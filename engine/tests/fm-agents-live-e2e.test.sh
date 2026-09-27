#!/usr/bin/env bash
# Live guard for bin/fm-agents.sh against the real Claude Code and Codex CLIs.
# Its sign-in reading rests on each vendor's own status command exiting 0 when
# signed in and 1 when not, so this proves that with every installed one:
# pointed at an empty config folder, each reads as signed out, never signed in
# or unknown; its version is the one its own --version prints; and whatever it
# reads for this machine's real sign-in is a definite answer. Spends no model
# tokens, so it runs wherever either CLI is installed; FM_AGENTS_LIVE=0 or
# FM_LIVE=0 turns it off, and FM_AGENTS_LIVE=1 makes an absent CLI a failure.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

AGENTS="$ROOT/bin/fm-agents.sh"
TMP_ROOT=$(fm_test_tmproot fm-agents-live)

fm_live_gate default-on FM_AGENTS_LIVE

# The folder each CLI reads its sign-in from, as an environment override.
config_var() {
  case "$1" in
    claude) printf 'CLAUDE_CONFIG_DIR\n' ;;
    codex) printf 'CODEX_HOME\n' ;;
  esac
}

checked=0
for harness in claude codex; do
  if ! command -v "$harness" >/dev/null 2>&1; then
    [ "${FM_AGENTS_LIVE:-${FM_LIVE:-}}" = 1 ] && fail "FM_AGENTS_LIVE=1 but $harness is not installed"
    printf 'skip: %s is not installed\n' "$harness"
    continue
  fi
  expected=$("$harness" --version 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n 1)
  [ -n "$expected" ] || fail "$harness --version printed no version"

  empty="$TMP_ROOT/$harness-empty"
  mkdir -p "$empty"
  line=$(env "$(config_var "$harness")=$empty" "$AGENTS" status "$harness") || fail "status $harness failed"
  assert_equals "$harness" "$(cut -f1 <<< "$line")" "$harness: the line names it"
  assert_equals installed "$(cut -f2 <<< "$line")" "$harness: installed"
  assert_equals "$expected" "$(cut -f3 <<< "$line")" "$harness $expected: the version is its own"
  assert_equals signed-out "$(cut -f4 <<< "$line")" "$harness $expected: an empty config folder reads as signed out"

  line=$("$AGENTS" status "$harness") || fail "status $harness failed"
  case "$(cut -f4 <<< "$line")" in
    signed-in|signed-out) ;;
    *) fail "$harness $expected: this machine's own sign-in read as '$(cut -f4 <<< "$line")', not a definite answer" ;;
  esac
  pass "fm-agents.sh reads $harness $expected: version, and signed out from an empty config folder"
  checked=$((checked + 1))
done
[ "$checked" -gt 0 ] || { printf 'skip: live: neither claude nor codex is installed\n'; exit 0; }
