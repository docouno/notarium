//! Current canonical visibility for retained and asynchronously built read cuts.

mod registration;
mod source;

pub use registration::{ProjectionCleanupRegistration, StoppedProjectionDeployment};

#[cfg(feature = "test-support")]
mod census;
#[cfg(feature = "test-support")]
pub use census::FenceCensusFixture;
pub(crate) use source::{ensure_postgres_owner_table, internal_budget};

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    mem::size_of,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use notarium_core::{
    DomainError,
    auth::{ResourceFacts, Space, SpaceLifecycle},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        AbilityId, ChatThreadId, FolderId, LeaseEpoch, NoteId, ProjectionGeneration, SpaceId,
        SpaceSeq, ThreadEntrySeq,
    },
    model::{HistoryScope, Lifecycle},
    ports::{
        CallBudget, Committed, MaintenanceContext, PortFuture, RedactedChat, ServicePurpose,
        SpaceContext,
    },
};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::{
    CanonicalStore,
    domain::common::MAX_FOLDER_DEPTH,
    runtime::{SpaceRecord, SqlDriverState},
};

use self::source::{FolderRow, NoteRow};

const MAX_PRIVATE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DELTA_NOTES: usize = 16_384;
const MAX_TRACKED_CHANGES: usize = 4_096;
const PAGE_ROWS: usize = 4_096;
const NO_PARENT: u32 = u32::MAX;
const SLOT_CHUNK: usize = 65_536;

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}

/// The immutable note directory belonging to a trusted structural checkpoint.
///
/// A slot must map back to exactly its original identity for the lifetime of
/// the directory. The lookup may use shared file-backed pages.
pub trait LiveDenseLookup: Send + Sync {
    fn slots(&self) -> u32;
    fn dense_id(&self, note: &NoteId) -> Option<u32>;

    /// Lookup replacements in a generation preserve all previously assigned
    /// slots. Implementations without this guarantee omit the generation.
    fn generation(&self) -> Option<ProjectionGeneration> {
        None
    }

    fn published_seq(&self) -> Option<SpaceSeq> {
        None
    }
}

/// Current-resource metadata classification. This metadata check is untainted.
/// Callers yielding content still use the appropriate authorizing read method.
#[derive(Debug, Clone, Eq, PartialEq)]
pub enum LiveNoteStatus {
    PurgedOrAbsent,
    HiddenByAuth {
        is_active_plain: bool,
    },
    ActiveVisible(ResourceFacts),
    EncryptedVisible {
        facts: ResourceFacts,
        effective_lifecycle: Lifecycle,
    },
    TrashedVisible(ResourceFacts),
}

/// Accounted private fence backing capacity and logical size of an admission.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct FenceMemoryUsage {
    pub dense_slots: usize,
    pub delta_notes: usize,
    pub folders: usize,
    pub private_bytes: usize,
    pub peak_private_bytes: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProjectionRedactedEntry {
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
    pub redacted_at: SpaceSeq,
}

/// Durable erasures discovered in a canonical command window.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProjectionErasures {
    pub scope: HistoryScope,
    pub through: SpaceSeq,
    pub purged: Vec<NoteId>,
    pub redacted: Vec<ProjectionRedactedEntry>,
}

/// Durable identity of the runtime whose admission must be revoked.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProjectionOwnerIdentity {
    scope: HistoryScope,
    epoch: LeaseEpoch,
    process: String,
}

impl ProjectionOwnerIdentity {
    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }

    pub fn epoch(&self) -> LeaseEpoch {
        self.epoch
    }

    pub fn process(&self) -> &str {
        &self.process
    }
}

/// Trusted composition may attest that the named process cannot serve again.
/// A disconnected database session or missing heartbeat cannot support this
/// proof. The capability has no transport decoder.
pub struct StoppedProjectionOwner(ProjectionOwnerIdentity);

impl StoppedProjectionOwner {
    pub fn attest(identity: ProjectionOwnerIdentity) -> Self {
        Self(identity)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct VisibilityChanges {
    pub notes: bool,
    pub folders: bool,
    pub erasures: bool,
}

impl VisibilityChanges {
    pub(crate) const fn all() -> Self {
        Self {
            notes: true,
            folders: true,
            erasures: true,
        }
    }

    pub(crate) fn from_events(events: &[crate::writer::BatchEventDraft]) -> Self {
        let mut out = Self::default();
        for ev in events {
            match (ev.entity_type.as_str(), ev.op_kind.as_str()) {
                ("note", "edit" | "rename") => {}
                ("note", _) | ("ability", _) => out.notes = true,
                ("folder", _) => out.folders = true,
                _ => {}
            }
            if ev.op_kind == "purge" || ev.op_kind == "redact" {
                out.erasures = true;
            }
        }
        out
    }

    pub(crate) fn merge(&mut self, other: Self) {
        self.notes |= other.notes;
        self.folders |= other.folders;
        self.erasures |= other.erasures;
    }
}

#[derive(Clone)]
pub(crate) struct VisibilityWindow {
    pub scope: HistoryScope,
    pub after: SpaceSeq,
    pub through: SpaceSeq,
    pub changes: VisibilityChanges,
}

/// Physically removes erasable derived data before a successful command reply.
/// The callback is idempotent and may access canonical maintenance reads. It
/// must not acquire final-delivery permits or enter a canonical writer. The
/// calling store supplies current history even after a writer is reopened.
pub trait ProjectionVisibilityCleanup: Send + Sync {
    fn erase_visibility<'a>(
        &'a self,
        canonical: &'a CanonicalStore,
        erasures: &'a ProjectionErasures,
    ) -> PortFuture<'a, ()>;
}

struct LiveState {
    record: SpaceRecord,
    readable: bool,
    lookup_retired: bool,
    retired_before: Option<SpaceSeq>,
    lookup: Option<Arc<dyn LiveDenseLookup>>,
    lookup_generation: Option<ProjectionGeneration>,
    dense: DenseSlots,
    abilities: HashMap<u32, AbilityId>,
    delta: HashMap<NoteId, NoteHead>,
    folder_slots: HashMap<FolderId, u32>,
    folders: Vec<FolderNode>,
    changes_after: SpaceSeq,
    note_changes: VecDeque<(SpaceSeq, NoteId)>,
    peak_private_bytes: usize,
}

// Separate arrays keep each slot at five bytes. Chunks avoid reallocating the
// whole fence when the checkpoint grows by an append-only suffix.
struct DenseChunk {
    parents: Vec<u32>,
    flags: Vec<u8>,
}

#[derive(Default)]
struct DenseSlots {
    chunks: Vec<DenseChunk>,
    len: usize,
}

impl DenseSlots {
    fn extend_to(&mut self, total: usize) {
        while self.len < total {
            let local = self.len % SLOT_CHUNK;
            if local == 0 {
                self.chunks.push(DenseChunk {
                    parents: Vec::new(),
                    flags: Vec::new(),
                });
            }
            let chunk = self.chunks.last_mut().expect("dense append chunk");
            let additional = (total - self.len).min(SLOT_CHUNK - local);
            chunk.parents.reserve_exact(additional);
            chunk.flags.reserve_exact(additional);
            chunk.parents.resize(local + additional, NO_PARENT);
            chunk.flags.resize(local + additional, 0);
            self.len += additional;
        }
    }

    fn get(&self, index: u32) -> Option<(u32, u8)> {
        let index = index as usize;
        let chunk = self.chunks.get(index / SLOT_CHUNK)?;
        let local = index % SLOT_CHUNK;
        Some((*chunk.parents.get(local)?, *chunk.flags.get(local)?))
    }

    fn update(&mut self, index: u32, parent: u32, flags: u8) {
        let index = index as usize;
        let chunk = &mut self.chunks[index / SLOT_CHUNK];
        let local = index % SLOT_CHUNK;
        chunk.parents[local] = parent;
        chunk.flags[local] = flags;
    }

    fn allocated_capacity(&self) -> usize {
        self.chunks.capacity() * size_of::<DenseChunk>()
            + self
                .chunks
                .iter()
                .map(|chunk| chunk.parents.capacity() * size_of::<u32>() + chunk.flags.capacity())
                .sum::<usize>()
    }
}

struct NoteHead {
    parent: u32,
    class: DocClass,
    lifecycle: Lifecycle,
    ability: Option<AbilityId>,
}

struct FolderNode {
    id: FolderId,
    parent: Option<u32>,
    lifecycle: Lifecycle,
    write_locked: bool,
}

impl LiveState {
    fn new(
        record: SpaceRecord,
        lookup: Option<Arc<dyn LiveDenseLookup>>,
    ) -> Result<Self, PortError> {
        let slots = lookup.as_ref().map_or(0, |lookup| lookup.slots()) as usize;
        if slots > MAX_PRIVATE_BYTES / 5 {
            return Err(not_ready());
        }
        let mut dense = DenseSlots::default();
        dense.extend_to(slots);
        let changes_after = record.last_seq;
        let lookup_generation = lookup.as_ref().and_then(|lookup| lookup.generation());
        let mut state = Self {
            record,
            readable: true,
            lookup_retired: false,
            retired_before: None,
            lookup,
            lookup_generation,
            dense,
            abilities: HashMap::new(),
            delta: HashMap::new(),
            folder_slots: HashMap::new(),
            folders: Vec::new(),
            changes_after,
            note_changes: VecDeque::new(),
            peak_private_bytes: 0,
        };
        state.peak_private_bytes = state.allocated_capacity();
        Ok(state)
    }

    fn update_lookup(&mut self, lookup: Arc<dyn LiveDenseLookup>) -> Result<bool, PortError> {
        let Some(generation) = lookup.generation() else {
            return Ok(false);
        };
        if self.lookup.as_ref().and_then(|old| old.generation()) != Some(generation) {
            return Ok(false);
        }
        let slots = lookup.slots() as usize;
        if slots < self.dense.len || slots > MAX_PRIVATE_BYTES / 5 {
            return Err(not_ready());
        }
        self.dense.extend_to(slots);
        self.lookup = Some(lookup.clone());
        self.delta.retain(|note, head| {
            let Some(slot) = lookup.dense_id(note) else {
                return true;
            };
            if (slot as usize) >= slots {
                return true;
            }
            self.dense
                .update(slot, head.parent, encode_flags(head.lifecycle, head.class));
            if let Some(ability) = head.ability.take() {
                self.abilities.insert(slot, ability);
            }
            false
        });
        self.delta.shrink_to_fit();
        self.enforce_limit()?;
        self.lookup_retired = false;
        Ok(true)
    }

    fn retire_lookup_before(&mut self, seq: SpaceSeq) {
        self.retired_before = Some(self.retired_before.map_or(seq, |prev| prev.max(seq)));
        if self.lookup.as_ref().is_some_and(|lookup| {
            lookup
                .published_seq()
                .is_none_or(|published| published < seq)
        }) {
            self.lookup_retired = true;
            self.lookup = None;
        }
    }

    fn change_notes(&mut self, head: SpaceSeq, notes: &[NoteRow], has_folder_changes: bool) {
        if has_folder_changes {
            self.changes_after = head;
            self.note_changes.clear();
            return;
        }
        for note in notes {
            if self.note_changes.len() == MAX_TRACKED_CHANGES
                && let Some((seq, _)) = self.note_changes.pop_front()
            {
                self.changes_after = self.changes_after.max(seq);
            }
            self.note_changes.push_back((head, note.id.clone()));
        }
    }

    fn folder_slot(&mut self, id: FolderId) -> Result<u32, PortError> {
        if let Some(slot) = self.folder_slots.get(&id) {
            return Ok(*slot);
        }
        let slot = u32::try_from(self.folders.len()).map_err(|_| not_ready())?;
        self.folder_slots.insert(id.clone(), slot);
        self.folders.push(FolderNode {
            id,
            parent: None,
            lifecycle: Lifecycle::Purged,
            write_locked: false,
        });
        Ok(slot)
    }

    fn apply_folder(&mut self, row: FolderRow) -> Result<(), PortError> {
        let index = self.folder_slot(row.id)?;
        let parent = row
            .parent
            .map(|parent| self.folder_slot(parent))
            .transpose()?;
        self.folders[index as usize] = FolderNode {
            id: self.folders[index as usize].id.clone(),
            parent,
            lifecycle: row.lifecycle,
            write_locked: row.write_locked,
        };
        self.enforce_limit()
    }

    fn apply_note(&mut self, row: NoteRow) -> Result<(), PortError> {
        let dense = self
            .lookup
            .as_ref()
            .and_then(|lookup| lookup.dense_id(&row.id));
        let present = row.lifecycle != Lifecycle::Purged;
        if let Some(dense) = dense {
            if dense as usize >= self.dense.len {
                return Err(not_ready());
            }
            let parent = if present {
                self.folder_slot(row.parent.ok_or_else(not_ready)?)?
            } else {
                NO_PARENT
            };
            self.dense
                .update(dense, parent, encode_flags(row.lifecycle, row.class));
            match row.ability.filter(|_| present) {
                Some(ability) => self.abilities.insert(dense, ability),
                None => self.abilities.remove(&dense),
            };
        } else if present {
            let parent = self.folder_slot(row.parent.ok_or_else(not_ready)?)?;
            self.delta.insert(
                row.id,
                NoteHead {
                    parent,
                    class: row.class,
                    lifecycle: row.lifecycle,
                    ability: row.ability,
                },
            );
        } else {
            self.delta.remove(&row.id);
        }
        self.enforce_limit()
    }

    fn note(&self, id: &NoteId) -> Option<(u32, DocClass, Lifecycle, Option<&AbilityId>)> {
        if let Some(slot) = self.lookup.as_ref().and_then(|lookup| lookup.dense_id(id)) {
            let (parent, flags) = self.dense.get(slot)?;
            let (class, lifecycle) = decode_flags(flags)?;
            Some((parent, class, lifecycle, self.abilities.get(&slot)))
        } else {
            let note = self.delta.get(id)?;
            Some((
                note.parent,
                note.class,
                note.lifecycle,
                note.ability.as_ref(),
            ))
        }
    }

    fn ancestry(&self, start: u32) -> Option<(Vec<FolderId>, bool, bool)> {
        let mut ancestors = Vec::new();
        let mut slot = start;
        let mut write_locked = false;
        let mut trashed = false;
        // A cycle cannot reach the permanent root. The depth bound also caps
        // accumulation if an invalid folder topology reaches storage.
        for _ in 0..=MAX_FOLDER_DEPTH {
            let node = self.folders.get(slot as usize)?;
            trashed |= node.lifecycle != Lifecycle::Active;
            write_locked |= node.write_locked;
            ancestors.push(node.id.clone());
            match node.parent {
                Some(parent) => slot = parent,
                None if node.id == self.record.root_folder_id => {
                    return Some((ancestors, write_locked, trashed));
                }
                None => return None,
            }
        }
        None
    }

    fn release_private_memory(&mut self) {
        self.readable = false;
        self.lookup = None;
        self.dense = DenseSlots::default();
        self.abilities = HashMap::new();
        self.delta = HashMap::new();
        self.folder_slots = HashMap::new();
        self.folders = Vec::new();
        self.note_changes = VecDeque::new();
    }

    fn enforce_limit(&mut self) -> Result<(), PortError> {
        let bytes = self.allocated_capacity();
        self.peak_private_bytes = self.peak_private_bytes.max(bytes);
        if self.delta.len() > MAX_DELTA_NOTES || bytes > MAX_PRIVATE_BYTES {
            return Err(not_ready());
        }
        Ok(())
    }

    fn memory_usage(&self) -> FenceMemoryUsage {
        FenceMemoryUsage {
            dense_slots: self.dense.len,
            delta_notes: self.delta.len(),
            folders: self.folders.len(),
            private_bytes: self.allocated_capacity(),
            peak_private_bytes: self.peak_private_bytes,
        }
    }

    fn allocated_capacity(&self) -> usize {
        // Hash tables reserve control bytes as well as entries. Their bucket
        // count is conservatively rounded up from 7/8 usable capacity. IDs are
        // owned strings, whose supported maximum encoded length is 40 bytes.
        fn table<K, V>(map: &HashMap<K, V>, identifier_heaps: usize) -> usize {
            let buckets = if map.capacity() == 0 {
                0
            } else {
                map.capacity()
                    .saturating_mul(8)
                    .div_ceil(7)
                    .next_power_of_two()
            };
            buckets.saturating_mul(size_of::<(K, V)>() + 1)
                + map.len().saturating_mul(identifier_heaps)
        }
        self.dense.allocated_capacity()
            + self.folders.capacity() * size_of::<FolderNode>()
            + self.folders.len() * 40
            + table(&self.folder_slots, 40)
            + table(&self.abilities, 40)
            + table(&self.delta, 80)
            + self.note_changes.capacity() * size_of::<(SpaceSeq, NoteId)>()
            + self.note_changes.len() * 40
            + size_of::<Gate>()
            + size_of::<LiveState>()
            + 256
    }
}

fn encode_flags(lifecycle: Lifecycle, class: DocClass) -> u8 {
    let lifecycle_bits = match lifecycle {
        Lifecycle::Purged => return 0,
        Lifecycle::Active => 0x10,
        Lifecycle::Trashed => 0x20,
    };
    let class_bits = match class {
        DocClass::UserDoc => 0,
        DocClass::EncryptedNote => 1,
        DocClass::AgentMemory => 2,
        DocClass::Skill => 3,
        DocClass::Profile => 4,
    };
    lifecycle_bits | class_bits
}

fn decode_flags(flags: u8) -> Option<(DocClass, Lifecycle)> {
    let lifecycle = match flags & 0xf0 {
        0x10 => Lifecycle::Active,
        0x20 => Lifecycle::Trashed,
        _ => return None,
    };
    let class = match flags & 0x0f {
        0 => DocClass::UserDoc,
        1 => DocClass::EncryptedNote,
        2 => DocClass::AgentMemory,
        3 => DocClass::Skill,
        4 => DocClass::Profile,
        _ => return None,
    };
    Some((class, lifecycle))
}

enum GateData {
    Empty,
    Active(Box<LiveState>),
    Revoked,
}

impl GateData {
    fn state(&self) -> Option<&LiveState> {
        match self {
            Self::Active(state) => Some(state),
            _ => None,
        }
    }

    fn state_mut(&mut self) -> Option<&mut LiveState> {
        match self {
            Self::Active(state) => Some(state),
            _ => None,
        }
    }
}

type Gate = Arc<RwLock<GateData>>;
type Topology = BTreeMap<SpaceId, Gate>;

#[derive(Clone, Debug)]
struct SuspendedWatermark {
    scope: HistoryScope,
    active_epoch: LeaseEpoch,
    lookup_generation: Option<ProjectionGeneration>,
    retired_before: Option<SpaceSeq>,
}

#[derive(Clone)]
pub struct LiveLifecycleFence {
    topology: Arc<std::sync::RwLock<Topology>>,
    closed: Arc<AtomicBool>,
    process: Arc<str>,
    cleanup: Arc<std::sync::RwLock<Option<Arc<dyn ProjectionVisibilityCleanup>>>>,
    cleanup_debt: Arc<std::sync::Mutex<HashMap<HistoryScope, (SpaceSeq, SpaceSeq)>>>,
    suspended_watermarks: Arc<std::sync::Mutex<HashMap<SpaceId, SuspendedWatermark>>>,
}

impl LiveLifecycleFence {
    pub(crate) fn new() -> Result<Self, PortError> {
        Ok(Self {
            topology: Arc::default(),
            closed: Arc::default(),
            process: crate::codec::new_prefixed_hex_id("owner_")?.into(),
            cleanup: Arc::default(),
            cleanup_debt: Arc::default(),
            suspended_watermarks: Arc::default(),
        })
    }

    fn cleanup(&self) -> Option<Arc<dyn ProjectionVisibilityCleanup>> {
        self.cleanup
            .read()
            .expect("projection cleanup registry")
            .clone()
    }

    pub(crate) fn has_cleanup(&self) -> bool {
        self.cleanup
            .read()
            .expect("projection cleanup registry")
            .is_some()
    }

    /// Gets a handle for the current history at this runtime.
    pub fn space(&self, scope: &HistoryScope) -> Result<LiveSpaceHandle, PortError> {
        let gate = self
            .topology
            .read()
            .expect("projection topology")
            .get(&scope.space_id)
            .cloned()
            .ok_or_else(not_ready)?;
        let guard = gate.try_read().map_err(|_| not_ready())?;
        let state = guard.state().ok_or_else(not_ready)?;
        state.record.scope.check(scope)?;
        if !state.readable || state.lookup_retired || self.closed.load(Ordering::Acquire) {
            return Err(not_ready());
        }
        let epoch = state.record.active_epoch;
        drop(guard);
        Ok(self.bind(gate, scope, epoch))
    }

    fn bind(&self, gate: Gate, scope: &HistoryScope, epoch: LeaseEpoch) -> LiveSpaceHandle {
        LiveSpaceHandle {
            gate,
            scope: scope.clone(),
            epoch,
            closed: Arc::clone(&self.closed),
            process: Arc::clone(&self.process),
        }
    }

    /// Acquires a short final-delivery permit, or fails closed during a writer.
    pub fn try_read(&self, scope: &HistoryScope) -> Result<LiveReadPermit, PortError> {
        self.space(scope)?.try_read()
    }

    pub(crate) async fn close_and_drain(&self) {
        self.closed.store(true, Ordering::Release);
        self.suspended_watermarks
            .lock()
            .expect("projection suspended watermarks")
            .clear();
        let gates: Vec<Gate> = {
            let mut topology = self.topology.write().expect("projection topology");
            std::mem::take(&mut *topology).into_values().collect()
        };
        for gate in gates {
            *gate.write().await = GateData::Revoked;
        }
    }

    fn gate_or_insert(&self, space: &SpaceId) -> Gate {
        if let Some(gate) = self
            .topology
            .read()
            .expect("projection topology")
            .get(space)
            .cloned()
        {
            return gate;
        }
        self.topology
            .write()
            .expect("projection topology")
            .entry(space.clone())
            .or_insert_with(|| Arc::new(RwLock::new(GateData::Empty)))
            .clone()
    }

    fn remove_gate_if_same(&self, space: &SpaceId, gate: &Gate) {
        let mut topology = self.topology.write().expect("projection topology");
        if topology
            .get(space)
            .is_some_and(|existing| Arc::ptr_eq(existing, gate))
        {
            topology.remove(space);
        }
    }

    fn cleanup_empty_gate(&self, space: &SpaceId, gate: &Gate) {
        if Arc::strong_count(gate) == 2
            && let Ok(mut topology) = self.topology.write()
            && Arc::strong_count(gate) == 2
            && topology
                .get(space)
                .is_some_and(|existing| Arc::ptr_eq(existing, gate))
            && gate
                .try_read()
                .is_ok_and(|data| matches!(*data, GateData::Empty))
        {
            topology.remove(space);
        }
    }

    fn cleanup_empty_gates(&self, gates: &[(SpaceId, Gate)]) {
        if let Ok(mut topology) = self.topology.write() {
            for (space, gate) in gates {
                if Arc::strong_count(gate) == 2
                    && topology
                        .get(space)
                        .is_some_and(|existing| Arc::ptr_eq(existing, gate))
                    && gate
                        .try_read()
                        .is_ok_and(|data| matches!(*data, GateData::Empty))
                {
                    topology.remove(space);
                }
            }
        }
    }

    async fn lock_current_gate(
        &self,
        space: &SpaceId,
        budget: &CallBudget,
        deadline: tokio::time::Instant,
    ) -> Result<(Gate, OwnedRwLockWriteGuard<GateData>), PortError> {
        loop {
            if self.closed.load(Ordering::Acquire) {
                return Err(not_ready());
            }
            let gate = self.gate_or_insert(space);
            let guard = budgeted(budget, deadline, Arc::clone(&gate).write_owned()).await?;
            let current = {
                let topology = self.topology.read().expect("projection topology");
                !matches!(*guard, GateData::Revoked)
                    && topology
                        .get(space)
                        .is_some_and(|existing| Arc::ptr_eq(existing, &gate))
            };
            if current {
                return Ok((gate, guard));
            }
            drop(guard);
        }
    }

    pub(crate) fn try_for_write(&self, mut spaces: Vec<SpaceId>) -> Option<LiveWriteSet> {
        spaces.sort_unstable();
        spaces.dedup();
        let gates: Vec<(SpaceId, Gate)> = spaces
            .iter()
            .map(|space| (space.clone(), self.gate_or_insert(space)))
            .collect();
        let mut guards = Vec::with_capacity(gates.len());
        for (_, gate) in &gates {
            let Ok(guard) = Arc::clone(gate).try_write_owned() else {
                drop(guards);
                self.cleanup_empty_gates(&gates);
                return None;
            };
            guards.push(guard);
        }
        let current = {
            let topology = self.topology.read().expect("projection topology");
            gates.iter().zip(&guards).all(|((space, gate), guard)| {
                !matches!(**guard, GateData::Revoked)
                    && topology
                        .get(space)
                        .is_some_and(|existing| Arc::ptr_eq(existing, gate))
            })
        };
        if current || self.closed.load(Ordering::Acquire) {
            Some(LiveWriteSet {
                topology: Arc::clone(&self.topology),
                gates,
                guards,
                spaces,
                preserve: true,
            })
        } else {
            drop(guards);
            self.cleanup_empty_gates(&gates);
            None
        }
    }

    pub(crate) async fn for_write(&self, mut spaces: Vec<SpaceId>) -> LiveWriteSet {
        spaces.sort_unstable();
        spaces.dedup();
        loop {
            let gates: Vec<(SpaceId, Gate)> = spaces
                .iter()
                .map(|space| (space.clone(), self.gate_or_insert(space)))
                .collect();
            let mut guards = Vec::with_capacity(gates.len());
            for (_, gate) in &gates {
                guards.push(Arc::clone(gate).write_owned().await);
            }
            let current = {
                let topology = self.topology.read().expect("projection topology");
                gates.iter().zip(&guards).all(|((space, gate), guard)| {
                    !matches!(**guard, GateData::Revoked)
                        && topology
                            .get(space)
                            .is_some_and(|existing| Arc::ptr_eq(existing, gate))
                })
            };
            if current || self.closed.load(Ordering::Acquire) {
                return LiveWriteSet {
                    topology: Arc::clone(&self.topology),
                    gates,
                    guards,
                    spaces,
                    preserve: true,
                };
            }
            drop(guards);
            drop(gates);
        }
    }
}

/// Capability bound to one admission of one history. A new admission creates
/// a distinct gate after release, so an old handle can never bind to it.
#[derive(Clone)]
pub struct LiveSpaceHandle {
    gate: Gate,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    closed: Arc<AtomicBool>,
    process: Arc<str>,
}

impl LiveSpaceHandle {
    pub fn try_read(&self) -> Result<LiveReadPermit, PortError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(not_ready());
        }
        let guard = Arc::clone(&self.gate)
            .try_read_owned()
            .map_err(|_| not_ready())?;
        self.validate_permit(guard)
    }

    pub async fn read(&self, budget: &CallBudget) -> Result<LiveReadPermit, PortError> {
        let deadline =
            crate::runtime::deadline_after(tokio::time::Instant::now(), budget.remaining);
        let guard = budgeted(budget, deadline, Arc::clone(&self.gate).read_owned()).await?;
        self.validate_permit(guard)
    }

    fn validate_permit(
        &self,
        guard: OwnedRwLockReadGuard<GateData>,
    ) -> Result<LiveReadPermit, PortError> {
        let state = guard.state().ok_or_else(not_ready)?;
        state.record.scope.check(&self.scope)?;
        if !state.readable
            || state.lookup_retired
            || state.record.active_epoch != self.epoch
            || self.closed.load(Ordering::Acquire)
        {
            return Err(not_ready());
        }
        Ok(LiveReadPermit {
            guard,
            process: Arc::clone(&self.process),
        })
    }
}

/// Keep this only through bounded validation and final delivery. Holding it
/// while calling a canonical mutator would wait on the caller's own permit.
pub struct LiveReadPermit {
    guard: OwnedRwLockReadGuard<GateData>,
    process: Arc<str>,
}

/// The confirmed Space owner, borrowed from a held final-delivery permit.
pub struct ProjectionOwnerWitness<'a> {
    permit: &'a LiveReadPermit,
}

impl ProjectionOwnerWitness<'_> {
    pub fn scope(&self) -> &HistoryScope {
        self.permit.scope()
    }

    pub fn epoch(&self) -> LeaseEpoch {
        self.permit.state().record.active_epoch
    }

    pub fn process(&self) -> &str {
        self.permit.process.as_ref()
    }
}

impl LiveReadPermit {
    fn state(&self) -> &LiveState {
        self.guard.state().expect("active final read permit")
    }

    pub fn space(&self) -> &Space {
        &self.state().record.space
    }

    pub fn scope(&self) -> &HistoryScope {
        &self.state().record.scope
    }

    pub fn root_folder_id(&self) -> &FolderId {
        &self.state().record.root_folder_id
    }

    pub fn head(&self) -> SpaceSeq {
        self.state().record.last_seq
    }

    pub fn owner_witness(&self) -> ProjectionOwnerWitness<'_> {
        ProjectionOwnerWitness { permit: self }
    }

    pub fn memory_usage(&self) -> FenceMemoryUsage {
        self.state().memory_usage()
    }

    /// Identity changes may be used to tighten a projected bitmap when there
    /// were no intervening folder cascades. A gap requires full verification.
    pub fn note_changes_since(
        &self,
        cut: SpaceSeq,
    ) -> Option<impl ExactSizeIterator<Item = &NoteId>> {
        let state = self.state();
        (state.changes_after <= cut && cut <= state.record.last_seq).then(|| {
            let first = state.note_changes.partition_point(|(seq, _)| *seq <= cut);
            state.note_changes.range(first..).map(|(_, note)| note)
        })
    }

    pub fn folder_facts(&self, folder: &FolderId) -> Option<ResourceFacts> {
        self.active_folder_facts(folder, true)
    }

    pub fn active_folder_facts(
        &self,
        folder: &FolderId,
        active_ancestors_only: bool,
    ) -> Option<ResourceFacts> {
        let state = self.state();
        if state.record.space.lifecycle != SpaceLifecycle::Active {
            return None;
        }
        self.folder_facts_in_space(state, folder, active_ancestors_only)
    }

    /// Resolves folder ancestry even when the Space itself is `Closing` or
    /// `Archived`, so project-scoped lifecycle subscribers can authorize
    /// non-active Space transitions while still validating active folder roots.
    pub fn folder_facts_any_space_lifecycle(
        &self,
        folder: &FolderId,
        active_ancestors_only: bool,
    ) -> Option<ResourceFacts> {
        self.folder_facts_in_space(self.state(), folder, active_ancestors_only)
    }

    fn folder_facts_in_space(
        &self,
        state: &LiveState,
        folder: &FolderId,
        active_ancestors_only: bool,
    ) -> Option<ResourceFacts> {
        let slot = *state.folder_slots.get(folder)?;
        let (ancestor_folders, folder_write_locked, trashed) = state.ancestry(slot)?;
        if active_ancestors_only && trashed {
            return None;
        }
        Some(ResourceFacts {
            space: state.record.space.clone(),
            class: DocClass::UserDoc,
            ancestor_folders,
            folder_write_locked,
            ability_package: None,
        })
    }

    pub fn classify(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        active_ancestors_only: bool,
    ) -> Result<LiveNoteStatus, PortError> {
        let state = self.state();
        state.record.scope.check(ctx.scope())?;
        if state.record.space.lifecycle != SpaceLifecycle::Active {
            return Ok(LiveNoteStatus::PurgedOrAbsent);
        }
        let Some((parent, class, lifecycle, ability)) = state.note(note) else {
            return Ok(LiveNoteStatus::PurgedOrAbsent);
        };
        let Some((ancestor_folders, folder_write_locked, trashed)) = state.ancestry(parent) else {
            return Ok(LiveNoteStatus::PurgedOrAbsent);
        };
        if active_ancestors_only && trashed {
            return Ok(LiveNoteStatus::PurgedOrAbsent);
        }
        let effective_lifecycle = if lifecycle == Lifecycle::Active && !trashed {
            Lifecycle::Active
        } else {
            Lifecycle::Trashed
        };
        let facts = ResourceFacts {
            space: state.record.space.clone(),
            class,
            ancestor_folders,
            folder_write_locked,
            ability_package: ability.cloned(),
        };
        if ctx.auth().can_view_resource(&facts).is_err() {
            return Ok(LiveNoteStatus::HiddenByAuth {
                is_active_plain: effective_lifecycle == Lifecycle::Active
                    && class != DocClass::EncryptedNote,
            });
        }
        Ok(match (class, effective_lifecycle) {
            (DocClass::EncryptedNote, effective_lifecycle) => LiveNoteStatus::EncryptedVisible {
                facts,
                effective_lifecycle,
            },
            (_, Lifecycle::Active) => LiveNoteStatus::ActiveVisible(facts),
            _ => LiveNoteStatus::TrashedVisible(facts),
        })
    }
}

/// Lock ordering is ordered per-Space gates, then storage. Topology is never
/// held across `.await`. An ambiguous SQL result invalidates acquired states.
pub(crate) struct LiveWriteSet {
    topology: Arc<std::sync::RwLock<Topology>>,
    gates: Vec<(SpaceId, Gate)>,
    guards: Vec<OwnedRwLockWriteGuard<GateData>>,
    spaces: Vec<SpaceId>,
    preserve: bool,
}

impl LiveWriteSet {
    pub(crate) fn has_live_state(&self) -> bool {
        self.guards.iter().any(|guard| guard.state().is_some())
    }

    fn guard_refresh_changes(
        state: &LiveState,
        windows: &[VisibilityWindow],
    ) -> Option<(VisibilityChanges, Option<SpaceSeq>)> {
        let matching = windows
            .iter()
            .find(|window| window.scope == state.record.scope);
        match matching {
            Some(window)
                if state.readable
                    && state.record.last_seq == window.after
                    && !window.changes.notes
                    && !window.changes.folders
                    && !window.changes.erasures =>
            {
                None
            }
            Some(window) if state.readable && state.record.last_seq == window.after => {
                Some((window.changes, Some(window.through)))
            }
            _ => Some((VisibilityChanges::all(), None)),
        }
    }

    pub(crate) fn needs_storage_read(
        &self,
        store: &CanonicalStore,
        windows: &[VisibilityWindow],
    ) -> bool {
        let mut active = Vec::with_capacity(self.guards.len());
        for guard in &self.guards {
            let Some(state) = guard.state() else {
                continue;
            };
            active.push(&state.record.scope);
            if Self::guard_refresh_changes(state, windows).is_some() {
                return true;
            }
        }
        if windows
            .iter()
            .any(|window| window.changes.erasures && !active.contains(&&window.scope))
        {
            return true;
        }
        let pending = store
            .inner
            .live_visibility
            .cleanup_debt
            .lock()
            .expect("projection cleanup debt");
        pending
            .keys()
            .any(|scope| self.spaces.binary_search(&scope.space_id).is_ok())
    }

    pub(crate) fn committing(&mut self) {
        self.preserve = false;
    }

    pub(crate) fn invalidate(mut self) {
        self.committing();
    }

    pub(crate) fn aborted(mut self) {
        self.preserve = true;
    }

    pub(crate) async fn published(
        mut self,
        store: &CanonicalStore,
        windows: &[VisibilityWindow],
    ) -> Result<(), PortError> {
        let cleanup = if windows.iter().any(|window| window.changes.erasures) {
            match store
                .projection_cleanup_for_erasure(&source::internal_budget())
                .await
            {
                Ok(cleanup) => cleanup,
                Err(error) => {
                    // Record erasure debt BEFORE returning an error so detached redactions
                    // or purges cannot be lost if a projector re-attaches later.
                    let mut pending = store
                        .inner
                        .live_visibility
                        .cleanup_debt
                        .lock()
                        .expect("projection cleanup debt");
                    for window in windows.iter().filter(|window| window.changes.erasures) {
                        pending
                            .entry(window.scope.clone())
                            .and_modify(|(after, through)| {
                                *after = (*after).min(window.after);
                                *through = (*through).max(window.through);
                            })
                            .or_insert((window.after, window.through));
                    }
                    return Err(error);
                }
            }
        } else {
            store.inner.live_visibility.cleanup()
        };
        let mut first_cleanup_error = None;
        let mut uncovered: Vec<_> = windows
            .iter()
            .filter(|window| window.changes.erasures)
            .collect();
        let mut failed_scopes = Vec::new();
        for guard in &mut self.guards {
            let Some(state) = guard.state_mut() else {
                continue;
            };
            let Some((changes, _)) = Self::guard_refresh_changes(state, windows) else {
                if let Some(window) = windows
                    .iter()
                    .find(|window| window.scope == state.record.scope)
                {
                    state.record.last_seq = window.through;
                }
                continue;
            };
            let budget = source::internal_budget();
            let after = state.record.last_seq;
            let visibility = match source::refresh(store, state, &budget, changes).await {
                Ok(checked) => {
                    if changes.erasures {
                        uncovered.retain(|window| {
                            window.scope != state.record.scope
                                || window.after < after
                                || window.through > checked.through
                        });
                    }
                    checked.visibility
                }
                Err(source::RefreshError::Cleanup(error)) => {
                    state.readable = false;
                    failed_scopes.push(state.record.scope.clone());
                    first_cleanup_error.get_or_insert(error);
                    continue;
                }
                Err(source::RefreshError::Visibility(error)) => Err(error),
            };
            state.readable = visibility.is_ok();
            if let Err(error) = visibility {
                tracing::warn!(?error, "canonical visibility admission needs a fresh cut");
            }
        }
        if let Some(cleanup) = cleanup {
            let mut debt = {
                let mut pending = store
                    .inner
                    .live_visibility
                    .cleanup_debt
                    .lock()
                    .expect("projection cleanup debt");
                // A retained admission can belong to the old writer epoch. Its failed
                // refresh cannot acknowledge physical erasure in the committed window.
                for window in uncovered {
                    pending
                        .entry(window.scope.clone())
                        .and_modify(|(after, through)| {
                            *after = (*after).min(window.after);
                            *through = (*through).max(window.through);
                        })
                        .or_insert((window.after, window.through));
                }
                pending
                    .iter()
                    .filter(|(scope, _)| {
                        self.spaces.binary_search(&scope.space_id).is_ok()
                            && !failed_scopes.contains(scope)
                    })
                    .map(|(scope, &(after, through))| VisibilityWindow {
                        scope: scope.clone(),
                        after,
                        through,
                        changes: VisibilityChanges::all(),
                    })
                    .collect::<Vec<_>>()
            };
            debt.sort_unstable_by(|left, right| left.scope.space_id.cmp(&right.scope.space_id));
            for window in debt {
                let result = source::erase_window(store, cleanup.as_ref(), &window).await;
                match result {
                    Err(error) => {
                        for state in self.guards.iter_mut().filter_map(|guard| guard.state_mut()) {
                            if state.record.scope == window.scope {
                                state.readable = false;
                            }
                        }
                        first_cleanup_error.get_or_insert(error);
                    }
                    Ok(purged) => {
                        if purged {
                            for state in
                                self.guards.iter_mut().filter_map(|guard| guard.state_mut())
                            {
                                if state.record.scope == window.scope {
                                    state.retire_lookup_before(window.through);
                                }
                            }
                        }
                        store
                            .inner
                            .live_visibility
                            .cleanup_debt
                            .lock()
                            .expect("projection cleanup debt")
                            .remove(&window.scope);
                    }
                }
            }
        }
        self.preserve = true;
        first_cleanup_error.map_or(Ok(()), Err)
    }
}

impl Drop for LiveWriteSet {
    fn drop(&mut self) {
        let mut empty_spaces = Vec::new();
        for ((space, _), guard) in self.gates.iter().zip(&mut self.guards) {
            if !self.preserve
                && let Some(state) = guard.state_mut()
            {
                state.readable = false;
                state.lookup = None;
            }
            if matches!(**guard, GateData::Empty) {
                empty_spaces.push(space.clone());
            }
        }
        self.guards.clear();
        if !empty_spaces.is_empty()
            && let Ok(mut topology) = self.topology.write()
        {
            for (space, gate) in &self.gates {
                if empty_spaces.contains(space)
                    && Arc::strong_count(gate) == 2
                    && topology
                        .get(space)
                        .is_some_and(|existing| Arc::ptr_eq(existing, gate))
                    && gate
                        .try_read()
                        .is_ok_and(|data| matches!(*data, GateData::Empty))
                {
                    topology.remove(space);
                }
            }
        }
    }
}

impl CanonicalStore {
    pub fn live_visibility_fence(&self) -> LiveLifecycleFence {
        self.inner.live_visibility.clone()
    }

    #[cfg(feature = "test-support")]
    pub fn set_projection_visibility_cleanup(
        &self,
        ctx: &MaintenanceContext,
        cleanup: Arc<dyn ProjectionVisibilityCleanup>,
    ) -> Result<(), PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        *self
            .inner
            .live_visibility
            .cleanup
            .write()
            .expect("projection cleanup registry") = Some(cleanup);
        Ok(())
    }

    pub(crate) async fn retry_purged_note_cleanup(
        &self,
        scope: &HistoryScope,
        through: SpaceSeq,
        note: &NoteId,
        budget: &CallBudget,
    ) -> Result<(), PortError> {
        self.replay_projection_erasure(
            ProjectionErasures {
                scope: scope.clone(),
                through,
                purged: vec![note.clone()],
                redacted: Vec::new(),
            },
            budget,
        )
        .await
    }

    pub(crate) async fn retry_redacted_chat_cleanup(
        &self,
        committed: &Committed<RedactedChat>,
        budget: &CallBudget,
    ) -> Result<(), PortError> {
        let through = committed.receipt.seq();
        let value = &committed.value;
        // Receipts preserve the affected entries even if another command moved a redacted-at marker.
        let redacted = std::iter::once(value.entry)
            .chain(value.invalidated_contexts.iter().copied())
            .map(|entry| ProjectionRedactedEntry {
                thread: value.thread.clone(),
                entry,
                redacted_at: through,
            })
            .collect();
        self.replay_projection_erasure(
            ProjectionErasures {
                scope: committed.receipt.scope().clone(),
                through,
                purged: Vec::new(),
                redacted,
            },
            budget,
        )
        .await
    }

    async fn replay_projection_erasure(
        &self,
        erasures: ProjectionErasures,
        budget: &CallBudget,
    ) -> Result<(), PortError> {
        let Some(callback) = self.projection_cleanup_for_erasure(budget).await? else {
            return Ok(());
        };
        let retry = |error: PortError| {
            crate::codec::unknown_commit_outcome("projection_cleanup_retry", error.to_string())
        };
        let deadline =
            crate::runtime::deadline_after(tokio::time::Instant::now(), budget.remaining);
        let mut visibility = budgeted(
            budget,
            deadline,
            self.inner
                .live_visibility
                .for_write(vec![erasures.scope.space_id.clone()]),
        )
        .await
        .map_err(retry)?;
        visibility.committing();
        if !erasures.purged.is_empty() {
            for state in visibility
                .guards
                .iter_mut()
                .filter_map(|guard| guard.state_mut())
            {
                if state.record.scope == erasures.scope {
                    state.retire_lookup_before(erasures.through);
                }
            }
        }
        callback
            .erase_visibility(self, &erasures)
            .await
            .map_err(retry)?;
        visibility.published(self, &[]).await.map_err(retry)
    }

    pub async fn projection_owner_identity(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<Option<ProjectionOwnerIdentity>, PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        source::owner_identity(self, scope, &ctx.budget, false).await
    }

    /// Resolves an active owner for projection read dispatch. The endpoint
    /// acquires a fresh read permit when the requested operation begins.
    pub async fn projection_read_owner_identity(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<Option<ProjectionOwnerIdentity>, PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        source::owner_identity(self, scope, &ctx.budget, true).await
    }

    /// Records trusted termination proof for an exact former owner and epoch.
    /// A stale attestation cannot authorize takeover of a replacement owner.
    pub async fn confirm_projection_owner_stopped(
        &self,
        ctx: &MaintenanceContext,
        proof: StoppedProjectionOwner,
    ) -> Result<(), PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        self.ensure_open()?;
        let identity = proof.0;
        if self.inner.live_visibility.process.as_ref() == identity.process {
            return Err(not_ready());
        }
        let deadline =
            crate::runtime::deadline_after(tokio::time::Instant::now(), ctx.budget.remaining);
        source::set_owner_phase(self, identity, "drained", &ctx.budget, deadline).await
    }

    pub async fn admit_projection_space(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<LiveSpaceHandle, PortError> {
        self.admit_live_space(ctx, scope, None).await
    }

    /// Rejects a worker without a locally held writer epoch before seeding.
    /// Final projection admission still requires the canonical owner permit.
    pub fn check_projection_writer_candidate(
        &self,
        ctx: &MaintenanceContext,
        space: &SpaceId,
    ) -> Result<(), PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        self.ensure_open()?;
        if self.is_postgres() {
            self.inner.writer_epoch(space).map_err(|_| not_ready())?;
        }
        Ok(())
    }

    pub async fn admit_projection_space_with_lookup(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        lookup: Arc<dyn LiveDenseLookup>,
    ) -> Result<LiveSpaceHandle, PortError> {
        self.admit_live_space(ctx, scope, Some(lookup)).await
    }

    async fn admit_live_space(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        lookup: Option<Arc<dyn LiveDenseLookup>>,
    ) -> Result<LiveSpaceHandle, PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        self.ensure_open()?;
        let fence = &self.inner.live_visibility;
        if fence.closed.load(Ordering::Acquire) {
            return Err(not_ready());
        }
        if self.is_postgres() && self.inner.writer_epoch(&scope.space_id).is_err() {
            return Err(not_ready());
        }
        if lookup.is_none()
            && let Ok(handle) = fence.space(scope)
        {
            return Ok(handle);
        }
        struct CleanupEmptyGateOnDrop<'a> {
            fence: &'a LiveLifecycleFence,
            space: &'a SpaceId,
            gate: Gate,
        }

        impl Drop for CleanupEmptyGateOnDrop<'_> {
            fn drop(&mut self) {
                self.fence.cleanup_empty_gate(self.space, &self.gate);
            }
        }

        let started = tokio::time::Instant::now();
        let deadline = crate::runtime::deadline_after(started, ctx.budget.remaining);
        let gate_slot = CleanupEmptyGateOnDrop {
            fence,
            space: &scope.space_id,
            gate: fence.gate_or_insert(&scope.space_id),
        };
        let gate = &gate_slot.gate;
        let mut old = budgeted(&ctx.budget, deadline, gate.write()).await?;
        if matches!(*old, GateData::Revoked) {
            fence.remove_gate_if_same(&scope.space_id, gate);
            return Err(not_ready());
        }
        let suspended_mark = fence
            .suspended_watermarks
            .lock()
            .expect("projection suspended watermarks")
            .get(&scope.space_id)
            .cloned();
        if let Some(next_lookup) = lookup.as_ref() {
            if let Some(state) = old.state()
                && &state.record.scope == scope
                && self
                    .inner
                    .check_writer_epoch(&scope.space_id, state.record.active_epoch)
                    .is_ok()
            {
                if next_lookup.generation() < state.lookup_generation {
                    // A publisher from before handoff can finish after the new lookup.
                    // Retirement clears the backing file, but keeps this generation.
                    return Err(not_ready());
                }
                if let Some(floor) = state.retired_before
                    && next_lookup
                        .published_seq()
                        .is_none_or(|published| published < floor)
                {
                    // Never re-admit a pre-purge checkpoint directory of the same generation.
                    return Err(not_ready());
                }
            }
            if let Some(mark) = suspended_mark.as_ref()
                && &mark.scope == scope
                && self
                    .inner
                    .check_writer_epoch(&scope.space_id, mark.active_epoch)
                    .is_ok()
            {
                if next_lookup.generation() < mark.lookup_generation {
                    return Err(not_ready());
                }
                if let Some(floor) = mark.retired_before
                    && next_lookup
                        .published_seq()
                        .is_none_or(|published| published < floor)
                {
                    return Err(not_ready());
                }
            }
        }
        if lookup.is_none()
            && let Some(state) = old.state()
            && state.readable
            && !state.lookup_retired
        {
            state.record.scope.check(scope)?;
            let epoch = state.record.active_epoch;
            if fence.closed.load(Ordering::Acquire)
                || self
                    .inner
                    .check_writer_epoch(&scope.space_id, epoch)
                    .is_err()
                || !fence
                    .topology
                    .read()
                    .expect("projection topology")
                    .get(&scope.space_id)
                    .is_some_and(|existing| Arc::ptr_eq(existing, gate))
            {
                return Err(not_ready());
            }
            drop(old);
            return Ok(fence.bind(Arc::clone(gate), scope, epoch));
        }
        if lookup.is_none()
            && let Some(state) = old.state()
            && state.lookup_retired
            && &state.record.scope == scope
        {
            // Once physical cleanup retired these slots, only a newly
            // published byte directory can restore dense admission.
            return Err(not_ready());
        }
        if let (Some(state), Some(next_lookup)) = (old.state_mut(), lookup.as_ref())
            && state.readable
            && &state.record.scope == scope
        {
            let epoch = state.record.active_epoch;
            if fence.closed.load(Ordering::Acquire)
                || self
                    .inner
                    .check_writer_epoch(&scope.space_id, epoch)
                    .is_err()
                || !fence
                    .topology
                    .read()
                    .expect("projection topology")
                    .get(&scope.space_id)
                    .is_some_and(|existing| Arc::ptr_eq(existing, gate))
            {
                return Err(not_ready());
            }
            match state.update_lookup(next_lookup.clone()) {
                Ok(true) => {
                    drop(old);
                    return Ok(fence.bind(Arc::clone(gate), scope, epoch));
                }
                Ok(false) => {}
                Err(error) => {
                    state.readable = false;
                    return Err(error);
                }
            }
        }
        let record =
            source::owner_space_record(self, &fence.process, scope, &ctx.budget, deadline).await?;
        let pending = fence
            .cleanup_debt
            .lock()
            .expect("projection cleanup debt")
            .get(scope)
            .copied();
        let mut retired_floor: Option<SpaceSeq> = None;
        if let Some((after, through)) = pending
            && let Some(callback) = fence.cleanup()
        {
            let window = VisibilityWindow {
                scope: scope.clone(),
                after,
                through,
                changes: VisibilityChanges::all(),
            };
            let purged = source::erase_window(self, callback.as_ref(), &window).await?;
            if purged {
                retired_floor = Some(retired_floor.map_or(through, |cur| cur.max(through)));
            }
            fence
                .cleanup_debt
                .lock()
                .expect("projection cleanup debt")
                .remove(scope);
        }
        if let Some(old_state) = old.state_mut()
            && !old_state.readable
            && &old_state.record.scope == scope
            && old_state.record.last_seq < record.last_seq
            && let Some(callback) = fence.cleanup()
        {
            let window = VisibilityWindow {
                scope: scope.clone(),
                after: old_state.record.last_seq,
                through: record.last_seq,
                changes: VisibilityChanges {
                    notes: false,
                    folders: false,
                    erasures: true,
                },
            };
            let purged = source::erase_window(self, callback.as_ref(), &window).await?;
            if purged {
                old_state.retire_lookup_before(record.last_seq);
                retired_floor =
                    Some(retired_floor.map_or(record.last_seq, |cur| cur.max(record.last_seq)));
            }
        }
        if let Some(old_state) = old.state_mut()
            && &old_state.record.scope == scope
            && old_state.record.active_epoch == record.active_epoch
            && let Some(prev_retired) = old_state.retired_before
        {
            retired_floor = Some(retired_floor.map_or(prev_retired, |cur| cur.max(prev_retired)));
        }
        if let (Some(floor), Some(next_lookup)) = (retired_floor, lookup.as_ref())
            && next_lookup
                .published_seq()
                .is_none_or(|published| published < floor)
        {
            return Err(not_ready());
        }
        // Release the previous admission's private buffers BEFORE allocating the
        // replacement LiveState so re-admission does not double peak RAM (>8 MiB).
        let previous_meta = if let Some(old_state) = old.state_mut() {
            let meta = (
                old_state.record.scope.clone(),
                old_state.record.active_epoch,
                old_state.lookup_generation,
                old_state.retired_before,
                old_state.peak_private_bytes,
            );
            old_state.release_private_memory();
            Some(meta)
        } else {
            None
        };
        let mut state = LiveState::new(record, lookup)?;
        source::seed(self, &mut state, &ctx.budget, deadline).await?;
        if let Some(floor) = retired_floor {
            state.retired_before = Some(state.retired_before.map_or(floor, |cur| cur.max(floor)));
        }
        if let Some((prev_scope, prev_epoch, prev_gen, prev_retired, prev_peak)) = previous_meta {
            if prev_scope == state.record.scope && prev_epoch == state.record.active_epoch {
                state.lookup_generation = state.lookup_generation.max(prev_gen);
                state.retired_before = match (state.retired_before, prev_retired) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
            }
            state.peak_private_bytes = state.peak_private_bytes.max(prev_peak);
        }
        if let Some(mark) = fence
            .suspended_watermarks
            .lock()
            .expect("projection suspended watermarks")
            .remove(&scope.space_id)
            && mark.scope == state.record.scope
            && mark.active_epoch == state.record.active_epoch
        {
            state.lookup_generation = state.lookup_generation.max(mark.lookup_generation);
            state.retired_before = match (state.retired_before, mark.retired_before) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
        }
        let epoch = state.record.active_epoch;
        if fence.closed.load(Ordering::Acquire)
            || self
                .inner
                .check_writer_epoch(&scope.space_id, epoch)
                .is_err()
            || !fence
                .topology
                .read()
                .expect("projection topology")
                .get(&scope.space_id)
                .is_some_and(|existing| Arc::ptr_eq(existing, gate))
        {
            return Err(not_ready());
        }
        *old = GateData::Active(Box::new(state));
        drop(old);
        Ok(fence.bind(Arc::clone(gate), scope, epoch))
    }

    /// Releases private lookup and fence state for an idle space. In Cloud
    /// the durable owner is unchanged and must still confirm a transfer.
    pub async fn suspend_projection_space(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<(), PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        let fence = &self.inner.live_visibility;
        let deadline =
            crate::runtime::deadline_after(tokio::time::Instant::now(), ctx.budget.remaining);
        let (gate, mut guard) = fence
            .lock_current_gate(&scope.space_id, &ctx.budget, deadline)
            .await?;
        if let Some(state) = guard.state() {
            state.record.scope.check(scope)?;
            if state.lookup_generation.is_some() || state.retired_before.is_some() {
                fence
                    .suspended_watermarks
                    .lock()
                    .expect("projection suspended watermarks")
                    .insert(
                        scope.space_id.clone(),
                        SuspendedWatermark {
                            scope: state.record.scope.clone(),
                            active_epoch: state.record.active_epoch,
                            lookup_generation: state.lookup_generation,
                            retired_before: state.retired_before,
                        },
                    );
            }
        }
        *guard = GateData::Revoked;
        fence.remove_gate_if_same(&scope.space_id, &gate);
        drop(guard);
        Ok(())
    }

    /// Revokes this runtime's admission and confirms the drain durably. The
    /// next writer epoch can then be acquired by another runtime. Reopening
    /// admission under the drained epoch is forbidden.
    pub async fn drain_projection_owner(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<(), PortError> {
        struct RemoveGateOnDrop<'a> {
            fence: &'a LiveLifecycleFence,
            space: &'a SpaceId,
            gate: &'a Gate,
        }

        impl Drop for RemoveGateOnDrop<'_> {
            fn drop(&mut self) {
                self.fence.remove_gate_if_same(self.space, self.gate);
            }
        }

        ctx.authority.require(ServicePurpose::Revocation)?;
        self.ensure_open()?;
        let fence = &self.inner.live_visibility;
        let deadline =
            crate::runtime::deadline_after(tokio::time::Instant::now(), ctx.budget.remaining);
        let (gate, mut guard) = fence
            .lock_current_gate(&scope.space_id, &ctx.budget, deadline)
            .await?;
        if let Some(state) = guard.state() {
            state.record.scope.check(scope)?;
        }
        fence
            .suspended_watermarks
            .lock()
            .expect("projection suspended watermarks")
            .remove(&scope.space_id);
        *guard = GateData::Revoked;
        // Remove the revoked gate from topology while still holding its write lock
        // (including on cancellation/error) so concurrent writers/admissions cannot
        // spin on a dead gate or reopen admission before epoch revocation finishes.
        let remove_gate = RemoveGateOnDrop {
            fence,
            space: &scope.space_id,
            gate: &gate,
        };
        let drained_identity = if matches!(&self.inner.sql, SqlDriverState::Postgres { .. }) {
            let identity = source::owner_identity(self, scope, &ctx.budget, false)
                .await?
                .ok_or_else(not_ready)?;
            if identity.process != *fence.process {
                return Err(not_ready());
            }
            source::set_owner_phase(self, identity.clone(), "draining", &ctx.budget, deadline)
                .await?;
            self.inner.revoke_writer_epoch(&scope.space_id);
            Some(identity)
        } else {
            None
        };
        drop(remove_gate);
        drop(guard);
        if let Some(identity) = drained_identity {
            source::set_owner_phase(self, identity, "drained", &ctx.budget, deadline).await?;
        }
        Ok(())
    }

    pub(crate) async fn check_projection_owner_advance(
        &self,
        tx: &mut crate::sql_exec::BackendConn<'_>,
        scope: &HistoryScope,
    ) -> Result<(), PortError> {
        source::remove_drained(tx, scope).await
    }

    pub(crate) async fn bind_projection_owner_restore(
        &self,
        tx: &mut crate::sql_exec::BackendConn<'_>,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
    ) -> Result<(), PortError> {
        source::restore(tx, &self.inner.live_visibility.process, scope, epoch).await
    }
}

async fn budgeted<T>(
    budget: &CallBudget,
    deadline: tokio::time::Instant,
    operation: impl Future<Output = T>,
) -> Result<T, PortError> {
    tokio::select! {
        biased;
        () = budget.cancellation.cancelled() => Err(crate::codec::cancelled_not_committed(
            "live_visibility_cancelled", "visibility work cancelled")),
        () = tokio::time::sleep_until(deadline) => Err(crate::codec::deadline_not_committed(
            "live_visibility_deadline", "visibility work exceeded its budget")),
        result = operation => Ok(result),
    }
}

#[cfg(test)]
mod fence_concurrency_tests {
    use std::{future::poll_fn, pin::pin, task::Poll};

    use super::*;

    #[tokio::test]
    async fn for_write_retries_onto_fresh_gate_after_concurrent_revocation() {
        let fence = LiveLifecycleFence::new().unwrap();
        let space = SpaceId::from_bytes([0xA1; 16]);
        let gate1 = fence.gate_or_insert(&space);
        let read_guard = Arc::clone(&gate1).read_owned().await;

        // Queue revocation on gate1 (simulating suspend/drain), then queue for_write behind it
        // on the EXACT same gate1 before releasing the reader.
        let fence_rev = fence.clone();
        let space_rev = space.clone();
        let gate1_rev = Arc::clone(&gate1);
        let mut revoke = pin!(async move {
            let mut guard = gate1_rev.write().await;
            *guard = GateData::Revoked;
            fence_rev.remove_gate_if_same(&space_rev, &gate1_rev);
        });
        poll_fn(|cx| {
            assert!(revoke.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;

        let mut writer = pin!(fence.for_write(vec![space.clone()]));
        poll_fn(|cx| {
            assert!(writer.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;

        // While gate1 is contended, try_for_write must immediately fail without blocking.
        assert!(fence.try_for_write(vec![space.clone()]).is_none());

        drop(read_guard);
        revoke.await;
        let write_set = writer.await;

        // for_write must NOT have proceeded on revoked gate1; it must hold the new live gate2.
        assert!(!Arc::ptr_eq(&write_set.gates[0].1, &gate1));
        assert!(!matches!(*write_set.guards[0], GateData::Revoked));
        {
            let topology = fence.topology.read().unwrap();
            assert!(
                topology
                    .get(&space)
                    .is_some_and(|live| Arc::ptr_eq(live, &write_set.gates[0].1))
            );
        }
        drop(write_set);
        assert!(!fence.topology.read().unwrap().contains_key(&space));
    }

    #[tokio::test]
    async fn cleanup_empty_gate_removes_orphaned_empty_slot_on_error_without_evicting_active() {
        let fence = LiveLifecycleFence::new().unwrap();
        let space = SpaceId::from_bytes([0xA2; 16]);
        let gate = fence.gate_or_insert(&space);
        assert!(fence.topology.read().unwrap().contains_key(&space));

        // Extra Arc holder (strong_count > 2): must NOT evict.
        let extra = Arc::clone(&gate);
        fence.cleanup_empty_gate(&space, &gate);
        assert!(fence.topology.read().unwrap().contains_key(&space));
        drop(extra);

        // Held exclusive write guard (try_read fails): must NOT evict.
        let write_guard = gate.write().await;
        fence.cleanup_empty_gate(&space, &gate);
        assert!(fence.topology.read().unwrap().contains_key(&space));
        drop(write_guard);

        // Orphaned unlocked GateData::Empty with strong_count == 2: MUST evict.
        fence.cleanup_empty_gate(&space, &gate);
        assert!(!fence.topology.read().unwrap().contains_key(&space));
        drop(gate);

        // Active gate with strong_count == 2: must NOT evict.
        let active_gate = fence.gate_or_insert(&space);
        let record = SpaceRecord {
            space: Space {
                id: space.clone(),
                kind: notarium_core::auth::SpaceKind::Shared,
                lifecycle: SpaceLifecycle::Active,
            },
            scope: HistoryScope {
                space_id: space.clone(),
                incarnation: notarium_core::ids::HistoryIncarnation::from_bytes([0xA3; 16]),
            },
            root_folder_id: FolderId::from_bytes([0xA4; 16]),
            slug: "active-cleanup-test".into(),
            owner: notarium_core::ids::PrincipalId::from_bytes([0xA5; 16]),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            last_seq: SpaceSeq::ZERO,
            created_at: notarium_core::value::Timestamp::from_unix_parts(1, 0).unwrap(),
        };
        *active_gate.write().await =
            GateData::Active(Box::new(LiveState::new(record, None).unwrap()));
        fence.cleanup_empty_gate(&space, &active_gate);
        assert!(
            fence
                .topology
                .read()
                .unwrap()
                .get(&space)
                .is_some_and(|existing| Arc::ptr_eq(existing, &active_gate))
        );
    }
}
