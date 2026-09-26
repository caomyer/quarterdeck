// Checks a call's two cards in the chat, in every state the design mocked (A to K), in both themes, on the browser mock.
//
//   pnpm dev --port 4194 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4194 pnpm calls
//
// A call is drawn where the first mate raised it, by its raised_at, and an answer where the captain gave it. Both are
// built from calls[] and the app's own answer lines. The mock's first mate acts on calls only the way
// `bin/fm-captain-hold.sh` does (`?chat-calls`, `chatCallsTurn` in src/host/mock.ts): `hold` stamps raised_at and
// updated_at together, `offer` moves updated_at alone, a hold on released work moves raised_at, and a hold until a day
// moves neither. Nothing here moves a time itself. Colours are compared with the theme's own tokens.
// Set CALL_SHOTS=<folder> to also save screenshots of each state in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4194. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.CALL_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

/** The call the mock's first mate raises in chat when asked, and the call the home already carries that nothing argues. */
const RAISED = "foreman-wifi-uploads";
const UNARGUED = "foreman-auto-merge";
const ARGUED = "res-model-download";
const OFFERED = "res-model-cellular";

async function open(query = "", width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("pageerror", (error) => failures.push(`${query}: ${error.message}`));
  await page.goto(`${baseUrl}/?artifacts&chat-calls${query}`);
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

/** Nothing on the chat is wider than the chat, in either theme. */
async function fits(page) {
  return page.locator("[data-testid='chat-messages']").evaluate((list) => {
    const edge = list.getBoundingClientRect().right;
    return [...list.querySelectorAll(".call-chat-card, .answer-chat-card, .call-chat-card *, .answer-chat-card *")].every((element) => element.getBoundingClientRect().right <= edge + 0.5);
  });
}

/** Checks a state in both themes, and saves its screenshot in each. */
async function inBothThemes(page, name, run) {
  for (const theme of themes) {
    await setTheme(page, theme);
    await run(theme);
    check(await fits(page), `${name}, ${theme}: nothing overflows the chat`);
    if (shots) await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

const chat = (page) => page.locator("[data-testid='chat-messages']");
const callCard = (page, id = RAISED) => chat(page).locator(`[data-testid='call-card'][data-call-id='${id}']`);
const answerCards = (page, id = RAISED) => chat(page).locator(`[data-testid='answer-card'][data-call-id='${id}']`);

async function toChat(page) {
  await page.locator(".nav-item", { hasText: "Chat" }).click();
  await chat(page).waitFor();
}

async function toBearings(page) {
  await page.locator(".nav-item", { hasText: "Bearings" }).click();
  await page.locator(".dashboard-section", { hasText: "Captain's call" }).waitFor();
}

/** Asks the mock's first mate for one `fm-captain-hold.sh` act, and waits for its turn to end. */
async function ask(page, words) {
  const composer = page.locator("textarea[aria-label='Message the first mate']");
  await composer.fill(words);
  await composer.press("Enter");
  await chat(page).locator(".mate-message").last().filter({ hasNotText: "…" }).waitFor();
  await page.waitForFunction(() => document.querySelector(".chat-status")?.textContent?.includes("Ready") ?? true);
  await page.waitForTimeout(3600);
}

/**
 * Where each item of the chat sits, top to bottom: `call:<id>`, `answer:<id>`, `captain:<first words>`,
 * `mate:<first words>`, `steps`, `page`.
 */
async function order(page) {
  return chat(page).evaluate((list) => [...list.children].map((element) => {
    if (element.matches("[data-testid='call-card']")) return `call:${element.getAttribute("data-call-id")}`;
    if (element.matches("[data-testid='answer-card']")) return `answer:${element.getAttribute("data-call-id")}`;
    if (element.matches(".captain-message")) return `captain:${element.querySelector("p")?.textContent?.slice(0, 24) ?? ""}`;
    if (element.matches(".mate-message")) return `mate:${element.querySelector(".markdown")?.textContent?.slice(0, 24) ?? ""}`;
    if (element.matches(".step-group")) return "steps";
    if (element.matches("[data-testid='artifact-card']")) return "page";
    return element.className.split(" ")[0];
  }));
}

// A: raised in chat, the call is a card where it was raised, above the first mate's words about it, with every way to
// answer; nothing is read from those words.
{
  const page = await open();
  await toChat(page);
  await ask(page, "What needs me?");
  const card = callCard(page);
  await card.waitFor();
  const items = await order(page);
  const asked = items.findIndex((item) => item.startsWith("captain:What needs me"));
  const at = items.indexOf(`call:${RAISED}`);
  const explained = items.findIndex((item) => item.startsWith("mate:Captain, one thing"));
  check(asked >= 0 && at > asked && at < explained, `the card sits after the question and above the first mate's explanation (${items.join(", ")})`);
  check(await card.getAttribute("data-standing") === "open", "it is open");
  check((await card.locator(".call-chat-kicker").innerText()).toLowerCase().includes("foreman · raised"), "it names the project and when it was raised");
  check(await card.locator(".suggestion-chips button").count() === 3 && await card.locator(".reply-field textarea").isEditable(), "the options, Not now and words, as Bearings offers them");
  await card.locator(".suggestion-chips button", { hasText: "Wait for Wi-Fi" }).click();
  check((await card.locator("[data-testid='call-hint']").innerText()) === "→ records: Wait for Wi-Fi", "choosing an option says what Record answer does");
  await inBothThemes(page, "a-open", async (theme) => {
    check(await paintedWith(card.locator(".call-chat-kicker"), "--coral"), `${theme}: a call waiting on the captain is marked --coral`);
  });
  await page.close();
}

// D: recorded from the chat card, through the intake Bearings uses. The card shrinks where it is to the choice, and the
// captain's answer message becomes an answer card where he gave it. Bearings reads the same standing.
{
  const page = await open();
  await toChat(page);
  await ask(page, "What needs me?");
  const card = callCard(page);
  await card.locator(".suggestion-chips button", { hasText: "Wait for Wi-Fi" }).click();
  await card.locator(".reply-field textarea").fill("Revisit when I'm back on Monday.");
  await card.locator(".call-chat-actions button", { hasText: "Record answer" }).click();
  await card.locator(".call-chat-line").waitFor();
  const before = await order(page);
  check(await card.getAttribute("data-standing") === "recorded", "answered, the card says it is recorded");
  check((await card.locator(".call-chat-line").innerText()).includes("you chose Wait for Wi-Fi"), "it names the choice on one line");
  await card.locator(".call-chat-options summary").click();
  check((await card.locator(".call-chat-options li.picked").innerText()) === "Wait for Wi-Fi" && await card.locator(".call-chat-options li").count() === 2, "the question and every option stay one click away, the pick marked");
  const answer = answerCards(page);
  await answer.waitFor();
  check(await answer.getAttribute("data-kind") === "recorded", "the answer message is drawn as an answer card");
  check((await answer.locator(".answer-chat-kicker").innerText()).toLowerCase() === "your answer · in chat", "it says where he answered");
  check((await answer.locator(".answer-chat-said").innerText()) === "Wait for Wi-Fi" && (await answer.locator(".answer-chat-added").innerText()) === "Revisit when I'm back on Monday.", "with what he chose and what he added");
  check((await answer.locator("details pre").textContent()).startsWith("The captain answered a call from Bearings."), "the text the first mate got is behind a fold");
  const after = await order(page);
  check(after.indexOf(`call:${RAISED}`) === before.indexOf(`call:${RAISED}`) && after.indexOf(`call:${RAISED}`) < after.indexOf(`answer:${RAISED}`), "the call card did not move, and the answer sits below it, where it was given");
  check(await chat(page).locator(".captain-message", { hasText: "The captain answered a call" }).count() === 0, "no plain-text answer is left in the chat");
  await inBothThemes(page, "d-recorded", async (theme) => {
    check(await paintedWith(card.locator(".call-pill"), "--green"), `${theme}: recorded is --green on the call card`);
    check(await paintedWith(answer.locator("[data-testid='answer-status']"), "--green"), `${theme}: and on the answer card`);
  });
  // The shared standing: Bearings no longer asks for it.
  await toBearings(page);
  const bearingsCard = page.locator(`.decision-card[data-call-id='${RAISED}']`);
  check(await bearingsCard.count() === 0 || await bearingsCard.getAttribute("data-recorded") === "true", "Bearings shows the call the chat answered as recorded, or no longer lists it");
  await page.close();
}

// Bearings answered while the chat card is on screen a moment ago: the chat card reads the same standing at once.
{
  const page = await open();
  await toChat(page);
  await ask(page, "What needs me?");
  await toBearings(page);
  const bearingsCard = page.locator(`.decision-card[data-call-id='${RAISED}']`);
  await bearingsCard.locator(".suggestion-chips button", { hasText: "Upload on any network" }).click();
  await bearingsCard.locator(".decision-actions button", { hasText: "Record answer" }).click();
  await page.locator(`.decision-card[data-call-id='${RAISED}'][data-recorded='true']`).waitFor();
  await toChat(page);
  const card = callCard(page);
  check(await card.getAttribute("data-standing") === "recorded" && (await card.locator(".call-chat-line").innerText()).includes("you chose Upload on any network"), "answered in Bearings, the chat card says so before the snapshot has it");
  const answer = answerCards(page);
  await answer.waitFor();
  check((await answer.locator(".answer-chat-kicker").innerText()).toLowerCase() === "your answer · from bearings", "and the answer card says it came from Bearings");
  await page.close();
}

// B and E: words, and a dated Not now, go through the reply path Bearings uses. The call stays open, the reply amber on
// both cards until something records it, and the form folds under Answer differently.
{
  const page = await open("&holds-reply");
  await toChat(page);
  await ask(page, "What needs me?");
  const card = callCard(page);
  await card.locator(".suggestion-chips button", { hasText: "Not now" }).click();
  check(await card.locator(".call-chat-actions button", { hasText: "Send" }).isDisabled(), "B: Not now cannot go without a day");
  await card.locator(".date-field input").fill("2026-10-03");
  await card.locator(".reply-field textarea").fill("I want to see the battery numbers first.");
  check((await card.locator("[data-testid='call-hint']").innerText()) === "→ keeps your words on the call for the first mate: Not now. Ask me again on Oct 3. I want to see the battery numbers first.", "B: a dated Not now is kept on the call as words");
  await inBothThemes(page, "b-not-now", async () => {});
  await card.locator(".call-chat-actions button", { hasText: "Send" }).click();
  await card.locator("[data-testid='call-replied']").waitFor();
  check(await card.getAttribute("data-standing") === "replied", "E: the call card reads the reply from the call");
  check(await card.locator(".suggestion-chips").count() === 0 && (await card.locator(".call-chat-actions button").last().innerText()) === "Answer differently", "E: the form folds under Answer differently");
  const answer = answerCards(page);
  await answer.waitFor();
  check(await answer.getAttribute("data-kind") === "replied" && (await answer.locator("[data-testid='answer-status']").innerText()) === "With the first mate · not recorded yet", "E: the answer card says it is with the first mate, not recorded");
  await inBothThemes(page, "e-replied", async (theme) => {
    check(await paintedWith(card.locator("[data-testid='call-replied']"), "--amber"), `${theme}: the reply is --amber on the call card`);
    check(await paintedWith(answer.locator("[data-testid='answer-status']"), "--amber"), `${theme}: and on the answer card`);
  });
  // The mock's first mate reads the message within seconds, then holds the call until the day, as `hold --until` does.
  const deadline = Date.now() + 2300;
  let green = false;
  while (Date.now() < deadline) {
    green ||= await answer.evaluate((element) => element.classList.contains("tone-green"));
    await page.waitForTimeout(200);
  }
  check(!green, "E: reading the reply is not recording it: the answer card never goes green");
  // G: held until the day. One line, with the day he named, and the answer card says it is held.
  await card.locator(".call-chat-line").waitFor({ timeout: 6000 });
  check(await card.getAttribute("data-standing") === "held" && (await card.locator(".call-chat-line").innerText()).includes("not now, ask again Oct 3"), "G: held, the card says the day he named");
  check((await answer.locator("[data-testid='answer-status']").innerText()) === "Held: not now", "G: the answer card says it is held, not recorded");
  await inBothThemes(page, "g-held", async (theme) => {
    check(await paintedWith(card.locator(".call-pill"), "--amber"), `${theme}: held is --amber`);
  });
  // The day comes: the record asks again with the same raised_at, so the card opens where it is.
  const place = (await order(page)).indexOf(`call:${RAISED}`);
  await ask(page, "The day has come.");
  await card.locator(".suggestion-chips").waitFor();
  check((await order(page)).indexOf(`call:${RAISED}`) === place, "G: the day come, the card opens where it was raised, not at the bottom");
  check((await card.locator(".call-chat-kicker").innerText()).toLowerCase().includes("your day has come") && (await card.locator("[data-testid='said-before']").innerText()).includes("you said: Not now. Ask me again on Oct 3."), "G: it says the day came, and what he said then");
  await inBothThemes(page, "g-day-comes", async () => {});
  await page.close();
}

// F: answered somewhere else while the card is on screen and something is written in it: the card changes at once, and
// what was written is kept and offered to the composer, never sent.
{
  const page = await open();
  await toChat(page);
  await ask(page, "What needs me?");
  const card = callCard(page);
  await card.locator(".reply-field textarea").fill("Use the publisher's, but flag the ones with ads.");
  await ask(page, "I answered the uploads in Lavish.");
  await card.locator(".call-chat-line").waitFor();
  check(await card.getAttribute("data-standing") === "recorded", "F: answered in Lavish, the card shrinks to the choice");
  check((await card.locator("[data-testid='call-unsent']").innerText()).includes("Use the publisher's, but flag the ones with ads."), "F: what he was writing is kept and shown as not sent");
  check(!(await chat(page).locator(".captain-message").allInnerTexts()).some((text) => text.includes("flag the ones with ads")), "F: and it was never sent");
  await inBothThemes(page, "f-elsewhere", async () => {});
  await card.locator("[data-testid='call-unsent'] button").click();
  check(await page.locator("textarea[aria-label='Message the first mate']").inputValue() === "Use the publisher's, but flag the ones with ads.", "F: Put it in the composer puts it there, unsent");
  check(await card.locator("[data-testid='call-unsent']").count() === 0, "F: and the note goes");
  await page.close();
}

// H: answered, then held again after its answer released the work: raised_at moves to the new hold, so the new ask is a
// new card at its new time, while the earlier answer keeps its own card and choice, pointing down.
{
  const page = await open();
  await toChat(page);
  await ask(page, "What needs me?");
  const first = callCard(page);
  await first.locator(".suggestion-chips button", { hasText: "Wait for Wi-Fi" }).click();
  await first.locator(".call-chat-actions button", { hasText: "Record answer" }).click();
  await answerCards(page).waitFor();
  await page.waitForTimeout(1500);
  await ask(page, "Ask me again about the uploads.");
  await callCard(page).locator(".suggestion-chips").waitFor();
  const items = await order(page);
  const answered = items.indexOf(`answer:${RAISED}`);
  const asked = items.indexOf(`call:${RAISED}`);
  check(items.filter((item) => item === `call:${RAISED}`).length === 1 && asked > answered, `H: the new ask is one card, below the earlier answer (${items.join(", ")})`);
  check(asked > items.findIndex((item) => item.startsWith("captain:Ask me again")) && asked < items.findIndex((item) => item.startsWith("mate:Captain, the Wi-Fi")), `H: placed at the new hold, above the first mate's words about it (${items.join(", ")})`);
  check((await callCard(page).locator(".call-chat-kicker").innerText()).toLowerCase().includes("asked before"), "H: the new card says it was asked before");
  check(await callCard(page).locator("[data-testid='options-changed']").count() === 0, "H: a hold that sets options as it raises changed nothing the card must warn of");
  const answer = answerCards(page);
  check(await answer.locator("[data-testid='asked-again']").count() === 1 && (await answer.locator(".answer-chat-said").innerText()) === "Wait for Wi-Fi", "H: the earlier answer keeps its choice and points down");
  await inBothThemes(page, "h-asked-again", async () => {});
  await page.close();
}

// I: new options offered after the call was raised, with the one picked withdrawn. The card draws the current ones,
// says they changed, and drops the pick rather than recording it.
{
  const page = await open();
  await toChat(page);
  await ask(page, "What needs me?");
  const card = callCard(page);
  await card.locator(".suggestion-chips button", { hasText: "Upload on any network" }).click();
  await ask(page, "Offer me other options.");
  await card.locator("[data-testid='options-changed']").waitFor();
  const notice = await card.locator("[data-testid='options-changed']").innerText();
  check(notice.includes("The options changed at") && notice.includes("“Upload on any network”, which you had picked, is no longer offered."), "I: the card says the options changed and names the withdrawn pick");
  check(await card.locator(".suggestion-chips button", { hasText: "Wait until it is charging" }).count() === 1 && await card.locator(".suggestion-chips button", { hasText: "Upload on any network" }).count() === 0, "I: it draws the current options only");
  check(await card.locator(".suggestion-chips button.selected").count() === 0 && await card.locator(".call-chat-actions button", { hasText: /Record answer|Send/ }).isDisabled(), "I: nothing is picked, so nothing withdrawn can be recorded");
  await inBothThemes(page, "i-options-changed", async (theme) => {
    check(await paintedWith(card.locator("[data-testid='options-changed'] svg"), "--amber"), `${theme}: the change is --amber`);
  });
  // The mock's own call whose options were offered after it was raised says so too.
  check(await callCard(page, OFFERED).locator("[data-testid='options-changed']").count() === 1, "I: so does the home's own call offered anew since it was raised");
  await page.close();
}

// J: the intake did not record it. The card says so as Bearings does, keeps the pick to try again, and nothing is said
// in chat, so there is no answer card.
{
  const page = await open(`&skip=${RAISED}`);
  await toChat(page);
  await ask(page, "What needs me?");
  const card = callCard(page);
  await card.locator(".suggestion-chips button", { hasText: "Wait for Wi-Fi" }).click();
  await card.locator(".call-chat-actions button", { hasText: "Record answer" }).click();
  await card.locator("[data-testid='not-recorded']").waitFor();
  check((await card.locator("[data-testid='not-recorded'] strong").innerText()) === "Not recorded: Wait for Wi-Fi", "J: not recorded, in Bearings' words");
  check(await card.locator(".suggestion-chips button.selected").count() === 1 && await card.getAttribute("data-standing") === "open", "J: the pick stays, to try again");
  check(await answerCards(page).count() === 0, "J: nothing reached the first mate, so there is no answer card");
  await inBothThemes(page, "j-not-recorded", async (theme) => {
    check(await paintedWith(card.locator("[data-testid='not-recorded']"), "--coral"), `${theme}: not recorded is --coral`);
  });
  await page.close();
}

// J from Bearings: what the intake said of an answer given there lives only in this session, never in the snapshot, so
// the chat card can show it only by reading the same standing Bearings does.
{
  const page = await open(`&skip=${RAISED}`);
  await toChat(page);
  await ask(page, "What needs me?");
  await toBearings(page);
  const bearingsCard = page.locator(`.decision-card[data-call-id='${RAISED}']`);
  await bearingsCard.locator(".suggestion-chips button", { hasText: "Upload on any network" }).click();
  await bearingsCard.locator(".decision-actions button", { hasText: "Record answer" }).click();
  await bearingsCard.locator("[data-testid='not-recorded']").waitFor();
  await toChat(page);
  check((await callCard(page).locator("[data-testid='not-recorded'] strong").innerText().catch(() => "")) === "Not recorded: Upload on any network", "J: refused in Bearings, the chat card says the same, from the one standing");
  await page.close();
}

// C: a call a page argues is open in the chat, with the argument beside the answer and the unread nudge.
{
  const page = await open();
  await toChat(page);
  const card = callCard(page, ARGUED);
  await card.waitFor();
  check((await card.locator("[data-testid='argued-by']").innerText()).startsWith("Argued by When may the app download the speech model?"), "C: it names the page that argues it");
  check(await card.locator("[data-testid='unread-argument']").count() === 1 && await card.locator(".suggestion-chips").count() === 1, "C: open, with the nudge to read it first");
  await inBothThemes(page, "c-argued", async () => {});
  await card.locator(".call-chat-actions button", { hasText: "Read the argument" }).click();
  await page.locator("iframe").first().waitFor();
  check(true, "C: Read the argument opens the page");
  await page.close();
}

// K: after a relaunch the history comes back with no ids or times. The app's own answer lines are still answer cards,
// one whose call left the snapshot is one line from its own words, and a message that only looks like one stays text.
{
  const page = await open("&history");
  await toChat(page);
  await answerCards(page, "res-upload-wifi").waitFor();
  const kept = answerCards(page, "res-upload-wifi");
  check(await kept.getAttribute("data-kind") === "recorded" && (await kept.locator(".answer-chat-said").innerText()) === "Wi-Fi only, and say so in Settings", "K: a resumed answer is an answer card");
  const gone = answerCards(page, "foreman-release-notes");
  check((await gone.getAttribute("class")).includes("line") && (await gone.innerText()).includes("Keep them to one screen"), "K: an answer whose call left the snapshot is one line");
  check(await chat(page).locator(".captain-message", { hasText: "I'd keep them short either way." }).count() === 1, "K: a message the app did not write stays a plain bubble");
  await inBothThemes(page, "k-resumed", async () => {});
  await page.close();
}

// A home whose firstmate predates calls[] has nothing to draw a card from, so the chat draws none.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${baseUrl}/?artifacts&chat-calls&legacy`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await toChat(page);
  await page.waitForTimeout(800);
  check(await chat(page).locator("[data-testid='call-card']").count() === 0, "legacy: no call cards without calls[]");
  await page.close();
}

// The narrow window: every state's card fits.
{
  const page = await open("", 390);
  await page.locator(".mobile-menu").click();
  await toChat(page);
  await ask(page, "What needs me?");
  await callCard(page).waitFor();
  await inBothThemes(page, "narrow", async () => {});
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nEvery call card state holds in both themes.");
