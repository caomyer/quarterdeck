#!/usr/bin/env bash
# The GitHub Issues adapter against a fake `gh`: the contract's item shape, the
# intake filter, idempotent comments by marker, and typed failures. It never
# reaches GitHub; the adapter's live reads are exercised by hand against a real
# repository, and a live comment is an outward write no test makes.
set -u
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
TMP_ROOT=$(fm_test_tmproot fm-source-github)
FAKE="$TMP_ROOT/fake"
mkdir -p "$FAKE/bin"

cat > "$FAKE/bin/gh" <<'EOF'
#!/usr/bin/env bash
# A fake gh: canned answers from $FAKE_GH, every argv logged.
printf '%s\n' "$*" >> "$FAKE_GH/argv.log"
if [ -s "$FAKE_GH/fail-next" ]; then
  cat "$FAKE_GH/fail-next" >&2; : > "$FAKE_GH/fail-next"; exit 1
fi
[ "$1" = api ] || exit 2
shift
method=GET input=
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --method) method=$2; shift 2 ;;
    --input) input=$2; shift 2 ;;
    --paginate) shift ;;
    --slurp) slurp=1; shift ;;
    -i) headers=1; shift ;;
    -f) args+=("$2"); shift 2 ;;
    --jq) jqf=$2; shift 2 ;;
    *) path=$1; shift ;;
  esac
done
wrap() { if [ -n "${slurp:-}" ]; then jq -c '[.]'; else cat; fi; }
case "$path" in
  user) printf 'HTTP/2.0 200 OK\r\nX-Oauth-Scopes: repo, read:org\r\n\r\n{"login":"me"}\n' ;;
  rate_limit) jq -n '{resources:{core:{reset:1790000000}}}' | jq -r "${jqf:-.}" ;;
  repos/o/r) printf '{"full_name":"o/r","has_issues":true,"permissions":{"pull":true,"triage":false,"push":false}}\n' ;;
  graphql)
    id=${args[1]#id=}
    jq -c --arg id "$id" '[.[] | select(.node_id == $id)] | first
      | if . == null then {data:{node:null}} else {data:{node:{number,repository:{nameWithOwner:"o/r"}}}} end' "$FAKE_GH/issues.json" ;;
  repos/o/r/issues\?*) jq -c . "$FAKE_GH/issues.json" ;;
  repos/o/r/issues/comments/*)
    jq -c --arg id "${path##*/}" '[.[] | select((.id | tostring) == $id)] | first' "$FAKE_GH/comments.json" ;;
  repos/o/r/issues/*/comments*)
    n=${path#repos/o/r/issues/}; n=${n%%/*}
    if [ "$method" = POST ]; then
      next=$(( $(jq length "$FAKE_GH/comments.json") + 100 ))
      jq -c --slurpfile p "$input" --argjson n "$n" --argjson id "$next" \
        '. + [{id:$id,node_id:("IC_" + ($id | tostring)),issue:$n,user:{login:"me"},created_at:"2026-09-25T10:00:00Z",body:$p[0].body}]' \
        "$FAKE_GH/comments.json" > "$FAKE_GH/c.tmp" && mv "$FAKE_GH/c.tmp" "$FAKE_GH/comments.json"
      if [ -e "$FAKE_GH/lose-post" ]; then rm -f "$FAKE_GH/lose-post"; echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi
      jq -c --argjson id "$next" '.[] | select(.id == $id)' "$FAKE_GH/comments.json"
    else
      jq -c --argjson n "$n" '[.[] | select(.issue == $n)]' "$FAKE_GH/comments.json" | wrap
    fi ;;
  repos/o/r/issues/*)
    jq -ce --argjson n "${path##*/}" '[.[] | select(.number == $n)] | first' "$FAKE_GH/issues.json" \
      || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
EOF
chmod +x "$FAKE/bin/gh"

issue() {  # <number> <labels-json> <state> [reason]
  jq -cn --argjson n "$1" --argjson labels "$2" --arg state "$3" --arg reason "${4:-}" \
    '{number:$n,node_id:("I_" + ($n | tostring)),html_url:("https://github.com/o/r/issues/" + ($n | tostring)),
      title:("Issue " + ($n | tostring)),body:"Body **text**",state:$state,
      state_reason:(if $reason == "" then null else $reason end),labels:[$labels[] | {name:.}],
      assignees:[],updated_at:"2026-09-25T10:00:00Z"}'
}
reset_fake() {
  jq -n --argjson a "$(issue 5 '["Quarterdeck"]' open)" --argjson b "$(issue 6 '["other"]' open)" \
    --argjson c "$(issue 7 '[]' closed not_planned)" \
    '[$a, $b, $c, {number:8,node_id:"PR_8",pull_request:{},state:"open",labels:[{name:"quarterdeck"}],updated_at:"2026-09-25T10:00:00Z"}]' \
    > "$FAKE/issues.json"
  printf '[]' > "$FAKE/comments.json"
  : > "$FAKE/argv.log"; : > "$FAKE/fail-next"; rm -f "$FAKE/lose-post"
}
gha() {  # <verb> <args...>; the token line and any body arrive on stdin
  PATH="$FAKE/bin:$PATH" FAKE_GH="$FAKE" "$ROOT/bin/fm-source-github.sh" "$@"
}
CFG='{"id":"github:o/r","provider":"github","locator":"o/r","filter":"label:quarterdeck is:open","identity":"me","linked":[]}'

test_items_and_filter() {
  local out
  reset_fake
  out=$(printf '\n' | gha probe --source "$CFG")
  printf '%s' "$out" | jq -e '.ok and .identity == "me" and .can == {read:true,comment:true,advance:false} and .scopes == ["repo","read:org"]' >/dev/null \
    || fail "probe answered $out"
  out=$(printf '\n' | gha changes --source "$(jq -c '.linked = ["I_7"]' <<< "$CFG")" --since 2026-09-01T00:00:00Z --budget 10)
  printf '%s' "$out" | jq -e '[.items[] | [.key, .matches, .state]] == [["#5",true,"open"],["#7",false,"cancelled"]]
    and .items[0].id == "I_5" and .items[0].body == "Body **text**" and .more == false' >/dev/null \
    || fail "changes did not keep what the filter matches plus what is linked, without pull requests: $out"
  out=$(printf '\n' | gha changes --source "$CFG" --since null --budget 10)
  printf '%s' "$out" | jq -e '.ok and .items == [] and (.cursor | test("Z$"))' >/dev/null || fail "since null returned history: $out"
  out=$(printf '\n' | gha changes --source "$(jq -c '.filter = "is:open"' <<< "$CFG")" --since null --budget 10)
  printf '%s' "$out" | jq -e '.ok == false and .error.code == "invalid"' >/dev/null || fail "a filter without a label was accepted: $out"
  out=$(printf '\n' | gha resolve 'https://github.com/o/r/issues/5' --source "$CFG")
  printf '%s' "$out" | jq -e '.item.key == "#5" and .item.state_name == "open"' >/dev/null || fail "resolve by URL answered $out"
  out=$(printf '\n' | gha resolve I_7 --source "$CFG")
  printf '%s' "$out" | jq -e '.item.key == "#7" and .item.state == "cancelled"' >/dev/null || fail "resolve by item id answered $out"
  out=$(printf '\n' | gha resolve '#8' --source "$CFG")
  printf '%s' "$out" | jq -e '.ok == false and .error.code == "invalid"' >/dev/null || fail "a pull request resolved as an issue: $out"
  out=$(printf '\n' | gha resolve 'x/y#5' --source "$CFG")
  printf '%s' "$out" | jq -e '.ok == false and .error.code == "not_found"' >/dev/null || fail "another repository's issue resolved: $out"
  pass 'items keep the contract shape, the filter needs a label, and pull requests are never items'
}

test_comment_is_idempotent_and_off_argv() {
  local out
  reset_fake
  out=$(printf '\nThe secret-free **body**\n' | gha comment I_5 --write-id fm-abcdef123456 --source "$CFG")
  printf '%s' "$out" | jq -e '.ok and .deduplicated == false' >/dev/null || fail "comment answered $out"
  ! grep -q 'secret-free' "$FAKE/argv.log" || fail 'the comment body reached argv'
  jq -e '.[0].body | endswith("<!-- fm-write:fm-abcdef123456 -->")' "$FAKE/comments.json" >/dev/null || fail 'the write id marker is missing'
  out=$(printf '\nThe secret-free **body**\n' | gha comment I_5 --write-id fm-abcdef123456 --source "$CFG")
  printf '%s' "$out" | jq -e '.ok and .deduplicated == true' >/dev/null || fail "a repeated write id posted again: $out"
  # Posted, but the answer lost: the retry finds it.
  touch "$FAKE/lose-post"
  out=$(printf '\nSecond\n' | gha comment I_5 --write-id fm-second-000001 --source "$CFG")
  printf '%s' "$out" | jq -e '.ok == false and .error.code == "provider"' >/dev/null || fail "a lost answer read as success: $out"
  out=$(printf '\nSecond\n' | gha comment I_5 --write-id fm-second-000001 --source "$CFG")
  printf '%s' "$out" | jq -e '.deduplicated == true' >/dev/null || fail "the retry after a lost answer posted again: $out"
  [ "$(jq length "$FAKE/comments.json")" = 2 ] || fail 'not exactly one comment per write id'
  out=$(printf '\n' | gha advance I_5 delivered --source "$CFG")
  printf '%s' "$out" | jq -e '.result == "not-supported"' >/dev/null || fail "delivered on an open issue answered $out"
  out=$(printf '\n' | gha advance I_7 delivered --source "$CFG")
  printf '%s' "$out" | jq -e '.result == "already"' >/dev/null || fail "delivered on a closed issue answered $out"
  out=$(printf '\n' | gha advance I_5 in-review --source "$CFG")
  printf '%s' "$out" | jq -e '.result == "not-supported"' >/dev/null || fail "GitHub claimed a review state: $out"
  pass 'a comment carries its write id as a marker, never reaches argv, and posts once'
}

test_typed_failures() {
  local out
  reset_fake
  printf 'gh: Bad credentials (HTTP 401) token ghp_abcdefghijklmnop123\n' > "$FAKE/fail-next"
  out=$(printf '\n' | gha probe --source "$CFG")
  printf '%s' "$out" | jq -e '.error.code == "auth" and (.error.detail | contains("ghp_") | not)' >/dev/null \
    || fail "a refused sign-in answered $out"
  printf 'gh: API rate limit exceeded (HTTP 403)\n' > "$FAKE/fail-next"
  out=$(printf '\n' | gha changes --source "$CFG" --since 2026-09-01T00:00:00Z --budget 10)
  printf '%s' "$out" | jq -e '.error.code == "rate_limited" and (.error.retry_at | test("^2026-"))' >/dev/null \
    || fail "a rate limit answered $out"
  printf 'dial tcp: lookup api.github.com: no such host\n' > "$FAKE/fail-next"
  out=$(printf '\n' | gha changes --source "$CFG" --since 2026-09-01T00:00:00Z --budget 10)
  printf '%s' "$out" | jq -e '.error.code == "network"' >/dev/null || fail "no network answered $out"
  out=$(printf '\n' | gha resolve '#99' --source "$CFG")
  printf '%s' "$out" | jq -e '.error.code == "not_found"' >/dev/null || fail "a missing issue answered $out"
  pass 'failures are typed, and a token never reaches their detail'
}

test_items_and_filter
test_comment_is_idempotent_and_off_argv
test_typed_failures
