// Checks the usage strip and its popover on the browser mock: the context window and the plan limits in every
// state they come in, not only full of numbers, and Compact now, the one control in it that acts.
//
//   pnpm dev --port 4193 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4193 pnpm usage
//
// Each state is the mock's `?usage=<state>` (src/host/mock-usage.ts). Set ARTIFACT_SHOTS to a folder to also save
// screenshots in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4193. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

async function open(query, viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (error) => failures.push(`${query}: ${error.message}`));
  await page.goto(`${baseUrl}/${query}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(".usage-strip").waitFor();
  return page;
}

const strip = (page) => page.locator(".usage-strip").innerText();

/** The mock's first mate starts, then reports its first reading, as the host does after a turn. */
async function waitForContext(page) {
  await page.waitForFunction(() => /Context\s+\d+%/.test(document.querySelector(".usage-strip")?.innerText ?? ""), null, { timeout: 10000 });
}
const popover = (page) => page.locator(".usage-popover");

async function openPopover(page) {
  await page.locator(".usage-strip").click();
  await popover(page).waitFor();
  // The first plan read lands a moment after the page.
  await page.waitForFunction(() => !document.querySelector(".usage-popover")?.textContent?.includes("Reading plan limits"), null, { timeout: 8000 }).catch(() => {});
}

async function shot(page, name) {
  if (!shots) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `usage-${name}-${theme}.png`), fullPage: false });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

// What this Mac read: every window, percent and reset together, and quiet.
{
  const page = await open("");
  await waitForContext(page);
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("5h"), null, { timeout: 8000 });
  const glance = await strip(page);
  check(glance.includes("Context") && glance.includes("7%") && glance.includes("71k of 1M"), `the strip reads the context: ${JSON.stringify(glance)}`);
  check(/Claude\s+20% 5h · 1h 3\dm/.test(glance), "and Claude's binding window with its reset");
  check(!glance.includes("Codex"), "a provider with room left stays out of the strip");
  check(await page.locator(".usage-strip-row.warn, .usage-strip-row.over").count() === 0, "nothing is coloured when nothing matters");
  await openPopover(page);
  const detail = await popover(page).innerText();
  check(detail.includes("THIS CONVERSATION") && detail.includes("PLAN LIMITS"), "the popover keeps the two readings in two sections");
  check(detail.includes("70,979") && detail.includes("1,000,000 tokens"), "the context is given in full");
  const claude = page.locator(".usage-provider").filter({ hasText: "Claude" });
  check((await claude.locator(".usage-window").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()).join(" | ") === "5h 20% | wk 17% | Fable wk 0%", "Claude shows every window it has");
  const codex = page.locator(".usage-provider").filter({ hasText: "Codex" });
  check(await codex.locator(".usage-tag").innerText() === "early", "an early reading is marked as one");
  check((await codex.locator(".usage-window").first().innerText()).includes("~0%"), "and its numbers say they are approximate");
  check(!/pace|From quota-axi|the first mate's session\./i.test(detail), "no pace and no line naming where numbers come from");
  const others = page.locator(".usage-others-toggle");
  check((await others.innerText()).includes("13 more providers not set up"), "providers nobody set up fold into one line");
  await others.click();
  const listed = await page.locator(".usage-others li").allInnerTexts();
  check(listed.length === 13 && listed.some((line) => line.includes("GitHub Copilot sign-in required")), "which opens to each in quota-axi's words");
  const title = await claude.locator(".usage-window").nth(1).getAttribute("title");
  check(/^wk: resets in 2d 2\dh$/.test(title ?? ""), `each window says its own reset on hover (${title})`);
  await shot(page, "live");
  const box = await popover(page).boundingBox();
  check(box && box.y >= 0 && box.y + box.height <= 900, "the popover sits inside the window");
  await page.keyboard.press("Escape");
  check(await popover(page).count() === 0, "Escape closes it");
  await openPopover(page);
  await page.mouse.click(900, 60);
  check(await popover(page).count() === 0, "and so does a click outside it");
  await page.close();
}

// A Mac that has not allowed the Keychain: Claude still has something to say, and the fix is one button.
{
  const page = await open("?usage=fresh");
  await waitForContext(page);
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("under limit"), null, { timeout: 8000 });
  check(/Claude\s+under limit 1h 3\dm/.test(await strip(page)), "Claude reads from the first mate's session before any Keychain access");
  await openPopover(page);
  const claude = page.locator(".usage-provider").filter({ hasText: "Claude" });
  check((await claude.locator(".usage-when").innerText()).startsWith("Under its limit · Resets in"), "its row says what the session knows");
  check((await claude.innerText()).includes("keychain_prompt_required"), "and what is missing, in quota-axi's words");
  await shot(page, "needs-keychain");
  await claude.getByRole("button", { name: "Allow Keychain access…" }).click();
  check(await claude.getByRole("button", { name: "Waiting for macOS…" }).count() === 1, "allowing it waits on macOS");
  await page.waitForFunction(() => document.querySelector(".usage-popover")?.textContent?.includes("20%"), null, { timeout: 8000 });
  check((await page.locator(".usage-provider").filter({ hasText: "Claude" }).innerText()).includes("Fable wk"), "once allowed, the percentages come in");
  await page.close();
}

// Close to a limit, and at one: the only times the strip takes colour.
{
  const page = await open("?usage=warn");
  await waitForContext(page);
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("86%"), null, { timeout: 8000 });
  check(await page.locator(".usage-strip-row.warn").count() === 2, "the context past 75% and a window past 80% are both marked");
  await openPopover(page);
  check((await popover(page).innerText()).includes("compacts on its own"), "a full context says what happens next");
  await shot(page, "warn");
  await page.close();
}
{
  const page = await open("?usage=over");
  await waitForContext(page);
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("limit"), null, { timeout: 8000 });
  check(/Claude\s+limit · back in 5\dm/.test(await strip(page)), "a refusal says when it ends");
  check(await page.locator(".usage-strip-row.over").count() === 1, "and is marked as a limit");
  await openPopover(page);
  check((await page.locator(".usage-provider").filter({ hasText: "Claude" }).locator(".usage-when").innerText()).startsWith("Back in"), "the row says so too");
  await shot(page, "refused");
  await page.close();
}

// A failed read keeps the last numbers and says how old they are and why.
{
  const page = await open("?usage=stale");
  await waitForContext(page);
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("old"), null, { timeout: 8000 });
  check(/Claude\s+31% 5h · 42m old/.test(await strip(page)), "stale numbers carry their age in the strip");
  await openPopover(page);
  const detail = await popover(page).innerText();
  check(detail.includes("Can't refresh: quota-axi did not answer within 45s"), "the popover says why, in the backend's words");
  check(detail.includes("These are the numbers from 42m ago"), "and how old the numbers are");
  check(await page.locator(".usage-aside").count() === 0, "once, not on every row");
  check(detail.includes("71k") === false && detail.includes("118,250"), "while the context, read elsewhere, is unaffected");
  await shot(page, "stale");
  await page.close();
}

// Nothing read yet: no reading is not 0%, and there is nothing to compact.
{
  const page = await open("?usage=start");
  // Running, with no turn behind it yet.
  await page.waitForFunction(() => document.querySelector(".sidebar-footer")?.textContent?.includes("Ready"), null, { timeout: 10000 });
  const glance = await strip(page);
  check(glance.includes("after first reply") && glance.includes("checking…"), `an empty start says what it is waiting for: ${JSON.stringify(glance)}`);
  check(!glance.includes("0%"), "and shows no 0%");
  await page.locator(".usage-strip").click();
  await popover(page).waitFor();
  check((await popover(page).innerText()).includes("Known after the first mate's first reply"), "the popover says when the context is known");
  check(await page.getByRole("button", { name: "Compact now…" }).isDisabled(), "there is nothing to compact");
  await shot(page, "empty");
  await page.close();
}

// quota-axi missing: an honest empty state, and Claude still from the session.
{
  const page = await open("?usage=missing");
  await waitForContext(page);
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("under limit"), null, { timeout: 8000 });
  await openPopover(page);
  check((await popover(page).innerText()).includes("which isn't installed on this Mac"), "the popover names what is missing");
  await shot(page, "no-quota-axi");
  await page.close();
}

// A compaction earlier, and a resumed session, each explain a reading the numbers alone would not.
for (const [state, words] of [["compacted", "Compacted 12m ago: 812k down to 61k"], ["resumed", "A resumed session"]]) {
  const page = await open(`?usage=${state}`);
  await waitForContext(page);
  await openPopover(page);
  check((await popover(page).innerText()).includes(words), `${state}: ${words}`);
  await page.close();
}

// Compact now: confirmed first, said in numbers, and reported when it ends.
{
  const page = await open("");
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("71k"), null, { timeout: 8000 });
  await openPopover(page);
  await page.getByRole("button", { name: "Compact now…" }).click();
  const confirm = await page.locator(".usage-confirm").innerText();
  check(confirm.includes("70,979 tokens") && confirm.includes("7% of its 1M context"), "the confirmation says what is there now");
  check(confirm.includes("gone for good"), "and that the detail does not come back");
  await shot(page, "compact-confirm");
  await page.getByRole("button", { name: "Cancel" }).click();
  check(await page.locator(".usage-confirm").count() === 0, "Cancel does nothing else");
  await page.getByRole("button", { name: "Compact now…" }).click();
  await page.locator(".usage-confirm").getByRole("button", { name: "Compact" }).click();
  await page.locator(".usage-working").waitFor();
  check(await page.getByRole("button", { name: "Compact now…" }).count() === 0, "while it runs, it cannot be asked for twice");
  await page.waitForFunction(() => document.querySelector(".usage-popover")?.textContent?.includes("Compacted just now"), null, { timeout: 8000 });
  check((await popover(page).innerText()).includes("Compacted just now: 71k down to 61k"), "when it ends, the popover says what it did");
  check((await strip(page)).includes("61k of 1M"), "and the strip shows the new reading");
  await shot(page, "compacted");
  await page.locator(".primary-nav .nav-item", { hasText: "Chat" }).click();
  const chat = await page.locator("[data-screen='chat']").innerText().catch(() => page.locator("main").innerText());
  check(chat.includes("/compact") && chat.includes("Compacting completed."), "the conversation shows the command and Claude Code's words");
  await page.close();
}
{
  const page = await open("?usage=compact-fails");
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("71k"), null, { timeout: 8000 });
  await openPopover(page);
  await page.getByRole("button", { name: "Compact now…" }).click();
  await page.locator(".usage-confirm").getByRole("button", { name: "Compact" }).click();
  await page.locator(".usage-problem").waitFor({ timeout: 8000 });
  check((await page.locator(".usage-problem").innerText()).includes("Couldn't compact: Compacting failed: Not enough messages to compact."), "a failed compaction says why, in Claude Code's words");
  check((await strip(page)).includes("71k of 1M"), "and the reading is unchanged");
  await shot(page, "compact-failed");
  await page.locator(".usage-problem").getByRole("button", { name: "Dismiss" }).click();
  check(await page.locator(".usage-problem").count() === 0, "and it can be dismissed");
  await page.close();
}
{
  // Mid-turn: it waits for the turn, and says so, rather than cutting in.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => failures.push(`mid-turn: ${error.message}`));
  // The mock's turn is over in a moment, so its clock is held while the turn runs, however slow the machine.
  await page.clock.install();
  await page.goto(`${baseUrl}/`);
  await page.waitForFunction(() => document.querySelector(".usage-strip")?.textContent?.includes("71k"), null, { timeout: 8000 });
  // Let the plan read land first: it waits on the same clock.
  await openPopover(page);
  await page.keyboard.press("Escape");
  await page.locator(".primary-nav .nav-item", { hasText: "Chat" }).click();
  await page.locator(".composer textarea").fill("Check the fleet.");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator(".send-button").click();
  await page.clock.runFor(50);
  await page.waitForFunction(() => document.querySelector(".chat-status")?.textContent?.includes("Working"), null, { timeout: 8000 });
  await openPopover(page);
  await page.getByRole("button", { name: "Compact now…" }).click();
  check((await page.locator(".usage-confirm").innerText()).includes("compacts once that turn ends"), "confirming mid-turn says it waits for the turn");
  await page.locator(".usage-confirm").getByRole("button", { name: "Compact" }).click();
  await page.locator(".usage-working").waitFor();
  check((await page.locator(".usage-working").innerText()).includes("Waiting for the current turn to end"), "and while it waits, it says so");
  await page.clock.resume();
  await page.waitForFunction(() => document.querySelector(".usage-popover")?.textContent?.includes("Compacted just now"), null, { timeout: 12000 });
  check(true, "then it compacts");
  await page.close();
}

// A first mate that is not running has no context to show and nothing to compact.
{
  const page = await open("?not-started");
  check((await strip(page)).includes("not running"), "the strip says the first mate is not running");
  await openPopover(page);
  check(await page.getByRole("button", { name: "Compact now…" }).isDisabled(), "and Compact now is off");
  await page.close();
}

// A narrow window: the popover fits, over the drawer.
{
  const page = await open("", { width: 760, height: 900 });
  await waitForContext(page);
  await page.locator(".mobile-menu").click();
  await openPopover(page);
  const box = await popover(page).boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 760, `the popover fits a narrow window (${box && Math.round(box.x)}..${box && Math.round(box.x + box.width)})`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over === 0, `nothing runs off the page (${over})`);
  await shot(page, "narrow");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nThe usage panel reads right in every state.");
