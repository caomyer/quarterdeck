//! Calm, the captain's choice about how the first mate's conversation reads,
//! through firstmate's own command.
//!
//! `bin/fm-calm.sh` reads and writes the home's `config/calm`, the one
//! preference Pi's and Claude Code's `/calm` also set, so one switch governs
//! every surface of the home. The app never writes the file itself. A home
//! whose firstmate predates the command reads as unavailable, and the chat
//! reads as it always has.
//!
//! Commands: `calm_get`, `calm_set`.

use crate::envpath;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;

const SCRIPT: &str = "bin/fm-calm.sh";

/// It reads or writes one small file; anything this slow is stuck.
const TIMEOUT: Duration = Duration::from_secs(15);

/// One change at a time, so two quick clicks cannot interleave their writes.
static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

/// What the window reads: whether this home can keep the choice, the choice, and why not.
fn view(on: bool) -> Value {
    json!({"available": true, "on": on, "problem": null})
}

fn unavailable(problem: String) -> Value {
    json!({"available": false, "on": false, "problem": problem})
}

/// Runs one verb in the home. `Ok` is the value it printed; `Err` is its reason, without its name.
async fn run(home: &Path, args: &[&str]) -> Result<bool, String> {
    let script = home.join(SCRIPT);
    let output = envpath::command(&script)
        .args(args)
        .env("FM_HOME", home)
        .env_remove("FM_CONFIG_OVERRIDE")
        .env_remove("FM_ROOT_OVERRIDE")
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(TIMEOUT, output).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("could not run {SCRIPT}: {e}")),
        Err(_) => return Err(format!("{SCRIPT} did not finish within {}s", TIMEOUT.as_secs())),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let line = stderr.lines().rev().map(str::trim).find(|line| !line.is_empty());
        return Err(match line {
            Some(line) => line.strip_prefix("fm-calm:").map(str::trim).unwrap_or(line).to_string(),
            None => format!("{SCRIPT} stopped ({})", output.status),
        });
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "on" => Ok(true),
        "off" => Ok(false),
        other => Err(format!("{SCRIPT} answered '{other}', not on or off")),
    }
}

/// This home's Calm choice.
pub(crate) async fn read(home: &Path) -> Value {
    if !home.join(SCRIPT).is_file() {
        return unavailable("Calm needs a newer firstmate: this home has no fm-calm.sh.".to_string());
    }
    match run(home, &["get"]).await {
        Ok(on) => view(on),
        Err(problem) => json!({"available": true, "on": false, "problem": problem}),
    }
}

/// Sets this home's Calm choice. Refused, in the script's words, when it could not be kept.
pub(crate) async fn write(home: &Path, on: bool) -> Result<Value, String> {
    if !home.join(SCRIPT).is_file() {
        return Err("Calm needs a newer firstmate: this home has no fm-calm.sh.".to_string());
    }
    let _one_at_a_time = WRITER.lock().await;
    run(home, &["set", if on { "on" } else { "off" }]).await.map(view)
}

#[tauri::command]
pub async fn calm_get(app: AppHandle) -> Result<Value, String> {
    Ok(read(&home_for(&app)?).await)
}

#[tauri::command]
pub async fn calm_set(on: bool, app: AppHandle) -> Result<Value, String> {
    write(&home_for(&app)?, on).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A home with this repository's own engine script, the way a real home has it.
    fn home(name: &str, with_script: bool) -> PathBuf {
        let home = std::env::temp_dir().join(format!("qd-calm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::create_dir_all(home.join("config")).unwrap();
        if with_script {
            let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine").join(SCRIPT);
            std::fs::copy(engine, home.join(SCRIPT)).unwrap();
        }
        home
    }

    #[tokio::test]
    async fn the_switch_goes_through_the_engine_command() {
        let home = home("switch", true);
        assert_eq!(read(&home).await, json!({"available": true, "on": false, "problem": null}));
        assert_eq!(write(&home, true).await.unwrap()["on"], true);
        assert_eq!(std::fs::read_to_string(home.join("config/calm")).unwrap(), "on\n", "written by fm-calm.sh, as the integrations write it");
        // A terminal session's /calm on the same home is what the window reads next.
        std::fs::write(home.join("config/calm"), "off\n").unwrap();
        assert_eq!(read(&home).await["on"], false);
        std::fs::write(home.join("config/calm"), "max\n").unwrap();
        assert_eq!(read(&home).await["on"], true, "the legacy value reads as on");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn a_write_that_fails_says_why_in_the_scripts_words() {
        let home = home("denied", true);
        std::fs::write(home.join("config/calm"), "on\n").unwrap();
        let mut perms = std::fs::metadata(home.join("config")).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o555);
        std::fs::set_permissions(home.join("config"), perms.clone()).unwrap();
        let refused = write(&home, false).await;
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(home.join("config"), perms).unwrap();
        let on = read(&home).await["on"].clone();
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(refused.unwrap_err(), "config/calm: Permission denied");
        assert_eq!(on, true, "the choice stays as it was");
    }

    #[tokio::test]
    async fn a_home_without_the_command_is_unavailable_and_nothing_is_written() {
        let home = home("old", false);
        let seen = read(&home).await;
        let refused = write(&home, true).await;
        let written = home.join("config/calm").exists();
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(seen, json!({"available": false, "on": false, "problem": "Calm needs a newer firstmate: this home has no fm-calm.sh."}));
        assert!(refused.unwrap_err().contains("newer firstmate"));
        assert!(!written, "the app never writes config/calm itself");
    }
}
