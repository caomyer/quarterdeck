// How the usage panel reads the first mate's context window and every provider's plan limits.
// Two separate readings: the context is this conversation's headroom, reported by the first mate's
// session after every turn; plan limits belong to each account and come from quota-axi. The panel
// never mixes their numbers, and a reading it does not have says so rather than showing 0%.

import type { ContextReading, QuotaProvider, QuotaRead, QuotaWindow, RateLimit } from "./host/types";

/** How loud a number is: quiet, amber, or coral. */
export type Level = "" | "warn" | "over";

/** Past this share of the context window the first mate will compact on its own soon. */
export const CONTEXT_WARN = 75;
/** Past this share of a plan window a provider is close to its limit. */
export const WINDOW_WARN = 80;

export function contextPercent(context: ContextReading | null) {
  if (!context || context.used == null || !context.size) return null;
  return (context.used / context.size) * 100;
}

export function contextLevel(percent: number | null): Level {
  return percent != null && percent >= CONTEXT_WARN ? "warn" : "";
}

export function windowLevel(used: number | null): Level {
  if (used == null) return "";
  if (used >= 100) return "over";
  return used >= WINDOW_WARN ? "warn" : "";
}

/** A token count at a glance: 950, 71k, 1M, 1.5M. */
export function tokens(count: number) {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

/** Every digit, for the popover: 70,979. */
export function tokensExact(count: number) {
  return count.toLocaleString("en-US");
}

export function percent(value: number) {
  return `${Math.round(value)}%`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long until a time: 38m, 1h 35m, 2d 23h. A week or more away reads as its date. */
export function until(at: number, now: number) {
  const left = at - now;
  if (left < MINUTE) return "a moment";
  if (left >= 7 * DAY) return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  const minutes = Math.floor((left % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

/** How long ago: just now, 3m ago, 2h ago, 3d ago. */
export function ago(at: number, now: number) {
  const past = now - at;
  if (past < MINUTE) return "just now";
  if (past < HOUR) return `${Math.floor(past / MINUTE)}m ago`;
  if (past < DAY) return `${Math.floor(past / HOUR)}h ago`;
  return `${Math.floor(past / DAY)}d ago`;
}

export type WindowView = { key: string; label: string; used: number | null; resetsAt: number | null; level: Level };

/**
 * One provider's row. `live` is a fresh, established reading; `early` a fresh one quota-axi is not yet sure of;
 * `stale` the last good numbers after a failed read; `partial` what the first mate's session knows when quota-axi
 * has no numbers; `refused` a provider refusing turns until a window resets; `needs_auth` and `unavailable` no
 * numbers, with quota-axi's words for why.
 */
export type ProviderView = {
  id: string;
  name: string;
  plan: string | null;
  glyph: string;
  state: "live" | "early" | "stale" | "partial" | "refused" | "needs_auth" | "unavailable";
  windows: WindowView[];
  /** The window that binds: the most used, or the one the session named when none has a number. */
  binding: WindowView | null;
  /** What the first mate's session says, when that is all there is or when it is refusing. */
  status: string | null;
  /** quota-axi's words for what is missing or wrong. */
  words: string | null;
  /** The command quota-axi says fixes it. */
  remedy: string | null;
  /** The fix is allowing quota-axi to read the Keychain, which the app can ask for. */
  keychain: boolean;
  /** When stale numbers were read. */
  readAt: number | null;
};

export const KEYCHAIN_REMEDY = "quota-axi --allow-keychain-prompt";

const GLYPHS: Record<string, string> = { claude: "CL", codex: "CX", cursor: "CU" };
const SESSION_WINDOWS: Record<string, string> = { five_hour: "5h", seven_day: "wk" };

/** A window's short name: 5h, wk, Fable wk, included. */
export function windowLabel(window: QuotaWindow) {
  if (window.id === "five_hour" || window.kind === "session") return "5h";
  if (window.kind === "weekly") return "wk";
  const label = window.label ?? window.id ?? "";
  if (window.kind === "model") return label.replace(/\s*week$/i, " wk");
  return label.replace(/\s+usage$/i, "");
}

function time(value: string | null | undefined) {
  const at = value ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : at;
}

function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function bindingWindow(windows: WindowView[]) {
  const measured = windows.filter((window) => window.used != null);
  if (!measured.length) return windows[0] ?? null;
  return measured.reduce((most, window) => (window.used! > most.used! || (window.used === most.used && (window.resetsAt ?? Infinity) < (most.resetsAt ?? Infinity)) ? window : most));
}

function windowViews(provider: QuotaProvider, now: number): WindowView[] {
  return provider.windows.map((window, index) => {
    const resetsAt = time(window.resets_at);
    // A window whose reset has passed started over; quota-axi reads it again on the next pass.
    const used = resetsAt != null && resetsAt <= now ? 0 : window.used;
    return { key: window.id ?? String(index), label: windowLabel(window), used, resetsAt, level: windowLevel(used) };
  });
}

/** What the first mate's own session says about Claude, when it is recent enough to still hold. */
function sessionLimit(limit: RateLimit | null, now: number) {
  if (!limit?.resetsAt || limit.resetsAt * 1000 <= now) return null;
  return limit;
}

function sessionStatus(limit: RateLimit) {
  if (limit.status === "rejected") return "Refused";
  if (limit.status === "allowed_warning") return "Near its limit";
  return "Under its limit";
}

function claudeView(provider: QuotaProvider | undefined, limit: RateLimit | null, read: QuotaRead | null, now: number): ProviderView | null {
  const session = sessionLimit(limit, now);
  if (!provider && !session) return null;
  const base = provider ? quotaView(provider, read, now) : null;
  const refused = session?.status === "rejected";
  if (base && base.windows.length) {
    if (!refused) return base;
    return { ...base, state: "refused", status: "Refused until it resets", binding: base.binding && { ...base.binding, level: "over", resetsAt: session!.resetsAt! * 1000 } };
  }
  if (!session) return base;
  const window: WindowView = {
    key: session.rateLimitType ?? "session",
    label: SESSION_WINDOWS[session.rateLimitType ?? ""] ?? session.rateLimitType ?? "limit",
    used: null,
    resetsAt: session.resetsAt! * 1000,
    level: refused ? "over" : session.status === "allowed_warning" ? "warn" : "",
  };
  return {
    id: "claude",
    name: base?.name ?? "Claude",
    plan: base?.plan ?? null,
    glyph: GLYPHS.claude,
    state: refused ? "refused" : "partial",
    windows: [window],
    binding: window,
    status: sessionStatus(session),
    words: base?.words ?? null,
    remedy: base?.remedy ?? null,
    keychain: base?.keychain ?? false,
    readAt: null,
  };
}

function quotaView(provider: QuotaProvider, read: QuotaRead | null, now: number): ProviderView {
  const id = provider.id ?? provider.label ?? "provider";
  const name = provider.label ?? capitalize(id);
  const windows = windowViews(provider, now);
  const stale = windows.length > 0 && (provider.stale || provider.status === "stale" || Boolean(read?.error));
  const state: ProviderView["state"] = windows.length
    ? stale ? "stale" : provider.confidence === "early" ? "early" : "live"
    : provider.status === "auth_required" ? "needs_auth" : "unavailable";
  return {
    id,
    name,
    plan: provider.plan ? capitalize(provider.plan) : null,
    glyph: GLYPHS[id] ?? name.slice(0, 2).toUpperCase(),
    state,
    windows,
    binding: bindingWindow(windows),
    status: null,
    words: windows.length ? null : provider.error ?? provider.reason ?? provider.status,
    remedy: provider.remedy,
    keychain: provider.remedy === KEYCHAIN_REMEDY,
    readAt: stale ? time(provider.refreshed_at) ?? read?.read_at_ms ?? null : null,
  };
}

/**
 * The providers worth a row, and the rest folded into one line. Claude always shows, since the first mate runs on it;
 * so does any provider with numbers, and any whose fix quota-axi names. Providers the captain has never set up are
 * noise in a glance, so they are only listed, in quota-axi's words, when the captain opens that line.
 */
export function providerViews(read: QuotaRead | null, limit: RateLimit | null, now: number) {
  const providers = read?.providers ?? [];
  const claude = claudeView(providers.find((provider) => provider.id === "claude"), limit, read, now);
  const rest = providers.filter((provider) => provider.id !== "claude").map((provider) => quotaView(provider, read, now));
  const worth = (view: ProviderView) => view.windows.length > 0 || view.remedy != null;
  return {
    shown: [...(claude ? [claude] : []), ...rest.filter(worth)],
    others: rest.filter((view) => !worth(view)).map((view) => ({ name: view.name, words: view.words ?? "not set up" })),
  };
}

/** What the strip shows for plan limits: the first mate's own provider, and any other only once it is close to a limit. */
export function stripProviders(shown: ProviderView[]) {
  return shown.filter((view, index) => (index === 0 && view.id === "claude") || ((view.binding?.level ?? "") !== "" && view.state !== "stale"));
}

/**
 * One line on a provider in the strip, which has room for about twenty characters: `20% 5h · 1h 35m`,
 * `limit · back in 52m`, `under limit 1h 35m`, and for stale numbers their age in place of the reset.
 * `joined`: the detail follows the value without a separator, as one phrase.
 */
export function stripLine(view: ProviderView, now: number) {
  const window = view.binding;
  const reset = window?.resetsAt != null ? until(window.resetsAt, now) : null;
  if (view.state === "refused") return { value: "limit", detail: reset ? `back in ${reset}` : "", joined: false };
  if (!window || window.used == null) {
    if (view.status) return { value: view.status === "Near its limit" ? "near limit" : "under limit", detail: reset ?? "", joined: true };
    return { value: view.state === "needs_auth" ? "needs sign-in" : "no reading", detail: "", joined: false };
  }
  const tilde = view.state === "early" ? "~" : "";
  const age = view.state === "stale" && view.readAt ? ago(view.readAt, now) : null;
  const detail = age?.endsWith(" ago") ? `${age.slice(0, -" ago".length)} old` : reset ?? "";
  return { value: `${tilde}${percent(window.used)} ${window.label}`, detail, joined: false };
}

/** What happened to the conversation's context that the reading alone would not explain. */
export function contextEvent(context: ContextReading | null, now: number) {
  if (context?.compacted) {
    const { from, to, at_ms: at } = context.compacted;
    return `Compacted ${ago(at, now)}: ${tokens(from)} down to ${tokens(to)}`;
  }
  if (context?.resumed && context.used != null) return "A resumed session: this reading carries its earlier conversation";
  return null;
}
