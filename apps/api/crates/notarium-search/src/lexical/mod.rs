//! Per-Space lexical indexing and structurally filtered candidate collection.

mod analysis;
mod collector;
mod pool;
mod query;
mod schema;

pub(crate) use analysis::ChunkRelevance;
pub use analysis::{TOKENIZER_VERSION, extract_note_body};
pub use collector::LexicalFilter;
pub use pool::{ReaderCache, SeedLease, WriterPool};

use self::{
    analysis::{EXACT, Exact, PROSE, Prose},
    collector::{collect_browse, collect_top_scored},
    pool::default_merge_policy,
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
    cmp::Ordering,
    collections::{BTreeSet, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tantivy::{
    DocAddress, DocSet, Index, IndexReader, ReloadPolicy, Searcher, TERMINATED, TantivyDocument,
    Term,
    collector::TopDocs,
    directory::RamDirectory,
    indexer::NoMergePolicy,
    schema::{IndexRecordOption, Schema},
    tokenizer::TokenizerManager,
};

const OVERLAY_WRITER_BUDGET: usize = 256 * 1024;
const MAX_FALLBACK_FLOOR: usize = 10;
const MERGE_RACE_TIMEOUT: Duration = Duration::from_secs(30);

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

/// Separates strict overlay matches from 1-term fallback matches so fallback
/// overlay rows never overtake full matches from the durable corpus.
#[derive(Clone, Debug, Default)]
pub(crate) struct OverlayHits {
    pub strict: Vec<LexicalHit>,
    pub fallback: Vec<LexicalHit>,
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
        let mutations = build_mutations(&self.fields, updates)?;
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

    /// Append one page to an unpublished, empty generation. Hold the returned
    /// `SeedLease` until `commit_seed` completes so the writer stays pinned
    /// between pages and releases automatically if seeding aborts.
    pub fn stage_seed(
        &self,
        pool: &WriterPool,
        updates: &[Update<'_>],
    ) -> Result<SeedLease, LexicalError> {
        if updates.is_empty() {
            return pool.pin_existing_stage(&self.path);
        }
        let mutations = build_mutations(&self.fields, updates)?;
        pool.with_stage_writer(&self.path, &self.index, |writer| {
            for (_, doc) in mutations {
                writer.add_document(doc.ok_or(LexicalError::CorruptIndex)?)?;
            }
            Ok(())
        })
    }

    pub fn commit_seed(&self, pool: &WriterPool) -> Result<(), LexicalError> {
        pool.with_writer(&self.path, &self.index, true, |writer| {
            writer.commit()?;
            self.reader.reload()?;
            Ok(())
        })
    }

    /// Expunge deleted documents one segment at a time so multi-segment corpora
    /// never collapse into one mega-segment, handling races with background
    /// `LogMergePolicy` merges.
    pub fn merge_deleted(&self, pool: &WriterPool) -> Result<(), LexicalError> {
        pool.with_writer(&self.path, &self.index, false, |writer| {
            writer.set_merge_policy(Box::new(NoMergePolicy));
            let result = (|| {
                let deadline = Instant::now() + MERGE_RACE_TIMEOUT;
                let mut attempt = 0_usize;
                loop {
                    let dirty: Vec<_> = self
                        .index
                        .searchable_segment_metas()?
                        .into_iter()
                        .filter(|segment| segment.num_deleted_docs() != 0)
                        .map(|segment| segment.id())
                        .collect();
                    if dirty.is_empty() {
                        break;
                    }
                    if attempt > 0 && Instant::now() >= deadline {
                        return Err(LexicalError::IncompleteCleanup);
                    }
                    attempt += 1;
                    let mut raced = false;
                    for segment_id in dirty {
                        match writer.merge(&[segment_id]).wait() {
                            Ok(_) => {}
                            Err(tantivy::TantivyError::InvalidArgument(_)) => {
                                raced = true;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    if raced {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                self.reader.reload()?;
                Ok(())
            })();
            writer.set_merge_policy(default_merge_policy());
            result
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
        top_k: usize,
        filtered: bool,
    ) -> Result<Vec<LexicalHit>, LexicalError> {
        self.search_pinned(
            &self.reader.searcher(),
            text,
            filter,
            candidate_limit,
            top_k,
            filtered,
        )
    }

    pub fn search_pinned(
        &self,
        searcher: &Searcher,
        text: &str,
        filter: &LexicalFilter<'_>,
        candidate_limit: usize,
        top_k: usize,
        filtered: bool,
    ) -> Result<Vec<LexicalHit>, LexicalError> {
        search_pinned(
            searcher,
            &self.fields,
            text,
            filter,
            candidate_limit,
            top_k,
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
        let plan = QueryPlan::parse(text, &self.fields.bodies[2..], false)?;
        let query: Box<dyn Query> = if cursor.relaxed {
            // The second pass only contributes documents absent from the strict pass.
            Box::new(BooleanQuery::new(vec![
                (Occur::Must, plan.query(true)),
                (Occur::MustNot, plan.query(false)),
            ]))
        } else {
            plan.query(false)
        };
        let mut scores =
            collect_top_scored(searcher, query.as_ref(), filter, limit + 1, cursor.after)?;
        let fallback_floor = limit.min(MAX_FALLBACK_FLOOR);
        let next = if scores.len() > limit {
            scores.truncate(limit);
            Some(ChatCursor {
                relaxed: cursor.relaxed,
                after: scores.last().copied(),
            })
        } else if !cursor.relaxed
            && cursor.after.is_none()
            && scores.len() < fallback_floor
            && plan.can_fallback()
        {
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
    /// Runs outside `WriterPool` using Tantivy's threadless single-segment
    /// writer over `RamDirectory` for exact tokenizer and scoring parity.
    pub(crate) fn rank_overlay(
        text: &str,
        updates: &[Update<'_>],
        filtered: bool,
        budget: crate::vector::SearchBudget<'_>,
    ) -> Result<OverlayHits, LexicalError> {
        if updates.is_empty() {
            return Ok(OverlayHits::default());
        }
        collector::check_budget(Some(budget))?;
        let fields = Fields::new();
        let plan = QueryPlan::parse(text, &fields.bodies[..2], filtered)?;
        if plan.browse {
            let mut strict: Vec<_> = updates
                .iter()
                .map(|update| match update {
                    Update::Note { content, .. } => Ok(LexicalHit {
                        key: HitKey::Note(content.provenance().reference().note_id.clone()),
                        score: 1.0,
                    }),
                    _ => Err(LexicalError::CorruptIndex),
                })
                .collect::<Result<_, _>>()?;
            strict.sort_by(|left, right| match (&left.key, &right.key) {
                (HitKey::Note(a), HitKey::Note(b)) => {
                    a.as_str().as_bytes().cmp(b.as_str().as_bytes())
                }
                _ => Ordering::Equal,
            });
            return Ok(OverlayHits {
                strict,
                fallback: Vec::new(),
            });
        }
        if plan.is_empty() {
            return Ok(OverlayHits::default());
        }
        let tokenizers = TokenizerManager::default();
        tokenizers.register(PROSE, Prose::default());
        tokenizers.register(EXACT, Exact);
        let mut writer = Index::builder()
            .schema(fields.schema.clone())
            .tokenizers(tokenizers)
            .single_segment_index_writer::<TantivyDocument>(
                RamDirectory::create(),
                OVERLAY_WRITER_BUDGET,
            )?;
        for update in updates {
            collector::check_budget(Some(budget))?;
            for (_, document) in build_mutations(&fields, std::slice::from_ref(update))? {
                writer.add_document(document.ok_or(LexicalError::CorruptIndex)?)?;
            }
        }
        collector::check_budget(Some(budget))?;
        let index = writer.finalize()?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let searcher = reader.searcher();
        let size = updates.len();
        let collector = TopDocs::with_limit(size).order_by_score();
        let strict_scores = searcher.search(plan.query(false).as_ref(), &collector)?;
        let fallback_scores = if strict_scores.len() < size && plan.can_fallback() {
            let seen: HashSet<_> = strict_scores.iter().map(|(_, addr)| *addr).collect();
            searcher
                .search(plan.query(true).as_ref(), &collector)?
                .into_iter()
                .filter(|(_, addr)| !seen.contains(addr))
                .collect()
        } else {
            Vec::new()
        };
        let strict = strict_scores
            .into_iter()
            .map(|(score, addr)| decode_hit(&searcher, addr, score))
            .collect::<Result<_, _>>()?;
        let fallback = fallback_scores
            .into_iter()
            .map(|(score, addr)| decode_hit(&searcher, addr, score))
            .collect::<Result<_, _>>()?;
        Ok(OverlayHits { strict, fallback })
    }
}

fn build_mutations(
    fields: &Fields,
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
                    let term = fields.note_term(&content.provenance().reference().note_id);
                    (term, Some(fields.note(content, title, &body, *folder)))
                }
                Update::Chat { hit, folder } => (
                    fields.chat_term(&hit.thread, hit.entry),
                    Some(fields.chat(hit, *folder)),
                ),
                Update::RemoveNote(note) => (fields.note_term(note), None),
                Update::RemoveChat(thread, entry) => (fields.chat_term(thread, *entry), None),
            })
        })
        .collect()
}

fn search_pinned(
    searcher: &Searcher,
    index_fields: &Fields,
    text: &str,
    filter: &LexicalFilter<'_>,
    candidate_limit: usize,
    top_k: usize,
    filtered: bool,
) -> Result<Vec<LexicalHit>, LexicalError> {
    if candidate_limit == 0 || (filter.classes == 0 && !filter.include_chats) {
        return Ok(Vec::new());
    }
    let fields = if filter.include_chats {
        &index_fields.bodies[..]
    } else {
        &index_fields.bodies[..2]
    };
    let query = QueryPlan::parse(text, fields, filtered)?;
    if query.browse {
        return collect_browse(searcher, filter, candidate_limit);
    }
    let mut ranked = collect_top_scored(
        searcher,
        query.query(false).as_ref(),
        filter,
        candidate_limit,
        None,
    )?;
    let fallback_floor = top_k.min(MAX_FALLBACK_FLOOR).min(candidate_limit);
    if ranked.len() < fallback_floor && query.can_fallback() {
        let fallback = collect_top_scored(
            searcher,
            query.query(true).as_ref(),
            filter,
            fallback_floor,
            None,
        )?;
        let seen: HashSet<_> = ranked.iter().map(|(_, addr)| *addr).collect();
        ranked.extend(
            fallback
                .into_iter()
                .filter(|(_, addr)| !seen.contains(addr))
                .take(fallback_floor - ranked.len()),
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
