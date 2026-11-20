use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use yrs::{ID, IdSet, block::ClientID};

use super::{
    body::{BodyIndex, UnitClass},
    update::{Block, Content, Frame, Parent},
};
use crate::wire::PolicyRejectReason as Reject;

/// Maximum distinct CRDT client IDs permitted to be introduced via untrusted
/// peer updates on a single live lineage. Bounds worst-case `yrs` `ClientHasher`
/// probing while allowing thousands of distinct collaborating sessions.
pub(super) const MAX_ROOM_CLIENTS: usize = 2048;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Root {
    Body,
    Field(Arc<str>),
    Garbage,
}

struct Span {
    end: u32,
    root: Root,
}

#[derive(Default)]
struct ClientHistory {
    clock: u32,
    spans: Vec<(u32, Span)>,
}

#[derive(Default)]
pub(super) struct Topology {
    clients: HashMap<ClientID, ClientHistory>,
}

enum Visit {
    Unseen,
    Visiting,
    Resolved(Root),
}

pub(super) struct Evidence {
    pub(super) insertions: IdSet,
    pub(super) fields: HashSet<Arc<str>>,
    pub(super) touches_body: bool,
    roots: Vec<Visit>,
}

impl Topology {
    pub(super) fn clock(&self, client: ClientID) -> u32 {
        self.clients.get(&client).map_or(0, |history| history.clock)
    }

    pub(super) fn has_client(&self, client: ClientID) -> bool {
        self.clients.contains_key(&client)
    }

    pub(super) fn client_count(&self) -> usize {
        self.clients.len()
    }

    fn span(&self, id: ID) -> Option<&Span> {
        guard_work!(causal_probes += 1);
        let history = self.clients.get(&id.client)?;
        let index = history
            .spans
            .partition_point(|(start, _)| *start <= id.clock)
            .checked_sub(1)?;
        let (_, span) = &history.spans[index];
        (id.clock < span.end).then_some(span)
    }

    pub(super) fn append_body(&mut self, id: ID, end: u32) {
        self.append(id, end, Root::Body);
    }

    fn append(&mut self, id: ID, end: u32, root: Root) {
        let history = self.clients.entry(id.client).or_default();
        debug_assert_eq!(id.clock, history.clock);
        history.clock = end;
        if let Some((_, last)) = history.spans.last_mut()
            && last.root == root
        {
            last.end = end;
            return;
        }
        history.spans.push((id.clock, Span { end, root }));
    }

    pub(super) fn from_snapshot(frame: &Frame<'_>) -> Result<Self, Reject> {
        let mut topology = Self::default();
        let evidence = topology.prove(frame, &BodyIndex::default(), &[], None)?;
        topology.apply_resolved(frame, &evidence)?;
        Ok(topology)
    }

    pub(super) fn apply_resolved(
        &mut self,
        frame: &Frame<'_>,
        evidence: &Evidence,
    ) -> Result<(), Reject> {
        for (block, visit) in frame.blocks.iter().zip(&evidence.roots) {
            let current = self.clock(block.id.client);
            if block.end <= current {
                continue;
            }
            let Visit::Resolved(root) = visit else {
                return Err(Reject::PendingClockGap);
            };
            let start = block.id.clock.max(current);
            self.append(ID::new(block.id.client, start), block.end, root.clone());
        }
        Ok(())
    }

    pub(super) fn prove(
        &self,
        frame: &Frame<'_>,
        body: &BodyIndex,
        reserved: &[ClientID],
        max_total_clients: Option<usize>,
    ) -> Result<Evidence, Reject> {
        let mut evidence = Evidence {
            insertions: IdSet::new(),
            fields: HashSet::new(),
            touches_body: false,
            roots: (0..frame.blocks.len()).map(|_| Visit::Unseen).collect(),
        };

        let mut new_clients = 0usize;
        for (client, run) in &frame.runs {
            let current = self.clock(*client);
            if !self.clients.contains_key(client) {
                new_clients += 1;
            }
            let first = &frame.blocks[run.start];
            let last = &frame.blocks[run.end - 1];
            if first.id.clock > current || (last.end > current && reserved.contains(client)) {
                return Err(Reject::PendingClockGap);
            }
            if last.end > current {
                evidence
                    .insertions
                    .insert(ID::new(*client, current), last.end - current);
            }
        }
        if let Some(limit) = max_total_clients
            && self.clients.len().saturating_add(new_clients) > limit
        {
            return Err(Reject::MalformedUpdate);
        }

        let mut maximum_body_len = body.len;
        for block in &frame.blocks {
            guard_work!(causal_blocks += 1);
            let current = self.clock(block.id.client);
            if block.end <= current {
                continue;
            }
            if let Content::String(text) = block.content {
                let overlap = current.saturating_sub(block.id.clock);
                if overlap > 0
                    && (utf16_unit_class_at(text, overlap).is_some_and(UnitClass::is_low)
                        || body
                            .unit_class(ID::new(block.id.client, current - 1))
                            .is_some_and(UnitClass::is_high))
                {
                    return Err(Reject::InvalidBodyContent);
                }
                maximum_body_len = maximum_body_len
                    .checked_add(block.len() - overlap)
                    .filter(|end| *end <= i32::MAX as u32)
                    .ok_or(Reject::InvalidBodyContent)?;
                evidence.touches_body = true;
            }
        }

        // Traverse causality iteratively. In addition to explicit anchors, each
        // client must have integrated its immediately preceding range. This
        // detects cycles that would otherwise leave a partial Yrs transaction.
        let mut stack = Vec::new();
        for (index, block) in frame.blocks.iter().enumerate() {
            if block.end <= self.clock(block.id.client)
                || !matches!(evidence.roots[index], Visit::Unseen)
            {
                continue;
            }
            stack.push((index, false));
            while let Some((index, resolve)) = stack.pop() {
                if resolve {
                    let root = self.resolve(frame, body, &evidence, index)?;
                    if let Root::Field(key) = &root {
                        evidence.fields.insert(Arc::clone(key));
                    }
                    evidence.roots[index] = Visit::Resolved(root);
                } else {
                    match evidence.roots[index] {
                        Visit::Resolved(_) => continue,
                        Visit::Visiting => return Err(Reject::PendingClockGap),
                        Visit::Unseen => {}
                    }
                    evidence.roots[index] = Visit::Visiting;
                    stack.push((index, true));
                    let block = frame.blocks[index];
                    let current = self.clock(block.id.client);
                    let (left, right) = anchors(block, current);
                    let predecessor = block
                        .id
                        .clock
                        .checked_sub(1)
                        .map(|clock| ID::new(block.id.client, clock));
                    for id in [predecessor, left, right].into_iter().flatten() {
                        if id.clock >= self.clock(id.client) {
                            let dependency = frame.block_at(id).ok_or(Reject::PendingClockGap)?;
                            stack.push((dependency, false));
                        }
                    }
                }
            }
        }

        for deletion in &frame.deletes {
            let first = deletion.id;
            let last = ID::new(first.client, deletion.end - 1);
            if self
                .unit_class(frame, body, first)
                .is_some_and(UnitClass::is_low)
                || self
                    .unit_class(frame, body, last)
                    .is_some_and(UnitClass::is_high)
            {
                return Err(Reject::InvalidBodyContent);
            }
            let mut id = first;
            // Intersect spans, not individual UTF-16 units. A compact delete set
            // may refer to an arbitrarily large contiguous tombstone.
            while id.clock < deletion.end {
                let (root, end) = self.locate(frame, &evidence, id)?;
                match root {
                    Root::Field(key) => {
                        evidence.fields.insert(Arc::clone(key));
                    }
                    Root::Body => evidence.touches_body = true,
                    Root::Garbage => {}
                }
                id.clock = end;
            }
        }
        Ok(evidence)
    }

    fn resolve(
        &self,
        frame: &Frame<'_>,
        body: &BodyIndex,
        evidence: &Evidence,
        index: usize,
    ) -> Result<Root, Reject> {
        let block = frame.blocks[index];
        let current = self.clock(block.id.client);
        if matches!(block.parent, Parent::Garbage) {
            return Ok(Root::Garbage);
        }
        let explicit = match block.parent {
            Parent::Body => Some(Root::Body),
            Parent::Field(key) => Some(Root::Field(Arc::from(key))),
            Parent::Anchored { .. } => None,
            Parent::Garbage => unreachable!("garbage has no parent"),
        };
        let (left, right) = anchors(block, current);
        let mut root = explicit;
        for (id, rejects) in [
            (left, UnitClass::is_high as fn(UnitClass) -> bool),
            (right, UnitClass::is_low),
        ] {
            if let Some(id) = id {
                let (anchored, _) = self.locate(frame, evidence, id)?;
                if matches!(anchored, Root::Garbage)
                    || root.as_ref().is_some_and(|known| known != anchored)
                {
                    return Err(Reject::ForbiddenRootOrSubdoc);
                }
                if self.unit_class(frame, body, id).is_some_and(rejects) {
                    return Err(Reject::InvalidBodyContent);
                }
                root = Some(anchored.clone());
            }
        }

        let root = root.ok_or(Reject::ForbiddenRootOrSubdoc)?;
        if let Parent::Anchored { map, .. } = block.parent
            && map != matches!(root, Root::Field(_))
        {
            return Err(Reject::ForbiddenRootOrSubdoc);
        }
        match (&root, block.content) {
            (Root::Body, Content::String(_) | Content::Deleted)
            | (Root::Field(_), Content::Value | Content::Deleted) => Ok(root),
            _ => Err(Reject::ForbiddenRootOrSubdoc),
        }
    }

    fn locate<'a>(
        &'a self,
        frame: &Frame<'_>,
        evidence: &'a Evidence,
        id: ID,
    ) -> Result<(&'a Root, u32), Reject> {
        if let Some(span) = self.span(id) {
            return Ok((&span.root, span.end));
        }
        let index = frame.block_at(id).ok_or(Reject::PendingClockGap)?;
        let Visit::Resolved(root) = &evidence.roots[index] else {
            return Err(Reject::PendingClockGap);
        };
        Ok((root, frame.blocks[index].end))
    }

    fn unit_class(&self, frame: &Frame<'_>, body: &BodyIndex, id: ID) -> Option<UnitClass> {
        if id.clock < self.clock(id.client) {
            return body.unit_class(id);
        }
        let index = frame.block_at(id)?;
        let block = frame.blocks[index];
        let Content::String(text) = block.content else {
            return None;
        };
        utf16_unit_class_at(text, id.clock - block.id.clock)
    }
}

fn utf16_unit_class_at(text: &str, utf16_offset: u32) -> Option<UnitClass> {
    let target = utf16_offset as usize;
    if text.is_ascii() {
        return text
            .as_bytes()
            .get(target)
            .map(|&b| UnitClass::from_utf16(u16::from(b)));
    }
    let mut pos = 0usize;
    for ch in text.chars() {
        let len = ch.len_utf16();
        if target < pos + len {
            return Some(if len == 2 {
                if target == pos {
                    UnitClass::HighSurrogate
                } else {
                    UnitClass::LowSurrogate
                }
            } else {
                UnitClass::from_utf16(ch as u16)
            });
        }
        pos += len;
    }
    None
}

fn anchors(block: Block<'_>, current: u32) -> (Option<ID>, Option<ID>) {
    let (mut left, right) = match block.parent {
        Parent::Anchored { left, right, .. } => (left, right),
        _ => (None, None),
    };
    if block.id.clock < current && !matches!(block.parent, Parent::Garbage) {
        // Yrs excludes the known prefix and sets the new piece's left origin
        // to the final ID of that prefix.
        left = Some(ID::new(block.id.client, current - 1));
    }
    (left, right)
}
