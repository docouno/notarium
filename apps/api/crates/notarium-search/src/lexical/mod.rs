//! Per-Space lexical indexing and structurally filtered candidate collection.

mod analysis;
mod collector;
mod pool;
mod query;
mod schema;

pub use analysis::{TOKENIZER_VERSION, extract_note_body};
pub use collector::LexicalFilter;
pub use pool::{ReaderCache, WriterPool};

use self::{
    analysis::{EXACT, Exact, PROSE, Prose},
    collector::DocFilterCollector,
    query::QueryPlan,
    schema::{CHAT, Fields, NOTE, class_ord, decode_chat_locator},
};
use crate::layout::FolderOrd;
use croaring::Bitmap;
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    DomainError,
    classes::{DocClass, SearchContent},
    ids::{ChatThreadId, NoteId, ThreadEntrySeq},
    ports::{ChatThreadKind, StructuralSnapshot},
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tantivy::{
    DocAddress, Index, IndexReader, Order, ReloadPolicy, Searcher,
    collector::{TopDocs, sort_key::SortByBytes},
    schema::Schema,
};

#[derive(Debug, thiserror::Error)]
pub enum LexicalError {
    #[error("invalid lexical search input")]
    Domain(#[from] DomainError),
    #[error("lexical index failed")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("lexical index I/O failed")]
    Io(#[from] std::io::Error),
    #[error("invalid lexical index format")]
    CorruptIndex,
    #[error("lexical writer unavailable")]
    WriterUnavailable,
    #[error("lexical reader unavailable")]
    ReaderUnavailable,
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

pub struct LexicalIndex {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    path: PathBuf,
}

impl LexicalIndex {
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

    pub fn apply(&self, pool: &WriterPool, updates: &[Update<'_>]) -> Result<usize, LexicalError> {
        if updates.is_empty() {
            return Ok(0);
        }
        let mut mutations = Vec::with_capacity(updates.len());
        for update in updates {
            let (term, doc) = match update {
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
                Update::RemoveChat(thread, entry) => (self.fields.chat_term(thread, *entry), None),
            };
            mutations.push((term, doc));
        }
        pool.with_writer(&self.path, &self.index, |writer| {
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

    /// Rewrite all active segments and collect obsolete files after a physical purge.
    pub fn compact(&self, pool: &WriterPool) -> Result<(), LexicalError> {
        pool.with_writer(&self.path, &self.index, |writer| {
            let segments = self.index.searchable_segment_ids()?;
            if !segments.is_empty() {
                writer.merge(&segments).wait()?;
            }
            self.reader.reload()?;
            writer.garbage_collect_files().wait()?;
            Ok(())
        })
    }

    pub fn search(
        &self,
        text: &str,
        filter: &LexicalFilter<'_>,
        candidate_limit: usize,
        filtered: bool,
    ) -> Result<Vec<LexicalHit>, LexicalError> {
        if candidate_limit == 0 || (filter.classes == 0 && !filter.include_chats) {
            return Ok(Vec::new());
        }
        let fields = if filter.include_chats {
            &self.fields.bodies[..]
        } else {
            &self.fields.bodies[..3]
        };
        let query = QueryPlan::parse(text, fields, filtered)?;
        let searcher = self.reader.searcher();
        if query.browse {
            let collector = DocFilterCollector {
                inner: TopDocs::with_limit(candidate_limit)
                    .order_by((SortByBytes::for_field("note_id_raw"), Order::Asc)),
                filter,
                browse: true,
            };
            return searcher
                .search(query.query(false).as_ref(), &collector)?
                .into_iter()
                .map(|(_, address)| decode_hit(&searcher, address, 1.0))
                .collect();
        }
        let collector = DocFilterCollector {
            inner: TopDocs::with_limit(candidate_limit).order_by_score(),
            filter,
            browse: false,
        };
        let mut ranked = searcher.search(query.query(false).as_ref(), &collector)?;
        if ranked.len() < candidate_limit && query.can_fallback() {
            let fallback = searcher.search(query.query(true).as_ref(), &collector)?;
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
            .map(|(score, address)| decode_hit(&searcher, address, score))
            .collect()
    }
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
        }
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
