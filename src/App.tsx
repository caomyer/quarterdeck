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
  ShipWheel,
  Sparkles,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createHostAdapter, type Decision, type FleetTask, type HostRuntimeState } from "./host";
import { type ChatMessage, type OutboxView, type RewakeStorm, useHost } from "./host/use-host";

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

function runtimeLabel(state: HostRuntimeState, pending: number) {
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
  const subtitle = view === "project" && selectedProjectData ? selectedProjectData.posture : view === "chat" ? "The first mate" : view === "bearings" && bearings ? `As of ${formatTime(bearings.generated)}` : `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  const openCallCount = bearings?.decisions_open.length ?? 0;
  const pendingCount = Object.values(outbox).filter((item) => item.status !== "picked_up").length;
  const runningHere = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"].includes(runtime.state);
  const hostLabel = bridge.rewakeStorm ? `Woken ${bridge.rewakeStorm.turns} times in ${Math.round(bridge.rewakeStorm.windowSecs / 60)} min` : runtimeLabel(runtime.state, pendingCount);

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
    if (!message) return;
    setChatDraft("");
    await bridge.send(message);
  }

  function runAhoy() {
    setAhoyVisible(false);
    navigate("chat");
    void bridge.send("/ahoy");
  }

  async function answerCall(id: string, text: string) {
    const messageId = await bridge.send(text);
    setCallMessageIds((current) => ({ ...current, [id]: messageId }));
  }

  function stopHost() {
    if (window.confirm("Stop the first mate? Nothing gets checked, merged or answered until you start it again. Work already underway keeps going.")) {
      void bridge.stop();
    }
  }

  if (!bearings || !fleet) return <div className="app-loading">Taking fresh bearings…</div>;

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
          <NavButton active={view === "chat"} icon={<MessageSquareText size={18} />} label="Chat" detail="First Mate" onClick={() => navigate("chat")} />
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
          <button className="icon-button" title="Settings"><Settings size={17} /></button>
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
            {(runtime.state === "dead" || runtime.state === "stopped") && <OfflineBanner onStart={() => void bridge.start()} />}
            {runtime.state === "locked_by_other" && <LockedBanner holder={runtime.holder} onCheck={() => void bridge.start()} />}
            {runtime.state === "refused" && <RefusedBanner reason={runtime.reason} onRetry={() => void bridge.start()} />}
            {bridge.rewakeStorm && <StormBanner storm={bridge.rewakeStorm} onAsk={() => { navigate("chat"); void bridge.send(stormQuestion(bridge.rewakeStorm!)); }} onRestart={() => void bridge.restart()} />}
            {bridge.healthWarning && <HostHealthBanner message={bridge.healthWarning} onRetry={() => void bridge.stop()} />}
            {ahoyVisible && (
              <section className="ahoy-card">
                <div className="ahoy-mark"><ShipWheel size={22} /></div>
                <div><span>Ahoy</span><h2>You've been away 3h 12m.</h2><p>The first mate can catch you up and take you through what's waiting.</p><strong>{bearings.decisions_open.length} waiting on you · {bearings.in_flight.length} underway</strong></div>
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
                  const task = fleet.tasks.find((candidate) => candidate.id === item.id);
                  return <button className="task-row" key={item.id} onClick={() => task && setActiveTask(task)}><span className="task-state warning"><CircleAlert size={16} /></span><span className="task-copy"><strong>{item.name}</strong><small>{projectName(item.repo)} · {item.kind}</small></span><span className="task-chip warning">{stateLabel(item.state)}</span><ChevronRight size={17} /></button>;
                })}
              </div>
              {bearings.in_flight.length === 0 && <EmptyState label="Nothing is underway." />}
            </DashboardSection>

            <DashboardSection title="Charted Next" icon={<Clock3 size={17} />} tone="amber" count={bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length}>
              {bearings.gates.map((item) => <CompactRow key={item.id} title={item.title} detail={item.reason} icon={<Clock3 size={15} />} badge="waiting" />)}
              {(bearings.unhealthy_endpoints ?? []).map((item) => <CompactRow key={`health-${item.id}`} title={`The first mate's records for ${projectName(fleet.tasks.find((task) => task.id === item.id)?.project ?? item.id)} don't match.`} detail="Nothing to do on your side." icon={<CircleAlert size={15} />} badge="needs repair" />)}
              {bearings.gates.length + (bearings.unhealthy_endpoints ?? []).length === 0 && <EmptyState label="Nothing is queued." />}
            </DashboardSection>
          </div>
        )}

        {view === "chat" && <ChatView messages={messages} outbox={outbox} draft={chatDraft} runtime={runtime.state} refusalReason={runtime.reason} hostLabel={hostLabel} storm={bridge.rewakeStorm} healthWarning={bridge.healthWarning} onDraft={setChatDraft} onSend={() => void sendChat()} onResend={(text) => void bridge.send(text)} onStart={() => void bridge.start()} onRestart={() => void bridge.restart()} />}
        {view === "projects" && <ProjectsView projects={projects} onOpen={openProject} />}
        {view === "project" && selectedProjectData && <ProjectView project={selectedProjectData} onOpenTask={setActiveTask} />}
      </main>

      {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
      {activeTask && <TaskDrawer task={activeTask} fleetSchema={fleet.schema} fleetGenerated={fleet.generated} expanded={showEverything} onCapture={bridge.paneCapture} onToggle={() => setShowEverything((current) => !current)} onClose={() => { setActiveTask(null); setShowEverything(false); }} />}
    </div>
  );
}

function NavButton({ active, icon, label, detail, count, onClick }: { active: boolean; icon: React.ReactNode; label: string; detail?: string; count?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>{count !== undefined && <em>{count}</em>}</button>;
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
      : state.error
        ? "The first mate didn't finish with your answer."
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
    return <article className={`decision-card ${read ? "read" : "queued"}`}><div className="decision-meta"><span>{decision.verb || "Your call"}</span><small>{decision.owner}</small></div><div className="call-state"><Check size={16} /><span><strong>{title}</strong>{!read && !state.error && <small>{detail}</small>}</span>{state.error ? <button onClick={() => onSend(preview)}>Send again</button> : !read && runtime === "dead" ? <button onClick={onStart}>Start the first mate</button> : null}</div></article>;
  }
  return <article className="decision-card" data-decision-id={decision.id}><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><h3 data-testid="decision-title">{decision.title}</h3><p data-testid="decision-reason">{decision.summary}</p><div className="suggestion-chips">{options.map((option) => <button className={selection === option.label ? "selected" : ""} key={option.label} onClick={() => { setSelection(option.label); setDateOpen(false); setDeferDate(""); }}><span>{option.label}</span>{option.recommended && <small>Recommended</small>}</button>)}<button className={dateOpen ? "selected" : ""} onClick={() => { setDateOpen(true); setSelection(""); }}>Not now</button></div>{dateOpen && <label className="date-field"><span>Ask me again</span><input type="date" value={deferDate} onChange={(event) => setDeferDate(event.target.value)} /></label>}<label className="reply-field"><span>{selection === "Send it back" ? "What should change?" : "Or write your own answer"}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label><div className="decision-actions"><span>→ sends: {preview}</span><button disabled={preview === "…"} onClick={() => onSend(preview)}><Send size={15} /> {mergeSelected && !note.trim() ? "Merge now" : "Send"}</button></div>{mergeSelected && note.trim() && <p className="merge-hint">This sends instructions, not a merge. Use Merge now to merge.</p>}</article>;
}

function ProjectsView({ projects, onOpen }: { projects: { name: string; posture: string; tasks: FleetTask[] }[]; onOpen: (name: string) => void }) {
  return <div className="content-scroll projects-page"><div className="project-grid">{projects.map((project) => <button key={project.name} className="project-card" onClick={() => onOpen(project.name)}><span className="project-sigil large">{project.name.slice(0, 2).toUpperCase()}</span><div><h2>{project.name}</h2><p>{project.posture}</p><span>{project.tasks.length} underway</span></div><ChevronRight size={18} /></button>)}</div></div>;
}

function ProjectView({ project, onOpenTask }: { project: { name: string; posture: string; tasks: FleetTask[] }; onOpenTask: (task: FleetTask) => void }) {
  return <div className="content-scroll project-page"><div className="posture-line"><Anchor size={15} /><span>{project.posture}</span></div><section className="project-summary"><div><span>Project</span><h2>{project.name}</h2><p>The first mate keeps this work within the project's standing delivery posture.</p></div><div className="project-stat"><strong>{project.tasks.length}</strong><span>Underway</span></div></section><DashboardSection title="Underway" icon={<Radio size={17} />} tone="blue" count={project.tasks.length}><div className="task-list">{project.tasks.map((task) => <button className="task-row" key={task.id} onClick={() => onOpenTask(task)}><span className="task-state warning"><CircleAlert size={16} /></span><span className="task-copy"><strong>{task.id}</strong><small>{task.kind} · {task.harness}</small></span><span className="task-chip warning">{stateLabel(task.current_state.state)}</span><ChevronRight size={17} /></button>)}</div></DashboardSection></div>;
}

function ChatView({ messages, outbox, draft, runtime, refusalReason, hostLabel, storm, healthWarning, onDraft, onSend, onResend, onStart, onRestart }: { messages: ChatMessage[]; outbox: Record<string, OutboxView>; draft: string; runtime: HostRuntimeState; refusalReason?: string; hostLabel: string; storm: RewakeStorm | null; healthWarning: string | null; onDraft: (value: string) => void; onSend: () => void; onResend: (text: string) => void; onStart: () => void; onRestart: () => void }) {
  const running = ["starting", "idle", "prompt_turn", "agent_turn", "restarting"].includes(runtime);
  const placeholder = runtime === "locked_by_other" ? "The first mate is running somewhere else. What you write here waits until it runs in this app." : running ? "Message the first mate" : "The first mate isn't running. It'll read this when it starts.";
  return <div className="chat-view">{(runtime === "dead" || runtime === "stopped") && <OfflineBanner onStart={onStart} />}{runtime === "locked_by_other" && <LockedBanner onCheck={onStart} />}{runtime === "refused" && <RefusedBanner reason={refusalReason} onRetry={onStart} />}{storm && <StormBanner storm={storm} onAsk={() => onDraft(stormQuestion(storm))} onRestart={onRestart} />}{healthWarning && <HostHealthBanner message={healthWarning} onRetry={onStart} />}<div className="chat-status"><span className="avatar">FM</span><div><strong>First Mate</strong><span><i className={`state-${runtime}`} /> {hostLabel}</span></div><button className="icon-button" onClick={onRestart} title="Restart the first mate"><RefreshCw size={16} /></button></div><div className="chat-messages"><div className="day-label">Today</div>{messages.length === 0 && <div className="chat-empty">The first mate is getting its bearings. Its first message will show up here.</div>}{messages.map((message) => <ChatMessageView key={message.id} message={message} outbox={outbox[message.id]} running={running} onResend={() => onResend(message.text)} />)}</div><div className="composer"><textarea value={draft} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={placeholder} aria-label="Message the first mate" /><div><button className="icon-button" title="Attach a file"><FileText size={17} /></button><button className="send-button" onClick={onSend} disabled={!draft.trim()} title="Send message"><Send size={16} /></button></div></div></div>;
}

function ChatMessageView({ message, outbox, running, onResend }: { message: ChatMessage; outbox?: OutboxView; running: boolean; onResend: () => void }) {
  const status = !outbox ? null : outbox.errorKind === "not_sent"
    ? "Not sent"
    : outbox.error
      ? "The first mate didn't finish with this"
    : outbox.resentAfterRestart
      ? `Re-sent after a restart${outbox.status === "picked_up" ? ` · Read by ${formatTime(outbox.readAt ?? message.createdAt)}` : ""}`
      : outbox.status === "picked_up"
        ? `Read by ${formatTime(outbox.readAt ?? message.createdAt)}`
        : "Queued";
  const tooltip = !outbox ? undefined : outbox.resentAfterRestart
    ? "The app stopped before the first mate finished with this, so it sent it again. If the first mate had already started on it, it may mention it twice."
    : outbox.status === "picked_up"
      ? `The first mate had read this by ${formatTime(outbox.readAt ?? message.createdAt)}, when it finished replying.`
      : running ? "The first mate will read this when it finishes what it's doing." : "The first mate will read this when it starts.";
  return <article className={message.who === "mate" ? "mate-message" : "captain-message"}>{message.who === "mate" && <span className="avatar small">FM</span>}<div><strong>{message.who === "mate" ? "First Mate" : "You"}</strong><p>{message.text}</p>{status ? <div className={`message-state ${outbox?.error ? "message-error" : ""}`} title={tooltip}><time>{status}</time>{outbox?.error && <button onClick={onResend}>{outbox.errorKind === "not_sent" ? "Retry" : "Send again"}</button>}</div> : <time>{formatTime(message.createdAt)}</time>}</div></article>;
}

function OfflineBanner({ onStart }: { onStart: () => void }) {
  return <section className="offline-banner"><CircleAlert size={18} /><div><strong>The first mate isn't running, so nothing gets checked, merged or answered.</strong><span>Work already underway keeps going.</span></div><button onClick={onStart}>Start the first mate</button></section>;
}

function LockedBanner({ holder, onCheck }: { holder?: string; onCheck: () => void }) {
  return <section className="offline-banner locked-banner"><CircleAlert size={18} /><div><strong>The first mate is already running for this home somewhere else, probably in a terminal.</strong><span>Only one can run at a time, so this app is showing the fleet without it.</span>{holder && <small title={holder}>Another session holds this home.</small>}</div><button onClick={onCheck}>Check again</button></section>;
}

function RefusedBanner({ reason, onRetry }: { reason?: string; onRetry: () => void }) {
  const permission = reason?.includes("claude-permission-mode");
  return <section className="offline-banner refused-banner"><CircleAlert size={18} /><div><strong>{permission ? "The first mate can't start: this home's permission setting isn't one it recognizes." : "The first mate can't start with this home."}</strong><span>Nothing was started. Work already underway keeps going.</span></div><div className="banner-actions"><button onClick={() => window.alert(reason ?? "No further details were reported.")}>Show details</button><button onClick={onRetry}>Try again</button></div></section>;
}

function StormBanner({ storm, onAsk, onRestart }: { storm: RewakeStorm; onAsk: () => void; onRestart: () => void }) {
  const minutes = Math.max(1, Math.round(storm.windowSecs / 60));
  return <section className="storm-banner"><CircleAlert size={18} /><div><strong>The first mate keeps getting woken up, {storm.turns} times in the last {minutes} minutes, and isn't settling. This uses up your Claude usage fast.</strong><span>Your messages still get through.</span></div><div><button onClick={onAsk}>Ask what's going on</button><button onClick={onRestart}>Restart the first mate</button></div></section>;
}

function HostHealthBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className="offline-banner"><CircleAlert size={18} /><div><strong>{message}</strong></div><div className="banner-actions"><button onClick={() => window.alert(message)}>Show details</button><button onClick={onRetry}>Try again</button></div></section>;
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
