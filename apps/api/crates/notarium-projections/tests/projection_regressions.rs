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

#[tokio::test]
async fn offline_sqlite_purge_cleans_derived_db_and_mmap_checkpoint() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
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
    let checkpoint = root.space_fast_index(gen1, &scope.space_id, head_before);
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
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
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

    // 1. StructuralReadPort::is_live_visible must taint cross-space reads.
    let ctx1 = cross_ctx();
    assert!(!ctx1.auth().taint().is_tainted());
    assert!(engine.is_live_visible(&ctx1, &note_b.note).unwrap());
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

    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn folder_by_path_ignores_trashed_collision_and_list_notes_hydrates_cover_page() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
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
async fn ryow_exact_falls_back_to_wait_on_intervening_schema_or_folder_mutation() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
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
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
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
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
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
                    thread,
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
    use notarium_core::{
        error::ValidationReason, ports::ControlCatalogPort, receipt::AccountCommandIdentity,
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
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
    store
        .change_lifecycle(
            budget(),
            AccountCommandIdentity {
                owner: owner_a.auth().principal().clone(),
                actor: owner_a.auth().principal().clone(),
                key: CommandKey::from_bytes(rand16()),
                hash: ContentDigest::from_bytes([1; 32]),
                expected: ControlRevision::ZERO,
            },
            scope.clone(),
            SpaceLifecycle::Archived,
        )
        .await
        .unwrap();
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
    store
        .change_lifecycle(
            budget(),
            AccountCommandIdentity {
                owner: owner_a.auth().principal().clone(),
                actor: owner_a.auth().principal().clone(),
                key: CommandKey::from_bytes(rand16()),
                hash: ContentDigest::from_bytes([2; 32]),
                expected: ControlRevision::ZERO,
            },
            scope.clone(),
            SpaceLifecycle::Active,
        )
        .await
        .unwrap();

    // 2. After projector shutdown (`publication_closed == true`), StructuralReadPort::hydrate
    //    must fail closed with NotReady instead of serving canonical fallback.
    runtime.shutdown().await.unwrap();
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
