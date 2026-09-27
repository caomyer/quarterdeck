#!/usr/bin/env bash
# The captain's edits to a task through bin/fm-task-edit.sh, and the backlog
# reading they rest on: priority and its start order, dependencies with a loop
# refused however long, what a task in flight keeps, a stale edit refused with
# the value that won, a title that would read as row metadata, putting a task
# off apart from a call's own date, projects this home registered, and groups:
# a program row, the `part-of:` line every engine body writer keeps, and a
# group that closes only once its tasks have. The parser's own new fields are
# read through the fleet snapshot's --backlog-json, never from its source.
# jq, not the shell, expands the $ names here.
# shellcheck disable=SC2016
set -u
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found (edits land through it)"; exit 0; }

TMP_ROOT=$(fm_test_tmproot fm-task-edit)
TASKS_AXI_BIN=$(command -v tasks-axi)
NOW=2026-09-26T12:00:00Z

# A home whose path has a space, as a real one under Application Support does.
new_home() {  # <name>
  local home="$TMP_ROOT/home $1"
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  cp "$ROOT/.tasks.toml" "$home/"
  printf '## In flight\n\n## Queued\n\n## Done\n' > "$home/data/backlog.md"
  printf -- '- demo - the demo project (added 2026-09-01)\n- other [direct-PR] - another one (added 2026-09-01)\n' > "$home/data/projects.md"
  fm_fake_exit0 "$(fm_fakebin "$home")" tmux treehouse no-mistakes gh gh-axi
  printf '%s\n' "$home"
}

edit() {  # <home> <verb> <args...>: stdout is the JSON result
  local home=$1
  shift
  PATH="$home/fakebin:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_DATA_OVERRIDE="$home/data" \
    FM_STATE_OVERRIDE="$home/state" FM_TASK_EDIT_NOW="$NOW" "$ROOT/bin/fm-task-edit.sh" "$@" 2>/dev/null
}

axi() {  # <home> <args...>
  local home=$1
  shift
  FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_DATA_OVERRIDE="$home/data" "$ROOT/bin/fm-tasks-axi.sh" "$@" >/dev/null \
    || fail "tasks-axi $* failed"
}

backlog() {  # <home>: the snapshot's backlog object
  PATH="$1/fakebin:$PATH" FM_HOME="$1" FM_ROOT_OVERRIDE="$ROOT" FM_STATE_OVERRIDE="$1/state" FM_DATA_OVERRIDE="$1/data" \
    FM_CONFIG_OVERRIDE="$1/config" FM_PROJECTS_OVERRIDE="$1/projects" FM_SNAPSHOT_NOW="$NOW" \
    "$ROOT/bin/fm-fleet-snapshot.sh" --backlog-json
}

row() {  # <home> <id>
  backlog "$1" | jq -c --arg id "$2" '.records[] | select(.id == $id)'
}

# Run an edit expected to be refused; prints the refusal's code and reason.
refused() {  # <home> <verb> <args...>
  local out rc=0
  out=$(edit "$@") && rc=0 || rc=$?
  [ "$rc" -eq 1 ] || fail "expected '$2 ${3-}' to be refused, got exit $rc: $out"
  printf '%s' "$out" | jq -r '"\(.code)|\(.reason)"'
}

test_priority_has_a_meaning_the_order_follows() {
  local home
  home=$(new_home order)
  axi "$home" add t-low 'low work' --repo demo --kind ship --priority 3
  axi "$home" add t-none 'unset work' --repo demo --kind ship
  axi "$home" add t-urgent 'urgent work' --repo demo --kind ship --priority 0
  axi "$home" add t-blocker 'a blocker' --repo demo --kind ship --priority 4
  axi "$home" add t-waits 'blocked at P0' --repo demo --kind ship --priority 0
  axi "$home" block t-waits --by t-blocker
  axi "$home" add t-put 'put off at P0' --repo demo --kind ship --priority 0
  axi "$home" hold t-put --reason 'later' --kind parked --until 2026-10-02
  assert_equals 't-urgent,t-none,t-low,t-blocker,t-waits,t-put' \
    "$(backlog "$home" | jq -r '[.records[] | select(.start_rank != null)] | sort_by(.start_rank) | map(.id) | join(",")')" \
    'start order is ready, then blocked, then put off, each by priority'
  assert_equals '2|ready' "$(row "$home" t-none | jq -r '"\(.priority_level)|\(.standing)"')" \
    'a row with no priority counts as normal, P2'
  assert_equals 'blocked|held' "$(backlog "$home" | jq -r '[(.records[] | select(.id == "t-waits") | .standing), (.records[] | select(.id == "t-put") | .standing)] | join("|")')" \
    'a blocked row and a put-off row say so'

  edit "$home" priority t-low 1 --expect 3 | jq -e '.ok and .changed and .record.priority == "1"' >/dev/null \
    || fail 'a priority change was not taken'
  assert_equals 't-urgent,t-low,t-none' \
    "$(backlog "$home" | jq -r '[.records[] | select(.standing == "ready")] | sort_by(.start_rank) | map(.id) | .[:3] | join(",")')" \
    'raising a priority moves the task up the start order'
  assert_equals 'stale|Not changed: its priority changed to 1 while your window showed 3; pick again' \
    "$(refused "$home" priority t-low 2 --expect 3)" 'an edit from a stale window is refused, naming the value that won'
  assert_equals '1' "$(edit "$home" priority t-low 2 --expect 3 >/dev/null; row "$home" t-low | jq -r .priority)" \
    'a refused edit changes nothing'
  edit "$home" priority t-none 2 --expect none | jq -e '.changed' >/dev/null || fail 'setting an unset priority was refused'
  assert_equals 'invalid' "$(refused "$home" priority t-low 5 | cut -d'|' -f1)" 'a priority outside 0-4 is refused'
  pass 'priority orders the queue: ready, then blocked, then put off, each by priority; stale edits are refused'
}

test_a_blocker_that_lands_and_is_archived_stays_resolved() {
  local home
  home=$(new_home archive)
  axi "$home" add t-old 'landed long ago' --repo demo --kind ship
  axi "$home" add t-after 'waits on it' --repo demo --kind ship
  axi "$home" block t-after --by t-old
  axi "$home" "done" t-old
  # tasks-axi keeps a few recent Done rows; the rest move to the archive.
  { printf '## Archived 2026-09-20\n'; grep -- '- \[x\] t-old ' "$home/data/backlog.md"; } > "$home/data/done-archive.md"
  awk '!/^- \[x\] t-old /' "$home/data/backlog.md" > "$home/data/backlog.tmp" && mv "$home/data/backlog.tmp" "$home/data/backlog.md"
  assert_equals 'ready|[]' "$(row "$home" t-after | jq -c '"\(.standing)|\(.unresolved_blocker_ids | tojson)"' | jq -r .)" \
    'a blocker closed in the done archive no longer holds its dependent'
  rm "$home/data/done-archive.md"
  assert_equals 'blocked' "$(row "$home" t-after | jq -r .standing)" 'a blocker named nowhere stays open'
  pass 'a blocker that landed and was archived is resolved, as tasks-axi ready judges it'
}

test_dependencies_refuse_a_loop_however_long() {
  local home out
  home=$(new_home loop)
  for id in t-a t-b t-c t-d; do axi "$home" add "$id" "task $id" --repo demo --kind ship; done
  edit "$home" block t-b --by t-a | jq -e '.changed and .record.standing == "blocked"' >/dev/null || fail 'block was not taken'
  edit "$home" block t-c --by t-b >/dev/null || fail 'second block was not taken'
  edit "$home" block t-d --by t-c >/dev/null || fail 'third block was not taken'
  out=$(refused "$home" block t-a --by t-d)
  assert_equals 'loop|Not added: t-d already waits on t-a through t-c, then t-b, so each would wait on the other forever' "$out" \
    'a loop three edges long is refused and the path named'
  assert_equals 'loop' "$(refused "$home" block t-a --by t-b | cut -d'|' -f1)" 'a direct loop is refused'
  assert_equals '[]' "$(row "$home" t-a | jq -c .blocked_by_ids)" 'a refused loop left no edge'
  assert_equals 'invalid' "$(refused "$home" block t-a --by t-a | cut -d'|' -f1)" 'a task cannot wait on itself'
  assert_equals 'unknown' "$(refused "$home" block t-a --by t-nobody | cut -d'|' -f1)" 'a blocker must exist'
  edit "$home" block t-c --by t-b | jq -e '.changed == false' >/dev/null || fail 'repeating an edge was not a no-op'
  edit "$home" unblock t-d --by t-c | jq -e '.changed and .record.blocked_by_ids == []' >/dev/null || fail 'unblock was not taken'
  edit "$home" block t-a --by t-d | jq -e '.changed' >/dev/null || fail 'once the loop is gone the edge is taken'
  axi "$home" "done" t-d
  assert_equals 'invalid' "$(refused "$home" block t-b --by t-d | cut -d'|' -f1)" 'waiting on landed work is refused'
  pass 'a dependency that would close a loop is refused, however long the loop'
}

test_work_in_flight_keeps_what_its_worker_was_briefed_for() {
  local home
  home=$(new_home flight)
  axi "$home" add t-run 'running work' --repo demo --kind ship --priority 2
  axi "$home" add t-other 'other work' --repo demo --kind ship
  axi "$home" start t-run
  for change in 'project t-run other' 'kind t-run scout' 'block t-run --by t-other' 'park t-run --until 2026-10-02'; do
    # shellcheck disable=SC2086 # the change is a word list on purpose
    assert_equals 'running' "$(refused "$home" $change | cut -d'|' -f1)" "in flight: '$change' must be refused"
  done
  assert_equals 'demo|ship|[]' "$(row "$home" t-run | jq -r '"\(.repo)|\(.kind)|\(.blocked_by_ids | tojson)"')" \
    'a refused in-flight edit changed nothing'
  edit "$home" priority t-run 0 | jq -e '.record.priority == "0"' >/dev/null || fail 'a priority change in flight was refused'
  edit "$home" title t-run 'running work, renamed' | jq -e '.record.title == "running work, renamed"' >/dev/null \
    || fail 'a title change in flight was refused'
  axi "$home" add t-closed 'finished' --repo demo --kind ship
  axi "$home" "done" t-closed
  assert_equals 'closed' "$(refused "$home" priority t-closed 1 | cut -d'|' -f1)" 'a closed row is not edited'
  axi "$home" add t-call 'a call' --repo demo --kind captain
  assert_equals 'call' "$(refused "$home" priority t-call 1 | cut -d'|' -f1)" 'a call is answered, not edited'
  assert_equals 'unknown' "$(refused "$home" priority t-missing 1 | cut -d'|' -f1)" 'an unknown task is refused'
  pass 'a task in flight keeps its project, kind, dependencies and start; its priority and title still change'
}

test_titles_projects_and_kinds_are_checked() {
  local home
  home=$(new_home fields)
  axi "$home" add t-x 'plain title' --repo demo --kind ship
  for title in 'moved (repo: other)' 'waits blocked-by: t-y' 'see https://example.com/pull/1' '   '; do
    assert_equals 'invalid' "$(refused "$home" title t-x "$title" | cut -d'|' -f1)" "a title like '$title' is refused"
  done
  assert_equals 'plain title' "$(row "$home" t-x | jq -r .title)" 'a refused title changed nothing'
  edit "$home" title t-x 'a better title - with a dash' --expect 'plain title' | jq -e '.record.title == "a better title - with a dash"' >/dev/null \
    || fail 'an ordinary retitle was refused'
  assert_equals 'unregistered' "$(refused "$home" project t-x nowhere | cut -d'|' -f1)" 'an unregistered project is refused'
  edit "$home" project t-x other --expect demo | jq -e '.record.repo == "other"' >/dev/null || fail 'a registered project was refused'
  assert_equals 'invalid' "$(refused "$home" kind t-x captain | cut -d'|' -f1)" 'only ship and scout are kinds a captain sets'
  edit "$home" kind t-x scout | jq -e '.record.kind == "scout"' >/dev/null || fail 'a kind change was refused'
  pass 'titles cannot carry row metadata, projects must be registered, and kinds are ship or scout'
}

test_putting_off_is_the_captains_own_hold() {
  local home
  home=$(new_home park)
  axi "$home" add t-p 'put me off' --repo demo --kind ship
  assert_equals 'invalid' "$(refused "$home" park t-p --until 2026-09-26 | cut -d'|' -f1)" 'today is not a day to put off to'
  assert_equals 'invalid' "$(refused "$home" park t-p --until 2026-02-30 | cut -d'|' -f1)" 'a date that does not exist is refused'
  edit "$home" park t-p --until 2026-10-02 --expect none | jq -e '.record | .standing == "held" and .hold_kind == "parked" and .hold_until == "2026-10-02" and .captain_actionable == false' >/dev/null \
    || fail 'putting a task off did not hold it apart from a call'
  edit "$home" park t-p --until 2026-10-09 --expect 2026-10-02 | jq -e '.record.hold_until == "2026-10-09"' >/dev/null \
    || fail 'moving the date was refused'
  assert_equals 'stale' "$(refused "$home" unpark t-p --expect 2026-10-02 | cut -d'|' -f1)" 'bringing back from a stale date is refused'
  edit "$home" unpark t-p --expect 2026-10-09 | jq -e '.record.standing == "ready"' >/dev/null || fail 'unpark did not bring it back'
  axi "$home" hold t-p --reason 'captain decision pending' --kind captain
  assert_equals 'held' "$(refused "$home" park t-p --until 2026-10-02 | cut -d'|' -f1)" "a call's date is not the list's to change"
  assert_equals 'held' "$(refused "$home" unpark t-p | cut -d'|' -f1)" "a call's hold is not the list's to lift"
  pass 'putting off is a parked hold the captain sets and lifts, apart from any call'
}

test_groups_are_program_rows_their_tasks_name() {
  local home group out
  home=$(new_home groups)
  axi "$home" add t-m1 'first member' --repo demo --kind ship --body 'The captain wrote this.
source-link: fixture:w 42 fulfills'
  axi "$home" add t-m2 'second member' --repo demo --kind ship
  out=$(edit "$home" group-new 'Trust what the app says about workers' --project demo --priority 1)
  group=$(printf '%s' "$out" | jq -r .task)
  assert_equals 'g-trust-what-the-app-says|program|in_flight|program|1' \
    "$(printf '%s' "$out" | jq -r '[.task, .record.kind, .record.state, .record.current_role, .record.priority] | join("|")')" \
    'a new group is a program row no worker runs'
  assert_equals 'g-trust-what-the-app-says-2' \
    "$(edit "$home" group-new 'Trust what the app says about workers' --project demo | jq -r .task)" 'a taken group id gains a suffix'
  edit "$home" group t-m1 "$group" --expect none | jq -e --arg g "$group" '.record.part_of == $g' >/dev/null || fail 'joining a group was refused'
  assert_equals '["The captain wrote this.","source-link: fixture:w 42 fulfills","part-of: g-trust-what-the-app-says"]' \
    "$(row "$home" t-m1 | jq -c .body_lines)" 'joining a group keeps every other body line as it was'
  assert_equals 'stale' "$(refused "$home" group t-m1 none --expect none | cut -d'|' -f1)" 'a stale group edit is refused'
  edit "$home" group t-m2 "$group" >/dev/null || fail 'second member was refused'
  assert_equals 'invalid' "$(refused "$home" group "$group" "$group" | cut -d'|' -f1)" 'a group cannot join a group'
  assert_equals 'invalid' "$(refused "$home" group t-m2 t-m1 | cut -d'|' -f1)" 'only a program row is a group'
  assert_equals 'invalid' "$(refused "$home" block t-m2 --by "$group" | cut -d'|' -f1)" 'nothing waits on a group'
  assert_equals 'open-members' "$(refused "$home" group-close "$group" | cut -d'|' -f1)" 'a group with open tasks stays open'
  edit "$home" group t-m1 none | jq -e '.record.part_of == null and (.record.body_lines | length) == 2' >/dev/null \
    || fail 'leaving a group did not drop only its line'
  axi "$home" "done" t-m2
  edit "$home" group-close "$group" | jq -e '.record.state == "done"' >/dev/null || fail 'a group whose tasks have all closed did not close'
  pass 'a group is a program row, its tasks carry one part-of line, and it closes once they have'
}

# Every engine writer of a task body must keep the lines machines own there:
# a `part-of:` line (bin/fm-task-edit.sh) and a `source-link:` line
# (bin/fm-sources.sh), whichever of them writes last.
test_every_body_writer_keeps_the_machine_lines() {
  local home body worlds
  home=$(new_home writers)
  worlds="$TMP_ROOT/worlds"
  mkdir -p "$worlds"
  jq -n '{identity:"fm-bot",page_size:50,seconds_per_page:0,faults:{},
    workflows:{default:{statuses:{"To Do":"new","Done":"done"},transitions:{"To Do":["Done"]}}},
    items:[{id:"7",key:"FIX-7",summary:"Item FIX-7",description:"",status:"To Do",workflow:"default",labels:["quarterdeck"],
      assignee:null,updated:"2026-09-25T10:00",deleted:false,comments:[]}]}' > "$worlds/w.json"
  src() {
    PATH="$home/fakebin:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_STATE_OVERRIDE="$home/state" \
      FM_DATA_OVERRIDE="$home/data" FM_CONFIG_OVERRIDE="$home/config" FM_SOURCE_FIXTURE_DIR="$worlds" \
      FM_SOURCES_NOW="2026-09-25T10:0$1:00Z" "$ROOT/bin/fm-sources.sh" "${@:2}"
  }
  captain() {
    PATH="$home/fakebin:$PATH" REAL_TASKS_AXI="$TASKS_AXI_BIN" FM_CAPTAIN_HOLD_NOW="$NOW" FM_HOME="$home" \
      FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" FM_CONFIG_OVERRIDE="$home/config" \
      "$ROOT/bin/fm-captain-hold.sh" "$@"
  }
  axi "$home" add t-w 'written by everyone' --repo demo --kind ship --body 'What the captain asked for.'
  src 1 add fixture w --project demo --filter 'labels = quarterdeck' >/dev/null || fail 'could not connect the fixture source'
  edit "$home" group-new 'A group' --project demo >/dev/null || fail 'could not file a group'
  edit "$home" group t-w g-a-group >/dev/null || fail 'could not join the group'
  src 2 link t-w FIX-7 >/dev/null || fail 'fm-sources link failed'
  captain hold t-w --reason 'captain decision pending' >/dev/null || fail 'fm-captain-hold hold failed'
  printf 'Go ahead.\n' > "$home/decision.txt"
  captain answer t-w --decision-file "$home/decision.txt" --release >/dev/null || fail 'fm-captain-hold answer failed'
  edit "$home" group t-w g-a-group >/dev/null || fail 'repeating the group was refused'
  body=$(row "$home" t-w | jq -c .body_lines)
  for line in 'What the captain asked for.' 'part-of: g-a-group' 'source-link: fixture:w 7 fulfills' 'Resolution recorded by fm-captain-hold.'; do
    assert_contains "$body" "\"$line\"" "a body writer dropped '$line'"
  done
  src 3 unlink t-w fixture:w 7 >/dev/null || fail 'fm-sources unlink failed'
  assert_equals 'g-a-group' "$(row "$home" t-w | jq -r .part_of)" 'unlinking a source dropped the group line'
  edit "$home" group t-w none >/dev/null || fail 'leaving the group failed'
  assert_contains "$(row "$home" t-w | jq -c .body_lines)" '"Resolution recorded by fm-captain-hold."' 'leaving a group dropped the resolution record'
  pass 'fm-task-edit, fm-sources and fm-captain-hold each keep the lines the others own'
}

test_priority_has_a_meaning_the_order_follows
test_a_blocker_that_lands_and_is_archived_stays_resolved
test_dependencies_refuse_a_loop_however_long
test_work_in_flight_keeps_what_its_worker_was_briefed_for
test_titles_projects_and_kinds_are_checked
test_putting_off_is_the_captains_own_hold
test_groups_are_program_rows_their_tasks_name
test_every_body_writer_keeps_the_machine_lines

echo "ALL TESTS PASSED"
