// Unit tests for src/replyto.ts, the one place a reply to a place in the chat is written into a message's words, read
// back out of them, and found again on screen.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build. Times are said on the captain's
// clock, so the tests run on one.
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { splitAttachments, withAttachments } from "../src/attachments.ts";
import {
  chipState, clock, commandOf, findPlace, knownThings, mateReplyOf, REPLY_HEADING, REPLY_RULE, replyBlock, resolve, splitReply, thingsNamed, withReply,
} from "../src/replyto.ts";

const fixture = JSON.parse(readFileSync(new URL("../src/fixtures/reply-block.json", import.meta.url), "utf8"));
const documented = fixture.cases.find((item) => item.name === "documented");

const VIS = { kind: "task", id: "qd-nm-vis-build-1", title: "Pipeline status per task: who it waits on", state: "in flight", pr: "https://github.com/caomyer/quarterdeck/pull/32" };
const SESSIONS = { kind: "task", id: "qd-sessionctl-build-1", title: "Model and effort in the composer", state: "in flight", pr: "https://github.com/caomyer/quarterdeck/pull/26" };
const APPROVE = { kind: "call", id: "qd-approve-flow-1", title: "How far to fix the approval loop", state: "open", pr: null };
const PAGE = { kind: "page", id: "task/qd-chat-reply-1/chat-reply", title: "Reply in chat: point at a place", state: "rev 1", pr: null };
const REPORT = { kind: "page", id: "task/qd-deterministic-1/report", title: "Where firstmate does a tool's job", state: "rev 2", pr: null };
const KNOWN = [VIS, SESSIONS, APPROVE, PAGE, REPORT];

test("each documented block is exactly what the app writes from what it captured", () => {
  for (const item of fixture.cases) {
    const written = withReply(item.words, replyBlock(item.draft, item.fleet, Date.parse(item.now)));
    assert.equal(written, item.text, item.name);
  }
});

test("the first mate's guidance shows it the block word for word", () => {
  const guidance = readFileSync(new URL("../engine/docs/quarterdeck-replies.md", import.meta.url), "utf8");
  assert.ok(guidance.includes(documented.text), "engine/docs/quarterdeck-replies.md no longer carries the documented reply block as the app writes it");
});

test("every block reads back as the place, the things and the captain's words, untouched", () => {
  for (const item of fixture.cases) {
    const read = splitReply(item.text);
    assert.ok(read, item.name);
    assert.equal(read.words, item.words, item.name);
    assert.equal(read.reply.owner.kind, item.draft.place.owner.kind, item.name);
    assert.equal(read.reply.selected, item.draft.place.selected, item.name);
  }
  const { reply } = splitReply(documented.text);
  assert.equal(reply.quote, "Doing well - it's on the last step.");
  assert.equal(reply.meant, null);
  assert.deepEqual(reply.named.map((thing) => [thing.kind, thing.id, thing.state, thing.pr]), [["task", "qd-nm-vis-build-1", "in flight", "https://github.com/caomyer/quarterdeck/pull/32"]]);
  assert.equal(reply.readAt, "22:07");
  assert.deepEqual(reply.around.before, null, "the start of the message is said as such, not quoted");
});

test("meant is only the captain's pick or a card; a thing that is the only one named stays named", () => {
  const picked = splitReply(fixture.cases.find((item) => item.name === "picked").text).reply;
  assert.equal(picked.meant.id, "qd-approve-flow-1");
  assert.equal(picked.meant.why, "the captain picked it");
  assert.deepEqual(picked.named, []);
  const several = splitReply(fixture.cases.find((item) => item.name === "several").text).reply;
  assert.equal(several.meant, null, "with nothing picked, nothing is meant");
  assert.deepEqual(several.named.map((thing) => thing.id), ["nm-rebase-guard-1", "qd-deterministic-1"]);
  assert.ok(several.named.every((thing) => /one of 2 things it names; not picked$/.test(thing.why)));
  const card = splitReply(fixture.cases.find((item) => item.name === "card").text).reply;
  assert.equal(card.meant.why, "a card is the thing itself");
  assert.equal(card.around, null);
  const only = splitReply(documented.text).reply;
  assert.equal(only.meant, null, "one thing found is still not a thing picked");
  assert.match(only.named[0].why, /the only thing it names; not picked$/);
});

test("a fleet that could not be read is said, and nothing is named from it", () => {
  const unread = splitReply(fixture.cases.find((item) => item.name === "unread").text).reply;
  assert.equal(unread.unread, "the fleet snapshot failed at 22:03 (fm-fleet-snapshot.sh exited 1)");
  assert.deepEqual(unread.named, []);
  assert.equal(unread.readAt, null);
  assert.ok(unread.quote.startsWith("nm-rebase-guard-1"), "the quote still goes");
});

test("a long quote is cut at 240 characters and says so", () => {
  const item = fixture.cases.find((entry) => entry.name === "cut");
  assert.match(item.text, /\(cut at 240 of 344 characters\)/);
  const { reply } = splitReply(item.text);
  assert.equal(reply.quote.length, 240);
  assert.equal(reply.cutFrom, 344);
});

test("a block the app did not write, or one cut short, is refused whole", () => {
  const text = documented.text;
  const lines = text.split("\n");
  const refused = {
    "no rule": lines.filter((line) => line !== REPLY_RULE).join("\n"),
    "cut short": text.slice(0, text.indexOf("\nnamed")),
    "heading not first": `hello\n${text}`,
    "unknown key": text.replace("read at   ", "seen at   "),
    "key padded wrong": text.replace("quote     ", "quote "),
    "two on lines": text.replace("\nquote", `\n${lines[1]}\nquote`),
    "quote not quoted": text.replace('"Doing well - it\'s on the last step."', "Doing well"),
    "a thing line it does not write": text.replace("named     task", "named     crew"),
    "an owner it does not write": text.replace("on        your message", "on        a message"),
    "around on a card": fixture.cases.find((item) => item.name === "card").text.replace("\nmeant", '\naround    (start of your message) ▸here◂ "x"\nmeant'),
    "no around on a message": text.split("\n").filter((line) => !line.startsWith("around")).join("\n"),
    "named after could not be read": fixture.cases.find((item) => item.name === "unread").text.replace("\n──", `\nnamed     task x · queued\n──`),
  };
  for (const [why, message] of Object.entries(refused)) assert.equal(splitReply(message), null, why);
  assert.equal(splitReply("then why i saw it was on paused state?"), null);
  assert.equal(splitReply(REPLY_HEADING), null);
});

test("the reply goes first, the words in the middle and the files last, and each reads back", () => {
  const files = [{ name: "trace.txt", path: "/home/data/.attachments/1-1/trace.txt", source: "/Users/captain/trace.txt", bytes: 12 }];
  const block = replyBlock(documented.draft, documented.fleet, Date.parse(documented.now));
  const sent = withReply(withAttachments("is this the trace?", files), block);
  assert.ok(sent.startsWith(REPLY_HEADING));
  const read = splitReply(sent);
  assert.ok(read);
  const said = splitAttachments(read.words);
  assert.equal(said.text, "is this the trace?");
  assert.equal(said.files[0].name, "trace.txt");
  assert.equal(withReply("plain", null), "plain");
});

test("things come from the quote first, then the message, and only by exact match", () => {
  assert.deepEqual(thingsNamed("Doing well - it's on the last step.", "**Doing well.**\n\nPR #32 is open.", KNOWN).map((thing) => [thing.id, thing.token, thing.where]), [["qd-nm-vis-build-1", "PR #32", "message"]]);
  assert.deepEqual(thingsNamed("qd-approve-flow-1 is overtaken", "and PR #32 too", KNOWN).map((thing) => [thing.id, thing.where]), [["qd-approve-flow-1", "quote"]], "the message is read only when the quote names nothing");
  assert.deepEqual(thingsNamed("still have a decision call waiting on pr 26", "", KNOWN).map((thing) => thing.id), ["qd-sessionctl-build-1"]);
  assert.deepEqual(thingsNamed("see https://github.com/caomyer/quarterdeck/pull/32 and #26", "", KNOWN).map((thing) => thing.id), ["qd-nm-vis-build-1", "qd-sessionctl-build-1"]);
  assert.deepEqual(thingsNamed("the chat-reply page, and Where firstmate does a tool's job", "", KNOWN).map((thing) => thing.id), ["task/qd-chat-reply-1/chat-reply", "task/qd-deterministic-1/report"]);
});

test("selected words that name nothing look next in the block they are in, and the block says so", () => {
  const item = "qd-approve-flow-1 - how far to fix the approval loop. Partly overtaken by events, and PR #32 too.";
  const message = `nm-rebase-guard-1 first. ${item} Then #26.`;
  assert.deepEqual(thingsNamed("Partly overtaken by events", message, KNOWN, item).map((thing) => [thing.id, thing.where]), [["qd-approve-flow-1", "block"], ["qd-nm-vis-build-1", "block"]]);
  assert.deepEqual(thingsNamed("Partly overtaken by events", message, KNOWN, "Partly overtaken by events").map((thing) => [thing.id, thing.where]), [["qd-approve-flow-1", "message"], ["qd-nm-vis-build-1", "message"], ["qd-sessionctl-build-1", "message"]], "a block naming nothing falls through to the message");
  const draft = { place: { ...fixture.cases.find((entry) => entry.name === "picked").draft.place }, picked: null };
  const block = replyBlock(draft, { read: { at: documented.now, things: KNOWN } }, Date.parse(documented.now));
  assert.match(block, /^named {5}call qd-approve-flow-1 .* {2}\(named in the item the quote is in, not in the quote: "qd-approve-flow-1"; the only thing it names; not picked\)$/m);
});

test("a word the snapshot does not know is never a thing", () => {
  assert.deepEqual(thingsNamed("fm/overnight-collab already builds the full option", "", KNOWN), []);
  assert.deepEqual(thingsNamed("qd-nm-vis-build-12 and xqd-nm-vis-build-1 and fm/qd-nm-vis-build-1", "", KNOWN), [], "an id inside a longer word or a branch is not the id");
  assert.deepEqual(thingsNamed("the report says so, and #3 is next", "", KNOWN), [], "a page named with a plain word, or a PR no task carries, names nothing");
  assert.deepEqual(thingsNamed("the gate fix and the crew", "", KNOWN), [], "descriptions are never matched");
});

test("a tap on a found thing makes it meant, and a tap on anything else does nothing", () => {
  const draft = { place: { ...documented.draft.place }, picked: "task:qd-nm-vis-build-1" };
  const fleet = { read: { at: documented.now, things: KNOWN } };
  assert.equal(resolve(draft, fleet).meant.thing.id, "qd-nm-vis-build-1");
  assert.equal(resolve({ ...draft, picked: "call:qd-approve-flow-1" }, fleet).meant, null);
  assert.equal(resolve({ ...draft, picked: null }, fleet).meant, null);
});

test("the snapshot's rows read as the block says them", () => {
  const fleet = {
    tasks: [],
    backlog: { records: [
      { id: "a-1", title: "A", state: "in_flight", pr_url: "https://x/pull/1", completion: { verb: null, date: null } },
      { id: "b-1", title: "B", state: "done", completion: { verb: "merged", date: "2026-10-01" } },
      { id: "c-1", title: "C", state: "queued" },
      { id: "call-1", title: "Call row", state: "in_flight" },
    ] },
    calls: [
      { id: "call-1", title: "Open call", state: "open", options: [{ key: "yes", label: "Yes", recommended: true }], answer: null, decided: null },
      { id: "call-2", title: "Recorded call", state: "closed", options: [], answer: { key: "no", label: "No", by: "captain", via: "quarterdeck", at: "" }, decided: null },
    ],
    artifacts: [{ scope: "chat", task: null, name: "nm-flow", title: "How no-mistakes carries a change", latest: { rev: 3 }, revisions: [] }],
  };
  assert.deepEqual(knownThings(fleet).map((thing) => `${thing.kind} ${thing.id} · ${thing.state}`), [
    "task a-1 · in flight", "task b-1 · merged", "task c-1 · queued", "call call-1 · open · recommended yes", "call call-2 · recorded = no", "page chat/nm-flow · rev 3",
  ]);
});

test("a sent reply's place is found by its words, latest first, and never by a near miss", () => {
  const { reply } = splitReply(documented.text);
  const text = "Doing well - it's on the last step. Eight of nine pipeline steps are complete on the merged head: intent, rebase, review, test, document, lint, push, pr.";
  const messages = [
    { id: "older", who: "mate", text },
    { id: "captain", who: "captain", text },
    { id: "newer", who: "mate", text },
  ];
  assert.deepEqual(findPlace(reply, messages), { id: "newer", start: 0, end: 35 });
  assert.equal(findPlace(reply, [{ id: "moved", who: "mate", text: `Update: ${text}` }]), null, "the quote not at its message's start is another place");
  assert.equal(findPlace(reply, [{ id: "other", who: "mate", text: "Doing well - it's on the last step. Something else entirely." }]), null, "the same words with other words around them are not the place");
  assert.equal(findPlace(reply, [{ id: "captain", who: "captain", text }]), null, "only the speaker the block names");
  assert.equal(findPlace(reply, []), null);
  const spanned = splitReply(fixture.cases.find((item) => item.name === "picked").text).reply;
  const three = fixture.cases.find((item) => item.name === "picked").draft.place;
  const drawn = `${three.around.before} ${three.quote}${three.around.after}`;
  const found = findPlace(spanned, [{ id: "three", who: "mate", text: drawn }]);
  assert.equal(drawn.slice(found.start, found.end), three.quote);
  const cut = fixture.cases.find((item) => item.name === "cut");
  const long = splitReply(cut.text).reply;
  assert.deepEqual(findPlace(long, [{ id: "mine", who: "captain", text: cut.draft.place.quote }]), { id: "mine", start: 0, end: 344 });
  assert.equal(findPlace(long, [{ id: "mine", who: "captain", text: cut.draft.place.quote.slice(0, 300) }]), null);
});

test("the first mate's quote line is a reply only on a word-for-word match, the latest", () => {
  const captains = [
    { id: "c1", words: "How’s pr 26 doing" },
    { id: "c2", words: "still have a decision call waiting on pr 26, is that expected? or blocking any work of the worker?" },
  ];
  assert.deepEqual(mateReplyOf('↩ "still have a decision call waiting on pr 26, is that expected?"\n**Expected, and it blocks nothing.**', captains), { quote: "still have a decision call waiting on pr 26, is that expected?", message: "c2", words: "**Expected, and it blocks nothing.**" });
  assert.equal(mateReplyOf('↩ "How’s pr 26 doing"\nReview is clean.', captains).message, "c1");
  assert.equal(mateReplyOf('↩ "pr 26"\nBoth.', captains).message, "c2", "several match: the latest");
  assert.equal(mateReplyOf('↩ "How is pr 26 doing"\nReview is clean.', captains), null, "close is not the same words");
  assert.equal(mateReplyOf('↩ "still have a decision call…"\nx', captains), null);
  assert.equal(mateReplyOf('Review is clean.\n↩ "How’s pr 26 doing"', captains), null, "only as the first line");
  assert.equal(mateReplyOf('↩ "How’s pr 26 doing"\nx', []), null);
});

test("a slash command cannot carry a reply", () => {
  assert.equal(commandOf("/compact", null), "/compact");
  assert.equal(commandOf("  /ahoy now", ["ahoy"]), "/ahoy");
  assert.equal(commandOf("/tmp/foo is broken", ["ahoy"]), null);
  assert.equal(commandOf("/unknown", ["ahoy"]), null);
  assert.equal(commandOf("then /compact", null), null);
});

test("a chip says the state now, and what it was when the captain replied once that has changed", () => {
  const sent = { kind: "call", id: "nm-rebase-guard-1", title: null, state: "open", pr: null, why: null };
  assert.equal(chipState(sent, { ...APPROVE, state: "open" }, true), "open");
  assert.equal(chipState(sent, { ...APPROVE, state: "recorded = merge" }, true), "recorded = merge since · open when you replied");
  assert.equal(chipState({ ...sent, kind: "task", state: "in flight" }, undefined, true), "closed, older than the board shows · in flight when you replied");
  assert.equal(chipState(sent, undefined, false), "open when you replied · not read now");
});

test("times read on the captain's clock", () => {
  const now = Date.parse("2026-10-02T22:07:00Z");
  assert.equal(clock("2026-10-02T09:05:00Z", now), "09:05");
  assert.equal(clock("2026-10-01T14:02:00Z", now), "14:02 yesterday");
  assert.equal(clock("2026-09-28T14:02:00Z", now), "14:02 on 2026-09-28");
});
