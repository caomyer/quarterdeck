/**
 * The task list: one generic component that takes its filter as input. A project page mounts it filtered to that
 * project, where it replaces the page's Work section; a list of every project is the same component with no filter.
 *
 * What it draws is read by src/tasks.ts from the backlog rows the snapshot carries, in the order firstmate starts work
 * in. Every change goes through `onEdit`, which the app sends to firstmate's `fm-task-edit.sh`; the list never decides
 * whether an edit is allowed, it shows the script's answer where the edit was made.
 *
 * A task waiting on another is drawn joined to it by a line in the list's left margin, and pointing at or focusing a
 * task lights its whole upstream chain, quietly, with a note when part of that chain is scrolled out of sight.
 */
import { Check, ChevronRight, CircleCheck, Clock3, Search, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BacklogRecord, TaskEdit, TaskEdited } from "./host/types";
import {
  daysSince, downstreamOf, groupChoices, groupSections, type ListRow, priorityIsSet, priorityLevel, PRIORITIES, taskGraph, type TaskFilter,
  type TaskGrouping, taskRows, type TaskSort, type TaskView, upstreamOf, viewCounts,
} from "./tasks";

/** How an underway task's worker reads now, drawn the way the rest of the app draws it. */
export type UnderwayStatus = { label: string; tone: string; icon: React.ReactNode };

type TaskListProps = {
  /** The whole backlog, every project: a chain or a group can reach beyond the filter. */
  records: BacklogRecord[];
  filter: TaskFilter;
  captainDay?: string | null;
  now: number;
  underway: Map<string, UnderwayStatus>;
  hidden?: Set<string>;
  /** A row's title as this page says it, without the project name the page already shows. */
  title: (text: string) => string;
  /** Whether this home's firstmate takes edits; without it the list only reads. */
  editing: boolean;
  onOpen: (id: string) => void;
  onOpenGroup: (id: string) => void;
  onEdit: (edit: TaskEdit) => Promise<TaskEdited>;
};

const VIEWS: { id: TaskView; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "ready", label: "Ready" },
  { id: "blocked", label: "Blocked" },
  { id: "held", label: "Put off" },
];

const SORTS: { id: TaskSort; label: string; hint: string }[] = [
  { id: "start", label: "Start order", hint: "ready first, then priority, then oldest filed" },
  { id: "unblocks", label: "Unblocks most", hint: "what the most other work waits on" },
  { id: "waiting", label: "Waiting longest", hint: "oldest filed first" },
  { id: "newest", label: "Newest filed", hint: "what was filed last" },
];

const KIND_NAMES: Record<string, string> = { scout: "Scout", ship: "Ship", secondmate: "Second mate", captain: "Call" };

/** `Oct 3`, from a `yyyy-mm-dd` day, read as that day where the app runs. */
export function shortDate(day: string) {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(y, m - 1, d));
}

/** A row's priority, drawn as a small badge that keeps its shape whatever state the row is in. */
export function PriorityBadge({ record, dim }: { record: BacklogRecord; dim?: boolean }) {
  const level = priorityLevel(record);
  const set = priorityIsSet(record);
  const info = PRIORITIES[level];
  const tip = set ? `P${level} ${info.name}: ${info.meaning}` : `No priority set, so it counts as P2 Normal.`;
  return <span className={`tl-pri p${level}${set ? "" : " unset"}${dim ? " dim" : ""}`} title={tip} data-priority={set ? level : "none"}>P{level}</span>;
}

/** What a row's chip says about where it stands. */
function standingChip(row: ListRow, underway: UnderwayStatus | undefined) {
  const record = row.record;
  if (row.standing === "underway") return underway ? { tone: underway.tone, label: underway.label } : { tone: "blue", label: "In flight" };
  if (row.standing === "landed") return { tone: "muted", label: record.completion?.verb === "merged" ? "Merged" : "Landed" };
  if (row.standing === "ready") return { tone: "green", label: "Ready" };
  if (row.standing === "blocked") return { tone: "amber", label: "Blocked" };
  if (record.hold_kind === "captain") return { tone: "muted", label: record.hold_until ? `Back ${shortDate(record.hold_until)}` : "Your call" };
  if (record.hold_kind === "parked") return { tone: "muted", label: record.hold_until ? `Back ${shortDate(record.hold_until)}` : "Put off" };
  return { tone: "amber", label: "Held" };
}

/** Where each row sits in the list, for drawing the lines between them. */
type Place = { top: number; mid: number; bottom: number };

type Edge = { from: string; to: string; lane: number; stub: boolean };

/** One lane per overlapping edge, so no two vertical runs share a line. */
function laneEdges(pairs: { from: string; to: string }[], places: Map<string, Place>): Edge[] {
  const spans = pairs.map((pair) => {
    const to = places.get(pair.to)!;
    const from = places.get(pair.from);
    const top = from ? Math.min(from.mid, to.mid) : to.mid - 18;
    const bottom = from ? Math.max(from.mid, to.mid) : to.mid;
    return { ...pair, top, bottom, stub: !from };
  }).sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const lanes: number[] = [];
  return spans.map((span) => {
    let lane = lanes.findIndex((end) => end <= span.top + 1);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = span.bottom;
    return { from: span.from, to: span.to, lane: Math.min(lane, 3), stub: span.stub };
  });
}

const DOT_X = 26;
const LANE_X = (lane: number) => 15 - lane * 4;

function edgePath(edge: Edge, places: Map<string, Place>) {
  const to = places.get(edge.to)!;
  const x = LANE_X(edge.lane);
  const r = 5;
  if (edge.stub) {
    // A blocker this list does not show: a short line up from the row, ending open.
    return `M ${DOT_X - 5} ${to.mid} H ${x + r} Q ${x} ${to.mid} ${x} ${to.mid - r} V ${to.top + 4}`;
  }
  const from = places.get(edge.from)!;
  const down = to.mid > from.mid ? 1 : -1;
  return `M ${DOT_X - 5} ${from.mid} H ${x + r} Q ${x} ${from.mid} ${x} ${from.mid + r * down} V ${to.mid - r * down} Q ${x} ${to.mid} ${x + r} ${to.mid} H ${DOT_X - 5}`;
}

export function TaskList({ records, filter: mountedFilter, captainDay, now, underway, hidden, title, editing, onOpen, onOpenGroup, onEdit }: TaskListProps) {
  // Filters are for this visit only, as with the logbook's: a filter that sticks reads as work gone missing.
  const [filter, setFilter] = useState<TaskFilter>(mountedFilter);
  const [view, setView] = useState<TaskView>("open");
  const [sort, setSort] = useState<TaskSort>("start");
  const [grouping, setGrouping] = useState<TaskGrouping>("none");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "bad" | "ok"; text: string } | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);

  const underwayIds = useMemo(() => new Set(underway.keys()), [underway]);
  const input = { records, filter, search, underway: underwayIds, hidden, captainDay };
  const rows = useMemo(() => taskRows({ ...input, view, sort }), [records, filter, search, underwayIds, hidden, captainDay, view, sort]);
  const counts = useMemo(() => viewCounts(input), [records, filter, search, underwayIds, hidden, captainDay]);
  const graph = useMemo(() => taskGraph(records), [records]);
  const byId = graph.byId;
  const sections = useMemo(() => grouping === "group"
    ? groupSections(records, filter, rows, view === "open")
    : [{ group: null, rows }], [grouping, records, filter, rows, view]);
  const shown = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const shownIds = useMemo(() => new Set(shown.map((row) => row.id)), [shown]);

  // Selection keeps only rows still shown and still editable.
  useEffect(() => {
    setSelected((current) => {
      const kept = new Set([...current].filter((id) => shownIds.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [shownIds]);

  const chain = useMemo(() => hovered ? new Set([hovered, ...upstreamOf(graph, hovered)]) : null, [hovered, graph]);

  // Where each row sits, measured after layout and again whenever the list changes size.
  const list = useRef<HTMLDivElement>(null);
  const [places, setPlaces] = useState<Map<string, Place>>(new Map());
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const base = element.getBoundingClientRect().top;
      const next = new Map<string, Place>();
      element.querySelectorAll<HTMLElement>("[data-row-id]").forEach((node) => {
        const box = node.getBoundingClientRect();
        next.set(node.dataset.rowId!, { top: box.top - base, mid: box.top - base + box.height / 2, bottom: box.bottom - base });
      });
      setPlaces(next);
      setHeight(element.scrollHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sections]);

  const edges = useMemo(() => {
    const pairs = shown.filter((row) => row.standing !== "landed" && places.has(row.id))
      .flatMap((row) => (graph.waitsOn.get(row.id) ?? []).map((from) => ({ from: places.has(from) ? from : `offlist:${from}`, to: row.id })));
    return laneEdges(pairs, places);
  }, [shown, graph, places]);

  // Rows of the lit chain that are out of sight, above or below what the page shows.
  const [outOfSight, setOutOfSight] = useState({ above: 0, below: 0 });
  useEffect(() => {
    if (!chain || !list.current) { setOutOfSight({ above: 0, below: 0 }); return; }
    const scroller = list.current.closest(".content-scroll") ?? document.documentElement;
    const view = scroller.getBoundingClientRect();
    let above = 0;
    let below = 0;
    list.current.querySelectorAll<HTMLElement>("[data-row-id]").forEach((node) => {
      if (!chain.has(node.dataset.rowId!) || node.dataset.rowId === hovered) return;
      const box = node.getBoundingClientRect();
      if (box.bottom < view.top + 4) above += 1;
      else if (box.top > view.bottom - 4) below += 1;
    });
    setOutOfSight({ above, below });
  }, [chain, hovered]);

  const choices = useMemo(() => groupChoices(records, filter.project), [records, filter.project]);
  const editable = (record: BacklogRecord) => editing && record.state !== "done" && record.kind !== "captain" && record.kind !== "program";

  async function run(ids: string[], build: (record: BacklogRecord) => TaskEdit | null, done: string) {
    setNotice(null);
    setPending((current) => new Set([...current, ...ids]));
    const refusals: string[] = [];
    let changed = 0;
    for (const id of ids) {
      const record = byId.get(id);
      const edit = record && build(record);
      if (!edit) continue;
      try {
        const result = await onEdit(edit);
        if (result.ok) changed += Number(result.changed);
        else refusals.push(ids.length > 1 ? `${id}: ${result.reason}` : result.reason);
      } catch (error) {
        refusals.push(`${ids.length > 1 ? `${id}: ` : ""}${String(error)}`);
      }
    }
    setPending((current) => new Set([...current].filter((id) => !ids.includes(id))));
    if (refusals.length) setNotice({ tone: "bad", text: ids.length > 1 ? `${changed} changed. Not changed: ${refusals.join("; ")}` : refusals[0] });
    else if (ids.length > 1) setNotice({ tone: "ok", text: `${done} for ${changed} ${changed === 1 ? "task" : "tasks"}.` });
  }

  const setPriority = (ids: string[], level: number) =>
    run(ids, (record) => ({ verb: "priority", task: record.id, value: String(level), expect: record.priority ?? "none" }), `P${level} set`);
  const setGroup = (ids: string[], group: string) =>
    run(ids, (record) => ({ verb: "group", task: record.id, value: group, expect: record.part_of ?? "none" }), group === "none" ? "Group cleared" : "Group set");
  const putOff = (ids: string[], until: string) =>
    run(ids, (record) => record.hold_kind === "parked" || !record.hold_reason ? { verb: "park", task: record.id, until, expect: record.hold_kind === "parked" ? record.hold_until ?? "none" : "none" } : null, `Put off until ${shortDate(until)}`);

  const selectable = shown.filter((row) => row.standing !== "landed" && editable(row.record));
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.id));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const queued = counts.open - [...underwayIds].filter((id) => shown.some((row) => row.id === id)).length;
  const heldCount = counts.held;
  const summary = [`${rows.filter((row) => row.standing === "underway").length} underway`, `${Math.max(0, queued - heldCount)} queued`, heldCount ? `${heldCount} put off` : null].filter(Boolean).join(" · ");
  const sortInfo = SORTS.find((item) => item.id === sort)!;

  const renderRow = (row: ListRow) => {
    const record = row.record;
    const lit = chain?.has(row.id) ?? false;
    const chip = standingChip(row, underway.get(row.id));
    const blockers = graph.waitsOn.get(row.id) ?? [];
    const landedBlockers = (record.blocked_by_ids ?? []).filter((id) => !blockers.includes(id));
    const unblocks = row.standing === "landed" ? 0 : downstreamOf(graph, row.id).length;
    const age = daysSince(record.since, now);
    const group = record.part_of ? byId.get(record.part_of) : undefined;
    const otherProject = !filter.project || record.repo !== mountedFilter.project ? record.repo : null;
    const canEdit = editable(record) && row.standing !== "landed";
    const blockerLabel = (id: string) => {
      const blocker = byId.get(id);
      const elsewhere = blocker?.repo && blocker.repo !== record.repo ? ` · ${blocker.repo}` : "";
      return `${id}${elsewhere}`;
    };
    return <div
      key={row.id}
      className={`tl-row ${row.standing}${lit ? " lit" : ""}${hovered === row.id ? " focus" : ""}${selected.has(row.id) ? " selected" : ""}${pending.has(row.id) ? " pending" : ""}`}
      data-row-id={row.id}
      data-id={row.id}
      data-standing={row.standing}
      role="button"
      tabIndex={0}
      aria-label={`${title(record.title)}, ${chip.label}`}
      onClick={() => onOpen(row.id)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(row.id); } }}
      onMouseEnter={() => setHovered(row.id)}
      onFocus={() => setHovered(row.id)}
      onBlur={() => setHovered((current) => (current === row.id ? null : current))}
    >
      <span className="tl-dot" aria-hidden="true" />
      {editing ? <span className="tl-check-cell">{canEdit && <input type="checkbox" className="tl-check" aria-label={`Select ${row.id}`} checked={selected.has(row.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggle(row.id)} />}</span> : null}
      <span className="tl-pri-cell" onClick={(event) => { if (canEdit) { event.stopPropagation(); setMenu(menu === row.id ? null : row.id); } }}>
        {canEdit ? <button type="button" className="tl-pri-button" aria-haspopup="listbox" aria-expanded={menu === row.id} aria-label={`Priority of ${row.id}`} onClick={(event) => { event.stopPropagation(); setMenu(menu === row.id ? null : row.id); }}><PriorityBadge record={record} /></button> : <PriorityBadge record={record} dim={row.standing === "landed"} />}
        {menu === row.id && <PriorityMenu current={record.priority ?? null} onPick={(level) => { setMenu(null); void setPriority([row.id], level); }} onClose={() => setMenu(null)} />}
      </span>
      <span className="tl-copy">
        <strong>{row.standing === "landed" && <CircleCheck size={13} className="tl-landed-mark" aria-hidden="true" />}{title(record.title)}</strong>
        <small>
          <span className="tl-id">{row.id}</span>
          {record.kind && KIND_NAMES[record.kind] && <span>{KIND_NAMES[record.kind]}</span>}
          {otherProject && <span className="tl-project">{otherProject}</span>}
          {blockers.length === 1 && <span className="tl-dep wait" title={`Waits on ${blockerLabel(blockers[0])}`}>waits on {blockerLabel(blockers[0])}</span>}
          {blockers.length > 1 && <span className="tl-dep wait" title={`Waits on ${blockers.map(blockerLabel).join(", ")}`}>waits on {blockers.length}</span>}
          {blockers.length === 0 && landedBlockers.length > 0 && row.standing !== "landed" && <span className="tl-dep done" title={`${landedBlockers.join(", ")} landed`}><Check size={11} /> {landedBlockers.length === 1 ? `${landedBlockers[0]} landed` : `${landedBlockers.length} landed`}</span>}
          {unblocks > 0 && <span className="tl-dep unblocks" title={`${unblocks} open ${unblocks === 1 ? "task waits" : "tasks wait"} on this, directly or through others`}>unblocks {unblocks}</span>}
          {grouping === "none" && group && <button type="button" className="tl-dep group" onClick={(event) => { event.stopPropagation(); onOpenGroup(group.id); }}>{group.title}</button>}
          {row.standing === "held" && record.hold_kind !== "parked" && record.hold_kind !== "captain" && record.hold_reason && <span className="tl-held-why">{record.hold_reason}</span>}
          {row.standing === "held" && record.hold_kind === "captain" && <span className="tl-held-why">You said not now on its call</span>}
          {row.standing === "landed" && record.completion?.date && <span>{shortDate(record.completion.date)}</span>}
        </small>
      </span>
      <span className={`tl-chip tone-${chip.tone}`}>{row.standing === "underway" ? underway.get(row.id)?.icon : null}{chip.label}</span>
      <time className="tl-age" title={record.since ? `Filed ${shortDate(record.since)}` : "Undated"}>{age === null ? "" : `${age}d`}</time>
      <ChevronRight size={15} className="tl-open" aria-hidden="true" />
    </div>;
  };

  const emptyText = search.trim() ? "No task here matches." : view === "open" ? (filter.project ? "Nothing is underway or queued in this project." : "Nothing is underway or queued.")
    : view === "ready" ? "Nothing is ready to start." : view === "blocked" ? "Nothing here waits on other work." : "Nothing is put off.";

  return <section className="dashboard-section tl" data-testid="task-list">
    <div className="section-heading"><span className="section-dot blue" aria-hidden="true" /><h2>Tasks</h2><span className="section-count-label tl-summary">{summary}</span></div>
    <div className="tl-toolbar">
      <div className="tl-views" role="tablist" aria-label="Which tasks">
        {VIEWS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={view === item.id} className={view === item.id ? "on" : ""} onClick={() => setView(item.id)}>{item.label}<span>{counts[item.id]}</span></button>)}
      </div>
      <label className="logbook-search tl-search"><Search size={14} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={filter.project ? "Search this project's tasks" : "Search every task"} aria-label={filter.project ? "Search this project's tasks" : "Search every task"} />{search && <button type="button" className="icon-button" aria-label="Clear the search" onClick={() => setSearch("")}><X size={13} /></button>}</label>
      <label className="tl-select"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as TaskSort)} aria-label="Sort">{SORTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="tl-select"><span>Group</span><select value={grouping} onChange={(event) => setGrouping(event.target.value as TaskGrouping)} aria-label="Group by"><option value="none">None</option><option value="group">Group</option></select></label>
      {mountedFilter.project && (filter.project
        ? <button type="button" className="tl-filter on" onClick={() => setFilter({})} title="Show every project's tasks">{filter.project}<X size={12} /></button>
        : <button type="button" className="tl-filter" onClick={() => setFilter(mountedFilter)}>All projects · only {mountedFilter.project}</button>)}
    </div>
    {editing && selected.size > 0 && <BulkBar
      count={selected.size}
      choices={choices}
      captainDay={captainDay}
      allSelected={allSelected}
      onSelectAll={() => setSelected(new Set(selectable.map((row) => row.id)))}
      onClear={() => setSelected(new Set())}
      onPriority={(level) => void setPriority([...selected], level)}
      onGroup={(group) => void setGroup([...selected], group)}
      onNewGroup={async (name) => {
        const created = await onEdit({ verb: "group-new", title: name, project: filter.project ?? mountedFilter.project ?? byId.get([...selected][0])?.repo ?? "", priority: null });
        if (!created.ok) { setNotice({ tone: "bad", text: created.reason }); return; }
        await run([...selected], (record) => ({ verb: "group", task: record.id, value: created.task, expect: record.part_of ?? "none" }), `Added to ${name}`);
      }}
      onPutOff={(until) => void putOff([...selected], until)}
    />}
    {notice && <p className={`tl-notice ${notice.tone}`} role="status">{notice.text}<button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={13} /></button></p>}
    <div className={`tl-list${chain ? " tracing" : ""}`} ref={list} onMouseLeave={() => setHovered(null)}>
      {chain && outOfSight.above > 0 && <div className="tl-out up" data-testid="chain-above"><span>↑ {outOfSight.above} more of its chain above</span></div>}
      <svg className="tl-lines" width="30" height={height} aria-hidden="true">
        {edges.map((edge) => {
          const from = edge.from.startsWith("offlist:") ? edge.from.slice(8) : edge.from;
          const litEdge = chain !== null && chain.has(edge.to) && chain.has(from);
          return <g key={`${edge.from}>${edge.to}`} className={`tl-edge${edge.stub ? " stub" : ""}${litEdge ? " lit" : ""}`}>
            <path d={edgePath(edge, places)} />
            {edge.stub && <circle cx={LANE_X(edge.lane)} cy={(places.get(edge.to)?.top ?? 0) + 4} r="2.5" />}
          </g>;
        })}
      </svg>
      {shown.length === 0 && sections.every((section) => !section.group) && <div className="tl-empty"><Clock3 size={15} /><span>{emptyText}</span></div>}
      {sections.map((section, index) => <Fragment key={section.group?.id ?? "loose"}>
        {section.group && <div className="tl-group" data-group-id={section.group.id} role="button" tabIndex={0} onClick={() => onOpenGroup(section.group!.id)} onKeyDown={(event) => { if (event.key === "Enter") onOpenGroup(section.group!.id); }}>
          <PriorityBadge record={section.group.record} />
          <strong>{title(section.group.record.title)}</strong>
          <span className="tl-id">{section.group.id}</span>
          <span className="tl-bar" aria-hidden="true"><i style={{ width: `${section.group.total ? (100 * section.group.landed) / section.group.total : 0}%` }} /></span>
          <span className="tl-group-count">{section.group.total ? `${section.group.landed} of ${section.group.total} landed` : "No tasks yet"}</span>
          <ChevronRight size={15} className="tl-open" aria-hidden="true" />
        </div>}
        {grouping === "group" && !section.group && section.rows.length > 0 && sections.length > 1 && <div className="tl-label">Not in a group <span>{section.rows.length}</span></div>}
        {grouping === "none" && view === "open" && index === 0 && section.rows.some((row) => row.standing === "underway") && <div className="tl-label">Underway <span>{section.rows.filter((row) => row.standing === "underway").length}</span></div>}
        {section.rows.map((row, rowIndex) => <Fragment key={row.id}>
          {grouping === "none" && view === "open" && row.standing !== "underway" && (rowIndex === 0 || section.rows[rowIndex - 1].standing === "underway") && <div className="tl-label">Up next <small>{sortInfo.label.toLowerCase()}: {sortInfo.hint}</small></div>}
          {renderRow(row)}
        </Fragment>)}
      </Fragment>)}
      {chain && outOfSight.below > 0 && <div className="tl-out down" data-testid="chain-below"><span>↓ {outOfSight.below} more of its chain below</span></div>}
    </div>
  </section>;
}

/** The five priorities to pick from, each with what it means to the first mate. */
function PriorityMenu({ current, onPick, onClose }: { current: string | null; onPick: (level: number) => void; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("[aria-selected='true'], button")?.focus();
    const away = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape, true); };
  }, [onClose]);
  return <div className="tl-menu" role="listbox" aria-label="Priority" ref={menu} onClick={(event) => event.stopPropagation()}>
    {PRIORITIES.map((item) => <button key={item.level} type="button" role="option" aria-selected={current === String(item.level)} onClick={() => onPick(item.level)}>
      <span className={`tl-pri p${item.level}`}>P{item.level}</span><span><b>{item.name}</b><small>{item.meaning}</small></span>{current === String(item.level) && <Check size={13} />}
    </button>)}
  </div>;
}

/** A day `days` after the captain's day, as `yyyy-mm-dd`. */
export function dayAfter(captainDay: string | null | undefined, days: number) {
  const base = captainDay && /^\d{4}-\d{2}-\d{2}$/.test(captainDay) ? captainDay : new Date().toISOString().slice(0, 10);
  const [y, m, d] = base.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Several tasks at once: priority, group and put off, nothing structural. */
function BulkBar({ count, choices, captainDay, allSelected, onSelectAll, onClear, onPriority, onGroup, onNewGroup, onPutOff }: {
  count: number; choices: BacklogRecord[]; captainDay?: string | null; allSelected: boolean; onSelectAll: () => void; onClear: () => void;
  onPriority: (level: number) => void; onGroup: (group: string) => void; onNewGroup: (name: string) => Promise<void>; onPutOff: (until: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(dayAfter(captainDay, 7));
  return <div className="tl-bulk" data-testid="bulk-bar">
    <strong>{count} selected</strong>
    {!allSelected && <button type="button" className="tl-bulk-link" onClick={onSelectAll}>Select all</button>}
    <label><span className="sr-only">Priority for the selected tasks</span><select value="" onChange={(event) => { if (event.target.value !== "") onPriority(Number(event.target.value)); }} aria-label="Priority for the selected tasks">
      <option value="">Priority…</option>{PRIORITIES.map((item) => <option key={item.level} value={item.level}>P{item.level} {item.name}</option>)}
    </select></label>
    {naming
      ? <form className="tl-bulk-new" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onNewGroup(name.trim()).then(() => { setNaming(false); setName(""); }); }}>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Name the group" aria-label="New group's name" />
          <button type="submit" disabled={!name.trim()}>Add</button><button type="button" onClick={() => setNaming(false)}>Cancel</button>
        </form>
      : <label><span className="sr-only">Group for the selected tasks</span><select value="" onChange={(event) => { if (event.target.value === "new") setNaming(true); else if (event.target.value) onGroup(event.target.value); }} aria-label="Group for the selected tasks">
          <option value="">Group…</option>{choices.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}<option value="none">No group</option><option value="new">New group…</option>
        </select></label>}
    <span className="tl-bulk-date"><input type="date" value={date} min={dayAfter(captainDay, 1)} onChange={(event) => setDate(event.target.value)} aria-label="Put off until" /><button type="button" onClick={() => onPutOff(date)} disabled={!date}>Put off</button></span>
    <button type="button" className="tl-bulk-link" onClick={onClear}>Clear</button>
  </div>;
}
