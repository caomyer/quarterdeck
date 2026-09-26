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
import type { Artifact, BacklogRecord, BearingsSnapshot, Call, CallAnswer, CallReply, FleetSnapshot, IntakeResult } from "./host/types";

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
  if (fleet?.calls) {
    const from = fleet.captain_day ? dayAfter(fleet.captain_day) : null;
    return { calls: from ? fleet.calls.map((call) => ({ ...call, ask_again_from: from })) : fleet.calls, legacy: false };
  }
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

/**
 * The calendar day after a `yyyy-mm-dd` day, or null for anything else. A call deferred to a day comes back at the
 * start of it, so the captain's own today is already too late to defer to; the earliest day is the one after.
 */
export function dayAfter(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const next = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(next.getTime())) return null;
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
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

/**
 * How long a call stays where it was raised in the chat: the day the chat keeps presented pages for. Older calls
 * are in Bearings, and the chat never moves one down to where the conversation is now.
 */
export const CHAT_CALL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The calls the chat shows where they were raised, oldest first, each with the time it goes in at: raised in the
 * window, with a time to place it by. A call the first mate decided for the captain was never his to answer, so it
 * is said in chat by the first mate, not drawn as a call.
 */
export function callsInChat(calls: Call[], now: number, windowMs = CHAT_CALL_WINDOW_MS) {
  return calls
    .map((call) => ({ call, at: Date.parse(call.raised_at ?? "") }))
    .filter(({ call, at }) => call.decided === null && Number.isFinite(at) && at >= now - windowMs)
    .sort((a, b) => a.at - b.at);
}

/**
 * What the intake did with an answer this session gave a call, as far as a call's standing needs it. `raised` is the
 * call's `raised_at` when it was answered: a hold that starts a new lifecycle asks anew, and the note is not its answer.
 */
export type IntakeNote = { label: string; result: IntakeResult; detail: string; raised?: string | null };

/**
 * Where a call stands for the captain, worked out once for every surface that answers one, so Bearings and the chat
 * can never disagree about the same call. Read from the call record, and from what this session knows first: the
 * intake's word on an answer given here, and the page whose review recorded one.
 *
 * - `recorded`: an answer is on the record, given here or anywhere else; `label` is the choice.
 * - `in-review`: answered in the review of `page`; the record catches up once firstmate closes it.
 * - `held`: open, but not now: firstmate asks again on a later day.
 * - `closed`: over without an answer of the captain's, such as a call the first mate withdrew.
 * - `open`: waiting on the captain; `failed` is an answer the intake did not record, which he can give again.
 */
export type CallStanding =
  | { kind: "open"; failed: IntakeNote | null }
  | { kind: "recorded"; label: string; via: string | null }
  | { kind: "in-review"; page: string }
  | { kind: "held" }
  | { kind: "closed" };

export function callStanding(call: Call, known: { answered?: IntakeNote; answeredIn?: string } = {}): CallStanding {
  const { answeredIn } = known;
  const answered = known.answered && (known.answered.raised === undefined || known.answered.raised === (call.raised_at ?? null)) ? known.answered : undefined;
  if (answered?.result === "closed") return { kind: "recorded", label: answered.label, via: "quarterdeck" };
  if (call.state !== "open") {
    if (call.answer?.by === "captain") return { kind: "recorded", label: call.answer.label, via: call.answer.via };
    return { kind: "closed" };
  }
  if (answeredIn) return { kind: "in-review", page: answeredIn };
  if (call.captain_actionable === false) return { kind: "held" };
  return { kind: "open", failed: answered ?? null };
}

/**
 * Whether an option the captain picked is still one the call offers, as he saw it: the same key with the same label.
 * The intake refuses a key that is gone, but a key kept under a new label would record words he never chose.
 */
export function stillOffered(call: Call, pick: { key: string; label: string }) {
  return call.options.some((option) => option.key === pick.key && option.label === pick.label);
}

/**
 * A captain's message the app wrote to answer a call, read back from its words, which is all a resumed conversation
 * keeps. The app owns both ends of these lines (`answer_message` and `reply_message` in `src-tauri/src/review.rs`),
 * so this reads the app's own format, never the first mate's prose, and anything else is not an answer.
 *
 * - `recorded`: an option recorded through the intake from Bearings or the chat, with anything the captain added.
 * - `replied`: the captain's words kept on the call for the first mate to record.
 */
export type MessageAnswer =
  | { kind: "recorded"; call: string; key: string; label: string; note: string | null }
  | { kind: "replied"; call: string; words: string };

const ANSWERED_HEADER = "The captain answered a call from Bearings.";
const RECORDED_LINE = /^Recorded: (\S+) = (\S+)(?: \("(.*)"\))?$/;
const REPLIED_HEADER = /^The captain replied to call (\S+) from Bearings, in words;/;

export function answerOfMessage(text: string, calls: Call[] = []): MessageAnswer | null {
  const lines = text.split("\n");
  if (lines[0] === ANSWERED_HEADER) {
    const recorded = lines.map((line) => line.match(RECORDED_LINE)).find(Boolean);
    if (!recorded) return null;
    const added = lines.find((line) => line.trimStart().startsWith("The captain added: "));
    return { kind: "recorded", call: recorded[1], key: recorded[2], label: recorded[3] ?? recorded[2], note: added ? added.trimStart().slice("The captain added: ".length) : null };
  }
  const replied = lines[0].match(REPLIED_HEADER);
  if (replied) {
    const said = lines.findIndex((line) => line.startsWith("The captain said: "));
    const words = said < 0 ? "" : [lines[said].slice("The captain said: ".length), ...lines.slice(said + 1)].join("\n").trim();
    return { kind: "replied", call: replied[1], words };
  }
  // Before replies were kept on the call, the app sent words as `On the <call id, spaced>: ...`.
  const earlier = text.match(/^on the ([^:\n]+):\s*/i);
  const call = earlier && calls.find((candidate) => candidate.id.replaceAll("-", " ").toLowerCase() === earlier[1].trim().toLowerCase());
  return call ? { kind: "replied", call: call.id, words: text.slice(earlier[0].length).trim() } : null;
}
