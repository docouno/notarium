use super::{
    HeldPages, Projection, View, context, mutation,
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
    DomainError, DomainResult,
    auth::SpaceKind,
    classes::DocClass,
    epoch::{DataRoot, SearchIndexKind},
    error::{PortError, ValidationReason},
    ids::{ChatThreadId, FolderId, LeaseEpoch, NoteId, SpaceSeq, ThreadEntrySeq},
    model::{DenseNodeId, DenseNodeIter, HistoryScope, Lifecycle, SnapshotCut},
    ports::{
        AppendChat, ChatEntryKind, ChatInputBody, ChatPort, ChatRead, ChatThreadKind, CreateChat,
        DeleteDisposition, DeleteNote, NoteCard, NoteWritePort, PageLimit, PortFuture, RecallQuery,
        RedactChatEntry, SearchPort, ServiceAuthority, ServicePurpose, SpaceContext,
        StructuralReadPort, StructuralSnapshot,
    },
    query::FieldFilterAstV1,
    receipt::{AwaitWatermarks, CausalBasis, MutationReceiptToken, ReceiptSet},
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::SearchLayout,
    ports::SearchDocumentTarget,
};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    collections::BTreeSet,
    fs,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub async fn run_all(store: Arc<CanonicalStore>, root: DataRoot) {
    trashed_folder_hidden_in_overlay_and_authorized_documents(store.clone(), root.clone()).await;
    exact_overlay_zero_grace_and_concurrent_align_convergence(store.clone(), root.clone()).await;
    redaction_incomplete_cleanup_during_model_refresh_blocks_ack(store.clone(), root.clone()).await;
    purge_resync_during_embedding_repair_recovers_cleanly(store.clone(), root.clone()).await;
    trash_and_restore_during_seed_recovers_cleanly(store.clone(), root.clone()).await;
    stray_files_and_orphan_tmps_do_not_break_reopen_or_scrub(store.clone(), root.clone()).await;
    empty_query_preserves_exact_causal_and_stale_incarnation(store.clone(), root.clone()).await;
    concurrent_trash_during_search_and_recall_skips_vanished_notes(store, root).await;
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
    let mut corpus = vec![note(&seed_id, &folder, "Base note", "alignbasetoken")];
    let mut view = View::new(scope.clone(), folder.clone());
    let mut live = BTreeSet::from([seed_id.clone()]);
    view.index(seed_id.clone(), folder.clone());
    for index in 0..10 {
        let id = sample_note_id(index + 1);
        let text = if index < 9 { "violet blue" } else { "violet" };
        corpus.push(note(&id, &folder, "Colour", text));
        view.index(id.clone(), folder.clone());
        live.insert(id);
    }
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(&scope, lease, &owner, corpus)
        .await
        .unwrap();
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(live),
    });
    let pages = Arc::new(HeldPages::new(store.clone()));
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.changes = pages.clone();
    let mut config = SearchConfig::new(root.clone(), VectorMode::Disabled);
    config.causal_wait_budget = Duration::from_secs(2);
    let engine = Arc::new(SearchEngine::start(config, deps));
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
            vec![note(
                &fresh_id,
                &folder,
                "Fresh note",
                "fastoverlaytoken violet blue",
            )],
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
    let mut quorum = query("violet blue orange");
    quorum.top_k = PageLimit::new(20).unwrap();
    quorum.causal = exact.causal.clone();
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

    let note_ids = |result: notarium_core::ports::SearchResult| -> BTreeSet<NoteId> {
        result
            .hits
            .into_iter()
            .map(|hit| hit.card.document.provenance().reference().note_id.clone())
            .collect()
    };
    let overlay_quorum = note_ids(engine.search(ctx.clone(), quorum.clone()).await.unwrap());
    assert_eq!(overlay_quorum.len(), 10);
    assert!(!overlay_quorum.contains(&sample_note_id(10)));

    // Release catch-up and exercise concurrent writes alongside parallel reads
    // to verify align converges without DeadlineExceeded.
    {
        let mut snap = projection.snapshot.write().unwrap();
        snap.index(fresh_id, folder.clone());
        snap.advance(fresh.last_seq);
    }
    pages.release();
    acknowledged(&store, &root, &scope, fresh.last_seq).await;

    let caught_up_quorum = note_ids(engine.search(ctx.clone(), quorum).await.unwrap());
    assert_eq!(caught_up_quorum, overlay_quorum);

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
    let start = || {
        let mut deps = SearchDependencies::new(store.clone(), projection.clone());
        deps.model_resolver = Some(resolver.clone());
        deps.providers = Some(provider.clone());
        Arc::new(SearchEngine::start(
            SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
            deps,
        ))
    };
    let engine = start();
    engine.start_space(scope.clone()).unwrap();
    let initial = acknowledged(&store, &root, &scope, appended.receipt.seq()).await;
    assert_eq!(initial.vector_seq, Some(appended.receipt.seq()));
    assert!(!initial.embeddings_pending);
    assert!(seeded.last_seq < appended.receipt.seq());
    engine.shutdown().await;

    // Register an extra managed path before reopening so Tantivy loads it into
    // `ManagedDirectory` while `open_disk` still sees only regular files.
    let layout = SearchLayout::open(&root, scope.clone()).unwrap();
    let initial_dir = layout.index_dir(&initial).unwrap();
    let managed_path = initial_dir.join(".managed.json");
    let mut managed: Vec<String> =
        serde_json::from_slice(&fs::read(&managed_path).unwrap()).unwrap();
    managed.push("stale_obsolete.term".to_owned());
    fs::write(&managed_path, serde_json::to_vec(&managed).unwrap()).unwrap();

    let engine = start();
    engine.start_space(scope.clone()).unwrap();
    assert_eq!(
        engine
            .search(ctx.clone(), query("pinreaderterm"))
            .await
            .unwrap()
            .hits
            .len(),
        1
    );

    // Hold a ModelRefresh mid-provider call so the redaction event runs while
    // ModelRefresh is active and cannot race with `BgDone(ModelRefresh)`.
    provider.block_next_part.store(true, Ordering::SeqCst);
    resolver.provider.store(6, Ordering::SeqCst);
    let _ = engine
        .search(ctx.clone(), query("pinreaderterm"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), provider.part_started.notified())
        .await
        .unwrap();

    // Plant a non-empty directory at the registered managed path after reopen
    // so `collect_obsolete` returns `LexicalError::IncompleteCleanup` (EISDIR)
    // once `publisher.drain()` completes. Locking it read-only on non-root Unix
    // also pauses `build::scrub` after manifest invalidation so we can observe
    // the watermark staying below `redacted.receipt.seq()`.
    #[cfg(unix)]
    struct ReadOnlyDirGuard(std::path::PathBuf);
    #[cfg(unix)]
    impl ReadOnlyDirGuard {
        fn lock(path: std::path::PathBuf) -> Self {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o555)).unwrap();
            Self(path)
        }
    }
    #[cfg(unix)]
    impl Drop for ReadOnlyDirGuard {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
        }
    }

    let blocker_dir = initial_dir.join("stale_obsolete.term");
    fs::create_dir(&blocker_dir).unwrap();
    fs::write(blocker_dir.join("hold"), b"pinned obsolete entry").unwrap();
    #[cfg(unix)]
    let non_root_unix = fs::metadata(&blocker_dir)
        .map(|meta| meta.uid() != 0)
        .unwrap_or(false);
    #[cfg(not(unix))]
    let non_root_unix = false;
    #[cfg(unix)]
    let blocker_guard = non_root_unix.then(|| ReadOnlyDirGuard::lock(blocker_dir.clone()));

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

    // No reader is pinned, so `publisher.drain()` finishes immediately and
    // `collect_obsolete` returns `IncompleteCleanup`, cancelling `ModelRefresh`
    // and entering `build::scrub` without advancing the watermark.
    if non_root_unix {
        tokio::time::timeout(Duration::from_secs(8), async {
            while !matches!(layout.search_manifest(), Ok(None)) {
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        })
        .await
        .expect("IncompleteCleanup must trigger scrub and invalidate manifest");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            store
                .min_consumer_watermark(&scope.space_id, &scope.incarnation)
                .is_none_or(|seq| seq < redacted.receipt.seq()),
            "redaction watermark advanced while IncompleteCleanup scrub remained blocked"
        );
        assert!(blocker_dir.exists());
        #[cfg(unix)]
        drop(blocker_guard);
    }

    acknowledged(&store, &root, &scope, redacted.receipt.seq()).await;
    assert!(
        !blocker_dir.exists(),
        "IncompleteCleanup must scrub and rebuild the dirty Tantivy generation"
    );
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

async fn empty_query_preserves_exact_causal_and_stale_incarnation(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xed;
    let owner = sample_principal_id(tag);
    let root_folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: root_folder.clone(),
            slug: "reg-empty-exact".into(),
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
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(&note_id, &root_folder, "Seed", "emptyexactseed")],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), root_folder.clone());
    view.index(note_id.clone(), root_folder.clone());
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([note_id])),
    });
    let engine = SearchEngine::start(
        SearchConfig::new(root, VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projection.clone()),
    );
    engine.start_space(scope.clone()).unwrap();
    let ctx = context(&scope, &owner);

    let stale_scope = HistoryScope {
        space_id: scope.space_id.clone(),
        incarnation: sample_incarnation(tag + 1),
    };
    let stale_receipt =
        ReceiptSet::new([
            MutationReceiptToken::new(stale_scope, SpaceSeq::new(1).unwrap()).unwrap(),
        ])
        .unwrap();

    // Punctuation-only query (`empty_query == true`) must still reject stale incarnation receipts.
    let mut empty_stale = query("---");
    empty_stale.folder = Some(root_folder.clone());
    empty_stale.causal = CausalBasis::Exact(stale_receipt.clone());
    let err = engine
        .search(ctx.clone(), empty_stale)
        .await
        .expect_err("empty_query must reject stale incarnation receipt");
    assert!(matches!(
        err,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch
    ));

    // Encrypted-only query must also reject stale incarnation receipts.
    let mut enc_stale = query("anything");
    enc_stale.classes = BTreeSet::from([DocClass::EncryptedNote]);
    enc_stale.causal = CausalBasis::Exact(stale_receipt);
    let err = engine
        .search(ctx.clone(), enc_stale)
        .await
        .expect_err("encrypted_only must reject stale incarnation receipt");
    assert!(matches!(
        err,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch
    ));

    // Exact receipt for a newly created folder must be honoured on empty_query
    // and encrypted_only early exits rather than reading a stale projection cut.
    let new_folder = sample_folder_id(tag + 1);
    let (_, _, folder_seq) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: lease,
            folder_id: new_folder.clone(),
            parent: Some(root_folder.clone()),
            slug: "fresh-folder".into(),
            display_name: "Fresh folder".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let proj_bg = projection.clone();
    let folder_bg = new_folder.clone();
    let root_bg = root_folder.clone();
    let advance_task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(40)).await;
        let mut snap = proj_bg.snapshot.write().unwrap();
        snap.folder(folder_bg, root_bg);
        snap.advance(folder_seq);
    });
    let folder_receipt =
        ReceiptSet::new([MutationReceiptToken::new(scope.clone(), folder_seq).unwrap()]).unwrap();
    let mut empty_exact = query("---");
    empty_exact.folder = Some(new_folder);
    empty_exact.causal = CausalBasis::Exact(folder_receipt);
    let empty_res = engine.search(ctx.clone(), empty_exact).await.unwrap();
    assert!(empty_res.cut.projected_seq >= folder_seq);
    assert!(empty_res.hits.is_empty());
    advance_task.await.unwrap();

    // Use a separate delayed folder and seq so encrypted_only independently
    // proves waiting on CausalBasis::Exact rather than reusing the advanced cut.
    let enc_folder = sample_folder_id(tag + 2);
    let (_, _, enc_folder_seq) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: lease,
            folder_id: enc_folder.clone(),
            parent: Some(root_folder.clone()),
            slug: "fresh-encrypted-folder".into(),
            display_name: "Fresh encrypted folder".into(),
            is_project: false,
            project_slug: None,
            actor: owner,
            timestamp: None,
        })
        .await
        .unwrap();
    assert!(
        projection.snapshot.read().unwrap().cut().projected_seq < enc_folder_seq,
        "projection must lag behind enc_folder_seq before enc_exact waits on it"
    );
    let enc_proj_bg = projection.clone();
    let enc_folder_bg = enc_folder.clone();
    let enc_root_bg = root_folder;
    let enc_advance_task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(40)).await;
        let mut snap = enc_proj_bg.snapshot.write().unwrap();
        snap.folder(enc_folder_bg, enc_root_bg);
        snap.advance(enc_folder_seq);
    });
    let enc_folder_receipt =
        ReceiptSet::new([MutationReceiptToken::new(scope, enc_folder_seq).unwrap()]).unwrap();
    let mut enc_exact = query("anything");
    enc_exact.folder = Some(enc_folder);
    enc_exact.classes = BTreeSet::from([DocClass::EncryptedNote]);
    enc_exact.causal = CausalBasis::Exact(enc_folder_receipt);
    let enc_res = engine.search(ctx, enc_exact).await.unwrap();
    assert!(enc_res.cut.projected_seq >= enc_folder_seq);
    assert!(enc_res.hits.is_empty());

    enc_advance_task.await.unwrap();
    engine.shutdown().await;
}

struct VanishingSnapshot {
    inner: View,
    vanished: NoteId,
    vanish_doc_class: bool,
    vanish_note_id: bool,
}

impl StructuralSnapshot for VanishingSnapshot {
    fn cut(&self) -> &SnapshotCut {
        self.inner.cut()
    }

    fn lookup(&self, note: &NoteId) -> DomainResult<Option<DenseNodeId>> {
        self.inner.lookup(note)
    }

    fn note_id(&self, node: DenseNodeId) -> DomainResult<NoteId> {
        let id = self.inner.note_id(node)?;
        if self.vanish_note_id && id == self.vanished {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(id)
    }

    fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
        if self.vanish_doc_class && self.inner.note_id(node).is_ok_and(|id| id == self.vanished) {
            return Err(DomainError::ResourceNotFound);
        }
        self.inner.doc_class(node)
    }

    fn folder_subtree<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, DenseNodeIter<'a>> {
        self.inner.folder_subtree(folder)
    }

    fn folder_descendants<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, Vec<FolderId>> {
        self.inner.folder_descendants(folder)
    }

    fn enclosing_project<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, Option<FolderId>> {
        self.inner.enclosing_project(folder)
    }

    fn filter_notes<'a>(
        &'a self,
        filter: &'a FieldFilterAstV1,
    ) -> PortFuture<'a, Option<DenseNodeIter<'a>>> {
        self.inner.filter_notes(filter)
    }

    fn outgoing(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        self.inner.outgoing(node)
    }

    fn incoming(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        self.inner.incoming(node)
    }
}

struct VanishingProjection {
    inner: Arc<Projection>,
    vanished: NoteId,
    vanish_doc_class: Arc<AtomicBool>,
    vanish_note_id: Arc<AtomicBool>,
    hold_after_hydration: AtomicBool,
    hold_second_note: AtomicBool,
    second_note_started: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

impl StructuralReadPort for VanishingProjection {
    fn acquire_snapshot(
        &self,
        ctx: SpaceContext,
        _: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        Box::pin(async move {
            let inner = self.inner.snapshot.read().unwrap().clone();
            ctx.check_current(&inner.cut().scope)?;
            Ok(Box::new(VanishingSnapshot {
                inner,
                vanished: self.vanished.clone(),
                vanish_doc_class: self.vanish_doc_class.load(Ordering::SeqCst),
                vanish_note_id: self.vanish_note_id.load(Ordering::SeqCst),
            }) as Box<dyn StructuralSnapshot>)
        })
    }

    fn is_live_visible<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        note: &'a NoteId,
    ) -> PortFuture<'a, bool> {
        Box::pin(async move {
            if note == &self.vanished && self.hold_second_note.swap(false, Ordering::SeqCst) {
                self.second_note_started.notify_one();
                self.resume.notified().await;
            }
            self.inner.is_live_visible(ctx, note).await
        })
    }

    fn hydrate(
        &self,
        ctx: SpaceContext,
        cut: SnapshotCut,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
        Box::pin(async move {
            let cards = self.inner.hydrate(ctx, cut, notes).await?;
            if self.hold_after_hydration.swap(false, Ordering::SeqCst) {
                self.hold_second_note.store(true, Ordering::SeqCst);
            }
            Ok(cards)
        })
    }
}

async fn concurrent_trash_during_search_and_recall_skips_vanished_notes(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xef;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "reg-vanish-trash".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let anchor = sample_note_id(tag);
    let vanished = sample_note_id(tag + 1);
    let survivor = sample_note_id(tag + 2);
    let (seeded, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![
                note(&anchor, &folder, "Anchor", "anchorvanishterm"),
                note(&vanished, &folder, "Vanished", "sharedvanishterm"),
                note(&survivor, &folder, "Survivor", "sharedvanishterm"),
            ],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.index(anchor.clone(), folder.clone());
    view.index(vanished.clone(), folder.clone());
    view.index(survivor.clone(), folder.clone());
    view.link(0, 1);
    view.link(0, 2);
    view.advance(seeded.last_seq);
    let inner = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([
            anchor.clone(),
            vanished.clone(),
            survivor.clone(),
        ])),
    });
    let vanish_doc_class = Arc::new(AtomicBool::new(false));
    let vanish_note_id = Arc::new(AtomicBool::new(false));
    let projection = Arc::new(VanishingProjection {
        inner,
        vanished: vanished.clone(),
        vanish_doc_class: vanish_doc_class.clone(),
        vanish_note_id: vanish_note_id.clone(),
        hold_after_hydration: AtomicBool::new(false),
        hold_second_note: AtomicBool::new(false),
        second_note_started: tokio::sync::Notify::new(),
        resume: tokio::sync::Notify::new(),
    });
    let engine = SearchEngine::start(
        SearchConfig::new(
            root.clone(),
            VectorMode::DeterministicTest { dimension: 64 },
        ),
        SearchDependencies::new(store.clone(), projection.clone()),
    );
    engine.start_space(scope.clone()).unwrap();
    let initial = acknowledged(&store, &root, &scope, seeded.last_seq).await;
    assert_eq!(initial.vector_seq, Some(seeded.last_seq));
    let ctx = context(&scope, &owner);

    // Gap 1: note vanishes between lookup() and doc_class() during unfiltered
    // lexical (`admits_note`) and vector (`visible`) checks.
    vanish_doc_class.store(true, Ordering::SeqCst);
    let unfiltered = engine
        .search(ctx.clone(), query("sharedvanishterm"))
        .await
        .expect("vanished doc_class must be skipped, not fail with 404");
    let unfiltered_ids: Vec<_> = unfiltered
        .hits
        .iter()
        .map(|hit| &hit.card.document.provenance().reference().note_id)
        .collect();
    assert!(unfiltered_ids.contains(&&survivor));
    assert!(!unfiltered_ids.contains(&&vanished));

    // Gap 2: note vanishes before `note_id()` during folder-filtered vector
    // candidate expansion (`vector_notes`) and 2-hop graph `recall` (`expand`).
    vanish_note_id.store(true, Ordering::SeqCst);
    let mut folder_req = query("sharedvanishterm");
    folder_req.folder = Some(folder);
    let filtered = engine
        .search(ctx.clone(), folder_req)
        .await
        .expect("vanished note_id in vector_notes must be skipped, not fail with 404");
    let filtered_ids: Vec<_> = filtered
        .hits
        .iter()
        .map(|hit| &hit.card.document.provenance().reference().note_id)
        .collect();
    assert!(filtered_ids.contains(&&survivor));
    assert!(!filtered_ids.contains(&&vanished));

    let recalled = engine
        .recall(
            ctx.clone(),
            RecallQuery {
                query: query("anchorvanishterm"),
                graph_depth: 2,
                token_budget: 2048,
            },
        )
        .await
        .expect("vanished neighbor in ranking::expand must be skipped, not fail with 404");
    let recall_ids: Vec<_> = recalled
        .hits
        .iter()
        .map(|hit| &hit.card.document.provenance().reference().note_id)
        .collect();
    assert!(recall_ids.contains(&&anchor));
    assert!(recall_ids.contains(&&survivor));
    assert!(!recall_ids.contains(&&vanished));
    // The alternate port deliberately uses the per-key default. In a blank
    // filtered browse the anchor sorts first; revoke it while checking the next
    // key in the final batch, after all note carriers are already hydrated.
    vanish_note_id.store(false, Ordering::SeqCst);
    vanish_doc_class.store(false, Ordering::SeqCst);
    projection
        .hold_after_hydration
        .store(true, Ordering::SeqCst);
    let (page, ()) = tokio::join!(engine.search(ctx.clone(), query("")), async {
        tokio::time::timeout(
            Duration::from_secs(3),
            projection.second_note_started.notified(),
        )
        .await
        .unwrap();
        let mut trash = mutation(
            &ctx,
            DeleteNote {
                note: anchor.clone(),
                disposition: DeleteDisposition::Trash,
            },
        );
        trash.preconditions.revision = Some(
            revisions
                .iter()
                .find(|(id, _)| id == &anchor)
                .unwrap()
                .1
                .clone(),
        );
        store.delete_note(ctx.clone(), trash).await.unwrap();
        projection.inner.live.write().unwrap().remove(&anchor);
        projection.resume.notify_one();
    });
    let delivered: BTreeSet<_> = page
        .unwrap()
        .hits
        .into_iter()
        .map(|hit| hit.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(delivered, BTreeSet::from([vanished, survivor]));
    engine.shutdown().await;
}
