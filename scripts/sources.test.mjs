// Unit tests for src/sources.ts, how every screen reads work from other task systems.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedSinceFiled, chipText, divergence, firstWords, linkViews, offerRows, policyLine, readingProblem, sourcesOf, takeOnPhase, upstreamLines } from "../src/sources.ts";

const NOW = Date.parse("2026-09-25T18:00:00Z");
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

function item(n, fields = {}) {
  return { id: `I_${n}`, key: `#${n}`, url: `https://github.com/o/r/issues/${n}`, title: `Issue ${n}`, body: "Body", state: "open", state_name: "open", assignee: null, updated_at: iso(60), deleted: false, matches: true, seen_at: iso(3), filed: null, ...fields };
}

function filed(n, task, fields = {}) {
  return { item: `I_${n}`, key: `#${n}`, url: `https://github.com/o/r/issues/${n}`, title: `Issue ${n}`, body: "Body", state: "open", state_name: "open", assignee: null, updated_at: iso(90), filed_at: iso(80), task, ...fields };
}

function source(fields = {}) {
  return {
    id: "github:o/r", provider: "github", locator: "o/r", project: "demo", filter: "label:quarterdeck", outbound: "comments", review_state: null, added: iso(999),
    identity: "me", can: { read: true, comment: true, advance: false }, reach: ["o/r"], last_read: iso(3), reading_more: false, stale: false, failure: null,
    items: {}, filed: {}, offers: [], outbox: [], sent: [], events: [], ...fields,
  };
}

function row(id, fields = {}) {
  return { id, title: `Task ${id}`, hold_reason: null, current_role: "queued", state: "queued", repo: "demo", body_lines: [], ...fields };
}

const link = (n, fields = {}) => ({ source: "github:o/r", item: `I_${n}`, role: "fulfills", ...fields });

test("the snapshot's sources, its reason when they cannot be read, and nothing from a home that predates them", () => {
  const read = sourcesOf({ sources: { first_milestone: "in-review", sources: [source()] } });
  assert.deepEqual(read.sources.map((one) => one.id), ["github:o/r"]);
  assert.equal(read.firstMilestone, "in-review");
  assert.deepEqual(sourcesOf({ sources: { error: "config/sources.json is not an fm-sources.v1 file" } }), { sources: [], problem: "config/sources.json is not an fm-sources.v1 file", firstMilestone: null });
  assert.deepEqual(sourcesOf({}), { sources: [], problem: null, firstMilestone: null });
});

test("a linked task's chip names the item, its state and how fresh the reading is, or that its source is not here", () => {
  const two = item(2);
  const views = linkViews(row("t-1", { source_links: [link(2), { source: "linear:acme", item: "u-1", role: "contributes" }] }), [source({ items: { I_2: two } })]);
  assert.equal(chipText(views[0], NOW), "GitHub #2 open · as last read 3 min ago");
  assert.equal(chipText(views[1], NOW), "linear:acme · not connected in this home");
  // The source was read just now, but it lists only what changed: the item is dated by its own last read.
  const old = linkViews(row("t-1", { source_links: [link(2)] }), [source({ items: { I_2: item(2, { seen_at: iso(3 * 24 * 60) }) }, last_read: iso(1) })]);
  assert.equal(chipText(old[0], NOW), "GitHub #2 open · as last read 3 d ago");
  const closed = linkViews(row("t-1", { source_links: [link(2)] }), [source({ items: { I_2: item(2, { state: "done", state_name: "closed (completed)" }) } })]);
  assert.equal(chipText(closed[0], NOW), "GitHub #2 closed · as last read 3 min ago");
  const onlyFiled = linkViews(row("t-1", { source_links: [link(2)] }), [source({ filed: { I_2: { item: "I_2", key: "#2", url: "", title: "", body: "", state: "open", state_name: "open", assignee: null, updated_at: iso(99), filed_at: iso(120), task: "t-1" } } })]);
  assert.equal(chipText(onlyFiled[0], NOW), "GitHub #2 open · as filed 2 h ago, not read since");
});

test("a key that changed upstream shows on the chip, because only the id is stored", () => {
  const moved = linkViews(row("t-1", { source_links: [link(3)] }), [source({ items: { I_3: item(3, { key: "OPS-9" }) } })]);
  assert.equal(chipText(moved[0], NOW), "GitHub OPS-9 open · as last read 3 min ago");
});

test("one slow read says nothing; a typed failure says so only once it has persisted, in the captain's terms", () => {
  assert.equal(readingProblem(source(), NOW), null);
  assert.equal(readingProblem(source({ failure: { code: "network", detail: "no route", first_at: iso(5), last_at: iso(5), count: 1, retry_at: null, woke: false } }), NOW), null);
  const limited = readingProblem(source({ last_read: iso(42), failure: { code: "rate_limited", detail: "", first_at: iso(40), last_at: iso(1), count: 8, retry_at: new Date(NOW + 20 * 60_000).toISOString(), woke: true } }), NOW);
  assert.match(limited.title, /^GitHub is rate limiting this Mac until /);
  assert.match(limited.detail, /nothing is lost, and reading resumes on its own/);
  const refused = readingProblem(source({ outbox: [{ write_id: "w", item: "I_9", task: "t-9", intent: "delivered", created: iso(70), attempts: 0, last_error: null }], failure: { code: "auth", detail: "HTTP 401", first_at: iso(93), last_at: iso(1), count: 18, retry_at: null, woke: true } }), NOW);
  assert.match(refused.title, /^GitHub refused the sign-in at /);
  assert.match(refused.detail, /One write is waiting; it goes once/);
  assert.match(refused.detail, /gh auth login/);
  assert.match(readingProblem(source({ last_read: iso(45) }), NOW).title, /^GitHub has not been read for 45 minutes$/);
});

test("an item closed, cancelled or deleted upstream is told, and only work in flight asks for a decision", () => {
  const cancelled = (state) => linkViews(row("t-1", { state, source_links: [link(2)] }), [source({ items: { I_2: item(2, { state: "cancelled", state_name: "closed (not planned)" }) } })])[0];
  const working = divergence(cancelled("in_flight"), row("t-1", { state: "in_flight" }));
  assert.equal(working.tone, "amber");
  assert.equal(working.title, "#2 was cancelled on GitHub");
  assert.match(working.detail, /asks you if it should stop/);
  assert.equal(divergence(cancelled("queued"), row("t-1")).tone, "muted");
  assert.equal(divergence(cancelled("done"), row("t-1", { state: "done" })), null);
  const gone = linkViews(row("t-1", { source_links: [link(4)] }), [source({ items: { I_4: item(4, { deleted: true }) } })])[0];
  assert.equal(divergence(gone, row("t-1")).title, "#4 was deleted on GitHub");
});

test("an edit upstream shows beside what was filed; the filed copy is never replaced", () => {
  const same = linkViews(row("t-1", { source_links: [link(2)] }), [source({ items: { I_2: item(2, { filed: filed(2, "t-1") }) } })])[0];
  assert.equal(changedSinceFiled(same), false);
  const edited = linkViews(row("t-1", { source_links: [link(2)] }), [source({ items: { I_2: item(2, { body: "New body", filed: filed(2, "t-1") }) } })])[0];
  assert.equal(changedSinceFiled(edited), true);
  assert.equal(edited.filed.body, "Body");
});

test("the Upstream timeline: linked, what was written, what is owed and how it is going, and what the item did", () => {
  const view = linkViews(row("t-1", { source_links: [link(2)] }), [source({
    items: { I_2: item(2, { state: "done", updated_at: iso(5), filed: filed(2, "t-1") }) },
    sent: [
      { write_id: "a", item: "I_2", task: "t-1", intent: "in-review", pr: "https://github.com/o/r/pull/19", at: iso(60), advance: { result: "ambiguous", from: "In Progress", to: null, candidates: ["Code Review", "QA Review"] } },
      { write_id: "b", item: "I_2", task: "other", intent: "delivered", at: iso(50) },
    ],
    outbox: [{ write_id: "c", item: "I_2", task: "t-1", intent: "delivered", created: iso(20), attempts: 2, last_error: { code: "provider", detail: "unconfirmed", at: iso(10) } }],
  })])[0];
  const lines = upstreamLines(view, "t-1");
  assert.deepEqual(lines.map((line) => [line.tone, line.text]), [
    ["muted", "Linked to #2"],
    ["green", "Commented: the PR is up"],
    ["amber", 'Status left at "In Progress"'],
    ["coral", "Completion comment not confirmed"],
    ["muted", "Closed on GitHub"],
  ]);
  assert.match(lines[2].detail, /"Code Review", "QA Review", so none was chosen/);
  assert.match(lines[3].detail, /never posted twice/);
  const away = upstreamLines(linkViews(row("t-1", { source_links: [{ source: "linear:acme", item: "u-1", role: "fulfills" }] }), [])[0], "t-1");
  assert.match(away[0].detail, /not connected in this home/);
});

test("taking an item on follows the ask, and is filed only when a row links the item", () => {
  const base = { records: [], asks: {}, deliveries: {}, runtime: "idle", sendReady: true, quietSince: NOW - 120_000, snapshotAt: NOW };
  assert.equal(takeOnPhase("github:o/r", "I_1", base), "offered");
  assert.equal(takeOnPhase("github:o/r", "I_1", { ...base, sendReady: false }), "offline");
  const ask = (fields = {}) => ({ at: NOW - 60_000, kind: "take-on", task: null, item: { source: "github:o/r", id: "I_1", key: "#1" }, project: "demo", title: "Issue 1", note: null, message: "m-1", error: null, header: "", text: "", ...fields });
  assert.equal(takeOnPhase("github:o/r", "I_1", { ...base, asks: { "github:o/r I_1": ask({ message: null, error: "not running" }) } }), "not_sent");
  assert.equal(takeOnPhase("github:o/r", "I_1", { ...base, runtime: "prompt_turn", asks: { "github:o/r I_1": ask() }, deliveries: { "m-1": { status: "sent" } } }), "asked");
  assert.equal(takeOnPhase("github:o/r", "I_1", { ...base, asks: { "github:o/r I_1": ask() }, deliveries: { "m-1": { status: "picked_up", readAt: iso(0.5) } } }), "answered");
  const filedRow = row("demo-drawer-1", { source_links: [link(1)] });
  assert.equal(takeOnPhase("github:o/r", "I_1", { ...base, records: [filedRow], asks: { "github:o/r I_1": ask() }, deliveries: { "m-1": { status: "picked_up", readAt: iso(0.5) } } }), "filed");
});

test("a project's intake lists its sources' offers, newest first, and a row filed without an ask here is ordinary work", () => {
  const src = source({ items: { I_1: item(1, { updated_at: iso(300) }), I_2: item(2, { updated_at: iso(10) }), I_3: item(3) }, offers: ["I_1", "I_2", "I_3"] });
  const other = source({ id: "github:o/elsewhere", project: "elsewhere", items: { I_9: item(9) }, offers: ["I_9"] });
  const inputs = { records: [row("t-3", { source_links: [link(3)] })], asks: {}, deliveries: {}, runtime: "idle", sendReady: true, quietSince: null, snapshotAt: NOW };
  assert.deepEqual(offerRows("demo", [src, other], inputs, NOW).map((one) => [one.item.key, one.phase]), [["#2", "offered"], ["#1", "offered"]]);
  const asked = { ...inputs, asks: { "github:o/r I_3": { at: NOW - 60_000, kind: "take-on", task: null, item: { source: "github:o/r", id: "I_3", key: "#3" }, project: "demo", title: "", note: null, message: "m", error: null, header: "", text: "" } } };
  const rows = offerRows("demo", [src], asked, NOW);
  assert.deepEqual(rows.find((one) => one.item.key === "#3").filedAs.id, "t-3");
});

test("what a linked task will write upstream follows firstmate's own setting for when it first speaks", () => {
  const src = source({ sent: [{ write_id: "a", item: "I_2", task: "t-1", intent: "in-review", at: iso(10) }] });
  assert.equal(policyLine(src, row("t-2", { state: "in_flight" }), "I_2", "in-review").detail, "Nothing is said before there is a PR to point at.");
  assert.equal(policyLine(src, row("t-2", { state: "in_flight" }), "I_2", "started").detail, firstWords("started"));
  assert.equal(policyLine(src, row("t-1", { state: "in_flight" }), "I_2", "in-review").detail, "Next: one comment when it lands.");
  assert.equal(policyLine(source({ outbound: "none" }), row("t-1"), "I_2", "in-review").text, "Writes nothing back to GitHub");
});

test("a task whose completion comment is still owed never reads as owing nothing", () => {
  const owed = source({ outbox: [{ write_id: "c", item: "I_2", task: "t-1", intent: "delivered", created: iso(20), attempts: 2, last_error: { code: "provider", detail: "unconfirmed", at: iso(10) } }] });
  assert.equal(policyLine(owed, row("t-1", { state: "done" }), "I_2", "in-review").detail, "What is owed posts once, on a read that works.");
  const sent = source({ sent: [{ write_id: "c", item: "I_2", task: "t-1", intent: "delivered", at: iso(20) }] });
  assert.equal(policyLine(sent, row("t-1", { state: "done" }), "I_2", "in-review").detail, "Nothing more is owed.");
  assert.equal(policyLine(source(), row("t-1", { state: "done" }), "I_2", "in-review").detail, "It closed without landing, so nothing more is posted.");
  assert.equal(policyLine(source({ landed: ["t-1"] }), row("t-1", { state: "done" }), "I_2", "in-review").detail, "It landed: the completion comment is queued on the next read.");
});
