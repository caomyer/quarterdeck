#!/usr/bin/env bash
# Behavior tests for tests/lib.sh's shared fixture-tempdir helper
# (fm_test_tmproot / fm_test_cleanup / fm_test_reap_orphans).
#
# The near-universal call pattern across this suite is
# `TMP_ROOT=$(fm_test_tmproot prefix)`, which forks a subshell to capture the
# function's stdout. These tests spawn real, separate bash processes that use
# that exact pattern and assert the fixture root is actually gone once the
# owning process's guarded teardown has run - on a normal exit and on a
# terminating signal - plus that a stale marked fixture from a killed prior
# run gets reaped on the next source. Nothing here inspects tests/lib.sh's
# source text; it only observes filesystem state around the real helper.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LIB="$ROOT/tests/lib.sh"

test_fixture_root_gone_after_normal_exit() {
  local child_out child_dir
  child_out=$(bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
    d=$(fm_test_tmproot fm-test-cleanup-exit)
    printf "%s\n" "$d"
    if [ -d "$d" ]; then printf "mid:present\n"; else printf "mid:missing\n"; fi
  ')
  child_dir=$(printf '%s\n' "$child_out" | sed -n '1p')
  assert_contains "$child_out" "mid:present" \
    "the fixture root was not present while its owning process was still alive"
  assert_absent "$child_dir" \
    "fm_test_tmproot's fixture root survived its owning process's normal exit"
  pass "fm_test_tmproot cleans up its fixture root on normal exit"
}

test_fixture_root_gone_after_sigterm() {
  local harness dirfile child_dir pid tries
  harness=$(fm_test_tmproot fm-test-cleanup-sigterm-harness)
  dirfile="$harness/child-dir"
  bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
    d=$(fm_test_tmproot fm-test-cleanup-term)
    printf "%s\n" "$d" > "'"$dirfile"'"
    while :; do sleep 0.1; done
  ' &
  pid=$!
  tries=0
  while [ "$tries" -lt 100 ]; do
    [ -s "$dirfile" ] && break
    sleep 0.05
    tries=$((tries + 1))
  done
  [ -s "$dirfile" ] || fail "the child never published its fixture root before the wait timed out"
  child_dir=$(cat "$dirfile")
  assert_present "$child_dir" "the child's fixture root did not exist before it was signaled"
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null
  assert_absent "$child_dir" \
    "fm_test_tmproot's fixture root survived SIGTERM to its owning process"
  pass "fm_test_tmproot cleans up its fixture root on SIGTERM"
}

test_cleanup_registry_resists_precreation() {
  local harness shared_tmp victim
  harness=$(fm_test_tmproot fm-test-cleanup-registry-harness)
  shared_tmp="$harness/shared-tmp"
  victim="$harness/victim"
  mkdir -p "$shared_tmp" "$victim"

  TMPDIR="$shared_tmp" bash -c '
    printf "%s\n" "$1" > "$TMPDIR/.fm-test-cleanup.$$"
    . "$2"
  ' _ "$victim" "$LIB"

  assert_present "$victim" \
    "a precreated predictable cleanup registry injected an arbitrary deletion target"
  pass "the cleanup registry cannot be injected through path precreation"
}

test_fixture_registration_failure_rolls_back_root() {
  local harness failure_tmp registry_dir output leaked_root
  harness=$(fm_test_tmproot fm-test-cleanup-registration-harness)
  failure_tmp="$harness/tmp"
  registry_dir="$harness/registry-dir"
  mkdir -p "$failure_tmp" "$registry_dir"

  if output=$(TMPDIR="$failure_tmp" FM_TEST_CLEANUP_REGISTRY="$registry_dir" \
    fm_test_tmproot fm-test-cleanup-registration-failure 2>/dev/null); then
    fail "fm_test_tmproot succeeded after its cleanup registry rejected registration"
  fi
  [ -z "$output" ] || fail "fm_test_tmproot published an unregistered fixture root"
  for leaked_root in "$failure_tmp"/fm-test-cleanup-registration-failure.*; do
    [ ! -e "$leaked_root" ] || fail "fm_test_tmproot leaked a root after registration failed"
  done
  pass "failed fixture registration rolls back the new root"
}

test_orphan_sweep_respects_fixture_ownership() {
  local harness dirfile active_dir stale_dir fresh_dir pid tries
  harness=$(fm_test_tmproot fm-test-cleanup-orphan-harness)
  dirfile="$harness/active-dir"
  bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
    d=$(fm_test_tmproot fm-test-cleanup-active)
    printf "%s\n" "$d" > "'"$dirfile"'"
    while :; do sleep 0.1; done
  ' &
  pid=$!
  tries=0
  while [ "$tries" -lt 100 ]; do
    [ -s "$dirfile" ] && break
    sleep 0.05
    tries=$((tries + 1))
  done
  [ -s "$dirfile" ] || fail "the active child never published its fixture root before the wait timed out"
  active_dir=$(cat "$dirfile")
  touch -t 202001010000 "$active_dir/.fm-test-fixture"

  stale_dir=$(mktemp -d "${TMPDIR:-/tmp}/fm-test-cleanup-stale.XXXXXX")
  printf '%s\n%s\n' "$$" reused-process-identity > "$stale_dir/.fm-test-fixture"
  touch -t 202001010000 "$stale_dir/.fm-test-fixture"
  fresh_dir=$(mktemp -d "${TMPDIR:-/tmp}/fm-test-cleanup-fresh.XXXXXX")
  : > "$fresh_dir/.fm-test-fixture"

  bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
  '

  assert_absent "$stale_dir" \
    "a stale fixture root whose PID was reused by another process was not reaped"
  assert_present "$active_dir" \
    "the orphan reaper removed an old fixture root whose owning process was still alive"
  assert_present "$fresh_dir" \
    "the orphan reaper removed a fresh marked fixture root it does not own yet"
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null
  assert_absent "$active_dir" \
    "the active fixture root survived its owning process's teardown"
  rm -rf "$fresh_dir"
  pass "the orphan sweep reaps only old fixtures without a live owner"
}

test_cleanup_reaps_orphans_and_spares_bystanders() {
  local harness dirfile child_dir tries watcher orphan orphan_child own_dir dead
  harness=$(fm_test_tmproot fm-test-reap-harness)
  dirfile="$harness/child-dir"
  # The fixture prefix carries a regex quantifier on purpose: a path matched as
  # a pattern instead of a literal string would find nothing here.
  bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
    set -m
    d=$(fm_test_tmproot "fm-test-reap+case")
    cat > "$d/worker.sh" <<SH
while :; do sleep 1; done
SH
    cat > "$d/worker-parent.sh" <<SH
bash "$d/worker.sh" &
while :; do sleep 1; done
SH
    # Orphaned the way a detached stage leaves its worker: the shell that
    # started it exits, and it leads a process group holding a child of its own.
    ( bash "$d/worker-parent.sh" & )
    sleep 1
    printf "%s\n" "$d" > "'"$dirfile"'"
    sleep 1
  ' || fail "the child harness failed"
  [ -s "$dirfile" ] || fail "the child never published its fixture root"
  child_dir=$(cat "$dirfile")
  tries=0
  while [ "$tries" -lt 50 ]; do
    # shellcheck disable=SC2009 # the fixture path must match literally, not as a pattern.
    ps -axo pid=,command= | grep -F -- "$child_dir" | grep -qv grep || break
    tries=$((tries + 1))
    sleep 0.2
  done
  # shellcheck disable=SC2009 # the fixture path must match literally, not as a pattern.
  orphan=$(ps -axo pid=,command= | grep -F -- "$child_dir/worker-parent.sh" | grep -v grep || true)
  # shellcheck disable=SC2009 # the fixture path must match literally, not as a pattern.
  orphan_child=$(ps -axo pid=,command= | grep -F -- "$child_dir/worker.sh" | grep -v grep || true)
  [ -z "$orphan" ] || fail "an orphaned worker outlived its fixture: $orphan"
  [ -z "$orphan_child" ] || fail "an orphaned worker's own child outlived its fixture: $orphan_child"
  assert_absent "$child_dir" "the fixture root survived its owning process"

  # A process with a live parent of its own, here the suite's, is not the
  # fixture's to stop.
  own_dir=$(fm_test_tmproot fm-test-reap-bystander)
  : > "$own_dir/watch.log"
  tail -f "$own_dir/watch.log" >/dev/null 2>&1 &
  watcher=$!
  sleep 0.3
  fm_test_reap_fixture_processes "$own_dir"
  kill -0 "$watcher" 2>/dev/null || fail "a process the fixture did not orphan was stopped"
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null || true

  # The rule itself: a parent that is gone, or init, leaves nothing to stop the
  # process; a live parent means something does.
  sh -c 'exit 0' & dead=$!
  wait "$dead"
  fm_test_pid_is_loose 1 || fail "a process whose parent is init must count as loose"
  fm_test_pid_is_loose "$dead" || fail "a process whose parent is gone must count as loose"
  ! fm_test_pid_is_loose "$$" || fail "a process with a live parent must not count as loose"
  ! fm_test_pid_is_loose "" || fail "a process with no parent recorded must not count as loose"
  pass "cleanup reaps a fixture's orphans and their groups, and spares everything with a parent of its own"
}

test_orphan_sweep_unlinks_a_stale_link_without_following_it() {
  local keep link
  # A stale fixture-shaped symlink in TMPDIR, pointing at a directory that is
  # not a fixture's to remove. The sweep must unlink it and leave the target.
  # Named outside the sweep's own fm-* glob: only the link is its business.
  keep=$(mktemp -d "${TMPDIR:-/tmp}/sweep-target.XXXXXX")
  printf 'important\n' > "$keep/important.txt"
  printf '%s\n%s\n' 999999 gone-identity > "$keep/.fm-test-fixture"
  touch -t 202001010000 "$keep/.fm-test-fixture"
  link="${TMPDIR:-/tmp}/fm-test-sweep-link.$$"
  ln -s "$keep" "$link"
  bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
  '
  [ -L "$link" ] && fail "the sweep left a stale fixture link in place"
  assert_present "$keep/important.txt" "the sweep removed what a stale link pointed at"
  rm -rf "$link" "$keep"
  pass "the sweep unlinks a stale fixture link without following it"
}

test_orphan_sweep_reaps_a_killed_runs_processes() {
  local harness dirfile child_dir pid tries worker
  harness=$(fm_test_tmproot fm-test-kill-harness)
  dirfile="$harness/child-dir"
  # A suite killed outright, as bin/fm-test-run.sh kills one that passes its
  # per-script bound: no trap runs, so its detached worker outlives it.
  # A trailing slash on TMPDIR, which is what exposed the sweep matching its
  # roots by the glob's path rather than the physical one.
  TMPDIR="${TMPDIR%/}/" bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
    set -m
    d=$(fm_test_tmproot fm-test-killed-run)
    cat > "$d/worker.sh" <<SH
while :; do sleep 1; done
SH
    ( bash "$d/worker.sh" & )
    printf "%s\n" "$d" > "'"$dirfile"'"
    while :; do sleep 0.1; done
  ' &
  pid=$!
  tries=0
  while [ "$tries" -lt 100 ]; do
    [ -s "$dirfile" ] && break
    sleep 0.05
    tries=$((tries + 1))
  done
  [ -s "$dirfile" ] || fail "the child never published its fixture root before the wait timed out"
  child_dir=$(cat "$dirfile")
  kill -KILL "$pid"
  wait "$pid" 2>/dev/null || true
  # shellcheck disable=SC2009 # the fixture path must match literally, not as a pattern.
  worker=$(ps -axo pid=,command= | grep -F -- "$child_dir/worker.sh" | grep -v grep || true)
  [ -n "$worker" ] || fail "the fixture's worker did not outlive the killed run, so this proves nothing"
  touch -t 202001010000 "$child_dir/.fm-test-fixture"

  # The next run's sweep is the only thing that sees it.
  TMPDIR="${TMPDIR%/}/" bash -c '
    # shellcheck source=tests/lib.sh
    . "'"$LIB"'"
  '

  assert_absent "$child_dir" "the killed run's fixture root was not swept"
  # shellcheck disable=SC2009 # the fixture path must match literally, not as a pattern.
  worker=$(ps -axo pid=,command= | grep -F -- "$child_dir/worker.sh" | grep -v grep || true)
  [ -z "$worker" ] || fail "the killed run's worker was left spinning on a path that is gone: $worker"
  pass "the stale-fixture sweep stops a killed run's processes before removing its files"
}

test_orphan_sweep_reaps_read_only_package_tree() {
  local stale_dir package_dir
  stale_dir=$(mktemp -d "${TMPDIR:-/tmp}/fm-test-cleanup-read-only.XXXXXX")
  package_dir="$stale_dir/packages/extension"
  mkdir -p "$package_dir"
  printf '%s\n%s\n' "$$" reused-process-identity > "$stale_dir/.fm-test-fixture"
  printf 'installed package\n' > "$package_dir/entrypoint.py"
  chmod -R a-w "$stale_dir/packages"
  touch -t 202001010000 "$stale_dir/.fm-test-fixture"

  bash -c '
    # shellcheck source=tests/lib.sh
    . "$1"
  ' _ "$LIB"

  assert_absent "$stale_dir" \
    "the orphan reaper left a stale fixture containing a read-only package tree"
  pass "the orphan sweep reaps read-only package fixtures"
}

test_fixture_root_gone_after_normal_exit
test_fixture_root_gone_after_sigterm
test_cleanup_registry_resists_precreation
test_fixture_registration_failure_rolls_back_root
test_orphan_sweep_respects_fixture_ownership
test_cleanup_reaps_orphans_and_spares_bystanders
test_orphan_sweep_reaps_read_only_package_tree
test_orphan_sweep_reaps_a_killed_runs_processes
test_orphan_sweep_unlinks_a_stale_link_without_following_it
