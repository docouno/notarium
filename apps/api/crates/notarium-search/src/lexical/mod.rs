//! Per-Space lexical indexing and structurally filtered candidate collection.

mod analysis;
mod collector;
mod pool;
mod query;
mod schema;

pub(crate) use analysis::ChunkRelevance;
pub use analysis::{TOKENIZER_VERSION, extract_note_body};
pub use collector::LexicalFilter;
pub use pool::{ReaderCache, WriterPool};

use self::{
    analysis::{EXACT, Exact, PROSE, Prose},
    collector::collect_filtered,
    query::QueryPlan,
    schema::{CHAT, Fields, NOTE, class_ord, decode_chat_locator},
};
use crate::layout::FolderOrd;
use croaring::Bitmap;
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    DomainError,
    classes::{DocClass, SearchContent},
    ids::{ChatThreadId, NoteId, PrincipalId, ThreadEntrySeq},
    ports::{ChatThreadKind, StructuralSnapshot},
};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use tantivy::{
    DocAddress, DocSet, Index, IndexReader, Order, ReloadPolicy, Searcher, TERMINATED,
    TantivyDocument, Term,
    collector::{TopDocs, sort_key::SortByBytes},
    schema::{IndexRecordOption, Schema},
};

#[derive(Debug, thiserror::Error)]
pub enum LexicalError {
    #[error("invalid lexical search input")]
    Domain(#[from] DomainError),
    #[error("lexical index failed")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("lexical index I/O failed")]
    Io(#[from] std::io::Error),
    #[error("lexical search stopped")]
    Stopped,
    #[error("invalid lexical index format")]
    CorruptIndex,
    #[error("lexical writer unavailable")]
    WriterUnavailable,
    #[error("lexical reader unavailable")]
    ReaderUnavailable,
    #[error("obsolete lexical files could not be removed")]
    IncompleteCleanup,
}

pub enum Update<'a> {
    Note {
        content: &'a SearchContent,
        title: &'a str,
        folder: FolderOrd,
    },
    Chat {
        hit: &'a HydratedChatHit,
        folder: Option<FolderOrd>,
    },
    RemoveNote(&'a NoteId),
    RemoveChat(&'a ChatThreadId, ThreadEntrySeq),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HitKey {
    Note(NoteId),
    Chat {
        thread: ChatThreadId,
        entry: ThreadEntrySeq,
        kind: ChatThreadKind,
    },
}

#[derive(Clone, Debug)]
pub struct LexicalHit {
    pub key: HitKey,
    pub score: f32,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct ChatCursor {
    relaxed: bool,
    after: Option<(f32, DocAddress)>,
}

pub struct LexicalIndex {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    path: PathBuf,
}

impl LexicalIndex {
    pub(crate) fn is_empty_query(text: &str, filtered: bool) -> Result<bool, LexicalError> {
        static FIELDS: std::sync::LazyLock<Fields> = std::sync::LazyLock::new(Fields::new);
        Ok(QueryPlan::parse(text, &FIELDS.bodies, filtered)?.is_empty())
    }

    pub fn create(path: &Path) -> Result<Self, LexicalError> {
        let fields = Fields::new();
        let index = Index::create_in_dir(path, fields.schema.clone())?;
        Self::from_index(path.to_owned(), index, fields)
    }

    pub fn open(path: &Path) -> Result<Self, LexicalError> {
        let index = Index::open_in_dir(path)?;
        let fields = Fields::new();
        if index.schema() != fields.schema {
            return Err(LexicalError::CorruptIndex);
        }
        Self::from_index(path.to_owned(), index, fields)
    }

    fn from_index(path: PathBuf, index: Index, fields: Fields) -> Result<Self, LexicalError> {
        index.tokenizers().register(PROSE, Prose::default());
        index.tokenizers().register(EXACT, Exact);
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        Ok(Self {
            index,
            reader,
            fields,
            path,
        })
    }

    pub fn schema(&self) -> &Schema {
        &self.fields.schema
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn searcher(&self) -> Searcher {
        self.reader.searcher()
    }

    pub fn commit_id(&self) -> Result<u64, LexicalError> {
        Ok(self.index.load_metas()?.opstamp)
    }

    pub fn apply(&self, pool: &WriterPool, updates: &[Update<'_>]) -> Result<usize, LexicalError> {
        if updates.is_empty() {
            return Ok(0);
        }
        let mutations = self.mutations(updates)?;
        pool.with_writer(&self.path, &self.index, false, |writer| {
            let added = mutations.iter().filter(|(_, doc)| doc.is_some()).count();
            for (term, doc) in mutations {
                writer.delete_term(term);
                if let Some(doc) = doc {
                    writer.add_document(doc)?;
                }
            }
            writer.commit()?;
            self.reader.reload()?;
            Ok(added)
        })
    }

    fn mutations(
        &self,
        updates: &[Update<'_>],
    ) -> Result<Vec<(Term, Option<TantivyDocument>)>, LexicalError> {
        updates
            .iter()
            .map(|update| {
                Ok(match update {
                    Update::Note {
                        content,
                        title,
                        folder,
                    } => {
                        let body = extract_note_body(content)?;
                        let term = self
                            .fields
                            .note_term(&content.provenance().reference().note_id);
                        (term, Some(self.fields.note(content, title, &body, *folder)))
                    }
                    Update::Chat { hit, folder } => (
                        self.fields.chat_term(&hit.thread, hit.entry),
                        Some(self.fields.chat(hit, *folder)),
                    ),
                    Update::RemoveNote(note) => (self.fields.note_term(note), None),
                    Update::RemoveChat(thread, entry) => {
                        (self.fields.chat_term(thread, *entry), None)
                    }
                })
            })
            .collect()
    }

    /// Append one page to an unpublished, empty generation. The writer remains
    /// pinned between pages so the final commit has the entire seed.
    pub fn stage_seed(
        &self,
        pool: &WriterPool,
        updates: &[Update<'_>],
    ) -> Result<(), LexicalError> {
        if updates.is_empty() {
            return Ok(());
        }
        let mutations = self.mutations(updates)?;
        pool.with_writer(&self.path, &self.index, true, |writer| {
            for (_, doc) in mutations {
                writer.add_document(doc.ok_or(LexicalError::CorruptIndex)?)?;
            }
            Ok(())
        })
    }

    pub fn commit_seed(&self, pool: &WriterPool) -> Result<(), LexicalError> {
        pool.with_writer(&self.path, &self.index, false, |writer| {
            writer.commit()?;
            self.reader.reload()?;
            Ok(())
        })
    }

    /// Rewrite all active segments and collect obsolete files after a physical purge.
    pub fn compact(&self, pool: &WriterPool) -> Result<(), LexicalError> {
        pool.with_writer(&self.path, &self.index, false, |writer| {
            let segments = self.index.searchable_segment_ids()?;
            if !segments.is_empty() {
                writer.merge(&segments).wait()?;
            }
            self.reader.reload()?;
            check_garbage_collection(writer)
        })
    }

    pub fn merge_deleted(&self, pool: &WriterPool) -> Result<(), LexicalError> {
        pool.with_writer(&self.path, &self.index, false, |writer| {
            let segments: Vec<_> = self
                .index
                .searchable_segment_metas()?
                .into_iter()
                .filter(|segment| segment.num_deleted_docs() != 0)
                .map(|segment| segment.id())
                .collect();
            if !segments.is_empty() {
                writer.merge(&segments).wait()?;
            }
            self.reader.reload()?;
            Ok(())
        })
    }

    pub fn collect_obsolete(&self, pool: &WriterPool) -> Result<(), LexicalError> {
        pool.with_writer(&self.path, &self.index, false, |writer| {
            check_garbage_collection(writer)
        })
    }

    pub fn contains_note(&self, searcher: &Searcher, note: &NoteId) -> Result<bool, LexicalError> {
        let term = self.fields.note_term(note);
        for segment in searcher.segment_readers() {
            let inverted = segment.inverted_index(self.fields.key)?;
            if let Some(postings) = inverted.read_postings(&term, IndexRecordOption::Basic)?
                && has_live_posting(segment, postings)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn live_chat_entries(
        &self,
        searcher: &Searcher,
        thread: &ChatThreadId,
    ) -> Result<BTreeSet<ThreadEntrySeq>, LexicalError> {
        let prefix = format!("c:{thread}:");
        let upper = format!("c:{thread};");
        let mut result = BTreeSet::new();
        for segment in searcher.segment_readers() {
            let inverted = segment.inverted_index(self.fields.key)?;
            let mut stream = inverted
                .terms()
                .range()
                .ge(&prefix)
                .lt(&upper)
                .into_stream()?;
            while stream.advance() {
                let entry = std::str::from_utf8(&stream.key()[prefix.len()..])
                    .ok()
                    .and_then(|raw| u64::from_str_radix(raw, 16).ok())
                    .and_then(|seq| ThreadEntrySeq::new(seq).ok())
                    .ok_or(LexicalError::CorruptIndex)?;
                let postings = inverted
                    .read_postings_from_terminfo(stream.value(), IndexRecordOption::Basic)?;
                if has_live_posting(segment, postings) {
                    result.insert(entry);
                }
            }
        }
        Ok(result)
    }

    pub fn search(
        &self,
        text: &str,
        filter: &LexicalFilter<'_>,
        candidate_limit: usize,
        filtered: bool,
    ) -> Result<Vec<LexicalHit>, LexicalError> {
        self.search_pinned(
            &self.reader.searcher(),
            text,
            filter,
            candidate_limit,
            filtered,
        )
    }

    pub fn search_pinned(
        &self,
        searcher: &Searcher,
        text: &str,
        filter: &LexicalFilter<'_>,
        candidate_limit: usize,
        filtered: bool,
    ) -> Result<Vec<LexicalHit>, LexicalError> {
        search_pinned(
            searcher,
            &self.fields,
            text,
            filter,
            candidate_limit,
            filtered,
        )
    }

    pub(crate) fn chat_page(
        &self,
        searcher: &Searcher,
        text: &str,
        filter: &LexicalFilter<'_>,
        limit: usize,
        cursor: ChatCursor,
    ) -> Result<(Vec<LexicalHit>, Option<ChatCursor>), LexicalError> {
        use tantivy::query::{BooleanQuery, Occur, Query};
        let plan = QueryPlan::parse(text, &self.fields.bodies[3..], false)?;
        let query: Box<dyn Query> = if cursor.relaxed {
            // The second pass only contributes documents absent from the strict pass.
            Box::new(BooleanQuery::new(vec![
                (Occur::Must, plan.query(true)),
                (Occur::MustNot, plan.query(false)),
            ]))
        } else {
            plan.query(false)
        };
        let collector = TopDocs::with_limit(limit + 1).order_by_score();
        let mut scores = collect_filtered(
            searcher,
            query.as_ref(),
            &collector,
            filter,
            false,
            cursor.after,
        )?;
        let next = if scores.len() > limit {
            scores.truncate(limit);
            Some(ChatCursor {
                relaxed: cursor.relaxed,
                after: scores.last().copied(),
            })
        } else if !cursor.relaxed && plan.can_fallback() {
            Some(ChatCursor {
                relaxed: true,
                after: None,
            })
        } else {
            None
        };
        let hits = scores
            .into_iter()
            .map(|(score, addr)| decode_hit(searcher, addr, score))
            .collect::<Result<_, _>>()?;
        Ok((hits, next))
    }

    /// Score only receipt-bound rows already admitted by the query filters.
    /// A RAM directory uses the same schema, tokenizers and query parser.
    pub(crate) fn rank_overlay(
        writers: &WriterPool,
        text: &str,
        updates: &[Update<'_>],
        filtered: bool,
        budget: crate::vector::SearchBudget<'_>,
    ) -> Result<Vec<LexicalHit>, LexicalError> {
        if updates.is_empty() {
            return Ok(Vec::new());
        }
        collector::check_budget(Some(budget))?;
        let fields = Fields::new();
        let index = Index::create_in_ram(fields.schema.clone());
        let lexical = Self::from_index(PathBuf::new(), index, fields)?;
        writers.with_temporary_writer(&lexical.index, |writer| {
            for update in updates {
                collector::check_budget(Some(budget))?;
                for (_, document) in lexical.mutations(std::slice::from_ref(update))? {
                    writer.add_document(document.ok_or(LexicalError::CorruptIndex)?)?;
                }
            }
            collector::check_budget(Some(budget))?;
            writer.commit()?;
            Ok(())
        })?;
        collector::check_budget(Some(budget))?;
        lexical.reader.reload()?;
        let searcher = lexical.searcher();
        let plan = QueryPlan::parse(text, &lexical.fields.bodies[..3], filtered)?;
        let size = updates.len();
        if plan.browse {
            let collector = TopDocs::with_limit(size)
                .order_by((SortByBytes::for_field("note_id_raw"), Order::Asc));
            return searcher
                .search(plan.query(false).as_ref(), &collector)?
                .into_iter()
                .map(|(_, addr)| decode_hit(&searcher, addr, 1.0))
                .collect();
        }
        let collector = TopDocs::with_limit(size).order_by_score();
        let mut scores = searcher.search(plan.query(false).as_ref(), &collector)?;
        if scores.len() < size && plan.can_fallback() {
            let seen: std::collections::HashSet<_> = scores.iter().map(|(_, addr)| *addr).collect();
            scores.extend(
                searcher
                    .search(plan.query(true).as_ref(), &collector)?
                    .into_iter()
                    .filter(|(_, addr)| !seen.contains(addr)),
            );
        }
        scores
            .into_iter()
            .map(|(score, addr)| decode_hit(&searcher, addr, score))
            .collect()
    }
}

fn search_pinned(
    searcher: &Searcher,
    index_fields: &Fields,
    text: &str,
    filter: &LexicalFilter<'_>,
    candidate_limit: usize,
    filtered: bool,
) -> Result<Vec<LexicalHit>, LexicalError> {
    if candidate_limit == 0 || (filter.classes == 0 && !filter.include_chats) {
        return Ok(Vec::new());
    }
    let fields = if filter.include_chats {
        &index_fields.bodies[..]
    } else {
        &index_fields.bodies[..3]
    };
    let query = QueryPlan::parse(text, fields, filtered)?;
    if query.browse {
        let collector = TopDocs::with_limit(candidate_limit)
            .order_by((SortByBytes::for_field("note_id_raw"), Order::Asc));
        return collect_filtered(
            searcher,
            query.query(false).as_ref(),
            &collector,
            filter,
            true,
            None,
        )?
        .into_iter()
        .map(|(_, address)| decode_hit(searcher, address, 1.0))
        .collect();
    }
    let collector = TopDocs::with_limit(candidate_limit).order_by_score();
    let mut ranked = collect_filtered(
        searcher,
        query.query(false).as_ref(),
        &collector,
        filter,
        false,
        None,
    )?;
    if ranked.len() < candidate_limit && query.can_fallback() {
        let fallback = collect_filtered(
            searcher,
            query.query(true).as_ref(),
            &collector,
            filter,
            false,
            None,
        )?;
        let seen: std::collections::HashSet<_> = ranked.iter().map(|(_, addr)| *addr).collect();
        ranked.extend(
            fallback
                .into_iter()
                .filter(|(_, addr)| !seen.contains(addr))
                .take(candidate_limit - ranked.len()),
        );
    }
    ranked
        .into_iter()
        .map(|(score, address)| decode_hit(searcher, address, score))
        .collect()
}

fn has_live_posting(segment: &tantivy::SegmentReader, mut postings: impl DocSet) -> bool {
    let mut doc = postings.doc();
    while doc != TERMINATED {
        if !segment.is_deleted(doc) {
            return true;
        }
        doc = postings.advance();
    }
    false
}

fn check_garbage_collection(writer: &tantivy::IndexWriter) -> Result<(), LexicalError> {
    let result = writer.garbage_collect_files().wait()?;
    if !result.failed_to_delete_files.is_empty() {
        return Err(LexicalError::IncompleteCleanup);
    }
    Ok(())
}

impl<'a> LexicalFilter<'a> {
    pub fn new(
        snapshot: &'a dyn StructuralSnapshot,
        folders: Option<Arc<Bitmap>>,
        notes: Option<&'a Bitmap>,
        classes: impl IntoIterator<Item = DocClass>,
        include_chats: bool,
    ) -> Self {
        let classes = classes
            .into_iter()
            .filter(|class| *class != DocClass::EncryptedNote)
            .fold(0, |bits, class| bits | (1 << class_ord(class)));
        Self {
            snapshot,
            folders,
            notes,
            classes,
            include_chats,
            chat_viewer: None,
            excluded: None,
            budget: None,
        }
    }

    pub(crate) fn within(mut self, budget: crate::vector::SearchBudget<'a>) -> Self {
        self.budget = Some(budget);
        self
    }

    pub fn excluding(mut self, notes: &'a BTreeSet<NoteId>) -> Self {
        self.excluded = Some(notes);
        self
    }

    pub fn visible_chats_for(mut self, principal: &'a PrincipalId) -> Self {
        self.chat_viewer = Some(principal);
        self
    }
}

fn decode_hit(
    searcher: &Searcher,
    address: DocAddress,
    score: f32,
) -> Result<LexicalHit, LexicalError> {
    let fields = searcher.segment_reader(address.segment_ord).fast_fields();
    let kind = fields.u64("doc_kind")?.first(address.doc_id);
    let read = |name| -> Result<Vec<u8>, LexicalError> {
        let column = fields.bytes(name)?.ok_or(LexicalError::CorruptIndex)?;
        let ord = column
            .ords()
            .first(address.doc_id)
            .ok_or(LexicalError::CorruptIndex)?;
        let mut bytes = Vec::new();
        if !column.ord_to_bytes(ord, &mut bytes)? {
            return Err(LexicalError::CorruptIndex);
        }
        Ok(bytes)
    };
    let key = match kind {
        Some(NOTE) => {
            let bytes = read("note_id_raw")?;
            let raw = std::str::from_utf8(&bytes).map_err(|_| LexicalError::CorruptIndex)?;
            HitKey::Note(NoteId::parse(raw).map_err(|_| LexicalError::CorruptIndex)?)
        }
        Some(CHAT) => {
            let (thread, entry, kind) =
                decode_chat_locator(&read("chat_locator")?).ok_or(LexicalError::CorruptIndex)?;
            HitKey::Chat {
                thread,
                entry,
                kind,
            }
        }
        _ => return Err(LexicalError::CorruptIndex),
    };
    Ok(LexicalHit { key, score })
}

#[cfg(test)]
mod tests;
