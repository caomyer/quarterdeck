#!/usr/bin/env bash
# fm-task-edit.sh - the one writer of a task's attributes on the captain's word.
#
# Usage:
#   fm-task-edit.sh priority <id> <0-4> [--expect <0-4|none>]
#   fm-task-edit.sh title <id> <text> [--expect <text>]
#   fm-task-edit.sh block <id> --by <blocker-id>
#   fm-task-edit.sh unblock <id> --by <blocker-id>
#   fm-task-edit.sh park <id> --until <YYYY-MM-DD> [--expect <YYYY-MM-DD|none>]
#   fm-task-edit.sh unpark <id> [--expect <YYYY-MM-DD>]
#   fm-task-edit.sh project <id> <project> [--expect <project|none>]
#   fm-task-edit.sh kind <id> <ship|scout> [--expect <kind|none>]
#   fm-task-edit.sh group <id> <group-id|none> [--expect <group-id|none>]
#   fm-task-edit.sh group-new <title> --project <project> [--priority <0-4>]
#   fm-task-edit.sh group-close <group-id>
#
# Quarterdeck edits a task only through this command (src-tauri/src/tasks.rs),
# and the first mate uses it too when it changes one of these attributes, so
# every refusal below holds whoever asks. Every change reaches the backlog
# through bin/fm-tasks-axi.sh; nothing here writes a backlog file itself.
#
# WHAT IT REFUSES, and why:
#   - any edit to a closed row (the logbook keeps it as it was) or to a call
#     (kind captain: bin/fm-captain-hold.sh owns it, and it is answered, not
#     edited);
#   - project, kind, a new blocker or a put-off date on a task in flight: its
#     worker was briefed and its worktree made for what the row said at spawn,
#     and state/<id>.meta froze its kind and project, which teardown reads while
#     delivery accounting reads the row. A priority, title or group change is
#     display and ordering only, so it is taken in flight;
#   - a blocker that would close a loop, walking every open edge (tasks-axi
#     itself accepts one, and neither task could ever start);
#   - a stale edit: --expect carries the value the caller last saw, and a
#     different value now means someone else changed it first. The refusal
#     names the current value;
#   - a title carrying row metadata such as `(repo: x)`, `blocked-by:` or a
#     link, which the backlog parser would read as something else;
#   - putting off a task someone else holds: a captain call's date is changed
#     by answering the call, and a first mate's hold is the first mate's;
#   - a project this home has not registered in data/projects.md;
#   - closing a group while any of its tasks is still open.
#
# GROUPS. A group is a `kind: program` row, which the engine already treats as
# an in-flight row no worker runs. A task joins one by a single body line,
# `part-of: <group-id>`, which only this command writes and
# bin/fm-backlog-parse-lib.sh reads into each record's `part_of`. The rest of the
# body is kept byte for byte: the body is read back from tasks-axi and only
# that line changes. Order inside a group stays with blocked-by edges.
# group-new files the row In flight and prints its id; the id is the title's
# first words, lower-cased, after `g-`, with -2, -3, ... when taken.
#
# PUTTING OFF. park records `tasks-axi hold --kind parked --until <date>`, a
# hold kind apart from `captain` so the call machinery ignores it; tasks-axi
# ready skips the task until that day. The date must be after the captain's
# day (bin/fm-backlog-parse-lib.sh owns it).
#
# LOCKING. Each change runs under state/.task-edit.lock, so a loop check and
# its write are one step, then under the task's control lock (shared with
# bin/fm-captain-hold.sh, whose body writes it serializes against) and its
# meta lock (held by bin/fm-spawn.sh while it starts the row), in that order.
# A lock still held after 10 seconds refuses the edit as busy.
#
# OUTPUT. One JSON object on stdout. Success, exit 0:
#   {ok:true, task:<id>, changed:<bool>, record:<the row, as the snapshot's
#    backlog.records[] carries it>}
# changed is false when the row already said so. A refusal, exit 1:
#   {ok:false, task:<id>|null, code:<code>, reason:<one line in the captain's
#    words>, current:<the current value, for stale>}
# and the reason on stderr after `fm-task-edit: `. Codes: unknown, closed,
# call, running, loop, stale, invalid, held, unregistered, open-members, busy,
# backlog. Exit 2 is a usage error.
#
# FM_HOME / FM_DATA_OVERRIDE / FM_STATE_OVERRIDE address the home as the other
# scripts do; FM_TASK_EDIT_NOW (a UTC timestamp) fixes the clock for tests.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
NOW=${FM_TASK_EDIT_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
LOCK_WAIT=10

# shellcheck source=bin/fm-backlog-parse-lib.sh
. "$SCRIPT_DIR/fm-backlog-parse-lib.sh"
# shellcheck source=bin/fm-tasks-axi-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
# shellcheck source=bin/fm-backlog-transition-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-backlog-transition-lib.sh"
# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"  # fm_pr_task_id_valid: the shared task id alphabet

usage() {
  sed -n '4,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

usage_fail() {
  printf 'fm-task-edit: %s\n' "$*" >&2
  exit 2
}

TASK=
# Refuse in one JSON line and one stderr line, and exit 1.
refuse() {  # <code> <reason> [<current>]
  jq -cn --arg task "$TASK" --arg code "$1" --arg reason "$2" --arg current "${3-}" --argjson has_current "$([ "$#" -ge 3 ] && echo true || echo false)" \
    '{ok:false, task:(if $task == "" then null else $task end), code:$code, reason:$reason}
     + (if $has_current then {current:$current} else {} end)'
  printf 'fm-task-edit: %s\n' "$2" >&2
  exit 1
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-task-edit.XXXXXX") || { echo 'fm-task-edit: cannot make a scratch directory' >&2; exit 1; }
HELD_LOCKS=()
# shellcheck disable=SC2329 # Invoked by the EXIT trap below.
cleanup() {
  local lock index
  for (( index=${#HELD_LOCKS[@]}-1; index>=0; index-- )); do
    lock=${HELD_LOCKS[$index]}
    fm_lock_release "$lock" 2>/dev/null || true
  done
  rm -rf -- "$TMP"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

LOCK_LIB_LOADED=0
hold_lock() {  # <lock-path>
  if [ "$LOCK_LIB_LOADED" = 0 ]; then
    mkdir -p "$STATE" || refuse backlog "cannot reach this home's state directory"
    # The wake library carries the lock primitives; keep its state paths here.
    FM_WAKE_QUEUE="$STATE/.wake-queue"
    FM_WAKE_QUEUE_LOCK="$STATE/.wake-queue.lock"
    export FM_STATE_OVERRIDE="$STATE"
    # shellcheck source=bin/fm-wake-lib.sh
    . "$SCRIPT_DIR/fm-wake-lib.sh"
    LOCK_LIB_LOADED=1
  fi
  fm_lock_acquire_wait_bounded "$1" "$LOCK_WAIT" \
    || refuse busy "another change to this task is in progress; try again in a moment"
  HELD_LOCKS+=("$1")
}

tasks_axi() {
  FM_HOME="$FM_HOME" FM_DATA_OVERRIDE="$DATA" "$SCRIPT_DIR/fm-tasks-axi.sh" "$@"
}

# ---- reading the backlog -----------------------------------------------------

BACKLOG=
ARCHIVE=
resolve_backlog() {
  FM_BACKLOG_TRANSITION_ERROR=
  fm_backlog_tasks_axi_addressing "$DATA" 2>/dev/null \
    || refuse backlog "cannot read the backlog: ${FM_BACKLOG_TRANSITION_ERROR:-data directory cannot be resolved: $DATA}"
  [ -n "$FM_BACKLOG_AXI_FILE" ] || refuse backlog "edits need this home's markdown backlog, and its tasks-axi backend keeps another"
  BACKLOG=$FM_BACKLOG_AXI_FILE
  [ -f "$BACKLOG" ] || refuse backlog "this home has no backlog at $BACKLOG"
  ARCHIVE=$(fm_tasks_axi_archive_resolve "$FM_BACKLOG_AXI_ROOT" "$BACKLOG" 2>/dev/null) || ARCHIVE=
}

# Parse the backlog as the snapshot does, into $TMP/backlog.json.
read_backlog() {
  local archived='[]'
  [ -z "$ARCHIVE" ] || archived=$(fm_backlog_archived_ids "$ARCHIVE") || archived='[]'
  printf '%s' "$archived" > "$TMP/archived.json"
  # shellcheck disable=SC2094 # the path is only a label; the file is read once
  fm_backlog_parse_json "$BACKLOG" "$NOW" 14 "$archived" < "$BACKLOG" > "$TMP/backlog.json" \
    || refuse backlog "cannot parse the backlog at $BACKLOG"
}

# A row by id: the open one when a closed copy shares its id. Empty when absent.
record_of() {  # <id>
  jq -c --arg id "$1" '[.records[] | select(.structured and .id == $id)]
    | (map(select(.state != "done")) + map(select(.state == "done"))) | .[0] // empty' "$TMP/backlog.json"
}

field() {  # <record-json> <jq-path>; "none" for null
  printf '%s' "$1" | jq -r "($2) // \"none\" | tostring"
}

archived() {  # <id>
  jq -e --arg id "$1" 'index($id) != null' "$TMP/archived.json" >/dev/null
}

captain_day() { fm_captain_day "$NOW"; }

# A task's body exactly as tasks-axi keeps it: `show --full` prints it as one
# TOON value, JSON-quoted whenever it is not a bare word.
task_body() {  # <id>
  local out line
  out=$(tasks_axi show "$1" --full 2>"$TMP/show.err") || refuse backlog "tasks-axi could not read $1"
  line=$(printf '%s\n' "$out" | sed -n 's/^  body: //p' | head -1)
  case "$line" in
    \"*) printf '%s' "$line" | jq -r . ;;
    *) printf '%s\n' "$line" ;;
  esac
}

registered_project() {  # <name>
  [ -f "$DATA/projects.md" ] || return 1
  awk -v want="$1" '
    /^[-*][[:space:]]+/ {
      line = $0
      sub(/^[-*][[:space:]]+/, "", line)
      name = line
      sub(/[[:space:]].*/, "", name)
      if (name == want) { found = 1; exit }
    }
    END { exit found ? 0 : 1 }' "$DATA/projects.md"
}

# ---- checks shared by the verbs ----------------------------------------------

REC=
# Load TASK's row and refuse what no verb may change.
load_task() {
  fm_pr_task_id_valid "$TASK" || usage_fail "'$TASK' is not a task id"
  REC=$(record_of "$TASK")
  if [ -z "$REC" ]; then
    if archived "$TASK"; then refuse closed "$TASK has closed; the logbook keeps it as it was"; fi
    refuse unknown "no task $TASK in this home's backlog"
  fi
  [ "$(field "$REC" .state)" != "done" ] || refuse closed "$TASK has closed; the logbook keeps it as it was"
  [ "$(field "$REC" .kind)" != captain ] || refuse call "$TASK is a call; answer it where it is asked"
}

is_group() { [ "$(field "$REC" .kind)" = program ]; }
in_flight() { [ "$(field "$REC" .state)" = in_flight ] && ! is_group; }

refuse_in_flight() {  # <what>
  in_flight || return 0
  refuse running "$TASK is already running, and its worker was briefed for its $1; to change it, the work has to stop and be briefed again, so ask the first mate"
}

refuse_group() {  # <what>
  is_group || return 0
  refuse invalid "$TASK is a group; $1"
}

check_expect() {  # <current> <expected-or-empty> <what>
  [ -n "$2" ] || return 0
  [ "$1" = "$2" ] && return 0
  refuse stale "Not changed: its $3 changed to $1 while your window showed $2; pick again" "$1"
}

check_title() {  # <text>
  local text=$1
  [ -n "${text//[[:space:]]/}" ] || refuse invalid "a title cannot be empty"
  case "$text" in
    *$'\n'*|*$'\r'*) refuse invalid "a title is one line" ;;
  esac
  [ "${#text}" -le 200 ] || refuse invalid "a title is at most 200 characters"
  if printf '%s' "$text" | grep -Eqi '\((repo|kind|priority|hold|hold-kind|hold-until):|\((since|merged|reported|done)[[:space:]]|blocked-by:|https?://'; then
    refuse invalid "a title cannot carry row details such as (repo: ...), blocked-by: or a link; add a link as a note"
  fi
}

check_priority() {  # <value>
  [[ "$1" =~ ^[0-4]$ ]] || refuse invalid "priority is 0 (urgent) to 4 (someday), not '$1'"
}

lock_task() {  # <id>
  local meta_lock
  hold_lock "$STATE/.control-$1.lock"
  meta_lock=$(fm_meta_lock_path "$STATE/$1.meta") || refuse invalid "'$1' is not a task id"
  hold_lock "$meta_lock"
}

# Print the result for TASK from a fresh read of the backlog.
succeed() {  # <changed:true|false>
  local rec
  read_backlog
  rec=$(record_of "$TASK")
  [ -n "$rec" ] || refuse backlog "$TASK is no longer in the backlog after the change"
  jq -cn --arg task "$TASK" --argjson changed "$1" --argjson record "$rec" '{ok:true, task:$task, changed:$changed, record:$record}'
  exit 0
}

# ---- loops -------------------------------------------------------------------

# The path by which <from> already waits on <to> through open edges, as
# "from x ... to", or nothing when it does not.
wait_path() {  # <from> <to>
  jq -r --arg from "$1" --arg to "$2" '
    ([.records[] | select(.structured and .state != "done")]
     | map({key:.id, value:.unresolved_blocker_ids}) | from_entries) as $edges
    | def walk_from($queue; $seen):
        if ($queue | length) == 0 then null
        else $queue[0] as $path
          | ($path[-1]) as $at
          | if $at == $to then $path
            else [($edges[$at] // [])[] as $next_id | select($seen | any(. == $next_id) | not) | $next_id] as $next
              | walk_from($queue[1:] + [$next[] | $path + [.]]; $seen + $next)
            end
        end;
      walk_from([[$from]]; [$from]) // empty | join(" ")' "$TMP/backlog.json"
}

# ---- verbs -------------------------------------------------------------------

take_expect() {  # sets EXPECT from the remaining arguments
  EXPECT=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --expect) [ "$#" -ge 2 ] || usage_fail '--expect needs a value'; EXPECT=$2; shift 2 ;;
      *) usage_fail "unknown argument '$1'" ;;
    esac
  done
}

cmd_priority() {
  [ "$#" -ge 2 ] || usage
  TASK=$1; local value=$2; shift 2
  take_expect "$@"
  check_priority "$value"
  load_task
  lock_task "$TASK"; read_backlog; load_task
  local current
  current=$(field "$REC" .priority)
  check_expect "$current" "$EXPECT" priority
  [ "$current" != "$value" ] || succeed false
  tasks_axi update "$TASK" --priority "$value" >/dev/null || refuse backlog "tasks-axi could not set the priority of $TASK"
  succeed true
}

cmd_title() {
  [ "$#" -ge 2 ] || usage
  TASK=$1; local value=$2; shift 2
  take_expect "$@"
  check_title "$value"
  load_task
  lock_task "$TASK"; read_backlog; load_task
  local current
  current=$(field "$REC" .title)
  check_expect "$current" "$EXPECT" title
  [ "$current" != "$value" ] || succeed false
  tasks_axi update "$TASK" --title "$value" >/dev/null || refuse backlog "tasks-axi could not retitle $TASK"
  succeed true
}

take_by() {  # sets BY from the remaining arguments
  BY=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --by) [ "$#" -ge 2 ] || usage_fail '--by needs a task id'; BY=$2; shift 2 ;;
      *) usage_fail "unknown argument '$1'" ;;
    esac
  done
  [ -n "$BY" ] || usage_fail 'name the other task with --by'
  fm_pr_task_id_valid "$BY" || usage_fail "'$BY' is not a task id"
}

cmd_block() {
  [ "$#" -ge 1 ] || usage
  TASK=$1; shift
  take_by "$@"
  load_task
  hold_lock "$STATE/.task-edit.lock"
  lock_task "$TASK"; read_backlog; load_task
  refuse_group "a group waits on nothing; order its tasks instead"
  refuse_in_flight "dependencies"
  [ "$BY" != "$TASK" ] || refuse invalid "a task cannot wait on itself"
  local blocker path
  blocker=$(record_of "$BY")
  if [ -z "$blocker" ]; then
    if archived "$BY"; then refuse invalid "$BY has already landed; there is nothing to wait for"; fi
    refuse unknown "no task $BY in this home's backlog"
  fi
  [ "$(field "$blocker" .state)" != "done" ] || refuse invalid "$BY has already landed; there is nothing to wait for"
  [ "$(field "$blocker" .kind)" != program ] || refuse invalid "$BY is a group; wait on one of its tasks instead"
  if printf '%s' "$REC" | jq -e --arg by "$BY" '.blocked_by_ids | index($by) != null' >/dev/null; then
    succeed false
  fi
  path=$(wait_path "$BY" "$TASK")
  if [ -n "$path" ]; then
    local through
    through=$(printf '%s\n' "$path" | awk '{ out = ""; for (i = 2; i < NF; i++) out = out (out == "" ? "" : ", then ") $i; print out }')
    if [ -n "$through" ]; then
      refuse loop "Not added: $BY already waits on $TASK through $through, so each would wait on the other forever"
    fi
    refuse loop "Not added: $BY already waits on $TASK, so each would wait on the other forever"
  fi
  tasks_axi block "$TASK" --by "$BY" >/dev/null || refuse backlog "tasks-axi could not record that $TASK waits on $BY"
  succeed true
}

cmd_unblock() {
  [ "$#" -ge 1 ] || usage
  TASK=$1; shift
  take_by "$@"
  load_task
  hold_lock "$STATE/.task-edit.lock"
  lock_task "$TASK"; read_backlog; load_task
  if ! printf '%s' "$REC" | jq -e --arg by "$BY" '.blocked_by_ids | index($by) != null' >/dev/null; then
    succeed false
  fi
  tasks_axi unblock "$TASK" --by "$BY" >/dev/null || refuse backlog "tasks-axi could not drop $BY from what $TASK waits on"
  succeed true
}

valid_day() {  # <YYYY-MM-DD>
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  [ "$(jq -rn --arg d "$1" 'try ($d + "T00:00:00Z" | fromdateiso8601 | strftime("%Y-%m-%d")) catch ""')" = "$1" ]
}

cmd_park() {
  [ "$#" -ge 1 ] || usage
  TASK=$1; shift
  local until='' rest=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --until) [ "$#" -ge 2 ] || usage_fail '--until needs a date'; until=$2; shift 2 ;;
      *) rest+=("$1"); shift ;;
    esac
  done
  take_expect ${rest[@]+"${rest[@]}"}
  [ -n "$until" ] || usage_fail 'park needs --until <YYYY-MM-DD>'
  valid_day "$until" || refuse invalid "'$until' is not a date like 2026-10-01"
  load_task
  lock_task "$TASK"; read_backlog; load_task
  refuse_group "put off its tasks instead"
  refuse_in_flight "start"
  local kind current today
  kind=$(field "$REC" .hold_kind)
  if [ "$(field "$REC" .hold_reason)" != none ] && [ "$kind" != parked ]; then
    [ "$kind" != captain ] || refuse held "$TASK waits on a call; its date changes by answering the call"
    refuse held "the first mate is holding $TASK: $(field "$REC" .hold_reason)"
  fi
  current=none
  [ "$kind" != parked ] || current=$(field "$REC" .hold_until)
  check_expect "$current" "$EXPECT" put-off date
  today=$(captain_day)
  [[ "$until" > "$today" ]] || refuse invalid "put it off to a day after today ($today)"
  [ "$current" != "$until" ] || succeed false
  tasks_axi hold "$TASK" --reason "put off by the captain until $until" --kind parked --until "$until" >/dev/null \
    || refuse backlog "tasks-axi could not put $TASK off"
  succeed true
}

cmd_unpark() {
  [ "$#" -ge 1 ] || usage
  TASK=$1; shift
  take_expect "$@"
  load_task
  lock_task "$TASK"; read_backlog; load_task
  local kind
  kind=$(field "$REC" .hold_kind)
  if [ "$(field "$REC" .hold_reason)" = none ]; then
    check_expect none "$EXPECT" put-off date
    succeed false
  fi
  [ "$kind" != captain ] || refuse held "$TASK waits on a call; its date changes by answering the call"
  [ "$kind" = parked ] || refuse held "the first mate is holding $TASK: $(field "$REC" .hold_reason)"
  check_expect "$(field "$REC" .hold_until)" "$EXPECT" put-off date
  tasks_axi unhold "$TASK" >/dev/null || refuse backlog "tasks-axi could not bring $TASK back"
  succeed true
}

cmd_project() {
  [ "$#" -ge 2 ] || usage
  TASK=$1; local value=$2; shift 2
  take_expect "$@"
  load_task
  lock_task "$TASK"; read_backlog; load_task
  refuse_in_flight "project"
  registered_project "$value" || refuse unregistered "no project named $value is registered in this home"
  local current
  current=$(field "$REC" .repo)
  check_expect "$current" "$EXPECT" project
  [ "$current" != "$value" ] || succeed false
  tasks_axi update "$TASK" --repo "$value" >/dev/null || refuse backlog "tasks-axi could not move $TASK to $value"
  succeed true
}

cmd_kind() {
  [ "$#" -ge 2 ] || usage
  TASK=$1; local value=$2; shift 2
  take_expect "$@"
  case "$value" in ship|scout) ;; *) refuse invalid "a task is a ship or a scout, not '$value'" ;; esac
  load_task
  lock_task "$TASK"; read_backlog; load_task
  refuse_group "it stays a group"
  refuse_in_flight "kind"
  local current
  current=$(field "$REC" .kind)
  check_expect "$current" "$EXPECT" kind
  [ "$current" != "$value" ] || succeed false
  tasks_axi update "$TASK" --kind "$value" >/dev/null || refuse backlog "tasks-axi could not change what kind of task $TASK is"
  succeed true
}

cmd_group() {
  [ "$#" -ge 2 ] || usage
  TASK=$1; local value=$2; shift 2
  take_expect "$@"
  [ "$value" = none ] || fm_pr_task_id_valid "$value" || usage_fail "'$value' is not a group id"
  load_task
  lock_task "$TASK"; read_backlog; load_task
  refuse_group "a group cannot be part of another group"
  local current group
  current=$(field "$REC" .part_of)
  check_expect "$current" "$EXPECT" group
  if [ "$value" != none ]; then
    group=$(record_of "$value")
    [ -n "$group" ] || refuse unknown "no group $value in this home's backlog"
    [ "$(field "$group" .kind)" = program ] || refuse invalid "$value is a task, not a group"
    [ "$(field "$group" .state)" != "done" ] || refuse invalid "the group $value has closed"
  fi
  [ "$current" != "$value" ] || succeed false
  task_body "$TASK" > "$TMP/body.md"
  # Every line but the group's, without the blank lines the body ends on, so
  # the line appended below sits directly under the body.
  awk '!/^part-of:[[:space:]]/ { line[++n] = $0 }
    END { while (n > 0 && line[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print line[i] }' \
    "$TMP/body.md" > "$TMP/body.new"
  if [ "$value" != none ]; then
    printf 'part-of: %s\n' "$value" >> "$TMP/body.new"
  fi
  # tasks-axi keeps a trailing newline as a blank body line; the body never had one.
  printf '%s' "$(cat "$TMP/body.new")" > "$TMP/body.final"
  tasks_axi update "$TASK" --body-file "$TMP/body.final" >/dev/null || refuse backlog "tasks-axi could not record the group of $TASK"
  succeed true
}

group_id_for() {  # <title>
  local slug candidate n=2
  slug=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//' \
    | awk -F- '{ out = ""; for (i = 1; i <= NF && i <= 5; i++) out = out (out == "" ? "" : "-") $i; print out }' | cut -c1-40 | sed 's/-$//')
  [ -n "$slug" ] || slug=group
  candidate="g-$slug"
  while [ -n "$(record_of "$candidate")" ] || archived "$candidate"; do
    candidate="g-$slug-$n"
    n=$((n + 1))
  done
  printf '%s\n' "$candidate"
}

cmd_group_new() {
  [ "$#" -ge 1 ] || usage
  local title=$1 project='' priority=''
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project) [ "$#" -ge 2 ] || usage_fail '--project needs a name'; project=$2; shift 2 ;;
      --priority) [ "$#" -ge 2 ] || usage_fail '--priority needs 0-4'; priority=$2; shift 2 ;;
      *) usage_fail "unknown argument '$1'" ;;
    esac
  done
  [ -n "$project" ] || usage_fail 'group-new needs --project'
  check_title "$title"
  [ -z "$priority" ] || check_priority "$priority"
  registered_project "$project" || refuse unregistered "no project named $project is registered in this home"
  hold_lock "$STATE/.task-edit.lock"
  read_backlog
  TASK=$(group_id_for "$title")
  local args=(add "$TASK" "$title" --repo "$project" --kind program --start)
  [ -z "$priority" ] || args+=(--priority "$priority")
  tasks_axi "${args[@]}" >/dev/null || refuse backlog "tasks-axi could not file the group $TASK"
  succeed true
}

cmd_group_close() {
  [ "$#" -eq 1 ] || usage
  TASK=$1
  load_task
  hold_lock "$STATE/.task-edit.lock"
  lock_task "$TASK"; read_backlog; load_task
  is_group || refuse invalid "$TASK is a task, not a group; the first mate closes tasks"
  local open
  open=$(jq -r --arg id "$TASK" '[.records[] | select(.structured and .state != "done" and .part_of == $id) | .id] | join(", ")' "$TMP/backlog.json")
  [ -z "$open" ] || refuse open-members "the group still has open tasks: $open"
  tasks_axi "done" "$TASK" >/dev/null || refuse backlog "tasks-axi could not close the group $TASK"
  succeed true
}

case "${1:-}" in
  ''|-h|--help) usage ;;
esac
command -v jq >/dev/null 2>&1 || { echo 'fm-task-edit: jq not found' >&2; exit 1; }
[[ "$NOW" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || usage_fail 'FM_TASK_EDIT_NOW must be a UTC timestamp like 2026-09-26T12:00:00Z'
VERB=$1
shift
resolve_backlog
read_backlog
case "$VERB" in
  priority) cmd_priority "$@" ;;
  title) cmd_title "$@" ;;
  block) cmd_block "$@" ;;
  unblock) cmd_unblock "$@" ;;
  park) cmd_park "$@" ;;
  unpark) cmd_unpark "$@" ;;
  project) cmd_project "$@" ;;
  kind) cmd_kind "$@" ;;
  group) cmd_group "$@" ;;
  group-new) cmd_group_new "$@" ;;
  group-close) cmd_group_close "$@" ;;
  *) usage_fail "unknown verb '$VERB'" ;;
esac
