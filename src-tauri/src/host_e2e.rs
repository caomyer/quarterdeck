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

    // 3. A message sent during an agent-initiated turn is handed over at once.
    if let Some(after) = answered_at {
        recorder.mark("3", "send during a rewake turn is dispatched without waiting for idle");
        let rewake = events.find(after, REWAKE_WAIT, host_state(&["agent_turn"])).await;
        match rewake {
            Some(turn) => {
                let from = events.now();
                let asked = Instant::now();
                let sent = send(&host, format!("Captain again. {GUARD} Reply with one word: two.")).await;
                let id = sent.clone().unwrap_or_default();
                let dispatched = events.find(from, Duration::from_secs(5), outbox(&id, "sent")).await;
                let picked = events.find(from, REPLY_WAIT, outbox(&id, "picked_up")).await;
                let during = events.body(dispatched)["while"].clone();
                let idle_first = picked.is_some_and(|p| events.any_between(from, p, host_state(&["idle"])));
                record(
                    &mut steps,
                    "send during a rewake turn",
                    during == "agent_turn" && picked.is_some(),
                    format!(
                        "rewake turn={}; sent while={during}; picked_up={} after {:.1}s; went idle before the answer={idle_first}",
                        events.body(Some(turn)),
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

/// A call the home is carrying, whole: the held task, the option to pick, and
/// the page that argues it. Any piece missing means there is no call to answer.
fn call_on_offer(home: &Path) -> Option<(String, Value, String, String)> {
    let snapshot = snapshot_json(home);
    let call = snapshot["backlog"]["records"]
        .as_array()?
        .iter()
        .find(|row| row["captain_actionable"] == Value::Bool(true))?["id"]
        .as_str()?
        .to_string();
    let options = snapshot["decision_options"].as_array()?.iter().find(|row| row["task"] == call.as_str())?.clone();
    let page = snapshot["artifacts"]
        .as_array()?
        .iter()
        .find(|row| {
            row["latest"]["covers"]
                .as_array()
                .is_some_and(|covers| covers.iter().any(|task| task == call.as_str()))
        })?
        .clone();
    let list = options["options"].as_array()?;
    let pick = list.iter().find(|option| option["recommended"] == Value::Bool(true)).or_else(|| list.first())?;
    let key = pick["key"].as_str()?.to_string();
    let label = pick["label"].as_str()?.to_string();
    Some((call, page, key, label))
}

/// What the first mate is asked for when the home is carrying no call. It is a
/// captain's request in the captain's own words, so what comes back is whatever
/// the first mate would really do, not a shape the test dictated.
const ASK_FOR_A_CALL: &str = "Captain here. This is an automated host test in a scratch home, so keep it to this one thing: do not dispatch work, change any project, or contact anyone. I need one decision from you. Pick something small and real about the demo project that genuinely needs my call, put it to me the way you would any call - hold the task for me with its options recorded - and present a page that argues it so I can decide from the page itself.";

/// A live run of the one path the mock cannot prove: a call the first mate is
/// really holding, answered from the page that argues it, sent as one review,
/// and recorded by the first mate so the call stops waiting.
///
/// ```sh
/// cd src-tauri && FM_E2E_HOME=<scratch home> \
///   cargo test review_e2e_live_decision -- --ignored --nocapture
/// ```
///
/// The run needs the home to be carrying a call: a captain-held task with
/// recorded options and a presented page that `--covers` it. If the home has one
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
    let Some((call, page, key, label)) = offer else {
        not_exercised(&mut steps, "the review carries the answer and reaches the first mate", "no call to answer".into());
        not_exercised(&mut steps, "the first mate records the answer and the call clears", "no call to answer".into());
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
        review::stage_answer(&log, &call, Some(&key), Some(&label)).expect("stage the answer");
        review::add_comment(&log, rev, "Say in the page what this costs us if we change our minds later.", None, None)
            .expect("write the comment");
        let (text, threads, answers) = review::draft(&dir, rev, "approve").expect("compose the review");
        println!("--- the message ---\n{text}\n-------------------");
        let carries = text.contains(&format!("{call} = {key}")) && text.contains("fm-captain-hold.sh");
        let from = events.now();
        let id = send(&host, text.clone()).await;
        let message = id.clone().unwrap_or_default();
        let picked = events.find(from, REPLY_WAIT, outbox(&message, "picked_up")).await;
        if picked.is_some() {
            review::record_sent(&log, "approve", rev, &threads, &answers, &message).expect("record that it went");
        }
        record(
            &mut steps,
            "the review carries the answer and reaches the first mate",
            carries && picked.is_some(),
            format!("names the call, the option and the intake={carries}; send={id:?}; picked_up={}", picked.is_some()),
        );
        picked.is_some()
    } else {
        not_exercised(&mut steps, "the review carries the answer and reaches the first mate", "the host did not start".into());
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
            "the first mate records the answer and the call clears",
            cleared,
            format!("state={}; captain_actionable={}; hold={}", row["state"], row["captain_actionable"], row["hold_reason"]),
        );
    } else {
        not_exercised(&mut steps, "the first mate records the answer and the call clears", "the review never went".into());
    }

    let _ = ask(&host, |reply| Cmd::Stop { reply }).await;
    println!("\nrecording: {}", recording.display());
    let failed: Vec<&str> = steps.iter().filter(|step| matches!(step.outcome, Outcome::Failed)).map(|step| step.name).collect();
    assert!(failed.is_empty(), "failed: {failed:?}");
}
