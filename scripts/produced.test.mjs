// Unit tests for src/produced.ts, which reads what a task produced: its pages and where each stands, its report, and
// its PR, what waits on the captain first, and the one chip its row carries.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { outputChip, pageSays, prNumber, taskOutput, waitsOnCaptain } from "../src/produced.ts";

const at = (minutesAgo) => new Date(Date.parse("2026-09-27T08:00:00Z") - minutesAgo * 60_000).toISOString();

/** A page `task` presented, in `revs` revisions, the newest `minutesAgo` minutes ago. */
function page(task, name, minutesAgo, revs = 1) {
  const revisions = Array.from({ length: revs }, (_, index) => ({
    scope: "task", task, name, rev: index + 1, title: name, note: null, entry: `${name}.html`, bytes: 1, presented_at: at(minutesAgo + (revs - 1 - index) * 10),
    presented_by: { role: "crew", task },
  }));
  return { scope: "task", task, name, title: name, latest: revisions.at(-1), revisions };
}

function worker(id, fields = {}) {
  return {
    id, kind: "scout", harness: "claude", mode: "", yolo: "", project: "/home/projects/resonance", backend: "tmux",
    paths: { status_log: { present: true, last_event: { state: "working", note: "", raw: "" } }, worktree: { path: "", present: true }, report: { path: `/home/data/${id}/report.md`, present: false } },
    current_state: { state: "working", source: "pane", detail: "", raw: "", observed_at: at(0), freshness: "fresh" },
    endpoint: { target: "", exists: true, agent_alive: "alive", status: "alive", observed_at: at(0), freshness: "fresh" },
    pr: { url: null, source: "none" }, hints: {}, actions: {}, ...fields,
  };
}

const row = (id, fields = {}) => ({ id, title: id, hold_reason: null, current_role: "in_flight", state: "in_flight", kind: "scout", ...fields });

function call(id, evidence, fields = {}) {
  return { id, title: id, question: null, options: [], on_answer: "done", state: "open", captain_actionable: true, evidence, answer: null, decided: null, ...fields };
}

const seen = (rev, fields = {}) => ({ seen_rev: rev, draft_count: 0, open_count: 0, answered: [], open_threads: [], ...fields });

function output(id, { record = row(id), work, artifacts = [], reviews = {}, calls = [], backlog } = {}) {
  return taskOutput({ id, record, worker: work, artifacts, reviews, calls, backlog: backlog ?? new Map([[id, record]]) });
}

const kinds = (items) => items.map((item) => item.kind === "page" ? `page:${item.artifact.name}` : item.kind);

test("a task that produced nothing has nothing to show and no chip", () => {
  const items = output("t");
  assert.deepEqual(items, []);
  assert.equal(outputChip(items), null);
  assert.equal(waitsOnCaptain(items), false);
});

test("pages come newest first, and the one that waits on the captain leads", () => {
  const older = page("t", "older", 90);
  const newer = page("t", "newer", 10);
  // Both read: newest first.
  assert.deepEqual(kinds(output("t", { artifacts: [older, newer], reviews: { "task/t/older": seen(1), "task/t/newer": seen(1) } })), ["page:newer", "page:older"]);
  // The older one is unread: it leads.
  const items = output("t", { artifacts: [older, newer], reviews: { "task/t/newer": seen(1) } });
  assert.deepEqual(kinds(items), ["page:older", "page:newer"]);
  assert.equal(items[0].needsYou, true);
  assert.equal(items[1].needsYou, false);
  assert.equal(waitsOnCaptain(items), true);
});

test("another task's pages and chat pages are not this task's", () => {
  const chat = { ...page("t", "board", 5), scope: "chat", task: null };
  assert.deepEqual(output("t", { artifacts: [page("other", "theirs", 5), chat] }), []);
});

test("a page says what is new since the captain looked, and what it asks of him", () => {
  const plan = page("t", "plan", 5, 3);
  plan.revisions[2].answers = { addressed: ["t1"], replies: [] };
  const says = (review, calls = []) => output("t", { artifacts: [plan], reviews: review ? { "task/t/plan": review } : {}, calls })[0].says;
  assert.deepEqual(says(undefined), ["Not looked at yet"]);
  assert.deepEqual(says(seen(2)), ["New since you looked"]);
  assert.deepEqual(says(seen(3)), ["Seen · nothing new"]);
  assert.deepEqual(says(seen(3, { open_threads: [{ id: "t1", rev: 2 }, { id: "t2", rev: 3 }], open_count: 2 })), ["1 of your comments answered", "1 comment with the author"]);
  assert.deepEqual(says(seen(3, { draft_count: 2 })), ["2 comments not sent"]);
  assert.deepEqual(says(seen(3), [call("c1", ["page:task/t/plan"]), call("c2", ["page:task/t/plan"], { state: "closed" })]), ["argues 1 call"]);
});

test("a page whose task landed is settled, and says so", () => {
  const record = row("t", { state: "done" });
  const [item] = output("t", { record, artifacts: [page("t", "plan", 5)] });
  assert.equal(item.standing, "settled");
  assert.equal(item.needsYou, false);
  assert.deepEqual(item.says, ["Settled"]);
  assert.deepEqual(pageSays(item.artifact, seen(1, { draft_count: 1 }), "settled", []), ["1 comment not sent"]);
});

test("a report is listed only when the task presented no page, from its worker or its row", () => {
  const work = worker("t", { paths: { ...worker("t").paths, report: { path: "/home/data/t/report.md", present: true } } });
  assert.deepEqual(kinds(output("t", { work })), ["report"]);
  assert.deepEqual(kinds(output("t", { record: row("t", { state: "done", report_path: "/home/data/t/report.md" }) })), ["report"]);
  // A page is how a report is presented, so one with a page is read there.
  assert.deepEqual(kinds(output("t", { work, artifacts: [page("t", "plan", 5)], reviews: { "task/t/plan": seen(1) } })), ["page:plan"]);
  // The worker's own word wins over the row's.
  const absent = worker("t");
  assert.equal(output("t", { work: absent, record: row("t", { report_path: "/old/report.md" }) })[0].path, "/old/report.md");
});

test("a report waits on the captain while its scout has finished and the row is open, or a call it argues waits on him", () => {
  const withReport = (state) => worker("t", { current_state: { ...worker("t").current_state, state }, paths: { ...worker("t").paths, report: { path: "/home/data/t/report.md", present: true } } });
  assert.equal(output("t", { work: withReport("working") })[0].needsYou, false);
  assert.equal(output("t", { work: withReport("done") })[0].needsYou, true);
  // Closed by the backlog: read.
  assert.equal(output("t", { work: withReport("done"), record: row("t", { state: "done" }) })[0].needsYou, false);
  // A ship's report is not a scout's finding.
  assert.equal(output("t", { work: { ...withReport("done"), kind: "ship" } })[0].needsYou, false);
  const argued = output("t", { work: withReport("working"), calls: [call("c", ["report:t"])] })[0];
  assert.equal(argued.needsYou, true);
  assert.deepEqual(argued.calls.map((item) => item.id), ["c"]);
  // A call the captain has replied to waits on the first mate, not on him; a closed call argues nothing now.
  assert.equal(output("t", { work: withReport("working"), calls: [call("c", ["report:t"], { reply: { words: "why?", via: "chat", at: at(1), message: null } })] })[0].needsYou, false);
  assert.equal(output("t", { work: withReport("working"), calls: [call("c", ["report:t"], { state: "closed" })] })[0].calls.length, 0);
});

test("a PR comes last, from the worker or the row, and waits on no one", () => {
  const work = worker("t", { kind: "ship", pr: { url: "https://github.com/o/r/pull/33", source: "status-log" } });
  const items = output("t", { work, artifacts: [page("t", "plan", 5)] });
  assert.deepEqual(kinds(items), ["page:plan", "pr"]);
  assert.deepEqual(items[1], { kind: "pr", url: "https://github.com/o/r/pull/33", number: "33", merged: false });
  const landed = output("t", { record: row("t", { state: "done", pr_url: "https://github.com/o/r/pull/6", completion: { verb: "merged", date: "2026-09-20" } }) });
  assert.equal(landed[0].merged, true);
  assert.equal(waitsOnCaptain(landed), false);
});

test("a PR's number is read only from a URL that names one", () => {
  assert.equal(prNumber("https://github.com/o/r/pull/31"), "31");
  assert.equal(prNumber("https://github.com/o/r/pull/31/files"), "31");
  assert.equal(prNumber("https://gitlab.com/o/r/-/merge_requests/4"), null);
  assert.equal(prNumber("https://github.com/o/r/pull/31x"), null);
});

test("the row's chip is strong for what waits on the captain and quiet for what is only there to open", () => {
  const plan = page("t", "plan", 5, 3);
  assert.deepEqual(pick(outputChip(output("t", { artifacts: [plan] }))), { strong: true, label: "Page to review · rev 3", opens: "page" });
  assert.deepEqual(pick(outputChip(output("t", { artifacts: [page("t", "plan", 5)] }))), { strong: true, label: "Page to review", opens: "page" });
  const read = { "task/t/plan": seen(3) };
  assert.deepEqual(pick(outputChip(output("t", { artifacts: [plan], reviews: read }))), { strong: false, label: "Page · rev 3", opens: "page" });
  assert.deepEqual(pick(outputChip(output("t", { artifacts: [plan, page("t", "sizes", 50)], reviews: { ...read, "task/t/sizes": seen(1) } }))), { strong: false, label: "2 pages", opens: "page" });
  // A page that asks nothing gives way to the PR; one that waits on the captain does not.
  const pr = worker("t", { kind: "ship", pr: { url: "https://github.com/o/r/pull/33", source: "status-log" } });
  assert.deepEqual(pick(outputChip(output("t", { work: pr, artifacts: [plan], reviews: read }))), { strong: false, label: "PR #33", opens: "pr" });
  assert.deepEqual(pick(outputChip(output("t", { work: pr, artifacts: [plan] }))), { strong: true, label: "Page to review · rev 3", opens: "page" });
  const report = worker("t", { paths: { ...worker("t").paths, report: { path: "/r.md", present: true } } });
  assert.deepEqual(pick(outputChip(output("t", { work: report }))), { strong: false, label: "Report", opens: "report" });
  assert.deepEqual(pick(outputChip(output("t", { work: report, calls: [call("c", ["report:t"])] }))), { strong: true, label: "Report to read", opens: "report" });
});

function pick(chip) {
  return chip && { strong: chip.strong, label: chip.label, opens: chip.opens.kind };
}
