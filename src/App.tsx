import {
  Anchor,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Clock3,
  ExternalLink,
  FileText,
  FolderGit2,
  FolderOpen,
  Gauge,
  GitBranch,
  Inbox,
  Menu,
  MessageSquareText,
  Moon,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldQuestion,
  ShipWheel,
  Sparkles,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { createHostAdapter, type Decision, type FleetTask, type HostRuntimeState, type ReasonKind } from "./host";
import { type ChatMessage, type HealthWarning, type OutboxView, type PermissionView, type RewakeStorm, type SnapshotHealth, useHost } from "./host/use-host";

type View = "bearings" | "chat" | "projects" | "project";
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
  const [dark, setDark] = useState(true);
  const [ahoyVisible, setAhoyVisible] = useState(true);
  const [callMessageIds, setCallMessageIds] = useState<Record<string, string>>({});
  const [chatDraft, setChatDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    return {
      ...decision,
      title: record?.title ?? decision.key,
      summary: record?.hold_reason ?? "",
    };
  }) ?? [], [bearings, fleet]);

  const selectedProjectData = projects.find((project) => project.name === selectedProject);
  const title = view === "bearings" ? "Bearings" : view === "chat" ? "Chat" : view === "projects" ? "Projects" : selectedProject ?? "Project";
  const subtitle = view === "project" && selectedProjectData ? selectedProjectData.posture : view === "chat" ? "The first mate" : view === "bearings" ? (bearings ? `As of ${formatTime(bearings.generated)}` : "") : `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  const openCallCount = bearings?.decisions_open.length ?? 0;
  const approvalCount = bridge.permissionRequests.length;
  // Failed and not-sent messages aren't being worked on.
  const pendingCount = Object.values(outbox).filter((item) => item.status !== "picked_up" && !item.error).length;
  const runningHere = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"].includes(runtime.state);
  const hostLabel = bridge.rewakeStorm ? `Woken ${bridge.rewakeStorm.turns} times in ${Math.round(bridge.rewakeStorm.windowSecs / 60)} min` : runtimeLabel(runtime.state, pendingCount, approvalCount);
  const notRunning = runtime.state === "dead" || runtime.state === "stopped";
  const problemDetails = [...new Set([runtime.reason, bridge.startError].filter((text): text is string => Boolean(text)))].join("\n\n");
  // A Start can also fail after the host said it was starting, and stay there.
  const hasProblem = runtime.state === "refused" || (notRunning && Boolean(runtime.reasonKind || problemDetails)) || (runtime.state === "starting" && Boolean(bridge.startError));

  function navigate(next: View) {
    setView(next);
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
    const previous = callMessageIds[id];
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
          <div className="connection"><span className={`live-dot state-${runtime.state}`} /><span><strong>First Mate</strong><small>{hostLabel}</small></span></div>
          <button className="runtime-button" disabled={runtime.state === "restarting"} onClick={runningHere ? stopHost : () => void bridge.start()}>{runtime.state === "locked_by_other" ? "Check again" : runningHere ? "Stop" : "Start"}</button>
          <button className="icon-button" title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={17} /></button>
        </div>
      </aside>

      <main className="main-surface">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} title="Open navigation"><Menu size={19} /></button>
          {view === "project" && <button className="icon-button back-button" onClick={() => navigate("projects")} title="Back to projects"><ArrowLeft size={18} /></button>}
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
                <DecisionCard key={decision.id} decision={decision} state={outbox[callMessageIds[decision.id]]} runtime={runtime.state} onSend={(text) => answerCall(decision.id, text)} onStart={() => void bridge.start()} />
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
                  return <button className="task-row" key={item.id} onClick={() => task && setActiveTask(task)}><span className="task-state warning"><CircleAlert size={16} /></span><span className="task-copy"><strong>{item.name}</strong><small>{projectName(item.repo)} · {item.kind}</small></span><span className="task-chip warning">{stateLabel(item.state)}</span><ChevronRight size={17} /></button>;
                })}
              </div>
              {bearings.in_flight.length === 0 && <EmptyState label="Nothing is underway." />}
            </DashboardSection>

            <DashboardSection title="Charted Next" icon={<Clock3 size={17} />} tone="amber" count={bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length}>
              {bearings.gates.map((item) => <CompactRow key={item.id} title={item.title} detail={item.reason} icon={<Clock3 size={15} />} badge="waiting" />)}
              {(bearings.unhealthy_endpoints ?? []).map((item) => <CompactRow key={`health-${item.id}`} title={`The first mate's records for ${projectName(fleet?.tasks.find((task) => task.id === item.id)?.project ?? item.id)} don't match.`} detail="Nothing to do on your side." icon={<CircleAlert size={15} />} badge="needs repair" />)}
              {bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length === 0 && <EmptyState label="Nothing is queued." />}
            </DashboardSection>
            </>}
          </div>
        )}

        {view === "chat" && <ChatView messages={messages} outbox={outbox} draft={chatDraft} runtime={runtime.state} hostLabel={hostLabel} home={bridge.home} sendReady={bridge.sendReady} banners={hostBanners(setChatDraft)} approvals={bridge.permissionRequests} onAnswer={(id, optionId) => void bridge.answerPermission(id, optionId)} onDraft={setChatDraft} onSend={() => void sendChat()} onResend={(id, text) => void bridge.resend(id, text)} onRestart={() => void bridge.restart()} />}
        {view === "projects" && <ProjectsView projects={projects} onOpen={openProject} />}
        {view === "project" && selectedProjectData && <ProjectView project={selectedProjectData} onOpenTask={setActiveTask} />}
      </main>

      {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
      {settingsOpen && <SettingsDialog home={bridge.home} problem={bridge.homeProblem} running={runningHere} choosing={bridge.choosingHome} onChoose={() => void bridge.chooseHome()} onClose={() => setSettingsOpen(false)} />}
      {activeTask && fleet && <TaskDrawer task={activeTask} fleetSchema={fleet.schema} fleetGenerated={fleet.generated} expanded={showEverything} onCapture={bridge.paneCapture} onToggle={() => setShowEverything((current) => !current)} onClose={() => { setActiveTask(null); setShowEverything(false); }} />}
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

function CompactRow({ title, detail, icon, badge }: { title: string; detail: string; icon: React.ReactNode; badge?: string }) {
  // firstmate's snapshots write "-" for an empty field; show nothing rather than a dash.
  const shown = detail.trim() === "-" ? "" : detail.trim();
  return <div className="compact-row"><span>{icon}</span><div><strong>{title}</strong>{shown && <small>{shown}</small>}</div>{badge && <em>{badge}</em>}</div>;
}

function DecisionCard({ decision, state, runtime, onSend, onStart }: { decision: Decision & { title: string }; state: CallState; runtime: HostRuntimeState; onSend: (text: string) => void; onStart: () => void }) {
  const options = optionLabels(decision.summary);
  const [selection, setSelection] = useState("");
  const [note, setNote] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [deferDate, setDeferDate] = useState("");
  const decisionName = (decision.key || decision.id).replaceAll("-", " ");
  const prUrl = decision.summary.match(/https:\/\/\S+\/pull\/\d+/)?.[0] ?? "";
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
    return <article className={`decision-card ${read ? "read" : "queued"}`}><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><div className="call-state"><Check size={16} /><span><strong>{title}</strong>{state.error ? <small>{state.error}</small> : !read && <small>{detail}</small>}</span>{state.error && !state.resent ? <button onClick={() => onSend(preview)}>Send again</button> : !read && !state.error && runtime === "dead" ? <button onClick={onStart}>Start the first mate</button> : null}</div></article>;
  }
  return <article className="decision-card" data-decision-id={decision.id}><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><h3 data-testid="decision-title">{decision.title}</h3><p data-testid="decision-reason">{decision.summary}</p><div className="suggestion-chips">{options.map((option) => <button className={selection === option.label ? "selected" : ""} key={option.label} onClick={() => { setSelection(option.label); setDateOpen(false); setDeferDate(""); }}><span>{option.label}</span>{option.recommended && <small>Recommended</small>}</button>)}<button className={dateOpen ? "selected" : ""} onClick={() => { setDateOpen(true); setSelection(""); }}>Not now</button></div>{dateOpen && <label className="date-field"><span>Ask me again</span><input type="date" value={deferDate} onChange={(event) => setDeferDate(event.target.value)} /></label>}<label className="reply-field"><span>{selection === "Send it back" ? "What should change?" : "Or write your own answer"}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label><div className="decision-actions"><span>{preview !== "…" && `→ sends: ${preview}`}</span><button disabled={preview === "…"} onClick={() => onSend(preview)}><Send size={15} /> {mergeSelected && !note.trim() ? "Merge now" : "Send"}</button></div>{mergeSelected && note.trim() && <p className="merge-hint">This sends instructions, not a merge. Use Merge now to merge.</p>}</article>;
}

function ProjectsView({ projects, onOpen }: { projects: { name: string; posture: string; tasks: FleetTask[] }[]; onOpen: (name: string) => void }) {
  return <div className="content-scroll projects-page"><div className="project-grid">{projects.map((project) => <button key={project.name} className="project-card" onClick={() => onOpen(project.name)}><span className="project-sigil large">{project.name.slice(0, 2).toUpperCase()}</span><div><h2>{project.name}</h2><p>{project.posture}</p><span>{project.tasks.length} underway</span></div><ChevronRight size={18} /></button>)}</div></div>;
}

function ProjectView({ project, onOpenTask }: { project: { name: string; posture: string; tasks: FleetTask[] }; onOpenTask: (task: FleetTask) => void }) {
  return <div className="content-scroll project-page"><div className="posture-line"><Anchor size={15} /><span>{project.posture}</span></div><section className="project-summary"><div><span>Project</span><h2>{project.name}</h2><p>The first mate keeps this work within the project's standing delivery posture.</p></div><div className="project-stat"><strong>{project.tasks.length}</strong><span>Underway</span></div></section><DashboardSection title="Underway" icon={<Radio size={17} />} tone="blue" count={project.tasks.length}><div className="task-list">{project.tasks.map((task) => <button className="task-row" key={task.id} onClick={() => onOpenTask(task)}><span className="task-state warning"><CircleAlert size={16} /></span><span className="task-copy"><strong>{task.id}</strong><small>{task.kind} · {task.harness}</small></span><span className="task-chip warning">{stateLabel(task.current_state.state)}</span><ChevronRight size={17} /></button>)}</div></DashboardSection></div>;
}

type ChatItem = { type: "message"; message: ChatMessage } | { type: "steps"; id: string; steps: ChatMessage[]; past: boolean } | { type: "label"; id: string; text: string };

/**
 * Consecutive steps read as one group between the first mate's messages.
 * A resumed session's history reads as "Earlier", and "Today" starts after its last item.
 * A message still waiting keeps its place inside the history, so it stays under "Earlier".
 */
function chatItems(messages: ChatMessage[]) {
  const lastPast = messages.reduce((found, message, index) => message.past ? index : found, -1);
  const items: ChatItem[] = [{ type: "label", id: "label-top", text: lastPast >= 0 ? "Earlier" : "Today" }];
  messages.forEach((message, index) => {
    if (lastPast >= 0 && index === lastPast + 1) items.push({ type: "label", id: `label-${message.id}`, text: "Today" });
    const past = message.past === true;
    const last = items.at(-1);
    if (message.who !== "step") items.push({ type: "message", message });
    else if (last?.type === "steps" && last.past === past) last.steps.push(message);
    else items.push({ type: "steps", id: `steps-${message.id}`, steps: [message], past });
  });
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

function ChatView({ messages, outbox, draft, runtime, hostLabel, home, sendReady, banners, approvals, onAnswer, onDraft, onSend, onResend, onRestart }: { messages: ChatMessage[]; outbox: Record<string, OutboxView>; draft: string; runtime: HostRuntimeState; hostLabel: string; home: string; sendReady: boolean; banners: React.ReactNode; approvals: PermissionView[]; onAnswer: (id: string, optionId: string) => void; onDraft: (value: string) => void; onSend: () => void; onResend: (id: string, text: string) => void; onRestart: () => void }) {
  const running = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"].includes(runtime);
  const turnLive = runtime === "prompt_turn" || runtime === "agent_turn";
  const placeholder = !sendReady ? "Start the first mate to send it a message." : runtime === "locked_by_other" ? "The first mate is running somewhere else. What you write here waits until it runs in this app." : running ? "Message the first mate" : "The first mate isn't running. It'll read this when it starts.";
  const items = chatItems(messages);
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the conversation, including a resumed session's history, unless the captain has scrolled up to read.
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages, outbox, approvals]);
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
  return <div className="chat-view">{banners}<div className="chat-status"><span className="avatar">FM</span><div><strong>First Mate</strong><span><i className={`state-${runtime}`} /> {hostLabel}</span></div><button className="icon-button" onClick={onRestart} title="Restart the first mate"><RefreshCw size={16} /></button></div><div className="chat-messages" ref={scroller} onScroll={onScroll} data-testid="chat-messages">{messages.length === 0 && <><div className="day-label">Today</div><div className="chat-empty">{running ? "The first mate is getting its bearings. Its first message will show up here." : "No messages yet."}</div></>}{messages.length > 0 && items.map((item, index) => item.type === "label"
    ? <div key={item.id} className={`day-label ${index > 0 ? "later" : ""}`}>{item.text}</div>
    : item.type === "steps"
      ? <StepGroup key={item.id} steps={item.steps} live={turnLive && !item.past && index === items.length - 1} home={home} />
      : item.message.who === "notice"
        ? <div key={item.message.id} className="chat-notice" role="status">{item.message.text}</div>
        : <ChatMessageView key={item.message.id} message={item.message} outbox={outbox[item.message.id]} running={running} onResend={() => onResend(item.message.id, item.message.text)} />)}</div>{approvals.map((request) => <ApprovalCard key={request.id} request={request} home={home} onAnswer={(optionId) => onAnswer(request.id, optionId)} />)}<div className="composer"><textarea value={draft} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} aria-label="Message the first mate" /><div><button className="icon-button" title="Attach a file"><FileText size={17} /></button><button className="send-button" onClick={onSend} disabled={!draft.trim() || !sendReady} title={sendReady ? "Send message" : "Start the first mate to send messages"}><Send size={16} /></button></div></div></div>;
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
  return <article className={`${message.who === "mate" ? "mate-message" : "captain-message"} ${message.past ? "past" : ""}`}>{message.who === "mate" && <span className="avatar small">FM</span>}<div><strong>{message.who === "mate" ? "First Mate" : "You"}</strong><p>{message.text}</p>{footer}</div></article>;
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

function TaskDrawer({ task, fleetSchema, fleetGenerated, expanded, onCapture, onToggle, onClose }: { task: FleetTask; fleetSchema: string; fleetGenerated: string; expanded: boolean; onCapture: (taskId: string) => Promise<{ text: string; observed_at?: string }>; onToggle: () => void; onClose: () => void }) {
  const [capture, setCapture] = useState<{ text: string; observed_at?: string } | null>(null);
  useEffect(() => {
    let active = true;
    void onCapture(task.id).then((next) => { if (active) setCapture(next); });
    return () => { active = false; };
  }, [onCapture, task.id]);
  const timeline = [
    { title: "Registered with the fleet", detail: `${task.kind} · ${task.harness}`, time: "Start", icon: <GitBranch size={15} /> },
    { title: task.paths.status_log.last_event.state, detail: task.paths.status_log.last_event.note, time: "Latest", icon: <Radio size={15} /> },
    { title: stateLabel(task.current_state.state), detail: "The first mate could not confirm the worker's current state.", time: formatTime(task.current_state.observed_at), icon: <CircleAlert size={15} /> },
  ];
  const captureText = capture?.text ?? `status: ${task.endpoint.status}\nbackend: ${task.backend}\nworker: ${task.endpoint.agent_alive}\nworktree: ${task.paths.worktree.present ? task.paths.worktree.path : "missing"}\nobserved: ${task.endpoint.observed_at}`;
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="task-drawer" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><div><span>{projectName(task.project)}</span><h2>{task.id}</h2></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header><div className="drawer-status"><span className="task-state warning"><CircleAlert size={16} /></span><div><strong>{stateLabel(task.current_state.state)}</strong><span>The first mate could not confirm the worker's current state.</span></div></div><div className="drawer-scroll"><DrawerSection title="Instructions"><div className="brief-block"><p>{task.paths.status_log.last_event.note}</p></div></DrawerSection><DrawerSection title="Timeline"><div className="timeline">{timeline.map((item) => <div key={item.title}><span className="timeline-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span><time>{item.time}</time></div>)}</div></DrawerSection><DrawerSection title="PR"><div className="pr-block">{task.pr.url ? <a href={task.pr.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {task.pr.url}</a> : <span><GitBranch size={15} /> No PR recorded</span>}</div></DrawerSection><DrawerSection title="Worker's screen"><p className="worker-caption">Read-only. To change anything, tell the first mate.</p><div className="worker-screen"><header><TerminalSquare size={14} /><span>{task.endpoint.target}</span><em>{capture?.observed_at ? `Updated ${formatTime(capture.observed_at)}` : "Updating…"}</em></header><pre>{captureText}</pre></div></DrawerSection><button className="show-everything" onClick={onToggle}><ChevronDown size={16} className={expanded ? "rotated" : ""} /><span>Show everything</span></button>{expanded && <div className="machine-details"><dl><dt>Branch</dt><dd>none recorded</dd><dt>Isolated copy</dt><dd>{task.paths.worktree.present ? task.paths.worktree.path : "missing"}</dd><dt>Worker runtime</dt><dd>{task.harness} on {task.backend}</dd><dt>Status line</dt><dd>{task.current_state.raw}</dd><dt>Log</dt><dd>{task.paths.status_log.last_event.raw}</dd></dl><div className="step-chips"><span>Registered</span><span>{task.current_state.freshness}</span><span>Endpoint {task.endpoint.status}</span><span>PR {task.pr.source}</span><span>Report {task.paths.report.present ? "ready" : "none"}</span></div></div>}</div><footer className="drawer-footer">From {fleetSchema} · {formatTime(fleetGenerated)}</footer></aside></div>;
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="drawer-section"><h3>{title}</h3>{children}</section>;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
