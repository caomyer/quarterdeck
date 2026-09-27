#!/usr/bin/env bash
# scripts/devtest.sh - a development Quarterdeck, against a scratch firstmate home
# with its own engine, data, lock, tmux server and first mate, that an agent can
# drive as the captain would (scripts/drive.mjs).
#
# Usage: scripts/devtest.sh up [name]      build and launch; waits until it can be driven
#        scripts/devtest.sh down [name]    stop everything it started and remove its folder
#        scripts/devtest.sh status [name]  what runs, and where
#        scripts/devtest.sh env [name]     the variables drive.mjs reads, to eval in a shell
#
# Everything lives in ~/.buzz/.scratch/qd-devtest/<name> (default name: devtest):
#   engine/    a copy of this checkout's engine/, laid out and read-only as the
#              app bundles it (src-tauri/tauri.conf.json's resources), so the
#              first mate runs on no git checkout, exactly as a captain's does;
#              `up` copies it afresh, so an engine change needs a new `up`
#   home/      the firstmate home the app lays out from that engine,
#              presenting in Quarterdeck, with one project, devtest-hello, cloned
#              from origin/ so a first mate can file, start and scout real work
#   settings/  the app's own folder (QUARTERDECK_SETTINGS_DIR): settings, and the
#              host's per-home outbox and conversation record
#   tmux/      TMUX_TMPDIR, so every crewmate the scratch first mate spawns runs on
#              a tmux server of its own, never in the fleet's "firstmate" session
#   drive/     the app's remote control (QUARTERDECK_DEVDRIVE, src-tauri/src/devdrive.rs)
#   logs/      the app's and Vite's output
#   run/       the process group, the port and the command line
#
# Isolation from the captain's own home is by construction, not by care:
# - the app starts under `env -i` with an allowlist, so no FM_HOME, FM_TASK_ID,
#   TMUX, CLAUDE_* or Orca variable of whoever runs this reaches it, its first
#   mate or any crewmate;
# - QUARTERDECK_SETTINGS_DIR, QUARTERDECK_HOME_DIR and QUARTERDECK_ENGINE_DIR name
#   the scratch folder, so nothing reads or writes the app data
#   folder of the installed app, whose home is the captain's;
# - the folder is refused if it resolves inside that app data folder or
#   ~/Documents/projects/firstmate.
# What it shares with the machine: the Claude login, treehouse's worktree pools
# (the project's pool is removed by `down`) and the no-mistakes daemon, which a
# scratch first mate must never be asked to use.
#
# `down` stops the app (which stops its first mate's process group), then the
# process group it was started in, the scratch tmux server and every process
# still working in the folder, removes the project's treehouse pool, and deletes
# the folder. It says what it killed. Run it before you finish, every time.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
NAME=${2:-devtest}
case "$NAME" in
'' | *[!A-Za-z0-9._-]* | .*) echo "devtest: a name is letters, digits, dot, dash or underscore" >&2; exit 2 ;;
esac
SCRATCH="$HOME/.buzz/.scratch/qd-devtest"
ROOT="$SCRATCH/$NAME"
PROJECT=devtest-hello

refuse_live() {
  local resolved live
  mkdir -p "$SCRATCH"
  resolved=$(cd "$SCRATCH" && pwd -P)/$NAME
  for live in "$HOME/Library/Application Support/dev.firstmate.desktop" "$HOME/Documents/projects/firstmate"; do
    case "$resolved/" in
    "$live"/*) echo "devtest: $resolved is inside $live, which is the captain's" >&2; exit 1 ;;
    esac
  done
}

# The scratch tmux server. TMUX, when this runs inside tmux, names the caller's
# server and wins over TMUX_TMPDIR, so it is dropped.
scratch_tmux() { env -u TMUX TMUX_TMPDIR="$ROOT/tmux" tmux "$@"; }

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

group_pids() { ps -A -o pid=,pgid= | awk -v g="$1" '$2 == g { print $1 }'; }

# Processes whose working directory is inside the folder, or whose command line names it.
stragglers() {
  {
    lsof -a -d cwd -Fpn 2>/dev/null | awk -v root="$ROOT" '/^p/ { pid = substr($0, 2) } /^n/ { if (index(substr($0, 2), root) == 1) print pid }'
    pgrep -f "$ROOT" 2>/dev/null || true
  } | sort -un | grep -vx "$$" || true
}

wait_gone() {
  local pid tries=${2:-50}
  while [ "$tries" -gt 0 ]; do
    pid=$($1)
    [ -z "$pid" ] && return 0
    sleep 0.2
    tries=$((tries - 1))
  done
  return 1
}

# The engine as the bundle lays it out: tauri.conf.json's `resources`.
copy_engine() {
  [ -d "$ROOT/engine" ] && chmod -R u+w "$ROOT/engine"
  rm -rf "$ROOT/engine"
  rsync -a "$REPO/engine/" "$ROOT/engine/"
  rsync -a "$REPO/engine/.agents/skills/" "$ROOT/engine/.claude/skills/"
  rsync -a "$REPO/engine/.claude/mods/firstmate-calm/" "$ROOT/engine/.agents/skills/firstmate-calm/"
  chmod -R a-w "$ROOT/engine"
}

seed_project() {
  local work="$ROOT/origin/work" bare="$ROOT/origin/$PROJECT.git"
  [ -d "$bare" ] && return 0
  mkdir -p "$work"
  cat > "$work/README.md" <<'EOF'
# devtest-hello

A small project for a scratch firstmate to do real work in.
`greet.sh NAME` prints a greeting.
EOF
  cat > "$work/greet.sh" <<'EOF'
#!/bin/sh
# Prints a greeting for the name given, or for the world.
echo "hello, ${1:-world}"
EOF
  chmod +x "$work/greet.sh"
  git -C "$work" init -q -b main
  git -C "$work" add -A
  git -C "$work" -c user.name=devtest -c user.email=devtest@example.invalid commit -q -m "first commit"
  git clone -q --bare "$work" "$bare"
  rm -rf "$work"
}

launch_env() {
  exec env -i \
    HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" SHELL="${SHELL:-/bin/zsh}" \
    LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color TMPDIR="${TMPDIR:-/tmp}" \
    PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    QUARTERDECK_SETTINGS_DIR="$ROOT/settings" \
    QUARTERDECK_HOME_DIR="$ROOT/home" \
    QUARTERDECK_ENGINE_DIR="$ROOT/engine" \
    QUARTERDECK_DEVDRIVE="$ROOT/drive" \
    QUARTERDECK_UPDATES=off \
    TMUX_TMPDIR="$ROOT/tmux" \
    "$@"
}

cmd_up() {
  refuse_live
  if alive "$(cat "$ROOT/run/pgid" 2>/dev/null)"; then
    echo "devtest: $NAME is already up; scripts/devtest.sh down $NAME first" >&2
    exit 1
  fi
  mkdir -p "$ROOT"/{settings,tmux,drive,logs,run,origin}
  chmod 700 "$ROOT/tmux"
  copy_engine
  (launch_env "$ROOT/engine/bin/fm-home-init.sh" --home "$ROOT/home") > "$ROOT/logs/home-init.log"
  mkdir -p "$ROOT/home/config" "$ROOT/home/projects"
  echo quarterdeck > "$ROOT/home/config/presentation"
  seed_project
  [ -d "$ROOT/home/projects/$PROJECT" ] || git clone -q "$ROOT/origin/$PROJECT.git" "$ROOT/home/projects/$PROJECT"
  local port
  port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  local config
  config=$(printf '{"build":{"devUrl":"http://127.0.0.1:%s","beforeDevCommand":"pnpm dev --port %s --strictPort"}}' "$port" "$port")
  echo "$port" > "$ROOT/run/port"
  rm -f "$ROOT/drive/in/"* "$ROOT/drive/out/"* 2>/dev/null || true
  (
    cd "$REPO"
    # A new session makes the launcher its own process group's leader, so `down`
    # can end Vite, Cargo and the app together by the group. launch_env execs,
    # so the background job's pid is the leader's.
    launch_env python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      pnpm tauri dev --config "$config" > "$ROOT/logs/app.log" 2>&1 &
    echo $! > "$ROOT/run/pgid"
  )
  echo "devtest: $NAME launching (group $(cat "$ROOT/run/pgid"), port $port); log $ROOT/logs/app.log"
  local started=$SECONDS waited=0
  while ! { [ -d "$ROOT/drive/in" ] && node "$REPO/scripts/drive.mjs" --dir "$ROOT/drive" --timeout 5 eval 'return document.readyState' > /dev/null 2>&1; }; do
    if ! alive "$(cat "$ROOT/run/pgid")"; then
      echo "devtest: the app exited while starting; the end of its log:" >&2
      tail -20 "$ROOT/logs/app.log" >&2
      exit 1
    fi
    sleep 2
    waited=$((SECONDS - started))
    if [ "$waited" -ge 900 ]; then
      echo "devtest: the app did not answer the drive in 15 minutes; see $ROOT/logs/app.log" >&2
      exit 1
    fi
  done
  echo "devtest: $NAME is up. home $ROOT/home"
  echo "devtest: drive it with: node scripts/drive.mjs --dir $ROOT/drive <eval|shot|text|click|type> ..."
}

cmd_down() {
  refuse_live
  [ -d "$ROOT" ] || { echo "devtest: $NAME is not here ($ROOT)"; return 0; }
  local pgid killed=''
  pgid=$(cat "$ROOT/run/pgid" 2>/dev/null || true)
  # The app first, alone: its exit stops the first mate's process group cleanly.
  local app
  for app in $(pgrep -f "target/debug/firstmate-desktop$" 2>/dev/null || true); do
    if [ -n "$pgid" ] && group_pids "$pgid" | grep -qx "$app"; then
      kill -TERM "$app" 2>/dev/null && killed="$killed app:$app"
      local n=75
      while alive "$app" && [ "$n" -gt 0 ]; do sleep 0.2; n=$((n - 1)); done
    fi
  done
  if [ -n "$pgid" ] && [ -n "$(group_pids "$pgid")" ]; then
    killed="$killed group:$pgid($(group_pids "$pgid" | tr '\n' ' ' | sed 's/ $//'))"
    kill -TERM -"$pgid" 2>/dev/null || true
    wait_gone "group_pids $pgid" 25 || kill -KILL -"$pgid" 2>/dev/null || true
  fi
  if [ -d "$ROOT/tmux" ] && scratch_tmux list-sessions > /dev/null 2>&1; then
    killed="$killed tmux:$(scratch_tmux list-windows -a -F '#S:#W' | tr '\n' ',' | sed 's/,$//')"
    scratch_tmux kill-server 2>/dev/null || true
  fi
  local left
  left=$(stragglers)
  if [ -n "$left" ]; then
    killed="$killed stragglers:$(echo "$left" | tr '\n' ',' | sed 's/,$//')"
    echo "$left" | xargs kill -TERM 2>/dev/null || true
    wait_gone stragglers 25 || stragglers | xargs kill -KILL 2>/dev/null || true
  fi
  # The project's worktree pool, whose worktrees' origin is this folder's clone.
  local pool wt
  for pool in "$HOME/.treehouse/$PROJECT"-*; do
    [ -d "$pool" ] || continue
    for wt in "$pool"/*/"$PROJECT"; do
      [ -d "$wt" ] || continue
      case "$(git -C "$wt" remote get-url origin 2>/dev/null)" in
      "$ROOT"/*) ;;
      *) continue 2 ;;
      esac
    done
    killed="$killed pool:$pool"
    for wt in "$pool"/*/"$PROJECT"; do
      [ -d "$wt" ] && treehouse destroy "$wt" --include-unlanded --include-in-use --include-leased --yes > /dev/null 2>&1 || true
    done
    rm -rf "$pool"
  done
  left=$(stragglers)
  if [ -n "$left" ]; then
    echo "devtest: still running in $ROOT, not removing it: $left" >&2
    exit 1
  fi
  [ -d "$ROOT/engine" ] && chmod -R u+w "$ROOT/engine"
  rm -rf "$ROOT"
  echo "devtest: $NAME down. stopped:${killed:- nothing was running}. removed $ROOT"
}

cmd_status() {
  [ -d "$ROOT" ] || { echo "devtest: $NAME is not here"; return 0; }
  local pgid
  pgid=$(cat "$ROOT/run/pgid" 2>/dev/null || true)
  echo "root: $ROOT"
  echo "port: $(cat "$ROOT/run/port" 2>/dev/null || echo -)"
  echo "group: ${pgid:--} $(alive "$pgid" && echo up || echo down)"
  echo "tmux: $(scratch_tmux list-windows -a -F '#S:#W' 2>/dev/null | tr '\n' ' ' || true)"
  echo "processes in the folder: $(stragglers | tr '\n' ' ')"
}

cmd_env() {
  printf 'export QD_DRIVE=%q\nexport QD_HOME=%q\nexport QD_TMUX_TMPDIR=%q\n' "$ROOT/drive" "$ROOT/home" "$ROOT/tmux"
}

case "${1:-}" in
up) cmd_up ;;
down) cmd_down ;;
status) cmd_status ;;
env) cmd_env ;;
*) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
