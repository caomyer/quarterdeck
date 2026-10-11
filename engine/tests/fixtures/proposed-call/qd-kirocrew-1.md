# KiroCrew vs Quarterdeck: scout report

This fixture is the opening line and the closing `## Proposed call` section of a real scout report, verbatim.

## Proposed call

Should crew workers run inside an OS sandbox that hides credentials and other homes, as KiroCrew does, instead of today's unrestricted `--dangerously-skip-permissions` default?

- `keep`: **Keep unrestricted workers.** Costs nothing now; a prompt-injected worker can still read `~/.ssh`, cloud credentials and other homes.
- `optin`: **Build a sandbox tier, off by default.** About a week of engine work (launch wrapper, Seatbelt profile, per-harness checks); protects only homes that turn it on.
- `default`: **Build it and make it the default.** Same build plus fixing whatever breaks: some workers lose tools that need credentials (for example `aws`, git over SSH) until a looser tier is chosen per project.

Recommendation: `optin`.
KiroCrew's own experience (`docs/architecture/overview.md:454-463`) is that a strict tier breaks common tools, which is why their default tier leaves `~/.ssh` and `~/.aws` visible.
Start opt-in, measure on our own fleet, then decide whether to flip the default.
