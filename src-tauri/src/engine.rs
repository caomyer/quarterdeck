//! The first mate's own code, shipped inside the app, and the home it runs in.
//!
//! The engine is `engine/` in this repository, bundled as a resource, so the
//! captain installs one app and never points it at a copy of firstmate they had
//! to fetch themselves. That copy is read-only and is no git checkout, so it
//! cannot be a home: `bin/fm-home-init.sh` builds one beside it, in the app's
//! data folder, whose every top-level entry links back into the copy. To the
//! harness and to every script that home looks exactly like a checkout.
//!
//! It runs on every launch, not only the first. It is idempotent, and it is
//! what repoints a home at the engine after the app updates or moves.
//!
//! `QUARTERDECK_ENGINE_DIR` and `QUARTERDECK_HOME_DIR` replace the bundled copy
//! and the managed home, so a test run uses a scratch pair and never the
//! captain's own.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The marker that tells a directory holding the engine from any other.
const ENTRYPOINT: &str = "bin/fm-home-init.sh";

/// The engine's code: the bundled copy, or what `QUARTERDECK_ENGINE_DIR` names.
pub(crate) fn bundled_engine<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("QUARTERDECK_ENGINE_DIR").filter(|dir| !dir.is_empty()) {
        return check_engine(Path::new(&dir));
    }
    let resources = tauri::Manager::path(app)
        .resource_dir()
        .map_err(|e| format!("the app has no resource folder: {e}"))?;
    check_engine(&resources.join("engine"))
}

/// An engine is a directory holding the script that lays out a home.
fn check_engine(dir: &Path) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(dir)
        .map_err(|e| format!("{} can't be opened: {e}.", dir.display()))?;
    if !resolved.join(ENTRYPOINT).is_file() {
        return Err(format!("{} has no {ENTRYPOINT}, so it is not the first mate's code.", resolved.display()));
    }
    Ok(resolved)
}

/// The home the app owns, in its data folder: `QUARTERDECK_HOME_DIR` replaces it.
/// The folder need not exist yet; laying it out is `prepare_home`'s work.
pub(crate) fn managed_home<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("QUARTERDECK_HOME_DIR").filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    tauri::Manager::path(app)
        .app_data_dir()
        .map(|dir| dir.join("home"))
        .map_err(|e| format!("no app data folder: {e}"))
}

/// Lays the home out from the engine, and returns what the script reported.
///
/// The script refuses a directory that is neither empty nor already one of its
/// homes, so a captain's own firstmate folder is never rearranged by this: the
/// refusal is returned as it was written, to be shown rather than guessed at.
pub(crate) fn prepare_home(engine: &Path, home: &Path) -> Result<String, String> {
    if let Some(parent) = home.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let script = engine.join(ENTRYPOINT);
    let output = Command::new(&script)
        .arg("--home")
        .arg(home)
        // The script reads FM_HOME when --home is absent; a stray one from the
        // captain's shell must not decide where the app's home goes.
        .env_remove("FM_HOME")
        .env("PATH", crate::envpath::search_path())
        .output()
        .map_err(|e| format!("could not run {}: {e}", script.display()))?;
    let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let why = said.lines().last().unwrap_or("it gave no reason").to_string();
        return Err(format!("the first mate's home could not be prepared: {why}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qd-engine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An engine whose entrypoint is a script the test can watch.
    fn fake_engine(dir: &Path, body: &str) -> PathBuf {
        let engine = dir.join("engine");
        std::fs::create_dir_all(engine.join("bin")).unwrap();
        let script = engine.join(ENTRYPOINT);
        std::fs::write(&script, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        engine
    }

    #[test]
    fn a_directory_without_the_entrypoint_is_not_the_engine() {
        let dir = scratch("not-engine");
        let problem = check_engine(&dir).unwrap_err();
        assert!(problem.contains("is not the first mate's code"), "{problem}");
        assert!(check_engine(&dir.join("nowhere")).unwrap_err().contains("can't be opened"));
        let engine = fake_engine(&dir, "#!/bin/sh\nexit 0\n");
        assert_eq!(check_engine(&engine).unwrap(), std::fs::canonicalize(&engine).unwrap());
    }

    #[test]
    fn the_home_is_laid_out_by_the_engines_own_script() {
        let dir = scratch("prepare");
        let engine = fake_engine(&dir, "#!/bin/sh\nprintf 'home: %s\\n' \"$2\"\nprintf 'ok\\n'\nexit 0\n");
        let home = dir.join("data").join("home");
        let said = prepare_home(&engine, &home).unwrap();
        assert!(said.contains(home.to_str().unwrap()), "{said}");
        assert!(dir.join("data").is_dir(), "the home's parent was not created");
    }

    #[test]
    fn a_refusal_is_reported_in_the_scripts_own_words() {
        let dir = scratch("refused");
        let engine = fake_engine(&dir, "#!/bin/sh\nprintf 'fm-home-init: not empty\\n' >&2\nexit 1\n");
        let problem = prepare_home(&engine, &dir.join("home")).unwrap_err();
        assert!(problem.contains("not empty"), "{problem}");
    }

    /// The engine this repository ships, so the test reads what the app would.
    fn real_engine() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("engine")
    }

    /// The real script against the real engine: the app's whole first launch,
    /// minus the app. Nothing outside the scratch home is touched, and the
    /// engine is checked afterwards for having stayed read-only in practice.
    #[test]
    fn the_real_engine_lays_out_a_real_home() {
        let engine = match check_engine(&real_engine()) {
            Ok(engine) => engine,
            Err(why) => panic!("the engine this app ships is not where it should be: {why}"),
        };
        let dir = scratch("live");
        let home = dir.join("home");
        let said = prepare_home(&engine, &home).unwrap();
        assert!(said.contains("ok"), "the script did not finish: {said}");
        // Every top-level entry of the code is reachable from the home, and the
        // home's own directories are real, which is what makes it a home.
        assert!(std::fs::symlink_metadata(home.join("bin")).unwrap().is_symlink(), "bin is not a link into the code");
        assert!(home.join("bin/fm-home-init.sh").is_file(), "the link does not reach the code");
        assert!(home.join("state").is_dir() && !std::fs::symlink_metadata(home.join("state")).unwrap().is_symlink(), "state is not the home's own");
        assert!(home.join("AGENTS.md").is_file(), "the home cannot read the first mate's job description");
        assert!(home.join(".fm-home").is_file(), "the home carries no marker naming the code it mirrors");

        // Idempotent: a second launch repoints nothing and refuses nothing.
        let again = prepare_home(&engine, &home).unwrap();
        assert!(again.contains("ok"), "a second launch did not finish: {again}");
        assert!(!again.contains("relinked"), "a second launch moved links that had not moved: {again}");

        // The copy the app ships is read-only in practice, not only in intent.
        let dirty = std::process::Command::new("git")
            .args(["status", "--porcelain", "--", "."])
            .current_dir(&engine)
            .output()
            .expect("git could not read the engine");
        assert_eq!(String::from_utf8_lossy(&dirty.stdout).trim(), "", "laying out a home changed the engine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A home set in the captain's shell must not decide where the app's home goes.
    #[test]
    fn an_inherited_fm_home_is_not_passed_on() {
        let dir = scratch("fm-home");
        let engine = fake_engine(&dir, "#!/bin/sh\nprintf 'FM_HOME=[%s]\\n' \"${FM_HOME-unset}\"\nexit 0\n");
        // SAFETY: single-threaded test process; no other thread reads the environment.
        unsafe { std::env::set_var("FM_HOME", "/somewhere/else") };
        let said = prepare_home(&engine, &dir.join("home")).unwrap();
        unsafe { std::env::remove_var("FM_HOME") };
        assert_eq!(said, "FM_HOME=[unset]");
    }
}
