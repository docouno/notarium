//! A segment is assembled from one input stream. The only disk copy is the
//! sealed generation that will become visible through the epoch manifest.

use super::{
    M, M0, MAX_DIMENSION, MIN_DIMENSION, MmapSegment, QuantizedVector, VectorChunk, VectorError,
    format::*, hnsw::BuilderGraph,
};
use crate::layout::{VectorModel, remove_file_if_exists, sync_dir};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use croaring::{Bitmap, Portable};
use notarium_core::{
    ids::{ContentDigest, ModelProfileId, NoteId},
    ports::Cancellation,
};
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, BufWriter, Write},
    ops::Range,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

pub const MAX_SEGMENT_BUILD_BYTES: usize = 112 * 1024 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub struct SegmentBuilder {
    graph: BuilderGraph,
    dimension: usize,
    hash: [u8; 32],
    keys: Option<HashMap<ContentDigest, usize>>,
}

impl SegmentBuilder {
    pub fn new(model: &ModelProfileId, dimension: usize) -> Result<Self, VectorError> {
        let dimension = u32::try_from(dimension).map_err(|_| VectorError::InvalidDimension)?;
        Self::for_model(&VectorModel::local(model.clone(), dimension))
    }

    pub(crate) fn for_model(model: &VectorModel) -> Result<Self, VectorError> {
        Self::for_model_with_keys(model, true)
    }

    pub(crate) fn for_compaction(model: &VectorModel) -> Result<Self, VectorError> {
        Self::for_model_with_keys(model, false)
    }

    fn for_model_with_keys(model: &VectorModel, track_keys: bool) -> Result<Self, VectorError> {
        let dimension = model.dimension as usize;
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension) {
            return Err(VectorError::InvalidDimension);
        }
        Ok(Self {
            graph: BuilderGraph::new(dimension),
            dimension,
            hash: model.hash(),
            keys: track_keys.then(HashMap::new),
        })
    }

    pub fn push(&mut self, chunk: VectorChunk) -> Result<(), VectorError> {
        self.push_with_cancel(chunk, None)
    }

    pub fn push_cancellable(
        &mut self,
        chunk: VectorChunk,
        cancel: &Cancellation,
    ) -> Result<(), VectorError> {
        self.push_with_cancel(chunk, Some(cancel))
    }

    fn push_with_cancel(
        &mut self,
        chunk: VectorChunk,
        cancel: Option<&Cancellation>,
    ) -> Result<(), VectorError> {
        if cancel.is_some_and(Cancellation::is_cancelled) {
            return Err(VectorError::Cancelled);
        }
        if self.at_budget() {
            return Err(VectorError::BufferFull);
        }
        chunk.validate(self.dimension)?;
        let key = chunk.metadata.key;
        let slot = self.graph.len();
        self.graph.push(chunk, cancel)?;
        if let Some(keys) = &mut self.keys {
            keys.entry(key).or_insert(slot);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn with_test_rows(
        model: &ModelProfileId,
        dimension: usize,
        rows: Vec<VectorChunk>,
    ) -> Self {
        let mut builder = Self::new(model, dimension).unwrap();
        let count = rows.len() as u32;
        for (slot, chunk) in (0u32..).zip(rows) {
            chunk.validate(dimension).unwrap();
            let key = chunk.metadata.key;
            let mut base_row = [0u32; M0];
            let mut base_len = 0usize;
            if let Some(previous) = slot.checked_sub(1) {
                base_row[base_len] = previous / 2;
                base_len += 1;
            }
            for next in [slot * 2 + 1, slot * 2 + 2] {
                if next < count {
                    base_row[base_len] = next;
                    base_len += 1;
                }
            }
            builder
                .graph
                .append_node_data(chunk, base_row, base_len as u8, None)
                .unwrap();
            if let Some(keys) = &mut builder.keys {
                keys.entry(key).or_insert(slot as usize);
            }
        }
        builder
    }

    pub fn find_vector(&self, key: ContentDigest) -> Option<QuantizedVector> {
        let &slot = self.keys.as_ref()?.get(&key)?;
        Some(self.graph.vector_at(slot))
    }

    pub fn estimated_bytes(&self) -> usize {
        self.len().saturating_mul(self.row_build_bytes())
    }

    fn row_build_bytes(&self) -> usize {
        self.graph.stride + M0 * 4 + 132 + if self.keys.is_some() { 72 } else { 0 }
    }

    pub fn at_budget(&self) -> bool {
        self.full_for_next_row(MAX_SEGMENT_BUILD_BYTES)
    }

    pub(crate) fn full_for_next_row(&self, budget: usize) -> bool {
        self.estimated_bytes()
            .saturating_add(self.row_build_bytes())
            > budget
    }

    pub(super) fn matches(&self, model: &VectorModel) -> bool {
        self.dimension == model.dimension as usize && self.hash == model.hash()
    }

    pub fn len(&self) -> usize {
        self.graph.len()
    }

    pub fn is_empty(&self) -> bool {
        self.graph.is_empty()
    }

    pub fn finish(self, path: &Path) -> Result<Option<MmapSegment>, VectorError> {
        self.finish_with_cancel(path, None)
    }

    pub fn finish_cancellable(
        self,
        path: &Path,
        cancel: &Cancellation,
    ) -> Result<Option<MmapSegment>, VectorError> {
        self.finish_with_cancel(path, Some(cancel))
    }

    fn finish_with_cancel(
        self,
        path: &Path,
        cancel: Option<&Cancellation>,
    ) -> Result<Option<MmapSegment>, VectorError> {
        if self.is_empty() {
            return Ok(None);
        }
        if cancel.is_some_and(Cancellation::is_cancelled) {
            return Err(VectorError::Cancelled);
        }
        let parent = path.parent().ok_or(VectorError::CorruptIndex)?;
        let name = path.file_name().ok_or(VectorError::CorruptIndex)?;
        let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
        let (tmp, file) = create_temp(&dir)?;
        let hash = self.hash;
        let result = (|| {
            let file = file.into_std();
            let mut output = CheckedWriter {
                writer: BufWriter::with_capacity(256 * 1024, &file),
                hash: blake3::Hasher::new(),
            };
            self.write(&mut output, cancel)?;
            let digest = output.finish()?;
            #[cfg(unix)]
            {
                let mut permissions = file.metadata()?.permissions();
                permissions.set_readonly(true);
                file.set_permissions(permissions)?;
            }
            file.sync_all()?;
            drop(file);
            // Linking into the final name is atomic and refuses an existing
            // generation. An already mapped segment keeps its own file identity.
            dir.hard_link(&tmp, &dir, name)?;
            Ok::<[u8; 32], VectorError>(digest)
        })();
        let cleanup = remove_file_if_exists(&dir, &tmp);
        let digest = result?;
        cleanup?;
        sync_dir(&dir)?;
        MmapSegment::open_sealed(path, &hash, &digest).map(Some)
    }

    fn write(
        &self,
        out: &mut CheckedWriter<impl Write>,
        cancel: Option<&Cancellation>,
    ) -> Result<(), VectorError> {
        let prepared = self.prepare_sections(cancel)?;
        let stride = self.graph.stride;
        let num_nodes = self.len();
        let upper_words = self
            .graph
            .upper_edges
            .iter()
            .filter_map(Option::as_deref)
            .flatten()
            .map(|row| row.len() + 1)
            .sum::<usize>();
        let span_count = self.graph.spans.len();
        if span_count > u32::MAX as usize {
            return Err(VectorError::BufferFull);
        }
        let note_bytes = prepared
            .sorted_notes
            .iter()
            .map(|(note, _)| note.as_str().len())
            .sum::<usize>();
        if note_bytes > u32::MAX as usize {
            return Err(VectorError::BufferFull);
        }
        let filters_len = 16usize
            .checked_add(4)
            .and_then(|len| {
                prepared
                    .class_bytes
                    .iter()
                    .try_fold(len, |acc, blob| acc.checked_add(blob.len()))
            })
            .and_then(|len| {
                prepared
                    .folder_entries
                    .len()
                    .checked_mul(FOLDER_DIR_ENTRY_BYTES)
                    .and_then(|dir_len| len.checked_add(dir_len))
            })
            .and_then(|len| len.checked_add(prepared.folder_bytes.len()));
        let file_lengths = [
            num_nodes.checked_mul(4),
            num_nodes.checked_mul(stride),
            num_nodes.checked_mul(BASE_ROW_BYTES),
            Some(num_nodes),
            num_nodes
                .checked_add(1)
                .and_then(|count| count.checked_mul(8)),
            upper_words.checked_mul(4),
            num_nodes.checked_mul(META_BYTES),
            prepared
                .sorted_notes
                .len()
                .checked_add(1)
                .and_then(|count| count.checked_mul(4))
                .and_then(|bytes| bytes.checked_add(note_bytes)),
            span_count.checked_mul(8),
            prepared
                .sorted_notes
                .len()
                .checked_add(1)
                .and_then(|count| count.checked_add(num_nodes))
                .and_then(|count| count.checked_mul(4)),
            prepared.key_entries.len().checked_mul(KEY_ENTRY_BYTES),
            filters_len,
        ];
        let mut sections: [Range<usize>; SECTION_COUNT] = std::array::from_fn(|_| 0..0);
        let mut end = HEADER;
        for (section, len) in sections.iter_mut().zip(file_lengths) {
            let start = end
                .checked_next_multiple_of(64)
                .ok_or(VectorError::BufferFull)?;
            end = start
                .checked_add(len.ok_or(VectorError::BufferFull)?)
                .ok_or(VectorError::BufferFull)?;
            *section = start..end;
        }
        let mut header = [0u8; HEADER];
        header[..8].copy_from_slice(HEADER_MAGIC);
        header[8..12].copy_from_slice(&VERSION.to_le_bytes());
        header[16..48].copy_from_slice(&self.hash);
        header[48..52].copy_from_slice(&(self.dimension as u32).to_le_bytes());
        header[52..56].copy_from_slice(&(stride as u32).to_le_bytes());
        header[56..60].copy_from_slice(&(num_nodes as u32).to_le_bytes());
        header[60..62].copy_from_slice(&u16::from(self.graph.max_level).to_le_bytes());
        header[62..64].copy_from_slice(&(M as u16).to_le_bytes());
        header[64..66].copy_from_slice(&(M0 as u16).to_le_bytes());
        header[68..72].copy_from_slice(&self.graph.entry.to_le_bytes());
        header[72..76].copy_from_slice(&(prepared.sorted_notes.len() as u32).to_le_bytes());
        for (index, section) in sections.iter().enumerate() {
            let offset = 80 + 16 * index;
            header[offset..offset + 8].copy_from_slice(&(section.start as u64).to_le_bytes());
            header[offset + 8..offset + 16].copy_from_slice(&(section.len() as u64).to_le_bytes());
        }
        out.write_all(&header)?;
        let mut preceding = HEADER;
        for (index, section) in sections.iter().enumerate() {
            if cancel.is_some_and(Cancellation::is_cancelled) {
                return Err(VectorError::Cancelled);
            }
            out.write_all(&[0u8; 64][..section.start - preceding])?;
            self.write_section(out, index, stride, &prepared, cancel)?;
            preceding = section.end;
        }
        Ok(())
    }

    fn prepare_sections(
        &self,
        cancel: Option<&Cancellation>,
    ) -> Result<PreparedSections<'_>, VectorError> {
        let num_nodes = self.len();
        let num_notes = self.graph.notes.len();
        let mut sorted_notes: Vec<(&NoteId, u32)> = self
            .graph
            .notes
            .iter()
            .enumerate()
            .map(|(ord, note)| (note, ord as u32))
            .collect();
        sorted_notes.sort_unstable_by(|left, right| {
            left.0.as_str().as_bytes().cmp(right.0.as_str().as_bytes())
        });
        let mut raw_to_sorted = vec![0u32; num_notes];
        for (sorted_ord, &(_, raw_ord)) in sorted_notes.iter().enumerate() {
            raw_to_sorted[raw_ord as usize] =
                u32::try_from(sorted_ord).map_err(|_| VectorError::BufferFull)?;
        }

        let mut note_counts = vec![0u32; num_notes];
        let mut classes: [Bitmap; 4] = std::array::from_fn(|_| Bitmap::new());
        let mut folders: BTreeMap<u32, Bitmap> = BTreeMap::new();
        let mut key_entries: Vec<(u64, u32)> = Vec::with_capacity(num_nodes);
        for (slot_idx, meta) in self.graph.metas.iter().enumerate() {
            if slot_idx.is_multiple_of(4096) && cancel.is_some_and(Cancellation::is_cancelled) {
                return Err(VectorError::Cancelled);
            }
            let slot = slot_idx as u32;
            let sorted_ord = raw_to_sorted[meta.note_ord as usize] as usize;
            note_counts[sorted_ord] += 1;
            let class_idx =
                usize::from(class_number(meta.class).ok_or(VectorError::InvalidChunk)?) - 1;
            classes[class_idx].add(slot);
            folders.entry(meta.folder).or_default().add(slot);
            let prefix = u64::from_be_bytes(
                meta.key.as_bytes()[..8]
                    .try_into()
                    .expect("digest prefix width"),
            );
            key_entries.push((prefix, slot));
        }

        let mut note_slot_offsets = Vec::with_capacity(num_notes + 1);
        let mut running = 0u32;
        note_slot_offsets.push(0);
        for count in note_counts {
            running = running.checked_add(count).ok_or(VectorError::BufferFull)?;
            note_slot_offsets.push(running);
        }
        let mut next_pos = note_slot_offsets[..num_notes].to_vec();
        let mut note_slots = vec![0u32; num_nodes];
        for (slot_idx, meta) in self.graph.metas.iter().enumerate() {
            let sorted_ord = raw_to_sorted[meta.note_ord as usize] as usize;
            let pos = next_pos[sorted_ord] as usize;
            note_slots[pos] = slot_idx as u32;
            next_pos[sorted_ord] += 1;
        }

        if cancel.is_some_and(Cancellation::is_cancelled) {
            return Err(VectorError::Cancelled);
        }
        // Sort by 8-byte big-endian prefix and full 32-byte digest so dedup
        // collapses exact 32-byte duplicates while keeping colliding 8-byte
        // prefixes distinct and contiguous for range lookup.
        key_entries.sort_unstable_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| {
                    self.graph.metas[left.1 as usize]
                        .key
                        .as_bytes()
                        .cmp(self.graph.metas[right.1 as usize].key.as_bytes())
                })
                .then_with(|| left.1.cmp(&right.1))
        });
        key_entries.dedup_by(|later, earlier| {
            later.0 == earlier.0
                && self.graph.metas[later.1 as usize].key
                    == self.graph.metas[earlier.1 as usize].key
        });

        let class_bytes = classes.map(|mut bitmap| {
            bitmap.run_optimize();
            bitmap.serialize::<Portable>()
        });
        let mut folder_entries = Vec::with_capacity(folders.len());
        let mut folder_bytes = Vec::new();
        for (folder_ord, mut bitmap) in folders {
            bitmap.run_optimize();
            let serialized = bitmap.serialize::<Portable>();
            let offset = u32::try_from(folder_bytes.len()).map_err(|_| VectorError::BufferFull)?;
            let len = u32::try_from(serialized.len()).map_err(|_| VectorError::BufferFull)?;
            folder_bytes.extend_from_slice(&serialized);
            folder_entries.push((folder_ord, offset, len));
        }

        Ok(PreparedSections {
            sorted_notes,
            raw_to_sorted,
            note_slot_offsets,
            note_slots,
            key_entries,
            class_bytes,
            folder_entries,
            folder_bytes,
        })
    }

    fn write_section(
        &self,
        out: &mut CheckedWriter<impl Write>,
        section: usize,
        stride: usize,
        prepared: &PreparedSections<'_>,
        cancel: Option<&Cancellation>,
    ) -> Result<(), VectorError> {
        let num_nodes = self.len();
        match section {
            SCALES => {
                for &scale in &self.graph.scales {
                    out.write_all(&scale.to_le_bytes())?;
                }
            }
            VECTORS => {
                let mut output = [0u8; MAX_DIMENSION];
                for slot in 0..num_nodes {
                    if slot.is_multiple_of(4096) && cancel.is_some_and(Cancellation::is_cancelled) {
                        return Err(VectorError::Cancelled);
                    }
                    let start = slot * stride;
                    for (dst, &value) in output[..stride]
                        .iter_mut()
                        .zip(&self.graph.vectors[start..start + stride])
                    {
                        *dst = value as u8;
                    }
                    out.write_all(&output[..stride])?;
                }
            }
            BASE => {
                let mut row = [0u8; BASE_ROW_BYTES];
                for slot in 0..num_nodes {
                    if slot.is_multiple_of(4096) && cancel.is_some_and(Cancellation::is_cancelled) {
                        return Err(VectorError::Cancelled);
                    }
                    let degree = usize::from(self.graph.base_lens[slot]);
                    row.fill(0);
                    row[..4].copy_from_slice(&(degree as u32).to_le_bytes());
                    for (index, &edge) in self.graph.base_edges[slot][..degree].iter().enumerate() {
                        let offset = (index + 1) * 4;
                        row[offset..offset + 4].copy_from_slice(&edge.to_le_bytes());
                    }
                    out.write_all(&row)?;
                }
            }
            LEVELS => {
                for slot in 0..num_nodes {
                    out.write_all(&[self.graph.node_level_at(slot)])?;
                }
            }
            UPPER_OFFSETS => {
                let mut offset = 0u64;
                out.write_all(&offset.to_le_bytes())?;
                for layers in &self.graph.upper_edges {
                    if let Some(layers) = layers {
                        offset += layers.iter().map(|row| row.len() as u64 + 1).sum::<u64>();
                    }
                    out.write_all(&offset.to_le_bytes())?;
                }
            }
            UPPER => {
                for row in self
                    .graph
                    .upper_edges
                    .iter()
                    .filter_map(Option::as_deref)
                    .flatten()
                {
                    out.write_all(&(row.len() as u32).to_le_bytes())?;
                    for neighbor in row {
                        out.write_all(&neighbor.to_le_bytes())?;
                    }
                }
            }
            METADATA => {
                for (slot, meta) in self.graph.metas.iter().enumerate() {
                    if slot.is_multiple_of(4096) && cancel.is_some_and(Cancellation::is_cancelled) {
                        return Err(VectorError::Cancelled);
                    }
                    let flags = meta.tokens
                        | (class_number(meta.class).ok_or(VectorError::InvalidChunk)? << 10)
                        | (u16::from(meta.spans_len) << 13);
                    let mut row = [0u8; META_BYTES];
                    row[..32].copy_from_slice(meta.key.as_bytes());
                    row[32..64].copy_from_slice(meta.source.as_bytes());
                    row[64..68].copy_from_slice(
                        &prepared.raw_to_sorted[meta.note_ord as usize].to_le_bytes(),
                    );
                    row[68..72].copy_from_slice(&meta.folder.to_le_bytes());
                    row[72..76].copy_from_slice(&meta.span_start.to_le_bytes());
                    row[76..78].copy_from_slice(&flags.to_le_bytes());
                    row[78..80].copy_from_slice(&meta.context_len.to_le_bytes());
                    out.write_all(&row)?;
                }
            }
            NOTES => {
                let mut offset = 0u32;
                out.write_all(&offset.to_le_bytes())?;
                for (note, _) in &prepared.sorted_notes {
                    offset += note.as_str().len() as u32;
                    out.write_all(&offset.to_le_bytes())?;
                }
                for (note, _) in &prepared.sorted_notes {
                    out.write_all(note.as_str().as_bytes())?;
                }
            }
            SPANS => {
                for &(start, end) in &self.graph.spans {
                    out.write_all(&start.to_le_bytes())?;
                    out.write_all(&end.to_le_bytes())?;
                }
            }
            NOTE_SLOTS => {
                for &offset in &prepared.note_slot_offsets {
                    out.write_all(&offset.to_le_bytes())?;
                }
                for &slot in &prepared.note_slots {
                    out.write_all(&slot.to_le_bytes())?;
                }
            }
            KEY_INDEX => {
                for &(prefix, slot) in &prepared.key_entries {
                    out.write_all(&prefix.to_be_bytes())?;
                    out.write_all(&slot.to_le_bytes())?;
                }
            }
            FILTERS => {
                for blob in &prepared.class_bytes {
                    let len = u32::try_from(blob.len()).map_err(|_| VectorError::BufferFull)?;
                    out.write_all(&len.to_le_bytes())?;
                }
                let folder_count = u32::try_from(prepared.folder_entries.len())
                    .map_err(|_| VectorError::BufferFull)?;
                out.write_all(&folder_count.to_le_bytes())?;
                for blob in &prepared.class_bytes {
                    out.write_all(blob)?;
                }
                for &(folder_ord, offset, len) in &prepared.folder_entries {
                    out.write_all(&folder_ord.to_le_bytes())?;
                    out.write_all(&offset.to_le_bytes())?;
                    out.write_all(&len.to_le_bytes())?;
                }
                out.write_all(&prepared.folder_bytes)?;
            }
            _ => return Err(VectorError::CorruptIndex),
        }
        Ok(())
    }
}

struct PreparedSections<'a> {
    sorted_notes: Vec<(&'a NoteId, u32)>,
    raw_to_sorted: Vec<u32>,
    note_slot_offsets: Vec<u32>,
    note_slots: Vec<u32>,
    key_entries: Vec<(u64, u32)>,
    class_bytes: [Vec<u8>; 4],
    folder_entries: Vec<(u32, u32, u32)>,
    folder_bytes: Vec<u8>,
}

fn create_temp(dir: &Dir) -> io::Result<(String, cap_std::fs::File)> {
    loop {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let name = format!(".segment-{}-{serial}.tmp", std::process::id());
        match dir.open_with(&name, OpenOptions::new().write(true).create_new(true)) {
            Ok(file) => return Ok((name, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

struct CheckedWriter<W> {
    writer: W,
    hash: blake3::Hasher,
}

impl<W: Write> CheckedWriter<W> {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.writer.write_all(bytes)?;
        self.hash.update(bytes);
        Ok(())
    }

    fn finish(mut self) -> io::Result<[u8; 32]> {
        let digest = *self.hash.finalize().as_bytes();
        let mut footer = [0u8; FOOTER];
        footer[..32].copy_from_slice(&digest);
        footer[32..40].copy_from_slice(FOOTER_MAGIC);
        self.writer.write_all(&footer)?;
        self.writer.flush()?;
        Ok(digest)
    }
}
