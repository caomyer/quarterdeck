// Unit tests for src/rules.ts, the crew routing form's model of config/crew-dispatch.json.
//
//   pnpm test
//
// Node runs the TypeScript module directly, types stripped, so this needs no build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addProfile, addRule, effortAllowed, effortChoices, extraKeys, formProblem, modelSuggestions, moveProfile, moveRule, parseRules, profilesOf, removeProfile, removeRule, rulesOf, serialize, setProfileField, setRuleText, targetProfiles } from "../src/rules.ts";

const example = readFileSync(new URL("../engine/docs/examples/crew-dispatch.json", import.meta.url), "utf8");

// What firstmate's engine lists on a Mac with claude, codex and pi installed.
const HARNESSES = [
  { name: "claude", installed: true, efforts: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort, needs: null })) },
  { name: "codex", installed: true, efforts: [...["low", "medium", "high", "xhigh"].map((effort) => ({ effort, needs: null })), { effort: "max", needs: "gpt-5.6-luna" }] },
  { name: "pi", installed: true, efforts: [...["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort, needs: null })), { effort: "ultra", needs: "codex-native/*" }] },
  { name: "grok", installed: false, efforts: ["low", "medium", "high"].map((effort) => ({ effort, needs: null })) },
  { name: "cursor", installed: false, efforts: [] },
];

// Everything the form has no control for, at every level it can appear.
const RICH = `{
  "rules": [
    {
      "when": "Images.",
      "approval": "captain",
      "floor": { "scope": "all_models", "min_percent": 20, "provider": "codex" },
      "use": [
        { "harness": "pi", "model": "openai-codex/gpt-5.6-sol", "provider": "codex" },
        { "harness": "codex", "model": "gpt-5.6-sol", "floor": { "scope": "all_models", "min_percent": 50 } }
      ],
      "select": "quota-balanced",
      "why": "Pictures."
    }
  ],
  "default": { "harness": "claude", "effort": "high" },
  "notes": "kept"
}
`;

test("the shipped example and a file with fields the form cannot edit both open in the form", () => {
  assert.equal(formProblem(example), null);
  assert.equal(formProblem(RICH), null);
});

test("an untouched file writes back exactly what it held, in the same order", () => {
  for (const text of [example, RICH]) {
    const saved = serialize(parseRules(text));
    assert.deepEqual(JSON.parse(saved), JSON.parse(text));
    assert.equal(JSON.stringify(JSON.parse(saved)), JSON.stringify(JSON.parse(text)), "same keys in the same order");
  }
});

test("an edit changes the one value it names and keeps every field the form does not show", () => {
  const doc = parseRules(RICH);
  const after = setProfileField(doc, { rule: 0 }, 1, "model", "gpt-5.5", HARNESSES);
  const rule = rulesOf(after)[0];
  assert.deepEqual(rule.floor, { scope: "all_models", min_percent: 20, provider: "codex" });
  assert.equal(rule.approval, "captain");
  assert.equal(rule.select, "quota-balanced");
  assert.deepEqual(profilesOf(rule.use)[0], { harness: "pi", model: "openai-codex/gpt-5.6-sol", provider: "codex" });
  assert.deepEqual(profilesOf(rule.use)[1], { harness: "codex", model: "gpt-5.5", floor: { scope: "all_models", min_percent: 50 } });
  assert.equal(after.notes, "kept");
  assert.deepEqual(Object.keys(rule), ["when", "approval", "floor", "use", "select", "why"], "keys stay where they were");
  assert.equal(parseRules(RICH).rules[0].use[1].model, "gpt-5.6-sol", "the original is not changed");
});

test("the fields the form cannot edit are named, so nothing is hidden", () => {
  const doc = parseRules(RICH);
  assert.deepEqual(extraKeys(rulesOf(doc)[0], "rule"), ["approval", "floor", "select"]);
  assert.deepEqual(extraKeys(profilesOf(rulesOf(doc)[0].use)[1], "profile"), ["floor"]);
  assert.deepEqual(extraKeys(doc, "doc"), ["notes"]);
});

test("a file the form cannot show says why", () => {
  assert.match(formProblem("{ nope"), /not valid JSON/);
  assert.equal(formProblem("[]"), "it is not a JSON object");
  assert.equal(formProblem('{"rules": {}}'), "its rules are not a list");
  assert.equal(formProblem('{"rules": ["x"]}'), "rule 1 is not an object");
  assert.equal(formProblem('{"rules": [{"when": 3, "use": {"harness": "claude"}}]}'), "rule 1 has a when that is not text");
  assert.equal(formProblem('{"rules": [{"when": "a", "use": [{"harness": "claude"}, {"harness": 4}]}]}'), "rule 1, choice 2, has a harness that is not text");
  assert.equal(formProblem('{"default": "claude"}'), "the default is not an object");
});

test("one choice stays an object until a fallback is added, and the fallback order is the list order", () => {
  let doc = parseRules(example);
  assert.equal(Array.isArray(rulesOf(doc)[0].use), false);
  doc = setProfileField(doc, { rule: 0 }, 0, "model", "grok-4", HARNESSES);
  assert.equal(Array.isArray(rulesOf(doc)[0].use), false, "editing keeps the file's shape");
  doc = addProfile(doc, { rule: 0 }, HARNESSES);
  assert.deepEqual(rulesOf(doc)[0].use, [{ harness: "grok", model: "grok-4" }, { harness: "claude" }], "a fallback makes it a list, trying an installed harness");
  doc = moveProfile(doc, { rule: 0 }, 1, -1);
  assert.deepEqual(targetProfiles(doc, { rule: 0 }).map((profile) => profile.harness), ["claude", "grok"]);
  doc = removeProfile(doc, { rule: 0 }, 1);
  assert.deepEqual(rulesOf(doc)[0].use, [{ harness: "claude" }]);
});

test("choosing a different harness clears its model and an effort it does not take", () => {
  let doc = parseRules('{"default": {"harness": "claude", "model": "haiku", "effort": "xhigh"}}');
  doc = setProfileField(doc, "default", 0, "harness", "grok", HARNESSES);
  assert.deepEqual(doc.default, { harness: "grok" }, "grok takes no xhigh, and haiku is claude's");
  doc = parseRules('{"default": {"harness": "claude", "effort": "high"}}');
  doc = setProfileField(doc, "default", 0, "harness", "codex", HARNESSES);
  assert.deepEqual(doc.default, { harness: "codex", effort: "high" }, "an effort the new harness takes is kept");
  doc = setProfileField(doc, "default", 0, "effort", "", HARNESSES);
  assert.deepEqual(doc.default, { harness: "codex" }, "the harness default is no effort key at all");
});

test("choosing a different harness clears the provider and floor that named the old one, and keeps the rule's own", () => {
  let doc = setProfileField(parseRules(RICH), { rule: 0 }, 0, "harness", "codex", HARNESSES);
  assert.deepEqual(profilesOf(rulesOf(doc)[0].use)[0], { harness: "codex" }, "pi's model and codex provider are gone");
  doc = setProfileField(doc, { rule: 0 }, 1, "harness", "claude", HARNESSES);
  assert.deepEqual(profilesOf(rulesOf(doc)[0].use)[1], { harness: "claude" }, "codex's model and floor are gone");
  const rule = rulesOf(doc)[0];
  assert.deepEqual(rule.floor, { scope: "all_models", min_percent: 20, provider: "codex" });
  assert.equal(rule.approval, "captain");
  assert.equal(rule.select, "quota-balanced");
  const same = setProfileField(parseRules(RICH), { rule: 0 }, 0, "harness", "pi", HARNESSES);
  assert.deepEqual(profilesOf(rulesOf(same)[0].use)[0], { harness: "pi", model: "openai-codex/gpt-5.6-sol", provider: "codex" }, "choosing the same harness clears nothing");
});

test("an effort bound to a model is offered only with that model", () => {
  const codex = HARNESSES[1];
  assert.equal(effortAllowed(codex, "gpt-5.5", "max"), false);
  assert.equal(effortAllowed(codex, "gpt-5.6-luna", "max"), true);
  const pi = HARNESSES[2];
  assert.equal(effortAllowed(pi, "codex-native/gpt-6", "ultra"), true);
  assert.equal(effortAllowed(pi, "codex-native/", "ultra"), false, "the prefix alone names no model");
  assert.equal(effortAllowed(pi, "anthropic/claude-sonnet-5", "ultra"), false);
  assert.deepEqual(effortChoices(HARNESSES[4], ""), [], "cursor takes no effort");
  let doc = parseRules('{"default": {"harness": "codex", "model": "gpt-5.6-luna", "effort": "max"}}');
  doc = setProfileField(doc, "default", 0, "model", "gpt-5.5", HARNESSES);
  assert.deepEqual(doc.default, { harness: "codex", model: "gpt-5.5" }, "changing the model drops an effort it no longer allows");
});

test("rules are added, reordered and removed, and an emptied why is dropped", () => {
  let doc = parseRules('{"rules": []}');
  doc = addRule(doc, HARNESSES);
  doc = setRuleText(doc, 0, "when", "First.");
  doc = addRule(doc, HARNESSES);
  doc = setRuleText(doc, 1, "when", "Second.");
  doc = setRuleText(doc, 1, "why", "Because.");
  doc = moveRule(doc, 1, -1);
  assert.deepEqual(rulesOf(doc), [{ when: "Second.", use: { harness: "claude" }, why: "Because." }, { when: "First.", use: { harness: "claude" } }]);
  doc = setRuleText(doc, 0, "why", "  ");
  assert.equal("why" in rulesOf(doc)[0], false);
  doc = removeRule(doc, 1);
  assert.equal(rulesOf(doc).length, 1);
  doc = removeProfile(addProfile(doc, "default", HARNESSES), "default", 0);
  assert.equal("default" in doc, false, "an emptied default is removed, not left as an empty list");
});

test("model suggestions come from the rules already written, the captain's own first", () => {
  const mine = parseRules('{"default": [{"harness": "claude", "model": "opus"}, {"harness": "codex", "model": "gpt-5.5"}]}');
  assert.deepEqual(modelSuggestions("claude", mine, parseRules(example)), ["opus", "haiku", "claude-sonnet-5"]);
  assert.deepEqual(modelSuggestions("pi", null, parseRules(example)), ["anthropic/claude-sonnet-5"]);
  assert.deepEqual(modelSuggestions("grok", parseRules(example)), []);
});
