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
//!   {at, kind: "opened", id, rev, anchor, body, picture?, picture_skipped?}
//!                                                 a new thread and its comment, with the
//!                                                 picture of its place kept in review-files/
//!   {at, kind: "comment", id, body}               another comment on a thread
//!   {at, kind: "discarded", id}                   an unsent thread taken back
//!   {at, kind: "sent", verdict, rev, threads[], answers[], message, header}
//!                                                 one review, sent: the chat message it became
//!                                                 and that message's first line, which is how
//!                                                 the chat finds it again in a resumed conversation
//!   {at, kind: "answer", decision, option, label, on_answer, note?, defer?, asked?}
//!                                                 an answer to a call the page argues: one of its
//!                                                 options, with anything the captain added, or,
//!                                                 with no option, words alone or a date to be
//!                                                 asked again on; `asked` is when the call was
//!                                                 last put, in ms, as the captain saw it
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
//! answer the intake skipped is shown as not recorded, never as sent. An answer
//! in words has no option for the intake to take, so it goes in the review's
//! message for the first mate to record, and is shown as sent once it has.
//! Such an answer holds until the call is put again after it went: then it is
//! what the captain said then, kept in `earlier`, and the call can be answered anew.
//!
//! Where a comment sits is the anchor `review-frame.js` describes: the words,
//! which match of them it is, the element by what it is, the labels around it,
//! and where it sat. When words alone may not say which place was meant, the
//! page draws itself around the place and that JPEG is kept beside the review as
//! `review-files/<thread>-r<rev>.jpg`; only its path ever reaches the first
//! mate. It is let go when its draft is taken back, or when its thread is
//! settled while its words are still on the page. A review of a crewmate's page
//! is also written to `review-files/review-<n>.md`, the exact text the crewmate
//! receives, and the first mate is told to pass that file on unchanged.
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

/// What the captain said in words with an answer: anything added to an option,
/// or, with no option, the answer itself, and a date to be asked again on.
#[derive(Deserialize, Default, Clone)]
pub struct Words {
    pub note: Option<String>,
    pub defer: Option<String>,
}

/// An answer in words is kept whole in the log; this is only a guard against a runaway paste.
const WORDS_LIMIT: usize = 4000;

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
    let mut earlier: Vec<Value> = Vec::new();
    let mut seen: Option<u64> = None;
    for event in &events {
        let kind = event.get("kind").and_then(Value::as_str).unwrap_or_default();
        let id = event.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        match kind {
            "opened" => threads.push(json!({
                "id": id,
                "rev": event.get("rev").cloned().unwrap_or(Value::Null),
                "anchor": event.get("anchor").cloned().unwrap_or(Value::Null),
                // A picture let go once its thread was settled reads as none.
                "picture": event.get("picture").filter(|picture| picture_file(path, picture).is_some_and(|file| file.is_file())).cloned().unwrap_or(Value::Null),
                "picture_skipped": event.get("picture_skipped").cloned().unwrap_or(Value::Null),
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
                // A recorded or sent answer is on the record; nothing after it changes it, unless the call was put again.
                let asked = event.get("asked").and_then(Value::as_u64);
                if answers.iter().any(|answer| answer["decision"] == decision.as_str() && locked(answer, asked)) {
                    continue;
                }
                earlier.extend(answers.iter().filter(|answer| answer["decision"] == decision.as_str() && !answer["sent_at"].is_null()).cloned());
                answers.retain(|answer: &Value| answer["decision"] != decision.as_str());
                // Choosing nothing and saying nothing takes the answer back off the tray.
                let said = |key: &str| event.get(key).and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty());
                if event.get("option").and_then(Value::as_str).is_some() || said("note") || said("defer") {
                    answers.push(json!({
                        "decision": decision,
                        "option": event.get("option").cloned().unwrap_or(Value::Null),
                        "label": event.get("label").cloned().unwrap_or(Value::Null),
                        "on_answer": event.get("on_answer").cloned().unwrap_or(Value::Null),
                        "note": event.get("note").cloned().unwrap_or(Value::Null),
                        "defer": event.get("defer").cloned().unwrap_or(Value::Null),
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
                    "header": event.get("header").cloned().unwrap_or(Value::Null),
                    "threads": event.get("threads").cloned().unwrap_or(Value::Null),
                    "answers": event.get("answers").cloned().unwrap_or(json!([])),
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
        "earlier": earlier,
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

/// One of the call's options, which is what the intake takes; an answer in words has none.
fn is_keyed(answer: &Value) -> bool {
    answer["option"].is_string()
}

/// Staged, and one the intake can take.
fn is_staged_keyed(answer: &Value) -> bool {
    is_staged(answer) && is_keyed(answer)
}

/// What the next review carries: recorded answers the first mate has not been
/// told of, and answers in words, which only the first mate can record.
fn goes_with_review(answer: &Value) -> bool {
    is_untold(answer) || (is_staged(answer) && !is_keyed(answer))
}

/// Recorded by the intake.
fn is_recorded(answer: &Value) -> bool {
    answer["recorded"]["result"] == "closed"
}

/// Recorded, and the first mate not told yet.
fn is_untold(answer: &Value) -> bool {
    is_recorded(answer) && answer["sent_at"].is_null()
}

/// Sent for the first mate to record, the intake never having recorded it:
/// words, a date, or an option from before the app called the intake itself.
fn is_handed(answer: &Value) -> bool {
    !answer["sent_at"].is_null() && answer["recorded"].is_null()
}

/// An answer that can no longer change: recorded, or handed to the first mate
/// and the call not put again since (`asked`, in ms).
fn locked(answer: &Value, asked: Option<u64>) -> bool {
    is_recorded(answer) || (is_handed(answer) && !asked.is_some_and(|asked| answer["sent_at"].as_u64().is_some_and(|sent| asked > sent)))
}

/// `YYYY-MM-DDTHH:MM:SSZ`, as firstmate stamps a call, in ms since the epoch.
fn iso_ms(text: &str) -> Option<u64> {
    let digits = |from: usize, to: usize| text.get(from..to).filter(|part| part.chars().all(|c| c.is_ascii_digit())).and_then(|part| part.parse::<i64>().ok());
    let shape = text.len() == 20 && text.as_bytes()[4] == b'-' && text.as_bytes()[7] == b'-' && text.as_bytes()[10] == b'T' && text.as_bytes()[13] == b':' && text.as_bytes()[16] == b':' && text.ends_with('Z');
    if !shape {
        return None;
    }
    let (year, month, day) = (digits(0, 4)?, digits(5, 7)?, digits(8, 10)?);
    let (hour, minute, second) = (digits(11, 13)?, digits(14, 16)?, digits(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 24 + hour) * 60 + minute) * 60 + second).ok().map(|seconds| seconds * 1000)
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

/// The crewmate that presented a revision, when a crewmate did.
fn crew_author(revision: &Value) -> Option<&str> {
    let by = revision.get("presented_by")?;
    (by.get("role").and_then(Value::as_str) == Some("crew")).then(|| by.get("task").and_then(Value::as_str).unwrap_or("the worker"))
}

/// Who a revision came from, in a sentence the first mate can act on: for a
/// crewmate's page, how to pass the review on without rewording where each
/// comment sits.
fn author_line(revision: &Value, relay: Option<&Path>) -> String {
    match (crew_author(revision), relay) {
        (Some(task), Some(relay)) => {
            let file = relay.to_string_lossy().replace('\'', "'\\''");
            format!("Written by {task}. Relay this review to it unchanged, since its lines say where on the page each comment sits: bin/fm-send.sh {task} \"$(cat '{file}')\". Add any framing of your own in a separate message.")
        }
        (Some(task), None) => format!("Written by {task}. Relay this review to it unchanged."),
        (None, _) => "Written by you.".to_string(),
    }
}

/// What a comment said, every reply included.
fn thread_words(thread: &Value) -> String {
    thread
        .get("comments")
        .and_then(Value::as_array)
        .map(|comments| comments.iter().filter_map(|comment| comment.get("body").and_then(Value::as_str)).collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// Why the author should look at a thread's picture before its words, in words.
fn reason_words(reason: &str) -> Option<&'static str> {
    match reason {
        "repeated" => Some("the words appear in more than one place on screen"),
        "opened" => Some("the place was inside something the captain had opened, so the page shows it only once that is opened again"),
        "wordless" => Some("the captain pointed at a spot with no words of its own"),
        _ => None,
    }
}

/// Everything a thread's anchor says about where it sits, one labelled line
/// each, for the author to find the place and see it. An anchor from before the
/// page could describe itself has only its words, and says only that.
fn where_lines(thread: &Value, dir: Option<&Path>) -> Vec<String> {
    let anchor = &thread["anchor"];
    let mut lines = Vec::new();
    if let (Some(n), Some(of)) = (anchor["occurrence"]["n"].as_u64(), anchor["occurrence"]["of"].as_u64()) {
        if of > 1 {
            let shown = anchor["occurrence"]["shown"].as_u64().unwrap_or(of);
            lines.push(format!("  match    {n} of the {of} places these words appear in the page's text, {shown} of them on screen"));
        }
    }
    let prefix = anchor["prefix"].as_str().unwrap_or_default();
    let suffix = anchor["suffix"].as_str().unwrap_or_default();
    if !prefix.is_empty() || !suffix.is_empty() {
        lines.push(format!("  around   \"…{}\" ▸here◂ \"{}…\"", prefix.trim_start(), suffix.trim_end()));
    }
    if let Some(element) = anchor["element"].as_str() {
        lines.push(format!("  element  {element}"));
    }
    if let Some(near) = anchor["near"].as_str() {
        lines.push(format!("  near     {near}"));
    }
    if let (Some(x), Some(y), Some(w), Some(h)) = (anchor["box"]["x"].as_i64(), anchor["box"]["y"].as_i64(), anchor["box"]["w"].as_i64(), anchor["box"]["h"].as_i64()) {
        let seen = match (anchor["view"]["w"].as_i64(), anchor["view"]["h"].as_i64(), anchor["view"]["scroll_y"].as_i64(), anchor["view"]["scheme"].as_str()) {
            (Some(vw), Some(vh), Some(scroll), Some(scheme)) => format!(", in a {vw} × {vh} window scrolled to {scroll}, on a {scheme} page"),
            _ => String::new(),
        };
        lines.push(format!("  box      x {x}, y {y}, {w} × {h} CSS px{seen}"));
    }
    if let (Some(x), Some(y)) = (anchor["point"]["x"].as_i64(), anchor["point"]["y"].as_i64()) {
        lines.push(format!("  clicked  x {x}, y {y}"));
    }
    let picture = dir.and_then(|dir| picture_file(&dir.join("review.jsonl"), &thread["picture"]));
    match (picture, thread["picture_skipped"].as_str()) {
        (Some(file), _) => {
            lines.push(format!("  picture  {}", file.display()));
            let reasons: Vec<&str> = anchor["reasons"].as_array().map(|reasons| reasons.iter().filter_map(Value::as_str).filter_map(reason_words).collect()).unwrap_or_default();
            if !reasons.is_empty() {
                lines.push(format!("           Look at it before acting: {}.", reasons.join("; ")));
            }
            lines.push("           It is a redraw the page made of itself when the captain picked the place, not a screenshot of the captain's screen. The place is outlined; layout and words are right, but colours, images from other sites and fine detail may differ from what the captain saw.".to_string());
        }
        (None, Some(reason)) => lines.push(format!("  picture  none ({reason})")),
        (None, None) => {}
    }
    lines
}

/// The review as its author receives it: the verdict, the exact page and log,
/// and every comment with where on the page it sits. Written to a file for a
/// crewmate, so firstmate passes it on byte for byte.
pub fn review_block(revision: &Value, verdict: &str, threads: &[Value], log: &Path) -> Result<String, String> {
    let sentence = verdict_sentence(verdict).ok_or_else(|| format!("'{verdict}' is not a verdict"))?;
    let title = revision.get("title").and_then(Value::as_str).unwrap_or("a page");
    let rev = revision.get("rev").and_then(Value::as_u64).unwrap_or(0);
    let where_it_lives = match revision.get("scope").and_then(Value::as_str) {
        Some("task") => format!("task {}", revision.get("task").and_then(Value::as_str).unwrap_or("unknown")),
        _ => "shared in chat".to_string(),
    };
    let dir = log.parent();
    let page_of = |rev: u64| -> Option<PathBuf> {
        let dir = dir?;
        let entry = if revision.get("rev").and_then(Value::as_u64) == Some(rev) {
            revision.get("entry").and_then(Value::as_str).map(str::to_string)
        } else {
            revision_record(dir, rev).ok()?.get("entry").and_then(Value::as_str).map(str::to_string)
        }?;
        Some(dir.join(format!("rev-{rev}")).join("files").join(entry))
    };
    let mut lines = vec![format!("Captain's review of \"{title}\" ({where_it_lives}, rev {rev}): {sentence}")];
    if let Some(page) = page_of(rev) {
        lines.push(format!("The page: {}", page.display()));
    }
    lines.push(format!("The whole review, including anything cut short below: {}", log.display()));
    if threads.is_empty() {
        lines.push("No comments on the page itself.".to_string());
    }
    for thread in threads {
        let id = thread.get("id").and_then(Value::as_str).unwrap_or("?");
        let quote = thread["anchor"]["quote"].as_str().unwrap_or_default();
        let on_rev = thread.get("rev").and_then(Value::as_u64).unwrap_or(rev);
        let scene = thread["anchor"]["scene"].as_str();
        let place = match (scene, quote.is_empty()) {
            (Some(_), _) => format!(" on the diagram \"{}\"", shorten(quote, QUOTE_LIMIT)),
            (None, true) => String::new(),
            (None, false) => format!(" on \"{}\"", shorten(quote, QUOTE_LIMIT)),
        };
        let older = if on_rev == rev { String::new() } else { format!(" (rev {on_rev})") };
        lines.push(format!("{id}{place}{older}: {}", shorten(&thread_words(thread), 600)));
        if scene.is_some() {
            let file = thread["anchor"]["scene_file"].as_str().unwrap_or("");
            let picture = thread["anchor"]["picture"].as_str().unwrap_or("");
            lines.push(format!("  proposed scene: {file}"));
            if !picture.is_empty() {
                lines.push(format!("  picture of it: {picture}"));
            }
            continue;
        }
        if on_rev != rev {
            if let Some(page) = page_of(on_rev) {
                lines.push(format!("  page     {}", page.display()));
            }
        }
        lines.extend(where_lines(thread, dir));
    }
    Ok(lines.join("\n"))
}

/// The one message a sent review becomes: the review as its author receives it,
/// with how to pass it on and the answers already recorded added after its
/// first line. The log path is included so the author can read the whole review
/// rather than only what fits here.
pub fn compose(revision: &Value, verdict: &str, threads: &[Value], answers: &[Value], log: &Path, relay: Option<&Path>) -> Result<String, String> {
    let block = review_block(revision, verdict, threads, log)?;
    let (header, rest) = block.split_once('\n').unwrap_or((block.as_str(), ""));
    let mut lines = vec![header.to_string(), author_line(revision, relay)];
    let (keyed, worded): (Vec<Value>, Vec<Value>) = answers.iter().cloned().partition(is_keyed);
    lines.extend(recorded_lines(&keyed));
    lines.extend(worded_lines(&worded));
    lines.push(rest.to_string());
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
        if let Some(note) = answer["note"].as_str().map(str::trim).filter(|note| !note.is_empty()) {
            lines.push(format!("  The captain added: {}", shorten(note, 1200)));
        }
    }
    lines
}

/// The answers the captain gave in words. Nothing has recorded them, since the
/// intake takes only an option's key, so the first mate records each as said.
fn worded_lines(answers: &[Value]) -> Vec<String> {
    if answers.is_empty() {
        return Vec::new();
    }
    let mut lines = vec!["Answered in words, which nothing has recorded yet; record each with bin/fm-captain-hold.sh as the captain said it (a date to be asked again on is a hold until then), then do the follow-up:".to_string()];
    for answer in answers {
        let decision = answer.get("decision").and_then(Value::as_str).unwrap_or("?");
        lines.push(format!("{decision}: {}", shorten(&answer_words(answer), 1200)));
    }
    lines
}

/// An answer in words as the captain gave it: not now, until a date, and whatever they wrote.
fn answer_words(answer: &Value) -> String {
    let note = answer["note"].as_str().map(str::trim).unwrap_or_default();
    match answer["defer"].as_str() {
        Some(date) if note.is_empty() => format!("Not now. Ask me again on {date}."),
        Some(date) => format!("Not now. Ask me again on {date}. {note}"),
        None => note.to_string(),
    }
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
/// trusted, so everything else is dropped, every string is capped, and every
/// number must be a finite number in range. A diagram anchor, which names
/// files, is only ever written by `review_scene`. `review-frame.js` owns what
/// each part means.
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
    let mut kept = json!({"quote": quote, "prefix": part("prefix", 200), "suffix": part("suffix", 200), "path": part("path", 600)});
    for (key, limit) in [("element", 600), ("near", 200)] {
        if anchor.get(key).and_then(Value::as_str).is_some_and(|text| !text.is_empty()) {
            kept[key] = part(key, limit);
        }
    }
    let count = |value: Option<&Value>| value.and_then(Value::as_u64).filter(|n| *n <= 100_000);
    if let Some(occurrence) = anchor.get("occurrence") {
        if let (Some(n), Some(of)) = (count(occurrence.get("n")), count(occurrence.get("of"))) {
            if n >= 1 && n <= of {
                kept["occurrence"] = json!({"n": n, "of": of, "shown": count(occurrence.get("shown")).unwrap_or(of).min(of)});
            }
        }
    }
    if let Some(found) = page_box(anchor.get("box"), true) {
        kept["box"] = found;
    }
    if let Some(point) = anchor.get("point") {
        if let (Some(x), Some(y)) = (coordinate(point.get("x")), coordinate(point.get("y"))) {
            kept["point"] = json!({"x": x, "y": y});
        }
    }
    if let Some(view) = anchor.get("view") {
        let scheme = view.get("scheme").and_then(Value::as_str).filter(|scheme| matches!(*scheme, "light" | "dark"));
        if let (Some(w), Some(h), Some(scroll_y), Some(scheme)) = (coordinate(view.get("w")), coordinate(view.get("h")), coordinate(view.get("scroll_y")), scheme) {
            kept["view"] = json!({"w": w, "h": h, "scroll_y": scroll_y, "scheme": scheme});
        }
    }
    let reasons: Vec<&str> = anchor
        .get("reasons")
        .and_then(Value::as_array)
        .map(|reasons| reasons.iter().filter_map(Value::as_str).filter(|reason| PICTURE_REASONS.contains(reason)).collect())
        .unwrap_or_default();
    if !reasons.is_empty() {
        kept["reasons"] = json!(reasons);
    }
    kept
}

/// Why the words alone may not say which place the captain meant.
const PICTURE_REASONS: [&str; 3] = ["repeated", "opened", "wordless"];

/// A whole number of CSS pixels a page could plausibly measure.
fn coordinate(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.abs() <= 1_000_000.0).then(|| number.round() as i64)
}

/// A rectangle on the page, or nothing when any part of it is not a sensible number.
fn page_box(value: Option<&Value>, allow_empty: bool) -> Option<Value> {
    let value = value?;
    let (x, y, w, h) = (coordinate(value.get("x"))?, coordinate(value.get("y"))?, coordinate(value.get("w"))?, coordinate(value.get("h"))?);
    let sized = if allow_empty { w >= 0 && h >= 0 } else { w > 0 && h > 0 };
    sized.then(|| json!({"x": x, "y": y, "w": w, "h": h}))
}

/// What the review screen hands over about a new comment's picture: the JPEG the
/// page drew around the place, or why there is none although one was due.
#[derive(Deserialize, Default)]
pub struct CommentPicture {
    jpeg: Option<String>,
    crop: Option<Value>,
    took_ms: Option<u64>,
    skipped: Option<String>,
}

/// The biggest picture a comment may carry. A crop is at most 800 by 600 CSS
/// pixels at quality 0.7, which comes to tens of kilobytes; anything near this is
/// not what the page's script draws.
const PICTURE_MAX_BYTES: usize = 2 * 1024 * 1024;
const PICTURE_MAX_SIDE: u32 = 4000;

/// The width and height a JPEG says it has, from its first frame header, or
/// nothing when the bytes are not a JPEG this reads cleanly.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[..3] != [0xFF, 0xD8, 0xFF] {
        return None;
    }
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return None;
        }
        let marker = bytes[at + 1];
        if marker == 0xFF {
            at += 1;
            continue;
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        // Start of frame, in any of its codings (not DHT, JPG or DAC, which share the range).
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let frame = bytes.get(at + 4..at + 9)?;
            let height = u32::from(u16::from_be_bytes([frame[1], frame[2]]));
            let width = u32::from(u16::from_be_bytes([frame[3], frame[4]]));
            return (width > 0 && height > 0).then_some((width, height));
        }
        if length < 2 {
            return None;
        }
        at += 2 + length;
    }
    None
}

/// Checks a picture the page drew and saves it beside the review as
/// `review-files/<thread>-r<rev>.jpg`, the name chosen here and never by the
/// page. Returns what the thread records about it, or why there is no picture.
fn keep_picture(log: &Path, id: &str, rev: u64, picture: &CommentPicture) -> Result<Value, String> {
    let jpeg = picture.jpeg.as_deref().ok_or("no picture came with it")?;
    if !jpeg.starts_with("data:image/jpeg;base64,") {
        return Err("the picture was not a JPEG".to_string());
    }
    let bytes = decode_base64(jpeg).ok_or("the picture could not be read")?;
    if bytes.len() > PICTURE_MAX_BYTES {
        return Err("the picture was too big to keep".to_string());
    }
    let (width, height) = jpeg_size(&bytes).ok_or("the picture was not a JPEG")?;
    if width > PICTURE_MAX_SIDE || height > PICTURE_MAX_SIDE {
        return Err("the picture was too big to keep".to_string());
    }
    let crop = page_box(picture.crop.as_ref(), false).ok_or("the picture did not say what it shows")?;
    let folder = log.parent().ok_or("the review has nowhere to live")?.join("review-files");
    std::fs::create_dir_all(&folder).map_err(|e| format!("could not create {}: {e}", folder.display()))?;
    let name = format!("{id}-r{rev}.jpg");
    let file = folder.join(&name);
    std::fs::write(&file, &bytes).map_err(|e| format!("could not write {}: {e}", file.display()))?;
    Ok(json!({
        "file": format!("review-files/{name}"),
        "crop": crop,
        "method": "redraw",
        "took_ms": picture.took_ms.unwrap_or(0).min(600_000),
        "bytes": bytes.len(),
    }))
}

/// A picture a thread keeps, on disk: only a name under this review's own
/// `review-files`, never a path the page could have chosen.
fn picture_file(log: &Path, picture: &Value) -> Option<PathBuf> {
    let name = picture.get("file")?.as_str()?.strip_prefix("review-files/")?;
    let fine = !name.is_empty() && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    fine.then(|| log.parent().map(|dir| dir.join("review-files").join(name))).flatten()
}

/// Opens a thread on the page, or adds a comment to one, in the review at `log`.
/// Local and reversible until the review is sent.
///
/// A new thread keeps the picture the page drew around its place when one came
/// with it. A picture that cannot be kept never stops the comment: the thread
/// records why there is none, and the message says so.
pub fn add_comment(log: &Path, rev: u64, body: &str, anchor: Option<Value>, thread: Option<&str>, picture: Option<CommentPicture>) -> Result<Value, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("a comment needs something in it".to_string());
    }
    let event = match thread {
        Some(id) => json!({"at": now_ms(), "kind": "comment", "id": id, "body": body}),
        None => {
            let id = next_thread_id(log);
            let mut event = json!({"at": now_ms(), "kind": "opened", "id": id, "rev": rev, "anchor": text_anchor(anchor), "body": body});
            if let Some(picture) = picture {
                match (picture.jpeg.is_some(), picture.skipped.as_deref()) {
                    (true, _) => match keep_picture(log, &id, rev, &picture) {
                        Ok(kept) => event["picture"] = kept,
                        Err(reason) => event["picture_skipped"] = json!(reason),
                    },
                    (false, Some(reason)) => event["picture_skipped"] = json!(reason.chars().take(200).collect::<String>()),
                    (false, None) => {}
                }
            }
            event
        }
    };
    append(log, &event)?;
    Ok(view(log))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn review_comment(
    app: AppHandle,
    writes: TauriState<'_, Writes>,
    page: Ref,
    rev: u64,
    body: String,
    anchor: Option<Value>,
    thread: Option<String>,
    picture: Option<CommentPicture>,
) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    blocking(move || add_comment(&log_path(&app, &page)?, rev, &body, anchor, thread.as_deref(), picture)).await
}

/// Takes back a comment that has not been sent. A sent one stays on the record.
/// Its picture goes with it.
pub fn discard(log: &Path, thread: &str) -> Result<Value, String> {
    let current = view(log);
    let Some(draft) = current["threads"].as_array().and_then(|threads| threads.iter().find(|item| item["id"] == thread && item["sent_at"].is_null())) else {
        return Err("that comment has already been sent, so it stays on the record".to_string());
    };
    if let Some(file) = picture_file(log, &draft["picture"]) {
        let _ = std::fs::remove_file(file);
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
    answers_where(log, is_staged_keyed)
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

/// The one message a review sends, with the draft comments and answers it is
/// made of, so what goes out and what is noted as sent cannot drift apart.
/// Composed after the intake has run: of the options, only those it recorded
/// are in it, and every answer in words is.
pub fn draft(dir: &Path, rev: u64, verdict: &str) -> Result<(String, Vec<Value>, Vec<Value>), String> {
    let log = dir.join("review.jsonl");
    let current = view(&log);
    let threads: Vec<Value> = current["threads"]
        .as_array()
        .map(|threads| threads.iter().filter(|thread| thread["sent_at"].is_null()).cloned().collect())
        .unwrap_or_default();
    let answers = answers_where(&log, goes_with_review);
    let revision = revision_record(dir, rev)?;
    // A crewmate's page gets the review through firstmate, as a file, so nothing about where a comment sits is retold.
    let relay = match crew_author(&revision) {
        Some(_) => {
            let folder = dir.join("review-files");
            std::fs::create_dir_all(&folder).map_err(|e| format!("could not create {}: {e}", folder.display()))?;
            let count = current["sent"].as_array().map_or(0, Vec::len);
            let file = folder.join(format!("review-{}.md", count + 1));
            let block = review_block(&revision, verdict, &threads, &log)?;
            std::fs::write(&file, format!("{block}\n")).map_err(|e| format!("could not write {}: {e}", file.display()))?;
            Some(file)
        }
        None => None,
    };
    let text = compose(&revision, verdict, &threads, &answers, &log, relay.as_deref())?;
    Ok((text, threads, answers))
}

/// Records that the draft went, under the id the host gave the message, with the
/// message's first line so the chat can find it again in a resumed conversation.
#[allow(clippy::too_many_arguments)]
pub fn record_sent(log: &Path, verdict: &str, rev: u64, threads: &[Value], answers: &[Value], message: &str, text: &str) -> Result<Value, String> {
    append(
        log,
        &json!({
            "at": now_ms(), "kind": "sent", "verdict": verdict, "rev": rev, "message": message,
            "header": text.lines().next().unwrap_or_default(),
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
        let text = text.clone();
        blocking(move || record_sent(&log, &verdict, rev, &threads, &answers, &message, &text)).await
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
pub async fn answer_one(home: &Path, log: Option<&Path>, keyed: &Keyed, asked: Option<&str>) -> Result<Value, String> {
    let outcomes = match log {
        Some(log) => {
            let (log_at, staged, asked) = (log.to_path_buf(), keyed.clone(), asked.map(str::to_string));
            blocking(move || stage_answer(&log_at, &staged.call, Some(&staged.key), Some(&staged.label), Some(&staged.on_answer), &Words::default(), asked.as_deref())).await?;
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
    asked: Option<String>,
) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    let home = home_for(&app)?;
    let keyed = Keyed { call: call.clone(), key: option.clone(), label: label.clone(), on_answer: on_answer.clone() };
    let log = match page {
        Some(page) => Some(blocking(move || log_path(&app, &page)).await?),
        None => None,
    };
    let outcome = answer_one(&home, log.as_deref(), &keyed, asked.as_deref()).await?;
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
/// comments are open and on which revision, which held tasks it has answered,
/// and each review sent with the comments it carried, for the chat. Only what
/// the list, the calls and the chat need, so it stays one cheap read per page.
pub fn summary(data: &Path) -> Value {
    let mut pages = serde_json::Map::new();
    let mut add = |key: String, log: PathBuf| {
        if !log.is_file() {
            return;
        }
        let current = view(&log);
        let answered: Vec<&str> = current["answers"]
            .as_array()
            .map(|answers| answers.iter().filter(|answer| is_recorded(answer)).filter_map(|answer| answer["decision"].as_str()).collect())
            .unwrap_or_default();
        // Handed to the first mate, and when: it holds only until the call is put again after that.
        let handed: serde_json::Map<String, Value> = current["answers"]
            .as_array()
            .map(|answers| {
                answers
                    .iter()
                    .filter(|answer| is_handed(answer))
                    .filter_map(|answer| Some((answer["decision"].as_str()?.to_string(), answer["sent_at"].clone())))
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
        // Each review sent, and each comment it carried as the chat shows it, so the chat can draw a review as the
        // thing it is: what was said where, whether a revision has answered it, and whether it is settled.
        let threads: Vec<Value> = current["threads"]
            .as_array()
            .map(|threads| {
                threads
                    .iter()
                    .filter(|thread| !thread["sent_at"].is_null())
                    .map(|thread| {
                        json!({
                            "id": thread["id"], "rev": thread["rev"], "state": thread["state"],
                            "quote": shorten(thread["anchor"]["quote"].as_str().unwrap_or_default(), 160),
                            "said": shorten(&thread_words(thread), 400),
                            "picture": !thread["picture"].is_null(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let labels: Vec<Value> = [&current["answers"], &current["earlier"]].iter().flat_map(|list| list.as_array().cloned().unwrap_or_default()).collect();
        let sent: Vec<Value> = current["sent"]
            .as_array()
            .map(|sent| {
                sent.iter()
                    .map(|review| {
                        let carried: Vec<Value> = review["answers"]
                            .as_array()
                            .map(|decisions| {
                                decisions
                                    .iter()
                                    .filter_map(|decision| {
                                        let said = |answer: &&Value| answer["decision"] == *decision;
                                        labels.iter().filter(said).find(|answer| answer["sent_at"] == review["at"]).or_else(|| labels.iter().find(said))
                                    })
                                    .map(|answer| json!({"decision": answer["decision"], "option": answer["option"], "label": answer["label"], "note": answer["note"], "defer": answer["defer"]}))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let mut review = review.clone();
                        review["answers"] = json!(carried);
                        review
                    })
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
                "handed": handed,
                "open_threads": open_threads,
                "sent": sent,
                "threads": threads,
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

/// Stages the captain's answer to a call this page argues: one of its options,
/// with anything they added in `words.note`, or, with no option, the note alone
/// or a date to be asked again on. Nothing at all takes the answer back.
/// `on_answer` is what the call declares, handed to the intake as it is.
/// Nothing is recorded until the review is sent; once the intake has recorded
/// it, or an answer in words has gone to the first mate, it is on the record,
/// and changing it is a new conversation with the first mate, not an edit,
/// until the call is put again after the answer went: `asked` is the call's
/// `updated_at` as the captain saw it. An answer the intake skipped can be
/// chosen again.
pub fn stage_answer(log: &Path, decision: &str, option: Option<&str>, label: Option<&str>, on_answer: Option<&str>, words: &Words, asked: Option<&str>) -> Result<Value, String> {
    if !artifact::valid_task_id(decision) {
        return Err("that is not a task".to_string());
    }
    let note = words.note.as_deref().map(str::trim).filter(|note| !note.is_empty());
    if note.is_some_and(|note| note.chars().count() > WORDS_LIMIT) {
        return Err(format!("an answer in words is kept under {WORDS_LIMIT} characters"));
    }
    let defer = words.defer.as_deref().filter(|date| !date.is_empty());
    if let Some(date) = defer {
        if option.is_some() {
            return Err("not now is an answer of its own, not one added to an option".to_string());
        }
        let plain = date.len() == 10 && date.chars().enumerate().all(|(at, c)| if at == 4 || at == 7 { c == '-' } else { c.is_ascii_digit() });
        if !plain {
            return Err(format!("'{date}' is not a date"));
        }
    }
    let asked = asked.and_then(iso_ms);
    let already = view(log)["answers"]
        .as_array()
        .is_some_and(|answers| answers.iter().any(|answer| answer["decision"] == decision && locked(answer, asked)));
    if already {
        return Err("that answer is already on the record; tell the first mate in chat if you have changed your mind".to_string());
    }
    let mut event = json!({"at": now_ms(), "kind": "answer", "decision": decision, "option": option, "label": label, "on_answer": on_answer});
    if let Some(note) = note {
        event["note"] = json!(note);
    }
    if let Some(date) = defer {
        event["defer"] = json!(date);
    }
    if let Some(asked) = asked {
        event["asked"] = json!(asked);
    }
    append(log, &event)?;
    Ok(view(log))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn review_answer(
    app: AppHandle,
    writes: TauriState<'_, Writes>,
    page: Ref,
    decision: String,
    option: Option<String>,
    label: Option<String>,
    on_answer: Option<String>,
    words: Option<Words>,
    asked: Option<String>,
) -> Result<Value, String> {
    let _one_writer = writes.0.lock().await;
    let words = words.unwrap_or_default();
    blocking(move || stage_answer(&log_path(&app, &page)?, &decision, option.as_deref(), label.as_deref(), on_answer.as_deref(), &words, asked.as_deref())).await
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
///
/// Settling lets a thread's picture go, unless the words it was written on are
/// no longer in the latest revision: then the picture is the only record of what
/// the comment was about, and it stays.
pub fn settle(log: &Path, thread: &str, resolved: bool) -> Result<Value, String> {
    let current = view(log);
    let Some(sent) = current["threads"].as_array().and_then(|threads| threads.iter().find(|item| item["id"] == thread && !item["sent_at"].is_null())) else {
        return Err("that comment has not been sent yet".to_string());
    };
    let kind = if resolved { "resolved" } else { "reopened" };
    append(log, &json!({"at": now_ms(), "kind": kind, "id": thread}))?;
    if resolved {
        let quote = sent["anchor"]["quote"].as_str().unwrap_or_default();
        if let Some(file) = picture_file(log, &sent["picture"]) {
            if log.parent().is_some_and(|dir| words_in_latest(dir, quote)) {
                let _ = std::fs::remove_file(file);
            }
        }
    }
    Ok(view(log))
}

/// Whether the words a comment was written on are still in the newest complete
/// revision's page, as text or in the script that writes it. Any doubt says
/// they are gone, which keeps the picture.
fn words_in_latest(dir: &Path, quote: &str) -> bool {
    let words = shorten(quote, usize::MAX);
    if words.is_empty() {
        return false;
    }
    let newest = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.strip_prefix("rev-")?.parse::<u64>().ok())
        .filter(|rev| dir.join(format!("rev-{rev}")).join("revision.json").is_file())
        .max();
    let Some(rev) = newest else { return false };
    let Ok(revision) = revision_record(dir, rev) else { return false };
    let Some(entry) = revision.get("entry").and_then(Value::as_str) else { return false };
    let Ok(page) = std::fs::read_to_string(dir.join(format!("rev-{rev}")).join("files").join(entry)) else { return false };
    shorten(&page, usize::MAX).contains(&words) || shorten(&strip_tags(&page), usize::MAX).contains(&words)
}

/// A page's text with its tags taken out, near enough to find a quote in.
fn strip_tags(page: &str) -> String {
    let mut out = String::with_capacity(page.len());
    let mut inside = false;
    for character in page.chars() {
        match character {
            '<' => inside = true,
            '>' if inside => {
                inside = false;
                out.push(' ');
            }
            _ if !inside => out.push(character),
            _ => {}
        }
    }
    out
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
        assert!(stage_answer(&path, "res-model", None, None, None, &Words::default(), None).is_err());
        assert!(stage_answer(&path, "res-model", Some("eager"), Some("Keep downloading eagerly"), Some("done"), &Words::default(), None).is_err());
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
        let current = add_comment(&path, 1, "Say more.", Some(forged), None, None).unwrap();
        let anchor = &current["threads"][0]["anchor"];
        assert_eq!(anchor["quote"], "Intro");
        for key in ["scene", "scene_file", "picture", "preview"] {
            assert!(anchor.get(key).is_none(), "{key} survived: {anchor}");
        }
        let text = compose(&json!({"scope": "chat", "rev": 1, "title": "t"}), "comment", current["threads"].as_array().unwrap(), &[], &path, None).unwrap();
        assert!(!text.contains("id_rsa"), "{text}");
        // Nothing to quote is a comment on the page as a whole.
        let current = add_comment(&path, 1, "Overall.", Some(json!({"quote": ""})), None, None).unwrap();
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
        let text = compose(&revision, "changes", &threads, &[], Path::new("/home/data/res-titles-scout/artifacts/titles-plan/review.jsonl"), None).unwrap();
        assert!(text.starts_with("Captain's review of \"AI titles for snips\" (task res-titles-scout, rev 2): Requests changes.\n"), "{text}");
        assert!(text.contains("Written by res-titles-scout. Relay this review to it unchanged."), "{text}");
        assert!(text.contains("/home/data/res-titles-scout/artifacts/titles-plan/review.jsonl"), "{text}");
        assert!(text.contains("t1 on \"Runs after transcription, free, private.\": Say what happens on an older phone. And on a metered hotspot."), "{text}");
        assert!(text.contains("t2 on \"a very long quote"), "{text}");
        assert!(text.contains("…\" (rev 1): Still open from the last round."), "{text}");

        let chat = json!({"scope": "chat", "task": null, "rev": 1, "title": "A decision", "presented_by": {"role": "firstmate"}});
        let text = compose(&chat, "approve", &[], &[], Path::new("/home/data/.artifacts/a/review.jsonl"), None).unwrap();
        assert!(text.contains("(shared in chat, rev 1): Approved."), "{text}");
        assert!(text.contains("Written by you."), "{text}");
        assert!(text.contains("No comments on the page itself."), "{text}");
        assert!(compose(&chat, "merge", &[], &[], Path::new("/x"), None).is_err());

        // An answer the intake recorded is stated as done, so the first mate follows up instead of recording it.
        let answers = vec![json!({"decision": "res-model-download", "option": "wifi-only", "label": "Wi-Fi only, with visible progress"})];
        let text = compose(&chat, "approve", &[], &answers, Path::new("/home/data/.artifacts/a/review.jsonl"), None).unwrap();
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
        stage_answer(&log, "res-model-download", Some("wifi-only"), Some("Wi-Fi only"), Some("done"), &Words::default(), None).unwrap();
        stage_answer(&log, "res-model-cellular", Some("pause"), Some("Pause until Wi-Fi"), Some("release"), &Words::default(), None).unwrap();
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
        record_sent(&log, "comment", 1, &threads, &told, "out-1", "A review").unwrap();
        let current = view(&log);
        assert_eq!(current["staged_answers"], 0);
        assert_eq!(summary(&home.join("data"))["chat/board"]["answered"], json!(["res-model-download"]));

        // A recorded answer is on the record; a skipped one can be chosen again, and goes to the intake again.
        assert!(stage_answer(&log, "res-model-download", Some("prompt"), Some("Ask"), Some("done"), &Words::default(), None).is_err());
        stage_answer(&log, "res-model-cellular", Some("finish"), Some("Finish on cellular"), Some("done"), &Words::default(), None).unwrap();
        assert_eq!(staged(&log).len(), 1);
        assert_eq!(staged(&log)[0].key, "finish");
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn an_answer_in_words_goes_with_the_review_for_the_first_mate_to_record() {
        let home = home_with_intake("intake-words", "closed: res-model-download recorded; closed");
        let dir = home.join("data/.artifacts/board");
        revision_on_disk(&dir);
        let log = dir.join("review.jsonl");
        let words = |note: Option<&str>, defer: Option<&str>| Words { note: note.map(str::to_string), defer: defer.map(str::to_string) };
        // An option with something added, words alone, and not now until a date: three ways to answer a call.
        stage_answer(&log, "res-model-download", Some("wifi-only"), Some("Wi-Fi only"), Some("done"), &words(Some(" Say so in Settings. "), None), None).unwrap();
        stage_answer(&log, "res-model-cellular", None, None, Some("done"), &words(Some("Pause, but tell the user why."), None), None).unwrap();
        stage_answer(&log, "res-transcripts-source", None, None, Some("release"), &words(None, Some("2026-10-03")), None).unwrap();
        let current = view(&log);
        assert_eq!(current["staged_answers"], 3);
        assert_eq!(current["answers"][0]["note"], "Say so in Settings.");
        assert_eq!(current["answers"][2]["defer"], "2026-10-03");
        // Not now is its own answer, a date is a date, and nothing said is nothing staged.
        assert!(stage_answer(&log, "res-other", Some("x"), Some("X"), None, &words(None, Some("2026-10-03")), None).is_err());
        assert!(stage_answer(&log, "res-other", None, None, None, &words(None, Some("next week")), None).is_err());
        stage_answer(&log, "res-other", None, None, None, &words(Some("   "), None), None).unwrap();
        assert_eq!(view(&log)["staged_answers"], 3);

        // Only the option goes to the intake: it takes keys, and words have none.
        assert_eq!(staged(&log).iter().map(|answer| answer.call.as_str()).collect::<Vec<_>>(), ["res-model-download"]);
        record_staged(&home, &log, None).await.unwrap();
        assert_eq!(std::fs::read_to_string(home.join("fed")).unwrap(), "res-model-download\twifi-only\tWi-Fi only\tdone\n");

        let (text, threads, carried) = draft(&dir, 1, "approve").unwrap();
        assert!(text.contains("\nRecorded: res-model-download = wifi-only (\"Wi-Fi only\")\n  The captain added: Say so in Settings."), "{text}");
        assert!(text.contains("\nAnswered in words, which nothing has recorded yet; record each with bin/fm-captain-hold.sh"), "{text}");
        assert!(text.contains("\nres-model-cellular: Pause, but tell the user why."), "{text}");
        assert!(text.contains("\nres-transcripts-source: Not now. Ask me again on 2026-10-03."), "{text}");
        assert_eq!(carried.len(), 3);
        record_sent(&log, "approve", 1, &threads, &carried, "out-1", &text).unwrap();

        // Sent, an answer in words is on the record like a recorded one: the page and Bearings both say it went.
        let current = view(&log);
        assert_eq!(current["staged_answers"], 0);
        assert!(stage_answer(&log, "res-model-cellular", None, None, None, &words(Some("Changed my mind"), None), None).is_err());
        let page = &summary(&home.join("data"))["chat/board"];
        assert_eq!(page["answered"], json!(["res-model-download"]));
        let sent_at = current["answers"][1]["sent_at"].clone();
        assert!(sent_at.is_u64());
        assert_eq!(page["handed"], json!({"res-model-cellular": sent_at, "res-transcripts-source": sent_at}));
        assert_eq!(page["sent"][0]["answers"][1], json!({"decision": "res-model-cellular", "option": null, "label": null, "note": "Pause, but tell the user why.", "defer": null}));

        // A call put again only before the answer went is still answered by it.
        assert!(stage_answer(&log, "res-model-cellular", None, None, None, &words(Some("Changed my mind"), None), Some("2000-01-01T00:00:00Z")).is_err());
        // A call put again after it is open again: words and a dated not now alike can be answered anew,
        // and what was said then stays in the log and in the review that carried it.
        stage_answer(&log, "res-model-cellular", None, None, None, &words(Some("Finish on cellular after all."), None), Some("2999-01-01T00:00:00Z")).unwrap();
        stage_answer(&log, "res-transcripts-source", None, None, None, &words(None, Some("2026-11-01")), Some("2999-01-01T00:00:00Z")).unwrap();
        let current = view(&log);
        assert_eq!(current["staged_answers"], 2);
        let answer = |call: &str| current["answers"].as_array().unwrap().iter().find(|a| a["decision"] == call).unwrap().clone();
        assert_eq!(answer("res-model-cellular")["note"], "Finish on cellular after all.");
        assert_eq!(answer("res-model-cellular")["sent_at"], Value::Null);
        assert_eq!(answer("res-transcripts-source")["defer"], "2026-11-01");
        assert_eq!(current["earlier"].as_array().unwrap().iter().map(|a| (a["decision"].clone(), a["note"].clone(), a["defer"].clone())).collect::<Vec<_>>(), [
            (json!("res-model-cellular"), json!("Pause, but tell the user why."), Value::Null),
            (json!("res-transcripts-source"), Value::Null, json!("2026-10-03")),
        ]);
        let page = &summary(&home.join("data"))["chat/board"];
        assert_eq!(page["handed"], json!({}));
        assert_eq!(page["sent"][0]["answers"][1]["note"], "Pause, but tell the user why.");
        assert_eq!(page["sent"][0]["answers"][2]["defer"], "2026-10-03");
        // The answer again goes with the next review.
        let (text, threads, carried) = draft(&dir, 1, "comment").unwrap();
        assert!(text.contains("\nres-model-cellular: Finish on cellular after all."), "{text}");
        assert!(text.contains("\nres-transcripts-source: Not now. Ask me again on 2026-11-01."), "{text}");
        record_sent(&log, "comment", 1, &threads, &carried, "out-2", &text).unwrap();
        let page = &summary(&home.join("data"))["chat/board"];
        assert_eq!(page["sent"][1]["answers"][0]["note"], "Finish on cellular after all.");
        assert_eq!(page["sent"][0]["answers"][1]["note"], "Pause, but tell the user why.");

        // A recorded answer stays on the record however new the call is.
        assert!(stage_answer(&log, "res-model-download", Some("prompt"), Some("Ask"), Some("done"), &Words::default(), Some("2999-01-01T00:00:00Z")).is_err());
        assert_eq!(view(&log)["answers"][0]["option"], "wifi-only");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_call_stamp_reads_as_ms_since_the_epoch() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2026-09-25T12:34:56Z"), Some(1_790_339_696_000));
        assert_eq!(iso_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
        assert_eq!(iso_ms("2026-09-25"), None);
        assert_eq!(iso_ms("2026-13-25T12:34:56Z"), None);
        assert_eq!(iso_ms("2026-09-25T12:34:56+01:00"), None);
    }

    #[tokio::test]
    async fn a_bearings_answer_runs_the_intake_for_that_call_alone() {
        let home = home_with_intake("intake-one", "closed: res-transcripts-source recorded; released");
        let dir = home.join("data/.artifacts/board");
        let log = dir.join("review.jsonl");
        // Something else staged on the same page stays staged for its review.
        stage_answer(&log, "res-model-download", Some("wifi-only"), Some("Wi-Fi only"), Some("done"), &Words::default(), None).unwrap();
        let keyed = Keyed { call: "res-transcripts-source".into(), key: "publisher-first".into(), label: "Publisher first".into(), on_answer: "release".into() };
        let outcome = answer_one(&home, Some(&log), &keyed, None).await.unwrap();
        assert_eq!(outcome["result"], "closed");
        assert_eq!(std::fs::read_to_string(home.join("fed")).unwrap(), "res-transcripts-source\tpublisher-first\tPublisher first\trelease\n");
        assert_eq!(staged(&log).iter().map(|answer| answer.call.as_str()).collect::<Vec<_>>(), ["res-model-download"]);

        // With no page, nothing is written to any review, and the outcome is the intake's word alone.
        let unargued = Keyed { call: "foreman-auto-merge".into(), key: "keep".into(), label: "Keep merging".into(), on_answer: "done".into() };
        let outcome = answer_one(&home, None, &unargued, None).await.unwrap();
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
        assert_eq!(summary(&data)["chat/board"]["handed"], json!({"res-model": 4}));
        append(&chat.join("review.jsonl"), &json!({"at": 5, "kind": "recorded", "decision": "res-model", "result": "closed", "detail": "recorded"})).unwrap();
        assert_eq!(summary(&data)["chat/board"]["answered"], json!(["res-model"]));
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
        let text = compose(&revision, "changes", &threads, &[], Path::new("/home/data/.artifacts/a/review.jsonl"), None).unwrap();
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

    /// A JPEG header this reads a size from: start of image, a frame of `width` by `height`, end of image.
    fn tiny_jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
        bytes.extend([0xFF, 0xC0, 0x00, 0x11, 0x08]);
        bytes.extend(height.to_be_bytes());
        bytes.extend(width.to_be_bytes());
        bytes.extend([0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        bytes.extend([0xFF, 0xD9]);
        bytes
    }

    fn data_url(kind: &str, bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
            for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
                out.push(if index <= chunk.len() { ALPHABET[((n >> shift) & 63) as usize] as char } else { '=' });
            }
        }
        format!("data:image/{kind};base64,{out}")
    }

    fn picture(jpeg: String) -> Option<CommentPicture> {
        Some(CommentPicture { jpeg: Some(jpeg), crop: Some(json!({"x": 350, "y": 515, "w": 337, "h": 255})), took_ms: Some(145), skipped: None })
    }

    /// The captain's t2 on the usage panel's first revision, exactly as the page now describes it: the words
    /// appear twice on screen, and the place is inside the Claude row, which is shut when the page opens.
    fn t2_anchor() -> Value {
        json!({
            "quote": "under pace: lasts past the reset",
            "prefix": "esets in 1h 35m5h 20%wk 17%Fable wk 0%5h",
            "suffix": "resets 1h 35mwkunder pace: lasts past th",
            "path": "div:nth-of-type(2) > div:nth-of-type(2) > div:nth-of-type(2) > dl:nth-of-type(1) > dd:nth-of-type(1)",
            "occurrence": {"n": 1, "of": 4, "shown": 2},
            "element": "div#pop.pop > div.pop-body > div.sect > div.prov.open[data-prov=claude] > div.detail > dl > dd",
            "near": "Usage › Plan limits › Claude › 5h",
            "box": {"x": 460, "y": 625, "w": 117, "h": 35},
            "point": {"x": 518, "y": 642},
            "view": {"w": 1280, "h": 900, "scroll_y": 0, "scheme": "light"},
            "reasons": ["repeated", "opened"],
        })
    }

    /// A crewmate's page with one revision, whose page holds the words given.
    fn crew_page(name: &str, words: &str) -> (PathBuf, PathBuf) {
        let dir = scratch(name).join("qd-usage-design-1/artifacts/usage-panel");
        std::fs::create_dir_all(dir.join("rev-1/files")).unwrap();
        std::fs::write(dir.join("rev-1/files/usage-panel.html"), format!("<dl><dt>5h</dt><dd>{words}</dd></dl>")).unwrap();
        std::fs::write(
            dir.join("rev-1/revision.json"),
            json!({"scope": "task", "task": "qd-usage-design-1", "rev": 1, "title": "Usage panel: context and plan limits", "entry": "usage-panel.html", "presented_by": {"role": "crew", "task": "qd-usage-design-1"}}).to_string(),
        )
        .unwrap();
        let log = dir.join("review.jsonl");
        (dir, log)
    }

    #[test]
    fn the_captains_t2_reaches_the_crewmate_saying_which_row_and_how_to_see_it() {
        let (dir, log) = crew_page("t2", "under pace: lasts past the reset");
        let current = add_comment(&log, 1, "what does underpace mean? is this really helpful? I think can remove this column for simplicity?", Some(t2_anchor()), None, picture(data_url("jpeg", &tiny_jpeg(337, 255)))).unwrap();
        let thread = &current["threads"][0];
        assert_eq!(thread["picture"]["file"], "review-files/t1-r1.jpg");
        assert_eq!(thread["picture"]["method"], "redraw");
        assert!(dir.join("review-files/t1-r1.jpg").is_file(), "the picture is kept beside the review");
        assert_eq!(thread["anchor"]["occurrence"], json!({"n": 1, "of": 4, "shown": 2}));

        let (text, _, _) = draft(&dir, 1, "changes").unwrap();
        let relay = dir.join("review-files/review-1.md");
        let block = std::fs::read_to_string(&relay).expect("the review the crewmate receives is a file");
        // The first mate is told to pass the file on, not to retell it.
        assert!(text.contains(&format!("bin/fm-send.sh qd-usage-design-1 \"$(cat '{}')\"", relay.display())), "{text}");
        assert!(text.contains("Add any framing of your own in a separate message."), "{text}");
        assert!(!block.contains("Relay this review"), "the crewmate's copy carries no instructions meant for the first mate: {block}");
        for said in [&text, &block] {
            // Which row: the second of two identical cells on screen is a different row.
            assert!(said.contains("t1 on \"under pace: lasts past the reset\": what does underpace mean?"), "{said}");
            assert!(said.contains("  match    1 of the 4 places these words appear in the page's text, 2 of them on screen"), "{said}");
            assert!(said.contains("  near     Usage › Plan limits › Claude › 5h"), "{said}");
            // How to see it: the Claude row has to be opened, and the picture shows it open.
            assert!(said.contains("  element  div#pop.pop > div.pop-body > div.sect > div.prov.open[data-prov=claude] > div.detail > dl > dd"), "{said}");
            assert!(said.contains(&format!("The page: {}", dir.join("rev-1/files/usage-panel.html").display())), "{said}");
            assert!(said.contains(&format!("  picture  {}", dir.join("review-files/t1-r1.jpg").display())), "{said}");
            assert!(said.contains("Look at it before acting: the words appear in more than one place on screen; the place was inside something the captain had opened"), "{said}");
            // Honest about what the picture is.
            assert!(said.contains("It is a redraw the page made of itself when the captain picked the place, not a screenshot of the captain's screen."), "{said}");
            assert!(said.contains("  box      x 460, y 625, 117 × 35 CSS px, in a 1280 × 900 window scrolled to 0, on a light page"), "{said}");
            assert!(!said.contains("nth-of-type"), "the positional path stays in the log: {said}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_page_cannot_put_anything_else_in_an_anchor() {
        let kept = text_anchor(Some(json!({
            "quote": "Intro", "prefix": "", "suffix": "", "path": "h1",
            "occurrence": {"n": 5, "of": 2}, "box": {"x": "0", "y": 1, "w": 2, "h": 3},
            "point": {"x": 1e30, "y": 2}, "view": {"w": 1, "h": 1, "scroll_y": 0, "scheme": "purple"},
            "reasons": ["repeated", "rm -rf"], "element": "x".repeat(5000), "near": "",
        })));
        assert!(kept.get("occurrence").is_none(), "a match past the count is not a match: {kept}");
        assert!(kept.get("box").is_none() && kept.get("point").is_none() && kept.get("view").is_none(), "{kept}");
        assert_eq!(kept["reasons"], json!(["repeated"]));
        assert_eq!(kept["element"].as_str().unwrap().len(), 600);
        assert!(kept.get("near").is_none());
    }

    #[test]
    fn only_a_jpeg_of_a_sensible_size_is_kept_and_the_comment_goes_either_way() {
        let (dir, log) = crew_page("picture-refused", "Intro");
        let refused = [
            data_url("png", &tiny_jpeg(10, 10)),
            data_url("jpeg", b"not a picture at all"),
            data_url("jpeg", &tiny_jpeg(4001, 10)),
        ];
        for (index, jpeg) in refused.into_iter().enumerate() {
            let current = add_comment(&log, 1, "Say more.", Some(json!({"quote": "Intro"})), None, picture(jpeg)).unwrap();
            let thread = &current["threads"][index];
            assert!(thread["picture"].is_null(), "{thread}");
            assert!(thread["picture_skipped"].as_str().is_some_and(|reason| !reason.is_empty()), "{thread}");
        }
        assert!(!dir.join("review-files").exists() || std::fs::read_dir(dir.join("review-files")).unwrap().next().is_none(), "nothing refused is written");
        let skipped = add_comment(&log, 1, "Again.", Some(json!({"quote": "Intro"})), None, Some(CommentPicture { skipped: Some("the page could not draw itself".into()), ..Default::default() })).unwrap();
        let text = compose(&json!({"scope": "chat", "rev": 1, "title": "t"}), "comment", &skipped["threads"].as_array().unwrap()[3..], &[], &log, None).unwrap();
        assert!(text.contains("  picture  none (the page could not draw itself)"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_picture_goes_with_a_discarded_draft_and_with_a_settled_thread_whose_words_remain() {
        let (dir, log) = crew_page("picture-life", "under pace: lasts past the reset");
        let jpeg = || picture(data_url("jpeg", &tiny_jpeg(20, 20)));
        add_comment(&log, 1, "Taken back.", Some(t2_anchor()), None, jpeg()).unwrap();
        discard(&log, "t1").unwrap();
        assert!(!dir.join("review-files/t1-r1.jpg").exists(), "a comment taken back takes its picture with it");

        add_comment(&log, 1, "Still there.", Some(t2_anchor()), None, jpeg()).unwrap();
        add_comment(&log, 1, "Gone later.", Some(json!({"quote": "a column that was cut"})), None, jpeg()).unwrap();
        append(&log, &json!({"at": 5, "kind": "sent", "verdict": "changes", "rev": 1, "threads": ["t2", "t3"], "message": "m"})).unwrap();
        let current = settle(&log, "t2", true).unwrap();
        assert!(!dir.join("review-files/t2-r1.jpg").exists(), "the words are still on the page, so the picture has done its job");
        assert!(current["threads"][0]["picture"].is_null(), "a picture let go reads as none");
        settle(&log, "t3", true).unwrap();
        assert!(dir.join("review-files/t3-r1.jpg").is_file(), "the words are gone, so the picture is the only record of what the comment was about");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_anchor_from_before_the_page_described_itself_says_only_its_words() {
        let log = scratch("old-anchor").join("review.jsonl");
        let current = add_comment(&log, 1, "Say more.", Some(anchor("Wi-Fi only")), None, None).unwrap();
        let text = compose(&json!({"scope": "chat", "rev": 1, "title": "t"}), "comment", current["threads"].as_array().unwrap(), &[], &log, None).unwrap();
        assert!(text.contains("t1 on \"Wi-Fi only\": Say more."), "{text}");
        for absent in ["  match", "  element", "  near", "  box", "  picture"] {
            assert!(!text.contains(absent), "{absent} in {text}");
        }
    }

    #[test]
    fn the_summary_gives_the_chat_each_review_as_it_went() {
        let (dir, log) = crew_page("chat-card", "under pace: lasts past the reset");
        add_comment(&log, 1, "what does underpace mean?", Some(t2_anchor()), None, picture(data_url("jpeg", &tiny_jpeg(20, 20)))).unwrap();
        stage_answer(&log, "qd-usage-design-1", Some("strip"), Some("One quiet strip in the sidebar footer"), Some("release"), &Words::default(), None).unwrap();
        append(&log, &json!({"at": 2, "kind": "recorded", "decision": "qd-usage-design-1", "result": "closed", "detail": ""})).unwrap();
        let (text, threads, told) = draft(&dir, 1, "changes").unwrap();
        record_sent(&log, "changes", 1, &threads, &told, "m1790147648486-20", &text).unwrap();
        let data = dir.parent().unwrap().parent().unwrap().parent().unwrap();
        let page = &summary(data)["task/qd-usage-design-1/usage-panel"];
        let sent = &page["sent"][0];
        assert_eq!(sent["message"], "m1790147648486-20");
        assert_eq!(sent["header"], "Captain's review of \"Usage panel: context and plan limits\" (task qd-usage-design-1, rev 1): Requests changes.");
        assert_eq!(sent["threads"], json!(["t1"]));
        assert_eq!(sent["answers"], json!([{"decision": "qd-usage-design-1", "option": "strip", "label": "One quiet strip in the sidebar footer", "note": null, "defer": null}]));
        assert_eq!(page["threads"][0], json!({"id": "t1", "rev": 1, "state": "open", "quote": "under pace: lasts past the reset", "said": "what does underpace mean?", "picture": true}));
        let _ = std::fs::remove_dir_all(data);
    }
}
