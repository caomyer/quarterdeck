# Replies in Quarterdeck chat

In Quarterdeck the captain can reply to a place in the chat: a paragraph, a list item, a card, or words they selected.
The app then writes a block before the captain's words, so you know which place they mean and what it names.
Quarterdeck's `src/replyto.ts` is the only writer of the block, and its `src/fixtures/reply-block.json` pins the example below, so this page and the app cannot drift apart.

## The block

The real reply that prompted the feature, as you receive it:

```text
↩ The captain is replying to a place in this chat. It comes first; the captain's words follow the rule.
on        your message of 22:04, 1 before this one, paragraph 1 of 4
quote     "Doing well - it's on the last step."
around    (start of your message) ▸here◂ "Eight of nine pipeline steps are complete on the merged head: intent, rebase,…"
named     task qd-nm-vis-build-1 "Pipeline status per task: who it waits on" · in flight · PR https://github.com/caomyer/quarterdeck/pull/32  (named in the message, not in the quote: "PR #32"; the only thing it names; not picked)
read at   22:07 from the fleet snapshot
──
then why i saw it was on paused state? is that a stale state
```

Every line states something the app captured, never its reading of what the captain meant.

- `on` says whose message the place is in (`your message` is yours, `the captain's own message` is theirs), when it was said on the captain's clock, how many messages and cards back it sits, and which paragraph or item it is; for a card it names the card and the call or page it is.
- `quote` is the place's words as the chat drew them, cut at 240 characters with `(cut at 240 of N characters)` when longer, and marked `(a span the captain selected)` when the captain selected words rather than a whole block.
- `around` is up to 80 characters on each side of the place in the same message, or `(start of …)` and `(end of …)` where the place reaches an end; a card has none.
- `meant` appears at most once: the thing the captain picked, `(the captain picked it)`, or the card they replied to, `(a card is the thing itself)`.
- `named` is one line for every other task, call or page the snapshot knows that the place names, with the exact words that named it and where they are.
  When selected words name none, the block they are in is read next, and when the place names none, the rest of its message.
  A thing is never `meant` because it was the only one found.
  `named  could not be read: …` means the fleet snapshot failed, so nothing the place names was checked.
- Each thing reads `kind id "title" · state`, with a task's PR URL exactly as the snapshot carries it.
- `read at` says when those states were read from the fleet snapshot, so you know how old they are.
- The `──` rule ends the block, and everything after it is the captain's words, untouched, with any attached-files block last.

Only exact ids, PR numbers or URLs, and page names or titles become things; a description such as "the gate fix" never does.

## How to act on it

[`AGENTS.md`](../AGENTS.md) section 3 owns how to act on a reply: which line is the referent, and when to confirm it before acting on work.

## Replying to one of the captain's messages

`AGENTS.md` section 3 also owns when you open a reply with `↩ "<the captain's words, verbatim>"`.
Quarterdeck draws that first line as a link to the captain's message only when the quote is the message, or a span of it, word for word, taking the latest such message; a paraphrase or an ellipsis shows as the line you wrote.
