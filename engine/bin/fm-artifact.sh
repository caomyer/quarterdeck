#!/usr/bin/env bash
# fm-artifact.sh - present HTML review artifacts as immutable revisions, and
# resolve how this home presents visual work.
#
# This script is the single owner of the artifact store format (schema
# fm-artifact-revision.v1), the listing format (schema fm-artifact-list.v1),
# the captain's verdicts and review waits (schemas fm-artifact-review.v1 and
# fm-artifact-reviews.v1), and the presentation-mode decision.
#
# Usage:
#   fm-artifact.sh present (--task <id> | --chat) <html-file>
#                  [--name <name>] [--title <title>] [--note <text>] [--assets <dir>]
#                  [--accept-layout] [--covers <task-id,...>] [--fyi | --for-review]
#                  [--addressed <t1,t2>] [--reply <t3>=<text>]
#   fm-artifact.sh verdict --task <id> --name <name> --rev <n>
#                  --verdict approve|changes|comment|not-now
#                  [--threads <t1,t2>] [--until YYYY-MM-DD] [--message <id>]
#   fm-artifact.sh handled --task <id> [--name <name> --rev <n>]
#                  (--promoted | --linked <task-id> | --reason <text>)
#   fm-artifact.sh withdraw --task <id> --name <name> --reason <text> [--by captain]
#   fm-artifact.sh reviews [--task <id>] [--json [--calls-json <file>]]
#   fm-artifact.sh reviews [--task <id>] (--unhandled | --owed) [--older-than <minutes>]
#   fm-artifact.sh waiting <task-id>
#   fm-artifact.sh list [--json]
#   fm-artifact.sh mode
#
# present
#   Copies the HTML file, plus the contents of --assets when given, into a new
#   immutable revision and returns at once; nothing blocks on the review, which
#   is tracked as a wait instead (REVIEW WAITS below).
#   --task attaches the artifact to a task this home knows (state/<id>.meta or
#   data/<id>/ exists); --chat attaches it to the first mate's conversation.
#   --name defaults to the file name without its extension, lowercased with
#   every run of other characters folded to "-"; it must match
#   [a-z0-9][a-z0-9-]{0,63}.
#   --title defaults to the document's <title>, then to the name.
#   --note says what changed since the previous revision.
#   --covers names the captain calls this page argues. It is kept for one
#   release as a shim: after the revision exists (or is unchanged), each named
#   call gets this page attached through
#   `fm-captain-hold.sh evidence <task> add page:<this page>`, which owns call
#   evidence; the revision itself records nothing about it. A page presented on
#   the task a call names as its --origin argues that call already. If
#   attaching fails the present still stands, and the command exits 1 naming
#   the call, so a retry is safe.
#   --addressed names the review comments this revision answers, and --reply
#   answers one in words without changing the page (repeat it per comment).
#   Both take the comment ids the captain's review carries (t1, t2, ...), and
#   naming one twice, or an id that is not one, is refused. They are recorded on
#   the revision, so the review screen can show each comment as answered next to
#   what the captain asked. Answering is a claim about this revision only:
#   whether a comment is settled stays the captain's call.
#   --assets copies that directory's contents beside the HTML so relative
#   references keep working; the HTML file wins a name clash. A diagram the page
#   owns ships this way too: include the Excalidraw scene file, show a picture of
#   it in the page, and mark that picture
#   `data-quarterdeck-scene="<scene file>"` with an optional
#   `data-quarterdeck-scene-label="<name>"`. The page stays a plain picture
#   wherever it is opened, and the review screen opens the real scene, so the
#   captain can change it and send the change back with their review. Symbolic links
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
#   Whether the page waits for the captain's review (REVIEW WAITS below) is
#   recorded on the revision. A task page waits unless its task is a ship (its
#   meta says kind=ship): a scout's or a queued task's page is work the captain asked to
#   see, while a ship's pages argue a change whose own review is its merge. A
#   chat page never waits, since it is discussion. --fyi presents a task page
#   for reference only, and --for-review makes a ship's page wait.
#   Output: "presented: <name> rev <n>" or "unchanged: <name> rev <n>", then
#   "entry: <absolute path of the revision's HTML>".
#
# REVIEW WAITS AND VERDICTS.
# A task page the captain has not reviewed is something the captain owes, as surely as a
# call, and nothing may file it away unread. This script owns that fact: which
# revision waits, what the captain said about each one, and what the first mate
# did about it. It never reads prose and never dispatches anything.
#   A revision waits when its revision.json says awaits_review (see present; a
#   revision written before the field existed does not) and it is the page's
#   latest revision, until one of these retires it: a
#   verdict other than not-now on that revision, a `sent` review of it in the
#   app's own review.jsonl, a withdrawal of it, or an answer to a captain call
#   that carries the page as evidence given at or after the revision was
#   presented. A newer revision opens a new wait in its place, so a task has at
#   most one wait per page, never one per revision.
#   Where a wait stands is its bucket: `call` while an open captain call carries
#   the page (the call's card already shows it, so it asks nothing twice),
#   `dated` while a not-now verdict's date is still ahead of the captain's day,
#   `aged` once it has waited FM_SNAPSHOT_UNDATED_HOLD_AGE_DAYS days (default 14,
#   the ruler an undated captain hold ages by; a lapsed not-now counts from its
#   date), else `live`.
# verdict
#   The one intake for the captain's verdict on a revision, called when a review
#   is sent. approve authorizes building what the page proposes, and nothing
#   else does; changes and comment send the page back to its author; not-now
#   keeps the wait but puts it off until --until, a day after the captain's
#   (bin/fm-backlog-parse-lib.sh owns it). --threads names the comment ids the
#   review carried. An exact repeat prints "unchanged:". A verdict other than
#   not-now lifts the review dispatch hold teardown put on the task's row (see
#   bin/fm-backlog-transition-lib.sh) once none of its pages waits any more, so
#   a returned page can go back to its author; a captain hold is never touched,
#   so a task held for a decision takes a review without its call being
#   released. Output: "recorded: <task> <name> rev <n> <verdict>" then
#   "author: live|retired", whether the task still has a worker to relay to.
# handled
#   Records what the first mate did with the captain's newest review of a page,
#   which is what stops `reviews --owed` listing it: --promoted (the task was
#   promoted in place into the build; approve only; bin/fm-promote.sh records it
#   itself), --linked <task-id> (a build filed separately carries it; approve
#   only), or --reason <text> (why not, or how it was answered instead). Without
#   --name and --rev it applies to every unhandled review on the task that the
#   action fits. A comments or changes review is also handled, with no record,
#   by the next revision presented after it.
# withdraw
#   Retires a page's wait with a reason the captain can see, and counts as
#   handling its newest review. --by captain records that the captain closed the
#   page. A later revision opens a new wait.
# reviews
#   The standing of every task page. --json prints
#   {schema:"fm-artifact-reviews.v1", captain_day, pages:[{task, name, title,
#   rev, presented_at, awaits_review, wait, verdict, unhandled, carried}]} where
#   wait is null or {rev, since, bucket, until, call}, verdict is the newest
#   verdict record, unhandled is null or {rev, verdict, threads, at, message,
#   author ("live"|"retired"), needs ("promote"|"relay")} for the newest review
#   no one has acted on, and carried is the comment ids an approval carried into
#   the build. --calls-json hands in `fm-captain-hold.sh list --json` output
#   already read (the fleet snapshot does); otherwise it is read when needed.
#   --unhandled prints one `<task>\t<name>\t<rev>\t<verdict>\t<threads>\t<author>\t<at>`
#   line per unhandled review. --owed prints the same lines for what the first
#   mate owes now: every unhandled approval, and every unhandled comments or
#   changes review whose author is retired, since a live author gets it relayed
#   and answers with a revision. --older-than skips reviews younger than that.
#   bin/fm-wake-drain.sh prints --owed as UNHANDLED REVIEWS.
# waiting
#   The predicate a closer asks before it retires a task's row: exit 0 when a
#   page of the task waits in the live, aged, or dated bucket (printing
#   "<name> rev <n>" per page), 1 when none does, 2 when it cannot tell.
#   bin/fm-teardown.sh keeps such a row open, and bin/fm-tasks-axi.sh refuses to
#   close it; withdraw is the way to let it go.
# Verdict store: <artifact-dir>/verdicts.jsonl, append-only, one
#   {schema:"fm-artifact-review.v1", kind, at, rev, ...} object per line:
#   kind "verdict" {verdict, threads, until, message}, kind "handled" {action
#   ("promoted"|"linked"|"reason"), link, reason}, kind "withdrawn" {reason, by}.
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
# ({role:"crew",task:<FM_TASK_ID>} or {role:"firstmate"}), answers ({addressed:[<comment id>], replies:[{thread,body}]}), layout
# ({status:"clean"|"accepted"|"skipped", reason (skipped only),
# issues:[{viewport:"wide"|"narrow", rule, selector, detail}]}), awaits_review
# (whether this revision waits for the captain's review; see present and REVIEW
# WAITS).
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
# cap, bad mode) or a --covers attachment failed after the present; 2 usage;
# 3 refused for layout findings.
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
# shellcheck source=bin/fm-backlog-parse-lib.sh
. "$SCRIPT_DIR/fm-backlog-parse-lib.sh"  # fm_captain_day: the one owner of the captain's day
# shellcheck source=bin/fm-tasks-axi-lib.sh
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
# shellcheck source=bin/fm-backlog-transition-lib.sh
. "$SCRIPT_DIR/fm-backlog-transition-lib.sh"  # the review dispatch hold on a task's row

usage() {
  sed -n '10,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "fm-artifact: $*" >&2
  exit 1
}

now_utc() {
  if [ -n "${FM_ARTIFACT_NOW:-}" ]; then printf '%s\n' "$FM_ARTIFACT_NOW"; else date -u +%Y-%m-%dT%H:%M:%SZ; fi
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

# Total size in bytes of the regular files under <dir>, read from their sizes
# rather than their contents, so measuring a mistaken huge directory is cheap.
tree_bytes() {  # <dir>
  find "$1" -type f -exec wc -c {} + 2>/dev/null \
    | awk '$2 != "total" { sum += $1 } END { printf "%d\n", sum }'
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

# Stop one headless Chrome and everything it started, for certain. The browser
# is asked first, since it tidies up its own helpers; if it is still there after
# a few seconds it is killed, and so is any helper it left. A bare `wait` after a
# single polite signal could wait forever, and the check is meant to fail open.
stop_chrome() {  # <pid>
  local pid=$1 helpers tries=0
  helpers=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ')
  kill "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null && [ "$tries" -lt 15 ]; do
    sleep 0.2
    tries=$((tries + 1))
  done
  helpers="$helpers $(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ')"
  kill -KILL "$pid" 2>/dev/null
  for helper in $helpers; do
    kill -KILL "$helper" 2>/dev/null
  done
  wait "$pid" 2>/dev/null
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
  stop_chrome "$pid"
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
  local task='' chat=0 file='' name='' title='' note='' assets='' accept_layout=0 scope art_dir stage digest latest latest_sha source_bytes
  local n tries entry bytes presented_by rev_dir now layout answered='' replies='[]' reply_id reply_body id covers= fyi=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) [ $# -ge 2 ] || usage; task=$2; shift 2 ;;
      --chat) chat=1; shift ;;
      --name) [ $# -ge 2 ] || usage; name=$2; shift 2 ;;
      --title) [ $# -ge 2 ] || usage; title=$2; shift 2 ;;
      --note) [ $# -ge 2 ] || usage; note=$2; shift 2 ;;
      --assets) [ $# -ge 2 ] || usage; assets=$2; shift 2 ;;
      --accept-layout) accept_layout=1; shift ;;
      --fyi) [ "$fyi" != review ] || die "--fyi and --for-review are opposites"; fyi=1; shift ;;
      --for-review) [ "$fyi" != 1 ] || die "--fyi and --for-review are opposites"; fyi=review; shift ;;
      --covers)
        [ $# -ge 2 ] || usage
        for id in $(printf '%s' "$2" | tr ',' ' '); do
          fm_task_id_path_safe "$id" || die "invalid task id '$id' in --covers"
          case " $covers " in *" $id "*) die "--covers names '$id' twice" ;; esac
          covers="$covers $id"
        done
        shift 2
        ;;
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
    # Measured before anything is copied: a mistaken --assets (a repo root, a
    # home folder) is refused here instead of being copied onto the home's disk.
    source_bytes=$(( $(tree_bytes "$assets") + $(wc -c < "$file") ))
    [ "$source_bytes" -le "$MAX_BYTES" ] || die "revision would be $source_bytes bytes, over the $MAX_BYTES byte cap (FM_ARTIFACT_MAX_BYTES); present a smaller assets directory"
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
  # Checked again on the copy itself: the source can change between the first
  # look and the copy, and only plain files and folders belong in a revision.
  [ -z "$(find "$stage/files" ! -type f ! -type d -print -quit)" ] \
    || die "--assets contains symbolic links or special files, which are refused: $assets"

  bytes=$(tree_bytes "$stage/files")
  [ "$bytes" -le "$MAX_BYTES" ] || die "revision is $bytes bytes, over the $MAX_BYTES byte cap (FM_ARTIFACT_MAX_BYTES); present a smaller assets directory"

  digest=$(tree_digest "$stage/files") || die "cannot digest the revision"
  latest=$(latest_rev "$art_dir")
  if [ "$latest" -gt 0 ]; then
    latest_sha=$(jq -r '.sha256 // empty' "$art_dir/rev-$latest/revision.json" 2>/dev/null)
    if [ "$latest_sha" = "$digest" ]; then
      printf 'unchanged: %s rev %s\n' "$name" "$latest"
      printf 'entry: %s\n' "$art_dir/rev-$latest/files/$(jq -r '.entry' "$art_dir/rev-$latest/revision.json")"
      attach_covers "$scope" "$task" "$name" "$covers"
      return
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

  if [ "$fyi" = review ]; then
    fyi=0
  elif [ "$fyi" = 0 ] && [ "$scope" = task ] && [ -f "$STATE/$task.meta" ] \
      && [ "$(sed -n 's/^kind=//p' "$STATE/$task.meta" | tail -n 1)" = ship ]; then
    fyi=1
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
  now=$(now_utc)
  jq -n \
    --arg scope "$scope" \
    --argjson fyi "$fyi" \
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
      presented_at:$presented_at, presented_by:$presented_by,
      answers:$answers, layout:$layout,
      awaits_review:($scope == "task" and $fyi == 0)}' \
    > "$rev_dir/.revision.json.tmp" || die "cannot write revision $n"
  mv "$rev_dir/.revision.json.tmp" "$rev_dir/revision.json" || die "cannot publish revision $n"

  printf 'presented: %s rev %s\n' "$name" "$n"
  printf 'entry: %s\n' "$rev_dir/files/$entry"
  attach_covers "$scope" "$task" "$name" "$covers"
}

# The one-release --covers shim: attach this page to each named call through
# the call's only writer. Returns 1 when any attachment failed.
attach_covers() {  # <scope> <task> <name> <space-separated call ids>
  local scope=$1 task=$2 name=$3 covers=$4 ref id failed=0
  [ -n "${covers# }" ] || return 0
  if [ "$scope" = chat ]; then ref="page:chat/$name"; else ref="page:task/$task/$name"; fi
  for id in $covers; do
    FM_STATE_OVERRIDE="$STATE" FM_DATA_OVERRIDE="$DATA" \
      "$SCRIPT_DIR/fm-captain-hold.sh" evidence "$id" add "$ref" >/dev/null || {
      echo "fm-artifact: the page is presented, but it could not be attached to call '$id' (see above)" >&2
      failed=1
    }
  done
  return "$failed"
}

# Every revision record in the store, one path per line, in a stable order.
revision_paths() {
  {
    find "$DATA" -mindepth 5 -maxdepth 5 -path "$DATA/*/artifacts/*/rev-*/revision.json" -type f 2>/dev/null
    find "$DATA" -mindepth 4 -maxdepth 4 -path "$DATA/.artifacts/*/rev-*/revision.json" -type f 2>/dev/null
  } | LC_ALL=C sort
}

# One revision record, checked against where it sits and given its paths. A
# record that disagrees with its own location is not one this script wrote.
# shellcheck disable=SC2016 # jq, not the shell, expands $path, $p, $loc, and $data.
REVISION_FILTER='
  (input_filename) as $path
  | ($path | ltrimstr($data + "/") | split("/")) as $p
  | (if $p[0] == ".artifacts"
     then {scope:"chat", task:null, name:$p[1], rev:$p[2]}
     else {scope:"task", task:$p[0], name:$p[2], rev:$p[3]} end) as $loc
  | select(.schema == "fm-artifact-revision.v1"
           and .scope == $loc.scope and .task == $loc.task and .name == $loc.name
           and ("rev-" + (.rev | tostring)) == $loc.rev
           and (.entry | type) == "string" and (.entry | test("^[^/]+$")))
  | . + {path:(($path | rtrimstr("/revision.json")) + "/files/" + .entry),
         dir:($path | rtrimstr("/revision.json") | sub("/rev-[0-9]+$"; ""))}'

# The records for the paths on stdin. The fleet snapshot lists the store every
# time it runs and revisions are never deleted, so the records are read in one
# jq rather than one per file. jq reads its files as one stream, though, so a
# single damaged record would fail the whole read; when it does, the records are
# read again one at a time and only the damaged one is left out.
revision_records() {
  local paths records
  paths=$(cat)
  [ -n "$paths" ] || return 0
  # Held until the whole read succeeds, so a failed pass never leaves half its records behind.
  if records=$(printf '%s\n' "$paths" | tr '\n' '\0' | xargs -0 jq -c --arg data "$DATA" "$REVISION_FILTER" 2>/dev/null); then
    [ -z "$records" ] || printf '%s\n' "$records"
    return 0
  fi
  printf '%s\n' "$paths" | while IFS= read -r path; do
    jq -c --arg data "$DATA" "$REVISION_FILTER" "$path" 2>/dev/null
  done
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
    records=$(revision_paths | revision_records | jq -s '
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

# --- review waits and verdicts (REVIEW WAITS in the header) -----------------

REVIEW_SCHEMA=fm-artifact-review.v1

# The directory of a task page with at least one complete revision, or die.
task_page_dir() {  # <task> <name>
  local task=$1 name=$2 dir
  fm_task_id_path_safe "$task" || die "invalid task id '$task'"
  name_valid "$name" || die "invalid artifact name '$name' (expected [a-z0-9][a-z0-9-]{0,63})"
  dir="$DATA/$task/artifacts/$name"
  [ "$(latest_rev "$dir" 2>/dev/null)" -gt 0 ] 2>/dev/null || die "task '$task' has no presented page '$name'"
  printf '%s\n' "$dir"
}

# A whole revision number: 1, 2, ...
rev_valid() {  # <rev>
  case "$1" in ''|0*|*[!0-9]*) return 1 ;; esac
}

# Every record in a page's verdict store, oldest first; a damaged line is skipped.
verdict_log() {  # <artifact-dir>
  [ -f "$1/verdicts.jsonl" ] || return 0
  jq -cR --arg schema "$REVIEW_SCHEMA" 'fromjson? | select(type == "object" and .schema == $schema)' "$1/verdicts.jsonl" 2>/dev/null
}

append_review_record() {  # <artifact-dir> <json>
  printf '%s\n' "$2" >> "$1/verdicts.jsonl" || die "cannot write $1/verdicts.jsonl"
}

# Does the task still have a worker to relay a review to?
author_state() {  # <task>
  if [ -f "$STATE/$1.meta" ]; then printf 'live\n'; else printf 'retired\n'; fi
}

known_task() {  # <task>
  [ -f "$STATE/$1.meta" ] || [ -d "$DATA/$1" ] && return 0
  fm_backlog_row_probe "$DATA" "$1" >/dev/null 2>&1 && [ "$FM_BACKLOG_ROW_RESULT" = found ]
}

# The comma list of review comment ids as a JSON array, refusing a bad or repeated id.
threads_json() {  # <comma list>
  local id seen='' out='[]'
  for id in $(printf '%s' "$1" | tr ',' ' '); do
    comment_id_valid "$id" || die "'$id' is not a review comment id (expected t1, t2, ...)"
    case " $seen " in *" $id "*) die "--threads names '$id' twice" ;; esac
    seen="$seen $id"
    out=$(printf '%s' "$out" | jq -c --arg id "$id" '. + [$id]')
  done
  printf '%s\n' "$out"
}

# Lift the review dispatch hold on the task's row once none of its pages waits.
# A captain hold is never touched. Best effort: the verdict is already recorded,
# and a hold left behind is visible on the row and in `reviews`.
release_review_hold() {  # <task>
  local task=$1 rc=0
  fm_backlog_transition_applies "$CONFIG" "$DATA" scout >/dev/null 2>&1 || return 0
  waiting_pages "$task" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ] || return 0
  fm_backlog_review_unhold "$DATA" "$task" \
    || echo "fm-artifact: warning: could not lift the review hold on $task's backlog row (${FM_BACKLOG_TRANSITION_ERROR:-unknown error}); lift it with bin/fm-tasks-axi.sh unhold $task" >&2
}

cmd_verdict() {
  local task='' name='' rev='' verdict='' threads='' until='' message='' dir today record last
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) [ $# -ge 2 ] || usage; task=$2; shift 2 ;;
      --chat) die "a chat page is discussion: its review reaches the first mate in the conversation, and nothing waits on it" ;;
      --name) [ $# -ge 2 ] || usage; name=$2; shift 2 ;;
      --rev) [ $# -ge 2 ] || usage; rev=$2; shift 2 ;;
      --verdict) [ $# -ge 2 ] || usage; verdict=$2; shift 2 ;;
      --threads) [ $# -ge 2 ] || usage; threads=$2; shift 2 ;;
      --until) [ $# -ge 2 ] || usage; until=$2; shift 2 ;;
      --message) [ $# -ge 2 ] || usage; message=$2; shift 2 ;;
      -h|--help) usage ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
  [ -n "$task" ] && [ -n "$name" ] && [ -n "$rev" ] && [ -n "$verdict" ] || usage
  dir=$(task_page_dir "$task" "$name") || exit 1
  rev_valid "$rev" || die "--rev takes a revision number, got '$rev'"
  [ -f "$dir/rev-$rev/revision.json" ] || die "page '$name' of task '$task' has no revision $rev"
  case "$verdict" in
    approve|changes|comment|not-now) ;;
    *) die "unknown verdict '$verdict' (expected approve, changes, comment, or not-now)" ;;
  esac
  threads=$(threads_json "$threads") || exit 1
  if [ "$verdict" = not-now ]; then
    [ -n "$until" ] || die "not-now puts the review off to a day: give --until YYYY-MM-DD"
    printf '%s' "$until" | LC_ALL=C grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || die "--until takes YYYY-MM-DD, got '$until'"
    today=$(fm_captain_day "$(now_utc)") || die "cannot read the captain's day"
    [[ "$until" > "$today" ]] || die "--until $until is not after the captain's day ($today), so the review would be due at once"
  else
    [ -z "$until" ] || die "--until belongs to a not-now verdict only"
  fi
  if [ -n "$message" ]; then
    printf '%s' "$message" | LC_ALL=C grep -Eq '^[A-Za-z0-9._:-]{1,128}$' || die "--message takes a message id, got '$message'"
  fi
  record=$(jq -cn --arg schema "$REVIEW_SCHEMA" --arg at "$(now_utc)" --argjson rev "$rev" \
    --arg verdict "$verdict" --argjson threads "$threads" --arg until "$until" --arg message "$message" \
    '{schema:$schema, kind:"verdict", at:$at, rev:$rev, verdict:$verdict, threads:$threads,
      until:(if $until == "" then null else $until end),
      message:(if $message == "" then null else $message end)}')
  last=$(verdict_log "$dir" | tail -n 1)
  if [ -n "$last" ] && [ "$(printf '%s' "$last" | jq -c 'del(.at)')" = "$(printf '%s' "$record" | jq -c 'del(.at)')" ]; then
    printf 'unchanged: %s %s rev %s %s\n' "$task" "$name" "$rev" "$verdict"
  else
    append_review_record "$dir" "$record"
    printf 'recorded: %s %s rev %s %s\n' "$task" "$name" "$rev" "$verdict"
  fi
  printf 'author: %s\n' "$(author_state "$task")"
  [ "$verdict" = not-now ] || release_review_hold "$task"
}

cmd_handled() {
  local task='' name='' rev='' action='' link='' reason='' reviews record count=0 row page page_rev
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) [ $# -ge 2 ] || usage; task=$2; shift 2 ;;
      --name) [ $# -ge 2 ] || usage; name=$2; shift 2 ;;
      --rev) [ $# -ge 2 ] || usage; rev=$2; shift 2 ;;
      --promoted) [ -z "$action" ] || die "name one action"; action=promoted; shift ;;
      --linked) [ $# -ge 2 ] || usage; [ -z "$action" ] || die "name one action"; action=linked; link=$2; shift 2 ;;
      --reason) [ $# -ge 2 ] || usage; [ -z "$action" ] || die "name one action"; action=reason; reason=$2; shift 2 ;;
      -h|--help) usage ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
  [ -n "$task" ] && [ -n "$action" ] || usage
  fm_task_id_path_safe "$task" || die "invalid task id '$task'"
  if [ -n "$name" ] || [ -n "$rev" ]; then
    [ -n "$name" ] && [ -n "$rev" ] || die "--name and --rev go together"
    task_page_dir "$task" "$name" >/dev/null || exit 1
    rev_valid "$rev" || die "--rev takes a revision number, got '$rev'"
  fi
  case "$action" in
    linked)
      fm_task_id_path_safe "$link" || die "invalid task id '$link'"
      [ "$link" != "$task" ] || die "--linked names another task; use --promoted when the task itself became the build"
      known_task "$link" || die "unknown task '$link' (no state/$link.meta, data/$link/, or backlog row)"
      ;;
    reason)
      reason=$(printf '%s' "$reason" | tr '\n\r\t' '   ')
      [ -n "${reason// /}" ] || die "--reason says nothing"
      ;;
  esac
  reviews=$(compute_reviews "$task" '' 0) || die "cannot read the reviews of task '$task'"
  while IFS=$'\t' read -r page page_rev row; do
    [ -n "$page" ] || continue
    if [ -n "$name" ] && { [ "$page" != "$name" ] || [ "$page_rev" != "$rev" ]; }; then continue; fi
    if [ "$action" != reason ] && [ "$row" != promote ]; then
      [ -z "$name" ] || die "$task $name rev $rev is a $row review: --$action fits an approval only; record what was done with --reason"
      continue
    fi
    record=$(jq -cn --arg schema "$REVIEW_SCHEMA" --arg at "$(now_utc)" --argjson rev "$page_rev" \
      --arg action "$action" --arg link "$link" --arg reason "$reason" \
      '{schema:$schema, kind:"handled", at:$at, rev:$rev, action:$action,
        link:(if $link == "" then null else $link end),
        reason:(if $reason == "" then null else $reason end)}')
    append_review_record "$DATA/$task/artifacts/$page" "$record"
    printf 'handled: %s %s rev %s %s\n' "$task" "$page" "$page_rev" "$action"
    count=$((count + 1))
  done <<EOT
$(printf '%s' "$reviews" | jq -r '.pages[] | select(.unhandled != null) | [.name, (.unhandled.rev | tostring), .unhandled.needs] | @tsv')
EOT
  if [ "$count" -eq 0 ]; then
    [ -z "$name" ] || die "no unhandled review of $task $name rev $rev"
    printf 'handled: nothing unhandled on %s\n' "$task"
  fi
}

cmd_withdraw() {
  local task='' name='' reason='' by=firstmate dir rev
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) [ $# -ge 2 ] || usage; task=$2; shift 2 ;;
      --name) [ $# -ge 2 ] || usage; name=$2; shift 2 ;;
      --reason) [ $# -ge 2 ] || usage; reason=$2; shift 2 ;;
      --by) [ $# -ge 2 ] || usage; by=$2; shift 2 ;;
      -h|--help) usage ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
  [ -n "$task" ] && [ -n "$name" ] || usage
  case "$by" in firstmate|captain) ;; *) die "--by takes captain (the captain closed the page), got '$by'" ;; esac
  reason=$(printf '%s' "$reason" | tr '\n\r\t' '   ')
  [ -n "${reason// /}" ] || die "withdrawing a page needs a --reason the captain can read"
  dir=$(task_page_dir "$task" "$name") || exit 1
  rev=$(latest_rev "$dir")
  append_review_record "$dir" "$(jq -cn --arg schema "$REVIEW_SCHEMA" --arg at "$(now_utc)" --argjson rev "$rev" \
    --arg reason "$reason" --arg by "$by" '{schema:$schema, kind:"withdrawn", at:$at, rev:$rev, reason:$reason, by:$by}')"
  printf 'withdrawn: %s %s rev %s\n' "$task" "$name" "$rev"
  release_review_hold "$task"
}

# shellcheck disable=SC2016 # jq, not the shell, expands these variables.
REVIEWS_JQ="$FM_CAPTAIN_DAY_JQ"'
  def epoch($d):
    if ($d | type) != "string" then null
    elif ($d | test("T")) then (try ($d | fromdateiso8601) catch null)
    else (try (($d + "T00:00:00Z") | fromdateiso8601) catch null) end;
  ($calls[0] // []) as $calls
  | ($live[0] // []) as $live
  | ($events[0] // []) as $events
  | {schema:"fm-artifact-reviews.v1", captain_day:$today,
     pages:([$records[0][] | select(.scope == "task")] | group_by(.dir) | map(
       sort_by(.rev) as $rs | ($rs | last) as $L | $L.dir as $dir
       | ($events | map(select(.file == ($dir + "/verdicts.jsonl")) | .e) | to_entries | map(.value + {seq:.key})) as $log
       | ($events | map(select(.file == ($dir + "/review.jsonl")) | .e.rev)) as $sent
       | ("page:task/" + $L.task + "/" + $L.name) as $ref
       | ($log | map(select(.kind == "verdict"))) as $verdicts
       | ($verdicts | map(select(.verdict != "not-now"))) as $reviews
       | ($verdicts | map(select(.verdict == "not-now" and .rev == $L.rev)) | last) as $notnow
       | ($calls | map(select(any((.evidence // [])[]; . == $ref)))) as $argued
       | (if $L.awaits_review != true then null
          elif any($sent[]; . == $L.rev) or any($reviews[]; .rev == $L.rev) then null
          elif any($log[]; .kind == "withdrawn" and .rev >= $L.rev) then null
          elif any($argued[]; (.answer.at // null) != null and .answer.at >= $L.presented_at) then null
          else
            ([$argued[] | select(.state == "open")] | first) as $call
            | (if $notnow != null then $notnow.until else $L.presented_at end) as $since
            | {rev:$L.rev, since:$since, until:($notnow.until // null), call:($call.id // null),
               bucket:(if $call != null then "call"
                       elif $notnow != null and $notnow.until > $today then "dated"
                       elif (epoch($since) // $now_epoch) <= ($now_epoch - $age_days * 86400) then "aged"
                       else "live" end)}
          end) as $wait
       | ($reviews | last) as $v
       | (if $v == null then null
          elif any($log[]; (.kind == "handled" or .kind == "withdrawn") and .seq > $v.seq) then null
          elif $v.verdict != "approve" and any($rs[]; .rev > $v.rev and .presented_at >= $v.at) then null
          else {rev:$v.rev, verdict:$v.verdict, threads:($v.threads // []), at:$v.at, message:($v.message // null),
                author:(if any($live[]; . == $L.task) then "live" else "retired" end),
                needs:(if $v.verdict == "approve" then "promote" else "relay" end)}
          end) as $unhandled
       | ($log | map(select(.kind == "handled" and (.action == "promoted" or .action == "linked"))) | last) as $carry
       | {task:$L.task, name:$L.name, title:$L.title, rev:$L.rev, presented_at:$L.presented_at,
          awaits_review:($L.awaits_review == true), wait:$wait,
          verdict:($verdicts | last | if . == null then null else del(.schema, .kind, .seq) end),
          unhandled:$unhandled,
          carried:(if $carry == null then []
                   else ([$reviews[] | select(.verdict == "approve" and .rev == $carry.rev and .seq < $carry.seq)] | last | .threads // [])
                   end)})
       | sort_by(.presented_at) | reverse)}'

# The standing of every task page (or one task's) as fm-artifact-reviews.v1.
# <want-waits> 0 skips reading captain calls, which only a wait needs.
compute_reviews() {  # <task or ''> <calls-json file or ''> <want-waits 0|1>
  local filter=$1 calls_file=$2 want_waits=$3 scratch paths files meta rc=0
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/fm-artifact-reviews.XXXXXX") || return 1
  paths=$(revision_paths | grep -F "/artifacts/" | grep -v -F "$DATA/.artifacts/")
  if [ -n "$filter" ]; then
    paths=$(printf '%s\n' "$paths" | grep -F "$DATA/$filter/artifacts/")
  fi
  printf '%s\n' "$paths" | revision_records | jq -s '.' > "$scratch/records.json" || rc=1
  files=$(jq -r '.[].dir' "$scratch/records.json" 2>/dev/null | LC_ALL=C sort -u | while IFS= read -r dir; do
    [ -f "$dir/verdicts.jsonl" ] && printf '%s\n' "$dir/verdicts.jsonl"
    [ -f "$dir/review.jsonl" ] && printf '%s\n' "$dir/review.jsonl"
  done)
  if [ -n "$files" ]; then
    printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 jq -cnR --arg schema "$REVIEW_SCHEMA" '
      [inputs as $line | input_filename as $file | ($line | fromjson?) as $e
       | select($e | type == "object")
       | if ($file | endswith("/review.jsonl")) then select($e.kind == "sent") | {file:$file, e:{rev:$e.rev}}
         else select($e.schema == $schema) | {file:$file, e:$e} end]' > "$scratch/events.json" 2>/dev/null \
      || printf '[]\n' > "$scratch/events.json"
  else
    printf '[]\n' > "$scratch/events.json"
  fi
  for meta in "$STATE"/*.meta; do
    [ -f "$meta" ] || continue
    meta=${meta##*/}
    printf '%s\n' "${meta%.meta}"
  done | jq -Rsc 'split("\n") | map(select(. != ""))' > "$scratch/live.json"
  printf '[]\n' > "$scratch/calls.json"
  if [ "$want_waits" = 1 ] && jq -e 'any(.[]; .awaits_review == true)' "$scratch/records.json" >/dev/null 2>&1; then
    if [ -n "$calls_file" ]; then
      jq -c '.calls // []' "$calls_file" > "$scratch/calls.json" 2>/dev/null || printf '[]\n' > "$scratch/calls.json"
    elif ! FM_HOME="$FM_HOME" FM_STATE_OVERRIDE="$STATE" FM_DATA_OVERRIDE="$DATA" \
        "$SCRIPT_DIR/fm-captain-hold.sh" list --json 2>/dev/null | jq -c '.calls // []' > "$scratch/calls.json" 2>/dev/null; then
      # Without the calls a page an answered call settled reads as still
      # waiting: kept, never silently filed away.
      printf '[]\n' > "$scratch/calls.json"
    fi
  fi
  if [ "$rc" -eq 0 ]; then
    local now
    now=$(now_utc)
    jq -n --slurpfile records "$scratch/records.json" --slurpfile events "$scratch/events.json" \
      --slurpfile live "$scratch/live.json" --slurpfile calls "$scratch/calls.json" \
      --arg today "$(fm_captain_day "$now")" --argjson now_epoch "$(jq -rn --arg n "$now" '$n | fromdateiso8601')" \
      --argjson age_days "${FM_SNAPSHOT_UNDATED_HOLD_AGE_DAYS:-14}" "$REVIEWS_JQ" || rc=1
  fi
  rm -rf -- "$scratch"
  return "$rc"
}

# Print "<name> rev <n>" for every page of the task whose wait keeps its row
# open (live, aged, or dated); exit 0 when there is one, 1 when none, 2 when the
# store cannot be read.
waiting_pages() {  # <task>
  local reviews out
  reviews=$(compute_reviews "$1" '' 1) || return 2
  out=$(printf '%s' "$reviews" | jq -r '.pages[] | select(.wait != null and (.wait.bucket == "live" or .wait.bucket == "aged" or .wait.bucket == "dated")) | "\(.name) rev \(.wait.rev)"') || return 2
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

cmd_waiting() {
  local rc=0
  [ $# -eq 1 ] || usage
  fm_task_id_path_safe "$1" || { echo "fm-artifact: invalid task id '$1'" >&2; exit 2; }
  waiting_pages "$1" || rc=$?
  [ "$rc" -ne 2 ] || echo "fm-artifact: cannot read the review waits of task '$1'" >&2
  exit "$rc"
}

cmd_reviews() {
  local task='' mode=text calls_file='' older=0 reviews cutoff
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) [ $# -ge 2 ] || usage; task=$2; fm_task_id_path_safe "$task" || die "invalid task id '$task'"; shift 2 ;;
      --json) mode=json; shift ;;
      --unhandled) mode=unhandled; shift ;;
      --owed) mode=owed; shift ;;
      --calls-json) [ $# -ge 2 ] || usage; calls_file=$2; shift 2 ;;
      --older-than)
        [ $# -ge 2 ] || usage
        older=$2
        case "$older" in ''|*[!0-9]*) die "--older-than takes a whole number of minutes, got '$older'" ;; esac
        shift 2
        ;;
      -h|--help) usage ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
  case "$mode" in
    unhandled|owed) reviews=$(compute_reviews "$task" '' 0) ;;
    *) reviews=$(compute_reviews "$task" "$calls_file" 1) ;;
  esac || die "cannot read the artifact store's reviews"
  case "$mode" in
    json) printf '%s\n' "$reviews" ;;
    unhandled|owed)
      cutoff=$(jq -rn --arg now "$(now_utc)" --argjson older "$older" '($now | fromdateiso8601) - $older * 60')
      printf '%s' "$reviews" | jq -r --arg mode "$mode" --argjson cutoff "$cutoff" '
        def clean: tostring | gsub("[[:cntrl:]]"; " ");
        .pages[] | .unhandled as $u | select($u != null)
        | select($mode == "unhandled" or $u.needs == "promote" or $u.author == "retired")
        | select(((try ($u.at | fromdateiso8601) catch null) // $cutoff) <= $cutoff)
        | [.task, .name, ($u.rev | tostring), $u.verdict,
           (if ($u.threads | length) == 0 then "-" else ($u.threads | join(",")) end), $u.author, $u.at]
        | map(clean) | join("\t")'
      ;;
    *)
      printf '%s' "$reviews" | jq -r '
        if (.pages | length) == 0 then "reviews: no task pages"
        else .pages[] | "task \(.task)  \(.name)  rev \(.rev)  wait: \(if .wait == null then "none" else .wait.bucket + (if .wait.until then " until " + .wait.until else "" end) end)  review: \(if .verdict == null then "none" else "\(.verdict.verdict) on rev \(.verdict.rev)" end)\(if .unhandled then "  unhandled (\(.unhandled.needs), author \(.unhandled.author))" else "" end)" end'
      ;;
  esac
}

[ $# -ge 1 ] || usage
sub=$1
shift
# `mode` only reads a setting, so bootstrap can ask it where pages go even when
# jq, which every other subcommand needs, is missing.
[ "$sub" = mode ] || command -v jq >/dev/null 2>&1 || die "jq is required"
case "$sub" in
  present) cmd_present "$@" ;;
  list) cmd_list "$@" ;;
  verdict) cmd_verdict "$@" ;;
  handled) cmd_handled "$@" ;;
  withdraw) cmd_withdraw "$@" ;;
  reviews) cmd_reviews "$@" ;;
  waiting) cmd_waiting "$@" ;;
  mode) [ $# -eq 0 ] || usage; cmd_mode ;;
  -h|--help) usage ;;
  *) usage ;;
esac
