# firstmate desktop MVP

A desktop app that hosts the firstmate first mate over ACP and renders its state natively.
The UI (React and Vite) is in `src/`, and the Tauri backend is in `src-tauri/`.

## Repository rules

- Commit as the repo's configured author, `James Cao <caomyer@gmail.com>`.
  James is the author of record for all work, including agent work.
- Never add agent names, `Co-Authored-By` lines, or other agent trailers.
  The #firstmate Buzz thread is the provenance.
- The repo is local only, with no remote.
  Do not create or push to a remote without James's say-so.
- Never use em dashes in code, docs, or commit messages.

## Firstmate homes

- Never run the app, the host, or any fleet-mutating command against James's live home `~/Documents/projects/firstmate`.
- Use a scratch home under `~/.buzz/.scratch`, one per agent: Fizz uses `fm-probe/firstmate`, Pumpkin uses `fm-probe-ui/firstmate`.
  Two hosts on one home contend for the session lock.

## Build and test

- Rust is pinned by `rust-toolchain.toml`, and `cargo` lives in `~/.cargo/bin`.
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
