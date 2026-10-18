/**
 * The conversation with the first mate, and what the host says around it, folded from the host's events.
 *
 * Every client of the host draws the same chat from the same events, so the rules that turn those events into a
 * conversation live here, as pure functions of what was there before and what arrived: no React, no window, no
 * clock or randomness of their own. A client keeps one `Conversation`, folds each event and each thing the captain
 * does into it, and draws what comes back. `use-host.ts` is the desktop's.
 */

import type {
  BearingsSnapshot,
  ContextReading,
  FleetSnapshot,
  HistoryItem,
  HostEvent,
  HostRuntimeState,
  HostStateSnapshot,
  OutboxStatus,
  PermissionRequest,
  RateLimit,
  ReasonKind,
  SessionControls,
  SnapshotError,
  SnapshotEvent,
  SnapshotProject,
  ToolStep,
} from "./types";
import { errorWarning, permissionLine } from "./health.ts";

export type ChatMessage = {
  id: string;
  /** `notice`: a line from the app itself, such as a fresh conversation starting. */
  who: "mate" | "captain" | "step" | "notice";
  text: string;
  createdAt: string;
  /** For steps: the ACP tool kind and status, when reported. */
  kind?: string;
  status?: string;
  /** From a resumed session's history: no time, and never part of a live turn. */
  past?: boolean;
  /** For a resumed message, which has no time of its own: when its history was read, so it was said before then. */
  before?: string;
  /** The session this belongs to, so a resumed session's history replaces only its own conversation. */
  session?: string | null;
  /** For live mate words and steps: the turn they arrived in. */
  turn?: number;
};

export type OutboxView = {
  status: OutboxStatus;
  resentAfterRestart: boolean;
  readAt?: string;
  error?: string;
  /** `not_sent`: never reached the host. `failed`: delivered, but its turn errored. */
  errorKind?: "not_sent" | "failed";
  /** The captain already sent it again, as a new message. */
  resent?: boolean;
};

export type RewakeStorm = { turns: number; windowSecs: number };

export type RuntimeView = { state: HostRuntimeState; holder?: string; reason?: string; reasonKind?: ReasonKind };

/**
 * A host health warning. The kind picks the banner's action: `session_limit` has none, `kill_refused` offers Restart.
 * `clearsAfter`: the warning clears when the first mate is ready after this many starts, so one raised during a start outlives that start.
 */
export type HealthWarning = { kind: "session_limit" | "kill_refused" | "other"; message: string; details?: string; clearsAfter?: number };

/** An approval on screen: `answering` while the answer is on its way, `error` when it didn't go through. */
export type PermissionView = PermissionRequest & { answering?: boolean; error?: string };

/**
 * A compaction the captain asked for: `waiting` from the moment it is sent until the first mate has compacted, which
 * is after any turn already running; then `done`, or `failed` with why, in Claude Code's or the host's words.
 */
export type Compaction = { id: string; state: "waiting" | "running" | "done" | "failed"; error?: string };

/** The command Compact now sends: Claude Code's own, which the first mate's session runs. */
export const COMPACT_COMMAND = "/compact";

/**
 * Why the snapshot on screen may be stale: which scripts failed, when each projection was last read, and when the app
 * learned of the failures it shows.
 */
export type SnapshotHealth = { errors: SnapshotError[]; bearingsAt: number | null; fleetAt: number | null; failedAt?: number | null };

/** The host keeps the home of its last Start, so until the first mate starts in the chosen home, messages would go elsewhere. */
export const NOT_STARTED_HERE = "The first mate hasn't started in this folder yet. Start it, then send this again.";

export const FRESH_CONVERSATION = "The first mate started a fresh conversation.";

/** Ids the app makes up for a message the host never took, which no first mate will ever read. */
const NOT_SENT = "not-sent-";

const READY_STATES: HostRuntimeState[] = ["idle", "prompt_turn", "agent_turn"];

/** What a client draws of the first mate and its home, and what it keeps between events to fold the next one. */
export type Conversation = {
  runtime: RuntimeView;
  /** The home the host last started in, which messages and restarts go to. */
  hostHome: string | null;
  bearings: BearingsSnapshot | null;
  fleet: FleetSnapshot | null;
  projects: SnapshotProject[];
  snapshotHealth: SnapshotHealth;
  refreshing: boolean;
  messages: ChatMessage[];
  outbox: Record<string, OutboxView>;
  healthWarning: HealthWarning | null;
  rewakeStorm: RewakeStorm | null;
  startError: string | null;
  permissionRequests: PermissionView[];
  context: ContextReading | null;
  rateLimit: RateLimit | null;
  compaction: Compaction | null;
  /** What the session offers and advertises, as the host last heard it from the adapter. */
  controls: SessionControls | null;
  /** When the turn running now started, for the working row; null between turns. */
  turnSince: number | null;
  /** The mate message words are streaming into, until a step, a new session or the turn's end starts a new one. */
  streamId: string | null;
  session: string | null;
  /** Advances each time a turn starts, so a live message knows which turn it belongs to. */
  turn: number;
  /** The messages on screen when the current session opened: the ones its history may replace. */
  onScreenAtSession: ReadonlySet<string>;
  /** Outbox states as they arrive, including those of messages not on screen, for merging history. */
  outboxStatuses: ReadonlyMap<string, OutboxStatus>;
  /** Approvals answered, so a waiting list read before the answer does not bring them back. */
  resolvedApprovals: ReadonlySet<string>;
  /** How many times the first mate has become ready after a start or restart. */
  readyStarts: number;
};

/**
 * What a fold may need from outside: the time, a fresh id, and the home the client is showing, whose snapshots alone
 * are this conversation's. Passed in so the fold stays pure and a test can name them.
 */
export type FoldContext = { now: number; newId: () => string; home: string | null };

export function emptyConversation(): Conversation {
  return {
    runtime: { state: "stopped" },
    hostHome: null,
    bearings: null,
    fleet: null,
    projects: [],
    snapshotHealth: { errors: [], bearingsAt: null, fleetAt: null },
    refreshing: false,
    messages: [],
    outbox: {},
    healthWarning: null,
    rewakeStorm: null,
    startError: null,
    permissionRequests: [],
    context: null,
    rateLimit: null,
    compaction: null,
    controls: null,
    turnSince: null,
    streamId: null,
    session: null,
    turn: 0,
    onScreenAtSession: new Set(),
    outboxStatuses: new Map(),
    resolvedApprovals: new Set(),
    readyStarts: 0,
  };
}

function isoAt(now: number) {
  return new Date(now).toISOString();
}

function withStatus(statuses: ReadonlyMap<string, OutboxStatus>, id: string, status: OutboxStatus) {
  return new Map(statuses).set(id, status);
}

/** Adapter errors arrive as JSON-RPC error text; the captain reads its message. */
function readableError(error: string) {
  try {
    const parsed = JSON.parse(error) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.replace(/^Internal error:\s*/, "");
  } catch { /* plain text already */ }
  return error;
}

/**
 * A resumed session's history replaces what was on screen for that session.
 * Captain messages still waiting, failed or not sent keep their status: each takes the place of its copy in the history when it has one,
 * and otherwise follows the history. History is matched to what's on screen in order, and a message the first mate has read must be in it,
 * so a repeated text like "yes" pairs with the right copy.
 * A message still waiting belongs to whichever session it's delivered into, so it's matched whatever session it was typed in.
 * Notices stay: they mark where an earlier conversation ended, before this session's history.
 */
function mergeHistory(current: ChatMessage[], items: HistoryItem[], session: string | null, onScreen: ReadonlySet<string>, statuses: ReadonlyMap<string, OutboxStatus>, now: number) {
  const before = isoAt(now);
  const past: ChatMessage[] = items.map((item, index) => ({ id: `history-${session ?? "none"}-${index}`, who: item.who, text: item.text, createdAt: "", past: true, before, session }));
  const kept = (message: ChatMessage) => statuses.get(message.id) !== "picked_up";
  const earlier = (message: ChatMessage) => onScreen.has(message.id);
  const replaced = (message: ChatMessage) => earlier(message) && message.who !== "notice"
    && (message.session === session || (message.who === "captain" && kept(message)));
  const otherSessions = current.filter((message) => earlier(message) && !replaced(message));
  const later = current.filter((message) => !earlier(message));
  const captains = current.filter((message) => replaced(message) && message.who === "captain");
  const slots = past.flatMap((message, index) => message.who === "captain" ? [index] : []);

  // Weighted longest common subsequence: pairing a read message counts double, since it must be in the history.
  const score = Array.from({ length: captains.length + 1 }, () => new Array<number>(slots.length + 1).fill(0));
  for (let i = captains.length - 1; i >= 0; i--) {
    for (let j = slots.length - 1; j >= 0; j--) {
      const pair = captains[i].text === past[slots[j]].text ? score[i + 1][j + 1] + (kept(captains[i]) ? 1 : 2) : -1;
      score[i][j] = Math.max(pair, score[i + 1][j], score[i][j + 1]);
    }
  }
  const takesPlaceOf = new Map<number, ChatMessage>();
  const unmatched: ChatMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < captains.length) {
    if (j < slots.length && captains[i].text === past[slots[j]].text && score[i][j] === score[i + 1][j + 1] + (kept(captains[i]) ? 1 : 2)) {
      if (kept(captains[i])) takesPlaceOf.set(slots[j], captains[i]);
      i++;
      j++;
    } else if (j < slots.length && score[i][j] === score[i][j + 1]) {
      j++;
    } else {
      if (kept(captains[i])) unmatched.push(captains[i]);
      i++;
    }
  }
  return [...otherSessions, ...past.map((message, index) => takesPlaceOf.get(index) ?? message), ...unmatched, ...later];
}

/** Raises a health warning. One raised while the first mate starts is about that start, so it outlives it. */
function warn(state: Conversation, warning: HealthWarning): Conversation {
  const starting = state.runtime.state === "starting" || state.runtime.state === "restarting";
  return { ...state, healthWarning: { ...warning, clearsAfter: state.readyStarts + (starting ? 1 : 0) } };
}

/** A snapshot of the home: a refresh starting, or the projections it read and the scripts that failed. */
export function foldSnapshot(state: Conversation, payload: SnapshotEvent, context: FoldContext): Conversation {
  // A snapshot of a home the captain has since moved away from is not this home's data.
  if (payload.home && context.home && payload.home !== context.home) return state;
  const refreshing = payload.phase === "refreshing" || payload.refreshing === true;
  if (payload.phase === "refreshing") return { ...state, refreshing };
  const at = payload.generated_at_ms ?? context.now;
  return {
    ...state,
    refreshing,
    bearings: payload.bearings ? payload.bearings : state.bearings,
    fleet: payload.fleet ? payload.fleet : state.fleet,
    projects: payload.projects ? payload.projects : state.projects,
    snapshotHealth: {
      errors: payload.errors ?? [],
      failedAt: payload.errors?.length ? context.now : null,
      bearingsAt: payload.bearings ? payload.bearings_at_ms ?? at : state.snapshotHealth.bearingsAt,
      fleetAt: payload.fleet ? payload.fleet_at_ms ?? at : state.snapshotHealth.fleetAt,
    },
  };
}

function foldStep(state: Conversation, step: ToolStep, isNew: boolean, context: FoldContext): Conversation {
  // Text after a new step belongs to a new message, so the chat reads in the order things happened.
  // Updates to earlier steps can land mid-reply and must not split it.
  const next = isNew ? { ...state, streamId: null } : state;
  const current = state.messages;
  const index = current.findIndex((message) => message.who === "step" && message.id === step.id);
  if (index < 0) {
    if (!isNew) return next;
    return { ...next, messages: [...current, { id: step.id, who: "step", text: step.title ?? "", kind: step.kind, status: step.status, createdAt: isoAt(context.now), session: state.session, turn: state.turn }] };
  }
  return {
    ...next,
    messages: current.map((message, position) => position === index ? {
      ...message,
      text: step.title || message.text,
      kind: step.kind ?? message.kind,
      status: step.status ?? message.status,
    } : message),
  };
}

/** Folds one event from the host into the conversation. Returns `state` itself when the event changes nothing. */
export function foldEvent(state: Conversation, event: HostEvent, context: FoldContext): Conversation {
  if (event.type === "state") {
    const { state: runtime } = event.payload;
    const previous = state.runtime.state;
    let next: Conversation = {
      ...state,
      runtime: { state: runtime, holder: event.payload.holder ?? event.payload.holder_command, reason: event.payload.reason, reasonKind: event.payload.reason_kind },
    };
    if (event.payload.home) next.hostHome = event.payload.home;
    if (runtime !== "stopped" && runtime !== "dead") next.startError = null;
    // Ready again after a start or restart: a warning from before that start is behind it. One raised during this start is about this start, so it stays.
    if (READY_STATES.includes(runtime) && (previous === "starting" || previous === "restarting")) {
      const before = next.readyStarts;
      next.readyStarts += 1;
      if (next.healthWarning && (next.healthWarning.clearsAfter ?? 0) <= before) next.healthWarning = null;
    }
    // The adapter that asked is gone, so nothing is waiting on these answers anymore.
    if (runtime === "stopped" || runtime === "dead" || runtime === "restarting" || runtime === "starting") next.permissionRequests = [];
    if (runtime === "idle" || runtime === "dead") next.streamId = null;
    const inTurn = (value: HostRuntimeState) => value === "prompt_turn" || value === "agent_turn";
    if (inTurn(runtime) && !inTurn(previous)) {
      next = { ...next, turn: next.turn + 1, turnSince: context.now };
    } else if (!inTurn(runtime)) next.turnSince = null;
    return next;
  }

  if (event.type === "session_controls") {
    return { ...state, controls: event.payload };
  }

  if (event.type === "session") {
    const { session_id: id, mode, previous_session_lost: lost } = event.payload;
    const current = state.messages;
    // A new session has its own context window, which reads nothing until its first turn.
    const next: Conversation = { ...state, session: id, context: null, streamId: null, onScreenAtSession: new Set(current.map((message) => message.id)) };
    if (mode !== "new" || !lost) return next;
    // Messages still waiting are handed to this new conversation, so the notice belongs above them, where the old one ended.
    const waiting = (message: ChatMessage) => message.who === "captain"
      && !message.id.startsWith(NOT_SENT)
      && state.outboxStatuses.get(message.id) !== "picked_up";
    let at = current.length;
    while (at > 0 && waiting(current[at - 1])) at -= 1;
    const notice: ChatMessage = { id: `notice-${id}`, who: "notice", text: FRESH_CONVERSATION, createdAt: isoAt(context.now), session: id };
    return { ...next, messages: [...current.slice(0, at), notice, ...current.slice(at)] };
  }

  if (event.type === "history") {
    return {
      ...state,
      streamId: null,
      messages: mergeHistory(state.messages, event.payload.items, state.session, state.onScreenAtSession, state.outboxStatuses, context.now),
    };
  }

  if (event.type === "snapshot") {
    return foldSnapshot(state, event.payload, context);
  }

  if (event.type === "usage") {
    const { update, context: reading, rate_limit: limit } = event.payload;
    const current = state.context;
    // A recording made before the host read its updates carries the adapter's alone.
    const next: Conversation = {
      ...state,
      context: reading ?? (typeof update.used === "number"
        ? { used: update.used, size: update.size ?? current?.size ?? null, at_ms: event.payload.at_ms ?? context.now, resumed: current?.resumed ?? false, compacted: current?.compacted ?? null }
        : current),
    };
    if (limit) next.rateLimit = limit;
    return next;
  }

  if (event.type === "compact") {
    const { id, state: compacted, error, context: reading } = event.payload;
    const next: Conversation = reading ? { ...state, context: reading } : state;
    if (compacted === "sent") return next;
    const current = next.compaction;
    if (!(current?.id === id && current.state !== "done" && current.state !== "failed")) return next;
    return { ...next, compaction: { id, state: compacted, error } };
  }

  if (event.type === "tool_call" || event.type === "tool_update") {
    return foldStep(state, event.payload, event.type === "tool_call", context);
  }

  if (event.type === "permission_request") {
    const resolved = new Set(state.resolvedApprovals);
    resolved.delete(event.payload.id);
    return {
      ...state,
      resolvedApprovals: resolved,
      permissionRequests: [...state.permissionRequests.filter((request) => request.id !== event.payload.id), event.payload],
    };
  }

  if (event.type === "permission") {
    // A home that skips prompts still gets a request now and then, which the host answers itself; say so in the chat.
    const line = permissionLine(event.payload);
    if (!line) return state;
    return { ...state, messages: [...state.messages, { id: `permission-${context.newId()}`, who: "notice", text: line, createdAt: isoAt(context.now), session: state.session }] };
  }

  if (event.type === "permission_resolved") {
    return {
      ...state,
      resolvedApprovals: new Set(state.resolvedApprovals).add(event.payload.id),
      permissionRequests: state.permissionRequests.filter((request) => request.id !== event.payload.id),
    };
  }

  if (event.type === "outbox") {
    const { id, status, text: words } = event.payload;
    const next: Conversation = { ...state, outboxStatuses: withStatus(state.outboxStatuses, id, status) };
    // After a relaunch the host's durable outbox holds the only copy of a waiting message's words.
    // It arrives before the session and its history, so the history still pairs with it rather than repeating it.
    if (words && (status === "queued" || status === "requeued") && !next.messages.some((message) => message.id === id)) {
      next.messages = [...next.messages, { id, who: "captain", text: words, createdAt: isoAt(context.now), session: state.session }];
    }
    // A message belongs to the session it's delivered into, which may not be the one it was typed in.
    if (status === "sent") {
      const into = state.session;
      next.messages = next.messages.map((message) => message.id === id && message.session !== into ? { ...message, session: into } : message);
    }
    const failed = status === "failed";
    const earlier = state.outbox[id];
    next.outbox = {
      ...state.outbox,
      [id]: {
        status,
        resentAfterRestart: earlier?.resentAfterRestart === true
          || status === "requeued"
          || event.payload.resent_after_restart === true,
        readAt: status === "picked_up" ? isoAt(context.now) : earlier?.readAt,
        error: failed ? readableError(event.payload.error || "Its turn ended with an error.") : undefined,
        errorKind: failed ? "failed" : undefined,
        resent: earlier?.resent,
      },
    };
    // A reply came through, so the usage limit has reset.
    if (status === "picked_up" && next.healthWarning?.kind === "session_limit") next.healthWarning = null;
    const compaction = next.compaction;
    if (failed && compaction?.id === id && (compaction.state === "waiting" || compaction.state === "running")) {
      next.compaction = { id, state: "failed", error: readableError(event.payload.error || "Its turn ended with an error.") };
    }
    return next;
  }

  if (event.type === "text") {
    const activeId = state.streamId ?? `mate-${context.newId()}`;
    const current = state.messages;
    const activeIndex = current.findIndex((message) => message.id === activeId);
    return {
      ...state,
      streamId: activeId,
      messages: activeIndex < 0
        ? [...current, { id: activeId, who: "mate", text: event.payload.chunk, createdAt: isoAt(context.now), session: state.session, turn: state.turn }]
        : current.map((message, index) => index === activeIndex ? { ...message, text: message.text + event.payload.chunk } : message),
    };
  }

  if (event.type === "host_health") {
    const { kind, warning } = event.payload;
    if (kind === "rewake_storm_cleared") {
      return { ...state, rewakeStorm: null };
    } else if (event.payload.rewake_storm) {
      return {
        ...state,
        rewakeStorm: {
          turns: typeof event.payload.turns === "number" ? event.payload.turns : 6,
          windowSecs: typeof event.payload.window_secs === "number" ? event.payload.window_secs : 120,
        },
      };
    } else if (kind === "session_limit") {
      return warn(state, { kind, message: warning || "Claude's usage limit was reached." });
    } else if (kind === "kill_refused") {
      return warn(state, {
        kind,
        // `leftover`: a first mate an earlier, crashed run of the app left behind, stopped on Start.
        message: event.payload.after === "leftover"
          ? "A first mate the app left running before it closed was stopped, but some of its processes are still running on this Mac."
          : "The first mate stopped, but some of its processes are still running on this Mac.",
        details: event.payload.report === undefined ? undefined : JSON.stringify(event.payload.report, null, 2),
      });
    } else if (warning) {
      return warn(state, { kind: "other", message: warning });
    }
    // Any failure reported with an `error`, such as a message whose durable copy could not be written
    // (`outbox_write_failed`) or a session pick that could not be kept (`session_pick_unsaved`). The kinds left
    // undrawn are the host's diagnostics, named in DIAGNOSTIC_KINDS.
    const failed = errorWarning(event.payload);
    return failed ? warn(state, { kind: "other", message: failed }) : state;
  }

  // Not drawn: `prompt_result` repeats how a message's turn ended, which its `outbox` event already says.
  return state;
}

/**
 * The host's state as a window opening late reads it. A window opened while the first mate runs, such as one
 * reloaded, missed the history its start sent and everything said since. The host keeps that conversation, so it is
 * shown as if the session had just resumed. Whatever events already said wins over this older reading.
 */
export function foldHostState(state: Conversation, initial: HostStateSnapshot, context: FoldContext): Conversation {
  const next: Conversation = { ...state, runtime: initial.state };
  if (initial.home && !state.hostHome) next.hostHome = initial.home;
  const earlier = initial.conversation;
  if (earlier && state.session === null) {
    // Anything that arrived before this answer belongs to the same session, and the conversation already holds it.
    const ours = state.messages.map((message) => message.session == null ? { ...message, session: earlier.sessionId } : message);
    next.session = earlier.sessionId;
    next.streamId = null;
    next.onScreenAtSession = new Set(ours.map((message) => message.id));
    next.messages = mergeHistory(ours, earlier.items, earlier.sessionId, next.onScreenAtSession, state.outboxStatuses, context.now);
  }
  if (initial.controls) next.controls = state.controls ?? initial.controls;
  if (initial.state.state === "prompt_turn" || initial.state.state === "agent_turn") next.turnSince = state.turnSince ?? context.now;
  if (initial.usage?.context) next.context = state.context ?? initial.usage.context;
  if (initial.usage?.rateLimit) next.rateLimit = state.rateLimit ?? initial.usage.rateLimit;
  const waiting = (initial.permissionRequests ?? []).filter((request) => !state.resolvedApprovals.has(request.id));
  if (waiting.length) {
    next.permissionRequests = [...waiting.filter((request) => !state.permissionRequests.some((shown) => shown.id === request.id)), ...state.permissionRequests];
  }
  return next;
}

/**
 * A message the captain sent: with the host's `id` when it took the message, or with the `error` that kept it from
 * the host, when the message stays on screen under an id of the app's own that no first mate will ever read.
 */
export function foldSend(state: Conversation, text: string, sent: { id: string } | { error: string }, context: FoldContext): { conversation: Conversation; id: string } {
  let next = state;
  let id: string;
  if ("id" in sent) {
    id = sent.id;
  } else {
    id = `${NOT_SENT}${context.newId()}`;
    next = {
      ...next,
      outboxStatuses: withStatus(next.outboxStatuses, id, "queued"),
      outbox: { ...next.outbox, [id]: { status: "queued", resentAfterRestart: false, error: sent.error, errorKind: "not_sent" } },
    };
  }
  next = { ...next, streamId: null, messages: [...next.messages, { id, who: "captain", text, createdAt: isoAt(context.now), session: next.session }] };
  return { conversation: next, id };
}

/**
 * A message the app sent through another path, such as a review, so the conversation shows it.
 * Idempotent: the host's own outbox event for the same id adds nothing twice.
 */
export function foldNoteSent(state: Conversation, id: string, text: string, context: FoldContext): Conversation {
  if (state.messages.some((message) => message.id === id)) return state;
  return { ...state, messages: [...state.messages, { id, who: "captain", text, createdAt: isoAt(context.now), session: state.session }] };
}

/** A message that didn't go through, sent again as a new message: the old one stops offering it, once. */
export function foldResent(state: Conversation, id: string): Conversation {
  const earlier = state.outbox[id];
  return earlier ? { ...state, outbox: { ...state.outbox, [id]: { ...earlier, resent: true } } } : state;
}

/** The captain asked for a compaction, sent as message `id`: it waits for the first mate, or failed if the host never took it. */
export function foldCompactionAsked(state: Conversation, id: string): Conversation {
  const notSent = id.startsWith(NOT_SENT);
  return { ...state, compaction: { id, state: notSent ? "failed" : "waiting", error: notSent ? NOT_STARTED_HERE : undefined } };
}

/** Puts away a finished compaction's line; one still on its way stays. */
export function foldCompactionDismissed(state: Conversation): Conversation {
  const current = state.compaction;
  return current?.state === "waiting" || current?.state === "running" ? state : { ...state, compaction: null };
}

/** Why the last Start failed, or `null` as a Start begins. */
export function foldStartError(state: Conversation, error: string | null): Conversation {
  return { ...state, startError: error };
}

/** The session's controls as the adapter confirmed a change to them. */
export function foldControls(state: Conversation, controls: SessionControls): Conversation {
  return { ...state, controls };
}

/** A change to an approval on screen, such as its answer being on its way or failing. */
export function foldPermission(state: Conversation, id: string, change: Partial<PermissionView>): Conversation {
  return { ...state, permissionRequests: state.permissionRequests.map((request) => request.id === id ? { ...request, ...change } : request) };
}

/** An approval nothing waits on any more, taken off the screen. */
export function foldPermissionGone(state: Conversation, id: string): Conversation {
  return { ...state, permissionRequests: state.permissionRequests.filter((request) => request.id !== id) };
}

/** The window moved to another home: what it showed of the old one, its snapshot and its conversation, goes. */
export function foldNewHome(state: Conversation): Conversation {
  return {
    ...state,
    bearings: null,
    fleet: null,
    projects: [],
    snapshotHealth: { errors: [], bearingsAt: null, fleetAt: null },
    refreshing: true,
    // The conversation on screen was with the first mate of the old home.
    messages: [],
    outbox: {},
    context: null,
    compaction: null,
    controls: null,
    outboxStatuses: new Map(),
    streamId: null,
  };
}
