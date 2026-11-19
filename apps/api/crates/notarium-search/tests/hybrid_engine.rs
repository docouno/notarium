mod hybrid_support;
#[path = "../../notarium-canonical/tests/support/mod.rs"]
mod storage;

use hybrid_support::{HeldPages, Projection, View, context, mutation};
use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, S3BucketModePolicy,
    blobs::s3::admin_ensure_bucket,
    changes::SyntheticNoteSpec,
    runtime::{CreateFolderSpec, CreateSpaceSpec},
};
use notarium_core::{
    auth::SpaceKind,
    classes::DocClass,
    epoch::{DataRoot, SearchIndexKind},
    error::PortError,
    ids::{ChatThreadId, FolderId, LeaseEpoch, NoteId, SpaceSeq, ThreadEntrySeq},
    model::{HistoryScope, Lifecycle},
    ports::{
        AppendChat, ChatEntryKind, ChatInputBody, ChatPort, ChatRead, ChatThreadKind, CreateChat,
        DeleteDisposition, DeleteNote, MintAndPurge, MoveFolder, NoteWritePort, PageLimit,
        RecallQuery, RedactChatEntry, SearchPort, SearchQuery, ServiceAuthority, ServicePurpose,
    },
    query::{FieldFilterAstV1, Predicate},
    receipt::{AwaitWatermarks, CausalBasis, MutationReceiptToken, ReceiptSet},
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::{SearchLayout, SearchManifest},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::Duration,
};
use storage::{
    StorageTestFixtures, TempDataRoot, sample_folder_id, sample_incarnation,
    sample_installation_id, sample_note_id, sample_principal_id, sample_space_id,
};

const SECRET: &str = "rangedisclosureunique";
const REDACTED: &str = "chatretirementunique";
const ARMOR: &str = "-----BEGIN AGE ENCRYPTED FILE-----\n\
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBURWlGMHlwcXIrYnB2Y3FY\n\
TnlDVkpwTDdPdXdQZFZ3UEw3S1FFYkZET0NjCmhqYWJHWHdTTFE5YzNTNkx3Mmkr\n\
UzJUdTJmaXdRSEhzbGJCTjZCNDFGTEUKLS0tIFd5SnA5Ri85Rk9aaDdnSmRoZXEy\n\
V0lKY3dIZ1ljOE5JVmgzZGR3aHJjTmcK7s9ix86RtDMnTmjU8vkTTLdMW/73vqpS\n\
yPC8DpksHoMx+2Y=\n\
-----END AGE ENCRYPTED FILE-----\n";

fn note(id: &NoteId, parent: &FolderId, title: &str, text: &str) -> SyntheticNoteSpec {
    SyntheticNoteSpec {
        note_id: id.clone(),
        parent_folder: Some(parent.clone()),
        slug: format!("source-{}", id.as_str()),
        title: title.to_owned(),
        doc_class: DocClass::UserDoc,
        lifecycle: Lifecycle::Active,
        carrier: format!("# {title}\n\n{text}\n"),
        fields: BTreeMap::new(),
    }
}

fn query(text: &str) -> SearchQuery {
    SearchQuery {
        text: text.to_owned(),
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::All(vec![]),
        },
        classes: [DocClass::UserDoc].into_iter().collect(),
        folder: None,
        causal: CausalBasis::Exact(ReceiptSet::default()),
        include_chats: false,
        top_k: PageLimit::new(10).unwrap(),
        model: None,
    }
}

async fn acknowledged(
    store: &CanonicalStore,
    root: &DataRoot,
    scope: &HistoryScope,
    seq: SpaceSeq,
) -> SearchManifest {
    let layout = SearchLayout::open(root, scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if store
                .min_consumer_watermark(&scope.space_id, &scope.incarnation)
                .is_some_and(|seen| seen >= seq)
                && let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= seq
            {
                return manifest;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("search did not acknowledge sequence {seq:?}"))
}

fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, entries: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, entries);
            } else if path.is_file()
                && path
                    .file_name()
                    .is_some_and(|name| name != "search_manifest.json")
            {
                entries.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    walk(root, root, &mut result);
    result
}

fn assert_absent(path: &Path, marker: &str) {
    for (file, bytes) in files(path) {
        assert!(
            !bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes()),
            "indexed marker found in {file:?}"
        );
    }
}

async fn run_scenario(store: Arc<CanonicalStore>, root: DataRoot, tag: u8) {
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(1);
    let docs = sample_folder_id(2);
    let archive = sample_folder_id(3);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "hybrid-search-test".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let scope = &space.scope;
    let ctx = context(scope, &owner);
    for (id, slug) in [(&docs, "docs"), (&archive, "archive")] {
        store
            .create_folder(CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: lease,
                folder_id: id.clone(),
                parent: None,
                slug: slug.to_owned(),
                display_name: slug.to_owned(),
                is_project: false,
                project_slug: None,
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let a = sample_note_id(1);
    let b = sample_note_id(2);
    let vault = sample_note_id(3);
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            scope,
            lease,
            &owner,
            vec![
                note(
                    &a,
                    &docs,
                    "Install guide",
                    "A repository setup manual. needle.",
                ),
                note(
                    &b,
                    &folder,
                    "Glossary",
                    "Orbits, satellites, and observatories.",
                ),
                note(&vault, &folder, "Retired carrier", SECRET),
            ],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.folder(docs.clone(), folder.clone());
    view.folder(archive.clone(), folder.clone());
    view.index(a.clone(), docs.clone());
    view.index(b.clone(), folder.clone());
    view.index(vault.clone(), folder.clone());
    view.link(0, 1);
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([a.clone(), b.clone(), vault.clone()])),
    });
    let pages = Arc::new(HeldPages::new(store.clone()));
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.changes = pages.clone();
    let vector_mode = VectorMode::DeterministicTest { dimension: 64 };
    let engine = SearchEngine::start(SearchConfig::new(root.clone(), vector_mode.clone()), deps);
    engine.start_space(scope.clone()).unwrap();
    assert!(
        acknowledged(&store, &root, scope, seeded.last_seq)
            .await
            .active_model
            .is_some()
    );
    let initial = engine.search(ctx.clone(), query("needle")).await.unwrap();
    assert_eq!(initial.hits[0].card.title, "Install guide");
    assert!(initial.hits[0].chunks[0].text().contains("needle"));
    assert!(initial.degraded.is_none());
    let mut rooted = query("needle");
    rooted.folder = Some(folder.clone());
    assert_eq!(
        engine.search(ctx.clone(), rooted).await.unwrap().hits[0]
            .card
            .title,
        "Install guide"
    );

    pages.hold(seeded.last_seq);
    let (first, exact) = store
        .commit_synthetic_note_batch_for_test(
            scope,
            lease,
            &owner,
            vec![note(&a, &docs, "Receipt version", "exactoverlaytoken")],
        )
        .await
        .unwrap();
    let (newer, _) = store
        .commit_synthetic_note_batch_for_test(
            scope,
            lease,
            &owner,
            vec![note(&a, &docs, "Latest version", "laterrevisiontoken")],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();
    let receipt = MutationReceiptToken::new(scope.clone(), first.last_seq).unwrap();
    let mut req = query("exactoverlaytoken");
    req.folder = Some(docs.clone());
    req.causal = CausalBasis::Exact(ReceiptSet::new([receipt.clone()]).unwrap());
    let instant = engine.search(ctx.clone(), req).await.unwrap();
    assert_eq!(instant.hits.len(), 1);
    assert_eq!(instant.hits[0].card.title, "Receipt version");
    assert_eq!(
        instant.hits[0].card.document.provenance().revision(),
        &exact[0].1
    );
    assert!(
        instant.hits[0].chunks[0]
            .text()
            .contains("exactoverlaytoken")
    );
    let mut waiting = query("exactoverlaytoken");
    waiting.causal = CausalBasis::Await(AwaitWatermarks::from_receipts([receipt]));
    let mut short = ctx.clone();
    short.budget.remaining = Duration::from_millis(30);
    assert!(matches!(
        engine.search(short, waiting).await,
        Err(PortError::DeadlineExceeded(_))
    ));
    projection.snapshot.write().unwrap().advance(newer.last_seq);
    pages.release();
    acknowledged(&store, &root, scope, newer.last_seq).await;
    assert_eq!(
        engine
            .search(ctx.clone(), query("laterrevisiontoken"))
            .await
            .unwrap()
            .hits[0]
            .card
            .title,
        "Latest version"
    );

    pages.hold(SpaceSeq::new(newer.last_seq.get() + 100).unwrap());
    let batch: Vec<_> = (0u16..150)
        .map(|ordinal| {
            let id = NoteId::from_bytes(u128::from(ordinal + 500).to_be_bytes());
            note(&id, &folder, "Atomic batch", "batchedworktoken")
        })
        .collect();
    let (range, _) = store
        .commit_synthetic_note_batch_for_test(scope, lease, &owner, batch.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();
    let layout = SearchLayout::open(&root, scope.clone()).unwrap();
    assert_eq!(
        layout.search_manifest().unwrap().unwrap().tantivy_seq,
        newer.last_seq
    );
    {
        let mut snapshot = projection.snapshot.write().unwrap();
        let mut live = projection.live.write().unwrap();
        for item in batch {
            live.insert(item.note_id.clone());
            snapshot.index(item.note_id, folder.clone());
        }
        snapshot.advance(range.last_seq);
    }
    pages.release();
    let before_move = acknowledged(&store, &root, scope, range.last_seq).await;
    let tantivy = root.search(&scope.space_id, SearchIndexKind::Tantivy);
    let vectors = root.search(&scope.space_id, SearchIndexKind::Vector);
    let old_vectors = files(&vectors);
    let moved = store
        .move_folder(
            ctx.clone(),
            mutation(
                &ctx,
                MoveFolder {
                    folder: docs.clone(),
                    new_parent: Some(archive.clone()),
                },
            ),
        )
        .await
        .unwrap();
    projection
        .snapshot
        .write()
        .unwrap()
        .folder(docs.clone(), archive.clone());
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(moved.receipt.seq());
    let after_move = acknowledged(&store, &root, scope, moved.receipt.seq()).await;
    assert_eq!(before_move.tantivy_commit, after_move.tantivy_commit);
    assert_eq!(old_vectors, files(&vectors));
    let mut scoped = query("laterrevisiontoken");
    scoped.folder = Some(archive.clone());
    let contained = engine.search(ctx.clone(), scoped).await.unwrap();
    assert_eq!(contained.hits.len(), 1);
    assert_eq!(contained.hits[0].card.title, "Latest version");

    // Hold the log reader long enough to overflow the real broadcast queue.
    // Durable folder commands require only a watermark advance.
    let mut high = moved.receipt.seq();
    pages.hold(high);
    high = high.checked_next().unwrap();
    store
        .fast_forward_space_to_seq_for_test(scope, lease, high)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();
    for _ in 0..1025 {
        high = high.checked_next().unwrap();
        store
            .fast_forward_space_to_seq_for_test(scope, lease, high)
            .await
            .unwrap();
    }
    projection.snapshot.write().unwrap().advance(high);
    pages.release();
    let after_lag = acknowledged(&store, &root, scope, high).await;
    assert!(pages.lagged.load(std::sync::atomic::Ordering::SeqCst) > 0);
    assert_eq!(after_lag.tantivy_commit, after_move.tantivy_commit);
    assert_eq!(old_vectors, files(&vectors));

    let thread = ChatThreadId::from_bytes([tag; 16]);
    store
        .create_chat(
            ctx.clone(),
            mutation(
                &ctx,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Search chat".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let appended = store
        .append_chat(
            ctx.clone(),
            mutation(
                &ctx,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text(REDACTED.to_owned()),
                    referenced_notes: vec![],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(appended.receipt.seq());
    acknowledged(&store, &root, scope, appended.receipt.seq()).await;
    let mut chat = query(REDACTED);
    chat.include_chats = true;
    assert_eq!(
        engine
            .search(ctx.clone(), chat.clone())
            .await
            .unwrap()
            .chat_hits[0]
            .snippet,
        REDACTED
    );
    let old_thread = store
        .read_chat(
            ctx.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: appended.value.seq,
                before: None,
                max_entries: PageLimit::new(8).unwrap(),
            },
        )
        .await
        .unwrap()
        .thread;
    let redacted = store
        .redact_chat_entry(
            ctx.clone(),
            mutation(
                &ctx,
                RedactChatEntry {
                    thread,
                    entry: appended.value.seq,
                    expected_thread_revision: old_thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(redacted.receipt.seq());
    acknowledged(&store, &root, scope, redacted.receipt.seq()).await;
    assert!(
        engine
            .search(ctx.clone(), chat)
            .await
            .unwrap()
            .chat_hits
            .is_empty()
    );
    assert_absent(&tantivy, REDACTED);

    let authority = ServiceAuthority::admit(ServicePurpose::Search);
    let previous = store
        .read_note_documents_at_cutoff(
            &authority,
            ctx.budget.clone(),
            scope.clone(),
            redacted.receipt.seq(),
            vec![vault.clone()],
        )
        .await
        .unwrap();
    let expected_revision = previous[0].1.as_ref().unwrap().document.revision().clone();
    let marker = format!(
        "---\nclass: encrypted-note\ntitle: Encrypted replacement\n---\n# Cipherfenceonly\n\n```age\n{ARMOR}```\n"
    );
    engine.shutdown().await;
    let minted = store
        .mint_and_purge(
            ctx.clone(),
            mutation(
                &ctx,
                MintAndPurge {
                    old_note: vault.clone(),
                    expected_revision,
                    new_note: sample_note_id(4),
                    new_slug: None,
                    encrypted_carrier: marker,
                },
            ),
        )
        .await
        .unwrap();
    projection.live.write().unwrap().remove(&vault);
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(minted.receipt.seq());

    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), vector_mode),
        SearchDependencies::new(store.clone(), projection.clone()),
    );
    engine.start_space(scope.clone()).unwrap();
    acknowledged(&store, &root, scope, minted.receipt.seq()).await;
    assert_absent(&tantivy, SECRET);
    assert_absent(&tantivy, "cipherfenceonly");
    assert_absent(&vectors, SECRET);
    let mut literal = query(SECRET);
    literal.classes = [DocClass::EncryptedNote].into_iter().collect();
    assert!(
        engine
            .search(ctx.clone(), literal)
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    engine.shutdown().await;

    let engine = SearchEngine::start(
        SearchConfig::new(root, VectorMode::Disabled),
        SearchDependencies::new(store, projection),
    );
    let rec = engine
        .recall(
            ctx.clone(),
            RecallQuery {
                query: query("laterrevisiontoken"),
                graph_depth: 1,
                token_budget: 64,
            },
        )
        .await
        .unwrap();
    assert_eq!(rec.hits[0].card.title, "Latest version");
    assert!(rec.hits.iter().any(|hit| hit.card.title == "Glossary"));
    assert!(
        rec.hits
            .iter()
            .flat_map(|hit| &hit.chunks)
            .map(|part| part.part().tokens())
            .sum::<u32>()
            <= 64
    );
    assert!(rec.degraded.is_none());
    let exhausted = engine
        .recall(
            ctx,
            RecallQuery {
                query: query("laterrevisiontoken"),
                graph_depth: 1,
                token_budget: 1,
            },
        )
        .await
        .unwrap();
    assert!(exhausted.hits.is_empty() && exhausted.truncated);
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_hybrid_seed_causal_boundaries_and_scrub() {
    let data = TempDataRoot::new("search-sqlite");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0x42),
        data.data_root(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    run_scenario(store.clone(), data.data_root(), 0x42).await;
    hybrid_support::remote::lexical_fallback(store.clone(), data.data_root()).await;
    purge_and_rebind(store, data.data_root()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_hybrid_seed_causal_boundaries_and_scrub() {
    let data = TempDataRoot::new("search-pg");
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("search-hybrid");
    let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let config = fixtures.pg_s3_config(sample_installation_id(0x43), &schema, s3);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let store = Arc::new(store);
    run_scenario(store.clone(), data.data_root(), 0x43).await;
    hybrid_support::remote::lexical_fallback(store.clone(), data.data_root()).await;
    purge_and_rebind(store, data.data_root()).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

async fn purge_and_rebind(store: Arc<CanonicalStore>, root: DataRoot) {
    let owner = sample_principal_id(0x62);
    let folder = sample_folder_id(0x62);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x62),
            incarnation: sample_incarnation(0x62),
            root_folder_id: folder.clone(),
            slug: "indexed-history".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let old = sample_note_id(0x62);
    let ctx = context(&space.scope, &owner);
    let (cut, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![note(
                &old,
                &folder,
                "Old incarnation",
                "oldincarnationsecret",
            )],
        )
        .await
        .unwrap();
    let mut view = View::new(space.scope.clone(), folder.clone());
    view.index(old.clone(), folder.clone());
    view.advance(cut.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([old.clone()])),
    });
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projection.clone()),
    );
    engine.start_space(space.scope.clone()).unwrap();
    acknowledged(&store, &root, &space.scope, cut.last_seq).await;
    assert_eq!(
        engine
            .search(ctx.clone(), query("oldincarnationsecret"))
            .await
            .unwrap()
            .hits
            .len(),
        1
    );
    let mut request = mutation(
        &ctx,
        DeleteNote {
            note: old.clone(),
            disposition: DeleteDisposition::Purge,
        },
    );
    request.preconditions.revision = Some(revisions[0].1.clone());
    let purged = store.delete_note(ctx.clone(), request).await.unwrap();
    projection.live.write().unwrap().remove(&old);
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(purged.receipt.seq());
    acknowledged(&store, &root, &space.scope, purged.receipt.seq()).await;
    let tantivy = root.search(&space.scope.space_id, SearchIndexKind::Tantivy);
    assert_absent(&tantivy, "oldincarnationsecret");
    assert!(
        engine
            .search(ctx.clone(), query("oldincarnationsecret"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );

    let scope = store
        .rotate_incarnation_for_test(&space.scope, sample_incarnation(0x63))
        .await
        .unwrap();
    let fresh = sample_note_id(0x63);
    let (restored, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(
                &fresh,
                &folder,
                "Restored history",
                "freshincarnationtoken",
            )],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.index(fresh.clone(), folder);
    view.advance(restored.last_seq);
    *projection.snapshot.write().unwrap() = view;
    projection.live.write().unwrap().insert(fresh);
    acknowledged(&store, &root, &scope, restored.last_seq).await;
    assert!(
        engine
            .search(ctx, query("freshincarnationtoken"))
            .await
            .is_err()
    );
    let hits = engine
        .search(context(&scope, &owner), query("freshincarnationtoken"))
        .await
        .unwrap();
    assert_eq!(hits.cut.scope, scope);
    assert_eq!(hits.hits[0].card.title, "Restored history");
    engine.shutdown().await;
}
