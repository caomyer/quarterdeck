/**
 * How the welcome reads the agents on this Mac: what each row says, what installing one would run, whether Node stands
 * in the way, and whether the first mate can start. Everything comes from `OnboardingStatus`, which firstmate and the app
 * report; nothing here keeps a list of its own. Checked by `pnpm test`.
 */
import type { AgentId, AgentStatus, InstallEvent, OnboardingStatus } from "./host/types";

export type Pill = { tone: "ok" | "bad" | "wait"; text: string };

/** What a row says about an agent, left to right. The adapter matters only for the agent that runs the first mate. */
export function agentPills(agent: AgentStatus, firstMate: AgentId): Pill[] {
  if (!agent.installed) return [{ tone: "bad", text: "Not installed" }];
  const pills: Pill[] = [{ tone: "ok", text: "✓ Installed" }];
  if (agent.signedIn === "signed-in") pills.push({ tone: "ok", text: "✓ Signed in" });
  if (agent.signedIn === "signed-out") pills.push({ tone: "bad", text: "Not signed in" });
  if (agent.id === firstMate) pills.push(agent.adapter.path ? { tone: "ok", text: "✓ ACP adapter" } : { tone: "bad", text: "No ACP adapter" });
  return pills;
}

/** The two roles an agent can have, which are different things: every installed agent can take crew work, and one runs the first mate. */
export function agentRole(agent: AgentStatus, firstMate: AgentId) {
  if (!agent.installed) return null;
  return agent.id === firstMate ? "Runs your first mate · Takes crew work" : "Takes crew work";
}

/** What clicking Install runs, in order, exactly as the backend runs it: the agent when missing, and the adapter for the first mate's agent. */
export function installSteps(agent: AgentStatus, firstMate: AgentId): { title: string; command: string }[] {
  const steps: { title: string; command: string }[] = [];
  if (!agent.installed && agent.install) steps.push({ title: `Install ${agent.label}`, command: agent.install });
  if (!agent.adapter.path && agent.id === firstMate) steps.push({ title: "Install the ACP adapter", command: agent.adapter.command });
  return steps;
}

/** An agent that is missing and that firstmate knows no way to install: all the captain can be told is that. */
export function cannotInstall(agent: AgentStatus) {
  return !agent.installed && !agent.install;
}

/**
 * Node, when installing this agent needs a newer one than the Mac has: the adapter is an npm package, and so is Codex.
 * `null` when Node is not in the way.
 */
export function nodeShortfall(agent: AgentStatus, firstMate: AgentId, node: OnboardingStatus["node"]) {
  const needsNode = installSteps(agent, firstMate).some((step) => step.command.trimStart().startsWith("npm "));
  if (!needsNode) return null;
  const floor = agent.adapter.nodeFloor;
  if (node.major !== null && node.major >= floor) return null;
  return { floor, have: node.version };
}

/**
 * Why the first mate cannot start yet, in the captain's words, or `null` when it can. An agent whose sign-in could not be
 * read is let through: starting it is the check, and it says plainly when it is signed out.
 */
export function startBlocker(status: OnboardingStatus): string | null {
  const agent = status.agents.find((candidate) => candidate.id === status.firstMate);
  if (!agent) return status.problem ? "This Mac's agents could not be checked." : "The agent chosen for the first mate is not one this app knows.";
  if (!agent.installed) return `Needs ${agent.label} to start.`;
  if (!agent.adapter.path) return `Needs the ${agent.label} ACP adapter to start.`;
  if (agent.signedIn === "signed-out") return `Your first mate runs on ${agent.label}, so it waits for ${agent.label}'s sign-in.`;
  return null;
}

/** Agents the captain could move the first mate to now: installed, and not the one it runs on. */
export function otherFirstMates(status: OnboardingStatus) {
  return status.agents.filter((agent) => agent.installed && agent.id !== status.firstMate);
}

/**
 * What the choice of agent means for how the first mate hears the captain. Codex supervises from inside one long turn and
 * reads new messages between its watcher checks, so a reply can take a few minutes while work is under way.
 */
export function firstMateNote(agent: AgentId) {
  return agent === "codex"
    ? "A Codex first mate reads new messages between its checks, so while work is under way a reply can take up to three minutes."
    : null;
}

/** The welcome shows on the app's own home until a first mate has answered there; a folder the captain chose is theirs already. */
export function showWelcome(input: { home: string | null; chosen: boolean; greeted: boolean | null; meeting: boolean }) {
  return input.home !== null && !input.chosen && input.greeted === false && !input.meeting;
}

export type InstallView = {
  step: number;
  steps: number;
  title: string;
  command: string;
  /** The newest line the step printed, so a slow download is visibly alive. */
  line: string | null;
  lines: string[];
  state: "running" | "failed" | "done";
  error?: string;
};

/** Folds an install's events into what its row shows. Lines past the last hundred are dropped; the error keeps npm's last words. */
export function foldInstall(current: InstallView | null, event: InstallEvent): InstallView {
  const base: InstallView = current && current.step <= event.step
    ? current
    : { step: event.step, steps: event.steps, title: event.title ?? "", command: event.command ?? "", line: null, lines: [], state: "running" };
  if (event.state === "line" && event.line) {
    const lines = [...base.lines, event.line].slice(-100);
    return { ...base, line: event.line, lines };
  }
  if (event.state === "running") {
    return { ...base, step: event.step, steps: event.steps, title: event.title ?? base.title, command: event.command ?? base.command, line: base.step === event.step ? base.line : null, state: "running", error: undefined };
  }
  if (event.state === "failed") return { ...base, state: "failed", error: event.error };
  return { ...base, state: event.step === event.steps ? "done" : "running" };
}
