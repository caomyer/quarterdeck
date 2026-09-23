// Unit tests for src/usage.ts, which reads the context window and every provider's plan limits for the usage panel.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, contextEvent, contextLevel, contextPercent, providerViews, stripLine, stripProviders, tokens, until, windowLabel, windowLevel } from "../src/usage.ts";

const NOW = Date.parse("2026-09-23T07:05:00Z");
const inMs = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function provider(id, fields = {}) {
  return { id, label: id[0].toUpperCase() + id.slice(1), plan: null, status: "fresh", stale: false, refreshed_at: inMs(-MIN), error: null, reason: null, remedy: null, confidence: "established", windows: [], ...fields };
}

const claude = provider("claude", {
  plan: "max",
  windows: [
    { id: "five_hour", label: "session", kind: "session", used: 20, resets_at: inMs(95 * MIN) },
    { id: "seven_day", label: "week", kind: "weekly", used: 17, resets_at: inMs(2 * DAY + 23 * HOUR) },
    { id: "model:fable", label: "Fable week", kind: "model", used: 0, resets_at: inMs(2 * DAY + 23 * HOUR) },
  ],
});
const codex = provider("codex", {
  plan: "plus",
  confidence: "early",
  windows: [
    { id: "five_hour", label: "session", kind: "session", used: 0, resets_at: inMs(5 * HOUR) },
    { id: "weekly", label: "week", kind: "weekly", used: 0, resets_at: inMs(4 * DAY + 12 * HOUR) },
  ],
});
const keychain = provider("claude", { status: "auth_required", error: "keychain_prompt_required", reason: "keychain_access_required", remedy: "quota-axi --allow-keychain-prompt", refreshed_at: null });
const copilot = provider("copilot", { label: "GitHub Copilot", status: "auth_required", error: "GitHub Copilot sign-in required", refreshed_at: null });
const agy = provider("agy", { label: "Antigravity", status: "unavailable", error: "Antigravity/agy is not running", refreshed_at: null });
const read = (providers, fields = {}) => ({ providers, read_at_ms: NOW - MIN, error: null, missing: false, ...fields });
const session = (status, fields = {}) => ({ status, rateLimitType: "five_hour", resetsAt: (NOW + 95 * MIN) / 1000, ...fields });

test("token counts and times read at a glance", () => {
  assert.deepEqual([tokens(950), tokens(70_979), tokens(812_400), tokens(1_000_000), tokens(1_500_000)], ["950", "71k", "812k", "1M", "1.5M"]);
  assert.equal(until(NOW + 95 * MIN, NOW), "1h 35m");
  assert.equal(until(NOW + 38 * MIN, NOW), "38m");
  assert.equal(until(NOW + 2 * DAY + 23 * HOUR + 5 * MIN, NOW), "2d 23h");
  assert.equal(until(NOW + 20 * 1000, NOW), "a moment");
  assert.equal(until(Date.parse("2026-10-06T12:00:00Z"), NOW), "Oct 6");
  assert.deepEqual([ago(NOW - 20_000, NOW), ago(NOW - 42 * MIN, NOW), ago(NOW - 3 * HOUR, NOW)], ["just now", "42m ago", "3h ago"]);
});

test("a window's name is the short one the captain knows", () => {
  assert.deepEqual(claude.windows.map(windowLabel), ["5h", "wk", "Fable wk"]);
  assert.equal(windowLabel({ id: "included_usage", label: "included usage", kind: "monthly" }), "included");
  assert.equal(windowLabel({ id: "model:base_model_inference:7d", label: "gpt-reserve week", kind: "model" }), "gpt-reserve wk");
});

test("numbers take colour only when they matter", () => {
  assert.deepEqual([windowLevel(null), windowLevel(79), windowLevel(80), windowLevel(100)], ["", "", "warn", "over"]);
  assert.deepEqual([contextLevel(null), contextLevel(74.9), contextLevel(75)], ["", "", "warn"]);
  assert.equal(contextPercent({ used: 70_979, size: 1_000_000, at_ms: NOW, resumed: false, compacted: null }), 7.0979);
  assert.equal(contextPercent({ used: null, size: null, at_ms: null, resumed: false, compacted: null }), null, "no reading is not 0%");
});

test("a live provider shows every window, and the strip shows the one that binds", () => {
  const { shown, others } = providerViews(read([claude, codex]), null, NOW);
  assert.deepEqual(shown.map((view) => [view.name, view.plan, view.state]), [["Claude", "Max", "live"], ["Codex", "Plus", "early"]]);
  assert.deepEqual(shown[0].windows.map((window) => [window.label, window.used]), [["5h", 20], ["wk", 17], ["Fable wk", 0]]);
  assert.equal(shown[0].binding.label, "5h");
  assert.deepEqual(stripLine(shown[0], NOW), { value: "20% 5h", detail: "1h 35m", joined: false });
  assert.deepEqual(others, []);
});

test("an early reading is marked as one", () => {
  const view = providerViews(read([codex]), null, NOW).shown[0];
  assert.equal(view.state, "early");
  assert.equal(stripLine(view, NOW).value, "~0% 5h");
});

test("the strip shows the first mate's provider, and another only once it is close to a limit", () => {
  const busy = provider("codex", { windows: [{ id: "five_hour", label: "session", kind: "session", used: 86, resets_at: inMs(38 * MIN) }] });
  assert.deepEqual(stripProviders(providerViews(read([claude, codex]), null, NOW).shown).map((view) => view.id), ["claude"]);
  assert.deepEqual(stripProviders(providerViews(read([claude, busy]), null, NOW).shown).map((view) => view.id), ["claude", "codex"]);
});

test("before the Keychain is allowed, Claude still says what the first mate's session knows", () => {
  const { shown } = providerViews(read([keychain, codex]), session("allowed"), NOW);
  const view = shown[0];
  assert.deepEqual([view.state, view.status, view.keychain, view.words], ["partial", "Under its limit", true, "keychain_prompt_required"]);
  assert.deepEqual(view.windows.map((window) => [window.label, window.used]), [["5h", null]]);
  assert.deepEqual(stripLine(view, NOW), { value: "under limit", detail: "1h 35m", joined: true });
});

test("without the session, a provider that needs sign-in says what it needs and how to fix it", () => {
  const view = providerViews(read([keychain]), null, NOW).shown[0];
  assert.deepEqual([view.state, view.words, view.remedy, view.keychain], ["needs_auth", "keychain_prompt_required", "quota-axi --allow-keychain-prompt", true]);
  assert.deepEqual(stripLine(view, NOW), { value: "needs sign-in", detail: "", joined: false });
});

test("a refusal from the session outranks quota-axi's numbers, and says when it ends", () => {
  const view = providerViews(read([claude]), session("rejected", { resetsAt: (NOW + 52 * MIN) / 1000 }), NOW).shown[0];
  assert.equal(view.state, "refused");
  assert.deepEqual(stripLine(view, NOW), { value: "limit", detail: "back in 52m", joined: false });
  assert.equal(view.binding.level, "over");
});

test("a session limit that has already reset says nothing", () => {
  const { shown } = providerViews(read([keychain]), session("rejected", { resetsAt: (NOW - MIN) / 1000 }), NOW);
  assert.equal(shown[0].state, "needs_auth");
});

test("a failed read keeps the last numbers, as stale", () => {
  const view = providerViews(read([claude], { error: "quota-axi did not answer within 45s", read_at_ms: NOW - 42 * MIN }), null, NOW).shown[0];
  assert.equal(view.state, "stale");
  assert.equal(stripLine(view, NOW).detail, "1m old", "stale numbers give their age, from quota-axi's own refresh time, in place of the reset");
});

test("providers nobody set up fold into one line, in quota-axi's words", () => {
  const { shown, others } = providerViews(read([claude, copilot, agy]), null, NOW);
  assert.deepEqual(shown.map((view) => view.id), ["claude"]);
  assert.deepEqual(others, [{ name: "GitHub Copilot", words: "GitHub Copilot sign-in required" }, { name: "Antigravity", words: "Antigravity/agy is not running" }]);
});

test("nothing read and nothing reported shows no provider", () => {
  assert.deepEqual(providerViews(null, null, NOW), { shown: [], others: [] });
  assert.deepEqual(providerViews(read(null, { missing: true, error: "quota-axi is not installed" }), null, NOW).shown, []);
});

test("a window that has reset reads as empty until the next read", () => {
  const reset = provider("claude", { windows: [{ id: "five_hour", label: "session", kind: "session", used: 91, resets_at: inMs(-MIN) }] });
  assert.equal(providerViews(read([reset]), null, NOW).shown[0].windows[0].used, 0);
});

test("a compaction and a resumed session each say what the reading alone would not", () => {
  const base = { used: 61_200, size: 1_000_000, at_ms: NOW, resumed: false, compacted: null };
  assert.equal(contextEvent(base, NOW), null);
  assert.equal(contextEvent({ ...base, compacted: { from: 812_400, to: 61_200, at_ms: NOW - 12 * MIN } }, NOW), "Compacted 12m ago: 812k down to 61k");
  assert.equal(contextEvent({ ...base, resumed: true }, NOW), "A resumed session: this reading carries its earlier conversation");
});
