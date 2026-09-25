// Unit tests for src/update.ts, which decides what the sidebar says about the app's own update.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkView, updateFeed, updateView } from "../src/update.ts";
import { ago } from "../src/usage.ts";

const base = { state: "none", current: "0.1.41", version: null, notes: null, error: null, installed: null, enabled: true, checking: false, downloading: null, checked_at_ms: null, check_error: null };
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

const NOW = 1_800_000_000_000;
const since = (at) => ago(at, NOW);

test("without an update, the line says when the app last checked and offers to check now", () => {
  const current = checkView({ ...base, checked_at_ms: NOW - 40 * 60_000 }, since);
  assert.deepEqual([current.kind, current.title, current.detail, current.action], ["current", "Up to date", "0.1.41 · checked 40m ago", "Check now"]);
  const unchecked = checkView(base, since);
  assert.deepEqual([unchecked.kind, unchecked.title, unchecked.detail, unchecked.action], ["unchecked", "Not checked yet", "0.1.41", "Check now"]);
  assert.equal(checkView(null, since), null);
});

test("a check running says what it is doing and offers no button", () => {
  const looking = checkView({ ...base, checking: true, checked_at_ms: NOW - 60_000 }, since);
  assert.deepEqual([looking.kind, looking.title, looking.action], ["checking", "Checking for updates…", null]);
  const fetching = checkView({ ...base, checking: true, downloading: "0.1.42" }, since);
  assert.deepEqual([fetching.kind, fetching.title, fetching.action], ["checking", "Downloading 0.1.42…", null]);
  assert.match(fetching.detail, /signature/);
});

test("a check that failed says why, when it last looked, and can be tried again", () => {
  const failed = checkView({ ...base, checked_at_ms: NOW - 5_000, check_error: "error sending request for url (https://example.test/latest.json)" }, since);
  assert.deepEqual([failed.kind, failed.title, failed.action], ["failed", "Couldn't check for updates", "Try again"]);
  assert.equal(failed.detail, "error sending request for url (https://example.test/latest.json) · tried just now");
  assert.equal(checkView({ ...base, check_error: "the update server did not answer." }, since).detail, "the update server did not answer");
});

test("a build that never looks says so plainly, with nothing to press", () => {
  const off = checkView({ ...base, enabled: false }, since);
  assert.deepEqual([off.kind, off.title, off.action], ["off", "This build does not update", null]);
  assert.equal(off.detail, "0.1.41 · updates are off for this build");
});

test("while an update is held, the notice speaks and the line steps aside", () => {
  for (const state of ["ready", "waiting", "installing", "failed"]) {
    assert.equal(checkView({ ...ready, state, checked_at_ms: NOW }, since), null, state);
  }
  const installed = { ...base, checked_at_ms: NOW, installed: { version: "0.1.41", from: "0.1.40", notes: null } };
  assert.equal(checkView(installed, since).kind, "current", "after a restart, the note and the line both show");
});

test("a command's reply never overwrites an event that arrived while it was asked", async () => {
  const shown = [];
  const feed = updateFeed((update) => shown.push(update));
  const checking = { ...base, checking: true };
  const done = { ...base, checked_at_ms: NOW, check_error: "error sending request" };
  await feed.reply(async () => {
    feed.event(checking);
    feed.event(done);
    return checking;
  });
  assert.deepEqual(shown, [checking, done]);
  assert.equal(checkView(shown.at(-1), since).action, "Try again");
});

test("a command's reply applies when no event came meanwhile, and a later event still wins", async () => {
  const shown = [];
  const feed = updateFeed((update) => shown.push(update));
  const checking = { ...base, checking: true };
  const done = { ...base, checked_at_ms: NOW };
  await feed.reply(async () => checking);
  feed.event(done);
  assert.deepEqual(shown, [checking, done]);
});
