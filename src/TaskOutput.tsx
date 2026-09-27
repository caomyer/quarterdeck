/**
 * A task's output in its own view: what it produced, leading its drawer; what the captain gave it, folded under that;
 * and, on a page it presented, a strip back to the task with its other pages beside it.
 *
 * UNREVIEWED DESIGN. This builds `task-list` rev 1's answer to the captain's t5 comment ("artifact can also be some
 * sort of baked into the task view"), which he has not reviewed. It lives on the overnight branch so he can see it
 * working instead of drawn, and it is his to accept or reject.
 *
 * Everything drawn here is read by `src/produced.ts`, from what outlives the worker. A task has a worktree only while
 * it runs and gives it back on cleanup, so nothing here names one.
 */
import { ChevronLeft, ChevronRight, ExternalLink, FileText, GitMerge, GitPullRequest, PanelsTopLeft, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, BacklogRecord, TaskReport } from "./host/types";
import type { Output, PageOutput, ReportOutput } from "./produced";
import { PriorityBadge } from "./TaskList";

/** Reads a task's report through the host; `null` when it has written none. */
export type ReadReport = (task: string) => Promise<TaskReport | null>;

/** Opens a link outside the app, as every link the app shows does. */
function openOutside(href: string) {
  window.open(href, "_blank", "noreferrer");
}

/**
 * What a task produced, first in its drawer: every page with what is new since the captain looked and what it asks of
 * him, the report when it has no page, read here, and the PR. The one that needs him is marked and first.
 *
 * `noPr` is set for work that opens a PR and has not yet; a task that never opens one says nothing about it.
 */
export function ProducedSection({ task, output, delivered, noPr, reportOpen, readReport, onOpenPage, onAskReport }: {
  task: string; output: Output[]; delivered?: boolean; noPr?: boolean; reportOpen?: boolean; readReport: ReadReport;
  onOpenPage: (artifact: Artifact) => void; onAskReport: () => void;
}) {
  const title = delivered ? "What it delivered" : "What it produced";
  return <section className="drawer-section" data-testid="task-output">
    <h3>{title}</h3>
    {output.length === 0 && !noPr
      ? <p className="to-none" data-testid="output-none">Nothing yet. Its pages, its report and its PR show here as the work makes them.</p>
      : <div className="to-list">
          {output.map((item) => item.kind === "page"
            ? <PageLine key={`${item.artifact.name}`} item={item} onOpen={() => onOpenPage(item.artifact)} />
            : item.kind === "report"
            ? <ReportLine key="report" task={task} item={item} open={reportOpen} read={readReport} onAsk={onAskReport} />
            : <a key="pr" className="to-row" data-output="pr" href={item.url} target="_blank" rel="noreferrer noopener" onClick={(event) => { event.preventDefault(); openOutside(item.url); }} title={item.url}>
                <span className="to-icon">{item.merged ? <GitMerge size={15} /> : <GitPullRequest size={15} />}</span>
                <span className="to-copy"><strong>{item.number ? `PR #${item.number}` : "Its PR"}</strong><small>{item.merged ? "Merged" : item.url.replace(/^https?:\/\//, "")}</small></span>
                <span className="to-act quiet">Open <ExternalLink size={12} /></span>
              </a>)}
          {noPr && !output.some((item) => item.kind === "pr") && <div className="to-row static" data-output="no-pr">
            <span className="to-icon"><GitPullRequest size={15} /></span>
            <span className="to-copy"><strong>No PR yet</strong><small>It shows here when the worker opens one.</small></span>
          </div>}
        </div>}
  </section>;
}

function PageLine({ item, onOpen }: { item: PageOutput; onOpen: () => void }) {
  const rev = item.artifact.latest.rev;
  return <button type="button" className={`to-row${item.needsYou ? " needs" : ""}`} data-output="page" data-page={item.artifact.name} data-needs={item.needsYou || undefined} onClick={onOpen}>
    <span className="to-icon"><PanelsTopLeft size={15} /></span>
    <span className="to-copy"><strong>{item.artifact.title}<em> · rev {rev}</em></strong><small>{item.says.join(" · ")}</small></span>
    <span className={`to-act${item.needsYou ? "" : " quiet"}`}>{item.needsYou ? "Review" : "Open"}<ChevronRight size={13} /></span>
  </button>;
}

type ReportRead = { status: "idle" | "loading" | "ready" | "gone" | "error"; report?: TaskReport; error?: string };

/** A report without a page, read in place: the app has no other reader for one, so it is read here, not asked for. */
function ReportLine({ task, item, open: startOpen, read, onAsk }: { task: string; item: ReportOutput; open?: boolean; read: ReadReport; onAsk: () => void }) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const [state, setState] = useState<ReportRead>({ status: "idle" });
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => { if (startOpen) setOpen(true); }, [startOpen]);
  // Read once, the first time it is opened; closing and opening again shows what was read.
  const asked = useRef(false);
  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    setState({ status: "loading" });
    read(task).then(
      (report) => setState(report ? { status: "ready", report } : { status: "gone" }),
      (error) => setState({ status: "error", error: String(error).replace(/^Error: /, "") }),
    );
  }, [open, task, read]);
  // Opened from its row's chip, the report is what the captain came for, so it is brought into view.
  useEffect(() => { if (startOpen) line.current?.scrollIntoView({ block: "start" }); }, [startOpen]);
  const says = [item.needsYou ? (item.calls.length ? `argues ${item.calls.length === 1 ? "a call" : `${item.calls.length} calls`} waiting on you` : "Finished, waiting to be read") : "Written up without a page"];
  return <div className={`to-report${item.needsYou ? " needs" : ""}${open ? " open" : ""}`} ref={line} data-output="report" data-needs={item.needsYou || undefined} data-state={open ? state.status : "closed"}>
    <button type="button" className="to-row" aria-expanded={open} onClick={() => setOpen((current) => !current)} title={item.path}>
      <span className="to-icon"><FileText size={15} /></span>
      <span className="to-copy"><strong>Report</strong><small>{says.join(" · ")}</small></span>
      <span className={`to-act${item.needsYou ? "" : " quiet"}`}>{open ? "Close" : "Read"}<ChevronRight size={13} className={open ? "rotated" : ""} /></span>
    </button>
    {open && <div className="to-report-body">
      {state.status === "loading" && <p className="to-quiet">Reading the report…</p>}
      {state.status === "ready" && state.report && <>
        <ReportText text={state.report.text} />
        {state.report.truncated && <p className="to-quiet" data-testid="report-cut">This is the first megabyte of {Math.round(state.report.bytes / 1024)} KB; the rest is in {state.report.path}.</p>}
      </>}
      {state.status === "gone" && <p className="to-quiet">The report isn't in the task's folder any more.</p>}
      {state.status === "error" && <div className="to-problem" role="alert"><TriangleAlert size={14} /><span>{state.error}</span><button type="button" className="landed-link" onClick={onAsk}>Ask the first mate for it</button></div>}
    </div>}
  </div>;
}

/**
 * A worker's markdown. Links open outside the app, and a picture is shown only by what it says it is: a report is the
 * worker's own words, and nothing in it loads from anywhere.
 */
function ReportText({ text }: { text: string }) {
  return <div className="markdown to-report-text" data-testid="report-text"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ href, children }) => <a href={href} title={href} target="_blank" rel="noreferrer noopener" onClick={(event) => { event.preventDefault(); if (href) openOutside(href); }}>{children}</a>,
      img: ({ alt, src }) => <span className="to-picture" title={typeof src === "string" ? src : undefined}>[{alt || "picture"}]</span>,
    }}
  >{text}</ReactMarkdown></div>;
}

/**
 * What the captain gave the task: what was asked, and his notes and files, folded under what it produced. The brief
 * the worker got is not among them: it is written for the worker, and what was asked plus the notes carries it.
 */
export function GaveSection({ asked, notes, files, children }: { asked: boolean; notes: number; files: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const parts = [asked ? "What was asked" : null, notes ? `${notes} ${notes === 1 ? "note" : "notes"}` : null, files ? `${files} ${files === 1 ? "file" : "files"}` : null].filter(Boolean);
  return <section className="drawer-section" data-testid="task-gave">
    <button type="button" className="fold-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <ChevronRight size={14} className={open ? "rotated" : ""} /><h3>What you gave it</h3><small>{parts.join(", ") || "Nothing beyond its title"}</small>
    </button>
    {open && <div className="to-gave">{children}</div>}
  </section>;
}

/** Where a task stands, in the word and tone its own drawer leads with. */
export type TaskStanding = { label: string; tone: string };

/**
 * Above a page a task presented: the task, where it stands and its priority, which opens its drawer, and the task's
 * other pages as tabs. A page shared in chat belongs to no task and has no strip.
 *
 * A task the home no longer carries (no row, no worker) is named but opens nothing, since there is no drawer to open.
 */
export function PageTaskStrip({ task, title, project, standing, record, pages, current, needs, onOpenTask, onOpenPage }: {
  task: string; title: string; project: string | null; standing: TaskStanding | null; record?: BacklogRecord; pages: Artifact[]; current: Artifact;
  needs: (page: Artifact) => boolean; onOpenTask: (() => void) | null; onOpenPage: (page: Artifact) => void;
}) {
  const meta = [project, standing?.label].filter(Boolean);
  const name = <>
    <ChevronLeft size={15} className="pts-back" aria-hidden="true" />
    <span className="pts-copy"><strong>{title}</strong><small>{meta.map((part, index) => <span key={index} className={index === 1 && standing ? `tone-${standing.tone}` : undefined}>{part}</span>)}{record && <PriorityBadge record={record} dim={record.state === "done"} />}</small></span>
  </>;
  return <nav className="page-task-strip" aria-label="The task this page is from" data-testid="page-task-strip" data-task={task}>
    {onOpenTask
      ? <button type="button" className="pts-task" onClick={onOpenTask} title="Open the task">{name}</button>
      : <span className="pts-task static" title="The home no longer carries this task">{name}</span>}
    {pages.length > 1 && <div className="pts-tabs" role="tablist" aria-label="This task's pages">
      {pages.map((page) => <button key={page.name} type="button" role="tab" aria-selected={page.name === current.name} className={page.name === current.name ? "on" : ""} data-page={page.name} onClick={() => { if (page.name !== current.name) onOpenPage(page); }}>
        {needs(page) && <span className="pts-dot" aria-label="Waits on you" />}{page.title}
      </button>)}
    </div>}
  </nav>;
}
