//! Exercise search against the production structural reader and control-plane
//! provider services on both storage backends.
#[path = "../../notarium-collab/tests/support/mod.rs"]
mod collab_support;

use collab_support::{StorageTestFixtures, TempDataRoot, maintenance_ctx, random_bytes_16};
use notarium_agents::abilities::SystemAbilityCatalog;
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
        provider::{ProviderConfig, ProviderService, ResolvedSearchEmbeddingModel},
    },
    store::{ControlStore, PostgresConfig, TargetRecord},
};
use notarium_core::{
    DomainError,
    auth::{
        ChatAudience, EngineAuthContext, SecretString, SpaceGrant, SpaceKind, SpaceRole,
        VerifiedHuman,
    },
    classes::{AbilityKind, DocClass},
    epoch::{DataRoot, EpochClassification, EpochReason, StorageEpochState},
    error::PortError,
    ids::*,
    model::{FolderRef, HistoryScope, Lifecycle},
    ports::{
        AbilityPreferenceUpdate, AbilityResolution, AbilitySelection, AccountContext, AppendChat,
        ApproveProviderAttachment, AuthEvidence, AuthEvidenceKind, BearerScope, BootstrapAccount,
        CallBudget, ChangePassword, ChatEntryKind, ChatInputBody, ChatPort, ChatThreadKind,
        ClaimSchedule, CreateChat, CreateNote, CreatePat, CreateSchedule, CreateSpace,
        EmbeddingProviderPort, EmbeddingQueryInput, EmbeddingRequest, EmptyRootAuthorization,
        MaintenanceContext, MembershipChange, MoveFolder, Mutation, NewAccount, NoteWritePort,
        PageLimit, PasswordLogin, PortFuture, PreAuthContext, PreferenceModelKind,
        ProviderAttachmentTarget, ProviderDisclosure, ProviderDisclosureConsent, ProviderLimits,
        ProviderModelKind, ProviderModelSpec, ProviderPreferenceScope, ProviderResourceSpec,
        ProviderWireKind, PublishAbilityPackage, PutProviderModel, RecallQuery,
        RequestProviderAttachment, ScheduleClaim, ScheduleDefinition, SearchDegradation,
        SearchPort, SearchQuery, SearchResult, ServiceAuthority, ServicePurpose,
        SetAccountDisabled, SetProviderPreference, SpaceContext, TokenAccountingProfile,
        control::{AccountMutation, ControlPageRequest, RunLimits},
    },
    query::{FieldFilterAstV1, FieldSchema, FieldType, Predicate, ScalarType},
    receipt::{
        AccountCommandIdentity, AwaitWatermarks, CausalBasis, CommandIdentity,
        MutationReceiptToken, ReceiptSet,
    },
    value::{ScalarValue, Timestamp},
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
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
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
                    folder_page: false,
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
                    attached_skills: Vec::new(),
                    expected_entrypoint_revision: None,
                    requires_explicit_binding: false,
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

    let (hop_three, _) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "hop-three",
        "---\ntitle: Hop Three\n---\nLast link.\n",
    )
    .await;
    let (hop_two, _) = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "hop-two",
        "---\ntitle: Hop Two\n---\ndeepgraphleaf links to [[hop-three]].\n",
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
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
                    proposed_effect: None,
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
                max_per_source: None,
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
                max_per_source: None,
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
                max_per_source: None,
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
    assert!(!depth2_ids.contains(&&hop_three));

    let depth_three = lexical_search
        .recall(
            owner.clone(),
            RecallQuery {
                query: query(&space.scope, seq, "graphseedterm"),
                graph_depth: 3,
                token_budget: 2048,
                max_per_source: None,
            },
        )
        .await
        .unwrap();
    assert!(ids(&depth_three).contains(&&hop_three));
    // A durable peer ACK uses room sequence numbers. Only the checkpoint
    // advances the canonical feed and makes the new text searchable.
    let marker = "livecheckpointmarker";
    let mut cfg = notarium_collab::CollabConfig::default();
    cfg.idle_checkpoint = Duration::from_secs(120);
    cfg.periodic_checkpoint = cfg.idle_checkpoint;
    cfg.idle_unload = cfg.idle_checkpoint;
    let hub = notarium_collab::CollabHub::new(store.as_ref().clone(), cfg).unwrap();
    let (mut peer, _) = collab_support::synced_client(&hub, &owner, &graph_anchor, 410).await;
    peer.send_update(&peer.append(marker)).await;
    assert_eq!(peer.ack().await.room_update_seq, 1);
    assert_eq!(
        store
            .read_space(&space.scope.space_id)
            .await
            .unwrap()
            .last_seq,
        seq
    );
    assert!(
        lexical_search
            .search(owner.clone(), query(&space.scope, seq, marker))
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    hub.shutdown(&owner.budget).await.unwrap();
    let checkpoint = store
        .read_space(&space.scope.space_id)
        .await
        .unwrap()
        .last_seq;
    assert!(checkpoint > seq);
    let indexed = lexical_search
        .search(owner.clone(), query(&space.scope, checkpoint, marker))
        .await
        .unwrap();
    assert_eq!(ids(&indexed), [&graph_anchor]);
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

    fn remote_indexing_revision<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        budget: CallBudget,
    ) -> PortFuture<'a, notarium_core::ids::ContentDigest> {
        Box::pin(
            self.0
                .search_indexing_revision(authority, &scope.space_id, budget),
        )
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
            Ok(self
                .0
                .admit_search_indexing(
                    authority,
                    scope.clone(),
                    revision_actor,
                    provider,
                    project,
                    budget,
                )
                .await?
                .map(|(ctx, policy)| RemoteIndexingGrant { ctx, policy }))
        })
    }
}

async fn spawn_local_ollama_server(
    author_inputs: Arc<AtomicUsize>,
    wire_inputs: Arc<Mutex<Vec<Vec<String>>>>,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let counter = counter.clone();
            let author_inputs = author_inputs.clone();
            let wire_inputs = wire_inputs.clone();
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
                let inputs = body["input"].as_array().unwrap();
                if inputs.iter().any(|input| {
                    input.as_str().is_some_and(|text| {
                        text.contains("Unique contribution by a former member.")
                    })
                }) {
                    author_inputs.fetch_add(1, Ordering::SeqCst);
                }
                wire_inputs.lock().unwrap().push(
                    inputs
                        .iter()
                        .map(|input| input.as_str().unwrap().to_owned())
                        .collect(),
                );
                let inputs = inputs.len();
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

async fn provider_fixture_folder(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    parent: Option<FolderId>,
    slug: &str,
) -> FolderRef {
    let scope = ctx.scope();
    let epoch = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    let folder = FolderRef {
        space_id: scope.space_id.clone(),
        folder_id: FolderId::from_bytes(random_bytes_16()),
    };
    let is_project = parent.is_none();
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: folder.folder_id.clone(),
            parent,
            slug: slug.into(),
            display_name: slug.into(),
            is_project,
            project_slug: is_project.then(|| slug.into()),
            actor: ctx.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    folder
}

async fn verify_moved_query_folder(
    store: &CanonicalStore,
    provider: &ProviderService,
    ctx: &SpaceContext,
    target: &notarium_control::service::provider::ResolvedSearchEmbeddingModel,
    requests: &AtomicUsize,
) {
    let project = target.project.as_ref().unwrap();
    let resource = &target.provider;
    let model = &target.model;
    let child =
        provider_fixture_folder(store, ctx, Some(project.folder_id.clone()), "query-folder")
            .await
            .folder_id;
    let destination = provider_fixture_folder(store, ctx, None, "destination").await;
    let disclosure = || {
        provider.query_disclosure(
            ctx.clone(),
            resource.clone(),
            model.clone(),
            Some(project.clone()),
            Some(child.clone()),
        )
    };
    assert!(disclosure().await.unwrap().contains(&DocClass::UserDoc));
    let request = EmbeddingRequest::query(
        CommandKey::from_bytes(random_bytes_16()),
        model.clone(),
        resource.clone(),
        EmbeddingQueryInput {
            text: "related search".into(),
            tokens: 5,
            classes: BTreeSet::from([DocClass::UserDoc]),
            project_scope: Some(project.clone()),
            folder: Some(child.clone()),
        },
    );
    store
        .move_folder(
            ctx.clone(),
            mutation(
                ctx,
                MoveFolder {
                    folder: child.clone(),
                    new_parent: Some(destination.folder_id),
                },
            ),
        )
        .await
        .unwrap();
    let before = requests.load(Ordering::SeqCst);
    assert!(matches!(
        disclosure().await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        provider.embed(ctx.clone(), request).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert_eq!(requests.load(Ordering::SeqCst), before);
}

async fn session_user(control: &ControlService, token: &SecretString) -> EngineAuthContext {
    control
        .resolve(PreAuthContext {
            budget: maintenance_ctx(ServicePurpose::Search).budget,
            evidence: AuthEvidence::new(AuthEvidenceKind::Session, token.expose().to_owned())
                .with_human_management(),
        })
        .await
        .unwrap()
}

async fn published_semantic_query(
    search: &SearchEngine,
    owner: &SpaceContext,
    query: SearchQuery,
) -> SearchResult {
    // The manifest is durable before the worker publishes the matching reader.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let ctx = SpaceContext::new(
                owner.auth().clone(),
                owner.scope().clone(),
                maintenance_ctx(ServicePurpose::Search).budget,
            )
            .unwrap();
            let result = search.search(ctx, query.clone()).await.unwrap();
            match result.degraded {
                Some(notarium_core::ports::SearchDegradation::EmbeddingsPending) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                None => return result,
                other => panic!("unexpected remote search degradation: {other:?}"),
            }
        }
    })
    .await
    .expect("remote repair must reach the published reader")
}

async fn claim_search_keeper(
    control: &ControlService,
    account: &AccountContext,
    project: &FolderRef,
) -> (
    SpaceContext,
    notarium_core::ports::AbilityRef,
    ControlRevision,
) {
    let role = control
        .resolve_ability(
            account.clone(),
            AbilitySelection::Name {
                name: "research".into(),
                kind: AbilityKind::Role,
                project: Some(project.clone()),
            },
        )
        .await
        .unwrap();
    let AbilityResolution::Resolved(role) = role else {
        panic!("expected the built-in research role")
    };
    let approval = control
        .schedule_ability_candidate(
            account.clone(),
            notarium_core::ports::ScheduleAbilitySelection {
                space: project.space_id.clone(),
                project: Some(project.clone()),
                role: role.reference.identity(),
            },
        )
        .await
        .unwrap();
    let skill = approval.approved_skills.first().unwrap().clone();
    // A single past occurrence stays due until claimed, independent of the test clock.
    let slot = Timestamp::parse("2020-01-01T00:00:00Z").unwrap();
    let scheduled = control
        .create_schedule(
            account.clone(),
            AccountMutation {
                identity: account_command(account.auth().principal(), approval.account_revision),
                input: CreateSchedule {
                    id: ScheduleId::from_bytes(random_bytes_16()),
                    definition: ScheduleDefinition {
                        space: project.space_id.clone(),
                        project: Some(project.clone()),
                        title: "Search fixture".into(),
                        init_prompt: "Search in the approved project.".into(),
                        cron: "0 0 0 1 1 * 2020".into(),
                        timezone: "UTC".into(),
                        approved_role: approval.approved_role.clone(),
                        limits: RunLimits::default(),
                    },
                    approved_skills: approval.approved_skills,
                    next_slot: slot,
                    paused: false,
                },
            },
        )
        .await
        .unwrap();
    let claim = control
        .claim_schedule(
            maintenance_ctx(ServicePurpose::Scheduler),
            ClaimSchedule {
                schedule: scheduled.value.id,
                slot,
                current_role: approval.approved_role,
                expected: scheduled.value.revision,
                next_slot: None,
            },
        )
        .await
        .unwrap();
    let ScheduleClaim::Claimed { context, .. } = claim else {
        panic!("expected an admitted Keeper")
    };
    (*context, skill, scheduled.revision)
}

async fn verify_run_query_disclosure(
    search: &SearchEngine,
    provider: &ProviderService,
    control: &ControlService,
    owner: &SpaceContext,
    target: &ResolvedSearchEmbeddingModel,
    base_query: SearchQuery,
    wire_inputs: &Mutex<Vec<Vec<String>>>,
) {
    let account = AccountContext::new(owner.auth().clone(), owner.budget.clone());
    let project = target.project.as_ref().unwrap();
    let owner_info = control
        .account(account.clone(), owner.auth().principal().clone())
        .await
        .unwrap();
    let issued = control
        .create_pat(
            account.clone(),
            CreatePat {
                name: "External MCP search".into(),
                scope: BearerScope::Read,
                ability_write: false,
                selected_spaces: Some(vec![project.space_id.clone()]),
                expires_at_ms: None,
                expected: owner_info.revision,
            },
        )
        .await
        .unwrap();
    let bearer = control
        .resolve(PreAuthContext {
            budget: owner.budget.clone(),
            evidence: AuthEvidence::new(
                AuthEvidenceKind::Pat,
                issued.value.token.expose().to_owned(),
            ),
        })
        .await
        .unwrap();
    let external = SpaceContext::new(bearer, owner.scope().clone(), owner.budget.clone()).unwrap();
    let (keeper, skill, revision) = claim_search_keeper(control, &account, project).await;
    let query = |text: &str| SearchQuery {
        text: text.into(),
        ..base_query.clone()
    };
    let run = |pin, audience| {
        let auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes(random_bytes_16()),
                pin,
                audience,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        SpaceContext::new(auth, owner.scope().clone(), owner.budget.clone()).unwrap()
    };
    let shared = run(owner.scope().space_id.clone(), ChatAudience::Shared);
    let foreign_pin = owner
        .auth()
        .spaces()
        .keys()
        .find(|space| *space != &owner.scope().space_id)
        .expect("the owner also has a Personal Space")
        .clone();
    let foreign = run(foreign_pin, ChatAudience::Personal);
    let initial = wire_inputs.lock().unwrap().len();
    for (actor, text) in [
        (&external, "externalmcpquery"),
        (&shared, "cleanrunquery"),
        (&keeper, "approvedkeeperquery"),
    ] {
        let result = published_semantic_query(search, actor, query(text)).await;
        assert!(!result.hits.is_empty());
    }
    struct DenyNotes;
    impl notarium_core::ports::SearchRecipient for DenyNotes {
        fn admit<'a>(
            &'a self,
            _: &'a notarium_core::classes::ClassifiedMetadata,
        ) -> PortFuture<'a, bool> {
            Box::pin(async { Ok(false) })
        }
    }
    let rejected = search
        .search_for(
            shared.clone(),
            SearchQuery {
                top_k: PageLimit::new(1).unwrap(),
                ..query("recipientquery")
            },
            Some(&DenyNotes),
        )
        .await
        .unwrap();
    assert!(rejected.hits.is_empty());
    assert!(rejected.degraded.is_none());
    assert_eq!(
        &wire_inputs.lock().unwrap()[initial..],
        &[
            vec!["externalmcpquery".to_owned()],
            vec!["cleanrunquery".to_owned()],
            vec!["approvedkeeperquery".to_owned()],
            vec!["recipientquery".to_owned()]
        ]
    );

    // Exercise direct admission before a projection can mark the branch as read.
    let before = wire_inputs.lock().unwrap().len();
    assert!(!foreign.auth().taint().is_tainted());
    assert!(matches!(
        provider
            .query_disclosure(
                foreign.clone(),
                target.provider.clone(),
                target.model.clone(),
                Some(project.clone()),
                Some(project.folder_id.clone())
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let request = EmbeddingRequest::query(
        CommandKey::from_bytes(random_bytes_16()),
        target.model.clone(),
        target.provider.clone(),
        EmbeddingQueryInput {
            text: "directforeignquery".into(),
            tokens: 5,
            classes: [DocClass::UserDoc].into(),
            project_scope: Some(project.clone()),
            folder: Some(project.folder_id.clone()),
        },
    );
    assert!(matches!(
        provider.embed(foreign.clone(), request).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let result = search
        .search(foreign.clone(), query("Indexed"))
        .await
        .unwrap();
    assert!(foreign.auth().taint().is_tainted());
    assert!(matches!(
        result.degraded,
        Some(SearchDegradation::ProviderUnavailable)
    ));
    assert!(!result.hits.is_empty());

    control
        .set_ability_preference(
            account.clone(),
            AccountMutation {
                identity: account_command(account.auth().principal(), revision),
                input: notarium_core::ports::AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: skill,
                        enabled: false,
                    },
                    expected: notarium_core::ports::AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let result = search.search(keeper, query("Indexed")).await.unwrap();
    assert!(matches!(
        result.degraded,
        Some(SearchDegradation::ProviderUnavailable)
    ));
    assert_eq!(wire_inputs.lock().unwrap().len(), before);
}

async fn wait_remote_sweep(layout: &SearchLayout, revision: ContentDigest) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.remote_admission == Some(revision)
                && !manifest.embeddings_pending
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("remote search must reconcile changed author admission");
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
    let catalog = Arc::new(SystemAbilityCatalog::new(store.clone()));
    let control = Arc::new(
        ControlService::open(
            control_store.clone(),
            catalog.clone(),
            Arc::new(notarium_agents::revocation::RevocationHub::new_local()),
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

    let author_inputs = Arc::new(AtomicUsize::new(0));
    let wire_inputs = Arc::new(Mutex::new(Vec::new()));
    let (origin, ollama_requests, server_task) =
        spawn_local_ollama_server(author_inputs.clone(), wire_inputs.clone()).await;
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
            catalog,
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
    let session_token = boot.session.unwrap().token;
    let account_ctx = AccountContext::new(session_user(&control, &session_token).await, budget());
    let author = control
        .create_account(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, boot.account.revision),
                input: NewAccount {
                    username: "contributor".into(),
                    display_name: "Contributor".into(),
                    email: None,
                },
            },
        )
        .await
        .unwrap();
    let space_id = SpaceId::from_bytes(random_bytes_16());
    let shared = control
        .create_space(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, author.revision),
                input: CreateSpace {
                    id: space_id.clone(),
                    kind: SpaceKind::Shared,
                    name: "Search".into(),
                },
            },
        )
        .await
        .unwrap();
    let auth = session_user(&control, &session_token).await;
    let account_ctx = AccountContext::new(auth.clone(), budget());
    let owner_space = SpaceContext::new(auth, shared.value.history.clone(), budget()).unwrap();
    let membership = control
        .change_membership(
            owner_space.clone(),
            MembershipChange {
                command: CommandKey::from_bytes(random_bytes_16()),
                member: author.value.id.clone(),
                role: Some(SpaceRole::Editor),
                expected: ControlRevision::ZERO,
            },
        )
        .await
        .unwrap();
    let password = || SecretString::new("e2e contributor password".into());
    control
        .change_password(
            account_ctx.clone(),
            ChangePassword {
                account: author.value.id.clone(),
                expected: author.value.revision,
                current: None,
                replacement: password(),
            },
        )
        .await
        .unwrap();
    let login = control
        .login(
            budget(),
            PasswordLogin {
                identifier: "contributor".into(),
                password: password(),
            },
        )
        .await
        .unwrap();
    let contributor = SpaceContext::new(
        session_user(&control, &login.token).await,
        shared.value.history,
        budget(),
    )
    .unwrap();
    let project = provider_fixture_folder(&store, &owner_space, None, "disclosed-project").await;
    let (former_note, _) = create_note(
        &store,
        &contributor,
        Some(&project.folder_id),
        DocClass::UserDoc,
        "former-author",
        "Unique contribution by a former member.",
    )
    .await;
    let res_commit = provider
        .create_resource(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, shared.revision),
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
    let consent = || {
        ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
            classes: BTreeSet::from([DocClass::UserDoc]),
        })
    };
    let offer = provider
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
                    target: ProviderAttachmentTarget::Project(project.clone()),
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    let approval = provider
        .approve_attachment(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, offer.revision),
                input: ApproveProviderAttachment {
                    id: offer.value.id,
                    expected: offer.value.revision,
                    resource_consent_epoch: reviewed.consent_epoch,
                    credential_consent_epoch: None,
                    consent: consent(),
                },
            },
        )
        .await
        .unwrap();
    let attached = provider
        .request_attachment(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, approval.revision),
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
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    provider
        .set_preference(
            account_ctx.clone(),
            AccountMutation {
                identity: account_command(&owner_id, attached.revision),
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Project(project.clone()),
                    kind: PreferenceModelKind::Embedding,
                    resource: resource_id.clone(),
                    model: model_id.clone(),
                },
            },
        )
        .await
        .unwrap();

    let contributor_account = AccountContext::new(contributor.auth().clone(), budget());
    let contributor_personal = provider
        .request_attachment(
            contributor_account.clone(),
            AccountMutation {
                identity: account_command(&author.value.id, login.account.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes(random_bytes_16()),
                    expected: None,
                    resource: resource_id.clone(),
                    resource_consent_epoch: reviewed.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: author.value.id.clone(),
                        space: space_id.clone(),
                    },
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    let removed = control
        .change_membership(
            owner_space.clone(),
            MembershipChange {
                command: CommandKey::from_bytes(random_bytes_16()),
                member: author.value.id.clone(),
                role: None,
                expected: membership.revision,
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

    let (note_id, note_receipt) = create_note(
        &store,
        &owner_space,
        Some(&project.folder_id),
        DocClass::UserDoc,
        "remote-e2e",
        "---\ntitle: Remote E2E\n---\nIndexed through real control provider service.\n",
    )
    .await;

    let start_search = || {
        let mut deps = SearchDependencies::new(store.clone(), projector.engine());
        deps.model_resolver = Some(Arc::new(ControlSearchModelResolver(provider.clone())));
        deps.providers = Some(provider.clone());
        let search = Arc::new(SearchEngine::start(
            SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
            deps,
        ));
        search.start_space(space_record.scope.clone()).unwrap();
        search
    };
    let search = start_search();

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
    let query_context = || {
        SpaceContext::new(
            owner_space.auth().clone(),
            owner_space.scope().clone(),
            budget(),
        )
        .unwrap()
    };
    let project_query = |text: &str| SearchQuery {
        folder: Some(project.folder_id.clone()),
        ..query(&space_record.scope, note_receipt.seq(), text)
    };
    let found = published_semantic_query(
        &search,
        &owner_space,
        project_query("unrelatedsemanticquery"),
    )
    .await;
    assert_eq!(ids(&found), [&note_id]);
    assert!(ollama_requests.load(Ordering::SeqCst) >= 2);
    let lexical = search
        .search(query_context(), project_query("contribution"))
        .await
        .unwrap();
    assert!(ids(&lexical).contains(&&former_note));
    assert_eq!(author_inputs.load(Ordering::SeqCst), 0);
    // Rejoin with the preexisting personal consent. Neither Canonical nor the
    // provider generation changes, so only the admission witness can drive repair.
    control
        .change_membership(
            owner_space.clone(),
            MembershipChange {
                command: CommandKey::from_bytes(random_bytes_16()),
                member: author.value.id.clone(),
                role: Some(SpaceRole::Editor),
                expected: removed.revision,
            },
        )
        .await
        .unwrap();
    let search_authority = ServiceAuthority::admit(ServicePurpose::Search);
    let revision = || provider.search_indexing_revision(&search_authority, &space_id, budget());
    wait_remote_sweep(&layout, revision().await.unwrap()).await;
    let semantic = || project_query("unrelatedsemanticquery");
    let found = published_semantic_query(&search, &owner_space, semantic()).await;
    let allowed_inputs = author_inputs.load(Ordering::SeqCst);
    assert!(allowed_inputs > 0);
    assert!(ids(&found).contains(&&former_note));
    let disable = |disabled, expected| {
        let mut identity = account_command(&author.value.id, expected);
        identity.actor = owner_id.clone();
        control.set_disabled(
            account_ctx.clone(),
            AccountMutation {
                identity,
                input: SetAccountDisabled {
                    account: author.value.id.clone(),
                    disabled,
                },
            },
        )
    };
    let disabled = disable(true, contributor_personal.revision).await.unwrap();
    wait_remote_sweep(&layout, revision().await.unwrap()).await;
    let found = published_semantic_query(&search, &owner_space, semantic()).await;
    assert_eq!(ids(&found), [&note_id]);
    assert_eq!(author_inputs.load(Ordering::SeqCst), allowed_inputs);
    search.shutdown().await;

    // A worker that missed the account restoration while stopped uses the
    // persisted witness and reuses the same model epoch and canonical cutoff.
    disable(false, disabled.revision).await.unwrap();
    let restarted = start_search();
    wait_remote_sweep(&layout, revision().await.unwrap()).await;
    let found = published_semantic_query(&restarted, &owner_space, semantic()).await;
    assert!(ids(&found).contains(&&former_note));
    assert_eq!(
        layout.search_manifest().unwrap().unwrap().vector_seq,
        Some(note_receipt.seq())
    );
    verify_run_query_disclosure(
        &restarted,
        &provider,
        &control,
        &owner_space,
        &resolved,
        semantic(),
        &wire_inputs,
    )
    .await;
    restarted.shutdown().await;
    verify_moved_query_folder(&store, &provider, &owner_space, &resolved, &ollama_requests).await;

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
