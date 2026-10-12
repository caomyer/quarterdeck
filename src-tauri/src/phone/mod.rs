//! The phone link: the Mac half of Quarterdeck on the captain's phone.
//!
//! The phone and the Mac sit on the captain's own Tailscale network, and no
//! service of ours runs anywhere. The Mac listens only on its tailnet address,
//! and only while a phone is paired or an invite is showing. A phone does four
//! things: it learns a call needs the captain, answers it, reads the page that
//! argues it and sends a review, and has a word with the first mate. Crew state
//! is only a glance. `docs/phone/protocol.md` is the wire, for the phone's side.
//!
//! - Pairing starts only on the Mac (`pairing`): Settings shows a QR with the
//!   Mac's key and a one-time invite that lapses in ten minutes. Only the Mac
//!   that showed it can answer the phone that scanned it, and from then on only
//!   that phone, by the key the Mac pinned, can talk to it.
//! - Every payload is sealed (`seal`) with those pinned keys, on top of the
//!   tailnet, and pinned to the phone's own implementation by shared vectors.
//! - A phone asks only what `request::PhoneRequest` lists, a closed set with no
//!   way to start or stop the first mate, take its lock or dispatch work, so a
//!   phone can never become a second host (`request`, `desk`).
//! - Revoke forgets the phone's key and closes its connections at once, so its
//!   next request is refused and nothing more reaches it; a write already under
//!   way finishes, and no request in hand starts one.
//! - Pages travel sealed through the link, read through the same resolver as
//!   the desktop's `artifact` scheme; nothing serves them on a network.
//!
//! Commands: `phone_status`, `phone_invite`, `phone_invite_cancel`, `phone_revoke`.
//! Event: `phones`, with what `phone_status` returns, when the list changes.

mod desk;
mod pairing;
pub mod request;
pub mod seal;
mod server;
#[cfg(test)]
mod tests;

pub use desk::Desk;
use pairing::Registry;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::sync::{mpsc, watch};

/// How often the Mac checks its tailnet address has not changed under it.
const RECHECK: Duration = Duration::from_secs(30);

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The Mac's name, as a phone shows which Mac it is paired with.
pub(crate) fn mac_name() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: gethostname writes at most `len` bytes into the buffer it is given.
    let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
    let name = if ok { String::from_utf8_lossy(buffer.split(|byte| *byte == 0).next().unwrap_or_default()).to_string() } else { String::new() };
    let name = name.trim_end_matches(".local").to_string();
    if name.is_empty() { "This Mac".to_string() } else { name }
}

/// The Mac's addresses on a Tailscale network: IPv4 in 100.64.0.0/10 on a
/// tunnel interface. Nothing else is ever listened on.
pub(crate) fn tailnet_addresses() -> Vec<IpAddr> {
    let mut found = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `list` with a linked list freed below with freeifaddrs.
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return found;
    }
    let mut at = list;
    while !at.is_null() {
        // SAFETY: `at` is a node of the list getifaddrs returned, which stays valid until freeifaddrs.
        let entry = unsafe { &*at };
        at = entry.ifa_next;
        if entry.ifa_addr.is_null() || entry.ifa_name.is_null() {
            continue;
        }
        // SAFETY: a non-null ifa_addr points at a sockaddr; its family says what it is.
        if i32::from(unsafe { (*entry.ifa_addr).sa_family }) != libc::AF_INET {
            continue;
        }
        // SAFETY: an AF_INET address is a sockaddr_in, and ifa_name is a C string.
        let (address, name) = unsafe { (*(entry.ifa_addr as *const libc::sockaddr_in), std::ffi::CStr::from_ptr(entry.ifa_name)) };
        let ip = Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr));
        let [first, second, ..] = ip.octets();
        if first == 100 && (64..128).contains(&second) && name.to_string_lossy().starts_with("utun") {
            found.push(IpAddr::V4(ip));
        }
    }
    // SAFETY: `list` came from getifaddrs and is freed once.
    unsafe { libc::freeifaddrs(list) };
    found
}

/// Test seam: in a debug build, `QUARTERDECK_PHONE_ADDRESSES` (comma-separated
/// IPs, e.g. `127.0.0.1`) replaces the tailnet so a check can drive the running
/// app on a Mac with no Tailscale. It cannot ship: a release listener must bind
/// only to the tailnet, so a release build never reads it.
#[cfg(debug_assertions)]
pub(crate) const ADDRESSES_OVERRIDE: &str = "QUARTERDECK_PHONE_ADDRESSES";

/// Where the app's link listens: the tailnet, or the debug-only test seam above.
pub(crate) fn link_addresses() -> Vec<IpAddr> {
    #[cfg(debug_assertions)]
    if let Ok(chosen) = std::env::var(ADDRESSES_OVERRIDE) {
        return chosen.split(',').filter_map(|ip| ip.trim().parse().ok()).collect();
    }
    tailnet_addresses()
}

/// One phone connection the Mac has open: where its events go, and how to end it.
struct Live {
    conn: u64,
    phone: String,
    events: mpsc::UnboundedSender<Value>,
    closed: watch::Sender<bool>,
}

/// Where the Mac listens, and the task accepting there.
struct Listening {
    address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

pub(crate) struct Inner {
    registry: Mutex<Registry>,
    live: Mutex<Vec<Live>>,
    listening: tokio::sync::Mutex<Vec<Listening>>,
    pub(crate) desk: Desk,
    /// How often a phone in session is pinged; [`server::KEEPALIVE`] but in tests.
    keepalive: Duration,
    addresses: Box<dyn Fn() -> Vec<IpAddr> + Send + Sync>,
    /// Port 0 listens wherever the system says, for tests; otherwise the registry's port.
    port: Option<u16>,
    on_change: Box<dyn Fn(Value) + Send + Sync>,
    /// The calls that needed the captain at the last snapshot; none until the first.
    waiting: Mutex<Option<HashSet<String>>>,
    next_conn: AtomicU64,
}

fn held<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    pub(crate) fn registry(&self) -> MutexGuard<'_, Registry> {
        held(&self.registry)
    }

    /// A session for a paired phone: its events start flowing to `events`, and
    /// `closed` ends it. Checked again here, so a revoke that lands between the
    /// greeting and this cannot leave a session open.
    fn attach(&self, key: &[u8; 32], events: mpsc::UnboundedSender<Value>, closed: watch::Sender<bool>) -> Option<u64> {
        let registry = self.registry();
        let phone = registry.paired(key)?.id.clone();
        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed);
        held(&self.live).push(Live { conn, phone, events, closed });
        drop(registry);
        self.seen_if_paired(key);
        self.changed();
        Some(conn)
    }

    /// Ends a session, noting the phone was last there at `heard_at`, when anything last arrived from it.
    fn detach(&self, conn: u64, key: &[u8; 32], heard_at: u64) {
        held(&self.live).retain(|live| live.conn != conn);
        self.registry().seen(key, heard_at);
        self.changed();
    }

    /// Whether this phone is still paired, noting it was seen if it is.
    fn seen_if_paired(&self, key: &[u8; 32]) -> bool {
        let mut registry = self.registry();
        if registry.paired(key).is_none() {
            return false;
        }
        registry.seen(key, now_ms());
        true
    }

    /// Sends an event to every connected phone that is still paired.
    pub(crate) fn notify(&self, event: &Value) {
        let registry = self.registry();
        for live in held(&self.live).iter() {
            if registry.phones().iter().any(|phone| phone.id == live.phone) && !*live.closed.borrow() {
                let _ = live.events.send(event.clone());
            }
        }
    }

    /// Forgets a phone and ends every connection it has, before answering.
    fn revoke(&self, id: &str) -> Result<bool, String> {
        let revoked = self.registry().revoke(id)?.is_some();
        let mut live = held(&self.live);
        for ended in live.iter().filter(|live| live.phone == id) {
            let _ = ended.closed.send(true);
        }
        live.retain(|live| live.phone != id);
        drop(live);
        self.changed();
        Ok(revoked)
    }

    fn connected(&self) -> HashSet<String> {
        held(&self.live).iter().map(|live| live.phone.clone()).collect()
    }

    pub(crate) fn changed(&self) {
        (self.on_change)(self.status_without_listening());
    }

    /// What Settings shows, less where the Mac listens, which needs the async lock.
    fn status_without_listening(&self) -> Value {
        let connected = self.connected();
        let registry = self.registry();
        let now = now_ms();
        let phones: Vec<Value> = registry
            .phones()
            .iter()
            .map(|phone| {
                let mut shown = phone.to_json();
                shown["connected"] = json!(connected.contains(&phone.id));
                shown
            })
            .collect();
        json!({"phones": phones, "invite_expires_at": registry.invite(now).map(|invite| invite.expires_at)})
    }

    /// Listens on every tailnet address while a phone is paired or an invite is
    /// showing, and nowhere otherwise. Run whenever either changes, and every
    /// [`RECHECK`] in case Tailscale moved.
    async fn reconcile(self: &Arc<Self>) -> Result<(), String> {
        let wanted = {
            let registry = self.registry();
            !registry.phones().is_empty() || registry.invite(now_ms()).is_some()
        };
        let port = self.port.unwrap_or_else(|| self.registry().port());
        let addresses: Vec<IpAddr> = if wanted { (self.addresses)() } else { Vec::new() };
        let mut listening = self.listening.lock().await;
        listening.retain(|kept| {
            let keep = addresses.contains(&kept.address.ip());
            if !keep {
                kept.task.abort();
            }
            keep
        });
        let mut problems = Vec::new();
        for ip in addresses {
            if listening.iter().any(|kept| kept.address.ip() == ip) {
                continue;
            }
            match tokio::net::TcpListener::bind(SocketAddr::new(ip, port)).await {
                Ok(listener) => {
                    let address = listener.local_addr().unwrap_or(SocketAddr::new(ip, port));
                    let task = tokio::spawn(server::accept_loop(listener, self.clone()));
                    listening.push(Listening { address, task });
                }
                Err(error) => problems.push(format!("could not listen on {ip}:{port}: {error}")),
            }
        }
        if problems.is_empty() { Ok(()) } else { Err(problems.join("; ")) }
    }

    async fn status(&self) -> Value {
        let mut status = self.status_without_listening();
        let listening = self.listening.lock().await;
        status["listening"] = json!(listening.iter().map(|kept| kept.address.to_string()).collect::<Vec<_>>());
        status["tailnet"] = json!(!(self.addresses)().is_empty());
        status
    }

    /// A new invite, and the QR that carries it. Refused when the Mac has no
    /// tailnet address, since the phone would have nowhere to reach.
    async fn invite(self: &Arc<Self>) -> Result<Value, String> {
        if (self.addresses)().is_empty() {
            return Err("this Mac is not on a Tailscale network; start Tailscale and sign in, then pair".to_string());
        }
        let invite = self.registry().new_invite(now_ms())?;
        let problem = self.reconcile().await.err();
        let addresses: Vec<String> = self.listening.lock().await.iter().map(|kept| kept.address.to_string()).collect();
        if addresses.is_empty() {
            self.registry().cancel_invite();
            return Err(problem.unwrap_or_else(|| "the Mac could not listen on its tailnet address".to_string()));
        }
        let mac = self.registry().mac().public();
        let offer = json!({
            "v": seal::VERSION, "type": "qd-phone-invite", "mac": seal::encode(&mac), "name": mac_name(),
            "invite": seal::encode(&invite.id), "secret": seal::encode(&invite.secret),
            "addresses": addresses, "path": server::PATH, "expires": invite.expires_at,
        });
        self.changed();
        Ok(json!({"offer": offer, "expires_at": invite.expires_at}))
    }

    /// Tells connected phones of each call that has come to need the captain
    /// since the last snapshot. The first snapshot only sets where things stand.
    fn snapshot_read(&self, snapshot: &Value) {
        let Some(calls) = snapshot.pointer("/fleet/calls").and_then(Value::as_array) else { return };
        let needs_him = |call: &&Value| call["state"] == "open" && call["captain_actionable"] != false && call["reply"].is_null();
        let now: HashSet<String> = calls.iter().filter(needs_him).filter_map(|call| call["id"].as_str().map(str::to_string)).collect();
        let before = held(&self.waiting).replace(now.clone());
        let Some(before) = before else { return };
        for call in calls.iter().filter(needs_him) {
            let Some(id) = call["id"].as_str() else { continue };
            if !before.contains(id) {
                self.notify(&json!({"event": "call", "call": {"id": id, "title": call["title"], "question": call["question"]}}));
            }
        }
    }
}

/// The phone link as the app holds it, or why it could not be opened.
pub struct Link(Result<Arc<Inner>, String>);

impl Link {
    pub(crate) fn open(dir: &Path, desk: Desk, keepalive: Duration, addresses: Box<dyn Fn() -> Vec<IpAddr> + Send + Sync>, port: Option<u16>, on_change: Box<dyn Fn(Value) + Send + Sync>) -> Link {
        Link(Registry::open(dir).map(|registry| {
            Arc::new(Inner {
                registry: Mutex::new(registry),
                live: Mutex::new(Vec::new()),
                listening: tokio::sync::Mutex::new(Vec::new()),
                desk,
                keepalive,
                addresses,
                port,
                on_change,
                waiting: Mutex::new(None),
                next_conn: AtomicU64::new(0),
            })
        }))
    }

    /// The app's link: the app's own folder, the Mac's tailnet addresses, and a
    /// `phones` event to the window on every change. Starts listening at once
    /// when a phone is already paired.
    pub fn spawn(app: &AppHandle, desk: Desk) -> Link {
        let dir = match crate::settings::settings_dir(app) {
            Ok(dir) => dir.join("phone"),
            Err(problem) => return Link(Err(problem)),
        };
        let emitter = app.clone();
        let link = Link::open(&dir, desk, server::KEEPALIVE, Box::new(link_addresses), None, Box::new(move |status| {
            let _ = emitter.emit("phones", status);
        }));
        if let Ok(inner) = &link.0 {
            let inner = inner.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    if let Err(problem) = inner.reconcile().await {
                        log::warn!("the phone link: {problem}");
                    }
                    tokio::time::sleep(RECHECK).await;
                }
            });
        }
        link
    }

    pub(crate) fn ready(&self) -> Result<&Arc<Inner>, String> {
        self.0.as_ref().map_err(|problem| format!("the phone link is not available: {problem}"))
    }
}

/// Called by the snapshot reader with every snapshot it keeps.
pub fn snapshot_read(app: &AppHandle, snapshot: &Value) {
    if let Some(link) = app.try_state::<Link>() {
        if let Ok(inner) = link.ready() {
            inner.snapshot_read(snapshot);
        }
    }
}

/// The paired phones, whether each is connected, any invite showing and where the Mac listens.
#[tauri::command]
pub async fn phone_status(link: TauriState<'_, Link>) -> Result<Value, String> {
    Ok(link.ready()?.status().await)
}

/// Shows a new invite, replacing any other, and returns what the QR carries
/// with the QR itself: its modules, a row at a time, `1` for dark.
#[tauri::command]
pub async fn phone_invite(link: TauriState<'_, Link>) -> Result<Value, String> {
    let inner = link.ready()?.clone();
    let mut invite = inner.invite().await?;
    invite["qr"] = qr(&invite["offer"].to_string())?;
    Ok(invite)
}

fn qr(text: &str) -> Result<Value, String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| format!("the invite does not fit in a QR code: {e}"))?;
    let width = code.width();
    let modules = code.to_colors();
    let rows: Vec<String> = modules.chunks(width).map(|row| row.iter().map(|module| if *module == qrcode::Color::Dark { '1' } else { '0' }).collect()).collect();
    Ok(json!({"width": width, "rows": rows}))
}

#[tauri::command]
pub async fn phone_invite_cancel(link: TauriState<'_, Link>) -> Result<Value, String> {
    let inner = link.ready()?.clone();
    inner.registry().cancel_invite();
    if let Err(problem) = inner.reconcile().await {
        log::warn!("the phone link: {problem}");
    }
    inner.changed();
    Ok(inner.status().await)
}

/// Forgets a phone: its key is gone and its connections are closed before this
/// answers, so its next request is refused and no event reaches it again.
#[tauri::command]
pub async fn phone_revoke(link: TauriState<'_, Link>, id: String) -> Result<Value, String> {
    let inner = link.ready()?.clone();
    if !inner.revoke(&id)? {
        return Err("that phone is not paired with this Mac".to_string());
    }
    if let Err(problem) = inner.reconcile().await {
        log::warn!("the phone link: {problem}");
    }
    Ok(inner.status().await)
}
