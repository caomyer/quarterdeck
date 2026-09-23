import { useEffect, useId, useState } from "react";
import { Check, CircleAlert, KeyRound } from "lucide-react";
import type { HostAdapter, Routing, RoutingStart } from "./host";
import { RulesEditor } from "./RulesEditor";
import { formProblem } from "./rules";

/** firstmate's refusal as a sentence, its reason kept in its own words. */
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const reason = text.replace(/^not saved: /, "");
  if (reason === text) return text.charAt(0).toUpperCase() + text.slice(1);
  if (reason.includes("changed since it was read")) return "Not saved. The rules file changed since it was opened here. Copy your edit, then close and reopen Settings to see the newer rules.";
  return `Not saved. The first mate can't use these rules: ${reason}`;
}

const STARTS: { from: RoutingStart; label: string; detail: string }[] = [
  { from: "restore", label: "The rules you set aside", detail: "Bring back the rules you had when you turned routing off." },
  { from: "template", label: "The example rules", detail: "Grok for fresh news, a cheap Claude model for rote edits, a strong model for big features, and Codex falling back to Claude for the rest." },
  { from: "empty", label: "No rules yet", detail: "Write your own. Until you do, the first mate still chooses for itself." },
];

/**
 * Crew routing, in the settings: rules for which tool and model takes each kind of work, and the optional key for
 * typed dispatch. Everything is read and written through firstmate's own `bin/fm-crew-dispatch.sh`, so the rules are
 * checked by the same test the first mate's startup applies, and the key is never shown once it is saved.
 */
export function RoutingSettings({ host }: { host: HostAdapter }) {
  const [routing, setRouting] = useState<Routing | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [start, setStart] = useState<RoutingStart>("template");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [view, setView] = useState<"form" | "json">("form");
  const ids = useId();

  useEffect(() => {
    let live = true;
    host.routingGet().then((status) => {
      if (!live) return;
      setRouting(status);
      setDraft(status.rules ?? "");
    }, (problem) => live && setLoadProblem(errorText(problem)));
    return () => { live = false; };
  }, [host]);

  const dirty = routing?.on === true && draft !== (routing.rules ?? "");

  /** Takes the writer's answer, keeping an edit in progress unless the change was to the rules themselves. */
  const apply = (next: Routing, rulesChanged: boolean) => {
    setRouting(next);
    if (rulesChanged || !dirty) setDraft(next.rules ?? "");
  };

  const act = async (work: () => Promise<Routing>, rulesChanged: boolean, onError: (text: string) => void = setError) => {
    setBusy(true);
    setError(null);
    setKeyError(null);
    setNotice(null);
    try {
      const next = await work();
      apply(next, rulesChanged);
      return next;
    } catch (problem) {
      onError(errorText(problem));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const beginTurningOn = () => {
    setStart(routing?.setAside ? "restore" : "template");
    setChoosing(true);
    setError(null);
    setNotice(null);
  };

  const turnOn = async () => {
    if (await act(() => host.routingEnable(start), true)) setChoosing(false);
  };

  const turnOff = async () => {
    if (dirty) {
      setError("Save or undo your changes to the rules before turning routing off.");
      return;
    }
    const next = await act(() => host.routingDisable(), true);
    if (next?.setAside) setNotice(`Routing is off. Your rules are kept as config/${next.setAside}, and turning routing on again can bring them back.`);
  };

  const save = async () => {
    if (!routing) return;
    const next = await act(() => host.routingSave(draft, routing.sha256), true);
    if (next) setNotice(next.invalid ? null : "Saved. The first mate uses these rules from its next hand-off.");
  };

  const saveKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    if (await act(() => host.routingSetKey(key), false, setKeyError)) setKey("");
  };

  const clearKey = async () => {
    await act(() => host.routingClearKey(), false, setKeyError);
  };

  const on = routing?.on === true;
  // The form is the way in whenever it can show the rules; JSON is there for what it cannot, and always on request.
  const noHarnesses = routing !== null && routing.harnesses.length === 0 ? "this firstmate does not list its harnesses" : null;
  const formBlocked = on ? noHarnesses ?? formProblem(draft) : null;
  const formReady = formBlocked === null;
  const showForm = view === "form" && formReady;
  const starts = STARTS.filter((option) => option.from !== "restore" || routing?.setAside);

  return <section className="routing" aria-labelledby={`${ids}-title`} data-testid="routing">
    <div className="routing-head">
      <div>
        <h3 id={`${ids}-title`}>Crew routing</h3>
        <p>Rules for which tool and model takes each kind of work. When one has run out of quota, the first mate moves on to the next one a rule lists.</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on || choosing}
        aria-label="Crew routing"
        className="routing-switch"
        disabled={!routing?.available || busy}
        onClick={() => (on ? void turnOff() : choosing ? setChoosing(false) : beginTurningOn())}
      ><span /></button>
    </div>

    {loadProblem && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>Routing could not be read: {loadProblem}</span></div>}
    {routing?.problem && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>{routing.problem}</span></div>}

    {routing?.available && !on && !choosing && <p className="routing-state">Off. The first mate chooses who does each piece of work itself.</p>}

    {choosing && <fieldset className="routing-start" disabled={busy}>
      <legend>Start from</legend>
      {starts.map((option) => <label key={option.from} className={start === option.from ? "chosen" : undefined}>
        <input type="radio" name={`${ids}-start`} value={option.from} checked={start === option.from} onChange={() => setStart(option.from)} />
        <span><strong>{option.label}</strong><small>{option.detail}</small></span>
      </label>)}
      <div className="routing-actions">
        <button type="button" className="routing-primary" onClick={() => void turnOn()}>{busy ? "Turning on…" : "Turn on"}</button>
        <button type="button" className="routing-quiet" onClick={() => setChoosing(false)}>Cancel</button>
      </div>
    </fieldset>}

    {on && routing && <>
      {routing.invalid
        ? <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>The first mate can't use these rules: {routing.invalid}</span></div>
        : <p className="routing-state on"><Check size={15} /> On. The first mate follows these rules when it hands out work.</p>}
      <div className="routing-rules-head">
        <span className="routing-rules-label" id={`${ids}-rules-label`}>Rules <code>config/crew-dispatch.json</code></span>
        <div className="routing-view" role="tablist" aria-label="Edit the rules as">
          <button type="button" role="tab" aria-selected={showForm} disabled={!formReady} title={formBlocked ?? undefined} onClick={() => setView("form")}>Form</button>
          <button type="button" role="tab" aria-selected={!showForm} onClick={() => setView("json")}>JSON</button>
        </div>
      </div>
      {formBlocked && <p className="routing-form-blocked" role="note">The form can't show these rules: {formBlocked}. Edit them as JSON.</p>}
      {showForm
        ? <RulesEditor text={draft} onChange={setDraft} harnesses={routing.harnesses} template={routing.template} disabled={busy} />
        : <textarea
          aria-labelledby={`${ids}-rules-label`}
          className="routing-rules"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />}
      <div className="routing-actions">
        <button type="button" className="routing-primary" disabled={!dirty || busy} onClick={() => void save()}>{busy && dirty ? "Saving…" : "Save rules"}</button>
        {dirty && <button type="button" className="routing-quiet" disabled={busy} onClick={() => { setDraft(routing.rules ?? ""); setError(null); }}>Undo changes</button>}
      </div>
    </>}

    {error && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {notice && <p className="routing-notice" role="status">{notice}</p>}

    {routing?.available && <details className="routing-key">
      <summary><KeyRound size={14} /> Typed dispatch key <em>optional</em></summary>
      <div className="routing-key-body">
        <p>Routing works without it. With a typesafe.ai key, the first mate matches each piece of work to a rule with one quick call instead of reasoning it out itself.</p>
        <p className="routing-key-state" data-testid="routing-key-state">
          {!routing.key.set ? "No key is set." : routing.key.source === "environment" ? "A key is set in the environment the app was started with, so change it there." : "A key is set."}
        </p>
        {routing.key.source !== "environment" && <form onSubmit={(event) => void saveKey(event)}>
          <input
            type="password"
            aria-label="Typed dispatch key"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            placeholder={routing.key.set ? "Paste a new key to replace it" : "Paste your TYPESAFE_API_KEY"}
            value={key}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" className="btn-base" disabled={!key.trim() || busy}>Save key</button>
          {routing.key.set && <button type="button" className="routing-quiet" disabled={busy} onClick={() => void clearKey()}>Remove</button>}
        </form>}
        {keyError && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>{keyError}</span></div>}
        <small>Kept only in this home's private <code>.env</code> file, and never shown again once saved.</small>
      </div>
    </details>}
  </section>;
}
