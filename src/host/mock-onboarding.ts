/**
 * The welcome's states in the browser mock, one per `?welcome=<scenario>`:
 *
 * - `ready` (or bare `?welcome`): both agents installed and signed in, Claude Code runs the first mate.
 * - `codex-first`: the same, with Codex chosen to run the first mate.
 * - `checking`: the agents are being looked for, and the answer does not come.
 * - `nothing`: no agent at all; installing Claude Code runs its installer and then the adapter, and works.
 * - `install-fails`: Claude Code is here without its adapter, and npm cannot reach the registry.
 * - `no-node`, `no-node-brewless`, `old-node`: the adapter is missing and Node stands in the way, with and without Homebrew.
 * - `signed-out`: Claude Code is not signed in; signing in works once the captain says they have.
 * - `still-signed-out`: the same, but the sign-in never took.
 * - `codex-only`: only Codex is here, and the first mate is set to run on Claude Code.
 * - `unreadable`: firstmate could not check the agents.
 *
 * Without `?welcome` the home has met its first mate already, so no welcome shows.
 */
import type { AgentId, AgentStatus, InstallEvent, OnboardingStatus } from "./types";

/** A first mate's first words in a new home, as the engine's NEW CAPTAIN paragraph asks for them, streamed in pieces. */
export const FIRST_WORDS = [
  "Ahoy, captain. I'm your first mate. You give me work across your projects; I hand it to crewmates who each work in their own copy of the code, check what comes back, and bring you only the calls that are yours.\n\n",
  "This Mac can talk to me now. Before I can send a crewmate anywhere it needs a few more things: the GitHub CLI signed in to your account, tmux and treehouse where crewmates work, and jq with five small command-line helpers I use. ",
  "Homebrew isn't here yet and most of these come through it; it asks for your Mac's password, so that one is yours, from https://brew.sh. Once it's in, say the word and I'll install the rest.\n\n",
  "Meanwhile, what would you like to work on first? Give me a GitHub repository and I'll get to know it.",
];

const scenario = () => {
  const params = new URLSearchParams(window.location.search);
  return params.has("welcome") ? params.get("welcome") || "ready" : null;
};

function agent(id: AgentId, fields: Partial<AgentStatus> = {}, adapterPath: string | null = `/opt/homebrew/bin/${id === "codex" ? "codex-acp" : "claude-agent-acp"}`): AgentStatus {
  const codex = id === "codex";
  return {
    id,
    label: codex ? "Codex" : "Claude Code",
    installed: true,
    version: codex ? "0.144.6" : "2.1.283",
    signedIn: "signed-in",
    install: codex ? "npm install -g @openai/codex" : "curl -fsSL https://claude.ai/install.sh | bash",
    signIn: codex ? "codex login" : "claude auth login",
    adapter: {
      program: codex ? "codex-acp" : "claude-agent-acp",
      package: codex ? "@agentclientprotocol/codex-acp" : "@agentclientprotocol/claude-agent-acp",
      version: codex ? "1.13.1" : "0.69.0",
      nodeFloor: codex ? 16 : 22,
      path: adapterPath,
      command: `npm install --prefix <the app's folder> ${codex ? "@agentclientprotocol/codex-acp@1.13.1" : "@agentclientprotocol/claude-agent-acp@0.69.0"}`,
    },
    ...fields,
  };
}

const missing = (id: AgentId) => agent(id, { installed: false, version: null, signedIn: "unknown" }, null);

export class MockOnboarding {
  readonly scenario = scenario();
  private status: OnboardingStatus;
  private listeners = new Set<(event: InstallEvent) => void>();

  constructor(private later: (ms: number, run: () => void) => void) {
    const node = { version: "v23.10.0", major: 23 };
    const base: OnboardingStatus = { agents: [agent("claude"), agent("codex")], problem: null, node, brew: true, firstMate: "claude", greeted: this.scenario === null };
    switch (this.scenario) {
      case "codex-first": this.status = { ...base, firstMate: "codex" }; break;
      case "nothing": this.status = { ...base, agents: [missing("claude"), missing("codex")] }; break;
      case "install-fails": this.status = { ...base, agents: [agent("claude", {}, null), agent("codex")] }; break;
      case "no-node": this.status = { ...base, agents: [agent("claude", {}, null), missing("codex")], node: { version: null, major: null } }; break;
      case "no-node-brewless": this.status = { ...base, agents: [agent("claude", {}, null), missing("codex")], node: { version: null, major: null }, brew: false }; break;
      case "old-node": this.status = { ...base, agents: [agent("claude", {}, null), agent("codex")], node: { version: "v20.11.0", major: 20 } }; break;
      case "signed-out":
      case "still-signed-out": this.status = { ...base, agents: [agent("claude", { signedIn: "signed-out" }), agent("codex", { signedIn: "signed-out" })] }; break;
      case "codex-only": this.status = { ...base, agents: [missing("claude"), agent("codex")] }; break;
      case "unreadable": this.status = { ...base, agents: [], problem: "firstmate could not check this Mac's agents: bin/fm-agents.sh: Permission denied" }; break;
      default: this.status = base;
    }
  }

  /** The chosen agent, as the host would start it. */
  get firstMate() {
    return this.status.firstMate;
  }

  greet() {
    this.status = { ...this.status, greeted: true };
  }

  onboardingGreeted() {
    return Promise.resolve(this.status.greeted);
  }

  onboardingStatus(): Promise<OnboardingStatus> {
    if (this.scenario === "checking") return new Promise(() => {});
    return Promise.resolve(structuredClone(this.status));
  }

  onInstall(listener: (event: InstallEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: InstallEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  agentInstall(id: AgentId): Promise<void> {
    const target = this.status.agents.find((candidate) => candidate.id === id)!;
    const steps: { title: string; command: string; lines: string[]; fails?: string }[] = [];
    if (!target.installed) steps.push({ title: `Installing ${target.label}`, command: target.install ?? "", lines: id === "codex" ? ["added 1 package in 9s"] : ["Downloading Claude Code 2.1.283 for darwin-arm64...", "Installing Claude Code native build latest...", "✔ Claude Code successfully installed!"] });
    if (!target.adapter.path && id === this.status.firstMate) {
      steps.push(this.scenario === "install-fails"
        ? { title: "Installing the ACP adapter", command: target.adapter.command, lines: ["npm http fetch GET https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp", "npm error code ENOTFOUND", "npm error network request to https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org"], fails: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org" }
        : { title: "Installing the ACP adapter", command: target.adapter.command, lines: ["npm http fetch GET 200 https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp 312ms", "npm http fetch GET 200 https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64 2210ms", "added 212 packages in 18s"] });
    }
    return new Promise((resolve, reject) => {
      let at = 0;
      steps.forEach((step, index) => {
        const number = index + 1;
        const base = { harness: id, step: number, steps: steps.length };
        this.later((at += 200), () => this.emit({ ...base, state: "running", title: step.title, command: step.command }));
        for (const line of step.lines) this.later((at += 700), () => this.emit({ ...base, state: "line", line }));
        if (step.fails) {
          this.later((at += 300), () => {
            this.emit({ ...base, state: "failed", error: step.fails });
            reject(new Error(`${target.label} stopped at step ${number} of ${steps.length}: ${step.fails}`));
          });
          return;
        }
        this.later((at += 300), () => {
          this.emit({ ...base, state: "done" });
          if (index === 0 && !target.installed) this.update(id, { installed: true, version: id === "codex" ? "0.144.6" : "2.1.283", signedIn: "signed-out" });
          if (number === steps.length) {
            this.update(id, { adapter: { ...target.adapter, path: id === this.status.firstMate ? `/Users/you/Library/Application Support/dev.firstmate.desktop/tools/${target.adapter.program}/node_modules/.bin/${target.adapter.program}` : target.adapter.path } });
            resolve();
          }
        });
      });
      if (steps.length === 0) resolve();
    });
  }

  private update(id: AgentId, fields: Partial<AgentStatus>) {
    this.status = { ...this.status, agents: this.status.agents.map((candidate) => candidate.id === id ? { ...candidate, ...fields } : candidate) };
  }

  agentSignIn(id: AgentId): Promise<void> {
    // The captain finishes in Terminal; the next check reads it, unless the sign-in never takes.
    if (this.scenario !== "still-signed-out") this.later(100, () => this.update(id, { signedIn: "signed-in" }));
    return Promise.resolve();
  }

  firstMateSet(id: AgentId) {
    this.status = { ...this.status, firstMate: id };
    return Promise.resolve({ firstMate: id, restarted: false });
  }
}
