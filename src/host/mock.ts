import bearingsFixture from "../fixtures/bearings-snapshot.json";
import fleetFixture from "../fixtures/fleet-snapshot.json";
import type { CopyResult, PickResult } from "../attachments";
import recordedStream from "./mock-event-stream.json";
// The example firstmate ships, read from the engine itself, so turning routing on here starts from the same rules.
import crewDispatchExample from "../../engine/docs/examples/crew-dispatch.json?raw";
import { MockUpdates } from "./mock-update";
import { mockUsage } from "./mock-usage";
import lockScreenPicture from "../fixtures/task-files/lock-screen.svg?url";
import { artifactPath } from "./types";
import type {
  AnswerWords,
  AppUpdate,
  Artifact,
  ArtifactRef,
  BacklogRecord,
  Call,
  CallAnswerRequest,
  ContextReading,
  IntakeOutcome,
  ArtifactRevision,
  BearingsSnapshot,
  FleetSnapshot,
  FleetTask,
  HistoryItem,
  HomeStatus,
  Needed,
  HostAdapter,
  HostEvent,
  HostEventListener,
  HostRuntimeState,
  HostStateSnapshot,
  OutboxStatus,
  PaneCapture,
  ProjectHistory,
  QuotaRead,
  TaskFile,
  TaskNote,
  TaskNotes,
  ReasonKind,
  CommentPicture,
  ReviewAnchor,
  ReviewSummary,
  ReviewThread,
  ReviewVerdict,
  ReviewView,
  HarnessChoice,
  Routing,
  RoutingStart,
  SnapshotEvent,
  StartAsk,
  StartRequest,
} from "./types";

type RecordedEvent = { t_ms: number; type: HostEvent["type"]; payload: Record<string, unknown> };

declare global {
  interface Window {
    /** `?replay`: a host recording (`recording-latest.jsonl` as an array) for the review to play through the UI. */
    __FM_REPLAY__?: { t_ms: number; type: string; payload: Record<string, unknown> }[];
  }
}

/** `?slow` replays at recorded speed, so a turn stays on screen long enough to review. */
const TIMING_SCALE = reviewFlag("slow") ? 1 : recordedStream.source.timing_scale;

/**
 * What firstmate's `fm-crew-dispatch.sh harnesses` prints on a Mac with claude, codex and pi installed. The real list
 * comes from the engine; this is only the mock's stand-in for it.
 */
const efforts = (...names: string[]) => names.map((name) => {
  const [effort, needs] = name.split("@");
  return { effort, needs: needs ?? null };
});
const FULL = ["low", "medium", "high", "xhigh", "max"];

/** Rules with fields the form keeps but does not edit, at every level they can appear. */
const MOCK_RICH_RULES = `{
  "rules": [
    {
      "when": "The task generates images.",
      "approval": "captain",
      "floor": { "scope": "all_models", "min_percent": 20, "provider": "codex" },
      "use": [
        { "harness": "pi", "model": "openai-codex/gpt-5.6-sol", "provider": "codex" },
        { "harness": "codex", "model": "gpt-5.6-sol", "floor": { "scope": "all_models", "min_percent": 50 } }
      ]
    }
  ],
  "default": { "harness": "claude" },
  "notes": "Kept by hand."
}
`;
const MOCK_HARNESSES: HarnessChoice[] = [
  { name: "claude", installed: true, efforts: efforts(...FULL) },
  { name: "codex", installed: true, efforts: efforts("low", "medium", "high", "xhigh", "max@gpt-5.6-luna") },
  { name: "opencode", installed: false, efforts: [] },
  { name: "pi", installed: true, efforts: efforts(...FULL, "ultra@codex-native/*") },
  { name: "pi-signed", installed: false, efforts: efforts(...FULL, "ultra@codex-native/*") },
  { name: "grok", installed: false, efforts: efforts("low", "medium", "high") },
  { name: "kimi", installed: false, efforts: [] },
  { name: "cursor", installed: false, efforts: [] },
  { name: "agy", installed: false, efforts: efforts("low", "medium", "high") },
  { name: "muse", installed: false, efforts: efforts(...FULL) },
  { name: "rovo", installed: false, efforts: efforts("low", "medium", "high", "max") },
  { name: "omp", installed: false, efforts: efforts(...FULL) },
];

function reviewFlag(name: string) {
  return new URLSearchParams(window.location.search).has(name);
}

function reviewValue(name: string) {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * `?artifacts`: a scout's plan in two revisions (the second presented with a narrow-window finding the scout accepted)
 * and a page the first mate shared in chat, all presented moments ago so they also show in the conversation.
 * The pages live in src/fixtures/review-pages, which only the dev server serves.
 *
 * Around them, a home a day into its work: a scout that has finished and presented its report, a scout that
 * reported without a page and has landed, and the home's calls[]: one page arguing two calls (one whose options
 * changed after the page), a call raised before the page its origin later presented, a call nothing argues, a call
 * the captain answered in chat, and the calls the first mate made for the captain.
 *
 * `?legacy` drops calls[], as a home whose firstmate predates it. `?skip=<call>[,<call>]` has the intake skip those calls.
 * `?usage-t2` adds the captain's own usage-panel mock as its scout presented it, the page his t2 comment was written on:
 * its "under pace" words sit twice in the Claude row, which is shut when the page opens.
 */
/** A calendar day `days` ago where the app runs, as a bare YYYY-MM-DD date. */
function localDate(days: number) {
  const day = new Date(Date.now() - days * 86_400_000);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

const ARTIFACT_TASK = "res-titles-scout";
/** A task the fixture backlog records as done, so its page has somewhere settled to sit. */
const LANDED_TASK = "foreman-rebase-before-review";
/** A scout that finished and presented its report, which the backlog has not closed yet. */
const REPORT_TASK = "res-transcripts-scout";
/** A scout that reported without a page and has landed. */
const REPORTED_TASK = "res-feed-scout";
/** A call the captain answered, argued by a chat page, and closed by the first mate. */
const ANSWERED_CALL = "res-upload-wifi";

/** The scout whose usage-panel mock the captain's t2 comment was written on. */
const USAGE_TASK = "qd-usage-design-1";

/** `?start`: a queued scout and a queued ship, to start from their drawers. */
const START_SCOUT = "res-chapters-scout";
const START_SHIP = "res-waveform-colors";

/** A call nothing argues, so Bearings offers its options inline. */
const UNARGUED_CALL = "foreman-auto-merge";

type MockHome = {
  artifacts: Artifact[];
  tasks: FleetTask[];
  calls: Call[];
  inFlight: BearingsSnapshot["in_flight"];
  records: BacklogRecord[];
  landed: BearingsSnapshot["landed"];
  reports: { id: string; path: string }[];
};

/** A backlog row in the shape fm-fleet-snapshot.sh writes, with only what the app reads filled in. */
function backlogRow(id: string, title: string, fields: Partial<BacklogRecord>): BacklogRecord {
  return {
    id, title, hold_reason: null, current_role: fields.state ?? "in_flight", state: "in_flight", captain_actionable: false,
    kind: "ship", repo: "resonance", hold_kind: null, since: null, completion: { verb: null, date: null }, pr_url: null, report_path: null, body_lines: [], body_excerpt: null,
    ...fields,
  };
}

/** A worker the fleet snapshot reports, spawned `startedMinutesAgo` ago. */
function mockTask(home: string, id: string, kind: string, state: string, startedMinutesAgo: number, fields: { detail: string; note: string; report: boolean; observedAt: string }): FleetTask {
  return {
    id, kind, harness: "claude", mode: kind === "scout" ? "" : "no-mistakes", yolo: kind === "scout" ? "" : "off", project: `${home}/projects/resonance`, backend: "tmux",
    spawn_gen: `s${Math.floor((Date.now() - startedMinutesAgo * 60_000) / 1000)}.4242.17`,
    paths: {
      status_log: { present: true, last_event: { state, note: fields.note, raw: `${state}: ${fields.note}` } },
      worktree: { path: `${home}/worktrees/${id}`, present: true },
      report: { path: `${home}/data/${id}/report.md`, present: fields.report },
    },
    current_state: { state, source: state === "working" ? "pane" : "status-log", detail: fields.detail, raw: `${state}: ${fields.detail}`, observed_at: fields.observedAt, freshness: "fresh" },
    endpoint: { target: `fm:${id}`, exists: true, agent_alive: "alive", status: "alive", observed_at: fields.observedAt, freshness: "fresh" },
    pr: { url: null, source: "none" },
    hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: fields.report, last_event_text: "" },
    actions: { watch: "", steer: "", return_channel_note: null },
  };
}

function mockArtifacts(home: string): MockHome {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const day = (daysAgo: number) => at(daysAgo * 24 * 60).slice(0, 10);
  const plan = (rev: number, minutesAgo: number, note: string | null, layout: ArtifactRevision["layout"]): ArtifactRevision => ({
    scope: "task", task: ARTIFACT_TASK, name: "titles-plan", rev, title: "AI titles for snips", note, entry: "titles-plan.html",
    bytes: 3100 + rev * 600, presented_at: at(minutesAgo), presented_by: { role: "crew", task: ARTIFACT_TASK }, layout,
  });
  const planRevisions = [
    plan(1, 42, null, { status: "clean", issues: [] }),
    plan(2, 3, "Measured the on-device model on an iPhone 12 and added before-and-after titles.", {
      status: "accepted",
      issues: [{ viewport: "narrow", rule: "page-scrolls-sideways", selector: "div.compare > img", detail: "the page is 116px wider than the window" }],
    }),
    // A revision the scout presented answering the captain's first two comments, as `--addressed` and `--reply` record it.
    {
      ...plan(3, 2, "Said what happens when the phone has no room for the model.", { status: "clean", issues: [] }),
      answers: { addressed: ["t1"], replies: [{ thread: "t2", body: "Kept the wide image: seeing both titles side by side is the point." }] },
    },
  ];
  // One page that argues two calls.
  const board: ArtifactRevision = {
    scope: "chat", task: null, name: "model-download", rev: 1, title: "When may the app download the speech model?", note: null,
    entry: "model-download.html", bytes: 2400, presented_at: at(1), presented_by: { role: "firstmate" }, layout: { status: "clean", issues: [] },
  };
  // A page whose task has landed: the list files it away on the backlog's word alone.
  const shipped: ArtifactRevision = {
    scope: "task", task: LANDED_TASK, name: "rebase-plan", rev: 1, title: "Rebase the subject before anybody reads it", note: null,
    entry: "rebase-plan.html", bytes: 1900, presented_at: at(2880), presented_by: { role: "crew", task: LANDED_TASK }, layout: { status: "clean", issues: [] },
  };
  // The finished scout's report, presented a little over a day ago, so it is not in today's conversation.
  const report: ArtifactRevision = {
    scope: "task", task: REPORT_TASK, name: "transcripts-report", rev: 1, title: "Which episodes already carry a transcript?", note: null,
    entry: "transcripts-report.html", bytes: 2200, presented_at: at(25 * 60), presented_by: { role: "crew", task: REPORT_TASK }, layout: { status: "clean", issues: [] },
  };
  // The page that argued a call the captain has since answered and the first mate has closed.
  const uploads: ArtifactRevision = {
    scope: "chat", task: null, name: "uploads-wifi", rev: 1, title: "Should uploads wait for Wi-Fi?", note: null,
    entry: "uploads-wifi.html", bytes: 1700, presented_at: at(3 * 24 * 60), presented_by: { role: "firstmate" }, layout: { status: "clean", issues: [] },
  };
  const artifacts: Artifact[] = [
    { scope: "chat", task: null, name: "model-download", title: board.title, latest: board, revisions: [board] },
    { scope: "task", task: ARTIFACT_TASK, name: "titles-plan", title: "AI titles for snips", latest: planRevisions[2], revisions: planRevisions },
    { scope: "task", task: REPORT_TASK, name: "transcripts-report", title: report.title, latest: report, revisions: [report] },
    { scope: "task", task: LANDED_TASK, name: "rebase-plan", title: shipped.title, latest: shipped, revisions: [shipped] },
    { scope: "chat", task: null, name: "uploads-wifi", title: uploads.title, latest: uploads, revisions: [uploads] },
  ];
  const usage: ArtifactRevision = {
    scope: "task", task: USAGE_TASK, name: "usage-panel", rev: 1, title: "Usage panel: context and plan limits", note: null,
    entry: "usage-panel.html", bytes: 107732, presented_at: at(5), presented_by: { role: "crew", task: USAGE_TASK }, layout: { status: "clean", issues: [] },
  };
  if (reviewFlag("usage-t2")) artifacts.push({ scope: "task", task: USAGE_TASK, name: "usage-panel", title: usage.title, latest: usage, revisions: [usage] });
  if (reviewFlag("resumed-day")) {
    // The captain's own day: pages from nearly a day ago, at the trailing edge of the chat's window.
    const flow: ArtifactRevision = {
      scope: "chat", task: null, name: "nm-flow", rev: 1, title: "How no-mistakes carries a change", note: null,
      entry: "nm-flow.html", bytes: 5200, presented_at: at(RESUMED_DAY_MINUTES.flow), presented_by: { role: "firstmate" }, layout: { status: "clean", issues: [] },
    };
    const panel = [
      { ...usage, presented_at: at(RESUMED_DAY_MINUTES.panel1) },
      { ...usage, rev: 2, note: "Said what \"under pace\" means.", presented_at: at(RESUMED_DAY_MINUTES.panel2) },
    ];
    artifacts.push(
      { scope: "chat", task: null, name: "nm-flow", title: flow.title, latest: flow, revisions: [flow] },
      { scope: "task", task: USAGE_TASK, name: "usage-panel", title: usage.title, latest: panel[1], revisions: panel },
    );
  }
  const usageTask = mockTask(home, USAGE_TASK, "scout", "working", 30, { detail: "harness busy (claude-hook)", note: "Designing the usage panel.", report: false, observedAt: at(1) });
  const planTask = mockTask(home, ARTIFACT_TASK, "scout", "working", 95, { detail: "harness busy (claude-hook)", note: "Revising the titles plan.", report: false, observedAt: at(2) });
  const reportTask = mockTask(home, REPORT_TASK, "scout", "done", 27 * 60, { detail: "Report written: 2 of 9281 sampled episodes carry a publisher transcript.", note: "Report written: 2 of 9281 sampled episodes carry a publisher transcript.", report: true, observedAt: at(2) });
  const records: BacklogRecord[] = [
    backlogRow(ARTIFACT_TASK, "Resonance: AI titles for snips", {
      kind: "scout", since: day(0),
      body_lines: ["Plan how a snip gets a title it earns, on the phone, before any model ships.", "- Compare an on-device model with the server one.", "- Say what a wrong title costs the captain."],
    }),
    backlogRow(REPORT_TASK, "Resonance: which episodes already carry a transcript?", { kind: "scout", since: day(1) }),
    backlogRow("res-lockscreen", "Resonance: snip from the Lock Screen and AirPods", {
      state: "queued", current_role: "queued", since: day(2), hold_reason: "Waits on the snip lifecycle work landing",
      // A body written the way firstmate files one: a paragraph per line, a list, labels, and code.
      body_lines: [
        "SYMPTOM, reported by the captain: a snip needs the phone unlocked and the app open.",
        "WHAT TO BUILD:",
        "- A Lock Screen widget that snips the last 30 seconds.",
        "- The AirPods stem press does the same, through `MPRemoteCommandCenter`.",
        "App-side only. Verify on a locked phone, not the simulator.",
      ],
      body_excerpt: "SYMPTOM, reported by the captain: a snip needs the phone unlocked and the app open.",
    }),
    backlogRow(REPORTED_TASK, "Resonance: how often do feeds change their artwork?", {
      kind: "scout", state: "done", current_role: "done", since: day(3), completion: { verb: "reported", date: day(1) }, report_path: `${home}/data/${REPORTED_TASK}/report.md`,
    }),
    backlogRow(ANSWERED_CALL, "Resonance: should uploads wait for Wi-Fi?", {
      kind: "captain", hold_kind: "captain", state: "done", current_role: "done", since: day(4), completion: { verb: "done", date: day(2) },
      // The resolution block bin/fm-captain-hold.sh writes when it closes a call, machine lines included.
      body_lines: [
        "Captain hold set: 2026-09-14T09:12:00Z",
        "Resolution recorded by fm-captain-hold.",
        "Decision digest: 5c1f0e",
        "Resolution mode: answered",
        "Answer key: wifi-only",
        "Answered by: captain",
        "Answered via: chat",
        "",
        "Captain decision:",
        "Wi-Fi only, and say so in Settings.",
      ],
      body_excerpt: "Resolution recorded by fm-captain-hold.",
    }),
  ];
  // `?start`: two rows waiting their turn with nothing holding them, a scout and a ship, to start from their drawers.
  if (reviewFlag("start")) records.push(
    backlogRow(START_SCOUT, "Resonance: which feeds publish chapters?", {
      kind: "scout", state: "queued", current_role: "queued", since: day(1),
      body_lines: ["Sample 200 feeds and count how many carry `podcast:chapters`.", "Say whether snips can lean on them for their titles."],
    }),
    backlogRow(START_SHIP, "Resonance: colour the snip waveform by speaker", {
      state: "queued", current_role: "queued", since: day(2),
      body_lines: ["The waveform is one colour, so a two-person snip reads as one voice.", "Colour each speaker's stretch from the transcript's speaker turns."],
    }),
  );
  const call = (id: string, title: string, fields: Partial<Call>): Call => ({
    id, title, question: null, options: [], on_answer: "done", state: "open", bucket: "live", captain_actionable: true, origin: null, about: null,
    evidence: [], raised_by: "firstmate", raised_at: at(30), updated_at: at(30), answer: null, decided: null, ...fields,
  });
  const option = (key: string, label: string, recommended = false) => ({ key, label, recommended });
  // A call the first mate settled for the captain, raised and answered in one act by `decide`.
  const decidedCall = (id: string, minutesAgo: number, about: string | null, decided: Call["decided"] & object): Call => call(id, decided.what, {
    state: "closed", bucket: null, captain_actionable: false, about, raised_at: at(minutesAgo), updated_at: at(minutesAgo),
    answer: { key: null, label: decided.what, by: "firstmate", via: "firstmate", at: at(minutesAgo) }, decided,
  });
  // What `bin/fm-captain-hold.sh list --json` reports, as the snapshot carries it in calls[].
  const calls: Call[] = [
    // Argued by a page the first mate presented after raising it; one of two calls that page argues.
    call("res-model-download", "Resonance: when may the app download the 150 MB speech model?", {
      question: "When may the app download the 150 MB speech model?",
      options: [option("wifi-only", "Wi-Fi only, with visible progress", true), option("prompt", "Ask on the first snip that needs it"), option("eager", "Keep downloading eagerly")],
      evidence: ["page:chat/model-download"], raised_at: at(30), updated_at: at(30),
    }),
    // The same page's second call, whose options changed after the page was presented.
    // `?options-missing`: its options are not recorded, so it can only be answered in words.
    call("res-model-cellular", "Resonance: what happens when a download leaves Wi-Fi?", {
      question: "If the phone leaves Wi-Fi halfway through the download, what happens?",
      options: reviewFlag("options-missing") ? [] : [option("pause", "Pause, and carry on when Wi-Fi is back", true), option("finish", "Finish on cellular if under 20 MB are left")],
      evidence: ["page:chat/model-download"], raised_at: at(20), updated_at: at(0.5),
    }),
    // Raised from a scout's work before its report page existed: the page comes through the origin.
    call("res-transcripts-source", "Resonance: where should transcripts come from?", {
      question: "Where should Resonance get an episode's transcript?",
      options: [option("publisher-first", "Use the publisher's transcript when there is one, else transcribe", true), option("always-transcribe", "Always transcribe on the device")],
      on_answer: "release", origin: REPORT_TASK, raised_at: at(26 * 60), updated_at: at(26 * 60),
      evidence: [`page:task/${REPORT_TASK}/transcripts-report`, `report:${REPORT_TASK}`],
    }),
    // Nothing argues this one, so its options are offered inline.
    call(UNARGUED_CALL, "Foreman: keep merging its own PRs while you are away?", {
      question: "Should foreman keep merging its own PRs while you are away this week?",
      options: [option("keep", "Keep merging once checks pass", true), option("pause", "Hold every PR for me")],
      raised_at: at(3 * 60), updated_at: at(3 * 60),
    }),
    // Answered by the captain in chat, and closed.
    call(ANSWERED_CALL, "Resonance: should uploads wait for Wi-Fi?", {
      question: "Should uploads wait for Wi-Fi?", state: "closed", bucket: null, captain_actionable: false,
      options: [option("wifi-only", "Wi-Fi only, and say so in Settings", true), option("any", "Upload on any connection")],
      evidence: ["page:chat/uploads-wifi"], raised_at: at(4 * 24 * 60), updated_at: at(4 * 24 * 60),
      // A bare date, as answers carried over from before calls had times record it.
      answer: { key: "wifi-only", label: "Wi-Fi only, and say so in Settings", by: "captain", via: "chat", at: localDate(2) },
    }),
    decidedCall("res-titles-keep-wide", 40, ARTIFACT_TASK, {
      kind: "review-finding", link: null,
      what: "Kept the wide before-and-after image in the titles plan (review finding F1)",
      why: "Seeing both titles side by side is the point of the page, so the narrow window scrolls it instead.",
    }),
    decidedCall("foreman-merge-24", 5 * 60, LANDED_TASK, {
      kind: "merge", link: "https://github.com/caomyer/foreman/pull/24",
      what: "Merged foreman PR #24 once its checks passed",
      why: "You approved the plan, and foreman merges its own PRs.",
    }),
    decidedCall("res-file-ai-titles", 26 * 60, null, {
      kind: "new-task", link: null,
      what: "Filed res-ai-titles to build the titles once you pick an approach",
      why: "The scout's plan needs a ship task to land, and it waits on your call rather than starting.",
    }),
  ];
  return {
    artifacts,
    tasks: reviewFlag("usage-t2") ? [planTask, reportTask, usageTask] : [planTask, reportTask],
    // `?plain-report`: the transcripts scout's report argues no call, so it is offered on its own card.
    calls: reviewFlag("plain-report") ? calls.filter((call) => call.origin !== REPORT_TASK) : calls,
    inFlight: [
      { id: ARTIFACT_TASK, kind: "scout", state: "working", repo: planTask.project, name: "AI titles for snips", doing: "Revising the titles plan." },
      { id: REPORT_TASK, kind: "scout", state: "done", repo: reportTask.project, name: "Resonance: which episodes already carry a transcript?", doing: "" },
    ],
    // Every call is a backlog row in firstmate, held for the captain or closed with its answer.
    records: [...records, ...calls.filter((item) => !records.some((record) => record.id === item.id)).map((item) => backlogRow(item.id, item.title, {
      kind: "captain", hold_kind: "captain", repo: item.id.startsWith("foreman-") ? "foreman" : "resonance",
      state: item.state === "open" ? "queued" : "done", current_role: item.state === "open" ? "held" : "done",
      captain_actionable: item.captain_actionable === true, hold_reason: item.state === "open" ? item.question : null,
      since: (item.raised_at ?? at(60)).slice(0, 10), completion: item.state === "open" ? { verb: null, date: null } : { verb: "done", date: (item.answer?.at ?? at(60)).slice(0, 10) },
    }))],
    landed: [{ id: REPORTED_TASK, what: "Resonance: how often do feeds change their artwork?", artifact: `${home}/data/${REPORTED_TASK}/report.md`, owner: "(main)" }],
    reports: [{ id: REPORT_TASK, path: `${home}/data/${REPORT_TASK}/report.md` }, { id: REPORTED_TASK, path: `${home}/data/${REPORTED_TASK}/report.md` }],
  };
}

/**
 * Resonance's older closed work, as `bin/fm-history.sh` lists it: newest first, most of it from the archive, spread
 * over three months, with a call the captain answered, one the first mate settled, and a row that delivered nothing.
 */
function mockHistory(home: string): { records: BacklogRecord[]; calls: Call[] } {
  const done = (id: string, title: string, verb: string, days: number, fields: Partial<BacklogRecord> = {}) =>
    backlogRow(id, title, { state: "done", current_role: "done", since: localDate(days + 2), completion: { verb, date: localDate(days) }, ...fields });
  const pr = (n: number) => `https://github.com/caomyer/Resonance/pull/${n}`;
  const answered = (id: string, title: string, days: number, key: string, label: string, by: "captain" | "firstmate", via: string): Call => ({
    id, title, question: `${title.replace(/^Resonance: (.)/, (_, first: string) => first.toUpperCase())}?`, options: [], on_answer: "done", state: "closed", bucket: null, captain_actionable: false,
    origin: null, about: null, evidence: [], raised_by: "firstmate", raised_at: null, updated_at: null,
    answer: { key, label, by, via, at: localDate(days) }, decided: null,
  });
  const records = [
    done("res-caption-fix", "Resonance: stop the snip caption promising Lock Screen snipping", "merged", 0, { pr_url: pr(6) }),
    done("res-next-scout", "Resonance: which audit improvement should come next", "reported", 0, { kind: "scout", report_path: `${home}/data/res-next-scout/report.md` }),
    done("res-after-lifecycle", "Resonance: what should follow the snip lifecycle work", "done", 0, { kind: "captain", hold_kind: "captain" }),
    done("res-audit", "Resonance: product and technical audit, with the most valuable improvements", "merged", 1, { pr_url: pr(5) }),
    done("res-export-names", "Resonance: how exported snip files are named when two share a title", "done", 5, { kind: "captain", hold_kind: "captain" }),
    done("res-share-spike", "Resonance: try a share-sheet extension for snips", "done", 9, { body_excerpt: "Dropped: the captain chose to wait for the lifecycle work." }),
    done("res-waveform", "Resonance: draw the snip waveform from the cached transcript timing", "merged", 12, { pr_url: pr(4) }),
    done("res-onboarding-scout", "Resonance: where new listeners give up during onboarding", "reported", 20, { kind: "scout", report_path: `${home}/data/res-onboarding-scout/report.md` }),
    done("res-offline-queue", "Resonance: queue snips made offline and upload them later", "merged", 33, { pr_url: pr(3) }),
    done("res-local-build", "Resonance: a local build script for TestFlight", "landed", 41),
    done("res-feed-parse", "Resonance: parse podcast:transcript tags in feeds", "merged", 47, { pr_url: pr(2) }),
    done("res-first-light", "Resonance: first light, the app records and plays a snip", "merged", 70, { pr_url: pr(1) }),
  ];
  const calls = [
    answered("res-after-lifecycle", "Resonance: what should follow the snip lifecycle work", 0, "titles", "AI titles", "captain", "quarterdeck"),
    answered("res-export-names", "Resonance: how exported snip files are named when two share a title", 5, "counter", "Number only on a collision", "firstmate", "decide"),
  ];
  return { records, calls };
}

/** As in the app: only the intake's record is final. */
function recorded(answer: ReviewView["answers"][number]) {
  return answer.recorded?.result === "closed";
}

/** The lines the app's composer writes for answers the intake recorded. */
function recordedLines(answers: { decision: string; option: string | null; label: string | null; note?: string | null }[]) {
  if (!answers.length) return [];
  return [
    "Answers already recorded with bin/fm-captain-hold.sh; do the follow-up each one calls for, and do not record them again:",
    ...answers.flatMap((answer) => [`Recorded: ${answer.decision} = ${answer.option} ("${answer.label}")`, ...(answer.note ? [`  The captain added: ${answer.note}`] : [])]),
  ];
}

/** The lines the app's composer writes for answers in words, which only the first mate can record. */
function wordedLines(answers: ReviewView["answers"]) {
  if (!answers.length) return [];
  return [
    "Answered in words, which nothing has recorded yet; record each with bin/fm-captain-hold.sh as the captain said it (a date to be asked again on is a hold until then), then do the follow-up:",
    ...answers.map((answer) => `${answer.decision}: ${[answer.defer ? `Not now. Ask me again on ${answer.defer}.` : "", answer.note ?? ""].filter(Boolean).join(" ")}`),
  ];
}

/** Why the author should look at a picture first, in the words `src-tauri/src/review.rs` uses. */
const REASON_WORDS: Record<string, string> = {
  repeated: "the words appear in more than one place on screen",
  opened: "the place was inside something the captain had opened, so the page shows it only once that is opened again",
  wordless: "the captain pointed at a spot with no words of its own",
};

/** Where a thread sits, in the labelled lines `where_lines` in `src-tauri/src/review.rs` writes; that function owns the shape. */
function whereLines(thread: ReviewThread, folder: string) {
  const anchor = (thread.anchor ?? {}) as ReviewAnchor;
  const lines: string[] = [];
  if (anchor.occurrence && anchor.occurrence.of > 1) lines.push(`  match    ${anchor.occurrence.n} of the ${anchor.occurrence.of} places these words appear in the page's text, ${anchor.occurrence.shown} of them on screen`);
  if (anchor.prefix || anchor.suffix) lines.push(`  around   "…${anchor.prefix.trimStart()}" ▸here◂ "${anchor.suffix.trimEnd()}…"`);
  if (anchor.element) lines.push(`  element  ${anchor.element}`);
  if (anchor.near) lines.push(`  near     ${anchor.near}`);
  if (anchor.box) lines.push(`  box      x ${anchor.box.x}, y ${anchor.box.y}, ${anchor.box.w} × ${anchor.box.h} CSS px${anchor.view ? `, in a ${anchor.view.w} × ${anchor.view.h} window scrolled to ${anchor.view.scroll_y}, on a ${anchor.view.scheme} page` : ""}`);
  if (anchor.point) lines.push(`  clicked  x ${anchor.point.x}, y ${anchor.point.y}`);
  if (thread.picture) {
    lines.push(`  picture  ${folder}/${thread.picture.file}`);
    const reasons = (anchor.reasons ?? []).map((reason) => REASON_WORDS[reason]).filter(Boolean);
    if (reasons.length) lines.push(`           Look at it before acting: ${reasons.join("; ")}.`);
    lines.push("           It is a redraw the page made of itself when the captain picked the place, not a screenshot of the captain's screen. The place is outlined; layout and words are right, but colours, images from other sites and fine detail may differ from what the captain saw.");
  } else if (thread.picture_skipped) {
    lines.push(`  picture  none (${thread.picture_skipped})`);
  }
  return lines;
}

/** What the host says for each `reason_kind`, so the review shows the details a captain would see. */
const MOCK_REASONS: Record<ReasonKind, string> = {
  not_a_home: "/Users/mingyucao_1/.buzz/.scratch/fm-probe/firstmate is not a firstmate home",
  permission_mode: "config/claude-permission-mode is 'sometimes', which is not one of bypass or auto",
  lock_unconfirmed: "could not confirm this home's session lock is free, so nothing was started. lock: unknown",
  lock_unclaimed: "the first mate did not claim this home's session lock within 30s",
  adapter_missing: "claude-agent-acp was not found on the login shell PATH",
  adapter_crashed: "claude-agent-acp exited with signal 9 during a turn",
  timeout: "session/new did not answer within 60s",
  exited: "the first mate process exited",
};

/** `?history` also tells a resumed first mate what came before this window. */
const EARLIER_CONVERSATION: HistoryItem[] = [
  { who: "captain", text: "What's waiting on me?" },
  { who: "step", text: "bin/fm-bearings-snapshot.sh --json" },
  { who: "step", text: "Read /Users/mingyucao_1/.buzz/.scratch/fm-probe/firstmate/data/backlog.md" },
  { who: "mate", text: "Two calls: the resonance titles PR is ready to merge, and foreman wants a yes or no on Wi-Fi only uploads." },
];

/**
 * `?resumed-day`, with `?artifacts`: a first mate resumed after a day of work, as a relaunch brings it back, so none of
 * it has a time. The captain reviewed the usage panel's first revision in it, so that review is the one thing the app
 * knows the time of. The last exchange is from minutes ago, and every page is older than it.
 */
const RESUMED_DAY_MINUTES = { flow: 23 * 60 + 50, panel1: 23 * 60 + 34, review: 23 * 60 + 30, panel2: 23 * 60 + 24 };
const RESUMED_DAY_REVIEW = 'Captain\'s review of "usage-panel" (rev 1): Requests changes.';
const RESUMED_DAY: HistoryItem[] = [
  { who: "captain", text: "Show me how no-mistakes carries a change from my branch to a PR." },
  { who: "step", text: "bin/fm-artifact.sh present --chat nm-flow.html" },
  { who: "mate", text: "It is on the nm-flow page: each gate, and who answers it." },
  { who: "captain", text: "And the usage panel?" },
  { who: "mate", text: "The scout's first cut is up as usage-panel." },
  { who: "captain", text: `${RESUMED_DAY_REVIEW}\nt1 on "under pace": what does under pace mean?` },
  { who: "mate", text: "Revision 2 says what it means." },
  { who: "captain", text: "Good. Park it until tomorrow." },
  { who: "mate", text: "Parked." },
  { who: "captain", text: "Morning. What changed overnight?" },
  { who: "mate", text: "Nothing needs you yet: two scouts are still working." },
];

/** `?markdown`: one reply in the shapes a first mate actually writes, for reviewing chat formatting. */
const MARKDOWN_SAMPLE: HistoryItem[] = [
  { who: "captain", text: "Where are we on the titles work?" },
  { who: "step", text: "bin/fm-fleet-snapshot.sh --json" },
  {
    who: "mate",
    text: [
      "Captain, **the titles branch is ready for you** and one call needs your word.",
      "",
      "### Ready to merge",
      "",
      "- `res-ai-titles` passed its checks on the third run; the first two failed on a flaky fixture.",
      "- PR: https://github.com/caomyer/resonance/pull/41",
      "",
      "### Waiting on you",
      "",
      "1. Whether the app may download the 150 MB speech model on cellular.",
      "2. Whether `foreman` keeps merging its own PRs while you are away.",
      "",
      "| Project | Under way | Posture |",
      "| --- | --- | --- |",
      "| resonance | 1 | Fully checked before a PR |",
      "| foreman | 0 | Opens a PR directly |",
      "",
      "The worker left this in its notes:",
      "",
      "```",
      "titles: painted 412 of 412 episodes",
      "skipped: 0",
      "```",
      "",
      "> Nothing else is under way, so the fleet is quiet.",
    ].join("\n"),
  },
];

/** `?relaunch`: the message the first mate was answering when the app went away. It is the last thing said, so the crash cut its reply off. */
const CUT_OFF_MESSAGE = "Ship the titles branch when CI is green.";

/** `?call-answered`: the captain's answer to the fixture's open call, worded the way the card writes it. */
const CALL_ANSWER = "On the res model download: Wi-Fi only with visible progress.";

const SESSION_LIMIT_ERROR = JSON.stringify({ code: -32603, data: { errorKind: "rate_limit" }, message: "Internal error: You've hit your session limit · resets 1:50pm (America/Los_Angeles)" });

export class MockHostAdapter implements HostAdapter {
  private listeners = new Set<HostEventListener>();
  private timers = new Set<number>();
  private outstanding = new Set<string>();
  /** Like the real host, a refused or dead start only shows once the captain presses Start. */
  private state: HostRuntimeState = reviewFlag("not-started") || reviewFlag("replay") || reviewFlag("relaunch") || this.problem() ? "stopped" : "idle";
  /** `?slow-start`: messages sent while starting, handed over once the first mate is ready. */
  private deferred: (() => void)[] = [];
  /** `?replay`: resolves the recorded send the replay is waiting on, with the id the host gave it. */
  private awaitingSend: ((id: string) => void) | null = null;
  private replayIds: string[] = [];
  /** Messages the review already sent, which the replay need not wait for when it reaches them. */
  private replaySent = new Set<string>();
  private sequence = 0;
  private startupPlayed = false;
  private homeChosen = false;
  private startThrown = false;
  /** The session's conversation so far, which a resumed session sends back as `history`. */
  private transcript: HistoryItem[] = reviewFlag("markdown")
    ? [...MARKDOWN_SAMPLE]
    : reviewFlag("resumed-day")
      ? [...RESUMED_DAY]
        : reviewFlag("history")
        ? [...EARLIER_CONVERSATION]
        : [];
  private streaming = false;
  private readonly snapshot = MockHostAdapter.fixtureSnapshot();
  private routing = MockHostAdapter.initialRouting();
  private routingRevision = 1;
  /** `?update=<state>`: the app's own update (src/host/mock-update.ts). */
  private readonly updates = new MockUpdates(() => this.state, (ms, run) => this.later(ms, run));

  /**
   * `?routing=on` starts with the example rules, `?routing=invalid` with rules the first mate cannot use,
   * `?routing=rich` with rules carrying fields the form does not edit, `?routing=unshowable` with rules the form
   * cannot show, `?routing=aside` off with rules set aside, `?routing=key` off with a key set, and `?routing=unavailable` in a
   * home whose firstmate cannot set routing up. Otherwise routing is off, as in a new home.
   */
  private static initialRouting(): Routing {
    const off: Routing = { available: true, problem: null, on: false, rules: null, sha256: null, invalid: null, key: { set: false, source: null }, setAside: null, harnesses: MOCK_HARNESSES, template: crewDispatchExample };
    switch (reviewValue("routing")) {
      case "on": return { ...off, on: true, rules: crewDispatchExample, sha256: "mock-1" };
      case "invalid": return { ...off, on: true, rules: '{\n  "rules": [\n    { "when": "Anything at all.", "use": { "harness": "spaceship" } }\n  ]\n}\n', sha256: "mock-1", invalid: "unverified harness: spaceship" };
      case "rich": return { ...off, on: true, rules: MOCK_RICH_RULES, sha256: "mock-1" };
      case "unshowable": return { ...off, on: true, rules: '{\n  "rules": { "when": "not a list" }\n}\n', sha256: "mock-1", invalid: "rules must be an array" };
      case "aside": return { ...off, setAside: "crew-dispatch.json.off-20260921T101500Z" };
      case "key": return { ...off, key: { set: true, source: ".env" } };
      case "unavailable": return { ...off, available: false, problem: "this home's firstmate has no bin/fm-crew-dispatch.sh, so routing can't be set up from here", harnesses: [], template: null };
      default: return off;
    }
  }

  /** `?usage=<state>`: the usage panel's states, from src/host/mock-usage.ts. */
  private readonly usage = mockUsage(reviewValue("usage"));
  /** The context reading the host has reported, which it does only after a turn. */
  private context: ContextReading | null = null;
  private keychainAllowed = false;
  private readonly openedAt = Date.now();

  private static fixtureSnapshot() {
    const bearings = bearingsFixture as unknown as BearingsSnapshot;
    // The recording predates `captain_day`: it was taken at 12:32 PDT on its day.
    const fleet = { ...(fleetFixture as unknown as FleetSnapshot), captain_day: "2026-09-15" };
    if (!reviewFlag("artifacts")) return { bearings, fleet };
    const mock = mockArtifacts(fleet.fm_home);
    return {
      bearings: {
        ...bearings,
        in_flight: [...bearings.in_flight, ...mock.inFlight],
        landed: [...mock.landed, ...bearings.landed],
        reports: [...(bearings.reports ?? []), ...mock.reports],
      },
      fleet: {
        ...fleet,
        tasks: [...fleet.tasks, ...mock.tasks],
        backlog: { ...fleet.backlog, records: [...(fleet.backlog?.records ?? []), ...mock.records] },
        artifacts: mock.artifacts,
        // `?legacy`: a home whose firstmate predates calls[], so the app reads Bearings' own list instead.
        ...(reviewFlag("legacy") ? {} : { calls: mock.calls }),
      },
    };
  }

  /**
   * firstmate's `answers` intake, as far as the review needs it: every answer is recorded and its call closes, except
   * a call named by `?skip=<id>`, which the intake skips with a reason. A recorded call reaches the snapshot a
   * moment later, the way the home's watcher brings it.
   */
  private intake(answers: { call: string; key: string; label: string }[]): IntakeOutcome[] {
    const skip = (reviewValue("skip") ?? "").split(",");
    const outcomes = answers.map(({ call }): IntakeOutcome => skip.includes(call)
      ? { call, result: "skipped", detail: "the hold changed after this answer was chosen; answer it again from what is there now" }
      : { call, result: "closed", detail: "recorded; closed" });
    const closed = answers.filter((answer) => outcomes.some((outcome) => outcome.call === answer.call && outcome.result === "closed"));
    if (closed.length && this.snapshot.fleet.calls) {
      const at = new Date().toISOString();
      const calls = this.snapshot.fleet.calls.map((call) => {
        const answer = closed.find((item) => item.call === call.id);
        return answer ? { ...call, state: "closed" as const, captain_actionable: false, answer: { key: answer.key, label: answer.label, by: "captain" as const, via: "quarterdeck", at } } : call;
      });
      this.later(1200, () => {
        this.snapshot.fleet = { ...this.snapshot.fleet, calls };
        this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
      });
    }
    return outcomes;
  }

  /**
   * What the first mate does with a dated Not now a review carried: holds the call until that day, so firstmate stops
   * asking the captain and the call leaves Captain's call. A hold writes no content, so `updated_at` stays as it was.
   * `?day-comes`: the day comes a few seconds later, and the call asks the captain again.
   */
  private holdUntilTheDay(decisions: string[]) {
    if (!decisions.length || !this.snapshot.fleet.calls) return;
    const asking = (actionable: boolean) => {
      this.snapshot.fleet = { ...this.snapshot.fleet, calls: this.snapshot.fleet.calls!.map((call) => decisions.includes(call.id) ? { ...call, captain_actionable: actionable } : call) };
      this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
    };
    this.later(1200, () => asking(false));
    if (reviewFlag("day-comes")) this.later(5000, () => asking(true));
  }

  /** The dev server serves the review pages at the same paths the app's `artifact` scheme does. */
  artifactUrl(revision: ArtifactRevision) {
    return `/artifacts/${artifactPath(revision)}`;
  }

  /** Reviews live in memory here; the app keeps them in the home beside the revisions. */
  private readonly reviews = new Map<string, ReviewView>(reviewFlag("resumed-day") ? [[`task/${USAGE_TASK}/usage-panel`, {
    threads: [{
      id: "t1", rev: 1, anchor: { quote: "under pace" } as ReviewAnchor, at: Date.now() - RESUMED_DAY_MINUTES.review * 60_000, sent_at: Date.now() - RESUMED_DAY_MINUTES.review * 60_000,
      resolved_at: null, state: "open", comments: [{ body: "what does under pace mean?", at: Date.now() - RESUMED_DAY_MINUTES.review * 60_000 }],
    }],
    answers: [], earlier: [], draft_count: 0, staged_answers: 0, open_count: 1, seen_rev: 2, log: `${this.snapshot.fleet.fm_home}/data/${USAGE_TASK}/review.jsonl`,
    // Sent by the window before this one, so its message id is not one this window has.
    sent: [{ at: Date.now() - RESUMED_DAY_MINUTES.review * 60_000, verdict: "changes", rev: 1, message: "m-yesterday", header: RESUMED_DAY_REVIEW, threads: ["t1"] }],
  }]] : []);
  /** Threads ever opened per review, discarded ones included, which is how the app numbers them too. */
  private readonly opened = new Map<string, number>();

  private nextThreadId(ref: ArtifactRef) {
    const key = `${ref.scope}/${ref.task}/${ref.name}`;
    const count = (this.opened.get(key) ?? 0) + 1;
    this.opened.set(key, count);
    return `t${count}`;
  }

  private review(ref: ArtifactRef): ReviewView {
    const key = `${ref.scope}/${ref.task}/${ref.name}`;
    const current = this.reviews.get(key) ?? { threads: [], answers: [], earlier: [], draft_count: 0, staged_answers: 0, open_count: 0, sent: [], seen_rev: null, log: `${this.snapshot.fleet.fm_home}/data/${ref.task ?? ".artifacts"}/review.jsonl` };
    this.reviews.set(key, current);
    return current;
  }

  private settle(ref: ArtifactRef, threads: ReviewThread[], sent = this.review(ref).sent) {
    // As in the app: waiting to go are answers not through the intake yet, and recorded ones not yet told.
    const waiting = this.review(ref).answers.filter((answer) => answer.sent_at === null && (!answer.recorded || answer.recorded.result === "closed")).length;
    const next: ReviewView = {
      ...this.review(ref),
      threads,
      sent,
      draft_count: threads.filter((thread) => thread.sent_at === null).length + waiting,
      staged_answers: waiting,
      open_count: threads.filter((thread) => thread.state === "open").length,
    };
    this.reviews.set(`${ref.scope}/${ref.task}/${ref.name}`, next);
    return next;
  }

  async reviewGet(ref: ArtifactRef) {
    return this.review(ref);
  }

  async reviewComment(ref: ArtifactRef, rev: number, body: string, anchor?: ReviewAnchor, thread?: string, picture?: CommentPicture) {
    const current = this.review(ref);
    const at = Date.now();
    if (thread) {
      return this.settle(ref, current.threads.map((item) => item.id === thread ? { ...item, comments: [...item.comments, { body, at }] } : item));
    }
    const id = this.nextThreadId(ref);
    // As in the app: a picture is kept beside the review under a name the app chooses; the mock keeps it inline to show.
    const kept = picture && "jpeg" in picture
      ? { picture: { file: `review-files/${id}-r${rev}.jpg`, crop: picture.crop, method: "redraw" as const, took_ms: picture.took_ms, bytes: Math.round((picture.jpeg.length - 23) * 3 / 4) }, picture_preview: picture.jpeg }
      : picture && "skipped" in picture ? { picture_skipped: picture.skipped } : {};
    return this.settle(ref, [...current.threads, { id, rev, anchor: anchor ?? null, at, sent_at: null, resolved_at: null, state: "draft", comments: [{ body, at }], ...kept }]);
  }

  async reviewScene(ref: ArtifactRef, rev: number, scene: string, label: string, path: string, summary: string, sceneJson: string, png: string) {
    const current = this.review(ref);
    const id = this.nextThreadId(ref);
    const at = Date.now();
    const folder = `${this.snapshot.fleet.fm_home}/data/${ref.task ?? ".artifacts"}/review-files`;
    void sceneJson;
    return this.settle(ref, [...current.threads, {
      id, rev, at, sent_at: null, resolved_at: null, state: "draft" as const,
      // The app writes these beside the review; the mock keeps the picture inline so the rail can show it.
      anchor: { scene, label, path, quote: label, scene_file: `${folder}/${id}.excalidraw`, picture: png ? `${folder}/${id}.png` : null, preview: png },
      comments: [{ body: summary, at }],
    }]);
  }

  async reviewAnswer(ref: ArtifactRef, decision: string, option?: string, label?: string, onAnswer?: string | null, words?: AnswerWords) {
    const current = this.review(ref);
    const note = words?.note?.trim() || null;
    const defer = words?.defer || null;
    // As in the app: not now is an answer of its own, and a date is a date.
    if (defer && option) throw new Error("not now is an answer of its own, not one added to an option");
    if (defer && !/^\d{4}-\d{2}-\d{2}$/.test(defer)) throw new Error(`'${defer}' is not a date`);
    // As in the app: a recorded answer is on the record and stays as it went; a skipped one can be chosen again.
    if (current.answers.some((answer) => answer.decision === decision && recorded(answer))) {
      throw new Error("that answer is already on the record; tell the first mate in chat if you have changed your mind");
    }
    // As in the app: the last answer that went and was answered anew is kept as what the captain said then.
    const then = current.answers.find((answer) => answer.decision === decision && answer.sent_at !== null);
    const earlier = then ? [...current.earlier.filter((answer) => answer.decision !== decision), then] : current.earlier;
    const kept = current.answers.filter((answer) => answer.decision !== decision);
    // Choosing nothing and saying nothing takes the answer back off the tray.
    const answers = option || note || defer ? [...kept, { decision, option: option ?? null, label: option ? label ?? option : null, on_answer: onAnswer ?? null, note, defer, at: Date.now(), sent_at: null, recorded: null }] : kept;
    this.reviews.set(`${ref.scope}/${ref.task}/${ref.name}`, { ...current, answers, earlier });
    return this.settle(ref, current.threads);
  }

  /** Runs the intake for the review's staged answers (or only `only`), and notes what it did with each. */
  private recordStaged(ref: ArtifactRef, only?: string) {
    const current = this.review(ref);
    // As in the app: the intake takes only an option's key, so an answer in words never goes to it.
    const staged = current.answers.filter((answer) => answer.option !== null && answer.sent_at === null && !answer.recorded && (!only || answer.decision === only));
    const outcomes = this.intake(staged.map((answer) => ({ call: answer.decision, key: answer.option!, label: answer.label ?? answer.option! })));
    const at = Date.now();
    const answers = current.answers.map((answer) => {
      const outcome = staged.includes(answer) ? outcomes.find((item) => item.call === answer.decision) : undefined;
      return outcome ? { ...answer, recorded: { result: outcome.result, detail: outcome.detail, at } } : answer;
    });
    this.reviews.set(`${ref.scope}/${ref.task}/${ref.name}`, { ...current, answers });
    this.settle(ref, current.threads);
    return outcomes;
  }

  async callAnswer({ call, option, label, onAnswer, page, note }: CallAnswerRequest) {
    let outcome: IntakeOutcome;
    if (page) {
      await this.reviewAnswer(page, call, option, label, onAnswer);
      outcome = this.recordStaged(page, call)[0];
    } else {
      outcome = this.intake([{ call, key: option, label }])[0];
    }
    if (outcome.result !== "closed") return { outcome, message: null, text: null, review: page ? this.review(page) : null };
    const text = ["The captain answered a call from Bearings.", ...recordedLines([{ decision: call, option, label }]), ...(note?.trim() ? [`The captain added: ${note.trim()}`] : [])].join("\n");
    const message = await this.send(text);
    if (page) {
      const current = this.review(page);
      const at = Date.now();
      this.reviews.set(`${page.scope}/${page.task}/${page.name}`, { ...current, answers: current.answers.map((answer) => answer.decision === call && answer.sent_at === null ? { ...answer, sent_at: at } : answer) });
      this.settle(page, current.threads);
    }
    return { outcome, message, text, review: page ? this.review(page) : null };
  }

  async reviewSettle(ref: ArtifactRef, thread: string, resolved: boolean) {
    const current = this.review(ref);
    return this.settle(ref, current.threads.map((item) => item.id === thread && item.sent_at !== null
      ? { ...item, state: resolved ? "resolved" as const : "open" as const, resolved_at: resolved ? Date.now() : null }
      : item));
  }

  async reviewSeen(ref: ArtifactRef, rev: number) {
    const current = this.review(ref);
    const key = `${ref.scope}/${ref.task}/${ref.name}`;
    const next = { ...current, seen_rev: Math.max(current.seen_rev ?? 0, rev) };
    this.reviews.set(key, next);
    return next;
  }

  async reviewSummary() {
    const pages: ReviewSummary = {};
    for (const [key, review] of this.reviews) {
      const [scope, task, name] = key.split("/");
      pages[scope === "chat" ? `chat/${name}` : `task/${task}/${name}`] = {
        seen_rev: review.seen_rev,
        draft_count: review.draft_count,
        open_count: review.open_count,
        answered: review.answers.filter(recorded).map((answer) => answer.decision),
        open_threads: review.threads.filter((thread) => thread.state === "open").map((thread) => ({ id: thread.id, rev: thread.rev })),
        // As the app sends it: each review with the answers it carried, and every comment that went.
        sent: review.sent.map((item) => ({
          ...item,
          answers: (item.answers ?? []).flatMap((decision) => {
            const said = [...review.answers, ...review.earlier].filter((candidate) => candidate.decision === (typeof decision === "string" ? decision : decision.decision));
            const answer = said.find((candidate) => candidate.sent_at === item.at) ?? said[0];
            return answer ? [{ decision: answer.decision, option: answer.option, label: answer.label, note: answer.note ?? null, defer: answer.defer ?? null }] : [];
          }),
        })),
        threads: review.threads.filter((thread) => thread.sent_at !== null).map((thread) => ({
          id: thread.id, rev: thread.rev, state: thread.state,
          quote: thread.anchor?.quote ?? "", said: thread.comments.map((comment) => comment.body).join(" "), picture: Boolean(thread.picture),
        })),
      };
    }
    return pages;
  }

  async reviewDiscard(ref: ArtifactRef, thread: string) {
    const current = this.review(ref);
    return this.settle(ref, current.threads.filter((item) => item.id !== thread || item.sent_at !== null));
  }

  async reviewSubmit(ref: ArtifactRef, rev: number, verdict: ReviewVerdict) {
    // As in the app: the intake records the answers first, and only what it recorded is told.
    const outcomes = this.recordStaged(ref);
    const current = this.review(ref);
    const draft = current.threads.filter((thread) => thread.sent_at === null);
    const told = current.answers.filter((answer) => answer.sent_at === null && answer.recorded?.result === "closed");
    // Answers in words go with every review until one carries them; the first mate records them.
    const worded = current.answers.filter((answer) => answer.option === null && answer.sent_at === null && !answer.recorded);
    const said = { approve: "Approved.", changes: "Requests changes.", comment: "Comments only, nothing is blocked." }[verdict];
    const text = [
      `Captain's review of "${ref.name}" (rev ${rev}): ${said}`,
      ...recordedLines(told),
      ...wordedLines(worded),
      // The same shape the app's own composer writes, so the browser review sees what a first mate would.
      ...draft.flatMap((thread) => {
        const anchor = thread.anchor as { quote?: string; scene?: string; scene_file?: string; picture?: string | null } | null;
        const place = anchor?.scene ? `on the diagram "${anchor.quote ?? ""}"` : `on "${anchor?.quote ?? ""}"`;
        const said = thread.comments.map((comment) => comment.body).join(" ");
        const folder = `${this.snapshot.fleet.fm_home}/data/${ref.task ?? ".artifacts"}/artifacts/${ref.name}`;
        return anchor?.scene
          ? [`${thread.id} ${place}: ${said}`, `  proposed scene: ${anchor.scene_file ?? ""}`, ...(anchor.picture ? [`  picture of it: ${anchor.picture}`] : [])]
          : [`${thread.id} ${place}: ${said}`, ...whereLines(thread, folder)];
      }),
    ].join("\n");
    const message = await this.send(text);
    const at = Date.now();
    const carried = [...told, ...worded];
    this.reviews.set(`${ref.scope}/${ref.task}/${ref.name}`, { ...current, answers: current.answers.map((answer) => carried.includes(answer) ? { ...answer, sent_at: at } : answer) });
    this.holdUntilTheDay(worded.filter((answer) => answer.defer).map((answer) => answer.decision));
    const review = this.settle(
      ref,
      current.threads.map((thread) => thread.sent_at === null ? { ...thread, sent_at: at, state: "open" as const } : thread),
      [...current.sent, { at, verdict, rev, message, header: text.split("\n")[0], threads: draft.map((thread) => thread.id), answers: carried.map((answer) => answer.decision) }],
    );
    return { message, text, review, outcomes };
  }

  subscribe(listener: HostEventListener) {
    this.listeners.add(listener);
    if (reviewFlag("replay")) {
      if (!this.startupPlayed) void this.replay(window.__FM_REPLAY__ ?? []);
      this.startupPlayed = true;
      return () => this.listeners.delete(listener);
    }
    // The recorded startup starts the first mate, which `?not-started`, `?relaunch` and a refused or dead start must not do.
    // `?reloaded`: the window opened while the first mate was already running, so no startup reaches it.
    if (!this.startupPlayed && !reviewFlag("not-started") && !reviewFlag("relaunch") && !reviewFlag("reloaded") && !this.problem()) {
      this.startupPlayed = true;
      this.play(recordedStream.startup as RecordedEvent[]);
      this.later(600, () => this.reportUsage());
      // `?markdown`: one reply in the shapes a first mate writes, for judging chat formatting by eye.
      if (reviewFlag("markdown")) this.later(900, () => this.emit({ type: "history", payload: { items: [...MARKDOWN_SAMPLE] } }));
      const health = reviewValue("health");
      if (health) this.later(700, () => this.emit({ type: "host_health", payload: health === "session_limit"
        ? { kind: "session_limit", id: "mock-0", warning: "You've hit your session limit · resets 1:50pm (America/Los_Angeles)" }
        : { kind: health, after: "restart", report: { pgid: 4242, survivors: ["4243 node claude-agent-acp"] } } }));
    }
    return () => this.listeners.delete(listener);
  }

  async hostStart() {
    const problem = this.problem();
    if (problem) {
      this.emit({ type: "state", payload: { state: problem.state, reason: problem.reason, reason_kind: problem.kind } });
      throw new Error(problem.reason);
    }
    // `?start-throws`: the first Start fails before the host reports any state.
    if (reviewFlag("start-throws") && !this.startThrown) {
      this.startThrown = true;
      throw new Error("host_start: the host is still shutting down the previous first mate");
    }
    // `?relaunch`: the app was closed with messages still waiting, so the host reports them, with their words, before the session resumes.
    // With `?session-lost` the earlier conversation couldn't be resumed, so there is no history to pair them with.
    if (reviewFlag("relaunch")) {
      this.emit({ type: "state", payload: { state: "starting", home: this.snapshot.fleet.fm_home } });
      this.later(400, () => {
        const lost = reviewFlag("session-lost");
        // Oldest first, as the durable outbox holds them: the cut-off message was handed over before, the other never was.
        this.emit({ type: "outbox", payload: { id: "m-1", status: "requeued", resent_after_restart: true, text: CUT_OFF_MESSAGE } });
        this.emit({ type: "outbox", payload: { id: "m-2", status: "queued", text: "Also merge the foreman PR." } });
        // `?call-answered`: one of the messages still waiting is the captain's answer to the open Captain's Call.
        if (reviewFlag("call-answered")) this.emit({ type: "outbox", payload: { id: "m-3", status: "queued", text: CALL_ANSWER } });
        this.emit({ type: "session", payload: { mode: lost ? "new" : "loaded", session_id: "79f27945-68cf-4639-899d-49576d4668e4", previous_session_lost: lost } });
        if (!lost) this.emit({ type: "history", payload: { items: [...EARLIER_CONVERSATION, { who: "captain", text: CUT_OFF_MESSAGE }] } });
        this.emit({ type: "state", payload: { state: "idle" } });
        // The host then hands the waiting messages over: `?drain` to the first mate, which reads them,
        // or `?failed` into a turn that errors, as a session limit does.
        if (reviewFlag("failed") || reviewFlag("drain")) {
          this.later(600, () => {
            for (const id of ["m-1", "m-2", "m-3"]) {
              this.emit({ type: "outbox", payload: { id, status: "sent" } });
              this.emit(reviewFlag("failed")
                ? { type: "outbox", payload: { id, status: "failed", error: SESSION_LIMIT_ERROR } }
                : { type: "outbox", payload: { id, status: "picked_up" } });
            }
          });
        }
      });
      return;
    }
    // `?slow-start`: starting takes a while, so the captain can send first; with `?history` it resumes the recorded session.
    if (reviewFlag("slow-start")) {
      this.emit({ type: "state", payload: { state: "starting", home: this.snapshot.fleet.fm_home } });
      this.later(1500, () => {
        const loaded = reviewFlag("history");
        this.emit({ type: "session", payload: { mode: loaded ? "loaded" : "new", session_id: "79f27945-68cf-4639-899d-49576d4668e4", previous_session_lost: false } });
        if (loaded) this.emit({ type: "history", payload: { items: [...this.transcript] } });
        this.emit({ type: "state", payload: { state: "idle" } });
      });
      return;
    }
    // Like the host's own, `starting` names the home the first mate starts in, so sending there works from now on.
    this.emit({ type: "state", payload: { state: "starting", home: this.snapshot.fleet.fm_home } });
    this.emit({ type: "state", payload: { state: "idle" } });
    this.later(300, () => this.reportUsage());
  }

  /** What the host reports after a turn: the context reading and the session's Claude limit. `?usage=start` has had no turn yet. */
  private reportUsage() {
    if (!this.usage.context) return;
    this.context = this.usage.context;
    this.emit({ type: "usage", payload: { at_ms: Date.now(), update: { used: this.context.used ?? undefined, size: this.context.size ?? undefined }, context: this.context, rate_limit: this.usage.rateLimit } });
  }

  updateStatus() {
    return this.updates.status();
  }

  updateCheck() {
    return this.updates.check();
  }

  updateRestart() {
    return this.updates.restart();
  }

  updateCancel() {
    return this.updates.cancel();
  }

  updateSeen() {
    return this.updates.seen();
  }

  onUpdate(listener: (update: AppUpdate) => void) {
    return this.updates.listen(listener);
  }

  async readQuota(): Promise<QuotaRead> {
    // Nothing is read before the scenario's first read lands, however many times the window asks.
    await new Promise((resolve) => window.setTimeout(resolve, Math.max(300, this.openedAt + this.usage.quotaDelay - Date.now())));
    return this.keychainAllowed ? this.usage.allowed(Date.now()) : this.usage.quota(Date.now());
  }

  /** Stands in for macOS asking the captain, who allows it. */
  async allowQuotaKeychain(): Promise<QuotaRead> {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    this.keychainAllowed = true;
    return this.usage.allowed(Date.now());
  }

  /**
   * `/compact`, as the real host and adapter run it: after the turn that is running, Claude Code's own words,
   * then the reading it leaves. `?usage=compact-fails`: Claude Code says it could not compact.
   */
  private compact(id: string) {
    const busy = this.state === "prompt_turn" || this.state === "agent_turn";
    this.later(busy ? 2500 : 300, () => {
      this.emit({ type: "outbox", payload: { id, status: "sent" } });
      this.emit({ type: "compact", payload: { id, state: "sent" } });
      this.emit({ type: "state", payload: { state: "prompt_turn" } });
      this.emit({ type: "text", payload: { chunk: "Compacting...", origin: "prompt" } });
      this.emit({ type: "compact", payload: { id, state: "running" } });
      this.later(1800, () => {
        const failure = this.usage.compactFailure;
        if (failure) {
          this.emit({ type: "text", payload: { chunk: `\n\n${failure}`, origin: "prompt" } });
          this.emit({ type: "compact", payload: { id, state: "failed", error: failure } });
        } else {
          const from = this.context?.used ?? 0;
          const at = Date.now();
          this.context = { used: 61_200, size: this.context?.size ?? 1_000_000, at_ms: at, resumed: this.context?.resumed ?? false, compacted: { from, to: 61_200, at_ms: at } };
          this.emit({ type: "usage", payload: { at_ms: at, update: { used: 61_200, size: this.context.size ?? undefined }, context: this.context, rate_limit: this.usage.rateLimit } });
          this.emit({ type: "text", payload: { chunk: "\n\nCompacting completed.", origin: "prompt" } });
          this.emit({ type: "compact", payload: { id, state: "done", context: this.context } });
        }
        this.outstanding.delete(id);
        this.emit({ type: "outbox", payload: { id, status: "picked_up" } });
        this.emit({ type: "state", payload: { state: "idle" } });
      });
    });
  }

  async hostStop() {
    this.clearTimers();
    this.emit({ type: "state", payload: { state: "dead" } });
  }

  async hostRestart() {
    this.clearTimers();
    const [id] = this.outstanding;
    this.play(recordedStream.restart as RecordedEvent[], id);
  }

  async send(text: string) {
    if (reviewFlag("replay")) {
      // The recording's next message goes when the captain sends one, under the id the host gave it.
      const id = this.replayIds.shift() ?? `replay-extra-${++this.sequence}`;
      this.replaySent.add(id);
      this.awaitingSend?.(id);
      this.awaitingSend = null;
      return id;
    }
    const id = `mock-${++this.sequence}`;
    this.outstanding.add(id);
    this.emit({ type: "outbox", payload: { id, status: "queued" } });
    if (/^\/compact(\s|$)/.test(text.trim())) {
      this.transcript.push({ who: "captain", text });
      this.compact(id);
      return id;
    }
    if (reviewFlag("records-chat")) this.recordToldInChat(text);
    const run = () => text.startsWith("Start work on ") ? this.startTurn(id, text) : this.deliver(id, text);
    if (this.state === "starting") this.deferred.push(run);
    else run();
    return id;
  }

  /**
   * `?records-chat`: the first mate records a call the captain answered in words in chat, the way Bearings words it,
   * and the call closes a moment later.
   */
  private recordToldInChat(text: string) {
    const call = this.snapshot.fleet.calls?.find((item) => item.state === "open" && text.startsWith(`On the ${item.id.replace(/-/g, " ")}: `));
    if (!call) return;
    const label = text.slice(`On the ${call.id.replace(/-/g, " ")}: `.length);
    this.later(1200, () => {
      const at = new Date().toISOString();
      this.snapshot.fleet = { ...this.snapshot.fleet, calls: this.snapshot.fleet.calls!.map((item) => item.id === call.id ? { ...item, state: "closed" as const, captain_actionable: false, answer: { key: null, label, by: "captain" as const, via: "chat", at } } : item) };
      this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
    });
  }

  /**
   * The asks `src-tauri/src/start.rs` records, here in memory. `?start=earlier` begins with an ask for the queued scout
   * sent before this launch, so the host's outbox no longer holds it: it was read, and the row is still queued.
   */
  private readonly asks = new Map<string, StartAsk>(reviewValue("start") === "earlier" ? [[START_SCOUT, {
    at: Date.now() - 60 * 60_000, task: START_SCOUT, project: "resonance", title: "Resonance: which feeds publish chapters?", kind: "scout",
    mode: "judge", note: null, message: "mock-earlier", error: null,
    header: "Start work on res-chapters-scout (resonance): Resonance: which feeds publish chapters?", text: "Start work on res-chapters-scout (resonance): Resonance: which feeds publish chapters?",
  }]] : []);
  private startRefused = false;

  /**
   * Hands a task to the first mate as `start_work` does: the message in start.rs's words, sent the ordinary way, and
   * the ask recorded. `?start=unsent`: the host does not take the first ask, as when the first mate is not running here.
   */
  async startWork({ task, project, title, kind, mode, note }: StartRequest): Promise<StartAsk> {
    const how = { judge: "your call, by the project's posture.", "no-mistakes": "full checks (no-mistakes).", "direct-PR": "straight to a PR (direct-PR)." }[mode];
    if (!how) throw new Error(`'${mode}' is not a way a task ships`);
    if (kind !== "ship" && mode !== "judge") throw new Error(`a ${kind} has no delivery mode to choose`);
    const words = note?.trim() || null;
    const text = [`Start work on ${task} (${project}): ${title.split(/\s+/).join(" ")}`, ...(kind === "ship" ? [`How it ships: ${how}`] : []), ...(words ? [`From me: ${words}`] : [])].join("\n");
    const refuse = reviewValue("start") === "unsent" && !this.startRefused;
    this.startRefused ||= refuse;
    const message = refuse ? null : await this.send(text);
    const ask: StartAsk = { at: Date.now(), task, project, title, kind, mode, note: words, message, error: refuse ? "The first mate isn't running in this folder." : null, header: text.split("\n")[0], text };
    this.asks.set(task, ask);
    return ask;
  }

  async startAsks() {
    return Object.fromEntries(this.asks);
  }

  /**
   * The first mate's turn on an ask to start work, by `?start=<outcome>`:
   * `launch` (the default) briefs and spawns, the pane holding only a shell at first and its agent seen alive a moment
   * later; `light` does the same under direct-PR, noting why in the row; `decline` answers in chat instead; `refused-mode`,
   * `refused-blanks`, `refused-empty` and `refused-unknown` meet fm-spawn.sh's refusals, in its words; `hold` puts a
   * question to the captain on the row; `no-agent` registers a worker whose agent never started; `unconfirmed` one on
   * a backend with no classifier; `finish` one on such a backend that then speaks for itself, a status line first and
   * a PR later, its row moving to done; `orphan` moves the row with no worker registered; `failed` errors before
   * reading it; and `slow` is still reading it.
   */
  private startTurn(id: string, text: string) {
    const task = text.match(/^Start work on (\S+) /)?.[1] ?? "";
    const outcome = reviewValue("start") || "launch";
    const step = (n: number, title: string, status = "completed") => {
      this.emit({ type: "tool_call", payload: { id: `start-${n}-${id}`, title, kind: "execute", status: "in_progress" } });
      this.emit({ type: "tool_update", payload: { id: `start-${n}-${id}`, status } });
    };
    const say = (words: string) => this.emit({ type: "text", payload: { chunk: words, origin: "prompt" } });
    const end = () => {
      this.outstanding.delete(id);
      this.emit({ type: "outbox", payload: { id, status: "picked_up" } });
      this.emit({ type: "state", payload: { state: "idle" } });
    };
    this.emit({ type: "outbox", payload: { id, status: "sent" } });
    this.emit({ type: "state", payload: { state: "prompt_turn" } });
    if (outcome === "slow") return;
    if (outcome === "failed") {
      this.later(300, () => {
        this.outstanding.delete(id);
        this.emit({ type: "outbox", payload: { id, status: "failed", error: "The first mate's turn ended with an error before it read this." } });
        this.emit({ type: "state", payload: { state: "idle" } });
      });
      return;
    }
    const kind = this.snapshot.fleet.backlog?.records.find((record) => record.id === task)?.kind ?? "ship";
    const scout = kind === "scout";
    // fm-spawn.sh's own words for each refusal (engine/bin/fm-spawn.sh), which the first mate passes on.
    const refusals: Record<string, string> = {
      "refused-mode": `error: delivery mismatch for ${task}: the brief says mode=no-mistakes but this spawn passed --mode direct-PR; correct the flag or re-scaffold the brief so the worker's instructions and the task record agree`,
      "refused-blanks": `error: data/${task}/brief.md still contains {TASK} or {FIRSTMATE_SPEC}; fill ## Captain's intent and ## Firstmate spec before spawn`,
      "refused-empty": `error: data/${task}/brief.md must contain nonempty ## Captain's intent and ## Firstmate spec subsections (or a nonempty legacy # Task body) before spawn`,
      "refused-unknown": `error: task ${task} has no backlog item in this home, so dispatching it would leave a worker no record owns; add it first (bin/fm-tasks-axi.sh add ${task} '<title>' --kind ${kind}) and re-run`,
    };
    const mode = outcome === "light" ? "direct-PR" : "no-mistakes";
    this.later(250, () => {
      this.emit({ type: "outbox", payload: { id, status: "likely_started" } });
      step(1, `bin/fm-brief.sh ${task} ${scout ? "--scout" : `--mode ${mode}`}`);
    });
    this.later(500, () => {
      if (outcome === "decline") {
        say(`I haven't started ${task}: it needs the snip lifecycle work to land first, and that is still in review. Say the word and I'll start it anyway.`);
        return end();
      }
      if (refusals[outcome]) {
        step(2, `bin/fm-spawn.sh ${task} ${scout ? "--scout" : `--mode ${mode} --yolo off`}`, "failed");
        say(`fm-spawn.sh refused to start ${task}, so it is still queued:\n\n    ${refusals[outcome]}\n\nI'll fix the brief and try again if you want.`);
        return end();
      }
      if (outcome === "hold") {
        this.holdForCaptain(task);
        say(`Before I start ${task} I need your word on one thing, so I've put it to you as a call.`);
        return end();
      }
      step(2, `bin/fm-spawn.sh ${task} ${scout ? "--scout" : `--mode ${mode} --yolo off`}`);
      this.spawnFor(task, kind, mode, outcome);
      say(`Started ${task}${scout ? " as a scout" : ` under ${mode}`}.`);
      end();
      // Its agent comes up a moment after the spawn, and the snapshot sees it the next time it reads.
      if (outcome === "launch" || outcome === "light") this.later(2500, () => this.seeAgent(task, "alive"));
      if (outcome === "finish") {
        this.later(2500, () => this.workerWrites(task, "working", "Reading how the waveform is drawn."));
        this.later(9000, () => this.workerWrites(task, "done", "Opened PR #31: the waveform takes each speaker's colour.", "https://github.com/caomyer/Resonance/pull/31"));
      }
    });
  }

  /** fm-spawn.sh's part, as the snapshot shows it: the row in flight and, but for `orphan`, its worker registered. */
  private spawnFor(task: string, kind: string, mode: string, outcome: string) {
    const home = this.snapshot.fleet.fm_home;
    const now = new Date().toISOString();
    const fleet = this.snapshot.fleet;
    const records = (fleet.backlog?.records ?? []).map((record) => record.id !== task ? record : {
      ...record, state: "in_flight", current_role: "in_flight",
      // The first mate notes why a task ships lighter than its project's posture, in the row, as engine/AGENTS.md has it.
      body_lines: outcome === "light" ? [...(record.body_lines ?? []), "Mode: direct-PR, because this only changes the app's own drawing code and nothing a listener sees changes."] : record.body_lines,
    });
    const launchedMinutesAgo = outcome === "no-agent" ? 3 : outcome === "unconfirmed" ? 5 : 0;
    const worker = mockTask(home, task, kind, "unknown", launchedMinutesAgo, { detail: "harness state unavailable", note: "", report: false, observedAt: now });
    worker.mode = kind === "scout" ? "scout" : mode;
    worker.paths.status_log = { present: false, last_event: { state: "", note: "", raw: "" } };
    // Right after a spawn the pane holds only a shell, so the probe reads no agent yet; a backend with no classifier reads unknown.
    const unclassified = outcome === "unconfirmed" || outcome === "finish";
    worker.endpoint = unclassified
      ? { ...worker.endpoint, agent_alive: "unknown", status: "unknown" }
      : { ...worker.endpoint, agent_alive: "dead", status: "dead" };
    if (unclassified) worker.backend = "zellij";
    // qd-spawn-race-1 as it was recorded: the pane's busy signature read busy while the pane held only a shell.
    if (outcome === "no-agent" || outcome === "unconfirmed") worker.current_state = { ...worker.current_state, state: "working", source: "pane", detail: "harness busy (fm-spawn)", raw: "state: working · source: pane · harness busy (fm-spawn)" };
    const orphan = outcome === "orphan";
    this.snapshot.fleet = {
      ...fleet, generated: now,
      backlog: { ...fleet.backlog, records },
      tasks: orphan ? fleet.tasks : [...fleet.tasks, worker],
      main_inventory: { valid: !orphan, reason: orphan ? `in-flight backlog item has no child metadata: ${task}` : null, orphan_in_flight: orphan ? [task] : [], unstructured_current_count: 0 },
    };
    this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
  }

  /** The snapshot's next reading of a worker's agent, through the probe. */
  private seeAgent(task: string, status: "alive" | "dead") {
    const now = new Date().toISOString();
    this.snapshot.fleet = {
      ...this.snapshot.fleet, generated: now,
      tasks: this.snapshot.fleet.tasks.map((worker) => worker.id !== task ? worker : {
        ...worker,
        current_state: { ...worker.current_state, state: "working", source: "pane", detail: "harness busy (claude-hook)", observed_at: now },
        endpoint: { ...worker.endpoint, agent_alive: status, status, observed_at: now },
      }),
    };
    this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
  }

  /**
   * The worker's own status line, as the snapshot next reads it: the probe still cannot classify its backend, and a
   * `done` line carries the PR and the row moves to done.
   */
  private workerWrites(task: string, state: "working" | "done", note: string, pr?: string) {
    const now = new Date().toISOString();
    const fleet = this.snapshot.fleet;
    const raw = `${state}: ${note}`;
    this.snapshot.fleet = {
      ...fleet, generated: now,
      backlog: state !== "done" ? fleet.backlog : { ...fleet.backlog, records: (fleet.backlog?.records ?? []).map((record) => record.id !== task ? record : { ...record, state: "done", current_role: "done", completion: { verb: "done", date: localDate(0) } }) },
      tasks: fleet.tasks.map((worker) => worker.id !== task ? worker : {
        ...worker,
        paths: { ...worker.paths, status_log: { present: true, last_event: { state, note, raw } } },
        current_state: { state, source: "status-log", detail: note, raw, observed_at: now, freshness: "fresh" },
        endpoint: { ...worker.endpoint, observed_at: now },
        pr: pr ? { url: pr, source: "status_event" } : worker.pr,
        hints: { ...worker.hints, last_event_text: raw },
      }),
    };
    this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
  }

  /** `?start=hold`: the first mate turns the ask into a call on the row, as `bin/fm-captain-hold.sh` would. */
  private holdForCaptain(task: string) {
    const now = new Date().toISOString();
    const fleet = this.snapshot.fleet;
    const question = "Should the chapters come from the feed, or from the transcript when a feed has none?";
    this.snapshot.fleet = {
      ...fleet, generated: now,
      backlog: { ...fleet.backlog, records: (fleet.backlog?.records ?? []).map((record) => record.id !== task ? record : { ...record, hold_kind: "captain", hold_reason: question, captain_actionable: true, current_role: "held" }) },
      calls: [...(fleet.calls ?? []), {
        id: task, title: "Resonance: where should chapters come from?", question, options: [{ key: "feed", label: "The feed only", recommended: true }, { key: "both", label: "The feed, else the transcript", recommended: false }],
        on_answer: "release", state: "open", bucket: "live", captain_actionable: true, origin: null, about: null, evidence: [], raised_by: "firstmate", raised_at: now, updated_at: now, answer: null, decided: null,
      }],
    };
    this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
  }

  /** Sizes of the files the mock's picker offers, by where they are. */
  private pickable = new Map<string, number>();

  /**
   * Stands in for the picker: a brief and a screenshot, named with a space and with characters beyond ASCII.
   * `?attach=cancel`: the captain cancels the picker. `?attach=refused`: of three files, one has been removed since
   * and one is over the limit.
   */
  async pickFiles(): Promise<PickResult | null> {
    const asked = reviewValue("attach");
    if (asked === "cancel") return null;
    const pick = (name: string, bytes: number) => {
      const source = `/Users/captain/Desktop/${name}`;
      this.pickable.set(source, bytes);
      return { name, source, bytes };
    };
    if (asked === "refused") {
      return {
        picked: [pick("crew notes.md", 5_120)],
        refused: [
          { source: "/Users/captain/Desktop/old plan.pdf", problem: "old plan.pdf is no longer there." },
          { source: "/Users/captain/Movies/demo.mov", problem: "demo.mov is 2.4 GB, and files over 100 MB can't be attached. Tell the first mate where it is instead." },
        ],
      };
    }
    return { picked: [pick("Release brief v2.md", 18_432), pick("Écran 日本 2026-09-22.png", 1_540_000)], refused: [] };
  }

  /**
   * Stands in for the copy into the home as a message is sent. `?attach=gone`: the brief was removed after it was picked.
   * `?attach=slow`: the copy takes a moment, as a large file does.
   */
  async copyFiles(sources: string[]): Promise<CopyResult> {
    if (reviewValue("attach") === "slow") await new Promise((resolve) => setTimeout(resolve, 1500));
    const name = (source: string) => source.split("/").pop() ?? source;
    const gone = sources.filter((source) => !this.pickable.has(source) || (reviewValue("attach") === "gone" && name(source) === "Release brief v2.md"));
    if (gone.length > 0) return { attached: [], refused: gone.map((source) => ({ source, problem: `${name(source)} is no longer there.` })) };
    const attached = sources.map((source) => {
      const folder = `${this.snapshot.fleet.fm_home}/data/.attachments/${Date.now()}-${++this.sequence}`;
      return { name: name(source), path: `${folder}/${name(source)}`, source, bytes: this.pickable.get(source) ?? 0 };
    });
    return { attached, refused: [] };
  }

  /** Hands a message to the first mate: from here it's part of the session's conversation. */
  private deliver(id: string, text: string) {
    this.transcript.push({ who: "captain", text });
    // `?failed`: the message is delivered, but its turn errors on the session limit, which the host also reports as a health warning.
    const limit = "You've hit your session limit · resets 1:50pm (America/Los_Angeles)";
    const events = (recordedStream.send as RecordedEvent[]).flatMap((item): RecordedEvent[] => reviewFlag("failed") && item.type === "outbox" && item.payload.state === "picked_up"
      ? [
        { ...item, type: "host_health", payload: { kind: "session_limit", id: "$id", warning: limit } },
        { ...item, payload: { ...item.payload, state: "failed", error: JSON.stringify({ code: -32603, data: { errorKind: "rate_limit" }, message: `Internal error: ${limit}` }) } },
      ]
      : [item]);
    this.play(events, id);
    if (reviewFlag("ask")) {
      // `?ask`: the first mate asks for an approval partway through the turn.
      this.later(400, () => this.emit({ type: "permission_request", payload: {
        id: `ask-${id}`,
        title: "cd /Users/mingyucao_1/.buzz/.scratch/fm-probe/firstmate/projects/resonance && \\\n  git push origin fm/res-ai-titles",
        options: [
          { option_id: "allow", name: "Allow", kind: "allow_once" },
          { option_id: "allow_always", name: "Always Allow", kind: "allow_always" },
          { option_id: "reject", name: "Reject", kind: "reject_once" },
        ],
      } }));
    }
  }

  async cancelTurn() {
    this.clearTimers();
    this.emit({ type: "state", payload: { state: "idle" } });
  }

  async getState(): Promise<HostStateSnapshot> {
    // Until a Start, the host has nothing to report about one.
    const problem = this.state === "stopped" ? null : this.problem();
    // `?not-started`: the first mate has not started in any home since launch.
    return {
      state: { state: this.state, reason: problem?.reason, reasonKind: problem?.kind },
      // The host only knows a home once it has started in one, so before a Start there is none to report.
      home: reviewFlag("not-started") || problem || (reviewFlag("relaunch") && this.state === "stopped") ? null : this.snapshot.fleet.fm_home,
      // `?reloaded`: the running host still has the conversation the window missed.
      conversation: reviewFlag("reloaded") ? { sessionId: "79f27945-68cf-4639-899d-49576d4668e4", items: [...EARLIER_CONVERSATION] } : null,
      // `?reloaded`: the host already had a reading when the window opened.
      usage: { context: reviewFlag("reloaded") ? this.usage.context : this.context, rateLimit: this.usage.rateLimit },
    };
  }

  async latestSnapshot(): Promise<SnapshotEvent> {
    if (reviewFlag("snapshot-error")) {
      // `?snapshot-error`: the last Bearings read failed, so what's on screen is from an earlier one.
      return {
        phase: "ready",
        generated_at_ms: Date.now() - 12 * 60_000,
        ...this.snapshot,
        errors: [{ source: "fm-bearings-snapshot.sh", error: "fm-bearings-snapshot.sh exited with exit status: 1: jq: error (at data/backlog.md:0): Cannot iterate over null" }],
      };
    }
    return { phase: "ready", ...this.snapshot };
  }

  /** The browser review path keeps the fixtures, so it reports the fixture's home. `?first-launch` shows the folder question instead. */
  async getHome(): Promise<HomeStatus> {
    if (reviewFlag("first-launch") && !this.homeChosen) return { home: null, problem: null, chosen: false };
    // `?start-on-launch`, with `?relaunch`: the first mate was running when the app closed, so the app starts it again on its own.
    return { home: this.snapshot.fleet.fm_home, problem: null, startOnLaunch: reviewFlag("start-on-launch"), chosen: this.homeChosen };
  }

  async chooseHome(): Promise<HomeStatus | null> {
    this.homeChosen = true;
    return this.getHome();
  }

  async useAppHome(): Promise<HomeStatus> {
    this.homeChosen = false;
    return this.getHome();
  }

  /** `?needs` shows the first-launch checklist; `?needs=none` an answered one. */
  async toolsMissing(): Promise<{ missing: Needed[]; problem: string | null }> {
    const asked = new URLSearchParams(window.location.search).get("needs");
    if (asked === null) return { missing: [], problem: null };
    if (asked === "none") return { missing: [], problem: null };
    if (asked === "unreadable") return { missing: [], problem: "the first mate could not check this machine: bin/fm-bootstrap.sh: permission denied" };
    return {
      // The shapes a real Mac produces, at the lengths it produces them: the
      // long curl pipeline, the presentation line that is a tool in prose, and
      // the two lines that name no tool at all.
      missing: [
        { tool: "jq", how: "brew install jq  # or the platform's package manager", kind: "install", says: "MISSING: jq (install: brew install jq  # or the platform's package manager)" },
        { tool: "no-mistakes", how: "curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh", kind: "install", says: "MISSING: no-mistakes (install: curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh)" },
        { tool: "lavish-axi", how: "npm install -g lavish-axi && lavish-axi setup hooks", kind: "install", says: "PRESENTATION_UNAVAILABLE: lavish-axi (requires >=0.1.46; install: npm install -g lavish-axi && lavish-axi setup hooks) - nonvisual work may proceed with plain-text decisions and reports; install or upgrade before using Lavish" },
        { tool: "herdr", how: "https://example.invalid/herdr", kind: "manual", says: "MISSING_MANUAL: herdr (instructions: https://example.invalid/herdr)" },
        { tool: null, how: null, kind: "other", says: "TANGLE: primary checkout on feature branch 'fm/example' (expected 'main'); the work is safe on that ref - read-only session must leave restore work to the session holding the fleet lock" },
        { tool: null, how: null, kind: "other", says: "BACKEND_INVALID: zellij (known: tmux herdr cmux orca zellij)" },
      ],
      problem: null,
    };
  }

  async routingGet(): Promise<Routing> {
    return structuredClone(this.routing);
  }

  async routingEnable(from: RoutingStart): Promise<Routing> {
    if (this.routing.on) throw new Error("routing is already on; config/crew-dispatch.json exists");
    if (from === "restore" && !this.routing.setAside) throw new Error("there is no set-aside rules file to restore");
    const rules = from === "template" ? crewDispatchExample : from === "restore" ? '{\n  "rules": [],\n  "default": { "harness": "claude" }\n}\n' : '{\n  "rules": []\n}\n';
    this.routing = { ...this.routing, on: true, rules, sha256: `mock-${++this.routingRevision}`, invalid: null, setAside: from === "restore" ? null : this.routing.setAside };
    return this.routingGet();
  }

  /** Refuses the way firstmate's writer does for the two cases a review exercises; the real check is firstmate's. */
  async routingSave(rules: string, sha256: string | null): Promise<Routing> {
    if (!this.routing.on) throw new Error("routing is off; turn it on before editing its rules");
    if (sha256 !== null && sha256 !== this.routing.sha256) throw new Error("not saved: config/crew-dispatch.json changed since it was read");
    let parsed: { rules?: { use?: unknown }[]; default?: unknown };
    try {
      parsed = JSON.parse(rules);
    } catch {
      throw new Error("not saved: malformed JSON");
    }
    if (parsed.rules !== undefined && !Array.isArray(parsed.rules)) throw new Error("not saved: rules must be an array");
    const profiles = [...(parsed.rules ?? []).map((rule) => rule.use), parsed.default].flat().filter(Boolean) as { harness?: string }[];
    const unknown = profiles.map((profile) => profile.harness ?? "").filter((harness) => !MOCK_HARNESSES.some((choice) => choice.name === harness));
    if (unknown.length) throw new Error(`not saved: unverified harness: ${[...new Set(unknown)].join(", ")}`);
    this.routing = { ...this.routing, rules, sha256: `mock-${++this.routingRevision}`, invalid: null };
    return this.routingGet();
  }

  async routingDisable(): Promise<Routing> {
    if (!this.routing.on) return this.routingGet();
    this.routing = { ...this.routing, on: false, rules: null, sha256: null, invalid: null, setAside: `crew-dispatch.json.off-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}` };
    return this.routingGet();
  }

  /** Keeps only whether a key is set, which is all the real host ever tells the window. */
  async routingSetKey(key: string): Promise<Routing> {
    const line = key.trim();
    if (!line) throw new Error("paste a key first");
    if (line.length > 512 || /[^A-Za-z0-9._~+/=:-]/.test(line)) throw new Error("the key holds a character a key does not; not saved");
    this.routing = { ...this.routing, key: { set: true, source: ".env" } };
    return this.routingGet();
  }

  async routingClearKey(): Promise<Routing> {
    this.routing = { ...this.routing, key: { set: false, source: null } };
    return this.routingGet();
  }

  async answerPermission(id: string, optionId: string) {
    this.emit({ type: "permission_resolved", payload: { id, option_id: optionId } });
  }

  async refreshSnapshot() {
    // `?start`: a fresh reading is stamped with when it was taken, as firstmate stamps its own, since the drawer judges by it.
    if (reviewFlag("start")) this.snapshot.fleet = { ...this.snapshot.fleet, generated: new Date().toISOString() };
    this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
  }

  /**
   * The notes firstmate's `bin/fm-task-note.sh` keeps beside each task, here in memory. The queued Lock Screen task
   * carries a picture and a change of scope, the way the first mate files a captain's screenshot.
   */
  private readonly notes = new Map<string, TaskNote[]>([
    ["res-lockscreen", [
      {
        id: "n1", at: "2026-09-22T09:14:00Z", by: "firstmate", scope: false,
        body: "The captain's picture of what the Lock Screen shows today.",
        files: [{ name: "Lock-Screen-9.41-AM.png", path: "/home/data/res-lockscreen/files/Lock-Screen-9.41-AM.png", bytes: 482_113, original: "Lock Screen 9.41\u202fAM.png" }],
      },
      { id: "n2", at: "2026-09-22T10:02:00Z", by: "firstmate", scope: true, body: "AirPods can wait: ship the Lock Screen widget on its own first.", files: [] },
    ]],
  ]);

  /** `?no-notes`: a firstmate without `fm-task-note.sh`. `?notes-error` fails the read. */
  async taskNotes(taskId: string): Promise<TaskNotes | null> {
    if (reviewFlag("no-notes")) return null;
    if (reviewFlag("notes-error")) throw new Error("fm-task-note.sh exited with 1: the notes in data/x/notes cannot be read");
    return { schema: "fm-task-notes.v1", task: taskId, notes: this.notes.get(taskId) ?? [] };
  }

  /** `?note-refused` refuses every add, in the script's words. */
  async taskNoteAdd(taskId: string, body: string, sources: string[]): Promise<TaskNotes> {
    if (!body.trim() && sources.length === 0) throw new Error("Write a note or add a file first.");
    if (reviewFlag("note-refused")) throw new Error("fm-task-note.sh exited with 1: fm-task-note: /Users/captain/Desktop/huge.mov is 2147483648 bytes, over the 104857600 cap; tell the worker where it is instead");
    const notes = this.notes.get(taskId) ?? [];
    const taken = new Set(notes.flatMap((note) => note.files.map((file) => file.name)));
    const files = sources.map((source): TaskFile => {
      const original = source.split("/").pop() ?? source;
      let name = original.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "").replace(/-+$/, "") || "file";
      const [stem, ext] = name.includes(".") ? [name.slice(0, name.lastIndexOf(".")), name.slice(name.lastIndexOf("."))] : [name, ""];
      for (let n = 2; taken.has(name); n += 1) name = `${stem}-${n}${ext}`;
      taken.add(name);
      return { name, path: `${this.snapshot.fleet.fm_home}/data/${taskId}/files/${name}`, bytes: this.pickable.get(source) ?? 0, original };
    });
    notes.push({ id: `n${notes.length + 1}`, at: new Date().toISOString(), by: "captain", scope: false, body: body.trim(), files });
    this.notes.set(taskId, notes);
    return { schema: "fm-task-notes.v1", task: taskId, notes };
  }

  /** Every picture in the mock is the one fixture, served by the dev server. */
  taskFileUrl(_taskId: string, _file: TaskFile) {
    return lockScreenPicture;
  }

  /**
   * `?no-history`: a firstmate without `fm-history.sh`. `?history-page=<n>` pages by n rows, `?history-error` fails.
   */
  async projectHistory(repo: string, options: { after?: string | null; limit?: number } = {}): Promise<ProjectHistory | null> {
    if (reviewFlag("no-history")) return null;
    if (reviewFlag("history-error")) throw new Error("fm-history.sh exited with 1: cannot read the backlog");
    const all = repo === "resonance" ? mockHistory(this.snapshot.fleet.fm_home) : { records: [], calls: [] };
    const limit = Number(reviewValue("history-page")) || options.limit || 50;
    const start = options.after ? all.records.findIndex((record) => record.id === options.after) + 1 : 0;
    const records = all.records.slice(start, start + limit);
    const next = start + limit < all.records.length ? records.at(-1)?.id ?? null : null;
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    return {
      schema: "fm-history.v1", repo, records, next, archive: { present: true, readable: true },
      calls: all.calls.filter((call) => records.some((record) => record.id === call.id)),
    };
  }

  async paneCapture(taskId: string): Promise<PaneCapture> {
    return {
      text: `task: ${taskId}\nsource: mock pane capture\nstatus: waiting for a fresh worker sighting`,
      observed_at: new Date().toISOString(),
    };
  }

  /** `?refused=<reason_kind>` or `?dead=<reason_kind>`: every Start ends that way. */
  private problem() {
    for (const state of ["refused", "dead"] as const) {
      const kind = reviewValue(state) as ReasonKind | null;
      if (kind) return { state, kind, reason: MOCK_REASONS[kind] ?? `the host reported ${kind}` };
    }
    return null;
  }

  /**
   * Plays a real host recording in order at 1/50 speed. Before each message's first `queued`, it waits for the review to send that message,
   * so captain messages reach the chat the way they do in the app. Recorded tool calls and their updates carry the ACP update nested.
   */
  private async replay(events: NonNullable<Window["__FM_REPLAY__"]>) {
    const queued = new Set<string>();
    // Only a live send waits for the captain. A `queued` that carries its text comes from the durable outbox, which the UI restores on its own.
    this.replayIds = events.filter((item) => item.type === "outbox" && item.payload.state === "queued" && !item.payload.text).map((item) => String(item.payload.id));
    let previous = events.at(0)?.t_ms ?? 0;
    for (const item of events) {
      await new Promise((resolve) => this.later(Math.min(400, Math.round((item.t_ms - previous) / 50)), () => resolve(null)));
      previous = item.t_ms;
      // A recording names the home it ran in on another machine. Played here, the host is running in this mock's
      // home, and a state naming any other would leave the app refusing to send, as it must for a real mismatch.
      const raw = item.type === "state" && typeof item.payload.home === "string" ? { ...item.payload, home: this.snapshot.fleet.fm_home } : item.payload;
      if (item.type === "outbox" && raw.state === "queued" && !raw.text && !queued.has(String(raw.id))) {
        queued.add(String(raw.id));
        if (!this.replaySent.has(String(raw.id))) await new Promise<string>((resolve) => { this.awaitingSend = resolve; });
      }
      if (item.type === "tool_call" || (item.type === "update" && raw.kind === "tool_call_update")) {
        const update = (raw.update ?? {}) as Record<string, unknown>;
        this.emit({ type: item.type === "tool_call" ? "tool_call" : "tool_update", payload: { id: String(update.toolCallId), title: (update.title ?? raw.title) as string | undefined, kind: update.kind as string | undefined, status: update.status as string | undefined } });
      } else if (["session", "history", "state", "text", "outbox", "prompt_result", "usage", "compact", "host_health", "permission_request", "permission_resolved"].includes(item.type)) {
        this.emit(this.normalize(item.type as HostEvent["type"], raw));
      }
    }
  }

  private later(ms: number, run: () => void) {
    this.timers.add(window.setTimeout(run, ms));
  }

  private play(events: RecordedEvent[], id?: string) {
    const startedAt = events.at(0)?.t_ms ?? 0;
    for (const item of events) {
      this.later(Math.round((item.t_ms - startedAt) * TIMING_SCALE), () => {
        const payload = JSON.parse(JSON.stringify(item.payload).replaceAll("$id", id ?? "")) as Record<string, unknown>;
        if (item.type === "snapshot" && payload.phase === "ready") {
          payload.bearings = this.snapshot.bearings;
          payload.fleet = this.snapshot.fleet;
          payload.projects = [
            // `?start`: resonance ships product work checked and internal tooling straight to a PR, as quarterdeck does.
            { name: "resonance", mode: reviewFlag("start") ? "no-mistakes-prod-only" : "no-mistakes", yolo: false, description: "Desktop podcast tools" },
            { name: "foreman", mode: "direct-PR", yolo: true, description: "Agent supervision" },
          ];
        }
        // `?session-lost`: the host couldn't resume the previous session, so the startup opens a fresh one.
        if (item.type === "session" && reviewFlag("session-lost")) payload.previous_session_lost = true;
        // `?history` and `?resumed-day`: the startup resumes the previous session instead of opening a new one.
        if (item.type === "session" && (reviewFlag("history") || reviewFlag("resumed-day")) && !reviewFlag("session-lost")) payload.mode = "loaded";
        const event = this.normalize(item.type, payload);
        this.emit(event);
        if (event.type === "session" && event.payload.mode === "loaded") this.emit({ type: "history", payload: { items: [...this.transcript] } });
        if (event.type === "outbox" && (event.payload.status === "picked_up" || event.payload.status === "failed")) this.outstanding.delete(event.payload.id);
      });
    }
  }

  private normalize(type: HostEvent["type"], raw: Record<string, unknown>): HostEvent {
    if (type === "text") {
      return { type, payload: { chunk: String(raw.text ?? raw.chunk ?? ""), origin: (raw.origin ?? "prompt_or_agent") as "prompt" | "agent" | "prompt_or_agent" } };
    }
    if (type === "outbox") {
      return { type, payload: { id: String(raw.id), status: (raw.state ?? raw.status) as OutboxStatus, resent_after_restart: raw.resent_after_restart === true, error: raw.error as string | undefined, text: raw.text as string | undefined } };
    }
    if (type === "tool_call" || type === "tool_update") {
      return { type, payload: { id: String(raw.toolCallId), title: raw.title as string | undefined, kind: raw.kind as string | undefined, status: raw.status as string | undefined } };
    }
    return { type, payload: raw } as HostEvent;
  }

  private emit(event: HostEvent) {
    if (event.type === "state") {
      this.state = event.payload.state;
      // Like the host, messages sent while starting go to the first mate once it's ready, however it started.
      if (["idle", "prompt_turn", "agent_turn"].includes(this.state)) this.deferred.splice(0).forEach((run) => run());
    }
    this.record(event);
    this.listeners.forEach((listener) => listener(event));
  }

  /** Keeps the transcript the way the adapter's session would: the captain's words, each step, and the first mate's replies. */
  private record(event: HostEvent) {
    if (event.type === "text") {
      const last = this.transcript.at(-1);
      if (this.streaming && last?.who === "mate") last.text += event.payload.chunk;
      else this.transcript.push({ who: "mate", text: event.payload.chunk });
      this.streaming = true;
      return;
    }
    if (event.type === "tool_call") this.transcript.push({ who: "step", text: event.payload.title ?? "" });
    if (event.type !== "tool_update") this.streaming = false;
  }

  private clearTimers() {
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.timers.clear();
  }
}
