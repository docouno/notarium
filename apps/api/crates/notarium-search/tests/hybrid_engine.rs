mod hybrid_support;
mod onnx_support;
#[path = "../../notarium-canonical/tests/support/mod.rs"]
mod storage;

use hybrid_support::{
    ControlledCarriers, HeldPages, Projection, View, context, context_with_grant, mutation,
    status_field,
};
use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, S3BucketModePolicy,
    blobs::s3::admin_ensure_bucket,
    changes::{DEFAULT_BROADCAST_CAPACITY, SyntheticNoteSpec},
    runtime::{CreateFolderSpec, CreateSpaceSpec},
};
use notarium_core::{
    auth::{
        AuthenticatedCredential, ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole,
        VerifiedHuman,
    },
    classes::DocClass,
    epoch::{DataRoot, SearchIndexKind},
    error::PortError,
    ids::{
        AgentRunId, ChatThreadId, FolderId, LeaseEpoch, NoteId, ScheduleId, SpaceSeq,
        ThreadEntrySeq,
    },
    model::{HistoryScope, Lifecycle},
    ports::{
        AppendChat, ChatEntryKind, ChatInputBody, ChatPort, ChatRead, ChatThreadKind, CreateChat,
        DeleteDisposition, DeleteNote, MintAndPurge, MoveFolder, NoteWritePort, PageLimit,
        RecallQuery, RedactChatEntry, SearchPort, SearchQuery, ServiceAuthority, ServicePurpose,
    },
    query::{FieldFilterAstV1, Predicate},
    receipt::{AwaitWatermarks, CausalBasis, MutationReceiptToken, ReceiptSet},
    value::ScalarValue,
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::{SearchLayout, SearchManifest},
    lexical::LexicalIndex,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock, atomic::Ordering},
    time::Duration,
};
use storage::{
    StorageTestFixtures, TempDataRoot, sample_folder_id, sample_incarnation,
    sample_installation_id, sample_note_id, sample_principal_id, sample_space_id,
};
use tokio::sync::Mutex;

// Each scenario measures fallback latency against the same storage resources.
static INTEGRATION_LOCK: Mutex<()> = Mutex::const_new(());
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
    acknowledged_when(store, root, scope, seq, |_| true).await
}

async fn acknowledged_when(
    store: &CanonicalStore,
    root: &DataRoot,
    scope: &HistoryScope,
    seq: SpaceSeq,
    ready: impl Fn(&SearchManifest) -> bool,
) -> SearchManifest {
    let layout = SearchLayout::open(root, scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if store
                .min_consumer_watermark(&scope.space_id, &scope.incarnation)
                .is_some_and(|seen| seen >= seq)
                && let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= seq
                && ready(&manifest)
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

fn assert_files_unchanged(before: &BTreeMap<PathBuf, Vec<u8>>, root: &Path) {
    let after = files(root);
    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>(),
        "file set changed under {}",
        root.display()
    );
    for (name, old) in before {
        let new = &after[name];
        assert!(
            old == new,
            "{} changed from {} bytes ({}) to {} bytes ({})",
            root.join(name).display(),
            old.len(),
            blake3::hash(old),
            new.len(),
            blake3::hash(new)
        );
    }
}

fn assert_absent(path: &Path, marker: &str) {
    for (file, bytes) in files(path) {
        assert!(
            !contains(&bytes, marker),
            "indexed marker found in {file:?}"
        );
        if file.extension().is_some_and(|ext| ext == "term") {
            assert!(
                !term_file_contains(&bytes, marker),
                "indexed term {marker:?} found in term dictionary {file:?}"
            );
        }
    }
}

fn term_file_contains(bytes: &[u8], marker: &str) -> bool {
    const FOOTER_MAGIC: u32 = 1337;
    assert!(bytes.len() >= 8, "truncated tantivy .term file");
    let footer_len =
        u32::from_le_bytes(bytes[bytes.len() - 8..bytes.len() - 4].try_into().unwrap());
    let footer_magic = u32::from_le_bytes(bytes[bytes.len() - 4..].try_into().unwrap());
    assert_eq!(
        footer_magic, FOOTER_MAGIC,
        "unexpected tantivy .term footer magic"
    );
    let body_len = bytes
        .len()
        .checked_sub(footer_len as usize + 8)
        .expect("invalid tantivy .term footer length");
    let body = tantivy::directory::FileSlice::from(bytes[..body_len].to_vec());
    let composite =
        tantivy::directory::CompositeFile::open(&body).expect("open tantivy .term composite file");
    for field_id in 0u32..32 {
        let field = tantivy::schema::Field::from_field_id(field_id);
        let Some(slice) = composite.open_read(field) else {
            continue;
        };
        let dict =
            tantivy::termdict::TermDictionary::open(slice).expect("open tantivy term dictionary");
        let mut stream = dict.stream().expect("stream tantivy term dictionary");
        while stream.advance() {
            if contains(stream.key(), marker) {
                return true;
            }
        }
    }
    false
}

fn tantivy_contains_term(path: &Path, marker: &str) -> bool {
    files(path).into_iter().any(|(file, bytes)| {
        contains(&bytes, marker)
            || (file.extension().is_some_and(|ext| ext == "term")
                && term_file_contains(&bytes, marker))
    })
}

fn contains(bytes: &[u8], marker: &str) -> bool {
    bytes
        .windows(marker.len())
        .any(|window| window == marker.as_bytes())
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
    for (id, slug, project) in [(&docs, "docs", false), (&archive, "archive", true)] {
        store
            .create_folder(CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: lease,
                folder_id: id.clone(),
                parent: None,
                slug: slug.to_owned(),
                display_name: slug.to_owned(),
                is_project: project,
                project_slug: project.then(|| slug.to_owned()),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let a = sample_note_id(1);
    let b = sample_note_id(2);
    let vault = sample_note_id(3);
    let mut install = note(
        &a,
        &docs,
        "Install guide",
        "A repository setup manual. needle.",
    );
    install.fields = status_field("todo");
    let mut glossary = note(
        &b,
        &folder,
        "Glossary",
        "Orbits, satellites, and observatories.",
    );
    glossary.fields = status_field("todo");
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            scope,
            lease,
            &owner,
            vec![
                install,
                glossary,
                note(&vault, &folder, "Retired carrier", SECRET),
            ],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), folder.clone());
    view.folder(docs.clone(), folder.clone());
    view.folder(archive.clone(), folder.clone());
    view.index(a.clone(), docs.clone());
    view.set_status(a.clone(), "todo");
    view.index(b.clone(), folder.clone());
    view.set_status(b.clone(), "todo");
    view.index(vault.clone(), folder.clone());
    view.link(0, 1);
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([a.clone(), b.clone(), vault.clone()])),
    });
    let pages = Arc::new(HeldPages::new(store.clone()));
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    *carriers.seed_deadline_attempts.lock().unwrap() = Some(Vec::new());
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.changes = pages.clone();
    deps.carriers = carriers.clone();
    let vector_mode = VectorMode::DeterministicTest { dimension: 64 };
    let engine = SearchEngine::start(SearchConfig::new(root.clone(), vector_mode.clone()), deps);
    engine.start_space(scope.clone()).unwrap();
    // The lexical cut can be published while the background worker still appends vectors.
    let vectors_ready = |manifest: &SearchManifest| {
        manifest.vector_seq == Some(manifest.tantivy_seq)
            && !manifest.embeddings_pending
            && manifest.vector_replay_after.is_none()
    };
    let before_lag = acknowledged_when(&store, &root, scope, seeded.last_seq, vectors_ready).await;
    let attempts = carriers
        .seed_deadline_attempts
        .lock()
        .unwrap()
        .take()
        .unwrap();
    assert!(attempts[0].after.is_none());
    assert!(attempts[1].after.is_some());
    assert_eq!(attempts[1], attempts[2], "resume the same seed page");
    assert!(before_lag.active_model.is_some());
    let vectors = root.search(&scope.space_id, SearchIndexKind::Vector);
    let old_vectors = files(&vectors);

    // Overflow the real ring before any query can prompt a catch-up itself.
    // Durable folder commands require only a watermark advance.
    let mut high = seeded.last_seq;
    pages.hold(high);
    high = high.checked_next().unwrap();
    store
        .fast_forward_space_to_seq_for_test(scope, lease, high)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();
    for _ in 0..=DEFAULT_BROADCAST_CAPACITY {
        high = high.checked_next().unwrap();
        store
            .fast_forward_space_to_seq_for_test(scope, lease, high)
            .await
            .unwrap();
    }
    projection.snapshot.write().unwrap().advance(high);
    pages.release();
    tokio::time::timeout(Duration::from_secs(30), pages.lagged.notified())
        .await
        .expect("the search subscriber observed a broadcast overrun");
    let after_lag = acknowledged(&store, &root, scope, high).await;
    assert_eq!(after_lag.tantivy_commit, before_lag.tantivy_commit);
    assert_eq!(before_lag.vector_seq, after_lag.vector_seq);
    assert!(!after_lag.embeddings_pending);
    assert_files_unchanged(&old_vectors, &vectors);

    let initial = engine.search(ctx.clone(), query("needle")).await.unwrap();
    assert_eq!(initial.hits[0].card.title, "Install guide");
    assert!(initial.hits[0].chunks[0].text().contains("needle"));
    assert!(initial.degraded.is_none());
    // Only the vector traversal needs to look up the unrelated glossary note.
    let observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    projection.snapshot.write().unwrap().blocked_lookup = Some((b.clone(), observed.clone()));
    let fallback = tokio::time::timeout(
        Duration::from_secs(2),
        engine.search(ctx.clone(), query("needle")),
    )
    .await
    .expect("the vector deadline must release a stalled traversal")
    .unwrap();
    projection.snapshot.write().unwrap().blocked_lookup = None;
    assert!(observed.load(Ordering::SeqCst));
    assert_eq!(fallback.hits[0].card.title, "Install guide");
    assert!(matches!(
        fallback.degraded,
        Some(notarium_core::ports::SearchDegradation::BudgetExceeded)
    ));
    let mut rooted = query("needle");
    rooted.folder = Some(folder.clone());
    let project_lookup = Arc::new(std::sync::atomic::AtomicBool::new(false));
    projection.snapshot.write().unwrap().blocked_project = Some(project_lookup.clone());
    assert_eq!(
        engine.search(ctx.clone(), rooted).await.unwrap().hits[0]
            .card
            .title,
        "Install guide"
    );
    assert!(!project_lookup.load(Ordering::SeqCst));
    projection.snapshot.write().unwrap().blocked_project = None;

    pages.hold(high);
    let created = sample_note_id(5);
    let mut updated = note(&a, &docs, "Receipt version", "exactoverlaytoken");
    updated.fields = status_field("done");
    let mut with_fields = note(&created, &folder, "Fresh receipt note", "newfieldtoken");
    with_fields.fields = status_field("done");
    let (first, exact) = store
        .commit_synthetic_note_batch_for_test(scope, lease, &owner, vec![updated, with_fields])
        .await
        .unwrap();
    let mut later_glossary = note(&b, &folder, "Glossary", "Meteorology and climate.");
    later_glossary.fields = status_field("done");
    let (newer, _) = store
        .commit_synthetic_note_batch_for_test(
            scope,
            lease,
            &owner,
            vec![
                note(&a, &docs, "Latest version", "laterrevisiontoken"),
                later_glossary,
            ],
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
    let instant = engine.search(ctx.clone(), req.clone()).await.unwrap();
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
    projection.live.write().unwrap().insert(created.clone());
    req.filter.predicate = Predicate::Eq {
        key: "status".to_owned(),
        value: ScalarValue::String("todo".to_owned()),
    };
    assert!(
        engine
            .search(ctx.clone(), req.clone())
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    req.filter.predicate = Predicate::Eq {
        key: "status".to_owned(),
        value: ScalarValue::String("done".to_owned()),
    };
    assert_eq!(
        engine.search(ctx.clone(), req.clone()).await.unwrap().hits[0]
            .card
            .title,
        "Receipt version"
    );
    req.text = "newfieldtoken".to_owned();
    req.folder = None;
    assert_eq!(
        engine.search(ctx.clone(), req).await.unwrap().hits[0]
            .card
            .title,
        "Fresh receipt note"
    );

    let mut waiting = query("exactoverlaytoken");
    waiting.causal = CausalBasis::Await(AwaitWatermarks::from_receipts([receipt]));
    let mut short = ctx.clone();
    short.budget.remaining = Duration::from_millis(30);
    assert!(matches!(
        engine.search(short, waiting).await,
        Err(PortError::DeadlineExceeded(_))
    ));
    {
        let mut snapshot = projection.snapshot.write().unwrap();
        snapshot.index(created.clone(), folder.clone());
        snapshot.set_status(created, "done");
        snapshot.set_status(b.clone(), "done");
        snapshot.advance(newer.last_seq);
    }
    let mut mismatched = query("satellites");
    mismatched.causal = CausalBasis::Exact(
        ReceiptSet::new([MutationReceiptToken::new(scope.clone(), first.last_seq).unwrap()])
            .unwrap(),
    );
    for status in ["done", "todo"] {
        mismatched.filter.predicate = Predicate::Eq {
            key: "status".to_owned(),
            value: ScalarValue::String(status.to_owned()),
        };
        let mut short = ctx.clone();
        short.budget.remaining = Duration::from_millis(60);
        assert!(matches!(
            engine.search(short, mismatched.clone()).await,
            Err(PortError::DeadlineExceeded(_))
        ));
    }
    pages.release();
    acknowledged(&store, &root, scope, newer.last_seq).await;
    mismatched.text = "meteorology".to_owned();
    mismatched.filter.predicate = Predicate::Eq {
        key: "status".to_owned(),
        value: ScalarValue::String("done".to_owned()),
    };
    let aligned = engine.search(ctx.clone(), mismatched).await.unwrap();
    let glossary = aligned
        .hits
        .iter()
        .find(|hit| hit.card.document.provenance().reference().note_id == b)
        .unwrap();
    assert!(
        glossary
            .chunks
            .iter()
            .any(|chunk| chunk.text().contains("Meteorology"))
    );
    assert_eq!(aligned.cut.projected_seq, newer.last_seq);
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
    let before_move = acknowledged_when(&store, &root, scope, range.last_seq, vectors_ready).await;
    let tantivy = root.search(&scope.space_id, SearchIndexKind::Tantivy);
    let old_vectors = files(&vectors);
    let viewer = context_with_grant(
        scope,
        &sample_principal_id(tag + 1),
        SpaceGrant {
            role: SpaceRole::Viewer,
            read_classes: [DocClass::UserDoc].into_iter().collect(),
            write_classes: BTreeSet::new(),
            project_root: Some(archive.clone()),
        },
    );
    assert!(
        engine
            .search(viewer.clone(), query("laterrevisiontoken"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
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
    assert_eq!(before_move.vector_seq, after_move.vector_seq);
    assert!(!after_move.embeddings_pending);
    assert_files_unchanged(&old_vectors, &vectors);
    let mut scoped = query("laterrevisiontoken");
    scoped.folder = Some(archive.clone());
    let contained = engine.search(ctx.clone(), scoped).await.unwrap();
    assert_eq!(contained.hits.len(), 1);
    assert_eq!(contained.hits[0].card.title, "Latest version");
    let contained_by_grant = engine
        .search(viewer, query("laterrevisiontoken"))
        .await
        .unwrap();
    assert_eq!(contained_by_grant.hits[0].card.title, "Latest version");
    assert_eq!(
        contained_by_grant.hits[0]
            .card
            .document
            .provenance()
            .revision(),
        contained.hits[0].card.document.provenance().revision()
    );

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
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text(format!("{REDACTED} {SECRET}")),
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
        format!("{REDACTED} {SECRET}")
    );

    assert!(
        engine
            .search(ctx.clone(), query(SECRET))
            .await
            .unwrap()
            .hits
            .iter()
            .any(|hit| { hit.card.document.provenance().reference().note_id == vault })
    );
    let mut mixed = query(SECRET);
    mixed.include_chats = true;
    carriers.hold_chat.store(true, Ordering::SeqCst);
    let (held, ()) = tokio::join!(engine.search(ctx.clone(), mixed), async {
        tokio::time::timeout(Duration::from_secs(3), carriers.chat_held.notified())
            .await
            .unwrap();
        projection.live.write().unwrap().remove(&vault);
        carriers.release_chat.notify_one();
    });
    let held = held.unwrap();
    assert_eq!(held.chat_hits.len(), 1);
    assert!(
        held.hits
            .iter()
            .all(|hit| { hit.card.document.provenance().reference().note_id != vault })
    );
    projection.live.write().unwrap().insert(vault.clone());

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
    let layout = SearchLayout::open(&root, scope.clone()).unwrap();
    let before = layout.search_manifest().unwrap().unwrap();
    let index_path = layout.index_dir(&before).unwrap();
    carriers.hold_chat.store(true, Ordering::SeqCst);
    let (held, redacted_seq) = tokio::join!(engine.search(ctx.clone(), chat.clone()), async {
        tokio::time::timeout(Duration::from_secs(3), carriers.chat_held.notified())
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
                        expected_thread_revision: old_thread.revision,
                    },
                ),
            )
            .await
            .unwrap();
        let seq = redacted.receipt.seq();
        projection.snapshot.write().unwrap().advance(seq);
        tokio::time::timeout(Duration::from_secs(3), async {
            while LexicalIndex::open(&index_path)
                .unwrap()
                .commit_id()
                .unwrap()
                == before.tantivy_commit
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let mut waiting = chat.clone();
        waiting.causal = CausalBasis::Await(AwaitWatermarks::from_receipts([redacted.receipt]));
        let mut short = ctx.clone();
        short.budget.remaining = Duration::from_millis(500);
        assert!(matches!(
            engine.search(short, waiting).await,
            Err(PortError::DeadlineExceeded(_))
        ));
        assert_eq!(
            layout.search_manifest().unwrap().unwrap().tantivy_seq,
            before.tantivy_seq
        );
        assert!(
            store
                .min_consumer_watermark(&scope.space_id, &scope.incarnation)
                .unwrap()
                < seq
        );
        carriers.release_chat.notify_one();
        seq
    });
    assert!(held.unwrap().chat_hits.is_empty());
    acknowledged(&store, &root, scope, redacted_seq).await;
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
            redacted_seq,
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
                max_per_source: None,
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
    for token_budget in [0, 131_073] {
        assert!(matches!(
            engine.recall(ctx.clone(), RecallQuery {
                max_per_source: None,
                query: query("laterrevisiontoken"),
                graph_depth: 0,
                token_budget,
            }).await,
            Err(PortError::Domain(notarium_core::DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == notarium_core::error::ValidationReason::TokenBudgetExceeded
        ));
    }
    let exhausted = engine
        .recall(
            ctx,
            RecallQuery {
                max_per_source: None,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graph_admission_checks_only_neighbors_needed_for_each_visit() {
    use notarium_core::ports::{PortFuture, SearchRecipient};
    use std::sync::atomic::AtomicUsize;
    struct Recipient {
        denied: BTreeSet<NoteId>,
        calls: AtomicUsize,
    }
    impl SearchRecipient for Recipient {
        fn admit<'a>(
            &'a self,
            card: &'a notarium_core::classes::ClassifiedMetadata,
        ) -> PortFuture<'a, bool> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Box::pin(async move { Ok(!self.denied.contains(&card.reference().note_id)) })
        }
    }

    let _guard = INTEGRATION_LOCK.lock().await;
    let data = TempDataRoot::new("graph-admission");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(93),
        data.data_root(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let owner = sample_principal_id(93);
    let folder = sample_folder_id(93);
    let epoch = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(93),
            incarnation: sample_incarnation(93),
            root_folder_id: folder.clone(),
            slug: "graph-admission".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let id = |index: u32| NoteId::from_bytes(u128::from(index).to_be_bytes());
    let mut view = View::new(scope.clone(), folder.clone());
    let narrow = 16 + 8 * 128;
    let last = narrow + 32;
    let mut batch = Vec::new();
    let mut live = BTreeSet::new();
    let mut cutoff = SpaceSeq::ZERO;
    for i in 0..last + 7 {
        let note_id = id(i);
        view.index(note_id.clone(), folder.clone());
        live.insert(note_id.clone());
        let title = if i < 16 {
            "Graphfanoutmarker"
        } else {
            "Neighbor"
        };
        batch.push(note(&note_id, &folder, title, "Evidence."));
        if batch.len() == 64 || i + 1 == last + 7 {
            let (written, _) = store
                .commit_synthetic_note_batch_for_test(
                    &scope,
                    epoch,
                    &owner,
                    std::mem::take(&mut batch),
                )
                .await
                .unwrap();
            cutoff = written.last_seq;
            view.advance(cutoff);
        }
    }
    // Eight seeds have 64 outgoing and 64 different incoming neighbors.
    // Their second half matters only when admission rejects a prefix match.
    for seed in 0..8 {
        for offset in 0..128 {
            let neighbor = 16 + seed * 128 + offset;
            if offset < 64 {
                view.link(seed, neighbor);
            } else {
                view.link(neighbor, seed);
            }
        }
    }
    for neighbor in narrow..last {
        view.link(8, neighbor);
    }
    for i in 0..7 {
        view.link(9 + i, last + i);
    }
    // One leaf is reachable from two seeds and in both directions for seed 9.
    view.link(9, last + 1);
    view.link(last + 1, 9);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(live),
    });
    let engine = SearchEngine::start(
        SearchConfig::new(data.data_root(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projection),
    );
    let ctx = context(&scope, &owner);
    let request = |depth| RecallQuery {
        query: SearchQuery {
            top_k: PageLimit::new(200).unwrap(),
            causal: CausalBasis::Await(AwaitWatermarks::at(scope.clone(), cutoff)),
            ..query("graphfanoutmarker")
        },
        graph_depth: depth,
        token_budget: 131_072,
        max_per_source: None,
    };
    let scores = |result: &notarium_core::ports::SearchResult| {
        result
            .hits
            .iter()
            .map(|hit| {
                (
                    hit.card.document.provenance().reference().note_id.clone(),
                    hit.score,
                )
            })
            .collect::<Vec<_>>()
    };
    for depth in [1, 2] {
        let ordinary = engine.recall(ctx.clone(), request(depth)).await.unwrap();
        let baseline = scores(&ordinary);
        assert!(baseline.iter().any(|(note, _)| note == &id(last + 6)));
        let all = Recipient {
            denied: BTreeSet::new(),
            calls: AtomicUsize::new(0),
        };
        let full = engine
            .recall_for(ctx.clone(), request(depth), Some(&all))
            .await
            .unwrap();
        let actual = scores(&full);
        for i in 0..baseline.len().max(actual.len()) {
            let expected = baseline.get(i);
            let found = actual.get(i);
            assert!(
                found == expected,
                "all sources admitted at depth {depth}, rank {}: expected {expected:?}, actual {found:?} (ordinary length {}, recipient length {})",
                i + 1,
                baseline.len(),
                actual.len()
            );
        }
        assert_eq!(all.calls.into_inner(), 16 + 8 * 64 + 32 + 7);
        if depth == 1 {
            let shared = baseline
                .iter()
                .find(|(note, _)| note == &id(last + 1))
                .unwrap()
                .1;
            let expected =
                0.25 / (70.0 * (1.0 + 3.0_f64.ln())) + 0.25 / (71.0 * (1.0 + 2.0_f64.ln()));
            assert!((shared - expected).abs() < 1e-9);
        }
    }
    // The second case leaves one slot open over three consecutive tail
    // denials. The next allowed note fills it without spending later slots.
    for (denied, replacements) in [
        (vec![16, 17], vec![80, 81]),
        (vec![16, 80, 81, 82], vec![83]),
    ] {
        let partial = Recipient {
            denied: denied.iter().copied().map(id).collect(),
            calls: AtomicUsize::new(0),
        };
        let found = engine
            .recall_for(ctx.clone(), request(1), Some(&partial))
            .await
            .unwrap();
        let hits: BTreeSet<_> = scores(&found).into_iter().map(|(note, _)| note).collect();
        assert!(hits.contains(&id(last + 6)));
        for accepted in &replacements {
            assert!(hits.contains(&id(*accepted)));
        }
        for skipped in &denied {
            assert!(!hits.contains(&id(*skipped)));
        }
        assert!(!hits.contains(&id(replacements.last().unwrap() + 1)));
        assert_eq!(
            partial.calls.into_inner(),
            16 + 8 * 64 + 32 + 7 + denied.len()
        );
    }
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_hybrid_seed_causal_boundaries_and_scrub() {
    let _guard = INTEGRATION_LOCK.lock().await;
    let data = TempDataRoot::new("search-sqlite");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0x42),
        data.data_root(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    run_scenario(store.clone(), data.data_root(), 0x42).await;
    hybrid_support::remote::folder_eligibility(store.clone(), data.data_root()).await;
    hybrid_support::remote::lexical_fallback(store.clone(), data.data_root()).await;
    chat_candidate_visibility(store.clone(), data.data_root()).await;
    reader_capacity(store.clone(), data.data_root()).await;
    writer_saturation_retires_redacted_chat_across_pages(store.clone(), data.data_root()).await;
    exact_overlay_auth_and_structural_folder_receipts(store.clone(), data.data_root()).await;
    hybrid_support::remote::scoped_backfill_recovers_and_rechecks_selection(
        store.clone(),
        data.data_root(),
    )
    .await;
    hybrid_support::ort::search_with_dynamic_models(store.clone(), data.data_root()).await;
    purge_and_rebind(store, data.data_root()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn model_epochs_and_repair_while_writes_continue() {
    let _guard = INTEGRATION_LOCK.lock().await;
    let data = TempDataRoot::new("search-model-epochs");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0x6a),
        data.data_root(),
    ))
    .await
    .unwrap();
    hybrid_support::remote::model_epochs_and_repair(Arc::new(store), data.data_root()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rate_limited_prefix_yields_to_the_sweep_tail() {
    let _guard = INTEGRATION_LOCK.lock().await;
    let data = TempDataRoot::new("search-budget-repair");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0x7b),
        data.data_root(),
    ))
    .await
    .unwrap();
    hybrid_support::remote::rate_limited_repair(Arc::new(store), data.data_root()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_partially_embedded_note_stays_out_of_search_until_complete() {
    let _guard = INTEGRATION_LOCK.lock().await;
    let data = TempDataRoot::new("search-note-budget");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0x7c),
        data.data_root(),
    ))
    .await
    .unwrap();
    hybrid_support::remote::atomic_note_budget(Arc::new(store), data.data_root()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lifecycle_overlay_and_resilience_regressions() {
    let _guard = INTEGRATION_LOCK.lock().await;
    let data = TempDataRoot::new("search-regressions");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0xe0),
        data.data_root(),
    ))
    .await
    .unwrap();
    hybrid_support::regressions::run_all(Arc::new(store), data.data_root()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_hybrid_seed_causal_boundaries_and_scrub() {
    let _guard = INTEGRATION_LOCK.lock().await;
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
    hybrid_support::remote::folder_eligibility(store.clone(), data.data_root()).await;
    hybrid_support::remote::lexical_fallback(store.clone(), data.data_root()).await;
    chat_candidate_visibility(store.clone(), data.data_root()).await;
    reader_capacity(store.clone(), data.data_root()).await;
    writer_saturation_retires_redacted_chat_across_pages(store.clone(), data.data_root()).await;
    exact_overlay_auth_and_structural_folder_receipts(store.clone(), data.data_root()).await;
    hybrid_support::remote::scoped_backfill_recovers_and_rechecks_selection(
        store.clone(),
        data.data_root(),
    )
    .await;
    purge_and_rebind(store, data.data_root()).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

async fn reader_capacity(store: Arc<CanonicalStore>, root: DataRoot) {
    async fn seed(
        store: &CanonicalStore,
        tag: u8,
    ) -> (HistoryScope, SpaceSeq, notarium_core::ids::RevisionId) {
        let owner = sample_principal_id(tag);
        let folder = sample_folder_id(tag);
        let note_id = sample_note_id(tag);
        let lease = LeaseEpoch::new(1).unwrap();
        let space = store
            .create_space(CreateSpaceSpec {
                space_id: sample_space_id(tag),
                incarnation: sample_incarnation(tag),
                root_folder_id: folder.clone(),
                slug: format!("reader-{tag}"),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: lease,
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let (range, revisions) = store
            .commit_synthetic_note_batch_for_test(
                &space.scope,
                lease,
                &owner,
                vec![note(
                    &note_id,
                    &folder,
                    "Capacity receipt",
                    "readercapacitykeyword",
                )],
            )
            .await
            .unwrap();
        (space.scope, range.last_seq, revisions[0].1.clone())
    }
    let tag = 0x90;
    let (first, first_seq, revision) = seed(&store, tag).await;
    let note = sample_note_id(tag);
    let folder = sample_folder_id(tag);
    let mut view = View::new(first.clone(), folder.clone());
    view.index(note.clone(), folder);
    view.advance(first_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([note.clone()])),
    });
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    let start = || {
        let mut deps = SearchDependencies::new(store.clone(), projection.clone());
        deps.carriers = carriers.clone();
        SearchEngine::start(
            SearchConfig::new(
                root.clone(),
                VectorMode::DeterministicTest { dimension: 64 },
            ),
            deps,
        )
    };
    let engine = start();
    engine.start_space(first.clone()).unwrap();
    let note_manifest = acknowledged(&store, &root, &first, first_seq).await;
    let note_layout = SearchLayout::open(&root, first.clone()).unwrap();
    let note_index = note_layout.index_dir(&note_manifest).unwrap();
    let chat_tag = tag + 33;
    let (chat_scope, _, _) = seed(&store, chat_tag).await;
    let chat_layout = SearchLayout::open(&root, chat_scope.clone()).unwrap();
    let chat_owner = sample_principal_id(chat_tag);
    let chat_ctx = context(&chat_scope, &chat_owner);
    let thread = ChatThreadId::from_bytes([chat_tag; 16]);
    store
        .create_chat(
            chat_ctx.clone(),
            mutation(
                &chat_ctx,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: chat_owner,
                    project_folder: None,
                    title: "Reader capacity chat".into(),
                },
            ),
        )
        .await
        .unwrap();
    let appended = store
        .append_chat(
            chat_ctx.clone(),
            mutation(
                &chat_ctx,
                AppendChat {
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
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
            chat_ctx.clone(),
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
    engine.start_space(chat_scope.clone()).unwrap();
    let chat_manifest = acknowledged(&store, &root, &chat_scope, appended.receipt.seq()).await;
    let chat_index = chat_layout.index_dir(&chat_manifest).unwrap();
    let mut other_spaces = Vec::new();
    for tag in (tag + 1)..=(tag + 32) {
        let (scope, seq, _) = seed(&store, tag).await;
        engine.start_space(scope.clone()).unwrap();
        acknowledged(&store, &root, &scope, seq).await;
        other_spaces.push((tag, scope, seq));
    }
    let ctx = context(&first, &sample_principal_id(tag));
    let hits = engine
        .search(ctx.clone(), query("readercapacitykeyword"))
        .await
        .unwrap();
    assert_eq!(hits.hits[0].card.title, "Capacity receipt");
    let mut chat_view = View::new(chat_scope.clone(), sample_folder_id(chat_tag));
    chat_view.advance(appended.receipt.seq());
    *projection.snapshot.write().unwrap() = chat_view;
    let mut chat_query = query(REDACTED);
    chat_query.include_chats = true;
    assert_eq!(
        engine
            .search(chat_ctx.clone(), chat_query)
            .await
            .unwrap()
            .chat_hits[0]
            .snippet,
        REDACTED,
    );
    engine.shutdown().await;
    let vectors = root.search(&first.space_id, SearchIndexKind::Vector);
    assert!(
        files(&vectors)
            .values()
            .any(|bytes| contains(bytes, note.as_str()))
    );
    let mut purge = mutation(
        &ctx,
        DeleteNote {
            note: note.clone(),
            disposition: DeleteDisposition::Purge,
        },
    );
    purge.preconditions.revision = Some(revision);
    let purged = store.delete_note(ctx, purge).await.unwrap();
    projection.live.write().unwrap().remove(&note);
    let redacted = store
        .redact_chat_entry(
            chat_ctx.clone(),
            mutation(
                &chat_ctx,
                RedactChatEntry {
                    thread,
                    entry: appended.value.seq,
                    expected_thread_revision,
                },
            ),
        )
        .await
        .unwrap();

    let engine = Arc::new(start());
    let mut held = tokio::task::JoinSet::new();
    carriers.hold_note_reads.store(true, Ordering::SeqCst);
    for (tag, scope, seq) in other_spaces {
        let folder = sample_folder_id(tag);
        let note_id = sample_note_id(tag);
        let mut view = View::new(scope.clone(), folder.clone());
        view.index(note_id.clone(), folder);
        view.advance(seq);
        *projection.snapshot.write().unwrap() = view;
        projection.live.write().unwrap().insert(note_id);
        let mut ctx = context(&scope, &sample_principal_id(tag));
        ctx.budget.remaining = Duration::from_secs(30);
        let query_engine = engine.clone();
        held.spawn(async move {
            query_engine
                .search(ctx, query("readercapacitykeyword"))
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), carriers.note_read_held.notified())
            .await
            .unwrap();
    }
    engine.start_space(first.clone()).unwrap();
    engine.start_space(chat_scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while note_layout.search_manifest().unwrap().is_some()
            || note_index.exists()
            || chat_layout.search_manifest().unwrap().is_some()
            || chat_index.exists()
            || files(&vectors)
                .values()
                .any(|bytes| contains(bytes, note.as_str()))
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        held.try_join_next().is_none(),
        "all other readers must remain pinned"
    );
    assert!(
        store
            .min_consumer_watermark(&first.space_id, &first.incarnation)
            .is_none_or(|seq| seq < purged.receipt.seq())
    );
    assert!(
        store
            .min_consumer_watermark(&chat_scope.space_id, &chat_scope.incarnation)
            .is_none_or(|seq| seq < redacted.receipt.seq())
    );
    held.shutdown().await;
    carriers.hold_note_reads.store(false, Ordering::SeqCst);
    acknowledged(&store, &root, &first, purged.receipt.seq()).await;
    acknowledged(&store, &root, &chat_scope, redacted.receipt.seq()).await;
    assert_absent(
        &root.search(&first.space_id, SearchIndexKind::Tantivy),
        "readercapacitykeyword",
    );
    assert_absent(
        &root.search(&chat_scope.space_id, SearchIndexKind::Tantivy),
        REDACTED,
    );
    let _kept_alive = Arc::clone(&engine);
    engine.shutdown().await;
}

async fn chat_candidate_visibility(store: Arc<CanonicalStore>, root: DataRoot) {
    let owner = sample_principal_id(0x67);
    let other = sample_principal_id(0x68);
    let folder = sample_folder_id(0x67);
    let project = sample_folder_id(0x68);
    let destination = sample_folder_id(0x69);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x67),
            incarnation: sample_incarnation(0x67),
            root_folder_id: folder.clone(),
            slug: "shared-chat-search".to_owned(),
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: project.clone(),
            parent: None,
            slug: "project".to_owned(),
            display_name: "Project".to_owned(),
            is_project: true,
            project_slug: Some("project".to_owned()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: destination.clone(),
            parent: None,
            slug: "destination".into(),
            display_name: "Destination".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let owner_ctx = context(&space.scope, &owner);
    let other_ctx = context_with_grant(
        &space.scope,
        &other,
        SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        },
    );
    let shared = ChatThreadId::from_bytes([0x67; 16]);
    let movable = ChatThreadId::from_bytes([0x6a; 16]);
    let log = ChatThreadId::from_bytes([0x6b; 16]);
    let run = AgentRunId::from_bytes([0x59; 16]);
    let keeper = EngineAuthContext::for_human(
        VerifiedHuman::attest(
            other.clone(),
            other_ctx.auth().grant().clone(),
            other_ctx.auth().spaces().clone(),
            false,
        )
        .with_credential(AuthenticatedCredential::ScheduledRun {
            schedule: ScheduleId::from_bytes([0x59; 16]),
            run: run.clone(),
            lease,
        }),
    )
    .for_keeper(
        run.clone(),
        space.scope.space_id.clone(),
        None,
        BTreeSet::new(),
    )
    .unwrap()
    .with_verified_keeper_log(log.clone())
    .unwrap();
    let keeper = notarium_core::ports::SpaceContext::new(
        keeper,
        space.scope.clone(),
        other_ctx.budget.clone(),
    )
    .unwrap();
    let mut last = SpaceSeq::ZERO;
    for (thread, ctx, kind, folder, body) in [
        (
            shared.clone(),
            &owner_ctx,
            ChatThreadKind::SpaceGroup,
            Some(project.clone()),
            format!("rankingterm {}", "background ".repeat(32)),
        ),
        (
            ChatThreadId::from_bytes([0x68; 16]),
            &other_ctx,
            ChatThreadKind::Personal,
            None,
            "rankingterm rankingterm".to_owned(),
        ),
        (
            ChatThreadId::from_bytes([0x69; 16]),
            &other_ctx,
            ChatThreadKind::Personal,
            None,
            "rankingterm rankingterm".to_owned(),
        ),
        (
            movable.clone(),
            &owner_ctx,
            ChatThreadKind::SpaceGroup,
            Some(destination.clone()),
            "moveterm".to_owned(),
        ),
        (
            log.clone(),
            &keeper,
            ChatThreadKind::KeeperLog,
            None,
            "logterm".to_owned(),
        ),
    ] {
        let keeper_entry = kind == ChatThreadKind::KeeperLog;
        store
            .create_chat(
                ctx.clone(),
                mutation(
                    ctx,
                    CreateChat {
                        thread: thread.clone(),
                        kind,
                        owner: ctx.auth().principal().clone(),
                        project_folder: folder,
                        title: "Search transcript".to_owned(),
                    },
                ),
            )
            .await
            .unwrap();
        let appended = store
            .append_chat(
                ctx.clone(),
                mutation(
                    ctx,
                    AppendChat {
                        tool_calls: Vec::new(),
                        interruption: None,
                        provenance: keeper_entry.then(Default::default),
                        proposed_diff: None,
                        thread,
                        parent: ThreadEntrySeq::ZERO,
                        kind: if keeper_entry {
                            ChatEntryKind::Model
                        } else {
                            ChatEntryKind::Human
                        },
                        body: ChatInputBody::Text(body),
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap();
        last = appended.receipt.seq();
    }
    let mut view = View::new(space.scope.clone(), folder.clone());
    view.project(project.clone(), folder.clone());
    view.folder(destination.clone(), folder);
    view.advance(last);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::new()),
    });
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projection.clone()),
    );
    engine.start_space(space.scope.clone()).unwrap();
    acknowledged(&store, &root, &space.scope, last).await;
    let mut req = query("rankingterm");
    req.include_chats = true;
    req.top_k = PageLimit::new(1).unwrap();
    let owner_results = engine.search(owner_ctx.clone(), req.clone()).await.unwrap();
    assert_eq!(owner_results.chat_hits.len(), 1);
    assert_eq!(owner_results.chat_hits[0].thread, shared);
    assert!(!owner_results.truncated);
    let other_results = engine.search(other_ctx.clone(), req.clone()).await.unwrap();
    assert_eq!(other_results.chat_hits[0].kind, ChatThreadKind::Personal);
    let private = &other_results.chat_hits[0];
    let shared_run = other_ctx
        .auth()
        .for_agent_run(
            run,
            space.scope.space_id.clone(),
            ChatAudience::Shared,
            other_ctx.auth().spaces().clone(),
        )
        .unwrap();
    let shared_run = notarium_core::ports::SpaceContext::new(
        shared_run,
        space.scope.clone(),
        other_ctx.budget.clone(),
    )
    .unwrap();
    for (ctx, expected) in [(shared_run, Some(&shared)), (keeper.clone(), None)] {
        let (rows, _) = store
            .hydrate_live_visible_chat_hits(
                &ctx,
                &[(private.thread.clone(), private.entry)],
                req.top_k,
            )
            .await
            .unwrap();
        assert!(rows.is_empty());
        let results = engine.search(ctx, req.clone()).await.unwrap();
        assert!(results.chat_hits.iter().map(|hit| &hit.thread).eq(expected));
        assert!(!results.truncated);
    }
    let log_hits = engine
        .search(
            keeper,
            SearchQuery {
                text: "logterm".into(),
                ..req.clone()
            },
        )
        .await
        .unwrap();
    assert!(log_hits.chat_hits.iter().map(|hit| &hit.thread).eq([&log]));
    let viewer = context_with_grant(
        &space.scope,
        &other,
        SpaceGrant {
            role: SpaceRole::Viewer,
            read_classes: DocClass::all(),
            write_classes: BTreeSet::new(),
            project_root: Some(project.clone()),
        },
    );
    let viewer_results = engine.search(viewer.clone(), req.clone()).await.unwrap();
    assert_eq!(viewer_results.chat_hits[0].thread, shared);
    let mut moved_request = query("moveterm");
    moved_request.include_chats = true;
    moved_request.folder = Some(project.clone());
    assert!(
        engine
            .search(owner_ctx.clone(), moved_request.clone())
            .await
            .unwrap()
            .chat_hits
            .is_empty()
    );
    let layout = SearchLayout::open(&root, space.scope.clone()).unwrap();
    let before = layout.search_manifest().unwrap().unwrap();
    let index = layout.index_dir(&before).unwrap();
    let old_files = files(&index);
    let moved = store
        .move_folder(
            owner_ctx.clone(),
            mutation(
                &owner_ctx,
                MoveFolder {
                    folder: destination.clone(),
                    new_parent: Some(project.clone()),
                },
            ),
        )
        .await
        .unwrap();
    {
        let mut view = projection.snapshot.write().unwrap();
        view.folder(destination, project);
        view.advance(moved.receipt.seq());
    }
    let after = acknowledged(&store, &root, &space.scope, moved.receipt.seq()).await;
    assert_eq!(before.tantivy_commit, after.tantivy_commit);
    assert_files_unchanged(&old_files, &index);
    let moved = engine
        .search(owner_ctx, moved_request.clone())
        .await
        .unwrap();
    assert_eq!(moved.chat_hits[0].thread, movable);
    assert!(
        engine
            .search(viewer.clone(), moved_request)
            .await
            .unwrap()
            .chat_hits
            .is_empty()
    );
    assert_eq!(
        engine.search(viewer, req).await.unwrap().chat_hits[0].thread,
        shared
    );
    let lifecycle_ctx = context(&space.scope, &owner);
    set_space_state(
        &store,
        &lifecycle_ctx,
        notarium_core::auth::SpaceLifecycle::Archived,
    )
    .await;
    wait_for_retirement(&layout).await;
    set_space_state(
        &store,
        &lifecycle_ctx,
        notarium_core::auth::SpaceLifecycle::Active,
    )
    .await;
    acknowledged(&store, &root, &space.scope, after.tantivy_seq).await;
    engine.shutdown().await;

    let thread = store
        .read_chat(
            other_ctx.clone(),
            ChatRead {
                thread: private.thread.clone(),
                leaf: private.entry,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap()
        .thread;
    store
        .redact_chat_entry(
            other_ctx.clone(),
            mutation(
                &other_ctx,
                RedactChatEntry {
                    thread: private.thread.clone(),
                    entry: private.entry,
                    expected_thread_revision: thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    set_space_state(
        &store,
        &context(&space.scope, &owner),
        notarium_core::auth::SpaceLifecycle::Archived,
    )
    .await;
    let archived = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projection),
    );
    archived.start_space(space.scope.clone()).unwrap();
    wait_for_retirement(&layout).await;
    archived.shutdown().await;

    tainted_chat_below_limit(store, root, owner).await;
}

async fn set_space_state(
    store: &CanonicalStore,
    ctx: &notarium_core::ports::SpaceContext,
    lifecycle: notarium_core::auth::SpaceLifecycle,
) {
    use notarium_core::{ports::ControlCatalogPort, receipt::AccountCommandIdentity};
    let identity = mutation(ctx, ()).identity;
    store
        .change_lifecycle(
            ctx.budget.clone(),
            AccountCommandIdentity {
                owner: ctx.auth().principal().clone(),
                actor: identity.actor,
                key: identity.key,
                hash: identity.hash,
                expected: notarium_core::ids::ControlRevision::ZERO,
            },
            ctx.scope().clone(),
            lifecycle,
        )
        .await
        .unwrap();
}

async fn wait_for_retirement(layout: &SearchLayout) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !layout.index_generations().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(layout.search_manifest().unwrap().is_none());
}

async fn tainted_chat_below_limit(
    store: Arc<CanonicalStore>,
    root: DataRoot,
    owner: notarium_core::ids::PrincipalId,
) {
    let tag = 0x6e;
    let folder = sample_folder_id(tag);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "chat-taint-limit".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let ctx = context(&scope, &owner);
    let thread = ChatThreadId::from_bytes([tag; 16]);
    let tainted_thread = ChatThreadId::from_bytes([tag.wrapping_add(1); 16]);
    for (id, title) in [
        (&thread, "Chat taint limit clean"),
        (&tainted_thread, "Chat taint limit tainted"),
    ] {
        store
            .create_chat(
                ctx.clone(),
                mutation(
                    &ctx,
                    CreateChat {
                        thread: id.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: owner.clone(),
                        project_folder: None,
                        title: title.into(),
                    },
                ),
            )
            .await
            .unwrap();
    }
    let highest = store
        .append_chat(
            ctx.clone(),
            mutation(
                &ctx,
                AppendChat {
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("filterterm filterterm".into()),
                    referenced_notes: vec![],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    let lower = store
        .append_chat(
            ctx.clone(),
            mutation(
                &ctx,
                AppendChat {
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
                    thread: tainted_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text(format!("filterterm {}", "details ".repeat(32))),
                    referenced_notes: vec![],
                    tainted: true,
                },
            ),
        )
        .await
        .unwrap();
    assert!(lower.value.tainted);
    let mut view = View::new(scope.clone(), folder);
    view.advance(lower.receipt.seq());
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::default(),
    });
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projection),
    );
    engine.start_space(scope.clone()).unwrap();
    acknowledged(&store, &root, &scope, lower.receipt.seq()).await;
    let mut request = query("filterterm");
    request.include_chats = true;
    request.top_k = PageLimit::new(1).unwrap();
    let viewer = context(&scope, &owner);
    let result = engine
        .search(viewer.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        (&result.chat_hits[0].thread, result.chat_hits[0].entry),
        (&thread, highest.value.seq)
    );
    assert!(result.truncated);
    assert!(!viewer.auth().taint().is_tainted());
    request.top_k = PageLimit::new(2).unwrap();
    let result = engine.search(viewer.clone(), request).await.unwrap();
    assert!(
        result
            .chat_hits
            .iter()
            .any(|hit| hit.thread == tainted_thread && hit.entry == lower.value.seq)
    );
    assert!(viewer.auth().taint().is_tainted());
    engine.shutdown().await;
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
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let old = sample_note_id(0x62);
    let ctx = context(&space.scope, &owner);
    let (cut, _) = store
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
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    let start = || {
        let mut deps = SearchDependencies::new(store.clone(), projection.clone());
        deps.carriers = carriers.clone();
        SearchEngine::start(
            SearchConfig::new(
                root.clone(),
                VectorMode::DeterministicTest { dimension: 64 },
            ),
            deps,
        )
    };
    let engine = start();
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
    let (edit, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![note(
                &old,
                &folder,
                "Old incarnation",
                "oldincarnationsecret edited",
            )],
        )
        .await
        .unwrap();
    projection.snapshot.write().unwrap().advance(edit.last_seq);
    acknowledged(&store, &root, &space.scope, edit.last_seq).await;
    let vectors = root.search(&space.scope.space_id, SearchIndexKind::Vector);
    let before_purge = files(&vectors);
    assert!(before_purge.iter().any(|(path, bytes)| {
        path.extension().is_some_and(|extension| extension == "seg")
            && contains(bytes, old.as_str())
    }));
    assert!(before_purge.iter().any(|(path, bytes)| {
        path.file_name().is_some_and(|name| name == "l0.wal") && contains(bytes, old.as_str())
    }));
    engine.shutdown().await;
    carriers.reject_seed.store(true, Ordering::SeqCst);
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
    set_space_state(&store, &ctx, notarium_core::auth::SpaceLifecycle::Archived).await;
    let engine = start();
    engine.start_space(space.scope.clone()).unwrap();
    let archived = SearchLayout::open(&root, space.scope.clone()).unwrap();
    wait_for_retirement(&archived).await;
    assert_absent(&vectors, old.as_str());
    set_space_state(&store, &ctx, notarium_core::auth::SpaceLifecycle::Active).await;
    tokio::time::timeout(Duration::from_secs(5), carriers.seed_rejected.notified())
        .await
        .unwrap();
    carriers.release_seed.notify_one();
    tokio::time::timeout(Duration::from_secs(5), carriers.seed_rejected.notified())
        .await
        .unwrap();
    let tantivy = root.search(&space.scope.space_id, SearchIndexKind::Tantivy);
    assert_absent(&tantivy, "oldincarnationsecret");
    assert_absent(&vectors, old.as_str());
    let layout = SearchLayout::open(&root, space.scope.clone()).unwrap();
    assert!(layout.search_manifest().unwrap().is_none());
    assert!(
        store
            .min_consumer_watermark(&space.scope.space_id, &space.scope.incarnation)
            .is_none_or(|seq| seq < purged.receipt.seq())
    );
    carriers.reject_seed.store(false, Ordering::SeqCst);
    carriers.release_seed.notify_one();
    acknowledged(&store, &root, &space.scope, purged.receipt.seq()).await;
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

async fn writer_saturation_retires_redacted_chat_across_pages(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let chat_tag = 0xc0;
    let lease = LeaseEpoch::new(1).unwrap();
    let owner = sample_principal_id(chat_tag);
    let folder = sample_folder_id(chat_tag);
    let chat_scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(chat_tag),
            incarnation: sample_incarnation(chat_tag),
            root_folder_id: folder.clone(),
            slug: "writer-cap-chat".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let chat_ctx = context(&chat_scope, &owner);
    let thread = ChatThreadId::from_bytes([chat_tag; 16]);
    store
        .create_chat(
            chat_ctx.clone(),
            mutation(
                &chat_ctx,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Writer cap chat".into(),
                },
            ),
        )
        .await
        .unwrap();
    let appended = store
        .append_chat(
            chat_ctx.clone(),
            mutation(
                &chat_ctx,
                AppendChat {
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
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
            chat_ctx.clone(),
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

    let mut view = View::new(chat_scope.clone(), folder.clone());
    view.advance(appended.receipt.seq());
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::new()),
    });
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    let start = || {
        let mut deps = SearchDependencies::new(store.clone(), projection.clone());
        deps.carriers = carriers.clone();
        SearchEngine::start(SearchConfig::new(root.clone(), VectorMode::Disabled), deps)
    };
    let engine = start();
    engine.start_space(chat_scope.clone()).unwrap();
    let initial_manifest = acknowledged(&store, &root, &chat_scope, appended.receipt.seq()).await;
    let mut chat_query = query(REDACTED);
    chat_query.include_chats = true;
    let initial_hits = engine.search(chat_ctx.clone(), chat_query).await.unwrap();
    assert_eq!(initial_hits.chat_hits.len(), 1);
    assert_eq!(initial_hits.chat_hits[0].snippet, REDACTED);
    let chat_layout = SearchLayout::open(&root, chat_scope.clone()).unwrap();
    let old_index = chat_layout.index_dir(&initial_manifest).unwrap();
    let chat_tantivy = root.search(&chat_scope.space_id, SearchIndexKind::Tantivy);
    assert!(tantivy_contains_term(&chat_tantivy, REDACTED));
    engine.shutdown().await;

    // Commit >100 note events so catch_up's first log page contains only notes
    // before the redaction event on the following page.
    for idx in 0u16..105 {
        let mut raw = [0u8; 16];
        raw[0] = chat_tag;
        raw[14..16].copy_from_slice(&(idx + 1).to_be_bytes());
        let id = NoteId::from_bytes(raw);
        store
            .commit_synthetic_note_batch_for_test(
                &chat_scope,
                lease,
                &owner,
                vec![note(&id, &folder, "Filler", "writerfiller")],
            )
            .await
            .unwrap();
    }
    let redacted = store
        .redact_chat_entry(
            chat_ctx.clone(),
            mutation(
                &chat_ctx,
                RedactChatEntry {
                    thread,
                    entry: appended.value.seq,
                    expected_thread_revision,
                },
            ),
        )
        .await
        .unwrap();

    // Saturate all 4 WriterPool slots with unrelated spaces held mid-seed after
    // staging their first page.
    let mut writer_spaces = Vec::new();
    for offset in 1u8..=4 {
        let tag = chat_tag + offset;
        let other_owner = sample_principal_id(tag);
        let other_folder = sample_folder_id(tag);
        let other_scope = store
            .create_space(CreateSpaceSpec {
                space_id: sample_space_id(tag),
                incarnation: sample_incarnation(tag),
                root_folder_id: other_folder.clone(),
                slug: format!("writer-sat-{offset}"),
                kind: SpaceKind::Personal,
                owner: other_owner.clone(),
                active_epoch: lease,
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap()
            .scope;
        let first_note = NoteId::from_bytes([tag; 16]);
        let mut second_raw = [tag; 16];
        second_raw[15] = tag.wrapping_add(1);
        let second_note = NoteId::from_bytes(second_raw);
        let (range, _) = store
            .commit_synthetic_note_batch_for_test(
                &other_scope,
                lease,
                &other_owner,
                vec![
                    note(&first_note, &other_folder, "Seed page 1", "satpageone"),
                    note(&second_note, &other_folder, "Seed page 2", "satpagetwo"),
                ],
            )
            .await
            .unwrap();
        carriers.hold_seed_tail_for(other_scope.space_id.clone());
        writer_spaces.push((other_scope, range.last_seq));
    }

    let engine = start();
    for (scope, _) in &writer_spaces {
        engine.start_space(scope.clone()).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(10), carriers.wait_seed_tail_held(4))
        .await
        .expect("four unrelated spaces hold all staged writers");

    // Now start the cold chat space while all four writers are occupied.
    // Even though the first log page contains only notes and hits
    // WriterUnavailable, the redaction guard must retire the old generation on
    // disk before waiting for a free writer.
    engine.start_space(chat_scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while chat_layout.search_manifest().unwrap().is_some() || old_index.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("old chat index retired on disk while writers remain saturated");
    assert_eq!(carriers.seed_tail_held_count(), 4);
    assert_absent(&chat_tantivy, REDACTED);
    assert!(
        store
            .min_consumer_watermark(&chat_scope.space_id, &chat_scope.incarnation)
            .is_none_or(|seq| seq < redacted.receipt.seq())
    );

    carriers.release_seed_tails();
    for (scope, seq) in &writer_spaces {
        acknowledged(&store, &root, scope, *seq).await;
    }
    acknowledged(&store, &root, &chat_scope, redacted.receipt.seq()).await;
    assert_absent(&chat_tantivy, REDACTED);
    engine.shutdown().await;
}

async fn exact_overlay_auth_and_structural_folder_receipts(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    let tag = 0xd0;
    let lease = LeaseEpoch::new(1).unwrap();
    let owner = sample_principal_id(tag);
    let viewer_id = sample_principal_id(tag + 1);
    let root_folder = sample_folder_id(tag);
    let project = sample_folder_id(tag + 1);
    let moving_folder = sample_folder_id(tag + 2);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: root_folder.clone(),
            slug: "exact-auth-structural".into(),
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: lease,
            folder_id: project.clone(),
            parent: None,
            slug: "project-p".into(),
            display_name: "Project P".into(),
            is_project: true,
            project_slug: Some("project-p".into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: lease,
            folder_id: moving_folder.clone(),
            parent: Some(project.clone()),
            slug: "folder-f".into(),
            display_name: "Folder F".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();

    let note_a = sample_note_id(tag + 1);
    let note_b = sample_note_id(tag + 2);
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![
                note(&note_a, &moving_folder, "Note A", "exactauthshared"),
                note(&note_b, &project, "Note B", "exactauthshared"),
            ],
        )
        .await
        .unwrap();
    let mut view = View::new(scope.clone(), root_folder.clone());
    view.project(project.clone(), root_folder.clone());
    view.folder(moving_folder.clone(), project.clone());
    view.index(note_a.clone(), moving_folder.clone());
    view.index(note_b.clone(), project.clone());
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([note_a.clone(), note_b.clone()])),
    });
    let pages = Arc::new(HeldPages::new(store.clone()));
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.changes = pages.clone();
    let engine = SearchEngine::start(SearchConfig::new(root.clone(), VectorMode::Disabled), deps);
    engine.start_space(scope.clone()).unwrap();
    acknowledged(&store, &root, &scope, seeded.last_seq).await;

    let owner_ctx = context(&scope, &owner);
    let project_viewer = context_with_grant(
        &scope,
        &viewer_id,
        SpaceGrant {
            role: SpaceRole::Viewer,
            read_classes: [DocClass::UserDoc].into_iter().collect(),
            write_classes: BTreeSet::new(),
            project_root: Some(project.clone()),
        },
    );

    // Keep the base tree intact while A leaves P at the edited revision.
    pages.hold(seeded.last_seq);
    let (edited, edited_revs) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(
                &note_a,
                &root_folder,
                "Moved edit A",
                "exactauthshared exactauthshared exactauthshared",
            )],
        )
        .await
        .unwrap();
    let outside = engine
        .search(project_viewer.clone(), query("exactauthshared"))
        .await
        .unwrap();
    assert_eq!(outside.hits.len(), 1);
    assert_eq!(
        outside.hits[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        note_b
    );

    let (returned, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(
                &note_a,
                &moving_folder,
                "Returned A",
                "exactauthshared",
            )],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();

    // A is visible at the base and at the live head. Its intervening
    // exact revision still belongs outside the viewer's project.
    let base = engine
        .search(project_viewer.clone(), query("exactauthshared"))
        .await
        .unwrap();
    assert_eq!(
        base.hits
            .iter()
            .map(|hit| &hit.card.document.provenance().reference().note_id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([&note_a, &note_b])
    );

    let edit_receipt = MutationReceiptToken::new(scope.clone(), edited.last_seq).unwrap();
    let mut viewer_req = query("exactauthshared");
    viewer_req.top_k = PageLimit::new(1).unwrap();
    viewer_req.causal = CausalBasis::Exact(ReceiptSet::new([edit_receipt.clone()]).unwrap());
    let top1 = engine
        .search(project_viewer.clone(), viewer_req.clone())
        .await
        .unwrap();
    assert_eq!(top1.hits.len(), 1);
    assert_eq!(
        top1.hits[0].card.document.provenance().reference().note_id,
        note_b
    );
    viewer_req.top_k = PageLimit::new(10).unwrap();
    let all_allowed = engine
        .search(project_viewer, viewer_req.clone())
        .await
        .unwrap();
    assert_eq!(all_allowed.hits.len(), 1);
    assert_eq!(
        all_allowed.hits[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        note_b
    );
    viewer_req.top_k = PageLimit::new(1).unwrap();
    let owner_top1 = engine.search(owner_ctx.clone(), viewer_req).await.unwrap();
    assert_eq!(owner_top1.hits.len(), 1);
    assert_eq!(owner_top1.hits[0].card.title, "Moved edit A");
    assert_eq!(
        owner_top1.hits[0].card.document.provenance().revision(),
        &edited_revs[0].1
    );

    projection
        .snapshot
        .write()
        .unwrap()
        .advance(returned.last_seq);
    pages.release();
    acknowledged(&store, &root, &scope, returned.last_seq).await;

    // A note-only receipt following a folder move must wait for the new
    // structural cut even when the request omits the move receipt.
    pages.hold(returned.last_seq);
    store
        .move_folder(
            owner_ctx.clone(),
            mutation(
                &owner_ctx,
                MoveFolder {
                    folder: moving_folder.clone(),
                    new_parent: None,
                },
            ),
        )
        .await
        .unwrap();
    let (after_move, after_move_revs) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(
                &note_a,
                &moving_folder,
                "After move",
                "afterfoldermovetoken",
            )],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();
    let edit_receipt = MutationReceiptToken::new(scope.clone(), after_move.last_seq).unwrap();
    let mut after_move_req = query("afterfoldermovetoken");
    after_move_req.causal = CausalBasis::Exact(ReceiptSet::new([edit_receipt]).unwrap());
    let mut short = owner_ctx.clone();
    short.budget.remaining = Duration::from_millis(60);
    assert!(matches!(
        engine.search(short.clone(), after_move_req.clone()).await,
        Err(PortError::DeadlineExceeded(_))
    ));

    {
        let mut view = projection.snapshot.write().unwrap();
        view.folder(moving_folder, root_folder.clone());
        view.advance(after_move.last_seq);
    }
    pages.release();
    acknowledged(&store, &root, &scope, after_move.last_seq).await;
    let after_move_hits = engine
        .search(owner_ctx.clone(), after_move_req)
        .await
        .unwrap();
    assert_eq!(after_move_hits.hits.len(), 1);
    assert_eq!(
        after_move_hits.hits[0]
            .card
            .document
            .provenance()
            .revision(),
        &after_move_revs[0].1
    );

    // Explicit create and trash receipts also need the corresponding tree.
    pages.hold(after_move.last_seq);
    let created_folder = sample_folder_id(tag + 3);
    let (_, created_folder_rev, created_folder_seq) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: lease,
            folder_id: created_folder.clone(),
            parent: None,
            slug: "fresh-folder".into(),
            display_name: "Fresh folder".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let fresh_note = sample_note_id(tag + 3);
    let (fresh_note_range, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(
                &fresh_note,
                &created_folder,
                "Fresh folder note",
                "freshfoldertoken",
            )],
        )
        .await
        .unwrap();
    projection.live.write().unwrap().insert(fresh_note.clone());
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();

    let folder_receipt = MutationReceiptToken::new(scope.clone(), created_folder_seq).unwrap();
    let note_receipt = MutationReceiptToken::new(scope.clone(), fresh_note_range.last_seq).unwrap();
    let mut structural_req = query("freshfoldertoken");
    structural_req.folder = Some(created_folder.clone());
    structural_req.causal =
        CausalBasis::Exact(ReceiptSet::new([folder_receipt, note_receipt]).unwrap());
    assert!(matches!(
        engine.search(short, structural_req.clone()).await,
        Err(PortError::DeadlineExceeded(_))
    ));

    {
        let mut view = projection.snapshot.write().unwrap();
        view.folder(created_folder.clone(), root_folder);
        view.index(fresh_note, created_folder.clone());
        view.advance(fresh_note_range.last_seq);
    }
    pages.release();
    acknowledged(&store, &root, &scope, fresh_note_range.last_seq).await;
    let found = engine
        .search(owner_ctx.clone(), structural_req)
        .await
        .unwrap();
    assert_eq!(found.hits.len(), 1);
    assert_eq!(found.hits[0].card.title, "Fresh folder note");

    pages.hold(fresh_note_range.last_seq);
    let (_, trash_seq) = store
        .set_folder_lifecycle(
            &scope,
            lease,
            &created_folder,
            &created_folder_rev,
            Lifecycle::Trashed,
            &owner,
            None,
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), pages.reached.notified())
        .await
        .unwrap();
    let trash_receipt = MutationReceiptToken::new(scope.clone(), trash_seq).unwrap();
    let mut trashed_req = query("freshfoldertoken");
    trashed_req.folder = Some(created_folder);
    trashed_req.causal = CausalBasis::Exact(ReceiptSet::new([trash_receipt]).unwrap());
    let mut short = owner_ctx;
    short.budget.remaining = Duration::from_millis(60);
    assert!(matches!(
        engine.search(short, trashed_req).await,
        Err(PortError::DeadlineExceeded(_))
    ));
    projection.snapshot.write().unwrap().advance(trash_seq);
    pages.release();
    acknowledged(&store, &root, &scope, trash_seq).await;
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lexical_evidence_and_live_chat_pagination() {
    let _guard = INTEGRATION_LOCK.lock().await;
    let data = TempDataRoot::new("search-lexical-pages");
    let root = data.data_root();
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0x31),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let owner = sample_principal_id(0x31);
    let folder = sample_folder_id(0x31);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x31),
            incarnation: sample_incarnation(0x31),
            root_folder_id: folder.clone(),
            slug: "lexical-pages".into(),
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
    let id = sample_note_id(32);
    let text = "## First\n\nbranchterm.\n\n## Second\n\nIntroduction.\n\n## Third\n\nBackground.\n\n## Fourth\n\nRareWidget::dispatch";
    store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(&id, &folder, "Reference", text)],
        )
        .await
        .unwrap();
    let thread = ChatThreadId::from_bytes([31; 16]);
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
                    title: "Paged results".into(),
                },
            ),
        )
        .await
        .unwrap();
    let mut parent = ThreadEntrySeq::ZERO;
    let mut first = None;
    let mut last = SpaceSeq::ZERO;
    for index in 0..201 {
        let body = if index == 0 {
            format!("pageterm {}", "background ".repeat(16))
        } else {
            "pageterm pageterm branchterm".into()
        };
        let appended = store
            .append_chat(
                ctx.clone(),
                mutation(
                    &ctx,
                    AppendChat {
                        tool_calls: Vec::new(),
                        interruption: None,
                        provenance: None,
                        proposed_diff: None,
                        thread: thread.clone(),
                        parent,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text(body),
                        referenced_notes: vec![],
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap();
        parent = appended.value.seq;
        first.get_or_insert(parent);
        last = appended.receipt.seq();
    }

    let mut view = View::new(scope.clone(), folder.clone());
    view.index(id.clone(), folder);
    view.advance(last);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new([id].into()),
    });
    let pages = Arc::new(HeldPages::new(store.clone()));
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    let mut deps = SearchDependencies::new(store.clone(), projection);
    deps.carriers = carriers.clone();
    deps.changes = pages.clone();
    let engine = SearchEngine::start(SearchConfig::new(root.clone(), VectorMode::Disabled), deps);
    engine.start_space(scope.clone()).unwrap();
    acknowledged(&store, &root, &scope, last).await;
    let hit = engine
        .search(ctx.clone(), query("RareWidget::dispatch"))
        .await
        .unwrap();
    assert!(
        hit.hits[0].chunks[0]
            .text()
            .contains("RareWidget::dispatch")
    );
    let tokens = hit.hits[0].chunks[0].part().tokens();
    let recall = engine
        .recall(
            ctx.clone(),
            RecallQuery {
                max_per_source: None,
                query: query("RareWidget::dispatch"),
                graph_depth: 0,
                token_budget: tokens,
            },
        )
        .await
        .unwrap();
    assert_eq!(recall.hits[0].chunks.len(), 1);
    assert!(
        recall.hits[0].chunks[0]
            .text()
            .contains("RareWidget::dispatch")
    );

    let source_limit = u16::try_from(tokens - 1).unwrap();
    let capped = engine
        .recall(
            ctx.clone(),
            RecallQuery {
                query: query("RareWidget::dispatch"),
                graph_depth: 0,
                token_budget: 131_072,
                max_per_source: Some(source_limit),
            },
        )
        .await
        .unwrap();
    assert!(capped.truncated);
    assert!(capped.hits.iter().all(|hit| {
        hit.chunks
            .iter()
            .map(|part| part.part().tokens())
            .sum::<u32>()
            <= u32::from(source_limit)
    }));

    let mut request = query("pageterm");
    request.include_chats = true;
    request.top_k = PageLimit::new(200).unwrap();
    let all = engine.search(ctx.clone(), request.clone()).await.unwrap();
    assert_eq!(all.chat_hits.len(), 200);
    assert!(all.truncated);

    // Keep the lexical cut pinned while the canonical branch drops all 200
    // higher-scoring entries. The remaining, weaker entry must still be found.
    pages.hold(last);
    let first = first.unwrap();
    let mut mixed = query("branchterm");
    mixed.include_chats = true;
    mixed.top_k = PageLimit::new(1).unwrap();
    let sticky_reader = context(&scope, &owner);
    carriers.hold_hydrated_chat.store(true, Ordering::SeqCst);
    let (retained, ()) = tokio::join!(engine.search(sticky_reader.clone(), mixed.clone()), async {
        tokio::time::timeout(Duration::from_secs(3), carriers.chat_held.notified())
            .await
            .unwrap();
        assert!(!sticky_reader.auth().taint().is_tainted());
        store
            .append_chat(
                ctx.clone(),
                mutation(
                    &ctx,
                    AppendChat {
                        tool_calls: Vec::new(),
                        interruption: None,
                        provenance: None,
                        proposed_diff: None,
                        thread: thread.clone(),
                        parent,
                        kind: ChatEntryKind::Model,
                        body: ChatInputBody::Text("External context".into()),
                        referenced_notes: vec![],
                        tainted: true,
                    },
                ),
            )
            .await
            .unwrap();
        carriers.release_chat.notify_one();
    });
    assert_eq!(retained.unwrap().chat_hits.len(), 1);
    assert!(
        sticky_reader.auth().taint().is_tainted(),
        "delivering an earlier message records the new sticky thread taint"
    );

    let fork = |actor: &notarium_core::ports::SpaceContext| {
        mutation(
            actor,
            notarium_core::ports::ForkChat {
                thread: thread.clone(),
                parent: first,
            },
        )
    };
    assert!(ctx.auth().taint().is_tainted());
    assert!(matches!(
        store.fork_chat(ctx.clone(), fork(&ctx)).await,
        Err(PortError::Domain(notarium_core::DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == notarium_core::error::ValidationReason::InvalidState
    ));
    let fork_reader = context(&scope, &owner);
    let fork_owner = context(&scope, &owner);
    carriers.hold_hydrated_chat.store(true, Ordering::SeqCst);
    let (mixed, ()) = tokio::join!(engine.search(fork_reader.clone(), mixed), async {
        tokio::time::timeout(Duration::from_secs(3), carriers.chat_held.notified())
            .await
            .unwrap();
        assert!(
            !fork_reader.auth().taint().is_tainted(),
            "preparing a snippet cannot taint its caller"
        );
        store
            .fork_chat(fork_owner.clone(), fork(&fork_owner))
            .await
            .unwrap();
        carriers.release_chat.notify_one();
    });
    let mixed = mixed.unwrap();
    assert_eq!(mixed.hits.len(), 1);
    assert!(
        mixed.chat_hits.is_empty(),
        "the admitted chat left the branch before note delivery"
    );
    assert!(
        !fork_reader.auth().taint().is_tainted(),
        "a withdrawn chat must not taint the delivered note"
    );
    request.top_k = PageLimit::new(1).unwrap();
    let visible = engine.search(ctx.clone(), request.clone()).await.unwrap();
    assert_eq!(visible.chat_hits.len(), 1);
    assert_eq!(visible.chat_hits[0].entry, first);
    assert!(!visible.truncated);
    // All strict matches left the branch. The one surviving single-term entry
    // becomes eligible for relaxation even while its old siblings remain indexed.
    request.text = "pageterm branchterm orangeterm".into();
    let relaxed = engine.search(ctx, request).await.unwrap();
    assert_eq!(relaxed.chat_hits.len(), 1);
    assert_eq!(relaxed.chat_hits[0].entry, first);
    pages.release();
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
}
