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
const tab = (name) => routing.locator(".routing-view [role='tab']", { hasText: name });
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
await routing.locator("[data-testid='rules-form']").waitFor();
check(await toggle.getAttribute("aria-checked") === "true", "routing is on");
check((await routing.innerText()).includes("The first mate follows these rules"), "and says the first mate follows them");
check(await routing.locator(".routing-primary", { hasText: "Save rules" }).isDisabled(), "there is nothing to save until the rules change");
check(await tab("Form").getAttribute("aria-selected") === "true", "the rules open as a form");
await shot("on");

// The form: a card per rule and the default, each harness chosen from firstmate's own list.
const cards = routing.locator("[data-testid='rule-card']");
check(await cards.count() === 3, `the example's three rules are each a card (${await cards.count()})`);
check(await routing.locator("[data-testid='rule-default'] [data-testid='choice-row']").count() === 2, "and the default tries two harnesses");
const harnessNames = await cards.nth(0).locator("select[aria-label^='Harness']").locator("option").allInnerTexts();
check(harnessNames.includes("claude") && harnessNames.includes("codex") && harnessNames.includes("pi"), `installed harnesses are offered plainly (${harnessNames.join(", ")})`);
check(harnessNames.includes("grok (not installed)") && harnessNames.includes("cursor (not installed)"), "a harness this Mac lacks is offered, marked as not installed");
check(harnessNames.length === 12 && !harnessNames.some((name) => name.includes("firstmate doesn't know")), "and nothing firstmate does not list");
check((await cards.nth(0).innerText()).includes("grok is not installed on this Mac"), "a rule on a missing harness says so");
check(await tab("JSON").click().then(() => routing.locator(".routing-rules").inputValue()) === example, "the untouched example reads back exactly as firstmate ships it");
await tab("Form").click();

// Effort is a list too, and an effort bound to a model waits for that model.
const big = cards.nth(2);
const codexEffort = big.locator("select[aria-label='Effort for rule 3, choice 2']");
const maxOption = codexEffort.locator("option[value='max']");
check(await maxOption.isDisabled() && (await maxOption.innerText()) === "max (needs gpt-5.6-luna)", "codex's max is offered only with the model that takes it");
await big.locator("input[aria-label='Model for rule 3, choice 2']").fill("gpt-5.6-luna");
check(!(await maxOption.isDisabled()), "and becomes a choice once that model is named");
await codexEffort.selectOption("max");
const claudeModels = await cards.nth(1).locator("datalist option").evaluateAll((nodes) => nodes.map((node) => node.value));
check(claudeModels.includes("haiku") && claudeModels.includes("claude-sonnet-5"), `a model is suggested from the rules already written (${claudeModels.join(", ")})`);

// Choosing another harness clears what belonged to the old one.
const trivial = cards.nth(1);
await trivial.locator("select[aria-label^='Harness']").selectOption("grok");
check(await trivial.locator("input[aria-label^='Model']").inputValue() === "", "choosing another harness clears the old harness's model");
check(await trivial.locator("select[aria-label^='Effort']").inputValue() === "low", "and keeps an effort the new harness takes");
await trivial.locator("select[aria-label^='Harness']").selectOption("cursor");
check(await trivial.locator("select[aria-label^='Effort']").inputValue() === "", "an effort the new harness does not take is dropped");
check(await trivial.locator("select[aria-label^='Effort']").isDisabled(), "and a harness with no effort setting offers none");
await trivial.locator("select[aria-label^='Harness']").selectOption("claude");

// Fallbacks: added, reordered, and tried in the order shown.
const news = cards.nth(0);
await news.locator("button", { hasText: "Add a fallback" }).click();
check(await news.locator("[data-testid='choice-row']").count() === 2, "a fallback adds a second harness to try");
check((await news.innerText()).includes("the first with quota left takes the work"), "and the rule says they are tried in order");
await news.locator("button[title='Try this one earlier']").nth(1).click();
const order = await news.locator("select[aria-label^='Harness']").evaluateAll((nodes) => nodes.map((node) => node.value));
check(order.join(",") === "claude,grok", `moving it up changes the order it is tried in (${order.join(", ")})`);
await shot("form-edited");

await routing.locator(".routing-primary", { hasText: "Save rules" }).click();
await routing.locator(".routing-notice").waitFor();
check((await routing.locator(".routing-notice").innerText()).startsWith("Saved."), "the form's rules are saved through firstmate");
await tab("JSON").click();
const saved = JSON.parse(await routing.locator(".routing-rules").inputValue());
check(JSON.stringify(saved.rules[0].use) === '[{"harness":"claude"},{"harness":"grok"}]', `the fallback is saved as an ordered list (${JSON.stringify(saved.rules[0].use)})`);
check(JSON.stringify(saved.rules[2].use[1]) === '{"harness":"codex","model":"gpt-5.6-luna","effort":"max"}', "the model and effort are saved together");
check(saved.rules[1].why === JSON.parse(example).rules[1].why && JSON.stringify(saved.default) === JSON.stringify(JSON.parse(example).default), "everything not edited is saved as it was");

// Written as JSON, a rule the first mate cannot use is refused in its words, and the edit is kept to fix.
const broken = '{ "rules": [ { "when": "Everything.", "use": { "harness": "spaceship" } } ] }';
await routing.locator(".routing-rules").fill(broken);
await routing.locator(".routing-primary", { hasText: "Save rules" }).click();
await routing.locator(".routing-alert").waitFor();
check((await routing.locator(".routing-alert").innerText()).includes("unverified harness: spaceship"), "rules the first mate cannot use are refused with its reason");
check(await routing.locator(".routing-rules").inputValue() === broken, "a refused edit stays on screen to fix");
await shot("refused");
await tab("Form").click();
check((await routing.locator("[data-testid='rule-card']").innerText()).includes("Firstmate doesn't know a harness called spaceship"), "the form shows a harness firstmate does not know, and says so");
await tab("JSON").click();

// Turning off with an edit unsaved would lose it, so it asks for a save or an undo first.
await toggle.click();
check(await toggle.getAttribute("aria-checked") === "true", "routing stays on while an edit is unsaved");
check((await routing.locator(".routing-alert").innerText()).includes("Save or undo"), "and says what to do first");

const fixed = '{\n  "rules": [],\n  "default": [\n    { "harness": "codex", "model": "gpt-5.5" },\n    { "harness": "claude" }\n  ]\n}\n';
await routing.locator(".routing-rules").fill(fixed);
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
await routing.locator(".routing-rules-head").waitFor();
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

// Fields the form has no control for are named on the rule they belong to, and kept through an edit.
await openSettings("routing=rich");
const rich = routing.locator("[data-testid='rule-card']");
check((await rich.innerText()).includes('This rule also sets "approval", "floor"'), "a rule's fields the form cannot edit are named");
check((await rich.innerText()).includes('Also sets "provider"') && (await rich.innerText()).includes('Also sets "floor"'), "and so are a choice's");
check((await routing.locator("[data-testid='rules-form']").innerText()).includes('This file also sets "notes"'), "and the file's own");
await rich.locator("input[aria-label='Model for rule 1, choice 2']").fill("gpt-5.5");
await routing.locator(".routing-primary", { hasText: "Save rules" }).click();
await routing.locator(".routing-notice").waitFor();
await tab("JSON").click();
const kept = JSON.parse(await routing.locator(".routing-rules").inputValue());
check(kept.rules[0].approval === "captain" && kept.rules[0].floor.min_percent === 20 && kept.rules[0].use[0].provider === "codex" && kept.rules[0].use[1].floor.min_percent === 50 && kept.notes === "Kept by hand.", "an edit in the form keeps every field it does not show");
check(Object.keys(kept.rules[0]).join(",") === "when,approval,floor,use", "in the order the file had them");
await shot("rich");

// Rules the form cannot show open as JSON, saying why, rather than being reshaped.
await openSettings("routing=unshowable");
check(await tab("Form").isDisabled() && await tab("JSON").getAttribute("aria-selected") === "true", "rules the form cannot show open as JSON");
check((await routing.locator(".routing-form-blocked").innerText()).includes("its rules are not a list"), "and say why");

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
