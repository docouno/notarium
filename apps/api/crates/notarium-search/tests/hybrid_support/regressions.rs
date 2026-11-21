use super::{
    ControlledCarriers, HeldPages, Projection, View, context, mutation,
    remote::{ModelProvider, SwitchingResolver},
};
use crate::{
    REDACTED, acknowledged, assert_absent, note, query,
    storage::{
        sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
    },
};
use notarium_canonical::{CanonicalStore, CreateFolderSpec, CreateSpaceSpec};
use notarium_core::{
    auth::SpaceKind,
    epoch::{DataRoot, SearchIndexKind},
    ids::{ChatThreadId, LeaseEpoch, SpaceSeq, ThreadEntrySeq},
    model::Lifecycle,
    ports::{
        AppendChat, ChatEntryKind, ChatInputBody, ChatPort, ChatRead, ChatThreadKind, CreateChat,
        DeleteDisposition, DeleteNote, NoteWritePort, PageLimit, RedactChatEntry, SearchPort,
        ServiceAuthority, ServicePurpose, StructuralSnapshot,
    },
    receipt::{AwaitWatermarks, CausalBasis, MutationReceiptToken, ReceiptSet},
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::SearchLayout,
    ports::SearchDocumentTarget,
};
use std::{
    collections::BTreeSet,
    fs,
    sync::{Arc, RwLock, atomic::Ordering},
    time::Duration,
};

pub async fn run_all(store: Arc<CanonicalStore>, root: DataRoot) {
    trashed_folder_hidden_in_overlay_and_authorized_documents(store.clone(), root.clone()).await;
    exact_overlay_zero_grace_and_concurrent_align_convergence(store.clone(), root.clone()).await;
    redaction_incomplete_cleanup_during_model_refresh_blocks_ack(store.clone(), root.clone()).await;
    purge_resync_during_embedding_repair_recovers_cleanly(store.clone(), root.clone()).await;
    trash_and_restore_during_seed_recovers_cleanly(store.clone(), root.clone()).await;
    stray_files_and_orphan_tmps_do_not_break_reopen_or_scrub(store, root).await;
}

async fn trashed_folder_hidden_in_overlay_and_authorized_documents(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xe1;
    let owner = sample_principal_id(tag);
    let root_folder = sample_folder_id(tag);
    let nested = sample_folder_id(tag + 1);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: root_folder.clone(),
            slug: "reg-trashed-folder".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let (_, folder_rev, _) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: lease,
            folder_id: nested.clone(),
            parent: Some(root_folder.clone()),
            slug: "hidden-branch".into(),
            display_name: "Hidden branch".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let hidden = sample_note_id(tag);
    let (written, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(&hidden, &nested, "Hidden note", "trashedfoldermarker")],
        )
        .await
        .unwrap();
    let revision = revisions[0].1.clone();
    let (_, trash_seq) = store
        .set_folder_lifecycle(
            &scope,
            lease,
            &nested,
            &folder_rev,
            Lifecycle::Trashed,
            &owner,
            None,
        )
        .await
        .unwrap();

    let ctx = context(&scope, &owner);
    let authority = ServiceAuthority::admit(ServicePurpose::Search);
    let overlay_rows = store
        .read_note_revisions_for_overlay(
            &authority,
            ctx.clone(),
            trash_seq,
            vec![(hidden.clone(), revision.clone())],
        )
        .await
        .unwrap();
    assert_eq!(overlay_rows.len(), 1);
    assert!(
        overlay_rows[0].1.is_none(),
        "trashed ancestor folder must hide note in read_note_revisions_for_overlay"
    );

    let auth_docs = store
        .read_authorized_documents_for_search(
            ctx.clone(),
            vec![SearchDocumentTarget {
                note_id: hidden.clone(),
                revision,
                projected_at: None,
            }],
        )
        .await
        .unwrap();
    assert_eq!(auth_docs.len(), 1);
    assert!(
        auth_docs[0].is_none(),
        "trashed ancestor folder must hide note in read_authorized_documents_for_search"
    );

    let mut view = View::new(scope.clone(), root_folder.clone());
    view.folder(nested.clone(), root_folder);
    view.index(hidden.clone(), nested);
    view.advance(trash_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([hidden])),
    });
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projection),
    );
    engine.start_space(scope.clone()).unwrap();
    acknowledged(&store, &root, &scope, trash_seq).await;
    assert!(
        engine
            .search(ctx.clone(), query("trashedfoldermarker"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    let mut exact = query("trashedfoldermarker");
    exact.causal = CausalBasis::Exact(
        ReceiptSet::new([MutationReceiptToken::new(scope, written.last_seq).unwrap()]).unwrap(),
    );
    assert!(engine.search(ctx, exact).await.unwrap().hits.is_empty());
    engine.shutdown().await;
}

async fn exact_overlay_zero_grace_and_concurrent_align_convergence(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xe3;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "reg-exact-align".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let seed_id = sample_note_id(tag);
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(&seed_id, &folder, "Base note", "alignbasetoken")],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.index(seed_id.clone(), folder.clone());
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([seed_id.clone()])),
    });
    let pages = Arc::new(HeldPages::new(store.clone()));
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.changes = pages.clone();
    let engine = Arc::new(SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::Disabled),
        deps,
    ));
    engine.start_space(scope.clone()).unwrap();
    acknowledged(&store, &root, &scope, seeded.last_seq).await;

    // Hold catch-up so indexed == projected < required; Exact must hit overlay
    // immediately without waiting on the causal grace timer.
    pages.hold(seeded.last_seq);
    let fresh_id = sample_note_id(tag + 1);
    let (fresh, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(&fresh_id, &folder, "Fresh note", "fastoverlaytoken")],
        )
        .await
        .unwrap();
    projection.live.write().unwrap().insert(fresh_id.clone());
    let ctx = context(&scope, &owner);
    let mut exact = query("fastoverlaytoken");
    exact.causal = CausalBasis::Exact(
        ReceiptSet::new([MutationReceiptToken::new(scope.clone(), fresh.last_seq).unwrap()])
            .unwrap(),
    );
    let started = std::time::Instant::now();
    let res = engine.search(ctx.clone(), exact).await.unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "exact receipt overlay unexpectedly stalled: {:?}",
        started.elapsed()
    );
    assert_eq!(res.hits.len(), 1);
    assert_eq!(
        res.hits[0].card.document.provenance().reference().note_id,
        fresh_id
    );

    // Release catch-up and exercise concurrent writes alongside parallel reads
    // to verify align converges without DeadlineExceeded.
    {
        let mut snap = projection.snapshot.write().unwrap();
        snap.index(fresh_id, folder.clone());
        snap.advance(fresh.last_seq);
    }
    pages.release();
    acknowledged(&store, &root, &scope, fresh.last_seq).await;

    let writer_store = store.clone();
    let writer_scope = scope.clone();
    let writer_folder = folder.clone();
    let writer_owner = owner.clone();
    let writer_proj = projection.clone();
    let writer = tokio::spawn(async move {
        for idx in 0u8..20 {
            let (range, _) = writer_store
                .commit_synthetic_note_batch_for_test(
                    &writer_scope,
                    lease,
                    &writer_owner,
                    vec![note(
                        &seed_id,
                        &writer_folder,
                        "Base note",
                        &format!("alignbasetoken iteration {idx}"),
                    )],
                )
                .await
                .unwrap();
            writer_proj
                .snapshot
                .write()
                .unwrap()
                .advance(range.last_seq);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
    for _ in 0..20 {
        let current_seq = projection.snapshot.read().unwrap().cut().projected_seq;
        let mut await_req = query("alignbasetoken");
        await_req.causal =
            CausalBasis::Await(AwaitWatermarks::from_receipts([MutationReceiptToken::new(
                scope.clone(),
                current_seq,
            )
            .unwrap()]));
        let res = engine
            .search(ctx.clone(), await_req)
            .await
            .expect("align must converge under concurrent writes without DeadlineExceeded");
        assert!(!res.hits.is_empty());
    }
    writer.await.unwrap();

    // Arc<SearchEngine>::shutdown(&self) must complete even with live clones.
    let _held_clone = Arc::clone(&engine);
    engine.shutdown().await;
}

async fn redaction_incomplete_cleanup_during_model_refresh_blocks_ack(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xe5;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "reg-redact-refresh".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let ctx = context(&scope, &owner);
    let note_id = sample_note_id(tag);
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(
                &note_id,
                &folder,
                "Pinned reader note",
                "pinreaderterm",
            )],
        )
        .await
        .unwrap();
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
                    title: "Redaction during refresh".into(),
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
                    body: ChatInputBody::Text(REDACTED.into()),
                    referenced_notes: vec![],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    let expected_thread_revision = store
        .read_chat(
            ctx.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: appended.value.seq,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap()
        .thread
        .revision;

    let mut view = View::new(scope.clone(), folder.clone());
    view.index(note_id.clone(), folder);
    view.advance(appended.receipt.seq());
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([note_id])),
    });
    let resolver = Arc::new(SwitchingResolver::new(5, 512));
    let provider = Arc::new(ModelProvider::default());
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.model_resolver = Some(resolver.clone());
    deps.providers = Some(provider.clone());
    deps.carriers = carriers.clone();
    let engine = Arc::new(SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    ));
    engine.start_space(scope.clone()).unwrap();
    let initial = acknowledged(&store, &root, &scope, appended.receipt.seq()).await;
    assert_eq!(initial.vector_seq, Some(appended.receipt.seq()));
    assert!(!initial.embeddings_pending);
    assert!(seeded.last_seq < appended.receipt.seq());

    // Begin a ModelRefresh and hold it mid-provider call.
    provider.block_next_part.store(true, Ordering::SeqCst);
    resolver.provider.store(6, Ordering::SeqCst);
    let _ = engine
        .search(ctx.clone(), query("pinreaderterm"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), provider.part_started.notified())
        .await
        .unwrap();

    // Pin the active Tantivy reader inside a held query so cleanup cannot
    // remove the redacted generation while ModelRefresh reconciles changes.
    carriers.hold_note_reads.store(true, Ordering::SeqCst);
    let held_engine = engine.clone();
    let mut held_ctx = ctx.clone();
    held_ctx.budget.remaining = Duration::from_secs(30);
    let pinned_reader = tokio::spawn(async move {
        let _ = held_engine.search(held_ctx, query("pinreaderterm")).await;
    });
    tokio::time::timeout(Duration::from_secs(5), carriers.note_read_held.notified())
        .await
        .unwrap();

    let redacted = store
        .redact_chat_entry(
            ctx.clone(),
            mutation(
                &ctx,
                RedactChatEntry {
                    thread,
                    entry: appended.value.seq,
                    expected_thread_revision,
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
    provider.release_part.notify_one();

    // Give the worker time to process the redaction event while the old reader
    // remains pinned; IncompleteCleanup must NOT be swallowed or acked.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        store
            .min_consumer_watermark(&scope.space_id, &scope.incarnation)
            .is_none_or(|seq| seq < redacted.receipt.seq()),
        "redaction watermark advanced while obsolete Tantivy reader remained pinned"
    );

    pinned_reader.abort();
    let _ = pinned_reader.await;
    carriers.hold_note_reads.store(false, Ordering::SeqCst);
    acknowledged(&store, &root, &scope, redacted.receipt.seq()).await;
    assert_absent(
        &root.search(&scope.space_id, SearchIndexKind::Tantivy),
        REDACTED,
    );
    engine.shutdown().await;
}

async fn purge_resync_during_embedding_repair_recovers_cleanly(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xe7;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "reg-purge-repair".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let victim = sample_note_id(tag);
    let survivor = sample_note_id(tag + 1);
    let (seeded, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![
                note(&victim, &folder, "Victim", "purgedrepairsecret"),
                note(&survivor, &folder, "Survivor", "survivingrepairtoken"),
            ],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.index(victim.clone(), folder.clone());
    view.index(survivor.clone(), folder);
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([victim.clone(), survivor.clone()])),
    });
    let resolver = Arc::new(SwitchingResolver::new(5, 512));
    let provider = Arc::new(ModelProvider::default());
    provider.fail_indexing.store(true, Ordering::SeqCst);
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.model_resolver = Some(resolver);
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    engine.start_space(scope.clone()).unwrap();
    let pending = acknowledged(&store, &root, &scope, seeded.last_seq).await;
    assert!(pending.embeddings_pending);

    // Let repair start and hold it mid-provider call while purging victim.
    provider.block_next_part.store(true, Ordering::SeqCst);
    provider.fail_indexing.store(false, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(10), provider.part_started.notified())
        .await
        .unwrap();

    let ctx = context(&scope, &owner);
    let mut purge_req = mutation(
        &ctx,
        DeleteNote {
            note: victim.clone(),
            disposition: DeleteDisposition::Purge,
        },
    );
    purge_req.preconditions.revision = Some(revisions[0].1.clone());
    let purged = store.delete_note(ctx.clone(), purge_req).await.unwrap();
    projection.live.write().unwrap().remove(&victim);
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(purged.receipt.seq());
    provider.release_part.notify_one();

    acknowledged(&store, &root, &scope, purged.receipt.seq()).await;
    let layout = SearchLayout::open(&root, scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= purged.receipt.seq()
                && manifest.vector_seq.is_some()
                && !manifest.embeddings_pending
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("repair must recover from PurgeResync without InvalidCutoff stall");

    assert_absent(
        &root.search(&scope.space_id, SearchIndexKind::Tantivy),
        "purgedrepairsecret",
    );
    let res = engine
        .search(ctx, query("survivingrepairtoken"))
        .await
        .unwrap();
    assert_eq!(res.hits.len(), 1);
    assert_eq!(
        res.hits[0].card.document.provenance().reference().note_id,
        survivor
    );
    engine.shutdown().await;
}

async fn trash_and_restore_during_seed_recovers_cleanly(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xe9;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "reg-trash-restore".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let note_id = sample_note_id(tag);
    let (seeded, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(
                &note_id,
                &folder,
                "Flapping note",
                "trashrestoretoken",
            )],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.index(note_id.clone(), folder);
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([note_id.clone()])),
    });
    let resolver = Arc::new(SwitchingResolver::new(5, 512));
    let provider = Arc::new(ModelProvider::default());
    provider.block_next_part.store(true, Ordering::SeqCst);
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.model_resolver = Some(resolver);
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    engine.start_space(scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), provider.part_started.notified())
        .await
        .unwrap();

    // Trash and immediately restore the note while vector seeding is in flight.
    let ctx = context(&scope, &owner);
    let mut trash_req = mutation(
        &ctx,
        DeleteNote {
            note: note_id.clone(),
            disposition: DeleteDisposition::Trash,
        },
    );
    trash_req.preconditions.revision = Some(revisions[0].1.clone());
    let trashed = store.delete_note(ctx.clone(), trash_req).await.unwrap();
    let mut restore_req = mutation(
        &ctx,
        DeleteNote {
            note: note_id.clone(),
            disposition: DeleteDisposition::Restore,
        },
    );
    restore_req.preconditions.revision = Some(trashed.value.revision);
    let restored = store.delete_note(ctx.clone(), restore_req).await.unwrap();
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(restored.receipt.seq());
    provider.release_part.notify_one();

    acknowledged(&store, &root, &scope, restored.receipt.seq()).await;
    let layout = SearchLayout::open(&root, scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= restored.receipt.seq()
                && manifest.vector_seq.is_some()
                && !manifest.embeddings_pending
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Trash -> Restore during seed must converge without Inconsistent failure");

    let hits = engine
        .search(ctx, query("trashrestoretoken"))
        .await
        .unwrap()
        .hits;
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0].card.document.provenance().reference().note_id,
        note_id
    );
    engine.shutdown().await;
}

async fn stray_files_and_orphan_tmps_do_not_break_reopen_or_scrub(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xeb;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "reg-stray-files".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let note_id = sample_note_id(tag);
    let (seeded, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(&note_id, &folder, "Stray tolerance", "strayfiletoken")],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.index(note_id.clone(), folder);
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([note_id.clone()])),
    });
    let start = || {
        SearchEngine::start(
            SearchConfig::new(
                root.clone(),
                VectorMode::DeterministicTest { dimension: 64 },
            ),
            SearchDependencies::new(store.clone(), projection.clone()),
        )
    };
    let engine = start();
    engine.start_space(scope.clone()).unwrap();
    let initial = acknowledged(&store, &root, &scope, seeded.last_seq).await;
    assert_eq!(initial.vector_seq, Some(seeded.last_seq));
    assert!(!initial.embeddings_pending);
    engine.shutdown().await;

    // Plant non-symlink stray files (.DS_Store and orphan *.tmp) in tantivy/
    // and vector/ directories before reopening.
    let tantivy_dir = root.search(&scope.space_id, SearchIndexKind::Tantivy);
    let vector_dir = root.search(&scope.space_id, SearchIndexKind::Vector);
    fs::write(tantivy_dir.join(".DS_Store"), b"finder metadata").unwrap();
    fs::write(tantivy_dir.join("orphan.tmp"), b"interrupted write").unwrap();
    fs::write(vector_dir.join(".DS_Store"), b"finder metadata").unwrap();
    fs::write(vector_dir.join("orphan.tmp"), b"interrupted write").unwrap();
    for entry in fs::read_dir(&vector_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            fs::write(path.join("segment.tmp"), b"partial segment").unwrap();
        }
    }

    // Reopening with stray non-symlink files must succeed cleanly.
    let ctx = context(&scope, &owner);
    let engine = start();
    engine.start_space(scope.clone()).unwrap();
    let reopened = engine
        .search(ctx.clone(), query("strayfiletoken"))
        .await
        .unwrap();
    assert_eq!(reopened.hits.len(), 1);
    assert_eq!(
        reopened.hits[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        note_id
    );

    // Triggering a purge scrub must clean everything without failing on stray files.
    let mut purge_req = mutation(
        &ctx,
        DeleteNote {
            note: note_id.clone(),
            disposition: DeleteDisposition::Purge,
        },
    );
    purge_req.preconditions.revision = Some(revisions[0].1.clone());
    let purged = store.delete_note(ctx.clone(), purge_req).await.unwrap();
    projection.live.write().unwrap().remove(&note_id);
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(purged.receipt.seq());
    acknowledged(&store, &root, &scope, purged.receipt.seq()).await;
    assert_absent(&tantivy_dir, "strayfiletoken");
    assert!(
        engine
            .search(ctx, query("strayfiletoken"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    engine.shutdown().await;
}
