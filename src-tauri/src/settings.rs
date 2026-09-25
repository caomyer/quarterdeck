//! The captain's firstmate home: the one the app owns, or one they chose.
//!
//! The app ships the first mate's own code and builds a home for it in the app
//! data folder, so a captain who has never heard of firstmate has a working one
//! on first launch. `home_choose` still points the app at a folder of their own,
//! and a saved choice always wins over the app's. Whichever it is, a home that
//! still checks out is handed to the snapshot reader at launch, so Bearings
//! shows real data before the first mate starts.
//!
//! Per home, the file also remembers whether the captain left the first mate
//! running, so the app starts it again when it opens; a first mate the captain
//! stopped stays stopped.
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

/// The whole settings file, `{}` when it is missing or unreadable.
fn read_settings(dir: &Path) -> Value {
    std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// Written to a temporary file and renamed, so a crash never leaves half a file.
fn write_settings(dir: &Path, settings: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let body = serde_json::to_string_pretty(settings).map_err(|e| format!("could not encode the settings: {e}"))?;
    let temporary = dir.join(format!("{SETTINGS_FILE}.tmp"));
    std::fs::write(&temporary, body).map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, dir.join(SETTINGS_FILE))
        .map_err(|e| format!("could not save {}: {e}", dir.join(SETTINGS_FILE).display()))
}

pub(crate) fn read_saved_home(dir: &Path) -> Option<PathBuf> {
    read_settings(dir).get("home").and_then(Value::as_str).filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// Forgets the chosen home, keeping everything else the file holds. What the
/// captain left running per home stays: it is keyed by home, and the folder
/// they chose may be chosen again.
pub(crate) fn forget_home(dir: &Path) -> Result<(), String> {
    let mut settings = read_settings(dir);
    if let Some(object) = settings.as_object_mut() {
        object.remove("home");
    }
    write_settings(dir, &settings)
}

/// Remembers the chosen home, keeping everything else the file holds.
pub(crate) fn save_home(dir: &Path, home: &Path) -> Result<(), String> {
    let mut settings = read_settings(dir);
    settings["home"] = json!(home.to_string_lossy());
    write_settings(dir, &settings)
}

/// Homes are remembered by their resolved path, however the captain named them.
fn home_key(home: &Path) -> String {
    std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()).to_string_lossy().to_string()
}

/// Whether the captain left the first mate running in this home: set when they start
/// it and cleared only when they stop it. A first mate that was running when the app
/// closed, or quit, or crashed, is started again when the app opens.
pub(crate) fn remember_running(dir: &Path, home: &Path, running: bool) -> Result<(), String> {
    let mut settings = read_settings(dir);
    if !settings.get("running").is_some_and(Value::is_object) {
        settings["running"] = json!({});
    }
    settings["running"][home_key(home)] = json!(running);
    write_settings(dir, &settings)
}

pub(crate) fn was_running(dir: &Path, home: &Path) -> bool {
    read_settings(dir)
        .pointer("/running")
        .and_then(|running| running.get(home_key(home)))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// For the host's Start and Stop: what the captain asked for is remembered, and a
/// settings file that cannot be written only costs the start on the next launch.
pub(crate) fn note_running<R: tauri::Runtime>(app: &AppHandle<R>, home: &Path, running: bool) {
    let result = settings_dir(app).and_then(|dir| remember_running(&dir, home, running));
    if let Err(error) = result {
        log::warn!("could not remember whether the first mate is running in {}: {error}", home.display());
    }
}

pub(crate) fn settings_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("QUARTERDECK_SETTINGS_DIR").filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    app.path().app_data_dir().map_err(|e| format!("no app data folder: {e}"))
}

/// The home everything reads: the folder the captain chose when they chose one,
/// and otherwise the app's own. Reviews and artifacts resolve their home through
/// here, so a captain who never chose a folder still has both.
pub(crate) fn saved_home<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = settings_dir(app).ok()?;
    match read_saved_home(&dir) {
        Some(saved) => check_home(&saved).ok(),
        None => prepared_home(app).ok(),
    }
}

/// The home to use when the captain has not chosen one: the app's own, laid out
/// from the engine it ships. Run on every launch, so a home built by an older
/// copy of the app is repointed at the one now installed.
///
/// Returns the reason instead when there is no engine to lay it out from, or
/// when the script refuses the folder; the captain can still choose their own.
pub(crate) fn prepared_home<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let mut ready = PREPARED.lock().unwrap_or_else(|held| held.into_inner());
    if let Some(home) = ready.as_ref() {
        return Ok(home.clone());
    }
    let home = lay_out_home(app)?;
    *ready = Some(home.clone());
    Ok(home)
}

/// The layout is done once per launch and every later caller is answered from
/// it. Only success is kept: another copy of the script holding the home's lock
/// is a passing thing, and one contended launch must not strand the captain on
/// its error until they restart the app.
static PREPARED: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

fn lay_out_home<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let engine = crate::engine::bundled_engine(app)?;
    let home = crate::engine::managed_home(app)?;
    let said = crate::engine::prepare_home(&engine, &home)?;
    log::info!("the first mate's home is ready at {}: {}", home.display(), said.replace('\n', "; "));
    // The app's own home presents its pages through the app, so the first mate
    // is told so before it is ever asked: left unsaid it means lavish-axi, and
    // the captain would be asked on first launch to install a tool this app
    // does not use.
    match crate::engine::claim_presentation(&home) {
        Ok(true) => log::info!("the first mate will present this home's pages in Quarterdeck"),
        Ok(false) => {}
        Err(problem) => log::warn!("{problem}"),
    }
    // An app update replaces the engine's bytes at the same path, which is the
    // case that leaves a watch armed against a copy that no longer exists. It
    // fails no launch: a home with no watches has nothing to do, and a watch
    // broken some other way is a thing to report.
    match crate::engine::rebind_watches(&engine, &home) {
        Ok(said) if said.is_empty() => {}
        Ok(said) => log::info!("the first mate's watches follow the engine now installed: {}", said.replace('\n', "; ")),
        Err(problem) => log::warn!("{problem}"),
    }
    check_home(&home)
}

/// The saved home, whether it still checks out, and whether the first mate was left
/// running there, so the window can start it again once it is listening.
fn saved_status(app: &AppHandle) -> Value {
    let Ok(dir) = settings_dir(app) else {
        return json!({"home": null, "problem": null, "start_on_launch": false});
    };
    // A folder the captain chose wins, whether or not it still checks out: they
    // asked for that one, and being told why it no longer works beats being
    // moved silently onto the app's own.
    // The app's own home is not a choice the captain made, so the app can offer
    // to go back to it; a folder they chose is theirs until they say otherwise.
    if read_saved_home(&dir).is_some() {
        let mut chosen = status_in(&dir);
        chosen["chosen"] = json!(true);
        return chosen;
    }
    match prepared_home(app) {
        Ok(home) => json!({"home": home.to_string_lossy(), "problem": null, "start_on_launch": was_running(&dir, &home), "chosen": false}),
        Err(problem) => json!({"home": null, "problem": problem, "start_on_launch": false, "chosen": false}),
    }
}

fn status_in(dir: &Path) -> Value {
    let Some(saved) = read_saved_home(dir) else {
        return json!({"home": null, "problem": null, "start_on_launch": false});
    };
    match check_home(&saved) {
        Ok(home) => json!({"home": home.to_string_lossy(), "problem": null, "start_on_launch": was_running(dir, &home)}),
        Err(problem) => json!({"home": null, "problem": problem, "start_on_launch": false}),
    }
}

/// At launch: point the snapshot reader at the home this launch reads, which is
/// the captain's choice when they made one and otherwise the app's own, laid
/// out from the engine before anything is read.
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
    // Answering this can run the engine's layout script, which on a contended
    // launch waits on another copy of itself; none of that belongs on a thread
    // that drives the app.
    tauri::async_runtime::spawn_blocking(move || saved_status(&app))
        .await
        .map_err(|e| format!("the first mate's home could not be read: {e}"))
}

/// What the first mate says this machine still needs, for the app to show.
/// Empty when nothing is missing. A home the captain chose is checked with the
/// engine the app ships, which is the one that will run in it.
#[tauri::command]
pub async fn tools_missing(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = crate::engine::bundled_engine(&app)?;
        let Some(home) = saved_home(&app) else {
            return Ok(json!({"missing": [], "problem": "there is no home to check"}));
        };
        match crate::engine::missing_tools(&engine, &home) {
            Ok(missing) => Ok(json!({"missing": missing, "problem": null})),
            Err(problem) => Ok(json!({"missing": [], "problem": problem})),
        }
    })
    .await
    .map_err(|e| format!("this machine could not be checked: {e}"))?
}

/// Gives the app's own home back, by forgetting the folder the captain chose.
/// The first mate has to be stopped for the same reason choosing one does.
#[tauri::command]
pub async fn home_use_app(
    app: AppHandle,
    host: TauriState<'_, HostHandle>,
    snapshots: TauriState<'_, SnapshotHandle>,
) -> Result<Value, String> {
    let state = host.call(|reply| Cmd::GetState { reply }).await?;
    if state.get("state").and_then(Value::as_str).is_some_and(|name| RUNNING.contains(&name)) {
        return Err("Stop the first mate before changing which folder it runs in.".to_string());
    }
    forget_home(&settings_dir(&app)?)?;
    let status = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || saved_status(&app)
    })
    .await
    .map_err(|e| format!("the first mate's home could not be read: {e}"))?;
    if let Some(home) = status.get("home").and_then(Value::as_str) {
        snapshots.point_at(PathBuf::from(home))?;
    }
    Ok(status)
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

    /// The captain's choice is theirs until they say otherwise, and saying so
    /// is what gives the app's own home back. Everything else the file holds,
    /// including what they left running per home, stays.
    #[test]
    fn forgetting_a_chosen_home_keeps_the_rest_of_the_file() {
        let dir = scratch("forget");
        let home = dir.join("chosen");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("AGENTS.md"), "# firstmate").unwrap();
        save_home(&dir, &home).unwrap();
        remember_running(&dir, &home, true).unwrap();
        assert_eq!(read_saved_home(&dir).as_deref(), Some(home.as_path()));

        forget_home(&dir).unwrap();
        assert_eq!(read_saved_home(&dir), None, "the chosen home was not forgotten");
        assert!(was_running(&dir, &home), "what was left running was forgotten with it");
        // Forgetting twice is not an error, and neither is forgetting nothing.
        forget_home(&dir).unwrap();
        assert_eq!(read_saved_home(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn a_first_mate_left_running_starts_again_and_a_stopped_one_does_not() {
        let dir = scratch("running");
        let home = scratch("running-home");
        std::fs::write(home.join("AGENTS.md"), "# firstmate").unwrap();
        std::fs::create_dir(home.join("bin")).unwrap();
        let other = scratch("running-other");
        save_home(&dir, &home).unwrap();
        assert_eq!(status_in(&dir)["start_on_launch"], json!(false), "never started");

        remember_running(&dir, &home, true).unwrap();
        assert_eq!(status_in(&dir)["start_on_launch"], json!(true));
        assert!(!was_running(&dir, &other), "remembered per home");

        // Choosing another home and coming back keeps what each one was doing.
        save_home(&dir, &other).unwrap();
        save_home(&dir, &home).unwrap();
        assert_eq!(status_in(&dir)["start_on_launch"], json!(true));

        remember_running(&dir, &home, false).unwrap();
        assert_eq!(status_in(&dir)["start_on_launch"], json!(false));
        assert_eq!(read_saved_home(&dir), Some(home.clone()), "the home survives");

        // The same home under another spelling is the same home.
        let spelled = home.join("bin").join("..");
        remember_running(&dir, &spelled, true).unwrap();
        assert!(was_running(&dir, &home));
        for folder in [dir, home, other] {
            let _ = std::fs::remove_dir_all(folder);
        }
    }
}
