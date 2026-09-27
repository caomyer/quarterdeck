// Tests for scripts/install.sh, the line a new captain pastes to install Quarterdeck, against a release served from
// local files: installing, replacing a copy, and each refusal leaving the Mac as it was.
//
//   pnpm test
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./install.sh", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "qd-install-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const APP = "firstmate desktop.app";

/** A release on disk: a manifest naming a tarball that holds `holds` (the app, by default) marked with `mark`. */
function release(name, { mark = "new", holds = APP } = {}) {
  const dir = join(root, name);
  const stage = join(dir, "stage");
  mkdirSync(join(stage, holds, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(stage, holds, "Contents", "MacOS", "firstmate-desktop"), `#!/bin/sh\n# ${mark}\n`);
  execFileSync("tar", ["-czf", join(dir, "quarterdeck_9.9.9_aarch64.app.tar.gz"), "-C", stage, holds]);
  const manifest = join(dir, "latest.json");
  writeFileSync(manifest, JSON.stringify({
    version: "9.9.9",
    notes: "- a change",
    platforms: { "darwin-aarch64": { signature: "sig", url: `file://${join(dir, "quarterdeck_9.9.9_aarch64.app.tar.gz")}` } },
  }, null, 2));
  return `file://${manifest}`;
}

function install(manifest, dest, env = {}) {
  return spawnSync("sh", [script], {
    encoding: "utf8",
    env: { ...process.env, QUARTERDECK_MANIFEST_URL: manifest, QUARTERDECK_INSTALL_DIR: dest, QUARTERDECK_INSTALL_ARCH: "arm64", QUARTERDECK_INSTALL_OPEN: "0", ...env },
  });
}

const marker = (dest) => readFileSync(join(dest, APP, "Contents", "MacOS", "firstmate-desktop"), "utf8");

test("installs the latest release into place, and replaces a copy already there", () => {
  const dest = join(root, "apps-fresh");
  const first = install(release("r1", { mark: "one" }), dest);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Installing Quarterdeck 9\.9\.9 for Apple Silicon\./);
  assert.match(first.stdout, /Installed .*firstmate desktop\.app/);
  assert.match(marker(dest), /one/);
  const second = install(release("r2", { mark: "two" }), dest);
  assert.equal(second.status, 0, second.stderr);
  assert.match(marker(dest), /two/, "the copy there is replaced");
});

test("an Intel Mac is told so, and nothing is installed", () => {
  const dest = join(root, "apps-intel");
  const run = install(release("r3"), dest, { QUARTERDECK_INSTALL_ARCH: "x86_64" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Intel processor\. Quarterdeck runs only on Apple Silicon for now, so nothing was installed\./);
  assert.equal(existsSync(dest), false);
});

test("a release that cannot be read, or holds no app, changes nothing", () => {
  const dest = join(root, "apps-kept");
  assert.equal(install(release("r4", { mark: "kept" }), dest).status, 0);
  const unreachable = install(`file://${join(root, "nowhere", "latest.json")}`, dest);
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, /Could not read the latest release: .*\nNothing was installed\./);
  const empty = install(release("r5", { holds: "something else.app" }), dest);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /did not hold firstmate desktop\.app\. Nothing was installed\./);
  assert.match(marker(dest), /kept/, "the copy that was there is untouched");
});

test("a running copy is not replaced from under its first mate", async () => {
  const dest = join(root, "apps-running");
  assert.equal(install(release("r6", { mark: "running" }), dest).status, 0);
  // A process running from the installed copy, as the app's own binary would. A script, since macOS will not run a
  // copied system binary from another path; its interpreter carries the path in its arguments, as the app's does.
  const binary = join(dest, APP, "Contents", "MacOS", "firstmate-desktop");
  writeFileSync(binary, "#!/bin/sh\nsleep 30\n");
  chmodSync(binary, 0o755);
  const running = spawn(binary, [], { stdio: "ignore", detached: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const run = install(release("r7", { mark: "replacement" }), dest);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /firstmate desktop is open\. Quit it, then run this line again\. Nothing was changed\./);
    assert.match(readFileSync(binary, "utf8"), /sleep 30/, "the running copy is untouched");
  } finally {
    process.kill(-running.pid);
  }
});
