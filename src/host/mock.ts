import bearingsFixture from "../fixtures/bearings-snapshot.json";
import fleetFixture from "../fixtures/fleet-snapshot.json";
import recordedStream from "./mock-event-stream.json";
import type {
  BearingsSnapshot,
  FleetSnapshot,
  HomeStatus,
  HostAdapter,
  HostEvent,
  HostEventListener,
  HostRuntimeState,
  HostStateSnapshot,
  OutboxStatus,
  PaneCapture,
  SnapshotEvent,
} from "./types";

type RecordedEvent = { t_ms: number; type: HostEvent["type"]; payload: Record<string, unknown> };

/** `?slow` replays at recorded speed, so a turn stays on screen long enough to review. */
const TIMING_SCALE = reviewFlag("slow") ? 1 : recordedStream.source.timing_scale;

function reviewFlag(name: string) {
  return new URLSearchParams(window.location.search).has(name);
}

export class MockHostAdapter implements HostAdapter {
  private listeners = new Set<HostEventListener>();
  private timers = new Set<number>();
  private outstanding = new Set<string>();
  private state: HostRuntimeState = reviewFlag("not-started") ? "stopped" : "idle";
  private sequence = 0;
  private startupPlayed = false;
  private homeChosen = false;
  private readonly snapshot = {
    bearings: bearingsFixture as unknown as BearingsSnapshot,
    fleet: fleetFixture as unknown as FleetSnapshot,
  };

  subscribe(listener: HostEventListener) {
    this.listeners.add(listener);
    // The recorded startup starts the first mate, which `?not-started` must not do.
    if (!this.startupPlayed && !reviewFlag("not-started")) {
      this.startupPlayed = true;
      this.play(recordedStream.startup as RecordedEvent[]);
    }
    return () => this.listeners.delete(listener);
  }

  async hostStart() {
    this.emit({ type: "state", payload: { state: "idle" } });
  }

  async hostStop() {
    this.clearTimers();
    this.emit({ type: "state", payload: { state: "dead" } });
  }

  async hostRestart() {
    this.clearTimers();
    const [id] = this.outstanding;
    this.play(recordedStream.restart as RecordedEvent[], id);
  }

  async send(_text: string) {
    const id = `mock-${++this.sequence}`;
    this.outstanding.add(id);
    this.emit({ type: "outbox", payload: { id, status: "queued" } });
    this.play(recordedStream.send as RecordedEvent[], id);
    if (reviewFlag("ask")) {
      // `?ask`: the first mate asks for an approval partway through the turn.
      const timer = window.setTimeout(() => this.emit({ type: "permission_request", payload: {
        id: `ask-${id}`,
        title: "cd /Users/mingyucao_1/.buzz/.scratch/fm-probe/firstmate/projects/resonance && \\\n  git push origin fm/res-ai-titles",
        options: [
          { option_id: "allow", name: "Allow", kind: "allow_once" },
          { option_id: "allow_always", name: "Always Allow", kind: "allow_always" },
          { option_id: "reject", name: "Reject", kind: "reject_once" },
        ],
      } }), 400);
      this.timers.add(timer);
    }
    return id;
  }

  async cancelTurn() {
    this.clearTimers();
    this.emit({ type: "state", payload: { state: "idle" } });
  }

  async getState(): Promise<HostStateSnapshot> {
    // `?not-started`: the first mate has not started in any home since launch.
    return { state: { state: this.state }, home: reviewFlag("not-started") ? null : this.snapshot.fleet.fm_home };
  }

  async latestSnapshot(): Promise<SnapshotEvent> {
    if (reviewFlag("snapshot-error")) {
      // `?snapshot-error`: the last Bearings read failed, so what's on screen is from an earlier one.
      return {
        phase: "ready",
        generated_at_ms: Date.now() - 12 * 60_000,
        ...this.snapshot,
        errors: [{ source: "fm-bearings-snapshot.sh", error: "fm-bearings-snapshot.sh exited with exit status: 1: jq: error (at data/backlog.md:0): Cannot iterate over null" }],
      };
    }
    return { phase: "ready", ...this.snapshot };
  }

  /** The browser review path keeps the fixtures, so it reports the fixture's home. `?first-launch` shows the folder question instead. */
  async getHome(): Promise<HomeStatus> {
    if (reviewFlag("first-launch") && !this.homeChosen) return { home: null, problem: null };
    return { home: this.snapshot.fleet.fm_home, problem: null };
  }

  async chooseHome(): Promise<HomeStatus | null> {
    this.homeChosen = true;
    return this.getHome();
  }

  async answerPermission(id: string, optionId: string) {
    this.emit({ type: "permission_resolved", payload: { id, option_id: optionId } });
  }

  async refreshSnapshot() {
    this.emit({ type: "snapshot", payload: { phase: "ready", ...this.snapshot } });
  }

  async paneCapture(taskId: string): Promise<PaneCapture> {
    return {
      text: `task: ${taskId}\nsource: mock pane capture\nstatus: waiting for a fresh worker sighting`,
      observed_at: new Date().toISOString(),
    };
  }

  private play(events: RecordedEvent[], id?: string) {
    const startedAt = events.at(0)?.t_ms ?? 0;
    for (const item of events) {
      const timer = window.setTimeout(() => {
        const payload = JSON.parse(JSON.stringify(item.payload).replaceAll("$id", id ?? "")) as Record<string, unknown>;
        if (item.type === "snapshot" && payload.phase === "ready") {
          payload.bearings = this.snapshot.bearings;
          payload.fleet = this.snapshot.fleet;
          payload.projects = [
            { name: "resonance", mode: "no-mistakes", yolo: false, description: "Desktop podcast tools" },
            { name: "foreman", mode: "direct-PR", yolo: true, description: "Agent supervision" },
          ];
        }
        const event = this.normalize(item.type, payload);
        this.emit(event);
        if (event.type === "outbox" && event.payload.status === "picked_up") this.outstanding.delete(event.payload.id);
      }, Math.round((item.t_ms - startedAt) * TIMING_SCALE));
      this.timers.add(timer);
    }
  }

  private normalize(type: HostEvent["type"], raw: Record<string, unknown>): HostEvent {
    if (type === "text") {
      return { type, payload: { chunk: String(raw.text ?? raw.chunk ?? ""), origin: (raw.origin ?? "prompt_or_agent") as "prompt" | "agent" | "prompt_or_agent" } };
    }
    if (type === "outbox") {
      return { type, payload: { id: String(raw.id), status: (raw.state ?? raw.status) as OutboxStatus, resent_after_restart: raw.resent_after_restart === true } };
    }
    if (type === "tool_call" || type === "tool_update") {
      return { type, payload: { id: String(raw.toolCallId), title: raw.title as string | undefined, kind: raw.kind as string | undefined, status: raw.status as string | undefined } };
    }
    return { type, payload: raw } as HostEvent;
  }

  private emit(event: HostEvent) {
    if (event.type === "state") this.state = event.payload.state;
    this.listeners.forEach((listener) => listener(event));
  }

  private clearTimers() {
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.timers.clear();
  }
}
