// `?chat-reply`: a resumed conversation to reply in, with the real messages the design was drawn from, and a fleet
// that knows the things they name. `scripts/chat-reply.mjs` checks every state against it.
//
//   ?chat-reply               the conversation, and the fleet read
//   ?chat-reply=fleet-failed  the same, but the last fleet read failed, so nothing a place names can be checked
//
// The replies already in the conversation are written by src/replyto.ts itself, as the app sent them: one whose place
// is still on screen, one whose place went with an earlier conversation and whose task has left the board, one whose
// call was recorded since, and a block cut short, which the chat shows as raw words.
import { type FleetRead, type Place, replyBlock, withReply } from "../replyto";
import type { BacklogRecord, Call, FleetSnapshot, HistoryItem } from "./types";

const minutes = (ago: number) => new Date(Date.now() - ago * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

export const VIS_TASK = "qd-nm-vis-build-1";
export const SESSIONS_TASK = "qd-sessionctl-build-1";
export const GUARD_CALL = "nm-rebase-guard-1";
export const APPROVE_CALL = "qd-approve-flow-1";
export const DETERMINISTIC_CALL = "qd-deterministic-1";
export const ONBOARDING_CALL = "qd-onboarding-1";

export const VIS_HEADLINE = "Doing well - it's on the last step.";
const VIS_MESSAGE = [
  `**${VIS_HEADLINE}**`,
  "",
  "Eight of nine pipeline steps are complete on the merged head: intent, rebase, review, test, document, lint, push, pr. Only **ci** is left, and it just started.",
  "",
  "Review came back **clean this round** - 0 findings - after I decided the rule 2 wording question.",
  "",
  "PR #32 is open with the same content plus the fixes.",
].join("\n");
const VIS_DRAWN = "Doing well - it's on the last step. Eight of nine pipeline steps are complete on the merged head: intent, rebase, review, test, document, lint, push, pr. Only ci is left, and it just started. Review came back clean this round - 0 findings - after I decided the rule 2 wording question. PR #32 is open with the same content plus the fixes.";

export const DECISIONS_MESSAGE = [
  "**Three decisions, and none of them is urgent.** All three crews are working and need nothing from you.",
  "",
  `1. **\`${GUARD_CALL}\`** - the one I'd take. It's live, it has six incidents behind it.`,
  `2. **\`${APPROVE_CALL}\`** - how far to fix the approval loop. Partly overtaken by events: the determinism work you just approved covers some of it, and \`fm/overnight-collab\` already builds the \`full\` option.`,
  `3. **\`${ONBOARDING_CALL}\`** - review the built onboarding, with the two Codex gaps named.`,
].join("\n");

const PR = (number: number) => `https://github.com/caomyer/quarterdeck/pull/${number}`;

const read = (at: string): FleetRead => ({
  read: {
    at,
    things: [
      { kind: "task", id: VIS_TASK, title: "Pipeline status per task: who it waits on", state: "in flight", pr: PR(32) },
      { kind: "task", id: "qd-gate-done-1", title: "Keep a captain's question open past a worker's done line", state: "in flight", pr: PR(33) },
      { kind: "call", id: APPROVE_CALL, title: "How far to fix the approval loop", state: "open", pr: null },
    ],
  },
});

/** A reply as the app sent it before the conversation was resumed. */
function sent(place: Omit<Place, "message" | "selected" | "unit"> & Partial<Place>, words: string, at: string, picked: string | null = null) {
  const full: Place = { unit: null, selected: false, message: "", ...place };
  return withReply(words, replyBlock({ place: full, picked }, read(at), Date.parse(at)));
}

export function replyHistory(): HistoryItem[] {
  const vis = sent({ owner: { kind: "mate" }, said: { at: minutes(40) }, back: 1, unit: { kind: "paragraph", index: 1, of: 4 }, quote: VIS_HEADLINE, around: { before: "", after: VIS_DRAWN.slice(VIS_HEADLINE.length + 1) }, message: VIS_MESSAGE }, "then why i saw it was on paused state? is that a stale state", minutes(37));
  const approve = sent({
    owner: { kind: "mate" }, said: { at: minutes(30) }, back: 1, unit: { kind: "item", index: 2, of: 3 }, quote: `${APPROVE_CALL} - how far to fix the approval loop.`, selected: true,
    around: { before: `${GUARD_CALL} - the one I'd take. It's live, it has six incidents behind it.`, after: "Partly overtaken by events: the determinism work you just approved covers some of it" },
    block: `${APPROVE_CALL} - how far to fix the approval loop. Partly overtaken by events: the determinism work you just approved covers some of it, and fm/overnight-collab already builds the full option.`, message: DECISIONS_MESSAGE,
  }, "ok close this one as overtaken, the det work covers it", minutes(29), `call:${APPROVE_CALL}`);
  const gone = sent({
    owner: { kind: "mate" }, said: { at: minutes(60 * 26) }, back: 3, unit: { kind: "paragraph", index: 1, of: 2 }, quote: "#34 is merged. origin/main is now 530d91b and CI is deterministic again.",
    around: { before: "", after: "The two crews it blocked, qd-gate-done-1 among them, can start again." }, message: "#34 is merged. origin/main is now 530d91b and CI is deterministic again.\n\nThe two crews it blocked, qd-gate-done-1 among them, can start again.",
  }, "did the two blocked crews actually restart?", minutes(60 * 26 - 2));
  return [
    { who: "captain", text: `how’s the task ${VIS_TASK} doing` },
    { who: "mate", text: VIS_MESSAGE },
    { who: "captain", text: vis },
    { who: "mate", text: "It was paused for two minutes while CI restarted a flaky job. What you saw was right at the time; it is running again now." },
    { who: "captain", text: "what needs my attention now?" },
    { who: "mate", text: DECISIONS_MESSAGE },
    { who: "captain", text: approve },
    { who: "mate", text: "Recorded as overtaken." },
    { who: "captain", text: gone },
    { who: "mate", text: "Both restarted and are working." },
    { who: "captain", text: "↩ The captain is replying to a place in this chat. It comes first; the captain's words follow the rule.\non        your mess" },
    { who: "captain", text: "How’s pr 26 doing" },
    { who: "captain", text: "still have a decision call waiting on pr 26, is that expected? or blocking any work of the worker?" },
    { who: "mate", text: `↩ "still have a decision call waiting on pr 26, is that expected?"\n**Expected, and it blocks nothing.** The call is the merge decision for \`${SESSIONS_TASK}\`; the worker is parked and waits on CI either way.` },
    { who: "mate", text: "↩ \"How’s pr 26 doing\"\nReview is clean, CI is 11 of 15 and green so far." },
    { who: "mate", text: "↩ \"how is the onboarding review going\"\nThe onboarding review waits on the two Codex gaps." },
  ];
}

/** The fleet the conversation talks about, added to the fixture's: two tasks with their PRs, and four calls. */
export function replyFleet(fleet: FleetSnapshot, row: (id: string, title: string, fields: Partial<BacklogRecord>) => BacklogRecord): FleetSnapshot {
  const call = (id: string, title: string, fields: Partial<Call>): Call => ({
    id, title, question: null, options: [], on_answer: "done", state: "open", bucket: "live", captain_actionable: true, origin: null, about: null,
    evidence: [], raised_by: "firstmate", raised_at: minutes(60 * 30), updated_at: minutes(60 * 30), answer: null, decided: null, ...fields,
  });
  const records = [
    row(VIS_TASK, "Pipeline status per task: who it waits on", { repo: "quarterdeck", pr_url: PR(32) }),
    row(SESSIONS_TASK, "Model and effort in the composer", { repo: "quarterdeck", pr_url: PR(26) }),
  ];
  const calls = [
    call(GUARD_CALL, "Make a rebase on a mirrored branch refuse, upstream it to no-mistakes?", {
      question: "Make a rebase on a mirrored branch refuse, upstream it to no-mistakes?",
      options: [{ key: "merge-and-upstream", label: "Merge it here and upstream it", recommended: true }, { key: "local", label: "Keep it local", recommended: false }],
      raised_at: minutes(50), updated_at: minutes(50),
    }),
    call(APPROVE_CALL, "How far to fix the approval loop", { state: "closed", bucket: null, captain_actionable: false, answer: { key: "overtaken", label: "Overtaken by the determinism work", by: "captain", via: "quarterdeck", at: minutes(28) } }),
    call(DETERMINISTIC_CALL, "Where the system relies on firstmate for steps a tool could take", { state: "closed", bucket: null, captain_actionable: false, answer: { key: "mechanical", label: "Make them mechanical", by: "captain", via: "quarterdeck", at: minutes(60 * 20) } }),
    call(ONBOARDING_CALL, "Review the built onboarding", { question: "Review the built onboarding, with the two Codex gaps named?" }),
  ];
  return {
    ...fleet,
    backlog: { ...fleet.backlog, records: [...(fleet.backlog?.records ?? []), ...records] },
    calls: [...(fleet.calls ?? []), ...calls],
  };
}

/** `?chat-reply=fleet-failed`: what the host reports when the fleet read fails. */
export const FLEET_FAILED = { source: "fm-fleet-snapshot.sh", error: "fm-fleet-snapshot.sh exited with exit status: 1: jq: error (at data/backlog.md:0): Cannot iterate over null" };
