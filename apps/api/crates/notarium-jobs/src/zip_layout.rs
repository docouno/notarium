use std::io::{Read, Seek, SeekFrom};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
};
use zip::read::{ArchiveOffset, Config, ZipArchive};

const END_SIZE: usize = 22;
const LOCATOR_SIZE: usize = 20;
const ZIP64_END_SIZE: usize = 56;
const CENTRAL_SIZE: usize = 46;
const LOCAL_SIZE: usize = 30;

const END: u32 = 0x0605_4b50;
const END64: u32 = 0x0606_4b50;
const LOCATOR: u32 = 0x0706_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;
const DESCRIPTOR: u32 = 0x0807_4b50;

pub(crate) struct ZipLimits {
    pub bytes: u64,
    pub metadata_bytes: u64,
    pub entries: usize,
}

#[derive(Clone, Copy)]
pub(crate) struct EntrySpan {
    pub offset: u64,
    pub len: u64,
}

struct Directory {
    start: u64,
    end: u64,
    entries: usize,
}

struct CentralEntry {
    local: u64,
    flags: u16,
    method: u16,
    crc: u32,
    stored: u64,
    expanded: u64,
    name: Vec<u8>,
}

/// Validate the physical layout before zip allocates the central directory or
/// opens a decoder. The returned spans are in central-directory order.
pub(crate) fn open_zip<R: Read + Seek>(
    mut source: R,
    limits: ZipLimits,
) -> Result<(ZipArchive<R>, Vec<EntrySpan>), PortError> {
    let directory = read_directory(&mut source, &limits)?;
    let entries = read_layout(&mut source, &directory, limits.metadata_bytes)?;
    let archive = ZipArchive::with_config(
        Config {
            archive_offset: ArchiveOffset::Known(0),
        },
        source,
    )
    .map_err(|_| invalid_zip())?;
    if archive.len() != directory.entries
        || archive.central_directory_start() != directory.start
        || archive.has_duplicate_names()
    {
        return Err(invalid_zip());
    }
    Ok((archive, entries))
}

fn read_directory(
    source: &mut (impl Read + Seek),
    limits: &ZipLimits,
) -> Result<Directory, PortError> {
    let len = source.seek(SeekFrom::End(0)).map_err(|_| invalid_zip())?;
    if len > limits.bytes {
        return Err(limit_exceeded());
    }
    let tail_start = len.saturating_sub((END_SIZE + usize::from(u16::MAX)) as u64);
    let mut tail = vec![0; (len - tail_start) as usize];
    read_at(source, tail_start, &mut tail)?;
    let end_pos = tail
        .windows(END_SIZE)
        .enumerate()
        .rev()
        .find(|&(pos, entry)| {
            le32(entry, 0) == END && tail.len() - pos == END_SIZE + usize::from(le16(entry, 20))
        })
        .map(|(pos, _)| pos)
        .ok_or_else(invalid_zip)?;
    let end = &tail[end_pos..];
    if le16(end, 4) != 0 || le16(end, 6) != 0 || le16(end, 8) != le16(end, 10) {
        return Err(invalid_zip());
    }
    let end_offset = tail_start + end_pos as u64;
    let count32 = le16(end, 10);
    let size32 = le32(end, 12);
    let start32 = le32(end, 16);
    let mut locator = [0; LOCATOR_SIZE];
    let has_zip64 = if let Some(locator_at) = end_offset.checked_sub(LOCATOR_SIZE as u64) {
        read_at(source, locator_at, &mut locator)?;
        le32(&locator, 0) == LOCATOR
    } else {
        false
    };
    let (entries, size, start, stop) = if has_zip64 {
        let zip64_at = le64(&locator, 8);
        let mut end64 = [0; ZIP64_END_SIZE];
        if le32(&locator, 4) != 0
            || le32(&locator, 16) != 1
            || zip64_at.checked_add(ZIP64_END_SIZE as u64 + LOCATOR_SIZE as u64) != Some(end_offset)
        {
            return Err(invalid_zip());
        }
        read_at(source, zip64_at, &mut end64)?;
        let entries = le64(&end64, 32);
        let size = le64(&end64, 40);
        let start = le64(&end64, 48);
        if le32(&end64, 0) != END64
            || le64(&end64, 4) != 44
            || le32(&end64, 16) != 0
            || le32(&end64, 20) != 0
            || le64(&end64, 24) != entries
            || (count32 != u16::MAX && entries != u64::from(count32))
            || (size32 != u32::MAX && size != u64::from(size32))
            || (start32 != u32::MAX && start != u64::from(start32))
        {
            return Err(invalid_zip());
        }
        (entries, size, start, zip64_at)
    } else {
        if count32 == u16::MAX || size32 == u32::MAX || start32 == u32::MAX {
            return Err(invalid_zip());
        }
        (
            u64::from(count32),
            u64::from(size32),
            u64::from(start32),
            end_offset,
        )
    };
    if size > limits.metadata_bytes || entries > limits.entries as u64 {
        return Err(limit_exceeded());
    }
    if start.checked_add(size) != Some(stop) || size / (CENTRAL_SIZE as u64) < entries {
        return Err(invalid_zip());
    }
    Ok(Directory {
        start,
        end: stop,
        entries: entries as usize,
    })
}

fn read_layout(
    source: &mut (impl Read + Seek),
    directory: &Directory,
    max_local_metadata: u64,
) -> Result<Vec<EntrySpan>, PortError> {
    let mut order = Vec::with_capacity(directory.entries);
    let mut entries = Vec::with_capacity(directory.entries);
    let mut position = directory.start;
    for index in 0..directory.entries {
        let (entry, next) = central_entry(source, directory.end, position)?;
        position = next;
        order.push((entry.local, index));
        entries.push(entry);
    }
    if position != directory.end {
        return Err(invalid_zip());
    }
    order.sort_unstable();
    if order.first().map_or(directory.start, |(offset, _)| *offset) != 0 {
        return Err(invalid_zip());
    }
    let mut spans = vec![EntrySpan { offset: 0, len: 0 }; entries.len()];
    let mut metadata = 0;
    for (index, &(start, central_index)) in order.iter().enumerate() {
        let stop = order
            .get(index + 1)
            .map_or(directory.start, |(offset, _)| *offset);
        let span = local_entry(source, start, stop, &entries[central_index])?;
        metadata += span.offset - start + (stop - span.offset - span.len);
        if metadata > max_local_metadata {
            return Err(limit_exceeded());
        }
        spans[central_index] = span;
    }
    Ok(spans)
}

fn central_entry(
    source: &mut (impl Read + Seek),
    limit: u64,
    position: u64,
) -> Result<(CentralEntry, u64), PortError> {
    bounded_end(position, CENTRAL_SIZE as u64, limit)?;
    let mut header = [0; CENTRAL_SIZE];
    read_at(source, position, &mut header)?;
    if le32(&header, 0) != CENTRAL || le16(&header, 34) != 0 {
        return Err(invalid_zip());
    }
    let flags = le16(&header, 8);
    let method = le16(&header, 10);
    let allowed_flags = if method == 8 { 0x080e } else { 0x0808 };
    if flags & !allowed_flags != 0 || !matches!(method, 0 | 8 | 93) {
        return Err(DomainError::validation(ValidationReason::UnsupportedArchiveEntry).into());
    }
    let name_len = usize::from(le16(&header, 28));
    let extra_len = usize::from(le16(&header, 30));
    let variable = (name_len + extra_len + usize::from(le16(&header, 32))) as u64;
    let next = bounded_end(position + CENTRAL_SIZE as u64, variable, limit)?;
    let mut name = vec![0; name_len];
    let mut extra = vec![0; extra_len];
    source.read_exact(&mut name).map_err(|_| invalid_zip())?;
    source.read_exact(&mut extra).map_err(|_| invalid_zip())?;
    let [expanded, stored, local] = zip64_values(
        [le32(&header, 24), le32(&header, 20), le32(&header, 42)],
        &extra,
    )?;
    if method == 0 && stored != expanded {
        return Err(invalid_zip());
    }
    Ok((
        CentralEntry {
            local,
            flags,
            method,
            crc: le32(&header, 16),
            stored,
            expanded,
            name,
        },
        next,
    ))
}

fn local_entry(
    source: &mut (impl Read + Seek),
    start: u64,
    stop: u64,
    entry: &CentralEntry,
) -> Result<EntrySpan, PortError> {
    let variable_at = bounded_end(start, LOCAL_SIZE as u64, stop)?;
    let mut header = [0; LOCAL_SIZE];
    read_at(source, start, &mut header)?;
    if le32(&header, 0) != LOCAL
        || le16(&header, 6) != entry.flags
        || le16(&header, 8) != entry.method
        || usize::from(le16(&header, 26)) != entry.name.len()
    {
        return Err(invalid_zip());
    }
    let extra_len = usize::from(le16(&header, 28));
    let offset = bounded_end(variable_at, (entry.name.len() + extra_len) as u64, stop)?;
    let mut name = vec![0; entry.name.len()];
    let mut extra = vec![0; extra_len];
    source.read_exact(&mut name).map_err(|_| invalid_zip())?;
    source.read_exact(&mut extra).map_err(|_| invalid_zip())?;
    if name != entry.name {
        return Err(invalid_zip());
    }
    let payload_end = bounded_end(offset, entry.stored, stop)?;
    let local_crc = le32(&header, 14);
    let [expanded, stored] = zip64_values([le32(&header, 22), le32(&header, 18)], &extra)?;
    if entry.flags & 8 == 0 {
        if stop != payload_end
            || local_crc != entry.crc
            || stored != entry.stored
            || expanded != entry.expanded
        {
            return Err(invalid_zip());
        }
    } else {
        if (local_crc != 0 && local_crc != entry.crc)
            || (stored != 0 && stored != entry.stored)
            || (expanded != 0 && expanded != entry.expanded)
        {
            return Err(invalid_zip());
        }
        verify_descriptor(source, payload_end, stop - payload_end, entry)?;
    }
    Ok(EntrySpan {
        offset,
        len: entry.stored,
    })
}

fn verify_descriptor(
    source: &mut (impl Read + Seek),
    offset: u64,
    len: u64,
    entry: &CentralEntry,
) -> Result<(), PortError> {
    if !matches!(len, 12 | 16 | 20 | 24) {
        return Err(invalid_zip());
    }
    let mut buffer = [0; 24];
    let mut raw = &mut buffer[..len as usize];
    read_at(source, offset, raw)?;
    if matches!(len, 16 | 24) {
        if le32(raw, 0) != DESCRIPTOR {
            return Err(invalid_zip());
        }
        raw = &mut raw[4..];
    }
    let (stored, expanded) = if raw.len() == 20 {
        (le64(raw, 4), le64(raw, 12))
    } else {
        (u64::from(le32(raw, 4)), u64::from(le32(raw, 8)))
    };
    if le32(raw, 0) != entry.crc || stored != entry.stored || expanded != entry.expanded {
        return Err(invalid_zip());
    }
    Ok(())
}

fn zip64_values<const N: usize>(sizes: [u32; N], extra: &[u8]) -> Result<[u64; N], PortError> {
    let mut fields = extra;
    let mut zip64 = None;
    while !fields.is_empty() {
        if fields.len() < 4 {
            return Err(invalid_zip());
        }
        let id = le16(fields, 0);
        let len = usize::from(le16(fields, 2));
        let data = fields.get(4..4 + len).ok_or_else(invalid_zip)?;
        if id == 1 && zip64.replace(data).is_some() {
            return Err(invalid_zip());
        }
        fields = &fields[4 + len..];
    }
    let mut output = sizes.map(u64::from);
    let mut values = zip64.unwrap_or_default();
    for (size, output) in sizes.into_iter().zip(output.iter_mut()) {
        if size == u32::MAX {
            let (value, rest) = values.split_at_checked(8).ok_or_else(invalid_zip)?;
            *output = le64(value, 0);
            values = rest;
        }
    }
    Ok(output)
}

fn read_at(
    source: &mut (impl Read + Seek),
    offset: u64,
    bytes: &mut [u8],
) -> Result<(), PortError> {
    source
        .seek(SeekFrom::Start(offset))
        .map_err(|_| invalid_zip())?;
    source.read_exact(bytes).map_err(|_| invalid_zip())
}

fn bounded_end(start: u64, len: u64, limit: u64) -> Result<u64, PortError> {
    start
        .checked_add(len)
        .filter(|end| *end <= limit)
        .ok_or_else(invalid_zip)
}

fn le16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

fn le32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn le64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn invalid_zip() -> PortError {
    DomainError::validation(ValidationReason::InvalidArchive).into()
}

fn limit_exceeded() -> PortError {
    DomainError::validation(ValidationReason::BudgetExceeded).into()
}
