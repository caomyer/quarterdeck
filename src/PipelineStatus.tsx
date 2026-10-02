// A task's pipeline status: the block at the top of its drawer, and the strip beside its row in the task list.
//
// Both draw only what src/pipeline.ts reads from the snapshot. The block has no control of its own: answering a gate,
// restarting a run and merging stay where they are, and its one link opens a call that already exists.
import { ExternalLink } from "lucide-react";
import { useNow } from "./use-now";
import type { Call, FleetTask } from "./host/types";
import {
  type CellState, chipOf, findingPlace, gateLine, hasRail, headline, howItShips, prLine, railNote, railOf, readAge, sourceLine,
  waitingOf, type Waiting,
} from "./pipeline";

const GLYPH: Partial<Record<CellState, string>> = { completed: "✓", skipped: "–", parked: "❚❚", held: "✓", failed: "✕", cancelled: "✕", unknown: "?" };

/** How fresh the read is: when the fleet was last read, and why the newest refresh failed, if it did. */
export type PipelineRead = { at: number | null; error: string | null };

/** The block that heads a task's drawer: who it waits on, then where its pipeline is, then where that was read. */
export function PipelineBlock({ task, waiting, call, read, onOpenCall }: { task: FleetTask; waiting: Waiting; call?: Call; read: PipelineRead; onOpenCall: (id: string) => void }) {
  const now = useNow(5_000);
  const pipeline = task.pipeline ?? null;
  const ships = howItShips(task);
  const rail = hasRail(pipeline) ? railOf(pipeline) : null;
  const note = hasRail(pipeline) ? railNote(pipeline) : null;
  const gate = pipeline ? gateLine(pipeline) : null;
  const pr = prLine(task);
  const decision = (task.hints.open_decisions as { key?: string; verb?: string }[]).find((item) => item?.key);
  const openCall = call && call.state === "open" ? call : undefined;
  const age = read.at !== null ? readAge(now - read.at) : null;
  const posture = waiting.rule === 2 ? (task.yolo === "on" ? "merge posture: first mate (yolo on)" : "merge posture: yours") : null;
  const callLink = openCall && <button type="button" className="ps-call" data-testid="pipeline-call" onClick={() => onOpenCall(openCall.id)}><span>Your call: {openCall.question ?? openCall.title}</span><b>Answer</b></button>;
  return <section className="ps-block" data-testid="pipeline-status" data-who={waiting.who} data-rule={waiting.rule}>
    <div className={`ps-head tone-${waiting.tone}`}>
      <span className="ps-k">Waiting on</span>
      <strong data-testid="pipeline-who">{waiting.label}</strong>
      <p>{headline(task, waiting, openCall?.question ?? openCall?.title)}</p>
    </div>
    {ships && <p className="ps-ships" data-testid="pipeline-ships"><span className="mode-chip">{ships.mode}</span> {ships.text}</p>}
    {rail && <ol className="ps-rail" data-testid="pipeline-rail" aria-label="Pipeline steps">
      {rail.map((cell) => <li key={cell.step} className={cell.state} title={`${cell.step}: ${cell.state}`}><i>{GLYPH[cell.state] ?? ""}</i><span>{cell.step}</span></li>)}
    </ol>}
    {note && <p className="ps-note" data-testid="pipeline-note">{note.text}{note.quiet && <> · <b className="ps-warn">{note.quiet}</b> (the pipeline's own word)</>}</p>}
    {read.error && <p className="ps-note ps-warn">This is the last read. The newest refresh failed.</p>}
    {gate && pipeline && <div className="ps-gate" data-testid="pipeline-gate">
      <p className="ps-gate-h">{gate}</p>
      {pipeline.findings && pipeline.findings.rows.length > 0 && <ul className="ps-findings">{pipeline.findings.rows.map((finding) => <li key={finding.id} className={finding.action === "ask-user" ? "ask" : undefined}>
        <span className="ps-fh">{finding.id} {finding.severity} <span className={`ps-act${finding.action === "ask-user" ? " ask-user" : ""}`}>{finding.action}</span></span>
        <span className="ps-fd">{finding.description}</span>
        {findingPlace(finding) && <span className="ps-ff">{findingPlace(finding)}</span>}
      </li>)}</ul>}
      {waiting.rule === 3 && decision?.key && <p className="ps-esc">Escalated as <code>{decision.key}</code>. Not yet a call to you.</p>}
      {waiting.rule === 4 && <p className="ps-esc">Not escalated yet.</p>}
      {callLink}
    </div>}
    {!gate && callLink}
    {pr && <p className="ps-pr" data-testid="pipeline-pr"><span className={`ps-pr-name ${pr.state.split(",")[0].replaceAll(" ", "-")}`}>{pr.name}</span> {pr.state} · {pr.detail}{pr.url && <> · <a href={pr.url} target="_blank" rel="noreferrer">Open PR <ExternalLink size={11} /></a></>}</p>}
    <footer className={read.error ? "stale" : undefined} data-testid="pipeline-source">
      {read.error
        ? <>last good read {age ?? "time unknown"} ago · refresh failed: {read.error}</>
        : <>{sourceLine(task, waiting)}{openCall?.raised_at && ` · call raised ${clock(openCall.raised_at)}`}{posture && ` · ${posture}`}{age && ` · read ${age} ago`}</>}
    </footer>
  </section>;
}

function clock(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The nine-cell strip beside a task list row, or the words for a task that never runs a pipeline. */
export function PipelineStrip({ task }: { task: FleetTask }) {
  const pipeline = task.pipeline ?? null;
  if (!hasRail(pipeline)) return <span className="ps-strip-none" data-testid="pipeline-strip">no pipeline</span>;
  return <span className="ps-strip" data-testid="pipeline-strip" aria-hidden="true">{railOf(pipeline).map((cell) => <b key={cell.step} className={cell.state} />)}</span>;
}

/**
 * A task list row's chip and strip, or null from a firstmate that predates the fold, which keeps its old chip. The
 * chip names the holder in its tone and why in plain ink; `label` is the same words for the row's accessible name.
 */
export function pipelineChip(task: FleetTask) {
  const waiting = waitingOf(task);
  const chip = chipOf(task);
  if (!waiting || !chip) return null;
  return {
    label: chip.label, tone: chip.tone,
    standing: <span className="ps-standing" data-testid="pipeline-standing" data-who={waiting.who}>
      <span className={`ps-who tone-${waiting.tone}`} title={chip.title}><em>{waiting.label}</em> · {waiting.why}</span>
      <PipelineStrip task={task} />
    </span>,
  };
}

export { waitingOf };
