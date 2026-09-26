// Checks what a call shows once the captain has replied to it in words, in both themes, on the browser mock.
//
//   pnpm dev --port 4193 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4193 pnpm replies
//
// Words, a dated Not now, or an option a call cannot take by key are the captain's reply: firstmate's own
// `bin/fm-captain-hold.sh reply` keeps them on the call, and the card draws them from the snapshot, amber, until the
// first mate records an answer or asks again. The mock models `reply` the way the script does it (src/host/mock.ts,
// `keepReply`), so each state here is one the engine produces: amber replied, coral refused, amber not told, green
// recorded, asked again, and after a reload. Colours are compared with the theme's own tokens.
// Set REPLY_SHOTS=<folder> to also save screenshots of each state in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4193. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.REPLY_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

/** The call nothing argues: options, no page, as qd-start-work-1 was when the captain's words on it were lost. */
const UNARGUED = "foreman-auto-merge";
const WORDS = "It doesn't make sense that it can't merge on its own, right? It did last week.";

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => failures.push(`${query}: ${error.message}`));
  await page.goto(`${baseUrl}/?artifacts${query}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(`.decision-card[data-call-id='${UNARGUED}']`).waitFor();
  return page;
}

const themes = ["light", "dark"];
async function setTheme(page, theme) {
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
  await page.waitForTimeout(120);
}

/** The element's colour against a theme token, both resolved by the browser. */
async function paintedWith(locator, token) {
  const page = locator.page();
  const want = await page.evaluate((name) => {
    if (!getComputedStyle(document.documentElement).getPropertyValue(name).trim()) return null;
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
  if (!want) throw new Error(`${token} is not declared in this theme`);
  return (await locator.evaluate((element) => getComputedStyle(element).color)) === want;
}

/** Checks the tone in both themes, and saves the state's screenshot in each, with `subject` scrolled into view. */
async function inBothThemes(page, name, run, subject) {
  for (const theme of themes) {
    await setTheme(page, theme);
    await run(theme);
    if (shots) {
      await subject?.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
    }
  }
  await setTheme(page, "light");
}

const captainsCall = (page) => page.locator(".dashboard-section", { hasText: "Captain's call" }).locator(".section-count");
const bearingsBadge = (page) => page.locator(".nav-item", { hasText: "Bearings" }).locator("em");

async function typeWords(card, words) {
  await card.locator(".reply-field textarea").fill(words);
}

async function captainMessages(page) {
  await page.locator(".nav-item", { hasText: "Chat" }).click();
  const texts = await page.locator(".captain-message").allInnerTexts();
  await page.locator(".nav-item", { hasText: "Bearings" }).click();
  return texts;
}

// Words on a call with options and no page: kept on the call, amber from the snapshot, and never green before the
// first mate records them, however long the first mate takes to read the message.
{
  const page = await open("");
  const card = page.locator(`.decision-card[data-call-id='${UNARGUED}']`);
  const before = Number(await captainsCall(page).innerText());
  await typeWords(card, WORDS);
  check((await card.locator(".decision-actions > span").innerText()) === `→ keeps your words on the call for the first mate: ${WORDS}`, "the card says the words are kept on the call, not sent as chat");
  await card.locator(".decision-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='call-replied']").waitFor();
  check(await card.getAttribute("data-replied") === "true", "the card reads the reply from the call");
  check((await card.locator("[data-testid='call-replied'] strong").innerText()) === "With the first mate · not recorded yet", "it says the reply is with the first mate and not recorded");
  check((await card.locator("[data-testid='call-said']").innerText()).startsWith("You said, ") && (await card.locator("[data-testid='call-said']").innerText()).endsWith(`: ${WORDS}`), "it shows the captain's words and when he said them");
  check(await card.locator(".reply-field textarea").inputValue() === "", "the field is empty, the words are on the call");
  check(Number(await captainsCall(page).innerText()) === before - 1, "a replied call no longer counts as waiting on the captain");
  check(Number(await bearingsBadge(page).innerText()) === before - 1, "nor in the sidebar");
  // The mock's first mate reads the message within a few seconds; reading it is not answering it.
  const deadline = Date.now() + 4000;
  let green = false;
  while (Date.now() < deadline) {
    green ||= await card.evaluate((element) => element.classList.contains("call-tone-green") || Boolean(element.querySelector(".tone-green, .lucide-check")));
    await page.waitForTimeout(250);
  }
  check(!green, "the card never goes green while nothing has recorded the reply, read or not");
  check(await card.locator("[data-testid='call-replied']").count() === 1, "it is still amber after the first mate read the message");
  // No locking: every answer is still offered, with what he said above it.
  check(await card.locator(".suggestion-chips button:not(:disabled)").count() === 3 && await card.locator(".reply-field textarea").isEditable(), "every way to answer is still there on the amber card");
  await inBothThemes(page, "reply-amber", async (theme) => {
    check(await paintedWith(card.locator("[data-testid='call-replied']"), "--amber"), `${theme}: a reply is painted --amber`);
  }, card);
  const told = await captainMessages(page);
  const message = told.find((text) => text.includes(`The captain replied to call ${UNARGUED} from Bearings`));
  check(Boolean(message), "the first mate is told, naming the call id");
  check(Boolean(message?.includes("nothing has recorded it")) && Boolean(message?.includes(WORDS)), "the message says nothing has recorded it, with the words");
  check(!told.some((text) => text.includes("On the foreman auto merge")), "no bare chat with a name nothing can find");

  // A keyed answer on the amber card records normally, and the call leaves with the reply cleared.
  await card.locator(".suggestion-chips button", { hasText: "Hold every PR for me" }).click();
  check((await card.locator(".decision-actions button").last().innerText()) === "Record answer", "an option on the amber card is recorded, not replied");
  await card.locator(".decision-actions button", { hasText: "Record answer" }).click();
  const recorded = page.locator(`.decision-card[data-call-id='${UNARGUED}'][data-recorded='true']`);
  await recorded.waitFor();
  await inBothThemes(page, "reply-recorded", async (theme) => {
    check(await paintedWith(recorded.locator(".call-state"), "--green"), `${theme}: a recorded answer is painted --green`);
  }, recorded);
  await card.waitFor({ state: "detached" });
  check(true, "recorded, the call leaves Captain's call");
  await page.close();
}

// A dated Not now typed on a card lands exactly the way words do.
{
  const page = await open("");
  const card = page.locator(`.decision-card[data-call-id='${UNARGUED}']`);
  await card.locator(".suggestion-chips button", { hasText: "Not now" }).click();
  await card.locator(".date-field input").fill("2026-10-03");
  check((await card.locator(".decision-actions > span").innerText()) === "→ keeps your words on the call for the first mate: Not now. Ask me again on Oct 3.", "a dated Not now is kept on the call like words");
  await card.locator(".decision-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='call-replied']").waitFor();
  check((await card.locator("[data-testid='call-said']").innerText()).endsWith(": Not now. Ask me again on Oct 3."), "the Not now shows as what he said");
  const told = await captainMessages(page);
  check(told.some((text) => text.includes(`The captain replied to call ${UNARGUED} from Bearings`) && text.includes("Not now. Ask me again on Oct 3.")), "the Not now reaches the first mate naming the call");
  // Saying something else replaces it, and what he said before stays in view.
  await typeWords(card, "Actually, keep merging.");
  await card.locator(".decision-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='call-said-before']").waitFor();
  check((await card.locator("[data-testid='call-said']").innerText()).endsWith(": Actually, keep merging.") && (await card.locator("[data-testid='call-said-before']").innerText()).endsWith(": Not now. Ask me again on Oct 3."), "a later reply replaces the earlier one, which stays as what he said before");
  await page.close();
}

// Refused: firstmate would not keep it, so nothing is sent and the words stay where he wrote them.
{
  const page = await open(`&reply-refused=${UNARGUED}`);
  const card = page.locator(`.decision-card[data-call-id='${UNARGUED}']`);
  const sentBefore = (await captainMessages(page)).length;
  await typeWords(card, WORDS);
  await card.locator(".decision-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='reply-refused']").waitFor();
  check((await card.locator("[data-testid='reply-refused'] strong").innerText()) === "Not sent: your reply could not be kept on the call", "a refused reply says it was not sent");
  check((await card.locator("[data-testid='reply-refused'] small").innerText()) === `call ${UNARGUED} is already closed`, "with firstmate's own reason");
  check(await card.locator(".reply-field textarea").inputValue() === WORDS, "the words stay in the field");
  check(await card.getAttribute("data-replied") === null, "a refused reply is not shown as kept");
  await inBothThemes(page, "reply-refused", async (theme) => {
    check(await paintedWith(card.locator("[data-testid='reply-refused']"), "--coral"), `${theme}: a refused reply is painted --coral`);
  }, card);
  check((await captainMessages(page)).length === sentBefore, "nothing reached the first mate");
  await page.close();
}

// Kept, but the message could not go: amber, and the first mate finds it on the call when it starts.
{
  const page = await open("&reply-not-told");
  const card = page.locator(`.decision-card[data-call-id='${UNARGUED}']`);
  const sentBefore = (await captainMessages(page)).length;
  await typeWords(card, WORDS);
  await card.locator(".decision-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='call-replied']").waitFor();
  check(await card.locator("[data-testid='call-replied']").getAttribute("data-told") === "false", "the reply is kept, and the card knows no message carried it");
  check((await card.locator("[data-testid='call-replied'] small").innerText()).includes("sees it on the call when it starts"), "it says the first mate sees it on the call when it starts");
  check((await captainMessages(page)).length === sentBefore, "no message went");
  await inBothThemes(page, "reply-not-told", async (theme) => {
    check(await paintedWith(card.locator("[data-testid='call-replied']"), "--amber"), `${theme}: kept but not told is still --amber`);
  }, card);
  await page.close();
}

// After a reload, or a relaunch, the reply is read from firstmate's record, not from anything the window remembered.
for (const [flag, told] of [["replied", true], ["replied-untold", false]]) {
  const page = await open(`&${flag}=${UNARGUED}`);
  const card = page.locator(`.decision-card[data-call-id='${UNARGUED}']`);
  await card.locator("[data-testid='call-replied']").waitFor();
  check((await card.locator("[data-testid='call-said']").innerText()).endsWith(": Why can't it merge on its own? It did last week."), `after a reload (${flag}), the card shows the reply the home carries`);
  check(await card.locator("[data-testid='call-replied']").getAttribute("data-told") === String(told), `after a reload (${flag}), it says whether a message carried it`);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await card.locator("[data-testid='call-replied']").waitFor();
  check(true, `the reply is still there after another reload (${flag})`);
  if (told) {
    await inBothThemes(page, "reply-after-reload", async (theme) => {
      check(await paintedWith(card.locator("[data-testid='call-replied']"), "--amber"), `${theme}: after a reload the reply is --amber`);
    }, card);
  }
  await page.close();
}

// The first mate acts on the reply: it asks again, and the call waits on the captain once more; or it records it.
{
  const page = await open("&reasks");
  const card = page.locator(`.decision-card[data-call-id='${UNARGUED}']`);
  const before = Number(await captainsCall(page).innerText());
  await typeWords(card, WORDS);
  await card.locator(".decision-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='call-replied']").waitFor();
  await card.locator("[data-testid='call-replied']").waitFor({ state: "detached", timeout: 8000 });
  check((await card.locator("[data-testid='decision-reason']").innerText()).endsWith("(asked again after your reply)"), "asked again, the card shows the new question");
  check(await card.getAttribute("data-replied") === null && Number(await captainsCall(page).innerText()) === before, "and the call waits on the captain again");
  await inBothThemes(page, "reply-reasked", async () => {}, card);
  await page.close();
}
{
  const page = await open("&records-reply");
  const card = page.locator(`.decision-card[data-call-id='${UNARGUED}']`);
  await typeWords(card, WORDS);
  await card.locator(".decision-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='call-replied']").waitFor();
  await card.waitFor({ state: "detached", timeout: 8000 });
  check(true, "recorded by the first mate, the call leaves Captain's call");
  await page.close();
}

// Words sent in a page's review are the same reply: Bearings and the rail show the same amber, and the page's
// standing in the list is the first mate's move, not the captain's.
{
  const page = await open("");
  const openPage = async (title) => {
    await page.locator(".nav-item", { hasText: "Artifacts" }).click();
    await page.locator(".artifact-list .artifact-row", { hasText: title }).click();
    await page.locator("[data-testid='decision-answer']").first().waitFor();
  };
  const reportTitle = "Which episodes already carry a transcript?";
  await openPage(reportTitle);
  const railCall = page.locator("[data-testid='decision-answer'][data-call-id='res-transcripts-source']");
  await railCall.locator(".reply-field textarea").fill("Publisher first, but log every episode we had to transcribe.");
  await railCall.locator(".decision-staged", { hasText: "for the first mate to record" }).waitFor();
  await page.locator(".send-review").click();
  await railCall.locator("[data-testid='call-replied']").waitFor();
  check((await railCall.locator("[data-testid='answer-earlier']").innerText()).startsWith("You said in your review, ") && (await railCall.locator("[data-testid='answer-earlier']").innerText()).endsWith(": Publisher first, but log every episode we had to transcribe."), "the rail shows the reply firstmate keeps");
  await inBothThemes(page, "reply-rail", async (theme) => {
    check(await paintedWith(railCall.locator("[data-testid='call-replied']"), "--amber"), `${theme}: the rail's reply is --amber`);
  }, railCall);
  await page.locator(".nav-item", { hasText: "Chat" }).click();
  const review = await page.locator("[data-testid='review-card']").last().locator(".review-card-text pre").textContent();
  check(review.includes("Answered in words, kept on each call as the captain's reply; nothing has recorded them.") && review.includes("\nres-transcripts-source: Publisher first, but log every episode we had to transcribe."), "the review tells the first mate the words are kept on the call and unrecorded");
  await page.locator(".nav-item", { hasText: "Bearings" }).click();
  const card = page.locator(".decision-card[data-call-id='res-transcripts-source']");
  await card.locator("[data-testid='call-replied']").waitFor();
  check((await card.locator("[data-testid='call-said']").innerText()).startsWith("You said in your review of “Which episodes already carry a transcript?”, "), "Bearings shows the same reply, and the review it went in");
  check(await card.locator("button", { hasText: "Answer now" }).count() === 1, "and still offers every way to answer it");
  await inBothThemes(page, "reply-from-review", async () => {}, card);
  await page.locator(".nav-item", { hasText: "Artifacts" }).click();
  const row = page.locator(".artifact-row", { hasText: reportTitle });
  check(await page.locator(".artifact-group[data-standing='discussion'] .artifact-row", { hasText: reportTitle }).count() === 1, `a read page whose only call has the captain's reply is in discussion, not open for review (${await row.count()})`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nA reply is kept on its call, and every card state reads it from there.");
