// Checks the repository's no-mistakes config, .no-mistakes.yaml at the root, which no-mistakes honours only from
// main's copy, so a change that drops a setting would pass every branch run and take effect only once it landed.
//
//   pnpm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The top-level keys of a block-style YAML mapping, each with the meaningful lines nested under it. Enough for this
// file's own shape; anything it cannot read as that shape fails rather than passing over it.
function topLevel(text) {
  const keys = [];
  for (const line of text.split("\n")) {
    const body = line.replace(/\s+#.*$/, "").trimEnd();
    if (body === "" || body.trimStart().startsWith("#")) continue;
    const key = /^([A-Za-z_][\w-]*):(.*)$/.exec(body);
    if (key) {
      keys.push({ key: key[1], value: key[2].trim(), nested: [] });
      continue;
    }
    assert.ok(/^\s/.test(body) && keys.length > 0, `not a block mapping line: ${JSON.stringify(line)}`);
    keys.at(-1).nested.push(body.trim());
  }
  return keys;
}

test("main integrates by merge, so a resubmitted branch keeps its earlier head as an ancestor", () => {
  const keys = topLevel(readFileSync(join(ROOT, ".no-mistakes.yaml"), "utf8"));
  const rebase = keys.filter((entry) => entry.key === "rebase");
  assert.equal(rebase.length, 1, "exactly one rebase block");
  assert.equal(rebase[0].value, "", "rebase is a block, not a scalar");
  assert.deepEqual(rebase[0].nested, ["strategy: merge"], "rebase.strategy is merge, and nothing else is set beside it");
});

test("the reader refuses what it cannot read rather than passing over it", () => {
  assert.deepEqual(topLevel("rebase:\n  strategy: merge # why\n"), [{ key: "rebase", value: "", nested: ["strategy: merge"] }]);
  assert.deepEqual(topLevel("rebase:\n  strategy: rebase\n")[0].nested, ["strategy: rebase"]);
  assert.throws(() => topLevel("  strategy: merge\n"), /not a block mapping line/);
  assert.throws(() => topLevel("rebase: {strategy: merge}\n- item\n"), /not a block mapping line/);
});
