import {
  Anchor,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
  BookOpen,
  CircleX,
  Crop,
  Clock3,
  ExternalLink,
  FileText,
  FolderGit2,
  FolderOpen,
  Gauge,
  GitBranch,
  GitMerge,
  Inbox,
  ListPlus,
  Menu,
  MessageSquarePlus,
  MessageSquareText,
  Monitor,
  Moon,
  PanelsTopLeft,
  Radio,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  ShieldQuestion,
  ShipWheel,
  Smartphone,
  Sparkles,
  Trash2,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { type Artifact, type ArtifactRef, type ArtifactRevision, type BacklogRecord, type Call, createHostAdapter, type ProjectHistory, type IntakeResult, type Landed, type FleetTask, type HostRuntimeState, type Needed, type ReasonKind, type ReviewAnchor, type ReviewSummary, type ReviewThread, type ReviewVerdict, type ReviewView } from "./host";
import { CheckCheck, RotateCcw, Shapes } from "lucide-react";
import { callProject, filterLog, type LogEntry, logCounts, logEntries, type LogFilter, logPeriods, outcomeLine, shortDay, upNext } from "./logbook";
import { answeredBy, answeredByCaptain, argumentOf, callsArguedBy, decidedForCaptain, type Evidence, homeCalls, isOpen, linkLabel, openCalls, optionsUpdatedSince, pageRef, recommended, resolveEvidence } from "./calls";
import type { ScenePlace, SceneProposal } from "./SceneEditor";

/** Excalidraw is a few megabytes, so nothing of it loads until a diagram is opened. */
const SceneEditor = lazy(() => import("./SceneEditor").then((module) => ({ default: module.SceneEditor })));
import { type ChatMessage, type HealthWarning, type OutboxView, type PermissionView, type RewakeStorm, type SnapshotHealth, useHost } from "./host/use-host";

type View = "bearings" | "chat" | "projects" | "project" | "artifacts" | "artifact";
/** Which page the review screen shows: the artifact, and the revision picked (the latest when none is). */
type OpenArtifact = ArtifactRef & { rev?: number };
type CallState = OutboxView | undefined;

const host = createHostAdapter();

function projectName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? "untitled-project";
}

function postureFor(task: FleetTask) {
  if (task.mode === "local-only") return "Stays on this machine · You land it";
  if (task.yolo === "on") return "Fully checked · Merges itself";
  return "Fully checked before a PR · You merge";
}

function postureForProject(mode: string, yolo: boolean) {
  if (mode === "local-only") return "Stays on this machine · You land it";
  if (yolo) return mode === "no-mistakes" ? "Fully checked · Merges itself" : "Opens a PR directly · Merges itself";
  return mode === "no-mistakes" ? "Fully checked before a PR · You merge" : "Opens a PR directly · You merge";
}

function stateLabel(state: string) {
  if (state === "unknown") return "Needs a fresh sighting";
  return state.replaceAll("_", " ");
}

type Tone = "blue" | "green" | "coral" | "amber" | "muted" | "sea";

/**
 * How a worker's state looks, from the states fm-fleet-snapshot.sh reports.
 * The warning icon is kept for a state that needs a look, so that it only ever means that.
 */
function taskStatus(state: string, size = 16): { tone: Tone; icon: React.ReactNode; summary: string } {
  if (state === "working") return { tone: "blue", icon: <CircleDot size={size} />, summary: "The worker is on it." };
  if (state === "done") return { tone: "green", icon: <CircleCheck size={size} />, summary: "The worker finished." };
  if (state === "failed") return { tone: "coral", icon: <CircleX size={size} />, summary: "The worker stopped on a failure." };
  if (state === "blocked") return { tone: "amber", icon: <CircleAlert size={size} />, summary: "The worker is blocked." };
  if (state === "parked" || state === "paused") return { tone: "amber", icon: <CirclePause size={size} />, summary: `The worker is ${state}.` };
  if (state === "unknown") return { tone: "muted", icon: <CircleQuestionMark size={size} />, summary: "The first mate could not confirm the worker's current state." };
  return { tone: "muted", icon: <CircleDot size={size} />, summary: "" };
}

function runtimeLabel(state: HostRuntimeState, pending: number, approvals: number) {
  if (approvals > 0 && ["idle", "prompt_turn", "agent_turn"].includes(state)) return "Waiting for your OK";
  if (state === "prompt_turn") return `Working on your ${pending > 1 ? `${pending} messages` : "message"}`;
  if (state === "agent_turn") return "Handling a fleet update";
  if (state === "restarting") return "Restarting…";
  if (state === "starting") return "Starting…";
  if (state === "locked_by_other") return "Running elsewhere";
  if (state === "dead" || state === "stopped" || state === "refused") return "Not running";
  return "Ready";
}

function stormQuestion(storm: RewakeStorm) {
  const minutes = Math.max(1, Math.round(storm.windowSecs / 60));
  return `You've been woken ${storm.turns} times in the last ${minutes} minutes. What keeps waking you, and can you settle it?`;
}

export function App() {
  const bridge = useHost(host);
  const { bearings, fleet, messages, outbox, runtime } = bridge;
  const [view, setView] = useState<View>("bearings");
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<FleetTask | null>(null);
  const [showEverything, setShowEverything] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The inline script in index.html has already decided and applied the theme.
  // Read it back rather than keeping a second default here, which could disagree with the markup.
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [ahoyVisible, setAhoyVisible] = useState(true);
  const [callMessageIds, setCallMessageIds] = useState<Record<string, string>>({});
  const [chatDraft, setChatDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openArtifact, setOpenArtifact] = useState<OpenArtifact | null>(null);
  const [artifactReturn, setArtifactReturn] = useState<View>("artifacts");
  const [review, setReview] = useState<ReviewView | null>(null);
  const [reviews, setReviews] = useState<ReviewSummary>({});

  const projects = useMemo(() => {
    const byName = new Map<string, { tasks: FleetTask[]; mode?: string; yolo?: boolean; description?: string }>();
    bridge.projects.forEach((project) => byName.set(project.name, { tasks: [], mode: project.mode, yolo: project.yolo, description: project.description }));
    fleet?.tasks.forEach((task) => {
      const name = projectName(task.project);
      const current = byName.get(name) ?? { tasks: [] };
      byName.set(name, { ...current, tasks: [...current.tasks, task] });
    });
    return [...byName.entries()].map(([name, project]) => ({
      name,
      tasks: project.tasks,
      posture: project.mode ? postureForProject(project.mode, project.yolo === true) : postureFor(project.tasks[0]),
      description: project.description ?? "",
    }));
  }, [bridge.projects, fleet]);

  const records = useMemo(() => new Map((fleet?.backlog?.records ?? []).map((record) => [record.id, record])), [fleet]);
  // Every call the home carries, from its one source: firstmate's calls[], or Bearings' bare list on an older home.
  const { calls } = useMemo(() => homeCalls(fleet, bearings, records), [fleet, bearings, records]);
  const waiting = useMemo(() => openCalls(calls), [calls]);

  // Which message answered which call. The link this session made is authoritative; after a relaunch
  // the app has none, so a message still in the host's outbox is matched by the call it names.
  const callAnswers = useMemo(() => {
    const found: Record<string, string> = {};
    for (const message of messages) {
      // Only an answer still on its way is matched. A read one is already the first mate's business, so a
      // launch that finds nothing waiting asks rather than showing an answer that has been dealt with.
      if (message.who !== "captain" || !outbox[message.id] || outbox[message.id].status === "picked_up") continue;
      const call = waiting.find((item) => answersCall(message.text, item));
      if (call) found[call.id] = message.id;
    }
    return { ...found, ...callMessageIds };
  }, [messages, outbox, waiting, callMessageIds]);

  // A match made here is kept for the rest of the session. Without this the card would drop the answer the
  // moment the first mate read it and ask its question again, in front of the captain who had just answered.
  useEffect(() => {
    setCallMessageIds((current) => {
      const matched = Object.entries(callAnswers).filter(([call, message]) => current[call] !== message);
      return matched.length ? { ...current, ...Object.fromEntries(matched) } : current;
    });
  }, [callAnswers]);

  const artifacts = useMemo(() => fleet?.artifacts ?? [], [fleet]);
  // Which pages have been looked at, and what is still waiting, for the list. Re-read whenever a review changes.
  const [answered, setAnswered] = useState<Record<string, AnswerNote>>({});
  useEffect(() => {
    void host.reviewSummary().then(setReviews).catch(() => setReviews({}));
  }, [artifacts, review, answered]);
  const now = useNow(60_000);
  /** What the captain calls a task: its backlog title. The id is for machines, and shows only beside it. */
  const taskTitle = (id: string) => records.get(id)?.title || bearings?.in_flight.find((item) => item.id === id)?.name || id;
  const evidenceOf = (call: Call) => resolveEvidence(call, artifacts, taskTitle);
  // A scout that finished with something to read, which the backlog has not closed yet, is the captain's to read.
  // A scout whose work already argues an open call is offered through that call's card, not a second one.
  const arguing = useMemo(() => new Set(openCalls(calls).flatMap((call) => [call.origin, ...call.evidence.map((ref) => ref.match(/^(?:report:|page:task\/)([^/]+)/)?.[1])]).filter((id): id is string => Boolean(id))), [calls]);
  const scoutsDone = useMemo(() => (fleet?.tasks ?? []).filter((task) => task.kind === "scout" && task.current_state.state === "done" && records.get(task.id)?.state !== "done"), [fleet, records]);
  const readyReports = useMemo(() => scoutsDone.flatMap((task) => {
    if (arguing.has(task.id)) return [];
    const page = latestTaskPage(artifacts, task.id);
    const report = task.paths.report.present ? task.paths.report.path : bearings?.reports?.find((item) => item.id === task.id)?.path ?? null;
    return page || report ? [{ task, page, report }] : [];
  }), [scoutsDone, arguing, artifacts, bearings]);
  const readyIds = new Set([...readyReports.map((item) => item.task.id), ...scoutsDone.filter((task) => arguing.has(task.id)).map((task) => task.id)]);
  const underway = (bearings?.in_flight ?? []).filter((item) => !readyIds.has(item.id));
  const landedRows = landedItems(bearings?.landed ?? [], records, artifacts, answeredByCaptain(calls, now), evidenceOf);
  const [dismissedDecided, setDismissedDecided] = useState<string[]>(readDismissed);
  const decidedCalls = decidedForCaptain(calls);
  const decided = decidedCalls.filter((item) => !dismissedDecided.includes(item.id));
  // The project page reads its closed work from firstmate, and again whenever the home changes.
  const history = useProjectHistory(view === "project" ? selectedProject : null, fleet?.generated);
  const [logEntry, setLogEntry] = useState<LogEntry | null>(null);
  useEffect(() => setLogEntry(null), [view, selectedProject]);
  const waitingIn = (name: string) => waiting.filter((call) => callProject(call, records) === name);
  // What a project has underway, the same wherever it is counted: a finished scout waiting to be read is not.
  const underwayIn = (project: ProjectSummary) => project.tasks.filter((task) => !readyIds.has(task.id) && records.get(task.id)?.state !== "done");
  // A call opened from a project page is shown on its card on Bearings, where it is answered.
  const [focusedCall, setFocusedCall] = useState<string | null>(null);
  useEffect(() => {
    if (!focusedCall || view !== "bearings") return;
    const card = document.querySelector<HTMLElement>(`.decision-card[data-call-id="${CSS.escape(focusedCall)}"]`);
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
    card?.classList.add("focused");
    const timer = window.setTimeout(() => { card?.classList.remove("focused"); setFocusedCall(null); }, 1800);
    return () => window.clearTimeout(timer);
  }, [focusedCall, view]);
  const artifactRef = useMemo<ArtifactRef | null>(() => openArtifact ? { scope: openArtifact.scope, task: openArtifact.task, name: openArtifact.name } : null, [openArtifact]);

  // The review is read from the home when a page opens, so a draft written before a relaunch is still there.
  useEffect(() => {
    if (!artifactRef) return setReview(null);
    let active = true;
    setReview(null);
    void host.reviewGet(artifactRef).then((next) => { if (active) setReview(next); }).catch(() => { if (active) setReview(null); });
    return () => { active = false; };
  }, [artifactRef?.scope, artifactRef?.task, artifactRef?.name]);
  const shownArtifact = openArtifact ? artifacts.find((artifact) => sameArtifact(artifact, openArtifact)) : undefined;
  // A pinned revision that is no longer in the home (rewritten history) falls back to the latest.
  const shownRevision = shownArtifact && (shownArtifact.revisions.find((revision) => revision.rev === openArtifact?.rev) ?? shownArtifact.latest);

  const selectedProjectData = projects.find((project) => project.name === selectedProject);
  const title = view === "bearings" ? "Bearings"
    : view === "chat" ? "Chat"
    : view === "projects" ? "Projects"
    : view === "artifacts" ? "Artifacts"
    : view === "artifact" ? shownRevision?.title ?? "Artifact"
    : selectedProject ?? "Project";
  const subtitle = view === "project" && selectedProjectData ? selectedProjectData.posture
    : view === "chat" ? "The first mate"
    : view === "bearings" ? (bearings ? `As of ${formatTime(bearings.generated)}` : "")
    : view === "artifacts" ? `${artifacts.length} page${artifacts.length === 1 ? "" : "s"} shared with you`
    : view === "artifact" ? (shownArtifact && shownRevision ? `${artifactOwner(shownArtifact, fleet?.tasks ?? [])} · Rev ${shownRevision.rev} of ${shownArtifact.revisions.length}` : "")
    : `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  // Everything waiting on the captain: open calls, and finished reports nobody has closed.
  const openCallCount = waiting.length + readyReports.length;
  const approvalCount = bridge.permissionRequests.length;
  // Failed and not-sent messages aren't being worked on.
  const pendingCount = Object.values(outbox).filter((item) => item.status !== "picked_up" && !item.error).length;
  const runningHere = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"].includes(runtime.state);
  // A usage limit or a rewake storm is degraded, and says so wherever the first mate's state is shown.
  const degraded = runningHere && Boolean(bridge.rewakeStorm || bridge.healthWarning);
  const hostLabel = bridge.rewakeStorm
    ? `Woken ${bridge.rewakeStorm.turns} times in ${Math.round(bridge.rewakeStorm.windowSecs / 60)} min`
    : runningHere && bridge.healthWarning?.kind === "session_limit"
      ? "At its usage limit"
      : runtimeLabel(runtime.state, pendingCount, approvalCount);
  const notRunning = runtime.state === "dead" || runtime.state === "stopped";
  const problemDetails = [...new Set([runtime.reason, bridge.startError].filter((text): text is string => Boolean(text)))].join("\n\n");
  // A Start can also fail after the host said it was starting, and stay there.
  const hasProblem = runtime.state === "refused" || (notRunning && Boolean(runtime.reasonKind || problemDetails)) || (runtime.state === "starting" && Boolean(bridge.startError));

  function navigate(next: View) {
    setView(next);
    setMobileNavOpen(false);
  }

  function showArtifact(artifact: Artifact, rev?: number) {
    // Back returns to wherever the page was opened from; opening another revision keeps that place.
    if (view !== "artifact") setArtifactReturn(view);
    // Pin the revision being read. A revision presented while the captain is reading is announced,
    // never swapped in underneath them, which would lose their place and what they were comparing.
    setOpenArtifact({ scope: artifact.scope, task: artifact.task, name: artifact.name, rev: rev ?? artifact.latest.rev });
    setActiveTask(null);
    setShowEverything(false);
    setView("artifact");
    setMobileNavOpen(false);
  }

  function openProject(name: string) {
    setSelectedProject(name);
    setView("project");
    setMobileNavOpen(false);
  }

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    // Remember it: without this the window goes back to the system setting on the next launch,
    // and a captain who prefers the other theme has to change it every time.
    try {
      localStorage.setItem("quarterdeck.theme", next ? "dark" : "light");
    } catch (error) {
      // Storage refused. The theme still applies for this session, it just will not be remembered.
    }
  }

  /** Puts words in the composer and opens Chat, for the captain to finish and send. Nothing goes without them. */
  function draftInChat(text: string) {
    setChatDraft(text);
    navigate("chat");
  }

  /** Opens what argues a call: a page here, a report through the first mate, anything else outside the app. */
  function openEvidence(item: Evidence) {
    if (item.kind === "page") showArtifact(item.artifact);
    else if (item.kind === "report") draftInChat(askAboutReport(taskTitle(item.task)));
    else window.open(item.url, "_blank", "noreferrer");
  }

  function dismissDecided(id: string) {
    // Only ids still in the snapshot are worth remembering, so the list cannot grow without end.
    const known = new Set(decidedCalls.map((item) => item.id));
    const next = [...dismissedDecided.filter((item) => known.has(item)), id];
    setDismissedDecided(next);
    writeDismissed(next);
  }

  function openTask(id: string) {
    const task = fleet?.tasks.find((candidate) => candidate.id === id);
    if (task) setActiveTask(task);
  }

  async function sendChat() {
    const message = chatDraft.trim();
    // Keep the draft: it can go once the first mate has started in this folder.
    if (!message || !bridge.sendReady) return;
    setChatDraft("");
    await bridge.send(message);
  }

  function runAhoy() {
    setAhoyVisible(false);
    navigate("chat");
    void bridge.send("/ahoy");
  }

  async function answerCall(id: string, text: string) {
    const previous = callAnswers[id];
    const messageId = previous ? await bridge.resend(previous, text) : await bridge.send(text);
    setCallMessageIds((current) => ({ ...current, [id]: messageId }));
  }

  /**
   * Answers a call from Bearings with one of its options: firstmate's intake records it, noted in the review of
   * the page that argues it, and the card says what the intake did. Only a recorded answer reaches the first mate.
   */
  async function answerNow(call: Call, option: { key: string; label: string }, note?: string) {
    const argument = argumentOf(evidenceOf(call));
    const argued = argument?.kind === "page" ? argument.artifact : null;
    const page = argued ? { scope: argued.scope, task: argued.task, name: argued.name } : null;
    const unread = argued ? (reviews[artifactKey(argued)]?.seen_rev ?? null) === null : false;
    let outcome: AnswerNote;
    try {
      const result = await host.callAnswer({ call: call.id, option: option.key, label: option.label, onAnswer: call.on_answer ?? "", page, note });
      if (result.message && result.text) bridge.noteSent(result.message, result.text);
      outcome = { label: option.label, result: result.outcome.result, detail: result.outcome.detail, told: Boolean(result.message), warning: result.warning, unread };
    } catch (error) {
      outcome = { label: option.label, result: "not_recorded", detail: String(error), told: false, unread };
    }
    setAnswered((current) => ({ ...current, [call.id]: outcome }));
  }

  async function chooseHomeAndStart() {
    if (await bridge.chooseHome()) void bridge.start();
  }

  /** The same host banners on Bearings and in Chat; only what asking about a rewake storm does differs. */
  function hostBanners(onAskStorm: (question: string) => void) {
    return <>
      {hasProblem
        ? <ProblemBanner kind={runtime.reasonKind} details={problemDetails} homeProblem={bridge.homeProblem} onStart={() => void bridge.start()} onChoose={() => void chooseHomeAndStart()} />
        : notRunning && <OfflineBanner onStart={() => void bridge.start()} />}
      {runtime.state === "locked_by_other" && <LockedBanner holder={runtime.holder} onCheck={() => void bridge.start()} />}
      {bridge.rewakeStorm && <StormBanner storm={bridge.rewakeStorm} onAsk={() => onAskStorm(stormQuestion(bridge.rewakeStorm!))} onRestart={() => void bridge.restart()} />}
      {bridge.healthWarning && <HostHealthBanner warning={bridge.healthWarning} onRestart={() => void bridge.restart()} />}
    </>;
  }

  function stopHost() {
    if (window.confirm("Stop the first mate? Nothing gets checked, merged or answered until you start it again. Work already underway keeps going.")) {
      void bridge.stop();
    }
  }

  if (!bridge.homeChecked) return <div className="app-loading">Opening firstmate…</div>;
  if (!bridge.home) return <HomeSetup problem={bridge.homeProblem} choosing={bridge.choosingHome} onChoose={() => void bridge.chooseHome()} onUseApp={() => void bridge.useAppHome()} />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`}>
        <div className="window-drag" aria-hidden="true"><span /><span /><span /></div>
        <div className="brand-row">
          <div className="brand-mark"><Anchor size={19} /></div>
          <div><strong>firstmate</strong><span>desktop</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileNavOpen(false)} title="Close navigation"><X size={18} /></button>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavButton active={view === "bearings"} icon={<Gauge size={18} />} label="Bearings" count={openCallCount || undefined} onClick={() => navigate("bearings")} />
          <NavButton active={view === "chat"} icon={<MessageSquareText size={18} />} label="Chat" detail="First Mate" count={approvalCount || undefined} countTitle={approvalCount ? `The first mate is waiting for your OK on ${approvalCount === 1 ? "one thing" : `${approvalCount} things`}` : undefined} onClick={() => navigate("chat")} />
          <NavButton active={view === "projects" || view === "project"} icon={<FolderGit2 size={18} />} label="Projects" count={projects.length} onClick={() => navigate("projects")} />
          <NavButton active={view === "artifacts" || view === "artifact"} icon={<PanelsTopLeft size={18} />} label="Artifacts" onClick={() => navigate("artifacts")} />
        </nav>
        <div className="sidebar-rule" />
        <div className="project-shortcuts">
          {projects.map((project) => (
            <button key={project.name} className={view === "project" && selectedProject === project.name ? "selected" : ""} onClick={() => openProject(project.name)}>
              <span className="project-sigil">{project.name.slice(0, 2).toUpperCase()}</span>
              <span><strong>{project.name}</strong><small>{waitingIn(project.name).length > 0 && `${waitingIn(project.name).length} waiting · `}{underwayIn(project).length} underway</small></span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="connection"><span className={`live-dot state-${runtime.state} ${degraded ? "degraded" : ""}`} /><span><strong>First Mate</strong><small>{hostLabel}</small></span></div>
          <button className="runtime-button" disabled={runtime.state === "restarting"} onClick={runningHere ? stopHost : () => void bridge.start()}>{runtime.state === "locked_by_other" ? "Check again" : runningHere ? "Stop" : "Start"}</button>
          <button className="icon-button" title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={17} /></button>
        </div>
      </aside>

      <main className="main-surface">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} title="Open navigation"><Menu size={19} /></button>
          {view === "project" && <button className="icon-button back-button" onClick={() => navigate("projects")} title="Back to projects"><ArrowLeft size={18} /></button>}
          {view === "artifact" && <button className="icon-button back-button" onClick={() => navigate(artifactReturn)} title="Back"><ArrowLeft size={18} /></button>}
          <div className="page-heading"><h1>{title}</h1><span>{subtitle}</span></div>
          <div className="top-actions">
            {view === "bearings" && <button className="ahoy-button" onClick={runAhoy} title="Catch up on what happened since your last message"><Sparkles size={15} /> Ahoy</button>}
            <button className="icon-button" title="Search"><Search size={18} /></button>
            <button className="icon-button" onClick={toggleTheme} title={dark ? "Use light theme" : "Use dark theme"}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
          </div>
        </header>

        {view === "bearings" && (
          <div className={`content-scroll bearings-page ${bridge.refreshing ? "snapshot-refreshing" : ""}`} data-screen="bearings" aria-busy={bridge.refreshing}>
            {hostBanners((question) => { navigate("chat"); void bridge.send(question); })}
            {bridge.snapshotHealth.errors.length > 0 && <SnapshotBanner health={bridge.snapshotHealth} refreshing={bridge.refreshing} onRetry={() => void bridge.refreshSnapshot()} />}
            <NeedsBanner needs={bridge.needs} problem={bridge.needsProblem} checking={bridge.checkingTools} onCheck={() => void bridge.checkTools()} />
            {approvalCount > 0 && view === "bearings" && <ApprovalBanner count={approvalCount} onOpen={() => navigate("chat")} />}
            {!bearings && bridge.snapshotHealth.errors.length === 0 && <EmptyState label="Taking fresh bearings of this home…" />}
            {bearings && <>
            {ahoyVisible && (
              <section className="ahoy-card">
                <div className="ahoy-mark"><ShipWheel size={22} /></div>
                <div><span>Ahoy</span><h2>Welcome back.</h2><p>The first mate can catch you up and take you through what's waiting.</p><strong>{openCallCount} waiting on you · {underway.length} underway</strong></div>
                <div className="ahoy-actions"><button onClick={runAhoy}>Ahoy</button><button onClick={() => setAhoyVisible(false)}>Not now</button></div>
              </section>
            )}
            <DashboardSection title="Captain's Call" icon={<Inbox size={17} />} tone="coral" count={openCallCount}>
              {waiting.map((call) => {
                const evidence = evidenceOf(call);
                const argument = argumentOf(evidence);
                const pages = evidence.flatMap((item) => item.kind === "page" ? [item.artifact] : []);
                // A review that already recorded an answer for it; the call leaves once the snapshot catches up.
                const answeredIn = pages.find((artifact) => (reviews[artifactKey(artifact)]?.answered ?? []).includes(call.id));
                const seen = argument?.kind === "page" ? (reviews[artifactKey(argument.artifact)]?.seen_rev ?? null) !== null : null;
                return <DecisionCard
                  key={call.id}
                  call={call}
                  argument={argument}
                  seenArgument={seen}
                  answered={answered[call.id]}
                  answeredIn={answeredIn?.title}
                  state={outbox[callAnswers[call.id]]}
                  answerText={messages.find((message) => message.id === callAnswers[call.id])?.text}
                  runtime={runtime.state}
                  onSend={(text) => answerCall(call.id, text)}
                  onAnswer={(option, note) => answerNow(call, option, note)}
                  onStart={() => void bridge.start()}
                  onReadArgument={argument ? () => openEvidence(argument) : undefined}
                  onOpenPage={answeredIn ? () => showArtifact(answeredIn) : argument?.kind === "page" ? () => showArtifact(argument.artifact) : undefined}
                />;
              })}
              {readyReports.map(({ task, page, report }) => (
                <ReportCard key={task.id} title={taskTitle(task.id)} project={projectName(task.project)} id={task.id} finished={finishedLine(task)} page={page} report={report} onOpen={page ? () => showArtifact(page) : undefined} onAsk={() => draftInChat(askAboutReport(taskTitle(task.id)))} onDetails={() => setActiveTask(task)} />
              ))}
              {openCallCount === 0 && <EmptyState label="Nothing needs your action right now." />}
            </DashboardSection>

            {decided.length > 0 && <DashboardSection title="Decided for you" icon={<ShipWheel size={17} />} tone="sea" count={decided.length}>
              <div className="decided-list" data-testid="decided">
                {decided.map((call) => {
                  const item = decidedItem(call);
                  return <DecidedRow key={item.id} item={item} taskTitle={item.task ? taskTitle(item.task) : null} onTask={item.task && fleet?.tasks.some((task) => task.id === item.task) ? () => openTask(item.task!) : undefined} onPushBack={() => draftInChat(`About "${item.what}": `)} onDismiss={() => dismissDecided(item.id)} />;
                })}
              </div>
            </DashboardSection>}

            <DashboardSection title="Recently Landed" icon={<Check size={17} />} tone="green" count={landedRows.length}>
              {landedRows.map((row) => <LandedRow key={row.id} row={row} onOpenPage={row.page ? () => showArtifact(row.page!) : undefined} onAsk={row.report && !row.page ? () => draftInChat(askAboutReport(row.title)) : undefined} onBasis={row.basis ? () => openEvidence(row.basis!) : undefined} />)}
              {landedRows.length === 0 && <EmptyState label="Nothing has landed recently." />}
            </DashboardSection>

            <DashboardSection title="Underway" icon={<Radio size={17} />} tone="blue" count={underway.length}>
              <div className="task-list">
                {underway.map((item) => {
                  const task = fleet?.tasks.find((candidate) => candidate.id === item.id);
                  const status = taskStatus(item.state);
                  const started = startedAt(task, records.get(item.id));
                  return <button className="task-row" key={item.id} onClick={() => task && setActiveTask(task)}><span className={`task-state tone-${status.tone}`}>{status.icon}</span><span className="task-copy"><strong>{item.name}</strong><small>{projectName(item.repo ?? "")} · {item.kind}{started && <> · <span data-testid="underway-for" title={`Started ${formatStart(started)}`}>{sinceLabel(started, now)}</span></>}</small></span><span className={`task-chip tone-${status.tone}`}>{stateLabel(item.state)}</span><ChevronRight size={17} /></button>;
                })}
              </div>
              {underway.length === 0 && <EmptyState label="Nothing is underway." />}
            </DashboardSection>

            <DashboardSection title="Charted Next" icon={<Clock3 size={17} />} tone="amber" count={bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length}>
              {bearings.gates.map((item) => <CompactRow key={item.id} title={item.title} detail={item.reason} icon={<Clock3 size={15} />} tone="amber" badge="waiting" />)}
              {(bearings.unhealthy_endpoints ?? []).map((item) => <CompactRow key={`health-${item.id}`} title={`The first mate's records for ${projectName(fleet?.tasks.find((task) => task.id === item.id)?.project ?? item.id)} don't match.`} detail="Nothing to do on your side." icon={<CircleAlert size={15} />} tone="amber" badge="needs repair" />)}
              {bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length === 0 && <EmptyState label="Nothing is queued." />}
            </DashboardSection>
            </>}
          </div>
        )}

        {view === "chat" && <ChatView messages={messages} artifacts={artifacts} tasks={fleet?.tasks ?? []} onOpenArtifact={showArtifact} outbox={outbox} draft={chatDraft} runtime={runtime.state} hostLabel={hostLabel} degraded={degraded} home={bridge.home} sendReady={bridge.sendReady} banners={hostBanners(setChatDraft)} approvals={bridge.permissionRequests} onAnswer={(id, optionId) => void bridge.answerPermission(id, optionId)} onDraft={setChatDraft} onSend={() => void sendChat()} onResend={(id, text) => void bridge.resend(id, text)} onRestart={() => void bridge.restart()} />}
        {view === "projects" && <ProjectsView projects={projects} waitingIn={(name) => waitingIn(name).length} underwayIn={(project) => underwayIn(project).length} onOpen={openProject} />}
        {view === "project" && selectedProjectData && <ProjectView
          project={selectedProjectData}
          now={now}
          taskTitle={taskTitle}
          records={records}
          waiting={waitingIn(selectedProjectData.name)}
          reports={readyReports.filter(({ task }) => projectName(task.project) === selectedProjectData.name)}
          underway={underwayIn(selectedProjectData)}
          queued={upNext(fleet?.backlog?.records ?? [], selectedProjectData.name)}
          recent={fleet?.backlog?.records ?? []}
          calls={calls}
          history={history}
          onOpenTask={setActiveTask}
          onOpenCall={(id) => { navigate("bearings"); setFocusedCall(id); }}
          onOpenReport={(item) => item.page ? showArtifact(item.page) : draftInChat(askAboutReport(taskTitle(item.task.id)))}
          onOpenEntry={setLogEntry}
        />}
        {view === "artifacts" && <ArtifactsView artifacts={artifacts} tasks={fleet?.tasks ?? []} reviews={reviews} backlog={records} calls={calls} onOpen={showArtifact} />}
        {view === "artifact" && (shownArtifact && shownRevision
          ? <ArtifactReview
              key={`${shownArtifact.scope}/${shownArtifact.task}/${shownArtifact.name}/${shownRevision.rev}`}
              artifact={shownArtifact}
              revision={shownRevision}
              url={host.artifactUrl(shownRevision)}
              review={review}
              stake={reviewStake(shownArtifact, fleet?.tasks ?? [], records, calls, (review?.answers ?? []).filter((answer) => answer.sent_at === null && answer.option).map((answer) => answer.decision))}
              sendReady={bridge.sendReady}
              runtime={runtime.state}
              onRevision={(rev) => showArtifact(shownArtifact, rev)}
              onComment={(body, anchor, thread) => host.reviewComment(artifactRef!, shownRevision.rev, body, anchor, thread).then(setReview)}
              onDiscard={(thread) => host.reviewDiscard(artifactRef!, thread).then(setReview)}
              onSubmit={(verdict) => host.reviewSubmit(artifactRef!, shownRevision.rev, verdict).then((sent) => {
                if (sent.message) bridge.noteSent(sent.message, sent.text);
                setReview(sent.review);
                return sent.warning;
              })}
              calls={callsArguedBy(calls, shownArtifact)}
              onAnswer={(call, option, label) => host.reviewAnswer(artifactRef!, call.id, option, label, call.on_answer).then(setReview)}
              onScene={(place, proposal) => host.reviewScene(artifactRef!, shownRevision.rev, place.file, place.label, place.path, proposal.summary, proposal.scene, proposal.png).then(setReview)}
              onSettle={(thread, resolved) => host.reviewSettle(artifactRef!, thread, resolved).then(setReview)}
              onSeen={(rev) => host.reviewSeen(artifactRef!, rev).then(setReview)}
            />
          : <div className="content-scroll"><EmptyState label="This page isn't in the home's records anymore." /></div>)}
      </main>

      {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
      {settingsOpen && <SettingsDialog home={bridge.home} problem={bridge.homeProblem} running={runningHere} choosing={bridge.choosingHome} chosen={bridge.homeChosen} onChoose={() => void bridge.chooseHome()} onUseApp={() => void bridge.useAppHome()} onClose={() => setSettingsOpen(false)} />}
      {logEntry && <LogbookDrawer entry={logEntry} project={selectedProject ?? ""} now={now} artifacts={artifacts.filter((artifact) => artifact.scope === "task" && artifact.task === logEntry.id)} reviews={reviews} source={history.schema} onOpenArtifact={showArtifact} onAskReport={() => { setLogEntry(null); draftInChat(askAboutReport(logEntry.title)); }} onClose={() => setLogEntry(null)} />}
      {activeTask && fleet && <TaskDrawer task={activeTask} title={taskTitle(activeTask.id)} record={records.get(activeTask.id)} now={now} reviews={reviews} onAskReport={() => { setActiveTask(null); draftInChat(askAboutReport(taskTitle(activeTask.id))); }} artifacts={artifacts.filter((artifact) => artifact.scope === "task" && artifact.task === activeTask.id)} onOpenArtifact={showArtifact} fleetSchema={fleet.schema} fleetGenerated={fleet.generated} expanded={showEverything} onCapture={bridge.paneCapture} onToggle={() => setShowEverything((current) => !current)} onClose={() => { setActiveTask(null); setShowEverything(false); }} />}
    </div>
  );
}

function NavButton({ active, icon, label, detail, count, countTitle, onClick }: { active: boolean; icon: React.ReactNode; label: string; detail?: string; count?: number; countTitle?: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>{count !== undefined && <em title={countTitle}>{count}</em>}</button>;
}

function HomeSetup({ problem, choosing, onChoose, onUseApp }: { problem: string | null; choosing: boolean; onChoose: () => void; onUseApp: () => void }) {
  return <div className="home-setup"><section><div className="brand-mark"><Anchor size={21} /></div><h1>Where does firstmate live on this Mac?</h1><p>The app ships its own first mate and keeps it in the app's folder. It could not set that up this time, so you can point it at a firstmate folder of your own: the one with <code>AGENTS.md</code> and <code>bin</code> inside.</p>{problem && <HomeProblem problem={problem} />}<div className="home-actions"><button className="home-choose" disabled={choosing} onClick={onChoose}><FolderOpen size={16} /> {choosing ? "Choosing…" : "Choose folder…"}</button><button className="home-revert" disabled={choosing} onClick={onUseApp}>Try the app's own again</button></div></section></div>;
}

/// What the first mate says this machine still needs, in its own order.
///
/// The live region is always here, empty when there is nothing to say: a region
/// that appears already full is not announced, because there was no change
/// inside it to announce.
function NeedsBanner({ needs, problem, checking, onCheck }: { needs: Needed[]; problem: string | null; checking: boolean; onCheck: () => void }) {
  // Only a named tool is a thing the captain can go and get. The rest is what
  // the first mate had to say, and counting it as a thing to install would be
  // telling them a branch name is something to install.
  const tools = needs.filter((needed) => needed.kind !== "other");
  const said = needs.filter((needed) => needed.kind === "other");
  const headline = problem ? "The first mate could not check this Mac"
    : tools.length === 0 ? "The first mate has something to say about this Mac"
    : tools.length === 1 ? "The first mate needs one more thing on this Mac"
    : `The first mate needs ${tools.length} more things on this Mac`;
  const row = (needed: Needed) => <li key={needed.says}>
    {needed.tool ? <><code className="needs-tool">{needed.tool}</code>{needed.kind === "manual"
      ? <span>install it yourself: {needed.how ? <a href={needed.how} target="_blank" rel="noreferrer noopener">{needed.how}</a> : "no instructions were offered"}</span>
      : needed.how ? <code className="needs-how">{needed.how}</code> : <span>no install command was offered</span>}</>
      : <span className="needs-says">{needed.says}</span>}
  </li>;
  return <div className="needs-region" role="status" aria-live="polite" aria-label="What this Mac still needs">
    {(needs.length > 0 || problem) && <section className="needs-banner">
      <header>
        <CircleAlert size={16} />
        <div>
          <strong>{headline}</strong>
          <small>{problem ? "Until it can, what is missing here is unknown." : tools.length === 0 ? "Nothing here is a thing to install." : "It runs without them, but the work that uses them will stop."}</small>
        </div>
        <button className="icon-button" onClick={onCheck} disabled={checking} title="Check this Mac again">
          <RefreshCw size={16} />
        </button>
      </header>
      {problem ? <p className="needs-problem">{problem}</p> : <>
        {tools.length > 0 && <ul>{tools.map(row)}</ul>}
        {said.length > 0 && <>
          <p className="needs-aside">{tools.length > 0 ? "And some things it could not put a name to:" : "It could not put a name to these:"}</p>
          <ul>{said.map(row)}</ul>
        </>}
      </>}
    </section>}
  </div>;
}

function HomeProblem({ problem }: { problem: string }) {
  return <div className="home-problem" role="alert"><CircleAlert size={16} /><span>{problem}</span></div>;
}

function SettingsDialog({ home, problem, running, choosing, chosen, onChoose, onUseApp, onClose }: { home: string; problem: string | null; running: boolean; choosing: boolean; chosen: boolean; onChoose: () => void; onUseApp: () => void; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <div className="drawer-backdrop" onMouseDown={onClose}><section className="settings-dialog" role="dialog" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><div><span>Settings</span><h2>firstmate folder</h2></div><button className="icon-button" onClick={onClose} title="Close settings"><X size={18} /></button></header><div className="settings-body"><p>{chosen ? "The first mate runs in the folder you chose, and Bearings is read from there." : "The app keeps its own first mate here, and Bearings is read from here."}</p><code className="settings-path" title={home}>{home}</code>{problem && <HomeProblem problem={problem} />}<button className="home-choose" disabled={running || choosing} onClick={onChoose}><FolderOpen size={16} /> {choosing ? "Choosing…" : "Choose a different folder…"}</button>{chosen && <button className="home-revert" disabled={running || choosing} onClick={onUseApp}>Use the app's own first mate again</button>}{running && <small>Stop the first mate before changing which folder it runs in.</small>}</div></section></div>;
}

const SNAPSHOT_SOURCES: Record<string, { label: string; part: "bearingsAt" | "fleetAt" }> = {
  "fm-bearings-snapshot.sh": { label: "Bearings", part: "bearingsAt" },
  "fm-fleet-snapshot.sh": { label: "the fleet", part: "fleetAt" },
};

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function SnapshotBanner({ health, refreshing, onRetry }: { health: SnapshotHealth; refreshing: boolean; onRetry: () => void }) {
  const now = useNow(30_000);
  const failed = health.errors.map((error) => SNAPSHOT_SOURCES[error.source]);
  const what = [...new Set(failed.map((source) => source?.label ?? "this home"))].join(" and ");
  const shownAt = failed.map((source) => source && health[source.part]).filter((at): at is number => typeof at === "number");
  const age = shownAt.length === failed.length && shownAt.length > 0
    ? `What's on screen was read at ${formatTime(new Date(Math.min(...shownAt)).toISOString())}, ${timeAgo(now - Math.min(...shownAt))}.`
    : `Nothing from ${what} to show until a read works.`;
  const details = health.errors.map((error) => `${error.source}: ${error.error}`).join("\n\n");
  return <section className="offline-banner snapshot-banner" role="alert"><CircleAlert size={18} /><div><strong>Couldn't refresh {what}.</strong><span>{age}</span><small className="snapshot-error" title={details}>{details}</small></div><div className="banner-actions"><button onClick={() => window.alert(details)}>Show details</button><button disabled={refreshing} onClick={onRetry}>{refreshing ? "Trying…" : "Try again"}</button></div></section>;
}

function ApprovalBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  return <section className="offline-banner approval-banner"><ShieldQuestion size={18} /><div><strong>The first mate is waiting for your OK on {count === 1 ? "one thing" : `${count} things`}.</strong><span>It won't go on with that until you answer.</span></div><button onClick={onOpen}>Open chat</button></section>;
}

function timeAgo(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function DashboardSection({ title, icon, tone, count, children }: { title: string; icon: React.ReactNode; tone: string; count: number; children: React.ReactNode }) {
  return <section className="dashboard-section"><div className="section-heading"><span className={`section-icon ${tone}`}>{icon}</span><h2>{title}</h2><span className="section-count">{count}</span></div>{children}</section>;
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty-state"><CircleDot size={16} /><strong>{label}</strong></div>;
}

function CompactRow({ title, detail, icon, tone = "green", badge }: { title: string; detail: string; icon: React.ReactNode; tone?: Tone; badge?: string }) {
  // firstmate's snapshots write "-" for an empty field; show nothing rather than a dash.
  const shown = detail.trim() === "-" ? "" : detail.trim();
  return <div className="compact-row"><span className={`tone-${tone}`}>{icon}</span><div><strong>{title}</strong>{shown && <small>{shown}</small>}</div>{badge && <em>{badge}</em>}</div>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A backlog date (`yyyy-mm-dd`) as a moment: midday there, so no time zone moves it to another day. */
function dayMs(date: string) {
  return Date.parse(`${date}T12:00:00`);
}

/** A backlog date the way the captain reads one. */
function formatDay(date: string) {
  const at = new Date(dayMs(date));
  if (Number.isNaN(at.getTime())) return date;
  if (at.toDateString() === new Date().toDateString()) return "today";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(at);
}

/** How long something has been going, to the precision a glance needs. */
function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

/** When a worker started. `exact` when its spawn says so; otherwise only the day its backlog row was filed. */
type Started = { ms: number; exact: boolean; day?: string };

/**
 * fm-spawn.sh stamps every spawn and relaunch `spawn_gen=s<epoch seconds>.<pid>.<random>`, so a worker's start is
 * the only time the snapshot carries for it. A row with no worker yet falls back to the day it was filed.
 */
function startedAt(task?: FleetTask, record?: BacklogRecord): Started | null {
  const epoch = task?.spawn_gen?.match(/^s(\d{9,})\./)?.[1];
  if (epoch) return { ms: Number(epoch) * 1000, exact: true };
  const since = record?.since ?? null;
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) return { ms: dayMs(since), exact: false, day: since };
  return null;
}

function sinceLabel(started: Started, now: number) {
  return started.exact ? `started ${formatDuration(now - started.ms)} ago` : `since ${formatDay(started.day!)}`;
}

function formatStart(started: Started) {
  return started.exact ? formatWhen(new Date(started.ms).toISOString()) : formatDay(started.day!);
}

/**
 * What a worker's state detail means, in the captain's words. fm-crew-state.sh writes these for its own
 * reasons; anything it did not write this way is the worker's own note and reads as it is.
 */
function plainDetail(detail: string) {
  const text = detail.trim();
  if (/^harness busy\b/.test(text)) return "Busy in its terminal.";
  if (/^harness state unavailable\b/.test(text)) return "Its terminal didn't say whether it is busy.";
  if (/^backend target gone\b/.test(text)) return "Its terminal has closed.";
  if (/^backend unreachable\b/.test(text)) return "Its terminal didn't answer.";
  if (text === "no backend target recorded") return "No terminal is recorded for it.";
  if (text === "no current-state source available") return "Nothing has reported its state yet.";
  return text;
}

/** The last thing a finished worker said, which for a scout is usually what it found. */
function finishedLine(task: FleetTask) {
  const detail = plainDetail(task.current_state.detail ?? "");
  return detail && detail !== "Busy in its terminal." ? detail : task.paths.status_log.last_event.note;
}

/** A task's newest page, when it has presented one. */
function latestTaskPage(artifacts: Artifact[], task: string) {
  return artifacts
    .filter((artifact) => artifact.scope === "task" && artifact.task === task)
    .sort((a, b) => b.latest.presented_at.localeCompare(a.latest.presented_at))[0];
}

/** What the captain types to have a report without a page read to them. */
function askAboutReport(title: string) {
  return `Walk me through the report on "${title}".`;
}

function ExternalAnchor({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return <a className={className} href={href} title={href} target="_blank" rel="noreferrer noopener" onClick={(event) => { event.preventDefault(); window.open(href, "_blank", "noreferrer"); }}>{children}</a>;
}

/** A finished scout's report, offered where the captain looks first. */
function ReportCard({ title, project, id, finished, page, report, onOpen, onAsk, onDetails }: { title: string; project: string; id: string; finished: string; page?: Artifact; report: string | null; onOpen?: () => void; onAsk: () => void; onDetails: () => void }) {
  return <article className="decision-card report-card" data-testid="report-ready" data-task-id={id}>
    <div className="decision-meta"><span>Report ready</span><small>{project}</small></div>
    <h3>{title}</h3>
    {finished && <p>{finished}</p>}
    <div className="decision-actions">
      <span title={report ?? undefined}>{page ? `The scout presented it ${formatWhen(page.latest.presented_at)}` : "The scout wrote it up without a page"}</span>
      <div className="report-actions">
        <button className="quiet" onClick={onDetails}>Task details</button>
        {onOpen ? <button onClick={onOpen}><PanelsTopLeft size={15} /> Read the report</button> : <button onClick={onAsk}><MessageSquareText size={15} /> Ask the first mate for it</button>}
      </div>
    </div>
  </article>;
}

const DECIDED_ICONS: Record<string, React.ReactNode> = {
  "review-finding": <MessageSquareText size={15} />,
  merge: <GitMerge size={15} />,
  "new-task": <ListPlus size={15} />,
  scope: <Crop size={15} />,
};

/** A call the first mate settled for the captain, as the lane shows it. */
type DecidedItem = { id: string; at: string; kind: string | null; task: string | null; what: string; why: string; link: string | null };

/** What and why come from the reasons `decide` recorded; the answer itself stands in for a call without them. */
function decidedItem(call: Call): DecidedItem {
  return {
    id: call.id,
    at: call.answer?.at ?? "",
    kind: call.decided?.kind ?? null,
    task: call.about ?? null,
    what: call.decided?.what || call.answer?.label || call.title,
    why: call.decided?.why ?? "",
    link: call.decided?.link ?? null,
  };
}

/** One call the first mate made for the captain: what, why, and a way to disagree. */
function DecidedRow({ item, taskTitle, onTask, onPushBack, onDismiss }: { item: DecidedItem; taskTitle: string | null; onTask?: () => void; onPushBack: () => void; onDismiss: () => void }) {
  return <article className="decided-row" data-decided-id={item.id}>
    <span className="decided-icon">{(item.kind && DECIDED_ICONS[item.kind]) || <ShipWheel size={15} />}</span>
    <div className="decided-copy">
      <strong>{item.what}</strong>
      {item.why && <p>{item.why}</p>}
      <small className="decided-meta">
        {item.at && <time dateTime={item.at}>{formatWhen(item.at)}</time>}
        {taskTitle && (onTask ? <button className="link-button" onClick={onTask}>{taskTitle}</button> : <span>{taskTitle}</span>)}
        {item.link && <ExternalAnchor className="link-button" href={item.link}>{linkLabel(item.link)} <ExternalLink size={11} /></ExternalAnchor>}
      </small>
    </div>
    <div className="decided-actions">
      <button onClick={onPushBack} title="Tell the first mate you see it differently"><Reply size={14} /> Push back</button>
      <button className="icon-button" onClick={onDismiss} title="Dismiss"><X size={15} /></button>
    </div>
  </article>;
}

const DISMISSED_KEY = "quarterdeck.decided.dismissed";

/** Which calls the captain has seen and put away. Only a convenience, so a refused store just shows them again. */
function readDismissed(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Storage refused: the row stays dismissed for this session only.
  }
}

type LandedItem = {
  id: string;
  kind: "landed" | "answered";
  title: string;
  date: string | null;
  verb: string | null;
  project: string | null;
  pr: string | null;
  report: string | null;
  page?: Artifact;
  /** On an answered call: what the captain chose, and the first thing that argued it. */
  answer?: string;
  basis?: Evidence;
};

/** The local day of a moment, `yyyy-mm-dd`, as backlog dates are written. */
function localDay(at: string) {
  // A bare date already names the day; parsing it would read it as UTC midnight,
  // which west of Greenwich is the evening before.
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * What landed, with what the captain would open next: the PR, the report, the page. Calls the captain
 * answered sit among them, since for the captain that is something done too.
 */
function landedItems(landed: Landed[], records: Map<string, BacklogRecord>, artifacts: Artifact[], answered: Call[], evidenceOf: (call: Call) => Evidence[]): LandedItem[] {
  const rows: LandedItem[] = landed.map((item) => {
    const record = records.get(item.id);
    // firstmate writes "-" for a row with nothing to point at.
    const artifact = item.artifact.trim() === "-" ? "" : item.artifact.trim();
    return {
      id: item.id,
      kind: "landed",
      title: item.what,
      date: record?.completion?.date ?? null,
      verb: record?.completion?.verb ?? null,
      project: record?.repo ?? null,
      pr: record?.pr_url ?? (/^https?:\/\/\S+\/pull\/\d+/.test(artifact) ? artifact : null),
      report: record?.report_path ?? (artifact.endsWith(".md") ? artifact : null),
      page: latestTaskPage(artifacts, item.id),
    };
  });
  for (const call of answered) {
    if (!call.answer) continue;
    rows.push({
      id: call.id, kind: "answered", title: call.title, date: localDay(call.answer.at), verb: call.state === "closed" ? "closed" : "answered",
      project: records.get(call.id)?.repo ?? null, pr: null, report: null,
      answer: call.answer.label, basis: argumentOf(evidenceOf(call)),
    });
  }
  // Newest first; a row with no date keeps its place after the dated ones.
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => (b.row.date ?? "").localeCompare(a.row.date ?? "") || a.index - b.index)
    .map(({ row }) => row);
}

const LANDED_VERBS: Record<string, string> = { merged: "Merged", reported: "Reported", done: "Done" };

function LandedRow({ row, onOpenPage, onAsk, onBasis }: { row: LandedItem; onOpenPage?: () => void; onAsk?: () => void; onBasis?: () => void }) {
  const when = row.date ? formatDay(row.date) : null;
  const meta = row.kind === "answered"
    ? ["Your call", when && `${row.verb ?? "closed"} ${when}`, row.project].filter(Boolean).join(" · ")
    : [row.verb && when ? `${LANDED_VERBS[row.verb] ?? row.verb} ${when}` : when, row.project].filter(Boolean).join(" · ");
  const basis = row.basis;
  return <div className="compact-row landed-row" data-testid="landed-row" data-landed-kind={row.kind} data-id={row.id}>
    <span className="tone-green">{row.kind === "answered" ? <Inbox size={15} /> : <Check size={15} />}</span>
    <div>
      <strong>{row.title}</strong>
      {row.kind === "answered" && <small className="landed-answer">You chose <em>{row.answer}</em>{basis && <> · based on {basis.kind === "url"
        ? <ExternalAnchor className="link-button" href={basis.url}>{basis.title}</ExternalAnchor>
        : <button className="link-button" onClick={onBasis}>{basis.title}</button>}</>}</small>}
      {meta && <small>{meta}</small>}
    </div>
    <div className="landed-links">
      {row.pr && <ExternalAnchor className="landed-link" href={row.pr}><GitMerge size={13} /> {linkLabel(row.pr)}</ExternalAnchor>}
      {onOpenPage && <button className="landed-link" onClick={onOpenPage}><PanelsTopLeft size={13} /> The page</button>}
      {onAsk && <button className="landed-link" onClick={onAsk} title={row.report ?? undefined}><FileText size={13} /> Report</button>}
    </div>
  </div>;
}

/** How an answer names its call, which is what lets a waiting answer find its card again after a relaunch. */
function callName(call: Call) {
  return call.id.replaceAll("-", " ");
}

/** Whether a message the captain sent is an answer to this call: the app wrote it itself. */
function answersCall(text: string, call: Call) {
  return text.trim().toLowerCase().startsWith(`on the ${callName(call).toLowerCase()}:`);
}

/** What firstmate's intake did with an answer given from Bearings, kept on the card until the call leaves the list. */
type AnswerNote = { label: string; result: IntakeResult; detail: string; told: boolean; warning?: string; unread: boolean };

type OptionChoice = { key: string; label: string };

/** A call's options at a glance: how many, and which one the first mate recommends. */
function optionSummary(call: Call) {
  const count = call.options.length;
  if (count === 0) return "The case for this is written up";
  const pick = recommended(call);
  return `${count} options${pick ? ` · Recommended: ${pick.label}` : ""}`;
}

/** The call's question, unless its title already asks it word for word (after the project's name). */
function questionBeyondTitle(call: Call) {
  const plain = (text: string) => text.replace(/^[^:]{1,40}:\s*/, "").trim().toLowerCase();
  return call.question && plain(call.question) !== plain(call.title) ? call.question : null;
}

function CallMeta({ call }: { call: Call }) {
  return <div className="decision-meta"><span>Your call</span>{call.raised_at && <small>Raised {formatWhen(call.raised_at)}</small>}</div>;
}

/** An answer the intake did not record, said as plainly as a recorded one. Nothing about it reached the first mate. */
function NotRecorded({ note }: { note: AnswerNote }) {
  return <div className="call-state tone-coral call-not-recorded" role="alert" data-testid="not-recorded"><CircleAlert size={16} /><span><strong>Not recorded: {note.label}</strong><small>{note.detail}</small></span></div>;
}

/**
 * One call waiting on the captain. A call something argues leads with reading that argument, and can be answered
 * right here too. A call nothing argues offers its options inline. An answer with a key goes through firstmate's
 * intake and the card says what it did; anything else is words to the first mate, tracked like any message.
 */
function DecisionCard({ call, argument, seenArgument, answered, answeredIn, state, answerText, runtime, onSend, onAnswer, onStart, onReadArgument, onOpenPage }: {
  call: Call;
  argument?: Evidence;
  /** Whether the captain has opened the page that argues it; null when the argument is not a page. */
  seenArgument: boolean | null;
  answered?: AnswerNote;
  answeredIn?: string;
  state: CallState;
  answerText?: string;
  runtime: HostRuntimeState;
  onSend: (text: string) => void;
  onAnswer: (option: OptionChoice, note?: string) => Promise<void>;
  onStart: () => void;
  onReadArgument?: () => void;
  onOpenPage?: () => void;
}) {
  const [selection, setSelection] = useState<OptionChoice | null>(null);
  const [note, setNote] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [deferDate, setDeferDate] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  // Options with a key go through the intake; that needs the call to say how an answer closes it.
  const keyed = call.options.length > 0 && Boolean(call.on_answer);
  const name = callName(call);
  const failed = answered && answered.result !== "closed" ? answered : undefined;

  async function record(option: OptionChoice, words?: string) {
    setRecording(option.key);
    try {
      await onAnswer(option, words);
    } finally {
      setRecording(null);
    }
  }

  const words = deferDate
    ? `not now. Ask me again on ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${deferDate}T12:00:00`))}.`
    : [selection && !keyed ? selection.label : "", note.trim()].filter(Boolean).join(". ");
  const recordPick = keyed && selection && !deferDate ? selection : null;
  const preview = words && !recordPick ? `On the ${name}: ${words.replace(/[.]*$/, ".")}` : "…";

  if (state) {
    const read = state.status === "picked_up";
    const reSent = state.resentAfterRestart;
    const title = state.errorKind === "not_sent"
      ? "Not sent"
      : state.errorKind === "failed"
        ? "Your answer didn't go through."
      : read
        ? `Answered · the first mate read it by ${formatTime(state.readAt ?? new Date().toISOString())}`
        : reSent
          ? "Re-sent after a restart"
          : "Queued";
    const detail = reSent && !read
      ? "The first mate may see this answer twice"
      : runtime === "dead"
        ? "The first mate will read this when it starts"
        : runtime === "locked_by_other"
          ? "This goes when the first mate runs in this app"
          : "The first mate will read this when it finishes what it's doing";
    // Read, still on its way, and didn't go through are three different facts, so they never share a look.
    const tone: Tone = state.error ? "coral" : read ? "green" : "amber";
    const icon = state.error ? <CircleAlert size={16} /> : read ? <Check size={16} /> : <Clock3 size={16} />;
    // After a relaunch the card is fresh, so what the captain chose lives in the message, not in this card's state.
    const resendText = preview === "…" ? answerText : preview;
    return <article className={`decision-card ${read ? "read" : "queued"} call-tone-${tone}`} data-call-id={call.id}><CallMeta call={call} /><h3>{call.title}</h3>{answerText && <p className="call-answer" title={answerText}>{answerText}</p>}<div className={`call-state tone-${tone}`}>{icon}<span><strong>{title}</strong>{state.error ? <small>{state.error}</small> : !read && <small>{detail}</small>}</span>{state.error && !state.resent && resendText ? <button onClick={() => onSend(resendText)}>Send again</button> : !read && !state.error && runtime === "dead" ? <button onClick={onStart}>Start the first mate</button> : null}</div></article>;
  }
  if (answered?.result === "closed") {
    // Recorded by firstmate itself; the card goes once the snapshot has the call closed.
    const told = answered.told ? "The first mate has been told, and does the follow-up." : answered.warning ?? "The first mate was not told. Tell it in chat so it does the follow-up.";
    return <article className="decision-card read call-tone-green" data-call-id={call.id} data-recorded="true"><CallMeta call={call} /><h3 data-testid="decision-title">{call.title}</h3><div className="call-state tone-green"><Check size={16} /><span><strong>Recorded: {answered.label}</strong><small>{told}</small>{answered.unread && <small className="call-unread">You answered without opening the argument.</small>}</span>{onOpenPage && <button onClick={onOpenPage}>Open the page</button>}</div></article>;
  }
  if (answeredIn) {
    // Answered in a review; the card goes once the snapshot has the call closed.
    return <article className="decision-card read call-tone-green" data-call-id={call.id} data-answered-in-review="true"><CallMeta call={call} /><h3 data-testid="decision-title">{call.title}</h3><div className="call-state tone-green"><Check size={16} /><span><strong>Answered in your review of “{answeredIn}”</strong><small>This leaves the list once firstmate has closed it.</small></span>{onOpenPage && <button onClick={onOpenPage}>Open the page</button>}</div></article>;
  }
  if (argument && onReadArgument) {
    // Something argues this one, so reading it comes first; answering here is for a captain who already knows.
    return <article className="decision-card" data-call-id={call.id} data-argued="true">
      <CallMeta call={call} />
      <h3 data-testid="decision-title">{call.title}</h3>
      {questionBeyondTitle(call) && <p data-testid="decision-reason">{call.question}</p>}
      <p className="call-argued" data-testid="argued-by">Argued by <strong>{argument.title}</strong></p>
      {failed && <NotRecorded note={failed} />}
      <div className="decision-actions">
        <span>{optionSummary(call)}</span>
        <div className="report-actions">
          {keyed && <button className="quiet" aria-expanded={quickOpen} onClick={() => setQuickOpen((open) => !open)}>Answer now</button>}
          <button onClick={onReadArgument}><PanelsTopLeft size={15} /> Read the argument</button>
        </div>
      </div>
      {quickOpen && keyed && <div className="call-quick" data-testid="answer-now">
        <p>Choosing an option records it as your answer right away. To change it afterwards, tell the first mate.</p>
        {seenArgument === false && <p className="call-unread" data-testid="unread-argument">You haven't opened “{argument.title}” yet.</p>}
        <div className="suggestion-chips">{call.options.map((option) => <button key={option.key} className={recording === option.key ? "selected" : ""} disabled={recording !== null} onClick={() => void record(option)}><span>{recording === option.key ? `Recording “${option.label}”…` : option.label}</span>{option.recommended && <small>Recommended</small>}</button>)}</div>
      </div>}
    </article>;
  }
  const buttonLabel = recordPick ? (recording ? "Recording…" : "Record answer") : "Send";
  const hint = recordPick ? `→ records: ${recordPick.label}${note.trim() ? ", and tells the first mate what you added" : ""}` : preview !== "…" ? `→ sends: ${preview}` : "";
  return <article className="decision-card" data-call-id={call.id} data-inline="true">
    <CallMeta call={call} />
    <h3 data-testid="decision-title">{call.title}</h3>
    {questionBeyondTitle(call) && <p data-testid="decision-reason">{call.question}</p>}
    {failed && <NotRecorded note={failed} />}
    <div className="suggestion-chips">
      {call.options.map((option) => <button className={selection?.key === option.key ? "selected" : ""} key={option.key} disabled={recording !== null} onClick={() => { setSelection(option); setDateOpen(false); setDeferDate(""); }}><span>{option.label}</span>{option.recommended && <small>Recommended</small>}</button>)}
      <button className={dateOpen ? "selected" : ""} disabled={recording !== null} onClick={() => { setDateOpen(true); setSelection(null); }}>Not now</button>
    </div>
    {dateOpen && <label className="date-field"><span>Ask me again</span><input type="date" value={deferDate} onChange={(event) => setDeferDate(event.target.value)} /></label>}
    <label className="reply-field"><span>{recordPick ? "Anything to add for the first mate?" : "Or write your own answer"}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <div className="decision-actions"><span>{hint}</span><button disabled={recording !== null || (!recordPick && preview === "…")} onClick={() => recordPick ? void record(recordPick, note.trim() || undefined) : onSend(preview)}><Send size={15} /> {buttonLabel}</button></div>
  </article>;
}

type ProjectSummary = { name: string; posture: string; description: string; tasks: FleetTask[] };

function ProjectsView({ projects, waitingIn, underwayIn, onOpen }: { projects: ProjectSummary[]; waitingIn: (name: string) => number; underwayIn: (project: ProjectSummary) => number; onOpen: (name: string) => void }) {
  return <div className="content-scroll projects-page"><div className="project-grid">{projects.map((project) => {
    const waiting = waitingIn(project.name);
    return <button key={project.name} className="project-card" onClick={() => onOpen(project.name)}><span className="project-sigil large">{project.name.slice(0, 2).toUpperCase()}</span><div><h2>{project.name}</h2><p>{project.posture}</p><span>{waiting > 0 && <em>{waiting} waiting on you · </em>}{underwayIn(project)} underway</span></div><ChevronRight size={18} /></button>;
  })}</div></div>;
}

/** A row's title without the project name it starts with, which the project page already says. */
function withinProject(title: string, project: string) {
  const match = title.match(/^([^:]{1,40}):\s+(.+)$/);
  if (!match) return title;
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const [prefix, name] = [squash(match[1]), squash(project)];
  if (!prefix || !(name.startsWith(prefix) || prefix.startsWith(name))) return title;
  return match[2].charAt(0).toUpperCase() + match[2].slice(1);
}

/** The project's closed work as the app has read it from firstmate, a page at a time. */
type HistoryView = {
  project: string | null;
  records: BacklogRecord[];
  calls: Call[];
  next: string | null;
  /** `unsupported`: this home's firstmate cannot list its history, so only the snapshot's recent rows show. */
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  error: string | null;
  loadingMore: boolean;
  schema: string | null;
};

const HISTORY_PAGE = 50;
const NO_HISTORY: HistoryView = { project: null, records: [], calls: [], next: null, status: "idle", error: null, loadingMore: false, schema: null };

/**
 * Reads a project's closed work while its page is open, and again whenever the snapshot changes, keeping as many
 * rows as the captain had already paged through. One read runs at a time: a change while it runs asks for one
 * more read after it, so a busy home, whose snapshot changes every few seconds, still gets its answer.
 */
function useProjectHistory(project: string | null, stamp: string | undefined) {
  const [view, setView] = useState<HistoryView>(NO_HISTORY);
  const [attempt, setAttempt] = useState(0);
  const reader = useRef({ project: null as string | null, count: 0, running: false, again: false });
  useEffect(() => {
    const state = reader.current;
    if (!project) { state.project = null; return; }
    if (state.project !== project) {
      Object.assign(state, { project, count: 0, again: false });
      setView({ ...NO_HISTORY, project, status: "loading" });
    }
    if (state.running) { state.again = true; return; }
    const read = (name: string) => {
      state.running = true;
      state.again = false;
      const limit = Math.min(500, Math.max(HISTORY_PAGE, state.count));
      host.projectHistory(name, { limit }).then((page) => {
        if (state.project !== name) return;
        // Older rows paged in while this read ran: read again rather than drop them.
        if (state.count > limit) { state.again = true; return; }
        if (!page) return setView({ ...NO_HISTORY, project: name, status: "unsupported" });
        state.count = page.records.length;
        setView({ project: name, records: page.records, calls: page.calls, next: page.next, status: "ready", error: null, loadingMore: false, schema: page.schema });
      }).catch((error: unknown) => {
        // A failed re-read keeps what was already shown.
        if (state.project === name) setView((current) => ({ ...current, project: name, status: current.project === name && current.status === "ready" ? "ready" : "error", error: String(error) }));
      }).finally(() => {
        state.running = false;
        if (state.project && (state.again || state.project !== name)) read(state.project);
      });
    };
    read(project);
  }, [project, stamp, attempt]);

  const more = () => {
    if (!view.project || !view.next || view.loadingMore) return;
    const { project: name, next } = view;
    setView((current) => ({ ...current, loadingMore: true }));
    host.projectHistory(name, { after: next, limit: HISTORY_PAGE }).then((page: ProjectHistory | null) => {
      setView((current) => {
        if (current.project !== name || !page) return { ...current, loadingMore: false };
        const known = new Set(current.records.map((record) => record.id));
        const records = [...current.records, ...page.records.filter((record) => !known.has(record.id))];
        reader.current.count = records.length;
        return { ...current, records, calls: [...current.calls, ...page.calls], next: page.next, loadingMore: false };
      });
    }).catch((error: unknown) => setView((current) => ({ ...current, loadingMore: false, error: String(error) })));
  };
  return { ...view, more, retry: () => setAttempt((count) => count + 1) };
}

type ProjectReport = { task: FleetTask; page?: Artifact; report: string | null };

function ProjectView({ project, now, taskTitle, records, waiting, reports, underway, queued, recent, calls, history, onOpenTask, onOpenCall, onOpenReport, onOpenEntry }: {
  project: ProjectSummary;
  now: number;
  taskTitle: (id: string) => string;
  records: Map<string, BacklogRecord>;
  waiting: Call[];
  reports: ProjectReport[];
  underway: FleetTask[];
  queued: BacklogRecord[];
  recent: BacklogRecord[];
  calls: Call[];
  history: ReturnType<typeof useProjectHistory>;
  onOpenTask: (task: FleetTask) => void;
  onOpenCall: (id: string) => void;
  onOpenReport: (item: ProjectReport) => void;
  onOpenEntry: (entry: LogEntry) => void;
}) {
  const needs = waiting.length + reports.length;
  const title = (text: string) => withinProject(text, project.name);
  return <div className="content-scroll project-page" data-testid="project-page">
    <section className="project-summary">
      <div><span>Project</span><h2>{project.name}</h2><p>{project.description || "The first mate keeps this work within the project's standing delivery posture."}</p></div>
      <div className="project-stats">
        <div className="project-stat" data-testid="stat-waiting"><strong className={needs ? "tone-coral" : ""}>{needs}</strong><span>Waiting on you</span></div>
        <div className="project-stat"><strong>{underway.length}</strong><span>Underway</span></div>
        <div className="project-stat"><strong>{queued.length}</strong><span>Up next</span></div>
      </div>
    </section>

    {needs > 0 && <DashboardSection title="Needs you" icon={<Inbox size={17} />} tone="coral" count={needs}>
      <div className="task-list" data-testid="project-needs">
        {waiting.map((call) => {
          const pick = recommended(call);
          return <button className="task-row wide" key={call.id} data-call={call.id} onClick={() => onOpenCall(call.id)}><span className="task-state tone-coral"><ShieldQuestion size={16} /></span><span className="task-copy"><strong>{title(call.title)}</strong><small>{pick ? `Recommended: ${pick.label}` : call.question ?? "The first mate needs your answer."}</small></span><span className="task-chip tone-coral">Your call</span><ChevronRight size={17} /></button>;
        })}
        {reports.map((item) => <button className="task-row wide" key={item.task.id} onClick={() => onOpenReport(item)}><span className="task-state tone-blue"><FileText size={16} /></span><span className="task-copy"><strong>{title(taskTitle(item.task.id))}</strong><small>{item.page ? "The report is ready to read." : "The report is written, without a page."}</small></span><span className="task-chip tone-blue">Report</span><ChevronRight size={17} /></button>)}
      </div>
    </DashboardSection>}

    <DashboardSection title="Underway" icon={<Radio size={17} />} tone="blue" count={underway.length}>
      <div className="task-list">{underway.map((task) => {
        const status = taskStatus(task.current_state.state);
        const started = startedAt(task, records.get(task.id));
        return <button className="task-row" key={task.id} onClick={() => onOpenTask(task)}><span className={`task-state tone-${status.tone}`}>{status.icon}</span><span className="task-copy"><strong>{title(taskTitle(task.id))}</strong><small>{KIND_NAMES[task.kind] ?? task.kind} · {task.harness}{started && <> · {sinceLabel(started, now)}</>}</small></span><span className={`task-chip tone-${status.tone}`}>{stateLabel(task.current_state.state)}</span><ChevronRight size={17} /></button>;
      })}</div>
      {underway.length === 0 && <EmptyState label="Nothing is underway in this project." />}
    </DashboardSection>

    {queued.length > 0 && <DashboardSection title="Up next" icon={<Clock3 size={17} />} tone="amber" count={queued.length}>
      <div className="task-list" data-testid="project-queue">{queued.map((record) => {
        const detail = [KIND_NAMES[record.kind ?? ""] ?? record.kind, record.since && `filed ${shortDay(record.since, now)}`, record.hold_reason].filter(Boolean).join(" · ");
        return <div className="task-row wide static" key={record.id}><span className="task-state tone-amber"><Clock3 size={16} /></span><span className="task-copy"><strong>{title(record.title)}</strong><small>{detail}</small></span><span className={`task-chip tone-${record.hold_reason ? "amber" : "muted"}`}>{record.hold_reason ? "Waiting" : "Queued"}</span></div>;
      })}</div>
    </DashboardSection>}

    <Logbook project={project.name} now={now} recent={recent} calls={calls} history={history} title={title} onOpen={onOpenEntry} />
  </div>;
}

const LOG_FILTERS: { id: LogFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "shipped", label: "Shipped" },
  { id: "report", label: "Reports" },
  { id: "decision", label: "Decisions" },
];

const LOG_LOOK: Record<LogEntry["kind"], { tone: string; chip: string; icon: React.ReactNode }> = {
  shipped: { tone: "green", chip: "Shipped", icon: <GitMerge size={16} /> },
  report: { tone: "blue", chip: "Report", icon: <FileText size={16} /> },
  decision: { tone: "sea", chip: "Decision", icon: <ShipWheel size={16} /> },
  closed: { tone: "muted", chip: "Closed", icon: <CircleSlash size={16} /> },
};

/**
 * Everything the project closed, newest first. The filters and the search are for this visit only: a filter
 * remembered across visits reads as work gone missing.
 */
function Logbook({ project, now, recent, calls, history, title, onOpen }: { project: string; now: number; recent: BacklogRecord[]; calls: Call[]; history: ReturnType<typeof useProjectHistory>; title: (text: string) => string; onOpen: (entry: LogEntry) => void }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [query, setQuery] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);
  useEffect(() => { setFilter("all"); setQuery(""); setIncludeClosed(false); }, [project]);
  // The snapshot's calls are the newer read of a call the history also lists.
  const allCalls = useMemo(() => {
    const known = new Set(calls.map((call) => call.id));
    return [...calls, ...history.calls.filter((call) => !known.has(call.id))];
  }, [calls, history.calls]);
  const entries = useMemo(() => logEntries(history.project === project ? history.records : [], recent, allCalls, project), [history.project, history.records, recent, allCalls, project]);
  const counts = logCounts(entries, includeClosed);
  const shown = filterLog(entries, filter, query, includeClosed);
  const periods = logPeriods(shown, now);
  // Until this project's first read answers, an empty list means "not read yet", never "nothing closed".
  const read = history.project === project && history.status !== "loading" && history.status !== "idle";
  const loading = !read && entries.length === 0;
  const narrowed = filter !== "all" || query.trim() !== "";
  // Older rows not read yet: every count is a floor, and a narrowed list says how far back it looked.
  const more = history.next ? "+" : "";
  const oldest = entries.at(-1)?.date;
  return <section className="dashboard-section logbook" data-testid="logbook" data-state={read ? history.status : "loading"}>
    <div className="section-heading"><span className="section-icon green"><BookOpen size={17} /></span><h2>Logbook</h2><span className="section-count" data-testid="log-count">{counts.all}{more}</span></div>
    {entries.length > 0 && <div className="logbook-tools">
      <div className="logbook-filters" role="group" aria-label="Show">
        {LOG_FILTERS.map((item) => <button key={item.id} aria-pressed={filter === item.id} className={filter === item.id ? "selected" : ""} onClick={() => setFilter(item.id)}>{item.label}<span>{counts[item.id]}{more}</span></button>)}
      </div>
      <label className="logbook-search"><Search size={14} /><input type="search" value={query} placeholder="Search this project's work" aria-label="Search this project's work" onChange={(event) => setQuery(event.target.value)} />{query && <button className="icon-button" title="Clear the search" onClick={() => setQuery("")}><X size={13} /></button>}</label>
    </div>}
    {periods.map((group) => <div className="logbook-period" key={group.id} data-period={group.id}>
      <h3>{group.title}</h3>
      <div className="task-list">{group.entries.map((entry) => <LogRow key={entry.id} entry={entry} now={now} title={title(entry.title)} onOpen={() => onOpen(entry)} />)}</div>
    </div>)}
    {loading && <EmptyState label="Reading this project's logbook…" />}
    {read && entries.length === 0 && history.status !== "error" && <EmptyState label="Nothing has closed in this project yet." />}
    {entries.length > 0 && shown.length === 0 && <div className="empty-state"><CircleDot size={16} /><strong>Nothing closed matches.</strong>{narrowed && <button className="text-link" onClick={() => { setFilter("all"); setQuery(""); }}>Show everything</button>}</div>}
    <div className="logbook-footer">
      {counts.closed > 0 && <button className="text-link" data-testid="toggle-closed" onClick={() => setIncludeClosed((shown) => !shown)}>{includeClosed ? "Hide" : "Show"} {counts.closed} {counts.closed === 1 ? "task" : "tasks"} closed without a delivery</button>}
      {history.next && !narrowed && <button className="landed-link" data-testid="log-more" disabled={history.loadingMore} onClick={history.more}>{history.loadingMore ? "Reading…" : "Show older"}</button>}
    </div>
    {narrowed && history.next && <p className="logbook-note" data-testid="log-partial">Looked back to {oldest ? shortDay(oldest, now) : "the rows read so far"}. <button className="text-link" data-testid="log-further" onClick={history.more} disabled={history.loadingMore}>{history.loadingMore ? "Reading…" : "Look further back"}</button></p>}
    {history.status === "unsupported" && <p className="logbook-note">Only the most recent work shows. This home's firstmate can't list older work yet.</p>}
    {history.status === "error" && <p className="logbook-note" data-testid="log-error">Couldn't read this project's older work. <button className="text-link" onClick={history.retry}>Try again</button></p>}
  </section>;
}

function LogRow({ entry, now, title, onOpen }: { entry: LogEntry; now: number; title: string; onOpen: () => void }) {
  const look = LOG_LOOK[entry.kind];
  const chip = entry.kind === "shipped" && entry.pr ? linkLabel(entry.pr) : look.chip;
  return <button className="task-row wide log-row" data-testid="log-row" data-kind={entry.kind} data-id={entry.id} onClick={onOpen}>
    <span className={`task-state tone-${look.tone}`}>{look.icon}</span>
    <span className="task-copy"><strong>{title}</strong><small>{outcomeLine(entry, now)}</small></span>
    <span className={`task-chip tone-${look.tone}`}>{chip}</span>
    <ChevronRight size={17} />
  </button>;
}

/** How long a closed task was open, the way its kind finishes. */
function tookLine(kind: LogEntry["kind"], days: number) {
  const span = `${days} day${days === 1 ? "" : "s"}`;
  if (kind === "decision") return days === 0 ? "answered the day it was raised" : `answered after ${span}`;
  return days === 0 ? "done the day it was filed" : `took ${span}`;
}

/** How the timeline names the moment a task closed. */
const CLOSED_AS: Record<LogEntry["kind"], (entry: LogEntry) => string> = {
  shipped: (entry) => entry.record.completion?.verb === "landed" ? "Landed" : "Merged",
  report: () => "Reported",
  decision: () => "Answered",
  closed: () => "Closed",
};

/** A closed task, read from its backlog row: what was asked, what it left behind, and how it closed. */
function LogbookDrawer({ entry, project, now, artifacts, reviews, source, onOpenArtifact, onAskReport, onClose }: { entry: LogEntry; project: string; now: number; artifacts: Artifact[]; reviews: ReviewSummary; source: string | null; onOpenArtifact: (artifact: Artifact) => void; onAskReport: () => void; onClose: () => void }) {
  const look = LOG_LOOK[entry.kind];
  const record = entry.record;
  const call = entry.call;
  const notes = (record.body_lines ?? []).map((line) => line.trim()).filter((line) => line && !BOOKKEEPING.test(line));
  const ask = notes.length ? notes.join(" ") : record.body_excerpt && !BOOKKEEPING.test(record.body_excerpt) ? record.body_excerpt : null;
  const days = record.since && entry.date ? Math.round((Date.parse(entry.date) - Date.parse(record.since)) / DAY_MS) : null;
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) close.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape); };
  }, []);
  return <div className="drawer-backdrop passive"><aside className="task-drawer" ref={panel} data-testid="log-drawer">
    <header className="drawer-header"><div><span>{project}</span><h2 data-testid="drawer-title">{withinProject(entry.title, project)}</h2><small className="drawer-id">{entry.id}</small></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header>
    <div className="drawer-status"><span className={`task-state tone-${look.tone}`}>{look.icon}</span><div><strong className={`tone-${look.tone}`}>{outcomeLine(entry, now)}</strong><span>{KIND_NAMES[record.kind ?? ""] ?? look.chip}{days !== null && days >= 0 && ` · ${tookLine(entry.kind, days)}`}</span></div></div>
    <div className="drawer-scroll">
      {call && <DrawerSection title="The call"><div className="brief-block log-call">
        {call.question && <p>{call.question}</p>}
        {call.answer && <dl><dt>Answer</dt><dd>{call.answer.label}</dd>{call.decided?.why && <><dt>Why</dt><dd>{call.decided.why}</dd></>}</dl>}
      </div></DrawerSection>}
      {ask && <DrawerSection title={call ? "From the backlog" : "What was asked"}><div className="brief-block"><p>{ask}</p></div></DrawerSection>}
      {entry.pr && <DrawerSection title="PR"><div className="pr-block"><a href={entry.pr} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {entry.pr}</a></div></DrawerSection>}
      {artifacts.length > 0 && <DrawerSection title="Pages"><div className="drawer-pages">{artifacts.map((artifact) => <ArtifactRow key={artifact.name} artifact={artifact} detail={revisionLine(artifact)} review={reviews[artifactKey(artifact)]} landed onOpen={() => onOpenArtifact(artifact)} />)}</div></DrawerSection>}
      {entry.report && artifacts.length === 0 && <DrawerSection title="Report"><div className="pr-block report-block"><span title={entry.report}><FileText size={15} /> The report is written, without a page.</span><button className="landed-link" onClick={onAskReport}><MessageSquareText size={13} /> Ask the first mate for it</button></div></DrawerSection>}
      <DrawerSection title="Timeline"><div className="timeline">
        {record.since && <div><span className="timeline-icon"><GitBranch size={15} /></span><span><strong>Filed</strong><small>{KIND_NAMES[record.kind ?? ""] ?? record.kind ?? "Task"}</small></span><time>{shortDay(record.since, now)}</time></div>}
        <div><span className="timeline-icon">{look.icon}</span><span><strong>{call?.answer && entry.kind === "decision" ? answeredBy(call.answer) : CLOSED_AS[entry.kind](entry)}</strong><small>{call?.answer && entry.kind === "decision" ? call.answer.label : KIND_NAMES[record.kind ?? ""] ?? look.chip}</small></span><time>{entry.date ? shortDay(entry.date, now) : "Undated"}</time></div>
      </div></DrawerSection>
    </div>
    <footer className="drawer-footer">From {source ?? "the fleet snapshot"}</footer>
  </aside></div>;
}

type ChatItem = { type: "message"; message: ChatMessage } | { type: "steps"; id: string; steps: ChatMessage[]; past: boolean } | { type: "label"; id: string; text: string } | { type: "artifact"; id: string; artifact: Artifact; revision: ArtifactRevision };

/**
 * Consecutive steps read as one group between the first mate's messages.
 * A resumed session's history reads as "Earlier", and "Today" starts after its last item.
 * A message still waiting keeps its place inside the history, so it stays under "Earlier".
 * A page presented in the last day shows where it happened among this window's messages, and after a resumed
 * session's history, whose items carry no time. A day rather than the calendar date, so a page shared just before
 * midnight does not drop out of the conversation a minute later.
 */
const CHAT_PAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** When this window opened: a page shared before it belongs with the resumed conversation, not with today's. */
const WINDOW_OPENED = new Date().toISOString();

function chatItems(messages: ChatMessage[], artifacts: Artifact[]) {
  const lastPast = messages.reduce((found, message, index) => message.past ? index : found, -1);
  // A resumed conversation comes back without times, so its pages cannot be placed
  // between its messages. They go after it, still under "Earlier", and "Today" keeps
  // to what happened since: before, yesterday's pages sat under "Today".
  const liveFrom = messages.find((message) => !message.past)?.createdAt ?? WINDOW_OPENED;
  const items: ChatItem[] = [{ type: "label", id: "label-top", text: lastPast >= 0 ? "Earlier" : "Today" }];
  const since = Date.now() - CHAT_PAGE_WINDOW_MS;
  const pages = artifacts
    .flatMap((artifact) => artifact.revisions.map((revision) => ({ artifact, revision })))
    .filter(({ revision }) => Date.parse(revision.presented_at) >= since)
    .sort((a, b) => a.revision.presented_at.localeCompare(b.revision.presented_at));
  const pushPages = (before?: string) => {
    while (pages.length && (before === undefined || pages[0].revision.presented_at < before)) {
      const { artifact, revision } = pages.shift()!;
      items.push({ type: "artifact", id: `artifact-${artifact.scope}-${artifact.task}-${artifact.name}-${revision.rev}`, artifact, revision });
    }
  };
  messages.forEach((message, index) => {
    if (lastPast >= 0 && index === lastPast + 1) {
      pushPages(liveFrom < WINDOW_OPENED ? liveFrom : WINDOW_OPENED);
      items.push({ type: "label", id: `label-${message.id}`, text: "Today" });
    }
    if (!message.past) pushPages(message.createdAt);
    const past = message.past === true;
    const last = items.at(-1);
    if (message.who !== "step") items.push({ type: "message", message });
    else if (last?.type === "steps" && last.past === past) last.steps.push(message);
    else items.push({ type: "steps", id: `steps-${message.id}`, steps: [message], past });
  });
  if (lastPast >= 0 && lastPast === messages.length - 1) {
    pushPages(WINDOW_OPENED);
    if (pages.length) items.push({ type: "label", id: "label-today-pages", text: "Today" });
  }
  pushPages();
  return items;
}

/** Paths inside the home read better relative to it. */
function stripHome(text: string, home: string) {
  return text.replaceAll(`${home}/`, "").trim();
}

/** For one-line step titles: the first line only, since the full text is in the tooltip. */
function relativeToHome(text: string, home: string) {
  return stripHome(text.split("\n")[0], home);
}

const STEP_VERBS: Record<string, string> = { Read: "Read", Edit: "Edited", Write: "Wrote", Fetch: "Opened" };

function describeStep(step: ChatMessage, home: string) {
  const title = relativeToHome(step.text, home) || "A step";
  if (step.kind === "execute") return { verb: "Ran", detail: title, code: true };
  if (step.kind === "search") return { verb: "Searched", detail: title, code: true };
  const [, word, rest] = title.match(/^(Read|Edit|Write|Fetch)\s+(.+)$/) ?? [];
  if (word && rest) return { verb: STEP_VERBS[word], detail: rest, code: false };
  return { verb: "", detail: title, code: false };
}

/** While the turn is on, show the latest steps as they happen; afterwards fold them into one line. */
const LIVE_STEPS = 6;

function StepGroup({ steps, live, home }: { steps: ChatMessage[]; live: boolean; home: string }) {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((step) => step.status === "failed").length;
  const visible = live && !open ? steps.slice(-LIVE_STEPS) : steps;
  const hidden = steps.length - visible.length;
  const summary = steps.length === 1 ? "1 step" : `${steps.length} steps`;
  // A step that errors is usually the first mate probing for something that isn't there, and it goes on from
  // there. The fact stays, told as quietly as the rest of the line.
  const note = failed ? `${failed === steps.length && failed === 1 ? "it" : failed} came back with an error` : "";
  return <div className={`step-group ${live ? "live" : ""}`}>{!live && <button className="step-summary" aria-expanded={open} onClick={() => setOpen((current) => !current)} title={failed ? "A step that errors is often the first mate checking for something that isn't there. It carried on from there." : undefined}><ChevronRight size={13} className={open ? "rotated" : ""} /><span>{summary}</span>{note && <span className="step-note">· {note}</span>}</button>}{live && hidden > 0 && <button className="step-summary" onClick={() => setOpen(true)}><ChevronRight size={13} /><span>{hidden} earlier {hidden === 1 ? "step" : "steps"}</span></button>}{(live || open) && <ol className="step-lines">{visible.map((step) => <StepLine key={step.id} step={step} live={live} home={home} />)}</ol>}</div>;
}

function StepLine({ step, live, home }: { step: ChatMessage; live: boolean; home: string }) {
  const { verb, detail, code } = describeStep(step, home);
  const failed = step.status === "failed";
  const done = step.status === "completed";
  const icon = failed ? <X size={12} /> : done ? <Check size={12} /> : live ? <span className="step-spinner" aria-label="In progress" /> : <CircleDot size={12} />;
  return <li className={`step-line ${failed ? "failed" : ""}`} title={step.text}><span className="step-icon">{icon}</span>{verb && <span className="step-verb">{verb}</span>}<span className={`step-detail ${code ? "code" : ""}`}>{detail}</span></li>;
}

const APPROVAL_LABELS: Record<string, string> = { allow_once: "Allow once", allow_always: "Always allow", reject_once: "Don't allow", reject_always: "Never allow" };

function ApprovalCard({ request, home, onAnswer }: { request: PermissionView; home: string; onAnswer: (optionId: string) => void }) {
  return <section className="approval-card" aria-label="The first mate is asking for your OK"><span className="approval-mark"><ShieldQuestion size={17} /></span><div className="approval-copy"><strong>The first mate wants to:</strong><code>{stripHome(request.title, home)}</code><span>It's waiting for your answer before it goes on with this.</span>{request.error && <small role="alert">That answer didn't go through: {request.error}</small>}</div><div className="approval-actions">{request.options.map((option) => <button key={option.option_id} className={option.kind === "allow_once" ? "allow" : ""} disabled={request.answering} onClick={() => onAnswer(option.option_id)}>{APPROVAL_LABELS[option.kind] ?? option.name}</button>)}</div></section>;
}

function ChatView({ messages, artifacts, tasks, onOpenArtifact, outbox, draft, runtime, hostLabel, degraded, home, sendReady, banners, approvals, onAnswer, onDraft, onSend, onResend, onRestart }: { messages: ChatMessage[]; artifacts: Artifact[]; tasks: FleetTask[]; onOpenArtifact: (artifact: Artifact, rev?: number) => void; outbox: Record<string, OutboxView>; draft: string; runtime: HostRuntimeState; hostLabel: string; degraded: boolean; home: string; sendReady: boolean; banners: React.ReactNode; approvals: PermissionView[]; onAnswer: (id: string, optionId: string) => void; onDraft: (value: string) => void; onSend: () => void; onResend: (id: string, text: string) => void; onRestart: () => void }) {
  const running = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"].includes(runtime);
  const turnLive = runtime === "prompt_turn" || runtime === "agent_turn";
  const placeholder = !sendReady ? "Start the first mate to send it a message." : runtime === "locked_by_other" ? "The first mate is running somewhere else. What you write here waits until it runs in this app." : running ? "Message the first mate" : "The first mate isn't running. It'll read this when it starts.";
  const items = chatItems(messages, artifacts);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // Arriving with words already written (Push back, asking for a report) puts the caret after them, ready to go on.
  useEffect(() => {
    const element = composer.current;
    if (!element || !draft) return;
    element.focus();
    element.setSelectionRange(draft.length, draft.length);
  }, []);
  // Follow the conversation, including a resumed session's history, unless the captain has scrolled up to read.
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages, outbox, approvals, artifacts]);
  // A banner or approval card appearing shrinks the list without a scroll event, so stay pinned through resizes too.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (following.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const element = scroller.current;
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };
  return <div className="chat-view">{banners}<div className="chat-status"><span className="avatar">FM</span><div><strong>First Mate</strong><span><i className={`state-${runtime} ${degraded ? "degraded" : ""}`} /> {hostLabel}</span></div><button className="icon-button" onClick={onRestart} title="Restart the first mate"><RefreshCw size={16} /></button></div><div className="chat-messages" ref={scroller} onScroll={onScroll} data-testid="chat-messages">{messages.length === 0 && items.length === 1 && <><div className="day-label">Today</div><div className="chat-empty">{running ? "The first mate is getting its bearings. Its first message will show up here." : "No messages yet."}</div></>}{items.length > 1 && items.map((item, index) => item.type === "label"
    ? <div key={item.id} className={`day-label ${index > 0 ? "later" : ""}`}>{item.text}</div>
    : item.type === "artifact"
      ? <ArtifactChatCard key={item.id} artifact={item.artifact} revision={item.revision} tasks={tasks} onOpen={() => onOpenArtifact(item.artifact, item.revision.rev)} />
    : item.type === "steps"
      ? <StepGroup key={item.id} steps={item.steps} live={turnLive && !item.past && index === items.length - 1} home={home} />
      : item.message.who === "notice"
        ? <div key={item.message.id} className="chat-notice" role="status">{item.message.text}</div>
        : <ChatMessageView key={item.message.id} message={item.message} outbox={outbox[item.message.id]} running={running} onResend={() => onResend(item.message.id, item.message.text)} />)}</div>{approvals.map((request) => <ApprovalCard key={request.id} request={request} home={home} onAnswer={(optionId) => onAnswer(request.id, optionId)} />)}<div className="composer"><textarea ref={composer} value={draft} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} aria-label="Message the first mate" /><div><button className="icon-button" title="Attach a file"><FileText size={17} /></button><button className="send-button" onClick={onSend} disabled={!draft.trim() || !sendReady} title={sendReady ? "Send message" : "Start the first mate to send messages"}><Send size={16} /></button></div></div></div>;
}

/**
 * The first mate writes markdown, so render it rather than showing the marks.
 * Raw HTML is never rendered, and a link opens outside the app instead of
 * navigating the window away from the first mate.
 */
function MateText({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ href, children }) => <a
        href={href}
        title={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(event) => {
          event.preventDefault();
          if (href) window.open(href, "_blank", "noreferrer");
        }}
      >{children}</a>,
    }}
  >{text}</ReactMarkdown></div>;
}

function ChatMessageView({ message, outbox, running, onResend }: { message: ChatMessage; outbox?: OutboxView; running: boolean; onResend: () => void }) {
  const status = !outbox ? null : outbox.errorKind === "not_sent"
    ? "Not sent"
    : outbox.errorKind === "failed"
      ? "Didn't go through"
    : outbox.resentAfterRestart
      ? `Re-sent after a restart${outbox.status === "picked_up" ? ` · Read by ${formatTime(outbox.readAt ?? message.createdAt)}` : ""}`
      : outbox.status === "picked_up"
        ? `Read by ${formatTime(outbox.readAt ?? message.createdAt)}`
        // Handed over and being worked on: "Queued" here read as if nothing had happened yet.
        : outbox.status === "sent" || outbox.status === "likely_started"
          ? "Reading"
          : "Queued";
  const tooltip = !outbox || outbox.error ? undefined : outbox.resentAfterRestart
    ? "The app stopped before the first mate finished with this, so it sent it again. If the first mate had already started on it, it may mention it twice."
    : outbox.status === "picked_up"
      ? `The first mate had read this by ${formatTime(outbox.readAt ?? message.createdAt)}, when it finished replying.`
      : outbox.status === "sent" || outbox.status === "likely_started"
        ? "The first mate has this and is working on it."
        : running ? "The first mate will read this when it finishes what it's doing." : "The first mate will read this when it starts.";
  const resendAction = !outbox?.error ? null : outbox.resent
    ? <span className="resent-note">Sent again</span>
    : <button onClick={onResend}>{outbox.errorKind === "not_sent" ? "Retry" : "Send again"}</button>;
  // A message from a resumed session's history has no time or delivery status to show.
  const footer = status
    ? <><div className={`message-state ${outbox?.error ? "message-error" : ""}`} title={tooltip}><time>{status}</time>{resendAction}</div>{outbox?.error && <small className="message-reason">{outbox.error}</small>}</>
    : !message.past && <time>{formatTime(message.createdAt)}</time>;
  return <article className={`${message.who === "mate" ? "mate-message" : "captain-message"} ${message.past ? "past" : ""}`}>{message.who === "mate" && <span className="avatar small">FM</span>}<div><strong>{message.who === "mate" ? "First Mate" : "You"}</strong>{message.who === "mate" ? <MateText text={message.text} /> : <p>{message.text}</p>}{footer}</div></article>;
}

function OfflineBanner({ onStart }: { onStart: () => void }) {
  return <section className="offline-banner"><CircleAlert size={18} /><div><strong>The first mate isn't running, so nothing gets checked, merged or answered.</strong><span>Work already underway keeps going.</span></div><button onClick={onStart}>Start the first mate</button></section>;
}

type ProblemCopy = { title: string; hint: string; action: string; choose?: boolean };

const TRY_AGAIN = "Try again";
const START_AGAIN = "Start it again";

/** Banner copy for each `reason_kind`. The host's `reason` is always one click away, under Show details. */
const PROBLEMS: Record<ReasonKind, ProblemCopy> = {
  not_a_home: { title: "The first mate can't start: this folder isn't a firstmate home.", hint: "It needs AGENTS.md and bin inside. Choose your firstmate folder, and the first mate starts there.", action: "Choose folder…", choose: true },
  permission_mode: { title: "The first mate can't start: this home's permission setting isn't one it recognizes.", hint: "Check config/claude-permission-mode in your firstmate folder, then try again.", action: TRY_AGAIN },
  lock_unconfirmed: { title: "The first mate didn't start: it couldn't check that no other first mate is using this home.", hint: "Nothing was started, so two can't run at once. Try again in a moment.", action: TRY_AGAIN },
  lock_unclaimed: { title: "The first mate isn't running: it started, but didn't claim this home in time.", hint: "It was stopped so it can't run unclaimed. Try again.", action: TRY_AGAIN },
  adapter_missing: { title: "The first mate can't start: claude-agent-acp isn't installed on this Mac.", hint: "Install it where your login shell can find it, then try again.", action: TRY_AGAIN },
  adapter_crashed: { title: "The first mate crashed.", hint: "Your messages are kept. Anything it hadn't finished goes to it again when it starts.", action: START_AGAIN },
  timeout: { title: "The first mate took too long to start, so it was stopped.", hint: "Try again. If it keeps happening, the details say where it got stuck.", action: TRY_AGAIN },
  exited: { title: "The first mate stopped on its own.", hint: "Your messages are kept. Start it to pick up where it left off.", action: START_AGAIN },
};

const UNKNOWN_PROBLEM: ProblemCopy = { title: "The first mate couldn't start.", hint: "Nothing gets checked, merged or answered until it runs. Work already underway keeps going.", action: TRY_AGAIN };

function ProblemBanner({ kind, details, homeProblem, onStart, onChoose }: { kind?: ReasonKind; details: string; homeProblem: string | null; onStart: () => void; onChoose: () => void }) {
  const [open, setOpen] = useState(false);
  const copy = (kind && PROBLEMS[kind]) || UNKNOWN_PROBLEM;
  // A folder the captain just chose here that doesn't check out says why right here.
  return <section className="offline-banner problem-banner" role="alert" data-reason-kind={kind}><CircleAlert size={18} /><div><strong>{copy.title}</strong><span>{copy.hint}</span>{copy.choose && homeProblem && <HomeProblem problem={homeProblem} />}{open && <pre className="banner-details">{details || "No further details were reported."}</pre>}</div><div className="banner-actions"><button aria-expanded={open} onClick={() => setOpen((current) => !current)}>{open ? "Hide details" : "Show details"}</button><button onClick={copy.choose ? onChoose : onStart}>{copy.action}</button></div></section>;
}

function LockedBanner({ holder, onCheck }: { holder?: string; onCheck: () => void }) {
  return <section className="offline-banner locked-banner"><CircleAlert size={18} /><div><strong>The first mate is already running for this home somewhere else, probably in a terminal.</strong><span>Only one can run at a time, so this app is showing the fleet without it.</span>{holder && <small title={holder}>Another session holds this home.</small>}</div><button onClick={onCheck}>Check again</button></section>;
}

function StormBanner({ storm, onAsk, onRestart }: { storm: RewakeStorm; onAsk: () => void; onRestart: () => void }) {
  const minutes = Math.max(1, Math.round(storm.windowSecs / 60));
  return <section className="storm-banner"><CircleAlert size={18} /><div><strong>The first mate keeps getting woken up, {storm.turns} times in the last {minutes} minutes, and isn't settling. This uses up your Claude usage fast.</strong><span>Your messages still get through.</span></div><div><button onClick={onAsk}>Ask what's going on</button><button onClick={onRestart}>Restart the first mate</button></div></section>;
}

/** Never offers Stop: a health warning is about a first mate the captain wants running. */
function HostHealthBanner({ warning, onRestart }: { warning: HealthWarning; onRestart: () => void }) {
  const [open, setOpen] = useState(false);
  const hint = warning.kind === "session_limit"
    ? "The first mate can't reply until then. Try again after the reset."
    : warning.kind === "kill_refused" ? "Show details lists them. Restart the first mate if it isn't responding." : undefined;
  const hasActions = Boolean(warning.details) || warning.kind === "kill_refused";
  return <section className="offline-banner health-banner" role="alert" data-health-kind={warning.kind}><CircleAlert size={18} /><div><strong>{warning.message}</strong>{hint && <span>{hint}</span>}{open && warning.details && <pre className="banner-details">{warning.details}</pre>}</div>{hasActions && <div className="banner-actions">{warning.details && <button aria-expanded={open} onClick={() => setOpen((current) => !current)}>{open ? "Hide details" : "Show details"}</button>}{warning.kind === "kill_refused" && <button onClick={onRestart}>Restart</button>}</div>}</section>;
}

const KIND_NAMES: Record<string, string> = { scout: "Scout", ship: "Ship", secondmate: "Second mate", captain: "Call" };

/** Backlog body lines that are bookkeeping rather than anything a person wrote about the task. */
const BOOKKEEPING = /^(Captain hold set:|Resolution recorded by|Decision digest:|Resolution mode:|Captain decision:|Reconciliation evidence:|Answer key:|Answered by:|Answered via:)/;

/**
 * One task, led by what its worker is doing now. The snapshot carries the worker's latest note but not the
 * brief it was given, so the note is labelled as what it is. The worker's screen is kept, folded: its top is
 * the brief being delivered, which is plumbing, so it opens on its newest lines.
 */
function TaskDrawer({ task, title, record, now, artifacts, reviews, onOpenArtifact, onAskReport, fleetSchema, fleetGenerated, expanded, onCapture, onToggle, onClose }: { task: FleetTask; title: string; record?: BacklogRecord; now: number; artifacts: Artifact[]; reviews: ReviewSummary; onOpenArtifact: (artifact: Artifact) => void; onAskReport: () => void; fleetSchema: string; fleetGenerated: string; expanded: boolean; onCapture: (taskId: string) => Promise<{ text: string; observed_at?: string }>; onToggle: () => void; onClose: () => void }) {
  const [capture, setCapture] = useState<{ text: string; observed_at?: string } | null>(null);
  const [screenOpen, setScreenOpen] = useState(false);
  const screen = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let active = true;
    void onCapture(task.id).then((next) => { if (active) setCapture(next); });
    return () => { active = false; };
  }, [onCapture, task.id]);
  useLayoutEffect(() => {
    if (screenOpen && screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [screenOpen, capture]);
  const status = taskStatus(task.current_state.state);
  // The snapshot's own detail says more than the generic sentence for a state, when it has one.
  const statusDetail = plainDetail(task.current_state.detail ?? "") || status.summary;
  const lastEvent = task.paths.status_log.last_event;
  const started = startedAt(task, record);
  const backlogNotes = (record?.body_lines ?? []).map((line) => line.trim()).filter((line) => line && !BOOKKEEPING.test(line));
  const report = task.paths.report.present ? task.paths.report.path : null;
  // A scout reports and never opens a PR, and a task that stays on this machine is landed by the captain.
  const prApplies = task.kind === "ship" && task.mode !== "local-only";
  const timeline = [
    ...(started ? [{ key: "start", title: started.exact ? "Started" : "Filed", detail: `${KIND_NAMES[task.kind] ?? task.kind} · ${task.harness} · ${sinceLabel(started, now)}`, time: formatStart(started), icon: <GitBranch size={15} /> }] : []),
    // A finished worker's last note is usually its state's detail too, and says it once.
    ...(lastEvent.note && lastEvent.note !== statusDetail ? [{ key: "event", title: `Last update · ${stateLabel(lastEvent.state)}`, detail: lastEvent.note, time: "Latest", icon: <Radio size={15} /> }] : []),
    { key: "now", title: stateLabel(task.current_state.state), detail: statusDetail, time: formatTime(task.current_state.observed_at), icon: taskStatus(task.current_state.state, 15).icon },
  ];
  const captureText = capture?.text ?? `status: ${task.endpoint.status}\nbackend: ${task.backend}\nworker: ${task.endpoint.agent_alive}\nworktree: ${task.paths.worktree.present ? task.paths.worktree.path : "missing"}\nobserved: ${task.endpoint.observed_at}`;
  // The drawer is not modal: a press anywhere outside it closes it and still does what it was aimed at, so
  // a click on the sidebar or another task is never swallowed by the drawer going away.
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) close.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape); };
  }, []);
  return <div className="drawer-backdrop passive"><aside className="task-drawer" ref={panel}>
    <header className="drawer-header"><div><span>{projectName(task.project)}</span><h2 data-testid="drawer-title">{title}</h2><small className="drawer-id">{task.id}</small></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header>
    <div className="drawer-status"><span className={`task-state tone-${status.tone}`}>{status.icon}</span><div><strong className={`tone-${status.tone}`}>{stateLabel(task.current_state.state)}</strong>{statusDetail && <span>{statusDetail}</span>}</div>{started?.exact && <time className="drawer-age" data-testid="drawer-age" title={`Started ${formatStart(started)}`}>{formatDuration(now - started.ms)}</time>}</div>
    <div className="drawer-scroll">
      <DrawerSection title="Latest from the worker"><div className="brief-block"><p>{lastEvent.note || "The worker hasn't written a note yet."}</p>{backlogNotes.length > 0 && <dl><dt>Backlog</dt><dd>{backlogNotes.join(" ")}</dd></dl>}</div></DrawerSection>
      {artifacts.length > 0 && <DrawerSection title="Pages"><div className="drawer-pages">{artifacts.map((artifact) => <ArtifactRow key={artifact.name} artifact={artifact} detail={revisionLine(artifact)} review={reviews[artifactKey(artifact)]} landed={record?.state === "done"} onOpen={() => onOpenArtifact(artifact)} />)}</div></DrawerSection>}
      {report && artifacts.length === 0 && <DrawerSection title="Report"><div className="pr-block report-block"><span title={report}><FileText size={15} /> The report is written, without a page.</span><button className="landed-link" onClick={onAskReport}><MessageSquareText size={13} /> Ask the first mate for it</button></div></DrawerSection>}
      <DrawerSection title="Timeline"><div className="timeline">{timeline.map((item) => <div key={item.key}><span className="timeline-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span><time>{item.time}</time></div>)}</div></DrawerSection>
      {prApplies && <DrawerSection title="PR"><div className="pr-block">{task.pr.url ? <a href={task.pr.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {task.pr.url}</a> : <span><GitBranch size={15} /> No PR yet</span>}</div></DrawerSection>}
      <section className="drawer-section"><button className="fold-toggle" aria-expanded={screenOpen} onClick={() => setScreenOpen((open) => !open)}><ChevronRight size={14} className={screenOpen ? "rotated" : ""} /><h3>Worker's screen</h3><small>{capture?.observed_at ? `Updated ${formatTime(capture.observed_at)}` : "Updating…"}</small></button>
        {screenOpen && <><p className="worker-caption">Read-only, newest at the bottom. To change anything, tell the first mate.</p><div className="worker-screen"><header><TerminalSquare size={14} /><span>{task.endpoint.target}</span></header><pre ref={screen}>{captureText}</pre></div></>}
      </section>
      <button className="show-everything" onClick={onToggle}><ChevronDown size={16} className={expanded ? "rotated" : ""} /><span>Show everything</span></button>
      {expanded && <div className="machine-details"><dl><dt>Task</dt><dd>{task.id}</dd><dt>Branch</dt><dd>none recorded</dd><dt>Isolated copy</dt><dd>{task.paths.worktree.present ? task.paths.worktree.path : "missing"}</dd><dt>Worker runtime</dt><dd>{task.harness} on {task.backend}</dd><dt>Spawn</dt><dd>{task.spawn_gen ?? "not recorded"}</dd><dt>Status line</dt><dd>{task.current_state.raw}</dd><dt>Log</dt><dd>{lastEvent.raw}</dd>{report && <><dt>Report</dt><dd>{report}</dd></>}</dl><div className="step-chips"><span>Registered</span><span>{task.current_state.freshness}</span><span>Endpoint {task.endpoint.status}</span><span>PR {task.pr.source}</span><span>Report {task.paths.report.present ? "ready" : "none"}</span></div></div>}
    </div>
    <footer className="drawer-footer">From {fleetSchema} · {formatTime(fleetGenerated)}</footer>
  </aside></div>;
}

function sameArtifact(artifact: Artifact, ref: ArtifactRef) {
  return artifact.scope === ref.scope && artifact.task === ref.task && artifact.name === ref.name;
}

/** Who a page belongs to, in the captain's nouns: the project and task, or the conversation. */
function artifactOwner(artifact: Artifact, tasks: FleetTask[]) {
  if (artifact.scope === "chat" || !artifact.task) return "Shared in chat";
  const task = tasks.find((candidate) => candidate.id === artifact.task);
  return task ? `${projectName(task.project)} · ${artifact.task}` : artifact.task;
}

function revisionLine(artifact: Artifact) {
  const count = artifact.revisions.length;
  return `${count === 1 ? "Presented" : `Rev ${artifact.latest.rev}`} · ${formatWhen(artifact.latest.presented_at)}`;
}

/** Findings the presenter accepted are the page's own business until the captain looks; a skipped check is only a note. */
function layoutNote(revision: ArtifactRevision) {
  const issues = revision.layout?.status === "accepted" ? revision.layout.issues : [];
  if (issues.length === 0) return null;
  const narrowOnly = issues.every((issue) => issue.viewport === "narrow");
  return { issues, label: narrowOnly ? "May look off in a narrow window" : "May look off", narrowOnly };
}

/**
 * What a page's review says about it in one chip: unsent work first, then what
 * is new, then what is waiting. A landed page says none of that, since nothing
 * on it is waiting on anyone any more; your own unsent words still show, because
 * they are yours and would otherwise disappear without being read.
 */
function reviewChip(review?: ReviewSummary[string], artifact?: Artifact, landed = false) {
  if (!artifact) return null;
  if (review && review.draft_count > 0) return { label: review.draft_count === 1 ? "1 comment not sent" : `${review.draft_count} comments not sent`, tone: "draft" };
  if (landed) return null;
  const seen = review?.seen_rev ?? null;
  if (seen === null) return { label: "Not looked at yet", tone: "new" };
  if (artifact.latest.rev > seen) return { label: `Rev ${artifact.latest.rev} is new`, tone: "new" };
  const { waiting, answered } = openComments(artifact, review);
  if (answered.length > 0) return { label: answered.length === 1 ? "1 comment answered" : `${answered.length} comments answered`, tone: "new" };
  if (waiting.length > 0) return { label: waiting.length === 1 ? "1 comment waiting" : `${waiting.length} comments waiting`, tone: "open" };
  return null;
}

/** What the author says each later revision does about the captain's comments: their claim, by thread. */
function authorAnswers(artifact: Artifact) {
  const found: Record<string, { rev: number; reply?: string }> = {};
  for (const item of artifact.revisions) {
    for (const id of item.answers?.addressed ?? []) found[id] = { ...found[id], rev: item.rev };
    for (const reply of item.answers?.replies ?? []) found[reply.thread] = { rev: item.rev, reply: reply.body };
  }
  return found;
}

/**
 * The captain's open comments, split by whose move they are: one a later revision changed or replied to
 * is answered and waits on the captain to settle or reply; the rest wait on the author.
 */
function openComments(artifact: Artifact, review?: ReviewSummary[string]) {
  const answers = authorAnswers(artifact);
  const open = review?.open_threads ?? [];
  const answered = open.filter((thread) => (answers[thread.id]?.rev ?? 0) > thread.rev).map((thread) => thread.id);
  // An older app's summary counts open comments without naming them; those can only be read as waiting.
  const waiting = open.length > 0 || !review ? open.filter((thread) => !answered.includes(thread.id)).map((thread) => thread.id) : Array.from({ length: review.open_count }, (_, index) => `open-${index}`);
  return { waiting, answered };
}

function ArtifactRow({ artifact, detail, review, landed, onOpen }: { artifact: Artifact; detail: string; review?: ReviewSummary[string]; landed?: boolean; onOpen: () => void }) {
  const note = layoutNote(artifact.latest);
  const chip = reviewChip(review, artifact, landed);
  return <button className="artifact-row" onClick={onOpen}><span className="artifact-icon"><PanelsTopLeft size={16} /></span><span className="artifact-copy"><strong>{artifact.title}</strong><small>{detail}</small></span><span className="artifact-chips">{chip && <span className={`review-chip ${chip.tone}`}>{chip.label}</span>}{note && <span className="artifact-flag" title={note.issues.map((issue) => issue.detail).join("\n")}>{note.label}</span>}</span><ChevronRight size={17} /></button>;
}

function artifactKey(artifact: Artifact) {
  return artifact.scope === "chat" ? `chat/${artifact.name}` : `task/${artifact.task}/${artifact.name}`;
}

/** Where a page stands: who the next move belongs to. */
export type ArtifactStanding = "needs-you" | "discussion" | "settled";

/**
 * Which of the three the page belongs in.
 *
 * The backlog owns whether a task landed, so a page files itself away when its
 * work is done rather than waiting for anyone to archive it. Everything before
 * that is a question of whose move it is: unread, revised, half-written, or
 * arguing a call still waiting on the captain means the move is yours; anything
 * else that is still going belongs with its author.
 */
export function artifactStanding(artifact: Artifact, review: ReviewSummary[string] | undefined, backlog: Map<string, BacklogRecord>, calls: Call[]): ArtifactStanding {
  const task = artifact.scope === "task" ? artifact.task : null;
  if (task && backlog.get(task)?.state === "done") return "settled";
  if (review && review.draft_count > 0) return "needs-you";
  const comments = openComments(artifact, review);
  const argued = callsArguedBy(calls, artifact);
  // A call this page argues: yours until you answer it, then firstmate's until its records catch up.
  const waiting = argued.filter(isOpen);
  // A chat page that argued calls exists for them, so once every one is closed it has done its work,
  // read or not, unless a comment on it is still going back and forth.
  if (!task && argued.length > 0 && waiting.length === 0 && comments.waiting.length === 0 && comments.answered.length === 0) return "settled";
  const seen = review?.seen_rev ?? null;
  if (seen === null || artifact.latest.rev > seen) return "needs-you";
  const answered = review?.answered ?? [];
  if (waiting.some((call) => !answered.includes(call.id))) return "needs-you";
  // The author answered a comment: settling it or replying is the captain's move.
  if (comments.answered.length > 0) return "needs-you";
  if (waiting.length > 0) return "discussion";
  if (comments.waiting.length > 0) return "discussion";
  // A chat page has no work to finish, so once it is read and quiet it is done.
  return task ? "discussion" : "settled";
}

const STANDINGS: { id: ArtifactStanding; title: string; blank: string }[] = [
  { id: "needs-you", title: "Needs you", blank: "Nothing needs you right now." },
  { id: "discussion", title: "In discussion", blank: "" },
  { id: "settled", title: "Settled", blank: "" },
];

function ArtifactsView({ artifacts, tasks, reviews, backlog, calls, onOpen }: { artifacts: Artifact[]; tasks: FleetTask[]; reviews: ReviewSummary; backlog: Map<string, BacklogRecord>; calls: Call[]; onOpen: (artifact: Artifact) => void }) {
  const [openSettled, setOpenSettled] = useState(false);
  const groups = useMemo(() => {
    const out = new Map<ArtifactStanding, Artifact[]>(STANDINGS.map((standing) => [standing.id, []]));
    for (const artifact of artifacts) out.get(artifactStanding(artifact, reviews[artifactKey(artifact)], backlog, calls))!.push(artifact);
    return out;
  }, [artifacts, reviews, backlog, calls]);

  const row = (artifact: Artifact, landed: boolean) => <ArtifactRow
    key={`${artifact.scope}/${artifact.task}/${artifact.name}`}
    artifact={artifact}
    detail={`${artifactOwner(artifact, tasks)} · ${revisionLine(artifact)}`}
    review={reviews[artifactKey(artifact)]}
    landed={landed}
    onOpen={() => onOpen(artifact)}
  />;

  return <div className="content-scroll artifacts-page" data-screen="artifacts">
    {artifacts.length === 0
      ? <EmptyState label="Nothing to look at yet. When the first mate or a worker shares a page, it shows up here." />
      : STANDINGS.map((standing) => {
        const pages = groups.get(standing.id) ?? [];
        if (pages.length === 0) return standing.blank ? <EmptyState key={standing.id} label={standing.blank} /> : null;
        // Settled pages keep piling up, so they stay folded away until asked for.
        const folded = standing.id === "settled" && !openSettled;
        return <section key={standing.id} className="artifact-group" data-standing={standing.id}>
          {standing.id === "settled"
            ? <button className="artifact-group-heading" aria-expanded={openSettled} onClick={() => setOpenSettled((open) => !open)}>
                <h2>{standing.title}</h2><span className="section-count">{pages.length}</span>{openSettled ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
            : <div className="artifact-group-heading static"><h2>{standing.title}</h2><span className="section-count">{pages.length}</span></div>}
          {!folded && <div className="task-list artifact-list">{pages.map((artifact) => row(artifact, standing.id === "settled"))}</div>}
        </section>;
      })}
  </div>;
}

function ArtifactChatCard({ artifact, revision, tasks, onOpen }: { artifact: Artifact; revision: ArtifactRevision; tasks: FleetTask[]; onOpen: () => void }) {
  const from = revision.presented_by.role === "firstmate" ? "The first mate shared a page" : `${artifactOwner(artifact, tasks)} ${revision.rev === 1 ? "shared a page" : `revised a page · Rev ${revision.rev}`}`;
  return <article className="artifact-card" data-testid="artifact-card"><span className="artifact-icon"><PanelsTopLeft size={16} /></span><div><small>{from}</small><strong>{revision.title}</strong>{revision.note && <p>{revision.note}</p>}<time>{formatWhen(revision.presented_at)}</time></div><button onClick={onOpen}>Open</button></article>;
}

/**
 * What the page's script says, taken only as far as it can be trusted.
 *
 * The page is someone else's HTML running in the frame, so whatever it posts is
 * read as data of a known shape: strings, capped, and nothing else. A comment's
 * anchor is only ever words and where they sit; a diagram is only ever a file
 * name beside the page, the same rule the review applies when it is saved.
 */
function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function pageAnchor(value: unknown): ReviewAnchor | null {
  if (!value || typeof value !== "object") return null;
  const anchor = value as Record<string, unknown>;
  const quote = text(anchor.quote, 400);
  if (!quote.trim()) return null;
  return { quote, prefix: text(anchor.prefix, 200), suffix: text(anchor.suffix, 200), path: text(anchor.path, 600) };
}

function sceneFileOk(file: string) {
  return file.length > 0 && !file.includes("/") && !file.includes("\\") && !file.startsWith(".");
}

function pagePlace(value: unknown): ScenePlace | null {
  if (!value || typeof value !== "object") return null;
  const place = value as Record<string, unknown>;
  const file = text(place.file, 200);
  if (!sceneFileOk(file)) return null;
  return { file, label: text(place.label, 120) || "Diagram", path: text(place.path, 600) };
}

/** Threads for a review not read yet: one array, so effects keyed on it do not fire every render. */
const NO_THREADS: ReviewThread[] = [];

const VERDICTS: { id: ReviewVerdict; label: string }[] = [
  { id: "changes", label: "Request changes" },
  { id: "approve", label: "Approve" },
  { id: "comment", label: "Comment" },
];

/** What a review of this page can hold up, which decides the verdict it starts on and what each verdict says. */
type ReviewStake = { verdict: ReviewVerdict; hints: Record<ReviewVerdict, string> };

const LIVE_STATES = new Set(["working", "blocked", "parked", "paused", "unknown"]);

/**
 * Whether the page genuinely gates live work. Only then does a review start on Request changes: a page whose
 * task has finished or landed, a scout's report that argues no call, or a chat page with no open call holds
 * nothing up, so it starts on Comment, and every hint says what the verdict does for this page, not in general.
 */
function reviewStake(artifact: Artifact, tasks: FleetTask[], backlog: Map<string, BacklogRecord>, known: Call[], staged: string[] = []): ReviewStake {
  const calls = callsArguedBy(known, artifact).filter(isOpen);
  const taskId = artifact.scope === "task" ? artifact.task : null;
  const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : undefined;
  const quiet = (reason: string): ReviewStake => ({
    verdict: "comment",
    hints: { changes: `Asks for another revision. ${reason}`, approve: `Says it reads well. ${reason}`, comment: `Thoughts only. ${reason}` },
  });
  // A call this page argues waits on it whatever became of the task that wrote it: a finished
  // scout's report is often exactly the argument an open call is decided from.
  // Once every call this page argues has an answer waiting to go, the captain has decided from the case as argued.
  if (calls.length > 0 && calls.every((call) => staged.includes(call.id))) {
    return { verdict: "approve", hints: { approve: "The case reads well, and your answer is recorded as it is sent.", changes: "Asks for another revision; your answer is still recorded as it is sent.", comment: "Thoughts only; your answer is still recorded as it is sent." } };
  }
  if (calls.length > 0) {
    return { verdict: "changes", hints: { changes: "The first mate revises the case before you decide.", approve: "The case reads well as it is argued.", comment: "Thoughts only; the call stays open until you answer it." } };
  }
  if (!taskId) return quiet("Nothing is waiting on this page.");
  if (backlog.get(taskId)?.state === "done") return quiet("Its task has already landed, so nothing waits on this page.");
  if (!task || !LIVE_STATES.has(task.current_state.state)) return quiet("Its task has finished, so nothing waits on this page.");
  if (calls.length === 0 && task.kind === "scout") return quiet("The scout carries on either way; this page argues no call.");
  return { verdict: "changes", hints: { changes: "The task keeps waiting on this page.", approve: "The work on this page can go ahead.", comment: "Thoughts only; the task goes on without waiting." } };
}

/**
 * The picture a proposal made of a diagram, served from beside the review rather
 * than from inside a revision, since the captain drew it rather than the author.
 */
function proposalPicture(thread: ReviewThread, url: string) {
  const anchor = thread.anchor as { scene?: string; picture?: string | null; preview?: string } | null;
  if (!anchor?.scene || !anchor.picture) return undefined;
  // The browser mock has no home to serve from, so it carries the picture itself.
  if (anchor.preview) return anchor.preview;
  const base = url.slice(0, url.lastIndexOf("/rev-"));
  return `${base}/review-files/${encodeURIComponent(anchor.picture.split("/").at(-1) ?? "")}`;
}

/** The words a thread is pinned to, for the rail. */
function threadQuote(thread: ReviewThread) {
  const quote = thread.anchor?.quote?.trim();
  return quote ? (quote.length > 140 ? `${quote.slice(0, 140)}…` : quote) : "the page";
}

/**
 * The page itself, in a frame that can run its scripts and reach the network but never the app or the home.
 * Narrow shows it at the width firstmate's layout check calls narrow. In Comment mode the page's own script
 * turns a selection or a block into a place, and what the captain writes stays a draft until the review is sent.
 */
function ArtifactReview({ artifact, revision, url, review, stake, sendReady, runtime, calls, onRevision, onComment, onDiscard, onSubmit, onSettle, onSeen, onAnswer, onScene }: {
  artifact: Artifact;
  revision: ArtifactRevision;
  url: string;
  review: ReviewView | null;
  stake: ReviewStake;
  sendReady: boolean;
  runtime: HostRuntimeState;
  onRevision: (rev: number) => void;
  onComment: (body: string, anchor?: ReviewAnchor, thread?: string) => Promise<unknown>;
  onDiscard: (thread: string) => Promise<unknown>;
  /** Resolves to a warning when the review went only partly: answers recorded, message not sent. */
  onSubmit: (verdict: ReviewVerdict) => Promise<string | undefined>;
  onSettle: (thread: string, resolved: boolean) => Promise<unknown>;
  onSeen: (rev: number) => Promise<unknown>;
  /** Every call whose evidence contains this page. */
  calls: Call[];
  onAnswer: (call: Call, option?: string, label?: string) => Promise<unknown>;
  onScene: (place: ScenePlace, proposal: SceneProposal) => Promise<unknown>;
}) {
  const [narrow, setNarrow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [pending, setPending] = useState<ReviewAnchor | null>(null);
  const [draft, setDraft] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [scenes, setScenes] = useState<ScenePlace[]>([]);
  const [openScene, setOpenScene] = useState<{ place: ScenePlace; scene: { elements: never[] } } | null>(null);
  const [sceneProblem, setSceneProblem] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ReviewVerdict>(stake.verdict);
  // The verdict follows what the page is waiting on (an answer staged turns it to Approve) until the captain picks one.
  const [verdictChosen, setVerdictChosen] = useState(false);
  useEffect(() => {
    if (!verdictChosen) setVerdict(stake.verdict);
  }, [stake.verdict, verdictChosen]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const note = layoutNote(revision);
  const newest = [...artifact.revisions].reverse();
  const threads = review?.threads ?? NO_THREADS;
  const draftCount = review?.draft_count ?? 0;
  const lastSent = review?.sent.at(-1);
  const seen = review?.seen_rev ?? null;

  // Looking at a revision is what makes a later one read as new.
  useEffect(() => {
    if (review && (seen === null || seen < revision.rev)) void onSeen(revision.rev);
  }, [review, seen, revision.rev]);

  // What the author says a later revision does about each comment. Their claim, shown as theirs.
  const answers = useMemo(() => authorAnswers(artifact), [artifact]);
  const settled = threads.filter((thread) => thread.state === "resolved");
  const live = threads.filter((thread) => thread.state !== "resolved");
  const [showSettled, setShowSettled] = useState(false);

  const tell = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, "*");

  // Everything the page needs to draw: which threads to highlight, and whether a click picks a place.
  useEffect(() => {
    if (!loaded) return;
    tell({ type: "qd:threads", threads: threads.map((thread) => ({ id: thread.id, anchor: thread.anchor, draft: thread.sent_at === null })) });
  }, [loaded, threads]);
  useEffect(() => {
    if (loaded) tell({ type: "qd:mode", mode: commenting ? "comment" : "read" });
  }, [loaded, commenting]);

  // The page may only pick a place while the captain has asked to pick one.
  const commentingNow = useRef(commenting);
  commentingNow.current = commenting;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (data.type === "qd:picked") {
        const anchor = commentingNow.current ? pageAnchor(data.anchor) : null;
        if (!anchor) return;
        setPending(anchor);
        setCommenting(false);
      } else if (data.type === "qd:located") {
        const found = Array.isArray(data.missing) ? data.missing.filter((id): id is string => typeof id === "string") : [];
        setMissing((current) => current.join("\n") === found.join("\n") ? current : found);
      } else if (data.type === "qd:scenes") {
        const found = Array.isArray(data.scenes) ? data.scenes.map(pagePlace).filter((place): place is ScenePlace => place !== null) : [];
        setScenes((current) => JSON.stringify(current) === JSON.stringify(found) ? current : found);
      } else if (data.type === "qd:scene-open") {
        const place = commentingNow.current ? pagePlace(data.scene) : null;
        if (place) void openDiagram(place);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** The page's own scene file, read through the same scheme that serves the page. */
  async function openDiagram(place: ScenePlace) {
    setCommenting(false);
    setSceneProblem(null);
    if (!sceneFileOk(place.file)) {
      setSceneProblem("That diagram could not be opened: its scene file has to sit beside the page.");
      return;
    }
    try {
      const base = url.slice(0, url.lastIndexOf("/") + 1);
      const response = await fetch(base + encodeURIComponent(place.file));
      if (!response.ok) throw new Error(`the diagram file is not in this revision (${response.status})`);
      setOpenScene({ place, scene: await response.json() });
    } catch (error) {
      setSceneProblem(`That diagram could not be opened: ${String(error)}`);
    }
  }

  async function save() {
    const body = draft.trim();
    if (!body || !pending) return;
    setProblem(null);
    try {
      await onComment(body, pending);
      setDraft("");
      setPending(null);
    } catch (error) {
      setProblem(String(error));
    }
  }

  async function send() {
    setSending(true);
    setProblem(null);
    try {
      const warning = await onSubmit(verdict);
      if (warning) setProblem(warning);
    } catch (error) {
      setProblem(String(error));
    } finally {
      setSending(false);
    }
  }

  const sendHint = !sendReady
    ? "Start the first mate to send your review."
    : runtime === "locked_by_other"
      ? "The first mate is running somewhere else. Your review waits until it runs here."
      : stake.hints[verdict];

  return <div className="artifact-review" data-screen="artifact">
    <div className="artifact-toolbar">
      <label className="revision-picker"><span className="sr-only">Revision</span><select value={revision.rev} onChange={(event) => onRevision(Number(event.target.value))}>{newest.map((item) => <option key={item.rev} value={item.rev}>{`Rev ${item.rev}${item.rev === artifact.latest.rev ? " · latest" : ""}${seen !== null && item.rev > seen ? " · new" : ""} · ${formatWhen(item.presented_at)}`}</option>)}</select><ChevronDown size={14} /></label>
      {/* While commenting, the hint takes the note's place in the toolbar, so the page under the pointer never moves. */}
      {commenting
        ? <p className="revision-note commenting" role="status">Select the words you mean, or click a part of the page{scenes.length > 0 ? ". A diagram opens for you to change" : ""}.</p>
        : revision.note ? <p className="revision-note" title={revision.note}><strong>What changed</strong> {revision.note}</p> : <span className="revision-note" />}
      {artifact.latest.rev > revision.rev && <button className="newer-revision" onClick={() => onRevision(artifact.latest.rev)} title={artifact.latest.note ?? undefined}>Rev {artifact.latest.rev} is new · Open</button>}
      {note && <button className={`layout-flag ${findingsOpen ? "open" : ""}`} aria-expanded={findingsOpen} onClick={() => setFindingsOpen((current) => !current)}><CircleAlert size={14} /> {note.label}</button>}
      <button className={`comment-toggle ${commenting ? "selected" : ""}`} aria-pressed={commenting} onClick={() => { setCommenting((current) => !current); setPending(null); }} title="Comment on a part of the page"><MessageSquarePlus size={15} /> Comment</button>
      {scenes.length > 0 && <button className="scene-open" onClick={() => void openDiagram(scenes[0])} title={`Change ${scenes[0].label}`}><Shapes size={15} /> {scenes.length === 1 ? "Diagram" : `${scenes.length} diagrams`}</button>}
      <div className="width-toggle" role="group" aria-label="Window width"><button className={narrow ? "" : "selected"} aria-pressed={!narrow} onClick={() => setNarrow(false)} title="Wide"><Monitor size={15} /></button><button className={narrow ? "selected" : ""} aria-pressed={narrow} onClick={() => setNarrow(true)} title="Narrow"><Smartphone size={15} /></button></div>
    </div>
    {note && findingsOpen && <div className="layout-findings" role="note"><p>When it was presented, firstmate's check found {note.issues.length === 1 ? "this" : "these"}, and the presenter kept the page as it is.</p><ul>{note.issues.map((issue, index) => <li key={index}><strong>{issue.viewport === "narrow" ? "Narrow" : "Wide"}</strong> {issue.detail}<code>{issue.selector}</code></li>)}</ul></div>}
    {sceneProblem && <div className="comment-hint problem" role="alert">{sceneProblem}</div>}
    <div className="artifact-body">
      <div className={`artifact-stage ${narrow ? "narrow" : ""}`}>
        {!loaded && <div className="artifact-loading">Opening the page…</div>}
        <iframe ref={frame} title={revision.title} src={url} sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" onLoad={() => { setLoaded(true); setMissing([]); }} />
      </div>
      <aside className="review-rail" aria-label="Your review">
        {pending && <section className="comment-composer">
          <blockquote>{pending.quote.length > 160 ? `${pending.quote.slice(0, 160)}…` : pending.quote}</blockquote>
          <textarea autoFocus value={draft} placeholder="What should change here?" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save(); if (event.key === "Escape") { setPending(null); setDraft(""); } }} />
          <div><button className="ghost" onClick={() => { setPending(null); setDraft(""); }}>Cancel</button><button disabled={!draft.trim()} onClick={() => void save()}>Comment</button></div>
        </section>}
        {calls.length > 0 && <div className="decision-answers">
          {calls.map((call) => <RailCall key={call.id} call={call} revision={revision} chosen={review?.answers.find((answer) => answer.decision === call.id)} onAnswer={(option, label) => onAnswer(call, option, label)} />)}
        </div>}
        <div className="review-threads">
          {threads.length === 0 && !pending && calls.length === 0 && <p className="review-empty">Nothing written yet. Use Comment to write on a part of the page, then send it all at once.</p>}
          {live.map((thread) => <ReviewThreadCard key={thread.id} thread={thread} answer={answers[thread.id]} rev={revision.rev} missing={missing.includes(thread.id)} picture={proposalPicture(thread, url)} onFocus={() => tell({ type: "qd:focus", id: thread.id })} onDiscard={() => void onDiscard(thread.id)} onSettle={(resolved) => void onSettle(thread.id, resolved)} />)}
          {settled.length > 0 && <button className="settled-toggle" aria-expanded={showSettled} onClick={() => setShowSettled((current) => !current)}><ChevronRight size={13} className={showSettled ? "rotated" : ""} /> {settled.length} settled</button>}
          {showSettled && settled.map((thread) => <ReviewThreadCard key={thread.id} thread={thread} answer={answers[thread.id]} rev={revision.rev} missing={missing.includes(thread.id)} picture={proposalPicture(thread, url)} onFocus={() => tell({ type: "qd:focus", id: thread.id })} onDiscard={() => void onDiscard(thread.id)} onSettle={(resolved) => void onSettle(thread.id, resolved)} />)}
        </div>
        <div className="review-send">
          {problem && <p className="review-problem" role="alert">{problem}</p>}
          {lastSent && draftCount === 0 && <p className="review-last">Sent {formatWhen(new Date(lastSent.at).toISOString())} · {VERDICTS.find((item) => item.id === lastSent.verdict)?.label ?? lastSent.verdict}</p>}
          <label className="verdict-picker"><span className="sr-only">Verdict</span><select value={verdict} onChange={(event) => { setVerdictChosen(true); setVerdict(event.target.value as ReviewVerdict); }}>{VERDICTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><ChevronDown size={14} /></label>
          <button className="send-review" disabled={!sendReady || sending} title={sendHint} onClick={() => void send()}><Send size={15} /> {sending ? "Sending…" : draftCount > 0 ? `Send review · ${draftCount}` : "Send review"}</button>
          <small>{sendHint}</small>
        </div>
      </aside>
    </div>
    {openScene && <Suspense fallback={<div className="scene-backdrop"><div className="scene-loading">Opening the diagram…</div></div>}>
      <SceneEditor place={openScene.place} scene={openScene.scene} onClose={() => setOpenScene(null)} onPropose={(proposal) => onScene(openScene.place, proposal)} />
    </Suspense>}
  </div>;
}

/**
 * A call this page argues, in the review rail. Open, it offers the call's own options; a choice is staged with the
 * review and recorded through firstmate's intake as the review goes. Answered anywhere, it says by whom and how,
 * instead of offering choices that could no longer do anything.
 */
function RailCall({ call, revision, chosen, onAnswer }: { call: Call; revision: ArtifactRevision; chosen?: ReviewView["answers"][number]; onAnswer: (option?: string, label?: string) => Promise<unknown> }) {
  const recorded = chosen?.recorded?.result === "closed";
  const refused = chosen?.recorded && !recorded ? chosen.recorded : null;
  // Sent before the app recorded answers itself: the first mate was asked to record it.
  const handedOver = chosen !== undefined && chosen.sent_at !== null && !chosen.recorded;
  const locked = recorded || handedOver;
  const updated = !call.answer && optionsUpdatedSince(call, revision.presented_at);
  const when = (at: number) => formatWhen(new Date(at).toISOString());
  return <section className="decision-answer" data-testid="decision-answer" data-call-id={call.id}>
    <header><span>Your call</span><small>{call.id}</small></header>
    {call.question && <p>{call.question}</p>}
    {updated && <small className="decision-updated" data-testid="options-updated">Options updated since rev {revision.rev}</small>}
    {call.answer
      ? <p className="decision-answered" data-testid="call-answered"><Check size={13} /><span>{answeredBy(call.answer)}: <strong>{call.answer.label}</strong></span></p>
      : call.options.length === 0
        ? <small className="decision-missing">This page argues a call whose options are not recorded. Answer it in chat.</small>
        : <div className="decision-choices">{call.options.map((option) => {
            const picked = chosen?.option === option.key && !refused;
            return <button key={option.key} className={picked ? "picked" : ""} aria-pressed={picked} disabled={locked} onClick={() => void onAnswer(picked ? undefined : option.key, option.label)}>
              <span>{option.label}</span>{option.recommended && <small>Recommended</small>}
            </button>;
          })}</div>}
    {!call.answer && chosen && (refused
      ? <small className="decision-refused" role="alert">Not recorded: {refused.detail}</small>
      : recorded
        ? <small className="decision-sent">Recorded {when(chosen.recorded!.at)}</small>
        : handedOver
          ? <small className="decision-sent">Sent {when(chosen.sent_at!)}</small>
          : <small className="decision-staged">Goes with your review, and is recorded as it is sent</small>)}
  </section>;
}

/**
 * One place on the page the captain wrote about, with what the author says about it.
 * The author's answer is their claim; settling it is the captain's, and stays reversible.
 */
function ReviewThreadCard({ thread, answer, rev, missing, picture, onFocus, onDiscard, onSettle }: { thread: ReviewThread; answer?: { rev: number; reply?: string }; rev: number; missing: boolean; picture?: string; onFocus: () => void; onDiscard: () => void; onSettle: (resolved: boolean) => void }) {
  const draft = thread.sent_at === null;
  // An author can only answer a comment they were sent, so a draft never shows one.
  const answered = answer && !draft && answer.rev > thread.rev;
  return <article className={`review-thread ${draft ? "draft" : thread.state}`} data-testid="review-thread" data-state={thread.state} onClick={onFocus}>
    <header>
      <span className="thread-id">{thread.id}</span>
      {draft
        ? <em className="thread-state draft">Not sent yet</em>
        : thread.state === "resolved"
          ? <em className="thread-state settled">Settled</em>
          : <em className="thread-state">Sent {formatWhen(new Date(thread.sent_at!).toISOString())}</em>}
      {draft
        ? <button className="icon-button" title="Take this comment back" onClick={(event) => { event.stopPropagation(); onDiscard(); }}><Trash2 size={14} /></button>
        : <button className="icon-button" title={thread.state === "resolved" ? "Open this again" : "Settle this"} onClick={(event) => { event.stopPropagation(); onSettle(thread.state !== "resolved"); }}>{thread.state === "resolved" ? <RotateCcw size={14} /> : <CheckCheck size={14} />}</button>}
    </header>
    <blockquote>{threadQuote(thread)}</blockquote>
    {picture && <img className="thread-picture" src={picture} alt={`The diagram as you proposed it: ${threadQuote(thread)}`} />}
    {thread.comments.map((comment, index) => <p key={index}>{comment.body}</p>)}
    {answered && <div className="thread-answer"><strong>{answer.reply ? `Answered in rev ${answer.rev}` : `Changed in rev ${answer.rev}`}</strong>{answer.reply && <p>{answer.reply}</p>}</div>}
    {missing && <small className="thread-missing">Not found in this revision.</small>}
    {thread.rev !== rev && <small className="thread-rev">Written on rev {thread.rev}</small>}
  </article>;
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="drawer-section"><h3>{title}</h3>{children}</section>;
}

/** A time today, otherwise the date too. */
function formatWhen(value: string) {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) return formatTime(value);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
