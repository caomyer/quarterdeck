#!/usr/bin/env bash
# Behavior tests for bin/fm-task-note.sh.
# Covers adding a note with a body, files and a scope mark; a queued backlog row
# taking notes before any worker exists; cleaning a file's
# name into one safe to pass to a shell; a name already taken; hard-linking a
# file Quarterdeck already copied into the home and copying anything else;
# refusals (no content, unknown task, bad id, folders, symbolic links, the size
# cap); concurrent adds claiming distinct note ids; show in text and JSON; the
# brief section; and a spawn appending that section to the launch brief.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }

NOTE="$ROOT/bin/fm-task-note.sh"
TMP_ROOT=$(fm_test_tmproot fm-task-note)

# new_home <label>: a disposable home with one known task, t1.
new_home() {
  local home="$TMP_ROOT/$1/home"
  mkdir -p "$home/data/t1" "$home/state" "$home/config"
  printf '%s\n' "$home"
}

test_add_records_a_note_with_clean_file_names() {
  local home src out rc
  home=$(new_home add)
  # A macOS screenshot's name: spaces, and a U+202F narrow no-break space before PM.
  src="$TMP_ROOT/add/Screenshot 2026-09-23 at 11.49.55"$'\xe2\x80\xaf'"PM.png"
  printf 'png bytes' > "$src"
  out=$(FM_HOME="$home" "$NOTE" add t1 --body $'SYMPTOM: cards jump.\nsecond line' --file "$src" --scope 2>&1); rc=$?
  expect_code 0 "$rc" "add"
  assert_contains "$out" "added: n1 on t1" "add names the note it recorded"
  assert_contains "$out" "file: $home/data/t1/files/Screenshot-2026-09-23-at-11.49.55-PM.png" "add prints the clean path"
  assert_present "$home/data/t1/files/Screenshot-2026-09-23-at-11.49.55-PM.png" "the file is on the task"
  assert_equals "png bytes" "$(cat "$home/data/t1/files/Screenshot-2026-09-23-at-11.49.55-PM.png")" "the file keeps its content"
  assert_equals "n1|firstmate|true|SYMPTOM: cards jump.
second line|files/Screenshot-2026-09-23-at-11.49.55-PM.png|9" \
    "$(jq -r '[.id,.by,(.scope|tostring),.body,.files[0].path,(.files[0].bytes|tostring)] | join("|")' "$home/data/t1/notes/n1.json")" \
    "the note is stored with its body, scope and file"
  assert_equals "$(basename "$src")" "$(jq -r '.files[0].original' "$home/data/t1/notes/n1.json")" "the original name is kept as a record"
  printf 'other' > "$TMP_ROOT/add/..weird\`name"
  out=$(FM_HOME="$home" "$NOTE" add t1 --file "$src" --file "$TMP_ROOT/add/..weird\`name" --by captain) || fail "second add failed: $out"
  assert_contains "$out" "added: n2 on t1" "the next note takes the next id"
  assert_present "$home/data/t1/files/Screenshot-2026-09-23-at-11.49.55-PM-2.png" "a taken name gains a number before its extension"
  assert_present "$home/data/t1/files/weird-name" "leading dots go and a backtick becomes a dash"
  assert_equals "captain|false|" "$(jq -r '[.by,(.scope|tostring),.body] | join("|")' "$home/data/t1/notes/n2.json")" "--by and a file-only note"
  pass "fm-task-note.sh: add records notes and files under clean, unique names"
}

test_a_queued_backlog_row_is_a_known_task() {
  local home out
  home="$TMP_ROOT/queued/home"
  mkdir -p "$home/data" "$home/state" "$home/config"
  # A queued row has no worker yet, so no state/<id>.meta and no data/<id>/: only the row says it exists.
  printf '# Backlog\n\n## In flight\n## Queued\n- [ ] qd-order-1 - pages sink below newer messages (kind: ship) (since 2026-09-23)\n' > "$home/data/backlog.md"
  printf 'png' > "$TMP_ROOT/queued/shot.png"
  out=$(FM_HOME="$home" "$NOTE" add qd-order-1 --body 'The captain saw this.' --file "$TMP_ROOT/queued/shot.png" 2>&1) || fail "a queued row was refused: $out"
  assert_present "$home/data/qd-order-1/files/shot.png" "the file lands beside the queued task"
  out=$(FM_HOME="$home" "$NOTE" add qd-other-2 --body hi 2>&1) && fail "a task with no row was accepted"
  assert_contains "$out" "unknown task 'qd-other-2'" "a task the backlog does not name is still refused"
  pass "fm-task-note.sh: a queued backlog row takes notes before any worker exists"
}

test_attachments_are_linked_and_other_files_copied() {
  local home att outside
  home=$(new_home link)
  att="$home/data/.attachments/1790232718309-1/shot.png"
  mkdir -p "$(dirname "$att")"
  printf 'attached' > "$att"
  outside="$TMP_ROOT/link/desk.png"
  printf 'desk' > "$outside"
  FM_HOME="$home" "$NOTE" add t1 --file "$att" --file "$outside" >/dev/null || fail "add failed"
  [ "$att" -ef "$home/data/t1/files/shot.png" ] || fail "a copy Quarterdeck made is hard-linked, not duplicated"
  [ ! "$outside" -ef "$home/data/t1/files/desk.png" ] || fail "a file from outside the home is copied"
  printf 'changed' > "$outside"
  assert_equals "desk" "$(cat "$home/data/t1/files/desk.png")" "the task keeps the file as it was when added"
  pass "fm-task-note.sh: Quarterdeck's attachment copies are linked, anything else is copied"
}

test_refusals() {
  local home out rc
  home=$(new_home refuse)
  mkdir -p "$TMP_ROOT/refuse/folder"
  printf 'x' > "$TMP_ROOT/refuse/real"
  ln -s "$TMP_ROOT/refuse/real" "$TMP_ROOT/refuse/link"
  printf 'too big' > "$TMP_ROOT/refuse/big"

  out=$(FM_HOME="$home" "$NOTE" add t1 --body '   ' 2>&1); rc=$?
  expect_code 1 "$rc" "empty note"; assert_contains "$out" "needs --body" "an empty note is refused"
  out=$(FM_HOME="$home" "$NOTE" add nope --body hi 2>&1); rc=$?
  expect_code 1 "$rc" "unknown task"; assert_contains "$out" "unknown task 'nope'" "an unknown task is refused"
  out=$(FM_HOME="$home" "$NOTE" add ../t1 --body hi 2>&1); rc=$?
  expect_code 1 "$rc" "bad id"; assert_contains "$out" "invalid task id" "a path-shaped id is refused"
  out=$(FM_HOME="$home" "$NOTE" add t1 --file "$TMP_ROOT/refuse/folder" 2>&1); rc=$?
  expect_code 1 "$rc" "folder"; assert_contains "$out" "is a folder" "a folder is refused"
  out=$(FM_HOME="$home" "$NOTE" add t1 --file "$TMP_ROOT/refuse/link" 2>&1); rc=$?
  expect_code 1 "$rc" "symlink"; assert_contains "$out" "symbolic link" "a symbolic link is refused"
  out=$(FM_HOME="$home" FM_TASK_NOTE_MAX_BYTES=3 "$NOTE" add t1 --file "$TMP_ROOT/refuse/big" 2>&1); rc=$?
  expect_code 1 "$rc" "size cap"; assert_contains "$out" "over the 3 cap" "a file over the cap is refused"
  out=$(FM_HOME="$home" "$NOTE" add t1 --body a --body-file "$TMP_ROOT/refuse/real" 2>&1); rc=$?
  expect_code 1 "$rc" "both bodies"
  out=$(FM_HOME="$home" "$NOTE" add t1 --by 'two words' --body hi 2>&1); rc=$?
  expect_code 1 "$rc" "bad --by"
  out=$(FM_HOME="$home" "$NOTE" frobnicate 2>&1); rc=$?
  expect_code 2 "$rc" "unknown subcommand"
  assert_absent "$home/data/t1/notes/n1.json" "no refused add left a note"
  assert_absent "$home/data/t1/files" "no refused add left a file"
  pass "fm-task-note.sh: refuses empty notes, unknown tasks, bad ids, folders, links and oversize files"
}

test_concurrent_adds_claim_distinct_ids() {
  local home i
  home=$(new_home concurrent)
  for i in 1 2 3 4 5 6; do
    FM_HOME="$home" "$NOTE" add t1 --body "note $i" >/dev/null &
  done
  wait
  assert_equals "6" "$(find "$home/data/t1/notes" -name 'n*.json' | wc -l | tr -d ' ')" "six adds leave six notes"
  assert_equals "note 1,note 2,note 3,note 4,note 5,note 6" \
    "$(FM_HOME="$home" "$NOTE" show t1 --json | jq -r '[.notes[].body] | sort | join(",")')" "every body survives"
  assert_absent "$(find "$home/data/t1/notes" -name '.incoming*' -print -quit)" "no scratch file is left behind"
  pass "fm-task-note.sh: concurrent adds claim distinct note ids"
}

test_show_and_brief() {
  local home out
  home=$(new_home show)
  assert_equals "" "$(FM_HOME="$home" "$NOTE" show t1)" "a task with no notes shows nothing"
  assert_equals '{"schema":"fm-task-notes.v1","task":"t1","notes":[]}' "$(FM_HOME="$home" "$NOTE" show t1 --json | jq -c .)" "and an empty list in JSON"
  assert_equals "" "$(FM_HOME="$home" "$NOTE" brief t1)" "and adds nothing to a brief"
  printf 'img' > "$TMP_ROOT/show/a b.png"
  for i in 1 2 3 4 5 6 7 8 9 10; do FM_HOME="$home" "$NOTE" add t1 --body "n$i" >/dev/null || fail "add $i failed"; done
  FM_HOME="$home" "$NOTE" add t1 --body 'Rebase on the review work first.' --file "$TMP_ROOT/show/a b.png" --scope >/dev/null || fail "scope add failed"
  out=$(FM_HOME="$home" "$NOTE" show t1 --json)
  assert_equals "n1,n2,n3,n4,n5,n6,n7,n8,n9,n10,n11" "$(printf '%s' "$out" | jq -r '[.notes[].id] | join(",")')" "notes come oldest first, n10 after n9"
  assert_equals "$home/data/t1/files/a-b.png" "$(printf '%s' "$out" | jq -r '.notes[10].files[0].path')" "show gives each file's absolute path"
  out=$(FM_HOME="$home" "$NOTE" show t1)
  assert_contains "$out" "by firstmate, changes scope" "text show marks a scope change"
  assert_contains "$out" "  file: $home/data/t1/files/a-b.png (3 bytes)" "text show lists each file"
  out=$(FM_HOME="$home" "$NOTE" brief t1)
  assert_contains "$out" "# Files and notes on this task" "brief opens its own section"
  assert_contains "$out" "fm-task-note.sh show t1" "brief says how to read notes added later"
  assert_contains "$out" '  - file: `'"$home/data/t1/files/a-b.png"'` (was a b.png)' "brief hands the file over as a path"
  assert_not_contains "$out" "img" "brief never inlines a file"
  pass "fm-task-note.sh: show and brief read notes in order, files as paths"
}

test_spawn_appends_notes_to_the_launch_brief() {
  local home proj fakebin out id=t-spawn
  # A real spawn that renders the launch brief and then stops: the fake tmux refuses, so no window or
  # worktree is ever created (the shape tests/fm-task-delivery.test.sh uses).
  home="$TMP_ROOT/spawn/home"
  proj="$TMP_ROOT/spawn/projects/proj"
  fakebin="$TMP_ROOT/spawn/bin"
  mkdir -p "$home/data/$id" "$home/state" "$home/config" "$proj" "$fakebin"
  git -C "$proj" init -q || fail "could not initialize project fixture"
  printf '#!/bin/sh\nexit 1\n' > "$fakebin/tmux"
  chmod +x "$fakebin/tmux"
  printf 'You are a crewmate.\n\n# Task\n## Captain'\''s intent\nFix the ordering.\n\n## Firstmate spec\nPlace pages by time.\n\n# Definition of done\nDelivery contract: mode=direct-PR\n' > "$home/data/$id/brief.md"
  printf 'img' > "$TMP_ROOT/spawn/shot.png"
  FM_HOME="$home" "$NOTE" add "$id" --body 'The captain saw this.' --file "$TMP_ROOT/spawn/shot.png" >/dev/null || fail "add failed"
  out=$(FM_ROOT_OVERRIDE='' FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
    FM_PROJECTS_OVERRIDE="$TMP_ROOT/spawn/projects-unused" FM_CONFIG_OVERRIDE="$home/config" \
    FM_SPAWN_NO_GUARD=1 FM_BACKEND=tmux PATH="$fakebin:$PATH" \
    "$ROOT/bin/fm-spawn.sh" "$id" "$proj" claude --mode direct-PR --yolo off 2>&1)
  assert_present "$home/data/$id/launch-brief.md" "the spawn rendered a launch brief: $out"
  assert_grep "Place pages by time." "$home/data/$id/launch-brief.md" "the launch brief keeps the brief"
  assert_grep "# Files and notes on this task" "$home/data/$id/launch-brief.md" "the launch brief carries the task's notes section"
  assert_grep "The captain saw this." "$home/data/$id/launch-brief.md" "the note reaches the worker"
  assert_grep "$home/data/$id/files/shot.png" "$home/data/$id/launch-brief.md" "and the file's path"
  pass "fm-task-note.sh: a spawn hands the task's files and notes to the worker"
}

test_add_records_a_note_with_clean_file_names
test_a_queued_backlog_row_is_a_known_task
test_attachments_are_linked_and_other_files_copied
test_refusals
test_concurrent_adds_claim_distinct_ids
test_show_and_brief
test_spawn_appends_notes_to_the_launch_brief
