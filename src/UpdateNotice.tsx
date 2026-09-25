import { ArrowUpCircle, ChevronRight, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { AppUpdate, HostRuntimeState } from "./host/types";
import { updateView } from "./update";

export type UpdateNoticeProps = {
  update: AppUpdate | null;
  problem: string | null;
  runtime: HostRuntimeState;
  onRestart: () => void;
  onCancel: () => void;
  onSeen: () => void;
};

/** A release's notes are one line per change; anything else is shown as it came. */
function noteLines(notes: string) {
  return notes.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
}

/**
 * The app's own update, in the sidebar above the first mate's footer, on every page. Quiet until there is one: then
 * what it is, what restarting does to the first mate, and the one button that acts. After a restart, once, what the
 * new version brought.
 */
export function UpdateNotice(props: UpdateNoticeProps) {
  const [notesOpen, setNotesOpen] = useState(false);
  const view = updateView(props.update, props.runtime);
  if (!view) return null;
  const icon = view.kind === "failed" ? <CircleAlert size={15} /> : view.kind === "installed" ? <CircleCheck size={15} /> : view.kind === "ready" ? <ArrowUpCircle size={15} /> : <RefreshCw size={15} className="update-spin" />;
  const act = view.kind === "waiting" ? props.onCancel : view.kind === "installed" ? props.onSeen : props.onRestart;
  const lines = view.notes ? noteLines(view.notes) : [];
  return <section className={`update-notice ${view.kind}`} role={view.kind === "failed" ? "alert" : "status"} aria-label="App update">
    <div className="update-head">
      <span className="update-icon" aria-hidden="true">{icon}</span>
      <span className="update-words"><strong>{view.title}</strong><small>{view.detail}</small></span>
      {view.action && <button className={`update-action ${view.kind === "ready" || view.kind === "failed" ? "primary" : ""}`} onClick={act}>{view.action}</button>}
    </div>
    {lines.length > 0 && <>
      <button className="update-notes-toggle" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)}><ChevronRight size={12} />What's new</button>
      {notesOpen && <ul className="update-notes">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    </>}
    {props.problem && <p className="update-problem">{props.problem}</p>}
  </section>;
}
