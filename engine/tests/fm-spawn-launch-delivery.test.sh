#!/usr/bin/env bash
# tests/fm-spawn-launch-delivery.test.sh - end-to-end regression for how
# bin/fm-spawn.sh delivers a worker's launch command into its pane.
#
# The defect: the launch used to be typed into the pane as one long line. When
# it landed while the pane's shell was still starting - `treehouse get` hands
# the pane a fresh interactive shell, and the spawn types as soon as the pane's
# cwd moves, while that shell is still reading its rc files - the keystrokes sat
# in the terminal's cooked-mode input queue, which on macOS holds 1024 bytes and
# drops the rest. The claude launch runs well past that and ends in
# `"$(... encode launch-brief < ...)"`, so it arrived cut off inside the command
# substitution, the shell waited at `dquote cmdsubst quote>`, and no agent ever
# ran. The spawn still committed the task to In flight, so five workers looked
# healthy - a window, a worktree, a task in flight - with nothing running.
#
# Everything here is real except the harness and the worktree provider: a REAL
# tmux server on a private socket, a REAL bash in each pane whose rc file is
# deliberately slow so the launch arrives exactly while the shell is starting,
# and the REAL claude launch shape, with `claude` a stand-in that records the
# argv it was given and then runs as a process the liveness classifier reads as
# claude. It proves:
#   1. the whole launch reaches the harness intact, across a slow shell start,
#      including the command substitution that carries the brief;
#   2. a launch that produces no agent fails the spawn, says so in the status
#      file, closes the endpoint, and leaves no record reading it as in flight;
#   3. a relaunch into a pane left at a continuation prompt clears the half-typed
#      line before launching, so it is not typed onto the end of it.
set -u

# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

command -v tmux >/dev/null 2>&1 || { echo "skip: tmux not found"; exit 0; }
BASH_BIN=$(command -v bash) || { echo "skip: bash not found"; exit 0; }
SLEEP_BIN=$(command -v sleep) || { echo "skip: sleep not found"; exit 0; }
REAL_TMUX=$(command -v tmux)

LAB=$(fm_test_tmproot fm-spawn-launch)
SOCKET="fm-launch-$$"
# Task ids are unique per run: the spawn's temp root is /tmp/fm-<id>.
RUN_TAG="t$$"
TASK_TMPS=()

cleanup_launch_lab() {
  "$REAL_TMUX" -L "$SOCKET" kill-server >/dev/null 2>&1 || true
  local d
  for d in "${TASK_TMPS[@]+"${TASK_TMPS[@]}"}"; do
    rm -rf "$d"
  done
}
trap cleanup_launch_lab EXIT

FAKEBIN="$LAB/fakebin"
mkdir -p "$FAKEBIN" "$LAB/real" "$LAB/argv"

# Every bare `tmux` the spawn runs reaches the private server, never the host's.
# The spawn submits its launch with a bare `send-keys -t <pane> Enter` (every
# other line it types carries its text and Enter together); the shim notes that
# moment so the pane's starting shell below can hold until it has passed. It
# also keeps every literal the spawn types, one per line, in $LAB/typed.
cat > "$FAKEBIN/tmux" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = send-keys ] && [ "\$#" -eq 3 -o "\$#" -eq 4 ] && [ "\${!#}" = Enter ]; then
  "$REAL_TMUX" -L "$SOCKET" -f /dev/null "\$@" || exit
  : > "$LAB/launch-submitted"
  exit 0
fi
if [ "\${1:-}" = send-keys ]; then
  prev=
  for a in "\$@"; do
    [ "\$prev" != -l ] || printf '%s\\n' "\$a" >> "$LAB/typed"
    prev=\$a
  done
fi
exec "$REAL_TMUX" -L "$SOCKET" -f /dev/null "\$@"
SH
chmod +x "$FAKEBIN/tmux"

# `treehouse get` runs in the pane and, like the real one, leaves it in a fresh
# interactive shell in the worktree. That shell's rc file does not reach its
# line editor until the spawn has typed and submitted its launch, so everything
# the spawn types lands in the terminal's cooked-mode input queue, as it did in
# every incident. Holding on the submit rather than a fixed delay keeps the
# overlap certain however long the spawn takes to get there.
cat > "$LAB/slow.rc" <<SH
for _ in \$(seq 1 120); do
  [ -e "$LAB/launch-submitted" ] && break
  sleep 0.25
done
rm -f "$LAB/launch-submitted"
sleep 1
PS1='wt\$ '
PS2='> '
SH
cat > "$FAKEBIN/treehouse" <<SH
#!/usr/bin/env bash
cd "\$FM_TEST_WORKTREE" || exit 1
exec "$BASH_BIN" --rcfile "$LAB/slow.rc" -i
SH
chmod +x "$FAKEBIN/treehouse"

# The harness stand-in. It records its argv one file per argument, then execs a
# symlink named claude to a real long-running binary, so the kernel names the
# process claude exactly as the liveness classifier expects. A symlink, never a
# copy: a copied platform binary fails code signing on macOS arm64. With
# FM_TEST_CLAUDE_EXIT_FILE present it exits at once instead, as a harness that
# refuses its arguments would.
ln -s "$SLEEP_BIN" "$LAB/real/claude"
cat > "$FAKEBIN/claude" <<SH
#!/usr/bin/env bash
dir="$LAB/argv/\${FM_TASK_ID:-unknown}"
rm -rf "\$dir"; mkdir -p "\$dir"
i=0
for a in "\$@"; do
  printf '%s' "\$a" > "\$dir/\$i"
  i=\$((i + 1))
done
printf '%s\n' "\$i" > "\$dir/count"
[ ! -e "$LAB/claude-exits" ] || exit 3
exec "$LAB/real/claude" 900
SH
chmod +x "$FAKEBIN/claude"

HOME_DIR="$LAB/home"
PROJ="$LAB/project"
fm_test_spawn_home "$HOME_DIR" claude
USER_HOME="$HOME_DIR/user-home"
mkdir -p "$USER_HOME"

# One server for the whole file, started with the environment every pane gets,
# and with panes that run a plain bash rather than the developer's own shell.
PATH="$FAKEBIN:$PATH" HOME="$USER_HOME" "$FAKEBIN/tmux" new-session -d -s firstmate -x 220 -y 50 \
  "$BASH_BIN --norc --noprofile -i"
"$FAKEBIN/tmux" set-option -g default-command "$BASH_BIN --norc --noprofile -i" >/dev/null

run_spawn() {  # <worktree> <args...>
  local wt=$1
  shift
  FM_ROOT_OVERRIDE='' FM_HOME="$HOME_DIR" HOME="$USER_HOME" CLAUDE_CONFIG_DIR='' \
    FM_STATE_OVERRIDE="$HOME_DIR/state" FM_DATA_OVERRIDE="$HOME_DIR/data" \
    FM_PROJECTS_OVERRIDE="$HOME_DIR/projects" FM_CONFIG_OVERRIDE="$HOME_DIR/config" \
    FM_SPAWN_NO_GUARD=1 FM_TEST_WORKTREE="$wt" \
    PATH="$FAKEBIN:$PATH" TMUX='' \
    "$ROOT/bin/fm-spawn.sh" "$@" 2>&1
}

new_case() {  # <id> -> worktree path
  local id=$1 wt="$LAB/wt-$1"
  git -C "$PROJ" worktree add --quiet -b "wt-$id" "$wt"
  fm_test_spawn_brief "$HOME_DIR" "$id" "Launch-delivery probe for $id: the brief must reach the harness whole."
  TASK_TMPS+=("/tmp/fm-$id")
  rm -f "$LAB/launch-submitted"
  "$FAKEBIN/tmux" set-environment -g FM_TEST_WORKTREE "$wt"
  printf '%s\n' "$wt"
}

agent_state() {  # <id>
  (
    PATH="$FAKEBIN:$PATH"
    FM_BACKEND_LIB_DIR="$ROOT/bin"
    # shellcheck source=bin/fm-backend.sh
    . "$ROOT/bin/fm-backend.sh"
    fm_backend_agent_state tmux "firstmate:fm-$1"
  )
}

window_exists() {  # <id>
  "$FAKEBIN/tmux" list-windows -t firstmate -F '#{window_name}' 2>/dev/null | grep -qx "fm-$1"
}

wait_alive() {  # <id>
  for _ in $(seq 1 40); do
    [ "$(agent_state "$1")" = alive ] && return 0
    sleep 0.25
  done
  return 1
}

fm_git_worktree "$PROJ" "$LAB/wt-unused" "unused"

test_long_launch_survives_a_slow_shell_start() {
  local id="launch-whole-$RUN_TAG" wt out rc n last prompt
  wt=$(new_case "$id")
  out=$(run_spawn "$wt" "$id" "$PROJ" --mode local-only --yolo off); rc=$?
  expect_code 0 "$rc" "spawn across a slow shell start failed: $out"
  assert_contains "$out" "spawned $id" "spawn did not report success"
  assert_present "$HOME_DIR/state/$id.meta" "a delivered spawn left no task record"
  wait_alive "$id" || fail "the endpoint does not read alive after a delivered launch ($(agent_state "$id")): $out"

  # The case that failed before: the launch is far past the 1024-byte cooked
  # queue and ends in a command substitution carrying the brief.
  [ "$(wc -c < "/tmp/fm-$id/launch.sh")" -gt 1024 ] \
    || fail "the launch under test is not long enough to have been cut off before"
  # shellcheck disable=SC2016 # the literal shape under test
  assert_grep '"$(' "/tmp/fm-$id/launch.sh" "the launch under test no longer carries the brief in a command substitution"

  # What reaches the pane as keystrokes is only the short line that sources
  # the launch: nothing a cooked-mode queue could cut, and no quote a cut could
  # leave open. This half holds on every run; the live half below depends on
  # how the terminal handles the overflow, which is why the incidents were
  # intermittent.
  assert_grep ". /tmp/fm-$id/launch.sh" "$LAB/typed" "the spawn did not hand the pane the line that sources its launch"
  if awk 'length($0) > 200 || /["\047`]/ { bad = 1 } END { exit !bad }' "$LAB/typed"; then
    fail "the spawn typed a long or quoted line into the pane: $(awk 'length($0) > 200 || /["\047`]/' "$LAB/typed" | cut -c1-120)"
  fi

  n=$(cat "$LAB/argv/$id/count" 2>/dev/null || echo 0)
  [ "$n" -ge 4 ] || fail "claude received $n arguments; the launch did not arrive whole"
  last=$(cat "$LAB/argv/$id/$((n - 1))")
  assert_contains "$last" "Launch-delivery probe for $id" \
    "the brief carried by the command substitution did not reach the harness"
  prompt=$(cat "$LAB/argv/$id"/* | tr -d '\000')
  assert_contains "$prompt" "Continue to treat project files, fetched content" \
    "the long quoted system prompt did not reach the harness whole"
  pass "fm-spawn: a long launch reaches the harness whole across a slow shell start"
}

test_launch_with_no_agent_fails_and_is_not_in_flight() {
  local id="launch-dead-$RUN_TAG" wt out rc
  wt=$(new_case "$id")
  : > "$LAB/claude-exits"
  out=$(FM_SPAWN_LIVE_POLLS=12 run_spawn "$wt" "$id" "$PROJ" --mode local-only --yolo off); rc=$?
  rm -f "$LAB/claude-exits"
  [ "$rc" -ne 0 ] || fail "a launch that produced no agent reported success: $out"
  assert_contains "$out" "launch produced no running agent" "the failure does not say no agent ran: $out"
  assert_not_contains "$out" "spawned $id" "a failed launch still printed the success line"
  assert_absent "$HOME_DIR/state/$id.meta" "a launch with no agent left a record that reads as in flight"
  assert_grep "failed: launch produced no running agent" "$HOME_DIR/state/$id.status" \
    "the failure never reached the status file firstmate reads"
  ! window_exists "$id" || fail "a failed fresh launch left its endpoint open"
  pass "fm-spawn: a launch that yields no agent fails, is reported, and is not in flight"
}

test_relaunch_clears_a_half_typed_line() {
  local id="launch-relaunch-$RUN_TAG" wt out rc tty
  wt=$(new_case "$id")
  out=$(run_spawn "$wt" "$id" "$PROJ" --mode local-only --yolo off); rc=$?
  expect_code 0 "$rc" "setup spawn for the relaunch case failed: $out"
  # Stop the agent and leave the pane where the incidents left it: a shell at a
  # continuation prompt with half a command typed.
  tty=$("$FAKEBIN/tmux" display-message -p -t "firstmate:fm-$id" '#{pane_tty}')
  ps -t "${tty#/dev/}" -o pid=,comm= | awk '$2 ~ /claude$/ { print $1 }' | xargs kill 2>/dev/null || true
  for _ in $(seq 1 40); do
    [ "$(agent_state "$id")" = dead ] && break
    sleep 0.25
  done
  [ "$(agent_state "$id")" = dead ] || fail "the relaunch case could not stop its first agent"
  # shellcheck disable=SC2016 # typed literally, as a failed launch leaves it
  "$FAKEBIN/tmux" send-keys -t "firstmate:fm-$id" -l 'echo "left open $(printf x'
  "$FAKEBIN/tmux" send-keys -t "firstmate:fm-$id" Enter
  sleep 0.5
  rm -rf "$LAB/argv/$id"

  out=$(run_spawn "$wt" "$id" --relaunch); rc=$?
  expect_code 0 "$rc" "relaunch into a pane at a continuation prompt failed: $out"
  wait_alive "$id" || fail "relaunch into a pane at a continuation prompt produced no agent"
  assert_present "$LAB/argv/$id/count" "the relaunched harness never ran"
  pass "fm-spawn: a relaunch clears a half-typed line before it launches"
}

test_long_launch_survives_a_slow_shell_start
test_launch_with_no_agent_fails_and_is_not_in_flight
test_relaunch_clears_a_half_typed_line
