// What Calm hides in the chat. docs/calm.md (in the engine) owns Calm's intent on every surface; this is how the
// app's own chat honours it. The chat already hides thinking and firstmate's operational inputs, so Calm adds the
// rest: the steps, and the first mate's working notes, the narration it writes alongside its tool calls.
//
// ACP text arrives with no stop reason, so a stretch of the first mate's words is a working note only once a step
// follows it in the same turn; until then it shows as it streams, because text still streaming is never hidden. The
// Claude Code mod's rule applies too: a note with a line break, or of 240 characters or more, stays, as a reply would.
// Hiding is presentation only: nothing is removed, and turning Calm off shows everything again.

/** The shape of a chat message this needs. */
type Said = { id: string; who: "mate" | "captain" | "step" | "notice"; text: string; turn?: number };

/** At or over this many characters, a note is kept as a reply would be (the Claude Code mod's threshold). */
export const KEPT_AT = 240;

/** A stretch of the first mate's words that reads as narration, not as a reply. */
export function readsAsNote(text: string) {
  return !text.includes("\n") && text.trim().length < KEPT_AT;
}

/**
 * The ids Calm hides: every step, and every working note, which is the first mate's words followed by a step before
 * the captain speaks again or a new turn begins. Words from a resumed session's history carry no turn, so there only the
 * captain and notices mark where a turn ends.
 */
export function calmHidden(messages: Said[]): Set<string> {
  const hidden = new Set<string>();
  let stepAfter = false;
  let stepTurn: number | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.who === "step") {
      hidden.add(message.id);
      stepAfter = true;
      stepTurn = message.turn;
    } else if (message.who === "captain" || message.who === "notice") {
      stepAfter = false;
    } else if (message.who === "mate" && stepAfter && message.turn === stepTurn && readsAsNote(message.text)) {
      hidden.add(message.id);
    }
  }
  return hidden;
}

/** A turn's elapsed time as the working row shows it: 0:09, 1:12, 1:02:03. */
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
