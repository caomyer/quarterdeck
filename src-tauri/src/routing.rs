//! Crew routing: which tool and model does which kind of work, through
//! firstmate's own writer.
//!
//! `bin/fm-crew-dispatch.sh` is the one writer of the home's
//! `config/crew-dispatch.json` and of the `TYPESAFE_API_KEY` line in its `.env`,
//! and its header owns the verbs and what they print. The app runs it and reads
//! back what it says; it never writes either file itself, and it has no second
//! validator: a reason the rules are not valid is the one bootstrap reports.
//!
//! The key goes to the script on stdin and nowhere else. It is never put on a
//! command line, never logged, never saved in the app's settings, and never
//! sent back to the window, which is told only whether a key is set.

use crate::envpath;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

/// Every verb reads or writes a small file; anything this slow is stuck.
const TIMEOUT: Duration = Duration::from_secs(30);

/// One change at a time, so two quick clicks cannot interleave their writes.
static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SCRIPT: &str = "bin/fm-crew-dispatch.sh";

/// Where the rules for a newly turned-on routing come from.
const STARTS: [(&str, &[&str]); 3] = [
    ("empty", &["enable"]),
    ("template", &["enable", "--template"]),
    ("restore", &["enable", "--restore"]),
];

fn home_for(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::saved_home(app).ok_or_else(|| "no firstmate home has been chosen".to_string())
}

/// Runs one verb in the home. `Ok` is what it printed; `Err` is its reason, in
/// its own words without the script's name in front.
async fn run(home: &Path, args: &[&str], input: Option<&[u8]>) -> Result<String, String> {
    let script = home.join(SCRIPT);
    let mut command = envpath::command(&script);
    #[cfg(test)]
    command.env_remove("TYPESAFE_API_KEY");
    let mut child = command
        .args(args)
        .env("FM_HOME", home)
        .current_dir(home)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run {SCRIPT}: {e}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        // A script that exits without reading is judged by what it printed.
        let _ = stdin.write_all(input).await;
        drop(stdin);
    }
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
        Some(line) => line.strip_prefix("fm-crew-dispatch:").map(str::trim).unwrap_or(line).to_string(),
        None => format!("{SCRIPT} stopped ({status})"),
    }
}

/// `status`'s `key=value` lines, as the window reads them. `rules` is filled in
/// separately, from `show`.
pub fn parse_status(stdout: &str) -> Value {
    let field = |name: &str| {
        stdout.lines().find_map(|line| line.strip_prefix(name).and_then(|rest| rest.strip_prefix('='))).map(str::to_string)
    };
    let on = field("routing").as_deref() == Some("on");
    let key_set = field("key").as_deref() == Some("set");
    json!({
        "available": true,
        "problem": null,
        "on": on,
        "rules": null,
        "sha256": field("sha256"),
        "invalid": field("invalid"),
        "key": {"set": key_set, "source": if key_set { field("key-source") } else { None }},
        "setAside": field("set-aside"),
        "harnesses": [],
        "template": null,
    })
}

/// `harnesses`' tab-separated lines: each harness a profile may name, whether
/// this machine has it, and the efforts it takes. An effort bound to a model
/// (`max@gpt-5.6-luna`, `ultra@codex-native/*`) carries what it needs.
pub fn parse_harnesses(stdout: &str) -> Value {
    let harnesses: Vec<Value> = stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let name = fields.next().filter(|name| !name.is_empty())?;
            let installed = fields.next() == Some("installed");
            let efforts: Vec<Value> = fields
                .next()
                .unwrap_or_default()
                .split_whitespace()
                .map(|entry| match entry.split_once('@') {
                    Some((effort, needs)) => json!({"effort": effort, "needs": needs}),
                    None => json!({"effort": entry, "needs": null}),
                })
                .collect();
            Some(json!({"name": name, "installed": installed, "efforts": efforts}))
        })
        .collect();
    json!(harnesses)
}

fn unavailable(problem: String) -> Value {
    json!({
        "available": false,
        "problem": problem,
        "on": false,
        "rules": null,
        "sha256": null,
        "invalid": null,
        "key": {"set": false, "source": null},
        "setAside": null,
        "harnesses": [],
        "template": null,
    })
}

/// Where routing stands in the home, with the rules as they are on disk.
pub async fn read(home: &Path) -> Value {
    if !home.join(SCRIPT).is_file() {
        return unavailable(format!("this home's firstmate has no {SCRIPT}, so routing can't be set up from here"));
    }
    let mut status = match run(home, &["status"], None).await {
        Ok(stdout) => parse_status(&stdout),
        Err(problem) => return unavailable(problem),
    };
    if status["on"] == json!(true) {
        match run(home, &["show"], None).await {
            Ok(rules) => status["rules"] = json!(rules),
            Err(problem) => status["problem"] = json!(problem),
        }
    }
    // What the rule editor offers comes from the engine, never a list kept here.
    // A firstmate that cannot list them leaves the editor to the rules as JSON.
    if let Ok(listed) = run(home, &["harnesses"], None).await {
        status["harnesses"] = parse_harnesses(&listed);
    }
    if let Ok(template) = run(home, &["template"], None).await {
        status["template"] = json!(template);
    }
    status
}

/// Runs one change, then reads where routing stands after it.
async fn change(home: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Value, String> {
    let _one_writer = WRITER.lock().await;
    run(home, args, input).await?;
    Ok(read(home).await)
}

pub async fn enable(home: &Path, from: &str) -> Result<Value, String> {
    let (_, args) = STARTS.iter().find(|(name, _)| *name == from).ok_or_else(|| format!("routing can't start from '{from}'"))?;
    change(home, args, None).await
}

pub async fn save(home: &Path, rules: &str, sha256: Option<&str>) -> Result<Value, String> {
    match sha256.filter(|digest| !digest.is_empty()) {
        Some(digest) => change(home, &["write", "--if-unchanged", digest], Some(rules.as_bytes())).await,
        None => change(home, &["write"], Some(rules.as_bytes())).await,
    }
}

pub async fn set_key(home: &Path, key: &str) -> Result<Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("paste a key first".to_string());
    }
    // One line on stdin, the only way the key leaves the app.
    let line = format!("{key}\n");
    change(home, &["set-key"], Some(line.as_bytes())).await
}

/// Where routing stands in the chosen home.
#[tauri::command]
pub async fn routing_get(app: AppHandle) -> Result<Value, String> {
    Ok(read(&home_for(&app)?).await)
}

/// Turns routing on, from the example rules (`template`), from none (`empty`), or
/// from the rules turning it off set aside (`restore`).
#[tauri::command]
pub async fn routing_enable(app: AppHandle, from: String) -> Result<Value, String> {
    enable(&home_for(&app)?, &from).await
}

/// Replaces the rules. `sha256` is the digest of the rules the edit started from,
/// so a file someone changed in the meantime is refused rather than overwritten.
#[tauri::command]
pub async fn routing_save(app: AppHandle, rules: String, sha256: Option<String>) -> Result<Value, String> {
    save(&home_for(&app)?, &rules, sha256.as_deref()).await
}

/// Turns routing off by setting the rules aside; nothing is deleted.
#[tauri::command]
pub async fn routing_disable(app: AppHandle) -> Result<Value, String> {
    change(&home_for(&app)?, &["disable"], None).await
}

/// Stores the typed dispatch key in the home's `.env`. The reply says only that
/// a key is set.
#[tauri::command]
pub async fn routing_key_set(app: AppHandle, key: String) -> Result<Value, String> {
    set_key(&home_for(&app)?, &key).await
}

#[tauri::command]
pub async fn routing_key_clear(app: AppHandle) -> Result<Value, String> {
    change(&home_for(&app)?, &["clear-key"], None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "tsk_live-QuarterdeckTest.9z/+=:~";

    /// A home whose `bin` and `docs` are this repository's engine, as the app's own
    /// home is laid out, so the tests drive the real writer.
    fn home(name: &str) -> PathBuf {
        let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine").canonicalize().unwrap();
        let home = std::env::temp_dir().join(format!("qd-routing-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("config")).unwrap();
        std::os::unix::fs::symlink(engine.join("bin"), home.join("bin")).unwrap();
        std::os::unix::fs::symlink(engine.join("docs"), home.join("docs")).unwrap();
        home
    }

    fn files_holding(dir: &Path, needle: &str, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                files_holding(&path, needle, found);
            } else if kind.is_file() && std::fs::read_to_string(&path).is_ok_and(|text| text.contains(needle)) {
                found.push(path);
            }
        }
    }

    #[test]
    fn status_lines_become_what_the_window_reads() {
        let status = parse_status("routing=on\nsha256=abc\ninvalid=unverified harness: nope\nkey=set\nkey-source=.env\nset-aside=crew-dispatch.json.off-1\n");
        assert_eq!(status["on"], json!(true));
        assert_eq!(status["sha256"], json!("abc"));
        assert_eq!(status["invalid"], json!("unverified harness: nope"));
        assert_eq!(status["key"], json!({"set": true, "source": ".env"}));
        assert_eq!(status["setAside"], json!("crew-dispatch.json.off-1"));
        let off = parse_status("routing=off\nkey=unset\n");
        assert_eq!(off["on"], json!(false));
        assert_eq!(off["invalid"], Value::Null);
        assert_eq!(off["key"], json!({"set": false, "source": null}));
    }

    #[test]
    fn harness_lines_become_choices() {
        let listed = parse_harnesses("claude\tinstalled\tlow medium high xhigh max\ncodex\tmissing\tlow max@gpt-5.6-luna\ncursor\tmissing\t\n");
        assert_eq!(listed[0], json!({"name": "claude", "installed": true, "efforts": [
            {"effort": "low", "needs": null}, {"effort": "medium", "needs": null}, {"effort": "high", "needs": null},
            {"effort": "xhigh", "needs": null}, {"effort": "max", "needs": null}]}));
        assert_eq!(listed[1]["efforts"][1], json!({"effort": "max", "needs": "gpt-5.6-luna"}));
        assert_eq!(listed[1]["installed"], json!(false));
        assert_eq!(listed[2], json!({"name": "cursor", "installed": false, "efforts": []}));
    }

    #[test]
    fn a_refusal_reads_in_the_scripts_words() {
        assert_eq!(reason("fm-crew-dispatch: not saved: unverified harness: nope\n", "exit status: 1"), "not saved: unverified harness: nope");
        assert_eq!(reason("", "exit status: 1"), "bin/fm-crew-dispatch.sh stopped (exit status: 1)");
    }

    #[tokio::test]
    async fn a_home_without_the_writer_is_told_so() {
        let home = std::env::temp_dir().join(format!("qd-routing-old-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let status = read(&home).await;
        assert_eq!(status["available"], json!(false));
        assert!(status["problem"].as_str().unwrap().contains("no bin/fm-crew-dispatch.sh"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn routing_turns_on_from_the_example_and_off_without_losing_the_rules() {
        let home = home("lifecycle");
        let off = read(&home).await;
        assert_eq!(off["available"], json!(true));
        assert_eq!(off["on"], json!(false));
        let names: Vec<&str> = off["harnesses"].as_array().unwrap().iter().filter_map(|harness| harness["name"].as_str()).collect();
        assert!(names.contains(&"claude") && names.contains(&"codex"), "the engine's harnesses: {names:?}");
        assert_eq!(off["template"], json!(std::fs::read_to_string(home.join("docs/examples/crew-dispatch.json")).unwrap()));
        assert!(!home.join("config/crew-dispatch.json").exists(), "off is no file at all");

        let on = enable(&home, "template").await.unwrap();
        assert_eq!(on["on"], json!(true));
        assert_eq!(on["invalid"], Value::Null);
        let example = std::fs::read_to_string(home.join("docs/examples/crew-dispatch.json")).unwrap();
        assert_eq!(on["rules"], json!(example));

        let refused = save(&home, r#"{"rules":[{"when":"x","use":{"harness":"spaceship"}}]}"#, on["sha256"].as_str()).await.unwrap_err();
        assert_eq!(refused, "not saved: unverified harness: spaceship");
        let edited = r#"{"rules":[],"default":{"harness":"claude"}}"#;
        let saved = save(&home, &format!("{edited}\n"), on["sha256"].as_str()).await.unwrap();
        assert_eq!(saved["rules"], json!(format!("{edited}\n")));
        let stale = save(&home, edited, on["sha256"].as_str()).await.unwrap_err();
        assert!(stale.contains("changed since it was read"), "{stale}");

        let turned_off = change(&home, &["disable"], None).await.unwrap();
        assert_eq!(turned_off["on"], json!(false));
        let aside = turned_off["setAside"].as_str().unwrap().to_string();
        assert_eq!(std::fs::read_to_string(home.join("config").join(&aside)).unwrap(), format!("{edited}\n"));

        let restored = enable(&home, "restore").await.unwrap();
        assert_eq!(restored["rules"], json!(format!("{edited}\n")));
        assert!(enable(&home, "anything").await.is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The window is told a key is set, and nothing more: not in any reply, and
    /// not in any file but the home's `.env`.
    #[tokio::test]
    async fn the_key_goes_only_to_the_homes_env() {
        let home = home("key");
        let before = read(&home).await;
        assert_eq!(before["key"], json!({"set": false, "source": null}));
        let set = set_key(&home, &format!("  {KEY}  ")).await.unwrap();
        assert_eq!(set["key"], json!({"set": true, "source": ".env"}));
        assert!(!set.to_string().contains(KEY), "the reply carries the key: {set}");
        let status = read(&home).await;
        assert!(!status.to_string().contains(KEY));
        assert_eq!(std::fs::read_to_string(home.join(".env")).unwrap(), format!("TYPESAFE_API_KEY={KEY}\n"));
        // The engine's own files are links, which the scan does not follow: it reads what this run wrote.
        let mut found = Vec::new();
        files_holding(&home, KEY, &mut found);
        assert_eq!(found, vec![home.join(".env")], "the key was written somewhere besides .env");

        let refused = set_key(&home, "not a key $(id)").await.unwrap_err();
        assert!(!refused.contains("$(id)"), "{refused}");
        assert!(set_key(&home, "   ").await.is_err());

        let cleared = change(&home, &["clear-key"], None).await.unwrap();
        assert_eq!(cleared["key"], json!({"set": false, "source": null}));
        assert_eq!(std::fs::read_to_string(home.join(".env")).unwrap(), "");
        let _ = std::fs::remove_dir_all(&home);
    }
}
