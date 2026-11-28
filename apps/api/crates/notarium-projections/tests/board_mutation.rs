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
    PgConnectConfig, PgTransport, S3AddressingStyle, S3BucketModePolicy, S3Config, S3Credentials,
    SqlBackendConfig, UpdateSpaceSchema, WriterConfig, blobs::s3::admin_ensure_bucket,
    config::default_postgres_backup_budget,
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
        CallBudget, Cancellation, CreateNote, EventBusPort, FilenamePin, GetNote, GroupKey,
        InterceptedMutation, InterceptionResult, LiveCollabInterceptor, MaintenanceContext,
        MoveBoardCard, Mutation, NoteRevision, NoteWritePort, PortFuture, Preconditions,
        RankExpectation, RollbackReservation, ServiceAuthority, ServicePurpose, SpaceContext,
        SpaceEventKind, ViewRef,
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

fn find_checkpoint_file(
    root: &DataRoot,
    generation: ProjectionGeneration,
    space: &SpaceId,
    seq: SpaceSeq,
) -> Option<PathBuf> {
    let dir = root.space_fast_index_dir(generation, space);
    let prefix = format!("fast_index_{}", seq.get());
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name();
        let name = name.to_str()?;
        let rest = name.strip_prefix(&prefix)?;
        let matches = rest == ".mmap"
            || (rest.starts_with('_') && rest.ends_with(".mmap") && rest.len() == 1 + 32 + 5);
        matches.then(|| entry.path())
    })
}

#[derive(Deserialize)]
struct PgFixture {
    pg_socket_dir_container: PathBuf,
    pg_socket_dir_host: PathBuf,
    pg_port: u16,
    pg_user: String,
    pg_password: String,
    pg_database: String,
    s3_socket_container: PathBuf,
    s3_socket_host: PathBuf,
    s3_endpoint: String,
    s3_region: String,
    s3_access_key: String,
    s3_secret_key: String,
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

    async fn s3_blobs(&self, prefix: &str) -> BlobBackendConfig {
        let socket = [&self.s3_socket_container, &self.s3_socket_host]
            .into_iter()
            .find(|path| path.exists())
            .expect("MinIO S3 fixture socket")
            .clone();
        let mut cfg = S3Config {
            endpoint: self.s3_endpoint.clone(),
            region: self.s3_region.clone(),
            bucket: "notarium-test-shared".to_owned(),
            application_prefix: String::new(),
            addressing: S3AddressingStyle::PathStyle,
            credentials: S3Credentials {
                access_key_id: self.s3_access_key.clone(),
                secret_access_key: self.s3_secret_key.clone(),
                session_token: None,
            },
            custom_ca_pem: None,
            unix_socket: Some(socket),
            bucket_mode_policy: S3BucketModePolicy::DetectFromBucket,
            request_timeout: Duration::from_secs(10),
        };
        static BUCKET_READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
        BUCKET_READY
            .get_or_init(|| async {
                admin_ensure_bucket(&cfg, Some("Enabled"))
                    .await
                    .expect("ensure shared MinIO test bucket");
            })
            .await;
        cfg.application_prefix = format!("{prefix}/");
        BlobBackendConfig::S3(Box::new(cfg))
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
                    folder_page: false,
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
    // Agents cannot mutate shared board order directly; they edit note frontmatter instead.
    assert!(matches!(
        store
            .move_board_card(runner.clone(), mutation(&runner, intent.clone()))
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let moved = store
        .move_board_card(owner.clone(), mutation(&owner, intent))
        .await
        .expect("human move card with the projection planner");
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

    // An agent changes the card's grouping field via ordinary note editing, moving it to `done`.
    let before_agent = store
        .get_note(
            owner.clone(),
            GetNote {
                note: card.note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    let carrier = before_agent
        .document
        .explicit_read(owner.auth())
        .expect("read card carrier");
    let pos = carrier.find("doing").expect("status: doing in carrier");
    let header_end = carrier
        .find("\n---\n")
        .map(|i| i + "\n---\n".len())
        .unwrap_or(0);
    let plan = notarium_syntax::patch::plan(
        carrier,
        notarium_core::span::ByteSpan::new(header_end, carrier.len()).unwrap(),
        vec![(
            notarium_core::patch::CarrierEditOrigin::Header,
            notarium_core::span::ByteSpan::new(pos, pos + "doing".len()).unwrap(),
            "done".into(),
        )],
    )
    .unwrap();
    let mut agent_edit = mutation(
        &runner,
        notarium_core::ports::EditNote {
            note: card.note.clone(),
            plan,
        },
    );
    agent_edit.preconditions.revision = Some(moved.value.revision.revision.clone());
    store
        .edit_note(runner.clone(), agent_edit)
        .await
        .expect("agent edits status frontmatter");
    sync(store, runtime, &scope).await;

    // Rolling back the agent run restores the card to `doing` while preserving the human rank.
    let rollback = store
        .rollback_agent_run_by_id(owner.clone(), mutation(&owner, run))
        .await
        .expect("rollback agent frontmatter edit by run id");
    let restored = rollback
        .value
        .restored
        .into_iter()
        .find(|row| row.note == card.note)
        .expect("restored card");
    sync(store, runtime, &scope).await;
    let snapshot = store
        .get_note(
            owner.clone(),
            GetNote {
                note: card.note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        snapshot.fields.get("status"),
        Some(&FieldObservation::Ok(FieldValue::Scalar(
            ScalarValue::String("doing".into())
        ))),
    );
    let overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_ref)
        .await
        .unwrap();
    assert_eq!(
        overlays
            .get(&card.note)
            .map(|ov| ov.sort_rank_lexo.as_str()),
        Some(moved.value.rank.as_str()),
        "human manual rank in `doing` survives agent frontmatter edit + rollback"
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
    root: DataRoot,
    postgres: Option<(&PgPool, &str)>,
) {
    let depth_boundary = board_authority::prepare_depth(&store).await;
    let oversized = oversized_views::fixture(&store).await;
    let overflow = board_authority::prepare_overflow(&store).await;
    let runtime = ProjectorRuntime::start_for_test(
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
    offline_erasure::disable_cleanup(&store);
    offline.mutate_offline(&store, &derived, &root).await;

    // Restart on the same canonical store to exercise planner registration and
    // reacquire the durable projection. The old planner must release its binding.
    let mut runtime = ProjectorRuntime::start_for_test(
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
    rotation::exercise(
        &store,
        &mut runtime,
        derived.generation().checked_next().unwrap(),
    )
    .await;

    let interceptor = Arc::new(Interceptor::default());
    store
        .register_collab_interceptor(interceptor.clone())
        .unwrap();
    let shared = agent(
        &owner,
        AgentRunId::from_bytes(random_bytes()),
        ChatAudience::Shared,
    );
    let agent_denied = store
        .move_board_card(
            shared.clone(),
            mutation(&shared, move_card(&card, &view, key.clone())),
        )
        .await;
    assert!(matches!(
        agent_denied,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert_eq!(interceptor.0.load(Ordering::SeqCst), 0);

    // A human caller without read access to `DocClass::Profile` must receive ResourceNotFound
    // before live room interception when the board sources `profile`.
    let mut restricted_grants = owner.auth().spaces().clone();
    restricted_grants
        .get_mut(&owner.scope().space_id)
        .unwrap()
        .read_classes
        .remove(&DocClass::Profile);
    let restricted = SpaceContext::new(
        owner.auth().for_pat(restricted_grants).unwrap(),
        owner.scope().clone(),
        budget(),
    )
    .unwrap();
    let denied = store
        .move_board_card(
            restricted.clone(),
            mutation(&restricted, move_card(&card, &view, key)),
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
async fn board_retry_after_unknown_recovers_committed_move_across_planner_cut() {
    use notarium_core::error::{CommitEffect, RetryAdvice};
    use std::future::poll_fn;

    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(random_bytes()),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store).await;
    let key = ViewKey::from_bytes(random_bytes());
    let view = note(
        &store,
        &owner,
        "board",
        DocClass::UserDoc,
        format!(
            "```nota\nid: {key}\ntype: board\ngroup_by: status\nfilter: {{exists: status}}\n```\n"
        ),
    )
    .await;
    let card = note(
        &store,
        &owner,
        "card",
        DocClass::UserDoc,
        "---\nstatus: todo\n---\nCard\n".into(),
    )
    .await;
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_context(),
        root,
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let command = mutation(&owner, move_card(&card, &view, key));

    let hold = store.acquire_writer_safe_point().await.unwrap();
    let mut first_ctx = owner.clone();
    first_ctx.budget.cancellation = Cancellation::default();
    let cancel = first_ctx.budget.cancellation.clone();
    let mut first = std::pin::pin!(store.move_board_card(first_ctx, command.clone()));
    // The queue and staging budget are free. Once the call yields with its
    // writer active, it is waiting for acknowledgement behind the safe point.
    let first = poll_fn(|cx| {
        let result = first.as_mut().poll(cx);
        if result.is_pending() && store.has_active_sqlite_writes_for_test().unwrap() {
            cancel.cancel();
        }
        result
    })
    .await;
    assert!(matches!(first, Err(PortError::Unavailable(failure))
        if failure.effect() == CommitEffect::Unknown && failure.retry() == RetryAdvice::RetrySameCommand));

    let engine = runtime.engine();
    let mut pause = engine.pause_after_board_facts_for_test(&scope).unwrap();
    let retry = store.move_board_card(owner.clone(), command.clone());
    let (retried, saved) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(retry, async {
            pause.reached_feed_boundary_for_test().await.unwrap();
            drop(hold);
            let cut = engine
                .wait_for_projected(&scope, before.checked_next().unwrap(), &budget())
                .await
                .unwrap();
            // Only the admitted original can have advanced the cut. Recover its
            // typed outcome while the retry is still validating the old board.
            let saved = store
                .move_board_card(owner.clone(), command.clone())
                .await
                .unwrap();
            assert_eq!(saved.receipt.seq(), cut.projected_seq);
            assert_ne!(saved.value.revision.revision, card.revision);
            assert_eq!(saved.value.group, group("doing"));
            pause.resume_for_test().await.unwrap();
            saved
        })
    })
    .await
    .expect("release the board planner after the original commit");
    let retried = retried.expect("same command must recover its durable outcome");
    assert_eq!(retried.receipt, saved.receipt);
    assert_eq!(retried.value.revision, saved.value.revision);
    assert_eq!(retried.value.rank_revision, saved.value.rank_revision);
    assert_eq!(retried.value.rank, saved.value.rank);
    assert_eq!(retried.value.group, saved.value.group);

    let mut grants = owner.auth().spaces().clone();
    grants.get_mut(&scope.space_id).unwrap().role = SpaceRole::Viewer;
    let viewer = SpaceContext::new(
        owner.auth().for_pat(grants).unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    assert!(matches!(
        store.move_board_card(viewer, command).await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        saved.receipt.seq()
    );
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
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
    exercise(store, derived, root, None).await;
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
        blobs: fixture.s3_blobs(&canonical_schema).await,
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
    exercise(store, derived, root, Some((&pool, &derived_schema))).await;
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
