// Checks a project's page on the browser mock: what waits on the captain there, what is underway and up next,
// and the logbook of closed work: its filters, search, the rows closed without a delivery, a closed task's
// details, paging through older work, and a home whose firstmate cannot list it or fails to.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm projects
//
// Set ARTIFACT_SHOTS to a folder to also save screenshots in both themes.
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
    await page.screenshot({ path: join(shots, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

/** Opens the mock with `flags` and goes to a project's page, once its logbook has been read. */
async function openProject(page, name, flags = "") {
  await page.goto(`${baseUrl}/?artifacts${flags}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(".project-shortcuts button", { hasText: name }).click();
  await page.locator("[data-testid='project-page']").waitFor();
  await page.waitForFunction(() => document.querySelector("[data-testid='logbook']")?.dataset.state !== "loading");
}

const logRows = (page) => page.locator("[data-testid='log-row']");
const logIds = (page) => logRows(page).evaluateAll((rows) => rows.map((row) => row.dataset.id));

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));

// The page: the project's own calls, what is underway, what is queued, and every count agreeing.
await openProject(page, "resonance");
const shortcut = await page.locator(".project-shortcuts button", { hasText: "resonance" }).innerText();
check(shortcut.includes("3 waiting · 1 underway"), `the sidebar counts resonance's calls and its work underway (${shortcut.replace(/\n/g, " ")})`);
check((await page.locator("[data-testid='stat-waiting'] strong").innerText()) === "3", "the page counts the three calls waiting in this project");
const needs = page.locator("[data-testid='project-needs'] .task-row");
check(await needs.count() === 3, "Needs you lists resonance's three open calls");
check(await page.locator("[data-testid='project-needs']").getByText("keep merging", { exact: false }).count() === 0, "another project's call is not listed");
check(await page.locator("[data-testid='project-underway'] .task-row").count() === 1, "a finished scout waiting to be read is not underway");
const queue = page.locator("[data-testid='project-queue'] .task-row");
check(await queue.count() === 2, "Up next lists the project's two queued rows");
check(/\bwaiting\b/i.test(await queue.nth(1).locator(".task-chip").innerText()), "a queued row held on something says so");
check(!(await page.locator("[data-testid='project-page']").innerText()).includes("Resonance:"), "titles drop the project name the page already says");
await shot(page, "project");

// A queued task opens, and reads the way its filer wrote it.
await page.locator("[data-testid='project-queue'] .task-row[data-id='res-lockscreen']").click();
const queued = page.locator("[data-testid='queued-drawer']");
await queued.waitFor();
check((await queued.locator("[data-testid='drawer-title']").innerText()) === "Snip from the Lock Screen and AirPods", "a queued task opens, titled within its project");
check((await queued.locator(".drawer-status").innerText()).includes("Waits on the snip lifecycle work landing"), "and says what it waits on");
const body = queued.locator(".drawer-section", { hasText: "What was asked" }).locator("[data-testid='task-body']");
check(await body.locator("p").count() === 3, "each line the filer wrote stays its own paragraph");
check(await body.locator("li").count() === 2, "the filer's list stays a list");
check(JSON.stringify(await body.locator(".body-label").allInnerTexts()) === JSON.stringify(["SYMPTOM", "WHAT TO BUILD"]), "labels in capitals lead their paragraphs");
check((await body.locator("code").innerText()) === "MPRemoteCommandCenter", "backticks read as code");

// What the task carries beside its row: the picture a worker is handed as a path, and the notes for whoever works it.
const sections = await queued.locator(".drawer-section > h3").allInnerTexts();
check(sections[0] === "Start work" && sections[1] === "File" && sections[2] === "What was asked", `Start work comes first, then the evidence, then what was asked (${sections.slice(0, 3).join(", ")})`);
const file = queued.locator("[data-testid='task-file']");
check(await file.locator("img").count() === 1, "a picture on the task shows as a thumbnail");
check((await file.locator("code").innerText()).endsWith("/data/res-lockscreen/files/Lock-Screen-9.41-AM.png"), "with the clean path a worker is handed");
check((await file.locator("strong").innerText()) === "Lock Screen 9.41\u202fAM.png", "and the name it had when it was added");
await file.locator("button.task-file-thumb").click();
check(await page.locator("[data-testid='picture-view']").count() === 1, "the thumbnail opens the whole picture");
await shot(page, "project-queued-picture");
await page.keyboard.press("Escape");
check(await page.locator("[data-testid='picture-view']").count() === 0 && await queued.count() === 1, "Escape closes the picture and leaves the task open");
const notes = queued.locator("[data-testid='task-note']");
check(await notes.count() === 2, "the task's notes are listed, oldest first");
check((await notes.nth(1).innerText()).includes("Changes scope"), "a note that changes scope says so");
check(await queued.locator("[data-testid='note-composer'] button", { hasText: "Add to task" }).isDisabled(), "an empty note cannot be added");
await shot(page, "project-queued");

// The captain adds evidence: words and a file, kept on the task through firstmate's writer.
await queued.getByLabel("Add a note to this task").fill("The widget should snip even when Focus is on.");
await queued.locator("[data-testid='note-composer'] button", { hasText: "Files" }).click();
check(await queued.locator("[data-testid='note-composer'] .file-chip").count() === 2, "picked files wait on the note until it is added");
await queued.locator("[data-testid='note-composer'] .file-chip", { hasText: "Release brief" }).getByRole("button").click();
await queued.locator("[data-testid='note-composer'] button", { hasText: "Add to task" }).click();
await page.waitForFunction(() => document.querySelectorAll("[data-testid='queued-drawer'] [data-testid='task-note']").length === 3);
const added = notes.nth(2);
check((await added.locator("header strong").innerText()) === "You", "the note is the captain's");
check((await added.innerText()).includes("snip even when Focus is on"), "with the captain's words");
check((await queued.locator("[data-testid='task-file'] code").nth(1).innerText()).endsWith("/files/cran-2026-09-22.png"), "and the file under a name safe to hand a worker");
check((await queued.getByLabel("Add a note to this task").inputValue()) === "", "the composer clears once the note is kept");
check((await queued.locator(".note-hint").innerText()).includes("handed to whoever works it"), "a queued task says who receives the note");
await page.keyboard.press("Escape");
check(await queued.count() === 0, "Escape closes a queued task");

// A refused note keeps the captain's words and says why, in firstmate's words.
await openProject(page, "resonance", "&note-refused");
await page.locator("[data-testid='project-queue'] .task-row[data-id='res-lockscreen']").click();
await queued.getByLabel("Add a note to this task").fill("See the attached recording.");
await queued.locator("[data-testid='note-composer'] button", { hasText: "Add to task" }).click();
await queued.locator(".attach-problems").waitFor();
check((await queued.locator(".attach-problems").innerText()).includes("over the 104857600 cap"), "a refused note says why");
check((await queued.getByLabel("Add a note to this task").inputValue()) === "See the attached recording.", "and keeps what the captain wrote");

// A firstmate that keeps no notes shows no notes, and a failed read offers to try again.
await openProject(page, "resonance", "&no-notes");
await page.locator("[data-testid='project-queue'] .task-row[data-id='res-lockscreen']").click();
check(await queued.locator("[data-testid='task-files'], [data-testid='note-composer']").count() === 0, "without fm-task-note.sh there is no Files or Notes section");
await openProject(page, "resonance", "&notes-error");
await page.locator("[data-testid='project-queue'] .task-row[data-id='res-lockscreen']").click();
check(await queued.locator("[data-testid='notes-error']").count() === 1, "a failed notes read says so and offers to try again");
await openProject(page, "resonance");

// The logbook: every closed row once, newest first, with the rows that delivered nothing hidden until asked for.
const ids = await logIds(page);
check(new Set(ids).size === ids.length, "each closed task appears once, though the snapshot and the history both list recent ones");
check(ids.indexOf("res-first-light") === ids.length - 1, "the oldest work comes last");
check(!ids.includes("res-share-spike"), "work closed without a delivery is hidden");
check((await page.locator("[data-testid='log-count']").innerText()) === String(ids.length), "the logbook counts what it shows");
check((await page.locator(".logbook-period").first().getAttribute("data-period")) === "week", "this week's work comes first");
const periods = await page.locator(".logbook-period h3").allInnerTexts();
check(periods.length >= 3 && periods.at(-1) !== "THIS WEEK", `older work is filed by month (${periods.join(", ")})`);
await page.locator("[data-testid='toggle-closed']").click();
check((await logIds(page)).includes("res-share-spike"), "asking for them shows the tasks closed without a delivery");
check((await page.locator("[data-testid='log-row'][data-id='res-share-spike']").innerText()).includes("Closed"), "such a row says it only closed");
await page.locator("[data-testid='toggle-closed']").click();

// Filters and search.
await page.locator(".logbook-filters button", { hasText: "Decisions" }).click();
const kinds = await logRows(page).evaluateAll((rows) => rows.map((row) => row.dataset.kind));
check(kinds.length > 0 && kinds.every((kind) => kind === "decision"), `Decisions shows only calls (${kinds.length})`);
const decisionsChip = await page.locator(".logbook-filters button", { hasText: "Decisions" }).locator("span").innerText();
check(decisionsChip === String(kinds.length), "the Decisions filter counts what it shows");
await page.locator(".logbook-filters button", { hasText: "All" }).click();
await page.getByLabel("Search this project's work").fill("wi-fi");
check(JSON.stringify(await logIds(page)) === JSON.stringify(["res-upload-wifi"]), "the search finds a call by its answer");
await page.getByLabel("Search this project's work").fill("nothing like this");
check((await page.locator("[data-testid='logbook']").innerText()).includes("Nothing closed matches."), "a search with no match says so");
await page.locator("[data-testid='logbook']").getByRole("button", { name: "Show everything" }).click();
check((await page.getByLabel("Search this project's work").inputValue()) === "", "Show everything clears the search");

// A closed task's details.
await page.locator("[data-testid='log-row'][data-id='res-after-lifecycle']").click();
const drawer = page.locator("[data-testid='log-drawer']");
await drawer.waitFor();
const drawerText = await drawer.innerText();
check(drawerText.includes("You chose AI titles"), "a decision's details say what the captain chose");
check(drawerText.includes("Answered by you here"), "and where they answered");
check(drawerText.includes("What should follow the snip lifecycle work?"), "and the question");
await shot(page, "project-log-decision");
await page.keyboard.press("Escape");
check(await drawer.count() === 0, "Escape closes the details");
await page.locator("[data-testid='log-row'][data-id='res-caption-fix']").click();
check(await drawer.locator("a[href='https://github.com/caomyer/Resonance/pull/6']").count() === 1, "shipped work links its PR");
check((await drawer.innerText()).includes("took 2 days"), "and says how long it took");
await page.locator("[data-testid='project-page'] .section-heading").first().click();
check(await drawer.count() === 0, "a click outside closes the details");

// A call opened from the project page is answered on its card on Bearings.
await needs.first().click();
await page.locator(".decision-card.focused").waitFor({ timeout: 3000 }).catch(() => {});
check(await page.locator(".decision-card.focused").count() === 1, "opening a call from the project shows its card on Bearings");

// The narrow window.
await openProject(page, "resonance");
await page.setViewportSize({ width: 400, height: 860 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, `the narrow page does not scroll sideways (${overflow}px)`);
const titleWidth = await logRows(page).first().locator(".task-copy strong").evaluate((node) => node.getBoundingClientRect().width);
check(titleWidth > 180, `a logbook title keeps most of a narrow row (${Math.round(titleWidth)}px)`);
await shot(page, "project-narrow");
await page.setViewportSize({ width: 1280, height: 900 });

// Another project's logbook is its own: foreman's PR, and the first mate's call to merge it.
await openProject(page, "foreman");
check(JSON.stringify(await logIds(page)) === JSON.stringify(["foreman-merge-24", "foreman-rebase-before-review"]), "foreman's logbook holds only foreman's closed work");
check((await logRows(page).first().innerText()).includes("Decided for you"), "a call the first mate settled says so");

// Paging: the counts are floors until the last page, and a search says how far back it looked.
await openProject(page, "resonance", "&history-page=5");
check((await page.locator("[data-testid='log-count']").innerText()).endsWith("+"), "with older work unread, the count says there is more");
const firstPage = (await logIds(page)).length;
await page.getByLabel("Search this project's work").fill("first light");
check(await page.locator("[data-testid='log-partial']").count() === 1, "a search over the first page says how far back it looked");
check(await page.locator("[data-testid='log-more']").count() === 0, "and offers one way further back, not two");
for (let turn = 0; turn < 5 && await page.locator("[data-testid='log-further']").count(); turn += 1) {
  await page.locator("[data-testid='log-further']").click();
  await page.waitForFunction(() => !document.querySelector("[data-testid='log-further']")?.textContent?.includes("Reading"));
}
check(JSON.stringify(await logIds(page)) === JSON.stringify(["res-first-light"]), "looking further back finds the oldest work");
await page.getByLabel("Search this project's work").fill("");
check((await logIds(page)).length > firstPage, "the pages read stay read");
check(!(await page.locator("[data-testid='log-count']").innerText()).endsWith("+"), "once everything is read, the count is exact");

// A firstmate that cannot list history still shows the snapshot's recent work, and says why there is no more.
await openProject(page, "resonance", "&no-history");
const recentOnly = await logIds(page);
check(recentOnly.length > 0 && !recentOnly.includes("res-first-light"), `without history the logbook shows the recent closed rows (${recentOnly.length})`);
check((await page.locator("[data-testid='logbook']").innerText()).includes("can't list older work yet"), "and says why older work is missing");

// A history read that fails keeps the recent rows and offers to try again.
await openProject(page, "resonance", "&history-error");
check(await page.locator("[data-testid='log-error']").count() === 1, "a failed read says so");
check((await logIds(page)).length > 0, "and the recent rows still show");

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll project page checks passed.");
