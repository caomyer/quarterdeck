// Unit tests for packages/core/src/conversation.ts, the rules that fold the host's events into the conversation every
// client draws.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, with no React and no window: the fold needs neither.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPACT_COMMAND, emptyConversation, foldCompactionAsked, foldCompactionDismissed, foldEvent, foldHostState, foldNewHome, foldNoteSent,
  foldPermission, foldPermissionGone, foldResent, foldSend, foldSnapshot, FRESH_CONVERSATION, NOT_STARTED_HERE,
} from "@quarterdeck/core/conversation";

const NOW = Date.parse("2026-10-17T09:00:00Z");
const HOME = "/Users/captain/firstmate";

/** A context whose time and ids are named, so every fold below is repeatable. */
function context(fields = {}) {
  let next = 0;
  return { now: NOW, newId: () => `id-${++next}`, home: HOME, ...fields };
}

/** Folds events in order, each with the same context. */
function fold(events, state = emptyConversation(), ctx = context()) {
  return events.reduce((current, event) => foldEvent(current, event, ctx), state);
}

const state = (value, fields = {}) => ({ type: "state", payload: { state: value, ...fields } });
const session = (id, fields = {}) => ({ type: "session", payload: { session_id: id, mode: "new", ...fields } });
const text = (chunk) => ({ type: "text", payload: { chunk, origin: "prompt" } });
const outbox = (id, status, fields = {}) => ({ type: "outbox", payload: { id, status, ...fields } });
const step = (id, fields = {}) => ({ type: "tool_call", payload: { id, title: `Step ${id}`, kind: "execute", status: "pending", ...fields } });
const words = (conversation) => conversation.messages.map((message) => `${message.who}: ${message.text}`);

test("a fold is pure: the same events give the same conversation, and what it was given is left as it was", () => {
  const events = [state("starting", { home: HOME }), session("s1"), state("idle"), outbox("m1", "queued", { text: "hello" }), state("prompt_turn"), text("Hi"), text(" there"), outbox("m1", "picked_up"), state("idle")];
  const before = emptyConversation();
  const kept = structuredClone(before);
  const once = fold(events, before);
  assert.deepEqual(before, kept);
  assert.deepEqual(fold(events), once);
  assert.deepEqual(words(once), ["captain: hello", "mate: Hi there"]);
});

test("an event that changes nothing gives back the conversation itself", () => {
  const start = fold([session("s1")]);
  assert.equal(foldEvent(start, { type: "prompt_result", payload: { id: "m1" } }, context()), start);
  assert.equal(foldEvent(start, { type: "tool_update", payload: { id: "unknown", status: "completed" } }, context()), start);
  assert.equal(foldEvent(start, { type: "permission", payload: {} }, context()), start);
});

test("words stream into one message until a new step, and an earlier step's update never splits them", () => {
  const conversation = fold([session("s1"), state("prompt_turn"), text("Looking"), step("t1"), text("Found it"), { type: "tool_update", payload: { id: "t1", status: "completed" } }, text(", done.")]);
  assert.deepEqual(words(conversation), ["mate: Looking", "step: Step t1", "mate: Found it, done."]);
  assert.equal(conversation.messages[1].status, "completed");
  assert.ok(conversation.messages.every((message) => message.session === "s1" && message.turn === 1));
});

test("a turn starting counts the turn and when it began; its end clears both the stream and the time", () => {
  const ctx = context();
  const turning = fold([session("s1"), state("idle"), state("prompt_turn"), text("a")], emptyConversation(), ctx);
  assert.equal(turning.turn, 1);
  assert.equal(turning.turnSince, NOW);
  assert.ok(turning.streamId);
  const agent = foldEvent(turning, state("agent_turn"), context({ now: NOW + 5_000 }));
  assert.equal(agent.turn, 1, "moving between kinds of turn is the same turn");
  assert.equal(agent.turnSince, NOW);
  const idle = foldEvent(agent, state("idle"), ctx);
  assert.equal(idle.turnSince, null);
  assert.equal(idle.streamId, null);
  assert.deepEqual(words(foldEvent(idle, text("b"), ctx)), ["mate: a", "mate: b"]);
});

test("the host's state names its home, clears a start error once it runs, and drops approvals when its adapter goes", () => {
  let conversation = { ...emptyConversation(), startError: "no such folder" };
  conversation = fold([state("stopped")], conversation);
  assert.equal(conversation.startError, "no such folder");
  conversation = fold([state("starting", { home: HOME, holder: "pid 1" })], conversation);
  assert.equal(conversation.startError, null);
  assert.equal(conversation.hostHome, HOME);
  assert.deepEqual(conversation.runtime, { state: "starting", holder: "pid 1", reason: undefined, reasonKind: undefined });
  const request = { id: "p1", title: "git push", options: [] };
  conversation = fold([state("idle"), { type: "permission_request", payload: request }], conversation);
  assert.deepEqual(conversation.permissionRequests, [request]);
  assert.deepEqual(fold([state("restarting")], conversation).permissionRequests, []);
});

test("a warning raised before a start clears when the first mate is ready; one raised during the start outlives it", () => {
  const limit = { type: "host_health", payload: { kind: "session_limit", warning: "You've hit your limit" } };
  const before = fold([state("idle"), limit]);
  assert.deepEqual(before.healthWarning, { kind: "session_limit", message: "You've hit your limit", clearsAfter: 0 });
  assert.equal(fold([state("restarting"), state("idle")], before).healthWarning, null);
  const during = fold([state("restarting"), limit, state("idle")]);
  assert.equal(during.healthWarning?.message, "You've hit your limit");
  assert.equal(fold([state("restarting"), state("idle")], during).healthWarning, null);
});

test("host health: a rewake storm comes and goes, a refused kill says so, and a reported failure is drawn", () => {
  const storm = fold([{ type: "host_health", payload: { rewake_storm: true, turns: 8, window_secs: 60 } }]);
  assert.deepEqual(storm.rewakeStorm, { turns: 8, windowSecs: 60 });
  assert.equal(fold([{ type: "host_health", payload: { kind: "rewake_storm_cleared" } }], storm).rewakeStorm, null);
  const kill = fold([{ type: "host_health", payload: { kind: "kill_refused", after: "leftover", report: { pids: [4] } } }]);
  assert.equal(kill.healthWarning?.kind, "kill_refused");
  assert.match(kill.healthWarning?.message ?? "", /left running before it closed/);
  assert.equal(kill.healthWarning?.details, JSON.stringify({ pids: [4] }, null, 2));
  const unsaved = fold([{ type: "host_health", payload: { kind: "outbox_write_failed", error: "disk full" } }]);
  assert.equal(unsaved.healthWarning?.kind, "other");
});

test("the outbox: words from the durable outbox once, delivery into the session, read time, and a failure in words", () => {
  const ctx = context();
  let conversation = fold([outbox("m1", "requeued", { text: "ship it" }), outbox("m1", "queued", { text: "ship it" })], emptyConversation(), ctx);
  assert.deepEqual(words(conversation), ["captain: ship it"]);
  assert.equal(conversation.outbox.m1.resentAfterRestart, true);
  conversation = fold([session("s2"), outbox("m1", "sent")], conversation, ctx);
  assert.equal(conversation.messages[0].session, "s2");
  conversation = fold([{ type: "host_health", payload: { kind: "session_limit" } }, outbox("m1", "picked_up")], conversation, ctx);
  assert.equal(conversation.outbox.m1.readAt, new Date(NOW).toISOString());
  assert.equal(conversation.healthWarning, null, "a reply came through, so the limit has reset");
  const failed = fold([outbox("m2", "failed", { error: JSON.stringify({ code: -32603, message: "Internal error: rate limited" }) })]);
  assert.deepEqual(failed.outbox.m2, { status: "failed", resentAfterRestart: false, readAt: undefined, error: "rate limited", errorKind: "failed", resent: undefined });
});

test("a fresh conversation after a lost one puts its notice above the messages still waiting", () => {
  const ctx = context();
  let conversation = fold([session("s1"), outbox("read", "picked_up")], emptyConversation(), ctx);
  conversation = foldSend(conversation, "read", { id: "read" }, ctx).conversation;
  conversation = foldSend(conversation, "waiting", { id: "waiting" }, ctx).conversation;
  conversation = fold([session("s2", { previous_session_lost: true })], conversation, ctx);
  assert.deepEqual(words(conversation), ["captain: read", `notice: ${FRESH_CONVERSATION}`, "captain: waiting"]);
  assert.equal(conversation.context, null);
  assert.equal(fold([session("s3")], conversation).messages.length, 3, "a session that was not lost adds no notice");
});

test("a resumed session's history replaces its messages, and a waiting message takes the place of its copy", () => {
  const ctx = context();
  let conversation = fold([session("s1"), text("old words")], emptyConversation(), ctx);
  conversation = foldSend(conversation, "yes", { id: "read-yes" }, ctx).conversation;
  conversation = fold([outbox("read-yes", "picked_up")], conversation, ctx);
  conversation = foldSend(conversation, "yes", { id: "waiting-yes" }, ctx).conversation;
  conversation = fold([session("s1", { mode: "loaded" }), {
    type: "history",
    payload: { items: [{ who: "mate", text: "old words" }, { who: "captain", text: "yes" }, { who: "mate", text: "ok" }, { who: "captain", text: "yes" }] },
  }], conversation, ctx);
  assert.deepEqual(words(conversation), ["mate: old words", "captain: yes", "mate: ok", "captain: yes"]);
  assert.equal(conversation.messages[1].id, "history-s1-1", "the read copy is the history's own");
  assert.equal(conversation.messages[3].id, "waiting-yes", "the waiting one keeps its status in its copy's place");
  assert.equal(conversation.messages[0].before, new Date(NOW).toISOString());
});

test("a snapshot of another home is not this one's, and a refresh starting changes only that it is refreshing", () => {
  const ctx = context();
  const bearings = { generated_at: "now" };
  const other = foldSnapshot(emptyConversation(), { phase: "ready", home: "/elsewhere", bearings }, ctx);
  assert.equal(other.bearings, null);
  const refreshing = foldEvent(emptyConversation(), { type: "snapshot", payload: { phase: "refreshing" } }, ctx);
  assert.equal(refreshing.refreshing, true);
  assert.equal(refreshing.snapshotHealth.bearingsAt, null);
  const ready = foldSnapshot(refreshing, { phase: "ready", home: HOME, bearings, generated_at_ms: 7, errors: [{ script: "fm-fleet-snapshot.sh", message: "boom" }] }, ctx);
  assert.equal(ready.refreshing, false);
  assert.equal(ready.bearings, bearings);
  assert.deepEqual(ready.snapshotHealth, { errors: [{ script: "fm-fleet-snapshot.sh", message: "boom" }], failedAt: NOW, bearingsAt: 7, fleetAt: null });
});

test("usage keeps the host's reading, or builds one from the adapter's alone, and compaction follows the asked one", () => {
  const ctx = context();
  let conversation = fold([{ type: "usage", payload: { update: { used: 100, size: 1000 }, at_ms: 5 } }], emptyConversation(), ctx);
  assert.deepEqual(conversation.context, { used: 100, size: 1000, at_ms: 5, resumed: false, compacted: null });
  const sent = foldSend(conversation, COMPACT_COMMAND, { id: "c1" }, ctx);
  conversation = foldCompactionAsked(sent.conversation, sent.id);
  assert.deepEqual(conversation.compaction, { id: "c1", state: "waiting", error: undefined });
  assert.equal(foldCompactionDismissed(conversation), conversation, "one still on its way stays");
  conversation = fold([{ type: "compact", payload: { id: "other", state: "running" } }], conversation, ctx);
  assert.equal(conversation.compaction.state, "waiting");
  conversation = fold([{ type: "compact", payload: { id: "c1", state: "done" } }, { type: "compact", payload: { id: "c1", state: "failed" } }], conversation, ctx);
  assert.equal(conversation.compaction.state, "done", "a finished compaction stays finished");
  assert.equal(foldCompactionDismissed(conversation).compaction, null);
});

test("a message the host never took stays on screen under an id of the app's own, and a compaction of it has failed", () => {
  const { conversation, id } = foldSend(emptyConversation(), COMPACT_COMMAND, { error: NOT_STARTED_HERE }, context());
  assert.equal(id, "not-sent-id-1");
  assert.deepEqual(conversation.outbox[id], { status: "queued", resentAfterRestart: false, error: NOT_STARTED_HERE, errorKind: "not_sent" });
  assert.deepEqual(foldCompactionAsked(conversation, id).compaction, { id, state: "failed", error: NOT_STARTED_HERE });
  assert.equal(foldResent(conversation, id).outbox[id].resent, true);
  assert.equal(foldResent(conversation, "nothing"), conversation);
  const lost = fold([session("s2", { previous_session_lost: true })], conversation);
  assert.equal(lost.messages.at(-1).who, "notice", "it is not waiting for the new conversation, so the notice goes below it");
});

test("a message sent another way is shown once", () => {
  const ctx = context();
  const noted = foldNoteSent(emptyConversation(), "r1", "review", ctx);
  assert.equal(foldNoteSent(noted, "r1", "review", ctx), noted);
  assert.equal(fold([outbox("r1", "queued", { text: "review" })], noted).messages.length, 1);
});

test("a window opening late takes the host's conversation, but what events already said wins", () => {
  const ctx = context();
  const early = fold([text("arrived first"), { type: "permission_resolved", payload: { id: "p-done", option_id: "allow" } }], emptyConversation(), ctx);
  const controls = { options: [], commands: [] };
  const opened = foldHostState(early, {
    state: { state: "prompt_turn" },
    home: HOME,
    conversation: { sessionId: "s9", items: [{ who: "captain", text: "earlier" }] },
    controls,
    usage: { context: { used: 1, size: 2, at_ms: 3, resumed: true, compacted: null }, rateLimit: null },
    permissionRequests: [{ id: "p-done", title: "answered", options: [] }, { id: "p-open", title: "waiting", options: [] }],
  }, ctx);
  assert.equal(opened.session, "s9");
  assert.equal(opened.hostHome, HOME);
  assert.deepEqual(words(opened), ["captain: earlier"], "what arrived before the answer is the same session's, which the host's conversation holds");
  assert.equal(opened.controls, controls);
  assert.equal(opened.turnSince, NOW);
  assert.deepEqual(opened.permissionRequests.map((request) => request.id), ["p-open"]);
  const again = foldHostState(opened, { state: { state: "idle" }, home: "/other", conversation: { sessionId: "s10", items: [] } }, ctx);
  assert.equal(again.session, "s9", "a conversation already shown is not replaced");
  assert.equal(again.hostHome, HOME);
});

test("approvals: answering, a failed answer, and one gone", () => {
  let conversation = fold([{ type: "permission_request", payload: { id: "p1", title: "push", options: [] } }]);
  conversation = foldPermission(conversation, "p1", { answering: true });
  assert.equal(conversation.permissionRequests[0].answering, true);
  conversation = foldPermission(conversation, "p1", { answering: false, error: "gone" });
  assert.equal(conversation.permissionRequests[0].error, "gone");
  assert.deepEqual(foldPermissionGone(conversation, "p1").permissionRequests, []);
});

test("a new home clears the old home's snapshot and conversation, and nothing else", () => {
  const ctx = context();
  let conversation = fold([state("idle", { home: HOME }), session("s1"), text("hi"), outbox("m1", "queued", { text: "x" })], emptyConversation(), ctx);
  conversation = foldSnapshot(conversation, { phase: "ready", bearings: {}, fleet: {}, projects: [{ name: "p" }] }, ctx);
  const moved = foldNewHome(conversation);
  assert.deepEqual(moved.messages, []);
  assert.deepEqual(moved.outbox, {});
  assert.equal(moved.outboxStatuses.size, 0);
  assert.equal(moved.bearings, null);
  assert.equal(moved.refreshing, true);
  assert.equal(moved.session, "s1");
  assert.equal(moved.runtime, conversation.runtime);
  assert.equal(moved.hostHome, HOME);
});
