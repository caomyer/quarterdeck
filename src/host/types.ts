import type { CopyResult, PickResult } from "../attachments";

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
  /** The items elsewhere this task is linked to, read from its body; absent from homes whose firstmate predates task sources. */
  source_links?: SourceLink[];
};

/** One link from a task to an item in a task source: the source, the item's immutable id, and what the task does for it. */
export type SourceLink = { source: string; item: string; role: "fulfills" | "contributes" };

/** An item's state in its source's own workflow, reduced to the four every provider maps onto. */
export type SourceItemState = "open" | "started" | "done" | "cancelled";

/** What an item said when a task was linked to it, kept so a later edit upstream shows beside it. */
export type SourceFiled = { item: string; key: string; url: string; title: string; body: string; state: SourceItemState; state_name: string; assignee: string | null; updated_at: string; filed_at: string; task: string };

/**
 * An item as `bin/fm-sources.sh` last read it. Its key and URL are display labels, refreshed on every read; only its
 * id is stored in a link. Its title and body were written by whoever filed it upstream: text to show, never to act on.
 */
export type SourceItem = {
  id: string; key: string; url: string; title: string; body: string; state: SourceItemState; state_name: string;
  assignee: string | null; updated_at: string; deleted: boolean; matches?: boolean; seen_at?: string;
  /** The copy taken when a task here was linked to it; null when that copy was lost with the cache. */
  filed: SourceFiled | null;
};

/** A write the fleet owes or made upstream, keyed by the id derived from its source, item, task and milestone. */
export type SourceWrite = {
  write_id: string; item: string; task: string; intent: "started" | "in-review" | "delivered" | "stopped"; pr?: string | null;
  /** When it was confirmed, for a write made; `created`, `attempts` and `last_error` for one still owed. */
  at?: string; created?: string; attempts?: number; last_error?: { code: string; detail: string; at: string } | null;
  advance?: { result: string; from: string | null; to: string | null; candidates: string[] } | null;
  comment_id?: string; deduplicated?: boolean; superseded?: boolean; withheld?: string;
};

/** A source that failed to read with a typed reason, which only wakes anyone once it persists. A read cut short is never one. */
export type SourceFailure = { code: string; detail: string; first_at: string; last_at: string; count: number; retry_at: string | null; woke: boolean };

/** One connected task source, as `bin/fm-sources.sh status` reports it. */
export type TaskSource = {
  id: string; provider: string; locator: string; project: string; filter: string;
  outbound: "none" | "comments" | "comments+status"; review_state: string | null; added: string;
  identity: string | null; can: { read: boolean; comment: boolean; advance: boolean } | null; reach: string[];
  last_read: string | null; reading_more: boolean; stale: boolean; failure: SourceFailure | null;
  items: Record<string, SourceItem>; filed: Record<string, SourceFiled>; offers: string[];
  outbox: SourceWrite[]; sent: SourceWrite[];
  /** The linked tasks that closed as a delivery, by firstmate's own rule; a Done row not named here delivered nothing. */
  landed?: string[];
  events: { token: string; item: string; key: string | null; kind: string; at: string; tasks: { id: string; state: string; role: string }[] }[];
};

/** Every source in a home. `problem` says why they could not be read; `unsupported`, that its firstmate cannot connect any. */
export type SourcesRead = { schema?: string; read_at?: string; first_milestone?: string; sources: TaskSource[]; problem?: string; unsupported?: boolean };

/** What taking an item on asks: the item as its source names it, and the captain's optional note. */
export type TakeOnRequest = { source: string; item: string; key: string; project: string; title: string; note?: string | null };

/**
 * One ask to take an item on, as `src-tauri/src/start.rs` records it beside the start asks: keyed by item, because
 * no task exists until the first mate files it.
 */
export type TakeOnAsk = {
  at: number; kind: "take-on"; task: null; item: { source: string; id: string; key: string }; project: string; title: string;
  note: string | null; message: string | null; error: string | null; header: string; text: string;
};

/** A file a task carries, as `bin/fm-task-note.sh show --json` names it: its clean name, where it is, and what it was called. */
export type TaskFile = { name: string; path: string; bytes: number; original: string };

/** One note on a task: evidence, a change of scope, or a decision about the work, for whoever works it. */
export type TaskNote = { id: string; at: string; by: string; scope: boolean; body: string; files: TaskFile[] };

/** Every note a task carries, oldest first, as `bin/fm-task-note.sh show --json` prints them. */
export type TaskNotes = { schema: string; task: string; notes: TaskNote[] };

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

/**
 * The captain's words on a call that nothing has recorded yet, kept by `bin/fm-captain-hold.sh reply`: words, a dated
 * not now, or an option the call cannot take by key. It records that the captain replied, never what he decided, and
 * only the first mate acting clears it, by recording an answer, asking again, or holding the call.
 */
export type CallReply = {
  words: string;
  /** `quarterdeck`: a Bearings card. `review`: a page's review. `chat`. */
  via: string;
  at: string;
  /** The message that carried the words to the first mate, or null when none has. */
  message: string | null;
  /** The reply this one replaced, while nothing has cleared it. */
  previous?: Omit<CallReply, "previous"> | null;
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
  /**
   * The earliest day Not now can name, `yyyy-mm-dd`: the day after the captain's day. Set by `homeCalls` from the
   * snapshot, never by firstmate; absent when the snapshot carries no captain's day.
   */
  ask_again_from?: string;
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
  /** The captain's reply while the call is open and nothing has recorded it; absent from a firstmate that predates replies. */
  reply?: CallReply | null;
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

/** A rectangle in the page's CSS pixels, measured from its top left. */
export type PageBox = { x: number; y: number; w: number; h: number };
/** Why the words alone may not say which place the captain meant, so a picture goes with the comment. */
export type PictureReason = "repeated" | "opened" | "wordless";
/**
 * Where a comment sits on the page: the words themselves, a little text either side, and a fallback path. A place
 * picked since the page could describe itself also carries which match of the words it is, the element by what it
 * is, the labels around it, where it sat, the window it was seen in, and why words alone may not be enough.
 * `src-tauri/src/review-frame.js` owns what each part means.
 */
export type ReviewAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  path: string;
  occurrence?: { n: number; of: number; shown: number } | null;
  element?: string;
  near?: string;
  box?: PageBox;
  point?: { x: number; y: number };
  view?: { w: number; h: number; scroll_y: number; scheme: "light" | "dark" };
  reasons?: PictureReason[];
};
/** What the page drew around a picked place: a small JPEG, which part of the page it shows, and how long it took. */
export type PagePicture = { jpeg: string; crop: PageBox; took_ms: number };
/** What goes with a new comment about its picture: the picture, or why there is none although one was due. */
export type CommentPicture = PagePicture | { skipped: string };
/** The picture a sent or saved thread keeps beside its review, as a file name under `review-files/`. */
export type ThreadPicture = { file: string; crop: PageBox; method: "redraw"; took_ms: number; bytes: number };
/** A thread on a diagram the page owns: the scene is the thing being changed, not a quote. */
export type SceneAnchor = { scene: string; label: string; path: string; quote: string; scene_file: string; picture: string | null; /** Only the browser mock, which has no home to serve the picture from. */ preview?: string };
export type ReviewComment = { body: string; at: number };
/** One place on the page the captain wrote about. `sent_at` is null while it is still a draft. */
/** `draft` until the review goes, then `open` until the captain settles it. */
export type ReviewThreadState = "draft" | "open" | "resolved";
export type ReviewThread = { id: string; rev: number; anchor: ReviewAnchor | SceneAnchor | null; at: number; sent_at: number | null; resolved_at: number | null; state: ReviewThreadState; comments: ReviewComment[]; picture?: ThreadPicture | null; picture_skipped?: string | null; /** Only the browser mock, which has no home to serve the picture from. */ picture_preview?: string };
export type ReviewVerdict = "approve" | "changes" | "comment";
export type ReviewSent = { at: number; verdict: ReviewVerdict; rev: number; message: string; threads: string[]; /** The message's first line; absent in reviews sent before it was kept. */ header?: string | null; answers?: string[] | SentAnswer[] };
/** A sent comment as the chat shows it. */
export type SentThread = { id: string; rev: number; state: ReviewThreadState; quote: string; said: string; picture: boolean };
/** An answer a review carried: an option the intake recorded, or, with no option, the captain's words for the first mate to record. */
export type SentAnswer = { decision: string; option: string | null; label: string | null; note?: string | null; defer?: string | null };
/** A review as the chat shows it: what went, and the answers it carried. */
export type SentReview = { at: number; verdict: ReviewVerdict; rev: number; message: string; header?: string | null; threads: string[]; answers: SentAnswer[] };
/** What firstmate's intake did with an answer: `closed` is recorded; anything else is not. */
export type IntakeResult = "closed" | "skipped" | "not_recorded";
export type IntakeOutcome = { call: string; result: IntakeResult; detail: string };
/**
 * The captain's answer to a call the page argues. Staged until the review is sent. An option goes through
 * firstmate's intake (`recorded`), with anything the captain added in `note`; with no option, `note` is the answer
 * in words, or `defer` the date to be asked again on, and the first mate records it. `sent_at` is when the first
 * mate was told.
 */
export type ReviewAnswer = { decision: string; option: string | null; label: string | null; on_answer?: string | null; note?: string | null; defer?: string | null; at: number; sent_at: number | null; recorded?: { result: IntakeResult; detail: string; at: number } | null; /** Whether firstmate kept an answer in words on its call as the captain's reply, as the review went. */ reply?: { result: "kept" | "not_kept"; detail: string } | null };
/** What the captain said in words with an answer: anything added to an option, or, with none, the answer itself, or a date. */
export type AnswerWords = { note?: string; defer?: string };
/** What sending a review did: the message (null if it could not go), and what the intake did with each answer. */
export type ReviewSubmitted = { message: string | null; text: string; review: ReviewView; outcomes?: IntakeOutcome[]; warning?: string };
/** What replying to a call from Bearings did: kept on the call or not, and whether the first mate was told. */
export type CallReplied = { kept: boolean; problem?: string; message: string | null; text: string | null; warning?: string };
/** What answering a call from Bearings did. `message` is null when nothing was told to the first mate. */
export type CallAnswered = { outcome: IntakeOutcome; message: string | null; text: string | null; review: ReviewView | null; warning?: string };
/** What the list needs about a page's review, keyed `task/<id>/<name>` or `chat/<name>`. */
export type ReviewSummary = Record<string, {
  seen_rev: number | null;
  draft_count: number;
  open_count: number;
  /** Calls whose answer the intake recorded: on the record for good. */
  answered: string[];
  /** Each sent comment the captain has not settled, with the revision it was written on, so a later revision can answer it. */
  open_threads?: { id: string; rev: number }[];
  /** Each review sent, and every comment sent, so the chat can draw a review as a card rather than its text. */
  sent?: SentReview[];
  threads?: SentThread[];
}>;

/** The whole review of one page, as the app stores it beside the revisions. */
export type ReviewView = { threads: ReviewThread[]; answers: ReviewAnswer[]; /** For each decision, the single most recent answer that went for the first mate to record and was followed by a new one: what the captain said then. */ earlier: ReviewAnswer[]; draft_count: number; staged_answers: number; open_count: number; sent: ReviewSent[]; seen_rev: number | null; log: string };
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
  /**
   * The captain's day at `generated`, `yyyy-mm-dd`, from the one owner firstmate keeps (`bin/fm-backlog-parse-lib.sh`).
   * Absent from a firstmate that predates it.
   */
  captain_day?: string;
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
  /** The main home's inventory checks; `orphan_in_flight` names in-flight backlog rows no worker is registered for. */
  main_inventory?: { valid: boolean; reason: string | null; orphan_in_flight: string[]; unstructured_current_count: number };
  /** The task sources connected in this home, or why they could not be read; absent from homes whose firstmate predates them. */
  sources?: SourcesRead | { error: string };
};

/** How the captain says a task should ship: `judge` leaves it to the first mate, by the project's posture. */
export type StartMode = "judge" | "no-mistakes" | "direct-PR";

/**
 * One ask to start a queued task, as `src-tauri/src/start.rs` records it in `data/.starts/asks.jsonl`: what was
 * asked, and the id the host gave the message, or why it did not take it. The latest per task is its ask.
 */
export type StartAsk = {
  at: number;
  task: string;
  project: string;
  title: string;
  kind: string;
  mode: StartMode;
  note: string | null;
  message: string | null;
  error: string | null;
  header: string;
  text: string;
};

/** What starting work asks for: the task as its row names it, and the captain's optional mode and note. */
export type StartRequest = { task: string; project: string; title: string; kind: string; mode: StartMode; note?: string | null };

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
  | { type: "usage"; payload: UsageEvent }
  | { type: "compact"; payload: CompactEvent }
  | { type: "permission"; payload: Record<string, unknown> }
  | { type: "permission_request"; payload: PermissionRequest }
  | { type: "permission_resolved"; payload: { id: string; option_id: string } }
  | { type: "host_health"; payload: { warning?: string; rewake_storm?: boolean; [key: string]: unknown } }
  | { type: "snapshot"; payload: SnapshotEvent };

/** The first mate's context window, as the host reads the adapter's usage updates. `null`s until the first reading. */
export type ContextReading = {
  used: number | null;
  size: number | null;
  at_ms: number | null;
  /** The session was resumed, so its readings already carry the earlier conversation. */
  resumed: boolean;
  /** The last compaction: the size it compacted from, what it left, and when. */
  compacted: { from: number; to: number; at_ms: number } | null;
};

/** The adapter's `_claude/rateLimit`: the Claude plan limit the first mate runs under, as its session last reported it. */
export type RateLimit = {
  status?: "allowed" | "allowed_warning" | "rejected" | string;
  rateLimitType?: string;
  /** Seconds since the epoch. */
  resetsAt?: number;
  /** When the host received it, in milliseconds. */
  at_ms?: number;
};

/** A usage update: the adapter's own, with the host's reading of it. Recordings made before the host read it carry `update` alone. */
export type UsageEvent = {
  at_ms?: number;
  update: { used?: number; size?: number; cost?: { amount: number; currency: string }; _meta?: Record<string, unknown> };
  context?: ContextReading;
  rate_limit?: RateLimit | null;
};

/** How a `/compact` the captain sent is going: handed to the first mate, running once any turn before it ended, then done or failed. */
export type CompactEvent = { id: string; state: "sent" | "running" | "done" | "failed"; error?: string; context?: ContextReading };

/** One of a provider's limit windows, as quota-axi reports it. */
export type QuotaWindow = { id: string | null; label: string | null; kind: string | null; used: number | null; resets_at: string | null };

/** One provider's plan limits, in quota-axi's own terms. */
export type QuotaProvider = {
  id: string | null;
  label: string | null;
  plan: string | null;
  /** `fresh`, `stale`, `auth_required`, `unavailable`, `rate_limited` or `error`. */
  status: string;
  stale: boolean;
  refreshed_at: string | null;
  /** quota-axi's words for what is wrong, when something is. */
  error: string | null;
  reason: string | null;
  /** The command quota-axi says fixes it. */
  remedy: string | null;
  /** How sure quota-axi is of the account's reading: `established`, `early` or `unknown`. */
  confidence: string | null;
  windows: QuotaWindow[];
};

/**
 * A read of every provider's plan limits. After a failed read, `providers` are the last good read's, from `read_at_ms`,
 * and `error` says why this one failed. `missing` when quota-axi is not installed.
 */
export type QuotaRead = { providers: QuotaProvider[] | null; read_at_ms: number | null; error: string | null; missing: boolean };

/**
 * The app's own update, from the backend's `update_*` commands and `app_update` event. `ready`: downloaded, verified
 * and waiting for the captain; `waiting`: the restart they asked for waits for the first mate's turn to end;
 * `failed`: installing failed and the update is still held, so asking again retries. `installed` is what the last
 * update brought, while its version is the one running, until the captain has read it.
 *
 * The rest is the looking, the schedule's and the captain's alike: `enabled` is false in a build that never looks,
 * `checking` while a check runs, `downloading` the version it found and is fetching, and `checked_at_ms` and
 * `check_error` when the last check ended and why it failed.
 */
export type AppUpdate = {
  state: "none" | "ready" | "waiting" | "installing" | "failed";
  current: string;
  version: string | null;
  notes: string | null;
  error: string | null;
  installed: { version: string; from: string | null; notes: string | null } | null;
  enabled: boolean;
  checking: boolean;
  downloading: string | null;
  checked_at_ms: number | null;
  check_error: string | null;
};

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
  /** The context window and the Claude plan limit as last reported, for a window that opened after them. */
  usage?: { context: ContextReading | null; rateLimit: RateLimit | null };
};

/** The captain's firstmate home: `home` once chosen and still valid, `problem` when a choice doesn't check out. */
export type HomeStatus = { home: string | null; problem: string | null; /** The captain left the first mate running in this home when the app last closed, so the app starts it again. */ startOnLaunch?: boolean; /** True when this is a folder the captain chose, false when it is the home the app owns. */ chosen?: boolean };

/** One thing the first mate says this machine still needs. */
export type Needed = {
  /** The tool's name, or null for a line that names no tool. */
  tool: string | null;
  /** The command that installs it, a page that explains it, or null. */
  how: string | null;
  kind: "install" | "manual" | "other";
  /** The first mate's own words, shown when the app has nothing better. */
  says: string;
};

/**
 * Crew routing in the home: rules for which tool and model does which kind of work, as firstmate's own
 * `bin/fm-crew-dispatch.sh` reports it. Off means there is no rules file and the first mate chooses for itself.
 */
export type Routing = {
  /** False when this home's firstmate cannot set routing up; `problem` says why, and also why the rules could not be read while routing is on. */
  available: boolean;
  problem: string | null;
  on: boolean;
  /** The rules file as it is on disk; `null` while routing is off. */
  rules: string | null;
  /** The digest of `rules`, handed back with a save so a file someone else changed meanwhile is not overwritten. */
  sha256: string | null;
  /** Why the first mate cannot use the rules, in the words its own startup check reports; `null` when it can. */
  invalid: string | null;
  /** Whether a typed dispatch key is set, and where from. The key itself never comes back. */
  key: { set: boolean; source: "environment" | ".env" | null };
  /** The rules turning routing off last set aside, which turning it on can bring back. */
  setAside: string | null;
  /** The harnesses a rule may name, as firstmate lists them; empty from a firstmate that cannot list them. */
  harnesses: HarnessChoice[];
  /** The example rules firstmate ships, for turning routing on and for model suggestions. */
  template: string | null;
};

/** A harness a rule may name: whether this Mac has it, and the efforts it takes. */
export type HarnessChoice = {
  name: string;
  installed: boolean;
  /** `needs` is the model an effort is bound to: exact, or a prefix ending in `*` with something after it. */
  efforts: { effort: string; needs: string | null }[];
};

/** Where a newly turned-on routing's rules come from: the shipped example, none yet, or the rules set aside when it was turned off. */
export type RoutingStart = "template" | "empty" | "restore";

export type PaneCapture = { text: string; observed_at?: string };
export type HostEventListener = (event: HostEvent) => void;

export interface HostAdapter {
  subscribe(listener: HostEventListener): () => void;
  hostStart(home: string): Promise<void>;
  hostStop(): Promise<void>;
  hostRestart(): Promise<void>;
  send(text: string): Promise<string>;
  /**
   * Asks the captain for files and checks each can be attached, copying nothing. `null` when they cancel; a file that
   * cannot be attached comes back in `refused`, with why.
   */
  pickFiles(): Promise<PickResult | null>;
  /**
   * Copies picked files into the chosen home as the message naming them is sent. All or nothing: if one cannot go,
   * none is copied and `refused` says why.
   */
  copyFiles(sources: string[]): Promise<CopyResult>;
  cancelTurn(): Promise<void>;
  getState(): Promise<HostStateSnapshot>;
  paneCapture(taskId: string): Promise<PaneCapture>;
  /** A task's notes, oldest first; `null` from a firstmate that cannot keep them. */
  taskNotes(taskId: string): Promise<TaskNotes | null>;
  /**
   * Adds the captain's note to a task through firstmate's writer: words, files the captain picked, or both. Returns
   * the task's notes after it; a refusal rejects with the reason.
   */
  taskNoteAdd(taskId: string, body: string, sources: string[]): Promise<TaskNotes>;
  /** Where a picture a task carries is shown from. */
  taskFileUrl(taskId: string, file: TaskFile): string;
  /** A page of a project's closed work, newest first; `null` from a firstmate that cannot list it. */
  projectHistory(repo: string, options?: { after?: string | null; limit?: number }): Promise<ProjectHistory | null>;
  getHome(): Promise<HomeStatus>;
  /** Asks the captain for the folder; `null` when they cancel. */
  chooseHome(): Promise<HomeStatus | null>;
  /** Forgets a chosen folder, so the app runs the first mate in the home it owns. */
  useAppHome(): Promise<HomeStatus>;
  /** What the first mate says this machine still needs. Reads only; changes nothing. */
  toolsMissing(): Promise<{ missing: Needed[]; problem: string | null }>;
  /** Where crew routing stands in the chosen home. */
  routingGet(): Promise<Routing>;
  /** Turns routing on. Refused, with why, when it already is. */
  routingEnable(from: RoutingStart): Promise<Routing>;
  /** Replaces the rules. Refused, with firstmate's reason, when they are not valid or the file changed since `sha256`. */
  routingSave(rules: string, sha256: string | null): Promise<Routing>;
  /** Turns routing off by setting the rules aside; nothing is deleted. */
  routingDisable(): Promise<Routing>;
  /** Stores the optional typed dispatch key in the home. Write-only: the reply says only that a key is set. */
  routingSetKey(key: string): Promise<Routing>;
  routingClearKey(): Promise<Routing>;
  /** Every provider's plan limits, from quota-axi. Reads only. */
  readQuota(): Promise<QuotaRead>;
  /** Reads plan limits once with quota-axi allowed to ask macOS for Claude's Keychain item. Only when the captain asks. */
  allowQuotaKeychain(): Promise<QuotaRead>;
  /** Where the app's own update stands. Reads only. */
  updateStatus(): Promise<AppUpdate>;
  /** Looks for an update now, as the schedule does, without moving it. Answers at once, already checking; asked while a check runs, it joins that one. */
  updateCheck(): Promise<AppUpdate>;
  /** Restarts into the waiting update once the first mate is not in a turn. Answers at once; `onUpdate` says how it goes. */
  updateRestart(): Promise<AppUpdate>;
  /** Takes back a restart still waiting for a turn to end. */
  updateCancel(): Promise<AppUpdate>;
  /** The captain has read what the last update changed. */
  updateSeen(): Promise<AppUpdate>;
  /** Every change to the update's status. Returns what stops listening. */
  onUpdate(listener: (update: AppUpdate) => void): () => void;
  refreshSnapshot(): Promise<void>;
  /** The last finished snapshot, for a window that subscribed after it was emitted. Waits for a read in progress. */
  latestSnapshot(): Promise<SnapshotEvent | null>;
  answerPermission(id: string, optionId: string): Promise<void>;
  /** Where the review frame loads a revision's page from. Its relative links resolve inside the same revision. */
  artifactUrl(revision: ArtifactRevision): string;
  /** The review of one page: every thread, and what has been sent. */
  reviewGet(ref: ArtifactRef): Promise<ReviewView>;
  /** Opens a thread on the page, or adds to one. Local until the review is sent. */
  reviewComment(ref: ArtifactRef, rev: number, body: string, anchor?: ReviewAnchor, thread?: string, picture?: CommentPicture): Promise<ReviewView>;
  /** Takes back a thread that has not been sent. */
  reviewDiscard(ref: ArtifactRef, thread: string): Promise<ReviewView>;
  /** Records the staged answers through firstmate's intake, then sends the whole draft to the first mate as one message. */
  reviewSubmit(ref: ArtifactRef, rev: number, verdict: ReviewVerdict): Promise<ReviewSubmitted>;
  /** Files a proposed diagram beside the review and opens a thread for it. */
  reviewScene(ref: ArtifactRef, rev: number, scene: string, label: string, path: string, summary: string, sceneJson: string, png: string): Promise<ReviewView>;
  /**
   * Stages the captain's answer to a call: an option, with any words added, or words alone, or not now until a date.
   * Nothing at all takes it back. `onAnswer` is what the call declares.
   */
  reviewAnswer(ref: ArtifactRef, decision: string, option?: string, label?: string, onAnswer?: string | null, words?: AnswerWords): Promise<ReviewView>;
  /**
   * Answers one call now, from Bearings: firstmate's intake records it (noted in the review of `page`, the page that
   * argues it, when there is one), and only a recorded answer is told to the first mate.
   */
  callAnswer(answer: CallAnswerRequest): Promise<CallAnswered>;
  /**
   * Replies to one call from Bearings in the captain's words: firstmate keeps them on the call through its `reply`, and
   * only then is the first mate told, naming the call. Words firstmate would not keep send nothing.
   */
  callReply(call: string, words: string): Promise<CallReplied>;
  /** Settles a sent comment, or opens it again. */
  reviewSettle(ref: ArtifactRef, thread: string, resolved: boolean): Promise<ReviewView>;
  /** Remembers that the captain has looked at a revision, so a later one reads as new. */
  reviewSeen(ref: ArtifactRef, rev: number): Promise<ReviewView>;
  /** Every page's review at a glance, for the list. */
  reviewSummary(): Promise<ReviewSummary>;
  /**
   * Hands a queued task to the first mate in one message and records the ask. A message the host did not take is
   * recorded with why, in `error`; only a failure to record rejects.
   */
  startWork(request: StartRequest): Promise<StartAsk>;
  /** Every task's latest ask in the home, by task id. */
  startAsks(): Promise<Record<string, StartAsk>>;
  /** Hands an item from a task source to the first mate to file as a queued task: one message on the start-work path. */
  takeOn(request: TakeOnRequest): Promise<TakeOnAsk>;
  /** Every item's latest take-on ask in the home, keyed `<source> <item id>`. */
  takeOnAsks(): Promise<Record<string, TakeOnAsk>>;
  /** Every task source in the chosen home, through `bin/fm-sources.sh`. Reads only. */
  sourcesGet(): Promise<SourcesRead>;
  /** Connects a source. Refused, in firstmate's words, when the sign-in cannot do what was asked or the filter is not one it reads. */
  sourcesAdd(provider: string, locator: string, project: string, filter: string, outbound: TaskSource["outbound"]): Promise<SourcesRead>;
  sourcesEdit(source: string, change: { filter?: string; outbound?: TaskSource["outbound"] }): Promise<SourcesRead>;
  /** Disconnects a source. Its links, owed writes and signals are kept for when it is connected again. */
  sourcesRemove(source: string): Promise<SourcesRead>;
  /** Not now: the item is not offered again until it changes upstream. */
  sourcesDismiss(source: string, item: string): Promise<SourcesRead>;
  /** Links a task that exists to an item, by its link or key. Refused, in firstmate's words, when it cannot be resolved. */
  sourcesLink(task: string, reference: string): Promise<unknown>;
}

/** The path both adapters serve a revision's page under: `task/<id>/<name>/rev-<n>/<entry>` or `chat/<name>/rev-<n>/<entry>`. */
export function artifactPath(revision: ArtifactRevision) {
  const owner = revision.scope === "task" && revision.task ? `task/${encodeURIComponent(revision.task)}` : "chat";
  return `${owner}/${encodeURIComponent(revision.name)}/rev-${revision.rev}/${encodeURIComponent(revision.entry)}`;
}
