// Unit tests for src/calls.ts, the one place every screen reads captain calls from.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { answerInWords, answerOfMessage, callsInChat, callStanding, stillOffered, answeredBy, answeredByCaptain, argumentOf, callsArguedBy, dayAfter, decidedForCaptain, homeCalls, linkLabel, openCalls, optionsUpdatedSince, pageRef, recommended, resolveEvidence } from "../src/calls.ts";

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

test("Not now can name no day earlier than the one after the captain's", () => {
  assert.equal(dayAfter("2026-09-25"), "2026-09-26");
  assert.equal(dayAfter("2026-09-30"), "2026-10-01");
  assert.equal(dayAfter("2026-12-31"), "2027-01-01");
  assert.equal(dayAfter("2028-02-28"), "2028-02-29");
  assert.equal(dayAfter("2026-03-07"), "2026-03-08", "a clock change is still one calendar day");
  assert.equal(dayAfter("2026-09-26T00:11:00Z"), null, "a moment is not a day");
  assert.equal(dayAfter("soon"), null);
  const { calls } = homeCalls({ tasks: [], calls: [call("dated"), call("later")], captain_day: "2026-09-25" }, null, new Map());
  assert.deepEqual(calls.map((each) => each.ask_again_from), ["2026-09-26", "2026-09-26"]);
  const older = homeCalls({ tasks: [], calls: [call("dated")] }, null, new Map());
  assert.equal("ask_again_from" in older.calls[0], false, "a firstmate that names no day sets no earliest day");
});

test("an answer in words is not now until a day, what the captain wrote, or both", () => {
  assert.equal(answerInWords(null, "  Pause, but say why.  "), "Pause, but say why.");
  assert.equal(answerInWords("2026-10-03", ""), "Not now. Ask me again on Oct 3.");
  assert.equal(answerInWords("2026-10-03", "After the launch."), "Not now. Ask me again on Oct 3. After the launch.");
  assert.equal(answerInWords(undefined, "   "), "");
});

test("the chat shows a call raised in the last day, where it was raised, and never one decided for the captain", () => {
  const calls = [
    call("later", { raised_at: ago(1) }),
    call("earlier", { raised_at: ago(20), state: "closed", answer: { key: "k", label: "L", by: "captain", via: "quarterdeck", at: ago(19) } }),
    call("yesterday", { raised_at: ago(25) }),
    call("no-time", { raised_at: null }),
    call("bad-time", { raised_at: "soon" }),
    call("decided", { raised_at: ago(2), state: "closed", decided: { what: "Merged it", why: "Checks passed." } }),
  ];
  assert.deepEqual(callsInChat(calls, NOW).map(({ call: shown, at }) => [shown.id, at]), [["earlier", Date.parse(ago(20))], ["later", Date.parse(ago(1))]]);
});

test("where a call stands is the same wherever it is asked", () => {
  const recorded = call("x", { state: "closed", answer: { key: "keep", label: "Keep merging", by: "captain", via: "lavish", at: ago(1) } });
  assert.deepEqual(callStanding(call("x")), { kind: "open", failed: null });
  assert.deepEqual(callStanding(recorded), { kind: "recorded", label: "Keep merging", via: "lavish" });
  assert.deepEqual(callStanding(call("x", { state: "answered", answer: recorded.answer })), { kind: "recorded", label: "Keep merging", via: "lavish" });
  assert.deepEqual(callStanding(call("x", { state: "closed" })), { kind: "closed" });
  assert.deepEqual(callStanding(call("x", { captain_actionable: false })), { kind: "held" });
  assert.deepEqual(callStanding(call("x"), { answeredIn: "The page" }), { kind: "in-review", page: "The page" });
  // This session's word from the intake comes first: the record catches up on the next snapshot.
  const closed = { label: "Keep merging", result: "closed", detail: "recorded" };
  assert.deepEqual(callStanding(call("x"), { answered: closed }), { kind: "recorded", label: "Keep merging", via: "quarterdeck" });
  const refused = { label: "Keep merging", result: "not_recorded", detail: "fm-captain-hold.sh did not finish within 60s" };
  assert.deepEqual(callStanding(call("x"), { answered: refused }), { kind: "open", failed: refused });
});

test("an answer given before the call was held again does not answer the new ask", () => {
  const first = ago(5);
  const answered = { label: "Keep merging", result: "closed", detail: "recorded", raised: first };
  assert.equal(callStanding(call("x", { raised_at: first }), { answered }).kind, "recorded");
  // Released, then held again: the hold starts a new lifecycle, and raised_at moves on.
  assert.deepEqual(callStanding(call("x", { raised_at: ago(1) }), { answered }), { kind: "open", failed: null });
  assert.deepEqual(callStanding(call("x", { raised_at: ago(1) }), { answered: { ...answered, result: "not_recorded" } }), { kind: "open", failed: null });
});

test("a pick stands only while the call still offers it as the captain saw it", () => {
  const options = [{ key: "wifi", label: "Wi-Fi only" }, { key: "any", label: "Any network" }];
  assert.equal(stillOffered(call("x", { options }), { key: "wifi", label: "Wi-Fi only" }), true);
  assert.equal(stillOffered(call("x", { options }), { key: "first-use", label: "On first use only" }), false, "withdrawn");
  assert.equal(stillOffered(call("x", { options }), { key: "any", label: "Any network, ask first" }), false, "kept, but relabelled");
});

test("the app's own answer messages read back as the answers they are", () => {
  // The same file the Rust tests compare answer_message against, so neither end can drift.
  const fixture = JSON.parse(readFileSync(new URL("../src/fixtures/call-messages.json", import.meta.url), "utf8"));
  for (const sent of fixture.answered) {
    assert.deepEqual(answerOfMessage(sent.text), { kind: "recorded", call: sent.call, key: sent.key, label: sent.label, note: sent.note });
  }
  for (const sent of fixture.replied) {
    assert.deepEqual(answerOfMessage(sent.text), { kind: "replied", call: sent.call, words: sent.words });
  }
});

test("only the app's own lines are answers", () => {
  const calls = [call("res-wifi-drop")];
  assert.deepEqual(answerOfMessage("On the res wifi drop: Not now. Ask me again on Oct 3.", calls), { kind: "replied", call: "res-wifi-drop", words: "Not now. Ask me again on Oct 3." });
  assert.equal(answerOfMessage("On the res other call: yes", calls), null, "a call the home does not carry");
  assert.equal(answerOfMessage("Keep foreman merging, please."), null);
  assert.equal(answerOfMessage("I answered a call from Bearings.\nRecorded: x = y"), null);
  assert.equal(answerOfMessage("The captain answered a call from Bearings.\nnothing recorded"), null);
  assert.equal(answerOfMessage("Recorded: foreman-auto-merge = keep"), null, "only under the app's header");
});
