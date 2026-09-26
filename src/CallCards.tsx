/**
 * A call's two cards in the chat: the call card, where the first mate raised it, and the answer card, where the
 * captain answered it. What each says is worked out in src/callcards.ts; these only draw it.
 *
 * The call card takes its answer form as parts the answering surface hands in (`form`), so it answers through the one
 * form and the one path Bearings uses, and never through a copy of its own.
 */
import { Check, CircleAlert, CircleCheck, CirclePause, CircleSlash, Ellipsis, Info } from "lucide-react";
import { useState } from "react";

import { type AnswerCardView, type CallCardView, type CallLine } from "./callcards";
import type { Call } from "./host/types";

/** The answer form a call card shows, handed in by the surface that answers the call. */
export type CallForm = {
  /** The ways to answer: the shared `CallAnswerFields`. */
  fields: React.ReactNode;
  /** Record answer or Send, whichever the form's state calls for. */
  button: React.ReactNode;
  /** What pressing it does, in a line. */
  hint: string;
  /** What he has written that has not gone; empty when nothing has. */
  draft: string;
  /** Empties the form. */
  clear: () => void;
};

/** A call once it is not the captain's to answer: one line, with the question and every option a click away. */
export function CallLineCard({ call, heading, line, form, onOpenPage, onDraft }: {
  call: Call;
  heading: string;
  line: CallLine;
  form: Pick<CallForm, "draft" | "clear">;
  onOpenPage?: () => void;
  onDraft: (text: string) => void;
}) {
  const icon = line.kind === "held" ? <CirclePause size={15} className="tone-amber" /> : line.kind === "closed" ? <CircleSlash size={15} className="tone-muted" /> : <CircleCheck size={15} className="tone-green" />;
  return <article className={`call-chat-card done standing-${line.kind}`} data-testid="call-card" data-call-id={call.id} data-standing={line.kind}>
    <div className="call-chat-line">
      {icon}
      <span className="grow"><strong>{heading}</strong> · {line.detail}{line.page && <> <strong>{line.page}</strong></>}</span>
      {line.pill && <span className={`call-pill tone-${line.tone}`}>{line.pill}</span>}
      {line.kind === "in-review" && onOpenPage && <button onClick={onOpenPage}>Open the page</button>}
    </div>
    {call.options.length > 0 && <details className="call-chat-options">
      <summary>The question and all {call.options.length === 1 ? "1 option" : `${call.options.length} options`}</summary>
      {call.question && <p>{call.question}</p>}
      <ul>{call.options.map((option) => <li key={option.key} className={option.key === line.pick ? "picked" : ""}>{option.key === line.pick && <Check size={13} />}{option.label}</li>)}</ul>
    </details>}
    {/* Answered somewhere else while he was writing here: what he wrote is kept, and never sent from here. */}
    {form.draft && <div className="call-chat-note" data-testid="call-unsent"><Info size={15} /><span><strong>What you were writing here was not sent</strong>“{form.draft}”</span><button onClick={() => { onDraft(form.draft); form.clear(); }}>Put it in the composer</button></div>}
  </article>;
}

/**
 * A call waiting on the captain, where the first mate raised it: the whole call and every way to answer it. A reply of
 * his that nothing has recorded folds the form under Answer differently. `notices` are the surface's own states
 * (not recorded, the reply itself, a reply refused), drawn the way Bearings draws them.
 */
export function CallOpenCard({ call, heading, view, form, argued, unread, summary, notices, onReadArgument }: {
  call: Call;
  heading: string;
  view: CallCardView;
  form: CallForm;
  argued: string | null;
  unread: boolean;
  /** The options at a glance, for when the form is folded. */
  summary: string;
  notices: React.ReactNode;
  onReadArgument?: () => void;
}) {
  const [answering, setAnswering] = useState(false);
  const folded = view.replied && !answering;
  return <article className={`call-chat-card${view.replied ? " replied" : ""}`} data-testid="call-card" data-call-id={call.id} data-standing={view.replied ? "replied" : "open"}>
    <div className="call-chat-kicker">Captain's call{view.kicker.length > 0 && <span>{view.kicker.join(" · ")}</span>}</div>
    <h4>{heading}</h4>
    {call.question && call.question !== heading && <p className="call-chat-question">{call.question}</p>}
    {argued && <p className="call-argued" data-testid="argued-by">Argued by <strong>{argued}</strong></p>}
    {argued && unread && !folded && <p className="call-unread" data-testid="unread-argument">You haven't opened “{argued}” yet.</p>}
    {(view.optionsChanged || view.withdrawn) && <div className="call-chat-note warn" data-testid="options-changed"><CircleAlert size={15} /><span>
      {view.optionsChanged && <><strong>The options changed at {view.optionsChanged}, after the first mate wrote about this above.</strong>These are the current ones. </>}
      {view.withdrawn && <>“{view.withdrawn}”, which you had picked, is no longer offered. Pick again.</>}
    </span></div>}
    {view.earlier && <div className="call-chat-note" data-testid="said-before"><Info size={15} /><span>{view.earlier}</span></div>}
    {notices}
    {!folded && form.fields}
    <div className="call-chat-actions">
      <span data-testid="call-hint">{folded ? summary : form.hint}</span>
      <div>
        {argued && onReadArgument && <button className="quiet" onClick={onReadArgument}>Read the argument</button>}
        {folded ? <button onClick={() => setAnswering(true)}>Answer differently</button> : form.button}
      </div>
    </div>
  </article>;
}

/**
 * One of the captain's answers to a call, drawn where he gave it instead of the text written for the first mate. The
 * text the first mate got stays one click away.
 */
export function AnswerCard({ callId, view, time, sent }: {
  callId: string;
  view: AnswerCardView;
  /** When he said it, for a live message the chat shows no delivery for. */
  time: string | null;
  /** The text the first mate was sent. */
  sent: string;
}) {
  if (view.line) {
    // Gone from the snapshot, so all that is known is the app's own line, which is enough for one.
    return <article className="answer-chat-card line" data-testid="answer-card" data-kind="recorded" data-call-id={callId}>
      <CircleCheck size={15} className="tone-green" /><span className="grow">Your call · <strong>{view.title}</strong> · {view.said}</span><span className="call-pill">closed</span>
    </article>;
  }
  const recorded = view.kind === "recorded";
  return <article className={`answer-chat-card tone-${view.tone}`} data-testid="answer-card" data-kind={view.kind} data-call-id={callId} data-tone={view.tone}>
    <span className="answer-chat-kicker">{view.kicker}</span>
    <strong className="answer-chat-title">{view.title}</strong>
    <div className="answer-chat-said">{recorded ? <Check size={14} /> : <Ellipsis size={14} />}<span>{view.said}</span></div>
    {view.note && <p className="answer-chat-added">{view.note}</p>}
    <footer className="message-state">
      <time className={`tone-${view.tone}`} data-testid="answer-status">{view.status}</time>
      {time && <time>{time}</time>}
      {view.askedAgain && <span className="answer-chat-again" data-testid="asked-again">Asked again ↓</span>}
    </footer>
    <details className="review-card-text"><summary>What the first mate was sent</summary><pre>{sent}</pre></details>
  </article>;
}
