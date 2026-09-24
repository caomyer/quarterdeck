import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CopyResult, PickResult } from "../attachments";
import { artifactPath } from "./types";
import type { AppUpdate, ArtifactRef, ArtifactRevision, CallAnswered, CallAnswerRequest, CommentPicture, ContextReading, HistoryItem, HomeStatus, HostAdapter, HostEvent, HostEventListener, HostRuntimeState, HostStateSnapshot, Needed, OutboxStatus, PaneCapture, PermissionRequest, ProjectHistory, QuotaRead, RateLimit, ReasonKind, ReviewSubmitted, ReviewSummary, ReviewVerdict, ReviewView, Routing, RoutingStart, SnapshotEvent, TaskFile, TaskNotes } from "./types";

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
  "compact",
  "permission",
  "permission_request",
  "permission_resolved",
  "host_health",
  "snapshot",
] as const;

/** What the commands answer with, in the backend's own spelling. */
type HomeReply = { home: string | null; problem: string | null; start_on_launch?: boolean; chosen?: boolean };

const homeStatus = (status: HomeReply): HomeStatus => ({
  home: status.home,
  problem: status.problem,
  startOnLaunch: status.start_on_launch === true,
  chosen: status.chosen === true,
});

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

  reviewGet(ref: ArtifactRef) {
    return invoke<ReviewView>("review_get", { page: ref });
  }

  reviewComment(ref: ArtifactRef, rev: number, body: string, anchor?: unknown, thread?: string, picture?: CommentPicture) {
    return invoke<ReviewView>("review_comment", { page: ref, rev, body, anchor, thread, picture });
  }

  reviewDiscard(ref: ArtifactRef, thread: string) {
    return invoke<ReviewView>("review_discard", { page: ref, thread });
  }

  reviewSubmit(ref: ArtifactRef, rev: number, verdict: ReviewVerdict) {
    return invoke<ReviewSubmitted>("review_submit", { page: ref, rev, verdict });
  }

  reviewScene(ref: ArtifactRef, rev: number, scene: string, label: string, path: string, summary: string, sceneJson: string, png: string) {
    return invoke<ReviewView>("review_scene", { page: ref, rev, proposal: { scene, label, path, summary, sceneJson, pngBase64: png } });
  }

  reviewAnswer(ref: ArtifactRef, decision: string, option?: string, label?: string, onAnswer?: string | null) {
    return invoke<ReviewView>("review_answer", { page: ref, decision, option, label, onAnswer: onAnswer ?? null });
  }

  callAnswer({ call, option, label, onAnswer, page, note }: CallAnswerRequest) {
    return invoke<CallAnswered>("call_answer", { page, call, option, label, onAnswer, note: note ?? null });
  }

  reviewSettle(ref: ArtifactRef, thread: string, resolved: boolean) {
    return invoke<ReviewView>("review_settle", { page: ref, thread, resolved });
  }

  reviewSeen(ref: ArtifactRef, rev: number) {
    return invoke<ReviewView>("review_seen", { page: ref, rev });
  }

  reviewSummary() {
    return invoke<ReviewSummary>("review_summary");
  }

  /** Waits until every event is being listened to: a start's history is sent once, and a window that missed it would show no earlier conversation. */
  async hostStart(home: string) {
    await this.ensureListening();
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

  pickFiles() {
    return invoke<PickResult | null>("attach_pick");
  }

  copyFiles(sources: string[]) {
    return invoke<CopyResult>("attach_copy", { sources });
  }

  cancelTurn() {
    return invoke<void>("cancel_turn");
  }

  getState() {
    return invoke<{ state: HostRuntimeState; home?: string | null; detail?: Record<string, unknown>; permission_requests?: unknown[]; conversation?: { session_id?: unknown; items?: unknown } | null; usage?: { context?: ContextReading | null; rate_limit?: RateLimit | null } }>("get_state").then((state): HostStateSnapshot => ({
      conversation: typeof state.conversation?.session_id === "string"
        ? { sessionId: state.conversation.session_id, items: historyItems(state.conversation.items) }
        : null,
      state: {
        state: state.state,
        holder: typeof state.detail?.holder_command === "string" ? state.detail.holder_command : undefined,
        reason: typeof state.detail?.reason === "string" ? state.detail.reason : undefined,
        reasonKind: text(state.detail?.reason_kind) as ReasonKind | undefined,
      },
      home: typeof state.home === "string" ? state.home : null,
      permissionRequests: (state.permission_requests ?? []).map(permissionRequest).filter((request): request is PermissionRequest => request !== null),
      usage: { context: state.usage?.context ?? null, rateLimit: state.usage?.rate_limit ?? null },
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

  taskNotes(taskId: string) {
    return invoke<TaskNotes | null>("task_notes", { taskId });
  }

  taskNoteAdd(taskId: string, body: string, sources: string[]) {
    return invoke<TaskNotes>("task_note_add", { taskId, body, sources });
  }

  taskFileUrl(taskId: string, file: TaskFile) {
    const base = navigator.userAgent.includes("Windows") ? "http://artifact.localhost" : "artifact://localhost";
    return `${base}/files/${encodeURIComponent(taskId)}/${encodeURIComponent(file.name)}`;
  }

  projectHistory(repo: string, options: { after?: string | null; limit?: number } = {}) {
    return invoke<ProjectHistory | null>("project_history", { repo, after: options.after ?? null, limit: options.limit ?? null });
  }

  getHome() {
    return invoke<HomeReply>("home_get").then(homeStatus);
  }

  chooseHome() {
    return invoke<HomeReply | null>("home_choose").then((status) => status && homeStatus(status));
  }

  useAppHome() {
    return invoke<HomeReply>("home_use_app").then(homeStatus);
  }

  toolsMissing() {
    return invoke<{ missing: Needed[]; problem: string | null }>("tools_missing");
  }

  routingGet() {
    return invoke<Routing>("routing_get");
  }

  routingEnable(from: RoutingStart) {
    return invoke<Routing>("routing_enable", { from });
  }

  routingSave(rules: string, sha256: string | null) {
    return invoke<Routing>("routing_save", { rules, sha256 });
  }

  routingDisable() {
    return invoke<Routing>("routing_disable");
  }

  routingSetKey(key: string) {
    return invoke<Routing>("routing_key_set", { key });
  }

  routingClearKey() {
    return invoke<Routing>("routing_key_clear");
  }

  readQuota() {
    return invoke<QuotaRead>("quota_read");
  }

  allowQuotaKeychain() {
    return invoke<QuotaRead>("quota_allow_keychain");
  }

  refreshSnapshot() {
    return invoke<void>("snapshot_refresh");
  }

  updateStatus() {
    return invoke<AppUpdate>("update_status");
  }

  updateCheck() {
    return invoke<AppUpdate>("update_check");
  }

  updateRestart() {
    return invoke<AppUpdate>("update_restart");
  }

  updateCancel() {
    return invoke<AppUpdate>("update_cancel");
  }

  updateSeen() {
    return invoke<AppUpdate>("update_seen");
  }

  /** Its own event, not one of the host's: `update` there is the adapter's ACP updates. */
  onUpdate(listener: (update: AppUpdate) => void) {
    const dispose = listen<AppUpdate>("app_update", ({ payload }) => listener(payload));
    return () => void dispose.then((stop) => stop());
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

function historyItems(raw: unknown): HistoryItem[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item: Record<string, unknown>): HistoryItem[] => {
    const who = item?.who;
    return (who === "captain" || who === "mate" || who === "step") && typeof item.text === "string" ? [{ who, text: item.text }] : [];
  });
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
    return { type: name, payload: { items: historyItems(raw.items) } };
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
