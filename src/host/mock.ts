import bearingsFixture from "../fixtures/bearings-snapshot.json";
import fleetFixture from "../fixtures/fleet-snapshot.json";
import recordedStream from "./mock-event-stream.json";
import { artifactPath } from "./types";
import type {
  Artifact,
  ArtifactRef,
  DecisionOptions,
  ArtifactRevision,
  BearingsSnapshot,
  FleetSnapshot,
  FleetTask,
  HistoryItem,
  HomeStatus,
  HostAdapter,
  HostEvent,
  HostEventListener,
  HostRuntimeState,
  HostStateSnapshot,
  OutboxStatus,
  PaneCapture,
  ReasonKind,
  ReviewAnchor,
  ReviewSummary,
  ReviewThread,
  ReviewVerdict,
  ReviewView,
  SnapshotEvent,
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
 */
const ARTIFACT_TASK = "res-titles-scout";
/** A task the fixture backlog records as done, so its page has somewhere settled to sit. */
const LANDED_TASK = "foreman-rebase-before-review";

function mockArtifacts(home: string): { artifacts: Artifact[]; task: FleetTask; decisionOptions: DecisionOptions[]; inFlight: BearingsSnapshot["in_flight"][number] } {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
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
  const board: ArtifactRevision = {
    scope: "chat", task: null, name: "model-download", rev: 1, title: "When may the app download the speech model?", note: null,
    entry: "model-download.html", bytes: 2400, presented_at: at(1), presented_by: { role: "firstmate" }, layout: { status: "clean", issues: [] },
    covers: ["res-model-download"],
  };
  // What the held task offers, as bin/fm-decision-options.sh records it.
  const decisionOptions: DecisionOptions[] = [{
    task: "res-model-download",
    question: "When may the app download the 150 MB speech model?",
    options: [
      { key: "wifi-only", label: "Wi-Fi only, with visible progress", recommended: true },
      { key: "prompt", label: "Ask on the first snip that needs it", recommended: false },
      { key: "eager", label: "Keep downloading eagerly", recommended: false },
    ],
  }];
  // A page whose task has landed: the list files it away on the backlog's word alone.
  const shipped: ArtifactRevision = {
    scope: "task", task: LANDED_TASK, name: "rebase-plan", rev: 1, title: "Rebase the subject before anybody reads it", note: null,
    entry: "rebase-plan.html", bytes: 1900, presented_at: at(2880), presented_by: { role: "crew", task: LANDED_TASK }, layout: { status: "clean", issues: [] },
  };
  const artifacts: Artifact[] = [
    { scope: "chat", task: null, name: "model-download", title: board.title, latest: board, revisions: [board] },
    { scope: "task", task: ARTIFACT_TASK, name: "titles-plan", title: "AI titles for snips", latest: planRevisions[2], revisions: planRevisions },
    { scope: "task", task: LANDED_TASK, name: "rebase-plan", title: shipped.title, latest: shipped, revisions: [shipped] },
  ];
  const task: FleetTask = {
    id: ARTIFACT_TASK, kind: "scout", harness: "claude", mode: "no-mistakes", yolo: "off", project: `${home}/projects/resonance`, backend: "tmux",
    paths: {
      status_log: { present: true, last_event: { state: "working", note: "Compare ways to title snips and show what each looks like.", raw: "working: comparing title options" } },
      worktree: { path: `${home}/worktrees/${ARTIFACT_TASK}`, present: true },
      report: { path: `${home}/data/${ARTIFACT_TASK}/report.md`, present: false },
    },
    current_state: { state: "working", source: "status", detail: "Revising the titles plan.", raw: "working: revising the titles plan", observed_at: at(2), freshness: "fresh" },
    endpoint: { target: `fm:${ARTIFACT_TASK}`, exists: true, agent_alive: "yes", status: "alive", observed_at: at(2), freshness: "fresh" },
    pr: { url: null, source: "none" },
    hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: "" },
    actions: { watch: "", steer: "", return_channel_note: null },
  };
  return { artifacts, task, decisionOptions, inFlight: { id: ARTIFACT_TASK, kind: "scout", state: "working", repo: task.project, name: "AI titles for snips", doing: "Revising the titles plan." } };
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
    : reviewFlag("history")
      ? [...EARLIER_CONVERSATION]
      : [];
  private streaming = false;
  private readonly snapshot = MockHostAdapter.fixtureSnapshot();

  private static fixtureSnapshot() {
    const bearings = bearingsFixture as unknown as BearingsSnapshot;
    const fleet = fleetFixture as unknown as FleetSnapshot;
    if (!reviewFlag("artifacts")) return { bearings, fleet };
    const { artifacts, task, decisionOptions, inFlight } = mockArtifacts(fleet.fm_home);
    return {
      bearings: { ...bearings, in_flight: [...bearings.in_flight, inFlight] },
      fleet: { ...fleet, tasks: [...fleet.tasks, task], artifacts, decision_options: decisionOptions },
    };
  }

  /** The dev server serves the review pages at the same paths the app's `artifact` scheme does. */
  artifactUrl(revision: ArtifactRevision) {
    return `/artifacts/${artifactPath(revision)}`;
  }

  /** Reviews live in memory here; the app keeps them in the home beside the revisions. */
  private readonly reviews = new Map<string, ReviewView>();
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
    const current = this.reviews.get(key) ?? { threads: [], answers: [], draft_count: 0, staged_answers: 0, open_count: 0, sent: [], seen_rev: null, log: `${this.snapshot.fleet.fm_home}/data/${ref.task ?? ".artifacts"}/review.jsonl` };
    this.reviews.set(key, current);
    return current;
  }

  private settle(ref: ArtifactRef, threads: ReviewThread[], sent = this.review(ref).sent) {
    const next: ReviewView = {
      ...this.review(ref),
      threads,
      sent,
      draft_count: threads.filter((thread) => thread.sent_at === null).length + this.review(ref).answers.filter((answer) => answer.sent_at === null).length,
      staged_answers: this.review(ref).answers.filter((answer) => answer.sent_at === null).length,
      open_count: threads.filter((thread) => thread.state === "open").length,
    };
    this.reviews.set(`${ref.scope}/${ref.task}/${ref.name}`, next);
    return next;
  }

  async reviewGet(ref: ArtifactRef) {
    return this.review(ref);
  }

  async reviewComment(ref: ArtifactRef, rev: number, body: string, anchor?: ReviewAnchor, thread?: string) {
    const current = this.review(ref);
    const at = Date.now();
    if (thread) {
      return this.settle(ref, current.threads.map((item) => item.id === thread ? { ...item, comments: [...item.comments, { body, at }] } : item));
    }
    const id = this.nextThreadId(ref);
    return this.settle(ref, [...current.threads, { id, rev, anchor: anchor ?? null, at, sent_at: null, resolved_at: null, state: "draft", comments: [{ body, at }] }]);
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

  async reviewAnswer(ref: ArtifactRef, decision: string, option?: string, label?: string) {
    const current = this.review(ref);
    // As in the app: a sent answer is on the record and stays as it went.
    if (current.answers.some((answer) => answer.decision === decision && answer.sent_at !== null)) {
      throw new Error("that answer has already gone to the first mate; tell it in chat if you have changed your mind");
    }
    const kept = current.answers.filter((answer) => answer.decision !== decision);
    const answers = option ? [...kept, { decision, option, label: label ?? option, at: Date.now(), sent_at: null }] : kept;
    this.reviews.set(`${ref.scope}/${ref.task}/${ref.name}`, { ...current, answers });
    return this.settle(ref, current.threads);
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
        answered: review.answers.filter((answer) => answer.sent_at !== null).map((answer) => answer.decision),
      };
    }
    return pages;
  }

  async reviewDiscard(ref: ArtifactRef, thread: string) {
    const current = this.review(ref);
    return this.settle(ref, current.threads.filter((item) => item.id !== thread || item.sent_at !== null));
  }

  async reviewSubmit(ref: ArtifactRef, rev: number, verdict: ReviewVerdict) {
    const current = this.review(ref);
    const draft = current.threads.filter((thread) => thread.sent_at === null);
    const staged = current.answers.filter((answer) => answer.sent_at === null);
    const said = { approve: "Approved.", changes: "Requests changes.", comment: "Comments only, nothing is blocked." }[verdict];
    const text = [
      `Captain's review of "${ref.name}" (rev ${rev}): ${said}`,
      ...(staged.length ? ["Answers, to record with bin/fm-captain-hold.sh:", ...staged.map((answer) => `${answer.option ? `${answer.decision} = ${answer.option}` : answer.decision}: ${answer.label}`)] : []),
      // The same shape the app's own composer writes, so the browser review sees what a first mate would.
      ...draft.flatMap((thread) => {
        const anchor = thread.anchor as { quote?: string; scene?: string; scene_file?: string; picture?: string | null } | null;
        const place = anchor?.scene ? `on the diagram "${anchor.quote ?? ""}"` : `on "${anchor?.quote ?? ""}"`;
        const said = thread.comments.map((comment) => comment.body).join(" ");
        return anchor?.scene
          ? [`${thread.id} ${place}: ${said}`, `  proposed scene: ${anchor.scene_file ?? ""}`, ...(anchor.picture ? [`  picture of it: ${anchor.picture}`] : [])]
          : [`${thread.id} ${place}: ${said}`];
      }),
    ].join("\n");
    const message = await this.send(text);
    const at = Date.now();
    this.reviews.set(`${ref.scope}/${ref.task}/${ref.name}`, { ...current, answers: current.answers.map((answer) => answer.sent_at === null ? { ...answer, sent_at: at } : answer) });
    const review = this.settle(
      ref,
      current.threads.map((thread) => thread.sent_at === null ? { ...thread, sent_at: at, state: "open" as const } : thread),
      [...current.sent, { at, verdict, rev, message, threads: draft.map((thread) => thread.id) }],
    );
    return { message, text, review };
  }

  subscribe(listener: HostEventListener) {
    this.listeners.add(listener);
    if (reviewFlag("replay")) {
      if (!this.startupPlayed) void this.replay(window.__FM_REPLAY__ ?? []);
      this.startupPlayed = true;
      return () => this.listeners.delete(listener);
    }
    // The recorded startup starts the first mate, which `?not-started`, `?relaunch` and a refused or dead start must not do.
    if (!this.startupPlayed && !reviewFlag("not-started") && !reviewFlag("relaunch") && !this.problem()) {
      this.startupPlayed = true;
      this.play(recordedStream.startup as RecordedEvent[]);
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
    this.emit({ type: "state", payload: { state: "idle" } });
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
    const run = () => this.deliver(id, text);
    if (this.state === "starting") this.deferred.push(run);
    else run();
    return id;
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
    if (reviewFlag("first-launch") && !this.homeChosen) return { home: null, problem: null };
    return { home: this.snapshot.fleet.fm_home, problem: null };
  }

  async chooseHome(): Promise<HomeStatus | null> {
    this.homeChosen = true;
    return this.getHome();
  }

  async answerPermission(id: string, optionId: string) {
    this.emit({ type: "permission_resolved", payload: { id, option_id: optionId } });
  }

  async refreshSnapshot() {
    this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
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
      const raw = item.payload;
      if (item.type === "outbox" && raw.state === "queued" && !raw.text && !queued.has(String(raw.id))) {
        queued.add(String(raw.id));
        if (!this.replaySent.has(String(raw.id))) await new Promise<string>((resolve) => { this.awaitingSend = resolve; });
      }
      if (item.type === "tool_call" || (item.type === "update" && raw.kind === "tool_call_update")) {
        const update = (raw.update ?? {}) as Record<string, unknown>;
        this.emit({ type: item.type === "tool_call" ? "tool_call" : "tool_update", payload: { id: String(update.toolCallId), title: (update.title ?? raw.title) as string | undefined, kind: update.kind as string | undefined, status: update.status as string | undefined } });
      } else if (["session", "history", "state", "text", "outbox", "prompt_result", "host_health", "permission_request", "permission_resolved"].includes(item.type)) {
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
            { name: "resonance", mode: "no-mistakes", yolo: false, description: "Desktop podcast tools" },
            { name: "foreman", mode: "direct-PR", yolo: true, description: "Agent supervision" },
          ];
        }
        // `?session-lost`: the host couldn't resume the previous session, so the startup opens a fresh one.
        if (item.type === "session" && reviewFlag("session-lost")) payload.previous_session_lost = true;
        // `?history`: the startup resumes the previous session instead of opening a new one.
        if (item.type === "session" && reviewFlag("history") && !reviewFlag("session-lost")) payload.mode = "loaded";
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
