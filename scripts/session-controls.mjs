// Checks the first mate's session controls in the composer on the browser mock: the slash palette drawn from the
// commands the session advertised, the Model and Effort pills and every state a change goes through, the Calm switch,
// and what Calm does to a running turn, Calm off beside Calm on, including under reduced motion.
//
//   pnpm dev --port 4194 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4194 pnpm session
//
// The mock answers from the payloads claude-agent-acp 0.69.0 really sent (src/host/mock-session.ts documents
// `?session`, `?calm` and `?turn`). Set ARTIFACT_SHOTS to a folder to also save a screenshot of every state in both
// themes; each file is named for its state.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4194. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const saved = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

async function open(query = "", { reducedMotion = "no-preference", viewport = { width: 1280, height: 860 } } = {}) {
  const page = await browser.newPage({ viewport, reducedMotion });
  page.on("pageerror", (error) => failures.push(`${query}: ${error.message}`));
  await page.goto(`${baseUrl}/${query}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  // A narrow window folds the sidebar behind its menu button.
  if (viewport.width <= 760) await page.locator(".mobile-menu").click();
  await page.getByRole("button", { name: /^Chat/ }).first().click();
  // The session's options arrive with it, its commands a moment later (under a second on the mock).
  await page.locator(".session-pill[data-category]").first().waitFor();
  await page.waitForTimeout(1000);
  return page;
}

async function shot(page, name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(120);
    const path = join(shots, `session-${name}-${theme}.png`);
    await page.screenshot({ path });
    saved.push(path);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

const composer = (page) => page.getByLabel("Message the first mate");
const palette = (page) => page.locator(".slash-palette");
const names = (page) => page.locator(".slash-name").allInnerTexts();
const pill = (page, category) => page.locator(`.session-pill[data-category=${category}]`);
const notice = (page) => page.locator(".session-notice");

async function type(page, text) {
  await composer(page).click();
  await composer(page).fill(text);
  await page.waitForTimeout(80);
}

// 1. The palette at /, from the 59 commands the session advertised, A to Z.
{
  const page = await open();
  await type(page, "/");
  await palette(page).waitFor();
  const all = await names(page);
  check(all.length === 59, `/ lists all 59 advertised commands (${all.length})`);
  check(all[0] === "/afk" && all.includes("/code-review") && all.includes("/__remote-workflow"), "A to Z, everything advertised, nothing of the app's own");
  check((await page.locator(".palette-head").innerText()).includes("59 commands this session offers"), "the header counts them");
  check(!all.includes("/calm"), "Calm is not listed: the session does not advertise it");
  await shot(page, "palette-all");

  // /a narrows to the commands starting with a.
  await type(page, "/a");
  const a = await names(page);
  check(JSON.stringify(a) === JSON.stringify(["/afk", "/agents", "/ahoy", "/auto-mode-setup", "/autocompact"]), `/a shows the five commands starting with a (${a.join(" ")})`);
  check((await page.locator(".palette-head").innerText()).includes("5 commands start with /a"), "and says so");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  check((await page.locator(".slash-command.active .slash-name").innerText()) === "/ahoy", "arrow keys move the choice");
  await shot(page, "palette-a");
  await page.keyboard.press("Tab");
  check((await composer(page).inputValue()) === "/ahoy ", "Tab fills the command and a space");
  check(!(await palette(page).isVisible()), "and the palette closes");
  check((await page.locator(".captain-message").count()) === 0, "choosing a command never sends it");

  // A command with an argument hint keeps it visible until typed over.
  await type(page, "/code-r");
  await page.keyboard.press("Enter");
  check((await composer(page).inputValue()) === "/code-review ", "Enter fills too, and sends nothing");
  check((await page.locator(".composer-ghost").innerText()).includes("[low|medium|high|xhigh|max|ultra]"), "the argument hint shows as ghost text");
  await shot(page, "palette-hint");
  await page.keyboard.type("high");
  check((await page.locator(".composer-ghost").count()) === 0, "and goes once the captain types over it");

  // Esc closes; typing again opens it.
  await type(page, "/b");
  await page.keyboard.press("Escape");
  check(!(await palette(page).isVisible()), "Esc closes the palette");
  await page.keyboard.type("a");
  check(await palette(page).isVisible(), "typing in the first word opens it again");

  // Nothing matching, and /calm.
  await type(page, "/zz");
  check((await palette(page).innerText()).includes("No command starts with /zz.") && (await palette(page).innerText()).includes("sends it to the first mate as an ordinary message"), "nothing matching says what Enter does");
  await shot(page, "palette-no-match");
  await type(page, "/calm");
  check((await palette(page).innerText()).includes("Calm is the switch beside Model and Effort"), "/calm points at the switch");
  await shot(page, "palette-calm");

  // /effort opens the Effort control instead of filling the composer.
  await type(page, "/ef");
  check((await page.locator(".slash-desc em").innerText()).includes("Opens the Effort control"), "/effort says it opens the control");
  check((await page.locator(".palette-keys").innerText()).includes("opens Effort"), "and the keys say so");
  await shot(page, "palette-effort-route");
  await page.keyboard.press("Enter");
  check(await page.getByRole("menu", { name: "Effort" }).isVisible(), "Enter on /effort opens the Effort menu");
  check((await composer(page).inputValue()) === "", "and leaves nothing to send as text");
  await page.keyboard.press("Escape");

  // A typed /model the session offers goes through the control, not as words.
  await type(page, "/model sonnet");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".session-pill[data-category=model] .v")?.textContent === "Sonnet");
  check((await page.locator(".captain-message").count()) === 0, "a typed /model sonnet sets the model and sends no message");
  await page.close();
}

// 2. The palette's empty states.
for (const [state, words] of [["waiting", "Commands appear once the first mate has started."], ["empty", "This first mate offers no commands."]]) {
  const page = await open(`?session=${state}`);
  await type(page, "/");
  check((await palette(page).innerText()).includes(words), `${state}: ${words}`);
  await shot(page, `palette-${state}`);
  await page.close();
}

// 3. Model and effort.
{
  const page = await open();
  check((await pill(page, "model").innerText()).replace(/\s+/g, " ").includes("Model Default · Opus"), "the model pill names what Default is, from the session");
  check((await pill(page, "thought_level").innerText()).replace(/\s+/g, " ").includes("Effort Default"), "the effort pill");
  await shot(page, "rest");
  await pill(page, "model").click();
  const menu = page.getByRole("menu", { name: "Model" });
  const offered = await menu.getByRole("menuitemradio").allInnerTexts();
  check(offered.length === 5 && offered[0].startsWith("Default") && offered.some((text) => text.startsWith("Fable")), "the menu lists the five models the session offers");
  check((await menu.getByRole("menuitemradio", { checked: true }).innerText()).startsWith("Default"), "the current one is ticked");
  await shot(page, "model-open");
  await page.keyboard.press("Escape");
  await pill(page, "thought_level").click();
  const efforts = await page.getByRole("menu", { name: "Effort" }).getByRole("menuitemradio").allInnerTexts();
  check(efforts.join(",") === "Default,Low,Medium,High,Xhigh,Max", `the six efforts (${efforts.join(",")})`);
  await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".session-pill[data-category=thought_level] .v")?.textContent === "High");
  await pill(page, "thought_level").click();
  await shot(page, "effort-open");
  await page.keyboard.press("Escape");
  // Haiku offers no effort; back on Sonnet, the effort chosen comes back.
  await pill(page, "model").click();
  await page.getByRole("menuitemradio", { name: /^Haiku/ }).click();
  await page.waitForFunction(() => document.querySelector(".session-pill[data-category=thought_level]")?.textContent?.includes("none for Haiku"));
  check(true, "on Haiku, Effort says none for Haiku");
  await pill(page, "model").click();
  await page.getByRole("menuitemradio", { name: /^Sonnet/ }).click();
  await page.waitForFunction(() => document.querySelector(".session-pill[data-category=thought_level] .v")?.textContent === "High");
  check(true, "back on Sonnet, Effort comes back at High");
  await page.close();
}
{
  const page = await open("?session=haiku");
  check((await pill(page, "thought_level").innerText()).replace(/\s+/g, " ").includes("Effort none for Haiku"), "a session on Haiku draws no effort as if it worked");
  await shot(page, "haiku");
  await page.close();
}

// 4. A change on its way shows nothing it has not confirmed.
{
  const page = await open("?session=slow");
  await pill(page, "model").click();
  await page.getByRole("menuitemradio", { name: /^Sonnet/ }).click();
  await page.locator(".session-pill.busy").waitFor();
  check((await pill(page, "model").locator(".v").innerText()) === "Default · Opus", "while switching, the pill still shows what the session is on");
  check((await pill(page, "model").getAttribute("title")) === "Switching to Sonnet…", "and says what it is switching to");
  await shot(page, "switching");
  await page.waitForFunction(() => document.querySelector(".session-pill[data-category=model] .v")?.textContent === "Sonnet", null, { timeout: 8000 });
  check(true, "Sonnet shows once the session confirmed it");
  await page.close();
}

// 5. Refused, the session gone, no options at all, a pick not applied at start, and a model that cannot run the home's mode.
{
  const page = await open("?session=refuse");
  await pill(page, "model").click();
  await page.getByRole("menuitemradio", { name: /^Fable/ }).click();
  await notice(page).waitFor();
  const said = await notice(page).innerText();
  check(said.includes("Couldn't switch to Fable.") && said.includes("“Invalid value for config option model: claude-fable-5[1m]”") && said.includes("It is still on Default · Opus."), `a refusal gives the session's own reason and what it is on (${said})`);
  check(await pill(page, "model").evaluate((element) => element.classList.contains("bad")), "and marks the pill");
  await shot(page, "refused");
  await page.close();
}
{
  const page = await open("?session=gone");
  await pill(page, "thought_level").click();
  await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
  await notice(page).waitFor();
  const said = await notice(page).innerText();
  check(said.includes("Couldn't change effort: the first mate's session has ended. Nothing changed.") && said.includes("Restart"), "a session that ended refuses before anything reaches it");
  check((await pill(page, "thought_level").locator(".v").innerText()) === "Default", "and nothing changed");
  await shot(page, "session-gone");
  await page.close();
}
{
  const page = await open("?session=none");
  check((await page.locator(".session-pill.off").first().innerText()).replace(/\s+/g, " ").includes("Model not offered by this first mate"), "an adapter with no options says so");
  check((await pill(page, "thought_level").count()) === 0, "and draws no Effort");
  await shot(page, "no-options");
  await page.close();
}
{
  const page = await open("?session=problem");
  const said = await notice(page).innerText();
  check(said.includes("Your model pick, Sonnet, wasn't applied when the first mate started:") && said.includes("It is on Default · Opus."), "a pick the session would not take at start says so, and what it runs on");
  await shot(page, "pick-not-applied");
  await page.close();
}
{
  const page = await open("?session=auto");
  await pill(page, "model").click();
  await page.getByRole("menuitemradio", { name: /^Haiku/ }).click();
  await notice(page).waitFor();
  check((await notice(page).innerText()).includes("Haiku can't run this home's auto permissions, so the first mate stayed on Default"), "a model that would drop the home's mode is refused, with why");
  await pill(page, "model").click();
  const haiku = page.getByRole("menuitemradio", { name: /^Haiku/ });
  check(await haiku.isDisabled(), "and drawn disabled afterwards");
  check((await haiku.innerText()).includes("can't run this home's auto permissions"), "with the reason in place of its description");
  await shot(page, "model-unfit");
  await page.close();
}

// 6. Stopped: the last values stay, dimmed, and cannot be changed.
{
  const page = await open();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Stop" }).click();
  await page.waitForFunction(() => document.querySelector(".session-pill[data-category=model]")?.hasAttribute("disabled"));
  check((await pill(page, "model").locator(".v").innerText()) === "Default · Opus", "stopped, the model pill keeps the last value");
  check((await pill(page, "model").getAttribute("title")).includes("applied again when it starts"), "and says the pick comes back at the next start");
  const before = await page.locator(".captain-message").count();
  await type(page, "/model sonnet");
  await composer(page).press("Enter");
  await notice(page).waitFor();
  check((await notice(page).innerText()).includes("The switch to Sonnet can be made once the first mate is running, so nothing was sent."), "a typed /model while stopped says it waits for the first mate");
  check((await composer(page).inputValue()) === "/model sonnet" && (await page.locator(".captain-message").count()) === before, "and keeps the draft rather than sending it as text");
  await shot(page, "typed-not-live");
  await shot(page, "stopped");
  await page.close();
}

// 7. Calm: a turn at five moments, Calm off beside Calm on.
const MOMENTS = ["sent", "first-tools", "still-working", "reply-arriving", "settled"];
for (const [index, moment] of MOMENTS.entries()) {
  for (const calm of ["off", "on"]) {
    const page = await open(`?turn=${index + 1}${calm === "on" ? "&calm=on" : ""}`);
    await page.locator(".captain-message", { hasText: "Is the release branch green?" }).waitFor();
    await page.waitForTimeout(200);
    const switchOn = await page.getByRole("switch", { name: "Calm" }).getAttribute("aria-checked");
    check(switchOn === (calm === "on" ? "true" : "false"), `${moment}, Calm ${calm}: the switch reads ${calm}`);
    const row = page.locator(".working-row");
    const steps = await page.locator(".step-group").count();
    const text = await page.locator(".chat-messages").innerText();
    const live = index < 4;
    if (calm === "on") {
      check((await row.count()) === (live ? 1 : 0), `${moment}, Calm on: the working row ${live ? "shows" : "is gone"}`);
      check(steps === 0, `${moment}, Calm on: no steps`);
      if (live) check(await page.locator(".chat-messages > :last-child").evaluate((element) => element.classList.contains("working-row")), `${moment}, Calm on: the working row is the chat's last line`);
      if (index === 0) check(text.includes("Let me check CI and the"), "sent, Calm on: the note shows while it streams");
      if (index >= 1) check(!text.includes("Let me check CI and the open PRs first."), `${moment}, Calm on: the note followed by steps is hidden`);
      if (index >= 2) check(!text.includes("Two runs are still going"), `${moment}, Calm on: the second note is hidden`);
    } else {
      check((await row.count()) === 0, `${moment}, Calm off: no working row`);
      if (index >= 1) check(steps > 0, `${moment}, Calm off: the steps show`);
      if (index >= 1) check(text.includes("Let me check CI and the open PRs first."), `${moment}, Calm off: the notes stay`);
    }
    check(text.includes("Start the attachments task when CI is green.") && text.includes("Will do. It is queued behind the release check."), `${moment}, Calm ${calm}: the conversation around the turn stays`);
    if (index >= 3) check(text.includes("Yes. Both runs on release/0.9"), `${moment}, Calm ${calm}: the reply shows as it streams`);
    await shot(page, `turn-${index + 1}-${moment}-calm-${calm}`);
    await page.close();
  }
}

// Toggling Calm redraws the window at once, and sends nothing.
{
  const page = await open("?turn=3");
  check((await page.locator(".step-group").count()) > 0, "Calm off: steps show");
  await page.getByRole("switch", { name: "Calm" }).click();
  await page.waitForFunction(() => document.querySelector("[role=switch][aria-label=Calm]")?.getAttribute("aria-checked") === "true");
  check((await page.locator(".step-group").count()) === 0 && (await page.locator(".working-row").count()) === 1, "turning Calm on hides the steps and draws the working row at once");
  check((await page.locator(".captain-message").count()) === 2, "and sends nothing to the first mate");
  await page.getByRole("switch", { name: "Calm" }).click();
  await page.waitForFunction(() => document.querySelector("[role=switch][aria-label=Calm]")?.getAttribute("aria-checked") === "false");
  check((await page.locator(".step-group").count()) > 0, "turning it off shows them again: hidden, not lost");
  await page.close();
}

// The working row moves at Calm's pace, and holds still under reduced motion.
{
  const page = await open("?turn=2&calm=on");
  const moving = await page.locator(".working-water").evaluate((element) => getComputedStyle(element).animationName);
  const drifting = await page.locator(".working-boat").evaluate((element) => getComputedStyle(element).animationName);
  check(moving === "calm-swell" && drifting === "calm-drift", `the water swells and the boat drifts (${moving}, ${drifting})`);
  check((await page.locator(".working-row time").innerText()).startsWith("Working · 0:0"), "the row says it is working, with the turn's time");
  await page.close();
  const still = await open("?turn=2&calm=on", { reducedMotion: "reduce" });
  const water = await still.locator(".working-water").evaluate((element) => getComputedStyle(element).animationName);
  const boat = await still.locator(".working-boat").evaluate((element) => getComputedStyle(element).animationName);
  check(water === "none" && boat === "none", `under reduced motion nothing moves (${water}, ${boat})`);
  await shot(still, "working-row-reduced-motion");
  await still.close();
}

// Calm that cannot be kept, and a firstmate that predates fm-calm.sh.
{
  const page = await open("?calm=denied");
  check((await page.getByRole("switch", { name: "Calm" }).getAttribute("aria-checked")) === "true", "denied: Calm reads on");
  await page.getByRole("switch", { name: "Calm" }).click();
  await notice(page).waitFor();
  const said = await notice(page).innerText();
  check(said.includes("Calm wasn't saved. fm-calm.sh said: “config/calm: Permission denied”. The chat is unchanged."), `a Calm that cannot be kept says why (${said})`);
  check((await page.getByRole("switch", { name: "Calm" }).getAttribute("aria-checked")) === "true", "and the switch stays as it was");
  await shot(page, "calm-denied");
  await page.close();
}
{
  const page = await open("?calm=missing");
  check(await page.getByRole("switch", { name: "Calm" }).isDisabled(), "a firstmate without fm-calm.sh: the switch is disabled");
  check((await page.locator(".session-note").innerText()).includes("Calm needs a newer firstmate: this home has no fm-calm.sh."), "and the composer says why under it");
  await shot(page, "calm-missing");
  await page.close();
}

// The narrow window: the bar wraps rather than spilling.
{
  const page = await open("?turn=4&calm=on", { viewport: { width: 700, height: 860 } });
  const spill = await page.locator(".composer").evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  check(!spill, "at a narrow width the composer bar stays inside the composer");
  await shot(page, "narrow");
  await page.close();
}

await browser.close();
if (saved.length) console.log(`\n${saved.length} screenshots:\n${saved.join("\n")}`);
if (failures.length) {
  console.log(`\n${failures.length} failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nall session control checks passed");
