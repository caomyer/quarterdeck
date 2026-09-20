import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BearingsSnapshot,
  FleetSnapshot,
  HistoryItem,
  HomeStatus,
  HostAdapter,
  HostEvent,
  HostRuntimeState,
  OutboxStatus,
  PermissionRequest,
  ReasonKind,
  SnapshotError,
  SnapshotEvent,
  SnapshotProject,
  ToolStep,
} from "./types";

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
  /** The session this belongs to, so a resumed session's history replaces only its own conversation. */
  session?: string | null;
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

/** Why the snapshot on screen may be stale: which scripts failed, and when each projection was last read. */
export type SnapshotHealth = { errors: SnapshotError[]; bearingsAt: number | null; fleetAt: number | null };

/** The host keeps the home of its last Start, so until the first mate starts in the chosen home, messages would go elsewhere. */
export const NOT_STARTED_HERE = "The first mate hasn't started in this folder yet. Start it, then send this again.";

export const FRESH_CONVERSATION = "The first mate started a fresh conversation.";

/** Ids the app makes up for a message the host never took, which no first mate will ever read. */
const NOT_SENT = "not-sent-";

const READY_STATES: HostRuntimeState[] = ["idle", "prompt_turn", "agent_turn"];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
function mergeHistory(current: ChatMessage[], items: HistoryItem[], session: string | null, onScreen: Set<string>, statuses: Map<string, OutboxStatus>) {
  const past: ChatMessage[] = items.map((item, index) => ({ id: `history-${session ?? "none"}-${index}`, who: item.who, text: item.text, createdAt: "", past: true, session }));
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

export function useHost(adapter: HostAdapter) {
  const [runtime, setRuntime] = useState<RuntimeView>({ state: "stopped" });
  const [home, setHome] = useState<string | null>(null);
  const [homeChecked, setHomeChecked] = useState(false);
  const [homeProblem, setHomeProblem] = useState<string | null>(null);
  const [choosingHome, setChoosingHome] = useState(false);
  /** False while the app's own home is in use, so the app can offer it back. */
  const [homeChosen, setHomeChosen] = useState(false);
  const [hostHome, setHostHome] = useState<string | null>(null);
  const [bearings, setBearings] = useState<BearingsSnapshot | null>(null);
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null);
  const [projects, setProjects] = useState<SnapshotProject[]>([]);
  const [snapshotHealth, setSnapshotHealth] = useState<SnapshotHealth>({ errors: [], bearingsAt: null, fleetAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [outbox, setOutbox] = useState<Record<string, OutboxView>>({});
  const [healthWarning, setHealthWarning] = useState<HealthWarning | null>(null);
  const [rewakeStorm, setRewakeStorm] = useState<RewakeStorm | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PermissionView[]>([]);
  const streamId = useRef<string | null>(null);
  const homeRef = useRef<string | null>(null);
  const hostHomeRef = useRef<string | null>(null);
  const resolvedApprovals = useRef(new Set<string>());
  const runtimeState = useRef<HostRuntimeState>("stopped");
  const session = useRef<string | null>(null);
  /** The messages on screen when the current session opened: the ones its history may replace. */
  const onScreenAtSession = useRef(new Set<string>());
  /** Outbox states as they arrive, for merging history, which can't wait for a render. */
  const outboxStatuses = useRef(new Map<string, OutboxStatus>());
  /** How many times the first mate has become ready after a start or restart. */
  const readyStarts = useRef(0);
  /** The captain pressed Stop, so a Start it cuts short isn't an error. */
  const stopRequested = useRef(false);
  /** The first mate was left running in the saved home when the app last closed, and hasn't been started again yet. */
  const startOnLaunch = useRef(false);

  const warn = useCallback((warning: HealthWarning) => {
    const starting = runtimeState.current === "starting" || runtimeState.current === "restarting";
    setHealthWarning({ ...warning, clearsAfter: readyStarts.current + (starting ? 1 : 0) });
  }, []);

  const noteHostHome = useCallback((next: string) => {
    hostHomeRef.current = next;
    setHostHome(next);
  }, []);

  const applySnapshot = useCallback((payload: SnapshotEvent) => {
    // A snapshot of a home the captain has since moved away from is not this home's data.
    if (payload.home && homeRef.current && payload.home !== homeRef.current) return;
    setRefreshing(payload.phase === "refreshing" || payload.refreshing === true);
    if (payload.phase === "refreshing") return;
    const at = payload.generated_at_ms ?? Date.now();
    if (payload.bearings) setBearings(payload.bearings);
    if (payload.fleet) setFleet(payload.fleet);
    if (payload.projects) setProjects(payload.projects);
    setSnapshotHealth((current) => ({
      errors: payload.errors ?? [],
      bearingsAt: payload.bearings ? payload.bearings_at_ms ?? at : current.bearingsAt,
      fleetAt: payload.fleet ? payload.fleet_at_ms ?? at : current.fleetAt,
    }));
  }, []);

  const receiveStep = useCallback((step: ToolStep, isNew: boolean) => {
    // Text after a new step belongs to a new message, so the chat reads in the order things happened.
    // Updates to earlier steps can land mid-reply and must not split it.
    if (isNew) streamId.current = null;
    setMessages((current) => {
      const index = current.findIndex((message) => message.who === "step" && message.id === step.id);
      if (index < 0) {
        if (!isNew) return current;
        return [...current, { id: step.id, who: "step", text: step.title ?? "", kind: step.kind, status: step.status, createdAt: new Date().toISOString(), session: session.current }];
      }
      return current.map((message, position) => position === index ? {
        ...message,
        text: step.title || message.text,
        kind: step.kind ?? message.kind,
        status: step.status ?? message.status,
      } : message);
    });
  }, []);

  const receive = useCallback((event: HostEvent) => {
    if (event.type === "state") {
      const { state } = event.payload;
      const previous = runtimeState.current;
      runtimeState.current = state;
      setRuntime({ state, holder: event.payload.holder ?? event.payload.holder_command, reason: event.payload.reason, reasonKind: event.payload.reason_kind });
      if (event.payload.home) noteHostHome(event.payload.home);
      if (state !== "stopped" && state !== "dead") setStartError(null);
      // Ready again after a start or restart: a warning from before that start is behind it. One raised during this start is about this start, so it stays.
      if (READY_STATES.includes(state) && (previous === "starting" || previous === "restarting")) {
        const before = readyStarts.current;
        readyStarts.current += 1;
        setHealthWarning((current) => current && (current.clearsAfter ?? 0) <= before ? null : current);
      }
      // The adapter that asked is gone, so nothing is waiting on these answers anymore.
      if (state === "stopped" || state === "dead" || state === "restarting" || state === "starting") setPermissionRequests([]);
      if (state === "idle" || state === "dead") streamId.current = null;
      return;
    }

    if (event.type === "session") {
      const { session_id: id, mode, previous_session_lost: lost } = event.payload;
      session.current = id;
      streamId.current = null;
      setMessages((current) => {
        onScreenAtSession.current = new Set(current.map((message) => message.id));
        if (mode !== "new" || !lost) return current;
        // Messages still waiting are handed to this new conversation, so the notice belongs above them, where the old one ended.
        const waiting = (message: ChatMessage) => message.who === "captain"
          && !message.id.startsWith(NOT_SENT)
          && outboxStatuses.current.get(message.id) !== "picked_up";
        let at = current.length;
        while (at > 0 && waiting(current[at - 1])) at -= 1;
        const notice: ChatMessage = { id: `notice-${id}`, who: "notice", text: FRESH_CONVERSATION, createdAt: new Date().toISOString(), session: id };
        return [...current.slice(0, at), notice, ...current.slice(at)];
      });
      return;
    }

    if (event.type === "history") {
      const id = session.current;
      streamId.current = null;
      setMessages((current) => mergeHistory(current, event.payload.items, id, onScreenAtSession.current, outboxStatuses.current));
      return;
    }

    if (event.type === "snapshot") {
      applySnapshot(event.payload);
      return;
    }

    if (event.type === "tool_call" || event.type === "tool_update") {
      receiveStep(event.payload, event.type === "tool_call");
      return;
    }

    if (event.type === "permission_request") {
      resolvedApprovals.current.delete(event.payload.id);
      setPermissionRequests((current) => [...current.filter((request) => request.id !== event.payload.id), event.payload]);
      return;
    }

    if (event.type === "permission_resolved") {
      resolvedApprovals.current.add(event.payload.id);
      setPermissionRequests((current) => current.filter((request) => request.id !== event.payload.id));
      return;
    }

    if (event.type === "outbox") {
      const { id, status, text: words } = event.payload;
      outboxStatuses.current.set(id, status);
      // After a relaunch the host's durable outbox holds the only copy of a waiting message's words.
      // It arrives before the session and its history, so the history still pairs with it rather than repeating it.
      if (words && (status === "queued" || status === "requeued")) {
        const at = session.current;
        setMessages((current) => current.some((message) => message.id === id)
          ? current
          : [...current, { id, who: "captain", text: words, createdAt: new Date().toISOString(), session: at }]);
      }
      // A message belongs to the session it's delivered into, which may not be the one it was typed in.
      if (status === "sent") {
        const into = session.current;
        setMessages((current) => current.map((message) => message.id === id && message.session !== into ? { ...message, session: into } : message));
      }
      const failed = status === "failed";
      setOutbox((current) => ({
        ...current,
        [id]: {
          status,
          resentAfterRestart: current[id]?.resentAfterRestart === true
            || status === "requeued"
            || event.payload.resent_after_restart === true,
          readAt: status === "picked_up" ? new Date().toISOString() : current[id]?.readAt,
          error: failed ? readableError(event.payload.error || "Its turn ended with an error.") : undefined,
          errorKind: failed ? "failed" : undefined,
          resent: current[id]?.resent,
        },
      }));
      // A reply came through, so the usage limit has reset.
      if (status === "picked_up") setHealthWarning((current) => current?.kind === "session_limit" ? null : current);
      return;
    }

    if (event.type === "text") {
      const activeId = streamId.current ?? `mate-${crypto.randomUUID()}`;
      streamId.current = activeId;
      const at = session.current;
      setMessages((current) => {
        const activeIndex = current.findIndex((message) => message.id === activeId);
        if (activeIndex < 0) {
          return [...current, { id: activeId, who: "mate", text: event.payload.chunk, createdAt: new Date().toISOString(), session: at }];
        }
        return current.map((message, index) => index === activeIndex ? { ...message, text: message.text + event.payload.chunk } : message);
      });
      return;
    }

    if (event.type === "host_health") {
      const { kind, warning } = event.payload;
      if (kind === "rewake_storm_cleared") {
        setRewakeStorm(null);
      } else if (event.payload.rewake_storm) {
        setRewakeStorm({
          turns: typeof event.payload.turns === "number" ? event.payload.turns : 6,
          windowSecs: typeof event.payload.window_secs === "number" ? event.payload.window_secs : 120,
        });
      } else if (kind === "session_limit") {
        warn({ kind, message: warning || "Claude's usage limit was reached." });
      } else if (kind === "kill_refused") {
        warn({
          kind,
          // `leftover`: a first mate an earlier, crashed run of the app left behind, stopped on Start.
          message: event.payload.after === "leftover"
            ? "A first mate the app left running before it closed was stopped, but some of its processes are still running on this Mac."
            : "The first mate stopped, but some of its processes are still running on this Mac.",
          details: event.payload.report === undefined ? undefined : JSON.stringify(event.payload.report, null, 2),
        });
      } else if (warning) {
        warn({ kind: "other", message: warning });
      }
    }
  }, [applySnapshot, receiveStep, noteHostHome, warn]);

  useEffect(() => {
    let active = true;
    const unsubscribe = adapter.subscribe(receive);
    void adapter.getHome().then((status) => {
      if (!active) return;
      homeRef.current = status.home;
      startOnLaunch.current = status.home !== null && status.startOnLaunch === true;
      setHome(status.home);
      setHomeProblem(status.problem);
      setHomeChosen(status.chosen === true);
      setHomeChecked(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setHomeProblem(`Couldn't read the saved firstmate folder: ${errorText(error)}`);
      setHomeChecked(true);
    });
    void adapter.getState().then((initial) => {
      if (!active) return;
      runtimeState.current = initial.state.state;
      setRuntime(initial.state);
      if (initial.home && !hostHomeRef.current) noteHostHome(initial.home);
      // A window opened while the first mate runs, such as one reloaded, missed the history its start sent and
      // everything said since. The host keeps that conversation, so it is shown as if the session had just resumed.
      const earlier = initial.conversation;
      if (earlier && session.current === null) {
        session.current = earlier.sessionId;
        streamId.current = null;
        setMessages((current) => {
          // Anything that arrived before this answer belongs to the same session, and the conversation already holds it.
          const ours = current.map((message) => message.session == null ? { ...message, session: earlier.sessionId } : message);
          onScreenAtSession.current = new Set(ours.map((message) => message.id));
          return mergeHistory(ours, earlier.items, earlier.sessionId, onScreenAtSession.current, outboxStatuses.current);
        });
      }
      const waiting = (initial.permissionRequests ?? []).filter((request) => !resolvedApprovals.current.has(request.id));
      if (waiting.length) {
        setPermissionRequests((current) => [...waiting.filter((request) => !current.some((shown) => shown.id === request.id)), ...current]);
      }
    }).catch(() => { /* state events still arrive */ });
    // Separate from the host state: this waits for a read in progress, which can take a while.
    void adapter.latestSnapshot().then((latest) => {
      if (active && latest) applySnapshot(latest);
    }).catch(() => { /* snapshot events still arrive */ });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [adapter, receive, applySnapshot, noteHostHome]);

  const send = useCallback(async (text: string) => {
    let id: string;
    try {
      if (!homeRef.current || hostHomeRef.current !== homeRef.current) throw new Error(NOT_STARTED_HERE);
      id = await adapter.send(text);
    } catch (error) {
      id = `${NOT_SENT}${crypto.randomUUID()}`;
      outboxStatuses.current.set(id, "queued");
      setOutbox((current) => ({
        ...current,
        [id]: {
          status: "queued",
          resentAfterRestart: false,
          error: errorText(error),
          errorKind: "not_sent",
        },
      }));
    }
    streamId.current = null;
    setMessages((current) => [
      ...current,
      { id, who: "captain", text, createdAt: new Date().toISOString(), session: session.current },
    ]);
    return id;
  }, [adapter]);

  /**
   * Records a message the app sent through another path, such as a review, so the conversation shows it.
   * Idempotent: the host's own outbox event for the same id adds nothing twice.
   */
  const noteSent = useCallback((id: string, text: string) => {
    setMessages((current) => current.some((message) => message.id === id)
      ? current
      : [...current, { id, who: "captain", text, createdAt: new Date().toISOString(), session: session.current }]);
  }, []);

  /** Sends a message that didn't go through again, as a new message, once: the old one stops offering it. */
  const resend = useCallback(async (id: string, text: string) => {
    setOutbox((current) => current[id] ? { ...current, [id]: { ...current[id], resent: true } } : current);
    return send(text);
  }, [send]);

  const start = useCallback(async () => {
    // The ref, not state: Start can follow a folder choice before a render.
    const target = homeRef.current;
    if (!target) return;
    setStartError(null);
    stopRequested.current = false;
    try {
      await adapter.hostStart(target);
    } catch (error) {
      if (!stopRequested.current) setStartError(errorText(error));
    }
  }, [adapter]);
  // A first mate the captain left running comes back with the app. Only once the window is listening, so the
  // earlier conversation the start sends reaches it, and only if nothing started it meanwhile, such as a window
  // reloaded while the app kept running.
  useEffect(() => {
    if (!homeChecked || !startOnLaunch.current) return;
    startOnLaunch.current = false;
    void adapter.getState().then((current) => {
      if (current.state.state === "stopped" && runtimeState.current === "stopped") void start();
    }, () => { /* the captain can still press Start */ });
  }, [homeChecked, adapter, start]);

  const stop = useCallback(async () => {
    stopRequested.current = true;
    try { await adapter.hostStop(); } catch { /* host state remains authoritative */ }
  }, [adapter]);
  const restart = useCallback(async () => {
    // A restart resumes the host's last home; after choosing a different folder, start there instead.
    if (hostHomeRef.current !== homeRef.current) return start();
    try { await adapter.hostRestart(); } catch { /* host state remains authoritative */ }
  }, [adapter, start]);
  const cancel = useCallback(async () => { try { await adapter.cancelTurn(); } catch { /* not exposed until the backend enables it */ } }, [adapter]);
  const paneCapture = useCallback((taskId: string) => adapter.paneCapture(taskId), [adapter]);
  const refreshSnapshot = useCallback(async () => { try { await adapter.refreshSnapshot(); } catch { /* the next snapshot event reports failures */ } }, [adapter]);

  /** Takes up a home the backend reported, clearing what belonged to the last one. */
  const adoptHome = useCallback((status: HomeStatus): string | null => {
    setHomeProblem(status.problem);
    setHomeChosen(status.chosen === true);
    if (!status.home || status.home === homeRef.current) return status.home;
    homeRef.current = status.home;
    setHome(status.home);
    setBearings(null);
    setFleet(null);
    setProjects([]);
    setSnapshotHealth({ errors: [], bearingsAt: null, fleetAt: null });
    setRefreshing(true);
    // The conversation on screen was with the first mate of the old home.
    setMessages([]);
    setOutbox({});
    outboxStatuses.current.clear();
    streamId.current = null;
    return status.home;
  }, []);

  /** Resolves to the chosen home when the captain picked a valid folder, `null` otherwise. */
  const chooseHome = useCallback(async (): Promise<string | null> => {
    setChoosingHome(true);
    let status;
    try {
      status = await adapter.chooseHome();
    } catch (error) {
      setHomeProblem(errorText(error));
      return null;
    } finally {
      setChoosingHome(false);
    }
    if (!status) return null;
    return adoptHome(status);
  }, [adapter, adoptHome]);

  /** Gives the app's own home back, forgetting a folder the captain chose. */
  const useAppHome = useCallback(async (): Promise<string | null> => {
    setChoosingHome(true);
    try {
      return adoptHome(await adapter.useAppHome());
    } catch (error) {
      setHomeProblem(errorText(error));
      return null;
    } finally {
      setChoosingHome(false);
    }
  }, [adapter, adoptHome]);

  const answerPermission = useCallback(async (id: string, optionId: string) => {
    const patch = (change: Partial<PermissionView>) => setPermissionRequests((current) => current.map((request) => request.id === id ? { ...request, ...change } : request));
    patch({ answering: true, error: undefined });
    try {
      await adapter.answerPermission(id, optionId);
    } catch (error) {
      // The request may be gone already, for example after the host restarted the adapter; only keep the card if it still waits.
      const waiting = await adapter.getState().then((state) => state.permissionRequests?.some((request) => request.id === id), () => true);
      if (waiting) patch({ answering: false, error: errorText(error) });
      else setPermissionRequests((current) => current.filter((request) => request.id !== id));
    }
  }, [adapter]);

  return {
    runtime,
    home,
    homeChecked,
    homeProblem,
    choosingHome,
    /** Messages go to the chosen home only once the first mate has started there. */
    sendReady: home !== null && hostHome === home,
    bearings,
    fleet,
    projects,
    snapshotHealth,
    refreshing,
    messages,
    outbox,
    healthWarning,
    rewakeStorm,
    startError,
    permissionRequests,
    answerPermission,
    send,
    noteSent,
    resend,
    start,
    stop,
    restart,
    cancel,
    paneCapture,
    chooseHome,
    useAppHome,
    homeChosen,
    refreshSnapshot,
  };
}
