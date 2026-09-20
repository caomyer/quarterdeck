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
/// The engine's own copy of the script is the one to run, not the home's.
/// They are the same file, but the script takes the directory above itself as
/// the code it may rebind, and reached through the home's `bin` link that is
/// the home. A watch's action resolves to its physical path, inside the
/// engine, so every one of them would be judged out of scope and the run would
/// report success having rebound nothing.
///
/// A home with no watches, and a watch broken for some other reason, are both
/// things to report rather than to fail a launch over.
pub(crate) fn rebind_watches(engine: &Path, home: &Path) -> Result<String, String> {
    let script = engine.join("bin/fm-procevent-when.sh");
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
        std::fs::create_dir_all(&home).unwrap();
        let engine = dir.join("engine");
        std::fs::create_dir_all(engine.join("bin")).unwrap();
        // Nothing to rebind is not a failure: an engine may predate the script.
        assert_eq!(rebind_watches(&engine, &home).unwrap(), "");

        let script = engine.join("bin/fm-procevent-when.sh");
        let executable = |path: &Path| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        };
        std::fs::write(&script, "#!/bin/sh\nprintf 'ran %s from %s in %s\\n' \"$1\" \"$0\" \"$FM_HOME\"\n").unwrap();
        executable(&script);
        // The home mirrors the engine, so the same script is reachable through
        // the home's own bin. Running that copy is what leaves every watch out
        // of scope, so the call must be the engine's.
        #[cfg(unix)]
        std::os::unix::fs::symlink(engine.join("bin"), home.join("bin")).unwrap();

        let said = rebind_watches(&engine, &home).unwrap();
        assert!(said.starts_with("ran rebind-all from "), "{said}");
        assert!(
            said.contains(engine.join("bin/fm-procevent-when.sh").to_str().unwrap()),
            "the home's copy was run rather than the engine's: {said}"
        );
        assert!(said.ends_with(home.to_str().unwrap()), "the home was not the one rebound: {said}");

        std::fs::write(&script, "#!/bin/sh\nprintf 'a watch is broken\\n' >&2\nexit 1\n").unwrap();
        let problem = rebind_watches(&engine, &home).unwrap_err();
        assert!(problem.contains("a watch is broken"), "{problem}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole thing, against the engine's real script: a home laid out from
    /// a copy of the engine, a watch armed on an action inside that copy, the
    /// copy's bytes then changed as an app update changes them, and the watch
    /// following. Reached through the home's own bin this reports success
    /// having rebound nothing, which is the shape the bug had.
    #[test]
    fn a_real_watch_follows_a_real_engine_that_changed() {
        let Ok(source) = check_engine(&real_engine()) else { return };
        let dir = scratch("rebind-live");
        let engine = dir.join("engine");
        let copied = Command::new("cp").arg("-R").arg(&source).arg(&engine).status();
        if !copied.map(|status| status.success()).unwrap_or(false) {
            panic!("could not copy the engine");
        }
        let action = engine.join("bin/fm-rebind-probe.sh");
        std::fs::write(&action, "#!/usr/bin/env bash\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&action, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let home = dir.join("home");
        prepare_home(&engine, &home).expect("the copy could not lay out a home");

        let armed = Command::new(home.join("bin/fm-procevent-when.sh"))
            .args(["arm", "rebindprobe", "--condition", "/usr/bin/true", "--action"])
            .arg(home.join("bin/fm-rebind-probe.sh"))
            .current_dir(&home)
            .env("FM_HOME", &home)
            .env("PATH", crate::envpath::search_path())
            .output()
            .expect("could not arm a watch");
        assert!(armed.status.success(), "could not arm a watch: {}", String::from_utf8_lossy(&armed.stderr));

        // The app update: same path, different bytes.
        std::fs::write(&action, "#!/usr/bin/env bash\n# the app updated\nexit 0\n").unwrap();
        let said = rebind_watches(&engine, &home).expect("rebinding failed");
        assert!(said.contains("rebound: when-rebindprobe"), "the watch did not follow the engine: {said}");
        assert!(said.contains("1 rebound"), "{said}");

        // Idempotent: nothing left to do on the launch after.
        let again = rebind_watches(&engine, &home).expect("rebinding failed");
        assert!(again.contains("0 rebound"), "a second launch rebound something again: {again}");
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

    /// Where the build put the copied resources: OUT_DIR is
    /// <target>/<profile>/build/<crate>-<hash>/out, so the copy is three levels
    /// up. This is the tree that ships, not the one in the repository.
    fn copied_engine() -> Option<PathBuf> {
        let out = Path::new(env!("OUT_DIR"));
        let profile = out.parent()?.parent()?.parent()?;
        let engine = profile.join("engine");
        engine.is_dir().then_some(engine)
    }

    /// The copy, not the source. Tauri's resource copy decides an entry is a
    /// directory by a question that follows symlinks, and then skips it, so the
    /// engine's two directory links once arrived as nothing at all and the
    /// bundled first mate had no skills. The source tree cannot see that: it
    /// has the links.
    #[test]
    fn the_copy_that_ships_carries_what_the_links_point_at() {
        let Some(engine) = copied_engine() else {
            // Nothing to check before the resources have been copied once.
            return;
        };
        let engine = check_engine(&engine).expect("the copied engine is not laid out as one");
        let skills = engine.join(".claude/skills");
        assert!(skills.is_dir(), "the copy has no .claude/skills, so the first mate ships with no skills");
        assert!(skills.join("bearings/SKILL.md").is_file(), ".claude/skills arrived empty");
        assert!(
            engine.join(".agents/skills/firstmate-calm/.claude-plugin/plugin.json").is_file(),
            "the copy has no firstmate-calm"
        );

        // And it lays out a home, which is the whole point of shipping it.
        let dir = scratch("copy");
        let home = dir.join("home");
        let said = prepare_home(&engine, &home).unwrap();
        assert!(said.contains("ok"), "the copy could not lay out a home: {said}");
        assert!(home.join(".claude/skills/bearings/SKILL.md").is_file(), "the home cannot reach the first mate's skills");
        let _ = std::fs::remove_dir_all(&dir);
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
