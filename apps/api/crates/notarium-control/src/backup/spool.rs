//! Versioned bounded PostgreSQL backup stream.
use crate::{
    error::invalid,
    store::target::{TARGET_SCHEMA_VERSION, TargetPosition, TargetRecord, TargetTable},
};
use notarium_core::{
    error::{PortError, ValidationReason},
    ids::ContentDigest,
    ports::BackupWitness,
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
const MAGIC: &[u8; 16] = b"NOTARIUMCTRL\0\0\0\x01";
// Target rows are at most 8 MiB; the framing envelope has a fixed small overhead.
const MAX_FRAME: usize = 8 * 1024 * 1024 + 128;
fn invalid_stream() -> PortError {
    invalid(ValidationReason::InvalidState)
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "snake_case", deny_unknown_fields)]
enum Frame {
    Header {
        schema: u32,
        witness: BackupWitness,
    },
    Table {
        table: TargetTable,
    },
    Row {
        record: Box<TargetRecord>,
    },
    EndTable {
        count: u64,
    },
    End {
        counts: Vec<u64>,
        digest: ContentDigest,
    },
}

/// The transport never borrows a full table or database into memory. Each frame
/// and each record has an explicit byte ceiling before allocation or decoding.
pub struct SpoolReader<R> {
    reader: R,
    digest: blake3::Hasher,
    witness: BackupWitness,
    table: usize,
    in_table: bool,
    counts: Vec<u64>,
    last: Option<TargetPosition>,
    finished: bool,
    failed: bool,
}
impl<R: Read> SpoolReader<R> {
    pub fn open(mut reader: R) -> Result<Self, PortError> {
        let mut magic = [0; 16];
        reader
            .read_exact(&mut magic)
            .map_err(|_| invalid_stream())?;
        if &magic != MAGIC {
            return Err(invalid_stream());
        }
        let mut digest = blake3::Hasher::new();
        digest.update(&magic);
        let frame = read_frame(&mut reader, &mut digest, true)?;
        let Frame::Header { schema, witness } = frame else {
            return Err(invalid_stream());
        };
        if schema != TARGET_SCHEMA_VERSION
            || witness.schema_version != schema
            || !witness.histories.is_empty()
            || witness.canaries.is_empty()
            || witness.canaries.len() > 4096
        {
            return Err(invalid_stream());
        }
        Ok(Self {
            reader,
            digest,
            witness,
            table: 0,
            in_table: false,
            counts: vec![0; TargetTable::ALL.len()],
            last: None,
            finished: false,
            failed: false,
        })
    }
    pub fn witness(&self) -> &BackupWitness {
        &self.witness
    }
    pub fn next_record(&mut self) -> Result<Option<TargetRecord>, PortError> {
        if self.failed {
            return Err(invalid_stream());
        }
        if self.finished {
            return Ok(None);
        }
        let result = self.next_inner();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn next_inner(&mut self) -> Result<Option<TargetRecord>, PortError> {
        loop {
            // The last frame's digest describes every preceding byte. Its own
            // bytes are covered by the artifact receipt's complete-file digest.
            let before = ContentDigest::from_bytes(*self.digest.finalize().as_bytes());
            match read_frame(&mut self.reader, &mut self.digest, true)? {
                Frame::Table { table }
                    if !self.in_table && TargetTable::ALL.get(self.table) == Some(&table) =>
                {
                    self.in_table = true;
                    self.last = None;
                }
                Frame::Row { record }
                    if self.in_table
                        && TargetTable::ALL.get(self.table) == Some(&record.table()) =>
                {
                    record.validate()?;
                    let key = record.position();
                    if self.last.as_ref().is_some_and(|last| last >= &key) {
                        return Err(invalid_stream());
                    }
                    self.last = Some(key);
                    self.counts[self.table] = self.counts[self.table]
                        .checked_add(1)
                        .ok_or_else(invalid_stream)?;
                    return Ok(Some(*record));
                }
                Frame::EndTable { count } if self.in_table && self.counts[self.table] == count => {
                    self.in_table = false;
                    self.table += 1;
                    self.last = None;
                }
                Frame::End { counts, digest }
                    if !self.in_table
                        && self.table == TargetTable::ALL.len()
                        && counts == self.counts
                        && digest == before =>
                {
                    let mut trailing = [0];
                    if self
                        .reader
                        .read(&mut trailing)
                        .map_err(|_| invalid_stream())?
                        != 0
                    {
                        return Err(invalid_stream());
                    }
                    self.finished = true;
                    return Ok(None);
                }
                _ => return Err(invalid_stream()),
            }
        }
    }
}
fn read_frame(
    reader: &mut impl Read,
    digest: &mut blake3::Hasher,
    hash: bool,
) -> Result<Frame, PortError> {
    let mut length = [0; 4];
    reader
        .read_exact(&mut length)
        .map_err(|_| invalid_stream())?;
    let len = u32::from_be_bytes(length) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let mut bytes = vec![0; len];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| invalid_stream())?;
    let source = std::str::from_utf8(&bytes).map_err(|_| invalid_stream())?;
    // Frame and row DTOs are closed; nested persisted JSON is revalidated by
    // TargetRecord::validate instead of normalizing or discarding fields.
    let frame: Frame = serde_json::from_str(source).map_err(|_| invalid_stream())?;
    if hash {
        digest.update(&length);
        digest.update(&bytes);
    }
    Ok(frame)
}

pub(crate) struct SpoolWriter<W> {
    writer: W,
    digest: blake3::Hasher,
    bytes: u64,
    counts: Vec<u64>,
    table: usize,
    in_table: bool,
    last: Option<TargetPosition>,
}
impl<W: Write> SpoolWriter<W> {
    pub(crate) fn new(mut writer: W, witness: BackupWitness) -> Result<Self, PortError> {
        writer.write_all(MAGIC).map_err(|_| invalid_stream())?;
        let mut digest = blake3::Hasher::new();
        digest.update(MAGIC);
        let mut value = Self {
            writer,
            digest,
            bytes: MAGIC.len() as u64,
            counts: vec![0; TargetTable::ALL.len()],
            table: 0,
            in_table: false,
            last: None,
        };
        value.frame(Frame::Header {
            schema: TARGET_SCHEMA_VERSION,
            witness,
        })?;
        Ok(value)
    }
    fn frame(&mut self, frame: Frame) -> Result<(), PortError> {
        let bytes = serde_json::to_vec(&frame).map_err(|_| invalid_stream())?;
        if bytes.len() > MAX_FRAME {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let length = (bytes.len() as u32).to_be_bytes();
        self.writer
            .write_all(&length)
            .and_then(|()| self.writer.write_all(&bytes))
            .map_err(|_| invalid_stream())?;
        self.digest.update(&length);
        self.digest.update(&bytes);
        self.bytes = self
            .bytes
            .checked_add(4 + bytes.len() as u64)
            .ok_or_else(invalid_stream)?;
        Ok(())
    }
    pub(crate) fn begin_table(&mut self, table: TargetTable) -> Result<(), PortError> {
        if self.in_table || TargetTable::ALL.get(self.table) != Some(&table) {
            return Err(invalid_stream());
        }
        self.frame(Frame::Table { table })?;
        self.in_table = true;
        self.last = None;
        Ok(())
    }
    pub(crate) fn row(&mut self, record: TargetRecord) -> Result<(), PortError> {
        if !self.in_table || TargetTable::ALL.get(self.table) != Some(&record.table()) {
            return Err(invalid_stream());
        }
        record.validate()?;
        let key = record.position();
        if self.last.as_ref().is_some_and(|last| last >= &key) {
            return Err(invalid_stream());
        }
        self.last = Some(key);
        self.counts[self.table] = self.counts[self.table]
            .checked_add(1)
            .ok_or_else(invalid_stream)?;
        self.frame(Frame::Row {
            record: Box::new(record),
        })
    }
    pub(crate) fn end_table(&mut self) -> Result<(), PortError> {
        if !self.in_table {
            return Err(invalid_stream());
        }
        self.frame(Frame::EndTable {
            count: self.counts[self.table],
        })?;
        self.table += 1;
        self.in_table = false;
        self.last = None;
        Ok(())
    }
    pub(crate) fn finish(mut self) -> Result<W, PortError> {
        if self.in_table || self.table != TargetTable::ALL.len() {
            return Err(invalid_stream());
        }
        let digest = ContentDigest::from_bytes(*self.digest.finalize().as_bytes());
        self.frame(Frame::End {
            counts: self.counts.clone(),
            digest,
        })?;
        self.writer.flush().map_err(|_| invalid_stream())?;
        Ok(self.writer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::target::UsersRow;
    use notarium_core::{ids::*, ports::KeyCanary};
    use serde_json::{Value, json};

    fn fixture() -> Vec<u8> {
        let witness = BackupWitness {
            installation: InstallationId::from_bytes([1; 16]),
            schema_version: 1,
            histories: vec![],
            canaries: vec![KeyCanary {
                key: KeyId::parse("ck_000000000000000000000000").unwrap(),
                generation: 1,
                active: true,
                readable: true,
                digest: ContentDigest::from_bytes([1; 32]),
            }],
        };
        let mut stream = SpoolWriter::new(Vec::new(), witness).unwrap();
        for &table in TargetTable::ALL {
            stream.begin_table(table).unwrap();
            if table == TargetTable::Users {
                stream
                    .row(TargetRecord::Users(UsersRow {
                        user_id: PrincipalId::from_bytes([1; 16]).to_string(),
                        username: "backup".into(),
                        email: None,
                        display_name: "Round trip".into(),
                        password_hash: None,
                        is_admin: 0,
                        disabled_at: None,
                        personal_space_id: None,
                        revision: 0,
                        metadata_revision: 0,
                        auth_version: 0,
                        created_at: 0,
                    }))
                    .unwrap();
            }
            stream.end_table().unwrap();
        }
        stream.finish().unwrap()
    }
    fn decode_frames(bytes: &[u8]) -> Vec<Value> {
        let mut at = MAGIC.len();
        let mut frames = vec![];
        while at < bytes.len() {
            let length = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            frames.push(serde_json::from_slice(&bytes[at + 4..at + 4 + length]).unwrap());
            at += 4 + length;
        }
        frames
    }
    fn encode_frames(mut frames: Vec<Value>) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        for frame in &mut frames {
            if frame["frame"] == "end" {
                frame["digest"] = serde_json::to_value(ContentDigest::from_bytes(
                    *blake3::hash(&bytes).as_bytes(),
                ))
                .unwrap();
            }
            let value = serde_json::to_vec(frame).unwrap();
            bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
            bytes.extend_from_slice(&value);
        }
        bytes
    }
    fn rejected(bytes: &[u8]) {
        let Ok(mut stream) = SpoolReader::open(bytes) else {
            return;
        };
        loop {
            match stream.next_record() {
                Ok(Some(_)) => (),
                Ok(None) => panic!("invalid stream accepted"),
                Err(_) => {
                    assert!(
                        stream.next_record().is_err(),
                        "failed reader must stay poisoned"
                    );
                    break;
                }
            }
        }
    }
    #[test]
    fn framed_spool_rejects_corruption_and_semantic_reordering() {
        let bytes = fixture();
        let mut reader = SpoolReader::open(bytes.as_slice()).unwrap();
        assert_eq!(reader.witness().schema_version, 1);
        assert!(matches!(
            reader.next_record().unwrap(),
            Some(TargetRecord::Users(_))
        ));
        assert!(reader.next_record().unwrap().is_none());
        let frames = decode_frames(&bytes);
        // Every frame boundary and final byte must be present.
        let mut boundary = MAGIC.len();
        for frame in &frames {
            rejected(&bytes[..boundary]);
            boundary += 4 + serde_json::to_vec(frame).unwrap().len();
        }
        rejected(&bytes[..bytes.len() - 1]);
        let mut trailing = bytes.clone();
        trailing.push(0);
        rejected(&trailing);
        let mut bad_magic = bytes.clone();
        bad_magic[0] ^= 1;
        rejected(&bad_magic);
        let mut over = MAGIC.to_vec();
        over.extend_from_slice(&((MAX_FRAME + 1) as u32).to_be_bytes());
        rejected(&over);
        let row = frames
            .iter()
            .position(|frame| frame["frame"] == "row")
            .unwrap();
        for case in 0..9 {
            let mut malformed = frames.clone();
            match case {
                0 => malformed[0]["schema"] = json!(2),
                1 => malformed[0]["witness"]["unknown"] = json!(true),
                2 => malformed[0]["witness"]["canaries"] = json!([]),
                3 => malformed.swap(1, 3),
                4 => malformed[row]["record"]["unknown"] = json!(true),
                5 => malformed[row]["record"]["row"]["user_id"] = json!("invalid"),
                6 => malformed.insert(row, malformed[row].clone()),
                7 => malformed[row + 1]["count"] = json!(2),
                8 => {
                    malformed.last_mut().unwrap()["counts"][0] = json!(7);
                }
                _ => unreachable!(),
            }
            // Recompute checksums so semantic checks, rather than incidental digest
            // mismatches, must reject unknown fields, wrong counts and repeated keys.
            rejected(&encode_frames(malformed));
        }
        let mut digest = bytes.clone();
        let last = digest.len() - 4;
        digest[last] ^= 1;
        rejected(&digest);
    }
}
