# Quarterdeck

A desktop app that hosts the firstmate first mate over ACP and renders its state natively.
Quarterdeck is the code name: the deck a captain commands from.
The UI (React and Vite) is in `src/`, the Tauri backend is in `src-tauri/`, and the first mate's own code is in `engine/`.
James's checkout lives at `~/Documents/projects/quarterdeck`, inside iCloud Drive.
Agents do not work there and do not branch from it: each agent clones the remote to `~/.buzz/REPOS/quarterdeck-<agent>` on local disk.

## Repository rules

- Commit as the repo's configured author, `James Cao <caomyer@gmail.com>`.
  James is the author of record for all work, including agent work.
- Never add agent names, `Co-Authored-By` lines, or other agent trailers.
  The #firstmate Buzz thread is the provenance.
- The remote is `https://github.com/caomyer/quarterdeck`, private, under James's account.
  Push `main` and any branch worth keeping; do not make the repository public or add another remote without James's say-so.
- Never use em dashes in code, docs, or commit messages.

## The engine

`engine/` is firstmate: the bash fleet supervisor the app runs.
It was its own repository at `caomyer/firstmate` until 2026-09-20, when it moved here with all 720 of its commits, paths rewritten, so `git log` and `git blame` read its whole past from this repo.
It is not a vendored dependency and not a submodule: it is ours, edited here, and a change that crosses the line between the app and the first mate is one commit.

- Its checks are its own, and they run from `engine/`: `cd engine && bin/fm-test-run.sh --changed` for what your change touches, `bin/fm-lint.sh` for the shell, `bin/fm-test-run.sh --all` for the full 221-script regression.
  They need pinned ShellCheck and actionlint on PATH; `engine/bin/fm-install-shellcheck.sh <dir>` and `engine/bin/fm-install-actionlint.sh <dir>` fetch the versions CI uses.
- GitHub runs workflows only from a repository root, so the engine's live at `.github/workflows/engine.yml`, running from `engine/` and firing only on changes under it.
  `.github/workflows/app.yml` is the app's own, and skips a change confined to `engine/`.
- `engine/AGENTS.md` is the first mate's job description, addressed to the first mate at work in a fleet.
  It is not instructions for an agent working on this repository, and a harness that loads it because you edited a file under `engine/` is showing you the product, not your brief.
  This file is your brief.
- firstmate's `Require no-mistakes` workflow did not come across: it forced every pull request to be raised through the no-mistakes gate, which was that repository's contribution policy.
  Nothing imposes it here.
  Ask James before adding it back.

## Firstmate homes

- Never run the app, the host, or any fleet-mutating command against James's live home `~/Documents/projects/firstmate`.
- Use a scratch home under `~/.buzz/.scratch`, one per agent: Fizz uses `fm-probe/firstmate`, Pumpkin uses `fm-probe-ui/firstmate`.
  Two hosts on one home contend for the session lock.

## Build and test

- Rust is pinned by `rust-toolchain.toml`, and `cargo` lives in `~/.cargo/bin`.
- Agents work from their own clone of the remote at `~/.buzz/REPOS/quarterdeck-<agent>`, on local disk, building normally into its own `target/`.
  Not a worktree of James's checkout.
  A worktree holds only a `gitdir:` pointer into its parent's `.git`, so every git command in it reads `~/Documents/projects/quarterdeck/.git`.
  When iCloud denies that path, the worktree dies with `fatal: not a git repository`, no matter where the worktree itself lives.
  One clone per agent: sessions run concurrently, and a shared clone puts two agents on one working tree and one branch.
  `origin` is the shared truth.
  Run `git fetch origin && git rebase origin/main` before starting, and again after committing and before you push, then push your branch so it is visible to everyone else.
  Rebase refuses to run while the tree has uncommitted changes, so "rebase before handing over" does nothing if you run it with your work still uncommitted: it prints `cannot rebase: You have unstaged changes` and you push anyway.
  Commit first, then rebase, then push.
  Only James's checkout sits in iCloud, so the rule below applies to it alone.
- This checkout is inside iCloud Drive, which adds sync attributes that make codesign fail, so the build output is kept outside it.
  `src-tauri/.cargo/config.toml` points Cargo at `~/Library/Caches/quarterdeck/target`; it holds a machine-specific path and is not committed.
  Never commit that file, and never let a build write `src-tauri/target` inside the checkout.
  A build cache cannot be moved between checkout paths: Tauri bakes absolute paths into it, so after a move, delete the cache and rebuild.
- Backend: `cd src-tauri && cargo clippy --all-targets && cargo test`.
- The look is tokens: palette, type (Instrument Sans and IBM Plex Mono, bundled from `@fontsource`) and surfaces are declared once at the top of `src/styles.css`, light in `:root` and dark in `:root.dark`.
  Style with the tokens, never a literal colour: `pnpm tones` compares what it sees against them.
- How every screen reads captain calls (`src/calls.ts`) and how a project's logbook reads closed work (`src/logbook.ts`): `pnpm test`, which needs no server.
  Calls come only from the snapshot's `calls[]`, which `bin/fm-captain-hold.sh` owns; the app answers them through its `answers` intake (`src-tauri/src/calls.rs`) and never closes one itself.
  Closed work beyond the snapshot's few recent rows comes only from `bin/fm-history.sh`, read when a project page opens; the app never parses the backlog or its archive itself.
- Live test of a project's history, which spends no tokens and changes nothing in the home:
  `cd src-tauri && FM_E2E_HOME=<scratch home> cargo test history_e2e_live_scratch_home -- --ignored --nocapture`.
  It reads every registered project's history through the app's own command, pages through it one row at a time, and checks `state/` and `data/` are untouched.
- Live end-to-end test, which spends model tokens: `cd src-tauri && FM_E2E_HOME=<scratch home> cargo test host_e2e_live_scratch_home -- --ignored --nocapture`.
  It writes a summary and a replayable event recording to `~/.buzz/.scratch/firstmate-desktop-e2e/`.
  Name the test exactly: `host_e2e` also matches the lock probe, and two first mates in one home make the loser report the other as another session.
  Only one live run per home runs at a time; a second one waits in the same binary and refuses across processes, naming the run that holds it.
- Live test of a relaunch, which also spends model tokens: `cd src-tauri && FM_E2E_HOME=<scratch home> cargo test host_e2e_live_relaunch -- --ignored --nocapture`.
  It closes and relaunches the host with crew wakes waiting, and checks the first mate handles them without a captain message, no watcher outlives it, and the conversation comes back.
  `pnpm replay` also plays its relaunch through the UI.
- Live test of a captain's call answered in the page that argues it, which also spends model tokens:
  `cd src-tauri && FM_E2E_HOME=<scratch home> cargo test review_e2e_live_decision -- --ignored --nocapture`.
  It answers a call the home is already carrying, or asks the first mate to put one up, sends the review the app would send, and waits for the call to stop waiting in the backlog.
  Nothing in it is hand-built: a hold written by the test would prove nothing about the path it tests.
  It runs the same lock and one-run-per-home rules as the test above, so give it the same care.
- Replay that recording through the UI, which spends no tokens: start Vite on your own port, then
  `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm replay`.
  It plays the recorded host events into the real UI and checks the resumed conversation, the crash banner, the re-sent message and the messages restored from the outbox.
  Run it after a change to the host's events.
- Check that status colour and icon follow the status, in both themes: start Vite on your own port, then
  `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm tones`.
  It feeds the mock a task in each state `fm-fleet-snapshot.sh` reports, so run it after changing how a state, an answer or the first mate's health is drawn.
  It refuses a recording that predates the fields it checks rather than passing over code it never reached, so record a fresh run when the event shapes change.
- Check the artifact review flow, in both themes: start Vite on your own port, then
  `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm artifacts`.
  It opens the mock with `?artifacts`, whose pages live in `src/fixtures/review-pages` and are served only by the dev server, and checks the list, the review screen, revisions, the narrow width, accepted layout findings, the frame's sandbox, the ways in from chat and the task drawer, reviewing itself: commenting on part of a page, the draft surviving a reload, taking a comment back, and sending the review with a verdict, iterating: what a later revision answers, settling a comment, and what the list says is new, deciding: a call answered inside the page that argues it, sent with the comments in one review, and a diagram the page owns: opening its scene, proposing changes, and how they reach the author.
  The dev server appends `src-tauri/src/review-frame.js` to those pages exactly as the app's own scheme does, so commenting behaves the same in both.
  Set `ARTIFACT_SHOTS=<folder>` to also save screenshots.
  Run it after changing how artifacts are listed, opened or framed.
- Check a project's page, in both themes: start Vite on your own port, then
  `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm projects`.
  It checks what waits on the captain in the project, what is underway and up next, and the logbook: its filters, search, the rows closed without a delivery, a closed task's details, paging, and a firstmate that cannot list its history or fails to.
  Run it after changing the project page or the mock's history.
- Check what the app tells a captain their Mac still needs, in both themes: start Vite on your own port, then
  `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm onboarding`.
  It checks the checklist the first mate's own detection produces, the remedy beside each name, a line the app has no shape for shown in the first mate's words, a check that could not be made, and a Mac with nothing missing saying nothing.
  The list is never kept here: `bin/fm-bootstrap.sh` owns what a home needs, and the app asks it for detection only with the network phase skipped, so the check reads the machine and changes nothing.
  Run it after changing that banner or what the backend reads from bootstrap.
- Files the captain attaches travel as words: picking one only checks it, and the host copies each into the home's `data/.attachments/` when the message is sent (`src-tauri/src/attach.rs`), and `src/attachments.ts` alone writes and reads the block naming those copies in the message, so the outbox, re-sends and history stay text.
  Check the composer, the sent message and the refusals, in both themes: start Vite on your own port, then `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm attach`.
  Live, which spends model tokens: `cd src-tauri && FM_E2E_HOME=<scratch home> cargo test attach_e2e_live_scratch_home -- --ignored --nocapture` has a real first mate read an attached file, and read it again after a restart mid-turn.
- Crew routing, in Settings, reads and writes only through `engine/bin/fm-crew-dispatch.sh` (`src-tauri/src/routing.rs`): the app never writes `config/crew-dispatch.json` or the `.env` key line itself, and the key goes to the script on stdin and never comes back to the window.
  Its rule form offers only the harnesses and efforts `fm-crew-dispatch.sh harnesses` lists, so the app keeps no copy of either; `src/rules.ts` edits one field at a time and keeps every key it does not show.
  Check it, in both themes: start Vite on your own port, then `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm routing`.
- The usage strip above the First Mate footer (`src/UsagePanel.tsx`, read by `src/usage.ts`) shows two readings it never mixes: the first mate's context window, only from the host's reading of the adapter's usage updates, and plan limits, only from `quota-axi` through `src-tauri/src/quota.rs`.
  Compact now sends Claude Code's own `/compact` through the ordinary message path, after the captain confirms, and nothing else ever compacts from the app.
  Check every state, including needs-authorization, stale and empty, in both themes: start Vite on your own port, then `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm usage`.
  `cd src-tauri && cargo test quota_live_reads_this_mac -- --ignored --nocapture` reads this Mac's quota-axi through the app's path, spending nothing.
  Live, which spends model tokens: `cd src-tauri && FM_E2E_HOME=<scratch home> cargo test compact_e2e_live_scratch_home -- --ignored --nocapture` compacts a real first mate while it is idle and while a turn runs.
- Every push to `main` publishes a release that running apps install (`.github/workflows/release.yml`, `src-tauri/src/update.rs`); `docs/releasing.md` says how, and what only James can do.
  `app.yml`'s Bundle job dry-runs that build on every branch, publishing nothing.
  Never publish a release to try something.
  A release build you launch must run with `QUARTERDECK_UPDATES=off`, or quitting it installs the latest release over it.
  Check the sidebar's update notice, in both themes: start Vite on your own port, then `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm updates`.
- App: `PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev`.
  The app remembers its home in its app data folder, which on James's Mac names his live home, so never launch it plainly.
  Set `QUARTERDECK_SETTINGS_DIR` to a folder under your scratch home holding `settings.json` with `{"home": "<scratch home>"}`, and the app uses that instead.
  Stop it by the PIDs you started, never with a `pkill` pattern: other agents run their own servers on this machine, and a pattern kill takes theirs down with yours.

## Continuous integration

- Every job runs on a GitHub-hosted runner, and self-hosted runners are not used here.
  That is a security boundary, not a preference: the repository is public, so anyone may fork it and open a pull request, and a pull request can change the workflow it runs under.
  On a hosted runner that is a throwaway virtual machine; on a self-hosted runner it is arbitrary code on the owner's own machine, as the owner's user, with reach into the keychain, SSH keys and the iCloud checkout.
  Standard hosted runners are free and unmetered for public repositories, macOS included, so self-hosting would buy nothing.
  Two self-hosted runners were tried on 2026-09-20 while the repository was private and Actions minutes had run out; they were removed the same day when it went public.
- Where a job runs is decided by what the job needs, and the default is `ubuntu-latest`.
  Only five jobs name `macos-latest`: the three App jobs and the Release job, because the app ships for macOS and is built and signed there, and the engine's stock-Bash job, because it asserts `/bin/bash` is exactly 3.2.57.
- The engine's four behaviour lanes must stay on Linux, and moving them to macOS is not an optimisation to retry.
  They identify a harness by reading another process's environment, and macOS System Integrity Protection forbids that for platform binaries.
  On a Mac `fm-harness-precedence`, `fm-kimi-harness`, `fm-muse-harness`, `fm-cursor-harness` and `fm-remote-herdr-guard` all resolve an empty harness name and fail; `fm-remote-herdr-guard` names the reason itself.
  This was measured on 2026-09-20 by moving the whole suite to a Mac and reading what came back.
- A CI job never installs into the machine's global npm prefix.
  Each sets `npm_config_prefix` to its own `$RUNNER_TEMP/npm` in a first step, so a job depends on no machine-global state.
  `npm root -g` inside `fm-pi-primary-types.test.sh` reads the same variable, so installs and lookups agree.
- A job may not assume a tool the runner image happened to provide.
  `tests/fm-pi-primary-types.test.sh` needs a global `tsc` and the lane refuses to let it skip, so TypeScript is installed explicitly and pinned at `typescript@6.0.3`, the version the app's own lockfile resolves.
- `.github/workflows/engine-windows-herdr-spike.yml` names `windows-latest`.
  It is `workflow_dispatch` only, so nothing starts it but James, and it measures Windows, which neither other lane can answer for.
- Fork pull requests from outside contributors require approval before any workflow runs.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
