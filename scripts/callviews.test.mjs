// Unit tests for src/callviews.ts, which works out what a call's two cards in the chat say.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build. Each fixture is a call as
// `bin/fm-captain-hold.sh list --json` reports it, in a state the mocked design (qd-chat-calls-1, states A to K) draws.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerOfMessage, callStanding } from "../src/calls.ts";
import { answerCardView, callCardView, callLine, notNowDay } from "../src/callviews.ts";

const NOW = Date.parse("2026-09-25T13:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const when = (at) => `@${at.slice(11, 16)}`;

const options = [
  { key: "keep", label: "Keep merging once checks pass", recommended: true },
  { key: "hold", label: "Hold every PR for me", recommended: false },
];

/** A call held twenty minutes ago with its options set as it was raised, so raised_at and updated_at agree. */
function call(fields = {}) {
  return {
    id: "foreman-auto-merge", title: "Keep merging its own PRs while you are away?", question: "Should foreman keep merging its own PRs while you are away this week?",
    options, on_answer: "done", state: "open", captain_actionable: true, evidence: [], raised_at: ago(20), updated_at: ago(20), answer: null, decided: null, ...fields,
  };
}

const recordedAnswer = { key: "keep", label: "Keep merging once checks pass", by: "captain", via: "quarterdeck", at: ago(10) };
const view = (item, fields = {}) => callCardView(item, { project: "foreman", reply: null, earlier: null, askedBefore: false, withdrawn: null, when, ...fields });

test("A: an open call leads with where it was raised, and nothing else to say", () => {
  assert.equal(callLine(call(), callStanding(call())), null, "open is the whole card, not a line");
  assert.deepEqual(view(call()), { kicker: ["foreman", `raised ${when(ago(20))}`], replied: false, optionsChanged: null, withdrawn: null, earlier: null });
});

test("D: an answer on the record shrinks the card to the choice, with the pick marked among the options", () => {
  const answered = call({ state: "closed", captain_actionable: false, answer: recordedAnswer });
  assert.deepEqual(callLine(answered, callStanding(answered)), { kind: "recorded", tone: "green", detail: "you chose Keep merging once checks pass", pill: "recorded", page: null, pick: "keep" });
  // This session's own answer is on the card before the record catches up, and the line says the same.
  const closing = { label: "Keep merging once checks pass", result: "closed", detail: "recorded", raised: ago(20) };
  assert.deepEqual(callLine(call(), callStanding(call(), { answered: closing })), callLine(answered, callStanding(answered)));
});

test("E: a reply nothing has recorded folds the form, and says nothing it did not say", () => {
  const reply = { words: "Pause it, and tell the user why.", at: ago(2) };
  assert.equal(view(call(), { reply }).replied, true);
  assert.equal(callLine(call(), callStanding(call())), null, "a reply leaves the call open: it is not answered");
});

test("F: answered in a review, the line names the page", () => {
  assert.deepEqual(callLine(call(), callStanding(call(), { answeredIn: "Which episodes already carry a transcript?" })), { kind: "in-review", tone: "green", detail: "answered in your review of", pill: null, page: "Which episodes already carry a transcript?", pick: null });
});

test("G: a held call says the day he named, and never guesses one", () => {
  const held = call({ captain_actionable: false });
  assert.equal(callLine(held, callStanding(held), { words: "Not now. Ask me again on Oct 3. Battery numbers first.", at: ago(5) }).detail, "not now, ask again Oct 3");
  assert.equal(callLine(held, callStanding(held)).detail, "not now, held");
  assert.equal(callLine(held, callStanding(held)).tone, "amber");
  // The day comes: the record asks again with the same raised_at, and the card opens in place saying so.
  const back = view(call(), { earlier: { words: "Not now. Ask me again on Oct 3.", at: "2026-09-25T12:58:00Z" } });
  assert.deepEqual(back.kicker, ["foreman", `raised ${when(ago(20))}`, "your day has come"]);
  assert.equal(back.earlier, "On Sep 25 you said: Not now. Ask me again on Oct 3.");
  // A reply standing now is what he said last; the earlier words give way to it.
  assert.equal(view(call(), { earlier: { words: "Not now. Ask me again on Oct 3.", at: null }, reply: { words: "Hold them.", at: ago(1) } }).earlier, null);
  assert.equal(notNowDay("Pause it."), null);
});

test("H: a call asked again after an answer says so on both cards", () => {
  assert.deepEqual(view(call(), { askedBefore: true }).kicker, ["foreman", `raised ${when(ago(20))}`, "asked before"]);
});

test("I: options offered after the call was raised are called out; a hold that sets them as it raises is not", () => {
  // `offer` moves updated_at alone.
  assert.equal(view(call({ updated_at: ago(3) })).optionsChanged, when(ago(3)));
  // A hold after release moves raised_at, and moves updated_at with it when it sets options.
  assert.equal(view(call({ raised_at: ago(3), updated_at: ago(3) })).optionsChanged, null);
  assert.equal(view(call({ updated_at: null })).optionsChanged, null);
  assert.equal(view(call(), { withdrawn: "On first use only" }).withdrawn, "On first use only");
});

test("closed without an answer from the captain is a muted line", () => {
  const closed = call({ state: "closed", captain_actionable: false });
  assert.deepEqual(callLine(closed, callStanding(closed)), { kind: "closed", tone: "muted", detail: "closed without an answer from you", pill: "closed", page: null, pick: null });
});

const RECORDED_TEXT = "The captain answered a call from Bearings.\nAnswers already recorded with bin/fm-captain-hold.sh; do the follow-up each one calls for, and do not record them again:\nRecorded: foreman-auto-merge = keep (\"Keep merging once checks pass\")\nThe captain added: Revisit when I'm back on Monday.";
const recorded = answerOfMessage(RECORDED_TEXT);
const replied = { kind: "replied", call: "foreman-auto-merge", words: "Pause it, and tell the user why." };
const answerView = (answer, item, fields = {}) => answerCardView(answer, item, { reply: null, said: Date.parse(ago(10)), past: false, delivery: null, from: null, ...fields });

test("D: a recorded answer is green, with what he added and how far it has got", () => {
  const closed = call({ state: "closed", captain_actionable: false, answer: recordedAnswer });
  assert.deepEqual(answerView(recorded, closed, { delivery: "read by the first mate 12:49 PM", from: "chat" }), {
    kind: "recorded", line: false, kicker: "Your answer · in chat", title: "Keep merging its own PRs while you are away?", said: "Keep merging once checks pass",
    note: "Revisit when I'm back on Monday.", tone: "green", status: "Recorded · read by the first mate 12:49 PM", askedAgain: false,
  });
  assert.equal(answerView(recorded, closed, { from: "bearings" }).kicker, "Your answer · from Bearings");
});

test("E: words the call still carries are amber, never green, however far the message has got", () => {
  const reply = { words: replied.words, at: ago(10) };
  const shown = answerView(replied, call(), { reply, delivery: "read by the first mate 12:59 PM" });
  assert.equal(shown.tone, "amber");
  assert.equal(shown.status, "With the first mate · not recorded yet");
  assert.equal(shown.kicker, "Your answer · in words");
  // Only a record turns it green, and then it says what was recorded.
  const done = call({ state: "closed", captain_actionable: false, answer: { ...recordedAnswer, key: "hold", label: "Hold every PR for me" } });
  assert.deepEqual([answerView(replied, done).tone, answerView(replied, done).status], ["green", "Recorded: Hold every PR for me"]);
  // A newer reply replaced these words: they are not what the call carries, so they are not with the first mate.
  assert.equal(answerView(replied, call(), { reply: { words: "Hold them.", at: ago(1) } }).status, "Not recorded · the first mate asked again");
  // Held until a day, the first mate acted on them without recording an answer.
  assert.deepEqual([answerView(replied, call({ captain_actionable: false })).tone, answerView(replied, call({ captain_actionable: false })).status], ["amber", "Held: not now"]);
});

test("H: a call held again after the answer points down to where it was asked anew, and keeps its own choice", () => {
  const reasked = call({ raised_at: ago(3), updated_at: ago(3) });
  const shown = answerView(recorded, reasked, { delivery: "read by the first mate 12:49 PM" });
  assert.equal(shown.askedAgain, true);
  assert.equal(shown.said, "Keep merging once checks pass", "from the app's own line, not the call's new record");
  assert.equal(shown.status, "Recorded");
  // Replayed with no time after a relaunch, a recorded answer whose call is open again was asked anew.
  assert.equal(answerView(recorded, call(), { past: true, said: Infinity }).askedAgain, true);
  assert.equal(answerView(recorded, call({ state: "closed", answer: recordedAnswer }), { past: true, said: Infinity }).askedAgain, false);
});

test("K: an answer whose call has left the snapshot is one line from the app's own words", () => {
  const shown = answerView(recorded, undefined, { past: true, said: Infinity });
  assert.deepEqual([shown.line, shown.title, shown.said], [true, "foreman-auto-merge", "Keep merging once checks pass"]);
  assert.deepEqual([answerView(replied, undefined).tone, answerView(replied, undefined).status], ["muted", "The call has closed"]);
});
