// Plays a recorded live host run through the UI, so a host change that alters event
// shapes is caught without spending model tokens on another live run.
//
//   pnpm dev --port 4182 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4182 pnpm replay
//
// The recording comes from the live end-to-end test, which writes
// `recording-latest.jsonl` to ~/.buzz/.scratch/firstmate-desktop-e2e/.
// The mock host adapter replays it on `?replay`. A `queued` event without text is a
// message the captain sent, so the replay waits there until this script types it into
// the composer. A `queued` or `requeued` event that carries its text comes from the
// host's durable outbox after a relaunch, and the UI restores it on its own.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4182. Other agents run servers from this checkout, so there is no safe default.");
const recordingPath = process.env.FIRSTMATE_RECORDING
  ?? `${process.env.HOME}/.buzz/.scratch/firstmate-desktop-e2e/recording-latest.jsonl`;
const output = process.env.FIRSTMATE_REVIEW_OUT ?? `${process.env.HOME}/.buzz/.scratch/firstmate-replay-review`;
await mkdir(output, { recursive: true });

const events = readFileSync(recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const outbox = events.filter((item) => item.type === "outbox").map((item) => item.payload);
const history = events.find((item) => item.type === "history")?.payload.items;
if (!history) throw new Error(`${recordingPath} has no history event: record a run that restarts the first mate.`);
// Without this the replay would still pass while covering none of the code that restores a waiting message's words.
const restored = outbox.filter((item) => typeof item.text === "string");
if (!restored.length) throw new Error(`${recordingPath} predates the host carrying message text on queued and requeued outbox events: record a fresh run.`);
const typed = outbox.filter((item) => item.state === "queued" && typeof item.text !== "string").map((item) => item.id);

const check = (ok, what) => { if (!ok) throw new Error(what); console.log(`ok: ${what}`); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
// A banner between two recorded events can be on screen for tens of milliseconds, too short to poll for.
await page.addInitScript((recording) => {
  window.__FM_REPLAY__ = recording;
  window.__BANNERS__ = [];
  new MutationObserver(() => {
    document.querySelectorAll(".problem-banner, .health-banner, .offline-banner").forEach((banner) => {
      const seen = `${banner.className}|${banner.getAttribute("data-reason-kind") ?? banner.getAttribute("data-health-kind") ?? ""}|${banner.querySelector("strong")?.textContent ?? ""}|${[...banner.querySelectorAll("button")].map((button) => button.textContent).join("/")}`;
      if (window.__BANNERS__.at(-1) !== seen) window.__BANNERS__.push(seen);
    });
  }).observe(document, { childList: true, subtree: true });
}, events);

await page.goto(`${baseUrl}/?replay`, { waitUntil: "domcontentloaded" });
await page.getByText("Captain's Call").waitFor();
await page.getByRole("button", { name: /^Chat/ }).click();
// The recording's own prompts, in order: one per message the captain sent live.
const sentTexts = [];
for (const id of typed) {
  const text = history.filter((item) => item.who === "captain")[sentTexts.length]?.text;
  if (!text) throw new Error(`${recordingPath} sends ${typed.length} messages but its history holds fewer: cannot replay ${id}.`);
  await page.getByLabel("Message the first mate").fill(text);
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30_000 });
  await page.locator(".send-button").click();
  sentTexts.push(text);
}

await page.locator(".day-label", { hasText: /^Earlier$/i }).waitFor({ timeout: 30_000 });
const banners = await page.evaluate(() => window.__BANNERS__);
check(
  banners.some((seen) => seen.includes("problem-banner") && seen.includes("|exited|")),
  `the recorded crash showed its own banner (saw ${JSON.stringify(banners)})`,
);
check(await page.locator(".problem-banner").count() === 0, "the crash banner cleared once the first mate was back");
await page.getByText("Re-sent after a restart", { exact: false }).waitFor({ timeout: 30_000 });
// That text appears as soon as the message is re-sent, while its reply is still streaming in.
// The host records picked_up after the last chunk of that reply, so waiting for the footer to
// say it was read is what proves the whole reply is on screen. Without it the checks below race
// the stream, and whether they pass depends on how quickly the first mate happened to answer.
await page.getByText(/Re-sent after a restart.*Read by/).waitFor({ timeout: 30_000 });

const captains = await page.locator(".captain-message p").allInnerTexts();
const expected = history.filter((item) => item.who === "captain").map((item) => item.text);
check(captains.join("\n") === expected.join("\n"), `each captain message shows once, in order (${captains.length} of ${expected.length})`);
for (const item of restored) {
  check(captains.includes(item.text), `a message the host held in its outbox shows its words (${item.state})`);
}
check(await page.getByRole("button", { name: "Send again" }).count() === 0, "a message cut off by a crash offers no Send again");
const labels = await page.locator(".day-label").allInnerTexts();
check(labels.join(",").toLowerCase() === "earlier,today", `one Earlier and one Today label (${labels.join(",")})`);
check(await page.locator(".offline-banner").getByRole("button", { name: "Stop" }).count() === 0, "no banner offers Stop");
const gap = await page.getByTestId("chat-messages").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
check(gap < 2, `chat follows to the newest message (${gap}px from the bottom)`);
await page.screenshot({ path: `${output}/replay-after-restart.png` });

await browser.close();
check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
console.log(JSON.stringify({ ok: true, recording: recordingPath, typed: typed.length, restored: restored.length }));
