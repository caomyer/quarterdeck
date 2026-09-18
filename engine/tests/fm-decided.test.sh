#!/usr/bin/env bash
# Behavior tests for bin/fm-decided.sh.
# Covers recording a call firstmate made on the captain's behalf, the refusals
# that keep an unreadable or unattributable record out, the list window and
# order, skipping a damaged record, concurrent writers, and the fleet snapshot
# carrying the listing as decided[].
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }

DECIDED="$ROOT/bin/fm-decided.sh"
TMP_ROOT=$(fm_test_tmproot fm-decided)

new_home() {  # <label>
  local home="$TMP_ROOT/$1/home"
  mkdir -p "$home/data/res-audit" "$home/state" "$home/config" "$home/projects"
  printf '%s\n' "$home"
}

# Write a record by hand, as an earlier session would have left it.
write_record() {  # <home> <id> <at> <what>
  local home=$1 id=$2 at=$3 what=$4
  mkdir -p "$home/state/decided"
  jq -n --arg id "$id" --arg at "$at" --arg what "$what" \
    '{schema:"fm-decided.v1", id:$id, at:$at, kind:"other", task:null, what:$what, why:"because", link:null}' \
    > "$home/state/decided/$id.json"
}

test_a_call_is_recorded_with_its_why() {
  local home out id record
  home=$(new_home record)
  out=$(FM_HOME="$home" "$DECIDED" record \
    --what 'Shipped U1 without fixing the interrupted-snip spinner (review finding F1)' \
    --why 'Fixing it needs the snip lifecycle work, so it is filed as res-snip-lifecycle instead.' \
    --task res-audit --kind review-finding \
    --link https://github.com/caomyer/Resonance/pull/5) || fail "record failed: $out"
  id=${out#recorded: }
  printf '%s' "$id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{6}$' || fail "record printed an id of the wrong shape: $out"
  record="$home/state/decided/$id.json"
  assert_present "$record" "the record is stored under its id"
  assert_equals "fm-decided.v1|$id|review-finding|res-audit|https://github.com/caomyer/Resonance/pull/5" \
    "$(jq -r '[.schema, .id, .kind, .task, .link] | join("|")' "$record")" \
    "the record carries its schema, id, kind, task, and link"
  [ "$(jq -r '.at' "$record" | tr -d ':-')" = "${id%%-*}" ] || fail "the record's time and id disagree: $(cat "$record")"

  out=$(FM_HOME="$home" "$DECIDED" record --what 'Filed a follow-up' --why 'Out of scope for this fix') \
    || fail "a record without task or link failed"
  record="$home/state/decided/${out#recorded: }.json"
  assert_equals "other|null|null" "$(jq -r '[.kind, (.task|tostring), (.link|tostring)] | join("|")' "$record")" \
    "kind defaults to other, and an absent task or link is null"
  [ -z "$(find "$home/state/decided" -name '.*' -type f)" ] || fail "a writer left its temporary file behind"

  out=$(FM_HOME="$home" "$DECIDED" list)
  assert_contains "$out" "review-finding  res-audit  Shipped U1 without fixing" "list prints what was decided for a human"
  assert_contains "$out" "why: Fixing it needs the snip lifecycle work" "list prints why"
  pass "fm-decided.sh: a call is recorded with its why"
}

test_refusals_keep_an_unattributable_record_out() {
  local home out rc long
  home=$(new_home refuse)
  long=$(printf 'x%.0s' $(seq 1 201))
  for args in \
    "--why reason" \
    "--what decided" \
    "--what decided --why reason --kind approve" \
    "--what decided --why reason --task nope" \
    "--what decided --why reason --task ../escape" \
    "--what decided --why reason --link ftp://example.com/x" \
    "--what $long --why reason"; do
    # shellcheck disable=SC2086 # each case is a flag list
    out=$(FM_HOME="$home" "$DECIDED" record $args 2>&1); rc=$?
    expect_code 1 "$rc" "refused: ${args:0:60}"
  done
  out=$(FM_HOME="$home" "$DECIDED" record --what 'two
lines' --why reason 2>&1); rc=$?
  expect_code 1 "$rc" "a what across two lines"
  out=$(FM_HOME="$home" "$DECIDED" record --what '   ' --why reason 2>&1); rc=$?
  expect_code 1 "$rc" "a blank what"
  out=$(FM_HOME="$home" "$DECIDED" record --what decided --why "$long$long" 2>&1); rc=$?
  expect_code 1 "$rc" "a why over 300 characters"
  assert_contains "$out" "longer than 300 characters" "the limit is named"
  assert_equals "0" "$(find "$home/state/decided" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')" "no refused call left a record"
  assert_equals "decided: none" "$(FM_HOME="$home" "$DECIDED" list)" "an empty store says so"
  out=$(FM_HOME="$home" "$DECIDED" list --since soon 2>&1); rc=$?
  expect_code 1 "$rc" "a non-numeric --since"
  pass "fm-decided.sh: an unreadable or unattributable record is refused"
}

test_the_list_window_order_and_damage() {
  local home out
  home=$(new_home window)
  write_record "$home" 20260910T000000Z-old000 2026-09-10T00:00:00Z 'Too old'
  write_record "$home" 20260912T080000Z-aaaaaa 2026-09-12T08:00:00Z 'Inside the window'
  write_record "$home" 20260917T090000Z-bbbbbb 2026-09-17T09:00:00Z 'Newest'
  printf '{not json\n' > "$home/state/decided/20260917T100000Z-broken.json"
  write_record "$home" 20260916T000000Z-cccccc 2026-09-16T00:00:00Z 'Wrong id inside'
  jq '.id = "20260101T000000Z-zzzzzz"' "$home/state/decided/20260916T000000Z-cccccc.json" > "$TMP_ROOT/moved.json"
  mv "$TMP_ROOT/moved.json" "$home/state/decided/20260916T000000Z-cccccc.json"

  out=$(FM_HOME="$home" FM_DECIDED_NOW=2026-09-18T07:00:00Z "$DECIDED" list --json) || fail "list failed past a damaged record"
  assert_equals "fm-decided-list.v1|Newest,Inside the window" \
    "$(printf '%s' "$out" | jq -r '.schema + "|" + ([.decided[].what] | join(","))')" \
    "list keeps the last 7 days, newest first, and skips damaged records"
  out=$(FM_HOME="$home" FM_DECIDED_NOW=2026-09-18T07:00:00Z "$DECIDED" list --json --since 30)
  assert_equals "3" "$(printf '%s' "$out" | jq '.decided | length')" "--since widens the window"
  pass "fm-decided.sh: the list window, order, and damaged records"
}

# Two writers at once each publish their own whole record and never replace
# the other's, even when both draw a record in the same second.
test_concurrent_records_never_overwrite() {
  local home round
  home=$(new_home concurrent)
  for round in 1 2 3 4 5 6 7 8; do
    FM_HOME="$home" "$DECIDED" record --what "A $round" --why a >/dev/null 2>&1 &
    FM_HOME="$home" "$DECIDED" record --what "B $round" --why b >/dev/null 2>&1 &
  done
  wait
  assert_equals "16" "$(FM_HOME="$home" "$DECIDED" list --json | jq '.decided | length')" "every concurrent record survived"
  [ -z "$(find "$home/state/decided" -name '.*' -type f)" ] || fail "a writer left its temporary file behind"
  pass "fm-decided.sh: concurrent records never overwrite each other"
}

test_the_fleet_snapshot_carries_decided() {
  local home out
  home=$(new_home snapshot)
  write_record "$home" 20260917T090000Z-bbbbbb 2026-09-17T09:00:00Z 'Merged PR #5'
  write_record "$home" 20260901T090000Z-old000 2026-09-01T09:00:00Z 'Too old'
  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE='' FM_SNAPSHOT_NOW=2026-09-18T07:00:00Z \
    "$ROOT/bin/fm-fleet-snapshot.sh" --json 2>/dev/null) || fail "fleet snapshot failed"
  assert_equals "Merged PR #5" "$(printf '%s' "$out" | jq -r '[.decided[].what] | join(",")')" \
    "the fleet snapshot carries the last 7 days of decided[], ending at its own time"
  rm -rf "$home/state/decided"
  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE='' "$ROOT/bin/fm-fleet-snapshot.sh" --json 2>/dev/null) || fail "fleet snapshot failed"
  assert_equals "[]" "$(printf '%s' "$out" | jq -c '.decided')" "a home with no decisions carries an empty decided[]"
  pass "fm-decided.sh: the fleet snapshot carries decided[]"
}

test_a_call_is_recorded_with_its_why
test_refusals_keep_an_unattributable_record_out
test_the_list_window_order_and_damage
test_concurrent_records_never_overwrite
test_the_fleet_snapshot_carries_decided
