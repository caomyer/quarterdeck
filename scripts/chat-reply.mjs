// Checks replying to a place in the chat, in every state the design mocked, in both themes, on the browser mock.
//
//   pnpm dev --port 4194 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4194 pnpm reply
//
// The mock (`?chat-reply`, src/host/mock-replies.ts) resumes the conversation the design was drawn from, with a fleet
// that knows the things it names. Every message the app sends is read back word for word through `window.__FM_SENT__`,
// and read with the app's own `splitReply`, so a check of the block is a check of what the first mate receives.
// Colours are compared with the theme's own tokens. Set REPLY_SHOTS=<folder> to also save screenshots of each state in
// both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { splitReply } from "../src/replyto.ts";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4194. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.REPLY_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

const VIS_TASK = "qd-nm-vis-build-1";
const GUARD_CALL = "nm-rebase-guard-1";
const HEADLINE = "Doing well - it's on the last step.";

async function open(query = "", width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("pageerror", (error) => failures.push(`${query}: ${error.message}`));
  await page.addInitScript(() => { window.__FM_SENT__ = []; });
  await page.goto(`${baseUrl}/?chat-reply${query}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  if (width < 700) await page.locator(".mobile-menu").click();
  await page.locator(".nav-item", { hasText: "Chat" }).click();
  await chat(page).locator(".mate-message", { hasText: HEADLINE }).waitFor();
  return page;
}

const themes = ["light", "dark"];
async function setTheme(page, theme) {
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
  await page.waitForTimeout(120);
}

/** The element's colour against a theme token, both resolved by the browser. */
async function paintedWith(locator, token, property = "color") {
  const page = locator.page();
  const want = await page.evaluate(([name, prop]) => {
    if (!getComputedStyle(document.documentElement).getPropertyValue(name).trim()) return null;
    const probe = document.createElement("span");
    probe.style[prop] = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe)[prop];
    probe.remove();
    return colour;
  }, [token, property]);
  if (!want) throw new Error(`${token} is not declared in this theme`);
  return (await locator.evaluate((element, prop) => getComputedStyle(element)[prop], property)) === want;
}

/** Nothing in the chat or the composer is wider than its column. */
async function fits(page) {
  return page.evaluate(() => [".chat-messages", ".composer"].every((selector) => {
    const box = document.querySelector(selector);
    if (!box) return true;
    const edge = box.getBoundingClientRect().right;
    return [...box.querySelectorAll(".reply-strip, .reply-strip *, .reply-header, .reply-header *, .thing-chips, .thing-chip")].every((element) => element.getBoundingClientRect().right <= edge + 0.5);
  }));
}

/** Checks a state in both themes, and saves its screenshot in each. */
async function inBothThemes(page, name, run = async () => {}) {
  for (const theme of themes) {
    await setTheme(page, theme);
    await run(theme);
    check(await fits(page), `${name}, ${theme}: nothing overflows the chat`);
    if (shots) await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

const chat = (page) => page.locator("[data-testid='chat-messages']");
const strip = (page) => page.locator("[data-testid='reply-strip']");
const composer = (page) => page.locator("textarea[aria-label='Message the first mate']");
const headline = (page) => chat(page).locator(".mate-message .markdown > p", { hasText: HEADLINE }).first();
const sent = (page) => page.evaluate(() => window.__FM_SENT__);
const lastSent = async (page) => (await sent(page)).at(-1);

/** Points at a place and clicks the arrow beside it. */
async function replyTo(page, place) {
  await place.scrollIntoViewIfNeeded();
  await place.hover();
  const arrow = page.locator("[data-testid='reply-arrow']");
  await arrow.waitFor();
  await arrow.click();
  await strip(page).waitFor();
}

async function send(page, words) {
  const before = (await sent(page)).length;
  await composer(page).fill(words);
  await composer(page).press("Enter");
  await page.waitForFunction((count) => window.__FM_SENT__.length > count, before);
  return lastSent(page);
}

/** The captain's latest message in the chat. */
const latestCaptain = (page) => chat(page).locator(".captain-message").last();

// A: the arrow beside a paragraph replies to it in one click. The paragraph names nothing and its message names one
// task by its PR, so the strip offers that task as named, not picked, and the block says exactly that.
{
  const page = await open();
  await headline(page).scrollIntoViewIfNeeded();
  await headline(page).hover();
  await page.locator("[data-testid='reply-arrow']").waitFor();
  check(await headline(page).evaluate((element) => element.classList.contains("reply-hot")), "the place under the pointer is marked as the one the arrow replies to");
  await inBothThemes(page, "a-hover", async (theme) => {
    check(await paintedWith(page.locator("[data-testid='reply-arrow']"), "--sea"), `${theme}: the arrow is drawn in --sea`);
  });
  await page.locator("[data-testid='reply-arrow']").click();
  await strip(page).waitFor();
  check(await composer(page).evaluate((element) => document.activeElement === element), "attaching a reply puts the caret in the draft");
  check((await strip(page).locator(".reply-strip-label").innerText()).startsWith("First Mate"), "the strip says whose place it is");
  check((await strip(page).locator(".reply-strip-quote").innerText()) === `“${HEADLINE}”`, "the strip quotes the paragraph, as drawn");
  const chips = strip(page).locator("[data-testid='thing-chip']");
  check(await chips.count() === 1 && await chips.first().getAttribute("data-thing") === `task:${VIS_TASK}`, "the one task its message names is offered");
  check((await chips.first().innerText()).includes("in flight · PR #32"), "with its state now and its PR");
  check(await chips.first().getAttribute("aria-pressed") === "false" && await chips.first().evaluate((element) => element.classList.contains("named")), "as named, not picked");
  await composer(page).fill("then why i saw it was on paused state? is that a stale state");
  await inBothThemes(page, "a-composer", async (theme) => {
    check(await paintedWith(strip(page), "--sea", "borderLeftColor"), `${theme}: the strip is edged in --sea`);
    check(await paintedWith(chips.first().locator(".thing-id"), "--ink"), `${theme}: a thing's id is in --ink`);
  });
  const text = await send(page, "then why i saw it was on paused state? is that a stale state");
  const read = splitReply(text);
  check(read !== null, "what went reads back as a reply the app wrote");
  check(read?.words === "then why i saw it was on paused state? is that a stale state", "the captain's words follow the block untouched");
  check(read?.reply.quote === HEADLINE && read.reply.around?.before === null, "the block quotes the paragraph, at the start of its message");
  check(/^on {8}your message from a resumed conversation, said before \d\d:\d\d, \d+ before this one, paragraph 1 of 4$/m.test(text), "on says whose message, when, how far back and which paragraph");
  check(read?.reply.meant === null && read.reply.named.length === 1 && read.reply.named[0].id === VIS_TASK, "the task goes as named, never meant, though it is the only one");
  check(/^named {5}task qd-nm-vis-build-1 "Pipeline status per task: who it waits on" · in flight · PR https:\/\/github\.com\/caomyer\/quarterdeck\/pull\/32 {2}\(named in the message, not in the quote: "PR #32"; the only thing it names; not picked\)$/m.test(text), "with its PR URL as the snapshot carries it, and why it was named");
  check(/^read at {3}\d\d:\d\d( yesterday| on \d{4}-\d\d-\d\d)? from the fleet snapshot$/m.test(text), "read at says when the fleet was read");
  check(!(await strip(page).count()), "sending clears the reply");
  const mine = latestCaptain(page);
  await mine.locator("[data-testid='reply-header']").waitFor();
  check(await mine.locator("[data-testid='reply-header']").getAttribute("data-found") === "true", "the sent message carries a header for a place still on screen");
  check(await mine.locator("[data-testid='reply-header'] .reply-header-who").innerText() === "First Mate:" && await mine.locator("[data-testid='reply-header'] .reply-header-quote").innerText() === `“${HEADLINE}”`, "the header names whose place and quotes it");
  check(await mine.locator(".captain-words").innerText() === "then why i saw it was on paused state? is that a stale state", "the bubble shows only the captain's words");
  check(await mine.locator("[data-testid='thing-chip']").count() === 1, "the thing it named shows under the bubble");
  await inBothThemes(page, "a-sent");
  await chat(page).evaluate((element) => { element.scrollTop = 0; });
  await mine.locator("[data-testid='reply-header']").click();
  await page.waitForTimeout(200);
  check(await chat(page).locator(".reply-flash").count() === 1 && (await chat(page).locator(".reply-flash").innerText()) === HEADLINE, "clicking the header brings the place back and outlines it");
  await page.close();
}

// B: tapping a chip makes the thing meant, and the block says the captain picked it.
{
  const page = await open();
  await replyTo(page, headline(page));
  const chip = strip(page).locator("[data-testid='thing-chip']").first();
  await chip.click();
  check(await chip.getAttribute("aria-pressed") === "true" && await chip.evaluate((element) => element.classList.contains("meant")), "a tapped chip is the captain's pick");
  await inBothThemes(page, "b-picked", async (theme) => {
    check(await paintedWith(chip, "--sea", "borderTopColor"), `${theme}: a picked thing is edged in --sea`);
  });
  const text = await send(page, "is this one stale?");
  check(/^meant {5}task qd-nm-vis-build-1 .* {2}\(the captain picked it\)$/m.test(text) && !/^named /m.test(text), "the pick goes as meant, with nothing left named");
  await page.close();
}

// C: selected words in a list item narrow the place to a span.
{
  const page = await open();
  const item = chat(page).locator(".mate-message .markdown li", { hasText: "how far to fix the approval loop" }).first();
  await item.scrollIntoViewIfNeeded();
  const span = "Partly overtaken by events";
  await item.evaluate((element, words) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(words);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + words.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
  }, span);
  const button = page.locator("[data-testid='reply-to-selection']");
  await button.waitFor();
  await inBothThemes(page, "c-selection");
  await button.click();
  await strip(page).waitFor();
  check((await strip(page).locator(".reply-strip-label").innerText()).includes("item 2"), "the strip says which item the words are in");
  check((await strip(page).locator(".reply-strip-quote").innerText()) === `“${span}”`, "the strip quotes exactly the selected words");
  const named = await strip(page).locator("[data-testid='thing-chip']").evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-thing")));
  check(named.length === 1 && named[0] === "call:qd-approve-flow-1", "the words name nothing, so the item they are in is read next, not the whole message");
  check(!named.some((thing) => thing.includes("overnight-collab")), "a branch the snapshot does not know gets no chip");
  await inBothThemes(page, "c-composer");
  const text = await send(page, "ok close this one as overtaken");
  const read = splitReply(text);
  check(read?.reply.selected === true && read.reply.quote === span, "the block marks the quote as a span the captain selected");
  check(/^on {8}your message .*, item 2 of 3$/m.test(text), "and says which item it is in");
  check(read?.reply.around?.after?.startsWith(": the determinism work"), "with the words that follow it");
  check(/^named {5}call qd-approve-flow-1 .*\(named in the item the quote is in, not in the quote: "qd-approve-flow-1"; the only thing it names; not picked\)$/m.test(text), "and says the call was named in the item, not in the words");
  await page.close();
}

// D: a card is a place that is one thing, so it goes as meant without a tap.
{
  const page = await open();
  const card = chat(page).locator(`[data-testid='call-card'][data-call-id='${GUARD_CALL}']`);
  await card.scrollIntoViewIfNeeded();
  await card.locator(".call-chat-kicker").hover();
  await page.locator("[data-testid='reply-arrow']").click();
  await strip(page).waitFor();
  const chips = strip(page).locator("[data-testid='thing-chip']");
  check(await chips.count() === 1 && await chips.first().getAttribute("data-thing") === `call:${GUARD_CALL}` && await chips.first().evaluate((element) => element.classList.contains("meant")), "the card's call is meant, filled, with nothing to tap");
  check(!(await strip(page).locator(".thing-hint").count()), "and no hint to tap");
  await inBothThemes(page, "d-card");
  const text = await send(page, "why is this still open, didn't we agree last week?");
  check(/^on {8}the call card for nm-rebase-guard-1, raised /m.test(text), "on names the card");
  check(/^meant {5}call nm-rebase-guard-1 ".*" · open · recommended merge-and-upstream {2}\(a card is the thing itself\)$/m.test(text), "meant is the card's call, as the snapshot reads it now");
  check(!/^around /m.test(text), "a card has nothing around it");
  await latestCaptain(page).locator("[data-testid='reply-header']").waitFor();
  check(await latestCaptain(page).locator("[data-testid='reply-header']").getAttribute("data-found") === "true" && (await latestCaptain(page).locator("[data-testid='reply-header']").innerText()).startsWith("Call card:"), "the sent reply's header finds the card");
  await page.close();
}

// E: R replies to the place under the pointer; Esc and × take the reply off.
{
  const page = await open();
  await headline(page).scrollIntoViewIfNeeded();
  await headline(page).hover();
  await page.locator("[data-testid='reply-arrow']").waitFor();
  await page.keyboard.press("r");
  await strip(page).waitFor();
  check(await composer(page).inputValue() === "", "R attaches the reply without typing an r");
  await composer(page).press("Escape");
  check(!(await strip(page).count()), "Esc in the draft takes the reply off");
  await replyTo(page, headline(page));
  await strip(page).locator(".reply-strip-remove").click();
  check(!(await strip(page).count()), "× takes the reply off");
  await composer(page).fill("r");
  check(await composer(page).inputValue() === "r", "typing r in the draft is a letter");
  await page.close();
}

// F: a slash command cannot carry a reply, so the composer refuses before anything is sent.
{
  const page = await open();
  await replyTo(page, headline(page));
  await composer(page).fill("/compact");
  const refused = page.locator("[data-testid='reply-refused']");
  await refused.waitFor();
  check((await refused.innerText()).includes("/compact goes to Claude Code, not the first mate, so a reply can't go with it."), "the strip says why the reply cannot go");
  check(await page.locator(".send-button").isDisabled(), "Send is off while it cannot");
  const count = (await sent(page)).length;
  await composer(page).press("Enter");
  await page.waitForTimeout(300);
  check((await sent(page)).length === count, "Enter sends nothing");
  await inBothThemes(page, "f-command", async (theme) => {
    check(await paintedWith(refused, "--coral"), `${theme}: the refusal is in --coral`);
  });
  await refused.getByRole("button", { name: "Keep the reply, edit the message" }).click();
  check(await strip(page).count() === 1 && await composer(page).evaluate((element) => document.activeElement === element), "keeping the reply leaves it on and the caret in the draft");
  await refused.getByRole("button", { name: "Send without the reply" }).click();
  await page.waitForFunction((before) => window.__FM_SENT__.length > before, count);
  check(await lastSent(page) === "/compact", "sending without the reply sends the command alone");
  check(!(await strip(page).count()), "and the reply is gone");
  await page.close();
}

// G: when the fleet could not be read, the strip warns before sending, and the block says nothing was checked.
{
  const page = await open("=fleet-failed");
  await replyTo(page, headline(page));
  const warn = strip(page).locator("[data-testid='fleet-unread']");
  check(await warn.count() === 1 && (await warn.innerText()) === "Fleet not read: things named here can't be checked", "the strip warns that nothing it names can be checked");
  check(!(await strip(page).locator("[data-testid='thing-chip']").count()), "and offers no thing");
  await inBothThemes(page, "g-unread", async (theme) => {
    check(await paintedWith(warn, "--coral"), `${theme}: the warning is in --coral`);
  });
  const text = await send(page, "go with your rec on this");
  check(/^named {5}could not be read: the fleet snapshot failed at \d\d:\d\d \(fm-fleet-snapshot\.sh exited with exit status: 1: jq: error/m.test(text), "the block says the fleet could not be read, when, and why");
  check(!/^read at /m.test(text) && splitReply(text)?.reply.quote === HEADLINE, "the quote still goes, with no read time");
  await page.close();
}

// H: replies the conversation already carries, as a relaunch brings them back.
{
  const page = await open();
  const headers = chat(page).locator(".captain-message [data-testid='reply-header']");
  check(await headers.count() === 3, "every sent reply in the history shows its header");
  const found = chat(page).locator(".captain-message", { hasText: "then why i saw it was on paused state" }).first();
  check(await found.locator("[data-testid='reply-header']").getAttribute("data-found") === "true", "a place still on screen is found by its words");
  const gone = chat(page).locator(".captain-message", { hasText: "did the two blocked crews actually restart?" });
  check(await gone.locator("[data-testid='reply-header']").getAttribute("data-found") === "false", "a place no longer in the chat is said to be gone");
  check((await gone.locator("[data-testid='reply-header']").innerText()).includes("#34 is merged. origin/main is now 530d91b and CI is deterministic again.") && (await gone.innerText()).includes("Not in this chat any more"), "and shows its own quote instead of pointing anywhere");
  check((await gone.locator("[data-testid='thing-chip']").innerText()).includes("closed, older than the board shows · in flight when you replied"), "a task gone from the board says so, and what it was when replied to");
  const recorded = chat(page).locator(".captain-message", { hasText: "ok close this one as overtaken, the det work covers it" });
  const chip = recorded.locator("[data-testid='thing-chip']");
  check((await chip.innerText()).includes("recorded = overtaken since · open when you replied") && await chip.evaluate((element) => element.classList.contains("meant")), "a picked call recorded since shows both states, as meant");
  check(await recorded.locator("[data-testid='reply-header']").getAttribute("data-found") === "true", "words selected inside a list item are found again by their words");
  await recorded.locator("[data-testid='reply-header']").click();
  await page.waitForTimeout(200);
  check((await chat(page).locator(".reply-flash").evaluate((element) => element.tagName)) === "LI" && (await chat(page).locator(".reply-flash").innerText()).includes("how far to fix the approval loop"), "and lead to the item they are in");
  const raw = chat(page).locator(".captain-message", { hasText: "on        your mess" });
  check(await raw.count() === 1 && !(await raw.locator("[data-testid='reply-header']").count()), "a block cut short is shown as the raw words that went, never half read");
  const mate = chat(page).locator("[data-testid='mate-reply-header']");
  check(await mate.count() === 2, "the first mate's quote lines that match the captain's words exactly become headers");
  check((await chat(page).locator(".mate-message", { hasText: "The onboarding review waits" }).innerText()).includes("↩ \"how is the onboarding review going\""), "one that matches nothing is drawn as written");
  await page.waitForFunction(() => !document.querySelector(".reply-flash"));
  await mate.first().click();
  await page.waitForTimeout(200);
  check((await chat(page).locator(".reply-flash").innerText()).startsWith("still have a decision call waiting on pr 26"), "a header the first mate wrote leads to the captain's message it answers");
  await gone.scrollIntoViewIfNeeded();
  await inBothThemes(page, "h-history", async (theme) => {
    check(await paintedWith(gone.locator(".reply-header small"), "--muted"), `${theme}: the gone note is in --muted`);
  });
  await mate.first().scrollIntoViewIfNeeded();
  await inBothThemes(page, "h-mate-replies");
  await page.close();
}

// I: a reply in a message that did not go through stays with it, and Send again sends the same words.
{
  const page = await open("&failed");
  await replyTo(page, headline(page));
  const first = await send(page, "then why i saw it was on paused state?");
  const mine = latestCaptain(page);
  await mine.locator(".message-error").waitFor({ timeout: 15_000 });
  check((await mine.locator("[data-testid='reply-resend-note']").innerText()) === "Send again goes with the same reply.", "a failed reply says Send again carries it");
  await mine.scrollIntoViewIfNeeded();
  await inBothThemes(page, "i-failed");
  await mine.getByRole("button", { name: "Send again" }).click();
  await page.waitForFunction(() => window.__FM_SENT__.length >= 2);
  check((await sent(page)).at(-1) === first, "Send again sends the same text, reply and all");
  await page.close();
}

// J: a narrow window keeps the strip, its chips and the headers inside the column.
{
  const page = await open("", 420);
  await replyTo(page, headline(page));
  await composer(page).fill("then why i saw it was on paused state? is that a stale state");
  await inBothThemes(page, "j-narrow");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nEvery reply state holds in both themes.");
