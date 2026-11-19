use std::{array, ops::Range};

use croaring::Frozen;
use notarium_core::{
    ids::{ProjectionGeneration, SpaceSeq},
    model::HistoryScope,
};

use super::{IndexError, IndexIdentity};
use crate::index::NoteSortHeader;

const MAGIC: [u8; 8] = *b"NTRMFI01";
const ENDIAN: u16 = 0x0102;
pub(crate) const FORMAT_VERSION: u16 = 1;
pub(super) const HEADER_SIZE: usize = 128;
const ALIGN: usize = 64;
const ENTRY_SIZE: usize = 32;
pub(super) const DIGEST_SIZE: usize = 32;
const SECTION_COUNT: usize = 14;
const CATALOG_ENTRY_SIZE: usize = 24;

#[derive(Clone, Copy, Debug)]
#[repr(u32)]
pub(crate) enum SectionKind {
    NoteIdentities = 1,
    NoteLookup = 2,
    FolderIdentities = 3,
    FolderLookup = 4,
    SortHeaders = 5,
    BitmapCatalog = 6,
    BitmapArena = 7,
    BsiCatalog = 8,
    BsiPlanes = 9,
    ExactIntegers = 10,
    GraphOutgoing = 11,
    GraphIncoming = 12,
    Clusters = 13,
    TimestampRemainder = 14,
}

pub(crate) struct WriteSection {
    kind: SectionKind,
    count: u32,
    bytes: Vec<u8>,
    aux: u64,
}

impl WriteSection {
    pub(crate) fn new(kind: SectionKind, count: u32, bytes: Vec<u8>, aux: u64) -> Self {
        Self {
            kind,
            count,
            bytes,
            aux,
        }
    }
}

#[derive(Default)]
struct Section {
    range: Range<usize>,
    count: u32,
    aux: usize,
}

pub(super) struct Directory {
    sections: [Section; SECTION_COUNT],
    pub(super) node_count: u32,
    pub(super) folder_count: u32,
    pub(super) active_count: u32,
}

impl Directory {
    pub(super) fn section<'a>(&self, bytes: &'a [u8], kind: SectionKind) -> &'a [u8] {
        &bytes[self.sections[kind as usize - 1].range.clone()]
    }

    pub(super) fn count(&self, kind: SectionKind) -> u32 {
        self.sections[kind as usize - 1].count
    }

    fn aux(&self, kind: SectionKind) -> usize {
        self.sections[kind as usize - 1].aux
    }

    pub(super) fn catalog<'a>(
        &self,
        bytes: &'a [u8],
        directory: SectionKind,
        arena: SectionKind,
    ) -> Catalog<'a> {
        Catalog {
            directory: self.section(bytes, directory),
            arena: self.section(bytes, arena),
            count: self.count(directory) as usize,
        }
    }

    pub(super) fn exact_catalog<'a>(&self, bytes: &'a [u8]) -> Catalog<'a> {
        let (directory, arena) = self
            .section(bytes, SectionKind::ExactIntegers)
            .split_at(self.aux(SectionKind::ExactIntegers));
        Catalog {
            directory,
            arena,
            count: self.count(SectionKind::ExactIntegers) as usize,
        }
    }

    fn validate(&self, bytes: &[u8]) -> Option<()> {
        use SectionKind::*;
        let count = self.node_count as usize;
        let folders = self.folder_count as usize;
        let data = |kind| self.section(bytes, kind);
        for (identity, lookup, expected) in [
            (NoteIdentities, NoteLookup, count),
            (FolderIdentities, FolderLookup, folders),
        ] {
            if self.count(identity) as usize != expected
                || !self.count(lookup).is_power_of_two()
                || data(lookup).len() != (self.count(lookup) as usize).checked_mul(8)?
                || data(identity).len() < expected.checked_mul(8)?
            {
                return None;
            }
            let (index, arena) = data(identity).split_at(expected * 8);
            let mut end = 0;
            for slot in index.as_chunks::<8>().0 {
                let offset = u32::from_le_bytes([slot[0], slot[1], slot[2], slot[3]]) as usize;
                let len = usize::from(u16::from_le_bytes([slot[4], slot[5]]));
                if len == 0 {
                    if *slot != [0; 8] {
                        return None;
                    }
                    continue;
                }
                if offset != end
                    || !matches!(len, 12 | 16 | 35 | 36)
                    || slot[7] != 0
                    || (matches!(identity, NoteIdentities) && slot[6] != 0)
                    || (matches!(identity, FolderIdentities) && !matches!(slot[6], 1 | 2 | 4))
                {
                    return None;
                }
                end = offset.checked_add(len)?;
                if end > arena.len() {
                    return None;
                }
            }
            if end != arena.len() || !arena.is_ascii() {
                return None;
            }
        }
        if self.active_count > self.node_count
            || self.count(SortHeaders) as usize != count
            || data(SortHeaders).len() != count.checked_mul(NoteSortHeader::WIDTH)?
            || self.count(BitmapCatalog) != self.count(BitmapArena)
            || self.count(BsiCatalog) != self.count(BsiPlanes)
        {
            return None;
        }
        for (directory, arena) in [(BitmapCatalog, BitmapArena), (BsiCatalog, BsiPlanes)] {
            self.catalog(bytes, directory, arena).validate(true)?;
        }
        self.exact_catalog(bytes).validate(false)?;
        for graph in [GraphOutgoing, GraphIncoming] {
            let offsets_len = count.checked_add(1)?.checked_mul(8)?;
            let graph_data = data(graph);
            let offsets = graph_data.get(..offsets_len)?;
            let edges = graph_data.get(offsets_len..)?;
            let edge_count = edges.len() / 4;
            if self.count(graph) as usize != count
                || !edges.len().is_multiple_of(4)
                || u64_at(offsets, 0)? != 0
                || u64_at(offsets, offsets_len - 8)? != edge_count as u64
            {
                return None;
            }
            let mut previous = 0;
            for offset in offsets.as_chunks::<8>().0 {
                let next = u64::from_le_bytes(*offset);
                if next < previous {
                    return None;
                }
                previous = next;
            }
        }
        let cluster_count = self.count(Clusters) as usize;
        if data(Clusters).len()
            != count
                .checked_mul(4)?
                .checked_add(cluster_count.checked_mul(16)?)?
            || data(TimestampRemainder).len()
                != (self.count(TimestampRemainder) as usize).checked_mul(8)?
        {
            return None;
        }
        Some(())
    }
}

pub(super) fn matches_header(bytes: &[u8], identity: &IndexIdentity, size: u64) -> bool {
    bytes.len() >= HEADER_SIZE
        && size >= (HEADER_SIZE + DIGEST_SIZE) as u64
        && bytes[..8] == MAGIC
        && u16_at(bytes, 8) == Some(ENDIAN)
        && u16_at(bytes, 10) == Some(FORMAT_VERSION)
        && u64_at(bytes, 12) == Some(identity.generation.get())
        && u64_at(bytes, 20) == Some(identity.seq.get())
        && &bytes[28..44] == identity.scope.incarnation.as_bytes()
        && u32_at(bytes, 56) == Some(SECTION_COUNT as u32)
        && u32_at(bytes, 60) == Some(0)
        && &bytes[64..96] == blake3::hash(identity.scope.space_id.as_str().as_bytes()).as_bytes()
        && u64_at(bytes, 96) == Some(size)
        && u64_at(bytes, 104) == Some(HEADER_SIZE as u64)
        && bytes[112..128] == [0; 16]
}

pub(super) fn matches_temp_header(
    bytes: &[u8; HEADER_SIZE],
    generation: ProjectionGeneration,
    scope: &HistoryScope,
    through: SpaceSeq,
) -> bool {
    let Some(seq) = u64_at(bytes, 20).and_then(|seq| SpaceSeq::new(seq).ok()) else {
        return false;
    };
    let Some(declared_size) = u64_at(bytes, 96) else {
        return false;
    };
    // The prefix witnesses ownership even if the writer never finished
    // appending the body. This header is used only to unlink a temp name.
    seq < through
        && matches_header(
            bytes,
            &IndexIdentity {
                generation,
                scope: scope.clone(),
                seq,
            },
            declared_size,
        )
}

pub(super) fn decode(
    bytes: &[u8],
    identity: &IndexIdentity,
    size: u64,
    digest: &[u8; 32],
) -> Result<Directory, IndexError> {
    let invalid = || IndexError::Untrusted("invalid checkpoint identity or layout");
    if bytes.len() as u64 != size || !matches_header(bytes, identity, size) {
        return Err(invalid());
    }

    let trailer = bytes.len() - DIGEST_SIZE;
    let mut hasher = blake3::Hasher::new();
    let payload = &bytes[..trailer];
    if payload.len() >= 1024 * 1024 {
        // Overlap cold page faults and hashing without copying the checkpoint.
        hasher.update_rayon(payload);
    } else {
        hasher.update(payload);
    }
    if hasher.finalize().as_bytes() != &bytes[trailer..] {
        return Err(IndexError::Untrusted("invalid checkpoint checksum"));
    }
    hasher.update(&bytes[trailer..]);
    if hasher.finalize().as_bytes() != digest {
        return Err(IndexError::Untrusted(
            "checkpoint does not match writer digest",
        ));
    }

    let mut sections: [Section; SECTION_COUNT] = array::from_fn(|_| Section::default());
    let mut floor = HEADER_SIZE + SECTION_COUNT * ENTRY_SIZE;
    for (index, section) in sections.iter_mut().enumerate() {
        let offset = HEADER_SIZE + index * ENTRY_SIZE;
        let kind = u32_at(bytes, offset).ok_or_else(invalid)?;
        let count = u32_at(bytes, offset + 4).ok_or_else(invalid)?;
        let start = usize_at(bytes, offset + 8).ok_or_else(invalid)?;
        let length = usize_at(bytes, offset + 16).ok_or_else(invalid)?;
        let aux = usize_at(bytes, offset + 24).ok_or_else(invalid)?;
        let end = start.checked_add(length).ok_or_else(invalid)?;
        if kind as usize != index + 1
            || start < floor
            || start % ALIGN != 0
            || end > trailer
            || aux > length
            || (kind != SectionKind::ExactIntegers as u32 && aux != 0)
        {
            return Err(invalid());
        }
        floor = end.max(start + 1);
        *section = Section {
            range: start..end,
            count,
            aux,
        };
    }

    let directory = Directory {
        sections,
        node_count: u32_at(bytes, 44).ok_or_else(invalid)?,
        folder_count: u32_at(bytes, 48).ok_or_else(invalid)?,
        active_count: u32_at(bytes, 52).ok_or_else(invalid)?,
    };
    directory.validate(bytes).ok_or_else(invalid)?;
    Ok(directory)
}

pub(super) fn encode(
    identity: &IndexIdentity,
    nodes: u32,
    folders: u32,
    active: u32,
    sections: &[WriteSection],
) -> Result<Vec<u8>, IndexError> {
    let size_error = || IndexError::InvalidInput("checkpoint exceeds addressable size");
    if sections.len() != SECTION_COUNT {
        return Err(IndexError::InvalidInput("incomplete sections"));
    }
    let mut out = vec![0; HEADER_SIZE + SECTION_COUNT * ENTRY_SIZE];
    out[..8].copy_from_slice(&MAGIC);
    out[8..10].copy_from_slice(&ENDIAN.to_le_bytes());
    out[10..12].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    out[12..20].copy_from_slice(&identity.generation.get().to_le_bytes());
    out[20..28].copy_from_slice(&identity.seq.get().to_le_bytes());
    out[28..44].copy_from_slice(identity.scope.incarnation.as_bytes());
    out[44..48].copy_from_slice(&nodes.to_le_bytes());
    out[48..52].copy_from_slice(&folders.to_le_bytes());
    out[52..56].copy_from_slice(&active.to_le_bytes());
    out[56..60].copy_from_slice(&(SECTION_COUNT as u32).to_le_bytes());
    out[64..96]
        .copy_from_slice(blake3::hash(identity.scope.space_id.as_str().as_bytes()).as_bytes());
    out[104..112].copy_from_slice(&(HEADER_SIZE as u64).to_le_bytes());
    for (index, section) in sections.iter().enumerate() {
        if section.kind as usize != index + 1 {
            return Err(IndexError::InvalidInput("sections out of order"));
        }
        let start = out
            .len()
            .checked_next_multiple_of(ALIGN)
            .ok_or_else(size_error)?;
        let directory_offset = HEADER_SIZE + index * ENTRY_SIZE;
        out[directory_offset..directory_offset + 4]
            .copy_from_slice(&(section.kind as u32).to_le_bytes());
        out[directory_offset + 4..directory_offset + 8]
            .copy_from_slice(&section.count.to_le_bytes());
        out[directory_offset + 8..directory_offset + 16]
            .copy_from_slice(&(start as u64).to_le_bytes());
        out[directory_offset + 16..directory_offset + 24]
            .copy_from_slice(&(section.bytes.len() as u64).to_le_bytes());
        out[directory_offset + 24..directory_offset + 32]
            .copy_from_slice(&section.aux.to_le_bytes());
        out.resize(start, 0);
        out.extend(&section.bytes);
        if section.bytes.is_empty() && index + 1 != SECTION_COUNT {
            out.push(0);
        }
    }
    let total_size = out.len().checked_add(DIGEST_SIZE).ok_or_else(size_error)?;
    out[96..104].copy_from_slice(&(total_size as u64).to_le_bytes());
    let footer = blake3::hash(&out);
    out.extend(footer.as_bytes());
    Ok(out)
}

pub(super) struct Catalog<'a> {
    directory: &'a [u8],
    arena: &'a [u8],
    count: usize,
}

impl<'a> Catalog<'a> {
    fn entry(&self, index: usize) -> Option<(&'a [u8], Range<usize>)> {
        if index >= self.count {
            return None;
        }
        let offset = index.checked_mul(CATALOG_ENTRY_SIZE)?;
        let entry = self
            .directory
            .get(offset..offset.checked_add(CATALOG_ENTRY_SIZE)?)?;
        let directory_len = self.count.checked_mul(CATALOG_ENTRY_SIZE)?;
        let key_at = directory_len.checked_add(usize_at(entry, 0)?)?;
        let key_len = u32_at(entry, 8)? as usize;
        let len = u32_at(entry, 12)? as usize;
        let start = usize_at(entry, 16)?;
        let key = self.directory.get(key_at..key_at.checked_add(key_len)?)?;
        Some((key, start..start.checked_add(len)?))
    }

    fn lower_bound(&self, key: &[u8]) -> usize {
        let mut from = 0;
        let mut through = self.count;
        while from < through {
            let middle = from + (through - from) / 2;
            if self.entry(middle).is_some_and(|(value, _)| value < key) {
                from = middle + 1;
            } else {
                through = middle;
            }
        }
        from
    }

    fn lookup(&self, key: &[u8]) -> Option<Range<usize>> {
        let index = self.lower_bound(key);
        let (actual, range) = self.entry(index)?;
        (actual == key).then_some(range)
    }

    pub(super) fn contains(&self, key: &[u8]) -> bool {
        self.lookup(key).is_some()
    }

    pub(super) fn with_prefix(&self, prefix: &'a [u8]) -> impl Iterator<Item = &'a [u8]> + '_ {
        (self.lower_bound(prefix)..self.count)
            .map_while(|index| self.entry(index).map(|(key, _)| key))
            .take_while(move |key| key.starts_with(prefix))
    }

    pub(super) fn frozen(&self, key: &[u8]) -> Option<FrozenSliceToken<'a>> {
        let bytes = self.arena.get(self.lookup(key)?)?;
        if bytes.as_ptr().align_offset(Frozen::REQUIRED_ALIGNMENT) != 0 {
            return None;
        }
        Some(FrozenSliceToken { bytes })
    }

    pub(super) fn value(&self, key: &[u8]) -> Option<&'a [u8]> {
        self.arena.get(self.lookup(key)?)
    }

    fn validate(&self, frozen: bool) -> Option<()> {
        let records_len = self.count.checked_mul(CATALOG_ENTRY_SIZE)?;
        self.directory.get(..records_len)?;
        let mut previous_key = None;
        let mut previous_value_end = 0;
        let mut total_key_bytes = 0usize;
        for n in 0..self.count {
            let (key, range) = self.entry(n)?;
            let offset = n * CATALOG_ENTRY_SIZE;
            if key.is_empty()
                || usize_at(self.directory, offset)? != total_key_bytes
                || previous_key.is_some_and(|previous| previous >= key)
                || range.is_empty()
                || range.start < previous_value_end
            {
                return None;
            }
            self.arena.get(range.clone())?;
            if frozen {
                if range.start
                    != previous_value_end.checked_next_multiple_of(Frozen::REQUIRED_ALIGNMENT)?
                    || range.len() < 4
                {
                    return None;
                }
            } else if range.start != previous_value_end || range.len() % 20 != 0 {
                return None;
            }
            total_key_bytes = total_key_bytes.checked_add(key.len())?;
            previous_value_end = range.end;
            previous_key = Some(key);
        }
        if records_len.checked_add(total_key_bytes)? != self.directory.len()
            || previous_value_end != self.arena.len()
        {
            return None;
        }
        Some(())
    }
}

pub(super) struct FrozenSliceToken<'a> {
    bytes: &'a [u8],
}

impl<'a> FrozenSliceToken<'a> {
    pub(super) fn bytes(self) -> &'a [u8] {
        self.bytes
    }
}

pub(super) fn u16_at(bytes: &[u8], index: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(index..index.checked_add(2)?)?.try_into().ok()?,
    ))
}
pub(super) fn u32_at(bytes: &[u8], index: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(index..index.checked_add(4)?)?.try_into().ok()?,
    ))
}
pub(super) fn u64_at(bytes: &[u8], index: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(index..index.checked_add(8)?)?.try_into().ok()?,
    ))
}
fn usize_at(bytes: &[u8], index: usize) -> Option<usize> {
    usize::try_from(u64_at(bytes, index)?).ok()
}
