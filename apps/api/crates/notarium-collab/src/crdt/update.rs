use std::{collections::HashMap, ops::Range};

use notarium_syntax::unicode::validate_content;
use yrs::{ID, block::ClientID};

use crate::{
    carrier::authorize_collab_key,
    wire::{Cursor, FrameError, PolicyRejectReason as Reject},
};

const ORIGIN: u8 = 0x80;
const RIGHT_ORIGIN: u8 = 0x40;
const MAP: u8 = 0x20;
const MAX_CLOCK: u32 = i32::MAX as u32;
pub(super) const MAX_PEER_UPDATE_CLIENTS: usize = 64;
pub(super) const MAX_PEER_UPDATE_BLOCKS: usize = 4096;
pub(super) const MAX_PEER_UPDATE_DELETE_RANGES: usize = 4096;

impl From<FrameError> for Reject {
    fn from(_: FrameError) -> Self {
        Self::MalformedUpdate
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Parent<'a> {
    Body,
    Field(&'a str),
    Anchored {
        left: Option<ID>,
        right: Option<ID>,
        map: bool,
    },
    Garbage,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Content<'a> {
    String { text: &'a str, has_surrogates: bool },
    Value,
    Deleted,
    Garbage,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Block<'a> {
    pub(super) id: ID,
    pub(super) end: u32,
    pub(super) parent: Parent<'a>,
    pub(super) content: Content<'a>,
}

impl Block<'_> {
    pub(super) fn len(&self) -> u32 {
        self.end - self.id.clock
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Deletion {
    pub(super) id: ID,
    pub(super) end: u32,
}

pub(super) struct Frame<'a> {
    pub(super) runs: HashMap<ClientID, Range<usize>>,
    pub(super) blocks: Vec<Block<'a>>,
    pub(super) deletes: Vec<Deletion>,
}

impl Frame<'_> {
    pub(super) fn block_at(&self, id: ID) -> Option<usize> {
        let run = self.runs.get(&id.client)?;
        let blocks = &self.blocks[run.clone()];
        let index = blocks.partition_point(|block| block.end <= id.clock);
        (blocks.get(index)?.id.clock <= id.clock).then_some(run.start + index)
    }
}

/// Inspect an untrusted peer update with strict anti-DoS bounds on clients,
/// blocks, and delete ranges before Yrs decodes or integrates it.
pub(super) fn inspect_peer(raw: &[u8], fm_writable: bool) -> Result<Frame<'_>, Reject> {
    inspect_with_limits(
        raw,
        fm_writable,
        Some(Limits {
            max_clients: MAX_PEER_UPDATE_CLIENTS,
            max_blocks: MAX_PEER_UPDATE_BLOCKS,
            max_deletes: MAX_PEER_UPDATE_DELETE_RANGES,
        }),
    )
}

/// Inspect a trusted snapshot, replay, or locally-encoded update without
/// per-edit peer caps.
pub(super) fn inspect_snapshot(raw: &[u8], fm_writable: bool) -> Result<Frame<'_>, Reject> {
    inspect_with_limits(raw, fm_writable, None)
}

#[derive(Clone, Copy)]
struct Limits {
    max_clients: usize,
    max_blocks: usize,
    max_deletes: usize,
}

fn inspect_with_limits(
    raw: &[u8],
    fm_writable: bool,
    limits: Option<Limits>,
) -> Result<Frame<'_>, Reject> {
    let mut cursor = Cursor::new(raw);
    let mut result = Frame {
        runs: HashMap::new(),
        blocks: Vec::new(),
        deletes: Vec::new(),
    };
    let clients = cursor.count(3)?;
    if limits.is_some_and(|l| clients > l.max_clients) {
        return Err(Reject::MalformedUpdate);
    }
    for _ in 0..clients {
        let blocks = cursor.count(2)?;
        if limits.is_some_and(|l| result.blocks.len().saturating_add(blocks) > l.max_blocks) {
            return Err(Reject::MalformedUpdate);
        }
        let client = cursor.client_id()?;
        let mut clock = cursor.clock()?;
        if blocks == 0 || result.runs.contains_key(&client) {
            return Err(Reject::MalformedUpdate);
        }
        let start = result.blocks.len();
        for _ in 0..blocks {
            let block = block(&mut cursor, ID::new(client, clock), fm_writable)?;
            guard_work!(update_elements += 1);
            clock = block.end;
            result
                .blocks
                .try_reserve(1)
                .map_err(|_| Reject::MalformedUpdate)?;
            result.blocks.push(block);
        }
        result.runs.insert(client, start..result.blocks.len());
    }

    let clients = cursor.count(2)?;
    if limits.is_some_and(|l| clients > l.max_clients) {
        return Err(Reject::MalformedUpdate);
    }
    let mut seen_clients = std::collections::HashSet::new();
    for _ in 0..clients {
        let client = cursor.client_id()?;
        let ranges = cursor.count(2)?;
        if limits.is_some_and(|l| result.deletes.len().saturating_add(ranges) > l.max_deletes) {
            return Err(Reject::MalformedUpdate);
        }
        // Yjs and Yrs use different client orderings in the delete set.
        if ranges == 0 || !seen_clients.insert(client) {
            return Err(Reject::MalformedUpdate);
        }
        let mut last_end = 0;
        for _ in 0..ranges {
            let clock = cursor.clock()?;
            let end = checked_end(clock, cursor.var_u32()?)?;
            guard_work!(update_elements += 1);
            if clock < last_end {
                return Err(Reject::MalformedUpdate);
            }
            last_end = end;
            result
                .deletes
                .try_reserve(1)
                .map_err(|_| Reject::MalformedUpdate)?;
            result.deletes.push(Deletion {
                id: ID::new(client, clock),
                end,
            });
        }
    }

    if !cursor.is_empty() {
        return Err(Reject::MalformedUpdate);
    }
    guard_work!(scanned_update_bytes += raw.len());
    Ok(result)
}

fn read_id(cursor: &mut Cursor<'_>) -> Result<ID, Reject> {
    Ok(ID::new(cursor.client_id()?, cursor.clock()?))
}

fn block<'a>(cursor: &mut Cursor<'a>, id: ID, fm_writable: bool) -> Result<Block<'a>, Reject> {
    let info = cursor.byte()?;
    if info == 10 {
        return Err(Reject::PendingClockGap);
    }
    if info == 0 {
        return Ok(Block {
            id,
            end: checked_end(id.clock, cursor.var_u32()?)?,
            parent: Parent::Garbage,
            content: Content::Garbage,
        });
    }

    let tag = info & 0x0f;
    let map = info & MAP != 0;
    if info & 0x10 != 0 || !matches!(tag, 1 | 4 | 8) {
        return Err(Reject::ForbiddenRootOrSubdoc);
    }
    if tag == 4 && map || tag == 8 && !map {
        return Err(Reject::InvalidFrontmatterValue);
    }
    if map && !fm_writable {
        return Err(Reject::FrontmatterNotWritable);
    }

    let left = (info & ORIGIN != 0).then(|| read_id(cursor)).transpose()?;
    let right = (info & RIGHT_ORIGIN != 0)
        .then(|| read_id(cursor))
        .transpose()?;
    let parent = if left.is_some() || right.is_some() {
        Parent::Anchored { left, right, map }
    } else {
        if cursor.var_u32()? != 1 {
            return Err(Reject::ForbiddenRootOrSubdoc);
        }
        match (cursor.string()?, map) {
            ("body", false) => Parent::Body,
            ("fm_overrides", true) => {
                let key = cursor.string()?;
                authorize_collab_key(key).map_err(|_| Reject::ProtectedFrontmatterKey)?;
                Parent::Field(key)
            }
            _ => return Err(Reject::ForbiddenRootOrSubdoc),
        }
    };
    let (content, len) = match tag {
        1 => (Content::Deleted, cursor.var_u32()?),
        4 => {
            let text = cursor.string()?;
            validate_content(text).map_err(|_| Reject::InvalidBodyContent)?;
            // In UTF-8 only 4-byte codepoints (>= 0xF0) encode to UTF-16
            // surrogate pairs; all 1..=3-byte UTF-8 sequences are single BMP
            // code units.
            let has_surrogates = text.as_bytes().iter().any(|&b| b >= 0xF0);
            let len = u32::try_from(text.encode_utf16().count())
                .map_err(|_| Reject::InvalidBodyContent)?;
            (
                Content::String {
                    text,
                    has_surrogates,
                },
                len,
            )
        }
        8 => {
            if cursor.count(1)? != 1 {
                return Err(Reject::InvalidFrontmatterValue);
            }
            scan_value(cursor)?;
            (Content::Value, 1)
        }
        _ => unreachable!("content tag is checked before decoding the parent"),
    };
    Ok(Block {
        id,
        end: checked_end(id.clock, len)?,
        parent,
        content,
    })
}

fn checked_end(start: u32, len: u32) -> Result<u32, Reject> {
    start
        .checked_add(len)
        .filter(|end| len != 0 && *end <= MAX_CLOCK)
        .ok_or(Reject::MalformedUpdate)
}

fn scan_value(cursor: &mut Cursor<'_>) -> Result<(), Reject> {
    let valid = match cursor.byte()? {
        125 => {
            let number = cursor.var_i64()?;
            // Lib0's integer tag is a JavaScript number, not BigInt.
            number.unsigned_abs() <= (1_u64 << 53)
        }
        124 => f32::from_be_bytes(
            cursor
                .take(4)?
                .try_into()
                .expect("cursor returned four bytes"),
        )
        .is_finite(),
        123 => f64::from_be_bytes(
            cursor
                .take(8)?
                .try_into()
                .expect("cursor returned eight bytes"),
        )
        .is_finite(),
        120 | 121 => true,
        119 => validate_content(cursor.string()?).is_ok(),
        118 => cursor.count(2)? == 1 && cursor.string()? == "$unset" && cursor.byte()? == 120,
        117 => {
            let count = cursor.count(2)?;
            for _ in 0..count {
                if cursor.byte()? != 119 || validate_content(cursor.string()?).is_err() {
                    return Err(Reject::InvalidFrontmatterValue);
                }
            }
            true
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(Reject::InvalidFrontmatterValue)
    }
}
