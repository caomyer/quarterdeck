#!/usr/bin/env bash
# Behavior tests for bin/fm-artifact.sh.
# Covers presenting task and chat artifacts as immutable revisions, idempotent
# re-presents, assets and their symlink and size refusals, input refusals,
# concurrent presents claiming distinct revision numbers, listing that ignores
# incomplete or misplaced revisions, the presentation-mode decision, the fleet
# snapshot carrying the listing, and the pre-present layout check through a fake
# Chrome (refuse, accept, clean, fail-open) plus one real headless Chrome run
# that skips when no Chrome is installed.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }

ARTIFACT="$ROOT/bin/fm-artifact.sh"
TMP_ROOT=$(fm_test_tmproot fm-artifact)
# Suites other than the layout ones present without a browser.
export FM_ARTIFACT_LAYOUT=0

# new_home <label>: a disposable home with one known task, t1.
new_home() {
  local home="$TMP_ROOT/$1/home"
  mkdir -p "$home/data/t1" "$home/state" "$home/config"
  printf '%s\n' "$home"
}

write_page() {  # <path> <title> [body]
  mkdir -p "$(dirname "$1")"
  printf '<html><head><title>%s</title></head><body>%s</body></html>\n' "$2" "${3:-}" > "$1"
}

test_present_creates_an_immutable_revision() {
  local home out rc rev
  home=$(new_home present)
  write_page "$TMP_ROOT/present/src/My_Plan.html" '  Launch   plan '
  out=$(FM_HOME="$home" FM_TASK_ID=t1 "$ARTIFACT" present --task t1 "$TMP_ROOT/present/src/My_Plan.html" --note 'first cut' 2>&1); rc=$?
  expect_code 0 "$rc" "present"
  rev="$home/data/t1/artifacts/my-plan/rev-1"
  assert_contains "$out" "presented: my-plan rev 1" "present reports the new revision"
  assert_contains "$out" "entry: $rev/files/My_Plan.html" "present reports the entry path"
  assert_present "$rev/files/My_Plan.html" "revision holds the HTML"
  assert_equals "fm-artifact-revision.v1|task|t1|my-plan|1|Launch plan|first cut|My_Plan.html|crew|t1" \
    "$(jq -r '[.schema,.scope,.task,.name,.rev,.title,.note,.entry,.presented_by.role,.presented_by.task] | join("|")' "$rev/revision.json")" \
    "revision.json records the presentation"
  assert_equals "$(wc -c < "$rev/files/My_Plan.html" | tr -d ' ')" "$(jq -r .bytes "$rev/revision.json")" "bytes is the real content size"
  pass "fm-artifact.sh: present stores a task revision with its metadata"
}

test_represent_is_idempotent_and_changes_add_revisions() {
  local home src out
  home=$(new_home idem)
  src="$TMP_ROOT/idem/page.html"
  write_page "$src" Page one
  FM_HOME="$home" "$ARTIFACT" present --task t1 "$src" >/dev/null || fail "first present failed"
  out=$(FM_HOME="$home" "$ARTIFACT" present --task t1 "$src") || fail "re-present failed"
  assert_contains "$out" "unchanged: page rev 1" "identical content creates no revision"
  assert_absent "$home/data/t1/artifacts/page/rev-2" "identical content left a second revision"
  write_page "$src" Page two
  out=$(FM_HOME="$home" "$ARTIFACT" present --task t1 "$src" --title 'Renamed') || fail "changed present failed"
  assert_contains "$out" "presented: page rev 2" "changed content creates the next revision"
  assert_equals "one" "$(sed -n 's/.*<body>\(.*\)<\/body>.*/\1/p' "$home/data/t1/artifacts/page/rev-1/files/page.html")" "revision 1 is never rewritten"
  assert_equals "Renamed|firstmate" "$(jq -r '[.title,.presented_by.role] | join("|")' "$home/data/t1/artifacts/page/rev-2/revision.json")" "--title and presenter recorded"
  pass "fm-artifact.sh: identical re-present is a no-op and changes add revisions"
}

test_chat_scope_and_assets() {
  local home src out
  home=$(new_home chat)
  src="$TMP_ROOT/chat/src"
  write_page "$src/board.html" Board '<img src="img/a.png">'
  mkdir -p "$src/img"
  printf 'png' > "$src/img/a.png"
  out=$(FM_HOME="$home" "$ARTIFACT" present --chat "$src/board.html" --assets "$src") || fail "chat present failed: $out"
  assert_present "$home/data/.artifacts/board/rev-1/files/img/a.png" "assets are copied beside the HTML"
  assert_equals "chat|null" "$(jq -r '[.scope,(.task|tostring)] | join("|")' "$home/data/.artifacts/board/rev-1/revision.json")" "chat revision has no task"
  pass "fm-artifact.sh: chat artifacts and assets"
}

test_refusals() {
  local home src out rc
  home=$(new_home refuse)
  src="$TMP_ROOT/refuse/page.html"
  write_page "$src" Page
  out=$(FM_HOME="$home" "$ARTIFACT" present "$src" 2>&1); rc=$?
  expect_code 1 "$rc" "missing scope"
  out=$(FM_HOME="$home" "$ARTIFACT" present --task t1 --chat "$src" 2>&1); rc=$?
  expect_code 1 "$rc" "both scopes"
  out=$(FM_HOME="$home" "$ARTIFACT" present --task nope "$src" 2>&1); rc=$?
  expect_code 1 "$rc" "unknown task"
  assert_contains "$out" "unknown task 'nope'" "unknown task is named"
  assert_absent "$home/data/nope" "unknown task created a directory"
  out=$(FM_HOME="$home" "$ARTIFACT" present --task ../t1 "$src" 2>&1); rc=$?
  expect_code 1 "$rc" "path-unsafe task id"
  printf 'x' > "$TMP_ROOT/refuse/notes.txt"
  out=$(FM_HOME="$home" "$ARTIFACT" present --task t1 "$TMP_ROOT/refuse/notes.txt" 2>&1); rc=$?
  expect_code 1 "$rc" "non-HTML file"
  out=$(FM_HOME="$home" "$ARTIFACT" present --task t1 "$src" --name 'Bad/Name' 2>&1); rc=$?
  expect_code 1 "$rc" "invalid name"
  mkdir -p "$TMP_ROOT/refuse/linked"
  ln -s /etc/hosts "$TMP_ROOT/refuse/linked/hosts"
  out=$(FM_HOME="$home" "$ARTIFACT" present --task t1 "$src" --assets "$TMP_ROOT/refuse/linked" 2>&1); rc=$?
  expect_code 1 "$rc" "symlinked assets"
  assert_contains "$out" "symbolic links" "symlink refusal is explained"
  out=$(FM_HOME="$home" FM_ARTIFACT_MAX_BYTES=10 "$ARTIFACT" present --task t1 "$src" 2>&1); rc=$?
  expect_code 1 "$rc" "over the size cap"
  assert_contains "$out" "byte cap" "size refusal is explained"
  assert_absent "$home/data/t1/artifacts/page/rev-1" "a refused present left a revision"
  [ -z "$(find "$home/data/t1/artifacts" -name '.stage.*' 2>/dev/null)" ] || fail "a refused present left a staging directory"
  pass "fm-artifact.sh: invalid input is refused without leaving revisions behind"
}

test_concurrent_presents_claim_distinct_revisions() {
  local home i pids='' pid
  home=$(new_home race)
  for i in 1 2 3 4 5 6; do
    write_page "$TMP_ROOT/race/src$i/page.html" Page "$i"
  done
  for i in 1 2 3 4 5 6; do
    FM_HOME="$home" "$ARTIFACT" present --task t1 "$TMP_ROOT/race/src$i/page.html" >/dev/null 2>&1 &
    pids="$pids $!"
  done
  for pid in $pids; do
    wait "$pid" || fail "a concurrent present failed"
  done
  assert_equals "1 2 3 4 5 6" \
    "$(FM_HOME="$home" "$ARTIFACT" list --json | jq -r '.artifacts[0].revisions | map(.rev) | map(tostring) | join(" ")')" \
    "concurrent presents claim distinct complete revisions"
  assert_equals "6" \
    "$(find "$home/data/t1/artifacts/page" -name page.html -path '*/files/*' -exec cat {} + | sed -n 's/.*<body>\(.*\)<\/body>.*/\1/p' | sort -u | wc -l | tr -d ' ')" \
    "every concurrent revision kept its own content"
  pass "fm-artifact.sh: concurrent presents get distinct revision numbers"
}

test_list_ignores_incomplete_and_misplaced_revisions() {
  local home out
  home=$(new_home list)
  out=$(FM_HOME="$home" "$ARTIFACT" list) || fail "empty list failed"
  assert_equals "artifacts: none" "$out" "empty store"
  write_page "$TMP_ROOT/list/a.html" Alpha
  write_page "$TMP_ROOT/list/b.html" Beta
  FM_HOME="$home" "$ARTIFACT" present --task t1 "$TMP_ROOT/list/a.html" >/dev/null || fail "present a failed"
  FM_HOME="$home" "$ARTIFACT" present --chat "$TMP_ROOT/list/b.html" >/dev/null || fail "present b failed"
  # An interrupted present: a claimed revision with no revision.json.
  mkdir -p "$home/data/t1/artifacts/a/rev-2/files"
  # A record copied to the wrong place must not be trusted.
  mkdir -p "$home/data/t1/artifacts/stolen/rev-1"
  cp "$home/data/t1/artifacts/a/rev-1/revision.json" "$home/data/t1/artifacts/stolen/rev-1/revision.json"
  out=$(FM_HOME="$home" "$ARTIFACT" list --json) || fail "list --json failed"
  assert_equals "fm-artifact-list.v1" "$(printf '%s' "$out" | jq -r .schema)" "listing schema"
  assert_equals "a:1:1,b:1:1" \
    "$(printf '%s' "$out" | jq -r '[.artifacts[] | "\(.name):\(.latest.rev):\(.revisions|length)"] | sort | join(",")')" \
    "listing skips incomplete and misplaced revisions"
  assert_equals "$home/data/t1/artifacts/a/rev-1/files/a.html|$home/data/t1/artifacts/a" \
    "$(printf '%s' "$out" | jq -r '.artifacts[] | select(.name == "a") | "\(.latest.path)|\(.dir)"')" \
    "listing carries absolute entry and artifact paths"
  out=$(FM_HOME="$home" "$ARTIFACT" list) || fail "list failed"
  assert_contains "$out" "task t1  a  rev 1  Alpha" "text listing names task artifacts"
  assert_contains "$out" "chat  b  rev 1  Beta" "text listing names chat artifacts"
  pass "fm-artifact.sh: list reports complete revisions only"
}

test_mode_resolution() {
  local home out rc
  home=$(new_home mode)
  assert_equals lavish "$(FM_HOME="$home" FM_PRESENTATION='' "$ARTIFACT" mode)" "default mode"
  printf '\n  quarterdeck \n' > "$home/config/presentation"
  assert_equals quarterdeck "$(FM_HOME="$home" FM_PRESENTATION='' "$ARTIFACT" mode)" "config/presentation"
  assert_equals lavish "$(FM_HOME="$home" FM_PRESENTATION=lavish "$ARTIFACT" mode)" "environment wins"
  printf 'lavishh\n' > "$home/config/presentation"
  out=$(FM_HOME="$home" FM_PRESENTATION='' "$ARTIFACT" mode 2>&1); rc=$?
  expect_code 1 "$rc" "unknown mode"
  assert_contains "$out" "unknown presentation mode 'lavishh'" "unknown mode is named"
  pass "fm-artifact.sh: presentation mode resolves env, then config, then lavish"
}

test_fleet_snapshot_lists_artifacts() {
  local home out
  home=$(new_home snapshot)
  write_page "$TMP_ROOT/snapshot/plan.html" Plan
  FM_HOME="$home" "$ARTIFACT" present --task t1 "$TMP_ROOT/snapshot/plan.html" >/dev/null || fail "present failed"
  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE='' "$ROOT/bin/fm-fleet-snapshot.sh" --json 2>/dev/null) || fail "fleet snapshot failed"
  assert_equals "t1|plan|1|Plan" \
    "$(printf '%s' "$out" | jq -r '.artifacts[0] | [.task,.name,.latest.rev,.title] | join("|")')" \
    "fleet snapshot carries the artifact listing"
  pass "fm-artifact.sh: the fleet snapshot lists presented artifacts"
}

# fake_chrome <dir> <wide-issues-json> <narrow-issues-json>: a Chrome stand-in
# that dumps a DOM carrying the probe marker for the requested window width, then
# stays running the way real headless Chrome sometimes does. "hang" emits nothing.
fake_chrome() {
  local dir=$1
  mkdir -p "$dir"
  cat > "$dir/chrome" <<SH
#!/usr/bin/env bash
width=1280
for arg in "\$@"; do
  case "\$arg" in --window-size=*) width=\${arg#--window-size=}; width=\${width%%,*} ;; esac
done
if [ "\$width" = 500 ]; then issues='$3'; else issues='$2'; fi
if [ "\$issues" != hang ]; then
  printf '<html><body><pre id="__fm_artifact_layout__">{&quot;viewport&quot;:%s,&quot;issues&quot;:%s}</pre></body></html>\n' "\$width" "\$(printf '%s' "\$issues" | sed 's/"/\&quot;/g')"
fi
exec sleep 30
SH
  chmod +x "$dir/chrome"
  printf '%s\n' "$dir/chrome"
}

test_layout_findings_refuse_until_fixed_or_accepted() {
  local home src chrome out rc clip
  home=$(new_home layout)
  src="$TMP_ROOT/layout/page.html"
  write_page "$src" Page
  clip='[{"rule":"text-clipped","selector":"div.label","detail":"\"Deploy\" is cut off by 12px"}]'
  chrome=$(fake_chrome "$TMP_ROOT/layout/bin" '[]' "$clip")
  out=$(FM_HOME="$home" FM_ARTIFACT_LAYOUT=1 FM_ARTIFACT_CHROME="$chrome" "$ARTIFACT" present --task t1 "$src" 2>&1); rc=$?
  expect_code 3 "$rc" "layout findings refuse the present"
  assert_contains "$out" 'layout: narrow text-clipped div.label - "Deploy" is cut off by 12px' "finding names viewport, rule, selector, and detail"
  assert_contains "$out" "--accept-layout" "refusal says how to accept"
  assert_absent "$home/data/t1/artifacts/page/rev-1" "a layout refusal created a revision"
  out=$(FM_HOME="$home" FM_ARTIFACT_LAYOUT=1 FM_ARTIFACT_CHROME="$chrome" "$ARTIFACT" present --task t1 "$src" --accept-layout 2>&1); rc=$?
  expect_code 0 "$rc" "accepted layout findings present"
  assert_equals "accepted|narrow|text-clipped" \
    "$(jq -r '[.layout.status, .layout.issues[0].viewport, .layout.issues[0].rule] | join("|")' "$home/data/t1/artifacts/page/rev-1/revision.json")" \
    "accepted findings are recorded on the revision"
  [ -z "$(find "$home/data/t1/artifacts" -name '.fm-artifact-layout-check.html')" ] || fail "the layout scratch page leaked into a revision"
  chrome=$(fake_chrome "$TMP_ROOT/layout/clean" '[]' '[]')
  write_page "$src" Page fixed
  out=$(FM_HOME="$home" FM_ARTIFACT_LAYOUT=1 FM_ARTIFACT_CHROME="$chrome" "$ARTIFACT" present --task t1 "$src" 2>&1); rc=$?
  expect_code 0 "$rc" "clean layout presents"
  assert_equals "clean" "$(jq -r .layout.status "$home/data/t1/artifacts/page/rev-2/revision.json")" "clean layout is recorded"
  pass "fm-artifact.sh: layout findings refuse until fixed or accepted"
}

test_layout_check_fails_open() {
  local home src chrome out rc
  home=$(new_home layout-open)
  src="$TMP_ROOT/layout-open/page.html"
  write_page "$src" Page
  chrome=$(fake_chrome "$TMP_ROOT/layout-open/bin" '[]' hang)
  out=$(FM_HOME="$home" FM_ARTIFACT_LAYOUT=1 FM_ARTIFACT_CHROME="$chrome" FM_ARTIFACT_LAYOUT_TIMEOUT=1 "$ARTIFACT" present --task t1 "$src" 2>&1); rc=$?
  expect_code 0 "$rc" "a browser that never answers does not block the present"
  assert_contains "$out" "layout: skipped (no result from the narrow window within 1s)" "timeout skip is announced"
  write_page "$src" Page again
  out=$(FM_HOME="$home" FM_ARTIFACT_LAYOUT=1 FM_ARTIFACT_CHROME="$TMP_ROOT/layout-open/missing" "$ARTIFACT" present --task t1 "$src" 2>&1); rc=$?
  expect_code 0 "$rc" "no browser does not block the present"
  assert_contains "$out" "layout: skipped (no Chrome or Chromium found)" "missing browser skip is announced"
  assert_equals "skipped|skipped" \
    "$(jq -rs 'map(.layout.status) | join("|")' "$home/data/t1/artifacts/page/rev-1/revision.json" "$home/data/t1/artifacts/page/rev-2/revision.json")" \
    "skips are recorded, never passed off as clean"
  pass "fm-artifact.sh: the layout check fails open and says so"
}

# One real headless Chrome run over a page with a known overflow and a known
# clipped label, so the probe rules are exercised by a real layout engine.
test_layout_check_with_real_chrome() {
  local home src out rc
  home=$(new_home layout-real)
  src="$TMP_ROOT/layout-real/page.html"
  mkdir -p "$TMP_ROOT/layout-real"
  cat > "$src" <<'HTML'
<html><head><title>Real</title><style>
body { margin: 0; font: 16px sans-serif; }
.wide { width: 1500px; }
.clip { width: 120px; overflow: hidden; white-space: nowrap; }
.fine { width: 120px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style></head><body>
<div class="clip">This label is far too long to fit</div>
<div class="fine">This label uses an ellipsis and is fine</div>
<span class="sr">Screen reader only text that is visually hidden</span>
<div class="wide">wide</div>
</body></html>
HTML
  out=$(FM_HOME="$home" FM_ARTIFACT_LAYOUT=1 FM_ARTIFACT_CHROME='' "$ARTIFACT" present --task t1 "$src" 2>&1); rc=$?
  case "$out" in
    *"layout: skipped (no Chrome or Chromium found)"*)
      echo "skip - fm-artifact.sh real Chrome layout check: install Chrome or Chromium to run it"
      return 0
      ;;
  esac
  expect_code 3 "$rc" "real Chrome finds the planted layout faults"
  assert_contains "$out" "layout: wide page-scrolls-sideways div.wide" "real Chrome names the over-wide element"
  assert_contains "$out" "layout: narrow text-clipped div.clip" "real Chrome names the clipped label"
  assert_not_contains "$out" "div.fine" "an ellipsis is intentional"
  assert_not_contains "$out" "span.sr" "visually hidden text is intentional"
  pass "fm-artifact.sh: real headless Chrome finds planted layout faults and ignores intentional ones"
}

test_present_creates_an_immutable_revision
test_represent_is_idempotent_and_changes_add_revisions
test_chat_scope_and_assets
test_refusals
test_concurrent_presents_claim_distinct_revisions
test_list_ignores_incomplete_and_misplaced_revisions
test_mode_resolution
test_fleet_snapshot_lists_artifacts
test_layout_findings_refuse_until_fixed_or_accepted
test_layout_check_fails_open
test_layout_check_with_real_chrome
