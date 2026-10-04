// Unit tests for src/pipeline.ts, which reads a task's pipeline status from the snapshot, and for the `?pipeline` mock
// it is reviewed against.
//
//   pnpm test
//
// Node runs the TypeScript modules directly, types stripped, so this needs no build. The last test also runs the
// engine's own "waiting on" fold (engine/bin/fm-waiting-on-lib.sh, through bash and jq) over every mock task, so the
// mock can never show a holder the engine would not name.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mockPipeline, PIPELINE_CASES } from "../src/host/mock-pipeline.ts";
import { chipOf, fixRound, gateLine, hasRail, headline, howItShips, prLine, railNote, railOf, readAge, sourceLine, STEPS, waitingOf } from "../src/pipeline.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pipeline = (fields = {}) => ({
  applies: true, reason: null, read: "full", run: null, steps: null, active: null, gate: null, findings: null, ci: null, pr: null, daemon: "not_probed", ...fields,
});
const steps = (code) => STEPS.map((step, index) => ({
  step, status: { c: "completed", s: "skipped", r: "running", f: "fixing", a: "awaiting_approval", x: "failed", k: "cancelled", ".": "pending" }[code[index]], findings: 0, duration_ms: 0,
}));
const task = (fields = {}) => ({
  id: "t1", kind: "ship", harness: "claude", mode: "no-mistakes", yolo: "off", project: "/home/projects/resonance", backend: "tmux",
  paths: { status_log: { present: true, last_event: { state: "working", note: "", raw: "" } }, worktree: { path: "/w", present: true }, report: { path: "/r", present: false } },
  current_state: { state: "working", source: "run-step", detail: "", raw: "", observed_at: "", freshness: "fresh" },
  endpoint: { target: "fm:t1", exists: true, agent_alive: "alive", status: "alive", observed_at: "", freshness: "fresh" },
  pr: { url: null, source: "absent" }, hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: "" },
  actions: { watch: "", steer: "", return_channel_note: null }, pipeline: pipeline(), ...fields,
});
const cells = (p) => railOf(p).map((cell) => cell.state);

test("the holder is firstmate's own, and a firstmate that predates the fold has none", () => {
  assert.equal(waitingOf(task()), null);
  assert.equal(waitingOf(task({ waiting_on: { who: "somebody", why: "x", rule: 1, call: null } })), null, "a holder the app has no name for is not drawn");
  const waiting = waitingOf(task({ waiting_on: { who: "first_mate", why: "run failed at test", rule: 5, call: null } }));
  assert.deepEqual(waiting, { who: "first_mate", label: "First mate", tone: "amber", why: "run failed at test", rule: 5, call: null });
  assert.deepEqual(chipOf(task({ waiting_on: { who: "captain", why: "merge PR #35", rule: 2, call: null } })),
    { label: "You · merge PR #35", tone: "coral", title: "Waiting on you: merge PR #35" });
  assert.equal(waitingOf(task({ waiting_on: { who: "unknown", why: "nothing proves a holder", rule: 12, call: null } })).label, "Can't tell");
});

test("the rail draws each step as the run reports it", () => {
  assert.deepEqual(cells(pipeline({ run: { status: "running" }, steps: steps("csr......") })), ["completed", "skipped", "running", "pending", "pending", "pending", "pending", "pending", "pending"]);
  assert.equal(cells(pipeline({ run: { status: "awaiting_approval" }, steps: steps("csa......") }))[2], "parked");
  assert.equal(cells(pipeline({ run: { status: "completed", outcome: "failed" }, steps: steps("cscx.....") }))[3], "failed");
  assert.equal(cells(pipeline({ run: { status: "cancelled" }, steps: steps("csk......") }))[2], "cancelled");
});

test("CI green while the run waits, or after its monitor ended, is held for a merge, not done or failed", () => {
  assert.equal(cells(pipeline({ run: { status: "running" }, steps: steps("ccccccccr"), ci: "green" }))[8], "held");
  assert.equal(cells(pipeline({ run: { status: "failed", outcome: "failed" }, steps: steps("ccccccccx"), ci: "green" }))[8], "held");
  assert.equal(cells(pipeline({ run: { status: "completed", outcome: "passed" }, steps: steps("ccccccccc"), ci: "green" }))[8], "completed");
  assert.equal(cells(pipeline({ run: { status: "running" }, steps: steps("ccccccccr"), ci: "fixing" }))[8], "fixing");
  assert.equal(cells(pipeline({ run: { status: "running" }, steps: steps("ccccccccr"), ci: "rearmed" }))[8], "running", "a re-armed monitor is still running, never held");
});

test("a read that could not see the steps draws them unknown, and no run draws them pending", () => {
  assert.ok(cells(pipeline({ read: "coarse", run: { status: "running" } })).every((state) => state === "unknown"));
  assert.ok(cells(pipeline({ read: "unanswered" })).every((state) => state === "unknown"));
  assert.ok(cells(pipeline({ run: { status: "running" }, steps: null })).every((state) => state === "unknown"), "a run with no steps table is unknown, not pending");
  assert.ok(cells(pipeline({ read: "none" })).every((state) => state === "pending"));
  assert.equal(railOf(pipeline({ read: "none" })).length, 9);
});

test("a scout, a direct-PR and a local-only task say how they ship and draw no rail", () => {
  for (const reason of ["scout", "direct-PR", "local-only"]) {
    const t = task({ kind: reason === "scout" ? "scout" : "ship", pipeline: pipeline({ applies: false, reason, read: "none" }) });
    assert.equal(hasRail(t.pipeline), false, reason);
    assert.equal(howItShips(t).mode, reason);
  }
  assert.equal(hasRail(null), false);
  assert.equal(hasRail(undefined), false);
  assert.deepEqual(howItShips(task({ pipeline: pipeline({ read: "none" }) })), { mode: "no-mistakes", text: "Will validate through the pipeline." });
  assert.equal(howItShips(task({ pipeline: pipeline({ read: "unanswered" }) })), null, "a pipeline that did not answer is not promised as not started");
});

test("the headline is the holder's situation, in the captain's words, from the fields that were read", () => {
  const say = (fields, waiting_on, callTitle) => headline(task({ ...fields, waiting_on }), waitingOf(task({ waiting_on })), callTitle);
  assert.equal(say({ pipeline: pipeline({ run: { status: "fixing" }, active: { step: "review", active_for: "12m3s", last_activity: "8s", quiet: false, round: "auto-fix 1/3" } }) }, { who: "pipeline", why: "", rule: 8, call: null }),
    "Fixing review findings. Fix round 1 of 3.");
  assert.equal(say({ pipeline: pipeline({ run: { status: "running" }, active: { step: "test", active_for: "42m8s", last_activity: "quiet 31m2s", quiet: true, round: null } }) }, { who: "pipeline", why: "", rule: 8, call: null }),
    "Testing, but nothing has come from the step for 31 minutes.");
  assert.equal(say({ pipeline: pipeline({ read: "coarse", run: { status: "running" } }) }, { who: "pipeline", why: "", rule: 8, call: null }), "Validating. Which step is not readable right now.");
  assert.equal(say({ pipeline: pipeline({ ci: "rearmed" }) }, { who: "ci", why: "", rule: 7, call: null }), "Checks were green, then main moved. Waiting for the monitor to read them again.");
  assert.equal(say({}, { who: "captain", why: "your call", rule: 1, call: "c1" }, "Ship it?"), "Your call: Ship it?");
  assert.equal(say({ pipeline: pipeline({ run: { status: "completed", outcome: "failed" }, steps: steps("cscx.....") }) }, { who: "first_mate", why: "", rule: 5, call: null }), "The run failed at test.");
  assert.equal(say({ pipeline: pipeline({ read: "coarse", daemon: "down", run: { status: "failed" } }) }, { who: "first_mate", why: "", rule: 5, call: null }),
    "The no-mistakes service is not answering. Its last record for this run is not proof the work failed.");
  assert.equal(say({ yolo: "on", pipeline: pipeline({ ci: "green" }) }, { who: "first_mate", why: "", rule: 2, call: null }), "Checks are green. The first mate holds merge authority for this task.");
  const unread = { url: "https://github.com/o/r/pull/37", state: "unknown", via: null };
  assert.equal(say({ pipeline: pipeline({ ci: "green", pr: unread }) }, { who: "captain", why: "", rule: 2, call: null }), "Checks are green. The PR state was not read. Merge authority is yours.");
  assert.equal(say({ yolo: "on", pipeline: pipeline({ ci: "green", pr: unread, run: { status: "completed", outcome: "failed" } }) }, { who: "first_mate", why: "", rule: 2, call: null }),
    "Checks were green when the pipeline stopped watching. The PR state was not read. The first mate holds merge authority for this task.");
  const gate = { step: "review", status: "awaiting_approval", parked_for: "2m" };
  assert.equal(say({ pipeline: pipeline({ gate, findings: { total: 1, ask_user: 1, rows: [] } }) }, { who: "first_mate", why: "", rule: 3, call: null }),
    "A finding needs an authority decision. The worker passed it to the first mate.");
  assert.equal(say({ hints: { pending_decision: true, blocked_event: true, open_decisions: [{ key: "d1", verb: "blocked" }], scout_report_present: false, last_event_text: "" }, pipeline: pipeline({ gate, findings: { total: 2, ask_user: 0, rows: [] } }) },
    { who: "first_mate", why: "blocked", rule: 3, call: null }), "The worker reported it is blocked. The first mate decides what happens next.");
  assert.equal(say({ pipeline: pipeline({ read: "unanswered" }) }, { who: "unknown", why: "", rule: 12, call: null }), "The pipeline did not answer, and nothing else proves who holds this.");
  assert.equal(say({ kind: "scout", pipeline: pipeline({ applies: false, reason: "scout" }) }, { who: "worker", why: "", rule: 9, call: null }), "Investigating. A scout writes a report and opens no PR.");
});

test("nothing claims a time the engine does not have", () => {
  const p = pipeline({ run: { status: "running" }, steps: steps("ccccccccr"), ci: "green", pr: { url: "https://github.com/o/r/pull/35", state: "open", via: "run" } });
  const line = prLine(task({ pipeline: p }));
  assert.deepEqual(line, { name: "PR #35", url: "https://github.com/o/r/pull/35", state: "open", detail: "checks green" });
  assert.doesNotMatch(JSON.stringify(line), /since|\d{1,2}:\d{2}/);
  assert.equal(prLine(task({ pipeline: pipeline({ pr: { url: "https://github.com/o/r/pull/37", state: "unknown", via: null }, ci: "green" }) })).detail, "ci monitor ended, last read green");
  assert.equal(prLine(task({ pipeline: pipeline({ pr: { url: "https://github.com/o/r/pull/28", state: "closed", via: "forge" } }) })).state, "closed, not merged");
  const direct = task({ pr: { url: "https://github.com/o/r/pull/38", source: "status_event" }, pipeline: pipeline({ applies: false, reason: "direct-PR" }) });
  assert.deepEqual(prLine(direct), { name: "PR #38", url: "https://github.com/o/r/pull/38", state: "state not read", detail: "checks not read for direct-PR" }, "a PR nothing read is never called open");
  assert.doesNotMatch(headline(direct, waitingOf({ ...direct, waiting_on: { who: "captain", why: "PR raised directly", rule: 2, call: null } })), /open/i);
  assert.equal(prLine(task()), null);
});

test("the gate, the rail's note and the footer say what was read and where it came from", () => {
  const parked = pipeline({ run: { status: "awaiting_approval" }, gate: { step: "review", status: "awaiting_approval", parked_for: "2m10s" }, findings: { total: 3, ask_user: 0, rows: [] } });
  assert.equal(gateLine(parked), "Parked at review for 2m10s · 3 findings, all the worker's");
  assert.equal(gateLine({ ...parked, findings: { total: 2, ask_user: 1, rows: [] } }), "Parked at review for 2m10s · 2 findings, 1 ask-user");
  assert.equal(gateLine({ ...parked, findings: { total: 1, ask_user: null, rows: [] } }), "Parked at review for 2m10s · 1 finding", "an unknown split says nothing about it");
  assert.equal(gateLine(pipeline()), null);
  assert.equal(railNote(pipeline({ run: { status: "running" }, active: { step: "review", active_for: "4m12s", last_activity: "8s", quiet: false, round: null } })).text, "review · 4m12s · last activity 8s ago");
  assert.deepEqual(railNote(pipeline({ run: { status: "running" }, active: { step: "test", active_for: "42m8s", last_activity: "quiet 31m2s", quiet: true, round: null } })), { text: "test · 42m8s", quiet: "quiet 31m2s" });
  assert.equal(railNote(pipeline()).text, "Not started. No run is bound to this branch yet.");
  assert.match(railNote(pipeline({ read: "unanswered" })).text, /did not answer/);
  assert.equal(sourceLine(task({ pipeline: pipeline({ run: { id: "01M3H2QK7A", head: "c7f19291a0b4", status: "running", outcome: null } }) })), "no-mistakes run 01M3H2… · head c7f19291");
  assert.equal(sourceLine(task({ pipeline: pipeline({ read: "coarse", run: { status: "running" } }) })), "no-mistakes runs ledger only");
  assert.equal(sourceLine(task({ pipeline: pipeline({ read: "unanswered" }) })), "no-mistakes did not answer");
  assert.equal(sourceLine(task({ pipeline: pipeline({ read: "none" }), current_state: { state: "done", source: "status-log", detail: "", raw: "" },
    paths: { status_log: { present: true, last_event: { state: "done", note: "", raw: "done: PR https://github.com/o/r/pull/38" } }, worktree: { path: "", present: true }, report: { path: "", present: false } } })), "worker said done: PR …/pull/38");
  const paused = task({ pipeline: pipeline({ read: "none" }), current_state: { state: "paused", source: "status-log", detail: "waiting for the rate limit to reset", raw: "" },
    paths: { status_log: { present: true, last_event: { state: "paused", note: "waiting for the rate limit to reset", raw: "paused: waiting for the rate limit to reset" } }, worktree: { path: "", present: true }, report: { path: "", present: false } },
    waiting_on: { who: "external", why: "waiting for the rate limit to reset", rule: 10, call: null } });
  const drawn = [headline(paused, waitingOf(paused)), sourceLine(paused, waitingOf(paused))].join(" ");
  assert.equal(drawn.split("waiting for the rate limit to reset").length - 1, 1, "the drawer quotes a declared pause reason once");
  assert.equal(chipOf(paused).label.split("waiting for the rate limit to reset").length - 1, 1, "the chip shows it once");
  assert.equal(fixRound("auto-fix 2/3"), "Fix round 2 of 3");
  assert.equal(fixRound(null), null);
  assert.deepEqual([readAge(12_000), readAge(240_000), readAge(7_500_000)], ["12s", "4m", "2h 5m"]);
});

test("every mock task's holder is the one the engine's own fold names", () => {
  const { tasks, calls } = mockPipeline("/home", {
    row: (id, title, fields) => ({ id, title, ...fields }),
    worker: (id, kind, state) => task({ id, kind, current_state: { state, source: "none", detail: "", raw: "", observed_at: "", freshness: "fresh" } }),
  });
  assert.equal(tasks.length, PIPELINE_CASES.length);
  const folded = JSON.parse(execFileSync("bash", ["-c", '. "$1"; jq -c --argjson calls "$2" "$FM_WAITING_ON_JQ_DEFS"\'map({id, waiting_on: waiting_on($calls)})\'', "_",
    join(root, "engine/bin/fm-waiting-on-lib.sh"), JSON.stringify(calls)], { input: JSON.stringify(tasks) }).toString());
  for (const item of folded) {
    const mocked = tasks.find((entry) => entry.id === item.id).waiting_on;
    assert.deepEqual(mocked, item.waiting_on, `${item.id}: the mock says ${JSON.stringify(mocked)}, the engine ${JSON.stringify(item.waiting_on)}`);
  }
});
