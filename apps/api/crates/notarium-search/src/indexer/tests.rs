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
