use super::{
    HitKey, LexicalError, LexicalHit,
    schema::{CHAT, NOTE, class_ord},
};
use crate::vector::SearchBudget;
use croaring::Bitmap;
use notarium_core::{
    DomainError,
    ids::{NoteId, PrincipalId},
    model::DenseNodeId,
    ports::StructuralSnapshot,
};
use std::{
    cmp::Ordering,
    collections::{BTreeSet, BinaryHeap},
    sync::Arc,
    time::Instant,
};
use tantivy::{
    DocAddress, DocId, DocSet, Score, Searcher, SegmentReader, TERMINATED,
    columnar::{BytesColumn, Column},
    query::{EnableScoring, Query},
};

const SELECTIVE_NOTE_MASK_LIMIT: u64 = 4_096;

pub struct LexicalFilter<'a> {
    pub snapshot: &'a dyn StructuralSnapshot,
    pub folders: Option<Arc<Bitmap>>,
    pub notes: Option<&'a Bitmap>,
    pub(super) classes: u64,
    pub include_chats: bool,
    pub(super) chat_viewer: Option<&'a PrincipalId>,
    pub(super) excluded: Option<&'a BTreeSet<NoteId>>,
    pub(super) budget: Option<SearchBudget<'a>>,
}

pub(super) fn check_budget(budget: Option<SearchBudget<'_>>) -> Result<(), LexicalError> {
    if budget.is_some_and(|budget| {
        budget.cancellation.is_cancelled() || Instant::now() >= budget.deadline
    }) {
        return Err(LexicalError::Stopped);
    }
    Ok(())
}

impl LexicalFilter<'_> {
    fn admits_note(&self, raw: &[u8]) -> Result<bool, LexicalError> {
        let Ok(raw) = std::str::from_utf8(raw) else {
            return Ok(false);
        };
        let Ok(note) = NoteId::parse(raw) else {
            return Ok(false);
        };
        if self.excluded.is_some_and(|ids| ids.contains(&note)) {
            return Ok(false);
        }
        let Some(node) = self.snapshot.lookup(&note)? else {
            return Ok(false);
        };
        if let Some(mask) = self.notes
            && !mask.contains(node.index(self.snapshot.cut().generation)?)
        {
            return Ok(false);
        }
        let class = match self.snapshot.doc_class(node) {
            Ok(class) => class,
            Err(DomainError::ResourceNotFound) => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        Ok(self.classes & (1 << class_ord(class)) != 0)
    }
}

struct SegmentFilter {
    kind: Column<u64>,
    class: Column<u64>,
    folder: Column<u64>,
    notes: Option<BytesColumn>,
    chat_owners: Option<Column<u64>>,
    viewer_ord: Option<u64>,
    note_bytes: Vec<u8>,
    note_mask: Option<Bitmap>,
}

impl SegmentFilter {
    fn open(segment: &SegmentReader, filter: &LexicalFilter<'_>) -> Result<Self, LexicalError> {
        let fields = segment.fast_fields();
        let notes = if filter.classes != 0 {
            fields.bytes("note_id_raw")?
        } else {
            None
        };
        let owners = if filter.include_chats {
            fields.bytes("chat_owner")?
        } else {
            None
        };
        let viewer_ord = match (&owners, filter.chat_viewer) {
            (Some(owners), Some(viewer)) => {
                owners.dictionary().term_ord(viewer.as_str().as_bytes())?
            }
            _ => None,
        };
        let note_mask = match (&notes, filter.notes) {
            (Some(column), Some(allowed)) if allowed.cardinality() <= SELECTIVE_NOTE_MASK_LIMIT => {
                let mut mask = Bitmap::new();
                let generation = filter.snapshot.cut().generation;
                for (position, dense_idx) in allowed.iter().enumerate() {
                    if position.is_multiple_of(64) {
                        check_budget(filter.budget)?;
                    }
                    let node = DenseNodeId::new(generation, dense_idx);
                    let note_id = match filter.snapshot.note_id(node) {
                        Ok(id) => id,
                        Err(DomainError::ResourceNotFound) => continue,
                        Err(error) => return Err(error.into()),
                    };
                    if filter.excluded.is_some_and(|ids| ids.contains(&note_id)) {
                        continue;
                    }
                    let class = match filter.snapshot.doc_class(node) {
                        Ok(class) => class,
                        Err(DomainError::ResourceNotFound) => continue,
                        Err(error) => return Err(error.into()),
                    };
                    if filter.classes & (1 << class_ord(class)) == 0 {
                        continue;
                    }
                    if let Some(ord) = column.dictionary().term_ord(note_id.as_str().as_bytes())?
                        && let Ok(ord) = u32::try_from(ord)
                    {
                        mask.add(ord);
                    }
                }
                Some(mask)
            }
            _ => None,
        };
        Ok(Self {
            kind: fields.u64("doc_kind")?,
            class: fields.u64("doc_class_ord")?,
            folder: fields.u64("parent_folder_ord")?,
            notes,
            chat_owners: owners.map(|c| c.ords().clone()),
            viewer_ord,
            note_bytes: Vec::new(),
            note_mask,
        })
    }

    fn admits_folder(&self, filter: &LexicalFilter<'_>, doc: DocId) -> bool {
        filter.folders.as_ref().is_none_or(|folders| {
            self.folder
                .first(doc)
                .and_then(|id| u32::try_from(id).ok())
                .is_some_and(|id| id != 0 && folders.contains(id))
        })
    }

    fn admits_note_fast_fields(&self, filter: &LexicalFilter<'_>, doc: DocId) -> bool {
        self.admits_folder(filter, doc)
            && self.kind.first(doc) == Some(NOTE)
            && self
                .class
                .first(doc)
                .is_some_and(|class| class < 64 && filter.classes & (1 << class) != 0)
    }

    fn admits(&mut self, filter: &LexicalFilter<'_>, doc: DocId) -> Result<bool, LexicalError> {
        if !self.admits_folder(filter, doc) {
            return Ok(false);
        }
        match self.kind.first(doc) {
            Some(CHAT) => Ok(filter.include_chats
                && self
                    .chat_owners
                    .as_ref()
                    .and_then(|column| column.first(doc))
                    .is_none_or(|owner| self.viewer_ord == Some(owner))),
            Some(NOTE)
                if self
                    .class
                    .first(doc)
                    .is_some_and(|class| class < 64 && filter.classes & (1 << class) != 0) =>
            {
                let Some(column) = &self.notes else {
                    return Ok(false);
                };
                let Some(ord) = column.ords().first(doc) else {
                    return Ok(false);
                };
                if let Some(mask) = &self.note_mask {
                    return Ok(u32::try_from(ord).is_ok_and(|ord| mask.contains(ord)));
                }
                if !column.ord_to_bytes(ord, &mut self.note_bytes)? {
                    return Ok(false);
                }
                filter.admits_note(&self.note_bytes)
            }
            _ => Ok(false),
        }
    }
}

/// Orders worst candidate first so a `BinaryHeap` maintains the global top-K
/// floor: higher scores are better, and smaller `DocAddress` breaks ties.
#[derive(Clone, Copy)]
struct WorstFirst {
    score: Score,
    address: DocAddress,
}

impl PartialEq for WorstFirst {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for WorstFirst {}

impl PartialOrd for WorstFirst {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for WorstFirst {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .total_cmp(&self.score)
            .then_with(|| self.address.cmp(&other.address))
    }
}

pub(super) fn collect_top_scored(
    searcher: &Searcher,
    query: &dyn Query,
    filter: &LexicalFilter<'_>,
    limit: usize,
    after: Option<(Score, DocAddress)>,
) -> Result<Vec<(Score, DocAddress)>, LexicalError> {
    check_budget(filter.budget)?;
    if limit == 0 {
        return Ok(Vec::new());
    }
    let weight = query.weight(EnableScoring::enabled_from_searcher(searcher))?;
    let mut heap = BinaryHeap::<WorstFirst>::with_capacity(limit);
    for (ord, reader) in searcher.segment_readers().iter().enumerate() {
        check_budget(filter.budget)?;
        let ord = ord as u32;
        let mut scorer = weight.scorer(reader, 1.0)?;
        let mut doc = scorer.doc();
        if doc == TERMINATED {
            continue;
        }
        let mut fields = SegmentFilter::open(reader, filter)?;
        let mut visited = 0_u32;
        while doc != TERMINATED {
            if visited.is_multiple_of(64) {
                check_budget(filter.budget)?;
            }
            visited += 1;
            if !reader.is_deleted(doc) {
                let score = scorer.score();
                let address = DocAddress::new(ord, doc);
                let after_cursor = after.is_none_or(|(last_score, last_address)| {
                    score.total_cmp(&last_score) == Ordering::Less
                        || (score.total_cmp(&last_score) == Ordering::Equal
                            && address > last_address)
                });
                if after_cursor {
                    let candidate = WorstFirst { score, address };
                    let can_enter =
                        heap.len() < limit || heap.peek().is_some_and(|worst| candidate < *worst);
                    if can_enter && fields.admits(filter, doc)? {
                        if heap.len() < limit {
                            heap.push(candidate);
                        } else if let Some(mut worst) = heap.peek_mut() {
                            *worst = candidate;
                        }
                    }
                }
            }
            doc = scorer.advance();
        }
    }
    check_budget(filter.budget)?;
    Ok(heap
        .into_sorted_vec()
        .into_iter()
        .map(|item| (item.score, item.address))
        .collect())
}

pub(super) fn collect_browse(
    searcher: &Searcher,
    filter: &LexicalFilter<'_>,
    limit: usize,
) -> Result<Vec<LexicalHit>, LexicalError> {
    check_budget(filter.budget)?;
    if limit == 0 || filter.classes == 0 {
        return Ok(Vec::new());
    }
    let mut candidates: Vec<(Vec<u8>, DocAddress)> = Vec::new();
    let mut scratch = Vec::new();
    for (seg_ord, reader) in searcher.segment_readers().iter().enumerate() {
        check_budget(filter.budget)?;
        if reader.num_docs() == 0 {
            continue;
        }
        let fields = SegmentFilter::open(reader, filter)?;
        let Some(notes) = fields.notes.as_ref() else {
            continue;
        };
        let ords = notes.ords();
        // Term ordinals are strictly ordered by `note_id_raw` within each segment.
        let mut segment_best = BinaryHeap::<(u64, DocId)>::with_capacity(limit);
        for doc in 0..reader.max_doc() {
            if doc.is_multiple_of(64) {
                check_budget(filter.budget)?;
            }
            if reader.is_deleted(doc) || !fields.admits_note_fast_fields(filter, doc) {
                continue;
            }
            let Some(ord) = ords.first(doc) else {
                continue;
            };
            if segment_best.len() == limit
                && segment_best
                    .peek()
                    .is_some_and(|&(worst_ord, _)| ord >= worst_ord)
            {
                continue;
            }
            let admitted = if let Some(mask) = &fields.note_mask {
                u32::try_from(ord).is_ok_and(|ord| mask.contains(ord))
            } else {
                notes.ord_to_bytes(ord, &mut scratch)? && filter.admits_note(&scratch)?
            };
            if !admitted {
                continue;
            }
            if segment_best.len() < limit {
                segment_best.push((ord, doc));
            } else if let Some(mut worst) = segment_best.peek_mut() {
                *worst = (ord, doc);
            }
        }
        let winners = segment_best.into_sorted_vec();
        candidates.reserve(winners.len());
        for (ord, doc) in winners {
            let mut bytes = Vec::new();
            if !notes.ord_to_bytes(ord, &mut bytes)? {
                return Err(LexicalError::CorruptIndex);
            }
            candidates.push((bytes, DocAddress::new(seg_ord as u32, doc)));
        }
    }
    check_budget(filter.budget)?;
    candidates
        .sort_unstable_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    candidates.truncate(limit);
    candidates
        .into_iter()
        .map(|(bytes, _)| {
            let raw = std::str::from_utf8(&bytes).map_err(|_| LexicalError::CorruptIndex)?;
            let note = NoteId::parse(raw).map_err(|_| LexicalError::CorruptIndex)?;
            Ok(LexicalHit {
                key: HitKey::Note(note),
                score: 1.0,
            })
        })
        .collect()
}
