// The first mate's session controls for the browser review: model, effort, the slash palette and Calm, from the
// payloads claude-agent-acp 0.69.0 really sent (src/fixtures/session-controls.json). A change answers the way the
// adapter answers `session/set_config_option`: with the whole list rebuilt, Haiku offering no effort, and a model
// switch keeping the effort level when the new model has it.
//
//   ?session=<state>
//     (none)    the real payloads: 59 commands, Model and Effort on Default
//     waiting   the session never sends its commands, as while it is still starting
//     empty     the session advertises an empty list
//     none      an adapter that offers no config options at all
//     haiku     the session is on Haiku, which offers no effort
//     slow      a change takes four seconds to be confirmed
//     refuse    the adapter refuses Fable, in its own words
//     gone      the session ended before a change could reach it
//     auto      a home on auto permissions, where Haiku drops the mode and the host puts it back
//     problem   the captain's Sonnet pick could not be applied when the session opened
//   ?calm=on | denied (fm-calm.sh cannot write) | missing (a firstmate that predates fm-calm.sh)
//   ?turn=1..5  one turn held at a moment: 1 sent, 2 first tools, 3 still working, 4 reply arriving, 5 settled
//   ?turn=play  the same turn played through, a few seconds a moment
import captured from "../fixtures/session-controls.json";
import type { CalmRead, HostEvent, PickedCategory, SessionCommand, SessionControls, SessionOption } from "./types";

const scenario = () => new URLSearchParams(window.location.search).get("session");

/** As the host keeps them (src-tauri/src/controls.rs `commands_of`). */
const COMMANDS: SessionCommand[] = captured.available_commands_update.availableCommands.map((command) => ({
  name: command.name,
  description: command.description ?? "",
  hint: (command.input as { hint?: string } | null)?.hint ?? null,
}));

const OPENED = captured.session_new_result.configOptions as SessionOption[];
const EFFORT = OPENED.find((option) => option.category === "thought_level")!;
const GONE = "the first mate's session has ended";

export class MockSession {
  private options: SessionOption[];
  private commands: SessionCommand[] | null = null;
  private pending: SessionControls["pending"] = null;
  private problems: SessionControls["problems"] = {};
  private unfit: Record<string, string> = {};
  private picks: SessionControls["picks"] = {};
  private calm: CalmRead;
  private readonly posture: string;

  constructor(private readonly emit: (event: HostEvent) => void, private readonly later: (ms: number, run: () => void) => void) {
    const state = scenario();
    this.posture = state === "auto" ? "auto" : "bypassPermissions";
    this.options = state === "none" ? [] : OPENED.map((option) => option.category === "mode" ? { ...option, currentValue: this.posture } : { ...option });
    if (state === "haiku") this.rebuild("model", "haiku");
    if (state === "problem") {
      this.picks = { model: "sonnet" };
      this.problems = { model: { value: "sonnet", reason: "Invalid value for config option model: sonnet" } };
    }
    const calm = new URLSearchParams(window.location.search).get("calm");
    this.calm = calm === "missing"
      ? { available: false, on: false, problem: "Calm needs a newer firstmate: this home has no fm-calm.sh." }
      : { available: true, on: calm === "on" || calm === "denied", problem: null };
  }

  view(live = true): SessionControls {
    return { live, options: this.options, commands: this.commands, mode: this.posture, pending: this.pending, problems: this.problems, unfit: this.unfit, picks: this.picks };
  }

  /** The session opened: its options at once, its commands a moment later, as the adapter sends them. */
  opened() {
    this.emit({ type: "session_controls", payload: this.view() });
    const state = scenario();
    if (state === "waiting") return;
    this.later(250, () => {
      this.commands = state === "empty" ? [] : COMMANDS;
      this.emit({ type: "session_controls", payload: this.view() });
    });
  }

  /** What the adapter's `setSessionConfigOption` does to the list. */
  private rebuild(category: PickedCategory, value: string) {
    if (category === "thought_level") {
      this.options = this.options.map((option) => option.category === category ? { ...option, currentValue: value } : option);
      return;
    }
    const kept = this.options.find((option) => option.category === "thought_level")?.currentValue ?? this.picks.thought_level ?? "default";
    const rest = this.options.filter((option) => option.category !== "thought_level").map((option) => option.category === "model" ? { ...option, currentValue: value } : option);
    this.options = value === "haiku" ? rest : [...rest, { ...EFFORT, currentValue: EFFORT.options.some((entry) => entry.value === kept) ? kept : "default" }];
  }

  async set(category: PickedCategory, value: string): Promise<SessionControls> {
    const state = scenario();
    if (state === "gone") throw new Error(GONE);
    const unfit = this.unfit[`${category}:${value}`];
    if (unfit) throw new Error(unfit);
    this.pending = { category, value };
    this.emit({ type: "session_controls", payload: this.view() });
    await new Promise((resolve) => window.setTimeout(resolve, state === "slow" ? 4000 : 350));
    this.pending = null;
    const model = this.options.find((option) => option.category === "model");
    if (state === "refuse" && value === "claude-fable-5[1m]") {
      this.emit({ type: "session_controls", payload: this.view() });
      throw new Error("Invalid value for config option model: claude-fable-5[1m]");
    }
    if (state === "auto" && value === "haiku" && model) {
      const reason = `Haiku can't run this home's auto permissions, so the first mate stayed on ${model.options.find((entry) => entry.value === model.currentValue)?.name.replace(/\s*\(recommended\)$/i, "") ?? model.currentValue}`;
      this.unfit = { ...this.unfit, [`${category}:${value}`]: reason };
      this.emit({ type: "session_controls", payload: this.view() });
      throw new Error(reason);
    }
    this.rebuild(category, value);
    this.picks = { ...this.picks, [category]: value };
    const { [category]: _cleared, ...problems } = this.problems;
    this.problems = problems;
    const view = this.view();
    this.emit({ type: "session_controls", payload: view });
    return view;
  }

  async calmGet() {
    return this.calm;
  }

  async calmSet(on: boolean) {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    if (!this.calm.available) throw new Error(this.calm.problem ?? "Calm needs a newer firstmate.");
    if (new URLSearchParams(window.location.search).get("calm") === "denied") throw new Error("config/calm: Permission denied");
    this.calm = { ...this.calm, on };
    return this.calm;
  }
}

const step = (id: string, title: string, kind: string, status: string): HostEvent => ({ type: "tool_call", payload: { id, title, kind, status } });
const done = (id: string): HostEvent => ({ type: "tool_update", payload: { id, status: "completed" } });
const says = (chunk: string): HostEvent => ({ type: "text", payload: { chunk, origin: "prompt" } });

/**
 * One turn at the five moments the design draws it, Calm off and on alike, after an earlier exchange: the first mate
 * writes before it runs anything, runs its first steps, writes again and runs more, then replies and settles.
 */
export const STAGED_TURN: HostEvent[][] = [
  // Before: an earlier exchange, read and answered.
  [
    { type: "outbox", payload: { id: "turn-0", status: "queued", text: "Start the attachments task when CI is green." } },
    { type: "outbox", payload: { id: "turn-0", status: "sent" } },
    { type: "state", payload: { state: "prompt_turn" } },
    says("Will do. It is queued behind the release check."),
    { type: "outbox", payload: { id: "turn-0", status: "picked_up" } },
    { type: "state", payload: { state: "idle" } },
  ],
  // 1: sent, and the first mate starts writing before it runs anything.
  [
    { type: "outbox", payload: { id: "turn-1", status: "queued", text: "Is the release branch green?" } },
    { type: "outbox", payload: { id: "turn-1", status: "sent" } },
    { type: "state", payload: { state: "prompt_turn" } },
    says("Let me check CI and the"),
  ],
  // 2: a step follows, so those words were narration.
  [
    says(" open PRs first."),
    step("t-1", "gh-axi run list --branch release/0.9", "execute", "pending"), done("t-1"),
    step("t-2", "Read data/backlog.md", "read", "pending"), done("t-2"),
    step("t-3", "fm-fleet-snapshot.sh", "execute", "in_progress"),
  ],
  // 3: a second note and a second batch.
  [
    done("t-3"),
    says("Two runs are still going; waiting on the Bundle job."),
    step("t-4", "gh-axi run view 1841", "execute", "pending"), done("t-4"),
    step("t-5", "gh-axi run view 1842", "execute", "pending"), done("t-5"),
    step("t-6", "gh-axi run watch 1842", "execute", "in_progress"),
  ],
  // 4: the reply streams in.
  [done("t-6"), says("Yes. Both runs on release/0.9")],
  // 5: settled.
  [
    says(" passed, and nothing is waiting on you."),
    { type: "outbox", payload: { id: "turn-1", status: "picked_up" } },
    { type: "state", payload: { state: "idle" } },
  ],
];
