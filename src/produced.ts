/**
 * What a task produced, as every surface reads it: its pages and where each stands, its report, and its PR.
 *
 * A task is a durable record: its row in the backlog and its folder, `data/<id>/`, which holds its brief, the notes
 * and files the captain added, a scout's report, and every page it presented with the captain's review of it. The
 * worktree and the worker are what it borrows while it runs, and nothing here reads them: a queued task has none, and
 * a landed one gave them back. So what a task produced is read only from what outlives the worker: the presented pages
 * (`artifacts[]`), the reviews the app keeps beside them, the calls they argue (`calls[]`), and the report and PR the
 * snapshot names on the task's worker or its row.
 *
 * The task drawer leads with this list, the task list's row chip opens its first item, and the list's To review view
 * is the tasks whose list starts with something that waits on the captain. All three read it here, so no surface keeps
 * a second idea of what a task has for him.
 *
 * Pure functions only: no React, no host.
 */
import type { Artifact, BacklogRecord, Call, FleetTask, ReviewSummary } from "./host/types";
import { awaitsCaptain, callsArguedBy, isOpen, resolveEvidence } from "./calls.ts";

export function artifactKey(artifact: Pick<Artifact, "scope" | "task" | "name">) {
  return artifact.scope === "chat" ? `chat/${artifact.name}` : `task/${artifact.task}/${artifact.name}`;
}

/** What the author says each later revision does about the captain's comments: their claim, by thread. */
export function authorAnswers(artifact: Artifact) {
  const found: Record<string, { rev: number; reply?: string }> = {};
  for (const item of artifact.revisions) {
    for (const id of item.answers?.addressed ?? []) found[id] = { ...found[id], rev: item.rev };
    for (const reply of item.answers?.replies ?? []) found[reply.thread] = { rev: item.rev, reply: reply.body };
  }
  return found;
}

/**
 * The captain's open comments, split by whose move they are: one a later revision changed or replied to
 * is answered and waits on the captain to settle or reply; the rest wait on the author.
 */
export function openComments(artifact: Artifact, review?: ReviewSummary[string]) {
  const answers = authorAnswers(artifact);
  const open = review?.open_threads ?? [];
  const answered = open.filter((thread) => (answers[thread.id]?.rev ?? 0) > thread.rev).map((thread) => thread.id);
  // An older app's summary counts open comments without naming them; those can only be read as waiting.
  const waiting = open.length > 0 || !review ? open.filter((thread) => !answered.includes(thread.id)).map((thread) => thread.id) : Array.from({ length: review.open_count }, (_, index) => `open-${index}`);
  return { waiting, answered };
}

/**
 * What a page's review says about it in one chip: unsent work first, then what
 * is new, then what is waiting. A landed page says none of that, since nothing
 * on it is waiting on anyone any more; your own unsent words still show, because
 * they are yours and would otherwise disappear without being read.
 */
export function reviewChip(review?: ReviewSummary[string], artifact?: Artifact, landed = false) {
  if (!artifact) return null;
  if (review && review.draft_count > 0) return { label: review.draft_count === 1 ? "1 comment not sent" : `${review.draft_count} comments not sent`, tone: "draft" };
  if (landed) return null;
  const seen = review?.seen_rev ?? null;
  if (seen === null) return { label: "Not looked at yet", tone: "new" };
  if (artifact.latest.rev > seen) return { label: `Rev ${artifact.latest.rev} is new`, tone: "new" };
  const { waiting, answered } = openComments(artifact, review);
  if (answered.length > 0) return { label: answered.length === 1 ? "1 comment answered" : `${answered.length} comments answered`, tone: "new" };
  if (waiting.length > 0) return { label: waiting.length === 1 ? "1 comment waiting" : `${waiting.length} comments waiting`, tone: "open" };
  return null;
}

/** Where a page stands: who the next move belongs to. */
export type ArtifactStanding = "needs-you" | "discussion" | "settled";

/**
 * Which of the three the page belongs in.
 *
 * The backlog owns whether a task landed, so a page files itself away when its
 * work is done rather than waiting for anyone to archive it. Everything before
 * that is a question of whose move it is: unread, revised, half-written, or
 * arguing a call still waiting on the captain means the move is yours; anything
 * else that is still going belongs with its author.
 */
export function artifactStanding(artifact: Artifact, artifacts: Artifact[], review: ReviewSummary[string] | undefined, backlog: Map<string, BacklogRecord>, calls: Call[]): ArtifactStanding {
  const task = artifact.scope === "task" ? artifact.task : null;
  if (task && backlog.get(task)?.state === "done") return "settled";
  if (review && review.draft_count > 0) return "needs-you";
  const comments = openComments(artifact, review);
  const argued = callsArguedBy(calls, artifact, artifacts);
  // A call this page argues: yours until you answer or reply to it, then firstmate's until it records or asks again.
  const waiting = argued.filter(isOpen);
  // A chat page that argued calls exists for them, so once every one is closed it has done its work,
  // read or not, unless a comment on it is still going back and forth.
  if (!task && argued.length > 0 && waiting.length === 0 && comments.waiting.length === 0 && comments.answered.length === 0) return "settled";
  const seen = review?.seen_rev ?? null;
  if (seen === null || artifact.latest.rev > seen) return "needs-you";
  const answered = review?.answered ?? [];
  // A call the captain has replied to waits on the first mate, like one his review recorded an answer for.
  if (waiting.some((call) => awaitsCaptain(call) && !answered.includes(call.id))) return "needs-you";
  // The author answered a comment: settling it or replying is the captain's move.
  if (comments.answered.length > 0) return "needs-you";
  if (waiting.length > 0) return "discussion";
  if (comments.waiting.length > 0) return "discussion";
  // A chat page has no work to finish, so once it is read and quiet it is done.
  return task ? "discussion" : "settled";
}

/** A page the task presented: where it stands, the open calls it argues, and what is new on it, in a few words each. */
export type PageOutput = { kind: "page"; artifact: Artifact; standing: ArtifactStanding; needsYou: boolean; calls: Call[]; says: string[] };
/**
 * The report a task wrote without a page, by the path the snapshot names. It waits on the captain while its scout has
 * finished and the backlog has not closed the row, which is when the rest of the app offers it to be read, or while a
 * call it argues waits on his word.
 */
export type ReportOutput = { kind: "report"; path: string; needsYou: boolean; calls: Call[] };
/** The PR the task opened, as its worker or its row names it. A PR waits on no one here: it is something to open. */
export type PrOutput = { kind: "pr"; url: string; number: string | null; merged: boolean };
export type Output = PageOutput | ReportOutput | PrOutput;

export type OutputInput = {
  id: string;
  /** Its backlog row, if the backlog carries one. */
  record?: BacklogRecord;
  /** Its worker, while the snapshot registers one. */
  worker?: FleetTask;
  artifacts: Artifact[];
  reviews: ReviewSummary;
  calls: Call[];
  backlog: Map<string, BacklogRecord>;
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What a page asks of the captain now, in the few words its line in a drawer says, newest news first. */
export function pageSays(artifact: Artifact, review: ReviewSummary[string] | undefined, standing: ArtifactStanding, open: Call[]) {
  const says: string[] = [];
  if (review && review.draft_count > 0) says.push(`${plural(review.draft_count, "comment")} not sent`);
  if (standing === "settled") return says.length ? says : ["Settled"];
  const seen = review?.seen_rev ?? null;
  if (seen === null) says.push("Not looked at yet");
  else if (artifact.latest.rev > seen) says.push("New since you looked");
  const { waiting, answered } = openComments(artifact, review);
  if (answered.length > 0) says.push(`${answered.length} of your comments answered`);
  if (waiting.length > 0) says.push(`${plural(waiting.length, "comment")} with the author`);
  if (open.length > 0) says.push(`argues ${plural(open.length, "call")}`);
  return says.length ? says : ["Seen · nothing new"];
}

/** A PR's number, from its URL, when the URL names one. */
export function prNumber(url: string) {
  return url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1] ?? null;
}

/**
 * Everything a task produced, what waits on the captain first: its pages, newest presented first, then its report
 * when it wrote one without a page (a page is how a report is presented, so one with a page is read there), then its
 * PR. The order within each part is kept, so the one that needs him is first and the rest read as they were made.
 */
export function taskOutput(input: OutputInput): Output[] {
  const { id, record, worker, artifacts, reviews, calls, backlog } = input;
  const pages = artifacts
    .filter((artifact) => artifact.scope === "task" && artifact.task === id)
    .sort((a, b) => b.latest.presented_at.localeCompare(a.latest.presented_at))
    .map((artifact): PageOutput => {
      const review = reviews[artifactKey(artifact)];
      const standing = artifactStanding(artifact, artifacts, review, backlog, calls);
      const open = callsArguedBy(calls, artifact, artifacts).filter(isOpen);
      return { kind: "page", artifact, standing, needsYou: standing === "needs-you", calls: open, says: pageSays(artifact, review, standing, open) };
    });
  const out: Output[] = [...pages];
  const reportPath = worker?.paths.report.present ? worker.paths.report.path : record?.report_path ?? null;
  if (reportPath && pages.length === 0) {
    // Calls argued by this report as a report: a report with a page is argued through the page, above.
    const argued = calls.filter((call) => isOpen(call) && resolveEvidence(call, artifacts, (task) => task).some((item) => item.kind === "report" && item.task === id && !item.page));
    const finished = worker?.kind === "scout" && worker.current_state.state === "done" && record?.state !== "done";
    out.push({ kind: "report", path: reportPath, needsYou: finished || argued.some(awaitsCaptain), calls: argued });
  }
  const url = worker?.pr.url ?? record?.pr_url ?? null;
  if (url) out.push({ kind: "pr", url, number: prNumber(url), merged: record?.completion?.verb === "merged" });
  const needsYou = (item: Output) => item.kind !== "pr" && item.needsYou;
  return [...out.filter(needsYou), ...out.filter((item) => !needsYou(item))];
}

/** Whether anything a task produced waits on the captain now. */
export function waitsOnCaptain(output: Output[]) {
  return output.some((item) => item.kind !== "pr" && item.needsYou);
}

/**
 * The one chip a task's row carries: the first thing the task produced, strong when it waits on the captain and quiet
 * when it is only there to open. A task that produced nothing carries none.
 */
export type OutputChip = { strong: boolean; label: string; title: string; opens: Output };

export function outputChip(output: Output[]): OutputChip | null {
  const first = output[0];
  if (!first) return null;
  if (first.kind === "page") {
    const rev = first.artifact.latest.rev;
    const pages = output.filter((item) => item.kind === "page").length;
    const title = `${first.artifact.title} · ${first.says.join(" · ")}`;
    if (first.needsYou) return { strong: true, label: `Page to review${rev > 1 ? ` · rev ${rev}` : ""}`, title, opens: first };
    // A page that asks nothing gives way to the PR, which is what shipped work is opened for.
    const pr = output.find((item): item is PrOutput => item.kind === "pr");
    if (pr) return prChip(pr);
    return { strong: false, label: pages > 1 ? `${pages} pages` : rev > 1 ? `Page · rev ${rev}` : "Page", title, opens: first };
  }
  if (first.kind === "report") return first.needsYou
    ? { strong: true, label: "Report to read", title: first.calls.length ? `Its report argues ${plural(first.calls.length, "call")} waiting on you` : "Its report is written", opens: first }
    : { strong: false, label: "Report", title: "Its report is written", opens: first };
  return prChip(first);
}

function prChip(pr: PrOutput): OutputChip {
  return { strong: false, label: pr.number ? `PR #${pr.number}` : "PR", title: `${pr.merged ? "Merged: " : ""}${pr.url}`, opens: pr };
}
