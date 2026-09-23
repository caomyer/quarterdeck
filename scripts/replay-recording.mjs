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
//
// When the live relaunch test has recorded a run (`relaunch-latest.jsonl`, or
// FIRSTMATE_RELAUNCH_RECORDING), it also plays what a fresh window gets after the app
// opens again, and checks the conversation from before it closed is on screen.
import { existsSync, readFileSync } from "node:fs";
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
// A banner between two recorded events can be on screen for tens of milliseconds, too short to poll for,
// and so can the usage strip's reading while the first mate is up between the recording's restarts.
await page.addInitScript((recording) => {
  window.__FM_REPLAY__ = recording;
  window.__BANNERS__ = [];
  window.__STRIPS__ = [];
  new MutationObserver(() => {
    const strip = document.querySelector(".usage-strip")?.textContent;
    if (strip && window.__STRIPS__.at(-1) !== strip) window.__STRIPS__.push(strip);
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
// The context window as the recorded session reported it, read from its usage updates whatever shape they were recorded in.
const reading = [...events].reverse().find((item) => item.type === "usage" && typeof item.payload.update?.used === "number");
if (reading) {
  const strips = await page.evaluate(() => window.__STRIPS__);
  const shown = strips.find((strip) => /Context\d+% · \d+(\.\d)?[kM]? of \d+(\.\d)?[kM]/.test(strip));
  check(Boolean(shown), `the strip showed the recorded session's context (${JSON.stringify(shown ?? strips.at(-1))})`);
}
for (const item of restored) {
  check(captains.includes(item.text), `a message the host held in its outbox shows its words (${item.state})`);
}
check(await page.getByRole("button", { name: "Send again" }).count() === 0, "a message cut off by a crash offers no Send again");
const labels = await page.locator(".day-label").allInnerTexts();
check(labels.join(",").toLowerCase() === "earlier,today", `one Earlier and one Today label (${labels.join(",")})`);
// The offline banner renders about half a second after the "Read by" anchor above.
// Without this wait the assertion is a coin flip: when the banner has not arrived yet
// it passes by finding no banner, rather than by finding a banner with no Stop button.
// Measured: 0 banners at the anchor, 1 from half a second later onward.
await page.locator(".offline-banner").waitFor({ timeout: 30_000 });
check(await page.locator(".offline-banner").getByRole("button", { name: "Stop" }).count() === 0, "no banner offers Stop");
const gap = await page.getByTestId("chat-messages").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
check(gap < 2, `chat follows to the newest message (${gap}px from the bottom)`);
await page.screenshot({ path: `${output}/replay-after-restart.png` });

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);

// A relaunch, from the live relaunch test: a fresh window gets only what the host sends after the app
// opens again, and must show the conversation from before it closed. Everything before the relaunch
// step is what the closed app's window saw, so it is left out.
const relaunchPath = process.env.FIRSTMATE_RELAUNCH_RECORDING
  ?? `${process.env.HOME}/.buzz/.scratch/firstmate-desktop-e2e/relaunch-latest.jsonl`;
let relaunched = null;
if (existsSync(relaunchPath)) {
  const all = readFileSync(relaunchPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const at = all.findIndex((item) => item.type === "step" && item.payload.step === "4");
  if (at < 0) throw new Error(`${relaunchPath} has no relaunch step: record it with host_e2e_live_relaunch.`);
  const after = all.slice(at);
  const earlier = after.find((item) => item.type === "history")?.payload.items ?? [];
  const captainEarlier = earlier.filter((item) => item.who === "captain").map((item) => item.text);
  check(captainEarlier.length > 0, `the relaunch recording resumes a conversation with the captain's messages in it (${captainEarlier.length})`);
  check(!after.some((item) => item.type === "outbox" && item.payload.state === "queued" && typeof item.payload.text !== "string"), "nothing the captain typed after the relaunch is needed to replay it");
  const fresh = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const freshErrors = [];
  fresh.on("pageerror", (error) => freshErrors.push(error.message));
  fresh.on("console", (message) => { if (message.type() === "error") freshErrors.push(message.text()); });
  await fresh.addInitScript((recording) => { window.__FM_REPLAY__ = recording; }, after);
  await fresh.goto(`${baseUrl}/?replay`, { waitUntil: "domcontentloaded" });
  await fresh.getByText("Captain's Call").waitFor();
  await fresh.getByRole("button", { name: /^Chat/ }).click();
  await fresh.locator(".day-label", { hasText: /^Earlier$/i }).waitFor({ timeout: 30_000 });
  const shown = await fresh.locator(".captain-message p").allInnerTexts();
  check(captainEarlier.every((text) => shown.includes(text)), `after a relaunch the chat shows the captain's earlier messages (${shown.length} shown, ${captainEarlier.length} from before)`);
  check(await fresh.locator(".mate-message").count() > 0, "and the first mate's earlier replies");
  check(!shown.some((text) => /^(<task-notification>|\[Request interrupted by user)/.test(text.trim())), `neither a rewake nor the CLI's own interruption marker shows as something the captain wrote (${JSON.stringify(shown)})`);
  await fresh.screenshot({ path: `${output}/replay-after-relaunch.png` });
  check(freshErrors.length === 0, `no page errors after the relaunch${freshErrors.length ? `: ${freshErrors.join(" | ")}` : ""}`);
  relaunched = relaunchPath;
} else {
  console.log(`skipped: no relaunch recording at ${relaunchPath}; run host_e2e_live_relaunch to record one`);
}

await browser.close();
console.log(JSON.stringify({ ok: true, recording: recordingPath, typed: typed.length, restored: restored.length, relaunch: relaunched }));
