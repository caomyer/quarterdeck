// Checks attaching files to a message in chat, in both themes: the Attach button, the files waiting in the composer,
// taking one back, what could not be attached and why, a file gone by the time the message is sent, a cancelled
// picker, the message as it is sent, and the same message after a restart brings the conversation back from the first
// mate's history.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm attach
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

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

async function shot(name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `attach-${name}-${theme}.png`), fullPage: false });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

async function openChat(query = "") {
  await page.goto(`${baseUrl}/${query}`);
  await page.locator(".nav-item", { hasText: "Chat" }).click();
  await page.waitForSelector(".composer .attach-button", { timeout: 20000 });
}

const composerFiles = () => page.locator(".composer-files .file-chip");
const lastCaptain = () => page.locator(".captain-message").last();

// Attaching: the files wait in the composer, named, with their sizes, and Send can take them.
await openChat();
check(await page.locator(".send-button").isDisabled(), "with nothing written or attached, Send waits");
await page.locator(".attach-button").click();
await composerFiles().first().waitFor({ timeout: 5000 });
const waiting = await composerFiles().allInnerTexts();
check(waiting.length === 2, `both picked files wait in the composer (${waiting.length})`);
check(waiting[0].includes("Release brief v2.md") && waiting[0].includes("18 KB"), `a file shows its name and size (${waiting[0]})`);
check(waiting[1].includes("Écran 日本 2026-09-22.png"), "a name beyond ASCII shows as it is");
check(await page.locator(".send-button").isEnabled(), "files alone are enough to send");
check((await composerFiles().first().getAttribute("title"))?.startsWith("/Users/captain/Desktop/Release brief v2.md") === true, "a file says where it was picked from");
await page.locator(".composer textarea").fill("Here is the brief, and a screenshot of the error.");
await shot("composer");

// Taking one back leaves the other.
await page.getByRole("button", { name: "Remove Écran 日本 2026-09-22.png" }).click();
check((await composerFiles().allInnerTexts()).length === 1, "a file taken back leaves the composer");

// Sending: the words, then the files, in the conversation; the composer is empty again.
await page.locator(".send-button").click();
await page.waitForFunction(() => document.querySelector(".captain-message .message-files"), null, { timeout: 5000 });
const bubble = await lastCaptain().locator("p").innerText();
check(bubble === "Here is the brief, and a screenshot of the error.", `the message shows the captain's words alone (${JSON.stringify(bubble)})`);
const sentFiles = await lastCaptain().locator(".file-chip").allInnerTexts();
check(sentFiles.length === 1 && sentFiles[0].includes("Release brief v2.md") && sentFiles[0].includes("18 KB"), `and the file it carried (${sentFiles.join(" | ")})`);
check((await lastCaptain().locator(".file-chip").getAttribute("title"))?.includes("/data/.attachments/") === true, "the message names the copy taken into the home as it was sent");
check(await composerFiles().count() === 0, "the composer lets the files go once they are sent");
check(await page.locator(".composer textarea").inputValue() === "", "and the words");
await lastCaptain().getByText(/Read by/).waitFor({ timeout: 10000 });
await shot("sent");

// Files with no words go too, and the message shows no empty bubble. Taking a file back and picking both again
// still sends one copy of each.
await page.locator(".attach-button").click();
await composerFiles().first().waitFor({ timeout: 5000 });
await page.getByRole("button", { name: "Remove Release brief v2.md" }).click();
await page.locator(".attach-button").click();
await page.waitForFunction(() => document.querySelectorAll(".composer-files .file-chip").length === 2, null, { timeout: 5000 });
check((await composerFiles().allInnerTexts()).length === 2, "picking a file again replaces it rather than adding it twice");
await page.locator(".composer textarea").press("Enter");
await page.waitForFunction(() => document.querySelectorAll(".captain-message").length === 2, null, { timeout: 5000 });
check(await lastCaptain().locator("p").count() === 0, "a message of files alone has no empty bubble");
const copies = await lastCaptain().locator(".file-chip").evaluateAll((chips) => chips.map((chip) => chip.getAttribute("title")));
check(copies.length === 2 && new Set(copies).size === 2 && copies.some((path) => path.endsWith("/Release brief v2.md")) && copies.some((path) => path.endsWith("/Écran 日本 2026-09-22.png")), `and carries exactly one copy of each file (${copies.join(" | ")})`);

// After a restart the conversation comes back from the first mate's history, files and all.
await page.waitForTimeout(3000);
await page.locator(".composer .icon-button[title='Restart the first mate']").click();
await page.waitForSelector(".captain-message.past", { timeout: 20000 });
const past = page.locator(".captain-message.past");
check(await past.count() === 2, `both messages come back from history (${await past.count()})`);
check((await past.first().locator("p").innerText()) === "Here is the brief, and a screenshot of the error.", "with the captain's words alone");
check((await past.first().locator(".file-chip").allInnerTexts()).some((text) => text.includes("Release brief v2.md")), "and the file, read back from the message's own words");

// What could not be attached says why, and what could waits as usual.
await openChat("?attach=refused");
await page.locator(".attach-button").click();
await page.waitForSelector(".attach-problems", { timeout: 5000 });
const problems = await page.locator(".attach-problems li").allInnerTexts();
check(problems.some((line) => line === "old plan.pdf is no longer there."), "a file gone since it was picked says so");
check(problems.some((line) => line.includes("files over 100 MB can't be attached")), "a file over the limit says so, and what to do");
check((await composerFiles().allInnerTexts()).length === 1, "the file that could be attached still waits");
await shot("refused");
await page.getByRole("button", { name: "Dismiss" }).click();
check(await page.locator(".attach-problems").count() === 0, "the reasons can be dismissed");

// A file gone by the time the message is sent holds the whole message back, words and files kept.
await openChat("?attach=gone");
await page.locator(".attach-button").click();
await composerFiles().first().waitFor({ timeout: 5000 });
await page.locator(".composer textarea").fill("The brief went missing");
const before = await page.locator(".captain-message").count();
await page.locator(".send-button").click();
await page.waitForSelector(".attach-problems", { timeout: 5000 });
check((await page.locator(".attach-problems li").allInnerTexts()).includes("Release brief v2.md is no longer there."), "a file gone since it was picked says so at send");
check(await page.locator(".captain-message").count() === before, "and nothing is sent");
check(await page.locator(".composer textarea").inputValue() === "The brief went missing", "the words are kept");
check(await composerFiles().count() === 2, "and so are the files");
await shot("gone");

// Cancelling the picker changes nothing.
await openChat("?attach=cancel");
await page.locator(".composer textarea").fill("Words kept");
await page.locator(".attach-button").click();
await page.waitForTimeout(300);
check(await composerFiles().count() === 0 && await page.locator(".attach-problems").count() === 0, "a cancelled picker attaches nothing and complains of nothing");
check(await page.locator(".composer textarea").inputValue() === "Words kept", "and leaves the words alone");

// Before the first mate has started here, files can be attached and wait with the words.
await openChat("?not-started");
await page.locator(".attach-button").click();
await composerFiles().first().waitFor({ timeout: 5000 });
check(await page.locator(".send-button").isDisabled(), "until the first mate has started, Send waits");
check(await composerFiles().count() === 2, "and the files wait with it");

// Nothing overflows, at the width the app opens and at a narrow one.
await openChat("?attach=refused");
await page.locator(".attach-button").click();
await page.waitForSelector(".attach-problems", { timeout: 5000 });
for (const width of [1280, 420]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(150);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over === 0, `nothing runs off the page at ${width}px (${over})`);
}
await shot("narrow");

check(errors.length === 0, `the page raised no errors${errors.length ? `: ${errors.join("; ")}` : ""}`);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll attach checks passed.");
