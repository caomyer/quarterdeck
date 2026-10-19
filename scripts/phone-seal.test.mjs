/**
 * The phone's half of `qd-phone/1`, as `scripts/phone-seal.mjs` writes it from `docs/phone/protocol.md`, against the
 * vectors the Mac's own implementation is held to (`src-tauri/src/phone/seal.rs`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VECTORS, agree, b64, generate, hex, openFrame, publicOf, unb64 } from "./phone-seal.mjs";

const vectors = JSON.parse(readFileSync(VECTORS, "utf8"));
const bytes = (text) => new Uint8Array(Buffer.from(text, "hex"));
const keysOf = (handshake) => ({
  "phone-to-mac": bytes(handshake.keys.phone_to_mac),
  "mac-to-phone": bytes(handshake.keys.mac_to_phone),
  session: bytes(handshake.keys.session),
});

test("the committed vectors are exactly what the document produces", () => {
  assert.equal(readFileSync(VECTORS, "utf8"), `${JSON.stringify(generate(), null, 2)}\n`);
});

test("every frame opens, in order, to its payload", () => {
  for (const [name, handshake] of Object.entries(vectors.handshakes)) {
    const keys = keysOf(handshake);
    const confirm = openFrame(keys["mac-to-phone"], keys.session, "mac-to-phone", 0, unb64(handshake.ready.confirm));
    assert.equal(hex(confirm), handshake.keys.transcript_hash, `${name}: the Mac's confirmation seals the transcript's hash`);
    for (const frame of handshake.frames) {
      const payload = openFrame(keys[frame.direction], keys.session, frame.direction, frame.counter, unb64(frame.frame));
      assert.equal(new TextDecoder().decode(payload), frame.payload, `${name} ${frame.direction} ${frame.counter}`);
    }
  }
});

test("nothing tampered, replayed, reordered, reflected or borrowed opens", () => {
  const keys = keysOf(vectors.handshakes.session);
  for (const reject of vectors.rejects) {
    assert.equal(openFrame(keys[reject.direction], keys.session, reject.direction, reject.expected, unb64(reject.frame)), null, reject.why);
  }
});

test("a key of low order is refused rather than agreed with", () => {
  assert.throws(() => agree(unb64(vectors.secrets.session.mac_eph), unb64(vectors.weak.hello.eph)), /weak key/);
});

test("the public keys are the secrets' own", () => {
  assert.equal(b64(publicOf(unb64(vectors.secrets.mac))), vectors.publics.mac);
  assert.equal(b64(publicOf(unb64(vectors.secrets.phone))), vectors.publics.phone);
  assert.equal(vectors.handshakes.pair.hello.phone, vectors.publics.phone);
  assert.equal(vectors.handshakes.session.ready.mac, vectors.publics.mac);
});
