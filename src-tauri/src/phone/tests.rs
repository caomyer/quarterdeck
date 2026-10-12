//! The phone link, proven with no phone and no Apple account: a test client
//! that speaks `qd-phone/1` over a real WebSocket on loopback, against a link
//! whose home has every engine script replaced by one that records it ran, and
//! whose host records every command it is given. The sealing is never stubbed.

use super::request::PhoneRequest;
use super::seal::{Channel, Initiator, Purpose, Ready, Secret};
use super::{Desk, Inner, Link};
use crate::host::HostHandle;
use crate::review::Writes;
use crate::snapshot::SnapshotReader;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const CALL: &str = "qd-phone-call-1";
const TASK: &str = "qd-phone-scout-1";
const PAGE: &str = "ship-or-wait";
const WAIT: Duration = Duration::from_secs(5);

/// Every request kind a phone may make, each with why it cannot start, stop or
/// take over the first mate or dispatch work. A new variant does not compile
/// until it is argued here, and `the_request_set_is_exactly_what_was_approved`
/// fails until it is also named in [`APPROVED`].
fn argued(request: &PhoneRequest) -> &'static str {
    match request {
        PhoneRequest::Board => "reads the snapshot the desktop already read",
        PhoneRequest::AnswerCall { .. } => "runs firstmate's own intake, then tells the running first mate",
        PhoneRequest::ReplyToCall { .. } => "keeps words on a call through firstmate's own reply, then tells the running first mate",
        PhoneRequest::Page { .. } => "reads one file of a presented revision through the artifact resolver",
        PhoneRequest::Review { .. } => "reads a review log",
        PhoneRequest::Comment { .. } => "appends a draft comment to a review log",
        PhoneRequest::Discard { .. } => "takes back a draft comment from a review log",
        PhoneRequest::SendReview { .. } => "the desktop's Send review: intake, delivery to the author, and telling the running first mate",
        PhoneRequest::Chat { .. } => "reads the running first mate's conversation",
        PhoneRequest::Say { .. } => "queues the captain's words for the running first mate, which never starts one",
    }
}

const APPROVED: [&str; 10] = ["board", "answer_call", "reply_to_call", "page", "review", "comment", "discard", "send_review", "chat", "say"];

/// What may run in the home while a phone is served: the intake an answer or a
/// review runs on the desktop too. Nothing else, ever.
const MAY_RUN: [&str; 3] = ["fm-captain-hold.sh answers", "fm-captain-hold.sh reply", "fm-artifact.sh deliver-review"];

/// What a phone may ask of the host: tell the first mate something, read its conversation.
fn may_reach_host(command: &str) -> bool {
    command == "get_state" || command.starts_with("send ")
}

/// One of each request, valid against the fixture home.
fn samples() -> Vec<Value> {
    let page = json!({"scope": "task", "task": TASK, "name": PAGE});
    vec![
        json!({"ask": "board"}),
        json!({"ask": "page", "page": page, "rev": 1}),
        json!({"ask": "page", "page": page, "rev": 1, "file": "style.css"}),
        json!({"ask": "review", "page": page}),
        json!({"ask": "comment", "page": page, "rev": 1, "body": "Wait for the numbers.", "anchor": {"quote": "Ship it"}}),
        json!({"ask": "comment", "page": page, "rev": 1, "body": "Never mind this one."}),
        json!({"ask": "discard", "page": page, "thread": "t2"}),
        json!({"ask": "answer_call", "call": CALL, "option": "wait", "page": page, "note": "after the numbers"}),
        json!({"ask": "send_review", "page": page, "rev": 1, "verdict": "changes"}),
        json!({"ask": "reply_to_call", "call": CALL, "words": "Not before Friday."}),
        json!({"ask": "chat", "limit": 2}),
        json!({"ask": "say", "text": "How is the scout doing?"}),
    ]
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qd-phone-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn executable(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A home with a crewmate's page arguing one call, and in `bin/` a stand-in for
/// every script the engine ships, each noting that it ran in `ran.log`.
fn home(root: &Path) -> PathBuf {
    let home = root.join("home");
    std::fs::create_dir_all(home.join("bin")).unwrap();
    let record = "here=$(cd \"$(dirname \"$0\")/..\" && pwd)\necho \"$(basename \"$0\") $1\" >> \"$here/ran.log\"\n";
    let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine/bin");
    let mut stood_in = 0;
    for entry in std::fs::read_dir(&engine).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        if name.ends_with(".sh") {
            executable(&home.join("bin").join(&name), &format!("#!/bin/sh\n{record}"));
            stood_in += 1;
        }
    }
    assert!(stood_in > 50, "every engine script is stood in for, {stood_in} found");
    executable(
        &home.join("bin/fm-captain-hold.sh"),
        &format!("#!/bin/sh\n{record}case \"$1\" in\n  answers) cat >> \"$here/intake.stdin\"; cat \"$here/intake-says\" ;;\n  reply) echo \"replied: $2\" ;;\nesac\n"),
    );
    executable(&home.join("bin/fm-artifact.sh"), &format!("#!/bin/sh\n{record}echo \"delivered: review to {TASK} inbox m-7\"\n"));
    std::fs::write(home.join("intake-says"), format!("closed: {CALL} recorded; released\n")).unwrap();
    let rev = home.join("data").join(TASK).join("artifacts").join(PAGE).join("rev-1");
    std::fs::create_dir_all(rev.join("files")).unwrap();
    std::fs::write(rev.join("files/index.html"), "<html><head><link rel=stylesheet href=style.css></head><body><h1>Ship it, or wait?</h1></body></html>").unwrap();
    std::fs::write(rev.join("files/style.css"), "h1 { font-weight: 600 }").unwrap();
    std::fs::write(home.join("data").join(TASK).join("secret.txt"), "not part of any page").unwrap();
    std::fs::write(
        rev.join("revision.json"),
        json!({"scope": "task", "task": TASK, "name": PAGE, "rev": 1, "title": "Ship it, or wait?", "entry": "index.html", "presented_by": {"role": "crew", "task": TASK}}).to_string(),
    )
    .unwrap();
    home
}

fn call(id: &str, title: &str) -> Value {
    json!({
        "id": id, "title": title, "question": format!("{title} Now, or after the numbers?"),
        "options": [{"key": "ship", "label": "Ship it now"}, {"key": "wait", "label": "Wait for the numbers"}],
        "on_answer": "release", "state": "open", "captain_actionable": true,
        "origin": TASK, "evidence": [format!("page:task/{TASK}/{PAGE}")], "answer": null, "decided": null, "reply": null,
    })
}

fn fleet(calls: Vec<Value>) -> Value {
    json!({
        "schema": "fm-fleet-snapshot/1", "captain_day": "2026-10-11", "calls": calls,
        "artifacts": [{
            "scope": "task", "task": TASK, "name": PAGE, "title": "Ship it, or wait?",
            "latest": {"scope": "task", "task": TASK, "name": PAGE, "rev": 1, "title": "Ship it, or wait?", "note": null, "entry": "index.html", "bytes": 98, "presented_at": "2026-10-11T09:00:00Z", "presented_by": {"role": "crew", "task": TASK}},
            "revisions": [],
        }],
        "tasks": [{"id": TASK, "kind": "scout", "project": "quarterdeck", "harness": "claude", "current_state": {"state": "working"}, "paths": {"worktree": {"path": "/never/shown"}}}],
    })
}

struct World {
    root: PathBuf,
    home: PathBuf,
    link: Link,
    commands: Arc<Mutex<Vec<String>>>,
    refreshes: Arc<AtomicUsize>,
}

impl World {
    fn new(name: &str) -> World {
        World::pinging(name, super::server::KEEPALIVE)
    }

    /// A world whose Mac pings a phone in session every `keepalive`.
    fn pinging(name: &str, keepalive: Duration) -> World {
        World::on(name, keepalive, Box::new(|| vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]), 0)
    }

    /// A world whose link listens on what `addresses` gives, at `port`.
    fn on(name: &str, keepalive: Duration, addresses: Box<dyn Fn() -> Vec<IpAddr> + Send + Sync>, port: u16) -> World {
        let root = scratch(name);
        let home = home(&root);
        let commands = Arc::new(Mutex::new(Vec::new()));
        let conversation = json!([
            {"who": "captain", "text": "Start the scout."},
            {"who": "step", "text": "Read file"},
            {"who": "mate", "text": "The scout is reading the reference."},
            {"who": "mate", "text": "It has a page for you."},
        ]);
        let host = HostHandle::recording(commands.clone(), conversation);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let snapshots = SnapshotReader::fixed(json!({"home": home, "snapshot": {"fleet": fleet(vec![call(CALL, "Ship it?")])}}), refreshes.clone());
        let at = home.clone();
        let desk = Desk::new(Arc::new(move || Some(at.clone())), host.messenger(), snapshots, Writes::default());
        let link = Link::open(&root.join("app/phone"), desk, keepalive, addresses, Some(port), Box::new(|_| {}));
        World { root, home, link, commands, refreshes }
    }

    fn inner(&self) -> &Arc<Inner> {
        self.link.ready().unwrap()
    }

    async fn invite(&self) -> Value {
        self.inner().invite().await.expect("an invite")["offer"].clone()
    }

    fn ran(&self) -> Vec<String> {
        std::fs::read_to_string(self.home.join("ran.log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    fn mac(&self) -> [u8; 32] {
        self.inner().registry().mac().public()
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The phone, as the app will be: it greets, checks the Mac is the one it
/// pinned, and from then on speaks only in sealed frames.
struct Phone {
    socket: Socket,
    channel: Channel,
    next_id: u64,
    events: Vec<Value>,
}

fn decode<const N: usize>(text: &Value) -> [u8; N] {
    super::seal::decode(text.as_str().unwrap(), "test").unwrap()
}

/// Greets the Mac at `offer`'s address. `Err` carries the Mac's refusal, or why the phone gave up.
async fn connect(offer: &Value, phone: &Secret, purpose: Purpose, secret: Option<[u8; 32]>) -> Result<Phone, String> {
    let address = offer["addresses"][0].as_str().unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/qd-phone/1")).await.map_err(|e| e.to_string())?;
    let invite = (purpose == Purpose::Pair).then(|| decode::<16>(&offer["invite"]));
    let initiator = Initiator::new(phone.clone(), Secret::generate().unwrap(), super::seal::random().unwrap(), decode(&offer["mac"]), purpose, invite);
    socket.send(Message::Text(initiator.hello().to_json().to_string().into())).await.map_err(|e| e.to_string())?;
    let answer = match tokio::time::timeout(WAIT, socket.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text).unwrap(),
        other => return Err(format!("no answer: {other:?}")),
    };
    if answer["type"] == "refused" {
        return Err(answer["reason"].as_str().unwrap_or_default().to_string());
    }
    let ready = Ready::from_json(&answer).map_err(|e| e.to_string())?;
    let channel = initiator.accept(&ready, &secret.unwrap_or([0; 32])).map_err(|e| format!("the phone did not accept the Mac: {e}"))?;
    Ok(Phone { socket, channel, next_id: 1, events: Vec::new() })
}

/// Pairs `phone` with the Mac showing `offer`, as scanning its QR does.
async fn pair(offer: &Value, phone: &Secret, name: &str) -> Result<Value, String> {
    let mut paired = connect(offer, phone, Purpose::Pair, Some(decode(&offer["secret"]))).await?;
    paired.send(&json!({"name": name})).await;
    paired.receive().await.ok_or_else(|| "the Mac closed without answering".to_string())
}

impl Phone {
    async fn send(&mut self, value: &Value) {
        let frame = self.channel.seal(value.to_string().as_bytes()).unwrap();
        let _ = self.socket.send(Message::Binary(frame.into())).await;
    }

    /// The next sealed payload, or `None` once the Mac has closed the connection.
    async fn receive(&mut self) -> Option<Value> {
        loop {
            match tokio::time::timeout(WAIT, self.socket.next()).await.ok()?? {
                Ok(Message::Binary(frame)) => return Some(serde_json::from_slice(&self.channel.open(&frame).expect("the Mac's frames open")).unwrap()),
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                _ => return None,
            }
        }
    }

    /// Asks one thing and waits for its answer, keeping any event that comes first.
    async fn ask(&mut self, request: &Value) -> Option<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let mut framed = request.clone();
        framed["id"] = json!(id);
        self.send(&framed).await;
        loop {
            let got = self.receive().await?;
            if got["id"] == id {
                return Some(got);
            }
            self.events.push(got);
        }
    }
}

async fn paired_phone(world: &World, name: &str) -> (Secret, Phone) {
    let offer = world.invite().await;
    let key = Secret::generate().unwrap();
    let answer = pair(&offer, &key, name).await.expect("paired");
    assert_eq!(answer["paired"], true, "{answer}");
    let phone = connect(&offer, &key, Purpose::Session, None).await.expect("a session");
    (key, phone)
}

#[tokio::test]
async fn a_phone_pairs_only_through_the_invite_the_mac_shows() {
    let world = World::new("pairing");
    assert!(world.inner().listening.lock().await.is_empty(), "nothing listens before a phone is paired or an invite shows");
    let offer = world.invite().await;
    assert_eq!(offer["type"], "qd-phone-invite");
    assert_eq!(offer["path"], "/qd-phone/1");
    let expires = offer["expires"].as_u64().unwrap();
    assert!(expires.abs_diff(super::now_ms() + 600_000) < 5_000, "the invite lapses in ten minutes");

    // Without the invite's secret the Mac's answer does not confirm, and nothing is paired.
    let stranger = Secret::generate().unwrap();
    let guessed = connect(&offer, &stranger, Purpose::Pair, Some([0; 32])).await.err().unwrap();
    assert!(guessed.contains("did not accept"), "{guessed}");
    assert!(world.inner().registry().phones().is_empty());

    // A phone that is not paired cannot open a session.
    let refused = connect(&offer, &stranger, Purpose::Session, None).await.err().unwrap();
    assert_eq!(refused, "this phone is not paired with this Mac");

    let phone = Secret::generate().unwrap();
    let answer = pair(&offer, &phone, "Captain's iPhone\u{7}").await.unwrap();
    assert_eq!(answer["paired"], true);
    let paired = world.inner().registry().phones().to_vec();
    assert_eq!(paired.len(), 1);
    assert_eq!(paired[0].name, "Captain's iPhone", "a control character is not kept");
    assert_eq!(paired[0].key, phone.public());

    // The invite is spent: a second phone scanning the same QR is turned away.
    let late = connect(&offer, &Secret::generate().unwrap(), Purpose::Pair, Some(decode(&offer["secret"]))).await.err().unwrap();
    assert!(late.contains("lapsed or was already used"), "{late}");

    // And one that lapsed is no good either.
    let lapsed = world.inner().registry().new_invite(super::now_ms() - 11 * 60_000).unwrap();
    let mut old = offer.clone();
    old["invite"] = json!(super::seal::encode(&lapsed.id));
    let refused = connect(&old, &Secret::generate().unwrap(), Purpose::Pair, Some(lapsed.secret)).await.err().unwrap();
    assert!(refused.contains("lapsed"), "{refused}");

    // The paired phone talks; it pinned this Mac's key from the QR.
    let mut session = connect(&offer, &phone, Purpose::Session, None).await.unwrap();
    let board = session.ask(&json!({"ask": "board"})).await.unwrap();
    assert_eq!(board["ok"], true, "{board}");
    assert_eq!(board["result"]["calls"][0]["id"], CALL);
    assert_eq!(board["result"]["crew"], json!([{"id": TASK, "project": "quarterdeck", "kind": "scout", "state": "working"}]), "the crew only as a glance");

    // A phone that pinned another Mac refuses this one.
    let mut elsewhere = offer.clone();
    elsewhere["mac"] = json!(super::seal::encode(&Secret::generate().unwrap().public()));
    assert!(connect(&elsewhere, &phone, Purpose::Session, None).await.err().unwrap().contains("did not accept"));

    // The pairing survives the app: a new link over the same folder knows the phone and the Mac's key.
    let reopened = super::pairing::Registry::open(&world.root.join("app/phone")).unwrap();
    assert_eq!(reopened.mac().public(), world.mac());
    assert_eq!(reopened.paired(&phone.public()).map(|kept| kept.name.as_str()), Some("Captain's iPhone"));
    let mode = std::fs::metadata(world.root.join("app/phone/mac.key")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "only the captain can read the Mac's key");
}

#[tokio::test]
async fn revoke_ends_the_phone_at_once_and_its_notifications_with_it() {
    let world = World::new("revoke");
    let (lost_key, mut lost) = paired_phone(&world, "Lost phone").await;
    let (_, mut kept) = paired_phone(&world, "Kept phone").await;
    let lost_id = world.inner().registry().paired(&lost_key.public()).unwrap().id.clone();
    assert_eq!(lost.ask(&json!({"ask": "board"})).await.unwrap()["ok"], true);

    // Both hear of a call that comes to need the captain; the first snapshot only sets where things stand.
    world.inner().snapshot_read(&json!({"fleet": fleet(vec![call(CALL, "Ship it?")])}));
    world.inner().snapshot_read(&json!({"fleet": fleet(vec![call(CALL, "Ship it?"), call("qd-second-1", "Rename it?")])}));
    for phone in [&mut lost, &mut kept] {
        let event = phone.receive().await.unwrap();
        assert_eq!(event, json!({"event": "call", "call": {"id": "qd-second-1", "title": "Rename it?", "question": "Rename it? Now, or after the numbers?"}}));
    }

    assert!(world.inner().revoke(&lost_id).unwrap());
    // The connection is closed before anything else reaches it.
    assert_eq!(tokio::time::timeout(WAIT, lost.receive()).await.unwrap(), None, "the revoked phone's connection is closed at once");

    // Its next request goes nowhere, and a new connection is refused at the greeting.
    lost.send(&json!({"id": 99, "ask": "board"})).await;
    assert_eq!(lost.receive().await, None);
    let offer = world.invite().await;
    assert_eq!(connect(&offer, &lost_key, Purpose::Session, None).await.err().unwrap(), "this phone is not paired with this Mac");

    // The next call reaches the phone still paired, and nothing reaches the revoked one.
    world.inner().snapshot_read(&json!({"fleet": fleet(vec![call(CALL, "Ship it?"), call("qd-second-1", "Rename it?"), call("qd-third-1", "Merge it?")])}));
    assert_eq!(kept.receive().await.unwrap()["call"]["id"], "qd-third-1");
    assert!(world.inner().live.lock().unwrap().iter().all(|live| live.phone != lost_id), "no event channel is left for it");
    assert_eq!(kept.ask(&json!({"ask": "board"})).await.unwrap()["ok"], true, "the other phone carries on");
    assert!(world.inner().registry().paired(&lost_key.public()).is_none());
    let on_disk = std::fs::read_to_string(world.root.join("app/phone/phones.json")).unwrap();
    assert!(!on_disk.contains(&super::seal::encode(&lost_key.public())), "its key is gone from disk too");
}

/// Settings takes what revoke and cancel answer as the whole status, so each
/// says whether the Mac is on a tailnet, as reading the status does.
#[tokio::test]
async fn every_status_settings_is_handed_says_whether_the_mac_is_on_a_tailnet() {
    let world = World::new("tailnet-status");
    let (key, _phone) = paired_phone(&world, "Lost phone").await;
    let id = world.inner().registry().paired(&key.public()).unwrap().id.clone();
    assert!(world.inner().revoke(&id).unwrap());
    assert_eq!(world.inner().status().await["tailnet"], true, "after a revoke");
    world.invite().await;
    world.inner().registry().cancel_invite();
    assert_eq!(world.inner().status().await["tailnet"], true, "after a cancelled invite");

    let off = World::on("tailnet-status-off", super::server::KEEPALIVE, Box::new(Vec::new), 0);
    assert_eq!(off.inner().status().await["tailnet"], false);
}

/// The structural reason a phone cannot be a second host, as a behaviour:
/// every kind of request, driven over the wire, reaches nothing but the
/// running first mate's outbox and conversation and the intake the desktop
/// itself runs. A variant that started, stopped or reconfigured the first mate,
/// took its lock, ran any other engine script or dispatched work fails here.
#[tokio::test]
async fn every_request_stays_on_the_captains_desk() {
    let world = World::new("desk");
    let (_, mut phone) = paired_phone(&world, "Captain's iPhone").await;
    let mut kinds = std::collections::BTreeSet::new();
    for sample in samples() {
        let request: PhoneRequest = serde_json::from_value(sample.clone()).expect("a sample is a request");
        assert!(!argued(&request).is_empty());
        kinds.insert(request.kind());
        let answer = phone.ask(&sample).await.unwrap_or_else(|| panic!("no answer to {sample}"));
        assert_eq!(answer["ok"], true, "{sample} -> {answer}");
    }
    assert_eq!(kinds.into_iter().collect::<Vec<_>>(), { let mut all = APPROVED.to_vec(); all.sort(); all }, "every kind is driven");

    let commands = world.commands.lock().unwrap().clone();
    assert!(commands.iter().all(|command| may_reach_host(command)), "the host was asked for more than telling and reading: {commands:?}");
    for ran in world.ran() {
        assert!(MAY_RUN.contains(&ran.as_str()), "the phone ran `{ran}` in the home");
    }
    assert!(!world.home.join("state").exists(), "nothing touched the home's state, where its lock lives");
}

/// A phone that vanishes without closing, as a sleeping or unplugged one does,
/// is let go once nothing has come from it for three pings: its place among the
/// Mac's connections is free again and Settings no longer shows it connected.
/// A phone that is only listening answers the pings, as any WebSocket does, and stays.
#[tokio::test]
async fn a_silent_phone_is_let_go_and_its_place_freed() {
    let beat = Duration::from_millis(100);
    let world = World::pinging("keepalive", beat);
    let (key, mut listening) = paired_phone(&world, "Captain's iPhone").await;
    let offer = world.invite().await;
    let mut silent = Vec::new();
    for _ in 1..super::server::CONNECTIONS {
        silent.push(connect(&offer, &key, Purpose::Session, None).await.expect("a session while there is room"));
    }
    assert_eq!(world.inner().live.lock().unwrap().len(), super::server::CONNECTIONS, "every place is taken");

    // Only reading, the listening phone hears nothing but pings, which it answers.
    assert!(tokio::time::timeout(beat * 10, listening.receive()).await.is_err(), "the listening phone was not let go");
    assert_eq!(world.inner().live.lock().unwrap().len(), 1, "every silent phone was let go");
    assert_eq!(world.inner().status_without_listening()["phones"][0]["connected"], true, "the listening phone still shows connected");
    for mut phone in silent {
        assert!(closed_by_the_mac(&mut phone).await, "a silent phone's connection was closed");
    }

    // Their places are free again: a new session gets in, where it would have been dropped unread.
    let mut back = connect(&offer, &key, Purpose::Session, None).await.expect("a place for a new session");
    assert_eq!(back.ask(&json!({"ask": "board"})).await.unwrap()["ok"], true);
    assert_eq!(listening.ask(&json!({"ask": "board"})).await.unwrap()["ok"], true, "the listening phone carries on");

    drop((listening, back));
    let deadline = tokio::time::Instant::now() + WAIT;
    while !world.inner().live.lock().unwrap().is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(beat).await;
    }
    assert_eq!(world.inner().status_without_listening()["phones"][0]["connected"], false, "a phone that left shows as not connected");
}

/// Two sessions of one phone can end out of order; the one that ends last but
/// heard from the phone earlier does not move its last seen back.
#[test]
fn last_seen_never_goes_back() {
    let root = scratch("seen-order");
    let mut registry = super::pairing::Registry::open(&root).unwrap();
    let paired_at = super::now_ms();
    let invite = registry.new_invite(paired_at).unwrap();
    let key = Secret::generate().unwrap().public();
    registry.claim(&invite.id, key, "Captain's iPhone", paired_at).unwrap();
    let later = paired_at + 180_000;
    registry.seen(&key, later);
    registry.seen(&key, paired_at + 60_000);
    assert_eq!(registry.paired(&key).unwrap().last_seen, Some(later));
    let reopened = super::pairing::Registry::open(&root).unwrap();
    assert_eq!(reopened.paired(&key).unwrap().last_seen, Some(later), "nor on disk");
    let _ = std::fs::remove_dir_all(&root);
}

/// Whether the Mac ends `phone`'s connection within [`WAIT`], reading past anything it sends first.
async fn closed_by_the_mac(phone: &mut Phone) -> bool {
    let ended = async {
        loop {
            match phone.socket.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => continue,
            }
        }
    };
    tokio::time::timeout(WAIT, ended).await.is_ok()
}

/// "Last seen" is when the phone was last there: a phone that only listens is
/// seen by the pongs it answers, and once it leaves, at the moment it left.
#[tokio::test]
async fn a_listening_phone_is_last_seen_when_it_left() {
    let beat = Duration::from_millis(100);
    let world = World::pinging("last-seen", beat);
    let (key, mut phone) = paired_phone(&world, "Captain's iPhone").await;
    let last_seen = || world.inner().registry().paired(&key.public()).and_then(|phone| phone.last_seen).unwrap();
    let attached = last_seen();

    assert!(tokio::time::timeout(beat * 10, phone.receive()).await.is_err(), "the listening phone was not let go");
    assert!(last_seen() >= attached + 5 * beat.as_millis() as u64, "its pongs say it is there");

    let left = super::now_ms();
    phone.socket.close(None).await.unwrap();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !world.inner().live.lock().unwrap().is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(beat).await;
    }
    assert!(world.inner().live.lock().unwrap().is_empty(), "its session ended");
    let seen = last_seen();
    assert!(seen >= left && seen <= super::now_ms(), "last seen when it left ({seen}), not when it came ({attached})");
    assert_eq!(world.inner().status_without_listening()["phones"][0]["last_seen"], seen, "and Settings says so");
}

/// Every kind `PhoneRequest` has, as serde names them when refusing one it does not.
fn every_kind() -> Vec<String> {
    let refused = serde_json::from_value::<PhoneRequest>(json!({"ask": "no-such-kind"})).unwrap_err().to_string();
    let (_, listed) = refused.split_once("expected one of ").unwrap_or_else(|| panic!("serde no longer lists the kinds: {refused}"));
    listed.split(", ").map(|kind| kind.trim_matches(|c: char| c == '`' || c.is_whitespace()).to_string()).collect()
}

#[test]
fn the_request_set_is_exactly_what_was_approved() {
    // A variant added to the enum fails here until it is approved, which needs a
    // sample, which `every_request_stays_on_the_captains_desk` then drives.
    let mut kinds = every_kind();
    kinds.sort();
    let mut approved = APPROVED.map(str::to_string).to_vec();
    approved.sort();
    assert_eq!(kinds, approved, "the phone can ask for something that was not approved");
    for kind in APPROVED {
        let sample = samples().into_iter().find(|sample| sample["ask"] == kind).unwrap_or_else(|| panic!("no sample of {kind}"));
        let request: PhoneRequest = serde_json::from_value(sample).unwrap();
        assert_eq!(request.kind(), kind);
    }
    // Anything else, or anything more, is not a request.
    for (asked, why) in [
        (json!({"id": 1, "ask": "start_work", "task": TASK}), "starting work"),
        (json!({"id": 1, "ask": "host_start"}), "starting the first mate"),
        (json!({"id": 1, "ask": "run", "command": "bin/fm-spawn.sh"}), "running a command"),
        (json!({"id": 1, "ask": "say", "text": "hi", "shell": "rm -rf /"}), "a field no request has"),
        (json!({"id": 1, "ask": "board", "then": "start"}), "a field no request has"),
        (json!({"ask": "board"}), "no id"),
    ] {
        assert!(super::request::parse(asked.to_string().as_bytes()).is_err(), "{why} was read as a request");
    }
}

/// An answer from the phone is the desktop's `call_answer`: the same keyed line
/// into firstmate's intake, the same message to the first mate, and "recorded"
/// only when the intake said it closed the call.
#[tokio::test]
async fn an_answer_reads_recorded_only_when_the_intake_recorded_it() {
    let world = World::new("answer");
    let (_, mut phone) = paired_phone(&world, "Captain's iPhone").await;
    let answer = phone.ask(&json!({"ask": "answer_call", "call": CALL, "option": "ship", "page": null, "note": "go"})).await.unwrap();
    assert_eq!(answer["result"]["recorded"], true, "{answer}");
    assert_eq!(answer["result"]["told"], true);
    // The label and how it closes come from the call, never from the phone.
    assert_eq!(std::fs::read_to_string(world.home.join("intake.stdin")).unwrap(), format!("{CALL}\tship\tShip it now\trelease\n"));
    let told = world.commands.lock().unwrap().clone();
    assert_eq!(told, vec![format!("send {}", crate::review::answer_message(CALL, "ship", "Ship it now", Some("go")))]);
    assert!(world.refreshes.load(std::sync::atomic::Ordering::SeqCst) > 0, "the Mac reads the fleet again");

    // The intake skipping it is not recorded, and nothing is told.
    std::fs::write(world.home.join("intake-says"), format!("skipped: {CALL} (already answered)\n")).unwrap();
    let skipped = phone.ask(&json!({"ask": "answer_call", "call": CALL, "option": "wait"})).await.unwrap();
    assert_eq!(skipped["result"]["recorded"], false, "{skipped}");
    assert_eq!(skipped["result"]["outcome"], json!({"call": CALL, "result": "skipped", "detail": "already answered"}));
    assert_eq!(world.commands.lock().unwrap().len(), 1, "nothing more was told");

    // Nor is anything the intake never spoke of.
    std::fs::write(world.home.join("intake-says"), "").unwrap();
    let silent = phone.ask(&json!({"ask": "answer_call", "call": CALL, "option": "wait"})).await.unwrap();
    assert_eq!(silent["result"]["recorded"], false);
    assert_eq!(silent["result"]["outcome"]["result"], "not_recorded");

    // A call or an option the Mac does not have never reaches the intake.
    let before = world.ran().len();
    for (call, option) in [("qd-nothing-1", "ship"), (CALL, "burn-it")] {
        let refused = phone.ask(&json!({"ask": "answer_call", "call": call, "option": option})).await.unwrap();
        assert_eq!(refused["ok"], false, "{refused}");
    }
    assert_eq!(world.ran().len(), before);
}

/// A page is read through the artifact resolver and travels sealed; the phone
/// can read exactly what the review screen can, and nothing beside it.
#[tokio::test]
async fn a_page_travels_sealed_and_nothing_beside_it_does() {
    let world = World::new("page");
    let (_, mut phone) = paired_phone(&world, "Captain's iPhone").await;
    let page = json!({"scope": "task", "task": TASK, "name": PAGE});
    let entry = phone.ask(&json!({"ask": "page", "page": page, "rev": 1})).await.unwrap();
    assert_eq!(entry["result"]["file"], "index.html");
    assert_eq!(entry["result"]["content_type"], "text/html; charset=utf-8");
    use base64::Engine as _;
    let body = base64::engine::general_purpose::STANDARD.decode(entry["result"]["body"].as_str().unwrap()).unwrap();
    assert_eq!(body, std::fs::read(world.home.join(format!("data/{TASK}/artifacts/{PAGE}/rev-1/files/index.html"))).unwrap(), "the page as presented, unchanged");
    for (asked, why) in [
        (json!({"ask": "page", "page": page, "rev": 1, "file": "../../../../secret.txt"}), "a path out of the page"),
        (json!({"ask": "page", "page": page, "rev": 1, "file": "../revision.json"}), "the revision's record"),
        (json!({"ask": "page", "page": page, "rev": 2}), "a revision never presented"),
        (json!({"ask": "page", "page": {"scope": "task", "task": "../..", "name": PAGE}, "rev": 1}), "a task that is a path"),
        (json!({"ask": "review", "page": {"scope": "elsewhere", "name": PAGE}}), "a scope that is not one"),
    ] {
        let refused = phone.ask(&asked).await.unwrap();
        assert_eq!(refused["ok"], false, "{why}: {refused}");
    }
}

/// The phone's conversation is the first mate's words and the captain's, not its steps.
#[tokio::test]
async fn chat_reads_words_not_steps() {
    let world = World::new("chat");
    let (_, mut phone) = paired_phone(&world, "Captain's iPhone").await;
    let chat = phone.ask(&json!({"ask": "chat"})).await.unwrap();
    let whos: Vec<&str> = chat["result"]["items"].as_array().unwrap().iter().map(|item| item["who"].as_str().unwrap()).collect();
    assert_eq!(whos, ["captain", "mate", "mate"]);
    let said = phone.ask(&json!({"ask": "say", "text": "  "})).await.unwrap();
    assert_eq!(said["ok"], false);
    assert!(world.commands.lock().unwrap().iter().all(|command| command == "get_state"), "empty words are not sent");
}

/// The request and answer the phone will see, recorded against the fixture
/// home, so the app is built against what the Mac actually says. Regenerate
/// with `QD_PHONE_RECORD=1 cargo test phone::tests::the_wire_matches_the_recording`.
#[tokio::test]
async fn the_wire_matches_the_recording() {
    let world = World::new("recording");
    let (_, mut phone) = paired_phone(&world, "Captain's iPhone").await;
    let mut exchanges = Vec::new();
    for sample in samples() {
        let answer = phone.ask(&sample).await.unwrap();
        exchanges.push(json!({"request": sample, "answer": steady(answer, &world.home.to_string_lossy())}));
    }
    let recorded = json!({
        "about": "Each request a phone may make, and what the Mac answered, inside the sealed channel, against the fixture home in src-tauri/src/phone/tests.rs. Times are replaced by <time> and the home by <home>. Regenerate with QD_PHONE_RECORD=1 cargo test phone::tests::the_wire_matches_the_recording.",
        "exchanges": exchanges,
    });
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/phone/requests.json");
    let text = format!("{}\n", serde_json::to_string_pretty(&recorded).unwrap());
    if std::env::var_os("QD_PHONE_RECORD").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text, "the Mac no longer answers as docs/phone/requests.json records");
}

/// An answer with every time made steady, and the scratch home named `<home>`.
fn steady(value: Value, home: &str) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let timed = key == "at" || key.ends_with("_at");
                    (key, if timed && value.is_number() { json!("<time>") } else { steady(value, home) })
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(|item| steady(item, home)).collect()),
        Value::String(text) => Value::String(text.replace(home, "<home>")),
        other => other,
    }
}

#[test]
fn nothing_listens_on_an_address_the_link_was_not_given() {
    // The app gives the link only tailnet addresses; whatever they are, every one is in 100.64.0.0/10.
    for ip in super::tailnet_addresses() {
        let IpAddr::V4(ip) = ip else { panic!("{ip} is not IPv4") };
        assert!(ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]), "{ip}");
    }
}

/// A port nothing holds, for a test that must know where a link would listen.
fn free_port() -> u16 {
    std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port()
}

/// The test seam (`QUARTERDECK_PHONE_ADDRESSES`) works in a debug build, which is
/// how a check drives the running app on a Mac with no Tailscale.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_debug_build_listens_where_the_test_seam_says() {
    std::env::set_var(super::ADDRESSES_OVERRIDE, "127.0.0.1");
    let port = free_port();
    let world = World::on("seam-debug", super::server::KEEPALIVE, Box::new(super::link_addresses), port);
    let offer = world.invite().await;
    std::env::remove_var(super::ADDRESSES_OVERRIDE);
    assert_eq!(offer["addresses"], json!([format!("127.0.0.1:{port}")]));
    assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_ok(), "the link listens on loopback");
}

/// A release build ignores the test seam: with it set, the app's link still
/// offers and listens only on the tailnet, and nothing answers on loopback.
/// CI runs this with `cargo test --release`.
#[cfg(not(debug_assertions))]
#[tokio::test]
async fn a_release_build_ignores_the_test_seam() {
    std::env::set_var("QUARTERDECK_PHONE_ADDRESSES", "127.0.0.1");
    assert_eq!(super::link_addresses(), super::tailnet_addresses());
    let port = free_port();
    let world = World::on("seam-release", super::server::KEEPALIVE, Box::new(super::link_addresses), port);
    if let Ok(invite) = world.inner().invite().await {
        for address in invite["offer"]["addresses"].as_array().unwrap() {
            let ip: std::net::SocketAddr = address.as_str().unwrap().parse().unwrap();
            assert!(super::tailnet_addresses().contains(&ip.ip()), "{ip} is not a tailnet address");
        }
    }
    std::env::remove_var("QUARTERDECK_PHONE_ADDRESSES");
    assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_err(), "nothing listens on loopback");
}

/// The browser mock's invite (`src/host/mock-phones.ts`) is a QR this Mac would
/// draw, for an invite shaped as `docs/phone/protocol.md` says. Regenerate with
/// `QD_PHONE_RECORD=1 cargo test phone::tests::the_mock_invite_is_a_real_qr`.
#[test]
fn the_mock_invite_is_a_real_qr() {
    let vectors: Value = serde_json::from_str(include_str!("../../../docs/phone/seal-vectors.json")).unwrap();
    let offer = json!({
        "v": 1, "type": "qd-phone-invite", "mac": vectors["publics"]["mac"], "name": "Captain's Mac",
        "invite": vectors["secrets"]["invite_id"], "secret": vectors["secrets"]["invite_secret"],
        "addresses": ["100.101.102.103:47319"], "path": "/qd-phone/1", "expires": 1_791_700_000_000u64,
    });
    let fixture = json!({"offer": offer, "qr": super::qr(&offer.to_string()).unwrap()});
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/fixtures/phone-invite.json");
    let text = format!("{}\n", serde_json::to_string(&fixture).unwrap());
    if std::env::var_os("QD_PHONE_RECORD").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), text);
}

/// A phone written in another language from the document alone pairs with the
/// real link over a real socket, and talks to it: `scripts/phone-client.mjs`,
/// on Node's own crypto and WebSocket. A frame out of order ends its session,
/// and a phone the Mac never paired is turned away.
#[tokio::test]
async fn a_phone_written_from_the_document_in_javascript_pairs_and_talks() {
    let world = World::new("javascript");
    let offer = world.invite().await;
    let file = world.root.join("invite.json");
    std::fs::write(&file, offer.to_string()).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/phone-client.mjs");
    let run = tokio::process::Command::new("node").arg(&script).arg(&file).kill_on_drop(true).output();
    let output = tokio::time::timeout(Duration::from_secs(60), run)
        .await
        .expect("the JavaScript phone finished")
        .expect("node runs: the app's CI installs it for this test");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let said: Value = serde_json::from_slice(&output.stdout).expect("the JavaScript phone reports JSON");
    assert_eq!(said["paired"]["paired"], true, "{said}");
    let paired = world.inner().registry().phones().to_vec();
    assert_eq!(paired.len(), 1);
    assert_eq!(paired[0].name, "A phone written in JavaScript");
    assert_eq!(super::seal::encode(&paired[0].key), said["phone"].as_str().unwrap());
    assert_eq!(said["board"], json!({"ok": true, "calls": [CALL], "pages": [PAGE]}));
    assert_eq!(said["page"]["file"], "index.html");
    assert!(said["page"]["text"].as_str().unwrap().contains("Ship it, or wait?"));
    assert_eq!(said["said"]["ok"], true);
    assert_eq!(said["refused"]["ok"], false, "{said}");
    assert!(said["refused"]["problem"].as_str().unwrap().starts_with("that is not something a phone can ask"));
    assert_eq!(said["out_of_order"], Value::Null, "a frame out of order ends the session");
    assert_eq!(said["stranger"], "this phone is not paired with this Mac");
    let told = world.commands.lock().unwrap().clone();
    assert_eq!(told, vec!["send Hello from a phone written in JavaScript.".to_string()]);
}
