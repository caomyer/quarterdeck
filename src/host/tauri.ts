import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { HostAdapter, HostEvent, HostEventListener, HostRuntimeState, HostStateSnapshot, OutboxStatus, PaneCapture } from "./types";

const EVENT_NAMES: HostEvent["type"][] = [
  "session",
  "state",
  "text",
  "tool_call",
  "outbox",
  "prompt_result",
  "usage",
  "permission",
  "host_health",
  "snapshot",
];

export class TauriHostAdapter implements HostAdapter {
  private listeners = new Set<HostEventListener>();
  private unlisten: UnlistenFn[] = [];
  private listening: Promise<void> | null = null;

  subscribe(listener: HostEventListener) {
    this.listeners.add(listener);
    void this.ensureListening();
    return () => this.listeners.delete(listener);
  }

  hostStart(home: string) {
    return invoke<void>("host_start", { home });
  }

  hostStop() {
    return invoke<void>("host_stop");
  }

  hostRestart() {
    return invoke<void>("host_restart");
  }

  send(text: string) {
    return invoke<string>("send", { text });
  }

  cancelTurn() {
    return invoke<void>("cancel_turn");
  }

  getState() {
    return invoke<{ state: HostRuntimeState; detail?: Record<string, unknown> }>("get_state").then((state): HostStateSnapshot => ({
      state: {
        state: state.state,
        holder: typeof state.detail?.holder_command === "string" ? state.detail.holder_command : undefined,
        reason: typeof state.detail?.reason === "string" ? state.detail.reason : undefined,
      },
    }));
  }

  paneCapture(taskId: string) {
    return invoke<{ text: string; captured_at_ms?: number }>("pane_capture", { taskId }).then((capture): PaneCapture => ({
      text: capture.text,
      observed_at: capture.captured_at_ms ? new Date(capture.captured_at_ms).toISOString() : undefined,
    }));
  }

  private ensureListening() {
    if (this.listening) return this.listening;
    this.listening = Promise.all(EVENT_NAMES.map(async (type) => {
      const dispose = await listen(type, ({ payload }) => {
        const normalized = normalizeEvent(type, payload as Record<string, unknown>);
        this.listeners.forEach((listener) => listener(normalized));
      });
      this.unlisten.push(dispose);
    })).then(() => undefined);
    return this.listening;
  }
}

function normalizeEvent(type: HostEvent["type"], raw: Record<string, unknown>): HostEvent {
  if (type === "text") {
    return { type, payload: { chunk: String(raw.text ?? ""), origin: (raw.origin ?? "prompt_or_agent") as "prompt" | "agent" | "prompt_or_agent" } };
  }
  if (type === "outbox") {
    return { type, payload: { id: String(raw.id), status: raw.state as OutboxStatus, resent_after_restart: raw.resent_after_restart === true } };
  }
  if (type === "snapshot") {
    return { type, payload: { ...raw, phase: (raw.phase ?? "ready") as "refreshing" | "ready", refreshing: raw.phase === "refreshing" } } as HostEvent;
  }
  if (type === "host_health") {
    return { type, payload: {
      ...raw,
      warning: typeof raw.warning === "string" ? raw.warning : undefined,
      rewake_storm: raw.kind === "rewake_storm",
    } } as HostEvent;
  }
  return { type, payload: raw } as HostEvent;
}
