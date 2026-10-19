/**
 * `qd-phone/1`, written from `docs/phone/protocol.md` alone with nothing but `node:crypto`, as the phone will write it.
 *
 * It is a second implementation on purpose: `docs/phone/seal-vectors.json` is generated here and checked against the
 * Mac's own (`src-tauri/src/phone/seal.rs`), so the two can only agree by both following the document. The phone app
 * checks itself against the same file.
 *
 *   node scripts/phone-seal.mjs --write    regenerate docs/phone/seal-vectors.json
 *   pnpm test                              check this implementation against the committed vectors
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const enc = new TextEncoder();
const TRANSCRIPT_LABEL = enc.encode("qd-phone/1 transcript\0");
const KEYS_LABEL = enc.encode("qd-phone/1 keys");
const FRAME_LABEL = enc.encode("qd-phone/1 frame\0");
const PURPOSE = { pair: 1, session: 2 };
const DIRECTION = { "phone-to-mac": 0, "mac-to-phone": 1 };

export const b64 = (bytes) => Buffer.from(bytes).toString("base64");
export const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64"));
export const hex = (bytes) => Buffer.from(bytes).toString("hex");
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const u64 = (n) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(n));
  return new Uint8Array(out);
};

// Raw X25519 keys wrapped in the fixed DER headers node:crypto reads.
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const privateKey = (secret) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(secret)]), format: "der", type: "pkcs8" });
const publicKey = (pub) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: "der", type: "spki" });

/** The public key of a 32-byte X25519 secret. */
export function publicOf(secret) {
  return new Uint8Array(createPublicKey(privateKey(secret)).export({ format: "der", type: "spki" }).subarray(SPKI.length));
}

/** X25519, refusing an agreement that comes out all zeros (a low-order key contributes nothing). */
export function agree(secret, theirs) {
  let shared;
  try {
    shared = new Uint8Array(diffieHellman({ privateKey: privateKey(secret), publicKey: publicKey(theirs) }));
  } catch {
    // OpenSSL itself refuses to derive an all-zero secret.
    throw new Error("weak key");
  }
  if (shared.every((byte) => byte === 0)) throw new Error("weak key");
  return shared;
}

export function transcript({ purpose, invite, phone, mac, phoneEph, macEph, phoneNonce, macNonce }) {
  return concat(TRANSCRIPT_LABEL, [PURPOSE[purpose]], invite ?? new Uint8Array(16), phone, mac, phoneEph, macEph, phoneNonce, macNonce);
}

export function schedule(staticShared, ephemeralShared, psk, transcriptBytes) {
  const transcriptHash = sha256(transcriptBytes);
  const out = new Uint8Array(hkdfSync("sha256", concat(staticShared, ephemeralShared, psk), transcriptHash, KEYS_LABEL, 96));
  return { phoneToMac: out.slice(0, 32), macToPhone: out.slice(32, 64), session: out.slice(64, 96), transcriptHash };
}

const nonceOf = (direction, counter) => concat([DIRECTION[direction], 0, 0, 0], u64(counter));
const aadOf = (session, direction, counter) => concat(FRAME_LABEL, session, [DIRECTION[direction]], u64(counter));

export function sealFrame(key, session, direction, counter, payload) {
  const cipher = createCipheriv("chacha20-poly1305", key, nonceOf(direction, counter), { authTagLength: 16 });
  cipher.setAAD(aadOf(session, direction, counter), { plaintextLength: payload.length });
  return concat(u64(counter), cipher.update(payload), cipher.final(), cipher.getAuthTag());
}

/** The payload, or null when the frame does not open as exactly the counter expected next. */
export function openFrame(key, session, direction, expected, frame) {
  if (frame.length < 8 + 16) return null;
  if (Buffer.from(frame.subarray(0, 8)).readBigUInt64BE() !== BigInt(expected)) return null;
  const sealed = frame.subarray(8, frame.length - 16);
  const decipher = createDecipheriv("chacha20-poly1305", key, nonceOf(direction, expected), { authTagLength: 16 });
  decipher.setAAD(aadOf(session, direction, expected), { plaintextLength: sealed.length });
  decipher.setAuthTag(frame.subarray(frame.length - 16));
  try {
    return concat(decipher.update(sealed), decipher.final());
  } catch {
    return null;
  }
}

/** Fixed, labelled bytes for the vectors, so anyone can see where each one came from. */
const fixed = (label, length = 32) => sha256(enc.encode(`qd-phone/1 vector ${label}`)).slice(0, length);

/** One whole handshake from both sides' secrets, as the document says each side computes it. */
function handshake(purpose, inputs) {
  const phone = publicOf(inputs.phoneSecret);
  const mac = publicOf(inputs.macSecret);
  const phoneEph = publicOf(inputs.phoneEphSecret);
  const macEph = publicOf(inputs.macEphSecret);
  const invite = purpose === "pair" ? inputs.inviteId : null;
  const psk = purpose === "pair" ? inputs.inviteSecret : new Uint8Array(32);
  const hello = { v: 1, type: "hello", purpose, phone: b64(phone), eph: b64(phoneEph), nonce: b64(inputs.phoneNonce), ...(invite ? { invite: b64(invite) } : {}) };
  const staticShared = agree(inputs.macSecret, phone);
  const ephemeralShared = agree(inputs.macEphSecret, phoneEph);
  if (hex(staticShared) !== hex(agree(inputs.phoneSecret, mac)) || hex(ephemeralShared) !== hex(agree(inputs.phoneEphSecret, macEph))) throw new Error("the two sides disagree");
  const transcriptBytes = transcript({ purpose, invite, phone, mac, phoneEph, macEph, phoneNonce: inputs.phoneNonce, macNonce: inputs.macNonce });
  const keys = schedule(staticShared, ephemeralShared, psk, transcriptBytes);
  const confirm = sealFrame(keys.macToPhone, keys.session, "mac-to-phone", 0, keys.transcriptHash);
  const ready = { v: 1, type: "ready", mac: b64(mac), eph: b64(macEph), nonce: b64(inputs.macNonce), confirm: b64(confirm) };
  return {
    purpose,
    psk: b64(psk),
    hello,
    ready,
    transcript: hex(transcriptBytes),
    static_shared: hex(staticShared),
    ephemeral_shared: hex(ephemeralShared),
    keys: { phone_to_mac: hex(keys.phoneToMac), mac_to_phone: hex(keys.macToPhone), session: hex(keys.session), transcript_hash: hex(keys.transcriptHash) },
    raw: keys,
  };
}

export function generate() {
  const inputs = {
    macSecret: fixed("mac static"),
    phoneSecret: fixed("phone static"),
    macEphSecret: fixed("mac ephemeral"),
    phoneEphSecret: fixed("phone ephemeral"),
    macNonce: fixed("mac nonce"),
    phoneNonce: fixed("phone nonce"),
    inviteId: fixed("invite id", 16),
    inviteSecret: fixed("invite secret"),
  };
  const pair = handshake("pair", inputs);
  // A later connection draws new per-connection keys and nonces.
  const session = handshake("session", {
    ...inputs,
    macEphSecret: fixed("mac ephemeral 2"),
    phoneEphSecret: fixed("phone ephemeral 2"),
    macNonce: fixed("mac nonce 2"),
    phoneNonce: fixed("phone nonce 2"),
  });

  // The conversations, in order, as the payloads `docs/phone/protocol.md` defines.
  const conversation = (hs, lines) => {
    const counters = { "phone-to-mac": 0, "mac-to-phone": 1 };
    return lines.map(([direction, payload]) => {
      const key = direction === "phone-to-mac" ? hs.raw.phoneToMac : hs.raw.macToPhone;
      const counter = counters[direction]++;
      return { direction, counter, payload, frame: b64(sealFrame(key, hs.raw.session, direction, counter, enc.encode(payload))) };
    });
  };
  const pairFrames = conversation(pair, [
    ["phone-to-mac", JSON.stringify({ name: "Captain's iPhone" })],
    ["mac-to-phone", JSON.stringify({ paired: true, mac: "Captain's Mac" })],
  ]);
  const sessionFrames = conversation(session, [
    ["phone-to-mac", JSON.stringify({ id: 1, ask: "board" })],
    ["mac-to-phone", JSON.stringify({ id: 1, ok: true, result: { captain_day: "2026-10-11", calls: [], pages: [], crew: { working: 0, waiting: 0, total: 0 } } })],
    ["mac-to-phone", JSON.stringify({ event: "call", call: { id: "qd-a-1", title: "Ship it?", question: "Ship it now or wait?" } })],
    ["phone-to-mac", JSON.stringify({ id: 2, ask: "answer_call", call: "qd-a-1", option: "ship", page: null, note: null })],
  ]);

  const tamper = (frameB64, at) => {
    const bytes = unb64(frameB64);
    bytes[at] ^= 0x01;
    return b64(bytes);
  };
  const first = sessionFrames[0];
  const second = sessionFrames[3];
  const k = session.raw;
  const rejects = [
    { why: "a flipped bit in the sealed payload", direction: "phone-to-mac", expected: 0, frame: tamper(first.frame, 12) },
    { why: "a flipped bit in the tag", direction: "phone-to-mac", expected: 0, frame: tamper(first.frame, unb64(first.frame).length - 1) },
    { why: "a counter changed in the header", direction: "phone-to-mac", expected: 0, frame: tamper(first.frame, 7) },
    { why: "frame 0 replayed when frame 1 is expected", direction: "phone-to-mac", expected: 1, frame: first.frame },
    { why: "frame 1 sent before frame 0", direction: "phone-to-mac", expected: 0, frame: second.frame },
    { why: "the phone's frame reflected back to it as the Mac's", direction: "mac-to-phone", expected: 0, frame: first.frame },
    { why: "a frame from the pairing connection", direction: "phone-to-mac", expected: 0, frame: pairFrames[0].frame },
    { why: "a frame shorter than a counter and a tag", direction: "phone-to-mac", expected: 0, frame: b64(unb64(first.frame).subarray(0, 23)) },
    {
      why: "the right counter sealed under another session's identifier",
      direction: "phone-to-mac",
      expected: 0,
      frame: b64(sealFrame(k.phoneToMac, pair.raw.session, "phone-to-mac", 0, enc.encode(first.payload))),
    },
  ];
  // A key the Mac must refuse to agree with: the identity point, whose agreement is all zeros.
  const weak = { why: "a per-connection key of low order", hello: { ...session.hello, eph: b64(new Uint8Array(32)) } };

  const strip = ({ raw, ...rest }) => rest;
  return {
    protocol: "qd-phone/1",
    about: "Generated by scripts/phone-seal.mjs from docs/phone/protocol.md. The Mac (src-tauri/src/phone/seal.rs) and the phone must both produce and accept exactly these bytes. Never edit by hand.",
    secrets: {
      mac: b64(inputs.macSecret),
      phone: b64(inputs.phoneSecret),
      invite_id: b64(inputs.inviteId),
      invite_secret: b64(inputs.inviteSecret),
      pair: { mac_eph: b64(inputs.macEphSecret), phone_eph: b64(inputs.phoneEphSecret) },
      session: { mac_eph: b64(fixed("mac ephemeral 2")), phone_eph: b64(fixed("phone ephemeral 2")) },
    },
    publics: { mac: b64(publicOf(inputs.macSecret)), phone: b64(publicOf(inputs.phoneSecret)) },
    handshakes: { pair: { ...strip(pair), frames: pairFrames }, session: { ...strip(session), frames: sessionFrames } },
    rejects,
    weak,
  };
}

export const VECTORS = fileURLToPath(new URL("../docs/phone/seal-vectors.json", import.meta.url));

if (process.argv.includes("--write")) {
  writeFileSync(VECTORS, `${JSON.stringify(generate(), null, 2)}\n`);
  console.log(`wrote ${VECTORS}`);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const same = readFileSync(VECTORS, "utf8") === `${JSON.stringify(generate(), null, 2)}\n`;
  console.log(same ? "the committed vectors are what the document produces" : "the committed vectors differ from what the document produces");
  process.exit(same ? 0 : 1);
}
