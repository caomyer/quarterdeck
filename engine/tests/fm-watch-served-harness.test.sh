#!/usr/bin/env bash
# tests/fm-watch-served-harness.test.sh - orphaned watcher chains retire.
#
# The Claude Stop hook runs bin/fm-claude-stop-autoarm.sh -> bin/fm-watch-arm.sh
# -> bin/fm-watch.sh for the first mate that holds the home's session lock.
# When that first mate dies uncatchably (host crash, SIGKILL), the chain is
# reparented instead of ending. These cases drive the REAL hook, arm, and
# watcher under a fake harness (a bash symlink named "claude") that holds a
# fixture home's state/.lock, SIGKILL it, and check that the chain notices and
# retires on its own (bin/fm-wake-lib.sh "Served harness"), while a chain that
# serves a live first mate, including a new one in the same home, keeps running.
# shellcheck disable=SC2016 # single quotes are deliberate: $$ and $FM_HOME expand inside the fake harness
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-watch-served-harness)
fm_git_identity fmtest fmtest@example.invalid

FAKEBIN=$(fm_fakebin "$TMP_ROOT/fakebin")
ln -s /bin/bash "$FAKEBIN/claude"
FAKE_CLAUDE="$FAKEBIN/claude"
# The fixture task names a tmux window; a fake tmux keeps the watcher's pane
# probes inside the fixture.
cat > "$FAKEBIN/tmux" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = list-windows ] && exit 0
exit 1
SH
chmod +x "$FAKEBIN/tmux"

# One poll per second bounds an orphan's life to about a second of test time.
export PATH="$FAKEBIN:$PATH" FM_POLL=1 FM_HEARTBEAT=999999 FM_CHECK_INTERVAL=999999 \
  FM_HOME_SUMMARY_INTERVAL=999999

STARTED_PIDS=()
cleanup_processes() {
  local pid
  for pid in "${STARTED_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
  done
  fm_test_cleanup
}
trap cleanup_processes EXIT

# A genuine primary checkout carrying the real scripts under test, with one
# in-flight task so the home needs supervision.
make_home() {  # <name>
  local dir="$TMP_ROOT/$1"
  fm_git_init_commit "$dir"
  mkdir -p "$dir/bin" "$dir/state"
  cp -R "$ROOT/bin/." "$dir/bin/"
  : > "$dir/AGENTS.md"
  printf 'project=fixture\nwindow=fixture\nbackend=tmux\n' > "$dir/state/task.meta"
  printf '%s\n' "$dir"
}

# Start a fake first mate for <home>: it takes the session lock, then fires one
# Stop hook per request file, exactly as Claude runs the async Stop hook as its
# own child. Sets HARNESS_PID; call it directly, never in a command
# substitution, so the harness stays this shell's child and can be reaped.
HARNESS_PID=
start_harness() {  # <home>
  local home=$1
  FM_HOME="$home" "$FAKE_CLAUDE" -c '
    printf "%s\n" "$$" > "$FM_HOME/state/.lock"
    while :; do
      if [ -e "$FM_HOME/stop-request" ]; then
        rm -f "$FM_HOME/stop-request"
        printf "{}\n" | "$FM_HOME/bin/fm-claude-stop-autoarm.sh" 2>/dev/null
        printf "%s\n" "$?" >> "$FM_HOME/stop-exits"
      fi
      sleep 0.1
    done
  ' >/dev/null 2>&1 &
  HARNESS_PID=$!
  STARTED_PIDS+=("$HARNESS_PID")
}

fire_stop() {  # <home>
  : > "$1/stop-request"
}

# Wait until the watcher recorded in <home>'s singleton serves <harness>.
wait_for_watcher_serving() {  # <home> <harness-pid>
  local home=$1 harness=$2 i=0
  while [ "$i" -lt 200 ]; do
    [ "$(sed -n '1p' "$home/state/.watch.lock/served-harness" 2>/dev/null)" = "$harness" ] && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# Wait for a watcher other than <not-pid> to hold <home>'s singleton, then set
# CHAIN_WATCHER, CHAIN_ARM, and CHAIN_HOOK from its parent links and track all
# three for cleanup, so even a chain that never retires is stopped by pid.
CHAIN_WATCHER='' CHAIN_ARM='' CHAIN_HOOK=''
wait_for_chain() {  # <home> [not-pid]
  local home=$1 not=${2:-} i=0 watcher arm hook
  while [ "$i" -lt 200 ]; do
    watcher=$(cat "$home/state/.watch.lock/pid" 2>/dev/null || true)
    if [ -n "$watcher" ] && [ "$watcher" != "$not" ]; then
      arm=$(ps -o ppid= -p "$watcher" 2>/dev/null | tr -d ' ')
      hook=$(ps -o ppid= -p "$arm" 2>/dev/null | tr -d ' ')
      case "$arm$hook" in
        ''|*[!0-9]*) ;;
        *)
          CHAIN_WATCHER=$watcher CHAIN_ARM=$arm CHAIN_HOOK=$hook
          STARTED_PIDS+=("$watcher" "$arm" "$hook")
          return 0
          ;;
      esac
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

all_gone() {
  local pid
  for pid in "$@"; do
    kill -0 "$pid" 2>/dev/null && return 1
  done
  return 0
}

all_alive() {
  local pid
  for pid in "$@"; do
    kill -0 "$pid" 2>/dev/null || return 1
  done
  return 0
}

# SIGKILL a fake first mate the way a crashed host leaves it: no trap runs, and
# the parent reaps it, so its pid is really gone.
crash_harness() {  # <pid>
  kill -KILL "$1" 2>/dev/null
  wait "$1" 2>/dev/null
}

# Wait up to <deci-seconds> for every pid to exit.
wait_all_gone() {  # <deci-seconds> <pid>...
  local limit=$1 i=0
  shift
  while [ "$i" -lt "$limit" ]; do
    all_gone "$@" && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

test_orphaned_chain_retires_after_its_harness_dies() {
  local home harness watcher arm hook
  home=$(make_home orphan)
  start_harness "$home"
  harness=$HARNESS_PID
  fire_stop "$home"
  wait_for_chain "$home" || fail "orphan: the Stop hook never started a watcher"
  watcher=$CHAIN_WATCHER arm=$CHAIN_ARM hook=$CHAIN_HOOK
  all_alive "$watcher" "$arm" "$hook" || fail "orphan: chain was not fully running before the crash"

  crash_harness "$harness"
  # One poll plus the cycle's own work; 10s is a generous ceiling at FM_POLL=1.
  wait_all_gone 100 "$watcher" "$arm" "$hook" \
    || fail "orphan: chain outlived its dead harness (watcher=$watcher arm=$arm hook=$hook)"
  assert_absent "$home/state/.watch.lock" "orphan: retired watcher left its singleton lock held"
  assert_grep 'reason=served-harness-gone' "$home/state/.watch-cycle-exits.log" \
    "orphan: the arm did not record the served-harness retirement"
  # The orphaned hook exits silently: nothing is committed for a dead session.
  assert_grep 'outcome=arming' "$home/state/.claude-autoarm-epoch" \
    "orphan: the orphaned hook committed an outcome for a dead session"
  pass "an orphaned Stop hook chain retires once its first mate is gone"
}

test_chain_serving_a_live_harness_keeps_running() {
  local home harness watcher arm hook
  home=$(make_home live)
  start_harness "$home"
  harness=$HARNESS_PID
  fire_stop "$home"
  wait_for_chain "$home" || fail "live: the Stop hook never started a watcher"
  watcher=$CHAIN_WATCHER arm=$CHAIN_ARM hook=$CHAIN_HOOK
  wait_for_watcher_serving "$home" "$harness" || fail "live: the watcher is not bound to its first mate"

  # Several full poll cycles, each of which checks the served harness.
  sleep 4
  all_alive "$watcher" "$arm" "$hook" || fail "live: a chain serving a live first mate stopped"
  assert_equals "$watcher" "$(cat "$home/state/.watch.lock/pid" 2>/dev/null)" "live: the watcher singleton changed hands"
  [ ! -e "$home/state/.watch-cycle-exits.log" ] || fail "live: a cycle closed while its first mate was alive"

  kill -KILL "$harness" "$hook" "$arm" "$watcher" 2>/dev/null
  wait "$harness" 2>/dev/null
  pass "a chain serving a live first mate keeps running across poll cycles"
}

test_new_harness_is_not_disturbed_by_the_old_chain() {
  local home old new old_watcher old_arm old_hook new_watcher new_arm new_hook ack i
  home=$(make_home successor)
  start_harness "$home"
  old=$HARNESS_PID
  fire_stop "$home"
  wait_for_chain "$home" || fail "successor: the first Stop hook never started a watcher"
  old_watcher=$CHAIN_WATCHER old_arm=$CHAIN_ARM old_hook=$CHAIN_HOOK

  # The new first mate starts in the same home while the old chain still runs.
  crash_harness "$old"
  start_harness "$home"
  new=$HARNESS_PID
  fire_stop "$home"
  wait_for_watcher_serving "$home" "$new" || fail "successor: the new first mate's Stop deferred to the orphan's claim or never armed"
  wait_all_gone 100 "$old_watcher" "$old_arm" "$old_hook" \
    || fail "successor: the old chain outlived its harness (watcher=$old_watcher arm=$old_arm hook=$old_hook)"
  assert_grep "session_pid=$new" "$home/state/.claude-autoarm-epoch" \
    "successor: the new first mate's claim does not name its own session"

  # The old watcher's close is watcher downtime, which the new first mate's
  # first cycle surfaces for recovery. Handle it as the new session would, then
  # let its next Stop arm the steady cycle.
  i=0
  while [ "$i" -lt 100 ] && [ ! -s "$home/stop-exits" ]; do sleep 0.1; i=$((i + 1)); done
  assert_equals 2 "$(sed -n '1p' "$home/stop-exits" 2>/dev/null)" "successor: the new first mate was not woken for the recovered downtime"
  ack=$(FM_HOME="$home" "$home/bin/fm-wake-drain.sh" 2>&1 >/dev/null \
    | sed -n 's/^WAKE_ACK_REQUIRED:.*\(--ack-through [0-9][0-9]* --recovery-generation [A-Za-z0-9._-][A-Za-z0-9._-]*\)$/\1/p')
  [ -n "$ack" ] || fail "successor: the recovery wake offered no acknowledgement"
  # shellcheck disable=SC2086 # $ack is the drain's own two-flag acknowledgement.
  FM_HOME="$home" "$home/bin/fm-wake-drain.sh" $ack >/dev/null 2>&1 || fail "successor: acknowledging the recovery wake failed"
  fire_stop "$home"
  wait_for_chain "$home" "$old_watcher" || fail "successor: the new first mate's next Stop started no watcher"
  new_watcher=$CHAIN_WATCHER new_arm=$CHAIN_ARM new_hook=$CHAIN_HOOK
  wait_for_watcher_serving "$home" "$new" || fail "successor: the steady watcher does not serve the new first mate"

  sleep 3
  all_alive "$new" "$new_watcher" "$new_arm" "$new_hook" \
    || fail "successor: the new first mate's chain stopped ($new_watcher $new_arm $new_hook)"
  assert_equals 1 "$(grep -c 'reason=served-harness-gone' "$home/state/.watch-cycle-exits.log")" \
    "successor: only the orphaned watcher may retire"

  kill -KILL "$new" "$new_hook" "$new_arm" "$new_watcher" 2>/dev/null
  wait "$new" 2>/dev/null
  pass "a new first mate in the same home is not disturbed by the old chain's exit"
}

test_orphaned_chain_retires_after_its_harness_dies
test_chain_serving_a_live_harness_keeps_running
test_new_harness_is_not_disturbed_by_the_old_chain
