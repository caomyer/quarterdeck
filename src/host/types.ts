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
  /** Scout reports on disk for tasks still in play or recently landed. */
  reports?: { id: string; path: string }[];
  /** fm-bearings-snapshot.sh omits this key entirely when no endpoint is unhealthy. */
  unhealthy_endpoints?: { id: string; backend: string; target: string; exists: boolean; agent: string }[];
};

export type BacklogRecord = {
  id: string;
  title: string;
  hold_reason: string | null;
  current_role: string;
  /** Where the row sits in the backlog: `in_flight`, `queued`, or `done`. */
  state?: string;
  /** firstmate's own read of "waiting on the captain now"; exactly a live captain hold. */
  captain_actionable?: boolean;
  /** `ship`, `scout`, `captain` or `secondmate`; absent on rows written before kinds. */
  kind?: string | null;
  /** The project, by name. */
  repo?: string | null;
  /** `captain` on a call held for the captain, which it keeps after the call is answered. */
  hold_kind?: string | null;
  /** The date the row was filed, `yyyy-mm-dd`. */
  since?: string | null;
  /** How a done row was closed, and on which date (`yyyy-mm-dd`). */
  completion?: { verb: string | null; date: string | null };
  pr_url?: string | null;
  report_path?: string | null;
  /** The row's body, bookkeeping lines included. What a call was answered with is read from `calls[]`, never from here. */
  body_lines?: string[];
  body_excerpt?: string | null;
};

/** One option a call offers, as `bin/fm-captain-hold.sh` records it. */
export type CallOption = { key: string; label: string; recommended: boolean };

/** Who answered a call and through which channel, read from the machine lines of its resolution block. */
export type CallAnswer = {
  /** The option's key, or null when the answer named none (a free answer in chat). */
  key: string | null;
  label: string;
  by: "captain" | "firstmate";
  /** `quarterdeck`, `chat`, `lavish`, or another source the intake was given. */
  via: string;
  at: string;
};

/** Why the first mate settled a call for the captain, on a call raised and answered by `decide`. */
export type CallDecided = { what: string; why: string; kind?: string | null; link?: string | null };

/**
 * A captain call, exactly as `bin/fm-captain-hold.sh list --json` reports it and `fm-fleet-snapshot.sh` carries it
 * in `calls[]`: the backlog row's lifecycle joined with the call's own record. A row with no record still comes
 * through, with no options and no evidence.
 */
export type Call = {
  id: string;
  title: string;
  question: string | null;
  options: CallOption[];
  /** How an answer closes it: `done` or `release`. Channels pass it on, never choose it. */
  on_answer: string | null;
  /** `open`: held, not answered. `answered`: the answer is recorded, the row not closed yet. `closed`. */
  state: "open" | "answered" | "closed";
  bucket?: string | null;
  captain_actionable?: boolean;
  /** The task whose work raised it: everything that task produced argues it. */
  origin?: string | null;
  /** The task it is about, if another. */
  about?: string | null;
  /** `page:task/<id>/<name>`, `page:chat/<name>`, `report:<task>`, `url:<url>`; explicit refs first, then the origin's. */
  evidence: string[];
  raised_by?: string | null;
  raised_at?: string | null;
  /** When its question or options last changed. */
  updated_at?: string | null;
  answer: CallAnswer | null;
  decided: CallDecided | null;
};

/**
 * A project's closed work, a page at a time, exactly as `bin/fm-history.sh --json` prints it: backlog rows in the
 * snapshot's shape, newest first, from the backlog and its archive, with the calls among them.
 */
export type ProjectHistory = {
  schema: string;
  repo: string | null;
  records: BacklogRecord[];
  calls: Call[];
  /** Pass as `after` for the next page; null on the last. */
  next: string | null;
  archive: { present: boolean; readable: boolean };
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
  /** `s<epoch seconds>.<pid>.<random>`, new on every spawn or relaunch, so it says when this worker started. */
  spawn_gen?: string | null;
  current_state: { state: string; source: string; detail: string; raw: string; observed_at: string; freshness: string };
  endpoint: { target: string; exists: boolean; agent_alive: string; status: string; observed_at: string; freshness: string };
  pr: { url: string | null; source: string };
  hints: { pending_decision: boolean; blocked_event: boolean; open_decisions: unknown[]; scout_report_present: boolean; last_event_text: string };
  actions: { watch: string; steer: string; return_channel_note: string | null };
};

/** A layout problem firstmate's pre-present check found in a page, at its wide (1280px) or narrow (500px) window. */
export type ArtifactLayoutIssue = { viewport: "wide" | "narrow"; rule: string; selector: string; detail: string };

/** One presented revision, as `bin/fm-artifact.sh list --json` reports it. Revisions never change once presented. */
export type ArtifactRevision = {
  scope: "task" | "chat";
  task: string | null;
  name: string;
  rev: number;
  title: string;
  /** What changed since the previous revision, in the presenter's words. */
  note: string | null;
  /** The page's file name inside the revision. */
  entry: string;
  bytes: number;
  presented_at: string;
  presented_by: { role: "crew"; task: string } | { role: "firstmate" };
  /** `accepted`: presented despite findings the presenter said were intentional. `skipped`: no browser was there to check. */
  layout?: { status: "clean" | "accepted" | "skipped"; reason?: string; issues: ArtifactLayoutIssue[] };
  /** What the author says this revision does about the captain's comments. Whether one is settled stays the captain's call. */
  answers?: { addressed: string[]; replies: { thread: string; body: string }[] };
};

/** Where a comment sits on the page: the words themselves, a little text either side, and a fallback path. */
export type ReviewAnchor = { quote: string; prefix: string; suffix: string; path: string };
/** A thread on a diagram the page owns: the scene is the thing being changed, not a quote. */
export type SceneAnchor = { scene: string; label: string; path: string; quote: string; scene_file: string; picture: string | null; /** Only the browser mock, which has no home to serve the picture from. */ preview?: string };
export type ReviewComment = { body: string; at: number };
/** One place on the page the captain wrote about. `sent_at` is null while it is still a draft. */
/** `draft` until the review goes, then `open` until the captain settles it. */
export type ReviewThreadState = "draft" | "open" | "resolved";
export type ReviewThread = { id: string; rev: number; anchor: ReviewAnchor | SceneAnchor | null; at: number; sent_at: number | null; resolved_at: number | null; state: ReviewThreadState; comments: ReviewComment[] };
export type ReviewVerdict = "approve" | "changes" | "comment";
export type ReviewSent = { at: number; verdict: ReviewVerdict; rev: number; message: string; threads: string[] };
/** What firstmate's intake did with an answer: `closed` is recorded; anything else is not. */
export type IntakeResult = "closed" | "skipped" | "not_recorded";
export type IntakeOutcome = { call: string; result: IntakeResult; detail: string };
/**
 * The captain's choice on a call the page argues. Staged until the review is sent, when firstmate's intake records
 * it (`recorded`); `sent_at` is when the first mate was told.
 */
export type ReviewAnswer = { decision: string; option: string; label: string; on_answer?: string | null; at: number; sent_at: number | null; recorded?: { result: IntakeResult; detail: string; at: number } | null };
/** What sending a review did: the message (null if it could not go), and what the intake did with each answer. */
export type ReviewSubmitted = { message: string | null; text: string; review: ReviewView; outcomes?: IntakeOutcome[]; warning?: string };
/** What answering a call from Bearings did. `message` is null when nothing was told to the first mate. */
export type CallAnswered = { outcome: IntakeOutcome; message: string | null; text: string | null; review: ReviewView | null; warning?: string };
/** What the list needs about a page's review, keyed `task/<id>/<name>` or `chat/<name>`. */
export type ReviewSummary = Record<string, {
  seen_rev: number | null;
  draft_count: number;
  open_count: number;
  answered: string[];
  /** Each sent comment the captain has not settled, with the revision it was written on, so a later revision can answer it. */
  open_threads?: { id: string; rev: number }[];
}>;

/** The whole review of one page, as the app stores it beside the revisions. */
export type ReviewView = { threads: ReviewThread[]; answers: ReviewAnswer[]; draft_count: number; staged_answers: number; open_count: number; sent: ReviewSent[]; seen_rev: number | null; log: string };
/** One answer given from Bearings: the call, the option, what the call declares, and the page that argues it. */
export type CallAnswerRequest = { call: string; option: string; label: string; onAnswer: string; page: ArtifactRef | null; note?: string };
/** Which page a review belongs to. */
export type ArtifactRef = { scope: "task" | "chat"; task: string | null; name: string };

/** A page the first mate or a worker presented for review, with every revision oldest first. */
export type Artifact = {
  scope: "task" | "chat";
  task: string | null;
  name: string;
  title: string;
  latest: ArtifactRevision;
  revisions: ArtifactRevision[];
};

export type FleetSnapshot = {
  schema: string;
  generated: string;
  fm_home: string;
  backlog?: { records: BacklogRecord[] };
  tasks: FleetTask[];
  /** Absent from homes whose firstmate predates `bin/fm-artifact.sh`. */
  artifacts?: Artifact[];
  /**
   * Every open call, and every call closed in the last 7 days. The one source of truth for calls; absent from homes
   * whose firstmate predates it, which show Bearings' own list instead.
   */
  calls?: Call[];
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
  /** While a first mate runs: its session's conversation so far, for a window that opened after the start sent its history. */
  conversation?: { sessionId: string; items: HistoryItem[] } | null;
};

/** The captain's firstmate home: `home` once chosen and still valid, `problem` when a choice doesn't check out. */
export type HomeStatus = { home: string | null; problem: string | null; /** The captain left the first mate running in this home when the app last closed, so the app starts it again. */ startOnLaunch?: boolean };

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
  /** A page of a project's closed work, newest first; `null` from a firstmate that cannot list it. */
  projectHistory(repo: string, options?: { after?: string | null; limit?: number }): Promise<ProjectHistory | null>;
  getHome(): Promise<HomeStatus>;
  /** Asks the captain for the folder; `null` when they cancel. */
  chooseHome(): Promise<HomeStatus | null>;
  refreshSnapshot(): Promise<void>;
  /** The last finished snapshot, for a window that subscribed after it was emitted. Waits for a read in progress. */
  latestSnapshot(): Promise<SnapshotEvent | null>;
  answerPermission(id: string, optionId: string): Promise<void>;
  /** Where the review frame loads a revision's page from. Its relative links resolve inside the same revision. */
  artifactUrl(revision: ArtifactRevision): string;
  /** The review of one page: every thread, and what has been sent. */
  reviewGet(ref: ArtifactRef): Promise<ReviewView>;
  /** Opens a thread on the page, or adds to one. Local until the review is sent. */
  reviewComment(ref: ArtifactRef, rev: number, body: string, anchor?: ReviewAnchor, thread?: string): Promise<ReviewView>;
  /** Takes back a thread that has not been sent. */
  reviewDiscard(ref: ArtifactRef, thread: string): Promise<ReviewView>;
  /** Records the staged answers through firstmate's intake, then sends the whole draft to the first mate as one message. */
  reviewSubmit(ref: ArtifactRef, rev: number, verdict: ReviewVerdict): Promise<ReviewSubmitted>;
  /** Files a proposed diagram beside the review and opens a thread for it. */
  reviewScene(ref: ArtifactRef, rev: number, scene: string, label: string, path: string, summary: string, sceneJson: string, png: string): Promise<ReviewView>;
  /** Stages the captain's choice on a call, or takes it back with no option. `onAnswer` is what the call declares. */
  reviewAnswer(ref: ArtifactRef, decision: string, option?: string, label?: string, onAnswer?: string | null): Promise<ReviewView>;
  /**
   * Answers one call now, from Bearings: firstmate's intake records it (noted in the review of `page`, the page that
   * argues it, when there is one), and only a recorded answer is told to the first mate.
   */
  callAnswer(answer: CallAnswerRequest): Promise<CallAnswered>;
  /** Settles a sent comment, or opens it again. */
  reviewSettle(ref: ArtifactRef, thread: string, resolved: boolean): Promise<ReviewView>;
  /** Remembers that the captain has looked at a revision, so a later one reads as new. */
  reviewSeen(ref: ArtifactRef, rev: number): Promise<ReviewView>;
  /** Every page's review at a glance, for the list. */
  reviewSummary(): Promise<ReviewSummary>;
}

/** The path both adapters serve a revision's page under: `task/<id>/<name>/rev-<n>/<entry>` or `chat/<name>/rev-<n>/<entry>`. */
export function artifactPath(revision: ArtifactRevision) {
  const owner = revision.scope === "task" && revision.task ? `task/${encodeURIComponent(revision.task)}` : "chat";
  return `${owner}/${encodeURIComponent(revision.name)}/rev-${revision.rev}/${encodeURIComponent(revision.entry)}`;
}
