// Unit tests for src/tasks.ts, which decides what a task list shows, in what order, and what each task waits on.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daysSince, downstreamOf, groupSections, groupsFor, loopsIn, loopThrough, openRows, priorityIsSet, priorityLevel, standingOf, startHere, startRanks, taskGraph, taskRows, upstreamOf, upstreamTree, viewCounts } from "../src/tasks.ts";

let order = 0;
/** A row as firstmate's parser writes it, with the start-order fields left for the test to give or leave out. */
function row(id, fields = {}) {
  order += 1;
  return {
    id, title: `task ${id}`, structured: true, state: "queued", kind: "ship", repo: "resonance", priority: null, hold_reason: null, hold_kind: null,
    hold_until: null, captain_actionable: false, current_role: "queued", since: "2026-09-20", blocked_by_ids: [], unresolved_blocker_ids: [],
    body_lines: [], part_of: null, order, ...fields,
  };
}

const input = (records, fields = {}) => ({ records, filter: { project: "resonance" }, view: "open", sort: "start", search: "", underway: new Set(), captainDay: "2026-09-26", ...fields });
const ids = (rows) => rows.map((item) => item.id);

test("a row's priority is its own, and a row without one counts as Normal", () => {
  assert.equal(priorityLevel(row("a", { priority: "0" })), 0);
  assert.equal(priorityLevel(row("a")), 2);
  assert.equal(priorityLevel(row("a", { priority: "9" })), 2);
  assert.equal(priorityLevel(row("a", { priority_level: 4, priority: "4" })), 4);
  assert.equal(priorityIsSet(row("a")), false);
  assert.equal(priorityIsSet(row("a", { priority: "3" })), true);
});

test("where a queued row stands is firstmate's word, else the same rule over what an older home carries", () => {
  assert.equal(standingOf(row("a", { standing: "blocked" })), "blocked");
  assert.equal(standingOf(row("a", { unresolved_blocker_ids: ["b"] })), "blocked");
  assert.equal(standingOf(row("a", { hold_reason: "later", hold_until: "2026-10-01" }), "2026-09-26"), "held");
  assert.equal(standingOf(row("a", { hold_reason: "later", hold_until: "2026-09-26" }), "2026-09-26"), "ready", "a hold lifts on its day");
  assert.equal(standingOf(row("a", { state: "in_flight" })), null);
});

test("start order is firstmate's rank when the home carries one", () => {
  const records = [row("late", { start_rank: 2 }), row("first", { start_rank: 1 })];
  assert.deepEqual(ids(taskRows(input(records))), ["first", "late"]);
  assert.deepEqual([...startRanks(records)], [["late", 2], ["first", 1]]);
});

test("an older home is ordered by the same rule: ready, then blocked, then put off, by priority then the oldest filed", () => {
  const records = [
    row("low", { priority: "3", since: "2026-09-01" }),
    row("new-normal", { since: "2026-09-25" }),
    row("old-normal", { since: "2026-09-02" }),
    row("urgent-blocked", { priority: "0", unresolved_blocker_ids: ["low"] }),
    row("urgent", { priority: "0", since: "2026-09-24" }),
    row("put-off", { priority: "0", hold_reason: "later", hold_kind: "parked", hold_until: "2026-10-09" }),
  ];
  assert.deepEqual(ids(taskRows(input(records))), ["urgent", "old-normal", "new-normal", "low", "urgent-blocked", "put-off"]);
});

test("underway work leads, and the list keeps to its filter, its search and what is its to show", () => {
  const records = [
    row("queued-one", { start_rank: 1 }),
    row("running", { state: "in_flight", current_role: "worker" }),
    row("elsewhere", { repo: "foreman", start_rank: 2 }),
    row("group", { kind: "program", state: "in_flight", current_role: "program" }),
    row("live-call", { kind: "captain", captain_actionable: true, hold_reason: "pending", hold_kind: "captain", standing: "held" }),
    row("answered-call", { kind: "captain", standing: "ready" }),
    row("deferred-call", { kind: "captain", hold_reason: "later", hold_kind: "captain", hold_until: "2026-09-28", standing: "held", start_rank: 3 }),
    row("report-waiting", { state: "in_flight" }),
    row("closed", { state: "done" }),
  ];
  const rows = taskRows(input(records, { hidden: new Set(["report-waiting"]) }));
  assert.deepEqual(ids(rows), ["running", "queued-one", "deferred-call"]);
  assert.equal(rows[0].standing, "underway");
  assert.deepEqual(ids(taskRows(input(records, { filter: {}, hidden: new Set(["report-waiting"]) }))), ["running", "queued-one", "elsewhere", "deferred-call"], "with no filter the list takes in every project");
  assert.deepEqual(ids(taskRows(input(records, { search: "queued ONE" }))), ["queued-one"], "search matches every word, in any case");
  assert.deepEqual(ids(taskRows(input([row("x", { body_lines: ["mentions the waveform"] })], { search: "waveform" }))), ["x"], "search reads the body");
});

test("the views split the open rows by where each stands, and count what they hold", () => {
  const records = [row("r", { standing: "ready" }), row("b", { standing: "blocked" }), row("h", { standing: "held" }), row("u", { state: "in_flight" })];
  assert.deepEqual(ids(taskRows(input(records, { view: "ready" }))), ["r"]);
  assert.deepEqual(ids(taskRows(input(records, { view: "blocked" }))), ["b"]);
  assert.deepEqual(ids(taskRows(input(records, { view: "held" }))), ["h"]);
  assert.deepEqual(viewCounts(input(records)), { open: 4, ready: 1, blocked: 1, held: 1 });
});

test("the other orders: what unblocks most, what has waited longest, what was filed last", () => {
  const records = [
    row("root", { since: "2026-09-10", start_rank: 1 }),
    row("mid", { unresolved_blocker_ids: ["root"], since: "2026-09-05", start_rank: 3 }),
    row("leaf", { unresolved_blocker_ids: ["mid"], since: "2026-09-22", start_rank: 4 }),
    row("alone", { since: "2026-09-01", start_rank: 2 }),
  ];
  assert.deepEqual(ids(taskRows(input(records, { sort: "unblocks" }))), ["root", "mid", "alone", "leaf"]);
  assert.deepEqual(ids(taskRows(input(records, { sort: "waiting" }))), ["alone", "mid", "root", "leaf"]);
  assert.deepEqual(ids(taskRows(input(records, { sort: "newest" }))), ["leaf", "root", "mid", "alone"]);
});

test("a task's whole upstream chain, and everything downstream of it, however deep", () => {
  const records = [
    row("a"), row("b", { unresolved_blocker_ids: ["a"] }), row("c", { unresolved_blocker_ids: ["b", "x"] }),
    row("d", { unresolved_blocker_ids: ["c"] }), row("x"), row("landed", { state: "done" }),
    row("e", { unresolved_blocker_ids: [], blocked_by_ids: ["landed"] }),
  ];
  const graph = taskGraph(records);
  assert.deepEqual(upstreamOf(graph, "d"), ["c", "b", "x", "a"]);
  assert.deepEqual(downstreamOf(graph, "a"), ["b", "c", "d"]);
  assert.deepEqual(upstreamOf(graph, "e"), [], "a landed blocker holds nothing");
  assert.deepEqual(startHere(graph, "d"), ["x", "a"], "the ready roots are where to start");
});

test("an older home's chain is read from what each row waits on that is still open", () => {
  const graph = taskGraph([row("a"), row("b", { unresolved_blocker_ids: undefined, blocked_by_ids: ["a", "gone"] })]);
  assert.deepEqual(upstreamOf(graph, "b"), ["a"]);
});

test("the chain tree puts each blocker under what waits on it, once, and marks a loop instead of following it", () => {
  const records = [row("a"), row("b", { unresolved_blocker_ids: ["a"] }), row("c", { unresolved_blocker_ids: ["a", "b"] }), row("d", { unresolved_blocker_ids: ["c"] })];
  const tree = upstreamTree(taskGraph(records), "d");
  const flat = (nodes) => nodes.flatMap((node) => [`${"  ".repeat(node.depth - 1)}${node.id}${node.loop ? " (loop)" : ""}`, ...flat(node.children)]);
  assert.deepEqual(flat(tree), ["c", "  a", "  b"]);
  const loop = upstreamTree(taskGraph([row("p", { unresolved_blocker_ids: ["q"] }), row("q", { unresolved_blocker_ids: ["p"] })]), "p");
  assert.deepEqual(flat(loop), ["q", "  p (loop)"]);
});

test("every loop is found once, and a task can say which loop it is in", () => {
  const records = [
    row("a", { unresolved_blocker_ids: ["b"] }), row("b", { unresolved_blocker_ids: ["c"] }), row("c", { unresolved_blocker_ids: ["a"] }),
    row("x", { unresolved_blocker_ids: ["y"] }), row("y", { unresolved_blocker_ids: ["x"] }), row("free"),
  ];
  const graph = taskGraph(records);
  assert.deepEqual(loopsIn(graph).map((loop) => loop.join(">")), ["a>b>c", "x>y"]);
  assert.deepEqual(loopThrough(graph, "c"), ["c", "a", "b"]);
  assert.equal(loopThrough(graph, "free"), null);
  assert.deepEqual(startHere(graph, "a"), [], "a loop has nowhere to start");
});

test("groups gather their tasks, keep landed ones at the foot until the group closes, and count them", () => {
  const records = [
    row("g-truth", { kind: "program", state: "in_flight", title: "Trust what the app says", priority: "1" }),
    row("g-empty", { kind: "program", state: "in_flight", title: "Nothing yet", priority: "2" }),
    row("g-other", { kind: "program", state: "in_flight", repo: "foreman" }),
    row("m1", { part_of: "g-truth", start_rank: 2 }),
    row("m2", { part_of: "g-truth", start_rank: 1 }),
    row("m-landed", { part_of: "g-truth", state: "done" }),
    row("loose", { start_rank: 3 }),
  ];
  const rows = taskRows(input(records));
  const groups = groupsFor(records, { project: "resonance" }, rows);
  assert.deepEqual(groups.map((group) => [group.id, group.landed, group.total]), [["g-truth", 1, 3], ["g-empty", 0, 0]]);
  const sections = groupSections(records, { project: "resonance" }, rows, true);
  assert.deepEqual(sections.map((section) => [section.group?.id ?? null, ids(section.rows)]), [["g-truth", ["m2", "m1", "m-landed"]], ["g-empty", []], [null, ["loose"]]]);
  assert.equal(sections[0].rows[2].standing, "landed");
  assert.deepEqual(groupSections(records, { project: "resonance" }, taskRows(input(records, { view: "ready" })), false)[0].rows.map((item) => item.id), ["m2", "m1"], "a view other than Open shows no landed tasks");
});

test("a list mounted with no filter shows every group, and a group elsewhere when one of its rows is listed", () => {
  const records = [row("g-foreman", { kind: "program", state: "in_flight", repo: "foreman" }), row("m", { part_of: "g-foreman" })];
  assert.deepEqual(groupsFor(records, { project: "resonance" }, openRows(input(records))).map((group) => group.id), ["g-foreman"]);
  assert.deepEqual(groupsFor(records, {}, []).map((group) => group.id), ["g-foreman"]);
});

test("days since a filing day count whole local days", () => {
  const now = new Date(2026, 8, 26, 9, 0).getTime();
  assert.equal(daysSince("2026-09-26", now), 0);
  assert.equal(daysSince("2026-09-20", now), 6);
  assert.equal(daysSince(null, now), null);
});
