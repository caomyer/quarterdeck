/**
 * Files the captain attaches to a message, and how a message carries them.
 *
 * A message is words and nothing else: the host's durable outbox, the re-send after a restart and a resumed
 * session's history all carry text. So the host copies each attached file into the home when the message is sent
 * (`src-tauri/src/attach.rs`), and the message ends with a block naming each copy's path for the first mate to
 * read. This module is the one place that writes that block and the one place that reads it back, so a message
 * shows its files the same way live, after a relaunch, and in a resumed session's history.
 */

/** A file the captain picked for the message being written: checked, and not copied until the message is sent. */
export type PickedFile = { name: string; source: string; bytes: number };
/** A file copied into the home: `path` is the copy, `source` where the captain picked it from. */
export type Attachment = { name: string; path: string; source: string; bytes: number };
/** A file that could not be attached, and why, in words for the captain. */
export type AttachRefusal = { source: string; problem: string };
/** What picking found: `null` from the adapter instead when the captain cancelled the picker. */
export type PickResult = { picked: PickedFile[]; refused: AttachRefusal[] };
/** What copying a message's files did: every file in `attached`, or none there and `refused` saying why. */
export type CopyResult = { attached: Attachment[]; refused: AttachRefusal[] };
/** A file as a sent message names it: what can be read back from the words alone. */
export type AttachedFile = { name: string; path: string; size: string | null };

export const ATTACHED_HEADING = "Attached files (copied into this home; read them at these paths):";

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Inline code that survives backticks inside it: a longer fence, padded, as Markdown reads it. */
function code(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function fileLine(file: Attachment) {
  return `- ${code(file.path)} (${formatBytes(file.bytes)}, from ${code(file.source)})`;
}

/** The message as it is sent: the captain's words, then one line per file. */
export function withAttachments(text: string, files: Attachment[]) {
  const words = text.trim();
  if (files.length === 0) return words;
  const block = [ATTACHED_HEADING, ...files.map(fileLine)].join("\n");
  return words ? `${words}\n\n${block}` : block;
}

const LINE = /^- (`+)(.*?)\1(?: \((.*)\))?$/;

function baseName(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * Splits a sent message into the captain's words and the files it names. Only a block this module wrote counts:
 * the heading on a line of its own, at the start or after a blank line, and nothing after it but file lines.
 */
export function splitAttachments(message: string): { text: string; files: AttachedFile[] } {
  const lines = message.split("\n");
  const at = lines.lastIndexOf(ATTACHED_HEADING);
  if (at < 0 || (at > 0 && lines[at - 1] !== "")) return { text: message, files: [] };
  const files: AttachedFile[] = [];
  for (const line of lines.slice(at + 1)) {
    const match = LINE.exec(line);
    if (!match) return { text: message, files: [] };
    const fenced = match[1].length > 1 ? match[2].replace(/^ (.*) $/, "$1") : match[2];
    files.push({ name: baseName(fenced), path: fenced, size: match[3]?.split(", from ")[0] ?? null });
  }
  if (files.length === 0) return { text: message, files: [] };
  return { text: lines.slice(0, Math.max(0, at - 1)).join("\n"), files };
}
