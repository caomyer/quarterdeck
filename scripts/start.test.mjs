// Unit tests for src/start.ts, where a queued task's drawer reads how its start stands.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { heldForCaptain, LAUNCH_GRACE_MS, launchPhase, lighterReason, postureHint, startPhase, wantsFreshReading, wantsReadingAfterTurn } from "../src/start.ts";

const NOW = Date.parse("2026-09-25T18:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function row(fields = {}) {
  return { id: "t-1", title: "Resonance: a task", hold_reason: null, current_role: "queued", state: "queued", captain_actionable: false, kind: "ship", repo: "resonance", hold_kind: null, body_lines: [], ...fields };
}

/** A registered worker, launched `launchedAgo` ms before NOW, whose endpoint was read `observedAgo` ms before NOW. */
function worker({ status = "unknown", state = "unknown", launchedAgo = 10_000, observedAgo = 0, wrote = false, gen = true } = {}) {
  return {
    id: "t-1", kind: "ship", harness: "claude", mode: "no-mistakes", yolo: "off", project: "/h/projects/resonance", backend: "tmux",
    spawn_gen: gen ? `s${Math.floor((NOW - launchedAgo) / 1000)}.4242.17` : null,
    paths: { status_log: { present: wrote, last_event: wrote ? { state: "working", note: "Reading.", raw: "working: Reading." } : { state: "", note: "", raw: "" } }, worktree: { path: "", present: true }, report: { path: "", present: false } },
    current_state: { state, source: "pane", detail: "", raw: "", observed_at: iso(NOW - observedAgo), freshness: "fresh" },
    endpoint: { target: "s:w", exists: status !== "absent", agent_alive: status === "absent" ? "dead" : status, status, observed_at: iso(NOW - observedAgo), freshness: "fresh" },
    pr: { url: null, source: "none" }, hints: {}, actions: {},
  };
}

function ask(fields = {}) {
  return { at: NOW - 60_000, task: "t-1", project: "resonance", title: "Resonance: a task", kind: "ship", mode: "judge", note: null, message: "m-1", error: null, header: "Start work on t-1 (resonance): Resonance: a task", text: "", ...fields };
}

function inputs(fields = {}) {
  return { record: row(), task: undefined, orphans: [], ask: null, delivery: undefined, runtime: "idle", sendReady: true, quietSince: NOW - 120_000, snapshotAt: NOW, now: NOW, ...fields };
}

test("a queued row with nothing asked offers Start, unless the first mate cannot be reached", () => {
  assert.equal(startPhase(inputs()), "queued");
  assert.equal(startPhase(inputs({ sendReady: false })), "offline");
});

test("a call is answered, not started, whether it waits on the captain or already has his answer", () => {
  assert.equal(startPhase(inputs({ record: row({ captain_actionable: true, hold_kind: "captain", hold_reason: "Pick one" }) })), "held");
  assert.equal(startPhase(inputs({ record: row({ kind: "captain", hold_kind: "captain" }) })), "held");
  // A row held on another task is not a call: the first mate can say it waits, and the drawer shows that in chat.
  assert.equal(startPhase(inputs({ record: row({ hold_reason: "Waits on the lifecycle work" }) })), "queued");
  assert.equal(heldForCaptain(row({ hold_reason: "blocked-by: other" })), false);
});

test("an ask on its way or being read is Asked", () => {
  for (const status of ["queued", "sent", "likely_started", "requeued"]) {
    assert.equal(startPhase(inputs({ ask: ask(), delivery: { status }, runtime: "prompt_turn", quietSince: null })), "asked", status);
  }
  // Read, but the first mate is still in its turn: it may be spawning right now.
  assert.equal(startPhase(inputs({ ask: ask(), delivery: { status: "picked_up", readAt: iso(NOW - 5_000) }, runtime: "prompt_turn", quietSince: null })), "asked");
});

test("an ask the host did not take, or whose turn errored, is Not sent", () => {
  assert.equal(startPhase(inputs({ ask: ask({ message: null, error: "not running here" }) })), "not_sent");
  assert.equal(startPhase(inputs({ ask: ask(), delivery: { status: "failed", errorKind: "failed", error: "rate limit" } })), "not_sent");
});

test("Not started needs the ask read, the turn over, and a snapshot taken since that still has the row queued", () => {
  const read = { status: "picked_up", readAt: iso(NOW - 30_000) };
  assert.equal(startPhase(inputs({ ask: ask(), delivery: read, quietSince: NOW - 29_000, snapshotAt: NOW - 1_000 })), "not_started");
  // The snapshot on screen predates the turn's end, so whether the row moved is not known yet.
  const stale = inputs({ ask: ask(), delivery: read, quietSince: NOW - 29_000, snapshotAt: NOW - 40_000 });
  assert.equal(startPhase(stale), "asked");
  assert.equal(wantsReadingAfterTurn(stale), true);
  // firstmate stamps its snapshot to the second, so one taken in the same second as the turn's end counts.
  assert.equal(startPhase(inputs({ ask: ask(), delivery: read, quietSince: Date.parse("2026-09-25T17:59:31.400Z"), snapshotAt: Date.parse("2026-09-25T17:59:31Z") })), "not_started");
  // A quiet first mate noticed before the read still waits for a snapshot taken after the read.
  assert.equal(startPhase(inputs({ ask: ask(), delivery: read, quietSince: NOW - 300_000, snapshotAt: NOW - 60_000 })), "asked");
  assert.equal(wantsReadingAfterTurn(inputs({ ask: ask(), delivery: read, quietSince: NOW - 300_000, snapshotAt: NOW - 60_000 })), true);
  // Nothing to judge while a turn runs.
  assert.equal(wantsReadingAfterTurn(inputs({ ask: ask(), delivery: read, runtime: "agent_turn", quietSince: null, snapshotAt: NOW - 60_000 })), false);
});

test("an ask from before this launch has no outbox entry: it was delivered, and is judged from what is read now", () => {
  assert.equal(startPhase(inputs({ ask: ask({ at: NOW - 3_600_000 }), quietSince: NOW - 10_000, snapshotAt: NOW - 5_000 })), "not_started");
  assert.equal(startPhase(inputs({ ask: ask({ at: NOW - 3_600_000 }), quietSince: NOW - 10_000, snapshotAt: NOW - 20_000 })), "asked");
});

test("a row in flight with no worker registered is Not picked up only when the snapshot says so", () => {
  const moved = row({ state: "in_flight" });
  assert.equal(startPhase(inputs({ record: moved, orphans: ["t-1"] })), "orphaned");
  assert.equal(startPhase(inputs({ record: moved })), "in_flight");
});

test("Working is only ever an agent the snapshot has seen alive", () => {
  const moved = row({ state: "in_flight" });
  assert.equal(startPhase(inputs({ record: moved, task: worker({ status: "alive", state: "working" }) })), "working");
  // The pane's busy signature is not liveness: qd-spawn-race-1 read a shell at a continuation prompt as busy.
  for (const status of ["unknown", "dead", "absent", "not_checked"]) {
    for (const launchedAgo of [5_000, LAUNCH_GRACE_MS + 60_000]) {
      const phase = launchPhase(worker({ status, state: "working", launchedAgo }), NOW);
      assert.notEqual(phase, "working", `${status} ${launchedAgo}`);
    }
  }
});

test("a dead endpoint is Didn't start only from a reading taken well after the launch", () => {
  assert.equal(launchPhase(worker({ status: "dead", launchedAgo: 20_000 }), NOW), "starting");
  // The only reading was taken at the launch, when a pane holds a shell while its agent starts: not proof of anything.
  assert.equal(launchPhase(worker({ status: "dead", launchedAgo: 5 * 60_000, observedAgo: 5 * 60_000 - 3_000 }), NOW), "starting");
  assert.equal(wantsFreshReading("starting"), true);
  assert.equal(launchPhase(worker({ status: "dead", launchedAgo: 3 * 60_000 }), NOW), "didnt_start");
  assert.equal(launchPhase(worker({ status: "absent", launchedAgo: 3 * 60_000 }), NOW), "didnt_start");
  // A worker that wrote a status line ran; one that died later is the live drawer's to tell.
  assert.equal(launchPhase(worker({ status: "dead", launchedAgo: 3 * 60_000, wrote: true }), NOW), "underway");
});

test("an endpoint no backend can classify is Launched, not confirmed once the grace has passed", () => {
  assert.equal(launchPhase(worker({ status: "unknown", launchedAgo: 30_000 }), NOW), "starting");
  assert.equal(launchPhase(worker({ status: "unknown", launchedAgo: LAUNCH_GRACE_MS }), NOW), "unconfirmed");
  assert.equal(launchPhase(worker({ status: "unknown", gen: false }), NOW), "unconfirmed");
  assert.equal(wantsFreshReading("unconfirmed"), true);
  assert.equal(launchPhase(worker({ status: "unknown", launchedAgo: LAUNCH_GRACE_MS, wrote: true }), NOW), "underway");
});

test("a worker that speaks for itself is the live drawer's, and a done row with its worker still registered too", () => {
  for (const state of ["done", "failed", "blocked", "parked", "paused"]) assert.equal(launchPhase(worker({ status: "unknown", state }), NOW), "underway");
  assert.equal(startPhase(inputs({ record: row({ state: "done" }), task: worker({ state: "done" }) })), "underway");
  assert.equal(startPhase(inputs({ record: row({ state: "done" }) })), "closed");
});

test("a lighter mode's reason is the first mate's own line in the row, or nothing", () => {
  const record = row({ body_lines: ["Colour each speaker.", "Mode: direct-PR, because it only touches drawing code."] });
  assert.equal(lighterReason(record, "direct-PR"), "Mode: direct-PR, because it only touches drawing code.");
  assert.equal(lighterReason(record, "no-mistakes"), null);
  assert.equal(lighterReason(row(), "direct-PR"), null);
});

test("the posture beside Start is the project's own", () => {
  assert.equal(postureHint("no-mistakes-prod-only"), "Project posture: no-mistakes for product work");
  assert.equal(postureHint(undefined), null);
});
