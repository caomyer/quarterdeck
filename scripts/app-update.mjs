// Checks the app's own update in the sidebar on the browser mock: quiet without one, what an update waiting says and
// does, a restart that waits for the first mate's turn to end, a failed install, and the note after the restart.
//
//   pnpm dev --port 4194 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4194 pnpm updates
//
// Each state is the mock's `?update=<state>` (src/host/mock-update.ts). Set ARTIFACT_SHOTS to a folder to also save
// screenshots in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4194. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

async function open(query, { clock = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => failures.push(`${query}: ${error.message}`));
  if (clock) await page.clock.install();
  await page.goto(`${baseUrl}/${query}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(".sidebar-footer").waitFor();
  return page;
}

const notice = (page) => page.locator(".update-notice");
const said = (page) => notice(page).innerText();

async function shot(page, name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `update-${name}-${theme}.png`), clip: { x: 0, y: 560, width: 268, height: 340 } });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

/** Both themes draw the notice on the sidebar, which is dark in each: its words must read against it. */
async function readable(page, what) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    const colours = await page.evaluate(() => {
      const title = document.querySelector(".update-words strong");
      const sidebar = document.querySelector(".sidebar");
      return title && sidebar ? { ink: getComputedStyle(title).color, ground: getComputedStyle(sidebar).backgroundColor } : null;
    });
    check(colours && colours.ink !== colours.ground && !colours.ink.includes("rgba(0, 0, 0, 0)"), `${what}: the title has its own ink in the ${theme} theme`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

// No update: nothing in the sidebar says anything about one.
{
  const page = await open("");
  await page.waitForTimeout(600);
  check(await notice(page).count() === 0, "without an update the sidebar says nothing about one");
  await page.close();
}

// One found after the page opened, as the backend's background check finds it.
{
  const page = await open("?update=late");
  check(await notice(page).count() === 0, "before the check finds one, nothing shows");
  await notice(page).waitFor({ timeout: 5000 });
  check((await said(page)).includes("Update ready: 0.1.42"), "an update found later appears on its own");
  await page.close();
}

// Waiting: what it is, what restarting does, the notes behind What's new, and a restart while the first mate is idle.
{
  const page = await open("?update=ready");
  await notice(page).waitFor();
  const text = await said(page);
  check(text.includes("Update ready: 0.1.42"), "an update waiting names its version");
  check(text.includes("installs when you quit"), "and says quitting installs it too");
  check(await notice(page).getByRole("button", { name: "Restart", exact: true }).isVisible(), "with the one button that acts");
  check(await page.locator(".update-notes").count() === 0, "its notes stay folded until asked for");
  await notice(page).getByRole("button", { name: "What's new", exact: true }).click();
  const notes = await page.locator(".update-notes li").allInnerTexts();
  check(notes.length === 3 && notes[0].startsWith("Usage panel"), "What's new lists the release's changes, one per line, without list markers");
  await readable(page, "ready");
  await shot(page, "ready");
  await notice(page).getByRole("button", { name: "Restart", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".update-notice")?.textContent?.includes("Installing 0.1.42"), null, { timeout: 5000 });
  check(true, "restarting while the first mate is idle installs at once");
  await page.waitForFunction(() => document.querySelector(".update-notice")?.textContent?.includes("Updated to 0.1.42"), null, { timeout: 5000 });
  check((await said(page)).includes("From 0.1.41"), "after the restart it says once what it updated from");
  await notice(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".update-notice"), null, { timeout: 3000 });
  check(true, "and dismissed, it is gone");
  await page.close();
}

// A restart asked for mid-turn waits for the turn to end, says so, and can be taken back.
{
  const page = await open("?update=ready", { clock: true });
  await notice(page).waitFor();
  await page.locator(".primary-nav .nav-item", { hasText: "Chat" }).click();
  await page.locator(".composer textarea").fill("Check the fleet.");
  // The mock's turn is over in a moment, so its clock is held while the turn runs, however slow the machine.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator(".send-button").click();
  await page.clock.runFor(50);
  await page.waitForFunction(() => document.querySelector(".chat-status")?.textContent?.includes("Working"), null, { timeout: 8000 });
  check((await said(page)).includes("Restarts once the current turn ends"), "mid-turn, the update says a restart waits for the turn");
  await notice(page).getByRole("button", { name: "Restart", exact: true }).click();
  await notice(page).filter({ hasText: "Waiting for the current turn to end" }).waitFor({ timeout: 5000 });
  check(true, "and while it waits, it says so");
  await readable(page, "waiting");
  await shot(page, "waiting");
  await notice(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await notice(page).filter({ hasText: "Update ready" }).waitFor({ timeout: 3000 });
  check(true, "a waiting restart can be taken back");
  await notice(page).getByRole("button", { name: "Restart", exact: true }).click();
  await notice(page).filter({ hasText: "Waiting for the current turn" }).waitFor({ timeout: 3000 });
  await page.clock.resume();
  await page.waitForFunction(() => document.querySelector(".update-notice")?.textContent?.includes("Updated to 0.1.42"), null, { timeout: 12000 });
  check(true, "asked again, it restarts once the turn ends");
  await page.close();
}

// An install that fails leaves the running version and offers to try again.
{
  const page = await open("?update=fails");
  await notice(page).waitFor();
  await notice(page).getByRole("button", { name: "Restart", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".update-notice")?.textContent?.includes("Couldn't install 0.1.42"), null, { timeout: 5000 });
  const text = await said(page);
  check(text.includes("Failed to move the new app into place") && text.includes("This version keeps running"), "a failed install says why and that nothing changed");
  check(await notice(page).getByRole("button", { name: "Try again", exact: true }).isVisible(), "and offers to try again");
  check(await notice(page).getAttribute("role") === "alert", "announced as an alert");
  await readable(page, "failed");
  await shot(page, "failed");
  await page.close();
}

// Just restarted into a new version: what it brought, once.
{
  const page = await open("?update=installed");
  await notice(page).waitFor();
  check((await said(page)).includes("Updated to 0.1.42"), "after an update the new version says so");
  await notice(page).getByRole("button", { name: "What's new", exact: true }).click();
  check(await page.locator(".update-notes li").count() === 3, "with what it brought");
  await readable(page, "installed");
  await shot(page, "installed");
  await page.close();
}

// A narrow window: the notice fits the drawer and its button stays in view.
{
  const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
  page.on("pageerror", (error) => failures.push(`narrow: ${error.message}`));
  await page.goto(`${baseUrl}/?update=ready`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(".mobile-menu").click();
  await notice(page).waitFor();
  const fits = await page.evaluate(() => {
    const box = document.querySelector(".update-notice")?.getBoundingClientRect();
    const button = document.querySelector(".update-action")?.getBoundingClientRect();
    const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
    return Boolean(box && button && sidebar && button.right <= sidebar.right && box.right <= sidebar.right + 0.5);
  });
  check(fits, "in a narrow window the notice and its button fit the drawer");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("\nall update checks passed");
