# What happens after the captain reviews a design page, and why "approved" did not start work

This fixture is the opening line and the closing `## Proposed call` section of a real scout report, verbatim.

## Proposed call

How far should the fix for "a page I asked for can be finished and forgotten" go?

- `full` - Fix the whole loop, together with `qd-review-orphan-1`: an unreviewed page keeps its task open and on your board, the verdict is recorded where the engine can read it, and an approval must be acted on by firstmate (promote or say why). Costs the largest change, in the engine and the app. Leaves chat-shared pages untracked, on purpose.
- `visible` - Only keep an unreviewed page's task open and on your board, and let a late review relaunch its author (covers the orphan). Costs about half. Leaves approval as prose: a build still starts only if firstmate acts on the message.
- `auto` - Everything in `full`, and approval also dispatches the build by itself without firstmate's turn. Costs the most, and spends tokens and picks a mode and brief without the first mate's judgement. Leaves nothing unanswered, but gives up control of when work starts.
- `policy` - No code; tighten firstmate's instructions so it does not close a task with an unread page and promotes on approval. Costs almost nothing. Leaves everything up to firstmate remembering, which is the part that failed today.

Recommendation: `full`.
It fixes the actual cause, the backlog not counting an unread page as waiting, instead of one symptom.
It closes the orphan task with it, and it keeps the first mate's judgement over what a build is while making sure an approval can no longer go unnoticed.
