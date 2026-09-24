// Unit tests for scripts/release.mjs: the release's version, its notes, the updater's manifest, and the signature
// check that runs before anything is published.
//
//   pnpm test
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { changeLines, manifest, PLATFORM, releaseVersion, signatureProblem } from "./release.mjs";

test("a release is 0.1.<run>, always newer than what is published", () => {
  assert.equal(releaseVersion(7, []), "0.1.7");
  assert.equal(releaseVersion("12", ["v0.1.9", "v0.1.11", "not-a-version"]), "0.1.12");
  assert.equal(releaseVersion(100, ["v0.1.99"]), "0.1.100", "compared as numbers, not text");
  assert.throws(() => releaseVersion(11, ["v0.1.11"]), /not newer than v0\.1\.11/);
  assert.throws(() => releaseVersion(3, ["v0.1.40"]), /run numbers restarted/);
  assert.throws(() => releaseVersion(5, ["v0.2.0"]), /not newer than v0\.2\.0/);
  assert.throws(() => releaseVersion("abc", []), /whole number/);
});

test("the notes name each change that landed: a pull request by its title, a commit by its subject", () => {
  const log = [
    "Merge pull request #9 from caomyer/fm/qd-usage-design-1\x1fUsage panel: context and plan limits\n\nLonger text\n",
    "engine: keep the watcher alive across a relaunch\x1f\n",
    "Merge pull request #8 from caomyer/fm/qd-attach-1\x1f\n",
  ].map((entry) => `${entry}\x1e`).join("\n");
  assert.equal(changeLines(log), "- Usage panel: context and plan limits (#9)\n- engine: keep the watcher alive across a relaunch\n- Merge pull request #8 from caomyer/fm/qd-attach-1 (#8)");
  const long = `no-mistakes(ci): ${"a very long subject ".repeat(12)}\x1f\x1e`;
  const line = changeLines(long);
  assert.ok(line.length <= 123 && line.endsWith("…"), line);
  const many = Array.from({ length: 25 }, (_, i) => `change ${i}\x1f\x1e`).join("");
  const lines = changeLines(many).split("\n");
  assert.equal(lines.length, 21);
  assert.equal(lines.at(-1), "- and 5 more");
  assert.equal(changeLines(""), "");
});

test("the manifest is what the updater reads", () => {
  const read = manifest({ version: "0.1.12", notes: "- One (#1)", signature: "c2ln\n", url: "https://example.test/a.app.tar.gz", date: new Date("2026-09-24T01:02:03.456Z") });
  assert.deepEqual(read, { version: "0.1.12", notes: "- One (#1)", pub_date: "2026-09-24T01:02:03Z", platforms: { [PLATFORM]: { signature: "c2ln", url: "https://example.test/a.app.tar.gz" } } });
  assert.equal(PLATFORM, "darwin-aarch64");
  assert.throws(() => manifest({ version: "latest", signature: "x", url: "u" }), /not a version/);
  assert.throws(() => manifest({ version: "0.1.1", signature: " ", url: "u" }), /empty/);
});

/** A minisign key and signature in the files Tauri writes, made here so the check is tested without its CLI. */
function minisign(idHex = "640E673B1E6299A6") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  // The comment prints the id in reverse byte order, as minisign does.
  const id = Buffer.from(idHex, "hex").reverse();
  const pubkey = Buffer.from(`untrusted comment: minisign public key: ${idHex}\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64");
  const signFile = (data, trusted = "timestamp:1\tfile:a.app.tar.gz") => {
    const signature = sign(null, createHash("blake2b512").update(data).digest(), privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
    const body = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
    return Buffer.from(body).toString("base64");
  };
  return { pubkey, signFile };
}

test("an update is published only when the key the app trusts signed it", () => {
  const data = Buffer.from("the bundle");
  const trusted = minisign();
  assert.equal(signatureProblem(data, trusted.signFile(data), trusted.pubkey), null);
  assert.equal(signatureProblem(Buffer.from("another bundle"), trusted.signFile(data), trusted.pubkey), "the signature does not match the file");
  const stranger = minisign("0123456789ABCDEF");
  assert.match(signatureProblem(data, stranger.signFile(data), trusted.pubkey), /signed by key 0123456789ABCDEF, but the app trusts 640E673B1E6299A6/);
  const sameId = minisign();
  assert.equal(signatureProblem(data, sameId.signFile(data), trusted.pubkey), "the signature does not match the file", "a different key that claims the same id");
  const tampered = Buffer.from(Buffer.from(trusted.signFile(data), "base64").toString().replace("file:a.app", "file:b.app")).toString("base64");
  assert.equal(signatureProblem(data, tampered, trusted.pubkey), "the signature's trusted comment does not match");
  assert.equal(signatureProblem(data, "bm90IGEgc2lnbmF0dXJl", trusted.pubkey), "the signature is not a minisign signature");
  assert.throws(() => signatureProblem(data, trusted.signFile(data), "bm90IGEga2V5"), /not a minisign key/);
});
