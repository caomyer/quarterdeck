# shellcheck shell=bash
# Where each verified harness's executable lives.
# Usage: . bin/fm-harness-bin-lib.sh
#
# The single owner of executable resolution for spawning, shared by
# bin/fm-spawn.sh, which launches the resolved path, and
# bin/fm-crew-dispatch.sh, which reports whether a harness is installed.
# Sourcing it has no side effects. Cursor's two-name rule stays with its own
# owner, bin/fm-cursor-lib.sh, which this file sources.

FM_HARNESS_BIN_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-cursor-lib.sh disable=SC1091
. "$FM_HARNESS_BIN_LIB_DIR/fm-cursor-lib.sh"

resolve_pi_executable() {
  local candidate dir
  candidate=$(type -P -- "$1" 2>/dev/null) || return 1
  [ -x "$candidate" ] || return 1
  case "$candidate" in
  /*) printf '%s\n' "$candidate" ;;
  *)
    dir=$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P) || return 1
    printf '%s/%s\n' "$dir" "$(basename "$candidate")"
    ;;
  esac
}

resolve_kimi_binary() {
  local candidate dir fallback
  candidate=$(command -v kimi 2>/dev/null || true)
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    case "$candidate" in
    /*)
      printf '%s\n' "$candidate"
      return 0
      ;;
    *)
      dir=$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P) || dir=
      if [ -n "$dir" ]; then
        printf '%s/%s\n' "$dir" "$(basename "$candidate")"
        return 0
      fi
      ;;
    esac
  fi
  fallback="${HOME:-}/.kimi-code/bin/kimi"
  if [ -n "${HOME:-}" ] && [ -x "$fallback" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  echo "error: kimi executable not found; searched PATH for 'kimi' and fallback '$fallback'" >&2
  return 1
}

resolve_muse_binary() {
  local candidate dir
  candidate=$(command -v muse 2>/dev/null || true)
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    case "$candidate" in
    /*)
      printf '%s\n' "$candidate"
      return 0
      ;;
    *)
      dir=$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P) || dir=
      if [ -n "$dir" ]; then
        printf '%s/%s\n' "$dir" "$(basename "$candidate")"
        return 0
      fi
      ;;
    esac
  fi
  echo "error: muse executable not found on PATH; install Muse Code or select a different verified harness" >&2
  return 1
}

resolve_rovo_binary() {
  local candidate dir fallback
  candidate=$(command -v rovo 2>/dev/null || true)
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    case "$candidate" in
    /*)
      printf '%s\n' "$candidate"
      return 0
      ;;
    *)
      dir=$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P) || dir=
      if [ -n "$dir" ]; then
        printf '%s/%s\n' "$dir" "$(basename "$candidate")"
        return 0
      fi
      ;;
    esac
  fi
  fallback="${HOME:-}/.local/bin/rovo"
  if [ -n "${HOME:-}" ] && [ -x "$fallback" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  echo "error: rovo executable not found; searched PATH for 'rovo' and fallback '$fallback'" >&2
  return 1
}

# fm_harness_installed <harness>
# True when this machine has an executable for <harness>, resolved exactly as a
# spawn on it would resolve it. A harness whose launcher is its own name on PATH
# is looked up by that name; kimi, rovo, and cursor use their fallbacks above.
fm_harness_installed() {
  case "$1" in
  kimi) resolve_kimi_binary >/dev/null 2>&1 ;;
  muse) resolve_muse_binary >/dev/null 2>&1 ;;
  rovo) resolve_rovo_binary >/dev/null 2>&1 ;;
  cursor) fm_cursor_resolve_binary >/dev/null 2>&1 ;;
  *) resolve_pi_executable "$1" >/dev/null 2>&1 ;;
  esac
}
