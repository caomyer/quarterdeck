import { useId, useMemo } from "react";
import { ArrowDown, ArrowUp, CircleAlert, Plus, X } from "lucide-react";
import type { HarnessChoice } from "./host";
import { addProfile, addRule, effortChoices, extraKeys, modelSuggestions, moveProfile, moveRule, parseRules, type Profile, removeProfile, removeRule, rulesOf, type RulesDoc, serialize, setProfileField, setRuleText, type Target, targetProfiles } from "./rules";

type Props = {
  /** The rules as text: the one draft the form and the JSON view both edit. */
  text: string;
  onChange: (text: string) => void;
  harnesses: HarnessChoice[];
  /** The example firstmate ships, whose models are offered as suggestions too. */
  template: string | null;
  disabled: boolean;
};

/** Words for a list of keys the form keeps but has no control for. */
function listed(keys: string[]) {
  return keys.map((key) => `"${key}"`).join(", ");
}

/**
 * The rules as a form: for each rule, the kind of work in plain words and the harnesses to try for it, in order; then
 * what to use when no rule fits. Harness and effort are chosen from what firstmate lists, so the form cannot name one
 * it would refuse. Models are typed, with the ones already in use suggested, because they are open-ended per harness.
 * The caller only shows this for text `formProblem` accepts.
 */
export function RulesEditor({ text, onChange, harnesses, template, disabled }: Props) {
  const doc = useMemo(() => parseRules(text), [text]);
  const example = useMemo(() => {
    try {
      return template ? parseRules(template) : null;
    } catch {
      return null;
    }
  }, [template]);
  const change = (next: RulesDoc) => onChange(serialize(next));
  const rules = rulesOf(doc);
  const defaults = targetProfiles(doc, "default");
  const extra = extraKeys(doc, "doc");

  return <div className="rules-form" data-testid="rules-form">
    {extra.length > 0 && <p className="rule-extra">This file also sets {listed(extra)}, kept as it is. Edit it as JSON to change that.</p>}
    {rules.length === 0 && <p className="rules-empty">No rules yet. Add one for a kind of work that should go to a particular harness.</p>}
    {rules.map((rule, index) => {
      const ruleExtra = extraKeys(rule, "rule");
      return <section className="rule-card" key={index} aria-label={`Rule ${index + 1}`} data-testid="rule-card">
        <header>
          <span>Rule {index + 1}</span>
          <div className="rule-tools">
            <button type="button" className="icon-button small" title="Move this rule up" disabled={disabled || index === 0} onClick={() => change(moveRule(doc, index, -1))}><ArrowUp size={14} /></button>
            <button type="button" className="icon-button small" title="Move this rule down" disabled={disabled || index === rules.length - 1} onClick={() => change(moveRule(doc, index, 1))}><ArrowDown size={14} /></button>
            <button type="button" className="icon-button small" title="Remove this rule" disabled={disabled} onClick={() => change(removeRule(doc, index))}><X size={14} /></button>
          </div>
        </header>
        <label className="rule-field">
          <span>When the work is</span>
          <textarea rows={2} value={typeof rule.when === "string" ? rule.when : ""} placeholder="A kind of work, in plain words: a rote rename, a big feature, anything about current events…" disabled={disabled} onChange={(event) => change(setRuleText(doc, index, "when", event.target.value))} />
        </label>
        <Choices doc={doc} target={{ rule: index }} harnesses={harnesses} example={example} disabled={disabled} onChange={change} label={`rule ${index + 1}`} />
        <label className="rule-field">
          <span>Why <em>optional</em></span>
          <input type="text" value={typeof rule.why === "string" ? rule.why : ""} placeholder="What helps the first mate tell this rule from the others" disabled={disabled} onChange={(event) => change(setRuleText(doc, index, "why", event.target.value))} />
        </label>
        {ruleExtra.length > 0 && <p className="rule-extra">This rule also sets {listed(ruleExtra)}, kept as it is. Edit it as JSON to change that.</p>}
      </section>;
    })}
    <button type="button" className="rules-add" disabled={disabled} onClick={() => change(addRule(doc, harnesses))}><Plus size={14} /> Add a rule</button>

    <section className="rule-card rule-default" aria-label="Otherwise" data-testid="rule-default">
      <header><span>Otherwise</span></header>
      <p className="rule-note">For work no rule fits.</p>
      {defaults.length > 0
        ? <Choices doc={doc} target="default" harnesses={harnesses} example={example} disabled={disabled} onChange={change} label="the default" removable />
        : <>
          <p className="rule-note">No default: the first mate picks its usual harness.</p>
          <button type="button" className="rules-add" disabled={disabled} onClick={() => change(addProfile(doc, "default", harnesses))}><Plus size={14} /> Add a default</button>
        </>}
    </section>
  </div>;
}

/** The harnesses one rule, or the default, tries, in the order it tries them. */
function Choices({ doc, target, harnesses, example, disabled, onChange, label, removable = false }: { doc: RulesDoc; target: Target; harnesses: HarnessChoice[]; example: RulesDoc | null; disabled: boolean; onChange: (next: RulesDoc) => void; label: string; removable?: boolean }) {
  const profiles = targetProfiles(doc, target);
  return <div className="rule-choices">
    <div className="rule-choices-label">
      <span>Use</span>
      {profiles.length > 1 && <small>in this order: the first with quota left takes the work</small>}
    </div>
    <ol>
      {profiles.map((profile, index) => <ChoiceRow
        key={index}
        doc={doc}
        profile={profile}
        index={index}
        count={profiles.length}
        target={target}
        harnesses={harnesses}
        example={example}
        disabled={disabled}
        onChange={onChange}
        label={`${label}, choice ${index + 1}`}
        removable={removable || profiles.length > 1}
      />)}
    </ol>
    <button type="button" className="rules-add small" disabled={disabled} onClick={() => onChange(addProfile(doc, target, harnesses))}><Plus size={13} /> Add a fallback</button>
  </div>;
}

function ChoiceRow({ doc, profile, index, count, target, harnesses, example, disabled, onChange, label, removable }: { doc: RulesDoc; profile: Profile; index: number; count: number; target: Target; harnesses: HarnessChoice[]; example: RulesDoc | null; disabled: boolean; onChange: (next: RulesDoc) => void; label: string; removable: boolean }) {
  const listId = useId();
  const harness = typeof profile.harness === "string" ? profile.harness : "";
  const model = typeof profile.model === "string" ? profile.model : "";
  const effort = typeof profile.effort === "string" ? profile.effort : "";
  const chosen = harnesses.find((choice) => choice.name === harness);
  const efforts = effortChoices(chosen, model);
  const effortKnown = effort === "" || efforts.some((choice) => choice.effort === effort && choice.allowed) || (!chosen && harness !== "");
  const suggestions = modelSuggestions(harness, doc, example);
  const extra = extraKeys(profile, "profile");
  const set = (field: "harness" | "model" | "effort", value: string) => onChange(setProfileField(doc, target, index, field, value, harnesses));

  return <li className="choice-row" data-testid="choice-row">
    <span className="choice-order" aria-hidden="true">{index + 1}</span>
    <select aria-label={`Harness for ${label}`} value={harness} disabled={disabled} onChange={(event) => set("harness", event.target.value)} className={chosen && !chosen.installed ? "choice-harness missing" : "choice-harness"}>
      {!chosen && <option value={harness}>{harness ? `${harness} (firstmate doesn't know it)` : "Choose a harness"}</option>}
      {harnesses.map((choice) => <option key={choice.name} value={choice.name}>{choice.installed ? choice.name : `${choice.name} (not installed)`}</option>)}
    </select>
    <input type="text" className="choice-model" aria-label={`Model for ${label}`} list={listId} value={model} placeholder="Its default model" spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={disabled} onChange={(event) => set("model", event.target.value)} />
    <datalist id={listId}>{suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}</datalist>
    <select className="choice-effort" aria-label={`Effort for ${label}`} value={effort} disabled={disabled || (chosen !== undefined && efforts.length === 0 && effort === "")} onChange={(event) => set("effort", event.target.value)}>
      <option value="">{chosen && efforts.length === 0 ? "No effort setting" : "Default effort"}</option>
      {efforts.map((choice) => <option key={choice.effort} value={choice.effort} disabled={!choice.allowed}>{choice.allowed ? choice.effort : `${choice.effort} (needs ${choice.needs?.endsWith("*") ? `a ${choice.needs.slice(0, -1)} model` : choice.needs})`}</option>)}
      {!effortKnown && <option value={effort}>{`${effort} (not accepted)`}</option>}
    </select>
    <div className="rule-tools">
      <button type="button" className="icon-button small" title="Try this one earlier" disabled={disabled || index === 0} onClick={() => onChange(moveProfile(doc, target, index, -1))}><ArrowUp size={14} /></button>
      <button type="button" className="icon-button small" title="Try this one later" disabled={disabled || index === count - 1} onClick={() => onChange(moveProfile(doc, target, index, 1))}><ArrowDown size={14} /></button>
      <button type="button" className="icon-button small" title="Remove this choice" disabled={disabled || !removable} onClick={() => onChange(removeProfile(doc, target, index))}><X size={14} /></button>
    </div>
    {chosen && !chosen.installed && <p className="choice-note"><CircleAlert size={13} /> {chosen.name} is not installed on this Mac, so the first mate cannot start it until it is.</p>}
    {!chosen && harness !== "" && <p className="choice-note"><CircleAlert size={13} /> Firstmate doesn't know a harness called {harness}; choose one it does.</p>}
    {!effortKnown && <p className="choice-note"><CircleAlert size={13} /> {harness} does not take the effort {effort}{model ? ` with ${model}` : ""}; choose another.</p>}
    {extra.length > 0 && <p className="rule-extra">Also sets {listed(extra)}, kept as it is.</p>}
  </li>;
}
