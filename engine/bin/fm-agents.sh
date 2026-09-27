#!/usr/bin/env bash
# fm-agents.sh - what this machine has of the agents firstmate runs on, for a
# captain setting it up: installed or not, which version, signed in or not, and
# how to install it and sign in.
#
# Usage:
#   fm-agents.sh status <harness>...
#   fm-agents.sh sign-in <harness>
#
# status
#   Prints one tab-separated line per named harness, in the order named:
#     <harness>\t<installed|missing>\t<version>\t<signed-in|signed-out|unknown>\t<install>
#   <version> is the first dotted number the harness's own --version prints,
#   or "-" when it is missing or says none. Sign-in is read from the harness's
#   own status command, which spends nothing and changes nothing: exit 0 is
#   signed-in, exit 1 is signed-out, and anything else, a harness without such
#   a command, or one that is missing reads as unknown. <install> is the
#   command that installs the harness, or "-" when firstmate knows none.
#   Whether a harness is installed is resolved exactly as a spawn on it would
#   resolve it (bin/fm-harness-bin-lib.sh), so this never disagrees with
#   bin/fm-crew-dispatch.sh harnesses or with bin/fm-spawn.sh.
#   A harness this script has no line for is still reported, as installed or
#   missing, with unknown sign-in and no install command. Needs no jq, so it
#   answers on a machine that has nothing yet.
#
# sign-in
#   Prints the command a person runs, in a terminal, to sign <harness> in.
#   Exit 1 when firstmate knows none.
#
# This is the one place firstmate keeps how its agents are installed and
# signed in, as bin/fm-bootstrap.sh is for the tools around them; an app that
# offers to install or sign one in asks here rather than keeping a copy.
#
# Exit codes: 0 success; 1 no sign-in command for that harness; 2 usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-harness-bin-lib.sh
. "$SCRIPT_DIR/fm-harness-bin-lib.sh"
# shellcheck source=bin/fm-timeout-lib.sh
. "$SCRIPT_DIR/fm-timeout-lib.sh"

# A status or version probe that hangs must not hang whoever asked.
PROBE_SECONDS=${FM_AGENTS_PROBE_SECONDS:-15}
case "$PROBE_SECONDS" in ''|*[!0-9]*|0) PROBE_SECONDS=15 ;; esac

usage() {
  sed -n '6,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# The command that installs a harness, from the harness's own documentation.
install_line() {
  case "$1" in
    claude) printf '%s\n' 'curl -fsSL https://claude.ai/install.sh | bash' ;;
    codex) printf '%s\n' 'npm install -g @openai/codex' ;;
    *) return 1 ;;
  esac
}

# The command a person runs to sign a harness in.
sign_in_line() {
  case "$1" in
    claude) printf '%s\n' 'claude auth login' ;;
    codex) printf '%s\n' 'codex login' ;;
    *) return 1 ;;
  esac
}

# The harness's own read-only sign-in status, as argv.
sign_in_probe() {
  case "$1" in
    claude) printf '%s\n' claude auth status ;;
    codex) printf '%s\n' codex login status ;;
    *) return 1 ;;
  esac
}

executable_of() {
  case "$1" in
    kimi) resolve_kimi_binary 2>/dev/null ;;
    muse) resolve_muse_binary 2>/dev/null ;;
    rovo) resolve_rovo_binary 2>/dev/null ;;
    cursor) fm_cursor_resolve_binary 2>/dev/null ;;
    *) resolve_pi_executable "$1" 2>/dev/null ;;
  esac
}

version_of() {
  local executable=$1 said
  said=$(fm_run_timed "$PROBE_SECONDS" "$executable" --version 2>/dev/null </dev/null) || true
  said=$(printf '%s\n' "$said" | grep -Eo '[0-9]+(\.[0-9]+)+' | head -n 1)
  printf '%s\n' "${said:--}"
}

signed_in_of() {
  local harness=$1 executable=$2 probe rc
  probe=$(sign_in_probe "$harness") || { printf 'unknown\n'; return 0; }
  # The probe's first word is the harness; run the resolved executable in its place.
  # shellcheck disable=SC2086
  set -- $probe
  shift
  fm_run_timed "$PROBE_SECONDS" "$executable" "$@" >/dev/null 2>&1 </dev/null
  rc=$?
  case "$rc" in
    0) printf 'signed-in\n' ;;
    1) printf 'signed-out\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

cmd_status() {
  local harness executable installed version signed install
  [ "$#" -gt 0 ] || usage
  for harness in "$@"; do
    case "$harness" in
      ''|*[!a-z0-9-]*) echo "fm-agents: not a harness name: '$harness'" >&2; exit 2 ;;
    esac
  done
  for harness in "$@"; do
    install=$(install_line "$harness") || install=-
    if fm_harness_installed "$harness" && executable=$(executable_of "$harness") && [ -n "$executable" ]; then
      installed=installed
      version=$(version_of "$executable")
      signed=$(signed_in_of "$harness" "$executable")
    else
      installed=missing
      version=-
      signed=unknown
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$harness" "$installed" "$version" "$signed" "$install"
  done
}

cmd_sign_in() {
  [ "$#" -eq 1 ] || usage
  sign_in_line "$1" || { echo "fm-agents: firstmate knows no sign-in command for '$1'" >&2; exit 1; }
}

command=${1-}
[ -n "$command" ] || usage
shift
case "$command" in
  status) cmd_status "$@" ;;
  sign-in) cmd_sign_in "$@" ;;
  -h|--help) sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) usage ;;
esac
