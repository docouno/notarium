//! Targeted regression coverage for projection security fences, erasure,
//! causal read fallbacks, event channel isolation, and read surface invariants.
#![forbid(unsafe_code)]

use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
    UpdateSpaceSchema,
};
use notarium_core::{
    DomainError,
    auth::{
        ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceLifecycle, SpaceRole,
        VerifiedHuman,
    },
    classes::DocClass,
    epoch::DataRoot,
    error::PortError,
    ids::*,
    model::{HistoryScope, Lifecycle, LifecycleMask, NoteRef},
    patch::CarrierEditOrigin,
    ports::{
        AppendChat, BoardDelta, CallBudget, Cancellation, ChatEntryKind, ChatInputBody, ChatPort,
        ChatThreadKind, ContentJob, ContentJobKind, CreateChat, CreateNote, DeleteDisposition,
        DeleteNote, EditNote, EventBusPort, GroupCount, GroupKey, JobState, LinkReadPort,
        MaintenanceContext, MoveBoardCard, MoveFolder, Mutation, NoteQuery, NoteReadPort,
        NoteRevision, NoteWritePort, PageLimit, Preconditions, RankExpectation, RankNeighbor,
        RenameFolder, ServiceAuthority, ServicePurpose, SpaceContext, SpaceEvent, SpaceEventKind,
        StructuralReadPort, ViewGraphPort, ViewQuery, ViewRef,
    },
    query::{
        Direction, FieldFilterAstV1, FieldSchema, FieldType, Predicate, ReadRequest, ScalarType,
        SortColumn, SortKey, SortSpec,
    },
    receipt::{AwaitWatermarks, CausalBasis, ChangeCursor, CommandIdentity, ReceiptSet},
    value::{ExactNumber, ScalarValue, YamlValue},
};
use notarium_projections::{
    NoteLinkDirection, ProjectedNoteReadPort, ProjectionConfig, ProjectorRuntime,
};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("notarium-reg-{}", hex::encode(rand16())));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn root(&self) -> DataRoot {
        DataRoot::new(self.0.clone())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn rand16() -> [u8; 16] {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes
}

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(rand16()),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(10),
    }
}

fn projection_ctx() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Projection),
        budget: budget(),
    }
}

fn event_pub_ctx() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::EventPublication),
        budget: budget(),
    }
}

fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    let key = CommandKey::from_bytes(rand16());
    let hash = ContentDigest::from_bytes(*blake3::hash(key.as_str().as_bytes()).as_bytes());
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key,
            hash,
        },
        preconditions: Preconditions::default(),
        input,
    }
}

fn owner_ctx(scope: &HistoryScope, owner: &PrincipalId) -> SpaceContext {
    let grants = BTreeMap::from([(
        scope.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Owner,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        },
    )]);
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner.clone(),
        GrantId::from_bytes(rand16()),
        grants,
        false,
    ));
    SpaceContext::new(auth, scope.clone(), budget()).unwrap()
}

async fn open_space(store: &CanonicalStore, kind: SpaceKind) -> (HistoryScope, SpaceContext) {
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes(rand16()),
        incarnation: HistoryIncarnation::from_bytes(rand16()),
    };
    let owner = PrincipalId::from_bytes(rand16());
    store
        .create_space(CreateSpaceSpec {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            root_folder_id: FolderId::from_bytes(rand16()),
            slug: format!("space-{}", hex::encode(&rand16()[..4])),
            kind,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let ctx = owner_ctx(&scope, &owner);
    (scope, ctx)
}

async fn create_folder(
    store: &CanonicalStore,
    owner: &SpaceContext,
    parent: Option<FolderId>,
    slug: &str,
    is_project: bool,
) -> (FolderId, RevisionId) {
    let id = FolderId::from_bytes(rand16());
    let (_, rev, _) = store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: id.clone(),
            parent,
            slug: slug.to_owned(),
            display_name: slug.to_owned(),
            is_project,
            project_slug: is_project.then(|| slug.to_owned()),
            actor: owner.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    (id, rev)
}

async fn create_note(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    parent: Option<FolderId>,
    slug: &str,
    class: DocClass,
    carrier: String,
) -> NoteRevision {
    store
        .create_note(
            ctx.clone(),
            mutation(
                ctx,
                CreateNote {
                    note: NoteId::from_bytes(rand16()),
                    parent,
                    slug: slug.to_owned(),
                    class,
                    carrier,
                },
            ),
        )
        .await
        .unwrap()
        .value
}

async fn sync(store: &CanonicalStore, runtime: &ProjectorRuntime, scope: &HistoryScope) {
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    runtime
        .engine()
        .wait_for_projected(scope, head, &budget())
        .await
        .unwrap();
}

fn empty_filter() -> FieldFilterAstV1 {
    FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::All(Vec::new()),
    }
}

async fn set_space_lifecycle(
    store: &CanonicalStore,
    owner: &SpaceContext,
    lifecycle: SpaceLifecycle,
) {
    use notarium_core::{ports::ControlCatalogPort, receipt::AccountCommandIdentity};
    store
        .change_lifecycle(
            budget(),
            AccountCommandIdentity {
                owner: owner.auth().principal().clone(),
                actor: owner.auth().principal().clone(),
                key: CommandKey::from_bytes(rand16()),
                hash: ContentDigest::from_bytes(*blake3::hash(&rand16()).as_bytes()),
                expected: ControlRevision::ZERO,
            },
            owner.scope().clone(),
            lifecycle,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn offline_sqlite_purge_cleans_derived_db_and_mmap_checkpoint() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let victim = create_note(
        &store,
        &owner,
        None,
        "offline-victim",
        DocClass::UserDoc,
        "# Secret payload\n".into(),
    )
    .await;
    let gen1 = ProjectionGeneration::new(1).unwrap();
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        gen1,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let head_before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let checkpoint = std::fs::read_dir(root.space_fast_index_dir(gen1, &scope.space_id))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|s| s.starts_with(&format!("fast_index_{}", head_before.get())))
        })
        .unwrap();
    assert!(checkpoint.is_file());

    // Stop the projector while leaving canonical running with its registered eraser.
    runtime.shutdown().await.unwrap();
    store
        .delete_note(
            owner.clone(),
            mutation(
                &owner,
                DeleteNote {
                    note: victim.note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();

    // Both the SQLite derived table and the local mmap checkpoint must be erased.
    let db = rusqlite::Connection::open(root.derived(gen1)).unwrap();
    let remaining: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM projected_notes WHERE space_id = ? AND note_id = ?",
            [scope.space_id.as_str(), victim.note.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
    assert!(
        !checkpoint.exists(),
        "offline SQLite purge must remove stale mmap checkpoints"
    );
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn is_live_visible_hydrate_and_note_links_enforce_cross_space_taint_and_auth() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope_a, owner_a) = open_space(&store, SpaceKind::Personal).await;
    let (scope_b, owner_b) = open_space(&store, SpaceKind::Personal).await;
    let note_b = create_note(
        &store,
        &owner_b,
        None,
        "foreign-note",
        DocClass::UserDoc,
        "# Foreign\n".into(),
    )
    .await;
    let gen1 = ProjectionGeneration::new(1).unwrap();
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        gen1,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope_a).await;
    sync(&store, &runtime, &scope_b).await;
    let engine = runtime.engine();

    // Create a cross-space AgentRun pinned to write in Space A with read access to Space B.
    let principal = owner_a.auth().principal().clone();
    let grants = BTreeMap::from([
        (
            scope_a.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        ),
        (
            scope_b.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Viewer,
                read_classes: DocClass::all(),
                write_classes: BTreeSet::new(),
                project_root: None,
            },
        ),
    ]);
    let human = EngineAuthContext::for_human(VerifiedHuman::attest(
        principal,
        GrantId::from_bytes(rand16()),
        grants.clone(),
        false,
    ));
    let cross_ctx = || {
        let auth = human
            .for_agent_run(
                AgentRunId::from_bytes(rand16()),
                scope_a.space_id.clone(),
                ChatAudience::Personal,
                grants.clone(),
            )
            .unwrap();
        SpaceContext::new(auth, scope_b.clone(), budget()).unwrap()
    };

    // 1. StructuralReadPort::is_live_visible must not taint on Ok(false),
    // and must taint cross-space reads on Ok(true).
    let ctx_miss = cross_ctx();
    let absent_note = NoteId::from_bytes(rand16());
    assert!(!ctx_miss.auth().taint().is_tainted());
    assert!(
        !engine
            .is_live_visible(&ctx_miss, &absent_note)
            .await
            .unwrap()
    );
    assert!(
        !ctx_miss.auth().taint().is_tainted(),
        "is_live_visible returning false must not taint cross-space branches"
    );
    assert_eq!(
        engine
            .filter_live_visible(&ctx_miss, std::slice::from_ref(&absent_note))
            .await
            .unwrap(),
        vec![false]
    );
    assert!(
        !ctx_miss.auth().taint().is_tainted(),
        "filter_live_visible with all-false results must not taint cross-space branches"
    );

    let ctx1 = cross_ctx();
    assert!(!ctx1.auth().taint().is_tainted());
    assert!(engine.is_live_visible(&ctx1, &note_b.note).await.unwrap());
    assert!(
        ctx1.auth().taint().is_tainted(),
        "is_live_visible must taint cross-space branches"
    );

    // 2. StructuralReadPort::hydrate must enforce entry auth and taint even on empty input.
    let cut_b = engine
        .acquire_snapshot(
            owner_b.clone(),
            CausalBasis::Await(AwaitWatermarks::default()),
        )
        .await
        .unwrap()
        .cut()
        .clone();
    let ctx2 = cross_ctx();
    assert!(!ctx2.auth().taint().is_tainted());
    let hydrated = engine
        .hydrate(ctx2.clone(), cut_b, Vec::new())
        .await
        .unwrap();
    assert!(hydrated.is_empty());
    assert!(
        ctx2.auth().taint().is_tainted(),
        "hydrate must taint cross-space branches even when notes slice is empty"
    );

    // 3. LinkReadPort::note_links must authorize/taint before dense_id lookup.
    let ctx3 = cross_ctx();
    assert!(!ctx3.auth().taint().is_tainted());
    let missing = NoteId::from_bytes(rand16());
    let err = LinkReadPort::note_links(
        engine.as_ref(),
        ctx3.clone(),
        missing,
        NoteLinkDirection::Outgoing,
        None,
        PageLimit::new(10).unwrap(),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        err,
        PortError::Domain(DomainError::ResourceNotFound)
    ));
    assert!(
        ctx3.auth().taint().is_tainted(),
        "note_links must taint cross-space branches before dense_id lookup"
    );

    // Both planners must authorize the target before interpreting a declared field.
    use notarium_core::{
        error::ValidationReason,
        ports::{GraphQuery, GraphTier},
    };
    store
        .update_space_schema(
            owner_b.clone(),
            mutation(
                &owner_b,
                UpdateSpaceSchema {
                    schema_note: NoteId::from_bytes(rand16()),
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
    sync(&store, &runtime, &scope_b).await;
    for notes in [false, true] {
        for (key, allowed) in [("weight", false), ("undeclared", false), ("weight", true)] {
            let mut requested = grants.clone();
            if !allowed {
                requested
                    .get_mut(&scope_b.space_id)
                    .unwrap()
                    .read_classes
                    .clear();
            }
            let auth = human
                .for_agent_run(
                    AgentRunId::from_bytes(rand16()),
                    scope_a.space_id.clone(),
                    ChatAudience::Personal,
                    requested,
                )
                .unwrap();
            let ctx = SpaceContext::new(auth, scope_b.clone(), budget()).unwrap();
            let filter = FieldFilterAstV1 {
                version: 1,
                predicate: Predicate::Eq {
                    key: key.into(),
                    value: ScalarValue::String("high".into()),
                },
            };
            let error = if notes {
                engine
                    .list_notes(
                        ctx.clone(),
                        ReadRequest::Open {
                            query: NoteQuery {
                                folder: None,
                                recursive: true,
                                classes: DocClass::all(),
                                lifecycle: LifecycleMask::Active,
                                filter,
                                sort: SortSpec::new(vec![SortKey {
                                    column: SortColumn::UpdatedAt,
                                    direction: Direction::Desc,
                                }])
                                .unwrap(),
                                limit: PageLimit::new(10).unwrap(),
                            },
                            causal: CausalBasis::Await(AwaitWatermarks::default()),
                        },
                    )
                    .await
                    .unwrap_err()
            } else {
                engine
                    .query_graph(
                        ctx.clone(),
                        GraphQuery {
                            tier: GraphTier::Superclusters,
                            filter,
                        },
                    )
                    .await
                    .unwrap_err()
            };
            let expected = if allowed {
                DomainError::validation(ValidationReason::InvalidQuery)
            } else {
                DomainError::ResourceNotFound
            };
            assert_eq!(error, PortError::Domain(expected));
            assert_eq!(ctx.auth().taint().is_tainted(), allowed);
        }
    }

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn folder_by_path_ignores_trashed_collision_and_list_notes_hydrates_cover_page() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Shared).await;
    let (old_dir, old_rev) = create_folder(&store, &owner, None, "docs", false).await;
    store
        .set_folder_lifecycle(
            &scope,
            LeaseEpoch::new(1).unwrap(),
            &old_dir,
            &old_rev,
            Lifecycle::Trashed,
            owner.auth().principal(),
            None,
        )
        .await
        .unwrap();
    let (live_dir, live_rev) = create_folder(&store, &owner, None, "docs", false).await;
    let cover = create_note(
        &store,
        &owner,
        Some(live_dir.clone()),
        "cover",
        DocClass::UserDoc,
        "---\ntitle: Docs Cover\n---\nCover body\n".into(),
    )
    .await;
    let item = create_note(
        &store,
        &owner,
        Some(live_dir.clone()),
        "item",
        DocClass::UserDoc,
        "---\ntitle: Item\nstatus: ok\n---\nBody\n".into(),
    )
    .await;
    // Attach cover_note_id to the folder and issue a canonical folder mutation so the
    // revision metadata carries cover_note_id through the change stream.
    {
        let db = rusqlite::Connection::open(root.canonical()).unwrap();
        db.execute(
            "UPDATE folder_heads SET cover_note_id = ?1 WHERE space_id = ?2 AND folder_id = ?3",
            [
                cover.note.as_str(),
                scope.space_id.as_str(),
                live_dir.as_str(),
            ],
        )
        .unwrap();
    }
    let mut rename = mutation(
        &owner,
        RenameFolder {
            folder: live_dir.clone(),
            name: "docs".into(),
        },
    );
    rename.preconditions.revision = Some(live_rev);
    store.rename_folder(owner.clone(), rename).await.unwrap();

    // Board/table view addressing the folder by path "/docs" must resolve cleanly
    // despite the trashed folder that previously held the same path.
    let view_key = ViewKey::from_bytes(rand16());
    let view_note = create_note(
        &store,
        &owner,
        None,
        "docs-view",
        DocClass::UserDoc,
        format!(
            "```nota\nid: {view_key}\ntype: table\nsource: {{scope: folder, folder: /docs}}\n```\n"
        ),
    )
    .await;

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let engine = runtime.engine();

    let result = engine
        .query_view(
            owner.clone(),
            ReadRequest::Open {
                query: ViewQuery {
                    view: ViewRef {
                        note: view_note.note,
                        key: view_key,
                    },
                    filter: empty_filter(),
                    sort: None,
                    group_by: None,
                    limit: PageLimit::new(20).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .expect("path source must resolve live folder despite trashed path collision");
    let returned: BTreeSet<_> = result
        .rows
        .items
        .iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert!(returned.contains(&cover.note));
    assert!(returned.contains(&item.note));

    // ProjectedNoteReadPort::list_notes populates FolderPage.page for a visible cover note.
    let read_port = ProjectedNoteReadPort::new(engine.clone());
    let query = NoteQuery {
        folder: Some(live_dir.clone()),
        recursive: false,
        classes: DocClass::all(),
        lifecycle: LifecycleMask::Active,
        filter: empty_filter(),
        sort: SortSpec::new(vec![SortKey {
            column: SortColumn::UpdatedAt,
            direction: Direction::Desc,
        }])
        .unwrap(),
        limit: PageLimit::new(20).unwrap(),
    };
    let folder_page = read_port
        .list_notes(
            owner.clone(),
            ReadRequest::Open {
                query: query.clone(),
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .unwrap();
    let cover_snapshot = folder_page
        .page
        .expect("visible folder cover note must be hydrated in FolderPage.page");
    assert_eq!(cover_snapshot.document.reference().note_id, cover.note);

    let mut pause = engine.pause_after_read_payload_for_test(&scope).unwrap();
    let request = read_port.list_notes(
        owner.clone(),
        ReadRequest::Open {
            query: query.clone(),
            causal: CausalBasis::Await(AwaitWatermarks::default()),
        },
    );
    let (archived, ()) = tokio::join!(request, async {
        tokio::time::timeout(
            Duration::from_secs(3),
            pause.reached_feed_boundary_for_test(),
        )
        .await
        .unwrap()
        .unwrap();
        set_space_lifecycle(&store, &owner, SpaceLifecycle::Archived).await;
        pause.resume_for_test().await.unwrap();
    });
    assert!(matches!(
        archived,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    set_space_lifecycle(&store, &owner, SpaceLifecycle::Active).await;

    // An unauthorized cover note (Profile for a Shared agent) must yield page = None.
    let secret_cover = create_note(
        &store,
        &owner,
        Some(live_dir.clone()),
        "profile-cover",
        DocClass::Profile,
        "---\ntitle: Private Profile\n---\nPrivate\n".into(),
    )
    .await;
    {
        let db = rusqlite::Connection::open(root.canonical()).unwrap();
        db.execute(
            "UPDATE folder_heads SET cover_note_id = ?1 WHERE space_id = ?2 AND folder_id = ?3",
            [
                secret_cover.note.as_str(),
                scope.space_id.as_str(),
                live_dir.as_str(),
            ],
        )
        .unwrap();
    }
    store
        .rename_folder(
            owner.clone(),
            mutation(
                &owner,
                RenameFolder {
                    folder: live_dir.clone(),
                    name: "docs".into(),
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope).await;

    let shared_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes(rand16()),
            scope.space_id.clone(),
            ChatAudience::Shared,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let shared_ctx = SpaceContext::new(shared_auth, scope.clone(), budget()).unwrap();
    let shared_page = read_port
        .list_notes(
            shared_ctx,
            ReadRequest::Open {
                query: NoteQuery {
                    classes: BTreeSet::from([DocClass::UserDoc]),
                    ..query
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .unwrap();
    assert!(
        shared_page.page.is_none(),
        "unauthorized folder cover note must not be leaked in FolderPage.page"
    );

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn lagged_folder_visibility_yields_to_writers_and_rejects_a_mixed_head() {
    use std::{future::poll_fn, task::Poll};

    use notarium_core::{
        error::ValidationReason,
        ports::{GraphQuery, GraphTier},
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let (project, _) = create_folder(&store, &owner, None, "project", true).await;
    let (sub, sub_rev) = create_folder(&store, &owner, Some(project.clone()), "sub", false).await;
    for i in 0..40 {
        create_note(
            &store,
            &owner,
            Some(sub.clone()),
            &format!("card-{i}"),
            DocClass::UserDoc,
            "Card".into(),
        )
        .await;
    }
    let mut grants = owner.auth().spaces().clone();
    grants.get_mut(&scope.space_id).unwrap().project_root = Some(project.clone());
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner.auth().principal().clone(),
        GrantId::from_bytes(rand16()),
        grants,
        false,
    ));
    let reader = SpaceContext::new(auth, scope.clone(), budget()).unwrap();
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root,
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let engine = runtime.engine();
    let causal = CausalBasis::Await(AwaitWatermarks::default());
    let warm = engine
        .acquire_snapshot(reader.clone(), causal.clone())
        .await
        .unwrap();
    assert_eq!(warm.folder_subtree(&project).await.unwrap().count(), 40);

    let mut projection = engine.pause_before_projection_for_test(&scope, 1).unwrap();
    let mut mv = mutation(
        &owner,
        MoveFolder {
            folder: sub,
            new_parent: None,
        },
    );
    mv.preconditions.revision = Some(sub_rev);
    store.move_folder(owner.clone(), mv).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), projection.reached())
        .await
        .expect("projector must stop before publishing the folder move")
        .unwrap();

    // The warm index is resident and the causal cut is already available.
    // The first poll must yield during live filtering after the folder move.
    let mut pending = engine.acquire_snapshot(reader.clone(), causal);
    poll_fn(|cx| {
        assert!(pending.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    tokio::time::timeout(
        Duration::from_secs(5),
        create_folder(&store, &owner, None, "writer-progress", false),
    )
    .await
    .expect("the canonical writer must commit while the bitmap scan is suspended");
    assert!(matches!(
        pending.await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::CursorStale
    ));

    // Restricted project-scoped readers are denied whole-Space Superclusters.
    let superclusters_err = engine
        .query_graph(
            reader.clone(),
            GraphQuery {
                tier: GraphTier::Superclusters,
                filter: empty_filter(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        superclusters_err,
        PortError::Domain(DomainError::AccessDenied)
    ));

    let graph = GraphQuery {
        tier: GraphTier::Lens {
            cluster: None,
            project: Some(project.clone()),
            tags: Vec::new(),
        },
        filter: empty_filter(),
    };
    let cancelled = SpaceContext::new(reader.auth().clone(), scope.clone(), budget()).unwrap();
    let mut pending = engine.query_graph(cancelled.clone(), graph.clone());
    poll_fn(|cx| {
        assert!(pending.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    cancelled.budget.cancellation.cancel();
    assert!(matches!(pending.await, Err(PortError::Cancelled(_))));

    let result = engine.query_graph(reader, graph).await.unwrap();
    assert!(result.nodes.is_empty());
    assert_eq!(result.hidden_count, 0);
    assert_eq!(result.cut.projected_seq, warm.cut().projected_seq);
    assert_eq!(
        result.cut.canonical_seq,
        store.read_space(&scope.space_id).await.unwrap().last_seq
    );
    drop(projection);
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn ryow_exact_falls_back_to_wait_on_intervening_schema_or_folder_mutation() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let (folder_a, _) = create_folder(&store, &owner, None, "a", false).await;
    let (folder_b, _) = create_folder(&store, &owner, None, "b", false).await;
    let (sub, sub_rev) = create_folder(&store, &owner, Some(folder_a.clone()), "sub", false).await;
    let view_key = ViewKey::from_bytes(rand16());
    let view_note = create_note(
        &store,
        &owner,
        None,
        "ryow-view",
        DocClass::UserDoc,
        format!(
            "```nota\nid: {view_key}\ntype: table\nsource: {{scope: folder, folder: {folder_b}, recursive: true}}\n```\n"
        ),
    )
    .await;
    let card = create_note(
        &store,
        &owner,
        Some(sub.clone()),
        "card",
        DocClass::UserDoc,
        "---\ntitle: Card\nrank: 1\n---\nBody\n".into(),
    )
    .await;

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let engine = runtime.engine();

    // Pause projection so both the folder move and subsequent note edit stay ahead of base_seq.
    let mut pause = engine.pause_before_projection_for_test(&scope, 1).unwrap();
    let mut mv = mutation(
        &owner,
        MoveFolder {
            folder: sub,
            new_parent: Some(folder_b.clone()),
        },
    );
    mv.preconditions.revision = Some(sub_rev);
    store.move_folder(owner.clone(), mv).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), pause.reached())
        .await
        .unwrap()
        .unwrap();

    // Edit the card after the intervening folder move and request Exact with ONLY the edit receipt.
    let old_carrier = "---\ntitle: Card\nrank: 1\n---\nBody\n";
    let body = notarium_syntax::frontmatter::analyze(old_carrier, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        old_carrier,
        body,
        vec![(CarrierEditOrigin::Body, body, "Edited\n".into())],
    )
    .unwrap();
    let mut edit = mutation(
        &owner,
        EditNote {
            note: card.note.clone(),
            plan,
        },
    );
    edit.preconditions.revision = Some(card.revision);
    let edited = store.edit_note(owner.clone(), edit).await.unwrap();

    let query = ViewQuery {
        view: ViewRef {
            note: view_note.note.clone(),
            key: view_key.clone(),
        },
        filter: empty_filter(),
        sort: None,
        group_by: None,
        limit: PageLimit::new(20).unwrap(),
    };
    let mut short_ctx = owner.clone();
    short_ctx.budget.remaining = Duration::from_millis(80);
    let res = engine
        .query_view(
            short_ctx,
            ReadRequest::Open {
                query: query.clone(),
                causal: CausalBasis::Exact(ReceiptSet::new([edited.receipt.clone()]).unwrap()),
            },
        )
        .await;
    assert!(
        matches!(res, Err(PortError::DeadlineExceeded(_))),
        "intervening folder mutation must force wait-only fallback instead of stale overlay: {res:?}"
    );
    drop(pause);
    let settled = engine
        .query_view(
            owner.clone(),
            ReadRequest::Open {
                query: query.clone(),
                causal: CausalBasis::Exact(ReceiptSet::new([edited.receipt]).unwrap()),
            },
        )
        .await
        .unwrap();
    assert_eq!(settled.rows.items.len(), 1);
    assert_eq!(
        settled.rows.items[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        card.note
    );

    // Repeat the same wait-only check for an intervening space_field_schemas update.
    let mut pause2 = engine.pause_before_projection_for_test(&scope, 1).unwrap();
    store
        .update_space_schema(
            owner.clone(),
            mutation(
                &owner,
                UpdateSpaceSchema {
                    schema_note: NoteId::from_bytes(rand16()),
                    parent: None,
                    slug: "schema".into(),
                    carrier: "---\ntitle: Schema\n---\n".into(),
                    schema: BTreeMap::from([(
                        "rank".into(),
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
    tokio::time::timeout(Duration::from_secs(3), pause2.reached())
        .await
        .unwrap()
        .unwrap();
    let edited2 = create_note(
        &store,
        &owner,
        Some(folder_b),
        "card2",
        DocClass::UserDoc,
        "---\ntitle: Card2\nrank: 2\n---\n".into(),
    )
    .await;
    let receipt2 = notarium_core::receipt::MutationReceiptToken::new(
        scope.clone(),
        store.read_space(&scope.space_id).await.unwrap().last_seq,
    )
    .unwrap();
    let mut short_ctx = owner.clone();
    short_ctx.budget.remaining = Duration::from_millis(80);
    let res2 = engine
        .query_view(
            short_ctx,
            ReadRequest::Open {
                query,
                causal: CausalBasis::Exact(ReceiptSet::new([receipt2]).unwrap()),
            },
        )
        .await;
    assert!(
        matches!(res2, Err(PortError::DeadlineExceeded(_))),
        "intervening schema mutation must force wait-only fallback: {res2:?}"
    );
    let _ = edited2;
    drop(pause2);
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn per_space_event_channels_isolate_bursts_and_purge_scrubs_board_deltas() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope_a, _owner_a) = open_space(&store, SpaceKind::Personal).await;
    let (scope_b, owner_b) = open_space(&store, SpaceKind::Personal).await;
    let key_b = ViewKey::from_bytes(rand16());
    let board_b = create_note(
        &store,
        &owner_b,
        None,
        "board-b",
        DocClass::UserDoc,
        format!("```nota\nid: {key_b}\ntype: board\ngroup_by: status\n```\n"),
    )
    .await;
    let card_b = create_note(
        &store,
        &owner_b,
        None,
        "card-b",
        DocClass::UserDoc,
        "---\ntitle: Sensitive Card\nstatus: todo\n---\n".into(),
    )
    .await;
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope_a).await;
    sync(&store, &runtime, &scope_b).await;

    let engine = runtime.engine();
    let bus = engine.event_bus();
    let head_a = store.read_space(&scope_a.space_id).await.unwrap().last_seq;
    let head_b = store.read_space(&scope_b.space_id).await.unwrap().last_seq;
    let mut stream_b = bus
        .subscribe(
            owner_b.clone(),
            ChangeCursor {
                scope: scope_b.clone(),
                after: head_b,
            },
        )
        .await
        .unwrap();

    // Flood Space A with > 300 events (exceeding the 256-slot per-Space ring buffer).
    for _ in 0..300 {
        bus.publish(
            event_pub_ctx(),
            SpaceEvent {
                scope: scope_a.clone(),
                seq: head_a,
                kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Active),
            },
        )
        .await
        .unwrap();
    }

    // Space B must receive its exact Job event at the same floor seq without lagging.
    let job_id = JobId::from_bytes(rand16());
    bus.publish(
        event_pub_ctx(),
        SpaceEvent {
            scope: scope_b.clone(),
            seq: head_b,
            kind: SpaceEventKind::Job(ContentJob {
                id: job_id.clone(),
                kind: ContentJobKind::Reindex,
                state: JobState::Queued,
                completed_units: 0,
                total_units: None,
                lease: LeaseEpoch::new(1).unwrap(),
                artifacts: Vec::new(),
            }),
        },
    )
    .await
    .unwrap();
    let got_job = tokio::time::timeout(Duration::from_secs(3), stream_b.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(got_job.kind, SpaceEventKind::Job(job) if job.id == job_id));
    assert_eq!(got_job.seq, head_b);

    // Same-seq Lifecycle(Closing) event must also be delivered cleanly.
    bus.publish(
        event_pub_ctx(),
        SpaceEvent {
            scope: scope_b.clone(),
            seq: head_b,
            kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Closing),
        },
    )
    .await
    .unwrap();
    let got_lifecycle = tokio::time::timeout(Duration::from_secs(3), stream_b.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(
        got_lifecycle.kind,
        SpaceEventKind::Lifecycle(SpaceLifecycle::Closing)
    ));

    // Queue a BoardDelta in Space B's broadcast ring, then purge card_b before
    // polling stream_b. Purge must scrub the queued BoardDelta payload in RAM.
    let next_b = create_note(
        &store,
        &owner_b,
        None,
        "after-b",
        DocClass::UserDoc,
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(&store, &runtime, &scope_b).await;
    let after_seq = store.read_space(&scope_b.space_id).await.unwrap().last_seq;
    let mut idle_stream = bus
        .subscribe(
            owner_b.clone(),
            ChangeCursor {
                scope: scope_b.clone(),
                after: after_seq,
            },
        )
        .await
        .unwrap();
    bus.publish(
        event_pub_ctx(),
        SpaceEvent {
            scope: scope_b.clone(),
            seq: after_seq,
            kind: SpaceEventKind::Board(BoardDelta {
                scope: scope_b.clone(),
                seq: after_seq,
                view: ViewRef {
                    note: board_b.note.clone(),
                    key: key_b.clone(),
                },
                groups: vec![GroupCount {
                    group: GroupKey::Value(ScalarValue::String("todo".into())),
                    count: 2,
                }],
                ranks: vec![(card_b.note.clone(), "000000000001".into())],
            }),
        },
    )
    .await
    .unwrap();
    store
        .delete_note(
            owner_b.clone(),
            mutation(
                &owner_b,
                DeleteNote {
                    note: card_b.note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope_b).await;
    let next_event = tokio::time::timeout(Duration::from_secs(3), idle_stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        !matches!(next_event.kind, SpaceEventKind::Board(_)),
        "purged board delta must be scrubbed from the SpaceEventBus ring buffer"
    );
    let _ = next_b;

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn shared_space_personal_chat_does_not_leak_and_exact_number_board_parity() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner_a) = open_space(&store, SpaceKind::Shared).await;
    let owner_b = owner_ctx(&scope, &PrincipalId::from_bytes(rand16()));
    let (project, proj_rev) = create_folder(&store, &owner_a, None, "proj", true).await;

    // 1. ExactNumber 1 vs 1.0 parity on board grouping + trashed ancestor view rejection.
    let key = ViewKey::from_bytes(rand16());
    let board = create_note(
        &store,
        &owner_a,
        Some(project.clone()),
        "num-board",
        DocClass::UserDoc,
        format!(
            "```nota\nid: {key}\ntype: board\nsource: {{scope: folder, folder: {project}}}\nfilter: {{exists: tier}}\ngroup_by: tier\noptions: {{columns: [1]}}\n```\n"
        ),
    )
    .await;
    let card_int = create_note(
        &store,
        &owner_a,
        Some(project.clone()),
        "card-int",
        DocClass::UserDoc,
        "---\ntitle: Int\ntier: 1\n---\n".into(),
    )
    .await;
    let card_float = create_note(
        &store,
        &owner_a,
        Some(project.clone()),
        "card-float",
        DocClass::UserDoc,
        "---\ntitle: Float\ntier: 1.0\n---\n".into(),
    )
    .await;

    // 2. Incoming link pagination skips unauthorized sources outside project_root.
    let target = create_note(
        &store,
        &owner_a,
        Some(project.clone()),
        "link-target",
        DocClass::UserDoc,
        "# Target\n".into(),
    )
    .await;
    for i in 0..2 {
        create_note(
            &store,
            &owner_a,
            None,
            &format!("hidden-src-{i}"),
            DocClass::UserDoc,
            format!("[[{}]]\n", target.note),
        )
        .await;
    }
    let visible_src = create_note(
        &store,
        &owner_a,
        Some(project.clone()),
        "visible-src",
        DocClass::UserDoc,
        format!("[[{}]]\n", target.note),
    )
    .await;

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let engine = runtime.engine();

    // Both `tier: 1` and `tier: 1.0` must collapse into the single column `1` and accept board ranking.
    let view_ref = ViewRef {
        note: board.note.clone(),
        key: key.clone(),
    };
    let moved = engine
        .move_board_card(
            owner_a.clone(),
            mutation(
                &owner_a,
                MoveBoardCard {
                    view: view_ref.clone(),
                    note: card_float.note.clone(),
                    group: GroupKey::Value(ScalarValue::Number(ExactNumber::new(
                        serde_json::Number::from_f64(1.0).unwrap(),
                    ))),
                    before: Some(RankNeighbor {
                        note: card_int.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::from([(
                        "tier".into(),
                        Some(YamlValue::Number(ExactNumber::new(
                            serde_json::Number::from_f64(1.0).unwrap(),
                        ))),
                    )]),
                    expected_note: card_float.revision,
                    expected_view: board.revision,
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .expect("board move with 1.0 must match integer group 1");
    sync(&store, &runtime, &scope).await;
    let result = engine
        .query_view(
            owner_a.clone(),
            ReadRequest::Open {
                query: ViewQuery {
                    view: view_ref.clone(),
                    filter: empty_filter(),
                    sort: None,
                    group_by: None,
                    limit: PageLimit::new(10).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(result.groups.len(), 1);
    assert_eq!(result.groups[0].count, 2);
    assert_eq!(
        result.rows.items[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        card_float.note,
        "ranked card (1.0) moved before card_int (1) must sort first inside column 1"
    );
    assert_eq!(
        result.rows.items[0].rank.as_deref(),
        Some(moved.value.rank.as_str())
    );
    assert_eq!(
        result.rows.items[1]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        card_int.note,
        "card_int (1) must appear second in the same canonical column 1"
    );
    assert!(result.rows.items[1].rank.is_some());

    // Incoming link pagination for a project-scoped reader with limit = 1 must skip
    // both unauthorized root sources and return visible_src on the first page.
    let scoped_grants = BTreeMap::from([(
        scope.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Viewer,
            read_classes: DocClass::all(),
            write_classes: BTreeSet::new(),
            project_root: Some(project.clone()),
        },
    )]);
    let scoped_ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes(rand16()),
            GrantId::from_bytes(rand16()),
            scoped_grants,
            false,
        )),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let incoming = LinkReadPort::note_links(
        engine.as_ref(),
        scoped_ctx,
        target.note.clone(),
        NoteLinkDirection::Incoming,
        None,
        PageLimit::new(1).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(incoming.links.len(), 1);
    assert_eq!(incoming.links[0].source, visible_src.note);

    // 3. Personal chat activity in a Shared Space must not leak to another full-Space owner.
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let mut stream_b = engine
        .event_bus()
        .subscribe(
            owner_b.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after: head,
            },
        )
        .await
        .unwrap();
    let thread = ChatThreadId::from_bytes(rand16());
    store
        .create_chat(
            owner_a.clone(),
            mutation(
                &owner_a,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner_a.auth().principal().clone(),
                    project_folder: None,
                    title: "Owner A private thread".into(),
                },
            ),
        )
        .await
        .unwrap();
    store
        .append_chat(
            owner_a.clone(),
            mutation(
                &owner_a,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Private message".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: scope.space_id.clone(),
                        note_id: target.note,
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(150), stream_b.next())
            .await
            .is_err(),
        "Shared Space full-Space owner B must receive zero events for owner A's Personal chat thread"
    );

    use notarium_core::ports::{ChangeBroadcast, ChangeRead, ChangeReadResult, EntityId};
    let read_port = ProjectedNoteReadPort::new(engine.clone());
    let through = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let seed = ChangeRead::Seed {
        scope: scope.clone(),
        cutoff: Some(through),
        limit: PageLimit::new(50).unwrap(),
    };
    for (reader, visible) in [(&owner_a, true), (&owner_b, false)] {
        let ChangeReadResult::Seed(page) = read_port
            .read_changes(reader.clone(), seed.clone())
            .await
            .unwrap()
        else {
            panic!("expected seed page")
        };
        assert_eq!(page.threads.iter().any(|row| row.id == thread), visible);
        let ChangeReadResult::Log(page) = read_port
            .recent_activity(
                reader.clone(),
                ChangeRead::Log {
                    after: ChangeCursor {
                        scope: scope.clone(),
                        after: head,
                    },
                    through,
                    limit: PageLimit::new(50).unwrap(),
                },
            )
            .await
            .unwrap()
        else {
            panic!("expected log page")
        };
        assert_eq!(
            page.changes
                .iter()
                .any(|row| row.entity == EntityId::Thread(thread.clone())),
            visible
        );
    }
    let ChangeReadResult::Seed(service) = store.catch_up(projection_ctx(), seed).await.unwrap()
    else {
        panic!("expected service seed page")
    };
    assert!(service.threads.iter().any(|row| row.id == thread));

    // 4. Trashing a folder containing a view carrier must reject query_view even for project_root: None.
    store
        .set_folder_lifecycle(
            &scope,
            LeaseEpoch::new(1).unwrap(),
            &project,
            &proj_rev,
            Lifecycle::Trashed,
            owner_a.auth().principal(),
            None,
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope).await;
    let trashed_view = engine
        .query_view(
            owner_a,
            ReadRequest::Open {
                query: ViewQuery {
                    view: view_ref,
                    filter: empty_filter(),
                    sort: None,
                    group_by: None,
                    limit: PageLimit::new(10).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await;
    assert!(
        matches!(
            trashed_view,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "view note under a trashed ancestor must be rejected even with project_root: None: {trashed_view:?}"
    );

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn security_admission_and_lifecycle_regressions() {
    use notarium_core::error::ValidationReason;

    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner_a) = open_space(&store, SpaceKind::Shared).await;
    let (project_a, _) = create_folder(&store, &owner_a, None, "project-a", true).await;

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root,
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = runtime.engine();

    let scoped_grants = BTreeMap::from([(
        scope.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: Some(project_a.clone()),
        },
    )]);
    let scoped_ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes(rand16()),
            GrantId::from_bytes(rand16()),
            scoped_grants,
            false,
        )),
        scope.clone(),
        budget(),
    )
    .unwrap();

    let card = create_note(
        &store,
        &owner_a,
        Some(project_a.clone()),
        "card-a",
        DocClass::UserDoc,
        "---\nstatus: todo\n---\n# Card A\n".into(),
    )
    .await;
    sync(&store, &runtime, &scope).await;
    let head_before_archive = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let cut_before_shutdown = engine
        .wait_for_projected(&scope, head_before_archive, &budget())
        .await
        .unwrap();

    // 1. Project-scoped subscriber must receive Lifecycle(Closing) even after the Space
    //    transitions out of SpaceLifecycle::Active.
    let bus = engine.event_bus();
    let mut project_stream = bus
        .subscribe(
            scoped_ctx.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after: head_before_archive,
            },
        )
        .await
        .unwrap();
    let mut pause = engine.pause_after_read_payload_for_test(&scope).unwrap();
    let hydrate = engine.hydrate(
        owner_a.clone(),
        cut_before_shutdown.clone(),
        vec![card.note.clone(); 201],
    );
    let (archived, ()) = tokio::join!(hydrate, async {
        tokio::time::timeout(
            Duration::from_secs(3),
            pause.reached_feed_boundary_for_test(),
        )
        .await
        .unwrap()
        .unwrap();
        set_space_lifecycle(&store, &owner_a, SpaceLifecycle::Archived).await;
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            head_before_archive
        );
        pause.resume_for_test().await.unwrap();
    });
    assert!(matches!(
        archived,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    bus.publish(
        event_pub_ctx(),
        SpaceEvent {
            scope: scope.clone(),
            seq: head_before_archive,
            kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Closing),
        },
    )
    .await
    .unwrap();
    let received = tokio::time::timeout(Duration::from_secs(3), project_stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            received.kind,
            SpaceEventKind::Lifecycle(SpaceLifecycle::Closing)
        ),
        "project-scoped subscriber must receive Lifecycle(Closing) when Space is non-active"
    );

    // Restore Space to Active so shutdown admission checks are isolated from archive state.
    set_space_lifecycle(&store, &owner_a, SpaceLifecycle::Active).await;

    // 2. After projector shutdown (`publication_closed == true`), StructuralReadPort::hydrate
    //    must fail closed with NotReady instead of serving canonical fallback.
    runtime.shutdown().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), project_stream.next())
            .await
            .expect("idle subscription must end at runtime shutdown")
            .unwrap()
            .is_none()
    );
    let hydrated_after_shutdown = StructuralReadPort::hydrate(
        engine.as_ref(),
        owner_a,
        cut_before_shutdown,
        vec![card.note],
    )
    .await;
    assert!(
        matches!(
            hydrated_after_shutdown,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::NotReady
        ),
        "StructuralReadPort::hydrate must fail closed with NotReady after shutdown, got {hydrated_after_shutdown:?}"
    );

    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn personal_chat_audience_isolation_and_deferred_backlink_taint() {
    use notarium_core::ports::{ChangeRead, ChangeReadResult, ChatRead, EntityId};

    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope_a, owner_a) = open_space(&store, SpaceKind::Shared).await;
    let (scope_a_personal, owner_a_personal) = open_space(&store, SpaceKind::Personal).await;
    let (scope_b, owner_b_home) = open_space(&store, SpaceKind::Personal).await;
    let principal_a = owner_a.auth().principal().clone();
    let principal_a_personal = owner_a_personal.auth().principal().clone();
    let principal_b = owner_b_home.auth().principal().clone();
    let owner_b_in_a = owner_ctx(&scope_a, &principal_b);

    let target_a = create_note(
        &store,
        &owner_a,
        None,
        "target-a",
        DocClass::UserDoc,
        "# Target A\n".into(),
    )
    .await;
    let target_b = create_note(
        &store,
        &owner_b_home,
        None,
        "target-b",
        DocClass::UserDoc,
        "# Target B\n".into(),
    )
    .await;

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root,
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = runtime.engine();
    sync(&store, &runtime, &scope_a).await;
    sync(&store, &runtime, &scope_a_personal).await;
    sync(&store, &runtime, &scope_b).await;

    let head_a_before = store.read_space(&scope_a.space_id).await.unwrap().last_seq;
    let thread = ChatThreadId::from_bytes(rand16());
    store
        .create_chat(
            owner_a.clone(),
            mutation(
                &owner_a,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: principal_a.clone(),
                    project_folder: None,
                    title: "Owner A private thread".into(),
                },
            ),
        )
        .await
        .unwrap();
    let appended = store
        .append_chat(
            owner_a.clone(),
            mutation(
                &owner_a,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Mentions note A".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: scope_a.space_id.clone(),
                        note_id: target_a.note.clone(),
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope_a).await;
    let head_a_after = store.read_space(&scope_a.space_id).await.unwrap().last_seq;

    // Cross-space chat backlink from a Personal Space referencing target_b in scope_b.
    let owner_a_cross_grants = BTreeMap::from([
        (
            scope_a_personal.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        ),
        (
            scope_b.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Viewer,
                read_classes: DocClass::all(),
                write_classes: Default::default(),
                project_root: None,
            },
        ),
    ]);
    let owner_a_cross = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            principal_a_personal.clone(),
            GrantId::from_bytes(rand16()),
            owner_a_cross_grants,
            false,
        )),
        scope_a_personal.clone(),
        budget(),
    )
    .unwrap();
    let cross_thread = ChatThreadId::from_bytes(rand16());
    store
        .create_chat(
            owner_a_cross.clone(),
            mutation(
                &owner_a_cross,
                CreateChat {
                    thread: cross_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: principal_a_personal,
                    project_folder: None,
                    title: "Cross-space private thread".into(),
                },
            ),
        )
        .await
        .unwrap();
    store
        .append_chat(
            owner_a_cross.clone(),
            mutation(
                &owner_a_cross,
                AppendChat {
                    thread: cross_thread,
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Mentions foreign note B".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: scope_b.space_id.clone(),
                        note_id: target_b.note.clone(),
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope_a_personal).await;

    let full_grants_a = BTreeMap::from([(
        scope_a.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Owner,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        },
    )]);
    let human_a = EngineAuthContext::for_human(VerifiedHuman::attest(
        principal_a.clone(),
        GrantId::from_bytes(rand16()),
        full_grants_a.clone(),
        false,
    ));
    let shared_agent_a = SpaceContext::new(
        human_a
            .for_agent_run(
                AgentRunId::from_bytes(rand16()),
                scope_a.space_id.clone(),
                ChatAudience::Shared,
                full_grants_a.clone(),
            )
            .unwrap(),
        scope_a.clone(),
        budget(),
    )
    .unwrap();
    let personal_agent_a = SpaceContext::new(
        human_a
            .for_agent_run(
                AgentRunId::from_bytes(rand16()),
                scope_a.space_id.clone(),
                ChatAudience::Personal,
                full_grants_a,
            )
            .unwrap(),
        scope_a.clone(),
        budget(),
    )
    .unwrap();

    let read_req = ChatRead {
        thread: thread.clone(),
        leaf: appended.value.seq,
        before: None,
        max_entries: PageLimit::new(10).unwrap(),
    };
    assert!(
        store
            .read_chat(owner_a.clone(), read_req.clone())
            .await
            .is_ok()
    );
    assert!(
        store
            .read_chat(personal_agent_a.clone(), read_req.clone())
            .await
            .is_ok()
    );
    assert!(matches!(
        store
            .read_chat(owner_b_in_a.clone(), read_req.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        store.read_chat(shared_agent_a.clone(), read_req).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    let await_all = CausalBasis::Await(AwaitWatermarks::default());
    assert_eq!(
        LinkReadPort::chat_backlinks(
            engine.as_ref(),
            owner_a.clone(),
            target_a.note.clone(),
            await_all.clone(),
        )
        .await
        .unwrap()
        .len(),
        1
    );
    assert_eq!(
        LinkReadPort::chat_backlinks(
            engine.as_ref(),
            personal_agent_a,
            target_a.note.clone(),
            await_all.clone(),
        )
        .await
        .unwrap()
        .len(),
        1
    );
    assert!(
        LinkReadPort::chat_backlinks(
            engine.as_ref(),
            owner_b_in_a,
            target_a.note.clone(),
            await_all.clone(),
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert!(
        LinkReadPort::chat_backlinks(
            engine.as_ref(),
            shared_agent_a.clone(),
            target_a.note.clone(),
            await_all.clone(),
        )
        .await
        .unwrap()
        .is_empty()
    );

    let ChangeReadResult::Log(log_page) = ProjectedNoteReadPort::new(engine.clone())
        .recent_activity(
            shared_agent_a,
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope_a.clone(),
                    after: head_a_before,
                },
                through: head_a_after,
                limit: PageLimit::new(50).unwrap(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected log page");
    };
    assert!(
        !log_page
            .changes
            .iter()
            .any(|row| row.entity == EntityId::Thread(thread.clone())),
        "Shared-audience agent must not observe Personal thread changes in recent_activity"
    );

    let cross_grants_b = BTreeMap::from([
        (
            scope_b.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        ),
        (
            scope_a_personal.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Viewer,
                read_classes: DocClass::all(),
                write_classes: Default::default(),
                project_root: None,
            },
        ),
    ]);
    let human_b = EngineAuthContext::for_human(VerifiedHuman::attest(
        principal_b,
        GrantId::from_bytes(rand16()),
        cross_grants_b.clone(),
        false,
    ));
    let agent_b_in_b = SpaceContext::new(
        human_b
            .for_agent_run(
                AgentRunId::from_bytes(rand16()),
                scope_b.space_id.clone(),
                ChatAudience::Personal,
                cross_grants_b,
            )
            .unwrap(),
        scope_b.clone(),
        budget(),
    )
    .unwrap();
    assert!(!agent_b_in_b.auth().taint().is_tainted());
    let backlinks_b = LinkReadPort::chat_backlinks(
        engine.as_ref(),
        agent_b_in_b.clone(),
        target_b.note,
        await_all,
    )
    .await
    .unwrap();
    assert!(backlinks_b.is_empty());
    assert!(
        !agent_b_in_b.auth().taint().is_tainted(),
        "hidden foreign Personal chat candidate must not taint caller"
    );

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn event_scrub_on_redact_chat_and_restricted_subscriber_floor() {
    use notarium_core::ports::{ChatRead, RedactChatEntry};

    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let note = create_note(
        &store,
        &owner,
        None,
        "linked",
        DocClass::UserDoc,
        "# Linked\n".into(),
    )
    .await;
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root,
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = runtime.engine();
    sync(&store, &runtime, &scope).await;
    let base_head = store.read_space(&scope.space_id).await.unwrap().last_seq;

    let thread = ChatThreadId::from_bytes(rand16());
    store
        .create_chat(
            owner.clone(),
            mutation(
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.auth().principal().clone(),
                    project_folder: None,
                    title: "Scrub test".into(),
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope).await;
    let pre_append_head = store.read_space(&scope.space_id).await.unwrap().last_seq;

    let bus = engine.event_bus();
    let mut owner_stream = bus
        .subscribe(
            owner.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after: pre_append_head,
            },
        )
        .await
        .unwrap();
    let restricted_grants = BTreeMap::from([(
        scope.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Viewer,
            read_classes: [DocClass::UserDoc].into_iter().collect(),
            write_classes: Default::default(),
            project_root: None,
        },
    )]);
    let restricted_ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes(rand16()),
            GrantId::from_bytes(rand16()),
            restricted_grants,
            false,
        )),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let mut restricted_stream = bus
        .subscribe(
            restricted_ctx,
            ChangeCursor {
                scope: scope.clone(),
                after: base_head,
            },
        )
        .await
        .unwrap();

    let appended = store
        .append_chat(
            owner.clone(),
            mutation(
                &owner,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Sensitive secret".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: scope.space_id.clone(),
                        note_id: note.note,
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope).await;

    let branch = store
        .read_chat(
            owner.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: appended.value.seq,
                before: None,
                max_entries: PageLimit::new(10).unwrap(),
            },
        )
        .await
        .unwrap();

    store
        .redact_chat_entry(
            owner.clone(),
            mutation(
                &owner,
                RedactChatEntry {
                    thread,
                    entry: appended.value.seq,
                    expected_thread_revision: branch.thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope).await;

    let first_event = tokio::time::timeout(Duration::from_secs(3), owner_stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(first_event.kind, SpaceEventKind::ResyncRequired),
        "pure RedactChatEntry must scrub queued Changed events into ResyncRequired, got: {first_event:?}"
    );

    let restricted_event = tokio::time::timeout(Duration::from_secs(3), restricted_stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(
        restricted_event.kind,
        SpaceEventKind::ResyncRequired
    ));
    assert_eq!(
        restricted_event.seq, base_head,
        "restricted subscriber must not observe global projected_seq in ResyncRequired"
    );

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn live_single_purge_recovers_incrementally_without_reading_surviving_blobs() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let (parent_folder, _) = create_folder(&store, &owner, None, "parent", false).await;
    let (child_folder, _) =
        create_folder(&store, &owner, Some(parent_folder.clone()), "child", false).await;

    let victim = create_note(
        &store,
        &owner,
        Some(child_folder.clone()),
        "shared-topic",
        DocClass::UserDoc,
        "# Shared Topic\n".into(),
    )
    .await;
    let fallback = create_note(
        &store,
        &owner,
        Some(parent_folder.clone()),
        "shared-topic",
        DocClass::UserDoc,
        "# Shared Topic\n".into(),
    )
    .await;
    let linker = create_note(
        &store,
        &owner,
        None,
        "linker",
        DocClass::UserDoc,
        "Points to [[shared-topic]].\n".into(),
    )
    .await;

    let gen1 = ProjectionGeneration::new(1).unwrap();
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        gen1,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = runtime.engine();
    sync(&store, &runtime, &scope).await;
    let seq_before = store.read_space(&scope.space_id).await.unwrap().last_seq;

    let dir = root.space_fast_index_dir(gen1, &scope.space_id);
    let prefix = format!("fast_index_{}_", seq_before.get());
    let nonce_file = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .find(|name| name.starts_with(&prefix) && name.ends_with(".mmap"))
        .expect("published checkpoint must carry a publication nonce");
    let nonce_hex = nonce_file
        .strip_prefix(&prefix)
        .unwrap()
        .strip_suffix(".mmap")
        .unwrap();
    assert_eq!(nonce_hex.len(), 32);
    assert!(nonce_hex.bytes().all(|b| b.is_ascii_hexdigit()));

    let before_links = LinkReadPort::note_links(
        engine.as_ref(),
        owner.clone(),
        linker.note.clone(),
        NoteLinkDirection::Outgoing,
        None,
        PageLimit::new(10).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(before_links.links.len(), 1);
    assert_eq!(before_links.links[0].target, Some(victim.note.clone()));

    // Hide surviving notes' canonical CAS blobs so any full-Space CAS reseed would fail.
    let notes_page = store
        .read_projection_notes_page(
            &projection_ctx(),
            &scope,
            seq_before,
            None,
            PageLimit::new(10).unwrap(),
        )
        .await
        .unwrap();
    let mut hidden_blobs = Vec::new();
    for row in notes_page.rows {
        if row.metadata.note_id != victim.note
            && let Some(digest) = row.metadata.content_digest
        {
            let path = root.blob(&scope.space_id, digest);
            let backup = path.with_extension("hidden-during-incremental-purge");
            std::fs::rename(&path, &backup).unwrap();
            hidden_blobs.push((path, backup));
        }
    }
    assert_eq!(hidden_blobs.len(), 2);

    store
        .delete_note(
            owner.clone(),
            mutation(
                &owner,
                DeleteNote {
                    note: victim.note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    sync(&store, &runtime, &scope).await;

    for (original, backup) in hidden_blobs {
        std::fs::rename(backup, original).unwrap();
    }

    let after_links = LinkReadPort::note_links(
        engine.as_ref(),
        owner.clone(),
        linker.note.clone(),
        NoteLinkDirection::Outgoing,
        None,
        PageLimit::new(10).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(after_links.links.len(), 1);
    assert_eq!(after_links.links[0].target, Some(fallback.note.clone()));

    let db = rusqlite::Connection::open(root.derived(gen1)).unwrap();
    let count_for = |folder: &FolderId| -> i64 {
        db.query_row(
            "SELECT active_note_count FROM projected_folders WHERE space_id = ? AND folder_id = ?",
            [scope.space_id.as_str(), folder.as_str()],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(count_for(&child_folder), 0);
    assert_eq!(count_for(&parent_folder), 1);

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn root_non_recursive_listing_supercluster_csprng_and_decommission_gate() {
    use notarium_canonical::StoppedProjectionDeployment;
    use notarium_core::{
        error::ValidationReason,
        ports::{GraphNodeId, GraphQuery, GraphTier},
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let installation = InstallationId::from_bytes(rand16());
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let (project, _) = create_folder(&store, &owner, None, "proj", true).await;
    let (sub, _) = create_folder(&store, &owner, Some(project.clone()), "sub", false).await;

    let root_note = create_note(
        &store,
        &owner,
        None,
        "root-only",
        DocClass::UserDoc,
        "# Root\n".into(),
    )
    .await;
    let proj_note = create_note(
        &store,
        &owner,
        Some(project.clone()),
        "proj-direct",
        DocClass::UserDoc,
        "# Proj\n".into(),
    )
    .await;
    let sub_note = create_note(
        &store,
        &owner,
        Some(sub.clone()),
        "sub-nested",
        DocClass::UserDoc,
        format!("# Sub\nLinks to [[{}]].\n", proj_note.note),
    )
    .await;

    let (scope2, owner2) = open_space(&store, SpaceKind::Personal).await;
    let n1 = store
        .create_note(
            owner2.clone(),
            mutation(
                &owner2,
                CreateNote {
                    note: proj_note.note.clone(),
                    parent: None,
                    slug: "n1".into(),
                    class: DocClass::UserDoc,
                    carrier: "# N1\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    let _n2 = store
        .create_note(
            owner2.clone(),
            mutation(
                &owner2,
                CreateNote {
                    note: sub_note.note.clone(),
                    parent: None,
                    slug: "n2".into(),
                    class: DocClass::UserDoc,
                    carrier: format!("# N2 [[{}]]\n", n1.value.note),
                },
            ),
        )
        .await
        .unwrap();

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = runtime.engine();
    sync(&store, &runtime, &scope).await;
    sync(&store, &runtime, &scope2).await;

    let read_port = engine.note_reads();
    let direct_root = read_port
        .list_notes(
            owner.clone(),
            ReadRequest::Open {
                query: NoteQuery {
                    folder: None,
                    recursive: false,
                    classes: DocClass::all(),
                    lifecycle: LifecycleMask::Active,
                    filter: empty_filter(),
                    sort: SortSpec::default(),
                    limit: PageLimit::new(20).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .unwrap();
    let root_ids: BTreeSet<_> = direct_root
        .children
        .items
        .iter()
        .map(|row| row.document.reference().note_id.clone())
        .collect();
    assert_eq!(root_ids, BTreeSet::from([root_note.note.clone()]));

    let proj_grants = BTreeMap::from([(
        scope.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: Some(project.clone()),
        },
    )]);
    let proj_ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes(rand16()),
            GrantId::from_bytes(rand16()),
            proj_grants,
            false,
        )),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let direct_proj = read_port
        .list_notes(
            proj_ctx.clone(),
            ReadRequest::Open {
                query: NoteQuery {
                    folder: None,
                    recursive: false,
                    classes: DocClass::all(),
                    lifecycle: LifecycleMask::Active,
                    filter: empty_filter(),
                    sort: SortSpec::default(),
                    limit: PageLimit::new(20).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .unwrap();
    let proj_ids: BTreeSet<_> = direct_proj
        .children
        .items
        .iter()
        .map(|row| row.document.reference().note_id.clone())
        .collect();
    assert_eq!(proj_ids, BTreeSet::from([proj_note.note.clone()]));

    let super_err = engine
        .query_graph(
            proj_ctx,
            GraphQuery {
                tier: GraphTier::Superclusters,
                filter: empty_filter(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        super_err,
        PortError::Domain(DomainError::AccessDenied)
    ));

    let sc = engine
        .query_graph(
            owner.clone(),
            GraphQuery {
                tier: GraphTier::Superclusters,
                filter: empty_filter(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        sc.nodes.len(),
        1,
        "isolated degree-0 note must not create a singleton cluster"
    );
    let GraphNodeId::Cluster(cluster_1) = sc.nodes[0].id.clone() else {
        panic!("expected cluster node");
    };

    let sc2 = engine
        .query_graph(
            owner2,
            GraphQuery {
                tier: GraphTier::Superclusters,
                filter: empty_filter(),
            },
        )
        .await
        .unwrap();
    assert_eq!(sc2.nodes.len(), 1);
    let GraphNodeId::Cluster(cluster_2) = sc2.nodes[0].id.clone() else {
        panic!("expected cluster node");
    };
    assert_ne!(
        cluster_1, cluster_2,
        "fresh ClusterId must be 128-bit CSPRNG, not derived from anchor NoteId"
    );

    let cache_id = std::fs::read_to_string(root.root().join("v1/projection_cache_id"))
        .unwrap()
        .trim()
        .to_owned();
    let revocation = MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
        budget: budget(),
    };
    let witness = StoppedProjectionDeployment::attest(cache_id.clone()).unwrap();
    let attached_err = store
        .confirm_projection_cleanup_decommissioned(&revocation, witness)
        .await
        .unwrap_err();
    assert!(matches!(
        attached_err,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::NotReady
    ));

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
    drop(store);

    let (reopened_store, reopened_canonical) =
        CanonicalRuntime::open(CanonicalConfig::local_default(installation, root.clone()))
            .await
            .unwrap();
    let witness = StoppedProjectionDeployment::attest(cache_id).unwrap();
    reopened_store
        .confirm_projection_cleanup_decommissioned(&revocation, witness)
        .await
        .unwrap();
    reopened_store
        .delete_note(
            owner.clone(),
            mutation(
                &owner,
                DeleteNote {
                    note: root_note.note,
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    reopened_canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn hydrate_older_snapshot_checks_recorded_facts_and_schema_move_updates_fence() {
    use notarium_core::ports::MoveNote;

    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let (secret_folder, _) = create_folder(&store, &owner, None, "secret", false).await;
    let (public_folder, _) = create_folder(&store, &owner, None, "public", true).await;

    let secret_note = create_note(
        &store,
        &owner,
        Some(secret_folder.clone()),
        "layoffs",
        DocClass::UserDoc,
        "# Layoffs Q4\nConfidential plan.\n".into(),
    )
    .await;
    let public_schema_note = create_note(
        &store,
        &owner,
        Some(public_folder.clone()),
        "schema-note",
        DocClass::UserDoc,
        "# Schema Carrier\n".into(),
    )
    .await;

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = runtime.engine();
    sync(&store, &runtime, &scope).await;

    let public_grants = BTreeMap::from([(
        scope.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: Some(public_folder.clone()),
        },
    )]);
    let public_ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes(rand16()),
            GrantId::from_bytes(rand16()),
            public_grants,
            false,
        )),
        scope.clone(),
        budget(),
    )
    .unwrap();

    // Capture a retained snapshot cut at the pre-sanitization seq.
    let read_port = engine.note_reads();
    let opened = read_port
        .list_notes(
            public_ctx.clone(),
            ReadRequest::Open {
                query: NoteQuery {
                    folder: None,
                    recursive: true,
                    classes: DocClass::all(),
                    lifecycle: LifecycleMask::Active,
                    filter: empty_filter(),
                    sort: SortSpec::default(),
                    limit: PageLimit::new(20).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .unwrap();
    let snapshot_before = notarium_core::model::SnapshotCut {
        scope: opened.children.scope,
        generation: ProjectionGeneration::new(1).unwrap(),
        canonical_seq: opened.children.canonical_seq,
        projected_seq: opened.children.projected_seq,
    };

    // Pause background projection so the retained cut stays pinned at
    // `snapshot_before` while canonical head advances past it, deterministically
    // exercising `hydrate_cards_at`'s fast-path head check.
    let _pause = engine.pause_before_projection_for_test(&scope, 1).unwrap();

    // Sanitize the secret note and move it into `/public/`. Canonical head
    // advances past `snapshot_before`, while the retained cut still holds the
    // pre-sanitization title/preview/path at `snapshot_before`.
    let old_carrier = "# Layoffs Q4\nConfidential plan.\n";
    let body = notarium_syntax::frontmatter::analyze(old_carrier, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        old_carrier,
        body,
        vec![(
            CarrierEditOrigin::Body,
            body,
            "# Public FAQ\nSanitized text.\n".into(),
        )],
    )
    .unwrap();
    let mut edit = mutation(
        &owner,
        EditNote {
            note: secret_note.note.clone(),
            plan,
        },
    );
    edit.preconditions.revision = Some(secret_note.revision);
    let edited = store.edit_note(owner.clone(), edit).await.unwrap();
    let _moved = store
        .move_note(
            owner.clone(),
            mutation(
                &owner,
                MoveNote {
                    note: secret_note.note.clone(),
                    parent: Some(public_folder.clone()),
                    slug: "public-faq".into(),
                },
            ),
        )
        .await
        .unwrap();
    assert!(edited.receipt.seq() > snapshot_before.projected_seq);

    // Hydrating `secret_note` at the older snapshot cut MUST NOT leak the
    // pre-sanitization title/preview/path to the `/public/`-pinned caller.
    let hydrated = StructuralReadPort::hydrate(
        engine.as_ref(),
        public_ctx.clone(),
        snapshot_before,
        vec![secret_note.note.clone()],
    )
    .await
    .unwrap();
    assert_eq!(hydrated.len(), 1);
    assert!(
        hydrated[0].is_none(),
        "historical hydrate must verify recorded facts and must not leak pre-sanitization metadata"
    );
    drop(_pause);

    // Move an existing note out of `/public/` via `update_space_schema` and
    // verify `LiveLifecycleFence` immediately hides it from `/public/` readers.
    let _schema = store
        .update_space_schema(
            owner.clone(),
            mutation(
                &owner,
                UpdateSpaceSchema {
                    schema_note: public_schema_note.note.clone(),
                    parent: None,
                    slug: "schema-note-root".into(),
                    carrier: "# Moved Schema\n".into(),
                    schema: BTreeMap::new(),
                    expected_schema_revision: None,
                },
            ),
        )
        .await
        .unwrap();
    assert!(
        !StructuralReadPort::is_live_visible(
            engine.as_ref(),
            &public_ctx,
            &public_schema_note.note,
        )
        .await
        .unwrap(),
        "update_space_schema moving an existing note out of project_root must update live fence"
    );

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn backlink_lookahead_taints_and_tainted_mutation_hides_foreign_personal_chat() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
        root.clone(),
    ))
    .await
    .unwrap();

    // Create two Personal Spaces owned by `principal_a` and order them so the
    // local Space ID sorts BEFORE the foreign Space ID (so row 0 is local and
    // lookahead row 1 is foreign in `ORDER BY thread_space_id, thread_id, entry_seq`).
    let principal_a = PrincipalId::from_bytes(rand16());
    let principal_b = PrincipalId::from_bytes(rand16());
    let mut personal_spaces = Vec::new();
    for label in ["p1", "p2"] {
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes(rand16()),
            incarnation: HistoryIncarnation::from_bytes(rand16()),
        };
        store
            .create_space(CreateSpaceSpec {
                space_id: scope.space_id.clone(),
                incarnation: scope.incarnation,
                root_folder_id: FolderId::from_bytes(rand16()),
                slug: format!("{label}-{}", hex::encode(&rand16()[..4])),
                kind: SpaceKind::Personal,
                owner: principal_a.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let ctx = owner_ctx(&scope, &principal_a);
        personal_spaces.push((scope, ctx));
    }
    personal_spaces.sort_by(|(a, _), (b, _)| a.space_id.as_str().cmp(b.space_id.as_str()));
    let (scope_local, owner_local) = personal_spaces.remove(0);
    let (scope_foreign, _owner_foreign) = personal_spaces.remove(0);

    let target = create_note(
        &store,
        &owner_local,
        None,
        "target",
        DocClass::UserDoc,
        "# Target\n".into(),
    )
    .await;

    // Backlink 0: same Space (`scope_local`), untainted.
    let local_thread = ChatThreadId::from_bytes(rand16());
    store
        .create_chat(
            owner_local.clone(),
            mutation(
                &owner_local,
                CreateChat {
                    thread: local_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: principal_a.clone(),
                    project_folder: None,
                    title: "Local".into(),
                },
            ),
        )
        .await
        .unwrap();
    let local_ref = NoteRef {
        space_id: scope_local.space_id.clone(),
        note_id: target.note.clone(),
    };
    store
        .append_chat(
            owner_local.clone(),
            mutation(
                &owner_local,
                AppendChat {
                    thread: local_thread,
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("local ref".into()),
                    referenced_notes: vec![local_ref.clone()],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();

    // Backlink 1: foreign Space (`scope_foreign > scope_local`), visible to `principal_a`.
    let owner_foreign_cross = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            principal_a.clone(),
            GrantId::from_bytes(rand16()),
            BTreeMap::from([
                (
                    scope_foreign.space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Owner,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: None,
                    },
                ),
                (
                    scope_local.space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Owner,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: None,
                    },
                ),
            ]),
            false,
        )),
        scope_foreign.clone(),
        budget(),
    )
    .unwrap();
    let foreign_thread = ChatThreadId::from_bytes(rand16());
    store
        .create_chat(
            owner_foreign_cross.clone(),
            mutation(
                &owner_foreign_cross,
                CreateChat {
                    thread: foreign_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: principal_a.clone(),
                    project_folder: None,
                    title: "Foreign".into(),
                },
            ),
        )
        .await
        .unwrap();
    store
        .append_chat(
            owner_foreign_cross.clone(),
            mutation(
                &owner_foreign_cross,
                AppendChat {
                    thread: foreign_thread,
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("foreign ref".into()),
                    referenced_notes: vec![local_ref],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();

    // Shared Space where `principal_a` has a Personal thread and `principal_b`
    // is an Editor with a tainted branch attempting to mutate `principal_a`'s
    // Personal thread.
    let shared_scope = HistoryScope {
        space_id: SpaceId::from_bytes(rand16()),
        incarnation: HistoryIncarnation::from_bytes(rand16()),
    };
    store
        .create_space(CreateSpaceSpec {
            space_id: shared_scope.space_id.clone(),
            incarnation: shared_scope.incarnation,
            root_folder_id: FolderId::from_bytes(rand16()),
            slug: format!("shared-oracle-{}", hex::encode(&rand16()[..4])),
            kind: SpaceKind::Shared,
            owner: principal_a.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let owner_shared = owner_ctx(&shared_scope, &principal_a);
    let private_in_shared = ChatThreadId::from_bytes(rand16());
    store
        .create_chat(
            owner_shared.clone(),
            mutation(
                &owner_shared,
                CreateChat {
                    thread: private_in_shared.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: principal_a.clone(),
                    project_folder: None,
                    title: "Owner Private".into(),
                },
            ),
        )
        .await
        .unwrap();

    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = runtime.engine();
    sync(&store, &runtime, &scope_local).await;
    sync(&store, &runtime, &scope_foreign).await;

    let agent_grants = BTreeMap::from([
        (
            scope_local.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        ),
        (
            scope_foreign.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        ),
    ]);
    let human_a = EngineAuthContext::for_human(VerifiedHuman::attest(
        principal_a,
        GrantId::from_bytes(rand16()),
        agent_grants.clone(),
        false,
    ));
    let agent_ctx = SpaceContext::new(
        human_a
            .for_agent_run(
                AgentRunId::from_bytes(rand16()),
                scope_local.space_id.clone(),
                ChatAudience::Personal,
                agent_grants,
            )
            .unwrap(),
        scope_local.clone(),
        budget(),
    )
    .unwrap();
    assert!(!agent_ctx.auth().taint().is_tainted());

    // Limit = 1 returns only the local backlink, while `next.is_some()` is
    // determined by the foreign lookahead row -> branch taint MUST engage.
    let page = LinkReadPort::chat_backlinks_page(
        engine.as_ref(),
        agent_ctx.clone(),
        target.note.clone(),
        CausalBasis::Await(AwaitWatermarks::default()),
        None,
        PageLimit::new(1).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(page.links.len(), 1);
    assert_eq!(page.links[0].thread.space, scope_local.space_id);
    assert!(page.next.is_some());
    assert!(
        agent_ctx.auth().taint().is_tainted(),
        "lookahead witness that sets page.next must taint the branch"
    );

    // Tainted non-owner attempting to mutate a foreign Personal thread in a
    // Shared Space must get ResourceNotFound (not CrossSpaceTainted).
    let b_grants = BTreeMap::from([(
        shared_scope.space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        },
    )]);
    let b_auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        principal_b,
        GrantId::from_bytes(rand16()),
        b_grants,
        false,
    ));
    b_auth.taint().mark_external_read();
    let b_ctx = SpaceContext::new(b_auth, shared_scope, budget()).unwrap();
    let err = store
        .append_chat(
            b_ctx.clone(),
            mutation(
                &b_ctx,
                AppendChat {
                    thread: private_in_shared,
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("probe".into()),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, PortError::Domain(DomainError::ResourceNotFound)),
        "expected ResourceNotFound for foreign Personal thread mutation by tainted caller, got {err:?}"
    );

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[path = "projection_regressions/read_windows.rs"]
mod read_windows;
