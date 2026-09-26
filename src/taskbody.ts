/**
 * What a filer wrote under a backlog row, read the way they wrote it.
 *
 * The snapshot keeps a body one entry per line (`body_lines`), and a filer uses those lines: a paragraph per line,
 * `- ` for a list, a leading label in capitals ("SYMPTOM:", "WHAT TO FIX:") to say what a paragraph is. Joining
 * them with spaces lost all of that, so a body is read into blocks instead. Nothing here is Markdown: only those
 * three shapes, plus backticks for code, and anything else stays the text it was.
 */

/**
 * Backlog body lines that are bookkeeping rather than anything a person wrote about the task. A `source-link:` line is
 * a link to an item elsewhere, which `bin/fm-sources.sh` writes and the drawer shows as its chip and Upstream section.
 */
export const BOOKKEEPING = /^(Captain hold set:|Resolution recorded by|Decision digest:|Resolution mode:|Captain decision:|Reconciliation evidence:|Answer key:|Answered by:|Answered via:|source-link: )/;

/** A run of text, plain or code. */
export type Span = { code: boolean; text: string };

/** One paragraph, led by its label when the filer gave it one; or one list. */
export type BodyBlock = { type: "paragraph"; label: string | null; spans: Span[] } | { type: "list"; items: Span[][] };

/** A leading label in capitals: a word or a few, then a comma or a colon. "PR #11" or "TODO" alone is not one. */
const LABEL = /^([A-Z][A-Z0-9'/-]*(?: [A-Z0-9'/-]+)*)(?=[,:])/;
const ITEM = /^[-*]\s+/;

/** Splits a line at its backticks. An unmatched backtick is kept as text. */
export function spans(text: string): Span[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return text ? [{ code: false, text }] : [];
  return parts.map((part, index) => ({ code: index % 2 === 1, text: part })).filter((part) => part.text !== "");
}

/** The lines a person wrote: trimmed, blank and bookkeeping lines dropped. */
export function writtenLines(lines: string[] | undefined) {
  return (lines ?? []).map((line) => line.trim()).filter((line) => line && !BOOKKEEPING.test(line));
}

/**
 * A body in blocks. A row read without its lines falls back to its excerpt, as one paragraph. An empty or
 * bookkeeping-only body has none.
 */
export function bodyBlocks(lines: string[] | undefined, excerpt?: string | null): BodyBlock[] {
  const written = writtenLines(lines);
  if (written.length === 0 && excerpt && !BOOKKEEPING.test(excerpt)) written.push(excerpt.trim());
  const blocks: BodyBlock[] = [];
  for (const line of written) {
    if (ITEM.test(line)) {
      const item = spans(line.replace(ITEM, ""));
      const last = blocks.at(-1);
      if (last?.type === "list") last.items.push(item);
      else blocks.push({ type: "list", items: [item] });
      continue;
    }
    const label = line.match(LABEL)?.[1] ?? null;
    // One capital word is a label only when it is long enough not to be an acronym ("PR:", "UI:").
    const kept = label && (label.includes(" ") || label.length >= 4) ? label : null;
    // The label keeps its own punctuation after it: "SYMPTOM, reported by the captain: ..." reads as written.
    blocks.push({ type: "paragraph", label: kept, spans: spans(kept ? line.slice(kept.length) : line) });
  }
  return blocks;
}
