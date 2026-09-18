#!/usr/bin/env bash
# fm-decision-options.sh - the options a captain-held task offers, as data.
#
# A decision is a task waiting on the captain, and its question lives in the
# hold that bin/fm-captain-hold.sh writes. That hold is one line of prose, so
# the choices inside it can only be read by eye. This script is the single
# owner of the machine-readable form: the same choices, recorded beside the
# task, so a review surface can offer them as buttons and hand the captain's
# pick back through the one intake (`fm-captain-hold.sh answers`).
#
# It records only what is offered. Holding the task, answering it, and closing
# it stay with bin/fm-captain-hold.sh, and nothing here changes a task's state.
#
# Usage:
#   fm-decision-options.sh set <task-id> --option <key>=<label> [--option ...]
#                          [--recommend <key>] [--question <text>]
#   fm-decision-options.sh show <task-id> [--json]
#   fm-decision-options.sh list [--json]
#   fm-decision-options.sh clear <task-id>
#
# set
#   Replaces what that task offers. Two to eight options, each `<key>=<label>`:
#   the key is what an answer names ([a-z0-9][a-z0-9-]{0,31}), the label is the
#   one line the captain reads. --recommend names the option to mark, and must
#   be one of them. --question restates the choice in one line when the hold's
#   own reason reads poorly on its own. The task must exist in this home.
#
# show / list
#   Print one task's options, or every task's. --json prints the record;
#   without it, one `<key>  <label>` line per option, recommended marked.
#
# clear
#   Removes the record. Answering or closing a task does not need it removed:
#   a renderer shows options only while the task is still held.
#
# Store: state/decision-options/<task-id>.json, schema fm-decision-options.v1,
# {schema, task, question, options:[{key,label,recommended}], set_at}. Written
# to a temporary file of its own and renamed, so neither a crash nor a second
# writer ever leaves half a record; the last whole record written wins.
#
# Exit codes: 0 done; 1 refused; 2 usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
STORE="$STATE/decision-options"
MAX_OPTIONS=8

# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"  # fm_task_id_path_safe: the shared task id alphabet

usage() {
  sed -n '16,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "fm-decision-options: $*" >&2
  exit 1
}

option_key_valid() {  # <key>
  printf '%s' "$1" | LC_ALL=C grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$'
}

record_path() {  # <task-id>
  printf '%s/%s.json\n' "$STORE" "$1"
}

known_task() {  # <task-id>
  [ -f "$STATE/$1.meta" ] || [ -d "$DATA/$1" ]
}

print_record() {  # <file> <json>
  local file=$1 json=$2
  if [ "$json" = 1 ]; then
    cat "$file"
    return
  fi
  jq -r '"task: \(.task)", (if .question == "" then empty else "question: \(.question)" end),
         (.options[] | "  \(.key)  \(.label)\(if .recommended then "  (recommended)" else "" end)")' "$file"
}

cmd_set() {
  local id=${1:-} question='' keys='' labels_json='[]' recommend='' key label pair
  [ -n "$id" ] || usage
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --option)
        [ $# -ge 2 ] || usage
        pair=$2
        case "$pair" in *=*) ;; *) die "--option takes <key>=<label>, got '$pair'" ;; esac
        key=${pair%%=*}
        label=${pair#*=}
        option_key_valid "$key" || die "'$key' is not an option key (expected [a-z0-9][a-z0-9-]{0,31})"
        [ -n "$label" ] || die "option '$key' has no label"
        case "$label" in *$'\n'*) die "option '$key' label must be one line" ;; esac
        [ "${#label}" -le 200 ] || die "option '$key' label is longer than 200 characters"
        case " $keys " in *" $key "*) die "--option names '$key' twice" ;; esac
        keys="$keys $key"
        labels_json=$(printf '%s' "$labels_json" | jq -c --arg key "$key" --arg label "$label" '. + [{key:$key, label:$label}]')
        shift 2
        ;;
      --recommend) [ $# -ge 2 ] || usage; recommend=$2; shift 2 ;;
      --question)
        [ $# -ge 2 ] || usage
        question=$2
        case "$question" in *$'\n'*) die "--question must be one line" ;; esac
        [ "${#question}" -le 400 ] || die "--question is longer than 400 characters"
        shift 2
        ;;
      -h|--help) usage ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  fm_task_id_path_safe "$id" || die "invalid task id '$id'"
  known_task "$id" || die "unknown task '$id' (no state/$id.meta or data/$id/)"
  local count
  count=$(printf '%s' "$labels_json" | jq 'length')
  [ "$count" -ge 2 ] || die "a decision needs at least two options"
  [ "$count" -le "$MAX_OPTIONS" ] || die "a decision takes at most $MAX_OPTIONS options, got $count"
  if [ -n "$recommend" ]; then
    case " $keys " in *" $recommend "*) ;; *) die "--recommend names '$recommend', which is not one of the options" ;; esac
  fi

  (umask 077; mkdir -p "$STORE") || die "cannot create $STORE"
  [ -d "$STORE" ] && [ ! -L "$STORE" ] || die "the decision options store is unsafe: $STORE"
  local target temporary
  target=$(record_path "$id")
  # Each writer gets its own temporary file: with one shared name, two sets of
  # the same task truncate each other and can publish half a record.
  temporary=$(mktemp "$STORE/.$id.json.XXXXXX") || die "cannot write in $STORE"
  # shellcheck disable=SC2064 # expand now: the path is fixed for this run
  trap "rm -f -- '$temporary'" EXIT
  jq -n \
    --arg task "$id" \
    --arg question "$question" \
    --argjson options "$labels_json" \
    --arg recommend "$recommend" \
    --arg set_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schema:"fm-decision-options.v1", task:$task, question:$question,
      options:($options | map(. + {recommended:(.key == $recommend)})), set_at:$set_at}' \
    > "$temporary" || die "cannot write $temporary"
  chmod 644 "$temporary" 2>/dev/null
  mv -f "$temporary" "$target" || die "cannot save $target"
  printf 'set: %s (%s options)\n' "$id" "$count"
}

cmd_show() {
  local id=${1:-} json=0
  [ -n "$id" ] || usage
  shift
  [ "${1:-}" = --json ] && json=1
  fm_task_id_path_safe "$id" || die "invalid task id '$id'"
  local file
  file=$(record_path "$id")
  [ -f "$file" ] || die "task '$id' offers no recorded options"
  print_record "$file" "$json"
}

cmd_list() {
  local json=0 file
  [ "${1:-}" = --json ] && json=1
  if [ "$json" = 1 ]; then
    find "$STORE" -maxdepth 1 -name '*.json' -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r file; do
      jq -c --arg task "$(basename "$file" .json)" 'select(.schema == "fm-decision-options.v1" and .task == $task)' "$file" 2>/dev/null
    done | jq -s '{schema:"fm-decision-options-list.v1", decisions:.}'
    return
  fi
  local found=0
  for file in "$STORE"/*.json; do
    [ -f "$file" ] || continue
    found=1
    print_record "$file" 0
  done
  [ "$found" = 1 ] || echo "decision options: none"
}

cmd_clear() {
  local id=${1:-}
  [ -n "$id" ] || usage
  fm_task_id_path_safe "$id" || die "invalid task id '$id'"
  rm -f -- "$(record_path "$id")" || die "cannot remove the record for '$id'"
  printf 'cleared: %s\n' "$id"
}

[ $# -ge 1 ] || usage
command -v jq >/dev/null 2>&1 || die "jq is required"
sub=$1
shift
case "$sub" in
  set) cmd_set "$@" ;;
  show) cmd_show "$@" ;;
  list) cmd_list "$@" ;;
  clear) cmd_clear "$@" ;;
  -h|--help) usage ;;
  *) usage ;;
esac
