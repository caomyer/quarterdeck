#!/usr/bin/env node
// Drives a development Quarterdeck started by scripts/devtest.sh, as the captain
// would: through the real window, against a real first mate.
//
//   node scripts/drive.mjs [--dir <drive dir>] [--timeout <s>] <command> ...
//
//   eval '<script>'        runs the script in the window as an async function body
//   text [selector]        the visible text of the page, or of the first match
//   click '<text>' [sel]   clicks the innermost visible control whose text or
//                          aria-label contains <text> (buttons, links, tabs, options)
//   type '<sel>' '<text>'  types into the input, textarea or contenteditable at <sel>
//   key '<sel>' '<key>'    presses a key (Enter, Escape, ...) on the element at <sel>
//   shot <file.png>        saves what the window shows, artifact frames included
//   wait '<text>' [s]      waits until the page's visible text contains <text>
//
// The drive directory is --dir, else QD_DRIVE, else devtest's default folder.
// Scripts run with a `qd` helper in scope: qd.find(text, sel), qd.click(text, sel),
// qd.type(sel, text), qd.key(sel, key), qd.text(sel), qd.sleep(ms).

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HELPERS = String.raw`
const qd = {
  visible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  },
  label(el) {
    return [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.value]
      .filter((t) => typeof t === "string").join(" ").replace(/\s+/g, " ").trim();
  },
  find(text, sel) {
    const pool = [...document.querySelectorAll(sel || "button, a, [role=button], [role=tab], [role=option], [role=menuitem], summary, label, input[type=checkbox], input[type=radio]")]
      .filter((el) => qd.visible(el) && qd.label(el).toLowerCase().includes(String(text).toLowerCase()));
    // The innermost match: a card holding a button of that name is not the button.
    return pool.find((el) => !pool.some((other) => other !== el && el.contains(other))) || null;
  },
  click(text, sel) {
    const el = qd.find(text, sel);
    if (!el) throw new Error("nothing visible to click says " + JSON.stringify(text));
    el.scrollIntoView({ block: "center" });
    el.click();
    return qd.label(el).slice(0, 120);
  },
  type(sel, text) {
    const el = document.querySelector(sel);
    if (!el) throw new Error("nothing matches " + sel);
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("insertText", false, text);
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, (el.value || "") + text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return el.value ?? el.innerText;
  },
  key(sel, key, opts = {}) {
    const el = sel ? document.querySelector(sel) : document.activeElement;
    if (!el) throw new Error("nothing matches " + sel);
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...opts }));
    }
    return key;
  },
  text(sel) {
    const el = sel ? document.querySelector(sel) : document.body;
    if (!el) throw new Error("nothing matches " + sel);
    return el.innerText;
  },
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
};
`;

function usage(message) {
  if (message) console.error(`drive: ${message}`);
  console.error(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}

const args = process.argv.slice(2);
let dir = process.env.QD_DRIVE || join(homedir(), ".buzz/.scratch/qd-devtest/devtest/drive");
let timeout = 120;
while (args[0]?.startsWith("--")) {
  const flag = args.shift();
  if (flag === "--dir") dir = args.shift();
  else if (flag === "--timeout") timeout = Number(args.shift());
  else usage(`unknown flag ${flag}`);
}
if (!existsSync(join(dir, "in"))) usage(`${dir} is not a drive folder; is the app up (scripts/devtest.sh up)?`);

let sequence = 0;
async function request(body, seconds = timeout) {
  const id = `${Date.now()}-${process.pid}-${sequence++}`;
  const partial = join(dir, `${id}.tmp`);
  writeFileSync(partial, JSON.stringify(body));
  renameSync(partial, join(dir, "in", `${id}.json`));
  const out = join(dir, "out", `${id}.json`);
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      const answer = JSON.parse(readFileSync(out, "utf8"));
      rmSync(out, { force: true });
      if (!answer.ok) throw new Error(typeof answer.value === "string" ? answer.value : JSON.stringify(answer.value));
      return answer.value;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  rmSync(join(dir, "in", `${id}.json`), { force: true });
  throw new Error(`no answer in ${seconds}s; is the app up?`);
}

// The deadline goes with the script, so one this side gave up on never runs later.
const run = (script, seconds = timeout) => request({ eval: `${HELPERS}\n${script}`, deadline_ms: Date.now() + seconds * 1000 }, seconds);
const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
const q = JSON.stringify;

const [command, ...rest] = args;
try {
  switch (command) {
    case "eval":
      print(await run(rest.join(" ")));
      break;
    case "text":
      print(await run(`return qd.text(${q(rest[0] || "")})`));
      break;
    case "click":
      print(await run(`return qd.click(${q(rest[0])}, ${q(rest[1] || "")})`));
      break;
    case "type":
      print(await run(`return qd.type(${q(rest[0])}, ${q(rest[1] ?? "")})`));
      break;
    case "key":
      print(await run(`return qd.key(${q(rest[0])}, ${q(rest[1])})`));
      break;
    case "shot": {
      if (!rest[0]) usage("shot needs a file");
      const file = resolve(rest[0]);
      mkdirSync(join(file, ".."), { recursive: true });
      const size = await run("return [innerWidth, innerHeight]");
      print(await request({ snapshot: file, size }));
      break;
    }
    case "wait": {
      const seconds = Number(rest[1] || timeout);
      // Polled from here, so a page that is slow to answer delays one check, not the wait.
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        const seen = await run(`return document.body.innerText.includes(${q(rest[0])})`, 30).catch(() => false);
        if (seen) break;
        if (Date.now() > deadline) throw new Error(`${q(rest[0])} did not appear in ${seconds}s`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      print("seen");
      break;
    }
    default:
      usage(command ? `unknown command ${command}` : "");
  }
} catch (error) {
  console.error(`drive: ${error.message}`);
  process.exit(1);
}
