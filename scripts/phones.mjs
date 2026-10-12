// Checks the captain's phone in the settings: no phone paired yet, pairing by a QR that works once and lapses, the
// phone that scans it arriving, each paired phone with when it was paired and last seen, revoking one behind a
// confirmation, a Mac not on a Tailscale network, and a phone list that cannot be read.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm phones
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

const phones = page.locator("[data-testid='phones']");
const rows = phones.locator("[data-testid='phone-row']");

async function shot(name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(150);
    await phones.scrollIntoViewIfNeeded();
    await phones.screenshot({ path: join(shots, `phones-${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

async function openSettings(query) {
  await page.goto(`${baseUrl}/?not-started${query ? `&${query}` : ""}`);
  await page.waitForSelector("button[title='Settings']", { timeout: 20000 });
  await page.click("button[title='Settings']");
  await page.waitForSelector("[data-testid='phones'] .phones-none, [data-testid='phones'] .phone-list, [data-testid='phones'] .routing-alert", { timeout: 10000 });
}

/** The QR a camera sees: dark modules on light paper, in either theme. */
async function qrColours() {
  return page.locator(".phone-qr").evaluate((svg) => ({ ink: getComputedStyle(svg).fill, paper: getComputedStyle(svg).backgroundColor }));
}

// No phone yet: the way in is to pair one, from this Mac.
await openSettings("phones=none");
check((await phones.innerText()).includes("No phone is paired with this Mac."), "a Mac with no phone says so");
const pairButton = phones.locator("button", { hasText: "Pair a phone" });
check(await pairButton.isEnabled(), "and offers to pair one");
await shot("none");

// Pairing shows a code that works once and says until when; cancelling takes it away.
await pairButton.click();
await phones.locator("[data-testid='phone-invite'] .phone-qr").waitFor();
const invite = await phones.locator("[data-testid='phone-invite']").innerText();
check(/It works once, until \d{1,2}:\d{2}/.test(invite), `the code says it works once and until when (${invite.split("\n").at(-2)})`);
check(invite.includes("Tailscale"), "and that the phone needs Tailscale");
check(await phones.locator("button", { hasText: "Pair a phone" }).count() === 0, "no second code is offered while one shows");
const modules = await phones.locator(".phone-qr path").getAttribute("d");
check((modules?.match(/M/g) ?? []).length > 1000, "the code is a full QR");
for (const theme of ["light", "dark"]) {
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
  const colours = await qrColours();
  check(colours.ink === "rgb(16, 26, 24)" && colours.paper === "rgb(255, 255, 255)", `the QR is dark on light in the ${theme} theme (${colours.ink} on ${colours.paper})`);
}
await page.evaluate(() => document.documentElement.classList.remove("dark"));
const box = await phones.locator(".phone-qr").boundingBox();
const across = (await phones.locator(".phone-qr").getAttribute("viewBox")).split(" ")[2];
check(box && box.width >= 190 && box.width === box.height && box.width % Number(across) === 0, `the QR is square, large enough to scan, and every module is whole pixels (${box?.width}px for ${across} modules)`);
check(await rows.count() === 0 && (await phones.locator(".phone-qr").getAttribute("class")) === "phone-qr", "a live code is drawn at full strength");
await shot("invite");
await phones.locator("button", { hasText: "Cancel" }).click();
await phones.locator("[data-testid='phone-invite']").waitFor({ state: "detached" });
check(await phones.locator("button", { hasText: "Pair a phone" }).isVisible(), "cancelling puts the code away");

// A code past its ten minutes says so and offers a new one.
await pairButton.click();
await phones.locator("[data-testid='phone-invite']").waitFor();
await page.clock.install();
await page.clock.fastForward("10:01");
await phones.locator(".phone-lapsed").waitFor();
check((await phones.locator(".phone-lapsed").innerText()).includes("This code has lapsed"), "a lapsed code says it has lapsed");
check(await phones.locator("button", { hasText: "Show a new code" }).isVisible(), "and offers a new one");
check(await phones.locator(".phone-qr.lapsed").count() === 1, "and fades the code, so it does not look scannable");
await shot("lapsed");

// The phone that scans the code arrives in the list, and the code goes.
await openSettings("phones=scans");
await phones.locator("button", { hasText: "Pair a phone" }).click();
await phones.locator("[data-testid='phone-invite']").waitFor();
await rows.first().waitFor({ timeout: 8000 });
check(await phones.locator("[data-testid='phone-invite']").count() === 0, "the code goes once a phone has paired");
check((await phones.locator(".routing-notice").innerText()) === "Captain's iPhone is paired.", "and says which phone paired");
check((await rows.first().locator("small").innerText()).endsWith(" · Connected now"), "the new phone shows as connected");
await shot("paired-now");

// Paired phones: when each was paired and last seen, one connected.
await openSettings("phones=paired");
check(await rows.count() === 2, "both paired phones are listed");
const first = await rows.nth(0).innerText();
const second = await rows.nth(1).innerText();
check(first.includes("Captain's iPhone") && first.includes("Connected now"), "a connected phone says so");
check(/Paired [A-Z][a-z]{2} \d{1,2}/.test(second) && second.includes("Last seen 23 d ago"), `an idle phone says when it was paired and last seen (${second.replace(/\n/g, " ")})`);
check(await phones.locator("button", { hasText: "Pair another phone" }).isVisible(), "another phone can be paired");
await shot("paired");

// Revoking asks first, and keeping changes nothing.
await rows.nth(1).locator("button", { hasText: "Revoke" }).click();
check((await rows.nth(1).innerText()).includes("It is cut off at once."), "revoking says what it does before it does it");
await shot("confirm");
await rows.nth(1).locator("button", { hasText: "Keep" }).click();
check(await rows.count() === 2, "keeping it changes nothing");
await rows.nth(1).locator("button", { hasText: "Revoke" }).click();
await rows.nth(1).locator(".phone-revoke-now").click();
await page.waitForFunction(() => document.querySelectorAll("[data-testid='phone-row']").length === 1);
check((await phones.locator(".routing-notice").innerText()).startsWith("Old iPhone 12 is revoked."), "the revoked phone goes from the list, and the screen says so");
await shot("revoked");

// A Mac off its Tailscale network says why nothing can pair.
await openSettings("phones=offline");
check((await phones.locator(".routing-alert").innerText()).includes("This Mac is not on a Tailscale network"), "a Mac off Tailscale says so");
check(await phones.locator("button", { hasText: "Pair another phone" }).isDisabled(), "and pairing waits for it");
check(await rows.count() === 2, "its paired phones are still listed, and can still be revoked");
await shot("offline");

// A phone list that cannot be read says why, in the backend's words.
await openSettings("phones=broken");
check((await phones.locator(".routing-alert").innerText()).includes("cannot be read, so no phone can reach this Mac"), "a list that cannot be read says why");
await shot("broken");

// A narrow window keeps the code and its words side by side without spilling.
await openSettings("phones=none");
await page.setViewportSize({ width: 560, height: 900 });
await phones.locator("button", { hasText: "Pair a phone" }).click();
await phones.locator("[data-testid='phone-invite']").waitFor();
const spill = await phones.locator("[data-testid='phone-invite']").evaluate((node) => node.scrollWidth - node.clientWidth);
check(spill <= 0, `nothing spills out of the code's box in a narrow window (${spill}px)`);
await shot("narrow");

check(errors.length === 0, `no page errors (${errors.join("; ")})`);
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nphones: all checks passed");
