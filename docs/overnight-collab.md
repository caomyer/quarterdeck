# The overnight collaboration branch

This branch is a proposal, not a shipment.
Nothing here has been merged to `main`, and several parts implement designs the captain has not yet reviewed.
Where that is true it is said so, in the commit that adds it and again below.

## Why this branch exists

The captain's words, 2026-09-27:

> I want you to improve yourself overnight.
> Right now, during our conversations, you really help me a lot, but still some frictions.

The frictions were then analysed against the records rather than from memory.
That distinction matters: firstmate's own first account of these two evenings was wrong in twenty places, and a scout corrected each one from the durable records before any of this was built.
The corrected account is `data/qd-collab-report-1/report.md`, and the root-cause work behind the largest change is `data/qd-approve-flow-1/report.md`.

## What the records actually showed

Across the evenings of 2026-09-25 and 2026-09-26, with seven pull requests merged:

- The captain asked firstmate for status five separate times.
  Each was him polling for something the workspace should have shown him.
- A revision he had asked for was presented, and firstmate then closed its task row.
  The app takes a closed row to mean the page has done its work, so an unread revision was filed under Settled thirteen minutes before he asked what had happened to it.
- Firstmate then briefed a build calling that page "the approved design".
  He had never opened it.
- Four of his reviews reached scouts that had already been retired.
  Each was answered by hand.
- A task held for his decision could not be worked on, so when what he wanted WAS work, he had to release the hold himself before a revision could be drawn.
- Two cards were restated three times, because each said something that had stopped being true.
- Nine possible-wedge wakes named six workers; at least five were ordinary long waits reported with the wrong word.
- Seven false "forge unavailable" alarms fired, every one about a merged pull request that read correctly on a direct check.

None of that is the captain's work.
All of it spends the attention that his work should have.

## What this branch changes

Each item links to the task that carries its evidence.

1. **A review verdict becomes state the engine can read** (`qd-on-approve-1`).
   Today a verdict reaches firstmate only as the first sentence of a chat message, so "Approved" starts nothing unless firstmate happens to act on it.
2. **An unreviewed page keeps waiting** (`qd-on-approve-1`).
   Closing a row no longer files a page the captain has not read.
3. **An approval cannot go unnoticed** (`qd-on-approve-1`).
   Outstanding approvals print on every wake until firstmate promotes the task or records why not.
   Approval deliberately does NOT dispatch work by itself: that would pick a mode, a harness and a brief with no judgement in the loop, and would spend tokens nobody chose to spend.
4. **A late review reaches someone, and a held task can still be worked** (`qd-on-approve-1`).
5. **The launch race is fixed** (`qd-on-noise-1`).
   A truncated launch left a shell at a quote prompt with no agent, twice, while the task read as in flight.
6. **The `paused:` guidance moves to where workers read it** (`qd-on-noise-1`).
   Four workers in one evening missed it in the middle of the longest rule; every one adopted it immediately when told.
7. **A dev instance anyone can bring up, and the first outside look at these flows** (`qd-on-devtest-1`).
8. **A task's artifacts, report and evidence in its own view** (`qd-on-taskview-1`).
   UNREVIEWED DESIGN: drawn as `task-list` rev 1 and deliberately left unbuilt because the captain had not reviewed it. It is built here so he can see it working. It is his to reject.

## How to review this

Read `docs/overnight-collab.md` first, then the two reports named above.
The changes are separable: each numbered item above is its own set of commits and can be taken or dropped on its own.

## What this branch does not do

It does not answer the captain's open call on `qd-approve-flow-1`.
That call asks how far the fix should go, and this branch shows what the recommended option looks like in working code so he can decide against evidence rather than against a description.
