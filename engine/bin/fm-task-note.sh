#!/usr/bin/env bash
# fm-task-note.sh - the files and notes a task carries beside its backlog row.
#
# This script is the single owner of a task's notes and files: nothing else
# writes data/<id>/notes/ or data/<id>/files/, and the store format below is
# stated only here.
#
# Usage:
#   fm-task-note.sh add <task-id> [--body <text> | --body-file <path>]
#                   [--file <path>]... [--scope] [--by <who>] [--json]
#   fm-task-note.sh show <task-id> [--json]
#   fm-task-note.sh brief <task-id>
#
# What belongs here: what whoever works the task must know and would get wrong
# without - evidence (a screenshot, a log, a sample file), a change of scope,
# a decision about the work. Progress stays in status lines, conversation stays
# in chat, and a comment about a page stays on that page's review. A note is a
# record on the task, not a message: adding one wakes nobody.
#
# add
#   Records one note on a task this home knows (state/<id>.meta, data/<id>/, or
#   a backlog row). It needs a body, a file, or both.
#   --file copies a regular file (a symbolic link or a folder is refused) into
#   data/<id>/files/ under a clean name: every character outside A-Z a-z 0-9
#   . _ - becomes "-", runs of "-" fold into one, and a name already taken gains
#   -2, -3, ... before its extension. So the path an agent receives is safe to
#   type and to pass to a shell, whatever the original was called (a macOS
#   screenshot's name carries a U+202F narrow no-break space). A file already
#   copied into the home by Quarterdeck (data/.attachments/) is hard-linked
#   instead, since those copies never change; anything else is copied, so the
#   task keeps the file as it was when added. Each file is capped at
#   FM_TASK_NOTE_MAX_BYTES (default 104857600, 100 MiB).
#   --scope marks a note that changes what the task must do.
#   --by names who added it: "firstmate" (the default), "captain", or a task id.
#   Prints "added: <note-id> on <task-id>" and one "file: <path>" line per file,
#   or with --json the note object as `show --json` shapes it.
#
# show
#   Prints a task's notes, oldest first. A task with none prints nothing and
#   exits 0. With --json it prints one object:
#     {schema:"fm-task-notes.v1", task:<id>, notes:[
#       {id:"n1", at:<UTC>, by:<who>, scope:<bool>, body:<text>,
#        files:[{name, path, bytes, original}]}]}
#   path is absolute; original is the file's name before it was cleaned.
#
# brief
#   Prints the section bin/fm-spawn.sh appends to a worker's launch brief: every
#   file as a path to read, and every note. Pictures travel as paths, never
#   inlined, so a brief never grows by a file. Prints nothing when the task has
#   no notes.
#
# Store: data/<id>/notes/<note-id>.json holds one note as `show --json` shapes
# it, except that each file's path is relative to data/<id>/. Note ids are n1,
# n2, ... in the order added; a note is published whole by a hard link, so two
# concurrent adds claim distinct ids and a reader never sees half a note.
# data/<id>/ outlives teardown, so the notes and files reach the next worker.
#
# Exit codes: 0 success; 1 refused (invalid input, unknown task, over the size
# cap, unreadable store); 2 usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
MAX_BYTES="${FM_TASK_NOTE_MAX_BYTES:-104857600}"
MAX_BODY_BYTES=65536

# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"  # fm_task_id_path_safe: the shared task id alphabet

usage() {
  sed -n '9,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "fm-task-note: $*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || die "jq is required"

# A task this home knows: one that ran or is running, or a backlog row, read by
# the snapshot's own parser so a queued task is known before any worker exists.
task_known() {  # <id>
  local id=$1
  if [ -f "$STATE/$id.meta" ] || [ -d "$DATA/$id" ]; then
    return 0
  fi
  FM_HOME="$FM_HOME" FM_STATE_OVERRIDE="$STATE" FM_DATA_OVERRIDE="$DATA" "$SCRIPT_DIR/fm-fleet-snapshot.sh" --backlog-json 2>/dev/null \
    | jq -e --arg id "$id" 'any(.records[]?; .id == $id)' >/dev/null
}

clean_name() {  # <raw>
  local name
  name=$(printf '%s' "$1" | LC_ALL=C sed -e 's/[^A-Za-z0-9._-]/-/g' -e 's/--*/-/g' -e 's/^[-.]*//' -e 's/-*$//')
  [ -n "$name" ] || name="file"
  printf '%s\n' "$name"
}

file_bytes() {  # <path>
  wc -c < "$1" | tr -d ' '
}

# Publishes <src> into <dir> under <name>, or the first free <stem>-N<ext>, and
# prints the name it took. The claim is a hard link, which fails when the name
# is taken, so two concurrent adds never share a name.
claim_file() {  # <src> <dir> <name> <link-ok: 0|1>
  local src=$1 dir=$2 name=$3 link_ok=$4 stem ext n=1 candidate tmp
  case "$name" in
    ?*.*) stem=${name%.*}; ext=.${name##*.} ;;
    *) stem=$name; ext= ;;
  esac
  if [ "$link_ok" = 1 ]; then
    tmp=$src
  else
    tmp="$dir/.incoming.${BASHPID:-$$}"
    cp -p "$src" "$tmp" 2>/dev/null || { rm -f -- "$tmp"; return 1; }
  fi
  candidate=$name
  while ! ln "$tmp" "$dir/$candidate" 2>/dev/null; do
    if [ "$link_ok" = 1 ] && [ "$n" = 1 ] && [ ! -e "$dir/$candidate" ]; then
      # The source cannot be linked from here (another filesystem): copy it instead.
      claim_file "$src" "$dir" "$name" 0
      return
    fi
    n=$((n + 1))
    [ "$n" -le 999 ] || { [ "$link_ok" = 1 ] || rm -f -- "$tmp"; return 1; }
    candidate="$stem-$n$ext"
  done
  [ "$link_ok" = 1 ] || rm -f -- "$tmp"
  printf '%s\n' "$candidate"
}

# Every note on <id>, oldest first, as `show --json` shapes them.
notes_json() {  # <id>
  local id=$1 dir="$DATA/$1/notes" file
  local -a files=()
  if [ -d "$dir" ]; then
    for file in "$dir"/n*.json; do
      [ -f "$file" ] && files+=("$file")
    done
  fi
  if [ "${#files[@]}" -eq 0 ]; then
    jq -n --arg task "$id" '{schema:"fm-task-notes.v1",task:$task,notes:[]}'
    return
  fi
  jq -s --arg task "$id" --arg base "$DATA/$id" '
    {schema:"fm-task-notes.v1", task:$task,
     notes: (sort_by(.id | ltrimstr("n") | tonumber)
       | map(.files |= map(.path = ($base + "/" + .path))))}' "${files[@]}" \
    || die "the notes in $dir cannot be read"
}

cmd_add() {
  local id=${1-} body='' body_file='' scope=false by=firstmate json=0 path name bytes n note tmp notes_dir files_dir link_ok taken
  local -a sources=() entries=()
  [ -n "$id" ] || usage
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --body) [ "$#" -ge 2 ] || usage; body=$2; shift 2 ;;
      --body-file) [ "$#" -ge 2 ] || usage; body_file=$2; shift 2 ;;
      --file) [ "$#" -ge 2 ] || usage; sources+=("$2"); shift 2 ;;
      --scope) scope=true; shift ;;
      --by) [ "$#" -ge 2 ] || usage; by=$2; shift 2 ;;
      --json) json=1; shift ;;
      *) usage ;;
    esac
  done
  fm_task_id_path_safe "$id" || die "invalid task id '$id'"
  printf '%s' "$by" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' || die "invalid --by '$by'"
  if [ -n "$body_file" ]; then
    [ -z "$body" ] || die "give --body or --body-file, not both"
    [ -f "$body_file" ] || die "no body file at $body_file"
    body=$(cat "$body_file") || die "cannot read $body_file"
  fi
  [ "$(printf '%s' "$body" | wc -c | tr -d ' ')" -le "$MAX_BODY_BYTES" ] || die "the body is over $MAX_BODY_BYTES bytes; attach it as a file instead"
  if [ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ] && [ "${#sources[@]}" -eq 0 ]; then
    die "a note needs --body, --body-file or --file"
  fi
  for path in ${sources[@]+"${sources[@]}"}; do
    [ ! -L "$path" ] || die "$path is a symbolic link; attach the file it points to"
    [ ! -d "$path" ] || die "$path is a folder; attach the files in it"
    [ -f "$path" ] || die "no file at $path"
    [ -r "$path" ] || die "cannot read $path"
    bytes=$(file_bytes "$path")
    [ "$bytes" -le "$MAX_BYTES" ] || die "$path is $bytes bytes, over the $MAX_BYTES cap; tell the worker where it is instead"
  done
  task_known "$id" || die "unknown task '$id' (no state/$id.meta, data/$id/, or backlog row)"

  notes_dir="$DATA/$id/notes"
  files_dir="$DATA/$id/files"
  mkdir -p "$notes_dir" || die "cannot create $notes_dir"
  for path in ${sources[@]+"${sources[@]}"}; do
    mkdir -p "$files_dir" || die "cannot create $files_dir"
    name=$(clean_name "$(basename "$path")")
    case "$(cd "$(dirname "$path")" && pwd -P)/" in
      "$(cd "$DATA" && pwd -P)/.attachments/"*) link_ok=1 ;;
      *) link_ok=0 ;;
    esac
    taken=$(claim_file "$path" "$files_dir" "$name" "$link_ok") || die "could not add $path to $files_dir"
    entries+=("$(jq -cn --arg name "$taken" --arg original "$(basename "$path")" --argjson bytes "$(file_bytes "$files_dir/$taken")" \
      '{name:$name, path:("files/" + $name), bytes:$bytes, original:$original}')")
  done

  tmp="$notes_dir/.incoming.${BASHPID:-$$}"
  n=1
  for note in "$notes_dir"/n*.json; do
    [ -f "$note" ] || continue
    note=${note##*/n}; note=${note%.json}
    case "$note" in ''|*[!0-9]*) continue ;; esac
    [ "$note" -ge "$n" ] && n=$((note + 1))
  done
  while :; do
    printf '%s\n' ${entries[@]+"${entries[@]}"} | jq -s \
      --arg id "n$n" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg by "$by" --argjson scope "$scope" --arg body "$body" \
      '{id:$id, at:$at, by:$by, scope:$scope, body:$body, files:.}' > "$tmp" || { rm -f -- "$tmp"; die "cannot write $tmp"; }
    ln "$tmp" "$notes_dir/n$n.json" 2>/dev/null && break
    n=$((n + 1))
    [ "$n" -le 99999 ] || { rm -f -- "$tmp"; die "no free note id in $notes_dir"; }
  done
  rm -f -- "$tmp"

  if [ "$json" = 1 ]; then
    jq --arg base "$DATA/$id" '.files |= map(.path = ($base + "/" + .path))' "$notes_dir/n$n.json"
    return
  fi
  printf 'added: n%s on %s\n' "$n" "$id"
  jq -r --arg base "$DATA/$id" '.files[] | "file: " + $base + "/" + .path' "$notes_dir/n$n.json"
}

cmd_show() {
  local id=${1-} json=0
  [ -n "$id" ] || usage
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --json) json=1; shift ;;
      *) usage ;;
    esac
  done
  fm_task_id_path_safe "$id" || die "invalid task id '$id'"
  if [ "$json" = 1 ]; then
    notes_json "$id"
    return
  fi
  notes_json "$id" | jq -r '
    .notes[]
    | "\(.id) \(.at) by \(.by)\(if .scope then ", changes scope" else "" end)",
      (.body | select(. != "") | split("\n")[] | "  " + .),
      (.files[] | "  file: \(.path) (\(.bytes) bytes)")'
}

cmd_brief() {
  local id=${1-}
  [ -n "$id" ] && [ "$#" -eq 1 ] || usage
  fm_task_id_path_safe "$id" || die "invalid task id '$id'"
  notes_json "$id" | jq -r --arg id "$id" '
    select(.notes | length > 0)
    | "",
      "# Files and notes on this task",
      "What was added to this task for whoever works it. Read every file before you start: each is evidence, not decoration.",
      "`fm-task-note.sh show \($id)` prints these again, with any added since.",
      "",
      (.notes[]
        | "- \(.id), \(.at), by \(.by)\(if .scope then ", changes scope" else "" end):",
          (.body | select(. != "") | split("\n")[] | "  " + .),
          (.files[] | "  - file: `\(.path)` (was \(.original | gsub("[[:cntrl:]`]"; "_")))"))'
}

case "${1-}" in
  add) shift; cmd_add "$@" ;;
  show) shift; cmd_show "$@" ;;
  brief) shift; cmd_brief "$@" ;;
  -h|--help) sed -n '2,60p' "${BASH_SOURCE[0]}" | sed -n '/^#/!q;p' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) usage ;;
esac
