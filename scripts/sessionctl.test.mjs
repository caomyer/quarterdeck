// Unit tests for src/sessionctl.ts, which reads the first mate's session for the composer: the slash palette, drawn
// from the commands the session advertises, and the model and effort it offers.
//
//   pnpm test
//
// The payloads are the ones claude-agent-acp 0.69.0 really sent (src/fixtures/session-controls.json), shaped as the
// host hands them on (src-tauri/src/controls.rs keeps each command's name, description and hint).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fill, ghostHint, optionOf, palette, pillState, routeOf, sortedCommands, typedSetting, valueLabel } from "../src/sessionctl.ts";

const captured = JSON.parse(readFileSync(new URL("../src/fixtures/session-controls.json", import.meta.url), "utf8"));
/** As the host keeps them: controls.rs `commands_of`. */
const commands = captured.available_commands_update.availableCommands.map((command) => ({ name: command.name, description: command.description ?? "", hint: command.input?.hint ?? null }));
const controls = (options = captured.session_new_result.configOptions, extra = {}) => ({ live: true, options, commands, mode: "bypassPermissions", pending: null, problems: {}, unfit: {}, picks: {}, ...extra });
const names = (state) => state.matches.map((command) => command.name);

test("/ lists every command the session advertised, A to Z", () => {
  const state = palette("/", 1, commands);
  assert.equal(state.kind, "list");
  assert.equal(state.matches.length, 59);
  assert.deepEqual(names(state), sortedCommands(commands).map((command) => command.name));
  assert.equal(names(state)[0], "afk");
  const keys = names(state).map((name) => name.replace(/^[^a-z0-9]+/i, ""));
  assert.deepEqual(keys, [...keys].sort(), "sorted by their letters");
  assert.ok(names(state).includes("__remote-workflow"), "what is advertised is listed, not second-guessed");
});

test("/a narrows to the commands starting with a", () => {
  const state = palette("/a", 2, commands);
  assert.deepEqual(names(state), ["afk", "agents", "ahoy", "auto-mode-setup", "autocompact"]);
  assert.deepEqual(names(palette("/au", 3, commands)), ["auto-mode-setup", "autocompact"]);
  assert.deepEqual(names(palette("/A", 2, commands)), names(state), "whatever the case typed");
});

test("the palette opens only while the caret is in the first word", () => {
  assert.equal(palette("", 0, commands).open, false);
  assert.equal(palette("hello /a", 8, commands).open, false, "a slash later in a message is not a command");
  assert.equal(palette("/compact now", 12, commands).open, false, "past the first word it closes");
  assert.equal(palette("/compact now", 3, commands).kind, "list", "back in the first word it opens again");
  assert.equal(palette("/a", 0, commands).open, false, "before the slash it is closed");
});

test("the empty states: nothing arrived yet, an empty list, and nothing matching", () => {
  assert.deepEqual(palette("/", 1, null), { open: true, query: "", kind: "waiting" });
  assert.deepEqual(palette("/", 1, []), { open: true, query: "", kind: "none" });
  assert.deepEqual(palette("/zz", 3, commands), { open: true, query: "zz", kind: "no_match" });
  assert.deepEqual(palette("/calm", 5, commands), { open: true, query: "calm", kind: "no_match" }, "Calm is not a session command");
});

test("choosing fills the composer and never sends; its hint shows until typed over", () => {
  const review = commands.find((command) => command.name === "code-review");
  assert.equal(fill(review), "/code-review ");
  assert.equal(ghostHint("/code-review ", commands), "[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [<pr#>|<branch>|<path>]");
  assert.equal(ghostHint("/code-review h", commands), null);
  assert.equal(ghostHint("/afk ", commands), null, "a command without a hint shows none");
});

test("/model and /effort open their controls, and only when the session offers them", () => {
  const byName = (name) => commands.find((command) => command.name === name);
  assert.equal(routeOf(byName("model"), controls()), "model");
  assert.equal(routeOf(byName("effort"), controls()), "thought_level");
  assert.equal(routeOf(byName("fast"), controls()), null, "no Fast control is drawn, so /fast stays text");
  const haiku = captured.session_new_result.configOptions.filter((option) => option.category !== "thought_level");
  assert.equal(routeOf(byName("effort"), controls(haiku)), null, "no effort on this model: it stays ordinary text");
});

test("a typed /model or /effort the session offers goes through the control", () => {
  assert.deepEqual(typedSetting("/model sonnet", controls()), { category: "model", value: "sonnet" });
  assert.deepEqual(typedSetting("/model Fable", controls()), { category: "model", value: "claude-fable-5[1m]" }, "by the name the session gives it");
  assert.deepEqual(typedSetting(" /effort HIGH ", controls()), { category: "thought_level", value: "high" });
  assert.equal(typedSetting("/effort ultracode", controls()), null, "a value the session does not offer is sent as written");
  assert.equal(typedSetting("/model sonnet please", controls()), null);
  assert.equal(typedSetting("/model sonnet", controls(null)), null);
});

test("the pills say only what the session last stated", () => {
  const model = optionOf(controls(), "model");
  assert.equal(valueLabel(model, "default"), "Default · Opus", "the default names its model, from the session's description");
  assert.equal(valueLabel(model, "sonnet"), "Sonnet");
  assert.deepEqual(pillState(null, "model"), { kind: "unknown" });
  assert.deepEqual(pillState(controls([]), "model"), { kind: "absent" }, "an adapter that offers no options");
  const waiting = pillState(controls(undefined, { pending: { category: "model", value: "sonnet" } }), "model");
  assert.equal(waiting.label, "Default · Opus", "a change on its way is not shown as made");
  assert.equal(waiting.pending, "sonnet");
  const effort = pillState(controls(), "thought_level");
  assert.equal(effort.label, "Default");
  assert.equal(effort.pending, null, "a model change is not the effort's");
});
