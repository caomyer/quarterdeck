import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const baseUrl = process.env.FIRSTMATE_URL ?? "http://127.0.0.1:4178";
const output = "/Users/mingyucao_1/.buzz/.scratch/firstmate-phase3-review";
await mkdir(output, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.locator(".snapshot-refreshing").waitFor();
await page.locator(".snapshot-refreshing").waitFor({ state: "detached" });
await page.locator('[data-decision-id="res-model-download"]').waitFor();

const expectedTitle = "Resonance: when may the app download the 150 MB speech model?";
const expectedReason = "Only 2 of 9281 sampled episodes have a publisher transcript, so the download is the normal path, and today it starts on every episode open with no Wi-Fi check. Options: Wi-Fi only with visible progress, recommended; ask on the first snip that needs it; keep downloading eagerly.";
if (await page.getByTestId("decision-title").innerText() !== expectedTitle) throw new Error("Decision title did not come from Fleet backlog");
if (await page.getByTestId("decision-reason").innerText() !== expectedReason) throw new Error("Decision reason was not rendered verbatim");
if (await page.getByText("Recommended", { exact: true }).count() !== 1) throw new Error("Recommended option marker missing");
if (await page.locator("text=sampled epis…").count()) throw new Error("Truncated Bearings summary leaked into the card");

await page.screenshot({ path: `${output}/01-bearings-real-state.png`, fullPage: true });
await page.getByRole("button", { name: /Projects/ }).first().click();
await page.locator(".project-card").filter({ hasText: "resonance" }).getByText("Fully checked before a PR · You merge").waitFor();
await page.locator(".project-card").filter({ hasText: "foreman" }).getByText("Opens a PR directly · Merges itself").waitFor();
await page.getByRole("button", { name: /Bearings/ }).click();
await page.getByRole("button", { name: /Wi-Fi only with visible progress/ }).click();
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.getByText("Queued", { exact: true }).waitFor();
await page.screenshot({ path: `${output}/02-decision-queued.png`, fullPage: true });
await page.getByText(/Answered · the first mate read it by/).waitFor();

await page.getByRole("button", { name: /Chat/ }).click();
await page.locator(".captain-message").filter({ hasText: "On the res model download: Wi-Fi only with visible progress." }).waitFor();
await page.locator(".mate-message").filter({ hasText: "I have that, captain. I’ll carry it through and report what changes." }).waitFor();
await page.screenshot({ path: `${output}/03-chat-stream-and-read.png`, fullPage: true });

await page.getByLabel("Message the first mate").fill("Keep the existing error text.");
await page.getByTitle("Send message").click();
await page.getByTitle("Restart the first mate").click();
await page.getByText("Re-sent after a restart", { exact: true }).waitFor();
await page.screenshot({ path: `${output}/04-chat-requeued.png`, fullPage: true });

await page.getByRole("button", { name: /Bearings/ }).click();
await page.locator(".task-row").filter({ hasText: "probe-task" }).click();
await page.locator(".worker-screen pre").filter({ hasText: "source: mock pane capture" }).waitFor();
await page.screenshot({ path: `${output}/05-pane-capture.png`, fullPage: true });

await page.getByTitle("Close task details").click();
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: "domcontentloaded" });
await page.locator('[data-decision-id="res-model-download"]').waitFor();
await page.waitForTimeout(250);
await page.screenshot({ path: `${output}/06-mobile-bearings.png`, fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow > 0) throw new Error(`Mobile horizontal overflow: ${overflow}px`);
const clippedControls = await page.locator("main button").evaluateAll((buttons) => buttons
  .filter((button) => {
    const box = button.getBoundingClientRect();
    return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
  })
  .map((button) => button.textContent?.trim() || button.getAttribute("title")));
if (clippedControls.length) throw new Error(`Mobile controls outside viewport: ${clippedControls.join(", ")}`);
if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);

console.log(JSON.stringify({ ok: true, screenshots: 6, overflow, clippedControls, errors }));
await browser.close();
