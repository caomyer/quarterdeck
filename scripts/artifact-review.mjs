// Checks the artifact review flow on the browser mock: the Artifacts list, the review screen,
// revisions, the narrow width, accepted layout findings, the sandbox, the ways in from chat,
// the task drawer and back, reviewing itself: commenting on a part of the page, the draft
// surviving a reload, taking a comment back, and sending the review with a verdict, and
// iterating: what the author answers, settling a comment, what the list says is new, and
// deciding: a call answered inside the page that argues it, in one review with the comments.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm artifacts
//
// Set ARTIFACT_SHOTS to a folder to also save screenshots of each screen in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4191. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

async function shot(page, name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

async function noSidewaysScroll(page, where) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${where}: the window does not scroll sideways (${overflow}px)`);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
await page.goto(`${baseUrl}/?artifacts`);
await page.waitForFunction(() => !document.querySelector(".app-loading"));

// The list.
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
const rows = page.locator(".artifact-list .artifact-row");
check(await rows.count() === 2, "the list shows both presented pages");
check((await rows.nth(0).innerText()).includes("When may the app download the speech model?"), "the newest page comes first");
check((await rows.nth(1).innerText()).includes("resonance · res-titles-scout · Rev 3"), "a task page names its project, task and revision");
check((await rows.nth(1).locator(".review-chip").innerText()) === "Not looked at yet", "a page nobody has opened says so");
check(await rows.nth(0).locator(".artifact-flag").count() === 0, "a clean page carries no flag");
await noSidewaysScroll(page, "list");
await shot(page, "01-list");

// The review screen.
await rows.nth(1).click();
const frame = page.frameLocator(".artifact-stage iframe");
await frame.locator("h1").waitFor();
check(await page.locator(".page-heading h1").innerText() === "AI titles for snips", "the review screen is titled by the page");
check(await page.locator(".page-heading span").innerText() === "resonance · res-titles-scout · Rev 3 of 3", "the subtitle names the owner and revision");
check((await frame.locator(".eyebrow").textContent()).includes("revised twice"), "the latest revision opens by default");
check((await page.locator(".revision-note").innerText()).includes("no room for the model"), "the revision says what changed");
const sandbox = await page.locator(".artifact-stage iframe").getAttribute("sandbox");
check(sandbox === "allow-scripts allow-forms allow-downloads", `the frame is sandboxed without same-origin or top navigation (${sandbox})`);
const reachesApp = await page.frames().find((candidate) => candidate.url().includes("/artifacts/"))
  .evaluate(() => { try { return Boolean(window.parent.document.body); } catch { return false; } });
check(!reachesApp, "the page cannot reach into the app");
check(await page.locator(".artifact-loading").count() === 0, "the loading note clears once the page loads");
await noSidewaysScroll(page, "review");
await shot(page, "02-review");

// Accepted layout findings, on the revision that carries them.
await page.locator(".revision-picker select").selectOption("2");
await frame.locator(".eyebrow", { hasText: "revised" }).waitFor();
check(await page.locator(".layout-flag").count() === 1, "a revision presented with findings carries the flag");
await page.locator(".layout-flag").click();
check((await page.locator(".layout-findings").innerText()).includes("the page is 116px wider than the window"), "the flag opens the findings the presenter accepted");
await shot(page, "03-findings");
await page.locator(".layout-flag").click();
check(await page.locator(".layout-findings").count() === 0, "the flag closes the findings again");

// Narrow.
await page.locator(".width-toggle button[title='Narrow']").click();
const narrowWidth = await page.locator(".artifact-stage iframe").evaluate((element) => element.getBoundingClientRect().width);
check(Math.round(narrowWidth) === 500, `narrow shows the page at the check's narrow width (${narrowWidth}px)`);
await shot(page, "04-narrow");
await page.locator(".width-toggle button[title='Wide']").click();

// An earlier revision.
await page.locator(".revision-picker select").selectOption("1");
await frame.locator(".eyebrow", { hasText: "scout report" }).waitFor();
check(!(await frame.locator(".eyebrow").textContent()).includes("revised"), "picking Rev 1 shows Rev 1");
check(await page.locator(".page-heading span").innerText() === "resonance · res-titles-scout · Rev 1 of 3", "the subtitle follows the picked revision");
check(await page.locator(".layout-flag").count() === 0, "a revision with a clean check has no flag");
check((await page.locator(".newer-revision").innerText()) === "Rev 3 is new · Open", "a newer revision is announced, not swapped in");
await page.locator(".newer-revision").click();
await frame.locator(".eyebrow", { hasText: "revised twice" }).waitFor();
check(await page.locator(".newer-revision").count() === 0, "opening the newest revision clears the announcement");

// Back to where it was opened from.
await page.locator(".back-button").click();
check(await page.locator("[data-screen='artifacts']").count() === 1, "back returns to the list");

// From chat.
await page.locator(".nav-item", { hasText: "Chat" }).click();
const cards = page.locator("[data-testid='artifact-card']");
await cards.first().waitFor();
check(await cards.count() === 4, `chat shows each revision presented in the last day (${await cards.count()})`);
check((await cards.nth(0).innerText()).includes("shared a page"), "the first revision reads as a shared page");
check((await cards.nth(1).innerText()).includes("revised a page · Rev 2"), "a later revision reads as a revision");
check((await cards.nth(3).innerText()).includes("The first mate shared a page"), "a first mate page says who shared it");
await noSidewaysScroll(page, "chat");
await shot(page, "05-chat");
await cards.nth(0).locator("button").click();
await frame.locator("h1").waitFor();
check(await page.locator(".page-heading span").innerText() === "resonance · res-titles-scout · Rev 1 of 3", "a chat card opens the revision it announced");
await page.locator(".back-button").click();
check(await page.locator(".chat-view").count() === 1, "back returns to chat");

// From the task drawer.
await page.locator(".nav-item", { hasText: "Bearings" }).click();
await page.locator(".task-row", { hasText: "AI titles for snips" }).click();
const pages = page.locator(".task-drawer .drawer-pages .artifact-row");
check(await pages.count() === 1, "the task drawer lists the task's pages");
await shot(page, "06-drawer");
await pages.first().click();
await frame.locator("h1").waitFor();
check(await page.locator(".task-drawer").count() === 0, "opening a page closes the drawer");
await page.locator(".back-button").click();
check(await page.locator("[data-screen='bearings']").count() === 1, "back returns to Bearings");

// Commenting on the page.
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await rows.nth(1).click();
await frame.locator("h1").waitFor();
check(await page.locator(".review-empty").count() === 1, "a page with no review says so");
// Written on rev 2, so rev 3's answer is about a comment that already existed.
await page.locator(".revision-picker select").selectOption("2");
await frame.locator(".eyebrow", { hasText: "revised" }).waitFor();
await page.locator(".comment-toggle").click();
check((await page.locator(".comment-hint").innerText()).includes("Select the words you mean"), "comment mode says what to do");
await frame.locator(".card.rec p").click();
const composer = page.locator(".comment-composer");
await composer.waitFor();
check((await composer.locator("blockquote").innerText()).includes("Runs after transcription"), "the composer quotes what was clicked");
check(await page.locator(".comment-hint").count() === 0, "picking a place leaves comment mode");
await composer.locator("textarea").fill("Say what happens on an older phone.");
await composer.locator("button", { hasText: "Comment" }).click();
const threads = page.locator("[data-testid='review-thread']");
await threads.first().waitFor();
check(await threads.count() === 1, "the comment joins the review");
check((await threads.first().innerText()).includes("Not sent yet"), "a new comment is a draft, not a message");
check((await page.locator(".send-review").innerText()).includes("Send review · 1"), "the send button counts the draft");
await frame.locator("#__qd_layer__ div").first().waitFor({ timeout: 5000 }).catch(() => {});
check(await frame.locator("#__qd_layer__ div").count() > 0, "the page highlights where the comment sits");
await shot(page, "08-comment");

// A second comment, then taking one back.
await page.locator(".comment-toggle").click();
await frame.locator("h2", { hasText: "What people see now" }).click();
await composer.locator("textarea").fill("Add the on-device title for a third episode.");
await composer.locator("button", { hasText: "Comment" }).click();
check(await threads.count() === 2, "a second comment joins the same review");
await threads.nth(1).locator("button[title='Take this comment back']").click();
check(await threads.count() === 1, "a draft comment can be taken back");
check((await page.locator(".send-review").innerText()).includes("Send review · 1"), "the count follows what is left");

// The draft is kept, not held in the screen.
await page.locator(".back-button").click();
await rows.nth(1).click();
await frame.locator("h1").waitFor();
await threads.first().waitFor();
check(await threads.count() === 1, "leaving the page and coming back keeps the draft");
check((await threads.first().innerText()).includes("Written on rev 2"), "a comment says which revision it was written on");

// Sending the whole review as one message.
await page.locator(".verdict-picker select").selectOption("changes");
await page.locator(".send-review").click();
await page.locator(".review-last").waitFor();
check((await threads.first().innerText()).includes("Sent"), "a sent comment says so");
check((await page.locator(".review-last").innerText()).includes("Request changes"), "the review records its verdict");
check((await page.locator(".send-review").innerText()) === "Send review", "the draft count clears once it is sent");
check(await threads.first().locator("button[title='Take this comment back']").count() === 0, "a sent comment cannot be taken back");
await shot(page, "09-sent");
await page.locator(".nav-item", { hasText: "Chat" }).click();
const lastMessage = page.locator(".captain-message").last();
await lastMessage.waitFor();
const sentText = await lastMessage.innerText();
check(sentText.includes("Requests changes."), "the first mate is told the verdict");
check(sentText.includes("Say what happens on an older phone."), "the review's comments reach the first mate");
check(!sentText.includes("Add the on-device title"), "a comment taken back is never sent");
await shot(page, "10-sent-message");

// What the author says about a comment, and settling it.
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await rows.nth(1).click();
await frame.locator("h1").waitFor();
await threads.first().waitFor();
check((await threads.first().innerText()).includes("Changed in rev 3"), "the rail shows the revision that answered the comment");
check(!(await threads.first().innerText()).includes("Not sent yet"), "a sent comment is not a draft");
await shot(page, "11-answered");
await threads.first().locator("button[title='Settle this']").click();
await page.locator(".settled-toggle").waitFor();
check(await threads.count() === 0, "a settled comment leaves the waiting list");
check((await page.locator(".settled-toggle").innerText()).includes("1 settled"), "settled comments are kept, out of the way");
await page.locator(".settled-toggle").click();
check((await threads.first().innerText()).includes("Settled"), "a settled comment says so");
await threads.first().locator("button[title='Open this again']").click();
check((await threads.first().innerText()).includes("Sent"), "settling can be undone");
await threads.first().locator("button[title='Settle this']").click();
await page.locator(".settled-toggle").waitFor();

// What the list says once the newest revision has been looked at.
await page.locator(".back-button").click();
check(await rows.nth(1).locator(".review-chip").count() === 0, "a page with nothing waiting carries no chip");
await rows.nth(1).click();
await frame.locator("h1").waitFor();
await page.locator(".comment-toggle").click();
await frame.locator("h2", { hasText: "Options" }).click();
await composer.locator("textarea").fill("Name the phone models this was measured on.");
await composer.locator("button", { hasText: "Comment" }).click();
await page.locator(".back-button").click();
check((await rows.nth(1).locator(".review-chip").innerText()) === "1 comment not sent", "the list says a comment is still unsent");
await shot(page, "12-list-state");

// A call that a page argues is answered in that page.
await page.locator(".nav-item", { hasText: "Bearings" }).click();
const call = page.locator(".decision-card").first();
await call.waitFor();
check(await call.getAttribute("data-argued") === "true", "a call with a page to argue it says so");
check(await call.locator(".suggestion-chips").count() === 0, "that call offers no second place to answer");
check((await call.innerText()).includes("3 options, with the case for each"), "the call says what is waiting in the page");
await shot(page, "13-call-with-page");
await call.locator("button", { hasText: "Read the argument" }).click();
const answer = page.locator("[data-testid='decision-answer']");
await answer.waitFor();
check((await answer.innerText()).includes("When may the app download the 150 MB speech model?"), "the page offers the call's own question");
const choices = answer.locator(".decision-choices button");
check(await choices.count() === 3, "every recorded option is offered");
check((await choices.first().textContent()).includes("Recommended"), "the recommendation is marked");
await choices.first().click();
check((await answer.innerText()).includes("Goes with your review"), "an answer is staged, not sent");
check((await page.locator(".send-review").innerText()).includes("Send review · 1"), "the answer counts towards the review");
await shot(page, "14-answer-staged");

// A comment alongside it, then one message carrying both.
await page.locator(".comment-toggle").click();
await frame.locator(".card.rec p").click();
await composer.locator("textarea").fill("Say what happens on a metered hotspot.");
await composer.locator("button", { hasText: "Comment" }).click();
check((await page.locator(".send-review").innerText()).includes("Send review · 2"), "the answer and the comment travel together");
await page.locator(".verdict-picker select").selectOption("approve");
await page.locator(".send-review").click();
await page.locator(".review-last").waitFor();
check((await answer.innerText()).includes("Sent"), "the answer says it has gone");
await page.locator(".nav-item", { hasText: "Chat" }).click();
const review = page.locator(".captain-message").last();
await review.waitFor();
const reviewText = await review.innerText();
check(reviewText.includes("Answers, to record with bin/fm-captain-hold.sh:"), "the first mate is told to record the answer");
check(reviewText.includes("res-model-download: Wi-Fi only, with visible progress"), "the answer names the task and the option");
check(reviewText.includes("Say what happens on a metered hotspot."), "the comment goes in the same message");
await shot(page, "15-answer-sent");

// The call stays open until the first mate records it, and says why.
await page.locator(".nav-item", { hasText: "Bearings" }).click();
await call.waitFor();
check(await call.getAttribute("data-answered-in-review") === "true", "the call shows the answer has gone");
check((await call.innerText()).includes("This stays here until the first mate records it."), "the call is honest about not being closed");
await shot(page, "16-call-answered");

// Narrow window: the review toolbar wraps instead of pushing the page sideways.
await page.setViewportSize({ width: 700, height: 900 });
await page.locator(".mobile-menu").click();
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await rows.nth(1).click();
await frame.locator("h1").waitFor();
await noSidewaysScroll(page, "review in a narrow window");
await shot(page, "07-review-small-window");

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall artifact review checks passed");
