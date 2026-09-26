/**
 * Work from other task systems, as every screen reads it: which items a project is offered, where an ask to take one
 * on stands, what a linked task's item says upstream and how fresh that is, and what the fleet has written back.
 *
 * Everything here is read from firstmate's own records, never inferred: the snapshot's `sources` (written only by
 * `bin/fm-sources.sh`), each backlog row's `source_links`, and the take-on ask the app recorded. Nothing here knows
 * one provider from another except to name it: a link, an item and a write have the same shape for all of them.
 */
import type { BacklogRecord, FleetSnapshot, HostRuntimeState, SourceFiled, SourceItem, SourceLink, SourcesRead, SourceWrite, TakeOnAsk, TaskSource } from "./host/types";
import { type AskDelivery, askProgress } from "./start.ts";

/** How long without a successful read before a source's items are shown as a reading from then, not now. */
export const STALE_MS = 30 * 60_000;

/** A provider's name as a captain knows it. Only for display: nothing else here tells providers apart. */
const PROVIDER_NAMES: Record<string, string> = { github: "GitHub", linear: "Linear", jira: "Jira" };

export function providerName(provider: string) {
  return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** What fixes a refused sign-in, in the captain's terms. GitHub's is the first mate's own `gh` sign-in. */
const SIGN_IN_FIX: Record<string, string> = { github: "Sign GitHub in again: run gh auth login in Terminal." };

/** The sources the snapshot carries, or why it carries none. A home whose firstmate predates them has neither. */
export function sourcesOf(fleet: FleetSnapshot | null | undefined): { sources: TaskSource[]; problem: string | null; firstMilestone: string | null } {
  const read = fleet?.sources;
  if (!read) return { sources: [], problem: null, firstMilestone: null };
  if ("error" in read) return { sources: [], problem: read.error, firstMilestone: null };
  return { sources: read.sources ?? [], problem: (read as SourcesRead).problem ?? null, firstMilestone: (read as SourcesRead).first_milestone ?? null };
}

/**
 * When the fleet first speaks upstream, from firstmate's one setting (`FIRST_MILESTONE` in `bin/fm-sources.sh`), which
 * the snapshot carries so no screen keeps its own copy.
 */
export function firstWords(firstMilestone: string | null | undefined) {
  return firstMilestone === "started" ? "It says work has started as soon as a worker is on it." : "Nothing is said before there is a PR to point at.";
}

/** A link as a screen shows it: the source it names (absent when that source is not connected here) and its item. */
export type LinkView = { link: SourceLink; source: TaskSource | null; item: SourceItem | null; filed: SourceFiled | null };

export function linkViews(record: BacklogRecord | undefined, sources: TaskSource[]): LinkView[] {
  return (record?.source_links ?? []).map((link) => {
    const source = sources.find((candidate) => candidate.id === link.source) ?? null;
    const item = source?.items[link.item] ?? null;
    return { link, source, item, filed: item?.filed ?? source?.filed[link.item] ?? null };
  });
}

/** How long ago, in the words a chip uses. */
export function ago(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** A time of day, the way the app writes one everywhere else. */
function clock(at: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

/** How fresh a source's reading is: "read 3 min ago", or "as of 13:20" once it is too old to call current. */
export function freshness(source: TaskSource, now: number) {
  if (!source.last_read) return "not read yet";
  const at = Date.parse(source.last_read);
  return now - at >= STALE_MS ? `as of ${clock(source.last_read)}` : `read ${ago(now - at)}`;
}

/** An item's state in a chip's words: the provider's own label, or "gone" when it was deleted. */
export function itemState(item: SourceItem) {
  if (item.deleted) return "deleted";
  return item.state === "done" || item.state === "cancelled" ? (item.state === "cancelled" ? "cancelled" : "closed") : item.state_name || item.state;
}

/** The chip on a linked task: "GitHub #2 open · read 3 min ago", or why the item cannot be shown. */
export function chipText(view: LinkView, now: number) {
  if (!view.source) return `${view.link.source} · not connected in this home`;
  const name = providerName(view.source.provider);
  const shown = view.item ?? view.filed;
  if (!shown) return `${name} · not read yet`;
  const state = view.item ? itemState(view.item) : shown.state_name;
  return `${name} ${shown.key} ${state} · ${freshness(view.source, now)}`;
}

/** The tone of an item's state, from the tokens: open is blue, done green, cancelled or gone muted. */
export function chipTone(view: LinkView) {
  if (!view.source || !view.item) return "muted";
  if (view.item.deleted || view.item.state === "cancelled") return "muted";
  return view.item.state === "done" ? "green" : "blue";
}

/**
 * Why a source's reading cannot be trusted as current, in the captain's terms, or null when it can. A single slow read
 * says nothing: only a typed failure that has persisted, or no successful read for half an hour, is worth a note.
 */
export function readingProblem(source: TaskSource, now: number): { title: string; detail: string } | null {
  const name = providerName(source.provider);
  const failure = source.failure;
  const since = source.last_read ? Date.parse(source.last_read) : null;
  const staleFor = since === null ? null : now - since;
  const persisted = failure && (failure.count >= 3 || now - Date.parse(failure.first_at) >= STALE_MS);
  const waiting = source.outbox.length;
  const owed = waiting ? ` ${waiting === 1 ? "One write is" : `${waiting} writes are`} waiting; ${waiting === 1 ? "it goes" : "they go"} once, when reading works again.` : "";
  if (failure && persisted) {
    if (failure.code === "rate_limited") {
      const until = failure.retry_at ? ` until ${clock(failure.retry_at)}` : "";
      return { title: `${name} is rate limiting this Mac${until}`, detail: `What you see is from ${since ? clock(source.last_read!) : "before"}; nothing is lost, and reading resumes on its own.${owed}` };
    }
    if (failure.code === "auth") return { title: `${name} refused the sign-in at ${clock(failure.first_at)}`, detail: `Nothing has been read${waiting ? " or posted" : ""} since.${owed} ${SIGN_IN_FIX[source.provider] ?? `Sign ${name} in again.`}` };
    if (failure.code === "scope") return { title: `The ${name} sign-in may not read this`, detail: `${failure.detail}${owed}` };
    if (failure.code === "not_found") return { title: `${name} no longer has ${source.locator}`, detail: `It may have been renamed, moved or made private.${owed}` };
    return { title: `${name} could not be read since ${clock(failure.first_at)}`, detail: `${failure.detail}${owed}` };
  }
  if (staleFor !== null && staleFor >= STALE_MS) {
    return { title: `${name} has not been read for ${Math.round(staleFor / 60_000)} minutes`, detail: `What you see is from ${clock(source.last_read!)}. The first mate reads it every five minutes while it runs.${owed}` };
  }
  return null;
}

/** What the captain is told about an item that moved on without the task: closed, cancelled or deleted upstream, or edited since it was filed. */
export function divergence(view: LinkView, record: BacklogRecord | undefined): { tone: "amber" | "muted"; title: string; detail: string } | null {
  const item = view.item;
  if (!item || !view.source) return null;
  const name = providerName(view.source.provider);
  const working = record?.state === "in_flight";
  const done = record?.state === "done";
  if (item.deleted) return { tone: working ? "amber" : "muted", title: `${item.key} was deleted on ${name}`, detail: working ? "The work here goes on until the first mate or you decide otherwise; nothing here changes by itself." : "Nothing here changed because of it." };
  if (!done && (item.state === "cancelled" || item.state === "done")) {
    const how = item.state === "cancelled" ? "cancelled" : "closed";
    return { tone: working ? "amber" : "muted", title: `${item.key} was ${how} on ${name}`, detail: working ? "The worker is still on it. The first mate was told, and asks you if it should stop; nothing here changes until then." : "The task is still here. The first mate was told, and decides whether it still needs doing." };
  }
  return null;
}

/** Whether an item's text moved on since it was filed, so the drawer shows both. */
export function changedSinceFiled(view: LinkView) {
  const { item, filed } = view;
  return Boolean(item && filed && (item.title !== filed.title || item.body !== filed.body));
}

/** A write still owed, by what it is. */
const OWED_WORDS: Record<SourceWrite["intent"], string> = {
  started: "Started comment",
  "in-review": "PR comment",
  delivered: "Completion comment",
  stopped: "Stopped comment",
};

const WRITE_WORDS: Record<SourceWrite["intent"], string> = {
  started: "Said work had started",
  "in-review": "Commented: the PR is up",
  delivered: "Commented: landed, with the summary",
  stopped: "Said work had stopped",
};

/** One line of a linked task's Upstream timeline. */
export type UpstreamLine = { at: string | null; kind: "linked" | "written" | "owed" | "status" | "upstream"; tone: "green" | "blue" | "amber" | "coral" | "muted"; text: string; detail?: string };

/**
 * What passed between the task and its item: when it was linked, each write the fleet made or owes, and what the
 * item did on its own. Oldest first.
 */
export function upstreamLines(view: LinkView, task: string): UpstreamLine[] {
  const source = view.source;
  if (!source) return [{ at: null, kind: "linked", tone: "muted", text: `Linked to ${view.link.item} on ${view.link.source}`, detail: "That source is not connected in this home, so it is not read, and anything owed to it waits here until it is." }];
  const name = providerName(source.provider);
  const key = view.item?.key ?? view.filed?.key ?? view.link.item;
  const lines: UpstreamLine[] = [];
  lines.push({ at: view.filed?.filed_at ?? null, kind: "linked", tone: "muted", text: `Linked to ${key}`, detail: view.link.role === "contributes" ? "This task is part of the work for it." : undefined });
  const mine = (write: SourceWrite) => write.task === task && write.item === view.link.item;
  for (const write of source.sent.filter(mine)) {
    if (write.superseded) continue;
    if (write.withheld) {
      lines.push({ at: write.at ?? null, kind: "written", tone: "muted", text: "Not posted", detail: `This source is set to write nothing back, so "${WRITE_WORDS[write.intent]}" stayed here.` });
      continue;
    }
    lines.push({ at: write.at ?? null, kind: "written", tone: "green", text: WRITE_WORDS[write.intent], detail: write.pr ?? undefined });
    const advance = write.advance;
    if (advance?.result === "moved") lines.push({ at: write.at ?? null, kind: "status", tone: "green", text: `Moved to "${advance.to}"` });
    else if (advance?.result === "ambiguous") lines.push({ at: write.at ?? null, kind: "status", tone: "amber", text: `Status left at "${advance.from}"`, detail: `${key} could move to any of ${advance.candidates.map((state) => `"${state}"`).join(", ")}, so none was chosen. The comment says so.` });
  }
  for (const write of source.outbox.filter(mine)) {
    const error = (write.attempts ?? 0) > 0 ? write.last_error : null;
    const why = error && error.detail !== "unconfirmed" ? ` (${error.detail})` : "";
    lines.push({
      at: write.created ?? null,
      kind: "owed",
      tone: error ? ((write.attempts ?? 0) >= 2 ? "coral" : "amber") : "blue",
      text: error ? `${OWED_WORDS[write.intent]} not confirmed` : `${OWED_WORDS[write.intent]} waiting to post`,
      detail: error ? `${name} did not confirm it${why}. It stays waiting and is tried again on the next read; it is never posted twice.` : `It posts on the next read of ${name}.`,
    });
  }
  const item = view.item;
  if (item && (item.state === "done" || item.state === "cancelled" || item.deleted)) {
    lines.push({ at: item.updated_at, kind: "upstream", tone: "muted", text: item.deleted ? `Deleted on ${name}` : item.state === "cancelled" ? `Cancelled on ${name}` : `Closed on ${name}` });
  }
  return lines.sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0));
}

/** The policy line for a linked task: what it writes upstream, and what comes next for this task. */
export function policyLine(source: TaskSource, record: BacklogRecord, item: string, firstMilestone: string | null): { text: string; detail: string } {
  const name = providerName(source.provider);
  if (source.outbound === "none") return { text: `Writes nothing back to ${name}`, detail: "Change that in Settings, Task sources." };
  const text = source.outbound === "comments+status" ? "Comments at each milestone, and moves its status forward" : firstMilestone === "started" ? "Comments when work starts, when a PR is up, and once when it lands" : "Comments when a PR is up, and once when it lands";
  const mine = (write: SourceWrite) => write.task === record.id && write.item === item && !write.superseded;
  const written = new Set(source.sent.filter(mine).map((write) => write.intent));
  const owed = new Set(source.outbox.filter(mine).map((write) => write.intent));
  const detail = owed.size > 0 ? "What is owed posts once, on a read that works."
    : record.state === "done" ? (written.has("delivered") ? "Nothing more is owed." : "It closed without landing, so nothing more is posted.")
    : written.has("in-review") ? "Next: one comment when it lands."
    : firstWords(firstMilestone);
  return { text, detail };
}

/** Where taking an offered item on stands. */
export type TakeOnPhase = "offered" | "offline" | "asked" | "not_sent" | "answered" | "filed";

export type OfferRow = { source: TaskSource; item: SourceItem; ask: TakeOnAsk | null; filedAs: BacklogRecord | null; phase: TakeOnPhase };

export function askKey(source: string, item: string) {
  return `${source} ${item}`;
}

/** The backlog row a take-on ask was filed as: one whose links name the item. */
export function filedAs(source: string, item: string, records: BacklogRecord[]) {
  return records.find((record) => (record.source_links ?? []).some((link) => link.source === source && link.item === item)) ?? null;
}

export type OfferInputs = {
  records: BacklogRecord[];
  asks: Record<string, TakeOnAsk>;
  deliveries: Record<string, AskDelivery | undefined>;
  runtime: HostRuntimeState;
  sendReady: boolean;
  quietSince: number | null;
  snapshotAt: number;
};

export function takeOnPhase(source: string, item: string, inputs: OfferInputs): TakeOnPhase {
  if (filedAs(source, item, inputs.records)) return "filed";
  const ask = inputs.asks[askKey(source, item)] ?? null;
  if (ask) return askProgress(ask, ask.message ? inputs.deliveries[ask.message] : undefined, inputs.runtime, inputs.quietSince, inputs.snapshotAt);
  return inputs.sendReady ? "offered" : "offline";
}

/**
 * A project's intake list: every item its sources offer, and every item the captain asked to take on that is still
 * worth a line (asked, not sent, answered in chat, or filed while the ask is recent). Newest change first.
 */
export function offerRows(project: string, sources: TaskSource[], inputs: OfferInputs, now: number): OfferRow[] {
  const rows: OfferRow[] = [];
  for (const source of sources.filter((candidate) => candidate.project === project)) {
    const ids = new Set(source.offers);
    for (const ask of Object.values(inputs.asks)) {
      if (ask.item.source === source.id && now - ask.at < 24 * 60 * 60_000) ids.add(ask.item.id);
    }
    for (const id of ids) {
      const item = source.items[id];
      if (!item) continue;
      const ask = inputs.asks[askKey(source.id, id)] ?? null;
      const record = filedAs(source.id, id, inputs.records);
      const phase = takeOnPhase(source.id, id, inputs);
      // An item filed before any ask here, or long enough ago, is ordinary backlog work now.
      if (phase === "filed" && !ask) continue;
      rows.push({ source, item, ask, filedAs: record, phase });
    }
  }
  return rows.sort((a, b) => Date.parse(b.item.updated_at) - Date.parse(a.item.updated_at));
}
