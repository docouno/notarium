//! A segment is assembled from one input stream. The only disk copy is the
//! sealed generation that will become visible through the epoch manifest.

use super::{
    M, M0, MAX_DIMENSION, MIN_DIMENSION, MmapSegment, QuantizedVector, VectorChunk, VectorError,
    format::*, hnsw::BuilderGraph, model_hash,
};
use cap_fs_ext::OpenOptionsMaybeDirExt;
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::ids::{ContentDigest, ModelProfileId, NoteId};
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, BufWriter, Write},
    ops::Range,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub struct SegmentBuilder {
    graph: BuilderGraph,
    dimension: usize,
    hash: [u8; 32],
    keys: HashMap<ContentDigest, usize>,
}

impl SegmentBuilder {
    pub fn new(model: &ModelProfileId, dimension: usize) -> Result<Self, VectorError> {
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension) {
            return Err(VectorError::InvalidDimension);
        }
        Ok(Self {
            graph: BuilderGraph::new(),
            dimension,
            hash: model_hash(model),
            keys: HashMap::new(),
        })
    }

    pub fn push(&mut self, chunk: VectorChunk) -> Result<(), VectorError> {
        chunk.validate(self.dimension)?;
        let key = chunk.metadata.key;
        let slot = self.graph.nodes.len();
        self.graph.push(chunk)?;
        self.keys.entry(key).or_insert(slot);
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
            let neighbors = slot
                .checked_sub(1)
                .map(|previous| previous / 2)
                .into_iter()
                .chain(
                    [slot * 2 + 1, slot * 2 + 2]
                        .into_iter()
                        .filter(|&next| next < count),
                )
                .collect();
            builder.graph.nodes.push(super::hnsw::Node {
                chunk,
                edges: vec![neighbors],
            });
        }
        builder
    }

    pub fn find_vector(&self, key: ContentDigest) -> Option<&QuantizedVector> {
        let &slot = self.keys.get(&key)?;
        Some(&self.graph.nodes[slot].chunk.vector)
    }

    pub(super) fn matches(&self, model: &ModelProfileId, dimension: usize) -> bool {
        self.dimension == dimension && self.hash == model_hash(model)
    }

    pub fn len(&self) -> usize {
        self.graph.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.graph.nodes.is_empty()
    }

    pub fn finish(self, path: &Path) -> Result<Option<MmapSegment>, VectorError> {
        if self.is_empty() {
            return Ok(None);
        }
        let parent = path.parent().ok_or(VectorError::CorruptIndex)?;
        let name = path.file_name().ok_or(VectorError::CorruptIndex)?;
        let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
        let (tmp, file) = create_temp(&dir)?;
        let result = (|| {
            let file = file.into_std();
            let mut output = CheckedWriter {
                writer: BufWriter::with_capacity(256 * 1024, &file),
                hash: blake3::Hasher::new(),
            };
            self.write(&mut output)?;
            output.finish()?;
            let mut permissions = file.metadata()?.permissions();
            permissions.set_readonly(true);
            file.set_permissions(permissions)?;
            file.sync_all()?;
            // Linking into the final name is atomic and refuses an existing
            // generation. An already mapped segment keeps its own file identity.
            dir.hard_link(&tmp, &dir, name)?;
            Ok::<_, VectorError>(())
        })();
        let cleanup = dir.remove_file(&tmp);
        result?;
        cleanup?;
        dir.open_with(".", OpenOptions::new().read(true).maybe_dir(true))?
            .sync_all()?;
        MmapSegment::open(path, &self.hash).map(Some)
    }

    fn write(&self, out: &mut CheckedWriter<impl Write>) -> Result<(), VectorError> {
        let mut notes: BTreeMap<&NoteId, u32> = self
            .graph
            .nodes
            .iter()
            .map(|node| (&node.chunk.metadata.note, 0))
            .collect();
        for (ordinal, target) in notes.values_mut().enumerate() {
            *target = u32::try_from(ordinal).map_err(|_| VectorError::BufferFull)?;
        }
        let stride = self.dimension.next_multiple_of(64);
        let upper_words = self
            .graph
            .nodes
            .iter()
            .flat_map(|node| node.edges.iter().skip(1))
            .map(|row| row.len() + 1)
            .sum::<usize>();
        let span_count = self
            .graph
            .nodes
            .iter()
            .map(|node| node.chunk.metadata.context.len() + node.chunk.metadata.spans.len())
            .sum::<usize>();
        if span_count > u32::MAX as usize {
            return Err(VectorError::BufferFull);
        }
        let note_bytes = notes.keys().map(|note| note.as_str().len()).sum::<usize>();
        if note_bytes > u32::MAX as usize {
            return Err(VectorError::BufferFull);
        }
        let num_nodes = self.len();
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
            notes
                .len()
                .checked_add(1)
                .and_then(|count| count.checked_mul(4))
                .and_then(|bytes| bytes.checked_add(note_bytes)),
            span_count.checked_mul(8),
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
        header[72..76].copy_from_slice(&(notes.len() as u32).to_le_bytes());
        for (index, section) in sections.iter().enumerate() {
            let offset = 80 + 16 * index;
            header[offset..offset + 8].copy_from_slice(&(section.start as u64).to_le_bytes());
            header[offset + 8..offset + 16].copy_from_slice(&(section.len() as u64).to_le_bytes());
        }
        out.write_all(&header)?;
        let mut preceding = HEADER;
        for (index, section) in sections.iter().enumerate() {
            out.write_all(&[0u8; 64][..section.start - preceding])?;
            self.write_section(out, index, stride, &notes)?;
            preceding = section.end;
        }
        Ok(())
    }

    fn write_section(
        &self,
        out: &mut CheckedWriter<impl Write>,
        section: usize,
        stride: usize,
        notes: &BTreeMap<&NoteId, u32>,
    ) -> Result<(), VectorError> {
        let nodes = &self.graph.nodes;
        match section {
            SCALES => {
                for node in nodes {
                    out.write_all(&node.chunk.vector.scale().to_le_bytes())?;
                }
            }
            VECTORS => {
                let mut output = [0u8; MAX_DIMENSION];
                for node in nodes {
                    for (dst, &value) in output.iter_mut().zip(node.chunk.vector.values()) {
                        *dst = value as u8;
                    }
                    out.write_all(&output[..stride])?;
                }
            }
            BASE => {
                let mut row = [0u8; BASE_ROW_BYTES];
                for node in nodes {
                    let edges = &node.edges[0];
                    row.fill(0);
                    row[..4].copy_from_slice(&(edges.len() as u32).to_le_bytes());
                    for (index, edge) in edges.iter().enumerate() {
                        let offset = (index + 1) * 4;
                        row[offset..offset + 4].copy_from_slice(&edge.to_le_bytes());
                    }
                    out.write_all(&row)?;
                }
            }
            LEVELS => {
                for node in nodes {
                    out.write_all(&[(node.edges.len() - 1) as u8])?;
                }
            }
            UPPER_OFFSETS => {
                let mut offset = 0u64;
                out.write_all(&offset.to_le_bytes())?;
                for node in nodes {
                    offset += node
                        .edges
                        .iter()
                        .skip(1)
                        .map(|row| row.len() as u64 + 1)
                        .sum::<u64>();
                    out.write_all(&offset.to_le_bytes())?;
                }
            }
            UPPER => {
                for row in nodes.iter().flat_map(|node| node.edges.iter().skip(1)) {
                    out.write_all(&(row.len() as u32).to_le_bytes())?;
                    for neighbor in row {
                        out.write_all(&neighbor.to_le_bytes())?;
                    }
                }
            }
            METADATA => {
                let mut span_start = 0u32;
                for node in nodes {
                    let meta = &node.chunk.metadata;
                    let flags = meta.tokens
                        | (class_number(meta.class).ok_or(VectorError::InvalidChunk)? << 10)
                        | ((meta.spans.len() as u16) << 13);
                    let mut row = [0u8; META_BYTES];
                    row[..32].copy_from_slice(meta.key.as_bytes());
                    row[32..64].copy_from_slice(meta.source.as_bytes());
                    row[64..68].copy_from_slice(&notes[&meta.note].to_le_bytes());
                    row[68..72].copy_from_slice(&meta.folder.to_le_bytes());
                    row[72..76].copy_from_slice(&span_start.to_le_bytes());
                    row[76..78].copy_from_slice(&flags.to_le_bytes());
                    row[78..80].copy_from_slice(&(meta.context.len() as u16).to_le_bytes());
                    out.write_all(&row)?;
                    span_start += (meta.context.len() + meta.spans.len()) as u32;
                }
            }
            NOTES => {
                let mut offset = 0u32;
                out.write_all(&offset.to_le_bytes())?;
                for note in notes.keys() {
                    offset += note.as_str().len() as u32;
                    out.write_all(&offset.to_le_bytes())?;
                }
                for note in notes.keys() {
                    out.write_all(note.as_str().as_bytes())?;
                }
            }
            SPANS => {
                for node in nodes {
                    let meta = &node.chunk.metadata;
                    for span in meta.context.iter().chain(&meta.spans) {
                        out.write_all(&(span.start() as u32).to_le_bytes())?;
                        out.write_all(&(span.end() as u32).to_le_bytes())?;
                    }
                }
            }
            _ => return Err(VectorError::CorruptIndex),
        }
        Ok(())
    }
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

    fn finish(mut self) -> io::Result<()> {
        let mut footer = [0u8; FOOTER];
        footer[..32].copy_from_slice(self.hash.finalize().as_bytes());
        footer[32..40].copy_from_slice(FOOTER_MAGIC);
        self.writer.write_all(&footer)?;
        self.writer.flush()
    }
}
