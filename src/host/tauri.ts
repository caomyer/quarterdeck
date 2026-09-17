import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { artifactPath } from "./types";
import type { ArtifactRevision, HistoryItem, HomeStatus, HostAdapter, HostEvent, HostEventListener, HostRuntimeState, HostStateSnapshot, OutboxStatus, PaneCapture, PermissionRequest, ReasonKind, SnapshotEvent } from "./types";

/** Backend event names. `update` carries the ACP updates the host does not name itself, such as `tool_call_update`. */
const EVENT_NAMES = [
  "session",
  "history",
  "state",
  "text",
  "tool_call",
  "update",
  "outbox",
  "prompt_result",
  "usage",
  "permission",
  "permission_request",
  "permission_resolved",
  "host_health",
  "snapshot",
] as const;

export class TauriHostAdapter implements HostAdapter {
  private listeners = new Set<HostEventListener>();
  private unlisten: UnlistenFn[] = [];
  private listening: Promise<void> | null = null;

  subscribe(listener: HostEventListener) {
    this.listeners.add(listener);
    void this.ensureListening();
    return () => this.listeners.delete(listener);
  }

  /** Served by the host's `artifact` scheme, which Windows' webview reaches as an http host instead. */
  artifactUrl(revision: ArtifactRevision) {
    const base = navigator.userAgent.includes("Windows") ? "http://artifact.localhost" : "artifact://localhost";
    return `${base}/${artifactPath(revision)}`;
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
    return invoke<{ state: HostRuntimeState; home?: string | null; detail?: Record<string, unknown>; permission_requests?: unknown[] }>("get_state").then((state): HostStateSnapshot => ({
      state: {
        state: state.state,
        holder: typeof state.detail?.holder_command === "string" ? state.detail.holder_command : undefined,
        reason: typeof state.detail?.reason === "string" ? state.detail.reason : undefined,
        reasonKind: text(state.detail?.reason_kind) as ReasonKind | undefined,
      },
      home: typeof state.home === "string" ? state.home : null,
      permissionRequests: (state.permission_requests ?? []).map(permissionRequest).filter((request): request is PermissionRequest => request !== null),
    }));
  }

  latestSnapshot() {
    return invoke<{ snapshot: SnapshotEvent | null }>("snapshot_latest").then((latest) => latest.snapshot);
  }

  answerPermission(id: string, optionId: string) {
    return invoke<void>("answer_permission", { id, optionId });
  }

  paneCapture(taskId: string) {
    return invoke<{ text: string; captured_at_ms?: number }>("pane_capture", { taskId }).then((capture): PaneCapture => ({
      text: capture.text,
      observed_at: capture.captured_at_ms ? new Date(capture.captured_at_ms).toISOString() : undefined,
    }));
  }

  getHome() {
    return invoke<HomeStatus>("home_get");
  }

  chooseHome() {
    return invoke<HomeStatus | null>("home_choose");
  }

  refreshSnapshot() {
    return invoke<void>("snapshot_refresh");
  }

  private ensureListening() {
    if (this.listening) return this.listening;
    this.listening = Promise.all(EVENT_NAMES.map(async (name) => {
      const dispose = await listen(name, ({ payload }) => {
        const normalized = normalizeEvent(name, payload as Record<string, unknown>);
        if (normalized) this.listeners.forEach((listener) => listener(normalized));
      });
      this.unlisten.push(dispose);
    })).then(() => undefined);
    return this.listening;
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

/** The host passes the adapter's options through as-is, so any field may be missing; an option without an id can't be answered. */
function permissionRequest(value: unknown): PermissionRequest | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  const id = text(raw.id);
  if (!id) return null;
  const options = (Array.isArray(raw.options) ? raw.options : []).flatMap((option: Record<string, unknown>) => {
    const optionId = text(option?.option_id);
    return optionId ? [{ option_id: optionId, name: text(option.name) ?? optionId, kind: text(option.kind) ?? "" }] : [];
  });
  return { id, title: text(raw.title) ?? "an action", options };
}

function normalizeEvent(name: (typeof EVENT_NAMES)[number], raw: Record<string, unknown>): HostEvent | null {
  if (name === "permission_request") {
    const request = permissionRequest(raw);
    return request && { type: name, payload: request };
  }
  if (name === "text") {
    return { type: name, payload: { chunk: String(raw.text ?? ""), origin: (raw.origin ?? "prompt_or_agent") as "prompt" | "agent" | "prompt_or_agent" } };
  }
  if (name === "tool_call" || name === "update") {
    const update = (raw.update ?? {}) as Record<string, unknown>;
    if (name === "update" && raw.kind !== "tool_call_update") return null;
    const id = text(update.toolCallId);
    if (!id) return null;
    return {
      type: name === "tool_call" ? "tool_call" : "tool_update",
      payload: { id, title: text(update.title) ?? text(raw.title), kind: text(update.kind), status: text(update.status) },
    };
  }
  if (name === "outbox") {
    return { type: name, payload: { id: String(raw.id), status: raw.state as OutboxStatus, resent_after_restart: raw.resent_after_restart === true, error: text(raw.error), text: text(raw.text) } };
  }
  if (name === "history") {
    const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((item: Record<string, unknown>): HistoryItem[] => {
      const who = item?.who;
      return (who === "captain" || who === "mate" || who === "step") && typeof item.text === "string" ? [{ who, text: item.text }] : [];
    });
    return { type: name, payload: { items } };
  }
  if (name === "snapshot") {
    return { type: name, payload: { ...raw, phase: (raw.phase ?? "ready") as "refreshing" | "ready", refreshing: raw.phase === "refreshing" } } as HostEvent;
  }
  if (name === "host_health") {
    return { type: name, payload: {
      ...raw,
      warning: typeof raw.warning === "string" ? raw.warning : undefined,
      rewake_storm: raw.kind === "rewake_storm",
    } } as HostEvent;
  }
  return { type: name, payload: raw } as HostEvent;
}
