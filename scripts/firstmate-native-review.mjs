import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const baseUrl = "http://127.0.0.1:4177/";
const output = "/Users/mingyucao_1/.buzz/.scratch/firstmate-native-review";
await mkdir(output, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openPage(browser, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.locator('[data-screen="bearings"]').waitFor();
  return { page, errors };
}

const browser = await chromium.launch({ headless: true });

try {
  const desktopRun = await openPage(browser, { width: 1440, height: 1000 });
  const desktop = desktopRun.page;
  const navLabels = await desktop.locator(".primary-nav .nav-item strong").allTextContents();
  assert(JSON.stringify(navLabels) === JSON.stringify(["Bearings", "Chat", "Projects"]), `wrong sidebar: ${navLabels.join(", ")}`);
  const sections = await desktop.locator(".bearings-page > .dashboard-section .section-heading h2").allTextContents();
  assert(JSON.stringify(sections) === JSON.stringify(["Captain's Call", "Recently Landed", "Underway", "Charted Next"]), `wrong section order: ${sections.join(", ")}`);
  assert(await desktop.getByText("Nothing needs your action right now.", { exact: true }).isVisible(), "Captain's Call empty copy missing");
  assert(await desktop.getByText("Nothing has landed recently.", { exact: true }).isVisible(), "Recently Landed empty copy missing");
  assert(await desktop.getByText("needs repair", { exact: true }).isVisible(), "records warning badge missing");
  assert(!(await desktop.locator(".task-row").first().innerText()).includes("worktree gone"), "raw doing text leaked onto Bearings row");
  assert((await desktop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)), "desktop has horizontal overflow");
  await desktop.screenshot({ path: `${output}/01-bearings.png`, fullPage: true });

  await desktop.locator(".task-row").first().click();
  for (const label of ["Instructions", "Timeline", "PR", "Worker's screen"]) {
    assert(await desktop.getByRole("heading", { name: label, exact: true }).isVisible(), `task detail missing ${label}`);
  }
  assert(await desktop.getByText("Read-only. To change anything, tell the first mate.", { exact: true }).isVisible(), "worker caption missing");
  await desktop.getByRole("button", { name: "Show everything" }).click();
  assert(await desktop.getByText("Worker runtime", { exact: true }).isVisible(), "expanded machine detail missing");
  await desktop.screenshot({ path: `${output}/02-task-detail.png`, fullPage: true });
  await desktop.getByTitle("Close task details").click();

  await desktop.getByRole("button", { name: /Projects/ }).click();
  await desktop.locator(".project-card").first().click();
  assert(await desktop.locator(".posture-line").getByText("Stays on this machine · You land it", { exact: true }).isVisible(), "project posture missing");
  await desktop.screenshot({ path: `${output}/03-project.png`, fullPage: true });

  await desktop.getByRole("button", { name: /Bearings/ }).click();
  await desktop.locator(".ahoy-card").getByRole("button", { name: "Ahoy" }).click();
  assert(await desktop.getByText("/ahoy", { exact: true }).isVisible(), "/ahoy was not sent to Chat");
  assert(await desktop.getByText("Captain, nothing happened after your last message. The probe task still needs a fresh sighting.", { exact: true }).isVisible(), "Ahoy reply missing captain address");
  await desktop.screenshot({ path: `${output}/04-chat-ahoy.png`, fullPage: true });

  await desktop.goto(baseUrl);
  await desktop.locator('[data-screen="bearings"]').waitFor();
  await desktop.locator(".runtime-button").click();
  assert(await desktop.getByRole("button", { name: "Start the first mate" }).isVisible(), "offline Start action missing");
  await desktop.getByRole("button", { name: /Chat/ }).click();
  assert((await desktop.getByLabel("Message the first mate").getAttribute("placeholder")) === "The first mate isn't running. It'll read this when it starts.", "offline composer copy is wrong");
  await desktop.screenshot({ path: `${output}/05-offline-chat.png`, fullPage: true });

  const mobileRun = await openPage(browser, { width: 390, height: 844 });
  const mobile = mobileRun.page;
  assert((await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)), "mobile has horizontal overflow");
  await mobile.screenshot({ path: `${output}/06-mobile-bearings.png`, fullPage: true });
  await mobile.locator(".task-row").first().click();
  assert(await mobile.getByText("Read-only. To change anything, tell the first mate.", { exact: true }).isVisible(), "mobile worker caption missing");
  await mobile.screenshot({ path: `${output}/07-mobile-task.png`, fullPage: true });

  assert(desktopRun.errors.length === 0, `desktop console errors: ${desktopRun.errors.join(" | ")}`);
  assert(mobileRun.errors.length === 0, `mobile console errors: ${mobileRun.errors.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, consoleErrors: 0, screenshots: 7 }, null, 2));
} finally {
  await browser.close();
}
