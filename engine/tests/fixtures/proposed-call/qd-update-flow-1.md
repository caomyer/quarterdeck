# Quarterdeck update flow: design proposal

This fixture is the opening line and the closing `## Proposed call` section of a real scout report, verbatim.

## Proposed call

Question: How should Quarterdeck get a stable signing identity so macOS permissions survive updates?

- `both` - Self-signed now, Developer ID when enrolled. Costs $99 per year plus one or two days of enrollment, and one last re-grant at the switch; updates and surviving grants start this week.
- `devid` - Developer ID and notarization only. Costs $99 per year; the updater waits for enrollment, and grants keep resetting until then.
- `selfsign` - Self-signed only. Free, works on this Mac only, a browser download trips Gatekeeper, and it can never go to another Mac without re-signing.
- `unsigned` - Ship the updater with today's ad-hoc signature. Free, but every update keeps resetting every grant, which is the complaint itself.

Recommendation: `both`.
Enrollment is the long pole and costs little; the self-signed identity stops the grant loss now instead of after Apple, and the updater is independent of Apple in Tauri, so nothing waits on it.
