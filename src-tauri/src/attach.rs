//! Files the captain attaches to a message.
//!
//! A message stays words: the durable outbox, the re-send after a restart and a
//! resumed session's history all carry text and nothing else. So an attached
//! file is copied into the home, under `data/.attachments/`, and the message
//! names the copy's path for the first mate to read. The copy is taken when the
//! file is picked, so what goes is what the captain chose even if the original
//! moves or changes before the message is sent, and it is still there when a
//! message is re-sent after a restart. The first mate works in the home, so it
//! reads the copy without asking to reach outside it.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// The largest file that can be attached. A copy of anything bigger fills the
/// home for a file no first mate could read whole anyway; the captain can tell
/// it where the file is instead.
pub const ATTACH_LIMIT: u64 = 100 * 1024 * 1024;

/// One attached file: its copy in the home, and where it came from.
#[derive(Debug, PartialEq)]
pub struct Attached {
    pub name: String,
    pub path: PathBuf,
    pub source: PathBuf,
    pub bytes: u64,
}

fn megabytes(bytes: u64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    if mb >= 1024.0 {
        format!("{:.1} GB", mb / 1024.0)
    } else {
        format!("{mb:.0} MB")
    }
}

/// The copy's file name: the original's, with anything that would break the
/// message's one line per file (control characters) or its quoting (backticks)
/// made plain.
fn safe_name(source: &Path) -> String {
    let raw = source.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let name: String = raw.chars().map(|c| if c.is_control() || c == '`' { '_' } else { c }).collect();
    if name.trim().is_empty() { "file".to_string() } else { name }
}

/// A folder of its own for each copy, so two files with one name never meet.
fn fresh_folder(home: &Path) -> Result<PathBuf, String> {
    let root = home.join("data").join(".attachments");
    std::fs::create_dir_all(&root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    for n in 1..1000 {
        let folder = root.join(format!("{stamp}-{n}"));
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not create {}: {e}", folder.display())),
        }
    }
    Err(format!("could not find a free folder in {}", root.display()))
}

/// Copies one file into the home. The error is a sentence for the captain.
pub fn stage(home: &Path, source: &Path) -> Result<Attached, String> {
    let shown = source.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| source.display().to_string());
    let meta = match std::fs::metadata(source) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(format!("{shown} is no longer there.")),
        Err(e) => return Err(format!("{shown} can't be read: {e}.")),
    };
    if meta.is_dir() {
        return Err(format!("{shown} is a folder. Attach the files in it instead."));
    }
    if !meta.is_file() {
        return Err(format!("{shown} isn't a file that can be attached."));
    }
    if meta.len() > ATTACH_LIMIT {
        return Err(format!(
            "{shown} is {}, and files over {} can't be attached. Tell the first mate where it is instead.",
            megabytes(meta.len()),
            megabytes(ATTACH_LIMIT)
        ));
    }
    let folder = fresh_folder(home)?;
    let name = safe_name(source);
    let copy = folder.join(&name);
    match std::fs::copy(source, &copy) {
        Ok(bytes) => Ok(Attached { name, path: copy, source: source.to_path_buf(), bytes }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&folder);
            Err(match e.kind() {
                std::io::ErrorKind::NotFound => format!("{shown} is no longer there."),
                _ => format!("{shown} could not be copied into the home: {e}."),
            })
        }
    }
}

/// Stages every file, keeping the ones that went and saying why the others did not.
pub fn stage_all(home: &Path, sources: &[PathBuf]) -> Value {
    let mut attached = Vec::new();
    let mut refused = Vec::new();
    for source in sources {
        match stage(home, source) {
            Ok(file) => attached.push(json!({
                "name": file.name,
                "path": file.path.to_string_lossy(),
                "source": file.source.to_string_lossy(),
                "bytes": file.bytes,
            })),
            Err(problem) => refused.push(json!({"source": source.to_string_lossy(), "problem": problem})),
        }
    }
    json!({"attached": attached, "refused": refused})
}

/// Asks the captain for files and copies them into the home messages go to.
/// `null` when they cancel.
#[tauri::command]
pub async fn attach_pick(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    let home = crate::settings::saved_home(&app).ok_or_else(|| "Choose a firstmate folder before attaching files.".to_string())?;
    let Some(picked) = app.dialog().file().set_title("Attach files for the first mate").set_parent(&window).blocking_pick_files() else {
        return Ok(Value::Null);
    };
    let sources: Vec<PathBuf> = picked.into_iter().filter_map(|file| file.into_path().ok()).collect();
    tauri::async_runtime::spawn_blocking(move || stage_all(&home, &sources))
        .await
        .map_err(|e| format!("the files could not be attached: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).unwrap();
        dir
    }

    #[test]
    fn a_file_is_copied_into_the_home_under_its_own_name() {
        let dir = scratch("copy");
        let source = dir.join("Résumé final 日本 v2.md");
        std::fs::write(&source, "hello").unwrap();
        let file = stage(&dir.join("home"), &source).unwrap();
        assert_eq!(file.name, "Résumé final 日本 v2.md");
        assert_eq!(file.bytes, 5);
        assert!(file.path.starts_with(dir.join("home").join("data").join(".attachments")));
        assert_eq!(std::fs::read_to_string(&file.path).unwrap(), "hello");
        // The copy is the captain's choice: changing or removing the original afterwards changes nothing.
        std::fs::remove_file(&source).unwrap();
        assert_eq!(std::fs::read_to_string(&file.path).unwrap(), "hello");
    }

    #[test]
    fn two_files_with_one_name_both_keep_it() {
        let dir = scratch("same-name");
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a").join("notes.txt"), "a").unwrap();
        std::fs::write(dir.join("b").join("notes.txt"), "b").unwrap();
        let first = stage(&dir.join("home"), &dir.join("a").join("notes.txt")).unwrap();
        let second = stage(&dir.join("home"), &dir.join("b").join("notes.txt")).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read_to_string(&first.path).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(&second.path).unwrap(), "b");
    }

    #[test]
    fn a_name_that_would_break_the_message_is_made_plain() {
        let dir = scratch("odd-name");
        let source = dir.join("two\nlines `quoted`.txt");
        std::fs::write(&source, "x").unwrap();
        let file = stage(&dir.join("home"), &source).unwrap();
        assert_eq!(file.name, "two_lines _quoted_.txt");
        assert_eq!(file.path.file_name().unwrap().to_string_lossy(), "two_lines _quoted_.txt");
    }

    #[test]
    fn what_cannot_be_attached_is_refused_with_a_reason_and_leaves_nothing() {
        let dir = scratch("refused");
        let home = dir.join("home");
        let gone = stage(&home, &dir.join("gone.pdf")).unwrap_err();
        assert_eq!(gone, "gone.pdf is no longer there.");
        let folder = stage(&home, &dir.join("home")).unwrap_err();
        assert!(folder.contains("is a folder"), "{folder}");
        let big = dir.join("huge.bin");
        std::fs::File::create(&big).unwrap().set_len(ATTACH_LIMIT * 3).unwrap();
        let large = stage(&home, &big).unwrap_err();
        assert_eq!(large, "huge.bin is 300 MB, and files over 100 MB can't be attached. Tell the first mate where it is instead.");
        let copies = std::fs::read_dir(home.join("data").join(".attachments")).map(|entries| entries.count()).unwrap_or(0);
        assert_eq!(copies, 0, "a refused file leaves no copy behind");
    }

    #[test]
    fn a_file_at_the_limit_is_attached() {
        let dir = scratch("limit");
        let source = dir.join("exact.bin");
        std::fs::File::create(&source).unwrap().set_len(ATTACH_LIMIT).unwrap();
        assert_eq!(stage(&dir.join("home"), &source).unwrap().bytes, ATTACH_LIMIT);
    }

    #[test]
    fn some_files_go_and_the_rest_say_why() {
        let dir = scratch("mixed");
        std::fs::write(dir.join("ok.txt"), "ok").unwrap();
        let result = stage_all(&dir.join("home"), &[dir.join("ok.txt"), dir.join("missing.txt")]);
        assert_eq!(result["attached"].as_array().unwrap().len(), 1);
        assert_eq!(result["attached"][0]["name"], "ok.txt");
        assert_eq!(result["refused"][0]["problem"], "missing.txt is no longer there.");
    }
}
