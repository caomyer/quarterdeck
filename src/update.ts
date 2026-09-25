import type { AppUpdate, HostRuntimeState } from "./host/types";

/** What the sidebar says about the app's own update: one line, a detail under it, and what the button does. */
export type UpdateView = {
  kind: "ready" | "waiting" | "installing" | "failed" | "installed";
  title: string;
  detail: string;
  /** The button's words, or `null` for none. */
  action: string | null;
  /** The release's notes, behind "What's new". */
  notes: string | null;
};

const BUSY: HostRuntimeState[] = ["prompt_turn", "agent_turn", "starting", "restarting"];

/**
 * Nothing at all until there is something to act on or to read: an update waiting, a restart under way or failed,
 * or what the last one brought. An update to act on comes before the note about the last one.
 */
export function updateView(update: AppUpdate | null, runtime: HostRuntimeState): UpdateView | null {
  if (!update) return null;
  const version = update.version ?? "";
  if (update.state === "ready") {
    return {
      kind: "ready",
      title: `Update ready: ${version}`,
      detail: BUSY.includes(runtime) ? "Restarts once the current turn ends. Or it installs when you quit." : "Restart to use it, or it installs when you quit.",
      action: "Restart",
      notes: update.notes,
    };
  }
  if (update.state === "waiting") return { kind: "waiting", title: "Waiting for the current turn to end", detail: `Then restarts into ${version}.`, action: "Cancel", notes: null };
  if (update.state === "installing") return { kind: "installing", title: `Installing ${version}…`, detail: "The app restarts in a moment, and so does the first mate.", action: null, notes: null };
  if (update.state === "failed") {
    return { kind: "failed", title: `Couldn't install ${version}`, detail: `${update.error ?? "It gave no reason"}. This version keeps running.`, action: "Try again", notes: update.notes };
  }
  if (update.installed) {
    const from = update.installed.from;
    return { kind: "installed", title: `Updated to ${update.installed.version}`, detail: `${from ? `From ${from}. ` : ""}Your home and its settings are as you left them.`, action: "Dismiss", notes: update.installed.notes };
  }
  return null;
}

/** The line about looking for an update, and the button that looks now, or `null` for no button while nothing can be done. */
export type CheckView = {
  kind: "off" | "checking" | "current" | "unchecked" | "failed";
  title: string;
  detail: string;
  action: string | null;
};

/**
 * What the sidebar says about looking for an update while none is held: a build that never looks says so, a check
 * running says what it is doing, and otherwise when it last looked, or why that failed, with a button to look now.
 * Nothing while an update is held: the notice above says that, and restarting is the thing to do. `ago` says how long
 * ago a time was, as the rest of the sidebar says it (`ago` in src/usage.ts).
 */
export function checkView(update: AppUpdate | null, ago: (at: number) => string): CheckView | null {
  if (!update || update.state !== "none") return null;
  if (!update.enabled) return { kind: "off", title: "This build does not update", detail: `${update.current} · updates are off for this build`, action: null };
  if (update.checking) {
    return update.downloading
      ? { kind: "checking", title: `Downloading ${update.downloading}…`, detail: "Its signature is checked before it is kept", action: null }
      : { kind: "checking", title: "Checking for updates…", detail: update.current, action: null };
  }
  const at = update.checked_at_ms ? ago(update.checked_at_ms) : null;
  if (update.check_error) {
    return { kind: "failed", title: "Couldn't check for updates", detail: `${update.check_error.replace(/\.$/, "")}${at ? ` · tried ${at}` : ""}`, action: "Try again" };
  }
  if (!at) return { kind: "unchecked", title: "Not checked yet", detail: update.current, action: "Check now" };
  return { kind: "current", title: "Up to date", detail: `${update.current} · checked ${at}`, action: "Check now" };
}

/**
 * The backend's word on the update, newest last. Events arrive in the order the backend sent them, and every change a
 * command makes is also sent as one, so an event always applies. A command's reply travels another way and can land
 * after an event sent later: it applies only when no event arrived while it was asked.
 */
export function updateFeed(apply: (update: AppUpdate) => void) {
  let events = 0;
  return {
    event(update: AppUpdate) {
      events += 1;
      apply(update);
    },
    async reply(ask: () => Promise<AppUpdate>) {
      const before = events;
      const next = await ask();
      if (events === before) apply(next);
    },
  };
}
