//! The mutable tier stores the last complete operation for each changed note.

use super::{
    ChunkMetadata, MAX_DIMENSION, MIN_DIMENSION, QuantizedVector, VectorChunk, VectorError,
};
use crate::layout::{atomic_file, atomic_write_with, sync_dir};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::ids::{NoteId, SpaceSeq};
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, BufReader, BufWriter, Read, Write},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

pub const L0_MAX_CHUNKS: usize = 25_000;
pub const L0_MAX_BYTES: usize = 16 * 1024 * 1024;
const MIN_TIMED_FLUSH_CHUNKS: usize = 4096;
const TIMED_FLUSH: Duration = Duration::from_secs(60);
const FRAME_MAGIC: &[u8; 4] = b"L0W1";
const FRAME_HEADER: usize = 17;
const CHECKSUM_BYTES: usize = 32;
const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
const MIN_REWRITE_BYTES: u64 = 1024 * 1024;
const WAL_NAME: &str = "l0.wal";

pub enum MutableOperation {
    Upsert {
        note: NoteId,
        chunks: Vec<VectorChunk>,
    },
    Delete(NoteId),
}
impl MutableOperation {
    pub(super) fn note(&self) -> &NoteId {
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

pub(super) struct FlushSnapshot {
    pub(super) flushed_seq: SpaceSeq,
    pub(super) flushed_gen: u64,
    pub(super) entries: Vec<(NoteId, Arc<Vec<VectorChunk>>)>,
}

struct Record {
    seq: SpaceSeq,
    write_gen: u64,
    chunks: Arc<Vec<VectorChunk>>,
    deleted: bool,
    frame_bytes: u64,
    mem_bytes: usize,
}

pub struct MutableBuffer {
    directory: Dir,
    dimension: usize,
    entries: BTreeMap<NoteId, Record>,
    chunks: usize,
    mem_bytes: usize,
    last_seq: SpaceSeq,
    write_gen: u64,
    first_dirty: Option<Instant>,
    failed_write: bool,
    journal_bytes: u64,
    live_bytes: u64,
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
            mem_bytes: 0,
            last_seq: SpaceSeq::ZERO,
            write_gen: 0,
            first_dirty: None,
            failed_write: false,
            journal_bytes: 0,
            live_bytes: 0,
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
        while let Some((seq, operation, frame_bytes)) = read_record(&mut input, dimension)? {
            buffer.admit(seq, &operation)?;
            let mem_bytes = operation_mem_bytes(&operation, dimension);
            buffer.apply_memory(seq, operation, frame_bytes, mem_bytes);
        }
        Ok(buffer)
    }

    pub fn len(&self) -> usize {
        self.chunks
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn mem_bytes(&self) -> usize {
        self.mem_bytes
    }
    pub fn last_seq(&self) -> SpaceSeq {
        self.last_seq
    }
    pub(super) fn is_failed(&self) -> bool {
        self.failed_write
    }
    pub fn supersedes(&self, note: &NoteId) -> bool {
        self.entries.contains_key(note)
    }
    pub(super) fn chunks_for_note(&self, note: &NoteId) -> Option<&[VectorChunk]> {
        self.entries
            .get(note)
            .map(|record| record.chunks.as_slice())
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

    pub(super) fn snapshot_for_flush(&self) -> FlushSnapshot {
        let entries = self
            .entries
            .iter()
            .map(|(note, record)| (note.clone(), record.chunks.clone()))
            .collect();
        FlushSnapshot {
            flushed_seq: self.last_seq,
            flushed_gen: self.write_gen,
            entries,
        }
    }

    pub(super) fn notes_after_gen(&self, flushed_gen: u64) -> impl Iterator<Item = &NoteId> {
        self.entries
            .iter()
            .filter(move |(_, record)| record.write_gen > flushed_gen)
            .map(|(note, _)| note)
    }

    pub fn should_flush(&self, now: Instant) -> bool {
        self.chunks >= L0_MAX_CHUNKS
            || self.entries.len() >= L0_MAX_CHUNKS
            || self.mem_bytes >= L0_MAX_BYTES
            || (self.chunks >= MIN_TIMED_FLUSH_CHUNKS
                && self
                    .first_dirty
                    .is_some_and(|start| now.saturating_duration_since(start) >= TIMED_FLUSH))
    }

    pub(super) fn exceeds_single_limit(&self, operation: &MutableOperation) -> bool {
        match operation {
            MutableOperation::Delete(_) => false,
            MutableOperation::Upsert { .. } => {
                operation.count() > L0_MAX_CHUNKS
                    || operation_mem_bytes(operation, self.dimension) > L0_MAX_BYTES
                    || estimate_encoded_bytes(operation, self.dimension) > MAX_PAYLOAD_BYTES
            }
        }
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
        if self.failed_write {
            return Err(VectorError::CorruptIndex);
        }
        self.admit_batch(seq, &operations)?;
        let mut encoded = Vec::new();
        let mut frame_sizes = Vec::with_capacity(operations.len());
        let mut mem_sizes = Vec::with_capacity(operations.len());
        for operation in &operations {
            let start = encoded.len();
            encode_into(&mut encoded, seq, operation)?;
            frame_sizes.push((encoded.len() - start) as u64);
            mem_sizes.push(operation_mem_bytes(operation, self.dimension));
        }
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
            file.write_all(&encoded)?;
            file.sync_data()?;
            if !was_present {
                sync_dir(&self.directory)?;
            }
            Ok::<_, VectorError>(())
        })();
        if let Err(error) = write {
            self.failed_write = true;
            return Err(error);
        }
        for ((operation, frame_bytes), mem_bytes) in
            operations.into_iter().zip(frame_sizes).zip(mem_sizes)
        {
            self.apply_memory(seq, operation, frame_bytes, mem_bytes);
        }
        if self.journal_bytes.saturating_sub(self.live_bytes)
            >= self.live_bytes.max(MIN_REWRITE_BYTES)
        {
            // The append is already synced and durable; atomic_write_with leaves
            // the prior WAL intact on failure. Retain it and retry compaction later.
            match self.rewrite() {
                Ok(bytes) => self.journal_bytes = bytes,
                Err(error) => {
                    tracing::warn!(
                        %error,
                        "vector L0 WAL compaction failed; retaining appended journal"
                    );
                }
            }
        }
        Ok(())
    }

    pub(super) fn admit(
        &self,
        seq: SpaceSeq,
        operation: &MutableOperation,
    ) -> Result<(), VectorError> {
        self.admit_batch(seq, std::slice::from_ref(operation))
    }

    pub(super) fn admit_batch(
        &self,
        seq: SpaceSeq,
        operations: &[MutableOperation],
    ) -> Result<(), VectorError> {
        if seq < self.last_seq || seq == SpaceSeq::ZERO {
            return Err(VectorError::CorruptIndex);
        }
        let mut projected_chunks = self.chunks;
        let mut projected_bytes = self.mem_bytes;
        let mut projected_entries = self.entries.len();
        let mut batch_state: HashMap<&NoteId, (usize, usize)> = HashMap::new();
        for operation in operations {
            if let MutableOperation::Upsert { note, chunks } = operation {
                for chunk in chunks {
                    if &chunk.metadata.note != note {
                        return Err(VectorError::InvalidChunk);
                    }
                    chunk.validate(self.dimension)?;
                }
            }
            let note = operation.note();
            let op_chunks = operation.count();
            let op_bytes = operation_mem_bytes(operation, self.dimension);
            let (prev_chunks, prev_bytes) = if let Some(&prev) = batch_state.get(note) {
                prev
            } else if let Some(record) = self.entries.get(note) {
                (record.chunks.len(), record.mem_bytes)
            } else {
                projected_entries += 1;
                (0, 0)
            };
            projected_chunks = projected_chunks
                .saturating_sub(prev_chunks)
                .saturating_add(op_chunks);
            projected_bytes = projected_bytes
                .saturating_sub(prev_bytes)
                .saturating_add(op_bytes);
            batch_state.insert(note, (op_chunks, op_bytes));
            if projected_chunks > L0_MAX_CHUNKS
                || projected_entries > L0_MAX_CHUNKS
                || projected_bytes > L0_MAX_BYTES
            {
                return Err(VectorError::BufferFull);
            }
        }
        Ok(())
    }

    fn apply_memory(
        &mut self,
        seq: SpaceSeq,
        operation: MutableOperation,
        frame_bytes: u64,
        mem_bytes: usize,
    ) {
        let (note, chunks, deleted) = match operation {
            MutableOperation::Upsert { note, chunks } => (note, chunks, false),
            MutableOperation::Delete(note) => (note, Vec::new(), true),
        };
        self.write_gen = self.write_gen.wrapping_add(1);
        let write_gen = self.write_gen;
        self.chunks += chunks.len();
        self.mem_bytes += mem_bytes;
        self.journal_bytes += frame_bytes;
        self.live_bytes += frame_bytes;
        if let Some(old) = self.entries.insert(
            note,
            Record {
                seq,
                write_gen,
                chunks: Arc::new(chunks),
                deleted,
                frame_bytes,
                mem_bytes,
            },
        ) {
            self.chunks -= old.chunks.len();
            self.mem_bytes -= old.mem_bytes;
            self.live_bytes = self.live_bytes.saturating_sub(old.frame_bytes);
        }
        self.last_seq = seq;
        self.first_dirty.get_or_insert_with(Instant::now);
    }

    /// Discard the journal only after the immutable replacement is published.
    pub fn reset_after_flush(&mut self) -> Result<(), VectorError> {
        atomic_file(&self.directory, WAL_NAME, &[])?;
        self.entries.clear();
        self.chunks = 0;
        self.mem_bytes = 0;
        self.journal_bytes = 0;
        self.live_bytes = 0;
        self.first_dirty = None;
        self.failed_write = false;
        Ok(())
    }

    /// Drop entries up to `flushed_gen` after the immutable replacement is
    /// published, keeping any concurrent writes newer than `flushed_gen`
    /// (including same-`SpaceSeq` overwrites).
    pub(super) fn prune_flushed(&mut self, flushed_gen: u64) -> Result<(), VectorError> {
        if self.failed_write {
            return Err(VectorError::CorruptIndex);
        }
        if self
            .entries
            .values()
            .all(|record| record.write_gen <= flushed_gen)
        {
            return self.reset_after_flush();
        }
        let written = self.rewrite_filtered(flushed_gen)?;
        self.entries
            .retain(|_, record| record.write_gen > flushed_gen);
        self.chunks = self
            .entries
            .values()
            .map(|record| record.chunks.len())
            .sum();
        self.mem_bytes = self.entries.values().map(|record| record.mem_bytes).sum();
        self.journal_bytes = written;
        self.live_bytes = written;
        self.first_dirty = Some(Instant::now());
        Ok(())
    }

    fn rewrite(&self) -> Result<u64, VectorError> {
        self.rewrite_filtered(0)
    }

    fn rewrite_filtered(&self, min_write_gen: u64) -> Result<u64, VectorError> {
        let mut records: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, record)| record.write_gen > min_write_gen)
            .collect();
        records.sort_unstable_by_key(|(_, record)| (record.seq, record.write_gen));
        let mut written = 0u64;
        atomic_write_with::<VectorError>(&self.directory, WAL_NAME, |file| {
            let mut writer = BufWriter::with_capacity(64 * 1024, file);
            let mut scratch = Vec::new();
            for (note, record) in records {
                scratch.clear();
                encode_record(
                    &mut scratch,
                    record.seq,
                    note,
                    &record.chunks,
                    record.deleted,
                )?;
                writer.write_all(&scratch)?;
                written += scratch.len() as u64;
            }
            writer.flush()?;
            Ok(())
        })?;
        Ok(written)
    }
}

fn operation_mem_bytes(operation: &MutableOperation, dimension: usize) -> usize {
    let stride = dimension.next_multiple_of(64);
    let note_bytes = operation.note().as_str().len().saturating_add(64);
    match operation {
        MutableOperation::Delete(_) => note_bytes,
        MutableOperation::Upsert { chunks, .. } => chunks
            .iter()
            .map(|chunk| {
                stride.saturating_add(160).saturating_add(
                    (chunk.metadata.context.len() + chunk.metadata.spans.len()) * 16,
                )
            })
            .fold(note_bytes, usize::saturating_add),
    }
}

fn estimate_encoded_bytes(operation: &MutableOperation, dimension: usize) -> usize {
    let stride = dimension.next_multiple_of(64);
    let header = operation.note().as_str().len().saturating_add(64);
    match operation {
        MutableOperation::Delete(_) => header,
        MutableOperation::Upsert { chunks, .. } => chunks
            .iter()
            .map(|chunk| {
                stride.saturating_add(512).saturating_add(
                    (chunk.metadata.context.len() + chunk.metadata.spans.len()) * 48,
                )
            })
            .fold(header, usize::saturating_add),
    }
}

fn encode_into(
    out: &mut Vec<u8>,
    seq: SpaceSeq,
    operation: &MutableOperation,
) -> Result<(), VectorError> {
    let (note, chunks, deleted) = match operation {
        MutableOperation::Upsert { note, chunks } => (note, chunks.as_slice(), false),
        MutableOperation::Delete(note) => (note, &[][..], true),
    };
    encode_record(out, seq, note, chunks, deleted)
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
) -> Result<Option<(SpaceSeq, MutableOperation, u64)>, VectorError> {
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
    // Bound initial allocation before reading so a truncated 17-byte header
    // claiming a 32 MiB payload cannot trigger an OOM allocation.
    let mut payload = Vec::with_capacity(len.min(64 * 1024));
    let read = input.by_ref().take(len as u64).read_to_end(&mut payload)?;
    if read != len {
        return Err(VectorError::CorruptIndex);
    }
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
            let mut chunks = Vec::with_capacity(count.min(1024));
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
    Ok(Some((
        seq,
        operation,
        (FRAME_HEADER + len + CHECKSUM_BYTES) as u64,
    )))
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
