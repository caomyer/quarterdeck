# Integration report: fm/overnight-collab

Integrator: `qd-on-integrate-1`, 2026-09-27.
Question answered: do the overnight branches stand up together, not whether each is good.

## What was validated, on which sha

- Final tip validated: `6a18b47` (merge of the last three `fm/qd-on-devtest-1` commits).
- App checks (`pnpm test`, `tsc`, `cargo clippy --all-targets`, `cargo test`, 17 Vite checks) ran on `6a18b47` itself.
- The engine suite (`engine/bin/fm-test-run.sh --changed`) ran from working commit `c3cf45e`.
  `git diff c3cf45e 6a18b47 -- engine` is empty, so it is the same engine tree as the final tip.
- Earlier rounds, superseded, kept only for how failures were bucketed: `687857f` (round 1), `ad8f143` (round 2, engine run stopped when the branch moved), `dfcf4d5` (round 3).
- Main comparisons ran on an extracted copy of `origin/main` at `27976ed` (`engine/` and `.github/`).

## Results on the final tip

| Check | Result |
| --- | --- |
| `engine/bin/fm-lint.sh` | pass (exit 0) |
| `pnpm test` | 184 of 184 pass |
| `pnpm exec tsc` | exit 0 |
| `cargo clippy --all-targets` | exit 0 |
| `cargo test` | 162 passed, 0 failed, 11 ignored (the live tests) |
| Vite: artifacts, tasks, taskview, calls, replies, tones, sources, projects, starts, evidence, onboarding, attach, routing, usage, updates, session, replay | 17 of 17 exit 0; 1478 ok, 0 FAIL |
| `engine/bin/fm-test-run.sh --changed` (230 cases) | ENGINE RESULT: pending, filled in when the run returns |

Engine failures so far in the final run, 74 of 230 cases complete: `fm-mail` (timeout), `fm-muse-harness`, `fm-harness-precedence`, `fm-kimi-harness`, all pre-existing on main (below).

## The two merges resolved

### 1. `fm/qd-on-devtest-1` up to `abe0ef9`, merged as `dfcf4d5`

- Conflict: `src/App.tsx`, the `artifactKey` / `artifactStanding` region.
  `fm/qd-on-taskview-1` had moved both functions into `src/produced.ts`; `abe0ef9` ("a new question under an answered call's name shows as open") changed `artifactStanding` in place.
- Checked first that devtest's `App.tsx` changes against the merge base were exactly `abe0ef9`'s three: the import, the call card's `answeredIn`, and `artifactStanding`.
- Resolution: kept taskview's relocation (the conflict block dropped, one definition only), and applied `abe0ef9`'s `answeredHere` / `answersThisAsk` guard to `artifactStanding` in `src/produced.ts`.
  The call card's `answeredIn` change merged cleanly in `App.tsx`.
  No other site in `src/` reads `review.answered` for calls.
- Proof: added a test to `scripts/produced.test.mjs` on the moved function.
  A call raised after the page's recorded answer reads `needs-you`; raised before it, `discussion`; a review with no `answered_at` keeps the old reading.
  With the fix reverted in `src/produced.ts`, that test fails (10 pass, 1 fail); with it, 11 of 11 pass.
  `abe0ef9`'s own `answersThisAsk` test in `scripts/calls.test.mjs` also passes.

### 2. `fm/qd-on-devtest-1` `a26e0a9`, `1dc767c`, `724f1bf`, merged as `6a18b47`

- Firstmate reported a conflict; on top of `c3cf45e` git merged it with none, because the region had already been resolved in `dfcf4d5`.
- `1dc767c` ("say only what is true in the Ahoy banner and the first mate's status") is intact: `runtimeLabel` returns "Working on its own" for `agent_turn`, and the banner's "Everything else is moving." needs both an open call and `underway.length`.
- No check in `scripts/` covers either string.
  Observed instead, driving the mock on `6a18b47` with Playwright:
  the default mock (1 open call, 0 underway) shows no "Everything else is moving.";
  `?artifacts` (4 open calls, 1 underway) shows it.
  "Working on its own" was not observed: no mock state or check reaches `agent_turn` with that label drawn.

## What changed on the branch from integration

1. `dfcf4d5` merge, resolved as above, plus the `produced.test.mjs` test.
2. `c3cf45e` `fix(engine): map the fake-tmux helpers so --changed can select their suites`.
   `fm-test-run.sh --changed` refused the combined tree with `no changed-test mapping for source path: tests/fake-tmux-liveness.sh` (exit 2), so the engine suite could not run at all.
   Suites reach `tests/fake-tmux-liveness.sh` and `tests/fake-tmux-typed.sh` through `lib.sh`'s `FM_TEST_FAKE_TMUX_*` variables (and `fixtures.sh`), so the reference scan now matches those names.
   Selection went from refusing to 230 cases; `fm-test-run.test.sh` and `fm-lint.sh` pass.
3. `6a18b47` merge, clean.

## Every failure seen, by bucket

### Crewmate bugs, found at `687857f`, fixed by their owners before the final tip

| Failure | Owner | Evidence | Status on final tip |
| --- | --- | --- | --- |
| `fm-lint.sh`: SC1007, SC1010, SC2016, SC2030, SC2031 in `fm-artifact.sh`, `fm-tasks-axi.sh`, `fm-review-waits.test.sh`; also fails `fm-lint.test.sh` | `qd-on-approve-1` | every line added by `09e5730`; lint passes on main | fixed in `4cf69dc` |
| `fm-test-run.test.sh`: coverage guard, 29 of 189 portable scripts unhinted (max 15%) | `qd-on-approve-1` | new `fm-review-waits.test.sh` had no hint; passes on main | fixed in `4cf69dc` |
| `pnpm artifacts`: drawer section order, filer's list, unscoped `.fold-toggle` click, `.drawer-pages` gone | `qd-on-taskview-1` | `c643a6e` redesigned the drawer without updating the check | fixed in `a7aa88b` |
| `pnpm projects`, `pnpm starts`: drawer PR is a button, not `a[href]` | `qd-on-taskview-1` | same | fixed in `a7aa88b` (`start-work.mjs` updated; the drawer draws the PR as a link again, so `project-page.mjs` passes unchanged) |
| `fm-test-run.sh --changed` refuses: unmapped `tests/fake-tmux-liveness.sh` | `qd-on-noise-1` | new helper from `63de740`/`32dbd5e`; noise's CI ran by `workflow_dispatch`, not `--changed` | fixed by the integrator in `c3cf45e` (owner had finished) |

I held off on the approve-1 and taskview-1 bugs while both workers still had uncommitted edits to those files.

### Pre-existing on main (`27976ed`), same first failure on both trees

| Test | First failure, identical on main |
| --- | --- |
| `fm-mail` | exceeds the 900s bound after the same 20 passing cases (exit 124) |
| `fm-muse-harness` | `fm-harness.sh under process 'muse-bin-0.1.0-R708.1' reported '', expected muse` |
| `fm-harness-precedence` | `codex ancestry alone resolved '', expected codex` |
| `fm-kimi-harness` | `verified kimi launch-then-send should succeed: expected exit 0, got 1` |
| `fm-remote-herdr-guard` | `this host does not expose a holder's environment (macOS hides platform-binary environments ...)` |
| `fm-remote-doctor` | `--fix left a repairable host unready: expected exit 0, got 1` |
| `fm-afk-return` | `evidence publication failure should retain catch-up (rc=1)` |
| `fm-teardown` | `herdr-preflight-missing-adapter: teardown continued without its required preflight` (round 1; `0a635a7` later targets it) |

The harness lanes are the macOS System Integrity Protection limit `AGENTS.md` records; they run on Linux in CI.

### Flakes under load, not reproducible alone

- `fm-secondmate-harness` (round 1): `first config push did not reach pointer delivery` in the parallel run; passed alone on both our tree and main.
- `cargo test` `host::tests::kept_picks_are_applied_again_after_every_start` (round 3, run beside the engine suite): failed once at `host.rs:3190` (`shown > started`); 5 of 5 alone pass, and it passed in rounds 1, 2 and on the final tip.
  The test is from main (`ea4ded3`, #26), untouched tonight.

### Integration failures

None: no check failed because of how two branches combined.

## Findings for firstmate, not fixed

1. The engine's verdict intake has no production caller.
   `fm-artifact.sh verdict` (from `qd-on-approve-1`) is called only by its tests and `fm-backlog-transition-lib.sh`; neither `src-tauri/src/review.rs` nor `engine/AGENTS.md` records a verdict there.
   So a review sent from the app does not lift an engine review wait or a review hold; only a first mate that happens to run the command would.
   Wiring it is a design choice across the app and the engine, not an integration fix.
2. Review standing now has two records that are never reconciled.
   The snapshot carries the engine's `reviews[]`; the app reads none of it, and the task drawer (`src/produced.ts`, `qd-on-taskview-1`) takes standing only from the app's own `ReviewSummary`.
3. The engine's retained, review-held row uses hold kind `external` with the reason "waiting for the captain to review a presented page", which the app draws as a generic external hold.
   Not a break, noted because the two sides were built apart.
4. Not fixed on purpose: the `fm-mail` hang, the macOS-only failures and the `kept_picks` flake, all on main and outside this branch; `qd-teardown-test-1` owns the main engine failures.

## History

No rebase and no force push.
`fm/overnight-collab` moved only by fast-forward pushes: `9d80ab6..dfcf4d5`, `dfcf4d5..c3cf45e`, `c3cf45e..6a18b47`.
Draft PR https://github.com/caomyer/quarterdeck/pull/31 was not touched.
