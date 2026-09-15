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
//! Commands: `host_start`, `host_stop`, `host_restart`, `send`, `get_state`,
//! `answer_permission`, and `cancel_turn`, which answers "not supported yet".
//! Events: `session`, `state`, `text`, `tool_call`, `update`, `outbox`,
//! `prompt_result`, `usage`, `permission`, `permission_request`,
//! `permission_resolved`, `host_health`.

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

/// Bounded waits, so a hung adapter or script fails a start instead of hanging it.
const HANDSHAKE_WAIT: Duration = Duration::from_secs(60);
/// Loading replays the whole conversation, so it gets longer.
const LOAD_WAIT: Duration = Duration::from_secs(180);
const SET_MODE_WAIT: Duration = Duration::from_secs(30);
const LOCK_WAIT: Duration = Duration::from_secs(15);
const REAP_WAIT: Duration = Duration::from_secs(5);
/// How long firstmate's own session-start hook gets to claim the home's lock on
/// its own. A live probe saw a new session claim it before session/new returned,
/// about 4s after spawn; a resumed session only nudges and claims it on a turn.
const CLAIM_WAIT_BEFORE_NUDGE: Duration = Duration::from_secs(10);
/// How long the session-start turn gets to claim the lock after it is sent.
const CLAIM_WAIT_AFTER_NUDGE: Duration = Duration::from_secs(180);
/// firstmate's own session-start instruction, as `bin/fm-sessionstart-nudge.sh` words it.
const SESSION_START_BODY: &str =
    "Run `bin/fm-session-start.sh` now, exactly once, before executing any other instructions.";

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
    AnswerPermission { id: String, option_id: String, reply: oneshot::Sender<Result<(), String>> },
}

/// Where the host sends its events and keeps its per-home files. The app uses
/// Tauri; the live end-to-end test records the events instead.
pub(crate) trait HostEnv: Send + Sync + 'static {
    fn emit(&self, event: &str, body: Value);
    fn data_dir(&self) -> Result<PathBuf, String>;
}

struct TauriEnv(AppHandle);

impl HostEnv for TauriEnv {
    fn emit(&self, event: &str, body: Value) {
        let _ = self.0.emit(event, body);
    }

    fn data_dir(&self) -> Result<PathBuf, String> {
        self.0.path().app_data_dir().map_err(|e| format!("no app data folder: {e}"))
    }
}

/// Tauri-managed handle to the host task.
pub struct HostHandle {
    tx: mpsc::UnboundedSender<Cmd>,
    groups: Groups,
}

impl HostHandle {
    pub fn spawn(app: AppHandle) -> Self {
        Self::spawn_with(Arc::new(TauriEnv(app)))
    }

    pub(crate) fn spawn_with(env: Arc<dyn HostEnv>) -> Self {
        let (tx, cmd_rx) = mpsc::unbounded_channel();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let groups = Groups::default();
        let host = Host::new(env, ev_tx, groups.clone());
        tauri::async_runtime::spawn(host.run(cmd_rx, ev_rx));
        HostHandle { tx, groups }
    }

    /// Process groups of the adapters running now.
    #[cfg(test)]
    pub(crate) fn live_groups(&self) -> Vec<u32> {
        self.groups.all()
    }

    /// For the app's exit handler: kill every first mate process group still
    /// alive, synchronously, without depending on the host loop being free.
    pub fn kill_on_exit(&self) {
        for pgid in self.groups.all() {
            let report = kill_group_blocking(pgid);
            if has_survivors(&report) {
                log::warn!("first mate processes survived app exit: {report}");
            } else {
                log::info!("stopped the first mate process group on app exit: {report}");
            }
            self.groups.remove(pgid);
        }
    }

    pub(crate) async fn call<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T, String> {
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

/// Registered so the UI gets a clear answer; cancelling and steering a turn
/// land after the first end-to-end run.
#[tauri::command]
pub async fn cancel_turn() -> Result<(), String> {
    Err("cancelling the first mate's turn is not supported yet".to_string())
}

#[tauri::command]
pub async fn get_state(host: TauriState<'_, HostHandle>) -> Result<Value, String> {
    host.call(|reply| Cmd::GetState { reply }).await
}

/// Answer an approval the first mate asked for in an ask-first home.
#[tauri::command]
pub async fn answer_permission(
    id: String,
    option_id: String,
    host: TauriState<'_, HostHandle>,
) -> Result<(), String> {
    host.call(|reply| Cmd::AnswerPermission { id, option_id, reply }).await?
}

// ------------------------------------------------------------------- rpc ---

enum HostEvent {
    Update { gen: u64, params: Value },
    Permission { gen: u64, params: Value, chose: String },
    PermissionAsked { gen: u64, rpc_id: u64, params: Value },
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

    /// `request`, bounded: a hung adapter answers with an error instead of never.
    async fn request_within(&self, method: &str, params: Value, limit: Duration) -> RpcResult {
        tokio::time::timeout(limit, self.request(method, params))
            .await
            .unwrap_or_else(|_| Err(format!("no answer to {method} within {}s", limit.as_secs())))
    }
}

// ------------------------------------------------------- process groups ---

/// How long a group gets to exit after TERM before it is KILLed.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Process groups of adapters this app started and has not killed yet. Shared
/// with the app's exit handler, so no first mate outlives the app.
#[derive(Clone, Default)]
struct Groups(Arc<std::sync::Mutex<Vec<u32>>>);

impl Groups {
    fn with<T>(&self, f: impl FnOnce(&mut Vec<u32>) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }
    fn add(&self, pgid: u32) {
        self.with(|groups| groups.push(pgid));
    }
    fn remove(&self, pgid: u32) {
        self.with(|groups| groups.retain(|g| *g != pgid));
    }
    fn all(&self) -> Vec<u32> {
        self.with(|groups| groups.clone())
    }
}

/// Live members of a process group, as `pid pgid stat command` lines.
/// Zombies are left out: they are already dead and cannot be signalled.
pub(crate) fn group_members(pgid: u32) -> Result<Vec<String>, String> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,pgid=,stat=,comm="])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run ps: {e}"))?;
    if !out.status.success() {
        return Err(format!("ps exited with {}", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| {
            let mut fields = line.split_whitespace().skip(1);
            let group = fields.next().and_then(|g| g.parse::<u32>().ok());
            let stat = fields.next().unwrap_or("");
            group == Some(pgid) && !stat.starts_with('Z')
        })
        .map(|line| line.trim().to_string())
        .collect())
}

/// Signal a whole process group. A group that is already gone is not an error.
fn signal_group(pgid: u32, signal: libc::c_int) -> Result<(), String> {
    let Ok(group) = libc::pid_t::try_from(pgid) else {
        return Err(format!("{pgid} is not a process group id"));
    };
    // SAFETY: killpg only sends a signal; it has no memory-safety preconditions.
    if unsafe { libc::killpg(group, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(error.to_string())
}

/// TERM the group, give it `KILL_GRACE`, KILL whatever is left, then list the
/// group again and report who survived. Blocking; runs off the async loop.
fn kill_group_blocking(pgid: u32) -> Value {
    let listed = |members: &Result<Vec<String>, String>| match members {
        Ok(lines) => json!(lines),
        Err(error) => json!({"error": error}),
    };
    let gone = |members: &Result<Vec<String>, String>| matches!(members, Ok(lines) if lines.is_empty());

    let members = group_members(pgid);
    let term = signal_group(pgid, libc::SIGTERM);
    let deadline = Instant::now() + KILL_GRACE;
    let mut remaining = group_members(pgid);
    while !gone(&remaining) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        remaining = group_members(pgid);
    }
    let mut kill = None;
    if !gone(&remaining) {
        kill = Some(signal_group(pgid, libc::SIGKILL));
        std::thread::sleep(Duration::from_millis(250));
        remaining = group_members(pgid);
    }
    json!({
        "pgid": pgid,
        "members": listed(&members),
        "term_refused": term.err(),
        "killed": kill.is_some(),
        "kill_refused": kill.and_then(Result::err),
        "survivors": listed(&remaining),
    })
}

/// Whether a kill report shows processes that may still be running.
fn has_survivors(report: &Value) -> bool {
    match report.get("survivors") {
        None => false,
        Some(Value::Array(lines)) => !lines.is_empty(),
        // The group could not be listed, so it may still be running.
        Some(_) => true,
    }
}

struct Adapter {
    child: Child,
    rpc: Rpc,
    session_id: String,
    pgid: u32,
    groups: Groups,
    killed: bool,
}

impl Adapter {
    /// Kill the adapter's whole process group, so the Claude CLI and any hook
    /// processes it started do not outlive it, and report any survivors.
    async fn kill_tree(&mut self) -> Value {
        let pgid = self.pgid;
        let report = tokio::task::spawn_blocking(move || kill_group_blocking(pgid))
            .await
            .unwrap_or_else(|e| json!({"pgid": pgid, "survivors": {"error": e.to_string()}}));
        let _ = tokio::time::timeout(REAP_WAIT, self.child.wait()).await;
        self.killed = true;
        self.groups.remove(pgid);
        report
    }
}

impl Drop for Adapter {
    /// Last resort for an adapter dropped without `kill_tree`: KILL the group
    /// at once rather than leave it running.
    fn drop(&mut self) {
        if !self.killed {
            let _ = signal_group(self.pgid, libc::SIGKILL);
            self.groups.remove(self.pgid);
        }
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
    groups: &Groups,
    auto_allow: bool,
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
    // process_group(0) makes the adapter its group's leader: its pid is the pgid.
    let pgid = child.id().ok_or("the adapter exited as soon as it started")?;
    groups.add(pgid);

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
            // Bytes, decoded lossily: one invalid UTF-8 byte must not end the reader.
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let raw = String::from_utf8_lossy(&buf);
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
                    (Some("session/update"), _)
                        if !loading.load(Ordering::SeqCst) => {
                            let params = message.get("params").cloned().unwrap_or(Value::Null);
                            let _ = events.send(HostEvent::Update { gen, params });
                        }
                    (Some("session/request_permission"), Some(id)) => {
                        let params = message.get("params").cloned().unwrap_or(Value::Null);
                        if !auto_allow {
                            // An ask-first home: the adapter only asks when Claude wants a
                            // human, so the captain decides. The request stays open until
                            // answered while this reader keeps reading.
                            let _ = events.send(HostEvent::PermissionAsked { gen, rpc_id: id, params });
                            continue;
                        }
                        // A bypass home skips prompts through the session mode; a request
                        // that still arrives is answered allow_once and reported.
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
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            while let Ok(read) = reader.read_until(b'\n', &mut buf).await {
                if read == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                buf.clear();
                let _ = events.send(HostEvent::Stderr { gen, line });
            }
        });
    }

    let mut adapter = Adapter {
        child,
        rpc: rpc.clone(),
        session_id: String::new(),
        pgid,
        groups: groups.clone(),
        killed: false,
    };
    match open_session(&rpc, &loading, home, resume).await {
        Ok((session_id, mode, session)) => {
            adapter.session_id = session_id;
            Ok(Spawned { adapter, mode, session })
        }
        Err(reason) => {
            let report = adapter.kill_tree().await;
            if has_survivors(&report) {
                return Err(format!("{reason} (and its processes did not all stop: {})", report["survivors"]));
            }
            Err(reason)
        }
    }
}

/// The ACP handshake: initialize, then resume the previous session or open a new one.
async fn open_session(
    rpc: &Rpc,
    loading: &AtomicBool,
    home: &Path,
    resume: Option<String>,
) -> Result<(String, &'static str, Value), String> {
    let init = rpc
        .request_within(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}}),
            HANDSHAKE_WAIT,
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
            .request_within("session/load", json!({"sessionId": previous, "cwd": cwd, "mcpServers": []}), LOAD_WAIT)
            .await;
        loading.store(false, Ordering::SeqCst);
        if let Ok(session) = loaded {
            return Ok((previous, "loaded", session));
        }
    }
    let session = rpc
        .request_within("session/new", json!({"cwd": cwd, "mcpServers": []}), HANDSHAKE_WAIT)
        .await
        .map_err(|e| format!("session/new failed: {e}"))?;
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("session/new returned no sessionId")?
        .to_string();
    Ok((session_id, "new", session))
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
        .kill_on_drop(true)
        .output();
    let Ok(output) = tokio::time::timeout(LOCK_WAIT, output).await else {
        return Lock::Unknown(format!("fm-lock.sh status did not answer within {}s", LOCK_WAIT.as_secs()));
    };
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

/// firstmate's session-start instruction in its own operational wire form, built by
/// `bin/fm-operational-input.sh`. Falls back to the plain text firstmate still
/// recognizes when the encoder is missing or does not answer.
async fn session_start_input(home: &Path) -> String {
    let encoded = async {
        let mut child = envpath::command(home.join("bin").join("fm-operational-input.sh"))
            .args(["encode", "session-start"])
            .env("FM_HOME", home)
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take()?;
        stdin.write_all(SESSION_START_BODY.as_bytes()).await.ok()?;
        drop(stdin);
        let output = child.wait_with_output().await.ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim_end_matches('\n').to_string();
        (output.status.success() && !text.is_empty()).then_some(text)
    };
    tokio::time::timeout(LOCK_WAIT, encoded)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| SESSION_START_BODY.to_string())
}

enum LockClaim {
    Ours,
    Other { pid: u32, command: String },
    Unclaimed(String),
}

/// Wait for the hosted first mate to claim the home's lock, and say whose it
/// became. The holder is ours when it is a live process in our process group.
async fn wait_for_lock_claim(home: &Path, pgid: u32, limit: Duration) -> LockClaim {
    let deadline = Instant::now() + limit;
    loop {
        let last = match lock_status(home).await {
            Lock::HeldBy { pid, command } => {
                let holder = pid.to_string();
                let ours = tokio::task::spawn_blocking(move || group_members(pgid))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .is_some_and(|members| {
                        members.iter().any(|line| line.split_whitespace().next() == Some(holder.as_str()))
                    });
                return if ours { LockClaim::Ours } else { LockClaim::Other { pid, command } };
            }
            Lock::Free => "lock: free".to_string(),
            Lock::Unknown(text) => text,
        };
        if Instant::now() >= deadline {
            return LockClaim::Unclaimed(last);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
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

/// An approval the first mate asked for in an ask-first home, waiting on the captain.
struct AskedPermission {
    rpc_id: u64,
    title: String,
    options: Vec<Value>,
}

struct Host {
    env: Arc<dyn HostEnv>,
    ev_tx: mpsc::UnboundedSender<HostEvent>,
    home: Option<PathBuf>,
    host_dir: Option<PathBuf>,
    outbox: Option<Outbox>,
    adapter: Option<Adapter>,
    gen: u64,
    state: State,
    detail: Value,
    permission: Option<&'static str>,
    asked: HashMap<String, AskedPermission>,
    in_flight: VecDeque<String>,
    started_hint: Option<String>,
    last_activity: Instant,
    last_prompt_done: Option<Instant>,
    agent_turns: u64,
    agent_turn_starts: VecDeque<Instant>,
    storm_active: bool,
    groups: Groups,
}

impl Host {
    fn new(env: Arc<dyn HostEnv>, ev_tx: mpsc::UnboundedSender<HostEvent>, groups: Groups) -> Self {
        Host {
            env,
            ev_tx,
            groups,
            home: None,
            host_dir: None,
            outbox: None,
            adapter: None,
            gen: 0,
            state: State::Stopped,
            detail: json!({}),
            permission: None,
            in_flight: VecDeque::new(),
            asked: HashMap::new(),
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
        self.env.emit(event, body);
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
        // Commands that arrived while a start was running, handled in order after it.
        let mut backlog: VecDeque<Cmd> = VecDeque::new();
        loop {
            if let Some(cmd) = backlog.pop_front() {
                self.handle_cmd(cmd, &mut cmd_rx, &mut backlog).await;
                self.dispatch();
                continue;
            }
            tokio::select! {
                cmd = cmd_rx.recv() => match cmd {
                    Some(cmd) => self.handle_cmd(cmd, &mut cmd_rx, &mut backlog).await,
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

    /// Start, but keep Stop answerable: a Stop that arrives mid-start abandons
    /// the start (an adapter already spawned is KILLed with its group when it is
    /// dropped) and stops at once. Other commands wait for the start to finish.
    async fn start_interruptible(
        &mut self,
        home: PathBuf,
        announce_loaded: bool,
        cmd_rx: &mut mpsc::UnboundedReceiver<Cmd>,
        backlog: &mut VecDeque<Cmd>,
    ) -> Result<(), String> {
        let mut stop_reply = None;
        let finished = {
            let start = self.start(home, announce_loaded);
            tokio::pin!(start);
            loop {
                tokio::select! {
                    result = &mut start => break Some(result),
                    cmd = cmd_rx.recv() => match cmd {
                        Some(Cmd::Stop { reply }) => {
                            stop_reply = Some(reply);
                            break None;
                        }
                        Some(other) => backlog.push_back(other),
                        None => break None,
                    },
                }
            }
        };
        if let Some(result) = finished {
            return result;
        }
        self.stop_now().await;
        if let Some(reply) = stop_reply {
            let _ = reply.send(Ok(()));
        }
        Err("stopped before the first mate finished starting".to_string())
    }

    /// Send the captain's answer to an approval the first mate is waiting on.
    async fn answer_permission(&mut self, id: &str, option_id: &str) -> Result<(), String> {
        let Some(asked) = self.asked.get(id) else {
            return Err("that approval request is no longer waiting".to_string());
        };
        if !asked.options.iter().any(|option| option["option_id"] == option_id) {
            return Err(format!("'{option_id}' is not one of the offered choices"));
        }
        let Some(adapter) = self.adapter.as_ref() else {
            return Err("the first mate is not running".to_string());
        };
        let response = json!({"jsonrpc": "2.0", "id": asked.rpc_id, "result": {"outcome": {"outcome": "selected", "optionId": option_id}}});
        adapter.rpc.write(&response).await?;
        self.asked.remove(id);
        self.emit("permission_resolved", json!({"id": id, "option_id": option_id}));
        Ok(())
    }

    async fn stop_now(&mut self) {
        self.requeue_in_flight();
        self.stop_adapter().await;
        self.set_state(State::Stopped, json!({}));
    }

    async fn handle_cmd(&mut self, cmd: Cmd, cmd_rx: &mut mpsc::UnboundedReceiver<Cmd>, backlog: &mut VecDeque<Cmd>) {
        match cmd {
            Cmd::Start { home, reply } => {
                let result = self.start_interruptible(home, true, cmd_rx, backlog).await;
                let _ = reply.send(result);
            }
            Cmd::Stop { reply } => {
                self.stop_now().await;
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
                let result = self.start_interruptible(home, false, cmd_rx, backlog).await;
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
            Cmd::AnswerPermission { id, option_id, reply } => {
                let _ = reply.send(self.answer_permission(&id, &option_id).await);
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
                    "permission_requests": self
                        .asked
                        .iter()
                        .map(|(id, asked)| json!({"id": id, "title": asked.title, "options": asked.options}))
                        .collect::<Vec<_>>(),
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
        let auto_allow = config_mode == "bypass";
        let spawned = match spawn_adapter(&home, self.ev_tx.clone(), self.gen, resume, &self.groups, auto_allow).await {
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
                .request_within(
                    "session/set_mode",
                    json!({"sessionId": adapter.session_id, "modeId": mode_id}),
                    SET_MODE_WAIT,
                )
                .await
                .map(|_| ())
        } else {
            Err(format!("the Claude Code adapter does not offer the {mode_id} mode"))
        };
        if let Err(error) = applied {
            let report = adapter.kill_tree().await;
            self.report_kill(report, "mode_refused");
            let reason = format!("could not apply config/claude-permission-mode ({config_mode}): {error}");
            self.set_state(State::Refused, json!({"reason": reason}));
            return Err(reason);
        }

        // Only call this first mate running once the home's lock is confirmed to be its
        // own: a terminal session that won the race keeps the home, and ours stops.
        // A new session's hook claims the lock as the session opens. A resumed one only
        // nudges, and firstmate claims the lock on its next turn, so when nothing claims
        // it the host hands the first mate that same session-start instruction as a turn.
        let mut claim = wait_for_lock_claim(&home, adapter.pgid, CLAIM_WAIT_BEFORE_NUDGE).await;
        if matches!(claim, LockClaim::Unclaimed(_)) {
            let input = session_start_input(&home).await;
            let rpc = adapter.rpc.clone();
            let session_id = adapter.session_id.clone();
            tauri::async_runtime::spawn(async move {
                // The claim below is the authority on whether this turn worked.
                let _ = rpc
                    .request("session/prompt", json!({"sessionId": session_id, "prompt": [{"type": "text", "text": input}]}))
                    .await;
            });
            claim = wait_for_lock_claim(&home, adapter.pgid, CLAIM_WAIT_AFTER_NUDGE).await;
        }
        match claim {
            LockClaim::Ours => {}
            LockClaim::Other { pid, command } => {
                let report = adapter.kill_tree().await;
                self.report_kill(report, "lock_taken");
                self.set_state(
                    State::LockedByOther,
                    json!({"holder_pid": pid, "holder_command": command}),
                );
                return Ok(());
            }
            LockClaim::Unclaimed(text) => {
                let report = adapter.kill_tree().await;
                self.report_kill(report, "lock_unclaimed");
                let reason = format!(
                    "the first mate did not claim this home's session lock within {}s of being asked to start its session, so it was stopped. {text}",
                    CLAIM_WAIT_AFTER_NUDGE.as_secs()
                );
                self.set_state(State::Refused, json!({"reason": reason, "lock_status": text}));
                return Err(reason);
            }
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
        let dir = self.env.data_dir()?.join("homes").join(key);
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

    /// Before a restart: everything not yet picked up goes back to the queue from
    /// the durable log, and each message that was already handed over is marked
    /// requeued. The log, not `in_flight`, decides, because a crash or an error
    /// result has already cleared `in_flight` by the time a restart happens.
    fn requeue_in_flight(&mut self) {
        self.in_flight.clear();
        self.started_hint = None;
        let (Some(outbox), Some(host_dir)) = (self.outbox.as_mut(), self.host_dir.as_ref()) else {
            return;
        };
        outbox.queue = Outbox::load(&host_dir.join("outbox.jsonl")).queue;
        let resent: Vec<String> = outbox.queue.iter().filter(|p| p.ever_sent).map(|p| p.id.clone()).collect();
        for id in resent {
            self.record(&id, None, "requeued", json!({"resent_after_restart": true}));
            self.emit("outbox", json!({"id": id, "state": "requeued", "resent_after_restart": true}));
        }
    }

    async fn stop_adapter(&mut self) {
        // Open approvals belong to the adapter being stopped; they cannot be answered after it.
        self.asked.clear();
        if let Some(mut adapter) = self.adapter.take() {
            let report = adapter.kill_tree().await;
            self.report_kill(report, "stop");
        }
    }

    /// `kill_refused` means processes may still be running; anything else is a
    /// routine `kill_group` record.
    fn report_kill(&self, report: Value, after: &str) {
        report_kill(self.env.as_ref(), report, after);
    }

    fn handle_event(&mut self, event: HostEvent) {
        match event {
            HostEvent::Update { gen, params } if gen == self.gen => self.on_update(params),
            HostEvent::Permission { gen, params, chose } if gen == self.gen => {
                let title = params.pointer("/toolCall/title").and_then(Value::as_str).unwrap_or("");
                self.emit("permission", json!({"title": title, "chose": chose}));
            }
            HostEvent::PermissionAsked { gen, rpc_id, params } if gen == self.gen => {
                let title = params
                    .pointer("/toolCall/title")
                    .and_then(Value::as_str)
                    .unwrap_or("an action")
                    .to_string();
                let options: Vec<Value> = params
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .map(|o| json!({"option_id": o.get("optionId"), "name": o.get("name"), "kind": o.get("kind")}))
                            .collect()
                    })
                    .unwrap_or_default();
                let id = format!("g{gen}-r{rpc_id}");
                self.emit("permission_request", json!({"id": id, "title": title, "options": options}));
                self.asked.insert(id, AskedPermission { rpc_id, title, options });
            }
            HostEvent::Stderr { gen, line } if gen == self.gen => {
                let short: String = line.chars().take(240).collect();
                self.emit("host_health", json!({"kind": "adapter_stderr", "line": short}));
            }
            HostEvent::Exited { gen } if gen == self.gen && self.state.live() => {
                self.asked.clear();
                // The adapter is gone, but the Claude CLI and hook processes it
                // started may not be: kill the group off the loop.
                if let Some(mut adapter) = self.adapter.take() {
                    let env = self.env.clone();
                    tauri::async_runtime::spawn(async move {
                        let report = adapter.kill_tree().await;
                        report_kill(env.as_ref(), report, "exit");
                    });
                }
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
        } else if let Some(message) = error.as_deref().and_then(session_limit_message) {
            // The adapter also streams this as chat text; the health event is what
            // tells the UI the account is out of turns rather than the mate talking.
            self.emit(
                "host_health",
                json!({"kind": "session_limit", "id": outbox_id, "warning": message}),
            );
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
        // Quiet only ends an agent turn; with a prompt in flight its result decides.
        if self.state == State::AgentTurn
            && self.in_flight.is_empty()
            && self.last_activity.elapsed() > AGENT_TURN_QUIET
        {
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
        while let Some(pending) = self.outbox.as_mut().and_then(|o| o.queue.pop_front()) {
            self.record(&pending.id, None, "sent", json!({}));
            self.emit("outbox", json!({"id": pending.id, "state": "sent", "while": self.state.name()}));
            self.in_flight.push_back(pending.id.clone());
            // A prompt in flight is a prompt turn, even when it was handed over
            // during an agent turn and is queued behind it.
            if self.state != State::PromptTurn {
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

/// The user-facing text of a prompt error that means the Claude account hit its
/// usage limit, as the adapter reports it: `data.errorKind == "rate_limit"`.
fn session_limit_message(error: &str) -> Option<String> {
    let error: Value = serde_json::from_str(error).ok()?;
    if error.pointer("/data/errorKind").and_then(Value::as_str) != Some("rate_limit") {
        return None;
    }
    let message = error.get("message").and_then(Value::as_str).unwrap_or("Claude's usage limit was reached");
    Some(message.trim_start_matches("Internal error: ").to_string())
}

fn report_kill(env: &dyn HostEnv, report: Value, after: &str) {
    let kind = if has_survivors(&report) { "kill_refused" } else { "kill_group" };
    env.emit("host_health", json!({"kind": kind, "after": after, "report": report, "at_ms": now_ms()}));
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

    /// A process group whose shell and two children ignore TERM, like a stuck hook.
    fn spawn_stubborn_group() -> (std::process::Child, u32) {
        use std::os::unix::process::CommandExt;
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; sleep 30 & sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        while group_members(pgid).unwrap().len() < 3 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        (child, pgid)
    }

    #[test]
    fn kill_group_escalates_and_relists_survivors() {
        let (mut child, pgid) = spawn_stubborn_group();
        assert_eq!(group_members(pgid).unwrap().len(), 3);
        let report = kill_group_blocking(pgid);
        let _ = child.wait();
        assert_eq!(report["killed"], json!(true), "{report}");
        assert_eq!(report["survivors"], json!([]), "{report}");
        assert!(!has_survivors(&report));
        assert!(group_members(pgid).unwrap().is_empty());
    }

    #[test]
    fn kill_group_of_a_gone_group_is_quiet() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        let report = kill_group_blocking(pid);
        assert_eq!(report["term_refused"], Value::Null, "{report}");
        assert_eq!(report["killed"], json!(false), "{report}");
        assert!(!has_survivors(&report));
    }

    #[test]
    fn has_survivors_treats_an_unlisted_group_as_possibly_alive() {
        assert!(has_survivors(&json!({"survivors": ["123 123 S sleep"]})));
        assert!(has_survivors(&json!({"survivors": {"error": "could not run ps"}})));
        assert!(!has_survivors(&json!({"survivors": []})));
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

    #[test]
    fn session_limit_is_read_from_the_adapter_error() {
        // Verbatim from the live run's prompt_result.
        let limit = r#"{"code":-32603,"data":{"errorKind":"rate_limit"},"message":"Internal error: You've hit your session limit · resets 1:50pm (America/Los_Angeles)"}"#;
        assert_eq!(
            session_limit_message(limit).as_deref(),
            Some("You've hit your session limit · resets 1:50pm (America/Los_Angeles)")
        );
        assert_eq!(session_limit_message(r#"{"code":-32603,"message":"Internal error: boom"}"#), None);
        assert_eq!(session_limit_message("the adapter exited"), None);
    }

    #[tokio::test]
    async fn lock_claim_is_ours_only_when_the_holder_is_in_our_group() {
        let (mut child, pgid) = spawn_stubborn_group();
        let member = group_members(pgid).unwrap()[1].split_whitespace().next().unwrap().to_string();

        let ours = home_with_lock_script("claim-ours", Some(&format!("echo 'lock: held by live harness pid {member}'")));
        assert!(matches!(wait_for_lock_claim(&ours, pgid, Duration::from_secs(1)).await, LockClaim::Ours));

        let other = home_with_lock_script(
            "claim-other",
            Some(&format!("echo 'lock: held by live harness pid {}'", std::process::id())),
        );
        assert!(matches!(
            wait_for_lock_claim(&other, pgid, Duration::from_secs(1)).await,
            LockClaim::Other { pid, .. } if pid == std::process::id()
        ));

        let free = home_with_lock_script("claim-free", Some("echo 'lock: free'"));
        let started = Instant::now();
        assert!(matches!(
            wait_for_lock_claim(&free, pgid, Duration::from_secs(1)).await,
            LockClaim::Unclaimed(text) if text == "lock: free"
        ));
        assert!(started.elapsed() < Duration::from_secs(3));

        kill_group_blocking(pgid);
        let _ = child.wait();
        for home in [ours, other, free] {
            let _ = std::fs::remove_dir_all(home);
        }
    }

    /// Tests that point ACP_ADAPTER at a fake adapter take this, since the variable is process-wide.
    static ADAPTER_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Answers the handshake, then asks for one approval during a prompt and
    /// replies with the option it was given.
    const FAKE_ADAPTER: &str = r#"#!/usr/bin/env python3
import json, os, sys
home = os.environ["FM_HOME"]
def claim():
    open(os.path.join(home, "adapter.pid"), "w").write(str(os.getpid()))
# A resumed firstmate session claims the lock only on a turn; the flag mimics that.
claim_on_prompt = os.path.exists(os.path.join(home, "claim-on-prompt"))
if not claim_on_prompt:
    claim()
def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()
prompt = None
while True:
    line = sys.stdin.readline()
    if not line:
        break
    m = json.loads(line)
    method = m.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"agentCapabilities": {"loadSession": False}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": "s1", "modes": {"availableModes": [{"id": "auto"}, {"id": "bypassPermissions"}]}}})
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
    elif method == "session/prompt":
        text = "".join(part.get("text", "") for part in m["params"]["prompt"])
        open(os.path.join(home, "prompts.log"), "a").write(text + "\n")
        if "fm-session-start.sh" in text:
            claim()
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
            continue
        prompt = m["id"]
        send({"jsonrpc": "2.0", "id": 9001, "method": "session/request_permission", "params": {"sessionId": "s1", "toolCall": {"title": "Delete the build folder"}, "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]}})
    elif method is None and m.get("id") == 9001:
        chose = m["result"]["outcome"]["optionId"]
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "chose " + chose}}}})
        send({"jsonrpc": "2.0", "id": prompt, "result": {"stopReason": "end_turn"}})
"#;

    #[derive(Default)]
    struct EventLog(std::sync::Mutex<Vec<(String, Value)>>);

    struct RecordingEnv {
        dir: PathBuf,
        log: Arc<EventLog>,
    }

    impl HostEnv for RecordingEnv {
        fn emit(&self, event: &str, body: Value) {
            self.log.0.lock().unwrap().push((event.to_string(), body));
        }

        fn data_dir(&self) -> Result<PathBuf, String> {
            Ok(self.dir.clone())
        }
    }

    async fn wait_for(log: &EventLog, limit: Duration, pred: impl Fn(&str, &Value) -> bool) -> Option<Value> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Some((_, body)) = log.0.lock().unwrap().iter().find(|(event, body)| pred(event, body)) {
                return Some(body.clone());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        None
    }

    /// Runs one prompt on the fake adapter in a home with the given permission
    /// mode, answering the approval with `answer` when the captain is asked.
    async fn fake_permission_turn(name: &str, mode: Option<&str>, answer: Option<&str>) -> (Vec<(String, Value)>, String) {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = home_with_lock_script(
            name,
            Some(r#"if [ -f "$FM_HOME/adapter.pid" ]; then echo "lock: held by live harness pid $(cat "$FM_HOME/adapter.pid")"; else echo 'lock: free'; fi"#),
        );
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        if let Some(mode) = mode {
            std::fs::create_dir_all(home.join("config")).unwrap();
            std::fs::write(home.join("config").join("claude-permission-mode"), format!("{mode}\n")).unwrap();
        }
        let adapter = home.join("fake-adapter.py");
        std::fs::write(&adapter, FAKE_ADAPTER).unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ACP_ADAPTER", &adapter);

        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("start");
        host.call(|reply| Cmd::Send { text: "go".into(), reply }).await.unwrap().expect("send");
        if let Some(answer) = answer {
            let request = wait_for(&log, Duration::from_secs(10), |e, _| e == "permission_request")
                .await
                .expect("the captain was asked");
            let id = request["id"].as_str().unwrap().to_string();
            host.call(|reply| Cmd::AnswerPermission { id, option_id: answer.to_string(), reply })
                .await
                .unwrap()
                .expect("the answer was accepted");
        }
        let done = wait_for(&log, Duration::from_secs(10), |e, b| e == "outbox" && b["state"] == "picked_up").await;
        let _ = host.call(|reply| Cmd::Stop { reply }).await;
        let events = log.0.lock().unwrap().clone();
        assert!(done.is_some(), "the prompt never finished: {events:?}");
        let text = events
            .iter()
            .filter(|(event, _)| event == "text")
            .filter_map(|(_, body)| body["text"].as_str())
            .collect();
        let _ = std::fs::remove_dir_all(&home);
        (events, text)
    }

    /// A resumed session whose hook only nudged: the host sends firstmate's
    /// session-start instruction as a turn, and starts once that claims the lock.
    #[tokio::test]
    async fn unclaimed_lock_gets_the_session_start_turn() {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = home_with_lock_script(
            "claim-on-prompt",
            Some(r#"if [ -f "$FM_HOME/adapter.pid" ]; then echo "lock: held by live harness pid $(cat "$FM_HOME/adapter.pid")"; else echo 'lock: free'; fi"#),
        );
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        std::fs::write(home.join("claim-on-prompt"), "").unwrap();
        let adapter = home.join("fake-adapter.py");
        std::fs::write(&adapter, FAKE_ADAPTER).unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ACP_ADAPTER", &adapter);

        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        let started = host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap();
        let prompts = std::fs::read_to_string(home.join("prompts.log")).unwrap_or_default();
        let idle = wait_for(&log, Duration::from_secs(2), |e, b| e == "state" && b["state"] == "idle").await;
        let _ = host.call(|reply| Cmd::Stop { reply }).await;
        let _ = std::fs::remove_dir_all(&home);

        assert!(started.is_ok(), "{started:?}");
        assert!(prompts.contains("fm-session-start.sh"), "no session-start turn was sent: {prompts:?}");
        assert!(idle.is_some(), "the first mate never became ready");
    }

    #[tokio::test]
    async fn ask_first_home_asks_the_captain_and_sends_their_answer() {
        let (events, text) = fake_permission_turn("perm-auto", Some("auto"), Some("reject")).await;
        assert_eq!(text, "chose reject");
        let request = events.iter().find(|(e, _)| e == "permission_request").map(|(_, b)| b).unwrap();
        assert_eq!(request["title"], "Delete the build folder");
        assert!(events.iter().any(|(e, b)| e == "permission_resolved" && b["option_id"] == "reject"));
        assert!(!events.iter().any(|(e, _)| e == "permission"), "an ask-first home never auto-approves");
    }

    #[tokio::test]
    async fn bypass_home_approves_without_asking() {
        let (events, text) = fake_permission_turn("perm-bypass", None, None).await;
        assert_eq!(text, "chose allow");
        assert!(!events.iter().any(|(e, _)| e == "permission_request"));
    }

    struct QuietEnv(PathBuf);

    impl HostEnv for QuietEnv {
        fn emit(&self, _event: &str, _body: Value) {}

        fn data_dir(&self) -> Result<PathBuf, String> {
            Ok(self.0.clone())
        }
    }

    /// An adapter that never answers `initialize` must not make Stop hang, and
    /// the abandoned start must not leave its process group running.
    #[tokio::test]
    async fn stop_answers_while_the_adapter_hangs_in_its_handshake() {
        let home = home_with_lock_script("hung-adapter", Some("echo 'lock: free'"));
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        let adapter = home.join("hung-adapter.sh");
        std::fs::write(&adapter, "#!/bin/sh\nsleep 600 &\nexec sleep 600\n").unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _adapter_env = ADAPTER_ENV.lock().await;
        std::env::set_var("ACP_ADAPTER", &adapter);

        let host = HostHandle::spawn_with(Arc::new(QuietEnv(home.join("appdata"))));
        let start = host.call(|reply| Cmd::Start { home: home.clone(), reply });
        let stop = async {
            let deadline = Instant::now() + Duration::from_secs(10);
            while host.groups.all().is_empty() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let pgid = host.groups.all().first().copied();
            let asked = Instant::now();
            let answer = tokio::time::timeout(Duration::from_secs(10), host.call(|reply| Cmd::Stop { reply })).await;
            (pgid, answer, asked.elapsed())
        };
        let (started, (pgid, stopped, took)) = tokio::join!(start, stop);

        assert!(matches!(&started, Ok(Err(reason)) if reason.contains("stopped before")), "{started:?}");
        assert!(matches!(stopped, Ok(Ok(Ok(())))), "stop did not answer: {stopped:?}");
        assert!(took < Duration::from_secs(5), "stop took {took:?}");
        let pgid = pgid.expect("the hung adapter was spawned");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !group_members(pgid).unwrap().is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(group_members(pgid).unwrap().is_empty(), "{:?}", group_members(pgid));
        assert!(host.groups.all().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
