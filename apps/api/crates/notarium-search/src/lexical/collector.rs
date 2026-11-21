use super::{
    LexicalError,
    schema::{CHAT, NOTE},
};
use crate::vector::SearchBudget;
use croaring::Bitmap;
use notarium_core::{
    ids::{NoteId, PrincipalId},
    ports::StructuralSnapshot,
};
use std::{collections::BTreeSet, sync::Arc, time::Instant};
use tantivy::{
    DocAddress, DocId, DocSet, Score, Searcher, SegmentReader, TERMINATED,
    collector::{Collector, SegmentCollector},
    columnar::{BytesColumn, Column},
    query::{EnableScoring, Query},
};

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
    fn admits_note(&self, raw: &[u8]) -> bool {
        let Ok(raw) = std::str::from_utf8(raw) else {
            return false;
        };
        let Ok(note) = NoteId::parse(raw) else {
            return false;
        };
        if self.excluded.is_some_and(|ids| ids.contains(&note)) {
            return false;
        }
        let Some(node) = self.snapshot.lookup(&note) else {
            return false;
        };
        self.notes.is_none_or(|mask| {
            node.index(self.snapshot.cut().generation)
                .is_ok_and(|id| mask.contains(id))
        }) && self
            .snapshot
            .doc_class(node)
            .is_ok_and(|class| self.classes & (1 << super::schema::class_ord(class)) != 0)
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
    checked: usize,
    note_mask: Option<Bitmap>,
}

impl SegmentFilter {
    fn open(segment: &SegmentReader, filter: &LexicalFilter<'_>) -> tantivy::Result<Self> {
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
        Ok(Self {
            kind: fields.u64("doc_kind")?,
            class: fields.u64("doc_class_ord")?,
            folder: fields.u64("parent_folder_ord")?,
            notes,
            chat_owners: owners.map(|c| c.ords().clone()),
            viewer_ord,
            note_bytes: Vec::new(),
            checked: 0,
            note_mask: None,
        })
    }

    fn admits(
        &mut self,
        filter: &LexicalFilter<'_>,
        doc: DocId,
        browse: bool,
    ) -> Result<bool, LexicalError> {
        if let Some(folders) = &filter.folders
            && !self
                .folder
                .first(doc)
                .and_then(|id| u32::try_from(id).ok())
                .is_some_and(|id| id != 0 && folders.contains(id))
        {
            return Ok(false);
        }
        match self.kind.first(doc) {
            Some(CHAT) => Ok(filter.include_chats
                && !browse
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
                // Resolve sparse matches on demand. For a broad term, switch to
                // one sequential dictionary scan instead of repeated SSTable seeks.
                let threshold = (column.num_terms() / 128).clamp(16, 256);
                if self.checked == threshold && self.note_mask.is_none() {
                    let mut mask = Bitmap::new();
                    let mut stream = column.dictionary().stream()?;
                    while stream.advance() {
                        let ord = stream.term_ord();
                        if ord.is_multiple_of(64) {
                            check_budget(filter.budget)?;
                        }
                        if filter.admits_note(stream.key()) {
                            mask.add(ord as u32);
                        }
                    }
                    self.note_mask = Some(mask);
                }
                if let Some(mask) = &self.note_mask {
                    return Ok(mask.contains(ord as u32));
                }
                self.checked += 1;
                Ok(column.ord_to_bytes(ord, &mut self.note_bytes)?
                    && filter.admits_note(&self.note_bytes))
            }
            _ => Ok(false),
        }
    }
}

pub(super) fn collect_filtered<C: Collector>(
    searcher: &Searcher,
    query: &dyn Query,
    collector: &C,
    filter: &LexicalFilter<'_>,
    browse: bool,
    after: Option<(Score, DocAddress)>,
) -> Result<C::Fruit, LexicalError> {
    check_budget(filter.budget)?;
    let scoring = if collector.requires_scoring() {
        EnableScoring::enabled_from_searcher(searcher)
    } else {
        EnableScoring::disabled_from_searcher(searcher)
    };
    let weight = query.weight(scoring)?;
    let mut fruits = Vec::new();
    for (ord, reader) in searcher.segment_readers().iter().enumerate() {
        check_budget(filter.budget)?;
        let ord = ord as u32;
        let mut child = collector.for_segment(ord, reader)?;
        let mut scorer = weight.scorer(reader, 1.0)?;
        let mut fields = SegmentFilter::open(reader, filter)?;
        let mut visited = 0_u32;
        let mut doc = scorer.doc();
        while doc != TERMINATED {
            if visited.is_multiple_of(64) {
                check_budget(filter.budget)?;
            }
            visited += 1;
            if !reader.is_deleted(doc) && fields.admits(filter, doc, browse)? {
                let score = if collector.requires_scoring() {
                    scorer.score()
                } else {
                    0.0
                };
                if after.is_none_or(|(last_score, last_address)| {
                    score < last_score
                        || (score == last_score && DocAddress::new(ord, doc) > last_address)
                }) {
                    child.collect(doc, score);
                }
            }
            doc = scorer.advance();
        }
        fruits.push(child.harvest());
    }
    check_budget(filter.budget)?;
    Ok(collector.merge_fruits(fruits)?)
}
