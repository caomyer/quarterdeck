//! The files and notes a task carries beside its backlog row, through
//! firstmate's own writer.
//!
//! `bin/fm-task-note.sh` is the one writer of a task's `data/<id>/notes/` and
//! `data/<id>/files/`, and its header owns the store and what it prints. The
//! app reads a task's notes with `show --json` when its details open, adds the
//! captain's with `add --by captain`, and never writes either folder itself.
//! A file the captain adds goes to the script as the path they picked, and the
//! script takes its own copy under a name safe to hand a worker.
//!
//! The pictures among those files are shown through the `artifact` scheme
//! (`artifact.rs`), read-only.

use crate::artifact::valid_task_id;
use crate::snapshot::run_script;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

const SCRIPT: &str = "fm-task-note.sh";

/// Reading notes is a few small files; adding copies files of up to 100 MiB.
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const ADD_TIMEOUT: Duration = Duration::from_secs(120);

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

fn checked(task_id: &str) -> Result<(), String> {
    if valid_task_id(task_id) && !task_id.starts_with('-') {
        Ok(())
    } else {
        Err(format!("'{task_id}' is not a task id"))
    }
}

/// The arguments one captain's note is added with. The body and each path are values of their flags, so a leading
/// dash in either is never read as a flag.
fn add_args(task_id: &str, body: &str, sources: &[String]) -> Vec<String> {
    let mut args = vec!["add".to_string(), task_id.to_string(), "--by".to_string(), "captain".to_string()];
    if !body.trim().is_empty() {
        args.extend(["--body".to_string(), body.to_string()]);
    }
    for source in sources {
        args.extend(["--file".to_string(), source.clone()]);
    }
    args
}

async fn show(home: &std::path::Path, task_id: &str) -> Result<Value, String> {
    if !home.join("bin").join(SCRIPT).is_file() {
        return Ok(Value::Null);
    }
    let output = run_script(home, SCRIPT, &["show", task_id, "--json"], READ_TIMEOUT).await?;
    serde_json::from_str(&output).map_err(|e| format!("{SCRIPT} printed invalid JSON: {e}"))
}

/// A task's notes as `show --json` prints them, or `null` from a firstmate that has no such script.
#[tauri::command]
pub async fn task_notes(app: AppHandle, task_id: String) -> Result<Value, String> {
    checked(&task_id)?;
    let home = home_for(&app)?;
    show(&home, &task_id).await
}

/// Adds the captain's note to a task, then reads the task's notes back. A refusal comes back in the script's words.
#[tauri::command]
pub async fn task_note_add(app: AppHandle, task_id: String, body: String, sources: Vec<String>) -> Result<Value, String> {
    checked(&task_id)?;
    if body.trim().is_empty() && sources.is_empty() {
        return Err("Write a note or add a file first.".to_string());
    }
    let home = home_for(&app)?;
    if !home.join("bin").join(SCRIPT).is_file() {
        return Err("This home's firstmate can't keep notes on a task yet.".to_string());
    }
    let args = add_args(&task_id, &body, &sources);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_script(&home, SCRIPT, &args, ADD_TIMEOUT).await?;
    show(&home, &task_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_is_the_captains_and_carries_only_what_was_given() {
        assert_eq!(add_args("t1", "  ", &[]), ["add", "t1", "--by", "captain"]);
        assert_eq!(
            add_args("t1", "-rf is not a flag", &["-odd.png".to_string(), "/a b.png".to_string()]),
            ["add", "t1", "--by", "captain", "--body", "-rf is not a flag", "--file", "-odd.png", "--file", "/a b.png"]
        );
    }

    #[test]
    fn only_a_task_id_reaches_the_script() {
        assert!(checked("qd-chat-page-order-1").is_ok());
        for bad in ["", "-x", "../t1", "a/b", ".hidden", "a b"] {
            assert!(checked(bad).is_err(), "{bad}");
        }
    }

    /// The real script, in a disposable home: what the app adds is the captain's, and reads back with a clean name.
    #[tokio::test]
    async fn adds_and_reads_through_the_engines_script() {
        let dir = std::env::temp_dir().join(format!("qd-notes-{}", std::process::id()));
        let home = dir.join("home");
        std::fs::create_dir_all(home.join("data").join("t1")).unwrap();
        std::fs::create_dir_all(home.join("state")).unwrap();
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("engine").join("bin");
        std::os::unix::fs::symlink(std::fs::canonicalize(engine).unwrap(), home.join("bin")).unwrap();
        let picked = dir.join("Screenshot 1\u{202f}PM.png");
        std::fs::write(&picked, b"png").unwrap();

        assert_eq!(show(&home, "t1").await.unwrap()["notes"], serde_json::json!([]));
        let args = add_args("t1", "The captain saw this.", &[picked.to_string_lossy().to_string()]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run_script(&home, SCRIPT, &args, ADD_TIMEOUT).await.unwrap();
        let notes = show(&home, "t1").await.unwrap();
        let note = &notes["notes"][0];
        assert_eq!(note["by"], "captain");
        assert_eq!(note["body"], "The captain saw this.");
        assert_eq!(note["files"][0]["name"], "Screenshot-1-PM.png");
        assert_eq!(note["files"][0]["original"], "Screenshot 1\u{202f}PM.png");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
