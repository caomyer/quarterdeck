#!/usr/bin/env bash
# fm-home-init.sh - create or refresh a firstmate home that mirrors this copy of
# firstmate's code.
#
# Usage: fm-home-init.sh [--home <dir>]
#        fm-home-init.sh --help
#
# A home is where firstmate keeps what it does: data/, state/, config/,
# projects/, and the other paths .gitignore keeps out of the code. Most homes
# are a git checkout of firstmate, where code and home share one directory.
# Firstmate installed inside an app is a read-only copy of the code that is no
# git checkout, and its home lives elsewhere. This script makes such a home look
# to the harness and to every script exactly like a checkout: each top-level
# entry of the code (bin/, docs/, AGENTS.md, CLAUDE.md, .agents/, .tasks.toml,
# ...) is a symlink into the code, and the home's own directories are real.
# .claude/ is a real directory whose entries link into the code's .claude/, so
# the harness can still write its own local settings there. A relative
# `bin/...` path, a printed hint, and a hook command built from the project
# directory all resolve from the home, and a write aimed at the code fails on
# the read-only copy instead of changing it.
#
# The home is --home, else FM_HOME. The code is the copy this script belongs to,
# by its physical path. Run it on every launch: it is idempotent, and it
# repoints links when the code has moved (an app update or a moved app),
# links entries a newer code added, and removes links to entries the code no
# longer has. A real file or directory in the home where the code has an entry
# is the home's own and is kept, and reported.
#
# Refused, with nothing changed: a home that is the code, lies inside it, or
# contains it; a home that is itself a git checkout of firstmate (it already
# carries its code); a home path that exists and is not a directory.
#
# Output: `home: <path>`, `code: <path>`, then one line per change -
# `linked: <name>`, `relinked: <name>`, `unlinked: <name>`, `kept: <name> (...)`
# - and `ok` at the end.
#
# Exit status: 0 the home mirrors the code, 1 refused or failed, 2 usage.
set -u

usage() {
  awk '
    NR == 1 { next }
    /^#/ { sub(/^# ?/, ""); print; next }
    { exit }
  ' "$0"
}

usage_fail() {
  printf 'fm-home-init: %s\n' "$*" >&2
  printf 'usage: fm-home-init.sh [--home <dir>]\n' >&2
  exit 2
}

fail() {
  printf 'fm-home-init: %s\n' "$*" >&2
  exit 1
}

home=${FM_HOME:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --home)
      [ "$#" -ge 2 ] || usage_fail "--home needs a directory"
      home=$2
      shift
      ;;
    --home=*) home=${1#--home=} ;;
    *) usage_fail "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$home" ] || usage_fail "name the home with --home or FM_HOME"

# is_firstmate_code <dir>: whether <dir> is a copy of firstmate's code.
is_firstmate_code() {
  [ -f "$1/AGENTS.md" ] && [ -d "$1/bin" ]
}

CODE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) || fail "cannot resolve this copy of firstmate"
is_firstmate_code "$CODE" || fail "$CODE is not a copy of firstmate"

# What belongs to a home, never to the code: the paths .gitignore keeps out of
# a checkout, the harness's own directory, and git's. tests/fm-home-init.test.sh
# checks this list against .gitignore.
HOME_OWNED='data state config projects .no-mistakes .lavish .fm-secondmate-home .fm-secondmate-parent .env .tools .DS_Store __pycache__ .git .claude'

home_owned() {  # <name>
  case "$1" in
    scratchpad*|*.pyc) return 0 ;;
  esac
  case " $HOME_OWNED " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

if [ -e "$home" ] || [ -L "$home" ]; then
  [ -d "$home" ] || fail "$home exists and is not a directory"
fi
mkdir -p "$home" || fail "cannot create $home"
HOME_DIR=$(cd "$home" && pwd -P) || fail "cannot resolve $home"

case "$HOME_DIR/" in
  "$CODE/"*) fail "the home $HOME_DIR is, or lies inside, the code at $CODE" ;;
esac
case "$CODE/" in
  "$HOME_DIR/"*) fail "the code $CODE lies inside the home $HOME_DIR" ;;
esac
if [ -d "$HOME_DIR/.git" ] && [ -d "$HOME_DIR/bin" ] && [ ! -L "$HOME_DIR/bin" ]; then
  fail "$HOME_DIR is a git checkout of firstmate, which carries its own code"
fi

printf 'home: %s\n' "$HOME_DIR"
printf 'code: %s\n' "$CODE"

for dir in data state config projects .claude; do
  mkdir -p "$HOME_DIR/$dir" || fail "cannot create $HOME_DIR/$dir"
done

# mirror <code-dir> <home-dir> <label-prefix> <skip-fn> <depth>
# Link every entry of <code-dir> that <skip-fn> does not claim into <home-dir>,
# and remove links in <home-dir> to entries the code no longer has. <depth> is
# how far <code-dir> sits below its code root: 0 for the root, 1 for .claude.
mirror() {
  local from=$1 to=$2 prefix=$3 skip=$4 depth=$5 path name target current root
  for path in "$from"/* "$from"/.[!.]* "$from"/..?*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    name=${path##*/}
    "$skip" "$name" && continue
    target="$from/$name"
    if [ -L "$to/$name" ]; then
      current=$(readlink "$to/$name")
      [ "$current" = "$target" ] && continue
      rm -f -- "$to/$name" || fail "cannot replace the link $to/$name"
      ln -s "$target" "$to/$name" || fail "cannot link $to/$name"
      printf 'relinked: %s%s\n' "$prefix" "$name"
    elif [ -e "$to/$name" ]; then
      printf 'kept: %s%s (the home'"'"'s own, not the code'"'"'s)\n' "$prefix" "$name"
    else
      ln -s "$target" "$to/$name" || fail "cannot link $to/$name"
      printf 'linked: %s%s\n' "$prefix" "$name"
    fi
  done
  # A link this script made points at the entry of the same name in a copy of
  # firstmate: this one, an older one that moved away, or one gone entirely.
  # Such a link to an entry this code does not have is removed. Other links are
  # the home's own and are left alone.
  for path in "$to"/* "$to"/.[!.]* "$to"/..?*; do
    [ -L "$path" ] || continue
    name=${path##*/}
    # A home-owned name is never this script's, even as a link: a data/ kept
    # elsewhere stays exactly where the home put it.
    "$skip" "$name" && continue
    current=$(readlink "$path")
    [ "${current##*/}" = "$name" ] || continue
    { [ -e "$from/$name" ] || [ -L "$from/$name" ]; } && continue
    root=${current%/*}
    [ "$depth" = 1 ] && root=${root%/*}
    [ -e "$path" ] && ! is_firstmate_code "$root" && continue
    rm -f -- "$path" || fail "cannot remove the stale link $path"
    printf 'unlinked: %s%s\n' "$prefix" "$name"
  done
}

top_skip() { home_owned "$1"; }
# The harness writes its own local settings beside the tracked ones.
claude_skip() { [ "$1" = settings.local.json ]; }

mirror "$CODE" "$HOME_DIR" "" top_skip 0
if [ -d "$CODE/.claude" ]; then
  mirror "$CODE/.claude" "$HOME_DIR/.claude" ".claude/" claude_skip 1
fi

printf 'ok\n'
