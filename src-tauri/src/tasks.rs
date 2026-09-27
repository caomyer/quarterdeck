//! The captain's edits to a task, through firstmate's own writer.
//!
//! `bin/fm-task-edit.sh` is the one writer of a task's priority, title,
//! dependencies, project, kind, put-off date and group, and its header owns the
//! verbs, what each refuses and what it prints. The app runs it and reads back
//! what it says; it never writes the backlog, and it keeps no second copy of a
//! rule: a loop, a task in flight or a stale edit is refused by the script, in
//! the script's words, and the window shows that refusal where the edit was made.
//!
//! The script prints one JSON object whether it takes the edit or refuses it, so
//! a refusal comes back as a result the window can place (`ok: false`, with a
//! `code`), and only a script that cannot run at all is an error.
//!
//! Command: `task_edit`.

use crate::envpath;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;

/// Every verb reads the backlog and makes one tasks-axi change; the script waits
/// at most 10 seconds for each lock it takes, so anything slower is stuck.
const TIMEOUT: Duration = Duration::from_secs(45);

/// One change at a time, so two quick clicks cannot race their expectations.
static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SCRIPT: &str = "bin/fm-task-edit.sh";

/// One edit as the window asks for it; `expect` is the value the window showed.
#[derive(Debug, Deserialize)]
#[serde(tag = "verb", rename_all = "kebab-case")]
pub enum Edit {
    Priority { task: String, value: String, expect: String },
    Title { task: String, value: String, expect: String },
    Block { task: String, by: String },
    Unblock { task: String, by: String },
    Park { task: String, until: String, expect: String },
    Unpark { task: String, expect: String },
    Project { task: String, value: String, expect: String },
    Kind { task: String, value: String, expect: String },
    Group { task: String, value: String, expect: String },
    GroupNew { title: String, project: String, priority: Option<String> },
    GroupClose { task: String },
}

/// The script's arguments for one edit. Every value follows its verb or flag in
/// its own argument, so a title that starts with a dash is never read as a flag.
fn args(edit: &Edit) -> Vec<String> {
    let owned = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
    match edit {
        Edit::Priority { task, value, expect } => owned(&["priority", task, value, "--expect", expect]),
        Edit::Title { task, value, expect } => owned(&["title", task, value, "--expect", expect]),
        Edit::Block { task, by } => owned(&["block", task, "--by", by]),
        Edit::Unblock { task, by } => owned(&["unblock", task, "--by", by]),
        Edit::Park { task, until, expect } => owned(&["park", task, "--until", until, "--expect", expect]),
        Edit::Unpark { task, expect } => owned(&["unpark", task, "--expect", expect]),
        Edit::Project { task, value, expect } => owned(&["project", task, value, "--expect", expect]),
        Edit::Kind { task, value, expect } => owned(&["kind", task, value, "--expect", expect]),
        Edit::Group { task, value, expect } => owned(&["group", task, value, "--expect", expect]),
        Edit::GroupNew { title, project, priority } => {
            let mut args = owned(&["group-new", title, "--project", project]);
            if let Some(priority) = priority {
                args.extend(owned(&["--priority", priority]));
            }
            args
        }
        Edit::GroupClose { task } => owned(&["group-close", task]),
    }
}

/// A task id the script would take: the shared id alphabet, never a flag.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('-') && id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn checked(edit: &Edit) -> Result<(), String> {
    let ids: Vec<&str> = match edit {
        Edit::Block { task, by } | Edit::Unblock { task, by } => vec![task, by],
        Edit::Priority { task, .. } | Edit::Title { task, .. } | Edit::Park { task, .. } | Edit::Unpark { task, .. }
        | Edit::Project { task, .. } | Edit::Kind { task, .. } | Edit::GroupClose { task } => vec![task],
        Edit::Group { task, value, .. } => if value == "none" { vec![task] } else { vec![task, value] },
        Edit::GroupNew { .. } => vec![],
    };
    match ids.into_iter().find(|id| !valid_id(id)) {
        Some(id) => Err(format!("'{id}' is not a task id")),
        None => Ok(()),
    }
}

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

/// Runs one edit in the home: the object the script printed, taken or refused.
pub async fn run(home: &Path, edit: &Edit) -> Result<Value, String> {
    checked(edit)?;
    let script = home.join(SCRIPT);
    if !script.is_file() {
        return Err("This home's firstmate can't change a task from here yet.".to_string());
    }
    let _one = WRITER.lock().await;
    let child = envpath::command(&script)
        .args(args(edit))
        .env("FM_HOME", home)
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run {SCRIPT}: {e}"))?;
    let output = match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("{SCRIPT} could not be read: {e}")),
        Err(_) => return Err(format!("{SCRIPT} did not finish within {}s", TIMEOUT.as_secs())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    // A refusal is exit 1 with its object on stdout; anything else without one is the script failing to run.
    match serde_json::from_str::<Value>(stdout.trim()) {
        Ok(value) if value.get("ok").and_then(Value::as_bool).is_some() => Ok(value),
        _ => Err(reason(&String::from_utf8_lossy(&output.stderr), &output.status.to_string())),
    }
}

/// The script's reason when it printed no result: its last line, without its name.
fn reason(stderr: &str, status: &str) -> String {
    let line = stderr.lines().rev().map(str::trim).find(|line| !line.is_empty());
    match line {
        Some(line) => line.strip_prefix("fm-task-edit:").map(str::trim).unwrap_or(line).to_string(),
        None => format!("{SCRIPT} stopped ({status})"),
    }
}

/// One edit to a task. The snapshot follows the backlog's change on its own.
#[tauri::command]
pub async fn task_edit(app: AppHandle, edit: Edit) -> Result<Value, String> {
    let home = home_for(&app)?;
    run(&home, &edit).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn edit(value: Value) -> Edit {
        serde_json::from_value(value).expect("the window's edit")
    }

    #[test]
    fn each_edit_reaches_the_script_as_its_own_arguments() {
        assert_eq!(args(&edit(json!({"verb": "priority", "task": "t1", "value": "1", "expect": "none"}))), ["priority", "t1", "1", "--expect", "none"]);
        assert_eq!(args(&edit(json!({"verb": "title", "task": "t1", "value": "--not a flag", "expect": "old"}))), ["title", "t1", "--not a flag", "--expect", "old"]);
        assert_eq!(args(&edit(json!({"verb": "block", "task": "t1", "by": "t2"}))), ["block", "t1", "--by", "t2"]);
        assert_eq!(args(&edit(json!({"verb": "park", "task": "t1", "until": "2026-10-02", "expect": "none"}))), ["park", "t1", "--until", "2026-10-02", "--expect", "none"]);
        assert_eq!(args(&edit(json!({"verb": "group-new", "title": "A group", "project": "demo", "priority": "1"}))), ["group-new", "A group", "--project", "demo", "--priority", "1"]);
        assert_eq!(args(&edit(json!({"verb": "group-new", "title": "A group", "project": "demo", "priority": null}))), ["group-new", "A group", "--project", "demo"]);
        assert_eq!(args(&edit(json!({"verb": "group-close", "task": "g-a"}))), ["group-close", "g-a"]);
    }

    #[test]
    fn only_task_ids_reach_the_script() {
        for bad in ["", "-x", "../t1", "a/b", "a b"] {
            assert!(checked(&edit(json!({"verb": "block", "task": "t1", "by": bad}))).is_err(), "{bad}");
        }
        assert!(checked(&edit(json!({"verb": "group", "task": "t1", "value": "none", "expect": "g-a"}))).is_ok());
        assert!(checked(&edit(json!({"verb": "group", "task": "t1", "value": "--g", "expect": "none"}))).is_err());
    }

    /// The real script, in a disposable home: an edit taken and one refused both come back as results.
    #[tokio::test]
    async fn edits_and_refusals_come_back_through_the_engines_script() {
        if std::process::Command::new("tasks-axi").arg("--version").output().is_err() {
            eprintln!("skip: tasks-axi not found");
            return;
        }
        let dir = std::env::temp_dir().join(format!("qd-tasks-{}", std::process::id()));
        let home = dir.join("home");
        std::fs::create_dir_all(home.join("data")).unwrap();
        std::fs::create_dir_all(home.join("state")).unwrap();
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("engine");
        std::fs::copy(engine.join(".tasks.toml"), home.join(".tasks.toml")).unwrap();
        std::os::unix::fs::symlink(std::fs::canonicalize(engine.join("bin")).unwrap(), home.join("bin")).unwrap();
        std::fs::write(home.join("data").join("projects.md"), "- demo - the demo project (added 2026-09-01)\n").unwrap();
        std::fs::write(
            home.join("data").join("backlog.md"),
            "## In flight\n\n## Queued\n- [ ] t-a - first (repo: demo) (kind: ship) (priority: 2) (since 2026-09-20)\n- [ ] t-b - second blocked-by: t-a (repo: demo) (kind: ship) (since 2026-09-21)\n\n## Done\n",
        )
        .unwrap();

        let taken = run(&home, &edit(json!({"verb": "priority", "task": "t-b", "value": "0", "expect": "none"}))).await.unwrap();
        assert_eq!(taken["ok"], true);
        assert_eq!(taken["record"]["priority"], "0");
        assert_eq!(taken["record"]["standing"], "blocked");

        let refused = run(&home, &edit(json!({"verb": "block", "task": "t-a", "by": "t-b"}))).await.unwrap();
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["code"], "loop");
        assert!(refused["reason"].as_str().unwrap().contains("t-b already waits on t-a"));

        let stale = run(&home, &edit(json!({"verb": "priority", "task": "t-b", "value": "3", "expect": "none"}))).await.unwrap();
        assert_eq!((stale["code"].as_str(), stale["current"].as_str()), (Some("stale"), Some("0")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
