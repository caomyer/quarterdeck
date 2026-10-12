/**
 * A phone, written in JavaScript from `docs/phone/protocol.md` and `scripts/phone-seal.mjs` alone, as the phone app
 * will be: it pairs with the Mac whose invite it is given, opens a session and asks for what the four journeys need.
 * The Mac's tests run it against the real link over a real socket (`src-tauri/src/phone/tests.rs`), so the two
 * implementations are proven to talk, not only to agree on paper.
 *
 *   node scripts/phone-client.mjs <invite.json>
 *
 * Prints one JSON object saying what happened at each step.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { agree, b64, openFrame, publicOf, schedule, sealFrame, transcript, unb64 } from "./phone-seal.mjs";

const offer = JSON.parse(readFileSync(process.argv[2], "utf8"));
const enc = new TextEncoder();
const dec = new TextDecoder();
const WAIT = 10_000;

/** A socket whose messages can be awaited one at a time. */
function open(url) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const queue = [];
  const waiting = [];
  const push = (item) => (waiting.length ? waiting.shift()(item) : queue.push(item));
  socket.onmessage = (event) => push({ data: event.data });
  socket.onclose = () => push({ closed: true });
  socket.onerror = () => push({ closed: true });
  const next = () => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => reject(new Error("the Mac said nothing")), WAIT);
    waiting.push((item) => { clearTimeout(timer); resolve(item); });
  });
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve({ socket, next });
    setTimeout(() => reject(new Error("could not reach the Mac")), WAIT);
  });
}

/** Greets the Mac and accepts it only if it is the one the invite pinned. Returns a sealed channel. */
async function connect(phoneSecret, purpose) {
  const { socket, next } = await open(`ws://${offer.addresses[0]}${offer.path}`);
  const ephSecret = new Uint8Array(randomBytes(32));
  const nonce = new Uint8Array(randomBytes(32));
  const phone = publicOf(phoneSecret);
  const invite = purpose === "pair" ? unb64(offer.invite) : null;
  socket.send(JSON.stringify({ v: 1, type: "hello", purpose, phone: b64(phone), eph: b64(publicOf(ephSecret)), nonce: b64(nonce), ...(invite ? { invite: b64(invite) } : {}) }));
  const answer = await next();
  if (answer.closed) throw new Error("the Mac closed without answering");
  const ready = JSON.parse(answer.data);
  if (ready.type === "refused") return { refused: ready.reason };
  if (ready.mac !== offer.mac) throw new Error("not the Mac this phone pinned");
  const mac = unb64(ready.mac);
  const keys = schedule(
    agree(phoneSecret, mac),
    agree(ephSecret, unb64(ready.eph)),
    purpose === "pair" ? unb64(offer.secret) : new Uint8Array(32),
    transcript({ purpose, invite, phone, mac, phoneEph: publicOf(ephSecret), macEph: unb64(ready.eph), phoneNonce: nonce, macNonce: unb64(ready.nonce) }),
  );
  const confirmed = openFrame(keys.macToPhone, keys.session, "mac-to-phone", 0, unb64(ready.confirm));
  if (!confirmed || b64(confirmed) !== b64(keys.transcriptHash)) throw new Error("the Mac's confirmation is not for this handshake");
  let sent = 0;
  let opened = 1;
  const send = (value) => socket.send(sealFrame(keys.phoneToMac, keys.session, "phone-to-mac", sent++, enc.encode(JSON.stringify(value))));
  const receive = async () => {
    const got = await next();
    if (got.closed) return null;
    const payload = openFrame(keys.macToPhone, keys.session, "mac-to-phone", opened++, new Uint8Array(got.data));
    if (!payload) throw new Error("a frame from the Mac did not open");
    return JSON.parse(dec.decode(payload));
  };
  let id = 0;
  const ask = async (request) => {
    const asked = ++id;
    send({ id: asked, ...request });
    for (;;) {
      const got = await receive();
      if (got === null || got.id === asked) return got;
    }
  };
  /** A frame sealed as if it came later than it does: the Mac must not open it. */
  const sendOutOfOrder = (value) => socket.send(sealFrame(keys.phoneToMac, keys.session, "phone-to-mac", sent + 5, enc.encode(JSON.stringify(value))));
  return { send, receive, ask, sendOutOfOrder, close: () => socket.close() };
}

const result = {};
const phoneSecret = new Uint8Array(randomBytes(32));
result.phone = b64(publicOf(phoneSecret));

const pairing = await connect(phoneSecret, "pair");
pairing.send({ name: "A phone written in JavaScript" });
result.paired = await pairing.receive();

const session = await connect(phoneSecret, "session");
const board = await session.ask({ ask: "board" });
result.board = { ok: board.ok, calls: board.result.calls.map((call) => call.id), pages: board.result.pages.map((page) => page.name) };
const page = board.result.pages[0];
const entry = await session.ask({ ask: "page", page: { scope: page.scope, task: page.task, name: page.name }, rev: page.latest.rev });
result.page = { ok: entry.ok, file: entry.result?.file, text: dec.decode(unb64(entry.result?.body ?? "")) };
const said = await session.ask({ ask: "say", text: "Hello from a phone written in JavaScript." });
result.said = said;
const refused = await session.ask({ ask: "start_work", task: "anything" });
result.refused = refused;
session.sendOutOfOrder({ id: 99, ask: "board" });
result.out_of_order = await session.receive();
session.close();

const stranger = await connect(new Uint8Array(randomBytes(32)), "session");
result.stranger = stranger.refused ?? "accepted";

console.log(JSON.stringify(result));
process.exit(0);
