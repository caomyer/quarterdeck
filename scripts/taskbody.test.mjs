// Unit tests for src/taskbody.ts, how a backlog row's body is read the way its filer wrote it.
//
//   pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyBlocks, spans } from "../src/taskbody.ts";

const plain = (text) => [{ code: false, text }];

test("each line a filer wrote stays its own paragraph", () => {
  assert.deepEqual(bodyBlocks(["First thought.", "Second thought."]), [
    { type: "paragraph", label: null, spans: plain("First thought.") },
    { type: "paragraph", label: null, spans: plain("Second thought.") },
  ]);
});

test("consecutive dash lines are one list, and a paragraph between starts a new one", () => {
  const blocks = bodyBlocks(["- one", "* two", "Then:", "- three"]);
  assert.deepEqual(blocks.map((block) => block.type), ["list", "paragraph", "list"]);
  assert.deepEqual(blocks[0].items, [plain("one"), plain("two")]);
  assert.deepEqual(blocks[2].items, [plain("three")]);
});

test("a leading label in capitals is kept apart, with its own punctuation after it", () => {
  const [symptom, fix, mechanism] = bodyBlocks([
    "SYMPTOM, reported by the captain 2026-09-24: cards jumped.",
    "WHAT TO FIX: never below a newer message.",
    "MECHANISM, src/App.tsx chatItems() (:1509-1543):",
  ]);
  assert.equal(symptom.label, "SYMPTOM");
  assert.deepEqual(symptom.spans, plain(", reported by the captain 2026-09-24: cards jumped."));
  assert.equal(fix.label, "WHAT TO FIX");
  assert.deepEqual(fix.spans, plain(": never below a newer message."));
  assert.equal(mechanism.label, "MECHANISM");
});

test("an acronym or a sentence is not a label", () => {
  for (const line of ["PR: https://github.com/o/r/pull/1", "UI, then engine.", "App-side. Verify in both themes.", "NOTE THE OVERLAP PR #11 adds cards"]) {
    assert.equal(bodyBlocks([line])[0].label, null, line);
  }
});

test("backticks are code, and an unmatched one is left as text", () => {
  assert.deepEqual(spans("call `pushPages()` last"), [{ code: false, text: "call " }, { code: true, text: "pushPages()" }, { code: false, text: " last" }]);
  assert.deepEqual(spans("a stray ` tick"), plain("a stray ` tick"));
  assert.deepEqual(spans(""), []);
});

test("bookkeeping, blank lines and indentation never reach the reader", () => {
  const blocks = bodyBlocks(["Captain hold set: 2026-09-14T09:12:00Z", "Resolution recorded by fm-captain-hold.", "", "   Captain decision:", "  Wi-Fi only."]);
  assert.deepEqual(blocks, [{ type: "paragraph", label: null, spans: plain("Wi-Fi only.") }]);
});

test("a row read without its lines falls back to its excerpt, unless that is bookkeeping too", () => {
  assert.deepEqual(bodyBlocks([], "Only the excerpt."), [{ type: "paragraph", label: null, spans: plain("Only the excerpt.") }]);
  assert.deepEqual(bodyBlocks(undefined, "Resolution recorded by fm-captain-hold."), []);
  assert.deepEqual(bodyBlocks(["Written."], "Excerpt."), [{ type: "paragraph", label: null, spans: plain("Written.") }]);
});

test("a link to an item elsewhere is bookkeeping: the drawer shows it as its chip, never as something the filer wrote", () => {
  assert.deepEqual(bodyBlocks(["Keep this line.", "source-link: github:o/r I_kwDO17 fulfills"]), [{ type: "paragraph", label: null, spans: plain("Keep this line.") }]);
  assert.deepEqual(bodyBlocks(["source-link: fixture:w 10001 contributes"], "source-link: fixture:w 10001 contributes"), []);
});
