use super::*;
use crate::layout::FolderDictionary;
use notarium_core::{
    DomainResult,
    auth::{ResourceFacts, Space, SpaceKind, SpaceLifecycle},
    classes::{ClassEgressFence, ClassifiedDocument},
    error::ValidationReason,
    ids::{
        ContentDigest, FolderId, HistoryIncarnation, PrincipalId, ProjectionGeneration, RevisionId,
        SpaceId, SpaceSeq,
    },
    model::{DenseNodeId, DenseNodeIter, HistoryScope, Lifecycle, NoteRef, SnapshotCut},
    ports::{Cancellation, PortFuture, ServiceAuthority, ServicePurpose},
    query::FieldFilterAstV1,
};
use std::{
    fs,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy).unwrap();
        let path = std::env::temp_dir().join(format!("search-lexical-{}", hex::encode(entropy)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct Snapshot {
    cut: SnapshotCut,
    notes: Vec<(NoteId, DocClass)>,
    lookups: AtomicUsize,
    cancel_at: Option<(usize, Cancellation)>,
    not_ready: AtomicBool,
    not_ready_on_doc_class: AtomicBool,
    vanished_on_doc_class: BTreeSet<NoteId>,
}
impl Snapshot {
    fn new(notes: impl IntoIterator<Item = NoteId>) -> Self {
        Self::with_classes(notes.into_iter().map(|id| (id, DocClass::UserDoc)))
    }

    pub(crate) fn with_classes(notes: impl IntoIterator<Item = (NoteId, DocClass)>) -> Self {
        Self {
            cut: SnapshotCut {
                scope: HistoryScope {
                    space_id: SpaceId::from_bytes([1; 16]),
                    incarnation: HistoryIncarnation::from_bytes([2; 16]),
                },
                generation: ProjectionGeneration::new(1).unwrap(),
                canonical_seq: SpaceSeq::new(1).unwrap(),
                projected_seq: SpaceSeq::new(1).unwrap(),
            },
            notes: notes.into_iter().collect(),
            lookups: AtomicUsize::new(0),
            cancel_at: None,
            not_ready: AtomicBool::new(false),
            not_ready_on_doc_class: AtomicBool::new(false),
            vanished_on_doc_class: BTreeSet::new(),
        }
    }
}
impl StructuralSnapshot for Snapshot {
    fn cut(&self) -> &SnapshotCut {
        &self.cut
    }
    fn lookup(&self, note: &NoteId) -> DomainResult<Option<DenseNodeId>> {
        if self.not_ready.load(Ordering::Relaxed) {
            return Err(DomainError::validation(ValidationReason::NotReady));
        }
        let previous = self.lookups.fetch_add(1, Ordering::Relaxed);
        if let Some((threshold, signal)) = &self.cancel_at
            && previous == *threshold
        {
            signal.cancel();
        }
        Ok(self
            .notes
            .iter()
            .position(|(id, _)| id == note)
            .map(|index| DenseNodeId::new(self.cut.generation, index as u32)))
    }
    fn note_id(&self, node: DenseNodeId) -> DomainResult<NoteId> {
        if self.not_ready.load(Ordering::Relaxed) {
            return Err(DomainError::validation(ValidationReason::NotReady));
        }
        self.notes
            .get(node.index(self.cut.generation)? as usize)
            .map(|(id, _)| id.clone())
            .ok_or(DomainError::ResourceNotFound)
    }
    fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
        if self.not_ready.load(Ordering::Relaxed)
            || self.not_ready_on_doc_class.load(Ordering::Relaxed)
        {
            return Err(DomainError::validation(ValidationReason::NotReady));
        }
        let (id, class) = self
            .notes
            .get(node.index(self.cut.generation)? as usize)
            .ok_or(DomainError::ResourceNotFound)?;
        if self.vanished_on_doc_class.contains(id) {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(*class)
    }
    fn folder_subtree<'a>(&'a self, _: &'a FolderId) -> PortFuture<'a, DenseNodeIter<'a>> {
        let generation = self.cut.generation;
        let len = self.notes.len() as u32;
        Box::pin(async move { Ok(DenseNodeIter::from_iter(generation, 0..len)) })
    }
    fn folder_descendants<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, Vec<FolderId>> {
        Box::pin(async move { Ok(vec![folder.clone()]) })
    }
    fn enclosing_project<'a>(&'a self, _: &'a FolderId) -> PortFuture<'a, Option<FolderId>> {
        Box::pin(async move { Ok(None) })
    }
    fn filter_notes<'a>(
        &'a self,
        _: &'a FieldFilterAstV1,
    ) -> PortFuture<'a, Option<DenseNodeIter<'a>>> {
        Box::pin(async move { Ok(None) })
    }
    fn outgoing(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        Ok(DenseNodeIter::from_slice(self.cut.generation, &[]))
    }
    fn incoming(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        Ok(DenseNodeIter::from_slice(self.cut.generation, &[]))
    }
}

fn note(source: &str, seed: u8, scope: &HistoryScope) -> SearchContent {
    note_with_id(
        source,
        NoteId::from_bytes([seed; 16]),
        RevisionId::from_bytes([seed; 16]),
        DocClass::UserDoc,
        scope,
    )
}

fn ordinal_note_id(ordinal: u32) -> NoteId {
    let mut bytes = [0u8; 16];
    bytes[12..].copy_from_slice(&ordinal.to_be_bytes());
    NoteId::from_bytes(bytes)
}

fn note_with_class(
    source: &str,
    ordinal: u32,
    class: DocClass,
    scope: &HistoryScope,
) -> SearchContent {
    let mut rev_bytes = [0u8; 16];
    rev_bytes[12..].copy_from_slice(&ordinal.to_be_bytes());
    note_with_id(
        source,
        ordinal_note_id(ordinal),
        RevisionId::from_bytes(rev_bytes),
        class,
        scope,
    )
}

fn note_with_id(
    source: &str,
    note_id: NoteId,
    revision_id: RevisionId,
    class: DocClass,
    scope: &HistoryScope,
) -> SearchContent {
    let content = ClassifiedDocument::from_canonical(
        NoteRef {
            space_id: scope.space_id.clone(),
            note_id,
        },
        revision_id,
        ResourceFacts {
            space: Space {
                id: scope.space_id.clone(),
                kind: SpaceKind::Personal,
                lifecycle: SpaceLifecycle::Active,
            },
            class,
            ancestor_folders: vec![],
            folder_write_locked: false,
            ability_package: None,
        },
        Lifecycle::Active,
        source.to_owned(),
        ContentDigest::from_bytes(*blake3::hash(source.as_bytes()).as_bytes()),
    )
    .unwrap();
    ClassEgressFence::index_for_search(content, &ServiceAuthority::admit(ServicePurpose::Search))
        .unwrap()
}

#[test]
fn lexical_queries_use_morphology_code_and_exact_phrase_positions() {
    let scratch = TestDir::new();
    let snapshot = Snapshot::new([NoteId::from_bytes([1; 16]), NoteId::from_bytes([2; 16])]);
    let index = LexicalIndex::create(&scratch.0).unwrap();
    assert_eq!(TOKENIZER_VERSION, 2);
    assert!(index.schema().get_field("memory_body_prose").is_err());
    assert!(index.schema().get_field("memory_body_exact").is_err());
    for name in ["doc_kind", "doc_class_ord", "parent_folder_ord"] {
        let field = index.schema().get_field(name).unwrap();
        assert!(!index.schema().get_field_entry(field).is_indexed());
    }
    let mut dictionary = FolderDictionary::default();
    let root = dictionary.insert(FolderId::from_bytes([1; 16])).unwrap();
    let source = note(
        "---\ninternal: yamlmarker\n---\n\nРасчётами и running. They searched indexes.\n\nfoo_bar `SearchPort::recall` [linked label](https://example.org) [[some-target|Visible alias]].\n\n    indented_code\n\n```nota\nprivateDslMarker\n```",
        1,
        &snapshot.cut.scope,
    );
    let phrase = note("foo bar and SearchPort Next", 2, &snapshot.cut.scope);
    let pool = WriterPool::default();
    assert_eq!(
        index
            .apply(
                &pool,
                &[
                    Update::Note {
                        content: &source,
                        title: "Source",
                        folder: root
                    },
                    Update::Note {
                        content: &phrase,
                        title: "Phrase",
                        folder: root
                    },
                ]
            )
            .unwrap(),
        2
    );
    assert!(index.schema().fields().all(|(_, field)| !field.is_stored()));
    let allowed = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);
    let only = |text: &str, seed: u8| {
        let hits = index.search(text, &allowed, 20, 20, false).unwrap();
        assert_eq!(hits.len(), 1, "query {text:?}");
        assert_eq!(hits[0].key, HitKey::Note(NoteId::from_bytes([seed; 16])));
    };
    for text in [
        "расчет",
        "runs",
        "SearchPort::recall",
        "SearchIndex",
        "indented_code",
        "\"linked label\"",
        "\"visible alias\"",
    ] {
        only(text, 1);
    }
    only("\"foo bar\"", 2);
    only("\"searchport next\"", 2);
    for text in [
        "yamlmarker",
        "privateDslMarker",
        "\"---\"",
        "\"missing",
        "###",
        "___",
        "@@@",
    ] {
        assert!(
            index
                .search(text, &allowed, 20, 20, false)
                .unwrap()
                .is_empty()
        );
    }
    let browsing = index.search("", &allowed, 20, 20, true).unwrap();
    assert_eq!(browsing[0].key, HitKey::Note(NoteId::from_bytes([1; 16])));
    assert_eq!(browsing[1].key, HitKey::Note(NoteId::from_bytes([2; 16])));

    use tantivy::tokenizer::{TokenStream, Tokenizer};
    let mut exact = super::analysis::Exact;
    let mut terms = exact.token_stream("user@docs.reference/path");
    let mut found = false;
    while terms.advance() {
        found |= terms.token().text == "docs.reference";
    }
    assert!(found);
}

#[test]
fn failed_obsolete_file_deletion_prevents_a_cleanup_certificate() {
    use std::io;
    use tantivy::directory::{
        Directory, FileHandle, RamDirectory, WatchCallback, WatchHandle, WritePtr,
        error::{DeleteError, OpenReadError, OpenWriteError},
    };
    const OBSOLETE: &str = "unused-postings.fixture";

    #[derive(Clone, Debug)]
    struct DirectoryWithFailedDeletion {
        inner: RamDirectory,
        blocked: Arc<AtomicBool>,
    }
    impl Directory for DirectoryWithFailedDeletion {
        fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
            self.inner.get_file_handle(path)
        }
        fn delete(&self, path: &Path) -> Result<(), DeleteError> {
            if path == Path::new(OBSOLETE) && self.blocked.load(Ordering::SeqCst) {
                return Err(DeleteError::IoError {
                    io_error: Arc::new(io::ErrorKind::PermissionDenied.into()),
                    filepath: path.to_owned(),
                });
            }
            self.inner.delete(path)
        }
        fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
            self.inner.exists(path)
        }
        fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
            self.inner.open_write(path)
        }
        fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
            self.inner.atomic_read(path)
        }
        fn atomic_write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            self.inner.atomic_write(path, bytes)
        }
        fn sync_directory(&self) -> io::Result<()> {
            self.inner.sync_directory()
        }
        fn watch(&self, callback: WatchCallback) -> tantivy::Result<WatchHandle> {
            self.inner.watch(callback)
        }
    }

    let blocked = Arc::new(AtomicBool::new(true));
    let directory = DirectoryWithFailedDeletion {
        inner: RamDirectory::create(),
        blocked: blocked.clone(),
    };
    let fields = schema::Fields::new();
    let index = Index::create(directory, fields.schema.clone(), Default::default()).unwrap();
    let lexical = LexicalIndex::from_index(PathBuf::new(), index, fields).unwrap();
    let writers = WriterPool::default();
    let obsolete = Path::new(OBSOLETE);
    lexical
        .index
        .directory()
        .atomic_write(obsolete, b"retired postings")
        .unwrap();
    assert!(matches!(
        lexical.collect_obsolete(&writers),
        Err(LexicalError::IncompleteCleanup)
    ));
    assert!(lexical.index.directory().exists(obsolete).unwrap());
    blocked.store(false, Ordering::SeqCst);
    lexical.collect_obsolete(&writers).unwrap();
    assert!(!lexical.index.directory().exists(obsolete).unwrap());
}

#[test]
fn overlay_ranking_runs_outside_writer_pool_and_separates_fallback() {
    let dirs: Vec<_> = (0..5).map(|_| TestDir::new()).collect();
    let indexes: Vec<_> = dirs
        .iter()
        .map(|dir| LexicalIndex::create(&dir.0).unwrap())
        .collect();
    let pool = WriterPool::default();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
    };
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();
    let strict_doc = note("alpha beta gamma", 2, &scope);
    let partial_doc = note("alpha only", 1, &scope);
    let updates = [
        Update::Note {
            content: &strict_doc,
            title: "Strict",
            folder,
        },
        Update::Note {
            content: &partial_doc,
            title: "Partial",
            folder,
        },
    ];
    let stop = Cancellation::default();
    let budget = crate::vector::SearchBudget {
        cancellation: &stop,
        deadline: Instant::now() + Duration::from_secs(10),
    };

    // Hold all 4 disk WriterPool slots simultaneously.
    fn hold_all_slots(
        pool: &WriterPool,
        indexes: &[LexicalIndex],
        idx: usize,
        body: impl FnOnce(),
    ) {
        if idx == 4 {
            assert_eq!(pool.open_leases().unwrap(), 4);
            assert!(matches!(
                pool.with_writer(&indexes[4].path, &indexes[4].index, false, |_| Ok(())),
                Err(LexicalError::WriterUnavailable)
            ));
            body();
            return;
        }
        pool.with_writer(&indexes[idx].path, &indexes[idx].index, false, |_| {
            hold_all_slots(pool, indexes, idx + 1, body);
            Ok(())
        })
        .unwrap();
    }

    hold_all_slots(&pool, &indexes, 0, || {
        let ranked = LexicalIndex::rank_overlay("alpha beta gamma", &updates, None, false, budget)
            .expect("overlay must not contend with WriterPool");
        assert_eq!(ranked.strict.len(), 1);
        assert_eq!(
            ranked.strict[0].key,
            HitKey::Note(NoteId::from_bytes([2; 16]))
        );
        assert_eq!(ranked.fallback.len(), 1);
        assert_eq!(
            ranked.fallback[0].key,
            HitKey::Note(NoteId::from_bytes([1; 16]))
        );

        let browse = LexicalIndex::rank_overlay("", &updates, None, true, budget).unwrap();
        assert!(browse.fallback.is_empty());
        let first = browse.merge(Vec::new(), Vec::new(), 1, 0, true);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].key, HitKey::Note(NoteId::from_bytes([1; 16])));
        let strict_only = ranked.merge(Vec::new(), Vec::new(), 1, 2, false);
        assert_eq!(strict_only.len(), 1);
        assert_eq!(
            strict_only[0].key,
            HitKey::Note(NoteId::from_bytes([2; 16]))
        );
        assert_eq!(
            browse
                .strict
                .iter()
                .map(|hit| (&hit.key, hit.score))
                .collect::<Vec<_>>(),
            vec![
                (&HitKey::Note(NoteId::from_bytes([1; 16])), 1.0),
                (&HitKey::Note(NoteId::from_bytes([2; 16])), 1.0),
            ]
        );
    });
}

#[test]
fn receipt_and_indexed_candidates_share_the_same_rrf_window() {
    let scratch = TestDir::new();
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let pool = WriterPool::default();
    let snapshot = Snapshot::new((0..=100).map(ordinal_note_id));
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();
    let docs: Vec<_> = (0..=100)
        .map(|i| note_with_class("alpha beta", i, DocClass::UserDoc, &snapshot.cut.scope))
        .collect();
    // Physical document order deliberately conflicts with the note-ID tie break.
    let indexed: Vec<_> = docs[1..]
        .iter()
        .rev()
        .map(|content| Update::Note {
            content,
            title: "",
            folder,
        })
        .collect();
    index.apply(&pool, &indexed).unwrap();
    let receipt = [Update::Note {
        content: &docs[0],
        title: "alpha",
        folder,
    }];
    let base = index.reader.searcher();
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);
    let stop = Cancellation::default();
    let budget = crate::vector::SearchBudget {
        cancellation: &stop,
        deadline: Instant::now() + Duration::from_secs(10),
    };
    let limit = crate::vector::search_candidate_limit(1);
    assert_eq!(limit, 100);
    // Top scoring receipt, tied strict hits, tied fallback hits, and browse.
    let cases = [
        ("alpha", 100),
        ("beta", 100),
        ("beta gamma delta", 1),
        ("", 100),
    ];
    let mut before = Vec::new();
    for (query, expected_len) in cases {
        let browse = query.is_empty();
        let overlay =
            LexicalIndex::rank_overlay(query, &receipt, Some(&base), browse, budget).unwrap();
        let hits = index
            .search_with_overlay(&base, query, &filter, limit, 1, browse, &overlay)
            .unwrap();
        let expected: Vec<_> = (0..expected_len)
            .map(|i| HitKey::Note(ordinal_note_id(i)))
            .collect();
        assert_eq!(
            hits.iter().map(|hit| hit.key.clone()).collect::<Vec<_>>(),
            expected
        );
        before.push(hits);
    }
    // Note 100 ranks 30th in the vector stream. A spurious 101st lexical
    // vote would put it ahead of the winner of either individual stream.
    let vectors = (200..229)
        .chain([100])
        .map(|i| crate::vector::VectorHit {
            score: 1.0,
            metadata: crate::vector::ChunkMetadata {
                note: ordinal_note_id(i),
                key: ContentDigest::from_bytes([1; 32]),
                source: ContentDigest::from_bytes([2; 32]),
                folder: folder.get(),
                class: DocClass::UserDoc,
                tokens: 1,
                context: Vec::new(),
                spans: vec![notarium_core::span::ByteSpan::new(0, 1).unwrap()],
            },
        })
        .collect::<Vec<_>>();
    let winner = |hits| {
        crate::query::ranking::fuse(hits, vectors.clone(), false)[0]
            .note
            .clone()
    };
    assert_eq!(winner(before[0].clone()), ordinal_note_id(0));

    index.apply(&pool, &receipt).unwrap();
    for ((query, _), overlay_hits) in cases.into_iter().zip(before) {
        let indexed_hits = index
            .search(query, &filter, limit, 1, query.is_empty())
            .unwrap();
        assert!(
            overlay_hits
                .iter()
                .map(|hit| &hit.key)
                .eq(indexed_hits.iter().map(|hit| &hit.key))
        );
        if query == "alpha" {
            assert_eq!(winner(indexed_hits), ordinal_note_id(0));
        }
    }
}

#[test]
fn segment_filters_exclude_chats_outside_folders_and_notes_outside_the_snapshot() {
    let scratch = TestDir::new();
    let snapshot = Snapshot::new([NoteId::from_bytes([1; 16]), NoteId::from_bytes([2; 16])]);
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let pool = WriterPool::default();
    let mut dictionary = FolderDictionary::default();
    let root = dictionary.insert(FolderId::from_bytes([1; 16])).unwrap();
    let nested = dictionary.insert(FolderId::from_bytes([2; 16])).unwrap();
    let first = note("rare heading", 1, &snapshot.cut.scope);
    let second = note("rare heading", 2, &snapshot.cut.scope);
    let absent = note("rare heading", 3, &snapshot.cut.scope);
    index
        .apply(
            &pool,
            &[
                Update::Note {
                    content: &first,
                    title: "One",
                    folder: root,
                },
                Update::Note {
                    content: &second,
                    title: "Two",
                    folder: nested,
                },
                Update::Note {
                    content: &absent,
                    title: "rare heading",
                    folder: root,
                },
            ],
        )
        .unwrap();
    let chat = HydratedChatHit {
        thread: ChatThreadId::from_bytes([1; 16]),
        entry: ThreadEntrySeq::new(1).unwrap(),
        kind: ChatThreadKind::SpaceGroup,
        project_folder: None,
        owner: PrincipalId::from_bytes([1; 16]),
        author: PrincipalId::from_bytes([1; 16]),
        text: "rare heading".to_owned(),
    };
    index
        .apply(
            &pool,
            &[Update::Chat {
                hit: &chat,
                folder: None,
            }],
        )
        .unwrap();
    let all = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], true);
    assert_eq!(index.search("rare", &all, 20, 20, false).unwrap().len(), 3);
    let root_only = LexicalFilter::new(
        &snapshot,
        Some(Arc::new(Bitmap::of(&[root.get()]))),
        None,
        [DocClass::UserDoc],
        true,
    );
    let hits = index.search("rare", &root_only, 1, 1, true).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].key, HitKey::Note(NoteId::from_bytes([1; 16])));
    let notes = Bitmap::of(&[1]);
    let nested_seen = LexicalFilter::new(
        &snapshot,
        Some(Arc::new(Bitmap::of(&[root.get(), nested.get()]))),
        Some(&notes),
        [DocClass::UserDoc],
        true,
    );
    assert_eq!(index.apply(&pool, &[]).unwrap(), 0);
    let hits = index.search("rare", &nested_seen, 20, 20, true).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].key, HitKey::Note(NoteId::from_bytes([2; 16])));
    index
        .apply(&pool, &[Update::RemoveChat(&chat.thread, chat.entry)])
        .unwrap();
    index.merge_deleted(&pool).unwrap();
    index.collect_obsolete(&pool).unwrap();
    assert_eq!(index.search("rare", &all, 20, 20, false).unwrap().len(), 2);
}

#[tokio::test]
async fn inactive_writer_is_evicted() {
    let scratch = TestDir::new();
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let pool = WriterPool::default();
    let key = NoteId::from_bytes([1; 16]);
    index.apply(&pool, &[Update::RemoveNote(&key)]).unwrap();
    assert_eq!(pool.open_leases().unwrap(), 1);
    let worker = pool.clone();
    let cancellation = Cancellation::default();
    let cancel = cancellation.clone();
    let task = tokio::spawn(async move { worker.evict_idle_until(cancel).await });
    tokio::time::timeout(Duration::from_secs(7), async {
        while pool.open_leases().unwrap() != 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    task.await.unwrap().unwrap();
    index.apply(&pool, &[Update::RemoveNote(&key)]).unwrap();
    assert_eq!(pool.open_leases().unwrap(), 1);
}

#[test]
fn reader_cache_enforces_its_bound_without_evicting_pinned_generations_or_on_failed_open() {
    let scratch = TestDir::new();
    let cache = ReaderCache::default();
    let path = |number| scratch.0.join(format!("generation-{number}"));
    let mut pinned = Vec::new();
    for number in 0..32 {
        fs::create_dir(path(number)).unwrap();
        pinned.push(cache.create(&path(number)).unwrap());
    }
    assert!(!cache.release(&path(31)).unwrap());
    fs::create_dir(path(32)).unwrap();
    assert!(matches!(
        cache.create(&path(32)),
        Err(LexicalError::ReaderUnavailable)
    ));
    // Unpin the last entry and verify a failing `open` does not evict it.
    let unpinned_ptr = Arc::as_ptr(&pinned.pop().unwrap());
    assert!(cache.open(&scratch.0.join("nonexistent")).is_err());
    let still_cached = cache.open(&path(31)).unwrap();
    assert_eq!(Arc::as_ptr(&still_cached), unpinned_ptr);
    drop(still_cached);

    cache.create(&path(32)).unwrap();
    assert!(cache.release(&path(32)).unwrap());
    assert!(!cache.release(&path(0)).unwrap());
}

#[test]
fn reader_cache_evicts_idle_owners_lru_without_disturbing_busy_owners_or_failed_opens() {
    use super::IdleReaderOwner;
    use std::sync::{Mutex, atomic::AtomicBool};

    struct TestOwner {
        busy: AtomicBool,
        held: Mutex<Option<Arc<LexicalIndex>>>,
        last_activity: Mutex<Instant>,
    }
    impl IdleReaderOwner for TestOwner {
        fn idle_last_activity(&self, path: &Path) -> Option<Instant> {
            if self.busy.load(Ordering::Acquire) {
                return None;
            }
            let slot = self.held.lock().unwrap();
            let index = slot.as_ref()?;
            if index.path() != path || Arc::strong_count(index) > 2 {
                return None;
            }
            Some(*self.last_activity.lock().unwrap())
        }
        fn evict_if_idle(&self, path: &Path) {
            if self.busy.load(Ordering::Acquire) {
                return;
            }
            let mut slot = self.held.lock().unwrap();
            if slot
                .as_ref()
                .is_some_and(|index| index.path() == path && Arc::strong_count(index) <= 2)
            {
                slot.take();
            }
        }
    }

    let scratch = TestDir::new();
    let cache = ReaderCache::default();
    let path = |number| scratch.0.join(format!("owned-{number}"));
    let mut owners = Vec::new();
    let base = Instant::now();
    for number in 0..32 {
        fs::create_dir(path(number)).unwrap();
        let owner = Arc::new(TestOwner {
            busy: AtomicBool::new(true),
            held: Mutex::new(None),
            last_activity: Mutex::new(base),
        });
        let weak = Arc::downgrade(&owner) as std::sync::Weak<dyn IdleReaderOwner>;
        let index = cache.create_owned(&path(number), weak).unwrap();
        *owner.held.lock().unwrap() = Some(index);
        owners.push(owner);
    }

    // All 32 owners are busy: a 33rd creation must fail closed without touching disk.
    fs::create_dir(path(32)).unwrap();
    assert!(matches!(
        cache.create(&path(32)),
        Err(LexicalError::ReaderUnavailable)
    ));

    // Mark owners[0] and owners[1] idle, but make owners[0] more recently active
    // than owners[1]; a failing open must NOT evict either.
    owners[0].busy.store(false, Ordering::Release);
    owners[1].busy.store(false, Ordering::Release);
    *owners[0].last_activity.lock().unwrap() = Instant::now() + Duration::from_secs(10);
    *owners[1].last_activity.lock().unwrap() = base;
    assert!(cache.open(&scratch.0.join("missing")).is_err());
    assert!(
        owners[0].held.lock().unwrap().is_some() && owners[1].held.lock().unwrap().is_some(),
        "failed open must leave idle owners intact"
    );

    // Succeeding 33rd creation evicts the true LRU idle owner (owners[1], not
    // the FIFO-oldest but recently active owners[0]) and admits path(32).
    let admitted = cache.create(&path(32)).unwrap();
    assert!(
        owners[1].held.lock().unwrap().is_none(),
        "least recently active idle owner must be evicted first"
    );
    assert!(
        owners[0].held.lock().unwrap().is_some(),
        "more recently active idle owner must stay cached"
    );
    assert!(
        owners[2..]
            .iter()
            .all(|owner| owner.held.lock().unwrap().is_some()),
        "busy owners must remain untouched"
    );
    // An evicted path must not be returned by get_owned.
    let probe = Arc::downgrade(&owners[1]) as std::sync::Weak<dyn IdleReaderOwner>;
    assert!(cache.get_owned(&path(1), probe).unwrap().is_none());
    drop(admitted);
}

#[test]
fn collectors_prune_lookups_on_broad_queries_and_browse_and_propagate_not_ready() {
    use crate::vector::SearchBudget;
    let scratch = TestDir::new();
    let mut snapshot = Snapshot::new((1..=250).map(ordinal_note_id));
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();
    let documents: Vec<_> = (1..=250)
        .map(|i| {
            note_with_class(
                if i == 173 { "common rare" } else { "common" },
                i,
                DocClass::UserDoc,
                &snapshot.cut.scope,
            )
        })
        .collect();
    let updates: Vec<_> = documents
        .iter()
        .map(|content| Update::Note {
            content,
            title: "",
            folder,
        })
        .collect();
    index.apply(&WriterPool::default(), &updates).unwrap();
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);
    assert_eq!(index.search("rare", &filter, 1, 1, false).unwrap().len(), 1);
    assert_eq!(snapshot.lookups.load(Ordering::Relaxed), 1);

    // Broad query with limit=1 must prune via score before calling `admits_note`.
    snapshot.lookups.store(0, Ordering::Relaxed);
    assert_eq!(
        index.search("common", &filter, 1, 1, false).unwrap().len(),
        1
    );
    assert!(snapshot.lookups.load(Ordering::Relaxed) <= 2);

    // Browse with limit=5 must prune via per-segment `term_ord` without scanning all 250 notes.
    snapshot.lookups.store(0, Ordering::Relaxed);
    let browsed = index.search("", &filter, 5, 5, true).unwrap();
    assert_eq!(browsed.len(), 5);
    assert_eq!(browsed[0].key, HitKey::Note(ordinal_note_id(1)));
    assert_eq!(browsed[4].key, HitKey::Note(ordinal_note_id(5)));
    assert!(snapshot.lookups.load(Ordering::Relaxed) <= 10);

    // Broad query with higher limit still obeys cancellation mid-collection.
    snapshot.lookups.store(0, Ordering::Relaxed);
    let stop = Cancellation::default();
    snapshot.cancel_at = Some((30, stop.clone()));
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false).within(
        SearchBudget {
            cancellation: &stop,
            deadline: Instant::now() + Duration::from_secs(60),
        },
    );
    assert!(matches!(
        index.search("common", &filter, 100, 20, false),
        Err(LexicalError::Stopped)
    ));
    assert!(snapshot.lookups.load(Ordering::Relaxed) < 150);

    // `NotReady` from `Snapshot::lookup` must fail closed instead of dropping hits.
    snapshot.cancel_at = None;
    snapshot.not_ready.store(true, Ordering::Relaxed);
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);
    assert!(matches!(
        index.search("rare", &filter, 10, 10, false),
        Err(LexicalError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::NotReady
    ));
    assert!(matches!(
        index.search("", &filter, 5, 5, true),
        Err(LexicalError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::NotReady
    ));
}

#[test]
fn agent_memory_matches_user_doc_bm25_scores_at_1000_to_10_ratio() {
    let scratch = TestDir::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
    };
    let mut entries = Vec::with_capacity(1_010);
    let mut documents = Vec::with_capacity(1_010);
    for ordinal in 1..=1_000_u32 {
        entries.push((ordinal_note_id(ordinal), DocClass::UserDoc));
        let body = if ordinal <= 5 {
            "sharedbm25target filler word sequence for equal document length parity"
        } else {
            "background user corpus note filler word sequence for realistic average length"
        };
        documents.push(note_with_class(body, ordinal, DocClass::UserDoc, &scope));
    }
    for ordinal in 1_001..=1_010_u32 {
        entries.push((ordinal_note_id(ordinal), DocClass::AgentMemory));
        let body = if ordinal <= 1_005 {
            "sharedbm25target filler word sequence for equal document length parity"
        } else {
            "background agent memory filler word sequence for realistic average length"
        };
        documents.push(note_with_class(
            body,
            ordinal,
            DocClass::AgentMemory,
            &scope,
        ));
    }
    let snapshot = Snapshot::with_classes(entries);
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();
    let updates: Vec<_> = documents
        .iter()
        .map(|content| Update::Note {
            content,
            title: "Uniform",
            folder,
        })
        .collect();
    index.apply(&WriterPool::default(), &updates).unwrap();
    let filter = LexicalFilter::new(
        &snapshot,
        None,
        None,
        [DocClass::UserDoc, DocClass::AgentMemory],
        false,
    );
    let hits = index
        .search("sharedbm25target", &filter, 100, 20, false)
        .unwrap();
    assert_eq!(hits.len(), 10);
    let user_score = hits
        .iter()
        .find(|hit| hit.key == HitKey::Note(ordinal_note_id(1)))
        .expect("UserDoc hit")
        .score;
    let memory_score = hits
        .iter()
        .find(|hit| hit.key == HitKey::Note(ordinal_note_id(1_001)))
        .expect("AgentMemory hit")
        .score;
    assert!(
        (user_score - memory_score).abs() < 1e-5,
        "BM25 scores diverged: user={user_score}, memory={memory_score}"
    );
}

#[test]
fn query_plan_rejects_clause_and_term_explosion_within_4kb_limit() {
    let fields = schema::Fields::new();
    let bodies = &fields.bodies[..2];

    // Alternating letters/digits with >MAX_ATOMS=16 distinct atoms in one token.
    let many_atoms: String = (0..18).map(|i| format!("a{i}")).collect();
    assert!(QueryPlan::parse(&many_atoms, bodies, false).is_err());

    // >64 quoted phrases must be rejected inside the phrase loop.
    let many_phrases = "\"a\"".repeat(65);
    assert!(QueryPlan::parse(&many_phrases, bodies, false).is_err());

    // A single quoted phrase >32 tokens must be rejected.
    let long_phrase = format!(
        "\"{}\"",
        (0..33)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    assert!(QueryPlan::parse(&long_phrase, bodies, false).is_err());

    // Compound tokens staying under MAX_ATOMS=16 and MAX_CLAUSES=64 must still
    // trip MAX_TOTAL_TERMS=512 (20 clauses * 8 atoms * 2 fields * (1+8+8) > 512).
    let many_terms = (0..20)
        .map(|i| format!("aa{i}Bb{}Cc{}Dd{}", i + 100, i + 200, i + 300))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(many_terms.len() < 4096);
    assert!(QueryPlan::parse(&many_terms, bodies, false).is_err());

    // 64 plain single-word clauses over note fields stay within 512 total terms,
    // while 65 trip MAX_CLAUSES=64.
    let sixty_four = (0..64).map(|_| "word").collect::<Vec<_>>().join(" ");
    assert!(QueryPlan::parse(&sixty_four, bodies, false).is_ok());
    let sixty_five = (0..65).map(|_| "word").collect::<Vec<_>>().join(" ");
    assert!(QueryPlan::parse(&sixty_five, bodies, false).is_err());
}

#[test]
fn fallback_floor_caps_one_term_relaxation_without_flooding_candidates() {
    let scratch = TestDir::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
    };
    let mut docs = Vec::new();
    let mut ids = Vec::new();
    for ordinal in 1..=15_u32 {
        ids.push(ordinal_note_id(ordinal));
        docs.push(note_with_class(
            "alpha beta gamma",
            ordinal,
            DocClass::UserDoc,
            &scope,
        ));
    }
    for ordinal in 16..=65_u32 {
        ids.push(ordinal_note_id(ordinal));
        docs.push(note_with_class(
            "alpha only",
            ordinal,
            DocClass::UserDoc,
            &scope,
        ));
    }
    let snapshot = Snapshot::new(ids);
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();
    let updates: Vec<_> = docs
        .iter()
        .map(|content| Update::Note {
            content,
            title: "",
            folder,
        })
        .collect();
    index.apply(&WriterPool::default(), &updates).unwrap();
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);

    // 15 strict hits >= fallback_floor(20.min(10) = 10): no 1-term fallback runs.
    let hits = index
        .search("alpha beta gamma", &filter, 100, 20, false)
        .unwrap();
    assert_eq!(hits.len(), 15);

    // With only 3 strict hits (< fallback_floor = 10), fallback fills up to 10 (not 100).
    let subset: Bitmap = (13..=65).map(|i| i - 1).collect();
    let narrow = LexicalFilter::new(&snapshot, None, Some(&subset), [DocClass::UserDoc], false);
    let relaxed = index
        .search("alpha beta gamma", &narrow, 100, 20, false)
        .unwrap();
    assert_eq!(relaxed.len(), 10);
}

#[test]
fn paged_chat_reconciliation_commits_additions_and_removals_together() {
    let dir = TestDir::new();
    let index = LexicalIndex::create(&dir.0).unwrap();
    let pool = WriterPool::default();
    let thread = ChatThreadId::from_bytes([1; 16]);
    let seq = |value| ThreadEntrySeq::new(value).unwrap();
    let entry = |value| HydratedChatHit {
        thread: thread.clone(),
        entry: seq(value),
        kind: ChatThreadKind::SpaceGroup,
        project_folder: None,
        owner: PrincipalId::from_bytes([1; 16]),
        author: PrincipalId::from_bytes([1; 16]),
        text: format!("message {value}"),
    };
    index
        .apply(
            &pool,
            &[Update::Chat {
                hit: &entry(1),
                folder: None,
            }],
        )
        .unwrap();
    let base = index.searcher();
    let aborted = index
        .stage_seed(
            &pool,
            &[Update::Chat {
                hit: &entry(9),
                folder: None,
            }],
        )
        .unwrap();
    drop(aborted);

    let mut staged = None;
    for n in 2..=4 {
        staged = Some(
            index
                .stage_seed(
                    &pool,
                    &[Update::Chat {
                        hit: &entry(n),
                        folder: None,
                    }],
                )
                .unwrap(),
        );
        assert_eq!(
            index.live_chat_entries(&index.searcher(), &thread).unwrap(),
            [seq(1)].into()
        );
    }
    index
        .commit_updates(&pool, &[Update::RemoveChat(&thread, seq(1))], staged)
        .unwrap();
    assert_eq!(
        index.live_chat_entries(&base, &thread).unwrap(),
        [seq(1)].into()
    );
    assert_eq!(
        index.live_chat_entries(&index.searcher(), &thread).unwrap(),
        [seq(2), seq(3), seq(4)].into()
    );
}

#[test]
fn seed_lease_unpins_and_discards_uncommitted_writer_on_drop() {
    let dirs: Vec<_> = (0..5).map(|_| TestDir::new()).collect();
    let indexes: Vec<_> = dirs
        .iter()
        .map(|dir| LexicalIndex::create(&dir.0).unwrap())
        .collect();
    let pool = WriterPool::default();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
    };
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();
    let doc1 = note("first staged token", 1, &scope);
    let doc2 = note("second staged token", 2, &scope);

    // Stage 4 seeds across all 4 slots so every slot is pinned.
    let mut guards = Vec::new();
    for index in indexes.iter().take(4) {
        let g1 = index
            .stage_seed(
                &pool,
                &[Update::Note {
                    content: &doc1,
                    title: "One",
                    folder,
                }],
            )
            .unwrap();
        // Extending across an empty page keeps the slot pinned even after dropping g1.
        let g2 = index.stage_seed(&pool, &[]).unwrap();
        drop(g1);
        guards.push(g2);
    }
    assert!(matches!(
        indexes[4].apply(
            &pool,
            &[Update::Note {
                content: &doc1,
                title: "Fifth",
                folder,
            }]
        ),
        Err(LexicalError::WriterUnavailable)
    ));

    // Dropping one guard before commit unpins its slot and discards uncommitted docs.
    drop(guards.remove(0));
    assert_eq!(
        indexes[4]
            .apply(
                &pool,
                &[Update::Note {
                    content: &doc1,
                    title: "Fifth",
                    folder,
                }]
            )
            .unwrap(),
        1
    );
    let snapshot = Snapshot::new([NoteId::from_bytes([1; 16]), NoteId::from_bytes([2; 16])]);
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);
    assert!(
        indexes[0]
            .search("staged", &filter, 10, 10, false)
            .unwrap()
            .is_empty()
    );

    // Committing a staged seed persists docs and makes dropping its guard a no-op.
    let g_next = indexes[1]
        .stage_seed(
            &pool,
            &[Update::Note {
                content: &doc2,
                title: "Two",
                folder,
            }],
        )
        .unwrap();
    indexes[1].commit_seed(&pool).unwrap();
    drop(g_next);
    drop(guards);
    assert_eq!(
        indexes[1]
            .search("staged", &filter, 10, 10, false)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn analysis_handles_tight_lists_unclosed_wikilinks_nfc_atoms_and_pure_punctuation() {
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
    };

    // Tight nested lists must not glue parent and child text together.
    let list_doc = note("- parent\n  - child\n- sibling", 1, &scope);
    let extracted = extract_note_body(&list_doc).unwrap();
    assert!(!extracted.contains("parentchild"), "got: {extracted:?}");
    assert!(extracted.contains("parent") && extracted.contains("child"));

    // Unclosed `[[` must not swallow text before a subsequent valid wikilink.
    let link_doc = note(
        "array[[0] and [[some-target|Visible]] plus [[broken\nline]] [[other|Alias]]",
        2,
        &scope,
    );
    let extracted = extract_note_body(&link_doc).unwrap();
    assert!(
        extracted.contains("array[[0] and Visible"),
        "got: {extracted:?}"
    );
    assert!(extracted.contains("Alias"), "got: {extracted:?}");

    // NFC and NFD spellings must produce identical identifier atoms.
    assert_eq!(
        analysis::atoms("cafe\u{0301}Name"),
        analysis::atoms("caf\u{00e9}Name")
    );
    assert_eq!(
        analysis::atoms("cafe\u{0301}Name"),
        BTreeSet::from(["caf\u{00e9}".to_owned(), "name".to_owned()])
    );
    use unicode_normalization::UnicodeNormalization;
    let lowered = analysis::normalize("\u{0130}Ёлка");
    assert_eq!(lowered, lowered.nfc().collect::<String>());

    // Pure punctuation emits zero tokens and does not create phrase position gaps.
    use tantivy::tokenizer::{TokenStream, Tokenizer};
    let mut exact = analysis::Exact;
    for punct in ["###", "___", "@@@", "---"] {
        let mut stream = exact.token_stream(punct);
        assert!(
            !stream.advance(),
            "punctuation {punct:?} should emit no tokens"
        );
    }
    let phrase_tokens = analysis::exact_phrase("foo ### bar");
    assert_eq!(phrase_tokens.len(), 2);
    assert_eq!(phrase_tokens[0].position, 0);
    assert_eq!(phrase_tokens[1].position, 1);

    // Oversized raw spans are ignored without panicking.
    let huge = "a".repeat(2048);
    let mut stream = exact.token_stream(&huge);
    assert!(!stream.advance());
}

#[test]
fn merge_deleted_expunges_dirty_segments_individually_without_collapsing_corpus() {
    let scratch = TestDir::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
    };
    let snapshot = Snapshot::new([
        NoteId::from_bytes([1; 16]),
        NoteId::from_bytes([2; 16]),
        NoteId::from_bytes([3; 16]),
    ]);
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let pool = WriterPool::default();
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();

    let n1 = note("segmentone live", 1, &scope);
    let n2 = note("segmenttwo live", 2, &scope);
    let n3 = note("segmentthree live", 3, &scope);
    let chat1 = HydratedChatHit {
        thread: ChatThreadId::from_bytes([1; 16]),
        entry: ThreadEntrySeq::new(1).unwrap(),
        kind: ChatThreadKind::SpaceGroup,
        project_folder: None,
        owner: PrincipalId::from_bytes([1; 16]),
        author: PrincipalId::from_bytes([1; 16]),
        text: "redactedalpha".to_owned(),
    };
    let chat2 = HydratedChatHit {
        thread: ChatThreadId::from_bytes([1; 16]),
        entry: ThreadEntrySeq::new(2).unwrap(),
        kind: ChatThreadKind::SpaceGroup,
        project_folder: None,
        owner: PrincipalId::from_bytes([1; 16]),
        author: PrincipalId::from_bytes([1; 16]),
        text: "redactedbeta".to_owned(),
    };

    // Three separate commits produce 3 segments (< min_num_segments=4).
    index
        .apply(
            &pool,
            &[
                Update::Note {
                    content: &n1,
                    title: "N1",
                    folder,
                },
                Update::Chat {
                    hit: &chat1,
                    folder: None,
                },
            ],
        )
        .unwrap();
    index
        .apply(
            &pool,
            &[Update::Note {
                content: &n2,
                title: "N2",
                folder,
            }],
        )
        .unwrap();
    index
        .apply(
            &pool,
            &[
                Update::Note {
                    content: &n3,
                    title: "N3",
                    folder,
                },
                Update::Chat {
                    hit: &chat2,
                    folder: None,
                },
            ],
        )
        .unwrap();
    assert_eq!(index.index.searchable_segment_metas().unwrap().len(), 3);

    index
        .apply(
            &pool,
            &[
                Update::RemoveChat(&chat1.thread, chat1.entry),
                Update::RemoveChat(&chat2.thread, chat2.entry),
            ],
        )
        .unwrap();
    index.merge_deleted(&pool).unwrap();
    index.collect_obsolete(&pool).unwrap();

    let metas = index.index.searchable_segment_metas().unwrap();
    assert_eq!(
        metas.len(),
        3,
        "dirty segments must be rewritten individually, not collapsed into 1 mega-segment"
    );
    assert!(metas.iter().all(|meta| meta.num_deleted_docs() == 0));

    let all = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], true);
    assert_eq!(index.search("live", &all, 20, 20, false).unwrap().len(), 3);
    assert!(
        index
            .search("redactedalpha", &all, 20, 20, false)
            .unwrap()
            .is_empty()
    );
    assert!(
        index
            .search("redactedbeta", &all, 20, 20, false)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn admits_note_skips_vanished_doc_class_and_propagates_not_ready() {
    let scratch = TestDir::new();
    let vanished_id = NoteId::from_bytes([1; 16]);
    let live_id = NoteId::from_bytes([2; 16]);
    let mut snapshot = Snapshot::new([vanished_id.clone(), live_id.clone()]);
    snapshot.vanished_on_doc_class.insert(vanished_id);
    let index = LexicalIndex::create(&scratch.0).unwrap();
    let folder = FolderDictionary::default()
        .insert(FolderId::from_bytes([1; 16]))
        .unwrap();
    let vanished_doc = note("concurrent trash target", 1, &snapshot.cut.scope);
    let live_doc = note("concurrent trash target", 2, &snapshot.cut.scope);
    index
        .apply(
            &WriterPool::default(),
            &[
                Update::Note {
                    content: &vanished_doc,
                    title: "Vanished",
                    folder,
                },
                Update::Note {
                    content: &live_doc,
                    title: "Live",
                    folder,
                },
            ],
        )
        .unwrap();

    // `ResourceNotFound` from `doc_class(node)` after a live `lookup(&note)` must skip
    // the vanished note cleanly on both scored search and browse paths.
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);
    let scored = index.search("concurrent", &filter, 10, 10, false).unwrap();
    assert_eq!(scored.len(), 1);
    assert_eq!(scored[0].key, HitKey::Note(live_id.clone()));
    let browsed = index.search("", &filter, 10, 10, true).unwrap();
    assert_eq!(browsed.len(), 1);
    assert_eq!(browsed[0].key, HitKey::Note(live_id));

    // `NotReady` from `doc_class(node)` must still propagate through `LexicalError::Domain`.
    snapshot.vanished_on_doc_class.clear();
    snapshot
        .not_ready_on_doc_class
        .store(true, Ordering::Relaxed);
    let filter = LexicalFilter::new(&snapshot, None, None, [DocClass::UserDoc], false);
    assert!(matches!(
        index.search("concurrent", &filter, 10, 10, false),
        Err(LexicalError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::NotReady
    ));
    assert!(matches!(
        index.search("", &filter, 10, 10, true),
        Err(LexicalError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::NotReady
    ));
}
