//! Exercise search against the production structural reader and control-plane
//! provider services on both storage backends.
#[path = "../../notarium-canonical/tests/support/mod.rs"]
mod support;

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
    PgConnectConfig, S3BucketModePolicy, UpdateSpaceSchema, blobs::s3::admin_ensure_bucket,
    build_pg_connect_options,
};
use notarium_control::{
    keyring::{Keyring, KeyringLocation},
    outbound::{NetworkPolicy, OutboundTransport, PrivateNetworkRule},
    service::{
        AuthenticationMode, ControlConfig, ControlService, SystemClock,
        provider::{ProviderConfig, ProviderService},
    },
    store::{ControlStore, PostgresConfig, TargetRecord},
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SecretString, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::{AbilityKind, DocClass, ProviderCurrentContent, ProviderOrigin},
    epoch::{DataRoot, EpochClassification, EpochReason, StorageEpochState},
    error::PortError,
    ids::*,
    model::{FolderRef, HistoryScope, Lifecycle},
    ports::{
        AccountContext, AppendChat, AuthEvidence, AuthEvidenceKind, BootstrapAccount, CallBudget,
        Cancellation, ChatEntryKind, ChatInputBody, ChatPort, ChatThreadKind, CreateChat,
        CreateNote, EmptyRootAuthorization, MaintenanceContext, MoveFolder, Mutation,
        NoteWritePort, PageLimit, PortFuture, PreAuthContext, PreferenceModelKind,
        ProviderAttachmentTarget, ProviderDisclosure, ProviderDisclosureConsent,
        ProviderEgressCatalogPort, ProviderEgressLease, ProviderEgressRequest, ProviderLimits,
        ProviderModelKind, ProviderModelSpec, ProviderPreferenceScope, ProviderResourceSpec,
        ProviderWireKind, PublishAbilityPackage, PutProviderModel, RecallQuery,
        RequestProviderAttachment, RevocationLease, RevocationReason, RevocationSelector,
        SearchPort, SearchQuery, SearchResult, ServiceAuthority, ServicePurpose,
        SessionRevocationPort, SetProviderPreference, SpaceContext, TokenAccountingProfile,
        control::{AccountMutation, ControlPageRequest, RunLimits},
    },
    query::{FieldFilterAstV1, FieldSchema, FieldType, Predicate, ScalarType},
    receipt::{
        AccountCommandIdentity, AwaitWatermarks, CausalBasis, CommandIdentity,
        MutationReceiptToken, ReceiptSet,
    },
    value::ScalarValue,
};
use notarium_projections::{ProjectionConfig, ProjectorRuntime};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::SearchLayout,
    ports::{
        EmbeddingBackendTarget, RemoteIndexingGrant, ResolvedEmbeddingTarget,
        SearchModelResolverPort,
    },
};
use sqlx::Connection as _;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::{StorageTestFixtures, TempDataRoot, maintenance_ctx, random_bytes_16};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn mutation<T>(owner: &SpaceContext, input: T) -> Mutation<T> {
    let key = CommandKey::from_bytes(random_bytes_16());
    Mutation {
        identity: CommandIdentity {
            scope: owner.scope().clone(),
            actor: owner.auth().principal().clone(),
            hash: ContentDigest::from_bytes(*blake3::hash(key.as_str().as_bytes()).as_bytes()),
            key,
        },
        preconditions: Default::default(),
        input,
    }
}

fn account_command(owner: &PrincipalId, expected: ControlRevision) -> AccountCommandIdentity {
    let entropy = random_bytes_16();
    AccountCommandIdentity {
        owner: owner.clone(),
        actor: owner.clone(),
        key: CommandKey::from_bytes(entropy),
        hash: ContentDigest::from_bytes(*blake3::hash(&entropy).as_bytes()),
        expected,
    }
}

fn query(scope: &HistoryScope, after: SpaceSeq, text: &str) -> SearchQuery {
    SearchQuery {
        text: text.to_owned(),
        causal: CausalBasis::Await(AwaitWatermarks::from_receipts([MutationReceiptToken::new(
            scope.clone(),
            after,
        )
        .unwrap()])),
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::All(Vec::new()),
        },
        classes: Default::default(),
        folder: None,
        model: None,
        include_chats: false,
        top_k: PageLimit::new(10).unwrap(),
    }
}

fn ids(result: &SearchResult) -> Vec<&NoteId> {
    result
        .hits
        .iter()
        .map(|hit| &hit.card.document.provenance().reference().note_id)
        .collect()
}

async fn create_note(
    store: &CanonicalStore,
    owner: &SpaceContext,
    folder: Option<&FolderId>,
    class: DocClass,
    slug: &str,
    carrier: &str,
) -> (NoteId, MutationReceiptToken) {
    let res = store
        .create_note(
            owner.clone(),
            mutation(
                owner,
                CreateNote {
                    note: NoteId::from_bytes(random_bytes_16()),
                    parent: folder.cloned(),
                    class,
                    slug: slug.to_owned(),
                    carrier: carrier.to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    (res.value.note, res.receipt)
}

async fn exercise(store: CanonicalStore, root: DataRoot, projector: ProjectorRuntime) {
    let store = Arc::new(store);
    let principal = PrincipalId::from_bytes(random_bytes_16());
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes(random_bytes_16()),
            incarnation: HistoryIncarnation::from_bytes(random_bytes_16()),
            root_folder_id: FolderId::from_bytes(random_bytes_16()),
            slug: "search-space".into(),
            kind: SpaceKind::Personal,
            owner: principal.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let owner = SpaceContext::new(
        EngineAuthContext::for_human(
            VerifiedHuman::attest(
                principal.clone(),
                GrantId::from_bytes(random_bytes_16()),
                BTreeMap::from([(
                    space.scope.space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Owner,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: None,
                    },
                )]),
                true,
            )
            .with_human_management(true),
        ),
        space.scope.clone(),
        maintenance_ctx(ServicePurpose::Search).budget,
    )
    .unwrap();
    let project = FolderId::from_bytes(random_bytes_16());
    let (_, folder_rev, _) = store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: project.clone(),
            parent: None,
            slug: "project".into(),
            display_name: "Project".into(),
            is_project: true,
            project_slug: Some("project".into()),
            actor: principal.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let (inside, _) = create_note(
        &store,
        &owner,
        Some(&project),
        DocClass::UserDoc,
        "inside",
        "---\ntitle: Inside\nweight: 7\n---\nThe concordance marker.\n",
    )
    .await;
    let (outside, _) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "outside",
        "---\ntitle: Outside\nweight: malformed\n---\nThe concordance marker.\n",
    )
    .await;
    store
        .update_space_schema(
            owner.clone(),
            mutation(
                &owner,
                UpdateSpaceSchema {
                    schema_note: NoteId::from_bytes(random_bytes_16()),
                    parent: None,
                    slug: "schema".into(),
                    carrier: "---\ntitle: Schema\n---\n".into(),
                    schema: BTreeMap::from([(
                        "weight".into(),
                        FieldSchema {
                            kind: FieldType::Scalar(ScalarType::Number),
                            nullable: false,
                        },
                    )]),
                    expected_schema_revision: None,
                },
            ),
        )
        .await
        .unwrap();
    let (skill, _) = create_note(
        &store,
        &owner,
        None,
        DocClass::Skill,
        "handbook",
        "---\nclass: skill\ntitle: Handbook\n---\npinnedhandbook\n",
    )
    .await;
    let ability = AbilityId::from_bytes(random_bytes_16());
    store
        .publish_ability_package(
            owner.clone(),
            mutation(
                &owner,
                PublishAbilityPackage {
                    ability: ability.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: skill.clone(),
                    files: Vec::new(),
                    expected_package_revision: None,
                },
            ),
        )
        .await
        .unwrap();

    // Linked notes for graph_depth = 1..2 recall expansion.
    let (hop_two, _) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "hop-two",
        "---\ntitle: Hop Two\n---\ndeepgraphleaf\n",
    )
    .await;
    let (hop_one, _) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "hop-one",
        "---\ntitle: Hop One\n---\nLinks onward to [[hop-two]].\n",
    )
    .await;
    let (graph_anchor, _) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "graph-anchor",
        "---\ntitle: Graph Anchor\n---\ngraphseedterm links to [[hop-one]].\n",
    )
    .await;

    // Personal chat entry for include_chats verification.
    let thread = ChatThreadId::from_bytes(random_bytes_16());
    store
        .create_chat(
            owner.clone(),
            mutation(
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: principal.clone(),
                    project_folder: None,
                    title: "Projection Chat".into(),
                },
            ),
        )
        .await
        .unwrap();
    let chat_entry = store
        .append_chat(
            owner.clone(),
            mutation(
                &owner,
                AppendChat {
                    thread,
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("projectionchattoken".into()),
                    referenced_notes: vec![],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();

    // Folders and note for MoveFolder visibility verification.
    let movable = FolderId::from_bytes(random_bytes_16());
    let dest_project = FolderId::from_bytes(random_bytes_16());
    store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: movable.clone(),
            parent: None,
            slug: "movable".into(),
            display_name: "Movable".into(),
            is_project: false,
            project_slug: None,
            actor: principal.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: dest_project.clone(),
            parent: None,
            slug: "dest-project".into(),
            display_name: "Dest Project".into(),
            is_project: true,
            project_slug: Some("dest-project".into()),
            actor: principal.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let (moved_note, _) = create_note(
        &store,
        &owner,
        Some(&movable),
        DocClass::UserDoc,
        "moved-note",
        "---\ntitle: Moved Note\n---\nmovedprojectiontoken\n",
    )
    .await;

    let seq = store
        .read_space(&space.scope.space_id)
        .await
        .unwrap()
        .last_seq;
    let search = Arc::new(SearchEngine::start(
        SearchConfig::new(root, VectorMode::DeterministicTest { dimension: 64 }),
        SearchDependencies::new(store.clone(), projector.engine()),
    ));
    let mut filtered = query(&space.scope, seq, "concordance");
    filtered.folder = Some(project.clone());
    filtered.filter.predicate = Predicate::Eq {
        key: "weight".into(),
        value: ScalarValue::Number(7_i64.into()),
    };
    let found = search
        .search(owner.clone(), filtered.clone())
        .await
        .unwrap();
    assert!(found.cut.projected_seq >= seq);
    assert_eq!(ids(&found), [&inside]);
    let recall = search
        .recall(
            owner.clone(),
            RecallQuery {
                query: filtered.clone(),
                graph_depth: 0,
                token_budget: 128,
            },
        )
        .await
        .unwrap();
    assert_eq!(ids(&recall), [&inside]);
    assert!(
        recall.hits[0]
            .chunks
            .iter()
            .any(|part| part.text().contains("concordance"))
    );

    // Graph recall expansion at depth 1 and depth 2 over projected backlinks.
    // Isolate graph expansion on a lexical-only engine so deterministic vector
    // candidates do not pre-populate unrelated hops in a tiny corpus.
    let lexical_temp = TempDataRoot::new("search-projections-graph");
    let lexical_search = SearchEngine::start(
        SearchConfig::new(lexical_temp.data_root(), VectorMode::Disabled),
        SearchDependencies::new(store.clone(), projector.engine()),
    );
    let recall_depth_1 = lexical_search
        .recall(
            owner.clone(),
            RecallQuery {
                query: query(&space.scope, seq, "graphseedterm"),
                graph_depth: 1,
                token_budget: 2048,
            },
        )
        .await
        .unwrap();
    let depth1_ids = ids(&recall_depth_1);
    assert!(depth1_ids.contains(&&graph_anchor));
    assert!(depth1_ids.contains(&&hop_one));
    assert!(!depth1_ids.contains(&&hop_two));

    let recall_depth_2 = lexical_search
        .recall(
            owner.clone(),
            RecallQuery {
                query: query(&space.scope, seq, "graphseedterm"),
                graph_depth: 2,
                token_budget: 2048,
            },
        )
        .await
        .unwrap();
    let depth2_ids = ids(&recall_depth_2);
    assert!(depth2_ids.contains(&&graph_anchor));
    assert!(depth2_ids.contains(&&hop_one));
    assert!(depth2_ids.contains(&&hop_two));
    lexical_search.shutdown().await;

    // Chat search hits through live projection & canonical hydration.
    let mut chat_req = query(&space.scope, seq, "projectionchattoken");
    chat_req.include_chats = true;
    let chat_res = search.search(owner.clone(), chat_req).await.unwrap();
    assert_eq!(chat_res.chat_hits.len(), 1);
    assert_eq!(chat_res.chat_hits[0].entry, chat_entry.value.seq);

    // CausalBasis::Exact receipt overlay scores an unindexed note immediately.
    let (exact_note, exact_receipt) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "exact-note",
        "---\ntitle: Exact Note\n---\nexactoverlaymarker\n",
    )
    .await;
    let mut exact_req = query(&space.scope, seq, "exactoverlaymarker");
    exact_req.causal = CausalBasis::Exact(ReceiptSet::new([exact_receipt]).unwrap());
    let exact_found = search.search(owner.clone(), exact_req).await.unwrap();
    let exact_hit = exact_found
        .hits
        .iter()
        .take(2)
        .find(|hit| hit.card.document.provenance().reference().note_id == exact_note)
        .expect("exact receipt overlay must surface the newly written note among top hits");
    assert!(exact_hit.card.preview.contains("exactoverlaymarker"));

    // MoveFolder updates projected folder visibility cleanly.
    let mut move_query = query(&space.scope, seq, "movedprojectiontoken");
    move_query.folder = Some(dest_project.clone());
    assert!(
        search
            .search(owner.clone(), move_query.clone())
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    let moved = store
        .move_folder(
            owner.clone(),
            mutation(
                &owner,
                MoveFolder {
                    folder: movable,
                    new_parent: Some(dest_project.clone()),
                },
            ),
        )
        .await
        .unwrap();
    let mut after_move_query = query(&space.scope, moved.receipt.seq(), "movedprojectiontoken");
    after_move_query.folder = Some(dest_project);
    assert_eq!(
        ids(&search
            .search(owner.clone(), after_move_query)
            .await
            .unwrap()),
        [&moved_note]
    );

    // Concurrent WriteBatchActor mutations and parallel searches must return
    // zero errors and never drop already-visible hits.
    let (concurrent_anchor, anchor_receipt) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "concurrent-anchor",
        "---\ntitle: Concurrent Anchor\n---\nconcurrentanchortoken\n",
    )
    .await;
    let _ = search
        .search(
            owner.clone(),
            query(&space.scope, anchor_receipt.seq(), "concurrentanchortoken"),
        )
        .await
        .unwrap();
    let writer_store = store.clone();
    let writer_owner = owner.clone();
    let writer = tokio::spawn(async move {
        for idx in 0..12 {
            let _ = create_note(
                &writer_store,
                &writer_owner,
                None,
                DocClass::UserDoc,
                &format!("concurrent-wave-{idx}"),
                &format!("---\ntitle: Wave {idx}\n---\nconcurrentwave{idx}\n"),
            )
            .await;
        }
    });
    let mut base_req = query(&space.scope, anchor_receipt.seq(), "concurrentanchortoken");
    base_req.causal = CausalBasis::Exact(ReceiptSet::default());
    for _ in 0..24 {
        let res = search
            .search(owner.clone(), base_req.clone())
            .await
            .expect("concurrent search must not fail during writes");
        assert!(
            ids(&res).contains(&&concurrent_anchor),
            "concurrent search dropped visible anchor hit"
        );
    }
    writer.await.unwrap();

    let after_writes = store
        .read_space(&space.scope.space_id)
        .await
        .unwrap()
        .last_seq;
    filtered.folder = None;
    filtered.causal =
        CausalBasis::Await(AwaitWatermarks::from_receipts([MutationReceiptToken::new(
            space.scope.clone(),
            after_writes,
        )
        .unwrap()]));
    filtered.filter.predicate = Predicate::IsBad {
        key: "weight".into(),
    };
    assert_eq!(
        ids(&search.search(owner.clone(), filtered).await.unwrap()),
        [&outside]
    );

    let keeper = SpaceContext::new(
        owner
            .auth()
            .for_keeper(
                AgentRunId::from_bytes(random_bytes_16()),
                space.scope.space_id.clone(),
                Some(project.clone()),
                [ability].into(),
            )
            .unwrap(),
        space.scope.clone(),
        owner.budget.clone(),
    )
    .unwrap();
    let mut external = query(&space.scope, after_writes, "pinnedhandbook");
    external.classes = [DocClass::Skill].into();
    assert_eq!(
        ids(&search
            .search(keeper.clone(), external.clone())
            .await
            .unwrap()),
        [&skill]
    );
    external.folder = Some(project.clone());
    assert!(
        search
            .search(keeper.clone(), external)
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    let keeper_hits = search
        .search(keeper, query(&space.scope, after_writes, "concordance"))
        .await
        .unwrap();
    assert_eq!(ids(&keeper_hits).first().copied(), Some(&inside));
    assert!(!ids(&keeper_hits).contains(&&outside));

    // Even a query guaranteed to have no hits must honor its requested cut.
    // Hold the next publication beyond the projection's partial-page wait.
    let mut empty = query(
        &space.scope,
        after_writes.checked_next().unwrap(),
        "concordance",
    );
    empty.classes = [DocClass::EncryptedNote].into();
    let mut waiting = search.search(owner.clone(), empty);
    assert!(
        tokio::time::timeout(Duration::from_millis(120), &mut waiting)
            .await
            .is_err()
    );
    let (_, trashed) = store
        .set_folder_lifecycle(
            &space.scope,
            lease,
            &project,
            &folder_rev,
            Lifecycle::Trashed,
            &principal,
            None,
        )
        .await
        .unwrap();
    let empty = waiting.await.unwrap();
    assert!(empty.cut.projected_seq >= trashed);
    assert!(empty.hits.is_empty());
    let visible = search
        .search(owner, query(&space.scope, trashed, "concordance"))
        .await
        .unwrap();
    assert!(visible.cut.projected_seq >= trashed);
    assert_eq!(ids(&visible).first().copied(), Some(&outside));
    assert!(!ids(&visible).contains(&&inside));

    // Verify SearchEngine::shutdown(&self) works while another Arc clone exists.
    let _extra_ref = Arc::clone(&search);
    search.shutdown().await;
    projector.shutdown().await.unwrap();
}

struct ControlSearchModelResolver(Arc<ProviderService>);

impl SearchModelResolverPort for ControlSearchModelResolver {
    fn resolve_model<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        explicit: Option<&'a ModelProfileId>,
        budget: &'a CallBudget,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            let resolved = self
                .0
                .resolve_search_embedding_model(
                    authority,
                    scope.clone(),
                    explicit.cloned(),
                    budget.clone(),
                )
                .await?;
            Ok(resolved.map(|item| ResolvedEmbeddingTarget {
                model: item.model,
                dimension: item.dimension,
                max_input_tokens: item.max_input_tokens,
                backend: EmbeddingBackendTarget::Remote {
                    provider: item.provider,
                    runtime_epochs: item.runtime_epochs,
                    project: item.project,
                },
            }))
        })
    }

    fn acquire_remote_indexing_grant<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        revision_actor: &'a PrincipalId,
        provider: &'a ProviderResourceId,
        project: Option<&'a FolderRef>,
        budget: CallBudget,
    ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
        Box::pin(async move {
            match self
                .0
                .admit_search_indexing(
                    authority,
                    scope.clone(),
                    revision_actor,
                    provider,
                    project,
                    budget,
                )
                .await
            {
                Ok((ctx, policy)) => Ok(Some(RemoteIndexingGrant { ctx, policy })),
                Err(PortError::Domain(
                    DomainError::AccessDenied
                    | DomainError::ResourceNotFound
                    | DomainError::Provider { .. },
                )) => Ok(None),
                Err(err) => Err(err),
            }
        })
    }
}

struct NoopLease;

impl RevocationLease for NoopLease {
    fn check(&self) -> Result<(), PortError> {
        Ok(())
    }
}

struct TestRevoker;

impl SessionRevocationPort for TestRevoker {
    fn register_provider(
        &self,
        _: MaintenanceContext,
        _: Vec<RevocationSelector>,
        _: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async { Ok(Box::new(NoopLease) as Box<dyn RevocationLease>) })
    }

    fn fence_provider(
        &self,
        _: MaintenanceContext,
        _: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async { Ok(Box::new(NoopLease) as Box<dyn RevocationLease>) })
    }

    fn fence_inactive_provider(
        &self,
        _: MaintenanceContext,
        _: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async { Ok(Some(Box::new(NoopLease) as Box<dyn RevocationLease>)) })
    }

    fn revoke(
        &self,
        _: MaintenanceContext,
        _: RevocationSelector,
        _: RevocationReason,
    ) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

struct SimpleEgressLease {
    current: Vec<ProviderCurrentContent>,
    project: Option<FolderRef>,
    cancellation: Cancellation,
}

impl ProviderEgressLease for SimpleEgressLease {
    fn current(&self) -> &[ProviderCurrentContent] {
        &self.current
    }

    fn project(&self) -> Option<&FolderRef> {
        self.project.as_ref()
    }

    fn check(&self) -> notarium_core::DomainResult<()> {
        if self.cancellation.is_cancelled() {
            Err(DomainError::AccessDenied)
        } else {
            Ok(())
        }
    }
}

struct CanonicalEgress(Arc<CanonicalStore>);

impl ProviderEgressCatalogPort for CanonicalEgress {
    fn acquire_egress(
        &self,
        ctx: AccountContext,
        request: ProviderEgressRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>> {
        Box::pin(async move {
            let authority = ServiceAuthority::admit(ServicePurpose::Search);
            let mut current = Vec::with_capacity(request.origins.len());
            for origin in request.origins {
                if let ProviderOrigin::Note { reference, .. } = origin {
                    let space = self.0.read_space(&reference.space_id).await?;
                    let rows = self
                        .0
                        .read_note_documents_at_cutoff(
                            &authority,
                            ctx.budget.clone(),
                            space.scope,
                            space.last_seq,
                            vec![reference.note_id],
                        )
                        .await?;
                    if let Some((_, Some(note))) = rows.into_iter().next() {
                        current.push(ProviderCurrentContent::Note(note.document.metadata()));
                    }
                }
            }
            Ok(Box::new(SimpleEgressLease {
                current,
                project: request.project,
                cancellation,
            }) as Box<dyn ProviderEgressLease>)
        })
    }
}

async fn spawn_local_ollama_server() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let counter = counter.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let header_end = loop {
                    let read = socket.read(&mut tmp).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&buf[..header_end]);
                let content_length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                while buf.len() < header_end + content_length {
                    let read = socket.read(&mut tmp).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                }
                let body: serde_json::Value =
                    serde_json::from_slice(&buf[header_end..header_end + content_length]).unwrap();
                assert_eq!(body["truncate"], serde_json::json!(false));
                let inputs = body["input"].as_array().unwrap().len();
                let mut unit = vec![0.0_f32; 64];
                unit[0] = 1.0;
                let embeddings = vec![unit; inputs];
                let response_body = serde_json::to_vec(&serde_json::json!({
                    "model": "e2e-embed",
                    "embeddings": embeddings,
                    "prompt_eval_count": 8,
                }))
                .unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&response_body).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (format!("http://{addr}"), requests, handle)
}

async fn import_control_keyring(
    control_store: &ControlStore,
    installation_id: &InstallationId,
) -> PathBuf {
    let keyring_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../notarium-control/tests/fixtures/keyring");
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(keyring_dir.join("vectors.json")).unwrap())
            .unwrap();
    let restore_ctx = MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Restore),
        budget: maintenance_ctx(ServicePurpose::Restore).budget,
    };
    control_store
        .import_target_batch(
            restore_ctx,
            &[
                TargetRecord::V1StorageEpoch {
                    singleton: 1,
                    epoch_version: 1,
                    state: "migrating".into(),
                    installation_id: installation_id.to_string(),
                    receipt_sha256: None,
                    receipt_json: None,
                },
                TargetRecord::SecretKeyring {
                    key_id: value["keyId"].as_str().unwrap().into(),
                    key_hash: value["keyHash"].as_str().unwrap().into(),
                    generation: 1,
                    state: "active".into(),
                    canary: value["canaryEnvelope"].as_str().unwrap().into(),
                    created_at: 0,
                    retired_at: None,
                },
            ],
        )
        .await
        .unwrap();
    keyring_dir.join("native")
}

async fn open_control_keyring(control_store: &ControlStore, native_dir: PathBuf) -> Arc<Keyring> {
    Arc::new(
        Keyring::open(
            control_store.clone(),
            KeyringLocation::External(native_dir),
            maintenance_ctx(ServicePurpose::Search).budget,
        )
        .await
        .unwrap(),
    )
}

async fn exercise_provider_e2e(
    installation_id: InstallationId,
    store: CanonicalStore,
    root: DataRoot,
    projector: ProjectorRuntime,
    control_store: ControlStore,
    keyring: Arc<Keyring>,
) {
    let store = Arc::new(store);
    let budget = || maintenance_ctx(ServicePurpose::Search).budget;
    let control = Arc::new(
        ControlService::open(
            control_store.clone(),
            store.clone(),
            Arc::new(TestRevoker),
            Arc::new(SystemClock),
            ControlConfig {
                authentication: AuthenticationMode::Password,
                resource_uri: "https://notarium.test/".into(),
                max_auth_spaces: 100,
                schedule_limits: RunLimits::HARD_CEILING,
            },
            budget(),
        )
        .await
        .unwrap(),
    );

    let (origin, ollama_requests, server_task) = spawn_local_ollama_server().await;
    let resource_id = ProviderResourceId::from_bytes(random_bytes_16());
    let model_id = ModelProfileId::from_bytes(random_bytes_16());
    let loopback: ipnet::IpNet = "127.0.0.1/32".parse().unwrap();
    let policy = NetworkPolicy::new(vec![
        PrivateNetworkRule::new(resource_id.clone(), &origin, vec![loopback]).unwrap(),
    ])
    .unwrap();
    let outbound = Arc::new(OutboundTransport::new(policy));
    let provider = Arc::new(
        ProviderService::new(
            control.clone(),
            keyring,
            outbound,
            Arc::new(CanonicalEgress(store.clone())),
            ProviderConfig::default(),
        )
        .unwrap(),
    );

    let empty_auth = EmptyRootAuthorization::from_classification(
        installation_id,
        EpochClassification {
            state: StorageEpochState::EmptyRoot,
            reason: EpochReason::ConfirmedEmpty,
        },
    )
    .unwrap();
    let boot = control
        .bootstrap(
            empty_auth,
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("e2e provider password".into())),
            },
        )
        .await
        .unwrap();
    let owner_id = boot.account.id;
    let space_id = boot.account.personal_space.unwrap();
    let session_token = boot.session.unwrap().token;
    let auth = control
        .resolve(PreAuthContext {
            budget: budget(),
            evidence: AuthEvidence::new(
                AuthEvidenceKind::Session,
                session_token.expose().to_owned(),
            )
            .with_human_management(),
        })
        .await
        .unwrap();
    let account_ctx = AccountContext::new(auth.clone(), budget());

    let res_commit = provider
        .create_resource(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, boot.account.revision),
                input: ProviderResourceSpec {
                    id: resource_id.clone(),
                    name: "Local Ollama E2E".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: origin,
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 10_000,
                },
            },
        )
        .await
        .unwrap();
    let model_commit = provider
        .put_model(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, res_commit.revision),
                input: PutProviderModel {
                    resource: resource_id.clone(),
                    expected: res_commit.value.revision,
                    model: ProviderModelSpec {
                        id: model_id.clone(),
                        wire_name: "e2e-embed".into(),
                        kind: ProviderModelKind::Embedding { dimension: 64 },
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 2048,
                        max_output_tokens: 0,
                        tools: false,
                    },
                    default: false,
                },
            },
        )
        .await
        .unwrap();
    let reviewed = provider
        .list_resources(
            account_ctx.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap()
        .items
        .remove(0);
    let attached = provider
        .request_attachment(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, model_commit.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes(random_bytes_16()),
                    expected: None,
                    resource: resource_id.clone(),
                    resource_consent_epoch: reviewed.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: owner_id.clone(),
                        space: space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: BTreeSet::from([DocClass::UserDoc]),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    provider
        .set_preference(
            account_ctx,
            AccountMutation {
                identity: account_command(&owner_id, attached.revision),
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Embedding,
                    resource: resource_id.clone(),
                    model: model_id.clone(),
                },
            },
        )
        .await
        .unwrap();

    let space_record = store.read_space(&space_id).await.unwrap();
    let resolved = provider
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            space_record.scope.clone(),
            None,
            budget(),
        )
        .await
        .unwrap()
        .expect("ProviderService must resolve configured Space embedding model");
    assert_eq!(resolved.provider, resource_id);
    assert_eq!(resolved.model, model_id);
    assert_eq!(resolved.dimension, 64);

    let owner_space = SpaceContext::new(auth, space_record.scope.clone(), budget()).unwrap();
    let (note_id, note_receipt) = create_note(
        &store,
        &owner_space,
        None,
        DocClass::UserDoc,
        "remote-e2e",
        "---\ntitle: Remote E2E\n---\nIndexed through real control provider service.\n",
    )
    .await;

    let mut deps = SearchDependencies::new(store.clone(), projector.engine());
    deps.model_resolver = Some(Arc::new(ControlSearchModelResolver(provider.clone())));
    deps.providers = Some(provider.clone());
    let search = Arc::new(SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    ));
    search.start_space(space_record.scope.clone()).unwrap();

    let layout = SearchLayout::open(&root, space_record.scope.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= note_receipt.seq()
                && manifest.vector_seq.is_some()
                && !manifest.embeddings_pending
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("remote indexing through real ProviderService must complete");

    // Semantic query without lexical overlap proves end-to-end vector indexing
    // and query embedding via ProviderService + ControlService.
    let found = search
        .search(
            owner_space,
            query(
                &space_record.scope,
                note_receipt.seq(),
                "unrelatedsemanticquery",
            ),
        )
        .await
        .unwrap();
    assert!(found.degraded.is_none());
    assert_eq!(ids(&found), [&note_id]);
    assert!(ollama_requests.load(Ordering::SeqCst) >= 2);

    search.shutdown().await;
    projector.shutdown().await.unwrap();
    server_task.abort();
    control_store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_search_uses_the_projected_scope() {
    let temp = TempDataRoot::new("search-projections");
    let root = temp.data_root();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(random_bytes_16()), root.clone());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let projector = ProjectorRuntime::start_sqlite(
        store.clone(),
        maintenance_ctx(ServicePurpose::Projection),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    exercise(store, root, projector).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_search_uses_the_projected_scope() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let prefix = fixtures.fresh_pg_schema();
    let s3 = fixtures.s3_config(
        fixtures.fresh_s3_bucket("search-projection"),
        S3BucketModePolicy::DetectFromBucket,
    );
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let config = fixtures.pg_s3_config(InstallationId::from_bytes(random_bytes_16()), &schema, s3);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let temp = TempDataRoot::new("search-projections-pg");
    let root = temp.data_root();
    let pool = sqlx::PgPool::connect_with(build_pg_connect_options(&fixtures.pg_connect_config()))
        .await
        .unwrap();
    let projector = ProjectorRuntime::start_postgres_ephemeral(
        store.clone(),
        maintenance_ctx(ServicePurpose::Projection),
        pool.clone(),
        &prefix,
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    exercise(store, root, projector).await;
    runtime.shutdown().await.unwrap();
    pool.close().await;
    for schema in [schema, format!("{prefix}_g1"), format!("{prefix}_ctrl")] {
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_search_provider_service_e2e() {
    let temp = TempDataRoot::new("search-provider-e2e-sqlite");
    let root = temp.data_root();
    let installation_id = InstallationId::from_bytes(random_bytes_16());
    let config = CanonicalConfig::local_default(installation_id.clone(), root.clone());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let projector = ProjectorRuntime::start_sqlite(
        store.clone(),
        maintenance_ctx(ServicePurpose::Projection),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let control_store = ControlStore::sqlite(&root).await.unwrap();
    let native_dir = import_control_keyring(&control_store, &installation_id).await;
    {
        let conn = rusqlite::Connection::open(root.control()).unwrap();
        conn.execute(
            "UPDATE v1_storage_epoch SET state='ready' WHERE singleton=1",
            [],
        )
        .unwrap();
    }
    let keyring = open_control_keyring(&control_store, native_dir).await;
    exercise_provider_e2e(
        installation_id,
        store,
        root,
        projector,
        control_store,
        keyring,
    )
    .await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_search_provider_service_e2e() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let prefix = fixtures.fresh_pg_schema();
    let ctrl_db = format!("search_ctrl_{}", hex::encode(&random_bytes_16()[..4]));
    {
        let mut admin = fixtures.open_raw_pg().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE DATABASE \"{ctrl_db}\""
        )))
        .execute(&mut admin)
        .await
        .unwrap();
        admin.close().await.unwrap();
    }
    let installation_id = InstallationId::from_bytes(random_bytes_16());
    let s3 = fixtures.s3_config(
        fixtures.fresh_s3_bucket("search-provider-e2e"),
        S3BucketModePolicy::DetectFromBucket,
    );
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let config = fixtures.pg_s3_config(installation_id.clone(), &schema, s3);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let temp = TempDataRoot::new("search-provider-e2e-pg");
    let root = temp.data_root();
    let pool = sqlx::PgPool::connect_with(build_pg_connect_options(&fixtures.pg_connect_config()))
        .await
        .unwrap();
    let projector = ProjectorRuntime::start_postgres_ephemeral(
        store.clone(),
        maintenance_ctx(ServicePurpose::Projection),
        pool.clone(),
        &prefix,
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let ctrl_url = format!(
        "postgres://{}:{}@localhost:{}/{}?host={}",
        fixtures.pg_user,
        fixtures.pg_password,
        fixtures.pg_port,
        ctrl_db,
        fixtures.pg_socket_dir.display()
    );
    let control_store = ControlStore::postgres(PostgresConfig::parse(&ctrl_url).unwrap())
        .await
        .unwrap();
    let native_dir = import_control_keyring(&control_store, &installation_id).await;
    {
        let mut ctrl_cfg = fixtures.pg_connect_config();
        ctrl_cfg.database = ctrl_db.clone();
        let mut conn =
            sqlx::PgConnection::connect_with(&build_pg_connect_options(&PgConnectConfig {
                ..ctrl_cfg
            }))
            .await
            .unwrap();
        sqlx::query("UPDATE v1_control.v1_storage_epoch SET state='ready' WHERE singleton=1")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
    }
    let keyring = open_control_keyring(&control_store, native_dir).await;
    exercise_provider_e2e(
        installation_id,
        store,
        root,
        projector,
        control_store,
        keyring,
    )
    .await;
    runtime.shutdown().await.unwrap();
    pool.close().await;
    for schema in [schema, format!("{prefix}_g1"), format!("{prefix}_ctrl")] {
        fixtures.drop_pg_schema(&schema).await;
    }
    let mut admin = fixtures.open_raw_pg().await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS \"{ctrl_db}\" WITH (FORCE)"
    )))
    .execute(&mut admin)
    .await
    .unwrap();
    admin.close().await.unwrap();
}
