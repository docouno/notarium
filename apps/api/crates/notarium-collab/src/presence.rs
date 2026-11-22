//! In-memory ownership and clocks for y-sync awareness records.
//!
//! The standard awareness clock rules apply after ownership is checked. An
//! explicit null keeps its clock and owner until that connection leaves. This
//! prevents another live peer from reviving or replacing the owner's state.

use std::collections::HashMap;
use yrs::ClientID;
use yrs::sync::AwarenessUpdate;
use yrs::sync::awareness::AwarenessUpdateEntry;

const MAX_CLIENTS_PER_PEER: usize = 8;
// Up to 128 concurrent peers × 8 clients per peer so no peer can starve another
// peer's awareness slots before hitting the room byte budget.
const MAX_ROOM_AWARENESS_CLIENTS: usize = 1024;
// Bound total awareness JSON stored in memory per room to 256 KiB (well below
// MAX_FRAME_BYTES so even a full snapshot fits in one outbound frame with ample
// headroom for client IDs, clocks, and protocol framing).
const MAX_ROOM_JSON_BYTES: usize = 256 * 1024;
const UNSET: &str = "null";

#[derive(Default)]
pub(crate) struct Presence {
    entries: HashMap<ClientID, OwnedState>,
    peer_counts: HashMap<u64, usize>,
    live_entries: usize,
    json_bytes: usize,
}

struct OwnedState {
    peer: u64,
    entry: AwarenessUpdateEntry,
}

impl Presence {
    /// Ignore foreign and stale records. Only accepted records are published.
    pub(crate) fn apply(&mut self, peer: u64, update: AwarenessUpdate) -> Option<AwarenessUpdate> {
        let mut remaining =
            MAX_CLIENTS_PER_PEER.saturating_sub(self.peer_counts.get(&peer).copied().unwrap_or(0));
        let mut candidates: Vec<_> = update.clients.into_iter().collect();
        // When a single message exceeds a quota, selection is deterministic.
        candidates.sort_unstable_by_key(|(id, _)| *id);

        let mut accepted = HashMap::new();
        for (id, mut entry) in candidates {
            let null = entry.json.trim() == UNSET;
            if null && entry.json.as_ref() != UNSET {
                entry.json = UNSET.into();
            }
            let (old_bytes, was_live) = match self.entries.get(&id) {
                Some(current) if current.peer == peer => {
                    let old_clock = current.entry.clock;
                    let removes_live_state =
                        null && current.entry.json.as_ref() != UNSET && entry.clock == old_clock;
                    if entry.clock <= old_clock && !removes_live_state {
                        continue;
                    }
                    (current.json_bytes(), current.entry.json.as_ref() != UNSET)
                }
                Some(_) => continue,
                None => {
                    if null || remaining == 0 || self.entries.len() == MAX_ROOM_AWARENESS_CLIENTS {
                        continue;
                    }
                    (0, false)
                }
            };
            // Absent records keep a clock but contribute no snapshot bytes.
            let json_bytes = self.json_bytes - old_bytes + if null { 0 } else { entry.json.len() };
            if json_bytes > MAX_ROOM_JSON_BYTES {
                continue;
            }
            let is_live = !null;
            if self
                .entries
                .insert(
                    id,
                    OwnedState {
                        peer,
                        entry: entry.clone(),
                    },
                )
                .is_none()
            {
                remaining -= 1;
                *self.peer_counts.entry(peer).or_insert(0) += 1;
            }
            if !was_live && is_live {
                self.live_entries += 1;
            } else if was_live && !is_live {
                self.live_entries -= 1;
            }
            self.json_bytes = json_bytes;
            accepted.insert(id, entry);
        }
        nonempty_update(accepted)
    }

    pub(crate) fn snapshot(&self) -> Option<AwarenessUpdate> {
        if self.live_entries == 0 {
            return None;
        }
        nonempty_update(
            self.entries
                .iter()
                .filter(|(_, state)| state.entry.json.as_ref() != UNSET)
                .map(|(&id, state)| (id, state.entry.clone()))
                .collect(),
        )
    }

    pub(crate) fn remove_peer(&mut self, peer: u64) -> Option<AwarenessUpdate> {
        self.peer_counts.remove(&peer)?;
        let mut cleared = HashMap::new();
        self.entries.retain(|&id, state| {
            if state.peer != peer {
                return true;
            }
            self.json_bytes -= state.json_bytes();
            if state.entry.json.as_ref() != UNSET {
                self.live_entries -= 1;
                cleared.insert(
                    id,
                    AwarenessUpdateEntry {
                        // A null at the same clock removes a known state.
                        // The next heartbeat can rejoin with its next clock.
                        clock: state.entry.clock,
                        json: UNSET.into(),
                    },
                );
            }
            false
        });
        nonempty_update(cleared)
    }
}

impl OwnedState {
    fn json_bytes(&self) -> usize {
        if self.entry.json.as_ref() == UNSET {
            0
        } else {
            self.entry.json.len()
        }
    }
}

fn nonempty_update(clients: HashMap<ClientID, AwarenessUpdateEntry>) -> Option<AwarenessUpdate> {
    if clients.is_empty() {
        None
    } else {
        Some(AwarenessUpdate { clients })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Doc, OffsetKind, Options, sync::Awareness};

    fn entry(clock: u32, json: &str) -> AwarenessUpdateEntry {
        AwarenessUpdateEntry {
            clock,
            json: json.into(),
        }
    }

    fn update(id: ClientID, clock: u32, json: &str) -> AwarenessUpdate {
        AwarenessUpdate {
            clients: HashMap::from([(id, entry(clock, json))]),
        }
    }

    #[test]
    fn foreign_writes_and_clock_regression_cannot_change_a_live_record() {
        let id = ClientID::new(1);
        let mut presence = Presence::default();
        assert!(presence.apply(10, update(id, 5, "{}")).is_some());
        assert!(presence.apply(20, update(id, 9, "{}")).is_none());
        assert!(presence.apply(20, update(id, 9, "null")).is_none());
        assert!(presence.apply(10, update(id, 4, "null")).is_none());
        assert_eq!(presence.snapshot(), Some(update(id, 5, "{}")));

        assert_eq!(
            presence.apply(10, update(id, 5, " null ")),
            Some(update(id, 5, "null"))
        );
        assert!(presence.snapshot().is_none());
        assert!(presence.apply(20, update(id, 10, "{}")).is_none());
        assert!(presence.apply(10, update(id, 5, "{}")).is_none());
        assert!(presence.apply(10, update(id, 6, "{}")).is_some());
    }

    #[test]
    fn disconnect_uses_standard_awareness_removal_and_releases_ids() {
        let id = ClientID::new(1);
        let mut presence = Presence::default();
        let mut options = Options::with_client_id(ClientID::new(2));
        options.offset_kind = OffsetKind::Utf16;
        let mut observer = Awareness::new(Doc::with_options(options));
        let published = presence.apply(10, update(id, 5, "{}")).unwrap();
        observer.apply_update(published).unwrap();
        assert!(observer.state::<serde_json::Value>(id).is_some());

        let expired = presence.remove_peer(10).unwrap();
        observer.apply_update(expired).unwrap();
        assert!(observer.state::<serde_json::Value>(id).is_none());
        assert!(presence.snapshot().is_none());

        let next = presence.apply(20, update(id, 6, "{}")).unwrap();
        observer.apply_update(next).unwrap();
        assert!(observer.state::<serde_json::Value>(id).is_some());
    }

    #[test]
    fn enforces_peer_slots_and_room_budget() {
        let mut presence = Presence::default();
        let all = AwarenessUpdate {
            clients: (0..16)
                .map(|n| (ClientID::new(n), entry(1, "{}")))
                .collect(),
        };
        let accepted = presence.apply(10, all).unwrap();
        assert_eq!(accepted.clients.len(), MAX_CLIENTS_PER_PEER);
        assert_eq!(presence.remove_peer(10).unwrap().clients.len(), 8);
        assert!(presence.entries.is_empty());
        assert_eq!(presence.json_bytes, 0);

        let json = format!("\"{}\"", "x".repeat(16 * 1024 - 2));
        for n in 0..MAX_ROOM_AWARENESS_CLIENTS as u64 {
            presence.apply(n, update(ClientID::new(n), 1, &json));
        }
        assert!(presence.json_bytes <= MAX_ROOM_JSON_BYTES);
        let snapshot = presence.snapshot().unwrap();
        assert_eq!(snapshot.clients.len(), MAX_ROOM_JSON_BYTES / (16 * 1024));
        assert!(crate::wire::encode_awareness(&snapshot).len() <= crate::wire::MAX_FRAME_BYTES);
    }
}
