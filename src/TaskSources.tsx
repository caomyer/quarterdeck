import { useEffect, useId, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, CircleDot, CircleSlash, Clock3, Ellipsis, Inbox, Link2, MessageSquare, Send, TriangleAlert } from "lucide-react";
import type { BacklogRecord, HostAdapter, SourcesRead, TaskSource } from "./host";
import { ago, changedSinceFiled, chipText, chipTone, divergence, firstWords, freshness, type LinkView, type OfferRow, policyLine, providerName, readingProblem, type UpstreamLine, upstreamLines } from "./sources.ts";

/** firstmate's refusal as a sentence, its reason kept in its own words. */
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function when(value: string) {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function Outside({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return <a className={className} href={href} title={href} target="_blank" rel="noreferrer noopener" onClick={(event) => { event.preventDefault(); window.open(href, "_blank", "noreferrer"); }}>{children}</a>;
}

/** What a GitHub source can write back, in the words of firstmate's own setting for when it first speaks. */
function outboundChoices(firstMilestone: string | null | undefined): { value: TaskSource["outbound"]; label: string; detail: string }[] {
  const started = firstMilestone === "started";
  return [
    { value: "comments", label: started ? "A comment when work starts, when a PR is up, and when it lands" : "A comment when a PR is up, and one when the work lands", detail: `${firstWords(firstMilestone)} Closing the issue is left to GitHub: a PR that says Fixes #n closes it on merge.` },
    { value: "none", label: "Nothing", detail: "The fleet reads the issue and says nothing back." },
  ];
}

/** The first line a source shows in Settings: who it reads as, how fresh, and what it holds. */
function sourceLine(source: TaskSource, now: number) {
  const linked = new Set(source.sent.map((write) => write.item).concat(Object.values(source.filed).map((copy) => copy.item))).size;
  return [source.identity ? `via ${source.provider === "github" ? "gh" : "its sign-in"}, signed in as ${source.identity}` : null, freshness(source, now), linked ? `${linked} linked` : null].filter(Boolean).join(" · ");
}

/** What the sign-in can do on the source, from `probe`, in the captain's words. */
function capabilityLine(source: TaskSource) {
  const can = source.can;
  if (!can) return null;
  const noun = source.provider === "github" ? "issues in this repository" : "its items";
  if (can.read && can.comment) return `This sign-in can read and comment on ${noun}.`;
  if (can.read) return `This sign-in can read ${noun}, but not comment on them.`;
  return null;
}

/**
 * Task sources, in the settings: where the fleet takes work on from and reports back to. Everything is read and
 * written through firstmate's own `bin/fm-sources.sh`; GitHub reuses the first mate's `gh` sign-in, so there is no
 * credential to enter, and Linear and Jira are not offered until someone's work lives there.
 */
export function SourcesSettings({ host, projects }: { host: HostAdapter; projects: string[] }) {
  const [read, setRead] = useState<SourcesRead | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [project, setProject] = useState(projects[0] ?? "");
  const [filter, setFilter] = useState("label:quarterdeck is:open");
  const [outbound, setOutbound] = useState<TaskSource["outbound"]>("comments");
  const now = Date.now();
  const ids = useId();

  useEffect(() => {
    let live = true;
    host.sourcesGet().then((next) => live && setRead(next), (problem) => live && setLoadProblem(errorText(problem)));
    return () => { live = false; };
  }, [host]);
  useEffect(() => { if (!project && projects[0]) setProject(projects[0]); }, [projects, project]);

  const act = async (work: () => Promise<SourcesRead>) => {
    setBusy(true);
    setError(null);
    try {
      setRead(await work());
      return true;
    } catch (problem) {
      setError(errorText(problem));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const beginAdd = () => { setAdding(true); setEditing(null); setError(null); setRepo(""); setFilter("label:quarterdeck is:open"); setOutbound("comments"); };
  const beginEdit = (source: TaskSource) => { setEditing(source.id); setAdding(false); setError(null); setFilter(source.filter); setOutbound(source.outbound); };
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await act(() => host.sourcesAdd("github", repo.trim(), project, filter, outbound))) setAdding(false);
  };
  const save = async (source: TaskSource) => {
    const change = { ...(filter !== source.filter ? { filter } : {}), ...(outbound !== source.outbound ? { outbound } : {}) };
    if (!Object.keys(change).length) { setEditing(null); return; }
    if (await act(() => host.sourcesEdit(source.id, change))) setEditing(null);
  };

  const sources = read?.sources ?? [];
  const policy = (name: string) => <fieldset className="routing-start" disabled={busy}>
    <legend>What the issue hears back</legend>
    {outboundChoices(read?.first_milestone).map((option) => <label key={option.value} className={outbound === option.value ? "chosen" : undefined}>
      <input type="radio" name={`${ids}-${name}`} value={option.value} checked={outbound === option.value} onChange={() => setOutbound(option.value)} />
      <span><strong>{option.label}</strong><small>{option.detail}</small></span>
    </label>)}
  </fieldset>;
  const filterField = <label className="source-field"><span>Take on issues that</span><input value={filter} spellCheck={false} autoCapitalize="off" disabled={busy} aria-label="Take on issues that" onChange={(event) => setFilter(event.target.value)} /><small>A label is required, so strangers on a public repository cannot queue work. <code>is:open</code> keeps closed issues out.</small></label>;

  return <section className="routing sources-settings" aria-labelledby={`${ids}-title`} data-testid="sources-settings">
    <div className="routing-head"><div>
      <h3 id={`${ids}-title`}>Task sources</h3>
      <p>Issues the fleet can take on, and where it reports back. The first mate reads them every 5 minutes while it runs.</p>
    </div></div>
    {loadProblem && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>Task sources could not be read: {loadProblem}</span></div>}
    {read?.problem && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>{read.problem}</span></div>}
    {read && !read.unsupported && <div className="source-list" data-testid="source-list">
      {sources.map((source) => {
        const problem = readingProblem(source, now);
        return <div className="source-row" key={source.id} data-source={source.id}>
          <div className="source-row-head">
            <span className="source-mark">{providerName(source.provider)}</span>
            <div><strong>{source.locator}</strong><small>{sourceLine(source, now)}</small></div>
            {editing !== source.id && <button type="button" className="routing-quiet" disabled={busy} onClick={() => beginEdit(source)}>Edit</button>}
          </div>
          {problem && <div className="source-note warn" role="status"><TriangleAlert size={15} /><span><strong>{problem.title}.</strong> {problem.detail}</span></div>}
          {editing === source.id && <div className="source-form">
            {filterField}
            {policy(source.id)}
            {capabilityLine(source) && <p className="source-can"><Check size={14} /> {capabilityLine(source)}</p>}
            <div className="routing-actions">
              <button type="button" className="routing-primary" disabled={busy} onClick={() => void save(source)}>{busy ? "Saving…" : "Save"}</button>
              <button type="button" className="routing-quiet" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="routing-quiet source-remove" disabled={busy} onClick={() => void act(() => host.sourcesRemove(source.id)).then((ok) => ok && setEditing(null))}>Disconnect</button>
            </div>
            <small>Disconnecting keeps every link and anything still owed, for when it is connected again.</small>
          </div>}
        </div>;
      })}
      {sources.length === 0 && !adding && <p className="routing-state">No task source is connected. The fleet takes work only from you.</p>}
    </div>}
    {read && !read.unsupported && !adding && <div className="source-add-row">
      <div><strong>Add a repository</strong><small>Uses the GitHub sign-in the first mate already has.</small></div>
      <button type="button" className="btn-base" disabled={busy || projects.length === 0} title={projects.length === 0 ? "Add a project to the fleet first" : undefined} onClick={beginAdd}>Add</button>
    </div>}
    {adding && <form className="source-form" onSubmit={(event) => void add(event)} data-testid="source-add">
      <label className="source-field"><span>Repository</span><input value={repo} placeholder="owner/name" spellCheck={false} autoCapitalize="off" disabled={busy} aria-label="Repository" onChange={(event) => setRepo(event.target.value)} /></label>
      <label className="source-field"><span>Project</span><select value={project} disabled={busy} aria-label="Project" onChange={(event) => setProject(event.target.value)}>{projects.map((name) => <option key={name} value={name}>{name}</option>)}</select><small>Its issues are offered on this project's page.</small></label>
      {filterField}
      {policy("add")}
      <div className="routing-actions">
        <button type="submit" className="routing-primary" disabled={busy || !repo.trim() || !project}>{busy ? "Connecting…" : "Connect"}</button>
        <button type="button" className="routing-quiet" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
      </div>
    </form>}
    {error && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {read && !read.unsupported && <small className="source-later">Linear and Jira are not offered yet: they come when someone's fleet work lives there.</small>}
  </section>;
}

type IntakeProps = {
  project: string;
  rows: OfferRow[];
  sources: TaskSource[];
  now: number;
  sendReady: boolean;
  onTakeOn: (row: OfferRow, note: string) => Promise<void>;
  onDismiss: (row: OfferRow) => Promise<void>;
  onOpenTask: (record: BacklogRecord) => void;
  onChat: () => void;
  onStartHost: () => void;
};

/**
 * A project's intake: issues its sources offer, each taken on or put aside by the captain. Taking one on is one message
 * to the first mate, on the path starting work uses; it files the issue as a queued task, and starting it stays a
 * separate choice in that task's drawer.
 */
export function IntakeSection({ project, rows, sources, now, sendReady, onTakeOn, onDismiss, onOpenTask, onChat, onStartHost }: IntakeProps) {
  const mine = sources.filter((source) => source.project === project);
  if (mine.length === 0) return null;
  const fresh = rows.filter((row) => row.phase === "offered" || row.phase === "offline").length;
  const names = [...new Set(mine.map((source) => providerName(source.provider)))].join(" and ");
  const problems = mine.map((source) => readingProblem(source, now)).filter((problem) => problem !== null);
  return <section className="dashboard-section intake" data-testid="intake">
    <div className="section-heading"><span className="section-dot sea" aria-hidden="true" /><h2>From {names}</h2><span className="section-count">{fresh}</span><span className="section-count-label">new · {mine.map((source) => freshness(source, now)).join(", ")}</span></div>
    {problems.map((problem) => <div className="source-note warn" key={problem!.title} role="status"><TriangleAlert size={15} /><span><strong>{problem!.title}.</strong> {problem!.detail}</span></div>)}
    {rows.length > 0
      ? <div className="task-list" data-testid="intake-list">{rows.map((row) => <IntakeRow key={`${row.source.id} ${row.item.id}`} row={row} now={now} sendReady={sendReady} onTakeOn={onTakeOn} onDismiss={onDismiss} onOpenTask={onOpenTask} onChat={onChat} onStartHost={onStartHost} />)}</div>
      : <div className="empty-state"><Inbox size={16} /><span>Nothing new. Issues labelled for the fleet show here{mine.length === 1 ? ` (${mine[0].filter})` : ""}.</span></div>}
  </section>;
}

function IntakeRow({ row, now, sendReady, onTakeOn, onDismiss, onOpenTask, onChat, onStartHost }: { row: OfferRow; now: number; sendReady: boolean } & Pick<IntakeProps, "onTakeOn" | "onDismiss" | "onOpenTask" | "onChat" | "onStartHost">) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { item, ask, phase } = row;
  useEffect(() => { setOpen(false); }, [ask?.at]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try { await work(); } catch (error) { setProblem(errorText(error)); } finally { setBusy(false); }
  };
  const updated = `updated ${ago(now - Date.parse(item.updated_at))}`;
  const line = phase === "asked" && ask ? `${item.key} · asked the first mate ${ago(now - ask.at)}`
    : phase === "filed" && row.filedAs ? `${item.key} · filed as ${row.filedAs.id} · ${row.filedAs.state === "queued" ? "queued" : row.filedAs.state === "in_flight" ? "in flight" : "done"}`
    : phase === "not_sent" ? `${item.key} · the ask was not sent`
    : phase === "answered" ? `${item.key} · the first mate answered in chat instead of filing it`
    : `${item.key} · ${updated}`;
  const tone = phase === "not_sent" ? "coral" : phase === "answered" ? "amber" : phase === "filed" ? "green" : phase === "asked" ? "blue" : "sea";
  const icon = phase === "not_sent" ? <TriangleAlert size={16} /> : phase === "answered" ? <MessageSquare size={16} /> : phase === "filed" ? <Check size={16} /> : phase === "asked" ? <Ellipsis size={16} /> : <CircleDot size={16} />;
  return <div className="intake-row" data-item={item.id} data-phase={phase}>
    <div className="task-row wide intake-head">
      <span className={`task-state tone-${tone}`}>{icon}</span>
      <span className="task-copy"><strong>{item.title}</strong><small>{line}</small></span>
      <span className="intake-actions">
        {(phase === "offered" || phase === "offline") && !open && <>
          <button className="btn-base" disabled={busy} onClick={() => void run(() => onDismiss(row))}>Not now</button>
          {phase === "offline"
            ? <button className="btn-base" onClick={onStartHost} title="Only the first mate files work">Start the first mate</button>
            : <button className="btn-base primary" onClick={() => { setOpen(true); setNote(""); }}>Take it on</button>}
        </>}
        {phase === "asked" && <span className="task-chip tone-blue">asked</span>}
        {phase === "filed" && row.filedAs && <button className="btn-base" onClick={() => onOpenTask(row.filedAs!)}>Open</button>}
        {phase === "not_sent" && ask && <button className="btn-base primary" disabled={busy || !sendReady} onClick={() => void run(() => onTakeOn(row, ask.note ?? ""))}>{busy ? "Sending…" : "Send again"}</button>}
        {phase === "answered" && <button className="btn-base" onClick={onChat}>Open chat</button>}
        <Outside href={item.url} className="icon-button intake-link"><ArrowUpRight size={15} /></Outside>
      </span>
    </div>
    {open && <div className="brief-block start-block new intake-panel" data-testid="take-on-panel">
      <p>The first mate files it as a queued task, choosing the id, kind and repo, and links it to {item.key}. Start it from its drawer when you want it worked on.</p>
      <label className="start-field"><span><b>Anything to add?</b> Optional, in your words.</span><textarea value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} aria-label="Anything to add?" placeholder={'For example "after the permissions work"'} /></label>
      <div className="start-actions"><button className="btn-base primary" disabled={busy || !sendReady} onClick={() => void run(() => onTakeOn(row, note))}><Send size={13} /> {busy ? "Handing over…" : "Hand to the first mate"}</button><button className="btn-base" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
    </div>}
    {problem && <p className="start-problem" role="alert">{problem}</p>}
  </div>;
}

/** The chip under a linked task's title: which item, its state upstream, and how fresh that is. */
export function SourceChips({ views, now }: { views: LinkView[]; now: number }) {
  if (views.length === 0) return null;
  return <div className="source-chips" data-testid="source-chips">{views.map((view) => {
    const text = chipText(view, now);
    const url = view.item?.url ?? view.filed?.url;
    return url
      ? <Outside key={`${view.link.source} ${view.link.item}`} href={url} className={`source-chip tone-${chipTone(view)}`}><Link2 size={13} />{text}<ArrowUpRight size={12} /></Outside>
      : <span key={`${view.link.source} ${view.link.item}`} className={`source-chip tone-${chipTone(view)}`}><Link2 size={13} />{text}</span>;
  })}</div>;
}

/** An Upstream line's icon: what kind of thing happened, or a warning when it went wrong. */
const LINE_ICONS: Record<UpstreamLine["kind"] | "warn", React.ReactNode> = {
  linked: <Link2 size={14} />, written: <MessageSquare size={14} />, owed: <Clock3 size={14} />, status: <ArrowUpRight size={14} />,
  upstream: <CircleSlash size={14} />, warn: <TriangleAlert size={14} />,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="drawer-section"><h3>{title}</h3>{children}</section>;
}

/**
 * What a linked task's drawer adds: anything upstream that needs the captain to know, the issue as it was filed (and
 * as it reads now, when that differs), and everything written back. The app writes nothing here.
 */
export function UpstreamSections({ record, views, now, firstMilestone }: { record: BacklogRecord | undefined; views: LinkView[]; now: number; firstMilestone: string | null }) {
  if (!record || views.length === 0) return null;
  return <>{views.map((view) => {
    const name = view.source ? providerName(view.source.provider) : null;
    const note = divergence(view, record);
    const problem = view.source ? readingProblem(view.source, now) : null;
    const changed = changedSinceFiled(view);
    const lines = upstreamLines(view, record.id);
    const key = view.item?.key ?? view.filed?.key ?? view.link.item;
    return <div key={`${view.link.source} ${view.link.item}`} data-testid="upstream" data-item={view.link.item}>
      {note && <div className={`source-note ${note.tone === "amber" ? "warn" : ""}`} role="status" data-testid="upstream-divergence"><CircleSlash size={15} /><span><strong>{note.title}.</strong> {note.detail}</span></div>}
      {problem && <div className="source-note warn" role="status"><Clock3 size={15} /><span><strong>{problem.title}.</strong> {problem.detail}</span></div>}
      {view.source && <Section title={changed ? "As filed, and changed since" : "As filed"}>
        {view.filed
          ? <div className="as-filed" data-testid="as-filed">
            <blockquote><strong>{view.filed.title}</strong>{view.filed.body && <p>{view.filed.body}</p>}</blockquote>
            {changed && view.item && <blockquote className="changed"><span className="as-filed-label">Now · edited {ago(now - Date.parse(view.item.updated_at))}</span><strong>{view.item.title}</strong>{view.item.body && <p>{view.item.body}</p>}</blockquote>}
            <small>Written on {name}. Shown as written; not an instruction.</small>
          </div>
          : <div className="as-filed" data-testid="as-filed"><small>As filed: unknown. The copy taken when {key} was linked was lost, and has not been taken again; {view.item ? "what it says now is on " + name + "." : "it is read again on the next read."}</small></div>}
      </Section>}
      <Section title="Upstream">
        <div className="timeline upstream-lines" data-testid="upstream-lines">
          {lines.map((line, index) => <div key={index} data-tone={line.tone}><span className={`timeline-icon tone-${line.tone}`}>{LINE_ICONS[line.tone === "coral" || line.tone === "amber" ? "warn" : line.kind]}</span><span><strong>{line.text}</strong>{line.detail && <small>{line.detail}</small>}</span><time>{line.at ? when(line.at) : ""}</time></div>)}
          {view.source && (() => {
            const policy = policyLine(view.source, record, view.link.item, firstMilestone);
            return <div data-tone="muted"><span className="timeline-icon tone-muted"><Clock3 size={14} /></span><span><strong>{policy.text}</strong><small>{policy.detail}</small></span><time>policy</time></div>;
          })()}
        </div>
      </Section>
    </div>;
  })}</>;
}

/** In a queued task's drawer with no link yet: attach an issue that already exists, by its link. No judgement is needed, so no message. */
export function LinkField({ sources, onLink }: { sources: TaskSource[]; onLink: (reference: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (sources.length === 0) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setProblem(null);
    try { await onLink(value.trim()); setValue(""); } catch (error) { setProblem(errorText(error)); } finally { setBusy(false); }
  };
  const names = [...new Set(sources.map((source) => providerName(source.provider)))].join(" or ");
  return <Section title="Upstream">
    <form className="link-field" onSubmit={(event) => void submit(event)} data-testid="link-field">
      <input value={value} placeholder={`Paste a ${names} issue link or #number`} spellCheck={false} disabled={busy} aria-label="Link an issue" onChange={(event) => setValue(event.target.value)} />
      <button type="submit" className="btn-base" disabled={busy || !value.trim()}>{busy ? "Linking…" : "Link"}</button>
    </form>
    {problem && <p className="start-problem" role="alert">{problem}</p>}
    <small className="link-hint">Links this task to an issue that already exists, so the issue hears when the work lands.</small>
  </Section>;
}
