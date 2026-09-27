// Checks the welcome a new captain meets: the agents on this Mac, one row each from firstmate's own list; what is
// missing and the offer to install it, showing every command first; Node standing in the way; signing in through
// Terminal; choosing which agent runs the first mate; the first start in chat until its first words; and the ways a
// first start fails. In both themes, at the widths the app opens at.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm welcome
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
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(120);
    // The app window opens no narrower than 960px (tauri.conf.json).
    for (const width of [1280, 1024, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(80);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over !== 0) check(false, `${name} runs ${over}px off the page at ${width}px in ${theme}`);
      if (shots) await page.screenshot({ path: join(shots, `welcome-${name}-${theme}-${width}.png`), fullPage: false });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

const row = (agent) => page.locator(`.agent-row[data-agent='${agent}']`);
const pills = async (agent) => (await row(agent).locator(".pill").allInnerTexts()).map((text) => text.trim());
const meet = () => page.locator(".welcome-meet");
const footer = () => page.locator(".welcome-footer small").innerText();

async function open(query) {
  await page.goto(`${baseUrl}/?${query}`);
  await page.waitForSelector("[data-screen='welcome']", { timeout: 20000 });
  await page.waitForTimeout(300);
}

// Looking: the rows the answer will fill, and nothing to press yet.
await open("welcome=checking");
check((await page.locator(".agent-row .pill").allInnerTexts()).filter((text) => text.includes("Looking")).length === 2, "each agent is looked for, one row each");
check(await meet().isDisabled(), "and the first mate cannot be met before the answer");
await shot("checking");

// Both here: installed, versions, signed in, the adapter only for the first mate's agent.
await open("welcome");
check((await pills("claude")).join(",") === "✓ Installed,✓ Signed in,✓ ACP adapter", `Claude Code reads installed, signed in, with its adapter (${await pills("claude")})`);
check((await pills("codex")).join(",") === "✓ Installed,✓ Signed in", `Codex reads installed and signed in, with no adapter it does not need (${await pills("codex")})`);
check((await row("claude").locator(".agent-version").innerText()) === "2.1.283", "each agent shows its version");
check((await row("claude").locator(".agent-role").innerText()).startsWith("Runs your first mate · Takes crew work"), "the first mate's agent says both of its roles");
check((await row("codex").locator(".agent-role").innerText()).startsWith("Takes crew work"), "another agent says it takes crew work, and only that");
check(!(await meet().isDisabled()), "a Mac that has everything is one click from the first mate");
check((await footer()).includes("Your first mate runs on Claude Code"), "the footer says which agent runs the first mate");
await shot("ready");

// Choosing Codex moves the first mate there, and says what that means for how it hears the captain.
await row("codex").locator(".agent-role .link-button").click();
await page.waitForTimeout(300);
check((await row("codex").locator(".agent-role").innerText()).startsWith("Runs your first mate"), "choosing Codex moves the first mate to it");
check((await row("codex").locator(".agent-note").innerText()).includes("up to three minutes"), "and says, where it is chosen, that Codex reads messages between its checks");
check((await pills("claude")).join(",") === "✓ Installed,✓ Signed in", "Claude Code no longer needs its adapter");
await shot("codex-first");

// Nothing installed: the commands show before anything runs, and one click is consent to exactly those.
await open("welcome=nothing");
check((await page.locator(".welcome-screen p").first().innerText()).includes("this Mac has none yet"), "a Mac with no agent is told so");
const commands = await row("claude").locator(".agent-cmd").allInnerTexts();
check(commands.length === 2 && commands[0] === "curl -fsSL https://claude.ai/install.sh | bash" && commands[1].includes("@agentclientprotocol/claude-agent-acp@0.69.0"), `installing Claude Code shows both commands first (${commands.join(" / ")})`);
check(await row("codex").locator(".agent-cmd").count() === 0, "another agent waits to be asked before it shows anything");
check(await meet().isDisabled() && (await footer()) === "Needs Claude Code to start.", "and nothing can be met until one is here");
await shot("nothing");
await row("codex").locator("button", { hasText: "Install Codex…" }).click();
check((await row("codex").locator(".agent-cmd").allInnerTexts()).join() === "npm install -g @openai/codex", "opening another agent shows what installing it runs, with no adapter it would not use");
await row("claude").locator("button", { hasText: "Install Claude Code" }).click();
await page.waitForSelector(".agent-row[data-agent='claude'] .pill.wait", { timeout: 3000 });
check((await row("claude").locator(".pill.wait").innerText()).includes("step 1 of 2"), "an install says which step it is on");
await page.waitForSelector(".agent-row[data-agent='claude'] .agent-out", { timeout: 3000 });
check((await row("claude").locator(".agent-out").innerText()).length > 0, "and shows the newest line it printed");
await shot("installing");
await page.waitForFunction(() => document.querySelector(".agent-row[data-agent='claude'] .pill.wait") === null, null, { timeout: 15000 });
await page.waitForTimeout(300);
check((await pills("claude")).join(",") === "✓ Installed,Not signed in,✓ ACP adapter", `once installed it is read again, and asks to be signed in (${await pills("claude")})`);

// npm cannot reach the registry: the failed step, npm's last words, everything on request, and a way to try again.
await open("welcome=install-fails");
await row("claude").locator("button", { hasText: "Install the adapter" }).click();
await page.waitForSelector(".agent-row[data-agent='claude'].bad .agent-out", { timeout: 10000 });
check((await row("claude").locator(".agent-says").innerText()).includes("stopped before it finished"), "a failed install says so");
check((await row("claude").locator(".agent-out").innerText()).includes("ENOTFOUND"), "in npm's own words");
await row("claude").locator("button", { hasText: "Show everything it said" }).click();
check((await row("claude").locator(".agent-log").innerText()).includes("registry.npmjs.org"), "and everything it said is one click away");
check(await row("claude").locator("button", { hasText: "Try again" }).count() === 1, "with a way to try again");
await shot("install-fails");

// Node stands in the way of an npm install: with Homebrew, without it, and too old.
await open("welcome=no-node");
check((await row("claude").locator(".agent-says").innerText()).includes("needs Node.js 22 or newer, and this Mac has none"), "no Node is said, with the version needed");
check((await row("claude").locator(".agent-cmd").innerText()) === "brew install node", "with Homebrew, its line is offered");
check((await row("claude").locator("a[href='https://nodejs.org/en/download']").count()) === 1, "and the installer from nodejs.org");
check(await row("claude").locator("button", { hasText: "Install" }).count() === 0, "and nothing is offered that would fail without it");
await shot("no-node");
await open("welcome=no-node-brewless");
check(await row("claude").locator(".agent-cmd").count() === 0, "without Homebrew no brew line is drawn");
check((await row("claude").locator(".agent-alt").innerText()).startsWith("Use the installer"), "only the installer is");
await open("welcome=old-node");
check((await row("claude").locator(".agent-says").innerText()).includes("This Mac has Node 20.11.0, and installing this needs 22 or newer"), "too old a Node says which it has");
check((await row("claude").locator(".agent-cmd").innerText()) === "brew upgrade node", "and how to upgrade it");

// Signed out: the agent's own sign-in in Terminal, then the captain says when they are done.
await open("welcome=signed-out");
check(await meet().isDisabled(), "a signed-out first mate's agent holds the first mate");
check((await footer()).includes("so it waits for Claude Code's sign-in"), "and says why");
check((await row("codex").locator(".agent-says").innerText()).startsWith("Signed out, so it can't take crew work yet"), "a signed-out crew agent says what it cannot do");
await shot("signed-out");
await row("claude").locator("button", { hasText: "Sign in to Claude" }).click();
await page.waitForSelector(".agent-row[data-agent='claude'] .pill.wait", { timeout: 3000 });
check((await row("claude").locator(".pill.wait").innerText()).includes("Signing in, in Terminal"), "while Terminal is open the row waits for the captain");
await shot("signing-in");
await row("claude").locator("button", { hasText: "I've signed in" }).click();
await page.waitForTimeout(400);
check((await pills("claude")).includes("✓ Signed in") && !(await meet().isDisabled()), "once the agent says so, the first mate can be met");
await open("welcome=still-signed-out");
await row("claude").locator("button", { hasText: "Sign in to Claude" }).click();
await page.waitForTimeout(200);
await row("claude").locator("button", { hasText: "I've signed in" }).click();
await page.waitForTimeout(400);
check((await row("claude").locator(".agent-says").innerText()).includes("still says this Mac isn't signed in"), "a sign-in that did not take is said, not assumed");

// Only Codex here: the first mate can move to it rather than wait for Claude Code.
await open("welcome=codex-only");
check((await footer()) === "Needs Claude Code to start." && await meet().isDisabled(), "a first mate set to Claude Code waits for it");
await shot("codex-only");
await row("codex").locator(".agent-role .link-button").click();
await page.waitForTimeout(300);
check(!(await meet().isDisabled()), "moving the first mate to Codex lets it start");

// An agent list firstmate could not read says so, and nothing can be started from it.
await open("welcome=unreadable");
check((await page.locator(".welcome-problem").first().innerText()).includes("could not check this Mac's agents"), "an unreadable agent list says why");
check(await meet().isDisabled(), "and holds the first mate");
await shot("unreadable");

// Meeting the first mate: chat says how its first start goes until it speaks, and the welcome never comes back.
await open("welcome");
await meet().click();
await page.waitForSelector("[data-testid='first-start']", { timeout: 5000 });
check((await page.locator("[data-testid='first-start']").innerText()).includes("getting its bearings"), "the first start is shown while the first mate reads this Mac");
await shot("first-start");
await page.waitForFunction(() => document.querySelector("[data-testid='first-start']") === null, null, { timeout: 10000 });
check((await page.locator(".main-surface").innerText()).includes("Ahoy, captain. I'm your first mate."), "its first words take the card's place");
check(await page.locator("[data-screen='welcome']").count() === 0, "and the welcome is done");
await shot("first-words");

// A first start that is signed out goes back to the welcome, where signing in is.
await open("welcome&welcome-start=signed-out");
await meet().click();
await page.waitForSelector("[data-screen='welcome']", { timeout: 8000 });
check(true, "a signed-out first start goes back to the welcome");
// One that fails another way says so in chat, as every later start does.
await open("welcome&welcome-start=timeout");
await meet().click();
await page.waitForSelector(".problem-banner[data-reason-kind='timeout']", { timeout: 8000 });
check(await page.locator("[data-testid='first-start']").count() === 0, "a first start that fails drops the progress for today's banner");
await shot("first-start-timeout");

// A home that met its first mate long ago: a signed-out start says so with the agent's name and a way to sign in.
await page.goto(`${baseUrl}/?dead=signed_out&not-started`);
await page.waitForSelector("[data-screen='bearings']", { timeout: 20000 });
await page.locator(".runtime-button").click();
await page.waitForSelector(".problem-banner[data-reason-kind='signed_out']", { timeout: 5000 });
const banner = await page.locator(".problem-banner").first().innerText();
check(banner.includes("Claude Code isn't signed in on this Mac"), "a signed-out start names the agent");
check(await page.locator(".problem-banner button", { hasText: "Sign in" }).count() === 1 && await page.locator(".problem-banner button", { hasText: "Start it again" }).count() === 1, "and offers its sign-in and another start");
check(await page.locator("[data-screen='welcome']").count() === 0, "a home that met its first mate never sees the welcome");
await shot("signed-out-banner");

// Settings lists the same agents, read when it opens.
await page.goto(`${baseUrl}/`);
await page.waitForSelector("[data-screen='bearings']", { timeout: 20000 });
await page.locator(".sidebar-footer button[title='Settings']").click();
await page.waitForSelector(".settings-dialog .agent-row", { timeout: 5000 });
check(await page.locator(".settings-dialog .agent-row").count() === 2, "Settings lists the agents on this Mac");
await shot("settings");

check(errors.length === 0, `the page raised no errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll welcome checks passed.");
