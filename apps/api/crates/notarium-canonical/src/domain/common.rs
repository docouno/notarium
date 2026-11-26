use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex},
};

use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, PrincipalKind, ResourceFacts, Space},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        AbilityId, AgentRunId, ContentDigest, FolderId, HistoryIncarnation, LeaseEpoch,
        LineageEpoch, NoteId, PrincipalId, RevisionId, SpaceId, SpaceSeq,
    },
    model::{FolderRef, HistoryScope, Lifecycle},
    ports::{
        AbilityPackageRevision, BoardMoveResult, ClosedRoomReservation, Committed, GroupKey, Link,
        LinkTarget, MintAndPurgeResult, NoteRevision, Preconditions, RestoredBoardRank,
        RollbackReservation, RollbackResult, RoomFenceState, SpaceContext,
    },
    query::FieldSchema,
    receipt::{CommandIdentity, MutationReceiptToken},
    value::{Timestamp, YamlValue},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::Mutex;

use crate::{
    codec::{
        AgentRunRevisionMetadata, MAX_MSGPACK_DECODE_BYTES, RevisionMetadataEnvelope,
        RevisionMetadataPayload, decode_msgpack_bounded, decode_timestamp_parts, doc_class_from_db,
        encode_msgpack, encode_timestamp_parts, i64_to_space_seq, internal_not_committed,
        lifecycle_from_db, new_revision_id,
    },
    runtime::{insert_revision_row, load_folder_head_row},
    sql_exec::BackendConn,
    writer::CommandIdentitySpec,
};

#[derive(Clone, Copy)]
pub(crate) struct CommandDeadline {
    pub(crate) at: tokio::time::Instant,
    operation: &'static str,
}

impl CommandDeadline {
    pub(crate) fn start(
        budget: &notarium_core::ports::CallBudget,
        operation: &'static str,
    ) -> Self {
        let at = crate::runtime::deadline_after(tokio::time::Instant::now(), budget.remaining);
        Self { at, operation }
    }

    pub(super) fn at(at: tokio::time::Instant, operation: &'static str) -> Self {
        Self { at, operation }
    }

    fn cancelled(&self) -> PortError {
        crate::codec::cancelled_not_committed(
            &format!("{}_cancelled", self.operation),
            format!("{} cancelled before commit", self.operation),
        )
    }

    fn expired(&self) -> PortError {
        crate::codec::deadline_not_committed(
            &format!("{}_deadline", self.operation),
            format!("{} deadline expired before commit", self.operation),
        )
    }

    pub(crate) fn remaining(
        &self,
        budget: &notarium_core::ports::CallBudget,
    ) -> Result<std::time::Duration, PortError> {
        if budget.cancellation.is_cancelled() {
            return Err(self.cancelled());
        }
        let remaining = self
            .at
            .saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(self.expired());
        }
        Ok(remaining)
    }

    /// Bounds read-only work or preparation whose mutation has not been admitted.
    pub(crate) async fn prepare<T, F: Future<Output = Result<T, PortError>>>(
        &self,
        budget: &notarium_core::ports::CallBudget,
        operation: impl FnOnce() -> F,
    ) -> Result<T, PortError> {
        let result = self.wait(budget, operation).await?;
        self.remaining(budget)?;
        result
    }

    /// Restart a read-only command phase once if its short snapshot expires.
    /// Both attempts must fit the command's original deadline.
    pub(crate) async fn prepare_read<T, F: Future<Output = Result<T, PortError>>>(
        &self,
        budget: &notarium_core::ports::CallBudget,
        mut read: impl FnMut() -> F,
    ) -> Result<T, PortError> {
        let first = self.prepare(budget, &mut read).await;
        if matches!(first, Err(PortError::DeadlineExceeded(_))) {
            return self.prepare(budget, read).await;
        }
        first
    }

    pub(crate) async fn submit<T: Serialize + serde::de::DeserializeOwned + Send + 'static>(
        &self,
        store: &crate::CanonicalStore,
        budget: &notarium_core::ports::CallBudget,
        intent: crate::writer::PreparedWriteIntent,
    ) -> Result<T, PortError> {
        store
            .submit_write_command_until(budget, self.at, intent, None, None, None)
            .await
    }

    pub(crate) async fn submit_with_effect<
        T: Serialize + serde::de::DeserializeOwned + Send + 'static,
    >(
        &self,
        store: &crate::CanonicalStore,
        budget: &notarium_core::ports::CallBudget,
        intent: crate::writer::PreparedWriteIntent,
        canonical_effect: Option<notarium_core::ports::CanonicalEffectAdmission>,
    ) -> Result<T, PortError> {
        store
            .submit_write_command_until_with_effect(
                budget,
                self.at,
                intent,
                canonical_effect,
                None,
                None,
                None,
            )
            .await
    }

    pub(crate) async fn wait<F: Future>(
        &self,
        budget: &notarium_core::ports::CallBudget,
        operation: impl FnOnce() -> F,
    ) -> Result<F::Output, PortError> {
        self.remaining(budget)?;
        tokio::select! {
            biased;
            _ = budget.cancellation.cancelled() => Err(self.cancelled()),
            _ = tokio::time::sleep_until(self.at) => Err(self.expired()),
            result = operation() => Ok(result),
        }
    }
}

/// Maximum parent edges from the Space root. A complete ancestry also includes the root.
pub const MAX_FOLDER_DEPTH: usize = 256;

pub(crate) fn persisted_room_fence(
    note: NoteId,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    active: bool,
) -> Result<RoomFenceState, PortError> {
    if !active {
        return Ok(RoomFenceState::new(note, scope, epoch));
    }
    let base = LeaseEpoch::new(epoch.get().saturating_sub(1))?;
    let mut state = RoomFenceState::new(note, scope, base);
    state.open()?;
    Ok(state)
}

const MAX_IDLE_CLOSED_FENCES: usize = 2048;
const MAX_DEFERRED_IDLE_CLOSED_FENCES: usize = 4096;
const TARGET_IDLE_CLOSED_FENCES: usize = 1024;
const MAX_RECOVERY_ENTRIES: usize = 4096;

struct RoomFenceEntry {
    state: Arc<Mutex<RoomFenceState>>,
    /// Eviction pin carrying this slot's creation `eviction_gen`.
    pin: Arc<u64>,
    touched: u64,
}

struct RoomFenceMapState {
    entries: HashMap<(SpaceId, NoteId), RoomFenceEntry>,
    touch_seq: u64,
    /// Monotonic eviction generation incremented whenever idle closed entries
    /// are pruned, preventing pre-eviction untracked reservations from matching
    /// a recreated zero-epoch slot without distorting durable `LeaseEpoch`.
    eviction_gen: u64,
    /// Shared pin (storing current `eviction_gen`) held by in-flight
    /// reservations minted for notes not yet in `entries`; allows deferring
    /// eviction while an untracked reservation is briefly in flight.
    untracked_pin: Arc<u64>,
    /// Monotonic generation for Space-level takeover / restore / removal
    /// transitions so stale post-commit takeover loops cannot overwrite a
    /// newer lease takeover or restored Space incarnation.
    space_sync_gen: u64,
    space_sync: HashMap<SpaceId, (u64, HistoryIncarnation, LeaseEpoch)>,
}

impl Default for RoomFenceMapState {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            touch_seq: 0,
            eviction_gen: 0,
            untracked_pin: Arc::new(0),
            space_sync_gen: 0,
            space_sync: HashMap::new(),
        }
    }
}

impl RoomFenceMapState {
    fn next_touch(&mut self) -> u64 {
        self.touch_seq = self.touch_seq.wrapping_add(1);
        self.touch_seq
    }

    fn advance_eviction_gen(&mut self) {
        self.eviction_gen = self.eviction_gen.saturating_add(1);
        self.untracked_pin = Arc::new(self.eviction_gen);
    }

    fn prune_idle_closed(&mut self, recovery: &StdMutex<RoomRecoveryFences>) {
        let cap = if Arc::strong_count(&self.untracked_pin) > 1 {
            MAX_DEFERRED_IDLE_CLOSED_FENCES
        } else {
            MAX_IDLE_CLOSED_FENCES
        };
        if self.entries.len() <= cap {
            return;
        }
        let fenced = &recovery
            .lock()
            .expect("room recovery fence table mutex")
            .fenced;
        let mut evictable: Vec<(u64, (SpaceId, NoteId))> = self
            .entries
            .iter()
            .filter_map(|(key, entry)| {
                if Arc::strong_count(&entry.state) != 1
                    || Arc::strong_count(&entry.pin) != 1
                    || fenced.contains(key)
                {
                    return None;
                }
                let guard = entry.state.try_lock().ok()?;
                (!guard.is_active()).then(|| (entry.touched, key.clone()))
            })
            .collect();
        if evictable.len() <= TARGET_IDLE_CLOSED_FENCES {
            return;
        }
        let remove_count = evictable.len() - TARGET_IDLE_CLOSED_FENCES;
        evictable.select_nth_unstable_by_key(remove_count, |(touched, _)| *touched);
        for (_, key) in evictable.into_iter().take(remove_count) {
            self.entries.remove(&key);
        }
        self.advance_eviction_gen();
    }
}

#[derive(Default)]
struct RoomRecoveryFences {
    fenced: HashSet<(SpaceId, NoteId)>,
    recovered: HashMap<(SpaceId, NoteId), (RevisionId, RevisionId, u64)>,
    recovery_seq: u64,
}

impl RoomRecoveryFences {
    fn record_recovery(
        &mut self,
        space_id: SpaceId,
        note: NoteId,
        previous: RevisionId,
        revision: RevisionId,
    ) {
        self.recovery_seq = self.recovery_seq.wrapping_add(1);
        let seq = self.recovery_seq;
        self.recovered
            .insert((space_id, note), (previous, revision, seq));
        if self.recovered.len() > MAX_RECOVERY_ENTRIES {
            let mut order: Vec<(u64, (SpaceId, NoteId))> = self
                .recovered
                .iter()
                .map(|(k, (_, _, touched))| (*touched, k.clone()))
                .collect();
            let remove_count = order.len() - (MAX_RECOVERY_ENTRIES / 2);
            order.select_nth_unstable_by_key(remove_count, |(touched, _)| *touched);
            for (_, key) in order.into_iter().take(remove_count) {
                self.recovered.remove(&key);
            }
        }
    }
}

/// Runtime-owned table of per-`(SpaceId, NoteId)` room fences (`tokio::sync::Mutex<RoomFenceState>`).
#[derive(Default)]
pub struct RoomFenceTable {
    fences: StdMutex<RoomFenceMapState>,
    recovery: StdMutex<RoomRecoveryFences>,
}

impl std::fmt::Debug for RoomFenceTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let len = self.fences.lock().map(|m| m.entries.len()).unwrap_or(0);
        f.debug_struct("RoomFenceTable")
            .field("entry_count", &len)
            .finish()
    }
}

impl RoomFenceTable {
    pub fn is_room_fenced(&self, space_id: &SpaceId, note: &NoteId) -> bool {
        self.recovery
            .lock()
            .expect("room recovery fence table mutex")
            .fenced
            .contains(&(space_id.clone(), note.clone()))
    }

    pub fn has_any_fenced_in_space(&self, space_id: &SpaceId) -> bool {
        self.recovery
            .lock()
            .expect("room recovery fence table mutex")
            .fenced
            .iter()
            .any(|(sid, _)| sid == space_id)
    }

    pub(crate) fn set_room_fenced(&self, space_id: &SpaceId, note: &NoteId, fenced: bool) {
        let mut recovery = self
            .recovery
            .lock()
            .expect("room recovery fence table mutex");
        let key = (space_id.clone(), note.clone());
        if fenced {
            recovery.fenced.insert(key);
        } else {
            recovery.fenced.remove(&key);
        }
    }

    pub(crate) fn publish_persisted_transition(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        guard: &mut tokio::sync::OwnedMutexGuard<RoomFenceState>,
        next: RoomFenceState,
        fenced: bool,
        recovered: Option<(RevisionId, RevisionId)>,
    ) -> bool {
        let key = (scope.space_id.clone(), note.clone());
        let mut map = self.fences.lock().expect("room fence table mutex");
        let current = tokio::sync::OwnedMutexGuard::mutex(guard);
        // A restore replaces the slot. A new room on the same slot advances
        // its epoch. Late publication must preserve both kinds of progress.
        if guard.epoch() > next.epoch()
            || !map
                .entries
                .get(&key)
                .is_some_and(|slot| Arc::ptr_eq(&slot.state, current))
        {
            return false;
        }
        let touched = map.next_touch();
        if let Some(slot) = map.entries.get_mut(&key) {
            slot.touched = touched;
        }
        let mut recovery = self
            .recovery
            .lock()
            .expect("room recovery fence table mutex");
        if let Some((previous, revision)) = recovered {
            recovery.record_recovery(scope.space_id.clone(), note.clone(), previous, revision);
        } else {
            recovery.recovered.remove(&key);
        }
        if fenced {
            recovery.fenced.insert(key);
        } else {
            recovery.fenced.remove(&key);
        }
        **guard = next;
        true
    }

    pub(crate) fn fenced_recovery_revision(
        &self,
        space_id: &SpaceId,
        note: &NoteId,
        previous: &RevisionId,
    ) -> Option<RevisionId> {
        self.recovery
            .lock()
            .expect("room recovery fence table mutex")
            .recovered
            .get(&(space_id.clone(), note.clone()))
            .and_then(|(prev, rev, _)| (prev == previous).then(|| rev.clone()))
    }

    pub(crate) fn existing_fence(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Option<Arc<Mutex<RoomFenceState>>> {
        let mut map = self.fences.lock().expect("room fence table mutex");
        let touched = map.next_touch();
        let entry = map
            .entries
            .get_mut(&(scope.space_id.clone(), note.clone()))?;
        entry.touched = touched;
        Some(Arc::clone(&entry.state))
    }

    pub(crate) async fn observed_active_lease(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Option<LeaseEpoch> {
        let lock = self.existing_fence(scope, note)?;
        let guard = lock.lock().await;
        guard.is_active().then(|| guard.epoch())
    }

    /// Captures all local `RoomFenceState` locks to synchronize for `scope`
    /// after a PostgreSQL writer-lease takeover at `new_epoch`, while the
    /// caller still holds the writer commit read guard (excluding concurrent
    /// Space restores) and WITHOUT holding any SQL connection or locking any
    /// per-note `Mutex<RoomFenceState>`.
    ///
    /// Returns `None` if a newer or equal takeover epoch for the same
    /// incarnation has already claimed synchronization for this Space.
    #[allow(clippy::type_complexity)]
    pub(crate) fn begin_space_takeover_sync(
        &self,
        scope: &HistoryScope,
        new_epoch: LeaseEpoch,
        fenced_leases: Vec<(NoteId, LeaseEpoch)>,
    ) -> Option<(
        u64,
        BTreeMap<NoteId, (Arc<Mutex<RoomFenceState>>, Option<LeaseEpoch>)>,
    )> {
        let mut fences = self.fences.lock().expect("room fence table mutex");
        if let Some((_, inc, prev_epoch)) = fences.space_sync.get(&scope.space_id)
            && *inc == scope.incarnation
            && *prev_epoch >= new_epoch
        {
            return None;
        }
        fences.advance_eviction_gen();
        let slot_gen = fences.eviction_gen;
        fences.space_sync_gen = fences.space_sync_gen.saturating_add(1);
        let sync_gen = fences.space_sync_gen;
        fences.space_sync.insert(
            scope.space_id.clone(),
            (sync_gen, scope.incarnation, new_epoch),
        );

        let mut targets: BTreeMap<NoteId, (Arc<Mutex<RoomFenceState>>, Option<LeaseEpoch>)> =
            BTreeMap::new();
        for (note, epoch) in fenced_leases {
            let key = (scope.space_id.clone(), note.clone());
            let touched = fences.next_touch();
            let state = if let Some(existing) = fences.entries.get_mut(&key) {
                existing.touched = touched;
                Arc::clone(&existing.state)
            } else {
                let state = Arc::new(Mutex::new(RoomFenceState::new(
                    note.clone(),
                    scope.clone(),
                    LeaseEpoch::ZERO,
                )));
                fences.entries.insert(
                    key,
                    RoomFenceEntry {
                        state: Arc::clone(&state),
                        pin: Arc::new(slot_gen),
                        touched,
                    },
                );
                state
            };
            targets.insert(note, (state, Some(epoch)));
        }
        for ((sid, note), entry) in &fences.entries {
            if sid == &scope.space_id && !targets.contains_key(note) {
                targets.insert(note.clone(), (Arc::clone(&entry.state), None));
            }
        }
        // Clean any orphaned recovery markers for this Space that no longer
        // have a corresponding fence slot.
        let mut recovery = self
            .recovery
            .lock()
            .expect("room recovery fence table mutex");
        recovery
            .fenced
            .retain(|(sid, note)| sid != &scope.space_id || targets.contains_key(note));
        recovery
            .recovered
            .retain(|(sid, note), _| sid != &scope.space_id || targets.contains_key(note));
        Some((sync_gen, targets))
    }

    /// Force-synchronizes one captured local `RoomFenceState` slot with
    /// authoritative PostgreSQL writer-lease takeover state while the caller
    /// holds `guard` (without holding any SQL connection or writer commit guard).
    ///
    /// Rejects stale updates superseded by a newer takeover epoch, Space
    /// restore, or Space removal.
    pub(crate) fn apply_takeover_transition(
        &self,
        scope: &HistoryScope,
        new_epoch: LeaseEpoch,
        sync_gen: u64,
        note: &NoteId,
        guard: &mut tokio::sync::OwnedMutexGuard<RoomFenceState>,
        fenced_epoch: Option<LeaseEpoch>,
    ) -> bool {
        let key = (scope.space_id.clone(), note.clone());
        let mut map = self.fences.lock().expect("room fence table mutex");
        if map.space_sync.get(&scope.space_id) != Some(&(sync_gen, scope.incarnation, new_epoch)) {
            return false;
        }
        let current = tokio::sync::OwnedMutexGuard::mutex(guard);
        // Preserve a concurrent Space restore that replaced the slot entirely.
        if !map
            .entries
            .get(&key)
            .is_some_and(|slot| Arc::ptr_eq(&slot.state, current))
        {
            return false;
        }
        let touched = map.next_touch();
        map.advance_eviction_gen();
        let slot_gen = map.eviction_gen;
        if let Some(slot) = map.entries.get_mut(&key) {
            slot.touched = touched;
            slot.pin = Arc::new(slot_gen);
        }
        let mut recovery = self
            .recovery
            .lock()
            .expect("room recovery fence table mutex");
        recovery.recovered.remove(&key);
        let next = match fenced_epoch {
            Some(epoch) => {
                recovery.fenced.insert(key);
                RoomFenceState::new(note.clone(), scope.clone(), epoch)
            }
            None => {
                recovery.fenced.remove(&key);
                RoomFenceState::new(note.clone(), scope.clone(), LeaseEpoch::ZERO)
            }
        };
        **guard = next;
        true
    }

    pub fn get_or_init(&self, scope: &HistoryScope, note: &NoteId) -> Arc<Mutex<RoomFenceState>> {
        let mut map = self.fences.lock().expect("room fence table mutex");
        let touched = map.next_touch();
        let key = (scope.space_id.clone(), note.clone());
        if let Some(entry) = map.entries.get_mut(&key) {
            entry.touched = touched;
            return Arc::clone(&entry.state);
        }
        map.prune_idle_closed(&self.recovery);
        let pin = Arc::new(map.eviction_gen);
        let state = Arc::new(Mutex::new(RoomFenceState::new(
            note.clone(),
            scope.clone(),
            LeaseEpoch::ZERO,
        )));
        map.entries.insert(
            key,
            RoomFenceEntry {
                state: Arc::clone(&state),
                pin,
                touched,
            },
        );
        state
    }

    /// Non-blocking closed-room reservation without allocating a persistent map
    /// entry for never-opened notes. Returns `None` if active, fenced, or contended.
    pub fn try_reserve_if_closed(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: CommandIdentity,
    ) -> Option<ClosedRoomReservation> {
        if self.is_room_fenced(&scope.space_id, note) {
            return None;
        }
        let lookup = {
            let mut map = self.fences.lock().expect("room fence table mutex");
            let touched = map.next_touch();
            if let Some(entry) = map.entries.get_mut(&(scope.space_id.clone(), note.clone())) {
                entry.touched = touched;
                Ok((Arc::clone(&entry.state), Arc::clone(&entry.pin)))
            } else {
                Err(Arc::clone(&map.untracked_pin))
            }
        };
        match lookup {
            Err(pin) => {
                match RoomFenceState::new(note.clone(), scope.clone(), LeaseEpoch::ZERO)
                    .reserve(identity)
                {
                    Ok(RollbackReservation::Closed(mut res)) => {
                        res.attach_table_pin(pin);
                        Some(res)
                    }
                    _ => None,
                }
            }
            Ok((lock, pin)) => {
                let guard = lock.try_lock().ok()?;
                match guard.reserve(identity) {
                    Ok(RollbackReservation::Closed(mut res)) => {
                        res.attach_table_pin(pin);
                        Some(res)
                    }
                    _ => None,
                }
            }
        }
    }

    pub async fn open_room(&self, scope: &HistoryScope, note: &NoteId) -> Result<(), PortError> {
        let lock = self.get_or_init(scope, note);
        let mut guard = lock.lock().await;
        guard.open().map_err(PortError::from)
    }

    pub async fn close_room(&self, scope: &HistoryScope, note: &NoteId) -> Result<(), PortError> {
        let lock = self.get_or_init(scope, note);
        let mut guard = lock.lock().await;
        guard.close().map_err(PortError::from)
    }

    pub async fn reserve_rollback(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: CommandIdentity,
    ) -> Result<RollbackReservation, PortError> {
        let lookup = {
            let mut map = self.fences.lock().expect("room fence table mutex");
            let touched = map.next_touch();
            if let Some(entry) = map.entries.get_mut(&(scope.space_id.clone(), note.clone())) {
                entry.touched = touched;
                Ok((Arc::clone(&entry.state), Arc::clone(&entry.pin)))
            } else {
                Err(Arc::clone(&map.untracked_pin))
            }
        };
        match lookup {
            Ok((lock, pin)) => {
                let guard = lock.lock().await;
                let mut res = guard.reserve(identity)?;
                if let RollbackReservation::Closed(ref mut closed) = res {
                    closed.attach_table_pin(pin);
                }
                Ok(res)
            }
            Err(pin) => {
                let mut res = RoomFenceState::new(note.clone(), scope.clone(), LeaseEpoch::ZERO)
                    .reserve(identity)?;
                if let RollbackReservation::Closed(ref mut closed) = res {
                    closed.attach_table_pin(pin);
                }
                Ok(res)
            }
        }
    }

    pub async fn is_room_active(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        let Some(lock) = self.existing_fence(scope, note) else {
            return Ok(false);
        };
        let probe_id = CommandIdentity {
            scope: scope.clone(),
            actor: PrincipalId::from_bytes([0u8; 16]),
            key: notarium_core::ids::CommandKey::from_bytes([0u8; 16]),
            hash: ContentDigest::from_bytes([0u8; 32]),
        };
        let guard = lock.try_lock().map_err(|_| Self::busy_fence())?;
        match guard.reserve(probe_id) {
            Ok(RollbackReservation::SkippedRoomActive) => Ok(true),
            Ok(RollbackReservation::Closed(_)) => Ok(false),
            Err(err) => Err(err.into()),
        }
    }

    /// Synchronous equivalent of `is_room_active` for `spawn_blocking` SQLite fast-path workers.
    pub fn is_room_active_blocking(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        let Some(lock) = self.existing_fence(scope, note) else {
            return Ok(false);
        };
        let probe_id = CommandIdentity {
            scope: scope.clone(),
            actor: PrincipalId::from_bytes([0u8; 16]),
            key: notarium_core::ids::CommandKey::from_bytes([0u8; 16]),
            hash: ContentDigest::from_bytes([0u8; 32]),
        };
        let guard = lock.try_lock().map_err(|_| Self::busy_fence())?;
        match guard.reserve(probe_id) {
            Ok(RollbackReservation::SkippedRoomActive) => Ok(true),
            Ok(RollbackReservation::Closed(_)) => Ok(false),
            Err(err) => Err(err.into()),
        }
    }

    pub fn remove_note(&self, space_id: &SpaceId, note: &NoteId) {
        let mut map = self.fences.lock().expect("room fence table mutex");
        let key = (space_id.clone(), note.clone());
        map.entries.remove(&key);
        let mut recovery = self
            .recovery
            .lock()
            .expect("room recovery fence table mutex");
        recovery.fenced.remove(&key);
        recovery.recovered.remove(&key);
    }

    pub fn remove_space(&self, space_id: &SpaceId) {
        let mut map = self.fences.lock().expect("room fence table mutex");
        map.entries.retain(|(sid, _), _| sid != space_id);
        map.advance_eviction_gen();
        map.space_sync_gen = map.space_sync_gen.saturating_add(1);
        map.space_sync.remove(space_id);
        let mut recovery = self
            .recovery
            .lock()
            .expect("room recovery fence table mutex");
        recovery.fenced.retain(|(sid, _)| sid != space_id);
        recovery.recovered.retain(|(sid, _), _| sid != space_id);
    }

    pub(crate) fn replace_restored_spaces(
        &self,
        spaces: &BTreeSet<&SpaceId>,
        restored: RoomFenceTable,
    ) {
        let mut fences = self.fences.lock().expect("room fence table mutex");
        fences.entries.retain(|(id, _), _| !spaces.contains(id));
        fences.advance_eviction_gen();
        fences.space_sync_gen = fences.space_sync_gen.saturating_add(1);
        for id in spaces {
            fences.space_sync.remove(*id);
        }
        let slot_gen = fences.eviction_gen;
        for (key, entry) in restored
            .fences
            .into_inner()
            .expect("restored room fence table")
            .entries
        {
            let touched = fences.next_touch();
            fences.entries.insert(
                key,
                RoomFenceEntry {
                    state: entry.state,
                    pin: Arc::new(slot_gen),
                    touched,
                },
            );
        }
        let mut recovery = self
            .recovery
            .lock()
            .expect("room recovery fence table mutex");
        recovery.fenced.retain(|(sid, _)| !spaces.contains(sid));
        recovery
            .recovered
            .retain(|(sid, _), _| !spaces.contains(sid));
        recovery.fenced.extend(
            restored
                .recovery
                .into_inner()
                .expect("restored room recovery fence table")
                .fenced,
        );
    }

    /// Writer transactions must never wait for a room guard retained by an earlier
    /// item in their own batch. A busy fence can be retried after the batch commits.
    pub(crate) fn lock_for_write(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<tokio::sync::OwnedMutexGuard<RoomFenceState>, PortError> {
        self.get_or_init(scope, note)
            .try_lock_owned()
            .map_err(|_| Self::busy_fence())
    }

    fn busy_fence() -> PortError {
        crate::codec::unavailable_retryable(
            "collab_fence_busy",
            "another operation holds the room fence",
            std::time::Duration::from_millis(5),
        )
    }

    pub(crate) fn lock_for_consume(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        reservation: &mut ClosedRoomReservation,
    ) -> Result<tokio::sync::OwnedMutexGuard<RoomFenceState>, PortError> {
        let res_gen = reservation.table_gen();
        let lock = {
            let mut map = self.fences.lock().expect("room fence table mutex");
            let touched = map.next_touch();
            let key = (scope.space_id.clone(), note.clone());
            if let Some(entry) = map.entries.get_mut(&key) {
                let expected_gen = *entry.pin;
                if res_gen != expected_gen {
                    reservation.release_pin();
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }
                entry.touched = touched;
                let state = Arc::clone(&entry.state);
                reservation.release_pin();
                state
            } else {
                let current_gen = map.eviction_gen;
                if res_gen != current_gen {
                    reservation.release_pin();
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }
                reservation.release_pin();
                let state = Arc::new(Mutex::new(RoomFenceState::new(
                    note.clone(),
                    scope.clone(),
                    LeaseEpoch::ZERO,
                )));
                map.entries.insert(
                    key,
                    RoomFenceEntry {
                        state: Arc::clone(&state),
                        pin: Arc::new(current_gen),
                        touched,
                    },
                );
                map.prune_idle_closed(&self.recovery);
                state
            }
        };
        lock.try_lock_owned().map_err(|_| {
            crate::codec::unavailable_retryable(
                "collab_room_fence_busy",
                "room fence lock is held by an in-flight writer commit",
                std::time::Duration::from_millis(5),
            )
        })
    }

    pub async fn consume_reservation(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        mut reservation: ClosedRoomReservation,
        identity: &CommandIdentity,
    ) -> Result<tokio::sync::OwnedMutexGuard<RoomFenceState>, PortError> {
        let mut guard = self.lock_for_consume(scope, note, &mut reservation)?;
        guard.consume(reservation, identity)?;
        Ok(guard)
    }

    pub fn consume_reservation_blocking(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        mut reservation: ClosedRoomReservation,
        identity: &CommandIdentity,
    ) -> Result<tokio::sync::OwnedMutexGuard<RoomFenceState>, PortError> {
        let mut guard = self.lock_for_consume(scope, note, &mut reservation)?;
        guard.consume(reservation, identity)?;
        Ok(guard)
    }

    /// Locks the per-note fence in ascending order and reserves a closed-room permit without mutating
    /// the fence epoch until all pre-write validations pass and `guard.consume(...)` is invoked.
    pub async fn try_lock_closed_for_rollback(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: &CommandIdentity,
    ) -> Result<
        Option<(
            tokio::sync::OwnedMutexGuard<RoomFenceState>,
            ClosedRoomReservation,
        )>,
        PortError,
    > {
        let guard = self.lock_for_write(scope, note)?;
        match guard.reserve(identity.clone())? {
            RollbackReservation::SkippedRoomActive => Ok(None),
            RollbackReservation::Closed(res) => Ok(Some((guard, res))),
        }
    }

    /// Synchronous equivalent of `try_lock_closed_for_rollback` for `spawn_blocking` SQLite fast-path workers.
    pub fn try_lock_closed_for_rollback_blocking(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: &CommandIdentity,
    ) -> Result<
        Option<(
            tokio::sync::OwnedMutexGuard<RoomFenceState>,
            ClosedRoomReservation,
        )>,
        PortError,
    > {
        let guard = self.lock_for_write(scope, note)?;
        match guard.reserve(identity.clone())? {
            RollbackReservation::SkippedRoomActive => Ok(None),
            RollbackReservation::Closed(res) => Ok(Some((guard, res))),
        }
    }

    /// Non-blocking batch lock + reservation in ascending `NoteId` order using a single map critical section.
    /// Returns `Ok(None)` on any per-note mutex contention so the caller can fall back to async locking.
    #[allow(clippy::type_complexity)]
    pub fn try_lock_batch_for_rollback_sync(
        &self,
        scope: &HistoryScope,
        sorted_notes: &[&NoteId],
        identity: &CommandIdentity,
    ) -> Result<
        Option<
            Vec<
                Option<(
                    tokio::sync::OwnedMutexGuard<RoomFenceState>,
                    ClosedRoomReservation,
                )>,
            >,
        >,
        PortError,
    > {
        let mut locks = Vec::with_capacity(sorted_notes.len());
        {
            let mut map = self.fences.lock().expect("room fence table mutex");
            map.prune_idle_closed(&self.recovery);
            for &note in sorted_notes {
                let touched = map.next_touch();
                let key = (scope.space_id.clone(), note.clone());
                let arc = if let Some(entry) = map.entries.get_mut(&key) {
                    entry.touched = touched;
                    Arc::clone(&entry.state)
                } else {
                    let pin = Arc::new(map.eviction_gen);
                    let state = Arc::new(Mutex::new(RoomFenceState::new(
                        note.clone(),
                        scope.clone(),
                        LeaseEpoch::ZERO,
                    )));
                    map.entries.insert(
                        key,
                        RoomFenceEntry {
                            state: Arc::clone(&state),
                            pin,
                            touched,
                        },
                    );
                    state
                };
                locks.push(arc);
            }
        }

        let mut out = Vec::with_capacity(locks.len());
        for lock in locks {
            let Ok(guard) = lock.try_lock_owned() else {
                return Ok(None);
            };
            match guard.reserve(identity.clone())? {
                RollbackReservation::SkippedRoomActive => out.push(None),
                RollbackReservation::Closed(res) => out.push(Some((guard, res))),
            }
        }
        Ok(Some(out))
    }

    pub async fn seed_persisted_room(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        epoch: LeaseEpoch,
        active: bool,
    ) -> Result<(), PortError> {
        let state = persisted_room_fence(note.clone(), scope.clone(), epoch, active)?;
        let existing = {
            let mut map = self.fences.lock().expect("room fence table mutex");
            let touched = map.next_touch();
            let slot_gen = map.eviction_gen;
            match map.entries.entry((scope.space_id.clone(), note.clone())) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    entry.get_mut().touched = touched;
                    Arc::clone(&entry.get().state)
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(RoomFenceEntry {
                        state: Arc::new(Mutex::new(state)),
                        pin: Arc::new(slot_gen),
                        touched,
                    });
                    return Ok(());
                }
            }
        };
        *existing.lock().await = state;
        Ok(())
    }
}

/// Atomic canonical Space field schema update input.
#[derive(Clone, Debug)]
pub struct UpdateSpaceSchema {
    pub schema_note: NoteId,
    pub parent: Option<FolderId>,
    pub slug: String,
    pub carrier: String,
    pub schema: BTreeMap<String, FieldSchema>,
    pub expected_schema_revision: Option<RevisionId>,
}

/// Committed Space field schema revision summary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SpaceSchemaRevision {
    pub schema_revision: RevisionId,
    pub schema_note: NoteId,
    pub note_revision: RevisionId,
    pub descriptor_fingerprint: ContentDigest,
}

pub(crate) fn validate_mutation_identity(
    ctx: &SpaceContext,
    identity: &CommandIdentity,
) -> Result<(), PortError> {
    if ctx.confirmed_chat_step().is_some() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    validate_confirmable_mutation_identity(ctx, identity)
}

pub(crate) fn validate_confirmable_mutation_identity(
    ctx: &SpaceContext,
    identity: &CommandIdentity,
) -> Result<(), PortError> {
    ctx.scope().check(&identity.scope)?;
    if identity.actor != *ctx.auth().principal() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if let Some(step) = ctx.confirmed_chat_step()
        && step.identity() != identity
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    Ok(())
}

/// These commands create an identity or carry their own typed predicates.
pub(crate) fn require_empty_preconditions(pre: &Preconditions) -> Result<(), PortError> {
    if pre != &Preconditions::default() {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(())
}

/// Folders and chat threads have revisions, but do not own a collaborative note room.
pub(crate) fn require_revision_only(pre: &Preconditions) -> Result<(), PortError> {
    if pre.lease.is_some() || pre.lineage.is_some() {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(())
}

pub(crate) fn command_identity_hash(
    identity: &CommandIdentity,
    command_kind: &str,
    canonical_payload_fingerprint: &[u8],
) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-cmd-v1:");
    hasher.update(command_kind.as_bytes());
    hasher.update(&[0]);
    hasher.update(identity.hash.as_bytes());
    hasher.update(&[0]);
    hasher.update(canonical_payload_fingerprint);
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

/// Derives a forged-hash-safe internal command hash binding `command_kind`, caller `identity.hash`,
/// and the canonicalized mutation input fingerprint, and attaches any live canonical effect
/// admission from `ctx`. Even if two requests share a forged `identity.hash` with the same
/// `CommandKey`, distinct inputs produce distinct `CommandIdentitySpec.command_hash` values and
/// trigger `DomainError::IdempotencyKeyReused`.
pub(crate) fn derive_command_identity_spec(
    ctx: &SpaceContext,
    identity: &CommandIdentity,
    command_kind: &str,
    canonical_payload_fingerprint: &[u8],
) -> crate::writer::replay::UnboundCommand {
    crate::writer::replay::UnboundCommand::new(
        CommandIdentitySpec::new(
            identity.actor.clone(),
            identity.key.clone(),
            command_identity_hash(identity, command_kind, canonical_payload_fingerprint),
        ),
        ctx.canonical_effect().cloned(),
    )
}

pub(crate) fn extract_agent_run_from_auth(auth: &EngineAuthContext) -> Option<AgentRunId> {
    match auth.kind() {
        PrincipalKind::AgentRun(run) | PrincipalKind::Keeper(run) => Some(run.clone()),
        PrincipalKind::DirectHuman
        | PrincipalKind::Pat
        | PrincipalKind::OAuth { .. }
        | PrincipalKind::SearchIndexing => None,
    }
}

pub(crate) fn note_rank_version_digest(
    note_rev: &RevisionId,
    rank_extra: Option<&str>,
) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-overlay-row-v1:");
    hasher.update(note_rev.as_str().as_bytes());
    if let Some(extra) = rank_extra {
        hasher.update(&[0]);
        hasher.update(extra.as_bytes());
    }
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

pub(crate) fn schema_descriptor_bytes_and_fingerprint(
    schema: &BTreeMap<String, FieldSchema>,
) -> Result<(Vec<u8>, ContentDigest), PortError> {
    let bytes = encode_msgpack(schema)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-space-schema-v1:");
    hasher.update(&bytes);
    let fp = ContentDigest::from_bytes(*hasher.finalize().as_bytes());
    Ok((bytes, fp))
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct NoteHeadRow {
    pub note_id: NoteId,
    pub parent_folder_id: FolderId,
    pub slug: String,
    pub slug_fold: String,
    pub title: String,
    pub title_fold: String,
    pub doc_class: DocClass,
    pub ability_id: Option<AbilityId>,
    pub head_rev_id: RevisionId,
    pub content_digest: Option<ContentDigest>,
    pub byte_size: u64,
    pub lifecycle: Lifecycle,
    pub visibility_mask: i32,
    pub settlement_successor_id: Option<NoteId>,
    pub created_seq: SpaceSeq,
    pub updated_seq: SpaceSeq,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub last_actor_id: PrincipalId,
}

// Optional projections omit inaccessible or unavailable values. A cancelled or
// expired request must still interrupt the enclosing page, even in a last slot.
pub(crate) fn optional_read<T>(result: Result<T, PortError>) -> Result<Option<T>, PortError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(err @ (PortError::DeadlineExceeded(_) | PortError::Cancelled(_))) => Err(err),
        Err(_) => Ok(None),
    }
}

#[allow(clippy::type_complexity)]
pub(crate) async fn load_note_head_row_opt_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<Option<NoteHeadRow>, PortError> {
    let raw: Option<(
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<Vec<u8>>,
        i64,
        String,
        i32,
        Option<String>,
        i64,
        i64,
        i64,
        i32,
        i64,
        i32,
        String,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                        ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                        visibility_mask, settlement_successor_id, created_seq, updated_seq,
                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                 FROM note_heads WHERE space_id = ? AND note_id = ?",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_note_head", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("parent_folder_id"),
                    r.get("slug"),
                    r.get("slug_fold"),
                    r.get("title"),
                    r.get("title_fold"),
                    r.get("doc_class"),
                    r.get("ability_id"),
                    r.get("head_rev_id"),
                    r.get("content_blake3"),
                    r.get("byte_size"),
                    r.get("lifecycle_state"),
                    r.get::<i64, _>("visibility_mask") as i32,
                    r.get("settlement_successor_id"),
                    r.get("created_seq"),
                    r.get("updated_seq"),
                    r.get("created_at_sec"),
                    r.get::<i64, _>("created_at_nsec") as i32,
                    r.get("updated_at_sec"),
                    r.get::<i64, _>("updated_at_nsec") as i32,
                    r.get("last_actor_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                        ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                        visibility_mask, settlement_successor_id, created_seq, updated_seq,
                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                 FROM note_heads WHERE space_id = $1 AND note_id = $2",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_note_head", err))?;
            row.map(|r| {
                (
                    r.get("parent_folder_id"),
                    r.get("slug"),
                    r.get("slug_fold"),
                    r.get("title"),
                    r.get("title_fold"),
                    r.get("doc_class"),
                    r.get("ability_id"),
                    r.get("head_rev_id"),
                    r.get("content_blake3"),
                    r.get("byte_size"),
                    r.get("lifecycle_state"),
                    r.get("visibility_mask"),
                    r.get("settlement_successor_id"),
                    r.get("created_seq"),
                    r.get("updated_seq"),
                    r.get("created_at_sec"),
                    r.get("created_at_nsec"),
                    r.get("updated_at_sec"),
                    r.get("updated_at_nsec"),
                    r.get("last_actor_id"),
                )
            })
        }
    };

    let Some((
        parent_raw,
        slug,
        slug_fold,
        title,
        title_fold,
        class_raw,
        ability_raw,
        head_rev_raw,
        digest_raw,
        byte_size_raw,
        lc_raw,
        visibility_mask,
        succ_raw,
        created_seq_raw,
        updated_seq_raw,
        c_sec,
        c_nsec,
        u_sec,
        u_nsec,
        actor_raw,
    )) = raw
    else {
        return Ok(None);
    };

    let parent_folder_id = FolderId::parse(&parent_raw)
        .map_err(|_| internal_not_committed("corrupt_note_parent", "invalid parent_folder_id"))?;
    let doc_class = doc_class_from_db(&class_raw)?;
    let ability_id = match ability_raw {
        Some(s) => Some(
            AbilityId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_ability_id", "invalid ability_id"))?,
        ),
        None => None,
    };
    let head_rev_id = RevisionId::parse(&head_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_note_rev", "invalid head_rev_id"))?;
    let content_digest = match digest_raw {
        Some(b) => {
            let arr: [u8; 32] = b.try_into().map_err(|_| {
                internal_not_committed("corrupt_note_digest", "content_blake3 != 32B")
            })?;
            Some(ContentDigest::from_bytes(arr))
        }
        None => None,
    };
    let byte_size = u64::try_from(byte_size_raw)
        .map_err(|_| internal_not_committed("corrupt_byte_size", "negative byte_size"))?;
    let lifecycle = lifecycle_from_db(&lc_raw)?;
    let settlement_successor_id = match succ_raw {
        Some(s) => Some(
            NoteId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_successor_id", "invalid successor"))?,
        ),
        None => None,
    };
    let created_seq = i64_to_space_seq(created_seq_raw)?;
    let updated_seq = i64_to_space_seq(updated_seq_raw)?;
    let created_at = decode_timestamp_parts(c_sec, c_nsec)?;
    let updated_at = decode_timestamp_parts(u_sec, u_nsec)?;
    let last_actor_id = PrincipalId::parse(&actor_raw)
        .map_err(|_| internal_not_committed("corrupt_last_actor", "invalid last_actor_id"))?;

    Ok(Some(NoteHeadRow {
        note_id: note_id.clone(),
        parent_folder_id,
        slug,
        slug_fold,
        title,
        title_fold,
        doc_class,
        ability_id,
        head_rev_id,
        content_digest,
        byte_size,
        lifecycle,
        visibility_mask,
        settlement_successor_id,
        created_seq,
        updated_seq,
        created_at,
        updated_at,
        last_actor_id,
    }))
}

pub(crate) async fn load_note_head_row_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<NoteHeadRow, PortError> {
    load_note_head_row_opt_tx(tx, space_id, note_id)
        .await?
        .ok_or_else(|| DomainError::ResourceNotFound.into())
}

#[allow(clippy::type_complexity)]
pub(crate) async fn load_note_heads_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_ids: &[NoteId],
) -> Result<BTreeMap<NoteId, NoteHeadRow>, PortError> {
    let mut out = BTreeMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    type RawBatchTuple = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<Vec<u8>>,
        i64,
        String,
        i32,
        Option<String>,
        i64,
        i64,
        i64,
        i32,
        i64,
        i32,
        String,
    );
    for chunk in note_ids.chunks(200) {
        let rows: Vec<RawBatchTuple> = match tx {
            BackendConn::Sqlite(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT note_id, parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                            ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                            visibility_mask, settlement_successor_id, created_seq, updated_seq,
                            created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                     FROM note_heads WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str()).push(" AND note_id IN (");
                let mut sep = qb.separated(", ");
                for nid in chunk {
                    sep.push_bind(nid.as_str());
                }
                sep.push_unseparated(")");
                let fetched = qb.build().fetch_all(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_load_note_heads_batch", err.to_string())
                })?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("note_id"),
                            r.get("parent_folder_id"),
                            r.get("slug"),
                            r.get("slug_fold"),
                            r.get("title"),
                            r.get("title_fold"),
                            r.get("doc_class"),
                            r.get("ability_id"),
                            r.get("head_rev_id"),
                            r.get("content_blake3"),
                            r.get("byte_size"),
                            r.get("lifecycle_state"),
                            r.get::<i64, _>("visibility_mask") as i32,
                            r.get("settlement_successor_id"),
                            r.get("created_seq"),
                            r.get("updated_seq"),
                            r.get("created_at_sec"),
                            r.get::<i64, _>("created_at_nsec") as i32,
                            r.get("updated_at_sec"),
                            r.get::<i64, _>("updated_at_nsec") as i32,
                            r.get("last_actor_id"),
                        )
                    })
                    .collect()
            }
            BackendConn::Postgres(conn) => {
                let note_strs: Vec<&str> = chunk.iter().map(NoteId::as_str).collect();
                let fetched = sqlx::query(
                    "SELECT note_id, parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                            ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                            visibility_mask, settlement_successor_id, created_seq, updated_seq,
                            created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                     FROM note_heads WHERE space_id = $1 AND note_id = ANY($2)",
                )
                .bind(space_id.as_str())
                .bind(note_strs)
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| {
                    crate::runtime::pg_read_error("pg_load_note_heads_batch", err)
                })?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("note_id"),
                            r.get("parent_folder_id"),
                            r.get("slug"),
                            r.get("slug_fold"),
                            r.get("title"),
                            r.get("title_fold"),
                            r.get("doc_class"),
                            r.get("ability_id"),
                            r.get("head_rev_id"),
                            r.get("content_blake3"),
                            r.get("byte_size"),
                            r.get("lifecycle_state"),
                            r.get("visibility_mask"),
                            r.get("settlement_successor_id"),
                            r.get("created_seq"),
                            r.get("updated_seq"),
                            r.get("created_at_sec"),
                            r.get("created_at_nsec"),
                            r.get("updated_at_sec"),
                            r.get("updated_at_nsec"),
                            r.get("last_actor_id"),
                        )
                    })
                    .collect()
            }
        };
        for (
            nid_raw,
            parent_raw,
            slug,
            slug_fold,
            title,
            title_fold,
            class_raw,
            ability_raw,
            head_rev_raw,
            digest_raw,
            byte_size_raw,
            lc_raw,
            visibility_mask,
            succ_raw,
            created_seq_raw,
            updated_seq_raw,
            c_sec,
            c_nsec,
            u_sec,
            u_nsec,
            actor_raw,
        ) in rows
        {
            let nid = NoteId::parse(&nid_raw)
                .map_err(|_| internal_not_committed("corrupt_note_id", "invalid note_id"))?;
            let parent_folder_id = FolderId::parse(&parent_raw).map_err(|_| {
                internal_not_committed("corrupt_note_parent", "invalid parent_folder_id")
            })?;
            let doc_class = doc_class_from_db(&class_raw)?;
            let ability_id = match ability_raw {
                Some(s) => Some(AbilityId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_ability_id", "invalid ability_id")
                })?),
                None => None,
            };
            let head_rev_id = RevisionId::parse(&head_rev_raw)
                .map_err(|_| internal_not_committed("corrupt_note_rev", "invalid head_rev_id"))?;
            let content_digest = match digest_raw {
                Some(b) => {
                    let arr: [u8; 32] = b.try_into().map_err(|_| {
                        internal_not_committed("corrupt_note_digest", "content_blake3 != 32B")
                    })?;
                    Some(ContentDigest::from_bytes(arr))
                }
                None => None,
            };
            let byte_size = u64::try_from(byte_size_raw)
                .map_err(|_| internal_not_committed("corrupt_byte_size", "negative byte_size"))?;
            let lifecycle = lifecycle_from_db(&lc_raw)?;
            let settlement_successor_id = match succ_raw {
                Some(s) => Some(NoteId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_successor_id", "invalid successor")
                })?),
                None => None,
            };
            let created_seq = i64_to_space_seq(created_seq_raw)?;
            let updated_seq = i64_to_space_seq(updated_seq_raw)?;
            let created_at = decode_timestamp_parts(c_sec, c_nsec)?;
            let updated_at = decode_timestamp_parts(u_sec, u_nsec)?;
            let last_actor_id = PrincipalId::parse(&actor_raw).map_err(|_| {
                internal_not_committed("corrupt_last_actor", "invalid last_actor_id")
            })?;
            out.insert(
                nid.clone(),
                NoteHeadRow {
                    note_id: nid,
                    parent_folder_id,
                    slug,
                    slug_fold,
                    title,
                    title_fold,
                    doc_class,
                    ability_id,
                    head_rev_id,
                    content_digest,
                    byte_size,
                    lifecycle,
                    visibility_mask,
                    settlement_successor_id,
                    created_seq,
                    updated_seq,
                    created_at,
                    updated_at,
                    last_actor_id,
                },
            );
        }
    }
    Ok(out)
}

pub(crate) fn combine_lifecycle(a: Lifecycle, b: Lifecycle) -> Lifecycle {
    match (a, b) {
        (Lifecycle::Purged, _) | (_, Lifecycle::Purged) => Lifecycle::Purged,
        (Lifecycle::Trashed, _) | (_, Lifecycle::Trashed) => Lifecycle::Trashed,
        (Lifecycle::Active, Lifecycle::Active) => Lifecycle::Active,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct FolderAncestryFacts {
    pub ancestors: Vec<FolderId>,
    pub write_locked: bool,
    /// Whether a note placed directly in this folder is a logical root child.
    pub is_root_child: bool,
    pub folder_path: String,
    pub project: Option<FolderId>,
    pub cover_note: Option<NoteId>,
    /// Most restrictive lifecycle across this folder and all of its ancestors.
    pub folder_lifecycle: Lifecycle,
}

impl FolderAncestryFacts {
    pub(crate) fn note_provenance(
        &self,
        note: &NoteId,
        slug: &str,
        title: String,
        principal: PrincipalId,
        modified_at: Timestamp,
    ) -> notarium_core::ports::NoteProvenance {
        let path = if self.folder_path.is_empty() {
            format!("{slug}.md")
        } else {
            format!("{}/{slug}.md", self.folder_path)
        };
        notarium_core::ports::NoteProvenance {
            title,
            path,
            project: self.project.clone(),
            principal,
            modified_at,
            folder_page: self.cover_note.as_ref() == Some(note),
        }
    }
}

/// Transaction-scoped memoization cache for `folder_heads` rows and computed `FolderAncestryFacts`
/// so multi-item read transactions (`recent_activity`, `read_changes`, `hydrate_cards`, `ChangeSeed`)
/// resolve 256-deep folder chains in `O(unique folders)` instead of `O(items * depth)` SQL queries.
#[derive(Default)]
pub(crate) struct FolderAncestryCache {
    rows: HashMap<(SpaceId, FolderId), AncestryRow>,
    snapshot: Option<(HistoryScope, SpaceSeq)>,
    resolved: HashMap<(SpaceId, FolderId, bool), FolderAncestryFacts>,
}

#[derive(Clone)]
struct AncestryRow {
    folder_id: FolderId,
    parent_folder_id: Option<FolderId>,
    is_root: bool,
    is_project: bool,
    slug: String,
    write_locked: bool,
    lifecycle: Lifecycle,
    cover_note: Option<NoteId>,
}

impl From<crate::runtime::FolderHeadRow> for AncestryRow {
    fn from(row: crate::runtime::FolderHeadRow) -> Self {
        Self {
            folder_id: row.folder_id,
            parent_folder_id: row.parent_folder_id,
            is_root: row.is_root,
            is_project: row.is_project,
            slug: row.slug,
            write_locked: row.write_locked,
            lifecycle: row.lifecycle,
            cover_note: row.cover_note_id,
        }
    }
}

impl FolderAncestryCache {
    pub(crate) fn at_cut(scope: &HistoryScope, cutoff: SpaceSeq) -> Self {
        Self {
            snapshot: Some((scope.clone(), cutoff)),
            ..Self::default()
        }
    }

    pub(crate) fn insert_preloaded_row(
        &mut self,
        space_id: SpaceId,
        row: crate::runtime::FolderHeadRow,
    ) {
        self.rows
            .insert((space_id, row.folder_id.clone()), row.into());
    }

    pub(crate) fn is_project_cached(
        &self,
        space_id: &SpaceId,
        folder_id: &FolderId,
    ) -> Option<bool> {
        self.rows
            .get(&(space_id.clone(), folder_id.clone()))
            .map(|row| row.is_project)
    }

    async fn load_row(
        &self,
        tx: &mut BackendConn<'_>,
        space: &SpaceId,
        folder: &FolderId,
    ) -> Result<AncestryRow, PortError> {
        let Some((scope, cutoff)) = &self.snapshot else {
            return Ok(load_folder_head_row(tx, space, folder).await?.into());
        };
        if &scope.space_id != space {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
        let rev = crate::runtime::read_immutable_revision_tx(
            tx,
            scope,
            "folder",
            folder.as_str(),
            *cutoff,
        )
        .await?
        .ok_or_else(|| DomainError::validation(ValidationReason::CursorStale))?;
        let RevisionMetadataPayload::Folder(row) = rev.metadata.payload else {
            return Err(internal_not_committed(
                "corrupt_folder_revision",
                "expected folder metadata",
            ));
        };
        Ok(AncestryRow {
            folder_id: row.folder_id,
            parent_folder_id: row.parent_folder_id,
            is_root: row.is_root,
            is_project: row.is_project,
            slug: row.slug,
            write_locked: row.write_locked,
            lifecycle: row.lifecycle,
            cover_note: row.cover_note_id,
        })
    }

    pub(crate) async fn load_ancestry_tx(
        &mut self,
        tx: &mut BackendConn<'_>,
        space_id: &SpaceId,
        folder_id: &FolderId,
        require_all_active: bool,
    ) -> Result<FolderAncestryFacts, PortError> {
        if let Some((scope, _)) = &self.snapshot
            && &scope.space_id != space_id
        {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
        if let Some(cached) =
            self.resolved
                .get(&(space_id.clone(), folder_id.clone(), require_all_active))
        {
            return Ok(cached.clone());
        }

        let mut chain: Vec<AncestryRow> = Vec::new();
        let mut visited = BTreeSet::new();
        let mut current = folder_id.clone();

        let mut acc = loop {
            if chain.len() > MAX_FOLDER_DEPTH {
                return Err(internal_not_committed(
                    "folder_depth_exceeded",
                    "folder tree exceeded MAX_FOLDER_DEPTH",
                ));
            }
            if let Some(cached) =
                self.resolved
                    .get(&(space_id.clone(), current.clone(), require_all_active))
            {
                break cached.clone();
            }
            if !visited.insert(current.clone()) {
                return Err(internal_not_committed(
                    "folder_cycle_detected",
                    "corrupt cycle in folder_heads",
                ));
            }

            let row = if let Some(existing) = self.rows.get(&(space_id.clone(), current.clone())) {
                existing.clone()
            } else {
                let fetched = self.load_row(tx, space_id, &current).await?;
                self.rows
                    .insert((space_id.clone(), current.clone()), fetched.clone());
                fetched
            };

            if require_all_active && row.lifecycle != Lifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }

            if row.is_root {
                let root_facts = FolderAncestryFacts {
                    ancestors: vec![row.folder_id.clone()],
                    write_locked: row.write_locked,
                    is_root_child: true,
                    folder_path: String::new(),
                    project: None,
                    cover_note: row.cover_note,
                    folder_lifecycle: row.lifecycle,
                };
                self.resolved.insert(
                    (space_id.clone(), row.folder_id.clone(), require_all_active),
                    root_facts.clone(),
                );
                break root_facts;
            }

            let next_parent = row.parent_folder_id.clone().ok_or_else(|| {
                internal_not_committed(
                    "non_root_missing_parent",
                    "non-root folder missing parent_folder_id",
                )
            })?;
            chain.push(row);
            current = next_parent;
        };

        for child_row in chain.into_iter().rev() {
            if acc.ancestors.len() > MAX_FOLDER_DEPTH {
                return Err(internal_not_committed(
                    "folder_depth_exceeded",
                    "folder tree exceeded MAX_FOLDER_DEPTH",
                ));
            }
            if acc.ancestors.contains(&child_row.folder_id) {
                return Err(internal_not_committed(
                    "folder_cycle_detected",
                    "corrupt cycle in folder_heads",
                ));
            }
            let mut next_anc = Vec::with_capacity(acc.ancestors.len() + 1);
            next_anc.push(child_row.folder_id.clone());
            next_anc.extend_from_slice(&acc.ancestors);
            let next_locked = child_row.write_locked || acc.write_locked;
            let next_path = if acc.folder_path.is_empty() {
                child_row.slug.clone()
            } else {
                format!("{}/{}", acc.folder_path, child_row.slug)
            };
            acc = FolderAncestryFacts {
                ancestors: next_anc,
                write_locked: next_locked,
                is_root_child: false,
                folder_path: next_path,
                project: if child_row.is_project {
                    Some(child_row.folder_id.clone())
                } else {
                    acc.project
                },
                cover_note: child_row.cover_note,
                folder_lifecycle: combine_lifecycle(acc.folder_lifecycle, child_row.lifecycle),
            };
            self.resolved.insert(
                (space_id.clone(), child_row.folder_id, require_all_active),
                acc.clone(),
            );
        }

        Ok(acc)
    }

    pub(crate) async fn live_note_facts(
        &mut self,
        tx: &mut BackendConn<'_>,
        space: &Space,
        note: &NoteId,
        active_only: bool,
    ) -> Result<Option<(ResourceFacts, Lifecycle)>, PortError> {
        if crate::runtime::is_note_purge_fenced_tx(tx, &space.id, note.as_str()).await? {
            return Ok(None);
        }
        let Some(head) = load_note_head_row_opt_tx(tx, &space.id, note).await? else {
            return Ok(None);
        };
        if head.lifecycle == Lifecycle::Purged
            || (active_only && head.lifecycle != Lifecycle::Active)
        {
            return Ok(None);
        }
        let (facts, anc) = self
            .build_resource_facts_tx(
                tx,
                space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id,
                active_only,
            )
            .await?;
        let effective = combine_lifecycle(head.lifecycle, anc.folder_lifecycle);
        if effective == Lifecycle::Purged || (active_only && effective != Lifecycle::Active) {
            return Ok(None);
        }
        Ok(Some((facts, effective)))
    }

    pub(crate) async fn build_resource_facts_tx(
        &mut self,
        tx: &mut BackendConn<'_>,
        space: &Space,
        parent_folder_id: &FolderId,
        class: DocClass,
        ability_package: Option<AbilityId>,
        require_active_folders: bool,
    ) -> Result<(ResourceFacts, FolderAncestryFacts), PortError> {
        let anc = self
            .load_ancestry_tx(tx, &space.id, parent_folder_id, require_active_folders)
            .await?;
        let facts = ResourceFacts {
            space: space.clone(),
            class,
            project: anc.project.clone(),
            ancestor_folders: anc.ancestors.clone(),
            folder_write_locked: anc.write_locked,
            ability_package,
        };
        Ok((facts, anc))
    }

    /// Check the lineage already loaded while resolving the resource facts.
    pub(crate) fn all_active(&self, space_id: &SpaceId, ancestors: &[FolderId]) -> bool {
        ancestors.iter().all(|id| {
            self.rows
                .get(&(space_id.clone(), id.clone()))
                .is_some_and(|row| row.lifecycle == Lifecycle::Active)
        })
    }

    pub(crate) fn enclosing_project(
        &self,
        space_id: &SpaceId,
        ancestry: &FolderAncestryFacts,
    ) -> Option<FolderId> {
        self.enclosing_project_in(space_id, &ancestry.ancestors)
    }

    pub(crate) fn enclosing_project_in(
        &self,
        space_id: &SpaceId,
        ancestors: &[FolderId],
    ) -> Option<FolderId> {
        ancestors.iter().find_map(|id| {
            self.rows
                .get(&(space_id.clone(), id.clone()))
                .filter(|row| row.is_project && row.lifecycle == Lifecycle::Active)
                .map(|_| id.clone())
        })
    }
}

/// Walks `folder_heads` from `folder_id` up to the Space root (`O(depth)`), returning
/// `[folder_id, parent, ..., root]`, aggregated `write_locked`, and normalized path prefix.
pub(crate) async fn load_folder_ancestry_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    folder_id: &FolderId,
    require_all_active: bool,
) -> Result<FolderAncestryFacts, PortError> {
    let mut ancestors = Vec::new();
    let mut segments_rev = Vec::new();
    let mut visited = BTreeSet::new();
    let mut write_locked = false;
    let mut current = folder_id.clone();
    let mut project = None;
    let mut cover_note = None;
    let mut folder_lifecycle = Lifecycle::Active;

    for _depth in 0..=MAX_FOLDER_DEPTH {
        if !visited.insert(current.clone()) {
            return Err(internal_not_committed(
                "folder_cycle_detected",
                "corrupt cycle in folder_heads",
            ));
        }
        let row = load_folder_head_row(tx, space_id, &current).await?;
        if require_all_active && row.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        folder_lifecycle = combine_lifecycle(folder_lifecycle, row.lifecycle);
        if row.write_locked {
            write_locked = true;
        }
        if ancestors.is_empty() {
            cover_note = row.cover_note_id;
        }
        if row.is_project && project.is_none() {
            project = Some(row.folder_id.clone());
        }
        ancestors.push(row.folder_id.clone());
        if row.is_root {
            segments_rev.reverse();
            let folder_path = if segments_rev.is_empty() {
                String::new()
            } else {
                segments_rev.join("/")
            };
            let is_root_child = ancestors.len() == 1;
            return Ok(FolderAncestryFacts {
                ancestors,
                write_locked,
                is_root_child,
                folder_path,
                project,
                cover_note,
                folder_lifecycle,
            });
        }
        segments_rev.push(row.slug);
        current = row.parent_folder_id.ok_or_else(|| {
            internal_not_committed(
                "non_root_missing_parent",
                "non-root folder missing parent_folder_id",
            )
        })?;
    }

    Err(internal_not_committed(
        "folder_depth_exceeded",
        "folder tree exceeded MAX_FOLDER_DEPTH",
    ))
}

pub(crate) async fn build_resource_facts_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    parent_folder_id: &FolderId,
    class: DocClass,
    ability_package: Option<AbilityId>,
    require_active_folders: bool,
) -> Result<(ResourceFacts, FolderAncestryFacts), PortError> {
    let anc =
        load_folder_ancestry_tx(tx, &space.id, parent_folder_id, require_active_folders).await?;
    let facts = ResourceFacts {
        space: space.clone(),
        class,
        project: anc.project.clone(),
        ancestor_folders: anc.ancestors.clone(),
        folder_write_locked: anc.write_locked,
        ability_package,
    };
    Ok((facts, anc))
}

pub(crate) async fn authorized_collision_revision_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &notarium_core::auth::EngineAuthContext,
    note: &NoteId,
) -> Result<Option<RevisionId>, PortError> {
    let Some(head) = load_note_head_row_opt_tx(tx, &space.id, note).await? else {
        return Ok(None);
    };
    if head.lifecycle == Lifecycle::Purged {
        return Err(DomainError::ResourceNotFound.into());
    }
    let (facts, _) = build_resource_facts_tx(
        tx,
        space,
        &head.parent_folder_id,
        head.doc_class,
        head.ability_id,
        false,
    )
    .await?;
    auth.authorize_direct_write(&facts, &facts)?;
    Ok(Some(head.head_rev_id))
}

pub(crate) async fn active_note_sibling_exists_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    parent_folder_id: &FolderId,
    slug_fold: &str,
    exclude_note_id: Option<&NoteId>,
) -> Result<bool, PortError> {
    let excl = exclude_note_id.map(NoteId::as_str).unwrap_or("");
    let found: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM note_heads
             WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ?
               AND lifecycle_state = 'active' AND note_id <> ?
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(parent_folder_id.as_str())
        .bind(slug_fold)
        .bind(excl)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_note_sibling_check", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM note_heads
             WHERE space_id = $1 AND parent_folder_id = $2 AND slug_fold = $3
               AND lifecycle_state = 'active' AND note_id <> $4
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(parent_folder_id.as_str())
        .bind(slug_fold)
        .bind(excl)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_note_sibling_check", err.to_string()))?,
    };
    Ok(found.is_some())
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct CurrentSpaceSchema {
    pub schema_revision: RevisionId,
    pub schema_note_id: NoteId,
    pub descriptor_fingerprint: ContentDigest,
    pub fields: BTreeMap<String, FieldSchema>,
}

pub(crate) async fn load_current_space_schema_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<Option<CurrentSpaceSchema>, PortError> {
    load_space_schema_tx(tx, space_id, None).await
}

pub(crate) async fn load_space_schema_revision_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    schema_rev_id: &RevisionId,
) -> Result<Option<CurrentSpaceSchema>, PortError> {
    load_space_schema_tx(tx, space_id, Some(schema_rev_id)).await
}

async fn load_space_schema_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    schema_rev_id: Option<&RevisionId>,
) -> Result<Option<CurrentSpaceSchema>, PortError> {
    let raw: Option<(String, String, Vec<u8>, Vec<u8>)> = match (tx, schema_rev_id) {
        (BackendConn::Sqlite(conn), None) => {
            let row = sqlx::query(
                "SELECT schema_rev_id, schema_note_id, descriptor_msgpack, descriptor_fingerprint
                 FROM space_field_schemas
                 WHERE space_id = ? AND is_current = 1
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_space_schema", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("schema_rev_id"),
                    r.get("schema_note_id"),
                    r.get("descriptor_msgpack"),
                    r.get("descriptor_fingerprint"),
                )
            })
        }
        (BackendConn::Sqlite(conn), Some(rev)) => {
            let row = sqlx::query(
                "SELECT schema_rev_id, schema_note_id, descriptor_msgpack, descriptor_fingerprint
                 FROM space_field_schemas
                 WHERE space_id = ?1 AND schema_rev_id = ?2
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(rev.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_load_space_schema_rev", err.to_string())
            })?;
            row.map(|r| {
                (
                    r.get("schema_rev_id"),
                    r.get("schema_note_id"),
                    r.get("descriptor_msgpack"),
                    r.get("descriptor_fingerprint"),
                )
            })
        }
        (BackendConn::Postgres(conn), None) => {
            let row = sqlx::query(
                "SELECT schema_rev_id, schema_note_id, descriptor_msgpack, descriptor_fingerprint
                 FROM space_field_schemas
                 WHERE space_id = $1 AND is_current = 1
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_space_schema", err))?;
            row.map(|r| {
                (
                    r.get("schema_rev_id"),
                    r.get("schema_note_id"),
                    r.get("descriptor_msgpack"),
                    r.get("descriptor_fingerprint"),
                )
            })
        }
        (BackendConn::Postgres(conn), Some(rev)) => {
            let row = sqlx::query(
                "SELECT schema_rev_id, schema_note_id, descriptor_msgpack, descriptor_fingerprint
                 FROM space_field_schemas
                 WHERE space_id = $1 AND schema_rev_id = $2
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(rev.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_space_schema_rev", err))?;
            row.map(|r| {
                (
                    r.get("schema_rev_id"),
                    r.get("schema_note_id"),
                    r.get("descriptor_msgpack"),
                    r.get("descriptor_fingerprint"),
                )
            })
        }
    };

    let Some((rev_raw, note_raw, msgpack, fp_bytes)) = raw else {
        return Ok(None);
    };
    let schema_revision = RevisionId::parse(&rev_raw)
        .map_err(|_| internal_not_committed("corrupt_schema_rev", "invalid schema_rev_id"))?;
    let schema_note_id = NoteId::parse(&note_raw)
        .map_err(|_| internal_not_committed("corrupt_schema_note", "invalid schema_note_id"))?;
    let arr: [u8; 32] = fp_bytes.try_into().map_err(|_| {
        internal_not_committed("corrupt_schema_fp", "descriptor_fingerprint != 32B")
    })?;
    let fields: BTreeMap<String, FieldSchema> =
        decode_msgpack_bounded(&msgpack, MAX_MSGPACK_DECODE_BYTES)?;

    Ok(Some(CurrentSpaceSchema {
        schema_revision,
        schema_note_id,
        descriptor_fingerprint: ContentDigest::from_bytes(arr),
        fields,
    }))
}

pub(crate) fn extract_note_title(
    carrier: &str,
    slug: &str,
    class: DocClass,
    raw_fields: Option<&BTreeMap<String, YamlValue>>,
    headings: &[notarium_core::document::Heading],
) -> String {
    if class == DocClass::EncryptedNote {
        return slug.to_owned();
    }
    if let Some(fields) = raw_fields
        && let Some(YamlValue::String(s)) = fields.get("title")
    {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    if let Some(h1) = headings.iter().find(|h| h.level == 1) {
        let trimmed = h1.title.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    let _ = carrier;
    slug.to_owned()
}

pub(crate) fn extract_note_preview(carrier: &str, class: DocClass) -> String {
    if class == DocClass::EncryptedNote {
        return String::new();
    }
    let body = match notarium_syntax::frontmatter::analyze(carrier, class) {
        Ok(hdr) => hdr.carrier.body.slice(carrier).unwrap_or(carrier),
        Err(_) => carrier,
    };
    let mut out = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("```") {
            continue;
        }
        let cleaned = trimmed.trim_start_matches('#').trim();
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(cleaned);
        if out.len() >= 180 {
            break;
        }
    }
    if out.chars().count() > 160 {
        out.chars().take(160).collect()
    } else {
        out
    }
}

pub(crate) async fn upsert_agent_run_head_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    run_id: &AgentRunId,
    actor_id: &PrincipalId,
    space_seq: SpaceSeq,
    visibility_seq: SpaceSeq,
    now_ts: Timestamp,
) -> Result<RevisionId, PortError> {
    let run_rev = new_revision_id()?;
    let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
        AgentRunRevisionMetadata {
            run_id: run_id.clone(),
            last_seq: visibility_seq,
        },
    ))
    .encode()?;
    insert_revision_row(
        tx,
        scope,
        &run_rev,
        "agent_run",
        run_id.as_str(),
        space_seq,
        visibility_seq,
        None,
        None,
        None,
        &meta,
        actor_id,
        Some(run_id),
        now_ts,
    )
    .await?;

    let (sec, nsec) = encode_timestamp_parts(now_ts);
    let last_i64 = visibility_seq.get() as i64;

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO agent_run_heads (
                    space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (space_id, run_id) DO UPDATE SET
                    history_incarnation = excluded.history_incarnation,
                    run_revision = excluded.run_revision,
                    last_seq = excluded.last_seq,
                    updated_at_sec = excluded.updated_at_sec,
                    updated_at_nsec = excluded.updated_at_nsec",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(run_id.as_str())
            .bind(run_rev.as_str())
            .bind(last_i64)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_upsert_agent_run", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO agent_run_heads (
                    space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (space_id, run_id) DO UPDATE SET
                    history_incarnation = EXCLUDED.history_incarnation,
                    run_revision = EXCLUDED.run_revision,
                    last_seq = EXCLUDED.last_seq,
                    updated_at_sec = EXCLUDED.updated_at_sec,
                    updated_at_nsec = EXCLUDED.updated_at_nsec",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(run_id.as_str())
            .bind(run_rev.as_str())
            .bind(last_i64)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_upsert_agent_run", err.to_string()))?;
        }
    }
    Ok(run_rev)
}

pub(crate) async fn check_collab_preconditions_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    preconditions: &Preconditions,
) -> Result<(), PortError> {
    if preconditions.lease.is_none() && preconditions.lineage.is_none() {
        return Ok(());
    }
    let session_opt: Option<(i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT lease_epoch, lineage_epoch FROM collab_sessions
                 WHERE space_id = ? AND note_id = ?",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_check_collab_prec", err.to_string()))?;
            row.map(|r| (r.get("lease_epoch"), r.get("lineage_epoch")))
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT lease_epoch, lineage_epoch FROM collab_sessions
                 WHERE space_id = $1 AND note_id = $2",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_check_collab_prec", err))?;
            row.map(|r| (r.get("lease_epoch"), r.get("lineage_epoch")))
        }
    };

    let (actual_lease, actual_lineage) = match session_opt {
        Some((le, li)) => (
            LeaseEpoch::new(u64::try_from(le).unwrap_or(0))?,
            LineageEpoch::new(u64::try_from(li).unwrap_or(0))?,
        ),
        None => (LeaseEpoch::ZERO, LineageEpoch::ZERO),
    };

    if let Some(expected_lease) = preconditions.lease
        && expected_lease != actual_lease
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if let Some(expected_lineage) = preconditions.lineage
        && expected_lineage != actual_lineage
    {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NoteRoomDirectWriteState {
    NoSessionRow,
    ClosedSessionRow,
    NeedsSettlement,
    ActiveOrFenced,
}

impl NoteRoomDirectWriteState {
    pub(crate) fn from_row(row: Option<(String, i64)>) -> Self {
        match row {
            None => Self::NoSessionRow,
            Some((state, dirty)) if state == "closed" => {
                if dirty == 0 {
                    Self::ClosedSessionRow
                } else {
                    Self::NeedsSettlement
                }
            }
            Some(_) => Self::ActiveOrFenced,
        }
    }

    /// Returns whether a closed lineage must be advanced with the carrier.
    pub(crate) fn require_writable(self) -> Result<bool, PortError> {
        match self {
            Self::NoSessionRow => Ok(false),
            Self::ClosedSessionRow => Ok(true),
            Self::NeedsSettlement => Err(crate::codec::unavailable_retryable(
                "collab_carrier_needs_settlement",
                "reconcile the closed room snapshot and remaining updates before replacing its carrier",
                std::time::Duration::from_millis(50),
            )),
            Self::ActiveOrFenced => Err(crate::codec::unavailable_retryable(
                "collab_room_not_closed",
                "note collaborative session is active or fenced awaiting recovery",
                std::time::Duration::from_millis(50),
            )),
        }
    }
}

pub(crate) async fn check_note_room_direct_write_tx(
    tx: &mut BackendConn<'_>,
    room_fences: &RoomFenceTable,
    scope: &HistoryScope,
    note_id: &NoteId,
) -> Result<NoteRoomDirectWriteState, PortError> {
    if room_fences.is_room_active(scope, note_id).await? {
        return Ok(NoteRoomDirectWriteState::ActiveOrFenced);
    }
    durable_note_room_state_tx(tx, &scope.space_id, note_id).await
}

pub(crate) async fn durable_note_room_state_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<NoteRoomDirectWriteState, PortError> {
    let row = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as::<_, (String, i64)>(
            "SELECT room_state, COALESCE(carrier_dirty, 0) FROM collab_sessions LEFT JOIN collab_checkpoints USING (space_id, note_id)
             WHERE space_id = ? AND note_id = ?",
        )
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .fetch_optional(&mut **conn)
        .await,
        BackendConn::Postgres(conn) => sqlx::query_as::<_, (String, i64)>(
            "SELECT room_state, COALESCE(carrier_dirty, 0) FROM collab_sessions LEFT JOIN collab_checkpoints USING (space_id, note_id)
             WHERE space_id = $1 AND note_id = $2",
        )
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .fetch_optional(&mut **conn)
        .await,
    }.map_err(|err| internal_not_committed("check_durable_room", err.to_string()))?;
    Ok(NoteRoomDirectWriteState::from_row(row))
}

pub(crate) async fn is_note_room_active_tx(
    tx: &mut BackendConn<'_>,
    room_fences: &RoomFenceTable,
    scope: &HistoryScope,
    note_id: &NoteId,
) -> Result<bool, PortError> {
    Ok(matches!(
        check_note_room_direct_write_tx(tx, room_fences, scope, note_id).await?,
        NoteRoomDirectWriteState::ActiveOrFenced
    ))
}

pub(crate) async fn sync_closed_collab_session_on_direct_write_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    new_carrier_rev: &RevisionId,
    updated_seq: SpaceSeq,
) -> Result<(), PortError> {
    if !durable_note_room_state_tx(tx, space_id, note_id)
        .await?
        .require_writable()?
    {
        return Ok(());
    }
    let seq_i64 = updated_seq.get() as i64;
    let affected = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query("DELETE FROM collab_checkpoints WHERE space_id = ? AND note_id = ?")
                .bind(space_id.as_str())
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_sync_clear_collab_checkpoint", err.to_string())
                })?;
            sqlx::query(
                "UPDATE collab_sessions
                 SET lineage_epoch = lineage_epoch + 1,
                     carrier_rev_id = ?,
                     yrs_snapshot_blob = NULL,
                     yrs_snapshot_blake3 = NULL,
                     updated_seq = ?
                 WHERE space_id = ? AND note_id = ? AND room_state = 'closed'",
            )
            .bind(new_carrier_rev.as_str())
            .bind(seq_i64)
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_sync_collab_lineage", err.to_string()))?
            .rows_affected()
        }
        BackendConn::Postgres(conn) => {
            sqlx::query("DELETE FROM collab_checkpoints WHERE space_id = $1 AND note_id = $2")
                .bind(space_id.as_str())
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_sync_clear_collab_checkpoint", err.to_string())
                })?;
            sqlx::query(
                "UPDATE collab_sessions
                 SET lineage_epoch = lineage_epoch + 1,
                     carrier_rev_id = $1,
                     yrs_snapshot_blob = NULL,
                     yrs_snapshot_blake3 = NULL,
                     updated_seq = $2
                 WHERE space_id = $3 AND note_id = $4 AND room_state = 'closed'",
            )
            .bind(new_carrier_rev.as_str())
            .bind(seq_i64)
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_sync_collab_lineage", err.to_string()))?
            .rows_affected()
        }
    };
    if affected > 0 {
        let _ = crate::blobs::release_owner_blob_refs_tx(
            tx,
            space_id,
            crate::blobs::BlobOwnerKind::CollabSnapshot,
            note_id.as_str(),
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn insert_note_alias_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    old_parent_folder_id: &FolderId,
    old_slug_fold: &str,
    old_title_norm: &str,
    target_note_id: &NoteId,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let seq_i64 = created_seq.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT OR IGNORE INTO note_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, old_title_norm, target_note_id, created_seq
                 ) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(old_title_norm)
            .bind(target_note_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_note_alias", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO note_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, old_title_norm, target_note_id, created_seq
                 ) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(old_title_norm)
            .bind(target_note_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_note_alias", err.to_string()))?;
        }
    }
    Ok(())
}

pub(crate) async fn insert_folder_alias_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    old_parent_folder_id: &FolderId,
    old_slug_fold: &str,
    target_folder_id: &FolderId,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let seq_i64 = created_seq.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT OR IGNORE INTO folder_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, target_folder_id, created_seq
                 ) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(target_folder_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_folder_alias", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO folder_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, target_folder_id, created_seq
                 ) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT DO NOTHING",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(target_folder_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_folder_alias", err.to_string()))?;
        }
    }
    Ok(())
}

// ============================================================================
// Serializable Receipt Wire Envelopes (MessagePack-safe, adjacently tagged)
// ============================================================================

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedNoteRevV1 {
    pub value: NoteRevision,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedNoteRevV1 {
    pub fn into_committed(self) -> Committed<NoteRevision> {
        Committed {
            value: self.value,
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedFolderRefV1 {
    pub value: FolderRef,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedFolderRefV1 {
    pub fn into_committed(self) -> Committed<FolderRef> {
        Committed {
            value: self.value,
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "target_kind",
    content = "target_data",
    rename_all = "snake_case"
)]
pub(crate) enum StoredLinkTargetV1 {
    Note(NoteId),
    Folder(FolderId),
    AuthoredName(String),
}

impl From<&LinkTarget> for StoredLinkTargetV1 {
    fn from(value: &LinkTarget) -> Self {
        match value {
            LinkTarget::Note(id) => Self::Note(id.clone()),
            LinkTarget::Folder(id) => Self::Folder(id.clone()),
            LinkTarget::AuthoredName(name) => Self::AuthoredName(name.clone()),
        }
    }
}

impl From<StoredLinkTargetV1> for LinkTarget {
    fn from(value: StoredLinkTargetV1) -> Self {
        match value {
            StoredLinkTargetV1::Note(id) => Self::Note(id),
            StoredLinkTargetV1::Folder(id) => Self::Folder(id),
            StoredLinkTargetV1::AuthoredName(name) => Self::AuthoredName(name),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedLinkV1 {
    pub source: NoteId,
    pub target: StoredLinkTargetV1,
    pub relation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_title: Option<String>,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedLinkV1 {
    pub fn from_link(link: &Link, receipt: MutationReceiptToken) -> Self {
        Self {
            source: link.source.clone(),
            target: StoredLinkTargetV1::from(&link.target),
            relation: link.relation.clone(),
            target_title: link.target_title.clone(),
            receipt,
        }
    }

    pub fn into_committed(self) -> Committed<Link> {
        Committed {
            value: Link {
                source: self.source,
                target: self.target.into(),
                relation: self.relation,
                target_title: self.target_title,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedAbilityRevV1 {
    pub ability: AbilityId,
    pub revision: RevisionId,
    pub manifest: BTreeMap<String, ContentDigest>,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedAbilityRevV1 {
    pub fn into_committed(self) -> Committed<AbilityPackageRevision> {
        Committed {
            value: AbilityPackageRevision {
                ability: self.ability,
                revision: self.revision,
                manifest: self.manifest,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedMintAndPurgeV1 {
    pub old_note: NoteId,
    pub new_note: NoteRevision,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedMintAndPurgeV1 {
    pub fn into_committed(self) -> Committed<MintAndPurgeResult> {
        Committed {
            value: MintAndPurgeResult {
                old_note: self.old_note,
                new_note: self.new_note,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedBoardMoveV1 {
    pub revision: NoteRevision,
    pub rank_revision: RevisionId,
    pub group: GroupKey,
    pub rank: String,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedBoardMoveV1 {
    pub fn into_committed(self) -> Committed<BoardMoveResult> {
        Committed {
            value: BoardMoveResult {
                revision: self.revision,
                rank_revision: self.rank_revision,
                group: self.group,
                rank: self.rank,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedRollbackV1 {
    pub restored: Vec<NoteRevision>,
    pub trashed: Vec<NoteRevision>,
    pub restored_ranks: Vec<RestoredBoardRank>,
    pub skipped_manual_edits: Vec<NoteId>,
    pub skipped_room_active: Vec<NoteId>,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedRollbackV1 {
    pub(crate) fn sanitized(receipt: MutationReceiptToken) -> Self {
        Self {
            restored: Vec::new(),
            trashed: Vec::new(),
            restored_ranks: Vec::new(),
            skipped_manual_edits: Vec::new(),
            skipped_room_active: Vec::new(),
            receipt,
        }
    }

    pub(crate) fn disclosed_notes(&self) -> impl Iterator<Item = &NoteId> {
        self.restored
            .iter()
            .chain(&self.trashed)
            .map(|head| &head.note)
            .chain(&self.skipped_manual_edits)
            .chain(&self.skipped_room_active)
            .chain(self.restored_ranks.iter().map(|rank| &rank.note))
    }

    /// Effect pointers retain their original owners. A receipt can also disclose
    /// notes whose history was skipped and both ends of a restored board rank.
    pub(crate) fn receipt_owners(&self, mut changed: Vec<NoteId>) -> Vec<NoteId> {
        if !(self.skipped_manual_edits.is_empty()
            && self.skipped_room_active.is_empty()
            && self.restored_ranks.is_empty())
        {
            changed.extend(
                self.skipped_manual_edits
                    .iter()
                    .chain(&self.skipped_room_active)
                    .cloned(),
            );
            for rank in &self.restored_ranks {
                changed.push(rank.note.clone());
                changed.push(rank.view.note.clone());
            }
            changed.sort_unstable();
            changed.dedup();
        }
        changed
    }

    pub fn into_committed(self) -> Committed<RollbackResult> {
        Committed {
            value: RollbackResult {
                restored: self.restored,
                trashed: self.trashed,
                restored_ranks: self.restored_ranks,
                skipped_manual_edits: self.skipped_manual_edits,
                skipped_room_active: self.skipped_room_active,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedSchemaRevV1 {
    pub value: SpaceSchemaRevision,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedSchemaRevV1 {
    pub fn into_committed(self) -> Committed<SpaceSchemaRevision> {
        Committed {
            value: self.value,
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "outcome", content = "data", rename_all = "snake_case")]
pub(crate) enum StoredExternalObsOutcomeV1 {
    Committed {
        #[serde(flatten)]
        result: StoredCommittedNoteRevV1,
        // Older receipts retain value and receipt without a validated plan.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        verified_plan: Option<ContentDigest>,
    },
    NoChange {
        revision: RevisionId,
    },
    Conflict {
        current: RevisionId,
    },
}

#[cfg(test)]
mod room_fence_bounds_tests {
    use super::*;
    use notarium_core::ids::{CommandKey, HistoryIncarnation};

    #[tokio::test]
    async fn room_fence_table_bounds_idle_closed_and_recovery_entries() {
        let table = RoomFenceTable::default();
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([1; 16]),
            incarnation: HistoryIncarnation::from_bytes([2; 16]),
        };
        let actor = PrincipalId::from_bytes([3; 16]);
        let lease = LeaseEpoch::new(1).unwrap();

        // Opening and closing >2048 distinct notes evicts idle closed entries.
        for i in 0..2500u32 {
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            let note = NoteId::from_bytes(bytes);
            table.open_room(&scope, &note).await.unwrap();
            table.close_room(&scope, &note).await.unwrap();
        }
        assert!(
            table.fences.lock().unwrap().entries.len() <= 2048,
            "idle closed room fences must be bounded"
        );

        // Closed-note reservations on never-opened notes do not insert entries.
        let before = table.fences.lock().unwrap().entries.len();
        for i in 5000..5200u32 {
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            let note = NoteId::from_bytes(bytes);
            let id = CommandIdentity {
                scope: scope.clone(),
                actor: actor.clone(),
                key: CommandKey::from_bytes(bytes),
                hash: ContentDigest::from_bytes([9; 32]),
            };
            let _res = table.try_reserve_if_closed(&scope, &note, id).unwrap();
        }
        assert_eq!(table.fences.lock().unwrap().entries.len(), before);

        // Writer-side consumption of >2048 never-opened notes stays bounded.
        for i in 6000..8500u32 {
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            let note = NoteId::from_bytes(bytes);
            let id = CommandIdentity {
                scope: scope.clone(),
                actor: actor.clone(),
                key: CommandKey::from_bytes(bytes),
                hash: ContentDigest::from_bytes([9; 32]),
            };
            let res = table
                .try_reserve_if_closed(&scope, &note, id.clone())
                .unwrap();
            assert!(
                table
                    .consume_reservation_blocking(&scope, &note, res, &id)
                    .is_ok()
            );
        }
        assert!(table.fences.lock().unwrap().entries.len() <= 2048);

        // Tracked reservation pinned against eviction survives >2500 idle churn.
        let pinned_note = NoteId::from_bytes([0xaa; 16]);
        table.open_room(&scope, &pinned_note).await.unwrap();
        table.close_room(&scope, &pinned_note).await.unwrap();
        let pinned_id = CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xaa; 16]),
            hash: ContentDigest::from_bytes([7; 32]),
        };
        let pinned_res = table
            .try_reserve_if_closed(&scope, &pinned_note, pinned_id.clone())
            .unwrap();
        for i in 10_000..12_600u32 {
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            let note = NoteId::from_bytes(bytes);
            table.open_room(&scope, &note).await.unwrap();
            table.close_room(&scope, &note).await.unwrap();
        }
        assert!(
            table
                .consume_reservation_blocking(&scope, &pinned_note, pinned_res, &pinned_id)
                .is_ok(),
            "pinned in-flight reservation must not suffer spurious SourceMismatch on eviction"
        );

        // Stale reservation captured before open+close+eviction MUST be rejected
        // (eviction_gen prevents matching a recreated zero-epoch slot).
        let stale_table = RoomFenceTable::default();
        let victim = NoteId::from_bytes([0xbb; 16]);
        let victim_id = CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xbb; 16]),
            hash: ContentDigest::from_bytes([8; 32]),
        };
        let stale_res = stale_table
            .try_reserve_if_closed(&scope, &victim, victim_id.clone())
            .unwrap();
        stale_table.open_room(&scope, &victim).await.unwrap();
        stale_table.close_room(&scope, &victim).await.unwrap();
        // Force eviction past deferred cap while stale_res is held.
        for i in 20_000..24_500u32 {
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            let note = NoteId::from_bytes(bytes);
            stale_table.open_room(&scope, &note).await.unwrap();
            stale_table.close_room(&scope, &note).await.unwrap();
        }
        assert!(
            !stale_table
                .fences
                .lock()
                .unwrap()
                .entries
                .contains_key(&(scope.space_id.clone(), victim.clone())),
            "victim entry should have been evicted"
        );
        let stale_err = stale_table
            .consume_reservation_blocking(&scope, &victim, stale_res, &victim_id)
            .unwrap_err();
        assert!(
            matches!(
                &stale_err,
                PortError::Domain(DomainError::ValidationFailed { diagnostic })
                    if diagnostic.reason == ValidationReason::SourceMismatch
            ),
            "stale pre-eviction reservation must be rejected, got {stale_err:?}"
        );

        // Recovery cache stays bounded even across >4096 fenced recoveries.
        for i in 0..4300u32 {
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            let note = NoteId::from_bytes(bytes);
            let lock = table.get_or_init(&scope, &note);
            let mut guard = lock.lock_owned().await;
            let prev = RevisionId::from_bytes(bytes);
            let mut next_bytes = bytes;
            next_bytes[15] = 1;
            let rev = RevisionId::from_bytes(next_bytes);
            let next_state = RoomFenceState::new(note.clone(), scope.clone(), lease);
            assert!(table.publish_persisted_transition(
                &scope,
                &note,
                &mut guard,
                next_state,
                false,
                Some((prev, rev)),
            ));
        }
        assert!(
            table.recovery.lock().unwrap().recovered.len() <= 4096,
            "recovered fence cache must stay bounded"
        );
    }

    #[tokio::test]
    async fn takeover_sync_rejects_stale_restore_and_older_epoch_interleavings() {
        let table = RoomFenceTable::default();
        let space_id = SpaceId::from_bytes([0x41; 16]);
        let scope_i1 = HistoryScope {
            space_id: space_id.clone(),
            incarnation: HistoryIncarnation::from_bytes([0x01; 16]),
        };
        let scope_i2 = HistoryScope {
            space_id: space_id.clone(),
            incarnation: HistoryIncarnation::from_bytes([0x02; 16]),
        };
        let n1 = NoteId::from_bytes([0x51; 16]);
        let n2 = NoteId::from_bytes([0x52; 16]);

        // 1. Stale takeover(I1) paused before apply_takeover_transition must not
        //    overwrite a concurrent Space restore(I2).
        let (sync_i1, targets_i1) = table
            .begin_space_takeover_sync(
                &scope_i1,
                LeaseEpoch::new(2).unwrap(),
                vec![(n1.clone(), LeaseEpoch::new(1).unwrap())],
            )
            .expect("initial takeover sync");

        let restored = RoomFenceTable::default();
        restored.set_room_fenced(&space_id, &n2, true);
        let restored_lock = restored.get_or_init(&scope_i2, &n2);
        {
            let mut g = restored_lock.lock_owned().await;
            let _ = restored.publish_persisted_transition(
                &scope_i2,
                &n2,
                &mut g,
                RoomFenceState::new(n2.clone(), scope_i2.clone(), LeaseEpoch::new(4).unwrap()),
                true,
                None,
            );
        }
        let spaces = BTreeSet::from([&space_id]);
        table.replace_restored_spaces(&spaces, restored);

        for (note, (lock, fenced_epoch)) in targets_i1 {
            let mut guard = lock.lock_owned().await;
            assert!(
                !table.apply_takeover_transition(
                    &scope_i1,
                    LeaseEpoch::new(2).unwrap(),
                    sync_i1,
                    &note,
                    &mut guard,
                    fenced_epoch,
                ),
                "stale pre-restore takeover must be rejected"
            );
        }
        assert!(table.is_room_fenced(&space_id, &n2));
        assert!(!table.is_room_fenced(&space_id, &n1));

        // 2. Stale takeover(epoch=2) superseded by takeover(epoch=3) must not
        //    clobber epoch=3's live active or fenced slots, and a late epoch=2
        //    begin_space_takeover_sync must return None.
        let (sync_e2, targets_e2) = table
            .begin_space_takeover_sync(
                &scope_i2,
                LeaseEpoch::new(2).unwrap(),
                vec![(n1.clone(), LeaseEpoch::new(1).unwrap())],
            )
            .expect("epoch 2 sync");
        let (sync_e3, targets_e3) = table
            .begin_space_takeover_sync(
                &scope_i2,
                LeaseEpoch::new(3).unwrap(),
                vec![(n2.clone(), LeaseEpoch::new(2).unwrap())],
            )
            .expect("epoch 3 sync supersedes epoch 2");
        assert!(
            table
                .begin_space_takeover_sync(
                    &scope_i2,
                    LeaseEpoch::new(2).unwrap(),
                    vec![(n1.clone(), LeaseEpoch::new(1).unwrap())],
                )
                .is_none(),
            "older epoch takeover must not supersede newer epoch sync"
        );
        for (note, (lock, fenced_epoch)) in targets_e3 {
            let mut guard = lock.lock_owned().await;
            assert!(table.apply_takeover_transition(
                &scope_i2,
                LeaseEpoch::new(3).unwrap(),
                sync_e3,
                &note,
                &mut guard,
                fenced_epoch,
            ));
        }
        table.open_room(&scope_i2, &n1).await.unwrap();
        for (note, (lock, fenced_epoch)) in targets_e2 {
            let mut guard = lock.lock_owned().await;
            assert!(
                !table.apply_takeover_transition(
                    &scope_i2,
                    LeaseEpoch::new(2).unwrap(),
                    sync_e2,
                    &note,
                    &mut guard,
                    fenced_epoch,
                ),
                "superseded epoch 2 takeover must be rejected"
            );
        }
        assert!(table.is_room_active(&scope_i2, &n1).await.unwrap());
        assert!(table.is_room_fenced(&space_id, &n2));
        assert!(!table.is_room_fenced(&space_id, &n1));
    }
}
