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

changes() {  # <output>: the lines that report a change
  printf '%s\n' "$1" | grep -E '^(linked|relinked|unlinked|kept):' || true
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
  grep -qx "code=$CODE" "$home/.fm-home" || fail "the marker must name the code"
  [ ! -e "$home/.fm-home-init.lock" ] || fail "the lock must be released"
  pass "a fresh home links the code's entries, keeps its own directories real, and is marked"
}

test_second_run_changes_nothing() {
  local home="$TMP_ROOT/again" out
  init "$CODE" "$home" >/dev/null 2>&1 || fail "first run failed"
  out=$(init "$CODE" "$home" 2>&1) || fail "second run failed: $out"
  [ -z "$(changes "$out")" ] || fail "a second run must change nothing: $out"
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
  grep -qx "code=$moved" "$home/.fm-home" || fail "the marker must name the moved code"
  pass "a moved or updated code is followed, entries added and dropped"
}

test_the_homes_own_files_and_links_are_never_changed() {
  local home="$TMP_ROOT/own" mine="$TMP_ROOT/mine" out
  init "$CODE" "$home" >/dev/null 2>&1 || fail "first run failed"
  mkdir -p "$mine/skills" "$TMP_ROOT/other-checkout/bin" "$TMP_ROOT/other-checkout/data"
  : > "$TMP_ROOT/other-checkout/AGENTS.md"
  printf 'mine\n' > "$mine/README.md"
  printf '{}\n' > "$mine/settings.json"
  rm -f "$home/README.md" "$home/docs" "$home/.claude/settings.json"
  printf 'mine\n' > "$home/README.md"
  ln -s "$mine/skills" "$home/docs"
  ln -s "$mine/settings.json" "$home/.claude/settings.json"
  printf '{}\n' > "$home/.claude/settings.local.json"
  # Links that dangle: an unmounted drive, and one named like its target.
  ln -s /Volumes/NotMounted/work "$home/work"
  ln -s /Volumes/Dotfiles/cmds/commands "$home/.claude/commands"
  # A home that keeps its data in another firstmate checkout's data/.
  rmdir "$home/data"
  ln -s "$TMP_ROOT/other-checkout/data" "$home/data"
  out=$(init "$CODE" "$home" 2>&1) || fail "init failed: $out"
  assert_contains "$out" "kept: README.md" "a real file where the code has an entry is kept"
  assert_contains "$out" "kept: docs (the home's own link" "a link of the home's own on a code name is kept"
  assert_contains "$out" "kept: .claude/settings.json (the home's own link" "custom harness settings are kept"
  [ "$(cat "$home/README.md")" = mine ] || fail "the home's own README.md was replaced"
  [ "$(readlink "$home/docs")" = "$mine/skills" ] || fail "the home's own docs link was repointed"
  [ "$(readlink "$home/.claude/settings.json")" = "$mine/settings.json" ] || fail "custom harness settings were repointed"
  [ -f "$home/.claude/settings.local.json" ] && [ ! -L "$home/.claude/settings.local.json" ] \
    || fail "the harness's local settings must stay the home's"
  [ -L "$home/work" ] && [ -L "$home/.claude/commands" ] || fail "the home's dangling links must be left alone"
  [ "$(readlink "$home/data")" = "$TMP_ROOT/other-checkout/data" ] || fail "a home-owned data link must be left alone"
  pass "the home's own files, links, dangling links, and settings are never changed"
}

test_concurrent_runs_take_turns() {
  local writable="$TMP_ROOT/writable/firstmate" i pids='' pid failed=0 home
  code_copy "$writable"
  writable=$(cd "$writable" && pwd -P)
  for i in 1 2 3 4 5 6; do
    home="$TMP_ROOT/race"
    init "$writable" "$home" >"$TMP_ROOT/race-$i.out" 2>&1 &
    pids="$pids $!"
  done
  for pid in $pids; do
    wait "$pid" || failed=$((failed + 1))
  done
  [ "$failed" = 0 ] || fail "concurrent runs failed: $(cat "$TMP_ROOT"/race-*.out)"
  [ ! -e "$writable/bin/bin" ] && [ ! -e "$writable/docs/docs" ] \
    || fail "a concurrent run linked into the code"
  [ -z "$(find "$writable" -type l -newer "$writable/AGENTS.md" -print -quit)" ] \
    || fail "a concurrent run left links inside the code"
  [ "$(readlink "$TMP_ROOT/race/bin")" = "$writable/bin" ] || fail "the raced home is not laid out"
  pass "concurrent runs on one home take turns and never write into the code"
}

test_paths_are_resolved_safely() {
  local out work="$TMP_ROOT/cwd" elsewhere="$TMP_ROOT/elsewhere"
  mkdir -p "$work" "$elsewhere/rel-home"
  # A relative home with CDPATH pointing somewhere that has the same name.
  out=$(cd "$work" && CDPATH="$elsewhere" FM_HOME='' "$CODE/bin/fm-home-init.sh" --home rel-home 2>&1) \
    || fail "a relative home failed: $out"
  [ "$(printf '%s\n' "$out" | grep -c '^home: ')" = 1 ] || fail "the home must be named once: $out"
  work=$(cd "$work" && pwd -P)
  assert_contains "$out" "home: $work/rel-home" "a relative home resolves from the working directory"
  [ -L "$work/rel-home/bin" ] || fail "the relative home was not laid out"
  [ ! -e "$elsewhere/rel-home/bin" ] || fail "CDPATH redirected the home"
  # A home whose name starts with a dash, and the --home= form.
  out=$(cd "$work" && FM_HOME='' "$CODE/bin/fm-home-init.sh" --home=-dash-home 2>&1) || fail "a dash home failed: $out"
  [ -L "$work/-dash-home/bin" ] || fail "a home starting with a dash was not laid out"
  # Reached through the home's own bin/ link, the code is still the real copy.
  out=$("$work/rel-home/bin/fm-home-init.sh" --home "$work/rel-home" 2>&1) || fail "running through the home's link failed: $out"
  assert_contains "$out" "code: $CODE" "the code is found through the home's bin link"
  [ -z "$(changes "$out")" ] || fail "running through the home's link must change nothing: $out"
  pass "relative, dash-led, and CDPATH-shadowed homes resolve, and the code is found through a link"
}

test_refusals_create_nothing() {
  local out status checkout="$TMP_ROOT/checkout" file="$TMP_ROOT/a-file" user="$TMP_ROOT/user-home"
  local writable="$TMP_ROOT/writable2/firstmate"
  status=0; out=$(init "$CODE" "$CODE" 2>&1) || status=$?
  expect_code 1 "$status" "the code as its own home"
  assert_contains "$out" "is, or lies inside, the code" "the code as home is named"
  code_copy "$writable"
  status=0; out=$(init "$writable" "$writable/new/deep" 2>&1) || status=$?
  expect_code 1 "$status" "a home inside the code"
  [ ! -e "$writable/new" ] || fail "a refused home inside the code must create nothing"
  status=0; out=$(init "$CODE" "$TMP_ROOT/app" 2>&1) || status=$?
  expect_code 1 "$status" "a home containing the code"
  assert_contains "$out" "lies inside the home" "a home containing the code is named"
  status=0; out=$(init "$CODE" / 2>&1) || status=$?
  expect_code 1 "$status" "/ as the home"
  # A checkout, a worktree-style checkout, and a user's home directory.
  mkdir -p "$checkout/bin"
  : > "$checkout/AGENTS.md"
  git init -q "$checkout"
  status=0; out=$(init "$CODE" "$checkout" 2>&1) || status=$?
  expect_code 1 "$status" "a firstmate checkout as home"
  assert_contains "$out" "not empty and is not a firstmate home" "a checkout is refused"
  [ ! -e "$checkout/data" ] && [ ! -L "$checkout/docs" ] || fail "a refused checkout must be left as it was"
  printf 'gitdir: /elsewhere/.git/worktrees/x\n' > "$TMP_ROOT/worktree-git"
  mkdir -p "$TMP_ROOT/worktree"
  mv "$TMP_ROOT/worktree-git" "$TMP_ROOT/worktree/.git"
  status=0; out=$(init "$CODE" "$TMP_ROOT/worktree" 2>&1) || status=$?
  expect_code 1 "$status" "a worktree as home"
  mkdir -p "$user/Documents"
  : > "$user/.zshrc"
  status=0; out=$(init "$CODE" "$user" 2>&1) || status=$?
  expect_code 1 "$status" "a user's home directory as home"
  [ ! -e "$user/data" ] && [ ! -e "$user/.fm-home" ] || fail "a refused home directory must be left as it was"
  : > "$file"
  status=0; out=$(init "$CODE" "$file" 2>&1) || status=$?
  expect_code 1 "$status" "a file as home"
  status=0; out=$(init "$CODE" "$file/below" 2>&1) || status=$?
  expect_code 1 "$status" "a home below a file"
  status=0; out=$(env -u FM_HOME "$CODE/bin/fm-home-init.sh" 2>&1) || status=$?
  expect_code 2 "$status" "no home named"
  pass "a home that is, holds, or sits in the code, a non-empty folder, or a file is refused, creating nothing"
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
test_the_homes_own_files_and_links_are_never_changed
test_concurrent_runs_take_turns
test_paths_are_resolved_safely
test_refusals_create_nothing
test_home_owned_names_match_gitignore
