#!/usr/bin/env bash
# Behavior tests for bin/fm-calm.sh.
# Covers reading an absent, on, off, legacy max and unrecognized preference;
# setting it on and off with exactly the value and newline the harness
# integrations write; resolving the file through FM_HOME, FM_ROOT_OVERRIDE and
# FM_CONFIG_OVERRIDE; a write that cannot land leaving the previous choice in
# place and saying why; and usage errors.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CALM="$ROOT/bin/fm-calm.sh"
TMP_ROOT=$(fm_test_tmproot fm-calm)

new_home() {
  local home="$TMP_ROOT/$1/home"
  mkdir -p "$home/config"
  printf '%s\n' "$home"
}

test_get_reads_the_shared_values() {
  local home out
  home=$(new_home get)
  out=$(FM_HOME="$home" "$CALM" get) || fail "get failed with no file"
  assert_equals "off" "$out" "an absent preference reads as off"
  for pair in "on:on" "off:off" "max:on" "loud:off" "  on  :on" ":off"; do
    printf '%s\n' "${pair%%:*}" > "$home/config/calm"
    out=$(FM_HOME="$home" "$CALM" get) || fail "get failed on '${pair%%:*}'"
    assert_equals "${pair##*:}" "$out" "'${pair%%:*}' reads as ${pair##*:}"
  done
  pass "fm-calm.sh: get reads on, off, legacy max and anything else as the integrations do"
}

test_set_writes_the_value_and_one_newline() {
  local home out
  home=$(new_home set)
  rm -rf "$home/config"
  out=$(FM_HOME="$home" "$CALM" set on) || fail "set on failed: $out"
  assert_equals "on" "$out" "set prints the value in force"
  assert_equals "$(printf 'on\n' | od -c)" "$(od -c < "$home/config/calm")" "on is written with one newline"
  out=$(FM_HOME="$home" "$CALM" set off) || fail "set off failed: $out"
  assert_equals "off" "$out" "set off prints off"
  assert_equals "$(printf 'off\n' | od -c)" "$(od -c < "$home/config/calm")" "off is written with one newline"
  assert_equals "" "$(find "$home/config" -name 'calm.*' -print)" "no temporary file is left behind"
  pass "fm-calm.sh: set writes on or off and a newline, creating config/ when needed"
}

test_the_file_resolves_as_the_integrations_resolve_it() {
  local base out
  base="$TMP_ROOT/resolve"
  mkdir -p "$base/home/config" "$base/root/config" "$base/override"
  FM_HOME="$base/home" FM_ROOT_OVERRIDE="$base/root" "$CALM" set on >/dev/null || fail "set with FM_HOME failed"
  assert_equals "on" "$(cat "$base/home/config/calm")" "FM_HOME wins over FM_ROOT_OVERRIDE"
  assert_absent "$base/root/config/calm" "FM_ROOT_OVERRIDE is not written while FM_HOME is set"
  FM_HOME='' FM_ROOT_OVERRIDE="$base/root" "$CALM" set on >/dev/null || fail "set with FM_ROOT_OVERRIDE failed"
  assert_equals "on" "$(cat "$base/root/config/calm")" "FM_ROOT_OVERRIDE is used without FM_HOME"
  FM_HOME="$base/home" FM_CONFIG_OVERRIDE="$base/override" "$CALM" set off >/dev/null || fail "set with FM_CONFIG_OVERRIDE failed"
  assert_equals "off" "$(cat "$base/override/calm")" "FM_CONFIG_OVERRIDE names the config directory outright"
  assert_equals "on" "$(cat "$base/home/config/calm")" "and leaves the home's own file alone"
  out=$(FM_HOME="$base/home" FM_CONFIG_OVERRIDE="$base/override" "$CALM" get)
  assert_equals "off" "$out" "get reads the same file set wrote"
  pass "fm-calm.sh: the file resolves through FM_CONFIG_OVERRIDE, FM_HOME, then FM_ROOT_OVERRIDE"
}

test_a_failed_write_keeps_the_choice() {
  local home out rc
  home=$(new_home denied)
  printf 'on\n' > "$home/config/calm"
  chmod 0555 "$home/config"
  out=$(FM_HOME="$home" "$CALM" set off 2>&1); rc=$?
  chmod 0755 "$home/config"
  if [ "$(id -u)" -eq 0 ]; then
    echo "skip: running as root, so a read-only folder cannot refuse the write"
    return 0
  fi
  expect_code 1 "$rc" "a write that cannot land exits 1"
  assert_contains "$out" "fm-calm: config/calm: " "the refusal names the file"
  assert_contains "$out" "Permission denied" "and says why in the system's words"
  assert_equals "on" "$(cat "$home/config/calm")" "the previous choice stays in place"
  assert_equals "" "$(find "$home/config" -name 'calm.*' -print)" "no temporary file is left behind"
  pass "fm-calm.sh: a write that fails keeps the previous choice and says why"
}

test_usage() {
  local home rc
  home=$(new_home usage)
  for args in "" "set" "set maybe" "set on extra" "get extra" "toggle"; do
    # shellcheck disable=SC2086
    FM_HOME="$home" "$CALM" $args >/dev/null 2>&1; rc=$?
    expect_code 2 "$rc" "usage error for '$args'"
  done
  assert_absent "$home/config/calm" "a usage error writes nothing"
  pass "fm-calm.sh: anything but get or set on|off is a usage error"
}

test_get_reads_the_shared_values
test_set_writes_the_value_and_one_newline
test_the_file_resolves_as_the_integrations_resolve_it
test_a_failed_write_keeps_the_choice
test_usage
