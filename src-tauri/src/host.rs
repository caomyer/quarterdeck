//! The ACP host: runs the first mate as one `claude-agent-acp` session in the
//! firstmate home and reports everything the UI needs as events.
//!
//! Contract (from the host spike, `FIRSTMATE_DESKTOP_ACP_HOST_SPIKE.md`):
//! - the adapter's stdout is read continuously, so turns the first mate starts
//!   on its own (Stop-hook rewakes) are observed instead of lost;
//! - turn state is derived, because agent-initiated turns carry no start
//!   marker: activity with no prompt in flight is an agent turn, ended by the
//!   usage update the adapter tags with the result's origin, or by silence when
//!   the adapter does not tag results;
//! - captain messages go to a durable outbox. They are handed to the adapter at
//!   once, which queues them behind a running prompt, except during an agent
//!   turn: the CLI folds a message that arrives then into the running cycle, whose
//!   result never settles the message's prompt, so it waits for the turn to end;
//! - every start opens with firstmate's session-start instruction as a turn,
//!   unless a captain message is waiting to be that first turn: firstmate's
//!   watcher is armed by its Stop hook when a turn ends, so a session that never
//!   had a turn is never woken for work that is waiting;
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

/// How long an agent-initiated turn may stay silent before it is considered over,
/// with an adapter that does not say when a turn's result arrives.
const AGENT_TURN_QUIET: Duration = Duration::from_secs(4);
/// The same, with an adapter that marks each turn's result: the mark ends the turn,
/// and silence ends it only as a safety net for a mark that never came. A step still
/// running holds the turn open up to `AGENT_TURN_STEP_LIMIT`.
const AGENT_TURN_QUIET_MARKED: Duration = Duration::from_secs(60);
const AGENT_TURN_STEP_LIMIT: Duration = Duration::from_secs(600);
/// Result origins `claude-agent-acp` counts as the model's own cycle rather than a
/// prompt's (its `AUTONOMOUS_RESULT_ORIGINS`). A Stop-hook rewake is a
/// `task-notification`. The adapter never settles a prompt with such a result, so a
/// prompt the CLI folded into one of these cycles would never be answered.
const AUTONOMOUS_ORIGINS: [&str; 5] = ["task-notification", "peer", "coordinator", "observer", "observer-activity"];
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
/// A live holder that is not ours by then stops the start.
const CLAIM_WAIT: Duration = Duration::from_secs(10);
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
    /// The home of the last Start the captain asked for.
    started_home: std::sync::Mutex<Option<PathBuf>>,
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
        HostHandle { tx, groups, started_home: std::sync::Mutex::new(None) }
    }

    fn note_started_home(&self, home: &Path) {
        *self.started_home.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(home.to_path_buf());
    }

    fn started_home(&self) -> Option<PathBuf> {
        self.started_home.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
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
    app: AppHandle,
    host: TauriState<'_, HostHandle>,
    snapshots: TauriState<'_, crate::snapshot::SnapshotHandle>,
) -> Result<(), String> {
    let home = PathBuf::from(home);
    // The captain wants it running here until they stop it, including across a relaunch.
    crate::settings::note_running(&app, &home, true);
    host.note_started_home(&home);
    snapshots.set_home(home.clone()).await?;
    // Scouts in this home present their pages here rather than in a browser. Not being able to
    // record that never stops the first mate: they fall back to the home's existing review loop.
    match crate::artifact::claim_presentation(&home) {
        Ok(outcome) => log::info!("presentation mode for {}: {outcome:?}", home.display()),
        Err(error) => log::warn!("could not record the presentation mode: {error}"),
    }
    host.call(|reply| Cmd::Start { home, reply }).await?
}

#[tauri::command]
pub async fn host_stop(app: AppHandle, host: TauriState<'_, HostHandle>) -> Result<(), String> {
    // Read without asking the host loop, so Stop still answers while a start is running.
    if let Some(home) = host.started_home() {
        crate::settings::note_running(&app, &home, false);
    }
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
    SessionStartDone { gen: u64, result: RpcResult },
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

/// A process's start time as `ps` prints it, which with its pid identifies it.
fn process_started(pid: u32) -> Option<String> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let started = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!started.is_empty()).then_some(started)
}

/// Remember which process group this app started for a home, and which app
/// started it, so a later start can stop it if the app dies without stopping it.
fn record_adapter(host_dir: &Path, pgid: u32) {
    let app = std::process::id();
    let (Some(started), Some(app_started)) = (process_started(pgid), process_started(app)) else {
        return;
    };
    let body = json!({"pgid": pgid, "started": started, "app_pid": app, "app_started": app_started});
    let _ = std::fs::write(host_dir.join("adapter.json"), body.to_string());
}

/// Stop the process group a previous app left running for this home. Only when it
/// is provably that group: the recording app is gone, and the group's leader is the
/// same process (same start time) or has exited while the group lives on, since a
/// group id cannot be reused while any member remains. Returns the kill report.
async fn stop_leftover(host_dir: &Path, groups: &Groups) -> Option<Value> {
    let path = host_dir.join("adapter.json");
    let record: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    let pgid = u32::try_from(record["pgid"].as_u64()?).ok()?;
    let started = record["started"].as_str()?.to_string();
    let app = u32::try_from(record["app_pid"].as_u64()?).ok()?;
    let app_started = record["app_started"].as_str()?.to_string();
    if groups.all().contains(&pgid) {
        return None;
    }
    let ours = tokio::task::spawn_blocking(move || {
        if process_started(app).as_deref() == Some(app_started.as_str()) {
            return false; // the app that started it is still running and owns it
        }
        match process_started(pgid) {
            Some(now) => now == started,
            None => group_members(pgid).is_ok_and(|members| !members.is_empty()),
        }
    })
    .await
    .unwrap_or(false);
    let _ = std::fs::remove_file(&path);
    if !ours {
        return None;
    }
    tokio::task::spawn_blocking(move || kill_group_blocking(pgid)).await.ok()
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
    /// The updates a resumed session replayed, in order; empty for a new session.
    history: Vec<Value>,
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
    let program = envpath::resolve(&name).ok_or_else(|| {
        format!(
            "{name} was not found on PATH or where these tools are installed. Install it with `npm i -g @agentclientprotocol/claude-agent-acp`, or start the app with its folder on PATH."
        )
    })?;
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
    // While session/load replays history, its updates are not live activity: they
    // are kept in `replay` and handed to the UI as the earlier conversation.
    let loading = Arc::new(AtomicBool::new(false));
    let replay: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

    {
        let rpc = rpc.clone();
        let events = events.clone();
        let loading = loading.clone();
        let replay = replay.clone();
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
                    (Some("session/update"), _) => {
                        let params = message.get("params").cloned().unwrap_or(Value::Null);
                        if loading.load(Ordering::SeqCst) {
                            if let Ok(mut replay) = replay.lock() {
                                replay.push(params.get("update").cloned().unwrap_or(Value::Null));
                            }
                        } else {
                            let _ = events.send(HostEvent::Update { gen, params });
                        }
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
            let history = replay.lock().map(|mut replay| std::mem::take(&mut *replay)).unwrap_or_default();
            Ok(Spawned { adapter, mode, session, history })
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
    Other { pid: u32, command: String, facts: Value },
    Unclaimed(String),
}

/// A process's parent, process group, and command, as `ps` reports them.
fn process_facts(pid: u32) -> Option<(u32, u32, String)> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "ppid=,pgid=,command=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut fields = line.split_whitespace();
    let ppid = fields.next()?.parse().ok()?;
    let group = fields.next()?.parse().ok()?;
    Some((ppid, group, fields.collect::<Vec<_>>().join(" ")))
}

/// Whether the process holding the home's lock is this first mate, and the evidence
/// either way. firstmate writes whichever process in the hook's ancestry it reads as
/// the harness, which is not always the group leader we track, so ownership is read
/// three ways: the same process group, a live member of it, or a descendant of its
/// leader. The evidence rides along so a refusal can be explained afterwards.
fn holder_is_ours(holder: u32, pgid: u32) -> (bool, Value) {
    let facts = process_facts(holder);
    let members = group_members(pgid);
    let holder_text = holder.to_string();
    let in_group = members
        .as_ref()
        .is_ok_and(|members| members.iter().any(|line| line.split_whitespace().next() == Some(holder_text.as_str())));
    let same_group = facts.as_ref().is_some_and(|(_, group, _)| *group == pgid);
    let mut ancestry: Vec<u32> = Vec::new();
    let mut descends = false;
    let mut walk = holder;
    for _ in 0..8 {
        let Some((parent, _, _)) = process_facts(walk) else { break };
        ancestry.push(parent);
        if parent == pgid {
            descends = true;
            break;
        }
        if parent <= 1 {
            break;
        }
        walk = parent;
    }
    let evidence = json!({
        "holder_pid": holder,
        "holder_ppid": facts.as_ref().map(|(ppid, _, _)| *ppid),
        "holder_pgid": facts.as_ref().map(|(_, group, _)| *group),
        "holder_command": facts.as_ref().map(|(_, _, command)| command.clone()),
        "our_pgid": pgid,
        "our_group": match &members {
            Ok(members) => json!(members),
            Err(error) => json!({"error": error}),
        },
        "holder_ancestry": ancestry,
        "in_group": in_group,
        "same_group": same_group,
        "descends_from_ours": descends,
    });
    (in_group || same_group || descends, evidence)
}

/// Wait for the hosted first mate to claim the home's lock, and say whose it
/// became. The holder is ours when it is a live process in our process group.
async fn wait_for_lock_claim(home: &Path, pgid: u32, limit: Duration) -> LockClaim {
    let deadline = Instant::now() + limit;
    loop {
        let last = match lock_status(home).await {
            Lock::HeldBy { pid, command } => {
                let (ours, facts) = tokio::task::spawn_blocking(move || holder_is_ours(pid, pgid))
                    .await
                    .unwrap_or_else(|error| (false, json!({"error": error.to_string()})));
                return if ours { LockClaim::Ours } else { LockClaim::Other { pid, command, facts } };
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
                (!matches!(state.as_str(), "picked_up" | "failed")).then_some(Pending { id, text, ever_sent })
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
    /// When the last turn's result arrived, prompt or agent: usage just after it is a trailer.
    last_turn_end: Option<Instant>,
    /// The adapter tags each result with its origin, so an agent turn ends at its result.
    marks_results: bool,
    open_steps: std::collections::HashSet<String>,
    /// firstmate's session-start turn is running.
    helm: bool,
    agent_turns: u64,
    agent_turn_starts: VecDeque<Instant>,
    /// The turn count last reported as a rewake storm, while one lasts.
    storm_reported: Option<usize>,
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
            last_turn_end: None,
            marks_results: false,
            open_steps: std::collections::HashSet::new(),
            helm: false,
            agent_turns: 0,
            agent_turn_starts: VecDeque::new(),
            storm_reported: None,
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
                    "rewake_storm": self.storm_reported.is_some(),
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
        let home = match std::fs::canonicalize(&home) {
            Ok(home) => home,
            Err(error) => {
                let reason = format!("{} is not a readable folder: {error}", home.display());
                self.set_state(State::Refused, json!({"reason": reason, "reason_kind": "not_a_home"}));
                return Err(reason);
            }
        };
        if !home.join("AGENTS.md").is_file() || !home.join("bin").is_dir() {
            let reason = format!("{} is not a firstmate home", home.display());
            self.set_state(State::Refused, json!({"reason": reason, "reason_kind": "not_a_home"}));
            return Err(reason);
        }
        if self.adapter.is_some() {
            self.stop_adapter().await;
        }
        self.set_state(State::Starting, json!({"home": home.to_string_lossy()}));

        let host_dir = self.host_dir_for(&home)?;
        // A first mate left behind by a crashed or force-quit app still holds this
        // home and would read as running elsewhere; stop it first if it is provably ours.
        if let Some(report) = stop_leftover(&host_dir, &self.groups).await {
            self.report_kill(report, "leftover");
        }
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
                self.set_state(State::Refused, json!({"reason": reason, "reason_kind": "permission_mode"}));
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
                self.set_state(
                    State::Refused,
                    json!({"reason": reason, "reason_kind": "lock_unconfirmed", "lock_status": text}),
                );
                return Err(reason);
            }
            Lock::Free => {}
        }

        let resume = read_session_id(&host_dir);
        let had_previous = resume.is_some();
        self.gen += 1;
        let auto_allow = config_mode == "bypass";
        let spawned = match spawn_adapter(&home, self.ev_tx.clone(), self.gen, resume, &self.groups, auto_allow).await {
            Ok(spawned) => spawned,
            Err(reason) => {
                self.set_state(
                    State::Dead,
                    json!({"reason": reason, "reason_kind": adapter_failure_kind(&reason)}),
                );
                return Err(reason);
            }
        };
        let Spawned { mut adapter, mode, session, history } = spawned;
        record_adapter(&host_dir, adapter.pgid);

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
            self.report_kill(report, "start_failed");
            // An adapter that crashed or hung while applying the mode is not a bad
            // permission setting; say which one it was.
            if cut_off_by_exit(&error) || error.starts_with("no answer to") {
                let reason = format!("the first mate stopped while starting: {error}");
                self.set_state(
                    State::Dead,
                    json!({"reason": reason, "reason_kind": adapter_failure_kind(&error)}),
                );
                return Err(reason);
            }
            let reason = format!("could not apply config/claude-permission-mode ({config_mode}): {error}");
            self.set_state(State::Refused, json!({"reason": reason, "reason_kind": "permission_mode"}));
            return Err(reason);
        }

        // The lock guards against two first mates in one home, so a live holder that is
        // not ours stops this start. Nobody holding it is a different matter: after a
        // crash the lock names a dead process, which firstmate reads as stale, so nothing
        // else is running. A resumed session claims it only on a turn, which comes below.
        // Never stop our own first mate over an unclaimed lock; say it plainly instead.
        match wait_for_lock_claim(&home, adapter.pgid, CLAIM_WAIT).await {
            LockClaim::Ours => {}
            LockClaim::Other { pid, command, facts } => {
                let report = adapter.kill_tree().await;
                self.report_kill(report, "lock_taken");
                // The evidence rides along: a first mate wrongly read as someone else's
                // has to be explainable from the recording alone.
                self.set_state(
                    State::LockedByOther,
                    json!({"holder_pid": pid, "holder_command": command, "holder_facts": facts}),
                );
                return Ok(());
            }
            // Diagnostics, not a banner: firstmate may record an owner for this home
            // well after the start, and a captain should not be greeted with the app's
            // own bookkeeping when the first mate is running and nothing else holds it.
            LockClaim::Unclaimed(text) => self.emit(
                "host_health",
                json!({
                    "kind": "lock_unclaimed",
                    "lock_status": text,
                    "detail": "firstmate has not recorded a session owner for this home yet",
                }),
            ),
        }

        write_session_id(&host_dir, &adapter.session_id, &home);
        self.emit(
            "session",
            json!({
                "mode": mode,
                "session_id": adapter.session_id,
                "permission_mode": config_mode,
                // An earlier conversation existed but could not be resumed.
                "previous_session_lost": had_previous && mode == "new",
            }),
        );
        if mode == "loaded" {
            self.emit("history", json!({"items": history_items(&history)}));
        }
        self.adapter = Some(adapter);
        self.in_flight.clear();
        self.started_hint = None;
        // firstmate hands work to an idle first mate through its watcher, which its Stop
        // hook arms when a turn ends, and its session start is what a first turn is for:
        // a new session's hook put the digest in context, a resumed one's put the
        // instruction to run it. Until some turn runs, nothing waiting is ever handled.
        // A captain message waiting to go is that first turn; otherwise the host sends
        // firstmate's own session-start instruction, as its nudge words it.
        if !self.outbox.as_ref().is_some_and(|outbox| !outbox.queue.is_empty()) {
            let input = session_start_input(&home).await;
            self.take_the_helm(input);
        } else {
            self.set_state(State::Idle, json!({}));
        }
        Ok(())
    }

    /// Sends the session-start turn. It is the first mate's own turn rather than a captain
    /// message: nothing in the outbox, and messages the captain sends meanwhile wait for it.
    fn take_the_helm(&mut self, input: String) {
        let Some(adapter) = self.adapter.as_ref() else { return };
        let rpc = adapter.rpc.clone();
        let session_id = adapter.session_id.clone();
        let events = self.ev_tx.clone();
        let gen = self.gen;
        self.helm = true;
        self.last_activity = Instant::now();
        self.set_state(State::AgentTurn, json!({"origin": "session_start"}));
        tauri::async_runtime::spawn(async move {
            let result = rpc
                .request("session/prompt", json!({"sessionId": session_id, "prompt": [{"type": "text", "text": input}]}))
                .await;
            let _ = events.send(HostEvent::SessionStartDone { gen, result });
        });
    }

    fn on_session_start_done(&mut self, result: RpcResult) {
        self.helm = false;
        self.last_turn_end = Some(Instant::now());
        let stop = result.as_ref().ok().and_then(|r| r.get("stopReason")).cloned().unwrap_or(Value::Null);
        let error = result.err();
        if let Some(message) = error.as_deref().and_then(session_limit_message) {
            self.emit("host_health", json!({"kind": "session_limit", "id": "session-start", "warning": message}));
        }
        // Diagnostics, not a banner: what firstmate's session start came back with.
        self.emit("host_health", json!({"kind": "session_start_turn", "stop_reason": stop, "error": error}));
        self.end_agent_turn(json!({"derived": "session start turn done"}));
    }

    fn host_dir_for(&self, home: &Path) -> Result<PathBuf, String> {
        let digest = Sha256::digest(home.to_string_lossy().as_bytes());
        let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
        let dir = self.env.data_dir()?.join("homes").join(key);
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        Ok(dir)
    }

    /// Report what the outbox holds from before this start. The text comes along
    /// because after a relaunch the UI has no other copy of it.
    fn announce_loaded(&self) {
        let Some(outbox) = &self.outbox else { return };
        for pending in &outbox.queue {
            if pending.ever_sent {
                self.record(&pending.id, None, "requeued", json!({"resent_after_restart": true}));
                self.emit(
                    "outbox",
                    json!({"id": pending.id, "state": "requeued", "resent_after_restart": true, "text": pending.text}),
                );
            } else {
                self.emit("outbox", json!({"id": pending.id, "state": "queued", "text": pending.text}));
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
        let resent: Vec<(String, String)> = outbox
            .queue
            .iter()
            .filter(|p| p.ever_sent)
            .map(|p| (p.id.clone(), p.text.clone()))
            .collect();
        for (id, text) in resent {
            self.record(&id, None, "requeued", json!({"resent_after_restart": true}));
            self.emit(
                "outbox",
                json!({"id": id, "state": "requeued", "resent_after_restart": true, "text": text}),
            );
        }
    }

    async fn stop_adapter(&mut self) {
        // Open approvals belong to the adapter being stopped; they cannot be answered after it.
        self.asked.clear();
        self.end_storm();
        self.helm = false;
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
                self.end_storm();
                self.helm = false;
                // The adapter is gone, but the Claude CLI and hook processes it
                // started may not be: kill the group off the loop.
                if let Some(mut adapter) = self.adapter.take() {
                    let env = self.env.clone();
                    tauri::async_runtime::spawn(async move {
                        let report = adapter.kill_tree().await;
                        report_kill(env.as_ref(), report, "exit");
                    });
                }
                self.set_state(
                    State::Dead,
                    json!({"reason": "the first mate process exited", "reason_kind": "exited"}),
                );
            }
            HostEvent::PromptDone { gen, outbox_id, result } if gen == self.gen => {
                self.on_prompt_done(outbox_id, result)
            }
            HostEvent::SessionStartDone { gen, result } if gen == self.gen => self.on_session_start_done(result),
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
        // The usage update the adapter sends with a turn's result names whose turn it was.
        let result_origin = (kind == "usage_update")
            .then(|| update.pointer("/_meta/_claude~1origin/kind").and_then(Value::as_str))
            .flatten()
            .map(str::to_string);
        if result_origin.is_some() {
            self.marks_results = true;
        }
        self.track_step(&kind, &update);
        // Usage that trails a turn's end, reports a rate limit, or is a turn's own result
        // is not a turn starting.
        let trailer = kind == "usage_update"
            && (self.last_turn_end.is_some_and(|t| t.elapsed() < TRAILER_WINDOW)
                || result_origin.is_some()
                || update.pointer("/_meta/_claude~1rateLimit").is_some());
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
        // The model's own cycle ended: its result is the authoritative end of the agent turn.
        if result_origin.as_deref().is_some_and(|origin| AUTONOMOUS_ORIGINS.contains(&origin)) {
            self.last_turn_end = Some(Instant::now());
            self.end_agent_turn(json!({"derived": "agent turn result", "result_origin": result_origin}));
        }
    }

    /// Steps the model has started and not finished. A turn with one still running is
    /// not over however quiet it is: a long command reports nothing until it ends.
    fn track_step(&mut self, kind: &str, update: &Value) {
        let (Some(id), status) = (
            update.get("toolCallId").and_then(Value::as_str),
            update.get("status").and_then(Value::as_str),
        ) else {
            return;
        };
        let done = matches!(status, Some("completed" | "failed"));
        match kind {
            "tool_call" if !done => {
                self.open_steps.insert(id.to_string());
            }
            "tool_call" | "tool_call_update" if done => {
                self.open_steps.remove(id);
            }
            _ => {}
        }
    }

    /// An agent turn is over: back to idle, where waiting captain messages go out.
    fn end_agent_turn(&mut self, detail: Value) {
        if self.state == State::AgentTurn && self.in_flight.is_empty() && !self.helm {
            self.open_steps.clear();
            self.set_state(State::Idle, detail);
        }
    }

    fn note_agent_turn(&mut self) {
        self.agent_turn_starts.push_back(Instant::now());
        self.review_storm();
    }

    /// A storm is `STORM_TURNS` agent turns inside the last `STORM_WINDOW`, counted
    /// now, not when the last turn started: a first mate that settles stops being in
    /// one as its turns age out of the window, whether or not another turn comes.
    /// Every change in the count is reported while it lasts, so the number on screen
    /// is always the number of turns in the window.
    fn review_storm(&mut self) {
        let now = Instant::now();
        while self
            .agent_turn_starts
            .front()
            .is_some_and(|t| now.duration_since(*t) > STORM_WINDOW)
        {
            self.agent_turn_starts.pop_front();
        }
        let turns = self.agent_turn_starts.len();
        if turns >= STORM_TURNS {
            if self.storm_reported != Some(turns) {
                self.storm_reported = Some(turns);
                self.emit(
                    "host_health",
                    json!({"kind": "rewake_storm", "turns": turns, "window_secs": STORM_WINDOW.as_secs()}),
                );
            }
        } else if self.storm_reported.take().is_some() {
            self.emit("host_health", json!({"kind": "rewake_storm_cleared", "turns": turns}));
        }
    }

    /// A first mate that is not running is not being woken: forget its turns.
    fn end_storm(&mut self) {
        self.agent_turn_starts.clear();
        self.review_storm();
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
        match error.as_deref() {
            None => {
                self.record(&outbox_id, None, "picked_up", json!({}));
                self.emit("outbox", json!({"id": outbox_id, "state": "picked_up"}));
            }
            // The adapter went away mid-turn: the message stays unread and is re-sent
            // after the next start, marked requeued.
            Some(error) if cut_off_by_exit(error) => {}
            // The turn itself ended in an error. Recording that is final, so a restart
            // never sends the message a second time; the captain decides to send again.
            Some(error) => {
                self.record(&outbox_id, None, "failed", json!({"error": error}));
                self.emit("outbox", json!({"id": outbox_id, "state": "failed", "error": error}));
                if let Some(message) = session_limit_message(error) {
                    // The adapter also streams this as chat text; the health event is what
                    // tells the UI the account is out of turns rather than the mate talking.
                    self.emit(
                        "host_health",
                        json!({"kind": "session_limit", "id": outbox_id, "warning": message}),
                    );
                }
            }
        }
        self.emit(
            "prompt_result",
            json!({"id": outbox_id, "stop_reason": stop, "usage": usage, "error": error}),
        );
        self.last_turn_end = Some(Instant::now());
        if self.state.live() {
            let next = if self.in_flight.is_empty() { State::Idle } else { State::PromptTurn };
            if next == State::Idle {
                self.open_steps.clear();
            }
            if next != self.state {
                self.set_state(next, json!({}));
            }
        }
    }

    fn tick(&mut self) {
        self.review_storm();
        // Quiet only ends an agent turn; with a prompt in flight its result decides.
        if self.state != State::AgentTurn || !self.in_flight.is_empty() || self.helm {
            return;
        }
        let quiet = self.last_activity.elapsed();
        if !self.marks_results {
            if quiet > AGENT_TURN_QUIET {
                self.end_agent_turn(json!({"derived": "agent turn quiet for 4s"}));
            }
            return;
        }
        // The result should have ended it. A turn this quiet with no step running, or with a
        // step running far longer than any should, lost its result: do not hold messages forever.
        let limit = if self.open_steps.is_empty() { AGENT_TURN_QUIET_MARKED } else { AGENT_TURN_STEP_LIMIT };
        if quiet > limit {
            self.end_agent_turn(json!({"derived": format!("agent turn quiet for {}s without a result", limit.as_secs())}));
        }
    }

    /// Hand every queued message to the adapter now; it queues behind a running prompt.
    /// During an agent turn they wait: the CLI folds a message that arrives mid-cycle into
    /// the running cycle, and the adapter never settles a prompt with that cycle's result,
    /// so the message would be answered and still read as waiting forever.
    fn dispatch(&mut self) {
        if !self.state.live() || self.state == State::AgentTurn {
            return;
        }
        let Some(adapter) = self.adapter.as_ref() else { return };
        let rpc = adapter.rpc.clone();
        let session_id = adapter.session_id.clone();
        while let Some(pending) = self.outbox.as_mut().and_then(|o| o.queue.pop_front()) {
            self.record(&pending.id, None, "sent", json!({}));
            self.emit("outbox", json!({"id": pending.id, "state": "sent", "while": self.state.name()}));
            self.in_flight.push_back(pending.id.clone());
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

/// The earlier conversation a resumed session replayed, as the chat shows it:
/// consecutive chunks of one message joined, each tool call as a step titled by
/// its latest title, thoughts left out, and firstmate's operational inputs hidden
/// because the captain did not write them.
fn history_items(updates: &[Value]) -> Vec<Value> {
    struct Item {
        who: &'static str,
        text: String,
        tool_id: Option<String>,
        message_id: Option<String>,
    }
    let mut items: Vec<Item> = Vec::new();
    for update in updates {
        let text = |key: &str| update.get(key).and_then(Value::as_str).map(str::to_string);
        let who = match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("user_message_chunk") => "captain",
            Some("agent_message_chunk") => "mate",
            Some("tool_call") => {
                items.push(Item {
                    who: "step",
                    text: text("title").unwrap_or_default(),
                    tool_id: text("toolCallId"),
                    message_id: None,
                });
                continue;
            }
            Some("tool_call_update") => {
                if let (Some(id), Some(title)) = (text("toolCallId"), text("title")) {
                    if let Some(step) = items.iter_mut().rev().find(|i| i.who == "step" && i.tool_id.as_deref() == Some(&id)) {
                        step.text = title;
                    }
                }
                continue;
            }
            _ => continue,
        };
        let chunk = update.pointer("/content/text").and_then(Value::as_str).unwrap_or("");
        let message_id = text("messageId");
        match items.last_mut() {
            // The adapter gives every replayed message an id; chunks join only when they
            // share one, so two separate prompts are never run together.
            Some(last) if last.who == who && message_id.is_some() && last.message_id == message_id => {
                last.text.push_str(chunk)
            }
            _ => items.push(Item { who, text: chunk.to_string(), tool_id: None, message_id }),
        }
    }
    items
        .into_iter()
        .filter(|item| !item.text.trim().is_empty())
        .filter(|item| !(item.who == "captain" && is_operational_input(&item.text)))
        .map(|item| json!({"who": item.who, "text": item.text}))
        .collect()
}

/// firstmate prefixes inputs the captain did not write with U+2063; the plain
/// session-start instruction is the older form it still accepts.
fn is_operational_input(text: &str) -> bool {
    text.starts_with('\u{2063}') || text.trim() == SESSION_START_BODY
}

/// The kind of a failure to start the adapter, read from the host's own messages,
/// so the UI can choose its words and action without matching text.
fn adapter_failure_kind(reason: &str) -> &'static str {
    if reason.contains("was not found on PATH") || reason.starts_with("could not start") {
        "adapter_missing"
    } else if reason.contains("no answer to") {
        "timeout"
    } else {
        "adapter_crashed"
    }
}

/// Whether a prompt error came from the adapter going away rather than from the
/// turn itself. These are the errors `Rpc` produces when the adapter is gone.
fn cut_off_by_exit(error: &str) -> bool {
    error.starts_with("the adapter exited") || error.starts_with("write failed")
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

    fn leftover_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-desktop-test-leftover-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A record as a crashed app would have left it: a group this test started,
    /// and an app pid that has exited.
    fn write_leftover_record(dir: &Path, pgid: u32, started: &str) {
        let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let app = gone.id();
        gone.wait().unwrap();
        let body = json!({"pgid": pgid, "started": started, "app_pid": app, "app_started": "Thu Jan  1 00:00:00 1970"});
        std::fs::write(dir.join("adapter.json"), body.to_string()).unwrap();
    }

    #[tokio::test]
    async fn a_leftover_first_mate_from_a_crashed_app_is_stopped() {
        let (mut child, pgid) = spawn_stubborn_group();
        let dir = leftover_dir("ours");
        write_leftover_record(&dir, pgid, &process_started(pgid).unwrap());
        let report = stop_leftover(&dir, &Groups::default()).await;
        let _ = child.wait();
        let report = report.expect("the leftover group was stopped");
        assert!(!has_survivors(&report), "{report}");
        assert!(group_members(pgid).unwrap().is_empty());
        assert!(!dir.join("adapter.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_group_that_is_not_provably_ours_is_left_alone() {
        let (mut child, pgid) = spawn_stubborn_group();
        let dir = leftover_dir("reused");
        write_leftover_record(&dir, pgid, "Thu Jan  1 00:00:00 1970");
        assert!(stop_leftover(&dir, &Groups::default()).await.is_none(), "a different process with that id");

        let started = process_started(pgid).unwrap();
        let body = json!({"pgid": pgid, "started": started, "app_pid": std::process::id(), "app_started": process_started(std::process::id()).unwrap()});
        std::fs::write(dir.join("adapter.json"), body.to_string()).unwrap();
        assert!(stop_leftover(&dir, &Groups::default()).await.is_none(), "the recording app is still running");

        assert_eq!(group_members(pgid).unwrap().len(), 3, "the group must still be running");
        kill_group_blocking(pgid);
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn a_lock_holder_is_ours_by_its_process_group_with_the_evidence_kept() {
        let (mut child, pgid) = spawn_stubborn_group();
        let member: u32 = group_members(pgid).unwrap()[1].split_whitespace().next().unwrap().parse().unwrap();

        let (ours, evidence) = holder_is_ours(member, pgid);
        assert!(ours, "{evidence}");
        assert_eq!(evidence["holder_pgid"], json!(pgid), "{evidence}");
        assert_eq!(evidence["same_group"], json!(true), "{evidence}");

        // This test's own process is a live harness-shaped holder that is not ours.
        let (theirs, evidence) = holder_is_ours(std::process::id(), pgid);
        assert!(!theirs, "{evidence}");
        assert_eq!(evidence["in_group"], json!(false), "{evidence}");
        assert_eq!(evidence["same_group"], json!(false), "{evidence}");
        assert_eq!(evidence["descends_from_ours"], json!(false), "{evidence}");
        assert!(evidence["holder_command"].as_str().is_some(), "{evidence}");
        assert!(!evidence["holder_ancestry"].as_array().unwrap().is_empty(), "{evidence}");

        kill_group_blocking(pgid);
        let _ = child.wait();
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
import threading, time
out = threading.Lock()
def send(message):
    with out:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()
def update(u):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1", "update": u}})
def answer(id, origin="human"):
    # As the real adapter does: the result's usage names whose turn it was, then the response.
    update({"sessionUpdate": "usage_update", "used": 1, "size": 100, "_meta": {"_claude/origin": {"kind": origin}}})
    send({"jsonrpc": "2.0", "id": id, "result": {"stopReason": "end_turn"}})
# A Stop-hook rewake: the model's own cycle, with a step that reports nothing for a while.
# A prompt that arrives during it is folded into the cycle, as the CLI does, and never answered.
cycle = threading.Event()
def rewake():
    time.sleep(0.3)
    cycle.set()
    update({"sessionUpdate": "usage_update", "used": 1, "size": 100})
    update({"sessionUpdate": "tool_call", "toolCallId": "w1", "title": "Drain the wake queue", "status": "pending"})
    time.sleep(5)
    update({"sessionUpdate": "tool_call_update", "toolCallId": "w1", "status": "completed"})
    update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "handled the wake"}})
    cycle.clear()
    update({"sessionUpdate": "usage_update", "used": 1, "size": 100, "_meta": {"_claude/origin": {"kind": "task-notification"}}})
prompt = None
while True:
    line = sys.stdin.readline()
    if not line:
        break
    m = json.loads(line)
    method = m.get("method")
    if method == "initialize":
        can_load = os.path.exists(os.path.join(home, "can-load"))
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"agentCapabilities": {"loadSession": can_load}}})
    elif method == "session/load":
        def replay(update):
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1", "update": update}})
        replay({"sessionUpdate": "user_message_chunk", "messageId": "u1", "content": {"type": "text", "text": "earlier "}})
        replay({"sessionUpdate": "user_message_chunk", "messageId": "u1", "content": {"type": "text", "text": "question"}})
        replay({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}})
        replay({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "earlier answer"}})
        replay({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read File", "kind": "read", "status": "pending"})
        replay({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Read AGENTS.md"})
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": "s1", "modes": {"availableModes": [{"id": "auto"}, {"id": "bypassPermissions"}]}}})
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
    elif method == "session/prompt":
        text = "".join(part.get("text", "") for part in m["params"]["prompt"])
        open(os.path.join(home, "prompts.log"), "a").write(text + "\n")
        if "fail-me" in text:
            send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32603, "message": "Internal error: boom"}})
            continue
        if cycle.is_set():
            update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "folded " + text}})
            continue
        if "fm-session-start.sh" in text:
            claim()
            answer(m["id"])
            continue
        if "wake-me-after" in text:
            answer(m["id"])
            threading.Thread(target=rewake).start()
            continue
        if "plain" in text:
            update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "answered " + text}})
            answer(m["id"])
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

    /// A host with no adapter, recording what it emits.
    fn bare_host(name: &str) -> (Host, Arc<EventLog>) {
        let log = Arc::new(EventLog::default());
        let dir = std::env::temp_dir().join(format!("fm-desktop-test-{name}-{}", std::process::id()));
        let (ev_tx, _ev_rx) = mpsc::unbounded_channel();
        (Host::new(Arc::new(RecordingEnv { dir, log: log.clone() }), ev_tx, Groups::default()), log)
    }

    fn storm_reports(log: &EventLog) -> Vec<Value> {
        log.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, body)| event == "host_health" && body["kind"].as_str().is_some_and(|k| k.starts_with("rewake_storm")))
            .map(|(_, body)| json!({"kind": body["kind"], "turns": body["turns"]}))
            .collect()
    }

    #[test]
    fn a_rewake_storm_reports_its_count_and_clears_once_the_turns_age_out() {
        let (mut host, log) = bare_host("storm");
        let ago = |secs| Instant::now() - Duration::from_secs(secs);
        host.agent_turn_starts = (0..STORM_TURNS as u64 - 1).map(|n| ago(100 - n)).collect();
        host.note_agent_turn();
        host.note_agent_turn();
        // Nothing new happened: the count on screen is still the count in the window.
        host.tick();
        assert_eq!(
            storm_reports(&log),
            vec![json!({"kind": "rewake_storm", "turns": 6}), json!({"kind": "rewake_storm", "turns": 7})]
        );
        assert_eq!(host.storm_reported, Some(7));

        // The first mate settles: no more turns, and time passes until most of them left the window.
        for start in host.agent_turn_starts.iter_mut().take(STORM_TURNS) {
            *start = ago(STORM_WINDOW.as_secs() + 1);
        }
        host.tick();
        assert_eq!(storm_reports(&log).last(), Some(&json!({"kind": "rewake_storm_cleared", "turns": 1})));
        assert_eq!(host.storm_reported, None);
        host.tick();
        assert_eq!(storm_reports(&log).len(), 3, "cleared once");
    }

    #[test]
    fn stopping_the_first_mate_ends_its_rewake_storm() {
        let (mut host, log) = bare_host("storm-stop");
        for _ in 0..STORM_TURNS {
            host.note_agent_turn();
        }
        host.end_storm();
        assert_eq!(
            storm_reports(&log),
            vec![json!({"kind": "rewake_storm", "turns": 6}), json!({"kind": "rewake_storm_cleared", "turns": 0})]
        );
    }

    #[test]
    fn history_joins_messages_keeps_steps_and_hides_what_the_captain_did_not_write() {
        let chunk = |kind: &str, text: &str, message: Option<&str>| {
            let mut update = json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}});
            if let Some(message) = message {
                update["messageId"] = json!(message);
            }
            update
        };
        let updates = vec![
            chunk("user_message_chunk", "\u{2063}FIRSTMATE_OP: v1 session-start: Run it", None),
            chunk("agent_message_chunk", "Captain, ", Some("a1")),
            chunk("agent_message_chunk", "on deck.", Some("a1")),
            chunk("agent_thought_chunk", "private thinking", None),
            chunk("agent_message_chunk", "Second message.", Some("a2")),
            json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read File"}),
            json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Read AGENTS.md"}),
            json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"}),
            chunk("user_message_chunk", SESSION_START_BODY, None),
            chunk("user_message_chunk", "Ship the fix.", None),
        ];
        assert_eq!(
            history_items(&updates),
            vec![
                json!({"who": "mate", "text": "Captain, on deck."}),
                json!({"who": "mate", "text": "Second message."}),
                json!({"who": "step", "text": "Read AGENTS.md"}),
                json!({"who": "captain", "text": "Ship the fix."}),
            ]
        );
    }

    #[tokio::test]
    async fn a_resumed_session_sends_its_earlier_conversation() {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = home_with_lock_script(
            "resume-history",
            Some(r#"if [ -f "$FM_HOME/adapter.pid" ]; then echo "lock: held by live harness pid $(cat "$FM_HOME/adapter.pid")"; else echo 'lock: free'; fi"#),
        );
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        std::fs::write(home.join("can-load"), "").unwrap();
        let adapter = home.join("fake-adapter.py");
        std::fs::write(&adapter, FAKE_ADAPTER).unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ACP_ADAPTER", &adapter);

        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("first start");
        host.call(|reply| Cmd::Stop { reply }).await.unwrap().expect("stop");
        let _ = std::fs::remove_file(home.join("adapter.pid"));
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("second start");
        let history = wait_for(&log, Duration::from_secs(2), |e, _| e == "history").await;
        let _ = host.call(|reply| Cmd::Stop { reply }).await;
        let events = log.0.lock().unwrap().clone();
        let _ = std::fs::remove_dir_all(&home);

        let sessions: Vec<&Value> = events.iter().filter(|(e, _)| e == "session").map(|(_, b)| b).collect();
        assert_eq!(sessions.len(), 2, "{events:?}");
        assert_eq!(sessions[0]["mode"], "new");
        assert_eq!(sessions[1]["mode"], "loaded");
        assert_eq!(sessions[1]["previous_session_lost"], false);
        let history = history.expect("the earlier conversation was sent");
        assert_eq!(
            history["items"],
            json!([
                {"who": "captain", "text": "earlier question"},
                {"who": "mate", "text": "earlier answer"},
                {"who": "step", "text": "Read AGENTS.md"},
            ])
        );
        assert!(!events.iter().any(|(e, b)| e == "text" && b["text"] == "earlier answer"), "replay leaked into live chat");
    }

    /// A throwaway home run by the fake adapter, whose lock is held while the adapter runs.
    fn fake_adapter_home(name: &str) -> PathBuf {
        let home = home_with_lock_script(
            name,
            Some(r#"if [ -f "$FM_HOME/adapter.pid" ]; then echo "lock: held by live harness pid $(cat "$FM_HOME/adapter.pid")"; else echo 'lock: free'; fi"#),
        );
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        let adapter = home.join("fake-adapter.py");
        std::fs::write(&adapter, FAKE_ADAPTER).unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ACP_ADAPTER", &adapter);
        home
    }

    /// Reproduces a live run: a message sent while a Stop-hook rewake ran was folded into
    /// that cycle, answered there, and read as waiting forever, because the adapter never
    /// settles a prompt with the result of a cycle the model started itself.
    #[tokio::test]
    async fn a_message_sent_during_an_agent_turn_waits_for_it_and_is_read() {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = fake_adapter_home("hold-during-agent-turn");
        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("start");
        let first = host.call(|reply| Cmd::Send { text: "wake-me-after".into(), reply }).await.unwrap().expect("send");
        wait_for(&log, Duration::from_secs(10), |e, b| e == "outbox" && b["id"] == first.as_str() && b["state"] == "picked_up")
            .await
            .expect("the first message was read");
        wait_for(&log, Duration::from_secs(10), |e, b| e == "state" && b["state"] == "agent_turn" && b["origin"] == "agent")
            .await
            .expect("the rewake started an agent turn");
        let during = host.call(|reply| Cmd::Send { text: "plain during".into(), reply }).await.unwrap().expect("send");
        let read = wait_for(&log, Duration::from_secs(20), |e, b| e == "outbox" && b["id"] == during.as_str() && b["state"] == "picked_up").await;
        let _ = host.call(|reply| Cmd::Stop { reply }).await;
        let events = log.0.lock().unwrap().clone();
        let prompts = std::fs::read_to_string(home.join("prompts.log")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&home);

        assert!(read.is_some(), "the message was never read: {events:?}");
        let position = |pred: &dyn Fn(&str, &Value) -> bool| events.iter().position(|(e, b)| pred(e, b)).unwrap();
        let queued = position(&|e, b| e == "outbox" && b["id"] == during.as_str() && b["state"] == "queued");
        let turn_over = position(&|e, b| e == "state" && b["state"] == "idle" && b["derived"] == "agent turn result");
        let sent = position(&|e, b| e == "outbox" && b["id"] == during.as_str() && b["state"] == "sent");
        assert_eq!(events[queued].1["while"], "agent_turn", "{events:?}");
        assert!(queued < turn_over && turn_over < sent, "handed over before the agent turn ended: {events:?}");
        assert!(!prompts.contains("folded"), "{prompts:?}");
        let text: String = events.iter().filter(|(e, _)| e == "text").filter_map(|(_, b)| b["text"].as_str()).collect();
        assert!(text.contains("answered plain during") && !text.contains("folded"), "{text:?}");
        // The five silent seconds of the rewake's step did not end its turn early.
        assert!(!events.iter().any(|(e, b)| e == "state" && b["derived"].as_str().is_some_and(|d| d.contains("quiet"))), "{events:?}");
    }

    #[test]
    fn start_failures_are_classified_without_the_ui_matching_text() {
        assert_eq!(
            adapter_failure_kind("claude-agent-acp was not found on PATH or where these tools are installed. Install it with `npm i -g @agentclientprotocol/claude-agent-acp`, or start the app with its folder on PATH."),
            "adapter_missing"
        );
        assert_eq!(adapter_failure_kind("could not start /x/claude-agent-acp: No such file or directory"), "adapter_missing");
        assert_eq!(adapter_failure_kind("initialize failed: no answer to initialize within 60s"), "timeout");
        assert_eq!(adapter_failure_kind("initialize failed: the adapter exited before responding"), "adapter_crashed");
    }

    #[tokio::test]
    async fn a_missing_adapter_is_reported_as_missing() {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = home_with_lock_script("missing-adapter", Some("echo 'lock: free'"));
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        std::env::set_var("ACP_ADAPTER", home.join("no-such-adapter"));
        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        let started = host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap();
        let dead = wait_for(&log, Duration::from_secs(2), |e, b| e == "state" && b["state"] == "dead").await;
        let _ = std::fs::remove_dir_all(&home);
        assert!(started.is_err());
        let dead = dead.expect("the start failure was reported");
        assert_eq!(dead["reason_kind"], "adapter_missing", "{dead}");
        assert!(dead["reason"].as_str().is_some_and(|r| r.contains("no-such-adapter")), "{dead}");
    }

    /// A turn that ends in an error is recorded failed and is never sent again,
    /// not on restart and not on a later start.
    #[tokio::test]
    async fn a_failed_turn_is_not_sent_twice() {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = home_with_lock_script(
            "failed-turn",
            Some(r#"if [ -f "$FM_HOME/adapter.pid" ]; then echo "lock: held by live harness pid $(cat "$FM_HOME/adapter.pid")"; else echo 'lock: free'; fi"#),
        );
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        let adapter = home.join("fake-adapter.py");
        std::fs::write(&adapter, FAKE_ADAPTER).unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ACP_ADAPTER", &adapter);

        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("start");
        let id = host.call(|reply| Cmd::Send { text: "fail-me".into(), reply }).await.unwrap().expect("send");
        let failed = wait_for(&log, Duration::from_secs(10), |e, b| e == "outbox" && b["id"] == id.as_str() && b["state"] == "failed").await;
        let _ = std::fs::remove_file(home.join("adapter.pid"));
        host.call(|reply| Cmd::Restart { reply }).await.unwrap().expect("restart");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = host.call(|reply| Cmd::Stop { reply }).await;
        let prompts = std::fs::read_to_string(home.join("prompts.log")).unwrap_or_default();
        let events = log.0.lock().unwrap().clone();
        let _ = std::fs::remove_dir_all(&home);

        let failed = failed.expect("the failed turn was reported");
        assert!(failed["error"].as_str().is_some_and(|e| e.contains("boom")), "{failed}");
        assert_eq!(prompts.matches("fail-me").count(), 1, "sent more than once: {prompts:?}");
        assert!(!events.iter().any(|(e, b)| e == "outbox" && b["id"] == id.as_str() && b["state"] == "requeued"));
    }

    /// A resumed session whose hook only nudged holds no lock until a turn runs. Nothing
    /// else holds it, so the app starts, says so, and gives the first mate the turn its
    /// hook asked for: firstmate's session-start instruction, once per start.
    #[tokio::test]
    async fn a_resumed_first_mate_that_has_not_claimed_the_lock_starts_and_takes_the_helm() {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = home_with_lock_script(
            "resume-unclaimed",
            Some(r#"if [ -f "$FM_HOME/adapter.pid" ]; then echo "lock: held by live harness pid $(cat "$FM_HOME/adapter.pid")"; else echo 'lock: free'; fi"#),
        );
        std::fs::write(home.join("AGENTS.md"), "scratch home for a host test\n").unwrap();
        std::fs::write(home.join("can-load"), "").unwrap();
        std::fs::write(home.join("claim-on-prompt"), "").unwrap();
        let adapter = home.join("fake-adapter.py");
        std::fs::write(&adapter, FAKE_ADAPTER).unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ACP_ADAPTER", &adapter);

        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("first start");
        host.call(|reply| Cmd::Stop { reply }).await.unwrap().expect("stop");
        // The lock now names a process that is gone, exactly as it does after a crash.
        let _ = std::fs::remove_file(home.join("adapter.pid"));
        let from = log.0.lock().unwrap().len();
        let resumed = host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap();
        let idle = wait_for(&log, Duration::from_secs(2), |e, b| e == "state" && b["state"] == "idle").await;
        let _ = host.call(|reply| Cmd::Stop { reply }).await;
        let prompts = std::fs::read_to_string(home.join("prompts.log")).unwrap_or_default();
        let events = log.0.lock().unwrap().clone();
        let _ = std::fs::remove_dir_all(&home);

        assert!(resumed.is_ok(), "{resumed:?}");
        assert!(idle.is_some(), "the resumed first mate never became ready");
        let after = &events[from..];
        assert_eq!(after.iter().filter(|(e, b)| e == "session" && b["mode"] == "loaded").count(), 1, "{after:?}");
        assert!(
            after.iter().any(|(e, b)| e == "host_health" && b["kind"] == "lock_unclaimed"),
            "the unclaimed lock was not reported: {after:?}"
        );
        assert!(
            !after.iter().any(|(e, b)| e == "state" && b["state"] == "refused"),
            "a resumed first mate was stopped over an unclaimed lock: {after:?}"
        );
        assert_eq!(
            prompts.matches("fm-session-start.sh").count(),
            2,
            "each start sends the session-start turn once: {prompts:?}"
        );
        assert!(
            after.iter().any(|(e, b)| e == "state" && b["state"] == "agent_turn" && b["origin"] == "session_start"),
            "{after:?}"
        );
    }

    /// Reproduces a live run: after a relaunch the first mate sat idle with wakes waiting,
    /// because nothing ran a turn, and firstmate arms the watcher that delivers them when
    /// a turn ends. Every start now opens with a turn: firstmate's session start, or the
    /// captain's own message when one is waiting to go.
    #[tokio::test]
    async fn every_start_opens_with_a_turn_and_a_waiting_message_can_be_it() {
        let _adapter_env = ADAPTER_ENV.lock().await;
        let home = fake_adapter_home("helm");
        let log = Arc::new(EventLog::default());
        let host = HostHandle::spawn_with(Arc::new(RecordingEnv { dir: home.join("appdata"), log: log.clone() }));
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("start");
        // Sent while the session-start turn runs: it waits for that turn, then goes.
        let early = host.call(|reply| Cmd::Send { text: "plain early".into(), reply }).await.unwrap().expect("send");
        let read = wait_for(&log, Duration::from_secs(10), |e, b| e == "outbox" && b["id"] == early.as_str() && b["state"] == "picked_up").await;
        host.call(|reply| Cmd::Stop { reply }).await.unwrap().expect("stop");
        let _ = std::fs::remove_file(home.join("adapter.pid"));
        let _waiting = host.call(|reply| Cmd::Send { text: "plain waiting".into(), reply }).await.unwrap().expect("send");
        host.call(|reply| Cmd::Start { home: home.clone(), reply }).await.unwrap().expect("second start");
        let idle = wait_for(&log, Duration::from_secs(10), |e, b| e == "outbox" && b["state"] == "picked_up" && b["id"] != early.as_str()).await;
        let _ = host.call(|reply| Cmd::Stop { reply }).await;
        let events = log.0.lock().unwrap().clone();
        let prompts: Vec<String> = std::fs::read_to_string(home.join("prompts.log")).unwrap_or_default().lines().map(str::to_string).collect();
        let _ = std::fs::remove_dir_all(&home);

        assert!(read.is_some() && idle.is_some(), "{events:?}");
        assert_eq!(prompts.len(), 3, "{prompts:?}");
        assert!(prompts[0].contains("fm-session-start.sh"), "the first start opens with the session start: {prompts:?}");
        assert_eq!(prompts[1], "plain early", "a message sent meanwhile waits for it: {prompts:?}");
        assert_eq!(prompts[2], "plain waiting", "a waiting message is the second start's first turn: {prompts:?}");
        let done = events.iter().find(|(e, b)| e == "host_health" && b["kind"] == "session_start_turn").map(|(_, b)| b).unwrap();
        assert_eq!(done["stop_reason"], "end_turn", "{done}");
    }

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
        let idle = wait_for(&log, Duration::from_secs(5), |e, b| e == "state" && b["state"] == "idle").await;
        let prompts = std::fs::read_to_string(home.join("prompts.log")).unwrap_or_default();
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
