//! The visible UTF-16 sequence, addressed by durable CRDT clocks.
//!
//! Each page holds non-overlapping runs of at most 1024 units stored as 4-bit
//! character-class nibbles. Adjacent same-client insertions on the same page
//! coalesce in place so sustained keystroke sessions do not fragment runs.
//! Links connect visible runs without walking deleted items, prior authors or
//! the text to the left of an ordinary edit. Structural updates rebuild this
//! projection from Yrs's actual visible order.

use std::{
    collections::{HashMap, VecDeque},
    ops::Range,
};

use notarium_core::span::ByteSpan;
use notarium_syntax::markdown;
use yrs::{ID, block::ClientID};

use super::update::{Block, Content, Deletion, Parent};
use crate::wire::PolicyRejectReason as Reject;

pub(super) const PAGE_UNITS: u32 = 1024;
const LOCAL_DELETE_LIMIT: u32 = 128;
const RECENT_DELETED_ANCHORS: usize = 512;

type Page = (ClientID, u32);
type Gap = (Option<ID>, Option<ID>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(super) enum UnitClass {
    Ordinary = 0,
    LineStartSafe = 1,
    Newline = 2,
    HighSurrogate = 3,
    LowSurrogate = 4,
}

impl UnitClass {
    pub(super) fn from_utf16(unit: u16) -> Self {
        match unit {
            10 | 13 => Self::Newline,
            0xd800..=0xdbff => Self::HighSurrogate,
            0xdc00..=0xdfff => Self::LowSurrogate,
            _ if char::from_u32(u32::from(unit)).is_some_and(prose_start) => Self::LineStartSafe,
            _ => Self::Ordinary,
        }
    }

    fn from_nibble(nibble: u8) -> Self {
        match nibble {
            1 => Self::LineStartSafe,
            2 => Self::Newline,
            3 => Self::HighSurrogate,
            4 => Self::LowSurrogate,
            _ => Self::Ordinary,
        }
    }

    pub(super) fn is_high(self) -> bool {
        self == Self::HighSurrogate
    }

    pub(super) fn is_low(self) -> bool {
        self == Self::LowSurrogate
    }

    pub(super) fn is_newline(self) -> bool {
        self == Self::Newline
    }

    pub(super) fn can_start_line(self) -> bool {
        matches!(self, Self::LineStartSafe | Self::HighSurrogate)
    }
}

pub(super) struct NibbleBuf {
    len: u32,
    bytes: Vec<u8>,
}

impl NibbleBuf {
    fn with_capacity(units: usize) -> Self {
        Self {
            len: 0,
            bytes: Vec::with_capacity(units.div_ceil(2)),
        }
    }

    fn from_str(text: &str) -> Self {
        let mut buf = Self::with_capacity(text.len());
        for unit in text.encode_utf16() {
            buf.push(UnitClass::from_utf16(unit));
        }
        buf
    }

    pub(super) fn len(&self) -> u32 {
        self.len
    }

    fn get(&self, idx: usize) -> UnitClass {
        let byte = self.bytes[idx >> 1];
        let nibble = if idx & 1 == 0 { byte & 0x0f } else { byte >> 4 };
        UnitClass::from_nibble(nibble)
    }

    fn push(&mut self, class: UnitClass) {
        let idx = self.len as usize;
        let val = class as u8;
        if idx & 1 == 0 {
            self.bytes.push(val);
        } else {
            self.bytes[idx >> 1] |= val << 4;
        }
        self.len += 1;
    }

    fn extend_from_range(&mut self, src: &Self, start: usize, count: usize) {
        let new_len = self.len as usize + count;
        self.bytes
            .reserve(new_len.div_ceil(2).saturating_sub(self.bytes.len()));
        if (self.len as usize) & 1 == 0 && start & 1 == 0 {
            let full_bytes = count >> 1;
            let src_byte = start >> 1;
            self.bytes
                .extend_from_slice(&src.bytes[src_byte..src_byte + full_bytes]);
            self.len += (full_bytes * 2) as u32;
            if count & 1 == 1 {
                self.push(src.get(start + count - 1));
            }
            return;
        }
        for idx in start..start + count {
            self.push(src.get(idx));
        }
    }

    fn truncate(&mut self, new_len: usize) {
        self.len = new_len as u32;
        self.bytes.truncate(new_len.div_ceil(2));
        if new_len & 1 == 1
            && let Some(last) = self.bytes.last_mut()
        {
            *last &= 0x0f;
        }
    }

    fn split_off(&mut self, offset: usize) -> Self {
        let total = self.len as usize;
        let right_len = total - offset;
        if offset & 1 == 0 {
            let right_bytes = self.bytes.split_off(offset >> 1);
            self.len = offset as u32;
            return Self {
                len: right_len as u32,
                bytes: right_bytes,
            };
        }
        let mut right = Self::with_capacity(right_len);
        for idx in offset..total {
            right.push(self.get(idx));
        }
        self.truncate(offset);
        right
    }
}

struct Run {
    start: u32,
    units: NibbleBuf,
    left: Option<ID>,
    right: Option<ID>,
    plain: bool,
}

impl Run {
    fn end(&self) -> u32 {
        self.start + self.units.len()
    }
}

enum PageRuns {
    One(Run),
    Many(Vec<Run>),
}

impl PageRuns {
    fn as_slice(&self) -> &[Run] {
        match self {
            Self::One(run) => std::slice::from_ref(run),
            Self::Many(runs) => runs,
        }
    }

    fn as_mut_slice(&mut self) -> &mut [Run] {
        match self {
            Self::One(run) => std::slice::from_mut(run),
            Self::Many(runs) => runs,
        }
    }

    fn insert(&mut self, run: Run) {
        match self {
            Self::One(_) => {
                let placeholder = Run {
                    start: 0,
                    units: NibbleBuf {
                        len: 0,
                        bytes: Vec::new(),
                    },
                    left: None,
                    right: None,
                    plain: false,
                };
                let Self::One(existing) = std::mem::replace(self, Self::One(placeholder)) else {
                    unreachable!()
                };
                let runs = if existing.start < run.start {
                    vec![existing, run]
                } else {
                    vec![run, existing]
                };
                *self = Self::Many(runs);
            }
            Self::Many(runs) => {
                let index = runs.partition_point(|old| old.start < run.start);
                runs.insert(index, run);
            }
        }
    }

    fn remove(mut self, clock: u32) -> (Run, Option<Self>) {
        match self {
            Self::One(run) => {
                debug_assert_eq!(run.start, clock);
                (run, None)
            }
            Self::Many(ref mut runs) => {
                let index = runs.partition_point(|run| run.start < clock);
                let run = runs.remove(index);
                if runs.is_empty() {
                    (run, None)
                } else if runs.len() == 1 {
                    let only = runs.pop().expect("single remaining run");
                    (run, Some(Self::One(only)))
                } else {
                    (run, Some(self))
                }
            }
        }
    }
}

#[derive(Default)]
pub(super) struct BodyIndex {
    pages: HashMap<Page, PageRuns>,
    head: Option<ID>,
    tail: Option<ID>,
    pub(super) len: u32,
    fences: usize,
    deleted_anchors: HashMap<ID, Gap>,
    deleted_order: VecDeque<ID>,
}

#[derive(Default)]
pub(super) struct LocalEdit {
    pub(super) insert: Option<Insertion>,
    pub(super) delete: Option<Removal>,
}

pub(super) struct Insertion {
    pub(super) id: ID,
    pub(super) units: NibbleBuf,
    left: Option<ID>,
    right: Option<ID>,
    plain: bool,
}

pub(super) struct Removal {
    pub(super) first: ID,
    pub(super) len: u32,
    left: Option<ID>,
    right: Option<ID>,
}

impl BodyIndex {
    pub(super) fn rebuild(body: &str, ordered: &[(ID, &str)]) -> Result<Self, Reject> {
        guard_work!(whole_body_passes += 1, body_input_bytes += body.len());
        let fences = body
            .as_bytes()
            .iter()
            .filter(|b| matches!(b, b'`' | b'~'))
            .count();
        let plain = if fences == 0 {
            vec![]
        } else {
            plain_lines(body)?
        };
        let mut result = Self {
            fences,
            ..Self::default()
        };
        let mut offset = 0;
        let mut line = 0;
        for (id, mut text) in ordered.iter().copied() {
            let mut clock = id.clock;
            while !text.is_empty() {
                while plain.get(line).is_some_and(|span| span.end <= offset) {
                    line += 1;
                }
                let (len, certified) = match plain.get(line) {
                    Some(span) if offset >= span.start => (text.len().min(span.end - offset), true),
                    Some(span) => (text.len().min(span.start - offset), false),
                    None => (text.len(), false),
                };
                let (first, rest) = text.split_at(len);
                let classes = NibbleBuf::from_str(first);
                let unit_len = classes.len();
                guard_work!(utf16_writes += unit_len as usize);
                let start = ID::new(id.client, clock);
                result.insert_gap(start, result.tail, None, &classes, certified);
                result.len += unit_len;
                offset += len;
                clock += unit_len;
                text = rest;
            }
        }
        Ok(result)
    }

    pub(super) fn unit_class(&self, id: ID) -> Option<UnitClass> {
        let run = self.run(id)?;
        Some(run.units.get((id.clock - run.start) as usize))
    }

    #[cfg(test)]
    pub(super) fn run_count(&self) -> usize {
        self.pages.values().map(|page| page.as_slice().len()).sum()
    }

    pub(super) fn local_insert(
        &self,
        block: Block<'_>,
        delete: Option<Removal>,
    ) -> Option<LocalEdit> {
        let Content::String(text) = block.content else {
            return None;
        };
        let (mut left, right) = match block.parent {
            Parent::Body if self.len == 0 => (None, None),
            Parent::Anchored {
                left,
                right,
                map: false,
            } => (left, right),
            _ => return None,
        };
        if let Some(id) = left
            && self.unit_class(id).is_none()
        {
            // Yjs and Yrs skip deleted items before typing at a visible
            // cursor. A recent deleted item can still identify the exact
            // gap, provided its visible endpoints are still neighbors.
            let anchors = self.deleted_anchors.get(&id);
            guard_work!(unproved_gaps += usize::from(anchors.is_none()));
            let (previous, next) = anchors?;
            if *next != right {
                guard_work!(unproved_gaps += 1);
                return None;
            }
            left = *previous;
        }
        if left.is_some_and(|id| self.unit_class(id).is_none_or(UnitClass::is_high))
            || right.is_some_and(|id| self.unit_class(id).is_none_or(UnitClass::is_low))
        {
            return None;
        }
        let (left, right) = if let Some(remove) = &delete {
            let last = ID::new(remove.first.client, remove.first.clock + remove.len - 1);
            // The author's insertion may have been placed before or after the
            // selected range. Those gaps collapse to the same visible neighbors
            // when the exact range is deleted in this transaction.
            if !(left == remove.left && (right == Some(remove.first) || right == remove.right)
                || left == Some(last) && right == remove.right)
            {
                return None;
            }
            (remove.left, remove.right)
        } else {
            if self.next(left) != right || self.previous(right) != left {
                guard_work!(unproved_gaps += 1);
                return None;
            }
            (left, right)
        };
        let plain = self.fences != 0;
        if plain {
            if !text.chars().all(prose_inner) || !self.prose_gap(left, right, text.chars().next()?)
            {
                return None;
            }
        } else if text.contains(['`', '~']) {
            return None;
        }
        let units = NibbleBuf::from_str(text);
        guard_work!(utf16_writes += units.len() as usize);
        Some(LocalEdit {
            insert: Some(Insertion {
                id: block.id,
                left,
                right,
                units,
                plain,
            }),
            delete,
        })
    }

    pub(super) fn local_removal(&self, deletion: Deletion) -> Option<Removal> {
        let Deletion { id, end } = deletion;
        let len = end - id.clock;
        if len > LOCAL_DELETE_LIMIT {
            return None;
        }
        let last = ID::new(id.client, end - 1);
        if self.unit_class(id)?.is_low() || self.unit_class(last)?.is_high() {
            return None;
        }
        let left = self.previous(Some(id));
        let right = self.next(Some(last));

        let mut clock = id.clock;
        while clock < end {
            let current = ID::new(id.client, clock);
            let run = self.run(current)?;
            if self.fences != 0 && !run.plain {
                return None;
            }
            let step_end = run.end().min(end);
            if step_end < end && run.right != Some(ID::new(id.client, step_end)) {
                return None;
            }
            clock = step_end;
        }
        if self.fences != 0
            && !left.is_some_and(|id| self.is_plain(id))
            && !right.is_some_and(|id| {
                self.is_plain(id) && self.unit_class(id).is_some_and(UnitClass::can_start_line)
            })
        {
            return None;
        }
        Some(Removal {
            first: id,
            left,
            right,
            len,
        })
    }

    pub(super) fn apply(&mut self, edit: LocalEdit) {
        if let Some(Removal {
            first,
            left,
            right,
            len,
        }) = edit.delete
        {
            self.split_at(first);
            if let Some(right) = right {
                self.split_at(right);
            }
            let mut current = Some(first);
            while current != right {
                let id = current.expect("validated deletion has a visible right boundary");
                current = self.remove_run(id).right;
            }
            self.join(left, right);
            self.len -= len;
            self.remember_deleted_anchor(
                ID::new(first.client, first.clock + len - 1),
                (left, right),
            );
        }
        if let Some(Insertion {
            id,
            left,
            right,
            units,
            plain,
        }) = edit.insert
        {
            let inserted = units.len();
            self.insert_gap(id, left, right, &units, plain);
            self.len += inserted;
        }
    }

    pub(super) fn keep_deleted_anchors(&mut self, previous: &mut Self) {
        self.deleted_anchors = std::mem::take(&mut previous.deleted_anchors);
        self.deleted_order = std::mem::take(&mut previous.deleted_order);
    }

    fn remember_deleted_anchor(&mut self, id: ID, gap: Gap) {
        if self.deleted_anchors.len() == RECENT_DELETED_ANCHORS
            && let Some(old) = self.deleted_order.pop_front()
        {
            self.deleted_anchors.remove(&old);
        }
        self.deleted_anchors.insert(id, gap);
        self.deleted_order.push_back(id);
    }

    fn prose_gap(&self, left: Option<ID>, right: Option<ID>, first: char) -> bool {
        let left_plain = left.is_some_and(|id| self.is_plain(id));
        let right_plain = right.is_some_and(|id| self.is_plain(id));
        let boundary = |neighbor: Option<ID>| {
            neighbor.is_none_or(|id| self.unit_class(id).is_some_and(UnitClass::is_newline))
        };
        (left_plain && (right_plain || boundary(right)))
            || (right_plain && boundary(left) && prose_start(first))
    }

    fn is_plain(&self, id: ID) -> bool {
        self.run(id).is_some_and(|run| run.plain)
    }

    fn next(&self, left: Option<ID>) -> Option<ID> {
        let Some(id) = left else {
            return self.head;
        };
        let run = self.run(id)?;
        let next_clock = id.clock + 1;
        if next_clock < run.end() {
            Some(ID::new(id.client, next_clock))
        } else {
            run.right
        }
    }

    fn previous(&self, right: Option<ID>) -> Option<ID> {
        let Some(id) = right else {
            return self.tail;
        };
        let run = self.run(id)?;
        if id.clock > run.start {
            Some(ID::new(id.client, id.clock - 1))
        } else {
            run.left
        }
    }

    fn insert_gap(
        &mut self,
        first: ID,
        left: Option<ID>,
        right: Option<ID>,
        classes: &NibbleBuf,
        plain: bool,
    ) {
        if let Some(right) = right {
            self.split_at(right);
        }
        let mut clock = first.clock;
        let mut offset = 0usize;
        let total = classes.len() as usize;
        let mut previous = left;
        while offset < total {
            let count = ((PAGE_UNITS - clock % PAGE_UNITS) as usize).min(total - offset);
            guard_work!(utf16_writes += count);
            let can_coalesce = previous == clock.checked_sub(1).map(|c| ID::new(first.client, c))
                && !clock.is_multiple_of(PAGE_UNITS);
            let coalesced = if can_coalesce {
                let prev_id = previous.expect("checked_sub succeeded");
                let run = self.run_mut(prev_id);
                if run.end() == clock && run.plain == plain {
                    run.units.extend_from_range(classes, offset, count);
                    run.right = None;
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if !coalesced {
                let id = ID::new(first.client, clock);
                let mut units = NibbleBuf::with_capacity(count);
                units.extend_from_range(classes, offset, count);
                self.push_run(
                    id.client,
                    Run {
                        start: id.clock,
                        units,
                        left: previous,
                        right: None,
                        plain,
                    },
                );
                self.join(previous, Some(id));
            }
            clock += count as u32;
            offset += count;
            previous = Some(ID::new(first.client, clock - 1));
        }
        self.join(previous, right);
    }

    fn join(&mut self, left: Option<ID>, right: Option<ID>) {
        if let Some(left) = left {
            self.run_mut(left).right = right;
        } else {
            self.head = right;
        }
        if let Some(right) = right {
            self.run_mut(right).left = left;
        } else {
            self.tail = left;
        }
    }

    fn split_at(&mut self, id: ID) {
        let run = self.run_mut(id);
        let offset = (id.clock - run.start) as usize;
        if offset == 0 {
            return;
        }
        let units = run.units.split_off(offset);
        guard_work!(utf16_writes += units.len() as usize);
        let next = run.right.replace(id);
        let plain = run.plain;
        self.push_run(
            id.client,
            Run {
                start: id.clock,
                units,
                left: Some(ID::new(id.client, id.clock - 1)),
                right: next,
                plain,
            },
        );
    }

    fn run(&self, id: ID) -> Option<&Run> {
        guard_work!(page_lookups += 1);
        let runs = self.pages.get(&page(id))?.as_slice();
        let index = runs
            .partition_point(|run| run.start <= id.clock)
            .checked_sub(1)?;
        let run = &runs[index];
        (id.clock < run.end()).then_some(run)
    }

    fn run_mut(&mut self, id: ID) -> &mut Run {
        guard_work!(page_lookups += 1);
        let runs = self
            .pages
            .get_mut(&page(id))
            .expect("visible clock page")
            .as_mut_slice();
        let index = runs.partition_point(|run| run.start <= id.clock) - 1;
        let run = &mut runs[index];
        debug_assert!(id.clock < run.end());
        run
    }

    fn push_run(&mut self, client: ClientID, run: Run) {
        let key = page(ID::new(client, run.start));
        match self.pages.get_mut(&key) {
            Some(existing) => existing.insert(run),
            None => {
                self.pages.insert(key, PageRuns::One(run));
            }
        }
    }

    fn remove_run(&mut self, id: ID) -> Run {
        let key = page(id);
        let page_runs = self.pages.remove(&key).expect("visible clock page");
        let (run, remaining) = page_runs.remove(id.clock);
        if let Some(remaining) = remaining {
            self.pages.insert(key, remaining);
        }
        run
    }
}

fn page(id: ID) -> Page {
    (id.client, id.clock / PAGE_UNITS)
}

fn prose_inner(ch: char) -> bool {
    !matches!(ch, '\r' | '\n' | '`' | '~')
}

fn prose_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || (!ch.is_ascii() && !ch.is_whitespace() && ch != '\u{feff}')
}

fn safe_line_prefix(prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    let trimmed = prefix.trim_start_matches([' ', '\t']);
    if trimmed.starts_with('<') || trimmed.starts_with('[') {
        return false;
    }
    !prefix.contains(['<', '`', '~'])
}

fn plain_lines(body: &str) -> Result<Vec<Range<usize>>, Reject> {
    guard_work!(whole_body_passes += 2, body_input_bytes += body.len() * 2);
    let span = ByteSpan::new(0, body.len()).map_err(|_| Reject::InvalidBodyContent)?;
    let analysis = markdown::analyze(body, span).map_err(|_| Reject::InvalidBodyContent)?;
    let mut visible = analysis.text_ranges.iter().peekable();
    let mut fences = analysis.fences.iter().peekable();
    let mut start = 0;
    let mut result = Vec::new();
    for line in body.split_inclusive(['\r', '\n']) {
        let source = line.trim_end_matches(['\r', '\n']);
        let end = start + source.len();
        while visible.peek().is_some_and(|span| span.end() <= start) {
            visible.next();
        }
        while fences.peek().is_some_and(|fence| fence.span.end() <= start) {
            fences.next();
        }
        let in_fence = fences
            .peek()
            .is_some_and(|fence| fence.span.start() < end && fence.span.end() > start);
        if !in_fence
            && !source.is_empty()
            && source.chars().all(prose_inner)
            && let Some(first_text) = visible
                .peek()
                .copied()
                .filter(|span| span.start() < end && span.end() > start)
        {
            let plain_start = first_text.start().max(start);
            let prefix = &body[start..plain_start];
            let suffix = &body[plain_start..end];
            if safe_line_prefix(prefix) && suffix.chars().next().is_some_and(prose_start) {
                result.push(plain_start..end);
            }
        }
        start += line.len();
    }
    Ok(result)
}
