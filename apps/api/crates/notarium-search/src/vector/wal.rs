//! The mutable tier stores the last complete operation for each changed note.

use super::{
    ChunkMetadata, MAX_DIMENSION, MIN_DIMENSION, QuantizedVector, VectorChunk, VectorError,
};
use crate::layout::atomic_file;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::ids::{NoteId, SpaceSeq};
use std::{
    collections::BTreeMap,
    io::{self, BufReader, Read, Write},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

pub const L0_MAX_CHUNKS: usize = 25_000;
const MIN_TIMED_FLUSH_CHUNKS: usize = 4096;
const TIMED_FLUSH: Duration = Duration::from_secs(60);
const FRAME_MAGIC: &[u8; 4] = b"L0W1";
const FRAME_HEADER: usize = 17;
const CHECKSUM_BYTES: usize = 32;
const MAX_PAYLOAD_BYTES: usize = 128 * 1024 * 1024;
const WAL_NAME: &str = "l0.wal";

pub enum MutableOperation {
    Upsert {
        note: NoteId,
        chunks: Vec<VectorChunk>,
    },
    Delete(NoteId),
}
impl MutableOperation {
    fn note(&self) -> &NoteId {
        match self {
            Self::Upsert { note, .. } | Self::Delete(note) => note,
        }
    }
    pub(super) fn count(&self) -> usize {
        match self {
            Self::Upsert { chunks, .. } => chunks.len(),
            Self::Delete(_) => 0,
        }
    }
}

struct Record {
    seq: SpaceSeq,
    chunks: Arc<Vec<VectorChunk>>,
    deleted: bool,
}

pub struct MutableBuffer {
    directory: Dir,
    dimension: usize,
    entries: BTreeMap<NoteId, Record>,
    chunks: usize,
    last_seq: SpaceSeq,
    first_dirty: Option<Instant>,
    failed_write: bool,
}

impl MutableBuffer {
    pub fn open(path: &Path, dimension: usize) -> Result<Self, VectorError> {
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension) {
            return Err(VectorError::InvalidDimension);
        }
        let directory = Dir::open_ambient_dir(path, ambient_authority())?;
        let mut buffer = Self {
            directory,
            dimension,
            entries: BTreeMap::new(),
            chunks: 0,
            last_seq: SpaceSeq::ZERO,
            first_dirty: None,
            failed_write: false,
        };
        let meta = match buffer.directory.symlink_metadata(WAL_NAME) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(buffer),
            Err(error) => return Err(error.into()),
        };
        if !meta.is_file() {
            return Err(VectorError::CorruptIndex);
        }
        let options = OpenOptions::new()
            .read(true)
            .follow(FollowSymlinks::No)
            .clone();
        let file = buffer.directory.open_with(WAL_NAME, &options)?;
        let mut input = BufReader::new(file);
        while let Some((seq, operation)) = read_record(&mut input, dimension)? {
            buffer.admit(seq, &operation)?;
            buffer.apply_memory(seq, operation);
        }
        Ok(buffer)
    }

    pub fn len(&self) -> usize {
        self.chunks
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn last_seq(&self) -> SpaceSeq {
        self.last_seq
    }
    pub fn supersedes(&self, note: &NoteId) -> bool {
        self.entries.contains_key(note)
    }
    pub fn notes(&self) -> impl Iterator<Item = &NoteId> {
        self.entries.keys()
    }
    pub fn chunks(&self) -> impl Iterator<Item = &VectorChunk> {
        self.entries
            .values()
            .flat_map(|record| record.chunks.iter())
    }

    pub(super) fn snapshot(&self) -> BTreeMap<NoteId, Arc<Vec<VectorChunk>>> {
        self.entries
            .iter()
            .map(|(note, record)| (note.clone(), record.chunks.clone()))
            .collect()
    }
    pub fn should_flush(&self, now: Instant) -> bool {
        self.chunks >= L0_MAX_CHUNKS
            || self.entries.len() >= L0_MAX_CHUNKS
            || (self.chunks >= MIN_TIMED_FLUSH_CHUNKS
                && self
                    .first_dirty
                    .is_some_and(|start| now.saturating_duration_since(start) >= TIMED_FLUSH))
    }

    pub fn apply(&mut self, seq: SpaceSeq, operation: MutableOperation) -> Result<(), VectorError> {
        if self.failed_write {
            return Err(VectorError::CorruptIndex);
        }
        self.admit(seq, &operation)?;
        let frame = encode(seq, &operation)?;
        let was_present = match self.directory.symlink_metadata(WAL_NAME) {
            Ok(meta) if meta.is_file() => true,
            Ok(_) => return Err(VectorError::CorruptIndex),
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        let options = OpenOptions::new()
            .create(true)
            .append(true)
            .follow(FollowSymlinks::No)
            .clone();
        // A short append or lost sync has ambiguous durability. Keep the
        // prior in-memory image and make retry reopen/rebuild from disk.
        let write = (|| {
            let mut file = self.directory.open_with(WAL_NAME, &options)?;
            file.write_all(&frame)?;
            file.sync_data()?;
            if !was_present {
                use cap_fs_ext::OpenOptionsMaybeDirExt;
                self.directory
                    .open_with(".", OpenOptions::new().read(true).maybe_dir(true))?
                    .sync_all()?;
            }
            Ok::<_, VectorError>(())
        })();
        if let Err(error) = write {
            self.failed_write = true;
            return Err(error);
        }
        self.apply_memory(seq, operation);
        Ok(())
    }

    pub(super) fn admit(
        &self,
        seq: SpaceSeq,
        operation: &MutableOperation,
    ) -> Result<(), VectorError> {
        if seq < self.last_seq || seq == SpaceSeq::ZERO {
            return Err(VectorError::CorruptIndex);
        }
        let existing = self
            .entries
            .get(operation.note())
            .map_or(0, |record| record.chunks.len());
        if self.chunks - existing + operation.count() > L0_MAX_CHUNKS
            || (self.entries.len() == L0_MAX_CHUNKS && !self.entries.contains_key(operation.note()))
        {
            return Err(VectorError::BufferFull);
        }
        if let MutableOperation::Upsert { note, chunks } = operation {
            for chunk in chunks {
                if &chunk.metadata.note != note {
                    return Err(VectorError::InvalidChunk);
                }
                chunk.validate(self.dimension)?;
            }
        }
        Ok(())
    }

    fn apply_memory(&mut self, seq: SpaceSeq, operation: MutableOperation) {
        let (note, chunks, deleted) = match operation {
            MutableOperation::Upsert { note, chunks } => (note, chunks, false),
            MutableOperation::Delete(note) => (note, Vec::new(), true),
        };
        self.chunks += chunks.len();
        if let Some(old) = self.entries.insert(
            note,
            Record {
                seq,
                chunks: Arc::new(chunks),
                deleted,
            },
        ) {
            self.chunks -= old.chunks.len();
        }
        self.last_seq = seq;
        self.first_dirty.get_or_insert_with(Instant::now);
    }

    /// Discard the journal only after the immutable replacement is published.
    pub fn reset_after_flush(&mut self) -> Result<(), VectorError> {
        atomic_file(&self.directory, WAL_NAME, &[])?;
        self.entries.clear();
        self.chunks = 0;
        self.first_dirty = None;
        self.failed_write = false;
        Ok(())
    }

    /// Remove every on-disk frame for a purged note after L1 has been scrubbed.
    pub fn scrub_note(&mut self, purged: &NoteId) -> Result<(), VectorError> {
        let mut records: Vec<_> = self
            .entries
            .iter()
            .filter(|(note, _)| *note != purged)
            .collect();
        records.sort_unstable_by_key(|(_, record)| record.seq);
        let mut replacement = Vec::new();
        for (note, record) in records {
            encode_record(
                &mut replacement,
                record.seq,
                note,
                &record.chunks,
                record.deleted,
            )?;
        }
        atomic_file(&self.directory, WAL_NAME, &replacement)?;
        if let Some(record) = self.entries.remove(purged) {
            self.chunks -= record.chunks.len();
        }
        self.failed_write = false;
        Ok(())
    }
}

fn encode(seq: SpaceSeq, operation: &MutableOperation) -> Result<Vec<u8>, VectorError> {
    let (note, chunks, deleted) = match operation {
        MutableOperation::Upsert { note, chunks } => (note, chunks.as_slice(), false),
        MutableOperation::Delete(note) => (note, &[][..], true),
    };
    let mut bytes = Vec::new();
    encode_record(&mut bytes, seq, note, chunks, deleted)?;
    Ok(bytes)
}

fn encode_record(
    out: &mut Vec<u8>,
    seq: SpaceSeq,
    note: &NoteId,
    chunks: &[VectorChunk],
    deleted: bool,
) -> Result<(), VectorError> {
    let start = out.len();
    out.extend_from_slice(FRAME_MAGIC);
    out.push(if deleted { 2 } else { 1 });
    out.extend_from_slice(&seq.get().to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    let note = note.as_str().as_bytes();
    let note_len = u16::try_from(note.len()).map_err(|_| VectorError::InvalidChunk)?;
    out.extend_from_slice(&note_len.to_le_bytes());
    out.extend_from_slice(note);
    out.extend_from_slice(&(chunks.len() as u32).to_le_bytes());
    for chunk in chunks {
        let metadata =
            serde_json::to_vec(&chunk.metadata).map_err(|_| VectorError::InvalidChunk)?;
        let len = u32::try_from(metadata.len()).map_err(|_| VectorError::BufferFull)?;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&metadata);
        out.extend_from_slice(&chunk.vector.scale().to_le_bytes());
        out.extend(chunk.vector.values().iter().map(|&value| value as u8));
        if out.len() - start - FRAME_HEADER > MAX_PAYLOAD_BYTES {
            return Err(VectorError::BufferFull);
        }
    }
    let len = (out.len() - start - FRAME_HEADER) as u32;
    out[start + FRAME_HEADER - 4..start + FRAME_HEADER].copy_from_slice(&len.to_le_bytes());
    let checksum = blake3::hash(&out[start..]);
    out.extend_from_slice(checksum.as_bytes());
    Ok(())
}

fn read_record(
    input: &mut impl Read,
    dimension: usize,
) -> Result<Option<(SpaceSeq, MutableOperation)>, VectorError> {
    let mut header = [0u8; FRAME_HEADER];
    if input.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    read_complete(input, &mut header[1..])?;
    if &header[..4] != FRAME_MAGIC {
        return Err(VectorError::CorruptIndex);
    }
    let op = header[4];
    let seq = SpaceSeq::new(u64::from_le_bytes(
        header[5..13].try_into().expect("header sequence"),
    ))
    .map_err(|_| VectorError::CorruptIndex)?;
    let len = u32::from_le_bytes(header[13..].try_into().expect("header payload")) as usize;
    if len > MAX_PAYLOAD_BYTES {
        return Err(VectorError::CorruptIndex);
    }
    let mut payload = vec![0u8; len];
    read_complete(input, &mut payload)?;
    let mut checksum = [0u8; CHECKSUM_BYTES];
    read_complete(input, &mut checksum)?;
    let mut expected = blake3::Hasher::new();
    expected.update(&header);
    expected.update(&payload);
    if expected.finalize().as_bytes() != &checksum {
        return Err(VectorError::CorruptIndex);
    }
    let mut bytes = payload.as_slice();
    let note_len = u16::from_le_bytes(take(&mut bytes, 2)?.try_into().expect("note length"));
    let note = std::str::from_utf8(take(&mut bytes, usize::from(note_len))?)
        .map_err(|_| VectorError::CorruptIndex)?;
    let note = NoteId::parse(note).map_err(|_| VectorError::CorruptIndex)?;
    let count = u32::from_le_bytes(take(&mut bytes, 4)?.try_into().expect("chunk count")) as usize;
    if count > L0_MAX_CHUNKS || (op == 2 && count != 0) {
        return Err(VectorError::CorruptIndex);
    }
    let operation = match op {
        1 => {
            let mut chunks = Vec::with_capacity(count);
            let stride = dimension.next_multiple_of(64);
            for _ in 0..count {
                let len =
                    u32::from_le_bytes(take(&mut bytes, 4)?.try_into().expect("metadata length"))
                        as usize;
                let metadata: ChunkMetadata = serde_json::from_slice(take(&mut bytes, len)?)
                    .map_err(|_| VectorError::CorruptIndex)?;
                let scale =
                    f32::from_le_bytes(take(&mut bytes, 4)?.try_into().expect("vector scale"));
                let values = take(&mut bytes, stride)?
                    .iter()
                    .map(|&byte| byte as i8)
                    .collect();
                let vector = QuantizedVector::from_parts(scale, values, dimension)?;
                chunks.push(VectorChunk { metadata, vector });
            }
            MutableOperation::Upsert { note, chunks }
        }
        2 => MutableOperation::Delete(note),
        _ => return Err(VectorError::CorruptIndex),
    };
    if !bytes.is_empty() {
        return Err(VectorError::CorruptIndex);
    }
    Ok(Some((seq, operation)))
}

fn read_complete(input: &mut impl Read, buf: &mut [u8]) -> Result<(), VectorError> {
    input.read_exact(buf).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            VectorError::CorruptIndex
        } else {
            error.into()
        }
    })
}

fn take<'a>(bytes: &mut &'a [u8], length: usize) -> Result<&'a [u8], VectorError> {
    let (head, rest) = bytes
        .split_at_checked(length)
        .ok_or(VectorError::CorruptIndex)?;
    *bytes = rest;
    Ok(head)
}
