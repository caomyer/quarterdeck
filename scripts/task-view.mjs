// Checks a task's output in its own view, in both themes, on the browser mock: the chip each task list row carries for
// what its task produced and where it opens, the list's To review view, every drawer leading with what its task
// produced (a page to review, a page already read, a report read in place, cut, refused or argued, a PR, a PR not yet
// opened, a queued task that produced nothing, a landed one's delivery), what the captain gave it folded under that,
// and the strip above a page back to its task, with its other pages as tabs.
//
// UNREVIEWED DESIGN: this checks `task-list` rev 1's answer to the captain's t5, built on the overnight branch so he can
// see it working. It is his to accept or reject.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm taskview
//
// `?taskview` adds what the tasks produced (src/host/mock.ts). Set ARTIFACT_SHOTS to a folder to also save screenshots
// in both themes.
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

/** Opens the mock with `flags` on resonance's page, links opened outside the app recorded rather than followed. */
async function openProject(flags = "", size = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: size.height } });
  page.on("pageerror", (error) => failures.push(`${flags}: page error: ${error.message}`));
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => { window.__opened.push(String(url)); return null; };
  });
  await page.goto(`${baseUrl}/?artifacts&tasks&taskview${flags}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(".project-shortcuts button", { hasText: "resonance" }).click();
  await page.locator("[data-testid='task-list']").waitFor();
  if (size.width !== 1280) await page.setViewportSize(size);
  return page;
}

const list = (page) => page.locator("[data-testid='task-list']");
const row = (page, id) => list(page).locator(`.tl-row[data-id='${id}']`);
const chipOf = (page, id) => row(page, id).locator(".tl-out-chip");
const drawer = (page) => page.locator(".task-drawer");
const output = (page) => drawer(page).locator("[data-testid='task-output']");
const opened = (page) => page.evaluate(() => window.__opened);

/** The colour a token paints in the current theme. */
const tokenColour = (page, name) => page.evaluate((token) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}, name);

/** Whether `locator`'s `property` is painted with `token`, in both themes. */
async function painted(page, locator, property, token, what) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(300);
    const want = await tokenColour(page, token);
    const got = await locator.evaluate((element, name) => getComputedStyle(element)[name], property);
    check(got === want, `${theme}: ${what} is ${token} (${got})`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

async function openDrawer(page, id) {
  await row(page, id).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await row(page, id).locator(".tl-copy").click();
  await drawer(page).waitFor();
}

async function closeDrawer(page) {
  await page.keyboard.press("Escape");
  await drawer(page).waitFor({ state: "detached" });
}

async function noSidewaysScroll(page, where) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${where}: the window does not scroll sideways (${overflow}px)`);
}

// The row chips: one per task that produced something, strong only for what waits on the captain.
{
  const page = await openProject();
  const chips = await list(page).locator(".tl-out-chip").evaluateAll((items) => Object.fromEntries(items.map((item) => [item.closest(".tl-row").dataset.id, `${item.dataset.strong ? "strong" : "quiet"} ${item.dataset.output}: ${item.textContent}`])));
  check(chips["res-titles-scout"] === "strong page: Page to review · rev 3", `a page the captain has not looked at is a strong chip naming its revision (${chips["res-titles-scout"]})`);
  check(chips["res-codec-scout"] === "strong report: Report to read", `a report a call argues is a strong chip (${chips["res-codec-scout"]})`);
  check(chips["res-snip-export"] === "quiet pr: PR #33", `a ship's PR is a quiet chip (${chips["res-snip-export"]})`);
  check(chips["res-lockscreen"] === "quiet page: Page", `a page already read is a quiet chip (${chips["res-lockscreen"]})`);
  check(Object.keys(chips).length === 4, `a task that produced nothing carries no chip (${Object.keys(chips).join(", ")})`);
  check((await chipOf(page, "res-titles-scout").getAttribute("title")).includes("Not looked at yet"), "a chip's tip says why it wants the captain");
  await painted(page, chipOf(page, "res-titles-scout"), "color", "--blue", "a strong chip");
  await painted(page, chipOf(page, "res-snip-export"), "color", "--muted", "a quiet chip");
  await shot(page, "a1-chips");

  // To review: the tasks whose output waits on the captain, and nothing else.
  const tabs = await list(page).locator(".tl-views button").allInnerTexts();
  check(tabs.map((tab) => tab.replace(/\s+/g, " ")).includes("To review 2"), `To review counts what waits on the captain (${tabs.join(" | ")})`);
  await list(page).locator(".tl-views button", { hasText: "To review" }).click();
  const shown = await list(page).locator(".tl-row").evaluateAll((items) => items.map((item) => item.dataset.id));
  check(JSON.stringify(shown) === JSON.stringify(["res-titles-scout", "res-codec-scout"]), `To review shows exactly those tasks (${shown.join(", ")})`);
  await shot(page, "a2-to-review");
  await list(page).locator(".tl-search input").fill("nothing matches this");
  check((await list(page).locator(".tl-empty").innerText()).includes("No task here matches."), "a search that matches nothing in To review says so");
  await list(page).locator(".tl-search input").fill("");
  await list(page).locator(".tl-views button", { hasText: "Open" }).click();

  // A chip opens what it names, straight past the drawer; the row around it still opens the drawer.
  await chipOf(page, "res-snip-export").click();
  check((await opened(page)).includes("https://github.com/caomyer/Resonance/pull/33"), "a PR chip opens the PR outside the app");
  check(await drawer(page).count() === 0, "and opens no drawer");
  await chipOf(page, "res-codec-scout").click();
  await drawer(page).waitFor();
  await drawer(page).locator("[data-testid='report-text']").waitFor();
  check((await drawer(page).locator("[data-output='report']").getAttribute("data-state")) === "ready", "a report chip opens its task's drawer with the report read");
  await closeDrawer(page);
  await chipOf(page, "res-titles-scout").click();
  await page.locator("[data-screen='artifact']").waitFor();
  check((await page.locator(".page-heading h1").innerText()) === "AI titles for snips", "a page chip opens the page to review");
  await page.locator(".back-button").click();
  await list(page).waitFor();
  // Opening the page marked it read: the list follows.
  await page.waitForFunction(() => document.querySelector(".tl-row[data-id='res-titles-scout'] .tl-out-chip")?.dataset.strong === undefined);
  check((await chipOf(page, "res-titles-scout").innerText()) === "2 pages", "a page once read turns quiet, and names how many there are");
  check((await list(page).locator(".tl-views button", { hasText: "To review" }).innerText()).replace(/\s+/g, " ") === "To review 1", "and leaves To review");
  await noSidewaysScroll(page, "the list");
  await page.close();
}

// The drawers lead with what their task produced.
{
  const page = await openProject();

  // A working scout with a page to review and a page already read.
  await openDrawer(page, "res-titles-scout");
  const headings = await drawer(page).locator(".drawer-section > h3, .drawer-section > .fold-toggle h3").allInnerTexts();
  check(headings[0] === "What it produced" && headings[1] === "What you gave it", `what it produced leads, what it was given follows (${headings.slice(0, 3).join(", ")})`);
  const lines = await output(page).locator("[data-output]").evaluateAll((items) => items.map((item) => `${item.dataset.needs ? "needs " : ""}${item.dataset.page}: ${item.querySelector("small").textContent} [${item.querySelector(".to-act").textContent}]`));
  check(lines[0] === "needs titles-plan: Not looked at yet [Review]", `the page that needs the captain is first and marked (${lines[0]})`);
  check(lines[1] === "model-sizes: Seen · nothing new [Open]", `a page already read says nothing is new (${lines[1]})`);
  check(await output(page).locator("[data-output='no-pr'], [data-output='pr']").count() === 0, "a scout's drawer says nothing about a PR");
  await painted(page, output(page).locator("[data-needs] .to-act"), "color", "--blue", "the page that needs the captain");
  check(await drawer(page).locator("[data-testid='task-body']").count() === 0, "what the captain gave it starts folded");
  check((await drawer(page).locator("[data-testid='task-gave'] .fold-toggle small").innerText()) === "What was asked", "and says what it holds");
  await drawer(page).locator("[data-testid='task-gave'] .fold-toggle").click();
  check(await drawer(page).locator("[data-testid='task-body'] li").count() === 2, "unfolded, it holds what was asked");
  await shot(page, "b1-drawer-pages");
  await output(page).locator("[data-page='model-sizes']").click();
  await page.locator("[data-screen='artifact']").waitFor();
  check((await page.locator(".page-heading h1").innerText()) === "Model sizes", "a page in the drawer opens it");
  check(await drawer(page).count() === 0, "and closes the drawer");
  await page.locator(".back-button").click();
  await list(page).waitFor();

  // A working scout's report, argued by a call, read in place.
  await openDrawer(page, "res-codec-scout");
  const report = output(page).locator("[data-output='report']");
  check((await report.getAttribute("data-needs")) === "true" && (await report.locator("small").innerText()) === "argues a call waiting on you", "a report a call argues says so, and is marked");
  await report.locator(".to-row").click();
  await report.locator("[data-testid='report-text']").waitFor();
  const text = report.locator("[data-testid='report-text']");
  check((await text.locator("h1").innerText()) === "Which codec should snips be stored in?", "the report reads in place, as markdown");
  check(await text.locator("table tr").count() === 3, "with its table");
  check(await text.locator("img").count() === 0 && (await text.innerText()).includes("[a chart that is not loaded]"), "a picture in a report loads nothing, and says what it was");
  await text.locator("a", { hasText: "the Opus support notes" }).click();
  check((await opened(page)).includes("https://opus-codec.org/"), "a link in a report opens outside the app");
  check(await drawer(page).count() === 1, "and leaves the drawer where it was");
  await shot(page, "b2-drawer-report");
  await report.locator(".to-row").click();
  check(await report.locator("[data-testid='report-text']").count() === 0, "the report folds away again");
  await closeDrawer(page);

  // A working ship's PR.
  await openDrawer(page, "res-snip-export");
  const pr = output(page).locator("a[data-output='pr']");
  check((await pr.getAttribute("href")) === "https://github.com/caomyer/Resonance/pull/33" && (await pr.locator("strong").innerText()) === "PR #33", "a ship's PR is a link in what it produced");
  await pr.click();
  check((await opened(page)).includes("https://github.com/caomyer/Resonance/pull/33"), "and opens outside the app");
  await closeDrawer(page);

  // A queued task that produced nothing: its drawer is as it was, Start work first.
  await openDrawer(page, "res-import-crash");
  check(await output(page).count() === 0, "a queued task that produced nothing has no such section");
  check((await drawer(page).locator(".drawer-section > h3").first().innerText()) === "Start work", "and leads with Start work, as before");
  check(!(await drawer(page).innerText()).toLowerCase().includes("worktree"), "a queued task's drawer names no worktree, since it has none");
  await closeDrawer(page);

  // A queued task that carries a page: what it produced leads, then Start work.
  await openDrawer(page, "res-lockscreen");
  const sections = await drawer(page).locator(".drawer-section > h3").allInnerTexts();
  check(sections[0] === "What it produced" && sections[1] === "Start work", `a queued task's page leads, and Start work follows (${sections.slice(0, 2).join(", ")})`);
  check(await drawer(page).locator("[data-testid='task-gave']").count() === 0, "a queued drawer keeps what was asked unfolded, as before");
  await shot(page, "b3-drawer-queued-page");
  await closeDrawer(page);
  await page.close();
}

// A ship that has not opened its PR says so, and offers nothing to open.
{
  const page = await openProject("&no-pr");
  await openDrawer(page, "res-snip-export");
  const none = output(page).locator("[data-output='no-pr']");
  check(await none.count() === 1 && (await none.locator("strong").innerText()) === "No PR yet", "a ship with no PR yet says so");
  check(await none.evaluate((node) => node.tagName) === "DIV" && await none.locator("a, button").count() === 0, "and draws nothing to press");
  check(await chipOf(page, "res-snip-export").count() === 0, "its row carries no chip");
  await closeDrawer(page);
  await page.close();
}

// A report cut past the reader's limit, and one that cannot be read.
{
  const page = await openProject("&report-long");
  await chipOf(page, "res-codec-scout").click();
  await drawer(page).locator("[data-testid='report-cut']").waitFor();
  check((await drawer(page).locator("[data-testid='report-cut']").innerText()).includes("first megabyte of 1270 KB"), "a report cut short says how much of it there is, and where the rest is");
  await page.close();
}
{
  const page = await openProject("&report-refused");
  await chipOf(page, "res-codec-scout").click();
  const problem = drawer(page).locator(".to-problem");
  await problem.waitFor();
  check((await problem.innerText()).includes("is not a plain file, so it is not opened"), "a report that cannot be read says why, in the reader's words");
  await painted(page, problem, "color", "--coral", "a report that cannot be read");
  await shot(page, "b4-report-refused");
  await problem.locator("button", { hasText: "Ask the first mate for it" }).click();
  await page.locator(".composer textarea").waitFor();
  check((await page.locator(".composer textarea").inputValue()) === 'Walk me through the report on "Resonance: which codec should snips be stored in?".', "and asking the first mate is still there, drafted in chat");
  await page.close();
}

// A landed task's drawer, in the logbook, leads with what it delivered.
{
  const page = await openProject();
  await page.waitForFunction(() => document.querySelector("[data-testid='logbook']")?.dataset.state !== "loading");
  await page.locator("[data-testid='log-row'][data-id='res-caption-fix']").click();
  const log = page.locator("[data-testid='log-drawer']");
  await log.waitFor();
  check((await log.locator(".drawer-section > h3").first().innerText()) === "What it delivered", "a landed task leads with what it delivered");
  check((await log.locator("a[data-output='pr'] small").innerText()) === "Merged", "a merged PR says so");
  check(!(await log.innerText()).toLowerCase().includes("worktree"), "a landed task's drawer names no worktree, since it gave its back");
  await closeDrawer(page);
  await page.locator("[data-testid='log-row'][data-id='res-next-scout']").click();
  await log.waitFor();
  await log.locator("[data-output='report'] .to-row").click();
  await log.locator("[data-testid='report-text']").waitFor();
  check((await log.locator("[data-testid='report-text'] h1").innerText()) === "Which audit improvement should come next", "a landed scout's report reads in place");
  check((await log.locator("[data-output='report'] small").innerText()) === "Written up without a page", "and waits on no one");
  await shot(page, "c1-logbook-report");
  await closeDrawer(page);
  await page.locator("[data-testid='log-row'][data-id='res-after-lifecycle']").click();
  await log.waitFor();
  check(await log.locator("[data-testid='task-output']").count() === 0, "a call produced nothing, so its drawer has no such section");
  await closeDrawer(page);
  await page.close();
}

// The strip above a page, back to its task, with the task's pages as tabs.
{
  const page = await openProject();
  await chipOf(page, "res-titles-scout").click();
  const strip = page.locator("[data-testid='page-task-strip']");
  await strip.waitFor();
  check((await strip.locator(".pts-copy strong").innerText()) === "AI titles for snips", "the strip names the task");
  check(JSON.stringify(await strip.locator(".pts-copy small > span:not(.tl-pri)").allInnerTexts()) === JSON.stringify(["resonance", "working"]), "with its project and where it stands");
  check(await strip.locator(".tl-pri").count() === 1, "and its priority");
  await painted(page, strip.locator(".pts-copy small .tone-blue"), "color", "--blue", "a working task's standing in the strip");
  const tabs = await strip.locator(".pts-tabs button").allInnerTexts();
  check(JSON.stringify(tabs) === JSON.stringify(["Model sizes", "AI titles for snips"]), `the task's pages are tabs, oldest presented first (${tabs.join(", ")})`);
  check((await strip.locator(".pts-tabs button.on").innerText()) === "AI titles for snips", "the page on screen is the tab that is on");
  await shot(page, "d1-strip");
  await strip.locator(".pts-tabs button", { hasText: "Model sizes" }).click();
  await page.waitForFunction(() => document.querySelector(".page-heading h1")?.textContent === "Model sizes");
  check((await strip.locator(".pts-tabs button.on").innerText()) === "Model sizes", "a tab opens the task's other page");
  await page.locator(".back-button").click();
  await list(page).waitFor();
  check(await list(page).count() === 1, "back from a tab returns where the page was opened from");

  // The strip opens the task's drawer over the page.
  await chipOf(page, "res-titles-scout").click();
  await strip.waitFor();
  await strip.locator("button.pts-task").click();
  await drawer(page).waitFor();
  check((await drawer(page).locator("[data-testid='drawer-title']").innerText()) === "Resonance: AI titles for snips", "the strip opens the task's drawer");
  check(await page.locator("[data-screen='artifact']").count() === 1, "over the page");
  await shot(page, "d2-strip-drawer");
  await output(page).locator("[data-page='model-sizes']").click();
  await page.waitForFunction(() => document.querySelector(".page-heading h1")?.textContent === "Model sizes");
  check(await drawer(page).count() === 0, "a page opened from that drawer closes it");
  await page.close();
}
{
  const page = await openProject();
  // A queued task's single page: a strip, no tabs.
  await chipOf(page, "res-lockscreen").click();
  const strip = page.locator("[data-testid='page-task-strip']");
  await strip.waitFor();
  check(await strip.locator(".pts-tabs").count() === 0, "a task with one page has no tabs");
  check((await strip.locator(".pts-copy small > span:not(.tl-pri)").allInnerTexts()).includes("Held"), "a held task's strip says so");
  // A chat page belongs to no task.
  await page.locator(".nav-item", { hasText: "Artifacts" }).click();
  await page.locator(".artifact-row", { hasText: "When may the app download the speech model?" }).click();
  await page.locator("[data-screen='artifact']").waitFor();
  check(await strip.count() === 0, "a page shared in chat has no strip");
  await page.locator(".back-button").click();
  // A page whose task the home no longer carries names it and opens nothing.
  await page.locator(".artifact-group-heading", { hasText: "Settled" }).click().catch(() => undefined);
  await page.locator(".artifact-row", { hasText: "What the retired scout found" }).click();
  await strip.waitFor();
  check(await strip.locator("button").count() === 0 && (await strip.locator(".pts-task strong").innerText()) === "res-retired-scout", "a task the home no longer carries is named, and nothing offers to open it");
  check((await strip.locator(".pts-copy small").innerText()) === "No longer in this home", "and says why");
  await shot(page, "d3-strip-gone");
  await page.setViewportSize({ width: 700, height: 900 });
  await noSidewaysScroll(page, "a narrow page with its strip");
  await page.close();
}

// A narrow list keeps each row's chips inside it.
{
  const page = await openProject("", { width: 700, height: 900 });
  await noSidewaysScroll(page, "a narrow list");
  const inside = await row(page, "res-titles-scout").evaluate((node) => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll(".tl-out-chip, .tl-chip")].every((chip) => chip.getBoundingClientRect().right <= box.right + 0.5);
  });
  check(inside, "a narrow row keeps both chips inside it");
  await row(page, "res-snip-export").evaluate((node) => node.scrollIntoView({ block: "start" }));
  await shot(page, "e1-narrow");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n${failures.map((item) => `  - ${item}`).join("\n")}`);
  process.exit(1);
}
console.log("\nA task's output reads right in its row, its drawer and its pages, in every state, in both themes.");
