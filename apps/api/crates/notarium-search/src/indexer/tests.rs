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

#[test]
fn transient_open_failures_preserve_the_checkpoint() {
    use std::io::{Error, ErrorKind};
    let denied = || Error::from(ErrorKind::PermissionDenied);
    for error in [
        IndexError::from(LayoutError::Io(denied())),
        IndexError::from(VectorError::Io(denied())),
        IndexError::from(LexicalError::Tantivy(tantivy::TantivyError::IoError(
            Arc::new(denied()),
        ))),
        IndexError::from(LexicalError::ReaderUnavailable),
    ] {
        assert!(!error.invalid_checkpoint());
    }
    assert!(IndexError::from(LayoutError::Corrupt).invalid_checkpoint());
    assert!(IndexError::from(VectorError::CorruptIndex).invalid_checkpoint());
}

pub(super) struct UnusedStructural;
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
            remote_admission: None,
            active_model: Some(ResolvedEmbeddingTarget {
                model: profile,
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::LocalOnnx,
            }),
            vector_seq: Some(current),
            vector_replay_after: None,
            embeddings_pending: false,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical_path: PathBuf::new(),
        lexical_idle_retired: true,
        epoch: Some(epoch),
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Idle,
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

        fn remote_indexing_revision<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            _: &'a HistoryScope,
            _: CallBudget,
        ) -> PortFuture<'a, notarium_core::ids::ContentDigest> {
            Box::pin(async { Ok(notarium_core::ids::ContentDigest::from_bytes([0; 32])) })
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
            _: Option<notarium_core::ids::FolderId>,
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
    let mut folders = FolderDictionary::default();
    folders.insert(FolderId::from_bytes([4; 16])).unwrap();
    layout.persist_folder_dictionary(&folders).unwrap();
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
        remote_admission: None,
        active_model: Some(target.clone()),
        vector_seq: Some(base),
        vector_replay_after: None,
        embeddings_pending: false,
    };
    layout.publish_search(&manifest).unwrap();
    drop(lexical);
    let engine = SearchEngine::start(
        SearchConfig::new(
            root.clone(),
            VectorMode::DynamicOrt {
                dylib_path: path.join("runtime"),
                model_dir: path.join("models"),
            },
        ),
        SearchDependencies::new(store.clone(), Arc::new(UnusedStructural)),
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = root
            .search(
                &scope.space_id,
                notarium_core::epoch::SearchIndexKind::Tantivy,
            )
            .join("search_manifest.json");
        let original = std::fs::metadata(&path).unwrap().permissions();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied) {
            let handle = Arc::new(SpaceHandle::new());
            let cx = Context {
                services: &engine.services,
                handle: &handle,
            };
            let result = open_disk(
                &cx,
                &mut Publisher { handle: &handle },
                layout.clone(),
                base,
            )
            .await;
            assert!(matches!(
                result,
                Err(IndexError::Layout(LayoutError::Io(_)))
            ));
            assert_eq!(layout.index_generations().unwrap(), vec![1]);
            assert!(
                layout
                    .epoch_manifest(&target.vector_model())
                    .unwrap()
                    .is_some()
            );
        }
        std::fs::set_permissions(path, original).unwrap();
    }
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
    let base_folders = published.folders.clone();
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
                assert!(Arc::ptr_eq(&base_folders, &state.folders));
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
async fn deferred_edits_replay_after_restart_before_admitting_the_checkpoint() {
    use crate::{SearchDependencies, SearchEngine, config::SearchConfig};
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CreateSpaceSpec, changes::SyntheticNoteSpec,
    };
    use notarium_core::{
        auth::SpaceKind,
        ids::{InstallationId, LeaseEpoch, PrincipalId},
        model::Lifecycle,
    };

    let mut entropy = [0; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-deferred-edits-{}", hex::encode(entropy)));
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
    let owner = PrincipalId::from_bytes([2; 16]);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([3; 16]),
            incarnation: HistoryIncarnation::from_bytes([4; 16]),
            root_folder_id: FolderId::from_bytes([5; 16]),
            slug: "deferred".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let note = |id| NoteId::from_bytes([id; 16]);
    let spec = |id, carrier: &str| SyntheticNoteSpec {
        note_id: note(id),
        parent_folder: None,
        slug: format!("note-{id}"),
        title: format!("Note {id}"),
        doc_class: DocClass::UserDoc,
        lifecycle: Lifecycle::Active,
        carrier: carrier.into(),
        fields: Default::default(),
    };
    let cut = |after| ChangeCursor {
        scope: scope.clone(),
        after,
    };
    let (seed, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            (1..=4).map(|id| spec(id, "seed")).collect(),
        )
        .await
        .unwrap();
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let engine = SearchEngine::start(
        SearchConfig::new(root, VectorMode::DeterministicTest { dimension: 64 }),
        SearchDependencies::new(store.clone(), Arc::new(UnusedStructural)),
    );
    let handle = Arc::new(SpaceHandle::new());
    let cx = Context {
        services: &engine.services,
        handle: &handle,
    };
    let mut publisher = Publisher { handle: &handle };
    let (mut disk, lexical) = build::seed_lexical(&cx, layout.clone(), &cut(seed.last_seq))
        .await
        .unwrap();
    let model = ModelProfileId::from_bytes([6; 16]);
    let chunk = |id| VectorChunk {
        metadata: ChunkMetadata {
            note: note(id),
            key: ContentDigest::from_bytes([id; 32]),
            source: ContentDigest::from_bytes([id; 32]),
            folder: 1,
            class: DocClass::UserDoc,
            context: vec![],
            spans: vec![ByteSpan::new(0, 1).unwrap()],
            tokens: 1,
        },
        vector: QuantizedVector::quantize(&[1.0; 64]).unwrap(),
    };
    let mut segments = SegmentBuilder::new(&model, 64).unwrap();
    for id in 1..=4 {
        segments.push(chunk(id)).unwrap();
    }
    let mut epoch = VectorEpoch::open(layout.clone(), model.clone(), 64).unwrap();
    epoch.seed(segments, seed.last_seq).unwrap();
    drop(epoch);
    disk.manifest.active_model = Some(ResolvedEmbeddingTarget {
        model,
        dimension: 64,
        max_input_tokens: 512,
        backend: EmbeddingBackendTarget::LocalOnnx,
    });
    disk.manifest.vector_seq = Some(seed.last_seq);
    disk.manifest.embeddings_pending = false;
    disk.publish_manifest().await.unwrap();
    disk.embedder_unavailable = true;

    let (edited, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![spec(1, "edited one"), spec(2, "edited two")],
        )
        .await
        .unwrap();
    assert!(
        !catch_up(
            &cx,
            &mut disk,
            &lexical,
            &mut publisher,
            cut(edited.last_seq),
            None,
            false
        )
        .await
        .unwrap()
    );
    let state = handle.published.load_full().unwrap();
    assert_eq!(state.seq, edited.last_seq);
    assert!(state.vectors.is_none() && state.embedder_unavailable && !state.reopening_vectors);
    drop(state);
    publisher.replace(None);
    drop((disk, lexical));

    let (mut disk, lexical) = open_disk(&cx, &mut publisher, layout.clone(), edited.last_seq)
        .await
        .unwrap()
        .unwrap();
    let manifest = layout.search_manifest().unwrap().unwrap();
    assert_eq!(manifest.vector_seq, Some(seed.last_seq));
    assert_eq!(manifest.vector_replay_after.unwrap().after, seed.last_seq);
    assert_eq!(disk.sweep, FullSweep::Idle);
    // Interrupted WAL writes and an epoch checkpoint can each precede the search manifest.
    let mut interrupted = open_vector_epoch(layout.clone(), &manifest).unwrap();
    interrupted
        .apply_batch(edited.last_seq, vec![MutableOperation::Delete(note(1))])
        .unwrap();
    drop(interrupted);
    let recover = || {
        recover_vector_epoch(
            &engine.services,
            &handle.stop,
            layout.clone(),
            manifest.clone(),
        )
    };
    let (mut interrupted, _) = recover().await.unwrap();
    assert!(interrupted.matches_note_chunks(&note(2), &[]));
    interrupted.checkpoint(edited.last_seq).unwrap();
    drop(interrupted);
    let (epoch, replayed) = recover().await.unwrap();
    assert_eq!(replayed, BTreeSet::from([note(1), note(2)]));
    assert!(epoch.matches_note_chunks(&note(4), &[chunk(4)]));

    // Advance the lexical cut once more while the recovered epoch is still private.
    let (live, _) = store
        .commit_synthetic_note_batch_for_test(&scope, lease, &owner, vec![spec(3, "live edit")])
        .await
        .unwrap();
    let mut dirty = BgDirty::default();
    assert!(
        !catch_up(
            &cx,
            &mut disk,
            &lexical,
            &mut publisher,
            cut(live.last_seq),
            Some(&mut dirty),
            true
        )
        .await
        .unwrap()
    );
    assert!(handle.published.load_full().unwrap().vectors.is_none());
    let mut disk = Some(disk);
    handle_bg_done(
        &cx,
        &mut publisher,
        &mut disk,
        &layout,
        BgOutcome::ReopenVectors(Ok((epoch, replayed))),
        dirty,
        &mut false,
        &mut false,
        &mut Instant::now(),
        &mut Duration::from_secs(1),
        &mut Instant::now(),
        &mut Instant::now(),
        &mut Duration::from_secs(1),
    )
    .await
    .unwrap();
    let disk = disk.unwrap();
    let epoch = disk.epoch.as_ref().unwrap();
    assert_eq!(
        disk.dirty_notes,
        BTreeSet::from([note(1), note(2), note(3)])
    );
    assert_eq!(disk.sweep, FullSweep::Idle);
    for id in 1..=3 {
        assert!(epoch.matches_note_chunks(&note(id), &[]));
    }
    assert!(epoch.matches_note_chunks(&note(4), &[chunk(4)]));
    let admitted = layout.search_manifest().unwrap().unwrap();
    assert_eq!(admitted.vector_seq, Some(live.last_seq));
    assert!(admitted.vector_replay_after.is_none());
    publisher.replace(None);
    drop((lexical, disk));
    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn absent_space_worker_exits_before_idempotent_shutdown() {
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
    engine
        .start_space(HistoryScope {
            space_id: SpaceId::from_bytes([0x53; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x54; 16]),
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while engine.worker_count() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a missing Space must release its worker");
    engine.shutdown().await;
    engine.shutdown().await;
    assert_eq!(engine.worker_count(), 0);
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn scheduled_reopen_signals_until_retry_backoff() {
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
            remote_admission: None,
            active_model: Some(ResolvedEmbeddingTarget {
                model: ModelProfileId::from_bytes([0xa2; 16]),
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::LocalOnnx,
            }),
            vector_seq: None,
            vector_replay_after: None,
            embeddings_pending: true,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical_path: lexical.path().to_path_buf(),
        lexical_idle_retired: false,
        epoch: None,
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Idle,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    };
    let handle = Arc::new(SpaceHandle::new());
    let mut publisher = Publisher { handle: &handle };
    // A scheduled opener signals its intent until the worker enters backoff.
    publisher.publish_with(&disk, &lexical, true);
    assert!(handle.published.load_full().unwrap().reopening_vectors);

    publisher.publish_with(&disk, &lexical, false);
    assert!(!handle.published.load_full().unwrap().reopening_vectors);

    disk.manifest.vector_seq = Some(seq);
    let retry_at = now + Duration::from_secs(5);
    assert!(next_vector_open(&disk, now, retry_at, now, EMBEDDER_IDLE).is_none());
    publisher.publish_with(&disk, &lexical, false);
    assert!(!handle.published.load_full().unwrap().reopening_vectors);
    assert!(matches!(
        next_vector_open(&disk, retry_at, retry_at, now, EMBEDDER_IDLE),
        Some(BgKind::ReopenVectors)
    ));

    publisher.replace(None);
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
            remote_admission: None,
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
            vector_replay_after: None,
            embeddings_pending: true,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical_path: lexical.path().to_path_buf(),
        lexical_idle_retired: false,
        epoch: Some(epoch),
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Scanning {
            after: NoteId::from_bytes([1; 16]),
            repeat: false,
        },
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    });
    let handle = Arc::new(SpaceHandle::new());
    let cx = Context {
        services: &engine.services,
        handle: &handle,
    };
    let mut publisher = Publisher { handle: &handle };
    let mut model_check_due = false;
    let mut retry_model = false;
    let mut model_retry_at = now;
    let mut model_retry_delay = Duration::from_secs(1);
    let mut embedder_retry_at = now;
    let mut repair_at = now;
    let mut repair_delay = Duration::from_secs(1);

    let page = |after: Option<u8>| {
        BgOutcome::EmbedBatch(Ok(update::EmbedBatchOutcome::Applied {
            rows: Vec::new(),
            requeue: Vec::new(),
            missing_folders: BTreeSet::new(),
            next_sweep_after: after.map(|id| NoteId::from_bytes([id; 16])),
            was_full_sweep: true,
            had_transient_failure: false,
        }))
    };
    let scanning = |id, repeat| FullSweep::Scanning {
        after: NoteId::from_bytes([id; 16]),
        repeat,
    };
    let admission = |id| {
        BgOutcome::ModelRefresh(Ok(build::ModelRefreshOutcome::AdmissionChanged(
            ContentDigest::from_bytes([id; 32]),
        )))
    };
    // Keep moving through distinct pages despite admission and folder changes,
    // including a change while the final page is in flight. One clean pass
    // after the latest change must suffice to clear the durable pending bit.
    for (outcome, moved, expected) in [
        (page(Some(2)), true, scanning(2, true)),
        (admission(1), false, scanning(2, true)),
        (page(Some(3)), false, scanning(3, true)),
        (admission(2), false, scanning(3, true)),
        (page(None), true, FullSweep::Requested),
        (page(Some(2)), false, scanning(2, false)),
        (page(Some(3)), false, scanning(3, false)),
        (page(None), false, FullSweep::Idle),
    ] {
        let mut dirty = BgDirty::default();
        if moved {
            dirty.folders.insert(FolderId::from_bytes([0xb5; 16]));
        }
        handle_bg_done(
            &cx,
            &mut publisher,
            &mut disk,
            &layout,
            outcome,
            dirty,
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
        assert_eq!(current.sweep, expected);
        assert_eq!(
            current.manifest.embeddings_pending,
            expected != FullSweep::Idle
        );
    }
    let saved = layout.search_manifest().unwrap().unwrap();
    assert!(!saved.embeddings_pending);
    assert_eq!(
        saved.remote_admission,
        Some(ContentDigest::from_bytes([2; 32]))
    );

    publisher.replace(None);
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

        fn remote_indexing_revision<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            _: &'a HistoryScope,
            _: CallBudget,
        ) -> PortFuture<'a, notarium_core::ids::ContentDigest> {
            Box::pin(async { Ok(notarium_core::ids::ContentDigest::from_bytes([0; 32])) })
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
            _: Option<notarium_core::ids::FolderId>,
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

        fn remote_indexing_revision<'a>(
            &'a self,
            _: &'a ServiceAuthority,
            _: &'a HistoryScope,
            _: CallBudget,
        ) -> PortFuture<'a, notarium_core::ids::ContentDigest> {
            Box::pin(async { Ok(notarium_core::ids::ContentDigest::from_bytes([0; 32])) })
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
        remote_admission: None,
        active_model: Some(target.clone()),
        vector_seq: Some(seq),
        vector_replay_after: None,
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
        lexical_path: lexical.path().to_path_buf(),
        lexical_idle_retired: false,
        epoch: Some(epoch),
        embedder: None,
        dirty_notes: BTreeSet::from([NoteId::from_bytes([0xf6; 16])]),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Requested,
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
            true,
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
            true,
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
async fn folder_moves_preserve_the_current_full_sweep_cursor() {
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
            remote_admission: None,
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
            vector_replay_after: None,
            embeddings_pending: true,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical_path: lexical.path().to_path_buf(),
        lexical_idle_retired: false,
        epoch: None,
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Scanning {
            after: NoteId::from_bytes([0x50; 16]),
            repeat: false,
        },
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    };
    let handle = Arc::new(SpaceHandle::new());
    let cx = Context {
        services: &engine.services,
        handle: &handle,
    };
    let mut publisher = Publisher { handle: &handle };

    let move_cursor = ChangeCursor {
        scope: scope.clone(),
        after: seq2,
    };
    let moved_folder = FolderId::from_bytes([0xfb; 16]);
    update::apply(
        &cx,
        &mut disk,
        &lexical,
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
    assert_eq!(
        disk.sweep,
        FullSweep::Scanning {
            after: NoteId::from_bytes([0x50; 16]),
            repeat: true
        }
    );
    assert!(disk.manifest.embeddings_pending);

    disk.sweep.finish_page(Some(NoteId::from_bytes([0x60; 16])));
    let restore_cursor = ChangeCursor { scope, after: seq3 };
    update::apply(
        &cx,
        &mut disk,
        &lexical,
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
    assert_eq!(
        disk.sweep,
        FullSweep::Scanning {
            after: NoteId::from_bytes([0x60; 16]),
            repeat: true
        }
    );
    assert!(disk.manifest.embeddings_pending);

    publisher.replace(None);
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
        cut: Mutex<SnapshotCut>,
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
                cut: self.cut.lock().unwrap().clone(),
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
            cut: Mutex::new(cut),
            note: note_id.clone(),
            folder,
        });
        let schedule = Schedule {
            tick: Duration::from_millis(20),
            lexical_idle,
            embedder_idle: Duration::from_millis(50),
            worker_idle: Duration::from_secs(300),
            archived_idle: Duration::from_secs(30),
        };
        let start = || {
            SearchEngine::start_with_schedule(
                SearchConfig::new(
                    root.clone(),
                    VectorMode::DeterministicTest { dimension: 64 },
                ),
                SearchDependencies::new(store.clone(), structural.clone()),
                schedule,
            )
        };
        let engine = start();
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
            owner.clone(),
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
        let result = engine.search(ctx.clone(), query.clone()).await.unwrap();
        assert!(
            result.degraded.is_none(),
            "first search after idle ({label}) must reload embedder, got {:?}",
            result.degraded
        );
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].card.title, "Idle reload note");

        engine.shutdown().await;
        #[cfg(unix)]
        if lexical_idle == Duration::from_secs(5) {
            use std::os::unix::fs::PermissionsExt;
            let layout = SearchLayout::open(&root, space.scope.clone()).unwrap();
            let manifest = layout.search_manifest().unwrap().unwrap();
            let model = manifest.active_model.as_ref().unwrap().vector_model();
            let checkpoint = layout
                .model_epoch(&model)
                .unwrap()
                .join("epoch_manifest.json");
            let original = layout.epoch_manifest(&model).unwrap().unwrap();
            let permissions = std::fs::metadata(&checkpoint).unwrap().permissions();
            std::fs::set_permissions(&checkpoint, std::fs::Permissions::from_mode(0o000)).unwrap();
            if std::fs::read(&checkpoint)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
            {
                let engine = start();
                let pinned = engine.pin_space(space.scope.clone()).unwrap();
                let handle = &pinned.handle;
                let mut changed = handle.epoch.subscribe();
                tokio::time::timeout(
                    Duration::from_secs(5),
                    changed.wait_for(|_| {
                        handle
                            .published
                            .load()
                            .as_ref()
                            .is_some_and(|state| state.embedder_unavailable)
                    }),
                )
                .await
                .expect("the failed vector reopen must publish lexical availability")
                .unwrap();
                let result = engine.search(ctx.clone(), query.clone()).await.unwrap();
                assert!(matches!(
                    result.degraded,
                    Some(notarium_core::ports::SearchDegradation::ModelUnavailable)
                ));
                assert_eq!(result.hits[0].card.title, "Idle reload note");
                assert_eq!(
                    layout.search_manifest().unwrap().unwrap().vector_seq,
                    manifest.vector_seq
                );
                let (edit, _) = store
                    .commit_synthetic_note_batch_for_test(
                        &space.scope,
                        lease,
                        &owner,
                        vec![SyntheticNoteSpec {
                            note_id: note_id.clone(),
                            parent_folder: None,
                            slug: "needle".into(),
                            title: "Edited during backoff".into(),
                            doc_class: DocClass::UserDoc,
                            lifecycle: Lifecycle::Active,
                            carrier: "needle in edited payload".into(),
                            fields: BTreeMap::new(),
                        }],
                    )
                    .await
                    .unwrap();
                {
                    let mut cut = structural.cut.lock().unwrap();
                    cut.projected_seq = edit.last_seq;
                    cut.canonical_seq = edit.last_seq;
                }
                tokio::time::timeout(
                    Duration::from_secs(3),
                    changed.wait_for(|_| {
                        handle.published.load().as_ref().is_some_and(|state| {
                            state.seq == edit.last_seq
                                && state.vectors.is_none()
                                && !state.reopening_vectors
                        })
                    }),
                )
                .await
                .expect("the edit must publish during vector backoff")
                .unwrap();
                let deferred = layout.search_manifest().unwrap().unwrap();
                assert_eq!(deferred.vector_seq, manifest.vector_seq);
                assert_eq!(
                    deferred.vector_replay_after.unwrap().after,
                    manifest.tantivy_seq
                );
                let result = engine.search(ctx.clone(), query.clone()).await.unwrap();
                assert!(matches!(
                    result.degraded,
                    Some(notarium_core::ports::SearchDegradation::ModelUnavailable)
                ));
                assert_eq!(result.hits[0].card.title, "Edited during backoff");
                std::fs::set_permissions(&checkpoint, permissions.clone()).unwrap();
                tokio::time::timeout(
                    Duration::from_secs(10),
                    changed.wait_for(|_| {
                        handle.published.load().as_ref().is_some_and(|state| {
                            state.embedder.is_some()
                                && state.vectors.is_some()
                                && !state.embeddings_pending
                        })
                    }),
                )
                .await
                .expect("the worker must retry the retained checkpoint")
                .unwrap();
                assert!(engine.search(ctx, query).await.unwrap().degraded.is_none());
                assert_eq!(
                    layout
                        .epoch_manifest(&model)
                        .unwrap()
                        .unwrap()
                        .active_segments,
                    original.active_segments
                );
                drop(pinned);
                engine.shutdown().await;
            }
            std::fs::set_permissions(&checkpoint, permissions).unwrap();
        }
        runtime.shutdown().await.unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[tokio::test]
async fn reconcile_reopening_clears_stale_flag_when_non_reopening_bg_task_spawns() {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path =
        std::env::temp_dir().join(format!("search-reconcile-reopen-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([0xf0; 16]),
        incarnation: HistoryIncarnation::from_bytes([0xf0; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let lexical =
        Arc::new(LexicalIndex::create(&layout.create_index_generation(1).unwrap()).unwrap());
    let profile = ModelProfileId::from_bytes([0xf1; 16]);
    let seq = SpaceSeq::new(1).unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), profile.clone(), 64).unwrap();
    epoch
        .seed(SegmentBuilder::new(&profile, 64).unwrap(), seq)
        .unwrap();
    let now = Instant::now();
    let disk = Disk {
        layout,
        manifest: SearchManifest {
            scope,
            tantivy_seq: seq,
            tantivy_commit: lexical.commit_id().unwrap(),
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            remote_admission: None,
            active_model: Some(ResolvedEmbeddingTarget {
                model: profile,
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::LocalOnnx,
            }),
            vector_seq: Some(seq),
            vector_replay_after: None,
            embeddings_pending: false,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical_path: lexical.path().to_path_buf(),
        lexical_idle_retired: false,
        epoch: Some(epoch),
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Idle,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: true,
    };
    let handle = Arc::new(SpaceHandle::new());
    let mut publisher = Publisher { handle: &handle };

    // Simulate stale reopening_vectors = true published during resume_reader
    // followed by spawning a non-reopening BgKind::ModelRefresh task.
    publisher.publish_with(&disk, &lexical, true);
    assert!(handle.published.load_full().unwrap().reopening_vectors);

    let bg = Some(BgTask {
        kind: BgKind::ModelRefresh,
        cancel: Cancellation::default(),
        dirty: BgDirty::default(),
        handle: tokio::spawn(async {
            BgOutcome::ModelRefresh(Ok(build::ModelRefreshOutcome::Unchanged))
        }),
    });
    reconcile_reopening(&mut publisher, &disk, &bg, true);
    let published = handle.published.load_full().unwrap();
    assert!(
        !published.reopening_vectors,
        "stale reopening_vectors must clear when a non-reopening BgTask spawns"
    );
    assert!(published.embedder_unavailable);
    drop(published);
    if let Some(task) = bg {
        let _ = task.handle.await;
    }

    // Reopening BgTask (LoadEmbedder) must keep reopening_vectors = true.
    let reopen_bg = Some(BgTask {
        kind: BgKind::LoadEmbedder,
        cancel: Cancellation::default(),
        dirty: BgDirty::default(),
        handle: tokio::spawn(async { BgOutcome::LoadEmbedder(None) }),
    });
    reconcile_reopening(&mut publisher, &disk, &reopen_bg, true);
    assert!(handle.published.load_full().unwrap().reopening_vectors);
    if let Some(task) = reopen_bg {
        let _ = task.handle.await;
    }

    // When nothing spawned, stale reopening_vectors must also clear.
    reconcile_reopening(&mut publisher, &disk, &None, false);
    assert!(!handle.published.load_full().unwrap().reopening_vectors);

    publisher.replace(None);
    drop(handle);
    drop(disk);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn disabled_vector_mode_never_schedules_maintenance_wake_on_pending_manifest() {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-disabled-wake-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([0xf2; 16]),
        incarnation: HistoryIncarnation::from_bytes([0xf2; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let lexical =
        Arc::new(LexicalIndex::create(&layout.create_index_generation(1).unwrap()).unwrap());
    let now = Instant::now();
    let disk = Disk {
        layout,
        manifest: SearchManifest {
            scope,
            tantivy_seq: SpaceSeq::new(1).unwrap(),
            tantivy_commit: lexical.commit_id().unwrap(),
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            remote_admission: None,
            active_model: Some(ResolvedEmbeddingTarget {
                model: ModelProfileId::from_bytes([0xf3; 16]),
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::LocalOnnx,
            }),
            vector_seq: None,
            vector_replay_after: None,
            embeddings_pending: true,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical_path: lexical.path().to_path_buf(),
        lexical_idle_retired: false,
        epoch: None,
        embedder: None,
        dirty_notes: BTreeSet::from([NoteId::from_bytes([0xf4; 16])]),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Requested,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    };

    assert_eq!(
        next_maintenance_wake(Some(&disk), false, false, true, now, now, now),
        None,
        "VectorMode::Disabled must never schedule a 0ns maintenance wake timer"
    );
    assert_eq!(
        next_maintenance_wake(Some(&disk), false, true, false, now, now, now),
        Some(now),
        "enabled vector mode still schedules pending model backfill wake"
    );

    drop(disk);
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn idle_published_readers_evict_on_demand_across_more_than_32_spaces() {
    use crate::{
        SearchDependencies, SearchEngine,
        config::{SearchConfig, VectorMode},
    };
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CreateSpaceSpec, changes::SyntheticNoteSpec,
    };
    use notarium_core::{
        auth::SpaceKind,
        ids::{InstallationId, LeaseEpoch, PrincipalId},
        model::Lifecycle,
    };
    use std::collections::BTreeMap;

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-reader-evict-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([0xc1; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let store = Arc::new(store);
    let lease = LeaseEpoch::new(1).unwrap();
    let engine = SearchEngine::start_with_schedule(
        SearchConfig::new(root.clone(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), Arc::new(UnusedStructural)),
        Schedule {
            tick: Duration::from_secs(60),
            lexical_idle: Duration::from_secs(300),
            embedder_idle: Duration::from_secs(300),
            worker_idle: Duration::from_secs(300),
            archived_idle: Duration::from_secs(300),
        },
    );

    let mut scopes = Vec::new();
    for index in 1u8..=36 {
        let owner = PrincipalId::from_bytes([index; 16]);
        let folder = FolderId::from_bytes([index; 16]);
        let note_id = NoteId::from_bytes([index; 16]);
        let space = store
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([index; 16]),
                incarnation: HistoryIncarnation::from_bytes([index; 16]),
                root_folder_id: folder.clone(),
                slug: format!("evict-{index}"),
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
                    note_id,
                    parent_folder: Some(folder),
                    slug: "n".into(),
                    title: format!("Note {index}"),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: format!("# Note {index}\n\nspace{index}token"),
                    fields: BTreeMap::new(),
                }],
            )
            .await
            .unwrap();
        let handle = engine.space(space.scope.clone()).unwrap();
        let mut epochs = handle.epoch.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if store
                    .min_consumer_watermark(&space.scope.space_id, &space.scope.incarnation)
                    .is_some_and(|seen| seen >= seeded.last_seq)
                    && handle
                        .published
                        .load()
                        .as_ref()
                        .is_some_and(|state| state.seq >= seeded.last_seq)
                {
                    break;
                }
                let _ = tokio::time::timeout(Duration::from_millis(20), epochs.changed()).await;
            }
        })
        .await
        .expect("space > 32 must evict idle published readers immediately instead of stalling");
        scopes.push((space.scope, seeded.last_seq, handle));
    }

    // The oldest idle space was evicted from published state, and waking it
    // reopens its reader on demand without stalling.
    let (first_scope, first_seq, first_handle) = &scopes[0];
    assert!(
        first_handle.published.load().is_none(),
        "oldest idle space should have been evicted under MAX_READERS pressure"
    );
    let mut epochs = first_handle.epoch.subscribe();
    first_handle.wake.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if first_handle
                .published
                .load()
                .as_ref()
                .is_some_and(|state| state.scope == *first_scope && state.seq >= *first_seq)
            {
                break;
            }
            epochs.changed().await.unwrap();
        }
    })
    .await
    .expect("evicted idle space must reopen immediately on wake");

    engine.shutdown().await;
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn space_handle_idle_eviction_respects_pins_extra_refs_and_replace_if_live() {
    use crate::lexical::IdleReaderOwner;

    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-handle-evict-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([0xd1; 16]),
        incarnation: HistoryIncarnation::from_bytes([0xd1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let index_dir = layout.create_index_generation(1).unwrap();
    let cache = crate::lexical::ReaderCache::default();
    let handle = Arc::new(SpaceHandle::new());
    let owner = Arc::downgrade(&handle) as Weak<dyn IdleReaderOwner>;
    let lexical = cache.create_owned(&index_dir, owner).unwrap();
    let now = Instant::now();
    let disk = Disk {
        layout,
        manifest: SearchManifest {
            scope,
            tantivy_seq: SpaceSeq::new(1).unwrap(),
            tantivy_commit: lexical.commit_id().unwrap(),
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            remote_admission: None,
            active_model: None,
            vector_seq: None,
            vector_replay_after: None,
            embeddings_pending: false,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical_path: lexical.path().to_path_buf(),
        lexical_idle_retired: false,
        epoch: None,
        embedder: None,
        dirty_notes: BTreeSet::new(),
        cached_vectors: HashMap::new(),
        sweep: FullSweep::Idle,
        last_activity: now,
        embedder_last_use: now,
        embedder_unavailable: false,
    };
    let mut publisher = Publisher { handle: &handle };
    publisher.publish_with(&disk, &lexical, false);

    // 1. Extra local stack Arc<LexicalIndex> (active worker) prevents eviction.
    assert!(handle.idle_last_activity(&index_dir).is_none());
    handle.evict_if_idle(&index_dir);
    assert!(handle.published.load().is_some());
    drop(lexical);

    // 2. Pinned query, pinned worker, or active align waiter prevents eviction and idle retirement.
    let pin = handle.pin_query();
    assert!(handle.idle_last_activity(&index_dir).is_none());
    handle.evict_if_idle(&index_dir);
    assert!(!publisher.retire_if_idle());
    assert!(handle.published.load().is_some());
    drop(pin);

    let worker_pin = handle.pin_worker();
    assert!(handle.idle_last_activity(&index_dir).is_none());
    handle.evict_if_idle(&index_dir);
    assert!(!publisher.retire_if_idle());
    assert!(handle.published.load().is_some());
    drop(worker_pin);

    let align_rx = handle.register_align_waiter(SpaceSeq::new(2).unwrap());
    assert!(handle.idle_last_activity(&index_dir).is_none());
    assert!(!publisher.retire_if_idle());
    assert!(handle.published.load().is_some());
    drop(align_rx);

    // 3. Extra Arc<Published> clone (e.g. lingering blocking_search) prevents eviction.
    let lingering = handle.published.load_full().unwrap();
    assert!(handle.idle_last_activity(&index_dir).is_none());
    handle.evict_if_idle(&index_dir);
    assert!(handle.published.load().is_some());
    drop(lingering);

    // 4. Truly idle snapshot reports last_activity, evicts cleanly, and
    //    publish_if_live refuses to resurrect after eviction.
    assert!(handle.idle_last_activity(&index_dir).is_some());
    handle.evict_if_idle(&index_dir);
    assert!(handle.published.load().is_none());
    assert!(
        cache.release(&index_dir).unwrap(),
        "evicted reader must be immediately releasable from ReaderCache"
    );
    publisher.publish_if_live(&disk, false);
    assert!(
        handle.published.load().is_none(),
        "publish_if_live must never resurrect an evicted snapshot"
    );
    handle.drain_published().await;

    drop(disk);
    std::fs::remove_dir_all(path).unwrap();
}
