// How the composer reads the first mate's session: the slash palette, drawn from the commands the session
// advertises, and the model and effort it offers. Nothing here keeps a list of its own; every name, hint and value
// comes from the adapter through the host (src-tauri/src/controls.rs).
import type { PickedCategory, SessionCommand, SessionControls, SessionOption } from "./host/types";

/** What the palette shows for a draft: nothing, the matching commands, or why there are none. */
export type Palette =
  | { open: false }
  | { open: true; query: string; kind: "list"; matches: SessionCommand[] }
  /** No list has arrived yet: the first mate is still starting, or not running. */
  | { open: true; query: string; kind: "waiting" }
  /** The session advertised an empty list. */
  | { open: true; query: string; kind: "none" }
  | { open: true; query: string; kind: "no_match" };

/** The name a command sorts by: A to Z on its letters, so a leading mark does not put it first. */
function sortKey(name: string) {
  return name.replace(/^[^a-z0-9]+/i, "").toLowerCase();
}

/** Every command, A to Z. */
export function sortedCommands(commands: SessionCommand[]) {
  return [...commands].sort((a, b) => {
    const [x, y] = [sortKey(a.name), sortKey(b.name)];
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * The palette for a draft and caret. It opens only while the draft starts with `/` and the caret is still in its
 * first word, and lists the commands whose name starts with what follows the slash.
 */
export function palette(draft: string, caret: number, commands: SessionCommand[] | null): Palette {
  if (!draft.startsWith("/")) return { open: false };
  const end = draft.search(/\s/);
  const wordEnd = end < 0 ? draft.length : end;
  if (caret < 1 || caret > wordEnd) return { open: false };
  const query = draft.slice(1, wordEnd);
  if (commands === null) return { open: true, query, kind: "waiting" };
  if (commands.length === 0) return { open: true, query, kind: "none" };
  const wanted = query.toLowerCase();
  const matches = sortedCommands(commands).filter((command) => command.name.toLowerCase().startsWith(wanted));
  return matches.length ? { open: true, query, kind: "list", matches } : { open: true, query, kind: "no_match" };
}

/** What choosing a command puts in the composer: its name and a space, ready for its argument. Never sent by itself. */
export function fill(command: SessionCommand) {
  return `/${command.name} `;
}

/** The argument hint to show after a chosen command, while the draft is still exactly what choosing it wrote. */
export function ghostHint(draft: string, commands: SessionCommand[] | null) {
  const match = /^\/(\S+) $/.exec(draft);
  if (!match || !commands) return null;
  return commands.find((command) => command.name === match[1])?.hint ?? null;
}

/**
 * The commands that set what a control shows. Sent as text they work, but the session's own options never hear of
 * it, so the control would keep showing the old value and the app would apply it again at the next start. The
 * palette opens the control instead, when the session offers one.
 */
const ROUTES: Record<string, PickedCategory> = { model: "model", effort: "thought_level" };

export function routeOf(command: SessionCommand, controls: SessionControls | null): PickedCategory | null {
  const category = ROUTES[command.name];
  return category && optionOf(controls, category) ? category : null;
}

/** The session's option of a category, when it offers one. */
export function optionOf(controls: SessionControls | null, category: PickedCategory): SessionOption | null {
  return controls?.options?.find((option) => option.category === category) ?? null;
}

/** A value's name as the session gives it, without the adapter's "(recommended)". */
export function valueName(option: SessionOption, value: string) {
  const entry = option.options.find((candidate) => candidate.value === value);
  return (entry?.name ?? value).replace(/\s*\(recommended\)$/i, "");
}

/** Its description's lead, without a trailing parenthesis: "Opus (1M context)" reads "Opus". */
function descriptionLead(description: string | undefined) {
  return (description ?? "").split(" · ")[0].replace(/\s*\([^)]*\)$/, "").trim();
}

/** How a pill names a value. The model's Default says which model that is, as the session describes it. */
export function valueLabel(option: SessionOption, value: string) {
  const name = valueName(option, value);
  const entry = option.options.find((candidate) => candidate.value === value);
  const lead = value === "default" && option.category === "model" ? descriptionLead(entry?.description) : "";
  return lead && lead !== name ? `${name} · ${lead}` : name;
}

/**
 * A typed `/model <x>` or `/effort <x>` whose argument the session offers, by value or by name: the composer sets it
 * through the control rather than sending words the session's options would never hear of.
 */
export function typedSetting(draft: string, controls: SessionControls | null): { category: PickedCategory; value: string } | null {
  const match = /^\/(model|effort)\s+(\S+)\s*$/i.exec(draft.trim());
  if (!match) return null;
  const category = ROUTES[match[1].toLowerCase()];
  const option = optionOf(controls, category);
  if (!option) return null;
  const wanted = match[2].toLowerCase();
  const entry = option.options.find((candidate) => candidate.value.toLowerCase() === wanted)
    ?? option.options.find((candidate) => valueName(option, candidate.value).toLowerCase() === wanted);
  return entry ? { category, value: entry.value } : null;
}

/** What the pill of a category says about the session right now. */
export type PillState =
  /** No session has stated its options yet. */
  | { kind: "unknown" }
  /** The session states options but none of this category: an adapter without it, or a model without efforts. */
  | { kind: "absent" }
  | { kind: "value"; option: SessionOption; label: string; pending: string | null };

export function pillState(controls: SessionControls | null, category: PickedCategory): PillState {
  if (!controls?.options) return { kind: "unknown" };
  const option = optionOf(controls, category);
  if (!option) return { kind: "absent" };
  const pending = controls.pending?.category === category ? controls.pending.value : null;
  return { kind: "value", option, label: valueLabel(option, option.currentValue), pending };
}

/** The label the first mate's session gives a category, for the captain's words: "Model", "Effort". */
export function categoryName(category: PickedCategory) {
  return category === "model" ? "Model" : "Effort";
}
