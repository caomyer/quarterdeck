// What a release is made of, for .github/workflows/release.yml: its version, the notes the app shows, the manifest
// the app's updater reads, and a check that the update is signed by the key the app trusts.
//
//   node scripts/release.mjs version --run <n>
//       0.1.<n>, refused unless it is newer than every v* tag already published.
//   node scripts/release.mjs notes [--since <tag>]
//       One line per change landed on main since <tag>, newest first: a merged pull request by its title,
//       a commit fast-forwarded onto main by its subject.
//   node scripts/release.mjs manifest --version <v> --tarball <path> --url <download url> [--notes-file <path>]
//       latest.json, for the updater: the version, the notes and the tarball's signature (<tarball>.sig).
//   node scripts/release.mjs verify --tarball <path> [--pubkey <base64>]
//       Checks <tarball>.sig against the updater's public key, by default the one in src-tauri/tauri.conf.json.
//       A release signed by any other key installs nowhere, so this runs before anything is published.
//
// Everything here is plain functions, exported for scripts/release.test.mjs; only the command line touches git.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The major and minor every release shares; the patch is the release workflow's run number. */
export const LINE = "0.1";
/** Each update's notes stay short: the sidebar shows them in a small space. */
const MAX_LINES = 20;
const MAX_LINE = 120;
/** The one platform the app ships for, in the updater's spelling. */
export const PLATFORM = "darwin-aarch64";

function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function newer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The release's version, which must be newer than every one published, or no installed app would take it. */
export function releaseVersion(run, tags) {
  if (!/^\d+$/.test(String(run))) throw new Error(`the run number must be a whole number, not ${JSON.stringify(run)}`);
  const version = `${LINE}.${Number(run)}`;
  const mine = parse(version);
  const newest = tags.map(parse).filter(Boolean).reduce((best, next) => (best && !newer(next, best) ? best : next), null);
  if (newest && !newer(mine, newest)) {
    throw new Error(`${version} is not newer than v${newest.join(".")}, already published. The workflow's run numbers restarted: raise LINE in scripts/release.mjs.`);
  }
  return version;
}

function clip(line) {
  const flat = line.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_LINE) return flat;
  const cut = flat.slice(0, MAX_LINE - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 60 ? cut.lastIndexOf(" ") : cut.length)}…`;
}

/**
 * The notes, from `git log --first-parent --format=%s%x1f%b%x1e`: one entry per change that landed on main. A merged
 * pull request says "Merge pull request #n from ..." and carries its title as the body's first line.
 */
export function changeLines(log) {
  const lines = log.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [subject, body = ""] = entry.split("\x1f");
    const merged = /^Merge pull request #(\d+) from /.exec(subject);
    if (merged) {
      const title = body.split("\n").map((line) => line.trim()).find(Boolean);
      return `- ${clip(title ?? subject)} (#${merged[1]})`;
    }
    return `- ${clip(subject)}`;
  });
  if (lines.length <= MAX_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_LINES), `- and ${lines.length - MAX_LINES} more`].join("\n");
}

/** What the updater reads: https://v2.tauri.app/plugin/updater/#static-json-file */
export function manifest({ version, notes, signature, url, date = new Date() }) {
  if (!parse(version)) throw new Error(`not a version: ${version}`);
  if (!signature.trim()) throw new Error("the signature is empty");
  return {
    version,
    notes: notes ?? "",
    pub_date: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { [PLATFORM]: { signature: signature.trim(), url } },
  };
}

/** A minisign public key as Tauri stores it: base64 of the key file. */
export function readPublicKey(pubkey) {
  const lines = Buffer.from(pubkey.trim(), "base64").toString("utf8").split("\n").filter(Boolean);
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") throw new Error("the updater's public key is not a minisign key");
  return { id: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw.subarray(10)]), format: "der", type: "spki" }) };
}

/** A key id as minisign prints it in the key's comment: its bytes in reverse. */
function keyId(bytes) {
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

/**
 * Whether `signature` (the `.sig` Tauri writes: base64 of a minisign signature file) signs `data` with `pubkey`.
 * Answers why not, or null when it does.
 */
export function signatureProblem(data, signature, pubkey) {
  const { id, key } = readPublicKey(pubkey);
  const lines = Buffer.from(signature.trim(), "base64").toString("utf8").split("\n");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (raw.length !== 74) return "the signature is not a minisign signature";
  const algorithm = raw.subarray(0, 2).toString();
  if (!raw.subarray(2, 10).equals(id)) return `signed by key ${keyId(raw.subarray(2, 10))}, but the app trusts ${keyId(id)}`;
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verifySignature(null, message, key, raw.subarray(10))) return "the signature does not match the file";
  const trusted = (lines[2] ?? "").replace(/^trusted comment: /, "");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (!verifySignature(null, Buffer.concat([raw.subarray(10), Buffer.from(trusted)]), key, global)) return "the signature's trusted comment does not match";
  return null;
}

function option(args, name, fallback) {
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && args[at + 1] !== undefined) return args[at + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function main(args) {
  const [command, ...rest] = args;
  if (command === "version") {
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    return releaseVersion(option(rest, "run"), tags);
  }
  if (command === "notes") {
    const since = option(rest, "since", "");
    const range = since ? [`${since}..HEAD`] : ["HEAD"];
    return changeLines(git("log", "--first-parent", "--format=%s%x1f%b%x1e", ...range)) || "- Maintenance";
  }
  if (command === "manifest") {
    const tarball = option(rest, "tarball");
    const notesFile = option(rest, "notes-file", "");
    return JSON.stringify(manifest({
      version: option(rest, "version"),
      notes: notesFile ? readFileSync(notesFile, "utf8").trim() : "",
      signature: readFileSync(`${tarball}.sig`, "utf8"),
      url: option(rest, "url"),
    }), null, 2);
  }
  if (command === "verify") {
    const tarball = option(rest, "tarball");
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const pubkey = option(rest, "pubkey", config.plugins?.updater?.pubkey ?? "");
    const problem = signatureProblem(readFileSync(tarball), readFileSync(`${tarball}.sig`, "utf8"), pubkey);
    if (problem) throw new Error(`${tarball}: ${problem}`);
    return `${tarball}: signed by the key the app trusts`;
  }
  throw new Error("usage: release.mjs version | notes | manifest | verify (see the top of the file)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`release.mjs: ${error.message}`);
    process.exit(1);
  }
}
