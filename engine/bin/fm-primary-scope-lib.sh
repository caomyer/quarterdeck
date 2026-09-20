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

# Return 0 when $1 is a genuine primary root whose effective state dir is $2.
# A valid secondmate marker force-includes a linked secondmate home.
# A root git places inside a work tree is judged as a checkout: only a plain
# one is primary, never a linked task worktree, whether the root is that
# checkout's top or a directory within it. A root with no work tree around it
# is firstmate installed as a copy, inside an app whose home mirrors it, and is
# primary wherever it sits. The difference is what git says, not whether the
# root itself carries .git: the engine ships as a subdirectory of the app's
# repository, so a root without .git of its own can still sit in a disposable
# worktree, where arming a watcher would be wrong.
# A root that carries .git but that git cannot answer for (git off PATH, a
# broken worktree link) is refused rather than taken for a copy.
fm_primary_scope_matches() {
  local root=$1 state=$2 git_dir git_common_dir
  if ! fm_root_is_secondmate_home "$root"; then
    if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      # Absolute on both sides: asked from a subdirectory of a checkout, git
      # answers --git-dir absolute and --git-common-dir relative, and the two
      # would never compare equal.
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
