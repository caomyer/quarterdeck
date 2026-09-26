/**
 * What a call's two cards in the chat say, worked out from the call record alone.
 *
 * A call is drawn twice in the chat, each time where its event happened: a call card where the first mate raised it,
 * and an answer card where the captain answered it. Both read the snapshot's `calls[]`, where the call stands
 * (`callStanding` in src/calls.ts), and the app's own answer lines (`answerOfMessage`), never the first mate's prose.
 * `src/CallCards.tsx` draws what these return.
 *
 * The captain's reply on a call, words that nothing has recorded yet, is taken as an input rather than read off the
 * call, so every surface passes the same one (`replyOf`). A reply is never shown as settled: only a record is.
 *
 * Pure functions only: no React, no host.
 */
import type { Call } from "./host/types";
import type { CallStanding, MessageAnswer } from "./calls";

/** The captain's words kept on a call that nothing has recorded yet: what he said, and when. */
export type ReplyWords = { words: string; at: string };

/** What the captain last said on a call in this chat, in his words and when, for a call that asks him again. */
export type EarlierWords = { words: string; at: string | null };

/** How a time reads on a card; the app passes its own, so cards read like the rest of the chat. */
export type When = (at: string) => string;

export type Tone = "green" | "amber" | "coral" | "muted";

/** A dated Not now, read back from the words the app wrote for it (`answerInWords`): the day, as said. */
export function notNowDay(words: string) {
  return words.match(/^Not now\. Ask me again on ([^.]+)\./)?.[1] ?? null;
}

/**
 * A call that is not the captain's to answer any more, as one line: what happened to it, in a word on its pill, and
 * which option was picked, for the question and options kept one click away. Null while the call waits on him.
 */
export type CallLine = { kind: Exclude<CallStanding["kind"], "open">; tone: Tone; detail: string; pill: string | null; page: string | null; pick: string | null };

export function callLine(call: Call, standing: CallStanding, earlier: EarlierWords | null = null): CallLine | null {
  switch (standing.kind) {
    case "open":
      return null;
    case "recorded": {
      const pick = call.options.find((option) => option.label === standing.label)?.key ?? call.answer?.key ?? null;
      return { kind: "recorded", tone: "green", detail: `you chose ${standing.label}`, pill: "recorded", page: null, pick };
    }
    case "in-review":
      return { kind: "in-review", tone: "green", detail: "answered in your review of", pill: null, page: standing.page, pick: null };
    case "held": {
      // The day comes from what he said; after a relaunch with that out of reach, the line does not guess one.
      const day = earlier ? notNowDay(earlier.words) : null;
      return { kind: "held", tone: "amber", detail: day ? `not now, ask again ${day}` : "not now, held", pill: "held", page: null, pick: null };
    }
    case "closed":
      return { kind: "closed", tone: "muted", detail: "closed without an answer from you", pill: "closed", page: null, pick: null };
  }
}

/**
 * A call waiting on the captain, as its card in the chat says it. `replied` folds the form under Answer differently,
 * so a second answer is never given by accident. `optionsChanged` is when the first mate offered new options after
 * raising it, since its message above the card may still describe the old ones; `withdrawn` names a pick the call no
 * longer offers. `earlier` is what he said before, shown only while no reply stands in its place.
 */
export type CallCardView = {
  kicker: string[];
  replied: boolean;
  optionsChanged: string | null;
  withdrawn: string | null;
  earlier: string | null;
};

export function callCardView(call: Call, { project, reply, earlier, askedBefore, withdrawn, when }: {
  project: string | null;
  reply: ReplyWords | null;
  earlier: EarlierWords | null;
  askedBefore: boolean;
  withdrawn: string | null;
  when: When;
}): CallCardView {
  const raised = Date.parse(call.raised_at ?? "");
  const updated = Date.parse(call.updated_at ?? "");
  // `offer` moves updated_at and nothing else; a hold that sets options moves both together, which changes nothing.
  const changed = Number.isFinite(raised) && Number.isFinite(updated) && updated > raised;
  const dayCome = earlier !== null && reply === null && notNowDay(earlier.words) !== null;
  const kicker = [
    project,
    call.raised_at && Number.isFinite(raised) ? `raised ${when(call.raised_at)}` : null,
    askedBefore ? "asked before" : null,
    dayCome ? "your day has come" : null,
  ].filter((part): part is string => Boolean(part));
  return {
    kicker,
    replied: reply !== null,
    optionsChanged: changed ? when(call.updated_at!) : null,
    withdrawn,
    earlier: earlier && reply === null ? `${earlier.at ? `On ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(earlier.at))} you said` : "You said"}: ${earlier.words}` : null,
  };
}

/**
 * One of the captain's answers, as its card in the chat says it. `line` is an answer whose call has left the snapshot,
 * drawn from the app's own line alone. The tone and `status` say how far it has got, which only the call record can
 * say: a recorded option is green; words stay amber while the call still carries them as his reply, and never turn
 * green until something records the call. `askedAgain` points down to where the call was asked anew.
 */
export type AnswerCardView = {
  kind: MessageAnswer["kind"];
  line: boolean;
  kicker: string;
  title: string;
  said: string;
  note: string | null;
  tone: Tone;
  status: string;
  askedAgain: boolean;
};

/**
 * Whether the words a message says the captain replied are the reply the call carries. The message holds them as
 * review.rs `shorten()` wrote them: whitespace squeezed to single spaces and, past its limit, cut with an ellipsis.
 */
function sameWords(kept: string, said: string): boolean {
  const squeeze = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
  const k = squeeze(kept);
  const s = squeeze(said);
  return s.endsWith("…") ? k.startsWith(s.slice(0, -1)) : k === s;
}

export function answerCardView(answer: MessageAnswer, call: Call | undefined, { reply, said, past, delivery, from }: {
  /** The reply the call carries now, if any. */
  reply: ReplyWords | null;
  /** The latest the message can have been said, in milliseconds (`latestTime`). */
  said: number;
  past: boolean;
  /** How far the message has got with the first mate, as the chat says it, or null when nothing is known. */
  delivery: string | null;
  /** Where he answered, when this session knows. */
  from: "chat" | "bearings" | null;
}): AnswerCardView {
  const title = call?.title ?? answer.call;
  // Asked again since: a hold that starts a new lifecycle moves raised_at past the answer. A resumed message has no
  // time of its own, but a recorded answer that finds its call open again was asked anew: a closed call never reopens.
  const askedAgain = call !== undefined && (Date.parse(call.raised_at ?? "") > said || (past && answer.kind === "recorded" && call.state === "open"));
  if (answer.kind === "recorded") {
    const kicker = `Your answer${from === "chat" ? " · in chat" : from === "bearings" ? " · from Bearings" : ""}`;
    const status = askedAgain || !delivery ? "Recorded" : `Recorded · ${delivery}`;
    return { kind: "recorded", line: call === undefined, kicker, title, said: answer.label, note: answer.note, tone: "green", status, askedAgain };
  }
  const [tone, status]: [Tone, string] = !call
    ? ["muted", "The call has closed"]
    : call.state !== "open"
      ? call.answer?.by === "captain" ? ["green", `Recorded: ${call.answer.label}`] : ["muted", "The call has closed"]
      : reply && sameWords(reply.words, answer.words)
        ? ["amber", "With the first mate · not recorded yet"]
        : call.captain_actionable === false
          ? ["amber", "Held: not now"]
          : ["muted", "Not recorded · the first mate asked again"];
  return { kind: "replied", line: false, kicker: "Your answer · in words", title, said: answer.words, note: null, tone, status, askedAgain };
}
