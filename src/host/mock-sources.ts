/**
 * `?sources`: a home with GitHub connected as a task source for resonance, as `bin/fm-sources.sh status` reports it
 * and as the fleet snapshot carries it, with the backlog rows its links live in.
 *
 * Every shape here is the engine's own: a link is a `source-link:` line in a row's body, parsed into `source_links`;
 * an item's `filed` copy is taken when a task is linked; writes the fleet made are in `sent`, and owed ones in
 * `outbox`; `offers` lists items that meet the intake filter, and keeps listing them once they are linked, exactly as
 * the engine's snapshot does. `?sources=<variant>` puts the source in one of the states the design draws:
 *   (none)        healthy, read 3 minutes ago, two offers, one linked task in flight, one queued, one landed
 *   `empty`       connected, nothing offered or linked yet
 *   `none`        no source connected
 *   `legacy`      a home whose firstmate predates task sources: the snapshot has no `sources`
 *   `rate-limited` GitHub rate limiting this Mac for 42 minutes, persisted past the threshold
 *   `refused`     the sign-in refused, with the landed task's completion comment waiting
 *   `cancelled`   the in-flight task's issue closed as not planned upstream
 *   `edited`      the queued task's issue edited upstream since it was filed
 *   `unconfirmed` the landed task's completion comment not confirmed after two tries
 *   `unconnected` a queued row linked to a source this home has not connected
 *   `lost`        the as-filed copies lost with the cache, as after `state/` was cleared
 */
import type { BacklogRecord, FleetTask, SourceFiled, SourceItem, SourceLink, SourcesRead, SourceWrite, TaskSource } from "./types";

export const MOCK_SOURCE = "github:caomyer/resonance";
const REPO = "caomyer/resonance";

/** The two issues offered for intake. */
export const OFFER_DRAWER = "I_kwDOmock17";
export const OFFER_BORDER = "I_kwDOmock15";
/** An issue outside the intake filter, found only by pasting its link. */
export const UNLABELLED = "I_kwDOmock21";
/** Linked tasks: one working, one waiting its turn, one landed. */
export const LINKED_WORKING = "res-share-sheet";
export const LINKED_QUEUED = "res-ai-titles";
export const LINKED_LANDED = "res-mini-player";

type Helpers = {
  row: (id: string, title: string, fields: Partial<BacklogRecord>) => BacklogRecord;
  worker: (id: string, kind: string, state: string, startedMinutesAgo: number) => FleetTask;
};

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

function issue(n: number, title: string, body: string, minutesAgo: number, fields: Partial<SourceItem> = {}): SourceItem {
  return {
    id: `I_kwDOmock${n}`, key: `#${n}`, url: `https://github.com/${REPO}/issues/${n}`, title, body, state: "open", state_name: "open",
    assignee: null, updated_at: at(minutesAgo), deleted: false, matches: true, seen_at: at(3), filed: null, ...fields,
  };
}

function filedCopy(item: SourceItem, task: string, minutesAgo: number, fields: Partial<SourceFiled> = {}): SourceFiled {
  return {
    item: item.id, key: item.key, url: item.url, title: item.title, body: item.body, state: item.state, state_name: item.state_name,
    assignee: item.assignee, updated_at: item.updated_at, filed_at: at(minutesAgo), task, ...fields,
  };
}

/** A backlog body carrying links, as `fm-sources.sh file` and `link` write it, and the parser's reading of it. */
export function linkedBody(lines: string[], links: SourceLink[]) {
  return { body_lines: [...lines, ...links.map((link) => `source-link: ${link.source} ${link.item} ${link.role}`)], source_links: links };
}

/** Every item the mock's GitHub knows, offered or not, so a pasted link can resolve one outside the filter. */
export function mockIssues(): SourceItem[] {
  return [
    issue(17, "Remember the drawer width between launches", "The task drawer opens at its default width every launch.\n\nExpected: it opens at the width I left it.", 24 * 60),
    issue(15, "Dark theme: the call card border disappears", "In dark mode the border around a call card is the same colour as the page.", 120),
    issue(21, "Crash when a snip is shorter than a second", "Trimming a snip under 1 s crashes the editor.", 3 * 24 * 60, { matches: false }),
  ];
}

export function mockSources(variant: string | null, helpers: Helpers): { read: SourcesRead | undefined; records: BacklogRecord[]; tasks: FleetTask[] } {
  if (variant === "legacy") return { read: undefined, records: [], tasks: [] };
  if (variant === "none") return { read: { schema: "fm-sources-snapshot.v1", read_at: at(0), first_milestone: "in-review", sources: [] }, records: [], tasks: [] };
  const [drawer, border] = mockIssues();
  const share = issue(2, "Share a snip straight from the share sheet", "Let me share a snip from the system share sheet without opening the app first.", 5 * 60, { matches: false });
  const titles = issue(11, "AI titles for snips", "Suggest a title for each snip from its transcript.", 3 * 24 * 60, { matches: false });
  const mini = issue(9, "A mini player while browsing", "Keep playing when I leave the episode page.", 60, { matches: false, state: "done", state_name: "closed (completed)" });
  if (variant === "cancelled") Object.assign(share, { state: "cancelled", state_name: "closed (not planned)", updated_at: at(12) });
  const shareFiled = filedCopy(share, LINKED_WORKING, 4 * 60, { state: "open", state_name: "open", updated_at: at(5 * 60) });
  const titlesFiled = filedCopy(titles, LINKED_QUEUED, 2 * 24 * 60);
  if (variant === "edited") Object.assign(titles, { body: "Suggest a title and a one-line note for each snip from its transcript, on the device only.", updated_at: at(60) });
  const miniFiled = filedCopy(mini, LINKED_LANDED, 3 * 24 * 60, { state: "open", state_name: "open" });
  const lost = variant === "lost";
  const items: Record<string, SourceItem> = {};
  for (const [item, filed] of [[drawer, null], [border, null], [share, shareFiled], [titles, titlesFiled], [mini, miniFiled]] as const) {
    items[item.id] = { ...item, filed: lost ? null : filed };
  }
  const filed = lost ? {} : Object.fromEntries([shareFiled, titlesFiled, miniFiled].map((copy) => [copy.item, copy]));
  const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;
  const sent: SourceWrite[] = [
    { write_id: "fm-mock-share-review", item: share.id, task: LINKED_WORKING, intent: "in-review", pr: pr(31), at: at(40), advance: null, comment_id: "IC_mock1", deduplicated: false },
  ];
  const outbox: SourceWrite[] = [];
  const delivered: SourceWrite = { write_id: "fm-mock-mini-delivered", item: mini.id, task: LINKED_LANDED, intent: "delivered", pr: pr(7) };
  if (variant === "refused") outbox.push({ ...delivered, created: at(70), attempts: 0, last_error: null, advance: null });
  else if (variant === "unconfirmed") outbox.push({ ...delivered, created: at(70), attempts: 2, last_error: { code: "provider", detail: "unconfirmed", at: at(5) }, advance: null });
  else sent.push({ ...delivered, at: at(70), advance: null, comment_id: "IC_mock2", deduplicated: false });
  const empty = variant === "empty";
  const source: TaskSource = {
    id: MOCK_SOURCE, provider: "github", locator: REPO, project: "resonance", filter: "label:quarterdeck is:open", outbound: "comments",
    review_state: null, added: at(7 * 24 * 60), identity: "caomyer", can: { read: true, comment: true, advance: true }, reach: [REPO],
    last_read: variant === "rate-limited" ? at(42) : variant === "refused" ? at(95) : at(3),
    reading_more: false, stale: variant === "rate-limited" || variant === "refused",
    failure: variant === "rate-limited"
      ? { code: "rate_limited", detail: "GitHub is rate limiting this Mac", first_at: at(40), last_at: at(1), count: 8, retry_at: new Date(Date.now() + 20 * 60_000).toISOString(), woke: true }
      : variant === "refused"
        ? { code: "auth", detail: "GitHub refused the gh sign-in: HTTP 401 Bad credentials", first_at: at(93), last_at: at(1), count: 18, retry_at: null, woke: true }
        : null,
    items: empty ? {} : items, filed: empty ? {} : filed, offers: empty ? [] : [drawer.id, border.id],
    outbox: empty ? [] : outbox, sent: empty ? [] : sent,
    events: variant === "cancelled" ? [{ token: "0123456789abcdef0123", item: share.id, key: "#2", kind: "cancelled", at: at(10), tasks: [{ id: LINKED_WORKING, state: "in_flight", role: "fulfills" }] }] : [],
  };
  const link = (item: string): SourceLink => ({ source: MOCK_SOURCE, item, role: "fulfills" });
  const records = empty ? [] : [
    helpers.row(LINKED_WORKING, "Resonance: share snips from the share sheet", {
      state: "in_flight", current_role: "worker", since: at(4 * 60).slice(0, 10),
      ...linkedBody(["Add a share extension that saves the shared audio as a snip."], [link(share.id)]),
    }),
    helpers.row(LINKED_LANDED, "Resonance: a mini player while browsing", {
      state: "done", current_role: "done", since: at(3 * 24 * 60).slice(0, 10), completion: { verb: "merged", date: at(70).slice(0, 10) }, pr_url: pr(7),
      ...linkedBody([], [link(mini.id)]),
    }),
    ...(variant === "unconnected" ? [helpers.row("res-other-link", "Resonance: match the other app's snip format", {
      state: "queued", current_role: "queued", since: at(24 * 60).slice(0, 10),
      ...linkedBody(["Asked for on the sister project's tracker."], [{ source: "github:caomyer/podcast-kit", item: "I_kwDOother4", role: "contributes" }]),
    })] : []),
  ];
  const worker = helpers.worker(LINKED_WORKING, "ship", "working", 4 * 60);
  worker.pr = { url: pr(31), source: "meta" };
  return { read: { schema: "fm-sources-snapshot.v1", read_at: at(3), first_milestone: "in-review", sources: [source] }, records, tasks: empty ? [] : [worker] };
}

/** The queued fixture row the mock links, as `fm-sources.sh link` would have left it. */
export function linkFixtureRow(record: BacklogRecord, variant: string | null): BacklogRecord {
  if (record.id !== LINKED_QUEUED || variant === "legacy" || variant === "none" || variant === "empty") return record;
  return { ...record, ...linkedBody(record.body_lines ?? [], [{ source: MOCK_SOURCE, item: "I_kwDOmock11", role: "fulfills" }]) };
}

/** What `fm-sources.sh add` refuses, in its words, for the mock's Settings. Null when it would connect. */
export function addRefusal(provider: string, locator: string, filter: string, existing: TaskSource[]) {
  if (provider !== "github") return `there is no adapter for '${provider}'`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(locator)) return `'${locator}' is not a GitHub repository (owner/name)`;
  if (!filter.trim()) return "a source needs an intake filter, so strangers cannot queue work";
  const terms = filter.trim().split(/\s+/);
  const bad = terms.find((term) => !/^label:.+$/.test(term) && term !== "is:open" && term !== "is:closed");
  if (bad) return `the filter term '${bad}' is not one GitHub intake understands (label:<name>, is:open, is:closed)`;
  if (!terms.some((term) => term.startsWith("label:"))) return "the filter needs at least one label:<name>, so strangers cannot queue work";
  if (existing.some((source) => source.id === `${provider}:${locator}`)) return `'${provider}:${locator}' is already connected`;
  return null;
}
