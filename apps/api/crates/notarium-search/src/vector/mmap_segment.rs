#![allow(unsafe_code)]

//! Read-only mappings of sealed segment files. The decoder validates the
//! entire format before a segment can be searched.

use super::{
    ChunkMetadata, EXACT_SCAN_LIMIT, M, M0, MAX_DIMENSION, MAX_LEVEL, MIN_DIMENSION,
    QuantizedVector, SearchBudget, VectorError,
    format::*,
    hnsw::{self, Graph, Neighbor, Similarity},
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use croaring::Bitmap;
use memmap2::{Mmap, MmapOptions};
use notarium_core::{
    ids::{ContentDigest, NoteId},
    span::ByteSpan,
};
use std::{collections::BinaryHeap, ops::Range, path::Path};

pub struct MmapSegment {
    bytes: Mmap,
    sections: [Range<usize>; SECTION_COUNT],
    dimension: usize,
    stride: usize,
    nodes: usize,
    notes: usize,
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
        let parent = path.parent().ok_or(VectorError::CorruptIndex)?;
        let name = path.file_name().ok_or(VectorError::CorruptIndex)?;
        let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
        let meta = dir.symlink_metadata(name)?;
        if !meta.is_file()
            || !meta.permissions().readonly()
            || meta.len() < (HEADER + FOOTER) as u64
        {
            return Err(VectorError::CorruptIndex);
        }
        let file = dir
            .open_with(
                name,
                OpenOptions::new().read(true).follow(FollowSymlinks::No),
            )?
            .into_std();
        let metadata = file.metadata()?;
        if !metadata.is_file() || !metadata.permissions().readonly() || metadata.len() != meta.len()
        {
            return Err(VectorError::CorruptIndex);
        }
        // SAFETY: the file is a regular read-only file in an owner-managed
        // generation. The builder seals it before publication and the only
        // supported subsequent operations are rename and unlink. Open file
        // identity survives both operations for the lifetime of the mapping.
        let bytes = unsafe { MmapOptions::new().map(&file)? };
        Self::decode(bytes, model_hash)
    }

    fn decode(bytes: Mmap, model_hash: &[u8; 32]) -> Result<Self, VectorError> {
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
            || bytes[224..HEADER] != [0u8; 32]
            || &footer[32..40] != FOOTER_MAGIC
            || footer[40..] != [0u8; 24]
            || &footer[..32] != blake3::hash(&bytes[..data_end]).as_bytes()
        {
            return Err(VectorError::CorruptIndex);
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
        {
            return Err(VectorError::CorruptIndex);
        }
        let segment = Self {
            bytes,
            sections,
            dimension,
            stride,
            nodes,
            notes,
            max_level: max_level as u8,
            entry,
        };
        segment.validate_contents()?;
        Ok(segment)
    }

    fn section(&self, section: usize) -> &[u8] {
        &self.bytes[self.sections[section].clone()]
    }
    fn row(&self, section: usize, slot: usize, width: usize) -> &[u8] {
        &self.section(section)[slot * width..(slot + 1) * width]
    }
    fn node_level(&self, slot: u32) -> u8 {
        self.section(LEVELS)[slot as usize]
    }
    fn scale(&self, slot: u32) -> f32 {
        f32::from_bits(read_u32(self.section(SCALES), slot as usize * 4))
    }
    fn vector_bytes(&self, slot: u32) -> &[u8] {
        self.row(VECTORS, slot as usize, self.stride)
    }
    fn values(&self, slot: u32) -> &[i8] {
        let bytes = self.vector_bytes(slot);
        // SAFETY: this is a borrowed view into a validated in-bounds row.
        // i8 and u8 have the same size and alignment and every bit pattern
        // is valid; the slice retains the mapping's lifetime.
        unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast(), bytes.len()) }
    }
    fn upper_range(&self, slot: u32) -> Option<Range<usize>> {
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

    fn validate_contents(&self) -> Result<(), VectorError> {
        let notes = self.section(NOTES);
        let offsets_len = self
            .notes
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .ok_or(VectorError::CorruptIndex)?;
        let (offsets, ids) = notes
            .split_at_checked(offsets_len)
            .ok_or(VectorError::CorruptIndex)?;
        if read_u32(offsets, 0) != 0 || read_u32(offsets, offsets_len - 4) as usize != ids.len() {
            return Err(VectorError::CorruptIndex);
        }
        for note in 0..self.notes {
            let start = read_u32(offsets, note * 4) as usize;
            let end = read_u32(offsets, (note + 1) * 4) as usize;
            let raw = ids
                .get(start..end)
                .and_then(|raw| std::str::from_utf8(raw).ok())
                .ok_or(VectorError::CorruptIndex)?;
            NoteId::parse(raw).map_err(|_| VectorError::CorruptIndex)?;
        }

        if self.node_level(self.entry) != self.max_level
            || read_u64(self.section(UPPER_OFFSETS), 0) != 0
            || read_u64(self.section(UPPER_OFFSETS), self.nodes * 8)
                != self.section(UPPER).len() as u64 / 4
        {
            return Err(VectorError::CorruptIndex);
        }
        let spans = self.section(SPANS);
        for pair in spans.as_chunks::<8>().0 {
            if read_u32(pair, 0) >= read_u32(pair, 4) {
                return Err(VectorError::CorruptIndex);
            }
        }
        for slot in 0..self.nodes as u32 {
            if self.node_level(slot) > self.max_level {
                return Err(VectorError::CorruptIndex);
            }
            let scale = self.scale(slot);
            let vector = self.vector_bytes(slot);
            if !scale.is_finite()
                || scale <= 0.0
                || scale > 1.0
                || vector[..self.dimension].contains(&128)
                || vector[self.dimension..].iter().any(|&byte| byte != 0)
            {
                return Err(VectorError::CorruptIndex);
            }
            self.validate_edges(slot)?;
            let meta = self.row(METADATA, slot as usize, META_BYTES);
            let flags = read_u16(meta, 76);
            let context = usize::from(read_u16(meta, 78));
            let span_count = usize::from(flags >> 13);
            let span_start = read_u32(meta, 72) as usize;
            if read_u32(meta, 64) as usize >= self.notes
                || read_u32(meta, 68) == 0
                || !(1..=512).contains(&(flags & 0x03ff))
                || doc_class((flags >> 10) & 7).is_none()
                || !(1..=7).contains(&span_count)
                || !span_start
                    .checked_add(context + span_count)
                    .is_some_and(|end| end <= spans.len() / 8)
            {
                return Err(VectorError::CorruptIndex);
            }
        }
        Ok(())
    }

    fn validate_edges(&self, slot: u32) -> Result<(), VectorError> {
        let base = self.row(BASE, slot as usize, BASE_ROW_BYTES);
        let degree = read_u32(base, 0) as usize;
        if degree > M0
            || words(&base[4..(1 + degree) * 4])
                .any(|other| other as usize >= self.nodes || other == slot)
        {
            return Err(VectorError::CorruptIndex);
        }
        let range = self.upper_range(slot).ok_or(VectorError::CorruptIndex)?;
        let mut bytes = &self.section(UPPER)[range];
        for layer in 1..=self.node_level(slot) {
            let (degree, edges) = bytes.split_at_checked(4).ok_or(VectorError::CorruptIndex)?;
            let degree = read_u32(degree, 0) as usize;
            if degree > M {
                return Err(VectorError::CorruptIndex);
            }
            let (row, rest) = edges
                .split_at_checked(degree * 4)
                .ok_or(VectorError::CorruptIndex)?;
            if words(row).any(|other| {
                other as usize >= self.nodes || other == slot || self.node_level(other) < layer
            }) {
                return Err(VectorError::CorruptIndex);
            }
            bytes = rest;
        }
        if !bytes.is_empty() {
            return Err(VectorError::CorruptIndex);
        }
        Ok(())
    }

    pub fn len(&self) -> u32 {
        self.nodes as u32
    }

    pub fn is_empty(&self) -> bool {
        self.nodes == 0
    }

    pub fn layer0_neighbors(&self, slot: u32) -> impl Iterator<Item = u32> + '_ {
        let row = if slot < self.len() {
            let data = self.row(BASE, slot as usize, BASE_ROW_BYTES);
            let degree = read_u32(data, 0) as usize;
            &data[4..(degree + 1) * 4]
        } else {
            &[]
        };
        words(row)
    }

    fn upper_neighbors(&self, slot: u32, level: u8) -> &[u8] {
        if level > self.node_level(slot) {
            return &[];
        }
        let range = self.upper_range(slot).expect("upper offsets validated");
        let mut bytes = &self.section(UPPER)[range];
        for _ in 1..level {
            bytes = &bytes[(1 + read_u32(bytes, 0) as usize) * 4..];
        }
        &bytes[4..4 * (1 + read_u32(bytes, 0) as usize)]
    }

    pub fn note_id(&self, slot: u32) -> Option<NoteId> {
        if slot >= self.len() {
            return None;
        }
        let meta = self.row(METADATA, slot as usize, META_BYTES);
        let note = read_u32(meta, 64) as usize;
        let notes = self.section(NOTES);
        let offset = (self.notes + 1) * 4;
        let from = offset + read_u32(notes, note * 4) as usize;
        let to = offset + read_u32(notes, (note + 1) * 4) as usize;
        NoteId::parse(std::str::from_utf8(&notes[from..to]).ok()?).ok()
    }

    pub fn chunk_key(&self, slot: u32) -> Option<ContentDigest> {
        (slot < self.len()).then(|| {
            let meta = self.row(METADATA, slot as usize, META_BYTES);
            ContentDigest::from_bytes(meta[..32].try_into().expect("slot key width"))
        })
    }

    pub fn folder(&self, slot: u32) -> Option<u32> {
        (slot < self.len()).then(|| read_u32(self.row(METADATA, slot as usize, META_BYTES), 68))
    }

    pub fn class(&self, slot: u32) -> Option<notarium_core::classes::DocClass> {
        (slot < self.len())
            .then(|| read_u16(self.row(METADATA, slot as usize, META_BYTES), 76))
            .and_then(|flags| doc_class((flags >> 10) & 7))
    }

    pub fn metadata(&self, slot: u32) -> Option<ChunkMetadata> {
        let note = self.note_id(slot)?;
        let meta = self.row(METADATA, slot as usize, META_BYTES);
        let flags = read_u16(meta, 76);
        let context_count = usize::from(read_u16(meta, 78));
        let first_span = read_u32(meta, 72) as usize;
        let span_count = usize::from(flags >> 13);
        let mut ranges = self.section(SPANS)
            [first_span * 8..(first_span + context_count + span_count) * 8]
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
            tokens: flags & 0x03ff,
            context,
            spans,
        })
    }

    pub fn owned_vector(&self, slot: u32) -> Option<QuantizedVector> {
        (slot < self.len()).then(|| {
            QuantizedVector::from_parts(
                self.scale(slot),
                self.values(slot).to_vec(),
                self.dimension,
            )
            .expect("segment vector validated")
        })
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
            eligible,
            top_k,
            budget,
            eligible.cardinality() <= EXACT_SCAN_LIMIT,
        )
    }

    pub(super) fn search_mode(
        &self,
        query: &QuantizedVector,
        eligible: &Bitmap,
        top_k: usize,
        budget: SearchBudget<'_>,
        exact: bool,
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
        let scorer = Similarity::new(query.values(), query.scale())?;
        if exact {
            let mut best = BinaryHeap::with_capacity(top_k);
            for (index, slot) in eligible
                .iter()
                .take_while(|slot| *slot < self.len())
                .enumerate()
            {
                if index.is_multiple_of(128) {
                    budget.check()?;
                }
                hnsw::keep_best(
                    &mut best,
                    scorer.score(slot, self.values(slot), self.scale(slot)),
                    top_k,
                );
            }
            budget.check()?;
            return Ok(SegmentSearch {
                neighbors: hnsw::finish(best),
                hnsw_hops: 0,
            });
        }
        let explored = hnsw::query_graph(
            self,
            scorer,
            self.entry,
            self.max_level,
            top_k,
            budget,
            |slot| eligible.contains(slot),
        )?;
        Ok(SegmentSearch {
            neighbors: explored.neighbors,
            hnsw_hops: explored.evaluations,
        })
    }
}

impl Graph for MmapSegment {
    fn vector(&self, node: u32) -> (&[i8], f32) {
        (self.values(node), self.scale(node))
    }

    fn neighbors(&self, node: u32, level: u8) -> impl Iterator<Item = u32> + '_ {
        let row = if level == 0 {
            let data = self.row(BASE, node as usize, BASE_ROW_BYTES);
            &data[4..(1 + read_u32(data, 0) as usize) * 4]
        } else {
            self.upper_neighbors(node, level)
        };
        words(row)
    }
}
