// Checks the repository's no-mistakes config, .no-mistakes.yaml at the root, which no-mistakes honours only from
// main's copy, so a change that drops a setting would pass every branch run and take effect only once it landed.
//
//   pnpm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: "utf8",
}).trim();
const CONFIG = join(ROOT, ".no-mistakes.yaml");

test("the config sits at the repository root, the one place no-mistakes reads it from", () => {
  assert.ok(existsSync(CONFIG), `no .no-mistakes.yaml at the repository root ${ROOT}`);
});

test("main integrates by merge, so a resubmitted branch keeps its earlier head as an ancestor", () => {
  const config = parse(readFileSync(CONFIG, "utf8"));
  assert.equal(config?.rebase?.strategy, "merge");
});
