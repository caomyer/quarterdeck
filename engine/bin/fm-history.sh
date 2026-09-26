#!/usr/bin/env bash
# fm-history.sh - every closed task of this home, newest first, paged.
#
# Usage: fm-history.sh --json [--repo <name>] [--limit <n>] [--after <task-id>]
#        fm-history.sh --help
#
# The fleet snapshot sees only the Done rows still in the backlog, and tasks-axi
# keeps just `done_keep` of those, moving older ones into the configured done
# archive. This command reads both, so a surface such as a per-project logbook
# can page through a home's whole closed history.
#
# Output contract: `--json` prints one object with schema `fm-history.v1`:
#   {schema:"fm-history.v1", repo:<name>|null, records:[...], calls:[...],
#    next:<task-id>|null, archive:{present:<bool>, readable:<bool>}}
#   records: closed rows only - the backlog's `## Done` section and every
#     `## Archived <date>` block of the done archive - each exactly the record
#     `fm-fleet-snapshot.sh --backlog-json` gives a Done row (id, title, state
#     "done", kind, repo, since, completion {verb, date}, pr_url, report_path,
#     hold_kind, hold_reason, current_role, body_lines, body_excerpt, and the
#     rest of that shape). Both read rows through bin/fm-backlog-parse-lib.sh,
#     the one backlog-row parser; its caller's header owns the field contract.
#     A backlog row is parsed from the backlog alone, exactly as the snapshot
#     parses it; an archived row is parsed with the backlog ahead of it, so a
#     blocker it names resolves against every row this home still records.
#     A row's `order` is its position in the file it was read from: the
#     backlog for a Done row, as in the snapshot, and the archive as written
#     for an archived row.
#     Only structured rows with an id are records: a free-form line has no id
#     to page by. A task id appears once, as its newest closed row; an older
#     archived copy of a task that was reopened and closed again is superseded.
#   repo: the --repo value, else null. With it, only records whose `repo` equals
#     the name exactly are returned; without it, every closed record.
#   calls: for the returned records that are captain calls, their call objects
#     exactly as `fm-captain-hold.sh list --json` shapes its `calls[]` items
#     (schema fm-call-list.v1), in record order. The page is handed to `list`
#     through its `--backlog-json` input with a `--since` window reaching back
#     past every returned close, so the answer {key, label, by, via, at} is
#     read by the one owner of answer parsing. What counts as a call is that
#     script's rule: a row held for the captain now or ever, or one carrying a
#     resolution block.
#   next: the id of the last returned record when more remain, else null.
#   archive.present is false when the archive file does not exist (normal for a
#     young home); archive.readable is false when it exists but cannot be read,
#     and the backlog's rows are still returned with exit 0.
#
# ORDER. Newest closed first: completion date (`completion.date`) descending,
# and within one date the more recently closed first. A row with no completion
# date sorts after every dated row. "More recently closed" is position, from
# how tasks-axi 0.2.4 writes these files (observed with `done` on twelve tasks
# in a scratch home carrying this repo's .tasks.toml, done_keep = 10):
#   - `done` inserts the closed row at the TOP of `## Done`, so the section
#     reads newest first;
#   - pruning keeps the top `done_keep` rows and appends the surplus rows, in
#     their section order, as one new `## Archived <date>` block at the END of
#     the archive, so later blocks are newer and each block reads newest first.
# The newest-first sequence is therefore the Done section top to bottom, then
# the archive's blocks from last to first, each top to bottom. Every row a
# prune moves is older than every row it leaves, so a close or prune between
# two pages never reorders rows already listed.
#
# PAGING. --limit defaults to 50 and must be 1..500. --after <task-id> returns
# the records after that id in the same order (after any --repo filter); an id
# that is not among them is a usage error. The cursor is an id, not an offset,
# so a task closing between pages lands ahead of the cursor instead of shifting
# the pages.
#
# ADDRESSING. The backlog and archive are found the way bin/fm-tasks-axi.sh
# finds them for this home: bin/fm-backlog-transition-lib.sh's
# fm_backlog_tasks_axi_addressing on the data directory (FM_DATA_OVERRIDE, else
# $FM_HOME/data) gives `<data>/backlog.md` and the addressing root, and
# bin/fm-tasks-axi-lib.sh's fm_tasks_axi_archive_resolve applies tasks-axi's own
# archive precedence from that root. An absent backlog file is a home with no
# closed rows of its own, not an error. A home whose configured tasks-axi
# backend is not markdown is refused with exit 1: its rows live in that
# backend's own store, which no parser here reads.
#
# READ-ONLY. Nothing under the home is created or written, no lock is taken,
# and tasks-axi is never run. The call listing runs `fm-captain-hold.sh list`,
# which reads a home without creating its state directory; the page it reads is
# staged in a private temporary directory that is removed on exit.
#
# FM_HISTORY_NOW (a UTC `YYYY-MM-DDTHH:MM:SSZ` timestamp) pins "now" for the
# rows' hold projection and the call window; FM_SNAPSHOT_UNDATED_HOLD_AGE_DAYS
# is read as the fleet snapshot reads it.
#
# Exit status: 0 success, 1 the backlog (or the jq it needs) cannot be read or
# the calls cannot be listed, 2 usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"

# shellcheck source=bin/fm-tasks-axi-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
# shellcheck source=bin/fm-backlog-transition-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-backlog-transition-lib.sh"
# shellcheck source=bin/fm-backlog-parse-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-backlog-parse-lib.sh"

HISTORY_LIMIT_DEFAULT=50
HISTORY_LIMIT_MAX=500

usage() {
  awk '
    NR == 1 { next }
    /^#/ { sub(/^# ?/, ""); print; next }
    { exit }
  ' "$0"
}

usage_fail() {
  printf 'fm-history: %s\n' "$*" >&2
  printf 'usage: fm-history.sh --json [--repo <name>] [--limit <n>] [--after <task-id>]\n' >&2
  exit 2
}

fail() {
  printf 'fm-history: %s\n' "$*" >&2
  exit 1
}

json=0
repo=
repo_set=0
limit=$HISTORY_LIMIT_DEFAULT
after=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --json) json=1 ;;
    --repo|--limit|--after)
      [ "$#" -ge 2 ] || usage_fail "$1 needs a value"
      case "$1" in
        --repo) repo=$2; repo_set=1 ;;
        --limit) limit=$2 ;;
        --after) after=$2 ;;
      esac
      shift
      ;;
    --repo=*) repo=${1#--repo=}; repo_set=1 ;;
    --limit=*) limit=${1#--limit=} ;;
    --after=*) after=${1#--after=} ;;
    *) usage_fail "unknown argument: $1" ;;
  esac
  shift
done

[ "$json" = 1 ] || usage_fail "--json is the only output; pass it"
if [ "$repo_set" = 1 ] && [ -z "$repo" ]; then
  usage_fail "--repo needs a project name"
fi
case "$limit" in
  ''|*[!0-9]*|????*) usage_fail "--limit takes a whole number from 1 to $HISTORY_LIMIT_MAX (got '$limit')" ;;
esac
limit=$((10#$limit))
if [ "$limit" -lt 1 ] || [ "$limit" -gt "$HISTORY_LIMIT_MAX" ]; then
  usage_fail "--limit takes a whole number from 1 to $HISTORY_LIMIT_MAX (got '$limit')"
fi

NOW=${FM_HISTORY_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
case "$NOW" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
  *) usage_fail "FM_HISTORY_NOW must be a UTC timestamp like 2026-09-18T12:00:00Z (got '$NOW')" ;;
esac
AGE_DAYS=${FM_SNAPSHOT_UNDATED_HOLD_AGE_DAYS:-14}
case "$AGE_DAYS" in
  ''|*[!0-9]*) usage_fail "FM_SNAPSHOT_UNDATED_HOLD_AGE_DAYS must be a non-negative integer" ;;
esac

command -v jq >/dev/null 2>&1 || fail "jq not found"

FM_BACKLOG_TRANSITION_ERROR=
if ! fm_backlog_tasks_axi_addressing "$DATA" 2>/dev/null; then
  fail "cannot read the backlog: ${FM_BACKLOG_TRANSITION_ERROR:-data directory cannot be resolved: $DATA}"
fi
if [ -z "$FM_BACKLOG_AXI_FILE" ]; then
  backend=$(fm_tasks_axi_backend "$FM_BACKLOG_AXI_ROOT" 2>/dev/null) || backend=unknown
  fail "history reads a markdown backlog and its done archive; this home's tasks-axi backend is '$backend'"
fi
BACKLOG=$FM_BACKLOG_AXI_FILE
ARCHIVE=$(fm_tasks_axi_archive_resolve "$FM_BACKLOG_AXI_ROOT" "$BACKLOG") \
  || fail "cannot resolve this home's done archive"

# The backlog is read once, so both parses below see the same text.
backlog_text=
if [ -e "$BACKLOG" ] || [ -L "$BACKLOG" ]; then
  { [ -f "$BACKLOG" ] && [ -r "$BACKLOG" ]; } || fail "cannot read the backlog at $BACKLOG"
  backlog_text=$(cat -- "$BACKLOG") || fail "cannot read the backlog at $BACKLOG"
fi

# The archive in file order, every `## Archived <date>` heading read as
# `## Done` so the shared parser reads its rows as closed, and each heading
# followed by a marker line naming its block. The parser keeps a marker as a
# free-form line, which is how the rows below learn their block (see ORDER);
# the markers are then dropped and every archived row's `order` is its position
# in the archive as written. Anything above the first heading belongs to no
# block and is dropped, as the parser drops it in a backlog.
BLOCK_MARK='@@fm-history-block'
archive_present=false
archive_readable=false
archive_text=
if [ -e "$ARCHIVE" ] || [ -L "$ARCHIVE" ]; then
  archive_present=true
  if [ -f "$ARCHIVE" ] && [ -r "$ARCHIVE" ] && archive_text=$(awk -v mark="$BLOCK_MARK" '
      /^##[[:space:]]+/ {
        n++
        if ($0 ~ /^##[[:space:]]+Archived([[:space:]]|$)/) print "## Done"
        else print
        print mark " " n
        next
      }
      n > 0 { print }
    ' "$ARCHIVE" 2>/dev/null); then
    archive_readable=true
  else
    archive_text=
  fi
fi

backlog_json=$(printf '%s\n' "$backlog_text" | fm_backlog_parse_json "$BACKLOG" "$NOW" "$AGE_DAYS") \
  || fail "cannot parse the backlog at $BACKLOG"
combined_json='{"records":[]}'
if [ -n "$archive_text" ]; then
  combined_json=$(printf '%s\n\n%s\n' "$backlog_text" "$archive_text" \
    | fm_backlog_parse_json "$ARCHIVE" "$NOW" "$AGE_DAYS") \
    || fail "cannot parse the done archive at $ARCHIVE"
fi

# shellcheck disable=SC2016 # jq, not the shell, expands these variables.
page=$(printf '%s\n%s\n' "$backlog_json" "$combined_json" | jq -c -n \
  --arg repo "$repo" --argjson by_repo "$repo_set" --argjson limit "$limit" --arg after "$after" \
  --arg mark "$BLOCK_MARK" '
  def closed: select(.structured == true and .id != null and .state == "done");
  def marker: .structured == false and (.raw | startswith($mark + " "));
  input as $backlog
  | input as $combined
  | ($backlog.records | length) as $n
  | [$backlog.records[] | closed]
    + ($combined.records[$n:]
       | reduce .[] as $r ({block: 0, marks: 0, out: []};
           if ($r | marker) then .block = ($r.raw | ltrimstr($mark + " ") | tonumber) | .marks += 1
           else . as $at
             | .out += [{block: $at.block, pos: (.out | length),
                         record: ($r | .order = (.order - $n - $at.marks))}]
           end)
       | .out
       | sort_by([-.block, .pos])
       | map(.record | closed))
  | . as $rows
  | [range(0; $rows | length) as $i | {rank: $i, record: $rows[$i]}]
  | reduce .[] as $row ({seen: {}, out: []};
      if .seen[$row.record.id] then .
      else .seen[$row.record.id] = true | .out += [$row] end)
  | .out
  | sort_by([(.record.completion.date // ""), -.rank]) | reverse
  | map(.record)
  | if $by_repo == 1 then map(select(.repo == $repo)) else . end
  | . as $ordered
  | (if $after == "" then 0
     else ((first(range(0; $ordered | length) as $i | select($ordered[$i].id == $after) | $i + 1)) // null)
     end) as $start
  | if $start == null then {unknown_after: true}
    else $ordered[$start:] as $rest
      | ($rest[:$limit]) as $records
      | {records: $records,
         next: (if ($rest | length) > $limit then $records[-1].id else null end)}
    end') || fail "cannot order the closed rows"

if [ "$(printf '%s\n' "$page" | jq -r '.unknown_after // false')" = true ]; then
  usage_fail "--after names no closed task in this listing: $after"
fi

calls='[]'
if printf '%s\n' "$page" | jq -e 'any(.records[];
    .hold_kind == "captain"
    or any(.body_lines[]?; test("^Resolution recorded by fm-(captain|decision)-hold\\.$")))' >/dev/null; then
  work=$(mktemp -d "${TMPDIR:-/tmp}/fm-history.XXXXXX") || fail "cannot stage the call listing"
  # shellcheck disable=SC2064 # expand now: the path is fixed for this run
  trap "rm -rf -- '$work'" EXIT
  printf '%s\n' "$page" | jq --arg path "$BACKLOG" '{path: $path, present: true, records: .records}' \
    > "$work/page.json" || fail "cannot stage the call listing"
  # A window reaching back past the epoch, so every returned close is inside it.
  since=$(jq -n --arg now "$NOW" '($now | fromdateiso8601 / 86400 | floor) + 2') \
    || fail "cannot date the call listing"
  calls=$(FM_CAPTAIN_HOLD_NOW="$NOW" "$SCRIPT_DIR/fm-captain-hold.sh" list --json \
      --backlog-json "$work/page.json" --since "$since" | jq -c '.calls') \
    || fail "cannot list the captain calls"
fi

# shellcheck disable=SC2016 # jq, not the shell, expands these variables.
printf '%s\n%s\n' "$page" "$calls" | jq -n \
  --arg repo "$repo" --argjson by_repo "$repo_set" \
  --argjson archive_present "$archive_present" --argjson archive_readable "$archive_readable" '
  input as $page
  | input as $calls
  | {schema: "fm-history.v1",
     repo: (if $by_repo == 1 then $repo else null end),
     records: $page.records,
     calls: $calls,
     next: $page.next,
     archive: {present: $archive_present, readable: $archive_readable}}'
