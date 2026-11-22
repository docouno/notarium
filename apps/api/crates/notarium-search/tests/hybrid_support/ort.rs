use super::{Projection, View, context};
use crate::{
    acknowledged, note,
    onnx_support::{ModelFiles, library},
    query,
    storage::{
        sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
    },
};
use notarium_canonical::{CanonicalStore, CreateSpaceSpec};
use notarium_core::{
    auth::SpaceKind,
    epoch::DataRoot,
    ids::{LeaseEpoch, ModelProfileId, NoteId, PrincipalId, ProviderResourceId, SpaceId, SpaceSeq},
    model::{FolderRef, HistoryScope, SnapshotCut},
    ports::{
        CallBudget, NoteCard, PortFuture, SearchDegradation, SearchPort, ServiceAuthority,
        SpaceContext, StructuralReadPort, StructuralSnapshot,
    },
    receipt::CausalBasis,
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
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

struct LocalResolver(
    RwLock<BTreeMap<SpaceId, ModelProfileId>>,
    std::sync::atomic::AtomicBool,
);

impl SearchModelResolverPort for LocalResolver {
    fn resolve_model<'a>(
        &'a self,
        _: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        explicit: Option<&'a ModelProfileId>,
        _: &'a CallBudget,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            if explicit.is_some() {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            Ok(self
                .0
                .read()
                .unwrap()
                .get(&scope.space_id)
                .filter(|model| explicit.is_none_or(|requested| *model == requested))
                .map(|model| ResolvedEmbeddingTarget {
                    model: model.clone(),
                    dimension: 64,
                    max_input_tokens: 512,
                    backend: if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                        EmbeddingBackendTarget::LocalOnnxCls
                    } else {
                        EmbeddingBackendTarget::LocalOnnx
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
        _: &'a HistoryScope,
        _: &'a PrincipalId,
        _: &'a ProviderResourceId,
        _: Option<&'a FolderRef>,
        _: CallBudget,
    ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
        Box::pin(async { Ok(None) })
    }
}

struct Projections(BTreeMap<SpaceId, Arc<Projection>>);

impl StructuralReadPort for Projections {
    fn acquire_snapshot(
        &self,
        ctx: SpaceContext,
        causal: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        self.0[&ctx.scope().space_id].acquire_snapshot(ctx, causal)
    }

    fn is_live_visible<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        note: &'a NoteId,
    ) -> PortFuture<'a, bool> {
        self.0[&ctx.scope().space_id].is_live_visible(ctx, note)
    }

    fn hydrate(
        &self,
        ctx: SpaceContext,
        cut: SnapshotCut,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
        self.0[&ctx.scope().space_id].hydrate(ctx, cut, notes)
    }
}

async fn seed(
    store: Arc<CanonicalStore>,
    tag: u8,
    title: &str,
    text: &str,
) -> (SpaceContext, SpaceSeq, Arc<Projection>) {
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let id = sample_note_id(tag);
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: format!("ort-search-{tag}"),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let (indexed, _) = store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &owner,
            vec![note(&id, &folder, title, text)],
        )
        .await
        .unwrap();
    let mut snapshot = View::new(space.scope.clone(), folder.clone());
    snapshot.index(id.clone(), folder);
    snapshot.advance(indexed.last_seq);
    let projection = Arc::new(Projection {
        store,
        snapshot: RwLock::new(snapshot),
        live: RwLock::new(BTreeSet::from([id])),
    });
    (context(&space.scope, &owner), indexed.last_seq, projection)
}

pub async fn search_with_dynamic_models(store: Arc<CanonicalStore>, root: DataRoot) {
    let (fast, fast_seq, fast_projection) =
        seed(store.clone(), 0x70, "Warm palette", "reddish zero").await;
    let (slow, slow_seq, slow_projection) = seed(store.clone(), 0x71, "Cool palette", "blue").await;
    let fast_model = ModelProfileId::from_bytes([0x70; 16]);
    let slow_model = ModelProfileId::from_bytes([0x71; 16]);
    let resolver = Arc::new(LocalResolver(
        RwLock::new(BTreeMap::from([
            (fast.scope().space_id.clone(), fast_model.clone()),
            (slow.scope().space_id.clone(), slow_model.clone()),
        ])),
        Default::default(),
    ));
    let projection = Arc::new(Projections(BTreeMap::from([
        (fast.scope().space_id.clone(), fast_projection),
        (slow.scope().space_id.clone(), slow_projection),
    ])));
    let start = |mode| {
        let mut deps = SearchDependencies::new(store.clone(), projection.clone());
        deps.model_resolver = Some(resolver.clone());
        let mut config = SearchConfig::new(root.clone(), mode);
        config.query_embedding_budget = Duration::from_millis(500);
        SearchEngine::start(config, deps)
    };
    let models = ModelFiles::new();
    let disabled = start(VectorMode::Disabled);
    let lexical = disabled
        .search(fast.clone(), query("reddish"))
        .await
        .unwrap();
    assert_eq!(lexical.hits[0].card.title, "Warm palette");
    assert!(lexical.degraded.is_none());
    assert!(
        disabled
            .search(fast.clone(), query("red"))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    disabled.shutdown().await;

    let missing = start(VectorMode::DynamicOrt {
        dylib_path: models.0.join("missing.so"),
        model_dir: models.0.clone(),
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let result = missing
                .search(fast.clone(), query("reddish"))
                .await
                .unwrap();
            assert_eq!(result.hits[0].card.title, "Warm palette");
            if matches!(result.degraded, Some(SearchDegradation::ModelUnavailable)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    missing.shutdown().await;

    let engine = start(VectorMode::DynamicOrt {
        dylib_path: library(),
        model_dir: models.0.clone(),
    });
    engine.start_space(fast.scope().clone()).unwrap();
    let pending = acknowledged(&store, &root, fast.scope(), fast_seq).await;
    assert!(pending.vector_seq.is_none() && pending.embeddings_pending);
    models.install(&fast_model, false);
    models.install(&slow_model, true);
    let layout = SearchLayout::open(&root, fast.scope().clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let manifest = layout.search_manifest().unwrap().unwrap();
            if manifest.vector_seq.is_some() && !manifest.embeddings_pending {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = engine.search(fast.clone(), query("red")).await.unwrap();
            if let Some(hit) = result.hits.first() {
                assert_eq!(hit.card.title, "Warm palette");
                assert!(result.degraded.is_none());
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    acknowledged(&store, &root, fast.scope(), fast_seq).await;
    let zero = engine.search(fast.clone(), query("zero")).await.unwrap();
    assert_eq!(zero.hits[0].card.title, "Warm palette");
    assert!(matches!(
        zero.degraded,
        Some(SearchDegradation::ModelUnavailable)
    ));
    let mut delayed_model = query("reddish");
    delayed_model.model = Some(fast_model.clone());
    let delayed = engine.search(fast.clone(), delayed_model).await.unwrap();
    assert_eq!(delayed.hits[0].card.title, "Warm palette");
    assert!(matches!(
        delayed.degraded,
        Some(SearchDegradation::BudgetExceeded)
    ));
    engine.start_space(slow.scope().clone()).unwrap();
    let slow_cut = acknowledged(&store, &root, slow.scope(), slow_seq).await;
    assert!(slow_cut.vector_seq.is_some());
    assert!(!slow_cut.embeddings_pending);
    let started = Instant::now();
    let timed = engine.search(slow, query("blue")).await.unwrap();
    eprintln!(
        "search-onnx-fallback-elapsed-us {}",
        started.elapsed().as_micros()
    );
    assert_eq!(timed.hits[0].card.title, "Cool palette");
    assert!(matches!(
        timed.degraded,
        Some(SearchDegradation::BudgetExceeded)
    ));
    let after = engine.search(fast.clone(), query("red")).await.unwrap();
    assert_eq!(after.hits[0].card.title, "Warm palette");
    assert!(after.degraded.is_none());

    // The first fixture token has a zero output, the second is a basis vector.
    // Only mean pooling can produce a query embedding from this pair.
    assert!(
        engine
            .search(fast.clone(), query("zero red"))
            .await
            .unwrap()
            .degraded
            .is_none()
    );
    resolver.1.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = engine
                .search(fast.clone(), query("zero red"))
                .await
                .unwrap();
            if matches!(
                layout
                    .search_manifest()
                    .unwrap()
                    .unwrap()
                    .active_model
                    .map(|m| m.backend),
                Some(EmbeddingBackendTarget::LocalOnnxCls)
            ) && matches!(result.degraded, Some(SearchDegradation::ModelUnavailable))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();

    // The replacement graph returns a pooled row even for a zero first token.
    // Changing only the installed profile ID must publish its own vector epoch.
    let replacement = ModelProfileId::from_bytes([0x72; 16]);
    models.install_pooled_2d(&replacement);
    resolver
        .0
        .write()
        .unwrap()
        .insert(fast.scope().space_id.clone(), replacement.clone());
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = engine
                .search(fast.clone(), query("zero red"))
                .await
                .unwrap();
            let manifest = layout.search_manifest().unwrap().unwrap();
            if manifest
                .active_model
                .as_ref()
                .is_some_and(|model| model.model == replacement)
                && result.degraded.is_none()
            {
                assert_eq!(result.hits[0].card.title, "Warm palette");
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    engine.shutdown().await;
}
