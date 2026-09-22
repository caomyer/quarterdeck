// Unit tests for src/logbook.ts, the project page's record of closed work.
//
//   pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { callProject, filterLog, landedWithin, logCounts, logEntries, logKind, logPeriods, outcomeLine, upNext } from "../src/logbook.ts";

const NOW = new Date(2026, 8, 18, 18, 0).getTime();

function row(id, fields = {}) {
  return {
    id, title: `Title of ${id}`, hold_reason: null, current_role: "done", state: "done", captain_actionable: false,
    kind: "ship", repo: "resonance", hold_kind: null, since: "2026-09-01", completion: { verb: "merged", date: "2026-09-18" },
    pr_url: null, report_path: null, body_lines: [], body_excerpt: null, ...fields,
  };
}

function call(id, answer, fields = {}) {
  return { id, title: `Title of ${id}`, question: "Which?", options: [], on_answer: "done", state: "closed", evidence: [], answer, decided: null, ...fields };
}

const captain = (label, key = label) => ({ key, label, by: "captain", via: "quarterdeck", at: "2026-09-18T10:00:00Z" });

test("a closed row says what it delivered", () => {
  assert.equal(logKind(row("a", { pr_url: "https://github.com/o/r/pull/6" }), null), "shipped");
  assert.equal(logKind(row("b", { completion: { verb: "landed", date: "2026-09-18" } }), null), "shipped");
  assert.equal(logKind(row("c", { kind: "scout", report_path: "data/c/report.md", completion: { verb: "reported", date: "2026-09-18" } }), null), "report");
  assert.equal(logKind(row("d", { kind: "captain", hold_kind: "captain", completion: { verb: "done", date: "2026-09-18" } }), null), "decision");
  assert.equal(logKind(row("e", { completion: { verb: "done", date: "2026-09-18" } }), null), "closed");
});

test("work a call released and then merged is shipped, and keeps its call", () => {
  const released = call("ship-x", captain("titles"));
  const [entry] = logEntries([row("ship-x", { hold_kind: "captain", pr_url: "https://github.com/o/r/pull/9" })], [], [released], "resonance");
  assert.equal(entry.kind, "shipped");
  assert.equal(entry.call, released);
  // A question row stays a decision whatever verb closed it.
  assert.equal(logKind(row("q", { kind: "captain", completion: { verb: "merged", date: "2026-09-18" } }), null), "decision");
});

test("the logbook keeps one project, each row once, newest day first", () => {
  const history = [
    row("old", { completion: { verb: "merged", date: "2026-08-02" } }),
    row("same-day-first", { completion: { verb: "merged", date: "2026-09-10" } }),
    row("same-day-second", { completion: { verb: "merged", date: "2026-09-10" } }),
    row("elsewhere", { repo: "foreman" }),
    row("queued", { state: "queued", completion: { verb: null, date: null } }),
  ];
  const recent = [row("just-now", { completion: { verb: "merged", date: "2026-09-18" } }), row("same-day-first", { completion: { verb: "merged", date: "2026-09-10" } })];
  const ids = logEntries(history, recent, [], "resonance").map((entry) => entry.id);
  assert.deepEqual(ids, ["just-now", "same-day-first", "same-day-second", "old"]);
});

test("a row with no date sorts last and keeps its place among the undated", () => {
  const ids = logEntries([row("u1", { completion: { verb: "merged", date: null } }), row("d", {}), row("u2", { completion: { verb: "merged", date: "yesterday" } })], [], [], "resonance").map((entry) => entry.id);
  assert.deepEqual(ids, ["d", "u1", "u2"]);
});

test("filters, search, and closed rows only on request", () => {
  const entries = logEntries([
    row("ship", { pr_url: "https://github.com/o/r/pull/1", title: "Caption fix" }),
    row("scout", { kind: "scout", report_path: "data/scout/report.md", completion: { verb: "reported", date: "2026-09-18" }, title: "Lifecycle audit" }),
    row("q", { kind: "captain", hold_kind: "captain", completion: { verb: "done", date: "2026-09-18" }, title: "What follows lifecycle" }),
    row("gone", { completion: { verb: "done", date: "2026-09-18" }, title: "Abandoned spike" }),
  ], [], [call("q", captain("AI titles", "titles"))], "resonance");
  assert.deepEqual(filterLog(entries, "all", "", false).map((entry) => entry.id), ["ship", "scout", "q"]);
  assert.deepEqual(filterLog(entries, "all", "", true).map((entry) => entry.id), ["ship", "scout", "q", "gone"]);
  assert.deepEqual(filterLog(entries, "decision", "", false).map((entry) => entry.id), ["q"]);
  // The search reads the answer as well as the title.
  assert.deepEqual(filterLog(entries, "all", "ai titles", false).map((entry) => entry.id), ["q"]);
  assert.deepEqual(filterLog(entries, "all", "LIFECYCLE", false).map((entry) => entry.id), ["scout", "q"]);
  assert.deepEqual(logCounts(entries, false), { all: 3, shipped: 1, report: 1, decision: 1, closed: 1 });
  assert.equal(logCounts(entries, true).all, 4);
});

test("periods: this week, then each month, then undated", () => {
  const entries = logEntries([
    row("today", { completion: { verb: "merged", date: "2026-09-18" } }),
    row("six-days", { completion: { verb: "merged", date: "2026-09-12" } }),
    row("seven-days", { completion: { verb: "merged", date: "2026-09-11" } }),
    row("august", { completion: { verb: "merged", date: "2026-08-30" } }),
    row("last-year", { completion: { verb: "merged", date: "2025-12-01" } }),
    row("undated", { completion: { verb: "merged", date: null } }),
  ], [], [], "resonance");
  const periods = logPeriods(entries, NOW).map((group) => [group.id, group.entries.map((entry) => entry.id)]);
  assert.deepEqual(periods, [
    ["week", ["today", "six-days"]],
    ["2026-9", ["seven-days"]],
    ["2026-8", ["august"]],
    ["2025-12", ["last-year"]],
    ["undated", ["undated"]],
  ]);
  assert.match(logPeriods(entries, NOW)[3].title, /2025/);
  assert.doesNotMatch(logPeriods(entries, NOW)[2].title, /2026/);
});

test("the outcome line names who chose what", () => {
  const [mine] = logEntries([row("q", { kind: "captain", completion: { verb: "done", date: "2026-09-18" } })], [], [call("q", captain("AI titles", "titles"))], "resonance");
  assert.match(outcomeLine(mine, NOW), /^You chose AI titles · Sep 18$/);
  const [theirs] = logEntries([row("q", { kind: "captain", completion: { verb: "done", date: "2026-09-18" } })], [], [call("q", { ...captain("Numbered"), by: "firstmate" })], "resonance");
  assert.match(outcomeLine(theirs, NOW), /^The first mate chose Numbered/);
  const [decided] = logEntries([row("q", { kind: "captain", completion: { verb: "done", date: "2026-09-18" } })], [], [call("q", { ...captain("x"), by: "firstmate" }, { decided: { what: "Keep going", why: "cheap" } })], "resonance");
  assert.match(outcomeLine(decided, NOW), /^Decided for you · Sep 18$/);
  const [merged] = logEntries([row("s", { pr_url: "https://github.com/o/r/pull/1" })], [], [], "resonance");
  assert.equal(outcomeLine(merged, NOW), "Merged Sep 18");
  const [old] = logEntries([row("s", { completion: { verb: "reported", date: "2025-03-02" }, kind: "scout", report_path: "r.md" })], [], [], "resonance");
  assert.match(outcomeLine(old, NOW), /2025/);
});

test("up next is the project's queue without calls waiting on the captain", () => {
  const records = [
    row("next", { state: "queued", completion: { verb: null, date: null } }),
    row("waiting", { state: "queued", captain_actionable: true, hold_kind: "captain" }),
    row("released", { state: "queued", hold_kind: "captain" }),
    row("other", { state: "queued", repo: "foreman" }),
    row("flying", { state: "in_flight" }),
  ];
  assert.deepEqual(upNext(records, "resonance").map((record) => record.id), ["next", "released"]);
});

test("a call belongs to its own row's project, else its origin's", () => {
  const records = new Map([["q", row("q", { repo: "demo" })], ["scout", row("scout", { repo: "resonance" })]]);
  assert.equal(callProject(call("q", null), records), "demo");
  assert.equal(callProject(call("new", null, { origin: "scout" }), records), "resonance");
  assert.equal(callProject(call("lost", null), records), null);
  assert.equal(callProject(call("about-it", null, { about: "q", origin: "scout" }), records), "demo");
  // A row with no project says nothing, so the next place is asked.
  assert.equal(callProject(call("bare", null, { origin: "scout" }), new Map([["bare", row("bare", { repo: null })], ...records])), "resonance");
});

test("what landed in a window counts delivered work, and says when it is a floor", () => {
  const entries = logEntries([
    row("shipped-today"),
    row("reported", { kind: "scout", report_path: "data/r/report.md", completion: { verb: "reported", date: "2026-09-10" } }),
    row("answered", { kind: "captain", hold_kind: "captain", completion: { verb: "done", date: "2026-09-12" } }),
    row("dropped", { completion: { verb: "done", date: "2026-09-12" } }),
    row("too-old", { completion: { verb: "merged", date: "2026-08-01" } }),
  ], [], [], "resonance");
  assert.deepEqual(landedWithin(entries, 30, NOW, "none"), { count: 2, floor: false });
  // Older rows unread, but the oldest read is already outside the window: nothing unread can count.
  assert.deepEqual(landedWithin(entries, 30, NOW, "older"), { count: 2, floor: false });
  // The oldest read is inside the window, so older unread rows might count too.
  assert.deepEqual(landedWithin(entries.slice(0, 4), 30, NOW, "older"), { count: 2, floor: true });
  // History not read yet, or it could not be: only the snapshot's recent rows counted, so any unread row might count.
  const snapshotOnly = logEntries([], [row("recent-shipped"), row("recent-old", { completion: { verb: "merged", date: "2026-08-01" } })], [], "resonance");
  assert.deepEqual(landedWithin(snapshotOnly, 30, NOW, "any"), { count: 1, floor: true });
  assert.deepEqual(landedWithin([], 30, NOW, "any"), { count: 0, floor: true });
  // The window's first day counts whole: 30 days back from Sep 18 starts on Aug 20.
  const edge = logEntries([row("edge", { completion: { verb: "merged", date: "2026-08-20" } }), row("outside", { completion: { verb: "merged", date: "2026-08-19" } })], [], [], "resonance");
  assert.equal(landedWithin(edge, 30, NOW, "none").count, 1);
});
