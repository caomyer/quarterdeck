// Checks the artifact review flow on the browser mock: the Artifacts list, the review screen,
// revisions, the narrow width, accepted layout findings, the sandbox, and the ways in from chat,
// the task drawer and back.
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
check((await rows.nth(1).innerText()).includes("resonance · res-titles-scout · Rev 2"), "a task page names its project, task and revision");
check(await rows.nth(1).locator(".artifact-flag").innerText() === "May look off in a narrow window", "a page presented with narrow findings says so quietly");
check(await rows.nth(0).locator(".artifact-flag").count() === 0, "a clean page carries no flag");
await noSidewaysScroll(page, "list");
await shot(page, "01-list");

// The review screen.
await rows.nth(1).click();
const frame = page.frameLocator(".artifact-stage iframe");
await frame.locator("h1").waitFor();
check(await page.locator(".page-heading h1").innerText() === "AI titles for snips", "the review screen is titled by the page");
check(await page.locator(".page-heading span").innerText() === "resonance · res-titles-scout · Rev 2 of 2", "the subtitle names the owner and revision");
check((await frame.locator(".eyebrow").textContent()).includes("revised"), "the latest revision opens by default");
check((await page.locator(".revision-note").innerText()).includes("Measured the on-device model"), "the revision says what changed");
const sandbox = await page.locator(".artifact-stage iframe").getAttribute("sandbox");
check(sandbox === "allow-scripts allow-forms allow-downloads", `the frame is sandboxed without same-origin or top navigation (${sandbox})`);
const reachesApp = await page.frames().find((candidate) => candidate.url().includes("/artifacts/"))
  .evaluate(() => { try { return Boolean(window.parent.document.body); } catch { return false; } });
check(!reachesApp, "the page cannot reach into the app");
check(await page.locator(".artifact-loading").count() === 0, "the loading note clears once the page loads");
await noSidewaysScroll(page, "review");
await shot(page, "02-review");

// Accepted layout findings.
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
check(await page.locator(".page-heading span").innerText() === "resonance · res-titles-scout · Rev 1 of 2", "the subtitle follows the picked revision");
check(await page.locator(".layout-flag").count() === 0, "a revision with a clean check has no flag");

// Back to where it was opened from.
await page.locator(".back-button").click();
check(await page.locator("[data-screen='artifacts']").count() === 1, "back returns to the list");

// From chat.
await page.locator(".nav-item", { hasText: "Chat" }).click();
const cards = page.locator("[data-testid='artifact-card']");
await cards.first().waitFor();
check(await cards.count() === 3, `chat shows each revision presented in the last day (${await cards.count()})`);
check((await cards.nth(0).innerText()).includes("shared a page"), "the first revision reads as a shared page");
check((await cards.nth(1).innerText()).includes("revised a page · Rev 2"), "a later revision reads as a revision");
check((await cards.nth(2).innerText()).includes("The first mate shared a page"), "a first mate page says who shared it");
await noSidewaysScroll(page, "chat");
await shot(page, "05-chat");
await cards.nth(0).locator("button").click();
await frame.locator("h1").waitFor();
check(await page.locator(".page-heading span").innerText() === "resonance · res-titles-scout · Rev 1 of 2", "a chat card opens the revision it announced");
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
