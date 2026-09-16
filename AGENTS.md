# Quarterdeck

A desktop app that hosts the firstmate first mate over ACP and renders its state natively.
Quarterdeck is the code name: the deck a captain commands from.
The UI (React and Vite) is in `src/`, and the Tauri backend is in `src-tauri/`.
The checkout lives at `~/Documents/projects/quarterdeck`.

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
- Agent worktrees live outside iCloud, under `~/.buzz/REPOS/quarterdeck-wt/<name>`, and build normally into their own `target/`.
  Only this checkout sits in iCloud, so the rule below applies to it alone.
- This checkout is inside iCloud Drive, which adds sync attributes that make codesign fail, so the build output is kept outside it.
  `src-tauri/.cargo/config.toml` points Cargo at `~/Library/Caches/quarterdeck/target`; it holds a machine-specific path and is not committed.
  Never commit that file, and never let a build write `src-tauri/target` inside the checkout.
  A build cache cannot be moved between checkout paths: Tauri bakes absolute paths into it, so after a move, delete the cache and rebuild.
- Backend: `cd src-tauri && cargo clippy --all-targets && cargo test`.
- Live end-to-end test, which spends model tokens: `cd src-tauri && FM_E2E_HOME=<scratch home> cargo test host_e2e_live_scratch_home -- --ignored --nocapture`.
  It writes a summary and a replayable event recording to `~/.buzz/.scratch/firstmate-desktop-e2e/`.
  Name the test exactly: `host_e2e` also matches the lock probe, and two first mates in one home make the loser report the other as another session.
  Only one live run per home runs at a time; a second one waits in the same binary and refuses across processes, naming the run that holds it.
- Replay that recording through the UI, which spends no tokens: start Vite on your own port, then
  `FIRSTMATE_URL=http://127.0.0.1:<port> pnpm replay`.
  It plays the recorded host events into the real UI and checks the resumed conversation, the crash banner, the re-sent message and the messages restored from the outbox.
  Run it after a change to the host's events.
  It refuses a recording that predates the fields it checks rather than passing over code it never reached, so record a fresh run when the event shapes change.
- App: `PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev`.
  Stop it by the PIDs you started, never with a `pkill` pattern: other agents run servers from this checkout.
