// Checks what argues a call on every surface that draws one, in both themes, on the browser mock.
//
//   pnpm dev --port 4196 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4196 pnpm evidence
//
// `?evidence` (src/host/mock.ts) gives the home's calls every kind of evidence: several pieces on one call, more than
// fit on a line, a report whose scout presented a page, a report with no page, and the page of a task with no worker
// left. Every surface reads it through `resolveEvidence` and `argumentOf` in src/calls.ts, so what is checked here is
// what each surface draws from them, and above all that a call nothing argues draws no control at all.
// Set EVIDENCE_SHOTS=<folder> to also save screenshots of each state in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4196. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.EVIDENCE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

/** A call nothing argues, one argued by a page, a report and a link, one argued by four pieces, and one by a report alone. */
const UNARGUED = "foreman-auto-merge";
const SEVERAL = "res-transcripts-source";
const FOLDED = "res-model-download";
const PAGE_ONLY = "res-model-cellular";
const REPORT_ONLY = "res-artwork-refresh";
/** The page of a task with no worker left, and the task. */
const TORN_DOWN_PAGE = "Rebase the subject before anybody reads it";
const TORN_DOWN_TASK = "foreman-rebase-before-review";

async function open(query = "&evidence", width = 1440) {
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

/** Checks a state in both themes, and saves a screenshot of `target` in each. */
async function inBothThemes(page, name, target, run) {
  for (const theme of themes) {
    await setTheme(page, theme);
    await target.scrollIntoViewIfNeeded();
    await run(theme);
    if (shots) await target.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

/** What an evidence line says, piece by piece: its kind and the words beside its title. */
async function pieces(line) {
  return line.locator("[data-testid='evidence-link']").evaluateAll((links) => links.map((link) => `${link.getAttribute("data-kind")}:${link.querySelector("small")?.textContent ?? ""}`));
}

/** Every control that would lead to what argues a call, which a call nothing argues must not draw. */
const EVIDENCE_CONTROLS = "[data-testid='argued-by'], [data-testid='evidence-link'], [data-testid='evidence-more'], [data-testid='read-argument'], [data-testid='unread-argument']";

/** Asserts a card draws no way to evidence at all: no line, no link, no read button, and nothing that says "argue". */
async function drawsNoEvidence(card, where) {
  check(await card.locator(EVIDENCE_CONTROLS).count() === 0, `${where}: no evidence line, link or read button is drawn`);
  const buttons = await card.locator("button").allInnerTexts();
  check(!buttons.some((text) => /argument|report|read/i.test(text)), `${where}: no button offers something to read (${buttons.join(" | ")})`);
  check(!/argued by/i.test(await card.innerText()), `${where}: nothing says what argues it`);
}

const bearingsCard = (page, id) => page.locator(`.decision-card[data-call-id='${id}']`);
const chat = (page) => page.locator("[data-testid='chat-messages']");
const chatCard = (page, id) => chat(page).locator(`[data-testid='call-card'][data-call-id='${id}']`);

async function toChat(page) {
  await page.locator(".nav-item", { hasText: "Chat" }).click();
  await chat(page).waitFor();
}

async function toBearings(page) {
  await page.locator(".nav-item", { hasText: "Bearings" }).click();
  await page.locator(".dashboard-section", { hasText: "Captain's call" }).waitFor();
}

// No evidence: the card offers its answer, and nothing to read. Checked on every surface a call is drawn.
{
  const page = await open();
  const card = bearingsCard(page, UNARGUED);
  await inBothThemes(page, "bearings-no-evidence", card, async (theme) => {
    await drawsNoEvidence(card, `Bearings, ${theme}`);
    check(await card.getAttribute("data-argued") === null && await card.getAttribute("data-inline") === "true", `Bearings, ${theme}: the answer is open on the card`);
    check(await card.locator(".suggestion-chips button").count() === 3, `Bearings, ${theme}: its options are offered`);
  });
  await toChat(page);
  const inChat = chatCard(page, UNARGUED);
  await inBothThemes(page, "chat-no-evidence", inChat, async (theme) => {
    await drawsNoEvidence(inChat, `chat, ${theme}`);
  });
  // Once answered, the line keeps its options one click away, and still nothing about evidence.
  await inChat.locator(".suggestion-chips button", { hasText: "Keep merging once checks pass" }).click();
  await inChat.locator(".call-chat-actions button", { hasText: "Record answer" }).click();
  await inChat.locator(".call-chat-line").waitFor();
  await inChat.locator(".call-chat-options summary").click();
  await inBothThemes(page, "chat-line-no-evidence", inChat, async (theme) => {
    await drawsNoEvidence(inChat, `chat line, ${theme}`);
  });
  await page.close();
}

// A call whose only page is gone argues nothing that can be opened, so it draws exactly what a call with no evidence draws.
{
  const page = await open("&evidence&gone-page");
  const card = bearingsCard(page, UNARGUED);
  await drawsNoEvidence(card, "Bearings, a page that is gone");
  await page.close();
}

// Several pieces: each a link in firstmate's order, saying what opening it does; past three, the rest fold.
{
  const page = await open();
  const card = bearingsCard(page, SEVERAL);
  const line = card.locator("[data-testid='argued-by']");
  await inBothThemes(page, "bearings-several", card, async (theme) => {
    check(JSON.stringify(await pieces(line)) === JSON.stringify(["page:page", "report:ask the first mate", "url:link"]), `Bearings, ${theme}: a page, a report with no page and a link, in order (${await pieces(line)})`);
    check((await line.textContent()) === "Argued by Which episodes already carry a transcript?page, the report on “Resonance: how often do feeds change their artwork?”ask the first mate, and PR #41link", `Bearings, ${theme}: joined as a sentence (${await line.textContent()})`);
    check(await paintedWith(line.locator("[data-testid='evidence-link']").first(), "--sea"), `Bearings, ${theme}: a link is drawn in the link colour`);
    check(await paintedWith(line.locator("[data-testid='evidence-link'] small").first(), "--faint"), `Bearings, ${theme}: what it does is drawn quiet`);
    check((await card.locator("[data-testid='read-argument']").innerText()) === "Read the argument", `Bearings, ${theme}: the page is read first`);
  });
  const folded = bearingsCard(page, FOLDED);
  const foldedLine = folded.locator("[data-testid='argued-by']");
  await inBothThemes(page, "bearings-folded", folded, async (theme) => {
    check(JSON.stringify(await pieces(foldedLine)) === JSON.stringify(["page:page", "report:report"]) && (await foldedLine.locator("[data-testid='evidence-more']").innerText()) === "2 more", `Bearings, ${theme}: four pieces show two and "2 more"`);
  });
  await foldedLine.locator("[data-testid='evidence-more']").click();
  check(JSON.stringify(await pieces(foldedLine)) === JSON.stringify(["page:page", "report:report", "page:page", "url:link"]) && await foldedLine.locator("[data-testid='evidence-more']").count() === 0, "Bearings: \"2 more\" unfolds the rest in place");
  if (shots) for (const theme of themes) { await setTheme(page, theme); await folded.screenshot({ path: join(shots, `bearings-unfolded-${theme}.png`) }); }
  await setTheme(page, "light");
  // A report whose scout presented a page opens that page, as the scout's own card does.
  await foldedLine.locator("[data-testid='evidence-link'][data-kind='report']").click();
  await page.locator(".page-heading h1", { hasText: "Which episodes already carry a transcript?" }).waitFor();
  check(true, "Bearings: a report with a page opens its page");
  await page.locator(".back-button").click();
  // The page of a task with no worker left still opens: teardown keeps it.
  await foldedLine.locator("[data-testid='evidence-more']").click();
  await foldedLine.locator("[data-testid='evidence-link']", { hasText: TORN_DOWN_PAGE }).click();
  await page.locator(".page-heading h1", { hasText: TORN_DOWN_PAGE }).waitFor();
  check(true, "Bearings: the page of a torn-down task opens");
  await page.close();
}

// A report with no page: the control says it can only be asked for, and asking puts the question in the composer.
{
  const page = await open();
  const card = bearingsCard(page, REPORT_ONLY);
  await inBothThemes(page, "bearings-report-only", card, async (theme) => {
    check(JSON.stringify(await pieces(card.locator("[data-testid='argued-by']"))) === JSON.stringify(["report:ask the first mate"]), `Bearings, ${theme}: the report says it goes to the first mate`);
    check((await card.locator("[data-testid='read-argument']").innerText()) === "Ask for the report", `Bearings, ${theme}: the button says "Ask for the report"`);
    check(await card.locator("[data-testid='unread-argument']").count() === 0, `Bearings, ${theme}: nothing claims an unread page`);
  });
  await card.locator("[data-testid='read-argument']").click();
  const composer = page.locator("textarea[aria-label='Message the first mate']");
  await composer.waitFor();
  check((await composer.inputValue()) === "Walk me through the report on \"Resonance: how often do feeds change their artwork?\".", "Bearings: asking for the report drafts the question, and sends nothing");
  await toBearings(page);
  await card.locator("[data-testid='evidence-link']").click();
  check((await composer.inputValue()).startsWith("Walk me through the report on"), "Bearings: the report's own link asks the same way");
  await page.close();
}

// The chat's open call card: the same line and the same button as Bearings.
{
  const page = await open();
  await toChat(page);
  const several = chatCard(page, FOLDED);
  await inBothThemes(page, "chat-several", several, async (theme) => {
    check(JSON.stringify(await pieces(several.locator("[data-testid='argued-by']"))) === JSON.stringify(["page:page", "report:report"]) && await several.locator("[data-testid='evidence-more']").count() === 1, `chat, ${theme}: four pieces show two and "2 more"`);
    check((await several.locator("[data-testid='read-argument']").innerText()) === "Read the argument", `chat, ${theme}: the page is read first`);
  });
  const report = chatCard(page, REPORT_ONLY);
  await inBothThemes(page, "chat-report-only", report, async (theme) => {
    check(JSON.stringify(await pieces(report.locator("[data-testid='argued-by']"))) === JSON.stringify(["report:ask the first mate"]), `chat, ${theme}: the report says it goes to the first mate`);
    check((await report.locator("[data-testid='read-argument']").innerText()) === "Ask for the report", `chat, ${theme}: the button says "Ask for the report"`);
  });
  // Once answered, what argues it is one click away beside the options.
  await report.locator(".suggestion-chips button", { hasText: "Weekly is enough" }).click();
  await report.locator(".call-chat-actions button", { hasText: "Record answer" }).click();
  await report.locator(".call-chat-line").waitFor();
  await report.locator(".call-chat-options summary").click();
  await inBothThemes(page, "chat-line-report", report, async (theme) => {
    check(JSON.stringify(await pieces(report.locator(".call-chat-options [data-testid='argued-by']"))) === JSON.stringify(["report:ask the first mate"]), `chat line, ${theme}: what argued it stays one click away`);
    check(await report.locator("[data-testid='read-argument']").count() === 0, `chat line, ${theme}: no read button on a call that is not his to answer`);
  });
  await report.locator("[data-testid='evidence-link']").click();
  check((await page.locator("textarea[aria-label='Message the first mate']").inputValue()).startsWith("Walk me through the report on"), "chat line: the report asks the first mate, as everywhere");
  await page.close();
}

// The review rail: beside the page on screen, only the rest of what argues the call.
{
  const page = await open();
  await page.locator(".nav-item", { hasText: "Artifacts" }).click();
  await page.locator(".artifact-list .artifact-row", { hasText: "When may the app download the speech model?" }).click();
  const rail = page.locator(".review-rail");
  const argued = rail.locator(`[data-testid='decision-answer'][data-call-id='${FOLDED}']`);
  await argued.waitFor();
  await inBothThemes(page, "rail-also-argued", rail, async (theme) => {
    const line = argued.locator("[data-testid='argued-by']");
    check((await line.innerText()).startsWith("Also argued by"), `rail, ${theme}: the line says the rest`);
    check(JSON.stringify(await pieces(line)) === JSON.stringify(["report:report", "page:page", "url:link"]), `rail, ${theme}: the page on screen is not repeated (${await pieces(line)})`);
    check(await rail.locator(`[data-testid='decision-answer'][data-call-id='${PAGE_ONLY}'] [data-testid='argued-by']`).count() === 0, `rail, ${theme}: a call argued only by this page has no such line`);
    check(await rail.locator("[data-testid='author-gone']").count() === 0, `rail, ${theme}: the first mate's own page has no author to lose`);
  });
  await page.close();
}

// A page whose task has been torn down: it opens, and the rail says the review goes to the first mate.
{
  const page = await open();
  await page.locator(".nav-item", { hasText: "Artifacts" }).click();
  await page.locator(".artifact-group-heading", { hasText: "Settled" }).click();
  await page.locator(".artifact-list .artifact-row", { hasText: TORN_DOWN_PAGE }).click();
  const gone = page.locator(".review-rail [data-testid='author-gone']");
  await page.locator(".review-rail .review-head").waitFor();
  await page.waitForTimeout(200);
  await inBothThemes(page, "rail-torn-down", page.locator(".review-rail"), async (theme) => {
    check(await gone.count() === 1, `rail, ${theme}: a page whose task has no worker left says so`);
    if (await gone.count() === 0) return;
    check((await gone.innerText()) === `Written by ${TORN_DOWN_TASK}, which has finished. Your review goes to the first mate, who acts on it.`, `rail, ${theme}: says the review goes to the first mate`);
    check(await paintedWith(gone.locator("strong"), "--ink"), `rail, ${theme}: drawn in the theme's ink`);
  });
  // A crewmate still at work keeps its review.
  await page.locator(".back-button").click();
  await page.locator(".artifact-list .artifact-row", { hasText: "AI titles for snips" }).click();
  await page.locator(".review-rail").waitFor();
  check(await page.locator(".review-rail [data-testid='author-gone']").count() === 0, "rail: a crewmate still at work is not called finished");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nWhat argues a call holds on every surface, in both themes.");
