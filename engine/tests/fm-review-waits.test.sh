#!/usr/bin/env bash
# Each library check below runs in its own subshell with its own FM_HOME on purpose.
# shellcheck disable=SC2030,SC2031
# Behavior tests for what happens after the captain reviews a task page:
# bin/fm-artifact.sh's verdict intake, review waits, and the record of what the
# first mate did about a review; bin/fm-teardown.sh and bin/fm-tasks-axi.sh
# keeping a task open while its page is unread; the review dispatch hold the
# retention puts on the row and a verdict lifts; the wake drain's UNHANDLED
# REVIEWS section; the fleet snapshot's reviews[]; a task held for the captain
# being dispatched for a review without its hold being released; and
# bin/fm-promote.sh carrying an approval's comments into the build.
# Every "keeps waiting" test has its negative beside it: a page the captain has
# reviewed must stop waiting, or silence has only been traded for noise.
set -u

# shellcheck source=tests/lib.sh
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; exit 0; }

ARTIFACT="$ROOT/bin/fm-artifact.sh"
TMP_ROOT=$(fm_test_tmproot fm-review-waits)
TASKS_AXI_BIN=$(command -v tasks-axi)
export FM_ARTIFACT_LAYOUT=0 TZ=UTC
T0=2026-09-27T01:00:00Z
T1=2026-09-27T01:10:00Z
T2=2026-09-27T01:20:00Z
T3=2026-09-27T01:30:00Z

make_home() {  # <name>
  local home="$TMP_ROOT/$1" fakebin
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  printf '## In flight\n\n## Queued\n\n## Done\n' > "$home/data/backlog.md"
  fakebin=$(fm_fakebin "$home")
  fm_fake_exit0 "$fakebin" tmux treehouse no-mistakes gh gh-axi
  printf '%s\n' "$home"
}

in_home() {  # <home> <command...>: run with the home's environment
  local home=$1
  shift
  PATH="$home/fakebin:$PATH" REAL_TASKS_AXI="$TASKS_AXI_BIN" FM_ROOT_OVERRIDE="$ROOT" \
    FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
    FM_CONFIG_OVERRIDE="$home/config" "$@"
}

art() {  # <home> <now> <fm-artifact args...>
  local home=$1 now=$2
  shift 2
  FM_ARTIFACT_NOW=$now in_home "$home" "$ARTIFACT" "$@"
}

tasks_in() {  # <home> <tasks-axi args...>
  local home=$1
  shift
  (cd "$home" && TASKS_AXI_FILE="$home/data/backlog.md" tasks-axi "$@")
}

# A scout task with a live worker record: kind scout unless given.
add_task() {  # <home> <id> [kind]
  local home=$1 id=$2 kind=${3:-scout}
  mkdir -p "$home/data/$id"
  tasks_in "$home" add "$id" "Draw the $id page" --kind "$kind" --repo sample --start >/dev/null \
    || fail "setup error: could not add $id"
  fm_write_meta "$home/state/$id.meta" "window=firstmate:fm-$id" \
    "worktree=$home/projects/missing-$id" "project=$home/projects/sample" "harness=codex" \
    "kind=$kind" "mode=$kind" "spawn_gen=fixture-$id"
  printf '# %s\n\nFindings.\n' "$id" > "$home/data/$id/report.md"
}

present() {  # <home> <now> <task> <name> <body> [flags...]
  local home=$1 now=$2 task=$3 name=$4 body=$5 src
  shift 5
  src="$TMP_ROOT/src-$task-$name.html"
  printf '<html><head><title>%s</title></head><body>%s</body></html>\n' "$name" "$body" > "$src"
  FM_TASK_ID=$task art "$home" "$now" present --task "$task" --name "$name" "$src" "$@" >/dev/null \
    || fail "setup error: could not present $task/$name"
}

wait_of() {  # <home> <now> <task> <name>: the page's wait bucket, or none
  art "$1" "$2" reviews --json | jq -r --arg t "$3" --arg n "$4" \
    '.pages[] | select(.task == $t and .name == $n) | if .wait == null then "none" else .wait.bucket end'
}

run_teardown() {  # <home> <id>
  in_home "$1" "$ROOT/bin/fm-teardown.sh" "$2"
}

run_drain() {  # <home>
  FM_REVIEW_OVERDUE_MINUTES=0 in_home "$1" "$ROOT/bin/fm-wake-drain.sh" 2>/dev/null
}

test_verdict_intake_records_and_refuses() {
  local home out rc
  home=$(make_home intake)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  present "$home" "$T1" t1 plan two
  out=$(art "$home" "$T2" verdict --task t1 --name plan --rev 1 --verdict comment --threads t1,t2 --message m-1) \
    || fail "a comments verdict on rev 1 was refused: $out"
  assert_contains "$out" "recorded: t1 plan rev 1 comment" "the intake names what it recorded"
  assert_contains "$out" "author: live" "a task with a worker record has a live author"
  assert_equals 'fm-artifact-review.v1|verdict|1|comment|t1,t2|null|m-1' \
    "$(jq -r '[.schema,.kind,.rev,.verdict,(.threads|join(",")),(.until|tostring),.message]|join("|")' "$home/data/t1/artifacts/plan/verdicts.jsonl")" \
    "the verdict is stored beside the revisions"
  out=$(art "$home" "$T3" verdict --task t1 --name plan --rev 1 --verdict comment --threads t1,t2 --message m-1) \
    || fail "an exact retry failed"
  assert_contains "$out" "unchanged: t1 plan rev 1 comment" "an exact retry records nothing"
  assert_equals 1 "$(wc -l < "$home/data/t1/artifacts/plan/verdicts.jsonl" | tr -d ' ')" "a retry appended a record"

  for args in "--verdict approved --rev 2" "--verdict approve --rev 3" "--verdict approve --rev 0" \
      "--verdict approve --rev 2 --threads x1" "--verdict approve --rev 2 --threads t1,t1" \
      "--verdict not-now --rev 2" "--verdict not-now --rev 2 --until 2026-09-27" \
      "--verdict not-now --rev 2 --until 27-09-2026" "--verdict approve --rev 2 --until 2026-10-01" \
      "--verdict approve --rev 2 --message bad/id"; do
    # shellcheck disable=SC2086 # each case is a word list on purpose
    out=$(art "$home" "$T3" verdict --task t1 --name plan $args 2>&1); rc=$?
    expect_code 1 "$rc" "verdict $args"
  done
  out=$(art "$home" "$T3" verdict --chat --name plan --rev 1 --verdict approve 2>&1); rc=$?
  expect_code 1 "$rc" "a chat page verdict"
  assert_contains "$out" "nothing waits on it" "a chat page's refusal says why"
  out=$(art "$home" "$T3" verdict --task t1 --name nope --rev 1 --verdict approve 2>&1); rc=$?
  expect_code 1 "$rc" "a verdict on a page that was never presented"
  rm "$home/state/t1.meta"
  out=$(art "$home" "$T3" verdict --task t1 --name plan --rev 2 --verdict approve) || fail "approve on rev 2 failed"
  assert_contains "$out" "author: retired" "a task with no worker record has a retired author"
  pass "fm-artifact.sh verdict: records the four verdicts and not-now, refuses bad input, and is idempotent"
}

test_which_pages_wait() {
  local home
  home=$(make_home which)
  add_task "$home" scout1
  add_task "$home" ship1 ship
  present "$home" "$T0" scout1 design one
  present "$home" "$T0" scout1 notes one --fyi
  present "$home" "$T0" ship1 shots one
  present "$home" "$T0" ship1 mock one --for-review
  printf '<html><head><title>c</title></head><body>c</body></html>' > "$TMP_ROOT/chat.html"
  art "$home" "$T0" present --chat "$TMP_ROOT/chat.html" >/dev/null || fail "setup error: chat present"
  # A revision written before the field existed never waits.
  mkdir -p "$home/data/scout1/artifacts/legacy/rev-1/files"
  printf 'x' > "$home/data/scout1/artifacts/legacy/rev-1/files/p.html"
  jq -n '{schema:"fm-artifact-revision.v1",scope:"task",task:"scout1",name:"legacy",rev:1,title:"l",entry:"p.html",sha256:"x",bytes:1,presented_at:"2026-09-27T00:00:00Z"}' \
    > "$home/data/scout1/artifacts/legacy/rev-1/revision.json"
  assert_equals live "$(wait_of "$home" "$T1" scout1 design)" "a scout's page waits for the captain"
  assert_equals none "$(wait_of "$home" "$T1" scout1 notes)" "a --fyi page does not wait"
  assert_equals none "$(wait_of "$home" "$T1" ship1 shots)" "a ship's evidence page does not wait"
  assert_equals live "$(wait_of "$home" "$T1" ship1 mock)" "--for-review makes a ship's page wait"
  assert_equals none "$(wait_of "$home" "$T1" scout1 legacy)" "a page presented before review waits existed does not wait"
  assert_equals 0 "$(art "$home" "$T1" reviews --json | jq '[.pages[] | select(.task == null)] | length')" "a chat page is not listed"
  pass "fm-artifact.sh reviews: only work pages the captain asked to see wait"
}

test_a_review_retires_the_wait_and_a_new_revision_opens_one() {
  local home out rc
  home=$(make_home retire)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  present "$home" "$T0" t1 plan two
  out=$(art "$home" "$T1" waiting t1); rc=$?
  expect_code 0 "$rc" "an unread latest revision waits"
  assert_equals "plan rev 2" "$out" "waiting names the page and revision"
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict approve >/dev/null || fail "verdict on rev 1 failed"
  assert_equals live "$(wait_of "$home" "$T1" t1 plan)" "a verdict on an older revision left the newest one retired"
  art "$home" "$T1" verdict --task t1 --name plan --rev 2 --verdict changes --threads t3 >/dev/null || fail "verdict on rev 2 failed"
  assert_equals none "$(wait_of "$home" "$T1" t1 plan)" "a reviewed page keeps waiting"
  out=$(art "$home" "$T1" waiting t1); rc=$?
  expect_code 1 "$rc" "a reviewed page reads as waiting"
  present "$home" "$T2" t1 plan three
  assert_equals live "$(wait_of "$home" "$T2" t1 plan)" "the next revision did not open a new wait"
  assert_equals 1 "$(art "$home" "$T2" reviews --json | jq '[.pages[] | select(.task == "t1")] | length')" \
    "a task lists one entry per page, never one per revision"

  # The app's own sent review of the latest revision counts as reviewed, so a
  # review sent by an app that predates the intake never keeps a page waiting.
  printf '%s\n' '{"at":1,"kind":"sent","verdict":"comment","rev":3,"threads":[],"message":"m"}' \
    > "$home/data/t1/artifacts/plan/review.jsonl"
  assert_equals none "$(wait_of "$home" "$T3" t1 plan)" "a page the app recorded as reviewed keeps waiting"
  printf '%s\n' '{"at":1,"kind":"seen","rev":3}' > "$home/data/t1/artifacts/plan/review.jsonl"
  assert_equals live "$(wait_of "$home" "$T3" t1 plan)" "merely opening a page is not a review"

  art "$home" "$T3" withdraw --task t1 --name plan >/dev/null 2>&1 && fail "a withdrawal without a reason was accepted"
  out=$(art "$home" "$T3" withdraw --task t1 --name plan --reason "superseded by the build") || fail "withdraw failed"
  assert_contains "$out" "withdrawn: t1 plan rev 3" "withdraw names the revision it retires"
  assert_equals none "$(wait_of "$home" "$T3" t1 plan)" "a withdrawn page keeps waiting"
  present "$home" "$T3" t1 plan four
  assert_equals live "$(wait_of "$home" "$T3" t1 plan)" "a revision after a withdrawal opens a new wait"
  pass "fm-artifact.sh reviews: a review or withdrawal retires a wait, a newer revision opens one"
}

test_not_now_ageing_and_calls_do_not_nag() {
  local home out rc
  home=$(make_home buckets)
  add_task "$home" t1
  present "$home" 2026-09-27T01:00:00Z t1 plan one
  art "$home" 2026-09-27T02:00:00Z verdict --task t1 --name plan --rev 1 --verdict not-now --until 2026-10-02 >/dev/null \
    || fail "not-now failed"
  out=$(art "$home" 2026-09-28T00:00:00Z reviews --json | jq -c '.pages[0].wait | [.bucket,.until]')
  assert_equals '["dated","2026-10-02"]' "$out" "not-now moves the wait to its date"
  out=$(art "$home" 2026-09-28T00:00:00Z waiting t1); rc=$?
  expect_code 0 "$rc" "a put-off page still keeps its task open"
  assert_equals live "$(wait_of "$home" 2026-10-02T09:00:00Z t1 plan)" "the wait did not come back on its date"
  assert_equals aged "$(wait_of "$home" 2026-10-17T00:00:00Z t1 plan)" "a lapsed not-now does not age from its date"
  assert_equals 0 "$(art "$home" 2026-09-28T00:00:00Z reviews --owed | wc -l | tr -d ' ')" "not-now asks the first mate for nothing"

  present "$home" 2026-09-27T01:00:00Z t1 old one
  assert_equals live "$(wait_of "$home" 2026-10-10T00:00:00Z t1 old)" "a wait aged before its time"
  assert_equals aged "$(wait_of "$home" 2026-10-11T01:00:00Z t1 old)" "a long wait did not age off the live list"

  # A page an open call carries is that call's: its card already shows it.
  printf '{"calls":[{"id":"t1-call","state":"open","evidence":["page:task/t1/old"],"answer":null}]}\n' > "$TMP_ROOT/calls-open.json"
  out=$(art "$home" 2026-09-28T00:00:00Z reviews --json --calls-json "$TMP_ROOT/calls-open.json" \
    | jq -c '.pages[] | select(.name == "old") | .wait | [.bucket,.call]')
  assert_equals '["call","t1-call"]' "$out" "a page an open call carries asks a second time"
  # An answer given after the page was presented settles it.
  printf '{"calls":[{"id":"t1-call","state":"closed","evidence":["page:task/t1/old"],"answer":{"at":"2026-09-27T05:00:00Z"}}]}\n' > "$TMP_ROOT/calls-answered.json"
  out=$(art "$home" 2026-09-28T00:00:00Z reviews --json --calls-json "$TMP_ROOT/calls-answered.json" \
    | jq -c '.pages[] | select(.name == "old") | .wait')
  assert_equals null "$out" "a page an answered call settled keeps waiting"
  printf '{"calls":[{"id":"t1-call","state":"closed","evidence":["page:task/t1/old"],"answer":{"at":"2026-09-27T00:30:00Z"}}]}\n' > "$TMP_ROOT/calls-early.json"
  out=$(art "$home" 2026-09-28T00:00:00Z reviews --json --calls-json "$TMP_ROOT/calls-early.json" \
    | jq -r '.pages[] | select(.name == "old") | .wait.bucket')
  assert_equals live "$out" "an answer given before the page existed settled it"
  pass "fm-artifact.sh reviews: not-now dates a wait, old waits age, and a call's page never asks twice"
}

test_unhandled_reviews_until_the_first_mate_acts() {
  local home out rc
  home=$(make_home unhandled)
  add_task "$home" t1
  add_task "$home" build1 ship
  present "$home" "$T0" t1 plan one
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict approve --threads t1 >/dev/null || fail "approve failed"
  out=$(art "$home" "$T3" reviews --owed)
  assert_equals "$(printf 't1\tplan\t1\tapprove\tt1\tlive\t%s' "$T1")" "$out" "an approval is owed even with a live author"
  assert_equals "" "$(art "$home" "$T1" reviews --owed --older-than 5)" "--older-than listed a review younger than it"
  out=$(art "$home" "$T3" handled --task t1 --name plan --rev 2 --promoted 2>&1); rc=$?
  expect_code 1 "$rc" "handled names a revision the review is not on"
  art "$home" "$T3" handled --task t1 --linked t1 >/dev/null 2>&1 && fail "an approval linked to its own task"
  art "$home" "$T3" handled --task t1 --linked nope >/dev/null 2>&1 && fail "an approval linked to an unknown task"
  out=$(art "$home" "$T3" handled --task t1 --linked build1) || fail "linking the approval to a build failed: $out"
  assert_contains "$out" "handled: t1 plan rev 1 linked" "handled names what it recorded"
  assert_equals "" "$(art "$home" "$T3" reviews --owed)" "a linked approval is still owed"
  assert_equals '["t1"]' "$(art "$home" "$T3" reviews --json | jq -c '.pages[0].carried')" "the approval's comments read as carried into the build"
  out=$(art "$home" "$T3" handled --task t1 --promoted)
  assert_contains "$out" "nothing unhandled on t1" "handled with nothing left says so"

  # Comments to a live author are relayed and answered by a revision: not owed.
  present "$home" "$T0" t1 flow one
  art "$home" "$T1" verdict --task t1 --name flow --rev 1 --verdict comment --threads t1,t2 >/dev/null || fail "comment failed"
  assert_equals "" "$(art "$home" "$T3" reviews --owed)" "a review a live author will answer was owed"
  assert_contains "$(art "$home" "$T3" reviews --unhandled)" "flow" "the review is still unhandled"
  out=$(art "$home" "$T3" handled --task t1 --name flow --rev 1 --promoted 2>&1); rc=$?
  expect_code 1 "$rc" "--promoted on a comments review"
  assert_contains "$out" "fits an approval only" "the refusal says why"
  # Its author goes: now the review reaches no one unless the first mate acts.
  rm "$home/state/t1.meta"
  assert_equals "$(printf 't1\tflow\t1\tcomment\tt1,t2\tretired\t%s' "$T1")" "$(art "$home" "$T3" reviews --owed)" \
    "a review for a retired author was not owed"
  # The next revision answers it.
  present "$home" "$T2" t1 flow two
  assert_equals "" "$(art "$home" "$T3" reviews --owed)" "a review answered by a revision is still owed"
  art "$home" "$T3" verdict --task t1 --name flow --rev 2 --verdict changes >/dev/null || fail "changes failed"
  assert_contains "$(art "$home" "$T3" reviews --owed)" "flow	2	changes	-	retired" "a second review for a retired author was not owed"
  out=$(art "$home" "$T3" handled --task t1 --reason "answered in chat: the flow stays as drawn") || fail "reason failed"
  assert_equals "" "$(art "$home" "$T3" reviews --owed)" "a review answered with a reason is still owed"
  pass "fm-artifact.sh reviews --owed: approvals and orphaned reviews stay listed until the first mate acts"
}

test_teardown_carries_an_unread_page_forward() {
  local home show out
  home=$(make_home teardown)
  add_task "$home" t1
  present "$home" "$T0" t1 session-controls two
  in_home "$home" "$ROOT/bin/fm-captain-hold.sh" complete t1 --none > "$home/complete.out" \
    || fail "the completion gate failed"
  assert_grep "review: session-controls rev 1 still waits" "$home/complete.out" "completion does not name the unread page"
  run_teardown "$home" t1 > "$home/teardown.out" 2> "$home/teardown.err" \
    || fail "cleanup of a task with an unread page failed: $(cat "$home/teardown.err")"
  show=$(tasks_in "$home" show t1 --full)
  assert_not_contains "$show" "state: done" "cleanup filed an unread page away by closing its task"
  assert_contains "$show" "state: queued" "the row is not open"
  assert_contains "$show" "held: yes" "the row is dispatchable while nothing has come back"
  assert_contains "$show" "hold_kind: external" "the review wait was recorded as a captain decision"
  assert_contains "$show" "hold_reason: waiting for the captain to review a presented page" "the hold does not say what it waits for"
  assert_contains "$show" "Deliverable of the finished work: report data/t1/report.md" "the deliverable was not recorded"
  assert_absent "$home/state/t1.meta" "the worker record outlived cleanup"
  assert_grep "held from dispatch until the captain reviews session-controls rev 1" "$home/teardown.out" \
    "cleanup does not say the row stays open for the review"
  # The late review lifts the hold and reaches the first mate.
  out=$(art "$home" "$T2" verdict --task t1 --name session-controls --rev 1 --verdict changes --threads t1) \
    || fail "the late review was refused"
  assert_contains "$out" "author: retired" "a late review does not say its author is gone"
  show=$(tasks_in "$home" show t1 --full)
  assert_contains "$show" "held: no" "the review hold outlived the review"
  assert_contains "$show" "state: queued" "the review closed the task"
  assert_contains "$(run_drain "$home")" "t1: the captain's changes review of page session-controls rev 1" \
    "a late review was dropped silently"

  # A page the captain has reviewed does not keep its task open.
  add_task "$home" t2
  present "$home" "$T0" t2 plan one
  art "$home" "$T1" verdict --task t2 --name plan --rev 1 --verdict comment >/dev/null || fail "verdict failed"
  present "$home" "$T0" t2 notes one --fyi
  in_home "$home" "$ROOT/bin/fm-captain-hold.sh" complete t2 --none > "$home/complete2.out" || fail "gate failed"
  assert_no_grep "review:" "$home/complete2.out" "completion named a reviewed page"
  run_teardown "$home" t2 > "$home/teardown2.out" 2> "$home/teardown2.err" || fail "cleanup failed: $(cat "$home/teardown2.err")"
  assert_contains "$(tasks_in "$home" show t2 --full)" "state: done" "a reviewed page kept its task open"
  assert_grep "is closed" "$home/teardown2.out" "the ordinary close message changed"
  pass "fm-teardown.sh: an unread page keeps its task open and held, a verdict frees it, a reviewed page closes"
}

test_a_captain_hold_survives_the_retention_and_the_verdict() {
  local home show
  home=$(make_home captain-held)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  in_home "$home" "$ROOT/bin/fm-captain-hold.sh" hold t1 --reason "choose a route" >/dev/null || fail "hold failed"
  in_home "$home" "$ROOT/bin/fm-captain-hold.sh" complete t1 t1 >/dev/null || fail "gate failed"
  run_teardown "$home" t1 > "$home/teardown.out" 2> "$home/teardown.err" || fail "cleanup failed: $(cat "$home/teardown.err")"
  show=$(tasks_in "$home" show t1 --full)
  assert_contains "$show" "hold_kind: captain" "the retention replaced the captain hold"
  assert_grep "still held for the captain" "$home/teardown.out" "the call's own message was lost"
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict comment --threads t1 >/dev/null || fail "verdict failed"
  show=$(tasks_in "$home" show t1 --full)
  assert_contains "$show" "held: yes" "a review released the captain's hold"
  assert_contains "$show" "hold_kind: captain" "a review changed the captain's hold"
  # Even a captain hold worded exactly like the review hold is never lifted.
  add_task "$home" t2
  present "$home" "$T0" t2 plan one
  in_home "$home" "$ROOT/bin/fm-captain-hold.sh" hold t2 --reason "waiting for the captain to review a presented page" >/dev/null \
    || fail "setup error: hold t2"
  art "$home" "$T1" verdict --task t2 --name plan --rev 1 --verdict approve >/dev/null || fail "verdict failed"
  assert_contains "$(tasks_in "$home" show t2 --full)" "hold_kind: captain" "a verdict lifted a captain hold that shared the review hold's words"
  pass "fm-artifact.sh verdict: a task held for the captain takes a review without its hold being released"
}

test_held_task_dispatches_for_a_review_only() {
  local home rc
  home=$(make_home dispatch)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  in_home "$home" "$ROOT/bin/fm-captain-hold.sh" hold t1 --reason "choose a route" >/dev/null || fail "hold failed"
  rm "$home/state/t1.meta"
  tasks_in "$home" reopen t1 >/dev/null || fail "setup error: reopen"
  dispatchable() {  # <home>
    (
      # shellcheck source=bin/fm-tasks-axi-lib.sh disable=SC1091
      . "$ROOT/bin/fm-tasks-axi-lib.sh"
      # shellcheck source=bin/fm-backlog-transition-lib.sh disable=SC1091
      . "$ROOT/bin/fm-backlog-transition-lib.sh"
      export FM_HOME="$1"
      fm_backlog_row_probe "$1/data" t1 || exit 3
      fm_backlog_row_dispatchable "$FM_BACKLOG_ROW_STATE" && exit 0
      fm_backlog_row_dispatchable_for_review "$FM_BACKLOG_ROW_STATE" "$FM_BACKLOG_ROW_HOLD_KIND" "$1/data" t1
    )
  }
  dispatchable "$home"; rc=$?
  expect_code 1 "$rc" "a held task with no review to answer"
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict approve >/dev/null || fail "approve failed"
  dispatchable "$home"; rc=$?
  expect_code 1 "$rc" "a held task whose page was approved (promotion is the first mate's call)"
  art "$home" "$T2" verdict --task t1 --name plan --rev 1 --verdict comment --threads t1 >/dev/null || fail "comment failed"
  dispatchable "$home"; rc=$?
  expect_code 0 "$rc" "a held task whose page came back with comments"
  (
    # shellcheck source=bin/fm-tasks-axi-lib.sh disable=SC1091
    . "$ROOT/bin/fm-tasks-axi-lib.sh"
    # shellcheck source=bin/fm-backlog-transition-lib.sh disable=SC1091
    . "$ROOT/bin/fm-backlog-transition-lib.sh"
    export FM_HOME="$home"
    printf 'spawn_gen=x\n' > "$home/state/t1.meta"
    fm_backlog_dispatch_transition "$home/state/t1.meta" "$home/data" t1 "$home/state" && exit 9
    FM_BACKLOG_DISPATCH_FOR_REVIEW=1 fm_backlog_dispatch_transition "$home/state/t1.meta" "$home/data" t1 "$home/state"
  ); rc=$?
  expect_code 0 "$rc" "the dispatch transition for a review"
  assert_contains "$(tasks_in "$home" show t1 --full)" "state: in_flight" "the review dispatch did not start the row"
  assert_contains "$(tasks_in "$home" show t1 --full)" "hold_kind: captain" "dispatching for a review released the call"
  present "$home" "$T3" t1 plan answered
  dispatchable "$home"; rc=$?
  expect_code 1 "$rc" "a held task whose review a revision already answered"
  pass "fm-backlog-transition-lib.sh: a captain-held task dispatches only to answer a returned review, hold intact"
}

test_done_is_refused_while_a_page_waits() {
  local home out rc
  home=$(make_home done-guard)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  out=$(in_home "$home" "$ROOT/bin/fm-tasks-axi.sh" "done" t1 2>&1); rc=$?
  expect_code 2 "$rc" "done on a task whose page is unread"
  assert_contains "$out" "plan rev 1" "the refusal does not name the page"
  assert_not_contains "$(tasks_in "$home" show t1 --full)" "state: done" "the refused close still closed the row"
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict approve >/dev/null || fail "approve failed"
  in_home "$home" "$ROOT/bin/fm-tasks-axi.sh" "done" t1 >/dev/null 2>&1 || fail "done on a reviewed task was refused"
  pass "fm-tasks-axi.sh: done refuses a task whose page the captain has not reviewed, and only that"
}

test_drain_lists_owed_reviews_until_acted_on() {
  local home out
  home=$(make_home drain)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  out=$(run_drain "$home")
  assert_not_contains "$out" "UNHANDLED REVIEWS" "the drain listed a page nobody has reviewed"
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict approve --threads t1,t2 >/dev/null || fail "approve failed"
  out=$(run_drain "$home")
  assert_contains "$out" "UNHANDLED REVIEWS (the captain reviewed these pages" "the drain did not list the approval"
  assert_contains "$out" "t1: the captain approved page plan rev 1 at $T1 with comments t1,t2 to carry into the build word for word; promote it or say why not" \
    "the approval line lacks the task, page, or comment ids"
  assert_contains "$(run_drain "$home")" "UNHANDLED REVIEWS" "the listing stopped before anyone acted"
  art "$home" "$T2" handled --task t1 --reason "the captain asked to wait for the usage work" >/dev/null || fail "handled failed"
  assert_not_contains "$(run_drain "$home")" "UNHANDLED REVIEWS" "the drain nagged after the first mate acted"
  pass "fm-wake-drain.sh: UNHANDLED REVIEWS lists an approval on every drain until the first mate acts"
}

test_snapshot_carries_reviews() {
  local home json
  home=$(make_home snapshot)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  json=$(in_home "$home" "$ROOT/bin/fm-fleet-snapshot.sh" --json 2>/dev/null) || fail "the fleet snapshot failed"
  assert_equals 't1|plan|live' "$(printf '%s' "$json" | jq -r '.reviews[0] | [.task,.name,.wait.bucket] | join("|")')" \
    "the snapshot does not carry the page's review wait"
  pass "fm-fleet-snapshot.sh: reviews[] carries every task page's review standing"
}

test_retention_replay_asks_again() {
  local home rc
  home=$(make_home replay)
  add_task "$home" t1
  present "$home" "$T0" t1 plan one
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict comment >/dev/null || fail "verdict failed"
  (
    # shellcheck source=bin/fm-tasks-axi-lib.sh disable=SC1091
    . "$ROOT/bin/fm-tasks-axi-lib.sh"
    # shellcheck source=bin/fm-backlog-transition-lib.sh disable=SC1091
    . "$ROOT/bin/fm-backlog-transition-lib.sh"
    export FM_HOME="$home"
    fm_backlog_retain "$home/data" t1
  ); rc=$?
  expect_code 0 "$rc" "a retention whose review already arrived"
  assert_contains "$(tasks_in "$home" show t1 --full)" "held: no" "a retention held a row whose page was already reviewed"
  pass "fm-backlog-transition-lib.sh: a retention re-asks the wait, so a review that arrived in between leaves no hold"
}

test_promote_carries_the_approved_comments() {
  local home out
  home=$(make_home promote)
  add_task "$home" t1
  cat > "$home/data/t1/brief.md" <<'EOF'
# Task
## Captain's intent
Design the session controls.

## Firstmate spec
Draw the page.
EOF
  present "$home" "$T0" t1 plan one
  cat > "$home/data/t1/artifacts/plan/review.jsonl" <<'EOF'
{"at":1,"kind":"opened","id":"t1","rev":1,"anchor":{"quote":"Model picker"},"body":"Put the model first.\nThen effort."}
{"at":2,"kind":"comment","id":"t1","body":"And keep Calm last."}
{"at":3,"kind":"opened","id":"t2","rev":1,"anchor":null,"body":"Drop the slash hint."}
{"at":4,"kind":"sent","verdict":"approve","rev":1,"threads":["t1","t2"],"message":"m"}
EOF
  art "$home" "$T1" verdict --task t1 --name plan --rev 1 --verdict approve --threads t1,t2 >/dev/null || fail "approve failed"
  out=$(in_home "$home" "$ROOT/bin/fm-promote.sh" t1 --mode local-only --yolo off 2>&1) || fail "promotion failed: $out"
  assert_contains "$out" "handled: t1 plan rev 1 promoted" "promotion did not record the approval as acted on"
  assert_grep "The captain approved the page plan rev 1, which is what authorizes this build." "$home/data/t1/ship-instructions.md" \
    "the ship instructions do not say what authorized the build"
  assert_contains "$(cat "$home/data/t1/ship-instructions.md")" '- t1 (on "Model picker"): Put the model first.' "a comment was not carried word for word"
  assert_grep '  Then effort.' "$home/data/t1/ship-instructions.md" "a comment's second line was lost"
  assert_grep '  And keep Calm last.' "$home/data/t1/ship-instructions.md" "a follow-up comment was lost"
  assert_grep '- t2: Drop the slash hint.' "$home/data/t1/ship-instructions.md" "the second comment was lost"
  assert_grep "Put the model first." "$home/data/t1/brief.md" "a relaunch brief would lose the approved comments"
  assert_equals "" "$(art "$home" "$T2" reviews --owed)" "the promoted approval is still owed"
  pass "fm-promote.sh: an approval's comments go into the build word for word and the approval reads as acted on"
}

test_verdict_intake_records_and_refuses
test_which_pages_wait
test_a_review_retires_the_wait_and_a_new_revision_opens_one
test_not_now_ageing_and_calls_do_not_nag
test_unhandled_reviews_until_the_first_mate_acts
test_teardown_carries_an_unread_page_forward
test_a_captain_hold_survives_the_retention_and_the_verdict
test_held_task_dispatches_for_a_review_only
test_done_is_refused_while_a_page_waits
test_drain_lists_owed_reviews_until_acted_on
test_snapshot_carries_reviews
test_retention_replay_asks_again
test_promote_carries_the_approved_comments
