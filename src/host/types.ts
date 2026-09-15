export type BearingsTask = {
  id: string;
  kind: string;
  state: string;
  repo: string;
  name: string;
  doing: string;
};

export type Decision = {
  id: string;
  key: string;
  verb: string;
  summary: string;
  owner: string;
};

export type Landed = { id: string; what: string; artifact: string; owner: string };
export type Gate = { id: string; title: string; blocked_by: string[] | string; reason: string; owner: string; filed: string };

export type BearingsSnapshot = {
  schema: string;
  home: string;
  generated: string;
  prs: string;
  in_flight: BearingsTask[];
  decisions_open: Decision[];
  landed: Landed[];
  gates: Gate[];
  /** fm-bearings-snapshot.sh omits this key entirely when no endpoint is unhealthy. */
  unhealthy_endpoints?: { id: string; backend: string; target: string; exists: boolean; agent: string }[];
};

export type BacklogRecord = {
  id: string;
  title: string;
  hold_reason: string | null;
  current_role: string;
};

export type FleetTask = {
  id: string;
  kind: string;
  harness: string;
  mode: string;
  yolo: string;
  project: string;
  backend: string;
  paths: {
    status_log: { present: boolean; last_event: { state: string; note: string; raw: string } };
    worktree: { path: string; present: boolean };
    report: { path: string; present: boolean };
  };
  current_state: { state: string; source: string; detail: string; raw: string; observed_at: string; freshness: string };
  endpoint: { target: string; exists: boolean; agent_alive: string; status: string; observed_at: string; freshness: string };
  pr: { url: string | null; source: string };
  hints: { pending_decision: boolean; blocked_event: boolean; open_decisions: unknown[]; scout_report_present: boolean; last_event_text: string };
  actions: { watch: string; steer: string; return_channel_note: string | null };
};

export type FleetSnapshot = {
  schema: string;
  generated: string;
  fm_home: string;
  backlog?: { records: BacklogRecord[] };
  tasks: FleetTask[];
};

export type SnapshotProject = { name: string; mode: string; yolo: boolean; description?: string; added?: string | null };

export type HostRuntimeState = "stopped" | "starting" | "idle" | "prompt_turn" | "agent_turn" | "restarting" | "dead" | "locked_by_other" | "refused";
/** `failed`: delivered, but its turn errored, for example on a session limit. A turn cut off by a crash is `requeued` and re-sent instead. */
export type OutboxStatus = "queued" | "sent" | "likely_started" | "picked_up" | "requeued" | "failed";

/** Why the host refused to start or the first mate died. Banners pick their copy from this, never from `reason`'s text. */
export type ReasonKind = "not_a_home" | "permission_mode" | "lock_unconfirmed" | "lock_unclaimed" | "adapter_missing" | "adapter_crashed" | "timeout" | "exited";

/** One item of the conversation a resumed session had before, oldest first. */
export type HistoryItem = { who: "captain" | "mate" | "step"; text: string };

export type PermissionOption = { option_id: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string };
/** An approval the first mate is waiting on, in a home whose permission mode is `auto`. */
export type PermissionRequest = { id: string; title: string; options: PermissionOption[] };

/** One step the first mate takes, from an ACP `tool_call` or `tool_call_update`. Updates carry only what changed. */
export type ToolStep = { id: string; title?: string; kind?: string; status?: string };

export type HostEvent =
  | { type: "session"; payload: { mode: "new" | "loaded"; session_id: string; can_load?: boolean; prompt_queueing?: boolean; /** With `mode: "new"`: the host tried to resume the previous session and couldn't. */ previous_session_lost?: boolean } }
  /** Sent once right after a session resumes: the whole earlier conversation, in order. */
  | { type: "history"; payload: { items: HistoryItem[] } }
  | { type: "state"; payload: { state: HostRuntimeState; origin?: string; derived?: boolean; holder?: string; holder_command?: string; reason?: string; reason_kind?: ReasonKind; /** Set on `starting`: the home the host is starting in. */ home?: string } }
  | { type: "text"; payload: { chunk: string; origin: "prompt" | "agent" | "prompt_or_agent" } }
  | { type: "tool_call"; payload: ToolStep }
  | { type: "tool_update"; payload: ToolStep }
  | { type: "outbox"; payload: { id: string; status: OutboxStatus; resent_after_restart?: boolean; /** Set on `failed`. */ error?: string; /** Set on `queued` and `requeued` from the durable outbox, which is the only copy of the words after a relaunch. */ text?: string } }
  | { type: "prompt_result"; payload: { id: string; stop_reason?: string; error?: string | null; usage?: Record<string, number> } }
  | { type: "usage"; payload: Record<string, number> }
  | { type: "permission"; payload: Record<string, unknown> }
  | { type: "permission_request"; payload: PermissionRequest }
  | { type: "permission_resolved"; payload: { id: string; option_id: string } }
  | { type: "host_health"; payload: { warning?: string; rewake_storm?: boolean; [key: string]: unknown } }
  | { type: "snapshot"; payload: SnapshotEvent };

export type SnapshotError = { source: string; error: string };

export type SnapshotEvent = {
  phase?: "refreshing" | "ready";
  refreshing?: boolean;
  /** The home the snapshot was read from; absent in the mock. */
  home?: string;
  generated_at_ms?: number;
  /** In the cached snapshot: when each projection was last read, which is earlier than `generated_at_ms` after a failed read. */
  bearings_at_ms?: number;
  fleet_at_ms?: number;
  /** A script that failed leaves its projection `null` and says why here. */
  bearings?: BearingsSnapshot | null;
  fleet?: FleetSnapshot | null;
  projects?: SnapshotProject[];
  errors?: SnapshotError[];
};

export type HostStateSnapshot = {
  state: { state: HostRuntimeState; holder?: string; reason?: string; reasonKind?: ReasonKind };
  /** The home the host last started in, which messages and restarts go to; `null` before any Start. */
  home: string | null;
  /** Approvals still waiting, so a relaunched window can show them again. */
  permissionRequests?: PermissionRequest[];
};

/** The captain's firstmate home: `home` once chosen and still valid, `problem` when a choice doesn't check out. */
export type HomeStatus = { home: string | null; problem: string | null };

export type PaneCapture = { text: string; observed_at?: string };
export type HostEventListener = (event: HostEvent) => void;

export interface HostAdapter {
  subscribe(listener: HostEventListener): () => void;
  hostStart(home: string): Promise<void>;
  hostStop(): Promise<void>;
  hostRestart(): Promise<void>;
  send(text: string): Promise<string>;
  cancelTurn(): Promise<void>;
  getState(): Promise<HostStateSnapshot>;
  paneCapture(taskId: string): Promise<PaneCapture>;
  getHome(): Promise<HomeStatus>;
  /** Asks the captain for the folder; `null` when they cancel. */
  chooseHome(): Promise<HomeStatus | null>;
  refreshSnapshot(): Promise<void>;
  /** The last finished snapshot, for a window that subscribed after it was emitted. Waits for a read in progress. */
  latestSnapshot(): Promise<SnapshotEvent | null>;
  answerPermission(id: string, optionId: string): Promise<void>;
}
