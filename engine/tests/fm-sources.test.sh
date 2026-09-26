#!/usr/bin/env bash
# External task sources: the core in bin/fm-sources.sh, proven against the
# fixture provider (bin/fm-source-fixture.sh), which has Jira's awkward traits
# and is deliberately not GitHub. Nothing here names GitHub: a case that needed
# to would be a provider-specific branch in the core.
# jq and the fixture world, not the shell, expand the $ names and backticks here.
# shellcheck disable=SC2016
set -u
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found (links live in its task bodies)"; exit 0; }
TMP_ROOT=$(fm_test_tmproot fm-sources)
WORLDS="$TMP_ROOT/worlds"
mkdir -p "$WORLDS"

# A home whose path has a space, as a real one under Application Support does.
new_home() {
  local home="$TMP_ROOT/home $1"
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/fakebin"
  cp "$ROOT/.tasks.toml" "$home/"
  printf '# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n' > "$home/data/backlog.md"
  printf '#!/bin/sh\nexit 1\n' > "$home/fakebin/tmux"
  chmod +x "$home/fakebin/tmux"
  printf '%s\n' "$home"
}

# A world with one workflow in Jira's shape and the given items.
new_world() {  # <name> <items-json>
  jq -n --argjson items "$2" '{identity:"fm-bot",page_size:50,seconds_per_page:0,faults:{},
    workflows:{
      default:{statuses:{"To Do":"new","In Progress":"started","Code Review":"started","Done":"done","Won'"'"'t Do":"cancelled"},
        transitions:{"To Do":["In Progress","Won'"'"'t Do"],"In Progress":["Code Review","Done"],"Code Review":["Done"]}},
      noreview:{statuses:{"To Do":"new","In Progress":"started","Done":"done"},
        transitions:{"To Do":["In Progress"],"In Progress":["Done"]}},
      tworeview:{statuses:{"To Do":"new","In Progress":"started","Code Review":"started","QA Review":"started","Done":"done"},
        transitions:{"To Do":["In Progress"],"In Progress":["Code Review","QA Review","Done"]}}},
    items:$items}' > "$WORLDS/$1.json"
}
item() {  # <id> <key> <minute> [labels-json] [workflow] [status]
  jq -cn --arg id "$1" --arg key "$2" --arg at "2026-09-25T$3" --argjson labels "${4:-[\"quarterdeck\"]}" \
    --arg wf "${5:-default}" --arg status "${6:-To Do}" \
    '{id:$id,key:$key,summary:("Item " + $key),description:"h2. Why\n*Too* many {{calls}}",status:$status,
      workflow:$wf,labels:$labels,assignee:null,updated:$at,deleted:false,comments:[]}'
}
world_set() {  # <name> <jq-program> [jq args...]
  local name=$1 program=$2
  shift 2
  jq "$@" "$program" "$WORLDS/$name.json" > "$WORLDS/$name.tmp" && mv "$WORLDS/$name.tmp" "$WORLDS/$name.json"
}

src() {  # <home> <clock-minute> <args...>
  local home=$1 at=$2
  shift 2
  PATH="$home/fakebin:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_STATE_OVERRIDE="$home/state" \
    FM_DATA_OVERRIDE="$home/data" FM_CONFIG_OVERRIDE="$home/config" FM_SOURCE_FIXTURE_DIR="$WORLDS" \
    FM_SOURCES_NOW="2026-09-25T$at:00Z" "$ROOT/bin/fm-sources.sh" "$@"
}
axi() {  # <home> <args...>
  local home=$1
  shift
  FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_DATA_OVERRIDE="$home/data" "$ROOT/bin/fm-tasks-axi.sh" "$@" >/dev/null
}
status_of() { src "$1" 23:59 status; }
# The source's slice of the status, as compact JSON.
source_of() { status_of "$1" | jq -c --arg id "$2" '.sources[] | select(.id == $id)'; }
events_of() { src "$1" 23:59 events | jq -c '.events'; }

connect() {  # <home> <world> [outbound]
  src "$1" 10:00 add fixture "$2" --project demo --filter 'labels = quarterdeck' --outbound "${3:-comments}" >/dev/null \
    || fail "could not connect fixture:$2"
}
# File a task for an item, then put it in flight with a registered PR.
in_flight_with_pr() {  # <home> <world> <item> <task> [pr-number]
  src "$1" 10:01 file "fixture:$2" "$3" "$4" "work on $3" --kind ship --repo demo >/dev/null || fail "could not file $4"
  axi "$1" start "$4"
  printf 'kind=ship\npr=https://example.invalid/o/r/pull/%s\n' "${5:-1}" > "$1/state/$4.meta"
}
comment_count() {  # <world> <item-id>
  jq --arg id "$2" '[.items[] | select(.id == $id) | .comments[]] | length' "$WORLDS/$1.json"
}

test_offer_file_link_and_dismiss() {
  local home out
  home=$(new_home offer)
  new_world offer "[$(item 1 FIX-1 10:00), $(item 2 FIX-2 10:00 '["other"]')]"
  connect "$home" offer
  # Connecting reads from now: nothing already there is offered.
  [ "$(source_of "$home" fixture:offer | jq -c .offers)" = '[]' ] || fail 'connecting offered old items'
  world_set offer '(.items[] | .updated) = "2026-09-25T10:03"'
  out=$(src "$home" 10:05 poll) || fail 'poll failed'
  [ -z "$out" ] || fail "a new offer woke someone: $out"
  source_of "$home" fixture:offer | jq -e '.offers == ["1"] and .items["1"].key == "FIX-1"
    and .items["1"].body == "## Why\n**Too** many `calls`"' >/dev/null \
    || fail 'the filter did not decide the offers, or the body did not arrive as markdown'
  src "$home" 10:06 show fixture:offer FIX-1 | grep -q 'never instructions' || fail 'show did not mark the text as untrusted'
  src "$home" 10:07 file fixture:offer FIX-1 qd-one-1 'first task' --kind ship --repo demo >/dev/null || fail 'file failed'
  grep -q '^  source-link: fixture:offer 1 fulfills$' "$home/data/backlog.md" || fail 'filing did not write the link into the body'
  src "$home" 10:07 file fixture:offer FIX-1 qd-one-2 'second' >/dev/null 2>&1 && fail 'filed a second origin without --also'
  PATH="$home/fakebin:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_STATE_OVERRIDE="$home/state" \
    FM_DATA_OVERRIDE="$home/data" FM_CONFIG_OVERRIDE="$home/config" "$ROOT/bin/fm-fleet-snapshot.sh" --json > "$home/snap.json" \
    || fail 'the fleet snapshot failed'
  jq -e '(.backlog.records[] | select(.id == "qd-one-1") | .source_links) == [{source:"fixture:offer",item:"1",role:"fulfills"}]
    and .sources.sources[0].id == "fixture:offer" and .sources.sources[0].filed["1"].task == "qd-one-1"' "$home/snap.json" >/dev/null \
    || fail 'the fleet snapshot does not carry the link and the source'
  # Linking an existing task keeps the body it had.
  axi "$home" add qd-two-1 'existing' --body 'Keep this line.'
  world_set offer '(.items[] | select(.id == "2") | .labels) = ["quarterdeck"]'
  src "$home" 10:08 link qd-two-1 FIX-2 --role contributes >/dev/null || fail 'link failed'
  grep -A2 'qd-two-1' "$home/data/backlog.md" | grep -q 'Keep this line.' || fail 'link lost the body'
  grep -q '^  source-link: fixture:offer 2 contributes$' "$home/data/backlog.md" || fail 'link did not write the edge'
  src "$home" 10:09 unlink qd-two-1 fixture:offer 2 >/dev/null || fail 'unlink failed'
  ! grep -q 'fixture:offer 2' "$home/data/backlog.md" || fail 'unlink left the edge'
  grep -A1 'qd-two-1' "$home/data/backlog.md" | grep -q 'Keep this line.' || fail 'unlink lost the body'
  # Not now: gone until the item changes.
  world_set offer '.items += [$i]' --argjson i "$(item 3 FIX-4 10:10)"
  src "$home" 10:11 poll >/dev/null
  source_of "$home" fixture:offer | jq -e '.offers | index("3") != null' >/dev/null || fail 'the new item was not offered'
  src "$home" 10:12 dismiss fixture:offer 3 >/dev/null || fail 'dismiss failed'
  source_of "$home" fixture:offer | jq -e '.offers | index("3") == null' >/dev/null || fail 'a dismissed item is still offered'
  world_set offer '(.items[] | select(.id == "3") | .updated) = "2026-09-25T10:20"'
  src "$home" 10:21 poll >/dev/null
  source_of "$home" fixture:offer | jq -e '.offers | index("3") != null' >/dev/null || fail 'a dismissed item that changed was not offered again'
  pass 'intake offers only what the filter matches, filing is the link, and Not now lasts until the item changes'
}

test_key_change_keeps_the_link() {
  local home before
  home=$(new_home move)
  new_world move "[$(item 77 FIX-3 10:00)]"
  connect "$home" move
  src "$home" 10:01 file fixture:move FIX-3 qd-move-1 'moved item' >/dev/null || fail 'file failed'
  src "$home" 10:02 poll >/dev/null
  before=$(cat "$home/data/backlog.md")
  world_set move '(.items[0] | .key, .updated) |= (if type == "string" and startswith("FIX") then "OPS-9" else "2026-09-25T10:05" end)'
  [ "$(jq -r '.items[0].key' "$WORLDS/move.json")" = OPS-9 ] || fail 'fixture did not move the item'
  src "$home" 10:06 poll >/dev/null || fail 'poll failed'
  [ "$(cat "$home/data/backlog.md")" = "$before" ] || fail 'a key change touched the backlog'
  source_of "$home" fixture:move | jq -e '.items["77"].key == "OPS-9"' >/dev/null || fail 'the displayed key did not follow the move'
  [ "$(events_of "$home")" = '[]' ] || fail 'a key change raised a signal'
  src "$home" 10:07 show fixture:move OPS-9 | grep -q 'OPS-9 (id 77)' || fail 'the new key does not resolve'
  pass 'a key change on a move keeps the link and updates the displayed key'
}

test_advance_is_transition_only() {
  local home sent
  home=$(new_home advance)
  new_world adv "[$(item a1 ADV-1 10:00 '["quarterdeck"]' noreview 'In Progress'),
    $(item a2 ADV-2 10:00 '["quarterdeck"]' default 'In Progress'),
    $(item a3 ADV-3 10:00 '["quarterdeck"]' tworeview 'In Progress'),
    $(item a4 ADV-4 10:00 '["quarterdeck"]' default 'Done')]"
  connect "$home" adv comments+status
  in_flight_with_pr "$home" adv ADV-1 qd-adv-1 1
  in_flight_with_pr "$home" adv ADV-2 qd-adv-2 2
  in_flight_with_pr "$home" adv ADV-3 qd-adv-3 3
  src "$home" 10:05 poll >/dev/null || fail 'poll failed'
  sent=$(source_of "$home" fixture:adv | jq -cS '.sent | map({key:.task,value:.advance.result}) | from_entries')
  [ "$sent" = '{"qd-adv-1":"not-supported","qd-adv-2":"moved","qd-adv-3":"ambiguous"}' ] \
    || fail "advance in-review with zero, one and two candidates answered $sent"
  [ "$(jq -r '.items[] | select(.id == "a2") | .status' "$WORLDS/adv.json")" = 'Code Review' ] || fail 'the one candidate was not moved to'
  [ "$(jq -r '.items[] | select(.id == "a3") | .status' "$WORLDS/adv.json")" = 'In Progress' ] || fail 'an ambiguous review state was moved'
  jq -r '.items[] | select(.id == "a3") | .comments[0].body' "$WORLDS/adv.json" | grep -q 'so none was chosen' \
    || fail 'the comment does not say the status was left alone'
  # A per-source review state wins over the ambiguity.
  src "$home" 10:06 edit fixture:adv --review-state 'QA Review' >/dev/null || fail 'edit failed'
  # Delivered on an item that is already done: already, and the comment still posted once.
  src "$home" 10:07 file fixture:adv ADV-4 qd-adv-4 'already done' >/dev/null || fail 'file failed'
  axi "$home" start qd-adv-4
  axi "$home" "done" qd-adv-4 --pr https://example.invalid/o/r/pull/4
  src "$home" 10:08 poll >/dev/null || fail 'poll failed'
  src "$home" 10:09 poll >/dev/null || fail 'second poll failed'
  source_of "$home" fixture:adv | jq -e '[.sent[] | select(.task == "qd-adv-4")] | length == 1 and .[0].advance.result == "already"
    and .[0].intent == "delivered"' >/dev/null || fail 'delivered on a done item did not answer already'
  [ "$(comment_count adv a4)" = 1 ] || fail "the delivered comment was posted $(comment_count adv a4) times"
  pass 'advance is transition-only: not-supported, moved and ambiguous by candidates, already when done, comment once'
}

test_markdown_round_trips() {
  local home
  home=$(new_home markdown)
  new_world md "[$(item m1 MD-1 10:00)]"
  connect "$home" md
  src "$home" 10:01 file fixture:md MD-1 qd-md-1 'markdown' >/dev/null || fail 'file failed'
  axi "$home" start qd-md-1
  printf 'Fixed the **export** limit; see `limits.rs`.\n' | src "$home" 10:02 summary qd-md-1 >/dev/null || fail 'summary failed'
  axi "$home" "done" qd-md-1 --pr https://example.invalid/o/r/pull/5
  src "$home" 10:03 poll >/dev/null || fail 'poll failed'
  jq -r '.items[0].comments[0].body' "$WORLDS/md.json" | grep -qF 'Fixed the *export* limit; see {{limits.rs}}.' \
    || fail 'the comment was not converted to the provider format'
  src "$home" 10:04 show fixture:md MD-1 | grep -qF 'Fixed the **export** limit; see `limits.rs`.' \
    || fail 'the comment did not come back as markdown'
  pass 'a non-markdown body round-trips: the core only ever sees markdown'
}

test_overlap_and_pages() {
  local home n
  home=$(new_home pages)
  new_world pages "[$(item p1 PG-1 10:00)]"
  connect "$home" pages
  src "$home" 10:01 file fixture:pages PG-1 qd-pg-1 'paged' >/dev/null || fail 'file failed'
  src "$home" 10:02 poll >/dev/null
  # Closed at the cursor's own minute: the next two reads both return it.
  world_set pages '(.items[0] | .status, .updated) |= (if . == "To Do" then "Done" else "2026-09-25T10:04" end)'
  src "$home" 10:05 poll >/dev/null || fail 'poll failed'
  src "$home" 10:06 poll >/dev/null || fail 'second poll failed'
  n=$(events_of "$home" | jq '[.[] | select(.kind == "closed")] | length')
  [ "$n" = 1 ] || fail "an item returned by two overlapping reads raised $n signals"
  # One page per call, and the third call cut short: the overlap returns PG-1
  # again as the first page, PG-2 is the second, and the next cycle resumes.
  world_set pages '.page_size = 1 | .items += [$a, $b, $c] | .faults.changes = ["ok", "ok", "timeout"]' \
    --argjson a "$(item p2 PG-2 10:10)" --argjson b "$(item p3 PG-3 10:11)" --argjson c "$(item p4 PG-4 10:12)"
  jq '.seconds_per_page = 30' "$WORLDS/pages.json" > "$WORLDS/p.tmp" && mv "$WORLDS/p.tmp" "$WORLDS/pages.json"
  src "$home" 10:13 poll >/dev/null || fail 'paged poll failed'
  source_of "$home" fixture:pages | jq -e '.offers == ["p2"] and .reading_more == true' >/dev/null \
    || fail 'the first page was not kept, or the cut-short read was not left to resume'
  src "$home" 10:14 poll >/dev/null || fail 'resumed poll failed'
  source_of "$home" fixture:pages | jq -e '(.offers | sort) == ["p2","p3","p4"] and .reading_more == false' >/dev/null \
    || fail "resuming lost or repeated an item: $(source_of "$home" fixture:pages | jq -c .offers)"
  pass 'overlapping reads give one signal, and a read cut short resumes from its saved cursor'
}

test_timeouts_never_wake() {
  local home out last i
  home=$(new_home timeout)
  new_world to "[$(item t1 TO-1 10:00)]"
  connect "$home" to
  src "$home" 10:01 poll >/dev/null
  last=$(source_of "$home" fixture:to | jq -r .last_read)
  world_set to '.faults.changes = ["timeout","timeout","timeout","timeout"]'
  for i in 2 3 4 5; do
    out=$(src "$home" "10:0$i" poll) || fail 'poll failed on a timeout'
    [ -z "$out" ] || fail "a timeout woke someone: $out"
  done
  source_of "$home" fixture:to | jq -e --arg last "$last" '.failure == null and .last_read == $last' >/dev/null \
    || fail 'a timeout was counted, or moved the last read'
  [ ! -s "$home/state/.wake-queue" ] || fail 'a timeout queued a wake'
  # Timeouts between failures do not count towards the threshold either.
  world_set to '.faults.changes = ["auth","timeout","auth","timeout"]'
  for i in 6 7 8 9; do src "$home" "10:0$i" poll >/dev/null; done
  [ "$(events_of "$home")" = '[]' ] || fail 'two failures and two timeouts raised a signal'
  world_set to '.faults.changes = ["auth","auth"]'
  out=$(src "$home" 10:10 poll)
  printf '%s' "$out" | grep -q 'sources: failing' || fail "the third failure did not wake: $out"
  out=$(src "$home" 10:11 poll)
  [ -z "$out" ] || fail "a persisting failure woke twice: $out"
  [ "$(events_of "$home" | jq '[.[] | select(.kind == "failing")] | length')" = 1 ] || fail 'not exactly one failing signal'
  grep -q 'check: sources failing' "$home/state/.wake-queue" || fail 'the failing signal queued no wake'
  src "$home" 10:12 poll >/dev/null
  source_of "$home" fixture:to | jq -e '.failure == null' >/dev/null || fail 'a good read did not clear the failure'
  # Thirty minutes of failure wakes too, even in fewer reads.
  world_set to '.faults.changes = ["network","network"]'
  src "$home" 11:00 poll >/dev/null
  out=$(src "$home" 11:31 poll)
  printf '%s' "$out" | grep -q 'sources: failing' || fail 'thirty minutes of failure did not wake'
  pass 'a timeout is never a failure; three failures or thirty minutes wake exactly once'
}

test_lost_response_deduplicates() {
  local home
  home=$(new_home lost)
  new_world lost "[$(item l1 LO-1 10:00)]"
  connect "$home" lost
  in_flight_with_pr "$home" lost LO-1 qd-lost-1 7
  world_set lost '.faults.comment = ["lose-response"]'
  src "$home" 10:02 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count lost l1)" = 1 ] || fail 'the fixture did not post before losing the answer'
  source_of "$home" fixture:lost | jq -e '(.outbox | length) == 1 and (.sent | length) == 0' >/dev/null \
    || fail 'a lost answer was taken as confirmed, or dropped'
  src "$home" 10:03 poll >/dev/null || fail 'retry failed'
  source_of "$home" fixture:lost | jq -e '(.outbox | length) == 0 and .sent[0].deduplicated == true' >/dev/null \
    || fail 'the retry did not find the comment by its write id'
  [ "$(comment_count lost l1)" = 1 ] || fail 'the retry posted a second comment'
  pass 'a comment whose answer was lost is found again by its write id, not posted twice'
}

test_inbound_changes_are_signals_only() {
  local home before kinds
  home=$(new_home inbound)
  new_world in "[$(item d1 IN-1 10:00), $(item c1 IN-2 10:00), $(item r1 IN-3 10:00 '["quarterdeck"]' default Done), $(item o1 IN-4 10:00)]"
  connect "$home" in
  for pair in IN-1:qd-in-1 IN-2:qd-in-2 IN-3:qd-in-3 IN-4:qd-in-4; do
    src "$home" 10:01 file fixture:in "${pair%%:*}" "${pair#*:}" "linked ${pair%%:*}" >/dev/null || fail "file ${pair%%:*} failed"
  done
  src "$home" 10:02 poll >/dev/null
  before=$(cat "$home/data/backlog.md")
  world_set in '(.items[] | select(.id == "d1")) |= (.deleted = true | .updated = "2026-09-25T10:05")'
  src "$home" 10:06 poll >/dev/null || fail 'poll failed'
  [ "$(cat "$home/data/backlog.md")" = "$before" ] || fail 'a deleted item changed the backlog'
  world_set in '(.items[] | select(.id == "c1")) |= (.status = "Won'"'"'t Do" | .updated = "2026-09-25T10:07")'
  src "$home" 10:08 poll >/dev/null || fail 'poll failed'
  [ "$(cat "$home/data/backlog.md")" = "$before" ] || fail 'a cancelled item changed the backlog'
  world_set in '(.items[] | select(.id == "r1")) |= (.status = "To Do" | .updated = "2026-09-25T10:09")'
  src "$home" 10:10 poll >/dev/null || fail 'poll failed'
  [ "$(cat "$home/data/backlog.md")" = "$before" ] || fail 'a reopened item changed the backlog'
  world_set in '(.items[] | select(.id == "o1")) |= (.comments += [{id:"k1",author:"fm-bot",created:"x",body:"ours",write_id:"fm-w1"}] | .updated = "2026-09-25T10:11")'
  src "$home" 10:12 poll >/dev/null || fail 'poll failed'
  world_set in '(.items[] | select(.id == "o1")) |= (.comments += [{id:"k2",author:"dana",created:"x",body:"*Please* hurry"}] | .updated = "2026-09-25T10:13")'
  src "$home" 10:14 poll >/dev/null || fail 'poll failed'
  [ "$(cat "$home/data/backlog.md")" = "$before" ] || fail 'a comment changed the backlog'
  kinds=$(events_of "$home" | jq -c 'map([.key, .kind]) | sort')
  [ "$kinds" = '[["IN-1","deleted"],["IN-2","cancelled"],["IN-3","reopened"],["IN-4","commented"]]' ] \
    || fail "inbound signals were $kinds"
  events_of "$home" | jq -e '.[] | select(.kind == "commented") | .detail == "dana: **Please** hurry" and .tasks == [{id:"qd-in-4",state:"queued",role:"fulfills"}]' >/dev/null \
    || fail 'the comment signal does not carry the author, the markdown text and the linked task'
  local token
  token=$(events_of "$home" | jq -r '.[] | select(.kind == "deleted") | .token')
  src "$home" 10:15 ack fixture:in "$token" >/dev/null || fail 'ack failed'
  [ "$(events_of "$home" | jq length)" = 3 ] || fail 'ack did not remove exactly one signal'
  pass 'deleted, cancelled, reopened and commented each raise one signal, ours raise none, and the backlog never changes'
}

test_silent_until_pr_and_forward_only() {
  local home
  home=$(new_home silent)
  new_world si "[$(item s1 SI-1 10:00), $(item s2 SI-2 10:00), $(item s3 SI-3 10:00)]"
  connect "$home" si
  src "$home" 10:01 file fixture:si SI-1 qd-si-1 'silent' >/dev/null || fail 'file failed'
  axi "$home" start qd-si-1
  src "$home" 10:02 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count si s1)" = 0 ] || fail 'dispatch without a PR was announced upstream'
  # Dropping work nothing upstream heard about says nothing.
  printf 'Superseded by another fix.\n' | src "$home" 10:03 stop qd-si-1 | jq -e '.queued == 0' >/dev/null \
    || fail 'stopping silent work queued a comment'
  printf 'kind=ship\npr=https://example.invalid/o/r/pull/8\n' > "$home/state/qd-si-1.meta"
  src "$home" 10:04 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count si s1)" = 1 ] || fail 'the PR milestone was not posted once'
  jq -r '.items[0].comments[0].body' "$WORLDS/si.json" | grep -qF 'pull/8' || fail 'the first comment does not point at the PR'
  axi "$home" "done" qd-si-1 --pr https://example.invalid/o/r/pull/8
  src "$home" 10:05 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count si s1)" = 2 ] || fail 'delivery was not posted'
  # Reopened and back in flight: nothing below delivered is written again.
  axi "$home" reopen qd-si-1
  axi "$home" start qd-si-1
  src "$home" 10:06 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count si s1)" = 2 ] || fail 'a lower milestone was written after delivery'
  # Delivered with no PR comment ever posted, then back in flight with a PR: the
  # core, not the adapter's write id, keeps the lower milestone from posting.
  src "$home" 10:06 file fixture:si SI-3 qd-si-3 'straight to done' >/dev/null || fail 'file failed'
  axi "$home" start qd-si-3
  axi "$home" "done" qd-si-3 --pr https://example.invalid/o/r/pull/10
  src "$home" 10:06 poll >/dev/null || fail 'poll failed'
  axi "$home" reopen qd-si-3
  axi "$home" start qd-si-3
  printf 'kind=ship\npr=https://example.invalid/o/r/pull/10\n' > "$home/state/qd-si-3.meta"
  src "$home" 10:06 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count si s3)" = 1 ] || fail "a PR comment was posted after delivery ($(comment_count si s3) comments)"
  printf 'The captain chose another approach.\n' | src "$home" 10:07 stop qd-si-1 | jq -e '.queued == 1' >/dev/null \
    || fail 'stopping announced work queued no comment'
  src "$home" 10:08 poll >/dev/null || fail 'poll failed'
  jq -r '.items[0].comments[-1].body' "$WORLDS/si.json" | grep -qF 'We have stopped work on this. The captain chose another approach.' \
    || fail 'the stop comment was not posted'
  printf 'Said twice.\n' | src "$home" 10:08 stop qd-si-1 | jq -e '.queued == 0' >/dev/null \
    || fail 'a stop already posted was queued again'
  # Outbound off: nothing is written, and that is recorded rather than dropped.
  src "$home" 10:09 edit fixture:si --outbound none >/dev/null || fail 'edit failed'
  in_flight_with_pr "$home" si SI-2 qd-si-2 9
  src "$home" 10:10 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count si s2)" = 0 ] || fail 'outbound none still wrote upstream'
  source_of "$home" fixture:si | jq -e '[.sent[] | select(.task == "qd-si-2")][0].withheld == "policy"' >/dev/null \
    || fail 'a withheld write was not recorded'
  pass 'nothing is written before a PR, milestones go forward only, stop speaks only after speaking, none writes nothing'
}

test_closed_without_delivery_posts_nothing() {
  local home
  home=$(new_home undelivered)
  new_world ud "[$(item u1 UD-1 10:00), $(item u2 UD-2 10:00)]"
  connect "$home" ud
  in_flight_with_pr "$home" ud UD-1 qd-ud-1 11
  src "$home" 10:02 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count ud u1)" = 1 ] || fail 'the PR milestone was not posted'
  # Dropped with its PR still registered: the stop comment goes, and no landed one.
  printf 'The captain dropped it.\n' | src "$home" 10:03 stop qd-ud-1 | jq -e '.queued == 1' >/dev/null \
    || fail 'stopping announced work queued no comment'
  axi "$home" "done" qd-ud-1 --note 'dropped: superseded'
  src "$home" 10:04 poll >/dev/null || fail 'poll failed'
  src "$home" 10:05 poll >/dev/null || fail 'second poll failed'
  [ "$(comment_count ud u1)" = 2 ] || fail "a dropped task posted $(comment_count ud u1) comments, not the PR and stop ones"
  ! jq -r '.items[] | select(.id == "u1") | .comments[].body' "$WORLDS/ud.json" | grep -q 'landed' \
    || fail 'a task closed without delivery said it landed'
  # Closed without delivery before anything was said: nothing is said at all.
  src "$home" 10:06 file fixture:ud UD-2 qd-ud-2 'superseded' --kind ship >/dev/null || fail 'file failed'
  axi "$home" start qd-ud-2
  printf 'kind=ship\npr=https://example.invalid/o/r/pull/12\n' > "$home/state/qd-ud-2.meta"
  axi "$home" "done" qd-ud-2
  src "$home" 10:07 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count ud u2)" = 0 ] || fail 'a task closed without delivery posted upstream'
  source_of "$home" fixture:ud | jq -e '[.sent[], .outbox[] | select(.task == "qd-ud-2")] | length == 0' >/dev/null \
    || fail 'a task closed without delivery queued a write'
  source_of "$home" fixture:ud | jq -e '.landed == []' >/dev/null || fail 'the snapshot names a task that closed without landing as landed'
  # Its PR comment still waiting when it closed without landing: it never posts.
  world_set ud '.items += [$i] | .faults.comment = ["provider"]' --argjson i "$(item u3 UD-3 10:08)"
  in_flight_with_pr "$home" ud UD-3 qd-ud-3 13
  src "$home" 10:09 poll >/dev/null || fail 'poll failed'
  source_of "$home" fixture:ud | jq -e '[.outbox[] | select(.task == "qd-ud-3")] | length == 1' >/dev/null \
    || fail 'the failed PR comment is not waiting'
  axi "$home" "done" qd-ud-3 --note 'dropped: no longer wanted'
  src "$home" 10:10 poll >/dev/null || fail 'poll failed'
  [ "$(comment_count ud u3)" = 0 ] || fail 'a PR comment still waiting posted after the task closed without landing'
  source_of "$home" fixture:ud | jq -e '([.outbox[] | select(.task == "qd-ud-3")] | length == 0)
    and ([.sent[] | select(.task == "qd-ud-3")] | length == 1 and .[0].superseded == true)' >/dev/null \
    || fail 'the waiting PR comment was not superseded'
  # A task that did land is named in the snapshot, so the drawer can say its comment is coming.
  src "$home" 10:11 file fixture:ud UD-1 qd-ud-4 'landed' --also >/dev/null || fail 'file failed'
  axi "$home" start qd-ud-4
  axi "$home" "done" qd-ud-4 --pr https://example.invalid/o/r/pull/14
  source_of "$home" fixture:ud | jq -e '.landed == ["qd-ud-4"]' >/dev/null || fail 'the snapshot does not name the task that landed'
  # Inside the fleet snapshot, the sources read the backlog the fleet snapshot already read, not a second one.
  PATH="$home/fakebin:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_STATE_OVERRIDE="$home/state" \
    FM_DATA_OVERRIDE="$home/data" FM_CONFIG_OVERRIDE="$home/config" FM_SOURCE_FIXTURE_DIR="$WORLDS" \
    "$ROOT/bin/fm-fleet-snapshot.sh" --json | jq -e '.sources.sources[0].landed == ["qd-ud-4"]' >/dev/null \
    || fail 'the fleet snapshot does not name the task that landed'
  jq -n '{backlog:{records:[]},tasks:[]}' > "$home/empty-input.json"
  FM_SOURCES_BACKLOG_INPUT="$home/empty-input.json" src "$home" 10:12 status | jq -e '.sources[0].landed == []' >/dev/null \
    || fail 'the snapshot read the backlog again instead of the reading it was handed'
  pass 'a task closed without a delivery never says it landed, by firstmate'"'"'s own delivery rule'
}

test_own_account_comment_wakes() {
  local home
  home=$(new_home own)
  new_world own "[$(item w1 OW-1 10:00)]"
  connect "$home" own
  src "$home" 10:01 file fixture:own OW-1 qd-own-1 'captain comments' >/dev/null || fail 'file failed'
  src "$home" 10:02 poll >/dev/null
  # The sign-in is the captain's own: a comment by that account without a write id is theirs.
  world_set own '(.items[0]) |= (.comments += [{id:"h1",author:"fm-bot",created:"x",body:"Hold off, the approach changed"}] | .updated = "2026-09-25T10:05")'
  src "$home" 10:06 poll | grep -q 'sources: commented' || fail 'a comment by the signed-in account did not wake'
  events_of "$home" | jq -e 'length == 1 and .[0].kind == "commented" and .[0].tasks[0].id == "qd-own-1"' >/dev/null \
    || fail "the captain's own comment raised $(events_of "$home")"
  pass 'a comment by the signed-in account wakes the first mate; only the fleet'"'"'s own writes are ours'
}

test_item_gone_when_resolved_is_deleted() {
  local home out
  home=$(new_home gone)
  new_world gone "[$(item g1 GO-1 10:00)]"
  connect "$home" gone
  src "$home" 10:01 file fixture:gone GO-1 qd-gone-1 'gone before read' >/dev/null || fail 'file failed'
  world_set gone '.items = []'
  out=$(src "$home" 10:02 poll) || fail 'poll failed'
  printf '%s' "$out" | grep -q 'sources: deleted GO-1' || fail "an item the source no longer has did not wake: $out"
  source_of "$home" fixture:gone | jq -e '.items.g1.deleted == true and .items.g1.key == "GO-1"' >/dev/null \
    || fail 'an item the source no longer has does not read deleted'
  out=$(src "$home" 10:03 poll) || fail 'poll failed'
  [ -z "$out" ] || fail "a deleted item woke twice: $out"
  pass 'a linked item the source answers not_found for reads deleted and wakes once'
}

test_unconfirmed_write_signals_once() {
  local home out
  home=$(new_home unconfirmed)
  new_world un "[$(item u1 UN-1 10:00)]"
  connect "$home" un
  in_flight_with_pr "$home" un UN-1 qd-un-1 3
  world_set un '.faults.comment = ["unconfirmed","unconfirmed","unconfirmed"]'
  out=$(src "$home" 10:02 poll)
  [ -z "$out" ] || fail "one unconfirmed write woke someone: $out"
  out=$(src "$home" 10:03 poll)
  printf '%s' "$out" | grep -q 'sources: write-unconfirmed' || fail "the second unconfirmed write did not signal: $out"
  out=$(src "$home" 10:04 poll)
  [ -z "$out" ] || fail "an unconfirmed write signalled twice: $out"
  source_of "$home" fixture:un | jq -e '(.outbox | length) == 1 and .outbox[0].attempts == 3' >/dev/null \
    || fail 'an unconfirmed write was dropped'
  src "$home" 10:05 poll >/dev/null
  source_of "$home" fixture:un | jq -e '(.outbox | length) == 0 and (.sent | length) == 1' >/dev/null \
    || fail 'the write was not delivered once the source confirmed it'
  pass 'an unconfirmed write stays waiting and signals once'
}

test_handoff_to_a_home_without_the_source() {
  local primary second
  primary=$(new_home primary)
  second=$(new_home second)
  new_world ho "[$(item h1 HO-1 10:00)]"
  connect "$primary" ho
  src "$primary" 10:01 file fixture:ho HO-1 qd-ho-1 'handed off' --kind ship >/dev/null || fail 'file failed'
  (cd "$primary" && TASKS_AXI_FILE="$primary/data/backlog.md" tasks-axi mv qd-ho-1 --to "$second/data/backlog.md" >/dev/null) \
    || fail 'tasks-axi mv failed'
  grep -q '^  source-link: fixture:ho h1 fulfills$' "$second/data/backlog.md" || fail 'the link did not travel with the row'
  axi "$second" start qd-ho-1
  printf 'kind=ship\npr=https://example.invalid/o/r/pull/6\n' > "$second/state/qd-ho-1.meta"
  src "$second" 10:02 poll >/dev/null || fail 'poll in the second home failed'
  src "$primary" 10:02 poll >/dev/null || fail 'poll in the primary failed'
  [ "$(comment_count ho h1)" = 0 ] || fail 'a home without the source, or one that no longer owns the work, posted'
  [ "$(status_of "$second" | jq '.sources | length')" = 0 ] || fail 'the second home reports a source it does not have'
  [ "$(find "$second/data/sources" -path '*/outbox/*.json' | wc -l | tr -d ' ')" = 1 ] \
    || fail 'the owed write was not kept in the second home'
  [ -z "$(find "$primary/data/sources" -path '*/outbox/*.json' 2>/dev/null)" ] || fail 'the primary queued a write for work it handed off'
  connect "$second" ho
  src "$second" 10:03 poll >/dev/null || fail 'poll after connecting failed'
  [ "$(comment_count ho h1)" = 1 ] || fail 'the owed write was not posted once the source was connected'
  pass 'a handed-off link keeps its writes in the new home until the source is connected there'
}

test_refusals() {
  local home
  home=$(new_home refuse)
  new_world rf "[$(item f1 RF-1 10:00)]"
  src "$home" 10:00 add fixture rf --project demo --filter '' >/dev/null 2>&1 && fail 'a source without a filter was connected'
  src "$home" 10:00 add fixture rf --project demo --filter 'label:x' >/dev/null 2>&1 && fail 'a filter the adapter does not understand was accepted'
  jq '.can = {read:true,comment:false,advance:false}' "$WORLDS/rf.json" > "$WORLDS/rf.tmp" && mv "$WORLDS/rf.tmp" "$WORLDS/rf.json"
  src "$home" 10:00 add fixture rf --project demo --filter 'labels = quarterdeck' >/dev/null 2>&1 \
    && fail 'a sign-in that cannot comment was connected to comment'
  src "$home" 10:00 add fixture rf --project demo --filter 'labels = quarterdeck' --outbound none >/dev/null \
    || fail 'a read-only connection was refused'
  [ ! -e "$home/config/sources.json" ] || ! grep -q token "$home/config/sources.json" || fail 'the config holds a token'
  pass 'a source needs a filter the adapter understands and a sign-in that can do what was asked'
}

test_arm_only_when_configured() {
  local home
  home=$(new_home arm)
  src "$home" 10:00 arm --if-configured >/dev/null || fail 'arm --if-configured failed with nothing connected'
  [ ! -e "$home/state/sources.check.sh" ] || fail 'a home with no source registered a poll'
  new_world arm "[$(item a1 AR-1 10:00)]"
  connect "$home" arm
  rm -f "$home/state/sources.check.sh" "$home/state/sources.check-trust"
  src "$home" 10:01 arm --if-configured >/dev/null || fail 'arm --if-configured failed with a source connected'
  [ -x "$home/state/sources.check.sh" ] && [ -f "$home/state/sources.check-trust" ] || fail 'a connected source did not register its poll'
  pass 'the poll is registered exactly while a source is connected'
}

test_arm_only_when_configured
test_offer_file_link_and_dismiss
test_key_change_keeps_the_link
test_advance_is_transition_only
test_markdown_round_trips
test_overlap_and_pages
test_timeouts_never_wake
test_lost_response_deduplicates
test_inbound_changes_are_signals_only
test_silent_until_pr_and_forward_only
test_closed_without_delivery_posts_nothing
test_own_account_comment_wakes
test_item_gone_when_resolved_is_deleted
test_unconfirmed_write_signals_once
test_handoff_to_a_home_without_the_source
test_refusals
