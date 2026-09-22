// Unit tests for src/attachments.ts, the one place a message's attached files are written into its words and read
// back out of them.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTACHED_HEADING, formatBytes, splitAttachments, withAttachments } from "../src/attachments.ts";

const HOME = "/Users/captain/firstmate/data/.attachments";
const file = (name, fields = {}) => ({ name, path: `${HOME}/1-1/${name}`, source: `/Users/captain/Downloads/${name}`, bytes: 2048, ...fields });

test("a message with no files is just the words", () => {
  assert.equal(withAttachments("  hello  ", []), "hello");
  assert.deepEqual(splitAttachments("hello"), { text: "hello", files: [] });
});

test("each file goes on its own line after the words, naming the copy and where it came from", () => {
  const sent = withAttachments("Look at this", [file("brief.md")]);
  assert.equal(sent, `Look at this\n\n${ATTACHED_HEADING}\n- \`${HOME}/1-1/brief.md\` (2.0 KB, from \`/Users/captain/Downloads/brief.md\`)`);
});

test("what was sent reads back as the same words and files", () => {
  const files = [file("Résumé final 日本 v2.pdf", { bytes: 3_500_000 }), file("notes with spaces.txt", { bytes: 12 })];
  const sent = withAttachments("Two files.\n\nSecond paragraph.", files);
  const read = splitAttachments(sent);
  assert.equal(read.text, "Two files.\n\nSecond paragraph.");
  assert.deepEqual(read.files, [
    { name: "Résumé final 日本 v2.pdf", path: `${HOME}/1-1/Résumé final 日本 v2.pdf`, size: "3.3 MB" },
    { name: "notes with spaces.txt", path: `${HOME}/1-1/notes with spaces.txt`, size: "12 B" },
  ]);
});

test("files can go without any words", () => {
  const sent = withAttachments("   ", [file("a.png")]);
  assert.ok(sent.startsWith(ATTACHED_HEADING));
  assert.deepEqual(splitAttachments(sent), { text: "", files: [{ name: "a.png", path: `${HOME}/1-1/a.png`, size: "2.0 KB" }] });
});

test("a backtick in a path is fenced, and still reads back", () => {
  const odd = { name: "x.txt", path: "/home/we`ird/x.txt", source: "/src/``two``/x.txt", bytes: 1 };
  const sent = withAttachments("", [odd]);
  assert.ok(sent.includes("- `` /home/we`ird/x.txt `` (1 B, from ``` /src/``two``/x.txt ```)"), sent);
  assert.deepEqual(splitAttachments(sent).files, [{ name: "x.txt", path: "/home/we`ird/x.txt", size: "1 B" }]);
});

test("words that only look like the block are left alone", () => {
  // The heading mid-paragraph, or followed by anything that is not a file line, is the captain's own words.
  const quoted = `I typed this:\n${ATTACHED_HEADING}\n- \`/a\` (1 B, from \`/b\`)`;
  assert.deepEqual(splitAttachments(quoted), { text: quoted, files: [] });
  const trailing = `${ATTACHED_HEADING}\n- \`/a\` (1 B, from \`/b\`)\nand then more words`;
  assert.deepEqual(splitAttachments(trailing), { text: trailing, files: [] });
  assert.deepEqual(splitAttachments(ATTACHED_HEADING), { text: ATTACHED_HEADING, files: [] });
});

test("sizes read the way a captain says them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(150 * 1024), "150 KB");
  assert.equal(formatBytes(100 * 1024 * 1024), "100 MB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GB");
});
