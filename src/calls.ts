/**
 * Captain calls, as every screen reads them.
 *
 * firstmate keeps one record per call and the snapshot carries every one in `calls[]`: its question and options,
 * the evidence that argues it, and how it was answered. Each screen is a projection of those records and the
 * presented pages, and every projection lives here, so no screen keeps a second idea of what a call is.
 *
 * A home whose firstmate predates `calls[]` still shows its open calls, from Bearings' own list, with no options and
 * no evidence: those are answered through the first mate. Nothing else falls back.
 *
 * Pure functions only: no React, no host.
 */
import type { Artifact, BacklogRecord, BearingsSnapshot, Call, CallAnswer, CallReply, FleetSnapshot } from "./host/types";

/** Which page an evidence ref names: `page:task/<id>/<name>` or `page:chat/<name>`. */
export function pageRef(page: { scope: "task" | "chat"; task: string | null; name: string }) {
  return page.scope === "task" && page.task ? `page:task/${page.task}/${page.name}` : `page:chat/${page.name}`;
}

/** The calls whose evidence contains this page, in the order the snapshot lists them. */
export function callsArguedBy(calls: Call[], page: { scope: "task" | "chat"; task: string | null; name: string }) {
  const ref = pageRef(page);
  return calls.filter((call) => call.evidence.includes(ref));
}

/** Waiting on the captain now: held, not answered, and in the live part of the hold. */
export function isOpen(call: Call) {
  return call.state === "open" && call.captain_actionable !== false;
}

export function openCalls(calls: Call[]) {
  return calls.filter(isOpen);
}

/**
 * The captain's reply on a call while it is open: words he said on it that nothing has recorded yet. It is shown
 * amber everywhere until the first mate records an answer or asks again, both of which clear it in firstmate.
 */
export function replyOf(call: Call): CallReply | null {
  return call.state === "open" ? call.reply ?? null : null;
}

/** Waiting on the captain's word: open, and not replied to. Once he has replied, the next move is the first mate's. */
export function awaitsCaptain(call: Call) {
  return isOpen(call) && replyOf(call) === null;
}

/** One piece of what argues a call, resolved to something the captain can open. */
export type Evidence =
  | { ref: string; kind: "page"; title: string; artifact: Artifact }
  | { ref: string; kind: "report"; title: string; task: string }
  | { ref: string; kind: "url"; title: string; url: string };

/**
 * What argues a call, in the order firstmate gives it: its explicit evidence first, then what its origin produced.
 * A page that is not among the presented pages cannot be opened, so it is left out rather than shown dead.
 */
export function resolveEvidence(call: Call, artifacts: Artifact[], taskTitle: (id: string) => string): Evidence[] {
  const out: Evidence[] = [];
  for (const ref of new Set(call.evidence)) {
    const page = ref.match(/^page:(?:task\/([^/]+)\/([^/]+)|chat\/([^/]+))$/);
    if (page) {
      const artifact = artifacts.find((item) => page[3] ? item.scope === "chat" && item.name === page[3] : item.scope === "task" && item.task === page[1] && item.name === page[2]);
      if (artifact) out.push({ ref, kind: "page", title: artifact.title, artifact });
      continue;
    }
    const report = ref.match(/^report:(.+)$/);
    if (report) {
      out.push({ ref, kind: "report", title: `the report on “${taskTitle(report[1])}”`, task: report[1] });
      continue;
    }
    const url = ref.match(/^url:(https?:\/\/\S+)$/);
    if (url) out.push({ ref, kind: "url", title: linkLabel(url[1]), url: url[1] });
  }
  return out;
}

/** The one piece to read first: the first page, since that is written to be read; otherwise whatever comes first. */
export function argumentOf(evidence: Evidence[]) {
  return evidence.find((item) => item.kind === "page") ?? evidence[0];
}

/** Calls the first mate settled for the captain, newest first. */
export function decidedForCaptain(calls: Call[]) {
  return calls
    .filter((call) => call.answer?.by === "firstmate" && call.state !== "open")
    .sort((a, b) => (b.answer?.at ?? "").localeCompare(a.answer?.at ?? ""));
}

/** How long an answered call counts as recent: the week the snapshot keeps closed calls for. */
export const ANSWERED_WINDOW_DAYS = 7;

/** Calls the captain answered that have left the waiting list, answered in the last week. */
export function answeredByCaptain(calls: Call[], now: number, windowDays = ANSWERED_WINDOW_DAYS) {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  return calls.filter((call) => call.answer?.by === "captain" && call.state !== "open" && Date.parse(call.answer.at) >= cutoff);
}

const CHANNELS: Record<string, string> = { quarterdeck: "here", chat: "in chat", lavish: "in Lavish" };

/** Who answered, and where, in the captain's words. */
export function answeredBy(answer: CallAnswer) {
  if (answer.by === "firstmate") return "Answered by the first mate";
  const where = CHANNELS[answer.via] ?? `through ${answer.via}`;
  return `Answered by you ${where}`;
}

/** Whether the call's question or options changed after this revision of a page arguing it was presented. */
export function optionsUpdatedSince(call: Call, presentedAt: string) {
  if (!call.updated_at) return false;
  const updated = Date.parse(call.updated_at);
  const presented = Date.parse(presentedAt);
  // A call raised after the page, with its options set as it was raised, changed nothing the page showed.
  const raised = Date.parse(call.raised_at ?? "");
  if (Number.isFinite(raised) && Number.isFinite(updated) && updated <= raised) return false;
  return Number.isFinite(updated) && Number.isFinite(presented) && updated > presented;
}

/** The recommended option, if the call names one. */
export function recommended(call: Call) {
  return call.options.find((option) => option.recommended);
}

/**
 * The calls a home carries: its `calls[]`, or, from a firstmate that predates it, the open calls Bearings lists,
 * with no options and no evidence, answered through the first mate.
 */
export function homeCalls(fleet: FleetSnapshot | null | undefined, bearings: BearingsSnapshot | null | undefined, records: Map<string, BacklogRecord>): { calls: Call[]; legacy: boolean } {
  if (fleet?.calls) return { calls: fleet.calls, legacy: false };
  const calls = (bearings?.decisions_open ?? []).map((decision): Call => ({
    id: decision.id,
    title: records.get(decision.id)?.title ?? decision.key,
    question: records.get(decision.id)?.hold_reason ?? null,
    options: [],
    on_answer: null,
    state: "open",
    captain_actionable: true,
    evidence: [],
    answer: null,
    decided: null,
  }));
  return { calls, legacy: true };
}

/** A link's name: a pull request by its number, anything else by its site. */
export function linkLabel(href: string) {
  const pr = href.match(/\/pull\/(\d+)/)?.[1];
  if (pr) return `PR #${pr}`;
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

/** A day to be asked again on, as the captain says it: Oct 3. It is the calendar day picked, wherever the Mac is. */
export function askAgainDay(date: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}

/** An answer in words, as every surface says it: not now until a day, what the captain wrote, or both. */
export function answerInWords(defer: string | null | undefined, note: string) {
  const words = note.trim();
  if (!defer) return words;
  const later = `Not now. Ask me again on ${askAgainDay(defer)}.`;
  return words ? `${later} ${words}` : later;
}
