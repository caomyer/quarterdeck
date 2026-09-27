#!/usr/bin/env bash
# Behavior tests for bin/fm-agents.sh.
# Covers a harness that is installed and signed in, installed and signed out,
# installed with a status command that fails some other way, installed without
# a version, and missing; a harness firstmate has no install or sign-in line
# for; the order of the lines; answering with no jq on PATH; a probe that hangs
# being cut off; the sign-in command; and usage errors.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

AGENTS="$ROOT/bin/fm-agents.sh"
TMP_ROOT=$(fm_test_tmproot fm-agents)

# A PATH holding only the basics the script needs, and no jq, plus fake agents.
new_bin() {
  local bin="$TMP_ROOT/$1/bin" tool
  mkdir -p "$bin"
  for tool in bash cat sed grep head dirname basename mktemp rm sleep kill perl; do
    command -v "$tool" >/dev/null 2>&1 && ln -sf "$(command -v "$tool")" "$bin/$tool"
  done
  printf '%s\n' "$bin"
}

# fake_agent <bin> <name> <version line> <status exit code>
fake_agent() {
  cat > "$1/$2" <<EOF
#!/bin/sh
case "\$*" in
  --version) printf '%s\n' '$3' ;;
  "auth status"|"login status") exit $4 ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "$1/$2"
}

run_status() {  # <bin> <harness>...
  local bin=$1
  shift
  RC=0
  OUT=$(env HOME="$TMP_ROOT/no-home" PATH="$bin" "$AGENTS" status "$@" 2>&1) || RC=$?
}

test_reports_each_agent_as_named() {
  local bin
  bin=$(new_bin states)
  fake_agent "$bin" claude "2.1.283 (Claude Code)" 0
  fake_agent "$bin" codex "codex-cli 0.144.6" 1
  run_status "$bin" codex claude opencode
  expect_code 0 "$RC" "status ($OUT)"
  assert_equals "$(printf '%s\n' \
    $'codex\tinstalled\t0.144.6\tsigned-out\tnpm install -g @openai/codex' \
    $'claude\tinstalled\t2.1.283\tsigned-in\tcurl -fsSL https://claude.ai/install.sh | bash' \
    $'opencode\tmissing\t-\tunknown\t-')" "$OUT" \
    "one line per harness, in the order named, with version, sign-in and install line"
  assert_absent "$bin/jq" "the answer needs no jq"
  pass "fm-agents.sh: status reports installed, version, sign-in and install for each agent named"
}

test_uncertain_answers_read_as_unknown() {
  local bin
  bin=$(new_bin uncertain)
  fake_agent "$bin" claude "no version here" 3
  fake_agent "$bin" pi "pi 1.2.3" 0
  run_status "$bin" claude pi codex
  expect_code 0 "$RC" "status ($OUT)"
  assert_equals $'claude\tinstalled\t-\tunknown\tcurl -fsSL https://claude.ai/install.sh | bash' "$(sed -n 1p <<< "$OUT")" \
    "a status command that fails another way is unknown, and no version is -"
  assert_equals $'pi\tinstalled\t1.2.3\tunknown\t-' "$(sed -n 2p <<< "$OUT")" \
    "a harness without a sign-in probe or install line is still reported"
  assert_equals $'codex\tmissing\t-\tunknown\tnpm install -g @openai/codex' "$(sed -n 3p <<< "$OUT")" \
    "a missing harness still carries its install line"
  pass "fm-agents.sh: what cannot be known reads as unknown, never as signed in"
}

test_a_hanging_probe_is_cut_off() {
  local bin started elapsed
  bin=$(new_bin hang)
  cat > "$bin/codex" <<'EOF'
#!/bin/sh
case "$*" in
  --version) echo "codex-cli 1.0.0" ;;
  *) sleep 30 ;;
esac
EOF
  chmod +x "$bin/codex"
  started=$(date +%s)
  RC=0
  OUT=$(env HOME="$TMP_ROOT/no-home" PATH="$bin" FM_AGENTS_PROBE_SECONDS=1 "$AGENTS" status codex 2>&1) || RC=$?
  elapsed=$(( $(date +%s) - started ))
  expect_code 0 "$RC" "status ($OUT)"
  assert_equals $'codex\tinstalled\t1.0.0\tunknown\tnpm install -g @openai/codex' "$OUT" "a probe that hangs reads as unknown"
  [ "$elapsed" -lt 10 ] || fail "a hanging probe held the answer for ${elapsed}s"
  pass "fm-agents.sh: a sign-in probe that hangs is cut off and reads as unknown"
}

test_sign_in_names_the_command() {
  local out rc
  out=$("$AGENTS" sign-in claude) || fail "sign-in claude failed"
  assert_equals "claude auth login" "$out" "claude signs in with its own login"
  out=$("$AGENTS" sign-in codex) || fail "sign-in codex failed"
  assert_equals "codex login" "$out" "codex signs in with its own login"
  rc=0
  out=$("$AGENTS" sign-in grok 2>&1) || rc=$?
  expect_code 1 "$rc" "no sign-in command for grok"
  assert_contains "$out" "knows no sign-in command for 'grok'" "and it says so"
  pass "fm-agents.sh: sign-in names each agent's own login, and refuses one it does not know"
}

test_usage() {
  local rc args
  for args in "" "status" "sign-in" "sign-in claude codex" "status Claude" "status ../x" "frobnicate"; do
    rc=0
    # shellcheck disable=SC2086
    "$AGENTS" $args >/dev/null 2>&1 || rc=$?
    expect_code 2 "$rc" "usage error for '$args'"
  done
  pass "fm-agents.sh: anything but status <harness>... or sign-in <harness> is a usage error"
}

test_reports_each_agent_as_named
test_uncertain_answers_read_as_unknown
test_a_hanging_probe_is_cut_off
test_sign_in_names_the_command
test_usage
