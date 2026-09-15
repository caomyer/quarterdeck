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
export type OutboxStatus = "queued" | "sent" | "likely_started" | "picked_up" | "requeued";

export type HostEvent =
  | { type: "session"; payload: { mode: "new" | "loaded"; session_id: string; can_load: boolean; prompt_queueing: boolean } }
  | { type: "state"; payload: { state: HostRuntimeState; origin?: string; derived?: boolean; holder?: string; holder_command?: string; reason?: string } }
  | { type: "text"; payload: { chunk: string; origin: "prompt" | "agent" | "prompt_or_agent" } }
  | { type: "tool_call"; payload: { title: string } }
  | { type: "outbox"; payload: { id: string; status: OutboxStatus; resent_after_restart?: boolean } }
  | { type: "prompt_result"; payload: { id: string; stop_reason?: string; error?: string | null; usage?: Record<string, number> } }
  | { type: "usage"; payload: Record<string, number> }
  | { type: "permission"; payload: Record<string, unknown> }
  | { type: "host_health"; payload: { warning?: string; rewake_storm?: boolean; [key: string]: unknown } }
  | { type: "snapshot"; payload: SnapshotEvent };

export type SnapshotEvent = {
  phase?: "refreshing" | "ready";
  refreshing?: boolean;
  bearings?: BearingsSnapshot;
  fleet?: FleetSnapshot;
  projects?: SnapshotProject[];
};

export type HostStateSnapshot = {
  state: { state: HostRuntimeState; holder?: string; reason?: string };
  snapshot?: { bearings: BearingsSnapshot; fleet: FleetSnapshot };
};

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
}
