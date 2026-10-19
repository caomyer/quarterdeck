//! Everything a phone's request can reach on the Mac, and nothing more.

use crate::host::Messenger;
use crate::review::Writes;
use crate::snapshot::SnapshotReader;
use std::path::PathBuf;
use std::sync::Arc;

/// The phone's whole reach: the home the desktop reads, the first mate only as
/// something to tell and read ([`Messenger`]), the snapshot only to read, and
/// the lock every review write takes. There is no host handle here, no app
/// handle and no way to run a command, so a request cannot start, stop or
/// restart the first mate whatever its handler does.
#[derive(Clone)]
pub struct Desk {
    home: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    pub messenger: Messenger,
    pub snapshots: SnapshotReader,
    pub writes: Writes,
}

impl Desk {
    pub fn new(home: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>, messenger: Messenger, snapshots: SnapshotReader, writes: Writes) -> Self {
        Desk { home, messenger, snapshots, writes }
    }

    /// The home every screen reads, as the desktop resolves it.
    pub fn home(&self) -> Result<PathBuf, String> {
        (self.home)().ok_or_else(|| "no firstmate home has been chosen on the Mac".to_string())
    }
}
