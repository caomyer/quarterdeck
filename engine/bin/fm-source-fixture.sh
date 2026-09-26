#!/usr/bin/env bash
# A test task source that is deliberately not GitHub: bin/fm-sources.sh drives
# it through the same five verbs as a real adapter, so the engine tests prove
# the core holds the adapter contract with no provider-specific branch.
#
# Usage: the adapter contract, owned by bin/fm-sources.sh's header:
#   fm-source-fixture.sh probe|changes|resolve|comment|advance ... --source <cfg-json>
#
# Its world is a JSON file, $FM_SOURCE_FIXTURE_DIR/<locator>.json, which the
# test writes and this adapter reads and changes. Without that directory every
# call answers `invalid`. It carries Jira's awkward traits on purpose:
#   - Ids are stable and keys are not: moving an item to another project gives
#     it a new key (FIX-3 becomes OPS-9) under the same id.
#   - State is transitioned, not set: a workflow names each status's category
#     (new, started, done, cancelled) and the transitions out of it, and
#     `advance` picks a transition by intent, answering ambiguous when two fit.
#   - Bodies and comments are stored in a wiki markup (`h2. `, `*bold*`,
#     `{{code}}`), converted to markdown on the way out and back on the way in.
#   - Update times have minute precision, so `changes` overlaps its cursor by a
#     minute and returns some items twice.
#   - Its intake filter is its own syntax, `labels = <name>`, opaque to the core.
#   - A comment's write id is kept as a property of the comment, not a marker,
#     and a comment is `ours` only when it carries one, whoever its author.
#
# World shape (every key but items optional):
#   {identity, can:{read,comment,advance}, scopes:[...], reach:[...],
#    page_size, seconds_per_page,
#    faults:{<verb>:[<code>|"ok"|"lose-response"|"unconfirmed", ...]}   one per call, in order
#    workflows:{<name>:{statuses:{<status>:<category>}, transitions:{<status>:[<status>...]}}},
#    items:[{id, key, summary, description, status, workflow, labels:[...],
#            assignee, updated:"YYYY-MM-DDTHH:MM", deleted,
#            comments:[{id, author, created, body, write_id}]}]}
# jq, not the shell, expands the $ names inside these single-quoted programs.
# shellcheck disable=SC2016
set -u

usage() { sed -n '2,/^set -u$/s/^# \{0,1\}//p' "$0"; }
bug() { printf 'fm-source-fixture: %s\n' "$*" >&2; exit 2; }
failure() {  # <code> <detail> [retry-at]
  jq -cn --arg code "$1" --arg detail "$2" --arg retry "${3:-}" \
    '{ok:false,error:{code:$code,retry_at:(if $retry == "" then null else $retry end),detail:$detail}}'
  exit 0
}

[ "$#" -gt 0 ] || { usage >&2; exit 2; }
case "$1" in -h|--help) usage; exit 0 ;; esac
VERB=$1; shift
IFS= read -r TOKEN_LINE || true
[ -z "$TOKEN_LINE" ] || [ "$TOKEN_LINE" = fixture-token ] || failure auth 'the fixture refused that token'

SOURCE_JSON=
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE_JSON=${2-}; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ -n "$SOURCE_JSON" ] || bug '--source is required'
LOCATOR=$(printf '%s' "$SOURCE_JSON" | jq -r '.locator // ""') || bug '--source is not JSON'
[ -n "${FM_SOURCE_FIXTURE_DIR:-}" ] || failure invalid 'no fixture world is configured'
[[ "$LOCATOR" =~ ^[A-Za-z0-9_-]+$ ]] || failure invalid "'$LOCATOR' is not a fixture world"
WORLD="$FM_SOURCE_FIXTURE_DIR/$LOCATOR.json"
[ -f "$WORLD" ] || failure not_found "no fixture world '$LOCATOR'"

save_world() {  # <jq program> [jq args...]; rewrites the world atomically
  local program=$1 staged
  shift
  staged=$(mktemp "$WORLD.XXXXXX")
  jq "$@" "$program" "$WORLD" > "$staged" && mv -f "$staged" "$WORLD"
}

# Pop this verb's next injected fault, if any.
fault() {
  local next
  next=$(jq -r --arg verb "$VERB" '(.faults[$verb] // [])[0] // empty' "$WORLD")
  [ -n "$next" ] || return 1
  save_world '.faults[$verb] |= .[1:]' --arg verb "$VERB"
  [ "$next" != ok ] || return 1
  printf '%s' "$next"
}

CONVERT_JQ='
  def wiki_to_md: gsub("(?m)^h(?<n>[1-6])\\. "; "\(("#" * (.n | tonumber))) ")
    | gsub("\\{\\{(?<c>[^}]+)\\}\\}"; "`\(.c)`")
    | gsub("(?<![*])\\*(?<b>[^*\n]+)\\*(?![*])"; "**\(.b)**");
  def md_to_wiki: gsub("(?m)^(?<h>#{1,6}) "; "h\(.h | length). ")
    | gsub("`(?<c>[^`]+)`"; "{{\(.c)}}")
    | gsub("\\*\\*(?<b>[^*\n]+)\\*\\*"; "*\(.b)*");
  def category($w; $item): ($w.workflows[$item.workflow // "default"].statuses[$item.status]) // "new";
  def contract_state($c): if $c == "new" then "open" else $c end;
  def item($w):
    . as $i
    | {id:.id, key:.key, url:("https://fixture.invalid/browse/" + .key),
       title:(.summary // ""), body:((.description // "") | wiki_to_md),
       state:contract_state(category($w; $i)), state_name:.status,
       assignee:(.assignee // null), updated_at:(.updated + ":00Z"), deleted:(.deleted // false),
       comments:[(.comments // [])[] | {id, author, ours:(.write_id != null), at:.created, body:(.body | wiki_to_md)}]};'

item_json() {  # <id>; the contract item, or nothing
  jq -c --arg id "$1" "$CONVERT_JQ"'. as $w | .items[] | select(.id == $id) | item($w)' "$WORLD"
}

case "$VERB" in
  probe)
    code=$(fault) && failure "$code" "injected $code"
    jq -c '{ok:true, identity:(.identity // "fixture-bot"),
      can:(.can // {read:true,comment:true,advance:true}), scopes:(.scopes // []), reach:(.reach // [])}' "$WORLD"
    ;;
  changes)
    since=null budget=
    set -- "${ARGS[@]}"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --since) since=${2-null}; shift 2 ;;
        --budget) budget=${2-}; shift 2 ;;
        *) bug "unknown changes argument '$1'" ;;
      esac
    done
    case "$budget" in ''|*[!0-9]*|0) bug '--budget must be a positive number of seconds' ;; esac
    code=$(fault) && failure "$code" "injected $code"
    filter=$(printf '%s' "$SOURCE_JSON" | jq -r '.filter // ""')
    [[ "$filter" =~ ^labels\ =\ ([A-Za-z0-9_-]+)$ ]] || failure invalid "the filter must read 'labels = <name>'"
    label=${BASH_REMATCH[1]}
    if [ "$since" = null ] || [ -z "$since" ]; then
      jq -c '{ok:true,items:[],cursor:(([.items[].updated] | max) // "1970-01-01T00:00"),more:false}' "$WORLD"
      exit 0
    fi
    # The cursor is `<minute>` or, part way through a query, `<minute>#<offset>`:
    # like JQL's startAt, the offset pages within one query, because a minute
    # can hold more items than one page.
    [[ "$since" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})(#([0-9]+))?$ ]] || failure invalid 'not a fixture cursor'
    minute=${BASH_REMATCH[1]} offset=${BASH_REMATCH[3]:-0}
    # Minute precision: read from a minute before the cursor, as JQL must.
    jq -c --arg since "$minute" --argjson offset "$offset" --arg label "$label" --argjson budget "$budget" \
      --argjson linked "$(printf '%s' "$SOURCE_JSON" | jq -c '.linked // []')" "$CONVERT_JQ"'
      . as $w
      | (($since + ":00Z") | fromdateiso8601 - 60 | todateiso8601 | .[:16]) as $from
      | [.items[] | select(.updated >= $from)
          | . + {matches:((.labels // []) | index($label) != null)}
          | select(.matches or (.id as $id | $linked | index($id) != null))]
      | sort_by(.updated, .id) as $all
      | ($w.page_size // 100) as $size
      | ($w.seconds_per_page // 0) as $cost
      | ([1, (if $cost == 0 then 1000000 else ($budget / $cost | floor) end)] | max) as $pages
      | $all[$offset : $offset + $pages * $size] as $read
      | (($all | length) > ($offset + ($read | length))) as $more
      | {ok:true,
         items:[$read[] | (. as $i | item($w) + {matches:$i.matches})],
         cursor:(if $more then $since + "#" + (($offset + ($read | length)) | tostring)
                 elif ($all | length) == 0 then $since else ($all | map(.updated) | max) end),
         more:$more}' "$WORLD"
    ;;
  resolve)
    [ "${#ARGS[@]}" -eq 1 ] || bug 'resolve takes one key or URL'
    code=$(fault) && failure "$code" "injected $code"
    ref=${ARGS[0]##*/}
    id=$(jq -r --arg ref "$ref" '[.items[] | select(.key == $ref or .id == $ref) | .id] | first // empty' "$WORLD")
    [ -n "$id" ] || failure not_found "no item $ref"
    jq -cn --argjson item "$(item_json "$id")" '{ok:true,item:$item}'
    ;;
  comment)
    set -- "${ARGS[@]}"
    item=${1-}; shift || true
    write_id=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --write-id) write_id=${2-}; shift 2 ;;
        *) bug "unknown comment argument '$1'" ;;
      esac
    done
    [ -n "$item" ] && [ -n "$write_id" ] || bug 'comment needs an item id and --write-id'
    body=$(cat)
    [ -n "$body" ] || failure invalid 'the comment is empty'
    jq -e --arg id "$item" 'any(.items[]; .id == $id)' "$WORLD" >/dev/null || failure not_found "no item $item"
    existing=$(jq -r --arg id "$item" --arg w "$write_id" \
      '[.items[] | select(.id == $id) | (.comments // [])[] | select(.write_id == $w) | .id] | first // empty' "$WORLD")
    if [ -n "$existing" ]; then
      jq -cn --arg id "$existing" '{ok:true,comment_id:$id,deduplicated:true}'
      exit 0
    fi
    code=$(fault) || code=
    case "$code" in
      ''|lose-response) ;;
      unconfirmed) failure provider unconfirmed ;;
      *) failure "$code" "injected $code" ;;
    esac
    comment_id="c-$write_id"
    save_world "$CONVERT_JQ"'
      (.identity // "fixture-bot") as $me
      | (.items[] | select(.id == $id)) |= (.comments = ((.comments // []) + [{id:$cid, author:$me,
        created:"2026-09-25T12:00:00Z", body:($body | md_to_wiki), write_id:$w}]))' \
      --arg id "$item" --arg cid "$comment_id" --arg body "$body" --arg w "$write_id"
    # The post landed; the answer did not reach the caller.
    [ "$code" != lose-response ] || failure timeout 'the answer was lost after posting'
    jq -cn --arg id "$comment_id" '{ok:true,comment_id:$id,deduplicated:false}'
    ;;
  advance)
    [ "${#ARGS[@]}" -eq 2 ] || bug 'advance takes an item id and an intent'
    item=${ARGS[0]} intent=${ARGS[1]}
    case "$intent" in started|in-review|delivered) ;; *) bug "'$intent' is not an intent" ;; esac
    code=$(fault) || code=
    case "$code" in ''|unconfirmed) ;; *) failure "$code" "injected $code" ;; esac
    jq -e --arg id "$item" 'any(.items[]; .id == $id)' "$WORLD" >/dev/null || failure not_found "no item $item"
    review=$(printf '%s' "$SOURCE_JSON" | jq -r '.review_state // ""')
    answer=$(jq -c --arg id "$item" --arg intent "$intent" --arg review "$review" "$CONVERT_JQ"'
      . as $w
      | (.items[] | select(.id == $id)) as $i
      | $w.workflows[$i.workflow // "default"] as $flow
      | category($w; $i) as $from
      | ({new:0,started:1,done:2,cancelled:2}[$from]) as $rank
      | [($flow.transitions[$i.status] // [])[] | {to:., category:($flow.statuses[.] // "new")}] as $out
      | if $intent == "started" then
          if $rank >= 1 then {result:(if $from == "started" then "already" else "would-regress" end)}
          else [$out[] | select(.category == "started" and (.to | test("review"; "i") | not))] as $c
            | if ($c | length) == 1 then {result:"moved",to:$c[0].to}
              elif ($c | length) == 0 then {result:"not-supported",candidates:[]}
              else {result:"ambiguous",candidates:[$c[].to]} end end
        elif $intent == "in-review" then
          if $rank >= 2 then {result:"would-regress"}
          elif ($i.status | test("review"; "i")) then {result:"already"}
          else [$out[] | select(.category == "started" and (.to | test("review"; "i")))] as $c
            | if $review != "" then
                (if any($c[]; .to == $review) then {result:"moved",to:$review} else {result:"not-supported",candidates:[$c[].to]} end)
              elif ($c | length) == 1 then {result:"moved",to:$c[0].to}
              elif ($c | length) == 0 then {result:"not-supported",candidates:[]}
              else {result:"ambiguous",candidates:[$c[].to]} end end
        else
          if $from == "done" then {result:"already"}
          elif $from == "cancelled" then {result:"would-regress"}
          else [$out[] | select(.category == "done")] as $c
            | if ($c | length) == 1 then {result:"moved",to:$c[0].to}
              elif ($c | length) == 0 then {result:"not-supported",candidates:[]}
              else {result:"ambiguous",candidates:[$c[].to]} end end
        end
      | {ok:true,result,from:$i.status,to:(.to // null),candidates:(.candidates // [])}' "$WORLD")
    if [ "$(printf '%s' "$answer" | jq -r .result)" = moved ]; then
      if [ "$code" != unconfirmed ]; then
        save_world '(.items[] | select(.id == $id)) |= (.status = $to)' --arg id "$item" --arg to "$(printf '%s' "$answer" | jq -r .to)"
      fi
      # Read it back: a move that did not land is unconfirmed.
      [ "$(jq -r --arg id "$item" '.items[] | select(.id == $id) | .status' "$WORLD")" = "$(printf '%s' "$answer" | jq -r .to)" ] \
        || failure provider unconfirmed
    fi
    printf '%s\n' "$answer"
    ;;
  *) bug "unknown verb '$VERB'" ;;
esac
