#!/usr/bin/env bash
# Behavior tests for bin/fm-project-intake.sh.
# Covers registering a captain's local checkout: the fleet name never matches
# the checkout's own directory name (Treehouse would share one worktree pool
# between them), a taken name moves on, and the captain notice reports the
# uncommitted, untracked, and unpushed work the fleet copy will not have.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }

INTAKE="$ROOT/bin/fm-project-intake.sh"
TMP_ROOT=$(fm_test_tmproot fm-project-intake)

# A captain checkout at <dir>/Resonance with an origin it has pushed to.
make_checkout() {  # <label>
  local base="$TMP_ROOT/$1" src
  src="$base/captain/Resonance"
  git init -q --bare "$base/origin.git" || fail "could not create the origin"
  git init -q "$src" || fail "could not create the checkout"
  git -C "$src" remote add origin "$base/origin.git"
  printf 'one\n' > "$src/a.txt"
  git -C "$src" add a.txt
  git -C "$src" -c user.name=t -c user.email=t@example.com commit -q -m one || fail "commit failed"
  git -C "$src" push -q origin HEAD 2>/dev/null || fail "push failed"
  mkdir -p "$base/home/projects" "$base/home/data"
  printf '%s\n' "$base"
}

test_a_clean_checkout_gets_a_distinct_name() {
  local base out json
  base=$(make_checkout clean)
  out=$(FM_HOME="$base/home" "$INTAKE" local "$base/captain/Resonance/") || fail "intake failed: $out"
  assert_contains "$out" "name: Resonance-fm" "the fleet name differs from the checkout's directory name"
  assert_contains "$out" "uncommitted: 0" "a clean checkout has no uncommitted changes"
  assert_contains "$out" "so that copy starts from the same code you have" "the notice says nothing is left behind"

  json=$(FM_HOME="$base/home" "$INTAKE" local "$base/captain/Resonance" --name resonance --json) || fail "intake --json failed"
  assert_equals "fm-project-intake-local.v1|resonance-fm|$base/origin.git" \
    "$(printf '%s' "$json" | jq -r '[.schema, .name, .origin] | join("|")')" \
    "a proposed name that matches the checkout's name only in case still moves"

  mkdir -p "$base/home/projects/Resonance-fm"
  printf -- '- resonance-fm-2 [direct-PR] - older copy (added 2026-09-01)\n' > "$base/home/data/projects.md"
  out=$(FM_HOME="$base/home" "$INTAKE" local "$base/captain/Resonance")
  assert_contains "$out" "name: Resonance-fm-3" "a name taken in projects/ or the registry moves on"
  out=$(FM_HOME="$base/home" "$INTAKE" local "$base/captain/Resonance" --name speech)
  assert_contains "$out" "name: speech" "a distinct free name is kept as proposed"
  pass "fm-project-intake.sh: the fleet name never shares the checkout's worktree pool"
}

test_the_notice_names_what_the_copy_will_not_have() {
  local base src out rc
  base=$(make_checkout dirty)
  src="$base/captain/Resonance"
  printf 'two\n' >> "$src/a.txt"
  printf 'draft\n' > "$src/notes.md"
  printf 'draft\n' > "$src/todo.md"
  git -C "$src" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m local || fail "commit failed"
  out=$(FM_HOME="$base/home" "$INTAKE" local "$src") || fail "intake failed: $out"
  assert_contains "$out" "uncommitted: 1" "the changed tracked file is counted"
  assert_contains "$out" "untracked: 2" "the untracked files are counted"
  assert_contains "$out" "unpushed: 1" "the local commit is counted"
  assert_contains "$out" "your folder has 1 uncommitted change, 2 untracked files, and 1 commit not pushed to origin, which that copy will not have unless you commit and push them." \
    "the notice names everything left behind"
  assert_equals "3" "$(git -C "$src" status --porcelain | wc -l | tr -d ' ')" "intake left the captain's checkout as it was"

  # The ceiling keeps git from finding a repository above the temp root.
  out=$(GIT_CEILING_DIRECTORIES="$TMP_ROOT" FM_HOME="$base/home" "$INTAKE" local "$base/home" 2>&1); rc=$?
  expect_code 1 "$rc" "a directory outside any checkout is refused"
  out=$(FM_HOME="$base/home" "$INTAKE" local "$src" --name '../x' 2>&1); rc=$?
  expect_code 1 "$rc" "an unusable name is refused"
  pass "fm-project-intake.sh: the notice names the work the fleet copy will not have"
}

test_a_clean_checkout_gets_a_distinct_name
test_the_notice_names_what_the_copy_will_not_have
