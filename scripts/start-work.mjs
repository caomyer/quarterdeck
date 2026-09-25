// Checks starting work on a queued task from its drawer, in both themes, on the browser mock: every state the drawer
// can be in, what the ask says, and that nothing reads Working until the snapshot has seen the worker's agent alive.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm starts
//
// `?start=<outcome>` picks how the mock's first mate answers the ask (src/host/mock.ts `startTurn`), so each state is
// reached the way a captain reaches it: by pressing Start work and handing the task over.
// Set ARTIFACT_SHOTS to a folder to also save screenshots in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4191. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const SCOUT = "res-chapters-scout";
const SHIP = "res-waveform-colors";
const NOTE = "check the review cards from #11 while you are in there";

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

/** Opens the mock with `flags`, goes to resonance's page, and opens a queued row's drawer. */
async function openQueued(flags, id) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => failures.push(`${flags}: page error: ${error.message}`));
  await page.goto(`${baseUrl}/?artifacts&${flags}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  // Hand over only once the first mate has started, as a captain would find it.
  if (!flags.includes("not-started")) await page.locator(".connection small", { hasText: "Ready" }).waitFor();
  await page.locator(".project-shortcuts button", { hasText: "resonance" }).click();
  // The project's posture comes with the first mate's first snapshot.
  if (!flags.includes("not-started")) await page.locator(".page-heading span", { hasText: "Product work fully checked" }).waitFor();
  await page.locator(`[data-testid='project-queue'] .task-row[data-id='${id}']`).click();
  const drawer = page.locator("[data-testid='queued-drawer']");
  await drawer.waitFor();
  return { page, drawer };
}

const phaseOf = (drawer) => drawer.getAttribute("data-phase").catch(() => null);
const statusOf = (drawer) => drawer.locator("[data-testid='start-status'] strong").innerText().catch(() => "");

/**
 * Follows the drawer until it reaches `until`, recording each phase it shows and what its status card said, so the
 * order is checked, not just the end.
 */
async function follow(drawer, until, limit = 12_000) {
  const seen = [];
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const phase = await phaseOf(drawer);
    const status = await statusOf(drawer);
    if (phase && (seen.at(-1)?.phase !== phase || seen.at(-1)?.status !== status)) seen.push({ phase, status });
    if (phase === until) break;
    await drawer.page().waitForTimeout(100);
  }
  return seen;
}

/** Opens the panel, writes the note, picks the mode (`no-mistakes` or `direct-PR`), and hands the task over. */
async function handOver(drawer, { note = "", mode = null } = {}) {
  await drawer.getByRole("button", { name: "Start work…" }).click();
  if (note) await drawer.getByLabel("Anything to add?").fill(note);
  if (mode) await drawer.locator(`.start-modes input[value='${mode}']`).check();
  await drawer.getByRole("button", { name: "Hand to the first mate" }).click();
}

/** The status card's colour against the token it must be painted with, and its icon, in both themes. */
async function tone(page, drawer, token, icon, what) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    const want = await page.evaluate((name) => {
      if (!getComputedStyle(document.documentElement).getPropertyValue(name).trim()) return null;
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    }, token);
    const strong = drawer.locator("[data-testid='start-status'] strong");
    const got = await strong.evaluate((element) => getComputedStyle(element).color);
    check(want !== null && got === want, `${theme}: ${what} is painted ${token}`);
    const classes = (await drawer.locator("[data-testid='start-status'] .task-state svg").getAttribute("class")) ?? "";
    check(classes.split(/\s+/).includes(icon), `${theme}: ${what} wears ${icon}`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

async function shot(page, name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

/** The captain's messages in chat, oldest first. */
async function sentInChat(page) {
  await page.locator(".primary-nav .nav-item", { hasText: "Chat" }).click();
  await page.locator(".composer").waitFor();
  // The words as sent, newlines and all: a paragraph's rendering folds them.
  return page.locator("article.captain-message > div > p").evaluateAll((items) => items.map((item) => item.textContent ?? ""));
}

/** Nothing in the drawer may say Working: not the status card, not the timeline, not anywhere. */
async function neverWorking(drawer, what) {
  check(!/\bWorking\b/.test(await drawer.innerText()), `${what}: nothing in the drawer reads "Working"`);
}

// A1 and A2: a queued ship offers Start work, and the panel asks for an optional note and an optional mode.
{
  const { page, drawer } = await openQueued("start", SHIP);
  check(await phaseOf(drawer) === "queued", "a queued ship's drawer is in the queued state");
  check(await statusOf(drawer) === "Queued", "its status card says Queued");
  const section = drawer.locator("[data-testid='start-work']");
  check((await section.innerText()).includes("The first mate will write the brief, pick how it ships, and start a worker."), "Start work says who does what");
  check((await section.innerText()).includes("Project posture: no-mistakes for product work"), "and names the project's posture beside the button");
  await tone(page, drawer, "--muted", "lucide-clock-3", "a queued row");
  await shot(page, "a1-queued");
  await drawer.getByRole("button", { name: "Start work…" }).click();
  const panel = drawer.locator("[data-testid='start-panel']");
  check(await panel.isVisible(), "Start work… opens the panel and sends nothing by itself");
  check(await panel.getByLabel("Anything to add?").inputValue() === "", "the note starts empty and is optional");
  const modes = await panel.locator(".start-modes label").allInnerTexts();
  check(modes.length === 3 && modes[0].startsWith("Let the first mate judge") && modes[1].startsWith("Full checks") && modes[2].startsWith("Straight to a PR"), `a ship offers three ways it ships (${modes.map((mode) => mode.split("\n")[0]).join(", ")})`);
  check(await panel.getByLabel("Let the first mate judge").isChecked(), "the first mate's judgement is the default");
  check(modes[0].includes("Product-facing or unsure: full checks. Internal tooling: straight to a PR."), "under no-mistakes-prod-only, the judgement is spelled out");
  check(!/yolo|merge/i.test(modes.join(" ")), "yolo and merge authority are not offered");
  await shot(page, "a2-panel");
  await panel.getByRole("button", { name: "Cancel" }).click();
  check(await drawer.locator("[data-testid='start-panel']").count() === 0 && await phaseOf(drawer) === "queued", "Cancel closes the panel and the row stays queued");
  const chat = await sentInChat(page);
  check(!chat.some((text) => text.startsWith("Start work on")), "opening and cancelling the panel sent nothing");
  await page.close();
}

// A scout has no delivery mode to choose.
{
  const { page, drawer } = await openQueued("start", SCOUT);
  await drawer.getByRole("button", { name: "Start work…" }).click();
  check(await drawer.locator(".start-modes").count() === 0, "a scout's panel offers no mode");
  check(!(await drawer.locator("[data-testid='start-panel']").innerText()).includes("How it ships"), "and does not ask how it ships");
  await page.close();
}

// A3: the first mate is not running, so nothing can be handed to it; starting it is the one thing on offer.
{
  const { page, drawer } = await openQueued("start&not-started", SCOUT);
  check(await phaseOf(drawer) === "offline", "with the first mate not started here, the drawer says so");
  const section = drawer.locator("[data-testid='start-work']");
  check((await section.innerText()).includes("Only the first mate starts work, and it isn't running."), "it says why nothing can start");
  check(await section.getByRole("button", { name: "Start work…" }).isDisabled(), "Start work… is disabled");
  await shot(page, "a3-offline");
  await section.getByRole("button", { name: "Start the first mate" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid='queued-drawer']")?.getAttribute("data-phase") === "queued", null, { timeout: 8000 }).catch(() => undefined);
  check(await phaseOf(drawer) === "queued", "Start the first mate starts it, and Start work is offered");
  await page.close();
}

// B1, B2, B3: handing a scout over moves the drawer through Asked, Launched and Working, in that order, and Working
// only comes once the snapshot has seen the agent alive. Right after the spawn the probe reads only a shell.
{
  const { page, drawer } = await openQueued("start", SCOUT);
  await handOver(drawer, { note: NOTE });
  const seen = await follow(drawer, "working");
  const order = seen.map((item) => item.phase);
  console.log(`   ${seen.map((item) => `${item.phase} (${item.status})`).join(" > ")}`);
  const asked = order.indexOf("asked");
  const launched = order.indexOf("starting");
  const working = order.indexOf("working");
  check(asked >= 0 && launched > asked && working > launched, "the drawer moved through Asked, Launched and Working, in that order");
  check(seen.find((item) => item.phase === "asked")?.status === "Handed to the first mate", "Asked reads Handed to the first mate");
  check(seen.find((item) => item.phase === "starting")?.status === "Starting", "Launched reads Starting while the probe has not seen its agent");
  check(!seen.slice(0, working).some((item) => /working/i.test(item.status)), "nothing read Working before the agent was seen alive");
  check(!order.includes("didnt_start"), "a shell-only reading right after the launch is not called a failure");
  await tone(page, drawer, "--green", "lucide-circle-play", "Working");
  const timeline = await drawer.locator(".timeline").innerText();
  check(timeline.includes("Handed to the first mate") && timeline.includes("Launched"), "the timeline shows the ask and the launch");
  check(await drawer.locator("[data-testid='how-it-ships']").count() === 0, "a scout shows no mode");
  await shot(page, "b3-working");
  const chat = await sentInChat(page);
  const ask = chat.find((text) => text.startsWith("Start work on"));
  check(ask === `Start work on ${SCOUT} (resonance): Resonance: which feeds publish chapters?\nFrom me: ${NOTE}`, `the ask is sent as one plain message, the note in the captain's words (${JSON.stringify(ask)})`);
  await page.close();
}

// B1 stays while the first mate is still reading, and says what was asked.
{
  const { page, drawer } = await openQueued("start=slow", SHIP);
  await handOver(drawer, { note: NOTE });
  await follow(drawer, "asked");
  check(await phaseOf(drawer) === "asked", "an ask still being read stays Asked");
  const section = await drawer.locator("[data-testid='start-work']").innerText();
  check(section.includes(NOTE) && section.includes("The first mate's call"), "Asked shows the note and that the mode is the first mate's call");
  check((await drawer.locator("[data-testid='timeline-asked']").innerText()).includes("Waiting to be read"), "the timeline says the ask is not read yet");
  await tone(page, drawer, "--blue", "lucide-ellipsis", "Asked");
  await neverWorking(drawer, "Asked");
  await shot(page, "b1-asked");
  await page.close();
}

// B2 and B3 for a ship: the mode is the worker's own, from the snapshot, and a lighter one says why.
{
  const { page, drawer } = await openQueued("start=launch", SHIP);
  await handOver(drawer);
  await follow(drawer, "starting");
  check(await phaseOf(drawer) === "starting", "a launched ship reads Starting");
  await tone(page, drawer, "--blue", "lucide-ellipsis", "Starting");
  await neverWorking(drawer, "Starting");
  check((await drawer.locator("[data-testid='how-it-ships']").innerText()).startsWith("no-mistakes"), "How it ships names the worker's mode");
  await shot(page, "b2-starting");
  await follow(drawer, "working");
  const chat = await sentInChat(page);
  check(chat.some((text) => text === `Start work on ${SHIP} (resonance): Resonance: colour the snip waveform by speaker\nHow it ships: your call, by the project's posture.`), "a ship's ask leaves the mode to the first mate by default");
  await page.close();
}
{
  const { page, drawer } = await openQueued("start=light", SHIP);
  await handOver(drawer);
  await follow(drawer, "working");
  const how = await drawer.locator("[data-testid='how-it-ships']").innerText();
  check(how.startsWith("direct-PR") && how.includes("Mode: direct-PR, because this only changes the app's own drawing code"), "a lighter mode the first mate picked shows its reason, from the row");
  await page.close();
}
{
  const { page, drawer } = await openQueued("start=light", SHIP);
  await handOver(drawer, { mode: "direct-PR" });
  await follow(drawer, "working");
  check((await drawer.locator("[data-testid='how-it-ships']").innerText()).includes("You asked for it."), "a lighter mode the captain chose says so");
  const chat = await sentInChat(page);
  check(chat.some((text) => text.split("\n")[1] === "How it ships: straight to a PR (direct-PR)."), "the captain's override is stated in the ask in their words");
  await page.close();
}

// C2: the first mate answered instead of starting it, or one of fm-spawn.sh's refusals stopped it. The row stays
// queued, and the reason is in chat, in the first mate's words.
const REFUSALS = {
  "decline": "it needs the snip lifecycle work to land first",
  "refused-mode": "error: delivery mismatch for res-chapters-scout: the brief says mode=no-mistakes but this spawn passed --mode direct-PR",
  "refused-blanks": "still contains {TASK} or {FIRSTMATE_SPEC}; fill ## Captain's intent and ## Firstmate spec before spawn",
  "refused-empty": "must contain nonempty ## Captain's intent and ## Firstmate spec subsections",
  "refused-unknown": "error: task res-chapters-scout has no backlog item in this home",
};
for (const [outcome, words] of Object.entries(REFUSALS)) {
  const { page, drawer } = await openQueued(`start=${outcome}`, SCOUT);
  await handOver(drawer);
  const seen = await follow(drawer, "not_started");
  check(await phaseOf(drawer) === "not_started", `${outcome}: the drawer says Not started`);
  check(!seen.some((item) => ["starting", "working"].includes(item.phase)), `${outcome}: it never read Starting or Working`);
  check((await drawer.locator("[data-testid='start-work']").innerText()).includes("Read its answer"), `${outcome}: it points to the answer in chat`);
  if (outcome === "decline") {
    await tone(page, drawer, "--amber", "lucide-circle-question-mark", "Not started");
    await shot(page, "c2-not-started");
    await drawer.getByRole("button", { name: "Start work…" }).click();
    check(await drawer.locator("[data-testid='start-panel']").isVisible(), "Start work… asks again from the same drawer");
  }
  await neverWorking(drawer, outcome);
  const queueRow = page.locator(`[data-testid='project-queue'] .task-row[data-id='${SCOUT}']`);
  check(await queueRow.count() === 1, `${outcome}: the row is still queued on the project page`);
  await page.locator(".primary-nav .nav-item", { hasText: "Chat" }).click();
  const chat = await page.locator("[data-testid='chat-messages']").innerText();
  check(chat.includes(words), `${outcome}: the first mate's explanation is in chat`);
  await page.close();
}

// A4: the first mate turned the ask into a question for the captain, so the row is a call now, answered on Bearings.
{
  const { page, drawer } = await openQueued("start=hold", SCOUT);
  await handOver(drawer);
  await follow(drawer, "held");
  check(await phaseOf(drawer) === "held", "a row the first mate put to the captain reads Waiting");
  check((await drawer.locator("[data-testid='start-work']").innerText()).includes("This waits on your answer, not on a worker."), "it waits on the captain, not a worker");
  check(await drawer.getByRole("button", { name: "Start work…" }).count() === 0, "and offers no Start");
  await tone(page, drawer, "--amber", "lucide-circle-question-mark", "Waiting on the captain");
  await shot(page, "a4-held");
  await drawer.getByRole("button", { name: "Open the call" }).click();
  await page.locator(`.decision-card[data-call-id='${SCOUT}']`).waitFor({ timeout: 5000 }).catch(() => undefined);
  check(await page.locator(`.decision-card[data-call-id='${SCOUT}']`).count() === 1, "Open the call shows the call on Bearings");
  await page.close();
}

// C3: a worker was launched but its agent never started, read well after the launch. Never Working.
{
  const { page, drawer } = await openQueued("start=no-agent", SCOUT);
  await handOver(drawer);
  await follow(drawer, "didnt_start");
  check(await phaseOf(drawer) === "didnt_start", "an in-flight task whose endpoint reads dead says Didn't start");
  check(await statusOf(drawer) === "Didn't start", "its status card says Didn't start");
  await neverWorking(drawer, "endpoint dead");
  await tone(page, drawer, "--coral", "lucide-circle-x", "Didn't start");
  check(await drawer.locator("[data-testid='worker-screen'] pre").isVisible(), "the worker's screen is open, as the evidence");
  await shot(page, "c3-didnt-start");
  await drawer.getByRole("button", { name: "Ask the first mate to relaunch" }).click();
  const draft = await page.locator(".composer textarea").inputValue();
  check(draft.startsWith(`${SCOUT} didn't start`), "relaunch goes through the first mate, drafted in chat for the captain to send");
  check(!(await sentInChat(page)).some((text) => text.includes("relaunch")), "and nothing is sent without the captain");
  await page.close();
}

// C4: launched on a backend with no classifier, so nothing can say whether the agent runs. Never Working.
{
  const { page, drawer } = await openQueued("start=unconfirmed", SHIP);
  await handOver(drawer);
  await follow(drawer, "unconfirmed");
  check(await phaseOf(drawer) === "unconfirmed", "an in-flight task whose endpoint reads unknown says Launched, not confirmed");
  check(await statusOf(drawer) === "Launched, not confirmed", "its status card says it cannot tell");
  await neverWorking(drawer, "endpoint unknown");
  await tone(page, drawer, "--amber", "lucide-triangle-alert", "Launched, not confirmed");
  await shot(page, "c4-unconfirmed");
  await drawer.getByRole("button", { name: "Show the screen" }).click();
  check(await drawer.locator("[data-testid='worker-screen'] pre").isVisible(), "Show the screen opens the worker's screen");
  await page.close();
}

// C5: the row moved to In flight but no worker is registered.
{
  const { page, drawer } = await openQueued("start=orphan", SCOUT);
  await handOver(drawer);
  await follow(drawer, "orphaned");
  check(await phaseOf(drawer) === "orphaned" && await statusOf(drawer) === "Not picked up", "a row in main_inventory.orphan_in_flight says Not picked up");
  await neverWorking(drawer, "orphaned");
  await tone(page, drawer, "--amber", "lucide-triangle-alert", "Not picked up");
  await shot(page, "c5-orphaned");
  await page.close();
}

// C1: the ask never reached the first mate, or its turn errored before reading it. Send again sends it again.
{
  const { page, drawer } = await openQueued("start=unsent", SCOUT);
  await handOver(drawer, { note: NOTE });
  await follow(drawer, "not_sent");
  check(await phaseOf(drawer) === "not_sent" && await statusOf(drawer) === "Not sent", "an ask the host did not take says Not sent");
  const section = drawer.locator("[data-testid='start-work']");
  check((await section.innerText()).includes("Nothing was started. The task is still queued."), "and that nothing started");
  check(await section.getByRole("button", { name: "See it in chat" }).count() === 0, "a message that never reached chat is not looked for there");
  await tone(page, drawer, "--coral", "lucide-triangle-alert", "Not sent");
  await shot(page, "c1-not-sent");
  await section.getByRole("button", { name: "Send again" }).click();
  const seen = await follow(drawer, "starting");
  check(seen.some((item) => item.phase === "asked") && await phaseOf(drawer) === "starting", "Send again hands it over, and the drawer follows the new ask");
  const chat = await sentInChat(page);
  check(chat.filter((text) => text.startsWith("Start work on")).length === 1 && chat.some((text) => text.endsWith(`From me: ${NOTE}`)), "the ask sent again carries the same note, once");
  await page.close();
}
{
  const { page, drawer } = await openQueued("start=failed", SCOUT);
  await handOver(drawer);
  await follow(drawer, "not_sent");
  check(await phaseOf(drawer) === "not_sent", "an ask whose turn errored before reading it says Not sent");
  check((await drawer.locator("[data-testid='start-status']").innerText()).includes("The first mate stopped before it read your ask."), "and why");
  check(await drawer.getByRole("button", { name: "See it in chat" }).count() === 1, "the message is in chat, where its error is");
  await page.close();
}

// After a relaunch: an ask from before is found again from the home's record, not chat, and judged from what is read now.
{
  const { page, drawer } = await openQueued("start=earlier", SCOUT);
  await follow(drawer, "not_started");
  check(await phaseOf(drawer) === "not_started", "an ask read before this launch, with the row still queued, says Not started");
  check((await drawer.locator("[data-testid='timeline-asked']").innerText()).includes("Handed to the first mate"), "the ask is on the timeline after a relaunch");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nStarting work from a queued task's drawer reads right in every state, in both themes.");
