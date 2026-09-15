import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BearingsSnapshot,
  FleetSnapshot,
  HostAdapter,
  HostEvent,
  HostRuntimeState,
  OutboxStatus,
  PermissionRequest,
  SnapshotError,
  SnapshotEvent,
  SnapshotProject,
  ToolStep,
} from "./types";

export type ChatMessage = {
  id: string;
  who: "mate" | "captain" | "step";
  text: string;
  createdAt: string;
  /** For steps: the ACP tool kind and status, when reported. */
  kind?: string;
  status?: string;
};

export type OutboxView = {
  status: OutboxStatus;
  resentAfterRestart: boolean;
  readAt?: string;
  error?: string;
  errorKind?: "not_sent" | "prompt";
};

export type RewakeStorm = { turns: number; windowSecs: number };

/** An approval on screen: `answering` while the answer is on its way, `error` when it didn't go through. */
export type PermissionView = PermissionRequest & { answering?: boolean; error?: string };

/** Why the snapshot on screen may be stale: which scripts failed, and when each projection was last read. */
export type SnapshotHealth = { errors: SnapshotError[]; bearingsAt: number | null; fleetAt: number | null };

/** The host keeps the home of its last Start, so until the first mate starts in the chosen home, messages would go elsewhere. */
export const NOT_STARTED_HERE = "The first mate hasn't started in this folder yet. Start it, then send this again.";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useHost(adapter: HostAdapter) {
  const [runtime, setRuntime] = useState<{ state: HostRuntimeState; holder?: string; reason?: string }>({ state: "stopped" });
  const [home, setHome] = useState<string | null>(null);
  const [homeChecked, setHomeChecked] = useState(false);
  const [homeProblem, setHomeProblem] = useState<string | null>(null);
  const [choosingHome, setChoosingHome] = useState(false);
  const [hostHome, setHostHome] = useState<string | null>(null);
  const [bearings, setBearings] = useState<BearingsSnapshot | null>(null);
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null);
  const [projects, setProjects] = useState<SnapshotProject[]>([]);
  const [snapshotHealth, setSnapshotHealth] = useState<SnapshotHealth>({ errors: [], bearingsAt: null, fleetAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [outbox, setOutbox] = useState<Record<string, OutboxView>>({});
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [rewakeStorm, setRewakeStorm] = useState<RewakeStorm | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PermissionView[]>([]);
  const streamId = useRef<string | null>(null);
  const homeRef = useRef<string | null>(null);
  const hostHomeRef = useRef<string | null>(null);
  const resolvedApprovals = useRef(new Set<string>());

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
        return [...current, { id: step.id, who: "step", text: step.title ?? "", kind: step.kind, status: step.status, createdAt: new Date().toISOString() }];
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
      setRuntime({ state, holder: event.payload.holder ?? event.payload.holder_command, reason: event.payload.reason });
      if (event.payload.home) noteHostHome(event.payload.home);
      if (state !== "stopped" && state !== "dead") setStartError(null);
      // The adapter that asked is gone, so nothing is waiting on these answers anymore.
      if (state === "stopped" || state === "dead" || state === "restarting" || state === "starting") setPermissionRequests([]);
      if (state === "idle" || state === "dead") streamId.current = null;
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
      setOutbox((current) => ({
        ...current,
        [event.payload.id]: {
          status: event.payload.status,
          resentAfterRestart: current[event.payload.id]?.resentAfterRestart === true
            || event.payload.status === "requeued"
            || event.payload.resent_after_restart === true,
          readAt: event.payload.status === "picked_up" ? new Date().toISOString() : current[event.payload.id]?.readAt,
          error: current[event.payload.id]?.error,
        },
      }));
      return;
    }

    if (event.type === "prompt_result" && event.payload.error) {
      setOutbox((current) => current[event.payload.id] ? ({
        ...current,
        [event.payload.id]: { ...current[event.payload.id], error: event.payload.error ?? undefined, errorKind: "prompt" },
      }) : current);
      return;
    }

    if (event.type === "text") {
      const activeId = streamId.current ?? `mate-${crypto.randomUUID()}`;
      streamId.current = activeId;
      setMessages((current) => {
        const activeIndex = current.findIndex((message) => message.id === activeId);
        if (activeIndex < 0) {
          return [...current, { id: activeId, who: "mate", text: event.payload.chunk, createdAt: new Date().toISOString() }];
        }
        return current.map((message, index) => index === activeIndex ? { ...message, text: message.text + event.payload.chunk } : message);
      });
      return;
    }

    if (event.type === "host_health") {
      if (event.payload.kind === "rewake_storm_cleared") {
        setRewakeStorm(null);
      } else if (event.payload.rewake_storm) {
        setRewakeStorm({
          turns: typeof event.payload.turns === "number" ? event.payload.turns : 6,
          windowSecs: typeof event.payload.window_secs === "number" ? event.payload.window_secs : 120,
        });
      } else if (event.payload.kind === "kill_refused") {
        setHealthWarning("The first mate stopped, but some of its processes are still running on this Mac.");
      } else if (event.payload.warning) {
        setHealthWarning(event.payload.warning);
      }
    }
  }, [applySnapshot, receiveStep, noteHostHome]);

  useEffect(() => {
    let active = true;
    const unsubscribe = adapter.subscribe(receive);
    void adapter.getHome().then((status) => {
      if (!active) return;
      homeRef.current = status.home;
      setHome(status.home);
      setHomeProblem(status.problem);
      setHomeChecked(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setHomeProblem(`Couldn't read the saved firstmate folder: ${errorText(error)}`);
      setHomeChecked(true);
    });
    void adapter.getState().then((initial) => {
      if (!active) return;
      setRuntime(initial.state);
      if (initial.home && !hostHomeRef.current) noteHostHome(initial.home);
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
      id = `not-sent-${crypto.randomUUID()}`;
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
      { id, who: "captain", text, createdAt: new Date().toISOString() },
    ]);
    return id;
  }, [adapter]);

  const start = useCallback(async () => {
    if (!home) return;
    setStartError(null);
    try {
      await adapter.hostStart(home);
    } catch (error) {
      setStartError(errorText(error));
    }
  }, [adapter, home]);
  const stop = useCallback(async () => { try { await adapter.hostStop(); } catch { /* host state remains authoritative */ } }, [adapter]);
  const restart = useCallback(async () => {
    // A restart resumes the host's last home; after choosing a different folder, start there instead.
    if (hostHomeRef.current !== homeRef.current) return start();
    try { await adapter.hostRestart(); } catch { /* host state remains authoritative */ }
  }, [adapter, start]);
  const cancel = useCallback(async () => { try { await adapter.cancelTurn(); } catch { /* not exposed until the backend enables it */ } }, [adapter]);
  const paneCapture = useCallback((taskId: string) => adapter.paneCapture(taskId), [adapter]);
  const refreshSnapshot = useCallback(async () => { try { await adapter.refreshSnapshot(); } catch { /* the next snapshot event reports failures */ } }, [adapter]);

  const chooseHome = useCallback(async () => {
    setChoosingHome(true);
    let status;
    try {
      status = await adapter.chooseHome();
    } catch (error) {
      setHomeProblem(errorText(error));
      return;
    } finally {
      setChoosingHome(false);
    }
    if (!status) return;
    setHomeProblem(status.problem);
    if (!status.home || status.home === homeRef.current) return;
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
    streamId.current = null;
  }, [adapter]);

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
    start,
    stop,
    restart,
    cancel,
    paneCapture,
    chooseHome,
    refreshSnapshot,
  };
}
