//! The captain's review of a presented artifact: comments pinned to the page,
//! kept as a draft until the whole review is sent as one message.
//!
//! Every review lives beside the revisions it is about, in the home:
//! `data/<task-id>/artifacts/<name>/review.jsonl`, or `data/.artifacts/...`
//! for a page shared in chat. It is append-only and fsynced on every write,
//! the same shape as the host's outbox, so quitting mid-review loses nothing
//! and the first mate can read the whole review itself.
//!
//! Events, one JSON object per line:
//!   {at, kind: "opened", id, rev, anchor, body}   a new thread and its comment
//!   {at, kind: "comment", id, body}               another comment on a thread
//!   {at, kind: "discarded", id}                   an unsent thread taken back
//!   {at, kind: "sent", verdict, rev, threads[], message}  one review, sent
//! A thread is a draft until a `sent` event names it. Sending is the only
//! thing that reaches the first mate; everything before it is local and
//! reversible.
//!
//! Commands: `review_get`, `review_comment`, `review_discard`, `review_submit`.

use crate::artifact;
use crate::host::{Cmd, HostHandle};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Deserialize;
use tauri::{AppHandle, State as TauriState};

/// Which page a review belongs to. The three parts travel together, so every
/// command takes the same shape the screen holds.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    scope: String,
    task: Option<String>,
    name: String,
}

/// What the captain says about the page as a whole, and what it does to the task.
const VERDICTS: [(&str, &str); 3] = [
    ("approve", "Approved."),
    ("changes", "Requests changes."),
    ("comment", "Comments only, nothing is blocked."),
];

/// Quotes in the message to the first mate are trimmed to this; the log has the whole thing.
const QUOTE_LIMIT: usize = 120;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn verdict_sentence(verdict: &str) -> Option<&'static str> {
    VERDICTS.iter().find(|(name, _)| *name == verdict).map(|(_, sentence)| *sentence)
}

/// The artifact's own folder in the home, or an error naming nothing on disk.
pub fn artifact_dir(data: &Path, scope: &str, task: Option<&str>, name: &str) -> Result<PathBuf, String> {
    if !artifact::valid_name(name) {
        return Err("that is not an artifact".to_string());
    }
    match (scope, task) {
        ("task", Some(task)) if artifact::valid_task_id(task) => Ok(data.join(task).join("artifacts").join(name)),
        ("chat", _) => Ok(data.join(".artifacts").join(name)),
        _ => Err("that is not an artifact".to_string()),
    }
}

fn read_events(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect()
}

/// Appends one event, creating the file if this is the first. The write is
/// fsynced, so a review that the screen shows as saved is on disk.
fn append(path: &Path, event: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let mut line = serde_json::to_string(event).map_err(|e| format!("could not encode the review: {e}"))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    file.write_all(line.as_bytes()).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    file.sync_all().map_err(|e| format!("could not save {}: {e}", path.display()))?;
    Ok(())
}

/// The review as the screen shows it: every thread with its comments, oldest
/// first, and whether each has been sent.
pub fn view(path: &Path) -> Value {
    let events = read_events(path);
    let mut threads: Vec<Value> = Vec::new();
    let mut sent: Vec<Value> = Vec::new();
    for event in &events {
        let kind = event.get("kind").and_then(Value::as_str).unwrap_or_default();
        let id = event.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        match kind {
            "opened" => threads.push(json!({
                "id": id,
                "rev": event.get("rev").cloned().unwrap_or(Value::Null),
                "anchor": event.get("anchor").cloned().unwrap_or(Value::Null),
                "at": event.get("at").cloned().unwrap_or(Value::Null),
                "sent_at": Value::Null,
                "comments": [{"body": event.get("body").cloned().unwrap_or(Value::Null), "at": event.get("at").cloned().unwrap_or(Value::Null)}],
            })),
            "comment" => {
                if let Some(thread) = threads.iter_mut().find(|thread| thread["id"] == id.as_str()) {
                    if let Some(comments) = thread["comments"].as_array_mut() {
                        comments.push(json!({"body": event.get("body").cloned().unwrap_or(Value::Null), "at": event.get("at").cloned().unwrap_or(Value::Null)}));
                    }
                }
            }
            "discarded" => threads.retain(|thread| thread["id"] != id.as_str()),
            "sent" => {
                let at = event.get("at").cloned().unwrap_or(Value::Null);
                for named in event.get("threads").and_then(Value::as_array).cloned().unwrap_or_default() {
                    if let Some(thread) = threads.iter_mut().find(|thread| thread["id"] == named) {
                        thread["sent_at"] = at.clone();
                    }
                }
                sent.push(json!({
                    "at": at,
                    "verdict": event.get("verdict").cloned().unwrap_or(Value::Null),
                    "rev": event.get("rev").cloned().unwrap_or(Value::Null),
                    "message": event.get("message").cloned().unwrap_or(Value::Null),
                    "threads": event.get("threads").cloned().unwrap_or(Value::Null),
                }));
            }
            _ => {}
        }
    }
    let draft: Vec<&Value> = threads.iter().filter(|thread| thread["sent_at"].is_null()).collect();
    json!({"threads": threads, "draft_count": draft.len(), "sent": sent, "log": path.to_string_lossy()})
}

fn next_thread_id(path: &Path) -> String {
    let used = read_events(path)
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("opened"))
        .count();
    format!("t{}", used + 1)
}

fn shorten(text: &str, limit: usize) -> String {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= limit {
        return trimmed;
    }
    let cut: String = trimmed.chars().take(limit).collect();
    format!("{}…", cut.trim_end())
}

/// Who a revision came from, in a sentence the first mate can act on.
fn author_line(revision: &Value) -> String {
    match revision.get("presented_by").and_then(|by| by.get("role")).and_then(Value::as_str) {
        Some("crew") => {
            let task = revision.get("presented_by").and_then(|by| by.get("task")).and_then(Value::as_str).unwrap_or("the worker");
            format!("Written by {task}. Relay this review to it word for word.")
        }
        _ => "Written by you.".to_string(),
    }
}

/// The one message a sent review becomes. The log path is included so the
/// author can read the whole review rather than only what fits here.
pub fn compose(revision: &Value, verdict: &str, threads: &[Value], log: &Path) -> Result<String, String> {
    let sentence = verdict_sentence(verdict).ok_or_else(|| format!("'{verdict}' is not a verdict"))?;
    let title = revision.get("title").and_then(Value::as_str).unwrap_or("a page");
    let rev = revision.get("rev").and_then(Value::as_u64).unwrap_or(0);
    let where_it_lives = match revision.get("scope").and_then(Value::as_str) {
        Some("task") => format!("task {}", revision.get("task").and_then(Value::as_str).unwrap_or("unknown")),
        _ => "shared in chat".to_string(),
    };
    let mut lines = vec![
        format!("Captain's review of \"{title}\" ({where_it_lives}, rev {rev}): {sentence}"),
        author_line(revision),
        format!("The whole review, including anything cut short below: {}", log.display()),
    ];
    if threads.is_empty() {
        lines.push("No comments on the page itself.".to_string());
    }
    for thread in threads {
        let id = thread.get("id").and_then(Value::as_str).unwrap_or("?");
        let quote = thread
            .get("anchor")
            .and_then(|anchor| anchor.get("quote"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let on_rev = thread.get("rev").and_then(Value::as_u64).unwrap_or(rev);
        let said = thread
            .get("comments")
            .and_then(Value::as_array)
            .map(|comments| {
                comments
                    .iter()
                    .filter_map(|comment| comment.get("body").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let place = if quote.is_empty() {
            String::new()
        } else {
            format!(" on \"{}\"", shorten(quote, QUOTE_LIMIT))
        };
        let older = if on_rev == rev { String::new() } else { format!(" (rev {on_rev})") };
        lines.push(format!("{id}{place}{older}: {}", shorten(&said, 600)));
    }
    Ok(lines.join("\n"))
}

/// The revision a review is about, read from its own record.
fn revision_record(artifact_dir: &Path, rev: u64) -> Result<Value, String> {
    let path = artifact_dir.join(format!("rev-{rev}")).join("revision.json");
    let text = std::fs::read_to_string(&path).map_err(|_| "that revision is not in this home".to_string())?;
    serde_json::from_str(&text).map_err(|_| "that revision's record cannot be read".to_string())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app)
        .map(|home| home.join("data"))
        .ok_or_else(|| "no firstmate home has been chosen".to_string())
}

fn dir_for(app: &AppHandle, page: &Ref) -> Result<PathBuf, String> {
    artifact_dir(&data_dir(app)?, &page.scope, page.task.as_deref(), &page.name)
}

fn log_path(app: &AppHandle, page: &Ref) -> Result<PathBuf, String> {
    Ok(dir_for(app, page)?.join("review.jsonl"))
}

#[tauri::command]
pub async fn review_get(app: AppHandle, page: Ref) -> Result<Value, String> {
    Ok(view(&log_path(&app, &page)?))
}

/// Opens a thread on the page, or adds a comment to one. Local and reversible
/// until the review is sent.
#[tauri::command]
pub async fn review_comment(
    app: AppHandle,
    page: Ref,
    rev: u64,
    body: String,
    anchor: Option<Value>,
    thread: Option<String>,
) -> Result<Value, String> {
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("a comment needs something in it".to_string());
    }
    let path = log_path(&app, &page)?;
    let event = match &thread {
        Some(id) => json!({"at": now_ms(), "kind": "comment", "id": id, "body": body}),
        None => json!({
            "at": now_ms(),
            "kind": "opened",
            "id": next_thread_id(&path),
            "rev": rev,
            "anchor": anchor.unwrap_or(Value::Null),
            "body": body,
        }),
    };
    append(&path, &event)?;
    Ok(view(&path))
}

#[tauri::command]
pub async fn review_discard(app: AppHandle, page: Ref, thread: String) -> Result<Value, String> {
    let path = log_path(&app, &page)?;
    let current = view(&path);
    let is_draft = current["threads"]
        .as_array()
        .is_some_and(|threads| threads.iter().any(|item| item["id"] == thread.as_str() && item["sent_at"].is_null()));
    if !is_draft {
        return Err("that comment has already been sent, so it stays on the record".to_string());
    }
    append(&path, &json!({"at": now_ms(), "kind": "discarded", "id": thread}))?;
    Ok(view(&path))
}

/// Sends the whole draft as one message to the first mate, then records that it went.
#[tauri::command]
pub async fn review_submit(
    app: AppHandle,
    host: TauriState<'_, HostHandle>,
    page: Ref,
    rev: u64,
    verdict: String,
) -> Result<Value, String> {
    let dir = dir_for(&app, &page)?;
    let path = dir.join("review.jsonl");
    let current = view(&path);
    let draft: Vec<Value> = current["threads"]
        .as_array()
        .map(|threads| threads.iter().filter(|thread| thread["sent_at"].is_null()).cloned().collect())
        .unwrap_or_default();
    let revision = revision_record(&dir, rev)?;
    let text = compose(&revision, &verdict, &draft, &path)?;
    let message = host.call(|reply| Cmd::Send { text: text.clone(), reply }).await??;
    let ids: Vec<&str> = draft.iter().filter_map(|thread| thread["id"].as_str()).collect();
    append(
        &path,
        &json!({"at": now_ms(), "kind": "sent", "verdict": verdict, "rev": rev, "threads": ids, "message": message}),
    )?;
    Ok(json!({"message": message, "text": text, "review": view(&path)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-review-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn anchor(quote: &str) -> Value {
        json!({"quote": quote, "prefix": "", "suffix": "", "path": "main > p"})
    }

    #[test]
    fn a_review_is_a_draft_until_it_is_sent() {
        let dir = scratch("draft");
        let path = dir.join("review.jsonl");
        assert_eq!(view(&path)["draft_count"], 0);

        append(&path, &json!({"at": 1, "kind": "opened", "id": next_thread_id(&path), "rev": 2, "anchor": anchor("Wi-Fi only"), "body": "Say what happens on cellular."})).unwrap();
        append(&path, &json!({"at": 2, "kind": "opened", "id": next_thread_id(&path), "rev": 2, "anchor": anchor("1.2s per snip"), "body": "Measure an older phone too."})).unwrap();
        append(&path, &json!({"at": 3, "kind": "comment", "id": "t1", "body": "And on a metered hotspot."})).unwrap();
        let current = view(&path);
        assert_eq!(current["draft_count"], 2);
        assert_eq!(current["threads"][0]["comments"].as_array().unwrap().len(), 2);
        assert_eq!(current["threads"][1]["id"], "t2");

        append(&path, &json!({"at": 4, "kind": "discarded", "id": "t2"})).unwrap();
        let current = view(&path);
        assert_eq!(current["draft_count"], 1);
        assert_eq!(current["threads"].as_array().unwrap().len(), 1);

        append(&path, &json!({"at": 5, "kind": "sent", "verdict": "changes", "rev": 2, "threads": ["t1"], "message": "out-7"})).unwrap();
        let current = view(&path);
        assert_eq!(current["draft_count"], 0);
        assert_eq!(current["threads"][0]["sent_at"], 5);
        assert_eq!(current["sent"][0]["verdict"], "changes");
        // A discarded id is never reused, so a sent review and the log always name the same thread.
        assert_eq!(next_thread_id(&path), "t3");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_half_written_line_does_not_lose_the_review() {
        let dir = scratch("torn");
        let path = dir.join("review.jsonl");
        append(&path, &json!({"at": 1, "kind": "opened", "id": "t1", "rev": 1, "anchor": anchor("a quote"), "body": "keep me"})).unwrap();
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"at\": 2, \"kind\": \"opene").unwrap();
        let current = view(&path);
        assert_eq!(current["draft_count"], 1);
        assert_eq!(current["threads"][0]["comments"][0]["body"], "keep me");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_message_carries_the_verdict_the_author_and_every_comment() {
        let revision = json!({
            "scope": "task", "task": "res-titles-scout", "name": "titles-plan", "rev": 2,
            "title": "AI titles for snips", "presented_by": {"role": "crew", "task": "res-titles-scout"},
        });
        let threads = vec![
            json!({"id": "t1", "rev": 2, "anchor": anchor("Runs after transcription, free, private."), "comments": [{"body": "Say what happens on an older phone."}, {"body": "And on a metered hotspot."}]}),
            json!({"id": "t2", "rev": 1, "anchor": anchor(&"a very long quote ".repeat(20)), "comments": [{"body": "Still open from the last round."}]}),
        ];
        let text = compose(&revision, "changes", &threads, Path::new("/home/data/res-titles-scout/artifacts/titles-plan/review.jsonl")).unwrap();
        assert!(text.starts_with("Captain's review of \"AI titles for snips\" (task res-titles-scout, rev 2): Requests changes.\n"), "{text}");
        assert!(text.contains("Written by res-titles-scout. Relay this review to it word for word."), "{text}");
        assert!(text.contains("/home/data/res-titles-scout/artifacts/titles-plan/review.jsonl"), "{text}");
        assert!(text.contains("t1 on \"Runs after transcription, free, private.\": Say what happens on an older phone. And on a metered hotspot."), "{text}");
        assert!(text.contains("t2 on \"a very long quote"), "{text}");
        assert!(text.contains("…\" (rev 1): Still open from the last round."), "{text}");

        let chat = json!({"scope": "chat", "task": null, "rev": 1, "title": "A decision", "presented_by": {"role": "firstmate"}});
        let text = compose(&chat, "approve", &[], Path::new("/home/data/.artifacts/a/review.jsonl")).unwrap();
        assert!(text.contains("(shared in chat, rev 1): Approved."), "{text}");
        assert!(text.contains("Written by you."), "{text}");
        assert!(text.contains("No comments on the page itself."), "{text}");
        assert!(compose(&chat, "merge", &[], Path::new("/x")).is_err());
    }

    #[test]
    fn a_review_belongs_to_one_artifact_folder() {
        let data = Path::new("/home/data");
        assert_eq!(artifact_dir(data, "task", Some("t1"), "plan").unwrap(), data.join("t1/artifacts/plan"));
        assert_eq!(artifact_dir(data, "chat", None, "plan").unwrap(), data.join(".artifacts/plan"));
        for (scope, task, name) in [
            ("task", Some(".."), "plan"),
            ("task", Some("t1"), "../../etc"),
            ("task", None, "plan"),
            ("files", Some("t1"), "plan"),
            ("chat", None, "Plan"),
        ] {
            assert!(artifact_dir(data, scope, task, name).is_err(), "{scope} {task:?} {name}");
        }
    }
}
