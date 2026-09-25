#!/usr/bin/env bash
# Behavioral tests for bin/fm-pr-body-fix.sh: the blank-line repair of a pull
# request body whose `<details>` HTML block swallows the markdown glued to it.
# The fixtures are real bodies, not invented ones: tests/assets/pr17-body-as-posted.body
# and tests/assets/pr11-body-as-posted.body are PRs #17 and #11 of
# caomyer/quarterdeck exactly as the no-mistakes pr step first posted them
# (GitHub's userContentEdits), and tests/assets/pr11-body-fixed-by-hand.body is
# the repair firstmate applied to #11 by hand.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SCRIPT="$ROOT/bin/fm-pr-body-fix.sh"
ASSETS="$ROOT/tests/assets"
TMP_ROOT=$(fm_test_tmproot fm-pr-body-fix-tests)
FAKEBIN=$(fm_fakebin "$TMP_ROOT")
URL=https://github.com/o/r/pull/7

# The fake gh holds the body in $FM_TEST_BODY and answers the two calls the
# script makes the way gh does: `pr view --json body -q .body` prints the body
# and a newline, and `pr edit --body-file` replaces it with the file's bytes.
# FM_TEST_DRIFT appends a counter to the body on every read, as a writer still
# updating it would; FM_TEST_CLOBBER overwrites it right after an edit.
cat > "$FAKEBIN/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FM_TEST_GH_LOG"
case "$*" in
  "pr view https://github.com/o/r/pull/7 --json body -q .body")
    if [ -n "${FM_TEST_DRIFT-}" ]; then
      n=$(($(cat "$FM_TEST_DRIFT") + 1))
      printf '%s' "$n" > "$FM_TEST_DRIFT"
      printf '\ndrift %s' "$n" >> "$FM_TEST_BODY"
    fi
    cat "$FM_TEST_BODY"
    printf '\n'
    ;;
  "pr edit https://github.com/o/r/pull/7 --body-file "*)
    cp "${!#}" "$FM_TEST_BODY"
    [ -z "${FM_TEST_CLOBBER-}" ] || printf 'someone else\n' >> "$FM_TEST_BODY"
    ;;
  *)
    printf 'unexpected gh call: %s\n' "$*" >&2
    exit 91
    ;;
esac
SH
chmod +x "$FAKEBIN/gh"

# nonblank <file>: the file without blank lines, the proof's comparison.
nonblank() {
  grep -v '^[[:space:]]*$' "$1"
}

# run_url <case> <body-file>: run the URL mode against a copy of the body.
# Sets OUT, STATUS, and CASE_DIR (holding body and gh.log).
run_url() {
  CASE_DIR="$TMP_ROOT/$1"
  mkdir -p "$CASE_DIR"
  cp "$2" "$CASE_DIR/body"
  : > "$CASE_DIR/gh.log"
  STATUS=0
  OUT=$(PATH="$FAKEBIN:$PATH" FM_TEST_BODY="$CASE_DIR/body" FM_TEST_GH_LOG="$CASE_DIR/gh.log" \
    "$SCRIPT" "$URL" 2>&1) || STATUS=$?
}

edits() {
  grep -c '^pr edit ' "$CASE_DIR/gh.log" || true
}

test_real_pr17_body_gets_one_blank_line_before_its_first_screenshot() {
  local out="$TMP_ROOT/pr17.out" notes="$TMP_ROOT/pr17.notes" expected="$TMP_ROOT/pr17.expected"
  "$SCRIPT" --filter < "$ASSETS/pr17-body-as-posted.body" > "$out" 2> "$notes" \
    || fail "the filter failed on the real #17 body"
  assert_equals 1 "$(wc -l < "$notes" | tr -d ' ')" "#17 has exactly one glued block"
  assert_contains "$(cat "$notes")" 'line 394: follows </details>: ![Bearings: argued call with a dated Not now and words (light)]' \
    "the note names the screenshot glued under the run log's </details>"
  sed -n 393p "$ASSETS/pr17-body-as-posted.body" | grep -qx '</details>' \
    || fail "fixture drifted: line 393 of the #17 body is no longer its </details>"
  awk 'NR == 394 { print "" } { print }' "$ASSETS/pr17-body-as-posted.body" > "$expected"
  cmp -s "$expected" "$out" || fail "the #17 repair is not exactly one blank line before line 394"
  cmp -s <(nonblank "$ASSETS/pr17-body-as-posted.body") <(nonblank "$out") \
    || fail "the #17 repair changed more than blank lines"
  pass "the real #17 body gets one blank line between </details> and its first screenshot, and nothing else"
}

test_real_pr11_body_matches_the_hand_repair() {
  local out="$TMP_ROOT/pr11.out" notes="$TMP_ROOT/pr11.notes"
  "$SCRIPT" --filter < "$ASSETS/pr11-body-as-posted.body" > "$out" 2> "$notes" \
    || fail "the filter failed on the real #11 body"
  assert_equals 5 "$(wc -l < "$notes" | tr -d ' ')" "#11 has five glued lines"
  assert_contains "$(cat "$notes")" 'line 129: follows </details>: <details>' \
    "a </details> glued to the next <details> gets one blank line, not two"
  assert_contains "$(cat "$notes")" 'line 144: is a <details> line glued to the line above' \
    "a <details> glued under a screenshot is separated too"
  # The hand repair also dropped the body's trailing blank line; the proof
  # ignores blank lines, and so does this comparison of the two repairs.
  cmp -s <(sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$out") \
    <(sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$ASSETS/pr11-body-fixed-by-hand.body") \
    || fail "the #11 repair differs from the one firstmate made by hand"
  pass "the real #11 body is repaired exactly as firstmate repaired it by hand"
}

test_repair_is_idempotent_on_every_real_body() {
  local f out2
  for f in pr17-body-as-posted pr11-body-as-posted pr11-body-fixed-by-hand; do
    "$SCRIPT" --filter < "$ASSETS/$f.body" > "$TMP_ROOT/$f.once" 2>/dev/null || fail "$f: filter failed"
    out2=$("$SCRIPT" --filter < "$TMP_ROOT/$f.once" 2>&1 >"$TMP_ROOT/$f.twice") || fail "$f: second pass failed"
    assert_equals "" "$out2" "$f: a second pass finds nothing"
    cmp -s "$TMP_ROOT/$f.once" "$TMP_ROOT/$f.twice" || fail "$f: a second pass changed the body"
  done
  pass "a second pass over any repaired body changes nothing"
}

test_fenced_code_and_line_endings() {
  local body out notes
  body=$'Log:\n```\n</details>\nstill code\n<details>\n```\n</details>\n```sh\necho\n```\n'
  out=$(printf '%s' "$body" | "$SCRIPT" --filter 2>"$TMP_ROOT/fence.notes")
  notes=$(cat "$TMP_ROOT/fence.notes")
  assert_equals 'line 8: follows </details>: ```sh' "$notes" \
    "inside a fence nothing is touched; the </details> after it is"
  assert_contains "$out" $'still code\n<details>\n```\n</details>\n\n```sh' "the repaired fence body"

  out=$(printf 'a\r\n<details>\r\n<summary>s</summary>\r\n\r\nx\r\n</details>\r\nb\r\n' | "$SCRIPT" --filter 2>/dev/null)
  assert_equals $'a\r\n\r\n<details>\r\n<summary>s</summary>\r\n\r\nx\r\n</details>\r\n\r\nb\r' "$out" \
    "a CRLF body gets CRLF blank lines"

  out=$(printf '<details open>\n<summary>s</summary>\n\n</details>\n\n<detailsx>\nend\n' | "$SCRIPT" --filter 2>&1 >/dev/null)
  assert_equals "" "$out" "a first-line <details>, a separated </details> and a non-details tag are left alone"
  pass "fenced code, CRLF bodies and non-matching tags are handled"
}

test_url_mode_repairs_once_then_leaves_it_alone() {
  run_url repair "$ASSETS/pr17-body-as-posted.body"
  expect_code 0 "$STATUS" "repair"
  assert_contains "$OUT" "pr-body: repaired 1 line(s) in $URL" "the repair is reported"
  assert_contains "$OUT" "line 394: follows </details>" "the report names the line"
  assert_equals 1 "$(edits)" "exactly one edit"
  cmp -s <(nonblank "$ASSETS/pr17-body-as-posted.body") <(nonblank "$CASE_DIR/body") \
    || fail "the written body changed more than blank lines"
  "$SCRIPT" --filter < "$CASE_DIR/body" > /dev/null 2> "$TMP_ROOT/written.notes"
  [ ! -s "$TMP_ROOT/written.notes" ] || fail "the written body still has a glued block"

  : > "$CASE_DIR/gh.log"
  STATUS=0
  OUT=$(PATH="$FAKEBIN:$PATH" FM_TEST_BODY="$CASE_DIR/body" FM_TEST_GH_LOG="$CASE_DIR/gh.log" \
    "$SCRIPT" "$URL" 2>&1) || STATUS=$?
  expect_code 0 "$STATUS" "second run"
  assert_equals "pr-body: ok" "$OUT" "the second run finds nothing"
  assert_equals 0 "$(edits)" "the second run writes nothing"
  pass "a PR is repaired once, and a second run reads it and writes nothing"
}

test_correct_body_is_never_written() {
  run_url correct "$ASSETS/pr11-body-fixed-by-hand.body"
  expect_code 0 "$STATUS" "correct body"
  assert_equals "pr-body: ok" "$OUT" "a correct body reads ok"
  assert_equals 0 "$(edits)" "a correct body is never written"
  assert_equals 1 "$(wc -l < "$CASE_DIR/gh.log" | tr -d ' ')" "a correct body costs one read"
  pass "a body that already follows the rule is read once and never written"
}

test_changing_body_is_refused() {
  CASE_DIR="$TMP_ROOT/drift"
  mkdir -p "$CASE_DIR"
  cp "$ASSETS/pr17-body-as-posted.body" "$CASE_DIR/body"
  : > "$CASE_DIR/gh.log"
  printf 0 > "$CASE_DIR/drift"
  STATUS=0
  OUT=$(PATH="$FAKEBIN:$PATH" FM_TEST_BODY="$CASE_DIR/body" FM_TEST_GH_LOG="$CASE_DIR/gh.log" \
    FM_TEST_DRIFT="$CASE_DIR/drift" "$SCRIPT" "$URL" 2>&1) || STATUS=$?
  expect_code 1 "$STATUS" "a body still being written"
  assert_contains "$OUT" "pr-body: refused: the body of $URL kept changing" "the refusal says why"
  assert_equals 0 "$(edits)" "a changing body is never written"

  CASE_DIR="$TMP_ROOT/clobber"
  mkdir -p "$CASE_DIR"
  cp "$ASSETS/pr17-body-as-posted.body" "$CASE_DIR/body"
  : > "$CASE_DIR/gh.log"
  STATUS=0
  OUT=$(PATH="$FAKEBIN:$PATH" FM_TEST_BODY="$CASE_DIR/body" FM_TEST_GH_LOG="$CASE_DIR/gh.log" \
    FM_TEST_CLOBBER=1 "$SCRIPT" "$URL" 2>&1) || STATUS=$?
  expect_code 1 "$STATUS" "a body overwritten after the repair"
  assert_contains "$OUT" "changed again right after the repair was written" "the read-back catches another writer"
  pass "a body another writer is still changing is refused, before or after the write"
}

# The proof is the guard against a wrong repair, so it is tested against one:
# a copy of the script whose filter also alters a content line.
test_failed_proof_refuses_and_writes_nothing() {
  local bad="$TMP_ROOT/badbin"
  mkdir -p "$bad"
  cp "$ROOT/bin/fm-pr-lib.sh" "$bad/"
  sed 's/^      print line$/      print (NR == 3 ? line "!" : line)/' "$SCRIPT" > "$bad/fm-pr-body-fix.sh"
  chmod +x "$bad/fm-pr-body-fix.sh"
  grep -q 'line "!"' "$bad/fm-pr-body-fix.sh" || fail "the broken-filter copy was not made"
  CASE_DIR="$TMP_ROOT/proof"
  mkdir -p "$CASE_DIR"
  cp "$ASSETS/pr17-body-as-posted.body" "$CASE_DIR/body"
  : > "$CASE_DIR/gh.log"
  STATUS=0
  OUT=$(PATH="$FAKEBIN:$PATH" FM_TEST_BODY="$CASE_DIR/body" FM_TEST_GH_LOG="$CASE_DIR/gh.log" \
    "$bad/fm-pr-body-fix.sh" "$URL" 2>&1) || STATUS=$?
  expect_code 1 "$STATUS" "a repair that changes content"
  assert_contains "$OUT" "would differ from the original by more than blank lines, so nothing was written" \
    "the refusal says nothing was written"
  assert_contains "$OUT" "  line 394: follows </details>: ![Bearings" "the refusal names the line to fix by hand"
  assert_equals 0 "$(edits)" "a failed proof writes nothing"
  cmp -s "$ASSETS/pr17-body-as-posted.body" "$CASE_DIR/body" || fail "the body was touched"
  pass "a repair that would change more than blank lines is refused and nothing is written"
}

test_non_github_and_bad_arguments() {
  local out status=0
  out=$("$SCRIPT" https://gitlab.com/g/p/-/merge_requests/1 2>&1) || status=$?
  expect_code 0 "$status" "gitlab"
  assert_contains "$out" "pr-body: skipped:" "a GitLab merge request is skipped"
  status=0
  "$SCRIPT" not-a-url >/dev/null 2>&1 || status=$?
  expect_code 2 "$status" "a non-URL"
  status=0
  "$SCRIPT" >/dev/null 2>&1 || status=$?
  expect_code 2 "$status" "no argument"
  pass "a non-GitHub URL is skipped and bad arguments are refused"
}

test_real_pr17_body_gets_one_blank_line_before_its_first_screenshot
test_real_pr11_body_matches_the_hand_repair
test_repair_is_idempotent_on_every_real_body
test_fenced_code_and_line_endings
test_url_mode_repairs_once_then_leaves_it_alone
test_correct_body_is_never_written
test_changing_body_is_refused
test_failed_proof_refuses_and_writes_nothing
test_non_github_and_bad_arguments
