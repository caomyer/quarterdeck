//! Process environment for everything the app launches.
//!
//! A macOS app started from Finder inherits a minimal PATH, while firstmate's
//! scripts need `jq`, `tasks-axi`, `tmux`, `gh`, and the ACP adapter. The login
//! shell's PATH is read once and put in front of the inherited one for every
//! child the app starts.
//!
//! PATH alone is not enough to find the adapter: `claude-agent-acp` is installed
//! inside Buzz's own tools folder, which no login shell here has on PATH, so a
//! lookup that misses falls back to the places these tools are actually installed.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

static SEARCH_PATH: OnceLock<String> = OnceLock::new();

/// The app's own tools folder, where it installs an agent's ACP adapter: one folder per
/// adapter, each an npm prefix. Set once at launch.
static TOOLS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_tools_dir(dir: PathBuf) {
    let _ = TOOLS_DIR.set(dir);
}

pub fn tools_dir() -> Option<&'static Path> {
    TOOLS_DIR.get().map(PathBuf::as_path)
}

/// The executables the app installed for itself, one `node_modules/.bin` per adapter.
fn tool_bins() -> Vec<PathBuf> {
    let Some(tools) = tools_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(tools) else { return Vec::new() };
    let mut bins: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path().join("node_modules").join(".bin"))
        .filter(|bin| bin.is_dir())
        .collect();
    bins.sort();
    bins
}

/// The search path with the places these tools are installed after it, for a child that
/// must find an agent a captain installed where their login shell does not look.
pub fn wide_path() -> String {
    let mut path = search_path().to_string();
    for dir in known_dirs() {
        let dir = dir.to_string_lossy().to_string();
        if !path.split(':').any(|entry| entry == dir) {
            path.push(':');
            path.push_str(&dir);
        }
    }
    path
}

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

/// Where these tools live when PATH does not name them. Buzz installs the ACP
/// adapter in its own tools folder, which is on no login shell's PATH.
fn known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join("Library/Application Support/Buzz/node-tools/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".bun/bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    // Last: a copy the captain installed themselves wins over the app's own.
    dirs.extend(tool_bins());
    dirs
}

/// The first of `dirs` holding `program`.
fn resolve_in(program: &str, dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    dirs.into_iter().map(|dir| dir.join(program)).find(|candidate| candidate.is_file())
}

/// Resolve a program name against the search path, then against the places these
/// tools are installed. A name containing `/` is returned as given.
pub fn resolve(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        return Some(PathBuf::from(program));
    }
    let on_path = search_path().split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from);
    resolve_in(program, on_path).or_else(|| resolve_in(program, known_dirs()))
}

/// A command whose child sees the search path.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.env("PATH", search_path());
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_program_is_found_where_it_is_installed_even_when_path_misses_it() {
        let dir = std::env::temp_dir().join(format!("fm-desktop-envpath-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tool = dir.join("pretend-adapter");
        std::fs::write(&tool, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(resolve_in("pretend-adapter", [dir.clone()]), Some(tool));
        assert_eq!(resolve_in("pretend-adapter", [dir.join("elsewhere")]), None);
        assert_eq!(resolve_in("no-such-tool", [dir.clone()]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The adapter lives here on this Mac, and no login shell has it on PATH.
    #[test]
    fn the_known_places_include_buzzs_tools_folder() {
        let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
        assert!(
            known_dirs().contains(&home.join("Library/Application Support/Buzz/node-tools/bin")),
            "{:?}",
            known_dirs()
        );
    }
}
