import {
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
  ListPlus,
  Menu,
  MessageSquarePlus,
  MessageSquareText,
  Monitor,
  Moon,
  PanelsTopLeft,
  Paperclip,
  Radio,
  RefreshCw,
  Search,
  Settings,
  ShieldQuestion,
  ShipWheel,
  Smartphone,
  Trash2,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { type Artifact, type ArtifactRef, type ArtifactRevision, type BacklogRecord, type Call, createHostAdapter, type ProjectHistory, type IntakeResult, type Landed, type FleetTask, type HostRuntimeState, type Needed, type ReasonKind, type SentReview, type SentThread, type CommentPicture, type PageBox, type PagePicture, type PictureReason, type ReviewAnchor, type ReviewSummary, type ReviewThread, type AnswerWords, type ReviewVerdict, type ReviewView, type TaskFile, type TaskNote } from "./host";
import { Camera, CameraOff, CheckCheck, RotateCcw, Shapes } from "lucide-react";
import { type Attachment, formatBytes, type PickedFile, splitAttachments, withAttachments } from "./attachments";
import { type BodyBlock, bodyBlocks, type Span } from "./taskbody";
import { callProject, filterLog, landedWithin, type LogEntry, logCounts, logEntries, type LogFilter, logPeriods, outcomeLine, shortDay, upNext } from "./logbook";
import { answeredBy, answeredByCaptain, answerInWords, argumentOf, callsArguedBy, decidedForCaptain, type Evidence, homeCalls, isOpen, linkLabel, openCalls, optionsUpdatedSince, recommended, resolveEvidence } from "./calls";
import { latestTime, pagePlaces } from "./chatorder";
import type { ScenePlace, SceneProposal } from "./SceneEditor";
import { RoutingSettings } from "./Routing";

/** Excalidraw is a few megabytes, so nothing of it loads until a diagram is opened. */
const SceneEditor = lazy(() => import("./SceneEditor").then((module) => ({ default: module.SceneEditor })));
import { type ChatMessage, type HealthWarning, type OutboxView, type PermissionView, type RewakeStorm, type SnapshotHealth, useHost } from "./host/use-host";
import { useQuota } from "./host/use-quota";
import { useUpdate } from "./host/use-update";
import { UpdateNotice } from "./UpdateNotice";
import { Usage } from "./UsagePanel";

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
  const quota = useQuota(host);
  const appUpdate = useUpdate(host);
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
  /** Files picked for the message being written, copied into the home only as it is sent, and what could not be attached, in the host's words. */
  const [chatFiles, setChatFiles] = useState<PickedFile[]>([]);
  const [attachProblems, setAttachProblems] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [copying, setCopying] = useState(false);
  // Files picked while one home was chosen are not carried into another.
  useEffect(() => {
    setChatFiles([]);
    setAttachProblems([]);
  }, [bridge.home]);
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
  // A queued row is kept by id, so its drawer reads each new snapshot's row rather than the one it opened with.
  const [queuedId, setQueuedId] = useState<string | null>(null);
  useEffect(() => setQueuedId(null), [view, selectedProject]);
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

  // A page never shows another page's review, even for the render before its own is read.
  const reviewKey = artifactRef ? `${artifactRef.scope}/${artifactRef.task}/${artifactRef.name}` : null;
  const [reviewFor, setReviewFor] = useState(reviewKey);
  if (reviewFor !== reviewKey) {
    setReviewFor(reviewKey);
    setReview(null);
  }
  // The review is read from the home when a page opens, so a draft written before a relaunch is still there.
  useEffect(() => {
    if (!artifactRef) return;
    let active = true;
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
  // Everything waiting on the captain: open calls, and finished reports nobody has closed.
  const openCallCount = waiting.length + readyReports.length;
  const shownCalls = shownArtifact ? callsArguedBy(calls, shownArtifact).filter(isOpen) : [];
  const subtitle = view === "project" && selectedProjectData ? selectedProjectData.posture
    : view === "chat" ? "You and the first mate"
    : view === "bearings" ? (bearings ? `Everything the fleet is doing${openCallCount ? `, and the ${countWord(openCallCount, "thing")} that ${openCallCount === 1 ? "wants" : "want"} your word` : ""}` : "")
    : view === "artifacts" ? "What the crew wrote for you to read"
    : view === "artifact" ? (shownArtifact && shownRevision ? `${artifactOwner(shownArtifact, fleet?.tasks ?? [])} · Rev ${shownRevision.rev} of ${shownArtifact.revisions.length}${shownCalls.length ? " · a decision rides on this" : ""}` : "")
    : capitalize(`${countWord(projects.length, "project")} under command`);
  // When the snapshot on screen was read, for a captain who wants to know how fresh Bearings is.
  const subtitleTitle = view === "bearings" && bearings ? `As of ${formatTime(bearings.generated)}` : undefined;
  // A home nothing has happened in yet: the app built it on this launch, or the
  // captain pointed at an empty one. "Welcome back" and an offer to catch them
  // up read strangely to someone who has not been anywhere yet.
  const nothingYet = openCallCount === 0 && underway.length === 0 && landedRows.length === 0
    && decided.length === 0 && projects.length === 0 && (fleet?.tasks.length ?? 0) === 0;
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

  /** Settles comments from their review's card in chat, then reads the summary again so the card follows. */
  async function settleFromChat(ref: ArtifactRef, threads: string[]) {
    try {
      for (const thread of threads) await host.reviewSettle(ref, thread, true);
    } finally {
      await host.reviewSummary().then(setReviews, () => undefined);
    }
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
    // Keep the draft: it can go once the first mate has started in this folder.
    if ((!chatDraft.trim() && chatFiles.length === 0) || !bridge.sendReady || copying) return;
    let attached: Attachment[] = [];
    if (chatFiles.length > 0) {
      setCopying(true);
      try {
        const result = await host.copyFiles(chatFiles.map((file) => file.source));
        // A file that cannot go holds the whole message back, words and files kept, so nothing goes without it.
        if (result.refused.length > 0) return setAttachProblems(result.refused.map((item) => item.problem));
        attached = result.attached;
      } catch (error) {
        return setAttachProblems([`The files could not be attached: ${String(error)}`]);
      } finally {
        setCopying(false);
      }
    }
    const message = withAttachments(chatDraft, attached);
    setChatDraft("");
    setChatFiles([]);
    setAttachProblems([]);
    await bridge.send(message);
  }

  /** Asks for files to go with the message. Cancelling the picker changes nothing. */
  async function attachToChat() {
    setAttaching(true);
    try {
      const result = await host.pickFiles();
      if (!result) return;
      // Picking a file again replaces it, so it goes once.
      setChatFiles((current) => [...current.filter((kept) => !result.picked.some((file) => file.source === kept.source)), ...result.picked]);
      setAttachProblems(result.refused.map((item) => item.problem));
    } catch (error) {
      setAttachProblems([`The files could not be attached: ${String(error)}`]);
    } finally {
      setAttaching(false);
    }
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
        <div className="brand-row">
          <div className="brand-mark">Q</div>
          <div><strong>Quarterdeck</strong><span>firstmate · desktop</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileNavOpen(false)} title="Close navigation"><X size={18} /></button>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavButton active={view === "bearings"} icon={<Gauge size={17} />} label="Bearings" count={openCallCount || undefined} onClick={() => navigate("bearings")} />
          <NavButton active={view === "chat"} icon={<MessageSquareText size={17} />} label="Chat" detail="First Mate" count={approvalCount || undefined} countTitle={approvalCount ? `The first mate is waiting for your OK on ${approvalCount === 1 ? "one thing" : `${approvalCount} things`}` : undefined} status={approvalCount ? undefined : <i className={`nav-status state-${runtime.state} ${degraded ? "degraded" : ""}`} title={`First Mate: ${hostLabel}`} />} onClick={() => navigate("chat")} />
          <NavButton active={view === "projects" || view === "project"} icon={<FolderGit2 size={17} />} label="Projects" count={projects.length} quietCount onClick={() => navigate("projects")} />
          <NavButton active={view === "artifacts" || view === "artifact"} icon={<PanelsTopLeft size={17} />} label="Artifacts" onClick={() => navigate("artifacts")} />
        </nav>
        {projects.length > 0 && <div className="sidebar-label">Projects</div>}
        <div className="project-shortcuts">
          {projects.map((project) => {
            const waitingHere = waitingIn(project.name).length;
            const underwayHere = underwayIn(project).length;
            return <button key={project.name} className={view === "project" && selectedProject === project.name ? "selected" : ""} onClick={() => openProject(project.name)}>
              <span className="project-sigil">{project.name.slice(0, 2).toUpperCase()}</span>
              <span><strong>{project.name}</strong><small>{waitingHere > 0 && <><em>{waitingHere} waiting</em> · </>}{waitingHere === 0 && underwayHere === 0 ? "idle" : `${underwayHere} underway`}</small></span>
            </button>;
          })}
        </div>
        <Usage context={bridge.context} rateLimit={bridge.rateLimit} quota={quota} runtime={runtime.state} sendReady={bridge.sendReady} compaction={bridge.compaction} onCompact={() => void bridge.compactNow()} onDismissCompaction={bridge.dismissCompaction} />
        <UpdateNotice update={appUpdate.update} problem={appUpdate.problem} runtime={runtime.state} onRestart={() => void appUpdate.restart()} onCancel={() => void appUpdate.cancel()} onSeen={() => void appUpdate.seen()} onCheck={() => void appUpdate.check()} />
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
          <div className="page-heading"><h1>{title}</h1><span title={subtitleTitle}>{subtitle}</span></div>
          <div className="top-actions">
            <button className="icon-button" onClick={toggleTheme} title={dark ? "Use light theme" : "Use dark theme"}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
            <button className="search-button" title="Search"><Search size={15} /> Search</button>
            <button className="ahoy-button" onClick={runAhoy} title="Catch up on what happened since your last message">Ahoy</button>
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
                <div>
                  <span>Ahoy</span>
                  <h2>{nothingYet ? "Welcome aboard." : `Welcome back. ${openCallCount ? `${capitalize(countWord(openCallCount, "thing"))} ${openCallCount === 1 ? "wants" : "want"} your word.` : "Nothing needs your word."}`}</h2>
                  <p>{nothingYet ? "Nothing has been asked of the first mate here yet. Say hello and it will take you from the top." : `${openCallCount ? "Everything else is moving. " : ""}The first mate can walk you through what changed since you were last here${openCallCount ? ", then take you through what's waiting" : ""}.`}</p>
                </div>
                <div className="ahoy-actions"><button onClick={runAhoy}>{nothingYet ? "Ahoy" : "Catch me up"}</button><button onClick={() => setAhoyVisible(false)}>Not now</button></div>
              </section>
            )}
            <DashboardSection title="Captain's call" tone="coral" count={openCallCount} countLabel="waiting on you">
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
                  project={callProject(call, records)}
                  now={now}
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

            <DashboardSection title="Underway" tone="blue" count={underway.length} countLabel={underway.length === 1 ? "worker" : "workers"}>
              <div className="task-list">
                {underway.map((item) => {
                  const task = fleet?.tasks.find((candidate) => candidate.id === item.id);
                  const status = taskStatus(item.state);
                  const started = startedAt(task, records.get(item.id));
                  return <button className="task-row" key={item.id} onClick={() => task && setActiveTask(task)}><span className={`task-state tone-${status.tone}`}>{status.icon}</span><span className="task-copy"><strong>{item.name}</strong><small>{projectName(item.repo ?? "")} · {item.kind}{started && <> · <span data-testid="underway-for" title={`Started ${formatStart(started)}`}>{sinceLabel(started, now)}</span></>}</small></span><span className={`task-chip tone-${status.tone}`}>{stateLabel(item.state)}</span><ChevronRight size={16} /></button>;
                })}
              </div>
              {underway.length === 0 && <EmptyState label="Nothing is underway." />}
            </DashboardSection>

            <div className="dashboard-pair">
              <DashboardSection title="Recently landed" tone="green" count={landedRows.length}>
                <div className="row-list">
                  {landedRows.map((row) => <LandedRow key={row.id} row={row} onOpenPage={row.page ? () => showArtifact(row.page!) : undefined} onAsk={row.report && !row.page ? () => draftInChat(askAboutReport(row.title)) : undefined} onBasis={row.basis ? () => openEvidence(row.basis!) : undefined} />)}
                </div>
                {landedRows.length === 0 && <EmptyState label="Nothing has landed recently." />}
              </DashboardSection>

              <DashboardSection title="Charted next" tone="muted" count={bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length}>
                <div className="row-list">
                  {bearings.gates.map((item) => <CompactRow key={item.id} title={item.title} detail={item.reason} tone="amber" badge="waiting" />)}
                  {(bearings.unhealthy_endpoints ?? []).map((item) => <CompactRow key={`health-${item.id}`} title={`The first mate's records for ${projectName(fleet?.tasks.find((task) => task.id === item.id)?.project ?? item.id)} don't match.`} detail="Nothing to do on your side." tone="amber" badge="needs repair" />)}
                </div>
                {bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length === 0 && <EmptyState label="Nothing is queued." />}
              </DashboardSection>
            </div>

            {decided.length > 0 && <DashboardSection title="Decided for you" tone="sea" count={decided.length}>
              <div className="decided-list" data-testid="decided">
                {decided.map((call) => {
                  const item = decidedItem(call);
                  return <DecidedRow key={item.id} item={item} taskTitle={item.task ? taskTitle(item.task) : null} onTask={item.task && fleet?.tasks.some((task) => task.id === item.task) ? () => openTask(item.task!) : undefined} onPushBack={() => draftInChat(`About "${item.what}": `)} onDismiss={() => dismissDecided(item.id)} />;
                })}
              </div>
            </DashboardSection>}
            </>}
          </div>
        )}

        {view === "chat" && <ChatView messages={messages} artifacts={artifacts} reviews={reviews} onSettle={(ref, threads) => settleFromChat(ref, threads)} tasks={fleet?.tasks ?? []} onOpenArtifact={showArtifact} outbox={outbox} draft={chatDraft} runtime={runtime.state} hostLabel={hostLabel} degraded={degraded} home={bridge.home} sendReady={bridge.sendReady} banners={hostBanners(setChatDraft)} approvals={bridge.permissionRequests} onAnswer={(id, optionId) => void bridge.answerPermission(id, optionId)} onDraft={setChatDraft} files={chatFiles} attachProblems={attachProblems} attaching={attaching} copying={copying} onAttach={() => void attachToChat()} onRemoveFile={(source) => setChatFiles((current) => current.filter((file) => file.source !== source))} onDismissProblems={() => setAttachProblems([])} onSend={() => void sendChat()} onResend={(id, text) => void bridge.resend(id, text)} onRestart={() => void bridge.restart()} />}
        {view === "projects" && <ProjectsView projects={projects} waitingIn={(name) => waitingIn(name).length} underwayIn={(project) => underwayIn(project).length} queuedIn={(name) => upNext(fleet?.backlog?.records ?? [], name).length} onOpen={openProject} />}
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
          onOpenQueued={(record) => setQueuedId(record.id)}
        />}
        {view === "artifacts" && <ArtifactsView artifacts={artifacts} tasks={fleet?.tasks ?? []} reviews={reviews} backlog={records} calls={calls} onOpen={showArtifact} />}
        {view === "artifact" && (shownArtifact && shownRevision
          ? <ArtifactReview
              key={`${shownArtifact.scope}/${shownArtifact.task}/${shownArtifact.name}/${shownRevision.rev}`}
              artifact={shownArtifact}
              revision={shownRevision}
              url={host.artifactUrl(shownRevision)}
              review={review}
              stake={reviewStake(shownArtifact, fleet?.tasks ?? [], records, calls, (review?.answers ?? []).filter((answer) => answer.sent_at === null))}
              sendReady={bridge.sendReady}
              runtime={runtime.state}
              onRevision={(rev) => showArtifact(shownArtifact, rev)}
              onComment={(body, anchor, thread, picture) => host.reviewComment(artifactRef!, shownRevision.rev, body, anchor, thread, picture).then(setReview)}
              onDiscard={(thread) => host.reviewDiscard(artifactRef!, thread).then(setReview)}
              onSubmit={(verdict) => host.reviewSubmit(artifactRef!, shownRevision.rev, verdict).then((sent) => {
                if (sent.message) bridge.noteSent(sent.message, sent.text);
                setReview(sent.review);
                return sent.warning;
              })}
              calls={callsArguedBy(calls, shownArtifact)}
              onAnswer={(call, answer) => host.reviewAnswer(artifactRef!, call.id, answer.option?.key, answer.option?.label, call.on_answer, answer.words).then(setReview)}
              onScene={(place, proposal) => host.reviewScene(artifactRef!, shownRevision.rev, place.file, place.label, place.path, proposal.summary, proposal.scene, proposal.png).then(setReview)}
              onSettle={(thread, resolved) => host.reviewSettle(artifactRef!, thread, resolved).then(setReview)}
              onSeen={(rev) => host.reviewSeen(artifactRef!, rev).then(setReview)}
            />
          : <div className="content-scroll"><EmptyState label="This page isn't in the home's records anymore." /></div>)}
      </main>

      {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
      {settingsOpen && <SettingsDialog home={bridge.home} problem={bridge.homeProblem} running={runningHere} choosing={bridge.choosingHome} chosen={bridge.homeChosen} onChoose={() => void bridge.chooseHome()} onUseApp={() => void bridge.useAppHome()} onClose={() => setSettingsOpen(false)} />}
      {queuedId && records.get(queuedId) && <QueuedDrawer record={records.get(queuedId)!} project={selectedProject ?? ""} now={now} artifacts={artifacts.filter((artifact) => artifact.scope === "task" && artifact.task === queuedId)} reviews={reviews} source={fleet?.schema ?? null} onOpenArtifact={showArtifact} onClose={() => setQueuedId(null)} />}
      {logEntry && <LogbookDrawer entry={logEntry} project={selectedProject ?? ""} now={now} artifacts={artifacts.filter((artifact) => artifact.scope === "task" && artifact.task === logEntry.id)} reviews={reviews} source={history.schema} onOpenArtifact={showArtifact} onAskReport={() => { setLogEntry(null); draftInChat(askAboutReport(logEntry.title)); }} onClose={() => setLogEntry(null)} />}
      {activeTask && fleet && <TaskDrawer task={activeTask} title={taskTitle(activeTask.id)} record={records.get(activeTask.id)} now={now} reviews={reviews} onAskReport={() => { setActiveTask(null); draftInChat(askAboutReport(taskTitle(activeTask.id))); }} artifacts={artifacts.filter((artifact) => artifact.scope === "task" && artifact.task === activeTask.id)} onOpenArtifact={showArtifact} fleetSchema={fleet.schema} fleetGenerated={fleet.generated} expanded={showEverything} onCapture={bridge.paneCapture} onToggle={() => setShowEverything((current) => !current)} onClose={() => { setActiveTask(null); setShowEverything(false); }} />}
    </div>
  );
}

/** A main view in the sidebar, drawn with a fixed icon; projects, which the captain names, keep their initials. A count that waits on the captain is a gold badge; a plain tally stays quiet. */
function NavButton({ active, icon, label, detail, count, countTitle, quietCount, status, onClick }: { active: boolean; icon: React.ReactNode; label: string; detail?: string; count?: number; countTitle?: string; quietCount?: boolean; status?: React.ReactNode; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><span className="nav-icon" aria-hidden="true">{icon}</span><span className="nav-label"><strong>{label}</strong>{detail && <small>{detail}</small>}</span>{count !== undefined ? <em className={quietCount ? "quiet" : ""} title={countTitle}>{count}</em> : status}</button>;
}

function HomeSetup({ problem, choosing, onChoose, onUseApp }: { problem: string | null; choosing: boolean; onChoose: () => void; onUseApp: () => void }) {
  return <div className="home-setup"><section><div className="brand-mark">Q</div><h1>Where does firstmate live on this Mac?</h1><p>The app ships its own first mate and keeps it in the app's folder. It could not set that up this time, so you can point it at a firstmate folder of your own: the one with <code>AGENTS.md</code> and <code>bin</code> inside.</p>{problem && <HomeProblem problem={problem} />}<div className="home-actions"><button className="home-choose" disabled={choosing} onClick={onChoose}><FolderOpen size={16} /> {choosing ? "Choosing…" : "Choose folder…"}</button><button className="home-revert" disabled={choosing} onClick={onUseApp}>Try the app's own again</button></div></section></div>;
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
  return <div className="drawer-backdrop" onMouseDown={onClose}><section className="settings-dialog" role="dialog" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><div><span>Settings</span><h2>The first mate</h2></div><button className="icon-button" onClick={onClose} title="Close settings"><X size={18} /></button></header><div className="settings-body"><h3>firstmate folder</h3><p>{chosen ? "The first mate runs in the folder you chose, and Bearings is read from there." : "The app keeps its own first mate here, and Bearings is read from here."}</p><code className="settings-path" title={home}>{home}</code>{problem && <HomeProblem problem={problem} />}<button className="home-choose" disabled={running || choosing} onClick={onChoose}><FolderOpen size={16} /> {choosing ? "Choosing…" : "Choose a different folder…"}</button>{chosen && <button className="home-revert" disabled={running || choosing} onClick={onUseApp}>Use the app's own first mate again</button>}{running && <small>Stop the first mate before changing which folder it runs in.</small>}{home && <RoutingSettings key={home} host={host} />}</div></section></div>;
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

/** A titled part of a page. The dot carries the section's tone; the count reads on in the words after it. */
function DashboardSection({ title, tone, count, countLabel, children }: { title: string; tone: string; count: number; countLabel?: string; children: React.ReactNode }) {
  return <section className="dashboard-section"><div className="section-heading"><span className={`section-dot ${tone}`} aria-hidden="true" /><h2>{title}</h2><span className="section-count">{count}</span>{countLabel && <span className="section-count-label">{countLabel}</span>}</div>{children}</section>;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** A count in words, the way a person says it: "two things", "12 projects". */
function countWord(count: number, noun: string) {
  return `${COUNT_WORDS[count] ?? count} ${noun}${count === 1 ? "" : "s"}`;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty-state"><CircleDot size={16} /><strong>{label}</strong></div>;
}

/** A quiet row: a dot in its tone, what it is, and a word on the right saying where it stands. */
function CompactRow({ title, detail, tone = "green", badge }: { title: string; detail: string; tone?: Tone; badge?: string }) {
  // firstmate's snapshots write "-" for an empty field; show nothing rather than a dash.
  const shown = detail.trim() === "-" ? "" : detail.trim();
  return <div className="compact-row"><span className={`row-dot tone-${tone}`} aria-hidden="true" /><div><strong>{title}</strong>{shown && <small>{shown}</small>}</div>{badge && <em className={`tone-${tone}`}>{badge}</em>}</div>;
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
    <div className="decision-body">
      <div className="decision-meta"><span>report ready</span><span>{project}</span><span title={report ?? undefined}>{page ? `presented ${formatWhen(page.latest.presented_at)}` : "written up without a page"}</span></div>
      <h3>{title}</h3>
      {finished && <p>{finished}</p>}
    </div>
    <div className="report-actions">
      {onOpen ? <button onClick={onOpen}>Read the report</button> : <button onClick={onAsk}>Ask the first mate for it</button>}
      <button className="quiet" onClick={onDetails}>Task details</button>
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
    <span className="decided-icon">{(item.kind && DECIDED_ICONS[item.kind]) || <ShipWheel size={14} />}</span>
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
      <button onClick={onPushBack} title="Tell the first mate you see it differently">Push back</button>
      <button className="quiet" onClick={onDismiss} title="Dismiss">Dismiss</button>
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
    ? [row.project, "Your call", when && `${row.verb ?? "closed"} ${when}`].filter(Boolean).join(" · ")
    : [row.project, row.verb && when ? `${LANDED_VERBS[row.verb] ?? row.verb} ${when}` : when].filter(Boolean).join(" · ");
  const basis = row.basis;
  return <div className="compact-row landed-row" data-testid="landed-row" data-landed-kind={row.kind} data-id={row.id}>
    <div>
      <strong>{row.title}</strong>
      {row.kind === "answered" && <small className="landed-answer">You chose <em>{row.answer}</em>{basis && <> · based on {basis.kind === "url"
        ? <ExternalAnchor className="link-button" href={basis.url}>{basis.title}</ExternalAnchor>
        : <button className="link-button" onClick={onBasis}>{basis.title}</button>}</>}</small>}
      {meta && <small>{meta}</small>}
    </div>
    <div className="landed-links">
      {row.pr && <ExternalAnchor className="landed-link" href={row.pr}>{linkLabel(row.pr)}</ExternalAnchor>}
      {onOpenPage && <button className="landed-link" onClick={onOpenPage}>The page</button>}
      {onAsk && <button className="landed-link" onClick={onAsk} title={row.report ?? undefined}>Report</button>}
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

/** The line above a call: what it is, whose it is, and how long it has waited on the captain. */
function CallMeta({ call, project, now }: { call: Call; project: string | null; now: number }) {
  const raised = call.raised_at ? Date.parse(call.raised_at) : NaN;
  return <div className="decision-meta"><span>decision</span>{project && <span>{project}</span>}{!Number.isNaN(raised) && <span title={`Raised ${formatWhen(call.raised_at!)}`}>held {heldFor(now - raised)}</span>}</div>;
}

/** How long something has waited, as short as a glance needs: 40m, 6h, 3d. */
function heldFor(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** An answer the intake did not record, said as plainly as a recorded one. Nothing about it reached the first mate. */
function NotRecorded({ note }: { note: AnswerNote }) {
  return <div className="call-state tone-coral call-not-recorded" role="alert" data-testid="not-recorded"><CircleAlert size={16} /><span><strong>Not recorded: {note.label}</strong><small>{note.detail}</small></span></div>;
}

/**
 * The ways to answer a call, the same on every surface that answers one: one of its options, not now until a day, and
 * words, as the answer itself or added to an option. Linking a call to the page that argues it never takes one away.
 * What choosing does, recording at once or going with a review, is the surface's; what the captain can say is not.
 */
function CallAnswerFields({ call, layout, picked, deferring, deferDate, note, adding, disabled, onPick, onDefer, onDate, onNote }: {
  call: Call;
  /** Chips across a card, or one choice per row in the review rail. */
  layout: "chips" | "list";
  picked: string | null;
  deferring: boolean;
  deferDate: string;
  note: string;
  /** Whether the words go with a chosen option rather than being the answer. */
  adding: boolean;
  disabled: boolean;
  onPick: (option: OptionChoice) => void;
  onDefer: () => void;
  onDate: (date: string) => void;
  onNote: (note: string) => void;
}) {
  return <div className="call-answer-fields" data-testid="answer-fields">
    <div className={layout === "list" ? "decision-choices" : "suggestion-chips"}>
      {call.options.map((option) => <button key={option.key} className={picked === option.key ? "selected" : ""} aria-pressed={picked === option.key} disabled={disabled} onClick={() => onPick(option)}><span>{option.label}</span>{option.recommended && <small>Recommended</small>}</button>)}
      <button className={deferring ? "selected" : ""} aria-pressed={deferring} disabled={disabled} onClick={onDefer}><span>Not now</span></button>
    </div>
    {deferring && <label className="date-field"><span>Ask me again</span><input type="date" value={deferDate} min={localDay(new Date().toISOString()) ?? undefined} disabled={disabled} onChange={(event) => onDate(event.target.value)} /></label>}
    <label className="reply-field"><span>{adding ? "Anything to add for the first mate?" : call.options.length ? "Or answer in words" : "Answer in words"}</span><textarea value={note} disabled={disabled} onChange={(event) => onNote(event.target.value)} /></label>
  </div>;
}

/**
 * One call waiting on the captain, as one card whether or not something argues it, answered the same ways either
 * way. A call something argues leads with reading that argument and keeps its answer folded under Answer now; a call
 * nothing argues has only the answer to offer, so it is open. An answer with a key goes through firstmate's intake
 * and the card says what it did; anything else is words to the first mate, tracked like any message.
 */
function DecisionCard({ call, project, now, argument, seenArgument, answered, answeredIn, state, answerText, runtime, onSend, onAnswer, onStart, onReadArgument, onOpenPage }: {
  call: Call;
  project: string | null;
  now: number;
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
  // Only an argued call folds its answer away, so the argument is read first.
  const [answering, setAnswering] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  // Options with a key go through the intake; that needs the call to say how an answer closes it.
  const keyed = call.options.length > 0 && Boolean(call.on_answer);
  const name = callName(call);
  const failed = answered && answered.result !== "closed" ? answered : undefined;
  const meta = <CallMeta call={call} project={project} now={now} />;
  // The meta line already names the project, so the title does not say it again.
  const heading = project ? withinProject(call.title, project) : call.title;

  async function record(option: OptionChoice, words?: string) {
    setRecording(option.key);
    try {
      await onAnswer(option, words);
    } finally {
      setRecording(null);
    }
  }

  // Not now says nothing until it has a day to be asked again on.
  const words = dateOpen
    ? deferDate ? answerInWords(deferDate, note) : ""
    : [selection && !keyed ? selection.label : "", note.trim()].filter(Boolean).join(". ");
  const recordPick = keyed && selection && !dateOpen ? selection : null;
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
    return <article className={`decision-card ${read ? "read" : "queued"} call-tone-${tone}`} data-call-id={call.id}><div className="decision-body">{meta}<h3>{heading}</h3>{answerText && <p className="call-answer" title={answerText}>{answerText}</p>}<div className={`call-state tone-${tone}`}>{icon}<span><strong>{title}</strong>{state.error ? <small>{state.error}</small> : !read && <small>{detail}</small>}</span>{state.error && !state.resent && resendText ? <button onClick={() => onSend(resendText)}>Send again</button> : !read && !state.error && runtime === "dead" ? <button onClick={onStart}>Start the first mate</button> : null}</div></div></article>;
  }
  if (answered?.result === "closed") {
    // Recorded by firstmate itself; the card goes once the snapshot has the call closed.
    const told = answered.told ? "The first mate has been told, and does the follow-up." : answered.warning ?? "The first mate was not told. Tell it in chat so it does the follow-up.";
    return <article className="decision-card read call-tone-green" data-call-id={call.id} data-recorded="true"><div className="decision-body">{meta}<h3 data-testid="decision-title">{heading}</h3><div className="call-state tone-green"><Check size={16} /><span><strong>Recorded: {answered.label}</strong><small>{told}</small>{answered.unread && <small className="call-unread">You answered without opening the argument.</small>}</span>{onOpenPage && <button onClick={onOpenPage}>Open the page</button>}</div></div></article>;
  }
  if (answeredIn) {
    // Answered in a review; the card goes once the snapshot has the call closed.
    return <article className="decision-card read call-tone-green" data-call-id={call.id} data-answered-in-review="true"><div className="decision-body">{meta}<h3 data-testid="decision-title">{heading}</h3><div className="call-state tone-green"><Check size={16} /><span><strong>Answered in your review of “{answeredIn}”</strong><small>This leaves the list once firstmate has closed it.</small></span>{onOpenPage && <button onClick={onOpenPage}>Open the page</button>}</div></div></article>;
  }
  const argued = argument && onReadArgument ? argument : null;
  const folded = argued !== null && !answering;
  const buttonLabel = recordPick ? (recording ? "Recording…" : "Record answer") : "Send";
  const hint = recordPick ? `→ records: ${recordPick.label}${note.trim() ? ", and tells the first mate what you added" : ""}` : preview !== "…" ? `→ sends: ${preview}` : dateOpen ? "Pick the day to be asked again" : "";
  const submit = <button disabled={recording !== null || (!recordPick && preview === "…")} onClick={() => recordPick ? void record(recordPick, note.trim() || undefined) : onSend(preview)}>{buttonLabel}</button>;
  return <article className="decision-card" data-call-id={call.id} data-argued={argued ? "true" : undefined} data-inline={argued ? undefined : "true"}>
    <div className="decision-body">
      {meta}
      <h3 data-testid="decision-title">{heading}</h3>
      {questionBeyondTitle(call) && <p data-testid="decision-reason">{call.question}</p>}
      {argued && <p className="call-argued" data-testid="argued-by">Argued by <strong>{argued.title}</strong></p>}
      {failed && <NotRecorded note={failed} />}
      {!folded && <>
        {argued && seenArgument === false && <p className="call-unread" data-testid="unread-argument">You haven't opened “{argued.title}” yet.</p>}
        <CallAnswerFields
          call={call}
          layout="chips"
          picked={selection?.key ?? null}
          deferring={dateOpen}
          deferDate={deferDate}
          note={note}
          adding={recordPick !== null || dateOpen}
          disabled={recording !== null}
          onPick={(option) => { setSelection(option); setDateOpen(false); setDeferDate(""); }}
          onDefer={() => { setDateOpen(true); setSelection(null); }}
          onDate={setDeferDate}
          onNote={setNote}
        />
      </>}
    </div>
    <div className="decision-actions">
      <span>{folded ? optionSummary(call) : hint}</span>
      {argued
        ? <div className="report-actions">
            <button className="quiet" aria-expanded={answering} onClick={() => setAnswering((open) => !open)}>Answer now</button>
            <button className={folded ? "" : "quiet"} onClick={onReadArgument}>Read the argument</button>
            {!folded && submit}
          </div>
        : submit}
    </div>
  </article>;
}

type ProjectSummary = { name: string; posture: string; description: string; tasks: FleetTask[] };

function ProjectsView({ projects, waitingIn, underwayIn, queuedIn, onOpen }: { projects: ProjectSummary[]; waitingIn: (name: string) => number; underwayIn: (project: ProjectSummary) => number; queuedIn: (name: string) => number; onOpen: (name: string) => void }) {
  if (projects.length === 0) return <div className="content-scroll projects-page"><EmptyState label="No projects yet. Tell the first mate about one and it shows up here." /></div>;
  return <div className="content-scroll projects-page"><div className="project-grid">{projects.map((project) => {
    const waiting = waitingIn(project.name);
    const underway = underwayIn(project);
    const queued = queuedIn(project.name);
    return <button key={project.name} className="project-card" onClick={() => onOpen(project.name)}>
      <span className="project-card-head"><span className="project-sigil large">{project.name.slice(0, 2).toUpperCase()}</span><h2>{project.name}</h2></span>
      <p>{project.description || project.posture}</p>
      <span className="project-counts">
        {waiting > 0 && <em className="tone-coral">{waiting} waiting on you</em>}
        {underway > 0 ? <em className="tone-blue">{underway} underway</em> : waiting === 0 && <em className="tone-muted">idle</em>}
        {queued > 0 && <em className="tone-muted">{queued} queued</em>}
      </span>
    </button>;
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

function ProjectView({ project, now, taskTitle, records, waiting, reports, underway, queued, recent, calls, history, onOpenTask, onOpenCall, onOpenReport, onOpenEntry, onOpenQueued }: {
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
  onOpenQueued: (record: BacklogRecord) => void;
}) {
  const needs = waiting.length + reports.length;
  const title = (text: string) => withinProject(text, project.name);
  // The snapshot's calls are the newer read of a call the history also lists.
  const allCalls = useMemo(() => {
    const known = new Set(calls.map((call) => call.id));
    return [...calls, ...history.calls.filter((call) => !known.has(call.id))];
  }, [calls, history.calls]);
  const entries = useMemo(() => logEntries(history.project === project.name ? history.records : [], recent, allCalls, project.name), [history.project, history.records, recent, allCalls, project.name]);
  const landed = landedWithin(entries, 30, now, history.project !== project.name || history.status !== "ready" ? "any" : history.next ? "older" : "none");
  return <div className="content-scroll project-page" data-testid="project-page">
    <section className="project-summary">
      <span className="project-sigil huge">{project.name.slice(0, 2).toUpperCase()}</span>
      <div><h2>{project.name}</h2><p>{project.description || "The first mate keeps this work within the project's standing delivery posture."}</p></div>
    </section>
    <section className="project-stats">
      <div className="project-stat" data-testid="stat-waiting"><span>Waiting on you</span><strong className={needs ? "tone-coral" : ""}>{needs}</strong></div>
      <div className="project-stat"><span>Underway</span><strong className={underway.length ? "tone-blue" : ""}>{underway.length}</strong></div>
      <div className="project-stat"><span>Queued</span><strong>{queued.length}</strong></div>
      <div className="project-stat" data-testid="stat-landed" title="Shipped work and reports that closed in the last 30 days"><span>Landed, 30d</span><strong className={landed.count ? "tone-green" : ""}>{landed.count}{landed.floor ? "+" : ""}</strong></div>
    </section>

    {needs > 0 && <DashboardSection title="Needs you" tone="coral" count={needs}>
      <div className="task-list needs-list" data-testid="project-needs">
        {waiting.map((call) => {
          const pick = recommended(call);
          const raised = call.raised_at ? Date.parse(call.raised_at) : NaN;
          return <button className="task-row wide" key={call.id} data-call={call.id} onClick={() => onOpenCall(call.id)}><span className="task-state tone-coral"><ShieldQuestion size={16} /></span><span className="task-copy"><strong>{title(call.title)}</strong><small>{[pick ? `Recommended: ${pick.label}` : call.question ?? "The first mate needs your answer.", !Number.isNaN(raised) && `held ${heldFor(now - raised)}`].filter(Boolean).join(" · ")}</small></span><span className="task-chip answer-chip">Answer</span></button>;
        })}
        {reports.map((item) => <button className="task-row wide" key={item.task.id} onClick={() => onOpenReport(item)}><span className="task-state tone-blue"><FileText size={16} /></span><span className="task-copy"><strong>{title(taskTitle(item.task.id))}</strong><small>{item.page ? "The report is ready to read." : "The report is written, without a page."}</small></span><span className="task-chip answer-chip">Read</span></button>)}
      </div>
    </DashboardSection>}

    <DashboardSection title="Work" tone="blue" count={underway.length} countLabel={`underway · ${queued.length} queued`}>
      <div className="task-list" data-testid="project-underway">{underway.map((task) => {
        const status = taskStatus(task.current_state.state);
        const started = startedAt(task, records.get(task.id));
        return <button className="task-row" key={task.id} onClick={() => onOpenTask(task)}><span className={`task-state tone-${status.tone}`}>{status.icon}</span><span className="task-copy"><strong>{title(taskTitle(task.id))}</strong><small>{KIND_NAMES[task.kind] ?? task.kind} · {task.harness}{started && <> · {sinceLabel(started, now)}</>}</small></span><span className={`task-chip tone-${status.tone}`}>{stateLabel(task.current_state.state)}</span><ChevronRight size={16} /></button>;
      })}</div>
      {queued.length > 0 && <div className="task-list" data-testid="project-queue">{queued.map((record) => {
        const detail = [KIND_NAMES[record.kind ?? ""] ?? record.kind, record.since && `filed ${shortDay(record.since, now)}`, record.hold_reason].filter(Boolean).join(" · ");
        return <button className="task-row wide" key={record.id} data-id={record.id} onClick={() => onOpenQueued(record)}><span className="task-state tone-muted"><Clock3 size={16} /></span><span className="task-copy"><strong>{title(record.title)}</strong><small>{detail}</small></span><span className={`task-chip tone-${record.hold_reason ? "amber" : "muted"}`}>{record.hold_reason ? "waiting" : "queued"}</span><ChevronRight size={16} /></button>;
      })}</div>}
      {underway.length + queued.length === 0 && <EmptyState label="Nothing is underway or queued in this project." />}
    </DashboardSection>

    <Logbook project={project.name} now={now} entries={entries} history={history} title={title} onOpen={onOpenEntry} />
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
function Logbook({ project, now, entries, history, title, onOpen }: { project: string; now: number; entries: LogEntry[]; history: ReturnType<typeof useProjectHistory>; title: (text: string) => string; onOpen: (entry: LogEntry) => void }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [query, setQuery] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);
  useEffect(() => { setFilter("all"); setQuery(""); setIncludeClosed(false); }, [project]);
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
    <div className="section-heading"><span className="section-dot green" aria-hidden="true" /><h2>Logbook</h2><span className="section-count" data-testid="log-count">{counts.all}{more}</span><span className="section-count-label">closed</span></div>
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

/**
 * A task waiting its turn, read from its backlog row: what it is waiting on, what was asked, and any page it
 * already carries. There is no worker to show; the row's state says whether one has picked it up since it opened.
 */
function QueuedDrawer({ record, project, now, artifacts, reviews, source, onOpenArtifact, onClose }: { record: BacklogRecord; project: string; now: number; artifacts: Artifact[]; reviews: ReviewSummary; source: string | null; onOpenArtifact: (artifact: Artifact) => void; onClose: () => void }) {
  const body = bodyBlocks(record.body_lines, record.body_excerpt);
  const kind = KIND_NAMES[record.kind ?? ""] ?? record.kind ?? "Task";
  const pickedUp = record.state === "in_flight";
  const closed = record.state === "done";
  const tone = !pickedUp && !closed && record.hold_reason ? "amber" : "muted";
  const label = pickedUp ? "Underway" : closed ? "Closed" : record.hold_reason ? "Waiting" : "Queued";
  const detail = pickedUp ? `${kind} · picked up by a worker` : closed ? `${kind} · closed` : record.hold_reason ?? `${kind} · waiting its turn`;
  const notes = useTaskNotes(record.id);
  const panel = useDrawerDismiss(onClose);
  return <div className="drawer-backdrop passive"><aside className="task-drawer" ref={panel} data-testid="queued-drawer">
    <header className="drawer-header"><div><span>{project}</span><h2 data-testid="drawer-title">{withinProject(record.title, project)}</h2><small className="drawer-id">{record.id}</small></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header>
    <div className="drawer-status"><span className={`task-state tone-${tone}`}><Clock3 size={16} /></span><div><strong className={`tone-${tone}`}>{label}</strong><span>{detail}</span></div></div>
    <div className="drawer-scroll">
      <TaskFiles taskId={record.id} notes={notes.notes} />
      {body.length > 0 ? <DrawerSection title="What was asked"><TaskBody blocks={body} /></DrawerSection> : <DrawerSection title="What was asked"><div className="brief-block"><p>The row says nothing more than its title.</p></div></DrawerSection>}
      <TaskNotesThread read={notes} running={pickedUp} closed={closed} />
      {artifacts.length > 0 && <DrawerSection title="Pages"><div className="drawer-pages">{artifacts.map((artifact) => <ArtifactRow key={artifact.name} artifact={artifact} detail={revisionLine(artifact)} review={reviews[artifactKey(artifact)]} onOpen={() => onOpenArtifact(artifact)} />)}</div></DrawerSection>}
      <DrawerSection title="Timeline"><div className="timeline">
        <div><span className="timeline-icon"><GitBranch size={15} /></span><span><strong>Filed</strong><small>{kind}</small></span><time>{record.since ? shortDay(record.since, now) : "Undated"}</time></div>
      </div></DrawerSection>
    </div>
    <footer className="drawer-footer">From {source ?? "the fleet snapshot"}</footer>
  </aside></div>;
}

/** A closed task, read from its backlog row: what was asked, what it left behind, and how it closed. */
function LogbookDrawer({ entry, project, now, artifacts, reviews, source, onOpenArtifact, onAskReport, onClose }: { entry: LogEntry; project: string; now: number; artifacts: Artifact[]; reviews: ReviewSummary; source: string | null; onOpenArtifact: (artifact: Artifact) => void; onAskReport: () => void; onClose: () => void }) {
  const look = LOG_LOOK[entry.kind];
  const record = entry.record;
  const call = entry.call;
  const body = bodyBlocks(record.body_lines, record.body_excerpt);
  const notes = useTaskNotes(entry.id);
  const days = record.since && entry.date ? Math.round((Date.parse(entry.date) - Date.parse(record.since)) / DAY_MS) : null;
  const panel = useDrawerDismiss(onClose);
  return <div className="drawer-backdrop passive"><aside className="task-drawer" ref={panel} data-testid="log-drawer">
    <header className="drawer-header"><div><span>{project}</span><h2 data-testid="drawer-title">{withinProject(entry.title, project)}</h2><small className="drawer-id">{entry.id}</small></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header>
    <div className="drawer-status"><span className={`task-state tone-${look.tone}`}>{look.icon}</span><div><strong className={`tone-${look.tone}`}>{outcomeLine(entry, now)}</strong><span>{KIND_NAMES[record.kind ?? ""] ?? look.chip}{days !== null && days >= 0 && ` · ${tookLine(entry.kind, days)}`}</span></div></div>
    <div className="drawer-scroll">
      {call && <DrawerSection title="The call"><div className="brief-block log-call">
        {call.question && <p>{call.question}</p>}
        {call.answer && <dl><dt>Answer</dt><dd>{call.answer.label}</dd>{call.decided?.why && <><dt>Why</dt><dd>{call.decided.why}</dd></>}</dl>}
      </div></DrawerSection>}
      <TaskFiles taskId={entry.id} notes={notes.notes} />
      {body.length > 0 && <DrawerSection title={call ? "From the backlog" : "What was asked"}><TaskBody blocks={body} /></DrawerSection>}
      <TaskNotesThread read={notes} running={false} closed />
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

type ChatItem = { type: "message"; message: ChatMessage } | { type: "steps"; id: string; steps: ChatMessage[]; past: boolean } | { type: "label"; id: string; text: string } | { type: "artifact"; id: string; artifact: Artifact; revision: ArtifactRevision } | { type: "review"; message: ChatMessage; sent: SentPage };

/** A review the captain sent, with the page it is about, as the chat draws it. */
type SentPage = { key: string; ref: ArtifactRef; artifact?: Artifact; review: SentReview; threads: SentThread[] };

/** The key the review summary files a page under. */
function reviewKey(artifact: { scope: string; task: string | null; name: string }) {
  return artifact.scope === "task" ? `task/${artifact.task}/${artifact.name}` : `chat/${artifact.name}`;
}

/**
 * Every review sent, found by the chat message it became and, oldest first, by that message's first line, since a
 * resumed conversation's history comes back without message ids.
 */
function sentReviews(reviews: ReviewSummary, artifacts: Artifact[]) {
  const byMessage = new Map<string, SentPage>();
  const byHeader = new Map<string, SentPage[]>();
  for (const [key, page] of Object.entries(reviews)) {
    const [scope, ...rest] = key.split("/");
    const ref: ArtifactRef = scope === "task" ? { scope: "task", task: rest[0], name: rest[1] } : { scope: "chat", task: null, name: rest[0] };
    const artifact = artifacts.find((candidate) => reviewKey(candidate) === key);
    for (const review of page.sent ?? []) {
      const sent: SentPage = { key, ref, artifact, review, threads: page.threads ?? [] };
      if (review.message) byMessage.set(review.message, sent);
      if (review.header) byHeader.set(review.header, [...byHeader.get(review.header) ?? [], sent]);
    }
  }
  for (const pages of byHeader.values()) pages.sort((a, b) => a.review.at - b.review.at);
  return { byMessage, byHeader };
}

/**
 * Which review each captain message is: by its id, or else, for a resumed conversation's messages, by its first line,
 * the latest such message taking the latest review with that line not already some message's own. One review is
 * never two messages.
 */
function reviewsOf(messages: ChatMessage[], artifacts: Artifact[], reviews: ReviewSummary) {
  const { byMessage, byHeader } = sentReviews(reviews, artifacts);
  const found = new Map<string, SentPage>();
  const ids = new Set(messages.map((message) => message.id));
  const unclaimed = new Map([...byHeader].map(([header, pages]) => [header, pages.filter((page) => !ids.has(page.review.message))]));
  for (const message of [...messages].reverse()) {
    if (message.who !== "captain") continue;
    const own = byMessage.get(message.id) ?? unclaimed.get(message.text.split("\n")[0])?.pop();
    if (own) found.set(message.id, own);
  }
  return found;
}

/**
 * Consecutive steps read as one group between the first mate's messages.
 * A resumed session's history reads as "Earlier", and "Today" starts after its last item.
 * A message still waiting keeps its place inside the history, so it stays under "Earlier".
 * A page presented in the last day shows where it happened among the conversation's messages. A day rather than the
 * calendar date, so a page shared just before midnight does not drop out of the conversation a minute later.
 */
const CHAT_PAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

function chatItems(messages: ChatMessage[], artifacts: Artifact[], reviews: ReviewSummary = {}) {
  const sent = reviewsOf(messages, artifacts, reviews);
  const lastPast = messages.reduce((found, message, index) => message.past ? index : found, -1);
  const items: ChatItem[] = [{ type: "label", id: "label-top", text: lastPast >= 0 ? "Earlier" : "Today" }];
  const since = Date.now() - CHAT_PAGE_WINDOW_MS;
  const shown = artifacts
    .flatMap((artifact) => artifact.revisions.map((revision) => ({ artifact, revision, at: Date.parse(revision.presented_at) })))
    .filter(({ at }) => at >= since)
    .sort((a, b) => a.at - b.at);
  // A page never renders below a message newer than it: pagePlaces (src/chatorder.ts) holds that, from the bounds.
  const places = pagePlaces(messages.map((message) => latestTime(message, sent.get(message.id)?.review.at)), shown.map(({ at }) => at));
  const pages = shown.map((page, index) => ({ ...page, place: places[index] }));
  const pushPages = (place: number) => {
    while (pages.length && pages[0].place <= place) {
      const { artifact, revision } = pages.shift()!;
      items.push({ type: "artifact", id: `artifact-${artifact.scope}-${artifact.task}-${artifact.name}-${revision.rev}`, artifact, revision });
    }
  };
  messages.forEach((message, index) => {
    pushPages(index);
    const past = message.past === true;
    const last = items.at(-1);
    // A review the captain sent is a card, not the text written for the first mate.
    const review = sent.get(message.id);
    if (review) items.push({ type: "review", message, sent: review });
    else if (message.who !== "step") items.push({ type: "message", message });
    else if (last?.type === "steps" && last.past === past) last.steps.push(message);
    else items.push({ type: "steps", id: `steps-${message.id}`, steps: [message], past });
    if (index === lastPast && (index < messages.length - 1 || pages.length)) items.push({ type: "label", id: `label-today-${message.id}`, text: "Today" });
  });
  // Only pages newer than every message are left, so they end the conversation.
  pushPages(messages.length);
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
  // What the steps were, at a glance: the first few, in the words each line would use.
  const preview = steps.slice(0, 3).map((step) => { const { verb, detail } = describeStep(step, home); return verb ? `${verb.toLowerCase()} ${detail}` : detail; }).join(" · ") + (steps.length > 3 ? " · …" : "");
  // A step that errors is usually the first mate probing for something that isn't there, and it goes on from
  // there. The fact stays, told as quietly as the rest of the line.
  const note = failed ? `${failed === steps.length && failed === 1 ? "it" : failed} came back with an error` : "";
  return <div className={`step-group ${live ? "live" : ""}`}>{!live && <button className="step-summary" aria-expanded={open} onClick={() => setOpen((current) => !current)} title={failed ? "A step that errors is often the first mate checking for something that isn't there. It carried on from there." : undefined}><span className="step-count">{summary}</span>{note && <span className="step-note">{note}</span>}{!open && <span className="step-preview">{preview}</span>}<ChevronRight size={14} className={open ? "rotated" : ""} /></button>}{live && hidden > 0 && <button className="step-summary" onClick={() => setOpen(true)}><ChevronRight size={13} /><span>{hidden} earlier {hidden === 1 ? "step" : "steps"}</span></button>}{(live || open) && <ol className="step-lines">{visible.map((step) => <StepLine key={step.id} step={step} live={live} home={home} />)}</ol>}</div>;
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
  return <section className="approval-card" aria-label="The first mate is asking for your OK"><div className="approval-copy"><strong>The first mate wants to run</strong><code>{stripHome(request.title, home)}</code><span>It's waiting for your answer before it goes on.</span>{request.error && <small role="alert">That answer didn't go through: {request.error}</small>}</div><div className="approval-actions">{request.options.map((option) => <button key={option.option_id} className={option.kind === "allow_once" ? "allow" : option.kind.startsWith("reject") ? "reject" : ""} disabled={request.answering} onClick={() => onAnswer(option.option_id)}>{APPROVAL_LABELS[option.kind] ?? option.name}</button>)}</div></section>;
}

function ChatView({ messages, artifacts, reviews, onSettle, tasks, onOpenArtifact, outbox, draft, files, attachProblems, attaching, copying, onAttach, onRemoveFile, onDismissProblems, runtime, hostLabel, degraded, home, sendReady, banners, approvals, onAnswer, onDraft, onSend, onResend, onRestart }: { messages: ChatMessage[]; artifacts: Artifact[]; reviews: ReviewSummary; onSettle: (ref: ArtifactRef, threads: string[]) => Promise<unknown>; tasks: FleetTask[]; onOpenArtifact: (artifact: Artifact, rev?: number) => void; outbox: Record<string, OutboxView>; draft: string; files: PickedFile[]; attachProblems: string[]; attaching: boolean; copying: boolean; onAttach: () => void; onRemoveFile: (path: string) => void; onDismissProblems: () => void; runtime: HostRuntimeState; hostLabel: string; degraded: boolean; home: string; sendReady: boolean; banners: React.ReactNode; approvals: PermissionView[]; onAnswer: (id: string, optionId: string) => void; onDraft: (value: string) => void; onSend: () => void; onResend: (id: string, text: string) => void; onRestart: () => void }) {
  const running = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"].includes(runtime);
  const turnLive = runtime === "prompt_turn" || runtime === "agent_turn";
  const placeholder = !sendReady ? "Start the first mate to send it a message." : runtime === "locked_by_other" ? "The first mate is running somewhere else. What you write here waits until it runs in this app." : running ? "Message the first mate" : "The first mate isn't running. It'll read this when it starts.";
  const items = chatItems(messages, artifacts, reviews);
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
  return <div className="chat-view">{banners}<div className="chat-messages" ref={scroller} onScroll={onScroll} data-testid="chat-messages">{messages.length === 0 && items.length === 1 && <><div className="day-label">Today</div><div className="chat-empty">{running ? "The first mate is getting its bearings. Its first message will show up here." : "No messages yet."}</div></>}{items.length > 1 && items.map((item, index) => item.type === "label"
    ? <div key={item.id} className={`day-label ${index > 0 ? "later" : ""}`}>{item.text}</div>
    : item.type === "artifact"
      ? <ArtifactChatCard key={item.id} artifact={item.artifact} revision={item.revision} tasks={tasks} reviews={reviews} onOpen={() => onOpenArtifact(item.artifact, item.revision.rev)} />
    : item.type === "review"
      ? <ReviewChatCard key={item.message.id} message={item.message} sent={item.sent} outbox={outbox[item.message.id]} running={running} tasks={tasks} onOpen={(rev) => item.sent.artifact && onOpenArtifact(item.sent.artifact, rev)} onSettle={(threads) => onSettle(item.sent.ref, threads)} />
    : item.type === "steps"
      ? <StepGroup key={item.id} steps={item.steps} live={turnLive && !item.past && index === items.length - 1} home={home} />
      : item.message.who === "notice"
        ? <div key={item.message.id} className="chat-notice" role="status">{item.message.text}</div>
        : <ChatMessageView key={item.message.id} message={item.message} outbox={outbox[item.message.id]} running={running} onResend={() => onResend(item.message.id, item.message.text)} />)}</div>{approvals.length > 0 && <div className="approval-stack">{approvals.map((request) => <ApprovalCard key={request.id} request={request} home={home} onAnswer={(optionId) => onAnswer(request.id, optionId)} />)}</div>}<div className="composer">{files.length > 0 && <ul className="file-chips composer-files" aria-label="Attached files">{files.map((file) => <li key={file.source} className="file-chip" title={`${file.source}\nCopied into the home when the message is sent`}><Paperclip size={13} /><span>{file.name}</span><small>{formatBytes(file.bytes)}</small><button onClick={() => onRemoveFile(file.source)} disabled={copying} title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`}><X size={12} /></button></li>)}</ul>}{attachProblems.length > 0 && <ul className="attach-problems" role="alert">{attachProblems.map((problem, index) => <li key={index}>{problem}</li>)}<li><button onClick={onDismissProblems} title="Dismiss" aria-label="Dismiss"><X size={12} /></button></li></ul>}<textarea ref={composer} value={draft} readOnly={copying} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} aria-label="Message the first mate" /><div><span className="chat-status" title={`First Mate: ${hostLabel}`}><i className={`state-${runtime} ${degraded ? "degraded" : ""}`} />{hostLabel}</span><span className="composer-hint">⏎ to send · ⇧⏎ for a new line</span><button className="icon-button" onClick={onRestart} title="Restart the first mate"><RefreshCw size={15} /></button><button className="attach-button" onClick={onAttach} disabled={attaching || copying} title="Attach files for the first mate to read">{attaching ? "Attaching…" : "Attach"}</button><button className="send-button" onClick={onSend} disabled={(!draft.trim() && files.length === 0) || !sendReady || copying} title={sendReady ? "Send message" : "Start the first mate to send messages"}>{copying ? "Sending…" : "Send"}</button></div></div></div>;
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

/** How far a captain's message has got with the first mate, and what that means, for its footer. */
function delivery(message: ChatMessage, outbox: OutboxView | undefined, running: boolean) {
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
  return { status, tooltip };
}

function ChatMessageView({ message, outbox, running, onResend }: { message: ChatMessage; outbox?: OutboxView; running: boolean; onResend: () => void }) {
  const { status, tooltip } = delivery(message, outbox, running);
  const resendAction = !outbox?.error ? null : outbox.resent
    ? <span className="resent-note">Sent again</span>
    : <button onClick={onResend}>{outbox.errorKind === "not_sent" ? "Retry" : "Send again"}</button>;
  // A message from a resumed session's history has no time or delivery status to show.
  const footer = status
    ? <><div className={`message-state ${outbox?.error ? "message-error" : ""}`} title={tooltip}><time>{status}</time>{resendAction}</div>{outbox?.error && <small className="message-reason">{outbox.error}</small>}</>
    : !message.past && <time>{formatTime(message.createdAt)}</time>;
  // A captain's message names its attached files in its words; they show as files, the same live and in history.
  const said = message.who === "mate" ? null : splitAttachments(message.text);
  return <article className={`${message.who === "mate" ? "mate-message" : "captain-message"} ${message.past ? "past" : ""}`}>{message.who === "mate" && <span className="avatar small">FM</span>}<div><strong>{message.who === "mate" ? "First Mate" : "You"}</strong>{!said ? <MateText text={message.text} /> : <>{said.text && <p>{said.text}</p>}{said.files.length > 0 && <ul className="file-chips message-files" aria-label="Attached files">{said.files.map((file) => <li key={file.path} className="file-chip" title={file.path}><Paperclip size={13} /><span>{file.name}</span>{file.size && <small>{file.size}</small>}</li>)}</ul>}</>}{footer}</div></article>;
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
  const body = bodyBlocks(record?.body_lines, record?.body_excerpt);
  const notes = useTaskNotes(task.id);
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
  const panel = useDrawerDismiss(onClose);
  return <div className="drawer-backdrop passive"><aside className="task-drawer" ref={panel}>
    <header className="drawer-header"><div><span>{projectName(task.project)}</span><h2 data-testid="drawer-title">{title}</h2><small className="drawer-id">{task.id}</small></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header>
    <div className="drawer-status"><span className={`task-state tone-${status.tone}`}>{status.icon}</span><div><strong className={`tone-${status.tone}`}>{stateLabel(task.current_state.state)}</strong>{statusDetail && <span>{statusDetail}</span>}</div>{started?.exact && <time className="drawer-age" data-testid="drawer-age" title={`Started ${formatStart(started)}`}>{formatDuration(now - started.ms)}</time>}</div>
    <div className="drawer-scroll">
      <TaskFiles taskId={task.id} notes={notes.notes} />
      {body.length > 0 && <DrawerSection title="What was asked"><TaskBody blocks={body} /></DrawerSection>}
      <DrawerSection title="Latest from the worker"><div className="brief-block"><p>{lastEvent.note || "The worker hasn't written a note yet."}</p></div></DrawerSection>
      <TaskNotesThread read={notes} running={LIVE_STATES.has(task.current_state.state)} closed={false} />
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

function ArtifactRow({ artifact, detail, review, landed, stake, card, onOpen }: { artifact: Artifact; detail: string; review?: ReviewSummary[string]; landed?: boolean; stake?: { label: string; tone: string }; card?: boolean; onOpen: () => void }) {
  const note = layoutNote(artifact.latest);
  const chip = reviewChip(review, artifact, landed);
  if (card) return <button className="artifact-row card" onClick={onOpen}>
    <span className="artifact-thumb" aria-hidden="true" />
    <span className="artifact-copy">
      <strong>{artifact.title}</strong>
      <small>{detail}</small>
      <span className="artifact-chips">{stake && <span className={`artifact-stake tone-${stake.tone}`}>{stake.label}</span>}{chip && <span className={`review-chip ${chip.tone}`}>{chip.label}</span>}{note && <span className="artifact-flag" title={note.issues.map((issue) => issue.detail).join("\n")}>{note.label}</span>}</span>
    </span>
  </button>;
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
  { id: "needs-you", title: "Open for review", blank: "Nothing is open for your review right now." },
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

  /** What rides on a page still in play: a call it argues, or the kind of work that wrote it. */
  const stakeOf = (artifact: Artifact) => {
    if (callsArguedBy(calls, artifact).some(isOpen)) return { label: "A decision rides on this", tone: "coral" };
    const task = artifact.scope === "task" ? tasks.find((candidate) => candidate.id === artifact.task) : undefined;
    if (task?.kind === "scout") return { label: "Scout report", tone: "muted" };
    return undefined;
  };
  const row = (artifact: Artifact, standing: ArtifactStanding) => <ArtifactRow
    key={`${artifact.scope}/${artifact.task}/${artifact.name}`}
    artifact={artifact}
    detail={`${artifactOwner(artifact, tasks)} · ${revisionLine(artifact)}`}
    review={reviews[artifactKey(artifact)]}
    landed={standing === "settled"}
    card={standing !== "settled"}
    stake={standing !== "settled" ? stakeOf(artifact) : undefined}
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
                <h2>{standing.title}</h2><span className="section-count">{pages.length}</span>{openSettled ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            : <div className="artifact-group-heading static"><h2>{standing.title}</h2><span className="section-count">{pages.length}</span></div>}
          {!folded && <div className={`artifact-list ${standing.id === "settled" ? "rows" : "cards"}`}>{pages.map((artifact) => row(artifact, standing.id))}</div>}
        </section>;
      })}
  </div>;
}

function ArtifactChatCard({ artifact, revision, tasks, reviews, onOpen }: { artifact: Artifact; revision: ArtifactRevision; tasks: FleetTask[]; reviews?: ReviewSummary; onOpen: () => void }) {
  const from = revision.presented_by.role === "firstmate" ? "The first mate shared a page" : `${artifactOwner(artifact, tasks)} ${revision.rev === 1 ? "shared a page" : `revised a page · Rev ${revision.rev}`}`;
  // A revision that answers the captain's comments says so, since the review card above is where they are settled.
  const sentIds = new Set((reviews?.[reviewKey(artifact)]?.threads ?? []).map((thread) => thread.id));
  const answering = [...(revision.answers?.addressed ?? []), ...(revision.answers?.replies ?? []).map((reply) => reply.thread)].filter((id, index, all) => sentIds.has(id) && all.indexOf(id) === index);
  return <article className="artifact-card" data-testid="artifact-card"><span className="artifact-thumb" aria-hidden="true" /><div><strong>{revision.title}</strong><small>{from} · <time>{formatWhen(revision.presented_at)}</time></small>{revision.note && <p>{revision.note}</p>}{answering.length > 0 && <p className="artifact-card-answers" data-testid="answers-review">Answers {answering.length === 1 ? "your comment" : `${answering.length} of your comments`}: {answering.join(", ")}</p>}</div><button onClick={onOpen}>Open review</button></article>;
}

const VERDICT_WORDS: Record<ReviewVerdict, string> = { changes: "Requests changes", approve: "Approved", comment: "Comments only" };

/**
 * A review the captain sent, drawn as what it is rather than the text written for the first mate: the page, the
 * verdict, each comment with its words, what the author's later revisions say about each, and what is settled. It
 * follows the review from sent to settled, then shrinks to one line, the way an answered call does. The text the
 * first mate got stays one click away.
 */
function ReviewChatCard({ message, sent, outbox, running, tasks, onOpen, onSettle }: { message: ChatMessage; sent: SentPage; outbox?: OutboxView; running: boolean; tasks: FleetTask[]; onOpen: (rev?: number) => void; onSettle: (threads: string[]) => Promise<unknown> }) {
  const { artifact, review } = sent;
  const [settling, setSettling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const title = artifact?.title ?? sent.ref.name;
  const threads = review.threads.map((id) => sent.threads.find((thread) => thread.id === id)).filter((thread): thread is SentThread => Boolean(thread));
  const answers = artifact ? authorAnswers(artifact) : {};
  const answerOf = (thread: SentThread) => {
    const answer = answers[thread.id];
    return answer && answer.rev > thread.rev ? answer : undefined;
  };
  const answeredIn = Math.max(0, ...threads.map((thread) => answerOf(thread)?.rev ?? 0));
  // The revision the comments were written on, which is where a review's story starts.
  const writtenOn = Math.min(review.rev, ...threads.map((thread) => thread.rev));
  const settleable = threads.filter((thread) => thread.state === "open" && answerOf(thread)).map((thread) => thread.id);
  const settle = async (ids: string[]) => {
    setSettling(true);
    setProblem(null);
    try {
      await onSettle(ids);
    } catch (error) {
      setProblem(`That did not settle: ${String(error)}`);
    } finally {
      setSettling(false);
    }
  };
  if (threads.length > 0 && threads.every((thread) => thread.state === "resolved")) {
    return <article className="review-card settled" data-testid="review-card" data-state="settled">
      <CheckCheck size={15} />
      <span><strong>Review of {title} settled</strong> · {threads.length === 1 ? "1 comment" : `${threads.length} comments`} · rev {writtenOn}{answeredIn > writtenOn ? ` → rev ${answeredIn}` : ""}</span>
      {artifact && <button onClick={() => onOpen(answeredIn || review.rev)}>Open</button>}
    </article>;
  }
  const { status, tooltip } = delivery(message, outbox, running);
  const task = artifact?.scope === "task" ? tasks.find((candidate) => candidate.id === artifact.task) : undefined;
  const working = task && LIVE_STATES.has(task.current_state.state) && !answeredIn ? `${task.id} · ${stateLabel(task.current_state.state)}` : null;
  const where = artifact?.scope === "task" ? artifact.task : "Shared in chat";
  return <article className="review-card" data-testid="review-card" data-state={answeredIn ? "answered" : "sent"}>
    <header>
      <span className="review-card-kicker">Your review</span>
      <strong>{title}</strong>
      <small>{where} · Rev {review.rev} · <em className={`review-verdict ${review.verdict}`}>{VERDICT_WORDS[review.verdict] ?? review.verdict}</em></small>
    </header>
    {threads.length === 0 && <p className="review-card-empty">No comments on the page itself.</p>}
    {threads.length > 0 && <ul className="review-card-threads">
      {threads.map((thread) => {
        const answer = answerOf(thread);
        return <li key={thread.id} data-thread={thread.id}>
          <span className="thread-id">{thread.id}</span>
          <div>
            {thread.quote && <blockquote>{thread.quote}</blockquote>}
            <p>{thread.said}</p>
            {answer && <div className="thread-answer"><strong>{answer.reply ? `Answered in rev ${answer.rev}` : `Changed in rev ${answer.rev}`}</strong>{answer.reply && <p>{answer.reply}</p>}</div>}
          </div>
          <span className="review-card-marks">
            {thread.picture && <span className="review-card-picture" title="Sent with a picture of this place"><Camera size={13} /></span>}
            {thread.state === "resolved"
              ? <em className="thread-state settled">Settled</em>
              : answer && <button className="icon-button" title="Settle this" disabled={settling} onClick={() => void settle([thread.id])}><CheckCheck size={14} /></button>}
          </span>
        </li>;
      })}
    </ul>}
    {review.answers.length > 0 && <ul className="file-chips review-card-answers">{review.answers.map((answer) => {
      // An option went through the intake; words went in the message, for the first mate to record.
      const said = answer.option === null ? answerInWords(answer.defer, answer.note ?? "") : answer.label || answer.option;
      return <li key={answer.decision} className="file-chip" title={said}><Check size={13} /><span>{said}</span><small>{answer.option === null ? "sent" : "recorded"}</small></li>;
    })}</ul>}
    <footer className="message-state review-card-trail">
      {status && <time title={tooltip}>{status === "Reading" ? "With the first mate" : status.startsWith("Read by") ? `Read by the first mate ${status.slice("Read by ".length)}` : status}</time>}
      {!status && !message.past && <time>{formatTime(message.createdAt)}</time>}
      {working && <span className="review-card-live">{working}</span>}
      {answeredIn > 0 && <span className="review-card-answered">Answered in rev {answeredIn}</span>}
    </footer>
    {(answeredIn > 0 || settleable.length > 0) && <div className="review-card-actions">
      {artifact && answeredIn > 0 && <button className="primary" onClick={() => onOpen(answeredIn)}>Open rev {answeredIn}</button>}
      {settleable.length > 0 && <button onClick={() => void settle(settleable)} disabled={settling}>{settleable.length === 1 ? "Settle it" : `Settle all ${settleable.length}`}</button>}
    </div>}
    {problem && <p className="review-card-problem" role="alert">{problem}</p>}
    <details className="review-card-text"><summary>What the first mate was sent</summary><pre>{message.text}</pre></details>
  </article>;
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

/** A whole number of CSS pixels a page could plausibly measure, or nothing. */
function pageNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? Math.round(value) : null;
}

function pageBoxOf(value: unknown): PageBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const box = value as Record<string, unknown>;
  const [x, y, w, h] = [box.x, box.y, box.w, box.h].map(pageNumber);
  return x === null || y === null || w === null || h === null || w < 0 || h < 0 ? undefined : { x, y, w, h };
}

const PICTURE_REASONS: PictureReason[] = ["repeated", "opened", "wordless"];

/** Why a picture is on for a pick, in the captain's words. */
const PICTURE_WHY: Record<PictureReason, string> = {
  repeated: "These words are in more than one place",
  opened: "It's inside something you opened",
  wordless: "There are no words of its own here",
};

function pageAnchor(value: unknown): ReviewAnchor | null {
  if (!value || typeof value !== "object") return null;
  const anchor = value as Record<string, unknown>;
  const quote = text(anchor.quote, 400);
  if (!quote.trim()) return null;
  const kept: ReviewAnchor = { quote, prefix: text(anchor.prefix, 200), suffix: text(anchor.suffix, 200), path: text(anchor.path, 600) };
  const element = text(anchor.element, 600);
  if (element) kept.element = element;
  const near = text(anchor.near, 200);
  if (near) kept.near = near;
  const occurrence = anchor.occurrence as Record<string, unknown> | null | undefined;
  const [n, of, shown] = [occurrence?.n, occurrence?.of, occurrence?.shown].map(pageNumber);
  if (n !== null && of !== null && n >= 1 && n <= of) kept.occurrence = { n, of, shown: shown === null ? of : Math.min(shown, of) };
  const box = pageBoxOf(anchor.box);
  if (box) kept.box = box;
  const point = anchor.point as Record<string, unknown> | undefined;
  const [px, py] = [point?.x, point?.y].map(pageNumber);
  if (px !== null && py !== null) kept.point = { x: px, y: py };
  const view = anchor.view as Record<string, unknown> | undefined;
  const [vw, vh, scrolled] = [view?.w, view?.h, view?.scroll_y].map(pageNumber);
  if (vw !== null && vh !== null && scrolled !== null && (view?.scheme === "light" || view?.scheme === "dark")) kept.view = { w: vw, h: vh, scroll_y: scrolled, scheme: view.scheme };
  const reasons = Array.isArray(anchor.reasons) ? PICTURE_REASONS.filter((reason) => (anchor.reasons as unknown[]).includes(reason)) : [];
  if (reasons.length) kept.reasons = reasons;
  return kept;
}

/** A picture the page drew around a pick: only a JPEG of a sane size, and what part of the page it shows. */
function pagePicture(value: Record<string, unknown>): PagePicture | null {
  const jpeg = typeof value.jpeg === "string" && value.jpeg.startsWith("data:image/jpeg;base64,") && value.jpeg.length <= 3_000_000 ? value.jpeg : null;
  const crop = pageBoxOf(value.crop);
  const took = pageNumber(value.took_ms);
  return jpeg && crop && crop.w > 0 && crop.h > 0 ? { jpeg, crop, took_ms: took ?? 0 } : null;
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
function reviewStake(artifact: Artifact, tasks: FleetTask[], backlog: Map<string, BacklogRecord>, known: Call[], staged: ReviewView["answers"] = []): ReviewStake {
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
  if (calls.length > 0 && calls.every((call) => staged.some((answer) => answer.decision === call.id))) {
    // An option is recorded as the review goes; words go to the first mate, who records them.
    const words = staged.some((answer) => answer.option === null);
    const [goes, still] = words ? ["goes to the first mate", "still goes to the first mate"] : ["is recorded", "is still recorded"];
    return { verdict: "approve", hints: { approve: `The case reads well, and your answer ${goes} as it is sent.`, changes: `Asks for another revision; your answer ${still} as it is sent.`, comment: `Thoughts only; your answer ${still} as it is sent.` } };
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

/** The picture the page drew around a thread's place, kept beside the review. */
function placePicture(thread: ReviewThread, url: string) {
  if (thread.picture_preview) return thread.picture_preview;
  const file = thread.picture?.file;
  if (!file?.startsWith("review-files/")) return undefined;
  const base = url.slice(0, url.lastIndexOf("/rev-"));
  return `${base}/review-files/${encodeURIComponent(file.slice("review-files/".length))}`;
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
  onComment: (body: string, anchor?: ReviewAnchor, thread?: string, picture?: CommentPicture) => Promise<unknown>;
  onDiscard: (thread: string) => Promise<unknown>;
  /** Resolves to a warning when the review went only partly: answers recorded, message not sent. */
  onSubmit: (verdict: ReviewVerdict) => Promise<string | undefined>;
  onSettle: (thread: string, resolved: boolean) => Promise<unknown>;
  onSeen: (rev: number) => Promise<unknown>;
  /** Every call whose evidence contains this page. */
  calls: Call[];
  onAnswer: (call: Call, answer: RailAnswer) => Promise<unknown>;
  onScene: (place: ScenePlace, proposal: SceneProposal) => Promise<unknown>;
}) {
  const [narrow, setNarrow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [pending, setPending] = useState<ReviewAnchor | null>(null);
  // The page draws every pick; the comment keeps the drawing only while Picture is on.
  const [pick, setPick] = useState<number | null>(null);
  const [withPicture, setWithPicture] = useState(false);
  const [drawn, setDrawn] = useState<Record<number, PagePicture | { error: string }>>({});
  const drawnNow = useRef(drawn);
  drawnNow.current = drawn;
  const waitingFor = useRef(new Map<number, (result: PagePicture | { error: string }) => void>());
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
  const [saving, setSaving] = useState(false);
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
        setPick(typeof data.pick === "number" && Number.isSafeInteger(data.pick) ? data.pick : null);
        setWithPicture((anchor.reasons?.length ?? 0) > 0);
        setCommenting(false);
      } else if (data.type === "qd:pictured") {
        if (typeof data.pick !== "number") return;
        const pickId = data.pick;
        const result = pagePicture(data) ?? { error: text(data.error, 200) || "the page could not draw itself" };
        setDrawn((current) => ({ ...current, [pickId]: result }));
        waitingFor.current.get(pickId)?.(result);
        waitingFor.current.delete(pickId);
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

  /** A page that loads again counts its picks from the start, so what it drew before names nothing in it now. */
  function forgetPicks() {
    for (const resolve of waitingFor.current.values()) resolve({ error: "the page reloaded before it finished drawing" });
    waitingFor.current.clear();
    drawnNow.current = {};
    setDrawn({});
    setPick(null);
    setPending(null);
    setWithPicture(false);
  }

  /** The picture a new comment goes with, waiting briefly for the page to finish drawing it. */
  async function pictureFor(anchor: ReviewAnchor): Promise<CommentPicture | undefined> {
    if (!withPicture || pick === null) return anchor.reasons?.length ? { skipped: "the captain left the picture out" } : undefined;
    const current = pick;
    const result = drawnNow.current[current] ?? await new Promise<PagePicture | { error: string }>((resolve) => {
      waitingFor.current.set(current, resolve);
      setTimeout(() => resolve({ error: "the page took too long to draw itself" }), 4000);
    });
    return "jpeg" in result ? result : { skipped: result.error };
  }

  async function save() {
    const body = draft.trim();
    if (!body || !pending) return;
    setProblem(null);
    setSaving(true);
    try {
      await onComment(body, pending, undefined, await pictureFor(pending));
      setDraft("");
      setPending(null);
      setPick(null);
    } catch (error) {
      setProblem(String(error));
    } finally {
      setSaving(false);
    }
  }

  // Words still being typed into a call, staged before the review goes so it never leaves without them.
  const typing = useRef(new Map<string, () => Promise<unknown>>());

  async function send() {
    setSending(true);
    setProblem(null);
    try {
      await Promise.all([...typing.current.values()].map((flush) => flush()));
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
        <iframe ref={frame} title={revision.title} src={url} sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" onLoad={() => { setLoaded(true); setMissing([]); forgetPicks(); }} />
      </div>
      <aside className="review-rail" aria-label="Your review">
        <header className="review-head"><strong>Your review</strong><small>{calls.some(isOpen) ? `Answering here also closes the captain's call on ${calls.filter(isOpen).length === 1 ? "this decision" : "these decisions"}.` : "Write on a part of the page, then send it all at once."}</small></header>
        {pending && <section className="comment-composer">
          <blockquote>{pending.quote.length > 160 ? `${pending.quote.slice(0, 160)}…` : pending.quote}</blockquote>
          {pick !== null && <PictureChoice on={withPicture} reasons={pending.reasons ?? []} drawn={drawn[pick]} onToggle={() => setWithPicture((current) => !current)} />}
          <textarea autoFocus value={draft} placeholder="What should change here?" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save(); if (event.key === "Escape") { setPending(null); setPick(null); setDraft(""); } }} />
          <div><button className="ghost" onClick={() => { setPending(null); setPick(null); setDraft(""); }}>Cancel</button><button disabled={!draft.trim() || saving} onClick={() => void save()}>{saving ? "Saving…" : "Comment"}</button></div>
        </section>}
        {review && calls.length > 0 && <div className="decision-answers">
          {calls.map((call) => <RailCall key={call.id} call={call} revision={revision} chosen={review.answers.find((answer) => answer.decision === call.id)} before={review.earlier.find((answer) => answer.decision === call.id)} onAnswer={(answer) => onAnswer(call, answer)} onPending={(flush) => { if (flush) typing.current.set(call.id, flush); else typing.current.delete(call.id); }} />)}
        </div>}
        <div className="review-threads">
          {threads.length === 0 && !pending && calls.length === 0 && <p className="review-empty">Nothing written yet. Use Comment, then pick the words or the part of the page you mean.</p>}
          {live.map((thread) => <ReviewThreadCard key={thread.id} thread={thread} answer={answers[thread.id]} rev={revision.rev} missing={missing.includes(thread.id)} picture={proposalPicture(thread, url) ?? placePicture(thread, url)} onFocus={() => tell({ type: "qd:focus", id: thread.id })} onDiscard={() => void onDiscard(thread.id)} onSettle={(resolved) => void onSettle(thread.id, resolved)} />)}
          {settled.length > 0 && <button className="settled-toggle" aria-expanded={showSettled} onClick={() => setShowSettled((current) => !current)}><ChevronRight size={13} className={showSettled ? "rotated" : ""} /> {settled.length} settled</button>}
          {showSettled && settled.map((thread) => <ReviewThreadCard key={thread.id} thread={thread} answer={answers[thread.id]} rev={revision.rev} missing={missing.includes(thread.id)} picture={proposalPicture(thread, url) ?? placePicture(thread, url)} onFocus={() => tell({ type: "qd:focus", id: thread.id })} onDiscard={() => void onDiscard(thread.id)} onSettle={(resolved) => void onSettle(thread.id, resolved)} />)}
        </div>
        <div className="review-send">
          {calls.some(isOpen) && <span className="review-send-label">Answer the decision</span>}
          {problem && <p className="review-problem" role="alert">{problem}</p>}
          {lastSent && draftCount === 0 && <p className="review-last">Sent {formatWhen(new Date(lastSent.at).toISOString())} · {VERDICTS.find((item) => item.id === lastSent.verdict)?.label ?? lastSent.verdict}</p>}
          <label className="verdict-picker"><span className="sr-only">Verdict</span><select value={verdict} onChange={(event) => { setVerdictChosen(true); setVerdict(event.target.value as ReviewVerdict); }}>{VERDICTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><ChevronDown size={14} /></label>
          <button className="send-review" disabled={!sendReady || sending} title={sendHint} onClick={() => void send()}>{sending ? "Sending…" : draftCount > 0 ? `Send review · ${draftCount}` : "Send review"}</button>
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
 * Whether a new comment goes with a picture of its place. It starts on when the words alone may not say which place
 * was meant, says why, and shows what the author would see. The picture is the page redrawing itself, not a
 * screenshot, and the author is told so.
 */
function PictureChoice({ on, reasons, drawn, onToggle }: { on: boolean; reasons: PictureReason[]; drawn?: PagePicture | { error: string }; onToggle: () => void }) {
  const why = reasons.map((reason) => PICTURE_WHY[reason]).join(" · ");
  const reason = why ? `${why}. ` : "";
  const status = !on
    ? (why ? `Left out. ${why}.` : "The words say where this is.")
    : !drawn
      ? `${reason}Drawing the page…`
      : "error" in drawn
        ? `${reason}Couldn't draw the page: ${drawn.error}. The comment goes without it.`
        : `${reason}The author gets this picture, a redraw of the page with the place outlined.`;
  return <div className={`picture-choice ${on ? "on" : ""}`} data-testid="picture-choice">
    <button type="button" className="picture-toggle" aria-pressed={on} onClick={onToggle} title={on ? "Send this comment without a picture" : "Send a picture of this place with the comment"}>{on ? <Camera size={14} /> : <CameraOff size={14} />} Picture</button>
    <div>
      {on && drawn && "jpeg" in drawn && <img src={drawn.jpeg} alt="The page redrawn around the place you picked, with it outlined" />}
      <small>{status}</small>
    </div>
  </div>;
}

/** What the rail stages for a call: an option, words, or not now until a day. Nothing at all takes it back. */
type RailAnswer = { option?: OptionChoice; words?: AnswerWords };

/**
 * A call this page argues, in the review rail. Open, it offers every way to answer it that Bearings does: its own
 * options, not now until a day, and words. What the captain says is staged with the review; as the review goes, an
 * option is recorded through firstmate's intake, and words go in its message for the first mate to record. Answered
 * anywhere, it says by whom and how, instead of offering choices that could no longer do anything.
 */
function RailCall({ call, revision, chosen, before, onAnswer, onPending }: {
  call: Call;
  revision: ArtifactRevision;
  chosen?: ReviewView["answers"][number];
  /** The last answer that went for the first mate to record and was followed by a new one. */
  before?: ReviewView["answers"][number];
  onAnswer: (answer: RailAnswer) => Promise<unknown>;
  /** Hands the review a way to stage words still being typed, so sending never goes without them. */
  onPending: (flush: (() => Promise<unknown>) | null) => void;
}) {
  const recorded = chosen?.recorded?.result === "closed";
  const refused = chosen?.recorded && !recorded ? chosen.recorded : null;
  // Sent without the intake: words, or an option from before the app recorded answers itself. The first mate records it;
  // while firstmate still asks the captain, it is what they said then, and the call takes a new answer.
  const handed = chosen !== undefined && chosen.sent_at !== null && !chosen.recorded;
  const anew = handed && isOpen(call);
  const handedOver = handed && !anew;
  const locked = recorded || handedOver;
  const current = anew ? undefined : chosen;
  const then = anew ? chosen : before;
  const updated = !call.answer && optionsUpdatedSince(call, revision.presented_at);
  const when = (at: number) => formatWhen(new Date(at).toISOString());
  const picked: OptionChoice | null = current && !refused ? call.options.find((option) => option.key === current.option) ?? null : null;
  const [deferring, setDeferring] = useState(Boolean(current?.defer));
  const [deferDate, setDeferDate] = useState(current?.defer ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  useEffect(() => {
    if (!anew) return;
    setDeferring(false);
    setDeferDate("");
    setNote("");
  }, [anew]);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ picked, deferring, deferDate, note });
  latest.current = { picked, deferring, deferDate, note };

  /** Stages what the rail says now. Not now waits for its day, so until then it takes the answer back. */
  function stage(next: Partial<typeof latest.current> = {}) {
    if (typing.current) clearTimeout(typing.current);
    typing.current = null;
    onPending(null);
    const { picked: option, deferring: later, deferDate: day, note: words } = { ...latest.current, ...next };
    if (later) return onAnswer(day ? { words: { defer: day, note: words } } : {});
    return onAnswer({ option: option ?? undefined, words: { note: words } });
  }

  // Answered or closed some other way, the call takes back what waits here, so it never goes with a later review.
  const settled = call.answer !== null || call.state !== "open";
  const waiting = chosen !== undefined && chosen.sent_at === null && !chosen.recorded;
  useEffect(() => {
    if (settled && waiting) void stage({ picked: null, deferring: false, deferDate: "", note: "" });
  }, [settled, waiting]);

  function type(words: string) {
    setNote(words);
    if (typing.current) clearTimeout(typing.current);
    const flush = () => stage({ note: words });
    typing.current = setTimeout(() => void flush(), 500);
    onPending(flush);
  }
  useEffect(() => () => { if (typing.current) clearTimeout(typing.current); }, []);

  const worded = chosen !== undefined && chosen.option === null;
  const said = chosen && (chosen.note || chosen.defer) ? answerInWords(chosen.defer, chosen.note ?? "") : "";
  const saidThen = then ? [then.label, answerInWords(then.defer, then.note ?? "")].filter(Boolean).join(". ") : "";
  return <section className="decision-answer" data-testid="decision-answer" data-call-id={call.id}>
    <header><span>Your call</span><small>{call.id}</small></header>
    {call.question && <p>{call.question}</p>}
    {updated && <small className="decision-updated" data-testid="options-updated">Options updated since rev {revision.rev}</small>}
    {call.answer
      ? <p className="decision-answered" data-testid="call-answered"><Check size={13} /><span>{answeredBy(call.answer)}: <strong>{call.answer.label}</strong></span></p>
      : locked
        ? <>
            {!worded && <div className="decision-choices">{call.options.map((option) => <button key={option.key} className={chosen?.option === option.key ? "selected" : ""} aria-pressed={chosen?.option === option.key} disabled><span>{option.label}</span>{option.recommended && <small>Recommended</small>}</button>)}</div>}
            {said && <blockquote className="decision-words" data-testid="answer-words">{worded ? said : `You added: ${said}`}</blockquote>}
          </>
        : <>
            {then && saidThen && <blockquote className="decision-words" data-testid="answer-earlier">You said in your review, {when(then.sent_at!)}: {saidThen}</blockquote>}
            {call.options.length === 0 && <small className="decision-missing" data-testid="options-missing">This page argues a call whose options are not recorded, so answer it in words.</small>}
            <CallAnswerFields
              call={call}
              layout="list"
              picked={picked?.key ?? null}
              deferring={deferring}
              deferDate={deferDate}
              note={note}
              adding={picked !== null || deferring}
              disabled={false}
              onPick={(option) => { const next = picked?.key === option.key ? null : option; setDeferring(false); setDeferDate(""); void stage({ picked: next, deferring: false, deferDate: "" }); }}
              onDefer={() => { const next = !deferring; setDeferring(next); void stage({ picked: null, deferring: next }); }}
              onDate={(day) => { setDeferDate(day); void stage({ deferDate: day }); }}
              onNote={type}
            />
          </>}
    {!call.answer && (refused
      ? <small className="decision-refused" role="alert">Not recorded: {refused.detail}</small>
      : recorded
        ? <small className="decision-sent">Recorded {when(chosen!.recorded!.at)}</small>
        : handedOver
          ? <small className="decision-sent">Sent {when(chosen!.sent_at!)}{worded ? ", for the first mate to record" : ""}</small>
          : current
            ? <small className="decision-staged">{worded ? "Goes with your review, for the first mate to record" : "Goes with your review, and is recorded as it is sent"}</small>
            : deferring && !deferDate
              ? <small className="decision-staged pending">Pick the day to be asked again</small>
              : null)}
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
    {picture && <img className="thread-picture" src={picture} alt={thread.anchor && "scene" in thread.anchor ? `The diagram as you proposed it: ${threadQuote(thread)}` : `The page redrawn around ${threadQuote(thread)}, with it outlined`} />}
    {thread.comments.map((comment, index) => <p key={index}>{comment.body}</p>)}
    {answered && <div className="thread-answer"><strong>{answer.reply ? `Answered in rev ${answer.rev}` : `Changed in rev ${answer.rev}`}</strong>{answer.reply && <p>{answer.reply}</p>}</div>}
    {missing && <small className="thread-missing">Not found in this revision.</small>}
    {thread.rev !== rev && <small className="thread-rev">Written on rev {thread.rev}</small>}
  </article>;
}

/** Whether a task file is a picture the drawer can show; the app's scheme serves nothing else of a task's files. */
const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

type NotesRead = { status: "loading" | "ready" | "unsupported" | "error"; notes: TaskNote[]; error?: string };

/**
 * The notes and files a task carries, read through firstmate's `fm-task-note.sh` when its details open, and the
 * captain's own added through the same script. A firstmate without it reads as `unsupported` and shows nothing.
 */
function useTaskNotes(taskId: string) {
  const [read, setRead] = useState<NotesRead>({ status: "loading", notes: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setRead((current) => ({ status: "loading", notes: current.notes }));
    host.taskNotes(taskId).then(
      (found) => { if (active) setRead(found ? { status: "ready", notes: found.notes } : { status: "unsupported", notes: [] }); },
      (error) => { if (active) setRead({ status: "error", notes: [], error: String(error) }); },
    );
    return () => { active = false; };
  }, [taskId, attempt]);
  const add = async (body: string, sources: string[]) => {
    const found = await host.taskNoteAdd(taskId, body, sources);
    setRead({ status: "ready", notes: found.notes });
  };
  return { ...read, add, retry: () => setAttempt((count) => count + 1) };
}

/** Who added a note, in the captain's words. */
function noteAuthor(by: string) {
  if (by === "captain") return "You";
  if (by === "firstmate") return "The first mate";
  return by;
}

/** A picture shown whole over the window. Escape or a press anywhere closes it, and only it. */
function PictureView({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopImmediatePropagation(); onClose(); } };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onClose]);
  return <div className="picture-view" role="dialog" aria-label={alt} data-testid="picture-view" onClick={onClose}><img src={src} alt={alt} /></div>;
}

/**
 * Every file the task's notes carry, newest last: a picture as a thumbnail that opens whole, anything else by name.
 * Each shows the path a worker is handed, since that is what the file is to whoever works the task.
 */
function TaskFiles({ taskId, notes }: { taskId: string; notes: TaskNote[] }) {
  const [shown, setShown] = useState<TaskFile | null>(null);
  const files = notes.flatMap((note) => note.files.map((file) => ({ file, note })));
  if (files.length === 0) return null;
  return <DrawerSection title={files.length === 1 ? "File" : `Files · ${files.length}`}>
    <div className="task-files" data-testid="task-files">{files.map(({ file, note }) => {
      const picture = PICTURE.test(file.name);
      const detail = `${noteAuthor(note.by)} · ${formatWhen(note.at)} · ${formatBytes(file.bytes)}`;
      return <div className="task-file" key={file.path} data-testid="task-file">
        {picture
          ? <button className="task-file-thumb" onClick={() => setShown(file)} title="Show the whole picture"><img src={host.taskFileUrl(taskId, file)} alt={file.original} /></button>
          : <span className="task-file-thumb icon"><FileText size={18} /></span>}
        <span className="task-file-copy"><strong title={file.original}>{file.original}</strong><small>{detail}</small><code title="The path a worker is handed">{file.path}</code></span>
      </div>;
    })}</div>
    {shown && <PictureView src={host.taskFileUrl(taskId, shown)} alt={shown.original} onClose={() => setShown(null)} />}
  </DrawerSection>;
}

/**
 * What whoever works the task must know, beyond what was asked: evidence, a change of scope, a decision about the
 * work. It is a record on the task, not a conversation, so it has no replies; `running` says the worker already has
 * its instructions and is not told of a note added now.
 */
function TaskNotesThread({ read, running, closed }: { read: ReturnType<typeof useTaskNotes>; running: boolean; closed: boolean }) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState<"picking" | "adding" | null>(null);
  if (read.status === "unsupported" || (closed && read.notes.length === 0 && read.status !== "error")) return null;
  const pick = async () => {
    setBusy("picking");
    try {
      const result = await host.pickFiles();
      if (!result) return;
      setFiles((current) => [...current.filter((kept) => !result.picked.some((file) => file.source === kept.source)), ...result.picked]);
      setProblems(result.refused.map((item) => item.problem));
    } catch (error) {
      setProblems([`The files could not be added: ${String(error)}`]);
    } finally {
      setBusy(null);
    }
  };
  const add = async () => {
    setBusy("adding");
    setProblems([]);
    try {
      await read.add(draft, files.map((file) => file.source));
      setDraft("");
      setFiles([]);
    } catch (error) {
      setProblems([String(error).replace(/^Error: /, "")]);
    } finally {
      setBusy(null);
    }
  };
  return <DrawerSection title="Notes">
    {read.status === "error" && <p className="notes-error" data-testid="notes-error">Couldn't read this task's notes. <button className="text-link" onClick={read.retry}>Try again</button></p>}
    {read.notes.length > 0 && <div className="task-notes" data-testid="task-notes">{read.notes.map((note) => {
      const body = bodyBlocks(note.body.split("\n"));
      return <article className={`task-note ${note.scope ? "scope" : ""}`} key={note.id} data-testid="task-note">
        <header><strong>{noteAuthor(note.by)}</strong>{note.scope && <span className="scope-tag">Changes scope</span>}<time>{formatWhen(note.at)}</time></header>
        {body.length > 0 && <TaskBody blocks={body} />}
        {note.files.length > 0 && <ul className="file-chips" aria-label="Files on this note">{note.files.map((file) => <li key={file.path} className="file-chip" title={file.path}><Paperclip size={13} /><span>{file.original}</span><small>{formatBytes(file.bytes)}</small></li>)}</ul>}
      </article>;
    })}</div>}
    {!closed && read.status !== "error" && <div className="note-composer" data-testid="note-composer">
      {files.length > 0 && <ul className="file-chips" aria-label="Files to add">{files.map((file) => <li key={file.source} className="file-chip" title={file.source}><Paperclip size={13} /><span>{file.name}</span><small>{formatBytes(file.bytes)}</small><button onClick={() => setFiles((current) => current.filter((kept) => kept.source !== file.source))} disabled={busy === "adding"} title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`}><X size={12} /></button></li>)}</ul>}
      {problems.length > 0 && <ul className="attach-problems" role="alert">{problems.map((problem, index) => <li key={index}>{problem}</li>)}<li><button onClick={() => setProblems([])} title="Dismiss" aria-label="Dismiss"><X size={12} /></button></li></ul>}
      <textarea value={draft} readOnly={busy === "adding"} onChange={(event) => setDraft(event.target.value)} placeholder="Evidence, or a change to what this task must do" aria-label="Add a note to this task" />
      <div>
        <span className="note-hint">{running ? "Kept on the task. The worker already running isn't told; ask the first mate if it needs this now." : "Kept on the task, and handed to whoever works it."}</span>
        <button className="attach-button" onClick={pick} disabled={busy !== null} title="Add files to this note">{busy === "picking" ? "Adding…" : "Files"}</button>
        <button className="send-button" onClick={add} disabled={busy !== null || (!draft.trim() && files.length === 0)}>{busy === "adding" ? "Adding…" : "Add to task"}</button>
      </div>
    </div>}
  </DrawerSection>;
}

/**
 * A drawer is not modal: a press anywhere outside it closes it and still does what it was aimed at, so a click on
 * the sidebar or another task is never swallowed by the drawer going away. Escape closes it too.
 */
function useDrawerDismiss(onClose: () => void) {
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
  return panel;
}

function BodySpans({ spans }: { spans: Span[] }) {
  return <>{spans.map((span, index) => span.code ? <code key={index}>{span.text}</code> : <Fragment key={index}>{span.text}</Fragment>)}</>;
}

/** A backlog row's body as its filer wrote it: a paragraph per line, their lists, and the labels that lead them. */
function TaskBody({ blocks }: { blocks: BodyBlock[] }) {
  return <div className="brief-block task-body" data-testid="task-body">{blocks.map((block, index) => block.type === "list"
    ? <ul key={index}>{block.items.map((item, at) => <li key={at}><BodySpans spans={item} /></li>)}</ul>
    : <p key={index}>{block.label && <strong className="body-label">{block.label}</strong>}<BodySpans spans={block.spans} /></p>)}</div>;
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
