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
        PortFuture, ProviderUsage, SearchDegradation, SearchPort, ServiceAuthority, SpaceContext,
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
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
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
            project: None,
        },
    }
}

struct SwitchingResolver {
    provider: AtomicU8,
    cap: u32,
}

impl SearchModelResolverPort for SwitchingResolver {
    fn resolve_model<'a>(
        &'a self,
        _: &'a HistoryScope,
        _: Option<&'a FolderId>,
        _: Option<&'a ModelProfileId>,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            Ok(Some(remote_target(
                self.provider.load(Ordering::SeqCst),
                self.cap,
            )))
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
struct ModelProvider {
    queries: Mutex<Vec<ProviderResourceId>>,
    parts: AtomicUsize,
    fail_indexing: AtomicBool,
}

impl EmbeddingProviderPort for ModelProvider {
    fn query_disclosure(
        &self,
        _: SpaceContext,
        _: ProviderResourceId,
        _: ModelProfileId,
        _: Option<FolderRef>,
    ) -> PortFuture<'_, BTreeSet<DocClass>> {
        Box::pin(async { Ok(BTreeSet::from([DocClass::UserDoc])) })
    }

    fn embed(&self, _: SpaceContext, request: EmbeddingRequest) -> PortFuture<'_, EmbeddingResult> {
        Box::pin(async move {
            if matches!(&request.inputs[..], [EmbeddingInput::Query(_)]) {
                self.queries.lock().unwrap().push(request.provider.clone());
            } else {
                self.parts.fetch_add(request.inputs.len(), Ordering::SeqCst);
                if self.fail_indexing.load(Ordering::SeqCst) {
                    return Err(DomainError::AccessDenied.into());
                }
            }
            let mut vector = vec![0.0; 64];
            vector[usize::from(request.provider == ProviderResourceId::from_bytes([6; 16]))] = 1.0;
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
    let resolver = Arc::new(SwitchingResolver {
        provider: AtomicU8::new(5),
        cap: 512,
    });
    let provider = Arc::new(ModelProvider::default());
    let carriers = Arc::new(ControlledCarriers::new(store.clone()));
    let start = || {
        let mut deps = SearchDependencies::new(store.clone(), projection.clone());
        deps.model_resolver = Some(resolver.clone());
        deps.providers = Some(provider.clone());
        deps.carriers = carriers.clone();
        SearchEngine::start(
            SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
            deps,
        )
    };
    let ctx = context(&space.scope, &owner);
    let engine = start();
    engine.start_space(space.scope.clone()).unwrap();
    let seeded = acknowledged(&store, &root, &space.scope, seeded.last_seq).await;
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

    carriers.reject_seed.store(true, Ordering::SeqCst);
    resolver.provider.store(6, Ordering::SeqCst);
    let old = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
    assert_eq!(old.hits[0].card.title, "Repeated note");
    tokio::time::timeout(Duration::from_secs(4), carriers.seed_rejected.notified())
        .await
        .unwrap();
    let during = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
    assert_eq!(during.hits[0].card.title, "Repeated note");
    assert!(
        provider
            .queries
            .lock()
            .unwrap()
            .iter()
            .all(|id| id == &ProviderResourceId::from_bytes([5; 16]))
    );
    carriers.release_seed.notify_one();
    carriers.reject_seed.store(false, Ordering::SeqCst);
    let layout = SearchLayout::open(&root, space.scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let _ = engine.search(ctx.clone(), semantic.clone()).await.unwrap();
            if layout.search_manifest().unwrap().unwrap().active_model
                == Some(remote_target(6, 512))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap();
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
    assert_eq!(
        provider.queries.lock().unwrap().last(),
        Some(&ProviderResourceId::from_bytes([6; 16]))
    );
    assert_eq!(provider.parts.load(Ordering::SeqCst), 2);

    provider.fail_indexing.store(true, Ordering::SeqCst);
    let edited = sample_note_id(0x6b);
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
        snapshot.index(edited.clone(), folder);
        snapshot.set_status(edited.clone(), "done");
        snapshot.advance(edit.last_seq);
    }
    projection.live.write().unwrap().insert(edited);
    let before_restart = acknowledged(&store, &root, &space.scope, edit.last_seq).await;
    assert!(before_restart.embeddings_pending);
    engine.shutdown().await;
    provider.fail_indexing.store(false, Ordering::SeqCst);
    let engine = start();
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
    let mut recovered_query = semantic;
    recovered_query.filter.predicate = notarium_core::query::Predicate::Eq {
        key: "status".to_owned(),
        value: notarium_core::value::ScalarValue::String("done".to_owned()),
    };
    let recovered = engine.search(ctx, recovered_query).await.unwrap();
    assert!(recovered.degraded.is_none());
    assert_eq!(recovered.hits[0].card.title, "Recoverable note");
    engine.shutdown().await;
}

struct Resolver {
    model: ModelProfileId,
    provider: ProviderResourceId,
}

impl SearchModelResolverPort for Resolver {
    fn resolve_model<'a>(
        &'a self,
        _: &'a HistoryScope,
        _: Option<&'a FolderId>,
        _: Option<&'a ModelProfileId>,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            Ok(Some(ResolvedEmbeddingTarget {
                model: self.model.clone(),
                dimension: 64,
                max_input_tokens: 1024,
                backend: EmbeddingBackendTarget::Remote {
                    provider: self.provider.clone(),
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
    println!(
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
