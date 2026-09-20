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
check((await banner.innerText()).includes("needs 4 more things"), "the count is of things to install, not of lines");
check((await banner.innerText()).includes("It runs without them"), "and says the first mate still runs without them");
check((await banner.innerText()).includes("could not put a name to"), "what names no tool is kept apart from what does");

// Each name carries the remedy for it, and they are the first mate's own words.
const tools = await page.locator(".needs-tool").allInnerTexts();
check(tools.join(",") === "jq,no-mistakes,lavish-axi,herdr", `every missing tool is named (${tools.join(", ")})`);
const commands = await page.locator(".needs-how").allInnerTexts();
check(commands.some((command) => command.startsWith("brew install jq")), "an install command is shown beside its tool");
// A tool named inside prose is still a tool with a command, not a paragraph.
check(commands.includes("npm install -g lavish-axi && lavish-axi setup hooks"), "a tool named inside a longer line still gets its command");
check(await page.locator(".needs-banner a").getAttribute("href") === "https://example.invalid/herdr", "a tool installed by hand links to its instructions");
check((await page.locator(".needs-banner a").getAttribute("rel"))?.includes("noopener") === true, "and that link cannot reach back into the app");

// The app does not drop what it has no shape for.
const said = await page.locator(".needs-says").allInnerTexts();
check(said.length === 2 && said.some((line) => line.startsWith("TANGLE:")), `a line the app has no shape for is shown in the first mate's words (${said.length})`);

// The remedies line up in one column: a checklist is read down, not across.
// A line that names no tool is not a remedy and starts further left, with the
// names, because it belongs to no name.
const columns = await page.locator(".needs-how, .needs-banner li > span:not(.needs-says)").evaluateAll((nodes) => [...new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left)))]);
check(columns.length === 1, `every remedy starts at the same place (${columns.join(", ")})`);
const [remedy] = columns;
const bare = await page.locator(".needs-says").first().evaluate((node) => Math.round(node.getBoundingClientRect().left));
check(bare < remedy, `a line belonging to no tool starts left of the remedies (${bare} < ${remedy})`);
const names = await page.locator(".needs-tool").evaluateAll((nodes) => [...new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left)))]);
check(names.length === 1 && names[0] === bare, `and in line with the names (${names.join(", ")})`);
await shot("missing");

// Asking again is the captain's move, and it is theirs to make at any time.
await page.locator(".needs-banner button").click();
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

check(errors.length === 0, `the page raised no errors${errors.length ? `: ${errors.join("; ")}` : ""}`);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll onboarding checks passed.");
