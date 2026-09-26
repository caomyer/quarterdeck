#!/usr/bin/env bash
# The GitHub Issues adapter for bin/fm-sources.sh, which alone calls it.
#
# Usage (the adapter contract; bin/fm-sources.sh's header owns it in full):
#   fm-source-github.sh probe   --source <cfg-json>
#   fm-source-github.sh changes --source <cfg-json> --since <cursor|null> --budget <seconds>
#   fm-source-github.sh resolve <url|key|item-id> --source <cfg-json>
#   fm-source-github.sh comment <item-id> --write-id <id> --source <cfg-json>
#   fm-source-github.sh advance <item-id> <started|in-review|delivered> --source <cfg-json>
#
# stdin's first line is the token line; GitHub needs none, so it is read and
# ignored, and every call uses the existing `gh` login. `comment` reads its
# markdown body from the rest of stdin. Every call prints one JSON object and
# exits 0, failures included; a non-zero exit means a bug (bad arguments).
#
# The source's locator is one repository, `owner/name`. Its filter is one or
# more space-separated terms, all of which must hold: `label:<name>` (matched
# case-insensitively) and at most one of `is:open` or `is:closed`. Anything else
# is refused as invalid, and so is a filter with no label, because an
# unlabelled filter on a public repository offers every stranger's issue.
#
# Items: the immutable id is the issue's GraphQL node id; the key is `#<n>`.
# Pull requests are never items. An open issue is `open`; a closed one is `done`
# when GitHub says completed and `cancelled` when it says not planned or
# duplicate. GitHub has no started or review state, so `advance started` and
# `advance in-review` answer not-supported, and `advance delivered` answers
# already on a closed issue and not-supported on an open one: closing is left to
# the pull request's "Fixes #n". GitHub's change list reports neither deletions
# nor transfers, so a deleted or transferred issue is noticed only when it is
# next resolved, not promptly: resolving it then answers not_found, which the
# core records as a deleted item.
#
# changes asks one `issues?since=` list per call (oldest update first, pages of
# FM_SOURCE_GITHUB_PAGE, default 50) and fetches comments only for linked items
# that changed. A comment is made idempotent by a hidden `<!-- fm-write:<id> -->`
# marker, searched for before posting, and is read back after posting. That
# marker alone makes a comment `ours`: the sign-in is the captain's own, so a
# comment the captain writes by hand is theirs, not the fleet's.
# jq, not the shell, expands the $ names inside these single-quoted programs.
# shellcheck disable=SC2016
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-timeout-lib.sh
. "$SCRIPT_DIR/fm-timeout-lib.sh"

PAGE=${FM_SOURCE_GITHUB_PAGE:-50}
case "$PAGE" in ''|*[!0-9]*|0) PAGE=50 ;; esac
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-source-github.XXXXXX") || exit 2
trap 'rm -rf -- "$TMP"' EXIT
trap 'exit 2' HUP INT TERM

usage() { sed -n '2,/^set -u$/s/^# \{0,1\}//p' "$0"; }
bug() { printf 'fm-source-github: %s\n' "$*" >&2; exit 2; }

# One failure object, with the detail scrubbed of anything token-shaped. It is
# written to fd 3, the adapter's real stdout, so a failure inside a command
# substitution still reaches the caller, and it exits FAILED, which every
# substitution passes up and the dispatch below turns into the contract's 0.
exec 3>&1
FAILED=99
failure() {  # <code> <detail> [retry-at]
  jq -cn --arg code "$1" --arg detail "$2" --arg retry "${3:-}" '
    {ok:false,error:{code:$code,retry_at:(if $retry == "" then null else $retry end),
      detail:($detail
        | gsub("(gh[pousr]_|github_pat_)[A-Za-z0-9_]+"; "[redacted]")
        | gsub("(?i)authorization:[^\n]*"; "[redacted]")
        | gsub("[\r\n\t]+"; " ") | .[:300])}}' >&3
  exit "$FAILED"
}

DEADLINE=
gh_call() {  # <gh args...>; output in $TMP/out, stderr in $TMP/err
  local bound=20 now rc=0
  if [ -n "$DEADLINE" ]; then
    now=$(date +%s)
    bound=$((DEADLINE - now))
    [ "$bound" -gt 0 ] || return 124
    [ "$bound" -le 20 ] || bound=20
  fi
  fm_run_timed "$bound" env GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 \
    gh "$@" > "$TMP/out" 2> "$TMP/err" || rc=$?
  return "$rc"
}

# Map a failed gh call to the contract's typed error, and stop.
gh_failure() {  # <status>
  local rc=$1 err reset retry
  [ "$rc" -ne 124 ] || failure timeout 'GitHub did not answer in time'
  err=$(cat "$TMP/err" "$TMP/out" 2>/dev/null | head -c 2000)
  case "$err" in
    *"rate limit"*|*"HTTP 429"*)
      retry=
      if reset=$(fm_run_timed 5 env GH_PROMPT_DISABLED=1 gh api rate_limit --jq '.resources.core.reset' 2>/dev/null) \
        && [ -n "$reset" ]; then
        retry=$(jq -rn --arg r "$reset" '$r | tonumber | todateiso8601' 2>/dev/null || true)
      fi
      failure rate_limited "GitHub is rate limiting this Mac" "$retry" ;;
    *"HTTP 401"*|*"gh auth login"*|*"authentication"*) failure auth "GitHub refused the gh sign-in: $err" ;;
    *"HTTP 403"*) failure scope "The gh sign-in may not do this: $err" ;;
    *"HTTP 404"*|*"HTTP 410"*|*"Could not resolve to"*) failure not_found "$err" ;;
    *"HTTP 422"*) failure invalid "$err" ;;
    *"could not resolve host"*|*"connection refused"*|*"no such host"*|*"network is unreachable"*|*"i/o timeout"*|*"TLS handshake"*)
      failure network "$err" ;;
    *) failure provider "$err" ;;
  esac
}

SOURCE_JSON=
parse_source_flag() {  # sets SOURCE_JSON, REPO, and the rest of the args in REST[]
  REST=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --source) [ "$#" -ge 2 ] || bug '--source needs a value'; SOURCE_JSON=$2; shift 2 ;;
      *) REST+=("$1"); shift ;;
    esac
  done
  [ -n "$SOURCE_JSON" ] || bug '--source is required'
  printf '%s' "$SOURCE_JSON" | jq -e 'type == "object"' >/dev/null 2>&1 || bug '--source is not a JSON object'
  REPO=$(printf '%s' "$SOURCE_JSON" | jq -r '.locator // ""')
  [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || failure invalid "'$REPO' is not a GitHub repository (owner/name)"
}

# The filter as JSON {labels:[...], state:"open"|"closed"|null}, or a refusal.
filter_json() {
  local filter term labels=() state=''
  filter=$(printf '%s' "$SOURCE_JSON" | jq -r '.filter // ""')
  for term in $filter; do
    case "$term" in
      label:?*) labels+=("${term#label:}") ;;
      is:open|is:closed) [ -z "$state" ] || failure invalid 'the filter names is:open or is:closed more than once'; state=${term#is:} ;;
      *) failure invalid "the filter term '$term' is not one GitHub intake understands (label:<name>, is:open, is:closed)" ;;
    esac
  done
  [ "${#labels[@]}" -gt 0 ] || failure invalid 'the filter needs at least one label:<name>, so strangers cannot queue work'
  jq -cn --arg state "$state" '{labels:($ARGS.positional | map(ascii_downcase)),state:(if $state == "" then null else $state end)}' \
    --args "${labels[@]}"
}

# The jq that turns one REST issue (and its comments) into the contract's item.
ITEM_JQ='
  def state_of: if .state == "open" then "open"
    elif (.state_reason // "completed") == "completed" then "done" else "cancelled" end;
  def item($comments; $filter):
    {id:.node_id, key:("#" + (.number | tostring)), url:.html_url,
     title:(.title // ""), body:(.body // ""),
     state:state_of,
     state_name:(if .state == "open" then "open" else "closed (" + ((.state_reason // "completed") | gsub("_"; " ")) + ")" end),
     assignee:((.assignees // [])[0].login // .assignee.login // null),
     updated_at:.updated_at, deleted:false,
     matches:(if $filter == null then null else
       ([.labels[]? | (.name // .) | ascii_downcase] as $have | all($filter.labels[]; . as $l | $have | index($l) != null))
       and ($filter.state == null or $filter.state == .state) end),
     comments:[$comments[]? | {id:(.node_id // (.id | tostring)), author:(.user.login // null),
       ours:((.body // "") | test("<!-- fm-write:[A-Za-z0-9_-]+ -->")), at:(.created_at // null), body:(.body // "")}]};'

cmd_probe() {
  local login scopes repo
  parse_source_flag "$@"
  filter_json > "$TMP/filter.json"
  gh_call api -i user || gh_failure $?
  scopes=$(tr -d '\r' < "$TMP/out" | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: *//p' | head -1)
  login=$(sed -n '/^\r\{0,1\}$/,$p' "$TMP/out" | jq -r '.login // empty' 2>/dev/null)
  [ -n "$login" ] || failure auth 'gh is not signed in to GitHub'
  gh_call api "repos/$REPO" || gh_failure $?
  repo=$(cat "$TMP/out")
  jq -cn --arg login "$login" --arg scopes "$scopes" --argjson repo "$repo" '
    ($repo.permissions // {}) as $p
    | {ok:true, identity:$login,
       can:{read:true, comment:(($repo.has_issues // true) and ($p.pull // true)), advance:(($p.triage // false) or ($p.push // false))},
       scopes:($scopes | split(",") | map(gsub("^ +| +$"; "")) | map(select(. != ""))),
       reach:[$repo.full_name]}'
}

cmd_changes() {
  local since='' budget='' page=1 count filter now linked
  parse_source_flag "$@"
  set -- "${REST[@]}"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --since) since=${2-}; shift 2 ;;
      --budget) budget=${2-}; shift 2 ;;
      *) bug "unknown changes argument '$1'" ;;
    esac
  done
  case "$budget" in ''|*[!0-9]*|0) bug '--budget must be a positive number of seconds' ;; esac
  filter=$(filter_json) || exit "$FAILED"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -z "$since" ] || [ "$since" = null ]; then
    jq -cn --arg now "$now" '{ok:true,items:[],cursor:$now,more:false}'
    return 0
  fi
  [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || failure invalid 'the cursor is not one this adapter wrote'
  DEADLINE=$(( $(date +%s) + budget ))
  linked=$(printf '%s' "$SOURCE_JSON" | jq -c '.linked // []')
  : > "$TMP/issues.jsonl"
  local more=false cursor=$since
  while :; do
    gh_call api "repos/$REPO/issues?state=all&sort=updated&direction=asc&per_page=$PAGE&page=$page&since=$since" \
      || { rc=$?; [ "$rc" -eq 124 ] && [ "$page" -gt 1 ] && { more=true; break; }; gh_failure "$rc"; }
    jq -e 'type == "array"' "$TMP/out" >/dev/null 2>&1 || failure provider 'GitHub answered the issue list with something that is not a list'
    jq -c '.[] | select(.pull_request == null)' "$TMP/out" >> "$TMP/issues.jsonl"
    count=$(jq 'length' "$TMP/out")
    [ "$count" -gt 0 ] && cursor=$(jq -r 'map(.updated_at) | max' "$TMP/out" | awk -v c="$cursor" '{print ($1 > c ? $1 : c)}')
    [ "$count" -ge "$PAGE" ] || break
    page=$((page + 1))
    [ "$(date +%s)" -lt "$DEADLINE" ] || { more=true; break; }
  done
  # Keep only what the filter matches or a task here links; fetch comments
  # only for the linked items that changed.
  jq -sc --argjson filter "$filter" --argjson linked "$linked" '
    [.[] | select(.node_id as $id | ($linked | index($id)) != null
      or ([.labels[]? | (.name // .) | ascii_downcase] as $have | all($filter.labels[]; . as $l | $have | index($l) != null))
         and ($filter.state == null or $filter.state == .state))]' "$TMP/issues.jsonl" > "$TMP/kept.json"
  : > "$TMP/items.jsonl"
  local n node
  while IFS=$'\t' read -r n node; do
    printf '[]' > "$TMP/comments.json"
    if printf '%s' "$linked" | jq -e --arg id "$node" 'index($id) != null' >/dev/null; then
      if gh_call api "repos/$REPO/issues/$n/comments?per_page=100&since=$since"; then
        cp "$TMP/out" "$TMP/comments.json"
      else
        rc=$?
        [ "$rc" -eq 124 ] || gh_failure "$rc"
        # Out of budget: stop before this item so the next cycle reads it whole.
        more=true
        cursor=$(jq -r --arg id "$node" '[.[] | select(.node_id == $id) | .updated_at] | first' "$TMP/kept.json")
        jq -c --arg id "$node" '[.[] | select(.node_id != $id)]' "$TMP/kept.json" > "$TMP/kept2.json"
        break
      fi
    fi
    jq -c --argjson filter "$filter" --slurpfile comments "$TMP/comments.json" \
      "$ITEM_JQ item(\$comments[0]; \$filter)" <<< "$(jq -c --arg id "$node" '.[] | select(.node_id == $id)' "$TMP/kept.json")" \
      >> "$TMP/items.jsonl"
  done < <(jq -r '.[] | [(.number | tostring), .node_id] | @tsv' "$TMP/kept.json")
  jq -sc --arg cursor "$cursor" --argjson more "$more" '{ok:true,items:.,cursor:$cursor,more:$more}' "$TMP/items.jsonl"
}

# Parse a URL or key into an issue number in this source's repository.
issue_number() {  # <url-or-key>
  local ref=$1 repo=''
  case "$ref" in
    https://github.com/*/issues/*)
      repo=${ref#https://github.com/}; repo=${repo%/issues/*}; ref=${ref##*/issues/}; ref=${ref%%[?#]*} ;;
    */*\#*) repo=${ref%%#*}; ref=${ref#*#} ;;
    \#*) ref=${ref#\#} ;;
  esac
  if [ -n "$repo" ] && [ "$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')" ]; then
    failure not_found "that issue is in $repo, not $REPO"
  fi
  [[ "$ref" =~ ^[0-9]+$ ]] || failure invalid "'$1' is not an issue link or number"
  printf '%s' "$ref"
}

read_item() {  # <number>; prints the contract item
  local n=$1 issue
  gh_call api "repos/$REPO/issues/$n" || gh_failure $?
  issue=$(cat "$TMP/out")
  printf '%s' "$issue" | jq -e '.node_id | type == "string"' >/dev/null 2>&1 || failure not_found "no issue #$n in $REPO"
  printf '%s' "$issue" | jq -e '.pull_request == null' >/dev/null || failure invalid "#$n is a pull request, not an issue"
  gh_call api "repos/$REPO/issues/$n/comments?per_page=100" --paginate --slurp || gh_failure $?
  jq -c 'add // []' "$TMP/out" > "$TMP/comments.json"
  printf '%s' "$issue" | jq -c --slurpfile comments "$TMP/comments.json" \
    "$ITEM_JQ item(\$comments[0]; null) | del(.matches)"
}

cmd_resolve() {
  local n
  parse_source_flag "$@"
  [ "${#REST[@]}" -eq 1 ] || bug 'resolve takes one URL, key or item id'
  # An item id (a node id) is what the core holds for a link it has not read yet.
  if [[ "${REST[0]}" =~ ^I_[A-Za-z0-9_-]+$ ]]; then
    n=$(number_of "${REST[0]}") || exit "$FAILED"
  else
    n=$(issue_number "${REST[0]}") || exit "$FAILED"
  fi
  item=$(read_item "$n") || exit "$FAILED"
  jq -cn --argjson item "$item" '{ok:true,item:$item}'
}

# The issue number behind a node id, checked to be in this source's repository.
number_of() {  # <node-id>
  gh_call api graphql -f query='query($id:ID!){node(id:$id){... on Issue{number repository{nameWithOwner}}}}' -f id="$1" \
    || gh_failure $?
  jq -e '.data.node.number' "$TMP/out" >/dev/null 2>&1 || failure not_found "no issue has the id $1"
  jq -e --arg repo "$REPO" '(.data.node.repository.nameWithOwner | ascii_downcase) == ($repo | ascii_downcase)' "$TMP/out" >/dev/null \
    || failure not_found "the issue $1 is no longer in $REPO"
  jq -r '.data.node.number' "$TMP/out"
}

cmd_comment() {
  local item='' write_id='' n body marker found posted
  parse_source_flag "$@"
  set -- "${REST[@]}"
  item=${1-}; shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --write-id) write_id=${2-}; shift 2 ;;
      *) bug "unknown comment argument '$1'" ;;
    esac
  done
  [ -n "$item" ] || bug 'comment needs an item id'
  [[ "$write_id" =~ ^[A-Za-z0-9_-]{8,80}$ ]] || bug '--write-id is required'
  body=$(cat)
  [ -n "$body" ] || failure invalid 'the comment is empty'
  marker="<!-- fm-write:$write_id -->"
  n=$(number_of "$item") || exit "$FAILED"
  gh_call api "repos/$REPO/issues/$n/comments?per_page=100" --paginate --slurp || gh_failure $?
  found=$(jq -r --arg marker "$marker" 'add // [] | map(select((.body // "") | contains($marker))) | first | .node_id // empty' "$TMP/out")
  if [ -n "$found" ]; then
    jq -cn --arg id "$found" '{ok:true,comment_id:$id,deduplicated:true}'
    return 0
  fi
  jq -n --arg body "$body"$'\n\n'"$marker" '{body:$body}' > "$TMP/payload.json"
  gh_call api --method POST "repos/$REPO/issues/$n/comments" --input "$TMP/payload.json" || gh_failure $?
  posted=$(jq -r '.id // empty' "$TMP/out")
  [ -n "$posted" ] || failure provider 'unconfirmed'
  # Read it back once: a post GitHub acknowledged but does not show is unconfirmed.
  gh_call api "repos/$REPO/issues/comments/$posted" || failure provider 'unconfirmed'
  jq -e --arg marker "$marker" '(.body // "") | contains($marker)' "$TMP/out" >/dev/null || failure provider 'unconfirmed'
  jq -c '{ok:true,comment_id:.node_id,deduplicated:false}' "$TMP/out"
}

cmd_advance() {
  local item intent n
  parse_source_flag "$@"
  [ "${#REST[@]}" -eq 2 ] || bug 'advance takes an item id and an intent'
  item=${REST[0]}; intent=${REST[1]}
  case "$intent" in started|in-review|delivered) ;; *) bug "'$intent' is not an intent" ;; esac
  if [ "$intent" != delivered ]; then
    jq -cn '{ok:true,result:"not-supported",from:null,to:null,candidates:[]}'
    return 0
  fi
  n=$(number_of "$item") || exit "$FAILED"
  gh_call api "repos/$REPO/issues/$n" || gh_failure $?
  jq -c '{ok:true,result:(if .state == "closed" then "already" else "not-supported" end),
    from:.state,to:null,candidates:[]}' "$TMP/out"
}

[ "$#" -gt 0 ] || { usage >&2; exit 2; }
case "$1" in -h|--help) usage; exit 0 ;; esac
command -v jq >/dev/null 2>&1 || bug 'jq is required'
verb=$1; shift
# The token line: GitHub needs none, but the framing is the same for every adapter.
if [ "$verb" = comment ]; then IFS= read -r _token_line || true; fi
unset _token_line
command -v gh >/dev/null 2>&1 || { (failure auth 'the GitHub CLI (gh) is not installed'); exit 0; }
rc=0
case "$verb" in
  probe) (cmd_probe "$@") || rc=$? ;;
  changes) (cmd_changes "$@") || rc=$? ;;
  resolve) (cmd_resolve "$@") || rc=$? ;;
  comment) (cmd_comment "$@") || rc=$? ;;
  advance) (cmd_advance "$@") || rc=$? ;;
  *) bug "unknown verb '$verb'" ;;
esac
[ "$rc" -ne "$FAILED" ] || exit 0
exit "$rc"
