#!/usr/bin/env bash
# End to end: firstmate installed as a read-only copy outside git, as inside an
# app, running a home created from nothing by bin/fm-home-init.sh. Everything
# runs from the home the way the app's first mate does - cwd is the home, the
# session-start hook is the exact command .claude/settings.json holds, and
# scripts are called by relative bin/ paths - and the copy must come out
# byte-for-byte unchanged.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-installed-home)
mkdir -p "$TMP_ROOT"
trap 'chmod -R u+w "$TMP_ROOT" 2>/dev/null; rm -rf "$TMP_ROOT"' EXIT

if ! command -v tasks-axi >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  pass "SKIP (tasks-axi and jq are required): installed-copy home end to end"
  exit 0
fi

CODE="$TMP_ROOT/app/firstmate"
mkdir -p "$CODE"
(cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$CODE" \
  || fail "could not copy the code"
chmod -R a-w "$CODE"
CODE=$(cd "$CODE" && pwd -P)
HOME_DIR="$TMP_ROOT/home"
USER_HOME="$TMP_ROOT/user"
mkdir -p "$USER_HOME" "$TMP_ROOT/tmp"

# Every path and every file's checksum, to prove nothing wrote to the copy.
manifest() {
  (cd "$CODE" && find . -print | LC_ALL=C sort && find . -type f -exec cksum {} + | LC_ALL=C sort)
}
BEFORE=$(manifest)

# in_home <cmd...>: run as the app's first mate does - from the home, with only
# FM_HOME naming it, and none of this checkout's or the caller's firstmate
# settings leaking in.
in_home() {
  (cd "$HOME_DIR" && env -u FM_ROOT_OVERRIDE -u FM_STATE_OVERRIDE -u FM_DATA_OVERRIDE -u FM_CONFIG_OVERRIDE \
    -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u TMUX -u TMUX_PANE \
    HOME="$USER_HOME" TMPDIR="$TMP_ROOT/tmp" FM_HOME="$HOME_DIR" CLAUDE_PROJECT_DIR="$HOME_DIR" "$@")
}

test_home_is_created_from_nothing() {
  local out
  out=$(FM_HOME="$HOME_DIR" "$CODE/bin/fm-home-init.sh" 2>&1) || fail "fm-home-init failed: $out"
  HOME_DIR=$(cd "$HOME_DIR" && pwd -P)
  [ -L "$HOME_DIR/bin" ] && [ -d "$HOME_DIR/state" ] || fail "the home was not laid out: $out"
  pass "an empty home is laid out from the installed copy"
}

test_session_start_hook_runs_from_the_home() {
  local cmd out
  cmd=$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$HOME_DIR/.claude/settings.json") \
    || fail "could not read the session-start hook"
  out=$(printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' | in_home bash -c "$cmd" 2>&1) \
    || fail "the session-start hook failed: $out"
  assert_contains "$out" "SESSION START - $HOME_DIR" "the hook ran session start in the home"
  assert_contains "$out" "SUPERVISION OPERATING INSTRUCTIONS" "the digest reached the supervision instructions"
  [ -f "$HOME_DIR/state/.session-start-complete" ] || fail "session start did not complete in the home's state"
  pass "the exact session-start hook command runs the full digest from the home"
}

test_backlog_calls_and_history_work_by_relative_paths() {
  local out
  out=$(in_home bin/fm-tasks-axi.sh add shipit-one "demo: ship one thing" --kind ship 2>&1) \
    || fail "adding a backlog task failed: $out"
  [ -f "$HOME_DIR/data/backlog.md" ] || fail "the backlog must be written in the home's data/"
  grep -q 'shipit-one' "$HOME_DIR/data/backlog.md" || fail "the task is not in the home's backlog"

  out=$(in_home bin/fm-captain-hold.sh hold pick-one --title 'demo: pick one' --reason 'which one' \
    --option left='Left' --option right='Right' --recommend left 2>&1) || fail "raising a call failed: $out"
  out=$(printf 'pick-one\tleft\tLeft\tdone\n' | in_home bin/fm-captain-hold.sh answers --source quarterdeck 2>&1) \
    || fail "answering the call failed: $out"
  assert_contains "$out" "closed: pick-one" "the call closed"
  out=$(in_home bin/fm-captain-hold.sh list --json 2>&1) || fail "listing calls failed: $out"
  [ "$(printf '%s' "$out" | jq -r '.calls[] | select(.id == "pick-one") | .answer.key')" = left ] \
    || fail "the call's answer is not listed: $out"

  out=$(in_home bin/fm-fleet-snapshot.sh --json 2>&1) || fail "the fleet snapshot failed: $out"
  printf '%s' "$out" | jq -e '.backlog.records | map(.id) | index("shipit-one") != null' >/dev/null \
    || fail "the fleet snapshot does not see the home's backlog"
  out=$(in_home bin/fm-bearings-snapshot.sh --json 2>&1) || fail "the bearings snapshot failed: $out"
  out=$(in_home bin/fm-history.sh --json 2>&1) || fail "the history failed: $out"
  [ "$(printf '%s' "$out" | jq -r '.calls[0].answer.label')" = Left ] || fail "the history lost the answer: $out"
  pass "the backlog, a call and its answer, both snapshots, and the history work from the home"
}

test_the_copy_is_untouched() {
  local after
  after=$(manifest)
  [ "$after" = "$BEFORE" ] || fail "the installed copy changed: $(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$after") | head -20)"
  [ -z "$(find "$CODE" -name __pycache__ -print -quit)" ] || fail "Python wrote bytecode into the copy"
  pass "the installed copy is byte-for-byte unchanged"
}

test_nothing_is_left_running() {
  local pids
  pids=$(pgrep -f -- "$TMP_ROOT" | tr '\n' ' ' || true)
  [ -z "${pids// /}" ] || fail "processes outlived the test: $(ps -o pid=,command= -p "${pids// /,}")"
  pass "nothing started from the home is left running"
}

test_home_is_created_from_nothing
test_session_start_hook_runs_from_the_home
test_backlog_calls_and_history_work_by_relative_paths
test_the_copy_is_untouched
test_nothing_is_left_running
