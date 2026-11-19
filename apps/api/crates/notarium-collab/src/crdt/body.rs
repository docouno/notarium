//! The visible UTF-16 sequence, addressed by durable CRDT clocks.
//!
//! Each page holds non-overlapping runs of at most 128 units. Links connect
//! visible runs without walking deleted items, prior authors or the text to
//! the left of an ordinary edit. Structural updates rebuild this projection
//! from Yrs's actual visible order.

use std::{
    collections::{HashMap, VecDeque},
    ops::Range,
};

use notarium_core::span::ByteSpan;
use notarium_syntax::markdown;
use yrs::{ID, block::ClientID};

use super::update::{Block, Content, Deletion, Parent};
use crate::wire::PolicyRejectReason as Reject;

const PAGE_UNITS: u32 = 128;
const LOCAL_DELETE_LIMIT: u32 = PAGE_UNITS;
const RECENT_DELETED_ANCHORS: usize = 4096;

type Page = (ClientID, u32);
type Gap = (Option<ID>, Option<ID>);

struct Run {
    start: u32,
    units: Vec<u16>,
    left: Option<ID>,
    right: Option<ID>,
    plain: bool,
}

impl Run {
    fn end(&self) -> u32 {
        self.start + self.units.len() as u32
    }
}

#[derive(Default)]
pub(super) struct BodyIndex {
    pages: HashMap<Page, Vec<Run>>,
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
    pub(super) units: Vec<u16>,
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
                let units: Vec<u16> = first.encode_utf16().collect();
                guard_work!(utf16_writes += units.len());
                let start = ID::new(id.client, clock);
                result.insert_gap(start, result.tail, None, &units, certified);
                result.len += units.len() as u32;
                offset += len;
                clock += units.len() as u32;
                text = rest;
            }
        }
        Ok(result)
    }

    pub(super) fn unit(&self, id: ID) -> Option<u16> {
        let run = self.run(id)?;
        Some(run.units[(id.clock - run.start) as usize])
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
            && self.unit(id).is_none()
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
        if left.is_some_and(|id| self.unit(id).is_none_or(is_high))
            || right.is_some_and(|id| self.unit(id).is_none_or(is_low))
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
            if !text.chars().all(prose) || !self.prose_gap(left, right, text.chars().next()?) {
                return None;
            }
        } else if text.contains(['`', '~']) {
            return None;
        }
        let units: Vec<u16> = text.encode_utf16().collect();
        guard_work!(utf16_writes += units.len());
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
        if is_low(self.unit(id)?) || is_high(self.unit(last)?) {
            return None;
        }
        let left = self.previous(Some(id));
        let right = self.next(Some(last));

        for clock in id.clock..end {
            let current = ID::new(id.client, clock);
            let run = self.run(current)?;
            if self.fences != 0 && !run.plain {
                return None;
            }
            if clock + 1 < end && self.next(Some(current)) != Some(ID::new(id.client, clock + 1)) {
                return None;
            }
        }
        if self.fences != 0
            && !left.is_some_and(|id| self.is_plain(id))
            && !right
                .is_some_and(|id| self.is_plain(id) && self.unit(id).is_some_and(unit_can_start))
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
            self.insert_gap(id, left, right, &units, plain);
            self.len += units.len() as u32;
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
        let boundary =
            |neighbor: Option<ID>| neighbor.is_none_or(|id| matches!(self.unit(id), Some(10 | 13)));
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
        mut units: &[u16],
        plain: bool,
    ) {
        if let Some(right) = right {
            self.split_at(right);
        }
        let mut clock = first.clock;
        let mut previous = left;
        while !units.is_empty() {
            let count = ((PAGE_UNITS - clock % PAGE_UNITS) as usize).min(units.len());
            let (chunk, rest) = units.split_at(count);
            guard_work!(utf16_writes += chunk.len());
            let id = ID::new(first.client, clock);
            self.push_run(
                id.client,
                Run {
                    start: id.clock,
                    units: chunk.to_vec(),
                    left: previous,
                    right: None,
                    plain,
                },
            );
            self.join(previous, Some(id));
            clock += count as u32;
            previous = Some(ID::new(first.client, clock - 1));
            units = rest;
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
        guard_work!(utf16_writes += units.len());
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
        let runs = self.pages.get(&page(id))?;
        let index = runs
            .partition_point(|run| run.start <= id.clock)
            .checked_sub(1)?;
        let run = &runs[index];
        (id.clock < run.end()).then_some(run)
    }

    fn run_mut(&mut self, id: ID) -> &mut Run {
        guard_work!(page_lookups += 1);
        let runs = self.pages.get_mut(&page(id)).expect("visible clock page");
        let index = runs.partition_point(|run| run.start <= id.clock) - 1;
        let run = &mut runs[index];
        debug_assert!(id.clock < run.end());
        run
    }

    fn push_run(&mut self, client: ClientID, run: Run) {
        let runs = self
            .pages
            .entry(page(ID::new(client, run.start)))
            .or_default();
        let index = runs.partition_point(|old| old.start < run.start);
        runs.insert(index, run);
    }

    fn remove_run(&mut self, id: ID) -> Run {
        let key = page(id);
        let runs = self.pages.get_mut(&key).expect("visible clock page");
        let index = runs.partition_point(|run| run.start < id.clock);
        let run = runs.remove(index);
        if runs.is_empty() {
            self.pages.remove(&key);
        }
        run
    }
}

fn page(id: ID) -> Page {
    (id.client, id.clock / PAGE_UNITS)
}

pub(super) fn is_high(unit: u16) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}

pub(super) fn is_low(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

fn prose(ch: char) -> bool {
    ch.is_alphanumeric()
        || matches!(ch, ' ' | '.' | ',' | '!' | '?' | '\'' | '"')
        || (!ch.is_ascii() && !ch.is_whitespace())
}

fn prose_start(ch: char) -> bool {
    ch.is_alphabetic() || (!ch.is_ascii() && !ch.is_whitespace() && !ch.is_numeric())
}

fn unit_can_start(unit: u16) -> bool {
    is_high(unit) || char::from_u32(u32::from(unit)).is_some_and(prose_start)
}

fn plain_lines(body: &str) -> Result<Vec<Range<usize>>, Reject> {
    guard_work!(whole_body_passes += 2, body_input_bytes += body.len() * 2);
    let span = ByteSpan::new(0, body.len()).map_err(|_| Reject::InvalidBodyContent)?;
    let analysis = markdown::analyze(body, span).map_err(|_| Reject::InvalidBodyContent)?;
    let mut visible = analysis.text_ranges.iter().peekable();
    let mut start = 0;
    let mut result = Vec::new();
    for line in body.split_inclusive(['\r', '\n']) {
        let source = line.trim_end_matches(['\r', '\n']);
        let end = start + source.len();
        while visible.peek().is_some_and(|span| span.end() <= start) {
            visible.next();
        }
        if source.chars().next().is_some_and(prose_start)
            && source.chars().all(prose)
            && visible
                .peek()
                .is_some_and(|span| span.start() <= start && span.end() >= end)
        {
            result.push(start..end);
        }
        start += line.len();
    }
    Ok(result)
}
