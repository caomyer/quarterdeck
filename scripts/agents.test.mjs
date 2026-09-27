// Unit tests for src/agents.ts, where the welcome reads the agents on this Mac.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPills, agentRole, cannotInstall, firstMateNote, foldInstall, installSteps, nodeShortfall, otherFirstMates, showWelcome, startBlocker } from "../src/agents.ts";

function agent(id, fields = {}) {
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
      path: `/opt/homebrew/bin/${codex ? "codex-acp" : "claude-agent-acp"}`,
      command: `npm install --prefix <the app's folder> ${codex ? "@agentclientprotocol/codex-acp@1.13.1" : "@agentclientprotocol/claude-agent-acp@0.69.0"}`,
    },
    ...fields,
  };
}

const status = (agents, fields = {}) => ({ agents, problem: null, node: { version: "v23.10.0", major: 23 }, brew: true, firstMate: "claude", greeted: false, ...fields });
const noAdapter = (a) => ({ ...a, adapter: { ...a.adapter, path: null } });

test("a row says installed, signed in, and the adapter only for the first mate's agent", () => {
  assert.deepEqual(agentPills(agent("claude"), "claude").map((p) => p.text), ["✓ Installed", "✓ Signed in", "✓ ACP adapter"]);
  assert.deepEqual(agentPills(agent("codex"), "claude").map((p) => p.text), ["✓ Installed", "✓ Signed in"]);
  assert.deepEqual(agentPills(noAdapter(agent("codex", { signedIn: "signed-out" })), "codex").map((p) => [p.tone, p.text]), [["ok", "✓ Installed"], ["bad", "Not signed in"], ["bad", "No ACP adapter"]]);
  assert.deepEqual(agentPills(agent("claude", { signedIn: "unknown" }), "codex").map((p) => p.text), ["✓ Installed"], "a sign-in nobody could read is not claimed either way");
  assert.deepEqual(agentPills(agent("claude", { installed: false }), "claude").map((p) => p.text), ["Not installed"]);
});

test("the two roles are drawn apart: crew work for every installed agent, the first mate for one", () => {
  assert.equal(agentRole(agent("claude"), "claude"), "Runs your first mate · Takes crew work");
  assert.equal(agentRole(agent("codex"), "claude"), "Takes crew work");
  assert.equal(agentRole(agent("codex", { installed: false }), "codex"), null);
});

test("install runs the agent's own installer, then the adapter, only for the first mate's agent", () => {
  const missing = noAdapter(agent("claude", { installed: false }));
  assert.deepEqual(installSteps(missing, "claude").map((s) => s.command), ["curl -fsSL https://claude.ai/install.sh | bash", missing.adapter.command]);
  assert.deepEqual(installSteps(missing, "codex").map((s) => s.command), ["curl -fsSL https://claude.ai/install.sh | bash"], "no adapter for an agent that only takes crew work");
  assert.deepEqual(installSteps(noAdapter(agent("codex")), "codex").map((s) => s.title), ["Install the ACP adapter"]);
  assert.deepEqual(installSteps(agent("codex"), "codex"), []);
  assert.equal(cannotInstall(agent("claude", { installed: false, install: null })), true);
  assert.equal(cannotInstall(agent("claude", { installed: false })), false);
});

test("Node stands in the way only of an install that runs npm, and only below the package's floor", () => {
  const node = (major) => ({ version: major === null ? null : `v${major}.1.0`, major });
  assert.deepEqual(nodeShortfall(noAdapter(agent("claude")), "claude", node(null)), { floor: 22, have: null });
  assert.deepEqual(nodeShortfall(noAdapter(agent("claude")), "claude", node(20)), { floor: 22, have: "v20.1.0" });
  assert.equal(nodeShortfall(noAdapter(agent("claude")), "claude", node(22)), null);
  assert.equal(nodeShortfall(agent("claude", { installed: false }), "codex", node(null)), null, "Claude Code's own installer needs no Node");
  assert.deepEqual(nodeShortfall(agent("codex", { installed: false }), "claude", node(null)), { floor: 16, have: null }, "Codex installs through npm");
});

test("the first mate starts once its own agent is installed, has its adapter and is not signed out", () => {
  assert.equal(startBlocker(status([agent("claude"), agent("codex")])), null);
  assert.equal(startBlocker(status([agent("claude", { signedIn: "unknown" })])), null, "starting is the check when sign-in could not be read");
  assert.equal(startBlocker(status([agent("claude", { installed: false }), agent("codex")])), "Needs Claude Code to start.");
  assert.equal(startBlocker(status([noAdapter(agent("claude"))])), "Needs the Claude Code ACP adapter to start.");
  assert.equal(startBlocker(status([agent("claude", { signedIn: "signed-out" })])), "Your first mate runs on Claude Code, so it waits for Claude Code's sign-in.");
  assert.equal(startBlocker(status([agent("claude", { signedIn: "signed-out" }), agent("codex")], { firstMate: "codex" })), null, "a signed-out crew agent does not block the first mate");
  assert.equal(startBlocker(status([], { problem: "boom" })), "This Mac's agents could not be checked.");
});

test("the first mate can move only to another installed agent, and Codex's pace is said where it is chosen", () => {
  assert.deepEqual(otherFirstMates(status([agent("claude"), agent("codex")])).map((a) => a.id), ["codex"]);
  assert.deepEqual(otherFirstMates(status([agent("claude"), agent("codex", { installed: false })])), []);
  assert.match(firstMateNote("codex"), /up to three minutes/);
  assert.equal(firstMateNote("claude"), null);
});

test("the welcome shows on the app's own home until a first mate has answered there", () => {
  assert.equal(showWelcome({ home: "/h", chosen: false, greeted: false, meeting: false }), true);
  assert.equal(showWelcome({ home: "/h", chosen: false, greeted: true, meeting: false }), false);
  assert.equal(showWelcome({ home: "/h", chosen: true, greeted: false, meeting: false }), false, "a folder the captain chose is theirs already");
  assert.equal(showWelcome({ home: "/h", chosen: false, greeted: null, meeting: false }), false, "nothing is shown before the home is read");
  assert.equal(showWelcome({ home: "/h", chosen: false, greeted: false, meeting: true }), false, "once the captain asked to meet it, chat says how that goes");
  assert.equal(showWelcome({ home: null, chosen: false, greeted: false, meeting: false }), false);
});

test("an install's events fold into what its row shows", () => {
  let view = foldInstall(null, { harness: "claude", step: 1, steps: 2, state: "running", title: "Installing Claude Code", command: "curl …" });
  view = foldInstall(view, { harness: "claude", step: 1, steps: 2, state: "line", line: "Downloading" });
  assert.equal(view.line, "Downloading");
  view = foldInstall(view, { harness: "claude", step: 1, steps: 2, state: "done" });
  assert.equal(view.state, "running", "one step of two done is not the install done");
  view = foldInstall(view, { harness: "claude", step: 2, steps: 2, state: "running", title: "Installing the ACP adapter", command: "npm …" });
  assert.equal(view.title, "Installing the ACP adapter");
  assert.equal(view.line, null, "a new step starts without the last step's line");
  view = foldInstall(view, { harness: "claude", step: 2, steps: 2, state: "line", line: "npm error code ENOTFOUND" });
  view = foldInstall(view, { harness: "claude", step: 2, steps: 2, state: "failed", error: "npm error code ENOTFOUND" });
  assert.equal(view.state, "failed");
  assert.equal(view.error, "npm error code ENOTFOUND");
  assert.deepEqual(view.lines, ["Downloading", "npm error code ENOTFOUND"]);
  const done = foldInstall(foldInstall(null, { harness: "codex", step: 1, steps: 1, state: "running", title: "t", command: "c" }), { harness: "codex", step: 1, steps: 1, state: "done" });
  assert.equal(done.state, "done");
});
