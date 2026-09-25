// Unit tests for src/calls.ts, the one place every screen reads captain calls from.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerInWords, answeredBy, answeredByCaptain, argumentOf, callsArguedBy, decidedForCaptain, homeCalls, linkLabel, openCalls, optionsUpdatedSince, pageRef, recommended, resolveEvidence } from "../src/calls.ts";

const NOW = Date.parse("2026-09-18T18:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();

function call(id, fields = {}) {
  return { id, title: `Title of ${id}`, question: `Question of ${id}?`, options: [], on_answer: "done", state: "open", captain_actionable: true, evidence: [], answer: null, decided: null, ...fields };
}

function page(scope, task, name, title) {
  const latest = { scope, task, name, rev: 1, title, presented_at: ago(1) };
  return { scope, task, name, title, latest, revisions: [latest] };
}

const board = page("chat", null, "model-download", "When may the app download the speech model?");
const report = page("task", "res-transcripts-scout", "transcripts-report", "Which episodes already carry a transcript?");
const title = (id) => ({ "res-transcripts-scout": "Resonance: transcripts" })[id] ?? id;

test("a page is named the way evidence names it", () => {
  assert.equal(pageRef(board), "page:chat/model-download");
  assert.equal(pageRef(report), "page:task/res-transcripts-scout/transcripts-report");
});

test("one page can argue two calls, and a page argues only what names it", () => {
  const calls = [
    call("res-model-download", { evidence: ["page:chat/model-download"] }),
    call("res-model-cellular", { evidence: ["url:https://example.com/x", "page:chat/model-download"] }),
    call("res-transcripts-source", { evidence: ["page:task/res-transcripts-scout/transcripts-report"] }),
    // A task page and a chat page with the same name are different pages.
    call("res-other", { evidence: ["page:task/someone/model-download"] }),
  ];
  assert.deepEqual(callsArguedBy(calls, board).map((item) => item.id), ["res-model-download", "res-model-cellular"]);
  assert.deepEqual(callsArguedBy(calls, report).map((item) => item.id), ["res-transcripts-source"]);
});

test("evidence resolves to what can be opened, in firstmate's order", () => {
  // Raised before its page existed: the page comes through the origin, derived at read time.
  const raised = call("res-transcripts-source", {
    origin: "res-transcripts-scout",
    evidence: ["url:https://github.com/caomyer/resonance/pull/41", "page:task/res-transcripts-scout/transcripts-report", "report:res-transcripts-scout", "page:chat/gone", "page:chat/model-download", "note:nonsense"],
  });
  const evidence = resolveEvidence(raised, [board, report], title);
  assert.deepEqual(evidence.map((item) => [item.kind, item.title]), [
    ["url", "PR #41"],
    ["page", "Which episodes already carry a transcript?"],
    ["report", "the report on “Resonance: transcripts”"],
    ["page", "When may the app download the speech model?"],
  ]);
  // The argument to read first is the first page, not the link ahead of it.
  assert.equal(argumentOf(evidence).title, "Which episodes already carry a transcript?");
  assert.equal(argumentOf(resolveEvidence(call("x", { evidence: ["report:res-transcripts-scout"] }), [], title)).kind, "report");
  assert.equal(argumentOf([]), undefined);
});

test("open calls are the live holds waiting on the captain", () => {
  const calls = [
    call("open"),
    call("deferred", { captain_actionable: false, bucket: "deferred" }),
    call("closing", { state: "answered" }),
    call("closed", { state: "closed" }),
  ];
  assert.deepEqual(openCalls(calls).map((item) => item.id), ["open"]);
});

test("decided for you is the first mate's answers, newest first", () => {
  const decided = (id, hours) => call(id, { state: "closed", answer: { key: null, label: id, by: "firstmate", via: "firstmate", at: ago(hours) }, decided: { what: `What ${id}`, why: "Because." } });
  const calls = [decided("older", 26), call("mine", { state: "closed", answer: { key: "a", label: "A", by: "captain", via: "chat", at: ago(2) } }), decided("newer", 1)];
  assert.deepEqual(decidedForCaptain(calls).map((item) => item.id), ["newer", "older"]);
});

test("answered calls are the captain's, closed or closing, from the last week", () => {
  const answered = (id, hours, fields = {}) => call(id, { state: "closed", answer: { key: "k", label: "L", by: "captain", via: "quarterdeck", at: ago(hours) }, ...fields });
  const calls = [
    answered("recent", 48),
    answered("closing", 1, { state: "answered" }),
    answered("stale", 24 * 8),
    answered("still-open", 1, { state: "open" }),
    call("by-mate", { state: "closed", answer: { key: null, label: "x", by: "firstmate", via: "firstmate", at: ago(1) } }),
  ];
  assert.deepEqual(answeredByCaptain(calls, NOW).map((item) => item.id), ["recent", "closing"]);
});

test("who answered reads in the captain's words", () => {
  const answer = (by, via) => ({ key: "k", label: "L", by, via, at: ago(1) });
  assert.equal(answeredBy(answer("captain", "chat")), "Answered by you in chat");
  assert.equal(answeredBy(answer("captain", "quarterdeck")), "Answered by you here");
  assert.equal(answeredBy(answer("captain", "lavish")), "Answered by you in Lavish");
  assert.equal(answeredBy(answer("captain", "email")), "Answered by you through email");
  assert.equal(answeredBy(answer("firstmate", "firstmate")), "Answered by the first mate");
});

test("options changed after a page was presented say so", () => {
  assert.equal(optionsUpdatedSince(call("x", { updated_at: ago(0.5) }), ago(1)), true);
  assert.equal(optionsUpdatedSince(call("x", { updated_at: ago(2) }), ago(1)), false);
  assert.equal(optionsUpdatedSince(call("x", { updated_at: null }), ago(1)), false);
  assert.equal(optionsUpdatedSince(call("x", { updated_at: "not a time" }), ago(1)), false);
  // Raised after the page with its options set as it was raised: nothing the page showed changed.
  assert.equal(optionsUpdatedSince(call("x", { raised_at: ago(0.5), updated_at: ago(0.5) }), ago(1)), false);
  // Raised before the page and offered new options after it: they did change.
  assert.equal(optionsUpdatedSince(call("x", { raised_at: ago(3), updated_at: ago(0.5) }), ago(1)), true);
});

test("the recommendation is the option marked so", () => {
  const options = [{ key: "a", label: "A", recommended: false }, { key: "b", label: "B", recommended: true }];
  assert.equal(recommended(call("x", { options })).key, "b");
  assert.equal(recommended(call("x")), undefined);
});

test("a home without calls[] shows Bearings' calls, bare, and nothing else", () => {
  const bearings = { decisions_open: [{ id: "res-model-download", key: "res-model-download", verb: "captain-hold", summary: "", owner: "(main)" }] };
  const records = new Map([["res-model-download", { id: "res-model-download", title: "Resonance: the model", hold_reason: "Only 2 of 9281. Options: a; b." }]]);
  const legacy = homeCalls({ tasks: [] }, bearings, records);
  assert.equal(legacy.legacy, true);
  assert.deepEqual(legacy.calls.map((item) => [item.id, item.title, item.question, item.options.length, item.evidence.length, item.on_answer]), [
    ["res-model-download", "Resonance: the model", "Only 2 of 9281. Options: a; b.", 0, 0, null],
  ]);
  assert.deepEqual(openCalls(legacy.calls).map((item) => item.id), ["res-model-download"]);
  // calls[] is the source of truth whenever it is there, even empty.
  const current = homeCalls({ tasks: [], calls: [] }, bearings, records);
  assert.deepEqual(current, { calls: [], legacy: false });
});

test("a link is named by what it is", () => {
  assert.equal(linkLabel("https://github.com/caomyer/foreman/pull/24"), "PR #24");
  assert.equal(linkLabel("https://www.example.com/doc"), "example.com");
  assert.equal(linkLabel("not a url"), "not a url");
});

test("an answer in words is not now until a day, what the captain wrote, or both", () => {
  assert.equal(answerInWords(null, "  Pause, but say why.  "), "Pause, but say why.");
  assert.equal(answerInWords("2026-10-03", ""), "Not now. Ask me again on Oct 3.");
  assert.equal(answerInWords("2026-10-03", "After the launch."), "Not now. Ask me again on Oct 3. After the launch.");
  assert.equal(answerInWords(undefined, "   "), "");
});
