# shellcheck shell=bash
# Shared "who is this task waiting on" fold.
# Usage: . bin/fm-waiting-on-lib.sh; splice "$FM_WAITING_ON_JQ_DEFS" ahead of a
# jq program, then call `waiting_on($calls)` on a fleet-snapshot task row and
# `pipeline_live` on the same row.
#
# ONE OWNER for the holder. bin/fm-fleet-snapshot.sh folds it once per task
# into tasks[].waiting_on, so the first mate's heartbeat and the captain's
# window always name the same holder; the app renders the answer and never
# computes one. tests/fm-fleet-waiting-on.test.sh pins every rule and their
# order.
#
# Each rule reads only structured fields the snapshot already holds, never
# prose: the task's pipeline object (bin/fm-crew-state.sh --json), its
# current_state, kind, yolo, report presence and keyed open decisions, and the
# snapshot's calls[]. The first rule that matches wins:
#    1 captain     an open, captain_actionable call whose origin or about is
#                  this task
#    2 captain or first_mate
#                  CI green and a PR not merged or closed; or a direct-PR or
#                  local-only task that reported done. captain while the
#                  task's yolo is off, first_mate while it is on
#    3 first_mate  a keyed open decision: needs-decision, blocked, or an
#                  ask-user escalation
#    4 first_mate  the gate holds an ask-user finding
#    5 first_mate  the run failed or was cancelled (a failed run whose ci log
#                  reads green is held for a merge, rule 2), the PR closed
#                  unmerged, or the daemon is down
#    6 worker      parked at a gate whose findings are all the worker's
#    7 ci          the ci step is running and checks are not green
#    8 pipeline    any other step running or fixing
#    9 worker      no run, and the worker's terminal is busy
#   10 external    the worker declared paused:
#   11 none        the PR merged, or a finished scout's report is in
#   12 unknown     anything else
# The result is {who, why, rule, call}: why is a short phrase built from the
# same fields, and call names the open call rule 1 matched, else null.
#
# pipeline_live is true while the task's run is running, fixing or on its ci
# step and no gate holds it; the app pulses a refresh only while some task is.

# shellcheck disable=SC2016  # jq program text, not shell expansion.
FM_WAITING_ON_JQ_DEFS='
def wo_run_live:
  (.pipeline.run // null) as $r
  | $r != null and $r.outcome == null and (["running", "fixing", "ci"] | index($r.status)) != null;
def pipeline_live: wo_run_live and (.pipeline.gate // null) == null;
def wo_pr_label:
  (.pipeline.pr.url // .pr.url // null) as $u
  | if $u == null then "PR"
    else ($u | capture("/(pull|merge_requests)/(?<n>[0-9]+)")? | "PR #" + .n) // "PR" end;
def wo_plural($n; $word): "\($n) \($word)" + (if $n == 1 then "" else "s" end);
def wo_short: if length > 80 then .[:79] + "…" else . end;
def waiting_on($calls):
  . as $t
  | ($t.pipeline // {}) as $p
  | ($t.current_state // {}) as $cs
  | ($t.id) as $id
  | (if $t.yolo == "on" then "first_mate" else "captain" end) as $merger
  | ([($calls // [])[] | select(.state == "open" and .captain_actionable == true
                                 and (.origin == $id or .about == $id))] | first) as $call
  | (($t.hints.open_decisions // []) | first) as $decision
  | ($p.gate // null) as $gate
  | ($p.findings // null) as $findings
  | ($p.run // null) as $run
  | ([($p.steps // [])[] | select(.status == "failed" or .status == "cancelled") | .step] | first) as $broke_at
  | if $call != null then
      {who: "captain", why: "your call", rule: 1, call: $call.id}
    elif ($p.ci == "green" and $p.pr != null and $p.pr.url != null
          and ($p.pr.state == "open" or $p.pr.state == "unknown")) then
      {who: $merger, why: ("merge " + ($t | wo_pr_label)), rule: 2}
    elif ($p.applies == false and ($p.reason == "direct-PR" or $p.reason == "local-only")
          and $cs.state == "done") then
      {who: $merger,
       why: (if $p.reason == "local-only" then "land on local main" else "merge " + ($t | wo_pr_label) end),
       rule: 2}
    elif $decision != null then
      {who: "first_mate", why: ($decision.verb + ": " + ($decision.summary // "") | wo_short), rule: 3}
    elif $gate != null and (($findings.ask_user // 0) > 0) then
      {who: "first_mate", why: wo_plural($findings.ask_user; "ask-user finding"), rule: 4}
    elif $run != null and ($run.outcome == "failed" or $run.status == "failed") and $p.ci != "green" then
      {who: "first_mate", why: ("run failed" + (if $broke_at then " at " + $broke_at else "" end)), rule: 5}
    elif $run != null and ($run.outcome == "cancelled" or $run.status == "cancelled") then
      {who: "first_mate", why: ("run cancelled" + (if $broke_at then " at " + $broke_at else "" end)), rule: 5}
    elif ($p.pr.state // null) == "closed" then
      {who: "first_mate", why: "PR closed unmerged", rule: 5}
    elif $p.daemon == "down" then
      {who: "first_mate", why: "pipeline service down", rule: 5}
    elif $gate != null and $findings != null and $findings.ask_user == 0 then
      {who: "worker", why: wo_plural($findings.total; $gate.step + " finding"), rule: 6}
    elif ($t | wo_run_live) and $gate == null and $p.ci != null and $p.ci != "green" then
      {who: "ci",
       why: ({running: "checks running", rearmed: "re-checking after main moved", fixing: "fixing CI",
              "not-ready": "checks not ready", unknown: "checks not readable"}[$p.ci] // "checks not readable"),
       rule: 7}
    elif ($t | wo_run_live) and $gate == null then
      {who: "pipeline",
       why: (if $p.active != null then
               $p.active.step + (if $p.active.round then ", " + $p.active.round else "" end)
             elif $run.status == "fixing" then "fixing"
             elif $p.read == "coarse" then "validating, step not readable"
             else "validating" end),
       rule: 8}
    elif $run == null and $cs.source == "pane" and $cs.state == "working" then
      {who: "worker", why: (if $t.kind == "scout" then "investigating" else "implementing" end), rule: 9}
    elif $cs.state == "paused" then
      {who: "external", why: (($cs.detail // "") | if . == "" then "paused" else wo_short end), rule: 10}
    elif ($p.pr.state // null) == "merged" then
      {who: "none", why: "PR merged", rule: 11}
    elif $t.kind == "scout" and $cs.state == "done" and ($t.paths.report.present // false) then
      {who: "none", why: "report in", rule: 11}
    else
      {who: "unknown", why: "nothing proves a holder", rule: 12}
    end
  | {who, why, rule, call: (.call // null)};
'
