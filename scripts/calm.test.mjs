// Unit tests for src/calm.ts, what Calm hides in the app's chat: the steps, and the first mate's working notes.
//
//   pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { calmHidden, elapsed, KEPT_AT, readsAsNote } from "../src/calm.ts";

const said = (id, who, text = id) => ({ id, who, text });

test("a note shows while it streams, and folds once a step follows it", () => {
  const streaming = [said("q", "captain"), said("n1", "mate", "Let me check CI and the")];
  assert.deepEqual([...calmHidden(streaming)], [], "text still streaming is never hidden");
  const stepped = [...streaming, said("s1", "step"), said("s2", "step")];
  assert.deepEqual([...calmHidden(stepped)].sort(), ["n1", "s1", "s2"]);
});

test("the reply that ends a turn stays, and so does everything the captain said", () => {
  const turn = [
    said("q", "captain", "Is the release branch green?"),
    said("n1", "mate", "Let me check CI and the open PRs first."),
    said("s1", "step"),
    said("n2", "mate", "Two runs are still going; waiting on the Bundle job."),
    said("s2", "step"),
    said("r", "mate", "Yes. Both runs on release/0.9 passed, and nothing is waiting on you."),
    said("q2", "captain", "Thanks"),
  ];
  assert.deepEqual([...calmHidden(turn)].sort(), ["n1", "n2", "s1", "s2"]);
});

test("a note with a line break, or as long as a reply, stays as a reply would", () => {
  assert.equal(readsAsNote("One line of narration."), true);
  assert.equal(readsAsNote("Here is the plan:\n- one\n- two"), false);
  assert.equal(readsAsNote("x".repeat(KEPT_AT)), false);
  assert.equal(readsAsNote("x".repeat(KEPT_AT - 1)), true);
  const turn = [said("q", "captain"), said("plan", "mate", "Plan:\n1. read\n2. fix"), said("s1", "step")];
  assert.deepEqual([...calmHidden(turn)], ["s1"]);
});

test("a step never makes a note of words from before the captain spoke", () => {
  const turns = [said("r1", "mate", "Done."), said("q", "captain", "Next?"), said("s1", "step")];
  assert.deepEqual([...calmHidden(turns)], ["s1"]);
  const afterNotice = [said("r1", "mate", "Done."), said("fresh", "notice"), said("s1", "step")];
  assert.deepEqual([...calmHidden(afterNotice)], ["s1"]);
});

test("a turn's reply stays when the next turn begins with a step and no captain message", () => {
  const live = (id, who, turn, text = id) => ({ id, who, text, turn });
  const turns = [
    said("q", "captain", "Anything waiting?"),
    live("n1", "mate", 1, "Let me look."),
    live("s1", "step", 1),
    live("r1", "mate", 1, "Merged PR 41; nothing waiting on you."),
    live("s2", "step", 2),
    live("n2", "mate", 2, "Checking the crew."),
    live("s3", "step", 2),
    live("r2", "mate", 2, "Crew is idle."),
    live("s4", "step", 3),
  ];
  assert.deepEqual([...calmHidden(turns)].sort(), ["n1", "n2", "s1", "s2", "s3", "s4"]);
});

test("the working row's elapsed time", () => {
  assert.equal(elapsed(2_400), "0:02");
  assert.equal(elapsed(72_000), "1:12");
  assert.equal(elapsed(3_723_000), "1:02:03");
  assert.equal(elapsed(-5), "0:00");
});
