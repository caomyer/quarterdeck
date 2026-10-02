// How a task's pipeline status reads: who it waits on, where its run is, and what the read was.
//
// The only reader of a task's `pipeline` and `waiting_on`, both from the fleet snapshot. Who holds a task is
// firstmate's answer (`bin/fm-waiting-on-lib.sh`), drawn here as it came: nothing in this file decides a holder.
// What it does decide is wording and the rail's cells, from the fields `bin/fm-crew-state.sh --json` read, and a
// field the engine could not read stays unknown here too. The ci log carries no timestamps, so nothing says when
// checks turned green, and nothing predicts when a run will end.
import type { FleetTask, TaskPipeline, WaitingOn } from "./host/types";

export type Who = WaitingOn["who"];
export type WhoTone = "coral" | "amber" | "blue" | "sea" | "green" | "muted" | "unknown";

export const WHO: Record<Who, { label: string; tone: WhoTone }> = {
  captain: { label: "You", tone: "coral" },
  first_mate: { label: "First mate", tone: "amber" },
  worker: { label: "Worker", tone: "blue" },
  pipeline: { label: "Pipeline", tone: "sea" },
  ci: { label: "CI", tone: "sea" },
  external: { label: "Outside wait", tone: "muted" },
  none: { label: "No one", tone: "green" },
  unknown: { label: "Can't tell", tone: "unknown" },
};

/** The steps a no-mistakes run takes, in order, for a run whose own steps were not read. */
export const STEPS = ["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"] as const;

export type CellState = "pending" | "completed" | "skipped" | "running" | "fixing" | "parked" | "held" | "failed" | "cancelled" | "unknown";
export type RailCell = { step: string; state: CellState };

export type Waiting = { who: Who; label: string; tone: WhoTone; why: string; rule: number; call: string | null };

/** Who holds the task, as firstmate folded it; null from a firstmate that predates the fold. */
export function waitingOf(task: FleetTask): Waiting | null {
  const waiting = task.waiting_on;
  if (!waiting || !(waiting.who in WHO)) return null;
  return { ...WHO[waiting.who], who: waiting.who, why: waiting.why, rule: waiting.rule, call: waiting.call ?? null };
}

/** Whether the task runs a pipeline at all. A scout, a direct-PR and a local-only task never do, and draw no rail. */
export function hasRail(pipeline: TaskPipeline | null | undefined): pipeline is TaskPipeline {
  return !!pipeline && pipeline.applies;
}

const CELL: Record<string, CellState> = {
  completed: "completed", skipped: "skipped", running: "running", fixing: "fixing",
  awaiting_approval: "parked", fix_review: "parked", failed: "failed", cancelled: "cancelled", pending: "pending",
};

/**
 * One cell per step. A full read draws each step as the run reports it; a run read only from the ledger, or a
 * pipeline that did not answer, draws every cell unknown; no run yet draws every cell pending. CI green while the
 * run still waits (or after its monitor ended) is held for a merge, not done.
 */
export function railOf(pipeline: TaskPipeline): RailCell[] {
  const run = pipeline.run;
  if (pipeline.read === "coarse" || pipeline.read === "unanswered" || (run && !pipeline.steps)) {
    return STEPS.map((step) => ({ step, state: "unknown" }));
  }
  if (!run || !pipeline.steps) return STEPS.map((step) => ({ step, state: "pending" }));
  const cells = pipeline.steps.map(({ step, status }): RailCell => ({ step, state: CELL[status] ?? "pending" }));
  return cells.map((cell) => {
    if (cell.step !== "ci") return cell;
    if (pipeline.ci === "green" && cell.state !== "completed") return { ...cell, state: "held" };
    if (pipeline.ci === "fixing") return { ...cell, state: "fixing" };
    return cell;
  });
}

/** `auto-fix 1/3` as the captain reads it: Fix round 1 of 3. */
export function fixRound(round: string | null | undefined): string | null {
  const match = round?.match(/(\d+)\s*\/\s*(\d+)/);
  return match ? `Fix round ${match[1]} of ${match[2]}` : null;
}

/** The pipeline's own `quiet 31m2s`, as how long. */
function quietFor(lastActivity: string | null) {
  return lastActivity?.replace(/^quiet\s+/, "") ?? null;
}

/** `31m2s` as whole minutes, for a sentence; null when the pipeline printed something else. */
function minutesOf(duration: string | null): number | null {
  const match = duration?.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !duration) return null;
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

const DOING: Record<string, string> = {
  intent: "Reading the intent", rebase: "Rebasing", review: "Reviewing the change", test: "Testing", document: "Updating the docs",
  lint: "Linting", push: "Pushing", pr: "Opening the PR", ci: "Watching CI",
};
const FIXING: Record<string, string> = { review: "Fixing review findings", test: "Fixing failing tests", lint: "Fixing lint", document: "Fixing the docs" };

const CI_SENTENCE: Record<string, string> = {
  running: "Checks are running on the PR.",
  rearmed: "Checks were green, then main moved. Waiting for the monitor to read them again.",
  fixing: "The pipeline is fixing a CI failure.",
  "not-ready": "Checks are not green, and the pipeline is still on them.",
  unknown: "The CI log could not be read.",
};

/** A PR as its number, or the word. */
export function prName(url: string | null | undefined) {
  const number = url?.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1];
  return number ? `PR #${number}` : "The PR";
}

/** The step a broken run stopped at, from its own steps. */
function brokeAt(pipeline: TaskPipeline) {
  return pipeline.steps?.find((step) => step.status === "failed" || step.status === "cancelled")?.step ?? null;
}

/** The headline's sentence: what the holder is doing or deciding, in the captain's words, from the rule that named them. */
export function headline(task: FleetTask, waiting: Waiting, callTitle?: string | null): string {
  const pipeline = task.pipeline ?? null;
  const active = pipeline?.active ?? null;
  switch (waiting.rule) {
    case 1:
      return callTitle ? `Your call: ${callTitle}` : "There is a call for you on this task.";
    case 2:
      if (pipeline?.reason === "local-only") return "Committed on its branch. No remote, no PR.";
      if (pipeline?.reason === "direct-PR") return "PR open. Raised directly, without the pipeline.";
      if (pipeline?.run && (pipeline.run.outcome === "failed" || pipeline.run.status === "failed")) {
        return waiting.who === "captain"
          ? "Checks were green when the pipeline stopped watching. The PR waits for your merge."
          : "Checks were green when the pipeline stopped watching. The first mate holds merge authority for this task.";
      }
      return waiting.who === "captain" ? "Checks are green. The PR waits for you to merge it." : "Checks are green. The first mate holds merge authority for this task.";
    case 3:
      return pipeline?.gate ? "A finding needs an authority decision. The worker passed it to the first mate." : "The worker asked the first mate to decide something.";
    case 4:
      return "A finding at the gate needs an authority decision, and the worker has not passed it on yet.";
    case 5: {
      if (pipeline?.daemon === "down") return "The no-mistakes service is not answering. Its last record for this run is not proof the work failed.";
      if (pipeline?.pr?.state === "closed") return "The PR was closed unmerged. The first mate decides what happens next.";
      const at = pipeline ? brokeAt(pipeline) : null;
      const cancelled = pipeline?.run?.outcome === "cancelled" || pipeline?.run?.status === "cancelled";
      return `The run ${cancelled ? "was cancelled" : "failed"}${at ? ` at ${at}` : ""}.`;
    }
    case 6: {
      const total = pipeline?.findings?.total ?? 0;
      return `The ${pipeline?.gate?.step ?? "pipeline"} gate found ${total === 1 ? "1 thing" : `${total} things`} the worker can answer itself.`;
    }
    case 7:
      return CI_SENTENCE[pipeline?.ci ?? "unknown"] ?? CI_SENTENCE.unknown;
    case 8: {
      if (pipeline?.read === "coarse") return "Validating. Which step is not readable right now.";
      if (!active) return pipeline?.run?.status === "fixing" ? "Fixing what the pipeline found." : "Validating.";
      if (active.quiet) {
        const minutes = minutesOf(quietFor(active.last_activity));
        return `${DOING[active.step] ?? `On ${active.step}`}, but nothing has come from the step${minutes !== null ? ` for ${minutes === 1 ? "1 minute" : `${minutes} minutes`}` : " for a while"}.`;
      }
      const round = fixRound(active.round);
      if (round) return `${FIXING[active.step] ?? `Fixing ${active.step}`}. ${round}.`;
      return `${DOING[active.step] ?? `On ${active.step}`}.`;
    }
    case 9:
      if (task.kind === "scout") return "Investigating. A scout writes a report and opens no PR.";
      return pipeline?.applies ? "Writing the change. The pipeline starts when the worker runs it." : "Writing the change.";
    case 10:
      return `Paused for an outside wait${waiting.why && waiting.why !== "paused" ? `: ${waiting.why}` : ""}.`;
    case 11:
      return pipeline?.pr?.state === "merged" ? "Landed. PR merged." : "The report is in.";
    default:
      if (pipeline?.read === "unanswered") return "The pipeline did not answer, and nothing else proves who holds this.";
      return "Nothing the first mate read proves who holds this.";
  }
}

/** How a task that runs no pipeline ships, in place of a rail. */
export function howItShips(task: FleetTask): { mode: string; text: string } | null {
  const pipeline = task.pipeline;
  if (!pipeline) return null;
  if (pipeline.reason === "scout") return { mode: "scout", text: "Report only." };
  if (pipeline.reason === "direct-PR") return { mode: "direct-PR", text: "No pipeline: the worker opens the PR itself." };
  if (pipeline.reason === "local-only") return { mode: "local-only", text: "No pipeline, no PR. Lands on local main." };
  if (pipeline.reason === "secondmate") return { mode: "second mate", text: "Runs its own home; no pipeline here." };
  if (pipeline.applies && !pipeline.run && pipeline.read !== "unanswered") return { mode: "no-mistakes", text: "Will validate through the pipeline." };
  return null;
}

/** The line under the rail: the active step and its own clock, or why the rail says nothing. */
export function railNote(pipeline: TaskPipeline): { text: string; quiet: string | null } | null {
  const active = pipeline.active;
  if (pipeline.read === "unanswered") return { text: "The pipeline did not answer this read, so the run's steps are not known.", quiet: null };
  if (pipeline.read === "coarse") {
    if (pipeline.daemon === "down") return { text: "Not readable: the only record is from before the service stopped.", quiet: null };
    return { text: `The run list says ${pipeline.run?.status ?? "nothing"} for this branch; its steps were not answered.`, quiet: null };
  }
  if (!pipeline.run) return { text: "Not started. No run is bound to this branch yet.", quiet: null };
  if (!active) return null;
  const parts = [active.round, active.active_for].filter(Boolean);
  if (active.quiet) return { text: [active.step, active.active_for].filter(Boolean).join(" · "), quiet: active.last_activity };
  if (active.last_activity) parts.push(`last activity ${active.last_activity} ago`);
  return { text: [active.step, ...parts].join(" · "), quiet: null };
}

/** The PR as the engine read it, and how it knows. */
export function prLine(task: FleetTask): { name: string; url: string | null; state: string; detail: string } | null {
  const pipeline = task.pipeline;
  const pr = pipeline?.pr;
  if (pr) {
    const detail = pr.via === "run"
      ? pipeline.ci === "green" ? "checks green" : pipeline.ci === "rearmed" ? "last read green, then main moved" : pipeline.ci === "running" ? "checks running" : "the run is watching it"
      : pr.via === "receipt" ? "merge receipt" : pr.via === "forge" ? "forge read" : pr.via === "skipped" ? "forge read skipped" : pr.via === "unreadable" ? "forge unreadable"
      : pipeline.ci === "green" ? "ci monitor ended, last read green" : "state not read";
    const state = pr.state === "closed" ? "closed, not merged" : pr.state === "unknown" ? "state unknown" : pr.state;
    return { name: prName(pr.url), url: pr.url, state, detail };
  }
  if (pipeline && !pipeline.applies && task.pr.url) return { name: prName(task.pr.url), url: task.pr.url, state: "open", detail: `checks not read for ${pipeline.reason ?? "this task"}` };
  return null;
}

/** Where the read came from, for the block's footer. */
export function sourceLine(task: FleetTask): string {
  const pipeline = task.pipeline;
  const state = task.current_state;
  if (pipeline?.run && pipeline.read === "full") {
    const id = pipeline.run.id ? `no-mistakes run ${pipeline.run.id.length > 8 ? `${pipeline.run.id.slice(0, 6)}…` : pipeline.run.id}` : "no-mistakes run";
    const head = pipeline.run.head ? ` · head ${pipeline.run.head.slice(0, 8)}` : "";
    const outcome = pipeline.run.outcome && pipeline.ci !== "green" ? ` · outcome ${pipeline.run.outcome}` : "";
    return id + head + outcome;
  }
  if (pipeline?.read === "coarse") return pipeline.daemon === "down" ? "no-mistakes runs ledger only · daemon not running · only the first mate restarts it" : "no-mistakes runs ledger only";
  if (pipeline?.read === "unanswered") return "no-mistakes did not answer";
  if (state.source === "pane") return state.state === "working" ? "Busy in its terminal" : "Its terminal";
  if (state.source === "status-log") {
    const said = task.paths.status_log.last_event.raw.replace(/https?:\/\/\S+(\/(?:pull|merge_requests)\/\d+)/g, "…$1");
    return said ? `worker said ${said}` : "the worker's last note";
  }
  return state.detail || "no current-state source";
}

/** A finding's file and line, as one place. */
export function findingPlace(finding: { file: string; line: string }) {
  return finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
}

/** The gate box's heading: where it parked, for how long, and what its findings are. */
export function gateLine(pipeline: TaskPipeline): string | null {
  if (!pipeline.gate) return null;
  const findings = pipeline.findings;
  const parked = pipeline.gate.parked_for ? ` for ${pipeline.gate.parked_for}` : "";
  if (!findings) return `Parked at ${pipeline.gate.step}${parked}.`;
  const count = `${findings.total} ${findings.total === 1 ? "finding" : "findings"}`;
  const split = findings.ask_user === null ? "" : findings.ask_user > 0 ? `, ${findings.ask_user} ask-user` : findings.total > 1 ? ", all the worker's" : "";
  return `Parked at ${pipeline.gate.step}${parked} · ${count}${split}`;
}

/** The list row's short form: the holder and a few words. */
export function chipOf(task: FleetTask): { label: string; tone: WhoTone; title: string } | null {
  const waiting = waitingOf(task);
  if (!waiting) return null;
  return { label: `${waiting.label} · ${waiting.why}`, tone: waiting.tone, title: `Waiting on ${waiting.label.toLowerCase()}: ${waiting.why}` };
}

/** How old a read is, for the footer: `12s`, `4m`, `2h 5m`. */
export function readAge(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
