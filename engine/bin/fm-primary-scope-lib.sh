#!/usr/bin/env bash
# Shared marker, plain-checkout, or installed-copy predicate for tracked hooks
# that must act only in a genuine firstmate primary home.
# This file is sourced by hook entrypoints and has no side effects on source.

# Return 0 when $1 carries a genuine secondmate-home marker.
fm_root_is_secondmate_home() {
  local marker="$1/.fm-secondmate-home" id LC_ALL=C
  [ -L "$marker" ] && return 1
  [ -f "$marker" ] || return 1
  IFS= read -r id < "$marker" 2>/dev/null || return 1
  id=${id//[[:space:]]/}
  [ -n "$id" ] || return 1
  case "$id" in
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

# Return 0 when $1 carries the marker bin/fm-home-init.sh writes into a home it
# laid out, naming the code that home mirrors. Such a home is a home wherever it
# sits: it is the app's own, in the app's data folder, which is nobody's
# checkout until somebody puts their data folder under version control.
fm_root_is_mirrored_home() {
  local marker="$1/.fm-home" line LC_ALL=C
  [ -L "$marker" ] && return 1
  [ -f "$marker" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      code=?*) return 0 ;;
    esac
  done < "$marker"
  return 1
}

# Return 0 when $1 is a genuine primary root whose effective state dir is $2.
# A valid secondmate marker force-includes a linked secondmate home.
# A root git places inside a work tree is judged as a checkout: primary only
# when it is the top of that work tree and the work tree is a plain checkout,
# never a linked task worktree and never a directory within either. A root git
# places in no work tree at all is firstmate installed as a copy, inside an app
# whose home mirrors it, and is primary wherever it sits; such a home lives in
# the app's data folder, which is nobody's checkout.
# The difference is what git says, not whether the root carries .git of its
# own. The engine ships as a subdirectory of the app's repository, so a root
# with no .git of its own can still sit in a checkout or in a disposable
# worktree: engine/ is the first mate's code, not a home, and one stray state/
# there must not turn a task worktree into one.
# A root git cannot be asked about at all, because git is not there, is refused
# rather than taken for a copy: the answer that arms watchers is the one that
# costs something to get wrong. So is a root carrying a .git git will not
# answer for, such as a broken worktree link.
fm_primary_scope_matches() {
  local root=$1 state=$2 git_dir git_common_dir top
  if ! fm_root_is_secondmate_home "$root" && ! fm_root_is_mirrored_home "$root"; then
    # Asked of git itself, so a git that is missing and a git that cannot run
    # are the same answer: without one there is no telling a checkout from a
    # copy, and the reading that arms watchers is the one that costs something
    # to get wrong, so it is refused. A home the app laid out says what it is
    # above and never reaches this.
    git --version >/dev/null 2>&1 || return 1
    if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || return 1
      [ "$(CDPATH='' cd -- "$top" 2>/dev/null && pwd -P)" \
        = "$(CDPATH='' cd -- "$root" 2>/dev/null && pwd -P)" ] || return 1
      # Absolute on both sides: git answers --git-dir absolute and
      # --git-common-dir relative in some layouts, and the two would never
      # compare equal.
      git_dir=$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null) || return 1
      git_common_dir=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
      [ "$git_dir" = "$git_common_dir" ] || return 1
    elif [ -e "$root/.git" ] || [ -L "$root/.git" ]; then
      return 1
    fi
  fi
  [ -f "$root/AGENTS.md" ] || return 1
  [ -d "$root/bin" ] || return 1
  [ -d "$state" ] || return 1
}
