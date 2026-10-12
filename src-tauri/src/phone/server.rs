//! One phone's connection: the greeting, then either a pairing claim or a
//! sealed session of requests, answers and events, until the phone leaves or
//! is revoked.
//!
//! The listener is a WebSocket on the Mac's tailnet address, at
//! `/qd-phone/1`. The tailnet already encrypts the transport; everything after
//! the greeting is sealed again by `seal`, so nothing depends on trusting it.

use super::request;
use super::seal::{self, Channel, Hello, Purpose, Secret};
use super::{now_ms, Inner};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::future::Future;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{http, Message};
use tokio_tungstenite::WebSocketStream;

pub const PATH: &str = "/qd-phone/1";
/// A phone has this long to open the socket and greet.
const GREETING_WAIT: Duration = Duration::from_secs(10);
/// And this long, once answered, to send its frame 0: the claim, or a session's first request.
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(30);
/// Nothing the phone sends is large: an answer, a comment, a message.
const INBOUND_LIMIT: usize = 1024 * 1024;
/// Requests one connection may have in hand at once.
const IN_HAND: usize = 4;
/// Connections at once, across every phone; anything past it is dropped unread.
pub(super) const CONNECTIONS: usize = 16;
/// How often the Mac pings a phone in session.
pub(super) const KEEPALIVE: Duration = Duration::from_secs(30);
/// A session from which nothing at all has arrived for this many pings is ended.
const SILENT_PINGS: u32 = 3;

type Socket = WebSocketStream<TcpStream>;

pub async fn accept_loop(listener: TcpListener, inner: Arc<Inner>) {
    let open = Arc::new(Semaphore::new(CONNECTIONS));
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                log::warn!("the phone link could not accept a connection: {error}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let Ok(permit) = open.clone().try_acquire_owned() else { continue };
        let inner = inner.clone();
        tokio::spawn(async move {
            connection(stream, inner).await;
            drop(permit);
        });
    }
}

// The shape tungstenite's handshake callback must have.
#[allow(clippy::result_large_err)]
fn only_our_path(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    if request.uri().path() == PATH {
        return Ok(response);
    }
    let mut refused = ErrorResponse::new(None);
    *refused.status_mut() = http::StatusCode::NOT_FOUND;
    Err(refused)
}

async fn connection(stream: TcpStream, inner: Arc<Inner>) {
    let config = WebSocketConfig::default().max_message_size(Some(INBOUND_LIMIT)).max_frame_size(Some(INBOUND_LIMIT));
    let opened = tokio::time::timeout(GREETING_WAIT, tokio_tungstenite::accept_hdr_async_with_config(stream, only_our_path, Some(config))).await;
    let Ok(Ok(mut socket)) = opened else { return };
    let hello = match tokio::time::timeout(GREETING_WAIT, socket.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text).ok().map(|value| Hello::from_json(&value)),
        _ => None,
    };
    let hello = match hello {
        Some(Ok(hello)) => hello,
        _ => return refuse(socket, "that is not a qd-phone/1 greeting").await,
    };
    let now = now_ms();
    let (mac, psk) = {
        let registry = inner.registry();
        let psk = match (hello.purpose, hello.invite) {
            (Purpose::Pair, Some(invite)) => registry.invite_secret(&invite, now),
            (Purpose::Session, None) => registry.paired(&hello.phone).map(|_| [0u8; 32]),
            _ => None,
        };
        (registry.mac().clone(), psk)
    };
    let Some(psk) = psk else {
        let reason = match hello.purpose {
            Purpose::Pair => "this invite has lapsed or was already used; show a new one on the Mac",
            Purpose::Session => "this phone is not paired with this Mac",
        };
        return refuse(socket, reason).await;
    };
    let (Ok(eph), Ok(nonce)) = (Secret::generate(), seal::random::<32>()) else {
        return refuse(socket, "the Mac could not draw random bytes").await;
    };
    let (ready, channel) = match seal::respond(&mac, &hello, &psk, &eph, nonce) {
        Ok(answered) => answered,
        Err(problem) => return refuse(socket, &problem.to_string()).await,
    };
    if socket.send(Message::Text(ready.to_json().to_string().into())).await.is_err() {
        return;
    }
    match hello.purpose {
        Purpose::Pair => pair(socket, channel, hello, inner).await,
        Purpose::Session => session(socket, channel, hello.phone, inner).await,
    }
}

async fn refuse(mut socket: Socket, reason: &str) {
    let _ = socket.send(Message::Text(seal::refused(reason).to_string().into())).await;
    let _ = socket.close(None).await;
}

async fn send_sealed(socket: &mut (impl SinkExt<Message> + Unpin), channel: &mut Channel, value: &Value) -> bool {
    let Ok(frame) = channel.seal(value.to_string().as_bytes()) else { return false };
    socket.send(Message::Binary(frame.into())).await.is_ok()
}

/// The phone's first frame names it; the invite is spent only once that frame
/// opens, which proves the phone holds both its key and the invite's secret.
async fn pair(mut socket: Socket, mut channel: Channel, hello: Hello, inner: Arc<Inner>) {
    let Some(claim) = first_frame(&mut socket, &mut channel).await else { return };
    let name = serde_json::from_slice::<Value>(&claim).ok().and_then(|claim| claim["name"].as_str().map(str::to_string)).unwrap_or_default();
    let invite = hello.invite.unwrap_or_default();
    let claimed = inner.registry().claim(&invite, hello.phone, &name, now_ms());
    let answer = match &claimed {
        Ok(_) => json!({"paired": true, "mac": super::mac_name()}),
        Err(problem) => json!({"paired": false, "problem": problem}),
    };
    if claimed.is_ok() {
        inner.changed();
    }
    send_sealed(&mut socket, &mut channel, &answer).await;
    let _ = socket.close(None).await;
}

/// The phone's frame 0, opened, or `None` when it does not come in time or does not open.
async fn first_frame(socket: &mut Socket, channel: &mut Channel) -> Option<Vec<u8>> {
    let frame = match tokio::time::timeout(FIRST_FRAME_WAIT, socket.next()).await {
        Ok(Some(Ok(Message::Binary(frame)))) => frame,
        _ => return None,
    };
    channel.open(&frame).ok()
}

/// Whether `sending` went out before a phone that has stopped listening could hold it up for longer than `quiet`.
async fn within(quiet: Duration, sending: impl Future<Output = bool>) -> bool {
    tokio::time::timeout(quiet, sending).await.unwrap_or(false)
}

/// A paired phone's session: every frame is one request, answered in its own
/// time; events the Mac raises go out between answers. It begins only once the
/// phone's frame 0 opens, which proves it holds the paired key: until then the
/// phone is neither connected nor seen. A revoke ends it at once, and no request
/// still in hand starts a write after it; so does a phone from which nothing, not even
/// a pong, has arrived for [`SILENT_PINGS`] pings.
async fn session(mut socket: Socket, mut channel: Channel, key: [u8; 32], inner: Arc<Inner>) {
    let Some(first) = first_frame(&mut socket, &mut channel).await else { return };
    let (events_tx, mut events) = mpsc::unbounded_channel::<Value>();
    let (closed_tx, mut closed) = watch::channel(false);
    let Some(conn) = inner.attach(&key, events_tx, closed_tx) else { return };
    let (mut sink, mut stream) = socket.split();
    let (answers_tx, mut answers) = mpsc::unbounded_channel::<Value>();
    let in_hand = Arc::new(Semaphore::new(IN_HAND));
    let quiet = inner.keepalive * SILENT_PINGS;
    let mut pings = tokio::time::interval_at(tokio::time::Instant::now() + inner.keepalive, inner.keepalive);
    pings.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heard = tokio::time::Instant::now();
    let mut heard_at = now_ms();
    take(&first, &inner, key, &in_hand, &answers_tx);
    loop {
        tokio::select! {
            biased;
            _ = closed.changed() => break,
            message = stream.next() => {
                let Some(Ok(message)) = message else { break };
                heard = tokio::time::Instant::now();
                heard_at = now_ms();
                let paired = inner.seen_if_paired(&key);
                let frame = match message {
                    Message::Binary(frame) => frame,
                    Message::Ping(_) | Message::Pong(_) => continue,
                    _ => break,
                };
                // A frame that does not open ends the connection: there is no telling what else is wrong with it.
                let Ok(payload) = channel.open(&frame) else { break };
                if !paired {
                    break;
                }
                take(&payload, &inner, key, &in_hand, &answers_tx);
            },
            Some(answer) = answers.recv() => {
                if *closed.borrow() || !within(quiet, send_sealed(&mut sink, &mut channel, &answer)).await {
                    break;
                }
            },
            Some(event) = events.recv() => {
                if *closed.borrow() || !within(quiet, send_sealed(&mut sink, &mut channel, &event)).await {
                    break;
                }
            },
            _ = pings.tick() => {
                if heard.elapsed() >= quiet || !within(quiet, async { sink.send(Message::Ping(Default::default())).await.is_ok() }).await {
                    break;
                }
            },
        }
    }
    inner.detach(conn, &key, heard_at);
    within(quiet, async { sink.send(Message::Close(None)).await.is_ok() && sink.close().await.is_ok() }).await;
}

/// Takes one opened request in hand, answering on `answers`. A revoke keeps it
/// from starting its writes, even once its session has ended; one already
/// writing finishes, so nothing is left half done.
fn take(payload: &[u8], inner: &Arc<Inner>, key: [u8; 32], in_hand: &Arc<Semaphore>, answers: &mpsc::UnboundedSender<Value>) {
    let answer = answers.clone();
    match request::parse(payload) {
        Ok((id, asked)) => match in_hand.clone().try_acquire_owned() {
            Ok(permit) => {
                let desk = inner.desk.clone();
                let registry = inner.clone();
                let paired = move || registry.registry().paired(&key).is_some();
                tokio::spawn(async move {
                    let result = request::handle(&desk, &paired, asked).await;
                    let _ = answer.send(request::answered(id, result));
                    drop(permit);
                });
            }
            Err(_) => {
                let _ = answer.send(request::answered(id, Err("the Mac is still working on this phone's other requests".to_string())));
            }
        },
        Err((id, problem)) => {
            let _ = answer.send(json!({"id": id, "ok": false, "problem": problem}));
        }
    }
}
