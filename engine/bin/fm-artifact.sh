#!/usr/bin/env bash
# fm-artifact.sh - present HTML review artifacts as immutable revisions, and
# resolve how this home presents visual work.
#
# This script is the single owner of the artifact store format (schema
# fm-artifact-revision.v1), the listing format (schema fm-artifact-list.v1),
# and the presentation-mode decision.
#
# Usage:
#   fm-artifact.sh present (--task <id> | --chat) <html-file>
#                  [--name <name>] [--title <title>] [--note <text>] [--assets <dir>]
#                  [--accept-layout] [--addressed <t1,t2>] [--reply <t3>=<text>]
#   fm-artifact.sh list [--json]
#   fm-artifact.sh mode
#
# present
#   Copies the HTML file, plus the contents of --assets when given, into a new
#   immutable revision and returns at once. Nothing waits for review.
#   --task attaches the artifact to a task this home knows (state/<id>.meta or
#   data/<id>/ exists); --chat attaches it to the first mate's conversation.
#   --name defaults to the file name without its extension, lowercased with
#   every run of other characters folded to "-"; it must match
#   [a-z0-9][a-z0-9-]{0,63}.
#   --title defaults to the document's <title>, then to the name.
#   --note says what changed since the previous revision.
#   --addressed names the review comments this revision answers, and --reply
#   answers one in words without changing the page (repeat it per comment).
#   Both take the comment ids the captain's review carries (t1, t2, ...), and
#   naming one twice, or an id that is not one, is refused. They are recorded on
#   the revision, so the review screen can show each comment as answered next to
#   what the captain asked. Answering is a claim about this revision only:
#   whether a comment is settled stays the captain's call.
#   --assets copies that directory's contents beside the HTML so relative
#   references keep working; the HTML file wins a name clash. Symbolic links
#   are refused, and the whole revision is capped at FM_ARTIFACT_MAX_BYTES
#   (default 52428800, 50 MiB).
#   Presenting content identical to the latest revision creates nothing and
#   prints "unchanged", so a retry is safe.
#   Before a new revision is created, the layout check loads a scratch copy in
#   headless Chrome at a wide (1280x900) and a narrow (500x900, Chrome's
#   headless minimum) window and runs bin/fm-artifact-layout.js, which owns the
#   rules. Findings refuse the present with exit 3 and one
#   "layout: <wide|narrow> <rule> <selector> - <detail>" line each, so the
#   agent fixes the page before the captain sees it; --accept-layout presents
#   anyway when the findings are intentional. The check fails open: no Chrome
#   (FM_ARTIFACT_CHROME overrides discovery), no result within
#   FM_ARTIFACT_LAYOUT_TIMEOUT seconds (default 30), or FM_ARTIFACT_LAYOUT=0
#   presents with "layout: skipped (<reason>)".
#   Output: "presented: <name> rev <n>" or "unchanged: <name> rev <n>", then
#   "entry: <absolute path of the revision's HTML>".
#
# Store layout, under the home's data directory:
#   <task-id>/artifacts/<name>/rev-<n>/files/...     task artifacts
#   .artifacts/<name>/rev-<n>/files/...              chat artifacts
#   .../rev-<n>/revision.json                        written last, atomically
# A revision directory without revision.json is incomplete and every reader
# ignores it. Revisions are never rewritten; a revision number is claimed with
# an atomic mkdir, so concurrent presents of one artifact get distinct numbers.
# revision.json fields: schema, scope ("task"|"chat"), task (null for chat),
# name, rev, title, note, entry (file name under files/), sha256 (over every
# file's path and content), bytes, presented_at (UTC), presented_by
# ({role:"crew",task:<FM_TASK_ID>} or {role:"firstmate"}),
# answers ({addressed:[<comment id>], replies:[{thread,body}]}), layout
# ({status:"clean"|"accepted"|"skipped", reason (skipped only),
# issues:[{viewport:"wide"|"narrow", rule, selector, detail}]}).
#
# list
#   Prints every complete artifact, newest presentation first. --json prints
#   {schema:"fm-artifact-list.v1", artifacts:[{scope, task, name, title, dir,
#   latest:{...revision.json fields, path}, revisions:[...same, oldest first]}]}
#   where dir is the artifact directory and path is the absolute entry path.
#   A revision.json whose scope, task, name, or rev disagrees with its own
#   location is ignored rather than trusted.
#
# mode
#   Prints the presentation mode: "quarterdeck" (the home is run by the
#   Quarterdeck desktop app, which reviews presented artifacts natively) or
#   "lavish" (review through lavish-axi, the default). FM_PRESENTATION wins,
#   then the first non-empty line of config/presentation. Any other value exits
#   1 naming the bad value, so a typo fails loudly instead of silently choosing.
#
# Exit codes: 0 success; 1 refused (invalid input, unknown task, over the size
# cap, bad mode); 2 usage; 3 refused for layout findings.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
MAX_BYTES="${FM_ARTIFACT_MAX_BYTES:-52428800}"
LAYOUT_TIMEOUT="${FM_ARTIFACT_LAYOUT_TIMEOUT:-30}"
LAYOUT_PROBE="$SCRIPT_DIR/fm-artifact-layout.js"
LAYOUT_MARKER='__fm_artifact_layout__'


# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"  # fm_task_id_path_safe: the shared task id alphabet

usage() {
  sed -n '9,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "fm-artifact: $*" >&2
  exit 1
}

sha256_of() {  # <file>
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'; else sha256sum | awk '{print $1}'; fi
}

# Digest over every regular file's relative path and content, in a stable order.
tree_digest() {  # <dir>
  local dir=$1 rel
  (
    cd "$dir" || exit 1
    find . -type f | LC_ALL=C sort | while IFS= read -r rel; do
      printf '%s  %s\n' "$(sha256_of "$rel")" "$rel"
    done
  ) | sha256_stdin
}

normalize_name() {  # <raw>
  printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//'
}

# A comment id from the captain's review: t1, t2, ...
comment_id_valid() {  # <id>
  printf '%s' "$1" | LC_ALL=C grep -Eq '^t[1-9][0-9]{0,4}$'
}

name_valid() {  # <name>
  printf '%s' "$1" | LC_ALL=C grep -Eq '^[a-z0-9][a-z0-9-]{0,63}$'
}

html_title() {  # <file>
  LC_ALL=C tr '\n\r\t' '   ' < "$1" \
    | LC_ALL=C sed -n 's/.*<[Tt][Ii][Tt][Ll][Ee][^>]*>\([^<]*\)<\/[Tt][Ii][Tt][Ll][Ee]>.*/\1/p' \
    | head -n 1 \
    | LC_ALL=C sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//' \
    | cut -c 1-200
}

# Highest complete revision number in an artifact directory, or 0.
latest_rev() {  # <artifact-dir>
  local dir=$1 best=0 entry n
  for entry in "$dir"/rev-*; do
    [ -f "$entry/revision.json" ] || continue
    n=${entry##*/rev-}
    case "$n" in ''|*[!0-9]*) continue ;; esac
    [ "$n" -gt "$best" ] && best=$n
  done
  printf '%s\n' "$best"
}

find_chrome() {
  local candidate
  if [ -n "${FM_ARTIFACT_CHROME:-}" ]; then
    [ -x "$FM_ARTIFACT_CHROME" ] && printf '%s\n' "$FM_ARTIFACT_CHROME"
    return
  fi
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return; }
  done
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$candidate" 2>/dev/null && return
  done
}

# Load <page> once in headless Chrome and print the probe's JSON, or nothing.
# Headless Chrome can keep running after it has dumped the DOM, so the dump is
# read as it arrives and Chrome is stopped as soon as the probe result is in it.
layout_probe_once() {  # <chrome> <page> <width> <height> <scratch>
  local chrome=$1 page=$2 width=$3 height=$4 scratch=$5 url pid waited=0 limit
  url="file://$(jq -rn --arg p "$page" '$p | split("/") | map(@uri) | join("/")')"
  mkdir -p "$scratch/profile-$width"
  "$chrome" --headless --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$scratch/profile-$width" --window-size="$width,$height" \
    --virtual-time-budget=8000 --dump-dom "$url" > "$scratch/dom-$width" 2>/dev/null &
  pid=$!
  limit=$((LAYOUT_TIMEOUT * 5))
  while [ "$waited" -lt "$limit" ]; do
    grep -q "$LAYOUT_MARKER" "$scratch/dom-$width" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
    waited=$((waited + 1))
  done
  pkill -P "$pid" 2>/dev/null
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  LC_ALL=C tr '\n' ' ' < "$scratch/dom-$width" \
    | LC_ALL=C sed -n "s/.*<pre id=\"$LAYOUT_MARKER\">\([^<]*\)<\/pre>.*/\1/p" \
    | sed -e 's/&quot;/"/g' -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g'
}

# Print the layout record (without status) for the staged files:
# {"skipped":<reason or null>,"issues":[...]}.
layout_check() {  # <files-dir> <entry>
  local files=$1 entry=$2 chrome scratch page result issues='[]' label width
  if [ "${FM_ARTIFACT_LAYOUT:-1}" = 0 ]; then
    printf '{"skipped":"disabled by FM_ARTIFACT_LAYOUT=0","issues":[]}\n'
    return
  fi
  chrome=$(find_chrome)
  if [ -z "$chrome" ]; then
    printf '{"skipped":"no Chrome or Chromium found","issues":[]}\n'
    return
  fi
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/fm-artifact-layout.XXXXXX") || {
    printf '{"skipped":"cannot create a scratch directory","issues":[]}\n'
    return
  }
  page="$files/.fm-artifact-layout-check.html"
  { cat "$files/$entry"; printf '\n<script>\n'; cat "$LAYOUT_PROBE"; printf '\n</script>\n'; } > "$page"
  for label in wide narrow; do
    if [ "$label" = wide ]; then width=1280; else width=500; fi
    result=$(layout_probe_once "$chrome" "$page" "$width" 900 "$scratch")
    if ! printf '%s' "$result" | jq -e '.issues | type == "array"' >/dev/null 2>&1; then
      rm -f "$page"
      rm -rf "$scratch"
      jq -cn --arg label "$label" --argjson limit "$LAYOUT_TIMEOUT" \
        '{skipped:("no result from the \($label) window within \($limit)s"),issues:[]}'
      return
    fi
    issues=$(jq -cn --argjson have "$issues" --argjson got "$result" --arg label "$label" \
      '$have + ($got.issues | map({viewport:$label, rule, selector, detail}))')
  done
  rm -f "$page"
  rm -rf "$scratch"
  jq -cn --argjson issues "$issues" '{skipped:null,issues:$issues}'
}

cmd_mode() {
  local raw source
  if [ -n "${FM_PRESENTATION:-}" ]; then
    raw=$FM_PRESENTATION
    source=FM_PRESENTATION
  elif [ -f "$CONFIG/presentation" ]; then
    raw=$(grep -v '^[[:space:]]*$' "$CONFIG/presentation" | head -n 1 | tr -d '[:space:]')
    source=config/presentation
  else
    raw=lavish
    source=default
  fi
  case "$raw" in
    lavish|quarterdeck) printf '%s\n' "$raw" ;;
    *) die "$source names unknown presentation mode '$raw' (expected lavish or quarterdeck)" ;;
  esac
}

cmd_present() {
  local task='' chat=0 file='' name='' title='' note='' assets='' accept_layout=0 scope art_dir stage digest latest latest_sha
  local n tries entry bytes presented_by rev_dir now layout answered='' replies='[]' reply_id reply_body id
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) [ $# -ge 2 ] || usage; task=$2; shift 2 ;;
      --chat) chat=1; shift ;;
      --name) [ $# -ge 2 ] || usage; name=$2; shift 2 ;;
      --title) [ $# -ge 2 ] || usage; title=$2; shift 2 ;;
      --note) [ $# -ge 2 ] || usage; note=$2; shift 2 ;;
      --assets) [ $# -ge 2 ] || usage; assets=$2; shift 2 ;;
      --accept-layout) accept_layout=1; shift ;;
      --addressed)
        [ $# -ge 2 ] || usage
        for id in $(printf '%s' "$2" | tr ',' ' '); do
          comment_id_valid "$id" || die "'$id' is not a review comment id (expected t1, t2, ...)"
          case " $answered " in *" $id "*) die "--addressed names '$id' twice" ;; esac
          answered="$answered $id"
        done
        shift 2
        ;;
      --reply)
        [ $# -ge 2 ] || usage
        case "$2" in *=*) ;; *) die "--reply takes <comment id>=<text>, got '$2'" ;; esac
        reply_id=${2%%=*}
        reply_body=${2#*=}
        comment_id_valid "$reply_id" || die "'$reply_id' is not a review comment id (expected t1, t2, ...)"
        [ -n "$reply_body" ] || die "--reply to '$reply_id' says nothing"
        printf '%s' "$replies" | jq -e --arg id "$reply_id" 'any(.[]; .thread == $id)' >/dev/null 2>&1 && die "--reply answers '$reply_id' twice"
        replies=$(printf '%s' "$replies" | jq -c --arg id "$reply_id" --arg body "$reply_body" '. + [{thread:$id, body:$body}]')
        shift 2
        ;;
      -h|--help) usage ;;
      -*) die "unknown option '$1'" ;;
      *) [ -z "$file" ] || die "only one HTML file may be presented at a time"; file=$1; shift ;;
    esac
  done
  [ -n "$file" ] || usage

  if [ "$chat" = 1 ]; then
    [ -z "$task" ] || die "--task and --chat are mutually exclusive"
    scope=chat
  else
    [ -n "$task" ] || die "say where the artifact belongs: --task <id> or --chat"
    fm_task_id_path_safe "$task" || die "invalid task id '$task'"
    [ -f "$STATE/$task.meta" ] || [ -d "$DATA/$task" ] || die "unknown task '$task' (no state/$task.meta or data/$task/)"
    scope=task
  fi

  [ -f "$file" ] && [ ! -L "$file" ] || die "not a regular file: $file"
  case "$file" in
    *.html|*.htm|*.HTML|*.HTM) ;;
    *) die "not an HTML file: $file" ;;
  esac
  entry=${file##*/}
  if [ -n "$assets" ]; then
    [ -d "$assets" ] || die "--assets is not a directory: $assets"
    [ -z "$(find "$assets" -type l -print -quit)" ] || die "--assets contains symbolic links, which are refused: $assets"
  fi

  [ -n "$name" ] || name=$(normalize_name "${entry%.*}")
  name_valid "$name" || die "invalid artifact name '$name' (expected [a-z0-9][a-z0-9-]{0,63})"
  [ -n "$title" ] || title=$(html_title "$file")
  [ -n "$title" ] || title=$name

  if [ "$scope" = chat ]; then
    art_dir="$DATA/.artifacts/$name"
  else
    art_dir="$DATA/$task/artifacts/$name"
  fi
  mkdir -p "$art_dir" || die "cannot create $art_dir"

  stage=$(mktemp -d "$art_dir/.stage.XXXXXX") || die "cannot stage in $art_dir"
  # shellcheck disable=SC2064 # expand now: the stage path is fixed for this run
  trap "rm -rf -- '$stage'" EXIT
  mkdir "$stage/files" || die "cannot stage in $art_dir"
  if [ -n "$assets" ]; then
    cp -R "$assets/." "$stage/files/" || die "cannot copy assets from $assets"
  fi
  cp "$file" "$stage/files/$entry" || die "cannot copy $file"

  bytes=$(find "$stage/files" -type f -exec cat {} + | wc -c | tr -d '[:space:]')
  [ "$bytes" -le "$MAX_BYTES" ] || die "revision is $bytes bytes, over the $MAX_BYTES byte cap (FM_ARTIFACT_MAX_BYTES); present a smaller assets directory"

  digest=$(tree_digest "$stage/files") || die "cannot digest the revision"
  latest=$(latest_rev "$art_dir")
  if [ "$latest" -gt 0 ]; then
    latest_sha=$(jq -r '.sha256 // empty' "$art_dir/rev-$latest/revision.json" 2>/dev/null)
    if [ "$latest_sha" = "$digest" ]; then
      printf 'unchanged: %s rev %s\n' "$name" "$latest"
      printf 'entry: %s\n' "$art_dir/rev-$latest/files/$(jq -r '.entry' "$art_dir/rev-$latest/revision.json")"
      return 0
    fi
  fi

  layout=$(layout_check "$stage/files" "$entry")
  if [ "$(printf '%s' "$layout" | jq -r '.skipped // empty')" != "" ]; then
    printf 'layout: skipped (%s)\n' "$(printf '%s' "$layout" | jq -r .skipped)"
    layout=$(printf '%s' "$layout" | jq -c '{status:"skipped", reason:.skipped, issues:[]}')
  elif [ "$(printf '%s' "$layout" | jq '.issues | length')" -gt 0 ]; then
    printf '%s' "$layout" | jq -r '.issues[] | "layout: \(.viewport) \(.rule) \(.selector) - \(.detail)"'
    if [ "$accept_layout" = 0 ]; then
      echo "refused: fix the layout findings above and present again, or add --accept-layout if they are intentional" >&2
      exit 3
    fi
    layout=$(printf '%s' "$layout" | jq -c '{status:"accepted", issues}')
  else
    layout=$(printf '%s' "$layout" | jq -c '{status:"clean", issues:[]}')
  fi

  n=$((latest + 1))
  tries=0
  until mkdir "$art_dir/rev-$n" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 1000 ] || die "cannot claim a revision number in $art_dir"
    n=$((n + 1))
  done
  rev_dir="$art_dir/rev-$n"
  mv "$stage/files" "$rev_dir/files" || die "cannot place revision $n"

  local answers
  answers=$(jq -cn --arg addressed "$answered" --argjson replies "$replies" \
    '{addressed:($addressed | split(" ") | map(select(length > 0))), replies:$replies}')

  if [ -n "${FM_TASK_ID:-}" ]; then
    presented_by=$(jq -cn --arg task "$FM_TASK_ID" '{role:"crew",task:$task}')
  else
    presented_by='{"role":"firstmate"}'
  fi
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg scope "$scope" \
    --arg task "$task" \
    --arg name "$name" \
    --argjson rev "$n" \
    --arg title "$title" \
    --arg note "$note" \
    --arg entry "$entry" \
    --arg sha256 "$digest" \
    --argjson bytes "$bytes" \
    --arg presented_at "$now" \
    --argjson presented_by "$presented_by" \
    --argjson answers "$answers" \
    --argjson layout "$layout" \
    '{schema:"fm-artifact-revision.v1", scope:$scope,
      task:(if $scope == "task" then $task else null end),
      name:$name, rev:$rev, title:$title,
      note:(if $note == "" then null else $note end),
      entry:$entry, sha256:$sha256, bytes:$bytes,
      presented_at:$presented_at, presented_by:$presented_by, answers:$answers, layout:$layout}' \
    > "$rev_dir/.revision.json.tmp" || die "cannot write revision $n"
  mv "$rev_dir/.revision.json.tmp" "$rev_dir/revision.json" || die "cannot publish revision $n"

  printf 'presented: %s rev %s\n' "$name" "$n"
  printf 'entry: %s\n' "$rev_dir/files/$entry"
}

cmd_list() {
  local json=0 records
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1; shift ;;
      *) usage ;;
    esac
  done
  records='{"schema":"fm-artifact-list.v1","artifacts":[]}'
  if [ -d "$DATA" ]; then
    records=$(
      {
        find "$DATA" -mindepth 5 -maxdepth 5 -path "$DATA/*/artifacts/*/rev-*/revision.json" -type f 2>/dev/null
        find "$DATA" -mindepth 4 -maxdepth 4 -path "$DATA/.artifacts/*/rev-*/revision.json" -type f 2>/dev/null
      } | LC_ALL=C sort | while IFS= read -r path; do
        jq -c --arg path "$path" --arg data "$DATA" '
          ($path | ltrimstr($data + "/") | split("/")) as $p
          | (if $p[0] == ".artifacts"
             then {scope:"chat", task:null, name:$p[1], rev:$p[2]}
             else {scope:"task", task:$p[0], name:$p[2], rev:$p[3]} end) as $loc
          | select(.schema == "fm-artifact-revision.v1"
                   and .scope == $loc.scope and .task == $loc.task and .name == $loc.name
                   and ("rev-" + (.rev | tostring)) == $loc.rev
                   and (.entry | type) == "string" and (.entry | test("^[^/]+$")))
          | . + {path:(($path | rtrimstr("/revision.json")) + "/files/" + .entry),
                 dir:($path | rtrimstr("/revision.json") | sub("/rev-[0-9]+$"; ""))}
        ' "$path" 2>/dev/null
      done | jq -s '
        {schema:"fm-artifact-list.v1",
         artifacts:(group_by([.scope, .task, .name])
           | map(sort_by(.rev) as $revs
                 | ($revs | last) as $latest
                 | {scope:$latest.scope, task:$latest.task, name:$latest.name, title:$latest.title,
                    dir:$latest.dir, latest:($latest | del(.dir)), revisions:($revs | map(del(.dir)))})
           | sort_by(.latest.presented_at) | reverse)}'
    ) || die "cannot read the artifact store"
  fi
  if [ "$json" = 1 ]; then
    printf '%s\n' "$records"
  else
    printf '%s\n' "$records" | jq -r '
      if (.artifacts | length) == 0 then "artifacts: none"
      else .artifacts[] | "\(if .scope == "chat" then "chat" else "task " + .task end)  \(.name)  rev \(.latest.rev)  \(.title)" end'
  fi
}

[ $# -ge 1 ] || usage
command -v jq >/dev/null 2>&1 || die "jq is required"
sub=$1
shift
case "$sub" in
  present) cmd_present "$@" ;;
  list) cmd_list "$@" ;;
  mode) [ $# -eq 0 ] || usage; cmd_mode ;;
  -h|--help) usage ;;
  *) usage ;;
esac
