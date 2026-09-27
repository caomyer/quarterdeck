#!/usr/bin/env bash
# tests/fake-tmux-liveness.sh - sourced by the fake `tmux` stubs spawn tests put
# on PATH, as their first line after the shebang:
#   . "${FM_TEST_FAKE_TMUX_LIVENESS:?}"
# tests/lib.sh exports that path, so a stub written from a quoted heredoc can
# reach it without interpolation.
#
# bin/fm-spawn.sh does not report a launch delivered until the endpoint reads
# `alive` through bin/backends/tmux.sh's fm_backend_tmux_agent_state. That
# classifier needs the window in its session's inventory and a harness in the
# pane, so a stub that only ever answers "ok" would read `missing` and every
# spawn would fail. This models just that: a window the stub created stays in
# the inventory until the stub kills it, and its pane runs a harness
# (FM_FAKE_PANE_COMMAND, default claude). A stub that answers these queries
# itself - to model a dead pane, say - handles them before sourcing this file.
# The inventory lives beside the stub, or at FM_FAKE_TMUX_WINDOWS_FILE.

# shellcheck source=tests/fake-tmux-typed.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/fake-tmux-typed.sh"

fm_fake_tmux_windows_file=${FM_FAKE_TMUX_WINDOWS_FILE:-$(dirname -- "$0")/.fake-tmux-windows}
case "${1:-}" in
  new-window)
    fm_fake_tmux_prev=
    for fm_fake_tmux_arg in "$@"; do
      [ "$fm_fake_tmux_prev" != -n ] || printf '%s\n' "$fm_fake_tmux_arg" >> "$fm_fake_tmux_windows_file"
      fm_fake_tmux_prev=$fm_fake_tmux_arg
    done
    ;;
  kill-window)
    fm_fake_tmux_prev=
    for fm_fake_tmux_arg in "$@"; do
      if [ "$fm_fake_tmux_prev" = -t ] && [ -f "$fm_fake_tmux_windows_file" ]; then
        fm_fake_tmux_name=${fm_fake_tmux_arg##*:}
        fm_fake_tmux_name=${fm_fake_tmux_name#=}
        grep -vxF -- "$fm_fake_tmux_name" "$fm_fake_tmux_windows_file" > "$fm_fake_tmux_windows_file.tmp" || true
        mv -f "$fm_fake_tmux_windows_file.tmp" "$fm_fake_tmux_windows_file"
      fi
      fm_fake_tmux_prev=$fm_fake_tmux_arg
    done
    ;;
  list-windows)
    # Only the bare name inventory is modeled, printed ahead of whatever the
    # stub itself prints.
    case " $* " in
      *" #{window_name} "*) [ ! -f "$fm_fake_tmux_windows_file" ] || cat "$fm_fake_tmux_windows_file" ;;
    esac
    ;;
esac
case "$*" in
  *'#{pane_current_command}'*) printf '%s\n' "${FM_FAKE_PANE_COMMAND:-claude}"; exit 0 ;;
  *'#{pane_tty}'*) exit 0 ;;
esac

