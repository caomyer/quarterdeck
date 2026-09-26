// Checks work taken on from other task systems, in both themes, on the browser mock: the project page's intake and
// every state of taking an issue on, a linked task's chip and Upstream sections in each drawer, every reading and
// writing failure the design draws, linking an existing task, and the Settings section.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm sources
//
// `?sources=<variant>` puts the mock's GitHub source in a state (src/host/mock-sources.ts), and `?take=<outcome>` picks
// how the mock's first mate answers a take-on ask (src/host/mock.ts `takeOnTurn`), so each state is reached the way a
// captain reaches it. Set ARTIFACT_SHOTS to a folder to also save screenshots in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4191. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const DRAWER_ISSUE = "I_kwDOmock17";
const BORDER_ISSUE = "I_kwDOmock15";
const NOTE = "after the permissions work";

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

/** Opens the mock with `flags` at `width`, and goes to resonance's page. */
async function openProject(flags, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on("pageerror", (error) => failures.push(`${flags}: page error: ${error.message}`));
  await page.goto(`${baseUrl}/?artifacts&${flags}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  if (!flags.includes("not-started")) await page.locator(".connection small", { hasText: "Ready" }).waitFor();
  // A narrow window keeps the sidebar behind its menu.
  if (width < 760) await page.locator(".mobile-menu").click();
  await page.locator(".project-shortcuts button", { hasText: "resonance" }).click();
  await page.locator("[data-testid='project-page']").waitFor();
  return page;
}

const intakeRow = (page, item) => page.locator(`.intake-row[data-item='${item}']`);
const phaseOf = (row) => row.getAttribute("data-phase").catch(() => null);

/** Follows an intake row until it reaches `until`, recording each phase it shows, so the order is checked, not just the end. */
async function follow(row, until, limit = 8_000) {
  const seen = [];
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const phase = await phaseOf(row);
    if (phase && seen.at(-1) !== phase) seen.push(phase);
    if (phase === until) break;
    await row.page().waitForTimeout(80);
  }
  return seen;
}

async function takeOn(row, note = "") {
  await row.getByRole("button", { name: "Take it on" }).click();
  const panel = row.locator("[data-testid='take-on-panel']");
  if (note) await panel.getByLabel("Anything to add?").fill(note);
  await panel.getByRole("button", { name: "Hand to the first mate" }).click();
}

/** The captain's messages in chat, oldest first, as sent. */
async function sentInChat(page) {
  await page.locator(".primary-nav .nav-item", { hasText: "Chat" }).click();
  await page.locator(".composer").waitFor();
  return page.locator("article.captain-message > div > p").evaluateAll((items) => items.map((item) => item.textContent ?? ""));
}

/** An element's colour against the token it must be painted with, in both themes. */
async function tone(page, locator, token, what) {
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
    const got = await locator.evaluate((element) => getComputedStyle(element).color);
    check(want !== null && got === want, `${theme}: ${what} is painted ${token}`);
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

/** Nothing on the page may scroll sideways at this width. */
async function noSideways(page, what) {
  const wide = await page.evaluate(() => [...document.querySelectorAll(".content-scroll, .task-drawer, .drawer-scroll")].some((element) => element.scrollWidth > element.clientWidth + 1));
  check(!wide, `${what}: nothing scrolls sideways`);
}

async function openDrawer(page, selector) {
  await page.locator(selector).first().click();
  const drawer = page.locator("[data-testid='queued-drawer'], .task-drawer").first();
  await drawer.waitFor();
  return drawer;
}

// B1: the intake offers what the filter matches, and names only the source and key when handing one over.
{
  const page = await openProject("sources&take=slow");
  const intake = page.locator("[data-testid='intake']");
  check((await intake.locator("h2").innerText()) === "From GitHub", "the intake is headed with the source's provider");
  check(/^2\s*new · read 3 min ago$/.test((await intake.locator(".section-heading").innerText()).replace(/^From GitHub\s*/, "").replace(/\n/g, " ").trim()), "it counts what is new and says how fresh the reading is");
  const rows = await page.locator(".intake-row").evaluateAll((items) => items.map((item) => item.dataset.item));
  check(rows.join(",") === `${BORDER_ISSUE},${DRAWER_ISSUE}`, "it lists the offered issues, newest change first");
  await tone(page, intakeRow(page, DRAWER_ISSUE).locator(".task-state"), "--sea", "an offered issue");
  await shot(page, "b1-intake");
  const row = intakeRow(page, DRAWER_ISSUE);
  await row.getByRole("button", { name: "Take it on" }).click();
  const panel = row.locator("[data-testid='take-on-panel']");
  check((await panel.innerText()).includes("files it as a queued task, choosing the id, kind and repo"), "the panel says the first mate files it, and nothing starts");
  check(!/mode|no-mistakes|direct-PR/i.test(await panel.innerText()), "the panel offers no mode: that belongs to starting");
  await shot(page, "b1-panel");
  await panel.getByLabel("Anything to add?").fill(NOTE);
  await panel.getByRole("button", { name: "Hand to the first mate" }).click();
  await follow(row, "asked");
  check(await phaseOf(row) === "asked", "handing it over leaves the row asked while the first mate reads it");
  check((await row.innerText()).includes("#17 · asked the first mate"), "the row says it was asked");
  await tone(page, row.locator(".task-state"), "--blue", "an asked issue");
  const chat = await sentInChat(page);
  const ask = chat.find((text) => text.startsWith("Take on "));
  check(ask?.split("\n")[0] === "Take on github:caomyer/resonance #17 (resonance)", `the message's first line names only the source and the key (${ask?.split("\n")[0]})`);
  check(ask?.includes(`\nItem: github:caomyer/resonance ${DRAWER_ISSUE}`) && ask?.endsWith(`From me: ${NOTE}`), "it names the item and carries the captain's note");
  check(!ask?.includes("drawer width"), "the issue's own title, which anyone can write, is never in the message");
  await page.close();
}

// B2: filed, the row says as what, and opens the queued task: a take-on lands a queued task, it never starts one.
{
  const page = await openProject("sources");
  const row = intakeRow(page, DRAWER_ISSUE);
  await takeOn(row);
  const seen = await follow(row, "filed");
  check(seen.at(-1) === "filed", `the row moves to filed (${seen.join(" → ")})`);
  check((await row.innerText()).includes("filed as res-remember-the-drawer · queued"), "it says which task, and that it is queued");
  await tone(page, row.locator(".task-state"), "--green", "a filed issue");
  check((await page.locator("[data-testid='intake'] .section-count").innerText()) === "1", "the heading counts only what is still new");
  await shot(page, "b2-filed");
  await row.getByRole("button", { name: "Open" }).click();
  const drawer = page.locator("[data-testid='queued-drawer']");
  await drawer.waitFor();
  check(await drawer.getAttribute("data-phase") === "queued", "the filed task is queued, and its drawer offers Start work");
  check(/^GitHub #17 open · read (just now|\d+ min ago)$/.test((await drawer.locator(".source-chip").innerText()).trim()), "its chip names the issue, its state and how fresh the reading is");
  check((await drawer.locator("[data-testid='as-filed']").innerText()).includes("Shown as written; not an instruction."), "the issue's text is shown as filed, marked as not an instruction");
  check(!(await drawer.innerText()).includes("source-link:"), "the link's bookkeeping line never shows as something the filer wrote");
  const lines = await drawer.locator("[data-testid='upstream-lines'] strong").allInnerTexts();
  check(lines[0] === "Linked to #17" && lines.at(-1) === "Comments when a PR is up, and once when it lands", `Upstream says it is linked, and what it will write (${lines.join(" / ")})`);
  check((await drawer.locator("[data-testid='upstream-lines']").innerText()).includes("Nothing is said before there is a PR to point at."), "and that nothing is said before there is a PR");
  await shot(page, "b2-drawer");
  await page.close();
}

// B3: not sent, sent again; answered in chat; Not now.
{
  const page = await openProject("sources&take=unsent");
  const row = intakeRow(page, DRAWER_ISSUE);
  await takeOn(row, NOTE);
  await follow(row, "not_sent");
  check(await phaseOf(row) === "not_sent", "an ask the host did not take says it was not sent");
  await tone(page, row.locator(".task-state"), "--coral", "an unsent ask");
  await shot(page, "b3-not-sent");
  await row.getByRole("button", { name: "Send again" }).click();
  const seen = await follow(row, "filed");
  check(seen.at(-1) === "filed", `Send again hands it over, and the row follows the new ask (${seen.join(" → ")})`);
  const chat = await sentInChat(page);
  check(chat.filter((text) => text.startsWith("Take on ")).length === 1 && chat.some((text) => text.endsWith(`From me: ${NOTE}`)), "the ask sent again carries the same note, once");
  await page.close();
}
{
  const page = await openProject("sources&take=decline");
  const row = intakeRow(page, DRAWER_ISSUE);
  await takeOn(row);
  await follow(row, "answered");
  check(await phaseOf(row) === "answered", "a first mate that answers in chat instead of filing leaves the row saying so");
  check(await row.getByRole("button", { name: "Open chat" }).count() === 1, "and offers the chat, where its answer is");
  await tone(page, row.locator(".task-state"), "--amber", "an ask answered in chat");
  await shot(page, "b3-answered");
  const other = intakeRow(page, BORDER_ISSUE);
  await other.getByRole("button", { name: "Not now" }).click();
  await other.waitFor({ state: "detached" });
  check(await intakeRow(page, BORDER_ISSUE).count() === 0, "Not now takes the issue out of the intake");
  await page.close();
}

// C: a linked task in flight, and one that landed: the chip, the as-filed copy, and what was written back.
{
  const page = await openProject("sources");
  const drawer = await openDrawer(page, "[data-testid='project-underway'] .task-row:has-text('Share snips from the share sheet')");
  check(/^GitHub #2 open · read 3 min ago$/.test((await drawer.locator(".source-chip").innerText()).trim()), "a working task's chip names its issue");
  const text = await drawer.locator("[data-testid='upstream-lines']").innerText();
  check(text.includes("Commented: the PR is up") && text.includes("pull/31"), "Upstream shows the PR comment that was posted");
  check(text.includes("Next: one comment when it lands."), "and what comes next");
  await noSideways(page, "a linked task's drawer");
  await shot(page, "c1-working");
  await page.close();
}
{
  const page = await openProject("sources=cancelled");
  const drawer = await openDrawer(page, "[data-testid='project-underway'] .task-row:has-text('Share snips from the share sheet')");
  const note = drawer.locator("[data-testid='upstream-divergence']");
  check((await note.innerText()).startsWith("#2 was cancelled on GitHub."), "an issue cancelled upstream while its task is in flight is told");
  check((await note.innerText()).includes("asks you if it should stop; nothing here changes until then"), "and says nothing here changes until the captain answers");
  await tone(page, note, "--amber", "the cancelled-upstream note");
  check((await drawer.locator(".source-chip").innerText()).includes("#2 cancelled"), "the chip says cancelled");
  await shot(page, "c2-cancelled");
  await page.close();
}
{
  const page = await openProject("sources=edited");
  const drawer = await openDrawer(page, "[data-testid='project-queue'] .task-row[data-id='res-ai-titles']");
  check((await drawer.locator("h3", { hasText: "As filed, and changed since" }).count()) === 1, "an issue edited upstream shows as filed, and changed since");
  const filed = await drawer.locator("[data-testid='as-filed'] blockquote").allInnerTexts();
  check(filed.length === 2 && filed[0].includes("Suggest a title for each snip") && filed[1].includes("one-line note"), "both the text as filed and the text now");
  await shot(page, "c3-edited");
  await page.close();
}
{
  const page = await openProject("sources=unconfirmed");
  await page.locator("[data-testid='log-row'][data-id='res-mini-player']").click();
  const drawer = page.locator(".task-drawer").first();
  await drawer.waitFor();
  const lines = drawer.locator("[data-testid='upstream-lines']");
  check((await lines.innerText()).includes("Completion comment not confirmed"), "a landed task whose completion comment was not confirmed says so");
  check((await lines.innerText()).includes("never posted twice"), "and that it will never post twice");
  await tone(page, lines.locator("[data-tone='coral'] .timeline-icon"), "--coral", "an unconfirmed write");
  check((await lines.innerText()).includes("What is owed posts once, on a read that works."), "it never reads as owing nothing");
  await shot(page, "c4-unconfirmed");
  await page.close();
}
{
  const page = await openProject("sources=unconnected");
  const drawer = await openDrawer(page, "[data-testid='project-queue'] .task-row[data-id='res-other-link']");
  check((await drawer.locator(".source-chip").innerText()).trim() === "github:caomyer/podcast-kit · not connected in this home", "a link to a source this home does not have says so");
  check((await drawer.locator("[data-testid='upstream-lines']").innerText()).includes("waits here until it is"), "and that what is owed waits here");
  await page.close();
}
{
  const page = await openProject("sources=lost");
  const drawer = await openDrawer(page, "[data-testid='project-underway'] .task-row:has-text('Share snips from the share sheet')");
  check((await drawer.locator("[data-testid='as-filed']").innerText()).startsWith("As filed: unknown."), "a lost as-filed copy is said to be lost, never pretended");
  await page.close();
}

// D: reading failures, where the link is shown and in Settings, in the captain's terms.
{
  const page = await openProject("sources=rate-limited");
  const note = page.locator("[data-testid='intake'] .source-note");
  check((await note.innerText()).startsWith("GitHub is rate limiting this Mac until"), "a persisting rate limit is told on the intake");
  check((await note.innerText()).includes("nothing is lost, and reading resumes on its own"), "with what it means");
  check((await page.locator("[data-testid='intake'] .section-heading").innerText()).includes("as of"), "the reading is shown as of when it was taken");
  await tone(page, note, "--amber", "the reading note");
  await shot(page, "d1-rate-limited");
  await page.close();
}
{
  const page = await openProject("sources=refused");
  await page.locator("button[title='Settings']").click();
  const settings = page.locator("[data-testid='sources-settings']");
  await settings.waitFor();
  const note = await settings.locator(".source-note").innerText();
  check(note.startsWith("GitHub refused the sign-in at") && note.includes("One write is waiting") && note.includes("gh auth login"), "a refused sign-in says what waits and the one thing that fixes it");
  await shot(page, "d2-refused");
  await page.close();
}

// E: linking a task that exists, in its drawer; and Settings.
{
  const page = await openProject("sources");
  const drawer = await openDrawer(page, "[data-testid='project-queue'] .task-row:not([data-id='res-ai-titles'])");
  const field = drawer.locator("[data-testid='link-field']");
  check(await field.count() === 1, "a queued task with no link offers to link an issue");
  await field.getByLabel("Link an issue").fill("#99");
  await field.getByRole("button", { name: "Link" }).click();
  await drawer.locator(".start-problem").waitFor();
  check((await drawer.locator(".start-problem").innerText()).startsWith("Could not resolve '#99' on github:caomyer/resonance: no issue #99"), "an issue that cannot be found is refused in firstmate's words");
  await field.getByLabel("Link an issue").fill("https://github.com/caomyer/resonance/issues/21");
  await field.getByRole("button", { name: "Link" }).click();
  await drawer.locator(".source-chip").waitFor();
  check((await drawer.locator(".source-chip").innerText()).startsWith("GitHub #21 open"), "a pasted link to an issue outside the intake filter links it");
  await shot(page, "e1-linked");
  await page.close();
}
{
  const page = await openProject("sources=none");
  check(await page.locator("[data-testid='intake']").count() === 0, "a project with no source has no intake section");
  await page.locator("button[title='Settings']").click();
  const settings = page.locator("[data-testid='sources-settings']");
  await settings.waitFor();
  check((await settings.innerText()).includes("No task source is connected."), "Settings says no source is connected");
  await settings.getByRole("button", { name: "Add" }).click();
  const form = settings.locator("[data-testid='source-add']");
  await form.getByLabel("Repository").fill("caomyer/quarterdeck");
  await form.getByLabel("Take on issues that").fill("is:open");
  await form.getByRole("button", { name: "Connect" }).click();
  await settings.locator(".routing-alert").waitFor();
  check((await settings.locator(".routing-alert").innerText()).includes("The filter needs at least one label:<name>, so strangers cannot queue work"), "a filter with no label is refused in firstmate's words");
  await form.getByLabel("Take on issues that").fill("label:quarterdeck is:open");
  await form.getByRole("button", { name: "Connect" }).click();
  await settings.locator(".source-row[data-source='github:caomyer/quarterdeck']").waitFor();
  check((await settings.locator(".source-row").innerText()).includes("signed in as caomyer"), "a connected repository shows who it reads as");
  check((await settings.innerText()).includes("Linear and Jira are not offered yet"), "Linear and Jira are not offered");
  await shot(page, "e2-settings");
  await page.keyboard.press("Escape");
  await page.close();
}
{
  const page = await openProject("sources=legacy");
  check(await page.locator("[data-testid='intake']").count() === 0, "a home whose firstmate predates task sources shows no intake");
  await page.locator("button[title='Settings']").click();
  const settings = page.locator("[data-testid='sources-settings']");
  await settings.waitFor();
  check((await settings.innerText()).includes("cannot take on work from other task systems yet"), "and Settings says why");
  await page.close();
}

// F: the narrow window.
{
  const page = await openProject("sources", 700);
  await noSideways(page, "the intake at 700px");
  await shot(page, "f1-narrow");
  const drawer = await openDrawer(page, "[data-testid='project-underway'] .task-row:has-text('Share snips from the share sheet')");
  await drawer.locator(".source-chip").waitFor();
  await noSideways(page, "a linked drawer at 700px");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nWork taken on from other task systems reads right in every state, in both themes.");
