#!/usr/bin/env bash
# tests/fake-tmux-typed.sh - sourced by fake `tmux` stubs that inspect what the
# spawn types into a pane (tests/lib.sh exports its path as
# FM_TEST_FAKE_TMUX_TYPED); tests/fake-tmux-liveness.sh sources it too.

# fm_fake_tmux_typed <literal>: what a pane shell runs for one typed literal.
# bin/fm-spawn.sh types only `. /tmp/fm-<id>/launch.sh` and keeps the launch
# command in that file, so a stub that logs launches for a test to inspect
# logs the file's command in place of the line that sources it.
fm_fake_tmux_typed() {
  case "$1" in
    ". /tmp/fm-"*"/launch.sh")
      if [ -f "${1#. }" ]; then
        printf '%s' "$(cat -- "${1#. }")"
        return 0
      fi
      ;;
  esac
  printf '%s' "$1"
}
