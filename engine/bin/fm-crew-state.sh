#!/usr/bin/env bash
# fm-crew-state.sh - deterministic read of a crew's CURRENT state.
#
# Why this exists: state/<id>.status is an append-only, best-effort EVENT LOG.
# Crews append only wake-worthy transitions (done/needs-decision/blocked/paused/failed)
# and nothing when they silently resume, so `tail -1` of that log reports the
# last EVENT, not the current STATE. After firstmate resolves a needs-decision
# or blocked and the crew resumes (responds to the gate, the pipeline fixes, it
# re-validates), the log's last line stays stale. This helper never infers the
# current state from a tail of the log: it reads the authoritative source (a
# no-mistakes run-step attributed under bin/fm-nm-run-lib.sh's contract, else
# the pane busy-signature) and reconciles the possibly-stale log against it.
#
# The determinism lives entirely here - run-step / pane / log reads, fixed
# mapping logic, and terminal passed-run PR detail from bounded evidence only,
# with no heuristics and no LLM.
# For a terminal passed no-mistakes run, a matching merge-poll retirement
# receipt is local merged evidence; otherwise a 5s-bounded forge read is tried.
# FM_CREW_STATE_NO_FORGE=1 keeps the receipt read but skips the forge fallback.
# An absent or unreadable PR identity yields an honest unknown, never an
# optimistic merged claim.
# Output is one stable, parseable, token-tight line firstmate can read every
# heartbeat:
#
#   state: <working|parked|done|blocked|paused|failed|unknown> · source: <run-step|pane|status-log|remote-endpoint|none> · <detail>
#
# Logic, in order:
#   1. Resolve worktree + backend target + kind from state/<id>.meta. A meta
#      recording remote_host= is a remote secondmate: its worktree and endpoint
#      live on that host, so the local worktree and pane reads are skipped and
#      the remote host is asked for the endpoint's recovery-grade state
#      (fm-on.sh + fm-remote-secondmate-control.sh state). alive falls through
#      to the routed status log; dead/missing report the remote verdict; an
#      unreachable or unreadable remote reports unknown-remote, never a false
#      gone/dead.
#   2. Matching no-mistakes run for this crew's branch AND current code identity,
#      active or terminal (from `axi status`, or the coarse `no-mistakes runs`
#      fallback)? Branch name alone is not enough: a historical run on a reused
#      branch whose head was rewritten or diverged must not be attributed.
#      A run matches when its head equals the worktree HEAD, or the worktree HEAD
#      is an ancestor of the run head (pipeline fix commits advanced the run on
#      the same line of history). Local work that advanced past the run head, or
#      diverged from it, invalidates attribution. While the pipeline owns the
#      branch (branch_sync.state=pipeline_owned), its own custody attribution
#      binds an ACTIVE run without head equality (fm_nm_run_is_pipeline_owned_active
#      in bin/fm-nm-run-lib.sh).
#      A run head whose commit object the task copy never fetched (the pipeline
#      committed its fix round in its own checkout) cannot be verified locally;
#      that row is recognized only as a provable pipeline-owned continuation -
#      the branch's ACTIVE newest ledger row, anchored by the row immediately
#      before it having ended at exactly this worktree's head - so an active fix
#      round never reads as an older failed run (rule owned by
#      fm_nm_runs_status_for_worktree in bin/fm-nm-run-lib.sh).
#      More than one recorded run can bind to this worktree at once, and
#      bin/fm-nm-run-lib.sh also owns which of them wins: a LIVE run always
#      outranks a terminal one, so a terminal answer here is provisional until
#      the ledger has been asked whether a live sibling run exists.
#      The run-step is AUTHORITATIVE: running/fixing -> working, ci -> working,
#      awaiting_approval/fix_review -> parked (with gate findings), terminal
#      passed/checks-passed -> done, failed/cancelled -> failed. EXCEPT: while
#      the active step is ci, `axi status` alone cannot tell "still waiting on
#      checks" from "checks green, waiting on merge" (see nm_ci_checks_read) -
#      a ci-step log-tail check overrides working -> done once checks read
#      green, so a green PR is never silently read as still-validating. And a
#      terminal FAILED run whose only failure is the ci monitor step, after
#      every substantive step completed and the ci log's last marker reads
#      checks green, also reads done (held-for-merge), never failed: a monitor
#      whose only remaining job is to observe a human merge decision must not
#      convert the absence of that decision into a failure verdict
#      (nm_failed_run_is_green_held_ci; 2026-09-05 jr-voice incident). In the
#      coarse runs-ledger fallback (no steps table, no ci log), a terminal
#      FAILED record whose daemon an explicit probe proves down reads unknown,
#      never failed: an instrument failure must not read as work failure
#      (nm_daemon_probe_down).
#   3. Reconcile the status log: if its last line says needs-decision/blocked but
#      the run-step shows the run moved on, the log is deterministically stale and
#      is flagged superseded. A genuinely parked run plus a needs-decision log
#      agree, and are reported as parked. A `blocked:` line that reports a
#      refused or missing daemon socket remains blocked even if an attributed
#      run record is stale or terminal. Other daemon, timeout, or unreachability
#      claims are superseded BECAUSE THE RUN IS ALIVE when the run is
#      running/fixing with recent reported activity: a killed or timed-out drive
#      call is not daemon death, so that claim is answered by steering the crew
#      to reattach, not by escalating.
#   4. No run for this crew (pre-validation, or kind=scout): fall back to the
#      recorded backend's pane busy state, then the status log's last line only
#      when its verb maps to a recognized run-state. Decision-only events such as
#      `resolved` never become current state or detail.
#   5. Missing meta or torn-down worktree: report unknown · none. If no run is
#      attributed to this crew, a dead endpoint also reports unknown · none rather
#      than trusting a stale status log. On tmux and herdr, which own a
#      recovery-grade classifier, only its positive death evidence reads as gone
#      (the endpoint is authoritatively absent, or its pane holds no agent); an
#      endpoint that merely failed to answer reports unknown · none as
#      unreachable, and an alive endpoint whose scrollback read failed is still
#      classified by step 4. Backends with no classifier keep reading a failed
#      capture as gone. The fallback's own comment owns the per-verdict rules.
#
# Structured output: `fm-crew-state.sh --json <id>` makes exactly the same
# reads and prints one object instead of the line:
#   {state, source, detail, raw, pipeline}
# where raw is the line, byte for byte, and pipeline holds what those reads
# found, with no further no-mistakes, forge or backend call
# (tests/fm-crew-state.test.sh compares both modes' calls on every case):
#   applies   true for a ship task validating through no-mistakes (or a ship
#             row with no recorded mode); false otherwise, with
#   reason    scout | direct-PR | local-only | secondmate, else null
#   read      full (axi status TOON) | coarse (the runs ledger's status word)
#             | none (asked, and no run is this worktree's; or nothing to ask)
#             | unanswered (axi status came back empty: the CLI did not answer,
#             which is not the same as no run) | not_asked (the lookup was
#             never reached: no CLI, a torn-down worktree, a remote mate)
#   run       {id, head, status, outcome}; a coarse read carries only status
#   steps     the steps[] table as [{step, status, findings, duration_ms}];
#             null unless read is full
#   active    the first active_steps[] row as {step, active_for, last_activity,
#             quiet, round}; quiet is the pipeline's own "quiet" prefix
#   gate      {step, status: awaiting_approval | fix_review | null, parked_for}
#             while parked; parked_for is awaiting_agent's "parked <for>"
#   findings  {total, ask_user, rows}: rows are the findings[] table verbatim,
#             ask_user counts rows whose action column is ask-user; a scalar
#             "findings: N awaiting" carries total N with rows [] and ask_user
#             null, "findings: none" is zero
#   ci        the ci step only: running | fixing | green | rearmed (checks were
#             green, then the base advanced; the line still reads working) |
#             not-ready | unknown (the log could not be read) | null when the
#             ci step is not running and no log was read. A passed or
#             checks-passed outcome reads green.
#   pr        {url, state: open | merged | closed | unknown, via}: via is
#             receipt or forge (a passed run's merge evidence), skipped
#             (FM_CREW_STATE_NO_FORGE), unreadable, run (the run is still on
#             its ci step, which ends when the PR merges or closes), or null
#   daemon    down (the coarse probe failed, or a blocked line reports a
#             refused or missing socket) | up (the coarse probe answered) |
#             not_probed
# pipeline is null when the task has no metadata. The ci log carries no
# timestamps, so nothing here says when checks turned green.
#
# Read-only and side-effect free. Always exits 0 on a successful read regardless
# of state; exit 2 only on a usage error (no id).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=bin/fm-tmux-lib.sh
. "$SCRIPT_DIR/fm-tmux-lib.sh"
# shellcheck source=bin/fm-backend.sh
. "$SCRIPT_DIR/fm-backend.sh"
# shellcheck source=bin/fm-classify-lib.sh
. "$SCRIPT_DIR/fm-classify-lib.sh"
# shellcheck source=bin/fm-busy-lib.sh
. "$SCRIPT_DIR/fm-busy-lib.sh"
# shellcheck source=bin/fm-nm-run-lib.sh
. "$SCRIPT_DIR/fm-nm-run-lib.sh"
# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"
# shellcheck source=bin/fm-timeout-lib.sh
. "$SCRIPT_DIR/fm-timeout-lib.sh"

# --json prints the same read as one JSON object instead of the line; the
# header's "Structured output" section owns its shape.
JSON_MODE=0
ID=
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=1 ;;
    *) [ -n "$ID" ] || ID=$arg ;;
  esac
done
[ -n "$ID" ] || { echo "usage: fm-crew-state.sh [--json] <id>" >&2; exit 2; }
if [ "$JSON_MODE" = 1 ] && ! command -v jq >/dev/null 2>&1; then
  echo "fm-crew-state: --json needs jq" >&2
  exit 1
fi

# Fleet snapshot composition supplies its captured metadata path here so every
# state read resolves the same task generation selected by that snapshot.
META=${FM_CREW_STATE_META_OVERRIDE:-"$STATE/$ID.meta"}
LOG=${FM_CREW_STATE_STATUS_OVERRIDE:-"$STATE/$ID.status"}
NM_TIMEOUT=${FM_CREW_STATE_NM_TIMEOUT:-10}
case "$NM_TIMEOUT" in ''|*[!0-9]*) NM_TIMEOUT=10 ;; esac
# How many of the most recent `no-mistakes runs` rows each ledger read
# (fm_nm_runs_status_for_worktree in bin/fm-nm-run-lib.sh) scans, whether it is
# the cross-branch fallback or the live-sibling probe behind a terminal `axi
# status` answer (docs/configuration.md owns the setting). Generous enough to
# still find a branch's own run on a busy multi-crew fleet without listing the
# entire history every call.
FM_CREW_STATE_RUNS_LIMIT=${FM_CREW_STATE_RUNS_LIMIT:-200}
case "$FM_CREW_STATE_RUNS_LIMIT" in ''|*[!0-9]*) FM_CREW_STATE_RUNS_LIMIT=200 ;; esac
SEP=' · '

# Emit the one canonical line and exit 0. Detail is optional. Under --json the
# same state, source, detail and line are printed as one object beside the
# pipeline facts this read already gathered (pipeline_json, below).
emit() {  # <state> <source> [detail]
  local line="state: $1${SEP}source: $2"
  [ -n "${3:-}" ] && line="$line${SEP}$3"
  if [ "$JSON_MODE" = 1 ]; then
    jq -cn --arg state "$1" --arg source "$2" --arg detail "${3:-}" --arg raw "$line" \
      --argjson pipeline "$(pipeline_json)" \
      '{state:$state,source:$source,detail:$detail,raw:$raw,pipeline:$pipeline}'
    exit 0
  fi
  printf '%s\n' "$line"
  exit 0
}

# --- structured output (--json) ---------------------------------------------
# Every fact below comes from a read this script already makes on the path it
# took; building the object adds no no-mistakes, forge or backend call. The
# P_* variables record what each read found as the script goes, and
# pipeline_json folds them with $RUN_OUT's own tables when emit runs.
P_META=0          # 1 once state/<id>.meta was found
P_APPLIES=false   # kind=ship validating through no-mistakes
P_REASON=         # why not: scout | direct-PR | local-only | secondmate
P_READ=none       # full | coarse | none | unanswered | not_asked
P_GATE_STEP=
P_GATE_STATUS=
P_PARKED_FOR=
P_CI=             # set where an outcome itself says checks passed
P_PR_URL=
P_PR_STATE=
P_PR_VIA=
P_DAEMON=not_probed
HAVE_RUN=0
RUN_SOURCE=full
RUN_OUT=""
RUN_STATUS=""
COARSE_STATUS=""
CI_STEP_STATUS=""
CI_LOG_STATE=""
CI_LOG_MARK=""
CI_LOG_READ=0
LOG_LINE=""
LOG_VERB=""

# One TOON table from $RUN_OUT: its header's column list on the first line,
# then each row verbatim. Empty when the table is absent. The header's own
# indentation bounds the block, as nm_steps_rows does.
nm_toon_table() {  # <name>
  printf '%s\n' "$RUN_OUT" | awk -v name="$1" '
    !inblock {
      line = $0
      sub(/^[ \t]+/, "", line)
      if (index(line, name "[") == 1 && match(line, /^[A-Za-z_]+\[[0-9]+\]\{[^}]*\}:/)) {
        hdr = index($0, name)
        cols = substr(line, index(line, "{") + 1)
        cols = substr(cols, 1, index(cols, "}") - 1)
        print cols
        inblock = 1
      }
      next
    }
    {
      if ($0 ~ /^[ \t]*$/) exit
      match($0, /[^ \t]/)
      if (RSTART <= hdr) exit
      sub(/^[ \t]+/, "")
      print
    }
  '
}

# 0 when a row of the findings table has action ask-user. The action column is
# found by name and each row is split respecting TOON quoting, so a finding
# whose description, file or branch merely mentions ask-user never counts.
nm_findings_ask_user() {
  nm_toon_table findings | awk '
    function cells(line, out,    n, i, c, q, esc, cur) {
      n = 0; cur = ""; q = 0; esc = 0
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (esc) { cur = cur c; esc = 0; continue }
        if (q && c == "\\") { cur = cur c; esc = 1; continue }
        if (c == "\"") { q = !q; cur = cur c; continue }
        if (c == "," && !q) { out[++n] = cur; cur = ""; continue }
        cur = cur c
      }
      out[++n] = cur
      return n
    }
    function clean(v) {
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (v ~ /^".*"$/) v = substr(v, 2, length(v) - 2)
      return v
    }
    NR == 1 {
      n = split($0, hdr, ",")
      for (i = 1; i <= n; i++) if (clean(hdr[i]) == "action") col = i
      if (!col) exit 1
      next
    }
    { cells($0, row); if (clean(row[col]) == "ask-user") { found = 1; exit } }
    END { exit found ? 0 : 1 }
  '
}

# jq definitions that turn nm_toon_table output into objects keyed by the
# header's own column names, unquoting each TOON cell.
# shellcheck disable=SC2016  # jq program text, not shell expansion.
PIPELINE_JQ_DEFS='
def cells:
  reduce (explode[]) as $c ({cur: [], out: [], q: false, esc: false};
    if .esc then .cur += [$c] | .esc = false
    elif .q and $c == 92 then .cur += [$c] | .esc = true
    elif $c == 34 then .cur += [$c] | .q = (.q | not)
    elif $c == 44 and (.q | not) then .out += [.cur | implode] | .cur = []
    else .cur += [$c] end)
  | .out + [.cur | implode]
  | map(gsub("^[[:space:]]+|[[:space:]]+$"; "")
        | if test("^\".*\"$") then (try fromjson catch .[1:-1]) else . end);
def table:
  if . == "" then null
  else split("\n") as $lines
    | ($lines[0] | split(",") | map(gsub("^[[:space:]]+|[[:space:]]+$"; ""))) as $cols
    | [$lines[1:][] | select(length > 0) | cells as $v
       | reduce range(0; $cols | length) as $i ({}; .[$cols[$i]] = ($v[$i] // ""))]
  end;
def nullish: if . == "" then null else . end;
def num: if test("^[0-9]+$") then tonumber else nullish end;
'

# The ci field reads only the ci step itself: its steps[] row (or a run whose
# top-level status is ci), and the ci log when this read already fetched it.
# A fix round on another step never reads as ci.
pipeline_ci() {
  [ -n "$P_CI" ] && { printf '%s' "$P_CI"; return; }
  [ "$HAVE_RUN" = 1 ] && [ "$RUN_SOURCE" = full ] || return 0
  local step
  step=$(nm_ci_step_status)
  [ -z "$step" ] && [ "$RUN_STATUS" = ci ] && step=running
  # Steps run in order, so a fix round while ci is the running step is ci's.
  [ "$step" = running ] && [ "$RUN_STATUS" = fixing ] && step=fixing
  if [ "$CI_LOG_READ" = 1 ]; then
    case "$CI_LOG_STATE:$CI_LOG_MARK" in
      green:*) printf 'green' ;;
      not-ready:rearmed|not-ready:running) printf '%s' "$CI_LOG_MARK" ;;
      not-ready:*) if [ "$step" = fixing ]; then printf 'fixing'; else printf 'not-ready'; fi ;;
      *) printf 'unknown' ;;
    esac
    return
  fi
  printf '%s' "$step"
}

pipeline_json() {
  [ "$P_META" = 1 ] || { printf 'null'; return; }
  local full=0 steps='' active='' findings='' findings_scalar='' daemon=$P_DAEMON
  local run_id='' run_head='' run_status='' run_outcome='' has_run=false
  if [ "$HAVE_RUN" = 1 ]; then
    has_run=true
    if [ "$RUN_SOURCE" = full ]; then
      full=1
      steps=$(nm_toon_table steps)
      active=$(nm_toon_table active_steps)
      findings=$(nm_toon_table findings)
      findings_scalar=$(fm_nm_strip_quotes "$(fm_nm_field "$RUN_OUT" findings)")
      run_id=$(fm_nm_strip_quotes "$(fm_nm_field "$RUN_OUT" id)")
      run_head=$(fm_nm_strip_quotes "$(fm_nm_field "$RUN_OUT" head)")
      run_status=$(fm_nm_strip_quotes "$(fm_nm_field "$RUN_OUT" status)")
      run_outcome=$(fm_nm_strip_quotes "$(fm_nm_field "$RUN_OUT" outcome)")
      # A PR the run names before it ends: its ci step monitors it until it
      # merges or closes, so a run still on that step proves it open; any
      # other point says nothing about its state.
      if [ -z "$P_PR_URL" ] && [ -z "$P_PR_STATE" ]; then
        P_PR_URL=$(fm_nm_strip_quotes "$(fm_nm_field "$RUN_OUT" pr)")
        if [ -n "$P_PR_URL" ] && [ -z "$run_outcome" ] \
          && { [ "$run_status" = ci ] || [ -n "$(nm_ci_step_status)" ]; }; then
          P_PR_STATE=open
          P_PR_VIA=run
        fi
      fi
    else
      run_status=$COARSE_STATUS
    fi
  fi
  if [ "$LOG_VERB" = blocked ] && declare -F log_reports_daemon_socket_down >/dev/null \
    && log_reports_daemon_socket_down "$LOG_LINE"; then
    daemon=down
  fi
  jq -cn \
    --argjson applies "$P_APPLIES" --arg reason "$P_REASON" --arg read "$P_READ" \
    --argjson has_run "$has_run" --argjson full "$full" \
    --arg run_id "$run_id" --arg run_head "$run_head" \
    --arg run_status "$run_status" --arg run_outcome "$run_outcome" \
    --arg steps "$steps" --arg active "$active" \
    --arg findings "$findings" --arg findings_scalar "$findings_scalar" \
    --arg gate_step "$P_GATE_STEP" --arg gate_status "$P_GATE_STATUS" --arg parked_for "$P_PARKED_FOR" \
    --arg ci "$(pipeline_ci)" \
    --arg pr_url "$P_PR_URL" --arg pr_state "$P_PR_STATE" --arg pr_via "$P_PR_VIA" \
    --arg daemon "$daemon" \
    "$PIPELINE_JQ_DEFS"'
    ($findings | table) as $rows
    | {
        applies: $applies,
        reason: ($reason | nullish),
        read: $read,
        run: (if $has_run then
                {id: ($run_id | nullish), head: ($run_head | nullish),
                 status: ($run_status | nullish), outcome: ($run_outcome | nullish)}
              else null end),
        steps: (if $full == 1 then
                  ($steps | table | if . == null then null else
                    map({step, status, findings: ((.findings // "") | num),
                         duration_ms: ((.duration_ms // "") | num)}) end)
                else null end),
        active: (if $full == 1 then
                   ($active | table | if . == null or length == 0 then null else .[0]
                     | {step, active_for: ((.active_for // "") | nullish),
                        last_activity: ((.last_activity // "") | nullish),
                        quiet: ((.last_activity // "") | startswith("quiet")),
                        round: ((.round // "") | nullish)} end)
                 else null end),
        gate: (if $gate_step == "" then null else
                 {step: $gate_step, status: ($gate_status | nullish), parked_for: ($parked_for | nullish)} end),
        findings: (if $full != 1 then null
                   elif $rows != null then
                     {total: ($rows | length),
                      ask_user: ([$rows[] | select(.action == "ask-user")] | length),
                      rows: $rows}
                   elif ($findings_scalar | test("^[0-9]+")) then
                     {total: ($findings_scalar | capture("^(?<n>[0-9]+)").n | tonumber), ask_user: null, rows: []}
                   elif $findings_scalar == "none" then {total: 0, ask_user: 0, rows: []}
                   else null end),
        ci: ($ci | nullish),
        pr: (if $pr_url == "" and $pr_state == "" then null else
               {url: ($pr_url | nullish), state: (if $pr_state == "" then "unknown" else $pr_state end),
                via: ($pr_via | nullish)} end),
        daemon: $daemon
      }'
}

# --- meta resolution --------------------------------------------------------

[ -f "$META" ] || emit unknown none "no metadata for $ID"

meta_value() {  # <key>
  grep "^$1=" "$META" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

WT=$(meta_value worktree)
KIND=$(meta_value kind)
HARNESS=$(meta_value harness)
REMOTE_HOST=$(meta_value remote_host)
[ -n "$KIND" ] || KIND=ship
P_META=1
# Only a ship task validating through no-mistakes ever has a run to read; the
# rest say how they ship instead. A ship row with no recorded mode predates
# modes, and the run lookup below reads runs for it as for no-mistakes.
case "$KIND:$(meta_value mode)" in
  ship:direct-PR) P_REASON=direct-PR ;;
  ship:local-only) P_REASON=local-only ;;
  ship:*) P_APPLIES=true; P_READ=not_asked ;;
  secondmate:*) P_REASON=secondmate ;;
  *) P_REASON=scout ;;
esac

# A torn-down (or never-created) worktree has no current state to read. A
# remote secondmate's recorded worktree is a path on ITS host, so the local
# probe proves nothing for it - the remote arm below reads the true source.
if [ -z "$REMOTE_HOST" ] && { [ -z "$WT" ] || [ ! -d "$WT" ]; }; then
  emit unknown none "worktree gone (torn down?)"
fi

# --- status log ------------------------------------------------------------

# Last non-empty status line; fm-classify-lib.sh owns leading-verb normalization.
log_last_line() {
  [ -f "$LOG" ] || return 1
  grep -v '^[[:space:]]*$' "$LOG" 2>/dev/null | tail -1
}
# Map a status-log verb onto a canonical state for the fallback path. `paused` is
# the deliberate-external-wait verb (fm-classify-lib.sh's FM_CLASSIFY_PAUSED_VERB):
# a crew with no active run and an idle pane that declared a known external wait
# reports `paused` distinctly, so a supervisor reading this sees a declared pause
# and its reason rather than a wedge-suspect idle.
map_log_state() {  # <line>
  if status_is_paused "$1"; then
    echo paused
    return
  fi
  case "$(status_line_verb "$1")" in
    working)        echo working ;;
    needs-decision) echo parked ;;
    blocked)        echo blocked ;;
    done)           echo "done" ;;
    failed)         echo failed ;;
    *)              echo unknown ;;
  esac
}

LOG_LINE=$(log_last_line || true)
LOG_VERB=$(status_line_verb "$LOG_LINE")

# --- remote secondmate: the true source is the remote endpoint ---------------
# A remote mate's recorded worktree and backend target live on its own host, so
# the local worktree probe above and the local pane reads below would misreport
# a healthy remote mate as gone or dead. Ask the remote host for the endpoint's
# recovery-grade state over the same fm-on.sh transport fm-send uses, then read
# current activity from the routed status log exactly as for a local
# secondmate (an idle endpoint is healthy for a secondmate either way). An
# unreachable host or unreadable endpoint is reported as unknown-remote -
# explicitly NOT proof of death - so a transport blip never reads as a torn
# down or dead mate; only the remote host's own dead/missing verdict may say
# the endpoint is actually gone.
if [ -n "$REMOTE_HOST" ]; then
  if ! REMOTE_STATE=$(FM_HOME="$FM_HOME" "$SCRIPT_DIR/fm-on.sh" "$ID" \
    fm-remote-secondmate-control.sh state "$ID" < /dev/null 2>/dev/null); then
    REMOTE_STATE=
  fi
  REMOTE_STATE=$(printf '%s\n' "$REMOTE_STATE" | tail -1)
  case "$REMOTE_STATE" in
    alive)
      if [ -n "$LOG_VERB" ]; then
        LOG_STATE=$(map_log_state "$LOG_LINE")
        if [ "$LOG_STATE" != unknown ]; then
          emit "$LOG_STATE" status-log "$(status_line_note "$LOG_LINE")${SEP}remote endpoint alive on $REMOTE_HOST"
        fi
      fi
      emit unknown remote-endpoint "alive on $REMOTE_HOST (an idle secondmate is healthy)"
      ;;
    dead|missing)
      emit unknown remote-endpoint "remote endpoint $REMOTE_STATE on $REMOTE_HOST"
      ;;
    '')
      emit unknown remote-endpoint "unknown-remote: $REMOTE_HOST unreachable or endpoint unreadable (not proof of death)"
      ;;
    *)
      emit unknown remote-endpoint "unknown-remote: endpoint state '$REMOTE_STATE' on $REMOTE_HOST (not proof of death)"
      ;;
  esac
fi

# pane_readable is consulted ONLY in the no-run fallback below. The run-step path
# stays authoritative regardless of pane liveness - judge by the run-step, not the
# shell - so a finished crew whose endpoint has closed still reports its run-step
# state (e.g. done) instead of being masked as unknown. Backend-aware
# (fm_backend_of_meta defaults absent backend= to tmux, the P1 contract): a
# herdr task is read through fm_backend_capture instead of a bare tmux probe.
TASK_BACKEND=$(fm_backend_of_meta "$META")
BACKEND_TARGET=$(fm_backend_target_of_meta "$META")
EXPECTED_LABEL="fm-$ID"
pane_readable() {  # <target>
  case "$TASK_BACKEND" in
    tmux) tmux display-message -p -t "$1" '#{pane_id}' >/dev/null 2>&1 ;;
    *) fm_backend_capture "$TASK_BACKEND" "$1" 1 "$EXPECTED_LABEL" >/dev/null 2>&1 ;;
  esac
}
# crew_busy_verdict: the crew's semantic busy state from the one contract
# owner (bin/fm-busy-lib.sh), as "<busy|idle|unknown> <source>". A converted
# adapter answers from its own lifecycle record; Grok answers from its
# isolated rendered-tail fallback; a herdr crew's native `busy` is accepted
# when no record exists, but its native `idle` is NOT, because agent.get
# reports generation state (idle while a crew blocks on its own long-running
# foreground tool call) rather than turn state.
crew_busy_verdict() {  # <target>
  local tail40=''
  case "$HARNESS" in
    grok*) tail40=$(fm_backend_capture "$TASK_BACKEND" "$1" 40 "$EXPECTED_LABEL" 2>/dev/null) || tail40='' ;;
  esac
  fm_busy_classify "$TASK_BACKEND" "$1" "$HARNESS" "$ID" "$STATE" "$tail40"
}

# --- no-mistakes run lookup (authoritative when a run matches this branch) --
# trim, strip_quotes, the bounded nm_run call, nm_field's TOON parse, and the
# attribution helpers below are thin wrappers over the ONE owner in
# bin/fm-nm-run-lib.sh, shared with fm-teardown.sh's pre-teardown run abort.

trim() { fm_nm_trim "$@"; }
strip_quotes() { fm_nm_strip_quotes "$@"; }
nm_run() {  # <args...>
  fm_nm_run "$WT" "$NM_TIMEOUT" "$@"
}

# Scalar value of a TOON key in the captured run output ($RUN_OUT).
RUN_OUT=""
nm_field() {  # <key>
  fm_nm_field "$RUN_OUT" "$1"
}

pr_read_record_bounded() {  # <owner> <repo> <number>
  local record state merged
  # shellcheck disable=SC2016  # The inner script expands after bash -c receives positional args.
  if ! record=$(fm_run_timed 5 bash -c '
    . "$1"
    fm_pr_github_read_record "$2" "$3" "$4" || exit 1
    printf "state=%s\nmerged=%s\n" "$FM_PR_RECORD_STATE" "$FM_PR_RECORD_MERGED"
  ' _ "$SCRIPT_DIR/fm-pr-lib.sh" "$1" "$2" "$3" 2>/dev/null); then
    return 1
  fi
  state=$(printf '%s\n' "$record" | sed -n 's/^state=//p' | head -1)
  merged=$(printf '%s\n' "$record" | sed -n 's/^merged=//p' | head -1)
  [ -n "$state" ] || return 1
  [ "$merged" = true ] || [ "$merged" = false ] || return 1
  FM_PR_RECORD_STATE=$state
  FM_PR_RECORD_MERGED=$merged
}

mr_read_record_bounded() {  # <host> <path> <number>
  local record state merged
  # shellcheck disable=SC2016  # The inner script expands after bash -c receives positional args.
  if ! record=$(fm_run_timed 5 bash -c '
    . "$1"
    fm_pr_gitlab_read_record "$2" "$3" "$4" || exit 1
    printf "state=%s\nmerged=%s\n" "$FM_PR_RECORD_STATE" "$FM_PR_RECORD_MERGED"
  ' _ "$SCRIPT_DIR/fm-pr-lib.sh" "$1" "$2" "$3" 2>/dev/null); then
    return 1
  fi
  state=$(printf '%s\n' "$record" | sed -n 's/^state=//p' | head -1)
  merged=$(printf '%s\n' "$record" | sed -n 's/^merged=//p' | head -1)
  [ -n "$state" ] || return 1
  [ "$merged" = true ] || [ "$merged" = false ] || return 1
  FM_PR_RECORD_STATE=$state
  FM_PR_RECORD_MERGED=$merged
}

# Read a terminal passed run's PR state. Sets PASSED_PR_DETAIL to the line's
# detail and P_PR_URL, P_PR_STATE and P_PR_VIA to the same answer for --json.
passed_pr_answer() {  # <state> <via> <detail>
  P_PR_STATE=$1
  P_PR_VIA=$2
  PASSED_PR_DETAIL=$3
}
passed_pr_read() {
  local provider url host path number owner repo raw_pr state_lc
  raw_pr=$(strip_quotes "$(nm_field pr)")
  if fm_pr_url_parse "$raw_pr"; then
    provider=$FM_PR_PROVIDER
    url=$FM_PR_URL
    host=$FM_PR_HOST
    path=$FM_PR_PATH
    number=$FM_PR_NUMBER
  elif fm_pr_metadata_identity_parse "$META"; then
    provider=$FM_PR_META_PROVIDER
    url=$FM_PR_META_URL
    host=$FM_PR_META_HOST
    path=$FM_PR_META_PATH
    number=$FM_PR_META_NUMBER
  else
    passed_pr_answer unknown '' 'run passed: PR state unknown (no PR identity)'
    return
  fi
  P_PR_URL=$url
  if fm_pr_poll_retirement_receipt_valid "$STATE" "$ID" \
    && [ "$FM_PR_RETIRE_PROVIDER" = "$provider" ] \
    && [ "$FM_PR_RETIRE_URL" = "$url" ] \
    && [ "$FM_PR_RETIRE_HOST" = "$host" ] \
    && [ "$FM_PR_RETIRE_PATH" = "$path" ] \
    && [ "$FM_PR_RETIRE_NUMBER" = "$number" ]; then
    passed_pr_answer merged receipt 'run passed: PR merged'
    return
  fi
  if [ "${FM_CREW_STATE_NO_FORGE:-0}" = 1 ]; then
    passed_pr_answer unknown skipped 'run passed: PR state unknown (forge read skipped)'
    return
  fi

  case "$provider" in
    github)
      owner=${path%%/*}
      repo=${path#*/}
      if ! pr_read_record_bounded "$owner" "$repo" "$number"; then
        passed_pr_answer unknown unreadable 'run passed: PR state unknown (unreadable)'
        return
      fi
      if [ "$FM_PR_RECORD_MERGED" = true ]; then
        passed_pr_answer merged forge 'run passed: PR merged'
        return
      fi
      state_lc=$(printf '%s' "$FM_PR_RECORD_STATE" | tr '[:upper:]' '[:lower:]')
      case "$state_lc" in
        open)   passed_pr_answer open forge 'run passed: PR open' ;;
        closed) passed_pr_answer closed forge 'run passed: PR closed' ;;
        *)      passed_pr_answer unknown forge "run passed: PR state $state_lc" ;;
      esac
      ;;
    gitlab)
      if ! mr_read_record_bounded "$host" "$path" "$number"; then
        passed_pr_answer unknown unreadable 'run passed: PR state unknown (unreadable)'
        return
      fi
      if [ "$FM_PR_RECORD_MERGED" = true ]; then
        passed_pr_answer merged forge 'run passed: PR merged'
        return
      fi
      state_lc=$(printf '%s' "$FM_PR_RECORD_STATE" | tr '[:upper:]' '[:lower:]')
      case "$state_lc" in
        open|opened) passed_pr_answer open forge 'run passed: PR open' ;;
        closed)      passed_pr_answer closed forge 'run passed: PR closed' ;;
        *)           passed_pr_answer unknown forge "run passed: PR state $state_lc" ;;
      esac
      ;;
    *)
      passed_pr_answer unknown unreadable "run passed: PR state unknown (unreadable: $url)"
      ;;
  esac
}
# Finding count from a findings[N]{...} table header; empty when none.
nm_findings_count() {
  printf '%s\n' "$RUN_OUT" | grep -oE 'findings\[[0-9]+\]' | head -1 | grep -oE '[0-9]+'
}
nm_gate_step_row() {
  local row step rest status findings
  row=$(printf '%s\n' "$RUN_OUT" | grep -E '^[[:space:]]*[^,]+,[[:space:]]*"?(awaiting_approval|fix_review)"?[[:space:]]*,' | head -1)
  [ -n "$row" ] || return 0
  row=$(trim "$row")
  step=$(trim "${row%%,*}")
  rest=${row#*,}
  status=$(strip_quotes "$(trim "${rest%%,*}")")
  rest=${rest#*,}
  findings=$(trim "${rest%%,*}")
  printf '%s|%s|%s' "$step" "$status" "$findings"
}
nm_gate_status() {
  local s row
  s=$(printf '%s\n' "$RUN_OUT" | grep -E '^[[:space:]]*(status|state):[[:space:]]*"?(awaiting_approval|fix_review)"?[[:space:]]*$' | head -1)
  if [ -n "$s" ]; then
    s=$(strip_quotes "$(trim "${s#*:}")")
    printf '%s' "$s"
    return
  fi
  row=$(nm_gate_step_row)
  [ -n "$row" ] && { row=${row#*|}; printf '%s' "${row%%|*}"; }
}
nm_has_gate() {
  printf '%s\n' "$RUN_OUT" | grep -Eq '^[[:space:]]*gate:[[:space:]]*'
}
nm_gate_line_name() {
  local gate step
  gate=$(strip_quotes "$(nm_field gate)")
  [ -n "$gate" ] && { printf '%s' "$gate"; return; }
  step=$(printf '%s\n' "$RUN_OUT" | sed -n '/^[[:space:]]*gate:[[:space:]]*$/,/^[^[:space:]][^:]*:/s/^[[:space:]]*step:[[:space:]]*\(.*\)/\1/p' | head -1)
  step=$(strip_quotes "$step")
  [ -n "$step" ] && printf '%s' "$step"
}
nm_gate_name() {
  local gate row
  gate=$(nm_gate_line_name)
  [ -n "$gate" ] && { printf '%s' "$gate"; return; }
  row=$(nm_gate_step_row)
  [ -n "$row" ] && printf '%s' "${row%%|*}"
}
nm_gate_findings_count() {
  local f row rest
  f=$(nm_findings_count)
  [ -n "$f" ] && { printf '%s' "$f"; return; }
  row=$(nm_gate_step_row)
  [ -n "$row" ] || return 0
  rest=${row#*|}
  rest=${rest#*|}
  rest=${rest%%|*}
  case "$rest" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s' "$rest"
}
log_reports_ci_ready() {
  [ "$LOG_VERB" = "done" ] || return 1
  case "$(status_line_note "$LOG_LINE")" in
    *PR*"checks green"*|*"checks green"*PR*) return 0 ;;
    *) return 1 ;;
  esac
}

# 0 when a status-log line reports positive daemon socket failure rather than a
# client-side timeout or generic unreachability.
log_reports_daemon_socket_down() {  # <line>
  local line
  line=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$line" in
    *daemon*|*no-mistakes*) ;;
    *) return 1 ;;
  esac
  case "$line" in
    *"connection refused"*|*"connections refused"*|*"socket refused connection"*|*"socket refuses connection"*|*"socket refusing connection"*|*"socket missing"*|*"socket is missing"*|*"missing socket"*) return 0 ;;
  esac
  return 1
}

# 0 when a status-log line blames the pipeline's transport rather than the work.
# None of these claims alone is evidence the daemon died: a drive call is only
# waiting for a read while the fix round runs in the background.
log_claims_pipeline_unreachable() {  # <line>
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *daemon*|*timeout*|*"timed out"*|*unreachab*) return 0 ;;
  esac
  return 1
}

# Rows of the `active_steps[N]{...}:` table in the captured run output
# ($RUN_OUT), which the pipeline emits only while a step is actually running or
# fixing. Column order is deliberately not assumed: the header's own indentation
# bounds the block, and callers below read the table as text.
nm_active_steps_rows() {
  printf '%s\n' "$RUN_OUT" | awk '
    /^[[:space:]]*active_steps\[[0-9]+\]\{/ { hdr = index($0, "active_steps"); inblock = 1; next }
    inblock {
      if ($0 ~ /^[[:space:]]*$/) { inblock = 0; next }
      match($0, /[^ \t]/)
      if (RSTART <= hdr) { inblock = 0; next }
      print
    }
  '
}

# Rows of the `steps[N]{step,status,findings,duration_ms}:` table in the
# captured run output ($RUN_OUT) - the full per-step ledger, present on
# terminal runs too, unlike active_steps[] which the pipeline emits only while
# a step is actually running or fixing. Column order is deliberately not
# assumed: the header's own indentation bounds the block, and callers below
# read the table as text.
nm_steps_rows() {
  printf '%s\n' "$RUN_OUT" | awk '
    /^[[:space:]]*steps\[[0-9]+\]\{/ { hdr = index($0, "steps"); inblock = 1; next }
    inblock {
      if ($0 ~ /^[[:space:]]*$/) { inblock = 0; next }
      match($0, /[^ \t]/)
      if (RSTART <= hdr) { inblock = 0; next }
      print
    }
  '
}

# 0 when the pipeline itself reports RECENT activity on an actively running or
# fixing step. The client prefixes a step's `last_activity` with `quiet` once no
# step log or native-agent lifecycle event has arrived for longer than its
# configured quiet warning, so its own recency verdict is the signal here rather
# than a second threshold invented in firstmate. Positive evidence is required:
# an absent table is not recency, so a run record that merely still says
# `running` while nothing executes it never reads as alive.
nm_run_activity_is_recent() {
  local rows
  rows=$(nm_active_steps_rows)
  [ -n "$rows" ] || return 1
  ! printf '%s\n' "$rows" | grep -q 'quiet'
}

# 0 when a terminal FAILED run's only failure is the ci monitor step and the
# ci log's last recognized marker reads checks green. Requires the exact
# shape, all on positive evidence: a steps[] table where every step completed
# except exactly `ci` failed (any other non-completed status, or a second
# failed step, disqualifies), plus nm_ci_checks_read's green (a genuinely red
# check, or an unreadable ci log, keeps the failure a failure). This is the
# orphaned-CI-monitor gap (2026-09-05 jr-voice): a run held for a captain
# merge decision polls until the shared daemon restarts under it and marks
# the run failed, although GitHub's own check state - the actual shippability
# authority - is green and every substantive step completed.
nm_failed_run_is_green_held_ci() {
  local rows row rest step status saw_ci_failed
  rows=$(nm_steps_rows)
  [ -n "$rows" ] || return 1
  saw_ci_failed=0
  while IFS= read -r row; do
    row=$(trim "$row")
    step=$(trim "${row%%,*}")
    rest=${row#*,}
    status=$(strip_quotes "$(trim "${rest%%,*}")")
    case "$status" in
      completed) continue ;;
      failed)
        [ "$step" = ci ] || return 1
        saw_ci_failed=1
        continue
        ;;
      *) return 1 ;;
    esac
  done <<EOF
$rows
EOF
  [ "$saw_ci_failed" = 1 ] || return 1
  nm_ci_checks_read
  [ "$CI_LOG_STATE" = green ]
}

# Reclassify a terminal failed run as done (held-for-merge) when
# nm_failed_run_is_green_held_ci matches, surfacing the run's PR URL so the
# supervisor reads the concrete review-ready outcome instead of a failure.
nm_reclassify_failed_run_as_held_green() {
  nm_failed_run_is_green_held_ci || return 1
  RUN_STATE="done"
  RUN_DETAIL="checks green: PR held for merge (ci monitor ended)"
  local pr_url
  pr_url=$(strip_quotes "$(nm_field pr)")
  [ -n "$pr_url" ] && RUN_DETAIL="$RUN_DETAIL: $pr_url"
  return 0
}

# 0 when an explicit probe proves the shared daemon down: `no-mistakes daemon
# status` is the canonical down-probe (the same one fm-brief.sh hands crews
# before a blocked append) and exits non-zero when the daemon is not running.
# Bounded like every other CLI call; a probe that fails for any reason -
# refused socket, timeout, non-zero answer - means the daemon is not provably
# up, which is the only fact the coarse fallback needs.
nm_daemon_probe_down() {
  fm_nm_run_checked "$WT" "$NM_TIMEOUT" daemon status >/dev/null || return 0
  return 1
}

nm_ci_step_status() {
  local row rest
  row=$(printf '%s\n' "$RUN_OUT" | grep -E '^[[:space:]]*ci,[[:space:]]*"?(running|fixing)"?[[:space:]]*,' | head -1)
  [ -n "$row" ] || return 0
  row=$(trim "$row")
  rest=${row#*,}
  strip_quotes "$(trim "${rest%%,*}")"
}

nm_effective_ci_step_status() {
  local step_status
  if [ "${RUN_STATUS:-}" = fixing ]; then
    printf 'fixing'
    return 0
  fi
  step_status=$(nm_ci_step_status)
  if [ -n "$step_status" ]; then
    printf '%s' "$step_status"
    return 0
  fi
  if [ "${RUN_STATUS:-}" = ci ]; then
    printf 'running'
  fi
}

# Root cause of the PR #252 incident (2026-07): for a repo where merge is left
# to the captain, no-mistakes' ci step (and therefore top-level status/outcome)
# stays "running" for the ENTIRE CI-monitor phase, including long after GitHub
# reports every check green - it only reaches outcome=passed once the PR is
# actually merged (or failed/cancelled if closed). `axi status`'s steps[] table
# never distinguishes "still waiting on checks" from "checks green, waiting on
# merge": both read as plain `ci,running,...`. The only place that transition is
# recorded is the ci step's own log text, e.g. "all CI checks passed - still
# monitoring until merged or closed" or "no CI checks reported - still
# monitoring until merged or closed" (verified against 360+ real run logs under
# ~/.no-mistakes/logs/*/ci.log on the installed v1.32.2 binary, including the
# actual PR #252 run). Reads the ci step's log tail via `axi logs` and scans it
# for the MOST RECENT recognized marker (the log is append-only/chronological,
# so the last match is current): green with nothing red after it means CI is
# green right now, still only waiting on merge/close.
#
# Sets CI_LOG_STATE to green, not-ready or unknown, and CI_LOG_MARK to which
# kind of marker decided it, for --json only: "rearmed" when the last marker is
# the base-advance re-arm (which still reads not-ready: a green PR whose base
# moved is held to working on purpose), "running" when checks are running or
# not yet registered, else empty. Callers read the variables rather than a
# command substitution so the mark survives without a second log read.
nm_ci_checks_read() {
  local run_id log_tail marker
  CI_LOG_STATE=unknown
  CI_LOG_MARK=
  CI_LOG_READ=1
  run_id=$(strip_quotes "$(nm_field id)")
  [ -n "$run_id" ] || return 0
  log_tail=$(nm_run axi logs --step ci --run "$run_id") || true
  [ -n "$log_tail" ] || return 0
  marker=$(printf '%s\n' "$log_tail" \
    | grep -E 'CI checks passed|no CI checks reported - still monitoring|no CI checks reported yet|checks failed|issues detected|CI checks running|base branch advanced.*re-arming CI monitor timeout' \
    | tail -1)
  case "$marker" in
    *"checks passed"*|*"no CI checks reported - still monitoring"*) CI_LOG_STATE=green ;;
    *"base branch advanced"*"re-arming CI monitor timeout"*) CI_LOG_STATE=not-ready; CI_LOG_MARK=rearmed ;;
    *"no CI checks reported yet"*|*"CI checks running"*) CI_LOG_STATE=not-ready; CI_LOG_MARK=running ;;
    *"checks failed"*|*"issues detected"*) CI_LOG_STATE=not-ready ;;
  esac
}
# Coarse fallback when the bare `axi status` answer is not this branch's own
# matching run: either it names another branch (routine once several crews
# validate the same underlying repo concurrently - a worktree with its own
# active run reliably gets that run answered, even under concurrent load), or
# it names this branch's run but the strict head rule rejected it. The real
# run-listing command is the top-level `no-mistakes runs` (the `axi` surface
# has no runs-listing subcommand; tests/fm-crew-state.test.sh owns the
# 2026-07-02 dead-code incident history this fallback replaced).
# fm_nm_runs_status_for_worktree in bin/fm-nm-run-lib.sh is the ONE owner of
# the ledger format, the newest-row-decides rule, its live-over-terminal
# exception, and the anchored pipeline-continuation recognition
# (model-routing-benchmark-hardening: an active fix round whose head object the
# task copy never fetched used to be rejected here, letting the older failed row
# answer as current), so both attribution routes share one rule.
# The same reader is also consulted when `axi status` DID bind this branch's run
# but that run is terminal, to find a live sibling run for this worktree.
nm_runs_list() {
  nm_run runs --limit "$FM_CREW_STATE_RUNS_LIMIT"
}

# CREW_BRANCH is empty at detached HEAD (a just-spawned crew, or a scout's
# scratch worktree); with no branch there is no run to attribute to this crew.
CREW_BRANCH=$(git -C "$WT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)

# 0 if the active axi-status run's head field matches this worktree's code
# identity. Branch match is a precondition (caller). Rule owned by
# fm_nm_head_matches_worktree in bin/fm-nm-run-lib.sh.
nm_run_head_matches_worktree() {
  local run_head
  run_head=$(strip_quotes "$(nm_field head)")
  fm_nm_head_matches_worktree "$WT" "$run_head"
}

HAVE_RUN=0
# RUN_SOURCE distinguishes the two ways HAVE_RUN=1 can happen: "full" means
# $RUN_OUT is real `axi status` TOON with step/gate detail (including a
# same-branch run the strict head rule rejected but the ledger proved is this
# worktree's pipeline-owned continuation); "coarse" means only a bare status
# word came back from the runs-list fallback, so the run-step block below skips
# the TOON field parsing entirely for this crew.
RUN_SOURCE=full
COARSE_STATUS=""
# Scouts and secondmates never drive a no-mistakes validation of their own
# worktree, so skip the lookup for them and read state from pane/log directly.
# P_READ records what the lookup found for --json: no branch means no run can
# be this crew's (none), and an `axi status` that came back empty means the
# CLI did not answer (unanswered), which is not the same as no run.
[ "$KIND" = ship ] && [ -z "$CREW_BRANCH" ] && P_READ=none
if [ "$KIND" = ship ] && [ -n "$CREW_BRANCH" ] && command -v no-mistakes >/dev/null 2>&1; then
  RUN_OUT=$(nm_run axi status)
  P_READ=unanswered
  if [ -n "$RUN_OUT" ]; then
    P_READ=none
    run_branch=$(strip_quotes "$(nm_field branch)")
    # Head equality, or the pipeline-owned-active exemption: while the
    # pipeline owns this branch, the daemon's own branch attribution is
    # authoritative and the lane head need not be a git object here
    # (fm_nm_run_is_pipeline_owned_active in bin/fm-nm-run-lib.sh).
    if [ -n "$run_branch" ] && [ "$run_branch" = "$CREW_BRANCH" ] \
      && { nm_run_head_matches_worktree || fm_nm_run_is_pipeline_owned_active "$RUN_OUT"; }; then
      HAVE_RUN=1
      # Live-over-terminal (bin/fm-nm-run-lib.sh). Bare `axi status` answers
      # with the most-recently-touched run, which after a pipeline crash is the
      # dead run sitting at this worktree's exact commit while the live run
      # that replaced it validates a descendant commit on the same branch. Both
      # bind, so a terminal answer is provisional until the ledger has been
      # asked whether this worktree also has a live run. Only a live word
      # displaces it: a terminal run with no live sibling keeps its full
      # `axi status` step and gate detail rather than degrading to the ledger.
      if ! fm_nm_run_is_active "$RUN_OUT"; then
        live_status=$(fm_nm_runs_status_for_worktree "$WT" "$CREW_BRANCH" "$(nm_runs_list)")
        if [ "$(fm_nm_run_status_class "$live_status")" = live ]; then
          COARSE_STATUS=$live_status
          RUN_SOURCE=coarse
        fi
      fi
    else
      # The active-or-most-recent run is for another branch, or it names this
      # branch with a head this copy cannot verify (a pipeline-advanced fix
      # round, or a rewritten tip). Deliberately nested inside
      # `[ -n "$RUN_OUT" ]`: an empty/timed-out primary call means the CLI
      # itself did not respond, so retrying it immediately with a second
      # bounded call would just double the wait for no better answer.
      COARSE_STATUS=$(fm_nm_runs_status_for_worktree "$WT" "$CREW_BRANCH" "$(nm_runs_list)")
      if [ -n "$COARSE_STATUS" ]; then
        HAVE_RUN=1
        # A branch-matching answer the strict rule rejected is this branch's
        # own current run once the ledger proves the pipeline-owned
        # continuation, so its axi TOON is the authoritative run detail
        # (RUN_SOURCE stays full); only a foreign-branch answer leaves
        # coarse status-word detail.
        [ "$run_branch" = "$CREW_BRANCH" ] || RUN_SOURCE=coarse
      fi
    fi
  fi
fi

# --- run-step authoritative path -------------------------------------------

if [ "$HAVE_RUN" = 1 ]; then
  RUN_STATE=working
  RUN_DETAIL=""
  CI_STEP_STATUS=""
  CI_LOG_STATE=""
  RUN_STATUS=""
  P_READ=$RUN_SOURCE
  if [ "$RUN_SOURCE" = coarse ]; then
    # No step/gate detail is available from the plain runs list - only ever
    # true/working, done, or failed. A crew genuinely parked at a gate still
    # gets full detail once `axi status` reports its own branch again (e.g.
    # once its own step is the most-recently-touched one), and its own
    # needs-decision/blocked status-log append (a captain-relevant VERB) is
    # surfaced by each supervisor's span classification (fm-classify-lib.sh's
    # status_span_first_actionable) regardless of this coarse-vs-full
    # distinction, so a real gate is never silently missed.
    case "$COARSE_STATUS" in
      running)   RUN_STATE=working; RUN_DETAIL="validating (background run)" ;;
      completed) RUN_STATE="done";  RUN_DETAIL="run completed" ;;
      failed)
        # The ledger row is terminal but the coarse path has no steps table
        # and no ci log, so the orphaned-monitor shape cannot be recognized
        # here. With the daemon provably down, the row is unverified evidence
        # from a dead instrument and must not read as work failure.
        P_DAEMON=up
        if nm_daemon_probe_down; then
          P_DAEMON=down
          RUN_STATE=unknown
          RUN_DETAIL="no-mistakes daemon unreachable; last ledger record failed - unverified"
        else
          RUN_STATE=failed; RUN_DETAIL="run failed"
        fi ;;
      cancelled) RUN_STATE=failed;  RUN_DETAIL="run cancelled" ;;
      *)         RUN_STATE=unknown; RUN_DETAIL="runs list status: $COARSE_STATUS" ;;
    esac
  else
    status=$(strip_quotes "$(nm_field status)")
    RUN_STATUS=$status
    outcome=$(strip_quotes "$(nm_field outcome)")
    awaiting=$(printf '%s\n' "$RUN_OUT" | grep -E '^[[:space:]]*awaiting_agent:' | head -1 || true)
    gate_status=$(nm_gate_status)
    has_gate=0
    nm_has_gate && has_gate=1

    if [ -n "$outcome" ]; then
      case "$outcome" in
        passed)        RUN_STATE="done"; passed_pr_read; RUN_DETAIL=$PASSED_PR_DETAIL; P_CI=green ;;
        checks-passed) RUN_STATE="done"; RUN_DETAIL="checks green: PR ready for review"; P_CI=green ;;
        failed)
          if nm_reclassify_failed_run_as_held_green; then :; else
            RUN_STATE=failed; RUN_DETAIL="run failed"
          fi ;;
        cancelled)     RUN_STATE=failed; RUN_DETAIL="run cancelled" ;;
        *)             RUN_STATE=unknown; RUN_DETAIL="outcome: $outcome" ;;
      esac
    elif [ -n "$awaiting" ] || [ "$status" = awaiting_approval ] || [ "$status" = fix_review ] || [ -n "$gate_status" ] || [ "$has_gate" = 1 ]; then
      if [ "$has_gate" = 1 ]; then
        gate=$(nm_gate_line_name)
      else
        gate=$(nm_gate_name)
      fi
      [ -n "$gate" ] || gate=$status
      [ -n "$gate" ] || gate=gate
      RUN_STATE=parked
      RUN_DETAIL="parked at $gate"
      P_GATE_STEP=$gate
      case "$gate_status" in
        awaiting_approval|fix_review) P_GATE_STATUS=$gate_status ;;
        *) case "$status" in awaiting_approval|fix_review) P_GATE_STATUS=$status ;; esac ;;
      esac
      parked=$(strip_quotes "$(trim "${awaiting#*:}")")
      case "$parked" in parked\ *) P_PARKED_FOR=${parked#parked } ;; esac
      fcount=$(nm_gate_findings_count)
      [ -n "$fcount" ] && RUN_DETAIL="$RUN_DETAIL: $fcount finding(s)"
      if nm_findings_ask_user; then
        RUN_DETAIL="$RUN_DETAIL (ask-user: authority decision)"
      fi
    else
      case "$status" in
        ci)             RUN_STATE=working; RUN_DETAIL="ci running" ;;
        running|fixing) RUN_STATE=working; RUN_DETAIL="validating ($status)" ;;
        completed)      RUN_STATE="done"; RUN_DETAIL="run completed" ;;
        failed)
          if nm_reclassify_failed_run_as_held_green; then :; else
            RUN_STATE=failed; RUN_DETAIL="run failed"
          fi ;;
        cancelled)      RUN_STATE=failed;  RUN_DETAIL="run cancelled" ;;
        "")             RUN_STATE=working; RUN_DETAIL="run active" ;;
        *)              RUN_STATE=working; RUN_DETAIL="run active ($status)" ;;
      esac
      if [ "$RUN_STATE" = working ]; then
        CI_STEP_STATUS=$(nm_effective_ci_step_status)
        case "$CI_STEP_STATUS" in
          running)
            nm_ci_checks_read
            if [ "$CI_LOG_STATE" = green ]; then
              RUN_STATE="done"
              RUN_DETAIL="checks green: PR ready for review (still monitoring for merge/close)"
            fi
            ;;
          fixing)
            CI_LOG_STATE=not-ready
            ;;
        esac
      fi
    fi
  fi

  if [ "$RUN_STATE" = working ] && log_reports_ci_ready; then
    if [ "$RUN_SOURCE" = coarse ]; then
      emit "done" status-log "$(status_line_note "$LOG_LINE")${SEP}run still monitoring PR"
    fi
    [ -n "$CI_STEP_STATUS" ] || CI_STEP_STATUS=$(nm_effective_ci_step_status)
    if [ "$RUN_STATUS" = fixing ]; then
      CI_LOG_STATE=not-ready
    elif [ "$CI_STEP_STATUS" = running ] && [ -z "$CI_LOG_STATE" ]; then
      nm_ci_checks_read
    elif [ "$CI_STEP_STATUS" = fixing ]; then
      CI_LOG_STATE=not-ready
    fi
    if [ "$CI_LOG_STATE" != not-ready ]; then
      emit "done" status-log "$(status_line_note "$LOG_LINE")${SEP}run still monitoring PR"
    fi
  fi

  # Reconcile the status log. A needs-decision/blocked log line that the run-step
  # has moved past (anything but a genuinely parked run) is deterministically
  # stale: the gate resolved and the run resumed or finished.
  #
  # A refused or missing daemon socket is positive daemon-down evidence and
  # outranks any attributed run record, including a terminal one left behind
  # after the daemon stopped. Other blocked claims caused by a timed-out drive
  # call are contradicted only when the run reports recent
  # activity; the answer is then to steer the crew to reattach without touching
  # the shared daemon.
  case "$LOG_VERB" in
    needs-decision|blocked)
      if [ "$LOG_VERB" = blocked ] \
        && log_reports_daemon_socket_down "$LOG_LINE"; then
        emit blocked status-log "$(status_line_note "$LOG_LINE")${SEP}daemon socket down despite attributed run record"
      fi
      if [ "$RUN_STATE" != parked ]; then
        if [ "$RUN_STATE" = working ]; then
          if [ "$LOG_VERB" = blocked ] \
            && log_claims_pipeline_unreachable "$LOG_LINE" \
            && { [ "$RUN_STATUS" = running ] || [ "$RUN_STATUS" = fixing ]; } \
            && nm_run_activity_is_recent; then
            RUN_DETAIL="$RUN_DETAIL${SEP}status-log superseded: run alive, not a daemon failure (steer reattach)"
          else
            RUN_DETAIL="$RUN_DETAIL${SEP}status-log superseded by active run"
          fi
        else
          RUN_DETAIL="$RUN_DETAIL${SEP}status-log superseded (run $RUN_STATE)"
        fi
      fi
      ;;
  esac

  emit "$RUN_STATE" run-step "$RUN_DETAIL"
fi

# --- fallback: no run attributed to this crew ------------------------------
# The run-step path above already handled any crew with a run, regardless of pane
# liveness, so a finished-but-pane-closed crew never reaches here. Down here there
# is no run to consult, so only positive evidence that the target is gone may
# read as death - a backend that failed to answer is unknown, never death, for
# both classifier-backed backends (tmux and herdr) - and every death-class
# verdict reports unknown rather than trusting a possibly-stale status log as
# the current state.
[ -n "$BACKEND_TARGET" ] || emit unknown none "no backend target recorded"
if ! pane_readable "$BACKEND_TARGET"; then
  # A failed probe is not itself evidence the pane is gone: the herdr CLI can
  # error or stall under load, and tmux can fail to be executed at all (a
  # trimmed PATH) or answer non-definitively, while the pane is alive - a busy
  # box would otherwise score dozens of live claims dead. Both backends own a
  # recovery-grade classifier (fm_backend_agent_state), which separates the
  # outcomes:
  #   missing - the endpoint is authoritatively absent: herdr's pane get
  #             answered pane_not_found; tmux's successful window inventory
  #             omitted the exact recorded window, or tmux gave one of its
  #             definitive no-session/no-server/no-socket responses (which
  #             fm_backend_tmux_agent_state owns as death, since fm-bootstrap
  #             and fm-session-start depend on it to license a respawn after a
  #             genuine server death - a socket-connection failure is NOT
  #             covered by the unknown-never-death rule above).
  #   dead    - the endpoint exists but confidently has no agent (herdr's agent
  #             get answered agent_not_found, or its registration lingers over a
  #             pane whose processes are nothing but shells - issue #4115;
  #             tmux's readable foreground process group is nothing but
  #             shells), still positive death evidence.
  #   alive   - the endpoint and its agent answered and only the heavy
  #             scrollback read failed, so the live state is classified by the
  #             normal flow below instead of being discarded.
  #   anything else - the cheap probes themselves failed to answer or
  #             contradicted themselves, which is unknown, never death.
  # Backends with no classifier (orca, zellij, and cmux all report unverified)
  # keep their historical capture-failure-means-gone reading.
  case "$TASK_BACKEND" in
    tmux|herdr) AGENT_STATE=$(fm_backend_agent_state "$TASK_BACKEND" "$BACKEND_TARGET") ;;
    *) AGENT_STATE=none ;;
  esac
  case "$TASK_BACKEND:$AGENT_STATE" in
    tmux:alive|herdr:alive)
      ;;
    tmux:missing|herdr:missing)
      emit unknown none "backend target gone: $BACKEND_TARGET"
      ;;
    tmux:dead|herdr:dead)
      emit unknown none "backend target gone: $BACKEND_TARGET (agent gone, pane shell remains)"
      ;;
    tmux:*|herdr:*)
      emit unknown none "backend unreachable ($TASK_BACKEND endpoint state: $AGENT_STATE)"
      ;;
    *)
      emit unknown none "backend target gone: $BACKEND_TARGET"
      ;;
  esac
fi

# Secondmates idle on their own watcher (idle pane = healthy), so the busy
# state is not meaningful for them; read their state from the status log only.
# Only an exact busy verdict reports working here, and only an exact idle
# verdict permits the status-log fallback below. Missing, malformed, stale, or
# unverified semantic state remains unknown.
if [ "$KIND" != secondmate ]; then
  BUSY_VERDICT=$(crew_busy_verdict "$BACKEND_TARGET")
  case "${BUSY_VERDICT%% *}" in
    busy) emit working pane "harness busy (${BUSY_VERDICT#* })" ;;
    idle) ;;
    *) emit unknown pane "harness state unavailable ($BUSY_VERDICT)" ;;
  esac
fi

# Fall back to the status log's last line, but ONLY when its verb maps to a real
# run-state. A decision-closing event - resolved: (fm-classify-lib.sh's
# FM_CLASSIFY_RESOLVE_VERB), and any future decision-only sibling - is NOT a state:
# it exists solely to CLOSE a keyed decision in the durable fold, so a trailing
# resolved: must never become the current state or leak its resolution prose as the
# detail. Skipping it lets a just-resolved idle crew (typically a secondmate, which
# has no busy check above) fall through to the idle default instead of rendering
# `unknown` with the resolution note as `doing`. map_log_state is the single owner of
# the verb->state mapping (including the configurable paused verb), so reusing its
# `unknown` verdict as the "not a state" test needs no second verb list here.
if [ -n "$LOG_VERB" ]; then
  LOG_STATE=$(map_log_state "$LOG_LINE")
  if [ "$LOG_STATE" != unknown ]; then
    emit "$LOG_STATE" status-log "$(status_line_note "$LOG_LINE")"
  fi
fi

emit unknown none "no current-state source available"
