#!/usr/bin/env bash
# fm-decision-options.sh - retired: a call's options belong to the call.
#
# bin/fm-captain-hold.sh is the only writer of anything about a captain call,
# and the options a call offers are part of its record there (state/calls/).
# This script remains for one release as a thin shim so briefs and habits that
# predate the move keep working; `fm-captain-hold.sh migrate` imports the
# records this script used to write under state/decision-options/.
#
# Usage:
#   fm-decision-options.sh set <task-id> --option <key>=<label> [--option ...]
#                          [--recommend <key>] [--question <text>]
#
# set
#   Runs `fm-captain-hold.sh offer <task-id>` with the same flags, so the task
#   must now be an open captain call.
#
# show, list, and clear are gone: read calls with `fm-captain-hold.sh list`,
# and replace a call's options with `fm-captain-hold.sh offer`.
#
# Exit codes: those of `fm-captain-hold.sh offer`; 2 usage or a retired command.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  set)
    shift
    [ "$#" -ge 1 ] || { sed -n '12,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }
    exec "$SCRIPT_DIR/fm-captain-hold.sh" offer "$@"
    ;;
  show|list|clear)
    echo "fm-decision-options: '$1' is retired; read calls with fm-captain-hold.sh list and change their options with fm-captain-hold.sh offer" >&2
    exit 2
    ;;
  *)
    sed -n '12,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
