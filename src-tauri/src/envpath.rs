//! Process environment for everything the app launches.
//!
//! A macOS app started from Finder inherits a minimal PATH, while firstmate's
//! scripts need `jq`, `tasks-axi`, `tmux`, `gh`, and the ACP adapter. The login
//! shell's PATH is read once and put in front of the inherited one for every
//! child the app starts.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

static SEARCH_PATH: OnceLock<String> = OnceLock::new();

/// The PATH given to every child process: the login shell's entries first,
/// then the inherited ones, without duplicates.
pub fn search_path() -> &'static str {
    SEARCH_PATH.get_or_init(|| {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let login = std::process::Command::new(&shell)
            .args(["-l", "-c", "printf '%s' \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| {
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                // A login profile may print before the value; the PATH is the last line.
                text.lines().last().unwrap_or("").trim().to_string()
            })
            .unwrap_or_default();
        let mut seen: Vec<&str> = Vec::new();
        for entry in login.split(':').chain(inherited.split(':')) {
            if !entry.is_empty() && !seen.contains(&entry) {
                seen.push(entry);
            }
        }
        seen.join(":")
    })
}

/// Resolve a program name against the search path. A name containing `/` is
/// returned as given.
pub fn resolve(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        return Some(PathBuf::from(program));
    }
    search_path()
        .split(':')
        .map(|dir| Path::new(dir).join(program))
        .find(|candidate| candidate.is_file())
}

/// A command whose child sees the search path.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.env("PATH", search_path());
    command
}
