//! Plan limits for the usage panel, read from `quota-axi`, the tool firstmate
//! already reads before it dispatches. Reads only: quota-axi reports what each
//! provider's account has used of its windows, and the app shows it.
//!
//! The panel is drawn from what this module hands it, never from quota-axi's
//! own output: that carries account identities the app has no use for, and
//! prose written for agents. Each provider comes back as its windows, its state
//! in quota-axi's own words, and how sure quota-axi is of it.
//!
//! A read that fails does not wipe what the last good one said: the panel shows
//! those numbers as stale, with the failure beside them.

use crate::envpath;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const READ_TIMEOUT: Duration = Duration::from_secs(45);
/// Allowing Keychain access waits on the captain answering macOS's prompt.
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(180);

/// The last good read, and the lock that keeps two reads from running at once.
#[derive(Default)]
pub struct Quota {
    last: Mutex<Option<(Value, u64)>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The quota-axi to run: `QUOTA_AXI` when set, which tests use, else the one on PATH.
fn program() -> Option<std::path::PathBuf> {
    match std::env::var_os("QUOTA_AXI").filter(|value| !value.is_empty()) {
        Some(path) => Some(path.into()),
        None => envpath::resolve("quota-axi"),
    }
}

async fn run(args: &[&str], limit: Duration) -> Result<Value, String> {
    let Some(program) = program() else {
        return Err(MISSING.to_string());
    };
    let child = envpath::command(&program).args(args).stdin(Stdio::null()).kill_on_drop(true).output();
    let output = tokio::time::timeout(limit, child)
        .await
        .map_err(|_| format!("quota-axi did not answer within {}s", limit.as_secs()))?
        .map_err(|e| format!("could not run quota-axi: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let said = stderr.trim().lines().last().unwrap_or("").trim();
        return Err(if said.is_empty() { format!("quota-axi exited with {}", output.status) } else { format!("quota-axi: {said}") });
    }
    let raw: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("quota-axi printed something other than JSON: {e}"))?;
    Ok(providers(&raw))
}

/// Said when quota-axi is not installed, which is a state of its own rather than a failed read.
const MISSING: &str = "quota-axi is not installed";

/// What the panel needs from `quota-axi --full --json`, provider by provider.
pub fn providers(raw: &Value) -> Value {
    let list = raw.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(list.iter().map(provider).collect())
}

fn provider(raw: &Value) -> Value {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_string);
    let state = raw.get("state").cloned().unwrap_or(Value::Null);
    let windows: Vec<Value> = raw
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .map(|window| {
                    // Older readings give only what is left.
                    let used = window.get("percentUsed").and_then(Value::as_f64).or_else(|| {
                        window.get("percentRemaining").and_then(Value::as_f64).map(|left| 100.0 - left)
                    });
                    json!({
                        "id": text(window.get("id")),
                        "label": text(window.get("label")),
                        "kind": text(window.get("kind")),
                        "used": used,
                        "resets_at": text(window.get("resetsAt")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // How sure quota-axi is of the account as a whole: the all-models reading's confidence.
    let confidence = raw
        .pointer("/quotaSemantics/effectiveAvailability")
        .and_then(Value::as_array)
        .and_then(|scopes| scopes.iter().find(|scope| scope.get("scope").and_then(Value::as_str) == Some("all_models")))
        .and_then(|scope| scope.pointer("/runway/projectionConfidence"))
        .and_then(Value::as_str);
    json!({
        "id": text(raw.get("provider")),
        "label": text(raw.get("label")),
        "plan": text(raw.get("plan")),
        "status": text(state.get("status")).unwrap_or_else(|| "unavailable".into()),
        "stale": state.get("stale").and_then(Value::as_bool).unwrap_or(false),
        "refreshed_at": text(state.get("refreshedAt")),
        "error": text(state.get("error")),
        "reason": text(state.get("reason")),
        "remedy": text(state.get("remedyCommand")),
        "confidence": confidence,
        "windows": windows,
    })
}

impl Quota {
    /// Reads quota-axi, or answers with the last good read and why this one failed.
    async fn read(&self, args: &[&str], limit: Duration) -> Value {
        let mut last = self.last.lock().await;
        match run(args, limit).await {
            Ok(providers) => {
                let at = now_ms();
                *last = Some((providers.clone(), at));
                json!({"providers": providers, "read_at_ms": at, "error": null, "missing": false})
            }
            Err(error) => {
                let missing = error == MISSING;
                let (providers, at) = last.clone().map_or((Value::Null, None), |(providers, at)| (providers, Some(at)));
                json!({"providers": providers, "read_at_ms": at, "error": error, "missing": missing})
            }
        }
    }
}

#[tauri::command]
pub async fn quota_read(quota: tauri::State<'_, Quota>) -> Result<Value, String> {
    Ok(quota.read(&["--full", "--json"], READ_TIMEOUT).await)
}

/// Lets quota-axi read Claude's credentials from the Keychain, which macOS asks
/// the captain to allow. Only ever run because the captain asked for it.
#[tauri::command]
pub async fn quota_allow_keychain(quota: tauri::State<'_, Quota>) -> Result<Value, String> {
    Ok(quota.read(&["--full", "--json", "--allow-keychain-prompt"], KEYCHAIN_TIMEOUT).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// What quota-axi 0.1.49 printed on a Mac, trimmed, with its account identity left in to prove it goes no further.
    fn sample() -> Value {
        json!({
            "generatedAt": "2026-09-23T07:21:03.055Z",
            "schemaVersion": 5,
            "providers": [
                {
                    "provider": "claude", "label": "Claude", "source": "oauth", "plan": "max",
                    "account": {"email": "captain@example.com", "accountId": "513ca67f"},
                    "windows": [
                        {"id": "five_hour", "label": "session", "kind": "session", "percentUsed": 23, "resetsAt": "2026-09-23T08:40:00.290744+00:00", "percentRemaining": 77},
                        {"id": "model:fable", "label": "Fable week", "kind": "model", "percentRemaining": 100, "resetsAt": "2026-09-26T06:00:00+00:00"}
                    ],
                    "attempts": [{"source": "keychain", "status": "success"}],
                    "state": {"status": "fresh", "stale": false, "refreshedAt": "2026-09-23T07:21:03.370Z", "sourcesTried": ["keychain"]},
                    "quotaSemantics": {"effectiveAvailability": [
                        {"scope": "model:fable", "runway": {"projectionConfidence": "unknown"}},
                        {"scope": "all_models", "runway": {"status": "through_reset", "projectionConfidence": "established"}}
                    ]}
                },
                {
                    "provider": "claude-keychain", "label": "Claude", "windows": [],
                    "state": {"status": "auth_required", "stale": false, "error": "keychain_prompt_required", "reason": "keychain_access_required", "remedyCommand": "quota-axi --allow-keychain-prompt"}
                },
                {"provider": "agy", "label": "Antigravity", "windows": [], "state": {"status": "unavailable", "stale": false, "error": "Antigravity/agy is not running"}}
            ]
        })
    }

    #[test]
    fn a_provider_comes_through_as_its_windows_state_and_confidence() {
        let providers = providers(&sample());
        assert_eq!(providers[0], json!({
            "id": "claude", "label": "Claude", "plan": "max", "status": "fresh", "stale": false,
            "refreshed_at": "2026-09-23T07:21:03.370Z", "error": null, "reason": null, "remedy": null,
            "confidence": "established",
            "windows": [
                {"id": "five_hour", "label": "session", "kind": "session", "used": 23.0, "resets_at": "2026-09-23T08:40:00.290744+00:00"},
                {"id": "model:fable", "label": "Fable week", "kind": "model", "used": 0.0, "resets_at": "2026-09-26T06:00:00+00:00"}
            ]
        }));
        assert!(!providers.to_string().contains("captain@example.com"), "account identities stay behind");
    }

    #[test]
    fn a_provider_that_needs_something_says_so_in_quota_axis_words() {
        let providers = providers(&sample());
        assert_eq!(
            (&providers[1]["status"], &providers[1]["error"], &providers[1]["reason"], &providers[1]["remedy"]),
            (&json!("auth_required"), &json!("keychain_prompt_required"), &json!("keychain_access_required"), &json!("quota-axi --allow-keychain-prompt"))
        );
        assert_eq!((&providers[2]["status"], &providers[2]["error"]), (&json!("unavailable"), &json!("Antigravity/agy is not running")));
    }

    fn fake_quota_axi(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fm-desktop-quota-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("quota-axi");
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    /// Reads this Mac's own quota-axi through the command's path, spending no tokens and changing nothing:
    /// `cargo test quota_live_reads_this_mac -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "live: runs the quota-axi installed on this Mac"]
    async fn quota_live_reads_this_mac() {
        let read = Quota::default().read(&["--full", "--json"], READ_TIMEOUT).await;
        println!("{}", serde_json::to_string_pretty(&read).unwrap());
        assert_eq!(read["error"], Value::Null, "{read}");
        let providers = read["providers"].as_array().expect("providers");
        assert!(!providers.is_empty());
        for provider in providers {
            assert!(provider["id"].is_string() && provider["status"].is_string(), "{provider}");
            for window in provider["windows"].as_array().unwrap() {
                assert!(window["used"].is_number() && window["resets_at"].is_string(), "{window}");
            }
        }
        assert!(!read.to_string().contains('@'), "no account identity reaches the app");
    }

    /// One test drives every read, since `QUOTA_AXI` is process-wide.
    #[tokio::test]
    async fn a_failed_read_keeps_the_last_good_one_and_says_why() {
        let quota = Quota::default();
        let good = fake_quota_axi("good", &format!("cat <<'JSON'\n{}\nJSON", sample()));
        std::env::set_var("QUOTA_AXI", &good);
        let read = quota.read(&["--full", "--json"], READ_TIMEOUT).await;
        assert_eq!(read["error"], Value::Null);
        assert_eq!(read["providers"][0]["windows"][0]["used"], 23.0);
        let at = read["read_at_ms"].as_u64().expect("a read time");

        let failing = fake_quota_axi("failing", "echo 'fetch failed' >&2\nexit 1");
        std::env::set_var("QUOTA_AXI", &failing);
        let read = quota.read(&["--full", "--json"], READ_TIMEOUT).await;
        assert_eq!(read["error"], "quota-axi: fetch failed");
        assert_eq!(read["read_at_ms"], at, "the numbers are the last good read's, and say when that was");
        assert_eq!(read["providers"][0]["windows"][0]["used"], 23.0);
        assert_eq!(read["missing"], false);

        let slow = fake_quota_axi("slow", "sleep 5");
        std::env::set_var("QUOTA_AXI", &slow);
        let read = quota.read(&["--full", "--json"], Duration::from_millis(200)).await;
        assert_eq!(read["error"], "quota-axi did not answer within 0s");

        std::env::set_var("QUOTA_AXI", failing.with_file_name("absent"));
        let read = quota.read(&["--full", "--json"], READ_TIMEOUT).await;
        assert!(read["error"].as_str().unwrap_or("").starts_with("could not run quota-axi"), "{read}");
        std::env::remove_var("QUOTA_AXI");
    }
}
