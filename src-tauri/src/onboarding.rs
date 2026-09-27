//! What a captain's Mac needs before their first mate can answer, and the ways
//! through it the app can offer: the agents on this Mac, installing one with
//! its ACP adapter, signing one in, and choosing which one runs the first mate.
//!
//! What an agent is, whether it is installed and signed in, and how it is
//! installed and signed in are the engine's, read through `bin/fm-agents.sh`;
//! the app keeps none of it. The ACP adapter is the app's own business, since
//! only the app needs one, so it is installed into the app's tools folder,
//! pinned (`crate::harness`), and never into the captain's global npm.
//!
//! Nothing here installs without the captain asking: the window shows every
//! command first, and a click on Install is consent to exactly those.
//!
//! Commands: `onboarding_greeted`, `onboarding_status`, `agent_install`, `agent_sign_in`, `first_mate_set`.

use crate::envpath;
use crate::harness::Harness;
use crate::host::{Cmd, HostHandle};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::io::{AsyncBufReadExt, BufReader};

/// One agent as `bin/fm-agents.sh status` reports it.
#[derive(Debug, PartialEq)]
pub(crate) struct AgentLine {
    pub harness: String,
    pub installed: bool,
    pub version: Option<String>,
    /// `signed-in`, `signed-out` or `unknown`.
    pub signed_in: String,
    pub install: Option<String>,
}

/// Reads the engine's tab-separated lines. A line of another shape is skipped rather
/// than guessed at; the agent it named then reads as unknown to this Mac.
pub(crate) fn parse_agents(text: &str) -> Vec<AgentLine> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            let [harness, installed, version, signed_in, install] = fields.as_slice() else { return None };
            let dash = |value: &str| Some(value.to_string()).filter(|value| value != "-" && !value.is_empty());
            Some(AgentLine {
                harness: harness.to_string(),
                installed: *installed == "installed",
                version: dash(version),
                signed_in: signed_in.to_string(),
                install: dash(install),
            })
        })
        .collect()
}

/// The major version in `node --version`'s answer, `v23.10.0`.
pub(crate) fn node_major(said: &str) -> Option<u32> {
    said.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

fn engine_script(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(crate::engine::bundled_engine(app)?.join("bin").join(name))
}

async fn run_engine(app: &AppHandle, script: &str, args: &[&str]) -> Result<String, String> {
    let path = engine_script(app, script)?;
    let output = tokio::process::Command::new(&path)
        .args(args)
        .env("PATH", envpath::wide_path())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("could not run {}: {e}", path.display()))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if said.is_empty() { format!("{script} failed with {}", output.status) } else { said });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The version of node on this Mac, as the adapters will see it.
async fn node_version() -> Option<String> {
    let node = envpath::resolve("node")?;
    let output = tokio::process::Command::new(node)
        .arg("--version")
        .env("PATH", envpath::wide_path())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A home this app has never seen a first mate answer in, and that nothing was ever
/// set up in: the files are the ones session start's NEW CAPTAIN check reads
/// (`engine/bin/fm-session-start.sh`), so a home a captain already ran firstmate in
/// is never treated as new, marker or not.
fn never_set_up(home: &Path) -> bool {
    let data = home.join("data");
    let files = ["projects.md", "captain.md", "secondmates.md", "backlog.md"];
    !files.iter().any(|file| data.join(file).exists())
        && std::fs::read_dir(home.join("projects")).map_or(true, |mut entries| entries.next().is_none())
}

fn greeted(app: &AppHandle, home: &Path) -> bool {
    let marker = app
        .path()
        .app_data_dir()
        .map(|dir| crate::host::host_dir_in(&dir, home).join(crate::host::GREETED_FILE).exists())
        .unwrap_or(false);
    marker || !never_set_up(home)
}

/// Whether this home has met its first mate, answered at once so a launch never waits on
/// the agents being probed: only a home that has not is shown the welcome, and read in full.
#[tauri::command]
pub async fn onboarding_greeted(app: AppHandle) -> Result<bool, String> {
    let home = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || crate::settings::saved_home(&app)
    })
    .await
    .map_err(|e| format!("the first mate's home could not be read: {e}"))?;
    Ok(home.as_deref().map_or(true, |home| greeted(&app, home)))
}

/// Where the agents stand on this Mac, and what the app would do for each.
#[tauri::command]
pub async fn onboarding_status(app: AppHandle) -> Result<Value, String> {
    let home = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || crate::settings::saved_home(&app)
    })
    .await
    .map_err(|e| format!("the first mate's home could not be read: {e}"))?;
    let ids: Vec<&str> = Harness::ALL.iter().map(|harness| harness.id()).collect();
    let mut args = vec!["status"];
    args.extend(ids.iter());
    let (lines, problem) = match run_engine(&app, "fm-agents.sh", &args).await {
        Ok(text) => (parse_agents(&text), None),
        Err(problem) => (Vec::new(), Some(format!("firstmate could not check this Mac's agents: {problem}"))),
    };
    let node = node_version().await;
    let major = node.as_deref().and_then(node_major);
    let mut agents = Vec::new();
    for harness in Harness::ALL {
        let adapter = harness.adapter();
        let line = lines.iter().find(|line| line.harness == harness.id());
        let sign_in = run_engine(&app, "fm-agents.sh", &["sign-in", harness.id()]).await.ok().map(|said| said.trim().to_string());
        let adapter_path = envpath::resolve(adapter.program);
        agents.push(json!({
            "id": harness.id(),
            "label": harness.label(),
            "installed": line.is_some_and(|line| line.installed),
            "version": line.and_then(|line| line.version.clone()),
            "signed_in": line.map_or("unknown", |line| line.signed_in.as_str()),
            "install": line.and_then(|line| line.install.clone()),
            "sign_in": sign_in,
            "adapter": {
                "program": adapter.program,
                "package": adapter.package,
                "version": adapter.version,
                "node_floor": adapter.node_floor,
                "path": adapter_path.map(|path| path.to_string_lossy().to_string()),
                "command": format!("npm install --prefix <the app's folder> {}@{}", adapter.package, adapter.version),
            },
        }));
    }
    let first_mate = home.as_deref().map_or(Harness::Claude, |home| crate::settings::first_mate_of(&app, home));
    Ok(json!({
        "agents": agents,
        "problem": problem,
        "node": {"version": node, "major": major},
        "brew": envpath::resolve("brew").is_some(),
        "first_mate": first_mate.id(),
        "greeted": home.as_deref().is_some_and(|home| greeted(&app, home)),
    }))
}

/// Installs in progress, by agent, so a second click does not start a second install.
static INSTALLING: Mutex<Option<HashSet<&'static str>>> = Mutex::new(None);

fn claim_install(harness: Harness) -> bool {
    let mut installing = INSTALLING.lock().unwrap_or_else(|held| held.into_inner());
    installing.get_or_insert_with(HashSet::new).insert(harness.id())
}

fn release_install(harness: Harness) {
    let mut installing = INSTALLING.lock().unwrap_or_else(|held| held.into_inner());
    if let Some(set) = installing.as_mut() {
        set.remove(harness.id());
    }
}

/// Where an install's events go: the window, or a test.
pub(crate) type Emit = std::sync::Arc<dyn Fn(Value) + Send + Sync>;

/// One step of an install: what it runs, as the captain was shown it.
struct Step {
    title: String,
    shown: String,
    run: StepRun,
}

enum StepRun {
    /// A line from the engine, run by bash as a person would paste it.
    Shell(String),
    /// The adapter, into the app's tools folder.
    Adapter(Harness),
}

/// Installs an agent and, when it is the one chosen to run the first mate, the ACP adapter
/// the app reaches it through, streaming each step's output as `agent_install` events. Only the steps still needed run, in order, and a
/// step that fails stops the rest; what already finished stays.
#[tauri::command]
pub async fn agent_install(app: AppHandle, harness: String) -> Result<Value, String> {
    let harness = Harness::parse(&harness).ok_or_else(|| format!("the app cannot install {harness}"))?;
    let status = onboarding_status(app.clone()).await?;
    let agent = status["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["id"] == harness.id()))
        .cloned()
        .ok_or("this Mac's agents could not be read")?;
    let mut steps = Vec::new();
    if agent["installed"] != true {
        let line = agent["install"].as_str().ok_or_else(|| format!("firstmate knows no way to install {}", harness.label()))?;
        steps.push(Step { title: format!("Installing {}", harness.label()), shown: line.to_string(), run: StepRun::Shell(line.to_string()) });
    }
    // The adapter is only needed to run the first mate, and weighs hundreds of megabytes,
    // so it comes with the agent the captain chose for that and no other.
    if agent["adapter"]["path"].is_null() && status["first_mate"] == harness.id() {
        steps.push(Step {
            title: "Installing the ACP adapter".to_string(),
            shown: agent["adapter"]["command"].as_str().unwrap_or_default().to_string(),
            run: StepRun::Adapter(harness),
        });
    }
    let needs_node = steps.iter().any(|step| match &step.run {
        StepRun::Shell(line) => line.trim_start().starts_with("npm "),
        StepRun::Adapter(_) => true,
    });
    if needs_node {
        let floor = harness.adapter().node_floor;
        match status["node"]["major"].as_u64() {
            Some(major) if major >= u64::from(floor) => {}
            Some(_) => return Err(format!("this needs Node.js {floor} or newer, and this Mac has {}", status["node"]["version"].as_str().unwrap_or("an older one"))),
            None => return Err(format!("this needs Node.js {floor} or newer, and this Mac has none")),
        }
    }
    if steps.is_empty() {
        return Ok(json!({"harness": harness.id(), "installed": true, "steps": 0}));
    }
    if !claim_install(harness) {
        return Err(format!("{} is already being installed", harness.label()));
    }
    let total = steps.len();
    let sink: Emit = {
        let app = app.clone();
        std::sync::Arc::new(move |event| {
            let _ = app.emit("agent_install", event);
        })
    };
    let mut outcome = Ok(json!({"harness": harness.id(), "installed": true, "steps": total}));
    for (index, step) in steps.iter().enumerate() {
        let number = index + 1;
        let emit = |state: &str, extra: Value| {
            let mut body = json!({"harness": harness.id(), "step": number, "steps": total, "title": step.title, "command": step.shown, "state": state});
            if let (Value::Object(body), Value::Object(extra)) = (&mut body, extra) {
                body.extend(extra);
            }
            sink(body);
        };
        emit("running", json!({}));
        let result = match &step.run {
            StepRun::Shell(line) => run_streamed(&sink, harness, number, total, "/bin/bash", &["-c", line], None).await,
            StepRun::Adapter(harness) => {
                let adapter = harness.adapter();
                match envpath::tools_dir() {
                    Some(tools) => install_adapter_into(tools, adapter.program, &format!("{}@{}", adapter.package, adapter.version), &sink, *harness, number, total).await,
                    None => Err("the app has no tools folder".to_string()),
                }
            }
        };
        match result {
            Ok(()) => emit("done", json!({})),
            Err(error) => {
                emit("failed", json!({"error": error}));
                outcome = Err(format!("{} stopped at step {number} of {total}: {error}", harness.label()));
                break;
            }
        }
    }
    release_install(harness);
    outcome
}

/// Runs a command with the wide path, sending each line it prints as an event, and keeps
/// the last lines to say why when it fails.
#[allow(clippy::too_many_arguments)]
async fn run_streamed(emit: &Emit, harness: Harness, step: usize, steps: usize, program: &str, args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env("PATH", envpath::wide_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|e| format!("could not run {program}: {e}"))?;
    let stdout = child.stdout.take().ok_or("no output to read")?;
    let stderr = child.stderr.take().ok_or("no errors to read")?;
    let tail = std::sync::Arc::new(Mutex::new(std::collections::VecDeque::<String>::new()));
    let pump = |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>| {
        let emit = emit.clone();
        let tail = tail.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                {
                    let mut tail = tail.lock().unwrap_or_else(|held| held.into_inner());
                    tail.push_back(line.clone());
                    while tail.len() > 40 {
                        tail.pop_front();
                    }
                }
                emit(json!({"harness": harness.id(), "step": step, "steps": steps, "state": "line", "line": line}));
            }
        })
    };
    let out = pump(Box::new(stdout));
    let err = pump(Box::new(stderr));
    let status = child.wait().await.map_err(|e| format!("{program} did not finish: {e}"))?;
    let _ = out.await;
    let _ = err.await;
    if status.success() {
        return Ok(());
    }
    let tail = tail.lock().unwrap_or_else(|held| held.into_inner());
    let said: Vec<&String> = tail.iter().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect();
    Err(if said.is_empty() { format!("it exited with {status}") } else { said.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n") })
}

/// The adapter goes into a scratch prefix that becomes the real one only once npm has
/// finished, so a failure leaves nothing half-installed where the app looks.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn install_adapter_into(tools: &Path, program: &str, spec: &str, emit: &Emit, harness: Harness, step: usize, steps: usize) -> Result<(), String> {
    let target = tools.join(program);
    let partial = tools.join(format!("{program}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial).map_err(|e| format!("could not create {}: {e}", partial.display()))?;
    let npm = envpath::resolve("npm").ok_or("npm is not on this Mac")?;
    let prefix = partial.to_string_lossy().to_string();
    let result = run_streamed(
        emit,
        harness,
        step,
        steps,
        &npm.to_string_lossy(),
        &["install", "--prefix", &prefix, spec, "--no-audit", "--no-fund", "--loglevel=http"],
        Some(&partial),
    )
    .await;
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(error);
    }
    if !partial.join("node_modules").join(".bin").join(program).exists() {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(format!("npm finished, but {program} was not among what it installed"));
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&partial, &target).map_err(|e| format!("could not move the adapter into place: {e}"))
}

/// Opens the agent's own sign-in in Terminal. The app writes a command file and hands it to
/// Terminal, so it sees no password or token, and needs no permission to control Terminal.
#[tauri::command]
pub async fn agent_sign_in(app: AppHandle, harness: String) -> Result<(), String> {
    let harness = Harness::parse(&harness).ok_or_else(|| format!("the app cannot sign {harness} in"))?;
    let line = run_engine(&app, "fm-agents.sh", &["sign-in", harness.id()]).await?;
    let line = line.trim();
    let dir = crate::settings::settings_dir(&app)?.join("sign-in");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let file = dir.join(format!("{}.command", harness.id()));
    std::fs::write(&file, sign_in_script(harness, line, &envpath::wide_path())).map_err(|e| format!("could not write {}: {e}", file.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let status = tokio::process::Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(&file)
        .status()
        .await
        .map_err(|e| format!("could not open Terminal: {e}"))?;
    if !status.success() {
        return Err(format!("Terminal did not open ({status})"));
    }
    Ok(())
}

/// Single quotes around anything, for a POSIX shell.
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

pub(crate) fn sign_in_script(harness: Harness, line: &str, path: &str) -> String {
    format!(
        "#!/bin/bash\nexport PATH={path}\nclear\nprintf '%s\\n\\n' {intro}\n{line}\nprintf '\\n%s\\n' {outro}\n",
        path = shell_quote(path),
        intro = shell_quote(&format!("Signing {} in for firstmate.", harness.label())),
        outro = shell_quote("When it says you are signed in, close this window and go back to firstmate."),
    )
}

/// Chooses the agent the first mate runs on in the current home. A session belongs to one
/// agent, so a first mate running now is started again on the new one: its conversation on
/// the old one is kept, to come back to if the captain switches back.
#[tauri::command]
pub async fn first_mate_set(app: AppHandle, host: TauriState<'_, HostHandle>, harness: String) -> Result<Value, String> {
    let harness = Harness::parse(&harness).ok_or_else(|| format!("the first mate cannot run on {harness} in this app"))?;
    let home = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || crate::settings::saved_home(&app)
    })
    .await
    .map_err(|e| e.to_string())?
    .ok_or("there is no home to choose for")?;
    crate::settings::remember_first_mate(&crate::settings::settings_dir(&app)?, &home, harness)?;
    let state = host.call(|reply| Cmd::GetState { reply }).await?;
    let running = state.get("state").and_then(Value::as_str).is_some_and(|name| crate::settings::RUNNING.contains(&name));
    let here = state.get("home").and_then(Value::as_str).is_some_and(|started| Path::new(started) == home);
    let on = state.get("harness").and_then(Value::as_str);
    if running && here && on != Some(harness.id()) {
        host.call(|reply| Cmd::Start { home: home.clone(), harness, reply }).await??;
    }
    Ok(json!({"first_mate": harness.id(), "restarted": running && here && on != Some(harness.id())}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engines_lines_read_as_agents() {
        let text = "claude\tinstalled\t2.1.283\tsigned-in\tcurl -fsSL https://claude.ai/install.sh | bash\ncodex\tmissing\t-\tunknown\tnpm install -g @openai/codex\nnot a line\n";
        let agents = parse_agents(text);
        assert_eq!(agents.len(), 2, "a line of another shape is skipped");
        assert_eq!(
            agents[0],
            AgentLine {
                harness: "claude".into(),
                installed: true,
                version: Some("2.1.283".into()),
                signed_in: "signed-in".into(),
                install: Some("curl -fsSL https://claude.ai/install.sh | bash".into()),
            }
        );
        assert!(!agents[1].installed);
        assert_eq!(agents[1].version, None, "a dash is no version");
        assert_eq!(agents[1].signed_in, "unknown");
    }

    #[test]
    fn node_says_its_version_with_a_v() {
        assert_eq!(node_major("v23.10.0\n"), Some(23));
        assert_eq!(node_major("v16.20.2"), Some(16));
        assert_eq!(node_major("not node"), None);
    }

    #[test]
    fn a_home_with_anything_set_up_is_not_new() {
        let home = std::env::temp_dir().join(format!("qd-onboarding-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("data")).unwrap();
        std::fs::create_dir_all(home.join("projects")).unwrap();
        assert!(never_set_up(&home));
        std::fs::write(home.join("data").join("backlog.md"), "").unwrap();
        assert!(!never_set_up(&home), "a backlog, even empty, is a home in use");
        std::fs::remove_file(home.join("data").join("backlog.md")).unwrap();
        std::fs::create_dir_all(home.join("projects").join("demo")).unwrap();
        assert!(!never_set_up(&home), "a cloned project is a home in use");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_sign_in_file_runs_the_engines_line_and_quotes_what_it_carries() {
        let script = sign_in_script(Harness::Codex, "codex login", "/opt/homebrew/bin:/Users/o'neil/.local/bin");
        assert!(script.starts_with("#!/bin/bash\n"));
        assert!(script.contains("\ncodex login\n"), "{script}");
        assert!(script.contains(r"export PATH='/opt/homebrew/bin:/Users/o'\''neil/.local/bin'"), "{script}");
        assert!(script.contains("Signing Codex in for firstmate."), "{script}");
    }

    fn engine() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("engine")
    }

    /// Reads this Mac's agents through firstmate's own script, as the welcome does, and
    /// checks what it says against the agents themselves. Spends nothing, changes nothing.
    ///
    /// ```sh
    /// cd src-tauri && cargo test onboarding_live_reads_this_mac -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "live: reads this Mac's agents"]
    async fn onboarding_live_reads_this_mac() {
        let output = tokio::process::Command::new(engine().join("bin").join("fm-agents.sh"))
            .args(["status", "claude", "codex"])
            .env("PATH", envpath::wide_path())
            .output()
            .await
            .expect("fm-agents.sh runs");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let agents = parse_agents(&String::from_utf8_lossy(&output.stdout));
        println!("{agents:#?}");
        assert_eq!(agents.iter().map(|agent| agent.harness.as_str()).collect::<Vec<_>>(), ["claude", "codex"]);
        for agent in &agents {
            let on_this_mac = envpath::resolve(&agent.harness).is_some();
            assert_eq!(agent.installed, on_this_mac, "{} reads as installed exactly when the app can find it", agent.harness);
            if agent.installed {
                assert!(agent.version.is_some(), "{} says which version it is", agent.harness);
                assert!(agent.signed_in == "signed-in" || agent.signed_in == "signed-out", "{} gives a definite sign-in: {}", agent.harness, agent.signed_in);
            }
            assert!(agent.install.is_some(), "{} carries its install line", agent.harness);
        }
    }

    /// Installs the pinned Codex adapter from npm into a scratch tools folder, as the welcome
    /// does, then fails one on purpose: a failure leaves nothing where the app looks. Needs the
    /// network and about 300 MB of disk; spends no model tokens.
    ///
    /// ```sh
    /// cd src-tauri && cargo test onboarding_live_installs_an_adapter -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "live: installs an ACP adapter from npm"]
    async fn onboarding_live_installs_an_adapter() {
        let tools = std::env::temp_dir().join(format!("qd-onboarding-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tools);
        std::fs::create_dir_all(&tools).unwrap();
        let events = std::sync::Arc::new(Mutex::new(Vec::<Value>::new()));
        let emit: Emit = {
            let events = events.clone();
            std::sync::Arc::new(move |event| events.lock().unwrap().push(event))
        };
        let adapter = Harness::Codex.adapter();
        let spec = format!("{}@{}", adapter.package, adapter.version);
        install_adapter_into(&tools, adapter.program, &spec, &emit, Harness::Codex, 1, 1).await.expect("the pinned adapter installs");
        let bin = tools.join(adapter.program).join("node_modules").join(".bin").join(adapter.program);
        assert!(bin.exists(), "{} is where the app looks", bin.display());
        assert!(!tools.join(format!("{}.partial", adapter.program)).exists(), "nothing half-installed is left");
        let said = tokio::process::Command::new(&bin).arg("--version").env("PATH", envpath::wide_path()).output().await.expect("the adapter runs");
        let version = String::from_utf8_lossy(&said.stdout).to_string();
        assert!(version.contains(adapter.version), "the pinned version is the one installed: {version}");
        assert!(events.lock().unwrap().iter().any(|event| event["state"] == "line"), "npm's lines were streamed");

        let failed = install_adapter_into(&tools, "no-such-adapter", "@agentclientprotocol/codex-acp@0.0.0-does-not-exist", &emit, Harness::Codex, 1, 1).await;
        let error = failed.expect_err("a version npm does not have fails");
        println!("npm said: {error}");
        assert!(!error.is_empty());
        assert!(!tools.join("no-such-adapter").exists() && !tools.join("no-such-adapter.partial").exists(), "a failed install leaves nothing where the app looks");
        assert!(bin.exists(), "and the adapter already there is untouched");
        let _ = std::fs::remove_dir_all(&tools);
    }
}
