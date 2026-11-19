use super::{Projection, View, context, context_with_grant};
use crate::{acknowledged, note, query};
use notarium_canonical::{CanonicalStore, CreateFolderSpec, CreateSpaceSpec};
use notarium_core::{
    DomainError,
    auth::{SpaceGrant, SpaceKind, SpaceRole},
    classes::DocClass,
    epoch::DataRoot,
    error::ValidationReason,
    ids::{FolderId, LeaseEpoch, ModelProfileId, PrincipalId, ProviderResourceId, SpaceSeq},
    model::{FolderRef, HistoryScope},
    ports::{
        CallBudget, EmbeddingInput, EmbeddingProviderPort, EmbeddingRequest, EmbeddingResult,
        PortFuture, SearchDegradation, SearchPort, ServiceAuthority, SpaceContext,
    },
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    ports::{
        EmbeddingBackendTarget, RemoteIndexingGrant, ResolvedEmbeddingTarget,
        SearchModelResolverPort,
    },
};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

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
    engine.start_space(space.scope.clone()).unwrap();
    acknowledged(&store, &root, &space.scope, range.last_seq).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);

    let ctx = context(&space.scope, &owner);
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
