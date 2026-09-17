#!/usr/bin/env bash
# Behavior tests for bin/fm-decision-options.sh.
# Covers recording what a captain-held task offers, replacing it, the refusals
# that keep a renderer from offering a choice nobody can answer, clearing, and
# the fleet snapshot carrying the listing.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }

OPTIONS="$ROOT/bin/fm-decision-options.sh"
TMP_ROOT=$(fm_test_tmproot fm-decision-options)

new_home() {  # <label>
  local home="$TMP_ROOT/$1/home"
  mkdir -p "$home/data/res-model" "$home/state"
  printf '%s\n' "$home"
}

test_a_decision_records_what_it_offers() {
  local home out
  home=$(new_home record)
  out=$(FM_HOME="$home" "$OPTIONS" set res-model \
    --option wifi-only='Wi-Fi only, with visible progress' \
    --option prompt='Ask on the first snip that needs it' \
    --recommend wifi-only \
    --question 'When may the app download the 150 MB speech model?') || fail "set failed"
  assert_contains "$out" "set: res-model (2 options)" "set reports what it recorded"
  local record="$home/state/decision-options/res-model.json"
  assert_equals "fm-decision-options.v1|res-model|wifi-only|Wi-Fi only, with visible progress|true|false" \
    "$(jq -r '[.schema, .task, .options[0].key, .options[0].label, (.options[0].recommended|tostring), (.options[1].recommended|tostring)] | join("|")' "$record")" \
    "the record carries the options in order, with the recommendation marked"
  assert_contains "$(FM_HOME="$home" "$OPTIONS" show res-model)" "wifi-only  Wi-Fi only, with visible progress  (recommended)" "show prints them for a human"
  assert_equals "1" "$(FM_HOME="$home" "$OPTIONS" list --json | jq '.decisions | length')" "list carries the record"

  # Setting again replaces the whole offer rather than adding to it.
  FM_HOME="$home" "$OPTIONS" set res-model --option now='Do it now' --option later='Wait a week' >/dev/null || fail "second set failed"
  assert_equals "now,later" "$(jq -r '[.options[].key] | join(",")' "$record")" "setting again replaces what was offered"
  assert_equals "false" "$(jq -r 'any(.options[]; .recommended) | tostring' "$record")" "a replacement with no recommendation marks none"
  assert_absent "$home/state/decision-options/.res-model.json.tmp" "the temporary record is not left behind"
  pass "fm-decision-options.sh: a decision records the options it offers"
}

test_refusals_keep_an_unanswerable_offer_out() {
  local home out rc
  home=$(new_home refuse)
  for bad in "--option only=one" "--option a=1 --option a=2" "--option a=1 --option b=2 --recommend c" "--option noequals"; do
    # shellcheck disable=SC2086 # each case is a flag list
    out=$(FM_HOME="$home" "$OPTIONS" set res-model $bad 2>&1); rc=$?
    expect_code 1 "$rc" "refused: $bad"
    assert_absent "$home/state/decision-options/res-model.json" "a refused set left a record ($bad)"
  done
  out=$(FM_HOME="$home" "$OPTIONS" set nope --option a=1 --option b=2 2>&1); rc=$?
  expect_code 1 "$rc" "unknown task"
  assert_contains "$out" "unknown task 'nope'" "an unknown task is named"
  out=$(FM_HOME="$home" "$OPTIONS" set ../escape --option a=1 --option b=2 2>&1); rc=$?
  expect_code 1 "$rc" "path-unsafe task id"
  out=$(FM_HOME="$home" "$OPTIONS" set res-model --option 'a=first
second' --option b=2 2>&1); rc=$?
  expect_code 1 "$rc" "a label across two lines"
  out=$(FM_HOME="$home" "$OPTIONS" show res-model 2>&1); rc=$?
  expect_code 1 "$rc" "show without a record"
  assert_contains "$out" "offers no recorded options" "show says there is nothing"
  assert_equals "decision options: none" "$(FM_HOME="$home" "$OPTIONS" list)" "an empty store says so"
  pass "fm-decision-options.sh: an offer nobody could answer is refused"
}

test_clearing_and_the_fleet_snapshot() {
  local home out
  home=$(new_home snapshot)
  FM_HOME="$home" "$OPTIONS" set res-model --option a='Do it' --option b='Do not' --recommend a >/dev/null || fail "set failed"
  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE='' "$ROOT/bin/fm-fleet-snapshot.sh" --json 2>/dev/null) || fail "fleet snapshot failed"
  assert_equals "res-model|a|true" \
    "$(printf '%s' "$out" | jq -r '.decision_options[0] | [.task, .options[0].key, (.options[0].recommended|tostring)] | join("|")')" \
    "the fleet snapshot carries what each decision offers"
  assert_contains "$(FM_HOME="$home" "$OPTIONS" clear res-model)" "cleared: res-model" "clear says what it removed"
  assert_absent "$home/state/decision-options/res-model.json" "clear removes the record"
  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE='' "$ROOT/bin/fm-fleet-snapshot.sh" --json 2>/dev/null) || fail "fleet snapshot failed"
  assert_equals "0" "$(printf '%s' "$out" | jq '.decision_options | length')" "a cleared decision offers nothing"
  pass "fm-decision-options.sh: clearing, and the fleet snapshot listing"
}

test_a_decision_records_what_it_offers
test_refusals_keep_an_unanswerable_offer_out
test_clearing_and_the_fleet_snapshot
