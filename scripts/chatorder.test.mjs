// Unit tests for src/chatorder.ts, which places the chat's pages among its messages.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { latestTime, pagePlaces } from "../src/chatorder.ts";

const NOW = Date.parse("2026-09-24T06:52:00Z");
const ago = (minutes) => NOW - minutes * 60_000;
const UNKNOWN = Infinity;

/** Checks the invariant itself: no page below a message known or possibly newer than it. */
function neverBelowNewer(bounds, pages, places) {
  pages.forEach((at, page) => {
    for (let index = 0; index < places[page]; index++) {
      const latest = Math.min(...bounds.slice(index));
      assert.ok(latest <= at, `page ${page} sits below message ${index}, which may be newer`);
    }
  });
}

test("a live conversation places each page between the messages either side of it", () => {
  const bounds = [ago(30), ago(20), ago(10)];
  const pages = [ago(40), ago(25), ago(15), ago(5)];
  assert.deepEqual(pagePlaces(bounds, pages), [0, 1, 2, 3]);
});

test("a page presented at the very time a message was said goes after it", () => {
  assert.deepEqual(pagePlaces([ago(10)], [ago(10)]), [1]);
});

test("a resumed history with no times keeps a day-old page above all of it, not after its newest message", () => {
  // The captain's case: the whole history came back without times; its last message is from minutes ago.
  const read = ago(1);
  const bounds = [read, read, read, read];
  const pages = [ago(23 * 60 + 50), ago(23 * 60 + 34), ago(23 * 60 + 24)];
  const places = pagePlaces(bounds, pages);
  assert.deepEqual(places, [0, 0, 0]);
  neverBelowNewer(bounds, pages, places);
});

test("a review sent inside the history is a time, so pages after it follow it", () => {
  const read = ago(1);
  const review = ago(23 * 60 + 30);
  const bounds = [read, read, review, read, read];
  const pages = [ago(23 * 60 + 34), ago(23 * 60 + 24)];
  const places = pagePlaces(bounds, pages);
  assert.deepEqual(places, [0, 3]);
  neverBelowNewer(bounds, pages, places);
});

test("a page presented after the history was read follows all of it", () => {
  const read = ago(10);
  assert.deepEqual(pagePlaces([read, read, ago(2)], [ago(5), ago(1)]), [2, 3]);
});

test("a message nothing is known of takes its bound from the next message that has one", () => {
  const bounds = [ago(30), UNKNOWN, ago(10)];
  assert.deepEqual(pagePlaces(bounds, [ago(20), ago(5)]), [1, 3]);
});

test("a later message's time bounds every message before it", () => {
  // The first message says only that it came before the history was read; the review after it says far more.
  const bounds = [ago(1), ago(1), ago(40), ago(1)];
  const pages = [ago(50), ago(20)];
  const places = pagePlaces(bounds, pages);
  assert.deepEqual(places, [0, 3]);
  neverBelowNewer(bounds, pages, places);
});

test("no messages: every page is shown", () => {
  assert.deepEqual(pagePlaces([], [ago(5), ago(1)]), [0, 0]);
});

test("a live message is bounded by its own time", () => {
  assert.equal(latestTime({ createdAt: new Date(ago(3)).toISOString() }), ago(3));
});

test("a resumed message is bounded by the review it is, or else by when its history was read", () => {
  const read = new Date(ago(1)).toISOString();
  assert.equal(latestTime({ createdAt: "", past: true, before: read }, ago(90)), ago(90));
  assert.equal(latestTime({ createdAt: "", past: true, before: read }), ago(1));
});

test("a message nothing is known of has no bound", () => {
  assert.equal(latestTime({ createdAt: "", past: true }), Infinity);
  assert.equal(latestTime({ createdAt: "" }), Infinity);
});
