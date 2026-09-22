/**
 * A project's logbook: every task it closed, newest first, as the captain reads it.
 *
 * firstmate owns what closed and how (`bin/fm-history.sh`); the snapshot's backlog carries only the most recent
 * rows. This module joins the two, says what each row delivered, and files the rows by period. It never decides
 * whether a call was answered: that is read from the call itself, as everywhere else.
 */
import type { BacklogRecord, Call } from "./host/types";

/** What a closed task left behind. `closed` is a row that delivered nothing: dropped, superseded, merged away. */
export type LogKind = "shipped" | "report" | "decision" | "closed";

export type LogEntry = {
  id: string;
  title: string;
  kind: LogKind;
  /** The day it closed, `yyyy-mm-dd`, or null for a row closed before firstmate recorded dates. */
  date: string | null;
  pr: string | null;
  report: string | null;
  call: Call | null;
  record: BacklogRecord;
};

/** The filters the captain can pick; `closed` rows show only when asked for. */
export type LogFilter = "all" | "shipped" | "report" | "decision";

/** Completion verbs that mean the work reached the project: firstmate's own delivery rule (`bin/fm-landed-lib.sh`). */
const DELIVERED = new Set(["merged", "landed"]);

/**
 * What a closed row delivered. Work that reached the project is shipped even when a call released it, and keeps
 * the call beside it; a row that is only a question is a decision.
 */
export function logKind(record: BacklogRecord, call: Call | null): LogKind {
  const verb = record.completion?.verb ?? null;
  if (record.kind === "scout" && (record.report_path || verb === "reported")) return "report";
  if (record.kind !== "captain" && verb && DELIVERED.has(verb)) return "shipped";
  if (call || record.hold_kind === "captain" || record.kind === "captain") return "decision";
  return "closed";
}

/**
 * The closed rows of one project, newest first, each once. `history` is firstmate's history in its own order;
 * `recent` is the snapshot's backlog, which can hold a row closed after the history was read.
 */
export function logEntries(history: BacklogRecord[], recent: BacklogRecord[], calls: Call[], project: string): LogEntry[] {
  const byCall = new Map(calls.map((call) => [call.id, call]));
  const seen = new Set<string>();
  const rows: BacklogRecord[] = [];
  for (const record of [...recent, ...history]) {
    if (record.state !== "done" || record.repo !== project || seen.has(record.id)) continue;
    seen.add(record.id);
    rows.push(record);
  }
  const entries = rows.map((record, index) => {
    const call = byCall.get(record.id) ?? null;
    return {
      entry: {
        id: record.id,
        title: record.title,
        kind: logKind(record, call),
        date: validDay(record.completion?.date ?? null),
        pr: record.pr_url ?? null,
        report: record.report_path ?? null,
        call,
        record,
      },
      index,
    };
  });
  // Newest day first. Within a day, recent rows lead, then firstmate's order, which is its own newest first.
  entries.sort((a, b) => (b.entry.date ?? "").localeCompare(a.entry.date ?? "") || a.index - b.index);
  return entries.map(({ entry }) => entry);
}

function validDay(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** The rows a filter and a search keep. The search reads the title, the answer, and the id. */
export function filterLog(entries: LogEntry[], filter: LogFilter, query: string, includeClosed: boolean) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (entry.kind === "closed" && !includeClosed) return false;
    if (filter !== "all" && entry.kind !== filter) return false;
    if (words.length === 0) return true;
    const text = [entry.title, entry.id, entry.call?.answer?.label ?? "", entry.call?.decided?.what ?? ""].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** How many rows each filter would show, with closed rows counted only when they are shown. */
export function logCounts(entries: LogEntry[], includeClosed: boolean): Record<LogFilter, number> & { closed: number } {
  const counts = { all: 0, shipped: 0, report: 0, decision: 0, closed: 0 };
  for (const entry of entries) {
    counts[entry.kind] += 1;
    if (entry.kind !== "closed" || includeClosed) counts.all += 1;
  }
  return counts;
}

/** A bare day read as that day where the captain is, never the evening before. */
function localDate(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/**
 * The rows filed by when they closed: "This week" for the last seven days, then one group per month, then the
 * rows with no date. Groups keep the rows' order.
 */
export function logPeriods(entries: LogEntry[], now: number): { id: string; title: string; entries: LogEntry[] }[] {
  const today = new Date(now);
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6).getTime();
  const groups: { id: string; title: string; entries: LogEntry[] }[] = [];
  const add = (id: string, title: string, entry: LogEntry) => {
    const last = groups.find((group) => group.id === id);
    if (last) last.entries.push(entry);
    else groups.push({ id, title, entries: [entry] });
  };
  for (const entry of entries) {
    if (!entry.date) { add("undated", "Undated", entry); continue; }
    const day = localDate(entry.date);
    if (day.getTime() >= weekStart) { add("week", "This week", entry); continue; }
    const sameYear = day.getFullYear() === today.getFullYear();
    const title = day.toLocaleDateString(undefined, sameYear ? { month: "long" } : { month: "long", year: "numeric" });
    add(`${day.getFullYear()}-${day.getMonth() + 1}`, title, entry);
  }
  // Undated rows go last, wherever they came in.
  return [...groups.filter((group) => group.id !== "undated"), ...groups.filter((group) => group.id === "undated")];
}

/** "Sep 18", or "Sep 18, 2025" from another year. */
export function shortDay(day: string, now: number) {
  const date = localDate(day);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** What the row says it did, in the captain's words. */
export function outcomeLine(entry: LogEntry, now: number) {
  const on = entry.date ? ` ${shortDay(entry.date, now)}` : "";
  // A verb reads straight into its date; anything longer, an answer in the captain's words, is set off from it.
  const apart = entry.date ? ` · ${shortDay(entry.date, now)}` : "";
  if (entry.kind === "decision") {
    const answer = entry.call?.answer;
    if (entry.call?.decided) return `Decided for you${apart}`;
    if (answer?.by === "firstmate") return `The first mate chose ${answer.label}${apart}`;
    if (answer) return `You chose ${answer.label}${apart}`;
    return `Answered${on}`;
  }
  if (entry.kind === "shipped") return entry.record.completion?.verb === "landed" ? `Landed${on}` : `Merged${on}`;
  if (entry.kind === "report") return `Reported${on}`;
  return `Closed${on}`;
}

/** The project's queued rows, in backlog order, without the calls waiting on the captain now (those are "Needs you"). */
export function upNext(records: BacklogRecord[], project: string) {
  return records.filter((record) => record.state === "queued" && record.repo === project && !record.captain_actionable);
}

/** The project a call belongs to: its own row's, else the task it is about, else the task that raised it. */
export function callProject(call: Call, records: Map<string, BacklogRecord>) {
  for (const id of [call.id, call.about, call.origin]) {
    const repo = id ? records.get(id)?.repo : null;
    if (repo) return repo;
  }
  return null;
}

/**
 * How much work the project delivered in the last `days` days: shipped work and reports, not calls or rows that
 * closed without a delivery. `more` says older rows are still unread; while the oldest row read so far is inside the
 * window, the count is a floor and `floor` says so.
 */
export function landedWithin(entries: LogEntry[], days: number, now: number, more: boolean) {
  const today = new Date(now);
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime();
  const inside = (entry: LogEntry) => entry.date !== null && localDate(entry.date).getTime() >= from;
  const count = entries.filter((entry) => (entry.kind === "shipped" || entry.kind === "report") && inside(entry)).length;
  const oldest = entries.at(-1);
  return { count, floor: more && (!oldest || oldest.date === null || inside(oldest)) };
}
