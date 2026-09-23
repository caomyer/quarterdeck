/**
 * Crew routing rules as the form edits them: `config/crew-dispatch.json` parsed, changed one field at a time, and
 * written back. The file's schema belongs to firstmate (`engine/docs/configuration.md`, "Crew dispatch profiles"),
 * and firstmate checks every save; this only keeps the form honest about what it can show.
 *
 * Nothing is dropped. An edit changes the one value it names and leaves every other key where it was, including
 * the ones the form has no control for (`floor`, `approval`, `provider`, anything newer), which the form lists so
 * they are never silently lost. A file the form cannot show at all is said so, and edited as JSON instead.
 */

import type { HarnessChoice } from "./host/types";

type Json = Record<string, unknown>;
export type Profile = Json;
export type Rule = Json;
export type RulesDoc = Json;

/** Where a list of profiles lives: one rule's `use`, or the top-level `default`. */
export type Target = { rule: number } | "default";

/** The fields the form edits; anything else on a profile or rule is kept and listed, never shown as a control. */
const PROFILE_FIELDS = ["harness", "model", "effort"];
const RULE_FIELDS = ["when", "use", "why"];
const DOC_FIELDS = ["rules", "default"];
/** A profile's fields that name its harness, so choosing another harness clears them. */
const HARNESS_BOUND = ["model", "provider", "floor"];

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function profileProblem(value: unknown, where: string): string | null {
  if (!isObject(value)) return `${where} is not an object`;
  for (const field of PROFILE_FIELDS) {
    if (field in value && typeof value[field] !== "string") return `${where} has a ${field} that is not text`;
  }
  return null;
}

function profilesProblem(value: unknown, where: string): string | null {
  if (value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  for (const [index, profile] of list.entries()) {
    const problem = profileProblem(profile, Array.isArray(value) ? `${where}, choice ${index + 1},` : where);
    if (problem) return problem;
  }
  return null;
}

/** Why the form cannot show this text, in words for the captain; `null` when it can. */
export function formProblem(text: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!isObject(doc)) return "it is not a JSON object";
  if ("rules" in doc && !Array.isArray(doc.rules)) return "its rules are not a list";
  for (const [index, rule] of ((doc.rules as unknown[] | undefined) ?? []).entries()) {
    const where = `rule ${index + 1}`;
    if (!isObject(rule)) return `${where} is not an object`;
    if ("when" in rule && typeof rule.when !== "string") return `${where} has a when that is not text`;
    if ("why" in rule && typeof rule.why !== "string") return `${where} has a why that is not text`;
    const problem = profilesProblem(rule.use, where);
    if (problem) return problem;
  }
  return profilesProblem(doc.default, "the default");
}

export function parseRules(text: string): RulesDoc {
  return JSON.parse(text) as RulesDoc;
}

/** The file as it is saved: two-space JSON and a final newline, keys in the order they already had. */
export function serialize(doc: RulesDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function rulesOf(doc: RulesDoc): Rule[] {
  return (doc.rules as Rule[] | undefined) ?? [];
}

/** A `use` or `default` as a list, whichever form the file holds it in. */
export function profilesOf(value: unknown): Profile[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as Profile[];
}

export function targetProfiles(doc: RulesDoc, target: Target): Profile[] {
  return profilesOf(target === "default" ? doc.default : rulesOf(doc)[target.rule]?.use);
}

/** The keys on `value` the form has no control for, in file order, so it can say they are there. */
export function extraKeys(value: Json, kind: "profile" | "rule" | "doc"): string[] {
  const known = kind === "profile" ? PROFILE_FIELDS : kind === "rule" ? RULE_FIELDS : DOC_FIELDS;
  return Object.keys(value).filter((key) => !known.includes(key));
}

/** Sets or, with an empty value, removes one key, leaving every other key where it was. */
function assign(target: Json, key: string, value: string) {
  if (value === "") delete target[key];
  else target[key] = value;
}

/** Puts a changed list back in the form the file held it in: one profile stays an object until there are more. */
function storeProfiles(doc: RulesDoc, target: Target, profiles: Profile[]) {
  const holder = target === "default" ? doc : rulesOf(doc)[target.rule];
  const key = target === "default" ? "default" : "use";
  if (target === "default" && profiles.length === 0) {
    delete holder.default;
    return;
  }
  holder[key] = profiles.length === 1 && isObject(holder[key]) ? profiles[0] : profiles;
}

function edited(doc: RulesDoc, change: (copy: RulesDoc) => void): RulesDoc {
  const copy = structuredClone(doc);
  change(copy);
  return copy;
}

export function setRuleText(doc: RulesDoc, rule: number, field: "when" | "why", value: string): RulesDoc {
  return edited(doc, (copy) => {
    const target = rulesOf(copy)[rule];
    // An empty when is still a when: firstmate refuses it, and says so, rather than the form dropping the key.
    if (field === "when") target.when = value;
    else assign(target, field, value.trim() === "" ? "" : value);
  });
}

/** The efforts `harness` takes with `model`, each saying whether the model allows it. */
export function effortChoices(harness: HarnessChoice | undefined, model: string) {
  return (harness?.efforts ?? []).map(({ effort, needs }) => ({ effort, needs, allowed: needsMet(needs, model) }));
}

/** Whether `model` is what an effort needs, by the rule firstmate's validator applies. */
export function needsMet(needs: string | null, model: string): boolean {
  if (needs === null) return true;
  if (needs.endsWith("*")) {
    const prefix = needs.slice(0, -1);
    return model.startsWith(prefix) && model.length > prefix.length;
  }
  return model === needs;
}

/** Whether `effort` is one firstmate accepts for `harness` with `model`. An unknown harness is not the form's to judge. */
export function effortAllowed(harness: HarnessChoice | undefined, model: string, effort: string): boolean {
  if (!harness) return true;
  return effortChoices(harness, model).some((choice) => choice.effort === effort && choice.allowed);
}

/**
 * Changes one field of one profile. Choosing a different harness clears what named the old harness (its model, the
 * provider whose quota it was judged by, and its own floor) and an effort the new one does not take, so the form
 * never holds a combination firstmate would refuse or route by the wrong harness's quota.
 */
export function setProfileField(doc: RulesDoc, target: Target, index: number, field: "harness" | "model" | "effort", value: string, harnesses: HarnessChoice[]): RulesDoc {
  return edited(doc, (copy) => {
    const profiles = targetProfiles(copy, target);
    const profile = profiles[index];
    const before = typeof profile.harness === "string" ? profile.harness : "";
    assign(profile, field, value);
    if (field === "harness" && value !== before) for (const key of HARNESS_BOUND) delete profile[key];
    if ((field === "harness" || field === "model") && typeof profile.effort === "string") {
      const chosen = harnesses.find((harness) => harness.name === profile.harness);
      if (chosen && !effortAllowed(chosen, typeof profile.model === "string" ? profile.model : "", profile.effort)) delete profile.effort;
    }
    storeProfiles(copy, target, profiles);
  });
}

/** Adds a choice at the end of the list, trying the harness first in `harnesses` that is installed. */
export function addProfile(doc: RulesDoc, target: Target, harnesses: HarnessChoice[]): RulesDoc {
  const harness = harnesses.find((choice) => choice.installed)?.name ?? harnesses[0]?.name ?? "claude";
  return edited(doc, (copy) => storeProfiles(copy, target, [...targetProfiles(copy, target), { harness }]));
}

export function removeProfile(doc: RulesDoc, target: Target, index: number): RulesDoc {
  return edited(doc, (copy) => storeProfiles(copy, target, targetProfiles(copy, target).filter((_, at) => at !== index)));
}

/** Moves a choice earlier (-1) or later (1): the order is the order firstmate tries them in. */
export function moveProfile(doc: RulesDoc, target: Target, index: number, by: -1 | 1): RulesDoc {
  return edited(doc, (copy) => {
    const profiles = targetProfiles(copy, target);
    const to = index + by;
    if (to < 0 || to >= profiles.length) return;
    [profiles[index], profiles[to]] = [profiles[to], profiles[index]];
    storeProfiles(copy, target, profiles);
  });
}

export function addRule(doc: RulesDoc, harnesses: HarnessChoice[]): RulesDoc {
  const harness = harnesses.find((choice) => choice.installed)?.name ?? harnesses[0]?.name ?? "claude";
  return edited(doc, (copy) => {
    copy.rules = [...rulesOf(copy), { when: "", use: { harness } }];
  });
}

export function removeRule(doc: RulesDoc, index: number): RulesDoc {
  return edited(doc, (copy) => {
    copy.rules = rulesOf(copy).filter((_, at) => at !== index);
  });
}

export function moveRule(doc: RulesDoc, index: number, by: -1 | 1): RulesDoc {
  return edited(doc, (copy) => {
    const rules = rulesOf(copy);
    const to = index + by;
    if (to < 0 || to >= rules.length) return;
    [rules[index], rules[to]] = [rules[to], rules[index]];
  });
}

/**
 * Models worth suggesting for `harness`: the ones the given rules already use with it, the captain's own first. A
 * suggestion only: models are open-ended per harness, and any model the captain types is theirs to name.
 */
export function modelSuggestions(harness: string, ...docs: (RulesDoc | null)[]): string[] {
  const seen: string[] = [];
  for (const doc of docs) {
    if (!doc) continue;
    const lists = [...rulesOf(doc).map((rule) => profilesOf(rule.use)), profilesOf(doc.default)];
    for (const profile of lists.flat()) {
      if (profile.harness === harness && typeof profile.model === "string" && profile.model && !seen.includes(profile.model)) seen.push(profile.model);
    }
  }
  return seen;
}
