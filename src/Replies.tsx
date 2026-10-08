/**
 * Replying to a place in the chat, as the captain sees it: the arrow on a paragraph, item or card, the strip above
 * the draft, the header a sent reply carries, and its things' chips. What a reply says is `src/replyto.ts`'s alone;
 * this file only finds places on screen and draws what that module wrote or read.
 */
import { CornerUpLeft, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  chipState, type DrawnMessage, findPlace, type FleetRead, type Found, ownerLabel, prNumber, type ReplyDraft, resolve, type SentReply, type SentThing,
  type Thing, thingKey, type UnitKind,
} from "./replyto";

/** The blocks of a message a reply can point at: the markdown's own, and a list's items one by one. */
const PLACES = "li, h1, h2, h3, h4, h5, h6, p, pre, blockquote, table";
/** Elements whose text reads as a block of its own, so the words on either side of one are kept apart. */
const BLOCKS = `${PLACES}, td, th, tr, ul, ol`;
/** The cards a reply can point at, each one thing. */
export const CARDS = "[data-testid='call-card'], [data-testid='answer-card'], [data-testid='artifact-card'], [data-testid='review-card']";

/** Where a message's words are drawn: the first mate's markdown, or the captain's bubble. */
export function wordsOf(article: Element) {
  return article.querySelector<HTMLElement>(":scope > div > .markdown, :scope > div > .captain-words");
}

/** The block under the pointer that a reply would quote, within a message's words: an item, or a top-level block. */
export function placeAt(target: Element, words: HTMLElement) {
  if (words.matches(".captain-words")) return words;
  let place = target.closest(PLACES);
  if (!place || !words.contains(place) || place === words) return null;
  // A paragraph inside an item or a block quote is part of it; an item stays the innermost one.
  const holder = place.parentElement?.closest("li, blockquote");
  if (!place.matches("li") && holder && words.contains(holder)) place = holder;
  if (!place.matches("li")) while (place.parentElement && place.parentElement !== words) place = place.parentElement;
  return place as HTMLElement;
}

const UNIT_KINDS: Record<string, UnitKind> = { P: "paragraph", PRE: "code block", BLOCKQUOTE: "block quote", TABLE: "table" };

/** Which block of its message a place is. */
export function unitOf(place: HTMLElement, words: HTMLElement): ReplyDraft["place"]["unit"] {
  if (place === words) return null;
  if (place.matches("li")) {
    const items = [...place.parentElement!.children].filter((child) => child.matches("li"));
    return { kind: "item", index: items.indexOf(place) + 1, of: items.length };
  }
  const blocks = [...words.children];
  return { kind: /^H\d$/.test(place.tagName) ? "heading" : UNIT_KINDS[place.tagName] ?? "paragraph", index: blocks.indexOf(place) + 1, of: blocks.length };
}

type Piece = { node: Text; start: number; text: string; trimmed: boolean };

/**
 * A message's words as one line, the way a reply quotes them: each text node's whitespace collapsed, and a space
 * between blocks so words on either side of one never run together. Kept with where each text node starts in it.
 */
export function drawnText(words: HTMLElement) {
  const walker = document.createTreeWalker(words, NodeFilter.SHOW_TEXT);
  const pieces: Piece[] = [];
  let text = "";
  let block: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const holder = node.parentElement?.closest(BLOCKS) ?? words;
    if (holder !== block && text && !text.endsWith(" ")) text += " ";
    block = holder;
    let piece = node.data.replace(/\s+/g, " ");
    const trimmed = (!text || text.endsWith(" ")) && piece.startsWith(" ");
    if (trimmed) piece = piece.slice(1);
    pieces.push({ node, start: text.length, text: piece, trimmed });
    text += piece;
  }
  return { text: text.trimEnd(), pieces };
}

/** Where a point in the DOM falls in the drawn text. */
function offsetOf(drawn: ReturnType<typeof drawnText>, container: Node, offset: number) {
  if (container.nodeType === Node.TEXT_NODE) {
    const piece = drawn.pieces.find((item) => item.node === container);
    if (!piece) return null;
    let before = (container as Text).data.slice(0, offset).replace(/\s+/g, " ");
    if (piece.trimmed) before = before.replace(/^ /, "");
    return piece.start + Math.min(before.length, piece.text.length);
  }
  const follows = (from: Node, piece: Piece) => from === piece.node || from.contains(piece.node) || (from.compareDocumentPosition(piece.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  // Before the container's child at `offset`: where the first text at or after that child starts.
  const child = container.childNodes[offset];
  if (child) return drawn.pieces.find((piece) => follows(child, piece))?.start ?? drawn.text.length;
  // At the container's end: after its last text, or where the text after it starts when it holds none.
  const inside = drawn.pieces.filter((piece) => container.contains(piece.node)).at(-1);
  if (inside) return inside.start + inside.text.length;
  return drawn.pieces.find((piece) => follows(container, piece))?.start ?? drawn.text.length;
}

/** A stretch of the drawn text as a place's quote and the words around it, whitespace at its edges left out. */
function stretch(text: string, from: number, to: number) {
  let start = Math.max(0, Math.min(from, to));
  let end = Math.min(text.length, Math.max(from, to));
  while (start < end && text[start] === " ") start++;
  while (end > start && text[end - 1] === " ") end--;
  return { quote: text.slice(start, end), before: text.slice(0, start).trimEnd(), after: text.slice(end).trimStart() };
}

/** A block's words in its message's drawn text. */
export function blockStretch(place: HTMLElement, words: HTMLElement) {
  const drawn = drawnText(words);
  const inside = drawn.pieces.filter((piece) => place.contains(piece.node));
  if (!inside.length) return null;
  const last = inside.at(-1)!;
  return stretch(drawn.text, inside[0].start, last.start + last.text.length);
}

/** The captain's selection as a stretch of one message's drawn text, or null when it is not inside one message's words. */
export function selectionStretch(selection: Selection, words: HTMLElement) {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!words.contains(range.startContainer) || !words.contains(range.endContainer)) return null;
  const drawn = drawnText(words);
  const start = offsetOf(drawn, range.startContainer, range.startOffset);
  const end = offsetOf(drawn, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  const found = stretch(drawn.text, start, end);
  if (!found.quote) return null;
  // The block the selection starts in names where it is.
  const startNode = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as Element;
  return { ...found, place: startNode ? placeAt(startNode, words) : null };
}

/** The element a found stretch of a message sits in: the block holding its start. */
function blockAt(words: HTMLElement, at: number) {
  const drawn = drawnText(words);
  // Whitespace between blocks draws as nothing, so only text with words in it can hold the place.
  const piece = drawn.pieces.find((item) => item.text.trim() && at >= item.start && at < item.start + item.text.length);
  return piece?.node.parentElement ? placeAt(piece.node.parentElement, words) : null;
}

/**
 * Where a sent reply's place is on screen now, before the message that sent it: found again by its words, or for a
 * card by the call or page it is. Null when it is not there, and never a guess.
 */
export function locate(reply: SentReply, list: HTMLElement, from: Element): HTMLElement | null {
  const earlier = (element: Element) => (element.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const { owner } = reply;
  if (owner.kind === "mate" || owner.kind === "captain") {
    const articles = [...list.querySelectorAll<HTMLElement>("article.mate-message[data-message-id], article.captain-message[data-message-id]")].filter(earlier);
    const drawn: (DrawnMessage & { words: HTMLElement })[] = articles.flatMap((article) => {
      const words = wordsOf(article);
      return words ? [{ id: article.dataset.messageId!, who: article.matches(".mate-message") ? "mate" as const : "captain" as const, text: drawnText(words).text, words }] : [];
    });
    const found = findPlace(reply, drawn);
    if (!found) return null;
    const words = drawn.find((message) => message.id === found.id)!.words;
    return blockAt(words, found.start);
  }
  const selector = owner.kind === "call" ? `[data-testid='call-card'][data-call-id="${CSS.escape(owner.id)}"]`
    : owner.kind === "answer" ? `[data-testid='answer-card'][data-call-id="${CSS.escape(owner.call)}"]`
    : owner.kind === "page" ? `[data-testid='artifact-card'][data-page="${CSS.escape(owner.id)}"][data-rev="${owner.rev}"]`
    : `[data-testid='review-card'][data-page="${CSS.escape(owner.page)}"]`;
  return [...list.querySelectorAll<HTMLElement>(selector)].filter(earlier).at(-1) ?? null;
}

/** Brings a place into view and outlines it for a moment. */
export function showPlace(element: HTMLElement) {
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.classList.add("reply-flash");
  window.setTimeout(() => element.classList.remove("reply-flash"), 1800);
}

function shortState(thing: Pick<Thing, "state" | "pr">) {
  const number = prNumber(thing.pr);
  return number ? `${thing.state} · PR #${number}` : thing.state;
}

function ThingChip({ kind, id, state, meant, title, onPick }: { kind: string; id: string; state: string; meant: boolean; title?: string; onPick?: () => void }) {
  const body = <><span className="thing-kind">{kind}</span><span className="thing-id">{id}</span><span className="thing-state">{state}</span></>;
  const className = `thing-chip ${meant ? "meant" : "named"}`;
  return <li>{onPick
    ? <button className={className} aria-pressed={meant} title={title} onClick={onPick} data-testid="thing-chip" data-thing={`${kind}:${id}`}>{body}</button>
    : <span className={className} title={title} data-testid="thing-chip" data-thing={`${kind}:${id}`}>{body}</span>}</li>;
}

/** The reply attached to the message being written: whose place, the quote, and the things it names, with their state now. */
export function ReplyStrip({ draft, fleet, said, command, onPick, onRemove, onSendWithout, onKeep }: {
  draft: ReplyDraft;
  fleet: FleetRead;
  /** When the place was said, as the chat shows times. */
  said: string | null;
  /** The slash command the draft is, which a reply cannot go with. */
  command: string | null;
  onPick: (key: string | null) => void;
  onRemove: () => void;
  onSendWithout: () => void;
  onKeep: () => void;
}) {
  const { place } = draft;
  const { meant, found } = resolve(draft, fleet);
  const card = meant?.why === "a card is the thing itself";
  const where = place.unit?.kind === "item" ? ` · item ${place.unit.index}` : "";
  const label = `${ownerLabel(place.owner)}${said ? `, ${said}` : ""}${where}`;
  const chips = [
    ...(card && meant ? [<ThingChip key="card" kind={meant.thing.kind} id={meant.thing.id} state={shortState(meant.thing)} meant />] : []),
    ...found.map((thing: Found) => {
      const key = thingKey(thing);
      const picked = draft.picked === key;
      return <ThingChip key={key} kind={thing.kind} id={thing.id} state={shortState(thing)} meant={picked} title={picked ? "You picked this one: the first mate is told you mean it. Tap again to unpick." : `Named ${thing.where === "quote" ? "in the words you pointed at" : thing.where === "block" ? "beside the words you selected" : "elsewhere in this message"}. Tap if this is the one you mean.`} onPick={() => onPick(picked ? null : key)} />;
    }),
  ];
  const unread = "failed" in fleet;
  return <div className={`reply-strip ${command ? "refused" : ""}`} data-testid="reply-strip">
    {command && <div className="reply-problem" role="alert" data-testid="reply-refused">
      <strong>{command} goes to Claude Code, not the first mate, so a reply can't go with it.</strong>
      <div><button onClick={onSendWithout}>Send without the reply</button><button onClick={onKeep}>Keep the reply, edit the message</button></div>
    </div>}
    <div className="reply-strip-top">
      <CornerUpLeft size={13} aria-hidden="true" />
      <span className="reply-strip-label">{label}</span>
      <span className="reply-strip-quote" title={place.quote}>“{place.quote}”</span>
      <button className="reply-strip-remove" onClick={onRemove} title="Remove the reply (Esc)" aria-label="Remove the reply"><X size={12} /></button>
    </div>
    {(chips.length > 0 || unread) && <ul className="thing-chips" aria-label="Things this place names">
      {chips}
      {unread && <li className="thing-chip warn" data-testid="fleet-unread" title={fleet.failed.why}>Fleet not read: things named here can't be checked</li>}
      {!unread && !card && found.length > 0 && !meant && <li className="thing-hint">{found.length === 1 ? "tap if this is the one you mean" : "tap the one you mean, if one is"}</li>}
    </ul>}
  </div>;
}

/** The things a sent reply named, with their state now beside what it was when the captain replied. */
export function SentThings({ reply, fleet }: { reply: SentReply; fleet: FleetRead }) {
  const things: (SentThing & { meant: boolean })[] = [...(reply.meant ? [{ ...reply.meant, meant: true }] : []), ...reply.named.map((thing) => ({ ...thing, meant: false }))];
  if (!things.length) return null;
  const known = "read" in fleet ? fleet.read.things : [];
  return <ul className="thing-chips sent" aria-label="Things the reply named">{things.map((thing) => {
    const now = known.find((candidate) => candidate.kind === thing.kind && candidate.id === thing.id);
    const state = chipState(thing, now, "read" in fleet);
    return <ThingChip key={thingKey(thing)} kind={thing.kind} id={thing.id} state={state} meant={thing.meant} title={thing.meant ? `Meant: ${thing.why ?? ""}` : `Named: ${thing.why ?? ""}`} />;
  })}</ul>;
}

/**
 * The line above a sent reply that says what it answers. Clicking it finds the place again by its words; when the place
 * is no longer in the chat, it opens out to show the quote it sent and says so, rather than pointing anywhere else.
 */
export function ReplyHeader({ reply, version }: { reply: SentReply; version: unknown }) {
  const [gone, setGone] = useState(false);
  const self = useRef<HTMLElement>(null);
  // Looked for from the header itself, which is on screen by now, before the message's own refs may be.
  const find = () => {
    const from = self.current?.closest("article");
    const list = from?.closest<HTMLElement>("[data-testid='chat-messages']");
    return from && list ? locate(reply, list, from) : null;
  };
  useLayoutEffect(() => setGone(find() === null), [version]);
  const quote = `${reply.quote}${reply.cutFrom ? "…" : ""}`;
  if (gone) {
    return <div ref={self as React.RefObject<HTMLDivElement>} className="reply-header gone" data-testid="reply-header" data-found="false">
      <span className="reply-header-who"><CornerUpLeft size={13} aria-hidden="true" />{ownerLabel(reply.owner)}</span>
      <span className="reply-header-quote">“{quote}”</span>
      <small>Not in this chat any more, so it can't be shown. The words above are what was sent.</small>
    </div>;
  }
  return <button ref={self as React.RefObject<HTMLButtonElement>} className="reply-header" data-testid="reply-header" data-found="true" title="Show where this was said" onClick={() => {
    const element = find();
    if (element) showPlace(element);
    else setGone(true);
  }}><CornerUpLeft size={13} aria-hidden="true" /><span className="reply-header-who">{ownerLabel(reply.owner)}:</span><span className="reply-header-quote">“{quote}”</span></button>;
}

/** The line above the first mate's reply to one of the captain's messages, drawn only on an exact match. */
export function MateReplyHeader({ quote, onGo }: { quote: string; onGo: () => void }) {
  return <button className="reply-header" data-testid="mate-reply-header" title="Show the message this answers" onClick={onGo}><CornerUpLeft size={13} aria-hidden="true" /><span className="reply-header-who">You:</span><span className="reply-header-quote">“{quote}”</span></button>;
}

/** The arrow beside the place under the pointer, and the button that replies to selected words. */
export function ReplyAffordances({ hover, selection, onHoverReply, onSelectionReply }: {
  hover: { top: number; left: number } | null;
  selection: { top: number; left: number } | null;
  onHoverReply: () => void;
  onSelectionReply: () => void;
}) {
  return <>
    {hover && <button className="reply-arrow" style={{ top: hover.top, left: hover.left }} onMouseDown={(event) => event.preventDefault()} onClick={onHoverReply} title="Reply to this (R)" aria-label="Reply to this" data-testid="reply-arrow"><CornerUpLeft size={14} /></button>}
    {selection && <button className="reply-to-selection" style={{ top: selection.top, left: selection.left }} onMouseDown={(event) => event.preventDefault()} onClick={onSelectionReply} data-testid="reply-to-selection"><CornerUpLeft size={13} />Reply to this</button>}
  </>;
}

/** Whether the keyboard is in something the captain types into, where R is a letter and not a reply. */
export function typing(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || element.matches?.("input, textarea, select")));
}

/** Re-renders a component when the window's selection changes, for the button that replies to selected words. */
export function useSelectionChange(onChange: () => void) {
  useEffect(() => {
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [onChange]);
}
