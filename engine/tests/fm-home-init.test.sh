#!/usr/bin/env bash
# Tests for bin/fm-home-init.sh: a home that mirrors a read-only copy of
# firstmate outside git, created from nothing and refreshed on every launch.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-home-init)
mkdir -p "$TMP_ROOT"
# The copies are made read-only; make them removable again on the way out.
trap 'chmod -R u+w "$TMP_ROOT" 2>/dev/null; rm -rf "$TMP_ROOT"' EXIT

# code_copy <dir>: this checkout's code as an installed copy - tracked and new
# files, no .git, nothing .gitignore keeps out.
code_copy() {
  local dir=$1
  mkdir -p "$dir"
  (cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$dir" \
    || fail "could not copy the code to $dir"
}

init() {  # <code-dir> <home> [args...]
  local code=$1 home=$2
  shift 2
  FM_HOME="$home" "$code/bin/fm-home-init.sh" "$@"
}

CODE="$TMP_ROOT/app/firstmate"
code_copy "$CODE"
chmod -R a-w "$CODE"
CODE=$(cd "$CODE" && pwd -P)

test_fresh_home_mirrors_the_code() {
  local home="$TMP_ROOT/fresh" out status=0
  out=$(init "$CODE" "$home" 2>&1) || status=$?
  expect_code 0 "$status" "a fresh home: $out"
  home=$(cd "$home" && pwd -P)
  assert_contains "$out" "home: $home" "the home is named"
  assert_contains "$out" "code: $CODE" "the code is named"
  assert_contains "$out" "linked: bin" "bin is linked"
  [ "$(printf '%s\n' "$out" | tail -1)" = ok ] || fail "the last line must be ok: $out"
  for name in bin docs AGENTS.md CLAUDE.md .agents .tasks.toml; do
    [ -L "$home/$name" ] || fail "$name must be a link in the home"
    [ "$(readlink "$home/$name")" = "$CODE/$name" ] || fail "$name must link to the code's $name"
  done
  for dir in data state config projects .claude; do
    [ -d "$home/$dir" ] && [ ! -L "$home/$dir" ] || fail "$dir must be a real directory in the home"
  done
  [ "$(readlink "$home/.claude/settings.json")" = "$CODE/.claude/settings.json" ] \
    || fail ".claude/settings.json must link to the code's"
  [ -e "$home/.claude/skills/captain-hold-lifecycle/SKILL.md" ] || fail "the skills must resolve through the home"
  [ ! -e "$home/.git" ] || fail "the home must not carry git"
  pass "a fresh home links the code's entries and keeps its own directories real"
}

test_second_run_changes_nothing() {
  local home="$TMP_ROOT/again" out
  init "$CODE" "$home" >/dev/null 2>&1 || fail "first run failed"
  out=$(init "$CODE" "$home" 2>&1) || fail "second run failed: $out"
  [ "$(printf '%s\n' "$out" | grep -c '^\(linked\|relinked\|unlinked\|kept\):')" = 0 ] \
    || fail "a second run must change nothing: $out"
  pass "a second run on the same code changes nothing"
}

test_moved_and_updated_code_is_followed() {
  local home="$TMP_ROOT/moved" moved="$TMP_ROOT/app2/firstmate" out
  code_copy "$moved"
  # The update dropped an entry and added one.
  rm -f "$moved/VISION.md"
  printf 'new\n' > "$moved/NEW.md"
  chmod -R a-w "$moved"
  moved=$(cd "$moved" && pwd -P)
  init "$CODE" "$home" >/dev/null 2>&1 || fail "first run failed"
  out=$(init "$moved" "$home" 2>&1) || fail "the run after the move failed: $out"
  assert_contains "$out" "relinked: bin" "a moved code relinks bin"
  assert_contains "$out" "relinked: .claude/settings.json" "and the harness settings"
  assert_contains "$out" "linked: NEW.md" "an entry the update added is linked"
  assert_contains "$out" "unlinked: VISION.md" "an entry the update dropped is unlinked"
  [ "$(readlink "$home/bin")" = "$moved/bin" ] || fail "bin must follow the moved code"
  [ ! -L "$home/VISION.md" ] || fail "the dropped entry's link must be gone"
  pass "a moved or updated code is followed, entries added and dropped"
}

test_the_homes_own_files_are_kept() {
  local home="$TMP_ROOT/own" out
  mkdir -p "$home/.claude"
  printf 'mine\n' > "$home/README.md"
  printf '{}\n' > "$home/.claude/settings.local.json"
  ln -s /nonexistent/elsewhere "$home/my-link"
  # A home that keeps its data in another firstmate checkout's data/.
  mkdir -p "$TMP_ROOT/other-checkout/bin" "$TMP_ROOT/other-checkout/data"
  : > "$TMP_ROOT/other-checkout/AGENTS.md"
  ln -s "$TMP_ROOT/other-checkout/data" "$home/data"
  out=$(init "$CODE" "$home" 2>&1) || fail "init failed: $out"
  assert_contains "$out" "kept: README.md" "a real file where the code has an entry is kept"
  [ "$(cat "$home/README.md")" = mine ] || fail "the home's own README.md was replaced"
  [ -f "$home/.claude/settings.local.json" ] && [ ! -L "$home/.claude/settings.local.json" ] \
    || fail "the harness's local settings must stay the home's"
  [ -L "$home/my-link" ] || fail "a link the script did not make must be left alone"
  [ "$(readlink "$home/data")" = "$TMP_ROOT/other-checkout/data" ] || fail "a home-owned data link must be left alone"
  pass "the home's own files, local settings, and links stay the home's"
}

test_refusals_change_nothing() {
  local out status checkout="$TMP_ROOT/checkout" file="$TMP_ROOT/a-file"
  status=0; out=$(init "$CODE" "$CODE" 2>&1) || status=$?
  expect_code 1 "$status" "the code as its own home"
  assert_contains "$out" "is, or lies inside, the code" "the code as home is named"
  status=0; out=$(init "$CODE" "$CODE/bin" 2>&1) || status=$?
  expect_code 1 "$status" "a home inside the code"
  status=0; out=$(init "$CODE" "$TMP_ROOT/app" 2>&1) || status=$?
  expect_code 1 "$status" "a home containing the code"
  assert_contains "$out" "lies inside the home" "a home containing the code is named"
  mkdir -p "$checkout/bin"
  git init -q "$checkout"
  status=0; out=$(init "$CODE" "$checkout" 2>&1) || status=$?
  expect_code 1 "$status" "a firstmate checkout as home"
  assert_contains "$out" "git checkout of firstmate" "a checkout is named"
  [ ! -e "$checkout/AGENTS.md" ] || fail "a refused checkout must be left as it was"
  : > "$file"
  status=0; out=$(init "$CODE" "$file" 2>&1) || status=$?
  expect_code 1 "$status" "a file as home"
  status=0; out=$(env -u FM_HOME "$CODE/bin/fm-home-init.sh" 2>&1) || status=$?
  expect_code 2 "$status" "no home named"
  pass "a home that is, holds, or sits in the code, a checkout, or a file is refused"
}

test_home_owned_names_match_gitignore() {
  local owned line name
  owned=$(sed -n "s/^HOME_OWNED='\(.*\)'$/\1/p" "$ROOT/bin/fm-home-init.sh")
  [ -n "$owned" ] || fail "could not read HOME_OWNED from fm-home-init.sh"
  while IFS= read -r line; do
    case "$line" in ''|'#'*|*'*'*) continue ;; esac
    name=${line%/}
    name=${name#/}
    case "$name" in */*) continue ;; esac
    case " $owned " in
      *" $name "*) ;;
      *) fail "$name is kept out of the code by .gitignore but fm-home-init.sh would link it" ;;
    esac
  done < "$ROOT/.gitignore"
  pass "every top-level path .gitignore keeps out of the code belongs to the home"
}

test_fresh_home_mirrors_the_code
test_second_run_changes_nothing
test_moved_and_updated_code_is_followed
test_the_homes_own_files_are_kept
test_refusals_change_nothing
test_home_owned_names_match_gitignore
