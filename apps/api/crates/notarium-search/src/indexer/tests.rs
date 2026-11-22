use super::*;
use crate::{
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
    vector::{ChunkMetadata, MutableOperation, QuantizedVector, SegmentBuilder, VectorChunk},
};
use notarium_core::{
    classes::DocClass,
    epoch::DataRoot,
    ids::{ContentDigest, HistoryIncarnation, ModelProfileId, NoteId, SpaceId},
    model::SnapshotCut,
    ports::{NoteCard, PortFuture, SpaceContext, StructuralReadPort, StructuralSnapshot},
    receipt::CausalBasis,
    span::ByteSpan,
};

struct UnusedStructural;
impl StructuralReadPort for UnusedStructural {
    fn acquire_snapshot(
        &self,
        _: SpaceContext,
        _: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        Box::pin(async { unreachable!("indexer does not read structural snapshots") })
    }

    fn is_live_visible<'a>(&'a self, _: &'a SpaceContext, _: &'a NoteId) -> PortFuture<'a, bool> {
        Box::pin(async { Ok(true) })
    }

    fn hydrate(
        &self,
        _: SpaceContext,
        _: SnapshotCut,
        _: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

#[tokio::test]
async fn idle_space_releases_embedder_and_reopens_checkpointed_wal_after_eviction() {
    let mut entropy = [0; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-idle-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let profile = ModelProfileId::from_bytes([2; 16]);
    let mut epoch = VectorEpoch::open(layout.clone(), profile.clone(), 64).unwrap();
    let seed = SpaceSeq::new(1).unwrap();
    let current = SpaceSeq::new(2).unwrap();
    epoch
        .seed(SegmentBuilder::new(&profile, 64).unwrap(), seed)
        .unwrap();
    let note = NoteId::from_bytes([3; 16]);
    let key = ContentDigest::from_bytes([4; 32]);
    let vector = QuantizedVector::quantize(&[1.0; 64]).unwrap();
    epoch
        .apply_batch(
            current,
            vec![MutableOperation::Upsert {
                note: note.clone(),
                chunks: vec![VectorChunk {
                    metadata: ChunkMetadata {
                        note,
                        key,
                        source: ContentDigest::from_bytes([5; 32]),
                        folder: 1,
                        class: DocClass::UserDoc,
                        context: vec![],
                        spans: vec![ByteSpan::new(0, 1).unwrap()],
                        tokens: 1,
                    },
                    vector: vector.clone(),
                }],
            }],
        )
        .unwrap();
    epoch.checkpoint(current).unwrap();
    let idle_since = Instant::now();
    let mut disk = Disk {
        layout: layout.clone(),
        manifest: SearchManifest {
            scope,
            tantivy_seq: current,
            tantivy_commit: 1,
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            active_model: Some(ResolvedEmbeddingTarget {
                model: profile,
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::LocalOnnx,
            }),
            vector_seq: Some(current),
            embeddings_pending: false,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical: None,
        epoch: Some(epoch),
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        full_sweep_after: None,
        full_sweep_needed: false,
        last_activity: idle_since,
        embedder_last_use: idle_since,
        embedder_unavailable: false,
    };
    // Embedder idle keeps the lightweight mmap VectorEpoch resident.
    disk.release_idle_embedder(idle_since + EMBEDDER_IDLE, EMBEDDER_IDLE);
    assert!(disk.epoch.is_some());
    let manifest = disk.manifest.clone();
    drop(disk);
    let reopened = open_vector_epoch(layout, &manifest).unwrap();
    assert!(reopened.is_checkpointed(current));
    assert_eq!(reopened.find_vector(key), Some(vector));
    drop(reopened);
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn idle_reopen_during_replacement_backoff_restores_active_embedder() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
        ports::{RemoteIndexingGrant, SearchModelResolverPort},
    };
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CreateSpaceSpec, changes::SyntheticNoteSpec,
    };
    use notarium_core::{
        auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
        classes::{ProviderAudience, ProviderPolicy},
        ids::{FolderId, GrantId, InstallationId, LeaseEpoch, PrincipalId, ProviderResourceId},
        model::{FolderRef, Lifecycle},
        ports::{
            EmbeddingInput, EmbeddingProviderPort, EmbeddingRequest, EmbeddingResult, PortFuture,
            ProviderRuntimeEpochs, ProviderUsage, ServiceAuthority,
        },
    };
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::atomic::{AtomicBool, AtomicU8, AtomicUsize},
    };
    use tokio::sync::Notify;

    fn remote_target(provider: u8) -> ResolvedEmbeddingTarget {
        ResolvedEmbeddingTarget {
            model: ModelProfileId::from_bytes([0x44; 16]),
            dimension: 64,
            max_input_tokens: 512,
            backend: EmbeddingBackendTarget::Remote {
                provider: ProviderResourceId::from_bytes([provider; 16]),
                runtime_epochs: ProviderRuntimeEpochs {
                    resource: std::num::NonZeroU64::MIN,
                    credential: None,
                },
                project: None,
            },
        }
    }

    struct SwitchingResolver {
        provider: AtomicU8,
    }
    impl SearchModelResolverPort for SwitchingResolver {
        fn resolve_model<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            _: &'a HistoryScope,
            _: Option<&'a ModelProfileId>,
            _: &'a CallBudget,
        ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
            Box::pin(async move { Ok(Some(remote_target(self.provider.load(Ordering::SeqCst)))) })
        }

        fn acquire_remote_indexing_grant<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            scope: &'a HistoryScope,
            actor: &'a PrincipalId,
            provider: &'a ProviderResourceId,
            _: Option<&'a FolderRef>,
            budget: CallBudget,
        ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
            Box::pin(async move {
                let grant = SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                };
                let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
                    actor.clone(),
                    GrantId::from_bytes([1; 16]),
                    BTreeMap::from([(scope.space_id.clone(), grant)]),
                    true,
                ));
                let ctx = SpaceContext::new(auth, scope.clone(), budget).unwrap();
                Ok(Some(RemoteIndexingGrant {
                    ctx,
                    policy: ProviderPolicy {
                        provider: provider.clone(),
                        audience: ProviderAudience::Personal { consented: true },
                        allowed_classes: BTreeSet::from([DocClass::UserDoc]),
                    },
                }))
            })
        }
    }

    #[derive(Default)]
    struct FailingReplacementProvider {
        fail_provider: AtomicU8,
        attempts: AtomicUsize,
        failed_once: AtomicBool,
        failed: Notify,
    }
    impl EmbeddingProviderPort for FailingReplacementProvider {
        fn query_disclosure(
            &self,
            _: SpaceContext,
            _: ProviderResourceId,
            _: ModelProfileId,
            _: Option<FolderRef>,
        ) -> PortFuture<'_, BTreeSet<DocClass>> {
            Box::pin(async { Ok(BTreeSet::from([DocClass::UserDoc])) })
        }

        fn embed(
            &self,
            _: SpaceContext,
            request: EmbeddingRequest,
        ) -> PortFuture<'_, EmbeddingResult> {
            Box::pin(async move {
                if !matches!(&request.inputs[..], [EmbeddingInput::Query(_)]) {
                    self.attempts.fetch_add(1, Ordering::SeqCst);
                    let failing = ProviderResourceId::from_bytes(
                        [self.fail_provider.load(Ordering::SeqCst); 16],
                    );
                    if request.provider == failing {
                        if !self.failed_once.swap(true, Ordering::SeqCst) {
                            self.failed.notify_one();
                        }
                        return Err(DomainError::AccessDenied.into());
                    }
                }
                let mut vector = vec![0.0; 64];
                vector[0] = 1.0;
                Ok(EmbeddingResult {
                    model: request.model,
                    dimension: 64,
                    vectors: vec![Ok(vector); request.inputs.len()],
                    usage: ProviderUsage::Unknown,
                })
            })
        }
    }

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-idle-backoff-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([7; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let owner = PrincipalId::from_bytes([0x11; 16]);
    let folder = FolderId::from_bytes([0x22; 16]);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0x33; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x33; 16]),
            root_folder_id: folder.clone(),
            slug: "idle-backoff".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let note_id = NoteId::from_bytes([0x55; 16]);
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![SyntheticNoteSpec {
                note_id,
                parent_folder: Some(folder),
                slug: "idle-backoff-note".into(),
                title: "Idle backoff note".into(),
                doc_class: DocClass::UserDoc,
                lifecycle: Lifecycle::Active,
                carrier: "# Idle backoff note\n\nvector body".into(),
                fields: BTreeMap::new(),
            }],
        )
        .await
        .unwrap();

    let resolver = Arc::new(SwitchingResolver {
        provider: AtomicU8::new(5),
    });
    let provider = Arc::new(FailingReplacementProvider::default());
    let mut deps = SearchDependencies::new(store.clone(), Arc::new(UnusedStructural));
    deps.model_resolver = Some(resolver.clone());
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(SearchConfig::new(root, VectorMode::RemoteOnly), deps);
    let handle = Arc::new(SpaceHandle::new());
    let _pin = handle.pin_query();
    let worker_services = engine.services.clone();
    let worker_handle = handle.clone();
    let worker_scope = space.scope.clone();
    let task = tokio::spawn(async move {
        let cx = Context {
            services: &worker_services,
            handle: &worker_handle,
        };
        let mut publisher = Publisher {
            handle: &worker_handle,
            old: Vec::new(),
        };
        let schedule = Schedule {
            tick: Duration::from_millis(20),
            lexical_idle: Duration::from_millis(20),
            embedder_idle: Duration::from_millis(40),
            worker_idle: Duration::from_secs(300),
            archived_idle: Duration::from_secs(30),
        };
        consume(&cx, &mut publisher, &Weak::new(), worker_scope, schedule).await
    });

    let mut epochs = handle.epoch.subscribe();
    let initial = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.seq >= seeded.last_seq
                && state.vectors.is_some()
            {
                break state;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(initial.embedder.is_some());
    assert_eq!(initial.active_model, Some(remote_target(5)));

    // Switch to a failing replacement target so consume enters replacement backoff.
    provider.fail_provider.store(6, Ordering::SeqCst);
    resolver.provider.store(6, Ordering::SeqCst);
    handle.wake.notify_one();
    tokio::time::timeout(Duration::from_secs(5), provider.failed.notified())
        .await
        .unwrap();

    // Release active query pin so idle ticks evict lexical and active embedder.
    drop(_pin);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if handle.published.load_full().is_none() {
                break;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert!(handle.published.load_full().is_none());

    // Wake while replacement backoff (>= 1s) is still active; active embedder must return.
    let _pin = handle.pin_query();
    handle.wake.notify_one();
    let resumed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.embedder.is_some()
            {
                break state;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(
        resumed.vectors.is_some(),
        "vector epoch must remain available on wake"
    );
    assert!(
        resumed.embedder.is_some(),
        "active embedder must reload on post-idle wake even during replacement backoff"
    );
    assert_eq!(resumed.active_model, Some(remote_target(5)));
    assert_eq!(
        provider.attempts.load(Ordering::SeqCst),
        2,
        "replacement backoff must still be active when active embedder reloads"
    );

    handle.stop.cancel();
    assert!(matches!(
        task.await.unwrap(),
        Ok(None) | Err(IndexError::Port(PortError::Cancelled(_)))
    ));
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn lexical_checkpoint_is_available_while_the_native_model_is_loading() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
    };
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CreateFolderSpec, CreateSpaceSpec,
        changes::SyntheticNoteSpec,
    };
    use notarium_core::{
        auth::SpaceKind,
        ids::{FolderId, InstallationId, LeaseEpoch, PrincipalId},
    };

    let mut entropy = [0; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-warm-cut-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([1; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let lease = LeaseEpoch::new(1).unwrap();
    let owner = PrincipalId::from_bytes([5; 16]);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([2; 16]),
            incarnation: HistoryIncarnation::from_bytes([3; 16]),
            root_folder_id: FolderId::from_bytes([4; 16]),
            slug: "warm".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let (_, _, base) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: lease,
            folder_id: FolderId::from_bytes([7; 16]),
            parent: None,
            slug: "work".into(),
            display_name: "Work".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let lexical = LexicalIndex::create(&layout.create_index_generation(1).unwrap()).unwrap();
    layout
        .persist_folder_dictionary(&FolderDictionary::default())
        .unwrap();
    let model = ModelProfileId::from_bytes([6; 16]);
    let mut epoch = VectorEpoch::open(layout.clone(), model.clone(), 64).unwrap();
    epoch
        .seed(SegmentBuilder::new(&model, 64).unwrap(), base)
        .unwrap();
    drop(epoch);
    let target = ResolvedEmbeddingTarget {
        model,
        dimension: 64,
        max_input_tokens: 512,
        backend: EmbeddingBackendTarget::LocalOnnx,
    };
    let manifest = SearchManifest {
        scope: scope.clone(),
        tantivy_seq: base,
        tantivy_commit: lexical.commit_id().unwrap(),
        active_index_dir: crate::layout::index_name(1),
        tokenizer_version: TOKENIZER_VERSION,
        active_model: Some(target.clone()),
        vector_seq: Some(base),
        embeddings_pending: false,
    };
    layout.publish_search(&manifest).unwrap();
    drop(lexical);
    let engine = SearchEngine::start(
        SearchConfig::new(
            root,
            VectorMode::DynamicOrt {
                dylib_path: path.join("runtime"),
                model_dir: path.join("models"),
            },
        ),
        SearchDependencies::new(store.clone(), Arc::new(UnusedStructural)),
    );
    let loading = engine
        .services
        .models
        .hold_loading(target.vector_model())
        .await;
    let handle = engine.space(scope.clone()).unwrap();
    let pin = handle.pin_query();
    let mut updates = handle.epoch.subscribe();
    let published = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(state) = handle.published.load_full() {
                break state;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .expect("lexical readiness cannot wait for ONNX loading");
    assert_eq!(
        published.lexical.commit_id().unwrap(),
        manifest.tantivy_commit
    );
    assert!(published.reopening_vectors);
    drop(published);
    let (edit, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![SyntheticNoteSpec {
                note_id: NoteId::from_bytes([8; 16]),
                parent_folder: None,
                slug: "new".into(),
                title: "A new note".into(),
                doc_class: DocClass::UserDoc,
                lifecycle: notarium_core::model::Lifecycle::Active,
                carrier: "A new note".into(),
                fields: Default::default(),
            }],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.seq == edit.last_seq
            {
                assert!(state.embedder.is_none());
                assert!(
                    state
                        .lexical
                        .contains_note(&state.searcher, &NoteId::from_bytes([8; 16]))
                        .unwrap()
                );
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .expect("lexical edits must progress while ONNX loading is blocked");
    drop((pin, loading));
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn arc_search_engine_shutdown_is_idempotent() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
    };
    use notarium_canonical::{CanonicalConfig, CanonicalRuntime};
    use notarium_core::ids::InstallationId;

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-arc-shutdown-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([9; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let engine = Arc::new(SearchEngine::start(
        SearchConfig::new(root, VectorMode::Disabled),
        SearchDependencies::new(Arc::new(store), Arc::new(UnusedStructural)),
    ));
    engine.shutdown().await;
    engine.shutdown().await;
    assert_eq!(engine.worker_count(), 0);
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn reopening_vectors_stays_true_during_reopen_after_live_edit_clears_vector_seq() {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-reopen-flag-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([0xa1; 16]),
        incarnation: HistoryIncarnation::from_bytes([0xa1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let lexical =
        Arc::new(LexicalIndex::create(&layout.create_index_generation(1).unwrap()).unwrap());
    let now = Instant::now();
    let seq = SpaceSeq::new(2).unwrap();
    let mut disk = Disk {
        layout,
        manifest: SearchManifest {
            scope,
            tantivy_seq: seq,
            tantivy_commit: lexical.commit_id().unwrap(),
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            active_model: Some(ResolvedEmbeddingTarget {
                model: ModelProfileId::from_bytes([0xa2; 16]),
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::LocalOnnx,
            }),
            vector_seq: None,
            embeddings_pending: true,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical: Some(lexical),
        epoch: None,
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        full_sweep_after: None,
        full_sweep_needed: false,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    };
    let handle = Arc::new(SpaceHandle::new());
    let mut publisher = Publisher {
        handle: &handle,
        old: Vec::new(),
    };
    // Live edit during BgKind::ReopenVectors clears vector_seq while passing
    // reopening = true; published state must stay marked reopening_vectors.
    publisher.publish(&disk, true);
    assert!(handle.published.load_full().unwrap().reopening_vectors);

    publisher.publish(&disk, false);
    assert!(!handle.published.load_full().unwrap().reopening_vectors);

    disk.manifest.vector_seq = Some(seq);
    publisher.publish(&disk, false);
    assert!(handle.published.load_full().unwrap().reopening_vectors);

    publisher.replace(None);
    drop(publisher);
    drop(handle);
    drop(disk);
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn full_sweep_completion_preserves_resweep_when_remote_folders_changed() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
    };
    use notarium_canonical::{CanonicalConfig, CanonicalRuntime};
    use notarium_core::{
        ids::{InstallationId, ProviderResourceId},
        ports::ProviderRuntimeEpochs,
    };

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-sweep-folder-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([0xb1; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        SearchDependencies::new(Arc::new(store), Arc::new(UnusedStructural)),
    );
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([0xb2; 16]),
        incarnation: HistoryIncarnation::from_bytes([0xb2; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let lexical =
        Arc::new(LexicalIndex::create(&layout.create_index_generation(1).unwrap()).unwrap());
    let profile = ModelProfileId::from_bytes([0xb3; 16]);
    let seq = SpaceSeq::new(1).unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), profile.clone(), 64).unwrap();
    epoch
        .seed(SegmentBuilder::new(&profile, 64).unwrap(), seq)
        .unwrap();
    let now = Instant::now();
    let mut disk = Some(Disk {
        layout: layout.clone(),
        manifest: SearchManifest {
            scope,
            tantivy_seq: seq,
            tantivy_commit: lexical.commit_id().unwrap(),
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            active_model: Some(ResolvedEmbeddingTarget {
                model: profile,
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::Remote {
                    provider: ProviderResourceId::from_bytes([0xb4; 16]),
                    runtime_epochs: ProviderRuntimeEpochs {
                        resource: std::num::NonZeroU64::MIN,
                        credential: None,
                    },
                    project: None,
                },
            }),
            vector_seq: Some(seq),
            embeddings_pending: true,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical: Some(lexical),
        epoch: Some(epoch),
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        full_sweep_after: Some(NoteId::from_bytes([1; 16])),
        full_sweep_needed: true,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    });
    let handle = Arc::new(SpaceHandle::new());
    let cx = Context {
        services: &engine.services,
        handle: &handle,
    };
    let mut publisher = Publisher {
        handle: &handle,
        old: Vec::new(),
    };
    let mut model_check_due = false;
    let mut retry_model = false;
    let mut model_retry_at = now;
    let mut model_retry_delay = Duration::from_secs(1);
    let mut embedder_retry_at = now;
    let mut repair_at = now;
    let mut repair_delay = Duration::from_secs(1);

    // Final full-sweep page with a concurrent remote folder move must stay scheduled from the start.
    handle_bg_done(
        &cx,
        &mut publisher,
        &mut disk,
        &layout,
        BgOutcome::EmbedBatch(Ok(update::EmbedBatchOutcome::Applied {
            rows: Vec::new(),
            requeue: Vec::new(),
            missing_folders: BTreeSet::new(),
            next_sweep_after: None,
            was_full_sweep: true,
            had_transient_failure: false,
        })),
        BgDirty {
            notes: HashSet::new(),
            folders: BTreeSet::from([FolderId::from_bytes([0xb5; 16])]),
        },
        &mut model_check_due,
        &mut retry_model,
        &mut model_retry_at,
        &mut model_retry_delay,
        &mut embedder_retry_at,
        &mut repair_at,
        &mut repair_delay,
    )
    .await
    .unwrap();
    let current = disk.as_ref().unwrap();
    assert!(current.full_sweep_needed);
    assert!(current.full_sweep_after.is_none());
    assert!(current.manifest.embeddings_pending);

    // Intermediate full-sweep page with a folder change must also reset the sweep cursor to None.
    handle_bg_done(
        &cx,
        &mut publisher,
        &mut disk,
        &layout,
        BgOutcome::EmbedBatch(Ok(update::EmbedBatchOutcome::Applied {
            rows: Vec::new(),
            requeue: Vec::new(),
            missing_folders: BTreeSet::new(),
            next_sweep_after: Some(NoteId::from_bytes([2; 16])),
            was_full_sweep: true,
            had_transient_failure: false,
        })),
        BgDirty {
            notes: HashSet::new(),
            folders: BTreeSet::from([FolderId::from_bytes([0xb6; 16])]),
        },
        &mut model_check_due,
        &mut retry_model,
        &mut model_retry_at,
        &mut model_retry_delay,
        &mut embedder_retry_at,
        &mut repair_at,
        &mut repair_delay,
    )
    .await
    .unwrap();
    let current = disk.as_ref().unwrap();
    assert!(current.full_sweep_needed);
    assert!(current.full_sweep_after.is_none());
    assert!(current.manifest.embeddings_pending);

    // Final page with no folder changes clears full_sweep_needed and embeddings_pending.
    handle_bg_done(
        &cx,
        &mut publisher,
        &mut disk,
        &layout,
        BgOutcome::EmbedBatch(Ok(update::EmbedBatchOutcome::Applied {
            rows: Vec::new(),
            requeue: Vec::new(),
            missing_folders: BTreeSet::new(),
            next_sweep_after: None,
            was_full_sweep: true,
            had_transient_failure: false,
        })),
        BgDirty::default(),
        &mut model_check_due,
        &mut retry_model,
        &mut model_retry_at,
        &mut model_retry_delay,
        &mut embedder_retry_at,
        &mut repair_at,
        &mut repair_delay,
    )
    .await
    .unwrap();
    let current = disk.as_ref().unwrap();
    assert!(!current.full_sweep_needed);
    assert!(current.full_sweep_after.is_none());
    assert!(!current.manifest.embeddings_pending);

    publisher.replace(None);
    drop(publisher);
    drop(disk);
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn idle_embedder_stays_unloaded_during_non_embedding_writes_until_wake() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
    };
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CreateFolderSpec, CreateSpaceSpec,
        changes::SyntheticNoteSpec,
    };
    use notarium_core::{
        auth::SpaceKind,
        ids::{InstallationId, LeaseEpoch, PrincipalId},
        model::Lifecycle,
    };
    use std::collections::BTreeMap;

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-embed-idle-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([0xc1; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let owner = PrincipalId::from_bytes([0xc2; 16]);
    let root_folder = FolderId::from_bytes([0xc3; 16]);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0xc4; 16]),
            incarnation: HistoryIncarnation::from_bytes([0xc4; 16]),
            root_folder_id: root_folder.clone(),
            slug: "embed-idle".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![SyntheticNoteSpec {
                note_id: NoteId::from_bytes([0xc5; 16]),
                parent_folder: Some(root_folder.clone()),
                slug: "idle-note".into(),
                title: "Idle note".into(),
                doc_class: DocClass::UserDoc,
                lifecycle: Lifecycle::Active,
                carrier: "# Idle note\n\nsteady body".into(),
                fields: BTreeMap::new(),
            }],
        )
        .await
        .unwrap();

    let engine = SearchEngine::start(
        SearchConfig::new(root, VectorMode::DeterministicTest { dimension: 64 }),
        SearchDependencies::new(store.clone(), Arc::new(UnusedStructural)),
    );
    let handle = Arc::new(SpaceHandle::new());
    let worker_services = engine.services.clone();
    let worker_handle = handle.clone();
    let worker_scope = space.scope.clone();
    let task = tokio::spawn(async move {
        let cx = Context {
            services: &worker_services,
            handle: &worker_handle,
        };
        let mut publisher = Publisher {
            handle: &worker_handle,
            old: Vec::new(),
        };
        let schedule = Schedule {
            tick: Duration::from_millis(20),
            lexical_idle: Duration::from_secs(5),
            embedder_idle: Duration::from_millis(50),
            worker_idle: Duration::from_secs(300),
            archived_idle: Duration::from_secs(30),
        };
        consume(&cx, &mut publisher, &Weak::new(), worker_scope, schedule).await
    });

    let mut epochs = handle.epoch.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.seq >= seeded.last_seq
                && state.embedder.is_some()
                && !state.embeddings_pending
            {
                break;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();

    // Wait for embedder_idle to release the embedder while lexical stays open.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.embedder.is_none()
            {
                break;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();

    // Folder-only writes keep lexical active but must not trigger an embedder reload loop.
    let (_, _, folder_seq) = store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: FolderId::from_bytes([0xc6; 16]),
            parent: Some(root_folder),
            slug: "folder-write".into(),
            display_name: "Folder write".into(),
            is_project: false,
            project_slug: None,
            actor: owner,
            timestamp: None,
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.seq >= folder_seq
            {
                break;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    let steady = handle.published.load_full().unwrap();
    assert_eq!(steady.seq, folder_seq);
    assert!(
        steady.embedder.is_none(),
        "embedder must stay unloaded across idle ticks and non-embedding writes"
    );

    // An interactive Wake reloads the active embedder on demand.
    handle.wake.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.embedder.is_some()
            {
                break;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();

    handle.stop.cancel();
    assert!(matches!(
        task.await.unwrap(),
        Ok(None) | Err(IndexError::Port(PortError::Cancelled(_)))
    ));
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn purge_resync_acknowledges_before_model_refresh_preventing_lagged_livelock() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
        ports::{RemoteIndexingGrant, SearchModelResolverPort},
    };
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CreateSpaceSpec,
        changes::{DEFAULT_BROADCAST_CAPACITY, SyntheticNoteSpec},
    };
    use notarium_core::{
        auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
        classes::{ProviderAudience, ProviderPolicy},
        ids::{
            CommandKey, GrantId, InstallationId, LeaseEpoch, PrincipalId, ProviderResourceId,
            RequestId,
        },
        model::{FolderRef, Lifecycle},
        ports::{
            DeleteDisposition, DeleteNote, EmbeddingInput, EmbeddingProviderPort, EmbeddingRequest,
            EmbeddingResult, Mutation, NoteWritePort, ProviderRuntimeEpochs, ProviderUsage,
            ServiceAuthority,
        },
        receipt::CommandIdentity,
    };
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::atomic::{AtomicBool, AtomicUsize},
    };
    use tokio::sync::Notify;

    struct StaticResolver;
    impl SearchModelResolverPort for StaticResolver {
        fn resolve_model<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            _: &'a HistoryScope,
            _: Option<&'a ModelProfileId>,
            _: &'a CallBudget,
        ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
            Box::pin(async {
                Ok(Some(ResolvedEmbeddingTarget {
                    model: ModelProfileId::from_bytes([0xd0; 16]),
                    dimension: 64,
                    max_input_tokens: 512,
                    backend: EmbeddingBackendTarget::Remote {
                        provider: ProviderResourceId::from_bytes([0xd1; 16]),
                        runtime_epochs: ProviderRuntimeEpochs {
                            resource: std::num::NonZeroU64::MIN,
                            credential: None,
                        },
                        project: None,
                    },
                }))
            })
        }

        fn acquire_remote_indexing_grant<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            scope: &'a HistoryScope,
            actor: &'a PrincipalId,
            provider: &'a ProviderResourceId,
            _: Option<&'a FolderRef>,
            budget: CallBudget,
        ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
            Box::pin(async move {
                let grant = SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                };
                let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
                    actor.clone(),
                    GrantId::from_bytes([0xd2; 16]),
                    BTreeMap::from([(scope.space_id.clone(), grant)]),
                    true,
                ));
                let ctx = SpaceContext::new(auth, scope.clone(), budget).unwrap();
                Ok(Some(RemoteIndexingGrant {
                    ctx,
                    policy: ProviderPolicy {
                        provider: provider.clone(),
                        audience: ProviderAudience::Personal { consented: true },
                        allowed_classes: BTreeSet::from([DocClass::UserDoc]),
                    },
                }))
            })
        }
    }

    #[derive(Default)]
    struct BlockingProvider {
        parts: AtomicUsize,
        block_next_part: AtomicBool,
        part_started: Notify,
        release_part: Notify,
    }
    impl EmbeddingProviderPort for BlockingProvider {
        fn query_disclosure(
            &self,
            _: SpaceContext,
            _: ProviderResourceId,
            _: ModelProfileId,
            _: Option<FolderRef>,
        ) -> PortFuture<'_, BTreeSet<DocClass>> {
            Box::pin(async { Ok(BTreeSet::from([DocClass::UserDoc])) })
        }

        fn embed(
            &self,
            ctx: SpaceContext,
            request: EmbeddingRequest,
        ) -> PortFuture<'_, EmbeddingResult> {
            Box::pin(async move {
                if !matches!(&request.inputs[..], [EmbeddingInput::Query(_)]) {
                    self.parts.fetch_add(request.inputs.len(), Ordering::SeqCst);
                    if self.block_next_part.swap(false, Ordering::SeqCst) {
                        self.part_started.notify_one();
                        tokio::select! {
                            () = self.release_part.notified() => {},
                            () = ctx.budget.cancellation.cancelled() => {
                                return Err(DomainError::AccessDenied.into());
                            }
                        }
                    }
                }
                let mut vector = vec![0.0; 64];
                vector[0] = 1.0;
                Ok(EmbeddingResult {
                    model: request.model,
                    dimension: 64,
                    vectors: vec![Ok(vector); request.inputs.len()],
                    usage: ProviderUsage::Unknown,
                })
            })
        }
    }

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-purge-lag-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([0xd3; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let owner = PrincipalId::from_bytes([0xd4; 16]);
    let lease = LeaseEpoch::new(1).unwrap();
    let folder_a = FolderId::from_bytes([0xd5; 16]);
    let space_a = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0xd6; 16]),
            incarnation: HistoryIncarnation::from_bytes([0xd6; 16]),
            root_folder_id: folder_a.clone(),
            slug: "purge-target".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let space_b = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0xd7; 16]),
            incarnation: HistoryIncarnation::from_bytes([0xd7; 16]),
            root_folder_id: FolderId::from_bytes([0xd8; 16]),
            slug: "noisy-peer".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let victim = NoteId::from_bytes([0xd9; 16]);
    let survivor = NoteId::from_bytes([0xda; 16]);
    let (seeded, revisions) = store
        .commit_synthetic_note_batch_for_test(
            &space_a.scope,
            lease,
            &owner,
            vec![
                SyntheticNoteSpec {
                    note_id: victim.clone(),
                    parent_folder: Some(folder_a.clone()),
                    slug: "victim".into(),
                    title: "Victim".into(),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: "# Victim\n\nsecret payload to purge".into(),
                    fields: BTreeMap::new(),
                },
                SyntheticNoteSpec {
                    note_id: survivor,
                    parent_folder: Some(folder_a),
                    slug: "survivor".into(),
                    title: "Survivor".into(),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: "# Survivor\n\ndistinct surviving document".into(),
                    fields: BTreeMap::new(),
                },
            ],
        )
        .await
        .unwrap();

    let provider = Arc::new(BlockingProvider::default());
    let mut deps = SearchDependencies::new(store.clone(), Arc::new(UnusedStructural));
    deps.model_resolver = Some(Arc::new(StaticResolver));
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    engine.start_space(space_a.scope.clone()).unwrap();
    let layout = SearchLayout::open(&root, space_a.scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= seeded.last_seq
                && manifest.vector_seq.is_some()
                && !manifest.embeddings_pending
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap();

    let parts_before = provider.parts.load(Ordering::SeqCst);
    provider.block_next_part.store(true, Ordering::SeqCst);

    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner.clone(),
        GrantId::from_bytes([0xdb; 16]),
        BTreeMap::from([(space_a.scope.space_id.clone(), grant)]),
        true,
    ));
    let ctx = SpaceContext::new(
        auth,
        space_a.scope.clone(),
        CallBudget {
            request: RequestId::from_bytes([0xdc; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(10),
        },
    )
    .unwrap();
    let key_bytes = [0xdd; 16];
    let mut purge_req = Mutation {
        identity: CommandIdentity {
            scope: space_a.scope.clone(),
            actor: owner,
            key: CommandKey::from_bytes(key_bytes),
            hash: ContentDigest::from_bytes(*blake3::hash(&key_bytes).as_bytes()),
        },
        preconditions: Default::default(),
        input: DeleteNote {
            note: victim,
            disposition: DeleteDisposition::Purge,
        },
    };
    purge_req.preconditions.revision = Some(revisions[0].1.clone());
    let purged = store.delete_note(ctx, purge_req).await.unwrap();

    tokio::time::timeout(Duration::from_secs(10), provider.part_started.notified())
        .await
        .unwrap();
    assert!(
        store
            .min_consumer_watermark(&space_a.scope.space_id, &space_a.scope.incarnation)
            .is_some_and(|seq| seq >= purged.receipt.seq()),
        "PurgeResync must acknowledge scrubbed lexical seed before ModelRefresh finishes"
    );

    // Overflow the shared process-wide BroadcastHub via another Space while
    // Space A's post-purge ModelRefresh is paused; it must not re-scrub/restart.
    let mut peer_seq = space_b.last_seq;
    for _ in 0..=(DEFAULT_BROADCAST_CAPACITY + 16) {
        peer_seq = peer_seq.checked_next().unwrap();
        store
            .fast_forward_space_to_seq_for_test(&space_b.scope, lease, peer_seq)
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        provider.parts.load(Ordering::SeqCst),
        parts_before + 1,
        "BroadcastHub lag must not cancel and restart post-purge ModelRefresh"
    );

    provider.release_part.notify_one();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= purged.receipt.seq()
                && manifest.vector_seq.is_some()
                && !manifest.embeddings_pending
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(provider.parts.load(Ordering::SeqCst), parts_before + 1);

    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn draining_gate_serializes_replacement_worker_until_evicted_worker_exits() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
    };
    use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CreateSpaceSpec};
    use notarium_core::{
        auth::SpaceKind,
        ids::{InstallationId, LeaseEpoch, PrincipalId},
    };

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-drain-gate-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([0xe1; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let owner = PrincipalId::from_bytes([0xe2; 16]);
    let lease = LeaseEpoch::new(1).unwrap();
    let space_a = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0xe3; 16]),
            incarnation: HistoryIncarnation::from_bytes([0xe3; 16]),
            root_folder_id: FolderId::from_bytes([0xe4; 16]),
            slug: "drain-a".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let space_b = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0xe5; 16]),
            incarnation: HistoryIncarnation::from_bytes([0xe5; 16]),
            root_folder_id: FolderId::from_bytes([0xe6; 16]),
            slug: "drain-b".into(),
            kind: SpaceKind::Personal,
            owner,
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();

    let engine = SearchEngine::start(
        SearchConfig::new(root, VectorMode::Disabled),
        SearchDependencies::new(store, Arc::new(UnusedStructural)),
    )
    .with_max_open_spaces(1);

    let gate = engine.hold_drain_gate(space_a.scope.space_id.clone());
    let handle_a = engine.space(space_a.scope.clone()).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        handle_a.published.load_full().is_none(),
        "replacement worker must wait on per-Space drain gate before opening disk"
    );

    engine.release_held_drain_gate(&space_a.scope.space_id, &gate);
    let mut epochs_a = handle_a.epoch.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if handle_a.published.load_full().is_some() {
                break;
            }
            epochs_a.changed().await.unwrap();
        }
    })
    .await
    .unwrap();

    // Opening Space B evicts Space A under max_open_spaces = 1; immediately
    // re-opening Space A must serialize cleanly behind the evicted worker.
    let handle_b = engine.space(space_b.scope.clone()).unwrap();
    let mut epochs_b = handle_b.epoch.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if handle_b.published.load_full().is_some() {
                break;
            }
            epochs_b.changed().await.unwrap();
        }
    })
    .await
    .unwrap();

    let handle_a2 = engine.space(space_a.scope.clone()).unwrap();
    let mut epochs_a2 = handle_a2.epoch.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if handle_a2.published.load_full().is_some() {
                break;
            }
            epochs_a2.changed().await.unwrap();
        }
    })
    .await
    .unwrap();

    engine.shutdown().await;
    assert_eq!(engine.worker_count(), 0);
    assert_eq!(engine.draining_and_bg_count(), (0, 0));
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn failed_embedder_load_respects_retry_backoff_without_busy_spin() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
        ports::{RemoteIndexingGrant, SearchModelResolverPort},
    };
    use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CreateSpaceSpec};
    use notarium_core::{
        auth::SpaceKind,
        ids::{InstallationId, LeaseEpoch, PrincipalId, ProviderResourceId},
        model::FolderRef,
        ports::ServiceAuthority,
    };

    struct FixedTargetResolver(ResolvedEmbeddingTarget);
    impl SearchModelResolverPort for FixedTargetResolver {
        fn resolve_model<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            _: &'a HistoryScope,
            _: Option<&'a ModelProfileId>,
            _: &'a CallBudget,
        ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
            let target = self.0.clone();
            Box::pin(async move { Ok(Some(target)) })
        }

        fn acquire_remote_indexing_grant<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            _: &'a HistoryScope,
            _: &'a PrincipalId,
            _: &'a ProviderResourceId,
            _: Option<&'a FolderRef>,
            _: CallBudget,
        ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
            Box::pin(async { Ok(None) })
        }
    }

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-embed-backoff-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([0xf1; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let owner = PrincipalId::from_bytes([0xf2; 16]);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0xf3; 16]),
            incarnation: HistoryIncarnation::from_bytes([0xf3; 16]),
            root_folder_id: FolderId::from_bytes([0xf4; 16]),
            slug: "embed-backoff".into(),
            kind: SpaceKind::Personal,
            owner,
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;

    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let lexical =
        Arc::new(LexicalIndex::create(&layout.create_index_generation(1).unwrap()).unwrap());
    layout
        .persist_folder_dictionary(&FolderDictionary::default())
        .unwrap();
    let profile = ModelProfileId::from_bytes([0xf5; 16]);
    let seq = SpaceSeq::ZERO;
    let mut epoch = VectorEpoch::open(layout.clone(), profile.clone(), 64).unwrap();
    epoch
        .seed(SegmentBuilder::new(&profile, 64).unwrap(), seq)
        .unwrap();
    let target = ResolvedEmbeddingTarget {
        model: profile,
        dimension: 64,
        max_input_tokens: 512,
        backend: EmbeddingBackendTarget::LocalOnnx,
    };
    let manifest = SearchManifest {
        scope: scope.clone(),
        tantivy_seq: seq,
        tantivy_commit: lexical.commit_id().unwrap(),
        active_index_dir: crate::layout::index_name(1),
        tokenizer_version: TOKENIZER_VERSION,
        active_model: Some(target.clone()),
        vector_seq: Some(seq),
        embeddings_pending: true,
    };
    layout.publish_search(&manifest).unwrap();

    // Pure timer invariant: when embedder is unloaded with pending embeddings,
    // next_maintenance_wake must wait until repair_at.max(embedder_retry_at)
    // instead of returning a past repair_at in a 0ns busy-spin.
    let now = Instant::now();
    let disk = Disk {
        layout,
        manifest,
        folders: Arc::new(FolderDictionary::default()),
        lexical: Some(lexical),
        epoch: Some(epoch),
        embedder: None,
        dirty_notes: BTreeSet::from([NoteId::from_bytes([0xf6; 16])]),
        cached_vectors: HashMap::new(),
        full_sweep_after: None,
        full_sweep_needed: true,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: true,
    };
    let embedder_retry_at = now + Duration::from_secs(5);
    let model_retry_at = now;
    assert_eq!(
        next_maintenance_wake(
            Some(&disk),
            false,
            false,
            model_retry_at,
            embedder_retry_at,
            now,
        ),
        Some(embedder_retry_at),
        "failed LoadEmbedder backoff must gate repair wake timer"
    );
    let later_repair = now + Duration::from_secs(10);
    assert_eq!(
        next_maintenance_wake(
            Some(&disk),
            false,
            false,
            model_retry_at,
            embedder_retry_at,
            later_repair,
        ),
        Some(later_repair)
    );
    assert_eq!(
        next_maintenance_wake(
            Some(&disk),
            true,
            false,
            model_retry_at,
            embedder_retry_at,
            now,
        ),
        None
    );
    drop(disk);

    // End-to-end check: missing ONNX dylib causes LoadEmbedder to fail and set
    // embedder_unavailable = true without spinning or re-publishing in backoff.
    let mut deps = SearchDependencies::new(store, Arc::new(UnusedStructural));
    deps.model_resolver = Some(Arc::new(FixedTargetResolver(target)));
    let engine = SearchEngine::start_with_schedule(
        SearchConfig::new(
            root,
            VectorMode::DynamicOrt {
                dylib_path: path.join("missing-onnx.so"),
                model_dir: path.join("missing-models"),
            },
        ),
        deps,
        Schedule {
            tick: Duration::from_millis(200),
            lexical_idle: Duration::from_secs(30),
            embedder_idle: Duration::from_secs(60),
            worker_idle: Duration::from_secs(300),
            archived_idle: Duration::from_secs(30),
        },
    );
    let handle = engine.space(scope).unwrap();
    let mut epochs = handle.epoch.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(state) = handle.published.load_full()
                && state.embedder_unavailable
            {
                assert!(state.embedder.is_none());
                assert!(!state.reopening_vectors);
                assert!(state.vectors.is_some());
                break;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let epoch_before = *handle.epoch.borrow();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(*handle.epoch.borrow(), epoch_before);
    let after = handle.published.load_full().unwrap();
    assert!(after.vectors.is_some());
    assert!(after.embedder_unavailable);
    assert!(after.embedder.is_none());
    drop(after);

    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn folder_move_between_full_sweep_pages_resets_full_sweep_after() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
    };
    use notarium_canonical::{CanonicalConfig, CanonicalRuntime};
    use notarium_core::{
        ids::{InstallationId, ProviderResourceId, RevisionId},
        model::Lifecycle,
        ports::{Change, ChangeKind, CommandSeqRange, EntityId, ProviderRuntimeEpochs},
        receipt::MutationEffect,
    };

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-sweep-move-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([0xf7; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        SearchDependencies::new(Arc::new(store), Arc::new(UnusedStructural)),
    );
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([0xf8; 16]),
        incarnation: HistoryIncarnation::from_bytes([0xf8; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let lexical =
        Arc::new(LexicalIndex::create(&layout.create_index_generation(1).unwrap()).unwrap());
    let now = Instant::now();
    let seq1 = SpaceSeq::new(1).unwrap();
    let seq2 = SpaceSeq::new(2).unwrap();
    let seq3 = SpaceSeq::new(3).unwrap();
    let mut disk = Disk {
        layout,
        manifest: SearchManifest {
            scope: scope.clone(),
            tantivy_seq: seq1,
            tantivy_commit: lexical.commit_id().unwrap(),
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            active_model: Some(ResolvedEmbeddingTarget {
                model: ModelProfileId::from_bytes([0xf9; 16]),
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::Remote {
                    provider: ProviderResourceId::from_bytes([0xfa; 16]),
                    runtime_epochs: ProviderRuntimeEpochs {
                        resource: std::num::NonZeroU64::MIN,
                        credential: None,
                    },
                    project: None,
                },
            }),
            vector_seq: Some(seq1),
            embeddings_pending: true,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical: Some(lexical),
        epoch: None,
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        full_sweep_after: Some(NoteId::from_bytes([0x50; 16])),
        full_sweep_needed: true,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    };
    let handle = Arc::new(SpaceHandle::new());
    let cx = Context {
        services: &engine.services,
        handle: &handle,
    };
    let mut publisher = Publisher {
        handle: &handle,
        old: Vec::new(),
    };

    let move_cursor = ChangeCursor {
        scope: scope.clone(),
        after: seq2,
    };
    let moved_folder = FolderId::from_bytes([0xfb; 16]);
    update::apply(
        &cx,
        &mut disk,
        &mut publisher,
        move_cursor.clone(),
        vec![Change {
            cursor: move_cursor,
            command_range: CommandSeqRange::new(seq2, seq2).unwrap(),
            entity: EntityId::Folder(moved_folder.clone()),
            kind: ChangeKind::Move,
            revision: RevisionId::from_bytes([1; 16]),
            lifecycle: Lifecycle::Active,
            class: None,
            effect: MutationEffect::NoRelevantEffect,
        }],
        false,
    )
    .await
    .unwrap();
    assert!(disk.full_sweep_needed);
    assert!(
        disk.full_sweep_after.is_none(),
        "folder move between FullSweep pages must restart sweep from the beginning"
    );
    assert!(disk.manifest.embeddings_pending);

    disk.full_sweep_after = Some(NoteId::from_bytes([0x60; 16]));
    let restore_cursor = ChangeCursor { scope, after: seq3 };
    update::apply(
        &cx,
        &mut disk,
        &mut publisher,
        restore_cursor.clone(),
        vec![Change {
            cursor: restore_cursor,
            command_range: CommandSeqRange::new(seq3, seq3).unwrap(),
            entity: EntityId::Folder(moved_folder),
            kind: ChangeKind::Restore,
            revision: RevisionId::from_bytes([2; 16]),
            lifecycle: Lifecycle::Active,
            class: None,
            effect: MutationEffect::NoRelevantEffect,
        }],
        false,
    )
    .await
    .unwrap();
    assert!(disk.full_sweep_needed);
    assert!(
        disk.full_sweep_after.is_none(),
        "folder restore between FullSweep pages must restart sweep from the beginning"
    );

    publisher.replace(None);
    drop(publisher);
    drop(disk);
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn search_after_embedder_idle_reloads_embedder_without_model_unavailable() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
        ports::SearchCarrierReadPort,
    };
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec,
        changes::SyntheticNoteSpec,
    };
    use notarium_core::{
        DomainResult,
        auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
        classes::ClassEgressFence,
        ids::{GrantId, InstallationId, LeaseEpoch, PrincipalId, ProjectionGeneration, RequestId},
        model::{DenseNodeId, DenseNodeIter, Lifecycle},
        ports::{SearchPort, SearchQuery, ServiceAuthority, ServicePurpose},
        query::{FieldFilterAstV1, Predicate},
        receipt::ReceiptSet,
    };
    use std::collections::BTreeMap;

    struct SingleNoteSnapshot {
        cut: SnapshotCut,
        note: NoteId,
        folder: FolderId,
    }
    impl StructuralSnapshot for SingleNoteSnapshot {
        fn cut(&self) -> &SnapshotCut {
            &self.cut
        }
        fn lookup(&self, note: &NoteId) -> DomainResult<Option<DenseNodeId>> {
            Ok((note == &self.note).then_some(DenseNodeId::new(self.cut.generation, 0)))
        }
        fn note_id(&self, node: DenseNodeId) -> DomainResult<NoteId> {
            if node.index(self.cut.generation)? == 0 {
                Ok(self.note.clone())
            } else {
                Err(DomainError::ResourceNotFound)
            }
        }
        fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
            if node.index(self.cut.generation)? == 0 {
                Ok(DocClass::UserDoc)
            } else {
                Err(DomainError::ResourceNotFound)
            }
        }
        fn folder_subtree<'a>(&'a self, _: &'a FolderId) -> PortFuture<'a, DenseNodeIter<'a>> {
            Box::pin(async { Ok(DenseNodeIter::from_slice(self.cut.generation, &[0])) })
        }
        fn folder_descendants<'a>(&'a self, _: &'a FolderId) -> PortFuture<'a, Vec<FolderId>> {
            Box::pin(async { Ok(vec![self.folder.clone()]) })
        }
        fn enclosing_project<'a>(&'a self, _: &'a FolderId) -> PortFuture<'a, Option<FolderId>> {
            Box::pin(async { Ok(None) })
        }
        fn filter_notes<'a>(
            &'a self,
            _: &'a FieldFilterAstV1,
        ) -> PortFuture<'a, Option<DenseNodeIter<'a>>> {
            Box::pin(async { Ok(None) })
        }
        fn outgoing(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
            Ok(DenseNodeIter::from_slice(self.cut.generation, &[]))
        }
        fn incoming(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
            Ok(DenseNodeIter::from_slice(self.cut.generation, &[]))
        }
    }

    struct SingleNoteStructural {
        store: Arc<CanonicalStore>,
        cut: SnapshotCut,
        note: NoteId,
        folder: FolderId,
    }
    impl StructuralReadPort for SingleNoteStructural {
        fn acquire_snapshot(
            &self,
            _: SpaceContext,
            _: CausalBasis,
        ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
            let snapshot = SingleNoteSnapshot {
                cut: self.cut.clone(),
                note: self.note.clone(),
                folder: self.folder.clone(),
            };
            Box::pin(async move { Ok(Box::new(snapshot) as Box<dyn StructuralSnapshot>) })
        }

        fn is_live_visible<'a>(
            &'a self,
            _: &'a SpaceContext,
            note: &'a NoteId,
        ) -> PortFuture<'a, bool> {
            let visible = note == &self.note;
            Box::pin(async move { Ok(visible) })
        }

        fn hydrate(
            &self,
            ctx: SpaceContext,
            cut: SnapshotCut,
            notes: Vec<NoteId>,
        ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
            Box::pin(async move {
                let carriers = SearchCarrierReadPort::read_note_documents_at_cutoff(
                    &*self.store,
                    ServiceAuthority::admit(ServicePurpose::Search),
                    ctx.budget.clone(),
                    cut.scope,
                    cut.projected_seq,
                    notes,
                )
                .await?;
                Ok(carriers
                    .into_iter()
                    .map(|(_, row)| {
                        let row = row?;
                        let document =
                            ClassEgressFence::search_metadata(row.document.metadata(), ctx.auth())
                                .ok()?;
                        Some(NoteCard {
                            document,
                            title: row.title,
                            path: String::new(),
                            preview: String::new(),
                        })
                    })
                    .collect())
            })
        }
    }

    for (lexical_idle, label) in [
        (Duration::from_secs(5), "lexical_open_embedder_idle"),
        (Duration::from_millis(30), "lexical_and_embedder_idle"),
    ] {
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy).unwrap();
        let path =
            std::env::temp_dir().join(format!("search-ondemand-{label}-{}", hex::encode(entropy)));
        std::fs::create_dir(&path).unwrap();
        let root = DataRoot::new(&path);
        let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
            InstallationId::from_bytes([0xe7; 16]),
            root.clone(),
        ))
        .await
        .unwrap();
        let store = Arc::new(store);
        let owner = PrincipalId::from_bytes([0xe8; 16]);
        let folder = FolderId::from_bytes([0xe9; 16]);
        let note_id = NoteId::from_bytes([0xea; 16]);
        let lease = LeaseEpoch::new(1).unwrap();
        let space = store
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([0xeb; 16]),
                incarnation: HistoryIncarnation::from_bytes([0xeb; 16]),
                root_folder_id: folder.clone(),
                slug: format!("ondemand-{label}"),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: lease,
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let (seeded, _) = store
            .commit_synthetic_note_batch_for_test(
                &space.scope,
                lease,
                &owner,
                vec![SyntheticNoteSpec {
                    note_id: note_id.clone(),
                    parent_folder: Some(folder.clone()),
                    slug: "needle".into(),
                    title: "Idle reload note".into(),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: "# Idle reload note\n\nneedle payload".into(),
                    fields: BTreeMap::new(),
                }],
            )
            .await
            .unwrap();

        let cut = SnapshotCut {
            scope: space.scope.clone(),
            generation: ProjectionGeneration::new(1).unwrap(),
            canonical_seq: seeded.last_seq,
            projected_seq: seeded.last_seq,
        };
        let structural = Arc::new(SingleNoteStructural {
            store: store.clone(),
            cut,
            note: note_id,
            folder,
        });
        let schedule = Schedule {
            tick: Duration::from_millis(20),
            lexical_idle,
            embedder_idle: Duration::from_millis(50),
            worker_idle: Duration::from_secs(300),
            archived_idle: Duration::from_secs(30),
        };
        let engine = SearchEngine::start_with_schedule(
            SearchConfig::new(root, VectorMode::DeterministicTest { dimension: 64 }),
            SearchDependencies::new(store, structural),
            schedule,
        );
        let handle = engine.space(space.scope.clone()).unwrap();
        let mut epochs = handle.epoch.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(state) = handle.published.load_full()
                    && state.seq >= seeded.last_seq
                    && state.vectors.is_some()
                    && state.embedder.is_some()
                    && !state.embeddings_pending
                {
                    break;
                }
                epochs.changed().await.unwrap();
            }
        })
        .await
        .unwrap();

        // Wait for idle release: embedder alone (case 1) or both lexical & embedder (case 2).
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match handle.published.load_full() {
                    None if lexical_idle < Duration::from_secs(1) => break,
                    Some(state)
                        if lexical_idle >= Duration::from_secs(1) && state.embedder.is_none() =>
                    {
                        break;
                    }
                    _ => {}
                }
                epochs.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        if lexical_idle < Duration::from_secs(1) {
            tokio::time::sleep(Duration::from_millis(80)).await;
        }

        let grant = SpaceGrant {
            role: SpaceRole::Owner,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        };
        let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
            owner,
            GrantId::from_bytes([0xec; 16]),
            BTreeMap::from([(space.scope.space_id.clone(), grant)]),
            true,
        ));
        let ctx = SpaceContext::new(
            auth,
            space.scope.clone(),
            CallBudget {
                request: RequestId::from_bytes([0xed; 16]),
                cancellation: Cancellation::default(),
                remaining: Duration::from_secs(5),
            },
        )
        .unwrap();
        let query = SearchQuery {
            text: "needle".to_owned(),
            filter: FieldFilterAstV1 {
                version: 1,
                predicate: Predicate::All(Vec::new()),
            },
            classes: [DocClass::UserDoc].into_iter().collect(),
            folder: None,
            causal: CausalBasis::Exact(ReceiptSet::default()),
            include_chats: false,
            top_k: PageLimit::new(10).unwrap(),
            model: None,
        };
        let result = engine.search(ctx, query).await.unwrap();
        assert!(
            result.degraded.is_none(),
            "first search after idle ({label}) must reload embedder, got {:?}",
            result.degraded
        );
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].card.title, "Idle reload note");

        engine.shutdown().await;
        runtime.shutdown().await.unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }
}
