import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

await page.goto("http://127.0.0.1:4174/");
const needsRow = page.locator(".primary-nav .nav-item").first();
const needsBadge = needsRow.locator(".count-badge");
const [rowBox, badgeBox] = await Promise.all([needsRow.boundingBox(), needsBadge.boundingBox()]);
if (!rowBox || !badgeBox || badgeBox.width !== 20 || badgeBox.x + badgeBox.width > rowBox.x + rowBox.width) {
  throw new Error("The Needs you badge must keep its 20px width inside the sidebar row.");
}
for (const project of ["resonance", "foreman", "director"]) {
  const row = page.locator(".project-row").filter({ hasText: project });
  if ((await row.locator(".project-count").textContent()) !== "1") {
    throw new Error(`${project} should show one waiting decision.`);
  }
}
await page.screenshot({
  path: "/Users/mingyucao_1/.buzz/OUTBOX/BRIDGE_MVP_SIDEBAR.png",
  fullPage: false,
});
await page.getByRole("radio", { name: /Wi-Fi only/ }).click();
await page.getByRole("button", { name: "Add to answers" }).first().click();
await page.getByRole("radio", { name: /Send back 1, approve 2/ }).click();
await page.getByRole("button", { name: "Add to answers" }).click();
await page.getByRole("button", { name: "Merge", exact: true }).click();
await page.getByRole("button", { name: /3 answers ready/ }).click();
await page
  .locator(".tray-detail")
  .getByText(/merge https:\/\/github.com\/you\/foreman\/pull\/42/)
  .waitFor();
await page.screenshot({
  path: "/Users/mingyucao_1/.buzz/OUTBOX/BRIDGE_MVP_DECISION_TRAY.png",
  fullPage: false,
});

await page.getByRole("button", { name: "Send to first mate" }).click();
await page.getByText("Answered, closing").first().waitFor();
if ((await page.getByText("Answered, closing").count()) !== 3) {
  throw new Error("All three staged actions should enter the closing state.");
}

await page.getByRole("button", { name: /Improve the player queue/ }).click();
await page.getByRole("button", { name: "Pause", exact: true }).click();
await page.getByText('→ sends: pause work on "Improve the player queue"', { exact: true }).waitFor();
await page.getByText("In your answers", { exact: true }).waitFor();
if (await page.getByText("PR #42 · Fix flaky login test").count()) {
  throw new Error("A running resonance task must not show foreman's PR deliverable.");
}
await page.getByRole("button", { name: "Show everything" }).click();
await page.getByText("Worker's screen · read only").waitFor();
await page.screenshot({
  path: "/Users/mingyucao_1/.buzz/OUTBOX/BRIDGE_MVP_TASK_DRAWER.png",
  fullPage: false,
});
await page.getByRole("button", { name: "Close task details" }).click();
await page.getByRole("button", { name: /Fix flaky login test/ }).last().click();
await page.getByText("PR #42 · Fix flaky login test", { exact: true }).waitFor();
await page.getByRole("button", { name: "Close task details" }).click();

await page.getByRole("button", { name: /resonance/ }).first().click();
await page.getByRole("tab", { name: "Tasks" }).click();
await page.getByText("Work in # resonance").waitFor();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto("http://127.0.0.1:4174/");
await mobile.getByRole("button", { name: "Open navigation" }).click();
await mobile.getByRole("button", { name: /Needs you/ }).click();
await mobile.waitForTimeout(250);
await mobile.screenshot({
  path: "/Users/mingyucao_1/.buzz/OUTBOX/BRIDGE_MVP_MOBILE.png",
  fullPage: false,
});

await browser.close();
