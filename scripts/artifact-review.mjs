// Checks the artifact review flow on the browser mock: the Artifacts list, the review screen,
// revisions, the narrow width, accepted layout findings, the sandbox, the ways in from chat,
// the task drawer and back, reviewing itself: commenting on a part of the page, the draft
// surviving a reload, taking a comment back, and sending the review with a verdict, and
// iterating: what the author answers, settling a comment, what the list says is new, and
// deciding: a call answered inside the page that argues it, in one review with the comments,
// recorded through firstmate's intake, or straight from Bearings, a skip never shown as recorded,
// every way to answer a call (an option, not now until a day, and words) kept by a call a page argues,
// in Bearings and in the page itself, a call put again after it was answered in words or not now being
// answerable again in both, and a home that predates calls[], and a diagram the page owns:
// opening it, proposing changes, and how they reach the author.
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

/** The text a sent review's card says the first mate was sent. */
async function sentText(card) {
  await card.waitFor();
  return (await card.locator(".review-card-text pre").textContent()) ?? "";
}

async function noSidewaysScroll(page, where) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${where}: the window does not scroll sideways (${overflow}px)`);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
await page.goto(`${baseUrl}/?artifacts`);
await page.waitForFunction(() => !document.querySelector(".app-loading"));

// Bearings: what waits on the captain, what was decided for them, what landed, and how long work has been going.
const bearingsPage = page.locator("[data-screen='bearings']");
const callSection = page.locator(".dashboard-section", { hasText: "Captain's Call" });
// The finished transcripts scout's report is the argument of an open call, so it is offered through that call, once.
check((await callSection.locator(".section-count").innerText()) === "4", "Captain's Call counts the four open calls, and a report that argues one is not counted again");
check((await page.locator(".nav-item", { hasText: "Bearings" }).locator("em").innerText()) === "4", "the sidebar counts the same four");
const ready = page.locator("[data-testid='report-ready']");
check(await ready.count() === 0, "a finished scout whose report argues an open call is not offered twice");
const transcriptsCall = callSection.locator(".decision-card", { hasText: "Where should Resonance get an episode's transcript?" });
check((await transcriptsCall.innerText()).includes("Argued by Which episodes already carry a transcript?"), "the call names the scout's report as its argument");
const underwayRows = page.locator(".dashboard-section", { hasText: "Underway" }).locator(".task-row");
check(await underwayRows.count() === 1, "a finished scout leaves Underway once its report is offered");
check(/started 1 h 3\d min ago/.test(await underwayRows.first().locator("[data-testid='underway-for']").innerText()), `Underway says how long a task has been going (${await underwayRows.first().locator("[data-testid='underway-for']").innerText()})`);

const decidedRows = page.locator("[data-testid='decided'] .decided-row");
check(await decidedRows.count() === 3, "Decided for you lists the calls the first mate made");
const finding = decidedRows.first();
check((await finding.innerText()).includes("Kept the wide before-and-after image"), "a decision says what was decided");
check((await finding.innerText()).includes("Seeing both titles side by side is the point"), "a decision says why");
check((await finding.locator(".link-button").first().innerText()) === "Resonance: AI titles for snips", "a decision names its task by title");
const merge = decidedRows.nth(1);
check((await merge.locator("a.link-button").getAttribute("href")) === "https://github.com/caomyer/foreman/pull/24", "a decision links what it points at");
check((await merge.locator("a.link-button").innerText()).includes("PR #24"), "a pull request link reads as its number");
await finding.locator(".link-button").first().click();
await page.locator(".task-drawer").waitFor();
check((await page.locator("[data-testid='drawer-title']").innerText()) === "Resonance: AI titles for snips", "a decision's task opens that task");
await page.locator(".task-drawer .icon-button[title='Close task details']").click();
await finding.locator("button", { hasText: "Push back" }).click();
const composerBox = page.locator(".composer textarea");
await composerBox.waitFor();
check((await composerBox.inputValue()) === 'About "Kept the wide before-and-after image in the titles plan (review finding F1)": ', "Push back puts the decision in the composer");
check(await composerBox.evaluate((element) => document.activeElement === element), "Push back leaves the caret in the composer");
check(await page.locator(".captain-message", { hasText: "Kept the wide" }).count() === 0, "Push back sends nothing by itself");
await composerBox.fill("");
await page.locator(".nav-item", { hasText: "Bearings" }).click();
await decidedRows.nth(2).locator("button[title='Dismiss']").click();
check(await decidedRows.count() === 2, "a decision can be dismissed");
await page.reload();
await page.waitForFunction(() => !document.querySelector(".app-loading"));
await decidedRows.first().waitFor();
check(await decidedRows.count() === 2, "a dismissed decision stays dismissed after a reload");
check(await page.locator(".decided-row", { hasText: "Filed res-ai-titles" }).count() === 0, "the dismissed decision is the one that was dismissed");

const landedRows = page.locator("[data-testid='landed-row']");
check(await landedRows.count() === 3, "Recently Landed shows what landed and the call the captain answered");
const answeredCall = page.locator("[data-testid='landed-row'][data-landed-kind='answered']");
check(await answeredCall.count() === 1, "an answered and closed call shows as done");
check((await answeredCall.innerText()).includes("You chose Wi-Fi only, and say so in Settings · based on Should uploads wait for Wi-Fi?"), "the answered call says what the captain chose, and what it was based on");
check(await answeredCall.locator("button.link-button", { hasText: "Should uploads wait for Wi-Fi?" }).count() === 1, "what the answer was based on is a link to it");
// It was answered on a bare date two days ago, and has to read as that same calendar day here, not the evening before.
const answeredDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(Date.now() - 2 * 86_400_000));
check((await answeredCall.innerText()).includes(`closed ${answeredDay}`), `a call answered on a bare date reads as that day (${answeredDay})`);
const shippedRow = page.locator("[data-testid='landed-row'][data-id='foreman-rebase-before-review']");
check((await shippedRow.locator("a.landed-link").getAttribute("href")) === "https://github.com/caomyer/foreman/pull/24", "a landed PR links the PR");
check(await shippedRow.locator("button.landed-link", { hasText: "The page" }).count() === 1, "a landed task with a page offers it");
const reportedRow = page.locator("[data-testid='landed-row'][data-id='res-feed-scout']");
check((await reportedRow.innerText()).includes("Reported"), "a landed scout says it reported");
await reportedRow.locator("button.landed-link", { hasText: "Report" }).click();
await composerBox.waitFor();
check((await composerBox.inputValue()) === 'Walk me through the report on "Resonance: how often do feeds change their artwork?".', "a report without a page is asked for in chat");
await composerBox.fill("");
await page.locator(".nav-item", { hasText: "Bearings" }).click();
await noSidewaysScroll(page, "bearings");
await shot(page, "00-bearings");

// The task drawer leads with the worker's own words, in plain language.
await underwayRows.first().click();
const drawer = page.locator(".task-drawer");
await drawer.waitFor();
check((await drawer.locator("[data-testid='drawer-title']").innerText()) === "Resonance: AI titles for snips", "the drawer is titled by the task's title");
check((await drawer.locator(".drawer-id").innerText()) === "res-titles-scout", "the task id sits beside the title");
check(!(await drawer.innerText()).includes("harness busy"), "the drawer never says harness busy");
check((await drawer.locator(".drawer-status").innerText()).includes("Busy in its terminal."), "the drawer says what the worker is doing in plain words");
check(await drawer.locator("h3", { hasText: "Instructions" }).count() === 0, "the drawer does not call a status note the instructions");
check((await drawer.locator(".drawer-section", { hasText: "Latest from the worker" }).innerText()).includes("Revising the titles plan."), "the drawer shows the worker's latest note, labelled as such");
const sections = await drawer.locator(".drawer-section > h3").allInnerTexts();
check(sections[0] === "What was asked" && sections[1] === "Latest from the worker", `what was asked comes before the worker's note (${sections.slice(0, 2).join(", ")})`);
check(await drawer.locator("[data-testid='task-body'] li").count() === 2, "the body keeps the filer's list");
check(/^1 h 3\d min$/.test(await drawer.locator("[data-testid='drawer-age']").innerText()), "the drawer says how long the task has been going");
check(await drawer.locator("h3", { hasText: /^PR$/ }).count() === 0, "a scout's drawer has no PR section");
check(await drawer.locator(".worker-screen").count() === 0, "the worker's screen starts folded");
await drawer.locator(".fold-toggle").click();
check(await drawer.locator(".worker-screen").count() === 1, "the worker's screen opens on request");
await shot(page, "00-drawer");
await page.keyboard.press("Escape");
check(await drawer.count() === 0, "Escape closes the drawer");
await underwayRows.first().click();
await drawer.waitFor();
// One click on the sidebar both closes the drawer and goes where it was aimed. A real press at the
// sidebar's position, since a locator click would wait for whatever covers it to go away.
const chatNav = await page.locator(".nav-item", { hasText: "Chat" }).boundingBox();
await page.mouse.click(chatNav.x + chatNav.width / 2, chatNav.y + chatNav.height / 2);
check(await drawer.count() === 0, "a click outside the drawer closes it");
check(await page.locator(".chat-view").count() === 1, "a click on the sidebar while the drawer is open is not swallowed");
await page.locator(".nav-item", { hasText: "Bearings" }).click();
await transcriptsCall.locator("button", { hasText: "Read the argument" }).click();
await page.locator(".artifact-stage iframe").waitFor();
check((await page.locator(".page-heading span").innerText()).includes("res-transcripts-scout"), "Read the argument opens the scout's report");
// The scout has finished, but its report argues a call that is still open, so the call waits on this page.
check((await page.locator(".verdict-picker select").inputValue()) === "changes", "a finished scout's report that argues an open call starts on Request changes");
check((await page.locator(".review-send small").innerText()) === "The first mate revises the case before you decide.", "the hint says the call waits on the page, not that nothing does");
// Answering the call there means the captain decided from the case as argued, so the review turns to Approve.
await page.locator("[data-testid='decision-answer'] .decision-choices button").first().click();
await page.locator("[data-testid='decision-answer'] .decision-staged").waitFor();
check((await page.locator(".verdict-picker select").inputValue()) === "approve", "answering every call the page argues turns the review to Approve");
check((await page.locator(".review-send small").innerText()) === "The case reads well, and your answer is recorded as it is sent.", "the Approve hint says the answer goes with it");
await page.locator(".verdict-picker select").selectOption("comment");
check((await page.locator(".review-send small").innerText()) === "Thoughts only; your answer is still recorded as it is sent.", "a verdict the captain picks stays theirs, and still carries the answer");
await page.locator(".back-button").click();
check(await bearingsPage.count() === 1, "back from the report returns to Bearings");
// The mock keeps reviews in memory, so a reload puts the report back to unread for the list below.
await page.reload();
await page.waitForFunction(() => !document.querySelector(".app-loading"));

// The list.
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
const rows = page.locator(".artifact-list .artifact-row");
// Rows move between groups as a review goes on, so each page is addressed by name, never by position.
const plan = page.locator(".artifact-list .artifact-row", { hasText: "AI titles for snips" });
const callPage = page.locator(".artifact-list .artifact-row", { hasText: "When may the app download the speech model?" });
check(await rows.count() === 3, "the list shows the pages still in play");
check((await rows.nth(0).innerText()).includes("When may the app download the speech model?"), "the newest page comes first");
check((await plan.innerText()).includes("resonance · res-titles-scout · Rev 3"), "a task page names its project, task and revision");
check((await plan.locator(".review-chip").innerText()) === "Not looked at yet", "a page nobody has opened says so");
check(await callPage.locator(".artifact-flag").count() === 0, "a clean page carries no flag");

// The list groups by whose move it is, and files away pages whose task landed.
const groups = page.locator(".artifact-group");
check(await groups.count() === 2, "only the groups with pages in them show");
check((await groups.nth(0).locator("h2").innerText()) === "Open for review", "pages waiting on the captain come first");
check(await groups.nth(0).locator(".artifact-row").count() === 3, "every unread page needs the captain");
const settled = groups.nth(1);
check((await settled.locator("h2").innerText()) === "Settled", "a page whose task landed is settled");
check((await settled.locator(".section-count").innerText()) === "2", "the settled group says how many it holds");
check(await settled.locator(".artifact-row").count() === 0, "settled pages stay folded away");
await settled.locator(".artifact-group-heading").click();
const landed = settled.locator(".artifact-row");
check(await landed.count() === 2, "the settled group opens on its own");
check((await settled.innerText()).includes("Should uploads wait for Wi-Fi?"), "a chat page whose calls are all closed is settled, read or not");
check((await landed.first().innerText()).includes("Rebase the subject before anybody reads it"), "the landed page is the one that landed");
check(await landed.first().locator(".review-chip").count() === 0, "a landed page says nothing is waiting on it");
// A landed page that argues nothing holds nothing up, so its review starts on Comment and says why.
await landed.first().click();
await page.locator(".artifact-stage iframe").waitFor();
check((await page.locator(".verdict-picker select").inputValue()) === "comment", "a landed page that argues no call starts the review on Comment");
check((await page.locator(".review-send small").innerText()) === "Thoughts only. Its task has already landed, so nothing waits on this page.", "the hint says why nothing waits on a landed page");
await page.locator(".verdict-picker select").selectOption("changes");
check(!(await page.locator(".review-send small").innerText()).includes("keeps waiting"), "Request changes never claims a landed task is waiting");
await page.locator(".back-button").click();
await settled.locator(".artifact-group-heading").click();
await shot(page, "01b-list-groups");
await settled.locator(".artifact-group-heading").click();
check(await settled.locator(".artifact-row").count() === 0, "the settled group folds again");

await noSidewaysScroll(page, "list");
await shot(page, "01-list");

// The review screen.
await plan.click();
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
check((await page.locator(".verdict-picker select").inputValue()) === "comment", "a live scout's page that argues no call starts on Comment");
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
await plan.click();
await frame.locator("h1").waitFor();
check(await page.locator(".review-empty").count() === 1, "a page with no review says so");
// Written on rev 2, so rev 3's answer is about a comment that already existed.
await page.locator(".revision-picker select").selectOption("2");
await frame.locator(".eyebrow", { hasText: "revised" }).waitFor();
const stageTop = async () => (await page.locator(".artifact-stage").boundingBox()).y;
const before = await stageTop();
await page.locator(".comment-toggle").click();
check((await page.locator(".revision-note.commenting").innerText()).includes("Select the words you mean"), "comment mode says what to do");
check(await stageTop() === before, "turning comment mode on leaves the page where it was");
await frame.locator(".card.rec p").click();
const composer = page.locator(".comment-composer");
await composer.waitFor();
check((await composer.locator("blockquote").innerText()).includes("Runs after transcription"), "the composer quotes what was clicked");
check(await page.locator(".revision-note.commenting").count() === 0, "picking a place leaves comment mode");
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
await plan.click();
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
const reviewCard = page.locator("[data-testid='review-card']").last();
const firstReview = await sentText(reviewCard);
check(firstReview.includes("Requests changes."), "the first mate is told the verdict");
check(firstReview.includes("Say what happens on an older phone."), "the review's comments reach the first mate");
check(!firstReview.includes("Add the on-device title"), "a comment taken back is never sent");
// In chat the review is a card, not the text written for the first mate.
check(await page.locator(".captain-message", { hasText: "Captain's review of" }).count() === 0, "a sent review is not shown as a bubble of its own text");
const cardText = (await reviewCard.locator("header").textContent()) ?? "";
check(cardText.includes("Your review") && cardText.includes("AI titles for snips") && cardText.includes("Requests changes"), "the card names the page and the verdict");
check((await reviewCard.locator("[data-thread='t1']").innerText()).includes("Say what happens on an older phone."), "the card shows each comment in the captain's words");
// Rev 3 already answers t1, so the card says so and offers the next move.
check(await reviewCard.getAttribute("data-state") === "answered", "a review a later revision answered reads as answered");
check((await reviewCard.locator("[data-thread='t1']").innerText()).includes("Changed in rev 3"), "the card says which revision answered each comment");
check(await reviewCard.locator("button", { hasText: "Open rev 3" }).count() === 1, "the card opens the revision that answered it");
check((await page.locator("[data-testid='answers-review']").innerText()).includes("t1"), "the revision's own card says which comments it answers");
await noSidewaysScroll(page, "chat with a review card");
await shot(page, "10-review-card");

// What the author says about a comment, and settling it.
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
// Rev 3 changed what the comment asked about, so the next move is the captain's, not the author's.
check((await plan.locator(".review-chip").innerText()) === "1 comment answered", "a comment a later revision answered is not counted as waiting");
check(await page.locator(".artifact-group[data-standing='needs-you'] .artifact-row", { hasText: "AI titles for snips" }).count() === 1, "a page whose author answered every comment needs the captain");
await plan.click();
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

// Settled in the review, the card in chat shrinks to one line.
await page.locator(".nav-item", { hasText: "Chat" }).click();
const settledCard = page.locator("[data-testid='review-card']").first();
await settledCard.waitFor();
check(await settledCard.getAttribute("data-state") === "settled", "a review whose comments are all settled shrinks to one line");
check((await settledCard.innerText()).includes("Review of AI titles for snips settled · 1 comment · rev 2 → rev 3"), `the line says what was settled and across which revisions (${await settledCard.innerText()})`);
await shot(page, "10b-review-settled");
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await plan.click();
await frame.locator("h1").waitFor();

// What the list says once the newest revision has been looked at.
await page.locator(".back-button").click();
check(await plan.locator(".review-chip").count() === 0, "a page with nothing waiting carries no chip");
check((await page.locator(".artifact-group").nth(1).locator("h2").innerText()) === "In discussion", "a read page with live work moves to its author");
await plan.click();
await frame.locator("h1").waitFor();
await page.locator(".comment-toggle").click();
await frame.locator("h2", { hasText: "Options" }).click();
await composer.locator("textarea").fill("Name the phone models this was measured on.");
await composer.locator("button", { hasText: "Comment" }).click();
await page.locator(".back-button").click();
check((await plan.locator(".review-chip").innerText()) === "1 comment not sent", "the list says a comment is still unsent");
await shot(page, "12-list-state");

// A call that a page argues is answered in that page.
await page.locator(".nav-item", { hasText: "Bearings" }).click();
const call = page.locator(".decision-card[data-call-id='res-model-download']");
await call.waitFor();
check(await call.getAttribute("data-argued") === "true", "a call with a page to argue it says so");
check(await call.locator(".suggestion-chips").count() === 0, "its options wait behind Answer now");
check((await call.locator("[data-testid='argued-by']").innerText()) === "Argued by When may the app download the speech model?", "the call names the page that argues it");
check((await call.innerText()).includes("3 options · Recommended: Wi-Fi only, with visible progress"), "the call says how many options and which is recommended");
check(await call.locator("[data-testid='decision-reason']").count() === 0, "a question the title already asks is not said twice");
await shot(page, "13-call-with-page");
await call.locator("button", { hasText: "Read the argument" }).click();
const answer = page.locator("[data-testid='decision-answer'][data-call-id='res-model-download']");
await answer.waitFor();
check(await page.locator("[data-testid='decision-answer']").count() === 2, "a page that argues two calls offers both");
check((await answer.innerText()).includes("When may the app download the 150 MB speech model?"), "the page offers the call's own question");
check(await answer.locator("[data-testid='options-updated']").count() === 0, "options unchanged since the page say nothing");
const cellular = page.locator("[data-testid='decision-answer'][data-call-id='res-model-cellular']");
check((await cellular.locator("[data-testid='options-updated']").innerText()) === "Options updated since rev 1", "options changed after the page was presented say so");
check((await page.locator(".verdict-picker select").inputValue()) === "changes", "a page arguing an open call starts on Request changes");
check((await page.locator(".review-send small").innerText()) === "The first mate revises the case before you decide.", "the hint says what Request changes does to an open call");
const choices = answer.locator(".decision-choices button");
check(await choices.count() === 4 && (await choices.last().innerText()) === "Not now", "every recorded option is offered, and Not now");
check((await choices.first().textContent()).includes("Recommended"), "the recommendation is marked");
await choices.first().click();
check((await answer.innerText()).includes("Goes with your review"), "an answer is staged, not sent");
check((await page.locator(".send-review").innerText()).includes("Send review · 1"), "the answer counts towards the review");
await shot(page, "14-answer-staged");

// A comment alongside it, then one message carrying both.
await page.locator(".comment-toggle").click();
await frame.locator(".card.rec p").first().click();
await composer.locator("textarea").fill("Say what happens on a metered hotspot.");
await composer.locator("button", { hasText: "Comment" }).click();
check((await page.locator(".send-review").innerText()).includes("Send review · 2"), "the answer and the comment travel together");
await page.locator(".verdict-picker select").selectOption("approve");
await page.locator(".send-review").click();
await page.locator(".review-last").waitFor();
check((await answer.innerText()).includes("Recorded"), "the answer says firstmate recorded it");
await page.locator(".nav-item", { hasText: "Chat" }).click();
const reviewText = await sentText(page.locator("[data-testid='review-card']").last());
check((await page.locator("[data-testid='review-card']").last().innerText()).includes("Wi-Fi only"), "the card shows the answer recorded with the review");
check(reviewText.includes("do not record them again"), "the first mate is told the answer is already recorded");
check(reviewText.includes("Recorded: res-model-download = wifi-only"), "the answer names the call and the option key, as recorded");
check(!reviewText.includes("to record with"), "the first mate is never asked to do the recording");
check(reviewText.includes("Say what happens on a metered hotspot."), "the comment goes in the same message");
await shot(page, "15-answer-sent");

// Recorded by the intake, the call closes: it leaves the waiting list and lands as the captain's answer.
await page.locator(".nav-item", { hasText: "Bearings" }).click();
await call.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
check(await call.count() === 0, "a recorded call leaves Captain's Call once the snapshot has it closed");
const chosenRow = page.locator("[data-testid='landed-row'][data-id='res-model-download']");
check((await chosenRow.innerText()).includes("You chose Wi-Fi only, with visible progress · based on When may the app download the speech model?"), "the recorded answer lands as what the captain chose");
await shot(page, "16-call-answered");
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await callPage.click();
await answer.waitFor();
check((await answer.locator("[data-testid='call-answered']").innerText()) === "Answered by you here: Wi-Fi only, with visible progress", "the rail says who answered and how, once the call is answered");
check(await answer.locator(".decision-choices button").count() === 0, "an answered call offers no live buttons");
await page.locator(".back-button").click();

// Answering from Bearings: Answer now opens the same answer a call nothing argues offers, and a recorded choice says so.
await page.locator(".nav-item", { hasText: "Bearings" }).click();
const quick = page.locator(".decision-card[data-call-id='res-transcripts-source']");
await quick.waitFor();
check((await quick.locator("[data-testid='argued-by']").innerText()) === "Argued by Which episodes already carry a transcript?", "a call raised before its page existed is argued by the page its origin presented");
check((await quick.locator(".decision-actions button").last().innerText()).includes("Read the argument"), "reading the argument is the primary action");
await quick.locator("button", { hasText: "Answer now" }).click();
const panel = quick.locator("[data-testid='answer-fields']");
await panel.waitFor();
check((await quick.locator("[data-testid='unread-argument']").innerText()).includes("You haven't opened"), "answering before opening the argument is noted, quietly");
await shot(page, "19-answer-now");
await panel.locator(".suggestion-chips button", { hasText: "Use the publisher" }).click();
check((await quick.locator(".decision-actions > span").innerText()).startsWith("→ records: Use the publisher"), "a keyed choice says it is recorded");
await quick.locator(".decision-actions button", { hasText: "Record answer" }).click();
const recordedCard = page.locator(".decision-card[data-call-id='res-transcripts-source'][data-recorded='true']");
await recordedCard.waitFor();
check((await recordedCard.innerText()).includes("Recorded: Use the publisher's transcript when there is one, else transcribe"), "the card says the answer is recorded");
check((await recordedCard.innerText()).includes("You answered without opening the argument."), "the card keeps the note that the argument was not opened");
await shot(page, "19b-answer-recorded");
await page.locator(".nav-item", { hasText: "Chat" }).click();
const quickMessage = await page.locator(".captain-message").last().innerText();
check(quickMessage.includes("Recorded: res-transcripts-source = publisher-first"), "the first mate is told the answer is already recorded");
await page.locator(".nav-item", { hasText: "Bearings" }).click();
await quick.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
check(await quick.count() === 0, "the call leaves once firstmate has it closed");
const quickRow = page.locator("[data-testid='landed-row'][data-id='res-transcripts-source']");
check((await quickRow.innerText()).includes("based on Which episodes already carry a transcript?"), "the answer lands based on the page that argued it");
await quickRow.locator("button.link-button").click();
await page.locator(".artifact-stage iframe").waitFor();
check((await page.locator(".page-heading h1").innerText()) === "Which episodes already carry a transcript?", "what an answer was based on opens from Recently Landed");
await page.locator(".back-button").click();

// A diagram the page owns: opened for real, changed, and proposed with the review.
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await plan.click();
await frame.locator("h1").waitFor();
await page.locator(".scene-open").waitFor();
check((await page.locator(".scene-open").innerText()).includes("Diagram"), "a page with a diagram offers to open it");
await page.locator(".scene-open").click();
const editor = page.locator(".scene-editor");
await editor.waitFor();
check((await editor.locator("> header h2").innerText()) === "Snip pipeline", "the editor opens the page's own diagram");
// Wait for what each step needs rather than a fixed time: Excalidraw loads lazily and at its own pace.
await editor.locator("canvas").first().waitFor({ timeout: 60_000 });
check(await editor.locator("canvas").count() > 0, "the scene draws on a canvas");
await shot(page, "17-diagram");
await editor.getByRole("button", { name: "Propose these changes" }).click();
await editor.getByText("Nothing has changed").waitFor();
check((await editor.innerText()).includes("Nothing has changed"), "an unchanged diagram is not filed as a change");
const canvas = await editor.locator("canvas").first().boundingBox();
await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
await page.keyboard.press("Meta+a");
await page.waitForTimeout(400);
for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
await page.waitForTimeout(600);
await editor.getByRole("button", { name: "Propose these changes" }).click();
await page.locator(".scene-editor").waitFor({ state: "detached", timeout: 30_000 });
check(await page.locator(".scene-editor").count() === 0, "proposing closes the editor");
const proposal = threads.last();
const proposalText = await proposal.innerText();
check(proposalText.includes("Snip pipeline"), "the proposal reads as a thread on that diagram");
check(/change(s)? to Snip pipeline/.test(proposalText), "the thread says what changed, in the diagram's own terms");
check(proposalText.includes("Not sent yet"), "a proposal is a draft like any comment");
check(await proposal.locator("img.thread-picture").count() === 1, "the rail shows what was proposed");
await shot(page, "18-proposed");
await page.locator(".verdict-picker select").selectOption("changes");
await page.locator(".send-review").click();
await page.locator(".review-last").waitFor();
await page.locator(".nav-item", { hasText: "Chat" }).click();
const proposalMessage = await sentText(page.locator("[data-testid='review-card']").last());
check(proposalMessage.includes("on the diagram \"Snip pipeline\""), "the message names the diagram");
check(proposalMessage.includes("proposed scene:"), "the message points at the scene the author can take up");

// The page is someone else's HTML: what it posts is read as data, and only when the captain asked for it.
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await plan.click();
await frame.locator("h1").waitFor();
const forge = (message) => page.frameLocator(".artifact-stage iframe").locator("body").evaluate((_, data) => parent.postMessage(data, "*"), message);
await forge({ type: "qd:picked", anchor: { quote: "Intro" } });
await forge({ type: "qd:picked", anchor: {} });
await forge({ type: "qd:scene-open", scene: { file: "../../../chat/model-download/rev-1/model-download.html", label: "x" } });
await page.waitForTimeout(300);
check(await composer.count() === 0, "a page cannot open the composer on its own");
check(await page.locator(".scene-editor").count() === 0, "a page cannot open a file of its choosing as a diagram");
await page.locator(".comment-toggle").click();
await forge({ type: "qd:picked", anchor: { quote: "Intro", scene: "x", scene_file: "/Users/me/.ssh/id_rsa", preview: "https://example.invalid/beacon" } });
await composer.waitFor();
await composer.locator("textarea").fill("Checking what a forged anchor keeps.");
await composer.locator("button", { hasText: "Comment" }).click();
const forged = threads.last();
await forged.waitFor();
check((await forged.innerText()).includes("Intro"), "a forged anchor keeps its words");
check(await forged.locator("img").count() === 0, "a forged anchor brings no picture into the app");
await forged.locator("button[title='Take this comment back']").click();

// Narrow window: the review toolbar wraps instead of pushing the page sideways.
await page.setViewportSize({ width: 700, height: 900 });
await page.locator(".mobile-menu").click();
await page.locator(".nav-item", { hasText: "Artifacts" }).click();
await plan.click();
await frame.locator("h1").waitFor();
await noSidewaysScroll(page, "review in a narrow window");
await shot(page, "07-review-small-window");

// A step that failed is told calmly: the fact stays, the alarm does not.
{
  const steps = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  steps.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await steps.addInitScript((events) => { window.__FM_REPLAY__ = events; }, [
    { t_ms: 0, type: "state", payload: { state: "idle" } },
    { t_ms: 10, type: "tool_call", payload: { update: { toolCallId: "s1", title: "bin/fm-fleet-snapshot.sh --json", kind: "execute", status: "completed" } } },
    { t_ms: 20, type: "tool_call", payload: { update: { toolCallId: "s2", title: "test -f data/res-ai-titles/report.md", kind: "execute", status: "failed" } } },
    { t_ms: 30, type: "text", payload: { text: "Nothing new on the titles work.", origin: "agent" } },
  ]);
  await steps.goto(`${baseUrl}/?replay`);
  await steps.waitForFunction(() => !document.querySelector(".app-loading"));
  await steps.locator(".nav-item", { hasText: "Chat" }).click();
  const summary = steps.locator(".step-summary").first();
  await summary.waitFor();
  const said = await summary.innerText();
  check(said.includes("2 steps") && said.includes("1 came back with an error"), `a step group keeps the fact that a step failed (${said})`);
  check(!said.includes("didn't work"), "a step group does not sound the alarm over a failed probe");
  await summary.click();
  const failedIcon = steps.locator(".step-line.failed .step-icon");
  const [iconColour, coral] = await Promise.all([
    failedIcon.evaluate((element) => getComputedStyle(element).color),
    steps.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--coral)"; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove(); return colour; }),
  ]);
  check(iconColour !== coral, "a failed step is not painted in the alarm colour");
  await steps.close();
}

// A resumed conversation comes back without times: pages shared before this window opened
// stay with it under "Earlier", and never sit under "Today" ahead of what happens next.
const resumed = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await resumed.goto(`${baseUrl}/?artifacts&history`);
await resumed.waitForFunction(() => !document.querySelector(".app-loading"));
await resumed.locator(".nav-item", { hasText: "Chat" }).click();
await resumed.locator("[data-testid='artifact-card']").first().waitFor();
// The mock replays the startup, and with it the resumed conversation, a moment after the pages.
await resumed.locator(".chat-messages .day-label", { hasText: /earlier/i }).waitFor();
const order = await resumed.evaluate(() => [...document.querySelectorAll(".chat-messages .day-label, .chat-messages [data-testid='artifact-card']")].map((element) => element.matches(".day-label") ? element.textContent.trim().toLowerCase() : "page"));
const firstToday = order.indexOf("today");
check(order[0] === "earlier" && order.includes("page") && (firstToday === -1 || order.lastIndexOf("page") < firstToday), `pages from before this window stay under Earlier (${order.join(",")})`);
await resumed.close();

// `?resumed-day`: a day of conversation resumed with no times, its last exchange minutes old and every page older.
// A page never renders below a message newer than it, so none sits below that last exchange, as they all did once.
// The one time the history holds is the review the captain sent on the usage panel's first revision: that revision
// stays above it, and the second, presented after it, follows it. The review's card keeps its message's place.
{
  const day = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  day.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await day.goto(`${baseUrl}/?artifacts&resumed-day`);
  await day.waitForFunction(() => !document.querySelector(".app-loading"));
  await day.locator(".nav-item", { hasText: "Chat" }).click();
  await day.locator(".chat-messages .captain-message", { hasText: "Morning. What changed overnight?" }).waitFor();
  await day.locator(".chat-messages [data-testid='review-card']").waitFor();
  const stream = await day.evaluate(() => [...document.querySelectorAll(".chat-messages > *")].map((element) => {
    if (element.matches(".day-label")) return `label:${element.textContent.trim().toLowerCase()}`;
    if (element.matches("[data-testid='artifact-card']")) return `page:${element.querySelector("strong")?.textContent.trim()}|${/Rev (\d+)/.exec(element.textContent)?.[1] ?? "1"}`;
    if (element.matches("[data-testid='review-card']")) return "review";
    return `said:${element.textContent.replace(/\s+/g, " ").trim()}`;
  }));
  const at = (test) => stream.findIndex(test);
  const shown = ` (${stream.join(" / ")})`;
  const lastExchange = at((item) => item.includes("Morning. What changed overnight?"));
  const pages = stream.flatMap((item, index) => item.startsWith("page:") ? [index] : []);
  const flow = at((item) => item.startsWith("page:How no-mistakes carries a change"));
  const panel = (rev) => at((item) => item.startsWith("page:Usage panel") && item.endsWith(`|${rev}`));
  const review = at((item) => item === "review");
  const checkDay = (ok, what) => check(ok, ok ? what : what + shown);
  checkDay(lastExchange > 0 && pages.length === 7 && pages.every((index) => index < lastExchange), "no page renders below the resumed conversation's last exchange, which is newer than all of them");
  checkDay(flow > 0 && panel(1) > flow && review > panel(1), "a page stays above the review sent on it, and pages keep their order");
  checkDay(panel(2) > review && panel(2) < at((item) => item.includes("Revision 2 says what it means")), "a page presented after a review the history holds follows that review");
  const said = stream.filter((item) => item.startsWith("said:") || item === "review");
  const card = said.indexOf("review");
  checkDay(said[card - 1]?.includes("first cut is up as usage-panel") && said[card + 1]?.includes("Revision 2 says what it means"), "the review's card keeps its message's place in the resumed conversation");
  checkDay(!stream.includes("label:today"), "nothing after the resumed conversation, so no Today");
  await day.locator(".chat-messages [data-testid='artifact-card']").first().scrollIntoViewIfNeeded();
  await shot(day, "25-resumed-day");
  await day.close();
}

// A skip is never shown as recorded: not from Bearings, and not from the review rail.
{
  const skipping = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  skipping.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await skipping.goto(`${baseUrl}/?artifacts&skip=foreman-auto-merge,res-model-cellular`);
  await skipping.waitForFunction(() => !document.querySelector(".app-loading"));
  const inline = skipping.locator(".decision-card[data-call-id='foreman-auto-merge']");
  await inline.waitFor();
  check(await inline.getAttribute("data-inline") === "true", "a call nothing argues offers its options inline");
  check(await inline.locator(".suggestion-chips button").count() === 3, "its options, and Not now");
  await inline.locator(".suggestion-chips button", { hasText: "Hold every PR for me" }).click();
  check((await inline.locator(".decision-actions button").innerText()).includes("Record answer"), "a keyed option is recorded, and the button says so");
  await inline.locator(".decision-actions button").click();
  const refused = inline.locator("[data-testid='not-recorded']");
  await refused.waitFor();
  check((await refused.innerText()).includes("Not recorded: Hold every PR for me"), "a skipped answer is shown as not recorded");
  check((await refused.innerText()).includes("the hold changed"), "with the intake's reason");
  await shot(skipping, "20-not-recorded");
  await skipping.locator(".nav-item", { hasText: "Chat" }).click();
  check(await skipping.locator(".captain-message, .review-card-text pre", { hasText: "foreman-auto-merge" }).count() === 0, "nothing about a skipped answer reaches the first mate");

  await skipping.locator(".nav-item", { hasText: "Artifacts" }).click();
  await skipping.locator(".artifact-list .artifact-row", { hasText: "When may the app download the speech model?" }).click();
  const railCellular = skipping.locator("[data-testid='decision-answer'][data-call-id='res-model-cellular']");
  await railCellular.waitFor();
  await railCellular.locator(".decision-choices button").first().click();
  await skipping.locator(".send-review").click();
  await railCellular.locator(".decision-refused").waitFor();
  check((await railCellular.innerText()).includes("Not recorded: the hold changed"), "the rail shows a skipped answer as not recorded");
  check(await railCellular.locator(".decision-choices button:not(:disabled)").count() === 3, "a skipped answer can be chosen again");
  await shot(skipping, "20b-rail-not-recorded");
  await skipping.locator(".nav-item", { hasText: "Chat" }).click();
  const skippedReview = await sentText(skipping.locator("[data-testid='review-card']").last());
  check(skippedReview.includes("Captain's review of") && !skippedReview.includes("res-model-cellular"), "the review never claims a skipped answer");

  // Answered in chat: the rail says so instead of offering buttons.
  await skipping.locator(".nav-item", { hasText: "Artifacts" }).click();
  await skipping.locator(".artifact-group[data-standing='settled'] .artifact-group-heading").click();
  await skipping.locator(".artifact-list .artifact-row", { hasText: "Should uploads wait for Wi-Fi?" }).click();
  const chatAnswered = skipping.locator("[data-testid='decision-answer'][data-call-id='res-upload-wifi']");
  await chatAnswered.waitFor();
  check((await chatAnswered.locator("[data-testid='call-answered']").innerText()) === "Answered by you in chat: Wi-Fi only, and say so in Settings", "a call answered in chat says so in the rail");
  check(await chatAnswered.locator(".decision-choices button").count() === 0, "and offers no buttons");
  await shot(skipping, "20c-rail-answered-in-chat");

  // Narrow: the call cards wrap rather than push the window sideways.
  await skipping.setViewportSize({ width: 420, height: 900 });
  await skipping.locator(".mobile-menu").click();
  await skipping.locator(".nav-item", { hasText: "Bearings" }).click();
  const narrowCall = skipping.locator(".decision-card[data-call-id='res-transcripts-source']");
  await narrowCall.locator("button", { hasText: "Answer now" }).click();
  await noSidewaysScroll(skipping, "Bearings with Answer now open in a narrow window");
  const spilling = await narrowCall.evaluate((card) => [...card.querySelectorAll(".suggestion-chips button")].filter((chip) => [...chip.children].some((part) => part.scrollWidth > part.clientWidth + 1)).map((chip) => chip.innerText));
  check(spilling.length === 0, `every option's words stay inside its chip in a narrow window (${spilling.join(" / ")})`);
  await narrowCall.scrollIntoViewIfNeeded();
  await shot(skipping, "22-bearings-narrow");
  await skipping.close();
}

// A home whose firstmate predates calls[]: Bearings' own calls, bare, answered through the first mate, and nothing else.
{
  const legacy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  legacy.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await legacy.goto(`${baseUrl}/?artifacts&legacy`);
  await legacy.waitForFunction(() => !document.querySelector(".app-loading"));
  const legacyCall = legacy.locator(".decision-card[data-call-id='res-model-download']");
  await legacyCall.waitFor();
  check((await legacy.locator(".dashboard-section", { hasText: "Captain's Call" }).locator(".section-count").innerText()) === "2", "an older home counts Bearings' calls");
  check(await legacyCall.getAttribute("data-inline") === "true", "its call is answered in words");
  check(await legacyCall.locator(".suggestion-chips button").count() === 1, "with no options but Not now");
  check(await legacyCall.locator("button", { hasText: "Read the argument" }).count() === 0, "and no evidence");
  check(await legacy.locator("[data-testid='decided']").count() === 0, "no Decided for you without calls[]");
  check(await legacy.locator("[data-testid='landed-row'][data-landed-kind='answered']").count() === 0, "no answers read back from prose");
  await shot(legacy, "21-legacy");
  await legacy.locator(".nav-item", { hasText: "Artifacts" }).click();
  await legacy.locator(".artifact-list .artifact-row", { hasText: "When may the app download the speech model?" }).click();
  await legacy.locator(".artifact-stage iframe").waitFor();
  await legacy.waitForTimeout(300);
  check(await legacy.locator("[data-testid='decision-answer']").count() === 0, "no call cards in the rail without calls[]");
  await legacy.close();
}

// A call a page argues keeps every way to answer it that a call nothing argues has: its options, not now until a
// day, and words. Linking a call to its page took the last two away once, in Bearings and in the page alike.
{
  const argued = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  argued.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await argued.goto(`${baseUrl}/?artifacts`);
  await argued.waitForFunction(() => !document.querySelector(".app-loading"));
  /** What a card or the rail offers to answer with: every choice, whether it has a day field, and what its words are called. */
  const offers = async (where) => ({
    choices: await where.locator("[data-testid='answer-fields'] :is(.suggestion-chips, .decision-choices) button").allInnerTexts(),
    words: await where.locator("[data-testid='answer-fields'] .reply-field span").allInnerTexts(),
  });
  const unargued = argued.locator(".decision-card[data-call-id='foreman-auto-merge']");
  const cellularCard = argued.locator(".decision-card[data-call-id='res-model-cellular']");
  await cellularCard.waitFor();
  const plain = await offers(unargued);
  check(plain.choices.at(-1) === "Not now" && plain.words[0] === "Or answer in words", `a call nothing argues offers Not now and words (${JSON.stringify(plain)})`);
  check(await cellularCard.getAttribute("data-argued") === "true" && await cellularCard.locator("[data-testid='answer-fields']").count() === 0, "an argued call keeps its answer folded under Answer now");
  await cellularCard.locator("button", { hasText: "Answer now" }).click();
  const opened = await offers(cellularCard);
  check(JSON.stringify(opened) === JSON.stringify({ choices: ["Pause, and carry on when Wi-Fi is back\nRECOMMENDED", "Finish on cellular if under 20 MB are left", "Not now"], words: ["Or answer in words"] }), `an argued call opens to its options, Not now and words (${JSON.stringify(opened)})`);

  // Not now waits for its day, then goes to the first mate as words with anything added.
  await cellularCard.locator(".suggestion-chips button", { hasText: "Not now" }).click();
  check(await cellularCard.locator(".decision-actions button", { hasText: "Send" }).isDisabled(), "Not now sends nothing until it has a day");
  check((await cellularCard.locator(".decision-actions > span").innerText()) === "Pick the day to be asked again", "and says what it is waiting for");
  await cellularCard.locator(".date-field input").fill("2026-10-03");
  await cellularCard.locator(".reply-field textarea").fill("After the launch, once we see real traffic.");
  check((await cellularCard.locator(".reply-field span").innerText()) === "Anything to add for the first mate?", "words go with Not now rather than instead of it");
  check((await cellularCard.locator(".decision-actions > span").innerText()) === "→ sends: On the res model cellular: Not now. Ask me again on Oct 3. After the launch, once we see real traffic.", "the dated Not now says what it sends, words and all");
  await shot(argued, "25-argued-not-now");
  await cellularCard.locator(".decision-actions button", { hasText: "Send" }).click();
  await cellularCard.locator(".call-state").waitFor();
  check((await cellularCard.innerText()).includes("Not now. Ask me again on Oct 3."), "the card keeps what was sent");

  // Words alone, on a call argued by a scout's report.
  const transcripts = argued.locator(".decision-card[data-call-id='res-transcripts-source']");
  await transcripts.locator("button", { hasText: "Answer now" }).click();
  await transcripts.locator(".reply-field textarea").fill("Publisher first, but log every episode we had to transcribe.");
  check((await transcripts.locator(".decision-actions button").last().innerText()) === "Send", "words are sent, not recorded");
  await transcripts.locator(".decision-actions button", { hasText: "Send" }).click();
  await transcripts.locator(".call-state").waitFor();
  await argued.locator(".nav-item", { hasText: "Chat" }).click();
  const told = await argued.locator(".captain-message").allInnerTexts();
  check(told.some((text) => text.includes("On the res model cellular: Not now. Ask me again on Oct 3. After the launch")), "the dated Not now reaches the first mate");
  check(told.some((text) => text.includes("On the res transcripts source: Publisher first, but log every episode")), "an argued call answered in words reaches the first mate");
  await argued.close();
}

// In the page that argues it: an option with words added, not now until a day, and words alone, all in one review.
{
  const rail = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  rail.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await rail.goto(`${baseUrl}/?artifacts`);
  await rail.waitForFunction(() => !document.querySelector(".app-loading"));
  const openPage = async () => {
    await rail.locator(".nav-item", { hasText: "Artifacts" }).click();
    await rail.locator(".artifact-list .artifact-row", { hasText: "When may the app download the speech model?" }).click();
    await rail.locator("[data-testid='decision-answer']").first().waitFor();
  };
  await openPage();
  const download = rail.locator("[data-testid='decision-answer'][data-call-id='res-model-download']");
  const cellular = rail.locator("[data-testid='decision-answer'][data-call-id='res-model-cellular']");
  const choices = await download.locator("[data-testid='answer-fields'] .decision-choices button").allInnerTexts();
  check(choices.at(-1) === "Not now" && choices.length === 4, `the page offers the call's options and Not now (${choices.join(" / ")})`);
  check((await download.locator(".reply-field span").innerText()) === "Or answer in words", "the page offers words");
  check((await cellular.locator("[data-testid='options-updated']").innerText()) === "Options updated since rev 1", "words beside it, the page still says its options changed");

  await download.locator(".decision-choices button", { hasText: "Not now" }).click();
  check((await download.locator(".decision-staged").innerText()) === "Pick the day to be asked again", "Not now in the page waits for its day");
  check((await rail.locator(".send-review").innerText()) === "Send review", "and stages nothing until it has one");
  await download.locator(".date-field input").fill("2026-10-03");
  await download.locator(".decision-staged", { hasText: "for the first mate to record" }).waitFor();
  check((await rail.locator(".send-review").innerText()) === "Send review · 1", "a dated Not now goes with the review");
  // Choosing an option instead takes the day back.
  await download.locator(".decision-choices button", { hasText: "Wi-Fi only" }).click();
  await download.locator(".decision-staged", { hasText: "recorded as it is sent" }).waitFor();
  check(await download.locator(".date-field").count() === 0, "an option replaces Not now");
  await download.locator(".reply-field textarea").fill("Say so in Settings too.");
  check((await download.locator(".reply-field span").innerText()) === "Anything to add for the first mate?", "words with an option are added to it");
  await cellular.locator(".reply-field textarea").fill("Pause, and tell the user why it stopped.");
  await rail.waitForTimeout(900);
  check((await rail.locator(".send-review").innerText()) === "Send review · 2", "words alone go with the review too");
  check((await cellular.locator(".decision-staged").innerText()) === "Goes with your review, for the first mate to record", "words are staged for the first mate to record, not the intake");
  await shot(rail, "26-rail-in-words");

  // What was staged is kept: leaving the page and coming back finds it as it was left.
  await rail.locator(".back-button").click();
  await openPage();
  check((await cellular.locator(".reply-field textarea").inputValue()) === "Pause, and tell the user why it stopped.", "staged words are there on coming back");
  check((await download.locator(".decision-choices button.selected").innerText()).includes("Wi-Fi only") && (await download.locator(".reply-field textarea").inputValue()) === "Say so in Settings too.", "a staged option keeps what was added to it");

  // Words still being typed as the review goes are not left behind.
  await cellular.locator(".reply-field textarea").fill("Pause, and tell the user why it stopped. Keep what was downloaded.");
  await rail.locator(".send-review").click();
  await rail.locator(".review-last").waitFor();
  check((await cellular.locator("[data-testid='answer-words']").innerText()) === "Pause, and tell the user why it stopped. Keep what was downloaded.", "the page shows the words that went");
  check((await cellular.locator(".decision-sent").innerText()).endsWith("for the first mate to record"), "words sent are sent, never recorded");
  check((await download.locator(".decision-sent").innerText()).startsWith("Recorded"), "the option is recorded");
  check((await download.locator("[data-testid='answer-words']").innerText()) === "You added: Say so in Settings too.", "with what was added to it");
  check(await cellular.locator("textarea, .decision-choices button:not(:disabled)").count() === 0, "an answer that went cannot be changed in the page");
  await shot(rail, "27-rail-words-sent");
  await rail.locator(".nav-item", { hasText: "Chat" }).click();
  const card = rail.locator("[data-testid='review-card']").last();
  const text = await sentText(card);
  check(text.includes("Recorded: res-model-download = wifi-only (\"Wi-Fi only, with visible progress\")\n  The captain added: Say so in Settings too."), "the recorded option carries what was added");
  check(text.includes("Answered in words, which nothing has recorded yet; record each with bin/fm-captain-hold.sh"), "the first mate is asked to record words, since nothing else can");
  check(text.includes("\nres-model-cellular: Pause, and tell the user why it stopped. Keep what was downloaded."), "the words go as the captain wrote them, the last of them too");
  check((await card.locator(".review-card-answers li").allInnerTexts()).some((chip) => chip.includes("Pause, and tell the user why") && chip.includes("sent")), "the chat card shows words as sent, not recorded");
  await rail.locator(".nav-item", { hasText: "Bearings" }).click();
  const answeredCard = rail.locator(".decision-card[data-call-id='res-model-cellular'][data-answered-in-review='true']");
  await answeredCard.waitFor();
  check((await answeredCard.innerText()).includes("Answered in your review of"), "Bearings says a call answered in words in the page was answered there");
  await rail.close();
}

// `?reasked`: a dated Not now and words alone went with a review, and the first mate put both calls again. Each is
// open again in Bearings and in the page, which keeps what was said then, and takes a new answer.
{
  const again = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  again.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await again.goto(`${baseUrl}/?artifacts&reasked`);
  await again.waitForFunction(() => !document.querySelector(".app-loading"));
  const openPage = async () => {
    await again.locator(".nav-item", { hasText: "Artifacts" }).click();
    await again.locator(".artifact-list .artifact-row", { hasText: "When may the app download the speech model?" }).click();
    await again.locator("[data-testid='decision-answer']").first().waitFor();
  };
  await openPage();
  const download = again.locator("[data-testid='decision-answer'][data-call-id='res-model-download']");
  const cellular = again.locator("[data-testid='decision-answer'][data-call-id='res-model-cellular']");
  await download.locator(".decision-choices button", { hasText: "Not now" }).click();
  await download.locator(".date-field input").fill("2026-10-03");
  await download.locator(".decision-staged", { hasText: "for the first mate to record" }).waitFor();
  await cellular.locator(".reply-field textarea").fill("Pause, and tell the user why it stopped.");
  await again.waitForTimeout(900);
  await again.locator(".send-review").click();
  await again.locator(".review-last").waitFor();
  await cellular.locator("[data-testid='call-reasked']").waitFor();
  await download.locator("[data-testid='call-reasked']").waitFor();
  for (const [name, rail, said] of [["the dated Not now", download, "Not now. Ask me again on Oct 3."], ["the words", cellular, "Pause, and tell the user why it stopped."]]) {
    check((await rail.locator("[data-testid='answer-earlier']").innerText()).endsWith(`: ${said}`), `put again, the page keeps ${name} as what was said then`);
    check(await rail.locator(".reply-field textarea").isEditable() && (await rail.locator(".reply-field textarea").inputValue()) === "", `put again after ${name}, the page offers its words again, empty`);
    check(await rail.locator(".decision-choices button:disabled").count() === 0 && await rail.locator(".decision-choices button").count() > 0, `put again after ${name}, the page offers every choice again`);
    check(await rail.locator(".decision-sent, .decision-staged").count() === 0, `put again after ${name}, the page no longer says it went or is staged`);
  }
  for (const theme of ["light", "dark"]) {
    await again.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await shot(again, `29-rail-put-again-${theme}`);
  }
  await again.evaluate(() => document.documentElement.classList.remove("dark"));

  await again.locator(".nav-item", { hasText: "Bearings" }).click();
  for (const id of ["res-model-download", "res-model-cellular"]) {
    const card = again.locator(`.decision-card[data-call-id='${id}']`);
    await card.waitFor();
    check(await card.getAttribute("data-answered-in-review") === null && await card.locator("button", { hasText: "Answer now" }).count() === 1, `Bearings offers ${id}'s answer again once it is put again`);
  }

  // A new answer is taken, in words and by option, and goes with the next review.
  await openPage();
  await cellular.locator(".reply-field textarea").fill("Finish on cellular after all.");
  await cellular.locator(".decision-staged", { hasText: "for the first mate to record" }).waitFor();
  check((await cellular.locator("[data-testid='answer-earlier']").innerText()).endsWith(": Pause, and tell the user why it stopped."), "what was said then stays beside the new answer");
  await download.locator(".decision-choices button", { hasText: "Wi-Fi only" }).click();
  await download.locator(".decision-staged", { hasText: "recorded as it is sent" }).waitFor();
  check((await again.locator(".send-review").innerText()) === "Send review · 2", "both new answers go with the next review");
  await again.locator(".send-review").click();
  await download.locator("[data-testid='call-answered']").waitFor();
  await cellular.locator(".decision-sent").waitFor();
  check((await cellular.locator("[data-testid='answer-words']").innerText()) === "Finish on cellular after all.", "the new words went");
  await again.locator(".nav-item", { hasText: "Chat" }).click();
  const texts = await Promise.all((await again.locator("[data-testid='review-card']").all()).map((card) => sentText(card)));
  check(texts.at(-1).includes("\nres-model-cellular: Finish on cellular after all.") && !texts.at(-1).includes("Pause, and tell the user"), "the next review carries the new words alone");
  check(texts.at(-2).includes("\nres-model-cellular: Pause, and tell the user why it stopped.") && texts.at(-2).includes("Not now. Ask me again on 2026-10-03."), "the review that carried the first answers still says what they were");
  await again.close();
}

// A call whose options are not recorded is answered in words, in Bearings and in the page.
{
  const bare = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  bare.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await bare.goto(`${baseUrl}/?artifacts&options-missing`);
  await bare.waitForFunction(() => !document.querySelector(".app-loading"));
  const card = bare.locator(".decision-card[data-call-id='res-model-cellular']");
  await card.locator("button", { hasText: "Answer now" }).click();
  check(JSON.stringify(await card.locator(".suggestion-chips button").allInnerTexts()) === JSON.stringify(["Not now"]) && (await card.locator(".reply-field span").innerText()) === "Answer in words", "an argued call with no options is answered in words in Bearings");
  await bare.locator(".nav-item", { hasText: "Artifacts" }).click();
  await bare.locator(".artifact-list .artifact-row", { hasText: "When may the app download the speech model?" }).click();
  const railCall = bare.locator("[data-testid='decision-answer'][data-call-id='res-model-cellular']");
  await railCall.waitFor();
  check((await railCall.locator("[data-testid='options-missing']").innerText()).includes("options are not recorded"), "the page says the options are not recorded");
  check((await railCall.locator(".reply-field span").innerText()) === "Answer in words", "and offers words instead of sending the captain to chat");
  await railCall.scrollIntoViewIfNeeded();
  await shot(bare, "28-rail-no-options");
  await bare.close();
}

// `?plain-report`: a finished scout whose report argues no call is offered on a card of its own.
const plain = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await plain.goto(`${baseUrl}/?artifacts&plain-report`);
await plain.waitForFunction(() => !document.querySelector(".app-loading"));
const plainCalls = plain.locator(".dashboard-section", { hasText: "Captain's Call" });
check((await plainCalls.locator(".section-count").innerText()) === "4", "Captain's Call counts a finished report beside the three open calls");
const plainReady = plain.locator("[data-testid='report-ready']");
check(await plainReady.count() === 1, "a finished scout's report is offered where the captain looks first");
check((await plainReady.innerText()).toLowerCase().includes("which episodes already carry a transcript?"), "the report card names the task by its title");
check((await plainReady.innerText()).includes("2 of 9281 sampled episodes"), "the report card says what the scout found");
await plainReady.locator("button", { hasText: "Read the report" }).click();
await plain.locator(".artifact-stage iframe").waitFor();
check((await plain.locator(".verdict-picker select").inputValue()) === "comment", "a finished scout's report that argues nothing starts the review on Comment");
check((await plain.locator(".review-send small").innerText()) === "Thoughts only. Its task has finished, so nothing waits on this page.", "the hint says why nothing waits on it");
await plain.close();

// Settling from the card in chat: a fresh home, one comment on rev 2, which rev 3 answers.
{
  const fromChat = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  fromChat.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await fromChat.goto(`${baseUrl}/?artifacts`);
  await fromChat.waitForFunction(() => !document.querySelector(".app-loading"));
  await fromChat.locator(".nav-item", { hasText: "Artifacts" }).click();
  await fromChat.locator(".artifact-list .artifact-row", { hasText: "AI titles for snips" }).click();
  const planFrame = fromChat.frameLocator(".artifact-stage iframe");
  await planFrame.locator("h1").waitFor();
  await fromChat.locator(".revision-picker select").selectOption("2");
  await planFrame.locator(".eyebrow", { hasText: "revised" }).waitFor();
  await fromChat.locator(".comment-toggle").click();
  await planFrame.locator(".card.rec p").click();
  await fromChat.locator(".comment-composer textarea").fill("Say what happens on an older phone.");
  await fromChat.locator(".comment-composer button", { hasText: "Comment" }).click();
  await fromChat.locator(".send-review").click();
  await fromChat.locator(".review-last").waitFor();
  await fromChat.locator(".nav-item", { hasText: "Chat" }).click();
  const card = fromChat.locator("[data-testid='review-card']").last();
  await card.waitFor();
  await card.locator("button", { hasText: "Settle it" }).click();
  await fromChat.waitForFunction(() => [...document.querySelectorAll("[data-testid='review-card']")].at(-1)?.getAttribute("data-state") === "settled", null, { timeout: 5000 }).catch(() => {});
  check(await card.getAttribute("data-state") === "settled", "a comment settled from its card in chat is settled");
  for (const theme of ["dark", "light"]) {
    await fromChat.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await noSidewaysScroll(fromChat, `a settled review card, ${theme}`);
  }
  await fromChat.close();
}

// `?usage-t2`: the captain's own t2, on the usage-panel mock its scout presented. The words "under pace: lasts past
// the reset" sit twice in the Claude row, which is shut when the page opens, so the author has to be told which row,
// what to open to see it, and be shown it.
{
  const t2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  t2.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await t2.goto(`${baseUrl}/?artifacts&usage-t2`);
  await t2.waitForFunction(() => !document.querySelector(".app-loading"));
  await t2.locator(".nav-item", { hasText: "Artifacts" }).click();
  await t2.locator(".artifact-list .artifact-row", { hasText: "Usage panel: context and plan limits" }).click();
  const usageFrame = t2.frameLocator(".artifact-stage iframe");
  await usageFrame.locator(".prov .prov-head").first().waitFor();
  // Read mode: the captain opens the Claude row, as he did, then picks the 5h cell.
  await usageFrame.locator(".prov .prov-head").first().click();
  await t2.locator(".comment-toggle").click();
  await usageFrame.locator(".prov.open .detail dd").first().click();
  const composer = t2.locator(".comment-composer");
  await composer.waitFor();
  const choice = composer.locator("[data-testid='picture-choice']");
  check(await choice.locator(".picture-toggle").getAttribute("aria-pressed") === "true", "t2: a place words cannot pin down starts with its picture on");
  check((await choice.innerText()).includes("These words are in more than one place · It's inside something you opened"), `t2: the comment box says why (${await choice.innerText()})`);
  await choice.locator("img").waitFor({ timeout: 8000 });
  check(await choice.locator("img").evaluate((image) => image.naturalWidth > 100 && image.naturalHeight > 100), "t2: the page draws itself around the place from inside its sandbox");
  await shot(t2, "23-t2-picture");
  await composer.locator("textarea").fill("what does underpace mean? is this really helpful? I think can remove this column for simplicity?");
  await composer.locator("button", { hasText: "Comment" }).click();
  const t2Thread = t2.locator("[data-testid='review-thread']").first();
  await t2Thread.waitFor();
  check(await t2Thread.locator("img.thread-picture").count() === 1, "t2: the draft keeps its picture");
  await t2.locator(".verdict-picker select").selectOption("changes");
  await t2.locator(".send-review").click();
  await t2.locator(".review-last").waitFor();
  await t2.locator(".nav-item", { hasText: "Chat" }).click();
  const t2Card = t2.locator("[data-testid='review-card']").last();
  const sent = await sentText(t2Card);
  check(await t2Card.locator("[data-thread='t1'] .review-card-picture").count() === 1, "t2: the card marks the comment that went with a picture");
  check((await t2Card.innerText()).includes("qd-usage-design-1 · working"), "t2: the card says the author is at work on it");
  await t2Card.locator(".review-card-text summary").click();
  await t2Card.scrollIntoViewIfNeeded();
  await shot(t2, "24-t2-card");
  for (const line of [
    "t1 on \"under pace: lasts past the reset\": what does underpace mean?",
    "of them on screen",
    "  near     Usage › Plan limits › Claude › 5h",
    "  element  div#pop.pop > div.pop-body > div.sect > div.prov.open[data-prov=claude] > div.detail > dl > dd",
    "/artifacts/usage-panel/review-files/t1-r1.jpg",
    "not a screenshot of the captain's screen",
  ]) check(sent.includes(line), `t2: the author is told ${JSON.stringify(line.trim())}`);
  check(/  match    1 of the \d+ places these words appear in the page's text, 2 of them on screen/.test(sent), "t2: which of the two cells on screen");
  check(!sent.includes("nth-of-type"), "t2: the positional path stays in the log");
  await t2.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall artifact review checks passed");
