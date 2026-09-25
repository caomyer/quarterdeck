//! Starting work on a queued task from its drawer: the captain hands the task
//! to the first mate in one plain message, and the app remembers that it asked.
//!
//! The app never briefs or spawns anything. The first mate reads the ask, picks
//! the delivery mode by its own written rule (or takes the captain's, which the
//! message states in the captain's words), writes the brief and spawns, exactly
//! as it does when asked in chat. Whether that happened is read back from the
//! snapshot: the backlog row moving to In flight, the worker registered in
//! `tasks[]`, and `endpoint.status`, never from this record.
//!
//! What this keeps is the ask itself, so the drawer finds it again after a
//! relaunch, when a resumed conversation's history has no message ids. One
//! append-only, fsynced log for the whole home, `data/.starts/asks.jsonl`, one
//! JSON object per line:
//!   {at, task, project, title, kind, mode, note, message, header, text, error}
//! `message` is the id the host gave the message, or null with `error` saying
//! why the host did not take it. The latest line for a task is its ask.
//!
//! It is not a task note: `bin/fm-task-note.sh` appends notes to the worker's
//! launch brief, so the ask would reach the worker a second time as if it were
//! another instruction.
//!
//! Commands: `start_work`, `start_asks`.

use crate::artifact::valid_task_id;
use crate::host::{Cmd, HostHandle};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State as TauriState};

/// How the captain says the task should ship. `judge` leaves it to the first
/// mate, by the project's posture; the other two are the captain's instruction.
const MODES: [(&str, &str); 3] = [
    ("judge", "your call, by the project's posture."),
    ("no-mistakes", "full checks (no-mistakes)."),
    ("direct-PR", "straight to a PR (direct-PR)."),
];

/// The captain's note goes whole into the message; this only guards against a runaway paste.
const NOTE_LIMIT: usize = 4000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The log of every ask in a home.
pub fn log_path(home: &Path) -> PathBuf {
    home.join("data").join(".starts").join("asks.jsonl")
}

/// The ask's fixed first line, by which the drawer and the chat know it.
pub fn header(task: &str, project: &str, title: &str) -> String {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("Start work on {task} ({project}): {title}")
}

/// The message the first mate reads. A scout has no delivery mode, so it says
/// nothing about one; a ship says how it ships, in the captain's words.
pub fn compose(task: &str, project: &str, title: &str, kind: &str, mode: &str, note: Option<&str>) -> Result<String, String> {
    let how = MODES.iter().find(|(key, _)| *key == mode).map(|(_, words)| *words).ok_or_else(|| format!("'{mode}' is not a way a task ships"))?;
    if kind != "ship" && mode != "judge" {
        return Err(format!("a {kind} has no delivery mode to choose"));
    }
    let mut lines = vec![header(task, project, title)];
    if kind == "ship" {
        lines.push(format!("How it ships: {how}"));
    }
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        if note.chars().count() > NOTE_LIMIT {
            return Err(format!("the note is longer than {NOTE_LIMIT} characters"));
        }
        lines.push(format!("From me: {note}"));
    }
    Ok(lines.join("\n"))
}

/// Appends one ask, creating the log if this is the first. Fsynced, so an ask
/// the drawer shows is on disk.
pub fn append(log: &Path, ask: &Value) -> Result<(), String> {
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let mut line = serde_json::to_string(ask).map_err(|e| format!("could not encode the ask: {e}"))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("could not open {}: {e}", log.display()))?;
    file.write_all(line.as_bytes()).map_err(|e| format!("could not write {}: {e}", log.display()))?;
    file.sync_all().map_err(|e| format!("could not save {}: {e}", log.display()))
}

/// Each task's latest ask, keyed by task id. A line that cannot be read is skipped.
pub fn latest(log: &Path) -> Value {
    let mut asks = Map::new();
    let Ok(text) = std::fs::read_to_string(log) else { return Value::Object(asks) };
    for ask in text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
        if let Some(task) = ask["task"].as_str() {
            asks.insert(task.to_string(), ask.clone());
        }
    }
    Value::Object(asks)
}

/// What one ask records: what was asked, and what the host did with the message.
#[allow(clippy::too_many_arguments)]
pub fn ask_record(task: &str, project: &str, title: &str, kind: &str, mode: &str, note: Option<&str>, text: &str, sent: &Result<String, String>) -> Value {
    json!({
        "at": now_ms(), "task": task, "project": project, "title": title, "kind": kind, "mode": mode,
        "note": note.map(str::trim).filter(|note| !note.is_empty()),
        "message": sent.as_ref().ok(), "error": sent.as_ref().err(),
        "header": text.lines().next().unwrap_or_default(), "text": text,
    })
}

/// One ask at a time for the whole home, so a double press cannot send two
/// messages that each think they are the task's ask.
#[derive(Default)]
pub struct Asks(tokio::sync::Mutex<()>);

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("the ask could not be read or saved: {e}"))?
}

/// Hands a queued task to the first mate: sends the ask through the ordinary
/// message path and records it. A message the host did not take is recorded
/// too, with why, so the drawer says it was not sent and offers to send it
/// again. Only a failure to record is an error: the message may have gone, and
/// the screen must not invite a second ask without saying so.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_work(
    app: AppHandle,
    host: TauriState<'_, HostHandle>,
    asks: TauriState<'_, Asks>,
    task: String,
    project: String,
    title: String,
    kind: String,
    mode: String,
    note: Option<String>,
) -> Result<Value, String> {
    if !valid_task_id(&task) || task.starts_with('-') {
        return Err(format!("'{task}' is not a task id"));
    }
    let text = compose(&task, &project, &title, &kind, &mode, note.as_deref())?;
    let _one_ask = asks.0.lock().await;
    let log = log_path(&home_for(&app)?);
    let sent = host.call(|reply| Cmd::Send { text: text.clone(), reply }).await?;
    let ask = ask_record(&task, &project, &title, &kind, &mode, note.as_deref(), &text, &sent);
    let saved = ask.clone();
    blocking(move || append(&log, &saved))
        .await
        .map_err(|problem| match &sent {
            Ok(_) => format!("Sent, but the app could not note that it asked: {problem}"),
            Err(_) => problem,
        })?;
    Ok(ask)
}

/// Every task's latest ask in the home.
#[tauri::command]
pub async fn start_asks(app: AppHandle) -> Result<Value, String> {
    let log = log_path(&home_for(&app)?);
    blocking(move || Ok(latest(&log))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ship_ask_says_how_it_ships_in_the_captains_words() {
        let text = compose("qd-chat-1", "quarterdeck-fm", "Day-old pages\n  sink", "ship", "judge", Some("  check #11  ")).unwrap();
        assert_eq!(text, "Start work on qd-chat-1 (quarterdeck-fm): Day-old pages sink\nHow it ships: your call, by the project's posture.\nFrom me: check #11");
        let text = compose("qd-chat-1", "quarterdeck-fm", "T", "ship", "direct-PR", None).unwrap();
        assert_eq!(text.lines().nth(1), Some("How it ships: straight to a PR (direct-PR)."));
        let text = compose("qd-chat-1", "quarterdeck-fm", "T", "ship", "no-mistakes", Some("   ")).unwrap();
        assert_eq!(text, "Start work on qd-chat-1 (quarterdeck-fm): T\nHow it ships: full checks (no-mistakes).");
    }

    #[test]
    fn a_scout_ask_has_no_mode_and_refuses_one() {
        assert_eq!(compose("s-1", "p", "Look", "scout", "judge", None).unwrap(), "Start work on s-1 (p): Look");
        assert!(compose("s-1", "p", "Look", "scout", "direct-PR", None).is_err());
    }

    #[test]
    fn a_posture_or_yolo_is_not_a_mode() {
        for mode in ["no-mistakes-prod-only", "yolo", "local-only", ""] {
            assert!(compose("t-1", "p", "T", "ship", mode, None).is_err(), "{mode} must be refused");
        }
        assert!(compose("t-1", "p", "T", "ship", "judge", Some(&"x".repeat(NOTE_LIMIT + 1))).is_err());
    }

    #[test]
    fn the_latest_ask_per_task_survives_a_relaunch() {
        let dir = std::env::temp_dir().join(format!("qd-start-{}-{}", std::process::id(), now_ms()));
        let log = log_path(&dir);
        let text = compose("t-1", "p", "T", "ship", "judge", None).unwrap();
        append(&log, &ask_record("t-1", "p", "T", "ship", "judge", None, &text, &Err("not started here".into()))).unwrap();
        append(&log, &ask_record("t-1", "p", "T", "ship", "judge", Some("again"), &text, &Ok("m-7".into()))).unwrap();
        append(&log, &ask_record("t-2", "p", "U", "scout", "judge", None, "Start work on t-2 (p): U", &Ok("m-8".into()))).unwrap();
        std::fs::OpenOptions::new().append(true).open(&log).unwrap().write_all(b"{not json\n").unwrap();
        let asks = latest(&log);
        assert_eq!(asks["t-1"]["message"], "m-7");
        assert_eq!(asks["t-1"]["note"], "again");
        assert_eq!(asks["t-1"]["error"], Value::Null);
        assert_eq!(asks["t-1"]["header"], "Start work on t-1 (p): T");
        assert_eq!(asks["t-2"]["kind"], "scout");
        assert_eq!(latest(&dir.join("absent.jsonl")), json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_message_the_host_did_not_take_is_recorded_with_why() {
        let ask = ask_record("t-1", "p", "T", "ship", "judge", None, "Start work on t-1 (p): T", &Err("The first mate isn't running".into()));
        assert_eq!(ask["message"], Value::Null);
        assert_eq!(ask["error"], "The first mate isn't running");
    }
}
