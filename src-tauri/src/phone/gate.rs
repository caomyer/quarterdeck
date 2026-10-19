//! The places a connection holds until it has proven who it is.
//!
//! Anyone who can reach the port can open a connection, and some, knowing a
//! paired phone's public key from any greeting, are even answered `ready`; none
//! of them has proven anything until its frame 0 opens. So the Mac keeps only
//! [`PLACES`] of them at once, and when a new one comes, the oldest held by
//! whichever address holds the most gives way. Holding connections open, or
//! opening them as fast as it can, then costs a stranger only its own places:
//! the captain's phone, coming from its own tailnet address with one at a time,
//! is let in. On a tailnet an address is a device's own, which WireGuard
//! vouches for, so it cannot be borrowed. Only as many hostile devices as there
//! are places, all at once, could still crowd the phone out.
//!
//! A connection whose frame 0 opens leaves its place; from then on a session
//! counts against its phone's own [`super::SESSIONS_PER_PHONE`].

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// Connections still greeting, across every address the Mac listens on.
pub(super) const PLACES: usize = 16;

#[derive(Default)]
pub(super) struct Gate {
    waiting: Mutex<Waiting>,
}

#[derive(Default)]
struct Waiting {
    next: u64,
    /// Oldest first.
    places: Vec<Place>,
}

struct Place {
    id: u64,
    from: IpAddr,
    give_way: oneshot::Sender<()>,
}

/// A connection's place while it greets; dropping it frees the place.
pub(super) struct Admitted {
    gate: Arc<Gate>,
    id: u64,
    /// Resolves when a newer connection has taken this place.
    pub(super) displaced: oneshot::Receiver<()>,
}

impl Gate {
    fn waiting(&self) -> std::sync::MutexGuard<'_, Waiting> {
        self.waiting.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A place for a connection from `from`, made by displacing another when all are held.
    pub(super) fn admit(self: &Arc<Self>, from: IpAddr) -> Admitted {
        let (give_way, displaced) = oneshot::channel();
        let mut waiting = self.waiting();
        if waiting.places.len() >= PLACES {
            let at = waiting.giving_way(from);
            let _ = waiting.places.remove(at).give_way.send(());
        }
        let id = waiting.next;
        waiting.next += 1;
        waiting.places.push(Place { id, from, give_way });
        Admitted { gate: self.clone(), id, displaced }
    }

    #[cfg(test)]
    pub(super) fn held(&self) -> Vec<IpAddr> {
        self.waiting().places.iter().map(|place| place.from).collect()
    }
}

impl Waiting {
    /// Which place gives way to a newcomer from `from`: the oldest of whichever
    /// address holds the most, and the newcomer's own when it holds as many as any.
    fn giving_way(&self, from: IpAddr) -> usize {
        let holds = |address: IpAddr| self.places.iter().filter(|place| place.from == address).count();
        let most = self.places.iter().map(|place| holds(place.from)).max().unwrap_or(0);
        let yielding = if holds(from) >= most { from } else { self.places.iter().map(|place| place.from).find(|address| holds(*address) == most).unwrap_or(from) };
        self.places.iter().position(|place| place.from == yielding).unwrap_or(0)
    }
}

impl Drop for Admitted {
    fn drop(&mut self) {
        self.gate.waiting().places.retain(|place| place.id != self.id);
    }
}
