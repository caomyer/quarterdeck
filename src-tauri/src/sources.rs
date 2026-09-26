//! Task sources: issues elsewhere the fleet can take on, and where it reports
//! back, through firstmate's own script.
//!
//! `bin/fm-sources.sh` is the only reader of a provider and the only writer of
//! a link, and its header owns the verbs, the link, and what each prints. The
//! app runs it and reads back what it says; it never writes the home's
//! `config/sources.json`, a task's body, or anything under `data/sources/`
//! itself, and it holds no credential: GitHub reuses the first mate's `gh`
//! sign-in.
//!
//! Taking an item on is not here: it needs the first mate's judgement, so it is
//! a message on the start-work path (`start.rs`), and the first mate files it.
//!
//! Commands: `sources_get`, `sources_add`, `sources_edit`, `sources_remove`,
//! `sources_dismiss`, `sources_link`.

use crate::envpath;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;

/// Adding or editing a source asks the provider what the sign-in may do; anything slower is stuck.
const TIMEOUT: Duration = Duration::from_secs(45);

/// One change at a time, so two quick clicks cannot interleave their writes.
static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SCRIPT: &str = "bin/fm-sources.sh";

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

/// Runs one verb in the home. `Ok` is what it printed; `Err` is its reason, in
/// its own words without the script's name in front.
async fn run(home: &Path, args: &[&str]) -> Result<String, String> {
    let script = home.join(SCRIPT);
    let child = envpath::command(&script)
        .args(args)
        .env("FM_HOME", home)
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run {SCRIPT}: {e}"))?;
    let output = match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("{SCRIPT} could not be read: {e}")),
        Err(_) => return Err(format!("{SCRIPT} did not finish within {}s", TIMEOUT.as_secs())),
    };
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    Err(reason(&String::from_utf8_lossy(&output.stderr), &output.status.to_string()))
}

/// The script's reason for a refusal: its last line, without its name.
fn reason(stderr: &str, status: &str) -> String {
    let line = stderr.lines().rev().map(str::trim).find(|line| !line.is_empty());
    match line {
        Some(line) => line.strip_prefix("fm-sources:").map(str::trim).unwrap_or(line).to_string(),
        None => format!("{SCRIPT} stopped ({status})"),
    }
}

fn parse(stdout: &str) -> Result<Value, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("{SCRIPT} printed something that is not JSON: {e}"))
}

/// Every source in the home, as `status` prints them, or why they cannot be read.
pub async fn read(home: &Path) -> Value {
    if !home.join(SCRIPT).exists() {
        return json!({ "sources": [], "unsupported": true, "problem": "This home's firstmate cannot take on work from other task systems yet." });
    }
    match run(home, &["status"]).await.and_then(|out| parse(&out)) {
        Ok(value) => value,
        Err(problem) => json!({ "sources": [], "problem": problem }),
    }
}

async fn change(home: &Path, args: &[&str]) -> Result<Value, String> {
    let _one = WRITER.lock().await;
    parse(&run(home, args).await?)
}

pub async fn add(home: &Path, provider: &str, locator: &str, project: &str, filter: &str, outbound: &str) -> Result<Value, String> {
    change(home, &["add", provider, locator, "--project", project, "--filter", filter, "--outbound", outbound]).await
}

pub async fn edit(home: &Path, source: &str, filter: Option<&str>, outbound: Option<&str>) -> Result<Value, String> {
    let mut args = vec!["edit", source];
    if let Some(filter) = filter {
        args.extend(["--filter", filter]);
    }
    if let Some(outbound) = outbound {
        args.extend(["--outbound", outbound]);
    }
    change(home, &args).await
}

#[tauri::command]
pub async fn sources_get(app: AppHandle) -> Result<Value, String> {
    Ok(read(&home_for(&app)?).await)
}

#[tauri::command]
pub async fn sources_add(app: AppHandle, provider: String, locator: String, project: String, filter: String, outbound: String) -> Result<Value, String> {
    let home = home_for(&app)?;
    add(&home, &provider, &locator, &project, &filter, &outbound).await?;
    Ok(read(&home).await)
}

#[tauri::command]
pub async fn sources_edit(app: AppHandle, source: String, filter: Option<String>, outbound: Option<String>) -> Result<Value, String> {
    let home = home_for(&app)?;
    edit(&home, &source, filter.as_deref(), outbound.as_deref()).await?;
    Ok(read(&home).await)
}

#[tauri::command]
pub async fn sources_remove(app: AppHandle, source: String) -> Result<Value, String> {
    let home = home_for(&app)?;
    change(&home, &["remove", &source]).await?;
    Ok(read(&home).await)
}

/// Not now: the item is not offered again until it changes.
#[tauri::command]
pub async fn sources_dismiss(app: AppHandle, source: String, item: String) -> Result<Value, String> {
    let home = home_for(&app)?;
    change(&home, &["dismiss", &source, &item]).await?;
    Ok(read(&home).await)
}

/// Links a task that already exists to an item, by its link or key: no judgement is needed, so no message.
#[tauri::command]
pub async fn sources_link(app: AppHandle, task: String, reference: String) -> Result<Value, String> {
    if !crate::artifact::valid_task_id(&task) || task.starts_with('-') {
        return Err(format!("'{task}' is not a task id"));
    }
    let home = home_for(&app)?;
    change(&home, &["link", &task, reference.trim()]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qd-sources-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A home whose `bin/fm-sources.sh` is the engine's own, with the fixture provider's world beside it.
    fn engine_home(name: &str) -> PathBuf {
        let dir = home(name);
        let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine");
        std::os::unix::fs::symlink(engine.join("bin"), dir.join("bin")).unwrap();
        std::fs::copy(engine.join(".tasks.toml"), dir.join(".tasks.toml")).unwrap();
        for sub in ["data", "state", "config", "worlds"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        std::fs::write(dir.join("data/backlog.md"), "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n").unwrap();
        std::fs::write(
            dir.join("worlds/w.json"),
            r#"{"identity":"fm-bot","items":[{"id":"1","key":"FIX-1","summary":"One","description":"","status":"To Do","labels":["quarterdeck"],"updated":"2026-09-25T10:00"}]}"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn a_refusal_reads_in_the_scripts_words() {
        assert_eq!(reason("noise\nfm-sources: 'x' is already connected\n", "exit status: 1"), "'x' is already connected");
        assert_eq!(reason("", "exit status: 2"), "bin/fm-sources.sh stopped (exit status: 2)");
    }

    #[tokio::test]
    async fn a_home_without_the_script_is_told_so() {
        let dir = home("absent");
        let read = read(&dir).await;
        assert_eq!(read["unsupported"], true);
        assert_eq!(read["sources"], json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_source_is_added_edited_and_removed_only_through_the_script() {
        let dir = engine_home("roundtrip");
        std::env::set_var("FM_SOURCE_FIXTURE_DIR", dir.join("worlds"));
        add(&dir, "fixture", "w", "demo", "labels = quarterdeck", "comments").await.unwrap();
        let read_back = read(&dir).await;
        assert_eq!(read_back["sources"][0]["id"], "fixture:w");
        assert_eq!(read_back["sources"][0]["outbound"], "comments");
        let refused = add(&dir, "fixture", "w", "demo", "labels = quarterdeck", "comments").await.unwrap_err();
        assert_eq!(refused, "'fixture:w' is already connected");
        edit(&dir, "fixture:w", None, Some("none")).await.unwrap();
        assert_eq!(read(&dir).await["sources"][0]["outbound"], "none");
        let no_filter = add(&dir, "fixture", "x", "demo", " ", "comments").await.unwrap_err();
        assert!(no_filter.contains("intake filter"), "{no_filter}");
        change(&dir, &["remove", "fixture:w"]).await.unwrap();
        assert_eq!(read(&dir).await["sources"], json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
