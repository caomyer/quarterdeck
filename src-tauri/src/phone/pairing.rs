//! Which phones this Mac is paired with, and the one invite it may be showing.
//!
//! Kept in the app's own folder, never in a firstmate home: `phone/mac.key`
//! holds the Mac's secret and `phone/phones.json` each paired phone's public
//! key, name, and when it was paired and last seen, both readable only by the
//! captain. An invite lives only in memory: it lapses after
//! [`INVITE_LIFETIME`], is spent by the first phone that claims it, and is
//! gone if the app quits.

use super::seal::{self, Secret};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const INVITE_LIFETIME: Duration = Duration::from_secs(10 * 60);
/// The port the Mac listens on, on its tailnet address only.
pub const DEFAULT_PORT: u16 = 47319;
/// Last seen is written at most this often; it is shown to the minute.
const SEEN_EVERY_MS: u64 = 60_000;
const NAME_LIMIT: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phone {
    /// A short fingerprint of its key, which is how the screen and Revoke name it.
    pub id: String,
    pub key: [u8; 32],
    pub name: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
}

impl Phone {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "paired_at": self.paired_at, "last_seen": self.last_seen})
    }
}

#[derive(Clone, Debug)]
pub struct Invite {
    pub id: [u8; 16],
    pub secret: [u8; 32],
    pub expires_at: u64,
}

pub fn fingerprint(key: &[u8; 32]) -> String {
    Sha256::digest(key)[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The name a phone gives itself, made safe to show.
fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(NAME_LIMIT).collect();
    if name.is_empty() { "A phone".to_string() } else { name }
}

pub struct Registry {
    dir: PathBuf,
    mac: Secret,
    port: u16,
    phones: Vec<Phone>,
    invite: Option<Invite>,
    seen_written: std::collections::HashMap<String, u64>,
}

/// Written beside the file and renamed over it, readable only by the captain.
fn write_private(path: &Path, body: &str) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    file.write_all(body.as_bytes()).map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    file.sync_all().map_err(|e| format!("could not save {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|e| format!("could not save {}: {e}", path.display()))
}

impl Registry {
    /// Opens the folder, making the Mac's key the first time. A key that exists
    /// but cannot be read is an error, never replaced: every paired phone pinned
    /// it, and a new one would unpair them all without a word.
    pub fn open(dir: &Path) -> Result<Registry, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        let key_file = dir.join("mac.key");
        let mac = match std::fs::read_to_string(&key_file) {
            Ok(text) => {
                let value: Value = serde_json::from_str(&text).map_err(|_| format!("{} cannot be read, so no phone can reach this Mac", key_file.display()))?;
                let secret = value["secret"].as_str().and_then(|secret| seal::decode::<32>(secret, "secret").ok());
                Secret::from_bytes(secret.ok_or_else(|| format!("{} cannot be read, so no phone can reach this Mac", key_file.display()))?)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mac = Secret::generate()?;
                write_private(&key_file, &json!({"v": 1, "secret": seal::encode(&mac.bytes())}).to_string())?;
                mac
            }
            Err(e) => return Err(format!("{} cannot be read, so no phone can reach this Mac: {e}", key_file.display())),
        };
        let list = dir.join("phones.json");
        let (port, phones) = match std::fs::read_to_string(&list) {
            Ok(text) => {
                let value: Value = serde_json::from_str(&text).map_err(|_| format!("{} cannot be read", list.display()))?;
                let port = value["port"].as_u64().and_then(|port| u16::try_from(port).ok()).unwrap_or(DEFAULT_PORT);
                let phones = value["phones"]
                    .as_array()
                    .map(|phones| {
                        phones
                            .iter()
                            .filter_map(|phone| {
                                let key = seal::decode::<32>(phone["key"].as_str()?, "key").ok()?;
                                Some(Phone {
                                    id: fingerprint(&key),
                                    key,
                                    name: clean_name(phone["name"].as_str().unwrap_or_default()),
                                    paired_at: phone["paired_at"].as_u64().unwrap_or(0),
                                    last_seen: phone["last_seen"].as_u64(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                (port, phones)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (DEFAULT_PORT, Vec::new()),
            Err(e) => return Err(format!("{} cannot be read: {e}", list.display())),
        };
        Ok(Registry { dir: dir.to_path_buf(), mac, port, phones, invite: None, seen_written: Default::default() })
    }

    fn save(&self) -> Result<(), String> {
        let phones: Vec<Value> = self
            .phones
            .iter()
            .map(|phone| json!({"key": seal::encode(&phone.key), "name": phone.name, "paired_at": phone.paired_at, "last_seen": phone.last_seen}))
            .collect();
        write_private(&self.dir.join("phones.json"), &serde_json::to_string_pretty(&json!({"v": 1, "port": self.port, "phones": phones})).unwrap_or_default())
    }

    pub fn mac(&self) -> &Secret {
        &self.mac
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn phones(&self) -> &[Phone] {
        &self.phones
    }

    pub fn paired(&self, key: &[u8; 32]) -> Option<&Phone> {
        self.phones.iter().find(|phone| &phone.key == key)
    }

    /// The invite showing now, if it has not lapsed.
    pub fn invite(&self, now: u64) -> Option<&Invite> {
        self.invite.as_ref().filter(|invite| invite.expires_at > now)
    }

    /// A new invite, replacing any other: only one QR is ever good at a time.
    pub fn new_invite(&mut self, now: u64) -> Result<Invite, String> {
        let invite = Invite { id: seal::random()?, secret: seal::random()?, expires_at: now + INVITE_LIFETIME.as_millis() as u64 };
        self.invite = Some(invite.clone());
        Ok(invite)
    }

    pub fn cancel_invite(&mut self) {
        self.invite = None;
    }

    /// The secret of the invite `id` names, while it is the one showing and has not lapsed.
    pub fn invite_secret(&self, id: &[u8; 16], now: u64) -> Option<[u8; 32]> {
        self.invite(now).filter(|invite| &invite.id == id).map(|invite| invite.secret)
    }

    /// Spends the invite on the phone that proved it holds it, and pairs that
    /// phone. A second claim, or a claim after it lapsed, finds no invite.
    pub fn claim(&mut self, id: &[u8; 16], key: [u8; 32], name: &str, now: u64) -> Result<Phone, String> {
        if self.invite_secret(id, now).is_none() {
            return Err("this invite has lapsed or was already used; show a new one on the Mac".to_string());
        }
        self.invite = None;
        let phone = Phone { id: fingerprint(&key), key, name: clean_name(name), paired_at: now, last_seen: Some(now) };
        self.phones.retain(|kept| kept.key != key);
        self.phones.push(phone.clone());
        self.save()?;
        self.seen_written.insert(phone.id.clone(), now);
        Ok(phone)
    }

    /// Forgets a phone's key. Its next connection is refused at the greeting.
    pub fn revoke(&mut self, id: &str) -> Result<Option<Phone>, String> {
        let Some(at) = self.phones.iter().position(|phone| phone.id == id) else { return Ok(None) };
        let phone = self.phones.remove(at);
        if let Err(problem) = self.save() {
            // Not on disk means not revoked: put it back so the screen does not say otherwise.
            self.phones.insert(at, phone);
            return Err(problem);
        }
        self.seen_written.remove(id);
        Ok(Some(phone))
    }

    /// Notes that a phone was seen at `now`, written at most once a minute. A
    /// time older than the one kept, from a session that ended late, changes nothing.
    pub fn seen(&mut self, key: &[u8; 32], now: u64) {
        let Some(phone) = self.phones.iter_mut().find(|phone| &phone.key == key) else { return };
        if phone.last_seen.is_some_and(|seen| seen >= now) {
            return;
        }
        phone.last_seen = Some(now);
        let id = phone.id.clone();
        if self.seen_written.get(&id).is_some_and(|written| now.saturating_sub(*written) < SEEN_EVERY_MS) {
            return;
        }
        self.seen_written.insert(id, now);
        if let Err(problem) = self.save() {
            log::warn!("could not note when a phone was last seen: {problem}");
        }
    }
}
