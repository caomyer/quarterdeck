// Proves the core package's boundary check by mutation: a copy of the package passes it as it is, and fails it with
// each kind of import or global a client brings put into it.
//
//   pnpm test
//
// The check is `packages/core/check.mjs`, which `pnpm build` runs before anything else, so a failure here is a build
// that fails.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CORE = fileURLToPath(new URL("../packages/core", import.meta.url));
const CHECK = join(CORE, "check.mjs");

/** Runs the check on a copy of the core holding `file` as `src/mutant.ts`, or no extra file at all. */
async function checkWith(file) {
  const folder = mkdtempSync(join(tmpdir(), "qd-core-"));
  try {
    cpSync(join(CORE, "src"), join(folder, "src"), { recursive: true });
    cpSync(join(CORE, "tsconfig.json"), join(folder, "tsconfig.json"));
    if (file !== undefined) writeFileSync(join(folder, "src", "mutant.ts"), file);
    try {
      await run(process.execPath, [CHECK, folder]);
      return { passed: true, said: "" };
    } catch (error) {
      return { passed: false, said: `${error.stdout}${error.stderr}` };
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const PLAIN = `import { emptyConversation } from "./conversation.ts";\nimport type { Call } from "./types";\nexport const fresh = (calls: Call[]) => calls.length ? emptyConversation() : null;\nexport const host = new URL("https://example.com/a").hostname;\n`;

const MUTANTS = [
  { name: "React", file: `import { useState } from "react";\nexport const hook = useState;\n`, says: /imports "react": React is a client's/ },
  { name: "React's types alone", file: `import type { ReactNode } from "react";\nexport type Node = ReactNode;\n`, says: /imports "react": React is a client's/ },
  { name: "React DOM", file: `import { createRoot } from "react-dom/client";\nexport const root = createRoot;\n`, says: /imports "react-dom\/client": React is a client's/ },
  { name: "React Native", file: `import { View } from "react-native";\nexport const view = View;\n`, says: /imports "react-native": React is a client's/ },
  { name: "Tauri", file: `import { invoke } from "@tauri-apps/api/core";\nexport const call = invoke;\n`, says: /imports "@tauri-apps\/api\/core": Tauri is the desktop's/ },
  { name: "Tauri loaded late", file: `export const load = () => import("@tauri-apps/api/event");\n`, says: /imports "@tauri-apps\/api\/event": Tauri is the desktop's/ },
  { name: "a browser library", file: `import { Icon } from "lucide-react";\nexport const icon = Icon;\n`, says: /imports "lucide-react": the core imports no package/ },
  { name: "a desktop file", file: `import { useHost } from "../../../src/host/use-host.ts";\nexport const hook = useHost;\n`, says: /imports "..\/..\/..\/src\/host\/use-host.ts": it leaves the core's own files/ },
  { name: "the window", file: `export const width = () => window.innerWidth;\n`, says: /Cannot find name 'window'/ },
  { name: "the document", file: `export const title = () => document.title;\n`, says: /Cannot find name 'document'/ },
  { name: "local storage", file: `export const saved = () => localStorage.getItem("home");\n`, says: /Cannot find name 'localStorage'/ },
  { name: "the browser's crypto", file: `export const id = () => crypto.randomUUID();\n`, says: /Cannot find name 'crypto'/ },
  { name: "the DOM lib, referenced", file: `/// <reference lib="dom" />\nexport const title = () => document.title;\n`, says: /references lib "dom": the core runs on the language alone/ },
  { name: "a package's types, referenced", file: `/// <reference types="react" />\nexport const none = 0;\n`, says: /references types "react": the core takes no package's types/ },
];

// Each run type-checks a copy of the whole core, so they run side by side.
describe("the core's boundary check", { concurrency: true }, () => {
  test("passes the core as it is", async () => {
    const { passed, said } = await checkWith(undefined);
    assert.ok(passed, said);
  });

  test("passes a file that uses only the language and the core's own files", async () => {
    const { passed, said } = await checkWith(PLAIN);
    assert.ok(passed, said);
  });

  for (const mutant of MUTANTS) {
    test(`fails on ${mutant.name} inside the core`, async () => {
      const { passed, said } = await checkWith(mutant.file);
      assert.equal(passed, false, `${mutant.name} passed the check`);
      assert.match(said, mutant.says);
      assert.match(said, /mutant\.ts/);
    });
  }
});
