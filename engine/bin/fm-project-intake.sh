#!/usr/bin/env bash
# fm-project-intake.sh - facts firstmate needs before registering a captain's
# local checkout as a fleet project.
#
# When the captain names a local path ("add ~/code/Resonance"), firstmate clones
# that checkout's origin into projects/ rather than working in the captain's own
# directory. Two things go wrong silently unless they are settled up front:
#
#   - Treehouse keys its pool of reusable worktrees on a checkout's directory
#     name and its origin, so a fleet copy with the same name as the captain's
#     checkout (compared without case, as a default macOS disk does) shares the
#     captain's pool, and the first dispatch is handed a worktree of the
#     captain's own repository instead of the fleet copy's.
#   - The crew sees only what is committed and pushed. Uncommitted, untracked,
#     or unpushed work in the captain's checkout is invisible to it.
#
# This script is read-only. It never clones, registers, or touches the source;
# the project-management skill owns the intake procedure that uses its answer.
#
# Usage: fm-project-intake.sh local <path> [--name <name>] [--json]
#
# local
#   Inspects the git checkout at <path> and prints, one `key: value` per line:
#   source (the checkout's top level), origin (URL, or `none`), branch (or
#   `detached`), uncommitted (changed tracked files), untracked (untracked
#   files), unpushed (commits on HEAD that no remote-tracking ref contains; a
#   local read, never a fetch; 0 when there is no origin), name (the fleet project name to use), and
#   notice (one plain sentence to tell the captain). --name proposes a name;
#   the default is the checkout's directory name. A proposed name equal to the
#   checkout's directory name gets `-fm` appended, and a name already taken
#   under projects/ or in data/projects.md gets `-2`, `-3`, ... until it is
#   free. --json prints the same facts as schema fm-project-intake-local.v1.
#
# Exit codes: 0 done; 1 refused; 2 usage.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
PROJECTS="${FM_PROJECTS_OVERRIDE:-$FM_HOME/projects}"

usage() {
  sed -n '20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die() {
  echo "fm-project-intake: $*" >&2
  exit 1
}

lower() {
  printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'
}

name_valid() {  # <name>
  printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
}

# A name is taken when projects/ holds an entry or the registry lists a
# project that differs from it only in case, since either would collide on a
# case-insensitive disk or in a reader that compares names loosely.
name_taken() {  # <name>
  local want entry
  want=$(lower "$1")
  if [ -d "$PROJECTS" ]; then
    for entry in "$PROJECTS"/* "$PROJECTS"/.[!.]*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      [ "$(lower "$(basename "$entry")")" != "$want" ] || return 0
    done
  fi
  if [ -f "$DATA/projects.md" ]; then
    awk '$1 == "-" { print $2 }' "$DATA/projects.md" | while IFS= read -r entry; do
      [ "$(lower "$entry")" != "$want" ] || { echo taken; break; }
    done | grep -q taken && return 0
  fi
  return 1
}

plural() {  # <count> <singular> <plural>
  if [ "$1" -eq 1 ]; then printf '1 %s' "$2"; else printf '%s %s' "$1" "$3"; fi
}

cmd_local() {
  local path='' name='' json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) [ $# -ge 2 ] || usage; name=$2; shift 2 ;;
      --json) json=1; shift ;;
      -h|--help) usage ;;
      -*) die "unknown option '$1'" ;;
      *) [ -z "$path" ] || usage; path=$1; shift ;;
    esac
  done
  [ -n "$path" ] || usage
  [ -d "$path" ] || die "no directory at '$path'"
  local source origin branch status uncommitted untracked unpushed source_name base candidate suffix notice parts pronoun action
  source=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null) || die "'$path' is not inside a git checkout"
  source=$(CDPATH='' cd -- "$source" 2>/dev/null && pwd -P) || die "cannot resolve '$path'"
  origin=$(git -C "$source" remote get-url origin 2>/dev/null) || origin=
  branch=$(git -C "$source" symbolic-ref --short -q HEAD 2>/dev/null) || branch=detached
  status=$(git -C "$source" status --porcelain=v1 --untracked-files=all 2>/dev/null) \
    || die "cannot read the state of '$source'"
  untracked=$(printf '%s\n' "$status" | grep -c '^??')
  uncommitted=$(printf '%s\n' "$status" | grep -v '^??' | grep -c .)
  if [ -n "$origin" ] && git -C "$source" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    unpushed=$(git -C "$source" rev-list --count HEAD --not --remotes 2>/dev/null) || unpushed=0
  else
    unpushed=0
  fi

  source_name=$(basename "$source")
  base=${name:-$source_name}
  name_valid "$base" || die "'$base' is not a usable project name (letters, digits, '.', '_', '-'; at most 64)"
  [ "$(lower "$base")" != "$(lower "$source_name")" ] || base="$base-fm"
  candidate=$base
  suffix=2
  while name_taken "$candidate"; do
    candidate="$base-$suffix"
    suffix=$((suffix + 1))
    [ "$suffix" -le 99 ] || die "no free project name near '$base'"
  done

  if [ -n "$origin" ]; then
    notice="Work on this project will run in a fresh copy of $origin named $candidate, not in your folder $source"
  else
    notice="Work on this project will run in a copy of the committed history in $source named $candidate, not in that folder itself"
  fi
  parts=()
  [ "$uncommitted" -eq 0 ] || parts+=("$(plural "$uncommitted" 'uncommitted change' 'uncommitted changes')")
  [ "$untracked" -eq 0 ] || parts+=("$(plural "$untracked" 'untracked file' 'untracked files')")
  if [ -n "$origin" ] && [ "$unpushed" -gt 0 ]; then
    parts+=("$(plural "$unpushed" 'commit not pushed to origin' 'commits not pushed to origin')")
  fi
  pronoun=them
  [ "${#parts[@]}" -ne 1 ] || [ "$((uncommitted + untracked + unpushed))" -ne 1 ] || pronoun=it
  [ -n "$origin" ] && action="commit and push" || action="commit"
  case ${#parts[@]} in
    0) notice="$notice; your folder has no uncommitted or unpushed work, so that copy starts from the same code you have." ;;
    1) notice="$notice; your folder has ${parts[0]}, which that copy will not have unless you $action $pronoun." ;;
    2) notice="$notice; your folder has ${parts[0]} and ${parts[1]}, which that copy will not have unless you $action them." ;;
    *) notice="$notice; your folder has ${parts[0]}, ${parts[1]}, and ${parts[2]}, which that copy will not have unless you $action them." ;;
  esac

  if [ "$json" = 1 ]; then
    command -v jq >/dev/null 2>&1 || die "jq is required for --json"
    jq -n --arg source "$source" --arg origin "$origin" --arg branch "$branch" \
      --argjson uncommitted "$uncommitted" --argjson untracked "$untracked" \
      --argjson unpushed "$unpushed" --arg name "$candidate" --arg notice "$notice" \
      '{schema:"fm-project-intake-local.v1", source:$source,
        origin:(if $origin == "" then null else $origin end), branch:$branch,
        uncommitted:$uncommitted, untracked:$untracked, unpushed:$unpushed,
        name:$name, notice:$notice}'
  else
    printf 'source: %s\norigin: %s\nbranch: %s\nuncommitted: %s\nuntracked: %s\nunpushed: %s\nname: %s\nnotice: %s\n' \
      "$source" "${origin:-none}" "$branch" "$uncommitted" "$untracked" "$unpushed" "$candidate" "$notice"
  fi
}

[ $# -ge 1 ] || usage
sub=$1
shift
case "$sub" in
  local) cmd_local "$@" ;;
  -h|--help) usage ;;
  *) usage ;;
esac
