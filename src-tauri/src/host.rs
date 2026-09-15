//! The ACP host: runs the first mate as one `claude-agent-acp` session in the
//! firstmate home and reports everything the UI needs as events.
//!
//! Contract (from the host spike, `FIRSTMATE_DESKTOP_ACP_HOST_SPIKE.md`):
//! - the adapter's stdout is read continuously, so turns the first mate starts
//!   on its own (Stop-hook rewakes) are observed instead of lost;
//! - turn state is derived, because agent-initiated turns carry no start or
//!   end marker: activity with no prompt in flight is an agent turn, ended by
//!   four seconds of silence;
//! - captain messages go to a durable outbox and are handed to the adapter at
//!   once, which queues them behind any running turn;
//! - a message is picked up only when its own prompt result arrives, and one
//!   whose result never arrived is re-sent after a restart;
//! - restart kills the adapter's process group and resumes the conversation
//!   with `session/load`.
//!
//! Commands: `host_start`, `host_stop`, `host_restart`, `send`, `get_state`.
//! Events: `session`, `state`, `text`, `tool_call`, `update`, `outbox`,
//! `prompt_result`, `usage`, `permission`, `host_health`.

use crate::envpath;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, oneshot, Mutex};

/// How long an agent-initiated turn may stay silent before it is considered over.
const AGENT_TURN_QUIET: Duration = Duration::from_secs(4);
/// Usage updates this soon after a prompt result are trailers, not a new turn.
const TRAILER_WINDOW: Duration = Duration::from_millis(1500);
/// A rewake storm is this many agent-initiated turns inside the window.
/// Placeholder agreed in #firstmate; the probe's real storm ran about 11 turns in 40s.
const STORM_TURNS: usize = 6;
const STORM_WINDOW: Duration = Duration::from_secs(120);

const PERMISSION_UNREADABLE: &str =
    "error: config/claude-permission-mode must be a readable regular file holding one of: bypass, auto";

type RpcResult = Result<Value, String>;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- commands ---

pub enum Cmd {
    Start { home: PathBuf, reply: oneshot::Sender<Result<(), String>> },
    Stop { reply: oneshot::Sender<Result<(), String>> },
    Restart { reply: oneshot::Sender<Result<(), String>> },
    Send { text: String, reply: oneshot::Sender<Result<String, String>> },
    GetState { reply: oneshot::Sender<Value> },
}

/// Tauri-managed handle to the host task.
pub struct HostHandle {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl HostHandle {
    pub fn spawn(app: AppHandle) -> Self {
        let (tx, cmd_rx) = mpsc::unbounded_channel();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let host = Host::new(app, ev_tx);
        tauri::async_runtime::spawn(host.run(cmd_rx, ev_rx));
        HostHandle { tx }
    }

    async fn call<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T, String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(make(reply))
            .map_err(|_| "the first mate host is not running".to_string())?;
        rx.await
            .map_err(|_| "the first mate host stopped before answering".to_string())
    }
}

#[tauri::command]
pub async fn host_start(
    home: String,
    host: TauriState<'_, HostHandle>,
    snapshots: TauriState<'_, crate::snapshot::SnapshotHandle>,
) -> Result<(), String> {
    let home = PathBuf::from(home);
    snapshots.set_home(home.clone()).await?;
    host.call(|reply| Cmd::Start { home, reply }).await?
}

#[tauri::command]
pub async fn host_stop(host: TauriState<'_, HostHandle>) -> Result<(), String> {
    host.call(|reply| Cmd::Stop { reply }).await?
}

#[tauri::command]
pub async fn host_restart(host: TauriState<'_, HostHandle>) -> Result<(), String> {
    host.call(|reply| Cmd::Restart { reply }).await?
}

#[tauri::command]
pub async fn send(text: String, host: TauriState<'_, HostHandle>) -> Result<String, String> {
    host.call(|reply| Cmd::Send { text, reply }).await?
}

#[tauri::command]
pub async fn get_state(host: TauriState<'_, HostHandle>) -> Result<Value, String> {
    host.call(|reply| Cmd::GetState { reply }).await
}

// ------------------------------------------------------------------- rpc ---

enum HostEvent {
    Update { gen: u64, params: Value },
    Permission { gen: u64, params: Value, chose: String },
    Exited { gen: u64 },
    Stderr { gen: u64, line: String },
    PromptDone { gen: u64, outbox_id: String, result: RpcResult },
}

#[derive(Clone)]
struct Rpc {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<RpcResult>>>>,
    next_id: Arc<AtomicU64>,
}

impl Rpc {
    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> RpcResult {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(err) = self.write(&message).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("write failed: {err}"));
        }
        rx.await
            .unwrap_or_else(|_| Err("the adapter exited before responding".to_string()))
    }
}

struct Adapter {
    child: Child,
    rpc: Rpc,
    session_id: String,
}

impl Adapter {
    /// Kill the adapter's whole process group, so the Claude CLI and any hook
    /// processes it started do not outlive it. Returns the members seen first.
    async fn kill_tree(&mut self) -> Value {
        let mut report = json!({});
        if let Some(pid) = self.child.id() {
            let members = envpath::command("ps")
                .args(["-o", "pid=,stat=,comm=", "-g", &pid.to_string()])
                .output()
                .await
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            let members: Vec<String> = members
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            let group = format!("-{pid}");
            let term = envpath::command("kill").args(["-TERM", &group]).output().await;
            let refused = term
                .as_ref()
                .ok()
                .filter(|o| !o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string());
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _ = envpath::command("kill").args(["-KILL", &group]).output().await;
            report = json!({"pgid": pid, "members": members, "term_refused": refused});
        }
        let _ = self.child.wait().await;
        report
    }
}

struct Spawned {
    adapter: Adapter,
    mode: &'static str,
    session: Value,
}

async fn spawn_adapter(
    home: &Path,
    events: mpsc::UnboundedSender<HostEvent>,
    gen: u64,
    resume: Option<String>,
) -> Result<Spawned, String> {
    let name = std::env::var("ACP_ADAPTER").unwrap_or_else(|_| "claude-agent-acp".to_string());
    let program = envpath::resolve(&name)
        .ok_or_else(|| format!("{name} was not found on the login shell PATH"))?;
    let mut child = envpath::command(&program)
        .current_dir(home)
        .env("FM_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;

    let stdin = child.stdin.take().ok_or("the adapter has no stdin")?;
    let stdout = child.stdout.take().ok_or("the adapter has no stdout")?;
    let stderr = child.stderr.take().ok_or("the adapter has no stderr")?;

    let rpc = Rpc {
        stdin: Arc::new(Mutex::new(stdin)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: Arc::new(AtomicU64::new(1)),
    };
    // While session/load replays history, its updates are not live activity.
    let loading = Arc::new(AtomicBool::new(false));

    {
        let rpc = rpc.clone();
        let events = events.clone();
        let loading = loading.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(raw)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(raw.trim()) else {
                    continue;
                };
                let method = message.get("method").and_then(Value::as_str);
                let id = message.get("id").and_then(Value::as_u64);
                match (method, id) {
                    (None, Some(id)) => {
                        if let Some(tx) = rpc.pending.lock().await.remove(&id) {
                            let result = match message.get("error") {
                                Some(err) => Err(err.to_string()),
                                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(result);
                        }
                    }
                    (Some("session/update"), _) => {
                        if !loading.load(Ordering::SeqCst) {
                            let params = message.get("params").cloned().unwrap_or(Value::Null);
                            let _ = events.send(HostEvent::Update { gen, params });
                        }
                    }
                    (Some("session/request_permission"), Some(id)) => {
                        // Permission posture is firstmate policy, applied through the
                        // session mode; a request that still arrives is answered
                        // allow_once and reported, never turned into a card.
                        let params = message.get("params").cloned().unwrap_or(Value::Null);
                        let options = params
                            .get("options")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let pick = options
                            .iter()
                            .find(|o| o.get("kind").and_then(Value::as_str) == Some("allow_once"))
                            .or_else(|| options.first());
                        let chose = pick
                            .and_then(|o| o.get("optionId"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let reply = json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "selected", "optionId": chose}}});
                        let _ = rpc.write(&reply).await;
                        let _ = events.send(HostEvent::Permission { gen, params, chose });
                    }
                    (Some(other), Some(id)) => {
                        let reply = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("not supported: {other}")}});
                        let _ = rpc.write(&reply).await;
                    }
                    _ => {}
                }
            }
            for (_, tx) in rpc.pending.lock().await.drain() {
                let _ = tx.send(Err("the adapter exited".into()));
            }
            let _ = events.send(HostEvent::Exited { gen });
        });
    }
    {
        let events = events.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = events.send(HostEvent::Stderr { gen, line });
            }
        });
    }

    let init = rpc
        .request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}}),
        )
        .await
        .map_err(|e| format!("initialize failed: {e}"))?;
    let can_load = init
        .pointer("/agentCapabilities/loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cwd = home.to_string_lossy().to_string();

    if let Some(previous) = resume.filter(|_| can_load) {
        loading.store(true, Ordering::SeqCst);
        let loaded = rpc
            .request("session/load", json!({"sessionId": previous, "cwd": cwd, "mcpServers": []}))
            .await;
        loading.store(false, Ordering::SeqCst);
        if let Ok(session) = loaded {
            return Ok(Spawned {
                adapter: Adapter { child, rpc, session_id: previous },
                mode: "loaded",
                session,
            });
        }
    }
    let session = rpc
        .request("session/new", json!({"cwd": cwd, "mcpServers": []}))
        .await
        .map_err(|e| format!("session/new failed: {e}"))?;
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("session/new returned no sessionId")?
        .to_string();
    Ok(Spawned { adapter: Adapter { child, rpc, session_id }, mode: "new", session })
}

// ---------------------------------------------------------------- policy ---

/// firstmate's `config/claude-permission-mode`, applied exactly as `fm-spawn.sh`
/// applies it to Claude workers: absent or `bypass` is bypass, `auto` is auto,
/// anything else refuses with the same message.
fn permission_mode(home: &Path) -> Result<(&'static str, &'static str), String> {
    let file = home.join("config").join("claude-permission-mode");
    match std::fs::metadata(&file) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(("bypass", "bypassPermissions"))
        }
        Err(_) => return Err(PERMISSION_UNREADABLE.to_string()),
        Ok(meta) if !meta.is_file() => return Err(PERMISSION_UNREADABLE.to_string()),
        Ok(_) => {}
    }
    let raw = std::fs::read_to_string(&file).map_err(|_| PERMISSION_UNREADABLE.to_string())?;
    let token: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    match token.as_str() {
        "bypass" => Ok(("bypass", "bypassPermissions")),
        "auto" => Ok(("auto", "auto")),
        other => Err(format!(
            "error: config/claude-permission-mode holds '{other}'; accepted values are: bypass (--dangerously-skip-permissions, the default when the file is absent), auto (--permission-mode auto)"
        )),
    }
}

enum Lock {
    Free,
    HeldBy { pid: u32, command: String },
    Unknown(String),
}

/// Read the home's session lock through firstmate's own read-only status.
/// Anything but a recognised answer from a clean exit is `Unknown`, and an
/// unknown lock refuses the start: a second first mate in one home is worse
/// than not starting.
async fn lock_status(home: &Path) -> Lock {
    let output = envpath::command(home.join("bin").join("fm-lock.sh"))
        .arg("status")
        .env("FM_HOME", home)
        .current_dir(home)
        .stdin(Stdio::null())
        .output()
        .await;
    let text = match output {
        // `fm-lock.sh status` documents that it always exits 0.
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Ok(out) => {
            let said = format!(
                "{} {}",
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
            return Lock::Unknown(format!("fm-lock.sh status exited with {}: {}", out.status, said.trim()));
        }
        Err(err) => return Lock::Unknown(format!("could not run fm-lock.sh status: {err}")),
    };
    if let Some(pid) = text
        .strip_prefix("lock: held by live harness pid ")
        .and_then(|rest| rest.trim().parse::<u32>().ok())
    {
        let command = envpath::command("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        return Lock::HeldBy { pid, command };
    }
    if text == "lock: free" || text.starts_with("lock: stale") {
        return Lock::Free;
    }
    Lock::Unknown(format!("fm-lock.sh status printed an unrecognised answer: '{text}'"))
}

// ---------------------------------------------------------------- outbox ---

struct Pending {
    id: String,
    text: String,
    ever_sent: bool,
}

/// Durable outbox: an append-only JSONL log. A message is re-sent on the next
/// start unless a record says its own turn finished reading it.
struct Outbox {
    path: PathBuf,
    queue: VecDeque<Pending>,
    counter: u64,
}

impl Outbox {
    fn load(path: &Path) -> Outbox {
        let mut order: Vec<String> = Vec::new();
        let mut latest: HashMap<String, (String, String, bool)> = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(path) {
            for line in text.lines() {
                let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
                let (Some(id), Some(state)) = (
                    record.get("id").and_then(Value::as_str),
                    record.get("state").and_then(Value::as_str),
                ) else {
                    continue;
                };
                let text = record.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                if !latest.contains_key(id) {
                    order.push(id.to_string());
                }
                let entry = latest
                    .entry(id.to_string())
                    .or_insert((String::new(), String::new(), false));
                if !text.is_empty() {
                    entry.0 = text;
                }
                entry.1 = state.to_string();
                if state == "sent" {
                    entry.2 = true;
                }
            }
        }
        let queue = order
            .into_iter()
            .filter_map(|id| {
                let (text, state, ever_sent) = latest.get(&id)?.clone();
                (state != "picked_up").then_some(Pending { id, text, ever_sent })
            })
            .collect();
        Outbox { path: path.to_path_buf(), queue, counter: 0 }
    }

    fn record(&self, id: &str, text: Option<&str>, state: &str, extra: Value) -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| e.to_string())?;
        let mut record = json!({"id": id, "state": state, "at_ms": now_ms()});
        if let Some(text) = text {
            record["text"] = json!(text);
        }
        if let (Value::Object(target), Value::Object(more)) = (&mut record, extra) {
            target.extend(more);
        }
        writeln!(file, "{record}").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("m{}-{}", now_ms(), self.counter)
    }
}

// ------------------------------------------------------------------ host ---

#[derive(Clone, Copy, PartialEq, Debug)]
enum State {
    Stopped,
    Starting,
    Idle,
    PromptTurn,
    AgentTurn,
    Restarting,
    Dead,
    LockedByOther,
    Refused,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            State::Stopped => "stopped",
            State::Starting => "starting",
            State::Idle => "idle",
            State::PromptTurn => "prompt_turn",
            State::AgentTurn => "agent_turn",
            State::Restarting => "restarting",
            State::Dead => "dead",
            State::LockedByOther => "locked_by_other",
            State::Refused => "refused",
        }
    }

    fn live(self) -> bool {
        matches!(self, State::Idle | State::PromptTurn | State::AgentTurn)
    }
}

struct Host {
    app: AppHandle,
    ev_tx: mpsc::UnboundedSender<HostEvent>,
    home: Option<PathBuf>,
    host_dir: Option<PathBuf>,
    outbox: Option<Outbox>,
    adapter: Option<Adapter>,
    gen: u64,
    state: State,
    detail: Value,
    permission: Option<&'static str>,
    in_flight: VecDeque<String>,
    started_hint: Option<String>,
    last_activity: Instant,
    last_prompt_done: Option<Instant>,
    agent_turns: u64,
    agent_turn_starts: VecDeque<Instant>,
    storm_active: bool,
}

impl Host {
    fn new(app: AppHandle, ev_tx: mpsc::UnboundedSender<HostEvent>) -> Self {
        Host {
            app,
            ev_tx,
            home: None,
            host_dir: None,
            outbox: None,
            adapter: None,
            gen: 0,
            state: State::Stopped,
            detail: json!({}),
            permission: None,
            in_flight: VecDeque::new(),
            started_hint: None,
            last_activity: Instant::now(),
            last_prompt_done: None,
            agent_turns: 0,
            agent_turn_starts: VecDeque::new(),
            storm_active: false,
        }
    }

    fn emit(&self, event: &str, mut body: Value) {
        if let Value::Object(map) = &mut body {
            map.insert("at_ms".into(), json!(now_ms()));
        }
        let _ = self.app.emit(event, body);
    }

    fn set_state(&mut self, state: State, detail: Value) {
        self.state = state;
        self.detail = detail.clone();
        let mut body = json!({"state": state.name()});
        if let (Value::Object(target), Value::Object(more)) = (&mut body, detail) {
            target.extend(more);
        }
        self.emit("state", body);
    }

    fn record(&self, id: &str, text: Option<&str>, state: &str, extra: Value) {
        if let Some(outbox) = &self.outbox {
            if let Err(error) = outbox.record(id, text, state, extra) {
                self.emit("host_health", json!({"kind": "outbox_write_failed", "id": id, "error": error}));
            }
        }
    }

    async fn run(
        mut self,
        mut cmd_rx: mpsc::UnboundedReceiver<Cmd>,
        mut ev_rx: mpsc::UnboundedReceiver<HostEvent>,
    ) {
        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                cmd = cmd_rx.recv() => match cmd {
                    Some(cmd) => self.handle_cmd(cmd).await,
                    None => {
                        self.stop_adapter().await;
                        break;
                    }
                },
                Some(event) = ev_rx.recv() => self.handle_event(event),
                _ = ticker.tick() => self.tick(),
            }
            self.dispatch();
        }
    }

    async fn handle_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Start { home, reply } => {
                let result = self.start(home, true).await;
                let _ = reply.send(result);
            }
            Cmd::Stop { reply } => {
                self.requeue_in_flight();
                self.stop_adapter().await;
                self.set_state(State::Stopped, json!({}));
                let _ = reply.send(Ok(()));
            }
            Cmd::Restart { reply } => {
                let Some(home) = self.home.clone() else {
                    let _ = reply.send(Err("no firstmate home has been started".to_string()));
                    return;
                };
                self.set_state(State::Restarting, json!({}));
                self.requeue_in_flight();
                self.stop_adapter().await;
                let result = self.start(home, false).await;
                let _ = reply.send(result);
            }
            Cmd::Send { text, reply } => {
                let Some(outbox) = self.outbox.as_mut() else {
                    let _ = reply.send(Err("no firstmate home has been started".to_string()));
                    return;
                };
                let id = outbox.next_id();
                // Durable first: a message the outbox could not save is refused, not
                // queued, so the captain never sees "queued" for words a crash would lose.
                if let Err(error) = outbox.record(&id, Some(&text), "queued", json!({})) {
                    let _ = reply.send(Err(format!("could not save the message, so it was not sent: {error}")));
                    return;
                }
                outbox.queue.push_back(Pending { id: id.clone(), text, ever_sent: false });
                self.emit("outbox", json!({"id": id, "state": "queued", "while": self.state.name()}));
                let _ = reply.send(Ok(id));
            }
            Cmd::GetState { reply } => {
                let queued: Vec<String> = self
                    .outbox
                    .as_ref()
                    .map(|o| o.queue.iter().map(|p| p.id.clone()).collect())
                    .unwrap_or_default();
                let _ = reply.send(json!({
                    "state": self.state.name(),
                    "detail": self.detail,
                    "home": self.home.as_ref().map(|h| h.to_string_lossy().to_string()),
                    "session_id": self.adapter.as_ref().map(|a| a.session_id.clone()),
                    "permission_mode": self.permission,
                    "in_flight": self.in_flight,
                    "queued": queued,
                    "agent_turns": self.agent_turns,
                    "rewake_storm": self.storm_active,
                }));
            }
        }
    }

    async fn start(&mut self, home: PathBuf, announce_loaded: bool) -> Result<(), String> {
        let home = std::fs::canonicalize(&home)
            .map_err(|e| format!("{} is not a readable folder: {e}", home.display()))?;
        if !home.join("AGENTS.md").is_file() || !home.join("bin").is_dir() {
            let reason = format!("{} is not a firstmate home", home.display());
            self.set_state(State::Refused, json!({"reason": reason}));
            return Err(reason);
        }
        if self.adapter.is_some() {
            self.stop_adapter().await;
        }
        self.set_state(State::Starting, json!({"home": home.to_string_lossy()}));

        let host_dir = self.host_dir_for(&home)?;
        let outbox = Outbox::load(&host_dir.join("outbox.jsonl"));
        self.home = Some(home.clone());
        self.host_dir = Some(host_dir.clone());
        self.outbox = Some(outbox);
        if announce_loaded {
            self.announce_loaded();
        }

        let (config_mode, mode_id) = match permission_mode(&home) {
            Ok(mode) => mode,
            Err(reason) => {
                self.set_state(State::Refused, json!({"reason": reason}));
                return Err(reason);
            }
        };
        self.permission = Some(config_mode);

        match lock_status(&home).await {
            Lock::HeldBy { pid, command } => {
                self.set_state(
                    State::LockedByOther,
                    json!({"holder_pid": pid, "holder_command": command}),
                );
                return Ok(());
            }
            Lock::Unknown(text) => {
                let reason = format!("could not confirm this home's session lock is free, so nothing was started. {text}");
                self.set_state(State::Refused, json!({"reason": reason, "lock_status": text}));
                return Err(reason);
            }
            Lock::Free => {}
        }

        let resume = read_session_id(&host_dir);
        self.gen += 1;
        let spawned = match spawn_adapter(&home, self.ev_tx.clone(), self.gen, resume).await {
            Ok(spawned) => spawned,
            Err(reason) => {
                self.set_state(State::Dead, json!({"reason": reason}));
                return Err(reason);
            }
        };
        let Spawned { mut adapter, mode, session } = spawned;

        // Apply firstmate's permission posture; never approximate a missing mode.
        let offered = session
            .pointer("/modes/availableModes")
            .and_then(Value::as_array)
            .map(|modes| modes.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(mode_id)))
            .unwrap_or(true);
        let applied = if offered {
            adapter
                .rpc
                .request("session/set_mode", json!({"sessionId": adapter.session_id, "modeId": mode_id}))
                .await
                .map(|_| ())
        } else {
            Err(format!("the Claude Code adapter does not offer the {mode_id} mode"))
        };
        if let Err(error) = applied {
            let report = adapter.kill_tree().await;
            self.emit("host_health", json!({"kind": "kill_group", "report": report}));
            let reason = format!("could not apply config/claude-permission-mode ({config_mode}): {error}");
            self.set_state(State::Refused, json!({"reason": reason}));
            return Err(reason);
        }

        write_session_id(&host_dir, &adapter.session_id, &home);
        self.emit(
            "session",
            json!({"mode": mode, "session_id": adapter.session_id, "permission_mode": config_mode}),
        );
        self.adapter = Some(adapter);
        self.in_flight.clear();
        self.started_hint = None;
        self.set_state(State::Idle, json!({}));
        Ok(())
    }

    fn host_dir_for(&self, home: &Path) -> Result<PathBuf, String> {
        let digest = Sha256::digest(home.to_string_lossy().as_bytes());
        let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
        let dir = self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| format!("no app data folder: {e}"))?
            .join("homes")
            .join(key);
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        Ok(dir)
    }

    /// Report what the outbox holds from before this start.
    fn announce_loaded(&self) {
        let Some(outbox) = &self.outbox else { return };
        for pending in &outbox.queue {
            if pending.ever_sent {
                self.record(&pending.id, None, "requeued", json!({"resent_after_restart": true}));
                self.emit(
                    "outbox",
                    json!({"id": pending.id, "state": "requeued", "resent_after_restart": true}),
                );
            } else {
                self.emit("outbox", json!({"id": pending.id, "state": "queued"}));
            }
        }
    }

    /// Messages handed over but not finished go back to the front of the queue.
    fn requeue_in_flight(&mut self) {
        let ids: Vec<String> = self.in_flight.drain(..).collect();
        for id in ids.iter().rev() {
            self.record(id, None, "requeued", json!({"resent_after_restart": true}));
            self.emit("outbox", json!({"id": id, "state": "requeued", "resent_after_restart": true}));
        }
        if let (Some(outbox), Some(home_dir)) = (self.outbox.as_mut(), self.host_dir.as_ref()) {
            let reloaded = Outbox::load(&home_dir.join("outbox.jsonl"));
            outbox.queue = reloaded.queue;
        }
        self.started_hint = None;
    }

    async fn stop_adapter(&mut self) {
        if let Some(mut adapter) = self.adapter.take() {
            let report = adapter.kill_tree().await;
            if report.get("term_refused").is_some_and(|v| !v.is_null()) {
                self.emit("host_health", json!({"kind": "kill_refused", "report": report}));
            }
        }
    }

    fn handle_event(&mut self, event: HostEvent) {
        match event {
            HostEvent::Update { gen, params } if gen == self.gen => self.on_update(params),
            HostEvent::Permission { gen, params, chose } if gen == self.gen => {
                let title = params.pointer("/toolCall/title").and_then(Value::as_str).unwrap_or("");
                self.emit("permission", json!({"title": title, "chose": chose}));
            }
            HostEvent::Stderr { gen, line } if gen == self.gen => {
                let short: String = line.chars().take(240).collect();
                self.emit("host_health", json!({"kind": "adapter_stderr", "line": short}));
            }
            HostEvent::Exited { gen } if gen == self.gen && self.state.live() => {
                self.adapter = None;
                self.set_state(State::Dead, json!({"reason": "the first mate process exited"}));
            }
            HostEvent::PromptDone { gen, outbox_id, result } if gen == self.gen => {
                self.on_prompt_done(outbox_id, result)
            }
            _ => {}
        }
    }

    fn on_update(&mut self, params: Value) {
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let meta = matches!(
            kind.as_str(),
            "session_info_update" | "available_commands_update" | "current_mode_update" | "config_option_update"
        );
        if meta {
            self.emit("update", json!({"kind": kind, "update": update}));
            return;
        }
        let trailer = kind == "usage_update"
            && self.last_prompt_done.is_some_and(|t| t.elapsed() < TRAILER_WINDOW);
        if !trailer {
            self.last_activity = Instant::now();
            if self.in_flight.is_empty() {
                if self.state == State::Idle {
                    self.agent_turns += 1;
                    self.note_agent_turn();
                    self.set_state(
                        State::AgentTurn,
                        json!({"origin": "agent", "turn": self.agent_turns, "first_update": kind}),
                    );
                }
            } else if kind != "usage_update" {
                if let Some(oldest) = self.in_flight.front().cloned() {
                    if self.started_hint.as_deref() != Some(oldest.as_str()) {
                        self.started_hint = Some(oldest.clone());
                        self.emit(
                            "outbox",
                            json!({"id": oldest, "state": "likely_started", "authoritative": false}),
                        );
                    }
                }
            }
        }
        let origin = if self.in_flight.is_empty() { "agent" } else { "prompt_or_agent" };
        match kind.as_str() {
            "agent_message_chunk" => {
                let text = update.pointer("/content/text").and_then(Value::as_str).unwrap_or("");
                self.emit("text", json!({"origin": origin, "text": text}));
            }
            "tool_call" => {
                let title = update.get("title").and_then(Value::as_str).unwrap_or("");
                self.emit("tool_call", json!({"origin": origin, "title": title, "update": update}));
            }
            "usage_update" => self.emit("usage", json!({"update": update})),
            other => self.emit("update", json!({"origin": origin, "kind": other, "update": update})),
        }
    }

    fn note_agent_turn(&mut self) {
        let now = Instant::now();
        self.agent_turn_starts.push_back(now);
        while self
            .agent_turn_starts
            .front()
            .is_some_and(|t| now.duration_since(*t) > STORM_WINDOW)
        {
            self.agent_turn_starts.pop_front();
        }
        let turns = self.agent_turn_starts.len();
        if turns >= STORM_TURNS && !self.storm_active {
            self.storm_active = true;
            self.emit(
                "host_health",
                json!({"kind": "rewake_storm", "turns": turns, "window_secs": STORM_WINDOW.as_secs()}),
            );
        } else if turns < STORM_TURNS / 2 && self.storm_active {
            self.storm_active = false;
            self.emit("host_health", json!({"kind": "rewake_storm_cleared", "turns": turns}));
        }
    }

    fn on_prompt_done(&mut self, outbox_id: String, result: RpcResult) {
        let Some(pos) = self.in_flight.iter().position(|id| id == &outbox_id) else { return };
        self.in_flight.remove(pos);
        let stop = result
            .as_ref()
            .ok()
            .and_then(|r| r.get("stopReason"))
            .cloned()
            .unwrap_or(Value::Null);
        let usage = result.as_ref().ok().and_then(|r| r.get("usage")).cloned().unwrap_or(Value::Null);
        let error = result.as_ref().err().cloned();
        if error.is_none() {
            self.record(&outbox_id, None, "picked_up", json!({}));
            self.emit("outbox", json!({"id": outbox_id, "state": "picked_up"}));
        }
        self.emit(
            "prompt_result",
            json!({"id": outbox_id, "stop_reason": stop, "usage": usage, "error": error}),
        );
        self.last_prompt_done = Some(Instant::now());
        if self.state.live() {
            let next = if self.in_flight.is_empty() { State::Idle } else { State::PromptTurn };
            if next != self.state {
                self.set_state(next, json!({}));
            }
        }
    }

    fn tick(&mut self) {
        if self.state == State::AgentTurn && self.last_activity.elapsed() > AGENT_TURN_QUIET {
            self.set_state(State::Idle, json!({"derived": "agent turn quiet for 4s"}));
        }
    }

    /// Hand every queued message to the adapter now; it queues behind any running turn.
    fn dispatch(&mut self) {
        if !self.state.live() {
            return;
        }
        let Some(adapter) = self.adapter.as_ref() else { return };
        let rpc = adapter.rpc.clone();
        let session_id = adapter.session_id.clone();
        loop {
            let Some(pending) = self.outbox.as_mut().and_then(|o| o.queue.pop_front()) else {
                break;
            };
            self.record(&pending.id, None, "sent", json!({}));
            self.emit("outbox", json!({"id": pending.id, "state": "sent", "while": self.state.name()}));
            self.in_flight.push_back(pending.id.clone());
            if self.state == State::Idle {
                self.set_state(State::PromptTurn, json!({"origin": "prompt"}));
            }
            let rpc = rpc.clone();
            let session_id = session_id.clone();
            let events = self.ev_tx.clone();
            let gen = self.gen;
            tauri::async_runtime::spawn(async move {
                let result = rpc
                    .request(
                        "session/prompt",
                        json!({"sessionId": session_id, "prompt": [{"type": "text", "text": pending.text}]}),
                    )
                    .await;
                let _ = events.send(HostEvent::PromptDone { gen, outbox_id: pending.id, result });
            });
        }
    }
}

fn read_session_id(host_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(host_dir.join("session.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("session_id").and_then(Value::as_str).map(str::to_string)
}

fn write_session_id(host_dir: &Path, session_id: &str, home: &Path) {
    let body = json!({"session_id": session_id, "home": home.to_string_lossy(), "at_ms": now_ms()});
    let _ = std::fs::write(host_dir.join("session.json"), body.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A throwaway home whose `bin/fm-lock.sh` is the given shell body.
    fn home_with_lock_script(name: &str, body: Option<&str>) -> PathBuf {
        let home = std::env::temp_dir().join(format!("fm-desktop-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("bin")).unwrap();
        if let Some(body) = body {
            let script = home.join("bin").join("fm-lock.sh");
            std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        home
    }

    async fn lock_for(name: &str, body: Option<&str>) -> Lock {
        let home = home_with_lock_script(name, body);
        let lock = lock_status(&home).await;
        let _ = std::fs::remove_dir_all(&home);
        lock
    }

    #[tokio::test]
    async fn lock_free_and_stale_start() {
        assert!(matches!(lock_for("free", Some("echo 'lock: free'")).await, Lock::Free));
        assert!(matches!(
            lock_for("stale", Some("echo 'lock: stale (pid 5410 dead or not a harness)'")).await,
            Lock::Free
        ));
    }

    #[tokio::test]
    async fn lock_held_reports_the_holder() {
        let lock = lock_for("held", Some(&format!("echo 'lock: held by live harness pid {}'", std::process::id()))).await;
        assert!(matches!(lock, Lock::HeldBy { pid, .. } if pid == std::process::id()));
    }

    #[tokio::test]
    async fn lock_that_cannot_be_confirmed_is_unknown() {
        let missing = lock_for("missing", None).await;
        assert!(matches!(&missing, Lock::Unknown(text) if text.contains("could not run fm-lock.sh")));

        let failed = lock_for("failed", Some("echo 'lock: free'; echo boom >&2; exit 3")).await;
        assert!(matches!(&failed, Lock::Unknown(text) if text.contains("exited with") && text.contains("boom")));

        let unreadable = lock_for("unreadable", Some("echo 'lock: unreadable'")).await;
        assert!(matches!(&unreadable, Lock::Unknown(text) if text.contains("lock: unreadable")));

        let empty = lock_for("empty", Some("true")).await;
        assert!(matches!(empty, Lock::Unknown(_)));
    }

    #[test]
    fn outbox_record_reports_a_failed_write() {
        let path = std::env::temp_dir()
            .join(format!("fm-desktop-test-no-such-dir-{}", std::process::id()))
            .join("outbox.jsonl");
        let outbox = Outbox::load(&path);
        assert!(outbox.record("m1", Some("hello"), "queued", json!({})).is_err());
    }

    #[test]
    fn outbox_reload_keeps_unfinished_messages_in_order() {
        let dir = std::env::temp_dir().join(format!("fm-desktop-test-outbox-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("outbox.jsonl");
        let outbox = Outbox::load(&path);
        outbox.record("a", Some("first"), "queued", json!({})).unwrap();
        outbox.record("b", Some("second"), "queued", json!({})).unwrap();
        outbox.record("c", Some("third"), "queued", json!({})).unwrap();
        outbox.record("a", None, "sent", json!({})).unwrap();
        outbox.record("b", None, "sent", json!({})).unwrap();
        outbox.record("b", None, "picked_up", json!({})).unwrap();
        let reloaded = Outbox::load(&path);
        let seen: Vec<(&str, &str, bool)> = reloaded
            .queue
            .iter()
            .map(|p| (p.id.as_str(), p.text.as_str(), p.ever_sent))
            .collect();
        assert_eq!(seen, vec![("a", "first", true), ("c", "third", false)]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
