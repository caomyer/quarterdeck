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
# by its physical path, however the script was reached (a home's bin/ link
# included). A home this script lays out carries a `.fm-home` marker naming the
# code it mirrors and every code it mirrored before; the marker is written
# before anything is laid out, so a run cut short leaves a home the next run
# finishes.
#
# Run it on every launch: it is idempotent, and it repoints its links when the
# code has moved (an app update or a moved app), links entries a newer code
# added, and removes its links to entries the code no longer has. Its links are
# exactly those that point at the entry of the same name in this code or in a
# code the marker records; every other file and link in the home is the home's
# own and is never changed, only reported as `kept` where the code has an entry
# of that name. Links are swapped in by rename, so a first mate already running
# in the home never sees an entry missing, and concurrent runs take turns.
#
# Refused, with nothing created or changed: a home that is the code, lies
# inside it, or contains it; an existing directory that is neither empty nor
# already a firstmate home (a checkout, a user's home directory, /; a Finder
# .DS_Store does not count); a home path that exists and is not a directory; a
# home path with a . or .. component.
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
case "$home" in
  /*) ;;
  *) home="$PWD/$home" ;;
esac
case "/$home/" in
  */./*|*/../*) usage_fail "name the home without . or .. in its path: $home" ;;
esac

MARKER=.fm-home

# is_firstmate_code <dir>: whether <dir> is a copy of firstmate's code.
is_firstmate_code() {
  [ -f "$1/AGENTS.md" ] && [ -d "$1/bin" ]
}

# physical <path>: the absolute <path> with its existing part resolved and the
# part that does not exist yet appended as given. Creates nothing; fails when a
# component exists and is not a directory.
physical() {
  local path=${1%/} rest='' dir
  while [ -n "$path" ] && [ ! -d "$path" ]; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      return 1
    fi
    rest="/${path##*/}$rest"
    path=${path%/*}
  done
  dir=$(CDPATH='' cd -P -- "${path:-/}" && pwd -P) || return 1
  [ "$dir" = / ] && dir=''
  printf '%s\n' "$dir$rest"
}

CODE=$(CDPATH='' cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P) \
  || fail "cannot resolve this copy of firstmate"
is_firstmate_code "$CODE" || fail "$CODE is not a copy of firstmate"

HOME_DIR=$(physical "$home") || fail "$home exists and is not a directory"
[ -n "$HOME_DIR" ] || HOME_DIR=/

case "$HOME_DIR/" in
  "$CODE/"*) fail "the home $HOME_DIR is, or lies inside, the code at $CODE" ;;
esac
case "$CODE/" in
  "${HOME_DIR%/}/"*) fail "the code $CODE lies inside the home $HOME_DIR" ;;
esac
# unclaimed <dir>: whether <dir> holds nothing but what a concurrent run of this
# script or the Finder leaves there, so it may become a home.
unclaimed() {
  local entry name
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    case "$name" in
      .fm-home-init.*|.DS_Store) continue ;;
    esac
    return 1
  done
  return 0
}

# Only an empty or missing directory becomes a home, and only a home this
# script laid out is refreshed: a checkout, a user's home directory, or any
# other folder with contents is never taken over. Checked before anything is
# created, and again under the lock.
if [ -d "$HOME_DIR" ] && [ ! -f "$HOME_DIR/$MARKER" ] && ! unclaimed "$HOME_DIR"; then
  fail "$HOME_DIR is not empty and is not a firstmate home"
fi

mkdir -p -- "$HOME_DIR" || fail "cannot create $HOME_DIR"

# Concurrent runs take turns, under firstmate's own lock (bin/fm-wake-lib.sh),
# which records its owner atomically and recovers a lock whose owner died.
# Loaded only now, once nothing is refused, and told not to create the home's
# state directory itself.
FM_HOME=$HOME_DIR
STATE="$HOME_DIR/state"
FM_WAKE_READ_ONLY=1
# shellcheck source=bin/fm-wake-lib.sh
. "$CODE/bin/fm-wake-lib.sh"
LOCK="$HOME_DIR/.fm-home-init.lock"
trap 'fm_lock_release "$LOCK" >/dev/null 2>&1' EXIT
# A run takes about a second, and a launch starts one, so a wait of more than a
# few seconds means the other run is wedged: say so, and give up soon enough to
# be a clear failure rather than a silent launch stall. The budget is a number
# of tries, not a deadline: 125 tries come to about half a minute at idle, and
# longer under load, which is what a run queued behind several others needs.
# FM_HOME_INIT_LOCK_TRIES sets the count, for tests.
lock_tries=${FM_HOME_INIT_LOCK_TRIES:-125}
# A count this shell can compare; anything else is the default.
case "$lock_tries" in ''|*[!0-9]*|??????*) lock_tries=125 ;; esac
lock_waited=0
until fm_lock_try_acquire "$LOCK"; do
  lock_waited=$((lock_waited + 1))
  [ "$lock_waited" != $(((lock_tries / 8) + 1)) ] \
    || printf 'fm-home-init: waiting for another fm-home-init.sh to finish with %s\n' "$HOME_DIR" >&2
  [ "$lock_waited" -le "$lock_tries" ] || fail "another fm-home-init.sh still holds $LOCK; nothing was changed"
  sleep 0.2
done

if [ ! -f "$HOME_DIR/$MARKER" ] && ! unclaimed "$HOME_DIR"; then
  fail "$HOME_DIR is not empty and is not a firstmate home"
fi

# A run killed partway leaves its temporary links and marker behind, and the
# lock leaves owner and steal records. Under the lock, clear the ones whose run
# is gone: an entry that names its run's pid, or holds one in a pid file, is
# gone when that process is; one that names no pid at all (a record whose owner
# died before writing it) is gone once it is over a minute old, which no live
# run's is. The live lock and its owner are always kept.
LIVE_OWNER=$(fm_lock_link_owner "$LOCK" 2>/dev/null || true)
sweep_leftovers() {  # <dir>
  local entry name owner_pid
  for entry in "$1"/.fm-home-init.*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    [ "$name" = .fm-home-init.lock ] && continue
    [ "$entry" = "$LIVE_OWNER" ] && continue
    owner_pid=${name#.fm-home-init.}
    owner_pid=${owner_pid%%.*}
    case "$owner_pid" in
      ''|*[!0-9]*) owner_pid=$(cat -- "$entry/pid" 2>/dev/null || true) ;;
    esac
    case "$owner_pid" in
      ''|*[!0-9]*)
        # No pid to ask about: only age tells a dead record from a live one.
        [ -n "$(find "$entry" -maxdepth 0 -mmin +1 2>/dev/null)" ] || continue
        ;;
      *) kill -0 "$owner_pid" 2>/dev/null && continue ;;
    esac
    rm -rf -- "$entry"
  done
}
sweep_leftovers "$HOME_DIR"
sweep_leftovers "$HOME_DIR/.claude"

# Every code this home has mirrored, current first. A link into any of them is
# this script's; a recorded path that now holds something other than firstmate
# is not trusted. The marker is rewritten before anything is laid out, so a run
# cut short leaves a home the next run recognises and finishes.
KNOWN=''
if [ -f "$HOME_DIR/$MARKER" ]; then
  while IFS= read -r line; do
    case "$line" in
      code=/*|previous=/*) path=${line#*=} ;;
      *) continue ;;
    esac
    [ "$path" = "$CODE" ] && continue
    if [ -e "$path" ] && ! is_firstmate_code "$path"; then
      continue
    fi
    case "
$KNOWN
" in
      *"
$path
"*) ;;
      *) KNOWN="${KNOWN:+$KNOWN
}$path" ;;
    esac
  done < "$HOME_DIR/$MARKER"
fi
marker_tmp="$HOME_DIR/.fm-home-init.$$.marker"
{
  printf 'firstmate-home=1\ncode=%s\n' "$CODE"
  [ -z "$KNOWN" ] || printf '%s\n' "$KNOWN" | sed 's/^/previous=/'
} > "$marker_tmp" || fail "cannot write $HOME_DIR/$MARKER"
mv -f -- "$marker_tmp" "$HOME_DIR/$MARKER" || { rm -f -- "$marker_tmp"; fail "cannot write $HOME_DIR/$MARKER"; }

printf 'home: %s\n' "$HOME_DIR"
printf 'code: %s\n' "$CODE"

for dir in data state config projects .claude; do
  mkdir -p -- "$HOME_DIR/$dir" || fail "cannot create $HOME_DIR/$dir"
done

# What belongs to a home, never to the code: the paths .gitignore keeps out of
# a checkout, the harness's own directory, git's, and this script's own files.
# tests/fm-home-init.test.sh checks this list against .gitignore.
HOME_OWNED='data state config projects .no-mistakes .lavish .fm-secondmate-home .fm-secondmate-parent .env .tools .DS_Store __pycache__ .git .claude .fm-home .fm-home-init.lock'

home_owned() {  # <name>
  case "$1" in
    scratchpad*|*.pyc|.fm-home-init.*) return 0 ;;
  esac
  case " $HOME_OWNED " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# ours <link-path> <rel>: whether the link at <link-path> is one this script
# made for <rel>, a path relative to a code root: it points at <rel> in this
# code or in a code the marker records.
ours() {
  local current known
  current=$(readlink -- "$1") || return 1
  [ "$current" = "$CODE/$2" ] && return 0
  while IFS= read -r known; do
    [ -n "$known" ] && [ "$current" = "$known/$2" ] && return 0
  done <<EOF_KNOWN
$KNOWN
EOF_KNOWN
  return 1
}

# swap_link <target> <path>: point <path> at <target> by renaming a new link
# over it, so the entry never goes missing. GNU mv takes -T, BSD mv -h; both
# replace a link to a directory instead of moving into it.
swap_link() {
  local tmp="${2%/*}/.fm-home-init.$$.${2##*/}"
  rm -f -- "$tmp"
  ln -s -- "$1" "$tmp" || return 1
  if mv -f -T -- "$tmp" "$2" 2>/dev/null || mv -f -h -- "$tmp" "$2" 2>/dev/null; then
    return 0
  fi
  rm -f -- "$tmp"
  return 1
}

# mirror <rel-dir> <skip-fn>: link every entry of the code's <rel-dir> ("" for
# the root) that <skip-fn> does not claim into the same place in the home, and
# remove this script's links to entries the code no longer has.
mirror() {
  local rel=$1 skip=$2 from to prefix path name
  from="$CODE${rel:+/$rel}"
  to="$HOME_DIR${rel:+/$rel}"
  prefix="${rel:+$rel/}"
  for path in "$from"/* "$from"/.[!.]* "$from"/..?*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    name=${path##*/}
    "$skip" "$name" && continue
    if [ -L "$to/$name" ]; then
      [ "$(readlink -- "$to/$name")" = "$from/$name" ] && continue
      if ours "$to/$name" "$prefix$name"; then
        swap_link "$from/$name" "$to/$name" || fail "cannot relink $to/$name"
        printf 'relinked: %s%s\n' "$prefix" "$name"
      else
        printf 'kept: %s%s (the home'"'"'s own link, not the code'"'"'s)\n' "$prefix" "$name"
      fi
    elif [ -e "$to/$name" ]; then
      printf 'kept: %s%s (the home'"'"'s own, not the code'"'"'s)\n' "$prefix" "$name"
    else
      swap_link "$from/$name" "$to/$name" || fail "cannot link $to/$name"
      printf 'linked: %s%s\n' "$prefix" "$name"
    fi
  done
  for path in "$to"/* "$to"/.[!.]* "$to"/..?*; do
    [ -L "$path" ] || continue
    name=${path##*/}
    "$skip" "$name" && continue
    { [ -e "$from/$name" ] || [ -L "$from/$name" ]; } && continue
    ours "$path" "$prefix$name" || continue
    rm -f -- "$path" || fail "cannot remove the stale link $path"
    printf 'unlinked: %s%s\n' "$prefix" "$name"
  done
}

top_skip() { home_owned "$1"; }
# The harness writes its own local settings beside the tracked ones.
claude_skip() { [ "$1" = settings.local.json ]; }

mirror "" top_skip
if [ -d "$CODE/.claude" ]; then
  mirror .claude claude_skip
fi

printf 'ok\n'
