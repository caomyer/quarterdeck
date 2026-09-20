#!/usr/bin/env bash
# Behavior tests for bin/fm-history.sh: every closed row of a home, from the
# backlog's Done section and the done archive tasks-axi prunes into, newest
# first and paged by an id cursor, each row in the fleet snapshot's own record
# shape and each captain call joined with its answer by fm-captain-hold.sh list.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }
command -v tasks-axi >/dev/null 2>&1 || { echo "skip: tasks-axi not found"; exit 0; }

HISTORY="$ROOT/bin/fm-history.sh"
TMP_ROOT=$(fm_test_tmproot fm-history)
TASKS_AXI_BIN=$(command -v tasks-axi)
NOW=2026-09-18T12:00:00Z

make_home() {  # <name> [--stateless]
  local home="$TMP_ROOT/$1"
  mkdir -p "$home/data" "$home/config"
  [ "${2:-}" = --stateless ] || mkdir -p "$home/state"
  cp "$ROOT/.tasks.toml" "$home/.tasks.toml"
  printf '# Backlog\n\n## In flight\n## Queued\n## Done\n' > "$home/data/backlog.md"
  printf '%s\n' "$home"
}

history() {  # <home> [args...]
  local home=$1
  shift
  FM_HOME="$home" FM_HISTORY_NOW="$NOW" "$HISTORY" "$@"
}

axi() {  # <home> <tasks-axi args...>
  local home=$1
  shift
  FM_HOME="$home" "$ROOT/bin/fm-tasks-axi.sh" "$@" >/dev/null
}

close_task() {  # <home> <id> <title> <repo> [done flags...]
  local home=$1 id=$2 title=$3 repo=$4
  shift 4
  axi "$home" add "$id" "$title" --repo "$repo" || fail "add $id failed"
  axi "$home" 'done' "$id" "$@" || fail "done $id failed"
}

ids() {  # jq over history JSON on stdin
  jq -r '[.records[].id] | join(",")'
}

test_order_runs_through_done_and_the_archive() {
  local home out i
  home=$(make_home order)
  for i in 01 02 03 04 05 06 07 08 09 10 11 12 13; do
    close_task "$home" "sample-$i" "Sample task $i" "sample-$(( 10#$i % 2 ))"
  done
  assert_present "$home/data/done-archive.md" "done_keep = 10 pruned the oldest rows into the archive"
  assert_equals 3 "$(grep -c '^## Archived ' "$home/data/done-archive.md")" "each prune appended its own block"
  out=$(history "$home" --json) || fail "history failed"
  assert_equals 'sample-13,sample-12,sample-11,sample-10,sample-09,sample-08,sample-07,sample-06,sample-05,sample-04,sample-03,sample-02,sample-01' \
    "$(printf '%s' "$out" | ids)" "the Done section top down, then the archive's newest block first"
  assert_equals 'fm-history.v1|null|null|true|true|0' \
    "$(printf '%s' "$out" | jq -r '[.schema, (.repo|tostring), (.next|tostring), .archive.present, .archive.readable, (.calls|length)] | join("|")')" \
    "the envelope"
  assert_equals 'done|done' "$(printf '%s' "$out" | jq -r '[.records[-1].state, .records[-1].current_role] | join("|")')" \
    "an archived row reads as a closed row"

  # A date decides before position; a row with no completion date sorts last.
  cat > "$home/data/backlog.md" <<'EOF'
# Backlog

## In flight
- [ ] sample-open - Still open (repo: sample-0) (since 2026-09-01)
## Queued
## Done
- [x] sample-late - Closed late but listed low (repo: sample-0) (done 2026-09-12)
- [x] sample-undated - A hand-written row with no date (repo: sample-0)
- [x] sample-mid - Closed mid (repo: sample-0) (done 2026-09-10)
EOF
  cat > "$home/data/done-archive.md" <<'EOF'
# Done archive

- [x] sample-preamble - Not under any block (done 2026-09-30)

## Archived 2026-09-11
- [x] sample-arch-b - Older block, top (repo: sample-0) (done 2026-09-10)
- [x] sample-arch-a - Older block, bottom (repo: sample-0) (done 2026-09-09)
- [x] sample-mid - An earlier close of a task reopened since (repo: sample-0) (done 2026-09-08)

## Archived 2026-09-14
- [x] sample-arch-c - Newer block but an earlier date (repo: sample-0) (done 2026-09-10)
- [x] sample-arch-d - Newer block, newest date (repo: sample-0) (done 2026-09-13)
EOF
  out=$(history "$home" --json) || fail "history over hand-written files failed"
  assert_equals 'sample-arch-d,sample-late,sample-mid,sample-arch-c,sample-arch-b,sample-arch-a,sample-undated' \
    "$(printf '%s' "$out" | ids)" \
    "completion date descending, position breaking ties, undated last, open rows and stray lines left out"
  assert_equals 'Closed mid|4' \
    "$(printf '%s' "$out" | jq -r '.records[] | select(.id == "sample-mid") | [.title, (.order|tostring)] | join("|")')" \
    "a task id appears once, as its newest close"
  assert_equals 4 "$(printf '%s' "$out" | jq -r '.records[] | select(.id == "sample-arch-c") | .order')" \
    "an archived row's order is its position in the archive as written"
  pass "closed rows run newest first through the Done section and the archive's blocks"
}

test_repo_filter_is_exact() {
  local home out
  home=$(make_home repo)
  close_task "$home" sample-a 'Sample A' sample
  close_task "$home" sample-b 'Sample B' sample-extra
  close_task "$home" sample-c 'Sample C' sample
  out=$(history "$home" --json --repo sample) || fail "history --repo failed"
  assert_equals 'sample-c,sample-a|sample' "$(printf '%s' "$out" | jq -r '([.records[].id] | join(",")) + "|" + .repo')" \
    "only rows whose repo equals the name, and the name echoed"
  assert_equals '' "$(history "$home" --json --repo sampl | ids)" "a prefix is not a match"
  assert_equals 3 "$(history "$home" --json | jq '.records | length')" "without --repo, every closed row"
  pass "--repo keeps rows whose repo equals the name exactly"
}

test_paging_follows_the_id_cursor_across_a_close() {
  local home out page1 page2 page3 all i
  home=$(make_home paging)
  for i in 01 02 03 04 05 06 07 08 09 10 11 12; do
    close_task "$home" "sample-$i" "Sample task $i" sample
  done
  page1=$(history "$home" --json --limit 5) || fail "page 1 failed"
  assert_equals 'sample-12,sample-11,sample-10,sample-09,sample-08|sample-08' \
    "$(printf '%s' "$page1" | jq -r '([.records[].id] | join(",")) + "|" + .next')" "page 1 and its cursor"

  # A task closes between pages: it lands ahead of the cursor and its prune
  # moves another row into the archive, and neither shifts the next page.
  close_task "$home" sample-13 'Sample task 13' sample
  assert_equals 3 "$(grep -c '^## Archived ' "$home/data/done-archive.md")" "the close pruned one more row"
  page2=$(history "$home" --json --limit 5 --after sample-08) || fail "page 2 failed"
  assert_equals 'sample-07,sample-06,sample-05,sample-04,sample-03|sample-03' \
    "$(printf '%s' "$page2" | jq -r '([.records[].id] | join(",")) + "|" + .next')" "page 2 continues after the cursor"
  page3=$(history "$home" --json --limit 5 --after sample-03) || fail "page 3 failed"
  assert_equals 'sample-02,sample-01|null' \
    "$(printf '%s' "$page3" | jq -r '([.records[].id] | join(",")) + "|" + (.next|tostring)')" "the last page has no cursor"
  all=$(history "$home" --json --limit 13 | jq -r '(.next|tostring)')
  assert_equals null "$all" "a page that holds every row has no cursor"
  assert_equals 'sample-13' "$(history "$home" --json --limit 1 | ids)" "the new close heads a fresh listing"
  assert_equals 'sample-06' "$(history "$home" --json --limit 1 --after sample-07 | ids)" "any id is a cursor"
  out=$(history "$home" --json --repo sample --limit 2 --after sample-02) || fail "a filtered cursor failed"
  assert_equals 'sample-01|null' "$(printf '%s' "$out" | jq -r '([.records[].id] | join(",")) + "|" + (.next|tostring)')" \
    "the cursor applies after the repo filter"
  pass "paging follows the id cursor, and a close between pages does not shift it"
}

test_usage_errors() {
  local home out rc bad
  home=$(make_home usage)
  close_task "$home" sample-a 'Sample A' sample
  out=$(history "$home" --json --after sample-missing 2>&1); rc=$?
  expect_code 2 "$rc" "an unknown --after id"
  assert_contains "$out" "--after names no closed task in this listing: sample-missing" "the unknown cursor is named"
  out=$(history "$home" --json --repo other --after sample-a 2>&1); rc=$?
  expect_code 2 "$rc" "a cursor the repo filter excludes"
  for bad in "--limit 0" "--limit 501" "--limit abc" "--limit 99999999999999999999" "--limit" "--repo" "--after" "--bogus" ""; do
    # shellcheck disable=SC2086 # each case is a flag list
    out=$(history "$home" --json $bad 2>&1); rc=$?
    if [ -z "$bad" ]; then
      expect_code 0 "$rc" "the defaults"
      continue
    fi
    expect_code 2 "$rc" "usage: $bad"
  done
  out=$(FM_HOME="$home" FM_HISTORY_NOW="$NOW" "$HISTORY" 2>&1); rc=$?
  expect_code 2 "$rc" "no --json"
  out=$(history "$home" --json --repo '' 2>&1); rc=$?
  expect_code 2 "$rc" "an empty --repo"
  assert_equals 1 "$(history "$home" --json --limit 500 | jq '.records | length')" "the largest limit is accepted"
  pass "usage errors exit 2, including an unknown cursor"
}

test_missing_and_unreadable_archive() {
  local home out rc
  home=$(make_home archive)
  close_task "$home" sample-a 'Sample A' sample
  assert_absent "$home/data/done-archive.md" "a young home has no archive"
  out=$(history "$home" --json); rc=$?
  expect_code 0 "$rc" "a missing archive"
  assert_equals 'false|false|sample-a' \
    "$(printf '%s' "$out" | jq -r '[.archive.present, .archive.readable, ([.records[].id] | join(","))] | join("|")')" \
    "a missing archive is not present, and the backlog still answers"

  printf '\n## Archived 2026-09-01\n- [x] sample-old - Archived sample (repo: sample) (done 2026-09-01)\n' \
    > "$home/data/done-archive.md"
  chmod 000 "$home/data/done-archive.md"
  if [ -r "$home/data/done-archive.md" ]; then
    chmod 644 "$home/data/done-archive.md"
    echo "skip: running as a user who can read a mode-000 file; the unreadable archive case needs another user"
  else
    out=$(history "$home" --json); rc=$?
    chmod 644 "$home/data/done-archive.md"
    expect_code 0 "$rc" "an unreadable archive"
    assert_equals 'true|false|sample-a' \
      "$(printf '%s' "$out" | jq -r '[.archive.present, .archive.readable, ([.records[].id] | join(","))] | join("|")')" \
      "an unreadable archive is present but not readable, and the backlog still answers"
  fi
  assert_equals 'true|true|sample-a,sample-old' \
    "$(history "$home" --json | jq -r '[.archive.present, .archive.readable, ([.records[].id] | join(","))] | join("|")')" \
    "once readable, the archive's rows follow"

  rm -f "$home/data/done-archive.md"
  mkdir "$home/data/done-archive.md"
  assert_equals 'true|false' "$(history "$home" --json | jq -r '[.archive.present, .archive.readable] | join("|")')" \
    "an archive path that is not a file is unreadable"
  rmdir "$home/data/done-archive.md"

  rm -f "$home/data/backlog.md"
  printf '\n## Archived 2026-09-01\n- [x] sample-old - Archived sample (repo: sample) (done 2026-09-01)\n' \
    > "$home/data/done-archive.md"
  out=$(history "$home" --json); rc=$?
  expect_code 0 "$rc" "a home with no backlog file"
  assert_equals 'sample-old' "$(printf '%s' "$out" | ids)" "an absent backlog has no rows of its own"
  pass "a missing or unreadable archive is reported, and the backlog still answers"
}

test_captain_call_returns_its_answer() {
  local home out
  home=$(make_home captain)
  close_task "$home" sample-ship 'SHIP the sample' sample --pr https://github.com/example/sample/pull/7
  FM_HOME="$home" REAL_TASKS_AXI="$TASKS_AXI_BIN" FM_CAPTAIN_HOLD_NOW="$NOW" \
    "$ROOT/bin/fm-captain-hold.sh" hold sample-call --title 'Choose the sample route' --reason 'route pending' \
    --repo sample --question 'Which route?' --option fast='Take the fast route' --option safe='Take the safe route' \
    >/dev/null || fail "hold failed"
  printf 'sample-call\tsafe\tTake the safe route\t\n' | FM_HOME="$home" REAL_TASKS_AXI="$TASKS_AXI_BIN" \
    FM_CAPTAIN_HOLD_NOW="$NOW" "$ROOT/bin/fm-captain-hold.sh" answers --source quarterdeck >/dev/null \
    || fail "answer failed"
  out=$(history "$home" --json --repo sample) || fail "history failed"
  assert_equals 'sample-call,sample-ship' "$(printf '%s' "$out" | ids)" "the answered call is a closed row"
  assert_equals 'captain|done' \
    "$(printf '%s' "$out" | jq -r '.records[0] | [.hold_kind, .completion.verb] | join("|")')" "the call's row"
  assert_equals 'sample-call|closed|Which route?|safe|Take the safe route|captain|quarterdeck|2026-09-18T12:00:00Z' \
    "$(printf '%s' "$out" | jq -r '.calls[] | [.id, .state, .question, .answer.key, .answer.label, .answer.by, .answer.via, .answer.at] | join("|")')" \
    "only the call is listed, with the answer read by the call owner"
  assert_equals "$(FM_HOME="$home" FM_CAPTAIN_HOLD_NOW="$NOW" "$ROOT/bin/fm-captain-hold.sh" list --json | jq -c '.calls')" \
    "$(printf '%s' "$out" | jq -c '.calls')" "the call object is exactly list's"
  assert_equals 0 "$(history "$home" --json --after sample-call | jq '.calls | length')" \
    "a page without the call lists no call"
  pass "a captain call's row returns its call with the answer key"
}

test_a_stateless_home_stays_stateless() {
  local home before after out
  home=$(make_home stateless --stateless)
  cat > "$home/data/backlog.md" <<'EOF'
# Backlog

## In flight
## Queued
## Done
- [x] sample-call - Sample question (repo: sample) (kind: captain) (hold: sample pending) (hold-kind: captain) (done 2026-09-17)
  Resolution recorded by fm-captain-hold.
  Decision digest: sample
  Resolution mode: answered
  Answer key: yes
  Answer label: Yes
  Answered by: captain
  Answered via: chat
  Answered at: 2026-09-17T10:00:00Z

  Captain decision:
  yes
EOF
  printf '\n## Archived 2026-09-01\n- [x] sample-old - Archived sample (repo: sample) (done 2026-09-01)\n' \
    > "$home/data/done-archive.md"
  chmod -R a-w "$home"
  before=$(cd "$home" && find . | LC_ALL=C sort)
  out=$(history "$home" --json) || { chmod -R u+w "$home"; fail "history in a stateless home failed"; }
  after=$(cd "$home" && find . | LC_ALL=C sort)
  chmod -R u+w "$home"
  assert_equals "$before" "$after" "history created nothing in the home"
  assert_absent "$home/state" "history created a state directory"
  assert_equals 'sample-call,sample-old|yes' \
    "$(printf '%s' "$out" | jq -r '([.records[].id] | join(",")) + "|" + .calls[0].answer.key')" \
    "a read-only home still answers, calls included"
  pass "a stateless, read-only home stays stateless"
}

test_record_shape_matches_the_snapshot() {
  local home snap hist row
  home=$(make_home shape)
  close_task "$home" sample-ship 'SHIP the sample' sample --pr https://github.com/example/sample/pull/7
  mkdir -p "$home/data/sample-scout"
  printf '# Findings\n' > "$home/data/sample-scout/report.md"
  axi "$home" add sample-scout 'Scout the sample' --repo sample --kind scout || fail "add scout failed"
  axi "$home" 'done' sample-scout --report data/sample-scout/report.md --note 'Findings recorded.' || fail "done scout failed"
  axi "$home" add sample-gated 'Gated sample' --repo sample || fail "add gated failed"
  axi "$home" 'done' sample-gated || fail "done gated failed"
  snap=$(FM_HOME="$home" FM_SNAPSHOT_NOW="$NOW" "$ROOT/bin/fm-fleet-snapshot.sh" --backlog-json) || fail "snapshot failed"
  hist=$(history "$home" --json) || fail "history failed"
  for row in sample-ship sample-scout sample-gated; do
    assert_equals "$(printf '%s' "$snap" | jq -cS --arg id "$row" '.records[] | select(.id == $id)')" \
      "$(printf '%s' "$hist" | jq -cS --arg id "$row" '.records[] | select(.id == $id)')" \
      "the history record for $row is the snapshot's"
  done
  assert_equals 'reported|data/sample-scout/report.md|merged|https://github.com/example/sample/pull/7' \
    "$(printf '%s' "$hist" | jq -r '[(.records[] | select(.id == "sample-scout") | .completion.verb, .report_path),
      (.records[] | select(.id == "sample-ship") | .completion.verb, .pr_url)] | join("|")')" \
    "completion verbs and artifacts come through"

  # An archived row reads exactly as the same row did in the Done section.
  # Its `order` is its position in the archive as written, the second row here
  # as it was the second row of the backlog.
  { printf '\n## Archived 2026-09-17\n- [x] sample-older - Older sample (repo: sample) (done 2026-09-17)\n'
    printf '\n## Archived 2026-09-18\n'; grep -A1 '^- \[x\] sample-scout ' "$home/data/backlog.md"; } > "$home/data/done-archive.md"
  grep -v -e '^- \[x\] sample-scout ' -e '^  Findings recorded\.$' "$home/data/backlog.md" > "$home/backlog.tmp"
  mv "$home/backlog.tmp" "$home/data/backlog.md"
  assert_equals "$(printf '%s' "$snap" | jq -cS '.records[] | select(.id == "sample-scout")')" \
    "$(history "$home" --json | jq -cS '.records[] | select(.id == "sample-scout")')" \
    "the archived record is the snapshot's record of the same row"
  pass "a history record has exactly the snapshot's shape for the same row"
}

test_a_non_markdown_backend_is_refused() {
  local home out rc
  home=$(make_home beads)
  printf 'backend = "beads"\n' > "$home/.tasks.toml"
  out=$(history "$home" --json 2>&1); rc=$?
  expect_code 1 "$rc" "a beads home"
  assert_contains "$out" "this home's tasks-axi backend is 'beads'" "the refusal names the backend"
  pass "a home on another backlog backend is refused"
}

test_order_runs_through_done_and_the_archive
test_repo_filter_is_exact
test_paging_follows_the_id_cursor_across_a_close
test_usage_errors
test_missing_and_unreadable_archive
test_captain_call_returns_its_answer
test_a_stateless_home_stays_stateless
test_record_shape_matches_the_snapshot
test_a_non_markdown_backend_is_refused
