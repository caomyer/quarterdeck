// Checks the task list on a project's page, in both themes, on the browser mock: the list in place of the Work
// section, start order, the views, sorts and search, the project filter, priority badges kept on every row, the lines
// that join a task to what it waits on, its whole upstream chain lit when pointed at, groups, and every edit and
// refusal the drawer and the list make through firstmate's fm-task-edit.sh (here, the mock's stand-in for it).
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm tasks
//
// `?tasks` adds the backlog in src/host/mock-tasks.ts; `?tasks=loop`, `=wide`, `=deep` and `=stale` add a loop, a
// task nine others wait on, a chain five deep, and an edit the first mate got to first.
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
    await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

/** Opens the mock with `flags` on resonance's page, with its task list drawn. */
async function openList(flags = "", size = { width: 1280, height: 900 }) {
  // The project shortcut lives in the sidebar, which a narrow window folds away: open wide, then narrow.
  const page = await browser.newPage({ viewport: { width: 1280, height: size.height } });
  page.on("pageerror", (error) => failures.push(`${flags}: page error: ${error.message}`));
  await page.goto(`${baseUrl}/?artifacts${flags}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(".project-shortcuts button", { hasText: "resonance" }).click();
  await page.locator("[data-testid='task-list']").waitFor();
  if (size.width !== 1280) await page.setViewportSize(size);
  return page;
}

const list = (page) => page.locator("[data-testid='task-list']");
const row = (page, id) => list(page).locator(`.tl-row[data-id='${id}']`);
const ids = (page, selector = ".tl-row") => list(page).locator(selector).evaluateAll((rows) => rows.map((item) => item.dataset.id));
const scrollTo = (page, id) => row(page, id).evaluate((node) => node.scrollIntoView({ block: "center" }));

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
    // Colours ease between themes; read them once they have settled.
    await page.waitForTimeout(300);
    const want = await tokenColour(page, token);
    const got = await locator.evaluate((element, name) => getComputedStyle(element)[name], property);
    check(got === want, `${theme}: ${what} is ${token} (${got})`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

async function openDrawer(page, id) {
  await scrollTo(page, id);
  await row(page, id).locator(".tl-copy").click();
  const drawer = page.locator(".task-drawer");
  await drawer.waitFor();
  return drawer;
}

async function noSideways(page, what) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${what}: nothing scrolls sideways (${overflow}px)`);
}

const READY = ["res-import-crash", "res-offline-queue", "res-ai-titles", "res-loudness", "res-share-sheet", "res-widget-theme"];
const BLOCKED = ["res-share-preview", "res-transcript-search", "res-foreman-hook", "res-share-stats"];

// A: the list in place of Work, in start order, with its views, sorts, search and project filter.
{
  const page = await openList("&tasks");
  check(await page.locator("[data-testid='project-underway'], [data-testid='project-queue']").count() === 0, "the Work section is gone");
  check(await page.locator(".section-heading h2", { hasText: /^Work$/ }).count() === 0, "and nothing on the page is titled Work");
  check(await page.locator(".primary-nav .nav-item", { hasText: "Tasks" }).count() === 0, "the sidebar has no Tasks destination");
  const open = await ids(page);
  check(open[0] === "res-titles-scout" && (await row(page, "res-titles-scout").getAttribute("data-standing")) === "underway", "underway work leads");
  check(!open.includes("res-transcripts-scout"), "a finished scout waiting to be read stays in Needs you");
  check(!open.includes("res-model-download"), "a call waiting on the captain stays in Needs you");
  check(JSON.stringify(open.slice(1, 1 + READY.length)) === JSON.stringify(READY), `ready work follows in start order: priority, then oldest filed (${open.slice(1, 7).join(", ")})`);
  check(JSON.stringify(open.slice(1 + READY.length, 1 + READY.length + BLOCKED.length)) === JSON.stringify(BLOCKED), "then blocked work, whatever its priority");
  const held = open.slice(1 + READY.length + BLOCKED.length);
  check(held.length === 3 && held.includes("res-chapters") && held.includes("res-storage-cap") && held.includes("res-lockscreen"), "then what is put off or held, last");
  check((await row(page, "res-storage-cap").locator(".tl-chip").innerText()).startsWith("Back "), "a call the captain put off says when it is back");
  check((await row(page, "res-storage-cap").innerText()).includes("You said not now on its call"), "and that it was the captain's not now");
  check(await row(page, "res-storage-cap").locator(".tl-check, .tl-pri-button").count() === 0, "a call is answered, not edited, from the list");
  const tabs = await list(page).locator(".tl-views button").allInnerTexts();
  check(JSON.stringify(tabs.map((tab) => tab.replace(/\s+/g, " "))) === JSON.stringify(["Open 14", "Ready 6", "Blocked 4", "Put off 3"]), `each view counts what it holds (${tabs.join(" | ")})`);
  check((await list(page).locator(".tl-summary").innerText()) === "1 underway · 10 queued · 3 put off", "the heading counts the project's work in words");
  await shot(page, "a1-list");

  await list(page).locator(".tl-views button", { hasText: "Blocked" }).click();
  check(JSON.stringify(await ids(page)) === JSON.stringify(BLOCKED), "Blocked shows only blocked work");
  await list(page).locator(".tl-views button", { hasText: "Put off" }).click();
  check((await ids(page)).length === 3, "Put off shows only what is put off or held");
  await list(page).locator(".tl-views button", { hasText: "Ready" }).click();
  check(JSON.stringify(await ids(page)) === JSON.stringify(READY), "Ready shows only what can start now");
  await list(page).locator(".tl-views button", { hasText: "Open" }).click();

  await list(page).getByLabel("Sort").selectOption("unblocks");
  check((await ids(page, ".tl-row:not([data-standing='underway'])"))[0] === "res-share-sheet", "Unblocks most puts first what the most work waits on");
  check((await row(page, "res-share-sheet").locator(".tl-dep.unblocks").innerText()) === "unblocks 2", "and counts it through every level");
  await list(page).getByLabel("Sort").selectOption("newest");
  check((await ids(page, ".tl-row:not([data-standing='underway'])"))[0] === "res-import-crash", "Newest filed puts today's filing first");
  await list(page).getByLabel("Sort").selectOption("start");

  await list(page).getByLabel("Search this project's tasks").fill("offline");
  check(JSON.stringify(await ids(page)) === JSON.stringify(["res-offline-queue"]), "search narrows the list");
  await list(page).getByLabel("Search this project's tasks").fill("nothing like this");
  check((await list(page).innerText()).includes("No task here matches."), "a search with no match says so");
  await list(page).getByLabel("Search this project's tasks").fill("");

  check(!(await ids(page)).includes("foreman-events-api"), "the list starts filtered to the project");
  await list(page).locator(".tl-filter.on").click();
  check((await ids(page)).includes("foreman-events-api"), "clearing the project filter widens it in place");
  check((await row(page, "foreman-events-api").locator(".tl-project").innerText()) === "foreman", "and each row from elsewhere names its project");
  check((await page.locator(".project-stat").first().innerText()).includes("3"), "while the page's own counts stay the project's");
  await list(page).locator(".tl-filter", { hasText: "only resonance" }).click();
  check(!(await ids(page)).includes("foreman-events-api"), "and it narrows back");
  await noSideways(page, "the list at 1280px");
  await page.close();
}

// B: priority on every row, done rows included, greyed with the row.
{
  const page = await openList("&tasks");
  await painted(page, row(page, "res-import-crash").locator(".tl-pri"), "backgroundColor", "--coral", "a P0 badge");
  check((await row(page, "res-ai-titles").locator(".tl-pri").getAttribute("data-priority")) === "none", "a row with no priority says it counts as Normal");
  check((await row(page, "res-ai-titles").locator(".tl-pri").innerText()) === "P2", "and draws as P2");
  await list(page).getByLabel("Group by").selectOption("group");
  const landed = row(page, "res-share-link");
  check((await landed.getAttribute("data-standing")) === "landed", "a landed task stays under its group");
  check((await landed.locator(".tl-pri").innerText()) === "P2" && (await landed.locator(".tl-pri").getAttribute("data-priority")) === "2", "a landed task keeps its priority badge");
  check((await landed.locator(".tl-pri").getAttribute("class")).includes("dim"), "greyed with its row");
  await painted(page, landed.locator(".tl-pri"), "color", "--faint", "a landed task's badge");
  await painted(page, landed.locator(".tl-copy strong"), "color", "--muted", "a landed task's title");
  await scrollTo(page, "res-share-link");
  await shot(page, "b1-landed-priority");
  await page.close();
}

// C: what a task waits on is drawn, and pointing at it lights its whole upstream chain, quietly.
{
  const page = await openList("&tasks");
  const edges = list(page).locator(".tl-edge");
  check(await list(page).locator(".tl-edge:not(.stub)").count() === 2, "each wait between two listed tasks is a line");
  check(await list(page).locator(".tl-edge.stub").count() === 2, "a blocker this list does not show is a line that leaves it");
  check((await row(page, "res-foreman-hook").locator(".tl-dep.wait").innerText()) === "waits on foreman-events-api · foreman", "and the row names it and its project");
  await painted(page, edges.first().locator("path"), "stroke", "--control-hover", "a line at rest");
  await scrollTo(page, "res-share-stats");
  await row(page, "res-share-stats").hover();
  const lit = await ids(page, ".tl-row.lit");
  check(JSON.stringify(lit.sort()) === JSON.stringify(["res-share-preview", "res-share-sheet", "res-share-stats"]), `pointing at a task lights its whole upstream chain (${lit.join(", ")})`);
  check(await list(page).locator(".tl-edge.lit").count() === 2, "and the lines between them");
  check(await list(page).locator(".tl-list.tracing").count() === 1, "the rest of the lines step back");
  await painted(page, list(page).locator(".tl-edge.lit path").first(), "stroke", "--sea", "a lit line");
  const tint = await row(page, "res-share-sheet").evaluate((node) => getComputedStyle(node).backgroundColor);
  const plain = await row(page, "res-loudness").evaluate((node) => getComputedStyle(node).backgroundColor);
  check(tint !== plain, "a row in the chain is tinted");
  const opacity = await row(page, "res-loudness").evaluate((node) => getComputedStyle(node).opacity);
  check(opacity === "1", "and the rows outside it are left as they were");
  await shot(page, "c1-chain");
  await row(page, "res-share-sheet").hover();
  check(JSON.stringify(await ids(page, ".tl-row.lit")) === JSON.stringify(["res-share-sheet"]), "a task at the root lights only itself");
  await row(page, "res-share-stats").focus();
  check((await ids(page, ".tl-row.lit")).length === 3, "focusing a task lights its chain too");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await list(page).locator(".tl-edge path").first().evaluate((node) => parseFloat(getComputedStyle(node).transitionDuration));
  check(duration < 0.001, `with reduced motion the lines change without easing (${duration}s)`);
  await page.close();

  // A long chain, most of it out of sight.
  const tall = await openList("&tasks=deep", { width: 1280, height: 560 });
  await row(tall, "res-deep-5").evaluate((node) => node.scrollIntoView({ block: "start" }));
  await tall.locator(".content-scroll").evaluate((node) => node.scrollBy(0, -30));
  await row(tall, "res-deep-5").hover();
  await tall.locator("[data-testid='chain-above']").waitFor({ timeout: 3000 }).catch(() => {});
  check(await tall.locator("[data-testid='chain-above']").count() === 1, "when part of the chain is scrolled away, the list says how much");
  const above = await tall.locator("[data-testid='chain-above']").innerText();
  check(/^↑ \d+ more of its chain above$/.test(above), `in words (${above})`);
  check((await ids(tall, ".tl-row.lit")).length === 5, "and every task in it is still lit");
  await shot(tall, "c2-chain-out-of-sight");
  await tall.close();
}

// D: editing: priority from the list, a stale edit, a loop refused, putting off, and work in flight locked.
{
  const page = await openList("&tasks");
  await scrollTo(page, "res-widget-theme");
  await row(page, "res-widget-theme").locator(".tl-pri-button").click();
  const menu = list(page).locator(".tl-menu");
  check(await menu.count() === 1 && (await menu.innerText()).includes("Never started unasked".replace("Never", "never")), "the priority menu says what each level means to the first mate");
  await shot(page, "d1-priority-menu");
  await menu.getByRole("option", { name: /High/ }).click();
  await page.waitForFunction(() => document.querySelector("[data-row-id='res-widget-theme'] .tl-pri")?.textContent === "P1");
  const ready = await ids(page, ".tl-row[data-standing='ready']");
  check(JSON.stringify(ready.slice(0, 3)) === JSON.stringify(["res-import-crash", "res-widget-theme", "res-offline-queue"]), `raising it moves it up the start order (${ready.slice(0, 3).join(", ")})`);
  await page.close();

  const stale = await openList("&tasks=stale");
  await scrollTo(stale, "res-widget-theme");
  await row(stale, "res-widget-theme").locator(".tl-pri-button").click();
  await list(stale).locator(".tl-menu").getByRole("option", { name: /High/ }).click();
  await list(stale).locator(".tl-notice").waitFor();
  check((await list(stale).locator(".tl-notice").innerText()).startsWith("Not changed: its priority changed to 3 while your window showed 4"), "an edit from a stale window is refused, naming the value that won");
  await stale.waitForFunction(() => document.querySelector("[data-row-id='res-widget-theme'] .tl-pri")?.textContent === "P3");
  check(true, "and the list shows the first mate's value");
  await shot(stale, "d2-stale");
  await stale.close();

  const loop = await openList("&tasks");
  const drawer = await openDrawer(loop, "res-share-sheet");
  const details = drawer.locator("[data-testid='task-details']");
  check(await details.count() === 1, "a queued task's drawer has its Details");
  await details.getByRole("button", { name: "Add" }).click();
  await details.getByLabel("Wait on").selectOption("res-share-stats");
  const refusal = details.locator(".td-refusal");
  await refusal.waitFor();
  check((await refusal.getAttribute("data-code")) === "loop", "waiting on a task downstream is refused as a loop");
  check((await refusal.innerText()).includes("res-share-stats already waits on res-share-sheet through res-share-preview"), "and the refusal names the path");
  await shot(loop, "d3-loop-refused");
  check((await drawer.locator("[data-testid='waiting-on-this']").innerText()).includes("A link preview that plays the snip"), "the drawer says what waits on this task");

  await loop.keyboard.press("Escape");
  const crash = await openDrawer(loop, "res-import-crash");
  const until = await crash.getByLabel("Put off until").inputValue();
  await crash.locator("[data-testid='task-details']").getByRole("button", { name: "Put off" }).click();
  await loop.waitForFunction(() => document.querySelector("[data-row-id='res-import-crash']")?.getAttribute("data-standing") === "held");
  check((await row(loop, "res-import-crash").locator(".tl-chip").innerText()).startsWith("Back "), `putting a task off moves it to Put off until ${until}`);
  check((await crash.locator("[data-testid='start-status']").innerText()).startsWith("Put off until"), "and its drawer says so");
  await crash.locator("[data-testid='task-details']").getByRole("button", { name: "Bring back" }).click();
  await loop.waitForFunction(() => document.querySelector("[data-row-id='res-import-crash']")?.getAttribute("data-standing") === "ready");
  check(true, "Bring back returns it to the queue");
  await loop.keyboard.press("Escape");

  const running = await openDrawer(loop, "res-titles-scout");
  const lock = running.locator("[data-testid='details-lock']");
  check(await lock.count() === 1 && (await lock.innerText()).includes("briefed as a scout in a resonance worktree"), "work in flight says why its project and kind stay");
  check(await running.locator(".td-field.locked", { hasText: "resonance" }).count() === 1 && await running.locator(".td-field.locked", { hasText: "Scout" }).count() === 1, "and draws them locked");
  check(await running.getByLabel("Priority").count() === 1, "while its priority still changes");
  await shot(loop, "d4-in-flight-locked");
  await lock.getByRole("button", { name: "Ask the first mate to re-scope it" }).click();
  check((await loop.locator(".composer textarea").inputValue()).startsWith("Can you re-scope res-titles-scout?"), "asking to re-scope drafts the message in chat");
  await loop.close();
}

// E: the chain in a drawer: its tree, where to start, and a deep chain, a wide one and a loop.
{
  const page = await openList("&tasks");
  const drawer = await openDrawer(page, "res-share-stats");
  const chain = drawer.locator("[data-testid='task-chain']");
  check(JSON.stringify(await chain.locator("[data-chain-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.chainId))) === JSON.stringify(["res-share-preview", "res-share-sheet"]), "the chain lists every task this one waits on, nearest first");
  check((await drawer.locator("[data-testid='start-here']").innerText()).includes("Share a snip from the share sheet is ready"), "and names where to start");
  await shot(page, "e1-chain-drawer");
  await drawer.locator("[data-testid='start-here']").getByRole("button", { name: "Open it" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid='drawer-title']")?.textContent === "Share a snip from the share sheet");
  check(true, "Open it opens the task to start, where Start work is");
  await page.close();

  const deep = await openList("&tasks=deep");
  const deepDrawer = await openDrawer(deep, "res-deep-5");
  const deepChain = deepDrawer.locator("[data-testid='task-chain']");
  check(await deepChain.locator("[data-chain-id]").count() === 3, "a deep chain shows three levels");
  check((await deepChain.locator(".td-more.deeper").innerText()).includes("1 more level"), "and folds the rest");
  check((await deepDrawer.locator("[data-testid='start-here']").innerText()).includes("Step 1 of the offline sync"), "while where to start is shown even folded");
  await deepChain.locator(".td-more.deeper").click();
  check(await deepChain.locator("[data-chain-id]").count() === 4, "unfolding shows the whole chain");
  await deep.close();

  const wide = await openList("&tasks=wide");
  check((await row(wide, "res-share-sheet").locator(".tl-dep.unblocks").innerText()) === "unblocks 11", "a task many wait on counts them all");
  const wideDrawer = await openDrawer(wide, "res-share-sheet");
  const waiting = wideDrawer.locator("[data-testid='waiting-on-this']");
  check(await waiting.locator(".td-waiting > button:not(.td-more)").count() === 4, "Waiting on this shows four");
  check((await waiting.locator(".td-more").innerText()) === "+6 more", "and counts the rest");
  await shot(wide, "e2-wide");
  await wide.close();

  const loop = await openList("&tasks=loop");
  check((await row(loop, "res-loop-a").getAttribute("data-standing")) === "blocked", "a task in a loop is blocked");
  const loopDrawer = await openDrawer(loop, "res-loop-a");
  const warning = loopDrawer.locator("[data-testid='chain-loop']");
  check((await warning.innerText()).includes("These tasks wait on each other"), "the drawer says the tasks wait on each other");
  await shot(loop, "e3-loop");
  await warning.getByRole("button", { name: /Remove res-loop-a/ }).click();
  await loop.waitForFunction(() => document.querySelector("[data-row-id='res-loop-a']")?.getAttribute("data-standing") === "ready");
  check(await loopDrawer.locator("[data-testid='chain-loop']").count() === 0, "removing one wait breaks the loop");
  await loop.close();
}

// F: groups: Group by, a group's drawer, a new group from several tasks, and no tag a captain would not use.
{
  const page = await openList("&tasks");
  await list(page).getByLabel("Group by").selectOption("group");
  const heads = list(page).locator(".tl-group");
  check(JSON.stringify(await heads.evaluateAll((nodes) => nodes.map((node) => node.dataset.groupId))) === JSON.stringify(["g-share-snips-anywhere", "g-audio-that-sounds-right"]), "groups lead, by their own priority");
  check((await heads.first().innerText()).includes("1 of 5 landed"), "each says how far through its tasks it is");
  check(!/proposed/i.test(await list(page).innerText()), "no row or group carries a proposed tag");
  check((await list(page).locator(".tl-label", { hasText: "Not in a group" }).count()) === 1, "work in no group follows");
  await shot(page, "f1-group-by");
  await heads.first().click();
  const drawer = page.locator("[data-testid='group-drawer']");
  await drawer.waitFor();
  check(await drawer.locator("[data-testid='group-members'] > button").count() === 5, "a group's drawer lists its tasks, landed ones too");
  check(await drawer.getByRole("button", { name: "Close the group" }).isDisabled(), "a group with open tasks cannot close");
  check((await drawer.innerText()).includes("It closes once its 4 open tasks have landed."), "and says when it can");
  await shot(page, "f2-group-drawer");
  await page.keyboard.press("Escape");
  await list(page).getByLabel("Group by").selectOption("none");

  await scrollTo(page, "res-widget-theme");
  await row(page, "res-widget-theme").locator(".tl-check").check();
  await row(page, "res-ai-titles").locator(".tl-check").check();
  const bulk = page.locator("[data-testid='bulk-bar']");
  check((await bulk.innerText()).startsWith("2 selected"), "selecting rows brings the bulk bar");
  await shot(page, "f3-bulk");
  await bulk.getByLabel("Group for the selected tasks").selectOption("new");
  await bulk.getByLabel("New group's name").fill("Widgets and polish");
  await bulk.getByRole("button", { name: "Add" }).click();
  await list(page).locator(".tl-notice").waitFor();
  check((await list(page).locator(".tl-notice").innerText()) === "Added to Widgets and polish for 2 tasks.", "a new group takes the selected tasks");
  await page.waitForFunction(() => document.querySelectorAll(".tl-dep.group").length >= 7);
  check((await row(page, "res-widget-theme").locator(".tl-dep.group").innerText()) === "Widgets and polish", "each row names its new group");
  await list(page).getByLabel("Group by").selectOption("group");
  check((await list(page).locator(".tl-group[data-group-id='g-widgets-and-polish']").innerText()).includes("0 of 2 landed"), "and Group by shows it");
  await page.close();
}

// G: a home whose firstmate cannot edit a task yet reads the list and changes nothing.
{
  const page = await openList("");
  check(await list(page).count() === 1, "the list still stands in for Work");
  check(await list(page).locator(".tl-check, .tl-pri-button").count() === 0, "with nothing to change it with");
  await list(page).locator(".tl-row[data-id='res-lockscreen'] .tl-copy").click();
  const drawer = page.locator("[data-testid='queued-drawer']");
  await drawer.waitFor();
  check(await drawer.locator("[data-testid='task-details']").count() === 0, "and its drawers offer no edits");
  await page.close();
}

// H: the narrow window.
{
  const page = await openList("&tasks", { width: 400, height: 860 });
  await noSideways(page, "the list at 400px");
  const width = await row(page, "res-offline-queue").locator(".tl-copy strong").evaluate((node) => node.getBoundingClientRect().width);
  check(width > 150, `a title keeps most of a narrow row (${Math.round(width)}px)`);
  await scrollTo(page, "res-share-stats");
  await shot(page, "h1-narrow");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nThe task list reads, sorts, draws its chains and takes edits right, in both themes.");
