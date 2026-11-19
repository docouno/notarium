use std::{collections::BTreeSet, io};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::NoteId,
};
use serde::Serialize;

use super::{
    DerivedMutation, ProjectedChatRef, StageKey, invalid_row,
    write::{encrypted_payload_empty, validate_locator},
};

pub(super) const MAX_STAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STAGE_ROWS: u32 = 200;
// An ordinary page encodes an array of mutations. The array32 header can be
// updated in place as mutations are appended.
const ARRAY_HEADER: [u8; 5] = [0xdd, 0, 0, 0, 0];
// MessagePack reserves this marker. It distinguishes a fragment witness from
// an encoded array without changing the existing staging page layout.
const FRAGMENT_MARKER: u8 = 0xc1;

pub(crate) struct StageBuffer {
    bytes: Vec<u8>,
    count: u32,
    checks: StageChecks,
}

impl Default for StageBuffer {
    fn default() -> Self {
        Self {
            bytes: ARRAY_HEADER.to_vec(),
            count: 0,
            checks: StageChecks::default(),
        }
    }
}

impl StageBuffer {
    pub(crate) fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub(crate) fn push(
        &mut self,
        key: &StageKey,
        mutation: &DerivedMutation,
    ) -> Result<bool, PortError> {
        if self.count == MAX_STAGE_ROWS {
            return Ok(false);
        }
        let previous = self.bytes.len();
        let mut writer = PageWriter {
            bytes: &mut self.bytes,
            full: false,
        };
        if encode_mutation(&mut writer, mutation).is_err() {
            let full = writer.full;
            self.bytes.truncate(previous);
            return if full { Ok(false) } else { Err(invalid_row()) };
        }
        self.checks.record(key, mutation)?;
        self.count += 1;
        Ok(true)
    }

    pub(super) fn finish(mut self) -> StagePage {
        self.bytes[1..ARRAY_HEADER.len()].copy_from_slice(&self.count.to_be_bytes());
        StagePage {
            payload: self.bytes,
            fragments: Vec::new(),
            checks: self.checks,
        }
    }
}

struct PageWriter<'a> {
    bytes: &'a mut Vec<u8>,
    full: bool,
}

impl io::Write for PageWriter<'_> {
    fn write(&mut self, src: &[u8]) -> io::Result<usize> {
        if src.len() > MAX_STAGE_BYTES - self.bytes.len() {
            self.full = true;
            return Err(io::ErrorKind::WriteZero.into());
        }
        extend_page(self.bytes, src);
        Ok(src.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct FragmentWriter {
    fragments: Vec<Vec<u8>>,
}

impl io::Write for FragmentWriter {
    fn write(&mut self, mut src: &[u8]) -> io::Result<usize> {
        let len = src.len();
        while !src.is_empty() {
            if self
                .fragments
                .last()
                .is_none_or(|bytes| bytes.len() == MAX_STAGE_BYTES)
            {
                self.fragments.push(Vec::new());
            }
            let bytes = self.fragments.last_mut().expect("fragment allocated");
            let take = src.len().min(MAX_STAGE_BYTES - bytes.len());
            let (part, rest) = src.split_at(take);
            extend_page(bytes, part);
            src = rest;
        }
        Ok(len)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn extend_page(bytes: &mut Vec<u8>, src: &[u8]) {
    if bytes.capacity() < bytes.len() + src.len() && bytes.capacity() > MAX_STAGE_BYTES / 2 {
        bytes.reserve_exact(MAX_STAGE_BYTES - bytes.len());
    }
    bytes.extend_from_slice(src);
}

fn encode_mutation(
    writer: impl io::Write,
    mutation: &DerivedMutation,
) -> Result<(), rmp_serde::encode::Error> {
    mutation.serialize(&mut rmp_serde::Serializer::new(writer).with_struct_map())
}

#[derive(Default)]
pub(super) struct StageChecks {
    pub(super) destructive: bool,
    pub(super) notes: BTreeSet<NoteId>,
    pub(super) references: Vec<ProjectedChatRef>,
}

impl StageChecks {
    fn record(&mut self, key: &StageKey, mutation: &DerivedMutation) -> Result<(), PortError> {
        match mutation {
            DerivedMutation::UpsertNote(row) => {
                if row.space_id != key.scope.space_id
                    || (row.doc_class == DocClass::EncryptedNote && !encrypted_payload_empty(row)?)
                {
                    return Err(invalid_row());
                }
                self.notes.insert(row.note_id.clone());
            }
            DerivedMutation::UpsertChatRef(reference) => {
                validate_locator(reference)?;
                self.references.push(reference.clone());
            }
            DerivedMutation::PurgeNote(_) | DerivedMutation::RedactChatEntry(..) => {
                self.destructive = true;
            }
            _ => {}
        }
        Ok(())
    }
}

pub(super) struct StagePage {
    pub(super) payload: Vec<u8>,
    pub(super) fragments: Vec<Vec<u8>>,
    pub(super) checks: StageChecks,
}

impl StagePage {
    pub(super) fn large(key: &StageKey, mutation: &DerivedMutation) -> Result<Self, PortError> {
        let mut checks = StageChecks::default();
        checks.record(key, mutation)?;
        if let DerivedMutation::UpsertViewDescriptor(row) = mutation {
            // A future standalone descriptor page must not restore plaintext
            // after its note has been purged.
            if row.space_id != key.scope.space_id {
                return Err(invalid_row());
            }
            checks.notes.insert(row.view_note_id.clone());
        }

        let mut writer = FragmentWriter::default();
        // A single-element array uses the same decode path as a regular page.
        io::Write::write_all(&mut writer, &[0x91]).map_err(|_| invalid_row())?;
        encode_mutation(&mut writer, mutation).map_err(|_| invalid_row())?;
        let mut hasher = blake3::Hasher::new();
        let length = writer.fragments.iter().try_fold(0usize, |len, bytes| {
            hasher.update(bytes);
            len.checked_add(bytes.len()).ok_or_else(invalid_row)
        })?;
        let length = u64::try_from(length).map_err(|_| invalid_row())?;
        if writer.fragments.len() < 2 {
            // The compact single-element header can fit where array32 could
            // not. Keep the ordinary page path when that occurs.
            return Ok(Self {
                payload: writer.fragments.pop().ok_or_else(invalid_row)?,
                fragments: Vec::new(),
                checks,
            });
        }
        let mut payload = Vec::with_capacity(41);
        payload.push(FRAGMENT_MARKER);
        payload.extend_from_slice(&length.to_be_bytes());
        payload.extend_from_slice(hasher.finalize().as_bytes());
        Ok(Self {
            payload,
            fragments: writer.fragments,
            checks,
        })
    }
}

pub(super) fn fragment_witness(bytes: &[u8]) -> Result<Option<(usize, [u8; 32])>, PortError> {
    if bytes.first() != Some(&FRAGMENT_MARKER) {
        if bytes.is_empty() || bytes.len() > MAX_STAGE_BYTES {
            return Err(invalid_row());
        }
        return Ok(None);
    }
    let Some((_, rest)) = bytes.split_first() else {
        return Err(invalid_row());
    };
    let (length, digest) = rest.split_first_chunk::<8>().ok_or_else(invalid_row)?;
    let length = usize::try_from(u64::from_be_bytes(*length)).map_err(|_| invalid_row())?;
    if length <= MAX_STAGE_BYTES {
        return Err(invalid_row());
    }
    Ok(Some((
        length,
        digest.try_into().map_err(|_| invalid_row())?,
    )))
}

pub(super) fn invalid_limit() -> PortError {
    DomainError::validation(ValidationReason::InvalidLimit).into()
}
