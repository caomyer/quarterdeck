#!/usr/bin/env bash
# Behavior tests for the "waiting on" fold (bin/fm-waiting-on-lib.sh) and the
# pipeline fields bin/fm-fleet-snapshot.sh carries into tasks[].
#
# The fold names who holds a task, once, in the engine, so the first mate's
# heartbeat and the captain's window always agree. Its twelve rules are taken
# in order and the first match wins. These cases pin:
#   - every rule, reached on its own;
#   - the order: for each rule, a task that also satisfies the next rule it can
#     coexist with must still answer with the earlier rule;
#   - pipeline_live, which is the only thing the app's refresh pulse reads;
#   - end to end, that a real snapshot over a fake no-mistakes carries
#     tasks[].pipeline, tasks[].waiting_on and the root pipeline_live.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=bin/fm-waiting-on-lib.sh
. "$ROOT/bin/fm-waiting-on-lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-fleet-waiting-on)
fm_git_identity fmtest fmtest@example.invalid

# A ship task validating through no-mistakes with nothing yet known: no run, no
# gate, no PR, a status-log read. Every case below patches it.
BASE_TASK='{
  "id": "t1", "kind": "ship", "yolo": "off",
  "current_state": {"state": "working", "source": "status-log", "detail": ""},
  "hints": {"open_decisions": []},
  "paths": {"report": {"present": false}},
  "pr": {"url": null},
  "pipeline": {"applies": true, "reason": null, "read": "full", "run": null, "steps": null,
               "active": null, "gate": null, "findings": null, "ci": null, "pr": null,
               "daemon": "not_probed"}
}'

# One patch per rule: the fields that make that rule match, merged deep into
# BASE_TASK with jq's `*`.
P_CALL='{}'
CALLS_OPEN='[{"id": "c-1", "title": "Pick a name", "state": "open", "captain_actionable": true, "origin": "t1", "about": null}]'
P_GREEN='{"pipeline": {"run": {"status": "running", "outcome": null}, "ci": "green",
          "pr": {"url": "https://github.com/o/r/pull/35", "state": "open", "via": "run"}}}'
P_DIRECT_DONE='{"pipeline": {"applies": false, "reason": "direct-PR", "read": "none"},
                "current_state": {"state": "done", "source": "status-log"},
                "pr": {"url": "https://github.com/o/r/pull/38"}}'
P_DECISION='{"hints": {"open_decisions": [{"key": "nm-01R-review", "verb": "needs-decision", "summary": "ask-user findings=r2"}]}}'
P_ASK_USER='{"pipeline": {"run": {"status": "awaiting_approval", "outcome": null},
             "gate": {"step": "review", "status": "awaiting_approval", "parked_for": "9m"},
             "findings": {"total": 2, "ask_user": 1, "rows": []}}}'
P_FAILED='{"pipeline": {"run": {"status": "completed", "outcome": "failed"},
           "steps": [{"step": "intent", "status": "completed"}, {"step": "test", "status": "failed"}]}}'
P_WORKER_GATE='{"pipeline": {"run": {"status": "awaiting_approval", "outcome": null},
                "gate": {"step": "review", "status": "awaiting_approval", "parked_for": "2m"},
                "findings": {"total": 3, "ask_user": 0, "rows": []}}}'
P_CI_RUNNING='{"pipeline": {"run": {"status": "running", "outcome": null}, "ci": "running"}}'
P_PIPELINE='{"pipeline": {"run": {"status": "fixing", "outcome": null},
             "active": {"step": "review", "active_for": "4m", "last_activity": "8s", "quiet": false, "round": "auto-fix 1/3"}}}'
P_PANE='{"current_state": {"state": "working", "source": "pane"}}'
P_PAUSED='{"current_state": {"state": "paused", "source": "status-log", "detail": "waiting for the rate limit to reset"}}'
P_MERGED='{"pipeline": {"pr": {"url": "https://github.com/o/r/pull/30", "state": "merged", "via": "receipt"}}}'

fold() {  # <patch-json>... ; calls from $CALLS (default [])
  local task=$BASE_TASK patch
  for patch in "$@"; do
    task=$(jq -n --argjson a "$task" --argjson b "$patch" '$a * $b') || fail "bad patch: $patch"
  done
  jq -cn --argjson t "$task" --argjson calls "${CALLS:-[]}" \
    "$FM_WAITING_ON_JQ_DEFS"'$t | waiting_on($calls)'
}

expect() {  # <result-json> <who> <rule> <message>
  printf '%s' "$1" | jq -e --arg who "$2" --argjson rule "$3" '.who == $who and .rule == $rule' >/dev/null \
    || fail "$4: got $1"
}

test_each_rule_alone() {
  local out
  out=$(CALLS=$CALLS_OPEN fold "$P_CALL")
  expect "$out" captain 1 "rule 1: an open call about this task"
  printf '%s' "$out" | jq -e '.call == "c-1" and .why == "your call"' >/dev/null \
    || fail "rule 1 names the call it matched: $out"
  out=$(fold "$P_GREEN")
  expect "$out" captain 2 "rule 2: green and open, yolo off"
  printf '%s' "$out" | jq -e '.why == "merge PR #35" and .call == null' >/dev/null || fail "rule 2 why: $out"
  out=$(fold "$P_GREEN" '{"yolo": "on"}')
  expect "$out" first_mate 2 "rule 2: green and open, yolo on"
  out=$(fold "$P_DIRECT_DONE")
  expect "$out" captain 2 "rule 2: a direct-PR task that reported done"
  printf '%s' "$out" | jq -e '.why == "merge PR #38"' >/dev/null || fail "rule 2 direct-PR why: $out"
  out=$(fold "$P_DIRECT_DONE" '{"pipeline": {"reason": "local-only"}, "yolo": "on"}')
  expect "$out" first_mate 2 "rule 2: a local-only task that reported done, yolo on"
  out=$(fold "$P_DECISION")
  expect "$out" first_mate 3 "rule 3: a keyed open decision"
  printf '%s' "$out" | jq -e '.why == "decision to make"' >/dev/null || fail "rule 3 why: $out"
  out=$(fold "$P_DECISION" "$P_ASK_USER")
  printf '%s' "$out" | jq -e '.rule == 3 and .why == "1 ask-user finding"' >/dev/null \
    || fail "rule 3 names an escalated ask-user finding by count: $out"
  out=$(fold '{"hints": {"open_decisions": [{"key": "k", "verb": "blocked", "summary": "no-mistakes daemon socket refused connections"}]}}')
  printf '%s' "$out" | jq -e '.rule == 3 and .why == "blocked"' >/dev/null || fail "rule 3 blocked why: $out"
  out=$(fold "$P_ASK_USER")
  expect "$out" first_mate 4 "rule 4: an ask-user finding at the gate"
  printf '%s' "$out" | jq -e '.why == "1 ask-user finding"' >/dev/null || fail "rule 4 why: $out"
  out=$(fold "$P_FAILED")
  expect "$out" first_mate 5 "rule 5: run failed"
  printf '%s' "$out" | jq -e '.why == "run failed at test"' >/dev/null || fail "rule 5 why: $out"
  out=$(fold '{"pipeline": {"run": {"status": "cancelled", "outcome": "cancelled"}}}')
  expect "$out" first_mate 5 "rule 5: run cancelled"
  out=$(fold '{"pipeline": {"pr": {"url": "https://github.com/o/r/pull/28", "state": "closed", "via": "forge"}}}')
  expect "$out" first_mate 5 "rule 5: PR closed unmerged"
  out=$(fold '{"pipeline": {"read": "coarse", "daemon": "down"}}')
  expect "$out" first_mate 5 "rule 5: daemon down"
  out=$(fold '{"pipeline": {"read": "coarse", "daemon": "down", "run": {"id": null, "head": null, "status": "failed", "outcome": null}}}')
  printf '%s' "$out" | jq -e '.why == "pipeline service down"' >/dev/null \
    || fail "rule 5: a failed record from a dead daemon is named as the daemon, not a failure: $out"
  out=$(fold "$P_WORKER_GATE")
  expect "$out" worker 6 "rule 6: a gate whose findings are all the worker's"
  printf '%s' "$out" | jq -e '.why == "3 review findings"' >/dev/null || fail "rule 6 why: $out"
  out=$(fold "$P_CI_RUNNING")
  expect "$out" ci 7 "rule 7: ci running"
  out=$(fold "$P_CI_RUNNING" '{"pipeline": {"ci": "rearmed"}}')
  expect "$out" ci 7 "rule 7: ci re-checking after main moved"
  printf '%s' "$out" | jq -e '.why == "re-checking after main moved"' >/dev/null || fail "rule 7 why: $out"
  out=$(fold "$P_PIPELINE")
  expect "$out" pipeline 8 "rule 8: a step fixing"
  printf '%s' "$out" | jq -e '.why == "review, auto-fix 1/3"' >/dev/null || fail "rule 8 why: $out"
  out=$(fold '{"pipeline": {"read": "coarse", "run": {"id": null, "head": null, "status": "running", "outcome": null}}}')
  expect "$out" pipeline 8 "rule 8: a ledger-only run"
  out=$(fold "$P_PANE")
  expect "$out" worker 9 "rule 9: no run, busy terminal"
  out=$(fold "$P_PANE" '{"kind": "scout", "pipeline": {"applies": false, "reason": "scout", "read": "none"}}')
  expect "$out" worker 9 "rule 9: a busy scout"
  printf '%s' "$out" | jq -e '.why == "investigating"' >/dev/null || fail "rule 9 scout why: $out"
  out=$(fold "$P_PAUSED")
  expect "$out" external 10 "rule 10: paused"
  out=$(fold "$P_MERGED")
  expect "$out" none 11 "rule 11: PR merged"
  out=$(fold '{"kind": "scout", "current_state": {"state": "done"}, "paths": {"report": {"present": true}},
              "pipeline": {"applies": false, "reason": "scout", "read": "none"}}')
  expect "$out" none 11 "rule 11: a finished scout's report is in"
  out=$(fold '{}')
  expect "$out" unknown 12 "rule 12: nothing proves a holder"
  out=$(jq -cn --argjson calls '[]' "$FM_WAITING_ON_JQ_DEFS"'{id: "bare"} | waiting_on($calls)')
  expect "$out" unknown 12 "rule 12: a row with no pipeline, state or hints"
  pass "every rule is reached on its own"
}

# Each pair satisfies both rules; the earlier one must win.
test_rule_order() {
  local out
  out=$(CALLS=$CALLS_OPEN fold "$P_GREEN")
  expect "$out" captain 1 "1 before 2: a call outranks the merge"
  out=$(CALLS=$CALLS_OPEN fold "$P_GREEN" '{"yolo": "on"}')
  expect "$out" captain 1 "1 before 2: a call outranks the first mate's merge"
  out=$(fold "$P_GREEN" "$P_DECISION" '{"yolo": "on"}')
  expect "$out" first_mate 2 "2 before 3: the merge question outranks an open decision"
  out=$(fold "$P_GREEN" "$P_DECISION")
  expect "$out" captain 2 "2 before 3: the captain's merge outranks an open decision"
  out=$(fold "$P_DECISION" "$P_ASK_USER")
  expect "$out" first_mate 3 "3 before 4: the escalation outranks the gate's ask-user"
  out=$(fold "$P_ASK_USER" '{"pipeline": {"daemon": "down"}}')
  expect "$out" first_mate 4 "4 before 5: ask-user outranks daemon down"
  out=$(fold "$P_FAILED" "$P_WORKER_GATE" '{"pipeline": {"run": {"outcome": "failed"}}}')
  expect "$out" first_mate 5 "5 before 6: a failed run outranks a worker's gate"
  out=$(fold "$P_WORKER_GATE" '{"pipeline": {"ci": "running"}}')
  expect "$out" worker 6 "6 before 7: a parked gate outranks a ci read"
  out=$(fold "$P_CI_RUNNING" "$P_PIPELINE")
  expect "$out" ci 7 "7 before 8: the ci step outranks the generic running step"
  out=$(fold "$P_PIPELINE" "$P_PAUSED")
  expect "$out" pipeline 8 "8 before 10: a running pipeline outranks a paused line"
  out=$(fold "$P_PANE" "$P_MERGED")
  expect "$out" worker 9 "9 before 11: a busy worker outranks a merged PR"
  out=$(fold "$P_PAUSED" "$P_MERGED")
  expect "$out" external 10 "10 before 11: a pause outranks a merged PR"
  out=$(fold "$P_MERGED" '{"current_state": {"state": "unknown", "source": "none"}}')
  expect "$out" none 11 "11 before 12: a merged PR is no one's"
  # Green-held: the run failed only because the ci monitor ended, and its ci
  # log reads green. That is the merge question, never a failure.
  out=$(fold "$P_FAILED" '{"pipeline": {"ci": "green", "pr": {"url": "https://github.com/o/r/pull/37", "state": "unknown", "via": null}}}')
  expect "$out" captain 2 "2 before 5: green-held is a merge, not a failure"
  printf '%s' "$out" | jq -e '.why == "checks green, PR #37 state not read"' >/dev/null \
    || fail "rule 2 why never claims a PR state it did not read: $out"
  # A gate whose ask-user split is unknown (a scalar count) is no worker's.
  out=$(fold "$P_WORKER_GATE" '{"pipeline": {"findings": {"total": 1, "ask_user": null, "rows": []}}}')
  expect "$out" unknown 12 "an unknown ask-user split proves no holder"
  # A merged PR with green ci is no longer a merge question.
  out=$(fold "$P_GREEN" "$P_MERGED" '{"pipeline": {"run": {"status": "completed", "outcome": "passed"}}}')
  expect "$out" none 11 "a merged PR is not rule 2's open PR"
  # A closed call, or one that is not captain-actionable, holds nothing.
  out=$(CALLS='[{"id": "c-2", "state": "answered", "captain_actionable": false, "origin": "t1"},
                {"id": "c-3", "state": "open", "captain_actionable": false, "about": "t1"}]' fold "$P_PANE")
  expect "$out" worker 9 "only an open, actionable call is rule 1"
  pass "the twelve rules hold their order"
}

test_pipeline_live() {
  live() { jq -n --argjson t "$1" "$FM_WAITING_ON_JQ_DEFS"'$t | pipeline_live'; }
  [ "$(live "$(jq -n --argjson a "$BASE_TASK" --argjson b "$P_PIPELINE" '$a * $b')")" = true ] \
    || fail "a fixing run is live"
  [ "$(live "$(jq -n --argjson a "$BASE_TASK" --argjson b "$P_CI_RUNNING" '$a * $b')")" = true ] \
    || fail "a run on its ci step is live"
  [ "$(live "$(jq -n --argjson a "$BASE_TASK" --argjson b "$P_WORKER_GATE" '$a * $b')")" = false ] \
    || fail "a parked run is not live"
  [ "$(live "$(jq -n --argjson a "$BASE_TASK" --argjson b "$P_FAILED" '$a * $b')")" = false ] \
    || fail "a finished run is not live"
  [ "$(live "$BASE_TASK")" = false ] || fail "no run is not live"
  [ "$(live '{"id": "x", "pipeline": null}')" = false ] || fail "no pipeline is not live"
  pass "pipeline_live is a running, fixing or ci run with no gate"
}

# End to end: the real snapshot, over a fake no-mistakes, carries the crew
# read's pipeline into tasks[], folds waiting_on there, and sets pipeline_live.
test_snapshot_carries_pipeline_and_waiting_on() {
  local home fb wt head json
  home="$TMP_ROOT/home"
  fb="$TMP_ROOT/fakebin"
  wt="$home/projects/demo-wt"
  mkdir -p "$home/state" "$home/data" "$home/config" "$home/projects" "$fb"
  git init -q "$wt"
  git -C "$wt" commit -q --allow-empty -m init
  git -C "$wt" checkout -q -b fm/demo
  head=$(git -C "$wt" rev-parse HEAD)
  cat > "$home/data/backlog.md" <<'EOF'
## In flight
- [ ] demo - Demo task (repo: demo) (kind: ship)

## Queued

## Done
EOF
  fm_write_meta "$home/state/demo.meta" "window=fixture:demo" "worktree=$wt" "project=demo" \
    "harness=claude" "kind=ship" "mode=no-mistakes" "yolo=off"
  cat > "$fb/no-mistakes" <<SH
#!/usr/bin/env bash
case "\$1 \$2" in
  "axi status") cat "$TMP_ROOT/axi-status" ;;
esac
exit 0
SH
  chmod +x "$fb/no-mistakes"
  cat > "$TMP_ROOT/axi-status" <<EOF
run:
  id: "01RUNE2E"
  branch: fm/demo
  status: fixing
  head: "$head"
  pr: ""
  findings: none
  steps[3]{step,status,findings,duration_ms}:
    intent,completed,0,425
    rebase,skipped,0,0
    review,fixing,2,1200
  active_steps[1]{step,active_for,last_activity,agent_pid,round}:
    review,4m2s,8s,44121,"auto-fix 1/3"
EOF
  json=$(PATH="$fb:$PATH" FM_HOME="$home" FM_SNAPSHOT_NOW=2026-10-01T12:00:00Z \
    FM_SNAPSHOT_NOW_EPOCH=1790856000 "$ROOT/bin/fm-fleet-snapshot.sh" --json) \
    || fail "fleet snapshot failed"
  printf '%s' "$json" | jq -e '
    .pipeline_live == true
    and (.tasks[] | select(.id == "demo")
      | .pipeline.read == "full" and .pipeline.run.id == "01RUNE2E"
        and .pipeline.active.round == "auto-fix 1/3"
        and (.current_state | has("pipeline") | not)
        and .current_state.state == "working"
        and .waiting_on == {who: "pipeline", why: "review, auto-fix 1/3", rule: 8, call: null})' >/dev/null \
    || fail "snapshot did not carry a live run: $(printf '%s' "$json" | jq -c '{pipeline_live, t: [.tasks[] | {id, pipeline, waiting_on}]}')"

  cat > "$TMP_ROOT/axi-status" <<EOF
run:
  id: "01RUNE2E"
  branch: fm/demo
  status: awaiting_approval
  awaiting_agent: parked 1m
  head: "$head"
  pr: ""
  findings[1]{id,severity,file,line,action,description}:
    r1,warning,a.go,,auto-fix,ignored error
gate: review
EOF
  json=$(PATH="$fb:$PATH" FM_HOME="$home" FM_SNAPSHOT_NOW=2026-10-01T12:00:00Z \
    FM_SNAPSHOT_NOW_EPOCH=1790856000 "$ROOT/bin/fm-fleet-snapshot.sh" --json) \
    || fail "fleet snapshot failed"
  printf '%s' "$json" | jq -e '
    .pipeline_live == false
    and (.tasks[] | select(.id == "demo")
      | .pipeline.gate.step == "review"
        and .waiting_on == {who: "worker", why: "1 review finding", rule: 6, call: null})' >/dev/null \
    || fail "snapshot did not fold a parked run: $(printf '%s' "$json" | jq -c '{pipeline_live, t: [.tasks[] | {id, pipeline, waiting_on}]}')"

  : > "$TMP_ROOT/axi-status"
  json=$(PATH="$fb:$PATH" FM_HOME="$home" FM_SNAPSHOT_NOW=2026-10-01T12:00:00Z \
    FM_SNAPSHOT_NOW_EPOCH=1790856000 "$ROOT/bin/fm-fleet-snapshot.sh" --json) \
    || fail "fleet snapshot failed"
  printf '%s' "$json" | jq -e '
    .pipeline_live == false
    and (.tasks[] | select(.id == "demo") | .pipeline.read == "unanswered" and .pipeline.run == null)' >/dev/null \
    || fail "snapshot hid an unanswered read: $(printf '%s' "$json" | jq -c '[.tasks[] | {id, pipeline}]')"
  pass "the snapshot carries pipeline, waiting_on and pipeline_live"
}

test_each_rule_alone
test_rule_order
test_pipeline_live
test_snapshot_carries_pipeline_and_waiting_on

echo "all fm-fleet-waiting-on tests passed"
