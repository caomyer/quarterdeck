// Unit tests for src/update.ts, which decides what the sidebar says about the app's own update.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { updateView } from "../src/update.ts";

const base = { state: "none", current: "0.1.41", version: null, notes: null, error: null, installed: null };
const ready = { ...base, state: "ready", version: "0.1.42", notes: "- One (#1)" };

test("nothing shows until there is something to act on or to read", () => {
  assert.equal(updateView(null, "idle"), null);
  assert.equal(updateView(base, "idle"), null);
});

test("an update waiting says whether a restart would wait for the turn", () => {
  const idle = updateView(ready, "idle");
  assert.deepEqual([idle.kind, idle.title, idle.action, idle.notes], ["ready", "Update ready: 0.1.42", "Restart", "- One (#1)"]);
  assert.match(idle.detail, /^Restart to use it/);
  for (const busy of ["prompt_turn", "agent_turn", "starting", "restarting"]) {
    assert.match(updateView(ready, busy).detail, /^Restarts once the current turn ends/, busy);
  }
  for (const quiet of ["stopped", "dead", "refused", "locked_by_other"]) {
    assert.match(updateView(ready, quiet).detail, /^Restart to use it/, quiet);
  }
});

test("a restart under way offers only what can still be done", () => {
  const waiting = updateView({ ...ready, state: "waiting" }, "agent_turn");
  assert.deepEqual([waiting.kind, waiting.title, waiting.detail, waiting.action], ["waiting", "Waiting for the current turn to end", "Then restarts into 0.1.42.", "Cancel"]);
  const installing = updateView({ ...ready, state: "installing" }, "idle");
  assert.deepEqual([installing.kind, installing.action], ["installing", null]);
});

test("a failed install says why, keeps the notes, and can be tried again", () => {
  const failed = updateView({ ...ready, state: "failed", error: "Failed to move the new app into place" }, "idle");
  assert.deepEqual([failed.kind, failed.title, failed.action, failed.notes], ["failed", "Couldn't install 0.1.42", "Try again", "- One (#1)"]);
  assert.equal(failed.detail, "Failed to move the new app into place. This version keeps running.");
  assert.match(updateView({ ...ready, state: "failed" }, "idle").detail, /^It gave no reason\./);
});

test("after a restart, what the update brought, until an update to act on comes first", () => {
  const installed = { ...base, current: "0.1.42", installed: { version: "0.1.42", from: "0.1.41", notes: "- One (#1)" } };
  const view = updateView(installed, "idle");
  assert.deepEqual([view.kind, view.title, view.action], ["installed", "Updated to 0.1.42", "Dismiss"]);
  assert.equal(view.detail, "From 0.1.41. Your home and its settings are as you left them.");
  assert.equal(updateView({ ...installed, installed: { ...installed.installed, from: null } }, "idle").detail, "Your home and its settings are as you left them.");
  assert.equal(updateView({ ...installed, state: "ready", version: "0.1.43" }, "idle").kind, "ready");
});
