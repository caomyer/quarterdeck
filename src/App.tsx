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
  CircleX,
  Clock3,
  ExternalLink,
  FileText,
  FolderGit2,
  FolderOpen,
  Gauge,
  GitBranch,
  Inbox,
  Menu,
  MessageSquarePlus,
  MessageSquareText,
  Monitor,
  Moon,
  PanelsTopLeft,
  Radio,
  RefreshCw,
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

import { type Artifact, type ArtifactRef, type ArtifactRevision, type BacklogRecord, createHostAdapter, type Decision, type DecisionOptions, type FleetTask, type HostRuntimeState, type ReasonKind, type ReviewAnchor, type ReviewSummary, type ReviewThread, type ReviewVerdict, type ReviewView } from "./host";
import { CheckCheck, RotateCcw, Shapes } from "lucide-react";
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

type Tone = "blue" | "green" | "coral" | "amber" | "muted";

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

function optionLabels(reason: string) {
  const optionLine = reason.match(/(?:^|\s)Options:\s*([^\n]+)$/i)?.[1]?.trim();
  if (!optionLine?.includes(";")) return [];
  const options = optionLine.replace(/[.]$/, "").split(";").map((item) => item.trim());
  if (options.some((item) => !item)) return [];
  return options.map((item) => ({
    label: item.replace(/,\s*recommended$/i, "").trim(),
    recommended: /,\s*recommended$/i.test(item),
  }));
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
    const byName = new Map<string, { tasks: FleetTask[]; mode?: string; yolo?: boolean }>();
    bridge.projects.forEach((project) => byName.set(project.name, { tasks: [], mode: project.mode, yolo: project.yolo }));
    fleet?.tasks.forEach((task) => {
      const name = projectName(task.project);
      const current = byName.get(name) ?? { tasks: [] };
      byName.set(name, { ...current, tasks: [...current.tasks, task] });
    });
    return [...byName.entries()].map(([name, project]) => ({
      name,
      tasks: project.tasks,
      posture: project.mode ? postureForProject(project.mode, project.yolo === true) : postureFor(project.tasks[0]),
    }));
  }, [bridge.projects, fleet]);

  const decisions = useMemo(() => bearings?.decisions_open.map((decision) => {
    const record = fleet?.backlog?.records.find((item) => item.id === decision.id);
    const recorded = fleet?.decision_options?.find((item) => item.task === decision.id);
    return {
      ...decision,
      title: record?.title ?? decision.key,
      summary: recorded?.question || record?.hold_reason || "",
      // Recorded options are the decision's own; the prose fallback is for holds nobody has recorded yet.
      options: recorded?.options.map((option) => ({ label: option.label, recommended: option.recommended })) ?? optionLabels(record?.hold_reason ?? ""),
      // The page that argues it, if one does: then that is where it is answered.
      page: (fleet?.artifacts ?? []).find((artifact) => (artifact.latest.covers ?? []).includes(decision.id)),
      // A review that already carried an answer for it. The call stays open until the first mate closes it.
      answeredIn: (fleet?.artifacts ?? []).find((artifact) => (reviews[artifactKey(artifact)]?.answered ?? []).includes(decision.id)),
    };
  }) ?? [], [bearings, fleet, reviews]);

  // Which message answered which call. The link this session made is authoritative; after a relaunch
  // the app has none, so a message still in the host's outbox is matched by the call it names.
  const callAnswers = useMemo(() => {
    const found: Record<string, string> = {};
    for (const message of messages) {
      // Only an answer still on its way is matched. A read one is already the first mate's business, so a
      // launch that finds nothing waiting asks rather than showing an answer that has been dealt with.
      if (message.who !== "captain" || !outbox[message.id] || outbox[message.id].status === "picked_up") continue;
      const call = decisions.find((decision) => answersCall(message.text, decision));
      if (call) found[call.id] = message.id;
    }
    return { ...found, ...callMessageIds };
  }, [messages, outbox, decisions, callMessageIds]);

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
  useEffect(() => {
    void host.reviewSummary().then(setReviews).catch(() => setReviews({}));
  }, [artifacts, review]);
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
  const openCallCount = bearings?.decisions_open.length ?? 0;
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
  if (!bridge.home) return <HomeSetup problem={bridge.homeProblem} choosing={bridge.choosingHome} onChoose={() => void bridge.chooseHome()} />;

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
              <span><strong>{project.name}</strong><small>{project.tasks.length} underway</small></span>
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
            {approvalCount > 0 && view === "bearings" && <ApprovalBanner count={approvalCount} onOpen={() => navigate("chat")} />}
            {!bearings && bridge.snapshotHealth.errors.length === 0 && <EmptyState label="Taking fresh bearings of this home…" />}
            {bearings && <>
            {ahoyVisible && (
              <section className="ahoy-card">
                <div className="ahoy-mark"><ShipWheel size={22} /></div>
                <div><span>Ahoy</span><h2>Welcome back.</h2><p>The first mate can catch you up and take you through what's waiting.</p><strong>{bearings.decisions_open.length} waiting on you · {bearings.in_flight.length} underway</strong></div>
                <div className="ahoy-actions"><button onClick={runAhoy}>Ahoy</button><button onClick={() => setAhoyVisible(false)}>Not now</button></div>
              </section>
            )}
            <DashboardSection title="Captain's Call" icon={<Inbox size={17} />} tone="coral" count={bearings.decisions_open.length}>
              {decisions.map((decision) => (
                <DecisionCard key={decision.id} decision={decision} state={outbox[callAnswers[decision.id]]} answerText={messages.find((message) => message.id === callAnswers[decision.id])?.text} runtime={runtime.state} onSend={(text) => answerCall(decision.id, text)} onStart={() => void bridge.start()} onReadArgument={decision.page ? () => showArtifact(decision.page!) : undefined} answeredIn={decision.answeredIn?.title} />
              ))}
              {bearings.decisions_open.length === 0 && <EmptyState label="Nothing needs your action right now." />}
            </DashboardSection>

            <DashboardSection title="Recently Landed" icon={<Check size={17} />} tone="green" count={bearings.landed.length}>
              {bearings.landed.map((item) => <CompactRow key={item.id} title={item.what} detail={item.artifact || item.owner} icon={<Check size={15} />} />)}
              {bearings.landed.length === 0 && <EmptyState label="Nothing has landed recently." />}
            </DashboardSection>

            <DashboardSection title="Underway" icon={<Radio size={17} />} tone="blue" count={bearings.in_flight.length}>
              <div className="task-list">
                {bearings.in_flight.map((item) => {
                  const task = fleet?.tasks.find((candidate) => candidate.id === item.id);
                  const status = taskStatus(item.state);
                  return <button className="task-row" key={item.id} onClick={() => task && setActiveTask(task)}><span className={`task-state tone-${status.tone}`}>{status.icon}</span><span className="task-copy"><strong>{item.name}</strong><small>{projectName(item.repo)} · {item.kind}</small></span><span className={`task-chip tone-${status.tone}`}>{stateLabel(item.state)}</span><ChevronRight size={17} /></button>;
                })}
              </div>
              {bearings.in_flight.length === 0 && <EmptyState label="Nothing is underway." />}
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
        {view === "projects" && <ProjectsView projects={projects} onOpen={openProject} />}
        {view === "project" && selectedProjectData && <ProjectView project={selectedProjectData} onOpenTask={setActiveTask} />}
        {view === "artifacts" && <ArtifactsView artifacts={artifacts} tasks={fleet?.tasks ?? []} reviews={reviews} backlog={fleet?.backlog?.records ?? []} onOpen={showArtifact} />}
        {view === "artifact" && (shownArtifact && shownRevision
          ? <ArtifactReview
              key={`${shownArtifact.scope}/${shownArtifact.task}/${shownArtifact.name}/${shownRevision.rev}`}
              artifact={shownArtifact}
              revision={shownRevision}
              url={host.artifactUrl(shownRevision)}
              review={review}
              sendReady={bridge.sendReady}
              runtime={runtime.state}
              onRevision={(rev) => showArtifact(shownArtifact, rev)}
              onComment={(body, anchor, thread) => host.reviewComment(artifactRef!, shownRevision.rev, body, anchor, thread).then(setReview)}
              onDiscard={(thread) => host.reviewDiscard(artifactRef!, thread).then(setReview)}
              onSubmit={(verdict) => host.reviewSubmit(artifactRef!, shownRevision.rev, verdict).then((sent) => { bridge.noteSent(sent.message, sent.text); setReview(sent.review); })}
              decisions={(shownRevision.covers ?? []).map((task) => (fleet?.decision_options ?? []).find((item) => item.task === task) ?? { task, question: "", options: [] })}
              onAnswer={(decision, option, label) => host.reviewAnswer(artifactRef!, decision, option, label).then(setReview)}
              onScene={(place, proposal) => host.reviewScene(artifactRef!, shownRevision.rev, place.file, place.label, place.path, proposal.summary, proposal.scene, proposal.png).then(setReview)}
              onSettle={(thread, resolved) => host.reviewSettle(artifactRef!, thread, resolved).then(setReview)}
              onSeen={(rev) => host.reviewSeen(artifactRef!, rev).then(setReview)}
            />
          : <div className="content-scroll"><EmptyState label="This page isn't in the home's records anymore." /></div>)}
      </main>

      {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
      {settingsOpen && <SettingsDialog home={bridge.home} problem={bridge.homeProblem} running={runningHere} choosing={bridge.choosingHome} onChoose={() => void bridge.chooseHome()} onClose={() => setSettingsOpen(false)} />}
      {activeTask && fleet && <TaskDrawer task={activeTask} artifacts={artifacts.filter((artifact) => artifact.scope === "task" && artifact.task === activeTask.id)} onOpenArtifact={showArtifact} fleetSchema={fleet.schema} fleetGenerated={fleet.generated} expanded={showEverything} onCapture={bridge.paneCapture} onToggle={() => setShowEverything((current) => !current)} onClose={() => { setActiveTask(null); setShowEverything(false); }} />}
    </div>
  );
}

function NavButton({ active, icon, label, detail, count, countTitle, onClick }: { active: boolean; icon: React.ReactNode; label: string; detail?: string; count?: number; countTitle?: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>{count !== undefined && <em title={countTitle}>{count}</em>}</button>;
}

function HomeSetup({ problem, choosing, onChoose }: { problem: string | null; choosing: boolean; onChoose: () => void }) {
  return <div className="home-setup"><section><div className="brand-mark"><Anchor size={21} /></div><h1>Where does firstmate live on this Mac?</h1><p>Choose your firstmate folder, the one with <code>AGENTS.md</code> and <code>bin</code> inside. The app runs the first mate there and reads Bearings from it.</p><p>You only do this once. You can change it later in Settings.</p>{problem && <HomeProblem problem={problem} />}<button className="home-choose" disabled={choosing} onClick={onChoose}><FolderOpen size={16} /> {choosing ? "Choosing…" : "Choose folder…"}</button></section></div>;
}

function HomeProblem({ problem }: { problem: string }) {
  return <div className="home-problem" role="alert"><CircleAlert size={16} /><span>{problem}</span></div>;
}

function SettingsDialog({ home, problem, running, choosing, onChoose, onClose }: { home: string; problem: string | null; running: boolean; choosing: boolean; onChoose: () => void; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <div className="drawer-backdrop" onMouseDown={onClose}><section className="settings-dialog" role="dialog" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><div><span>Settings</span><h2>firstmate folder</h2></div><button className="icon-button" onClick={onClose} title="Close settings"><X size={18} /></button></header><div className="settings-body"><p>The first mate runs here, and Bearings is read from here.</p><code className="settings-path" title={home}>{home}</code>{problem && <HomeProblem problem={problem} />}<button className="home-choose" disabled={running || choosing} onClick={onChoose}><FolderOpen size={16} /> {choosing ? "Choosing…" : "Choose a different folder…"}</button>{running && <small>Stop the first mate before choosing a different folder.</small>}</div></section></div>;
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

/** How an answer names its call, which is what lets a waiting answer find its card again after a relaunch. */
function callName(decision: Decision) {
  return (decision.key || decision.id).replaceAll("-", " ");
}

function callPrUrl(decision: { summary: string }) {
  return decision.summary.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? "";
}

/** Whether a message the captain sent is an answer to this call: the app wrote both forms itself. */
function answersCall(text: string, decision: Decision & { summary: string }) {
  const said = text.trim();
  const prUrl = callPrUrl(decision);
  if (prUrl && said === `Merge ${prUrl}`) return true;
  return said.toLowerCase().startsWith(`on the ${callName(decision).toLowerCase()}:`);
}

function DecisionCard({ decision, state, answerText, runtime, onSend, onStart, onReadArgument, answeredIn }: { decision: Decision & { title: string; options?: { label: string; recommended: boolean }[] }; state: CallState; answerText?: string; runtime: HostRuntimeState; onSend: (text: string) => void; onStart: () => void; onReadArgument?: () => void; answeredIn?: string }) {
  const options = decision.options ?? optionLabels(decision.summary);
  const [selection, setSelection] = useState("");
  const [note, setNote] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [deferDate, setDeferDate] = useState("");
  const decisionName = callName(decision);
  const prUrl = callPrUrl(decision);
  const mergeSelected = selection === "Merge now" && Boolean(prUrl);
  const answer = deferDate ? `not now. Ask me again on ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${deferDate}T12:00:00`))}.` : [selection, note.trim()].filter(Boolean).join(selection && note.trim() ? ". " : "");
  const preview = mergeSelected && !note.trim() ? `Merge ${prUrl}` : answer ? `On the ${decisionName}: ${answer.replace(/[.]*$/, ".")}` : "…";
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
    return <article className={`decision-card ${read ? "read" : "queued"} call-tone-${tone}`}><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><h3>{decision.title}</h3>{answerText && <p className="call-answer" title={answerText}>{answerText}</p>}<div className={`call-state tone-${tone}`}>{icon}<span><strong>{title}</strong>{state.error ? <small>{state.error}</small> : !read && <small>{detail}</small>}</span>{state.error && !state.resent && resendText ? <button onClick={() => onSend(resendText)}>Send again</button> : !read && !state.error && runtime === "dead" ? <button onClick={onStart}>Start the first mate</button> : null}</div></article>;
  }
  if (answeredIn) {
    // The answer has gone; the call stays until the first mate records it and closes the task.
    return <article className="decision-card read call-tone-green" data-decision-id={decision.id} data-answered-in-review="true"><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><h3 data-testid="decision-title">{decision.title}</h3><div className="call-state tone-green"><Check size={16} /><span><strong>Answered in your review of “{answeredIn}”</strong><small>This stays here until the first mate records it.</small></span>{onReadArgument && <button onClick={onReadArgument}>Open the page</button>}</div></article>;
  }
  if (onReadArgument) {
    // A page argues this one, so it is answered there: one decision, one place.
    return <article className="decision-card" data-decision-id={decision.id} data-argued="true"><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><h3 data-testid="decision-title">{decision.title}</h3><p data-testid="decision-reason">{decision.summary}</p><div className="decision-actions"><span>{options.length > 0 ? `${options.length} options, with the case for each` : "The case for this is written up"}</span><button onClick={onReadArgument}><PanelsTopLeft size={15} /> Read the argument</button></div></article>;
  }
  return <article className="decision-card" data-decision-id={decision.id}><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><h3 data-testid="decision-title">{decision.title}</h3><p data-testid="decision-reason">{decision.summary}</p><div className="suggestion-chips">{options.map((option) => <button className={selection === option.label ? "selected" : ""} key={option.label} onClick={() => { setSelection(option.label); setDateOpen(false); setDeferDate(""); }}><span>{option.label}</span>{option.recommended && <small>Recommended</small>}</button>)}<button className={dateOpen ? "selected" : ""} onClick={() => { setDateOpen(true); setSelection(""); }}>Not now</button></div>{dateOpen && <label className="date-field"><span>Ask me again</span><input type="date" value={deferDate} onChange={(event) => setDeferDate(event.target.value)} /></label>}<label className="reply-field"><span>{selection === "Send it back" ? "What should change?" : "Or write your own answer"}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label><div className="decision-actions"><span>{preview !== "…" && `→ sends: ${preview}`}</span><button disabled={preview === "…"} onClick={() => onSend(preview)}><Send size={15} /> {mergeSelected && !note.trim() ? "Merge now" : "Send"}</button></div>{mergeSelected && note.trim() && <p className="merge-hint">This sends instructions, not a merge. Use Merge now to merge.</p>}</article>;
}

function ProjectsView({ projects, onOpen }: { projects: { name: string; posture: string; tasks: FleetTask[] }[]; onOpen: (name: string) => void }) {
  return <div className="content-scroll projects-page"><div className="project-grid">{projects.map((project) => <button key={project.name} className="project-card" onClick={() => onOpen(project.name)}><span className="project-sigil large">{project.name.slice(0, 2).toUpperCase()}</span><div><h2>{project.name}</h2><p>{project.posture}</p><span>{project.tasks.length} underway</span></div><ChevronRight size={18} /></button>)}</div></div>;
}

function ProjectView({ project, onOpenTask }: { project: { name: string; posture: string; tasks: FleetTask[] }; onOpenTask: (task: FleetTask) => void }) {
  return <div className="content-scroll project-page"><div className="posture-line"><Anchor size={15} /><span>{project.posture}</span></div><section className="project-summary"><div><span>Project</span><h2>{project.name}</h2><p>The first mate keeps this work within the project's standing delivery posture.</p></div><div className="project-stat"><strong>{project.tasks.length}</strong><span>Underway</span></div></section><DashboardSection title="Underway" icon={<Radio size={17} />} tone="blue" count={project.tasks.length}><div className="task-list">{project.tasks.map((task) => {
    const status = taskStatus(task.current_state.state);
    return <button className="task-row" key={task.id} onClick={() => onOpenTask(task)}><span className={`task-state tone-${status.tone}`}>{status.icon}</span><span className="task-copy"><strong>{task.id}</strong><small>{task.kind} · {task.harness}</small></span><span className={`task-chip tone-${status.tone}`}>{stateLabel(task.current_state.state)}</span><ChevronRight size={17} /></button>;
  })}</div></DashboardSection></div>;
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

function chatItems(messages: ChatMessage[], artifacts: Artifact[]) {
  const lastPast = messages.reduce((found, message, index) => message.past ? index : found, -1);
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
    if (lastPast >= 0 && index === lastPast + 1) items.push({ type: "label", id: `label-${message.id}`, text: "Today" });
    if (!message.past) pushPages(message.createdAt);
    const past = message.past === true;
    const last = items.at(-1);
    if (message.who !== "step") items.push({ type: "message", message });
    else if (last?.type === "steps" && last.past === past) last.steps.push(message);
    else items.push({ type: "steps", id: `steps-${message.id}`, steps: [message], past });
  });
  if (pages.length && lastPast >= 0 && lastPast === messages.length - 1) items.push({ type: "label", id: "label-today-pages", text: "Today" });
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
  const summary = `${steps.length === 1 ? "1 step" : `${steps.length} steps`}${failed ? ` · ${failed} didn't work` : ""}`;
  return <div className={`step-group ${live ? "live" : ""}`}>{!live && <button className="step-summary" aria-expanded={open} onClick={() => setOpen((current) => !current)}><ChevronRight size={13} className={open ? "rotated" : ""} /><span>{summary}</span></button>}{live && hidden > 0 && <button className="step-summary" onClick={() => setOpen(true)}><ChevronRight size={13} /><span>{hidden} earlier {hidden === 1 ? "step" : "steps"}</span></button>}{(live || open) && <ol className="step-lines">{visible.map((step) => <StepLine key={step.id} step={step} live={live} home={home} />)}</ol>}</div>;
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
        : <ChatMessageView key={item.message.id} message={item.message} outbox={outbox[item.message.id]} running={running} onResend={() => onResend(item.message.id, item.message.text)} />)}</div>{approvals.map((request) => <ApprovalCard key={request.id} request={request} home={home} onAnswer={(optionId) => onAnswer(request.id, optionId)} />)}<div className="composer"><textarea value={draft} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} aria-label="Message the first mate" /><div><button className="icon-button" title="Attach a file"><FileText size={17} /></button><button className="send-button" onClick={onSend} disabled={!draft.trim() || !sendReady} title={sendReady ? "Send message" : "Start the first mate to send messages"}><Send size={16} /></button></div></div></div>;
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
        : "Queued";
  const tooltip = !outbox || outbox.error ? undefined : outbox.resentAfterRestart
    ? "The app stopped before the first mate finished with this, so it sent it again. If the first mate had already started on it, it may mention it twice."
    : outbox.status === "picked_up"
      ? `The first mate had read this by ${formatTime(outbox.readAt ?? message.createdAt)}, when it finished replying.`
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

function TaskDrawer({ task, artifacts, onOpenArtifact, fleetSchema, fleetGenerated, expanded, onCapture, onToggle, onClose }: { task: FleetTask; artifacts: Artifact[]; onOpenArtifact: (artifact: Artifact) => void; fleetSchema: string; fleetGenerated: string; expanded: boolean; onCapture: (taskId: string) => Promise<{ text: string; observed_at?: string }>; onToggle: () => void; onClose: () => void }) {
  const [capture, setCapture] = useState<{ text: string; observed_at?: string } | null>(null);
  useEffect(() => {
    let active = true;
    void onCapture(task.id).then((next) => { if (active) setCapture(next); });
    return () => { active = false; };
  }, [onCapture, task.id]);
  const status = taskStatus(task.current_state.state);
  // The snapshot's own detail says more than the generic sentence for a state, when it has one.
  const statusDetail = (task.current_state.detail ?? "").trim() || status.summary;
  const timeline = [
    { title: "Registered with the fleet", detail: `${task.kind} · ${task.harness}`, time: "Start", icon: <GitBranch size={15} /> },
    { title: task.paths.status_log.last_event.state, detail: task.paths.status_log.last_event.note, time: "Latest", icon: <Radio size={15} /> },
    { title: stateLabel(task.current_state.state), detail: statusDetail, time: formatTime(task.current_state.observed_at), icon: taskStatus(task.current_state.state, 15).icon },
  ];
  const captureText = capture?.text ?? `status: ${task.endpoint.status}\nbackend: ${task.backend}\nworker: ${task.endpoint.agent_alive}\nworktree: ${task.paths.worktree.present ? task.paths.worktree.path : "missing"}\nobserved: ${task.endpoint.observed_at}`;
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="task-drawer" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><div><span>{projectName(task.project)}</span><h2>{task.id}</h2></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header><div className="drawer-status"><span className={`task-state tone-${status.tone}`}>{status.icon}</span><div><strong className={`tone-${status.tone}`}>{stateLabel(task.current_state.state)}</strong>{statusDetail && <span>{statusDetail}</span>}</div></div><div className="drawer-scroll"><DrawerSection title="Instructions"><div className="brief-block"><p>{task.paths.status_log.last_event.note}</p></div></DrawerSection><DrawerSection title="Timeline"><div className="timeline">{timeline.map((item) => <div key={item.time}><span className="timeline-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span><time>{item.time}</time></div>)}</div></DrawerSection>{artifacts.length > 0 && <DrawerSection title="Pages"><div className="drawer-pages">{artifacts.map((artifact) => <ArtifactRow key={artifact.name} artifact={artifact} detail={revisionLine(artifact)} onOpen={() => onOpenArtifact(artifact)} />)}</div></DrawerSection>}<DrawerSection title="PR"><div className="pr-block">{task.pr.url ? <a href={task.pr.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {task.pr.url}</a> : <span><GitBranch size={15} /> No PR recorded</span>}</div></DrawerSection><DrawerSection title="Worker's screen"><p className="worker-caption">Read-only. To change anything, tell the first mate.</p><div className="worker-screen"><header><TerminalSquare size={14} /><span>{task.endpoint.target}</span><em>{capture?.observed_at ? `Updated ${formatTime(capture.observed_at)}` : "Updating…"}</em></header><pre>{captureText}</pre></div></DrawerSection><button className="show-everything" onClick={onToggle}><ChevronDown size={16} className={expanded ? "rotated" : ""} /><span>Show everything</span></button>{expanded && <div className="machine-details"><dl><dt>Branch</dt><dd>none recorded</dd><dt>Isolated copy</dt><dd>{task.paths.worktree.present ? task.paths.worktree.path : "missing"}</dd><dt>Worker runtime</dt><dd>{task.harness} on {task.backend}</dd><dt>Status line</dt><dd>{task.current_state.raw}</dd><dt>Log</dt><dd>{task.paths.status_log.last_event.raw}</dd></dl><div className="step-chips"><span>Registered</span><span>{task.current_state.freshness}</span><span>Endpoint {task.endpoint.status}</span><span>PR {task.pr.source}</span><span>Report {task.paths.report.present ? "ready" : "none"}</span></div></div>}</div><footer className="drawer-footer">From {fleetSchema} · {formatTime(fleetGenerated)}</footer></aside></div>;
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
  if (review && review.open_count > 0) return { label: review.open_count === 1 ? "1 comment waiting" : `${review.open_count} comments waiting`, tone: "open" };
  return null;
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
export function artifactStanding(artifact: Artifact, review: ReviewSummary[string] | undefined, backlog: Map<string, BacklogRecord>): ArtifactStanding {
  const task = artifact.scope === "task" ? artifact.task : null;
  if (task && backlog.get(task)?.state === "done") return "settled";
  if (review && review.draft_count > 0) return "needs-you";
  const seen = review?.seen_rev ?? null;
  if (seen === null || artifact.latest.rev > seen) return "needs-you";
  const answered = review?.answered ?? [];
  // A call this page argues: yours until you answer it, then the first mate's until it records it.
  const calls = (artifact.latest.covers ?? []).filter((call) => backlog.get(call)?.captain_actionable);
  if (calls.some((call) => !answered.includes(call))) return "needs-you";
  if (calls.length > 0) return "discussion";
  if (review && review.open_count > 0) return "discussion";
  // A chat page has no work to finish, so once it is read and quiet it is done.
  return task ? "discussion" : "settled";
}

const STANDINGS: { id: ArtifactStanding; title: string; blank: string }[] = [
  { id: "needs-you", title: "Needs you", blank: "Nothing needs you right now." },
  { id: "discussion", title: "In discussion", blank: "" },
  { id: "settled", title: "Settled", blank: "" },
];

function ArtifactsView({ artifacts, tasks, reviews, backlog, onOpen }: { artifacts: Artifact[]; tasks: FleetTask[]; reviews: ReviewSummary; backlog: BacklogRecord[]; onOpen: (artifact: Artifact) => void }) {
  const [openSettled, setOpenSettled] = useState(false);
  const rows = useMemo(() => new Map(backlog.map((record) => [record.id, record])), [backlog]);
  const groups = useMemo(() => {
    const out = new Map<ArtifactStanding, Artifact[]>(STANDINGS.map((standing) => [standing.id, []]));
    for (const artifact of artifacts) out.get(artifactStanding(artifact, reviews[artifactKey(artifact)], rows))!.push(artifact);
    return out;
  }, [artifacts, reviews, rows]);

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

const VERDICTS: { id: ReviewVerdict; label: string; hint: string }[] = [
  { id: "changes", label: "Request changes", hint: "The task keeps waiting on this page." },
  { id: "approve", label: "Approve", hint: "The work on this page can go ahead." },
  { id: "comment", label: "Comment", hint: "Thoughts only; nothing is blocked." },
];

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
function ArtifactReview({ artifact, revision, url, review, sendReady, runtime, decisions, onRevision, onComment, onDiscard, onSubmit, onSettle, onSeen, onAnswer, onScene }: {
  artifact: Artifact;
  revision: ArtifactRevision;
  url: string;
  review: ReviewView | null;
  sendReady: boolean;
  runtime: HostRuntimeState;
  onRevision: (rev: number) => void;
  onComment: (body: string, anchor?: ReviewAnchor, thread?: string) => Promise<unknown>;
  onDiscard: (thread: string) => Promise<unknown>;
  onSubmit: (verdict: ReviewVerdict) => Promise<unknown>;
  onSettle: (thread: string, resolved: boolean) => Promise<unknown>;
  onSeen: (rev: number) => Promise<unknown>;
  decisions: DecisionOptions[];
  onAnswer: (decision: string, option?: string, label?: string) => Promise<unknown>;
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
  const [verdict, setVerdict] = useState<ReviewVerdict>("changes");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const note = layoutNote(revision);
  const newest = [...artifact.revisions].reverse();
  const threads = review?.threads ?? [];
  const draftCount = review?.draft_count ?? 0;
  const lastSent = review?.sent.at(-1);
  const seen = review?.seen_rev ?? null;

  // Looking at a revision is what makes a later one read as new.
  useEffect(() => {
    if (review && (seen === null || seen < revision.rev)) void onSeen(revision.rev);
  }, [review, seen, revision.rev]);

  // What the author says a later revision does about each comment. Their claim, shown as theirs.
  const answers = useMemo(() => {
    const found: Record<string, { rev: number; reply?: string }> = {};
    for (const item of artifact.revisions) {
      for (const id of item.answers?.addressed ?? []) found[id] = { ...found[id], rev: item.rev };
      for (const reply of item.answers?.replies ?? []) found[reply.thread] = { rev: item.rev, reply: reply.body };
    }
    return found;
  }, [artifact.revisions]);
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

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; anchor?: ReviewAnchor; missing?: string[] };
      if (data?.type === "qd:picked" && data.anchor) {
        setPending(data.anchor);
        setCommenting(false);
      } else if (data?.type === "qd:located") {
        setMissing(data.missing ?? []);
      } else if (data?.type === "qd:scenes") {
        setScenes((data as { scenes?: ScenePlace[] }).scenes ?? []);
      } else if (data?.type === "qd:scene-open") {
        void openDiagram((data as { scene?: ScenePlace }).scene);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** The page's own scene file, read through the same scheme that serves the page. */
  async function openDiagram(place?: ScenePlace) {
    if (!place) return;
    setCommenting(false);
    setSceneProblem(null);
    try {
      const base = url.slice(0, url.lastIndexOf("/") + 1);
      const response = await fetch(base + place.file.split("/").map(encodeURIComponent).join("/"));
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
      await onSubmit(verdict);
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
      : VERDICTS.find((item) => item.id === verdict)?.hint;

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
        {decisions.length > 0 && <div className="decision-answers">
          {decisions.map((decision) => {
            const chosen = review?.answers.find((answer) => answer.decision === decision.task);
            return <section key={decision.task} className="decision-answer" data-testid="decision-answer">
              <header><span>Your call</span><small>{decision.task}</small></header>
              {decision.question && <p>{decision.question}</p>}
              {decision.options.length === 0
                ? <small className="decision-missing">This page argues a decision whose options are not recorded. Answer it in chat.</small>
                : <div className="decision-choices">{decision.options.map((option) => {
                    const picked = chosen?.option === option.key;
                    return <button key={option.key} className={picked ? "picked" : ""} aria-pressed={picked} onClick={() => void onAnswer(decision.task, picked ? undefined : option.key, option.label)}>
                      <span>{option.label}</span>{option.recommended && <small>Recommended</small>}
                    </button>;
                  })}</div>}
              {chosen && <small className={chosen.sent_at === null ? "decision-staged" : "decision-sent"}>{chosen.sent_at === null ? "Goes with your review" : `Sent ${formatWhen(new Date(chosen.sent_at).toISOString())}`}</small>}
            </section>;
          })}
        </div>}
        <div className="review-threads">
          {threads.length === 0 && !pending && decisions.length === 0 && <p className="review-empty">Nothing written yet. Use Comment to write on a part of the page, then send it all at once.</p>}
          {live.map((thread) => <ReviewThreadCard key={thread.id} thread={thread} answer={answers[thread.id]} rev={revision.rev} missing={missing.includes(thread.id)} picture={proposalPicture(thread, url)} onFocus={() => tell({ type: "qd:focus", id: thread.id })} onDiscard={() => void onDiscard(thread.id)} onSettle={(resolved) => void onSettle(thread.id, resolved)} />)}
          {settled.length > 0 && <button className="settled-toggle" aria-expanded={showSettled} onClick={() => setShowSettled((current) => !current)}><ChevronRight size={13} className={showSettled ? "rotated" : ""} /> {settled.length} settled</button>}
          {showSettled && settled.map((thread) => <ReviewThreadCard key={thread.id} thread={thread} answer={answers[thread.id]} rev={revision.rev} missing={missing.includes(thread.id)} picture={proposalPicture(thread, url)} onFocus={() => tell({ type: "qd:focus", id: thread.id })} onDiscard={() => void onDiscard(thread.id)} onSettle={(resolved) => void onSettle(thread.id, resolved)} />)}
        </div>
        <div className="review-send">
          {problem && <p className="review-problem" role="alert">{problem}</p>}
          {lastSent && draftCount === 0 && <p className="review-last">Sent {formatWhen(new Date(lastSent.at).toISOString())} · {VERDICTS.find((item) => item.id === lastSent.verdict)?.label ?? lastSent.verdict}</p>}
          <label className="verdict-picker"><span className="sr-only">Verdict</span><select value={verdict} onChange={(event) => setVerdict(event.target.value as ReviewVerdict)}>{VERDICTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><ChevronDown size={14} /></label>
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
