/**
 * Where a queued task stands once the captain may start it from its drawer, and where each answer comes from.
 *
 * The drawer hands the task to the first mate in one message (`src-tauri/src/start.rs`); the first mate picks the
 * mode, writes the brief and spawns. Nothing here is a guess and nothing is taken from the spawn's word: every phase
 * is read from the backlog row, the ask the app recorded, the host's outbox and runtime, and the snapshot's worker
 * entry. Above all, a worker is Working only when the snapshot has seen its agent alive (`endpoint.status`, which
 * `fm-fleet-snapshot.sh` reads through the process-level probe), never because a spawn returned or a pane exists.
 */
import type { BacklogRecord, FleetTask, HostRuntimeState, StartAsk, StartMode } from "./host/types";

/** How long after a launch the drawer waits for its agent before saying it did not start, or that it cannot tell. */
export const LAUNCH_GRACE_MS = 2 * 60_000;

/**
 * - `queued`: nothing asked yet; Start work is offered.
 * - `offline`: nothing asked, and the first mate is not running here, so nothing can be.
 * - `held`: a call waiting on the captain. Answering it moves the row, not a worker.
 * - `asked`: the ask is on its way or being read; the row is still queued.
 * - `not_sent`: the host did not take the ask, or its turn errored before reading it.
 * - `not_started`: the first mate read the ask and its turn ended with the row still queued; its answer is in chat.
 * - `starting`: the row is in flight and a worker registered, not yet seen alive.
 * - `working`: the worker's agent has been seen alive.
 * - `didnt_start`: a worker was launched, and a reading taken well after the launch finds no agent in it.
 * - `unconfirmed`: launched a while ago, and nothing can say whether its agent runs: the backend has no classifier.
 * - `orphaned`: the row is in flight with no worker registered for it.
 * - `in_flight`: the row is in flight and the snapshot says nothing either way about a worker.
 * - `underway`: the worker has spoken for itself (a status line, or a state beyond working), so today's drawer tells it.
 * - `closed`: the row is done.
 */
export type StartPhase = "queued" | "offline" | "held" | "asked" | "not_sent" | "not_started" | "starting" | "working" | "didnt_start" | "unconfirmed" | "orphaned" | "in_flight" | "underway" | "closed";

/** The outbox's word on the ask's message, as `use-host.ts` keeps it. */
export type AskDelivery = { status: string; readAt?: string; errorKind?: "not_sent" | "failed"; error?: string };

export type StartInputs = {
  record: BacklogRecord;
  /** The snapshot's worker for the row, if one is registered. */
  task?: FleetTask;
  /** `main_inventory.orphan_in_flight`. */
  orphans: string[];
  ask: StartAsk | null;
  /** The outbox's entry for the ask's message. None for a message sent before this launch: the host re-sends one still waiting, so it was delivered. */
  delivery?: AskDelivery;
  runtime: HostRuntimeState;
  sendReady: boolean;
  /** When the first mate was last seen out of a turn: the end of its latest turn, or the app's start if it was quiet then. */
  quietSince: number | null;
  /** When the snapshot on screen was read. firstmate stamps it to the second. */
  snapshotAt: number;
  now: number;
};

/** States a worker reaches by speaking for itself, which today's drawer already tells. */
const SPOKEN = new Set(["done", "failed", "blocked", "parked", "paused"]);

/** Runtime states in which the first mate is in, or about to be in, a turn. */
export const BUSY: HostRuntimeState[] = ["starting", "prompt_turn", "agent_turn", "restarting"];

/** When this worker was launched: `spawn_gen` is `s<epoch seconds>.<pid>.<random>`, new on every spawn. */
export function launchedAt(task: FleetTask): number | null {
  const epoch = task.spawn_gen?.match(/^s(\d{9,})\./)?.[1];
  return epoch ? Number(epoch) * 1000 : null;
}

/** A call is answered, not worked: one waiting on the captain now, or one already answered that the first mate closes. */
export function heldForCaptain(record: BacklogRecord) {
  return record.captain_actionable === true || record.hold_kind === "captain" || record.kind === "captain";
}

/** Where a registered worker stands, from what the snapshot read of it. */
export function launchPhase(task: FleetTask, now: number): StartPhase {
  if (SPOKEN.has(task.current_state.state)) return "underway";
  const status = task.endpoint.status;
  if (status === "alive") return "working";
  // A status line is the worker writing: its agent ran, whatever the endpoint reads now.
  if (task.paths.status_log.present && task.paths.status_log.last_event.state) return "underway";
  const launched = launchedAt(task);
  if (status === "dead" || status === "absent") {
    // A pane holds only a shell for a moment while its agent starts, so only a reading taken well after the launch counts.
    const observed = Date.parse(task.endpoint.observed_at);
    return launched !== null && observed - launched >= LAUNCH_GRACE_MS ? "didnt_start" : "starting";
  }
  return launched === null || now - launched >= LAUNCH_GRACE_MS ? "unconfirmed" : "starting";
}

/** Whether the snapshot was taken once the first mate was quiet. It is stamped to the second, so the second counts. */
function readSince(snapshotAt: number, quietSince: number) {
  return snapshotAt >= Math.floor(quietSince / 1000) * 1000;
}

/** Any ask the app sent the first mate and recorded: when, and the id the host gave its message. */
type SentAsk = { at: number; message: string | null };

/** When the ask's turn was over by: once it was read and the first mate was quiet. Null while either is still to come. */
function settledAt(ask: SentAsk, delivery: AskDelivery | undefined, quietSince: number | null) {
  const read = delivery ? (delivery.status === "picked_up" ? Date.parse(delivery.readAt ?? "") || ask.at : null) : ask.at;
  return read === null || quietSince === null ? null : Math.max(read, quietSince);
}

/** Where the task stands for its drawer. */
export function startPhase(inputs: StartInputs): StartPhase {
  const { record, task, orphans, ask, delivery, runtime, sendReady, quietSince, snapshotAt, now } = inputs;
  if (task && record.state !== "queued") return launchPhase(task, now);
  if (record.state === "done") return "closed";
  if (record.state === "in_flight") return orphans.includes(record.id) ? "orphaned" : "in_flight";
  if (heldForCaptain(record)) return "held";
  if (ask) {
    const progress = askProgress(ask, delivery, runtime, quietSince, snapshotAt);
    return progress === "answered" ? "not_started" : progress;
  }
  return sendReady ? "queued" : "offline";
}

/**
 * How far an ask the first mate has not acted on yet has got, for every panel that asks it something: `not_sent` when
 * the host did not take it or its turn errored; `answered` when it was read, the turn that read it is over, and a
 * snapshot taken since then still shows nothing done, so the answer is in chat; `asked` while any of that is to come.
 * The host marks a message read when its turn is done, so a read ask and a quiet first mate mean that turn has ended.
 */
export function askProgress(ask: SentAsk, delivery: AskDelivery | undefined, runtime: HostRuntimeState, quietSince: number | null, snapshotAt: number): "not_sent" | "answered" | "asked" {
  if (!ask.message || delivery?.errorKind) return "not_sent";
  const settled = settledAt(ask, delivery, quietSince);
  if (settled !== null && !BUSY.includes(runtime) && readSince(snapshotAt, settled)) return "answered";
  return "asked";
}

/** Whether an ask's turn is over but the snapshot on screen predates it, so only a fresh reading can judge it. */
export function askWantsReading(ask: SentAsk | null, delivery: AskDelivery | undefined, runtime: HostRuntimeState, quietSince: number | null, snapshotAt: number) {
  if (!ask?.message || delivery?.errorKind || BUSY.includes(runtime)) return false;
  const settled = settledAt(ask, delivery, quietSince);
  return settled !== null && !readSince(snapshotAt, settled);
}

/**
 * Whether the drawer should ask for a fresh snapshot to judge the ask: it was read and the turn that read it is over,
 * but the snapshot on screen was taken before that, so whether the row moved is not known yet. Nothing under the home
 * need change when the first mate only answers in chat, so without this read the drawer would wait on nothing.
 */
export function wantsReadingAfterTurn(inputs: StartInputs) {
  const { record, ask, delivery, runtime, quietSince, snapshotAt } = inputs;
  return record.state === "queued" && askWantsReading(ask, delivery, runtime, quietSince, snapshotAt);
}

/** Phases in which only a fresh reading can move the drawer on, so it asks for one now and then. */
export function wantsFreshReading(phase: StartPhase) {
  return phase === "starting" || phase === "unconfirmed" || phase === "didnt_start";
}

/** What the captain chose, in the drawer's words. */
export const MODE_CHOICES: { mode: StartMode; label: string; detail: string }[] = [
  { mode: "judge", label: "Let the first mate judge", detail: "" },
  { mode: "no-mistakes", label: "Full checks", detail: "no-mistakes: review, tests and CI before a PR" },
  { mode: "direct-PR", label: "Straight to a PR", detail: "direct-PR: no pipeline, for internal tooling" },
];

/** What the first mate's judgement means under a project's posture, as `engine/AGENTS.md` "Intake and authority" rules it. */
export function judgeDetail(posture: string | undefined) {
  if (posture === "no-mistakes-prod-only") return "Product-facing or unsure: full checks. Internal tooling: straight to a PR.";
  return "By the project's posture.";
}

/** The project's posture beside the Start button, in a few words. */
export function postureHint(posture: string | undefined) {
  if (posture === "no-mistakes-prod-only") return "Project posture: no-mistakes for product work";
  if (posture === "no-mistakes") return "Project posture: full checks";
  if (posture === "direct-PR") return "Project posture: straight to a PR";
  if (posture === "local-only") return "Project posture: stays on this machine";
  return null;
}

/** How the ask said the task ships. */
export function askedHow(mode: StartMode) {
  return mode === "judge" ? "The first mate's call" : mode === "no-mistakes" ? "Full checks" : "Straight to a PR";
}

/** What a registered worker's mode means, for the drawer's How it ships. */
export function modeLine(mode: string) {
  if (mode === "no-mistakes") return "Full checks before a PR.";
  if (mode === "direct-PR") return "Straight to a PR, with no pipeline.";
  if (mode === "local-only") return "Stays on this machine; you land it.";
  return null;
}

/**
 * Why the task ships lighter than its project's posture asks, in the first mate's own words: the line it records in
 * the backlog row naming the lighter mode. None when it wrote none; nothing is made up in its place.
 */
export function lighterReason(record: BacklogRecord | undefined, mode: string) {
  if (mode !== "direct-PR") return null;
  return (record?.body_lines ?? []).find((line) => /\bdirect-PR\b/.test(line))?.trim() ?? null;
}
