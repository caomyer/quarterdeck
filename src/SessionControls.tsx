// The composer's hold on the first mate's session: the slash palette, the Model and Effort pills, the Calm switch,
// and the working row Calm draws in the chat. Every list comes from the session through the host; src/sessionctl.ts
// reads it, and src/calm.ts says what Calm hides.
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { elapsed } from "./calm";
import type { CalmRead, PickedCategory, SessionCommand, SessionControls, SessionOption } from "./host/types";
import { categoryName, type Palette, pillState, routeOf, unfitReason, valueLabel, valueName } from "./sessionctl";

/** One line of the palette's header: how many commands, and what the keys do. */
function paletteHead(state: Extract<Palette, { kind: "list" }>, route: PickedCategory | null) {
  const count = state.matches.length;
  const what = state.query
    ? `${count} ${count === 1 ? "command starts" : "commands start"} with /${state.query}`
    : `${count} ${count === 1 ? "command" : "commands"} this session offers`;
  const keys = route ? `Tab or ⏎ opens ${categoryName(route)}` : "↑↓ move · Tab or ⏎ fills · Esc closes";
  return { what, keys };
}

/** The palette above the composer: the commands the session advertised, or why there are none. */
export function SlashPalette({ state, active, controls, onHover, onChoose }: { state: Palette; active: number; controls: SessionControls | null; onHover: (index: number) => void; onChoose: (command: SessionCommand) => void }) {
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(".slash-command.active")?.scrollIntoView({ block: "nearest" });
  }, [active, state]);
  if (!state.open) return null;
  if (state.kind !== "list") {
    const [title, body] = state.kind === "waiting"
      ? ["Commands appear once the first mate has started.", "Its session sends the list a moment after it opens."]
      : state.kind === "none"
        ? ["This first mate offers no commands.", "Anything you type is sent as an ordinary message."]
        : state.query.toLowerCase() === "calm"
          ? [`No command starts with /${state.query}.`, "Calm is the switch beside Model and Effort, under the draft. Sent as text, the session only answers “Unknown command: /calm”."]
          : [`No command starts with /${state.query}.`, "⏎ sends it to the first mate as an ordinary message."];
    return <div className="slash-palette" role="status" data-kind={state.kind}><div className="palette-empty"><b>{title}</b>{body}</div></div>;
  }
  const route = routeOf(state.matches[active] ?? state.matches[0], controls);
  const head = paletteHead(state, route);
  return <div className="slash-palette" data-kind="list">
    <div className="palette-head"><span>{head.what}</span><span className="palette-keys">{head.keys}</span></div>
    <ul ref={list} role="listbox" id="slash-palette" aria-label="Commands">{state.matches.map((command, index) => {
      const opens = routeOf(command, controls);
      return <li key={command.name} id={`slash-${index}`} role="option" aria-selected={index === active} className={`slash-command ${index === active ? "active" : ""}`}
        onMouseEnter={() => onHover(index)} onMouseDown={(event) => { event.preventDefault(); onChoose(command); }}>
        <span className="slash-name">/{command.name}</span>
        {command.hint && <span className="slash-hint">{command.hint}</span>}
        <span className="slash-desc">{opens && <em>Opens the {categoryName(opens)} control · </em>}{command.description}</span>
      </li>;
    })}</ul>
  </div>;
}

/** The argument hint after a chosen command, drawn behind the draft until the captain types over it. */
export function GhostHint({ draft, hint }: { draft: string; hint: string | null }) {
  if (!hint) return null;
  return <div className="composer-ghost" aria-hidden="true"><span>{draft}</span>{hint}</div>;
}

/** What went wrong with a change, shown under the composer bar until the next change or a dismissal. */
export type SessionNotice =
  | { kind: "refused"; category: PickedCategory; value: string; reason: string }
  | { kind: "calm"; problem: string }
  | { kind: "not-live"; category: PickedCategory; value: string };

const GONE = "the first mate's session has ended";

function SettingMenu({ category, option, controls, onChoose, onClose }: { category: PickedCategory; option: SessionOption; controls: SessionControls; onChoose: (value: string) => void; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button[aria-checked=true]:not(:disabled), button:not(:disabled)")?.focus();
    const away = (event: MouseEvent) => { if (!menu.current?.parentElement?.contains(event.target as Node)) onClose(); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);
  const model = category === "model" ? null : controls.options?.find((candidate) => candidate.category === "model");
  const head = category === "model" ? "Applies from the next message · kept for this home" : `Effort for ${model ? valueLabel(model, model.currentValue) : "this model"} · applies from the next message`;
  const foot = category === "model" ? "The list is the one the first mate's session offers; the app keeps none of its own." : "Levels come from the model the session is on.";
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return <div className="session-menu" ref={menu} role="menu" aria-label={categoryName(category)} onKeyDown={onKeyDown}>
    <div className="session-menu-head">{head}</div>
    <ul>{option.options.map((entry) => {
      const unfit = unfitReason(controls, category, entry.value);
      const current = entry.value === option.currentValue;
      return <li key={entry.value}><button role="menuitemradio" aria-checked={current} disabled={Boolean(unfit)} onClick={() => onChoose(entry.value)}>
        <span>{valueName(option, entry.value)}</span>
        {(unfit || entry.description) && <small>{unfit ?? entry.description}</small>}
        {current && <Check size={14} className="session-tick" aria-hidden="true" />}
      </button></li>;
    })}</ul>
    <div className="session-menu-foot">{foot}</div>
  </div>;
}

/** A Model or Effort pill, with its menu. It shows only what the adapter last confirmed; a change on its way waits beside it. */
function SettingPill({ category, controls, live, open, failed, onOpen, onClose, onChoose }: { category: PickedCategory; controls: SessionControls | null; live: boolean; open: boolean; failed: boolean; onOpen: () => void; onClose: () => void; onChoose: (value: string) => void }) {
  const state = pillState(controls, category);
  const name = categoryName(category);
  if (state.kind === "unknown") {
    return <span className="session-pill off" title={`The first mate's session says which ${category === "model" ? "models" : "effort levels"} it offers once it starts.`}><span className="k">{name}</span><span>—</span></span>;
  }
  if (state.kind === "absent") {
    const model = controls?.options?.find((option) => option.category === "model");
    const why = category === "thought_level" && model ? `none for ${valueName(model, model.currentValue)}` : "not offered by this first mate";
    return <span className="session-pill off" data-category={category} title={category === "thought_level" ? "This model offers no effort setting. Switching to one that does brings Effort back, at the level you last chose." : "This first mate's session offers no model setting."}><span className="k">{name}</span><span>{why}</span></span>;
  }
  const pending = state.pending ? valueName(state.option, state.pending) : null;
  const title = pending ? `Switching to ${pending}…` : !live ? `${name}: ${state.label}. The first mate isn't running; your pick is applied again when it starts.` : `${name}: ${state.label}. Applies from the next message.`;
  return <span className="session-pill-wrap">
    <button className={`session-pill ${open ? "open" : ""} ${pending ? "busy" : ""} ${failed ? "bad" : ""}`} data-category={category} aria-haspopup="menu" aria-expanded={open} disabled={!live || Boolean(pending)} title={title} onClick={() => open ? onClose() : onOpen()}>
      <span className="k">{name}</span><span className="v">{state.label}</span>{pending ? <span className="session-spin" aria-label={title} /> : <ChevronDown size={12} className="chev" aria-hidden="true" />}
    </button>
    {open && controls && <SettingMenu category={category} option={state.option} controls={controls} onChoose={onChoose} onClose={onClose} />}
  </span>;
}

/** The Calm switch: how this window reads, so it sits with the settings and sends nothing to the first mate. */
export function CalmPill({ calm, saving, failed, onToggle }: { calm: CalmRead | null; saving: boolean; failed: boolean; onToggle: () => void }) {
  const on = calm?.available === true && calm.on;
  const unavailable = calm !== null && !calm.available;
  const title = unavailable ? calm.problem ?? "Calm needs a newer firstmate." : on
    ? "Calm is on: the chat keeps the conversation and hides the first mate's steps and working notes, with one working row while it works. Changes nothing the first mate does."
    : "Calm is off: every step and working note shows. The same choice /calm sets in a terminal on this home.";
  return <button className={`session-pill calm-pill ${unavailable ? "dis" : ""} ${failed ? "bad" : ""}`} role="switch" aria-checked={on} aria-label="Calm" disabled={calm === null || unavailable || saving} title={title} onClick={onToggle}>
    <span>Calm</span><span className={`calm-switch ${on ? "on" : ""}`}><i /></span>
  </button>;
}

/** Model and Effort, in the composer bar. */
export function SessionPills({ controls, live, openMenu, notice, onOpen, onChoose }: { controls: SessionControls | null; live: boolean; openMenu: PickedCategory | null; notice: SessionNotice | null; onOpen: (menu: PickedCategory | null) => void; onChoose: (category: PickedCategory, value: string) => void }) {
  const failed = (category: PickedCategory) => notice?.kind === "refused" && notice.category === category;
  const model = pillState(controls, "model");
  return <>
    <SettingPill category="model" controls={controls} live={live} open={openMenu === "model"} failed={failed("model")} onOpen={() => onOpen("model")} onClose={() => onOpen(null)} onChoose={(value) => onChoose("model", value)} />
    {model.kind !== "absent" && <SettingPill category="thought_level" controls={controls} live={live} open={openMenu === "thought_level"} failed={failed("thought_level")} onOpen={() => onOpen("thought_level")} onClose={() => onOpen(null)} onChoose={(value) => onChoose("thought_level", value)} />}
  </>;
}

/** The lines under the composer bar: a change that failed, a pick not applied at start, or a Calm that cannot be kept. */
export function SessionNotices({ controls, calm, notice, dismissedProblems, onRetry, onRestart, onDismiss, onDismissProblem }: { controls: SessionControls | null; calm: CalmRead | null; notice: SessionNotice | null; dismissedProblems: string[]; onRetry: () => void; onRestart: () => void; onDismiss: () => void; onDismissProblem: (key: string) => void }) {
  const lines: React.ReactNode[] = [];
  if (notice?.kind === "refused") {
    const option = controls?.options?.find((candidate) => candidate.category === notice.category);
    const name = option ? valueName(option, notice.value) : notice.value;
    if (notice.reason === GONE) {
      lines.push(<p key="refused" className="session-notice" role="alert"><b>Couldn't change {categoryName(notice.category).toLowerCase()}:</b> the first mate's session has ended. Nothing changed. Restart the first mate, then choose again. <button className="link-button" onClick={onRestart}>Restart</button></p>);
    } else if (unfitReason(controls, notice.category, notice.value)) {
      lines.push(<p key="refused" className="session-notice" role="alert"><b>Couldn't switch to {name}.</b> {notice.reason}. <button className="link-button" onClick={onDismiss}>Dismiss</button></p>);
    } else {
      const still = option ? ` It is still on ${valueLabel(option, option.currentValue)}.` : "";
      lines.push(<p key="refused" className="session-notice" role="alert"><b>Couldn't switch to {name}.</b> The first mate said: “{notice.reason}”.{still} <button className="link-button" onClick={onRetry}>Try again</button></p>);
    }
  }
  if (notice?.kind === "not-live") {
    const option = controls?.options?.find((candidate) => candidate.category === notice.category);
    lines.push(<p key="not-live" className="session-notice" role="status"><b>{categoryName(notice.category)} can't change yet.</b> The switch to {option ? valueName(option, notice.value) : notice.value} can be made once the first mate is running, so nothing was sent. <button className="link-button" onClick={onDismiss}>Dismiss</button></p>);
  }
  if (notice?.kind === "calm") {
    lines.push(<p key="calm" className="session-notice" role="alert"><b>Calm wasn't saved.</b> fm-calm.sh said: “{notice.problem}”. The chat is unchanged. <button className="link-button" onClick={onRetry}>Try again</button></p>);
  }
  for (const [category, problem] of Object.entries(controls?.problems ?? {}) as [PickedCategory, { value: string; reason: string }][]) {
    const key = `${category}:${problem.value}:${problem.reason}`;
    if (!problem || dismissedProblems.includes(key)) continue;
    const option = controls?.options?.find((candidate) => candidate.category === category);
    const now = option ? ` It is on ${valueLabel(option, option.currentValue)}.` : "";
    lines.push(<p key={key} className="session-notice" role="status"><b>Your {categoryName(category).toLowerCase()} pick, {option ? valueName(option, problem.value) : problem.value}, wasn't applied when the first mate started:</b> {problem.reason}.{now} <button className="link-button" onClick={() => onDismissProblem(key)}>Dismiss</button></p>);
  }
  if (calm && !calm.available && calm.problem) lines.push(<p key="calm-missing" className="session-note">{calm.problem}</p>);
  return lines.length ? <div className="session-notices">{lines}</div> : null;
}

function useTick(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * The working row Calm draws as the chat's last line while the first mate works: a small boat on a line of water,
 * then the turn's elapsed time. It is the app's own drawing in its palette, at Calm's slow pace, and it holds still
 * under reduced motion. It inherits nothing from Pi's or Claude Code's terminal sprite.
 */
export function WorkingRow({ since }: { since: number | null }) {
  const now = useTick(1000);
  const took = elapsed(now - (since ?? now));
  return <div className="working-row" role="status" aria-label={`The first mate is working, ${took}`}>
    <span className="working-sea" aria-hidden="true">
      <span className="working-water" />
      <svg className="working-boat" width="22" height="18" viewBox="0 0 22 18"><path className="sail" d="M11 1 L11 12 L4 12 Z M12 3 L12 12 L17 12 Z" /><path className="hull" d="M2 13 H20 L17 17 H5 Z" /></svg>
    </span>
    <time>Working · {took}</time>
  </div>;
}
