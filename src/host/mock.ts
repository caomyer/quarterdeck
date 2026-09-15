import bearingsFixture from "../fixtures/bearings-snapshot.json";
import fleetFixture from "../fixtures/fleet-snapshot.json";
import recordedStream from "./mock-event-stream.json";
import type {
  BearingsSnapshot,
  FleetSnapshot,
  HostAdapter,
  HostEvent,
  HostEventListener,
  HostRuntimeState,
  HostStateSnapshot,
  OutboxStatus,
  PaneCapture,
} from "./types";

type RecordedEvent = { t_ms: number; type: HostEvent["type"]; payload: Record<string, unknown> };

const TIMING_SCALE = recordedStream.source.timing_scale;

export class MockHostAdapter implements HostAdapter {
  private listeners = new Set<HostEventListener>();
  private timers = new Set<number>();
  private outstanding = new Set<string>();
  private state: HostRuntimeState = "idle";
  private sequence = 0;
  private startupPlayed = false;
  private readonly snapshot = {
    bearings: bearingsFixture as unknown as BearingsSnapshot,
    fleet: fleetFixture as unknown as FleetSnapshot,
  };

  subscribe(listener: HostEventListener) {
    this.listeners.add(listener);
    if (!this.startupPlayed) {
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
    return id;
  }

  async cancelTurn() {
    this.clearTimers();
    this.emit({ type: "state", payload: { state: "idle" } });
  }

  async getState(): Promise<HostStateSnapshot> {
    return { state: { state: this.state }, snapshot: this.snapshot };
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
    if (type === "snapshot") {
      return { type, payload: raw } as HostEvent;
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
