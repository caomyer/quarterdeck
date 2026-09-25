//! Live end-to-end test of the first mate host: the real host loop, the real
//! `claude-agent-acp`, and a real firstmate scratch home. Ignored by default,
//! because it spends model tokens and takes several minutes:
//!
//! ```sh
//! cd src-tauri && cargo test host_e2e_live_scratch_home -- --ignored --nocapture
//! ```
//!
//! Name the test exactly. `host_e2e` matches this test and the lock probe, which
//! starts two first mates in one home; the one that loses the race truthfully
//! reports the other as another session, which reads like a bug and is not. Only
//! one live run per home may be in flight, and `LiveRun` enforces it.
//!
//! `FM_E2E_HOME` picks the home (default `~/.buzz/.scratch/fm-probe/firstmate`).
//! It must be a scratch home that no other host is using, never a live one.
//! Every event is recorded with step markers to
//! `~/.buzz/.scratch/firstmate-desktop-e2e/recording-<ms>.jsonl`, the stream
//! the UI's mock adapter replays. Payloads are the backend's raw ones.
//!
//! Each step reports its outcome with the evidence: passed, failed, or not
//! exercised when the session never produced its conditions. Only a failure fails
//! the run, and the run finishes every step so one failure does not hide the rest.

use crate::host::{group_members, Cmd, HostEnv, HostHandle};
use crate::review;
use serde_json::{json, Value};
use std::io::Write as _;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

const REPLY_WAIT: Duration = Duration::from_secs(240);
const CALL_WAIT: Duration = Duration::from_secs(300);
const REWAKE_WAIT: Duration = Duration::from_secs(90);

/// Keeps the first mate from doing fleet work while leaving firstmate's own
/// session start alone: the host relies on it to claim the home's lock.
const GUARD: &str = "This is an automated host test in a scratch home. Follow your session-start instructions as usual, but do not dispatch work, change any project, or contact anyone.";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ------------------------------------------------------------ recording ---

struct Recorder {
    started: Instant,
    file: Mutex<std::fs::File>,
    data_dir: PathBuf,
    tx: mpsc::UnboundedSender<(String, Value)>,
}

impl Recorder {
    fn line(&self, kind: &str, payload: &Value) {
        let record = json!({"t_ms": self.started.elapsed().as_millis() as u64, "type": kind, "payload": payload});
        if let Ok(mut file) = self.file.lock() {
            let _ = writeln!(file, "{record}");
            let _ = file.flush();
        }
    }

    fn mark(&self, step: &str, what: &str) {
        println!("\n== step {step}: {what}");
        self.line("step", &json!({"step": step, "what": what}));
    }
}

impl HostEnv for Recorder {
    fn emit(&self, event: &str, body: Value) {
        self.line(event, &body);
        let _ = self.tx.send((event.to_string(), body));
    }

    fn data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.data_dir.clone())
    }
}

/// Every event the host emitted, in order, with a way to wait for one.
struct Events {
    rx: mpsc::UnboundedReceiver<(String, Value)>,
    seen: Vec<(String, Value)>,
}

impl Events {
    /// Position after everything emitted so far.
    fn now(&mut self) -> usize {
        while let Ok(item) = self.rx.try_recv() {
            self.seen.push(item);
        }
        self.seen.len()
    }

    /// Index of the first event at or after `from` that matches, waiting up to `limit`.
    async fn find(&mut self, from: usize, limit: Duration, pred: impl Fn(&str, &Value) -> bool) -> Option<usize> {
        let deadline = tokio::time::Instant::now() + limit;
        let mut next = from;
        loop {
            while next < self.seen.len() {
                let (event, body) = &self.seen[next];
                if pred(event, body) {
                    return Some(next);
                }
                next += 1;
            }
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(item)) => self.seen.push(item),
                _ => return None,
            }
        }
    }

    fn body(&self, index: Option<usize>) -> Value {
        index.map(|i| self.seen[i].1.clone()).unwrap_or(Value::Null)
    }

    fn text_between(&self, from: usize, to: usize) -> String {
        self.seen[from..to.min(self.seen.len())]
            .iter()
            .filter(|(event, _)| event == "text")
            .filter_map(|(_, body)| body["text"].as_str())
            .collect()
    }

    fn any_between(&self, from: usize, to: usize, pred: impl Fn(&str, &Value) -> bool) -> bool {
        self.seen[from..to.min(self.seen.len())].iter().any(|(event, body)| pred(event, body))
    }
}

fn outbox<'a>(id: &'a str, state: &'static str) -> impl Fn(&str, &Value) -> bool + 'a {
    move |event, body| event == "outbox" && body["id"] == id && body["state"] == state
}

fn host_state(names: &'static [&'static str]) -> impl Fn(&str, &Value) -> bool {
    move |event, body| event == "state" && body["state"].as_str().is_some_and(|s| names.contains(&s))
}

fn kill_report(after: &'static str) -> impl Fn(&str, &Value) -> bool {
    move |event, body| {
        event == "host_health"
            && matches!(body["kind"].as_str(), Some("kill_group" | "kill_refused"))
            && body["after"] == after
    }
}

async fn ask<T>(host: &HostHandle, make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> Cmd) -> Result<T, String> {
    tokio::time::timeout(CALL_WAIT, host.call(make))
        .await
        .map_err(|_| format!("no answer within {}s", CALL_WAIT.as_secs()))?
        .and_then(|answer| answer)
}

async fn send(host: &HostHandle, text: String) -> Result<String, String> {
    ask(host, |reply| Cmd::Send { text, reply }).await
}

/// Kills whatever the host still has running when the test ends, panic or not.
/// Without it, a failing live run leaves a first mate holding the home and the
/// next run reads that as another session.
/// Serializes live runs inside one test binary, which is where `cargo test host_e2e`
/// used to start both live tests at once.
static LIVE_RUN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The right to run a live first mate against one home, held for the whole test.
/// Two hosts on one home make the loser report the winner as another session, so
/// this waits for other tests in this binary and refuses a run started elsewhere.
struct LiveRun {
    lock: PathBuf,
    _in_process: tokio::sync::MutexGuard<'static, ()>,
}

impl LiveRun {
    async fn take(out: &Path, home: &Path) -> LiveRun {
        let _in_process = LIVE_RUN.lock().await;
        let digest = Sha256::digest(home.to_string_lossy().as_bytes());
        let key: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        let lock = out.join(format!("live-run-{key}.lock"));
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
                Ok(mut file) => {
                    let _ = writeln!(file, "{}", std::process::id());
                    return LiveRun { lock, _in_process };
                }
                Err(_) => {
                    let holder = std::fs::read_to_string(&lock)
                        .ok()
                        .and_then(|text| text.trim().parse::<u32>().ok())
                        .filter(|pid| process_alive(*pid));
                    assert!(
                        holder.is_none(),
                        "another live run (pid {}) is already using {}; run one live test at a time and name it exactly, for example cargo test host_e2e_live_scratch_home -- --ignored",
                        holder.unwrap_or_default(),
                        home.display()
                    );
                    let _ = std::fs::remove_file(&lock); // the run that held it is gone
                }
            }
        }
    }
}

impl Drop for LiveRun {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.lock);
    }
}

fn process_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-o", "pid=", "-p", &pid.to_string()])
        .output()
        .map(|out| out.status.success() && !out.stdout.trim_ascii().is_empty())
        .unwrap_or(false)
}

struct StopOnDrop(Arc<HostHandle>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.kill_on_exit();
    }
}

#[derive(PartialEq)]
enum Outcome {
    Passed,
    Failed,
    /// The session never produced this step's conditions, which is not a defect:
    /// the first mate starts a turn of its own when it has reason to, not on cue.
    NotExercised,
}

impl Outcome {
    fn label(&self) -> &'static str {
        match self {
            Outcome::Passed => "PASS",
            Outcome::Failed => "FAIL",
            Outcome::NotExercised => "NOT EXERCISED",
        }
    }
}

struct Step {
    name: &'static str,
    outcome: Outcome,
    evidence: String,
}

fn record(steps: &mut Vec<Step>, name: &'static str, pass: bool, evidence: String) {
    let outcome = if pass { Outcome::Passed } else { Outcome::Failed };
    finish(steps, name, outcome, evidence);
}

/// A step whose conditions the run never produced. It is reported, and it does not
/// fail the run: calling it a failure hid which steps were actually broken.
fn not_exercised(steps: &mut Vec<Step>, name: &'static str, evidence: String) {
    finish(steps, name, Outcome::NotExercised, evidence);
}

fn finish(steps: &mut Vec<Step>, name: &'static str, outcome: Outcome, evidence: String) {
    println!("   {} {name}\n   {evidence}", outcome.label());
    steps.push(Step { name, outcome, evidence });
}

// ---------------------------------------------------------- lock holder ---

fn lock_status(home: &Path) -> String {
    std::process::Command::new(home.join("bin").join("fm-lock.sh"))
        .arg("status")
        .env("FM_HOME", home)
        .current_dir(home)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|e| format!("could not run fm-lock.sh: {e}"))
}

/// Holds the home's session lock for a fake live harness (a `sleep` whose
/// argv[0] is `claude`), and restores the lock file exactly when dropped.
struct FakeHolder {
    lock: PathBuf,
    original: Option<Vec<u8>>,
    child: std::process::Child,
}

impl FakeHolder {
    fn hold(home: &Path) -> FakeHolder {
        let lock = home.join("state").join(".lock");
        let original = std::fs::read(&lock).ok();
        let child = std::process::Command::new("/bin/sleep")
            .arg0("claude")
            .arg("600")
            .spawn()
            .expect("start the fake harness");
        std::fs::write(&lock, child.id().to_string()).expect("write the fake lock");
        FakeHolder { lock, original, child }
    }
}

impl Drop for FakeHolder {
    fn drop(&mut self) {
        match &self.original {
            Some(bytes) => {
                let _ = std::fs::write(&self.lock, bytes);
            }
            None => {
                let _ = std::fs::remove_file(&self.lock);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ----------------------------------------------------------------- test ---

#[tokio::test]
#[ignore = "live: runs the real claude-agent-acp against a firstmate scratch home"]
async fn host_e2e_live_scratch_home() {
    let user_home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let buzz = user_home.join(".buzz");
    let home = std::env::var("FM_E2E_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| buzz.join(".scratch/fm-probe/firstmate"));
    let home = std::fs::canonicalize(&home).expect("the scratch home exists");
    assert!(
        home.starts_with(buzz.join(".scratch")),
        "refusing to run against {}: only homes under ~/.buzz/.scratch are scratch homes",
        home.display()
    );
    let before = lock_status(&home);
    assert!(
        before == "lock: free" || before.starts_with("lock: stale"),
        "the scratch home's lock is not free ({before}); another host may be using it"
    );

    let out = buzz.join(".scratch/firstmate-desktop-e2e");
    std::fs::create_dir_all(&out).expect("create the run folder");
    let _live = LiveRun::take(&out, &home).await;
    let run = now_ms();
    let data_dir = out.join(format!("appdata-{run}"));
    std::fs::create_dir_all(&data_dir).expect("create the app data folder");
    let recording = out.join(format!("recording-{run}.jsonl"));
    let (tx, rx) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        started: Instant::now(),
        file: Mutex::new(std::fs::File::create(&recording).expect("create the recording")),
        data_dir,
        tx,
    });
    println!("home: {}\nrecording: {}", home.display(), recording.display());
    let host = Arc::new(HostHandle::spawn_with(recorder.clone()));
    let _cleanup = StopOnDrop(host.clone());
    let mut events = Events { rx, seen: Vec::new() };
    let mut steps = Vec::new();

    // 1. Start with the lock free: session, then idle or an agent turn.
    recorder.mark("1", "host_start with the lock free");
    let from = events.now();
    let started = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
    let session = events.find(from, Duration::from_secs(5), |e, _| e == "session").await;
    let ready = match session {
        Some(i) => events.find(i, Duration::from_secs(5), host_state(&["idle", "agent_turn"])).await,
        None => None,
    };
    let running = started.is_ok() && session.is_some() && ready.is_some();
    record(
        &mut steps,
        "start: session then idle or agent turn",
        running,
        format!("start={started:?}; session={}; then state={}", events.body(session), events.body(ready)["state"]),
    );

    // 2. A captain message is queued, picked up, and answered.
    let mut answered_at = None;
    if running {
        recorder.mark("2", "send: queued, then picked_up with the reply in text");
        let from = events.now();
        let sent = send(&host, format!("Captain here. {GUARD} Reply with one word: aye.")).await;
        let id = sent.clone().unwrap_or_default();
        let queued = events.find(from, Duration::from_secs(5), outbox(&id, "queued")).await;
        let picked = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
        let reply = picked.map(|p| events.text_between(from, p)).unwrap_or_default();
        answered_at = picked;
        record(
            &mut steps,
            "send: queued, picked_up, reply text",
            sent.is_ok() && queued.is_some() && picked.is_some() && reply.to_lowercase().contains("aye"),
            format!(
                "send={sent:?}; queued={}; picked_up={}; reply text={reply:?}",
                queued.is_some(),
                picked.is_some()
            ),
        );
    } else {
        not_exercised(&mut steps, "send: queued, picked_up, reply text", "the host did not start".into());
    }

    // 3. A message sent during an agent-initiated turn waits for it to end, then is read.
    // Handed over mid-cycle, the CLI folds it into the cycle and its prompt never settles.
    if let Some(after) = answered_at {
        recorder.mark("3", "send during a rewake turn waits for the turn to end and is read");
        let rewake = events.find(after, REWAKE_WAIT, host_state(&["agent_turn"])).await;
        match rewake {
            Some(turn) => {
                let from = events.now();
                let asked = Instant::now();
                let sent = send(&host, format!("Captain again. {GUARD} Reply with one word: two.")).await;
                let id = sent.clone().unwrap_or_default();
                let queued = events.find(from, Duration::from_secs(5), outbox(&id, "queued")).await;
                let picked = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
                let dispatched = events.find(from, Duration::ZERO, outbox(&id, "sent")).await;
                let during = events.body(queued)["while"].clone();
                let idle_first = picked.is_some_and(|p| events.any_between(from, p, host_state(&["idle"])));
                record(
                    &mut steps,
                    "send during a rewake turn",
                    during == "agent_turn" && idle_first && picked.is_some(),
                    format!(
                        "rewake turn={}; queued while={during}; handed over while={}; picked_up={} after {:.1}s; the turn ended before the answer={idle_first}",
                        events.body(Some(turn)),
                        events.body(dispatched)["while"],
                        picked.is_some(),
                        asked.elapsed().as_secs_f32()
                    ),
                );
            }
            None => not_exercised(
                &mut steps,
                "send during a rewake turn",
                format!("no agent-initiated turn within {}s of the reply", REWAKE_WAIT.as_secs()),
            ),
        }
    } else {
        not_exercised(&mut steps, "send during a rewake turn", "no answered message".into());
    }

    // 4. The adapter is killed from outside: dead, and its group is empty.
    let mut unanswered = None;
    let pgid = host.live_groups().first().copied();
    match pgid {
        Some(pgid) if running => {
            recorder.mark("4", "kill -9 the adapter: dead, group empty");
            let from = events.now();
            let sent = send(&host, format!("Captain here. {GUARD} Count from 1 to 60, one number per line.")).await;
            let id = sent.clone().unwrap_or_default();
            let dispatched = events.find(from, Duration::from_secs(10), outbox(&id, "sent")).await;
            // Kill once the adapter is working on it, before its result can arrive.
            let busy = match dispatched {
                Some(d) => {
                    events
                        .find(d, Duration::from_secs(120), |e, b| {
                            e == "text" || (e == "outbox" && b["id"] == id.as_str() && b["state"] == "likely_started")
                        })
                        .await
                }
                None => None,
            };
            let members_before = group_members(pgid);
            let kill_from = events.now();
            // SAFETY: kill only sends a signal.
            let killed = unsafe { libc::kill(pgid as libc::pid_t, libc::SIGKILL) } == 0;
            let dead = events.find(kill_from, Duration::from_secs(30), host_state(&["dead"])).await;
            let report = events.find(kill_from, Duration::from_secs(30), kill_report("exit")).await;
            let members_after = group_members(pgid);
            let answered_first = events.any_between(from, events.seen.len(), outbox(&id, "picked_up"));
            if !answered_first {
                unanswered = Some(id.clone());
            }
            record(
                &mut steps,
                "kill -9: dead, group empty",
                killed && dead.is_some() && report.is_some() && matches!(&members_after, Ok(m) if m.is_empty()),
                format!(
                    "pgid={pgid}; busy before kill={}; group before={members_before:?}; state dead={}; kill report={}; group after={members_after:?}; in-flight message answered before the kill={answered_first}",
                    busy.is_some(),
                    dead.is_some(),
                    events.body(report)
                ),
            );
        }
        _ => not_exercised(&mut steps, "kill -9: dead, group empty", "no running adapter".into()),
    }

    // 5. Restart resumes the conversation and re-sends what was never answered.
    if let Some(id) = unanswered {
        recorder.mark("5", "host_restart: loaded, unanswered message requeued with resent_after_restart");
        let from = events.now();
        let restarted = ask(&host, |reply| Cmd::Restart { reply }).await;
        let session = events.find(from, Duration::from_secs(5), |e, _| e == "session").await;
        let requeued = events
            .find(from, Duration::from_secs(10), |e, b| {
                outbox(&id, "requeued")(e, b) && b["resent_after_restart"] == true
            })
            .await;
        let picked = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
        let trail: Vec<Value> = events.seen[from..]
            .iter()
            .filter(|(e, b)| e == "outbox" && b["id"] == id.as_str())
            .map(|(_, b)| b.clone())
            .collect();
        let mode = events.body(session)["mode"].clone();
        record(
            &mut steps,
            "restart: loaded, requeued with resent_after_restart",
            restarted.is_ok() && mode == "loaded" && requeued.is_some(),
            format!(
                "restart={restarted:?}; session mode={mode}; requeued event={}; answered after restart={}; outbox trail={trail:?}",
                requeued.is_some(),
                picked.is_some()
            ),
        );
    } else {
        not_exercised(
            &mut steps,
            "restart: loaded, requeued with resent_after_restart",
            "no message was left unanswered by the kill".into(),
        );
    }

    // 6. Stop kills the group and reports it.
    match host.live_groups().first().copied() {
        Some(pgid) => {
            recorder.mark("6", "host_stop: group empty, kill_group report");
            let from = events.now();
            let stopped = ask(&host, |reply| Cmd::Stop { reply }).await;
            let report = events.find(from, Duration::from_secs(10), kill_report("stop")).await;
            let members = group_members(pgid);
            let kind = events.body(report)["kind"].clone();
            record(
                &mut steps,
                "stop: group empty, kill_group report",
                stopped.is_ok() && kind == "kill_group" && matches!(&members, Ok(m) if m.is_empty()) && host.live_groups().is_empty(),
                format!("stop={stopped:?}; pgid={pgid}; report={}; group after={members:?}", events.body(report)),
            );
        }
        None => not_exercised(&mut steps, "stop: group empty, kill_group report", "no running adapter".into()),
    }

    // 7. A lock held by another live harness: no spawn.
    recorder.mark("7", "host_start with the lock held by a fake live harness");
    let from = events.now();
    let (held, answer, state, spawned) = {
        let holder = FakeHolder::hold(&home);
        let held = lock_status(&home);
        let answer = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
        let state = events.find(from, Duration::from_secs(10), host_state(&["locked_by_other", "refused"])).await;
        let to = events.now();
        let spawned = !host.live_groups().is_empty() || events.any_between(from, to, |e, _| e == "session");
        drop(holder);
        (held, answer, state, spawned)
    };
    record(
        &mut steps,
        "lock held by a live harness: no spawn",
        held.starts_with("lock: held by live harness pid") && state.is_some() && !spawned,
        format!(
            "fm-lock.sh said {held:?}; start={answer:?}; state={}; spawned={spawned}; lock restored to {:?}",
            events.body(state),
            lock_status(&home)
        ),
    );

    host.kill_on_exit();
    let passed = steps.iter().filter(|s| s.outcome == Outcome::Passed).count();
    let failed = steps.iter().filter(|s| s.outcome == Outcome::Failed).count();
    let not_run = steps.iter().filter(|s| s.outcome == Outcome::NotExercised).count();
    let summary = json!({
        "home": home.to_string_lossy(),
        "recording": recording.to_string_lossy(),
        "passed": passed,
        "failed": failed,
        "not_exercised": not_run,
        "steps": steps
            .iter()
            .map(|s| json!({"step": s.name, "outcome": s.outcome.label(), "evidence": s.evidence}))
            .collect::<Vec<_>>(),
    });
    let _ = std::fs::write(out.join(format!("summary-{run}.json")), serde_json::to_string_pretty(&summary).unwrap_or_default());
    // A run with no failures is usable evidence for the UI replay, even when the session
    // never produced the conditions for every step. A failed run's recording is not.
    if failed == 0 {
        let _ = std::fs::copy(&recording, out.join("recording-latest.jsonl"));
    }
    println!("\n{passed} passed, {failed} failed, {not_run} not exercised; summary-{run}.json");
    assert_eq!(failed, 0, "{}", serde_json::to_string_pretty(&summary).unwrap_or_default());
}

/// Live probe: does the hosted first mate claim the home's session lock on its
/// own right after the session opens, before any prompt is sent?
#[tokio::test]
#[ignore = "live: starts the real claude-agent-acp against a firstmate scratch home"]
async fn host_lock_claim_probe() {
    let buzz = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".buzz");
    let home = std::env::var("FM_E2E_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| buzz.join(".scratch/fm-probe/firstmate"));
    let home = std::fs::canonicalize(&home).expect("the scratch home exists");
    assert!(home.starts_with(buzz.join(".scratch")), "only scratch homes");
    let out = buzz.join(".scratch/firstmate-desktop-e2e");
    std::fs::create_dir_all(&out).expect("create the run folder");
    let _live = LiveRun::take(&out, &home).await;
    let run = now_ms();
    let data_dir = buzz.join(format!(".scratch/firstmate-desktop-e2e/appdata-lockprobe-{run}"));
    std::fs::create_dir_all(&data_dir).unwrap();
    let recording = buzz.join(format!(".scratch/firstmate-desktop-e2e/lockprobe-{run}.jsonl"));
    let (tx, _rx) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        started: Instant::now(),
        file: Mutex::new(std::fs::File::create(&recording).unwrap()),
        data_dir,
        tx,
    });
    let host = Arc::new(HostHandle::spawn_with(recorder.clone()));
    let _cleanup = StopOnDrop(host.clone());
    println!("lock before start: {}", lock_status(&home));
    let asked = Instant::now();
    let started = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
    println!("start={started:?} after {:.1}s; groups={:?}", asked.elapsed().as_secs_f32(), host.live_groups());
    for second in 0..45 {
        let members = host.live_groups().first().map(|g| group_members(*g));
        println!("t+{second}s lock: {} | group: {members:?}", lock_status(&home));
        if lock_status(&home).starts_with("lock: held") {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let _ = ask(&host, |reply| Cmd::Stop { reply }).await;
    println!("lock after stop: {}", lock_status(&home));
}

// --------------------------------------------------- closing and relaunching ---

/// A custom watcher check registered the way a captain registers one, so the
/// home needs supervision and the watcher can be made to wake the first mate on
/// cue: it fires once each time its trigger file appears. Unregistered on drop.
struct TestCheck {
    home: PathBuf,
    trigger: PathBuf,
}

const TEST_CHECK: &str = "hosttest";

impl TestCheck {
    fn register(home: &Path) -> TestCheck {
        use std::os::unix::fs::PermissionsExt;
        let state = home.join("state");
        let trigger = state.join(format!("{TEST_CHECK}.fire"));
        let script = state.join(format!("{TEST_CHECK}.check.sh"));
        let body = format!(
            "#!/usr/bin/env bash\n[ -e '{}' ] || exit 0\nrm -f '{}'\necho 'automated host test wake from the app test harness: acknowledge it and do nothing else'\n",
            trigger.display(),
            trigger.display()
        );
        std::fs::write(&script, body).expect("write the test check");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).expect("make the check private");
        let registered = std::process::Command::new(home.join("bin").join("fm-check-register.sh"))
            .arg(TEST_CHECK)
            .env("FM_HOME", home)
            .current_dir(home)
            .output()
            .expect("run fm-check-register.sh");
        assert!(registered.status.success(), "fm-check-register.sh: {}", String::from_utf8_lossy(&registered.stderr));
        TestCheck { home: home.to_path_buf(), trigger }
    }

    fn fire(&self) {
        std::fs::write(&self.trigger, "").expect("fire the test check");
    }
}

impl Drop for TestCheck {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.trigger);
        let _ = std::process::Command::new(self.home.join("bin").join("fm-check-unregister.sh"))
            .arg(TEST_CHECK)
            .env("FM_HOME", &self.home)
            .current_dir(&self.home)
            .output();
    }
}

/// firstmate watcher processes for this home still running, as `ps` lists them.
fn leftover_watchers(home: &Path) -> Vec<String> {
    let bin = home.join("bin").to_string_lossy().to_string();
    std::process::Command::new("/bin/ps")
        .args(["-Ao", "pid=,command="])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|line| line.contains(&bin) && (line.contains("fm-watch") || line.contains("fm-claude-stop-autoarm")))
                .map(|line| line.trim().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Rows waiting in the home's durable wake queue.
fn queued_wakes(home: &Path) -> usize {
    std::fs::read_to_string(home.join("state").join(".wake-queue"))
        .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

/// A captain's inbox note, the firstmate path that queues a wake while nobody is watching.
fn inbox_note(home: &Path, text: &str) -> bool {
    std::process::Command::new(home.join("bin").join("fm-inbox.sh"))
        .args(["note", text])
        .env("FM_HOME", home)
        .current_dir(home)
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Live run of what a captain does across an app restart: talk to the first mate,
/// get woken work, send a message while the first mate is busy with a wake, close
/// the app while it is idle, let wakes arrive while it is closed, and open the app
/// again. The relaunch must bring back the earlier conversation and the first mate
/// must pick up the waiting wakes on its own, without a captain message.
///
/// ```sh
/// cd src-tauri && FM_E2E_HOME=<scratch home> cargo test host_e2e_live_relaunch -- --ignored --nocapture
/// ```
#[tokio::test]
#[ignore = "live: runs the real claude-agent-acp against a firstmate scratch home"]
async fn host_e2e_live_relaunch() {
    let buzz = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".buzz");
    let home = std::env::var("FM_E2E_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| buzz.join(".scratch/fm-probe/firstmate"));
    let home = std::fs::canonicalize(&home).expect("the scratch home exists");
    assert!(home.starts_with(buzz.join(".scratch")), "only scratch homes");
    let before = lock_status(&home);
    assert!(
        before == "lock: free" || before.starts_with("lock: stale"),
        "the scratch home's lock is not free ({before}); another host may be using it"
    );
    // The watcher runs custom checks every FM_CHECK_INTERVAL seconds; the first mate's
    // hooks inherit it through the adapter, so the test check answers within a poll or two.
    std::env::set_var("FM_CHECK_INTERVAL", "15");

    let out = buzz.join(".scratch/firstmate-desktop-e2e");
    std::fs::create_dir_all(&out).expect("create the run folder");
    let _live = LiveRun::take(&out, &home).await;
    let run = now_ms();
    let data_dir = out.join(format!("appdata-relaunch-{run}"));
    std::fs::create_dir_all(&data_dir).expect("create the app data folder");
    let recording = out.join(format!("relaunch-{run}.jsonl"));
    let (tx, rx) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        started: Instant::now(),
        file: Mutex::new(std::fs::File::create(&recording).expect("create the recording")),
        data_dir,
        tx,
    });
    println!("home: {}\nrecording: {}", home.display(), recording.display());
    let mut events = Events { rx, seen: Vec::new() };
    let mut steps = Vec::new();
    let check = TestCheck::register(&home);

    // 1. First launch: the first mate starts and answers.
    recorder.mark("1", "first launch: start, and a message answered");
    let host = Arc::new(HostHandle::spawn_with(recorder.clone()));
    let cleanup = StopOnDrop(host.clone());
    let from = events.now();
    let started = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
    let sent = send(&host, format!("Captain here. {GUARD} Reply with one word: aye.")).await;
    let id = sent.clone().unwrap_or_default();
    let picked = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
    let reply = picked.map(|p| events.text_between(from, p)).unwrap_or_default();
    let running = started.is_ok() && picked.is_some();
    record(
        &mut steps,
        "first launch: started and answered",
        running && reply.to_lowercase().contains("aye"),
        format!("start={started:?}; send={sent:?}; picked_up={}; reply={reply:?}", picked.is_some()),
    );

    // 2. A wake arrives, and the captain writes while the first mate handles it.
    if running {
        recorder.mark("2", "a watcher wake starts a turn, and a message sent during it is read");
        let from = events.now();
        check.fire();
        let turn = events.find(from, REWAKE_WAIT * 2, host_state(&["agent_turn"])).await;
        match turn {
            Some(turn) => {
                let from = events.now();
                let sent = send(&host, format!("Captain again. {GUARD} Reply with one word: two.")).await;
                let id = sent.clone().unwrap_or_default();
                let queued = events.find(from, Duration::from_secs(5), outbox(&id, "queued")).await;
                let picked = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
                let to = picked.unwrap_or(events.now());
                let reply = events.text_between(from, to);
                record(
                    &mut steps,
                    "a message sent during a wake turn is read",
                    picked.is_some(),
                    format!(
                        "wake turn={}; queued while={}; picked_up={}; text meanwhile={reply:?}; outbox trail={:?}",
                        events.body(Some(turn)),
                        events.body(queued)["while"],
                        picked.is_some(),
                        events.seen[from..]
                            .iter()
                            .filter(|(e, b)| e == "outbox" && b["id"] == id.as_str())
                            .map(|(_, b)| b["state"].clone())
                            .collect::<Vec<_>>()
                    ),
                );
            }
            None => not_exercised(
                &mut steps,
                "a message sent during a wake turn is read",
                format!("the test check's wake started no turn within {}s", (REWAKE_WAIT * 2).as_secs()),
            ),
        }
    } else {
        not_exercised(&mut steps, "a message sent during a wake turn is read", "the first launch did not answer".into());
    }

    // 3. The app closes while the first mate is idle, and wakes arrive while it is closed.
    recorder.mark("3", "the app closes while idle; wakes arrive while it is closed");
    let quiet = events.now();
    let last_state = events.seen.iter().rposition(|(e, _)| e == "state");
    let idle = match last_state {
        Some(at) if events.seen[at].1["state"] == "idle" => Some(at),
        _ => events.find(quiet, Duration::from_secs(120), host_state(&["idle"])).await,
    };
    host.kill_on_exit();
    drop(cleanup);
    drop(host);
    let leftovers = leftover_watchers(&home);
    record(
        &mut steps,
        "closing the app leaves no watcher behind",
        leftovers.is_empty(),
        format!("watcher processes still running for this home: {leftovers:?}"),
    );
    let noted = (1..=3).all(|n| inbox_note(&home, &format!("Automated host test note {n} of 3: acknowledge it and do nothing else.")));
    let waiting = queued_wakes(&home);
    println!("   closed while idle={}; notes queued={noted}; wake rows waiting={waiting}", idle.is_some());

    // 4. The app opens again: the earlier conversation comes back.
    recorder.mark("4", "relaunch: start, and the earlier conversation comes back");
    let host = Arc::new(HostHandle::spawn_with(recorder.clone()));
    let _cleanup = StopOnDrop(host.clone());
    let from = events.now();
    let started = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
    let session = events.find(from, Duration::from_secs(5), |e, _| e == "session").await;
    let history = events.find(from, Duration::from_secs(5), |e, _| e == "history").await;
    let items = events.body(history)["items"].as_array().cloned().unwrap_or_default();
    let has = |who: &str, needle: &str| {
        items.iter().any(|item| item["who"] == who && item["text"].as_str().is_some_and(|t| t.to_lowercase().contains(needle)))
    };
    record(
        &mut steps,
        "relaunch: the earlier conversation comes back",
        started.is_ok() && events.body(session)["mode"] == "loaded" && has("captain", "reply with one word: aye") && has("mate", "aye"),
        format!("start={started:?}; session={}; history items={}", events.body(session), items.len()),
    );

    // 5. The wakes that arrived while the app was closed are picked up without a captain message.
    recorder.mark("5", "relaunch: waiting wakes are handled without a captain message");
    let deadline = Instant::now() + Duration::from_secs(300);
    while queued_wakes(&home) > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    let left = queued_wakes(&home);
    let to = events.now();
    let turns = events.seen[from..to].iter().filter(|(e, b)| e == "state" && b["state"] == "agent_turn").count();
    let captain = events.any_between(from, to, |e, b| e == "outbox" && b["state"] == "sent");
    if waiting == 0 {
        not_exercised(&mut steps, "relaunch: waiting wakes are handled on their own", "no wake was waiting at relaunch".into());
    } else {
        record(
            &mut steps,
            "relaunch: waiting wakes are handled on their own",
            left == 0 && !captain,
            format!("wake rows at relaunch={waiting}; left after the wait={left}; agent turns={turns}; captain messages sent={captain}"),
        );
    }

    // 6. A window that opens now, such as one reloaded, reads the same conversation from the host.
    recorder.mark("6", "a window opened after the relaunch reads the conversation from the host");
    let state = tokio::time::timeout(CALL_WAIT, host.call(|reply| Cmd::GetState { reply })).await.ok().and_then(Result::ok);
    let kept = state
        .as_ref()
        .and_then(|state| state["conversation"]["items"].as_array().cloned())
        .unwrap_or_default();
    let kept_has = |who: &str, needle: &str| {
        kept.iter().any(|item| item["who"] == who && item["text"].as_str().is_some_and(|t| t.to_lowercase().contains(needle)))
    };
    record(
        &mut steps,
        "a window opened after the relaunch gets the conversation",
        kept_has("captain", "reply with one word: aye") && kept_has("mate", "aye") && kept.len() >= items.len(),
        format!("conversation items={} (history had {})", kept.len(), items.len()),
    );

    let _ = ask(&host, |reply| Cmd::Stop { reply }).await;
    drop(check);
    let failed = steps.iter().filter(|s| s.outcome == Outcome::Failed).count();
    let summary = json!({
        "home": home.to_string_lossy(),
        "recording": recording.to_string_lossy(),
        "steps": steps.iter().map(|s| json!({"step": s.name, "outcome": s.outcome.label(), "evidence": s.evidence})).collect::<Vec<_>>(),
    });
    let _ = std::fs::write(out.join(format!("summary-relaunch-{run}.json")), serde_json::to_string_pretty(&summary).unwrap_or_default());
    // The UI replay plays a passing run's relaunch into a fresh window.
    if failed == 0 {
        let _ = std::fs::copy(&recording, out.join("relaunch-latest.jsonl"));
    }
    println!("\nrecording: {}", recording.display());
    assert_eq!(failed, 0, "{}", serde_json::to_string_pretty(&summary).unwrap_or_default());
}

// ------------------------------------------------- the review of a call ---

/// Reads the home's snapshot once, for the rows the review screen reads.
fn snapshot_json(home: &Path) -> Value {
    let out = std::process::Command::new(home.join("bin").join("fm-fleet-snapshot.sh"))
        .arg("--json")
        .env("FM_HOME", home)
        .current_dir(home)
        .output()
        .expect("run fm-fleet-snapshot.sh");
    serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
}

/// Whether the backlog still says this task is waiting on the captain.
fn still_waiting(home: &Path, task: &str) -> bool {
    snapshot_json(home)["backlog"]["records"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .any(|row| row["id"] == task && row["captain_actionable"] == Value::Bool(true))
        })
        .unwrap_or(false)
}

/// The evidence ref a page answers to, as firstmate's calls name it.
fn page_ref(page: &Value) -> String {
    match page["scope"].as_str() {
        Some("task") => format!("page:task/{}/{}", page["task"].as_str().unwrap_or_default(), page["name"].as_str().unwrap_or_default()),
        _ => format!("page:chat/{}", page["name"].as_str().unwrap_or_default()),
    }
}

/// A call the home is carrying, whole: the open call with its options, the
/// option to pick, and the page its evidence names. Any piece missing means
/// there is no call to answer.
fn call_on_offer(home: &Path) -> Option<(String, Value, String, String, String)> {
    let snapshot = snapshot_json(home);
    let pages = snapshot["artifacts"].as_array()?.clone();
    snapshot["calls"].as_array()?.iter().find_map(|call| {
        if call["state"] != "open" || call["captain_actionable"] != Value::Bool(true) {
            return None;
        }
        // Only a question-shaped call: answering one that releases held work would
        // start that work for real, and a test must never set real work going.
        if call["on_answer"] != "done" {
            return None;
        }
        let evidence = call["evidence"].as_array()?;
        let page = pages.iter().find(|page| evidence.iter().any(|item| item.as_str() == Some(page_ref(page).as_str())))?.clone();
        let list = call["options"].as_array()?;
        let pick = list.iter().find(|option| option["recommended"] == Value::Bool(true)).or_else(|| list.first())?;
        Some((
            call["id"].as_str()?.to_string(),
            page,
            pick["key"].as_str()?.to_string(),
            pick["label"].as_str()?.to_string(),
            call["on_answer"].as_str()?.to_string(),
        ))
    })
}

/// What the first mate is asked for when the home is carrying no call. It is a
/// captain's request in the captain's own words, so what comes back is whatever
/// the first mate would really do, not a shape the test dictated.
const ASK_FOR_A_CALL: &str = "Captain here. This is an automated host test in a scratch home, so keep it to this one thing: do not dispatch work, change any project, or contact anyone. I need one decision from you. Pick something small and real about the demo project that genuinely needs my call, put it to me the way you would any call, with its question, options and a recommendation, and present a page that argues it so I can decide from the page itself.";

/// A live run of the one path the mock cannot prove: a call the first mate is
/// really holding, answered from the page that argues it, recorded through
/// firstmate's own intake, and sent as one review the first mate follows up on.
///
/// ```sh
/// cd src-tauri && FM_E2E_HOME=<scratch home> \
///   cargo test review_e2e_live_decision -- --ignored --nocapture
/// ```
///
/// The run needs the home to be carrying a call: an open call in the snapshot's
/// `calls[]` with options, whose evidence names a presented page. If the home has one
/// already it is used; otherwise the first mate is asked for one and produces it
/// the way it would for a real captain. Nothing here is hand-built, because a
/// hold written by the test would prove nothing about the path it is testing.
#[tokio::test]
#[ignore = "live: runs the real claude-agent-acp against a firstmate scratch home"]
async fn review_e2e_live_decision() {
    let buzz = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".buzz");
    let home = std::env::var("FM_E2E_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| buzz.join(".scratch/fm-probe/firstmate"));
    let home = std::fs::canonicalize(&home).expect("the scratch home exists");
    assert!(home.starts_with(buzz.join(".scratch")), "only scratch homes");

    let out = buzz.join(".scratch/firstmate-desktop-e2e");
    std::fs::create_dir_all(&out).expect("create the run folder");
    let _live = LiveRun::take(&out, &home).await;
    let run = now_ms();
    let data_dir = out.join(format!("appdata-decision-{run}"));
    std::fs::create_dir_all(&data_dir).expect("create the app data folder");
    let recording = out.join(format!("decision-{run}.jsonl"));
    let (tx, rx) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        started: Instant::now(),
        file: Mutex::new(std::fs::File::create(&recording).expect("create the recording")),
        data_dir,
        tx,
    });
    let host = Arc::new(HostHandle::spawn_with(recorder.clone()));
    let _cleanup = StopOnDrop(host.clone());
    let mut events = Events { rx, seen: Vec::new() };
    let mut steps = Vec::new();

    // 1. The first mate is up.
    recorder.mark("1", "host_start against the home carrying the call");
    let from = events.now();
    let started = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
    let session = events.find(from, Duration::from_secs(5), |e, _| e == "session").await;
    let ready = match session {
        Some(i) => events.find(i, Duration::from_secs(30), host_state(&["idle", "agent_turn"])).await,
        None => None,
    };
    let running = started.is_ok() && ready.is_some();
    record(&mut steps, "start: the first mate is running", running, format!("start={started:?}; state={}", events.body(ready)["state"]));

    // 2. A call to answer: the one the home already carries, or one the first mate puts up.
    let mut offer = call_on_offer(&home);
    if running && offer.is_none() {
        recorder.mark("2", "ask the first mate to put a call to the captain");
        println!("no call is waiting; asking the first mate for one");
        let asked = send(&host, ASK_FOR_A_CALL.to_string()).await;
        let deadline = Instant::now() + Duration::from_secs(900);
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_secs(15)).await;
            offer = call_on_offer(&home);
            if offer.is_some() {
                break;
            }
        }
        record(
            &mut steps,
            "the first mate puts a call up: held, with options and a page",
            offer.is_some(),
            format!("ask={asked:?}; call={:?}", offer.as_ref().map(|(call, ..)| call.clone())),
        );
    }
    let Some((call, page, key, label, on_answer)) = offer else {
        not_exercised(&mut steps, "the intake records the answer and the review reaches the first mate", "no call to answer".into());
        not_exercised(&mut steps, "the call stops waiting in the backlog", "no call to answer".into());
        let _ = ask(&host, |reply| Cmd::Stop { reply }).await;
        let failed: Vec<&str> = steps.iter().filter(|step| matches!(step.outcome, Outcome::Failed)).map(|step| step.name).collect();
        assert!(failed.is_empty(), "failed: {failed:?}");
        return;
    };
    println!("call: {call}\npage: {}\npicking: {key}", page["name"].as_str().unwrap_or_default());

    // 3. The review the app would send: the captain's answer, a comment, one message.
    let dir = review::artifact_dir(
        &home.join("data"),
        page["scope"].as_str().unwrap_or_default(),
        page["task"].as_str(),
        page["name"].as_str().unwrap_or_default(),
    )
    .expect("the page's own folder");
    let log = dir.join("review.jsonl");
    let rev = page["latest"]["rev"].as_u64().unwrap_or(1);
    let sent = if running {
        recorder.mark("3", "answer the call in the page, and send the review");
        review::stage_answer(&log, &call, Some(&key), Some(&label), Some(&on_answer), &review::Words::default()).expect("stage the answer");
        review::add_comment(&log, rev, "Say in the page what this costs us if we change our minds later.", None, None, None)
            .expect("write the comment");
        // What sending does first: firstmate's own intake records the answer.
        let outcomes = review::record_staged(&home, &log, None).await.expect("run the intake");
        println!("intake: {outcomes:?}");
        let (text, threads, answers) = review::draft(&dir, rev, "approve").expect("compose the review");
        println!("--- the message ---\n{text}\n-------------------");
        let carries = text.contains(&format!("Recorded: {call} = {key}"));
        let from = events.now();
        let id = send(&host, text.clone()).await;
        let message = id.clone().unwrap_or_default();
        let picked = events.find(from, REPLY_WAIT, outbox(&message, "picked_up")).await;
        if picked.is_some() {
            review::record_sent(&log, "approve", rev, &threads, &answers, &message, &text).expect("record that it went");
        }
        record(
            &mut steps,
            "the intake records the answer and the review reaches the first mate",
            carries && picked.is_some(),
            format!("states the answer as recorded={carries}; send={id:?}; picked_up={}", picked.is_some()),
        );
        picked.is_some()
    } else {
        not_exercised(&mut steps, "the intake records the answer and the review reaches the first mate", "the host did not start".into());
        false
    };

    // 4. The first mate records the answer, and the call stops waiting.
    if sent {
        recorder.mark("4", "the call clears in the backlog");
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut cleared = false;
        while Instant::now() < deadline {
            if !still_waiting(&home, &call) {
                cleared = true;
                break;
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        let row = snapshot_json(&home)["backlog"]["records"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == call.as_str()).cloned())
            .unwrap_or(Value::Null);
        record(
            &mut steps,
            "the call stops waiting in the backlog",
            cleared,
            format!("state={}; captain_actionable={}; hold={}", row["state"], row["captain_actionable"], row["hold_reason"]),
        );
    } else {
        not_exercised(&mut steps, "the call stops waiting in the backlog", "the review never went".into());
    }

    let _ = ask(&host, |reply| Cmd::Stop { reply }).await;
    println!("\nrecording: {}", recording.display());
    let failed: Vec<&str> = steps.iter().filter(|step| matches!(step.outcome, Outcome::Failed)).map(|step| step.name).collect();
    assert!(failed.is_empty(), "failed: {failed:?}");
}

// -------------------------------------------------------------- attach ---

/// The message the UI sends with `files`, written by `src/attachments.ts` itself
/// so this test sends exactly what the composer would.
fn ui_message(text: &str, files: &[crate::attach::Attached]) -> String {
    let files: Vec<Value> = files
        .iter()
        .map(|file| json!({"name": file.name, "path": file.path.to_string_lossy(), "source": file.source.to_string_lossy(), "bytes": file.bytes}))
        .collect();
    let module = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/attachments.ts");
    let script = "const [module, text, files] = process.argv.slice(1); const { withAttachments } = await import(module); process.stdout.write(withAttachments(text, JSON.parse(files)));";
    let node = crate::envpath::resolve("node").expect("node is installed");
    let output = std::process::Command::new(node)
        .args(["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script])
        .arg(module.canonicalize().expect("src/attachments.ts"))
        .arg(text)
        .arg(Value::Array(files).to_string())
        .output()
        .expect("run node");
    assert!(output.status.success(), "node: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).expect("the message is text")
}

/// A file the captain picks and sends: a name with spaces, an apostrophe and
/// characters beyond ASCII, holding a word the first mate can only know by
/// reading it. It is checked when picked and copied into the home when sent, as
/// the composer does; the original is then removed, so only the copy can answer.
fn sent_file(home: &Path, dir: &Path, name: &str, word: &str) -> crate::attach::Attached {
    let source = dir.join(name);
    std::fs::write(&source, format!("Captain's attachment for the host test.\nThe code word is {word}.\n")).expect("write the file");
    crate::attach::check(&source).expect("pick the file");
    let file = crate::attach::copy_all(home, std::slice::from_ref(&source)).expect("attach the file").remove(0);
    std::fs::remove_file(&source).expect("remove the original");
    file
}

/// Live test of an attached file reaching the first mate. Spends model tokens:
///
/// ```sh
/// cd src-tauri && FM_E2E_HOME=<scratch home> cargo test attach_e2e_live_scratch_home -- --ignored --nocapture
/// ```
///
/// A file is attached the way the Attach button attaches one and sent in the
/// message the composer writes; the first mate must answer with a word only the
/// file holds. A second one is sent and the host restarted while the first mate
/// works on it: it must be re-sent from the durable outbox and still be read.
#[tokio::test]
#[ignore = "live: runs the real claude-agent-acp against a firstmate scratch home"]
async fn attach_e2e_live_scratch_home() {
    let buzz = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".buzz");
    let home = std::env::var("FM_E2E_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| buzz.join(".scratch/fm-probe/firstmate"));
    let home = std::fs::canonicalize(&home).expect("the scratch home exists");
    assert!(home.starts_with(buzz.join(".scratch")), "only scratch homes");
    let before = lock_status(&home);
    assert!(
        before == "lock: free" || before.starts_with("lock: stale"),
        "the scratch home's lock is not free ({before}); another host may be using it"
    );

    let out = buzz.join(".scratch/firstmate-desktop-e2e");
    std::fs::create_dir_all(&out).expect("create the run folder");
    let _live = LiveRun::take(&out, &home).await;
    let run = now_ms();
    let data_dir = out.join(format!("appdata-attach-{run}"));
    std::fs::create_dir_all(&data_dir).expect("create the app data folder");
    let picked = out.join(format!("picked-{run}"));
    std::fs::create_dir_all(&picked).expect("create the folder files are picked from");
    let recording = out.join(format!("attach-{run}.jsonl"));
    let (tx, rx) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        started: Instant::now(),
        file: Mutex::new(std::fs::File::create(&recording).expect("create the recording")),
        data_dir,
        tx,
    });
    println!("home: {}\nrecording: {}", home.display(), recording.display());
    let host = Arc::new(HostHandle::spawn_with(recorder.clone()));
    let _cleanup = StopOnDrop(host.clone());
    let mut events = Events { rx, seen: Vec::new() };
    let mut steps = Vec::new();

    recorder.mark("1", "host_start");
    let from = events.now();
    let started = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
    let session = events.find(from, Duration::from_secs(5), |e, _| e == "session").await;
    let ready = match session {
        Some(i) => events.find(i, Duration::from_secs(30), host_state(&["idle", "agent_turn"])).await,
        None => None,
    };
    let running = started.is_ok() && ready.is_some();
    record(&mut steps, "start: the first mate is running", running, format!("start={started:?}; state={}", events.body(ready)["state"]));

    // 2. An attached file is read, and the answer comes from inside it.
    if running {
        recorder.mark("2", "send a message with an attached file; the reply names the word inside it");
        let word = format!("LANTERN-{}", run % 100_000);
        let file = sent_file(&home, &picked, "captain's notes 日本 résumé.txt", &word);
        let text = ui_message(&format!("{GUARD} Read the attached file and reply with only the code word it gives."), std::slice::from_ref(&file));
        let from = events.now();
        let sent = send(&host, text.clone()).await;
        let id = sent.clone().unwrap_or_default();
        let picked_up = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
        let reply = picked_up.map(|p| events.text_between(from, p)).unwrap_or_default();
        record(
            &mut steps,
            "attach: the first mate reads the file and answers from it",
            sent.is_ok() && picked_up.is_some() && reply.contains(&word),
            format!("copy={}; message={text:?}; picked_up={}; reply={reply:?}", file.path.display(), picked_up.is_some()),
        );
    } else {
        not_exercised(&mut steps, "attach: the first mate reads the file and answers from it", "the host did not start".into());
    }

    // 3. A message with a file survives a restart the way words do.
    if running {
        recorder.mark("3", "restart while the first mate works on an attached file; it is re-sent and read");
        let word = format!("HARBOUR-{}", run % 100_000);
        let file = sent_file(&home, &picked, "second file with spaces.md", &word);
        let text = ui_message(
            &format!("{GUARD} First count from 1 to 40, one number per line. Then read the attached file and end your reply with the code word it gives."),
            std::slice::from_ref(&file),
        );
        let from = events.now();
        let sent = send(&host, text).await;
        let id = sent.clone().unwrap_or_default();
        let dispatched = events.find(from, Duration::from_secs(60), outbox(&id, "sent")).await;
        let busy = match dispatched {
            Some(d) => events.find(d, Duration::from_secs(120), |e, _| e == "text" || e == "tool_call").await,
            None => None,
        };
        let answered_first = events.any_between(from, events.seen.len(), outbox(&id, "picked_up"));
        let restart_from = events.now();
        let restarted = ask(&host, |reply| Cmd::Restart { reply }).await;
        let requeued = events
            .find(restart_from, Duration::from_secs(30), |e, b| outbox(&id, "requeued")(e, b) && b["resent_after_restart"] == true)
            .await;
        let picked_up = events.find(restart_from, REPLY_WAIT, outbox(&id, "picked_up")).await;
        let reply = picked_up.map(|p| events.text_between(restart_from, p)).unwrap_or_default();
        if answered_first {
            not_exercised(&mut steps, "attach: re-sent after a restart and still read", "the first mate answered before the restart".into());
        } else {
            record(
                &mut steps,
                "attach: re-sent after a restart and still read",
                busy.is_some() && restarted.is_ok() && requeued.is_some() && picked_up.is_some() && reply.contains(&word),
                format!(
                    "busy before restart={}; restart={restarted:?}; requeued={}; picked_up after restart={}; reply ends={:?}",
                    busy.is_some(),
                    events.body(requeued),
                    picked_up.is_some(),
                    reply.chars().rev().take(120).collect::<String>().chars().rev().collect::<String>()
                ),
            );
        }
    } else {
        not_exercised(&mut steps, "attach: re-sent after a restart and still read", "the host did not start".into());
    }

    let _ = ask(&host, |reply| Cmd::Stop { reply }).await;
    let _ = std::fs::remove_dir_all(&picked);
    println!("\nrecording: {}", recording.display());
    let failed: Vec<&str> = steps.iter().filter(|step| matches!(step.outcome, Outcome::Failed)).map(|step| step.name).collect();
    assert!(failed.is_empty(), "failed: {failed:?}");
}

fn used_tokens(event: &str, body: &Value) -> Option<u64> {
    (event == "usage").then(|| body["update"]["used"].as_u64()).flatten()
}

/// The last context reading at or before `to`.
fn last_used(events: &Events, to: usize) -> Option<u64> {
    events.seen[..to.min(events.seen.len())].iter().rev().find_map(|(event, body)| used_tokens(event, body))
}

/// The smallest context reading between two points.
fn least_used(events: &Events, from: usize, to: usize) -> Option<u64> {
    events.seen[from..to.min(events.seen.len())].iter().filter_map(|(event, body)| used_tokens(event, body)).min()
}

/// Live test of Compact now: the app compacts the first mate's conversation by
/// sending `/compact` through the ordinary message path, which the adapter runs
/// as Claude Code's own command. Once while the first mate is idle, where the
/// context reading must drop and the adapter must say it compacted; and once
/// sent while a turn is still running, where it must wait for that turn and
/// then compact, without cutting the turn short.
#[tokio::test]
#[ignore = "live: runs the real claude-agent-acp against a firstmate scratch home"]
async fn compact_e2e_live_scratch_home() {
    let buzz = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".buzz");
    let home = std::env::var("FM_E2E_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| buzz.join(".scratch/fm-probe/firstmate"));
    let home = std::fs::canonicalize(&home).expect("the scratch home exists");
    assert!(home.starts_with(buzz.join(".scratch")), "only scratch homes");
    let before = lock_status(&home);
    assert!(
        before == "lock: free" || before.starts_with("lock: stale"),
        "the scratch home's lock is not free ({before}); another host may be using it"
    );

    let out = buzz.join(".scratch/firstmate-desktop-e2e");
    std::fs::create_dir_all(&out).expect("create the run folder");
    let _live = LiveRun::take(&out, &home).await;
    let run = now_ms();
    let data_dir = out.join(format!("appdata-compact-{run}"));
    std::fs::create_dir_all(&data_dir).expect("create the app data folder");
    let recording = out.join(format!("compact-{run}.jsonl"));
    let (tx, rx) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        started: Instant::now(),
        file: Mutex::new(std::fs::File::create(&recording).expect("create the recording")),
        data_dir,
        tx,
    });
    println!("home: {}\nrecording: {}", home.display(), recording.display());
    let host = Arc::new(HostHandle::spawn_with(recorder.clone()));
    let _cleanup = StopOnDrop(host.clone());
    let mut events = Events { rx, seen: Vec::new() };
    let mut steps = Vec::new();

    recorder.mark("1", "host_start");
    let from = events.now();
    let started = ask(&host, |reply| Cmd::Start { home: home.clone(), reply }).await;
    let session = events.find(from, Duration::from_secs(5), |e, _| e == "session").await;
    let ready = match session {
        Some(i) => events.find(i, Duration::from_secs(30), host_state(&["idle", "agent_turn"])).await,
        None => None,
    };
    let running = started.is_ok() && ready.is_some();
    record(&mut steps, "start: the first mate is running", running, format!("start={started:?}; state={}", events.body(ready)["state"]));

    // 2. Something in the conversation to compact, and a reading of its size.
    let mut warmed = None;
    if running {
        recorder.mark("2", "a first exchange, so there is a conversation to compact");
        let from = events.now();
        let sent = send(&host, format!("{GUARD} Reply with only the word READY.")).await;
        let id = sent.clone().unwrap_or_default();
        let picked_up = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
        warmed = picked_up;
        record(&mut steps, "warm up: the first mate answers", warmed.is_some(), format!("sent={sent:?}; reading={:?}", picked_up.and_then(|p| last_used(&events, p))));
    } else {
        not_exercised(&mut steps, "warm up: the first mate answers", "the host did not start".into());
    }

    // 3. Compact now, while the first mate is idle.
    if let Some(answered) = warmed {
        recorder.mark("3", "send /compact while idle; the reading drops and the adapter says it compacted");
        let _ = events.find(answered, Duration::from_secs(120), host_state(&["idle"])).await;
        let from = events.now();
        let size_before = last_used(&events, from);
        let sent = send(&host, "/compact".to_string()).await;
        let id = sent.clone().unwrap_or_default();
        let done = events.find(from, REPLY_WAIT, |e, b| outbox(&id, "picked_up")(e, b) || outbox(&id, "failed")(e, b)).await;
        // The reading that follows compaction can land just after the result.
        let _ = events.find(done.unwrap_or(from) + 1, Duration::from_secs(10), |e, _| e == "usage").await;
        let end = events.now();
        let said = events.text_between(from, end);
        let size_after = least_used(&events, from, end);
        let picked = events.body(done)["state"] == "picked_up";
        let ended = events.find(from, Duration::from_secs(5), |e, b| e == "compact" && b["id"] == id.as_str() && matches!(b["state"].as_str(), Some("done" | "failed"))).await;
        let ended = events.body(ended);
        record(
            &mut steps,
            "compact when idle: it compacts and the reading drops",
            picked
                && said.contains("Compacting completed")
                && matches!((size_before, size_after), (Some(b), Some(a)) if a < b)
                && ended["state"] == "done"
                && ended["context"]["compacted"]["to"].as_u64() == size_after,
            format!("sent={sent:?}; outcome={}; before={size_before:?}; after={size_after:?}; said={said:?}; host said={ended}", events.body(done)),
        );
    } else {
        not_exercised(&mut steps, "compact when idle: it compacts and the reading drops", "there was no conversation to compact".into());
    }

    // 4. Compact now, sent while a turn is still running.
    if warmed.is_some() {
        recorder.mark("4", "send /compact while a turn runs; it waits for that turn, then compacts");
        let from = events.now();
        let long = send(&host, format!("{GUARD} Count from 1 to 60, one number per line, then say DONE.")).await;
        let long_id = long.clone().unwrap_or_default();
        let busy = events.find(from, Duration::from_secs(120), |e, _| e == "text").await;
        let compact = send(&host, "/compact".to_string()).await;
        let compact_id = compact.clone().unwrap_or_default();
        let long_done = events.find(from, REPLY_WAIT, |e, b| outbox(&long_id, "picked_up")(e, b) || outbox(&long_id, "failed")(e, b)).await;
        let compact_done = events.find(from, REPLY_WAIT, |e, b| outbox(&compact_id, "picked_up")(e, b) || outbox(&compact_id, "failed")(e, b)).await;
        let end = events.now();
        let said = events.text_between(from, end);
        let in_order = matches!((long_done, compact_done), (Some(l), Some(c)) if l < c);
        let ended = events.find(from, Duration::from_secs(5), |e, b| e == "compact" && b["id"] == compact_id.as_str() && matches!(b["state"].as_str(), Some("done" | "failed"))).await;
        let ended = events.body(ended);
        record(
            &mut steps,
            "compact mid-turn: the turn finishes first, then it compacts",
            busy.is_some()
                && events.body(long_done)["state"] == "picked_up"
                && events.body(compact_done)["state"] == "picked_up"
                && in_order
                && said.contains("DONE")
                && said.contains("Compacting completed")
                && ended["state"] == "done",
            format!(
                "busy when sent={}; turn={}; compact={}; turn ended first={in_order}; host said={ended}; said ends={:?}",
                busy.is_some(),
                events.body(long_done),
                events.body(compact_done),
                said.chars().rev().take(160).collect::<String>().chars().rev().collect::<String>()
            ),
        );
    } else {
        not_exercised(&mut steps, "compact mid-turn: the turn finishes first, then it compacts", "there was no conversation to compact".into());
    }

    let _ = ask(&host, |reply| Cmd::Stop { reply }).await;
    println!("\nrecording: {}", recording.display());
    let failed: Vec<&str> = steps.iter().filter(|step| matches!(step.outcome, Outcome::Failed)).map(|step| step.name).collect();
    assert!(failed.is_empty(), "failed: {failed:?}");
}
