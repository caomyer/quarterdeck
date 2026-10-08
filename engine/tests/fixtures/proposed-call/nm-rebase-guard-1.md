# nm-rebase-guard-1: why an ordinary rebase strands a no-mistakes branch, and what to do about it

This fixture is the opening line and the closing `## Proposed call` section of a real scout report, verbatim.

## Proposed call

Question: How should we stop ordinary rebases from stranding branches in no-mistakes?

- `merge-and-upstream`: Switch to merge-based integration now, and take the guard fix upstream.
  Costs:
  - A one-line trusted `.no-mistakes.yaml` on main, and a wording change in `AGENTS.md:51-53` and the worker brief (merge `origin/main`, never rebase a submitted branch).
  - Firstmate updating the shared daemon to v1.83.x at a quiet moment.
  - A worker's time to raise the content-test fix and the refusal-3 report upstream.
  - Branches carry merge commits that squash-merge removes.
- `merge-only`: Switch to merge-based integration and the daemon update, and leave the guard upstream as it is.
  Costs: the same local changes. Anyone who rebases still hits the false refusals, and upstream keeps the defect.
- `upstream-only`: Keep rebasing, contribute the guard, rebase-target and custody fixes upstream, and wait for a release.
  Costs: every rebase keeps costing a firstmate verification and an authorisation until upstream ships, for weeks at least, on a timeline we do not control.
- `local-fork`: Run a locally patched no-mistakes with the new test.
  Costs: we own a fork of a daemon every lane depends on, including every upgrade and every conflict with upstream. I recommend against it.
- `status-quo`: Keep today's flow, with firstmate verifying and authorising each stranded rebase.
  Costs: the tax the task describes, on every overlapping PR.

Recommendation: `merge-and-upstream`.
It is the only option that removes all four refusals today, and it does so with a setting no-mistakes already ships and tests.
The upstream work then fixes the test for everyone who does rebase, and our local posture does not depend on it landing.

A precedent to weigh: on qd-prbody-lint-1 the captain chose `local-only` for a no-mistakes defect, keeping the local repair and not touching their repository.
`merge-only` is the option consistent with that standing choice, and it removes the same four refusals for us.
I still recommend `merge-and-upstream` because this defect differs in two ways.
- No local repair exists for the guard itself, only a way to avoid it.
- Upstream has already asked for exactly this fix (#1174, ready-for-pr), and took the neighbouring one (#1193) within a day.

