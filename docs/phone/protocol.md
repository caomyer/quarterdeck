# qd-phone/1: the phone link

How the captain's phone talks to Quarterdeck on his Mac.
The Mac half is `src-tauri/src/phone/`; this document is what the phone is written against.
Two files pin both halves to it:

- `seal-vectors.json` holds fixed keys, handshakes and frames, and frames that must be refused.
  `scripts/phone-seal.mjs` generates it from this document with nothing but `node:crypto`, the Mac's own tests (`seal.rs`) must reproduce it byte for byte, and the phone must too.
  Never edit it by hand: change this document and the generator, then the Mac.
- `requests.json` records every request the phone may make and what the Mac answered, inside the sealed channel, against a fixture home.

## Shape

The phone and the Mac sit on the captain's own Tailscale network.
No service of ours runs anywhere.
The Mac listens only on its tailnet address (IPv4 in 100.64.0.0/10), port 47319 unless the invite names another, and only while a phone is paired or an invite is showing.
The connection is a WebSocket at `ws://<address>/qd-phone/1`.
The tailnet already encrypts it; every payload is sealed again with keys pinned at pairing, so nothing depends on trusting the transport.

A phone does four things: it learns a call needs the captain, answers it, reads the page that argues it and sends a review, and has a word with the first mate.
It can ask for nothing else, and nothing it can ask starts, stops or takes over the first mate, so it can never become a second host.

All binary values in JSON are standard base64 with padding.

## Pairing starts on the Mac

Settings shows a QR whose text is this JSON:

```json
{"v": 1, "type": "qd-phone-invite", "mac": "<Mac public key>", "name": "<Mac name>",
 "invite": "<16 bytes>", "secret": "<32 bytes>", "addresses": ["100.x.y.z:47319"],
 "path": "/qd-phone/1", "expires": <unix ms>}
```

The invite lapses at `expires`, ten minutes after it was shown, and is spent by the first phone that claims it.
Showing a new one voids the old.
The phone pins `mac` from the QR and never accepts any other key for this Mac.

## Keys

Each side has a static X25519 key: the Mac's is in the QR, and the phone's is pinned by the Mac when the phone pairs.
Every connection also draws a fresh X25519 key and 32 random bytes on each side.
An agreement that comes out all zeros (a low-order key) is refused.

## Greeting

The phone opens with one text message:

```json
{"v": 1, "type": "hello", "purpose": "pair" | "session",
 "phone": "<phone public key>", "eph": "<phone per-connection key>", "nonce": "<32 bytes>",
 "invite": "<16 bytes, pairing only>"}
```

The Mac answers with one text message, either

```json
{"v": 1, "type": "ready", "mac": "<Mac public key>", "eph": "<Mac per-connection key>", "nonce": "<32 bytes>", "confirm": "<frame>"}
```

or `{"v": 1, "type": "refused", "reason": "<words for the captain>"}` and a close.
A session is refused when the phone is not paired (or has been revoked); pairing is refused when the invite has lapsed, been spent, or is not the one showing.

## Key schedule

```
transcript = "qd-phone/1 transcript\0" || purpose (1 = pair, 2 = session)
           || invite (16 bytes; zeros for a session)
           || phone || mac || phone eph || mac eph || phone nonce || mac nonce
th         = SHA-256(transcript)
ss         = X25519(phone static, mac static)
ee         = X25519(phone eph, mac eph)
psk        = invite secret when pairing, 32 zero bytes otherwise
okm        = HKDF-SHA256(salt = th, ikm = ss || ee || psk, info = "qd-phone/1 keys", 96 bytes)
phone-to-mac key = okm[0..32], mac-to-phone key = okm[32..64], session = okm[64..96]
```

`confirm` is the Mac's frame 0, whose payload is `th`.
The phone accepts the Mac only if `mac` is the key it pinned and `confirm` opens to `th`: only the Mac holding that key, and while pairing the invite's secret, can produce it.
The Mac learns the phone holds its key, and the invite's secret, when the phone's frame 0 opens.

## Frames

After the greeting every message is binary, one frame each:

```
frame = counter (8 bytes, big-endian) || ChaCha20-Poly1305(key, nonce, aad, payload)
nonce = direction (0 phone-to-mac, 1 mac-to-phone) || 0x000000 || counter (8 bytes, big-endian)
aad   = "qd-phone/1 frame\0" || session || direction || counter (8 bytes, big-endian)
```

Each direction counts from 0 on its own key: the phone's first frame is 0, and the Mac's first after `confirm` is 1.
A frame is accepted only with exactly the next counter, so a replayed, reordered, reflected or tampered frame does not open, and either side closes the connection when one does not.
Payloads are UTF-8 JSON.

## Pairing

After `ready`, the phone sends `{"name": "<what the phone calls itself>"}` as frame 0.
The Mac pairs the phone's key under that name, spends the invite, answers `{"paired": true, "mac": "<Mac name>"}` (or `{"paired": false, "problem": "..."}`) and closes.
The phone then opens a session.

## Session

A session begins when the phone's frame 0, its first request, opens: until then the Mac neither counts the phone as connected nor notes it as seen, and sends it no events.
A phone that sends no frame within 30 seconds of `ready` is closed.

A request is `{"id": <number the phone picks>, "ask": "<kind>", ...fields}`.
Its answer is `{"id": n, "ok": true, "result": ...}` or `{"id": n, "ok": false, "problem": "<words for the captain>"}`.
Answers may arrive in any order.
A request with a field its kind does not have, or a kind not listed here, is refused.

| ask | fields | what it does |
| --- | --- | --- |
| `board` | | Every call the fleet carries, the presented pages, and the crew as a glance (`id`, `project`, `kind`, `state`). |
| `answer_call` | `call`, `option`, `page`?, `note`? | The desktop's own answer: firstmate's intake records it, the first mate is told only once it has. `recorded` is true only when the intake said so. |
| `reply_to_call` | `call`, `words` | The captain's words kept on the call through firstmate, then the first mate is told. |
| `page` | `page`, `rev`, `file`? | One file of a presented revision (its entry page when no file is named), base64 in `body`, with its `content_type`. |
| `review` | `page` | The page's review, as the desktop's review screen reads it. |
| `comment` | `page`, `rev`, `body`, `anchor`?, `thread`? | A draft comment, kept until the review is sent. |
| `discard` | `page`, `thread` | Takes back a draft comment. |
| `send_review` | `page`, `rev`, `verdict` (`approve`, `changes`, `comment`) | The desktop's Send review. |
| `chat` | `limit`? (1 to 200, 40 by default) | The recent conversation: the captain's words and the first mate's. |
| `say` | `text` | A message to the first mate. A reply to a place in the chat carries the block `src/replyto.ts` writes, before the captain's words. Words starting with `/` are a command for the first mate's session and are refused: those come only from the Mac. |

`page` is `{"scope": "task", "task": "<task id>", "name": "<page>"}` or `{"scope": "chat", "name": "<page>"}`.

A page is fetched through this link and drawn by the phone in a sealed web view.
Nothing serves pages on a network.

The Mac also sends events between answers.
`{"event": "call", "call": {"id", "title", "question"}}` says a call has come to need the captain since the Mac last read the fleet.

The Mac sends a WebSocket ping every 30 seconds while a session is open.
When nothing at all has arrived from the phone for 90 seconds, not a request and not a pong, the Mac ends the session.
A WebSocket client answers pings by itself, so a phone only has to keep reading its socket.
A phone that slept or lost its network simply opens a new session.

## Revoke

Revoking a phone in Settings forgets its key and closes its connections before Settings answers.
Its next greeting is refused, and no event reaches it again.
A request it sent that the Mac has not finished is dropped where it stands and not answered.
Pairing it again needs a new invite.
