//! Durability order for one model's mutable buffer and immutable segments.

use super::{
    ChunkMetadata, EXACT_SCAN_LIMIT, L0_MAX_CHUNKS, MmapSegment, MutableBuffer, MutableOperation,
    QuantizedVector, SearchBudget, SegmentBuilder, Tombstones, VectorChunk, VectorError,
    format::class_number,
    hnsw::{self, ExactNeighbor, Similarity},
};
use crate::layout::{EpochManifest, SearchLayout, VectorModel};
use croaring::Bitmap;
use notarium_core::{
    classes::DocClass,
    ids::{ContentDigest, ModelProfileId, NoteId, SpaceSeq},
};
use std::{
    collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap},
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const MAX_SEGMENTS: usize = 6;

#[derive(Clone)]
struct Segment {
    id: u64,
    index: Arc<SegmentIndex>,
    tombstones: Tombstones,
}
struct SegmentIndex {
    data: MmapSegment,
    notes: HashMap<NoteId, Vec<u32>>,
    folders: HashMap<u32, Bitmap>,
    classes: [Bitmap; 4],
    keys: HashMap<ContentDigest, u32>,
}
impl SegmentIndex {
    fn new(data: MmapSegment) -> Result<Self, VectorError> {
        let mut notes: HashMap<_, Vec<_>> = HashMap::new();
        let mut folders: HashMap<_, Bitmap> = HashMap::new();
        let mut classes = std::array::from_fn(|_| Bitmap::new());
        let mut keys = HashMap::new();
        for slot in 0..data.len() {
            let note = data.note_id(slot).ok_or(VectorError::CorruptIndex)?;
            let folder = data.folder(slot).ok_or(VectorError::CorruptIndex)?;
            let class = data
                .class(slot)
                .and_then(class_number)
                .ok_or(VectorError::CorruptIndex)?;
            let key = data.chunk_key(slot).ok_or(VectorError::CorruptIndex)?;
            notes.entry(note).or_default().push(slot);
            folders.entry(folder).or_default().add(slot);
            classes[usize::from(class) - 1].add(slot);
            keys.entry(key).or_insert(slot);
        }
        Ok(Self {
            data,
            notes,
            folders,
            classes,
            keys,
        })
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

pub struct VectorSnapshot {
    epoch: EpochManifest,
    segments: Vec<Segment>,
    mutable: BTreeMap<NoteId, Arc<Vec<VectorChunk>>>,
}

impl VectorSnapshot {
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
        self.search_mode(query, filter, limit, budget, false)
    }

    /// Exhaustive quantized scoring for callers that need a recall reference.
    pub fn search_exact(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
    ) -> Result<VectorResults, VectorError> {
        self.search_mode(query, filter, limit, budget, true)
    }

    fn search_mode(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
        force_exact: bool,
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
        self.search_mutable(query, filter, limit, budget, &mut hits)?;
        for segment in &self.segments {
            budget.check()?;
            let allowed = self.allowed_slots(segment, filter, budget)?;
            let exact = force_exact || allowed.cardinality() <= EXACT_SCAN_LIMIT;
            let result = segment
                .index
                .data
                .search_mode(query, &allowed, limit, budget, exact)?;
            hnsw_hops += result.hnsw_hops;
            for neighbor in result.neighbors {
                let metadata = segment
                    .index
                    .data
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

    fn allowed_slots(
        &self,
        segment: &Segment,
        filter: &VectorFilter<'_>,
        budget: SearchBudget<'_>,
    ) -> Result<Bitmap, VectorError> {
        let mut allowed = Bitmap::new();
        let index = &segment.index;
        for class in filter.classes.iter().copied().filter_map(class_number) {
            allowed.or_inplace(&index.classes[usize::from(class) - 1]);
        }
        if let Some(folders) = filter.folders {
            let mut selected = Bitmap::new();
            for (index, folder) in folders.iter().enumerate() {
                if index.is_multiple_of(128) {
                    budget.check()?;
                }
                if let Some(slots) = segment.index.folders.get(&folder) {
                    selected.or_inplace(slots);
                }
            }
            allowed.and_inplace(&selected);
        }
        if let Some(notes) = filter.notes {
            let mut selected = Bitmap::new();
            for (position, note) in notes.iter().enumerate() {
                if position.is_multiple_of(128) {
                    budget.check()?;
                }
                if let Some(slots) = index.notes.get(note) {
                    selected.add_many(slots);
                }
            }
            allowed.and_inplace(&selected);
        }
        allowed.andnot_inplace(segment.tombstones.bitmap());
        if let Some(excluded) = filter.excluded {
            for note in excluded {
                if let Some(slots) = index.notes.get(note) {
                    for &slot in slots {
                        allowed.remove(slot);
                    }
                }
            }
        }
        for (position, note) in self.mutable.keys().enumerate() {
            if position.is_multiple_of(128) {
                budget.check()?;
            }
            if let Some(slots) = index.notes.get(note) {
                for &slot in slots {
                    allowed.remove(slot);
                }
            }
        }
        Ok(allowed)
    }

    fn search_mutable(
        &self,
        query: &QuantizedVector,
        filter: &VectorFilter<'_>,
        limit: usize,
        budget: SearchBudget<'_>,
        hits: &mut Vec<VectorHit>,
    ) -> Result<(), VectorError> {
        let scorer = Similarity::new(query.values(), query.scale())?;
        let mut eligible = Vec::new();
        let mut best = BinaryHeap::with_capacity(limit);
        let chunks = self
            .mutable
            .iter()
            .filter(|(note, _)| filter.notes.is_none_or(|notes| notes.contains(*note)))
            .filter(|(note, _)| filter.excluded.is_none_or(|notes| !notes.contains(*note)))
            .flat_map(|(_, chunks)| chunks.iter());
        for (index, chunk) in chunks.enumerate() {
            if index.is_multiple_of(128) {
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
            eligible.push(chunk);
            hnsw::keep_best(
                &mut best,
                ExactNeighbor {
                    hit: scorer.score(slot, chunk.vector.values(), chunk.vector.scale()),
                    note: meta.note.as_str().as_bytes(),
                    span: meta.spans[0].start(),
                    key: meta.key.as_bytes(),
                },
                limit,
            );
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

/// A single indexing owner mutates an epoch. Queries use immutable snapshots.
pub struct VectorEpoch {
    layout: Arc<SearchLayout>,
    path: PathBuf,
    manifest: EpochManifest,
    segments: Vec<Segment>,
    mutable: MutableBuffer,
    next_segment: u64,
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
            let data = MmapSegment::open(&segment_path(&path, id), &model.hash())?;
            if data.dimension() != dimension {
                return Err(VectorError::InvalidDimension);
            }
            let tombstones = Tombstones::open(&tombstone_path(&path, id), data.len())?;
            segments.push(Segment {
                id,
                index: Arc::new(SegmentIndex::new(data)?),
                tombstones,
            });
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
        })
    }

    pub fn snapshot(&self) -> VectorSnapshot {
        VectorSnapshot {
            epoch: self.manifest.clone(),
            segments: self.segments.clone(),
            mutable: self.mutable.snapshot(),
        }
    }

    /// Copy a numerical embedding with the same model and rendered text.
    /// Every new chunk keeps its own metadata and source spans.
    pub fn find_vector(&self, key: ContentDigest) -> Option<QuantizedVector> {
        if let Some(chunk) = self
            .mutable
            .chunks()
            .find(|chunk| chunk.metadata.key == key)
        {
            return Some(chunk.vector.clone());
        }
        self.segments.iter().rev().find_map(|segment| {
            segment
                .index
                .keys
                .get(&key)
                .and_then(|&slot| segment.index.data.owned_vector(slot))
        })
    }

    pub fn apply(&mut self, seq: SpaceSeq, operation: MutableOperation) -> Result<(), VectorError> {
        if seq < self.manifest.vector_seq || operation.count() > L0_MAX_CHUNKS {
            return Err(VectorError::InvalidChunk);
        }
        if matches!(
            self.mutable.admit(seq, &operation),
            Err(VectorError::BufferFull)
        ) {
            self.flush()?;
        }
        self.mutable.apply(seq, operation)
    }

    pub fn should_flush(&self, now: Instant) -> bool {
        self.mutable.should_flush(now)
    }

    pub fn flush(&mut self) -> Result<(), VectorError> {
        if self.mutable.is_empty() {
            return Ok(());
        }
        let mut builder = self.builder()?;
        for chunk in self.mutable.chunks() {
            builder.push(chunk.clone())?;
        }
        let added = self.seal(builder)?;
        let mut segments = self.segments.clone();
        for segment in &mut segments {
            let before = segment.tombstones.bitmap().cardinality();
            for note in self.mutable.notes() {
                if let Some(slots) = segment.index.notes.get(note) {
                    for &slot in slots {
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
        segments.extend(added);
        self.publish(
            segments,
            self.mutable.last_seq(),
            self.manifest.complete_backfill,
        )?;
        self.mutable.reset_after_flush()
    }

    pub fn seed(&mut self, builder: SegmentBuilder, seq: SpaceSeq) -> Result<(), VectorError> {
        if seq < self.manifest.vector_seq || !self.segments.is_empty() || !self.mutable.is_empty() {
            return Err(VectorError::CorruptIndex);
        }
        let added = self.seal(builder)?;
        self.publish(added.into_iter().collect(), seq, true)
    }

    pub fn checkpoint(&mut self, seq: SpaceSeq) -> Result<(), VectorError> {
        self.publish(self.segments.clone(), seq, self.manifest.complete_backfill)
    }

    pub fn is_checkpointed(&self, seq: SpaceSeq) -> bool {
        self.manifest.vector_seq == seq && self.mutable.last_seq() <= seq
    }

    pub(crate) fn matches_model(&self, model: &VectorModel) -> bool {
        &self.manifest.model == model
    }

    pub(crate) fn matches_note_chunks(&self, note: &NoteId, chunks: &[VectorChunk]) -> bool {
        let mut metadata = Vec::new();
        if let Some(rows) = self.mutable.chunks_for_note(note) {
            metadata.extend(rows.iter().map(|row| row.metadata.clone()));
        } else {
            for segment in &self.segments {
                if let Some(slots) = segment.index.notes.get(note) {
                    metadata.extend(slots.iter().filter_map(|&slot| {
                        (!segment.tombstones.bitmap().contains(slot))
                            .then(|| segment.index.data.metadata(slot))
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
        if self.segments.len() > MAX_SEGMENTS {
            return true;
        }
        let nodes: u64 = self
            .segments
            .iter()
            .map(|segment| u64::from(segment.index.data.len()))
            .sum();
        let dead: u64 = self
            .segments
            .iter()
            .map(|segment| segment.tombstones.bitmap().cardinality())
            .sum();
        nodes > 0 && dead * 5 > nodes
    }

    pub fn compact(&mut self) -> Result<(), VectorError> {
        self.flush()?;
        let mut builder = self.builder()?;
        for segment in &self.segments {
            append_live(segment, &mut builder, None)?;
        }
        let added = self.seal(builder)?;
        self.publish(
            added.into_iter().collect(),
            self.manifest.vector_seq,
            self.manifest.complete_backfill,
        )
    }

    /// Rewrite every segment that contains the note, including slots already
    /// covered by tombstones. Call collect_obsolete after rotating readers.
    pub fn scrub_note(&mut self, note: &NoteId, seq: SpaceSeq) -> Result<(), VectorError> {
        let mut segments = Vec::with_capacity(self.segments.len());
        for segment in self.segments.clone() {
            if !segment.index.notes.contains_key(note) {
                segments.push(segment);
                continue;
            }
            let mut builder = self.builder()?;
            append_live(&segment, &mut builder, Some(note))?;
            segments.extend(self.seal(builder)?);
        }
        segments.sort_unstable_by_key(|segment| segment.id);
        self.mutable.scrub_note(note)?;
        self.publish(segments, seq, self.manifest.complete_backfill)
    }

    pub fn collect_obsolete(&self) -> Result<(), VectorError> {
        let active: BTreeSet<_> = self.manifest.active_segments.iter().copied().collect();
        for id in disk_generations(&self.path)? {
            if !active.contains(&id) {
                remove_if_exists(&segment_path(&self.path, id))?;
                remove_if_exists(&tombstone_path(&self.path, id))?;
            }
        }
        for entry in fs::read_dir(&self.path)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or(VectorError::CorruptIndex)?;
            if name.ends_with(".tmp")
                && (name.starts_with(".segment-") || name.starts_with("l0.wal."))
            {
                remove_if_exists(&entry.path())?;
            }
        }
        std::fs::File::open(&self.path)?.sync_all()?;
        Ok(())
    }

    fn builder(&self) -> Result<SegmentBuilder, VectorError> {
        SegmentBuilder::for_model(&self.manifest.model)
    }

    fn seal(&mut self, builder: SegmentBuilder) -> Result<Option<Segment>, VectorError> {
        if builder.is_empty() {
            return Ok(None);
        }
        if !builder.matches(&self.manifest.model) {
            return Err(VectorError::InvalidDimension);
        }
        let id = self.next_segment;
        self.next_segment = id.checked_add(1).ok_or(VectorError::BufferFull)?;
        let data = builder
            .finish(&segment_path(&self.path, id))?
            .ok_or(VectorError::CorruptIndex)?;
        Ok(Some(Segment {
            id,
            index: Arc::new(SegmentIndex::new(data)?),
            tombstones: Tombstones::default(),
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

fn append_live(
    segment: &Segment,
    builder: &mut SegmentBuilder,
    purged: Option<&NoteId>,
) -> Result<(), VectorError> {
    let data = &segment.index.data;
    for slot in 0..data.len() {
        if segment.tombstones.bitmap().contains(slot) {
            continue;
        }
        let metadata = data.metadata(slot).ok_or(VectorError::CorruptIndex)?;
        if purged == Some(&metadata.note) {
            continue;
        }
        let vector = data.owned_vector(slot).ok_or(VectorError::CorruptIndex)?;
        builder.push(VectorChunk { metadata, vector })?;
    }
    Ok(())
}

fn segment_path(path: &Path, id: u64) -> PathBuf {
    path.join(format!("seg_{id:016x}.seg"))
}
fn tombstone_path(path: &Path, id: u64) -> PathBuf {
    path.join(format!("seg_{id:016x}.tomb"))
}
fn disk_generations(path: &Path) -> Result<BTreeSet<u64>, VectorError> {
    let mut found = BTreeSet::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().ok_or(VectorError::CorruptIndex)?;
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
fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
