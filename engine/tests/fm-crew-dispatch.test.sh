#!/usr/bin/env bash
# Behavior tests for bin/fm-crew-dispatch.sh.
#
# Drives the public verbs against a temporary home. The key cases run every
# external command the script may start through a logging wrapper, so they
# prove the key reaches no process's argv, and they assert it appears in no
# output and in no file but .env.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TOOL="$ROOT/bin/fm-crew-dispatch.sh"
TMP_ROOT=$(fm_test_tmproot fm-crew-dispatch)
BASE_PATH=$PATH
KEY='tsk_live-4Q9.z/Abc+def=:~Z'

new_home() {  # <name>: prints a fresh home with an empty config/
  local home="$TMP_ROOT/$1"
  mkdir -p "$home/config"
  printf '%s\n' "$home"
}

run() {  # <home> <verb...>: runs the tool, stdout and stderr to $OUT and $ERR, exit in $RC
  local home=$1
  shift
  RC=0
  env -u TYPESAFE_API_KEY FM_HOME="$home" "$TOOL" "$@" > "$TMP_ROOT/out" 2> "$TMP_ROOT/err" || RC=$?
  OUT=$(cat "$TMP_ROOT/out")
  ERR=$(cat "$TMP_ROOT/err")
}

run_in() {  # <home> <stdin file> <verb...>
  local home=$1 input=$2
  shift 2
  RC=0
  env -u TYPESAFE_API_KEY FM_HOME="$home" "$TOOL" "$@" < "$input" > "$TMP_ROOT/out" 2> "$TMP_ROOT/err" || RC=$?
  OUT=$(cat "$TMP_ROOT/out")
  ERR=$(cat "$TMP_ROOT/err")
}

input() {  # <text>: prints a file holding <text>
  local file
  file=$(mktemp "$TMP_ROOT/input.XXXXXX")
  printf '%s\n' "$1" > "$file"
  printf '%s\n' "$file"
}

test_off_by_default() {
  local home
  home=$(new_home off)
  run "$home" status
  expect_code 0 "$RC" "status of a fresh home"
  assert_equals $'routing=off\nkey=unset' "$OUT" "a fresh home has routing off and no key"
  run "$home" show
  assert_equals "" "$OUT" "show prints nothing while routing is off"
  run "$home" disable
  expect_code 0 "$RC" "disable while off"
  assert_equals "routing=off" "$OUT" "disable while off is a no-op"
  assert_absent "$home/config/crew-dispatch.json" "disable while off creates nothing"
  pass "routing is off until turned on, and turning it off again is a no-op"
}

test_enable_empty_and_template() {
  local home
  home=$(new_home enable)
  run "$home" enable
  expect_code 0 "$RC" "enable"
  assert_equals "routing=on" "$OUT" "enable reports routing on"
  assert_equals '[]' "$(jq -c .rules "$home/config/crew-dispatch.json")" "plain enable writes empty rules"
  run "$home" enable --template
  expect_code 1 "$RC" "enable while on"
  assert_contains "$ERR" "already on" "enable while on names why"
  assert_equals '[]' "$(jq -c .rules "$home/config/crew-dispatch.json")" "a refused enable leaves the file alone"

  home=$(new_home template)
  run "$home" enable --template
  expect_code 0 "$RC" "enable --template"
  cmp -s "$ROOT/docs/examples/crew-dispatch.json" "$home/config/crew-dispatch.json" \
    || fail "enable --template copies the shipped example"
  run "$home" status
  assert_contains "$OUT" "routing=on" "status after enable"
  assert_not_contains "$OUT" "invalid=" "the shipped example is valid"
  run "$home" show
  assert_equals "$(cat "$ROOT/docs/examples/crew-dispatch.json")" "$OUT" "show prints the rules"
  run "$home" template
  assert_equals "$(cat "$ROOT/docs/examples/crew-dispatch.json")" "$OUT" "template prints the shipped example"
  [ -z "$(find "$home/config" -name '.crew-dispatch*')" ] || fail "enable leaves no temporary file behind"
  pass "enable creates empty rules or the shipped example, and never overwrites"
}

test_write_validates() {
  local home before sha
  home=$(new_home write)
  run_in "$home" "$(input '{"rules":[]}')" write
  expect_code 1 "$RC" "write while off"
  assert_contains "$ERR" "routing is off" "write while off names why"
  assert_absent "$home/config/crew-dispatch.json" "write while off creates nothing"

  run "$home" enable --template
  before=$(cat "$home/config/crew-dispatch.json")
  run_in "$home" "$(input '{"rules":[{"when":"x","use":{"harness":"spaceship"}}]}')" write
  expect_code 1 "$RC" "write of an unverified harness"
  assert_equals "fm-crew-dispatch: not saved: unverified harness: spaceship" "$ERR" "write names the validator's reason"
  assert_equals "$before" "$(cat "$home/config/crew-dispatch.json")" "a refused write leaves the file alone"
  run_in "$home" "$(input '{"rules":[')" write
  assert_equals "fm-crew-dispatch: not saved: malformed JSON" "$ERR" "malformed JSON is refused"

  sha=$(sed -n 's/^sha256=//p' <<< "$(env -u TYPESAFE_API_KEY FM_HOME="$home" "$TOOL" status)")
  run_in "$home" "$(input '{"rules":[],"default":{"harness":"claude"}}')" write --if-unchanged "$sha"
  expect_code 0 "$RC" "write of valid rules"
  assert_equals '{"harness":"claude"}' "$(jq -c .default "$home/config/crew-dispatch.json")" "write saves valid rules"
  assert_contains "$OUT" "sha256=" "write reports the new digest"
  run_in "$home" "$(input '{"rules":[],"default":{"harness":"codex"}}')" write --if-unchanged "$sha"
  expect_code 1 "$RC" "write over a changed file"
  assert_contains "$ERR" "changed since it was read" "a stale digest is refused"
  assert_equals '{"harness":"claude"}' "$(jq -c .default "$home/config/crew-dispatch.json")" "a stale write leaves the file alone"
  pass "write saves only rules the shared validator accepts, and never over someone else's edit"
}

test_status_reports_bootstrap_reason() {
  local home reason
  home=$(new_home invalid)
  printf '%s\n' '{"rules":[{"when":"x","use":{"harness":"claude","effort":"ultra"}}]}' > "$home/config/crew-dispatch.json"
  run "$home" status
  reason=$(sed -n 's/^invalid=//p' <<< "$OUT")
  assert_equals "invalid effort: claude:ultra" "$reason" "status reports a hand-edited file's reason"
  pass "status reports the reason the shared validator gives for a hand-edited file"
}

test_disable_sets_aside_and_restore() {
  local home aside
  home=$(new_home disable)
  run "$home" enable --template
  printf '%s\n' '{"rules":[],"default":{"harness":"grok"}}' > "$home/config/crew-dispatch.json"
  run "$home" disable
  expect_code 0 "$RC" "disable"
  aside=$(sed -n 's/^set-aside=//p' <<< "$OUT")
  case "$aside" in
    crew-dispatch.json.off-*) : ;;
    *) fail "disable names the set-aside file (got: $OUT)" ;;
  esac
  assert_absent "$home/config/crew-dispatch.json" "disable turns routing off"
  assert_equals '{"harness":"grok"}' "$(jq -c .default "$home/config/$aside")" "the hand-edited rules survive disable"
  run "$home" status
  assert_contains "$OUT" "set-aside=$aside" "status names the set-aside file"

  run "$home" enable --restore
  expect_code 0 "$RC" "enable --restore"
  assert_contains "$OUT" "restored=$aside" "restore names what it brought back"
  assert_equals '{"harness":"grok"}' "$(jq -c .default "$home/config/crew-dispatch.json")" "restore brings the rules back"
  assert_absent "$home/config/$aside" "restore consumes the set-aside file"
  run "$home" enable --restore
  expect_code 1 "$RC" "restore while on"

  run "$home" disable
  run "$home" disable
  run "$home" enable --restore
  run "$home" disable
  [ "$(find "$home/config" -name 'crew-dispatch.json.off-*' | wc -l | tr -d ' ')" = 1 ] \
    || fail "repeated disable and restore keeps exactly one set-aside copy"
  pass "disable moves the rules aside without deleting them, and restore brings them back"
}

# Every external command the script can start, wrapped to log its argv.
logging_path() {  # <dir> <log>
  local dir=$1 log=$2 tool real
  mkdir -p "$dir"
  for tool in awk basename cat chmod cp date grep jq ln mkdir mktemp mv rm sed sha256sum shasum; do
    real=$(command -v "$tool") || continue
    printf '#!/bin/sh\nprintf "%%s\\n" "%s $*" >> "%s"\nexec "%s" "$@"\n' "$tool" "$log" "$real" > "$dir/$tool"
    chmod +x "$dir/$tool"
  done
  printf '%s\n' "$dir"
}

test_set_key_never_leaks() {
  local home log bin mode
  home=$(new_home key)
  log="$TMP_ROOT/argv.log"
  bin=$(logging_path "$TMP_ROOT/logbin" "$log")
  printf '%s\n' 'FMX_PAIRING_TOKEN=keep-me' 'export TYPESAFE_API_KEY=old-one' 'MAIL_USER=me' 'TYPESAFE_API_KEY="older"' > "$home/.env"
  RC=0
  printf '%s\n' "$KEY" | env -u TYPESAFE_API_KEY PATH="$bin:$BASE_PATH" FM_HOME="$home" "$TOOL" set-key \
    > "$TMP_ROOT/out" 2> "$TMP_ROOT/err" || RC=$?
  expect_code 0 "$RC" "set-key"
  assert_equals $'key=set\nkey-source=.env' "$(cat "$TMP_ROOT/out")" "set-key reports the key set"
  assert_equals "" "$(cat "$TMP_ROOT/err")" "set-key says nothing on stderr"
  [ -s "$log" ] || fail "the argv log recorded the commands set-key ran"
  assert_no_grep "$KEY" "$log" "the key is on no process's argv"
  assert_equals "$(printf '%s\n' 'FMX_PAIRING_TOKEN=keep-me' 'MAIL_USER=me' "TYPESAFE_API_KEY=$KEY")" "$(cat "$home/.env")" \
    "set-key replaces every older key line and keeps the rest"
  mode=$(perl -e 'printf "%o\n", (stat $ARGV[0])[2] & 07777' "$home/.env")
  assert_equals 600 "$mode" ".env is private to its owner"
  [ "$(grep -rlF -- "$KEY" "$home" "$TMP_ROOT/out" "$TMP_ROOT/err" | tr '\n' ' ')" = "$home/.env " ] \
    || fail "the key is written nowhere but .env"

  run "$home" status
  assert_not_contains "$OUT$ERR" "$KEY" "status never prints the key"
  assert_contains "$OUT" "key=set" "status reports the key set"

  # shellcheck disable=SC2016 # the literal text is the point: it must not be stored
  run_in "$home" "$(input 'bad key$(id)')" set-key
  expect_code 1 "$RC" "a key with an unsafe character"
  assert_not_contains "$ERR" 'bad key' "a refused key is not echoed"
  assert_grep "TYPESAFE_API_KEY=$KEY" "$home/.env" "a refused key leaves the stored one"
  run_in "$home" "$(input '   ')" set-key
  expect_code 1 "$RC" "an empty key"

  run "$home" clear-key
  expect_code 0 "$RC" "clear-key"
  assert_equals "key=unset" "$OUT" "clear-key reports the key unset"
  assert_equals "$(printf '%s\n' 'FMX_PAIRING_TOKEN=keep-me' 'MAIL_USER=me')" "$(cat "$home/.env")" "clear-key removes only the key"
  pass "set-key stores the key only in .env, off every argv and output, and clear-key removes it"
}

test_environment_key_and_symlinks() {
  local home real
  home=$(new_home envkey)
  RC=0
  OUT=$(TYPESAFE_API_KEY="$KEY" FM_HOME="$home" "$TOOL" status 2>&1) || RC=$?
  assert_equals $'routing=off\nkey=set\nkey-source=environment' "$OUT" "an environment key is reported, not printed"

  real="$TMP_ROOT/elsewhere.env"
  printf '%s\n' 'OTHER=1' > "$real"
  ln -s "$real" "$home/.env"
  run_in "$home" "$(input "$KEY")" set-key
  expect_code 1 "$RC" "set-key through a symlinked .env"
  [ -L "$home/.env" ] || fail "a symlinked .env stays a symlink"
  assert_equals "OTHER=1" "$(cat "$real")" "a symlinked .env's target is untouched"
  pass "an environment key is reported without printing it, and a symlinked .env is refused"
}

test_bootstrap_uses_same_validator() {
  local home out
  home=$(new_home bootstrap)
  printf '%s\n' '{"rules":[{"when":"x","use":{"harness":"spaceship"}}]}' > "$home/config/crew-dispatch.json"
  out=$(env -u TYPESAFE_API_KEY FM_HOME="$home" FM_BOOTSTRAP_DETECT_ONLY=1 FM_BOOTSTRAP_NETWORK=skip \
    "$ROOT/bin/fm-bootstrap.sh" 2>/dev/null | grep '^CREW_DISPATCH:')
  run "$home" status
  assert_equals "CREW_DISPATCH: invalid config/crew-dispatch.json - $(sed -n 's/^invalid=//p' <<< "$OUT")" "$out" \
    "bootstrap and status give the same reason"
  pass "bootstrap reports the same reason status does"
}

command -v jq >/dev/null 2>&1 || fail "jq is required"
test_off_by_default
test_enable_empty_and_template
test_write_validates
test_status_reports_bootstrap_reason
test_disable_sets_aside_and_restore
test_set_key_never_leaks
test_environment_key_and_symlinks
test_bootstrap_uses_same_validator
