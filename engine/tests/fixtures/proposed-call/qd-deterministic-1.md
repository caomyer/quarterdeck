# qd-deterministic-1: where the system relies on firstmate for steps a tool could take

This fixture is the opening line and the closing `## Proposed call` section of a real scout report, verbatim.

## Proposed call

How far should we move steps that depend on firstmate remembering them into the tools themselves?

- `gate` - Make missed steps impossible to miss, but automate none: the completion gates check for an unraised Proposed call, an open decision behind a `done:` line, and open keys on ships, and new drain sections list proposals, answered calls nobody followed up, and open sibling calls. Costs the least, mostly engine. Leaves every step a manual one, just one that firstmate can no longer skip without being told.
- `mechanical` - Everything in `gate`, and the tools also take the deterministic steps themselves: the app delivers reviews to a live author, a dated Not now becomes a deferral, an answer closes the status key it came from, the verdict intake gets its caller, promote sends its own steer, a PR's ready line arms the merge watch, and fm-send records who actually decided. A call is still raised by one firstmate command from the report. Costs a few engine verbs and app changes across findings 1 to 13 and 17, including a reader for text-only reports. Leaves a scout's call reaching the board only once firstmate has read the report, which is on purpose.
- `auto-raise` - Everything in `mechanical`, and a scout's Proposed call is also raised as soon as it reports done, with no firstmate step. Costs about the same as `mechanical`. A call can reach your board before firstmate has checked whether it is yours to answer, so some calls will need withdrawing.
- `policy` - Only tighten firstmate's instructions. Costs almost nothing. Leaves every gap in this report to memory, which is how each of the four failures happened.

Recommendation: `mechanical`.
It moves everything that is purely mechanical, and makes every step with a judged part impossible to skip silently.
It keeps the one check that is not mechanical: whether a scout's proposal is really the captain's to answer.
Whichever option you choose, the gate defect in finding 4 should be fixed.
