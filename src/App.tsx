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
  Search,
  Send,
  Settings,
  ShipWheel,
  Sparkles,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import bearingsFixture from "./fixtures/bearings-snapshot.json";
import fleetFixture from "./fixtures/fleet-snapshot.json";

type BearingsTask = {
  id: string;
  kind: string;
  state: string;
  repo: string;
  name: string;
  doing: string;
};

type Decision = {
  id: string;
  key: string;
  verb: string;
  summary: string;
  owner: string;
};

type Landed = { id: string; what: string; artifact: string; owner: string };
type Gate = { id: string; title: string; blocked_by: string[]; reason: string; owner: string; filed: string };

type BearingsSnapshot = {
  schema: string;
  home: string;
  generated: string;
  prs: string;
  in_flight: BearingsTask[];
  decisions_open: Decision[];
  landed: Landed[];
  gates: Gate[];
  unhealthy_endpoints: { id: string; backend: string; target: string; exists: boolean; agent: string }[];
};

type FleetTask = {
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

type FleetSnapshot = {
  schema: string;
  generated: string;
  fm_home: string;
  tasks: FleetTask[];
};

type View = "bearings" | "chat" | "projects" | "project";
type ChatMessage = { who: "mate" | "captain"; text: string };
type CallState = "writing" | "queued" | "read";

const bearings = bearingsFixture as unknown as BearingsSnapshot;
const fleet = fleetFixture as unknown as FleetSnapshot;

function projectName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? "untitled-project";
}

function postureFor(task: FleetTask) {
  if (task.mode === "local-only") return "Stays on this machine · You land it";
  if (task.yolo === "on") return "Fully checked · Merges itself";
  return "Fully checked before a PR · You merge";
}

function stateLabel(state: string) {
  if (state === "unknown") return "Needs a fresh sighting";
  return state.replaceAll("_", " ");
}

function optionLabels(summary: string) {
  const optionLine = summary.match(/Options:\s*(.+)$/im)?.[1];
  if (!optionLine) return [];
  return optionLine.split(/\s*(?:·|\||,)\s*/).map((item) => item.replace(/\s*\(recommended\)\s*/i, "").trim()).filter(Boolean);
}

export function App() {
  const [view, setView] = useState<View>("bearings");
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<FleetTask | null>(null);
  const [showEverything, setShowEverything] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const [running, setRunning] = useState(true);
  const [ahoyVisible, setAhoyVisible] = useState(true);
  const [callStates, setCallStates] = useState<Record<string, CallState>>({});
  const [chatDraft, setChatDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { who: "mate", text: `Ahoy, captain. I took fresh bearings. ${bearings.in_flight.length} item is under way and ${bearings.unhealthy_endpoints.length} worker needs a fresh sighting.` },
  ]);

  const projects = useMemo(() => {
    const byName = new Map<string, FleetTask[]>();
    fleet.tasks.forEach((task) => {
      const name = projectName(task.project);
      byName.set(name, [...(byName.get(name) ?? []), task]);
    });
    return [...byName.entries()].map(([name, tasks]) => ({ name, tasks, posture: postureFor(tasks[0]) }));
  }, []);

  const selectedProjectData = projects.find((project) => project.name === selectedProject);
  const title = view === "bearings" ? "Bearings" : view === "chat" ? "Chat" : view === "projects" ? "Projects" : selectedProject ?? "Project";
  const subtitle = view === "project" && selectedProjectData ? selectedProjectData.posture : view === "chat" ? "The first mate" : view === "bearings" ? `As of ${formatTime(bearings.generated)}` : `${projects.length} project`;
  const openCallCount = bearings.decisions_open.length;

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

  function sendChat() {
    const message = chatDraft.trim();
    if (!message) return;
    setMessages((current) => [...current, { who: "captain", text: message }]);
    setChatDraft("");
  }

  function runAhoy() {
    setMessages((current) => [...current, { who: "captain", text: "/ahoy" }, { who: "mate", text: "Captain, nothing happened after your last message. The probe task still needs a fresh sighting." }]);
    setAhoyVisible(false);
    navigate("chat");
  }

  function queueCall(id: string) {
    setCallStates((current) => ({ ...current, [id]: "queued" }));
    if (running) setTimeout(() => setCallStates((current) => ({ ...current, [id]: "read" })), 1200);
  }

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
          <div className="connection"><span className={`live-dot ${running ? "" : "offline"}`} /><span><strong>First Mate</strong><small>{running ? `Snapshot ${formatTime(bearings.generated)}` : "Not running"}</small></span></div>
          <button className="runtime-button" onClick={() => setRunning((current) => !current)}>{running ? "Stop" : "Start"}</button>
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
          <div className="content-scroll bearings-page" data-screen="bearings">
            {!running && <OfflineBanner onStart={() => setRunning(true)} />}
            {ahoyVisible && (
              <section className="ahoy-card">
                <div className="ahoy-mark"><ShipWheel size={22} /></div>
                <div><span>Ahoy</span><h2>You've been away 3h 12m.</h2><p>The first mate can catch you up and take you through what's waiting.</p><strong>{bearings.decisions_open.length} waiting on you · {bearings.in_flight.length} underway</strong></div>
                <div className="ahoy-actions"><button onClick={runAhoy}>Ahoy</button><button onClick={() => setAhoyVisible(false)}>Not now</button></div>
              </section>
            )}
            <DashboardSection title="Captain's Call" icon={<Inbox size={17} />} tone="coral" count={bearings.decisions_open.length}>
              {bearings.decisions_open.map((decision) => (
                <DecisionCard key={decision.id} decision={decision} state={callStates[decision.id] ?? "writing"} running={running} onSend={() => queueCall(decision.id)} onStart={() => setRunning(true)} />
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

            <DashboardSection title="Charted Next" icon={<Clock3 size={17} />} tone="amber" count={bearings.gates.length + bearings.unhealthy_endpoints.length}>
              {bearings.gates.map((item) => <CompactRow key={item.id} title={item.title} detail={item.reason} icon={<Clock3 size={15} />} badge="waiting" />)}
              {bearings.unhealthy_endpoints.map((item) => <CompactRow key={`health-${item.id}`} title={`The first mate's records for ${projectName(fleet.tasks.find((task) => task.id === item.id)?.project ?? item.id)} don't match.`} detail="Nothing to do on your side." icon={<CircleAlert size={15} />} badge="needs repair" />)}
              {bearings.gates.length + bearings.unhealthy_endpoints.length === 0 && <EmptyState label="Nothing is queued." />}
            </DashboardSection>
          </div>
        )}

        {view === "chat" && <ChatView messages={messages} draft={chatDraft} running={running} onDraft={setChatDraft} onSend={sendChat} onStart={() => setRunning(true)} />}
        {view === "projects" && <ProjectsView projects={projects} onOpen={openProject} />}
        {view === "project" && selectedProjectData && <ProjectView project={selectedProjectData} onOpenTask={setActiveTask} />}
      </main>

      {mobileNavOpen && <button className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
      {activeTask && <TaskDrawer task={activeTask} expanded={showEverything} onToggle={() => setShowEverything((current) => !current)} onClose={() => { setActiveTask(null); setShowEverything(false); }} />}
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
  return <div className="compact-row"><span>{icon}</span><div><strong>{title}</strong><small>{detail}</small></div>{badge && <em>{badge}</em>}</div>;
}

function DecisionCard({ decision, state, running, onSend, onStart }: { decision: Decision; state: CallState; running: boolean; onSend: () => void; onStart: () => void }) {
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
  if (state !== "writing") return <article className={`decision-card ${state}`}><div className="decision-meta"><span>{decision.verb || "Your call"}</span><small>{decision.owner}</small></div><div className="call-state"><Check size={16} /><span><strong>{state === "queued" ? "Queued" : `Answered · the first mate read it at ${formatTime(bearings.generated)}`}</strong>{state === "queued" && <small>{running ? "The first mate will read this when it finishes what it's doing" : "The first mate will read this when it starts"}</small>}</span>{state === "queued" && !running && <button onClick={onStart}>Start the first mate</button>}</div></article>;
  return <article className="decision-card"><div className="decision-meta"><span>{decision.key || decision.verb || "Your call"}</span><small>{decision.owner}</small></div><p>{decision.summary}</p><button className="text-link">See how the first mate asked</button><div className="suggestion-chips">{options.map((option) => <button className={selection === option ? "selected" : ""} key={option} onClick={() => { setSelection(option); setDateOpen(false); setDeferDate(""); }}>{option}</button>)}<button className={dateOpen ? "selected" : ""} onClick={() => { setDateOpen(true); setSelection(""); }}>Not now</button></div>{dateOpen && <label className="date-field"><span>Ask me again</span><input type="date" value={deferDate} onChange={(event) => setDeferDate(event.target.value)} /></label>}<label className="reply-field"><span>{selection === "Send it back" ? "What should change?" : "Or write your own answer"}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label><div className="decision-actions"><span>→ sends: {preview}</span><button disabled={preview === "…"} onClick={onSend}><Send size={15} /> {mergeSelected && !note.trim() ? "Merge now" : "Send"}</button></div>{mergeSelected && note.trim() && <p className="merge-hint">This sends instructions, not a merge. Use Merge now to merge.</p>}</article>;
}

function ProjectsView({ projects, onOpen }: { projects: { name: string; posture: string; tasks: FleetTask[] }[]; onOpen: (name: string) => void }) {
  return <div className="content-scroll projects-page"><div className="project-grid">{projects.map((project) => <button key={project.name} className="project-card" onClick={() => onOpen(project.name)}><span className="project-sigil large">{project.name.slice(0, 2).toUpperCase()}</span><div><h2>{project.name}</h2><p>{project.posture}</p><span>{project.tasks.length} underway</span></div><ChevronRight size={18} /></button>)}</div></div>;
}

function ProjectView({ project, onOpenTask }: { project: { name: string; posture: string; tasks: FleetTask[] }; onOpenTask: (task: FleetTask) => void }) {
  return <div className="content-scroll project-page"><div className="posture-line"><Anchor size={15} /><span>{project.posture}</span></div><section className="project-summary"><div><span>Project</span><h2>{project.name}</h2><p>The first mate keeps this work within the project's standing delivery posture.</p></div><div className="project-stat"><strong>{project.tasks.length}</strong><span>Underway</span></div></section><DashboardSection title="Underway" icon={<Radio size={17} />} tone="blue" count={project.tasks.length}><div className="task-list">{project.tasks.map((task) => <button className="task-row" key={task.id} onClick={() => onOpenTask(task)}><span className="task-state warning"><CircleAlert size={16} /></span><span className="task-copy"><strong>{task.id}</strong><small>{task.kind} · {task.harness}</small></span><span className="task-chip warning">{stateLabel(task.current_state.state)}</span><ChevronRight size={17} /></button>)}</div></DashboardSection></div>;
}

function ChatView({ messages, draft, running, onDraft, onSend, onStart }: { messages: ChatMessage[]; draft: string; running: boolean; onDraft: (value: string) => void; onSend: () => void; onStart: () => void }) {
  return <div className="chat-view">{!running && <OfflineBanner onStart={onStart} />}<div className="chat-status"><span className="avatar">FM</span><div><strong>First Mate</strong><span><i className={running ? "" : "offline"} /> {running ? "Online" : "Not running"}</span></div></div><div className="chat-messages"><div className="day-label">Today</div>{messages.map((message, index) => <article className={message.who === "mate" ? "mate-message" : "captain-message"} key={`${message.text}-${index}`}>{message.who === "mate" && <span className="avatar small">FM</span>}<div><strong>{message.who === "mate" ? "First Mate" : "You"}</strong><p>{message.text}</p><time>{index === 0 ? formatTime(bearings.generated) : "Now"}</time></div></article>)}</div><div className="composer"><textarea value={draft} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={running ? "Message the first mate" : "The first mate isn't running. It'll read this when it starts."} aria-label="Message the first mate" /><div><button className="icon-button" title="Attach a file"><FileText size={17} /></button><button className="send-button" onClick={onSend} disabled={!draft.trim()} title="Send message"><Send size={16} /></button></div></div></div>;
}

function OfflineBanner({ onStart }: { onStart: () => void }) {
  return <section className="offline-banner"><CircleAlert size={18} /><div><strong>The first mate isn't running, so nothing gets checked, merged or answered.</strong><span>Work already underway keeps going.</span></div><button onClick={onStart}>Start the first mate</button></section>;
}

function TaskDrawer({ task, expanded, onToggle, onClose }: { task: FleetTask; expanded: boolean; onToggle: () => void; onClose: () => void }) {
  const timeline = [
    { title: "Registered with the fleet", detail: `${task.kind} · ${task.harness}`, time: "Start", icon: <GitBranch size={15} /> },
    { title: task.paths.status_log.last_event.state, detail: task.paths.status_log.last_event.note, time: "Latest", icon: <Radio size={15} /> },
    { title: stateLabel(task.current_state.state), detail: "The first mate could not confirm the worker's current state.", time: formatTime(task.current_state.observed_at), icon: <CircleAlert size={15} /> },
  ];
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="task-drawer" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><div><span>{projectName(task.project)}</span><h2>{task.id}</h2></div><button className="icon-button" onClick={onClose} title="Close task details"><X size={18} /></button></header><div className="drawer-status"><span className="task-state warning"><CircleAlert size={16} /></span><div><strong>{stateLabel(task.current_state.state)}</strong><span>The first mate could not confirm the worker's current state.</span></div></div><div className="drawer-scroll"><DrawerSection title="Instructions"><div className="brief-block"><p>{task.paths.status_log.last_event.note}</p></div></DrawerSection><DrawerSection title="Timeline"><div className="timeline">{timeline.map((item) => <div key={item.title}><span className="timeline-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span><time>{item.time}</time></div>)}</div></DrawerSection><DrawerSection title="PR"><div className="pr-block">{task.pr.url ? <a href={task.pr.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {task.pr.url}</a> : <span><GitBranch size={15} /> No PR recorded</span>}</div></DrawerSection><DrawerSection title="Worker's screen"><p className="worker-caption">Read-only. To change anything, tell the first mate.</p><div className="worker-screen"><header><TerminalSquare size={14} /><span>{task.endpoint.target}</span><em>Updated just now</em></header><pre>{`status: ${task.endpoint.status}\nbackend: ${task.backend}\nworker: ${task.endpoint.agent_alive}\nworktree: ${task.paths.worktree.present ? task.paths.worktree.path : "missing"}\nobserved: ${task.endpoint.observed_at}`}</pre></div></DrawerSection><button className="show-everything" onClick={onToggle}><ChevronDown size={16} className={expanded ? "rotated" : ""} /><span>Show everything</span></button>{expanded && <div className="machine-details"><dl><dt>Branch</dt><dd>none recorded</dd><dt>Isolated copy</dt><dd>{task.paths.worktree.present ? task.paths.worktree.path : "missing"}</dd><dt>Worker runtime</dt><dd>{task.harness} on {task.backend}</dd><dt>Status line</dt><dd>{task.current_state.raw}</dd><dt>Log</dt><dd>{task.paths.status_log.last_event.raw}</dd></dl><div className="step-chips"><span>Registered</span><span>{task.current_state.freshness}</span><span>Endpoint {task.endpoint.status}</span><span>PR {task.pr.source}</span><span>Report {task.paths.report.present ? "ready" : "none"}</span></div></div>}</div><footer className="drawer-footer">From {fleet.schema} · {formatTime(fleet.generated)}</footer></aside></div>;
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="drawer-section"><h3>{title}</h3>{children}</section>;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
