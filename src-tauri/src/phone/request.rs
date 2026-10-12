//! What a paired phone may ask the Mac, and how each ask is answered.
//!
//! Every answer goes through the same path the desktop's own screen takes for
//! the same thing: an answer is `review::answer_call`, the very body of
//! `call_answer`; words on a call are `review::reply_and_tell`; a review is
//! `review::submit`. Nothing here records, closes, delivers or decides anything
//! the desktop path would not.

use super::desk::Desk;
use crate::calls::Keyed;
use crate::host::Tell;
use crate::review;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Everything a paired phone can ask for. There is nothing else: a frame that
/// does not read as one of these is refused, and no variant carries a command,
/// a script, a path to run or a message for anything but the first mate.
///
/// This is the reason a phone can never become a second host. The Mac runs one
/// first mate session under the home's lock, and a second host contending for
/// that lock breaks the session that is running. So no variant may start,
/// stop, restart or reconfigure the first mate, take the session lock, run the
/// engine beyond the intake an answer or a review already runs on the desktop
/// (`fm-captain-hold.sh answers` and `reply`, `fm-artifact.sh deliver-review`),
/// or dispatch work (`fm-spawn.sh`, `fm-brief.sh`, Start work, taking an issue
/// on). The handlers are given a [`Desk`], which holds no way to do any of
/// that, and `phone::tests` drives every variant against a home whose every
/// script records being run and a host that records every command, and fails
/// if a variant reaches anything outside that list.
///
/// The four journeys the captain approved, and nothing more:
/// - a call needs him: [`PhoneRequest::Board`], with crew state only as a glance;
/// - he answers it: [`PhoneRequest::AnswerCall`] by option, [`PhoneRequest::ReplyToCall`] in words;
/// - he reads the page that argues it and sends a review: [`PhoneRequest::Page`],
///   [`PhoneRequest::Review`], [`PhoneRequest::Comment`], [`PhoneRequest::Discard`],
///   [`PhoneRequest::SendReview`];
/// - he has a word with the first mate: [`PhoneRequest::Chat`], [`PhoneRequest::Say`].
///
/// Adding a variant means arguing, here, that it cannot do any of the above,
/// and adding it to the list `phone::tests` holds; that test fails until then.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "ask", rename_all = "snake_case", deny_unknown_fields)]
pub enum PhoneRequest {
    /// The open calls, the presented pages that may argue them, and a glance at the crew.
    Board,
    /// Answer a call with one of its options, through firstmate's own intake.
    /// The label and how the call closes are read from the call itself.
    AnswerCall { call: String, option: String, page: Option<PageRef>, note: Option<String> },
    /// The captain's words on a call, kept on it by firstmate before the first mate is told.
    ReplyToCall { call: String, words: String },
    /// One file of a presented revision, its entry page when no file is named.
    Page { page: PageRef, rev: u64, file: Option<String> },
    /// A page's review as the desktop's review screen reads it.
    Review { page: PageRef },
    /// A comment on a page, kept as a draft until the review is sent.
    Comment { page: PageRef, rev: u64, body: String, anchor: Option<Value>, thread: Option<String> },
    /// Take back a draft comment.
    Discard { page: PageRef, thread: String },
    /// Send the review with a verdict, as the desktop's Send review does.
    SendReview { page: PageRef, rev: u64, verdict: String },
    /// The recent conversation with the first mate.
    Chat { limit: Option<u32> },
    /// A message to the first mate in the captain's words. A reply to a place in
    /// the chat arrives already carrying the block `src/replyto.ts` writes.
    Say { text: String },
}

impl PhoneRequest {
    /// Its name on the wire.
    #[cfg(test)]
    pub fn kind(&self) -> &'static str {
        match self {
            PhoneRequest::Board => "board",
            PhoneRequest::AnswerCall { .. } => "answer_call",
            PhoneRequest::ReplyToCall { .. } => "reply_to_call",
            PhoneRequest::Page { .. } => "page",
            PhoneRequest::Review { .. } => "review",
            PhoneRequest::Comment { .. } => "comment",
            PhoneRequest::Discard { .. } => "discard",
            PhoneRequest::SendReview { .. } => "send_review",
            PhoneRequest::Chat { .. } => "chat",
            PhoneRequest::Say { .. } => "say",
        }
    }
}

/// Which page: the same three parts the desktop's review screen holds.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PageRef {
    pub scope: String,
    pub task: Option<String>,
    pub name: String,
}

/// One frame from the phone: a request id it chose, and the request.
pub fn parse(payload: &[u8]) -> Result<(u64, PhoneRequest), (Option<u64>, String)> {
    let mut value: Value = serde_json::from_slice(payload).map_err(|_| (None, "that is not a request".to_string()))?;
    let id = value.get("id").and_then(Value::as_u64);
    let Some(id) = id else { return Err((None, "a request needs a numeric id".to_string())) };
    if let Some(object) = value.as_object_mut() {
        object.remove("id");
    }
    let request: PhoneRequest = serde_json::from_value(value.clone()).map_err(|e| (Some(id), format!("that is not something a phone can ask: {e}")))?;
    // serde lets an unknown field through on a tagged unit variant, so every
    // field asked must be one the request itself has.
    let known = serde_json::to_value(&request).unwrap_or(Value::Null);
    let asked = value.as_object().map(|asked| asked.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
    if let Some(extra) = asked.iter().find(|key| known.get(key.as_str()).is_none()) {
        return Err((Some(id), format!("that is not something a phone can ask: no request has `{extra}`")));
    }
    Ok((id, request))
}

/// The answer to one request, as the phone reads it.
pub fn answered(id: u64, result: Result<Value, String>) -> Value {
    match result {
        Ok(result) => json!({"id": id, "ok": true, "result": result}),
        Err(problem) => json!({"id": id, "ok": false, "problem": problem}),
    }
}

/// The longest page file sent over the link.
const PAGE_LIMIT: u64 = 16 * 1024 * 1024;
/// The longest message the phone may send the first mate, in characters.
const SAY_LIMIT: usize = 20_000;
const CHAT_DEFAULT: usize = 40;
const CHAT_MAX: usize = 200;

pub async fn handle(desk: &Desk, request: PhoneRequest) -> Result<Value, String> {
    match request {
        PhoneRequest::Board => board(desk).await,
        PhoneRequest::AnswerCall { call, option, page, note } => answer_call(desk, call, option, page, note).await,
        PhoneRequest::ReplyToCall { call, words } => {
            let home = desk.home()?;
            let replied = review::reply_and_tell(&home, &desk.messenger, &call, &words).await?;
            desk.snapshots.refresh();
            Ok(replied)
        }
        PhoneRequest::Page { page, rev, file } => page_file(desk, page, rev, file).await,
        PhoneRequest::Review { page } => {
            let log = log_of(desk, &page)?;
            blocking(move || Ok(review::view(&log))).await
        }
        PhoneRequest::Comment { page, rev, body, anchor, thread } => {
            let log = log_of(desk, &page)?;
            let _one_writer = desk.writes.lock().await;
            blocking(move || review::add_comment(&log, rev, &body, anchor, thread.as_deref(), None)).await
        }
        PhoneRequest::Discard { page, thread } => {
            let log = log_of(desk, &page)?;
            let _one_writer = desk.writes.lock().await;
            blocking(move || review::discard(&log, &thread)).await
        }
        PhoneRequest::SendReview { page, rev, verdict } => {
            let home = desk.home()?;
            let dir = dir_of(desk, &page)?;
            let _one_writer = desk.writes.lock().await;
            let sent = review::submit(&home, &desk.messenger, &dir, rev, verdict).await?;
            desk.snapshots.refresh();
            Ok(sent)
        }
        PhoneRequest::Chat { limit } => chat(desk, limit).await,
        PhoneRequest::Say { text } => {
            if text.trim().is_empty() {
                return Err("there is nothing to say".to_string());
            }
            if text.chars().count() > SAY_LIMIT {
                return Err(format!("a message from the phone is at most {SAY_LIMIT} characters"));
            }
            let message = desk.messenger.tell(text).await?;
            Ok(json!({"message": message}))
        }
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("the Mac could not read or save that: {e}"))?
}

fn dir_of(desk: &Desk, page: &PageRef) -> Result<PathBuf, String> {
    review::artifact_dir(&desk.home()?.join("data"), &page.scope, page.task.as_deref(), &page.name)
}

fn log_of(desk: &Desk, page: &PageRef) -> Result<PathBuf, String> {
    Ok(dir_of(desk, page)?.join("review.jsonl"))
}

/// The fleet snapshot the desktop reads, or why there is none yet.
async fn fleet(desk: &Desk) -> Result<Value, String> {
    let latest = desk.snapshots.latest().await?;
    match latest.pointer("/snapshot/fleet") {
        Some(fleet) if fleet.is_object() => Ok(fleet.clone()),
        _ => Err("the Mac has not read the fleet yet".to_string()),
    }
}

/// What the phone's first screen needs: every call the snapshot carries, as the
/// desktop reads it, the presented pages with their newest revision, and the
/// crew only as a glance: who, on what, and where it stands.
async fn board(desk: &Desk) -> Result<Value, String> {
    let fleet = fleet(desk).await?;
    let pages: Vec<Value> = fleet["artifacts"]
        .as_array()
        .map(|pages| {
            pages
                .iter()
                .map(|page| {
                    let latest = &page["latest"];
                    json!({
                        "scope": page["scope"], "task": page["task"], "name": page["name"], "title": page["title"],
                        "latest": {
                            "rev": latest["rev"], "title": latest["title"], "note": latest["note"], "entry": latest["entry"],
                            "presented_at": latest["presented_at"], "presented_by": latest["presented_by"],
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let crew: Vec<Value> = fleet["tasks"]
        .as_array()
        .map(|tasks| {
            tasks
                .iter()
                .map(|task| json!({"id": task["id"], "project": task["project"], "kind": task["kind"], "state": task.pointer("/current_state/state").cloned().unwrap_or(Value::Null)}))
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "captain_day": fleet.get("captain_day").cloned().unwrap_or(Value::Null),
        "calls": fleet.get("calls").cloned().unwrap_or_else(|| json!([])),
        "pages": pages,
        "crew": crew,
    }))
}

/// The call as the snapshot has it, so an answer carries the label and the way
/// it closes that firstmate declared, never what the phone says they are.
async fn keyed(desk: &Desk, call: &str, option: &str) -> Result<Keyed, String> {
    let fleet = fleet(desk).await?;
    let found = fleet["calls"].as_array().and_then(|calls| calls.iter().find(|item| item["id"] == call));
    let Some(found) = found else { return Err("the Mac has no such call".to_string()) };
    let picked = found["options"].as_array().and_then(|options| options.iter().find(|item| item["key"] == option));
    let Some(picked) = picked else { return Err("that call has no such option".to_string()) };
    Ok(Keyed {
        call: call.to_string(),
        key: option.to_string(),
        label: picked["label"].as_str().unwrap_or(option).to_string(),
        on_answer: found["on_answer"].as_str().unwrap_or_default().to_string(),
    })
}

/// `call_answer`, as the desktop runs it. `recorded` is true only when
/// firstmate's intake said it closed the call.
async fn answer_call(desk: &Desk, call: String, option: String, page: Option<PageRef>, note: Option<String>) -> Result<Value, String> {
    let home = desk.home()?;
    let keyed = keyed(desk, &call, &option).await?;
    let log = page.as_ref().map(|page| log_of(desk, page)).transpose()?;
    let answered = {
        let _one_writer = desk.writes.lock().await;
        review::answer_call(&home, &desk.messenger, log, &keyed, note.as_deref()).await?
    };
    desk.snapshots.refresh();
    let recorded = answered["outcome"]["result"] == "closed";
    Ok(json!({
        "recorded": recorded,
        "outcome": answered["outcome"],
        "told": !answered["message"].is_null(),
        "warning": answered.get("warning").cloned().unwrap_or(Value::Null),
    }))
}

/// A path the artifact resolver reads: each segment as it is on disk.
fn request_path(page: &PageRef, rev: u64, file: &str) -> Result<String, String> {
    let escape = |segment: &str| segment.replace('%', "%25");
    let head = match (page.scope.as_str(), page.task.as_deref()) {
        ("task", Some(task)) => format!("task/{}/{}", escape(task), escape(&page.name)),
        ("chat", _) => format!("chat/{}", escape(&page.name)),
        _ => return Err("that is not a page".to_string()),
    };
    Ok(format!("{head}/rev-{rev}/{}", file.split('/').map(escape).collect::<Vec<_>>().join("/")))
}

/// One file of a presented revision, read through the same resolver the
/// desktop's `artifact` scheme uses, so the phone can read exactly what the
/// review screen can and nothing beside it. Nothing serves it on a network:
/// it travels sealed, like every other answer.
async fn page_file(desk: &Desk, page: PageRef, rev: u64, file: Option<String>) -> Result<Value, String> {
    let dir = dir_of(desk, &page)?;
    let data = desk.home()?.join("data");
    blocking(move || {
        let file = match file {
            Some(file) => file,
            None => {
                let record = std::fs::read_to_string(dir.join(format!("rev-{rev}")).join("revision.json")).map_err(|_| "that revision is not on this Mac".to_string())?;
                let record: Value = serde_json::from_str(&record).map_err(|_| "that revision's record cannot be read".to_string())?;
                record["entry"].as_str().filter(|entry| !entry.is_empty()).ok_or("that revision names no page")?.to_string()
            }
        };
        let path = crate::artifact::resolve(&data, &request_path(&page, rev, &file)?).map_err(|_| "that file is not part of the page".to_string())?;
        let size = std::fs::metadata(&path).map_err(|_| "that file is not part of the page".to_string())?.len();
        if size > PAGE_LIMIT {
            return Err(format!("that file is larger than the {} MB the phone is sent", PAGE_LIMIT / 1024 / 1024));
        }
        let bytes = std::fs::read(&path).map_err(|_| "that file could not be read".to_string())?;
        Ok(json!({"file": file, "rev": rev, "content_type": crate::artifact::content_type(&path), "body": B64.encode(bytes)}))
    })
    .await
}

/// The recent conversation: the captain's words and the first mate's, newest
/// last, with where the host stands and what is waiting to go.
async fn chat(desk: &Desk, limit: Option<u32>) -> Result<Value, String> {
    let state = desk.messenger.state().await?;
    let limit = limit.map_or(CHAT_DEFAULT, |limit| (limit as usize).clamp(1, CHAT_MAX));
    let items: Vec<Value> = state
        .pointer("/conversation/items")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter(|item| matches!(item["who"].as_str(), Some("captain" | "mate"))).cloned().collect())
        .unwrap_or_default();
    let recent = items[items.len().saturating_sub(limit)..].to_vec();
    Ok(json!({"state": state["state"], "items": recent, "queued": state["queued"]}))
}
