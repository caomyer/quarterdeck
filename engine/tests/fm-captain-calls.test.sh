#!/usr/bin/env bash
# Behavior tests for a captain call's single source of truth in
# bin/fm-captain-hold.sh: the sidecar record `hold` and `offer` write, evidence
# attached explicitly and derived from --origin whatever the presentation
# order, `decide` for calls settled on the captain's behalf, `list` and the
# fleet snapshot's calls[], the answer's machine lines written by `answers` and
# `answer` with their closed channel vocabulary, the declared on_answer, the
# one-time `migrate`, and the shims that
# replaced fm-decision-options.sh and `fm-artifact.sh present --covers`.
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
  assert_equals 'fast|fast = go now' "$(call_json "$home" sample-bf-spaced | jq -r '[.answer.key, .answer.label] | join("|")')" \
    "the label is trimmed"
  assert_contains "$(cd "$home" && tasks-axi show sample-bf-prefix --full)" \
    "Resolution mode: answered\\nAnswer key: safe\\nAnswer label: safe: because it is safer\\nAnswered by: captain\\nAnswered via: other\\nAnswered at: $closed\\n\\nCaptain decision:\\nsafe: because it is safer" \
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

test_hold_records_the_call_and_refuses_what_nobody_could_answer
test_a_hold_without_content_is_still_a_call
test_origin_evidence_is_derived_whatever_the_presentation_order
test_offer_and_evidence_change_a_call
test_answers_write_machine_lines_and_honor_on_answer
test_answered_via_is_a_closed_channel_vocabulary
test_an_interrupted_close_reads_as_answered
test_decide_records_a_call_settled_for_the_captain
test_list_window_damage_and_the_snapshot
test_migrate_imports_the_old_stores_idempotently
test_migrate_gives_older_answers_their_machine_lines
test_the_retired_surfaces_are_shims
