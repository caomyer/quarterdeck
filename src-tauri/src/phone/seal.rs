//! Sealing between the Mac and a paired phone, `qd-phone/1`, on top of the
//! tailnet's own encryption, so what a call, an answer or a page says never
//! depends on trusting the transport.
//!
//! `docs/phone/protocol.md` is the specification, and
//! `docs/phone/seal-vectors.json` pins this file and the phone's own
//! implementation to it: both must produce and accept exactly those bytes.
//! Change one without the others and the tests here fail.
//!
//! In short: each side holds a static X25519 key, pinned by the other at
//! pairing. Every connection adds a fresh X25519 key and 32 random bytes from
//! each side, so a connection's keys are its own and a recorded one cannot be
//! opened later with the static keys alone. HKDF-SHA256 over both agreements
//! (and, while pairing, the invite's secret) gives one key per direction, and
//! every payload is ChaCha20-Poly1305 under a counter that must go up by one.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub const VERSION: u64 = 1;

const TRANSCRIPT_LABEL: &[u8] = b"qd-phone/1 transcript\0";
const KEYS_LABEL: &[u8] = b"qd-phone/1 keys";
const FRAME_LABEL: &[u8] = b"qd-phone/1 frame\0";
const COUNTER_LEN: usize = 8;
const TAG_LEN: usize = 16;

/// Why a connection or a frame was not accepted. Each one ends the connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    /// A greeting that is not `qd-phone/1`'s, or a field of the wrong shape.
    Malformed(&'static str),
    /// A key agreement with a key that contributes nothing, as a low-order point does.
    WeakKey,
    /// The frame did not open under this connection's key: tampered, replayed,
    /// out of order, sent the wrong way, or sealed by someone else.
    Unopened,
    /// The Mac's confirmation is not for this handshake. Only the phone's side says this.
    #[cfg_attr(not(test), allow(dead_code))]
    Unconfirmed,
    /// A direction has sent every counter it may.
    Exhausted,
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SealError::Malformed(what) => write!(f, "malformed {what}"),
            SealError::WeakKey => write!(f, "a key that contributes nothing"),
            SealError::Unopened => write!(f, "a frame that does not open under this connection's key"),
            SealError::Unconfirmed => write!(f, "a confirmation that is not for this handshake"),
            SealError::Exhausted => write!(f, "every counter has been used"),
        }
    }
}

/// What a connection is for: claiming an invite, or talking as a paired phone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Pair,
    Session,
}

impl Purpose {
    fn byte(self) -> u8 {
        match self {
            Purpose::Pair => 1,
            Purpose::Session => 2,
        }
    }

    #[cfg(test)]
    fn name(self) -> &'static str {
        match self {
            Purpose::Pair => "pair",
            Purpose::Session => "session",
        }
    }
}

/// Which way a frame travels. Each way has its own key and its own counter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    PhoneToMac,
    MacToPhone,
}

impl Direction {
    fn byte(self) -> u8 {
        match self {
            Direction::PhoneToMac => 0,
            Direction::MacToPhone => 1,
        }
    }
}

/// A static or per-connection X25519 secret, kept as the 32 bytes it was made from.
#[derive(Clone)]
pub struct Secret(StaticSecret);

impl Secret {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Secret(StaticSecret::from(bytes))
    }

    /// A new secret from the operating system's random source.
    pub fn generate() -> Result<Self, String> {
        Ok(Secret::from_bytes(random()?))
    }

    pub fn bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn public(&self) -> [u8; 32] {
        PublicKey::from(&self.0).to_bytes()
    }

    fn agree(&self, theirs: &[u8; 32]) -> Result<[u8; 32], SealError> {
        let shared = self.0.diffie_hellman(&PublicKey::from(*theirs));
        if !shared.was_contributory() {
            return Err(SealError::WeakKey);
        }
        Ok(shared.to_bytes())
    }
}

/// `N` bytes from the operating system's random source.
pub fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("no random bytes: {e}"))?;
    Ok(bytes)
}

pub fn encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn decode<const N: usize>(text: &str, what: &'static str) -> Result<[u8; N], SealError> {
    let bytes = B64.decode(text).map_err(|_| SealError::Malformed(what))?;
    bytes.try_into().map_err(|_| SealError::Malformed(what))
}

/// The phone's opening message, sent in the clear: whose key it is, its key and
/// nonce for this connection, and for pairing which invite it claims.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub purpose: Purpose,
    pub phone: [u8; 32],
    pub eph: [u8; 32],
    pub nonce: [u8; 32],
    pub invite: Option<[u8; 16]>,
}

impl Hello {
    #[cfg(test)]
    pub fn to_json(&self) -> Value {
        let mut hello = json!({
            "v": VERSION, "type": "hello", "purpose": self.purpose.name(),
            "phone": encode(&self.phone), "eph": encode(&self.eph), "nonce": encode(&self.nonce),
        });
        if let Some(invite) = self.invite {
            hello["invite"] = json!(encode(&invite));
        }
        hello
    }

    pub fn from_json(value: &Value) -> Result<Hello, SealError> {
        if value["v"] != json!(VERSION) || value["type"] != "hello" {
            return Err(SealError::Malformed("greeting"));
        }
        let text = |key: &'static str| value[key].as_str().ok_or(SealError::Malformed(key));
        let purpose = match text("purpose")? {
            "pair" => Purpose::Pair,
            "session" => Purpose::Session,
            _ => return Err(SealError::Malformed("purpose")),
        };
        let invite = match (purpose, value.get("invite")) {
            (Purpose::Pair, Some(Value::String(invite))) => Some(decode::<16>(invite, "invite")?),
            (Purpose::Session, None) => None,
            _ => return Err(SealError::Malformed("invite")),
        };
        Ok(Hello { purpose, phone: decode(text("phone")?, "phone")?, eph: decode(text("eph")?, "eph")?, nonce: decode(text("nonce")?, "nonce")?, invite })
    }
}

/// The Mac's answer, also in the clear: its key, its key and nonce for this
/// connection, and its first frame, which seals the transcript's hash so the
/// phone knows it reached the Mac it pinned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ready {
    pub mac: [u8; 32],
    pub eph: [u8; 32],
    pub nonce: [u8; 32],
    pub confirm: Vec<u8>,
}

impl Ready {
    pub fn to_json(&self) -> Value {
        json!({
            "v": VERSION, "type": "ready",
            "mac": encode(&self.mac), "eph": encode(&self.eph), "nonce": encode(&self.nonce), "confirm": encode(&self.confirm),
        })
    }

    #[cfg(test)]
    pub fn from_json(value: &Value) -> Result<Ready, SealError> {
        if value["v"] != json!(VERSION) || value["type"] != "ready" {
            return Err(SealError::Malformed("answer"));
        }
        let text = |key: &'static str| value[key].as_str().ok_or(SealError::Malformed(key));
        let confirm = B64.decode(text("confirm")?).map_err(|_| SealError::Malformed("confirm"))?;
        Ok(Ready { mac: decode(text("mac")?, "mac")?, eph: decode(text("eph")?, "eph")?, nonce: decode(text("nonce")?, "nonce")?, confirm })
    }
}

/// The Mac turning a connection away before any key is agreed, with why.
pub fn refused(reason: &str) -> Value {
    json!({"v": VERSION, "type": "refused", "reason": reason})
}

/// Every byte both sides agreed on, in a fixed order.
pub fn transcript(hello: &Hello, mac: &[u8; 32], mac_eph: &[u8; 32], mac_nonce: &[u8; 32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(TRANSCRIPT_LABEL.len() + 1 + 16 + 32 * 6);
    bytes.extend_from_slice(TRANSCRIPT_LABEL);
    bytes.push(hello.purpose.byte());
    bytes.extend_from_slice(&hello.invite.unwrap_or([0; 16]));
    for part in [&hello.phone, mac, &hello.eph, mac_eph, &hello.nonce, mac_nonce] {
        bytes.extend_from_slice(part);
    }
    bytes
}

/// One connection's keys, and the hash of the handshake that made them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keys {
    pub phone_to_mac: [u8; 32],
    pub mac_to_phone: [u8; 32],
    pub session: [u8; 32],
    pub transcript_hash: [u8; 32],
}

/// The key schedule: HKDF-SHA256, salted with the transcript's hash, over the
/// static agreement, the per-connection one and the invite's secret (zeros
/// outside pairing).
pub fn schedule(static_shared: &[u8; 32], ephemeral_shared: &[u8; 32], psk: &[u8; 32], transcript: &[u8]) -> Keys {
    let transcript_hash: [u8; 32] = Sha256::digest(transcript).into();
    let mut ikm = Vec::with_capacity(96);
    ikm.extend_from_slice(static_shared);
    ikm.extend_from_slice(ephemeral_shared);
    ikm.extend_from_slice(psk);
    let mut out = [0u8; 96];
    Hkdf::<Sha256>::new(Some(&transcript_hash), &ikm).expand(KEYS_LABEL, &mut out).expect("96 bytes is a valid HKDF-SHA256 length");
    let part = |at: usize| -> [u8; 32] { out[at..at + 32].try_into().expect("32 bytes") };
    Keys { phone_to_mac: part(0), mac_to_phone: part(32), session: part(64), transcript_hash }
}

fn nonce(direction: Direction, counter: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[0] = direction.byte();
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn aad(session: &[u8; 32], direction: Direction, counter: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(FRAME_LABEL.len() + 32 + 1 + COUNTER_LEN);
    aad.extend_from_slice(FRAME_LABEL);
    aad.extend_from_slice(session);
    aad.push(direction.byte());
    aad.extend_from_slice(&counter.to_be_bytes());
    aad
}

/// One frame: the counter, big-endian, then the sealed payload and its tag.
pub fn seal_frame(key: &[u8; 32], session: &[u8; 32], direction: Direction, counter: u64, payload: &[u8]) -> Vec<u8> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce(direction, counter)), Payload { msg: payload, aad: &aad(session, direction, counter) })
        .expect("ChaCha20-Poly1305 seals any payload that fits in memory");
    let mut frame = Vec::with_capacity(COUNTER_LEN + sealed.len());
    frame.extend_from_slice(&counter.to_be_bytes());
    frame.extend_from_slice(&sealed);
    frame
}

/// Opens a frame only if it carries exactly the counter expected next.
pub fn open_frame(key: &[u8; 32], session: &[u8; 32], direction: Direction, expected: u64, frame: &[u8]) -> Result<Vec<u8>, SealError> {
    if frame.len() < COUNTER_LEN + TAG_LEN {
        return Err(SealError::Unopened);
    }
    let (counter, sealed) = frame.split_at(COUNTER_LEN);
    if u64::from_be_bytes(counter.try_into().expect("8 bytes")) != expected {
        return Err(SealError::Unopened);
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&nonce(direction, expected)), Payload { msg: sealed, aad: &aad(session, direction, expected) })
        .map_err(|_| SealError::Unopened)
}

/// One end of a sealed connection: what it seals goes one way and what it opens
/// comes the other, each under its own counter.
#[derive(Debug)]
pub struct Channel {
    keys: Keys,
    sends: Direction,
    sent: u64,
    opened: u64,
}

impl Channel {
    fn new(keys: Keys, sends: Direction, sent: u64) -> Self {
        Channel { keys, sends, sent, opened: 0 }
    }

    #[cfg(test)]
    pub fn keys(&self) -> &Keys {
        &self.keys
    }

    fn receives(&self) -> Direction {
        match self.sends {
            Direction::PhoneToMac => Direction::MacToPhone,
            Direction::MacToPhone => Direction::PhoneToMac,
        }
    }

    fn key_for(&self, direction: Direction) -> &[u8; 32] {
        match direction {
            Direction::PhoneToMac => &self.keys.phone_to_mac,
            Direction::MacToPhone => &self.keys.mac_to_phone,
        }
    }

    pub fn seal(&mut self, payload: &[u8]) -> Result<Vec<u8>, SealError> {
        if self.sent == u64::MAX {
            return Err(SealError::Exhausted);
        }
        let frame = seal_frame(self.key_for(self.sends), &self.keys.session, self.sends, self.sent, payload);
        self.sent += 1;
        Ok(frame)
    }

    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, SealError> {
        if self.opened == u64::MAX {
            return Err(SealError::Exhausted);
        }
        let direction = self.receives();
        let payload = open_frame(self.key_for(direction), &self.keys.session, direction, self.opened, frame)?;
        self.opened += 1;
        Ok(payload)
    }
}

/// The Mac's side of a handshake: agrees both keys, seals its confirmation as
/// its frame 0, and returns its answer with the channel, whose next frame is 1.
/// `psk` is the invite's secret when pairing and zeros otherwise; the caller
/// decides whether this phone may connect at all before calling.
pub fn respond(mac: &Secret, hello: &Hello, psk: &[u8; 32], eph: &Secret, nonce: [u8; 32]) -> Result<(Ready, Channel), SealError> {
    let static_shared = mac.agree(&hello.phone)?;
    let ephemeral_shared = eph.agree(&hello.eph)?;
    let keys = schedule(&static_shared, &ephemeral_shared, psk, &transcript(hello, &mac.public(), &eph.public(), &nonce));
    let confirm = seal_frame(&keys.mac_to_phone, &keys.session, Direction::MacToPhone, 0, &keys.transcript_hash);
    let ready = Ready { mac: mac.public(), eph: eph.public(), nonce, confirm };
    Ok((ready, Channel::new(keys, Direction::MacToPhone, 1)))
}

/// The phone's side of a handshake, here for the test client and the vectors:
/// the phone app implements the same thing in its own language.
#[cfg(test)]
pub struct Initiator {
    phone: Secret,
    eph: Secret,
    expected_mac: [u8; 32],
    hello: Hello,
}

#[cfg(test)]
impl Initiator {
    pub fn new(phone: Secret, eph: Secret, nonce: [u8; 32], expected_mac: [u8; 32], purpose: Purpose, invite: Option<[u8; 16]>) -> Self {
        let hello = Hello { purpose, phone: phone.public(), eph: eph.public(), nonce, invite };
        Initiator { phone, eph, expected_mac, hello }
    }

    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    /// Accepts the Mac's answer only from the Mac this phone pinned, and only
    /// with a confirmation that seals this very handshake.
    pub fn accept(self, ready: &Ready, psk: &[u8; 32]) -> Result<Channel, SealError> {
        if ready.mac != self.expected_mac {
            return Err(SealError::Unconfirmed);
        }
        let static_shared = self.phone.agree(&ready.mac)?;
        let ephemeral_shared = self.eph.agree(&ready.eph)?;
        let keys = schedule(&static_shared, &ephemeral_shared, psk, &transcript(&self.hello, &ready.mac, &ready.eph, &ready.nonce));
        let confirmed = open_frame(&keys.mac_to_phone, &keys.session, Direction::MacToPhone, 0, &ready.confirm).map_err(|_| SealError::Unconfirmed)?;
        if confirmed != keys.transcript_hash {
            return Err(SealError::Unconfirmed);
        }
        let mut channel = Channel::new(keys, Direction::PhoneToMac, 0);
        channel.opened = 1;
        Ok(channel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../../docs/phone/seal-vectors.json");

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).expect("the vectors are JSON")
    }

    fn secret(text: &Value) -> Secret {
        Secret::from_bytes(decode(text.as_str().unwrap(), "secret").unwrap())
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn direction(text: &Value) -> Direction {
        match text.as_str().unwrap() {
            "phone-to-mac" => Direction::PhoneToMac,
            "mac-to-phone" => Direction::MacToPhone,
            other => panic!("no direction {other}"),
        }
    }

    /// The Mac answers each vector's greeting with exactly the vector's answer,
    /// from the same secrets, and agrees exactly the vector's keys.
    #[test]
    fn the_mac_answers_every_handshake_byte_for_byte() {
        let v = vectors();
        let mac = secret(&v["secrets"]["mac"]);
        assert_eq!(encode(&mac.public()), v["publics"]["mac"]);
        for name in ["pair", "session"] {
            let hs = &v["handshakes"][name];
            let hello = Hello::from_json(&hs["hello"]).expect(name);
            assert_eq!(hello.to_json(), hs["hello"], "{name}: the greeting reads back as itself");
            let psk: [u8; 32] = decode(hs["psk"].as_str().unwrap(), "psk").unwrap();
            let nonce = Ready::from_json(&hs["ready"]).unwrap().nonce;
            let (ready, channel) = respond(&mac, &hello, &psk, &secret(&v["secrets"][name]["mac_eph"]), nonce).expect(name);
            assert_eq!(ready.to_json(), hs["ready"], "{name}: the answer");
            let keys = channel.keys();
            assert_eq!(hex(&keys.phone_to_mac), hs["keys"]["phone_to_mac"], "{name}");
            assert_eq!(hex(&keys.mac_to_phone), hs["keys"]["mac_to_phone"], "{name}");
            assert_eq!(hex(&keys.session), hs["keys"]["session"], "{name}");
            assert_eq!(hex(&keys.transcript_hash), hs["keys"]["transcript_hash"], "{name}");
            let transcript = transcript(&hello, &ready.mac, &ready.eph, &ready.nonce);
            assert_eq!(hex(&transcript), hs["transcript"], "{name}");
        }
    }

    /// The phone's side, as the test client runs it, accepts the vector's
    /// answer and then both channels seal and open the vector's frames.
    #[test]
    fn both_ends_seal_and_open_every_frame_in_order() {
        let v = vectors();
        let mac = secret(&v["secrets"]["mac"]);
        for name in ["pair", "session"] {
            let hs = &v["handshakes"][name];
            let hello = Hello::from_json(&hs["hello"]).unwrap();
            let psk: [u8; 32] = decode(hs["psk"].as_str().unwrap(), "psk").unwrap();
            let ready = Ready::from_json(&hs["ready"]).unwrap();
            let (_, mut mac_end) = respond(&mac, &hello, &psk, &secret(&v["secrets"][name]["mac_eph"]), ready.nonce).unwrap();
            let phone = Initiator::new(secret(&v["secrets"]["phone"]), secret(&v["secrets"][name]["phone_eph"]), hello.nonce, mac.public(), hello.purpose, hello.invite);
            assert_eq!(phone.hello(), &hello);
            let mut phone_end = phone.accept(&ready, &psk).expect("the phone accepts its Mac");
            for frame in hs["frames"].as_array().unwrap() {
                let payload = frame["payload"].as_str().unwrap().as_bytes();
                let wire = B64.decode(frame["frame"].as_str().unwrap()).unwrap();
                let (sender, receiver) = match direction(&frame["direction"]) {
                    Direction::PhoneToMac => (&mut phone_end, &mut mac_end),
                    Direction::MacToPhone => (&mut mac_end, &mut phone_end),
                };
                assert_eq!(sender.seal(payload).unwrap(), wire, "{name} {frame}");
                assert_eq!(receiver.open(&wire).unwrap(), payload, "{name} {frame}");
            }
        }
    }

    #[test]
    fn nothing_tampered_replayed_reordered_reflected_or_borrowed_opens() {
        let v = vectors();
        let hs = &v["handshakes"]["session"];
        let key = |dir: Direction| -> [u8; 32] {
            let name = if dir == Direction::PhoneToMac { "phone_to_mac" } else { "mac_to_phone" };
            let text = hs["keys"][name].as_str().unwrap();
            (0..32).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap()).collect::<Vec<_>>().try_into().unwrap()
        };
        let session: [u8; 32] = {
            let text = hs["keys"]["session"].as_str().unwrap();
            (0..32).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap()).collect::<Vec<_>>().try_into().unwrap()
        };
        for reject in v["rejects"].as_array().unwrap() {
            let dir = direction(&reject["direction"]);
            let frame = B64.decode(reject["frame"].as_str().unwrap()).unwrap();
            let opened = open_frame(&key(dir), &session, dir, reject["expected"].as_u64().unwrap(), &frame);
            assert_eq!(opened, Err(SealError::Unopened), "{}", reject["why"]);
        }
    }

    #[test]
    fn a_key_of_low_order_is_refused() {
        let v = vectors();
        let hello = Hello::from_json(&v["weak"]["hello"]).unwrap();
        let mac = secret(&v["secrets"]["mac"]);
        let refused = respond(&mac, &hello, &[0; 32], &secret(&v["secrets"]["session"]["mac_eph"]), [0; 32]);
        assert_eq!(refused.unwrap_err(), SealError::WeakKey);
    }

    /// A phone that pinned another Mac, or an answer whose confirmation is not
    /// for this handshake, never gets a channel.
    #[test]
    fn the_phone_accepts_only_the_mac_it_pinned() {
        let v = vectors();
        let hs = &v["handshakes"]["session"];
        let hello = Hello::from_json(&hs["hello"]).unwrap();
        let ready = Ready::from_json(&hs["ready"]).unwrap();
        let phone = |pinned: [u8; 32]| Initiator::new(secret(&v["secrets"]["phone"]), secret(&v["secrets"]["session"]["phone_eph"]), hello.nonce, pinned, Purpose::Session, None);
        let other_mac = Secret::from_bytes([7; 32]).public();
        assert_eq!(phone(other_mac).accept(&ready, &[0; 32]).unwrap_err(), SealError::Unconfirmed);
        // The pinned Mac's key in the answer, but agreed by a Mac that does not hold its secret.
        let impostor = Secret::from_bytes([9; 32]);
        let (mut forged, _) = respond(&impostor, &hello, &[0; 32], &secret(&v["secrets"]["session"]["mac_eph"]), ready.nonce).unwrap();
        forged.mac = ready.mac;
        assert_eq!(phone(ready.mac).accept(&forged, &[0; 32]).unwrap_err(), SealError::Unconfirmed);
        // Pairing without the invite's secret does not confirm either.
        let pair = &v["handshakes"]["pair"];
        let pair_hello = Hello::from_json(&pair["hello"]).unwrap();
        let pair_ready = Ready::from_json(&pair["ready"]).unwrap();
        let claimant = Initiator::new(secret(&v["secrets"]["phone"]), secret(&v["secrets"]["pair"]["phone_eph"]), pair_hello.nonce, ready.mac, Purpose::Pair, pair_hello.invite);
        assert_eq!(claimant.accept(&pair_ready, &[0; 32]).unwrap_err(), SealError::Unconfirmed);
    }

    #[test]
    fn a_greeting_of_the_wrong_shape_is_malformed() {
        let v = vectors();
        let good = v["handshakes"]["pair"]["hello"].clone();
        let mut cases = Vec::new();
        for (key, value) in [("v", json!(2)), ("type", json!("ready")), ("purpose", json!("start")), ("phone", json!("short")), ("invite", Value::Null)] {
            let mut bad = good.clone();
            bad[key] = value;
            cases.push(bad);
        }
        let mut session_with_invite = v["handshakes"]["session"]["hello"].clone();
        session_with_invite["invite"] = good["invite"].clone();
        cases.push(session_with_invite);
        for bad in cases {
            assert!(matches!(Hello::from_json(&bad), Err(SealError::Malformed(_))), "{bad}");
        }
    }
}
