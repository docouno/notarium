//! Board commands use the same semantic planner and authority checks on both stores.
#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use notarium_canonical::{
    BlobBackendConfig, CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec,
    PgConnectConfig, PgTransport, SqlBackendConfig, UpdateSpaceSchema, WriterConfig,
    codec::RevisionMetadataPayload, config::default_postgres_backup_budget,
};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::DataRoot,
    error::PortError,
    ids::*,
    model::HistoryScope,
    ports::{
        AssociatedBoardExpectation, CallBudget, Cancellation, CreateNote, EventBusPort,
        FilenamePin, GetNote, GroupKey, InterceptedMutation, InterceptionResult,
        LiveCollabInterceptor, MaintenanceContext, MoveBoardCard, Mutation, NoteRevision,
        NoteWritePort, PortFuture, Preconditions, RankExpectation, RollbackAgentRun,
        RollbackReservation, ServiceAuthority, ServicePurpose, SpaceContext, SpaceEventKind,
        ViewRef,
    },
    query::{FieldObservation, FieldSchema, FieldType, FieldValue, ScalarType},
    receipt::{CausalBasis, ChangeCursor, CommandIdentity, ReceiptSet},
    value::{ScalarValue, YamlValue},
};
use notarium_projections::{ProjectionConfig, ProjectorRuntime, derived::DerivedStore};
use serde::Deserialize;
use sqlx::{
    Connection, PgPool, SqliteConnection, Transaction,
    postgres::{PgConnectOptions, PgPoolOptions},
    sqlite::SqliteConnectOptions,
};

#[path = "board_mutation/board_authority.rs"]
mod board_authority;
#[cfg(unix)]
#[path = "board_mutation/checkpoint_repair.rs"]
mod checkpoint_repair;
#[path = "board_mutation/events_and_backlinks.rs"]
mod events_and_backlinks;
#[path = "board_mutation/generation_maintenance.rs"]
mod generation_maintenance;
#[path = "board_mutation/offline_erasure.rs"]
mod offline_erasure;
#[path = "board_mutation/oversized_views.rs"]
mod oversized_views;
#[path = "board_mutation/read_surface.rs"]
mod read_surface;
#[path = "board_mutation/rotation.rs"]
mod rotation;

#[derive(Deserialize)]
struct PgFixture {
    pg_socket_dir_container: PathBuf,
    pg_socket_dir_host: PathBuf,
    pg_port: u16,
    pg_user: String,
    pg_password: String,
    pg_database: String,
}

impl PgFixture {
    fn required() -> Self {
        let manifest = std::env::var_os("NOTARIUM_STORAGE_FIXTURES_MANIFEST")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .ancestors()
                    .nth(4)
                    .expect("workspace root")
                    .join(".artifacts/storage-tests/current.json")
            });
        serde_json::from_slice(
            &std::fs::read(manifest)
                .expect("offline PostgreSQL fixture is required, run through make test app=api"),
        )
        .expect("valid PostgreSQL fixture manifest")
    }

    fn socket_dir(&self) -> &Path {
        let file = format!(".s.PGSQL.{}", self.pg_port);
        [&self.pg_socket_dir_container, &self.pg_socket_dir_host]
            .into_iter()
            .find(|path| path.join(&file).exists())
            .expect("PostgreSQL fixture socket")
    }

    fn canonical(&self) -> PgConnectConfig {
        PgConnectConfig {
            transport: PgTransport::UnixSocket {
                socket_dir: self.socket_dir().to_path_buf(),
                port: self.pg_port,
            },
            username: self.pg_user.clone(),
            password: self.pg_password.clone(),
            database: self.pg_database.clone(),
        }
    }

    fn pool_options(&self) -> PgConnectOptions {
        PgConnectOptions::new()
            .socket(self.socket_dir())
            .port(self.pg_port)
            .username(&self.pg_user)
            .password(&self.pg_password)
            .database(&self.pg_database)
    }
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("projection-board-{}", hex::encode(random_bytes())));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn root(&self) -> DataRoot {
        DataRoot::new(&self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn random_bytes() -> [u8; 16] {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes
}

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(random_bytes()),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(15),
    }
}

fn projection_context() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Projection),
        budget: budget(),
    }
}

fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes(random_bytes()),
            hash: ContentDigest::from_bytes(*blake3::hash(&random_bytes()).as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

async fn open_space(store: &CanonicalStore) -> (HistoryScope, SpaceContext) {
    open_space_with_id(store, SpaceId::from_bytes(random_bytes())).await
}

async fn open_space_with_id(
    store: &CanonicalStore,
    space_id: SpaceId,
) -> (HistoryScope, SpaceContext) {
    let owner = PrincipalId::from_bytes(random_bytes());
    let record = store
        .create_space(CreateSpaceSpec {
            space_id,
            incarnation: HistoryIncarnation::from_bytes(random_bytes()),
            root_folder_id: FolderId::from_bytes(random_bytes()),
            slug: format!("board-{}", hex::encode(random_bytes())),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let auth = EngineAuthContext::for_human(
        VerifiedHuman::attest(
            owner,
            GrantId::from_bytes(random_bytes()),
            BTreeMap::from([(
                record.scope.space_id.clone(),
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                },
            )]),
            false,
        )
        .with_human_management(true),
    );
    let ctx = SpaceContext::new(auth, record.scope.clone(), budget()).unwrap();
    (record.scope, ctx)
}

fn agent(ctx: &SpaceContext, run: AgentRunId, audience: ChatAudience) -> SpaceContext {
    let auth = ctx
        .auth()
        .for_agent_run(
            run,
            ctx.scope().space_id.clone(),
            audience,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    SpaceContext::new(auth, ctx.scope().clone(), budget()).unwrap()
}

async fn note(
    store: &CanonicalStore,
    owner: &SpaceContext,
    slug: &str,
    class: DocClass,
    carrier: String,
) -> NoteRevision {
    store
        .create_note(
            owner.clone(),
            mutation(
                owner,
                CreateNote {
                    note: NoteId::from_bytes(random_bytes()),
                    parent: None,
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

fn group(value: &str) -> GroupKey {
    GroupKey::Value(ScalarValue::String(value.to_owned()))
}

fn move_card(card: &NoteRevision, view: &NoteRevision, key: ViewKey) -> MoveBoardCard {
    MoveBoardCard {
        view: ViewRef {
            note: view.note.clone(),
            key,
        },
        note: card.note.clone(),
        group: group("doing"),
        before: None,
        after: None,
        fields: BTreeMap::from([("status".to_owned(), Some(YamlValue::String("doing".into())))]),
        expected_note: card.revision.clone(),
        expected_view: view.revision.clone(),
        expected_rank: RankExpectation::Absent,
    }
}

async fn sync(store: &CanonicalStore, runtime: &ProjectorRuntime, scope: &HistoryScope) {
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    runtime
        .engine()
        .wait_for_projected(scope, head, &budget())
        .await
        .unwrap();
}

async fn run_board_round_trip(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
    schema_enabled: bool,
) -> (SpaceContext, NoteRevision, NoteRevision, ViewKey) {
    let (scope, owner) = open_space(store).await;
    if schema_enabled {
        store
            .update_space_schema(
                owner.clone(),
                mutation(
                    &owner,
                    UpdateSpaceSchema {
                        schema_note: NoteId::from_bytes(random_bytes()),
                        parent: None,
                        slug: "field-schema".into(),
                        carrier: "# Field schema\n".into(),
                        schema: BTreeMap::from([(
                            "status".into(),
                            FieldSchema {
                                kind: FieldType::Scalar(ScalarType::String),
                                nullable: false,
                            },
                        )]),
                        expected_schema_revision: None,
                    },
                ),
            )
            .await
            .expect("publish declared board fields");
    }

    let key = ViewKey::from_bytes([8; 16]);
    let view = note(
        store, &owner, "board", DocClass::UserDoc,
        format!("```nota\nid: {key}\ntype: board\ngroup_by: status\nsource: {{classes: [user-doc, profile]}}\nfilter: {{exists: status}}\n```\n"),
    ).await;
    let card = note(
        store,
        &owner,
        "card",
        DocClass::UserDoc,
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let mut events = runtime
        .engine()
        .event_bus()
        .subscribe(
            owner.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after: head,
            },
        )
        .await
        .expect("subscribe before the board move");
    let run = AgentRunId::from_bytes(random_bytes());
    let runner = agent(&owner, run.clone(), ChatAudience::Personal);
    let intent = move_card(&card, &view, key.clone());
    let view_ref = intent.view.clone();
    let moved = store
        .move_board_card(runner.clone(), mutation(&runner, intent))
        .await
        .expect("move card with the projection planner");
    assert_eq!(moved.value.group, group("doing"));
    sync(store, runtime, &scope).await;
    let delta = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events
                .next()
                .await
                .expect("read board events")
                .expect("event stream remains open");
            if let SpaceEventKind::Board(delta) = event.kind {
                assert_eq!(event.seq, moved.receipt.seq());
                assert_eq!(delta.seq, moved.receipt.seq());
                assert_eq!(delta.view, view_ref);
                return delta;
            }
        }
    })
    .await
    .expect("board delta follows the durable projection");
    assert!(
        delta
            .groups
            .iter()
            .any(|column| column.group == group("doing") && column.count == 1)
    );
    assert_eq!(delta.ranks, [(card.note.clone(), moved.value.rank.clone())]);

    let run_revision = store
        .read_entity_revision_at_cutoff(&scope, "agent_run", run.as_str(), None)
        .await
        .unwrap()
        .expect("agent run revision")
        .revision_id;
    let rank_key = format!("{}:{}:{}", view.note, key, card.note);
    let rank = store
        .read_entity_revision_at_cutoff(&scope, "rank", &rank_key, None)
        .await
        .unwrap()
        .expect("board rank revision");
    let RevisionMetadataPayload::Rank(rank_meta) = rank.metadata.payload else {
        panic!("expected rank metadata");
    };

    let rollback = store
        .rollback_agent_run(
            owner.clone(),
            mutation(
                &owner,
                RollbackAgentRun {
                    run,
                    expected_run_revision: run_revision,
                    expected_entities: vec![moved.value.revision],
                    associated_board_expectations: vec![AssociatedBoardExpectation {
                        view: view_ref,
                        note: card.note.clone(),
                        expected_rank: RankExpectation::Existing(rank.revision_id),
                        expected_placement_revision: rank_meta.placement_revision,
                    }],
                },
            ),
        )
        .await
        .expect("rollback board placement and fields with the same planner");
    let restored = rollback
        .value
        .restored
        .into_iter()
        .find(|row| row.note == card.note)
        .expect("restored card");
    let snapshot = store
        .get_note(
            owner.clone(),
            GetNote {
                note: card.note,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        snapshot.fields.get("status"),
        Some(&FieldObservation::Ok(FieldValue::Scalar(
            ScalarValue::String("todo".into())
        ))),
    );
    (owner, view, restored, key)
}

#[derive(Default)]
struct Interceptor(AtomicUsize);

impl LiveCollabInterceptor for Interceptor {
    fn intercept(&self, _: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(InterceptionResult::Conflict(DomainError::ResourceNotFound)) })
    }

    fn reserve_rollback(
        &self,
        _: SpaceContext,
        _: NoteId,
        _: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        panic!("privacy scenario does not issue rollback");
    }

    fn filename_pin(&self, _: SpaceContext, _: NoteId) -> PortFuture<'_, FilenamePin> {
        panic!("privacy scenario does not inspect filename pins");
    }
}

async fn exercise(
    store: CanonicalStore,
    derived: DerivedStore,
    candidate: DerivedStore,
    root: DataRoot,
    postgres: Option<(&PgPool, &str)>,
) {
    let depth_boundary = board_authority::prepare_depth(&store).await;
    let oversized = oversized_views::fixture(&store).await;
    let overflow = board_authority::prepare_overflow(&store).await;
    let runtime = ProjectorRuntime::start(
        store.clone(),
        projection_context(),
        derived.clone(),
        root.clone(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    depth_boundary.exercise(&store, &runtime).await;
    board_authority::exercise(&store, &runtime).await;
    overflow.exercise(&store, &runtime).await;
    oversized.exercise(&store, &runtime, &derived).await;
    read_surface::exercise(&store, &runtime).await;
    events_and_backlinks::exercise(&store, &runtime).await;
    events_and_backlinks::exercise_restored_target(&store, &runtime, &derived).await;
    run_board_round_trip(&store, &runtime, false).await;
    let stale_links = read_surface::StaleLinks::prepare(&store, &runtime).await;
    let blocker = ProjectionWriteBlock::hold(&root, postgres, stale_links.scope()).await;
    stale_links.exercise(&store, &runtime.engine()).await;
    blocker.release().await;
    let mut offline = offline_erasure::OfflineErasures::prepare(&store, &runtime, &derived).await;
    runtime.shutdown().await.unwrap();
    if postgres.is_some() {
        offline_erasure::disable_cleanup(&store);
    }
    offline.mutate_offline(&store, &derived, &root).await;

    // Restart on the same canonical store to exercise planner registration and
    // reacquire the durable projection. The old planner must release its binding.
    let mut runtime = ProjectorRuntime::start(
        store.clone(),
        projection_context(),
        derived.clone(),
        root,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    offline.verify(&store, &runtime, &derived).await;
    let (owner, view, card, key) = run_board_round_trip(&store, &runtime, true).await;
    note(
        &store,
        &owner,
        "hidden-third-column",
        DocClass::Profile,
        "---\nclass: profile\nstatus: done\n---\n".into(),
    )
    .await;
    sync(&store, &runtime, owner.scope()).await;
    rotation::exercise(&store, &mut runtime, candidate).await;

    let interceptor = Arc::new(Interceptor::default());
    store
        .register_collab_interceptor(interceptor.clone())
        .unwrap();
    let shared = agent(
        &owner,
        AgentRunId::from_bytes(random_bytes()),
        ChatAudience::Shared,
    );
    let denied = store
        .move_board_card(
            shared.clone(),
            mutation(&shared, move_card(&card, &view, key)),
        )
        .await;
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert_eq!(interceptor.0.load(Ordering::SeqCst), 0);
    runtime.shutdown().await.unwrap();
}

enum ProjectionWriteBlock {
    Sqlite(SqliteConnection),
    Postgres(Transaction<'static, sqlx::Postgres>),
}

impl ProjectionWriteBlock {
    async fn hold(
        root: &DataRoot,
        postgres: Option<(&PgPool, &str)>,
        scope: &HistoryScope,
    ) -> Self {
        if let Some((pool, prefix)) = postgres {
            let mut transaction = pool.begin().await.unwrap();
            let sql = format!(
                "SELECT space_id FROM \"{prefix}_g1\".projection_space_guard WHERE space_id = $1 FOR UPDATE"
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(scope.space_id.as_str())
                .fetch_one(&mut *transaction)
                .await
                .unwrap();
            Self::Postgres(transaction)
        } else {
            let options = SqliteConnectOptions::new()
                .filename(root.derived(ProjectionGeneration::new(1).unwrap()))
                .busy_timeout(Duration::from_secs(5));
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("BEGIN IMMEDIATE")
                .execute(&mut connection)
                .await
                .unwrap();
            Self::Sqlite(connection)
        }
    }

    async fn release(self) {
        match self {
            Self::Sqlite(mut connection) => {
                sqlx::query("ROLLBACK")
                    .execute(&mut connection)
                    .await
                    .unwrap();
            }
            Self::Postgres(transaction) => transaction.rollback().await.unwrap(),
        }
    }
}

#[tokio::test]
async fn board_move_and_rollback_sqlite() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(random_bytes()),
        root.clone(),
    ))
    .await
    .unwrap();
    let derived = DerivedStore::open_sqlite(&root, ProjectionGeneration::new(1).unwrap())
        .await
        .unwrap();
    let candidate = DerivedStore::open_sqlite(&root, ProjectionGeneration::new(2).unwrap())
        .await
        .unwrap();
    exercise(store, derived, candidate, root, None).await;
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn board_move_and_rollback_postgres() {
    let fixture = PgFixture::required();
    let scratch = Scratch::new();
    let root = scratch.root();
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_board_{id}");
    let derived_schema = format!("test_board_{id}_d");
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: BlobBackendConfig::Local {
            data_root: root.clone(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    })
    .await
    .unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .connect_with(fixture.pool_options())
        .await
        .unwrap();
    let derived = DerivedStore::open_postgres(
        pool.clone(),
        &derived_schema,
        ProjectionGeneration::new(1).unwrap(),
    )
    .await
    .unwrap();
    let candidate = DerivedStore::open_postgres(
        pool.clone(),
        &derived_schema,
        ProjectionGeneration::new(2).unwrap(),
    )
    .await
    .unwrap();
    exercise(
        store,
        derived,
        candidate,
        root,
        Some((&pool, &derived_schema)),
    )
    .await;
    canonical.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        format!("{derived_schema}_g1"),
        format!("{derived_schema}_g2"),
        format!("{derived_schema}_ctrl"),
    ] {
        let ddl = format!("DROP SCHEMA IF EXISTS {schema} CASCADE");
        sqlx::query(sqlx::AssertSqlSafe(ddl))
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}
