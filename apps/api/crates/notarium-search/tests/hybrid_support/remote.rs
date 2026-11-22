mod folder_privacy;
pub use folder_privacy::folder_eligibility;

use super::{ControlledCarriers, Projection, View, context, context_with_grant, status_field};
use crate::{acknowledged, note, query};
use notarium_canonical::{CanonicalStore, CreateFolderSpec, CreateSpaceSpec};
use notarium_core::{
    DomainError,
    auth::{SpaceGrant, SpaceKind, SpaceRole},
    classes::{DocClass, ProviderAudience, ProviderPolicy},
    epoch::{DataRoot, SearchIndexKind},
    error::ValidationReason,
    ids::{FolderId, LeaseEpoch, ModelProfileId, PrincipalId, ProviderResourceId, SpaceSeq},
    model::{FolderRef, HistoryScope},
    ports::{
        CallBudget, EmbeddingInput, EmbeddingProviderPort, EmbeddingRequest, EmbeddingResult,
        PortFuture, ProviderRuntimeEpochs, ProviderUsage, SearchDegradation, SearchPort,
        ServiceAuthority, SpaceContext,
    },
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::SearchLayout,
    ports::{
        EmbeddingBackendTarget, RemoteIndexingGrant, ResolvedEmbeddingTarget,
        SearchModelResolverPort,
    },
};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

fn remote_target(resource: u8, cap: u32) -> ResolvedEmbeddingTarget {
    ResolvedEmbeddingTarget {
        model: ModelProfileId::from_bytes([4; 16]),
        dimension: 64,
        max_input_tokens: cap,
        backend: EmbeddingBackendTarget::Remote {
            provider: ProviderResourceId::from_bytes([resource; 16]),
            runtime_epochs: ProviderRuntimeEpochs {
                resource: std::num::NonZeroU64::MIN,
                credential: None,
            },
            project: None,
        },
    }
}

pub(super) struct SwitchingResolver {
    pub(super) model: AtomicU8,
    pub(super) provider: AtomicU8,
    pub(super) runtime_epoch: AtomicU64,
    pub(super) cap: AtomicU32,
    pub(super) project: RwLock<Option<FolderRef>>,
    pub(super) grant_project: RwLock<Option<FolderRef>>,
    pub(super) deny_project: RwLock<Option<FolderRef>>,
    pub(super) unavailable: AtomicBool,
    pub(super) hold_resolution: AtomicBool,
    pub(super) resolution_started: Notify,
    pub(super) release_resolution: Notify,
    pub(super) hold_grant: AtomicBool,
    pub(super) grant_started: Notify,
    pub(super) release_grant: Notify,
}

impl SwitchingResolver {
    pub(super) fn new(provider: u8, cap: u32) -> Self {
        Self {
            model: AtomicU8::new(4),
            provider: AtomicU8::new(provider),
            runtime_epoch: AtomicU64::new(1),
            cap: AtomicU32::new(cap),
            project: RwLock::new(None),
            grant_project: RwLock::new(None),
            deny_project: RwLock::new(None),
            unavailable: AtomicBool::new(false),
            hold_resolution: AtomicBool::new(false),
            resolution_started: Notify::new(),
            release_resolution: Notify::new(),
            hold_grant: AtomicBool::new(false),
            grant_started: Notify::new(),
            release_grant: Notify::new(),
        }
    }

    fn current_target(&self) -> ResolvedEmbeddingTarget {
        let mut target = remote_target(
            self.provider.load(Ordering::SeqCst),
            self.cap.load(Ordering::SeqCst),
        );
        target.model = ModelProfileId::from_bytes([self.model.load(Ordering::SeqCst); 16]);
        if let EmbeddingBackendTarget::Remote {
            runtime_epochs,
            project,
            ..
        } = &mut target.backend
        {
            runtime_epochs.resource = self
                .runtime_epoch
                .load(Ordering::SeqCst)
                .try_into()
                .unwrap();
            *project = self.project.read().unwrap().clone();
        }
        target
    }
}

impl SearchModelResolverPort for SwitchingResolver {
    fn resolve_model<'a>(
        &'a self,
        _: &'a ServiceAuthority,
        _: &'a HistoryScope,
        _: Option<&'a ModelProfileId>,
        _: &'a CallBudget,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            if self.hold_resolution.swap(false, Ordering::SeqCst) {
                self.resolution_started.notify_one();
                self.release_resolution.notified().await;
            }
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(DomainError::AccessDenied.into());
            }
            Ok(Some(self.current_target()))
        })
    }

    fn acquire_remote_indexing_grant<'a>(
        &'a self,
        _: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        actor: &'a PrincipalId,
        provider: &'a ProviderResourceId,
        actual_project: Option<&'a FolderRef>,
        budget: CallBudget,
    ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
        Box::pin(async move {
            if self
                .grant_project
                .read()
                .unwrap()
                .as_ref()
                .is_some_and(|allowed| actual_project != Some(allowed))
            {
                return Ok(None);
            }
            if self
                .deny_project
                .read()
                .unwrap()
                .as_ref()
                .is_some_and(|denied| actual_project == Some(denied))
            {
                return Ok(None);
            }
            if self.hold_grant.swap(false, Ordering::SeqCst) {
                self.grant_started.notify_one();
                self.release_grant.notified().await;
            }
            let mut ctx = context(scope, actor);
            ctx.budget = budget;
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
pub(super) struct ModelProvider {
    pub(super) queries: Mutex<Vec<ProviderResourceId>>,
    query_folders: Mutex<Vec<Option<FolderId>>>,
    hold_query: AtomicBool,
    query_started: Notify,
    release_query: Notify,
    pub(super) parts: AtomicUsize,
    pub(super) outside_parts: AtomicUsize,
    pub(super) fail_indexing: AtomicBool,
    pub(super) block_next_part: AtomicBool,
    pub(super) part_started: Notify,
    pub(super) release_part: Notify,
    pub(super) project_parts: Mutex<Vec<FolderRef>>,
    pub(super) block_project: Mutex<Option<FolderRef>>,
    pub(super) first_project_batch: Notify,
    pub(super) release_first_project_batch: Notify,
}

impl EmbeddingProviderPort for ModelProvider {
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
            if let [EmbeddingInput::Query(input)] = &request.inputs[..] {
                self.query_folders
                    .lock()
                    .unwrap()
                    .push(input.folder.clone());
                self.queries.lock().unwrap().push(request.provider.clone());
                if self.hold_query.swap(false, Ordering::SeqCst) {
                    self.query_started.notify_one();
                    tokio::select! {
                        () = self.release_query.notified() => {},
                        () = ctx.budget.cancellation.cancelled() => return Err(DomainError::AccessDenied.into()),
                    }
                }
            } else {
                self.parts.fetch_add(request.inputs.len(), Ordering::SeqCst);
                if self.block_next_part.swap(false, Ordering::SeqCst) {
                    self.part_started.notify_one();
                    tokio::select! {
                        () = self.release_part.notified() => {},
                        () = ctx.budget.cancellation.cancelled() => return Err(DomainError::AccessDenied.into()),
                    }
                }
                if let Some(project) = &request.project {
                    self.project_parts.lock().unwrap().push(project.clone());
                    let block = {
                        let mut selected = self.block_project.lock().unwrap();
                        selected.as_ref() == Some(project) && selected.take().is_some()
                    };
                    if block {
                        self.first_project_batch.notify_one();
                        self.release_first_project_batch.notified().await;
                    }
                } else {
                    self.outside_parts
                        .fetch_add(request.inputs.len(), Ordering::SeqCst);
                }
                if self.fail_indexing.load(Ordering::SeqCst) {
                    return Err(DomainError::AccessDenied.into());
                }
            }
            let mut vector = vec![0.0; 64];
            let runtime_epoch = request.runtime_epochs().unwrap().resource.get() as usize;
            let provider_offset =
                usize::from(request.provider == ProviderResourceId::from_bytes([6; 16]));
            vector[2 * runtime_epoch + provider_offset] = 1.0;
            Ok(EmbeddingResult {
                model: request.model,
                dimension: 64,
                vectors: vec![Ok(vector); request.inputs.len()],
                usage: ProviderUsage::Unknown,
            })
        })
    }
}

pub async fn model_epochs_and_repair(store: Arc<CanonicalStore>, root: DataRoot) {
    use crate::storage::{
        sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
    };
    let tag = 0x6a;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "embedding-model-epoch".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let notes: Vec<_> = (1..=101).map(sample_note_id).collect();
    let (seeded, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            notes
                .iter()
                .map(|id| note(id, &folder, "Repeated note", "identical source material"))
                .collect(),
        )
        .await
        .unwrap();
    let mut view = View::new(space.scope.clone(), folder.clone());
    for id in &notes {
        view.index(id.clone(), folder.clone());
    }
    view.advance(seeded.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(notes.into_iter().collect()),
    });
    let resolver = Arc::new(SwitchingResolver::new(5, 512));
    let provider = Arc::new(ModelProvider::default());
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    let start = |resolver: Arc<SwitchingResolver>| {
        let mut deps = SearchDependencies::new(store.clone(), projection.clone());
        deps.model_resolver = Some(resolver);
        deps.providers = Some(provider.clone());
        deps.carriers = carriers.clone();
        SearchEngine::start(
            SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
            deps,
        )
    };
    let ctx = context(&space.scope, &owner);
    let edit_during_work = async |body: &str| {
        let (edit, _) = store
            .commit_synthetic_note_batch_for_test(
                &space.scope,
                lease,
                &owner,
                vec![note(&sample_note_id(1), &folder, "Repeated note", body)],
            )
            .await
            .unwrap();
        projection.snapshot.write().unwrap().advance(edit.last_seq);
        edit.last_seq
    };
    resolver.hold_resolution.store(true, Ordering::SeqCst);
    provider.block_next_part.store(true, Ordering::SeqCst);
    let engine = start(resolver.clone());
    engine.start_space(space.scope.clone()).unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        resolver.resolution_started.notified(),
    )
    .await
    .unwrap();
    let mut short = ctx.clone();
    short.budget.remaining = Duration::from_millis(500);
    let while_resolving = edit_during_work("pausedresolver").await;
    let resolved = engine
        .search(short.clone(), query("pausedresolver"))
        .await
        .unwrap();
    assert_eq!(resolved.cut.projected_seq, while_resolving);
    assert_eq!(resolved.hits[0].card.title, "Repeated note");
    resolver.release_resolution.notify_one();
    tokio::time::timeout(Duration::from_secs(5), provider.part_started.notified())
        .await
        .unwrap();
    let during_seed = edit_during_work("continuousseed").await;
    let changed = engine
        .search(short.clone(), query("continuousseed"))
        .await
        .unwrap();
    assert_eq!(changed.cut.projected_seq, during_seed);
    assert_eq!(changed.hits[0].card.title, "Repeated note");
    let final_cut = edit_during_work("identical source material").await;
    let cold = engine
        .search(short.clone(), query("identical"))
        .await
        .unwrap();
    assert_eq!(cold.hits[0].card.title, "Repeated note");
    assert!(matches!(
        cold.degraded,
        Some(SearchDegradation::EmbeddingsPending)
    ));
    assert_eq!(cold.cut.projected_seq, final_cut);
    provider.release_part.notify_one();
    let seeded = acknowledged(&store, &root, &space.scope, final_cut).await;
    assert_eq!(seeded.vector_seq, Some(final_cut));
    assert!(!seeded.embeddings_pending);
    assert_eq!(
        provider.parts.load(Ordering::SeqCst),
        1,
        "deduplication spans seed pages"
    );
    let semantic = query("vectorprobe");
    assert_eq!(
        engine
            .search(ctx.clone(), semantic.clone())
            .await
            .unwrap()
            .hits[0]
            .card
            .title,
        "Repeated note"
    );

    // The second query resolves A while A's first request occupies the worker.
    // Replace the default before the queued request is allowed to dispatch.
    provider.hold_query.store(true, Ordering::SeqCst);
    let before = provider.queries.lock().unwrap().len();
    let first = engine.search(ctx.clone(), semantic.clone());
    let queued = async {
        provider.query_started.notified().await;
        let second = engine.search(ctx.clone(), query("identical"));
        let switch = async {
            while engine.queued_embeddings()[0] == 0 {
                tokio::task::yield_now().await;
            }
            resolver.provider.store(6, Ordering::SeqCst);
            provider.release_query.notify_one();
        };
        tokio::join!(second, switch).0.unwrap()
    };
    let (first, second) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(first, queued)
    })
    .await
    .unwrap();
    assert!(first.unwrap().degraded.is_none());
    assert!(matches!(
        second.degraded,
        Some(SearchDegradation::EmbeddingsPending)
    ));
    assert_eq!(second.hits[0].card.title, "Repeated note");
    assert_eq!(provider.queries.lock().unwrap().len(), before + 1);
    resolver.provider.store(5, Ordering::SeqCst);

    // Switching models within the same remote provider and runtime epochs keeps
    // serving the previous epoch while the replacement builds.
    carriers.reject_seed.store(true, Ordering::SeqCst);
    resolver.model.store(9, Ordering::SeqCst);
    let same_provider = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
    assert_eq!(same_provider.hits[0].card.title, "Repeated note");
    assert!(same_provider.degraded.is_none());
    tokio::time::timeout(Duration::from_secs(4), carriers.seed_rejected.notified())
        .await
        .unwrap();
    assert!(
        provider
            .queries
            .lock()
            .unwrap()
            .iter()
            .all(|id| id == &ProviderResourceId::from_bytes([5; 16]))
    );

    // Switching to a different remote provider must immediately stop sending
    // query plaintext to the prior provider and serve lexical-only results
    // with EmbeddingsPending until the new epoch activates.
    resolver.model.store(4, Ordering::SeqCst);
    resolver.provider.store(6, Ordering::SeqCst);
    let queries_before_provider_switch = provider.queries.lock().unwrap().len();
    let during = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
    assert!(during.hits.is_empty());
    assert!(matches!(
        during.degraded,
        Some(SearchDegradation::EmbeddingsPending)
    ));
    let lexical_during = engine
        .search(ctx.clone(), query("identical"))
        .await
        .unwrap();
    assert_eq!(lexical_during.hits[0].card.title, "Repeated note");
    assert!(matches!(
        lexical_during.degraded,
        Some(SearchDegradation::EmbeddingsPending)
    ));
    assert_eq!(
        provider.queries.lock().unwrap().len(),
        queries_before_provider_switch
    );
    provider.fail_indexing.store(true, Ordering::SeqCst);
    carriers.release_seed.notify_one();
    carriers.reject_seed.store(false, Ordering::SeqCst);
    let layout = SearchLayout::open(&root, space.scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let probe = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
            assert!(probe.hits.is_empty());
            assert!(matches!(
                probe.degraded,
                Some(SearchDegradation::EmbeddingsPending)
            ));
            assert_eq!(
                provider.queries.lock().unwrap().len(),
                queries_before_provider_switch
            );
            if provider.parts.load(Ordering::SeqCst) > 1
                && layout.index_generations().unwrap() == [seeded.generation().unwrap()]
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    let still_blocked = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
    assert!(still_blocked.hits.is_empty());
    assert!(matches!(
        still_blocked.degraded,
        Some(SearchDegradation::EmbeddingsPending)
    ));
    assert_eq!(
        provider.queries.lock().unwrap().len(),
        queries_before_provider_switch
    );
    assert_eq!(
        layout.search_manifest().unwrap().unwrap().active_model,
        Some(remote_target(5, 512))
    );
    let attempts = provider.parts.load(Ordering::SeqCst);
    provider.block_next_part.store(true, Ordering::SeqCst);
    provider.fail_indexing.store(false, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(8), provider.part_started.notified())
        .await
        .unwrap();
    // Stop the final selection check after the replacement has all its base
    // vectors. Keep changing the same note while that check is suspended.
    resolver.hold_resolution.store(true, Ordering::SeqCst);
    provider.release_part.notify_one();
    tokio::time::timeout(
        Duration::from_secs(8),
        resolver.resolution_started.notified(),
    )
    .await
    .unwrap();
    for term in ["handoffediting", "handofflatest"] {
        let seq = edit_during_work(term).await;
        let hit = engine.search(short.clone(), query(term)).await.unwrap();
        assert_eq!(hit.cut.projected_seq, seq);
        assert_eq!(
            hit.hits[0].card.document.provenance().reference().note_id,
            sample_note_id(1)
        );
        assert_eq!(
            layout.search_manifest().unwrap().unwrap().active_model,
            Some(remote_target(5, 512))
        );
    }
    provider.block_next_part.store(true, Ordering::SeqCst);
    resolver.release_resolution.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let manifest = layout.search_manifest().unwrap().unwrap();
            if manifest.active_model == Some(remote_target(6, 512)) {
                assert!(manifest.embeddings_pending);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let unaffected = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
    assert!(!unaffected.hits.is_empty());
    assert!(
        unaffected
            .hits
            .iter()
            .all(|hit| hit.card.document.provenance().reference().note_id != sample_note_id(1))
    );
    assert_eq!(
        provider.queries.lock().unwrap().last(),
        Some(&ProviderResourceId::from_bytes([6; 16]))
    );
    provider.release_part.notify_one();
    tokio::time::timeout(Duration::from_secs(8), async {
        while layout
            .search_manifest()
            .unwrap()
            .unwrap()
            .embeddings_pending
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    // One base input, one repaired latest input, no restarted backfill.
    assert_eq!(provider.parts.load(Ordering::SeqCst), attempts + 2);
    // Drain the notification stored by the repaired part blocked above so the
    // next `part_started.notified().await` observes the post-restart live edit.
    tokio::time::timeout(Duration::from_secs(5), provider.part_started.notified())
        .await
        .unwrap();

    // A stale caller can start the worker before the first current request.
    // The saved cut belongs to the current incarnation and is reusable.
    engine.shutdown().await;
    let before = layout.search_manifest().unwrap().unwrap();
    let lexical_path = layout.index_dir(&before).unwrap();
    let lexical_files = crate::files(&lexical_path);
    let vector_path = root.search(&space.scope.space_id, SearchIndexKind::Vector);
    let vector_files = crate::files(&vector_path);
    let engine = start(resolver.clone());
    engine
        .start_space(HistoryScope {
            space_id: space.scope.space_id.clone(),
            incarnation: notarium_core::ids::HistoryIncarnation::from_bytes([0xff; 16]),
        })
        .unwrap();
    let restarted = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
    assert!(restarted.degraded.is_none());
    assert_eq!(restarted.hits[0].card.title, "Repeated note");
    assert_eq!(layout.search_manifest().unwrap().unwrap(), before);
    assert_eq!(crate::files(&lexical_path), lexical_files);
    assert_eq!(crate::files(&vector_path), vector_files);
    assert_eq!(provider.parts.load(Ordering::SeqCst), attempts + 2);

    provider.fail_indexing.store(true, Ordering::SeqCst);
    provider.block_next_part.store(true, Ordering::SeqCst);
    let edited = sample_note_id(0x64);
    let mut recovered_note = note(
        &edited,
        &folder,
        "Recoverable note",
        "durable retry content",
    );
    recovered_note.fields = status_field("done");
    let (edit, _) = store
        .commit_synthetic_note_batch_for_test(&space.scope, lease, &owner, vec![recovered_note])
        .await
        .unwrap();
    {
        let mut snapshot = projection.snapshot.write().unwrap();
        snapshot.set_status(edited.clone(), "done");
        snapshot.advance(edit.last_seq);
    }
    projection.live.write().unwrap().insert(edited.clone());
    tokio::time::timeout(Duration::from_secs(5), provider.part_started.notified())
        .await
        .unwrap();
    let mut edited_query = query("durable");
    edited_query.filter.predicate = notarium_core::query::Predicate::Eq {
        key: "status".to_owned(),
        value: notarium_core::value::ScalarValue::String("done".to_owned()),
    };
    let live = engine
        .search(short.clone(), edited_query.clone())
        .await
        .unwrap();
    assert_eq!(live.hits[0].card.title, "Recoverable note");
    assert_eq!(live.cut.projected_seq, edit.last_seq);
    assert!(live.degraded.is_some());

    // Another canonical command can advance the same Space while the first
    // edit is still in the provider. The blocked request is never released.
    let (_, _, next) = store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: sample_folder_id(0xa0),
            parent: Some(folder.clone()),
            slug: "during-embedding".into(),
            display_name: "During embedding".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    projection.snapshot.write().unwrap().advance(next);
    let next_hit = engine.search(short.clone(), edited_query).await.unwrap();
    assert_eq!(next_hit.cut.projected_seq, next);
    assert_eq!(next_hit.hits[0].card.title, "Recoverable note");
    let before_restart = acknowledged(&store, &root, &space.scope, edit.last_seq).await;
    assert!(before_restart.embeddings_pending);
    engine.shutdown().await;
    let orphan = root
        .search(&space.scope.space_id, SearchIndexKind::Vector)
        .join("ffffffffffffffff");
    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join("pending-segment"), b"abandoned epoch").unwrap();
    provider.fail_indexing.store(false, Ordering::SeqCst);
    let engine = start(resolver.clone());
    engine.start_space(space.scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        while layout
            .search_manifest()
            .unwrap()
            .unwrap()
            .embeddings_pending
        {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        !orphan.exists(),
        "reopen must drop an abandoned replacement"
    );
    let mut recovered_query = semantic;
    recovered_query.filter.predicate = notarium_core::query::Predicate::Eq {
        key: "status".to_owned(),
        value: notarium_core::value::ScalarValue::String("done".to_owned()),
    };
    let recovered = engine.search(ctx.clone(), recovered_query).await.unwrap();
    assert!(recovered.degraded.is_none());
    assert_eq!(recovered.hits[0].card.title, "Recoverable note");

    resolver.runtime_epoch.store(2, Ordering::SeqCst);
    let version_two = resolver.current_target();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = engine
                .search(ctx.clone(), query("vectorprobe"))
                .await
                .unwrap();
            if layout
                .search_manifest()
                .unwrap()
                .unwrap()
                .active_model
                .as_ref()
                == Some(&version_two)
                && !result.hits.is_empty()
                && result.degraded.is_none()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();

    let project = sample_folder_id(0x6c);
    store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: project.clone(),
            parent: Some(folder.clone()),
            slug: "embedding-scope".into(),
            display_name: "Embedding scope".into(),
            is_project: true,
            project_slug: Some("embedding-scope".into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let leaving = sample_folder_id(0x6d);
    store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: leaving.clone(),
            parent: Some(project.clone()),
            slug: "leaving".into(),
            display_name: "Leaving".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let revoked_note = sample_note_id(0x6d);
    let scoped_note = sample_note_id(0x6c);
    let (range, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![
                note(&scoped_note, &project, "Project note", "inside scope"),
                note(&revoked_note, &leaving, "Project note", "inside scope"),
            ],
        )
        .await
        .unwrap();
    {
        let mut view = projection.snapshot.write().unwrap();
        view.project(project.clone(), folder.clone());
        view.folder(leaving.clone(), project.clone());
        view.index(scoped_note.clone(), project.clone());
        view.index(revoked_note.clone(), leaving.clone());
        view.advance(range.last_seq);
    }
    projection
        .live
        .write()
        .unwrap()
        .extend([scoped_note.clone(), revoked_note.clone()]);
    acknowledged(&store, &root, &space.scope, range.last_seq).await;
    let previous_outside_parts = provider.outside_parts.load(Ordering::SeqCst);
    let selected_project = FolderRef {
        space_id: space.scope.space_id.clone(),
        folder_id: project.clone(),
    };
    *provider.block_project.lock().unwrap() = Some(selected_project.clone());
    *resolver.project.write().unwrap() = Some(selected_project);
    let narrowed = resolver.current_target();
    let (outside, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![note(
                &edited,
                &folder,
                "Recoverable note",
                "durable retry content changed",
            )],
        )
        .await
        .unwrap();
    projection
        .snapshot
        .write()
        .unwrap()
        .advance(outside.last_seq);
    tokio::time::timeout(
        Duration::from_secs(8),
        provider.first_project_batch.notified(),
    )
    .await
    .unwrap();
    resolver.hold_resolution.store(true, Ordering::SeqCst);
    provider.release_first_project_batch.notify_one();
    tokio::time::timeout(
        Duration::from_secs(8),
        resolver.resolution_started.notified(),
    )
    .await
    .unwrap();
    let pages = carriers.full_seed_pages.load(Ordering::SeqCst);
    let move_and_publish = async |id: &FolderId, destination: &FolderId| {
        use notarium_core::ports::{MoveFolder, NoteWritePort};
        let moved = store
            .move_folder(
                ctx.clone(),
                crate::mutation(
                    &ctx,
                    MoveFolder {
                        folder: id.clone(),
                        new_parent: Some(destination.clone()),
                    },
                ),
            )
            .await
            .unwrap();
        let seq = moved.receipt.seq();
        {
            let mut view = projection.snapshot.write().unwrap();
            view.folder(id.clone(), destination.clone());
            view.advance(seq);
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            while layout.search_manifest().unwrap().unwrap().tantivy_seq < seq {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    };
    // Both notes qualified at the frozen cut. Revoke one while the final
    // model selection is held, then keep moving an unrelated empty folder.
    move_and_publish(&leaving, &folder).await;
    let empty = sample_folder_id(0xa0);
    for destination in [&project, &folder, &project, &folder] {
        move_and_publish(&empty, destination).await;
    }
    resolver.hold_grant.store(true, Ordering::SeqCst);
    resolver.release_resolution.notify_one();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            move_and_publish(&empty, &project).await;
            move_and_publish(&empty, &folder).await;
            if layout
                .search_manifest()
                .unwrap()
                .unwrap()
                .active_model
                .as_ref()
                == Some(&narrowed)
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(carriers.full_seed_pages.load(Ordering::SeqCst), pages);
    assert!(
        layout
            .search_manifest()
            .unwrap()
            .unwrap()
            .embeddings_pending
    );
    let mut scoped = query("vectorprobe");
    scoped.folder = Some(project.clone());
    let hits = engine
        .search(ctx.clone(), scoped.clone())
        .await
        .unwrap()
        .hits;
    assert!(
        hits.iter()
            .any(|hit| hit.card.document.provenance().reference().note_id == scoped_note)
    );
    assert!(
        hits.iter()
            .all(|hit| hit.card.document.provenance().reference().note_id != revoked_note)
    );
    resolver.release_grant.notify_one();
    acknowledged(&store, &root, &space.scope, outside.last_seq).await;
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = engine.search(ctx.clone(), scoped.clone()).await.unwrap();
            if layout
                .search_manifest()
                .unwrap()
                .unwrap()
                .active_model
                .as_ref()
                == Some(&narrowed)
                && result
                    .hits
                    .iter()
                    .any(|hit| hit.card.document.provenance().reference().note_id == scoped_note)
                && result.degraded.is_none()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        provider.outside_parts.load(Ordering::SeqCst),
        previous_outside_parts
    );
    let observed = Arc::new(AtomicBool::new(false));
    projection.snapshot.write().unwrap().blocked_project = Some(observed.clone());
    let mut lexical_only = query("inside scope");
    lexical_only.folder = Some(project.clone());
    let queries_before = provider.queries.lock().unwrap().len();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        engine.search(ctx.clone(), lexical_only),
    )
    .await
    .expect("a blocked provider scope must leave time for lexical hits")
    .unwrap();
    projection.snapshot.write().unwrap().blocked_project = None;
    assert!(observed.load(Ordering::SeqCst));
    assert!(matches!(
        result.degraded,
        Some(SearchDegradation::BudgetExceeded)
    ));
    assert!(
        result
            .hits
            .iter()
            .any(|hit| hit.card.document.provenance().reference().note_id == scoped_note)
    );
    assert_eq!(provider.queries.lock().unwrap().len(), queries_before);
    let keeper = SpaceContext::new(
        ctx.auth()
            .for_keeper(
                notarium_core::ids::AgentRunId::from_bytes([7; 16]),
                space.scope.space_id.clone(),
                Some(project.clone()),
                [notarium_core::ids::AbilityId::from_bytes([8; 16])].into(),
            )
            .unwrap(),
        space.scope.clone(),
        ctx.budget.clone(),
    )
    .unwrap();
    let mut mixed_scope = query("vectorprobe");
    mixed_scope.classes.insert(DocClass::Skill);
    let before = provider.queries.lock().unwrap().len();
    let broad = engine
        .search(keeper.clone(), mixed_scope.clone())
        .await
        .unwrap();
    assert!(matches!(
        broad.degraded,
        Some(SearchDegradation::ProviderUnavailable)
    ));
    assert_eq!(provider.queries.lock().unwrap().len(), before);
    mixed_scope.folder = Some(project.clone());
    let narrow = engine.search(keeper, mixed_scope).await.unwrap();
    assert!(narrow.degraded.is_none());
    assert_eq!(provider.queries.lock().unwrap().len(), before + 1);
    assert_eq!(
        provider.query_folders.lock().unwrap().last(),
        Some(&Some(project))
    );
    engine.shutdown().await;

    let cold_root = DataRoot::new(root.root().join("undersized"));
    std::fs::create_dir(cold_root.root()).unwrap();
    let layout = SearchLayout::open(&cold_root, space.scope.clone()).unwrap();
    let mut deps = SearchDependencies::new(store, projection);
    deps.model_resolver = Some(Arc::new(SwitchingResolver::new(6, 8)));
    deps.providers = Some(provider);
    let undersized =
        SearchEngine::start(SearchConfig::new(cold_root, VectorMode::RemoteOnly), deps);
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = undersized
                .search(ctx.clone(), query("durable retry content"))
                .await
                .unwrap();
            assert!(
                result
                    .hits
                    .iter()
                    .any(|hit| hit.card.title == "Recoverable note")
            );
            if let Some(manifest) = layout.search_manifest().unwrap()
                && manifest.active_model == Some(remote_target(6, 8))
            {
                assert!(manifest.embeddings_pending);
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap();
    undersized.shutdown().await;
}

pub async fn scoped_backfill_recovers_and_rechecks_selection(
    store: Arc<CanonicalStore>,
    root: DataRoot,
) {
    use crate::storage::{
        sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
    };
    let tag = 0x84;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "scoped-backfill-search".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let project = |tag| FolderRef {
        space_id: space.scope.space_id.clone(),
        folder_id: sample_folder_id(tag),
    };
    let (first, next, empty) = (project(tag + 1), project(tag + 2), project(tag + 3));
    let mut view = View::new(space.scope.clone(), folder.clone());
    for (project, slug) in [
        (&first, "previous-selection"),
        (&next, "next-selection"),
        (&empty, "empty-selection"),
    ] {
        store
            .create_folder(CreateFolderSpec {
                scope: space.scope.clone(),
                active_epoch: lease,
                folder_id: project.folder_id.clone(),
                parent: Some(folder.clone()),
                slug: slug.into(),
                display_name: slug.into(),
                is_project: true,
                project_slug: Some(slug.into()),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
        view.project(project.folder_id.clone(), folder.clone());
    }
    let notes = [
        note(
            &sample_note_id(tag + 1),
            &first.folder_id,
            "First Q note",
            "first distinct source from project Q",
        ),
        note(
            &sample_note_id(tag + 2),
            &first.folder_id,
            "Second Q note",
            "second distinct source from project Q",
        ),
        note(
            &sample_note_id(tag + 3),
            &next.folder_id,
            "P note",
            "source from project P",
        ),
    ];
    let mut live = BTreeSet::new();
    for row in &notes {
        view.index(row.note_id.clone(), row.parent_folder.clone().unwrap());
        live.insert(row.note_id.clone());
    }
    let (range, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            notes.into_iter().collect(),
        )
        .await
        .unwrap();
    view.advance(range.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(live),
    });
    let resolver = Arc::new(SwitchingResolver::new(5, 512));
    resolver.unavailable.store(true, Ordering::SeqCst);
    *resolver.project.write().unwrap() = Some(first.clone());
    let provider = Arc::new(ModelProvider::default());
    *provider.block_project.lock().unwrap() = Some(first.clone());
    let mut deps = SearchDependencies::new(store.clone(), projection);
    deps.model_resolver = Some(resolver.clone());
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    engine.start_space(space.scope.clone()).unwrap();
    let pending = acknowledged(&store, &root, &space.scope, range.last_seq).await;
    assert!(pending.embeddings_pending && pending.active_model.is_none());

    // Keep Q's disclosure and provider runtime valid. The first Q batch can
    // finish, but the second note must see the changed project before sending.
    resolver.unavailable.store(false, Ordering::SeqCst);
    tokio::time::timeout(
        Duration::from_secs(8),
        provider.first_project_batch.notified(),
    )
    .await
    .unwrap();
    *resolver.project.write().unwrap() = Some(next.clone());
    provider.release_first_project_batch.notify_one();
    let layout = SearchLayout::open(&root, space.scope.clone()).unwrap();
    let await_model = async |selected: ResolvedEmbeddingTarget| {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Some(manifest) = layout.search_manifest().unwrap()
                    && manifest.active_model.as_ref() == Some(&selected)
                    && manifest.vector_seq.is_some()
                    && !manifest.embeddings_pending
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "model switch to {selected:?} did not finish: {:?}",
                layout.search_manifest()
            )
        });
    };
    // The subscriber must recover from the cold resolver error and complete
    // the switch without support from a query or a new canonical edit.
    await_model(resolver.current_target()).await;
    assert_eq!(
        *provider.project_parts.lock().unwrap(),
        [first.clone(), next]
    );

    // A cap too small for notes outside the selected project is irrelevant:
    // the empty corpus is complete and may replace a ready previous epoch.
    resolver.cap.store(9, Ordering::SeqCst);
    *resolver.project.write().unwrap() = Some(empty);
    let ctx = context(&space.scope, &owner);
    let queries_before = provider.queries.lock().unwrap().len();
    assert!(
        !engine
            .search(ctx, query("source"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    assert_eq!(provider.queries.lock().unwrap().len(), queries_before);
    await_model(resolver.current_target()).await;
    assert_eq!(provider.project_parts.lock().unwrap().len(), 2);
    assert_eq!(provider.outside_parts.load(Ordering::SeqCst), 0);
    engine.shutdown().await;
}

struct Resolver {
    model: ModelProfileId,
    provider: ProviderResourceId,
}

impl SearchModelResolverPort for Resolver {
    fn resolve_model<'a>(
        &'a self,
        _: &'a ServiceAuthority,
        _: &'a HistoryScope,
        _: Option<&'a ModelProfileId>,
        _: &'a CallBudget,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            Ok(Some(ResolvedEmbeddingTarget {
                model: self.model.clone(),
                dimension: 64,
                max_input_tokens: 1024,
                backend: EmbeddingBackendTarget::Remote {
                    provider: self.provider.clone(),
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
        _: &'a HistoryScope,
        _: &'a PrincipalId,
        _: &'a ProviderResourceId,
        _: Option<&'a FolderRef>,
        _: CallBudget,
    ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
        Box::pin(async { Ok(None) })
    }
}

#[derive(Default)]
struct SlowProvider {
    calls: AtomicUsize,
    cancelled: Notify,
}

impl EmbeddingProviderPort for SlowProvider {
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
            assert!(
                matches!(&request.inputs[..], [EmbeddingInput::Query(input)] if input.classes == BTreeSet::from([DocClass::UserDoc]))
            );
            assert!(ctx.budget.remaining <= Duration::from_millis(150));
            self.calls.fetch_add(1, Ordering::SeqCst);
            ctx.budget.cancellation.cancelled().await;
            self.cancelled.notify_one();
            Err(DomainError::validation(ValidationReason::BudgetExceeded).into())
        })
    }
}

pub async fn lexical_fallback(store: Arc<CanonicalStore>, root: DataRoot) {
    use crate::storage::{
        sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
    };
    let owner = sample_principal_id(0x61);
    let folder = sample_folder_id(0x61);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x61),
            incarnation: sample_incarnation(0x61),
            root_folder_id: folder.clone(),
            slug: "search-provider-fallback".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let home = sample_folder_id(0x64);
    let foreign = sample_folder_id(0x65);
    for (id, slug) in [(&home, "allowed-project"), (&foreign, "excluded-project")] {
        store
            .create_folder(CreateFolderSpec {
                scope: space.scope.clone(),
                active_epoch: lease,
                folder_id: id.clone(),
                parent: None,
                slug: slug.to_owned(),
                display_name: slug.to_owned(),
                is_project: true,
                project_slug: Some(slug.to_owned()),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let source = sample_note_id(0x61);
    let (range, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![note(&source, &folder, "Local result", "evidencekeyword")],
        )
        .await
        .unwrap();
    let mut view = View::new(space.scope.clone(), folder.clone());
    view.folder(home.clone(), folder.clone());
    view.folder(foreign.clone(), folder.clone());
    view.index(source.clone(), folder);
    view.advance(range.last_seq);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([source])),
    });
    let provider = Arc::new(SlowProvider::default());
    let mut deps = SearchDependencies::new(store.clone(), projection);
    deps.model_resolver = Some(Arc::new(Resolver {
        model: ModelProfileId::from_bytes([4; 16]),
        provider: ProviderResourceId::from_bytes([5; 16]),
    }));
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    let ctx = context(&space.scope, &owner);
    let mut encrypted = query("evidencekeyword");
    encrypted.classes = BTreeSet::from([DocClass::EncryptedNote]);
    let encrypted = engine.search(ctx.clone(), encrypted).await.unwrap();
    assert!(encrypted.hits.is_empty() && encrypted.degraded.is_none());
    assert_eq!(encrypted.cut.projected_seq, range.last_seq);
    assert!(
        !root
            .search(&space.scope.space_id, SearchIndexKind::Tantivy)
            .exists()
    );
    engine.start_space(space.scope.clone()).unwrap();
    acknowledged(&store, &root, &space.scope, range.last_seq).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);

    let useless = engine.search(ctx.clone(), query("---")).await.unwrap();
    assert!(useless.hits.is_empty() && useless.degraded.is_none());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    let scoped = context_with_grant(
        &space.scope,
        &owner,
        SpaceGrant {
            role: SpaceRole::Viewer,
            read_classes: BTreeSet::from([DocClass::UserDoc]),
            write_classes: BTreeSet::new(),
            project_root: Some(home),
        },
    );
    let mut outside = query("evidencekeyword");
    outside.folder = Some(foreign);
    let outside = engine.search(scoped, outside).await.unwrap();
    assert!(outside.hits.is_empty());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);

    let mut unfiltered = query("evidencekeyword");
    unfiltered.classes.clear();
    let started = Instant::now();
    let hits = tokio::time::timeout(
        Duration::from_secs(2),
        engine.search(ctx.clone(), unfiltered),
    )
    .await
    .expect("the lexical response returned while provider work was pending")
    .unwrap();
    eprintln!(
        "search-fallback-elapsed-us {}",
        started.elapsed().as_micros()
    );
    assert_eq!(hits.hits[0].card.title, "Local result");
    assert!(matches!(
        hits.degraded,
        Some(SearchDegradation::BudgetExceeded)
    ));
    tokio::time::timeout(Duration::from_secs(1), provider.cancelled.notified())
        .await
        .unwrap();
    ctx.auth().taint().mark_external_read();
    let hits = engine.search(ctx, query("evidencekeyword")).await.unwrap();
    assert_eq!(hits.hits[0].card.title, "Local result");
    assert!(matches!(
        hits.degraded,
        Some(SearchDegradation::ProviderUnavailable)
    ));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    engine.shutdown().await;
}
