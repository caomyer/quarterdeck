// Checks each task's pipeline status on the browser mock, in both themes: the block heading the task drawer in every
// state the approved mock draws, and the chip and nine-cell strip beside the row in the project's task list.
//
//   pnpm dev --port 4191 --strictPort
//   FIRSTMATE_URL=http://127.0.0.1:4191 pnpm pipeline
//
// `?pipeline` adds a task in every state (src/host/mock-pipeline.ts), each with `pipeline` and `waiting_on` in the
// engine's shape; `?pipeline=stale` makes the newest fleet read fail, so the last good one shows and says so.
// It checks that the holder is the snapshot's own, that a scout, a direct-PR and a local-only task draw no rail, that
// unknown stays unknown, that the only control is the link to an open call and it opens that call, and that a task from
// a firstmate predating the fold keeps its old status line.
// Set ARTIFACT_SHOTS to a folder to also save screenshots in both themes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { PIPELINE_CALL, PIPELINE_CASES } from "../src/host/mock-pipeline.ts";

const baseUrl = process.env.FIRSTMATE_URL;
if (!baseUrl) throw new Error("Set FIRSTMATE_URL to the Vite server you started yourself, for example http://127.0.0.1:4191. Other agents run servers from this checkout, so there is no safe default.");
const shots = process.env.ARTIFACT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (ok) console.log(`ok: ${what}`); else { failures.push(what); console.log(`FAIL: ${what}`); } };

async function shot(target, name) {
  if (!shots) return;
  const page = "page" in target ? target.page() : target;
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(300);
    await target.screenshot({ path: join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

/** What each state's block must say: its headline's words, and whether it draws a rail, a gate and a PR line. */
const EXPECT = {
  "qd-usage-strip-2": { headline: "Writing the change. The pipeline starts when the worker runs it.", rail: true, ships: "Will validate through the pipeline.", note: "No run is bound to this branch yet." },
  "qd-tasklist-build-2": { headline: "Reviewing the change.", rail: true, note: "review · 4m12s · last activity 8s ago", source: "no-mistakes run 01M3H2" },
  "qd-contrib-noise-2": { headline: "Fixing review findings. Fix round 1 of 3.", rail: true, note: "auto-fix 1/3" },
  "qd-attach-e2e-1": { headline: "Testing, but nothing has come from the step for 31 minutes.", rail: true, note: "quiet 31m2s" },
  "qd-pr-shots-2": { headline: "Checks are running on the PR.", rail: true, pr: "PR #33 open · checks running" },
  "qd-onboarding-3": { headline: "Checks were green, then main moved.", rail: true, pr: "last read green, then main moved" },
  "qd-replies-2": { headline: "Validating. Which step is not readable right now.", rail: true, unknownRail: true, source: "runs ledger only" },
  "qd-call-evidence-3": { headline: "The review gate found 3 things the worker can answer itself.", rail: true, gate: "Parked at review for 2m10s · 3 findings, all the worker's", findings: 3 },
  "qd-sessionctl-build-2": { headline: "A finding needs an authority decision. The worker passed it to the first mate.", rail: true, gate: "2 findings, 1 ask-user", findings: 2, askUser: 1, escalated: "nm-01M3HD-review" },
  "qd-chat-calls-build-2": { headline: "Your call: Let a page sit below a newer message?", rail: true, gate: "1 finding, 1 ask-user", findings: 1, askUser: 1, call: true },
  "qd-tasks-sort-2": { headline: "Checks are green. The PR waits for you to merge it.", rail: true, held: true, pr: "PR #35 open · checks green", source: "merge posture: yours" },
  "qd-routing-fix-1": { headline: "Checks are green. The first mate holds merge authority for this task.", rail: true, held: true, source: "merge posture: first mate (yolo on)" },
  "qd-voice-held-1": { headline: "Checks were green when the pipeline stopped watching. The PR waits for your merge.", rail: true, held: true, pr: "PR #37 state unknown · ci monitor ended, last read green" },
  "qd-contrib-noise-1": { headline: "Landed. PR merged.", rail: true, pr: "PR #30 merged · merge receipt" },
  "qd-call-evidence-1": { headline: "The PR was closed unmerged. The first mate decides what happens next.", rail: true, pr: "PR #28 closed, not merged · forge read" },
  "qd-history-page-2": { headline: "The run failed at test.", rail: true, source: "outcome failed" },
  "qd-sessionctl-build-1": { headline: "The run was cancelled at review.", rail: true },
  "qd-sources-gh-2": { headline: "The no-mistakes service is not answering.", rail: true, unknownRail: true, note: "the only record is from before the service stopped" },
  "qd-nm-visibility-1": { headline: "Investigating. A scout writes a report and opens no PR.", rail: false, ships: "Report only." },
  "qd-docs-shots-1": { headline: "Reported done with a PR, raised directly without the pipeline.", rail: false, ships: "No pipeline: the worker opens the PR itself.", pr: "state not read · checks not read for direct-PR" },
  "qd-dev-tidy-1": { headline: "Committed on its branch. No remote, no PR.", rail: false, ships: "No pipeline, no PR. Lands on local main." },
  "qd-spawn-race-2": { headline: "The pipeline did not answer, and nothing else proves who holds this.", rail: true, unknownRail: true, source: "no-mistakes did not answer" },
};
const LABEL = { captain: "You", first_mate: "First mate", worker: "Worker", pipeline: "Pipeline", ci: "CI", external: "Outside wait", none: "No one", unknown: "Can't tell" };
const TOKEN = { captain: "--coral", first_mate: "--amber", worker: "--blue", pipeline: "--sea", ci: "--sea", none: "--green", unknown: "--muted" };

check(PIPELINE_CASES.length === Object.keys(EXPECT).length && PIPELINE_CASES.every((item) => EXPECT[item.id]), "every mock state has an expectation, and every expectation a state");
check(new Set(PIPELINE_CASES.map((item) => item.waiting_on.who)).size >= 7, "the mock covers every holder but the outside wait");

/** Opens the mock with `flags` on resonance's page, with its task list drawn. */
async function openList(flags = "", size = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: size.height } });
  page.on("pageerror", (error) => failures.push(`${flags}: page error: ${error.message}`));
  await page.goto(`${baseUrl}/?artifacts${flags}`);
  await page.waitForFunction(() => !document.querySelector(".app-loading"));
  await page.locator(".project-shortcuts button", { hasText: "resonance" }).click();
  await page.locator("[data-testid='task-list']").waitFor();
  if (size.width !== 1280) await page.setViewportSize(size);
  return page;
}

const row = (page, id) => page.locator(`[data-testid='task-list'] .tl-row[data-id='${id}']`);

async function openDrawer(page, id) {
  await row(page, id).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await row(page, id).locator(".tl-copy").click();
  const drawer = page.locator(".task-drawer");
  await drawer.waitFor();
  return drawer;
}

async function closeDrawer(page) {
  await page.locator(".task-drawer .icon-button[title='Close task details']").click();
  await page.locator(".task-drawer").waitFor({ state: "detached" });
}

const tokenColour = (page, name) => page.evaluate((token) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}, name);

async function painted(page, locator, token, what) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(300);
    const want = await tokenColour(page, token);
    const got = await locator.evaluate((element) => getComputedStyle(element).color);
    check(got === want, `${theme}: ${what} is ${token} (${got})`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

// The list: every row says who holds it, in a few words, beside its strip or the words for no pipeline.
{
  const page = await openList("&pipeline");
  for (const item of PIPELINE_CASES) {
    const standing = row(page, item.id).locator("[data-testid='pipeline-standing']");
    check(await standing.getAttribute("data-who") === item.waiting_on.who, `${item.id}: the row's chip is the snapshot's holder, ${item.waiting_on.who}`);
    check((await standing.locator(".ps-who").innerText()).trim() === `${LABEL[item.waiting_on.who]} · ${item.waiting_on.why}`, `${item.id}: the chip reads "${LABEL[item.waiting_on.who]} · ${item.waiting_on.why}"`);
    const strip = standing.locator("[data-testid='pipeline-strip']");
    if (EXPECT[item.id].rail) {
      check(await strip.locator("b").count() === 9, `${item.id}: the strip has nine cells`);
    } else {
      check((await strip.innerText()).trim() === "no pipeline" && await strip.locator("b").count() === 0, `${item.id}: no strip, the words "no pipeline"`);
    }
  }
  const cells = (id) => row(page, id).locator("[data-testid='pipeline-strip'] b").evaluateAll((items) => items.map((item) => item.className));
  check((await cells("qd-call-evidence-3"))[2] === "parked", "a parked run's strip parks its review cell");
  check((await cells("qd-tasks-sort-2"))[8] === "held", "a green run waiting on its merge holds its ci cell");
  check((await cells("qd-history-page-2"))[3] === "failed", "a failed run's strip marks the step it failed at");
  check((await cells("qd-replies-2")).every((name) => name === "unknown"), "a ledger-only read draws every cell unknown, not pending");
  check((await cells("qd-spawn-race-2")).every((name) => name === "unknown"), "a pipeline that did not answer draws every cell unknown");
  check((await cells("qd-usage-strip-2")).every((name) => name === "pending"), "no run yet draws every cell pending");
  for (const [who, token] of Object.entries(TOKEN)) {
    const item = PIPELINE_CASES.find((entry) => entry.waiting_on.who === who);
    await painted(page, row(page, item.id).locator(".ps-who em"), token, `the ${LABEL[who]} chip`);
  }
  const list = page.locator("[data-testid='task-list']");
  await list.evaluate((node) => node.scrollIntoView());
  await shot(list, "pipeline-list");
  await row(page, "qd-chat-calls-build-2").evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot(row(page, "qd-chat-calls-build-2"), "pipeline-list-row");

  // The drawer: every state's block, and nothing in it that does nothing.
  for (const item of PIPELINE_CASES) {
    const want = EXPECT[item.id];
    const drawer = await openDrawer(page, item.id);
    const block = drawer.locator("[data-testid='pipeline-status']");
    check(await block.count() === 1, `${item.id}: the block heads the drawer`);
    check(await drawer.locator("[data-testid='start-status']").count() === 0, `${item.id}: the block takes the old status line's place`);
    const first = await drawer.evaluate((node) => node.querySelector(".drawer-header")?.nextElementSibling?.getAttribute("data-testid"));
    check(first === "pipeline-status", `${item.id}: the block sits directly under the title`);
    check(await block.getAttribute("data-who") === item.waiting_on.who && Number(await block.getAttribute("data-rule")) === item.waiting_on.rule, `${item.id}: the block names the snapshot's holder and rule`);
    check((await block.locator("[data-testid='pipeline-who']").innerText()).trim() === LABEL[item.waiting_on.who], `${item.id}: headline says ${LABEL[item.waiting_on.who]}`);
    const text = await block.innerText();
    check(text.includes(want.headline), `${item.id}: says "${want.headline}"`);
    const rail = block.locator("[data-testid='pipeline-rail']");
    check((await rail.count() === 1) === want.rail, `${item.id}: ${want.rail ? "draws a rail" : "draws no rail"}`);
    if (want.rail) check(await rail.locator("li").count() === 9, `${item.id}: the rail has nine steps`);
    if (want.unknownRail) check((await rail.locator("li").evaluateAll((items) => items.map((li) => li.className))).every((name) => name === "unknown"), `${item.id}: every step is unknown`);
    if (want.held) check(await rail.locator("li.held").count() === 1, `${item.id}: ci is held for a merge, not done`);
    if (want.ships) check((await block.locator("[data-testid='pipeline-ships']").innerText()).includes(want.ships), `${item.id}: says how it ships: "${want.ships}"`);
    if (want.note) check((await block.locator("[data-testid='pipeline-note']").first().innerText()).includes(want.note), `${item.id}: the rail's note says "${want.note}"`);
    if (want.pr) check((await block.locator("[data-testid='pipeline-pr']").innerText()).includes(want.pr), `${item.id}: the PR line says "${want.pr}"`);
    if (want.source) check((await block.locator("[data-testid='pipeline-source']").innerText()).includes(want.source), `${item.id}: the footer names "${want.source}"`);
    check(/read \d+s ago/.test(await block.locator("[data-testid='pipeline-source']").innerText()), `${item.id}: the footer says how old the read is`);
    const gate = block.locator("[data-testid='pipeline-gate']");
    check((await gate.count() === 1) === !!want.gate, `${item.id}: ${want.gate ? "shows the gate" : "shows no gate"}`);
    if (want.gate) {
      check((await gate.locator(".ps-gate-h").innerText()).includes(want.gate), `${item.id}: the gate says "${want.gate}"`);
      check(await gate.locator(".ps-findings li").count() === want.findings, `${item.id}: every finding row shows`);
      check(await gate.locator(".ps-findings li.ask").count() === (want.askUser ?? 0), `${item.id}: ask-user findings are marked`);
      const rows = item.pipeline.findings.rows;
      check((await gate.locator(".ps-fd").allInnerTexts()).join("|") === rows.map((finding) => finding.description).join("|"), `${item.id}: finding descriptions are the pipeline's words, verbatim`);
    }
    if (want.escalated) check((await block.innerText()).includes(`Escalated as ${want.escalated}`), `${item.id}: names the escalation it found`);
    const controls = await block.locator("button, a, input, select").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid") ?? item.tagName.toLowerCase()));
    const allowed = controls.every((name) => name === "pipeline-call" || name === "a");
    check(allowed, `${item.id}: the block has no control but a call link and a link to the PR (${controls.join(",") || "none"})`);
    check((await block.locator("[data-testid='pipeline-call']").count() === 1) === !!want.call, `${item.id}: ${want.call ? "links its open call" : "links no call"}`);
    const overflow = await block.evaluate((node) => node.scrollWidth - node.clientWidth);
    check(overflow <= 0, `${item.id}: nothing in the block runs past its edge (${overflow}px)`);
    if (["qd-sessionctl-build-2", "qd-tasks-sort-2", "qd-contrib-noise-2", "qd-pr-shots-2", "qd-history-page-2", "qd-nm-visibility-1", "qd-spawn-race-2", "qd-chat-calls-build-2", "qd-sources-gh-2", "qd-onboarding-3", "qd-call-evidence-3", "qd-docs-shots-1"].includes(item.id)) {
      await shot(block, `pipeline-block-${item.id}`);
    }
    if (item.id === "qd-sessionctl-build-2") await shot(drawer, "pipeline-drawer");
    await closeDrawer(page);
  }

  // The one link opens the call it names, on Bearings, where it is answered.
  const drawer = await openDrawer(page, "qd-chat-calls-build-2");
  await drawer.locator("[data-testid='pipeline-call']").click();
  const card = page.locator(`.decision-card[data-call-id='${PIPELINE_CALL}']`);
  await card.waitFor({ timeout: 4000 }).catch(() => {});
  check(await card.count() === 1 && await page.locator(".task-drawer").count() === 0, "the call link closes the drawer and opens the call's card");
  await page.close();
}

// A firstmate that predates the fold: the drawer keeps its own status line and the list its own chip.
{
  const page = await openList("");
  const id = await page.locator("[data-testid='task-list'] .tl-row.underway").first().getAttribute("data-id");
  check(!!id && await row(page, id).locator("[data-testid='pipeline-standing']").count() === 0 && await row(page, id).locator(".tl-chip").count() === 1, "a task with no waiting_on keeps its old chip");
  const drawer = await openDrawer(page, id);
  check(await drawer.locator("[data-testid='start-status']").count() === 1 && await drawer.locator("[data-testid='pipeline-status']").count() === 0, "a task with no waiting_on keeps its old status line");
  await page.close();
}

// A failed refresh: the last good read stays, and says it is the last one and why.
{
  const page = await openList("&pipeline=stale");
  const drawer = await openDrawer(page, "qd-tasklist-build-2");
  const footer = drawer.locator("[data-testid='pipeline-source']");
  check(await footer.evaluate((node) => node.classList.contains("stale")), "a failed refresh turns the footer amber");
  const words = await footer.innerText();
  check(/last good read 7m ago/.test(words) && words.includes("refresh failed: fm-fleet-snapshot.sh did not finish within 90s"), `the footer says how old the last good read is and why the refresh failed (${words})`);
  check((await drawer.locator("[data-testid='pipeline-status']").innerText()).includes("This is the last read. The newest refresh failed."), "the block says this is the last read");
  await painted(page, footer, "--amber", "the stale footer");
  await shot(drawer.locator("[data-testid='pipeline-status']"), "pipeline-block-stale");
  await page.close();
}

// The narrow window: the chip and strip still fit beside the title, and the block inside the drawer.
{
  const page = await openList("&pipeline", { width: 500, height: 900 });
  const overflow = await page.locator("[data-testid='task-list']").evaluate((node) => node.scrollWidth - node.clientWidth);
  check(overflow <= 0, `narrow: the list does not scroll sideways (${overflow}px)`);
  const drawer = await openDrawer(page, "qd-sessionctl-build-2");
  const block = drawer.locator("[data-testid='pipeline-status']");
  check(await block.evaluate((node) => node.scrollWidth - node.clientWidth) <= 0, "narrow: the block fits the drawer");
  await shot(page, "pipeline-narrow");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall pipeline checks passed");
