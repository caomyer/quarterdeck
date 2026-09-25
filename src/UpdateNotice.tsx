import { ArrowUpCircle, ChevronRight, CircleAlert, CircleCheck, CircleOff, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { AppUpdate, HostRuntimeState } from "./host/types";
import { checkView, updateView, type UpdateView } from "./update";
import { useNow } from "./use-now";
import { ago } from "./usage";

export type UpdateNoticeProps = {
  update: AppUpdate | null;
  problem: string | null;
  runtime: HostRuntimeState;
  onRestart: () => void;
  onCancel: () => void;
  onSeen: () => void;
  onCheck: () => void;
};

/** A release's notes are one line per change; anything else is shown as it came. */
function noteLines(notes: string) {
  return notes.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
}

/**
 * The app's own update, in the sidebar above the first mate's footer, on every page. Without one, a quiet line: when
 * the app last looked, and a button to look now. With one: what it is, what restarting does to the first mate, and the
 * one button that acts. After a restart, once, what the new version brought.
 */
export function UpdateNotice(props: UpdateNoticeProps) {
  const now = useNow();
  const view = updateView(props.update, props.runtime);
  const looking = checkView(props.update, (at) => ago(at, now));
  if (!view && !looking) return null;
  return <section className={`update-notice ${view?.kind ?? `check-${looking?.kind}`}`} role={view?.kind === "failed" ? "alert" : "status"} aria-label="App update">
    {view && <Notice view={view} {...props} />}
    {looking && <div className={`update-head update-check ${looking.kind}`}>
      <span className="update-icon" aria-hidden="true">{looking.kind === "failed" ? <CircleAlert size={15} /> : looking.kind === "checking" ? <RefreshCw size={15} className="update-spin" /> : looking.kind === "off" ? <CircleOff size={15} /> : <CircleCheck size={15} />}</span>
      <span className="update-words"><strong>{looking.title}</strong><small>{looking.detail}</small></span>
      {looking.action && <button className="update-action" onClick={props.onCheck}>{looking.action}</button>}
    </div>}
    {props.problem && <p className="update-problem">{props.problem}</p>}
  </section>;
}

function Notice({ view, ...props }: UpdateNoticeProps & { view: UpdateView }) {
  const [notesOpen, setNotesOpen] = useState(false);
  const icon = view.kind === "failed" ? <CircleAlert size={15} /> : view.kind === "installed" ? <CircleCheck size={15} /> : view.kind === "ready" ? <ArrowUpCircle size={15} /> : <RefreshCw size={15} className="update-spin" />;
  const act = view.kind === "waiting" ? props.onCancel : view.kind === "installed" ? props.onSeen : props.onRestart;
  const lines = view.notes ? noteLines(view.notes) : [];
  return <>
    <div className="update-head">
      <span className="update-icon" aria-hidden="true">{icon}</span>
      <span className="update-words"><strong>{view.title}</strong><small>{view.detail}</small></span>
      {view.action && <button className={`update-action ${view.kind === "ready" || view.kind === "failed" ? "primary" : ""}`} onClick={act}>{view.action}</button>}
    </div>
    {lines.length > 0 && <>
      <button className="update-notes-toggle" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)}><ChevronRight size={12} />What's new</button>
      {notesOpen && <ul className="update-notes">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    </>}
  </>;
}
