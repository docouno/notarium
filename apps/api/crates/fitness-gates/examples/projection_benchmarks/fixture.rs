use std::{
    collections::BTreeMap,
    fmt::Write as _,
    ops::Range,
    path::{Path, PathBuf},
    time::Duration,
};

use notarium_canonical::{
    BlobBackendConfig, CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec,
    CreateSpaceSpec, PgConnectConfig, PgTransport, SpaceRecord, SqlBackendConfig,
    UpdateSpaceSchema, WriterConfig, build_pg_connect_options, changes::SyntheticNoteSpec,
    config::default_postgres_backup_budget,
};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::DataRoot,
    error::{CommitEffect, PortError},
    ids::{
        CommandKey, ContentDigest, FolderId, GrantId, HistoryIncarnation, InstallationId,
        LeaseEpoch, NoteId, PrincipalId, RequestId, RevisionId, SpaceId, SpaceSeq, ViewKey,
    },
    model::Lifecycle,
    ports::{
        CallBudget, Cancellation, CreateNote, MaintenanceContext, Mutation, NoteWritePort,
        PageLimit, Preconditions, ServiceAuthority, ServicePurpose, SpaceContext, ViewQuery,
        ViewRef,
    },
    query::{
        FieldFilterAstV1, FieldObservation, FieldSchema, FieldType, FieldValue, Predicate,
        ScalarType,
    },
    receipt::CommandIdentity,
    value::{Date, ExactNumber, ScalarValue},
};
use serde::Deserialize;
use sqlx::PgPool;

use crate::report::{Backend, LINKS_PER_NOTE};

const IMPORT_PAGE: usize = 128;
const IMPORT_WORKERS: usize = 4;
const IMPORT_RETRIES: usize = 3;
pub(crate) const REPLAY_TAG: &str = "replay-witness";
pub(crate) const PG_DERIVED_PREFIX: &str = "test_projection_derived";

#[derive(Deserialize)]
pub(crate) struct PgFixture {
    pg_socket_dir_container: PathBuf,
    pg_port: u16,
    pg_user: String,
    pg_password: String,
    pg_database: String,
    s3_socket_container: PathBuf,
    s3_endpoint: String,
    s3_region: String,
    s3_access_key: String,
    s3_secret_key: String,
}

impl PgFixture {
    pub fn read() -> Self {
        let manifest = Path::new("/workspace/.artifacts/storage-tests/current.json");
        let fixture: Self = serde_json::from_slice(
            &std::fs::read(manifest).expect("read the PostgreSQL fixture manifest"),
        )
        .expect("decode PostgreSQL fixture manifest");
        assert!(
            fixture
                .pg_socket_dir_container
                .join(format!(".s.PGSQL.{}", fixture.pg_port))
                .exists(),
            "missing PostgreSQL fixture Unix socket"
        );
        fixture
    }

    pub fn connect_config(&self) -> PgConnectConfig {
        PgConnectConfig {
            transport: PgTransport::UnixSocket {
                socket_dir: self.pg_socket_dir_container.clone(),
                port: self.pg_port,
            },
            username: self.pg_user.clone(),
            password: self.pg_password.clone(),
            database: self.pg_database.clone(),
        }
    }

    pub async fn s3_blobs(&self, prefix: &str) -> BlobBackendConfig {
        let mut cfg = notarium_canonical::S3Config {
            endpoint: self.s3_endpoint.clone(),
            region: self.s3_region.clone(),
            bucket: "notarium-bench-shared".to_owned(),
            application_prefix: String::new(),
            addressing: notarium_canonical::S3AddressingStyle::PathStyle,
            credentials: notarium_canonical::S3Credentials {
                access_key_id: self.s3_access_key.clone(),
                secret_access_key: self.s3_secret_key.clone(),
                session_token: None,
            },
            custom_ca_pem: None,
            unix_socket: Some(self.s3_socket_container.clone()),
            bucket_mode_policy: notarium_canonical::S3BucketModePolicy::DetectFromBucket,
            request_timeout: Duration::from_secs(10),
        };
        notarium_canonical::blobs::s3::admin_ensure_bucket(&cfg, Some("Enabled"))
            .await
            .expect("ensure benchmark MinIO bucket");
        cfg.application_prefix = format!("{prefix}/");
        BlobBackendConfig::S3(Box::new(cfg))
    }

    pub async fn open_pool(&self) -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(12)
            .connect_with(build_pg_connect_options(&self.connect_config()))
            .await
            .expect("connect to isolated PostgreSQL")
    }
}

pub(crate) async fn open_canonical(
    backend: Backend,
    path: &Path,
    pg: &PgFixture,
) -> (CanonicalStore, CanonicalRuntime) {
    let root = DataRoot::new(path);
    let installation_id = InstallationId::from_bytes([17; 16]);
    let config = match backend {
        Backend::Sqlite => CanonicalConfig::local_default(installation_id, root),
        Backend::Postgres => CanonicalConfig {
            installation_id,
            sql: SqlBackendConfig::postgres_default(
                pg.connect_config(),
                "test_projection_canonical",
            ),
            blobs: pg.s3_blobs("test_projection_canonical").await,
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: default_postgres_backup_budget(),
        },
    };
    CanonicalRuntime::open(config)
        .await
        .expect("open canonical store")
}

pub(crate) fn budget() -> CallBudget {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).expect("generate request identity");
    CallBudget {
        request: RequestId::from_bytes(bytes),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(90),
    }
}

pub(crate) fn projection_context() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Projection),
        budget: budget(),
    }
}

#[derive(Clone)]
pub(crate) struct Corpus {
    pub space: SpaceRecord,
    pub(crate) moved_folder: FolderId,
    pub(crate) moved_folder_revision: RevisionId,
    pub(crate) destination_folder: FolderId,
    scoped_folder: FolderId,
    nested_folder: FolderId,
    outside_folder: FolderId,
    pub view: ViewRef,
    pub view_revision: RevisionId,
    pub head: SpaceSeq,
}

impl Corpus {
    pub async fn create(store: &CanonicalStore) -> Self {
        let epoch = LeaseEpoch::new(1).unwrap();
        let space = store
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([0x10; 16]),
                incarnation: HistoryIncarnation::from_bytes([0x20; 16]),
                root_folder_id: FolderId::from_bytes([0x30; 16]),
                slug: "projection-fixture".into(),
                kind: SpaceKind::Personal,
                owner: PrincipalId::from_bytes([0x40; 16]),
                active_epoch: epoch,
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .expect("provision benchmark Space");
        let folders = [
            ("work", FolderId::from_bytes([0x31; 16])),
            ("focused", FolderId::from_bytes([0x32; 16])),
            ("nested", FolderId::from_bytes([0x33; 16])),
            ("other", FolderId::from_bytes([0x34; 16])),
            ("archive", FolderId::from_bytes([0x35; 16])),
        ];
        let mut moved_folder_revision = None;
        for (index, (slug, id)) in folders.iter().enumerate() {
            let parent = match index {
                1 | 3 => Some(folders[0].1.clone()),
                2 => Some(folders[1].1.clone()),
                _ => None,
            };
            let (_, revision, _) = store
                .create_folder(CreateFolderSpec {
                    scope: space.scope.clone(),
                    active_epoch: epoch,
                    folder_id: id.clone(),
                    parent,
                    slug: (*slug).into(),
                    display_name: (*slug).into(),
                    is_project: index == 4,
                    project_slug: (index == 4).then(|| (*slug).to_owned()),
                    actor: space.owner.clone(),
                    timestamp: None,
                })
                .await
                .expect("create benchmark folder");
            if index == 0 {
                moved_folder_revision = Some(revision);
            }
        }
        let scoped_folder = folders[1].1.clone();
        let view = ViewRef {
            note: NoteId::from_bytes([0x50; 16]),
            key: ViewKey::from_bytes([0x51; 16]),
        };
        let created = store
            .create_note(
                owner_context(&space),
                mutation(
                    &space,
                    CreateNote {
                        folder_page: false,
                        note: view.note.clone(),
                        parent: None,
                        slug: "benchmark-board".into(),
                        class: DocClass::UserDoc,
                        carrier: board_carrier(&view.key, &scoped_folder),
                    },
                ),
            )
            .await
            .expect("create .nota board");
        let fields: BTreeMap<_, _> = [
            ("status", ScalarType::String),
            ("priority", ScalarType::String),
            ("due", ScalarType::Date),
            ("owner", ScalarType::String),
            ("estimate", ScalarType::Number),
        ]
        .into_iter()
        .map(|(name, kind)| {
            (
                name.to_owned(),
                FieldSchema {
                    kind: FieldType::Scalar(kind),
                    nullable: false,
                },
            )
        })
        .collect();
        let schema = store
            .update_space_schema(
                owner_context(&space),
                mutation(
                    &space,
                    UpdateSpaceSchema {
                        schema_note: NoteId::from_bytes([0x52; 16]),
                        parent: None,
                        slug: "benchmark-fields".into(),
                        carrier: "---\ntitle: Benchmark fields\n---\n\n# Benchmark fields\n".into(),
                        schema: fields,
                        expected_schema_revision: None,
                    },
                ),
            )
            .await
            .expect("declare benchmark field domains");

        Self {
            space,
            moved_folder: folders[0].1.clone(),
            moved_folder_revision: moved_folder_revision.unwrap(),
            scoped_folder,
            nested_folder: folders[2].1.clone(),
            outside_folder: folders[3].1.clone(),
            destination_folder: folders[4].1.clone(),
            view,
            view_revision: created.value.revision,
            head: schema.receipt.seq(),
        }
    }

    pub fn ctx(&self) -> SpaceContext {
        owner_context(&self.space)
    }

    pub fn command<T>(&self, input: T) -> Mutation<T> {
        mutation(&self.space, input)
    }

    pub fn board_query(&self, group: Option<&str>) -> ViewQuery {
        let predicate = match group {
            Some(value) => Predicate::Eq {
                key: "status".into(),
                value: ScalarValue::String(value.into()),
            },
            None => Predicate::All(Vec::new()),
        };
        ViewQuery {
            view: self.view.clone(),
            filter: FieldFilterAstV1 {
                version: 1,
                predicate,
            },
            sort: None,
            group_by: None,
            limit: PageLimit::new(50).unwrap(),
        }
    }

    pub async fn seed(&mut self, store: &CanonicalStore, corpus_notes: usize) {
        // Only fixture preparation overlaps staging. The writer still owns
        // command boundaries and samples begin after every worker has drained.
        let mut workers = tokio::task::JoinSet::new();
        for offset in 0..IMPORT_WORKERS {
            let fixture = self.clone();
            let store = store.clone();
            workers.spawn(async move {
                let mut last_seq = SpaceSeq::ZERO;
                for start in
                    (offset * IMPORT_PAGE..corpus_notes).step_by(IMPORT_WORKERS * IMPORT_PAGE)
                {
                    let end = (start + IMPORT_PAGE).min(corpus_notes);
                    last_seq =
                        last_seq.max(fixture.insert_batch(&store, start, end, corpus_notes).await);
                }
                last_seq
            });
        }
        while let Some(result) = workers.join_next().await {
            self.head = self.head.max(result.expect("benchmark import worker"));
        }
    }

    pub async fn insert_batch(
        &self,
        store: &CanonicalStore,
        start: usize,
        end: usize,
        corpus_notes: usize,
    ) -> SpaceSeq {
        let mut retries = IMPORT_RETRIES;
        loop {
            let result = self.try_insert_batch(store, start, end, corpus_notes).await;
            if retries == 0
                || !matches!(&result, Err(PortError::DeadlineExceeded(failure))
                    if failure.effect() == CommitEffect::NotCommitted)
            {
                return result.expect("ingest benchmark notes using canonical storage");
            }
            retries -= 1;
            eprintln!("retrying benchmark batch {start}..{end} after a confirmed non-commit");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn try_insert_batch(
        &self,
        store: &CanonicalStore,
        start: usize,
        end: usize,
        corpus_notes: usize,
    ) -> Result<SpaceSeq, PortError> {
        let notes = (start..end)
            .map(|index| self.note(index, corpus_notes))
            .collect();
        self.commit_batch(store, notes).await
    }

    pub async fn edit_tail(
        &self,
        store: &CanonicalStore,
        existing_notes: Range<usize>,
        corpus_notes: usize,
    ) -> SpaceSeq {
        let notes = existing_notes
            .map(|index| {
                let mut note = self.note(index, corpus_notes);
                writeln!(note.carrier, "\n#{REPLAY_TAG}").unwrap();
                note
            })
            .collect();
        self.commit_batch(store, notes)
            .await
            .expect("edit the replay fixture through canonical storage")
    }

    async fn commit_batch(
        &self,
        store: &CanonicalStore,
        notes: Vec<SyntheticNoteSpec>,
    ) -> Result<SpaceSeq, PortError> {
        let expected = notes.len();
        let (range, committed) = store
            .commit_synthetic_note_batch_for_test(
                &self.space.scope,
                self.space.active_epoch,
                &self.space.owner,
                notes,
            )
            .await?;
        assert_eq!(committed.len(), expected);
        Ok(range.last_seq)
    }

    fn note(&self, index: usize, corpus_notes: usize) -> SyntheticNoteSpec {
        let initial_corpus = index < corpus_notes;
        let priority = if initial_corpus && index % 5 < 3 {
            "high"
        } else {
            "normal"
        };
        let due = format!("2026-10-{:02}", 1 + index % 28);
        let status = if index.is_multiple_of(2) {
            "todo"
        } else {
            "done"
        };
        let owner = format!("team-{}", index % 19);
        let estimate = 1 + index % 25;
        let title = format!("Task {index:06}");
        let tag = if index.is_multiple_of(3) {
            "#focus"
        } else {
            "#general"
        };
        let mut carrier = format!(
            "---\ntitle: {title}\nstatus: {status}\npriority: {priority}\ndue: '{due}'\nowner: {owner}\nestimate: {estimate}\n---\n\n# {title}\n\n{tag}\n\n"
        );
        // Ring edges and named links give every node a bounded nontrivial
        // neighborhood and let the folder-move workload exercise both paths.
        let anchor = index % corpus_notes;
        for offset in 1..=LINKS_PER_NOTE {
            let neighbor = (anchor + offset * 37) % corpus_notes;
            if offset == 4 {
                write!(carrier, "[[Task {neighbor:06}]] ").unwrap();
            } else if offset == 5 && index.is_multiple_of(8) {
                let target_folder = match folder_location(neighbor) {
                    FolderLocation::Direct => "focused",
                    FolderLocation::Nested => "focused/nested",
                    FolderLocation::Outside => "other",
                };
                write!(carrier, "[[/work/{target_folder}/task-{neighbor:06}]] ").unwrap();
            } else {
                write!(carrier, "[[{}]] ", card_id(neighbor)).unwrap();
            }
        }
        carrier.push('\n');
        let fields = BTreeMap::from([
            (
                "due".into(),
                scalar(ScalarValue::Date(Date::parse(&due).unwrap())),
            ),
            ("status".into(), scalar(ScalarValue::String(status.into()))),
            (
                "priority".into(),
                scalar(ScalarValue::String(priority.into())),
            ),
            ("owner".into(), scalar(ScalarValue::String(owner))),
            (
                "estimate".into(),
                scalar(ScalarValue::Number(ExactNumber::new(
                    serde_json::Number::from(estimate),
                ))),
            ),
        ]);
        SyntheticNoteSpec {
            note_id: card_id(index),
            parent_folder: Some(match folder_location(index) {
                FolderLocation::Direct => self.scoped_folder.clone(),
                FolderLocation::Nested => self.nested_folder.clone(),
                FolderLocation::Outside => self.outside_folder.clone(),
            }),
            slug: format!("task-{index:06}"),
            title,
            doc_class: DocClass::UserDoc,
            lifecycle: Lifecycle::Active,
            carrier,
            fields,
        }
    }
}

pub(crate) fn card_id(index: usize) -> NoteId {
    NoteId::from_bytes((index as u128).to_be_bytes())
}

enum FolderLocation {
    Direct,
    Nested,
    Outside,
}

fn folder_location(index: usize) -> FolderLocation {
    if index % 7 >= 5 {
        FolderLocation::Outside
    } else if index.is_multiple_of(4) {
        FolderLocation::Nested
    } else {
        FolderLocation::Direct
    }
}

pub(crate) fn matches_board(index: usize) -> bool {
    index % 7 < 5
        && index % 5 < 3
        && index.is_multiple_of(3)
        && (8..=20).contains(&(1 + index % 28))
}

fn scalar(value: ScalarValue) -> FieldObservation<FieldValue> {
    FieldObservation::Ok(FieldValue::Scalar(value))
}

pub(crate) fn board_carrier(view: &ViewKey, folder: &FolderId) -> String {
    format!(
        "---\ntitle: Benchmark board\n---\n\n# Benchmark board\n\n```nota\n\
         id: {view}\n\
         version: 1\n\
         type: board\n\
         source: {{scope: folder, folder: {folder}, recursive: true, tags: [focus]}}\n\
         filter: {{all: [{{eq: {{key: priority, value: high}}}}, {{date_range: {{key: due, lower: {{value: '2026-10-08'}}, upper: {{value: '2026-10-20'}}}}}}]}}\n\
         sort: [{{field: updated_at, direction: asc}}]\n\
         group_by: status\n\
         options: {{columns: [todo, done]}}\n\
         ```\n"
    )
}

fn owner_context(space: &SpaceRecord) -> SpaceContext {
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let auth = EngineAuthContext::for_human(
        VerifiedHuman::attest(
            space.owner.clone(),
            GrantId::from_bytes([7; 16]),
            BTreeMap::from([(space.scope.space_id.clone(), grant)]),
            false,
        )
        .with_human_management(true),
    );
    SpaceContext::new(auth, space.scope.clone(), budget()).unwrap()
}

fn mutation<T>(space: &SpaceRecord, input: T) -> Mutation<T> {
    let ordered = budget().request;
    let raw = ordered.as_str().as_bytes();
    let hash = blake3::hash(raw);
    let key = hash.as_bytes()[..16].try_into().unwrap();
    Mutation {
        identity: CommandIdentity {
            scope: space.scope.clone(),
            actor: space.owner.clone(),
            key: CommandKey::from_bytes(key),
            hash: ContentDigest::from_bytes(*hash.as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}
