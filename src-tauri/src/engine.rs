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
    match override_dir("QUARTERDECK_ENGINE_DIR") {
        Some(named) => check_engine(&named),
        None => {
            let resources = tauri::Manager::path(app)
                .resource_dir()
                .map_err(|e| format!("the app has no resource folder: {e}"))?;
            check_engine(&resources.join("engine"))
        }
    }
}

/// A directory an environment variable names, if it names one. An empty
/// variable names nothing: it must not resolve to the current directory, or to
/// the app data folder's own root.
fn override_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|dir| !dir.is_empty()).map(PathBuf::from)
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
    if let Some(dir) = override_dir("QUARTERDECK_HOME_DIR") {
        return Ok(dir);
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
    let told = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        // The script names itself on the line carrying the reason. A usage
        // failure prints a usage line after it, which is not the reason, and a
        // late failure has already printed what it did to stdout.
        let why = said
            .lines()
            .find_map(|line| line.strip_prefix("fm-home-init:").map(str::trim))
            .filter(|reason| !reason.is_empty())
            .or_else(|| said.lines().last())
            .unwrap_or("it gave no reason");
        log::warn!("the first mate's home was refused; it said: {said}; it had done: {told}");
        return Err(format!("the first mate's home could not be prepared: {why}"));
    }
    if !said.is_empty() {
        // Waiting on another copy of the script, and anything else it wanted said.
        log::info!("laying out the first mate's home: {}", said.replace('\n', "; "));
    }
    Ok(told)
}

/// Rebinds the home's registered watches to the engine's current bytes.
///
/// A watch records the hash of the executable it will run, so a watch armed
/// against a previous copy of the engine is refused on its next fire and dies
/// without saying so. Updating the app replaces those bytes at the same path,
/// which is exactly that case, so this runs after every layout. It is
/// idempotent: a watch whose action already matches is left alone.
///
/// A home with no watches, and a watch broken for some other reason, are both
/// things to report rather than to fail a launch over.
pub(crate) fn rebind_watches(home: &Path) -> Result<String, String> {
    let script = home.join("bin/fm-procevent-when.sh");
    if !script.is_file() {
        return Ok(String::new());
    }
    let output = Command::new(&script)
        .arg("rebind-all")
        .current_dir(home)
        .env("FM_HOME", home)
        .env("PATH", crate::envpath::search_path())
        .output()
        .map_err(|e| format!("could not run {}: {e}", script.display()))?;
    let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let told = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(format!("the first mate's watches could not be rebound: {}", if said.is_empty() { told } else { said }));
    }
    Ok(if told.is_empty() { said } else { told })
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

    /// A home whose watches were armed against an older copy of the engine.
    #[test]
    fn the_homes_watches_are_rebound_to_the_engine_now_installed() {
        let dir = scratch("rebind");
        let home = dir.join("home");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        // Nothing to rebind is not a failure: a home may have no watches, and
        // a home the captain chose may predate the script entirely.
        assert_eq!(rebind_watches(&home).unwrap(), "");

        let script = home.join("bin/fm-procevent-when.sh");
        std::fs::write(&script, "#!/bin/sh\nprintf 'rebound %s in %s\\n' \"$1\" \"$FM_HOME\"\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let said = rebind_watches(&home).unwrap();
        assert!(said.starts_with("rebound rebind-all in "), "{said}");
        assert!(said.ends_with(home.to_str().unwrap()), "the home was not the one rebound: {said}");

        std::fs::write(&script, "#!/bin/sh\nprintf 'a watch is broken\\n' >&2\nexit 1\n").unwrap();
        let problem = rebind_watches(&home).unwrap_err();
        assert!(problem.contains("a watch is broken"), "{problem}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every file under a directory, by path, size and last change.
    fn manifest(dir: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
        let mut found = Vec::new();
        let mut walk = vec![dir.to_path_buf()];
        while let Some(here) = walk.pop() {
            let Ok(entries) = std::fs::read_dir(&here) else { continue };
            for entry in entries.flatten() {
                // symlink_metadata: a link's own record, never what it points at,
                // so a link into the home could not hide a change here.
                let Ok(about) = entry.metadata().or_else(|_| entry.path().symlink_metadata()) else { continue };
                if about.is_dir() {
                    walk.push(entry.path());
                } else {
                    found.push((entry.path(), about.len(), about.modified().unwrap_or(std::time::UNIX_EPOCH)));
                }
            }
        }
        found.sort();
        found
    }

    /// An empty variable names nothing. Left to resolve, it would send the
    /// engine lookup at the current directory and the home at the app data
    /// folder's own root, which is not a home and must not be laid out as one.
    #[test]
    fn an_empty_override_names_nothing() {
        // A name no test sets, so this reads the absent case without touching
        // the environment other tests are running against.
        assert_eq!(override_dir("QUARTERDECK_NOTHING_NAMES_THIS"), None);
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
        let before = manifest(&engine);
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

        // The copy the app ships was not written to. Every file it holds, by
        // name, size and last change: git status would answer for whatever else
        // is uncommitted in the checkout, and would say nothing at all about
        // the directories the engine's own .gitignore hides, which are exactly
        // the ones a home is made of.
        assert_eq!(manifest(&engine), before, "laying out a home changed the engine");

        let _ = std::fs::remove_dir_all(&dir);
    }

}
