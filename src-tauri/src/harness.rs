//! The agents the app can run the first mate on, and what the app needs of each.
//!
//! Crew work may go to any agent firstmate verifies; that list is the engine's,
//! read through `bin/fm-agents.sh`. This one is narrower and the app's own: the
//! agents the host can hold a first mate's session with over ACP, each through
//! an adapter the app installs for itself, pinned to the version it was tested
//! with. The first mate's agent is chosen per home and applies from its next
//! start: a session belongs to one agent, so switching is a relaunch.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Harness {
    Claude,
    Codex,
}

/// The ACP adapter an agent is reached through, as the app installs it.
pub(crate) struct AcpAdapter {
    /// The executable the package installs, looked up like any other tool.
    pub program: &'static str,
    pub package: &'static str,
    /// The version the app runs its checks against.
    pub version: &'static str,
    /// The oldest Node.js the pinned package runs on: its own `engines.node`, or, for
    /// a package that names none, that of the agent it carries.
    pub node_floor: u32,
}

impl Harness {
    pub(crate) const ALL: [Harness; 2] = [Harness::Claude, Harness::Codex];

    /// firstmate's own name for the agent, as `bin/fm-agents.sh` and every other script use it.
    pub(crate) fn id(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
        }
    }

    pub(crate) fn parse(id: &str) -> Option<Harness> {
        Harness::ALL.into_iter().find(|harness| harness.id() == id)
    }

    /// What the captain calls it.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Harness::Claude => "Claude Code",
            Harness::Codex => "Codex",
        }
    }

    pub(crate) fn adapter(self) -> AcpAdapter {
        match self {
            Harness::Claude => AcpAdapter {
                program: "claude-agent-acp",
                package: "@agentclientprotocol/claude-agent-acp",
                version: "0.69.0",
                node_floor: 22,
            },
            Harness::Codex => AcpAdapter {
                program: "codex-acp",
                package: "@agentclientprotocol/codex-acp",
                version: "1.13.1",
                node_floor: 16,
            },
        }
    }

    /// The executable the host starts: the adapter, or what `ACP_ADAPTER` names, so a
    /// test can stand a fake in for whichever agent it starts.
    pub(crate) fn adapter_program(self) -> String {
        std::env::var("ACP_ADAPTER").unwrap_or_else(|_| self.adapter().program.to_string())
    }

    /// The session mode the first mate runs in on this agent, and the posture it
    /// stands for, or the reason the home's setting cannot be applied.
    ///
    /// Claude follows the home's `config/claude-permission-mode`, as its crewmates do.
    /// Codex runs as firstmate launches every Codex crewmate, with no approvals and no
    /// sandbox (`--dangerously-bypass-approvals-and-sandbox` in `bin/fm-spawn.sh`), which
    /// is codex-acp's `agent-full-access`.
    pub(crate) fn posture(self, home: &std::path::Path) -> Result<(&'static str, &'static str), String> {
        match self {
            Harness::Claude => crate::host::claude_permission_mode(home),
            Harness::Codex => Ok(("bypass", "agent-full-access")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_agent_round_trips_through_its_firstmate_name() {
        for harness in Harness::ALL {
            assert_eq!(Harness::parse(harness.id()), Some(harness));
        }
        assert_eq!(Harness::parse("gemini"), None);
        assert_eq!(Harness::parse(""), None);
    }

    #[test]
    fn codex_runs_as_its_crewmates_do_whatever_the_claude_setting_says() {
        let home = std::env::temp_dir().join(format!("qd-harness-posture-{}", std::process::id()));
        std::fs::create_dir_all(home.join("config")).unwrap();
        std::fs::write(home.join("config").join("claude-permission-mode"), "auto\n").unwrap();
        assert_eq!(Harness::Claude.posture(&home), Ok(("auto", "auto")));
        assert_eq!(Harness::Codex.posture(&home), Ok(("bypass", "agent-full-access")));
        std::fs::write(home.join("config").join("claude-permission-mode"), "sometimes\n").unwrap();
        assert!(Harness::Claude.posture(&home).is_err());
        assert_eq!(Harness::Codex.posture(&home), Ok(("bypass", "agent-full-access")), "the Claude setting is Claude's");
        let _ = std::fs::remove_dir_all(&home);
    }
}
