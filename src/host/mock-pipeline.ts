/**
 * `?pipeline`: a task in every pipeline state the approved mock draws, each in the engine's own shape: `pipeline` as
 * `bin/fm-crew-state.sh --json` reads it and `waiting_on` as `bin/fm-waiting-on-lib.sh` folds it. scripts/pipeline.test.mjs
 * runs that fold over every task here and checks it names the same holder, so this mock cannot claim a holder the
 * engine would not.
 *   (none)   every state, read moments ago
 *   `stale`  the same, but the newest fleet read failed, so what shows is the last good one
 */
import type { BacklogRecord, Call, FleetTask, TaskPipeline, WaitingOn } from "./types";

type Row = (id: string, title: string, fields: Partial<BacklogRecord>) => BacklogRecord;
type Worker = (id: string, kind: string, state: string, minutesAgo: number) => FleetTask;

const STEP_NAMES = ["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"];
const STATUS: Record<string, string> = { c: "completed", s: "skipped", r: "running", f: "fixing", a: "awaiting_approval", x: "failed", k: "cancelled", ".": "pending" };

/** The nine steps from one letter each: c completed, s skipped, r running, f fixing, a parked, x failed, k cancelled, . pending. */
function steps(code: string): TaskPipeline["steps"] {
  return STEP_NAMES.map((step, index) => {
    const status = STATUS[code[index] ?? "."];
    return { step, status, findings: 0, duration_ms: status === "completed" ? 60_000 * (index + 1) : 0 };
  });
}

const none: TaskPipeline = { applies: true, reason: null, read: "none", run: null, steps: null, active: null, gate: null, findings: null, ci: null, pr: null, daemon: "not_probed" };
const run = (id: string, status: string, outcome: string | null = null) => ({ id, head: "c7f19291a0b4", status, outcome });
const pr = (n: number, state: "open" | "merged" | "closed" | "unknown", via: NonNullable<TaskPipeline["pr"]>["via"]) => ({ url: `https://github.com/caomyer/quarterdeck/pull/${n}`, state, via });
const finding = (id: string, severity: string, action: string, description: string, file: string) => ({ id, severity, file, line: "", action, description });

/** One fixture: its row, how its worker reads, and what the engine read of its pipeline and folded from it. */
type Case = {
  id: string;
  title: string;
  kind?: string;
  mode?: string;
  yolo?: string;
  state: { state: string; source: string; detail: string };
  pipeline: TaskPipeline | null;
  waiting_on: WaitingOn;
  note?: string;
  pr?: string;
  decisions?: { key: string; verb: string; summary: string }[];
  report?: boolean;
};

const working = { state: "working", source: "run-step", detail: "validating (running)" };

export const PIPELINE_CALL = "qd-chat-calls-build-2-call";

export const PIPELINE_CASES: Case[] = [
  // Moving
  { id: "qd-usage-strip-2", title: "Usage strip in the footer", state: { state: "working", source: "pane", detail: "harness busy (claude-hook)" }, pipeline: none,
    waiting_on: { who: "worker", why: "implementing", rule: 9, call: null } },
  { id: "qd-tasklist-build-2", title: "Sortable task list", state: working,
    pipeline: { ...none, read: "full", run: run("01M3H2QK7A", "running"), steps: steps("csr......"), active: { step: "review", active_for: "4m12s", last_activity: "8s", quiet: false, round: null }, findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "pipeline", why: "review", rule: 8, call: null } },
  { id: "qd-contrib-noise-2", title: "Stop contribution false alarms", state: { state: "working", source: "run-step", detail: "validating (fixing)" },
    pipeline: { ...none, read: "full", run: run("01M3H7RT2C", "fixing"), steps: steps("csf......"), active: { step: "review", active_for: "12m3s", last_activity: "8s", quiet: false, round: "auto-fix 1/3" }, findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "pipeline", why: "review, auto-fix 1/3", rule: 8, call: null } },
  { id: "qd-attach-e2e-1", title: "Attach files end to end", state: working,
    pipeline: { ...none, read: "full", run: run("01M3HA0PZE", "running"), steps: steps("cscr....."), active: { step: "test", active_for: "42m8s", last_activity: "quiet 31m2s", quiet: true, round: null }, findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "pipeline", why: "test", rule: 8, call: null } },
  { id: "qd-pr-shots-2", title: "PR screenshots by file path", state: { state: "working", source: "run-step", detail: "validating (running)" },
    pipeline: { ...none, read: "full", run: run("01M3HB9WQF", "running"), steps: steps("cscccccc" + "r"), ci: "running", pr: pr(33, "open", "run"), findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "ci", why: "checks running", rule: 7, call: null } },
  { id: "qd-onboarding-3", title: "Onboarding checklist from bootstrap", state: working,
    pipeline: { ...none, read: "full", run: run("01M3HC4MNG", "running"), steps: steps("cscccccc" + "r"), ci: "rearmed", pr: pr(34, "open", "run"), findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "ci", why: "re-checking after main moved", rule: 7, call: null } },
  { id: "qd-replies-2", title: "Replies to calls in words", state: { state: "working", source: "run-step", detail: "validating (background run)" },
    pipeline: { ...none, read: "coarse", run: { id: null, head: null, status: "running", outcome: null } },
    waiting_on: { who: "pipeline", why: "validating, step not readable", rule: 8, call: null } },
  // Parked at a gate
  { id: "qd-call-evidence-3", title: "Link a call to everything that argues it", state: { state: "parked", source: "run-step", detail: "parked at review: 3 finding(s)" },
    pipeline: { ...none, read: "full", run: run("01M3HCV2KJ", "awaiting_approval"), steps: steps("csa......"), gate: { step: "review", status: "awaiting_approval", parked_for: "2m10s" },
      findings: { total: 3, ask_user: 0, rows: [finding("r1", "warning", "auto-fix", "ignored error from answerCall", "src/calls.ts"), finding("r2", "warning", "auto-fix", "missing key on mapped list", "src/CallCards.tsx"), finding("r3", "info", "auto-fix", "doc names a removed script", "AGENTS.md")] } },
    waiting_on: { who: "worker", why: "3 review findings", rule: 6, call: null } },
  { id: "qd-sessionctl-build-2", title: "Session controls in the composer", state: { state: "parked", source: "run-step", detail: "parked at review: 2 finding(s) (ask-user: authority decision)" },
    pipeline: { ...none, read: "full", run: run("01M3HD8XLM", "awaiting_approval"), steps: steps("csa......"), gate: { step: "review", status: "awaiting_approval", parked_for: "9m" },
      findings: { total: 2, ask_user: 1, rows: [finding("r1", "warning", "auto-fix", "unused import", "src/sessionctl.ts"), finding("r2", "error", "ask-user", "changes product behavior", "src-tauri/src/controls.rs")] } },
    decisions: [{ key: "nm-01M3HD-review", verb: "needs-decision", summary: "ask-user findings=r2" }],
    waiting_on: { who: "first_mate", why: "1 ask-user finding", rule: 3, call: null } },
  { id: "qd-chat-calls-build-2", title: "Captain's calls in the chat composer", state: { state: "parked", source: "run-step", detail: "parked at review: 1 finding(s) (ask-user: authority decision)" },
    pipeline: { ...none, read: "full", run: run("01M3HE1NPQ", "awaiting_approval"), steps: steps("csa......"), gate: { step: "review", status: "awaiting_approval", parked_for: "1h12m" },
      findings: { total: 1, ask_user: 1, rows: [finding("r1", "error", "ask-user", "a page may now sit below a newer message", "src/chatorder.ts")] } },
    waiting_on: { who: "captain", why: "your call", rule: 1, call: PIPELINE_CALL } },
  // Ready and landed
  { id: "qd-tasks-sort-2", title: "Sort the task list by start order", state: { state: "done", source: "run-step", detail: "checks green: PR ready for review (still monitoring for merge/close)" },
    pipeline: { ...none, read: "full", run: run("01M3HF6RST", "running"), steps: steps("cscccccc" + "r"), ci: "green", pr: pr(35, "open", "run"), findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "captain", why: "merge PR #35", rule: 2, call: null } },
  { id: "qd-routing-fix-1", title: "Crew routing keeps unknown keys", yolo: "on", state: { state: "done", source: "run-step", detail: "checks green: PR ready for review (still monitoring for merge/close)" },
    pipeline: { ...none, read: "full", run: run("01M3HG2UVW", "running"), steps: steps("cscccccc" + "r"), ci: "green", pr: pr(36, "open", "run"), findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "first_mate", why: "merge PR #36", rule: 2, call: null } },
  { id: "qd-voice-held-1", title: "Voice handover queue", state: { state: "done", source: "run-step", detail: "checks green: PR held for merge (ci monitor ended)" },
    pipeline: { ...none, read: "full", run: run("01M3HH7XYZ", "failed", "failed"), steps: steps("cscccccc" + "x"), ci: "green", pr: { ...pr(37, "unknown", null) }, findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "captain", why: "merge PR #37", rule: 2, call: null } },
  { id: "qd-contrib-noise-1", title: "Stop contribution observation false alarms", state: { state: "done", source: "run-step", detail: "run passed: PR merged" },
    pipeline: { ...none, read: "full", run: run("01M3GQHA9Q05RK4F1EJRRKTW1T", "completed", "passed"), steps: steps("csccccccc"), ci: "green", pr: pr(30, "merged", "receipt"), findings: { total: 1, ask_user: null, rows: [] } },
    waiting_on: { who: "none", why: "PR merged", rule: 11, call: null } },
  { id: "qd-call-evidence-1", title: "Evidence lines on call cards", state: { state: "done", source: "run-step", detail: "run passed: PR closed" },
    pipeline: { ...none, read: "full", run: run("01M3HJ3ABC", "completed", "passed"), steps: steps("csccccccc"), ci: "green", pr: pr(28, "closed", "forge"), findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "first_mate", why: "PR closed unmerged", rule: 5, call: null } },
  // Broken
  { id: "qd-history-page-2", title: "Page through a project's history", state: { state: "failed", source: "run-step", detail: "run failed" },
    pipeline: { ...none, read: "full", run: run("01M3HF0DEF", "completed", "failed"), steps: steps("cscx....."), findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "first_mate", why: "run failed at test", rule: 5, call: null } },
  { id: "qd-sessionctl-build-1", title: "Session controls, first attempt", state: { state: "failed", source: "run-step", detail: "run cancelled" },
    pipeline: { ...none, read: "full", run: { id: "738c23bc", head: "738c23bc", status: "cancelled", outcome: "cancelled" }, steps: steps("csk......"), findings: { total: 0, ask_user: 0, rows: [] } },
    waiting_on: { who: "first_mate", why: "run cancelled at review", rule: 5, call: null } },
  { id: "qd-sources-gh-2", title: "GitHub sources sync", state: { state: "unknown", source: "run-step", detail: "no-mistakes daemon unreachable; last ledger record failed - unverified" },
    pipeline: { ...none, read: "coarse", run: { id: null, head: null, status: "failed", outcome: null }, daemon: "down" },
    waiting_on: { who: "first_mate", why: "pipeline service down", rule: 5, call: null } },
  // No pipeline
  { id: "qd-nm-visibility-1", title: "Pipeline status per task", kind: "scout", mode: "", yolo: "", state: { state: "working", source: "pane", detail: "harness busy (claude-hook)" },
    pipeline: { ...none, applies: false, reason: "scout" },
    waiting_on: { who: "worker", why: "investigating", rule: 9, call: null } },
  { id: "qd-docs-shots-1", title: "Docs screenshot pass", mode: "direct-PR", state: { state: "done", source: "status-log", detail: "PR https://github.com/caomyer/quarterdeck/pull/38" },
    pipeline: { ...none, applies: false, reason: "direct-PR" }, pr: "https://github.com/caomyer/quarterdeck/pull/38", note: "PR https://github.com/caomyer/quarterdeck/pull/38",
    waiting_on: { who: "captain", why: "merge PR #38", rule: 2, call: null } },
  { id: "qd-dev-tidy-1", title: "Tidy the dev scripts", mode: "local-only", state: { state: "done", source: "status-log", detail: "ready in branch" },
    pipeline: { ...none, applies: false, reason: "local-only" }, note: "ready in branch",
    waiting_on: { who: "captain", why: "land on local main", rule: 2, call: null } },
  // Can't tell
  { id: "qd-spawn-race-2", title: "Terminal spawn race", state: { state: "unknown", source: "none", detail: "backend unreachable (herdr endpoint state: unreadable)" },
    pipeline: { ...none, read: "unanswered" },
    waiting_on: { who: "unknown", why: "nothing proves a holder", rule: 12, call: null } },
];

/** The tasks, their in-flight rows, and the one open call the parked-and-now-yours task carries. */
export function mockPipeline(home: string, make: { row: Row; worker: Worker }) {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const tasks = PIPELINE_CASES.map((item, index): FleetTask => {
    const kind = item.kind ?? "ship";
    const base = make.worker(item.id, kind, item.state.state, 20 + index * 7);
    const note = item.note ?? (item.state.source === "pane" ? "Working through the brief." : item.state.detail);
    return {
      ...base,
      mode: item.mode ?? (kind === "scout" ? "" : "no-mistakes"),
      yolo: item.yolo ?? (kind === "scout" ? "" : "off"),
      project: `${home}/projects/resonance`,
      paths: { ...base.paths, status_log: { present: true, last_event: { state: item.state.state, note, raw: `${item.state.state}: ${note}` } }, report: { ...base.paths.report, present: item.report ?? false } },
      current_state: { ...base.current_state, ...item.state, raw: `state: ${item.state.state} · source: ${item.state.source} · ${item.state.detail}` },
      pr: { url: item.pr ?? item.pipeline?.pr?.url ?? null, source: item.pr ? "status_event" : "absent" },
      hints: { ...base.hints, open_decisions: item.decisions ?? [], pending_decision: (item.decisions ?? []).some((d) => d.verb === "needs-decision") },
      pipeline: item.pipeline,
      waiting_on: item.waiting_on,
    };
  });
  const records = PIPELINE_CASES.map((item, index) => make.row(item.id, `Resonance: ${item.title}`, {
    state: "in_flight", current_role: "in_flight", kind: item.kind ?? "ship", priority: String(1 + (index % 3)), since: at(60 * 24 * (1 + (index % 4))).slice(0, 10),
  }));
  const call: Call = {
    id: PIPELINE_CALL, title: "Resonance: let a page sit below a newer message?", question: "Let a page sit below a newer message?",
    options: [{ key: "allow", label: "Allow it", recommended: true }, { key: "keep", label: "Keep pages above newer messages", recommended: false }],
    on_answer: "done", state: "open", bucket: "live", captain_actionable: true, origin: "qd-chat-calls-build-2", about: null,
    evidence: [], raised_by: "firstmate", raised_at: at(72), updated_at: at(72), answer: null, decided: null,
  };
  return { tasks, records, calls: [call] };
}
