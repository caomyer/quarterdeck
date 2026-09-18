#!/usr/bin/env bash
# fm-decided.sh - the calls firstmate made on the captain's behalf, as data.
#
# Firstmate settles some things the captain could reasonably have wanted to
# settle: answering a crew's ask-user or needs-decision itself, merging or
# closing a pull request, filing a task nobody asked for, or narrowing or
# widening the scope the captain gave. Each call may be right, but a call made
# only in chat prose is invisible afterwards. This script is the single owner of
# the durable record, so a review surface can show every call with one line of
# why and let the captain push back.
#
# It records only what was decided. It never changes a task, a hold, or a PR.
#
# Usage:
#   fm-decided.sh record --what <one line> --why <one line>
#                        [--task <task-id>] [--kind <kind>] [--link <url>]
#   fm-decided.sh list [--json] [--since <days>]
#
# record
#   --what says what was decided, in the captain's terms (one line, at most 200
#   characters). --why says why (one line, at most 300 characters). --kind is
#   one of review-finding, merge, new-task, scope, other (default other).
#   --task names the task it concerns and must be a task this home knows (a
#   state/<id>.meta or a data/<id>/ directory). --link is an http(s) URL, such as
#   the PR or a report. Prints `recorded: <id>`.
#
# list
#   Prints the decisions of the last --since days (default 7), newest first.
#   --json prints {"schema":"fm-decided-list.v1","decided":[<records>]}. A
#   damaged record is skipped, never fatal. FM_DECIDED_NOW (ISO-8601 UTC) pins
#   the window's end for a caller that already fixed "now", such as the fleet
#   snapshot.
#
# Store: state/decided/<id>.json, one file per decision, schema fm-decided.v1:
# {schema, id, at, kind, task, what, why, link}, with task and link null when
# absent. The id is `<UTC yyyymmddThhmmssZ>-<6 random [a-z0-9]>`, so ids sort by
# time and never collide. Each record is written to a temporary file of its own
# and then linked into place without replacing anything, so neither a crash nor
# a concurrent writer ever leaves half a record or overwrites another.
#
# Exit codes: 0 done; 1 refused; 2 usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
STORE="$STATE/decided"
DEFAULT_SINCE_DAYS=7

# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"  # fm_task_id_path_safe: the shared task id alphabet

usage() {
  sed -n '15,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "fm-decided: $*" >&2
  exit 1
}

known_task() {  # <task-id>
  [ -f "$STATE/$1.meta" ] || [ -d "$DATA/$1" ]
}

# One line of text with a character (not byte) limit.
check_line() {  # <flag> <value> <max>
  local flag=$1 value=$2 max=$3 length
  case "$value" in *[![:space:]]*) ;; *) die "$flag must say something" ;; esac
  case "$value" in *$'\n'*|*$'\r'*) die "$flag must be one line" ;; esac
  length=$(jq -n --arg s "$value" '$s | length') || die "cannot measure $flag"
  [ "$length" -le "$max" ] || die "$flag is longer than $max characters ($length)"
}

random_suffix() {
  local suffix
  suffix=$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 6)
  [ "${#suffix}" -eq 6 ] || return 1
  printf '%s\n' "$suffix"
}

cmd_record() {
  local what='' why='' task='' kind=other link='' what_set=0 why_set=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --what) [ $# -ge 2 ] || usage; what=$2; what_set=1; shift 2 ;;
      --why) [ $# -ge 2 ] || usage; why=$2; why_set=1; shift 2 ;;
      --task) [ $# -ge 2 ] || usage; task=$2; shift 2 ;;
      --kind) [ $# -ge 2 ] || usage; kind=$2; shift 2 ;;
      --link) [ $# -ge 2 ] || usage; link=$2; shift 2 ;;
      -h|--help) usage ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  [ "$what_set" = 1 ] || die "record needs --what <what was decided>"
  [ "$why_set" = 1 ] || die "record needs --why <why it was decided>"
  check_line --what "$what" 200
  check_line --why "$why" 300
  case "$kind" in
    review-finding|merge|new-task|scope|other) ;;
    *) die "--kind must be one of review-finding, merge, new-task, scope, other (got '$kind')" ;;
  esac
  if [ -n "$task" ]; then
    fm_task_id_path_safe "$task" || die "invalid task id '$task'"
    known_task "$task" || die "unknown task '$task' (no state/$task.meta or data/$task/)"
  fi
  if [ -n "$link" ]; then
    printf '%s' "$link" | LC_ALL=C grep -Eq '^https?://[^[:space:]]+$' \
      || die "--link must be an http(s) URL (got '$link')"
  fi

  [ -d "$STATE" ] || die "state dir not found: $STATE"
  (umask 077; mkdir -p "$STORE") || die "cannot create $STORE"
  [ -d "$STORE" ] && [ ! -L "$STORE" ] || die "the decided store is unsafe: $STORE"

  local temporary stamp at suffix id target attempt
  temporary=$(mktemp "$STORE/.record.XXXXXX") || die "cannot write in $STORE"
  # shellcheck disable=SC2064 # expand now: the path is fixed for this run
  trap "rm -f -- '$temporary'" EXIT
  for attempt in 1 2 3 4 5; do
    # One clock read feeds both the id and the time, so they always agree.
    stamp=$(date -u +%Y%m%dT%H%M%SZ) || die "cannot read the clock"
    at="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
    suffix=$(random_suffix) || die "cannot draw a random id"
    id="$stamp-$suffix"
    target="$STORE/$id.json"
    jq -n \
      --arg id "$id" --arg at "$at" --arg kind "$kind" --arg task "$task" \
      --arg what "$what" --arg why "$why" --arg link "$link" \
      '{schema:"fm-decided.v1", id:$id, at:$at, kind:$kind,
        task:(if $task == "" then null else $task end),
        what:$what, why:$why,
        link:(if $link == "" then null else $link end)}' \
      > "$temporary" || die "cannot write $temporary"
    chmod 644 "$temporary" 2>/dev/null
    # A hard link publishes the whole record at once and refuses to replace an
    # existing one, so two writers can never overwrite each other.
    if ln -- "$temporary" "$target" 2>/dev/null; then
      printf 'recorded: %s\n' "$id"
      return 0
    fi
    [ -e "$target" ] || die "cannot save $target"
    [ "$attempt" -lt 5 ] || die "could not find a free decision id"
  done
}

cmd_list() {
  local json=0 since=$DEFAULT_SINCE_DAYS now records
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1; shift ;;
      --since)
        [ $# -ge 2 ] || usage
        since=$2
        case "$since" in ''|*[!0-9]*) die "--since takes a whole number of days (got '$since')" ;; esac
        shift 2
        ;;
      -h|--help) usage ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  now=${FM_DECIDED_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
  jq -en --arg now "$now" '$now | fromdateiso8601' >/dev/null 2>&1 \
    || die "FM_DECIDED_NOW must be an ISO-8601 UTC time such as 2026-09-18T07:14:00Z (got '$now')"
  local file
  records=$(
    if [ -d "$STORE" ] && [ ! -L "$STORE" ]; then
      find "$STORE" -maxdepth 1 -name '*.json' -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r file; do
        jq -c --arg id "$(basename "$file" .json)" '
          select(type == "object" and .schema == "fm-decided.v1" and .id == $id
            and (.at | type) == "string" and (.what | type) == "string"
            and (.why | type) == "string" and (.kind | type) == "string"
            and ((.task == null) or (.task | type) == "string")
            and ((.link == null) or (.link | type) == "string")
            and ((try (.at | fromdateiso8601) catch null) != null))' "$file" 2>/dev/null
      done
    fi | jq -s --arg now "$now" --argjson days "$since" '
      ($now | fromdateiso8601) as $end
      | {schema:"fm-decided-list.v1",
         decided:(map(select((.at | fromdateiso8601) >= ($end - $days * 86400)))
           | sort_by(.at, .id) | reverse)}'
  ) || die "cannot read the decided store"
  if [ "$json" = 1 ]; then
    printf '%s\n' "$records"
  else
    printf '%s\n' "$records" | jq -r '
      if (.decided | length) == 0 then "decided: none"
      else .decided[]
        | "\(.at)  \(.kind)\(if .task then "  " + .task else "" end)  \(.what)",
          "  why: \(.why)",
          (if .link then "  link: \(.link)" else empty end)
      end'
  fi
}

[ $# -ge 1 ] || usage
command -v jq >/dev/null 2>&1 || die "jq is required"
sub=$1
shift
case "$sub" in
  record) cmd_record "$@" ;;
  list) cmd_list "$@" ;;
  -h|--help) usage ;;
  *) usage ;;
esac
