//! Durability order for one model's mutable buffer and immutable segments.

use super::{
    ChunkMetadata, EXACT_SCAN_LIMIT, M0, MAX_SEGMENT_BUILD_BYTES, MmapSegment, MutableBuffer,
    MutableOperation, QuantizedVector, SearchBudget, SegmentBuilder, Tombstones, VectorChunk,
    VectorError,
    format::class_number,
    hnsw::{self, ExactNeighbor, Similarity},
    mmap_segment::SlotMask,
};
use crate::layout::{EpochManifest, SearchLayout, VectorModel, remove_path_if_exists, sync_dir};
use cap_std::{ambient_authority, fs::Dir};
use croaring::Bitmap;
use notarium_core::{
    classes::DocClass,
    ids::{ContentDigest, ModelProfileId, NoteId, SpaceSeq},
    ports::Cancellation,
};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
    time::Instant,
};

const MAX_SMALL_SEGMENTS: usize = 6;

#[derive(Clone)]
struct Segment {
    id: u64,
    data: Arc<MmapSegment>,
    tombstones: Tombstones,
    superseded: Bitmap,
}

impl Segment {
    fn mark_superseded_note(&mut self, note: &NoteId) {
        if let Some(slots) = self.data.note_slots(note) {
            for slot in slots {
                self.superseded.add(slot);
            }
        }
    }

    fn rebuild_superseded(&mut self, mutable: &MutableBuffer) {
        self.superseded.clear();
        for note in mutable.notes() {
            if let Some(slots) = self.data.note_slots(note) {
                for slot in slots {
                    if !self.tombstones.bitmap().contains(slot) {
                        self.superseded.add(slot);
                    }
                }
            }
        }
    }

    fn live_build_bytes(&self) -> usize {
        let live =
            u64::from(self.data.len()).saturating_sub(self.tombstones.bitmap().cardinality());
        let stride = self.data.dimension().next_multiple_of(64);
        (live as usize).saturating_mul(stride + M0 * 4 + 132)
    }

    fn is_dead_heavy(&self) -> bool {
        let total = u64::from(self.data.len());
        let dead = self.tombstones.bitmap().cardinality();
        total > 0 && dead.saturating_mul(5) > total
    }

    fn is_small(&self) -> bool {
        self.live_build_bytes() < MAX_SEGMENT_BUILD_BYTES / 2
    }
}

pub struct VectorFilter<'a> {
    pub classes: &'a BTreeSet<DocClass>,
    pub folders: Option<&'a Bitmap>,
    pub notes: Option<&'a BTreeSet<NoteId>>,
    pub excluded: Option<&'a BTreeSet<NoteId>>,
}

#[derive(Clone, Debug)]
pub struct VectorHit {
    pub metadata: ChunkMetadata,
    pub score: f32,
}

#[derive(Debug)]
pub struct VectorResults {
    pub hits: Vec<VectorHit>,
    pub hnsw_hops: usize,
}

struct PlanGuard {
    slot: Arc<AtomicU64>,
    token: u64,
}

impl PlanGuard {
    fn acquire(slot: &Arc<AtomicU64>, token: u64) -> Option<Self> {
        slot.compare_exchange(0, token, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .ok()
            .map(|_| Self {
                slot: Arc::clone(slot),
                token,
            })
    }

    fn release(&self) {
        let _ = self.slot.compare_exchange(
            self.token,
            0,
            AtomicOrdering::AcqRel,
            AtomicOrdering::Relaxed,
        );
    }

    fn matches(&self, slot: &Arc<AtomicU64>) -> bool {
        Arc::ptr_eq(&self.slot, slot) && slot.load(AtomicOrdering::Acquire) == self.token
    }
}

impl Drop for PlanGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// Immutable snapshot of one bounded compaction step. Build runs off-owner on a
/// blocking thread while live updates keep appending to `VectorEpoch`.
pub struct CompactionPlan {
    path: PathBuf,
    model: VectorModel,
    replaced_ids: Vec<u64>,
    sources: Vec<(u64, Arc<MmapSegment>, Tombstones)>,
    target_id: u64,
    guard: PlanGuard,
}

impl CompactionPlan {
    pub fn replaced_ids(&self) -> &[u64] {
        &self.replaced_ids
    }

    pub fn target_id(&self) -> u64 {
        self.target_id
    }

    pub fn execute(&self, cancel: &Cancellation) -> Result<Option<MmapSegment>, VectorError> {
        let result = self.execute_inner(cancel);
        if result.is_err() {
            self.guard.release();
        }
        result
    }

    fn execute_inner(&self, cancel: &Cancellation) -> Result<Option<MmapSegment>, VectorError> {
        if cancel.is_cancelled() {
            return Err(VectorError::Cancelled);
        }
        let mut builder = SegmentBuilder::for_compaction(&self.model)?;
        for (_, data, tombstones) in &self.sources {
            for slot in 0..data.len() {
                if slot.is_multiple_of(64) && cancel.is_cancelled() {
                    return Err(VectorError::Cancelled);
                }
                if tombstones.bitmap().contains(slot) {
                    continue;
                }
                let metadata = data.metadata(slot).ok_or(VectorError::CorruptIndex)?;
                let vector = data.owned_vector(slot).ok_or(VectorError::CorruptIndex)?;
                builder.push_cancellable(VectorChunk { metadata, vector }, cancel)?;
            }
        }
        builder.finish_cancellable(&segment_file_path(&self.path, self.target_id), cancel)
    }
}

/// Immutable snapshot of the mutable L0 tier for non-blocking background flush.
pub struct FlushL0Plan {
    path: PathBuf,
    model: VectorModel,
    flushed_seq: SpaceSeq,
    flushed_gen: u64,
    prior_max_segment_id: u64,
    entries: Vec<(NoteId, Arc<Vec<VectorChunk>>)>,
    replaced_notes: Vec<NoteId>,
    target_id: Option<u64>,
    guard: PlanGuard,
}

impl FlushL0Plan {
    pub fn flushed_seq(&self) -> SpaceSeq {
        self.flushed_seq
    }

    pub fn execute(&self, cancel: &Cancellation) -> Result<Option<MmapSegment>, VectorError> {
        let result = self.execute_inner(cancel);
        if result.is_err() {
            self.guard.release();
        }
        result
    }

    fn execute_inner(&self, cancel: &Cancellation) -> Result<Option<MmapSegment>, VectorError> {
        if cancel.is_cancelled() {
            return Err(VectorError::Cancelled);
        }
        let Some(target_id) = self.target_id else {
            return Ok(None);
        };
        let mut builder = SegmentBuilder::for_compaction(&self.model)?;
        for (_, chunks) in &self.entries {
            for chunk in chunks.iter() {
                builder.push_cancellable(chunk.clone(), cancel)?;
            }
        }
        builder.finish_cancellable(&segment_file_path(&self.path, target_id), cancel)
    }
}

pub struct VectorSnapshot {
    epoch: EpochManifest,
    segments: Vec<Segment>,
    mutable: BTreeMap<NoteId, Arc<Vec<VectorChunk>>>,
}

impl VectorSnapshot {
    pub(crate) fn find_vector(&self, key: ContentDigest) -> Option<QuantizedVector> {
        find_cached_vector(
            self.mutable.values().flat_map(|chunks| chunks.iter()),
            &self.segments,
            key,
        )
    }

    pub fn manifest(&self) -> &EpochManifest {
        &self.epoch
    }

    pub fn search(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
    ) -> Result<VectorResults, VectorError> {
        self.search_mode::<fn(&NoteId) -> Result<bool, VectorError>>(
            query, filter, limit, budget, false, None,
        )
    }

    /// Apply snapshot visibility before admitting a candidate into the result heap.
    pub fn search_visible(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
        mut visible: impl FnMut(&NoteId) -> Result<bool, VectorError>,
    ) -> Result<VectorResults, VectorError> {
        self.search_mode(query, filter, limit, budget, false, Some(&mut visible))
    }

    /// Exhaustive quantized scoring for callers that need a recall reference.
    pub fn search_exact(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
    ) -> Result<VectorResults, VectorError> {
        self.search_mode::<fn(&NoteId) -> Result<bool, VectorError>>(
            query, filter, limit, budget, true, None,
        )
    }

    fn search_mode<F: FnMut(&NoteId) -> Result<bool, VectorError>>(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
        force_exact: bool,
        mut visible: Option<&mut F>,
    ) -> Result<VectorResults, VectorError> {
        budget.check()?;
        query.validate(self.epoch.model.dimension as usize)?;
        let limit = limit.min(4096);
        if limit == 0 {
            return Ok(VectorResults {
                hits: Vec::new(),
                hnsw_hops: 0,
            });
        }
        let mut hits = Vec::new();
        let mut hnsw_hops = 0;
        self.search_mutable(
            query,
            filter,
            limit,
            budget,
            visible.as_deref_mut(),
            &mut hits,
        )?;
        let mut active = Vec::with_capacity(self.segments.len());
        for segment in &self.segments {
            budget.check()?;
            let allowed = self.allowed_slots(segment, filter, budget)?;
            if !allowed.is_empty() {
                active.push((segment, allowed));
            }
        }
        let active_segments = active.len().max(1);
        for (segment, allowed) in active {
            budget.check()?;
            let exact = force_exact || allowed.cardinality() <= EXACT_SCAN_LIMIT;
            let data = &segment.data;
            let mut vis_cache: HashMap<u32, bool> = HashMap::new();
            let result = data.search_mode(
                query,
                &allowed,
                limit,
                active_segments,
                budget,
                exact,
                |slot| {
                    let Some(check) = visible.as_deref_mut() else {
                        return Ok(true);
                    };
                    let ord = data
                        .note_ord_for_slot(slot)
                        .ok_or(VectorError::CorruptIndex)?;
                    if let Some(&cached) = vis_cache.get(&ord) {
                        return Ok(cached);
                    }
                    let raw = data
                        .note_bytes_by_ord(ord)
                        .ok_or(VectorError::CorruptIndex)?;
                    let raw = std::str::from_utf8(raw).map_err(|_| VectorError::CorruptIndex)?;
                    let note = NoteId::parse(raw).map_err(|_| VectorError::CorruptIndex)?;
                    let ok = check(&note)?;
                    vis_cache.insert(ord, ok);
                    Ok(ok)
                },
            )?;
            hnsw_hops += result.hnsw_hops;
            for neighbor in result.neighbors {
                let metadata = data
                    .metadata(neighbor.slot)
                    .ok_or(VectorError::CorruptIndex)?;
                hits.push(VectorHit {
                    metadata,
                    score: neighbor.score,
                });
            }
        }
        hits.sort_unstable_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.metadata.note.cmp(&right.metadata.note))
                .then_with(|| {
                    left.metadata.spans[0]
                        .start()
                        .cmp(&right.metadata.spans[0].start())
                })
                .then_with(|| {
                    left.metadata
                        .key
                        .as_bytes()
                        .cmp(right.metadata.key.as_bytes())
                })
        });
        hits.truncate(limit);
        budget.check()?;
        Ok(VectorResults { hits, hnsw_hops })
    }

    fn allowed_slots<'a>(
        &self,
        segment: &'a Segment,
        filter: &VectorFilter<'_>,
        budget: SearchBudget<'_>,
    ) -> Result<SlotMask<'a>, VectorError> {
        let mut class_indices = [0usize; 4];
        let mut class_count = 0usize;
        for class in filter.classes.iter().copied().filter_map(class_number) {
            class_indices[class_count] = usize::from(class) - 1;
            class_count += 1;
        }
        if class_count == 0 {
            return Ok(SlotMask::Owned(Bitmap::new()));
        }

        let data = &segment.data;
        let excluded_ords: Vec<u32> = filter
            .excluded
            .into_iter()
            .flatten()
            .filter_map(|note| data.find_note_ord(note.as_str().as_bytes()))
            .collect();
        let has_masks = !segment.tombstones.bitmap().is_empty()
            || !segment.superseded.is_empty()
            || !excluded_ords.is_empty();

        // Zero-allocation fast path when no folder/note filter and no segment
        // tombstones, mutable overrides, or matching exclusions apply.
        if filter.folders.is_none() && filter.notes.is_none() && !has_masks {
            if class_count == 4 {
                return Ok(SlotMask::All(data.len()));
            }
            if class_count == 1 {
                return Ok(SlotMask::Ref(data.class_bitmap(class_indices[0])));
            }
        }

        let mut allowed = if let Some(notes) = filter.notes {
            let mut selected = Bitmap::new();
            for (position, note) in notes.iter().enumerate() {
                if position.is_multiple_of(128) {
                    budget.check()?;
                }
                if let Some(slots) = data.note_slots(note) {
                    for slot in slots {
                        selected.add(slot);
                    }
                }
            }
            if !selected.is_empty()
                && let Some(folders) = filter.folders
            {
                let mut folder_slots = Bitmap::new();
                for (index, folder) in folders.iter().enumerate() {
                    if index.is_multiple_of(128) {
                        budget.check()?;
                    }
                    if let Some(slots) = data.folder_bitmap(folder)? {
                        folder_slots.or_inplace(&slots);
                    }
                }
                selected.and_inplace(&folder_slots);
            }
            if class_count < 4 {
                let class_mask = union_classes(data, &class_indices[..class_count]);
                selected.and_inplace(&class_mask);
            }
            selected
        } else if let Some(folders) = filter.folders {
            let mut selected = Bitmap::new();
            for (index, folder) in folders.iter().enumerate() {
                if index.is_multiple_of(128) {
                    budget.check()?;
                }
                if let Some(slots) = data.folder_bitmap(folder)? {
                    selected.or_inplace(&slots);
                }
            }
            if class_count < 4 {
                let class_mask = union_classes(data, &class_indices[..class_count]);
                selected.and_inplace(&class_mask);
            }
            selected
        } else if class_count == 4 {
            Bitmap::from_range(0..data.len())
        } else {
            union_classes(data, &class_indices[..class_count])
        };

        if !segment.tombstones.bitmap().is_empty() {
            allowed.andnot_inplace(segment.tombstones.bitmap());
        }
        if !segment.superseded.is_empty() {
            allowed.andnot_inplace(&segment.superseded);
        }
        for ord in excluded_ords {
            if let Some(slots) = data.note_slots_by_ord(ord) {
                for slot in slots {
                    allowed.remove(slot);
                }
            }
        }
        Ok(SlotMask::Owned(allowed))
    }

    fn search_mutable<F: FnMut(&NoteId) -> Result<bool, VectorError>>(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
        mut visible: Option<&mut F>,
        hits: &mut Vec<VectorHit>,
    ) -> Result<(), VectorError> {
        let scorer = Similarity::new(query.values(), query.scale())?;
        let mut eligible = Vec::new();
        let mut best = BinaryHeap::<std::cmp::Reverse<ExactNeighbor<'_>>>::with_capacity(limit);
        for (position, (note, chunks)) in self.mutable.iter().enumerate() {
            if position.is_multiple_of(128) {
                budget.check()?;
            }
            if chunks.is_empty()
                || filter.notes.is_some_and(|notes| !notes.contains(note))
                || filter.excluded.is_some_and(|notes| notes.contains(note))
            {
                continue;
            }
            let mut checked_visibility = false;
            for (index, chunk) in chunks.iter().enumerate() {
                if index != 0 && index.is_multiple_of(128) {
                    budget.check()?;
                }
                let meta = &chunk.metadata;
                if !filter.classes.contains(&meta.class)
                    || filter
                        .folders
                        .is_some_and(|folders| !folders.contains(meta.folder))
                {
                    continue;
                }
                let slot = eligible.len() as u32;
                let candidate = ExactNeighbor {
                    hit: scorer.score(slot, chunk.vector.values(), chunk.vector.scale()),
                    note: meta.note.as_str().as_bytes(),
                    span: meta.spans[0].start(),
                    key: meta.key.as_bytes(),
                };
                if best.len() == limit && best.peek().is_some_and(|worst| candidate <= worst.0) {
                    continue;
                }
                if !checked_visibility {
                    if let Some(check) = visible.as_deref_mut()
                        && !check(note)?
                    {
                        break;
                    }
                    checked_visibility = true;
                }
                eligible.push(chunk);
                hnsw::keep_best(&mut best, candidate, limit);
            }
        }
        for neighbor in hnsw::finish(best) {
            let hit = neighbor.hit;
            let metadata = eligible[hit.slot as usize].metadata.clone();
            hits.push(VectorHit {
                metadata,
                score: hit.score,
            });
        }
        Ok(())
    }
}

fn union_classes(data: &MmapSegment, class_indices: &[usize]) -> Bitmap {
    let mut mask = Bitmap::new();
    for &idx in class_indices {
        mask.or_inplace(data.class_bitmap(idx));
    }
    mask
}

fn find_cached_vector<'a>(
    mut mutable: impl Iterator<Item = &'a VectorChunk>,
    segments: &[Segment],
    key: ContentDigest,
) -> Option<QuantizedVector> {
    if let Some(chunk) = mutable.find(|chunk| chunk.metadata.key == key) {
        return Some(chunk.vector.clone());
    }
    segments
        .iter()
        .rev()
        .find_map(|segment| segment.data.find_vector(key))
}

/// A single indexing owner mutates an epoch. Queries use immutable snapshots.
pub struct VectorEpoch {
    layout: Arc<SearchLayout>,
    path: PathBuf,
    manifest: EpochManifest,
    segments: Vec<Segment>,
    mutable: MutableBuffer,
    next_segment: u64,
    active_plan: Arc<AtomicU64>,
    next_plan_token: u64,
}

impl VectorEpoch {
    pub fn open(
        layout: Arc<SearchLayout>,
        model: ModelProfileId,
        dimension: usize,
    ) -> Result<Self, VectorError> {
        let dimension = u32::try_from(dimension).map_err(|_| VectorError::InvalidDimension)?;
        Self::open_model(layout, VectorModel::local(model, dimension))
    }

    pub(crate) fn open_model(
        layout: Arc<SearchLayout>,
        model: VectorModel,
    ) -> Result<Self, VectorError> {
        let dimension = model.dimension as usize;
        let path = layout.model_epoch(&model)?;
        let manifest = layout
            .epoch_manifest(&model)?
            .unwrap_or_else(|| EpochManifest {
                scope: layout.scope().clone(),
                model: model.clone(),
                vector_seq: SpaceSeq::ZERO,
                active_segments: Vec::new(),
                complete_backfill: false,
            });
        let mutable = MutableBuffer::open(&path, dimension)?;
        let mut segments = Vec::with_capacity(manifest.active_segments.len());
        for &id in &manifest.active_segments {
            let data = MmapSegment::open(&segment_file_path(&path, id), &model.hash())?;
            if data.dimension() != dimension {
                return Err(VectorError::InvalidDimension);
            }
            let tombstones = Tombstones::open(&tombstone_path(&path, id), data.len())?;
            segments.push(Segment {
                id,
                data: Arc::new(data),
                tombstones,
                superseded: Bitmap::new(),
            });
        }
        reconcile_superseded_tombstones(&path, &mut segments)?;
        for segment in &mut segments {
            segment.rebuild_superseded(&mutable);
        }
        let next_segment = disk_generations(&path)?
            .into_iter()
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(VectorError::BufferFull)?;
        Ok(Self {
            layout,
            path,
            manifest,
            segments,
            mutable,
            next_segment,
            active_plan: Arc::new(AtomicU64::new(0)),
            next_plan_token: 1,
        })
    }

    fn has_active_plan(&self) -> bool {
        self.active_plan.load(AtomicOrdering::Acquire) != 0
    }

    fn acquire_plan_guard(&mut self) -> Option<PlanGuard> {
        if self.has_active_plan() {
            return None;
        }
        let token = self.next_plan_token;
        self.next_plan_token = token.checked_add(1).unwrap_or(1);
        PlanGuard::acquire(&self.active_plan, token)
    }

    pub fn snapshot(&self) -> VectorSnapshot {
        VectorSnapshot {
            epoch: self.manifest.clone(),
            segments: self.segments.clone(),
            mutable: self.mutable.snapshot(),
        }
    }

    pub(crate) fn mutable_note_chunks(&self, note: &NoteId) -> &[VectorChunk] {
        self.mutable.chunks_for_note(note).unwrap_or_default()
    }

    /// Copy a numerical embedding with the same model and rendered text.
    /// Every new chunk keeps its own metadata and source spans.
    pub fn find_vector(&self, key: ContentDigest) -> Option<QuantizedVector> {
        find_cached_vector(self.mutable.chunks(), &self.segments, key)
    }

    pub fn apply(&mut self, seq: SpaceSeq, operation: MutableOperation) -> Result<(), VectorError> {
        self.apply_batch(seq, vec![operation])
    }

    pub fn apply_batch(
        &mut self,
        seq: SpaceSeq,
        operations: Vec<MutableOperation>,
    ) -> Result<(), VectorError> {
        if operations.is_empty() {
            return Ok(());
        }
        if seq == SpaceSeq::ZERO || seq < self.manifest.vector_seq.max(self.mutable.last_seq()) {
            return Err(VectorError::InvalidChunk);
        }
        if self.mutable.is_failed() {
            return Err(VectorError::CorruptIndex);
        }
        let mut pending = Vec::new();
        for operation in operations {
            if self.mutable.exceeds_single_limit(&operation) {
                self.flush_pending_batch(seq, &mut pending)?;
                if let MutableOperation::Upsert { note, chunks } = operation {
                    self.apply_large_upsert(seq, note, chunks)?;
                }
            } else {
                pending.push(operation);
            }
        }
        self.flush_pending_batch(seq, &mut pending)
    }

    fn flush_pending_batch(
        &mut self,
        seq: SpaceSeq,
        pending: &mut Vec<MutableOperation>,
    ) -> Result<(), VectorError> {
        if pending.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(pending);
        match self.mutable.admit_batch(seq, &batch) {
            Ok(()) => {
                let notes: Vec<NoteId> = batch.iter().map(|op| op.note().clone()).collect();
                self.mutable.apply_batch(seq, batch)?;
                for note in &notes {
                    for segment in &mut self.segments {
                        segment.mark_superseded_note(note);
                    }
                }
                return Ok(());
            }
            Err(VectorError::BufferFull) => {}
            Err(error) => return Err(error),
        }
        // Flush existing L0 and apply in bounded sub-batches that fit L0 limits.
        self.flush()?;
        let mut current = Vec::new();
        for operation in batch {
            current.push(operation);
            if matches!(
                self.mutable.admit_batch(seq, &current),
                Err(VectorError::BufferFull)
            ) {
                let overflow = current.pop().expect("non-empty sub-batch");
                if !current.is_empty() {
                    let sub = std::mem::take(&mut current);
                    let notes: Vec<NoteId> = sub.iter().map(|op| op.note().clone()).collect();
                    self.mutable.apply_batch(seq, sub)?;
                    for note in &notes {
                        for segment in &mut self.segments {
                            segment.mark_superseded_note(note);
                        }
                    }
                    self.flush()?;
                }
                current.push(overflow);
            }
        }
        if !current.is_empty() {
            let notes: Vec<NoteId> = current.iter().map(|op| op.note().clone()).collect();
            self.mutable.apply_batch(seq, current)?;
            for note in &notes {
                for segment in &mut self.segments {
                    segment.mark_superseded_note(note);
                }
            }
        }
        Ok(())
    }

    pub(super) fn apply_large_upsert(
        &mut self,
        seq: SpaceSeq,
        note: NoteId,
        chunks: Vec<VectorChunk>,
    ) -> Result<(), VectorError> {
        if chunks.is_empty() {
            return Err(VectorError::InvalidChunk);
        }
        for chunk in &chunks {
            if chunk.metadata.note != note {
                return Err(VectorError::InvalidChunk);
            }
            chunk.validate(self.manifest.model.dimension as usize)?;
        }
        self.flush()?;
        // Keep all chunks of a single note inside one sealed segment so reopen
        // supersession reconciliation (`seg_new.id > seg_old.id`) never
        // tombstones an earlier slice of the same note.
        let mut builder = SegmentBuilder::for_compaction(&self.manifest.model)?;
        for chunk in chunks {
            builder.push(chunk)?;
        }
        let added = self.seal(builder)?;
        self.append_replacement_segment(added, seq, &[note])
    }

    pub fn should_flush(&self, now: Instant) -> bool {
        self.mutable.should_flush(now)
    }

    pub fn plan_flush_l0(&mut self) -> Result<Option<FlushL0Plan>, VectorError> {
        if self.mutable.is_failed() {
            return Err(VectorError::CorruptIndex);
        }
        if self.mutable.is_empty() || self.has_active_plan() {
            return Ok(None);
        }
        let snapshot = self.mutable.snapshot_for_flush();
        let replaced_notes: Vec<NoteId> = snapshot
            .entries
            .iter()
            .map(|(note, _)| note.clone())
            .collect();
        let has_chunks = snapshot
            .entries
            .iter()
            .any(|(_, chunks)| !chunks.is_empty());
        let prior_max_segment_id = self.segments.iter().map(|seg| seg.id).max().unwrap_or(0);
        let target_id = if has_chunks {
            Some(self.alloc_segment_id()?)
        } else {
            None
        };
        let Some(guard) = self.acquire_plan_guard() else {
            return Ok(None);
        };
        Ok(Some(FlushL0Plan {
            path: self.path.clone(),
            model: self.manifest.model.clone(),
            flushed_seq: snapshot.flushed_seq,
            flushed_gen: snapshot.flushed_gen,
            prior_max_segment_id,
            entries: snapshot.entries,
            replaced_notes,
            target_id,
            guard,
        }))
    }

    pub fn commit_flush_l0(
        &mut self,
        plan: FlushL0Plan,
        replacement: Option<MmapSegment>,
        dirty_notes: &HashSet<NoteId>,
    ) -> Result<(), VectorError> {
        if self.mutable.is_failed() || !plan.guard.matches(&self.active_plan) {
            return Err(VectorError::CorruptIndex);
        }
        if plan.model != self.manifest.model {
            return Err(VectorError::InvalidDimension);
        }
        let mut segments = self.segments.clone();
        for segment in &mut segments {
            if segment.id > plan.prior_max_segment_id {
                continue;
            }
            let before = segment.tombstones.bitmap().cardinality();
            for note in &plan.replaced_notes {
                if let Some(slots) = segment.data.note_slots(note) {
                    for slot in slots {
                        segment.tombstones.mark(slot);
                    }
                }
            }
            if segment.tombstones.bitmap().cardinality() != before {
                segment
                    .tombstones
                    .persist(&tombstone_path(&self.path, segment.id))?;
            }
        }
        if plan.target_id.is_some() != replacement.is_some() {
            return Err(VectorError::CorruptIndex);
        }
        if let Some(data) = replacement {
            let target_id = plan.target_id.ok_or(VectorError::CorruptIndex)?;
            let mut tombstones = Tombstones::default();
            for note in dirty_notes
                .iter()
                .chain(self.mutable.notes_after_gen(plan.flushed_gen))
            {
                if let Some(slots) = data.note_slots(note) {
                    for slot in slots {
                        tombstones.mark(slot);
                    }
                }
            }
            for newer in segments
                .iter()
                .filter(|seg| seg.id > plan.prior_max_segment_id)
            {
                for n_ord in 0..newer.data.num_notes() {
                    if !segment_note_has_live_slots(newer, n_ord)? {
                        continue;
                    }
                    if let Some(bytes) = newer.data.note_bytes_by_ord(n_ord)
                        && let Some(ord) = data.find_note_ord(bytes)
                        && let Some(slots) = data.note_slots_by_ord(ord)
                    {
                        for slot in slots {
                            tombstones.mark(slot);
                        }
                    }
                }
            }
            if !tombstones.bitmap().is_empty() {
                tombstones.persist(&tombstone_path(&self.path, target_id))?;
            }
            segments.push(Segment {
                id: target_id,
                data: Arc::new(data),
                tombstones,
                superseded: Bitmap::new(),
            });
            segments.sort_unstable_by_key(|segment| segment.id);
        }
        self.publish(
            segments,
            self.manifest.vector_seq.max(plan.flushed_seq),
            self.manifest.complete_backfill,
        )?;
        self.mutable.prune_flushed(plan.flushed_gen)?;
        for segment in &mut self.segments {
            segment.rebuild_superseded(&self.mutable);
        }
        Ok(())
    }

    pub fn flush(&mut self) -> Result<(), VectorError> {
        self.flush_cancellable(&Cancellation::default())
    }

    pub fn flush_cancellable(&mut self, cancel: &Cancellation) -> Result<(), VectorError> {
        if self.mutable.is_empty() {
            return Ok(());
        }
        let Some(plan) = self.plan_flush_l0()? else {
            return Err(VectorError::BufferFull);
        };
        let replacement = plan.execute(cancel)?;
        self.commit_flush_l0(plan, replacement, &HashSet::new())
    }

    fn append_replacement_segment(
        &mut self,
        added: Option<Segment>,
        seq: SpaceSeq,
        replaced: &[NoteId],
    ) -> Result<(), VectorError> {
        let mut segments = self.segments.clone();
        let mut dirty = Vec::new();
        for (index, segment) in segments.iter_mut().enumerate() {
            let before = segment.tombstones.bitmap().cardinality();
            for note in replaced {
                if let Some(slots) = segment.data.note_slots(note) {
                    for slot in slots {
                        segment.tombstones.mark(slot);
                    }
                }
            }
            if segment.tombstones.bitmap().cardinality() != before {
                dirty.push(index);
            }
        }
        if let Some(segment) = added {
            segments.push(segment);
            segments.sort_unstable_by_key(|segment| segment.id);
        }
        self.publish(segments, seq, self.manifest.complete_backfill)?;
        // Direct large upserts have no WAL backing; publish the replacement segment
        // first so a pre-publish crash leaves prior tombstones intact, and reopen
        // reconciles any post-publish crash before these tombstones reach disk.
        for index in dirty {
            let segment = &self.segments[index];
            segment
                .tombstones
                .persist(&tombstone_path(&self.path, segment.id))?;
        }
        for segment in &mut self.segments {
            segment.rebuild_superseded(&self.mutable);
        }
        Ok(())
    }

    pub fn seed(&mut self, builder: SegmentBuilder, seq: SpaceSeq) -> Result<(), VectorError> {
        if seq < self.manifest.vector_seq || !self.segments.is_empty() || !self.mutable.is_empty() {
            return Err(VectorError::CorruptIndex);
        }
        let added = self.seal(builder)?;
        self.publish(added.into_iter().collect(), seq, true)
    }

    /// Publish pre-sealed bounded segments produced during a multi-segment backfill.
    /// Callers must cut segments on note boundaries so no note spans two segments.
    pub fn seed_segments(
        &mut self,
        staged: Vec<(u64, MmapSegment)>,
        seq: SpaceSeq,
    ) -> Result<(), VectorError> {
        if seq < self.manifest.vector_seq || !self.segments.is_empty() || !self.mutable.is_empty() {
            return Err(VectorError::CorruptIndex);
        }
        let dimension = self.manifest.model.dimension as usize;
        let mut segments = Vec::with_capacity(staged.len());
        let mut max_id = 0u64;
        for (id, data) in staged {
            if id == 0 || data.dimension() != dimension {
                return Err(VectorError::InvalidDimension);
            }
            max_id = max_id.max(id);
            segments.push(Segment {
                id,
                data: Arc::new(data),
                tombstones: Tombstones::default(),
                superseded: Bitmap::new(),
            });
        }
        segments.sort_unstable_by_key(|segment| segment.id);
        if segments.windows(2).any(|pair| pair[0].id >= pair[1].id) {
            return Err(VectorError::CorruptIndex);
        }
        if max_id >= self.next_segment {
            self.next_segment = max_id.checked_add(1).ok_or(VectorError::BufferFull)?;
        }
        self.publish(segments, seq, true)
    }

    pub fn checkpoint(&mut self, seq: SpaceSeq) -> Result<(), VectorError> {
        if self.mutable.is_failed() {
            return Err(VectorError::CorruptIndex);
        }
        self.publish(self.segments.clone(), seq, self.manifest.complete_backfill)
    }

    pub fn is_checkpointed(&self, seq: SpaceSeq) -> bool {
        self.manifest.vector_seq == seq && self.mutable.last_seq() <= seq
    }

    pub(crate) fn matches_note_chunks(&self, note: &NoteId, chunks: &[VectorChunk]) -> bool {
        let mut metadata = Vec::new();
        if let Some(rows) = self.mutable.chunks_for_note(note) {
            metadata.extend(rows.iter().map(|row| row.metadata.clone()));
        } else {
            for segment in &self.segments {
                if let Some(slots) = segment.data.note_slots(note) {
                    metadata.extend(slots.filter_map(|slot| {
                        (!segment.tombstones.bitmap().contains(slot))
                            .then(|| segment.data.metadata(slot))
                            .flatten()
                    }));
                }
            }
        }
        if metadata.len() != chunks.len() {
            return false;
        }
        let key = |meta: &ChunkMetadata| (meta.spans[0].start(), meta.key);
        let mut expected: Vec<_> = chunks.iter().map(|chunk| &chunk.metadata).collect();
        metadata.sort_unstable_by_key(key);
        expected.sort_unstable_by_key(|meta| key(meta));
        metadata.iter().eq(expected)
    }

    pub fn should_compact(&self) -> bool {
        if self.segments.iter().any(Segment::is_dead_heavy) {
            return true;
        }
        let small = self.segments.iter().filter(|seg| seg.is_small()).count();
        small > MAX_SMALL_SEGMENTS
    }

    /// Select one bounded compaction group (`<= MAX_SEGMENT_BUILD_BYTES` live)
    /// without removing `self` from the owning indexer.
    pub fn plan_compact(&mut self) -> Option<CompactionPlan> {
        if self.has_active_plan() {
            return None;
        }
        let mut dead: Vec<usize> = self
            .segments
            .iter()
            .enumerate()
            .filter(|(_, seg)| seg.is_dead_heavy())
            .map(|(index, _)| index)
            .collect();
        let small: Vec<usize> = self
            .segments
            .iter()
            .enumerate()
            .filter(|(_, seg)| seg.is_small() && !seg.is_dead_heavy())
            .map(|(index, _)| index)
            .collect();

        let mut chosen = Vec::new();
        let mut group_bytes = 0usize;
        if !dead.is_empty() {
            dead.sort_unstable_by(|&a, &b| {
                let lhs = self.segments[a].tombstones.bitmap().cardinality()
                    * u64::from(self.segments[b].data.len());
                let rhs = self.segments[b].tombstones.bitmap().cardinality()
                    * u64::from(self.segments[a].data.len());
                rhs.cmp(&lhs).then_with(|| a.cmp(&b))
            });
            let first = dead[0];
            chosen.push(first);
            group_bytes = self.segments[first].live_build_bytes();
            for &idx in dead.iter().skip(1).chain(&small) {
                let bytes = self.segments[idx].live_build_bytes();
                if group_bytes.saturating_add(bytes) <= MAX_SEGMENT_BUILD_BYTES {
                    chosen.push(idx);
                    group_bytes = group_bytes.saturating_add(bytes);
                }
            }
        } else if small.len() > MAX_SMALL_SEGMENTS {
            for &idx in &small {
                let bytes = self.segments[idx].live_build_bytes();
                if chosen.is_empty() || group_bytes.saturating_add(bytes) <= MAX_SEGMENT_BUILD_BYTES
                {
                    chosen.push(idx);
                    group_bytes = group_bytes.saturating_add(bytes);
                }
            }
            if chosen.len() < 2 {
                return None;
            }
        } else {
            return None;
        }

        chosen.sort_unstable();
        let target_id = self.alloc_segment_id().ok()?;
        let replaced_ids = chosen.iter().map(|&idx| self.segments[idx].id).collect();
        let sources = chosen
            .into_iter()
            .map(|idx| {
                let seg = &self.segments[idx];
                (seg.id, seg.data.clone(), seg.tombstones.clone())
            })
            .collect();
        let guard = self.acquire_plan_guard()?;
        Some(CompactionPlan {
            path: self.path.clone(),
            model: self.manifest.model.clone(),
            replaced_ids,
            sources,
            target_id,
            guard,
        })
    }

    /// Atomically swap compacted segments in `EpochManifest`, carrying over any
    /// tombstones and mutable overrides recorded while `plan.execute()` ran.
    pub fn commit_compaction(
        &mut self,
        plan: CompactionPlan,
        replacement: Option<MmapSegment>,
        dirty_notes: &HashSet<NoteId>,
    ) -> Result<(), VectorError> {
        if !plan.guard.matches(&self.active_plan) {
            return Err(VectorError::CorruptIndex);
        }
        if plan.model != self.manifest.model {
            return Err(VectorError::InvalidDimension);
        }
        let replaced_set: BTreeSet<u64> = plan.replaced_ids.iter().copied().collect();
        let current_by_id: HashMap<u64, &Segment> = self
            .segments
            .iter()
            .filter(|seg| replaced_set.contains(&seg.id))
            .map(|seg| (seg.id, seg))
            .collect();
        if current_by_id.len() != replaced_set.len() {
            return Err(VectorError::CorruptIndex);
        }

        let mut new_segments: Vec<Segment> = self
            .segments
            .iter()
            .filter(|seg| !replaced_set.contains(&seg.id))
            .cloned()
            .collect();

        if let Some(data) = replacement {
            let mut tombstones = Tombstones::default();
            // Carry over tombstones newly applied to replaced segments during BgTask.
            for (seg_id, source_data, snapshot_tombstones) in &plan.sources {
                let current = current_by_id[seg_id];
                let delta = current
                    .tombstones
                    .bitmap()
                    .andnot(snapshot_tombstones.bitmap());
                for slot in delta.iter() {
                    if let Some(src_ord) = source_data.note_ord_for_slot(slot)
                        && let Some(raw) = source_data.note_bytes_by_ord(src_ord)
                        && let Some(dst_ord) = data.find_note_ord(raw)
                        && let Some(new_slots) = data.note_slots_by_ord(dst_ord)
                    {
                        for new_slot in new_slots {
                            tombstones.mark(new_slot);
                        }
                    }
                }
            }
            for note in dirty_notes {
                if let Some(new_slots) = data.note_slots(note) {
                    for new_slot in new_slots {
                        tombstones.mark(new_slot);
                    }
                }
            }
            if !tombstones.bitmap().is_empty() {
                tombstones.persist(&tombstone_path(&self.path, plan.target_id))?;
            }
            let mut segment = Segment {
                id: plan.target_id,
                data: Arc::new(data),
                tombstones,
                superseded: Bitmap::new(),
            };
            segment.rebuild_superseded(&self.mutable);
            new_segments.push(segment);
            new_segments.sort_unstable_by_key(|seg| seg.id);
        }

        self.publish(
            new_segments,
            self.manifest.vector_seq,
            self.manifest.complete_backfill,
        )
    }

    pub fn compact(&mut self) -> Result<(), VectorError> {
        self.compact_cancellable(&Cancellation::default())
    }

    pub fn compact_cancellable(&mut self, cancel: &Cancellation) -> Result<(), VectorError> {
        if self.has_active_plan() {
            return Err(VectorError::BufferFull);
        }
        self.flush_cancellable(cancel)?;
        while let Some(plan) = self.plan_compact() {
            let replacement = plan.execute(cancel)?;
            self.commit_compaction(plan, replacement, &HashSet::new())?;
        }
        Ok(())
    }

    pub fn collect_obsolete(&self) -> Result<(), VectorError> {
        let active: BTreeSet<_> = self.manifest.active_segments.iter().copied().collect();
        for id in disk_generations(&self.path)? {
            if !active.contains(&id) {
                remove_path_if_exists(&segment_file_path(&self.path, id))?;
                remove_path_if_exists(&tombstone_path(&self.path, id))?;
            }
        }
        for entry in fs::read_dir(&self.path)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if is_orphan_temp(&name) {
                remove_path_if_exists(&entry.path())?;
            }
        }
        let dir = Dir::open_ambient_dir(&self.path, ambient_authority())?;
        sync_dir(&dir)?;
        Ok(())
    }

    fn alloc_segment_id(&mut self) -> Result<u64, VectorError> {
        let id = self.next_segment;
        self.next_segment = id.checked_add(1).ok_or(VectorError::BufferFull)?;
        Ok(id)
    }

    fn seal(&mut self, builder: SegmentBuilder) -> Result<Option<Segment>, VectorError> {
        if builder.is_empty() {
            return Ok(None);
        }
        if !builder.matches(&self.manifest.model) {
            return Err(VectorError::InvalidDimension);
        }
        let id = self.alloc_segment_id()?;
        let data = builder
            .finish(&segment_file_path(&self.path, id))?
            .ok_or(VectorError::CorruptIndex)?;
        Ok(Some(Segment {
            id,
            data: Arc::new(data),
            tombstones: Tombstones::default(),
            superseded: Bitmap::new(),
        }))
    }

    fn publish(
        &mut self,
        segments: Vec<Segment>,
        seq: SpaceSeq,
        complete: bool,
    ) -> Result<(), VectorError> {
        let manifest = EpochManifest {
            active_segments: segments.iter().map(|segment| segment.id).collect(),
            vector_seq: self.manifest.vector_seq.max(seq),
            complete_backfill: complete,
            ..self.manifest.clone()
        };
        self.layout.publish_epoch(&manifest)?;
        self.manifest = manifest;
        self.segments = segments;
        Ok(())
    }
}

fn segment_note_has_live_slots(segment: &Segment, note_ord: u32) -> Result<bool, VectorError> {
    if segment.tombstones.bitmap().is_empty() {
        return Ok(true);
    }
    let mut slots = segment
        .data
        .note_slots_by_ord(note_ord)
        .ok_or(VectorError::CorruptIndex)?;
    let dead = segment.tombstones.bitmap();
    Ok(slots.any(|slot| !dead.contains(slot)))
}

fn reconcile_superseded_tombstones(
    path: &Path,
    segments: &mut [Segment],
) -> Result<(), VectorError> {
    if segments.len() < 2 {
        return Ok(());
    }
    for older_idx in 0..segments.len() - 1 {
        let (left, newer_slice) = segments.split_at_mut(older_idx + 1);
        let older = &mut left[older_idx];
        let before = older.tombstones.bitmap().cardinality();
        let older_notes = older.data.num_notes();
        for newer in newer_slice {
            let newer_notes = newer.data.num_notes();
            if (newer_notes as usize).saturating_mul(20) < (older_notes as usize) {
                for n_ord in 0..newer_notes {
                    if !segment_note_has_live_slots(newer, n_ord)? {
                        continue;
                    }
                    let bytes = newer
                        .data
                        .note_bytes_by_ord(n_ord)
                        .ok_or(VectorError::CorruptIndex)?;
                    if let Some(o_ord) = older.data.find_note_ord(bytes) {
                        let slots = older
                            .data
                            .note_slots_by_ord(o_ord)
                            .ok_or(VectorError::CorruptIndex)?;
                        for slot in slots {
                            older.tombstones.mark(slot);
                        }
                    }
                }
            } else {
                let (mut oi, mut ni) = (0u32, 0u32);
                while oi < older_notes && ni < newer_notes {
                    let o_bytes = older
                        .data
                        .note_bytes_by_ord(oi)
                        .ok_or(VectorError::CorruptIndex)?;
                    let n_bytes = newer
                        .data
                        .note_bytes_by_ord(ni)
                        .ok_or(VectorError::CorruptIndex)?;
                    match o_bytes.cmp(n_bytes) {
                        Ordering::Less => oi += 1,
                        Ordering::Greater => ni += 1,
                        Ordering::Equal => {
                            if segment_note_has_live_slots(newer, ni)? {
                                let slots = older
                                    .data
                                    .note_slots_by_ord(oi)
                                    .ok_or(VectorError::CorruptIndex)?;
                                for slot in slots {
                                    older.tombstones.mark(slot);
                                }
                            }
                            oi += 1;
                            ni += 1;
                        }
                    }
                }
            }
        }
        if older.tombstones.bitmap().cardinality() != before {
            older.tombstones.persist(&tombstone_path(path, older.id))?;
        }
    }
    Ok(())
}

pub fn segment_file_path(path: &Path, id: u64) -> PathBuf {
    path.join(format!("seg_{id:016x}.seg"))
}

fn tombstone_path(path: &Path, id: u64) -> PathBuf {
    path.join(format!("seg_{id:016x}.tomb"))
}

fn is_orphan_temp(name: &str) -> bool {
    name.ends_with(".tmp")
        && (name.starts_with(".segment-")
            || name.starts_with("l0.wal.")
            || name.starts_with("epoch_manifest.json.")
            || name.contains(".tomb.")
            || name.contains("_manifest.json."))
}

fn disk_generations(path: &Path) -> Result<BTreeSet<u64>, VectorError> {
    let mut found = BTreeSet::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(suffix) = name.strip_prefix("seg_") else {
            continue;
        };
        let Some(number) = suffix
            .strip_suffix(".seg")
            .or_else(|| suffix.strip_suffix(".tomb"))
        else {
            continue;
        };
        if number.len() != 16 {
            return Err(VectorError::CorruptIndex);
        }
        let id = u64::from_str_radix(number, 16).map_err(|_| VectorError::CorruptIndex)?;
        found.insert(id);
    }
    Ok(found)
}
