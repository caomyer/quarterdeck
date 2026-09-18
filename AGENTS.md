# Quarterdeck

A desktop app that hosts the firstmate first mate over ACP and renders its state natively.
Quarterdeck is the code name: the deck a captain commands from.
The UI (React and Vite) is in `src/`, and the Tauri backend is in `src-tauri/`.
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
- App: `PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev`.
  The app remembers its home in its app data folder, which on James's Mac names his live home, so never launch it plainly.
  Set `QUARTERDECK_SETTINGS_DIR` to a folder under your scratch home holding `settings.json` with `{"home": "<scratch home>"}`, and the app uses that instead.
  Stop it by the PIDs you started, never with a `pkill` pattern: other agents run their own servers on this machine, and a pattern kill takes theirs down with yours.
