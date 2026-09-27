//! A task's report, read so the captain can read it in the task's drawer.
//!
//! A scout writes its findings to `data/<id>/report.md` in the home, and the
//! snapshot names that path on the task's worker and, once it lands, on its row.
//! Nothing but the worker writes it, and the app only reads it: one task's
//! report, by id, from that one place, never a path the window hands in.
//!
//! The file is the worker's words, so a report that is a link, or a file that
//! resolves anywhere but its task's own folder, is refused rather than followed.
//! A report too long to draw is cut, and says so.

use crate::artifact::valid_task_id;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// More than any report a scout writes to be read; a longer one is cut here and says so.
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct TaskReport {
    pub task: String,
    /// Where it is in the home, as the snapshot names it.
    pub path: String,
    pub text: String,
    pub bytes: u64,
    /// Whether `text` stops short of the file.
    pub truncated: bool,
}

/// Reads `<home>/data/<task>/report.md`. `Ok(None)` when the task has written none.
pub fn read(home: &Path, task: &str) -> Result<Option<TaskReport>, String> {
    if !valid_task_id(task) || task.starts_with('-') {
        return Err(format!("'{task}' is not a task id"));
    }
    let data = home.join("data");
    let path = data.join(task).join("report.md");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{task}'s report can't be read: {error}")),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!("{task}'s report is not a plain file, so it is not opened"));
    }
    // The task's own folder, not a link out of the home: resolved, it still sits under data/.
    let folder = std::fs::canonicalize(data.join(task)).map_err(|e| format!("{task}'s folder can't be read: {e}"))?;
    let root = std::fs::canonicalize(&data).map_err(|e| format!("the home's data folder can't be read: {e}"))?;
    if folder.parent() != Some(root.as_path()) {
        return Err(format!("{task}'s folder is outside the home, so its report is not opened"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|file| file.take(MAX_BYTES).read_to_end(&mut bytes))
        .map_err(|e| format!("{task}'s report can't be read: {e}"))?;
    Ok(Some(TaskReport {
        task: task.to_string(),
        path: path.to_string_lossy().into_owned(),
        text: String::from_utf8_lossy(&bytes).into_owned(),
        bytes: meta.len(),
        truncated: meta.len() > MAX_BYTES,
    }))
}

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

/// A task's report as its worker wrote it, or `null` when it has written none.
#[tauri::command]
pub async fn task_report(app: AppHandle, task_id: String) -> Result<Option<TaskReport>, String> {
    let home = home_for(&app)?;
    tokio::task::spawn_blocking(move || read(&home, &task_id))
        .await
        .map_err(|e| format!("reading the report stopped: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qd-report-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn a_report_is_read_from_its_tasks_folder() {
        let home = home("read");
        std::fs::create_dir_all(home.join("data/res-feed-scout")).unwrap();
        std::fs::write(home.join("data/res-feed-scout/report.md"), "# Findings\n\nMost feeds never change.").unwrap();
        let report = read(&home, "res-feed-scout").unwrap().unwrap();
        assert_eq!(report.text, "# Findings\n\nMost feeds never change.");
        assert_eq!(report.bytes, report.text.len() as u64);
        assert!(!report.truncated);
        assert!(report.path.ends_with("data/res-feed-scout/report.md"));
    }

    #[test]
    fn a_task_with_no_report_has_none() {
        let home = home("none");
        assert_eq!(read(&home, "res-feed-scout").unwrap(), None);
        std::fs::create_dir_all(home.join("data/res-feed-scout")).unwrap();
        assert_eq!(read(&home, "res-feed-scout").unwrap(), None);
    }

    #[test]
    fn only_a_task_id_names_a_report() {
        let home = home("ids");
        for bad in ["", "..", ".hidden", "a/b", "../data", "-rf", "a b"] {
            assert!(read(&home, bad).is_err(), "{bad:?} was read");
        }
    }

    #[test]
    fn a_report_that_is_a_link_is_not_followed() {
        let home = home("link");
        std::fs::write(home.join("secret.txt"), "not a report").unwrap();
        std::fs::create_dir_all(home.join("data/t1")).unwrap();
        std::os::unix::fs::symlink(home.join("secret.txt"), home.join("data/t1/report.md")).unwrap();
        let refused = read(&home, "t1").unwrap_err();
        assert!(refused.contains("not a plain file"), "{refused}");
    }

    #[test]
    fn a_task_folder_that_leads_out_of_the_home_is_not_read() {
        let home = home("folder-link");
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("report.md"), "not this home's").unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join("data/t1")).unwrap();
        let refused = read(&home, "t1").unwrap_err();
        assert!(refused.contains("outside the home"), "{refused}");
    }

    #[test]
    fn a_long_report_is_cut_and_says_so() {
        let home = home("long");
        std::fs::create_dir_all(home.join("data/t1")).unwrap();
        std::fs::write(home.join("data/t1/report.md"), "a".repeat(MAX_BYTES as usize + 10)).unwrap();
        let report = read(&home, "t1").unwrap().unwrap();
        assert_eq!(report.text.len(), MAX_BYTES as usize);
        assert_eq!(report.bytes, MAX_BYTES + 10);
        assert!(report.truncated);
    }
}
