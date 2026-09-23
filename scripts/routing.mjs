// Checks crew routing in the settings: off until the captain turns it on, the
// example rules as a starting point, rules the first mate cannot use refused in
// its own words and shown when a file already holds them, turning it off
// setting the rules aside and turning it on bringing them back, and the
// optional typed dispatch key, which is never shown once saved.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm routing
//
// Set ARTIFACT_SHOTS to a folder to also save screenshots in both themes.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4191. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const example = readFileSync(new URL("../engine/docs/examples/crew-dispatch.json", import.meta.url), "utf8");
const KEY = "tsk_live-RoutingCheck.7Qz/+=:~";

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const logged = [];
page.on("console", (message) => logged.push(message.text()));

async function shot(name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(150);
    await page.locator(".settings-dialog").screenshot({ path: join(shots, `routing-${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

async function openSettings(query) {
  await page.goto(`${baseUrl}/?not-started${query ? `&${query}` : ""}`);
  await page.waitForSelector("button[title='Settings']", { timeout: 20000 });
  await page.click("button[title='Settings']");
  await page.waitForSelector("[data-testid='routing'] .routing-state, [data-testid='routing'] .routing-alert", { timeout: 10000 });
}

const routing = page.locator("[data-testid='routing']");
const toggle = routing.locator("[role='switch']");

// Off by default: nothing is set up until the captain asks for it.
await openSettings();
check(await toggle.getAttribute("aria-checked") === "false", "routing is off in a new home");
check((await routing.innerText()).includes("The first mate chooses who does each piece of work itself"), "and says the first mate chooses for itself");
check(await routing.locator("textarea").count() === 0, "no rules are shown while it is off");
check(await routing.locator("details.routing-key").getAttribute("open") === null, "the key is tucked away as optional");
await shot("off");

// Turning it on offers the example, and nothing is written until the captain confirms.
await toggle.click();
const starts = await routing.locator(".routing-start label strong").allInnerTexts();
check(starts.join(",") === "The example rules,No rules yet", `turning on offers the example or no rules (${starts.join(", ")})`);
check(await routing.locator(".routing-start input[value='template']").isChecked(), "the example is the suggested start");
await shot("choosing");
await routing.locator(".routing-start button", { hasText: "Cancel" }).click();
check(await toggle.getAttribute("aria-checked") === "false", "cancelling leaves routing off");
await toggle.click();
await routing.locator(".routing-primary", { hasText: "Turn on" }).click();
await routing.locator("textarea").waitFor();
check(await toggle.getAttribute("aria-checked") === "true", "routing is on");
check(await routing.locator("textarea").inputValue() === example, "the rules start as the example firstmate ships");
check((await routing.innerText()).includes("The first mate follows these rules"), "and says the first mate follows them");
check(await routing.locator(".routing-primary", { hasText: "Save rules" }).isDisabled(), "there is nothing to save until the rules change");
await shot("on");

// A rule the first mate cannot use is refused in its words, and the edit is kept to fix.
const broken = '{ "rules": [ { "when": "Everything.", "use": { "harness": "spaceship" } } ] }';
await routing.locator("textarea").fill(broken);
await routing.locator(".routing-primary", { hasText: "Save rules" }).click();
await routing.locator(".routing-alert").waitFor();
check((await routing.locator(".routing-alert").innerText()).includes("unverified harness: spaceship"), "rules the first mate cannot use are refused with its reason");
check(await routing.locator("textarea").inputValue() === broken, "a refused edit stays on screen to fix");
await shot("refused");

// Turning off with an edit unsaved would lose it, so it asks for a save or an undo first.
await toggle.click();
check(await toggle.getAttribute("aria-checked") === "true", "routing stays on while an edit is unsaved");
check((await routing.locator(".routing-alert").innerText()).includes("Save or undo"), "and says what to do first");

const fixed = '{\n  "rules": [],\n  "default": [\n    { "harness": "codex", "model": "gpt-5.5" },\n    { "harness": "claude" }\n  ]\n}\n';
await routing.locator("textarea").fill(fixed);
await routing.locator(".routing-primary", { hasText: "Save rules" }).click();
await routing.locator(".routing-notice").waitFor();
check((await routing.locator(".routing-notice").innerText()).startsWith("Saved."), "valid rules are saved");
check(await routing.locator(".routing-alert").count() === 0, "and nothing is left complaining");

// Turning off sets the rules aside rather than deleting them, and turning on can bring them back.
await toggle.click();
await routing.locator(".routing-notice").waitFor();
check(await toggle.getAttribute("aria-checked") === "false", "routing turns off");
check(/kept as config\/crew-dispatch\.json\.off-/.test(await routing.locator(".routing-notice").innerText()), "turning off says where the rules were kept");
await toggle.click();
check(await routing.locator(".routing-start input[value='restore']").isChecked(), "turning on again suggests the rules set aside");
await shot("restore");
await routing.locator(".routing-primary", { hasText: "Turn on" }).click();
await routing.locator("textarea").waitFor();
check(await toggle.getAttribute("aria-checked") === "true", "and brings routing back on");

// The key: optional, write-only, and never shown again.
await routing.locator("details.routing-key summary").click();
check((await routing.locator(".routing-key").innerText()).includes("Routing works without it"), "the key says routing works without it");
check((await routing.locator("[data-testid='routing-key-state']").innerText()) === "No key is set.", "no key is set to begin with");
const field = routing.locator(".routing-key input");
check(await field.getAttribute("type") === "password", "the key is typed into a masked field");
await field.fill("not a key $(id)");
await routing.locator(".routing-key button", { hasText: "Save key" }).click();
await routing.locator(".routing-key .routing-alert").waitFor();
check(!(await routing.locator(".routing-key .routing-alert").innerText()).includes("$(id)"), "a refused key is not repeated back");
await field.fill(KEY);
await routing.locator(".routing-key button", { hasText: "Save key" }).click();
await page.waitForFunction(() => document.querySelector("[data-testid='routing-key-state']")?.textContent === "A key is set.");
check(await field.inputValue() === "", "the field empties once the key is saved");
const page_html = await page.content();
const values = await page.evaluate(() => [...document.querySelectorAll("input, textarea")].map((node) => node.value).join("\n"));
check(!page_html.includes(KEY) && !values.includes(KEY), "the key is nowhere on the page after saving");
check(!logged.some((line) => line.includes(KEY)), "nor in the console");
check(await field.getAttribute("placeholder") === "Paste a new key to replace it", "a set key can be replaced");
await shot("key");
await routing.locator(".routing-key button", { hasText: "Remove" }).click();
await page.waitForFunction(() => document.querySelector("[data-testid='routing-key-state']")?.textContent === "No key is set.");
check(true, "a key can be removed");

// A file that already holds rules the first mate cannot use says so on opening.
await openSettings("routing=invalid");
check((await routing.locator(".routing-alert").innerText()).includes("The first mate can't use these rules: unverified harness: spaceship"), "rules already on disk that cannot be used say why");
await shot("invalid");

// A key set outside the app is reported, and left to where it was set.
await openSettings("routing=key");
await routing.locator("details.routing-key summary").click();
check((await routing.locator("[data-testid='routing-key-state']").innerText()) === "A key is set.", "a key already in the home reads as set");

// A home whose firstmate cannot set routing up says so, and offers nothing to click.
await openSettings("routing=unavailable");
check((await routing.locator(".routing-alert").innerText()).includes("no bin/fm-crew-dispatch.sh"), "a firstmate without the writer says so");
check(await toggle.isDisabled(), "and the switch cannot be used");
check(await routing.locator("details.routing-key").count() === 0, "and offers no key field");

// Nothing overflows the dialog or the page, at the width the app opens and at a narrow one.
await openSettings("routing=on");
for (const width of [1280, 760, 420]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(150);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over === 0, `nothing runs off the page at ${width}px (${over})`);
  const dialog = await page.locator(".settings-dialog").boundingBox();
  check(dialog !== null && dialog.y >= 0 && dialog.y + dialog.height <= 900, `the dialog fits the window at ${width}px`);
}

check(errors.length === 0, `the page raised no errors${errors.length ? `: ${errors.join("; ")}` : ""}`);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall routing checks passed");
