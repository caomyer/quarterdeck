#!/usr/bin/env bash
# fm-calm.sh - read or set this home's Calm preference, config/calm.
#
# Usage:
#   fm-calm.sh get
#   fm-calm.sh set on|off
#
# Calm is the captain's one choice about how the first mate's conversation
# reads: docs/calm.md owns what it hides and shows on each surface, and
# docs/configuration.md ("Calm preference") owns the file. This script is the
# writer for anything outside the two harness integrations, which write the
# file themselves: an app drawing the conversation reads and sets the same
# choice here, so one switch governs every surface of the home.
#
# The file is resolved exactly as both integrations resolve it: the config
# directory is FM_CONFIG_OVERRIDE when set, otherwise config/ under FM_HOME,
# then FM_ROOT_OVERRIDE, then the code root this script lives in.
#
# get
#   Prints "on" or "off". "on" and the legacy "max" read as on; an absent,
#   unreadable or unrecognized value reads as off, as it does everywhere else.
#
# set on|off
#   Writes "on" or "off" and one newline, replacing the file atomically through
#   a temporary file in the same directory, so a reader never sees half a
#   value. A write that fails leaves the previous choice in place and says why.
#   Prints the value now in force.
#
# Exit codes: 0 success; 1 the preference could not be written; 2 usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
CONFIG_DIR="${FM_CONFIG_OVERRIDE:-$HOME_DIR/config}"
CALM_FILE="$CONFIG_DIR/calm"

usage() {
  sed -n '4,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "fm-calm: $*" >&2
  exit 1
}

read_calm() {
  local stored=""
  if [ -f "$CALM_FILE" ] && [ -r "$CALM_FILE" ]; then
    stored=$(tr -d '[:space:]' < "$CALM_FILE" 2>/dev/null) || stored=""
  fi
  case "$stored" in
    on|max) printf 'on\n' ;;
    *) printf 'off\n' ;;
  esac
}

write_calm() {
  local value="$1" tmp err
  err=$(mkdir -p "$CONFIG_DIR" 2>&1) || die "config/calm: ${err##*: }"
  tmp="$CALM_FILE.$$.tmp"
  # The temporary file is created in the same directory so the rename is atomic.
  if ! err=$( { printf '%s\n' "$value" > "$tmp"; } 2>&1 ); then
    rm -f "$tmp"
    die "config/calm: ${err##*: }"
  fi
  if ! err=$(mv -f "$tmp" "$CALM_FILE" 2>&1); then
    rm -f "$tmp"
    die "config/calm: ${err##*: }"
  fi
}

[ $# -ge 1 ] || usage
case "$1" in
  get)
    [ $# -eq 1 ] || usage
    read_calm
    ;;
  set)
    [ $# -eq 2 ] || usage
    case "$2" in
      on|off) ;;
      *) usage ;;
    esac
    write_calm "$2"
    read_calm
    ;;
  *)
    usage
    ;;
esac
