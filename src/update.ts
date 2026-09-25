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
