use super::schema::{CHAT, NOTE};
use croaring::Bitmap;
use notarium_core::{ids::NoteId, ports::StructuralSnapshot};
use std::{collections::BTreeSet, sync::Arc};
use tantivy::{
    DocId, Score, SegmentReader,
    collector::{Collector, SegmentCollector},
    columnar::Column,
};

pub struct LexicalFilter<'a> {
    pub snapshot: &'a dyn StructuralSnapshot,
    pub folders: Option<Arc<Bitmap>>,
    pub notes: Option<&'a Bitmap>,
    pub(super) classes: u64,
    pub include_chats: bool,
    pub(super) excluded: Option<&'a BTreeSet<NoteId>>,
}

pub(super) struct DocFilterCollector<'a, T> {
    pub inner: T,
    pub filter: &'a LexicalFilter<'a>,
    pub browse: bool,
}

pub(super) struct SegmentFilter<T> {
    inner: T,
    kind: Column<u64>,
    class: Column<u64>,
    folder: Column<u64>,
    allowed_folders: Option<Arc<Bitmap>>,
    notes: Option<Column<u64>>,
    allowed_note_ords: Vec<u64>,
    classes: u64,
    include_chats: bool,
}

impl<T: Collector> Collector for DocFilterCollector<'_, T> {
    type Fruit = T::Fruit;
    type Child = SegmentFilter<T::Child>;

    fn for_segment(&self, index: u32, segment: &SegmentReader) -> tantivy::Result<Self::Child> {
        let fields = segment.fast_fields();
        let mut allowed_note_ords = Vec::new();
        let mut notes = None;
        if self.filter.classes != 0
            && let Some(column) = fields.bytes("note_id_raw")?
        {
            allowed_note_ords.resize(column.dictionary().num_terms().div_ceil(64), 0);
            let mut stream = column.dictionary().stream()?;
            let generation = self.filter.snapshot.cut().generation;
            while stream.advance() {
                let Ok(raw) = std::str::from_utf8(stream.key()) else {
                    continue;
                };
                let Ok(note) = NoteId::parse(raw) else {
                    continue;
                };
                if self
                    .filter
                    .excluded
                    .is_some_and(|excluded| excluded.contains(&note))
                {
                    continue;
                }
                let Some(node) = self.filter.snapshot.lookup(&note) else {
                    continue;
                };
                if !self.filter.snapshot.doc_class(node).is_ok_and(|class| {
                    self.filter.classes & (1 << super::schema::class_ord(class)) != 0
                }) {
                    continue;
                }
                if self
                    .filter
                    .notes
                    .is_none_or(|mask| node.index(generation).is_ok_and(|idx| mask.contains(idx)))
                {
                    let ord = stream.term_ord() as usize;
                    allowed_note_ords[ord / 64] |= 1 << (ord % 64);
                }
            }
            notes = Some(column.ords().clone());
        }
        Ok(SegmentFilter {
            inner: self.inner.for_segment(index, segment)?,
            kind: fields.u64("doc_kind")?,
            class: fields.u64("doc_class_ord")?,
            folder: fields.u64("parent_folder_ord")?,
            allowed_folders: self.filter.folders.clone(),
            notes,
            allowed_note_ords,
            classes: self.filter.classes,
            include_chats: self.filter.include_chats && !self.browse,
        })
    }

    fn requires_scoring(&self) -> bool {
        self.inner.requires_scoring()
    }

    fn merge_fruits(
        &self,
        fruits: Vec<<Self::Child as SegmentCollector>::Fruit>,
    ) -> tantivy::Result<Self::Fruit> {
        self.inner.merge_fruits(fruits)
    }
}

impl<T: SegmentCollector> SegmentCollector for SegmentFilter<T> {
    type Fruit = T::Fruit;

    fn collect(&mut self, doc: DocId, score: Score) {
        if let Some(folders) = &self.allowed_folders
            && !self
                .folder
                .first(doc)
                .and_then(|value| u32::try_from(value).ok())
                .is_some_and(|folder| folder != 0 && folders.contains(folder))
        {
            return;
        }
        let allowed = match self.kind.first(doc) {
            Some(CHAT) => self.include_chats,
            Some(NOTE) => {
                self.class
                    .first(doc)
                    .is_some_and(|class| class < 64 && self.classes & (1 << class) != 0)
                    && self
                        .notes
                        .as_ref()
                        .and_then(|column| column.first(doc))
                        .is_some_and(|ord| {
                            self.allowed_note_ords
                                .get(ord as usize / 64)
                                .is_some_and(|bits| bits & (1 << (ord % 64)) != 0)
                        })
            }
            _ => false,
        };
        if allowed {
            self.inner.collect(doc, score);
        }
    }

    fn harvest(self) -> Self::Fruit {
        self.inner.harvest()
    }
}
