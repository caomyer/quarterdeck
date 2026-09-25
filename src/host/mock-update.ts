import type { AppUpdate, HostRuntimeState } from "./types";

/** What a release's notes look like: one line per pull request merged since the last one (scripts/release.mjs). */
const NOTES = "- Usage panel: the context window and plan limits, with Compact now (#9)\n- Attach files to a message (#8)\n- Crew routing in Settings (#7)";
const CURRENT = "0.1.41";
const NEXT = "0.1.42";

const none = (): AppUpdate => ({ state: "none", current: CURRENT, version: null, notes: null, error: null, installed: null });

/**
 * The app's own update, as the backend drives it (src-tauri/src/update.rs), for the browser mock. `?update=<state>`:
 * `ready` has one waiting, `late` finds one a moment after the page opens, `fails` has one that cannot be installed,
 * `installed` has just restarted into one. Without it there is no update, and nothing shows.
 *
 * A restart waits while the mock's first mate is in a turn, installs, then comes back as the relaunched app does: on
 * the new version, with a note saying what it brought.
 */
export class MockUpdates {
  private listeners = new Set<(update: AppUpdate) => void>();
  private update: AppUpdate;
  private readonly scenario: string | null;

  constructor(private readonly runtime: () => HostRuntimeState, private readonly later: (ms: number, run: () => void) => void) {
    this.scenario = new URLSearchParams(window.location.search).get("update");
    this.update = none();
    if (this.scenario === "ready" || this.scenario === "fails") this.update = this.ready();
    if (this.scenario === "installed") this.update = { ...none(), current: NEXT, installed: { version: NEXT, from: CURRENT, notes: NOTES } };
    if (this.scenario === "late") this.later(1500, () => this.set(this.ready()));
  }

  private ready(): AppUpdate {
    return { ...none(), state: "ready", version: NEXT, notes: NOTES };
  }

  private set(update: AppUpdate) {
    this.update = update;
    this.listeners.forEach((listener) => listener(update));
  }

  async status() {
    return this.update;
  }

  async restart() {
    if (this.update.state === "none") throw new Error("No update is waiting to be installed.");
    if (this.update.state === "waiting" || this.update.state === "installing") return this.update;
    this.set({ ...this.update, state: "waiting", error: null });
    this.whenIdle();
    return this.update;
  }

  private whenIdle() {
    if (this.update.state !== "waiting") return;
    const busy = ["prompt_turn", "agent_turn", "starting", "restarting"].includes(this.runtime());
    if (busy) {
      this.later(200, () => this.whenIdle());
      return;
    }
    this.set({ ...this.update, state: "installing" });
    this.later(800, () => {
      if (this.scenario === "fails") {
        this.set({ ...this.update, state: "failed", error: "Failed to move the new app into place" });
        return;
      }
      this.set({ ...none(), current: NEXT, installed: { version: NEXT, from: CURRENT, notes: this.update.notes } });
    });
  }

  async cancel() {
    if (this.update.state === "waiting") this.set({ ...this.update, state: "ready" });
    return this.update;
  }

  async seen() {
    this.set({ ...this.update, installed: null });
    return this.update;
  }

  listen(listener: (update: AppUpdate) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
