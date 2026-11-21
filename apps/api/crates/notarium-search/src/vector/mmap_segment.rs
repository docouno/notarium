#![allow(unsafe_code)]

//! Read-only mappings of sealed segment files. Cold opens verify header layout
//! and the BLAKE3 footer in a single pass; runtime accessors are bounds-checked.

use super::{
    ChunkMetadata, EXACT_SCAN_LIMIT, M, M0, MAX_CONTEXT_SPANS, MAX_DIMENSION, MAX_LEVEL,
    MIN_DIMENSION, QuantizedVector, SearchBudget, VectorError,
    format::*,
    hnsw::{self, ExactNeighbor, Graph, Neighbor, Similarity},
    simd::Dot,
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use croaring::{Bitmap, Portable};
use memmap2::{Mmap, MmapOptions};
use notarium_core::{
    ids::{ContentDigest, NoteId},
    span::ByteSpan,
};
use std::{
    cmp::{Ordering, Reverse},
    collections::BinaryHeap,
    ops::Range,
    path::Path,
};

pub(super) enum SlotMask<'a> {
    All(u32),
    Ref(&'a Bitmap),
    Owned(Bitmap),
}

impl SlotMask<'_> {
    pub(super) fn cardinality(&self) -> u64 {
        match self {
            Self::All(count) => u64::from(*count),
            Self::Ref(bitmap) => bitmap.cardinality(),
            Self::Owned(bitmap) => bitmap.cardinality(),
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.cardinality() == 0
    }

    pub(super) fn contains(&self, slot: u32) -> bool {
        match self {
            Self::All(count) => slot < *count,
            Self::Ref(bitmap) => bitmap.contains(slot),
            Self::Owned(bitmap) => bitmap.contains(slot),
        }
    }
}

pub struct MmapSegment {
    bytes: Mmap,
    sections: [Range<usize>; SECTION_COUNT],
    classes: [Bitmap; 4],
    folder_dir: Range<usize>,
    folder_data: Range<usize>,
    folder_count: usize,
    dimension: usize,
    stride: usize,
    nodes: usize,
    notes: usize,
    key_count: usize,
    max_level: u8,
    entry: u32,
}

#[derive(Debug)]
pub struct SegmentSearch {
    pub neighbors: Vec<Neighbor>,
    pub hnsw_hops: usize,
}

impl MmapSegment {
    /// Called on files published by the segment builder under the search
    /// directory's single-owner lifecycle. Published files are unlinked or
    /// replaced by rename. All mutations use a different file identity.
    pub(crate) fn open(path: &Path, model_hash: &[u8; 32]) -> Result<Self, VectorError> {
        Self::open_inner(path, model_hash, None)
    }

    /// Open a segment just written by `SegmentBuilder::finish` using the
    /// BLAKE3 digest computed while streaming the file to disk (0 re-scans).
    pub(crate) fn open_sealed(
        path: &Path,
        model_hash: &[u8; 32],
        expected_digest: &[u8; 32],
    ) -> Result<Self, VectorError> {
        Self::open_inner(path, model_hash, Some(expected_digest))
    }

    fn open_inner(
        path: &Path,
        model_hash: &[u8; 32],
        sealed_digest: Option<&[u8; 32]>,
    ) -> Result<Self, VectorError> {
        let parent = path.parent().ok_or(VectorError::CorruptIndex)?;
        let name = path.file_name().ok_or(VectorError::CorruptIndex)?;
        let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
        let meta = dir.symlink_metadata(name)?;
        if !meta.is_file() || meta.len() < (HEADER + FOOTER) as u64 {
            return Err(VectorError::CorruptIndex);
        }
        #[cfg(unix)]
        if !meta.permissions().readonly() {
            return Err(VectorError::CorruptIndex);
        }
        let file = dir
            .open_with(
                name,
                OpenOptions::new().read(true).follow(FollowSymlinks::No),
            )?
            .into_std();
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != meta.len() {
            return Err(VectorError::CorruptIndex);
        }
        #[cfg(unix)]
        if !metadata.permissions().readonly() {
            return Err(VectorError::CorruptIndex);
        }
        // SAFETY: the file is a regular immutable file in an owner-managed
        // generation. The builder seals it before publication and the only
        // supported subsequent operations are rename and unlink. Open file
        // identity survives both operations for the lifetime of the mapping.
        let bytes = unsafe { MmapOptions::new().map(&file)? };
        Self::decode(bytes, model_hash, sealed_digest)
    }

    fn decode(
        bytes: Mmap,
        model_hash: &[u8; 32],
        sealed_digest: Option<&[u8; 32]>,
    ) -> Result<Self, VectorError> {
        if bytes.len() < HEADER + FOOTER || bytes.as_ptr().align_offset(64) != 0 {
            return Err(VectorError::CorruptIndex);
        }
        let data_end = bytes.len() - FOOTER;
        let footer = &bytes[data_end..];
        if &bytes[..8] != HEADER_MAGIC
            || read_u32(&bytes, 8) != VERSION
            || read_u32(&bytes, 12) != 0
            || &bytes[16..48] != model_hash
            || read_u32(&bytes, 76) != 0
            || read_u16(&bytes, 66) != 0
            || bytes[80 + 16 * SECTION_COUNT..HEADER] != [0u8; HEADER - (80 + 16 * SECTION_COUNT)]
            || &footer[32..40] != FOOTER_MAGIC
            || footer[40..] != [0u8; 24]
        {
            return Err(VectorError::CorruptIndex);
        }
        match sealed_digest {
            Some(expected) => {
                if &footer[..32] != expected {
                    return Err(VectorError::CorruptIndex);
                }
            }
            None => {
                if &footer[..32] != blake3::hash(&bytes[..data_end]).as_bytes() {
                    return Err(VectorError::CorruptIndex);
                }
            }
        }
        let dimension = read_u32(&bytes, 48) as usize;
        let stride = read_u32(&bytes, 52) as usize;
        let nodes = read_u32(&bytes, 56) as usize;
        let max_level = read_u16(&bytes, 60);
        let entry = read_u32(&bytes, 68);
        let notes = read_u32(&bytes, 72) as usize;
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension)
            || stride != dimension.next_multiple_of(64)
            || nodes == 0
            || entry as usize >= nodes
            || notes == 0
            || notes > nodes
            || max_level > u16::from(MAX_LEVEL)
            || usize::from(read_u16(&bytes, 62)) != M
            || usize::from(read_u16(&bytes, 64)) != M0
        {
            return Err(VectorError::CorruptIndex);
        }
        let mut sections: [Range<usize>; SECTION_COUNT] = std::array::from_fn(|_| 0..0);
        let mut previous_end = HEADER;
        for (index, section) in sections.iter_mut().enumerate() {
            let offset = 80 + 16 * index;
            let start =
                usize::try_from(read_u64(&bytes, offset)).map_err(|_| VectorError::CorruptIndex)?;
            let len = usize::try_from(read_u64(&bytes, offset + 8))
                .map_err(|_| VectorError::CorruptIndex)?;
            let end = start.checked_add(len).ok_or(VectorError::CorruptIndex)?;
            if start < previous_end || end > data_end || !start.is_multiple_of(64) {
                return Err(VectorError::CorruptIndex);
            }
            *section = start..end;
            previous_end = end;
        }
        let size = |section: usize, count: usize, width: usize| {
            count
                .checked_mul(width)
                .is_some_and(|len| len == sections[section].len())
        };
        let note_slots_words = notes
            .checked_add(1)
            .and_then(|count| count.checked_add(nodes));
        if !size(SCALES, nodes, 4)
            || !size(VECTORS, nodes, stride)
            || !size(BASE, nodes, BASE_ROW_BYTES)
            || !size(LEVELS, nodes, 1)
            || !nodes
                .checked_add(1)
                .is_some_and(|count| size(UPPER_OFFSETS, count, 8))
            || !sections[UPPER].len().is_multiple_of(4)
            || !size(METADATA, nodes, META_BYTES)
            || !sections[SPANS].len().is_multiple_of(8)
            || !note_slots_words.is_some_and(|count| size(NOTE_SLOTS, count, 4))
            || !sections[KEY_INDEX].len().is_multiple_of(KEY_ENTRY_BYTES)
        {
            return Err(VectorError::CorruptIndex);
        }
        let key_count = sections[KEY_INDEX].len() / KEY_ENTRY_BYTES;
        if key_count == 0 || key_count > nodes {
            return Err(VectorError::CorruptIndex);
        }

        // O(1) structural bounds for NOTES, NOTE_SLOTS, UPPER_OFFSETS, and entry.
        let notes_sec = &bytes[sections[NOTES].clone()];
        let notes_offsets_len = notes
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .ok_or(VectorError::CorruptIndex)?;
        let (note_offsets, note_ids) = notes_sec
            .split_at_checked(notes_offsets_len)
            .ok_or(VectorError::CorruptIndex)?;
        if read_u32(note_offsets, 0) != 0
            || read_u32(note_offsets, notes_offsets_len - 4) as usize != note_ids.len()
        {
            return Err(VectorError::CorruptIndex);
        }

        let note_slots_sec = &bytes[sections[NOTE_SLOTS].clone()];
        if read_u32(note_slots_sec, 0) != 0 || read_u32(note_slots_sec, notes * 4) as usize != nodes
        {
            return Err(VectorError::CorruptIndex);
        }

        let upper_offsets = &bytes[sections[UPPER_OFFSETS].clone()];
        if bytes[sections[LEVELS].start + entry as usize] != max_level as u8
            || read_u64(upper_offsets, 0) != 0
            || read_u64(upper_offsets, nodes * 8) != sections[UPPER].len() as u64 / 4
        {
            return Err(VectorError::CorruptIndex);
        }

        // Decode class bitmaps and validate the lazy folder directory table.
        let filters_range = sections[FILTERS].clone();
        let filters = &bytes[filters_range.clone()];
        if filters.len() < 20 {
            return Err(VectorError::CorruptIndex);
        }
        let mut cursor = 20usize;
        let mut class_lens = [0usize; 4];
        for (index, slot) in class_lens.iter_mut().enumerate() {
            *slot = read_u32(filters, index * 4) as usize;
        }
        let folder_count = read_u32(filters, 16) as usize;
        let mut classes: [Bitmap; 4] = std::array::from_fn(|_| Bitmap::new());
        for (target, len) in classes.iter_mut().zip(class_lens) {
            let end = cursor.checked_add(len).ok_or(VectorError::CorruptIndex)?;
            let slice = filters.get(cursor..end).ok_or(VectorError::CorruptIndex)?;
            let bitmap =
                Bitmap::try_deserialize::<Portable>(slice).ok_or(VectorError::CorruptIndex)?;
            if bitmap.maximum().is_some_and(|slot| slot as usize >= nodes) {
                return Err(VectorError::CorruptIndex);
            }
            *target = bitmap;
            cursor = end;
        }
        let dir_len = folder_count
            .checked_mul(FOLDER_DIR_ENTRY_BYTES)
            .ok_or(VectorError::CorruptIndex)?;
        let dir_end = cursor
            .checked_add(dir_len)
            .ok_or(VectorError::CorruptIndex)?;
        if dir_end > filters.len() {
            return Err(VectorError::CorruptIndex);
        }
        let data_len = filters.len() - dir_end;
        let mut previous_folder = 0u32;
        for index in 0..folder_count {
            let entry_offset = cursor + index * FOLDER_DIR_ENTRY_BYTES;
            let folder_ord = read_u32(filters, entry_offset);
            let blob_offset = read_u32(filters, entry_offset + 4) as usize;
            let blob_len = read_u32(filters, entry_offset + 8) as usize;
            if folder_ord == 0
                || (index != 0 && folder_ord <= previous_folder)
                || blob_offset
                    .checked_add(blob_len)
                    .is_none_or(|end| end > data_len)
            {
                return Err(VectorError::CorruptIndex);
            }
            previous_folder = folder_ord;
        }
        let folder_dir = (filters_range.start + cursor)..(filters_range.start + dir_end);
        let folder_data = (filters_range.start + dir_end)..filters_range.end;

        Ok(Self {
            bytes,
            sections,
            classes,
            folder_dir,
            folder_data,
            folder_count,
            dimension,
            stride,
            nodes,
            notes,
            key_count,
            max_level: max_level as u8,
            entry,
        })
    }

    fn section(&self, section: usize) -> &[u8] {
        &self.bytes[self.sections[section].clone()]
    }

    fn row(&self, section: usize, slot: usize, width: usize) -> Option<&[u8]> {
        let start = slot.checked_mul(width)?;
        let end = start.checked_add(width)?;
        self.section(section).get(start..end)
    }

    fn node_level(&self, slot: u32) -> Option<u8> {
        self.section(LEVELS)
            .get(slot as usize)
            .copied()
            .filter(|&level| level <= self.max_level)
    }

    fn scale(&self, slot: u32) -> Option<f32> {
        let raw = self.row(SCALES, slot as usize, 4)?;
        let value = f32::from_bits(read_u32(raw, 0));
        (value.is_finite() && value > 0.0 && value <= 1.0).then_some(value)
    }

    fn vector_bytes(&self, slot: u32) -> Option<&[u8]> {
        self.row(VECTORS, slot as usize, self.stride)
    }

    fn values(&self, slot: u32) -> Option<&[i8]> {
        Some(signed_bytes(self.vector_bytes(slot)?))
    }

    fn upper_range(&self, slot: u32) -> Option<Range<usize>> {
        if (slot as usize) >= self.nodes {
            return None;
        }
        let offsets = self.section(UPPER_OFFSETS);
        let offset = slot as usize * 8;
        let start = usize::try_from(read_u64(offsets, offset))
            .ok()?
            .checked_mul(4)?;
        let end = usize::try_from(read_u64(offsets, offset + 8))
            .ok()?
            .checked_mul(4)?;
        (start <= end && end <= self.section(UPPER).len()).then_some(start..end)
    }

    fn layer0_neighbors_checked(&self, slot: u32) -> Result<&[u8], VectorError> {
        let data = self
            .row(BASE, slot as usize, BASE_ROW_BYTES)
            .ok_or(VectorError::CorruptIndex)?;
        let degree = read_u32(data, 0) as usize;
        if degree > M0 {
            return Err(VectorError::CorruptIndex);
        }
        let slice = data
            .get(4..(degree + 1) * 4)
            .ok_or(VectorError::CorruptIndex)?;
        if words(slice).any(|other| other as usize >= self.nodes || other == slot) {
            return Err(VectorError::CorruptIndex);
        }
        Ok(slice)
    }

    fn upper_neighbors_checked(&self, slot: u32, level: u8) -> Result<&[u8], VectorError> {
        let node_level = self.node_level(slot).ok_or(VectorError::CorruptIndex)?;
        if level == 0 || level > node_level {
            return Ok(&[]);
        }
        let range = self.upper_range(slot).ok_or(VectorError::CorruptIndex)?;
        let mut bytes = self
            .section(UPPER)
            .get(range)
            .ok_or(VectorError::CorruptIndex)?;
        for current_layer in 1..=level {
            let (degree_bytes, rest) =
                bytes.split_at_checked(4).ok_or(VectorError::CorruptIndex)?;
            let degree = read_u32(degree_bytes, 0) as usize;
            if degree > M {
                return Err(VectorError::CorruptIndex);
            }
            let (row, tail) = rest
                .split_at_checked(degree * 4)
                .ok_or(VectorError::CorruptIndex)?;
            if current_layer == level {
                if words(row).any(|other| {
                    other as usize >= self.nodes
                        || other == slot
                        || self.node_level(other).is_none_or(|lvl| lvl < level)
                }) {
                    return Err(VectorError::CorruptIndex);
                }
                return Ok(row);
            }
            bytes = tail;
        }
        Ok(&[])
    }

    pub fn len(&self) -> u32 {
        self.nodes as u32
    }

    pub(super) fn dimension(&self) -> usize {
        self.dimension
    }

    pub fn is_empty(&self) -> bool {
        self.nodes == 0
    }

    pub(super) fn num_notes(&self) -> u32 {
        self.notes as u32
    }

    pub(super) fn class_bitmap(&self, class_idx: usize) -> &Bitmap {
        &self.classes[class_idx]
    }

    pub(super) fn folder_bitmap(&self, folder_ord: u32) -> Result<Option<Bitmap>, VectorError> {
        if folder_ord == 0 || self.folder_count == 0 {
            return Ok(None);
        }
        let dir = &self.bytes[self.folder_dir.clone()];
        let mut low = 0usize;
        let mut high = self.folder_count;
        while low < high {
            let mid = low + (high - low) / 2;
            let ord = read_u32(dir, mid * FOLDER_DIR_ENTRY_BYTES);
            match ord.cmp(&folder_ord) {
                Ordering::Less => low = mid + 1,
                Ordering::Greater => high = mid,
                Ordering::Equal => {
                    let entry = mid * FOLDER_DIR_ENTRY_BYTES;
                    let off = read_u32(dir, entry + 4) as usize;
                    let len = read_u32(dir, entry + 8) as usize;
                    let data = &self.bytes[self.folder_data.clone()];
                    let slice = data
                        .get(off..off.checked_add(len).ok_or(VectorError::CorruptIndex)?)
                        .ok_or(VectorError::CorruptIndex)?;
                    let bitmap = Bitmap::try_deserialize::<Portable>(slice)
                        .ok_or(VectorError::CorruptIndex)?;
                    if bitmap
                        .maximum()
                        .is_some_and(|slot| slot as usize >= self.nodes)
                    {
                        return Err(VectorError::CorruptIndex);
                    }
                    return Ok(Some(bitmap));
                }
            }
        }
        Ok(None)
    }

    pub(super) fn note_ord_for_slot(&self, slot: u32) -> Option<u32> {
        let meta = self.row(METADATA, slot as usize, META_BYTES)?;
        let ord = read_u32(meta, 64);
        ((ord as usize) < self.notes).then_some(ord)
    }

    pub(super) fn note_bytes_by_ord(&self, note_ord: u32) -> Option<&[u8]> {
        if (note_ord as usize) >= self.notes {
            return None;
        }
        let notes = self.section(NOTES);
        let base = (self.notes + 1) * 4;
        let from = base.checked_add(read_u32(notes, note_ord as usize * 4) as usize)?;
        let to = base.checked_add(read_u32(notes, (note_ord as usize + 1) * 4) as usize)?;
        (from <= to).then(|| notes.get(from..to)).flatten()
    }

    pub(super) fn find_note_ord(&self, note_bytes: &[u8]) -> Option<u32> {
        let mut low = 0usize;
        let mut high = self.notes;
        while low < high {
            let mid = low + (high - low) / 2;
            let mid_bytes = self.note_bytes_by_ord(mid as u32)?;
            match mid_bytes.cmp(note_bytes) {
                Ordering::Less => low = mid + 1,
                Ordering::Greater => high = mid,
                Ordering::Equal => return Some(mid as u32),
            }
        }
        None
    }

    pub(super) fn note_slots_by_ord(
        &self,
        note_ord: u32,
    ) -> Option<impl Iterator<Item = u32> + '_> {
        if (note_ord as usize) >= self.notes {
            return None;
        }
        let sec = self.section(NOTE_SLOTS);
        let offsets_bytes = (self.notes + 1) * 4;
        let start = read_u32(sec, note_ord as usize * 4) as usize;
        let end = read_u32(sec, (note_ord as usize + 1) * 4) as usize;
        if start > end || end > self.nodes {
            return None;
        }
        let byte_start = offsets_bytes.checked_add(start.checked_mul(4)?)?;
        let byte_end = offsets_bytes.checked_add(end.checked_mul(4)?)?;
        let slice = sec.get(byte_start..byte_end)?;
        Some(words(slice))
    }

    pub(super) fn note_slots(&self, note: &NoteId) -> Option<impl Iterator<Item = u32> + '_> {
        let ord = self.find_note_ord(note.as_str().as_bytes())?;
        self.note_slots_by_ord(ord)
    }

    pub fn find_vector(&self, key: ContentDigest) -> Option<QuantizedVector> {
        let target =
            u64::from_be_bytes(key.as_bytes()[..8].try_into().expect("digest prefix width"));
        let index = self.section(KEY_INDEX);
        let mut low = 0usize;
        let mut high = self.key_count;
        while low < high {
            let mid = low + (high - low) / 2;
            let prefix = read_u64_be(index, mid * KEY_ENTRY_BYTES);
            if prefix < target {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        let mut pos = low;
        while pos < self.key_count {
            let entry_offset = pos * KEY_ENTRY_BYTES;
            if read_u64_be(index, entry_offset) != target {
                break;
            }
            let slot = read_u32(index, entry_offset + 8);
            if let Some(meta) = self.row(METADATA, slot as usize, META_BYTES)
                && &meta[..32] == key.as_bytes()
            {
                return self.owned_vector(slot);
            }
            pos += 1;
        }
        None
    }

    pub fn layer0_neighbors(&self, slot: u32) -> impl Iterator<Item = u32> + '_ {
        let row = self
            .row(BASE, slot as usize, BASE_ROW_BYTES)
            .and_then(|data| {
                let degree = (read_u32(data, 0) as usize).min(M0);
                data.get(4..(degree + 1) * 4)
            })
            .unwrap_or(&[]);
        words(row)
    }

    pub fn note_id(&self, slot: u32) -> Option<NoteId> {
        let ord = self.note_ord_for_slot(slot)?;
        let raw = self.note_bytes_by_ord(ord)?;
        NoteId::parse(std::str::from_utf8(raw).ok()?).ok()
    }

    fn note_bytes(&self, meta: &[u8]) -> Option<&[u8]> {
        let ord = read_u32(meta, 64);
        self.note_bytes_by_ord(ord)
    }

    pub fn chunk_key(&self, slot: u32) -> Option<ContentDigest> {
        let meta = self.row(METADATA, slot as usize, META_BYTES)?;
        Some(ContentDigest::from_bytes(
            meta[..32].try_into().expect("slot key width"),
        ))
    }

    pub fn folder(&self, slot: u32) -> Option<u32> {
        let meta = self.row(METADATA, slot as usize, META_BYTES)?;
        let folder = read_u32(meta, 68);
        (folder != 0).then_some(folder)
    }

    pub fn class(&self, slot: u32) -> Option<notarium_core::classes::DocClass> {
        let meta = self.row(METADATA, slot as usize, META_BYTES)?;
        let flags = read_u16(meta, 76);
        doc_class((flags >> 10) & 7)
    }

    pub fn metadata(&self, slot: u32) -> Option<ChunkMetadata> {
        let meta = self.row(METADATA, slot as usize, META_BYTES)?;
        let note = self.note_id(slot)?;
        let flags = read_u16(meta, 76);
        let tokens = flags & 0x03ff;
        let context_count = usize::from(read_u16(meta, 78));
        let span_count = usize::from(flags >> 13);
        if !(1..=512).contains(&tokens)
            || !(1..=7).contains(&span_count)
            || context_count > MAX_CONTEXT_SPANS
        {
            return None;
        }
        let first_span = read_u32(meta, 72) as usize;
        let total_spans = context_count.checked_add(span_count)?;
        let byte_start = first_span.checked_mul(8)?;
        let byte_end = first_span.checked_add(total_spans)?.checked_mul(8)?;
        let raw_spans = self.section(SPANS).get(byte_start..byte_end)?;
        let mut ranges = raw_spans
            .as_chunks::<8>()
            .0
            .iter()
            .map(|pair| ByteSpan::new(read_u32(pair, 0) as usize, read_u32(pair, 4) as usize));
        let context = ranges
            .by_ref()
            .take(context_count)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        let spans = ranges.collect::<Result<Vec<_>, _>>().ok()?;
        Some(ChunkMetadata {
            note,
            key: self.chunk_key(slot)?,
            source: ContentDigest::from_bytes(meta[32..64].try_into().ok()?),
            folder: self.folder(slot)?,
            class: self.class(slot)?,
            tokens,
            context,
            spans,
        })
    }

    pub fn owned_vector(&self, slot: u32) -> Option<QuantizedVector> {
        let scale = self.scale(slot)?;
        let values = self.values(slot)?;
        QuantizedVector::from_parts(scale, values.to_vec(), self.dimension).ok()
    }

    pub fn search(
        &self,
        query: &QuantizedVector,
        eligible: &Bitmap,
        top_k: usize,
        budget: SearchBudget<'_>,
    ) -> Result<SegmentSearch, VectorError> {
        self.search_mode(
            query,
            &SlotMask::Ref(eligible),
            top_k,
            1,
            budget,
            eligible.cardinality() <= EXACT_SCAN_LIMIT,
            |_| Ok(true),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn search_mode(
        &self,
        query: &QuantizedVector,
        eligible: &SlotMask<'_>,
        top_k: usize,
        active_segments: usize,
        budget: SearchBudget<'_>,
        exact: bool,
        mut visible: impl FnMut(u32) -> Result<bool, VectorError>,
    ) -> Result<SegmentSearch, VectorError> {
        budget.check()?;
        query.validate(self.dimension)?;
        let top_k = top_k.min(4096).min(self.nodes);
        if top_k == 0 || eligible.is_empty() {
            return Ok(SegmentSearch {
                neighbors: Vec::new(),
                hnsw_hops: 0,
            });
        }
        if !exact {
            let scorer = Similarity::new(query.values(), query.scale())?;
            let explored = hnsw::query_graph(
                self,
                scorer,
                self.entry,
                self.max_level,
                top_k,
                active_segments,
                budget,
                |slot| {
                    if !eligible.contains(slot) {
                        return Ok(false);
                    }
                    visible(slot)
                },
            )?;
            // Never fall back from HNSW to an O(N) scan over >EXACT_SCAN_LIMIT
            // slots when a selective visibility predicate yields fewer than top-k.
            return Ok(SegmentSearch {
                neighbors: explored.neighbors,
                hnsw_hops: explored.evaluations,
            });
        }
        Ok(SegmentSearch {
            neighbors: self.exact_neighbors(query, eligible, top_k, budget, visible)?,
            hnsw_hops: 0,
        })
    }

    fn exact_neighbors(
        &self,
        query: &QuantizedVector,
        eligible: &SlotMask<'_>,
        top_k: usize,
        budget: SearchBudget<'_>,
        mut visible: impl FnMut(u32) -> Result<bool, VectorError>,
    ) -> Result<Vec<Neighbor>, VectorError> {
        let dot = Dot::new(query.values()).ok_or(VectorError::InvalidDimension)?;
        let mut best = BinaryHeap::<Reverse<ExactNeighbor<'_>>>::with_capacity(top_k);
        let vectors = signed_bytes(self.section(VECTORS));
        let scales = self.section(SCALES).as_chunks::<4>().0;
        let spans_section = self.section(SPANS);
        let mut slots = [0u32; 256];
        let mut scores = [0i32; 256];
        let mut range_next = 0u32;
        let mut bitmap_iter = match eligible {
            SlotMask::All(_) => None,
            SlotMask::Ref(bitmap) => Some(bitmap.iter()),
            SlotMask::Owned(bitmap) => Some(bitmap.iter()),
        };
        loop {
            budget.check()?;
            let count = match (&mut bitmap_iter, eligible) {
                (Some(iter), _) => iter.next_many(&mut slots),
                (None, &SlotMask::All(total)) => {
                    let end = total.min(range_next.saturating_add(256));
                    let len = (end - range_next) as usize;
                    for (idx, dst) in slots[..len].iter_mut().enumerate() {
                        *dst = range_next + idx as u32;
                    }
                    range_next = end;
                    len
                }
                (None, _) => 0,
            };
            if count == 0 {
                break;
            }
            let bounded = slots[..count].partition_point(|&slot| (slot as usize) < self.nodes);
            let current = &slots[..bounded];
            let scores = &mut scores[..bounded];
            dot.dot_rows(vectors, current, scores)
                .ok_or(VectorError::CorruptIndex)?;
            for (&slot, &score) in current.iter().zip(scores.iter()) {
                let scale = f32::from_le_bytes(scales[slot as usize]);
                if !scale.is_finite() || scale <= 0.0 || scale > 1.0 {
                    return Err(VectorError::CorruptIndex);
                }
                let score = score as f32 * query.scale() * scale;
                if best.len() == top_k
                    && best
                        .peek()
                        .is_some_and(|worst| score.total_cmp(&worst.0.hit.score) == Ordering::Less)
                {
                    continue;
                }
                if !visible(slot)? {
                    continue;
                }
                let meta = self
                    .row(METADATA, slot as usize, META_BYTES)
                    .ok_or(VectorError::CorruptIndex)?;
                let first_body_span =
                    (read_u32(meta, 72) as usize).saturating_add(usize::from(read_u16(meta, 78)));
                let span_offset = first_body_span
                    .checked_mul(8)
                    .ok_or(VectorError::CorruptIndex)?;
                let span_bytes = spans_section
                    .get(
                        span_offset
                            ..span_offset
                                .checked_add(4)
                                .ok_or(VectorError::CorruptIndex)?,
                    )
                    .ok_or(VectorError::CorruptIndex)?;
                let note = self.note_bytes(meta).ok_or(VectorError::CorruptIndex)?;
                hnsw::keep_best(
                    &mut best,
                    ExactNeighbor {
                        hit: Neighbor { slot, score },
                        note,
                        span: read_u32(span_bytes, 0) as usize,
                        key: &meta[..32],
                    },
                    top_k,
                );
            }
            if bounded < count {
                break;
            }
        }
        budget.check()?;
        Ok(hnsw::finish(best)
            .into_iter()
            .map(|neighbor| neighbor.hit)
            .collect())
    }
}

fn signed_bytes(bytes: &[u8]) -> &[i8] {
    // SAFETY: i8 and u8 have the same size and alignment, and every bit
    // pattern is valid. The view borrows the original slice's lifetime.
    unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast(), bytes.len()) }
}

impl Graph for MmapSegment {
    fn vector(&self, node: u32) -> Result<(&[i8], f32), VectorError> {
        let values = self.values(node).ok_or(VectorError::CorruptIndex)?;
        let scale = self.scale(node).ok_or(VectorError::CorruptIndex)?;
        Ok((values, scale))
    }

    fn neighbors(
        &self,
        node: u32,
        level: u8,
    ) -> Result<impl Iterator<Item = u32> + '_, VectorError> {
        let row = if level == 0 {
            self.layer0_neighbors_checked(node)?
        } else {
            self.upper_neighbors_checked(node, level)?
        };
        Ok(words(row))
    }
}
