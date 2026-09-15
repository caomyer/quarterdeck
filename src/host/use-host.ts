import { useCallback, useEffect, useRef, useState } from "react";

import bearingsFixture from "../fixtures/bearings-snapshot.json";
import fleetFixture from "../fixtures/fleet-snapshot.json";
import type {
  BearingsSnapshot,
  FleetSnapshot,
  HostAdapter,
  HostEvent,
  HostRuntimeState,
  OutboxStatus,
  SnapshotProject,
} from "./types";

export type ChatMessage = {
  id: string;
  who: "mate" | "captain";
  text: string;
  createdAt: string;
};

export type OutboxView = {
  status: OutboxStatus;
  resentAfterRestart: boolean;
  readAt?: string;
  error?: string;
  errorKind?: "not_sent" | "prompt";
};

export type RewakeStorm = { turns: number; windowSecs: number };

export function useHost(adapter: HostAdapter) {
  const [runtime, setRuntime] = useState<{ state: HostRuntimeState; holder?: string; reason?: string }>({ state: "idle" });
  const [bearings, setBearings] = useState<BearingsSnapshot>(bearingsFixture as unknown as BearingsSnapshot);
  const [fleet, setFleet] = useState<FleetSnapshot>(fleetFixture as unknown as FleetSnapshot);
  const [projects, setProjects] = useState<SnapshotProject[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [outbox, setOutbox] = useState<Record<string, OutboxView>>({});
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [rewakeStorm, setRewakeStorm] = useState<RewakeStorm | null>(null);
  const streamId = useRef<string | null>(null);

  const receive = useCallback((event: HostEvent) => {
    if (event.type === "state") {
      setRuntime({ state: event.payload.state, holder: event.payload.holder ?? event.payload.holder_command, reason: event.payload.reason });
      if (event.payload.state === "idle" || event.payload.state === "dead") streamId.current = null;
      return;
    }

    if (event.type === "snapshot") {
      const isRefreshing = event.payload.phase === "refreshing" || event.payload.refreshing === true;
      setRefreshing(isRefreshing);
      if (event.payload.bearings) setBearings(event.payload.bearings);
      if (event.payload.fleet) setFleet(event.payload.fleet);
      if (event.payload.projects) setProjects(event.payload.projects);
      if (event.payload.phase === "ready") setRefreshing(false);
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
  }, []);

  useEffect(() => {
    const unsubscribe = adapter.subscribe(receive);
    void adapter.getState().then((initial) => {
      setRuntime(initial.state);
      if (initial.snapshot) {
        setBearings(initial.snapshot.bearings);
        setFleet(initial.snapshot.fleet);
      }
    });
    return unsubscribe;
  }, [adapter, receive]);

  const send = useCallback(async (text: string) => {
    let id: string;
    try {
      id = await adapter.send(text);
    } catch (error) {
      id = `not-sent-${crypto.randomUUID()}`;
      setOutbox((current) => ({
        ...current,
        [id]: {
          status: "queued",
          resentAfterRestart: false,
          error: error instanceof Error ? error.message : String(error),
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

  const start = useCallback(async () => { try { await adapter.hostStart(fleet?.fm_home ?? ""); } catch { /* state events carry the refusal copy */ } }, [adapter, fleet?.fm_home]);
  const stop = useCallback(async () => { try { await adapter.hostStop(); } catch { /* host state remains authoritative */ } }, [adapter]);
  const restart = useCallback(async () => { try { await adapter.hostRestart(); } catch { /* host state remains authoritative */ } }, [adapter]);
  const cancel = useCallback(async () => { try { await adapter.cancelTurn(); } catch { /* not exposed until the backend enables it */ } }, [adapter]);
  const paneCapture = useCallback((taskId: string) => adapter.paneCapture(taskId), [adapter]);

  return {
    runtime,
    bearings,
    fleet,
    projects,
    refreshing,
    messages,
    outbox,
    healthWarning,
    rewakeStorm,
    send,
    start,
    stop,
    restart,
    cancel,
    paneCapture,
  };
}
