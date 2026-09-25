//! Updates to the app itself: found, fetched and verified on their own, then
//! installed only when the captain says, or when they quit.
//!
//! A release publishes `latest.json` beside a signed `.app.tar.gz`
//! (`.github/workflows/release.yml`). The app reads it shortly after launch and
//! every few hours, downloads a newer version in the background, and holds it
//! until the captain asks for the restart. The updater checks the download
//! against the public key in `tauri.conf.json` before anything is kept, so an
//! endpoint can offer nothing it did not sign.
//!
//! Installing replaces the bundle, and with it the engine the home links into,
//! so it never happens under a turn: a restart the captain asks for waits until
//! the first mate is not working, then swaps the bundle and relaunches, and the
//! relaunch starts the first mate again as any relaunch does. Quitting installs
//! a waiting update too, after the first mate is stopped, but only where no
//! password prompt is needed: the exit handler cannot show one.
//!
//! What was installed is noted in the settings folder before the relaunch, so
//! the new version can say once what changed. Reading it never removes it: a
//! note naming a version other than the one running is a swap that did not
//! take, and is dropped once, at launch, before this process can write another.
//!
//! Only a release build looks for updates, and `QUARTERDECK_UPDATES=off` stops
//! even that, for a build an agent launches to test.
//!
//! Commands: `update_status`, `update_restart`, `update_cancel`, `update_seen`.
//! Event: `app_update`, the whole status each time it changes.

use crate::host::{Cmd, HostHandle};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State as TauriState};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Long enough after launch that the home is laid out and the first mate started.
const FIRST_CHECK: Duration = Duration::from_secs(20);
/// Releases follow merges, so a few hours is soon enough and never a burden.
const EVERY: Duration = Duration::from_secs(4 * 60 * 60);
/// How often a restart that is waiting asks whether the turn has ended.
const TURN_POLL: Duration = Duration::from_millis(500);
const NOTE_FILE: &str = "update-note.json";
const EVENT: &str = "app_update";

/// Host states in which the first mate is doing something a restart would cut short.
const BUSY: [&str; 4] = ["prompt_turn", "agent_turn", "starting", "restarting"];

/// A version downloaded and verified, waiting to be installed.
struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

/// What the status names of the update held.
trait Held {
    fn version(&self) -> &str;
    fn notes(&self) -> Option<&str>;
}

impl Held for Ready {
    fn version(&self) -> &str {
        &self.update.version
    }
    fn notes(&self) -> Option<&str> {
        self.update.body.as_deref()
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    /// Nothing asked of it: an update, if one is ready, waits for the captain.
    Idle,
    /// The captain asked for the restart and the first mate is still working.
    Waiting,
    Installing,
    /// Installing failed; the update is still held, so asking again retries it.
    Failed(String),
}

pub struct Updates {
    inner: Mutex<Inner>,
}

/// The update held stays here while it installs, so the status names it
/// throughout and a failed install can be asked for again.
struct Inner<T = Ready> {
    ready: Option<Arc<T>>,
    phase: Phase,
}

impl<T: Held> Inner<T> {
    /// Moves a waiting restart to installing, handing over what to install.
    fn start_install(&mut self) -> Option<Arc<T>> {
        if self.phase != Phase::Waiting {
            return None;
        }
        let ready = self.ready.clone()?;
        self.phase = Phase::Installing;
        Some(ready)
    }

    fn view(&self) -> Value {
        let state = match (&self.phase, &self.ready) {
            (Phase::Waiting, _) => "waiting",
            (Phase::Installing, _) => "installing",
            (Phase::Failed(_), _) => "failed",
            (Phase::Idle, Some(_)) => "ready",
            (Phase::Idle, None) => "none",
        };
        json!({
            "state": state,
            "version": self.ready.as_ref().map(|ready| ready.version()),
            "notes": self.ready.as_ref().and_then(|ready| ready.notes()),
            "error": match &self.phase { Phase::Failed(error) => Some(error.as_str()), _ => None },
        })
    }
}

impl Default for Updates {
    fn default() -> Self {
        Updates { inner: Mutex::new(Inner { ready: None, phase: Phase::Idle }) }
    }
}

impl Updates {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Whether this build looks for updates at all.
fn enabled() -> bool {
    !cfg!(debug_assertions) && !std::env::var("QUARTERDECK_UPDATES").is_ok_and(|value| value == "off")
}

/// Starts looking for updates, in a release build.
pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(problem) = check(&app).await {
                // Offline, or a release still being published: the next check tries again.
                log::warn!("could not check for an update: {problem}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// One check: a version newer than both the running one and the one already
/// held is downloaded, verified, and held.
async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updates = app.state::<Updates>();
    if matches!(updates.lock().phase, Phase::Waiting | Phase::Installing) {
        return Ok(());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if updates.lock().ready.as_ref().is_some_and(|ready| ready.update.version == update.version) {
        return Ok(());
    }
    log::info!("downloading version {} of the app", update.version);
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    {
        let mut inner = updates.lock();
        // A restart asked for meanwhile installs what it was shown, not this.
        if matches!(inner.phase, Phase::Waiting | Phase::Installing) {
            return Ok(());
        }
        inner.ready = Some(Arc::new(Ready { update, bytes }));
        inner.phase = Phase::Idle;
    }
    emit(app);
    Ok(())
}

fn status<R: Runtime>(app: &AppHandle<R>) -> Value {
    let current = app.package_info().version.to_string();
    let mut view = app.state::<Updates>().inner().lock().view();
    view["installed"] = crate::settings::settings_dir(app).map(|dir| read_note_in(&dir, &current)).unwrap_or(Value::Null);
    view["current"] = Value::String(current);
    view
}

fn emit<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(EVENT, status(app));
}

fn set_phase<R: Runtime>(app: &AppHandle<R>, phase: Phase) {
    app.state::<Updates>().inner().lock().phase = phase;
    emit(app);
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> Value {
    status(&app)
}

/// Restarts into the waiting update once the first mate is not in a turn.
/// Answers at once; how it goes arrives as `app_update` events.
#[tauri::command]
pub fn update_restart(app: AppHandle, updates: TauriState<'_, Updates>) -> Result<Value, String> {
    {
        let mut inner = updates.lock();
        if inner.ready.is_none() {
            return Err("No update is waiting to be installed.".to_string());
        }
        if matches!(inner.phase, Phase::Waiting | Phase::Installing) {
            drop(inner);
            return Ok(status(&app));
        }
        inner.phase = Phase::Waiting;
    }
    emit(&app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { restart_when_idle(handle).await });
    Ok(status(&app))
}

/// Takes back a restart that is still waiting for a turn to end.
#[tauri::command]
pub fn update_cancel(app: AppHandle, updates: TauriState<'_, Updates>) -> Value {
    {
        let mut inner = updates.lock();
        if inner.phase == Phase::Waiting {
            inner.phase = Phase::Idle;
        }
    }
    emit(&app);
    status(&app)
}

/// The captain has read what the last update changed.
#[tauri::command]
pub fn update_seen(app: AppHandle) -> Value {
    if let Ok(dir) = crate::settings::settings_dir(&app) {
        let _ = std::fs::remove_file(dir.join(NOTE_FILE));
    }
    emit(&app);
    status(&app)
}

async fn restart_when_idle(app: AppHandle) {
    loop {
        if app.state::<Updates>().inner().lock().phase != Phase::Waiting {
            return;
        }
        let state = match app.try_state::<HostHandle>() {
            Some(host) => host.call(|reply| Cmd::GetState { reply }).await.ok(),
            None => None,
        };
        let busy = state.as_ref().and_then(|state| state["state"].as_str()).is_some_and(|state| BUSY.contains(&state));
        if !busy {
            break;
        }
        tokio::time::sleep(TURN_POLL).await;
    }
    let Some(ready) = app.state::<Updates>().inner().lock().start_install() else { return };
    emit(&app);
    // Off the async runtime: extracting the bundle is blocking work, and a
    // bundle the captain cannot write asks macOS for a password on the main thread.
    let installing = ready.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || installing.update.install(&installing.bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result);
    match installed {
        Ok(()) => {
            write_note(&app, &ready.update);
            log::info!("installed version {}; restarting into it", ready.update.version);
            // The exit handler stops the first mate, as on any quit; the relaunch starts it again.
            app.request_restart();
        }
        Err(error) => {
            log::warn!("could not install version {}: {error}", ready.update.version);
            set_phase(&app, Phase::Failed(error));
        }
    }
}

/// For the app's exit handler, after the first mate is stopped: installs an
/// update that is waiting, so the next launch is the new version. Skipped when
/// installing would need a password, which nothing can ask for while exiting.
pub fn install_on_exit<R: Runtime>(app: &AppHandle<R>) {
    let Some(updates) = app.try_state::<Updates>() else { return };
    let ready = {
        let mut inner = updates.lock();
        if inner.phase == Phase::Installing {
            return;
        }
        inner.ready.take()
    };
    let Some(ready) = ready else { return };
    let writable = std::env::current_exe().ok().and_then(|exe| app_bundle(&exe)).is_some_and(|bundle| can_replace(&bundle));
    if !writable {
        log::info!("version {} waits for a restart from the app: installing it needs a password", ready.update.version);
        return;
    }
    match ready.update.install(&ready.bytes) {
        Ok(()) => {
            write_note(app, &ready.update);
            log::info!("installed version {} on quit", ready.update.version);
        }
        Err(error) => log::warn!("could not install version {} on quit: {error}", ready.update.version),
    }
}

/// The `.app` a binary runs from: `<bundle>.app/Contents/MacOS/<binary>`.
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Replacing a bundle moves it out of its folder and a new one in: both need write access.
fn can_replace(bundle: &Path) -> bool {
    let writable = |path: &Path| {
        let Ok(path) = std::ffi::CString::new(path.as_os_str().to_string_lossy().as_bytes()) else { return false };
        // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
        unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
    };
    bundle.parent().is_some_and(writable) && writable(bundle)
}

fn write_note<R: Runtime>(app: &AppHandle<R>, update: &Update) {
    let note = json!({"from": update.current_version, "to": update.version, "notes": update.body, "at_ms": now_ms()});
    let written = crate::settings::settings_dir(app).and_then(|dir| write_note_in(&dir, &note));
    if let Err(problem) = written {
        log::warn!("could not note what the update changed: {problem}");
    }
}

fn write_note_in(dir: &Path, note: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let partial = dir.join(format!("{NOTE_FILE}.tmp"));
    std::fs::write(&partial, note.to_string()).map_err(|e| format!("could not write {}: {e}", partial.display()))?;
    std::fs::rename(&partial, dir.join(NOTE_FILE)).map_err(|e| format!("could not save {}: {e}", dir.join(NOTE_FILE).display()))
}

/// For the app's setup, before anything can install: drops a note left by a
/// swap that did not take.
pub fn settle_note<R: Runtime>(app: &AppHandle<R>) {
    let current = app.package_info().version.to_string();
    if let Ok(dir) = crate::settings::settings_dir(app) {
        settle_note_in(&dir, &current);
    }
}

fn settle_note_in(dir: &Path, current: &str) {
    let Some(note) = load_note(dir) else { return };
    if note["to"].as_str() != Some(current) {
        log::warn!("dropping the note for version {}, which is not the version running ({current})", note["to"]);
        let _ = std::fs::remove_file(dir.join(NOTE_FILE));
    }
}

/// What the last update installed, while it is the version running.
fn read_note_in(dir: &Path, current: &str) -> Value {
    match load_note(dir) {
        Some(note) if note["to"].as_str() == Some(current) => json!({"version": note["to"], "from": note["from"], "notes": note["notes"]}),
        _ => Value::Null,
    }
}

fn load_note(dir: &Path) -> Option<Value> {
    std::fs::read_to_string(dir.join(NOTE_FILE)).ok().and_then(|text| serde_json::from_str(&text).ok())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qd-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fake;

    impl Held for Fake {
        fn version(&self) -> &str {
            "0.1.5"
        }
        fn notes(&self) -> Option<&str> {
            Some("Faster start")
        }
    }

    #[test]
    fn the_update_is_named_while_it_installs_and_after_it_fails() {
        let mut inner = Inner { ready: Some(Arc::new(Fake)), phase: Phase::Idle };
        assert!(inner.start_install().is_none(), "only a restart that is waiting installs");
        inner.phase = Phase::Waiting;
        assert!(inner.start_install().is_some());
        assert_eq!(inner.view(), json!({"state": "installing", "version": "0.1.5", "notes": "Faster start", "error": null}));
        inner.phase = Phase::Failed("disk full".to_string());
        assert_eq!(inner.view(), json!({"state": "failed", "version": "0.1.5", "notes": "Faster start", "error": "disk full"}));
        inner.phase = Phase::Waiting;
        assert!(inner.start_install().is_some(), "asking again retries the update held");
    }

    #[test]
    fn a_note_is_read_only_while_its_version_runs() {
        let dir = scratch("note");
        write_note_in(&dir, &json!({"from": "0.1.4", "to": "0.1.5", "notes": "Faster start"})).unwrap();
        assert_eq!(read_note_in(&dir, "0.1.4"), Value::Null, "the old version is still running");
        assert!(dir.join(NOTE_FILE).is_file(), "reading before the relaunch keeps it");
        assert_eq!(read_note_in(&dir, "0.1.5"), json!({"version": "0.1.5", "from": "0.1.4", "notes": "Faster start"}));
        assert!(dir.join(NOTE_FILE).is_file(), "reading does not dismiss it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn launch_drops_only_a_note_for_another_version() {
        let dir = scratch("settle");
        write_note_in(&dir, &json!({"from": "0.1.4", "to": "0.1.5", "notes": "Faster start"})).unwrap();
        settle_note_in(&dir, "0.1.5");
        assert!(dir.join(NOTE_FILE).is_file(), "the swap took");
        assert_eq!(read_note_in(&dir, "0.1.5"), json!({"version": "0.1.5", "from": "0.1.4", "notes": "Faster start"}));
        settle_note_in(&dir, "0.1.4");
        assert!(!dir.join(NOTE_FILE).exists(), "the swap did not take");
        assert_eq!(read_note_in(&dir, "0.1.5"), Value::Null);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_bundle_is_found_from_its_binary() {
        let exe = Path::new("/Applications/firstmate desktop.app/Contents/MacOS/firstmate-desktop");
        assert_eq!(app_bundle(exe), Some(PathBuf::from("/Applications/firstmate desktop.app")));
        assert_eq!(app_bundle(Path::new("/repo/src-tauri/target/release/firstmate-desktop")), None);
    }

    #[test]
    fn a_bundle_in_a_folder_the_captain_cannot_write_is_not_replaced_on_quit() {
        let dir = scratch("writable");
        let bundle = dir.join("Q.app");
        std::fs::create_dir_all(&bundle).unwrap();
        assert!(can_replace(&bundle));
        let mut locked = std::fs::metadata(&dir).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut locked, 0o555);
        std::fs::set_permissions(&dir, locked).unwrap();
        let refused = !can_replace(&bundle);
        let mut open = std::fs::metadata(&dir).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut open, 0o755);
        std::fs::set_permissions(&dir, open).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(refused);
    }
}
