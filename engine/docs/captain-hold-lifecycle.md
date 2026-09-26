# Captain-hold lifecycle mechanism

The normative policy is owned by `.agents/skills/captain-hold-lifecycle/SKILL.md` and is not restated here.
This document records the deterministic mechanism, structured surfaces, compatibility contract, and privacy-safe regression evidence.

## Mechanism

A decision is not a separate thing in this system: it is an ordinary backlog task held for the captain, and the task id is the identity every surface and channel uses.
`bin/fm-captain-hold.sh` is the only lifecycle command layered on that primitive.
The command addresses the active home's configured data directory, so the existing backlog remains the only durable work database and a secondmate-owned captain call stays in the secondmate home.
It never reads report bodies, review artifacts, terminal output, or chat.

The `hold` subcommand is the mandatory captain-hold creation path: it uses an existing task or creates one when nothing exists to hold, records its UTC hold-set timestamp as the leading line of the task body, then invokes the underlying tasks-axi hold operation and verifies both records.
Publishing the stamp first ensures a snapshot cannot observe a newly captain-held task without the timestamp that defines its age.
Retries of an active hold preserve its hold-set timestamp, while re-holding released work starts a new timestamped lifecycle; a closed task is refused rather than reopened, and `--until` stores the captain's own deferral date through tasks-axi's date gate, refusing a date that is not after the captain's day because it would be live at once.

The `answer` subcommand records the captain's exact words and resolves the call in the same act: it closes a question-shaped call, while `answer --release` frees a captain-gated work item to proceed without completing it.
It requires a non-empty captain decision file of at most 8192 bytes, durably writes a resolution block carrying the decision digest and a `Resolution mode:` while retaining the leading hold-set stamp until the selected `tasks-axi done` or `tasks-axi unhold` transition succeeds, then restores the successful record's resolution-first body ordering (the previous body remains preserved below the block and archived through tasks-axi `--archive-body`).
If the close is interrupted, the still-held task therefore keeps its original age basis.
Every answer's block also carries machine lines directly under `Resolution mode:` - `Answer key:` when the answer named one of the call's options, `Answer label:`, `Answered by:` (`captain` or `firstmate`), `Answered via:` (the channel), and `Answered at:` - which readers take the way they take the hold-set stamp, stopping at the first line that is not one, so the captain's words below are never parsed.
They sit outside the decision digest, which stays the captain's words alone: a record written before the lines existed and a retry arriving later or through another command both still match, and a retry never rewrites the block.
`Answered via:` is always a token of the closed channel vocabulary described under answer-time resolution, and a plain `answer` records `chat` unless told otherwise, with an `Answer key:` only when `--key` names one of the call's options.
A matching retry also completes any resolution-first normalization left unfinished after the close itself succeeded.
An exact retry is idempotent only when the requested close mode matches the newest record; a drifted answer or mode mismatch is rejected, while a re-held task accepts a new answer as a new record on top.
On a task closed outside the script, `answer` records the missing block only when the captain-hold annotations tasks-axi preserves through a close prove the captain owned it, and it verifies the task stays closed.
A hold whose `--until` date has passed keeps those annotations while tasks-axi reports it no longer held, so an expired deferral remains answerable.

The `complete` subcommand unions the reviewed captain-held task ids into `decision_keys=` and appends `decisions_reviewed=1` while originating task metadata is live.
A post-teardown visual review can complete against the surviving report and durable tasks without recreating volatile task metadata.
It accepts `--none` as an explicit semantic inventory result, refused while the origin still has a lifecycle-open keyed status decision, and verifies every listed task against tasks-axi before recording completion.
With a non-empty inventory it appends a `captain-held [key=<key>]: tracked by <inventory>` transfer event for every still-open keyed status decision, which `bin/fm-classify-lib.sh` recognizes as closing the live status copy without claiming that the captain has answered it.

Scout teardown calls the read-only `verify` subcommand after checking for the report and before removing any source state.
`verify` requires the recorded attestation, requires every recorded inventory entry to still be durable (actively captain-held, or carrying a recorded answer), and fails on any keyed status decision that opened after the last `complete`, which makes re-running `complete` the repair.
The `--force` path remains the explicit captain-approved discard escape hatch.

### One source of truth for a call

The backlog row stays the spine: whether a call exists and whether it is held, bucketed, answered, or closed is read from the row and nowhere else.
What the call asks - its question, 2 to 8 keyed options, the recommendation, the declared close (`on_answer`), the task whose work raised it (`origin`), the task it concerns (`about`), explicit evidence, and provenance - lives beside the row in one sidecar record per call, `state/calls/<task-id>.json` (schema `fm-call.v1`).
`bin/fm-captain-hold.sh` is that record's only writer, under the same per-task control lock it already takes, through a temporary file of its own and a rename.
`hold` writes it when given any content flag or `--origin`, before the hold is applied, for the same reason the hold-set stamp precedes the hold: a newly held call is never visible without its content.
A hold given none of them behaves exactly as it always did, and such a row is still a call, listed with its hold reason as the question and empty options and evidence.
`offer` replaces an open call's content and records `updated_at`, which moves only when the offered content - question, options, recommendation, or `on_answer` - is written by `hold` or `offer`, so a surface can tell that a page revision predates the choice it argues; attaching or detaching evidence never moves it, and `evidence` attaches or detaches one ref (`page:task/<id>/<name>`, `page:chat/<name>`, `report:<id>`, or `url:<http(s) url>`) on any call, open or closed.
A call raised from a task's work with `--origin` is argued by everything that task produced - its report and every page it presented - derived when the call is read rather than written, so a page presented before the call exists argues it exactly like one presented after.
Holding an existing task that has already written its report or presented a page makes that task its own origin when neither `--origin` nor the call's record names one, so a call raised on the work that produced its evidence is linked without a flag; a task the hold creates, work that has produced nothing yet, and a record that already names an origin are left as they are.
A defaulted origin only links: it declares no `on_answer`, on the first hold or any later re-hold, so an answer closes the call exactly as it would have without it.
`on_answer` defaults to `done` for a question the hold created and to `release` for held work that should resume, and channels never choose it: `answers` takes the declaration for an empty mode column and skips a mode that disagrees with it.

`decide` is the same call for a decision the first mate made on the captain's behalf: it raises a new row whose id is the digest of every argument, records the content with `decided` carrying what and why, and answers it through the same `answer` path with `Answered by: firstmate`, so an exact retry names the same row and changes nothing.
`bin/fm-decision-options.sh set` is a one-release shim over `offer`, and `bin/fm-artifact.sh present --covers` is one over `evidence add`; revisions no longer record `covers`.
The one-time `migrate` imports `state/decision-options/` records into calls that have no options yet and turns every revision's `covers` into evidence, leaving the old files in place and read by nothing, and a second run changes nothing.
It also gives every call answered before the machine lines existed the lines a current answer carries, so a surface that reads only machine lines keeps the answers already on record.
Under the task lock it inserts them into the newest resolution block beneath `Resolution mode:`, leaving the decision text and digest untouched, so an exact retry still matches: `Answered by: captain`, `Answered via: other`, `Answer label:` (the recovered option's own label, or without a key the recorded decision's first non-empty line, trimmed and capped at 200 characters, or for a block the keyed intake wrote the label the captain was shown), and `Answered at:` from the row's close date, the only resolution time an older block has.
`Answer key:` is added only when exactly one recorded option is named unambiguously: the line starts with the key followed by `:`, ` =`, `=`, or whitespace and a dash, or equals the option's label, or, for a keyed-intake block, its recorded answer is the key or its shown label is the option's label.
That one-time conversion is the only place `bin/fm-captain-hold.sh` ever reads recorded prose; a reconciliation block gets no lines.
A block an earlier `migrate` backfilled with that first line as its label although it recovered a key - recognized by `Answered via: other` and a label equal to the line - has its label corrected to the option's own, once.

## Cleanup never closes a captain call

The policy prefers holding the very work item a question gates, so the backlog row a finished task's cleanup is about to close is routinely the captain's own call.
`bin/fm-teardown.sh` therefore asks the read-only `open` subcommand before its automatic close: exit 0 means the row is still an open captain call (not Done, `hold_kind: captain`), 1 means it is not, and 2 means the answer could not be established, which teardown treats as a refusal before any destructive step rather than as permission to close.
On 0 only the close changes: after cleanup and still under the task's own lock, teardown records one `Deliverable of the finished work: ...` line at the end of the task body, copies a supported pull request or canonical `data/<id>/report.md` into the row's structured artifact fields, and runs `tasks-axi reopen`, so the row returns to Queued with its hold intact and remains on the appropriate Captain's Call or Charted Next decision surface instead of reading as work still under way.
The pending-close record teardown already stages before destructive cleanup carries that intent as a `mode=retain` line, so an interrupted cleanup replays the retention at the next session start through the same record, validator, and lock as an ordinary close and never closes the row; if the captain answers before replay, `answer` validates that record and copies any supported retained pull request or report into the row before closing it, after which replay retires the record.
Two retained-delivery gaps remain bounded by tasks-axi 0.2.5 and are recorded for separate upstream work rather than representing defects introduced by this branch.
A retained local-only delivery cannot reach the row because `--note` exists on `tasks-axi done` but not on `tasks-axi update`, while the durable pending-close record carrying that note is retired when retention completes.
A relocated retained report cannot reach the row because tasks-axi accepts only `data/<id>/report.md`: `done` reports `Task report link must be a data/<id>/report.md path`, and `update` reports `--report must be a data/<id>/report.md path`.
When an interrupted retention leaves such a relocated report in the validated pending-close record, `answer` skips only that known-unsupported row artifact and closes normally, so the delivery remains absent from Recently Landed instead of wedging the captain's answer.
A pending-close record that fails validation outright is a different case and still refuses the answer, but the refusal names the record and the validation reason so the captain can repair it rather than facing a bare failure.
`--force` does not lift the deferral, because it authorizes discarding unlanded work, never the captain's question; only `answer` with the captain's words or evidence-backed `reconcile close` resolves the call, by either closing the question or releasing the gated work.
`bin/fm-backlog-transition-lib.sh` owns the transition and its record, and `bin/fm-captain-hold.sh --help` owns the predicate's contract.

## Answer-time resolution

"A keyed answer resolves its matching captain-held task" is one capability with one owner.
`answers` is its channel-agnostic entry point: it reads `<task-id>\t<answer>\t<label>[\t<mode>]` lines and resolves each named task through the same `answer` path, so every guard applies identically no matter which channel the answer arrived on.
The optional mode column carries a card-declared close: `done` (default) completes the task and `release` lifts the hold so held work resumes; any other value is skipped.
A key that names no task, names a task that is not captain-held, or names a task already closed is reported as `skipped:` and feeds nothing; a replay whose answer and requested close mode match the newest record is an idempotent `closed:`, while a mode mismatch is skipped; and the command exits nonzero when any key was skipped.
`--source` is provenance text recorded in the durable decision, never a behavior switch, and the command carries no per-channel branch.
`Answered via:` is a token from a closed channel vocabulary rather than that prose, so a surface can say where the captain answered: `quarterdeck` (the app), `chat` (the captain's words relayed by the first mate), `lavish` (a Lavish board result), `captured` (any other captured process-event result), `decide` (a call decided on the captain's behalf), and `other`.
`answer` and `answers` take it as `--via <token>` and refuse any other value; without it `answer` records `chat`, `answers` records `quarterdeck` when `--source` is exactly `quarterdeck` (what the app sends) and `other` otherwise, and `decide` records `decide`.
The chat channel passes `--via chat`, and the process-event runner passes `lavish` for the Lavish adapter and `captured` for every other source.
An answer that names one of the call's recorded options is recorded with its `Answer key:`, and a freeform answer is recorded with none.
The Quarterdeck app calls this intake directly and reads its `closed:` and `skipped:` lines per call; the app never closes anything itself, and the first mate is told afterwards to do the follow-up work.

`bind`, `unbind`, and `binding` record that a captured-answer source feeds this intake, as a private record under `state/decision-bindings/`; an unbound source feeds nothing, so the path is opt-in per source, and `bind` deliberately does not require the source to exist yet.

Two channels feed that one intake today, and both are ordinary callers rather than special cases.
`bin/fm-send.sh --resolve-key` is the chat channel: its status-log close for a key the status log still owns is owned by that script's header, and a key the status log no longer owns is resolved to a still-open captain-held task - the key as a task id, then the legacy derived identity - and fed as one keyed line.
`bin/fm-procevent.sh` is the captured-result channel: after capture, a bound built-in source has its result passed to `bin/fm-procevent-<adapter>.sh answers <result-file>` and whatever that prints is piped into the intake, so any built-in adapter with an `answers` command works and the runner parses no result and carries no decision rule; its only mapping is the channel token it passes as `--via`.
Trusted external process-event adapters intentionally expose no answer operation and cannot feed this authority-bearing intake; [`extension-bindings.md`](extension-bindings.md#trust-boundary) owns that boundary.
`bin/fm-procevent-lavish.sh answers` is one such adapter command; it reads only rows tagged `choice`, relays a card's declared close mode, and can never let freeform captain prose forge a task id or a mode.

## Reconcile: re-check reality, never a blind close

A captain call can stop being a question without the captain ever answering it because the subject lands, the premise turns out to be false, or the choice becomes a matter of fact rather than the captain's to make.
`reconcile` is the standing third option for that case, and its whole point is that it is NOT an answer.
It means "go verify the latest state", and it resolves in exactly one of two ways once that verification has actually been done: close the call with the evidence that made it moot, or leave it open with a note recording that it is genuinely still active.

The value remains reserved at the shared keyed-answer intake, which visibly refuses it from every channel and never passes it to `answer`.
A reconcile value delivered through chat or any ordinary keyed-answer caller therefore cannot complete a task, lift a hold, write a resolution record, or create a reconcile request.

Board request creation uses a separate captured-source seam.
The board emits `fm-bearings-answer.v1` context with the slug-shaped selected option and freeform note in separate fields, so annotating Reconcile cannot turn it into an ordinary answer value.
`bin/fm-procevent-lavish.sh answers` emits an exact non-reconcile selection, or a bare note when no option was selected, while `reconciles` emits only task ids whose structured selection is Reconcile and carries their notes as request provenance.
Current rows require the versioned shape and the `choice` tag; a time-limited rollout branch accepts ordinary answers from the old question/answer shape but refuses its bare and separator-annotated reconcile values from both intakes because those rows do not separate the selected option from its note.
Every other structurally uncertain capture feeds neither intake, remains announced, and cannot forge a task id from freeform prose.
The adapter-agnostic runner pipes reconcile rows into `reconcile-requests` only for a bound source, and that intake verifies the named binding again before it creates anything.
Failures remain best-effort and never acknowledge or suppress the captured result.
What this captured-source intake records is a durable reconcile request under `state/reconcile-requests/`, one private record per task, carrying the requesting provenance and a UTC timestamp.
The record exists so the obligation to re-check cannot be lost between the wake that carried the answer and the turn that acts on it.
It is idempotent per task: repeating a reconcile keeps one request and its original timestamp.
The supported creator is the runner carrying the captain's board selection; the binding-checked `reconcile-requests` command is that internal intake rather than an operator reconciliation outcome.

Verification retires a request through one of two outcomes, and each one requires both the pending board-created request and the operator input that supports its claim:

- `reconcile close <task-id> --evidence-file <path>` is the moot outcome.
  It writes a resolution record whose mode is `reconciled` and whose body is the supplied EVIDENCE under a `Reconciliation evidence:` label, then closes the task.
  The distinct mode and label are what keep the record honest: it says the call dissolved against verified evidence, and it never claims the captain answered.
- `reconcile note <task-id> --note-file <path>` is the still-active outcome.
  It appends one dated `Captain hold reconciled:` note to the task body, leaves the hold in place, and retires the request.
  The call stays the captain's, now carrying what the re-check found; a marker bound to the request timestamp, provenance, and note digest lets a matching retry finish retirement without appending again while a later request with the same finding still receives its own dated note.

`reconcile list` is the read-only enumeration of pending requests filed by board answers.
A successful normal answer also retires any pending request, because an answered call has no remaining re-check obligation.
Every retirement is checked: if request removal fails after an answer, close, or note is already durable, the durable outcome stands but the command fails and leaves the pending request visible for retry.
No path here closes a captain call without either the captain's words through `answer` or the evidence through `reconcile close`.

## Card hygiene: a landed subject is not a live call

`bin/fm-bearings-board.sh build` cross-checks every `decision` card before it publishes and drops stale subjects rather than trusting the composed inventory alone.

Three checks run, all on exact identity and none on prose:

- The card's key is the captain-held task id, so `bin/fm-captain-hold.sh open --distinguish-absent` is asked whether that task is still an open captain call.
  Exit 1 - present but closed, or no longer held for the captain - drops the card.
  Exit 2 means the answer could not be established and exit 3 means the task is absent from the main backlog, which includes a home carrying no backlog file at all; both keep the card, because a card wrongly shown is recoverable and a call wrongly hidden is not.
- The payload's own `landed` rows are the recently-landed artifacts.
  A decision card whose task id or `pr_url` appears among them has already shipped its subject, so it drops.
- A version decision can carry a structured `subject` with an artifact and numeric three-part version.
  A landed row carrying the same artifact at that version or a newer one supersedes the card without parsing prose.

Dropped cards are named on stderr as `dropped-landed-card:` lines so a rebuild states what it removed rather than quietly shrinking Captain's Call.
The landing procedure requires one immediate board rebuild to remove already-stale merged-PR and superseded-version cards without a committed migration or change-worktree state mutation.
A subject whose state cannot be established is kept, because a wrongly shown card is safer than a wrongly hidden call.
The validator's reservation scope must equal the adapter's reconcile-classification scope, which is all card types because the captured payload carries no card type.
Owner-aware routing for remote-secondmate decision cards is tracked separately: that follow-up must query landedness and route reconciliation in the authoritative secondmate home while honoring the remote and local consistency principle.
Until then, an absent main-home task passes through this hygiene check unchanged, and its Reconcile selection remains announced but cannot create a main-home request because the main intake refuses an absent task.
For a main-home call, the reconcile option is the recovery path for whatever still slips through.

## Structured read surfaces

`bin/fm-fleet-snapshot.sh` parses canonical tasks-axi `(hold: ...)`, `(hold-kind: ...)`, and `(hold-until: ...)` metadata alongside existing backlog fields.
It resolves every repeated `blocked-by:` edge against structured Done records and keeps missing blockers unresolved.
It then assigns every captain hold exactly one `hold_bucket`, decided only from structured fields - `hold_kind`, `state`, `hold_until`, `unresolved_blocker_ids`, and the machine-written hold-set timestamp.
Hold reason and body prose are never matched, so no wording can hide, reveal, or reclassify a decision.
The buckets are total and mutually exclusive: `blocked` when any blocker is unresolved, else `dated` while `hold_until` is after the captain's day, else `aged` when an undated hold's hold-set timestamp is at least `FM_SNAPSHOT_UNDATED_HOLD_AGE_DAYS` old (default 14, floored elapsed days), else `live`.
The captain's day is the host's local date, never the UTC one, so a call deferred to a day is back from the first moment of that day where the captain is; `bin/fm-backlog-parse-lib.sh` owns it and says why.
No captain hold can fall through them and none can match two, which is what keeps a hold from vanishing from every view.
`captain_actionable` - waiting on the captain now - is exactly `hold_bucket == "live"`.
Existing undated holds without a hold-set stamp fall back to the task's `since` date and age in whole captain's days from it.
That aging is a projection safety net only.
The durable deferral remains re-holding with `--until`.
Its secondmate-home summary classifies an actionable captain hold as `captain_decision` and preserves every captain hold in the bounded queued inventory of the owning home.

The snapshot's `calls[]` is exactly `bin/fm-captain-hold.sh list --json`'s array, and it replaced the `decision_options[]` and `decided[]` lists.
The snapshot hands the listing its own parsed backlog, so every call's `bucket` and `captain_actionable` are the classification above, unchanged, and the listing costs one process however many calls there are; run standalone, `list` asks the snapshot's parser for the backlog instead.
Each call joins its row with its record: `state` is `open`, `answered` (the newest resolution block belongs to the current hold lifecycle, so its close was interrupted), or `closed`; `evidence` is the explicit refs followed by what the origin produced, de-duplicated; and `answer` is null or `{key, label, by, via, at}` read from the machine lines.
It lists every open or answered call plus those closed within 7 days; a damaged record is reported under `damaged[]` and skipped, never fatal, and a record whose row is not a call is ignored.

`bin/fm-bearings-snapshot.sh` places each captain hold by its `hold_bucket` and inspects no prose of its own.
A `live` hold is a default Captain's Call entry.
A `blocked`, `dated`, or `aged` hold leaves the default Captain's Call, renders as a Charted Next gate stating why - the blocking work, the `until <date>`, or the floored age - and contributes to the concrete `omitted[]` disclosure.
`--all-decisions` reveals every captain hold available within the remote-summary bound and drops its gate, so an available hold is never in both Captain's Call and Charted Next.
An actively worked held task may also appear in Underway, which reports running work independently of those decision buckets.

Three accepted limits remain deliberate:

- A remote or secondmate hold retains the producer home's age and aging decision from the summary's capture time and threshold rather than being recomputed by the parent.
- A rare concurrent answer-close and re-hold race can leave the newly re-held task without its age basis.
- Cross-home summaries remain bounded by `FM_SNAPSHOT_SECONDMATE_DECISIONS` and `FM_SNAPSHOT_SECONDMATE_QUEUED`; a remote deferred hold beyond those bounds is not exported, so it can be neither gated nor revealed.

Re-holding through the wrapper with `--until` remains the durable fix rather than relying on the projection safety net.
[`bin/fm-landed-lib.sh`](../bin/fm-landed-lib.sh) owns Recently Landed's shared selection and artifact-display compatibility rules.
A local-only landing's note is written by `tasks-axi done --note` as the last of the row's indented body lines rather than into the row title, so the snapshot reads that final line as the note as well as parsing the title, and the landing is published carrying its recorded note.
A body that carries a captain resolution record is the captain's own prose and is never mined for that note, so a decision worded `local main` does not become a delivery artifact.
The projection remains read-only and uses the canonical snapshot's structured fields, including the machine-written hold-set timestamp.

The window between a merge landing and cleanup is an accepted structural residual rather than an oversight.
That local window is normally only seconds wide and requires re-holding a task whose merge has just landed.
A re-hold inside the window makes cleanup retain the row rather than publish it, so the delivery is omitted until the stale hold is cleared from that row.
Queued forge merges cannot be covered locally because the forge performs the merge asynchronously after the local command has returned, when no lock this code could hold would still be held.
The away-posture restriction on queued merges and its residual limits are owned by [architecture.md](architecture.md#delivery-modes-are-explicit-per-task).

## Record divergence

A captain call can have two records, and closing one does not close the other.
A `resolved [key=...]` line closes the status-log fold; the structured captain-held task closes only through `answer`.
Until this guard existed, closing on the status side alone left no trace of the disagreement: the fold went quiet, the durable record kept saying the captain owed an answer, and nothing warned.

`bin/fm-captain-hold.sh diverged` is the read-only report of that state, and `bin/fm-wake-drain.sh` prints it as a bounded `RECORD DIVERGENCE` section beside OPEN DECISIONS on every drain.
It flags exactly one condition: a task still open and still carrying the captain-hold annotations, whose key was closed on the status side by the resolve verb, resolved through the collapsed identity (the key is the task id) or the legacy derived one.
It closes nothing, ever - a captain call closed wrongly leaves review entirely, so both reconciliation directions stay human-owned and the printed hint names both.

Three states are deliberately not divergence.
A `captain-held [key=...]` close is the verified transfer `complete` writes, so the structured row staying open behind it is correct; `bin/fm-classify-lib.sh`'s `status_key_closing_verb` is what keeps the two closing verbs distinguishable.
A still-open keyed status decision belongs to the OPEN DECISIONS fold.
And the absence of a routed work item is legitimate rather than incomplete - when the decision is the deliverable there is nothing to route - so routed work is no part of the test.

Cost stays flat: one `tasks-axi list`, one key scan per status log, and the precise per-key fold only for a key that already names a still-open task.
The comparison is refused unless the status directory is the active home's own, since tasks-axi reads that home's backlog and a mismatch would report one home's logs against another's tasks.
If tasks-axi is unavailable or its listing cannot be parsed, the guard cannot read the structured record and prints nothing.

## Replies waiting on the first mate

The captain can speak on a call without deciding it: words that dispute its premise, a dated "not now", or an option on a call that cannot record it by key.
`bin/fm-captain-hold.sh reply` keeps those words beside the open call as its record's `reply`, under the call's control lock, and records nothing about what they mean.
A surface that carries the captain's words to a call writes them there first, so Bearings, a page's review rail, and the first mate all read one state from `calls[]`: not answered (`reply` and `answer` null), replied and not yet recorded (`reply` set), and answered (`answer` set).
It never moves `updated_at`, so a page revision's standing against the choice it argues is unchanged, and it leaves the hold projection (`bucket`, `captain_actionable`) as it was, so a replied call stays answerable on every surface.
Only the first mate acting clears it: `answer` once the answer is recorded, `offer`, and every `hold`, each of which records, re-asks, or defers the call.

`bin/fm-captain-hold.sh replies --older-than <minutes>` is the read-only report of replies still set on open calls, and `bin/fm-wake-drain.sh` prints it as a bounded `UNHANDLED REPLIES` section on every drain once a reply is `FM_REPLY_OVERDUE_MINUTES` old (default 5).
It needs no status log, so it prints on a home with no live work too, and it stops only when the first mate acts, because an unhandled reply is the first mate's overdue work, not a call awaiting the captain.
`captain-hold-lifecycle` owns what the first mate does with one.
`tests/fm-captain-calls.test.sh` proves the record, the lock, the refusals, each clearing path, `list` and the drain section.

## Compatibility with pre-collapse installs

Older installs created derived `<origin>-decision-<key>` identities through the retired `bin/fm-decision-hold.sh`.
Those rows are already plain task ids, so they render, answer, verify, and close through the collapsed surfaces with no data migration.
Three legacy inputs are resolved in place: a `decision_keys=` metadata entry that names no task resolves through `<origin>-decision-<entry>`; a channel key that names no task resolves the same way when the source's binding carries a concrete legacy origin; and resolution records written by the old script are recognized wherever a record is read.
On the Beads backend, an attested legacy markdown id that resolves to no task is accepted through the row the markdown-to-beads hold migration produced, found by the authoritative evidence first: a row whose notes carry the marker line `migrated from data/backlog.md id <legacy id>`, either alone or followed by ` on <date>` as fm-hold-migration wrote it on 2026-09-04.
Only when no row carries that marker line is the legacy id tried under the configured beads prefix, and that name-only guess is accepted solely for a single row still held for the captain - two such rows refuse rather than attest.
Because that acceptance rests on a name rather than on evidence, `complete` names the resolved row beside each prefix-attested legacy id in its completion line, so the guess is auditable after the fact.
A markdown home keeps its legacy rows verbatim, so its resolution is unchanged.
The shim recognizes an exact replay of a pre-collapse routed resolution by its historical answer digest and routed ids, then finishes any still-recorded dependency-edge cleanup without rewriting the old decision text.
`bin/fm-decision-hold.sh` itself remains for one release as a thin command-mapping shim over `bin/fm-captain-hold.sh`, so in-flight work briefed before the collapse keeps working; its header owns the exact mapping.

## Verification record

The focused end-to-end regression suite is `tests/fm-captain-hold-lifecycle.test.sh`, using only synthetic `sample` identities and decision text.
It proves: cleanup of a finished task whose own row is the captain call leaves that call open, queued, held, carrying its deliverable, and visible in Bearings' Captain's Call, leaves no pending record behind, survives a `--force` cleanup, and closes only when `answer` records the captain's words, while an ordinary finished task in the same home still closes with its report link; an interrupted cleanup leaves the row In flight and untouched with its pending record, the next session start retains it as queued and held with the deliverable recorded when it remains unanswered, and an answer before replay preserves that record's completed report while closing the call so the next session start retires the satisfied record without losing the delivery from Recently Landed; a pending-close record that cannot be validated refuses the answer while naming the record and the reason; a relocated data directory keeps the retention in its one configured backlog; direct PR and local-only merge entrypoint calls refuse a still-held task before reaching the forge or moving local main, while a released pull request passes the guarded PR entrypoint, cleanup records its artifact, and Recently Landed publishes it; an ordinary release still survives zero-retention cleanup and archives when configured; a ship row whose captain hold cannot be read refuses cleanup before any destructive step and surfaces the read failure; the reconstructed silent-divergence case is signalled - a status resolution over a still-open captain-held task reaches both `diverged` and the drain's `RECORD DIVERGENCE` section, under the collapsed and the legacy identity alike, while the backlog task, its hold, and the status log all survive the report unchanged and the printed hint names both reconciliation directions; the false-signal boundary holds - a captain call with no routed work item, a verified `captain-held` transfer, a still-open status decision, an already answered call, and an ordinary task whose keyed question was answered all stay silent; a released call whose decision text is `local main`, closed with no artifact, is not published as a local-only landing; a report-only unresolved captain call refuses `--none` completion before teardown can erase the source; non-forced scout teardown always requires the durable inventory verification; the recorded-answer guard (a bare `tasks-axi done` close fails `verify` until `answer` records the captain's word, and an ordinary finished task cannot be dressed up as an answered call); answer-time resolution through a bound channel with task-id keys, including the `release` mode, mode-matched replay idempotence, and the refusal of drifted, mode-mismatched, absent, unheld, and already-closed keys; the chat channel reaching the same intake; hold-set stamping that precedes visible hold state, preserves an active lifecycle's timestamp, and resets after release; interrupted answer closure retaining the stamp until close and restoring resolution-first ordering on retry; deferral through `--until` leaving `captain_actionable` false until due; and every legacy path (composed identities through the shim, pre-collapse `decision_keys=` metadata, routed-resolution replay, and a concrete-origin binding).
The suite does not test the accepted merge-to-cleanup re-hold window or asynchronous queued-forge landing because those events occur after the locally serialized merge command has returned.

Two of its cases pin how a task body is read back rather than any decision behavior, because both paths that read one are otherwise silent when they get it wrong.
Holding a task that carries a body, and cleanup's retention of a captain-held row, both work where the installed JSON::PP defaults `allow_nonref` off and therefore rejects the JSON-encoded bare string a shown scalar field arrives as; the case forces that older default back off and probes that the simulation really does reject a bare scalar, so it cannot pass vacuously on a lenient library.
A fleet host does carry such a library, and both failures reproduce on it natively with no shim, so that behavior is observed and not only simulated.
The case still forces the older default rather than depending on the installed one, which is what makes it deterministic on any host.
A retained body's non-ASCII characters also survive cleanup's rewrite as their exact UTF-8 bytes, and the case asserts bytes rather than decoded strings: a codepoint at or below U+00FF is the one a stream with no raw layer emits as a single latin-1 byte, and comparing decoded strings cannot see that.
It uses one row per character class, because any character above U+00FF makes the whole string print as UTF-8 and would mask the latin-1 case in a mixed body.
That latin-1 byte loss also reproduces natively on the fleet host carrying the older library, with no shim.

The markdown-to-beads migration family runs the same suite's beads fixture (bd-driven scratch graph, self-skipping on markdown-only tasks-axi installs) and proves: `verify` and `complete` resolve an attested legacy id through a migrated row's marker note, through the configured prefix when no row carries a note - naming the resolved row in the completion line - and through the marker note of a pre-collapse derived identity; a marker-noted row wins over an unrelated captain-held row occupying the bare prefix namesake; an unresolvable id is refused once naming the id (never an empty name); and the attested id stays in `decision_keys=` for idempotent re-verification.
One case in that family needs no beads install and always runs: a stubbed tasks-axi that fails any markdown file override proves the captain-hold hold, answer, and close mutations reach a beads-configured home without one.

The reconcile path is pinned in the same suite: a reconcile answer arriving through the keyed-answer intake, in the default close mode and in the `release` mode a captain-gated work card declares, is refused and leaves both tasks held with no resolution record or request; only the separately bound captured-source intake records one durable request per task idempotently across a replay.
It also proves the two verification outcomes - an evidence-backed `reconciled` close that records the evidence under its own label and never as the captain's words, and a note that leaves the call queued, held, and dated - while both outcomes refuse without a pending board request, each durable mutation applies only once across close, probe, and request-retirement failures, a later distinct request with the same note still appends its own dated record, every failed retirement is surfaced with its pending request retained, incompatible resolution modes cannot replay as captain answers, and normal close, release, and replay paths retire pending requests.
The captured-source coverage proves Lavish deduplicates each card before separating versioned structured selections from notes, bare and annotated Reconcile choices never reach keyed answers, genuine current and legacy choices still close normally, legacy bare and separator-annotated reconcile values feed neither intake, mixed repeated selections preserve every other card's final value, the generic runner creates a request only through a verified bound source, chat reconcile text creates none, and the resulting board request authorizes evidence-backed closure.
The board's half is pinned in `tests/fm-bearings-board.test.sh`: every published decision card carries exactly one reconcile option, authored options reserve that value across every card type, recommendations name authored options, a decision card whose structured subject appears in the payload's landed rows is dropped while a genuinely open one is kept even when an unrelated landed id contains its key after a newline, a build requires a fresh authoritative listed-open result before binding or arming, a reopen retires the pre-reopen source generation and waits for a fresh live listener, and a rebuild of an already-armed board with no live listener starts one.
That suite drives its Lavish session through a protocol-shaped stub, and `tests/fm-bearings-board-lavish-live-e2e.test.sh` is the default-on capability guard for the installed provider; [`verification/process-event-sources.md`](verification/process-event-sources.md) owns the version-scoped evidence.
[`verification/process-event-sources.md`](verification/process-event-sources.md) owns the process-event ownership and reclamation evidence exercised by `tests/fm-procevent.test.sh`.

`tests/fm-captain-calls.test.sh` pins the call record and its surfaces: `hold` recording content and refusing what nobody could answer, a hold without content still listed as a call, evidence derived from `--origin` for pages presented before and after the call, a held task that produced work becoming its own origin without changing how an answer closes it, across a release and re-hold, `offer` and `evidence` (including `updated_at` and closed calls), `answers --source quarterdeck` writing the machine lines and honoring the declared `on_answer` in both directions, a freeform answer carrying no key, `answer --key`, an interrupted close reading as `answered` while a re-held call reads as open, `decide` and its idempotent retry, the listing window, damaged records, the snapshot's `calls[]` equalling `list --json`, an idempotent `migrate`, including the one-time backfill of older answers' machine lines with keys recovered only in the unambiguous cases and digests and retries still matching, `updated_at` moving only with the offered content, and both shims.

`tests/fm-classify-decision-key.test.sh` pins `status_key_closing_verb` itself: it separates a resolution from the durable-transfer close and from a still-open key, reports the last real transition across re-openings and both key positions, and treats a prose mention as no transition.

Projection regressions live in `tests/fm-fleet-snapshot-view.test.sh` (the total structured-only bucket classifier, hold-until parsing, kind-independent captain actionability, undated-hold aging, and title stripping) and `tests/fm-bearings-snapshot.test.sh` (default and expanded decision-bucket membership, deferral explanations, blocker-overflow disclosure, working-hold dual surfaces, remote-summary schema invalidation, exact leading-kind inference, artifact-kind mismatch and answered-question exclusion, kind-bearing and kindless local-only landings publishing their recorded note, and scout-report precedence over competing pull-request links).
The exact commands and their summarized outputs are recorded in the shipping PR's evidence; run the four suites above plus `tests/fm-send-resolve-key.test.sh`, `tests/fm-bearings-board.test.sh`, `tests/fm-procevent.test.sh`, and `bin/fm-lint.sh` to refresh this record, and `FM_BEARINGS_LAVISH_LIVE=1 tests/fm-bearings-board-lavish-live-e2e.test.sh` after a lavish-axi upgrade.
