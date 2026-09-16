// Checks that status colour and icon follow the status, in both themes, on the browser mock.
//
//   pnpm dev --port 4182 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4182 pnpm tones
//
// The fixtures have nothing underway, so this feeds the mock a fleet with one task in each
// state fm-fleet-snapshot.sh reports, by answering the fixture imports itself.
// Colours are compared with the theme's own tokens, so a retheme does not break the check.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4182. Other agents run servers from this checkout, so there is no safe default.");

const fleet = JSON.parse(readFileSync(new URL("../src/fixtures/fleet-snapshot.json", import.meta.url), "utf8"));
const bearings = JSON.parse(readFileSync(new URL("../src/fixtures/bearings-snapshot.json", import.meta.url), "utf8"));
const home = fleet.fm_home;

/** The tone each state must show, as the token it is painted with. */
const EXPECTED = { working: "--blue", done: "--green", failed: "--coral", blocked: "--amber", parked: "--amber", paused: "--amber", unknown: "--muted" };
const WARNING_ICON = "lucide-circle-alert";

const task = (state) => ({
  id: `task-${state}`, kind: "ship", harness: "claude", mode: "no-mistakes", yolo: "off", project: `${home}/projects/resonance`, backend: "tmux",
  paths: { status_log: { present: true, last_event: { state, note: `A task that is ${state}.`, raw: `${state}` } }, worktree: { path: `${home}/worktrees/task-${state}`, present: true }, report: { path: "", present: false } },
  current_state: { state, source: "pane", detail: "", raw: `state=${state}`, observed_at: "2026-09-16T07:41:00Z", freshness: "fresh" },
  endpoint: { target: `fm:task-${state}`, exists: true, agent_alive: "yes", status: "alive", observed_at: "2026-09-16T07:41:00Z", freshness: "fresh" },
  pr: { url: null, source: "gh" },
  hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: "" },
  actions: { watch: "", steer: "", return_channel_note: null },
});
const tasks = Object.keys(EXPECTED).map(task);
const busyFleet = { ...fleet, tasks };
const busyBearings = {
  ...bearings,
  in_flight: tasks.map((item) => ({ id: item.id, kind: item.kind, state: item.current_state.state, repo: item.project, name: item.id, doing: "" })),
  unhealthy_endpoints: [{ id: "task-working", backend: "tmux", target: "fm:task-working", exists: false, agent: "gone" }],
};

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

async function open(query, { busy = false, replay = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
  page.on("pageerror", (error) => failures.push(`${query}: ${error.message}`));
  if (busy) {
    await page.route("**/src/fixtures/fleet-snapshot.json*", (route) => route.fulfill({ contentType: "text/javascript", body: `export default ${JSON.stringify(busyFleet)};` }));
    await page.route("**/src/fixtures/bearings-snapshot.json*", (route) => route.fulfill({ contentType: "text/javascript", body: `export default ${JSON.stringify(busyBearings)};` }));
  }
  if (replay) await page.addInitScript((events) => { window.__FM_REPLAY__ = events; }, replay);
  await page.goto(`${baseUrl}/${query}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  return page;
}

/** Runs the checks once per theme: tokens resolve differently, and a tone must hold in both. */
async function inBothThemes(page, run) {
  for (const theme of ["dark", "light"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await run(theme);
  }
}

/** The element's colour (or background) against a token, both resolved by the browser. */
function colourOf(locator, property = "color") {
  return locator.evaluate((element, prop) => getComputedStyle(element)[prop], property);
}
async function tokenColour(page, token) {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}
/** Lucide names its icon in one of several classes, so match the name rather than the whole attribute. */
async function wears(locator, icon) {
  return ((await locator.locator("svg").first().getAttribute("class")) ?? "").split(/\s+/).includes(icon);
}

// Underway on Bearings, a project page and the task drawer: tone and icon follow the task's state.
{
  const page = await open("", { busy: true });
  await page.locator(".task-row").first().waitFor();
  await inBothThemes(page, async (theme) => {
    for (const [state, token] of Object.entries(EXPECTED)) {
      const row = page.locator(".bearings-page .task-row", { hasText: `task-${state}` });
      const want = await tokenColour(page, token);
      check(await colourOf(row.locator(".task-state")) === want, `${theme}: Underway ${state} icon is painted ${token}`);
      check(await colourOf(row.locator(".task-chip")) === want, `${theme}: Underway ${state} chip is painted ${token}`);
      if (state === "working" || state === "done") check(!(await wears(row.locator(".task-state"), WARNING_ICON)), `${theme}: Underway ${state} does not wear the warning icon`);
    }
    // Charted Next: a gate waits, and a record that doesn't match is degraded. Neither is a success.
    const gate = page.locator(".compact-row", { hasText: "AI titles" }).locator("> span");
    check(await colourOf(gate) === await tokenColour(page, "--amber"), `${theme}: a Charted Next gate is painted --amber, not --green`);
    const repair = page.locator(".compact-row", { hasText: "don't match" }).locator("> span");
    check(await colourOf(repair) === await tokenColour(page, "--amber"), `${theme}: a records mismatch is painted --amber, not --green`);
  });

  await page.locator(".bearings-page .task-row", { hasText: "task-working" }).click();
  const status = page.locator(".drawer-status");
  await status.waitFor();
  check(await colourOf(status.locator("strong")) === await tokenColour(page, "--blue"), "the drawer of a working task is painted --blue");
  check(!(await wears(status.locator(".task-state"), WARNING_ICON)), "the drawer of a working task does not wear the warning icon");
  check(!(await status.textContent()).includes("could not confirm"), "the drawer of a working task does not claim its state is unconfirmed");
  await page.locator(".task-drawer .icon-button[title='Close task details']").click();

  await page.locator(".primary-nav .nav-item", { hasText: "Projects" }).click();
  await page.locator(".project-card", { hasText: "resonance" }).click();
  const failed = page.locator(".project-page .task-row", { hasText: "task-failed" });
  check(await colourOf(failed.locator(".task-state")) === await tokenColour(page, "--coral"), "a failed task on its project page is painted --coral");
  await page.close();
}

// A Captain's Call answer: read, waiting and failed are three facts, with three looks.
{
  const page = await open("");
  const card = page.locator(".decision-card").first();
  await card.locator(".suggestion-chips button").first().click();
  await card.locator(".decision-actions button").click();
  await card.getByText("Answered", { exact: false }).waitFor();
  await inBothThemes(page, async (theme) => {
    check(await colourOf(card.locator(".call-state")) === await tokenColour(page, "--green"), `${theme}: an answer the first mate read is painted --green`);
    check(await colourOf(card, "borderTopColor") === await tokenColour(page, "--border"), `${theme}: an answered call drops its urgent outline`);
  });
  await page.close();
}
{
  const page = await open("?relaunch&call-answered");
  await page.locator(".sidebar-footer .runtime-button").click();
  const card = page.locator(".decision-card").first();
  await card.getByText("Queued").waitFor();
  check(!(await wears(card.locator(".call-state"), "lucide-check")), "a queued answer does not wear the check mark");
  await page.close();
}
{
  const page = await open("?relaunch&failed&call-answered");
  await page.locator(".sidebar-footer .runtime-button").click();
  const card = page.locator(".decision-card").first();
  await card.getByText("Your answer didn't go through.").waitFor();
  check(!(await wears(card.locator(".call-state"), "lucide-check")), "a failed answer does not wear the check mark");
  await inBothThemes(page, async (theme) => {
    check(await colourOf(card.locator(".call-state")) === await tokenColour(page, "--coral"), `${theme}: a failed answer is painted --coral`);
  });
  await page.close();
}

// The first mate's dot: a usage limit or a rewake storm is degraded, never a green "Ready".
for (const [name, query, replay] of [
  ["a session limit", "?health=session_limit", null],
  ["a rewake storm", "?replay", [{ t_ms: 0, type: "state", payload: { state: "idle" } }, { t_ms: 10, type: "host_health", payload: { kind: "rewake_storm", rewake_storm: true, turns: 9, window_secs: 300 } }]],
]) {
  const page = await open(query, { replay });
  await page.locator(name === "a session limit" ? ".health-banner" : ".storm-banner").waitFor();
  await inBothThemes(page, async (theme) => {
    const amber = await tokenColour(page, "--amber");
    check(await colourOf(page.locator(".sidebar-footer .live-dot"), "backgroundColor") === amber, `${theme}: the sidebar dot is --amber during ${name}`);
  });
  check(!["Ready"].includes(await page.locator(".sidebar-footer .connection small").textContent()), `the sidebar does not say Ready during ${name}`);
  await page.locator(".primary-nav .nav-item", { hasText: "Chat" }).click();
  check(await colourOf(page.locator(".chat-status i"), "backgroundColor") === await tokenColour(page, "--amber"), `the chat status dot is --amber during ${name}`);
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nStatus tones follow status.");
