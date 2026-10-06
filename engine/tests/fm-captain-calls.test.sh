#!/usr/bin/env bash
# Behavior tests for a captain call's single source of truth in
# bin/fm-captain-hold.sh: the sidecar record `hold` and `offer` write, evidence
# attached explicitly and derived from --origin whatever the presentation
# order, a held task that produced work standing as its own origin, `decide` for calls settled on the captain's behalf, `list` and the
# fleet snapshot's calls[], the answer's machine lines written by `answers` and
# `answer` with their closed channel vocabulary, the declared on_answer, the
# one-time `migrate`, the captain's `reply` kept beside an open call until the
# first mate acts, the UNHANDLED REPLIES drain section, the shims that
# replaced fm-decision-options.sh and `fm-artifact.sh present --covers`, and a
# report's proposed call: raised exactly from real reports, refused at its line,
# gating completion until raised or declined, and listed by the drain beside the
# answers the first mate gave and never recorded.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; exit 0; }

CAPTAIN="$ROOT/bin/fm-captain-hold.sh"
TMP_ROOT=$(fm_test_tmproot fm-captain-calls)
TASKS_AXI_BIN=$(command -v tasks-axi)
NOW=2026-09-18T12:00:00Z

make_home() {  # <name>
  local home="$TMP_ROOT/$1"
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  printf '## In flight\n\n## Queued\n\n## Done\n' > "$home/data/backlog.md"
  fm_fake_exit0 "$(fm_fakebin "$home")" tmux treehouse no-mistakes gh gh-axi
  printf '%s\n' "$home"
}

run_captain() {  # <home> <command args...>
  local home=$1
  shift
  PATH="$home/fakebin:$PATH" REAL_TASKS_AXI="$TASKS_AXI_BIN" FM_CAPTAIN_HOLD_NOW="${CALL_NOW:-$NOW}" \
    FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
    FM_CONFIG_OVERRIDE="$home/config" "$CAPTAIN" "$@"
}

present() {  # <home> <task> <name> [extra args]
  local home=$1 task=$2 name=$3
  shift 3
  printf '<title>%s</title><p>%s</p>\n' "$name" "$task" > "$home/$name.html"
  PATH="$home/fakebin:$PATH" FM_ARTIFACT_LAYOUT=0 FM_HOME="$home" \
    FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
    "$ROOT/bin/fm-artifact.sh" present --task "$task" "$home/$name.html" --name "$name" "$@"
}

snapshot() {  # <home>
  PATH="$1/fakebin:$PATH" FM_HOME="$1" FM_STATE_OVERRIDE="$1/state" FM_DATA_OVERRIDE="$1/data" \
    FM_CONFIG_OVERRIDE="$1/config" FM_PROJECTS_OVERRIDE="$1/projects" FM_SNAPSHOT_NOW="$NOW" \
    "$ROOT/bin/fm-fleet-snapshot.sh" --json
}

call_json() {  # <home> <id> [list args]
  local home=$1 id=$2
  shift 2
  run_captain "$home" list --json "$@" | jq -c --arg id "$id" '.calls[] | select(.id == $id)'
}

scout_task() {  # <home> <id>: a finished scout with a report
  mkdir -p "$1/data/$2"
  printf 'kind=scout\n' > "$1/state/$2.meta"
  printf '# Findings\n' > "$1/data/$2/report.md"
}

test_hold_records_the_call_and_refuses_what_nobody_could_answer() {
  local home record out rc bad
  home=$(make_home content)
  run_captain "$home" hold sample-choice --title 'Choose the sample route' --reason 'route pending' \
    --question 'Which route should the sample take?' \
    --option fast='Take the fast route' --option safe='Take the safe route' --recommend safe \
    --about sample-work >/dev/null || fail "hold with content failed"
  record="$home/state/calls/sample-choice.json"
  assert_equals 'fm-call.v1|sample-choice|Which route should the sample take?|fast,safe|safe|done|sample-work|firstmate|2026-09-18T12:00:00Z' \
    "$(jq -r '[.schema, .task, .question, ([.options[].key] | join(",")),
      (.options[] | select(.recommended) | .key), .on_answer, .about, .raised_by, .raised_at] | join("|")' "$record")" \
    "the record carries the question, options, recommendation, and a done close for a task the hold created"
  assert_equals "null|null|0" "$(jq -r '[(.origin|tostring), (.decided|tostring), (.evidence|length)] | join("|")' "$record")" \
    "a call raised from nothing carries no origin, decision, or evidence"

  printf '## In flight\n\n## Queued\n- [ ] sample-work - Existing sample work (repo: sample) (kind: ship) (since 2026-09-01)\n\n## Done\n' \
    > "$home/data/backlog.md"
  run_captain "$home" hold sample-work --reason 'gated on the captain' --option go='Go ahead' --option stop='Stop' >/dev/null \
    || fail "hold of existing work failed"
  assert_equals release "$(jq -r .on_answer "$home/state/calls/sample-work.json")" \
    "holding existing work declares a release close by default"

  for bad in "--option only=one" "--option a=1 --option a=2" "--option a=1 --option b=2 --recommend c" \
    "--option Bad=1 --option b=2" "--option noequals --option b=2" "--on-answer maybe" \
    "--evidence report:nobody" "--evidence page:task/nobody/none" "--evidence ftp:x" "--about ../x"; do
    # shellcheck disable=SC2086 # each case is a flag list
    out=$(run_captain "$home" hold sample-refused --title 'Refused sample' --reason 'refused' $bad 2>&1); rc=$?
    expect_code 1 "$rc" "refused: $bad"
    assert_absent "$home/state/calls/sample-refused.json" "a refused hold left a record ($bad)"
    assert_no_grep "sample-refused" "$home/data/backlog.md" "a refused hold created its task ($bad)"
  done
  out=$(run_captain "$home" hold sample-refused --title 'Refused sample' --reason 'refused' \
    --option a="$(printf 'x%.0s' $(seq 1 201))" --option b=2 2>&1); rc=$?
  expect_code 1 "$rc" "a label over 200 characters"
  assert_contains "$out" "longer than 200 characters" "the long label is named"
  out=$(run_captain "$home" hold sample-refused --title 'Refused sample' --reason 'refused' \
    --question "$(printf 'first\nsecond')" 2>&1); rc=$?
  expect_code 1 "$rc" "a question across two lines"
  pass "hold records a call's content and refuses what nobody could answer"
}

test_a_hold_without_content_is_still_a_call() {
  local home call
  home=$(make_home plain)
  run_captain "$home" hold sample-plain --title 'Plain sample call' --reason 'plain question pending' >/dev/null \
    || fail "plain hold failed"
  assert_absent "$home/state/calls" "a hold without content wrote a record"
  call=$(call_json "$home" sample-plain)
  assert_equals 'plain question pending|[]|[]|done|open|live|true|null' \
    "$(printf '%s' "$call" | jq -r '[.question, (.options|tojson), (.evidence|tojson), .on_answer, .state, .bucket,
      (.captain_actionable|tostring), (.answer|tostring)] | join("|")')" \
    "a call with no record is listed from its row, with its hold reason as the question"
  pass "a hold made without content, as before this record, is still a call"
}

test_origin_evidence_is_derived_whatever_the_presentation_order() {
  local home call
  home=$(make_home origin)
  scout_task "$home" sample-scout
  present "$home" sample-scout sample-before >/dev/null || fail "present before the hold failed"
  run_captain "$home" hold sample-origin-call --title 'Call from the scout' --reason 'scout call' \
    --origin sample-scout --evidence url:https://example.invalid/pull/1 \
    --evidence page:task/sample-scout/sample-before >/dev/null || fail "hold with origin failed"
  present "$home" sample-scout sample-after >/dev/null || fail "present after the hold failed"
  call=$(call_json "$home" sample-origin-call)
  assert_equals '["url:https://example.invalid/pull/1","page:task/sample-scout/sample-before","report:sample-scout","page:task/sample-scout/sample-after"]' \
    "$(printf '%s' "$call" | jq -c .evidence)" \
    "explicit refs come first, then the origin's report and every page, de-duplicated, whenever each was presented"
  assert_equals sample-scout "$(printf '%s' "$call" | jq -r .origin)" "the origin is listed"
  assert_equals 2 "$(jq '.evidence | length' "$home/state/calls/sample-origin-call.json")" \
    "derived evidence is never written into the record"
  pass "a call raised with --origin is argued by everything its origin produced, in any order"
}

test_held_work_that_produced_something_is_its_own_origin() {
  local home call
  home=$(make_home self-origin)
  printf '%s\n' '## In flight' '' \
    '- [ ] sample-paged - Scout that presented a page (repo: sample) (kind: scout) (since 2026-09-01)' \
    '- [ ] sample-reported - Scout that wrote a report (repo: sample) (kind: scout) (since 2026-09-01)' \
    '' '## Queued' '' '## Done' > "$home/data/backlog.md"
  mkdir -p "$home/data/sample-paged"
  printf 'kind=scout\n' > "$home/state/sample-paged.meta"
  present "$home" sample-paged sample-findings >/dev/null || fail "present on the paged scout failed"
  scout_task "$home" sample-reported

  run_captain "$home" hold sample-paged --reason 'paged scout call' >/dev/null \
    || fail "bare hold of the paged scout failed"
  call=$(call_json "$home" sample-paged)
  assert_equals 'sample-paged|["page:task/sample-paged/sample-findings"]' \
    "$(printf '%s' "$call" | jq -r '[.origin, (.evidence|tojson)] | join("|")')" \
    "a bare hold of a task that presented a page links that page with no flag"
  assert_equals 0 "$(jq '.evidence | length' "$home/state/calls/sample-paged.json")" \
    "the link is the recorded origin, not a copied evidence ref"

  run_captain "$home" hold sample-reported --reason 'reported scout call' \
    --question 'Which way should the sample go?' --option left='Go left' --option right='Go right' >/dev/null \
    || fail "hold of the reported scout failed"
  present "$home" sample-reported sample-later >/dev/null || fail "present after the hold failed"
  call=$(call_json "$home" sample-reported)
  assert_equals 'sample-reported|["report:sample-reported","page:task/sample-reported/sample-later"]' \
    "$(printf '%s' "$call" | jq -r '[.origin, (.evidence|tojson)] | join("|")')" \
    "a held task's report and a page it presents later both argue its call"
  pass "holding work that already produced something makes it the call's origin"
}

test_a_defaulted_origin_links_without_changing_the_close() {
  local home call body
  home=$(make_home self-origin-close)
  printf '%s\n' '## In flight' '' \
    '- [ ] sample-bare - Scout with a report and a page (repo: sample) (kind: scout) (since 2026-09-01)' \
    '' '## Queued' '' '## Done' > "$home/data/backlog.md"
  scout_task "$home" sample-bare
  present "$home" sample-bare sample-bare-page >/dev/null || fail "present on the scout failed"

  run_captain "$home" hold sample-bare --reason 'bare scout call' >/dev/null || fail "bare hold failed"
  assert_equals 'sample-bare|null' \
    "$(jq -r '[.origin, (.on_answer|tostring)] | join("|")' "$home/state/calls/sample-bare.json")" \
    "a defaulted origin is recorded without declaring a close mode"
  call=$(call_json "$home" sample-bare)
  assert_equals 'sample-bare|["report:sample-bare","page:task/sample-bare/sample-bare-page"]' \
    "$(printf '%s' "$call" | jq -r '[.origin, (.evidence|tojson)] | join("|")')" \
    "the report and page argue the call through the origin"

  printf 'sample-bare\tkeep going\t\trelease\n' | run_captain "$home" answers --source quarterdeck >/dev/null \
    || fail "release of the bare hold failed"
  body=$(cd "$home" && tasks-axi show sample-bare --full)
  assert_contains "$body" "held: no" "the released scout resumed"
  CALL_NOW=2026-09-18T13:00:00Z run_captain "$home" hold sample-bare --reason 'bare scout call again' >/dev/null \
    || fail "second bare hold failed"
  assert_equals 'sample-bare|null' \
    "$(jq -r '[.origin, (.on_answer|tostring)] | join("|")' "$home/state/calls/sample-bare.json")" \
    "a re-hold of a self-origin call still declares no close mode"

  printf 'sample-bare\tlooks good\t\n' | CALL_NOW=2026-09-18T13:00:00Z run_captain "$home" answers --source "a chat relay" >/dev/null \
    || fail "chat-shaped answer failed"
  body=$(cd "$home" && tasks-axi show sample-bare --full)
  assert_contains "$body" "state: done" "an empty mode still closes a bare hold as done"
  call=$(call_json "$home" sample-bare)
  assert_equals 'closed|sample-bare|["report:sample-bare","page:task/sample-bare/sample-bare-page"]' \
    "$(printf '%s' "$call" | jq -r '[.state, .origin, (.evidence|tojson)] | join("|")')" \
    "the answered call keeps its linked evidence"
  pass "a defaulted origin links the held work without changing how the call closes"
}

test_a_held_task_is_not_its_own_origin_when_it_should_not_be() {
  local home call
  home=$(make_home no-self-origin)
  printf '%s\n' '## In flight' '' \
    '- [ ] sample-idle - Work that has produced nothing (repo: sample) (kind: ship) (since 2026-09-01)' \
    '- [ ] sample-gated - Work gated on another scout (repo: sample) (kind: ship) (since 2026-09-01)' \
    '- [ ] sample-named - Work whose call names a scout (repo: sample) (kind: ship) (since 2026-09-01)' \
    '' '## Queued' '' '## Done' > "$home/data/backlog.md"
  scout_task "$home" sample-scout
  scout_task "$home" sample-gated
  scout_task "$home" sample-named

  run_captain "$home" hold sample-idle --reason 'idle work call' >/dev/null || fail "bare hold of idle work failed"
  assert_absent "$home/state/calls/sample-idle.json" "a bare hold of work that produced nothing wrote a record"
  run_captain "$home" hold sample-idle --reason 'idle work call' --option a='A' --option b='B' >/dev/null \
    || fail "hold of idle work with content failed"
  assert_equals 'null|[]' "$(call_json "$home" sample-idle | jq -r '[(.origin|tostring), (.evidence|tojson)] | join("|")')" \
    "work that has produced nothing is not made an origin"

  mkdir -p "$home/data/sample-reused"
  printf '# An earlier task under this id\n' > "$home/data/sample-reused/report.md"
  run_captain "$home" hold sample-reused --title 'A new call under a reused id' --reason 'reused id call' >/dev/null \
    || fail "hold that creates its task failed"
  assert_absent "$home/state/calls/sample-reused.json" "a task the hold created was made its own origin"

  run_captain "$home" hold sample-gated --reason 'gated call' --origin sample-scout >/dev/null \
    || fail "hold with an explicit origin failed"
  assert_equals 'sample-scout|["report:sample-scout"]' \
    "$(call_json "$home" sample-gated | jq -r '[.origin, (.evidence|tojson)] | join("|")')" \
    "an explicit --origin wins over the held task's own work"

  run_captain "$home" hold sample-named --reason 'named call' --origin sample-scout >/dev/null \
    || fail "first hold of the named call failed"
  printf 'later\n' > "$home/named-decision.txt"
  run_captain "$home" answer sample-named --decision-file "$home/named-decision.txt" --release >/dev/null \
    || fail "releasing the named call failed"
  CALL_NOW=2026-09-19T12:00:00Z run_captain "$home" hold sample-named --reason 'named call' --until 2026-10-01 >/dev/null \
    || fail "deferring re-hold of the named call failed"
  assert_equals 'sample-scout|["report:sample-scout"]' \
    "$(call_json "$home" sample-named | jq -r '[.origin, (.evidence|tojson)] | join("|")')" \
    "a re-hold without --origin keeps the origin the call's record names"
  pass "a held task is not made its own origin when it produced nothing, was just created, or the call names another"
}

test_offer_and_evidence_change_a_call() {
  local home record out rc
  home=$(make_home offer)
  run_captain "$home" hold sample-offer --title 'Offer sample' --reason 'offer pending' \
    --option a='First' --option b='Second' >/dev/null || fail "hold failed"
  record="$home/state/calls/sample-offer.json"
  CALL_NOW=2026-09-18T13:00:00Z run_captain "$home" offer sample-offer --recommend b >/dev/null \
    || fail "offer --recommend failed"
  assert_equals 'b|2026-09-18T12:00:00Z|2026-09-18T13:00:00Z' \
    "$(jq -r '[(.options[] | select(.recommended) | .key), .raised_at, .updated_at] | join("|")' "$record")" \
    "offer marks the recommendation and records updated_at, keeping raised_at"
  CALL_NOW=2026-09-18T14:00:00Z run_captain "$home" offer sample-offer --question 'Now which?' \
    --option x='Ex' --option y='Why' --on-answer release >/dev/null || fail "offer replacement failed"
  assert_equals 'Now which?|x,y|release|2026-09-18T14:00:00Z' \
    "$(jq -r '[.question, ([.options[].key] | join(",")), .on_answer, .updated_at] | join("|")' "$record")" \
    "offer replaces the content it is given"
  out=$(run_captain "$home" offer sample-offer --recommend z 2>&1); rc=$?
  expect_code 1 "$rc" "offer recommending a missing option"
  out=$(run_captain "$home" offer sample-offer 2>&1); rc=$?
  expect_code 1 "$rc" "offer with nothing to change"

  printf '## In flight\n\n## Queued\n- [ ] sample-idle - Unheld sample (repo: sample) (kind: ship) (since 2026-09-01)\n\n## Done\n' \
    >> "$home/data/backlog.md"
  run_captain "$home" hold sample-legacy --title 'Legacy sample' --reason 'legacy' >/dev/null || fail "legacy hold failed"
  run_captain "$home" offer sample-legacy --option a=A --option b=B >/dev/null || fail "offer on a call with no record failed"
  assert_equals "null|2026-09-18T12:00:00Z" "$(jq -r '[(.on_answer|tostring), .raised_at] | join("|")' "$home/state/calls/sample-legacy.json")" \
    "offer on an older call creates its record from the hold, declaring no close it was not told"

  assert_contains "$(CALL_NOW=2026-09-18T15:00:00Z run_captain "$home" evidence sample-offer add url:https://example.invalid/doc)" \
    "added: sample-offer url:https://example.invalid/doc" "evidence add reports the ref"
  assert_contains "$(run_captain "$home" evidence sample-offer add url:https://example.invalid/doc)" \
    "unchanged: sample-offer" "attaching again changes nothing"
  assert_contains "$(run_captain "$home" evidence sample-offer remove url:https://example.invalid/doc)" \
    "removed: sample-offer" "evidence remove reports the ref"
  assert_equals 0 "$(jq '.evidence | length' "$record")" "the ref is gone"
  assert_equals 2026-09-18T14:00:00Z "$(jq -r .updated_at "$record")" \
    "attaching and detaching evidence never moves updated_at, which tracks the offered choice"
  out=$(run_captain "$home" evidence sample-offer add report:sample-none 2>&1); rc=$?
  expect_code 1 "$rc" "attaching a report that does not exist"

  printf 'Close it.\n' > "$home/decision.txt"
  run_captain "$home" answer sample-offer --decision-file "$home/decision.txt" >/dev/null || fail "answer failed"
  out=$(run_captain "$home" offer sample-offer --recommend x 2>&1); rc=$?
  expect_code 1 "$rc" "offer on a closed call"
  assert_contains "$out" "not an open captain call" "offer names why"
  run_captain "$home" evidence sample-offer add url:https://example.invalid/after >/dev/null \
    || fail "evidence could not be attached to a closed call"
  out=$(run_captain "$home" evidence sample-idle add url:https://example.invalid/x 2>&1); rc=$?
  expect_code 1 "$rc" "evidence on a task that is not a call"
  pass "offer and evidence change a call's content under its one owner"
}

test_answers_write_machine_lines_and_honor_on_answer() {
  local home out rc body call
  home=$(make_home answers)
  run_captain "$home" hold sample-question --title 'Question sample' --reason 'question pending' \
    --option keep='Keep it' --option drop='Drop it' >/dev/null || fail "question hold failed"
  (cd "$home" && tasks-axi add sample-gated 'Gated sample work' --kind ship --repo sample >/dev/null) || fail "add gated failed"
  run_captain "$home" hold sample-gated --reason 'gate pending' --option go='Go' --option wait='Wait' >/dev/null \
    || fail "gated hold failed"

  out=$(printf 'sample-question\tkeep\tKeep it\trelease\n' | run_captain "$home" answers --source quarterdeck); rc=$?
  expect_code 1 "$rc" "an answer whose mode disagrees with the declared close"
  assert_contains "$out" "skipped: sample-question (close mode release disagrees with the call's declared on_answer done)" \
    "the disagreement is named"
  out=$(printf 'sample-question\tkeep\tKeep it\tdone\nsample-gated\tgo\tGo\t\n' \
    | run_captain "$home" answers --source quarterdeck); rc=$?
  expect_code 0 "$rc" "answers closing both calls"
  assert_contains "$out" "closed: sample-question" "the question closed"
  assert_contains "$out" "closed: sample-gated" "the gated work closed"
  assert_contains "$out" "answers: closed=2 skipped=0" "the tally line"
  body=$(cd "$home" && tasks-axi show sample-question --full)
  assert_contains "$body" 'Resolution mode: answered\nAnswer key: keep\nAnswer label: Keep it\nAnswered by: captain\nAnswered via: quarterdeck\nAnswered at: 2026-09-18T12:00:00Z\n\nCaptain decision:' \
    "the block carries the machine lines between the mode and the captain's words"
  assert_contains "$body" "state: done" "the question closed as done"
  body=$(cd "$home" && tasks-axi show sample-gated --full)
  assert_contains "$body" "state: queued" "an empty mode took the declared release"
  assert_contains "$body" "held: no" "the gated work resumed"
  call=$(call_json "$home" sample-gated)
  assert_equals 'closed|go|Go|captain|quarterdeck|2026-09-18T12:00:00Z' \
    "$(printf '%s' "$call" | jq -r '[.state, .answer.key, .answer.label, .answer.by, .answer.via, .answer.at] | join("|")')" \
    "list reads the answer from the machine lines"
  out=$(printf 'sample-question\tkeep\tKeep it\tdone\n' | run_captain "$home" answers --source quarterdeck); rc=$?
  expect_code 0 "$rc" "an exact replay"
  assert_contains "$out" "closed: sample-question" "a replay is an idempotent close"

  run_captain "$home" hold sample-free --title 'Freeform sample' --reason 'free pending' \
    --option a=A --option b=B >/dev/null || fail "free hold failed"
  printf 'sample-free\tneither, do something else\t\n' | run_captain "$home" answers --source "a chat relay" >/dev/null \
    || fail "freeform answer failed"
  call=$(call_json "$home" sample-free)
  assert_equals 'null|neither, do something else|other' \
    "$(printf '%s' "$call" | jq -r '[(.answer.key|tostring), .answer.label, .answer.via] | join("|")')" \
    "an answer that names no option records no key"

  run_captain "$home" hold sample-direct --title 'Direct sample' --reason 'direct pending' \
    --option a='Alpha' --option b='Beta' >/dev/null || fail "direct hold failed"
  printf 'The captain said beta, with a caveat.\n' > "$home/direct.txt"
  out=$(run_captain "$home" answer sample-direct --decision-file "$home/direct.txt" --key c 2>&1); rc=$?
  expect_code 1 "$rc" "answer --key naming no option"
  run_captain "$home" answer sample-direct --decision-file "$home/direct.txt" --key b >/dev/null \
    || fail "answer --key failed"
  call=$(call_json "$home" sample-direct)
  assert_equals 'b|Beta|captain|chat' \
    "$(printf '%s' "$call" | jq -r '[.answer.key, .answer.label, .answer.by, .answer.via] | join("|")')" \
    "a relayed answer naming an option records it as chat"
  run_captain "$home" hold sample-words --title 'Words sample' --reason 'words pending' >/dev/null || fail "words hold failed"
  printf '\nShip it on Monday.\nNot before.\n' > "$home/words.txt"
  run_captain "$home" answer sample-words --decision-file "$home/words.txt" >/dev/null || fail "plain answer failed"
  assert_equals 'null|Ship it on Monday.|chat' \
    "$(call_json "$home" sample-words | jq -r '[(.answer.key|tostring), .answer.label, .answer.via] | join("|")')" \
    "a plain relayed answer labels itself with the captain's first line"
  pass "answers and answer record machine lines and honor the declared close"
}

test_answered_via_is_a_closed_channel_vocabulary() {
  local home out rc token
  home=$(make_home via)
  for token in lavish captured chat other; do
    run_captain "$home" hold "sample-via-$token" --title "Via $token sample" --reason 'via pending' \
      --option a=A --option b=B >/dev/null || fail "hold for $token failed"
    printf 'sample-via-%s\ta\tA\n' "$token" \
      | run_captain "$home" answers --source "some provenance text" --via "$token" >/dev/null \
      || fail "answers --via $token failed"
    assert_equals "$token" "$(call_json "$home" "sample-via-$token" | jq -r .answer.via)" \
      "answers --via $token records that token"
  done
  run_captain "$home" hold sample-via-qd --title 'Via app sample' --reason 'via pending' >/dev/null || fail "hold failed"
  printf 'sample-via-qd\tgo\tGo\n' | run_captain "$home" answers --source quarterdeck >/dev/null || fail "app answer failed"
  assert_equals quarterdeck "$(call_json "$home" sample-via-qd | jq -r .answer.via)" \
    "--source quarterdeck without --via records quarterdeck"
  run_captain "$home" hold sample-via-bad --title 'Via refused sample' --reason 'via pending' >/dev/null || fail "hold failed"
  out=$(printf 'sample-via-bad\tgo\tGo\n' | run_captain "$home" answers --source quarterdeck --via app 2>&1); rc=$?
  expect_code 1 "$rc" "answers with an unknown channel token"
  assert_contains "$out" "--via must be one of quarterdeck, chat, lavish, captured, decide, other: app" "the token is named"
  printf 'Go.\n' > "$home/go.txt"
  out=$(run_captain "$home" answer sample-via-bad --decision-file "$home/go.txt" --via "in chat" 2>&1); rc=$?
  expect_code 1 "$rc" "answer with an unknown channel token"
  assert_equals open "$(call_json "$home" sample-via-bad | jq -r .state)" "a refused channel closed nothing"
  run_captain "$home" answer sample-via-bad --decision-file "$home/go.txt" --via lavish >/dev/null || fail "answer --via failed"
  assert_equals lavish "$(call_json "$home" sample-via-bad | jq -r .answer.via)" "answer --via records its token"
  pass "Answered via is a token from a closed channel vocabulary, with defaults per command"
}

test_an_interrupted_close_reads_as_answered() {
  local home
  home=$(make_home interrupted)
  run_captain "$home" hold sample-interrupted --title 'Interrupted sample' --reason 'pending' \
    --option a=A --option b=B >/dev/null || fail "hold failed"
  cat > "$home/fakebin/tasks-axi" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = done ] && exit 92
exec "$REAL_TASKS_AXI" "$@"
EOF
  chmod +x "$home/fakebin/tasks-axi"
  if printf 'sample-interrupted\ta\tA\n' | run_captain "$home" answers --source quarterdeck >/dev/null; then
    fail "the forced close failure reported success"
  fi
  assert_equals 'answered|a' "$(call_json "$home" sample-interrupted | jq -r '[.state, .answer.key] | join("|")')" \
    "a recorded answer whose close was interrupted reads as answered"
  rm -f "$home/fakebin/tasks-axi"
  printf 'sample-interrupted\ta\tA\n' | run_captain "$home" answers --source quarterdeck >/dev/null || fail "retry failed"
  assert_equals closed "$(call_json "$home" sample-interrupted | jq -r .state)" "the retry closes it"

  # A re-held call starts a new lifecycle: its previous answer is history.
  (cd "$home" && tasks-axi add sample-rehold 'Rehold sample' --kind ship --repo sample >/dev/null) || fail "add failed"
  run_captain "$home" hold sample-rehold --reason 'first' --option a=A --option b=B >/dev/null || fail "first hold failed"
  printf 'sample-rehold\ta\tA\n' | run_captain "$home" answers --source quarterdeck >/dev/null || fail "release failed"
  CALL_NOW=2026-09-19T12:00:00Z run_captain "$home" hold sample-rehold --reason 'second' >/dev/null || fail "re-hold failed"
  assert_equals 'open|null|2026-09-19T12:00:00Z' \
    "$(CALL_NOW=2026-09-19T12:00:00Z call_json "$home" sample-rehold | jq -r '[.state, (.answer|tostring), .raised_at] | join("|")')" \
    "a re-held call is open again and raised anew"
  pass "list tells an interrupted close from a new lifecycle"
}

test_decide_records_a_call_settled_for_the_captain() {
  local home out rc first second call rows
  home=$(make_home decide)
  scout_task "$home" sample-about
  first=$(run_captain "$home" decide --about sample-about --title 'Merged the sample fix' \
    --what 'Merged the sample pull request' --why 'Every check passed' --kind merge \
    --link https://example.invalid/pull/7) || fail "decide failed"
  second=$(run_captain "$home" decide --about sample-about --title 'Merged the sample fix' \
    --what 'Merged the sample pull request' --why 'Every check passed' --kind merge \
    --link https://example.invalid/pull/7) || fail "decide retry failed"
  assert_equals "$first" "$second" "an exact retry names the same call"
  case "$first" in "decided: decided-"*) ;; *) fail "decide printed '$first'" ;; esac
  rows=$(grep -c 'Merged the sample fix' "$home/data/backlog.md")
  assert_equals 1 "$rows" "an exact retry raised no second row"
  call=$(call_json "$home" "${first#decided: }")
  assert_equals 'closed|firstmate|decide|Merged the sample pull request|null|sample-about|merge|Every check passed|https://example.invalid/pull/7|firstmate' \
    "$(printf '%s' "$call" | jq -r '[.state, .answer.by, .answer.via, .answer.label, (.answer.key|tostring), .about,
      .decided.kind, .decided.why, .decided.link, .raised_by] | join("|")')" \
    "the decided call is closed, answered by firstmate, and carries why"
  out=$(run_captain "$home" decide --about sample-about --title 'Another' --what 'Filed a task' --why 'It was needed' --kind new-task) \
    || fail "a second decision failed"
  assert_not_equals "$first" "$out" "a different decision is a different call"
  for bad in "--about sample-nobody" "--kind sometimes" "--link ftp://x"; do
    # shellcheck disable=SC2086 # each case is a flag list
    out=$(run_captain "$home" decide --about sample-about --title 'Bad' --what 'w' --why 'y' $bad 2>&1); rc=$?
    expect_code 1 "$rc" "refused decide: $bad"
  done
  out=$(run_captain "$home" decide --about sample-about --title 'Bad' --what "$(printf 'x%.0s' $(seq 1 201))" --why y 2>&1); rc=$?
  expect_code 1 "$rc" "a what over 200 characters"
  pass "decide raises and answers a call for the captain in one idempotent act"
}

test_list_window_damage_and_the_snapshot() {
  local home out snap list
  home=$(make_home window)
  printf 'Done.\n' > "$home/d.txt"
  CALL_NOW=2026-09-01T12:00:00Z run_captain "$home" hold sample-old --title 'Old sample' --reason 'old' \
    --option a=A --option b=B >/dev/null || fail "old hold failed"
  CALL_NOW=2026-09-01T12:00:00Z run_captain "$home" answer sample-old --decision-file "$home/d.txt" --key a >/dev/null \
    || fail "old answer failed"
  run_captain "$home" hold sample-open --title 'Open sample' --reason 'open' --option a=A --option b=B >/dev/null \
    || fail "open hold failed"
  printf '{"schema":"fm-call.v1","task":"sample-open"' > "$home/state/calls/sample-open.json"
  printf 'not json at all' > "$home/state/calls/sample-junk.json"
  out=$(run_captain "$home" list --json) || fail "list failed over damaged records"
  assert_equals 'sample-open' "$(printf '%s' "$out" | jq -r '[.calls[].id] | join(",")')" \
    "the default window keeps open calls and drops calls closed over 7 days ago"
  assert_equals 'sample-junk,sample-open' "$(printf '%s' "$out" | jq -r '[.damaged[].task] | sort | join(",")')" \
    "damaged records are reported"
  assert_equals '[]' "$(printf '%s' "$out" | jq -c '.calls[0].options')" "a damaged record is skipped, the call is not"
  assert_equals 'sample-old,sample-open' \
    "$(run_captain "$home" list --json --since 30 | jq -r '[.calls[].id] | sort | join(",")')" "--since widens the window"
  assert_contains "$(run_captain "$home" list)" "damaged: sample-junk" "the text listing reports damage too"

  snap=$(snapshot "$home") || fail "snapshot failed"
  list=$(run_captain "$home" list --json)
  assert_equals "$(printf '%s' "$list" | jq -c .calls)" "$(printf '%s' "$snap" | jq -c .calls)" \
    "the snapshot's calls[] is exactly list --json's array"
  assert_equals 'false|false' "$(printf '%s' "$snap" | jq -r '[has("decision_options"), has("decided")] | map(tostring) | join("|")')" \
    "decision_options[] and decided[] are gone from the snapshot"
  pass "list keeps a window, survives damage, and is the snapshot's calls[]"
}

test_migrate_imports_the_old_stores_idempotently() {
  local home out rev
  home=$(make_home migrate)
  scout_task "$home" sample-scout
  run_captain "$home" hold sample-migrated --title 'Migrated sample' --reason 'migrated' >/dev/null || fail "hold failed"
  mkdir -p "$home/state/decision-options"
  printf '%s\n' '{"schema":"fm-decision-options.v1","task":"sample-migrated","question":"Old question?","options":[{"key":"a","label":"A","recommended":true},{"key":"b","label":"B","recommended":false}],"set_at":"2026-09-17T00:00:00Z"}' \
    > "$home/state/decision-options/sample-migrated.json"
  printf '%s\n' '{"schema":"fm-decision-options.v1","task":"sample-scout","question":"","options":[{"key":"a","label":"A","recommended":false},{"key":"b","label":"B","recommended":false}],"set_at":"2026-09-17T00:00:00Z"}' \
    > "$home/state/decision-options/sample-scout.json"
  present "$home" sample-scout sample-page >/dev/null || fail "present failed"
  rev="$home/data/sample-scout/artifacts/sample-page/rev-1/revision.json"
  jq '. + {covers:["sample-migrated"]}' "$rev" > "$rev.new" && mv "$rev.new" "$rev"
  out=$(run_captain "$home" migrate) || fail "migrate failed"
  assert_contains "$out" "imported: sample-migrated options" "the options were imported"
  assert_contains "$out" "attached: sample-migrated page:task/sample-scout/sample-page" "covers became evidence"
  assert_contains "$out" "skipped: sample-scout (not a captain call)" "a task that is not a call is skipped"
  assert_equals 'Old question?|a|page:task/sample-scout/sample-page' \
    "$(jq -r '[.question, (.options[] | select(.recommended) | .key), .evidence[0]] | join("|")' "$home/state/calls/sample-migrated.json")" \
    "the call record carries what the old stores held"
  cp "$home/state/calls/sample-migrated.json" "$home/before.json"
  out=$(run_captain "$home" migrate) || fail "second migrate failed"
  assert_contains "$out" "migrate: imported=0 attached=0" "a second run changes nothing"
  cmp -s "$home/before.json" "$home/state/calls/sample-migrated.json" || fail "a second migrate rewrote the record"
  assert_present "$home/state/decision-options/sample-migrated.json" "migrate leaves the old files in place"
  pass "migrate imports the old option and covers stores once"
}

test_migrate_gives_older_answers_their_machine_lines() {
  local home out id before after digests_before closed
  home=$(make_home backfill)
  (cd "$home" && tasks-axi add sample-bf-released 'Released sample' --kind ship --repo sample >/dev/null) || fail "add failed"
  for id in sample-bf-keyed sample-bf-prefix sample-bf-prose sample-bf-label sample-bf-spaced; do
    run_captain "$home" hold "$id" --title "Backfill $id" --reason 'backfill pending' \
      --option fast='Take the fast route' --option safe='Take the safe route' >/dev/null || fail "hold $id failed"
  done
  run_captain "$home" hold sample-bf-released --reason 'backfill pending' \
    --option fast='Take the fast route' --option safe='Take the safe route' >/dev/null || fail "hold released failed"
  printf 'sample-bf-keyed\tfast\tTake the fast route\n' | run_captain "$home" answers --source quarterdeck >/dev/null \
    || fail "keyed answer failed"
  printf 'safe: because it is safer\n' > "$home/prefix.txt"
  printf 'fastest route please\n' > "$home/prose.txt"
  printf 'Take the safe route\n' > "$home/label.txt"
  printf '\n   fast = go now   \nmore words\n' > "$home/spaced.txt"
  printf 'safe - resume the work\n' > "$home/released.txt"
  for id in prefix prose label spaced; do
    run_captain "$home" answer "sample-bf-$id" --decision-file "$home/$id.txt" >/dev/null || fail "answer $id failed"
  done
  run_captain "$home" answer sample-bf-released --decision-file "$home/released.txt" --release >/dev/null \
    || fail "release answer failed"
  CALL_NOW=2026-09-19T12:00:00Z run_captain "$home" decide --about sample-bf-keyed --title 'Decided sample' \
    --what 'Filed a follow-up' --why 'It was needed' >/dev/null || fail "decide failed"
  # Make every answered block but the decided one look as it did before the
  # machine lines existed.
  sed -i.bak -e '/Decided sample/,/^- /!{/^  Answer key: /d;/^  Answer label: /d;/^  Answered by: /d;/^  Answered via: /d;/^  Answered at: /d;}' \
    "$home/data/backlog.md"
  assert_equals 1 "$(grep -c '^  Answered by: ' "$home/data/backlog.md")" "fixture: only the decided call keeps its lines"
  assert_equals null "$(call_json "$home" sample-bf-prefix | jq -c .answer)" "fixture: an older answer lists no structured answer"
  digests_before=$(grep 'Decision digest:' "$home/data/backlog.md")
  closed=$(cd "$home" && tasks-axi show sample-bf-keyed --full | sed -n 's/^  closed: //p')

  out=$(run_captain "$home" migrate) || fail "migrate failed"
  assert_contains "$out" "answered: sample-bf-keyed key=fast" "a keyed block recovers its key"
  assert_contains "$out" "answered: sample-bf-prefix key=safe" "a line starting with the key and a colon names it"
  assert_contains "$out" "answered: sample-bf-prose key=-" "a key that is only a prefix of a word names nothing"
  assert_contains "$out" "answered: sample-bf-label key=safe" "a line equal to an option label names it"
  assert_contains "$out" "answered: sample-bf-spaced key=fast" "the first non-empty line, trimmed, is what is read"
  assert_contains "$out" "answered: sample-bf-released key=safe" "a key followed by a spaced dash names it"
  assert_contains "$out" "answered=6" "only the older answers were backfilled"
  assert_equals "$digests_before" "$(grep 'Decision digest:' "$home/data/backlog.md")" "no digest changed"
  assert_equals "fast|Take the fast route|captain|other|$closed" \
    "$(call_json "$home" sample-bf-keyed | jq -r '[.answer.key, .answer.label, .answer.by, .answer.via, .answer.at] | join("|")')" \
    "list reports the backfilled answer"
  assert_equals 'null|fastest route please' \
    "$(call_json "$home" sample-bf-prose | jq -r '[(.answer.key|tostring), .answer.label] | join("|")')" \
    "an unrecovered key stays out and the label is the captain's first line"
  assert_equals 'fast|Take the fast route' "$(call_json "$home" sample-bf-spaced | jq -r '[.answer.key, .answer.label] | join("|")')" \
    "a recovered key is labelled with its option's own label"
  assert_contains "$(cd "$home" && tasks-axi show sample-bf-prefix --full)" \
    "Resolution mode: answered\\nAnswer key: safe\\nAnswer label: Take the safe route\\nAnswered by: captain\\nAnswered via: other\\nAnswered at: $closed\\n\\nCaptain decision:\\nsafe: because it is safer" \
    "the lines sit under the mode and the decision text is untouched"
  assert_not_contains "$(cd "$home" && tasks-axi show sample-bf-released --full)" "Answered at:" \
    "a released call with no close date gets no resolution time"

  before=$(cat "$home/data/backlog.md")
  out=$(run_captain "$home" migrate) || fail "second migrate failed"
  assert_contains "$out" "migrate: imported=0 attached=0 answered=0" "a second migrate backfills nothing"
  after=$(cat "$home/data/backlog.md")
  assert_equals "$before" "$after" "a second migrate left the backlog as it was"
  out=$(run_captain "$home" answer sample-bf-prefix --decision-file "$home/prefix.txt") \
    || fail "an exact answer retry no longer matches after the backfill"
  assert_contains "$out" "answered: sample-bf-prefix" "the retry is the idempotent no-op"
  printf 'sample-bf-keyed\tfast\tTake the fast route\n' | run_captain "$home" answers --source quarterdeck >/dev/null \
    || fail "an exact keyed replay no longer matches after the backfill"

  # A home that ran the earlier migrate carries the prose line as the label of
  # a call whose key it recovered; migrate corrects only what it wrote itself.
  sed -i.bak -e 's/^  Answer label: Take the safe route$/  Answer label: safe: because it is safer/' \
    -e 's/^  Answer label: Take the fast route$/  Answer label: fast = go now/' "$home/data/backlog.md"
  out=$(run_captain "$home" migrate) || fail "relabeling migrate failed"
  assert_contains "$out" "relabeled: sample-bf-prefix key=safe" "an earlier backfill's prose label is corrected"
  assert_contains "$out" "relabeled: sample-bf-spaced key=fast" "a trimmed prose label is corrected"
  assert_contains "$out" "answered=0 relabeled=2" "only those two were relabeled"
  assert_equals 'safe|Take the safe route' "$(call_json "$home" sample-bf-prefix | jq -r '[.answer.key, .answer.label] | join("|")')" \
    "the corrected call lists its option's label"
  assert_equals "$digests_before" "$(grep 'Decision digest:' "$home/data/backlog.md")" "relabeling changed no digest"
  out=$(run_captain "$home" migrate) || fail "migrate after relabeling failed"
  assert_contains "$out" "answered=0 relabeled=0" "relabeling happens once"
  pass "migrate gives answers recorded before the machine lines their lines, once"
}

test_the_retired_surfaces_are_shims() {
  local home out rc rev
  home=$(make_home shims)
  scout_task "$home" sample-scout
  run_captain "$home" hold sample-shim --title 'Shim sample' --reason 'shim' >/dev/null || fail "hold failed"
  PATH="$home/fakebin:$PATH" FM_CAPTAIN_HOLD_NOW=$NOW FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" \
    FM_DATA_OVERRIDE="$home/data" "$ROOT/bin/fm-decision-options.sh" set sample-shim \
    --option a='Do it' --option b='Do not' --recommend a --question 'Shall we?' >/dev/null || fail "options shim failed"
  assert_equals 'Shall we?|a' "$(jq -r '[.question, (.options[] | select(.recommended) | .key)] | join("|")' "$home/state/calls/sample-shim.json")" \
    "fm-decision-options.sh set records through offer"
  assert_absent "$home/state/decision-options" "the shim writes nothing to the old store"
  out=$(FM_HOME="$home" "$ROOT/bin/fm-decision-options.sh" list 2>&1); rc=$?
  expect_code 2 "$rc" "a retired options command"

  out=$(present "$home" sample-scout sample-covering --covers sample-shim) || fail "present --covers failed"
  rev="$home/data/sample-scout/artifacts/sample-covering/rev-1/revision.json"
  assert_equals false "$(jq 'has("covers")' "$rev")" "a revision no longer records covers"
  assert_equals 'page:task/sample-scout/sample-covering' "$(jq -r '.evidence[0]' "$home/state/calls/sample-shim.json")" \
    "--covers attaches the page to the call"
  out=$(present "$home" sample-scout sample-covering --covers sample-scout 2>&1); rc=$?
  expect_code 1 "$rc" "--covers naming a task that is not a call"
  assert_contains "$out" "unchanged: sample-covering rev 1" "the page itself still stands"
  assert_contains "$out" "could not be attached to call 'sample-scout'" "the failed attachment is named"
  pass "fm-decision-options.sh and present --covers are shims over the call owner"
}

reply_json() {  # <home> <id>: the call's listed reply
  CALL_NOW=${CALL_NOW:-$NOW} call_json "$1" "$2" | jq -c .reply
}

test_reply_keeps_the_captains_words_beside_an_open_call() {
  local home record out rc before
  home=$(make_home reply)
  run_captain "$home" hold sample-reply --title 'Reply sample' --reason 'reply pending' \
    --question 'Which route?' --option fast='Fast' --option safe='Safe' >/dev/null || fail "hold failed"
  record="$home/state/calls/sample-reply.json"
  printf 'it does not make sense that screenshots cannot be attached, right?\nthey could last week.\n' > "$home/words.txt"
  assert_equals "unchanged: sample-reply" \
    "$(run_captain "$home" reply sample-reply --words-file "$home/words.txt" --via quarterdeck --message m1)" \
    "naming a message on a call carrying no reply changes nothing"
  assert_equals null "$(jq -c .reply "$record")" "naming a message never writes a reply"
  out=$(CALL_NOW=2026-09-18T12:05:00Z run_captain "$home" reply sample-reply --words-file "$home/words.txt" \
    --via quarterdeck) || fail "reply failed: $out"
  assert_equals "replied: sample-reply" "$out" "reply names the call"
  CALL_NOW=2026-09-18T12:05:30Z run_captain "$home" reply sample-reply --words-file "$home/words.txt" \
    --via quarterdeck --message m1790375413720-25 >/dev/null || fail "naming the message failed"
  assert_equals 'quarterdeck|2026-09-18T12:05:00Z|m1790375413720-25|null|2026-09-18T12:00:00Z' \
    "$(jq -r '[.reply.via, .reply.at, .reply.message, (.reply.previous|tostring), .updated_at] | join("|")' "$record")" \
    "the record carries how, when, and in which message, and a reply never moves updated_at"
  assert_equals "$(printf 'it does not make sense that screenshots cannot be attached, right?\nthey could last week.')" \
    "$(jq -r .reply.words "$record")" "the words are kept exactly, every line"
  assert_equals 'open|live|true|quarterdeck|m1790375413720-25|null' \
    "$(CALL_NOW=2026-09-18T12:06:00Z call_json "$home" sample-reply | jq -r '[.state, .bucket,
      (.captain_actionable|tostring), .reply.via, .reply.message, (.answer|tostring)] | join("|")')" \
    "list carries the reply, and leaves state, bucket, captain_actionable, and answer as they were"
  assert_contains "$(CALL_NOW=2026-09-18T12:06:00Z run_captain "$home" list)" \
    "reply: 2026-09-18T12:05:00Z via quarterdeck  it does not make sense" "the text listing shows the reply"

  before=$(cat "$record")
  assert_equals "unchanged: sample-reply" \
    "$(CALL_NOW=2026-09-18T12:07:00Z run_captain "$home" reply sample-reply --words-file "$home/words.txt" \
      --via quarterdeck --message m1790375413720-25)" "an exact retry changes nothing"
  assert_equals "$before" "$(cat "$record")" "the retried record is byte for byte the same"

  printf 'Not now. Ask me again on Oct 3.\n' > "$home/later.txt"
  CALL_NOW=2026-09-18T12:10:00Z run_captain "$home" reply sample-reply --words-file "$home/later.txt" --via review \
    >/dev/null || fail "second reply failed"
  assert_equals 'Not now. Ask me again on Oct 3.|review|null|quarterdeck|2026-09-18T12:05:00Z|m1790375413720-25|false' \
    "$(jq -r '[.reply.words, .reply.via, (.reply.message|tostring), .reply.previous.via, .reply.previous.at,
      .reply.previous.message, (.reply.previous | has("previous"))] | join("|")' "$record")" \
    "a later reply replaces the earlier one and keeps it, one level deep, as previous"

  # A surface keeps the words first and names the message that carried them once it has gone.
  CALL_NOW=2026-09-18T12:12:00Z run_captain "$home" reply sample-reply --words-file "$home/later.txt" --via review \
    --message m42 >/dev/null || fail "naming the message failed"
  assert_equals 'm42|2026-09-18T12:10:00Z|quarterdeck' \
    "$(jq -r '[.reply.message, .reply.at, .reply.previous.via] | join("|")' "$record")" \
    "naming the message later fills it in, keeping when the captain replied and what he said before"

  # A message named for words the captain has since replaced leaves the newer reply standing.
  before=$(cat "$record")
  assert_equals "unchanged: sample-reply" \
    "$(CALL_NOW=2026-09-18T12:14:00Z run_captain "$home" reply sample-reply --words-file "$home/words.txt" \
      --via quarterdeck --message m43)" "naming a message for older words changes nothing"
  assert_equals "$before" "$(cat "$record")" "the newer reply stands, byte for byte"
  assert_equals "unchanged: sample-reply" \
    "$(CALL_NOW=2026-09-18T12:15:00Z run_captain "$home" reply sample-reply --words-file "$home/later.txt" \
      --via review --message m44)" "the same words already naming another message are left as they are"
  assert_equals "$before" "$(cat "$record")" "the reply keeps the message that carried it"
  pass "reply keeps the captain's words, how and when, beside an open call without deciding it"
}

test_reply_refuses_what_it_cannot_keep() {
  local home out rc bad
  home=$(make_home reply-refused)
  run_captain "$home" hold sample-open --title 'Open sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  printf 'my words\n' > "$home/words.txt"
  : > "$home/empty.txt"
  printf '  \n\n' > "$home/blank.txt"
  for bad in "--via app" "--via" "--words-file $home/empty.txt --via quarterdeck" \
    "--words-file $home/blank.txt --via quarterdeck" "--words-file $home/none.txt --via quarterdeck" \
    "--via quarterdeck --message bad/id"; do
    case "$bad" in --words-file*) ;; *) bad="--words-file $home/words.txt $bad" ;; esac
    # shellcheck disable=SC2086 # each case is a flag list
    out=$(run_captain "$home" reply sample-open $bad 2>&1); rc=$?
    [ "$rc" -ne 0 ] || fail "reply accepted: $bad"
  done
  assert_equals null "$(jq -c .reply "$home/state/calls/sample-open.json")" "no refused reply was kept"
  head -c 8193 /dev/zero | tr '\0' x > "$home/long.txt"
  out=$(run_captain "$home" reply sample-open --words-file "$home/long.txt" --via chat 2>&1); rc=$?
  expect_code 1 "$rc" "a reply over 8192 bytes"

  out=$(run_captain "$home" reply sample-absent --words-file "$home/words.txt" --via quarterdeck 2>&1); rc=$?
  expect_code 1 "$rc" "a reply to a call this home does not have"
  assert_equals "fm-captain-hold: call sample-absent is not in this home's backlog" "$out" \
    "the refusal is one line the app can show"
  assert_absent "$home/state/calls/sample-absent.json" "a refused reply wrote no record"

  printf '## In flight\n\n## Queued\n- [ ] sample-idle - Unheld sample (repo: sample) (kind: ship) (since 2026-09-01)\n\n## Done\n' \
    >> "$home/data/backlog.md"
  out=$(run_captain "$home" reply sample-idle --words-file "$home/words.txt" --via quarterdeck 2>&1); rc=$?
  expect_code 1 "$rc" "a reply to a task nobody is asking the captain about"
  assert_equals "fm-captain-hold: call sample-idle is not waiting on the captain" "$out" "the refusal says why"

  printf 'Close it.\n' > "$home/decision.txt"
  run_captain "$home" answer sample-open --decision-file "$home/decision.txt" >/dev/null || fail "answer failed"
  out=$(run_captain "$home" reply sample-open --words-file "$home/words.txt" --via quarterdeck 2>&1); rc=$?
  expect_code 1 "$rc" "a reply to a closed call"
  assert_equals "fm-captain-hold: call sample-open is already closed" "$out" "the refusal says the call is closed"
  assert_equals null "$(jq -c .reply "$home/state/calls/sample-open.json")" "the closed call carries no reply"

  # An answer recorded in this lifecycle whose close was interrupted is not open to a reply.
  run_captain "$home" hold sample-half --title 'Half sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  cat > "$home/fakebin/tasks-axi" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = done ] && exit 92
exec "$REAL_TASKS_AXI" "$@"
EOF
  chmod +x "$home/fakebin/tasks-axi"
  printf 'sample-half\ta\tA\n' | run_captain "$home" answers --source quarterdeck >/dev/null 2>&1 \
    && fail "the forced close failure reported success"
  rm -f "$home/fakebin/tasks-axi"
  out=$(run_captain "$home" reply sample-half --words-file "$home/words.txt" --via quarterdeck 2>&1); rc=$?
  expect_code 1 "$rc" "a reply to a call whose answer is already recorded"
  assert_equals "fm-captain-hold: call sample-half already has a recorded answer" "$out" "the refusal says so"
  pass "reply refuses, in one line, a call that is absent, closed, not the captain's, or already answered"
}

test_reply_takes_the_calls_control_lock() {
  local home lock holder waiter i=0
  home=$(make_home reply-lock)
  run_captain "$home" hold sample-locked --title 'Locked sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  printf 'my words\n' > "$home/words.txt"
  lock="$home/state/.control-sample-locked.lock"
  (
    # shellcheck source=/dev/null
    . "$ROOT/bin/fm-wake-lib.sh"
    fm_lock_try_acquire "$lock" || exit 1
    sleep 2
    fm_lock_release "$lock"
  ) &
  holder=$!
  while [ ! -e "$lock" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  [ -e "$lock" ] || { kill "$holder" 2>/dev/null; fail "could not stage a held control lock"; }
  run_captain "$home" reply sample-locked --words-file "$home/words.txt" --via quarterdeck >/dev/null &
  waiter=$!
  sleep 1
  assert_equals null "$(jq -c .reply "$home/state/calls/sample-locked.json")" \
    "a reply waits while another writer holds the call's lock"
  wait "$holder" 2>/dev/null || true
  wait "$waiter" || fail "the waiting reply failed"
  assert_equals '"my words"' "$(jq -c .reply.words "$home/state/calls/sample-locked.json")" \
    "the reply lands once the lock is free"
  pass "reply writes under the call's control lock"
}

test_only_the_first_mate_acting_clears_a_reply() {
  local home record words
  home=$(make_home reply-clear)
  words="$home/words.txt"
  printf 'my words\n' > "$words"
  printf 'Go.\n' > "$home/decision.txt"
  run_captain "$home" hold sample-clear --title 'Clear sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  record="$home/state/calls/sample-clear.json"

  run_captain "$home" reply sample-clear --words-file "$words" --via quarterdeck >/dev/null || fail "reply failed"
  run_captain "$home" evidence sample-clear add url:https://example.invalid/doc >/dev/null || fail "evidence failed"
  CALL_NOW=2026-09-18T12:30:00Z run_captain "$home" list --json >/dev/null || fail "list failed"
  assert_not_equals null "$(jq -c .reply "$record")" "evidence and list leave a reply alone"

  CALL_NOW=2026-09-18T13:00:00Z run_captain "$home" offer sample-clear --question 'Asked again?' >/dev/null \
    || fail "offer failed"
  assert_equals 'null|2026-09-18T13:00:00Z' "$(jq -r '[(.reply|tostring), .updated_at] | join("|")' "$record")" \
    "offer is the first mate asking again: it clears the reply and moves updated_at as it always does"
  assert_equals "unchanged: sample-clear" \
    "$(run_captain "$home" reply sample-clear --words-file "$words" --via quarterdeck --message m1)" \
    "naming the message after offer cleared the reply changes nothing"
  assert_equals null "$(jq -c .reply "$record")" "the reply the first mate acted on stays cleared"

  run_captain "$home" reply sample-clear --words-file "$words" --via quarterdeck >/dev/null || fail "reply failed"
  CALL_NOW=2026-09-18T14:00:00Z run_captain "$home" hold sample-clear --reason 'deferred' --until 2026-10-03 >/dev/null \
    || fail "hold --until failed"
  assert_equals 'null|2026-09-18T13:00:00Z' "$(jq -r '[(.reply|tostring), .updated_at] | join("|")' "$record")" \
    "a fresh hold, deferral included, clears the reply without moving updated_at"

  run_captain "$home" reply sample-clear --words-file "$words" --via quarterdeck >/dev/null || fail "reply failed"
  run_captain "$home" answer sample-clear --decision-file "$home/decision.txt" --key a >/dev/null || fail "answer failed"
  assert_equals 'null|closed|null' \
    "$(jq -r '.reply|tostring' "$record")|$(call_json "$home" sample-clear | jq -r '[.state, (.reply|tostring)] | join("|")')" \
    "answer clears the reply as part of recording"

  run_captain "$home" hold sample-keyed --title 'Keyed sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  run_captain "$home" reply sample-keyed --words-file "$words" --via review >/dev/null || fail "reply failed"
  printf 'sample-keyed\tb\tB\n' | run_captain "$home" answers --source quarterdeck >/dev/null || fail "keyed answer failed"
  assert_equals null "$(jq -c .reply "$home/state/calls/sample-keyed.json")" "the keyed intake clears the reply too"

  # A call with no record: reply creates one dated from the hold, and answer clears it.
  run_captain "$home" hold sample-bare --title 'Bare sample' --reason 'pending' >/dev/null || fail "hold failed"
  CALL_NOW=2026-09-18T15:00:00Z run_captain "$home" reply sample-bare --words-file "$words" --via chat >/dev/null \
    || fail "reply on a call without a record failed"
  assert_equals '2026-09-18T12:00:00Z|2026-09-18T12:00:00Z|chat|null' \
    "$(jq -r '[.raised_at, .updated_at, .reply.via, (.on_answer|tostring)] | join("|")' "$home/state/calls/sample-bare.json")" \
    "a reply on an older call creates its record from the hold, declaring nothing it was not told"
  run_captain "$home" answer sample-bare --decision-file "$home/decision.txt" >/dev/null || fail "answer failed"
  assert_equals null "$(jq -c .reply "$home/state/calls/sample-bare.json")" "answer clears it"
  pass "only answer, offer, and hold - the first mate acting - clear a reply"
}

test_replies_lists_what_waits_on_the_first_mate() {
  local home out
  home=$(make_home replies)
  printf 'first line\nsecond line\n' > "$home/words.txt"
  assert_equals "" "$(run_captain "$home" replies)" "a home with no calls reports nothing"
  run_captain "$home" hold sample-waiting --title 'Waiting sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  run_captain "$home" hold sample-quiet --title 'Quiet sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  assert_equals "" "$(run_captain "$home" replies)" "calls without a reply report nothing"
  CALL_NOW=2026-09-18T12:10:00Z run_captain "$home" reply sample-waiting --words-file "$home/words.txt" --via quarterdeck \
    >/dev/null || fail "reply failed"
  assert_equals "" "$(CALL_NOW=2026-09-18T12:14:00Z run_captain "$home" replies --older-than 5)" \
    "a reply younger than the threshold is still the first mate's to handle in its turn"
  out=$(CALL_NOW=2026-09-18T12:15:00Z run_captain "$home" replies --older-than 5)
  assert_equals "$(printf 'sample-waiting\t2026-09-18T12:10:00Z\tquarterdeck\tfirst line')" "$out" \
    "an overdue reply is listed with when, how, and its first line"
  out=$(CALL_NOW=2026-09-18T12:15:00Z run_captain "$home" replies --older-than soon 2>&1) && fail "a bad threshold was accepted"
  printf 'Go.\n' > "$home/decision.txt"
  run_captain "$home" answer sample-waiting --decision-file "$home/decision.txt" >/dev/null || fail "answer failed"
  assert_equals "" "$(CALL_NOW=2026-09-18T13:00:00Z run_captain "$home" replies)" "a handled reply is no longer listed"
  pass "replies lists every open call whose reply is waiting on the first mate"
}

test_the_wake_drain_prints_unhandled_replies() {
  local home out
  home=$(make_home replies-drain)
  printf 'we already attach screenshots, right?\n' > "$home/words.txt"
  run_captain "$home" hold sample-drained --title 'Drained sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  CALL_NOW=2026-09-18T12:00:00Z run_captain "$home" reply sample-drained --words-file "$home/words.txt" --via quarterdeck \
    >/dev/null || fail "reply failed"
  drain() {
    PATH="$home/fakebin:$PATH" FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
      FM_CONFIG_OVERRIDE="$home/config" FM_CAPTAIN_HOLD_NOW="$1" "$ROOT/bin/fm-wake-drain.sh" 2>/dev/null
  }
  out=$(drain 2026-09-18T12:02:00Z)
  assert_not_contains "$out" "UNHANDLED REPLIES" "a fresh reply is not yet overdue"
  out=$(drain 2026-09-18T12:06:00Z)
  assert_contains "$out" "UNHANDLED REPLIES (the captain replied on these calls" "an overdue reply is the first mate's alarm"
  assert_contains "$out" "sample-drained: the captain replied via quarterdeck at 2026-09-18T12:00:00Z, still unrecorded: we already attach screenshots, right?" \
    "the line names the call, how, when, and the words"
  assert_contains "$out" "never infer an answer from the reply alone" "the hint names both ways to act and forbids inferring"
  out=$(drain 2026-09-18T12:07:00Z)
  assert_contains "$out" "sample-drained: the captain replied" "it prints again on every drain until someone acts"
  CALL_NOW=2026-09-18T12:08:00Z run_captain "$home" offer sample-drained --question 'Asked again' >/dev/null || fail "offer failed"
  out=$(drain 2026-09-18T12:30:00Z)
  assert_not_contains "$out" "UNHANDLED REPLIES" "re-asking silences it"
  pass "the wake drain prints UNHANDLED REPLIES until the first mate acts"
}

test_a_refused_deferral_keeps_the_reply_and_a_valid_one_clears_it() {
  local home record out rc
  home=$(make_home reply-defer)
  printf 'Not now. Ask me again on Oct 3.\n' > "$home/words.txt"
  run_captain "$home" hold sample-defer --title 'Defer sample' --reason 'pending' --option a=A --option b=B >/dev/null \
    || fail "hold failed"
  record="$home/state/calls/sample-defer.json"
  run_captain "$home" reply sample-defer --words-file "$home/words.txt" --via quarterdeck >/dev/null || fail "reply failed"
  # 2026-09-18T12:00:00Z is still 2026-09-18 in Los Angeles, so that day is already due there.
  out=$(TZ=America/Los_Angeles run_captain "$home" hold sample-defer --reason 'deferred' --until 2026-09-18 2>&1); rc=$?
  expect_code 1 "$rc" "a deferral to a day already due on the captain's calendar"
  assert_contains "$out" "is not after the captain's today (2026-09-18)" "the refusal names the captain's day"
  assert_equals '"Not now. Ask me again on Oct 3."' "$(jq -c .reply.words "$record")" \
    "a refused deferral changes nothing, so the captain's reply is still waiting on the first mate"
  TZ=America/Los_Angeles run_captain "$home" hold sample-defer --reason 'deferred' --until 2026-10-03 >/dev/null \
    || fail "a deferral to a later day failed"
  assert_equals null "$(jq -c .reply "$record")" "a deferral the captain's calendar accepts clears the reply"
  assert_equals 'open|null' "$(call_json "$home" sample-defer | jq -r '[.state, (.reply|tostring)] | join("|")')" \
    "the deferred call is still open and lists no reply"
  pass "a refused deferral keeps the captain's reply, and a valid one clears it"
}

PROPOSALS="$ROOT/tests/fixtures/proposed-call"

# A finished scout still in this home: its row, its record, and a real report
# from tests/fixtures/proposed-call, which keeps each one's own Proposed call.
proposing_scout() {  # <home> <id> [<fixture-id>]
  local home=$1 id=$2 fixture=${3:-$2}
  mkdir -p "$home/data/$id"
  cp "$PROPOSALS/$fixture.md" "$home/data/$id/report.md"
  printf 'kind=scout\n' > "$home/state/$id.meta"
  printf 'done: report written\n' > "$home/state/$id.status"
  (cd "$home" && tasks-axi add "$id" "Scout $id" --kind scout --repo sample --start >/dev/null) \
    || fail "could not file the scout row $id"
}

# The line of the fixture's report that first matches <pattern>.
report_line() {  # <home> <id> <grep-pattern>
  grep -n -e "$3" "$1/data/$2/report.md" | head -1 | cut -d: -f1
}

# What `proposal` must print, derived from the fixture by the grammar's own
# shapes rather than by the parser under test.
# shellcheck disable=SC2016 # backticks here are the grammar's own, never expansions
expected_proposal() {  # <report>
  sed -n 's/^Question: //p' "$1" | sed 's/^/question: /'
  sed -n 's/^- `\([^`]*\)` - \(.*\)$/option: \1	\2/p' "$1"
  sed -n 's/^Recommendation: `\([^`]*\)`.*$/recommend: \1/p' "$1"
}

test_a_proposed_call_is_raised_exactly_as_written() {
  local home id out record expected labels
  home=$(make_home proposal-raise)
  id=qd-update-flow-1
  proposing_scout "$home" "$id"
  expected=$(expected_proposal "$home/data/$id/report.md")
  assert_equals 6 "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" "setup: the fixture's own shape was not read"
  out=$(run_captain "$home" proposal "$id") || fail "a report that follows the grammar did not parse"
  assert_equals "$expected" "$out" "the parsed call is the section exactly, the Question: lead aside"

  out=$(run_captain "$home" raise "$id") || fail "raise failed on a section that parses"
  assert_equals "raised: $id from $home/data/$id/report.md" "$out" "raise names the call and where it came from"
  record="$home/state/calls/$id.json"
  labels=$(jq -r '.options[] | "option: \(.key)\t\(.label)"' "$record")
  assert_equals "$expected" "$(printf 'question: %s\n%s\nrecommend: %s' "$(jq -r .question "$record")" "$labels" \
    "$(jq -r '.options[] | select(.recommended) | .key' "$record")")" \
    "the call carries exactly the proposal's question, options, and recommendation"
  assert_equals "$id|$id" "$(jq -r '[.origin, .task] | join("|")' "$record")" \
    "the call names the scout as its origin on the scout's own row"
  assert_contains "$(call_json "$home" "$id" | jq -r '.evidence | join(" ")')" "report:$id" \
    "the scout's report argues the raised call"
  assert_equals "captain|yes" "$(tasks_in "$home" show "$id" --full | sed -n 's/^  hold_kind: //p; s/^  held: //p' | sort | paste -sd'|' -)" \
    "the scout's row is held for the captain"

  id=qd-kirocrew-1
  proposing_scout "$home" "$id"
  (cd "$home" && tasks-axi add sample-sandbox-work "Sandbox the crew" --kind ship --repo sample >/dev/null) \
    || fail "could not file the gated work item"
  out=$(run_captain "$home" raise "$id" --onto sample-sandbox-work) || fail "raise --onto failed"
  record="$home/state/calls/sample-sandbox-work.json"
  assert_equals "$id|optin|3|release" \
    "$(jq -r '[.origin, (.options[] | select(.recommended) | .key), (.options | length), .on_answer] | join("|")' "$record")" \
    "--onto holds the work item the question gates, with the scout as origin and a release close"
  assert_contains "$(jq -r '.options[0].label' "$record")" "**Keep unrestricted workers.**" \
    "a label is copied as written, its markdown included"
  assert_absent "$home/state/calls/$id.json" "--onto also raised a call on the scout's own row"
  pass "a report's proposed call is raised exactly as written, on its own row or the work it gates"
}

tasks_in() {  # <home> <tasks-axi args...>
  local home=$1
  shift
  (cd "$home" && tasks-axi "$@")
}

# shellcheck disable=SC2016 # backticks here are the grammar's own, never expansions
test_a_proposal_that_does_not_parse_is_refused_at_its_line() {
  local home id out rc line before report bad
  home=$(make_home proposal-refused)
  id=qd-approve-flow-1
  proposing_scout "$home" "$id"
  before=$(shasum "$home/data/backlog.md")
  line=$(report_line "$home" "$id" '^- `full` - ')
  out=$(run_captain "$home" raise "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "raise of an option too long for a call"
  assert_contains "$out" "$home/data/$id/report.md:$line: option \`full\` is" "the refusal names the report line at fault"
  assert_contains "$out" "option \`full\` is $(sed -n "${line}p" "$home/data/$id/report.md" | sed 's/^- `full` - //' | jq -Rr length) characters after its key, over the 200 a call's option holds" \
    "the refusal names the option, its length, and the limit"
  assert_contains "$out" "shorten that label in the report" "the refusal says how to fix it at its source"
  assert_contains "$out" "nothing was raised" "the refusal says nothing was taken"
  assert_absent "$home/state/calls/$id.json" "a refused proposal left a record"
  assert_equals "$before" "$(shasum "$home/data/backlog.md")" "a refused proposal changed the backlog"

  id=nm-rebase-guard-1
  proposing_scout "$home" "$id"
  line=$(report_line "$home" "$id" '^  Costs:')
  out=$(run_captain "$home" proposal "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "an option continued onto a second line"
  assert_contains "$out" "report.md:$line: an option continues onto this line" "the continuation is named at its line"

  # Each break of the grammar, made to a real report that otherwise parses.
  id=sample-broken
  report="$home/data/$id/report.md"
  mkdir -p "$home/data/$id"
  for bad in 'no-recommendation' 'unknown-recommendation' 'repeated-key' 'second-section' 'two-line-question' 'one-option'; do
    case "$bad" in
      no-recommendation) sed '/^Recommendation:/d' "$PROPOSALS/qd-update-flow-1.md" > "$report" ;;
      unknown-recommendation) sed 's/^Recommendation: `both`/Recommendation: `notary`/' "$PROPOSALS/qd-update-flow-1.md" > "$report" ;;
      repeated-key) sed 's/^- `devid`/- `both`/' "$PROPOSALS/qd-update-flow-1.md" > "$report" ;;
      second-section) { cat "$PROPOSALS/qd-update-flow-1.md"; printf '\n## Proposed call\n\nAnother?\n'; } > "$report" ;;
      two-line-question) awk '{ print } /^Question: / { print "And one more line." }' "$PROPOSALS/qd-update-flow-1.md" > "$report" ;;
      one-option) sed '/^- `devid`/d; /^- `selfsign`/d; /^- `unsigned`/d' "$PROPOSALS/qd-update-flow-1.md" > "$report" ;;
    esac
    case "$bad" in
      no-recommendation) line=$(wc -l < "$report" | tr -d ' ') ;;
      unknown-recommendation) line=$(report_line "$home" "$id" '^Recommendation:') ;;
      repeated-key) line=$(grep -n '^- `both`' "$report" | sed -n '2p' | cut -d: -f1) ;;
      second-section) line=$(grep -n '^## Proposed call' "$report" | sed -n '2p' | cut -d: -f1) ;;
      two-line-question) line=$(report_line "$home" "$id" '^And one more line') ;;
      one-option) line=$(report_line "$home" "$id" '^Recommendation:') ;;
    esac
    [ -n "$line" ] || fail "setup: no line to expect for $bad"
    out=$(run_captain "$home" raise "$id" 2>&1); rc=$?
    expect_code 1 "$rc" "raise of a section with $bad"
    assert_contains "$out" "report.md:$line:" "the refusal for $bad names line $line: $out"
    assert_absent "$home/state/calls/$id.json" "a refused $bad section left a record"
  done

  # A heading inside fenced code is an example, not a proposal.
  printf '# Notes\n\n```\n## Proposed call\n\nNot a real one?\n```\n' > "$report"
  out=$(run_captain "$home" proposal "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "a report whose only heading is fenced"
  assert_contains "$out" "has no Proposed call section" "a fenced heading is not a section"
  pass "a proposal that breaks the grammar is refused at the line at fault, and nothing is guessed at"
}

# A heading that varies from `## Proposed call` is still a proposal, never none.
test_a_variant_heading_is_still_a_proposal() {
  local home id heading out expected
  home=$(make_home proposal-heading)
  id=qd-update-flow-1
  proposing_scout "$home" "$id"
  expected=$(run_captain "$home" proposal "$id") || fail "setup: the fixture did not parse"
  for heading in '### Proposed Call: signing' '## proposed calls' '#### PROPOSED CALL (for the captain)'; do
    awk -v h="$heading" '/^## Proposed call$/ { print h; next } { print }' "$PROPOSALS/$id.md" > "$home/data/$id/report.md"
    out=$(run_captain "$home" proposal "$id") || fail "the heading '$heading' was not read as a proposal"
    assert_equals "$expected" "$out" "the heading '$heading' reads the same call"
    out=$(run_captain "$home" gate "$id" 2>&1) && fail "the gate passed beside '$heading'"
    assert_contains "$out" "unraised proposal: $id's report" "the gate names the proposal under '$heading'"
  done
  printf '# Notes\n\n## Proposed callback design\n\nNot a call.\n' > "$home/data/$id/report.md"
  out=$(run_captain "$home" proposal "$id" 2>&1) && fail "a heading about something else read as a proposal"
  assert_contains "$out" "has no Proposed call section" "a heading about something else is not a proposal"
  pass "a variant Proposed call heading is read as a proposal, and the gate refuses it until handled"
}

# A call that only names the scout as its origin may be about anything, so it
# handles no proposal; only a call that records this proposal does, and a
# revised proposal is a new one.
# shellcheck disable=SC2016 # backticks here are the grammar's own, never expansions
test_only_a_call_that_records_this_proposal_handles_it() {
  local home id out rc
  home=$(make_home proposal-identity)
  id=qd-update-flow-1
  mkdir -p "$home/data/$id"
  printf 'kind=scout\n' > "$home/state/$id.meta"
  printf 'done: report written\n' > "$home/state/$id.status"
  tasks_in "$home" add "$id" "Scout $id" --kind scout --repo sample --start >/dev/null || fail "could not file the scout row"
  present "$home" "$id" sample-interim >/dev/null || fail "presenting the interim page failed"
  run_captain "$home" hold "$id" --reason 'which page layout' --question 'Which layout for the interim page?' \
    --option table=Table --option cards=Cards >/dev/null || fail "holding the scout's row failed"
  assert_equals "$id" "$(jq -r .origin "$home/state/calls/$id.json")" "setup: the call about the page names the scout as origin"
  cp "$PROPOSALS/$id.md" "$home/data/$id/report.md"

  out=$(run_captain "$home" gate "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "the gate beside a proposal only an unrelated call names"
  assert_contains "$out" "unraised proposal: $id's report proposes a call" "the gate names the unraised proposal"
  printf 'decisions_reviewed=1\ndecision_keys=%s\n' "$id" >> "$home/state/$id.meta"
  out=$(run_captain "$home" verify "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "verify beside a proposal only an unrelated call names"
  assert_contains "$out" "unraised proposal" "verify names the unraised proposal"
  assert_contains "$(run_captain "$home" proposals)" "$id	parses	" "PROPOSED CALLS still lists it"

  tasks_in "$home" add sample-signing "Sign the app" --kind ship --repo sample >/dev/null || fail "could not file the gated row"
  run_captain "$home" raise "$id" --onto sample-signing >/dev/null || fail "raise failed"
  assert_equals "$id" "$(jq -r .proposal.task "$home/state/calls/sample-signing.json")" "the raised call records the proposal"
  run_captain "$home" gate "$id" >/dev/null || fail "the gate refused a raised proposal"
  assert_equals "" "$(run_captain "$home" proposals)" "a raised proposal left PROPOSED CALLS"

  sed 's/^- `devid` - /- `devid` - Revised: /' "$PROPOSALS/$id.md" > "$home/data/$id/report.md"
  assert_contains "$(run_captain "$home" proposals)" "$id	parses	" "a revised proposal surfaces again"
  out=$(run_captain "$home" gate "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "the gate beside a revised proposal"
  assert_contains "$out" "a revised proposal is a new one" "the refusal says a revision is a new proposal"
  run_captain "$home" raise "$id" --onto sample-signing >/dev/null || fail "raising the revision failed"
  run_captain "$home" gate "$id" >/dev/null || fail "the gate refused the raised revision"
  printf '\nA closing note after the call.\n' >> "$home/data/$id/report.md"
  run_captain "$home" gate "$id" >/dev/null || fail "prose outside the proposal read as a revision"

  out=$(run_captain "$home" hold sample-other --title 'Other' --reason 'other' --proposal-of sample-none 2>&1); rc=$?
  expect_code 1 "$rc" "hold --proposal-of a task with no proposal"
  assert_contains "$out" "has no Proposed call section" "the refusal names the missing section"
  pass "only a call that records this proposal handles it, and a revised proposal surfaces again"
}

test_completion_refuses_an_unraised_proposal_until_it_is_raised() {
  local home id out rc
  home=$(make_home proposal-complete)
  id=qd-update-flow-1
  proposing_scout "$home" "$id"
  out=$(run_captain "$home" complete "$id" --none 2>&1); rc=$?
  expect_code 1 "$rc" "complete --none beside an unraised proposal"
  assert_contains "$out" "unraised proposal: $id's report proposes a call at $home/data/$id/report.md:$(report_line "$home" "$id" '^## Proposed call')" \
    "the refusal says what is missing and where"
  assert_contains "$out" "fm-captain-hold.sh raise $id" "the refusal names raising it"
  assert_contains "$out" "fm-captain-hold.sh decline $id" "the refusal names declining it"
  assert_no_grep "decisions_reviewed" "$home/state/$id.meta" "a refused completion attested the inventory"

  printf 'decisions_reviewed=1\ndecision_keys=\n' >> "$home/state/$id.meta"
  out=$(run_captain "$home" verify "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "verify beside an unraised proposal, even with an attestation"
  assert_contains "$out" "unraised proposal" "verify names the unraised proposal"

  run_captain "$home" raise "$id" >/dev/null || fail "raise failed"
  run_captain "$home" complete "$id" "$id" >/dev/null || fail "complete refused once the proposal was raised"
  run_captain "$home" verify "$id" >/dev/null || fail "verify refused once the proposal was raised"
  out=$(run_captain "$home" gate "$id") || fail "gate refused once the proposal was raised"
  assert_equals "gate: $id clear" "$out" "the gate reads clear"
  pass "complete and verify refuse an unraised proposal, naming how to proceed, and pass once it is raised"
}

test_a_declined_proposal_passes_and_leaves_a_decision() {
  local home id out rc call
  home=$(make_home proposal-decline)
  id=qd-kirocrew-1
  proposing_scout "$home" "$id"
  out=$(run_captain "$home" decline "$id" --what 'Kept unrestricted workers' 2>&1); rc=$?
  expect_code 1 "$rc" "a decline without why"
  assert_absent "$home/state/calls" "a refused decline recorded something"
  out=$(run_captain "$home" decline "$id" --what 'Kept unrestricted workers for now' \
    --why 'The captain already ruled sandboxing out until a second user exists') || fail "decline failed"
  case "$out" in "declined: $id (decided-"*")") ;; *) fail "decline printed '$out'" ;; esac
  call=${out#*(}; call=${call%)}
  assert_equals "closed|firstmate|decide|$id|$id|scope|Kept unrestricted workers for now|3|$(run_captain "$home" proposal "$id" | sed -n 's/^question: //p')" \
    "$(call_json "$home" "$call" | jq -r '[.state, .answer.by, .answer.via, .origin, .about, .decided.kind, .decided.what,
      (.options | length), .question] | join("|")')" \
    "the decline is a decided call about the scout, carrying the proposal it settled"
  assert_contains "$(call_json "$home" "$call" | jq -r '.evidence | join(" ")')" "report:$id" \
    "the report that proposed it argues the decision"
  run_captain "$home" complete "$id" --none >/dev/null || fail "complete --none refused a declined proposal"
  run_captain "$home" verify "$id" >/dev/null || fail "verify refused a declined proposal"

  id=qd-approve-flow-1
  proposing_scout "$home" "$id"
  out=$(run_captain "$home" decline "$id" --what 'Built the full loop' --why 'Full was already the brief'"'"'s scope') \
    || fail "a malformed proposal could not be declined"
  call=${out#*(}; call=${call%)}
  assert_equals "$id's proposed call|0" "$(call_json "$home" "$call" | jq -r '[.question, (.options | length)] | join("|")')" \
    "a section that does not parse is declined by name, with nothing guessed from it"
  run_captain "$home" gate "$id" >/dev/null || fail "the gate refused a declined malformed proposal"
  out=$(run_captain "$home" decline sample-nothing --what w --why y 2>&1); rc=$?
  expect_code 1 "$rc" "a decline with no proposal to decline"
  pass "a declined proposal passes the gate and leaves a decided call the captain can see"
}

test_an_answer_the_first_mate_gave_needs_its_record() {
  local home id out rc
  home=$(make_home unrecorded)
  id=sample-ship
  printf 'kind=ship\n' > "$home/state/$id.meta"
  cat > "$home/state/$id.status" <<'EOF'
working: building
needs-decision [key=port]: which port should the sample serve on?
resolved [key=port]: answered: use 9090, the default is taken
needs-decision [key=retry]: retry the flaky step?
resolved [key=retry]: retried it myself, it passed
blocked [key=creds]: need the sample token
resolved [key=creds]: answered: it is in the vault
needs-decision [key=sample-call]: which export format?
captain-held [key=sample-call]: tracked by sample-call
needs-decision [key=again]: first ask
resolved [key=again]: answered: yes
needs-decision [key=again]: asked again after the answer
done: built
EOF
  out=$(run_captain "$home" unrecorded) || fail "unrecorded failed"
  assert_equals "$id	port	use 9090, the default is taken" "$out" \
    "only a question the first mate answered itself is listed, not a worker's own close, a blocker, a transfer, or a re-opened question"
  out=$(run_captain "$home" gate "$id" 2>&1); rc=$?
  expect_code 1 "$rc" "the gate beside an unrecorded answer and an open question"
  assert_contains "$out" "unrecorded decision: you answered $id [key=port] yourself (use 9090, the default is taken)" \
    "the gate names the answer nothing records"
  assert_contains "$out" "fm-captain-hold.sh decide --about $id --key port" "the gate names how to record it"
  assert_contains "$out" "open needs-decision [key=again] on $id" "the gate names the open question"

  run_captain "$home" decide --about "$id" --key port --title 'Which port should the sample serve on?' \
    --what 'Serve on 9090' --why 'The default port is taken on every fleet host' >/dev/null || fail "decide --key failed"
  assert_equals "" "$(run_captain "$home" unrecorded)" "a decided call naming the key records it"
  assert_equals port "$(jq -r 'select(.about == "sample-ship") | .decided.key' "$home"/state/calls/decided-*.json)" \
    "the decided call carries the key it settles"
  printf 'resolved [key=again]: answered: no\n' >> "$home/state/$id.status"
  out=$(run_captain "$home" unrecorded)
  assert_equals "$id	again	no" "$out" "a second answer needs its own record"
  run_captain "$home" hold again --title 'Ask again?' --reason 'held as a call' >/dev/null || fail "hold failed"
  run_captain "$home" gate "$id" >/dev/null || fail "an answer whose key is itself a call still read as unrecorded"
  pass "a question the first mate answered itself is a decision it must record, and the gate holds until it does"
}

test_the_wake_drain_lists_proposals_and_unrecorded_answers_until_handled() {
  local home out
  home=$(make_home gate-drain)
  proposing_scout "$home" qd-update-flow-1
  proposing_scout "$home" qd-approve-flow-1
  proposing_scout "$home" qd-deterministic-1
  mkdir -p "$home/data/sample-done"
  cp "$PROPOSALS/qd-kirocrew-1.md" "$home/data/sample-done/report.md"
  printf 'kind=ship\n' > "$home/state/sample-ship.meta"
  printf 'needs-decision [key=port]: which port?\nresolved [key=port]: answered: 9090\n' > "$home/state/sample-ship.status"
  drain() {
    PATH="$home/fakebin:$PATH" FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
      FM_CONFIG_OVERRIDE="$home/config" FM_CAPTAIN_HOLD_NOW="$NOW" "$ROOT/bin/fm-wake-drain.sh" 2>/dev/null
  }
  out=$(drain)
  assert_contains "$out" "PROPOSED CALLS (a report proposes a call that nobody has raised or declined" "the proposals heading"
  assert_contains "$out" "qd-update-flow-1 [parses]: How should Quarterdeck get a stable signing identity" "a proposal that parses is named by its question"
  assert_contains "$out" "qd-approve-flow-1 [malformed]: $home/data/qd-approve-flow-1/report.md:" "a malformed proposal is named with its line"
  assert_contains "$out" "PROPOSED CALLS: read the report, then raise the call" "the hint names both ways to act"
  assert_not_contains "$out" "sample-done" "a report whose task left this home is not listed"
  assert_contains "$out" "UNRECORDED DECISIONS (you answered these worker questions yourself" "the unrecorded heading"
  assert_contains "$out" "sample-ship [key=port]: you answered: 9090" "the answer nothing records is named"
  assert_contains "$out" "UNRECORDED DECISIONS: record each with bin/fm-captain-hold.sh decide --about <task> --key <key>" \
    "the hint names how to record it"
  out=$(drain)
  assert_contains "$out" "qd-update-flow-1 [parses]" "the section prints again on the next drain"
  assert_contains "$out" "sample-ship [key=port]" "so does the unrecorded answer"

  run_captain "$home" raise qd-update-flow-1 >/dev/null || fail "raise failed"
  run_captain "$home" decline qd-approve-flow-1 --what 'Built the full loop' --why 'Already decided' >/dev/null || fail "decline failed"
  run_captain "$home" hold qd-deterministic-1 --proposal-of qd-deterministic-1 --reason 'raised by hand' \
    --question 'How far?' --option gate=Gate --option mechanical=Mechanical --recommend mechanical >/dev/null \
    || fail "a hand-raised call failed"
  out=$(drain)
  assert_not_contains "$out" "PROPOSED CALLS" "raised, declined, and hand-raised proposals all leave the section"
  assert_contains "$out" "UNRECORDED DECISIONS" "recording a proposal does not record an unrelated answer"
  run_captain "$home" decide --about sample-ship --key port --title 'Which port?' --what 'Serve on 9090' --why 'Free port' \
    >/dev/null || fail "decide failed"
  out=$(drain)
  assert_not_contains "$out" "UNRECORDED DECISIONS" "a recorded answer leaves the section"
  pass "the wake drain lists unhandled proposals and unrecorded answers on every drain until each is handled"
}

test_hold_records_the_call_and_refuses_what_nobody_could_answer
test_a_hold_without_content_is_still_a_call
test_origin_evidence_is_derived_whatever_the_presentation_order
test_held_work_that_produced_something_is_its_own_origin
test_a_defaulted_origin_links_without_changing_the_close
test_a_held_task_is_not_its_own_origin_when_it_should_not_be
test_offer_and_evidence_change_a_call
test_answers_write_machine_lines_and_honor_on_answer
test_answered_via_is_a_closed_channel_vocabulary
test_an_interrupted_close_reads_as_answered
test_decide_records_a_call_settled_for_the_captain
test_list_window_damage_and_the_snapshot
test_migrate_imports_the_old_stores_idempotently
test_migrate_gives_older_answers_their_machine_lines
test_the_retired_surfaces_are_shims
test_reply_keeps_the_captains_words_beside_an_open_call
test_reply_refuses_what_it_cannot_keep
test_reply_takes_the_calls_control_lock
test_only_the_first_mate_acting_clears_a_reply
test_replies_lists_what_waits_on_the_first_mate
test_the_wake_drain_prints_unhandled_replies
test_a_refused_deferral_keeps_the_reply_and_a_valid_one_clears_it
test_a_proposed_call_is_raised_exactly_as_written
test_a_proposal_that_does_not_parse_is_refused_at_its_line
test_a_variant_heading_is_still_a_proposal
test_only_a_call_that_records_this_proposal_handles_it
test_completion_refuses_an_unraised_proposal_until_it_is_raised
test_a_declined_proposal_passes_and_leaves_a_decision
test_an_answer_the_first_mate_gave_needs_its_record
test_the_wake_drain_lists_proposals_and_unrecorded_answers_until_handled
