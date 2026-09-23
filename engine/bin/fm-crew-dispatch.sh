#!/usr/bin/env bash
# Turn this home's crew dispatch routing on or off, edit its rules, and set or
# clear the optional typed dispatch resolution key.
# Usage: fm-crew-dispatch.sh status
#        fm-crew-dispatch.sh show
#        fm-crew-dispatch.sh template
#        fm-crew-dispatch.sh harnesses
#        fm-crew-dispatch.sh enable [--template | --restore]
#        fm-crew-dispatch.sh write [--if-unchanged <sha256>]   (rules JSON on stdin)
#        fm-crew-dispatch.sh disable
#        fm-crew-dispatch.sh set-key                           (key on stdin)
#        fm-crew-dispatch.sh clear-key
#
# This is the one writer of config/crew-dispatch.json and of the
# TYPESAFE_API_KEY line in the home's gitignored .env for any caller that is not
# a person with an editor; Quarterdeck's settings call it rather than writing
# either file. docs/configuration.md "Crew dispatch profiles" owns what the
# rules mean and "Typed dispatch resolution" owns what the key turns on.
#
# Routing is on exactly when config/crew-dispatch.json exists.
#
#   status    Print key=value lines, always in this order:
#               routing=on|off
#               sha256=<hex>             (on only: the file's digest, for write --if-unchanged)
#               invalid=<reason>         (on only, when the rules are not valid)
#               key=set|unset
#               key-source=environment|.env   (set only)
#               set-aside=<file name>    (the newest one disable left in config/, when any)
#             <reason> is bin/fm-crew-dispatch-lib.sh's, the same words
#             bin/fm-bootstrap.sh reports after "CREW_DISPATCH: invalid
#             config/crew-dispatch.json - "; "cannot check without jq" when jq
#             is missing.
#   show      Print the rules file as it is on disk; nothing when routing is off.
#   template  Print the shipped example, docs/examples/crew-dispatch.json.
#   harnesses Print one tab-separated line per harness a profile may name, in
#             the order the validator lists them:
#               <harness>\t<installed|missing>\t<efforts>
#             <efforts> is space-separated and may be empty, each entry
#             "<effort>" or "<effort>@<model>" (accepted only with that model)
#             or "<effort>@<prefix>*" (only with a model under that prefix).
#             The list, the efforts, and whether a harness is installed come
#             from the same owners the validator and spawning use, so a caller
#             offering a choice keeps no copy of them. It follows the key: with
#             typed dispatch resolution on, gemini is listed too.
#   enable    Create the rules file: empty rules by default, the shipped example
#             with --template, or the newest set-aside file with --restore.
#             Refuses when routing is already on, and never overwrites a file.
#   write     Replace the rules with the JSON on stdin. Refuses content that is
#             not valid by the rule above, and, with --if-unchanged, a file whose
#             digest is no longer <sha256> because someone else edited it.
#             Routing must already be on.
#   disable   Move the rules file aside to config/crew-dispatch.json.off-<UTC stamp>
#             and print "set-aside=<file name>". Nothing is ever deleted; enable
#             --restore brings the newest one back. Already off is a no-op.
#   set-key   Read one line from stdin and store it as the home's
#             TYPESAFE_API_KEY. It is never taken from argv, never printed, never
#             logged, and written nowhere but .env (mode 600, replaced whole).
#             Refuses a value outside [A-Za-z0-9._~+/=:-], at most 512 bytes,
#             without echoing it.
#   clear-key Remove every TYPESAFE_API_KEY line from .env.
#
# A symlinked config/crew-dispatch.json or .env is refused by write, set-key and
# clear-key rather than replaced, because replacing it would cut the link.
# Exit 0 on success, 1 on a refusal (reason on stderr), 2 on a usage error.
# FM_HOME selects the home and FM_CONFIG_OVERRIDE its config directory, as for
# the other scripts.
set -u

# The key never reaches a child process: copy an environment-provided one into a
# private variable and unset it, as bin/fm-bootstrap.sh and
# bin/fm-dispatch-resolve.sh do.
TYPESAFE_API_KEY_PRIVATE=${TYPESAFE_API_KEY:-}
export -n TYPESAFE_API_KEY_PRIVATE 2>/dev/null || true
unset TYPESAFE_API_KEY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
RULES="$CONFIG/crew-dispatch.json"
ENV_FILE="$FM_HOME/.env"
TEMPLATE="$FM_ROOT/docs/examples/crew-dispatch.json"
KEY_LINE_RE='^[[:space:]]*(export[[:space:]]+)?TYPESAFE_API_KEY='

# shellcheck source=bin/fm-env-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-env-lib.sh"
# shellcheck source=bin/fm-crew-dispatch-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-crew-dispatch-lib.sh"
# shellcheck source=bin/fm-harness-bin-lib.sh disable=SC1091
. "$SCRIPT_DIR/fm-harness-bin-lib.sh"

# The header above, up to `set -u`, is the help text.
help_text() {
  awk 'NR > 1 && /^set -u/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

usage() {
  help_text >&2
  exit 2
}

refuse() {
  printf 'fm-crew-dispatch: %s\n' "$1" >&2
  exit 1
}

routing_on() {
  [ -e "$RULES" ] || [ -L "$RULES" ]
}

digest() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# Where the key comes from, if anywhere: the environment wins over .env, as for
# every reader of it.
key_source() {
  if [ -n "$TYPESAFE_API_KEY_PRIVATE" ]; then
    echo environment
  elif [ -n "$(fmx_env_get TYPESAFE_API_KEY "$ENV_FILE")" ]; then
    echo .env
  fi
}

key_status() {
  local source
  source=$(key_source)
  if [ -n "$source" ]; then
    echo "key=set"
    echo "key-source=$source"
  else
    echo "key=unset"
  fi
}

typed_active() {
  if [ -n "$(key_source)" ]; then echo true; else echo false; fi
}

invalid_reason() {  # <file>
  if ! command -v jq >/dev/null 2>&1; then
    echo "cannot check without jq"
    return 0
  fi
  fm_crew_dispatch_invalid_reason "$1" "$(typed_active)"
}

newest_set_aside() {
  local newest='' candidate
  for candidate in "$RULES".off-*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    # Stamps sort as text, and a same-second suffix sorts after its stamp.
    if [ -z "$newest" ] || [[ "$candidate" > "$newest" ]]; then
      newest=$candidate
    fi
  done
  [ -z "$newest" ] || basename -- "$newest"
}

# Link a finished temporary file into place, which fails rather than overwrite a
# file someone created a moment earlier.
place_new() {  # <temporary> <target>
  local linked=0
  ln -- "$1" "$2" 2>/dev/null && linked=1
  rm -f -- "$1"
  [ "$linked" = 1 ] || refuse "config/crew-dispatch.json appeared while this ran; left it as it is"
}

cmd_status() {
  local reason set_aside
  if routing_on; then
    echo "routing=on"
    # A dangling symlink has no content to digest.
    if [ -e "$RULES" ]; then
      echo "sha256=$(digest "$RULES")"
    fi
    reason=$(invalid_reason "$RULES")
    [ -z "$reason" ] || echo "invalid=$reason"
  else
    echo "routing=off"
  fi
  key_status
  set_aside=$(newest_set_aside)
  [ -z "$set_aside" ] || echo "set-aside=$set_aside"
}

cmd_show() {
  routing_on || return 0
  cat -- "$RULES" || refuse "could not read config/crew-dispatch.json"
}

cmd_template() {
  cat -- "$TEMPLATE" || refuse "the shipped example is missing: $TEMPLATE"
}

cmd_harnesses() {
  local harness installed
  command -v jq >/dev/null 2>&1 || refuse "cannot list harnesses without jq"
  while IFS= read -r harness; do
    [ -n "$harness" ] || continue
    installed=missing
    fm_harness_installed "$harness" && installed=installed
    printf '%s\t%s\t%s\n' "$harness" "$installed" "$(fm_crew_dispatch_efforts "$harness")"
  done < <(fm_crew_dispatch_harnesses "$(typed_active)")
}

cmd_enable() {
  local from=empty temporary set_aside
  case "${1-}" in
    '') ;;
    --template) from=template ;;
    --restore) from=restore ;;
    *) usage ;;
  esac
  [ "$#" -le 1 ] || usage
  routing_on && refuse "routing is already on; config/crew-dispatch.json exists"
  mkdir -p -- "$CONFIG" || refuse "could not create $CONFIG"
  if [ "$from" = restore ]; then
    set_aside=$(newest_set_aside)
    [ -n "$set_aside" ] || refuse "there is no set-aside rules file to restore"
    place_new_restore "$CONFIG/$set_aside"
    echo "routing=on"
    echo "restored=$set_aside"
    return 0
  fi
  temporary=$(mktemp "$CONFIG/.crew-dispatch.json.XXXXXX") || refuse "could not write in $CONFIG"
  if [ "$from" = template ]; then
    cp -- "$TEMPLATE" "$temporary" || { rm -f -- "$temporary"; refuse "the shipped example is missing: $TEMPLATE"; }
  else
    printf '{\n  "rules": []\n}\n' > "$temporary"
  fi
  chmod 644 "$temporary"
  place_new "$temporary" "$RULES"
  echo "routing=on"
}

# A set-aside file comes back under its own name's link, then the set-aside name
# goes, so a failure leaves it where it was.
place_new_restore() {  # <set-aside path>
  if [ -L "$1" ]; then
    mv -n -- "$1" "$RULES" || refuse "could not restore $(basename -- "$1")"
    [ ! -L "$1" ] || refuse "config/crew-dispatch.json appeared while this ran; left it as it is"
    return 0
  fi
  ln -- "$1" "$RULES" 2>/dev/null || refuse "config/crew-dispatch.json appeared while this ran; left it as it is"
  rm -f -- "$1"
}

cmd_write() {
  local expect='' temporary reason
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --if-unchanged) [ "$#" -ge 2 ] || usage; expect=$2; shift 2 ;;
      *) usage ;;
    esac
  done
  routing_on || refuse "routing is off; turn it on before editing its rules"
  [ -L "$RULES" ] && refuse "config/crew-dispatch.json is a symlink; edit the file it points at"
  command -v jq >/dev/null 2>&1 || refuse "cannot check the rules without jq"
  temporary=$(mktemp "$CONFIG/.crew-dispatch.json.XXXXXX") || refuse "could not write in $CONFIG"
  cat > "$temporary" || { rm -f -- "$temporary"; refuse "could not read the rules from stdin"; }
  reason=$(fm_crew_dispatch_invalid_reason "$temporary" "$(typed_active)")
  if [ -n "$reason" ]; then
    rm -f -- "$temporary"
    refuse "not saved: $reason"
  fi
  if [ -n "$expect" ] && [ "$(digest "$RULES")" != "$expect" ]; then
    rm -f -- "$temporary"
    refuse "not saved: config/crew-dispatch.json changed since it was read"
  fi
  chmod 644 "$temporary"
  mv -f -- "$temporary" "$RULES" || { rm -f -- "$temporary"; refuse "could not save config/crew-dispatch.json"; }
  echo "sha256=$(digest "$RULES")"
}

cmd_disable() {
  local stamp target n=1
  routing_on || { echo "routing=off"; return 0; }
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="$RULES.off-$stamp"
  while [ -e "$target" ] || [ -L "$target" ]; do
    n=$((n + 1))
    target="$RULES.off-$stamp-$n"
  done
  mv -n -- "$RULES" "$target" || refuse "could not move config/crew-dispatch.json aside"
  if routing_on; then
    refuse "config/crew-dispatch.json could not be moved aside"
  fi
  echo "routing=off"
  echo "set-aside=$(basename -- "$target")"
}

# Rewrite .env without its TYPESAFE_API_KEY lines, then run the optional
# appender on the new copy, and replace .env with it whole.
rewrite_env() {  # <appender function or empty>
  local temporary status=0
  [ -L "$ENV_FILE" ] && refuse ".env is a symlink; edit the file it points at"
  temporary=$(umask 077 && mktemp "$FM_HOME/.env.XXXXXX") || refuse "could not write in $FM_HOME"
  if [ -f "$ENV_FILE" ]; then
    # grep exits 1 when every line was a key line, which is not a failure.
    grep -Ev "$KEY_LINE_RE" "$ENV_FILE" > "$temporary" || status=$?
    [ "$status" -le 1 ] || { rm -f -- "$temporary"; refuse "could not read .env"; }
  fi
  if [ -n "$1" ]; then
    "$1" "$temporary" || { rm -f -- "$temporary"; refuse "could not write .env"; }
  fi
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$ENV_FILE" || { rm -f -- "$temporary"; refuse "could not save .env"; }
}

NEW_KEY=''
append_key() {  # <file>
  # printf is a builtin: the key is on no process's argv.
  printf 'TYPESAFE_API_KEY=%s\n' "$NEW_KEY" >> "$1"
}

cmd_set_key() {
  local line=''
  IFS= read -r line || [ -n "$line" ] || refuse "no key on stdin"
  line=${line%$'\r'}
  line=${line#"${line%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}
  [ -n "$line" ] || refuse "no key on stdin"
  [ "${#line}" -le 512 ] || refuse "the key is longer than 512 characters; not saved"
  case "$line" in
    *[!A-Za-z0-9._~+/=:-]*) refuse "the key holds a character a key does not; not saved" ;;
  esac
  NEW_KEY=$line
  rewrite_env append_key
  NEW_KEY=''
  key_status
}

cmd_clear_key() {
  if [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
    rewrite_env ''
  fi
  key_status
}

verb=${1-}
[ "$#" -gt 0 ] && shift
case "$verb" in
  status) [ "$#" -eq 0 ] || usage; cmd_status ;;
  show) [ "$#" -eq 0 ] || usage; cmd_show ;;
  template) [ "$#" -eq 0 ] || usage; cmd_template ;;
  harnesses) [ "$#" -eq 0 ] || usage; cmd_harnesses ;;
  enable) cmd_enable "$@" ;;
  write) cmd_write "$@" ;;
  disable) [ "$#" -eq 0 ] || usage; cmd_disable ;;
  set-key) [ "$#" -eq 0 ] || usage; cmd_set_key ;;
  clear-key) [ "$#" -eq 0 ] || usage; cmd_clear_key ;;
  -h|--help) help_text ;;
  *) usage ;;
esac
