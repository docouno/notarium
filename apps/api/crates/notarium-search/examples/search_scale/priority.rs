use super::support::{Fixture, Projection};
use notarium_canonical::{CreateSpaceSpec, changes::SyntheticNoteSpec};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::{DocClass, ProviderAudience, ProviderPolicy},
    ids::{
        FolderId, GrantId, HistoryIncarnation, LeaseEpoch, ModelProfileId, NoteId, PrincipalId,
        ProjectionGeneration, ProviderResourceId, RequestId, SpaceId,
    },
    model::{FolderRef, HistoryScope, Lifecycle, SnapshotCut},
    ports::{
        CallBudget, Cancellation, EmbeddingInput, EmbeddingProviderPort, EmbeddingRequest,
        EmbeddingResult, PageLimit, PortFuture, ProviderRuntimeEpochs, ProviderUsage, SearchPort,
        SearchQuery, ServiceAuthority, SpaceContext,
    },
    query::{FieldFilterAstV1, Predicate},
    receipt::CausalBasis,
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
    collections::{BTreeMap, BTreeSet},
    error::Error,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    Background(usize),
    Query,
}

struct Probe {
    bulk: SpaceId,
    query: SpaceId,
    first: AtomicBool,
    bulk_started: Notify,
    release_bulk: Notify,
    events: Mutex<Vec<Event>>,
}

impl SearchModelResolverPort for Probe {
    fn resolve_model<'a>(
        &'a self,
        _: &'a ServiceAuthority,
        _: &'a HistoryScope,
        _: Option<&'a ModelProfileId>,
        _: &'a CallBudget,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            Ok(Some(ResolvedEmbeddingTarget {
                model: ModelProfileId::from_bytes([0x19; 16]),
                dimension: 64,
                max_input_tokens: 1024,
                backend: EmbeddingBackendTarget::Remote {
                    provider: ProviderResourceId::from_bytes([0x19; 16]),
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
            let ctx = context(actor, scope, budget)?;
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

impl EmbeddingProviderPort for Probe {
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
            if matches!(request.inputs.as_slice(), [EmbeddingInput::Query(_)]) {
                self.events.lock().unwrap().push(Event::Query);
            } else if ctx.scope().space_id != self.query {
                self.events
                    .lock()
                    .unwrap()
                    .push(Event::Background(request.inputs.len()));
                if ctx.scope().space_id == self.bulk && self.first.swap(false, Ordering::SeqCst) {
                    self.bulk_started.notify_one();
                    tokio::select! {
                        () = self.release_bulk.notified() => {},
                        () = ctx.budget.cancellation.cancelled() => {},
                    }
                }
            }
            let mut vector = vec![0.0; 64];
            vector[1] = 1.0;
            Ok(EmbeddingResult {
                model: request.model,
                dimension: 64,
                vectors: vec![Ok(vector); request.inputs.len()],
                usage: ProviderUsage::Unknown,
            })
        })
    }
}

fn context(
    owner: &PrincipalId,
    scope: &HistoryScope,
    budget: CallBudget,
) -> notarium_core::DomainResult<SpaceContext> {
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner.clone(),
        GrantId::from_bytes([1; 16]),
        BTreeMap::from([(
            scope.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        false,
    ));
    SpaceContext::new(auth, scope.clone(), budget)
}

async fn space_with_body(
    fixture: &Fixture,
    tag: u8,
    carrier: String,
) -> Result<Projection, Box<dyn Error>> {
    let root = FolderId::from_bytes([tag; 16]);
    let lease = LeaseEpoch::new(1)?;
    let space = fixture
        .store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([tag; 16]),
            incarnation: HistoryIncarnation::from_bytes([tag; 16]),
            root_folder_id: root.clone(),
            slug: format!("priority-{tag}"),
            kind: SpaceKind::Personal,
            owner: fixture.owner.clone(),
            active_epoch: lease,
            initial_last_seq: Default::default(),
            created_at: None,
        })
        .await?;
    let note = NoteId::from_bytes(1u128.to_be_bytes());
    let (cut, _) = fixture
        .store
        .commit_synthetic_note_batch_for_test(
            &space.scope,
            lease,
            &fixture.owner,
            vec![SyntheticNoteSpec {
                note_id: note.clone(),
                parent_folder: Some(root.clone()),
                slug: "seed".into(),
                title: "Priority exercise".into(),
                doc_class: DocClass::UserDoc,
                lifecycle: Lifecycle::Active,
                carrier,
                fields: BTreeMap::new(),
            }],
        )
        .await?;
    Ok(Projection::single_folder(
        fixture.store.clone(),
        SnapshotCut {
            scope: space.scope,
            generation: ProjectionGeneration::new(1)?,
            canonical_seq: cut.last_seq,
            projected_seq: cut.last_seq,
        },
        root,
        vec![note],
    ))
}

fn multi_quantum_carrier(sections: usize) -> String {
    let mut body = String::from("# Priority exercise\n\n");
    for idx in 1..=sections {
        body.push_str(&format!(
            "## Section {idx:02}\n\nDistinct quantum backfill paragraph {idx:02} for preemption.\n\n"
        ));
    }
    body
}

pub async fn measure(fixture: &Fixture) -> Result<(usize, [usize; 3]), Box<dyn Error>> {
    let query_view = space_with_body(
        fixture,
        0x40,
        "# Priority exercise\n\ninteractive retrieval\n".into(),
    )
    .await?;
    // 24 distinct sections split into a full 16-chunk quantum followed by an
    // 8-chunk tail so interactive search proves preemption mid-note.
    let bulk_view = space_with_body(fixture, 0x42, multi_quantum_carrier(24)).await?;
    let competing_view = space_with_body(
        fixture,
        0x41,
        "# Priority exercise\n\nindependent bulk import\n".into(),
    )
    .await?;
    let query_cut = query_view.cut();
    let bulk_cut = bulk_view.cut();
    let competing_cut = competing_view.cut();
    let probe = Arc::new(Probe {
        bulk: bulk_cut.scope.space_id.clone(),
        query: query_cut.scope.space_id.clone(),
        first: AtomicBool::new(true),
        bulk_started: Notify::new(),
        release_bulk: Notify::new(),
        events: Mutex::new(Vec::new()),
    });
    let mut deps = SearchDependencies::new(fixture.store.clone(), Arc::new(query_view));
    deps.model_resolver = Some(probe.clone());
    deps.providers = Some(probe.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(fixture.root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    engine.start_space(query_cut.scope.clone())?;
    let run = async {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if fixture
                    .store
                    .min_consumer_watermark(
                        &query_cut.scope.space_id,
                        &query_cut.scope.incarnation,
                    )
                    .is_some_and(|seq| seq >= query_cut.projected_seq)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        engine.start_space(bulk_cut.scope.clone())?;
        tokio::time::timeout(Duration::from_secs(30), probe.bulk_started.notified()).await?;
        engine.start_space(competing_cut.scope.clone())?;
        wait_for_queued(&engine, 2).await?;
        let query = engine.search(
            context(
                &fixture.owner,
                &query_cut.scope,
                CallBudget {
                    request: RequestId::from_bytes([0x40; 16]),
                    cancellation: Cancellation::default(),
                    remaining: Duration::from_secs(5),
                },
            )?,
            SearchQuery {
                text: "interactive".into(),
                filter: FieldFilterAstV1 {
                    version: 1,
                    predicate: Predicate::All(Vec::new()),
                },
                classes: BTreeSet::from([DocClass::UserDoc]),
                folder: None,
                causal: CausalBasis::Exact(Default::default()),
                include_chats: false,
                top_k: PageLimit::new(1)?,
                model: Some(ModelProfileId::from_bytes([0x19; 16])),
            },
        );
        let release = async {
            let depths = wait_for_queued(&engine, 0).await?;
            if depths != [1, 0, 1] {
                return Err(format!(
                    "expected one queued request in lanes 0 and 2, observed {depths:?}"
                )
                .into());
            }
            probe.release_bulk.notify_one();
            Ok::<_, Box<dyn Error>>(depths)
        };
        tokio::pin!(query);
        let (response, depths) = tokio::select! {
            _ = &mut query => return Err("interactive embedding completed before the active quantum was released".into()),
            released = release => {
                let depths = released?;
                (query.await?, depths)
            }
        };
        if response.degraded.is_some() {
            return Err("interactive embedding degraded during bounded backfill".into());
        }
        let events = probe.events.lock().unwrap();
        match events.as_slice() {
            [Event::Background(count), Event::Query, ..] if *count == 16 => Ok((*count, depths)),
            other => Err(format!(
                "expected 16-chunk background quantum preempted by interactive query, got {other:?}"
            )
            .into()),
        }
    }
    .await;
    probe.release_bulk.notify_one();
    engine.shutdown().await;
    run
}

async fn wait_for_queued(
    engine: &SearchEngine,
    lane: usize,
) -> Result<[usize; 3], tokio::time::error::Elapsed> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let depths = engine.queued_embeddings();
            if depths[lane] > 0 {
                return depths;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
}
