//! Read-only view of the firstmate home.
//!
//! Runs firstmate's own read-only snapshot scripts when the home is selected
//! and whenever files under `state/` or `data/` change (debounced, never on a
//! timer), and emits one `snapshot` event with both projections and the
//! project registry. Also serves the worker's read-only screen through
//! `bin/fm-peek.sh`.
//!
//! The last finished snapshot is kept, so a window that subscribes after it
//! was emitted can still show it.
//!
//! Also lists a project's closed work through `bin/fm-history.sh`, on request
//! rather than with every snapshot, since it reads the backlog's archive too.
//!
//! Commands: `snapshot_refresh`, `snapshot_latest`, `pane_capture`, `project_history`.
//! Event: `snapshot`.

use crate::envpath;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State as TauriState};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

/// Quiet period after the last file change before re-running the snapshots.
const DEBOUNCE: Duration = Duration::from_millis(750);
/// Minimum gap between two snapshot runs, so a busy watcher cannot spin them.
const MIN_GAP: Duration = Duration::from_secs(2);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(90);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);
const HISTORY_TIMEOUT: Duration = Duration::from_secs(30);
/** `bin/fm-history.sh` refuses a page larger than this. */
const HISTORY_MAX_LIMIT: u32 = 500;
const CAPTURE_LINES: &str = "60";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

enum SnapCmd {
    SetHome { home: PathBuf, reply: oneshot::Sender<Result<(), String>> },
    Refresh,
    Latest { reply: oneshot::Sender<Value> },
    Capture { task_id: String, reply: oneshot::Sender<Result<Value, String>> },
    History { request: HistoryRequest, reply: oneshot::Sender<Result<Value, String>> },
}

struct HistoryRequest {
    repo: String,
    after: Option<String>,
    limit: Option<u32>,
}

/// Tauri-managed handle to the snapshot task.
pub struct SnapshotHandle {
    tx: mpsc::UnboundedSender<SnapCmd>,
}

impl SnapshotHandle {
    pub fn spawn(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        tauri::async_runtime::spawn(run(app, rx));
        SnapshotHandle { tx }
    }

    pub async fn set_home(&self, home: PathBuf) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(SnapCmd::SetHome { home, reply })
            .map_err(|_| "the snapshot reader is not running".to_string())?;
        rx.await
            .map_err(|_| "the snapshot reader stopped before answering".to_string())?
    }

    /// Points the reader at `home` without waiting for its answer: it may be
    /// busy reading the previous home for a while. `home` must already be
    /// resolved, since a folder that can't be opened is reported nowhere.
    pub fn point_at(&self, home: PathBuf) -> Result<(), String> {
        let (reply, _) = oneshot::channel();
        self.tx
            .send(SnapCmd::SetHome { home, reply })
            .map_err(|_| "the snapshot reader is not running".to_string())
    }
}

#[tauri::command]
pub async fn snapshot_refresh(snapshots: TauriState<'_, SnapshotHandle>) -> Result<(), String> {
    snapshots
        .tx
        .send(SnapCmd::Refresh)
        .map_err(|_| "the snapshot reader is not running".to_string())
}

/// `{home, snapshot}`: `snapshot` is the last finished `snapshot` event for
/// the current home, or `null` before the first one. A run in progress is
/// awaited, since the reader handles one command at a time.
#[tauri::command]
pub async fn snapshot_latest(snapshots: TauriState<'_, SnapshotHandle>) -> Result<Value, String> {
    let (reply, rx) = oneshot::channel();
    snapshots
        .tx
        .send(SnapCmd::Latest { reply })
        .map_err(|_| "the snapshot reader is not running".to_string())?;
    rx.await
        .map_err(|_| "the snapshot reader stopped before answering".to_string())
}

#[tauri::command]
pub async fn pane_capture(
    task_id: String,
    snapshots: TauriState<'_, SnapshotHandle>,
) -> Result<Value, String> {
    let (reply, rx) = oneshot::channel();
    snapshots
        .tx
        .send(SnapCmd::Capture { task_id, reply })
        .map_err(|_| "the snapshot reader is not running".to_string())?;
    rx.await
        .map_err(|_| "the snapshot reader stopped before answering".to_string())?
}

/// A page of `repo`'s closed work, as `bin/fm-history.sh --json` prints it, or
/// `null` from a firstmate that has no such script.
#[tauri::command]
pub async fn project_history(
    repo: String,
    after: Option<String>,
    limit: Option<u32>,
    snapshots: TauriState<'_, SnapshotHandle>,
) -> Result<Value, String> {
    let (reply, rx) = oneshot::channel();
    snapshots
        .tx
        .send(SnapCmd::History { request: HistoryRequest { repo, after, limit }, reply })
        .map_err(|_| "the snapshot reader is not running".to_string())?;
    rx.await
        .map_err(|_| "the snapshot reader stopped before answering".to_string())?
}

async fn run(app: AppHandle, mut cmd_rx: mpsc::UnboundedReceiver<SnapCmd>) {
    let (fs_tx, mut fs_rx) = mpsc::unbounded_channel::<PathBuf>();
    let mut home: Option<PathBuf> = None;
    let mut watcher: Option<RecommendedWatcher> = None;
    let mut deadline: Option<Instant> = None;
    let mut last_run: Option<Instant> = None;
    let mut latest: Option<Value> = None;

    loop {
        let wake_at = deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            cmd = cmd_rx.recv() => match cmd {
                None => break,
                Some(SnapCmd::SetHome { home: requested, reply }) => {
                    match std::fs::canonicalize(&requested) {
                        Ok(resolved) => {
                            if home.as_ref() != Some(&resolved) {
                                latest = None;
                            }
                            watcher = watch_home(&resolved, fs_tx.clone());
                            home = Some(resolved);
                            deadline = Some(Instant::now());
                            let _ = reply.send(Ok(()));
                        }
                        Err(err) => {
                            let _ = reply.send(Err(format!("{} is not a readable folder: {err}", requested.display())));
                        }
                    }
                }
                Some(SnapCmd::Refresh) => deadline = Some(Instant::now()),
                Some(SnapCmd::Latest { reply }) => {
                    let _ = reply.send(json!({
                        "home": home.as_ref().map(|root| root.to_string_lossy()),
                        "snapshot": latest,
                    }));
                }
                Some(SnapCmd::Capture { task_id, reply }) => {
                    let home = home.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = reply.send(capture(home, task_id).await);
                    });
                }
                Some(SnapCmd::History { request, reply }) => {
                    let home = home.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = reply.send(history(home, request).await);
                    });
                }
            },
            Some(path) = fs_rx.recv() => {
                if let (Some(root), Some(active)) = (home.as_ref(), watcher.as_mut()) {
                    // state/ or data/ created after the home was selected: start watching it.
                    for dir in ["state", "data"] {
                        if path == root.join(dir) && path.is_dir() {
                            let _ = active.watch(&path, RecursiveMode::Recursive);
                        }
                    }
                    if relevant(root, &path) {
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                }
            },
            _ = tokio::time::sleep_until(wake_at), if deadline.is_some() => {
                if let Some(previous) = last_run {
                    if previous.elapsed() < MIN_GAP {
                        deadline = Some(previous + MIN_GAP);
                        continue;
                    }
                }
                deadline = None;
                last_run = Some(Instant::now());
                if let Some(root) = home.clone() {
                    // Announce the run first, so the UI can grey the last known state
                    // for watcher-triggered refreshes as well as explicit ones.
                    let _ = app.emit(
                        "snapshot",
                        json!({"phase": "refreshing", "home": root.to_string_lossy(), "started_at_ms": now_ms()}),
                    );
                    let payload = build_snapshot(&root).await;
                    latest = Some(merge_latest(latest.take(), payload.clone()));
                    let _ = app.emit("snapshot", payload);
                }
            }
        }
    }
}

/// The cached snapshot keeps the last good projection when a read fails, with
/// the time each projection was read (`bearings_at_ms`, `fleet_at_ms`), so a
/// window that opens later still has the data and knows how old it is.
fn merge_latest(previous: Option<Value>, mut next: Value) -> Value {
    let at = next.get("generated_at_ms").cloned().unwrap_or(Value::Null);
    for part in ["bearings", "fleet"] {
        let stamp = format!("{part}_at_ms");
        if next.get(part).is_some_and(|value| !value.is_null()) {
            next[stamp.as_str()] = at.clone();
        } else if let Some(old) = previous.as_ref().filter(|old| old.get(part).is_some_and(|value| !value.is_null())) {
            next[part] = old[part].clone();
            next[stamp.as_str()] = old[stamp.as_str()].clone();
        }
    }
    next
}

fn watch_home(home: &Path, fs_tx: mpsc::UnboundedSender<PathBuf>) -> Option<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        if let Ok(event) = result {
            for path in event.paths {
                let _ = fs_tx.send(path);
            }
        }
    })
    .ok()?;
    let _ = watcher.watch(home, RecursiveMode::NonRecursive);
    for dir in ["state", "data"] {
        let path = home.join(dir);
        if path.is_dir() {
            let _ = watcher.watch(&path, RecursiveMode::Recursive);
        }
    }
    Some(watcher)
}

/// A change matters when it is under state/ or data/ and is not one of the
/// dot-files the watcher and supervision internals rewrite every poll.
fn relevant(home: &Path, path: &Path) -> bool {
    let Ok(rest) = path.strip_prefix(home) else { return false };
    let mut parts = rest.components();
    let top = parts.next().map(|c| c.as_os_str().to_string_lossy().to_string());
    if !matches!(top.as_deref(), Some("state") | Some("data")) {
        return false;
    }
    !path
        .file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
}

async fn build_snapshot(home: &Path) -> Value {
    let (bearings, fleet) = tokio::join!(
        run_json(home, "fm-bearings-snapshot.sh", &["--json"]),
        run_json(home, "fm-fleet-snapshot.sh", &["--json"]),
    );
    let mut errors = Vec::new();
    let bearings = bearings.unwrap_or_else(|e| {
        errors.push(json!({"source": "fm-bearings-snapshot.sh", "error": e}));
        Value::Null
    });
    let fleet = fleet.unwrap_or_else(|e| {
        errors.push(json!({"source": "fm-fleet-snapshot.sh", "error": e}));
        Value::Null
    });
    json!({
        "phase": "ready",
        "home": home.to_string_lossy(),
        "generated_at_ms": now_ms(),
        "bearings": bearings,
        "fleet": fleet,
        "projects": parse_projects(home),
        "errors": errors,
    })
}

async fn run_json(home: &Path, script: &str, args: &[&str]) -> Result<Value, String> {
    let output = run_script(home, script, args, SNAPSHOT_TIMEOUT).await?;
    serde_json::from_str(&output).map_err(|e| format!("{script} printed invalid JSON: {e}"))
}

pub(crate) async fn run_script(home: &Path, script: &str, args: &[&str], limit: Duration) -> Result<String, String> {
    let child = envpath::command(home.join("bin").join(script))
        .args(args)
        .env("FM_HOME", home)
        .current_dir(home)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(limit, child)
        .await
        .map_err(|_| format!("{script} did not finish within {}s", limit.as_secs()))?
        .map_err(|e| format!("could not run {script}: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("{script} exited with {}: {}", output.status, tail.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The project registry, read-only: `- <name> [<mode> +yolo] - <desc> (added <date>)`.
/// Matches `bin/fm-project-mode.sh`: a missing annotation is `no-mistakes`.
fn parse_projects(home: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(home.join("data").join("projects.md")) else {
        return json!([]);
    };
    let mut projects = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("- ") else { continue };
        let (head, description) = match rest.split_once(" - ") {
            Some((head, description)) => (head.trim(), description.trim()),
            None => (rest.trim(), ""),
        };
        let (name, annotation) = match head.find(" [") {
            Some(index) => (head[..index].trim(), head[index + 2..].trim_end_matches(']').trim()),
            None => (head, ""),
        };
        let mut words = annotation.split_whitespace();
        let mode = words.next().unwrap_or("no-mistakes");
        let yolo = annotation.split_whitespace().any(|w| w == "+yolo");
        let (description, added) = match description.rfind(" (added ") {
            Some(index) if description.ends_with(')') => (
                description[..index].trim(),
                Some(description[index + 8..description.len() - 1].trim()),
            ),
            _ => (description, None),
        };
        projects.push(json!({
            "name": name,
            "mode": mode,
            "yolo": yolo,
            "description": description,
            "added": added,
        }));
    }
    Value::Array(projects)
}

fn valid_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.len() <= 128
        && task_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

async fn capture(home: Option<PathBuf>, task_id: String) -> Result<Value, String> {
    let home = home.ok_or("no firstmate home has been selected")?;
    if !valid_task_id(&task_id) {
        return Err(format!("'{task_id}' is not a task id"));
    }
    let text = run_script(&home, "fm-peek.sh", &[&task_id, CAPTURE_LINES], CAPTURE_TIMEOUT).await?;
    Ok(json!({"task_id": task_id, "text": text, "captured_at_ms": now_ms()}))
}

/// The arguments `bin/fm-history.sh` is run with, once the request is known to be safe to pass.
fn history_args(request: &HistoryRequest) -> Result<Vec<String>, String> {
    // A leading dash would read as a flag, whatever position it is passed in.
    let safe = |value: &str| valid_task_id(value) && !value.starts_with('-');
    if !safe(&request.repo) {
        return Err(format!("'{}' is not a project name", request.repo));
    }
    let mut args = vec!["--json".to_string(), "--repo".to_string(), request.repo.clone()];
    if let Some(after) = &request.after {
        if !safe(after) {
            return Err(format!("'{after}' is not a task id"));
        }
        args.extend(["--after".to_string(), after.clone()]);
    }
    if let Some(limit) = request.limit {
        args.extend(["--limit".to_string(), limit.clamp(1, HISTORY_MAX_LIMIT).to_string()]);
    }
    Ok(args)
}

async fn history(home: Option<PathBuf>, request: HistoryRequest) -> Result<Value, String> {
    let home = home.ok_or("no firstmate home has been selected")?;
    let args = history_args(&request)?;
    if !home.join("bin").join("fm-history.sh").is_file() {
        return Ok(Value::Null);
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_script(&home, "fm-history.sh", &args, HISTORY_TIMEOUT).await?;
    serde_json::from_str(&output).map_err(|e| format!("fm-history.sh printed invalid JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_passes_only_safe_arguments() {
        let request = |repo: &str, after: Option<&str>, limit: Option<u32>| HistoryRequest {
            repo: repo.to_string(),
            after: after.map(str::to_string),
            limit,
        };
        assert_eq!(history_args(&request("resonance", None, None)).unwrap(), ["--json", "--repo", "resonance"]);
        assert_eq!(
            history_args(&request("resonance", Some("res-audit"), Some(50))).unwrap(),
            ["--json", "--repo", "resonance", "--after", "res-audit", "--limit", "50"]
        );
        assert_eq!(history_args(&request("resonance", None, Some(9000))).unwrap()[4], "500");
        assert_eq!(history_args(&request("resonance", None, Some(0))).unwrap()[4], "1");
        assert!(history_args(&request("--help", None, None)).is_err());
        assert!(history_args(&request("resonance", Some("-x"), None)).is_err());
        assert!(history_args(&request("a b", None, None)).is_err());
        assert!(history_args(&request("resonance", Some("x;rm"), None)).is_err());
    }

    /// Every file under `dir`, with its size and modification time, to show a read changed nothing.
    fn tree(dir: &Path) -> Vec<(PathBuf, u64, Option<SystemTime>)> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else { return out };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(tree(&path));
            } else if let Ok(meta) = entry.metadata() {
                out.push((path, meta.len(), meta.modified().ok()));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Reads every registered project's history from a real scratch home through the command's own path,
    /// pages through it one row at a time, and checks the home is untouched. Spends no model tokens.
    #[tokio::test]
    #[ignore = "live: runs the scratch home's bin/fm-history.sh"]
    async fn history_e2e_live_scratch_home() {
        let buzz = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".buzz");
        let home = std::env::var("FM_E2E_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| buzz.join(".scratch/fm-artifacts/firstmate"));
        let home = std::fs::canonicalize(&home).expect("the scratch home exists");
        assert!(home.starts_with(buzz.join(".scratch")), "only homes under ~/.buzz/.scratch are scratch homes");
        assert!(home.join("bin/fm-history.sh").is_file(), "this scratch home's firstmate has no fm-history.sh");
        let before = (tree(&home.join("state")), tree(&home.join("data")));

        let projects = parse_projects(&home);
        let names: Vec<String> = projects.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect();
        assert!(!names.is_empty(), "the scratch home registers no projects");
        let mut seen = 0;
        for name in &names {
            let request = |after: Option<String>, limit: Option<u32>| HistoryRequest { repo: name.clone(), after, limit };
            let whole = history(Some(home.clone()), request(None, None)).await.expect("the history reads");
            assert_eq!(whole["schema"], "fm-history.v1");
            let records = whole["records"].as_array().unwrap();
            for record in records {
                assert_eq!(record["repo"].as_str(), Some(name.as_str()), "{name}'s history holds another project's row: {record}");
                assert_eq!(record["state"], "done");
            }
            let dates: Vec<&str> = records.iter().map(|r| r["completion"]["date"].as_str().unwrap_or("")).collect();
            assert!(dates.windows(2).all(|pair| pair[0] >= pair[1] || pair[1].is_empty()), "{name}'s history is not newest first: {dates:?}");
            // One row at a time, the pages join into the whole list.
            let mut paged = Vec::new();
            let mut after = None;
            loop {
                let page = history(Some(home.clone()), request(after.clone(), Some(1))).await.expect("a page reads");
                paged.extend(page["records"].as_array().unwrap().iter().map(|r| r["id"].clone()));
                match page["next"].as_str() {
                    Some(next) => after = Some(next.to_string()),
                    None => break,
                }
            }
            let ids: Vec<Value> = records.iter().map(|r| r["id"].clone()).collect();
            assert_eq!(paged, ids, "{name}: paging one row at a time did not give the whole list");
            println!("{name}: {} closed, {} calls", records.len(), whole["calls"].as_array().unwrap().len());
            seen += records.len();
        }
        assert!(seen > 0, "no project in the scratch home has closed work to read");
        assert_eq!((tree(&home.join("state")), tree(&home.join("data"))), before, "reading history changed the home");

        // A firstmate without the script is not an error: the app shows only recent rows.
        let bare = std::env::temp_dir().join(format!("qd-history-bare-{}", std::process::id()));
        std::fs::create_dir_all(bare.join("bin")).unwrap();
        let missing = history(Some(bare.clone()), HistoryRequest { repo: "demo".into(), after: None, limit: None }).await;
        let _ = std::fs::remove_dir_all(&bare);
        assert_eq!(missing, Ok(Value::Null));
    }

    #[test]
    fn a_failed_read_keeps_the_last_good_projection() {
        let good = merge_latest(None, json!({"generated_at_ms": 100, "bearings": {"b": 1}, "fleet": {"f": 1}, "errors": []}));
        assert_eq!(good["bearings_at_ms"], 100);
        assert_eq!(good["fleet_at_ms"], 100);

        let failed = merge_latest(
            Some(good),
            json!({"generated_at_ms": 200, "bearings": null, "fleet": {"f": 2}, "errors": [{"source": "fm-bearings-snapshot.sh"}]}),
        );
        assert_eq!(failed["bearings"], json!({"b": 1}));
        assert_eq!(failed["bearings_at_ms"], 100);
        assert_eq!(failed["fleet"], json!({"f": 2}));
        assert_eq!(failed["fleet_at_ms"], 200);
        assert_eq!(failed["errors"][0]["source"], "fm-bearings-snapshot.sh");

        let never = merge_latest(None, json!({"generated_at_ms": 300, "bearings": null, "fleet": null}));
        assert!(never["bearings"].is_null());
        assert!(never.get("bearings_at_ms").is_none());
    }
}
