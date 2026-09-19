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

# left_running: the pids of processes still running from this test's files.
# Session start leaves its deferred network checks running detached, as it does
# for a real first mate; the test waits for them, and anything still here at the
# end is stopped by pid before the files go.
left_running() {
  pgrep -f -- "$TMP_ROOT" 2>/dev/null | grep -vx "$$" || true
}
reap() {
  local pid
  for pid in $(left_running); do
    kill "$pid" 2>/dev/null || true
  done
  chmod -R u+w "$TMP_ROOT" 2>/dev/null
  rm -rf "$TMP_ROOT"
}
trap reap EXIT

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
# FM_HOME naming it, none of this checkout's or the caller's firstmate or
# harness settings leaking in, and no credentials: the network checks run
# against a user with no GitHub login, and give up quickly.
in_home() {
  (cd "$HOME_DIR" && env -u FM_ROOT_OVERRIDE -u FM_STATE_OVERRIDE -u FM_DATA_OVERRIDE -u FM_CONFIG_OVERRIDE \
    -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u TMUX -u TMUX_PANE -u GROK_AGENT -u GROK_HOOK_EVENT \
    -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN -u GH_CONFIG_DIR \
    -u GIT_CONFIG_GLOBAL -u SSH_AUTH_SOCK \
    -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME \
    HOME="$USER_HOME" TMPDIR="$TMP_ROOT/tmp" FM_STARTUP_NETWORK_TIMEOUT=30 \
    FM_HOME="$HOME_DIR" CLAUDE_PROJECT_DIR="$HOME_DIR" "$@")
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
  # A copy outside git has no branch to read; the first mate must not be shown git errors.
  assert_not_contains "$out" "fatal:" "the digest shows no git errors"
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

test_guard_hooks_apply_in_the_home() {
  local cmd out rc
  # Every PreToolUse hook .claude/settings.json runs for a Bash call: those
  # matching Bash and the catch-all. Any one blocking blocks the call.
  run_bash_hooks() {  # <shell command>
    local payload hook status=0
    payload=$(jq -cn --arg command "$1" '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$command}}')
    while IFS= read -r hook; do
      printf '%s' "$payload" | in_home bash -c "$hook" 2>&1 || status=$?
      [ "$status" = 0 ] || return "$status"
    done < <(jq -r '.hooks.PreToolUse[] | select(.matcher == "Bash" or .matcher == ".*") | .hooks[].command' "$HOME_DIR/.claude/settings.json")
  }
  rc=0; out=$(run_bash_hooks 'cd projects/foo') || rc=$?
  expect_code 2 "$rc" "a persistent cd must be blocked from the home: $out"
  assert_contains "$out" '[persistent-cd]' "the cd guard names its reason"
  rc=0; out=$(run_bash_hooks 'bin/fm-watch.sh') || rc=$?
  expect_code 2 "$rc" "a direct watcher run must be blocked from the home: $out"
  assert_contains "$out" 'watcher-direct' "the arm guard names its reason"
  rc=0; out=$(run_bash_hooks '(cd projects/foo && git status)') || rc=$?
  expect_code 0 "$rc" "a cd scoped to a subshell must pass the guards: $out"
  rc=0; out=$(run_bash_hooks 'bin/fm-tasks-axi.sh list') || rc=$?
  expect_code 0 "$rc" "an ordinary command must pass the guards: $out"
  pass "the cd and watcher-arm guards run from the home and block what they block in a checkout"
}

test_secondmates_are_refused_plainly() {
  local out rc=0 before after
  before=$(cd "$HOME_DIR" && find . -print | LC_ALL=C sort)
  out=$(in_home bin/fm-home-seed.sh mate - --no-projects 2>&1) || rc=$?
  expect_code 1 "$rc" "seeding a secondmate from an installed copy must be refused: $out"
  assert_contains "$out" "secondmates are not available here yet" "the refusal says why"
  assert_not_contains "$out" "fatal:" "the refusal shows no git errors"
  after=$(cd "$HOME_DIR" && find . -print | LC_ALL=C sort)
  [ "$after" = "$before" ] || fail "a refused seed changed the home"
  pass "a secondmate cannot be seeded from an installed copy, and the refusal says so plainly"
}

test_deferred_network_report_is_clean() {
  local status_file="$HOME_DIR/state/.startup-network.status" waited=0
  # Longer than the network budget in_home sets, so a slow network is waited out.
  while [ "$waited" -lt 200 ] && ! grep -q '^state=done' "$status_file" 2>/dev/null; do
    sleep 0.2
    waited=$((waited + 1))
  done
  grep -q '^state=done' "$status_file" 2>/dev/null || fail "the deferred network checks never finished: $(cat "$status_file" 2>/dev/null)"
  assert_no_grep "fatal:" "$HOME_DIR/state/.startup-network.report" "the network report shows no git errors"
  pass "the deferred network checks finish in the home without git errors"
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
  pids=$(left_running | tr '\n' ' ')
  [ -z "${pids// /}" ] || fail "processes outlived the test: $(ps -o pid=,command= -p "$(printf '%s' "$pids" | tr ' ' ',' | sed 's/,$//')")"
  pass "nothing started from the home is left running"
}

test_home_is_created_from_nothing
test_session_start_hook_runs_from_the_home
test_backlog_calls_and_history_work_by_relative_paths
test_guard_hooks_apply_in_the_home
test_secondmates_are_refused_plainly
test_deferred_network_report_is_clean
test_the_copy_is_untouched
test_nothing_is_left_running
