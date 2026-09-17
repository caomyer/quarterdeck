//! The captain's firstmate home: asked for once, checked, and remembered in
//! the app data folder.
//!
//! Nothing is ever picked automatically: the captain chooses the folder. A
//! saved home that still checks out is handed to the snapshot reader at
//! launch, so Bearings shows real data before the first mate starts.
//!
//! `QUARTERDECK_SETTINGS_DIR` replaces the app data folder for this file, so a
//! test run can use a scratch home without touching the captain's saved one.
//!
//! Commands: `home_get`, `home_choose`.

use crate::host::{Cmd, HostHandle};
use crate::snapshot::SnapshotHandle;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State as TauriState};
use tauri_plugin_dialog::DialogExt;

const SETTINGS_FILE: &str = "settings.json";

/// Host states in which a first mate is running for the current home.
const RUNNING: [&str; 5] = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"];

/// A firstmate home is a folder holding `AGENTS.md` and `bin/`. Returns the
/// resolved path, or a sentence the captain can act on.
pub(crate) fn check_home(home: &Path) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(home)
        .map_err(|e| format!("{} can't be opened: {e}.", home.display()))?;
    if !resolved.is_dir() {
        return Err(format!("{} is not a folder.", resolved.display()));
    }
    let mut missing = Vec::new();
    if !resolved.join("AGENTS.md").is_file() {
        missing.push("AGENTS.md");
    }
    if !resolved.join("bin").is_dir() {
        missing.push("a bin folder");
    }
    if !missing.is_empty() {
        return Err(format!(
            "{} doesn't look like a firstmate home: it has no {}.",
            resolved.display(),
            missing.join(" and ")
        ));
    }
    Ok(resolved)
}

pub(crate) fn read_saved_home(dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("home").and_then(Value::as_str).filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// Written to a temporary file and renamed, so a crash never leaves half a file.
pub(crate) fn save_home(dir: &Path, home: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let body = serde_json::to_string_pretty(&json!({"home": home.to_string_lossy()}))
        .map_err(|e| format!("could not encode the settings: {e}"))?;
    let temporary = dir.join(format!("{SETTINGS_FILE}.tmp"));
    std::fs::write(&temporary, body).map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, dir.join(SETTINGS_FILE))
        .map_err(|e| format!("could not save {}: {e}", dir.join(SETTINGS_FILE).display()))
}

fn settings_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("QUARTERDECK_SETTINGS_DIR").filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    app.path().app_data_dir().map_err(|e| format!("no app data folder: {e}"))
}

/// The saved home when it still checks out.
pub(crate) fn saved_home<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let saved = read_saved_home(&settings_dir(app).ok()?)?;
    check_home(&saved).ok()
}

/// The saved home and whether it still checks out.
fn saved_status(app: &AppHandle) -> Value {
    let Some(saved) = settings_dir(app).ok().and_then(|dir| read_saved_home(&dir)) else {
        return json!({"home": null, "problem": null});
    };
    match check_home(&saved) {
        Ok(home) => json!({"home": home.to_string_lossy(), "problem": null}),
        Err(problem) => json!({"home": null, "problem": problem}),
    }
}

/// At launch: point the snapshot reader at the saved home, if it still checks out.
pub fn load_saved_home(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(home) = saved_status(&app).get("home").and_then(Value::as_str).map(PathBuf::from) else {
            return;
        };
        if let Err(error) = app.state::<SnapshotHandle>().point_at(home) {
            log::warn!("could not read the saved firstmate home: {error}");
        }
    });
}

/// `{home, problem}`: `home` is the saved home when it still checks out;
/// `problem` says why a saved home no longer does.
#[tauri::command]
pub async fn home_get(app: AppHandle) -> Result<Value, String> {
    Ok(saved_status(&app))
}

/// Asks the captain for the folder. `null` when they cancel; `{home: null,
/// problem}` when the folder is not a firstmate home, leaving the saved one
/// alone; `{home, problem: null}` once it is saved and being read.
#[tauri::command]
pub async fn home_choose(
    app: AppHandle,
    window: tauri::WebviewWindow,
    host: TauriState<'_, HostHandle>,
    snapshots: TauriState<'_, SnapshotHandle>,
) -> Result<Value, String> {
    let state = host.call(|reply| Cmd::GetState { reply }).await?;
    if state.get("state").and_then(Value::as_str).is_some_and(|name| RUNNING.contains(&name)) {
        return Err("Stop the first mate before choosing a different folder.".to_string());
    }
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Choose your firstmate folder")
        .set_parent(&window)
        .blocking_pick_folder()
    else {
        return Ok(Value::Null);
    };
    let picked = picked.into_path().map_err(|e| format!("that folder can't be used: {e}"))?;
    let home = match check_home(&picked) {
        Ok(home) => home,
        Err(problem) => return Ok(json!({"home": null, "problem": problem})),
    };
    save_home(&settings_dir(&app)?, &home)?;
    snapshots.point_at(home.clone())?;
    Ok(json!({"home": home.to_string_lossy(), "problem": null}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_home_needs_agents_md_and_bin() {
        let home = scratch("check");
        let error = check_home(&home).unwrap_err();
        assert!(error.contains("it has no AGENTS.md and a bin folder."), "{error}");

        std::fs::write(home.join("AGENTS.md"), "# firstmate").unwrap();
        let error = check_home(&home).unwrap_err();
        assert!(error.contains("it has no a bin folder."), "{error}");

        std::fs::create_dir(home.join("bin")).unwrap();
        assert_eq!(check_home(&home).unwrap(), std::fs::canonicalize(&home).unwrap());

        let error = check_home(&home.join("AGENTS.md")).unwrap_err();
        assert!(error.contains("is not a folder."), "{error}");
        let error = check_home(&home.join("missing")).unwrap_err();
        assert!(error.contains("can't be opened"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_saved_home_round_trips() {
        let dir = scratch("save").join("nested");
        assert_eq!(read_saved_home(&dir), None);
        save_home(&dir, Path::new("/tmp/fm home")).unwrap();
        assert_eq!(read_saved_home(&dir), Some(PathBuf::from("/tmp/fm home")));
        assert!(!dir.join("settings.json.tmp").exists());

        std::fs::write(dir.join(SETTINGS_FILE), "not json").unwrap();
        assert_eq!(read_saved_home(&dir), None);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
