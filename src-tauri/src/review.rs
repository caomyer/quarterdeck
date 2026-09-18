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
//!   {at, kind: "answer", decision, option, label, on_answer}  a choice on a call the page argues
//!   {at, kind: "recorded", decision, result, detail}  what firstmate's intake did with it
//!   {at, kind: "told", answers[], message}        recorded answers told to the first mate outside a review
//!   {at, kind: "resolved" | "reopened", id}       the captain settles a thread
//!   {at, kind: "seen", rev}                       the captain looked at a revision
//! A thread is a draft until a `sent` event names it. Sending is the only
//! thing that reaches the first mate; everything before it is local and
//! reversible.
//!
//! A thread's state follows from those events: `draft` until it is sent, then
//! `open` until the captain resolves it, and `resolved` after. Whether the
//! author says a revision answers it is the author's claim, recorded on the
//! revision itself; settling a thread stays the captain's.
//!
//! An answer is staged the same way a comment is: local and changeable until
//! the review goes. Sending runs firstmate's own intake (`calls::record`) with
//! the staged answers first, notes what it did with each, and then tells the
//! first mate which answers are already recorded, so it does the follow-up
//! rather than the recording. The app never closes a call itself, and an
//! answer the intake skipped is shown as not recorded, never as sent.
//!
//! A change the captain makes to a diagram the page owns is a thread like any
//! other: its anchor names the scene instead of quoting words, its body says
//! what changed, and the proposed scene and a picture of it are written beside
//! the review for the author to pick up. The author's next revision is still
//! the only thing that changes the page.
//!
//! Commands: `review_get`, `review_comment`, `review_discard`, `review_submit`,
//! `review_settle`, `review_seen`, `review_summary`, `review_answer`,
//! `review_scene`, `call_answer`.

use crate::artifact;
use crate::calls::{self, Keyed, Outcome};
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

/// A diagram as the captain left it: which diagram, what changed, and the scene
/// and picture to hand the author.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    scene: String,
    label: String,
    path: String,
    summary: String,
    scene_json: String,
    png_base64: String,
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
    let mut answers: Vec<Value> = Vec::new();
    let mut seen: Option<u64> = None;
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
                "state": "draft",
                "resolved_at": Value::Null,
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
            "resolved" | "reopened" => {
                if let Some(thread) = threads.iter_mut().find(|thread| thread["id"] == id.as_str()) {
                    // A thread nobody has sent yet is still a draft; settling waits for it to go.
                    if !thread["sent_at"].is_null() {
                        let settled = kind == "resolved";
                        thread["state"] = json!(if settled { "resolved" } else { "open" });
                        thread["resolved_at"] = if settled { event.get("at").cloned().unwrap_or(Value::Null) } else { Value::Null };
                    }
                }
            }
            "seen" => seen = event.get("rev").and_then(Value::as_u64).max(seen),
            "answer" => {
                let decision = event.get("decision").and_then(Value::as_str).unwrap_or_default().to_string();
                // A recorded or sent answer is on the record; nothing after it changes it.
                if answers.iter().any(|answer| answer["decision"] == decision.as_str() && locked(answer)) {
                    continue;
                }
                answers.retain(|answer: &Value| answer["decision"] != decision.as_str());
                // Choosing nothing takes the answer back off the tray.
                if event.get("option").and_then(Value::as_str).is_some() {
                    answers.push(json!({
                        "decision": decision,
                        "option": event.get("option").cloned().unwrap_or(Value::Null),
                        "label": event.get("label").cloned().unwrap_or(Value::Null),
                        "on_answer": event.get("on_answer").cloned().unwrap_or(Value::Null),
                        "at": event.get("at").cloned().unwrap_or(Value::Null),
                        "sent_at": Value::Null,
                        "recorded": Value::Null,
                    }));
                }
            }
            "recorded" => {
                let decision = event.get("decision").and_then(Value::as_str).unwrap_or_default();
                if let Some(answer) = answers.iter_mut().find(|answer| answer["decision"] == decision && answer["recorded"].is_null()) {
                    answer["recorded"] = json!({
                        "result": event.get("result").cloned().unwrap_or(Value::Null),
                        "detail": event.get("detail").cloned().unwrap_or(Value::Null),
                        "at": event.get("at").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            "told" => {
                let at = event.get("at").cloned().unwrap_or(Value::Null);
                let carried = event.get("answers").and_then(Value::as_array).cloned().unwrap_or_default();
                for answer in answers.iter_mut() {
                    if answer["sent_at"].is_null() && carried.iter().any(|decision| *decision == answer["decision"]) {
                        answer["sent_at"] = at.clone();
                    }
                }
            }
            "sent" => {
                let at = event.get("at").cloned().unwrap_or(Value::Null);
                for named in event.get("threads").and_then(Value::as_array).cloned().unwrap_or_default() {
                    if let Some(thread) = threads.iter_mut().find(|thread| thread["id"] == named) {
                        thread["sent_at"] = at.clone();
                        if thread["state"] == "draft" {
                            thread["state"] = json!("open");
                        }
                    }
                }
                // Only what this message carried: a pick made while it was on its way went nowhere.
                let carried = event.get("answers").and_then(Value::as_array).cloned().unwrap_or_default();
                for answer in answers.iter_mut() {
                    if answer["sent_at"].is_null() && carried.iter().any(|decision| *decision == answer["decision"]) {
                        answer["sent_at"] = at.clone();
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
    // Waiting to go: answers not through the intake yet, and recorded ones the first mate has not been told of.
    let staged = answers.iter().filter(|answer| is_staged(answer) || is_untold(answer)).count();
    let open = threads.iter().filter(|thread| thread["state"] == "open").count();
    json!({
        "threads": threads,
        "answers": answers,
        "draft_count": draft.len() + staged,
        "staged_answers": staged,
        "open_count": open,
        "sent": sent,
        "seen_rev": seen,
        "log": path.to_string_lossy(),
    })
}

/// Chosen, and not through firstmate's intake yet.
fn is_staged(answer: &Value) -> bool {
    answer["recorded"].is_null() && answer["sent_at"].is_null()
}

/// Recorded by the intake.
fn is_recorded(answer: &Value) -> bool {
    answer["recorded"]["result"] == "closed"
}

/// Recorded, and the first mate not told yet.
fn is_untold(answer: &Value) -> bool {
    is_recorded(answer) && answer["sent_at"].is_null()
}

/// An answer that can no longer change: recorded, or, in a review sent before
/// the app called the intake itself, already handed to the first mate to record.
fn locked(answer: &Value) -> bool {
    is_recorded(answer) || (!answer["sent_at"].is_null() && answer["recorded"].is_null())
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
pub fn compose(revision: &Value, verdict: &str, threads: &[Value], answers: &[Value], log: &Path) -> Result<String, String> {
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
    lines.extend(recorded_lines(answers));
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
        let scene = thread.get("anchor").and_then(|anchor| anchor.get("scene")).and_then(Value::as_str);
        let place = match (scene, quote.is_empty()) {
            (Some(_), _) => format!(" on the diagram \"{}\"", shorten(quote, QUOTE_LIMIT)),
            (None, true) => String::new(),
            (None, false) => format!(" on \"{}\"", shorten(quote, QUOTE_LIMIT)),
        };
        let older = if on_rev == rev { String::new() } else { format!(" (rev {on_rev})") };
        lines.push(format!("{id}{place}{older}: {}", shorten(&said, 600)));
        if scene.is_some() {
            let anchor = thread.get("anchor");
            let file = anchor.and_then(|anchor| anchor.get("scene_file")).and_then(Value::as_str).unwrap_or("");
            let picture = anchor.and_then(|anchor| anchor.get("picture")).and_then(Value::as_str).unwrap_or("");
            lines.push(format!("  proposed scene: {file}"));
            if !picture.is_empty() {
                lines.push(format!("  picture of it: {picture}"));
            }
        }
    }
    Ok(lines.join("\n"))
}

/// The answers firstmate's intake has already recorded, stated as done, so the
/// first mate does the follow-up rather than recording them again.
fn recorded_lines(answers: &[Value]) -> Vec<String> {
    if answers.is_empty() {
        return Vec::new();
    }
    let mut lines = vec!["Answers already recorded with bin/fm-captain-hold.sh; do the follow-up each one calls for, and do not record them again:".to_string()];
    for answer in answers {
        let decision = answer.get("decision").and_then(Value::as_str).unwrap_or("?");
        let key = answer.get("option").and_then(Value::as_str).unwrap_or("?");
        let label = answer.get("label").and_then(Value::as_str).unwrap_or_default();
        let said = if label.is_empty() { String::new() } else { format!(" (\"{}\")", shorten(label, 200)) };
        lines.push(format!("Recorded: {decision} = {key}{said}"));
    }
    lines
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

/// One writer at a time for every review log in the home. A thread id is worked
/// out from the log before it is written, and a review is read, sent and then
/// recorded, so two commands interleaving could hand out one id twice or send
/// one draft twice. Async, because a submit holds it across the send.
#[derive(Default)]
pub struct Writes(tokio::sync::Mutex<()>);

/// Runs file work on the blocking pool: every write is fsynced, and none of it
/// belongs on the threads that drive the app.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the review could not be read or saved: {e}"))?
}

#[tauri::command]
pub async fn review_get(app: AppHandle, page: Ref) -> Result<Value, String> {
    blocking(move || Ok(view(&log_path(&app, &page)?))).await
}

/// The only anchor a comment on the page may carry: words and where they sit.
///
/// The anchor comes from a script running inside the page, and the page is not
/// trusted, so everything else is dropped and every part is capped. A diagram
/// anchor, which names files, is only ever written by `review_scene`.
fn text_anchor(anchor: Option<Value>) -> Value {
    let Some(anchor) = anchor else { return Value::Null };
    let part = |key: &str, limit: usize| {
        let text = anchor.get(key).and_then(Value::as_str).unwrap_or_default();
        Value::String(text.chars().take(limit).collect())
    };
    let quote = part("quote", 400);
    if quote.as_str().is_some_and(str::is_empty) {
        return Value::Null;
    }
    json!({"quote": quote, "prefix": part("prefix", 200), "suffix": part("suffix", 200), "path": part("path", 600)})
}

/// Opens a thread on the page, or adds a comment to one, in the review at `log`.
/// Local and reversible until the review is sent.
pub fn add_comment(log: &Path, rev: u64, body: &str, anchor: Option<Value>, thread: Option<&str>) -> Result<Value, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("a comment needs something in it".to_string());
    }
    let event = match thread {
        Some(id) => json!({"at": now_ms(), "kind": "comment", "id": id, "body": body}),
        None => json!({
            "at": now_ms(),
            "kind": "opened",
            "id": next_thread_id(log),
            "rev": rev,
            "anchor": text_anchor(anchor),
            "body": body,
        }),
    };
    append(log, &event)?;
    Ok(view(log))
}

#[tauri::command]
pub async fn review_comment(
    app: AppHandle,
    writes: TauriState<'_, Writes>,
    page: Ref,
    rev: u64,
    body: String,
    anchor: Option<Value>,
    thread: Option<String>,
) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    blocking(move || add_comment(&log_path(&app, &page)?, rev, &body, anchor, thread.as_deref())).await
}

/// Takes back a comment that has not been sent. A sent one stays on the record.
pub fn discard(log: &Path, thread: &str) -> Result<Value, String> {
    let is_draft = view(log)["threads"]
        .as_array()
        .is_some_and(|threads| threads.iter().any(|item| item["id"] == thread && item["sent_at"].is_null()));
    if !is_draft {
        return Err("that comment has already been sent, so it stays on the record".to_string());
    }
    append(log, &json!({"at": now_ms(), "kind": "discarded", "id": thread}))?;
    Ok(view(log))
}

#[tauri::command]
pub async fn review_discard(app: AppHandle, writes: TauriState<'_, Writes>, page: Ref, thread: String) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    blocking(move || discard(&log_path(&app, &page)?, &thread)).await
}

fn answers_where(log: &Path, keep: fn(&Value) -> bool) -> Vec<Value> {
    view(log)["answers"].as_array().map(|answers| answers.iter().filter(|answer| keep(answer)).cloned().collect()).unwrap_or_default()
}

/// The answers chosen in this review that have not been through the intake yet,
/// as the intake takes them.
pub fn staged(log: &Path) -> Vec<Keyed> {
    answers_where(log, is_staged)
        .iter()
        .map(|answer| Keyed {
            call: answer["decision"].as_str().unwrap_or_default().to_string(),
            key: answer["option"].as_str().unwrap_or_default().to_string(),
            label: answer["label"].as_str().unwrap_or_default().to_string(),
            on_answer: answer["on_answer"].as_str().unwrap_or_default().to_string(),
        })
        .collect()
}

/// Notes what the intake did with each answer, in the review it was chosen in.
pub fn note_outcomes(log: &Path, answers: &[Keyed], outcomes: &[Outcome]) -> Result<Value, String> {
    for (answer, outcome) in answers.iter().zip(outcomes) {
        append(
            log,
            &json!({"at": now_ms(), "kind": "recorded", "decision": answer.call, "result": outcome.result(), "detail": outcome.detail()}),
        )?;
    }
    Ok(view(log))
}

/// The one message a review sends, with the draft comments and recorded answers
/// it is made of, so what goes out and what is noted as sent cannot drift apart.
/// Composed after the intake has run: only answers it recorded are in it.
pub fn draft(dir: &Path, rev: u64, verdict: &str) -> Result<(String, Vec<Value>, Vec<Value>), String> {
    let log = dir.join("review.jsonl");
    let current = view(&log);
    let threads: Vec<Value> = current["threads"]
        .as_array()
        .map(|threads| threads.iter().filter(|thread| thread["sent_at"].is_null()).cloned().collect())
        .unwrap_or_default();
    let answers = answers_where(&log, is_untold);
    let revision = revision_record(dir, rev)?;
    let text = compose(&revision, verdict, &threads, &answers, &log)?;
    Ok((text, threads, answers))
}

/// Records that the draft went, under the id the host gave the message.
pub fn record_sent(log: &Path, verdict: &str, rev: u64, threads: &[Value], answers: &[Value], message: &str) -> Result<Value, String> {
    append(
        log,
        &json!({
            "at": now_ms(), "kind": "sent", "verdict": verdict, "rev": rev, "message": message,
            "threads": threads.iter().filter_map(|thread| thread["id"].as_str()).collect::<Vec<_>>(),
            "answers": answers.iter().filter_map(|answer| answer["decision"].as_str()).collect::<Vec<_>>(),
        }),
    )?;
    Ok(view(log))
}

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

/// Runs the intake for the answers staged in the review at `log` (every one, or
/// only the one call named), notes what it did with each there, and returns
/// those outcomes for the screen.
pub async fn record_staged(home: &Path, log: &Path, only: Option<&str>) -> Result<Vec<Value>, String> {
    let answers: Vec<Keyed> = {
        let log = log.to_path_buf();
        blocking(move || Ok(staged(&log))).await?
    };
    let answers: Vec<Keyed> = answers.into_iter().filter(|answer| only.is_none() || only == Some(answer.call.as_str())).collect();
    if answers.is_empty() {
        return Ok(Vec::new());
    }
    let outcomes = calls::record(home, &answers).await;
    let shown: Vec<Value> = answers.iter().zip(&outcomes).map(|(answer, outcome)| outcome.to_json(&answer.call)).collect();
    let log = log.to_path_buf();
    blocking(move || note_outcomes(&log, &answers, &outcomes)).await?;
    Ok(shown)
}

/// Records the review's answers through firstmate's intake, then sends the whole
/// draft as one message to the first mate, and notes that it went.
///
/// Once the host has taken the message it has gone, so a failure to note that
/// is reported alongside the sent message rather than as a failed send: a send
/// shown as failed invites sending the same review twice. An answer the intake
/// recorded stays recorded if the message then cannot go, and is told with the
/// next review.
#[tauri::command]
pub async fn review_submit(
    app: AppHandle,
    host: TauriState<'_, HostHandle>,
    writes: TauriState<'_, Writes>,
    page: Ref,
    rev: u64,
    verdict: String,
) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    let home = home_for(&app)?;
    let dir = blocking(move || dir_for(&app, &page)).await?;
    let log = dir.join("review.jsonl");
    let outcomes = record_staged(&home, &log, None).await?;
    let (text, threads, answers) = {
        let (dir, verdict) = (dir.clone(), verdict.clone());
        blocking(move || draft(&dir, rev, &verdict)).await?
    };
    let message = match host.call(|reply| Cmd::Send { text: text.clone(), reply }).await? {
        Ok(message) => message,
        Err(problem) if !outcomes.is_empty() => {
            // The intake has run, so the screen has to show what it recorded even though nothing went.
            let review = blocking(move || Ok(view(&log))).await.unwrap_or(Value::Null);
            return Ok(json!({
                "message": Value::Null, "text": text, "review": review, "outcomes": outcomes,
                "warning": format!("The review did not reach the first mate: {problem}. Any answer shown as recorded is recorded; send the review again to tell the first mate."),
            }));
        }
        Err(problem) => return Err(problem),
    };
    let recorded = {
        let (log, message) = (log.clone(), message.clone());
        blocking(move || record_sent(&log, &verdict, rev, &threads, &answers, &message)).await
    };
    match recorded {
        Ok(review) => Ok(json!({"message": message, "text": text, "review": review, "outcomes": outcomes})),
        Err(problem) => {
            log::error!("review {message} was sent but not recorded: {problem}");
            let review = blocking(move || Ok(view(&log))).await.unwrap_or(Value::Null);
            Ok(json!({"message": message, "text": text, "review": review, "outcomes": outcomes, "warning": format!("Sent, but the app could not note that it went: {problem}")}))
        }
    }
}

/// What the first mate is told when the captain answers a call from Bearings:
/// that it is recorded, and anything the captain added.
pub fn answer_message(call: &str, key: &str, label: &str, note: Option<&str>) -> String {
    let answer = json!({"decision": call, "option": key, "label": label});
    let mut lines = vec!["The captain answered a call from Bearings.".to_string()];
    lines.extend(recorded_lines(&[answer]));
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        lines.push(format!("The captain added: {}", shorten(note, 1200)));
    }
    lines.join("\n")
}

/// Records one answer through the intake: staged first in the review at `log`
/// when a page argues the call, so what happened is noted beside that page.
/// Returns what the intake did with it.
pub async fn answer_one(home: &Path, log: Option<&Path>, keyed: &Keyed) -> Result<Value, String> {
    let outcomes = match log {
        Some(log) => {
            let (log_at, staged) = (log.to_path_buf(), keyed.clone());
            blocking(move || stage_answer(&log_at, &staged.call, Some(&staged.key), Some(&staged.label), Some(&staged.on_answer))).await?;
            record_staged(home, log, Some(&keyed.call)).await?
        }
        None => calls::record(home, std::slice::from_ref(keyed)).await.iter().map(|outcome| outcome.to_json(&keyed.call)).collect(),
    };
    Ok(outcomes.into_iter().find(|outcome| outcome["call"] == keyed.call.as_str()).unwrap_or_else(|| {
        Outcome::NotRecorded("the intake was not run for this answer".to_string()).to_json(&keyed.call)
    }))
}

/// Answers one call straight from Bearings: stages it in the review of the page
/// that argues it (when one does), runs the intake for it, notes what happened,
/// and only if the intake recorded it tells the first mate, so it does the
/// follow-up. A skip or a failure sends nothing: there is nothing to follow up.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn call_answer(
    app: AppHandle,
    host: TauriState<'_, HostHandle>,
    writes: TauriState<'_, Writes>,
    page: Option<Ref>,
    call: String,
    option: String,
    label: String,
    on_answer: String,
    note: Option<String>,
) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    let home = home_for(&app)?;
    let keyed = Keyed { call: call.clone(), key: option.clone(), label: label.clone(), on_answer: on_answer.clone() };
    let log = match page {
        Some(page) => Some(blocking(move || log_path(&app, &page)).await?),
        None => None,
    };
    let outcome = answer_one(&home, log.as_deref(), &keyed).await?;
    let review = match &log {
        Some(log) => {
            let log = log.clone();
            blocking(move || Ok(view(&log))).await.unwrap_or(Value::Null)
        }
        None => Value::Null,
    };
    if outcome["result"] != "closed" {
        return Ok(json!({"outcome": outcome, "message": Value::Null, "text": Value::Null, "review": review}));
    }
    let text = answer_message(&call, &option, &label, note.as_deref());
    let message = match host.call(|reply| Cmd::Send { text: text.clone(), reply }).await? {
        Ok(message) => message,
        Err(problem) => {
            return Ok(json!({
                "outcome": outcome, "message": Value::Null, "text": text, "review": review,
                "warning": format!("Recorded, but the first mate was not told: {problem}. Tell it in chat so it does the follow-up."),
            }));
        }
    };
    let review = match &log {
        Some(log) => {
            let (log, call, message) = (log.clone(), call.clone(), message.clone());
            blocking(move || {
                append(&log, &json!({"at": now_ms(), "kind": "told", "answers": [call], "message": message}))?;
                Ok(view(&log))
            })
            .await
            .unwrap_or(review)
        }
        None => review,
    };
    Ok(json!({"outcome": outcome, "message": message, "text": text, "review": review}))
}

/// Every page's review at a glance, keyed `task/<id>/<name>` or `chat/<name>`:
/// the newest revision looked at, how many comments are waiting or unsent, which
/// comments are open and on which revision, and which held tasks it has answered. Only what the list and the calls need, so
/// it stays one cheap read per page.
pub fn summary(data: &Path) -> Value {
    let mut pages = serde_json::Map::new();
    let mut add = |key: String, log: PathBuf| {
        if !log.is_file() {
            return;
        }
        let current = view(&log);
        let answered: Vec<&str> = current["answers"]
            .as_array()
            .map(|answers| {
                answers
                    .iter()
                    .filter(|answer| locked(answer))
                    .filter_map(|answer| answer["decision"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        // Each comment still open, with the revision it was written on: a later revision the author
        // presented may answer it, and then the next move is the captain's, not the author's.
        let open_threads: Vec<Value> = current["threads"]
            .as_array()
            .map(|threads| {
                threads
                    .iter()
                    .filter(|thread| thread["state"] == "open")
                    .map(|thread| json!({"id": thread["id"], "rev": thread["rev"]}))
                    .collect()
            })
            .unwrap_or_default();
        pages.insert(
            key,
            json!({
                "seen_rev": current["seen_rev"],
                "draft_count": current["draft_count"],
                "open_count": current["open_count"],
                "answered": answered,
                "open_threads": open_threads,
            }),
        );
    };
    let Ok(entries) = std::fs::read_dir(data) else { return Value::Object(pages) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".artifacts" {
            for page in std::fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                let page_name = page.file_name().to_string_lossy().to_string();
                add(format!("chat/{page_name}"), page.path().join("review.jsonl"));
            }
        } else if artifact::valid_task_id(&name) {
            for page in std::fs::read_dir(entry.path().join("artifacts")).into_iter().flatten().flatten() {
                let page_name = page.file_name().to_string_lossy().to_string();
                add(format!("task/{name}/{page_name}"), page.path().join("review.jsonl"));
            }
        }
    }
    Value::Object(pages)
}

#[tauri::command]
pub async fn review_summary(app: AppHandle) -> Result<Value, String> {
    blocking(move || Ok(summary(&data_dir(&app)?))).await
}

/// Stages the captain's choice on a call this page argues, or takes it back
/// when `option` is absent. `on_answer` is what the call declares, handed to
/// the intake as it is. Nothing is recorded until the review is sent; once the
/// intake has recorded it, it is on the record, and changing it is a new
/// conversation with the first mate, not an edit. An answer the intake skipped
/// can be chosen again.
pub fn stage_answer(log: &Path, decision: &str, option: Option<&str>, label: Option<&str>, on_answer: Option<&str>) -> Result<Value, String> {
    if !artifact::valid_task_id(decision) {
        return Err("that is not a task".to_string());
    }
    let already = view(log)["answers"]
        .as_array()
        .is_some_and(|answers| answers.iter().any(|answer| answer["decision"] == decision && locked(answer)));
    if already {
        return Err("that answer is already on the record; tell the first mate in chat if you have changed your mind".to_string());
    }
    append(
        log,
        &json!({"at": now_ms(), "kind": "answer", "decision": decision, "option": option, "label": label, "on_answer": on_answer}),
    )?;
    Ok(view(log))
}

#[tauri::command]
pub async fn review_answer(
    app: AppHandle,
    writes: TauriState<'_, Writes>,
    page: Ref,
    decision: String,
    option: Option<String>,
    label: Option<String>,
    on_answer: Option<String>,
) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    blocking(move || stage_answer(&log_path(&app, &page)?, &decision, option.as_deref(), label.as_deref(), on_answer.as_deref())).await
}

/// Files a proposed diagram beside the review and opens a thread for it. The
/// scene is written as the captain left it, with a picture, so the author can
/// see it and take it up in the next revision.
#[tauri::command]
pub async fn review_scene(app: AppHandle, writes: TauriState<'_, Writes>, page: Ref, rev: u64, proposal: Proposal) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    blocking(move || propose_scene(&log_path(&app, &page)?, rev, proposal)).await
}

fn propose_scene(log: &Path, rev: u64, proposal: Proposal) -> Result<Value, String> {
    let Proposal { scene, label, path, summary, scene_json, png_base64 } = proposal;
    if scene.contains('/') || scene.contains('\\') || scene.starts_with('.') || scene.is_empty() {
        return Err("that is not a diagram this page owns".to_string());
    }
    serde_json::from_str::<Value>(&scene_json).map_err(|_| "the diagram could not be read".to_string())?;
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err("a proposal needs to say what changed".to_string());
    }
    let id = next_thread_id(log);
    let folder = log.parent().ok_or("the review has nowhere to live")?.join("review-files");
    std::fs::create_dir_all(&folder).map_err(|e| format!("could not create {}: {e}", folder.display()))?;
    let scene_file = folder.join(format!("{id}.excalidraw"));
    std::fs::write(&scene_file, scene_json).map_err(|e| format!("could not write {}: {e}", scene_file.display()))?;
    let picture = folder.join(format!("{id}.png"));
    match decode_base64(&png_base64) {
        Some(bytes) => std::fs::write(&picture, bytes).map_err(|e| format!("could not write {}: {e}", picture.display()))?,
        None => log::warn!("a proposed diagram came without a readable picture"),
    }
    append(
        log,
        &json!({
            "at": now_ms(), "kind": "opened", "id": id, "rev": rev, "body": summary,
            "anchor": {
                "scene": scene, "label": label, "path": path, "quote": label,
                "scene_file": scene_file.to_string_lossy(),
                "picture": if picture.is_file() { Value::String(picture.to_string_lossy().to_string()) } else { Value::Null },
            },
        }),
    )?;
    Ok(view(log))
}

/// Just enough base64 for the picture a proposal carries.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let body = text.rsplit(',').next()?;
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in body.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = ALPHABET.iter().position(|candidate| *candidate == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// The captain settles a thread, or opens it again. Only a sent thread can be
/// settled: a draft is still theirs to change.
pub fn settle(log: &Path, thread: &str, resolved: bool) -> Result<Value, String> {
    let sent = view(log)["threads"]
        .as_array()
        .is_some_and(|threads| threads.iter().any(|item| item["id"] == thread && !item["sent_at"].is_null()));
    if !sent {
        return Err("that comment has not been sent yet".to_string());
    }
    let kind = if resolved { "resolved" } else { "reopened" };
    append(log, &json!({"at": now_ms(), "kind": kind, "id": thread}))?;
    Ok(view(log))
}

#[tauri::command]
pub async fn review_settle(app: AppHandle, writes: TauriState<'_, Writes>, page: Ref, thread: String, resolved: bool) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    blocking(move || settle(&log_path(&app, &page)?, &thread, resolved)).await
}

/// Records that the captain has looked at a revision, so a later one can be
/// marked as new. Looking at an older revision never unsees a newer one.
pub fn mark_seen(log: &Path, rev: u64) -> Result<Value, String> {
    let current = view(log);
    if current["seen_rev"].as_u64().is_some_and(|already| already >= rev) {
        return Ok(current);
    }
    append(log, &json!({"at": now_ms(), "kind": "seen", "rev": rev}))?;
    Ok(view(log))
}

#[tauri::command]
pub async fn review_seen(app: AppHandle, writes: TauriState<'_, Writes>, page: Ref, rev: u64) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    blocking(move || mark_seen(&log_path(&app, &page)?, rev)).await
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
        assert_eq!(current["open_count"], 1);
        assert_eq!(current["threads"][0]["sent_at"], 5);
        assert_eq!(current["threads"][0]["state"], "open");
        assert_eq!(current["sent"][0]["verdict"], "changes");
        // A discarded id is never reused, so a sent review and the log always name the same thread.
        assert_eq!(next_thread_id(&path), "t3");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_answer_is_staged_changeable_and_goes_with_the_review() {
        let dir = scratch("answers");
        let path = dir.join("review.jsonl");
        append(&path, &json!({"at": 1, "kind": "answer", "decision": "res-model", "option": "eager", "label": "Keep downloading eagerly"})).unwrap();
        let current = view(&path);
        assert_eq!(current["staged_answers"], 1);
        assert_eq!(current["draft_count"], 1);
        assert_eq!(current["answers"][0]["option"], "eager");

        // Choosing again replaces the answer rather than adding a second one.
        append(&path, &json!({"at": 2, "kind": "answer", "decision": "res-model", "option": "wifi-only", "label": "Wi-Fi only"})).unwrap();
        let current = view(&path);
        assert_eq!(current["answers"].as_array().unwrap().len(), 1);
        assert_eq!(current["answers"][0]["option"], "wifi-only");

        // Choosing nothing takes it back off the tray.
        append(&path, &json!({"at": 3, "kind": "answer", "decision": "res-model", "option": Value::Null})).unwrap();
        assert_eq!(view(&path)["staged_answers"], 0);

        append(&path, &json!({"at": 4, "kind": "answer", "decision": "res-model", "option": "prompt", "label": "Ask on the first snip"})).unwrap();
        append(&path, &json!({"at": 5, "kind": "sent", "verdict": "approve", "rev": 1, "threads": [], "answers": ["res-model"], "message": "out-2"})).unwrap();
        let current = view(&path);
        assert_eq!(current["staged_answers"], 0);
        assert_eq!(current["draft_count"], 0);
        assert_eq!(current["answers"][0]["sent_at"], 5);

        // Once sent it is on the record: neither taking it back nor choosing again changes it.
        assert!(stage_answer(&path, "res-model", None, None, None).is_err());
        assert!(stage_answer(&path, "res-model", Some("eager"), Some("Keep downloading eagerly"), Some("done")).is_err());
        append(&path, &json!({"at": 6, "kind": "answer", "decision": "res-model", "option": Value::Null})).unwrap();
        let current = view(&path);
        assert_eq!(current["answers"][0]["option"], "prompt");
        assert_eq!(current["answers"][0]["sent_at"], 5);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_review_marks_sent_only_the_answers_it_carried() {
        let dir = scratch("carried");
        let path = dir.join("review.jsonl");
        append(&path, &json!({"at": 1, "kind": "answer", "decision": "a-call", "option": "x", "label": "X"})).unwrap();
        // Picked while the review carrying only a-call was on its way.
        append(&path, &json!({"at": 2, "kind": "answer", "decision": "b-call", "option": "y", "label": "Y"})).unwrap();
        append(&path, &json!({"at": 3, "kind": "sent", "verdict": "approve", "rev": 1, "threads": [], "answers": ["a-call"], "message": "m"})).unwrap();
        let current = view(&path);
        let sent_at = |decision: &str| current["answers"].as_array().unwrap().iter().find(|a| a["decision"] == decision).unwrap()["sent_at"].clone();
        assert_eq!(sent_at("a-call"), 3);
        assert_eq!(sent_at("b-call"), Value::Null);
        assert_eq!(current["staged_answers"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_comment_keeps_only_a_text_anchor() {
        let dir = scratch("anchor");
        let path = dir.join("review.jsonl");
        let forged = json!({"quote": "Intro", "prefix": "", "suffix": "", "path": "h1", "scene": "x", "scene_file": "/Users/me/.ssh/id_rsa", "picture": "p", "preview": "https://example.invalid/beacon"});
        let current = add_comment(&path, 1, "Say more.", Some(forged), None).unwrap();
        let anchor = &current["threads"][0]["anchor"];
        assert_eq!(anchor["quote"], "Intro");
        for key in ["scene", "scene_file", "picture", "preview"] {
            assert!(anchor.get(key).is_none(), "{key} survived: {anchor}");
        }
        let text = compose(&json!({"scope": "chat", "rev": 1, "title": "t"}), "comment", current["threads"].as_array().unwrap(), &[], &path).unwrap();
        assert!(!text.contains("id_rsa"), "{text}");
        // Nothing to quote is a comment on the page as a whole.
        let current = add_comment(&path, 1, "Overall.", Some(json!({"quote": ""})), None).unwrap();
        assert_eq!(current["threads"][1]["anchor"], Value::Null);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settling_is_the_captains_and_only_after_a_comment_has_gone() {
        let dir = scratch("settle");
        let path = dir.join("review.jsonl");
        append(&path, &json!({"at": 1, "kind": "opened", "id": "t1", "rev": 1, "anchor": anchor("a"), "body": "one"})).unwrap();
        append(&path, &json!({"at": 2, "kind": "opened", "id": "t2", "rev": 1, "anchor": anchor("b"), "body": "two"})).unwrap();
        // A draft cannot be settled, so its state never jumps ahead of the first mate hearing it.
        append(&path, &json!({"at": 3, "kind": "resolved", "id": "t1"})).unwrap();
        assert_eq!(view(&path)["threads"][0]["state"], "draft");

        append(&path, &json!({"at": 4, "kind": "sent", "verdict": "changes", "rev": 1, "threads": ["t1", "t2"], "message": "out-1"})).unwrap();
        assert_eq!(view(&path)["open_count"], 2);
        append(&path, &json!({"at": 5, "kind": "resolved", "id": "t1"})).unwrap();
        let current = view(&path);
        assert_eq!(current["threads"][0]["state"], "resolved");
        assert_eq!(current["threads"][0]["resolved_at"], 5);
        assert_eq!(current["open_count"], 1);
        append(&path, &json!({"at": 6, "kind": "reopened", "id": "t1"})).unwrap();
        let current = view(&path);
        assert_eq!(current["threads"][0]["state"], "open");
        assert!(current["threads"][0]["resolved_at"].is_null());
        assert_eq!(current["open_count"], 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_newest_revision_looked_at_is_remembered() {
        let dir = scratch("seen");
        let path = dir.join("review.jsonl");
        assert!(view(&path)["seen_rev"].is_null());
        append(&path, &json!({"at": 1, "kind": "seen", "rev": 2})).unwrap();
        assert_eq!(view(&path)["seen_rev"], 2);
        // Looking back at an older revision does not unsee the newer one.
        append(&path, &json!({"at": 2, "kind": "seen", "rev": 1})).unwrap();
        assert_eq!(view(&path)["seen_rev"], 2);
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
        let text = compose(&revision, "changes", &threads, &[], Path::new("/home/data/res-titles-scout/artifacts/titles-plan/review.jsonl")).unwrap();
        assert!(text.starts_with("Captain's review of \"AI titles for snips\" (task res-titles-scout, rev 2): Requests changes.\n"), "{text}");
        assert!(text.contains("Written by res-titles-scout. Relay this review to it word for word."), "{text}");
        assert!(text.contains("/home/data/res-titles-scout/artifacts/titles-plan/review.jsonl"), "{text}");
        assert!(text.contains("t1 on \"Runs after transcription, free, private.\": Say what happens on an older phone. And on a metered hotspot."), "{text}");
        assert!(text.contains("t2 on \"a very long quote"), "{text}");
        assert!(text.contains("…\" (rev 1): Still open from the last round."), "{text}");

        let chat = json!({"scope": "chat", "task": null, "rev": 1, "title": "A decision", "presented_by": {"role": "firstmate"}});
        let text = compose(&chat, "approve", &[], &[], Path::new("/home/data/.artifacts/a/review.jsonl")).unwrap();
        assert!(text.contains("(shared in chat, rev 1): Approved."), "{text}");
        assert!(text.contains("Written by you."), "{text}");
        assert!(text.contains("No comments on the page itself."), "{text}");
        assert!(compose(&chat, "merge", &[], &[], Path::new("/x")).is_err());

        // An answer the intake recorded is stated as done, so the first mate follows up instead of recording it.
        let answers = vec![json!({"decision": "res-model-download", "option": "wifi-only", "label": "Wi-Fi only, with visible progress"})];
        let text = compose(&chat, "approve", &[], &answers, Path::new("/home/data/.artifacts/a/review.jsonl")).unwrap();
        assert!(text.contains("Answers already recorded with bin/fm-captain-hold.sh; do the follow-up"), "{text}");
        assert!(text.contains("\nRecorded: res-model-download = wifi-only (\"Wi-Fi only, with visible progress\")"), "{text}");
        assert!(!text.contains("to record"), "{text}");
    }

    #[test]
    fn a_bearings_answer_tells_the_first_mate_it_is_recorded() {
        let text = answer_message("res-snip-lifecycle", "retry", "Mark it failed and give the user a way to retry it", Some("  Ship it this week. "));
        assert!(text.contains("\nRecorded: res-snip-lifecycle = retry (\"Mark it failed and give the user a way to retry it\")"), "{text}");
        assert!(text.ends_with("The captain added: Ship it this week."), "{text}");
        assert!(!answer_message("a", "x", "X", Some("  ")).contains("added"));
    }

    /// A home with a pretend `fm-captain-hold.sh answers` that keeps what it was fed and prints `says`.
    fn home_with_intake(name: &str, says: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch(name);
        std::fs::create_dir_all(home.join("bin")).unwrap();
        let script = home.join("bin/fm-captain-hold.sh");
        std::fs::write(&script, format!("#!/bin/sh\ncat >> \"$FM_HOME/fed\"\ncat <<'EOF'\n{says}\nEOF\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        home
    }

    fn revision_on_disk(dir: &Path) {
        std::fs::create_dir_all(dir.join("rev-1")).unwrap();
        std::fs::write(
            dir.join("rev-1/revision.json"),
            json!({"scope": "chat", "task": null, "name": "board", "rev": 1, "title": "Two calls", "presented_by": {"role": "firstmate"}}).to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn sending_records_answers_through_the_intake_and_tells_only_what_it_recorded() {
        let home = home_with_intake("intake-review", "closed: res-model-download recorded; closed\nskipped: res-model-cellular mode release does not match the call's on_answer done");
        let dir = home.join("data/.artifacts/board");
        revision_on_disk(&dir);
        let log = dir.join("review.jsonl");
        stage_answer(&log, "res-model-download", Some("wifi-only"), Some("Wi-Fi only"), Some("done")).unwrap();
        stage_answer(&log, "res-model-cellular", Some("pause"), Some("Pause until Wi-Fi"), Some("release")).unwrap();
        assert_eq!(view(&log)["staged_answers"], 2);

        let outcomes = record_staged(&home, &log, None).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("fed")).unwrap(),
            "res-model-download\twifi-only\tWi-Fi only\tdone\nres-model-cellular\tpause\tPause until Wi-Fi\trelease\n"
        );
        assert_eq!(outcomes[0], json!({"call": "res-model-download", "result": "closed", "detail": "recorded; closed"}));
        assert_eq!(outcomes[1]["result"], "skipped");

        let current = view(&log);
        let answer = |call: &str| current["answers"].as_array().unwrap().iter().find(|a| a["decision"] == call).unwrap().clone();
        assert_eq!(answer("res-model-download")["recorded"]["result"], "closed");
        assert_eq!(answer("res-model-cellular")["recorded"]["detail"], "mode release does not match the call's on_answer done");
        // The recorded answer still waits to be told; the skipped one waits on nothing.
        assert_eq!(current["staged_answers"], 1);
        assert!(staged(&log).is_empty());

        let (text, threads, told) = draft(&dir, 1, "comment").unwrap();
        assert!(text.contains("Recorded: res-model-download = wifi-only"), "{text}");
        assert!(!text.contains("res-model-cellular"), "a skipped answer is never claimed: {text}");
        record_sent(&log, "comment", 1, &threads, &told, "out-1").unwrap();
        let current = view(&log);
        assert_eq!(current["staged_answers"], 0);
        assert_eq!(summary(&home.join("data"))["chat/board"]["answered"], json!(["res-model-download"]));

        // A recorded answer is on the record; a skipped one can be chosen again, and goes to the intake again.
        assert!(stage_answer(&log, "res-model-download", Some("prompt"), Some("Ask"), Some("done")).is_err());
        stage_answer(&log, "res-model-cellular", Some("finish"), Some("Finish on cellular"), Some("done")).unwrap();
        assert_eq!(staged(&log).len(), 1);
        assert_eq!(staged(&log)[0].key, "finish");
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn a_bearings_answer_runs_the_intake_for_that_call_alone() {
        let home = home_with_intake("intake-one", "closed: res-transcripts-source recorded; released");
        let dir = home.join("data/.artifacts/board");
        let log = dir.join("review.jsonl");
        // Something else staged on the same page stays staged for its review.
        stage_answer(&log, "res-model-download", Some("wifi-only"), Some("Wi-Fi only"), Some("done")).unwrap();
        let keyed = Keyed { call: "res-transcripts-source".into(), key: "publisher-first".into(), label: "Publisher first".into(), on_answer: "release".into() };
        let outcome = answer_one(&home, Some(&log), &keyed).await.unwrap();
        assert_eq!(outcome["result"], "closed");
        assert_eq!(std::fs::read_to_string(home.join("fed")).unwrap(), "res-transcripts-source\tpublisher-first\tPublisher first\trelease\n");
        assert_eq!(staged(&log).iter().map(|answer| answer.call.as_str()).collect::<Vec<_>>(), ["res-model-download"]);

        // With no page, nothing is written to any review, and the outcome is the intake's word alone.
        let unargued = Keyed { call: "foreman-auto-merge".into(), key: "keep".into(), label: "Keep merging".into(), on_answer: "done".into() };
        let outcome = answer_one(&home, None, &unargued).await.unwrap();
        assert_eq!(outcome["result"], "not_recorded", "the fake intake said nothing about it: {outcome}");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_summary_covers_every_page_with_a_review() {
        let data = scratch("summary");
        let task = data.join("res-titles-scout/artifacts/titles-plan");
        std::fs::create_dir_all(&task).unwrap();
        append(&task.join("review.jsonl"), &json!({"at": 1, "kind": "opened", "id": "t1", "rev": 2, "anchor": anchor("q"), "body": "b"})).unwrap();
        append(&task.join("review.jsonl"), &json!({"at": 2, "kind": "seen", "rev": 2})).unwrap();
        let chat = data.join(".artifacts/board");
        std::fs::create_dir_all(&chat).unwrap();
        append(&chat.join("review.jsonl"), &json!({"at": 1, "kind": "seen", "rev": 1})).unwrap();
        // A page nobody has reviewed has no row, and neither does a stray folder.
        std::fs::create_dir_all(data.join("res-titles-scout/artifacts/unread")).unwrap();
        std::fs::create_dir_all(data.join("notes")).unwrap();

        let pages = summary(&data);
        assert_eq!(pages["task/res-titles-scout/titles-plan"]["seen_rev"], 2);
        assert_eq!(pages["task/res-titles-scout/titles-plan"]["draft_count"], 1);
        assert_eq!(pages["chat/board"]["seen_rev"], 1);
        // A decision answered in a sent review shows against the page that answered it.
        append(&chat.join("review.jsonl"), &json!({"at": 3, "kind": "answer", "decision": "res-model", "option": "wifi-only", "label": "Wi-Fi only"})).unwrap();
        append(&chat.join("review.jsonl"), &json!({"at": 4, "kind": "sent", "verdict": "approve", "rev": 1, "threads": [], "answers": ["res-model"], "message": "out-1"})).unwrap();
        assert_eq!(summary(&data)["chat/board"]["answered"][0], "res-model");
        assert_eq!(pages["chat/board"]["draft_count"], 0);
        assert_eq!(pages.as_object().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn the_summary_names_each_open_comment_and_its_revision() {
        let data = scratch("summary-open");
        let page = data.join("res-titles-scout/artifacts/titles-plan");
        std::fs::create_dir_all(&page).unwrap();
        let log = page.join("review.jsonl");
        append(&log, &json!({"at": 1, "kind": "opened", "id": "t1", "rev": 2, "anchor": anchor("a"), "body": "one"})).unwrap();
        append(&log, &json!({"at": 2, "kind": "opened", "id": "t2", "rev": 2, "anchor": anchor("b"), "body": "two"})).unwrap();
        append(&log, &json!({"at": 3, "kind": "opened", "id": "t3", "rev": 3, "anchor": anchor("c"), "body": "three"})).unwrap();
        append(&log, &json!({"at": 4, "kind": "sent", "verdict": "changes", "rev": 3, "threads": ["t1", "t2"], "answers": [], "message": "out-1"})).unwrap();
        append(&log, &json!({"at": 5, "kind": "resolved", "id": "t2"})).unwrap();

        let row = &summary(&data)["task/res-titles-scout/titles-plan"];
        // A settled comment and an unsent one are not open; the open one carries the revision it was written on.
        assert_eq!(row["open_threads"], json!([{"id": "t1", "rev": 2}]));
        assert_eq!(row["open_count"], 1);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_proposed_diagram_reads_as_a_thread_with_its_files() {
        let revision = json!({"scope": "chat", "task": null, "rev": 2, "title": "A plan", "presented_by": {"role": "firstmate"}});
        let threads = vec![json!({
            "id": "t1", "rev": 2,
            "anchor": {"scene": "pipeline.excalidraw", "label": "Snip pipeline", "quote": "Snip pipeline",
                       "scene_file": "/home/data/.artifacts/a/review-files/t1.excalidraw",
                       "picture": "/home/data/.artifacts/a/review-files/t1.png"},
            "comments": [{"body": "Moved \"Title the snip\" below \"Transcribe\"; added \"Retry\"."}],
        })];
        let text = compose(&revision, "changes", &threads, &[], Path::new("/home/data/.artifacts/a/review.jsonl")).unwrap();
        assert!(text.contains("t1 on the diagram \"Snip pipeline\": Moved"), "{text}");
        assert!(text.contains("  proposed scene: /home/data/.artifacts/a/review-files/t1.excalidraw"), "{text}");
        assert!(text.contains("  picture of it: /home/data/.artifacts/a/review-files/t1.png"), "{text}");
    }

    #[test]
    fn a_picture_comes_back_out_of_its_base64() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("data:image/png;base64,aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert!(decode_base64("not base64!").is_none());
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
