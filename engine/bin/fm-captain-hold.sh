#!/usr/bin/env bash
# fm-captain-hold.sh - deterministic mechanics for tasks held for the captain.
#
# The semantic policy is owned once by
# .agents/skills/captain-hold-lifecycle/SKILL.md. This script never reads
# report, visual-review, chat, or terminal prose to guess whether the captain
# owes an answer. The invoking agent decides what is genuinely waiting on the
# captain; this script supplies guarded creation, a durable record of what the
# captain actually said, the investigation completion gate, and the one
# keyed-answer intake every channel feeds.
#
# There is no separate decision type. A captain call is an ordinary backlog
# task held for the captain through this script's mandatory `hold` subcommand,
# and its identity is simply the task id. Older installs created derived
# `<origin>-decision-<key>` identities through bin/fm-decision-hold.sh; those
# rows are already plain task ids, so they keep working here unchanged, and
# the legacy inputs noted below resolve them without a migration.
# All backlog reads and mutations address the active home's configured data
# directory the way bin/fm-backlog-transition-lib.sh does, which keeps main-home
# and secondmate-home ownership aligned with the work that discovered the call.
#
# Usage:
#   fm-captain-hold.sh hold <task-id> --reason <reason> \
#     [--title <title>] [--repo <repo>] [--origin <origin-id>] [--until YYYY-MM-DD] \
#     [--question <text>] [--option <key>=<label>]... [--recommend <key>] \
#     [--on-answer done|release] [--evidence <ref>]... [--about <task-id>]
#   fm-captain-hold.sh offer <task-id> [--question <text>] [--option <key>=<label>]... \
#     [--recommend <key>] [--on-answer done|release]
#   fm-captain-hold.sh evidence <task-id> (add | remove) <ref>
#   fm-captain-hold.sh reply <task-id> --words-file <path> --via quarterdeck|review|chat [--message <id>]
#   fm-captain-hold.sh replies [--older-than <minutes>]
#   fm-captain-hold.sh decide --about <task-id> --title <title> --what <one line> --why <one line> \
#     [--kind review-finding|merge|new-task|scope|other] [--link <url>] [--option <key>=<label>]...
#   fm-captain-hold.sh list [--json] [--since <days>]
#   fm-captain-hold.sh migrate
#   fm-captain-hold.sh answer <task-id> --decision-file <path> [--release] [--key <option-key>] [--via <channel>]
#   fm-captain-hold.sh answers [<legacy-origin> | --any-origin] --source <provenance> [--via <channel>]   (keyed answers on stdin)
#   fm-captain-hold.sh reconcile-requests --source-id <source-id> --source <provenance>   (task ids on stdin)
#   fm-captain-hold.sh bind <source-id> [<legacy-origin> | --any-origin]
#   fm-captain-hold.sh unbind <source-id>
#   fm-captain-hold.sh binding <source-id>
#   fm-captain-hold.sh complete <origin-id> (--none | <task-id>...)
#   fm-captain-hold.sh verify <origin-id>
#   fm-captain-hold.sh open <task-id> [--identity] [--distinguish-absent]
#   fm-captain-hold.sh diverged
#   fm-captain-hold.sh reconcile list
#   fm-captain-hold.sh reconcile close <task-id> --evidence-file <path>
#   fm-captain-hold.sh reconcile note <task-id> --note-file <path>
#
# `hold` places an existing task under an active captain hold, or creates the
# task first when no work item exists to hold (--title required to create; the
# optional --origin records provenance in the new task's body and supplies the
# default repo from that origin's metadata). Prefer holding the work item the
# question gates over minting a new row. The command records a UTC `Captain
# hold set:` timestamp in the task body: repeating an active hold preserves the
# existing timestamp, while re-holding released work starts a new lifecycle.
# A task already closed is refused rather than reopened. `--until` records the
# captain's own deferral date through `tasks-axi hold --until`, so a "revisit
# later" answer is stored as a date instead of a live card.
#
# ONE SOURCE OF TRUTH FOR A CALL'S CONTENT.
# The backlog row stays the spine: whether a call exists, and whether it is
# held, bucketed, answered, or closed, is read from the row alone. What the call
# asks lives beside the row in one sidecar record per call,
# `state/calls/<task-id>.json` (schema fm-call.v1), and this script is its only
# writer. It is written to a temporary file of its own and renamed, under the
# same per-task control lock every mutation here takes:
#   {schema, task, question, options:[{key,label,recommended}],
#    on_answer ("done"|"release"|null), origin, about, evidence:[<ref>],
#    raised_by, raised_at, updated_at, decided (null or {what,why,kind,link}),
#    reply (null or {words,via,at,message,previous}; see `reply` below)}
# `hold` writes it whenever it is given --question, --option, --recommend,
# --on-answer, --evidence, --about, or --origin (given, or defaulted as below),
# and a hold without any of them behaves exactly as it always did (an existing
# record only has its raised_at moved to a new lifecycle's hold-set stamp). The
# record is written before the hold is applied, so a newly held call is never
# visible without its content.
# Options: 2 to 8, keys `[a-z0-9][a-z0-9-]{0,31}`, labels one line of at most
# 200 characters, and --recommend must name one of them; the question is one
# line of at most 400 characters. --on-answer declares how an answer closes the
# call: `done` (a question; the default for a task this hold created, and for a
# row whose kind is captain because a hold created it) or `release` (held work
# resumes; the default for any other existing task). A record that declares
# nothing (null) is one written by `evidence` or `migrate` for an older call.
# `--origin` names the task whose work raised the call; that task's report and
# every page it presented argue the call automatically (see `list`). Holding an
# existing task that has already written its report or presented a page makes
# that task the origin when neither --origin nor the call's record names one,
# so a scout's own call needs no flag; a task this hold creates, work that has
# produced nothing yet, and a call whose record already names an origin are
# left as they are, and an explicit --origin always wins. A defaulted origin
# only links: it declares no on_answer, so an answer closes the call exactly
# as it would have without it.
# `offer` replaces the content of an open call and records `updated_at`, which
# moves only when the offered content (question, options, recommendation, or
# on_answer) is written by `hold` or `offer`, so a surface can tell a page
# revision older than the choice it argues; attaching evidence never moves it.
# `reply` keeps the captain's own words on an open call without deciding it:
# the captain replied on the call (in words, a dated "not now", or an option
# the call cannot record by key), and nothing has recorded what that means yet.
# It writes {words, via, at, message, previous} as the record's `reply`, where
# `via` is quarterdeck (a call card), review (a page review), or chat, `message`
# is the id of the message that carried the words (null without --message), and
# `previous` is the reply this one replaced (without its own `previous`), so a
# surface can say what the captain said before. The words file holds 1 to 8192
# bytes. It never closes, releases, answers, or re-holds, and never moves
# `updated_at`; a call with no record gets one whose `updated_at` is its
# raised_at. It refuses, with a one-line reason, a call that is absent, closed,
# not held for the captain, or already carrying a recorded answer in this hold
# lifecycle. An exact retry (same words, via, and message) prints `unchanged:`,
# and the same words and via with --message on a reply that names no message
# fill that message in, keeping its `at` and `previous`, for a surface that
# keeps the words before it sends the message that carries them. With
# --message, any other reply the call carries is newer than those words, so it
# stands and the command prints `unchanged:`; a fresh reply is written only
# when the call carries none.
# Only the first mate acting clears it: `answer` (and so `answers` and
# `decide`) once the answer is recorded, `offer`, and every `hold` once the
# hold is applied, because each records, re-asks, or defers the call.
# `replies` is the read-only report of replies still waiting on the first mate:
# one `<task-id>\t<at>\t<via>\t<first line of the words>` line per open call
# whose reply is at least --older-than minutes old (default 0), silent when
# there are none. bin/fm-wake-drain.sh prints it as UNHANDLED REPLIES.
# `evidence` attaches or detaches one ref on any call, open or closed. Refs:
#   page:task/<task-id>/<name> or page:chat/<name>  a presented page (must exist)
#   report:<task-id>   data/<task-id>/report.md (must exist)
#   url:<http(s) url>  anything else, such as a pull request
# `decide` raises a call and answers it on the captain's behalf in one act,
# for a call the first mate settled itself: it holds a new row
# `decided-<digest>` (the digest of every argument, so an exact retry names the
# same row and is an idempotent no-op), records the content with `decided`
# set, and answers it with `Answered by: firstmate` through the same `answer`
# path. `--about` must be a task this home knows.
# `list` joins every call row with its record. A call is a backlog row held for
# the captain now or ever (its hold kind survives a close) or one carrying a
# resolution block; a record whose row is not a call is ignored, and a row with
# no record is still listed, with its hold reason as the question and empty
# options and evidence. `--json` prints {schema:"fm-call-list.v1", calls:[...],
# damaged:[{task,file}]}, each call being {id, title, question, options,
# on_answer, state ("open"|"answered"|"closed"), bucket, captain_actionable,
# origin, about, evidence, raised_by, raised_at, updated_at, answer, decided,
# reply}, where `reply` is the record's reply while the call is open, else null.
# `bucket` and `captain_actionable` are the fleet snapshot's hold projection,
# unchanged: `list` reads the snapshot's own backlog parser
# (`fm-fleet-snapshot.sh --backlog-json`), and the snapshot hands its already
# parsed backlog in through the internal `--backlog-json <file>` flag, so its
# `calls[]` is exactly this array at one extra process. `evidence` is the
# explicit refs followed by what the origin produced - `report:<origin>` when
# the report exists and `page:task/<origin>/<name>` for every page with a
# complete revision - de-duplicated, derived at read time so presentation order
# never matters. `answer` is null or {key,label,by,via,at} read from the newest
# resolution block's machine lines. `state` is `answered` while a held row's
# newest block was written in this hold lifecycle (an interrupted close). By
# default every open or answered call is listed plus those closed within 7 days
# (`--since <days>` widens it); a call closed before `Answered at:` existed
# dates from its Done row. A damaged record is reported and skipped, never
# fatal. FM_CAPTAIN_HOLD_NOW pins "now" for the window.
# `migrate` is one-time and idempotent: it imports every
# `state/decision-options/<task>.json` into a call that has no options yet and
# turns every artifact revision's `covers` into page evidence on those calls,
# leaving the old files in place (read by nothing). It also gives every call
# answered before the machine lines existed the lines a current answer carries,
# inserted into its newest resolution block under the task lock without
# touching the decision text or digest: `Answered by: captain`, `Answered via:
# other`, `Answer label:` (the recovered option's own label; without a key,
# the recorded decision's first non-empty line, trimmed and capped at 200
# characters, or for a block the keyed intake wrote, the label the captain was
# shown, else the answer), `Answered at:` (the row's
# close date, the only resolution time an older block has), and `Answer key:`
# only when exactly one recorded option is named unambiguously - the line
# starts with the key followed by `:`, ` =`, `=`, or whitespace and a dash, or
# equals an option's label (a keyed block: its answer equals a key, or its
# shown label equals an option's label). This conversion is the one place this
# script ever reads recorded prose. A reconciliation block gets no lines. A
# block an earlier migrate backfilled (`Answered via: other` with a label equal
# to that first line) that recovered a key has its label corrected to the
# option's own.
#
# `answer` records the captain's exact words and resolves the call in the same
# act. It requires a non-empty captain decision file of at most 8192 bytes and
# writes a resolution block while preserving the leading hold-set stamp until
# the close succeeds (the previous body is preserved and archived through
# tasks-axi --archive-body). It closes a question with `tasks-axi done` - or,
# with `--release`, lifts the hold with `tasks-axi unhold` so a captain-gated
# WORK item resumes without closing - and restores resolution-first body
# ordering. An exact retry also completes unfinished ordering normalization and
# is idempotent only when its requested close mode
# matches the newest record; a changed decision or a mode mismatch is rejected.
# A re-held task may record a new answer on top. On a task already closed outside this script,
# `answer` records the missing resolution block (the old `repair` path) only
# when the task still carries the captain-hold provenance tasks-axi preserves
# through a close, so an ordinary finished task cannot be dressed up as an
# answered captain call. A hold that expired by date (`--until` in the past) is
# still answerable: the surviving hold annotations, not tasks-axi's live
# `held:` bit, prove the captain owned it.
#
# ONE KEYED-ANSWER INTAKE, FED BY EVERY CHANNEL.
# "A keyed answer resolves its matching captain-held task" is a single
# capability, owned here and nowhere else. `answers` reads
# `<task-id>\t<answer>\t<label>[\t<mode>]` lines on stdin and resolves each named
# task through the very same `answer` path above, so every guard applies
# identically no matter which channel the answer arrived on. The key IS the
# task id - no identity arithmetic. The optional fourth field selects the close:
# empty or `done` completes the task, `release` lifts the hold so held work
# resumes; anything else is skipped. A key that names no task, a task that is
# not held for the captain, or a task already closed is reported as `skipped:`
# and feeds nothing. A replayed delivery whose answer digest and requested
# close mode both match the newest record is reported `closed:` and is a no-op;
# a mode mismatch is skipped. A call whose record declares `on_answer` closes
# the way it declares: an empty mode column means "what the call declares",
# and a mode that disagrees with the declaration is skipped. The command exits
# nonzero when any key was skipped. `--source` is provenance text recorded in
# the durable decision, never a behavior switch (`--via` names the channel for
# the `Answered via:` line; see the channel vocabulary below): this command has no per-channel
# branch and no knowledge of chat, review decks, or any transport. An answer
# that names one of the call's recorded options is recorded with its
# `Answer key:`. Output, one line per input row: `closed: <task-id>`,
# `skipped: <task-id-or-key> (<reason>)`, or `refused: <key> (<reason>)`, then
# `answers: closed=<n> skipped=<n>`.
# Legacy input: an optional positional origin (or a stored concrete-origin
# binding) makes a key that names no task fall back to the old
# `<origin>-decision-<key>` identity, so an in-flight pre-collapse channel
# keeps closing its rows; `--any-origin` and the stored `(any)` marker mean
# what an absent origin means and are accepted for the same reason.
#
# RECONCILE IS RESERVED AT THIS INTAKE, NOT FILTERED IN A CHANNEL.
# The exact answer value `reconcile` means "go re-check reality", never "the
# captain answered". `answers` matches it before it reads the close mode,
# visibly refuses it, and never passes it to `answer`, so no channel and no
# card-declared mode can turn it into a close, release, or request. A separate
# `reconcile-requests` intake verifies a captured source's binding before it
# records a durable request under `state/reconcile-requests/`.
#
# `reconcile` is the verify-then-decide half. Both outcomes require the pending
# request created by the captain's board selection. `close` is the moot outcome:
# it requires the evidence that made the call moot, writes a `reconciled` resolution record
# under a `Reconciliation evidence:` label so it can never read as the
# captain's words, and closes the task. `note` is the still-active outcome: it
# appends one dated `Captain hold reconciled:` note and leaves the hold in
# place. A normal answer also retires the request because the call is settled.
# `list` is the read-only enumeration.
# docs/captain-hold-lifecycle.md owns the semantics.
#
# A channel's ONLY job is to turn whatever it received into those keyed lines
# and pipe them here. It must never map keys to tasks, build decision records,
# choose a close mode beyond what its card declared, or close anything itself.
#
# `bind`, `unbind`, and `binding` record that a captured-answer SOURCE feeds
# this intake, for any channel whose answers arrive detached from their origin
# (a process-event source id, for example). The binding is a private record
# under `state/decision-bindings/`; a source with no binding feeds nothing, so
# this whole path is opt-in per source and an unbound source behaves as if it
# did not exist. `bind` deliberately does not require the source to exist yet,
# so a channel can be bound BEFORE it is armed. The optional second argument
# exists only for legacy pre-collapse records and callers: a concrete origin is
# stored verbatim and used as the composition fallback above, and
# `--any-origin` stores the same `(any)` marker a plain `bind <source-id>`
# stores. `binding` prints the stored value verbatim and `answers` accepts it,
# so the process-event runner's feed seam is unchanged.
#
# `complete` is the shared investigation and visual-review completion gate.
# It attests, in the origin task's metadata, the reviewed inventory of
# captain-held tasks that carry the origin's unresolved captain calls.
# `--none` is an explicit semantic attestation that the just-reviewed surface
# has no unresolved captain call, and is refused while the origin still has an
# open keyed status decision. With a non-empty inventory, every listed task is
# verified durable (actively captain-held, or closed with a recorded answer),
# the inventory is unioned idempotently into the metadata, and every still-open
# keyed status decision is transferred to its durable owner with a
# `captain-held [key=...]` status close naming the inventory. Later review
# passes may add ids. A post-teardown visual review can complete against the
# surviving report and tasks without recreating task state.
# `verify` is read-only and is called by scout teardown, so teardown cannot
# erase a source before this gate has succeeded: every recorded inventory
# entry must still be durable and no keyed status decision may be open.
# Metadata compatibility: the attestation keeps the historical
# `decisions_reviewed=1` and `decision_keys=` keys, and an inventory entry that
# names no existing task resolves through the legacy `<origin>-decision-<entry>`
# identity, so pre-collapse metadata written by fm-decision-hold.sh verifies
# unchanged. An entry that exists as a task id is always that task. On the
# Beads backend an attested legacy markdown id that resolves to no task is
# accepted through the migrated row fm-hold-migration produced, found by the
# authoritative evidence first: a row whose notes carry the marker line
# "migrated from data/backlog.md id <legacy id>", alone or followed by
# " on <date>". Only when no row carries that line is the legacy id tried under
# the configured beads prefix, and that name-only guess is accepted solely for
# a single row still held for the captain; two such rows refuse rather than
# attest, and `complete` names each prefix-resolved row beside its attested
# legacy id so the guess stays auditable.
#
# `open` is the read-only predicate a mechanical closer asks before it may
# retire a task's row: is this task still an open captain call? Exit 0 means it
# is (not Done, hold kind captain), 1 means it is not, and 2 means the answer
# could not be established, so a caller that must never close a live call can
# treat "cannot tell" as its own case instead of as a no. With
# `--distinguish-absent`, an absent local task returns 3 instead of 1; a home
# with no backlog file counts as absent, because it records no captain calls.
# It prints nothing on these predicate results and mutates nothing, unless
# `--identity` asks it to print this call's
# LIFECYCLE identity, which it does on an exit 0 only. That identity - the
# hold-set stamp and the count of recorded answers - is what distinguishes two
# successive calls on one task id: re-holding released work starts a new
# lifecycle without necessarily touching the task's status log, so a consumer
# that bounds repeated work per call cannot use the task id alone.
# bin/fm-teardown.sh asks it before its automatic
# backlog close and, on 0, returns the row to Queued with its deliverable
# recorded instead (bin/fm-backlog-transition-lib.sh owns that transition), so
# holding the very work item a question gates is safe; only `answer` with the
# captain's words or evidence-backed `reconcile close` closes the call.
# bin/fm-watch.sh asks it when an ordinary
# crew task reaches a due stale alarm - its open backlog hold need not appear in
# the task's last status line - and on a 0 bounds repeated alarms from new pane
# hashes for the decision.
#
# `diverged` is the read-only guard over the seam between the two records of
# one captain call. See "record divergence" beside command_diverged below.
#
# Resolution records: the block written into the body names this script, the
# decision digest, and a `Resolution mode:` of answered, released, repaired, or
# reconciled. Records written by the retired fm-decision-hold.sh (routed,
# declined, answered, repaired) are recognized everywhere a record is read, so
# nothing already closed needs rewriting.
# An answer (every mode but reconciled) also writes machine lines directly
# under `Resolution mode:`, which `list` and the fleet snapshot read the way
# they read the hold-set stamp, never touching the prose below them:
#   Answer key: <option key>      only when the answer named one of the options
#   Answer label: <one line>      the option's label, the label a channel showed,
#                                 or the first line of the captain's words
#   Answered by: captain|firstmate
#   Answered via: <channel>       one token of the channel vocabulary below
#   Answered at: <UTC timestamp>
# They sit outside the decision digest on purpose: the digest stays the
# captain's words alone, so records written before these lines existed, and
# exact retries arriving later or through `answer` instead of `answers`, keep
# matching; a retry never rewrites an existing block. `answer --key` must name
# one of the call's recorded options (or, with none recorded, be a well-formed
# key); --by and --label are internal to `answers` and `decide`.
# CHANNEL VOCABULARY. `Answered via:` is always one of a closed set of tokens,
# never provenance prose, so a surface can say where the captain answered:
#   quarterdeck  the Quarterdeck app
#   chat         the captain's words relayed in chat by the first mate
#   lavish       a Lavish review board result
#   captured     any other captured process-event result
#   decide       a call the first mate decided on the captain's behalf
#   other        a channel that named none of these
# `answer` and `answers` take `--via <token>` and refuse any other value.
# Defaults when absent: `answer` -> chat; `answers` -> quarterdeck when
# --source is exactly `quarterdeck` (what the app sends), otherwise other;
# `decide` -> decide. `--source` stays free provenance text for the decision.
#
# Parent channel: inside a secondmate home a task held for the captain, and its
# answer, are captain-facing facts the moment they are recorded, so `hold`
# publishes `needs-decision [key=captain-hold-<task>-<n>]` and `answer` (and
# `answers`) the matching `resolved` line on the parent channel through
# bin/fm-parent-channel-lib.sh, whether or not the mate model appends anything.
# <n> is the count of resolution records the body already carries plus one, so
# a released and re-held task opens and closes a distinct parent decision with
# no new persisted state, and an exact retry republishes the same line, which
# the channel deduplicates. A main home has no channel and publishes nothing.
# The hold or answer is already durable in the backlog, so a channel that
# cannot be written is reported as `actionable:` on stderr rather than undoing
# the record; bin/fm-inactive-reconcile.sh's diagnostics name a broken binding.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"

# shellcheck source=bin/fm-classify-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/fm-classify-lib.sh"
# shellcheck source=bin/fm-tasks-axi-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
# shellcheck source=bin/fm-backlog-transition-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/fm-backlog-transition-lib.sh"
# `list` and `replies` only read, and the fleet snapshot runs `list` on homes that have no state yet.
case "${1:-}" in list|replies) FM_WAKE_READ_ONLY=1 ;; esac
# shellcheck source=bin/fm-wake-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/fm-wake-lib.sh"
# shellcheck source=bin/fm-parent-channel-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/fm-parent-channel-lib.sh"

PARENT_HOLD_PUBLISHED=0
publish_parent_hold() {  # <task-id> <occurrence> <verb> <note>
  local id=$1 occurrence=$2 verb=$3 note=$4 rc=0
  PARENT_HOLD_PUBLISHED=0
  fm_parent_channel_report "$FM_HOME" "$STATE" \
    "$verb [key=captain-hold-$id-$occurrence]: captain hold $id: $(fm_parent_channel_clean_note "$note")" || rc=$?
  case "$rc" in
    0|1) PARENT_HOLD_PUBLISHED=1 ;;
    *) printf 'actionable: task %s is held for the captain in this home but that did not reach the parent channel (rc=%s)\n' "$id" "$rc" >&2 ;;
  esac
}

CAPTAIN_META_LOCK=
CAPTAIN_META_LOCK_HELD=0
CAPTAIN_CONTROL_LOCK=
CAPTAIN_CONTROL_LOCK_HELD=0
captain_hold_cleanup() {
  if [ "$CAPTAIN_META_LOCK_HELD" = 1 ]; then
    fm_lock_release "$CAPTAIN_META_LOCK" || true
    CAPTAIN_META_LOCK_HELD=0
  fi
  if [ "$CAPTAIN_CONTROL_LOCK_HELD" = 1 ]; then
    fm_lock_release "$CAPTAIN_CONTROL_LOCK" || true
    CAPTAIN_CONTROL_LOCK_HELD=0
  fi
}
trap captain_hold_cleanup EXIT

usage() {
  awk '
    NR == 1 { next }
    /^#/ { sub(/^# ?/, ""); print; next }
    { exit }
  ' "$0"
}

fail() {
  printf 'fm-captain-hold: %s\n' "$*" >&2
  exit 1
}

validate_slug() {  # <label> <value>
  local label=$1 value=$2
  case "$value" in
    ''|*[!A-Za-z0-9._-]*) fail "$label must be a non-empty privacy-safe slug: $value" ;;
  esac
}

validate_one_line() {  # <label> <value>
  local label=$1 value=$2
  [ -n "$value" ] || fail "$label must not be empty"
  case "$value" in
    *$'\n'*|*$'\r'*) fail "$label must be one line" ;;
  esac
}

acquire_task_control_lock() {  # <task-id>
  CAPTAIN_CONTROL_LOCK="$STATE/.control-$1.lock"
  fm_lock_acquire_wait "$CAPTAIN_CONTROL_LOCK"
  CAPTAIN_CONTROL_LOCK_HELD=1
}

release_task_control_lock() {
  [ "$CAPTAIN_CONTROL_LOCK_HELD" = 1 ] || return 0
  fm_lock_release "$CAPTAIN_CONTROL_LOCK"
  CAPTAIN_CONTROL_LOCK_HELD=0
  CAPTAIN_CONTROL_LOCK=
}

sha256_text() {  # <text>
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    fail "shasum or sha256sum is required"
  fi
}

# The legacy derived identity older installs minted for a captain call.
# Kept only to resolve pre-collapse rows, metadata entries, and channel keys.
legacy_hold_id() {  # <origin-id> <key>
  printf '%s-decision-%s' "$1" "$2"
}

# The legacy any-origin binding marker. Slug validation rejects parentheses, so
# no real origin id or task id can collide with it.
BINDING_ANY='(any)'

DECISION_TEXT=''
DECISION_DIGEST=''

load_decision() {  # <path>; sets DECISION_TEXT and DECISION_DIGEST
  local path=$1 decision
  [ -n "$path" ] || fail "--decision-file is required"
  [ -f "$path" ] || fail "decision file does not exist: $path"
  decision=$(cat "$path")
  [ -n "$decision" ] || fail "decision file must not be empty"
  [ "$(printf '%s' "$decision" | LC_ALL=C wc -c | tr -d ' ')" -le 8192 ] \
    || fail "decision file exceeds 8192 bytes"
  DECISION_TEXT=$decision
  DECISION_DIGEST=$(sha256_text "$decision")
}

# Mutations address the configured data directory's backlog from its root, the
# way bin/fm-backlog-transition-lib.sh addresses every transition, so a home
# with a relocated data directory keeps one backlog. The explicit --file file
# belongs to the markdown backend only; a non-markdown backend is addressed by
# the root's own tasks-axi configuration, exactly like the transition library's
# mutate path.
tasks_axi() {
  local data file root backend
  data=$(fm_backlog_data_absolute "$DATA") || fail "data directory cannot be resolved: $DATA"
  root=$(fm_backlog_root "$data") || fail "$FM_BACKLOG_TRANSITION_ERROR"
  backend=$(fm_tasks_axi_backend "$root") || return 2
  if [ "$backend" = markdown ]; then
    file=$(fm_backlog_file "$data") || fail "$FM_BACKLOG_TRANSITION_ERROR"
    (cd "$root" && tasks-axi "$@" --file "$file")
  else
    (cd "$root" && tasks-axi "$@")
  fi
}

require_tasks_axi() {
  fm_tasks_axi_compatible || fail "compatible tasks-axi is required"
  tasks-axi hold --help 2>&1 | grep -F -- '--kind captain' >/dev/null \
    || fail "tasks-axi does not expose the captain-hold contract"
}

# Read one row into TASK_SHOW_OUTPUT; a non-zero return means the row is
# absent. A read that could not finish inside its bound is NOT absence, and
# every caller below would otherwise spend it as one - minting a duplicate task,
# skipping a keyed answer, or reporting a task that exists as missing. So the
# bound's own status stops the command instead, loudly and by name, and it
# leaves 124 intact rather than collapsing to fail's 1 so a caller running this
# inside a command substitution can still tell a wedged backend from a
# genuinely unknown id.
TASK_SHOW_OUTPUT=
task_show() {  # <id>; sets TASK_SHOW_OUTPUT
  local data status=0 reason
  data=$(fm_backlog_data_absolute "$DATA") || fail "data directory cannot be resolved: $DATA"
  TASK_SHOW_OUTPUT=$(fm_backlog_row_show "$data" "$1" --full 2>/dev/null) || status=$?
  if [ "$status" -eq 124 ]; then
    reason=${TASK_SHOW_OUTPUT%%$'\n'*}
    printf 'fm-captain-hold: %s\n' \
      "${reason:-tasks-axi show $1 exceeded its backlog read bound}" >&2
    exit 124
  fi
  return "$status"
}

# Read one row into `show`, failing with <absence-message> only when the read
# genuinely failed; a read-bound hit (124) stops the command by name instead.
# task_show must be called in THIS shell, not inside a command substitution:
# it carries the row in TASK_SHOW_OUTPUT, which a subshell cannot hand back.
task_show_or_fail() {  # <id> <absence-message>; sets show
  task_show "$1" || {
    [ "$?" -ne 124 ] || fail "the backlog backend exceeded its read bound reading $1"
    fail "$2"
  }
  show=$TASK_SHOW_OUTPUT
}

show_field() {  # <show-output> <field>
  local output=$1 field=$2
  printf '%s\n' "$output" | sed -n "s/^  $field: //p" | head -1
}

# A shown scalar field arrives as a JSON-encoded bare string, which decode_json
# accepts only where the installed JSON::PP defaults allow_nonref on. Older
# libraries default it off and reject the whole value as "must be object or
# array", so ask for it explicitly rather than inheriting the local default.
decode_shown_value() {  # <shown-field>
  local value=$1
  case "$value" in
    \"*\")
      printf '%s' "$value" | perl -MJSON::PP -e '
        local $/;
        my $value = JSON::PP->new->utf8->allow_nonref->decode(<STDIN>);
        binmode STDOUT, ":raw";
        utf8::encode($value) if utf8::is_utf8($value);
        print $value;
      '
      ;;
    *) printf '%s' "$value" ;;
  esac
}

# Decode show-encoded scalar fields and normalize the empty marker.
show_field_value() {  # <show-output> <field>
  local value
  value=$(decode_shown_value "$(show_field "$1" "$2")")
  [ "$value" != '-' ] || value=''
  printf '%s' "$value"
}

origin_exists_here() {  # <origin-id>
  [ -f "$STATE/$1.meta" ] && return 0
  [ -f "$DATA/$1/report.md" ] && return 0
  task_show "$1"
}

list_has_key() {  # <comma-list> <key>
  case ",$1," in
    *",$2,"*) return 0 ;;
    *) return 1 ;;
  esac
}

sorted_key_union() {  # <comma-list> <newline-or-space-separated-new-keys>
  local existing=$1 new=$2
  {
    printf '%s\n' "$existing" | tr ',' '\n'
    printf '%s\n' "$new" | tr ' ' '\n'
  } | sed '/^$/d' | LC_ALL=C sort -u | paste -sd, -
}

meta_value() {  # <meta> <key>
  grep "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

origin_open_decisions() {  # <origin-id>
  local origin=$1 meta="$STATE/$1.meta" status_file="$STATE/$1.status" open kind last verb
  open=$(status_open_decisions "$status_file")
  [ -n "$open" ] || return 0
  [ -f "$meta" ] || { printf '%s' "$open"; return 0; }
  kind=$(meta_value "$meta" kind)
  [ -n "$kind" ] || kind=ship
  if [ "$kind" != secondmate ]; then
    last=$(last_status_line "$status_file")
    verb=$(status_line_verb "$last")
    case "$verb" in
      done|failed) return 0 ;;
    esac
  fi
  printf '%s' "$open"
}

# A resolution record written by this script or by the retired
# fm-decision-hold.sh. Both carry the same leader-then-captain-decision shape.
body_has_resolution_record() {  # <task-body>
  case "$1" in
    *"Resolution recorded by fm-captain-hold."*"Captain decision:"*) return 0 ;;
    *"Resolution recorded by fm-decision-hold."*"Captain decision:"*) return 0 ;;
    *"Resolution recorded by fm-captain-hold."*"Reconciliation evidence:"*) return 0 ;;
  esac
  return 1
}

# The recorded decision digest of either record format, from the show-escaped
# body (multi-line bodies print as one quoted line with \n escapes). Records
# are prepended, so the first match is the newest record.
recorded_decision_digest() {  # <task-body>
  local rest=$1
  case "$rest" in
    *"Decision digest: "*) rest=${rest#*"Decision digest: "} ;;
    *) return 1 ;;
  esac
  rest=${rest%%\\n*}
  rest=${rest%%$'\n'*}
  printf '%s' "$rest"
}

# How many resolution records the shown body carries, in either record format.
resolution_record_count() {  # <task-body>
  local body
  body=$(decode_shown_value "$1") || return 1
  printf '%s\n' "$body" \
    | grep -Ec '^Resolution recorded by fm-(captain|decision)-hold\.$' || true
}

# The newest record's `Resolution mode:` value; empty for a record predating it.
recorded_resolution_mode() {  # <task-body>
  local rest=$1
  case "$rest" in
    *"Resolution mode: "*) rest=${rest#*"Resolution mode: "} ;;
    *) return 1 ;;
  esac
  rest=${rest%%\\n*}
  rest=${rest%%$'\n'*}
  printf '%s' "$rest"
}

closed_answer_replay_mode_compatible() {  # <mode> <task-body>
  case "$1" in
    answered|repaired|routed) return 0 ;;
  esac
  return 1
}

# The record's label is what keeps an evidence-backed reconciliation from
# reading as the captain's own words. `reconciled` closes a call that went moot
# and carries verified evidence; every other mode carries what the captain said.
#
# An answer's machine lines follow `Resolution mode:` directly (the header
# owns them). They are outside DECISION_DIGEST, which stays the captain's words.
ANSWER_KEY=''
ANSWER_LABEL=''
ANSWER_BY=''
ANSWER_VIA=''
resolution_block() {  # <mode>
  local label='Captain decision:' machine=''
  [ "$1" != reconciled ] || label='Reconciliation evidence:'
  if [ "$1" != reconciled ] && [ -n "$ANSWER_BY" ]; then
    [ -z "$ANSWER_KEY" ] || machine="${machine}Answer key: $ANSWER_KEY"$'\n'
    [ -z "$ANSWER_LABEL" ] || machine="${machine}Answer label: $ANSWER_LABEL"$'\n'
    machine="${machine}Answered by: $ANSWER_BY"$'\n'
    machine="${machine}Answered via: $ANSWER_VIA"$'\n'
    machine="${machine}Answered at: ${FM_CAPTAIN_HOLD_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"$'\n'
  fi
  printf 'Resolution recorded by fm-captain-hold.\nDecision digest: %s\nResolution mode: %s\n%s\n%s\n%s\n' \
    "$DECISION_DIGEST" "$1" "$machine" "$label" "$DECISION_TEXT"
}

# Durable state of one captain call: an active captain hold (annotations
# surviving even when a date gate has expired) or a recorded captain answer.
verify_hold_durable() {  # <task-id>
  local id=$1 show state hold_kind body
  task_show "$id" || fail "captain-held task $id is absent from this home's configured backlog (data directory $DATA)"
  show=$TASK_SHOW_OUTPUT
  state=$(show_field "$show" state)
  hold_kind=$(show_field_value "$show" hold_kind)
  body=$(show_field "$show" body)
  if body_has_resolution_record "$body"; then
    return 0
  fi
  if [ "$state" != "done" ] && [ "$hold_kind" = captain ]; then
    return 0
  fi
  fail "captain-held task $id is neither held for the captain nor closed with a recorded captain answer"
}

# --- migrated legacy-id resolution on the Beads backend ---------------------
#
# A home that moved its backlog from markdown to Beads no longer carries the
# legacy hold ids a scout report attested: the migration rehomed every held
# row under a prefixed fm- id and recorded its markdown identity in the row's
# notes as "migrated from data/backlog.md id <legacy id>", alone or followed by
# " on <date>" (fm-hold-migration wrote the dated form on 2026-09-04). When an
# attested legacy id resolves to no task, the beads backend accepts the row the
# migration produced, found by scanning the configured graph's notes for either
# form of that marker line, and only when no row carries the marker by
# prepending the configured prefix to the legacy id - a name-only guess, so it
# is accepted solely for a row still held for the captain and only when it is
# the single such row. A markdown home keeps its legacy rows verbatim, so its
# exact-id resolution is unchanged.

CAPTAIN_MIGRATION_SCAN_LOADED=0
CAPTAIN_MIGRATION_SCAN_JSON=
NL_SEP=$'\n'

# Section-aware [beads] extraction from a .tasks.toml: only keys inside the
# [beads] section, comments stripped. Prints "<key> <value>" lines.
captain_beads_toml_entries() {  # <toml-file>
  [ -f "$1" ] || return 0
  LC_ALL=C awk '
    function trim(v) { sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v); return v }
    BEGIN { inbeads = 0 }
    {
      line = $0
      sub(/[[:space:]]*#.*/, "", line)
      line = trim(line)
      if (line ~ /^\[[^]]+\]$/) { inbeads = (line == "[beads]"); next }
      if (!inbeads) next
      if (line ~ /^(prefix|path|binary)[[:space:]]*=/) {
        key = line
        sub(/[[:space:]]*=.*/, "", key)
        sub(/^[^=]*=[[:space:]]*/, "", line)
        gsub(/^"|"$/, "", line); gsub(/^'\''|'\''$/, "", line)
        printf "%s %s\n", key, line
      }
    }
  ' "$1"
}

captain_beads_setting() {  # <entries-output> <setting>
  printf '%s\n' "$1" | sed -n "s/^$2 //p" | head -1
}

# Read the configured beads graph's row listing for a migration-note scan.
# The listing is deliberately re-read per unresolvable key: the cache below
# lives and dies with the command-substitution subshell every resolve_entry
# call site runs in, so it cannot persist across keys - bounded by a scout
# report's handful of attested ids. Returns 0 when the listing loads, and 2
# with the reason on stderr when the graph cannot be read.
captain_migration_scan_load() {  # <resolved-data-dir>
  local data=$1 root entries bd_bin bd_path backend
  [ "$CAPTAIN_MIGRATION_SCAN_LOADED" = 1 ] && return 0
  root=$(fm_backlog_root "$data") || {
    printf 'fm-captain-hold: the configured data directory cannot be resolved for a migration scan: %s\n' "$FM_BACKLOG_TRANSITION_ERROR" >&2
    return 2
  }
  backend=$(fm_tasks_axi_backend "$root") || return 2
  if [ "$backend" != beads ]; then
    CAPTAIN_MIGRATION_SCAN_LOADED=1
    return 0
  fi
  entries=$(captain_beads_toml_entries "$root/.tasks.toml")
  bd_bin=$(captain_beads_setting "$entries" binary)
  bd_path=$(captain_beads_setting "$entries" path)
  bd_bin=${bd_bin:-bd}
  if [ -z "$bd_path" ]; then
    printf 'fm-captain-hold: the beads backend carries no graph path in %s, so a migrated hold cannot be found\n' "$root/.tasks.toml" >&2
    return 2
  fi
  # A relative [beads] path resolves against the backlog root, the same rule
  # every other .tasks.toml path consumer uses, never against the process CWD.
  case "$bd_path" in
    /*) ;;
    *) bd_path="$root/$bd_path" ;;
  esac
  command -v "$bd_bin" >/dev/null 2>&1 || {
    printf 'fm-captain-hold: the beads binary %s is not on PATH, so a migrated hold cannot be found\n' "$bd_bin" >&2
    return 2
  }
  command -v jq >/dev/null 2>&1 || {
    printf 'fm-captain-hold: jq is required to scan the beads graph for a migrated hold\n' >&2
    return 2
  }
  local bd_err
  bd_err=$(mktemp "${TMPDIR:-/tmp}/fm-captain-hold-bd.XXXXXX") || {
    printf 'fm-captain-hold: cannot stage the beads graph read diagnostics\n' >&2
    return 2
  }
  if ! CAPTAIN_MIGRATION_SCAN_JSON=$(BEADS_DIR="$bd_path" "$bd_bin" list --all --json 2>"$bd_err"); then
    printf 'fm-captain-hold: reading the beads graph at %s failed (%s), so a migrated hold cannot be found\n' \
      "$bd_path" "$(sanitize_field "$(head -c 200 "$bd_err" | tr '\n' ' ')")" >&2
    rm -f "$bd_err"
    return 2
  fi
  rm -f "$bd_err"
  CAPTAIN_MIGRATION_SCAN_LOADED=1
  return 0
}

# Resolve one attested legacy id to the migrated row that carries it on the
# beads backend. Prints "<row id> <how>" and returns 0 when exactly one
# migration matches, returns 1 when none does, and returns 2 with the reason on
# stderr when the scan itself cannot run or is ambiguous. The marker note is the
# authoritative evidence and is scanned first; the bare configured prefix is a
# guess, so it only runs when no marker line matches any identity and it accepts
# a row solely when that row is itself still held for the captain.
resolve_migrated_entry() {  # <origin-or-empty> <entry>
  local origin=$1 entry=$2 data root entries prefix derived show backend
  local candidate candidate_matches prefixed matches count prefixed_matches prefixed_count
  data=$(fm_backlog_data_absolute "$DATA") || {
    printf 'fm-captain-hold: the migrated hold of %s cannot be resolved: %s\n' \
      "$entry" "${FM_BACKLOG_TRANSITION_ERROR:-the configured data directory $DATA cannot be resolved}" >&2
    return 2
  }
  root=$(fm_backlog_root "$data") || {
    printf 'fm-captain-hold: the migrated hold of %s cannot be resolved: %s\n' \
      "$entry" "${FM_BACKLOG_TRANSITION_ERROR:-the configured data directory $DATA cannot be resolved}" >&2
    return 2
  }
  backend=$(fm_tasks_axi_backend "$root") || return 2
  [ "$backend" = beads ] || return 1
  # Every identity this entry could have been migrated under: the raw entry,
  # and - for a pre-collapse channel key - the derived legacy identity its
  # origin would have minted, because fm-hold-migration recorded the DERIVED
  # id in each migrated row's marker note.
  CAPTAIN_MIGRATION_IDENTITIES=$entry
  if [ -n "$origin" ] && [ "$origin" != "$BINDING_ANY" ]; then
    derived=$(legacy_hold_id "$origin" "$entry")
    if [ "$derived" != "$entry" ]; then
      CAPTAIN_MIGRATION_IDENTITIES="$CAPTAIN_MIGRATION_IDENTITIES $derived"
    fi
  fi
  captain_migration_scan_load "$data" || return 2
  matches=
  if [ -n "$CAPTAIN_MIGRATION_SCAN_JSON" ]; then
    for candidate in $CAPTAIN_MIGRATION_IDENTITIES; do
      candidate_matches=$(printf '%s\n' "$CAPTAIN_MIGRATION_SCAN_JSON" | jq -r \
        --arg exact "migrated from data/backlog.md id $candidate" \
        --arg dated "migrated from data/backlog.md id $candidate on " \
        '.[] | select(((.notes // "") | split("\n")) | any(. == $exact or startswith($dated))) | .id' 2>/dev/null) || {
        printf 'fm-captain-hold: the beads graph scan for the migrated hold of %s could not be parsed\n' "$candidate" >&2
        return 2
      }
      matches="${matches}${matches:+$NL_SEP}${candidate_matches}"
    done
    count=$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')
    case "$count" in
      0) : ;;
      1) printf '%s migrated-note' "$(printf '%s\n' "$matches" | sed '/^$/d' | sed -n 1p)"; return 0 ;;
      *)
        printf 'fm-captain-hold: the migrated hold of %s is ambiguous: %s rows carry its marker line (identities tried: %s)\n' \
          "$entry" "$count" "$(printf '%s' "$CAPTAIN_MIGRATION_IDENTITIES" | tr ' ' ',')" >&2
        return 2
        ;;
    esac
  fi
  # No marker line anywhere: a mechanical migration keeps the legacy id under
  # the configured prefix, but that name alone is evidence of nothing, so only
  # a row still held for the captain - and only one of them - is accepted.
  entries=$(captain_beads_toml_entries "$root/.tasks.toml")
  prefix=$(captain_beads_setting "$entries" prefix)
  [ -n "$prefix" ] || return 1
  prefixed_matches=
  for candidate in $CAPTAIN_MIGRATION_IDENTITIES; do
    case "$prefix" in
      *-) prefixed="$prefix$candidate" ;;
      *) prefixed="$prefix-$candidate" ;;
    esac
    # Same shell rule as task_show_or_fail: the row is read out of
    # TASK_SHOW_OUTPUT, so the read cannot sit inside a command substitution.
    task_show "$prefixed" 2>/dev/null || {
      [ "$?" -ne 124 ] || return 124
      continue
    }
    show=$TASK_SHOW_OUTPUT
    [ "$(show_field_value "$show" hold_kind)" = captain ] || continue
    prefixed_matches="${prefixed_matches}${prefixed_matches:+$NL_SEP}$prefixed"
  done
  prefixed_count=$(printf '%s\n' "$prefixed_matches" | sed '/^$/d' | wc -l | tr -d ' ')
  case "$prefixed_count" in
    0) return 1 ;;
    1) printf '%s migrated-prefix' "$prefixed_matches"; return 0 ;;
  esac
  printf 'fm-captain-hold: the migrated hold of %s is ambiguous: %s captain-held rows carry the configured prefix (identities tried: %s)\n' \
    "$entry" "$prefixed_count" "$(printf '%s' "$CAPTAIN_MIGRATION_IDENTITIES" | tr ' ' ',')" >&2
  return 2
}

# Resolve one inventory entry or channel key to the task that carries it: the
# exact task id when it exists, else the legacy derived identity, else - on the
# beads backend - the migrated row the markdown-to-beads hold migration wrote.
# Prints "<resolved id> <how>", where <how> is exact, legacy, migrated-note or
# migrated-prefix, so a caller can record which evidence carried the attestation.
resolve_entry() {  # <origin-or-empty> <entry>; prints "<id> <how>" or fails
  local origin=$1 entry=$2 legacy migrated rc
  if task_show "$entry"; then
    printf '%s exact' "$entry"
    return 0
  fi
  if [ -n "$origin" ] && [ "$origin" != "$BINDING_ANY" ]; then
    legacy=$(legacy_hold_id "$origin" "$entry")
    if task_show "$legacy"; then
      printf '%s legacy' "$legacy"
      return 0
    fi
  fi
  rc=0
  migrated=$(resolve_migrated_entry "$origin" "$entry") || rc=$?
  case "$rc" in
    0) printf '%s' "$migrated"; return 0 ;;
    2) return 2 ;;
    124) return 124 ;;
  esac
  if [ -n "$origin" ] && [ "$origin" != "$BINDING_ANY" ]; then
    legacy=$(legacy_hold_id "$origin" "$entry")
    fail "no captain-held task $entry and no migrated hold for it in this home's configured backlog (data directory $DATA); the nearest legacy identity $legacy also resolves to nothing"
  fi
  fail "no captain-held task $entry and no migrated hold for it in this home's configured backlog (data directory $DATA)"
}

body_hold_set_timestamp() {  # <decoded-task-body>
  printf '%s\n' "$1" \
    | sed -n \
      -e '1s/^Captain hold set: \([0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z\)$/\1/p' \
      -e '1s/^Captain hold set: \([0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\)$/\1/p' \
    | head -1
}

write_hold_set_stamp() {  # <task-id> <shown-body> <timestamp> <preserve-existing-0-or-1>
  local id=$1 body=$2 hold_set=$3 preserve=$4 existing new_body tmp
  body=$(decode_shown_value "$body") \
    || fail "could not decode the existing body for $id"
  existing=$(body_hold_set_timestamp "$body")
  if [ "$preserve" = 1 ] && [ -n "$existing" ]; then
    return 0
  fi
  if [ -n "$existing" ]; then
    body=${body#"Captain hold set: $existing"}
    case "$body" in
      $'\n\n'*) body=${body#$'\n\n'} ;;
      $'\n'*) body=${body#$'\n'} ;;
    esac
  fi
  new_body=$(printf 'Captain hold set: %s' "$hold_set")
  if [ -n "$body" ]; then
    new_body=$(printf '%s\n\n%s' "$new_body" "$body")
  fi
  tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-captain-hold-stamp.XXXXXX") \
    || fail "cannot stage the hold-set stamp"
  if ! printf '%s\n' "$new_body" > "$tmp"; then
    rm -f -- "$tmp"
    fail "cannot stage the hold-set stamp for $id"
  fi
  if ! tasks_axi update "$id" --body-file "$tmp" >/dev/null; then
    rm -f -- "$tmp"
    fail "could not record the hold-set stamp on $id"
  fi
  rm -f -- "$tmp"
}

# Resolve one entry and verify the row it names is durably captain-held. A
# resolution failure that is not the read bound keeps resolve_entry's own
# status - its stderr already named the entry; 124 means the backend never
# answered, which is not the same as an unknown entry and must not be spent
# as absence. On success prints "<id> <how>" so the caller can keep the
# attestation evidence.
verify_entry_durable() {  # <origin-or-empty> <entry>; prints "<id> <how>"
  local origin=$1 entry=$2 resolved resolve_status=0
  resolved=$(resolve_entry "$origin" "$entry") || resolve_status=$?
  if [ "$resolve_status" -ne 0 ]; then
    [ "$resolve_status" -ne 124 ] \
      || fail "the backlog backend exceeded its read bound resolving $entry"
    exit "$resolve_status"
  fi
  printf '%s\n' "$resolved"
  verify_hold_durable "${resolved%% *}"
}

# --- call records: the content of a call, beside its row --------------------
#
# The header owns the record's contract. Every writer below runs under the
# task's control lock, and every write goes to a temporary file of its own that
# is then renamed, so a reader sees a whole record or the previous one.

CALLS_DIR="$STATE/calls"
CALL_SCHEMA=fm-call.v1
CALL_MAX_OPTIONS=8

# The jq definition every reader and writer applies before trusting a record.
# shellcheck disable=SC2016 # jq, not the shell, expands these variables.
CALL_VALID_JQ='
  def valid_call($id):
    type == "object" and .schema == "fm-call.v1" and .task == $id
    and (.question | type) == "string"
    and (.options | type) == "array"
    and all(.options[]; type == "object" and (.key | type) == "string"
        and (.label | type) == "string" and (.recommended | type) == "boolean")
    and (.on_answer == null or .on_answer == "done" or .on_answer == "release")
    and (.origin == null or (.origin | type) == "string")
    and (.about == null or (.about | type) == "string")
    and (.evidence | type) == "array" and all(.evidence[]; type == "string")
    and (.raised_by == null or (.raised_by | type) == "string")
    and (.raised_at | type) == "string" and (.updated_at | type) == "string"
    and (.decided == null or (.decided | type) == "object")
    and (.reply == null or ((.reply | type) == "object"
        and (.reply.words | type) == "string" and (.reply.at | type) == "string"));'

require_jq() {
  command -v jq >/dev/null 2>&1 || fail "jq is required to read or record a call's content"
}

option_key_valid() {  # <key>
  local key=$1
  local LC_ALL=C
  case "$key" in
    ''|[!a-z0-9]*|*[!a-z0-9-]*) return 1 ;;
  esac
  [ "${#key}" -le 32 ]
}

# The task id alphabet a path may carry (bin/fm-pr-lib.sh's rule, which this
# script does not source).
task_id_path_safe() {  # <task-id>
  local id=${1-}
  local LC_ALL=C
  case "$id" in
    ''|.*|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
}

page_name_valid() {  # <name>
  local name=$1
  local LC_ALL=C
  case "$name" in
    ''|[!a-z0-9]*|*[!a-z0-9-]*) return 1 ;;
  esac
  [ "${#name}" -le 64 ]
}

call_record_path() { printf '%s/%s.json\n' "$CALLS_DIR" "$1"; }

call_now() {
  local now=${FM_CAPTAIN_HOLD_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
  case "$now" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) : ;;
    *) fail "FM_CAPTAIN_HOLD_NOW must be a UTC YYYY-MM-DDTHH:MM:SSZ timestamp" ;;
  esac
  printf '%s\n' "$now"
}

# Who raised the call: the first mate, or the crewmate whose pane ran this.
call_raised_by() {
  if [ -n "${FM_TASK_ID:-}" ]; then
    printf 'crew:%s\n' "$(sanitize_field "$FM_TASK_ID")"
  else
    printf 'firstmate\n'
  fi
}

# A presented page with at least one complete revision.
page_dir_presented() {  # <artifact-dir>
  local revision
  for revision in "$1"/rev-*/revision.json; do
    [ -f "$revision" ] && return 0
  done
  return 1
}

# Has the task produced a report or presented a page (what an origin derives)?
task_produced_work() {  # <task-id>
  local dir
  task_id_path_safe "$1" || return 1
  [ ! -f "$DATA/$1/report.md" ] || return 0
  for dir in "$DATA/$1/artifacts"/*; do
    [ -d "$dir" ] && page_name_valid "${dir##*/}" && page_dir_presented "$dir" && return 0
  done
  return 1
}

# Validate one evidence ref; with <must-exist> = 1 it must also name something
# that exists now (attaching), while detaching accepts any well-formed ref.
evidence_ref_validate() {  # <ref> <must-exist-0-or-1>
  local ref=$1 must_exist=$2 rest task name
  case "$ref" in
    *$'\n'*|*$'\r'*|*$'\t'*|*' '*) fail "evidence ref must be one word: $ref" ;;
  esac
  case "$ref" in
    page:task/*/*)
      rest=${ref#page:task/}
      task=${rest%%/*}
      name=${rest#*/}
      task_id_path_safe "$task" || fail "evidence ref names an invalid task id: $ref"
      page_name_valid "$name" || fail "evidence ref names an invalid page name: $ref"
      [ "$must_exist" = 0 ] || page_dir_presented "$DATA/$task/artifacts/$name" \
        || fail "no presented page $name on task $task: $ref"
      ;;
    page:chat/*)
      name=${ref#page:chat/}
      page_name_valid "$name" || fail "evidence ref names an invalid page name: $ref"
      [ "$must_exist" = 0 ] || page_dir_presented "$DATA/.artifacts/$name" \
        || fail "no presented chat page $name: $ref"
      ;;
    report:*)
      task=${ref#report:}
      task_id_path_safe "$task" || fail "evidence ref names an invalid task id: $ref"
      [ "$must_exist" = 0 ] || [ -f "$DATA/$task/report.md" ] \
        || fail "task $task has no report at data/$task/report.md: $ref"
      ;;
    url:http://?*|url:https://?*) : ;;
    *) fail "evidence ref must be page:task/<task-id>/<name>, page:chat/<name>, report:<task-id>, or url:<http(s) url>: $ref" ;;
  esac
}

# Load <task-id>'s record into CALL_RECORD (compact JSON), or '' when it has
# none. A writer must not build on a record it cannot trust, so a damaged one
# stops the command by name; `list` reads records separately and skips them.
# call_record_try_load is the same read returning 1 for a damaged record, for a
# caller that has a safe way to proceed without it.
CALL_RECORD=''
call_record_try_load() {  # <task-id>
  local id=$1 path
  CALL_RECORD=''
  path=$(call_record_path "$id")
  [ -e "$path" ] || [ -L "$path" ] || return 0
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  CALL_RECORD=$(jq -c --arg id "$id" "$CALL_VALID_JQ"'
    if valid_call($id) then . else error("invalid") end' "$path" 2>/dev/null) || {
    CALL_RECORD=''
    return 1
  }
}

call_record_load() {  # <task-id>
  require_jq
  call_record_try_load "$1" \
    || fail "call record is damaged: $(call_record_path "$1") (repair or remove it, then retry)"
}

call_record_store() {  # <task-id> <json>
  local id=$1 json=$2 dest tmp
  (umask 077; mkdir -p "$CALLS_DIR") || fail "cannot create $CALLS_DIR"
  [ -d "$CALLS_DIR" ] && [ ! -L "$CALLS_DIR" ] || fail "the call record directory is unsafe: $CALLS_DIR"
  dest=$(call_record_path "$id")
  tmp=$(mktemp "$CALLS_DIR/.$id.json.XXXXXX") || fail "cannot stage the call record for $id"
  if ! { printf '%s\n' "$json" | jq --arg id "$id" "$CALL_VALID_JQ"'
           if valid_call($id) then . else error("the composed record is invalid") end' > "$tmp" \
         && chmod 644 "$tmp" && mv -f -- "$tmp" "$dest"; }; then
    rm -f -- "$tmp"
    fail "cannot record the call content for $id"
  fi
}

# The first mate has acted on the call (recorded, re-asked, or deferred it), so
# the captain's reply is no longer waiting: clear it. A record this cannot read
# is left as it is with a warning, because the act that clears it has already
# succeeded and must not be reported as failed.
call_reply_clear() {  # <task-id>
  local id=$1 record
  command -v jq >/dev/null 2>&1 || return 0
  if ! call_record_try_load "$id"; then
    printf 'fm-captain-hold: warning: call record %s is damaged; its reply was left as it is\n' \
      "$(call_record_path "$id")" >&2
    return 0
  fi
  [ -n "$CALL_RECORD" ] || return 0
  printf '%s' "$CALL_RECORD" | jq -e '.reply != null' >/dev/null || return 0
  record=$(printf '%s' "$CALL_RECORD" | jq -c '.reply = null') \
    || fail "cannot compose the call content for $id"
  call_record_store "$id" "$record"
}

# The newest resolution block's `Answered at:` in a decoded body, or nothing.
newest_answered_at() {  # <decoded-task-body>
  printf '%s\n' "$1" | awk '
    /^Resolution recorded by fm-(captain|decision)-hold\.$/ { if (seen) exit; seen = 1; next }
    !seen { next }
    /^Answered at: / { sub(/^Answered at: /, ""); print; exit }
    !/^(Decision digest|Resolution mode|Answer key|Answer label|Answered by|Answered via): / { exit }
  '
}

# --- the content flags hold, offer, and decide share -----------------------

CALL_CONTENT_GIVEN=0
CALL_QUESTION=''
CALL_QUESTION_SET=0
CALL_OPTION_PAIRS=()
CALL_OPTIONS_JSON=null
CALL_RECOMMEND=''
CALL_RECOMMEND_SET=0
CALL_ON_ANSWER=''
CALL_EVIDENCE=()
CALL_ABOUT=''
CALL_ABOUT_SET=0

# Record one content flag; returns 1 for a flag that is not a content flag.
call_content_flag() {  # <flag> <value>
  case "$1" in
    --question) CALL_QUESTION=$2; CALL_QUESTION_SET=1 ;;
    --option) CALL_OPTION_PAIRS+=("$2") ;;
    --recommend) CALL_RECOMMEND=$2; CALL_RECOMMEND_SET=1 ;;
    --on-answer) CALL_ON_ANSWER=$2 ;;
    --evidence) CALL_EVIDENCE+=("$2") ;;
    --about) CALL_ABOUT=$2; CALL_ABOUT_SET=1 ;;
    *) return 1 ;;
  esac
  CALL_CONTENT_GIVEN=1
}

# Validate the content flags the way the retired fm-decision-options.sh did,
# and build CALL_OPTIONS_JSON (null when no --option was given).
call_content_validate() {
  local pair key keys=' ' err ref
  if [ "$CALL_QUESTION_SET" = 1 ]; then
    validate_one_line question "$CALL_QUESTION"
  fi
  for pair in "${CALL_OPTION_PAIRS[@]+"${CALL_OPTION_PAIRS[@]}"}"; do
    case "$pair" in *=*) ;; *) fail "--option takes <key>=<label>, got '$pair'" ;; esac
    key=${pair%%=*}
    option_key_valid "$key" || fail "'$key' is not an option key (expected [a-z0-9][a-z0-9-]{0,31})"
    [ -n "${pair#*=}" ] || fail "option '$key' has no label"
    case "${pair#*=}" in *$'\n'*|*$'\r'*) fail "option '$key' label must be one line" ;; esac
    case "$keys" in *" $key "*) fail "--option names '$key' twice" ;; esac
    keys="$keys$key "
  done
  if [ "${#CALL_OPTION_PAIRS[@]}" -gt 0 ]; then
    [ "${#CALL_OPTION_PAIRS[@]}" -ge 2 ] || fail "a call needs at least two options"
    [ "${#CALL_OPTION_PAIRS[@]}" -le "$CALL_MAX_OPTIONS" ] \
      || fail "a call takes at most $CALL_MAX_OPTIONS options, got ${#CALL_OPTION_PAIRS[@]}"
    if [ "$CALL_RECOMMEND_SET" = 1 ]; then
      case "$keys" in *" $CALL_RECOMMEND "*) ;; *) fail "--recommend names '$CALL_RECOMMEND', which is not one of the options" ;; esac
    fi
  elif [ "$CALL_RECOMMEND_SET" = 1 ]; then
    option_key_valid "$CALL_RECOMMEND" || fail "'$CALL_RECOMMEND' is not an option key"
  fi
  case "$CALL_ON_ANSWER" in
    ''|done|release) : ;;
    *) fail "--on-answer must be done or release: $CALL_ON_ANSWER" ;;
  esac
  if [ "$CALL_ABOUT_SET" = 1 ]; then
    validate_slug about "$CALL_ABOUT"
  fi
  for ref in "${CALL_EVIDENCE[@]+"${CALL_EVIDENCE[@]}"}"; do
    evidence_ref_validate "$ref" 1
  done
  if [ "$CALL_QUESTION_SET" = 1 ] || [ "${#CALL_OPTION_PAIRS[@]}" -gt 0 ]; then
    require_jq
    err=$(jq -nr --arg question "$CALL_QUESTION" '
      ($ARGS.positional | map(.[(index("=") + 1):])) as $labels
      | if ($question | length) > 400 then "--question is longer than 400 characters"
        else ([$labels[] | select(length > 200)] | first // empty
              | "an option label is longer than 200 characters: \(.[:40])...")
        end' --args "${CALL_OPTION_PAIRS[@]+"${CALL_OPTION_PAIRS[@]}"}") \
      || fail "cannot measure the call content"
    [ -z "$err" ] || fail "$err"
  fi
  if [ "${#CALL_OPTION_PAIRS[@]}" -gt 0 ]; then
    CALL_OPTIONS_JSON=$(jq -nc '$ARGS.positional
      | map(index("=") as $i | {key:.[:$i], label:.[($i + 1):], recommended:false})' \
      --args "${CALL_OPTION_PAIRS[@]}") || fail "cannot build the call options"
  fi
}

# Compose a record from the current one (CALL_RECORD, or a fresh one) and the
# content flags. <raised-at> replaces raised_at when non-empty; <default-on-answer>
# declares on_answer only when neither the flags nor the record declare it.
call_record_compose() {  # <task-id> <now> <raised-at> <default-on-answer> <origin>
  local id=$1 now=$2 raised_at=$3 default_on_answer=$4 origin=$5 evidence out
  evidence=$(jq -nc '$ARGS.positional' --args "${CALL_EVIDENCE[@]+"${CALL_EVIDENCE[@]}"}") \
    || fail "cannot build the call evidence"
  out=$(jq -nc \
    --argjson cur "${CALL_RECORD:-null}" \
    --arg id "$id" --arg now "$now" --arg schema "$CALL_SCHEMA" \
    --arg raised_by "$(call_raised_by)" --arg raised_at "$raised_at" \
    --arg question "$CALL_QUESTION" --argjson question_set "$CALL_QUESTION_SET" \
    --argjson options "$CALL_OPTIONS_JSON" \
    --arg recommend "$CALL_RECOMMEND" --argjson recommend_set "$CALL_RECOMMEND_SET" \
    --arg on_answer "$CALL_ON_ANSWER" --arg default_on_answer "$default_on_answer" \
    --argjson evidence "$evidence" \
    --arg about "$CALL_ABOUT" --argjson about_set "$CALL_ABOUT_SET" \
    --arg origin "$origin" '
    ($cur // {schema:$schema, task:$id, question:"", options:[], on_answer:null,
              origin:null, about:null, evidence:[], raised_by:$raised_by,
              raised_at:$now, updated_at:$now, decided:null})
    | if $question_set == 1 then .question = $question else . end
    | if $options != null then .options = $options else . end
    | if $recommend_set == 1 then
        if any(.options[]; .key == $recommend)
        then .options |= map(.recommended = (.key == $recommend))
        else error("--recommend names \($recommend), which is not one of the options") end
      else . end
    | if $on_answer != "" then .on_answer = $on_answer
      elif .on_answer == null and $default_on_answer != "" then .on_answer = $default_on_answer
      else . end
    | .evidence = reduce $evidence[] as $e (.evidence;
        if any(.[]; . == $e) then . else . + [$e] end)
    | if $about_set == 1 then .about = $about else . end
    | if $origin != "" then .origin = $origin else . end
    | if $raised_at != "" then .raised_at = $raised_at else . end
    | if $question_set == 1 or $options != null or $recommend_set == 1 or $on_answer != ""
      then .updated_at = $now else . end' 2>&1) \
    || fail "cannot compose the call content for $id: ${out##*error*: }"
  printf '%s\n' "$out"
}

# Is the shown row a call at all: held for the captain now or ever (the hold
# kind survives a close), or carrying a resolution block.
shown_row_is_call() {  # <show-output>
  [ "$(show_field_value "$1" hold_kind)" = captain ] && return 0
  body_has_resolution_record "$(show_field "$1" body)"
}

# The raised_at a record created for an existing call starts from: its active
# hold-set stamp, else now.
shown_call_raised_at() {  # <show-output> <now>
  local stamp
  stamp=$(body_hold_set_timestamp "$(show_field_value "$1" body)")
  printf '%s\n' "${stamp:-$2}"
}

# The answer's machine lines for the resolution block (see the header).
# The closed channel vocabulary of `Answered via:` (the header owns it).
VIA_TOKENS='quarterdeck, chat, lavish, captured, decide, other'
via_token_valid() {  # <token>
  case "$1" in
    quarterdeck|chat|lavish|captured|decide|other) return 0 ;;
  esac
  return 1
}

answer_machine_lines() {  # <task-id> <key> <label> <by> <via>
  local id=$1 key=$2 label=$3 option_label=''
  ANSWER_KEY=''
  ANSWER_LABEL=''
  ANSWER_BY=$4
  ANSWER_VIA=$5
  if [ -n "$key" ]; then
    call_record_load "$id"
    if [ -n "$CALL_RECORD" ] \
      && [ "$(printf '%s' "$CALL_RECORD" | jq '.options | length')" -gt 0 ]; then
      option_label=$(printf '%s' "$CALL_RECORD" | jq -r --arg key "$key" \
        'first(.options[] | select(.key == $key) | .label) // empty')
      [ -n "$option_label" ] || fail "--key $key is not one of the options call $id offers"
    fi
    ANSWER_KEY=$key
  fi
  [ -n "$label" ] || label=$option_label
  [ -n "$label" ] || label=$(printf '%s\n' "$DECISION_TEXT" | sed -n '/[^[:space:]]/{p;q;}')
  ANSWER_LABEL=$(sanitize_field "$label")
}

command_hold() {
  local id=${1:-} title='' reason='' repo='' origin='' until='' show state existing_title body='' hold_kind hold_set occurrence
  local existing_hold_kind='' existing_held='' preserve_hold_set=0 created=0 existing_kind='' default_on_answer
  local stamp raised_at record
  [ "$#" -ge 1 ] || { usage >&2; exit 2; }
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --title) shift; title=${1:-} ;;
      --reason) shift; reason=${1:-} ;;
      --repo) shift; repo=${1:-} ;;
      --origin) shift; origin=${1:-} ;;
      --until) shift; until=${1:-} ;;
      --question|--option|--recommend|--on-answer|--evidence|--about)
        [ "$#" -ge 2 ] || { usage >&2; exit 2; }
        call_content_flag "$1" "$2"
        shift
        ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  validate_slug task-id "$id"
  validate_one_line reason "$reason"
  case "$reason" in *'('*|*')'*) fail "reason must not contain parentheses (tasks-axi hold contract)" ;; esac
  if [ -n "$origin" ]; then
    validate_slug origin-id "$origin"
  fi
  call_content_validate
  if [ -n "$until" ]; then
    case "$until" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) : ;;
      *) fail "--until must be a YYYY-MM-DD date: $until" ;;
    esac
  fi
  hold_set=${FM_CAPTAIN_HOLD_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
  case "$hold_set" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) : ;;
    *) fail "FM_CAPTAIN_HOLD_NOW must be a UTC YYYY-MM-DDTHH:MM:SSZ timestamp" ;;
  esac
  acquire_task_control_lock "$id"
  require_tasks_axi
  if task_show "$id"; then
    show=$TASK_SHOW_OUTPUT
    state=$(show_field "$show" state)
    [ "$state" != "done" ] \
      || fail "task $id is already closed; a new captain call needs its own task"
    existing_hold_kind=$(show_field_value "$show" hold_kind)
    existing_held=$(show_field_value "$show" held)
    existing_kind=$(show_field_value "$show" kind)
    if [ "$existing_hold_kind" = captain ] && [ "$existing_held" = yes ]; then
      preserve_hold_set=1
    fi
    if [ -n "$title" ]; then
      existing_title=$(show_field_value "$show" title)
      [ "$existing_title" = "$title" ] || fail "existing task $id has a different title"
    fi
  else
    [ -n "$title" ] || fail "--title is required to create task $id"
    validate_one_line title "$title"
    if [ -z "$repo" ] && [ -n "$origin" ] && [ -f "$STATE/$origin.meta" ]; then
      repo=$(meta_value "$STATE/$origin.meta" project)
      repo=${repo%/}
      repo=${repo##*/}
    fi
    [ -n "$repo" ] || repo=firstmate
    validate_one_line repo "$repo"
    [ -z "$origin" ] || body=$(printf 'Origin: %s' "$origin")
    if [ -n "$body" ]; then
      tasks_axi add "$id" "$title" --kind captain --repo "$repo" --body "$body" >/dev/null \
        || fail "could not create task $id"
    else
      tasks_axi add "$id" "$title" --kind captain --repo "$repo" >/dev/null \
        || fail "could not create task $id"
    fi
    created=1
  fi
  # Publish the timestamp before the captain-hold annotation. A concurrent
  # snapshot may see the harmless stamp by itself, but can never see a newly
  # held task without the timestamp that defines this hold lifecycle's age.
  task_show_or_fail "$id" "task $id disappeared before recording its hold-set stamp"
  write_hold_set_stamp "$id" "$(show_field "$show" body)" "$hold_set" "$preserve_hold_set"
  task_show_or_fail "$id" "task $id disappeared while recording its hold-set stamp"
  stamp=$(body_hold_set_timestamp "$(show_field_value "$show" body)")
  [ -n "$stamp" ] || fail "task $id did not retain its hold-set stamp"
  # The call's content is recorded before the hold is applied, for the same
  # reason the stamp is: a newly held call is never visible without it. A hold
  # given no content keeps behaving as it always did; an existing record only
  # follows a new hold lifecycle's stamp.
  if [ "$created" = 1 ] || [ "$existing_kind" = captain ]; then
    default_on_answer="done"
  else
    default_on_answer=release
  fi
  # Holding work that has already produced something makes that work the
  # call's origin unless the call names one, so the caller never has to
  # repeat the held id for its report and pages to argue the call.
  if [ -z "$origin" ] && [ "$created" = 0 ] && task_produced_work "$id" \
    && command -v jq >/dev/null 2>&1 && call_record_try_load "$id" \
    && [ -z "$(printf '%s' "${CALL_RECORD:-null}" | jq -r '.origin // empty')" ]; then
    origin=$id
    [ "$CALL_CONTENT_GIVEN" = 1 ] || default_on_answer=''
  fi
  if [ "$CALL_CONTENT_GIVEN" = 1 ] || [ -n "$origin" ]; then
    call_record_load "$id"
    raised_at=''
    if [ -z "$CALL_RECORD" ] || [ "$preserve_hold_set" = 0 ]; then
      raised_at=$stamp
    fi
    record=$(call_record_compose "$id" "$hold_set" "$raised_at" "$default_on_answer" "$origin") || exit 1
    call_record_store "$id" "$record"
  elif [ "$preserve_hold_set" = 0 ] \
    && { [ -e "$(call_record_path "$id")" ] || [ -L "$(call_record_path "$id")" ]; }; then
    if call_record_try_load "$id" && [ -n "$CALL_RECORD" ]; then
      [ "$(printf '%s' "$CALL_RECORD" | jq -r '.origin // empty')" != "$id" ] || default_on_answer=''
      record=$(call_record_compose "$id" "$hold_set" "$stamp" "$default_on_answer" '') || exit 1
      call_record_store "$id" "$record"
    else
      printf 'fm-captain-hold: warning: call record %s is damaged and was left as it is\n' \
        "$(call_record_path "$id")" >&2
    fi
  fi
  if [ -n "$until" ]; then
    tasks_axi hold "$id" --reason "$reason" --kind captain --until "$until" >/dev/null \
      || fail "could not hold task $id for the captain"
  else
    tasks_axi hold "$id" --reason "$reason" --kind captain >/dev/null \
      || fail "could not hold task $id for the captain"
  fi
  task_show "$id" || fail "task $id disappeared while holding it"
  show=$TASK_SHOW_OUTPUT
  hold_kind=$(show_field_value "$show" hold_kind)
  [ "$hold_kind" = captain ] || fail "task $id did not retain its captain hold"
  call_reply_clear "$id"
  occurrence=$(( $(resolution_record_count "$(show_field "$show" body)") + 1 ))
  [ -n "$(body_hold_set_timestamp "$(show_field_value "$show" body)")" ] \
    || fail "task $id lost its hold-set stamp while being held"
  publish_parent_hold "$id" "$occurrence" needs-decision "$reason"
  printf '%s\n' "$id"
}

# Record a resolution block beneath any leading active hold-set stamp,
# preserving the previous body below it and archiving the pristine original.
# Successful closure removes the stamp to restore resolution-first ordering.
write_resolution_record() {  # <task-id> <mode> <shown-body>
  local id=$1 mode=$2 body=$3 new_body tmp hold_set
  new_body=$(resolution_block "$mode")
  body=$(decode_shown_value "$body") \
    || fail "could not decode the existing body for $id"
  hold_set=$(body_hold_set_timestamp "$body")
  if [ -n "$hold_set" ]; then
    body=${body#"Captain hold set: $hold_set"}
    case "$body" in
      $'\n\n'*) body=${body#$'\n\n'} ;;
      $'\n'*) body=${body#$'\n'} ;;
    esac
    new_body=$(printf 'Captain hold set: %s\n\n%s' "$hold_set" "$new_body")
  fi
  if [ -n "$body" ]; then
    new_body=$(printf '%s\n\n%s' "$new_body" "$body")
  fi
  tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-captain-hold-body.XXXXXX") \
    || fail "cannot stage the resolution record"
  if ! printf '%s\n' "$new_body" > "$tmp"; then
    rm -f -- "$tmp"
    fail "cannot stage the resolution record for $id"
  fi
  if ! tasks_axi update "$id" --body-file "$tmp" --archive-body >/dev/null; then
    rm -f -- "$tmp"
    fail "could not record the captain decision on $id"
  fi
  rm -f -- "$tmp"
}

report_retained_artifact_failure() {  # <task-id> <marker-path>
  printf 'fm-captain-hold: cannot apply the artifact recorded for %s in %s: %s\n' \
    "$1" "$2" "${FM_BACKLOG_TRANSITION_ERROR:-no reason reported}" >&2
}

apply_pending_retained_artifact() {  # <task-id>
  local id=$1 marker
  local -a args=()
  marker=$(fm_backlog_close_marker_path "$STATE" "$id") || return 1
  [ -e "$marker" ] || [ -L "$marker" ] || return 0
  fm_backlog_close_marker_validate "$marker" "$DATA" "$id" "$STATE" \
    || { report_retained_artifact_failure "$id" "$marker"; return 1; }
  [ "$FM_BACKLOG_CLOSE_VALIDATED_MODE" = retain ] || return 0
  args=("${FM_BACKLOG_CLOSE_VALIDATED_ARGS[@]+"${FM_BACKLOG_CLOSE_VALIDATED_ARGS[@]}"}")
  case "${args[0]-}" in
    --pr|--report)
      fm_backlog_row_artifact_supported "$id" "${args[@]}" || return 0
      fm_backlog_mutate "$DATA" update "$id" "${args[@]}" \
        || { report_retained_artifact_failure "$id" "$marker"; return 1; }
      ;;
  esac
}

close_answered() {  # <task-id> <release-0-or-1>
  if [ "$2" = 1 ]; then
    tasks_axi unhold "$1" >/dev/null
  else
    apply_pending_retained_artifact "$1" || return 1
    tasks_axi "done" "$1" >/dev/null
  fi
}

remove_interrupted_answer_stamp() {  # <task-id>
  local id=$1 show body existing tmp
  task_show_or_fail "$id" "task $id disappeared after closing"
  body=$(decode_shown_value "$(show_field "$show" body)") \
    || fail "could not decode the closed body for $id"
  existing=$(body_hold_set_timestamp "$body")
  [ -n "$existing" ] || return 0
  body=${body#"Captain hold set: $existing"}
  case "$body" in
    $'\n\n'*) body=${body#$'\n\n'} ;;
    $'\n'*) body=${body#$'\n'} ;;
  esac
  tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-captain-hold-normalize.XXXXXX") \
    || fail "cannot stage the closed body for $id"
  if ! printf '%s\n' "$body" > "$tmp" \
    || ! tasks_axi update "$id" --body-file "$tmp" >/dev/null; then
    rm -f -- "$tmp"
    fail "could not restore the resolution record ordering for $id"
  fi
  rm -f -- "$tmp"
}

command_answer() {
  local id=${1:-} decision_file='' release=0 show state hold_kind body outcome recorded_mode occurrence
  local key='' key_set=0 via=chat label='' by=captain
  [ "$#" -ge 1 ] || { usage >&2; exit 2; }
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --decision-file) shift; decision_file=${1:-} ;;
      --release) release=1 ;;
      --key) shift; key=${1:-}; key_set=1 ;;
      --via) shift; via=${1:-} ;;
      --label) shift; label=${1:-} ;;
      --by) shift; by=${1:-} ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  validate_slug task-id "$id"
  load_decision "$decision_file"
  if [ "$key_set" = 1 ]; then
    option_key_valid "$key" || fail "--key must be an option key ([a-z0-9][a-z0-9-]{0,31}): $key"
  fi
  via_token_valid "$via" || fail "--via must be one of $VIA_TOKENS: $via"
  case "$by" in captain|firstmate) ;; *) fail "--by must be captain or firstmate: $by" ;; esac
  acquire_task_control_lock "$id"
  require_tasks_axi
  answer_machine_lines "$id" "$key" "$label" "$by" "$via"
  task_show "$id" || fail "captain-held task $id is absent from this home's configured backlog (data directory $DATA)"
  show=$TASK_SHOW_OUTPUT
  state=$(show_field "$show" state)
  hold_kind=$(show_field_value "$show" hold_kind)
  body=$(show_field "$show" body)
  if [ "$release" = 1 ]; then outcome=released; else outcome=answered; fi
  # The occurrence the parent line names: the record about to be written is
  # one past those already in the body, and a retry names the newest one.
  occurrence=$(( $(resolution_record_count "$body") + 1 ))

  if [ "$state" = "done" ]; then
    if body_has_resolution_record "$body"; then
      # An exact compatible retry is an idempotent no-op; drift is rejected.
      [ "$(recorded_decision_digest "$body" || true)" = "$DECISION_DIGEST" ] \
        || fail "captain-held task $id records a different captain decision"
      recorded_mode=$(recorded_resolution_mode "$body" || true)
      closed_answer_replay_mode_compatible "$recorded_mode" "$body" \
        || fail "task $id records this resolution with mode ${recorded_mode:-unknown}; it is not a captain-answer replay"
      [ "$release" = 0 ] \
        || fail "task $id records this answer with mode ${recorded_mode:-unknown}; --release cannot reopen a closed task"
      remove_interrupted_answer_stamp "$id"
      call_reply_clear "$id"
      if [ "$recorded_mode" = repaired ]; then
        publish_parent_resolution_then_retire "$id" $((occurrence - 1)) "answered (repaired)"
      else
        publish_parent_resolution_then_retire "$id" $((occurrence - 1)) answered
      fi
      printf 'answered: %s\n' "$id"
      return 0
    fi
    [ "$release" = 0 ] || fail "task $id is already closed; --release cannot reopen it"
    # Closed outside this script: record the captain's answer retroactively.
    # tasks-axi keeps hold_kind through a close, so it is the surviving proof
    # this really was the captain's item rather than ordinary finished work.
    [ "$hold_kind" = captain ] \
      || fail "task $id was never held for the captain; nothing to record an answer on"
    write_resolution_record "$id" repaired "$body"
    remove_interrupted_answer_stamp "$id"
    task_show "$id" || fail "task $id disappeared while recording the answer"
    show=$TASK_SHOW_OUTPUT
    [ "$(show_field "$show" state)" = "done" ] || fail "recording the answer reopened closed task $id"
    body_has_resolution_record "$(show_field "$show" body)" \
      || fail "captain-held task $id did not retain its durable resolution record"
    call_reply_clear "$id"
    publish_parent_resolution_then_retire "$id" "$occurrence" "answered (repaired)"
    printf 'repaired: %s\n' "$id"
    return 0
  fi

  if [ "$hold_kind" = captain ]; then
    # Actively the captain's item (a date-expired hold keeps its annotations
    # and stays answerable). A matching record means an interrupted close to
    # finish; a different digest is a NEW answer on a re-held task and gets
    # its own record on top. Either way the close mode is the caller's flag,
    # checked against an interrupted close's recorded mode so a retry cannot
    # silently flip a release into a close.
    if body_has_resolution_record "$body" \
      && [ "$(recorded_decision_digest "$body" || true)" = "$DECISION_DIGEST" ]; then
      recorded_mode=$(recorded_resolution_mode "$body" || true)
      case "$recorded_mode" in
        released) [ "$release" = 1 ] || fail "task $id records this answer as a release; retry with --release" ;;
        answered|routed) [ "$release" = 0 ] || fail "task $id records this answer as a close; retry without --release" ;;
        *) fail "task $id records this resolution with mode ${recorded_mode:-unknown}; it is not a captain-answer replay" ;;
      esac
      if ! close_answered "$id" "$release"; then
        fail "could not close answered captain-held task $id"
      fi
      remove_interrupted_answer_stamp "$id"
      call_reply_clear "$id"
      publish_parent_resolution_then_retire "$id" $((occurrence - 1)) "$outcome"
      printf '%s: %s\n' "$outcome" "$id"
      return 0
    fi
    write_resolution_record "$id" "$outcome" "$body"
    call_reply_clear "$id"
    if ! close_answered "$id" "$release"; then
      fail "could not close answered captain-held task $id"
    fi
    remove_interrupted_answer_stamp "$id"
    task_show "$id" || fail "task $id disappeared after closing"
    show=$TASK_SHOW_OUTPUT
    body_has_resolution_record "$(show_field "$show" body)" \
      || fail "captain-held task $id did not retain its durable resolution record"
    call_reply_clear "$id"
    publish_parent_resolution_then_retire "$id" "$occurrence" "$outcome"
    printf '%s: %s\n' "$outcome" "$id"
    return 0
  fi

  # Not held and not closed: only an already-recorded release replays cleanly.
  if body_has_resolution_record "$body"; then
    recorded_mode=$(recorded_resolution_mode "$body" || true)
    [ "$(recorded_decision_digest "$body" || true)" = "$DECISION_DIGEST" ] \
      || fail "task $id records a different captain decision with mode ${recorded_mode:-unknown}"
    [ "$recorded_mode" = released ] && [ "$release" = 1 ] \
      || fail "task $id records this answer with mode ${recorded_mode:-unknown}; replay requires matching --release"
    remove_interrupted_answer_stamp "$id"
    call_reply_clear "$id"
    publish_parent_resolution_then_retire "$id" $((occurrence - 1)) released
    printf 'released: %s\n' "$id"
    return 0
  fi
  fail "task $id is not held for the captain; hold it first or name the right task"
}

# --- the call's content: offer, evidence, decide, list, migrate --------------

command_offer() {
  local id=${1:-} now show record
  [ "$#" -ge 1 ] || { usage >&2; exit 2; }
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --question|--option|--recommend|--on-answer)
        [ "$#" -ge 2 ] || { usage >&2; exit 2; }
        call_content_flag "$1" "$2"
        shift
        ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  validate_slug task-id "$id"
  [ "$CALL_CONTENT_GIVEN" = 1 ] || fail "offer needs --question, --option, --recommend, or --on-answer"
  call_content_validate
  require_jq
  now=$(call_now)
  acquire_task_control_lock "$id"
  require_tasks_axi
  task_show_or_fail "$id" "task $id is absent from this home's configured backlog (data directory $DATA)"
  [ "$(show_field "$show" state)" != "done" ] && [ "$(show_field_value "$show" hold_kind)" = captain ] \
    || fail "task $id is not an open captain call; offer changes only an open call's content"
  call_record_load "$id"
  if [ -z "$CALL_RECORD" ]; then
    record=$(call_record_compose "$id" "$now" "$(shown_call_raised_at "$show" "$now")" '' '') || exit 1
  else
    record=$(call_record_compose "$id" "$now" '' '' '') || exit 1
  fi
  # Offering is the first mate asking again, so a reply waiting on it is answered.
  record=$(printf '%s' "$record" | jq -c '.reply = null') || fail "cannot compose the call content for $id"
  call_record_store "$id" "$record"
  printf 'offered: %s\n' "$id"
}

REPLY_VIA_TOKENS='quarterdeck, review, chat'
command_reply() {
  local id=${1:-} words_file='' via='' message='' words now show state body hold_set answered_at raised_at record
  [ "$#" -ge 1 ] || { usage >&2; exit 2; }
  shift
  while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || { usage >&2; exit 2; }
    case "$1" in
      --words-file) words_file=$2 ;;
      --via) via=$2 ;;
      --message) message=$2 ;;
      *) usage >&2; exit 2 ;;
    esac
    shift 2
  done
  validate_slug task-id "$id"
  [ -n "$words_file" ] || fail "reply needs --words-file <path>: the captain's words"
  [ -f "$words_file" ] || fail "words file does not exist: $words_file"
  words=$(cat "$words_file")
  [ -n "$(printf '%s' "$words" | tr -d '[:space:]')" ] || fail "the reply has no words"
  [ "$(printf '%s' "$words" | LC_ALL=C wc -c | tr -d ' ')" -le 8192 ] \
    || fail "the reply is longer than 8192 bytes"
  case "$via" in
    quarterdeck|review|chat) : ;;
    *) fail "--via must be one of $REPLY_VIA_TOKENS: $via" ;;
  esac
  [ -z "$message" ] || validate_slug message "$message"
  require_jq
  now=$(call_now)
  acquire_task_control_lock "$id"
  require_tasks_axi
  task_show_or_fail "$id" "call $id is not in this home's backlog"
  state=$(show_field "$show" state)
  [ "$state" != "done" ] || fail "call $id is already closed"
  [ "$(show_field_value "$show" hold_kind)" = captain ] || fail "call $id is not waiting on the captain"
  body=$(decode_shown_value "$(show_field "$show" body)") || fail "could not read call $id"
  hold_set=$(body_hold_set_timestamp "$body")
  answered_at=$(newest_answered_at "$body")
  if [ -n "$answered_at" ] && { [ -z "$hold_set" ] || ! [[ "$answered_at" < "$hold_set" ]]; }; then
    fail "call $id already has a recorded answer"
  fi
  call_record_load "$id"
  if [ -z "$CALL_RECORD" ]; then
    # A reply never moves updated_at, so a record it creates dates from the call.
    raised_at=$(shown_call_raised_at "$show" "$now")
    record=$(call_record_compose "$id" "$raised_at" "$raised_at" '' '') || exit 1
  else
    record=$CALL_RECORD
  fi
  if printf '%s' "$record" | jq -e --arg words "$words" --arg via "$via" --arg message "$message" '
      .reply != null and .reply.words == $words and .reply.via == $via
      and .reply.message == (if $message == "" then null else $message end)' >/dev/null; then
    printf 'unchanged: %s\n' "$id"
    return 0
  fi
  if [ -n "$message" ] && printf '%s' "$record" | jq -e --arg words "$words" --arg via "$via" '
      .reply != null and .reply.words == $words and .reply.via == $via and .reply.message == null' >/dev/null; then
    record=$(printf '%s' "$record" | jq -c --arg message "$message" '.reply.message = $message') \
      || fail "cannot compose the call content for $id"
    call_record_store "$id" "$record"
    printf 'replied: %s\n' "$id"
    return 0
  fi
  if [ -n "$message" ] && printf '%s' "$record" | jq -e '.reply != null' >/dev/null; then
    printf 'unchanged: %s\n' "$id"
    return 0
  fi
  record=$(printf '%s' "$record" | jq -c --arg words "$words" --arg via "$via" --arg at "$now" \
    --arg message "$message" '
    .reply = {words:$words, via:$via, at:$at,
              message:(if $message == "" then null else $message end),
              previous:(if .reply == null then null else (.reply | del(.previous)) end)}') \
    || fail "cannot compose the call content for $id"
  call_record_store "$id" "$record"
  printf 'replied: %s\n' "$id"
}

# Replies still waiting on the first mate (see the header). Read-only and
# silent when nothing waits, because the wake drain runs it on every turn.
command_replies() {
  local older=0 now cutoff path id show
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --older-than)
        shift
        older=${1:-}
        case "$older" in ''|*[!0-9]*) fail "--older-than takes a whole number of minutes (got '$older')" ;; esac
        ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  [ -d "$CALLS_DIR" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  command -v tasks-axi >/dev/null 2>&1 || return 0
  now=$(call_now)
  cutoff=$(jq -nr --arg now "$now" --argjson older "$older" '($now | fromdateiso8601) - $older * 60') || return 0
  for path in "$CALLS_DIR"/*.json; do
    [ -f "$path" ] && [ ! -L "$path" ] || continue
    id=${path##*/}; id=${id%.json}
    task_id_path_safe "$id" || continue
    call_record_try_load "$id" || continue
    [ -n "$CALL_RECORD" ] || continue
    printf '%s' "$CALL_RECORD" | jq -e --argjson cutoff "$cutoff" '
      .reply != null and ((try (.reply.at | fromdateiso8601) catch null) // $cutoff) <= $cutoff' >/dev/null \
      || continue
    task_show "$id" || continue
    show=$TASK_SHOW_OUTPUT
    [ "$(show_field "$show" state)" != "done" ] || continue
    [ "$(show_field_value "$show" hold_kind)" = captain ] || continue
    printf '%s' "$CALL_RECORD" | jq -r --arg id "$id" '
      def clean: gsub("[[:cntrl:]]"; " ") | .[:200];
      [$id, (.reply.at | clean), ((.reply.via // "") | clean),
       ((.reply.words | split("\n") | map(select(test("[^[:space:]]"))) | .[0] // "") | clean)] | join("\t")'
  done
}

command_evidence() {
  local id=${1:-} action=${2:-} ref=${3:-} now show record
  [ "$#" -eq 3 ] || { usage >&2; exit 2; }
  validate_slug task-id "$id"
  case "$action" in
    add) evidence_ref_validate "$ref" 1 ;;
    remove) evidence_ref_validate "$ref" 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  require_jq
  now=$(call_now)
  acquire_task_control_lock "$id"
  require_tasks_axi
  task_show_or_fail "$id" "task $id is absent from this home's configured backlog (data directory $DATA)"
  shown_row_is_call "$show" || fail "task $id is not a captain call; evidence argues a call"
  call_record_load "$id"
  if [ -n "$CALL_RECORD" ] \
    && printf '%s' "$CALL_RECORD" | jq -e --arg ref "$ref" 'any(.evidence[]; . == $ref)' >/dev/null; then
    if [ "$action" = add ]; then
      printf 'unchanged: %s %s\n' "$id" "$ref"
      return 0
    fi
    record=$(printf '%s' "$CALL_RECORD" | jq -c --arg ref "$ref" \
      '.evidence |= map(select(. != $ref))') \
      || fail "cannot compose the call content for $id"
    call_record_store "$id" "$record"
    printf 'removed: %s %s\n' "$id" "$ref"
    return 0
  fi
  if [ "$action" = remove ]; then
    printf 'unchanged: %s %s\n' "$id" "$ref"
    return 0
  fi
  CALL_EVIDENCE=("$ref")
  if [ -z "$CALL_RECORD" ]; then
    record=$(call_record_compose "$id" "$now" "$(shown_call_raised_at "$show" "$now")" '' '') || exit 1
  else
    record=$(call_record_compose "$id" "$now" '' '' '') || exit 1
  fi
  call_record_store "$id" "$record"
  printf 'added: %s %s\n' "$id" "$ref"
}

# The durable decision a `decide` call records. Pure function of its inputs,
# so an exact retry carries the same digest.
decided_decision_text() {  # <task-id> <what> <why>
  printf 'Firstmate decided this call on the captain'"'"'s behalf.\n'
  printf 'Task: %s\n' "$1"
  printf 'Decided: %s\n' "$2"
  printf 'Why: %s\n' "$3"
}

command_decide() {
  local about='' title='' what='' why='' kind=other link='' what_set=0 why_set=0 pair id digest err
  local repo='' show state tmp record decided
  local -a hold_args=()
  while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || { usage >&2; exit 2; }
    case "$1" in
      --about) about=$2 ;;
      --title) title=$2 ;;
      --what) what=$2; what_set=1 ;;
      --why) why=$2; why_set=1 ;;
      --kind) kind=$2 ;;
      --link) link=$2 ;;
      --option) call_content_flag --option "$2" ;;
      *) usage >&2; exit 2 ;;
    esac
    shift 2
  done
  [ -n "$about" ] || fail "decide needs --about <task-id>: the task the decision concerns"
  validate_slug about "$about"
  [ -n "$title" ] || fail "decide needs --title <title>"
  validate_one_line title "$title"
  [ "$what_set" = 1 ] || fail "decide needs --what <what was decided>"
  [ "$why_set" = 1 ] || fail "decide needs --why <why it was decided>"
  validate_one_line what "$what"
  validate_one_line why "$why"
  case "$kind" in
    review-finding|merge|new-task|scope|other) : ;;
    *) fail "--kind must be one of review-finding, merge, new-task, scope, other (got '$kind')" ;;
  esac
  if [ -n "$link" ]; then
    case "$link" in
      http://?*|https://?*) : ;;
      *) fail "--link must be an http(s) URL (got '$link')" ;;
    esac
    case "$link" in *[[:space:]]*) fail "--link must be one word: $link" ;; esac
  fi
  require_jq
  err=$(jq -nr --arg what "$what" --arg why "$why" --arg title "$title" '
    if ($what | length) > 200 then "--what is longer than 200 characters"
    elif ($why | length) > 300 then "--why is longer than 300 characters"
    elif ($title | length) > 400 then "--title is longer than 400 characters"
    else empty end') || fail "cannot measure the decision"
  [ -z "$err" ] || fail "$err"
  call_content_validate
  require_tasks_axi
  if [ ! -f "$STATE/$about.meta" ] && [ ! -d "$DATA/$about" ] && ! task_show "$about"; then
    fail "unknown task '$about' (no state/$about.meta, data/$about/, or backlog row)"
  fi
  # The identity is the digest of every argument, so an exact retry names the
  # same row and a different decision can never land on an existing one.
  digest=$(sha256_text "$(printf '%s\n' "$about" "$title" "$what" "$why" "$kind" "$link" \
    "${CALL_OPTION_PAIRS[@]+"${CALL_OPTION_PAIRS[@]}"}")")
  id="decided-${digest:0:12}"
  decided=$(jq -nc --arg what "$what" --arg why "$why" --arg kind "$kind" --arg link "$link" \
    '{what:$what, why:$why, kind:$kind, link:(if $link == "" then null else $link end)}')
  if task_show "$id"; then
    show=$TASK_SHOW_OUTPUT
    state=$(show_field "$show" state)
    if [ "$state" = "done" ]; then
      body_has_resolution_record "$(show_field "$show" body)" \
        || fail "task $id is closed without a recorded decision"
      printf 'decided: %s\n' "$id"
      return 0
    fi
  fi
  if [ -f "$STATE/$about.meta" ]; then
    repo=$(meta_value "$STATE/$about.meta" project)
    repo=${repo%/}
    repo=${repo##*/}
  fi
  [ -n "$repo" ] || repo=firstmate
  hold_args=(--title "$title" --reason "decided by firstmate on the captain's behalf" --repo "$repo"
    --question "$title" --on-answer "done" --about "$about")
  for pair in "${CALL_OPTION_PAIRS[@]+"${CALL_OPTION_PAIRS[@]}"}"; do
    hold_args+=(--option "$pair")
  done
  "$0" hold "$id" "${hold_args[@]}" >/dev/null || fail "could not raise the decided call $id"
  acquire_task_control_lock "$id"
  call_record_load "$id"
  [ -n "$CALL_RECORD" ] || fail "the decided call $id lost its record"
  record=$(printf '%s' "$CALL_RECORD" | jq -c --argjson decided "$decided" \
    '.decided = $decided | .raised_by = "firstmate"') \
    || fail "cannot compose the call content for $id"
  call_record_store "$id" "$record"
  release_task_control_lock
  tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-captain-decided.XXXXXX") || fail "cannot stage the decision"
  if ! decided_decision_text "$id" "$what" "$why" > "$tmp"; then
    rm -f -- "$tmp"
    fail "cannot stage the decision for $id"
  fi
  if ! "$0" answer "$id" --decision-file "$tmp" --via decide --by firstmate --label "$what" >/dev/null; then
    rm -f -- "$tmp"
    fail "could not record the decided call $id"
  fi
  rm -f -- "$tmp"
  printf 'decided: %s\n' "$id"
}

# Every call record, one compact JSON line per file: {task, ok:true, record} or
# {task, ok:false, file}. One jq reads them all; when a file is not even JSON the
# whole read fails, and they are read again one at a time so only it is lost.
call_records_read() {
  local path lines
  local -a paths=()
  for path in "$CALLS_DIR"/*.json; do
    [ -f "$path" ] && [ ! -L "$path" ] && paths+=("$path")
  done
  [ "${#paths[@]}" -gt 0 ] || return 0
  # shellcheck disable=SC2016 # jq, not the shell, expands these variables.
  local filter="$CALL_VALID_JQ"'
    (input_filename) as $file
    | ($file | sub("^.*/"; "") | sub("\\.json$"; "")) as $id
    | if valid_call($id) then {task:$id, ok:true, record:.} else {task:$id, ok:false, file:$file} end'
  if lines=$(jq -c "$filter" "${paths[@]}" 2>/dev/null); then
    [ -z "$lines" ] || printf '%s\n' "$lines"
    return 0
  fi
  for path in "${paths[@]}"; do
    jq -c "$filter" "$path" 2>/dev/null \
      || jq -nc --arg file "$path" '{task:($file | sub("^.*/"; "") | sub("\\.json$"; "")), ok:false, file:$file}'
  done
}

command_list() {
  local json=0 since=7 backlog_file='' now work records origins origin dir name
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --json) json=1 ;;
      --since)
        shift
        since=${1:-}
        case "$since" in ''|*[!0-9]*) fail "--since takes a whole number of days (got '$since')" ;; esac
        ;;
      --backlog-json) shift; backlog_file=${1:-} ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  require_jq
  now=$(call_now)
  work=$(mktemp -d "${TMPDIR:-/tmp}/fm-captain-calls.XXXXXX") || fail "cannot stage the call listing"
  # shellcheck disable=SC2064 # expand now: the path is fixed for this run
  trap "rm -rf -- '$work'; captain_hold_cleanup" EXIT
  if [ -z "$backlog_file" ]; then
    backlog_file="$work/backlog.json"
    FM_SNAPSHOT_NOW="$now" "$SCRIPT_DIR/fm-fleet-snapshot.sh" --backlog-json > "$backlog_file" \
      || fail "cannot read this home's backlog"
  fi
  [ -f "$backlog_file" ] || fail "no backlog listing at $backlog_file"
  records=$(call_records_read)
  printf '%s\n' "$records" | jq -sc 'map(select(. != null))' > "$work/records.json" \
    || fail "cannot read the call records"
  # What each origin produced, found by globbing rather than by reading the
  # artifact store, so a listing costs no process per call.
  origins=$(jq -r '.[] | select(.ok) | .record.origin // empty' "$work/records.json" | LC_ALL=C sort -u)
  : > "$work/derived.tsv"
  while IFS= read -r origin; do
    [ -n "$origin" ] || continue
    task_id_path_safe "$origin" || continue
    [ ! -f "$DATA/$origin/report.md" ] || printf '%s\treport\t\n' "$origin" >> "$work/derived.tsv"
    for dir in "$DATA/$origin/artifacts"/*; do
      [ -d "$dir" ] || continue
      name=${dir##*/}
      page_name_valid "$name" || continue
      page_dir_presented "$dir" && printf '%s\tpage\t%s\n' "$origin" "$name" >> "$work/derived.tsv"
    done
  done <<EOF_ORIGINS
$origins
EOF_ORIGINS
  # shellcheck disable=SC2016 # jq, not the shell, expands these variables.
  jq -n \
    --slurpfile backlog "$backlog_file" \
    --slurpfile records "$work/records.json" \
    --rawfile derived "$work/derived.tsv" \
    --arg now "$now" --argjson days "$since" '
    def epoch($d):
      if ($d | type) != "string" then null
      elif ($d | test("T")) then try ($d | fromdateiso8601) catch null
      else try (($d + "T00:00:00Z") | fromdateiso8601) catch null end;
    def dedupe: reduce .[] as $e ([]; if any(.[]; . == $e) then . else . + [$e] end);
    def resolution_line: test("^Resolution recorded by fm-(captain|decision)-hold\\.$");
    # The newest resolution block'"'"'s machine lines: the fixed header lines
    # directly under its leader, up to its first line that is not one.
    def machine($lines):
      (first(range(0; $lines | length) as $i | select($lines[$i] | resolution_line) | $i) // null) as $at
      | if $at == null then null
        else reduce ($lines[($at + 1):][]) as $line ({open:true, m:{}};
            if .open | not then .
            else ([$line | capture("^(?<k>Decision digest|Resolution mode|Answer key|Answer label|Answered by|Answered via|Answered at): (?<v>.*)$")] | .[0]) as $c
              | if $c == null then .open = false else .m[$c.k] = $c.v end
            end)
          | .m end;
    ($derived | split("\n") | map(select(length > 0) | split("\t"))
      | reduce .[] as $row ({};
          if $row[1] == "report" then .[$row[0]].report = true
          else .[$row[0]].pages += [$row[2]] end)) as $made
    | ($records[0] | map(select(.ok)) | map({key:.task, value:.record}) | from_entries) as $by_task
    | ($now | epoch(.)) as $end
    | [ $backlog[0].records[]?
        | select(.structured == true and .id != null)
        | select(.hold_kind == "captain" or any(.body_lines[]?; resolution_line))
        | . as $row
        | ($by_task[$row.id] // null) as $rec
        | machine($row.body_lines // []) as $m
        | (if $row.state == "done" then "closed"
           elif $row.hold_kind == "captain" then
             (if $m != null and $m["Answered at"] != null
                 and ($row.hold_set == null or $m["Answered at"] >= $row.hold_set)
              then "answered" else "open" end)
           else "closed" end) as $state
        | (if $state != "open" and $m != null and $m["Answered by"] != null then
             {key:($m["Answer key"] // null), label:($m["Answer label"] // null),
              by:$m["Answered by"], via:($m["Answered via"] // null), at:($m["Answered at"] // null)}
           else null end) as $answer
        | (if $state != "closed" then null
           else ($answer.at // (if $row.state == "done" then ($row.done // $row.completion.date) else null end))
           end) as $closed_at
        | select($state != "closed"
            or ($closed_at != null and epoch($closed_at) != null and $end != null
                and epoch($closed_at) >= ($end - $days * 86400)))
        | ($rec.origin // null) as $origin
        | {id:$row.id,
           title:$row.title,
           question:(if (($rec.question // "") != "") then $rec.question else $row.hold_reason end),
           options:($rec.options // []),
           on_answer:($rec.on_answer // (if $row.kind == "captain" then "done" else "release" end)),
           state:$state,
           bucket:($row.hold_bucket // null),
           captain_actionable:($row.captain_actionable // false),
           origin:$origin,
           about:($rec.about // null),
           evidence:((($rec.evidence // [])
             + (if $origin == null then []
                else ((if $made[$origin].report then ["report:" + $origin] else [] end)
                      + (($made[$origin].pages // []) | sort | map("page:task/" + $origin + "/" + .)))
                end)) | dedupe),
           raised_by:($rec.raised_by // null),
           raised_at:($rec.raised_at // $row.hold_set // $row.since),
           updated_at:($rec.updated_at // null),
           answer:$answer,
           decided:($rec.decided // null),
           reply:(if $state == "open" then ($rec.reply // null) else null end)}
      ] as $calls
    | {schema:"fm-call-list.v1", calls:$calls,
       damaged:($records[0] | map(select(.ok | not) | {task, file}))}' > "$work/list.json" \
    || fail "cannot list the calls"
  if [ "$json" = 1 ]; then
    cat "$work/list.json"
    return 0
  fi
  jq -r '
    (.calls[] |
      "\(.id)  \(.state)\(if .bucket then "  " + .bucket else "" end)  \(.question // .title)",
      (.options[] | "  \(.key)  \(.label)\(if .recommended then "  (recommended)" else "" end)"),
      (.evidence[] | "  evidence: \(.)"),
      (if .answer then "  answer: \(.answer.key // "-")  \(.answer.label // "")  (by \(.answer.by) via \(.answer.via // "-"))" else empty end),
      (if .reply then "  reply: \(.reply.at) via \(.reply.via)  \(.reply.words | split("\n") | .[0])" else empty end)),
    (.damaged[] | "damaged: \(.task) \(.file)"),
    "calls: \(.calls | length)"' "$work/list.json"
}

# The one place any recorded prose is read. `migrate` gives a resolution block
# written before the machine lines existed the lines a current answer carries,
# so surfaces that read only machine lines keep the answers already on record.
# It prints the new body and a summary line, or nothing when the newest block
# already carries them, is a reconciliation, or has no captain decision.
# shellcheck disable=SC2016 # jq, not the shell, expands these variables.
BACKFILL_JQ='
  def trim: gsub("^[[:space:]]+|[[:space:]]+$"; "");
  def header_line: test("^(Decision digest|Resolution mode|Answer key|Answer label|Answered by|Answered via|Answered at): ");
  ($body | split("\n")) as $l
  | (first(range(0; $l | length) as $i
      | select($l[$i] | test("^Resolution recorded by fm-(captain|decision)-hold\\.$")) | $i) // null) as $s
  | select($s != null)
  | (first(range($s + 1; $l | length) as $i | select($l[$i] | test("^[[:space:]]*$")) | $i) // ($l | length)) as $e
  | ($l[($s + 1):$e]) as $header
  | select(any($header[]; . == "Resolution mode: reconciled") | not)
  | ($header | any(startswith("Answered by:"))) as $answered
  | (first(range($s + 1; $e) as $i | select($l[$i] | header_line | not) | $i) // $e) as $insert
  | (first(range($e; $l | length) as $i | select($l[$i] == "Captain decision:") | $i) // null) as $d
  | select($d != null)
  | ([$l[($d + 1):][] | select(test("[^[:space:]]"))] | .[0] // "" | trim) as $first
  | select($first != "")
  | if ($first | test("^Captain answered this (call|decision) through .*\\.$")) then
      # The keyed intake wrote this block, in its own fixed format.
      ([$l[($d + 2):][]] | (first(range(0; length) as $j | select(.[$j] | test("^[[:space:]]*$")) | $j) // length) as $n
        | .[:$n]) as $keyed
      | ([$keyed[] | capture("^Answer: (?<v>.*)$") | .v] | .[0] // "") as $value
      | ([$keyed[] | capture("^Answer as shown to the captain: (?<v>.*)$") | .v] | .[0] // "") as $shown
      | {label:(if $shown != "" then $shown else $value end),
         keys:([$options[] | select(.key == $value) | .key]
               + [$options[] | select($shown != "" and .label == $shown) | .key] | unique)}
    else
      {label:$first,
       keys:([$options[] | . as $o
               | select(($first == $o.label)
                   or (($first | startswith($o.key))
                       and ($first[($o.key | length):] | test("^(:| =|=|[[:space:]]+-)"))))
               | .key] | unique)}
    end
  | (.label | gsub("[[:cntrl:]]"; " ") | trim | .[:200]) as $prose_label
  | (if (.keys | length) == 1 then .keys[0] else null end) as $key
  | (if $key == null then $prose_label
     else first($options[] | select(.key == $key) | .label) end) as $label
  | if $answered | not then
      (if $key != null then ["Answer key: " + $key] else [] end
       + ["Answer label: " + $label]
       + ["Answered by: captain", "Answered via: other"]
       + (if ($closed | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}")) then ["Answered at: " + $closed] else [] end)) as $lines
      | "key=\($key // "-")",
        ($l[:$insert] + $lines + $l[$insert:] | join("\n"))
    else
      # A block an earlier migrate backfilled with the prose line as its label
      # although it recovered a key: give it the option'"'"'s own label.
      select($key != null and $label != $prose_label
        and any($header[]; . == "Answered via: other")
        and any($header[]; . == "Answer key: " + $key)
        and any($header[]; . == "Answer label: " + $prose_label))
      | "relabeled key=\($key)",
        ($l | to_entries | map(if .key > $s and .key < $e and .value == "Answer label: " + $prose_label
                               then "Answer label: " + $label else .value end) | join("\n"))
    end'

# Backfill one call's newest resolution block; prints the summary on success
# and returns 3 when there is nothing to backfill.
migrate_answer_lines() {  # <task-id>
  local id=$1 show body options closed out summary tmp
  task_show "$id" || return 3
  show=$TASK_SHOW_OUTPUT
  shown_row_is_call "$show" || return 3
  body=$(decode_shown_value "$(show_field "$show" body)") || fail "could not decode the body of $id"
  options='[]'
  if call_record_try_load "$id" && [ -n "$CALL_RECORD" ]; then
    options=$(printf '%s' "$CALL_RECORD" | jq -c '.options')
  fi
  closed=$(show_field_value "$show" closed)
  out=$(jq -nr --arg body "$body" --argjson options "$options" --arg closed "$closed" "$BACKFILL_JQ") \
    || fail "cannot read the resolution block of $id"
  [ -n "$out" ] || return 3
  summary=${out%%$'\n'*}
  tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-captain-backfill.XXXXXX") || fail "cannot stage the answer lines for $id"
  if ! printf '%s\n' "${out#*$'\n'}" > "$tmp" || ! tasks_axi update "$id" --body-file "$tmp" >/dev/null; then
    rm -f -- "$tmp"
    fail "could not record the answer lines on $id"
  fi
  rm -f -- "$tmp"
  printf '%s\n' "$summary"
}

# One-time import of the stores this record replaced. Idempotent: an option set
# lands only on a call with no options yet, and evidence is never duplicated.
command_migrate() {
  local path task imported=0 attached=0 answered=0 relabeled=0 skipped=0 unchanged=0 old record now ref rows show backlog summary rc
  [ "$#" -eq 0 ] || { usage >&2; exit 2; }
  require_jq
  require_tasks_axi
  now=$(call_now)
  for path in "$STATE/decision-options"/*.json; do
    [ -f "$path" ] && [ ! -L "$path" ] || continue
    task=${path##*/}
    task=${task%.json}
    if ! task_id_path_safe "$task"; then
      printf 'skipped: %s (not a task id)\n' "$task"
      skipped=$((skipped + 1))
      continue
    fi
    old=$(jq -c --arg task "$task" '
      select(.schema == "fm-decision-options.v1" and .task == $task
        and (.options | type) == "array" and (.options | length) >= 2)
      | {question:(.question // ""), set_at:(.set_at // null),
         options:[.options[] | {key, label, recommended:(.recommended == true)}]}' "$path" 2>/dev/null)
    if [ -z "$old" ]; then
      printf 'skipped: %s (damaged decision-options record)\n' "$task"
      skipped=$((skipped + 1))
      continue
    fi
    acquire_task_control_lock "$task"
    if ! task_show "$task" || ! shown_row_is_call "$TASK_SHOW_OUTPUT"; then
      printf 'skipped: %s (not a captain call)\n' "$task"
      skipped=$((skipped + 1))
      release_task_control_lock
      continue
    fi
    show=$TASK_SHOW_OUTPUT
    call_record_load "$task"
    if [ -n "$CALL_RECORD" ] && [ "$(printf '%s' "$CALL_RECORD" | jq '.options | length')" -gt 0 ]; then
      printf 'unchanged: %s options\n' "$task"
      unchanged=$((unchanged + 1))
      release_task_control_lock
      continue
    fi
    if [ -z "$CALL_RECORD" ]; then
      CALL_RECORD=$(call_record_compose "$task" "$now" "$(shown_call_raised_at "$show" "$now")" '' '') || exit 1
    fi
    record=$(printf '%s' "$CALL_RECORD" | jq -c --argjson old "$old" --arg now "$now" '
      .options = $old.options
      | (if .question == "" then .question = $old.question else . end)
      | .updated_at = $now') || fail "cannot compose the call content for $task"
    call_record_store "$task" "$record"
    printf 'imported: %s options\n' "$task"
    imported=$((imported + 1))
    release_task_control_lock
  done
  rows=$(FM_DATA_OVERRIDE="$DATA" "$SCRIPT_DIR/fm-artifact.sh" list --json | jq -r '
    .artifacts[].revisions[]
    | select((.covers | type) == "array")
    | (if .scope == "chat" then "page:chat/\(.name)" else "page:task/\(.task)/\(.name)" end) as $ref
    | .covers[] | select(type == "string") | [., $ref] | @tsv' | LC_ALL=C sort -u) \
    || fail "cannot read the artifact store"
  while IFS=$'\t' read -r task ref; do
    [ -n "$task" ] || continue
    if ! task_id_path_safe "$task"; then
      printf 'skipped: %s (not a task id)\n' "$task"
      skipped=$((skipped + 1))
      continue
    fi
    acquire_task_control_lock "$task"
    if ! task_show "$task" || ! shown_row_is_call "$TASK_SHOW_OUTPUT"; then
      printf 'skipped: %s %s (not a captain call)\n' "$task" "$ref"
      skipped=$((skipped + 1))
      release_task_control_lock
      continue
    fi
    show=$TASK_SHOW_OUTPUT
    call_record_load "$task"
    if [ -n "$CALL_RECORD" ] \
      && printf '%s' "$CALL_RECORD" | jq -e --arg ref "$ref" 'any(.evidence[]; . == $ref)' >/dev/null; then
      printf 'unchanged: %s %s\n' "$task" "$ref"
      unchanged=$((unchanged + 1))
      release_task_control_lock
      continue
    fi
    CALL_EVIDENCE=("$ref")
    if [ -z "$CALL_RECORD" ]; then
      record=$(call_record_compose "$task" "$now" "$(shown_call_raised_at "$show" "$now")" '' '') || exit 1
    else
      record=$(call_record_compose "$task" "$now" '' '' '') || exit 1
    fi
    CALL_EVIDENCE=()
    call_record_store "$task" "$record"
    printf 'attached: %s %s\n' "$task" "$ref"
    attached=$((attached + 1))
    release_task_control_lock
  done <<EOF_ROWS
$rows
EOF_ROWS
  # Answers recorded before the machine lines existed: every call row whose
  # newest resolution block lacks them, found in the snapshot's own parse.
  backlog=$(FM_SNAPSHOT_NOW="$now" "$SCRIPT_DIR/fm-fleet-snapshot.sh" --backlog-json) \
    || fail "cannot read this home's backlog"
  rows=$(printf '%s' "$backlog" | jq -r '
    .records[]? | select(.structured == true and .id != null)
    | . as $row
    | ($row.body_lines // []) as $l
    | (first(range(0; $l | length) as $i
        | select($l[$i] | test("^Resolution recorded by fm-(captain|decision)-hold\\.$")) | $i) // null) as $s
    | select($s != null)
    | select([$l[($s + 1):][] | select(test("^(Decision digest|Resolution mode|Answer key|Answer label|Answered by|Answered via|Answered at): "))]
        | (any(startswith("Answered by:")) | not)
          or (any(. == "Answered via: other") and any(startswith("Answer key: "))))
    | $row.id') || fail "cannot read this home's backlog"
  while IFS= read -r task; do
    [ -n "$task" ] || continue
    task_id_path_safe "$task" || continue
    acquire_task_control_lock "$task"
    rc=0
    summary=$(migrate_answer_lines "$task") || rc=$?
    case "$rc" in
      0)
        case "$summary" in
          relabeled*)
            printf 'relabeled: %s %s\n' "$task" "${summary#relabeled }"
            relabeled=$((relabeled + 1))
            ;;
          *)
            printf 'answered: %s %s\n' "$task" "$summary"
            answered=$((answered + 1))
            ;;
        esac
        ;;
      3) : ;;
      *) exit "$rc" ;;
    esac
    release_task_control_lock
  done <<EOF_ANSWERED
$rows
EOF_ANSWERED
  printf 'migrate: imported=%s attached=%s answered=%s relabeled=%s unchanged=%s skipped=%s\n' \
    "$imported" "$attached" "$answered" "$relabeled" "$unchanged" "$skipped"
}

# --- the one keyed-answer intake, and the source bindings that feed it --------

BINDING_DIR="$STATE/decision-bindings"
BINDING_SCHEMA=fm-decision-binding.v1

validate_source_id() {  # <source-id>
  validate_slug source-id "$1"
  [ "${#1}" -le 64 ] || fail "source-id must be at most 64 characters: $1"
}

binding_path() { printf '%s/%s.origin\n' "$BINDING_DIR" "$1"; }

# The stored binding value, or empty when the source is unbound. An unreadable
# or wrong-schema record is a hard error rather than a silent "unbound":
# feeding nothing is the safe direction only when it is a deliberate choice,
# never when it is a corrupted record.
read_binding() {  # <source-id>
  local path origin schema
  path=$(binding_path "$1")
  [ -e "$path" ] || return 0
  [ -f "$path" ] && [ ! -L "$path" ] || fail "decision binding is unsafe: $path"
  schema=$(sed -n 's/^schema=//p' "$path" | head -1)
  [ "$schema" = "$BINDING_SCHEMA" ] || fail "decision binding has an incompatible schema: $path"
  origin=$(sed -n 's/^origin=//p' "$path" | head -1)
  if [ "$origin" != "$BINDING_ANY" ]; then
    case "$origin" in
      ''|*[!A-Za-z0-9._-]*) fail "decision binding has an invalid origin id: $path" ;;
    esac
  fi
  printf '%s\n' "$origin"
}

command_bind() {
  local source=${1:-} origin=${2:-} dest tmp
  [ "$#" -ge 1 ] && [ "$#" -le 2 ] || { usage >&2; exit 2; }
  validate_source_id "$source"
  if [ -z "$origin" ] || [ "$origin" = --any-origin ]; then
    origin=$BINDING_ANY
  else
    validate_slug legacy-origin "$origin"
  fi
  (umask 077; mkdir -p "$BINDING_DIR") || fail "cannot create $BINDING_DIR"
  [ -d "$BINDING_DIR" ] && [ ! -L "$BINDING_DIR" ] || fail "decision binding dir is unsafe: $BINDING_DIR"
  dest=$(binding_path "$source")
  tmp=$(umask 077; mktemp "$BINDING_DIR/.origin.XXXXXX") || fail "cannot stage the decision binding"
  if ! { printf 'schema=%s\norigin=%s\n' "$BINDING_SCHEMA" "$origin" > "$tmp" \
    && chmod 0600 "$tmp" && mv -f -- "$tmp" "$dest"; }; then
    rm -f -- "$tmp"
    fail "cannot record the decision binding for $source"
  fi
  printf 'bound: %s -> %s\n' "$source" "$origin"
}

command_unbind() {
  local source=${1:-}
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  validate_source_id "$source"
  rm -f -- "$(binding_path "$source")"
  printf 'unbound: %s\n' "$source"
}

command_binding() {
  local source=${1:-} origin
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  validate_source_id "$source"
  origin=$(read_binding "$source") || exit 1
  [ -n "$origin" ] || return 1
  printf '%s\n' "$origin"
}

# The durable captain decision one keyed answer records. Pure function of its
# inputs, so the same answer delivered twice is idempotent rather than a
# conflicting decision.
keyed_decision_text() {  # <source> <task-id> <answer> <label>
  printf 'Captain answered this call through %s.\n' "$1"
  printf 'Task: %s\n' "$2"
  printf 'Answer: %s\n' "$3"
  [ -z "$4" ] || printf 'Answer as shown to the captain: %s\n' "$4"
}

legacy_keyed_decision_text() {  # <source> <key> <answer> <label>
  printf 'Captain answered this decision through %s.\n' "$1"
  printf 'Decision key: %s\n' "$2"
  printf 'Answer: %s\n' "$3"
  [ -z "$4" ] || printf 'Answer as shown to the captain: %s\n' "$4"
}

sanitize_field() {  # <text>
  printf '%s' "$1" | tr '\n\r\t' '   ' | LC_ALL=C tr -d '\000-\037\177' | cut -c1-512
}

sanitize_reconcile_provenance() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | LC_ALL=C tr -d '\000-\037\177' | cut -c1-1024
}

command_answers() {
  local origin='' source='' row rest key answer label mode id show state hold_kind body digest legacy_digest legacy_key
  local recorded_digest recorded_mode occurrence tmp err closed=0 skipped=0 reason release_flag tab=$'\t'
  local resolve_rc declared option_keys via=''
  local -a answer_args
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --source) shift; source=${1:-} ;;
      --via) shift; via=${1:-}; [ -n "$via" ] || fail "--via must be one of $VIA_TOKENS" ;;
      --any-origin) origin=$BINDING_ANY ;;
      --*) usage >&2; exit 2 ;;
      *)
        [ -z "$origin" ] || { usage >&2; exit 2; }
        origin=$1
        ;;
    esac
    shift
  done
  if [ -n "$origin" ] && [ "$origin" != "$BINDING_ANY" ]; then
    validate_slug legacy-origin "$origin"
  fi
  [ -n "$source" ] || fail "--source provenance is required so the durable decision records where the answer came from"
  source=$(sanitize_field "$source")
  if [ -z "$via" ]; then
    if [ "$source" = quarterdeck ]; then via=quarterdeck; else via=other; fi
  fi
  via_token_valid "$via" || fail "--via must be one of $VIA_TOKENS: $via"
  require_tasks_axi
  tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-keyed-decision.XXXXXX") || fail "cannot stage the captain decision"
  err=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-keyed-decision-err.XXXXXX") \
    || { rm -f -- "$tmp"; fail "cannot stage the captain decision diagnostics"; }
  while IFS= read -r row; do
    key=${row%%"$tab"*}
    rest=''
    case "$row" in *"$tab"*) rest=${row#*"$tab"} ;; esac
    answer=${rest%%"$tab"*}
    case "$rest" in *"$tab"*) rest=${rest#*"$tab"} ;; *) rest='' ;; esac
    label=${rest%%"$tab"*}
    case "$rest" in *"$tab"*) mode=${rest#*"$tab"} ;; *) mode='' ;; esac
    [ -n "${key:-}" ] || continue
    case "$key" in *[!A-Za-z0-9._-]*) continue ;; esac
    [ "${#key}" -le 128 ] || continue
    answer=$(sanitize_field "${answer:-}")
    [ -n "$answer" ] || continue
    label=$(sanitize_field "${label:-}")
    if [ "$answer" = "$RECONCILE_VALUE" ]; then
      printf 'refused: %s (reconcile requests require a bound captured source)\n' "$key"
      skipped=$((skipped + 1))
      continue
    fi
    release_flag=''
    case "${mode:-}" in
      ''|done) : ;;
      release) release_flag=--release ;;
      *)
        printf 'skipped: %s (unknown close mode %s)\n' "$key" "$(sanitize_field "$mode")"
        skipped=$((skipped + 1))
        continue
        ;;
    esac
    resolve_rc=0
    id=$(resolve_entry "$origin" "$key" 2>"$err") || resolve_rc=$?
    id=${id%% *}
    if [ "$resolve_rc" = 2 ]; then
      reason=$(tr -d '\n' < "$err")
      printf 'skipped: %s (migrated-hold scan refused%s)\n' "$key" "${reason:+: $reason}"
      skipped=$((skipped + 1))
      continue
    fi
    if [ "$resolve_rc" -ne 0 ]; then
      # resolve_entry runs in a command substitution, so task_show's exit
      # cannot stop this loop; only its status crosses back. 124 means the
      # backend never answered, which is not the same as an unknown key and
      # must not be spent as a skip.
      [ "$resolve_rc" -ne 124 ] \
        || fail "the backlog backend exceeded its read bound resolving $key"
      printf 'skipped: %s (no captain-held task with that id)\n' "$key"
      skipped=$((skipped + 1))
      continue
    fi
    # A call that declares how an answer closes it closes that way: an empty
    # mode column takes the declaration, and a disagreeing one is skipped.
    # The answer names an option when it is one of the recorded keys.
    declared=''
    option_keys=''
    if call_record_try_load "$id" && [ -n "$CALL_RECORD" ]; then
      declared=$(printf '%s' "$CALL_RECORD" | jq -r '.on_answer // empty')
      option_keys=$(printf '%s' "$CALL_RECORD" | jq -r '.options[].key')
    fi
    if [ -n "$declared" ]; then
      if [ -z "$mode" ]; then
        [ "$declared" != release ] || release_flag=--release
      elif [ "$mode" != "$declared" ]; then
        printf 'skipped: %s (close mode %s disagrees with the call'"'"'s declared on_answer %s)\n' \
          "$id" "$mode" "$declared"
        skipped=$((skipped + 1))
        continue
      fi
    fi
    answer_args=(--via "$via")
    if [ -n "$option_keys" ] && list_has_line "$option_keys" "$answer"; then
      answer_args+=(--key "$answer")
      [ -z "$label" ] || answer_args+=(--label "$label")
    else
      answer_args+=(--label "${label:-$answer}")
    fi
    keyed_decision_text "$source" "$id" "$answer" "$label" > "$tmp" \
      || fail "cannot stage the captain decision for $id"
    digest=$(sha256_text "$(cat "$tmp")")
    legacy_digest=''
    if [ "$id" != "$key" ]; then
      legacy_key=$key
    elif { [ -z "$origin" ] || [ "$origin" = "$BINDING_ANY" ]; } \
      && [ "${id#*-decision-}" != "$id" ]; then
      legacy_key=${id#*-decision-}
    else
      legacy_key=''
    fi
    if [ -n "$legacy_key" ]; then
      legacy_digest=$(sha256_text "$(legacy_keyed_decision_text "$source" "$legacy_key" "$answer" "$label")")
    fi
    task_show "$id" || { printf 'skipped: %s (absent)\n' "$id"; skipped=$((skipped + 1)); continue; }
    show=$TASK_SHOW_OUTPUT
    state=$(show_field "$show" state)
    hold_kind=$(show_field_value "$show" hold_kind)
    body=$(show_field "$show" body)
    recorded_digest=$(recorded_decision_digest "$body" || true)
    recorded_mode=$(recorded_resolution_mode "$body" || true)
    if body_has_resolution_record "$body" \
      && { [ "$recorded_digest" = "$digest" ] \
        || { case "$body" in *"Resolution recorded by fm-decision-hold."*) true ;; *) false ;; esac \
          && [ -n "$legacy_digest" ] && [ "$recorded_digest" = "$legacy_digest" ]; }; }; then
      if { [ -z "$release_flag" ] && [ "$state" = "done" ] \
          && closed_answer_replay_mode_compatible "$recorded_mode" "$body"; } \
        || { [ "$release_flag" = --release ] && [ "$state" != "done" ] \
          && [ "$hold_kind" != captain ] && [ "$recorded_mode" = released ]; }; then
        occurrence=$(resolution_record_count "$body")
        case "$recorded_mode" in
          repaired) publish_parent_resolution_then_retire "$id" "$occurrence" "answered (repaired)" ;;
          released) publish_parent_resolution_then_retire "$id" "$occurrence" released ;;
          *) publish_parent_resolution_then_retire "$id" "$occurrence" answered ;;
        esac
        printf 'closed: %s\n' "$id"
        closed=$((closed + 1))
        continue
      fi
    fi
    if [ "$state" = "done" ]; then
      printf 'skipped: %s (already closed)\n' "$id"
      skipped=$((skipped + 1))
      continue
    fi
    if [ "$hold_kind" != captain ]; then
      printf 'skipped: %s (not held for the captain)\n' "$id"
      skipped=$((skipped + 1))
      continue
    fi
    # shellcheck disable=SC2086  # release_flag is empty or a single literal flag.
    if "$0" answer "$id" --decision-file "$tmp" $release_flag "${answer_args[@]}" </dev/null >/dev/null 2>"$err"; then
      # A parent-channel delivery problem is reported on stderr by the answer
      # path even when the close succeeded; keep it visible.
      [ ! -s "$err" ] || cat "$err" >&2
      printf 'closed: %s\n' "$id"
      closed=$((closed + 1))
    else
      reason=$(tr -d '\n' < "$err" | sed 's/^fm-captain-hold: //')
      printf 'skipped: %s (%s)\n' "$id" "$reason"
      skipped=$((skipped + 1))
    fi
  done
  rm -f -- "$tmp" "$err"
  printf 'answers: closed=%s skipped=%s\n' "$closed" "$skipped"
  [ "$skipped" -eq 0 ]
}

# --- reconcile: verify latest state, then close with evidence or annotate ----
#
# The semantics are owned by docs/captain-hold-lifecycle.md; this section owns
# the durable record and the two terminal operations that retire it. Nothing
# here closes a captain call on the strength of a reconcile alone: `close`
# demands the evidence that made the call moot, and `note` leaves it open.

RECONCILE_DIR="$STATE/reconcile-requests"
RECONCILE_SCHEMA=fm-reconcile-request.v1
RECONCILE_VALUE=reconcile

reconcile_request_path() { printf '%s/%s.request\n' "$RECONCILE_DIR" "$1"; }

# Idempotent per task: a repeated reconcile keeps the one request and its
# original timestamp, so a re-delivered board answer never resets the clock on
# an obligation that is already open.
reconcile_request_record() {  # <task-id> <provenance>
  local id=$1 source=$2 path tmp
  path=$(reconcile_request_path "$id")
  [ ! -e "$path" ] || return 0
  (umask 077; mkdir -p "$RECONCILE_DIR") || return 1
  [ -d "$RECONCILE_DIR" ] && [ ! -L "$RECONCILE_DIR" ] || return 1
  tmp=$(umask 077; mktemp "$RECONCILE_DIR/.request.XXXXXX") || return 1
  if {
    printf 'schema=%s\n' "$RECONCILE_SCHEMA"
    printf 'task=%s\n' "$id"
    printf 'requested=%s\n' "${FM_CAPTAIN_HOLD_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
    printf 'source=%s\n' "$(sanitize_reconcile_provenance "$source")"
  } > "$tmp" && chmod 0600 "$tmp" && mv -f -- "$tmp" "$path"; then
    return 0
  fi
  rm -f -- "$tmp"
  return 1
}

reconcile_request_read() {  # <task-id>; sets RECONCILE_REQUESTED/RECONCILE_SOURCE
  local id=$1 path schema task
  path=$(reconcile_request_path "$id")
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  schema=$(sed -n 's/^schema=//p' "$path" | head -1)
  [ "$schema" = "$RECONCILE_SCHEMA" ] || fail "reconcile request has an incompatible schema: $path"
  task=$(sed -n 's/^task=//p' "$path" | head -1)
  [ "$task" = "$id" ] || fail "reconcile request names a different task: $path"
  RECONCILE_REQUESTED=$(sed -n 's/^requested=//p' "$path" | head -1)
  RECONCILE_SOURCE=$(sed -n 's/^source=//p' "$path" | head -1)
}

reconcile_request_retire() {  # <task-id>
  rm -f -- "$(reconcile_request_path "$1")" \
    || fail "could not retire the pending reconcile request for $1"
}

publish_parent_resolution_then_retire() {  # <task-id> <occurrence> <note>
  local id=$1 occurrence=$2 note=$3 request
  request=$(reconcile_request_path "$id")
  publish_parent_hold "$id" "$occurrence" resolved "$note"
  if [ -e "$request" ] && [ "$PARENT_HOLD_PUBLISHED" != 1 ]; then
    fail "could not publish the answered captain-held task $id to its parent"
  fi
  reconcile_request_retire "$id"
}

command_reconcile_requests() {
  local source_id='' source='' origin row id note provenance show show_status=0 created=0 skipped=0 tab=$'\t'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --source-id) shift; source_id=${1:-} ;;
      --source) shift; source=${1:-} ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  validate_source_id "$source_id"
  [ -n "$source" ] || fail "--source provenance is required"
  origin=$(read_binding "$source_id") || fail "cannot verify the binding for source $source_id"
  [ -n "$origin" ] || fail "source $source_id is not bound; no reconcile requests were created"
  require_tasks_axi
  while IFS= read -r row; do
    id=${row%%"$tab"*}
    note=''
    case "$row" in *"$tab"*) note=${row#*"$tab"} ;; esac
    [ -n "$id" ] || continue
    case "$id" in
      *[!A-Za-z0-9._-]*) printf 'refused: %s (invalid task id)\n' "$id"; skipped=$((skipped + 1)); continue ;;
    esac
    [ "${#id}" -le 128 ] \
      || { printf 'refused: %s (task id is too long)\n' "$id"; skipped=$((skipped + 1)); continue; }
    acquire_task_control_lock "$id"
    show_status=0
    show=''
    task_show "$id" || show_status=$?
    [ "$show_status" -ne 0 ] || show=$TASK_SHOW_OUTPUT
    if [ "$show_status" -eq 124 ]; then
      fail "the backlog backend exceeded its read bound reading $id"
    fi
    if [ -z "$show" ]; then
      printf 'refused: %s (absent)\n' "$id"
      skipped=$((skipped + 1))
    elif [ "$(show_field "$show" state)" = "done" ]; then
      printf 'refused: %s (already closed)\n' "$id"
      skipped=$((skipped + 1))
    elif [ "$(show_field_value "$show" hold_kind)" != captain ]; then
      printf 'refused: %s (not held for the captain)\n' "$id"
      skipped=$((skipped + 1))
    else
      provenance=$source
      [ -z "$note" ] || provenance="$source; captain note: $(sanitize_field "$note")"
      if reconcile_request_record "$id" "$provenance"; then
        printf 'reconcile: %s\n' "$id"
        created=$((created + 1))
      else
        printf 'refused: %s (cannot record the reconcile request)\n' "$id"
        skipped=$((skipped + 1))
      fi
    fi
    release_task_control_lock || fail "cannot release task control for $id"
  done
  printf 'reconcile-requests: created=%s skipped=%s\n' "$created" "$skipped"
  [ "$skipped" -eq 0 ]
}

command_reconcile() {
  local action=${1:-}
  [ "$#" -ge 1 ] || { usage >&2; exit 2; }
  shift
  case "$action" in
    list)    reconcile_list "$@" ;;
    close)   reconcile_close "$@" ;;
    note)    reconcile_note "$@" ;;
    *) usage >&2; exit 2 ;;
  esac
}

reconcile_list() {
  local path id count=0
  [ "$#" -eq 0 ] || { usage >&2; exit 2; }
  [ -d "$RECONCILE_DIR" ] || { printf 'reconcile-requests: 0\n'; return 0; }
  for path in "$RECONCILE_DIR"/*.request; do
    [ -e "$path" ] || continue
    id=${path##*/}; id=${id%.request}
    RECONCILE_REQUESTED=''
    RECONCILE_SOURCE=''
    reconcile_request_read "$id" || continue
    printf '%s\trequested=%s\tsource=%s\n' "$id" "$RECONCILE_REQUESTED" "$RECONCILE_SOURCE"
    count=$((count + 1))
  done
  printf 'reconcile-requests: %s\n' "$count"
}

# The moot outcome. The evidence is what closes the call, and the `reconciled`
# resolution mode is what keeps the record from claiming the captain answered.
reconcile_close() {
  local id=${1:-} evidence_file='' show state hold_kind body occurrence recorded_mode
  [ "$#" -ge 1 ] || { usage >&2; exit 2; }
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --evidence-file) shift; evidence_file=${1:-} ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  validate_slug task-id "$id"
  [ -n "$evidence_file" ] || fail "--evidence-file is required; a moot call closes on evidence, never on assertion"
  load_decision "$evidence_file"
  acquire_task_control_lock "$id"
  reconcile_request_read "$id" \
    || fail "task $id has no pending board-created reconcile request"
  require_tasks_axi
  task_show_or_fail "$id" "captain-held task $id is absent from this home's configured backlog (data directory $DATA)"
  state=$(show_field "$show" state)
  hold_kind=$(show_field_value "$show" hold_kind)
  body=$(show_field "$show" body)
  occurrence=$(( $(resolution_record_count "$body") + 1 ))
  if [ "$state" = "done" ]; then
    # An exact retry finishes an interrupted close and stays idempotent; a
    # different evidence text on an already closed call is refused.
    body_has_resolution_record "$body" \
      || fail "task $id is already closed with no resolution record; use answer to record what closed it"
    [ "$(recorded_decision_digest "$body" || true)" = "$DECISION_DIGEST" ] \
      || fail "task $id records a different resolution; it cannot be reconciled again"
    [ "$(recorded_resolution_mode "$body" || true)" = reconciled ] \
      || fail "task $id was not closed by reconciliation"
    occurrence=$(resolution_record_count "$body")
    remove_interrupted_answer_stamp "$id"
    publish_parent_hold "$id" "$occurrence" resolved reconciled
    [ "$PARENT_HOLD_PUBLISHED" = 1 ] \
      || fail "could not publish the reconciled captain-held task $id to its parent"
    reconcile_request_retire "$id"
    printf 'reconciled: %s\n' "$id"
    return 0
  fi
  [ "$hold_kind" = captain ] \
    || fail "task $id is not held for the captain; there is no captain call to reconcile"
  if body_has_resolution_record "$body" \
    && [ "$(recorded_decision_digest "$body" || true)" = "$DECISION_DIGEST" ]; then
    recorded_mode=$(recorded_resolution_mode "$body" || true)
    [ "$recorded_mode" = reconciled ] \
      || fail "task $id records this resolution with mode ${recorded_mode:-unknown}; it is not a reconciliation retry"
    occurrence=$(resolution_record_count "$body")
  else
    write_resolution_record "$id" reconciled "$body"
  fi
  close_answered "$id" 0 || fail "could not close reconciled captain-held task $id"
  remove_interrupted_answer_stamp "$id"
  task_show_or_fail "$id" "task $id disappeared after closing"
  body_has_resolution_record "$(show_field "$show" body)" \
    || fail "captain-held task $id did not retain its durable resolution record"
  publish_parent_hold "$id" "$occurrence" resolved reconciled
  [ "$PARENT_HOLD_PUBLISHED" = 1 ] \
    || fail "could not publish the reconciled captain-held task $id to its parent"
  reconcile_request_retire "$id"
  printf 'reconciled: %s\n' "$id"
}

# The still-active outcome. The hold survives, so the call stays the captain's
# and stays on Captain's Call, now carrying what the re-check found.
reconcile_note() {
  local id=${1:-} note_file='' note show body stamp tmp note_digest marker
  [ "$#" -ge 1 ] || { usage >&2; exit 2; }
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --note-file) shift; note_file=${1:-} ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  validate_slug task-id "$id"
  [ -n "$note_file" ] || fail "--note-file is required; leaving a call open records what the re-check found"
  [ -f "$note_file" ] || fail "note file does not exist: $note_file"
  note=$(cat "$note_file")
  [ -n "$note" ] || fail "note file must not be empty"
  [ "$(printf '%s' "$note" | LC_ALL=C wc -c | tr -d ' ')" -le 8192 ] \
    || fail "note file exceeds 8192 bytes"
  acquire_task_control_lock "$id"
  reconcile_request_read "$id" \
    || fail "task $id has no pending board-created reconcile request"
  require_tasks_axi
  command_open "$id" \
    || fail "task $id is not an open captain call; a note cannot keep a closed call open"
  task_show_or_fail "$id" "captain-held task $id is absent from this home's configured backlog (data directory $DATA)"
  body=$(decode_shown_value "$(show_field "$show" body)") \
    || fail "could not decode the existing body for $id"
  note_digest=$(sha256_text "$note")
  marker="Reconcile request: $RECONCILE_REQUESTED | $RECONCILE_SOURCE | note digest: $note_digest"
  case "$body" in
    *"$marker"*)
      reconcile_request_retire "$id" \
        || fail "could not retire the applied reconcile request for $id"
      command_open "$id" || fail "recording the reconcile note released captain-held task $id"
      printf 'still-open: %s\n' "$id"
      return 0
      ;;
  esac
  stamp=${FM_CAPTAIN_HOLD_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
  tmp=$(umask 077; mktemp "${TMPDIR:-/tmp}/fm-captain-hold-note.XXXXXX") \
    || fail "cannot stage the reconcile note"
  if ! printf '%s\n\nCaptain hold reconciled: %s\n%s\n%s\n' "$body" "$stamp" "$marker" "$note" > "$tmp"; then
    rm -f -- "$tmp"
    fail "cannot stage the reconcile note for $id"
  fi
  if ! tasks_axi update "$id" --body-file "$tmp" --archive-body >/dev/null; then
    rm -f -- "$tmp"
    fail "could not record the reconcile note on $id"
  fi
  rm -f -- "$tmp"
  reconcile_request_retire "$id" \
    || fail "could not retire the applied reconcile request for $id"
  command_open "$id" || fail "recording the reconcile note released captain-held task $id"
  printf 'still-open: %s\n' "$id"
}

command_complete() {
  local origin=${1:-} meta previous='' supplied='' keys='' entry key status_file open raw_open has_meta=0 transfer_rc resolved
  local resolved_how attested_by_prefix=''
  [ "$#" -ge 2 ] || { usage >&2; exit 2; }
  validate_slug origin-id "$origin"
  shift
  meta="$STATE/$origin.meta"
  [ -f "$meta" ] && has_meta=1
  if [ "$has_meta" = 1 ]; then
    CAPTAIN_META_LOCK=$(fm_meta_lock_path "$meta") || fail "could not resolve task metadata lock"
    fm_lock_acquire_wait "$CAPTAIN_META_LOCK"
    CAPTAIN_META_LOCK_HELD=1
    [ -f "$meta" ] || fail "task metadata disappeared while recording completion"
  fi
  require_tasks_axi
  origin_exists_here "$origin" || fail "origin $origin is not owned by the active home $FM_HOME"
  if [ "$#" -eq 1 ] && [ "$1" = --none ]; then
    supplied=''
  else
    while [ "$#" -gt 0 ]; do
      [ "$1" != --none ] || fail "--none cannot be combined with task ids"
      validate_slug task-id "$1"
      supplied="${supplied}${supplied:+ }$1"
      shift
    done
  fi
  if [ "$has_meta" = 1 ]; then
    previous=$(meta_value "$meta" decision_keys)
  fi
  keys=$(sorted_key_union "$previous" "$supplied")
  if [ -n "$keys" ]; then
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      resolved=$(verify_entry_durable "$origin" "$entry") || exit $?
      resolved_how=${resolved##* }
      resolved=${resolved%% *}
      if [ "$resolved_how" = migrated-prefix ]; then
        attested_by_prefix="${attested_by_prefix}${attested_by_prefix:+ }$entry=$resolved"
      fi
    done <<EOF
$(printf '%s\n' "$keys" | tr ',' '\n')
EOF
  fi

  status_file="$STATE/$origin.status"
  raw_open=$(status_open_decisions "$status_file")
  open=$(origin_open_decisions "$origin")
  if [ -n "$open" ] && [ -z "$keys" ]; then
    fail "origin $origin still has open captain decisions in its status stream; hold a captain task for what remains, or answer them, before attesting --none"
  fi

  if [ "$has_meta" = 1 ]; then
    if [ "$(meta_value "$meta" decisions_reviewed)" != 1 ] || [ "$previous" != "$keys" ]; then
      printf 'decisions_reviewed=1\ndecision_keys=%s\n' "$keys" >> "$meta"
    fi
    fm_lock_release "$CAPTAIN_META_LOCK"
    CAPTAIN_META_LOCK_HELD=0

    # Transfer every still-open status decision to the durable captain-held
    # inventory so the live status fold does not duplicate the same Captain's
    # Call item. The transfer line is this home's own bookkeeping close,
    # written by the turn that just reviewed the inventory, so it uses the
    # guarded self-announced append (bin/fm-wake-lib.sh) and does not wake this
    # same session; an append failure still fails this command loudly.
    if [ -n "$keys" ]; then
      while IFS=$'\t' read -r key _verb _summary; do
        [ -n "$key" ] || continue
        transfer_rc=0
        fm_wake_status_append_self_announced "$STATE" "$status_file" \
          "captain-held [key=$key]: tracked by $keys" || transfer_rc=$?
        [ "$transfer_rc" -ne 2 ] || fail "cannot append the captain-held transfer for $origin/$key"
      done <<EOF
$raw_open
EOF
    fi
  fi
  printf 'complete: %s captain-call inventory reviewed%s%s\n' "$origin" "${keys:+ ($keys)}" \
    "${attested_by_prefix:+ [attested through the configured prefix: $attested_by_prefix]}"
}

command_verify() {
  local origin=${1:-} meta reviewed keys entry key open resolved
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  validate_slug origin-id "$origin"
  meta="$STATE/$origin.meta"
  [ -f "$meta" ] || fail "origin metadata is absent: $meta"
  require_tasks_axi
  reviewed=$(meta_value "$meta" decisions_reviewed)
  [ "$reviewed" = 1 ] || fail "origin $origin has no completed captain-call inventory"
  keys=$(meta_value "$meta" decision_keys)
  if [ -n "$keys" ]; then
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      verify_entry_durable "$origin" "$entry" >/dev/null
    done <<EOF
$(printf '%s\n' "$keys" | tr ',' '\n')
EOF
  fi
  open=$(origin_open_decisions "$origin")
  while IFS=$'\t' read -r key _verb _summary; do
    [ -n "$key" ] || continue
    fail "open captain decision $origin/$key is not transferred to the captain-held inventory; re-run complete"
  done <<EOF
$open
EOF
  printf 'verified: %s captain-call inventory\n' "$origin"
}

# --- record divergence ------------------------------------------------------
#
# A captain call can be written down twice, and until now nothing said when
# those two records disagreed. A `resolved [key=...]` line closes the status-log
# fold outright; the structured captain-held task is closed by a SEPARATE act
# (`answer` above). Closing only on the status side therefore looks complete
# there while the durable record still says the captain owes an answer and
# keeps resurfacing it. The defect was never the separation; it was the silence.
#
# `diverged` is a read-only report of that contradiction and nothing else. It
# closes NOTHING. A captain call closed wrongly disappears without review, which
# is strictly worse than the noise this prints, so reconciling a divergence stays
# a human-owned act - and it runs in either direction: record what the captain
# actually said with `answer`, or re-open the status decision when that
# resolution was not the captain's word.
#
# What it flags, and only this: a task that is still open and still carries the
# captain-hold annotations, whose key was closed on the status side by the
# RESOLVE verb. The other closing verb is not a divergence: a `captain-held`
# close is the VERIFIED transfer to that very task, written by command_complete
# only after verifying it, so the structured row staying open behind it is the
# correct state. Neither is a still-open status decision - the OPEN DECISIONS
# fold already owns that one.
#
# Routed work is deliberately irrelevant. When the decision IS the deliverable
# there is nothing to route, so the test is only whether the status side already
# declared this task's key resolved.
# Nor does the report interpret why that resolution exists. A call can turn out
# not to be a captain arbitration at all - a premise can dissolve, or a question
# of fact can prove its first reading wrong - so the report says only that the
# two records disagree and names both reconciliation directions above.
#
# Cost stays flat on a healthy home: one `tasks-axi list`, one key scan per
# status log, and the precise per-key fold only for a key that already names a
# still-open task. If tasks-axi is unavailable or its listing cannot be parsed,
# the guard cannot read the structured record and prints nothing.
#
# Output: one `<task-id>\t<origin>\t<key>\t<title>` line per divergence, in
# status-log then key order; nothing when the two records agree.

# Every still-open task id in this home's backlog, one per line. Only the first
# two comma-separated listing fields are read - both are slugs that precede any
# quoted title - so a title containing commas or quotes cannot shift them.
open_task_ids() {
  local data
  data=$(fm_backlog_data_absolute "$DATA") || return 1
  fm_backlog_row_list "$data" 2>/dev/null | awk -F, '
    /^  [A-Za-z0-9._-]+,/ {
      id = $1
      sub(/^ +/, "", id)
      if ($2 != "done") print id
    }
  '
}

# Every key token stated anywhere in a status log. A cheap candidate scan: it
# over-includes tokens that are only prose, and status_key_closing_verb below is
# what actually decides what the stream says about a key.
status_log_key_tokens() {  # <status-file>
  grep -o '\[key=[A-Za-z0-9._-]*\]' "$1" 2>/dev/null |
    sed 's/^\[key=//; s/\]$//' | LC_ALL=C sort -u
}

list_has_line() {  # <newline-separated-list> <value>
  case $'\n'"$1"$'\n' in
    *$'\n'"$2"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

command_diverged() {
  local ids resolve f origin tokens id keys key show title
  [ "$#" -eq 0 ] || { usage >&2; exit 2; }
  # Both records must belong to the SAME home or the comparison is meaningless:
  # tasks-axi reads $FM_HOME's backlog, so a state dir pointed somewhere else
  # would report one home's status logs against another home's tasks. Every
  # production caller pairs the two; a mismatch stays silent rather than
  # inventing a cross-home divergence.
  [ "$STATE" = "$FM_HOME/state" ] || return 0
  # A read-only listing on a per-wake path, so it skips the mutation-oriented
  # compatibility floor and its extra probes: a listing this parser cannot read
  # simply yields no candidates and the report stays silent.
  command -v tasks-axi >/dev/null 2>&1 || return 0
  ids=$(open_task_ids) || return 0
  [ -n "$ids" ] || return 0
  resolve=${FM_CLASSIFY_RESOLVE_VERB:-$FM_CLASSIFY_RESOLVE_VERB_DEFAULT}
  for f in "$STATE"/*.status; do
    [ -f "$f" ] && [ -r "$f" ] && [ ! -L "$f" ] || continue
    origin=$(basename "$f"); origin=${origin%.status}
    tokens=$(status_log_key_tokens "$f")
    [ -n "$tokens" ] || continue
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      # The keys that could name this task in THIS log: the collapsed identity
      # (the key IS the task id) and, for a pre-collapse row, the legacy derived
      # one this origin would have minted.
      keys=$id
      case "$id" in
        "$origin-decision-"?*) keys="$keys"$'\n'"${id#"$origin-decision-"}" ;;
      esac
      while IFS= read -r key; do
        list_has_line "$tokens" "$key" || continue
        [ "$(status_key_closing_verb "$f" "$key")" = "$resolve" ] || continue
        task_show "$id" || continue
        show=$TASK_SHOW_OUTPUT
        [ "$(show_field "$show" state)" != "done" ] || continue
        [ "$(show_field_value "$show" hold_kind)" = captain ] || continue
        # The title is the only free-text field here, and the report is
        # TAB-separated, so it goes through the same sanitizer every other
        # emitted field uses rather than being trusted to stay one clean line.
        title=$(sanitize_field "$(show_field_value "$show" title)")
        printf '%s\t%s\t%s\t%s\n' "$id" "$origin" "$key" "$title"
        break
      done <<INNER
$keys
INNER
    done <<EOF
$ids
EOF
  done
}

# Still an open captain call? Exit 0 yes, 1 no, 2 cannot tell (see the header).
# A row this home does not carry is 3 when the caller requests the distinction,
# and so is a home with no backlog file at all, because a backlog that does not
# exist holds nothing. Every read failure over a record that DOES exist is a 2,
# printed to stderr, because a mechanical closer must never read "cannot tell"
# as permission to close.
command_open() {  # <task-id> [--identity] [--distinguish-absent]
  local id='' identity=0 distinguish_absent=0 data state root file backend show shown_body
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --identity) identity=1 ;;
      --distinguish-absent) distinguish_absent=1 ;;
      -*) usage >&2; exit 2 ;;
      *)
        [ -z "$id" ] || { usage >&2; exit 2; }
        id=$1
        ;;
    esac
    shift
  done
  case "$id" in
    ''|*[!A-Za-z0-9._-]*)
      printf 'fm-captain-hold: task id must be a non-empty privacy-safe slug: %s\n' "$id" >&2
      exit 2
      ;;
  esac
  data=$(fm_backlog_data_absolute "$DATA") \
    || { printf 'fm-captain-hold: data directory cannot be resolved: %s\n' "$DATA" >&2; exit 2; }
  root=$(fm_backlog_root "$data") \
    || { printf 'fm-captain-hold: %s\n' "$FM_BACKLOG_TRANSITION_ERROR" >&2; exit 2; }
  if ! backend=$(fm_tasks_axi_backend_resolve "$root"); then
    exit 2
  fi
  if [ "$backend" = markdown ]; then
    file=$(fm_backlog_file "$data") \
      || { printf 'fm-captain-hold: %s\n' "$FM_BACKLOG_TRANSITION_ERROR" >&2; exit 2; }
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then
      # No backlog file at all: this home records no captain calls, so the task
      # is absent from it rather than held. A record that EXISTS but cannot be
      # read is a different state and still leaves by the exit 2 paths below,
      # because that one may hide a live hold.
      [ "$distinguish_absent" = 0 ] || return 3
      return 1
    fi
  fi
  fm_tasks_axi_compatible || { printf 'fm-captain-hold: compatible tasks-axi is required\n' >&2; exit 2; }
  if fm_backlog_row_probe "$data" "$id"; then
    state=${FM_BACKLOG_ROW_STATE%% *}
    if [ "$state" != "done" ] && [ "$FM_BACKLOG_ROW_HOLD_KIND" = captain ]; then
      if [ "$identity" -eq 1 ]; then
        task_show "$id" || {
          printf 'fm-captain-hold: captain call %s is open but its record could not be read\n' "$id" >&2
          exit 2
        }
        show=$TASK_SHOW_OUTPUT
        shown_body=$(show_field "$show" body)
        printf '%s#%s\n' \
          "$(body_hold_set_timestamp "$(decode_shown_value "$shown_body")")" \
          "$(resolution_record_count "$shown_body")"
      fi
      return 0
    fi
    return 1
  fi
  if [ "$FM_BACKLOG_ROW_RESULT" = not_found ]; then
    [ "$distinguish_absent" = 0 ] || return 3
    return 1
  fi
  printf 'fm-captain-hold: %s\n' "$FM_BACKLOG_ROW_ERROR" >&2
  exit 2
}

case "${1:-}" in
  hold) shift; command_hold "$@" ;;
  offer) shift; command_offer "$@" ;;
  reply) shift; command_reply "$@" ;;
  replies) shift; command_replies "$@" ;;
  evidence) shift; command_evidence "$@" ;;
  decide) shift; command_decide "$@" ;;
  list) shift; command_list "$@" ;;
  migrate) shift; command_migrate "$@" ;;
  answer) shift; command_answer "$@" ;;
  answers) shift; command_answers "$@" ;;
  reconcile-requests) shift; command_reconcile_requests "$@" ;;
  bind) shift; command_bind "$@" ;;
  unbind) shift; command_unbind "$@" ;;
  binding) shift; command_binding "$@" ;;
  complete) shift; command_complete "$@" ;;
  verify) shift; command_verify "$@" ;;
  open) shift; command_open "$@" ;;
  diverged) shift; command_diverged "$@" ;;
  reconcile) shift; command_reconcile "$@" ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
