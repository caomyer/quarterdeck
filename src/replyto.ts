/**
 * A reply to a place in the chat, and how a message carries it.
 *
 * The object of a reply is a place: a paragraph, a list item, a card, or words the captain selected. The thing it is
 * about follows from the place: the tasks, calls and pages it names, read from the fleet snapshot, never guessed.
 *
 * A message is words and nothing else: the outbox, a re-send and a resumed history all carry text, and the adapter
 * flattens any structured block to text before the model sees it. So the reply rides as a block the app writes before
 * the captain's words, the way the attached-files block (`src/attachments.ts`) rides after them. This module is the
 * one place that writes that block and the one place that reads it back. Every line in it states a fact the app
 * captured, never its reading of what the captain meant: a thing goes as `meant` only when the captain picked it or
 * pointed at a card, and everything else found goes as `named`. `engine/AGENTS.md` tells the first mate how to read
 * it, and `src/fixtures/reply-block.json` pins the two together.
 *
 * A reply points at its place by words, never by a message id, since ids do not survive a relaunch: the quote and the
 * text around it, latest match first, and nothing rather than a near miss. That is how a page review finds a place too.
 */
import type { Artifact, BacklogRecord, Call, FleetSnapshot } from "./host/types";

export const REPLY_HEADING = "↩ The captain is replying to a place in this chat. It comes first; the captain's words follow the rule.";
export const REPLY_RULE = "──";
/** Longer quotes are cut, and say so. */
export const QUOTE_LIMIT = 240;
/** How much of the text on each side of the place goes with it, as the page review sends. */
export const AROUND_LIMIT = 80;
const KEYS = ["on", "quote", "around", "meant", "named", "read at"] as const;
type Key = (typeof KEYS)[number];
const KEY_WIDTH = 10;
const HERE = "▸here◂";

export type ThingKind = "task" | "call" | "page";
/** Something the fleet snapshot knows, with its state as the snapshot reads now. A page's id is `task/<task>/<name>` or `chat/<name>`. */
export type Thing = { kind: ThingKind; id: string; title: string | null; state: string; pr: string | null };
/** A thing a place names: the words that named it, and whether they were in the quote or elsewhere in its message. */
export type Found = Thing & { token: string; where: "quote" | "block" | "message" };

/** Whose the place is: a message of the first mate's or the captain's, or a card, which is one thing. */
export type PlaceOwner =
  | { kind: "mate" }
  | { kind: "captain" }
  | { kind: "call"; id: string }
  | { kind: "page"; id: string; rev: number }
  | { kind: "answer"; call: string }
  | { kind: "review"; page: string };

export type UnitKind = "paragraph" | "heading" | "item" | "code block" | "block quote" | "table";

/** When a place was said: its time, or for a resumed conversation's message, which keeps none, when its history was read. */
export type Said = { at: string } | { before: string } | null;

/** A place the captain pointed at, captured at that moment. */
export type Place = {
  owner: PlaceOwner;
  said: Said;
  /** How many messages and cards the chat shows from the place on, the place included, so 1 is the latest. */
  back: number;
  /** Which block of its message the place is, for a message's first mate. */
  unit: { kind: UnitKind; index: number; of: number } | null;
  /** The words, as the chat drew them, whitespace collapsed. */
  quote: string;
  /** The captain selected these words, rather than a whole block. */
  selected: boolean;
  /** The message's drawn text before and after the place; null for a card. */
  around: { before: string; after: string } | null;
  /** For selected words, the whole block they are in, where things are looked for next when the words name none. */
  block?: string;
  /** The message's own words, where things are looked for when the place names none; empty for a card. */
  message: string;
};

/** What the composer holds: the place, and the thing the captain tapped, if any, as `kind:id`. */
export type ReplyDraft = { place: Place; picked: string | null };

/** The fleet as a reply reads it: the things it knows and when it was read, or why it could not be read. */
export type FleetRead = { read: { at: string; things: Thing[] } } | { failed: { at: number | null; why: string } };

/** A thing as a sent block names it: what can be read back from the words alone. */
export type SentThing = { kind: ThingKind; id: string; title: string | null; state: string; pr: string | null; why: string | null };

/** A reply read back from a sent message. */
export type SentReply = {
  owner: PlaceOwner;
  on: string;
  quote: string;
  /** The quote's whole length, when it was cut. */
  cutFrom: number | null;
  selected: boolean;
  /** Null on a side means the place is at that end of its message; the whole is null for a card. */
  around: { before: string | null; after: string | null } | null;
  meant: SentThing | null;
  named: SentThing[];
  /** Why the things could not be read, when they could not. */
  unread: string | null;
  readAt: string | null;
};

export function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function thingKey(thing: { kind: ThingKind; id: string }) {
  return `${thing.kind}:${thing.id}`;
}

function pad(key: Key) {
  return key.padEnd(KEY_WIDTH);
}

function two(value: number) {
  return String(value).padStart(2, "0");
}

/** A time as the block says it, on the captain's own clock: `22:04`, `22:04 yesterday`, or `22:04 on 2026-09-30`. */
export function clock(iso: string | number, now: number) {
  const date = new Date(iso);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const day = (value: Date) => `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}`;
  const today = new Date(now);
  if (day(date) === day(today)) return time;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day(date) === day(yesterday)) return `${time} yesterday`;
  return `${time} on ${day(date)}`;
}

/** The pull request number a URL names, or null. */
export function prNumber(url: string | null) {
  return url?.match(/\/pull\/(\d+)\/?$/)?.[1] ?? null;
}

function taskState(record: BacklogRecord) {
  if (record.state === "done") return record.completion?.verb || "done";
  if (record.state === "queued") return "queued";
  return "in flight";
}

function callState(call: Call) {
  if (call.state === "open") {
    const recommended = call.options.find((option) => option.recommended);
    return recommended ? `open · recommended ${recommended.key}` : "open";
  }
  const key = call.answer?.key;
  if (call.state === "answered") return key ? `answered = ${key}` : "answered";
  if (call.decided) return "decided by the first mate";
  if (call.answer?.by === "captain") return key ? `recorded = ${key}` : "recorded";
  return "closed";
}

export function pageId(page: { scope: string; task: string | null; name: string }) {
  return page.scope === "task" ? `task/${page.task}/${page.name}` : `chat/${page.name}`;
}

/** Everything the fleet snapshot knows that a place could name: its tasks, its calls, and its pages. */
export function knownThings(fleet: Pick<FleetSnapshot, "backlog" | "tasks" | "calls" | "artifacts">): Thing[] {
  const calls = fleet.calls ?? [];
  const callIds = new Set(calls.map((call) => call.id));
  const records = (fleet.backlog?.records ?? []).filter((record) => !callIds.has(record.id));
  const recorded = new Set(records.map((record) => record.id));
  const workers = new Map(fleet.tasks.map((task) => [task.id, task]));
  return [
    ...records.map((record): Thing => ({ kind: "task", id: record.id, title: record.title || null, state: taskState(record), pr: record.pr_url || workers.get(record.id)?.pr.url || null })),
    // A worker the backlog has no row for still names a task.
    ...fleet.tasks.filter((task) => !recorded.has(task.id) && !callIds.has(task.id)).map((task): Thing => ({ kind: "task", id: task.id, title: null, state: task.current_state.state.replaceAll("_", " "), pr: task.pr.url })),
    ...calls.map((call): Thing => ({ kind: "call", id: call.id, title: call.title || null, state: callState(call), pr: null })),
    ...(fleet.artifacts ?? []).map((artifact: Artifact): Thing => ({ kind: "page", id: pageId(artifact), title: artifact.title || null, state: `rev ${artifact.latest.rev}`, pr: null })),
  ];
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every exact mention, in order: an id or page name as a whole word, a PR by number or URL, or a page's whole title. */
function mentions(text: string, known: Thing[]) {
  const found: { thing: Thing; token: string; at: number }[] = [];
  const word = (needle: string) => new RegExp(`(?<![A-Za-z0-9_/-])${escapeRegExp(needle)}(?![A-Za-z0-9_-])`, "g");
  for (const thing of known) {
    // A page's name counts only when it reads as a name, never a plain word like "report".
    const names = thing.kind !== "page" ? [thing.id] : [thing.id.split("/").at(-1)!].filter((name) => /[-_\d]/.test(name));
    for (const name of names) for (const match of text.matchAll(word(name))) found.push({ thing, token: match[0], at: match.index });
    if (thing.kind === "page" && thing.title) {
      const at = text.indexOf(thing.title);
      if (at >= 0) found.push({ thing, token: thing.title, at });
    }
  }
  // A PR by its URL names only the thing carrying exactly that URL; by its number, every thing whose PR has it.
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+?\/pull\/\d+(?![\d/])/g)) {
    for (const thing of known) if (thing.pr === match[0]) found.push({ thing, token: match[0], at: match.index });
  }
  for (const match of text.matchAll(/(?<![A-Za-z0-9_/#])(?:(?:PR|pr|Pr) ?#?|#)(\d+)(?!\d)/g)) {
    for (const thing of known) if (prNumber(thing.pr) === match[1]) found.push({ thing, token: match[0], at: match.index });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  return found.filter(({ thing }) => !seen.has(thingKey(thing)) && seen.add(thingKey(thing)));
}

/**
 * The things a place names, from the snapshot: in the quote first; for selected words, then in the block they are in;
 * and in the rest of its message only when the place names none. Only exact matches count, and a word the snapshot
 * does not know is never a thing.
 */
export function thingsNamed(quote: string, message: string, known: Thing[], block?: string): Found[] {
  const places: [Found["where"], string | undefined][] = [["quote", quote], ["block", block], ["message", message]];
  for (const [where, text] of places) {
    const found = text ? mentions(text, known) : [];
    if (found.length) return found.map(({ thing, token }) => ({ ...thing, token, where }));
  }
  return [];
}

/** The card itself, as the thing a reply to it means. */
export function cardThing(owner: PlaceOwner, known: Thing[], titles: Record<string, string | null> = {}): Thing | null {
  const id = owner.kind === "call" ? owner.id : owner.kind === "answer" ? owner.call : owner.kind === "page" ? owner.id : owner.kind === "review" ? owner.page : null;
  if (!id) return null;
  const kind: ThingKind = owner.kind === "call" || owner.kind === "answer" ? "call" : "page";
  return known.find((thing) => thing.kind === kind && thing.id === id) ?? { kind, id, title: titles[id] ?? null, state: "not read", pr: null };
}

/** What a reply attached in the composer would send: the meant thing and the named ones, or why none could be read. */
export function resolve(draft: ReplyDraft, fleet: FleetRead) {
  const known = "read" in fleet ? fleet.read.things : [];
  const card = cardThing(draft.place.owner, known);
  const found = "read" in fleet ? thingsNamed(draft.place.quote, draft.place.message, known, draft.place.block).filter((thing) => !card || thingKey(thing) !== thingKey(card)) : [];
  const picked = card ? null : found.find((thing) => thingKey(thing) === draft.picked) ?? null;
  return {
    meant: card ? { thing: card, why: "a card is the thing itself" } : picked ? { thing: picked as Thing, why: "the captain picked it" } : null,
    named: found.filter((thing) => thing !== picked),
    found,
    unread: "failed" in fleet ? fleet.failed : null,
  };
}

function thingLine(thing: Thing) {
  const title = thing.title ? ` ${JSON.stringify(thing.title)}` : "";
  const pr = thing.pr ? ` · PR ${thing.pr}` : "";
  return `${thing.kind} ${thing.id}${title} · ${thing.state}${pr}`;
}

/** Up to `limit` characters from one end, cut back to a whole word when the cut falls inside one. */
function cut(text: string, limit: number, keep: "start" | "end") {
  if (text.length <= limit) return text;
  if (keep === "start") {
    const head = text.slice(0, limit);
    const word = /\S$/.test(head) && /^\S/.test(text.slice(limit)) ? head.replace(/\S+$/, "") : head;
    return `${(word.trim() ? word : head).trimEnd()}…`;
  }
  const tail = text.slice(text.length - limit);
  const word = /^\S/.test(tail) && /\S$/.test(text.slice(0, text.length - limit)) ? tail.replace(/^\S+/, "") : tail;
  return `…${(word.trim() ? word : tail).trimStart()}`;
}

function whose(owner: PlaceOwner) {
  return owner.kind === "mate" ? "your message" : "the captain's message";
}

function saidWords(said: Said, now: number, verb: string) {
  if (!said) return "";
  return "at" in said ? `${verb} ${clock(said.at, now)}` : `from a resumed conversation, said before ${clock(said.before, now)}`;
}

function onLine(place: Place, now: number) {
  const { owner } = place;
  const back = `${place.back} before this one`;
  const when = (verb: string) => saidWords(place.said, now, verb);
  const parts = (...items: string[]) => items.filter(Boolean).join(", ");
  switch (owner.kind) {
    case "mate":
      return parts(`your message ${when("of")}`.trimEnd(), back, place.unit ? `${place.unit.kind} ${place.unit.index} of ${place.unit.of}` : "");
    case "captain":
      return parts(`the captain's own message ${when("of")}`.trimEnd(), back);
    case "call":
      return parts(`the call card for ${owner.id}`, when("raised"), back);
    case "page":
      return parts(`the page card for ${owner.id} rev ${owner.rev}`, when("presented"), back);
    case "answer":
      return parts(`the card of the captain's answer to ${owner.call}`, when("given"), back);
    case "review":
      return parts(`the card of the captain's review of ${owner.page}`, when("sent"), back);
  }
}

function namedWhy(thing: Found, count: number, unit: UnitKind | undefined) {
  const token = JSON.stringify(thing.token);
  const where = thing.where === "quote" ? `named in the quote: ${token}`
    : thing.where === "block" ? `named in the ${unit ?? "block"} the quote is in, not in the quote: ${token}`
    : `named in the message, not in the quote: ${token}`;
  return `${where}; ${count === 1 ? "the only thing it names" : `one of ${count} things it names`}; not picked`;
}

/**
 * The block for a reply, as the first mate receives it. `now` is when it is sent, which every time in it is said
 * against. The things are read from the fleet as it is at that moment.
 */
export function replyBlock(draft: ReplyDraft, fleet: FleetRead, now: number) {
  const { place } = draft;
  const { meant, named, found, unread } = resolve(draft, fleet);
  const lines = [REPLY_HEADING, `${pad("on")}${onLine(place, now)}`];
  const quoted = place.quote.length > QUOTE_LIMIT ? place.quote.slice(0, QUOTE_LIMIT) : place.quote;
  const notes = [
    place.quote.length > QUOTE_LIMIT ? `(cut at ${QUOTE_LIMIT} of ${place.quote.length} characters)` : "",
    place.selected ? "(a span the captain selected)" : "",
  ].filter(Boolean);
  lines.push(`${pad("quote")}${JSON.stringify(quoted)}${notes.length ? `  ${notes.join(" ")}` : ""}`);
  if (place.around) {
    const end = (side: "start" | "end") => `(${side} of ${whose(place.owner)})`;
    const before = place.around.before ? JSON.stringify(cut(place.around.before, AROUND_LIMIT, "end")) : end("start");
    const after = place.around.after ? JSON.stringify(cut(place.around.after, AROUND_LIMIT, "start")) : end("end");
    lines.push(`${pad("around")}${before} ${HERE} ${after}`);
  }
  if (meant) lines.push(`${pad("meant")}${thingLine(meant.thing)}  (${meant.why})`);
  if (unread) {
    const at = unread.at === null ? "" : ` at ${clock(unread.at, now)}`;
    lines.push(`${pad("named")}could not be read: the fleet snapshot failed${at} (${unread.why})`);
  } else {
    for (const thing of named) lines.push(`${pad("named")}${thingLine(thing)}  (${namedWhy(thing, found.length, place.unit?.kind)})`);
    if ("read" in fleet) lines.push(`${pad("read at")}${clock(fleet.read.at, now)} from the fleet snapshot`);
  }
  lines.push(REPLY_RULE);
  return lines.join("\n");
}

/** The message as it is sent: the reply's block first, then the captain's words, untouched. */
export function withReply(words: string, block: string | null) {
  return block ? `${block}\n${words}` : words;
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const THING_LINE = new RegExp(String.raw`^(task|call|page) (\S+)(?: (${JSON_STRING}))? · (.+?)(?:  \((.+)\))?$`);
const SPAN_NOTE = String.raw`\(a span the captain selected\)`;
const QUOTE_LINE = new RegExp(String.raw`^(${JSON_STRING})(?:  \(cut at ${QUOTE_LIMIT} of (\d+) characters\)(?: (${SPAN_NOTE}))?|  (${SPAN_NOTE}))?$`);
const AROUND_SIDE = String.raw`(${JSON_STRING}|\((?:start|end) of [^)]+\))`;
const AROUND_LINE = new RegExp(String.raw`^${AROUND_SIDE} ${HERE} ${AROUND_SIDE}$`);

function parseString(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function parseThing(text: string): SentThing | null {
  const match = THING_LINE.exec(text);
  if (!match) return null;
  const title = match[3] === undefined ? null : parseString(match[3]);
  if (match[3] !== undefined && title === null) return null;
  const [state, pr = null] = match[4].split(" · PR ");
  return { kind: match[1] as ThingKind, id: match[2], title, state, pr, why: match[5] ?? null };
}

function parseOwner(on: string): PlaceOwner | null {
  if (/^your message\b/.test(on)) return { kind: "mate" };
  if (/^the captain's own message\b/.test(on)) return { kind: "captain" };
  let match = /^the call card for (\S+?),/.exec(on);
  if (match) return { kind: "call", id: match[1] };
  match = /^the page card for (\S+) rev (\d+),/.exec(on);
  if (match) return { kind: "page", id: match[1], rev: Number(match[2]) };
  match = /^the card of the captain's answer to (\S+?),/.exec(on);
  if (match) return { kind: "answer", call: match[1] };
  match = /^the card of the captain's review of (\S+?),/.exec(on);
  if (match) return { kind: "review", page: match[1] };
  return null;
}

function aroundSide(text: string) {
  if (text.startsWith("(")) return null;
  return parseString(text);
}

/**
 * Splits a sent message into its reply and the captain's words. Only a block this module wrote counts: the heading as
 * the first line, keyed lines it knows in the shape it writes them, and the rule. Anything else, a block cut short or
 * written by something else, is refused whole and the message is its own words, never half read.
 */
export function splitReply(message: string): { reply: SentReply; words: string } | null {
  const lines = message.split("\n");
  if (lines[0] !== REPLY_HEADING) return null;
  const end = lines.indexOf(REPLY_RULE);
  if (end < 0) return null;
  const seen = new Map<Key, string[]>();
  for (const line of lines.slice(1, end)) {
    const key = KEYS.find((candidate) => line.startsWith(pad(candidate)) && line.length > KEY_WIDTH && line[KEY_WIDTH] !== " ");
    if (!key) return null;
    seen.set(key, [...seen.get(key) ?? [], line.slice(KEY_WIDTH)]);
  }
  const one = (key: Key) => {
    const values = seen.get(key) ?? [];
    return values.length > 1 ? undefined : values[0] ?? null;
  };
  const on = one("on");
  const quoteLine = one("quote");
  const aroundLine = one("around");
  const meantLine = one("meant");
  const readAt = one("read at");
  if (!on || !quoteLine || aroundLine === undefined || meantLine === undefined || readAt === undefined) return null;
  const owner = parseOwner(on);
  const quoted = QUOTE_LINE.exec(quoteLine);
  const quote = quoted && parseString(quoted[1]);
  if (!owner || quote === null || quote === undefined || !quoted) return null;
  const card = owner.kind !== "mate" && owner.kind !== "captain";
  let around: SentReply["around"] = null;
  if (aroundLine !== null) {
    const match = AROUND_LINE.exec(aroundLine);
    if (!match || card) return null;
    const before = aroundSide(match[1]);
    const after = aroundSide(match[2]);
    if ((match[1].startsWith('"') && before === null) || (match[2].startsWith('"') && after === null)) return null;
    around = { before, after };
  } else if (!card) return null;
  const meant = meantLine === null ? null : parseThing(meantLine);
  if (meantLine !== null && !meant) return null;
  let unread: string | null = null;
  const named: SentThing[] = [];
  for (const line of seen.get("named") ?? []) {
    if (line.startsWith("could not be read: ")) {
      if (unread !== null || named.length) return null;
      unread = line.slice("could not be read: ".length);
      continue;
    }
    const thing = parseThing(line);
    if (!thing || unread !== null) return null;
    named.push(thing);
  }
  if (readAt !== null && !/ from the fleet snapshot$/.test(readAt)) return null;
  return {
    reply: {
      owner, on, quote, cutFrom: quoted[2] ? Number(quoted[2]) : null, selected: Boolean(quoted[3] || quoted[4]), around, meant, named, unread,
      readAt: readAt === null ? null : readAt.replace(/ from the fleet snapshot$/, ""),
    },
    words: lines.slice(end + 1).join("\n"),
  };
}

/** A message as the chat drew it: its words as one line, the way a place's quote and context were taken from it. */
export type DrawnMessage = { id: string; who: "mate" | "captain"; text: string };

function trimEllipsis(text: string, side: "start" | "end") {
  return side === "start" ? text.replace(/^…/, "") : text.replace(/…$/, "");
}

/**
 * Finds a sent reply's place again among the messages the chat shows, oldest first: the latest message of the right
 * speaker whose drawn words hold the quote with the same words around it. A near miss is no match: when nothing
 * fits, the answer is null, and the place is said to be gone rather than shown somewhere it is not.
 */
export function findPlace(reply: SentReply, messages: DrawnMessage[]): { id: string; start: number; end: number } | null {
  const { owner, around } = reply;
  if (owner.kind !== "mate" && owner.kind !== "captain") return null;
  const length = reply.cutFrom ?? reply.quote.length;
  if (!reply.quote) return null;
  for (const message of [...messages].reverse()) {
    if (message.who !== owner.kind) continue;
    const { text } = message;
    for (let at = text.lastIndexOf(reply.quote); at >= 0; at = at === 0 ? -1 : text.lastIndexOf(reply.quote, at - 1)) {
      const end = at + length;
      if (end > text.length) continue;
      const before = text.slice(0, at).trimEnd();
      const after = text.slice(end).trimStart();
      const beforeFits = around?.before == null ? before === "" : before.endsWith(trimEllipsis(around.before, "start"));
      const afterFits = around?.after == null ? after === "" : after.startsWith(trimEllipsis(around.after, "end"));
      if (beforeFits && afterFits) return { id: message.id, start: at, end };
    }
  }
  return null;
}

/** What the first mate wrote when it replied to one of the captain's messages, by the convention `engine/AGENTS.md` gives it. */
export type MateReply = { quote: string; message: string; words: string };

/**
 * The first mate's `↩ "<the captain's words>"` first line, matched word for word against the captain's messages
 * before it, the latest that holds them. With no exact match it is no reply, and its line is drawn as written.
 */
export function mateReplyOf(text: string, captains: { id: string; words: string }[]): MateReply | null {
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  const match = /^↩ "(.+)"\s*$/.exec(first);
  if (!match) return null;
  const quote = collapse(match[1]);
  if (!quote) return null;
  const said = [...captains].reverse().find((message) => collapse(message.words).includes(quote));
  return said ? { quote, message: said.id, words: newline < 0 ? "" : text.slice(newline + 1).replace(/^\n+/, "") } : null;
}

/** A slash command goes to Claude Code, not the first mate, so a reply cannot go with one. */
export function commandOf(draft: string, commands: string[] | null) {
  const name = /^\/([A-Za-z][\w:-]*)(?:\s|$)/.exec(draft.trim())?.[1];
  if (!name) return null;
  return name === "compact" || (commands ?? []).includes(name) ? `/${name}` : null;
}

/** A thing's chip on a sent reply: its state now, and what it was when the captain replied when that has changed. */
export function chipState(sent: SentThing, now: Thing | undefined, fleetRead: boolean) {
  if (!fleetRead) return `${sent.state} when you replied · not read now`;
  if (!now) return sent.kind === "page" ? `no longer listed · ${sent.state} when you replied` : `closed, older than the board shows · ${sent.state} when you replied`;
  return now.state === sent.state ? now.state : `${now.state} since · ${sent.state} when you replied`;
}

/** How the composer and a header name whose place it is. */
export function ownerLabel(owner: PlaceOwner) {
  switch (owner.kind) {
    case "mate": return "First Mate";
    case "captain": return "You";
    case "call": return "Call card";
    case "page": return "Page card";
    case "answer": return "Your answer";
    case "review": return "Your review";
  }
}
