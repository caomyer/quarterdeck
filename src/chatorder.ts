/**
 * Where the pages presented in the chat's window go among its messages.
 *
 * THE INVARIANT: a page never renders below a message newer than it.
 *
 * A resumed conversation comes back without times, so what is known of a message is a bound: the latest it can have
 * been said. The conversation is in order, so a message was said no later than anything after it, and its bound is
 * the least of its own and every later one's. A page goes before the first message that could be newer than it,
 * which is right after every message it is known to be newer than. With no times at all in a resumed history, that
 * is above all of it: a page whose place cannot be told is shown too early, never too late.
 */
import type { ChatMessage } from "./host/use-host";

/**
 * The latest a message can have been said, in milliseconds: its own time when it has one, the time of the review it
 * is (`reviewAt`), or, for a resumed message with neither, when its history was read. Nothing known is no bound at all.
 */
export function latestTime(message: Pick<ChatMessage, "createdAt" | "past" | "before">, reviewAt?: number) {
  const at = !message.past ? Date.parse(message.createdAt) : reviewAt ?? Date.parse(message.before ?? "");
  return Number.isNaN(at) ? Infinity : at;
}

/**
 * For each page, the index of the message it renders before, or `bounds.length` for after them all.
 * `bounds[i]` is the latest message `i` can have been said, in milliseconds, and `Infinity` when nothing is known.
 * A page presented at the very time a message was said goes after it.
 */
export function pagePlaces(bounds: number[], pages: number[]): number[] {
  const latest = [...bounds, Infinity];
  for (let index = bounds.length - 1; index >= 0; index--) latest[index] = Math.min(latest[index], latest[index + 1]);
  return pages.map((at) => latest.findIndex((bound) => at < bound));
}
