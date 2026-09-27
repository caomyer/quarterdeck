/**
 * What a task's drawer adds for the task list: its Details, which the captain edits; its Chain, everything it waits
 * on down to where to start; and what waits on it.
 *
 * Every change goes through `onEdit` to firstmate's `fm-task-edit.sh`, and a refusal is shown under the field it came
 * from, in the script's words. What cannot change is shown locked, with why and the one way it can: work in flight
 * keeps the project, kind and dependencies it was briefed with, and a task the first mate is starting keeps them until
 * it has.
 */
import { ArrowRight, Check, ChevronRight, Lock, Pencil, Plus, Repeat2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BacklogRecord, TaskEdit, TaskEdited } from "./host/types";
import { dayAfter, PriorityBadge, shortDate } from "./TaskList";
import { downstreamOf, groupChoices, loopThrough, openById, priorityIsSet, priorityLevel, PRIORITIES, standingOf, startHere, taskGraph, upstreamOf, type ChainNode, upstreamTree } from "./tasks";

const KIND_NAMES: Record<string, string> = { scout: "Scout", ship: "Ship", secondmate: "Second mate", captain: "Call", program: "Group" };

function Section({ title, testid, children }: { title: string; testid?: string; children: React.ReactNode }) {
  return <section className="drawer-section" data-testid={testid}><h3>{title}</h3>{children}</section>;
}

/** Why the project, kind and dependencies cannot change now, and what to do instead. */
export type DetailsLock = { reason: "running" | "asked"; text: string; ask?: () => void };

type Refusal = { field: string; code: string; reason: string };

function RefusalLine({ refusal }: { refusal: Refusal }) {
  const icon = refusal.code === "loop" ? <Repeat2 size={14} /> : refusal.code === "stale" ? <RotateCcw size={14} /> : <TriangleAlert size={14} />;
  return <p className={`td-refusal ${refusal.code}`} role="alert" data-code={refusal.code}>{icon}<span>{refusal.reason}</span></p>;
}

/** The drawer's editable attributes. */
export function TaskDetails({ record, records, projects, captainDay, editing, lock, onEdit, onOpen }: {
  record: BacklogRecord; records: BacklogRecord[]; projects: string[]; captainDay?: string | null; editing: boolean;
  lock: DetailsLock | null; onEdit: (edit: TaskEdit) => Promise<TaskEdited>; onOpen: (id: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(record.title);
  const [adding, setAdding] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [date, setDate] = useState(record.hold_kind === "parked" && record.hold_until ? record.hold_until : dayAfter(captainDay, 7));
  // A different task in the same drawer starts clean.
  useEffect(() => { setRefusal(null); setRenaming(false); setAdding(false); setGrouping(false); }, [record.id]);

  const byId = useMemo(() => openById(records), [records]);
  const groups = useMemo(() => groupChoices(records, record.repo), [records, record.repo]);
  const group = record.part_of ? byId.get(record.part_of) ?? records.find((item) => item.id === record.part_of) : undefined;
  const blockers = record.blocked_by_ids ?? [];
  const locked = Boolean(lock);
  const closed = record.state === "done";
  const isCall = record.kind === "captain";
  const canEdit = editing && !closed && !isCall;

  async function change(field: string, edit: TaskEdit) {
    setPending(field);
    setRefusal(null);
    try {
      const result = await onEdit(edit);
      if (!result.ok) { setRefusal({ field, code: result.code, reason: result.reason }); return false; }
      return true;
    } catch (error) {
      setRefusal({ field, code: "error", reason: String(error) });
      return false;
    } finally {
      setPending(null);
    }
  }

  const refusalFor = (field: string) => refusal?.field === field ? <RefusalLine refusal={refusal} /> : null;
  const lockedField = (text: string) => <span className="td-field locked"><span>{text}</span><Lock size={12} aria-label="Locked" /></span>;

  // Every other open task this one could wait on, this project's first; the script refuses any that would loop.
  const candidates = [...byId.values()]
    .filter((item) => item.id !== record.id && item.kind !== "program" && item.kind !== "captain" && !blockers.includes(item.id))
    .sort((a, b) => Number(b.repo === record.repo) - Number(a.repo === record.repo) || (a.start_rank ?? 1e9) - (b.start_rank ?? 1e9) || a.id.localeCompare(b.id));

  const hold = record.hold_reason ? record.hold_kind ?? "other" : null;

  return <Section title="Details" testid="task-details">
    <div className={`td-attrs${pending ? " busy" : ""}`}>
      <span className="td-key">Priority</span>
      <span className="td-value">
        {canEdit
          ? <label className="td-field select"><PriorityBadge record={record} /><select value={priorityIsSet(record) ? record.priority! : ""} disabled={pending === "priority"} aria-label="Priority" onChange={(event) => void change("priority", { verb: "priority", task: record.id, value: event.target.value, expect: record.priority ?? "none" })}>
              {!priorityIsSet(record) && <option value="">Normal, not set</option>}
              {PRIORITIES.map((item) => <option key={item.level} value={String(item.level)}>{item.name}</option>)}
            </select></label>
          : <span className="td-field plain"><PriorityBadge record={record} /> {PRIORITIES[priorityLevel(record)].name}</span>}
        {refusalFor("priority")}
      </span>

      <span className="td-key">Title</span>
      <span className="td-value">
        {renaming
          ? <form className="td-rename" onSubmit={(event) => { event.preventDefault(); void change("title", { verb: "title", task: record.id, value: name.trim(), expect: record.title }).then((ok) => { if (ok) setRenaming(false); }); }}>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} aria-label="Title" />
              <button type="submit" className="btn-base primary" disabled={!name.trim() || name.trim() === record.title || pending === "title"}>Save</button>
              <button type="button" className="btn-base" onClick={() => { setRenaming(false); setRefusal(null); }}>Cancel</button>
            </form>
          : <span className="td-field plain td-title"><span>{record.title}</span>{canEdit && <button type="button" className="icon-button td-icon" aria-label="Rename" title="Rename" onClick={() => { setName(record.title); setRenaming(true); }}><Pencil size={13} /></button>}</span>}
        {refusalFor("title")}
      </span>

      <span className="td-key">Project</span>
      <span className="td-value">
        {canEdit && !locked && record.kind !== "program"
          ? <label className="td-field select"><select value={record.repo ?? ""} aria-label="Project" disabled={pending === "project"} onChange={(event) => void change("project", { verb: "project", task: record.id, value: event.target.value, expect: record.repo ?? "none" })}>
              {!record.repo && <option value="">No project</option>}
              {[...new Set([...(record.repo ? [record.repo] : []), ...projects])].map((project) => <option key={project} value={project}>{project}</option>)}
            </select></label>
          : record.kind === "program" ? <span className="td-field plain">{record.repo ?? "No project"}</span> : lockedField(record.repo ?? "No project")}
        {refusalFor("project")}
      </span>

      {record.kind !== "program" && <>
        <span className="td-key">Kind</span>
        <span className="td-value">
          {canEdit && !locked
            ? <label className="td-field select"><select value={record.kind ?? "ship"} aria-label="Kind" disabled={pending === "kind"} onChange={(event) => void change("kind", { verb: "kind", task: record.id, value: event.target.value, expect: record.kind ?? "none" })}>
                <option value="ship">Ship: changes the project</option><option value="scout">Scout: finds out, reports back</option>
              </select></label>
            : lockedField(KIND_NAMES[record.kind ?? ""] ?? record.kind ?? "Task")}
          {refusalFor("kind")}
        </span>

        <span className="td-key">Group</span>
        <span className="td-value">
          {canEdit && grouping
            ? <form className="td-rename" onSubmit={(event) => {
                event.preventDefault();
                const title = groupName.trim();
                if (!title) return;
                void (async () => {
                  setPending("group");
                  const created = await onEdit({ verb: "group-new", title, project: record.repo ?? projects[0] ?? "", priority: null });
                  setPending(null);
                  if (!created.ok) { setRefusal({ field: "group", code: created.code, reason: created.reason }); return; }
                  if (await change("group", { verb: "group", task: record.id, value: created.task, expect: record.part_of ?? "none" })) { setGrouping(false); setGroupName(""); }
                })();
              }}>
                <input autoFocus value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Name the group" aria-label="New group's name" />
                <button type="submit" className="btn-base primary" disabled={!groupName.trim()}>Add</button>
                <button type="button" className="btn-base" onClick={() => setGrouping(false)}>Cancel</button>
              </form>
            : canEdit
            ? <label className="td-field select"><select value={record.part_of ?? "none"} aria-label="Group" disabled={pending === "group"} onChange={(event) => {
                if (event.target.value === "new") { setGrouping(true); return; }
                void change("group", { verb: "group", task: record.id, value: event.target.value, expect: record.part_of ?? "none" });
              }}>
                <option value="none">No group</option>
                {record.part_of && !groups.some((item) => item.id === record.part_of) && <option value={record.part_of}>{group?.title ?? `${record.part_of}, not in this home`}</option>}
                {groups.map((item) => <option key={item.id} value={item.id}>{item.title}{item.repo !== record.repo ? ` (${item.repo})` : ""}</option>)}
                <option value="new">New group…</option>
              </select></label>
            : <span className="td-field plain">{group ? group.title : record.part_of ? `${record.part_of}, not in this home` : "No group"}</span>}
          {refusalFor("group")}
        </span>

        <span className="td-key">Waits on</span>
        <span className="td-value">
          <span className="td-deps">
            {blockers.length === 0 && !adding && <span className="td-none">Nothing</span>}
            {blockers.map((id) => {
              const blocker = byId.get(id) ?? records.find((item) => item.id === id);
              const open = (record.unresolved_blocker_ids ?? blockers).includes(id);
              return <span key={id} className={`td-dep${open ? "" : " landed"}`}>
                <button type="button" className="td-dep-open" onClick={() => onOpen(id)} title={blocker?.title ?? id}>{!open && <Check size={11} />}{id}{blocker?.repo && blocker.repo !== record.repo ? <em> · {blocker.repo}</em> : null}</button>
                {canEdit && !locked && <button type="button" className="td-dep-drop" aria-label={`Stop waiting on ${id}`} disabled={pending === "deps"} onClick={() => void change("deps", { verb: "unblock", task: record.id, by: id })}><X size={11} /></button>}
              </span>;
            })}
            {canEdit && !locked && (adding
              ? <select autoFocus className="td-dep-add" value="" aria-label="Wait on" onBlur={() => setAdding(false)} onChange={(event) => { const by = event.target.value; setAdding(false); if (by) void change("deps", { verb: "block", task: record.id, by }); }}>
                  <option value="">Wait on…</option>
                  {candidates.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.title.slice(0, 60)}{item.repo !== record.repo ? ` (${item.repo})` : ""}</option>)}
                </select>
              : <button type="button" className="td-add" onClick={() => { setRefusal(null); setAdding(true); }}><Plus size={12} /> Add</button>)}
            {locked && blockers.length === 0 && <Lock size={12} className="td-lock" aria-label="Locked" />}
          </span>
          {refusalFor("deps")}
        </span>

        <span className="td-key">Put off</span>
        <span className="td-value">
          {hold === "captain"
            ? lockedField(record.hold_until ? `Until ${shortDate(record.hold_until)}, on its call` : "Waiting on its call")
            : hold && hold !== "parked"
            ? lockedField(`Held by the first mate: ${record.hold_reason}`)
            : !canEdit || locked
            ? lockedField(hold === "parked" && record.hold_until ? `Until ${shortDate(record.hold_until)}` : "Not put off")
            : <span className="td-putoff">
                {hold === "parked" && <span className="td-until">Until {record.hold_until ? shortDate(record.hold_until) : "later"}</span>}
                <input type="date" value={date} min={dayAfter(captainDay, 1)} onChange={(event) => setDate(event.target.value)} aria-label="Put off until" />
                <button type="button" className="btn-base" disabled={!date || pending === "putoff" || date === record.hold_until} onClick={() => void change("putoff", { verb: "park", task: record.id, until: date, expect: hold === "parked" ? record.hold_until ?? "none" : "none" })}>{hold === "parked" ? "Move" : "Put off"}</button>
                {hold === "parked" && <button type="button" className="btn-base" disabled={pending === "putoff"} onClick={() => void change("putoff", { verb: "unpark", task: record.id, expect: record.hold_until ?? "none" })}>Bring back</button>}
              </span>}
          {refusalFor("putoff")}
        </span>
      </>}
    </div>
    {lock && <div className="td-lockwhy" data-testid="details-lock"><Lock size={13} /><p>{lock.text}</p>{lock.ask && <button type="button" className="landed-link" onClick={lock.ask}>Ask the first mate to re-scope it</button>}</div>}
    {!editing && <p className="td-note">This home's firstmate can't change a task from here yet.</p>}
  </Section>;
}

const STANDING_WORDS: Record<string, { tone: string; label: string }> = {
  ready: { tone: "green", label: "Ready" }, blocked: { tone: "amber", label: "Blocked" }, held: { tone: "muted", label: "Put off" },
  in_flight: { tone: "blue", label: "Underway" }, done: { tone: "muted", label: "Landed" },
};

function standingWords(record: BacklogRecord | undefined, captainDay?: string | null) {
  if (!record) return { tone: "muted", label: "Not in this home" };
  if (record.state === "in_flight") return STANDING_WORDS.in_flight;
  if (record.state === "done") return STANDING_WORDS.done;
  return STANDING_WORDS[standingOf(record, captainDay) ?? "ready"];
}

const WIDE = 4;
const DEEP = 3;

/** Everything a task waits on, as a tree down to where to start, and any loop it sits in. */
export function TaskChain({ record, records, captainDay, editing, title = (text) => text, onOpen, onEdit }: {
  record: BacklogRecord; records: BacklogRecord[]; captainDay?: string | null; editing: boolean; title?: (text: string) => string;
  onOpen: (id: string) => void; onEdit: (edit: TaskEdit) => Promise<TaskEdited>;
}) {
  const graph = useMemo(() => taskGraph(records), [records]);
  const tree = useMemo(() => upstreamTree(graph, record.id), [graph, record.id]);
  const loop = useMemo(() => loopThrough(graph, record.id), [graph, record.id]);
  const roots = useMemo(() => startHere(graph, record.id, captainDay), [graph, record.id, captainDay]);
  const upstream = useMemo(() => upstreamOf(graph, record.id), [graph, record.id]);
  const [deep, setDeep] = useState(false);
  const [wide, setWide] = useState<Set<string>>(new Set());
  const [refusal, setRefusal] = useState<string | null>(null);
  const landed = (record.blocked_by_ids ?? []).filter((id) => !(graph.waitsOn.get(record.id) ?? []).includes(id));
  if (tree.length === 0 && landed.length === 0 && !loop) return null;

  const depthOf = (nodes: ChainNode[]): number => nodes.reduce((max, node) => Math.max(max, node.depth, depthOf(node.children)), 0);
  const deepest = depthOf(tree);
  const node = (item: ChainNode, parent: string): React.ReactNode => {
    const words = item.loop ? { tone: "coral", label: "Loop" } : standingWords(item.record, captainDay);
    const shown = !deep && item.depth >= DEEP ? [] : item.children;
    const key = `${parent}>${item.id}`;
    const open = wide.has(key);
    const kids = open ? shown : shown.slice(0, WIDE);
    return <li key={key} className={`td-node${roots.includes(item.id) ? " start" : ""}`} style={{ "--depth": item.depth } as React.CSSProperties}>
      <button type="button" onClick={() => onOpen(item.id)} data-chain-id={item.id}>
        <span className={`td-node-dot tone-${words.tone}`} />
        <span className="td-node-copy"><strong>{item.record ? title(item.record.title) : item.id}</strong><small>{item.id}{item.record ? ` · P${priorityLevel(item.record)}` : ""}{item.record?.repo && item.record.repo !== record.repo ? ` · ${item.record.repo}` : ""}</small></span>
        <span className={`td-node-chip tone-${words.tone}`}>{words.label}</span>
      </button>
      {kids.length > 0 && <ul>{kids.map((child) => node(child, key))}</ul>}
      {!open && shown.length > WIDE && <button type="button" className="td-more" style={{ "--depth": item.depth + 1 } as React.CSSProperties} onClick={() => setWide(new Set([...wide, key]))}>+{shown.length - WIDE} more</button>}
    </li>;
  };
  const topOpen = wide.has("root");
  const top = topOpen ? tree : tree.slice(0, WIDE);
  const rootRecord = (id: string) => graph.byId.get(id);

  return <Section title="Chain" testid="task-chain">
    <div className="td-chain">
      <div className="td-node here"><span className="td-node-dot here" /><span className="td-node-copy"><strong>This task</strong><small>{record.id}</small></span><span className={`td-node-chip tone-${standingWords(record, captainDay).tone}`}>{standingWords(record, captainDay).label}</span></div>
      {tree.length > 0 && <ul>{top.map((item) => node(item, "root"))}</ul>}
      {!topOpen && tree.length > WIDE && <button type="button" className="td-more" style={{ "--depth": 1 } as React.CSSProperties} onClick={() => setWide(new Set([...wide, "root"]))}>+{tree.length - WIDE} more</button>}
      {!deep && deepest > DEEP && <button type="button" className="td-more deeper" style={{ "--depth": DEEP + 1 } as React.CSSProperties} onClick={() => setDeep(true)}><ChevronRight size={12} /> {deepest - DEEP} more {deepest - DEEP === 1 ? "level" : "levels"}</button>}
      {landed.length > 0 && <p className="td-landed"><Check size={12} /> {landed.length} landed: {landed.join(", ")}</p>}
    </div>
    {loop && <div className="td-loop" data-testid="chain-loop">
      <p><Repeat2 size={14} /> <span><b>These tasks wait on each other.</b> {loop.map((id, index) => `${id} waits on ${loop[(index + 1) % loop.length]}`).join(", ")}, so none of them can start.</span></p>
      {editing && <div className="td-loop-actions">{loop.map((id, index) => {
        const by = loop[(index + 1) % loop.length];
        return <button key={id} type="button" className="btn-base" onClick={() => void onEdit({ verb: "unblock", task: id, by }).then((result) => setRefusal(result.ok ? null : result.reason))}>Remove {id} <ArrowRight size={12} /> {by}</button>;
      })}</div>}
      {refusal && <RefusalLine refusal={{ field: "loop", code: "error", reason: refusal }} />}
    </div>}
    {roots.length > 0 && <div className="td-start" data-testid="start-here">
      <p><b>Start here:</b> {roots.length === 1
        ? <>{title(rootRecord(roots[0])?.title ?? roots[0])} is ready{upstream.length === 1 ? ", and it is the only thing between this task and the front of the queue" : ""}.</>
        : <>{roots.length} tasks at the root of this chain are ready.</>}</p>
      <div className="td-start-actions">{roots.slice(0, 3).map((id) => <button key={id} type="button" className="btn-base" onClick={() => onOpen(id)}>{roots.length === 1 ? "Open it" : `Open ${id}`}</button>)}</div>
    </div>}
  </Section>;
}

/** What waits on this task, directly or through others. */
export function WaitingOnThis({ record, records, title = (text) => text, onOpen }: { record: BacklogRecord; records: BacklogRecord[]; title?: (text: string) => string; onOpen: (id: string) => void }) {
  const graph = useMemo(() => taskGraph(records), [records]);
  const direct = graph.waitedOnBy.get(record.id) ?? [];
  const all = downstreamOf(graph, record.id);
  const [open, setOpen] = useState(false);
  // A task in no chain at all has nothing to say here.
  if (record.state === "done" || record.kind === "program" || (direct.length === 0 && (graph.waitsOn.get(record.id) ?? []).length === 0)) return null;
  const shown = open ? direct : direct.slice(0, WIDE);
  return <Section title="Waiting on this" testid="waiting-on-this">
    {direct.length === 0
      ? <p className="td-quiet">Nothing else waits on this task.</p>
      : <div className="td-waiting">
          {shown.map((id) => {
            const item = graph.byId.get(id);
            return <button key={id} type="button" onClick={() => onOpen(id)}><span className="td-node-dot tone-amber" /><span className="td-node-copy"><strong>{item ? title(item.title) : id}</strong><small>{id}{item ? ` · P${priorityLevel(item)}` : ""}</small></span></button>;
          })}
          {!open && direct.length > WIDE && <button type="button" className="td-more" onClick={() => setOpen(true)}>+{direct.length - WIDE} more</button>}
          {all.length > direct.length && <p className="td-quiet">{all.length - direct.length} more wait on those in turn.</p>}
        </div>}
  </Section>;
}
