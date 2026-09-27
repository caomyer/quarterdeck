// Checks what the app tells a captain their Mac still needs: the checklist the
// first mate's own detection produces, the remedy beside each name, a line the
// app has no shape for shown in the first mate's words, a check that cannot be
// made at all, and a Mac with nothing missing saying nothing.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm onboarding
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
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `onboarding-${name}-${theme}.png`), fullPage: false });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

await page.goto(`${baseUrl}/?needs`);
await page.waitForSelector(".needs-banner", { timeout: 20000 });
const banner = page.locator(".needs-banner");
// Four of the six lines name a tool; two name none. Counting all six would
// tell the captain a branch name is something to install.
const text = await banner.innerText();
check(text.includes("Crew work isn't ready on this Mac yet"), "the headline says what is not ready, for a captain with no work yet");
check(text.includes("these 4 are here"), "the count is of things to install, not of lines");
check(text.includes("It asks before installing any of them"), "and says nothing is installed without the captain's OK");
check(text.includes("could not put a name to"), "what names no tool is kept apart from what does");

// Grouped by who acts: what the captain installs by hand, then what the first mate installs with their OK.
const groups = await page.locator(".needs-group").allInnerTexts();
check(groups.join(" | ").toLowerCase() === "yours to install | the first mate can install, with your ok", `grouped by who acts (${groups.join(" | ")})`);
const tools = await page.locator(".needs-tool").allInnerTexts();
check(tools.join(",") === "herdr,jq,no-mistakes,lavish-axi", `every missing tool is named, in the first mate's order within its group (${tools.join(", ")})`);
// A tool named inside prose is still a tool with a command, not a paragraph, and the command is one hover away.
check(await page.locator(".needs-tool", { hasText: "lavish-axi" }).getAttribute("title") === "npm install -g lavish-axi && lavish-axi setup hooks", "a tool named inside a longer line still carries its command");
check((await page.locator(".needs-tool", { hasText: "jq" }).getAttribute("title"))?.startsWith("brew install jq") === true, "an install command is carried by its tool");
check(await page.locator(".needs-banner a").getAttribute("href") === "https://example.invalid/herdr", "a tool installed by hand links to its instructions");
check((await page.locator(".needs-banner a").getAttribute("rel"))?.includes("noopener") === true, "and that link cannot reach back into the app");

// The app does not drop what it has no shape for.
const said = await page.locator(".needs-says").allInnerTexts();
check(said.length === 2 && said.some((line) => line.startsWith("TANGLE:")), `a line the app has no shape for is shown in the first mate's words (${said.length})`);
await shot("missing");

// Asking the first mate drafts the ask in chat and sends nothing.
await page.locator(".needs-actions button").click();
await page.waitForSelector("textarea[aria-label='Message the first mate']", { timeout: 5000 });
const draft = await page.locator("textarea[aria-label='Message the first mate']").inputValue();
check(draft === "Set up what this Mac still needs for crew work: herdr, jq, no-mistakes, lavish-axi.", `the ask names every tool and waits in the composer (${draft})`);
await page.goto(`${baseUrl}/?needs`);
await page.waitForSelector(".needs-banner", { timeout: 20000 });

// Asking again is the captain's move, and it is theirs to make at any time.
await page.locator(".needs-banner header button").click();
await page.waitForTimeout(300);
check(await page.locator(".needs-banner").count() === 1, "checking again leaves the checklist in place");

// A Mac with nothing missing is told nothing.
await page.goto(`${baseUrl}/?needs=none`);
await page.waitForSelector("[data-screen='bearings']", { timeout: 20000 });
await page.waitForTimeout(500);
check(await page.locator(".needs-banner").count() === 0, "a Mac with nothing missing says nothing");

// A check that could not be made says so, rather than reading as all clear.
await page.goto(`${baseUrl}/?needs=unreadable`);
await page.waitForSelector(".needs-problem", { timeout: 20000 });
const unreadable = await page.locator(".needs-banner").innerText();
check(unreadable.includes("could not check this Mac"), "a check that cannot be made says so");
check(unreadable.includes("what is missing here is unknown"), "and does not read as all clear");
check(unreadable.includes("permission denied"), "and carries what stopped it");
await shot("unreadable");

// Nothing overflows the page, at the width the app opens and at a narrow one.
for (const width of [1280, 760]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(150);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over === 0, `nothing runs off the page at ${width}px (${over})`);
}
await page.setViewportSize({ width: 1280, height: 900 });

// The region is there before it has anything to say, so a reader is told when
// it fills: one that appears already full has no change to announce.
await page.goto(`${baseUrl}/?needs=none`);
await page.waitForSelector("[data-screen='bearings']", { timeout: 20000 });
check(await page.locator("[role='status'][aria-live='polite']").count() >= 1, "the region that says this is there before it says anything");
// And takes no room while it is empty, or the page below it sits a gap lower
// on every visit where there is nothing to say.
const gap = await page.evaluate(() => {
  const region = document.querySelector(".needs-region");
  const first = document.querySelector("[data-screen='bearings']")?.firstElementChild;
  return region && first ? Math.round(first.getBoundingClientRect().top - region.getBoundingClientRect().top) : -1;
});
check(gap === 0, `an empty checklist takes no room (${gap}px)`);

check(errors.length === 0, `the page raised no errors${errors.length ? `: ${errors.join("; ")}` : ""}`);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll onboarding checks passed.");
