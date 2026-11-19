use super::*;
use crate::layout::FolderDictionary;
use notarium_core::{
    DomainResult,
    auth::{ResourceFacts, Space, SpaceKind, SpaceLifecycle},
    classes::{ClassEgressFence, ClassifiedDocument},
    ids::{
        ContentDigest, FolderId, HistoryIncarnation, PrincipalId, ProjectionGeneration, RevisionId,
        SpaceId, SpaceSeq,
    },
    model::{DenseNodeId, DenseNodeIter, HistoryScope, Lifecycle, NoteRef, SnapshotCut},
    ports::{Cancellation, ServiceAuthority, ServicePurpose},
    query::FieldFilterAstV1,
};
use std::{fs, time::Duration};

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

struct Snapshot {
    cut: SnapshotCut,
    notes: Vec<NoteId>,
}
impl Snapshot {
    fn new(notes: impl IntoIterator<Item = NoteId>) -> Self {
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
        }
    }
}
impl StructuralSnapshot for Snapshot {
    fn cut(&self) -> &SnapshotCut {
        &self.cut
    }
    fn lookup(&self, note: &NoteId) -> Option<DenseNodeId> {
        self.notes
            .iter()
            .position(|id| id == note)
            .map(|index| DenseNodeId::new(self.cut.generation, index as u32))
    }
    fn note_id(&self, node: DenseNodeId) -> DomainResult<&NoteId> {
        self.notes
            .get(node.index(self.cut.generation)? as usize)
            .ok_or(DomainError::ResourceNotFound)
    }
    fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
        self.note_id(node)?;
        Ok(DocClass::UserDoc)
    }
    fn folder_subtree(&self, _: &FolderId) -> DomainResult<DenseNodeIter<'_>> {
        Ok(DenseNodeIter::from_iter(
            self.cut.generation,
            0..self.notes.len() as u32,
        ))
    }
    fn folder_descendants(&self, folder: &FolderId) -> DomainResult<Vec<FolderId>> {
        Ok(vec![folder.clone()])
    }
    fn enclosing_project(&self, _: &FolderId) -> DomainResult<Option<FolderId>> {
        Ok(None)
    }
    fn filter_notes(&self, _: &FieldFilterAstV1) -> DomainResult<Option<DenseNodeIter<'_>>> {
        Ok(None)
    }
    fn outgoing(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        Ok(DenseNodeIter::from_slice(self.cut.generation, &[]))
    }
    fn incoming(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        Ok(DenseNodeIter::from_slice(self.cut.generation, &[]))
    }
}

fn note(source: &str, seed: u8, scope: &HistoryScope) -> SearchContent {
    let content = ClassifiedDocument::from_canonical(
        NoteRef {
            space_id: scope.space_id.clone(),
            note_id: NoteId::from_bytes([seed; 16]),
        },
        RevisionId::from_bytes([seed; 16]),
        ResourceFacts {
            space: Space {
                id: scope.space_id.clone(),
                kind: SpaceKind::Personal,
                lifecycle: SpaceLifecycle::Active,
            },
            class: DocClass::UserDoc,
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
        let hits = index.search(text, &allowed, 20, false).unwrap();
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
    for text in ["yamlmarker", "privateDslMarker", "\"---\"", "\"missing"] {
        assert!(index.search(text, &allowed, 20, false).unwrap().is_empty());
    }
    let browsing = index.search("", &allowed, 20, true).unwrap();
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
fn temporary_overlay_writers_share_disk_admission() {
    fn hold_overlay_slots(pool: &WriterPool, remaining: usize) -> Result<(), LexicalError> {
        let index = Index::create_in_ram(schema::Fields::new().schema);
        if remaining == 0 {
            assert_eq!(pool.open_leases()?, 4);
            assert!(matches!(
                pool.with_temporary_writer(&index, |_| Ok(())),
                Err(LexicalError::WriterUnavailable)
            ));
            return Ok(());
        }
        pool.with_temporary_writer(&index, |_| hold_overlay_slots(pool, remaining - 1))
    }
    let scratch = TestDir::new();
    let lexical = LexicalIndex::create(&scratch.0).unwrap();
    let pool = WriterPool::default();
    pool.with_writer(&scratch.0, &lexical.index, false, |_| {
        hold_overlay_slots(&pool, 3)
    })
    .unwrap();
    assert_eq!(pool.open_leases().unwrap(), 1);
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
    assert_eq!(index.search("rare", &all, 20, false).unwrap().len(), 3);
    let root_only = LexicalFilter::new(
        &snapshot,
        Some(Arc::new(Bitmap::of(&[root.get()]))),
        None,
        [DocClass::UserDoc],
        true,
    );
    let hits = index.search("rare", &root_only, 1, true).unwrap();
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
    let hits = index.search("rare", &nested_seen, 20, true).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].key, HitKey::Note(NoteId::from_bytes([2; 16])));
    index
        .apply(&pool, &[Update::RemoveChat(&chat.thread, chat.entry)])
        .unwrap();
    index.compact(&pool).unwrap();
    assert_eq!(index.search("rare", &all, 20, false).unwrap().len(), 2);
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
    tokio::time::timeout(Duration::from_secs(6), async {
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
fn reader_cache_enforces_its_bound_without_evicting_pinned_generations() {
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
    pinned.pop();
    cache.create(&path(32)).unwrap();
    assert!(cache.release(&path(32)).unwrap());
    assert!(!cache.release(&path(0)).unwrap());
}
