/**
 * `?tasks`: a resonance backlog with every state the task list draws, and the edits `bin/fm-task-edit.sh` takes.
 *
 * Rows are in the engine's own shape: priorities as tasks-axi stores them, `blocked-by` edges, a parked hold, a
 * deferred call, groups as `kind: program` rows whose tasks carry a `part-of:` body line, and the fields
 * `bin/fm-backlog-parse-lib.sh` derives (`standing`, `priority_level`, `start_rank`, `unresolved_blocker_ids`),
 * derived here by the same rule after every change. The edits refuse what the script refuses, in its words.
 *   (none)   the backlog below
 *   `loop`   two tasks that wait on each other, as a hand-edited backlog can hold
 *   `wide`   one task nine others wait on
 *   `deep`   a chain five tasks deep
 *   `stale`  the first edit finds the first mate changed that value a moment before
 */
import type { BacklogRecord, TaskEdit, TaskEdited } from "./types";
import { startRanks, standingOf } from "../tasks";

type Row = (id: string, title: string, fields: Partial<BacklogRecord>) => BacklogRecord;

const day = (offset: number) => {
  const date = new Date(Date.now() + offset * 86_400_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** The groups this backlog files its work under. */
export const SHARING_GROUP = "g-share-snips-anywhere";
export const AUDIO_GROUP = "g-audio-that-sounds-right";

/** The backlog rows `?tasks` adds to the home, before the parser's fields are derived. */
export function mockTaskRecords(row: Row, variant: string | null): BacklogRecord[] {
  const queued = (id: string, title: string, fields: Partial<BacklogRecord>) =>
    row(id, title, { state: "queued", current_role: "queued", since: day(-3), ...fields });
  const member = (group: string, lines: string[] = []) => ({ body_lines: [...lines, `part-of: ${group}`], part_of: group });
  const records = [
    row(SHARING_GROUP, "Share snips anywhere", { kind: "program", current_role: "program", priority: "1", since: day(-9), body_lines: ["Everything that gets a snip out of the app and in front of someone."] }),
    row(AUDIO_GROUP, "Audio that sounds right", { kind: "program", current_role: "program", priority: "2", since: day(-12) }),
    queued("res-import-crash", "Resonance: a 12-hour episode crashes the import", { priority: "0", since: day(0), body_lines: ["The importer reads the whole file into memory. Stream it."] }),
    queued("res-offline-queue", "Resonance: keep snips made offline and send them when back online", { priority: "1", since: day(-6), ...member(SHARING_GROUP) }),
    queued("res-share-sheet", "Resonance: share a snip from the share sheet", { priority: "2", since: day(-5), ...member(SHARING_GROUP, ["Use the system share sheet; no account needed."]) }),
    queued("res-share-preview", "Resonance: a link preview that plays the snip", { priority: "2", since: day(-4), blocked_by_ids: ["res-share-sheet"], ...member(SHARING_GROUP) }),
    queued("res-share-stats", "Resonance: count how often a shared snip is played", { priority: "3", since: day(-4), blocked_by_ids: ["res-share-preview"], ...member(SHARING_GROUP) }),
    row("res-share-link", "Resonance: a plain link for every snip", { state: "done", current_role: "done", priority: "2", since: day(-10), completion: { verb: "merged", date: day(-2) }, pr_url: "https://github.com/caomyer/Resonance/pull/31", ...member(SHARING_GROUP) }),
    queued("res-loudness", "Resonance: even out loudness between episodes", { priority: "2", since: day(-8), ...member(AUDIO_GROUP) }),
    row("res-noise-gate", "Resonance: gate the hiss under quiet speech", { state: "done", current_role: "done", priority: "3", since: day(-14), completion: { verb: "merged", date: day(-7) }, ...member(AUDIO_GROUP) }),
    queued("res-transcript-search", "Resonance: search inside transcripts", { priority: "2", since: day(-2), blocked_by_ids: ["res-transcripts-scout"] }),
    queued("res-foreman-hook", "Resonance: tell foreman when a snip is shared", { priority: "2", since: day(-1), blocked_by_ids: ["foreman-events-api"] }),
    queued("foreman-events-api", "Foreman: an events API other apps can post to", { repo: "foreman", priority: "1", since: day(-3) }),
    queued("res-chapters", "Resonance: use podcast chapters as snip titles", { priority: "2", since: day(-7), hold_reason: `put off by the captain until ${day(5)}`, hold_kind: "parked", hold_until: day(5) }),
    queued("res-storage-cap", "Resonance: how much storage may downloads use?", {
      kind: "captain", priority: null, since: day(-2), hold_reason: "captain decision pending", hold_kind: "captain", hold_until: day(2), hold_bucket: "dated",
    }),
    queued("res-widget-theme", "Resonance: match the widget to the wallpaper", { priority: "4", since: day(-11) }),
  ];
  if (variant === "loop") records.push(
    queued("res-loop-a", "Resonance: move settings into the sidebar", { priority: "2", blocked_by_ids: ["res-loop-b"] }),
    queued("res-loop-b", "Resonance: redraw the sidebar for settings", { priority: "2", blocked_by_ids: ["res-loop-a"] }),
  );
  if (variant === "deep") for (let n = 1; n <= 5; n += 1) {
    records.push(queued(`res-deep-${n}`, `Resonance: step ${n} of the offline sync`, { priority: "2", since: day(-20 + n), blocked_by_ids: n > 1 ? [`res-deep-${n - 1}`] : [] }));
  }
  if (variant === "wide") for (let n = 1; n <= 9; n += 1) {
    records.push(queued(`res-after-sheet-${n}`, `Resonance: follow-up ${n} to the share sheet`, { priority: "3", blocked_by_ids: ["res-share-sheet"] }));
  }
  return records;
}

/** The parser's derived fields, by its own rules, over the whole backlog: what `fm-backlog-parse-lib.sh` writes. */
export function reparse(records: BacklogRecord[], captainDay: string): BacklogRecord[] {
  const closed = new Map<string, boolean>();
  for (const record of records) closed.set(record.id, (closed.get(record.id) ?? true) && record.state === "done");
  const next = records.map((record): BacklogRecord => {
    const unresolved = (record.blocked_by_ids ?? []).filter((id) => closed.get(id) !== true);
    const level = typeof record.priority === "string" && /^[0-4]$/.test(record.priority) ? Number(record.priority) : 2;
    const part = (record.body_lines ?? []).map((line) => line.match(/^part-of:\s+(\S+)$/)?.[1]).find(Boolean) ?? null;
    const base: BacklogRecord = { ...record, unresolved_blocker_ids: unresolved, priority_level: level, part_of: part, standing: undefined, start_rank: null };
    return { ...base, standing: standingOf(base, captainDay) };
  });
  const ranks = startRanks(next.map((record) => ({ ...record, start_rank: undefined })), captainDay);
  return next.map((record) => ({ ...record, start_rank: ranks.get(record.id) ?? null }));
}

type EditContext = { records: BacklogRecord[]; captainDay: string; projects: string[]; staleOnce: boolean };

const refuse = (task: string | null, code: string, reason: string, current?: string): TaskEdited => ({ ok: false, task, code, reason, ...(current === undefined ? {} : { current }) });

/**
 * One edit, as `bin/fm-task-edit.sh` takes or refuses it. Returns the new rows and what the script would print; a
 * refusal leaves the rows as they were, except `stale`, where the first mate's own change is what the window missed.
 */
export function applyTaskEdit(edit: TaskEdit, context: EditContext): { records: BacklogRecord[]; result: TaskEdited; staleUsed: boolean } {
  const { captainDay } = context;
  let records = context.records;
  const find = (id: string) => records.find((record) => record.id === id && record.state !== "done") ?? records.find((record) => record.id === id);
  const done = (result: TaskEdited, staleUsed = false) => ({ records, result, staleUsed });
  const change = (id: string, fields: Partial<BacklogRecord>) => {
    records = reparse(records.map((record) => (record.id === id ? { ...record, ...fields } : record)), captainDay);
    return done({ ok: true, task: id, changed: true, record: find(id)! });
  };
  const same = (id: string) => done({ ok: true, task: id, changed: false, record: find(id)! });

  if (edit.verb === "group-new") {
    if (!context.projects.includes(edit.project)) return done(refuse(null, "unregistered", `no project named ${edit.project} is registered in this home`));
    const slug = edit.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 5).join("-").slice(0, 40).replace(/-$/, "") || "group";
    let id = `g-${slug}`;
    for (let n = 2; find(id); n += 1) id = `g-${slug}-${n}`;
    records = reparse([...records, { id, title: edit.title, hold_reason: null, current_role: "program", state: "in_flight", kind: "program", repo: edit.project, priority: edit.priority ?? null, since: captainDay, body_lines: [] }], captainDay);
    return done({ ok: true, task: id, changed: true, record: find(id)! });
  }

  const task = edit.task;
  const record = find(task);
  if (!record) return done(refuse(task, "unknown", `no task ${task} in this home's backlog`));
  if (record.state === "done") return done(refuse(task, "closed", `${task} has closed; the logbook keeps it as it was`));
  if (record.kind === "captain") return done(refuse(task, "call", `${task} is a call; answer it where it is asked`));
  const group = record.kind === "program";
  const inFlight = record.state === "in_flight" && !group;
  const running = (what: string) => refuse(task, "running", `${task} is already running, and its worker was briefed for its ${what}; to change it, the work has to stop and be briefed again, so ask the first mate`);
  const stale = (current: string | null | undefined, expect: string, what: string) => {
    const now = current ?? "none";
    return now === expect ? null : refuse(task, "stale", `Not changed: its ${what} changed to ${now} while your window showed ${expect}; pick again`, now);
  };

  switch (edit.verb) {
    case "priority": {
      if (context.staleOnce) {
        const theirs = edit.value === "3" ? "1" : "3";
        records = reparse(records.map((item) => (item.id === task ? { ...item, priority: theirs } : item)), captainDay);
        return done(refuse(task, "stale", `Not changed: its priority changed to ${theirs} while your window showed ${edit.expect}; pick again`, theirs), true);
      }
      const refused = stale(record.priority, edit.expect, "priority");
      if (refused) return done(refused);
      return (record.priority ?? "none") === edit.value ? same(task) : change(task, { priority: edit.value });
    }
    case "title": {
      const title = edit.value.trim();
      if (!title) return done(refuse(task, "invalid", "a title cannot be empty"));
      if (/\((repo|kind|priority|hold|hold-kind|hold-until):|\((since|merged|reported|done)\s|blocked-by:|https?:\/\//i.test(title)) {
        return done(refuse(task, "invalid", "a title cannot carry row details such as (repo: ...), blocked-by: or a link; add a link as a note"));
      }
      const refused = stale(record.title, edit.expect, "title");
      if (refused) return done(refused);
      return record.title === title ? same(task) : change(task, { title });
    }
    case "block": {
      if (group) return done(refuse(task, "invalid", `${task} is a group; a group waits on nothing; order its tasks instead`));
      if (inFlight) return done(running("dependencies"));
      if (edit.by === task) return done(refuse(task, "invalid", "a task cannot wait on itself"));
      const blocker = find(edit.by);
      if (!blocker) return done(refuse(task, "unknown", `no task ${edit.by} in this home's backlog`));
      if (blocker.state === "done") return done(refuse(task, "invalid", `${edit.by} has already landed; there is nothing to wait for`));
      if (blocker.kind === "program") return done(refuse(task, "invalid", `${edit.by} is a group; wait on one of its tasks instead`));
      if ((record.blocked_by_ids ?? []).includes(edit.by)) return same(task);
      // The path by which the blocker already waits on this task, through open edges.
      const path = waitPath(records, edit.by, task);
      if (path) {
        const through = path.slice(1, -1);
        return done(refuse(task, "loop", `Not added: ${edit.by} already waits on ${task}${through.length ? ` through ${through.join(", then ")}` : ""}, so each would wait on the other forever`));
      }
      return change(task, { blocked_by_ids: [...(record.blocked_by_ids ?? []), edit.by] });
    }
    case "unblock":
      return (record.blocked_by_ids ?? []).includes(edit.by) ? change(task, { blocked_by_ids: (record.blocked_by_ids ?? []).filter((id) => id !== edit.by) }) : same(task);
    case "park": {
      if (group) return done(refuse(task, "invalid", `${task} is a group; put off its tasks instead`));
      if (inFlight) return done(running("start"));
      if (record.hold_reason && record.hold_kind !== "parked") {
        return done(refuse(task, "held", record.hold_kind === "captain" ? `${task} waits on a call; its date changes by answering the call` : `the first mate is holding ${task}: ${record.hold_reason}`));
      }
      const refused = stale(record.hold_kind === "parked" ? record.hold_until : null, edit.expect, "put-off date");
      if (refused) return done(refused);
      if (!(edit.until > captainDay)) return done(refuse(task, "invalid", `put it off to a day after today (${captainDay})`));
      return change(task, { hold_reason: `put off by the captain until ${edit.until}`, hold_kind: "parked", hold_until: edit.until });
    }
    case "unpark": {
      if (!record.hold_reason) return same(task);
      if (record.hold_kind !== "parked") return done(refuse(task, "held", record.hold_kind === "captain" ? `${task} waits on a call; its date changes by answering the call` : `the first mate is holding ${task}: ${record.hold_reason}`));
      const refused = stale(record.hold_until, edit.expect, "put-off date");
      if (refused) return done(refused);
      return change(task, { hold_reason: null, hold_kind: null, hold_until: null });
    }
    case "project": {
      if (inFlight) return done(running("project"));
      if (!context.projects.includes(edit.value)) return done(refuse(task, "unregistered", `no project named ${edit.value} is registered in this home`));
      const refused = stale(record.repo, edit.expect, "project");
      if (refused) return done(refused);
      return record.repo === edit.value ? same(task) : change(task, { repo: edit.value });
    }
    case "kind": {
      if (group) return done(refuse(task, "invalid", `${task} is a group; it stays a group`));
      if (inFlight) return done(running("kind"));
      const refused = stale(record.kind, edit.expect, "kind");
      if (refused) return done(refused);
      return record.kind === edit.value ? same(task) : change(task, { kind: edit.value });
    }
    case "group": {
      if (group) return done(refuse(task, "invalid", `${task} is a group; a group cannot be part of another group`));
      const refused = stale(record.part_of, edit.expect, "group");
      if (refused) return done(refused);
      if (edit.value !== "none") {
        const target = find(edit.value);
        if (!target) return done(refuse(task, "unknown", `no group ${edit.value} in this home's backlog`));
        if (target.kind !== "program") return done(refuse(task, "invalid", `${edit.value} is a task, not a group`));
        if (target.state === "done") return done(refuse(task, "invalid", `the group ${edit.value} has closed`));
      }
      if ((record.part_of ?? "none") === edit.value) return same(task);
      const kept = (record.body_lines ?? []).filter((line) => !/^part-of:\s/.test(line));
      return change(task, { body_lines: edit.value === "none" ? kept : [...kept, `part-of: ${edit.value}`] });
    }
    case "group-close": {
      if (!group) return done(refuse(task, "invalid", `${task} is a task, not a group; the first mate closes tasks`));
      const open = records.filter((item) => item.state !== "done" && item.part_of === task).map((item) => item.id);
      if (open.length) return done(refuse(task, "open-members", `the group still has open tasks: ${open.join(", ")}`));
      return change(task, { state: "done", current_role: "done", completion: { verb: "done", date: captainDay } });
    }
  }
}

function waitPath(records: BacklogRecord[], from: string, to: string): string[] | null {
  const waits = new Map(records.filter((record) => record.state !== "done").map((record) => [record.id, record.unresolved_blocker_ids ?? []]));
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift()!;
    const at = path[path.length - 1];
    if (at === to) return path;
    for (const next of waits.get(at) ?? []) if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); }
  }
  return null;
}
