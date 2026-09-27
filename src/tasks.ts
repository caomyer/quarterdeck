/**
 * The task list: which open tasks a list shows, in what order, what each waits on and unblocks, and how they group.
 *
 * Everything here is read from the backlog rows the snapshot carries. firstmate owns the rules that decide dispatch
 * (`bin/fm-backlog-parse-lib.sh`: a row's `standing`, its `priority_level` and its `start_rank`), so the list draws the
 * order the first mate starts work in and never keeps a second one. A home whose firstmate predates those fields is
 * read by the same rule, from the fields it does carry, until it updates.
 *
 * The list is generic: it takes a filter, and a project page mounts it filtered to that project. Nothing here knows
 * where it is mounted.
 */
import type { BacklogRecord } from "./host/types";

/** What a list is mounted with. A project page passes its project; a list of everything passes nothing. */
export type TaskFilter = { project?: string | null };
/** The fixed views over the filter: every open task, what can start now, what waits on other work, what is put off. */
export type TaskView = "open" | "ready" | "blocked" | "held";
export type TaskSort = "start" | "unblocks" | "waiting" | "newest";
export type TaskGrouping = "none" | "group";
/** Where a row stands in the list: `underway` is in flight, `landed` is a closed member shown under its group. */
export type RowStanding = "underway" | "ready" | "blocked" | "held" | "landed";

/** The five priorities, as `engine/AGENTS.md` gives them meaning. */
export const PRIORITIES = [
  { level: 0, name: "Urgent", meaning: "Start it now, even past the usual number running." },
  { level: 1, name: "High", meaning: "First when a slot frees." },
  { level: 2, name: "Normal", meaning: "In the order filed. A task with no priority counts as Normal." },
  { level: 3, name: "Low", meaning: "Only when nothing more pressing is ready." },
  { level: 4, name: "Someday", meaning: "Kept, and never started unasked." },
] as const;

/** A row's priority, 0 to 4; a row without one counts as 2. */
export function priorityLevel(record: BacklogRecord): number {
  if (typeof record.priority_level === "number") return record.priority_level;
  return priorityIsSet(record) ? Number(record.priority) : 2;
}

/** Whether the row carries a priority of its own, rather than counting as Normal. */
export function priorityIsSet(record: BacklogRecord) {
  return typeof record.priority === "string" && /^[0-4]$/.test(record.priority);
}

const structured = (record: BacklogRecord) => Boolean(record.id) && (record as { structured?: boolean }).structured !== false;
const isGroup = (record: BacklogRecord) => record.kind === "program";

/** Where a queued row stands for dispatch: firstmate's word, else the same rule over the fields an older home carries. */
export function standingOf(record: BacklogRecord, captainDay?: string | null): "ready" | "blocked" | "held" | null {
  if (record.state !== "queued") return null;
  if (record.standing !== undefined) return record.standing;
  const until = record.hold_until ?? null;
  if (record.hold_reason && (!until || !captainDay || until > captainDay)) return "held";
  return (record.unresolved_blocker_ids ?? []).length > 0 ? "blocked" : "ready";
}

/** The open rows by id: an open row wins over a closed copy of the same id. */
export function openById(records: BacklogRecord[]) {
  const byId = new Map<string, BacklogRecord>();
  for (const record of records) {
    if (!structured(record) || record.state === "done") continue;
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  return byId;
}

/** Every row by id, open or closed, the open one winning. */
function anyById(records: BacklogRecord[]) {
  const byId = openById(records);
  for (const record of records) if (structured(record) && !byId.has(record.id)) byId.set(record.id, record);
  return byId;
}

/** The open dependency edges: what each open task waits on that is still open, and the reverse. */
export type TaskGraph = { waitsOn: Map<string, string[]>; waitedOnBy: Map<string, string[]>; byId: Map<string, BacklogRecord> };

export function taskGraph(records: BacklogRecord[]): TaskGraph {
  const byId = anyById(records);
  const open = openById(records);
  const waitsOn = new Map<string, string[]>();
  const waitedOnBy = new Map<string, string[]>();
  for (const record of open.values()) {
    // An older home carries no unresolved list; a blocker is open while its row is.
    const blockers = record.unresolved_blocker_ids ?? (record.blocked_by_ids ?? []).filter((id) => open.has(id));
    waitsOn.set(record.id, [...new Set(blockers)]);
    for (const blocker of blockers) waitedOnBy.set(blocker, [...(waitedOnBy.get(blocker) ?? []), record.id]);
  }
  return { waitsOn, waitedOnBy, byId };
}

/** Everything reachable from `id` along `edges`, nearest first, without `id` itself even when a loop leads back to it. */
function reach(edges: Map<string, string[]>, id: string) {
  const seen = new Set([id]);
  const order: string[] = [];
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const at of frontier) {
      for (const to of edges.get(at) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        order.push(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return order;
}

/** Every open task `id` waits on, directly or through others: its whole upstream chain, nearest first. */
export function upstreamOf(graph: TaskGraph, id: string) {
  return reach(graph.waitsOn, id);
}

/** Every open task waiting on `id`, directly or through others. */
export function downstreamOf(graph: TaskGraph, id: string) {
  return reach(graph.waitedOnBy, id);
}

/** One task in a chain, as the drawer draws it: indented under the task that waits on it. */
export type ChainNode = { id: string; depth: number; record?: BacklogRecord; children: ChainNode[]; loop?: boolean };

/**
 * The tree of what `id` waits on, each blocker under the task that waits on it. A task reached twice is drawn once,
 * where it is nearest; a task that leads back into the chain is marked as a loop rather than followed.
 */
export function upstreamTree(graph: TaskGraph, id: string): ChainNode[] {
  const depthOf = new Map<string, number>([[id, 0]]);
  for (let frontier = [id], depth = 1; frontier.length; depth += 1) {
    const next: string[] = [];
    for (const at of frontier) for (const to of graph.waitsOn.get(at) ?? []) if (!depthOf.has(to)) { depthOf.set(to, depth); next.push(to); }
    frontier = next;
  }
  const drawn = new Set<string>([id]);
  const build = (at: string, depth: number, path: Set<string>): ChainNode[] => (graph.waitsOn.get(at) ?? []).flatMap((to) => {
    if (path.has(to)) return [{ id: to, depth, record: graph.byId.get(to), children: [], loop: true }];
    if (drawn.has(to) || depthOf.get(to) !== depth) return [];
    drawn.add(to);
    return [{ id: to, depth, record: graph.byId.get(to), children: build(to, depth + 1, new Set([...path, to])) }];
  });
  return build(id, 1, new Set([id]));
}

/** The tasks at the root of `id`'s chain that could start now: pushing one of them is what brings `id` closer. */
export function startHere(graph: TaskGraph, id: string, captainDay?: string | null) {
  return upstreamOf(graph, id).filter((blocker) => {
    const record = graph.byId.get(blocker);
    return record && (graph.waitsOn.get(blocker) ?? []).length === 0 && standingOf(record, captainDay) === "ready";
  });
}

/** Every loop among open tasks, each once, as the ids around it. A loop means none of its tasks can ever start. */
export function loopsIn(graph: TaskGraph) {
  const loops: string[][] = [];
  const found = new Set<string>();
  for (const start of graph.waitsOn.keys()) {
    const stack: { at: string; path: string[] }[] = [{ at: start, path: [start] }];
    while (stack.length) {
      const { at, path } = stack.pop()!;
      for (const to of graph.waitsOn.get(at) ?? []) {
        if (to === start) {
          const key = [...path].sort().join(" ");
          if (!found.has(key)) { found.add(key); loops.push(path); }
        } else if (!path.includes(to) && to > start) {
          // Each loop is found from its smallest id only.
          stack.push({ at: to, path: [...path, to] });
        }
      }
    }
  }
  return loops;
}

/** The loop `id` sits in, if any: the ids around it, starting from `id`. */
export function loopThrough(graph: TaskGraph, id: string) {
  const loop = loopsIn(graph).find((ids) => ids.includes(id));
  if (!loop) return null;
  const at = loop.indexOf(id);
  return [...loop.slice(at), ...loop.slice(0, at)];
}

/** What the list needs to place its rows: the rows, the filter, and what the app knows beside the backlog. */
export type ListInput = {
  records: BacklogRecord[];
  filter: TaskFilter;
  search?: string;
  /** Tasks with a worker the snapshot has registered, drawn as underway. */
  underway?: Set<string>;
  /** Tasks another section of the page already shows, such as a finished scout's report waiting to be read. */
  hidden?: Set<string>;
  captainDay?: string | null;
};

export type ListRow = { id: string; record: BacklogRecord; standing: RowStanding };

/** Whether an open row belongs in a list at all: work, not a group, and not a call waiting on the captain's answer. */
function listed(record: BacklogRecord, input: ListInput) {
  if (!structured(record) || isGroup(record) || input.hidden?.has(record.id)) return false;
  if (record.state !== "queued" && record.state !== "in_flight") return false;
  // A call waiting on the captain now has its own card; a call put off to a day is listed as put off.
  if (record.captain_actionable) return false;
  if (record.kind === "captain" && standingOf(record, input.captainDay) !== "held") return false;
  return true;
}

function matches(record: BacklogRecord, search: string) {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [record.id, record.title, record.repo ?? "", ...(record.body_lines ?? [])].join("\n").toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Every open row the filter and search admit, before any view: underway first, then the queue. */
export function openRows(input: ListInput): ListRow[] {
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  for (const record of input.records) {
    if (seen.has(record.id) || !listed(record, input)) continue;
    if (input.filter.project && record.repo !== input.filter.project) continue;
    if (!matches(record, input.search ?? "")) continue;
    seen.add(record.id);
    rows.push({ id: record.id, record, standing: record.state === "in_flight" ? "underway" : standingOf(record, input.captainDay) ?? "ready" });
  }
  return rows;
}

const VIEW_STANDING: Record<Exclude<TaskView, "open">, RowStanding> = { ready: "ready", blocked: "blocked", held: "held" };

export function inView(row: ListRow, view: TaskView) {
  return view === "open" ? row.standing !== "landed" : row.standing === VIEW_STANDING[view];
}

/** How many rows each view holds, over the same filter and search. */
export function viewCounts(input: ListInput): Record<TaskView, number> {
  const rows = openRows(input);
  return { open: rows.length, ready: rows.filter((row) => row.standing === "ready").length, blocked: rows.filter((row) => row.standing === "blocked").length, held: rows.filter((row) => row.standing === "held").length };
}

const TIER: Record<RowStanding, number> = { underway: 0, ready: 1, blocked: 2, held: 3, landed: 4 };

/**
 * firstmate's start rank for each queued row, or, from a home that predates it, the same rule: ready, then blocked,
 * then held; within each, priority, then the oldest filed, then the order written.
 */
export function startRanks(records: BacklogRecord[], captainDay?: string | null) {
  const queued = records.filter((record) => structured(record) && record.state === "queued");
  if (queued.every((record) => typeof record.start_rank === "number")) return new Map(queued.map((record) => [record.id, record.start_rank as number]));
  const tier = (record: BacklogRecord) => ({ ready: 0, blocked: 1, held: 2 })[standingOf(record, captainDay) ?? "ready"];
  const ordered = queued.map((record, order) => ({ record, order })).sort((a, b) =>
    tier(a.record) - tier(b.record) || priorityLevel(a.record) - priorityLevel(b.record)
    || (a.record.since ?? "9999-12-31").localeCompare(b.record.since ?? "9999-12-31") || a.order - b.order);
  return new Map(ordered.map(({ record }, index) => [record.id, index + 1]));
}

/** The rows a view shows, in the chosen order. Underway work always leads, as the section this list replaced did. */
export function taskRows(input: ListInput & { view: TaskView; sort: TaskSort }): ListRow[] {
  const rows = openRows(input).filter((row) => inView(row, input.view));
  const ranks = startRanks(input.records, input.captainDay);
  const graph = taskGraph(input.records);
  const rank = (row: ListRow) => ranks.get(row.id) ?? Number.MAX_SAFE_INTEGER;
  const since = (row: ListRow) => row.record.since ?? "";
  const unblocks = new Map(input.sort === "unblocks" ? rows.map((row) => [row.id, downstreamOf(graph, row.id).length]) : []);
  const byStart = (a: ListRow, b: ListRow) => TIER[a.standing] - TIER[b.standing] || rank(a) - rank(b) || since(a).localeCompare(since(b));
  const underwayFirst = (a: ListRow, b: ListRow) => Number(b.standing === "underway") - Number(a.standing === "underway");
  const compare: Record<TaskSort, (a: ListRow, b: ListRow) => number> = {
    start: byStart,
    unblocks: (a, b) => (unblocks.get(b.id) ?? 0) - (unblocks.get(a.id) ?? 0) || byStart(a, b),
    // Undated rows have waited for an unknown time, so they go last.
    waiting: (a, b) => (since(a) || "9999").localeCompare(since(b) || "9999") || byStart(a, b),
    newest: (a, b) => since(b).localeCompare(since(a)) || byStart(a, b),
  };
  return rows.sort((a, b) => underwayFirst(a, b) || compare[input.sort](a, b));
}

/**
 * A group as the list draws it: its own row, and how many of its tasks are open. The backlog keeps only its few recent
 * landed rows and the archive's rows are not read, so how many have landed is never known.
 */
export type GroupInfo = { id: string; record: BacklogRecord; open: number };

/** The open groups a list shows: every group of its project, and any other group one of its rows is in. */
export function groupsFor(records: BacklogRecord[], filter: TaskFilter, rows: ListRow[]): GroupInfo[] {
  const named = new Set(rows.map((row) => row.record.part_of).filter(Boolean));
  const open = [...openById(records).values()].filter((record) => isGroup(record) && (!filter.project || record.repo === filter.project || named.has(record.id)));
  const members = [...openById(records).values()];
  return open
    .map((record) => ({ id: record.id, record, open: members.filter((member) => member.part_of === record.id).length }))
    .sort((a, b) => priorityLevel(a.record) - priorityLevel(b.record) || (a.record.since ?? "").localeCompare(b.record.since ?? ""));
}

/** Every open group, for choosing one; in the list's project first. */
export function groupChoices(records: BacklogRecord[], project?: string | null) {
  return [...openById(records).values()].filter(isGroup).sort((a, b) => Number(b.repo === project) - Number(a.repo === project) || a.title.localeCompare(b.title));
}

export type ListSection = { group: GroupInfo | null; rows: ListRow[] };

/**
 * The rows under their groups, each group's landed tasks kept at its foot, dimmed, until the group closes; then the
 * rows in no group. Order within a section is the list's.
 */
export function groupSections(records: BacklogRecord[], filter: TaskFilter, rows: ListRow[], withLanded: boolean): ListSection[] {
  const groups = groupsFor(records, filter, rows);
  const known = new Set(groups.map((group) => group.id));
  const sections: ListSection[] = groups.map((group) => {
    const own = rows.filter((row) => row.record.part_of === group.id);
    const landed = withLanded
      ? [...new Map(records.filter((record) => structured(record) && record.state === "done" && record.part_of === group.id).map((record) => [record.id, record])).values()]
        .filter((record) => !filter.project || record.repo === filter.project)
        .map((record): ListRow => ({ id: record.id, record, standing: "landed" }))
      : [];
    return { group, rows: [...own, ...landed] };
  });
  const loose = rows.filter((row) => !row.record.part_of || !known.has(row.record.part_of));
  return [...sections.filter((section) => section.rows.length > 0 || filter.project === section.group?.record.repo), { group: null, rows: loose }];
}

/** Days from a `yyyy-mm-dd` day to `now`, in whole local days; null for no day. */
export function daysSince(day: string | null | undefined, now: number) {
  if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) return null;
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const then = new Date(y, m - 1, d).getTime();
  const today = new Date(now);
  return Math.max(0, Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - then) / 86_400_000));
}
