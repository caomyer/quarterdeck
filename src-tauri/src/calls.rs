//! Recording the captain's answers through firstmate's own intake.
//!
//! firstmate owns every call: `bin/fm-captain-hold.sh` is the only writer of
//! anything about one, and `answers` is its one way in for an answer. The app
//! feeds it keyed lines and reads back what it did; it never closes a call
//! itself, and it never says an answer was recorded unless the intake said so.
//!
//! The invocation, from the home with `FM_HOME` set:
//!
//! ```text
//! bin/fm-captain-hold.sh answers --source quarterdeck
//! <task-id>\t<answer-key>\t<label>\t<on_answer>     one line per answer, on stdin
//! ```
//!
//! and one result line per call on stdout:
//!
//! ```text
//! closed: <task-id> ...            recorded, and the call is closed or released
//! skipped: <task-id> <reason>      not recorded, for the reason given
//! ```
//!
//! Anything else is not a result. A call with no result line is not recorded,
//! whatever the exit status; a `closed:` line is believed even when the script
//! exits non-zero afterwards, since the close has happened. A `skipped:` line
//! wins over a `closed:` line for the same call, so a skip is never shown as
//! recorded.

use crate::envpath;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// The intake records a handful of lines; anything this slow is stuck.
const INTAKE_TIMEOUT: Duration = Duration::from_secs(60);

/// How an answer closes its call, as the call declares it. Channels never choose.
const MODES: [&str; 2] = ["done", "release"];

/// One answer to record: the call, the option's key and label, and how the call
/// says an answer closes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Keyed {
    pub call: String,
    pub key: String,
    pub label: String,
    pub on_answer: String,
}

/// What the intake did with one answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Recorded. The detail is the rest of the intake's line.
    Closed(String),
    /// The intake looked at it and did not record it, for this reason.
    Skipped(String),
    /// Nothing says it was recorded: no line for it, a missing script, a crash.
    NotRecorded(String),
}

impl Outcome {
    pub fn result(&self) -> &'static str {
        match self {
            Outcome::Closed(_) => "closed",
            Outcome::Skipped(_) => "skipped",
            Outcome::NotRecorded(_) => "not_recorded",
        }
    }

    pub fn detail(&self) -> &str {
        match self {
            Outcome::Closed(detail) | Outcome::Skipped(detail) | Outcome::NotRecorded(detail) => detail,
        }
    }

    pub fn to_json(&self, call: &str) -> Value {
        json!({"call": call, "result": self.result(), "detail": self.detail()})
    }
}

/// A field on one intake line: tabs and line breaks would split it into others.
fn field(text: &str) -> String {
    text.split(['\t', '\n', '\r']).map(str::trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Whether an answer can go to the intake at all, and if not, why.
fn refusal(answer: &Keyed) -> Option<String> {
    if !crate::artifact::valid_task_id(&answer.call) {
        return Some("that is not a call".to_string());
    }
    if field(&answer.key).is_empty() {
        return Some("the answer names no option".to_string());
    }
    if !MODES.contains(&answer.on_answer.as_str()) {
        return Some("the call does not say how an answer closes it, so it has to be answered through the first mate".to_string());
    }
    None
}

/// The lines the intake reads, one per answer.
pub fn lines(answers: &[Keyed]) -> String {
    answers
        .iter()
        .map(|answer| format!("{}\t{}\t{}\t{}\n", answer.call, field(&answer.key), field(&answer.label), answer.on_answer))
        .collect()
}

/// What the intake did with each answer, read from what it printed.
pub fn parse(answers: &[Keyed], stdout: &str, failure: Option<&str>) -> Vec<Outcome> {
    let mut closed: Vec<(&str, &str)> = Vec::new();
    let mut skipped: Vec<(&str, &str)> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        // `refused:` is the intake turning an answer away outright (a reserved key such as
        // `reconcile`); for the captain it is a skip like any other, with its reason.
        for (prefix, is_close) in [("closed:", true), ("skipped:", false), ("refused:", false)] {
            let Some(rest) = line.strip_prefix(prefix) else { continue };
            let rest = rest.trim_start();
            let (call, detail) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            // firstmate wraps a reason in parentheses: `skipped: <task> (<reason>)`.
            let detail = detail.trim();
            let detail = detail.strip_prefix('(').and_then(|inner| inner.strip_suffix(')')).unwrap_or(detail).trim();
            if !call.is_empty() {
                if is_close { closed.push((call, detail)) } else { skipped.push((call, detail)) }
            }
        }
    }
    answers
        .iter()
        .map(|answer| {
            if let Some((_, reason)) = skipped.iter().find(|(call, _)| *call == answer.call) {
                let reason = if reason.is_empty() { "the intake gave no reason" } else { reason };
                return Outcome::Skipped(reason.to_string());
            }
            if let Some((_, detail)) = closed.iter().find(|(call, _)| *call == answer.call) {
                return Outcome::Closed(detail.to_string());
            }
            Outcome::NotRecorded(match failure {
                Some(failure) => failure.to_string(),
                None => "firstmate's intake said nothing about this answer".to_string(),
            })
        })
        .collect()
}

/// Runs the intake for these answers and says what happened to each, in order.
/// Never fails as a whole: every way it can go wrong is an outcome of each answer.
pub async fn record(home: &Path, answers: &[Keyed]) -> Vec<Outcome> {
    let mut outcomes: Vec<Option<Outcome>> = answers.iter().map(|answer| refusal(answer).map(Outcome::NotRecorded)).collect();
    let fed: Vec<Keyed> = answers.iter().zip(&outcomes).filter(|(_, outcome)| outcome.is_none()).map(|(answer, _)| answer.clone()).collect();
    if !fed.is_empty() {
        let mut ran = run(home, &fed).await.into_iter();
        for outcome in outcomes.iter_mut().filter(|outcome| outcome.is_none()) {
            *outcome = ran.next();
        }
    }
    outcomes.into_iter().map(|outcome| outcome.unwrap_or_else(|| Outcome::NotRecorded("the answer was lost on its way to the intake".to_string()))).collect()
}

async fn run(home: &Path, answers: &[Keyed]) -> Vec<Outcome> {
    let script = home.join("bin").join("fm-captain-hold.sh");
    let everyone = |why: String| answers.iter().map(|_| Outcome::NotRecorded(why.clone())).collect::<Vec<_>>();
    if !script.is_file() {
        return everyone("this home's firstmate has no bin/fm-captain-hold.sh, so the answer has to go through the first mate".to_string());
    }
    let child = envpath::command(&script)
        .args(["answers", "--source", "quarterdeck"])
        .env("FM_HOME", home)
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) => return everyone(format!("could not run bin/fm-captain-hold.sh: {e}")),
    };
    let input = lines(answers);
    if let Some(mut stdin) = child.stdin.take() {
        // A script that exits without reading its input is judged by what it printed.
        let _ = stdin.write_all(input.as_bytes()).await;
        drop(stdin);
    }
    let output = match tokio::time::timeout(INTAKE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return everyone(format!("bin/fm-captain-hold.sh could not be read: {e}")),
        Err(_) => return everyone(format!("bin/fm-captain-hold.sh did not finish within {}s", INTAKE_TIMEOUT.as_secs())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let failure = (!output.status.success()).then(|| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.trim().chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
        let tail = tail.lines().last().unwrap_or_default().trim().to_string();
        if tail.is_empty() {
            format!("firstmate's intake stopped ({})", output.status)
        } else {
            format!("firstmate's intake stopped: {tail}")
        }
    });
    if failure.is_some() {
        log::warn!("fm-captain-hold.sh answers exited with {}", output.status);
    }
    parse(answers, &stdout, failure.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn keyed(call: &str, key: &str, label: &str, mode: &str) -> Keyed {
        Keyed { call: call.into(), key: key.into(), label: label.into(), on_answer: mode.into() }
    }

    /// A home with a pretend intake that records how it was run and prints `says`.
    fn home_with_intake(name: &str, says: &str, exit: i32) -> PathBuf {
        let home = std::env::temp_dir().join(format!("fm-calls-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("bin")).unwrap();
        let script = home.join("bin/fm-captain-hold.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FM_HOME/args\"\npwd > \"$FM_HOME/cwd\"\ncat > \"$FM_HOME/stdin\"\ncat <<'EOF'\n{says}\nEOF\nexit {exit}\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        home
    }

    #[tokio::test]
    async fn the_intake_is_fed_keyed_lines_from_the_home() {
        let home = home_with_intake("fed", "closed: res-snip-lifecycle answer recorded; released", 0);
        let answers = [
            keyed("res-snip-lifecycle", "retry", "Mark it failed\tand give the user a way\nto retry it", "release"),
            keyed("res-model-download", "wifi-only", "Wi-Fi only", "done"),
        ];
        let outcomes = record(&home, &answers).await;
        let read = |name: &str| std::fs::read_to_string(home.join(name)).unwrap();
        assert_eq!(read("args"), "answers\n--source\nquarterdeck\n");
        assert_eq!(std::fs::canonicalize(read("cwd").trim()).unwrap(), std::fs::canonicalize(&home).unwrap());
        // A tab or a line break in a label would split the line, so it is folded into spaces.
        assert_eq!(
            read("stdin"),
            "res-snip-lifecycle\tretry\tMark it failed and give the user a way to retry it\trelease\nres-model-download\twifi-only\tWi-Fi only\tdone\n"
        );
        assert_eq!(outcomes[0], Outcome::Closed("answer recorded; released".into()));
        // Nothing said about the second, so it is not recorded.
        assert!(matches!(&outcomes[1], Outcome::NotRecorded(why) if why.contains("said nothing")), "{outcomes:?}");
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn a_skip_is_reported_with_its_reason_and_never_as_recorded() {
        let home = home_with_intake(
            "skipped",
            "skipped: res-model-download mode release does not match the call's on_answer done\nclosed: res-model-download (should never win)",
            0,
        );
        let outcomes = record(&home, &[keyed("res-model-download", "wifi-only", "Wi-Fi only", "release")]).await;
        assert_eq!(outcomes, vec![Outcome::Skipped("mode release does not match the call's on_answer done".into())]);
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn garbage_and_a_failed_exit_record_nothing() {
        let home = home_with_intake("garbage", "Recorded everything, trust me\nclosed:\nres-a closed", 3);
        let outcomes = record(&home, &[keyed("res-a", "x", "X", "done")]).await;
        assert!(matches!(&outcomes[0], Outcome::NotRecorded(why) if why.contains("intake stopped")), "{outcomes:?}");
        let _ = std::fs::remove_dir_all(home);

        // A close the intake printed before failing on a later line did happen.
        let home = home_with_intake("partial", "closed: res-a recorded", 1);
        let outcomes = record(&home, &[keyed("res-a", "x", "X", "done"), keyed("res-b", "y", "Y", "done")]).await;
        assert_eq!(outcomes[0], Outcome::Closed("recorded".into()));
        assert!(matches!(&outcomes[1], Outcome::NotRecorded(_)), "{outcomes:?}");
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn a_home_without_the_script_records_nothing() {
        let home = std::env::temp_dir().join(format!("fm-calls-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let outcomes = record(&home, &[keyed("res-a", "x", "X", "done")]).await;
        assert!(matches!(&outcomes[0], Outcome::NotRecorded(why) if why.contains("no bin/fm-captain-hold.sh")), "{outcomes:?}");
        let _ = std::fs::remove_dir_all(home);
    }

    #[tokio::test]
    async fn an_answer_the_intake_cannot_take_never_reaches_it() {
        let home = home_with_intake("refused", "closed: res-b ok", 0);
        let outcomes = record(&home, &[keyed("res-a", "x", "X", ""), keyed("res-b", "y", "Y", "done"), keyed("../etc", "z", "Z", "done")]).await;
        assert!(matches!(&outcomes[0], Outcome::NotRecorded(why) if why.contains("through the first mate")), "{outcomes:?}");
        assert_eq!(outcomes[1], Outcome::Closed("ok".into()));
        assert!(matches!(&outcomes[2], Outcome::NotRecorded(_)), "{outcomes:?}");
        // Only what it could take was fed to it.
        assert_eq!(std::fs::read_to_string(home.join("stdin")).unwrap(), "res-b\ty\tY\tdone\n");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn parsing_reads_only_result_lines() {
        let answers = [keyed("a", "x", "X", "done"), keyed("b", "y", "Y", "done")];
        let outcomes = parse(&answers, "  closed: a   done  \nnote: b looked fine\nskipped: b\n", None);
        assert_eq!(outcomes[0], Outcome::Closed("done".into()));
        assert_eq!(outcomes[1], Outcome::Skipped("the intake gave no reason".into()));
        // A task whose id merely starts with another's is not that task.
        // firstmate's own wording: a reason in parentheses, a refusal, and its closing tally line.
        let outcomes = parse(
            &[keyed("res-a", "x", "X", "done"), keyed("res-b", "reconcile", "R", "done")],
            "skipped: res-a (close mode release disagrees with the call's declared on_answer done)\nrefused: res-b (reconcile is reserved)\nanswers: closed=0 skipped=2\n",
            None,
        );
        assert!(matches!(&outcomes[0], Outcome::Skipped(reason) if reason == "close mode release disagrees with the call's declared on_answer done"), "{outcomes:?}");
        assert!(matches!(&outcomes[1], Outcome::Skipped(reason) if reason == "reconcile is reserved"), "{outcomes:?}");
        let outcomes = parse(&[keyed("res-a", "x", "X", "done")], "closed: res-ab ok\n", None);
        assert!(matches!(&outcomes[0], Outcome::NotRecorded(_)));
    }
}
