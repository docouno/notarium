#![forbid(unsafe_code)]

mod support;

use std::{
    collections::BTreeMap,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use notarium_canonical::{
    BackupArtifactEncoding, BlobBackendConfig, CanonicalConfig, CanonicalRuntime, CanonicalStore,
    CollabRoomState, CreateSpaceSpec, DataRootOwnerLock, OpenCollabSession, PostgresSpoolValue,
    S3BucketModePolicy, SqlBackendConfig, WriterConfig, blobs::s3::admin_ensure_bucket,
    decode_postgres_spool_v1, default_backup_budget,
};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::DataRoot,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{
        ArtifactId, BackupId, CommandKey, ContentDigest, GrantId, InstallationId, LeaseEpoch,
        NoteId, PrincipalId, RequestId, SpaceSeq,
    },
    model::HistoryScope,
    ports::{
        BackupBudget, BackupHold, BackupParticipantPort, BackupSnapshot, BackupSpool,
        BackupWitness, CallBudget, Cancellation, ChangeBroadcast, ChangeNotice, CreateNote,
        DeleteDisposition, DeleteNote, GetNote, MaintenanceContext, Mutation, NoteWritePort,
        PausedBackup, PortFuture, Preconditions, PreparedBackup, RenameNote, ServicePurpose,
        SpaceContext,
    },
    receipt::{CausalBasis, ChangeCursor, CommandIdentity, ReceiptSet},
};

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, random_bytes_16,
    sample_folder_id, sample_incarnation, sample_installation_id, sample_note_id,
    sample_principal_id, sample_space_id,
};

const SUBPROC_MODE_ENV: &str = "NOTARIUM_L4_SUBPROC_MODE";
const SUBPROC_PATH_ENV: &str = "NOTARIUM_L4_SUBPROC_PATH";
const SUBPROC_SCHEMA_ENV: &str = "NOTARIUM_L4_SUBPROC_SCHEMA";
const SUBPROC_DIGEST_ENV: &str = "NOTARIUM_L4_SUBPROC_DIGEST";

const PEER_BLOB_64MIB: usize = 64 * 1024 * 1024;
const MEDIUM_ROW_BYTES: usize = 64 * 1024;
const MEDIUM_ROW_COUNT: usize = 50;

fn make_budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(random_bytes_16()),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(60),
    }
}

fn owner_ctx(scope: &HistoryScope, principal: PrincipalId) -> SpaceContext {
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let verified = VerifiedHuman::attest(
        principal,
        GrantId::from_bytes([0x44; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        true,
    );
    SpaceContext::new(
        EngineAuthContext::for_human(verified),
        scope.clone(),
        make_budget(),
    )
    .expect("owner SpaceContext")
}

fn next_mutation<T>(scope: &HistoryScope, actor: &PrincipalId, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes(random_bytes_16()),
            hash: ContentDigest::from_bytes(*blake3::hash(&random_bytes_16()).as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

fn deterministic_incompressible_bytes(seed_label: &[u8], len: usize) -> Vec<u8> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(seed_label);
    let mut xof = hasher.finalize_xof();
    let mut out = vec![0u8; len];
    xof.fill(&mut out);
    out
}

fn read_proc_vm_hwm_kib() -> u64 {
    let status = fs::read_to_string("/proc/self/status").expect("read /proc/self/status");
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let digits = rest.trim().strip_suffix("kB").unwrap_or(rest.trim()).trim();
            return digits.parse::<u64>().expect("parse VmHWM kB");
        }
    }
    panic!("VmHWM not found in /proc/self/status");
}

// ============================================================================
// Two-participant test double representing the paired control-plane participant
// ============================================================================

struct TestControlParticipant {
    installation: InstallationId,
    scope: HistoryScope,
    current_seq: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    fail_on_open_cut: AtomicBool,
}

impl TestControlParticipant {
    fn new(installation: InstallationId, scope: HistoryScope) -> Self {
        Self {
            installation,
            scope,
            current_seq: Arc::new(AtomicU64::new(0)),
            paused: Arc::new(AtomicBool::new(false)),
            fail_on_open_cut: AtomicBool::new(false),
        }
    }

    fn advance_revision(&self) -> u64 {
        assert!(
            !self.paused.load(Ordering::SeqCst),
            "control participant cannot commit while paused"
        );
        self.current_seq.fetch_add(1, Ordering::SeqCst) + 1
    }
}

struct MockPrepared {
    installation: InstallationId,
    scope: HistoryScope,
    current_seq: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    fail_on_open_cut: bool,
}

struct MockHold {
    witness: BackupWitness,
}

impl BackupHold for MockHold {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }
    fn release(self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async { Ok(()) })
    }
}

struct MockPaused {
    installation: InstallationId,
    scope: HistoryScope,
    current_seq: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    fail_on_open_cut: bool,
}

impl Drop for MockPaused {
    fn drop(&mut self) {
        self.paused.store(false, Ordering::SeqCst);
    }
}

impl PausedBackup for MockPaused {
    fn open_cut(&mut self) -> PortFuture<'_, Box<dyn BackupSnapshot>> {
        let fail = self.fail_on_open_cut;
        let seq = self.current_seq.load(Ordering::SeqCst);
        let witness = BackupWitness {
            installation: self.installation.clone(),
            histories: vec![ChangeCursor {
                scope: self.scope.clone(),
                after: SpaceSeq::new(seq).unwrap(),
            }],
            canaries: Vec::new(),
        };
        Box::pin(async move {
            if fail {
                let op = OperationalFailure::new(
                    ContentDigest::from_bytes([0xAB; 32]),
                    CommitEffect::NotCommitted,
                    RetryAdvice::After(Duration::from_millis(25)),
                    true,
                )?;
                return Err(PortError::Unavailable(op));
            }
            Ok(Box::new(MockSnapshot { witness }) as Box<dyn BackupSnapshot>)
        })
    }

    fn resume(self: Box<Self>) -> PortFuture<'static, ()> {
        self.paused.store(false, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

struct MockSnapshot {
    witness: BackupWitness,
}

impl BackupSnapshot for MockSnapshot {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }
    fn spool(
        &mut self,
        _budget: BackupBudget,
        _cancellation: Cancellation,
    ) -> PortFuture<'_, BackupSpool> {
        let w = self.witness.clone();
        Box::pin(async move {
            Ok(BackupSpool {
                artifact: ArtifactId::from_bytes([0xCC; 16]),
                bytes: 64,
                digest: ContentDigest::from_bytes([0xDD; 32]),
                witness: w,
            })
        })
    }
    fn close(self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async { Ok(()) })
    }
}

impl PreparedBackup for MockPrepared {
    fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
        let seq = self.current_seq.load(Ordering::SeqCst);
        let witness = BackupWitness {
            installation: self.installation.clone(),
            histories: vec![ChangeCursor {
                scope: self.scope.clone(),
                after: SpaceSeq::new(seq).unwrap(),
            }],
            canaries: Vec::new(),
        };
        Box::pin(async move { Ok(Box::new(MockHold { witness }) as Box<dyn BackupHold>) })
    }

    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
        self.paused.store(true, Ordering::SeqCst);
        let p = MockPaused {
            installation: self.installation.clone(),
            scope: self.scope.clone(),
            current_seq: Arc::clone(&self.current_seq),
            paused: Arc::clone(&self.paused),
            fail_on_open_cut: self.fail_on_open_cut,
        };
        Box::pin(async move { Ok(Box::new(p) as Box<dyn PausedBackup>) })
    }
}

impl BackupParticipantPort for TestControlParticipant {
    fn prepare(
        &self,
        ctx: MaintenanceContext,
        _backup: BackupId,
        _budget: BackupBudget,
    ) -> PortFuture<'_, Box<dyn PreparedBackup>> {
        let inst = self.installation.clone();
        let scope = self.scope.clone();
        let current_seq = Arc::clone(&self.current_seq);
        let paused = Arc::clone(&self.paused);
        let fail_on_open_cut = self.fail_on_open_cut.swap(false, Ordering::SeqCst);
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Backup)?;
            Ok(Box::new(MockPrepared {
                installation: inst,
                scope,
                current_seq,
                paused,
                fail_on_open_cut,
            }) as Box<dyn PreparedBackup>)
        })
    }

    fn restore_cursors(
        &self,
        ctx: MaintenanceContext,
        _restored: Vec<ChangeCursor>,
    ) -> PortFuture<'_, ()> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Restore)?;
            Ok(())
        })
    }
}

// ============================================================================
// Backend harness
// ============================================================================

struct BackendCase {
    label: &'static str,
    is_sqlite: bool,
    store: CanonicalStore,
    runtime: Option<CanonicalRuntime>,
    spool_dir: PathBuf,
    temp_root: TempDataRoot,
    pg_cleanup: Option<(StorageTestFixtures, String)>,
}

impl BackendCase {
    async fn open_sqlite() -> Self {
        let temp_root = TempDataRoot::new("l4-backup-sqlite");
        let data_root = temp_root.data_root();
        let spool_dir = data_root.staging().join("backups");
        let cfg = CanonicalConfig {
            installation_id: sample_installation_id(0x61),
            sql: SqlBackendConfig::Sqlite {
                data_root: data_root.clone(),
                read_pool_size: 6,
                read_deadline: Duration::from_millis(250),
                passive_checkpoint_interval: Duration::from_millis(20),
                wal_soft_watermark_bytes: 64 * 1024,
                wal_high_watermark_bytes: 128 * 1024,
                wal_reset_cycle_deadline: Duration::from_millis(250),
            },
            blobs: BlobBackendConfig::Local { data_root },
            writer: WriterConfig::default(),
            snapshot_retention: Duration::from_secs(300),
            default_backup_budget: default_backup_budget(),
        };
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open SQLite");
        Self {
            label: "sqlite_local",
            is_sqlite: true,
            store,
            runtime: Some(runtime),
            spool_dir,
            temp_root,
            pg_cleanup: None,
        }
    }

    async fn open_pg_s3() -> Self {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l4-backup");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::RequireEnabled);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("create versioned MinIO CE bucket");
        let temp_root = TempDataRoot::new("l4-backup-pg-spool");
        let spool_dir = temp_root.path().join("pg-backups");
        let cfg = fixtures.pg_s3_config(sample_installation_id(0x62), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open PG+S3");
        store.set_backup_spool_dir(spool_dir.clone());
        Self {
            label: "postgres_s3",
            is_sqlite: false,
            store,
            runtime: Some(runtime),
            spool_dir,
            temp_root,
            pg_cleanup: Some((fixtures, schema)),
        }
    }

    async fn shutdown(mut self) {
        if let Some(rt) = self.runtime.take() {
            rt.shutdown().await.expect("clean runtime shutdown");
        }
        if let Some((fx, schema)) = self.pg_cleanup.take() {
            fx.drop_pg_schema(&schema).await;
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn l4_paired_backup_cut_holds_budgets_cleanup_and_restore_cursors_dual_dialect_parity() {
    let cases = vec![
        BackendCase::open_sqlite().await,
        BackendCase::open_pg_s3().await,
    ];

    for case in cases {
        let label = case.label;
        let store = &case.store;
        let actor = sample_principal_id(0x63);
        let space_rec = store
            .create_space(CreateSpaceSpec {
                space_id: sample_space_id(0x63),
                incarnation: sample_incarnation(0x63),
                root_folder_id: sample_folder_id(0x63),
                slug: "backup-parity-space".to_owned(),
                kind: SpaceKind::Personal,
                owner: actor.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .expect("create space");
        let scope = space_rec.scope.clone();
        let ctx = owner_ctx(&scope, actor.clone());

        // Reject invalid authority on prepare and restore_cursors.
        let wrong_prep = store
            .prepare(
                maintenance_ctx(ServicePurpose::Projection),
                BackupId::from_bytes([1u8; 16]),
                default_backup_budget(),
            )
            .await;
        assert_validation_err(&wrong_prep.map(|_| ()), ValidationReason::InvalidAuthority);
        let wrong_restore = store
            .restore_cursors(maintenance_ctx(ServicePurpose::Backup), Vec::new())
            .await;
        assert_validation_err(&wrong_restore, ValidationReason::InvalidAuthority);

        // 1. SQLite SELECT 1 non-pinning negative control.
        if case.is_sqlite {
            let neg_conn = rusqlite::Connection::open_with_flags(
                case.temp_root.data_root().canonical(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .expect("open negative control rusqlite");
            neg_conn.execute_batch("BEGIN DEFERRED;").unwrap();
            let one: i64 = neg_conn.query_row("SELECT 1", [], |r| r.get(0)).unwrap();
            assert_eq!(one, 1);
            // Commit note_1 while neg_conn only ran SELECT 1!
            let note_1 = NoteId::from_bytes([0x11; 16]);
            store
                .create_note(
                    ctx.clone(),
                    next_mutation(
                        &scope,
                        &actor,
                        CreateNote {
                            note: note_1,
                            parent: None,
                            slug: "note-select1-control".to_owned(),
                            class: DocClass::UserDoc,
                            carrier: "---\ntitle: Note One\n---\n# Note One\n".to_owned(),
                        },
                    ),
                )
                .await
                .expect("create note 1");
            let observed_seq: i64 = neg_conn
                .query_row("SELECT last_seq FROM spaces LIMIT 1", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                observed_seq, 1,
                "[{label}] SELECT 1 alone does NOT pin a SQLite WAL snapshot"
            );
            neg_conn.execute_batch("ROLLBACK;").unwrap();
            drop(neg_conn);
        } else {
            let note_1 = NoteId::from_bytes([0x11; 16]);
            store
                .create_note(
                    ctx.clone(),
                    next_mutation(
                        &scope,
                        &actor,
                        CreateNote {
                            note: note_1,
                            parent: None,
                            slug: "note-select1-control".to_owned(),
                            class: DocClass::UserDoc,
                            carrier: "---\ntitle: Note One\n---\n# Note One\n".to_owned(),
                        },
                    ),
                )
                .await
                .expect("create note 1");
        }

        // 2. Paired two-participant cut + multi-byte UTF-8 straddling 64 KiB slice boundary.
        let control_peer =
            TestControlParticipant::new(store.installation_id().clone(), scope.clone());
        assert_eq!(control_peer.advance_revision(), 1);

        let backup_id = BackupId::from_bytes([0x20; 16]);
        let budget = default_backup_budget();
        let mut prep_canon = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                backup_id.clone(),
                budget,
            )
            .await
            .expect("prepare canonical");
        let mut prep_ctrl = control_peer
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                backup_id.clone(),
                budget,
            )
            .await
            .expect("prepare control");

        let hold_canon = prep_canon
            .acquire_hold()
            .await
            .expect("acquire canonical hold");
        let hold_ctrl = prep_ctrl
            .acquire_hold()
            .await
            .expect("acquire control hold");

        // Write BETWEEN prepare and pause_writes -> MUST appear in both snapshots!
        // Include a 4-byte emoji ("🦀" = 4 bytes) straddling byte offset 65_536 in `folder_heads.description`!
        let mut boundary_utf8 = "A".repeat(65_534);
        boundary_utf8.push_str("🦀🔐📜✨-after-64k-boundary");
        store
            .execute_diagnostic_write_sql_for_test(&format!(
                "UPDATE folder_heads SET description = '{boundary_utf8}' WHERE space_id = '{}' AND is_root = 1",
                scope.space_id.as_str()
            ))
            .await
            .expect("set >64KiB UTF-8 boundary description");

        let note_pre_pause = NoteId::from_bytes([0x12; 16]);
        let pre_pause_committed = store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    CreateNote {
                        note: note_pre_pause.clone(),
                        parent: None,
                        slug: "note-pre-pause".to_owned(),
                        class: DocClass::UserDoc,
                        carrier:
                            "---\ntitle: Included Pre Pause\n---\n# Pre Pause\nIncluded in cut.\n"
                                .to_owned(),
                    },
                ),
            )
            .await
            .expect("create note between prepare and pause");
        let cut_seq = pre_pause_committed.receipt.seq();
        assert_eq!(cut_seq.get(), 2);
        assert_eq!(control_peer.advance_revision(), 2);

        // Pause BOTH participants.
        let mut paused_canon = prep_canon.pause_writes().await.expect("pause canonical");
        let mut paused_ctrl = prep_ctrl.pause_writes().await.expect("pause control");

        // Spawn a write while paused — it MUST block until `resume()`!
        let post_resume_done = Arc::new(AtomicBool::new(false));
        let post_resume_done_cl = Arc::clone(&post_resume_done);
        let store_bg = store.clone();
        let ctx_bg = ctx.clone();
        let scope_bg = scope.clone();
        let actor_bg = actor.clone();
        let note_post_resume = NoteId::from_bytes([0x13; 16]);
        let note_post_cl = note_post_resume.clone();
        let blocked_writer = tokio::spawn(async move {
            let res = store_bg
                .create_note(
                    ctx_bg,
                    next_mutation(
                        &scope_bg,
                        &actor_bg,
                        CreateNote {
                            note: note_post_cl,
                            parent: None,
                            slug: "note-post-resume".to_owned(),
                            class: DocClass::UserDoc,
                            carrier: "---\ntitle: Excluded Post Resume\n---\n# Post Resume\n"
                                .to_owned(),
                        },
                    ),
                )
                .await
                .expect("post-resume create_note");
            post_resume_done_cl.store(true, Ordering::SeqCst);
            res
        });

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !post_resume_done.load(Ordering::SeqCst),
            "[{label}] write must remain blocked while PausedBackup holds safe point"
        );

        // Open cut on BOTH participants while paused!
        let mut snap_canon = paused_canon.open_cut().await.expect("open_cut canonical");
        let mut snap_ctrl = paused_ctrl.open_cut().await.expect("open_cut control");
        assert_eq!(snap_canon.witness().histories[0].after, cut_seq);
        assert_eq!(snap_ctrl.witness().histories[0].after.get(), 2);

        // Resume BOTH participants BEFORE spooling!
        paused_canon.resume().await.expect("resume canonical");
        paused_ctrl.resume().await.expect("resume control");

        // Blocked writer now commits immediately (`seq = 3`) BEFORE spool even runs!
        let post_committed = blocked_writer.await.expect("join post-resume writer");
        assert_eq!(post_committed.receipt.seq().get(), 3);

        // Spool both snapshots and verify post-resume write (`seq = 3`) is ABSENT from the spooled cut!
        let spool_canon = snap_canon
            .spool(budget, Cancellation::default())
            .await
            .expect("spool canonical");
        let _spool_ctrl = snap_ctrl
            .spool(budget, Cancellation::default())
            .await
            .expect("spool control");
        snap_canon.close().await.expect("close canonical snapshot");
        snap_ctrl.close().await.expect("close control snapshot");

        let reg = store
            .get_backup_artifact(&spool_canon.artifact)
            .await
            .expect("read backup_artifacts registry");
        assert_eq!(reg.state, "ready");
        assert_eq!(reg.byte_size, spool_canon.bytes);
        assert_eq!(reg.digest, spool_canon.digest);
        let disk_bytes = fs::read(&reg.artifact_path).expect("read artifact file");
        assert_eq!(disk_bytes.len() as u64, spool_canon.bytes);
        assert_eq!(
            ContentDigest::from_bytes(*blake3::hash(&disk_bytes).as_bytes()),
            spool_canon.digest
        );

        if case.is_sqlite {
            assert_eq!(reg.encoding, BackupArtifactEncoding::SqliteSnapshotV1);
            // Source WAL must NOT remain pinned while `hold_canon` is still held for simulated slow CAS upload!
            for idx in 0..10u8 {
                let nid = NoteId::from_bytes([0x80 + idx; 16]);
                store
                    .create_note(
                        ctx.clone(),
                        next_mutation(
                            &scope,
                            &actor,
                            CreateNote {
                                note: nid,
                                parent: None,
                                slug: format!("wal-unpinned-probe-{idx}"),
                                class: DocClass::UserDoc,
                                carrier: format!("---\ntitle: Probe {idx}\n---\n# Body {idx}\n"),
                            },
                        ),
                    )
                    .await
                    .expect("write while hold active after spool");
            }
            let before_tel = store.wal_telemetry().unwrap();
            store.run_wal_maintenance_now(true).await;
            let after_tel = store.wal_telemetry().unwrap();
            assert!(
                after_tel.reset_successes > before_tel.reset_successes,
                "[{label}] WAL reset must succeed immediately after spool finishes even while CAS BackupHold remains active"
            );

            // Verify independent SQLite reader on `<artifact_id>.sqlite` sees exact cut (`seq=2`)!
            let ind = rusqlite::Connection::open_with_flags(
                &reg.artifact_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .expect("open spooled sqlite artifact");
            let spooled_last_seq: i64 = ind
                .query_row("SELECT last_seq FROM spaces LIMIT 1", [], |r| r.get(0))
                .unwrap();
            assert_eq!(spooled_last_seq, 2);
            let post_exists: Option<i64> = ind
                .query_row(
                    "SELECT 1 FROM note_heads WHERE note_id = ?1",
                    [note_post_resume.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .unwrap();
            assert!(
                post_exists.is_none(),
                "[{label}] post-resume write must NOT appear in pinned SQLiteSnapshotV1"
            );
            let spooled_desc: String = ind
                .query_row(
                    "SELECT description FROM folder_heads WHERE is_root = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(spooled_desc, boundary_utf8);
        } else {
            assert_eq!(reg.encoding, BackupArtifactEncoding::PostgresSpoolV1);
            assert!(
                !find_subslice(&disk_bytes, b"ctid"),
                "[{label}] PostgresSpoolV1 must never persist ctid metadata"
            );
            let decoded = decode_postgres_spool_v1(&reg.artifact_path)
                .expect("independent streaming decode of PostgresSpoolV1");
            assert_eq!(decoded.tables.len(), 34);
            assert_eq!(decoded.witness.histories[0].after.get(), 2);

            let spaces_tbl = decoded
                .tables
                .iter()
                .find(|t| t.name == "spaces")
                .expect("spaces table");
            assert_eq!(spaces_tbl.rows.len(), 1);
            let last_seq_idx = spaces_tbl
                .columns
                .iter()
                .position(|c| c == "last_seq")
                .unwrap();
            assert_eq!(spaces_tbl.rows[0][last_seq_idx], PostgresSpoolValue::Int(2));

            let notes_tbl = decoded
                .tables
                .iter()
                .find(|t| t.name == "note_heads")
                .expect("note_heads table");
            let nid_idx = notes_tbl
                .columns
                .iter()
                .position(|c| c == "note_id")
                .unwrap();
            let spooled_note_ids: Vec<String> = notes_tbl
                .rows
                .iter()
                .map(|r| match &r[nid_idx] {
                    PostgresSpoolValue::Text(s) => s.clone(),
                    other => panic!("expected Text note_id, got {other:?}"),
                })
                .collect();
            assert!(spooled_note_ids.contains(&note_pre_pause.as_str().to_owned()));
            assert!(
                !spooled_note_ids.contains(&note_post_resume.as_str().to_owned()),
                "[{label}] post-resume write must NOT appear in pinned PostgresSpoolV1"
            );

            let folders_tbl = decoded
                .tables
                .iter()
                .find(|t| t.name == "folder_heads")
                .expect("folder_heads table");
            let desc_idx = folders_tbl
                .columns
                .iter()
                .position(|c| c == "description")
                .unwrap();
            assert_eq!(
                folders_tbl.rows[0][desc_idx],
                PostgresSpoolValue::Text(boundary_utf8),
                "[{label}] multi-byte UTF-8 emojis split across 64 KiB chunks must decode losslessly"
            );
        }

        // 3. Concurrent independent BackupHold reference counting + Purge mutual exclusion.
        let mut prep_second = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x21; 16]),
                budget,
            )
            .await
            .expect("prepare second concurrent backup");
        let hold_second = prep_second
            .acquire_hold()
            .await
            .expect("acquire second concurrent hold");
        drop(prep_second);

        // Purge while BOTH holds are active -> blocked!
        let purge_blocked_1 = store
            .delete_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    DeleteNote {
                        note: note_post_resume.clone(),
                        disposition: DeleteDisposition::Purge,
                    },
                ),
            )
            .await;
        assert!(
            matches!(purge_blocked_1, Err(PortError::Unavailable(_))),
            "[{label}] purge must be blocked while backup holds are active: {purge_blocked_1:?}"
        );

        // Release first hold (`hold_canon`) -> `hold_second` STILL keeps Purge blocked!
        hold_canon.release().await.expect("release first hold");
        hold_ctrl.release().await.expect("release control hold");

        let purge_blocked_2 = store
            .delete_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    DeleteNote {
                        note: note_post_resume.clone(),
                        disposition: DeleteDisposition::Purge,
                    },
                ),
            )
            .await;
        assert!(
            matches!(purge_blocked_2, Err(PortError::Unavailable(_))),
            "[{label}] releasing backup_1 hold must NOT release independent backup_2 hold"
        );

        // Release second hold -> Purge now succeeds!
        hold_second.release().await.expect("release second hold");
        store
            .delete_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    DeleteNote {
                        note: note_post_resume.clone(),
                        disposition: DeleteDisposition::Purge,
                    },
                ),
            )
            .await
            .expect("purge succeeds once all backup holds release");

        // Conversely: incomplete Step-1 purge blocks `acquire_hold`!
        let note_step1 = NoteId::from_bytes([0x22; 16]);
        store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    CreateNote {
                        note: note_step1.clone(),
                        parent: None,
                        slug: "interrupted-purge-blocks-hold".to_owned(),
                        class: DocClass::UserDoc,
                        carrier: "---\ntitle: Step1 Purge\n---\n# Step1\n".to_owned(),
                    },
                ),
            )
            .await
            .expect("create note_step1");
        let step1_mut = next_mutation(
            &scope,
            &actor,
            DeleteNote {
                note: note_step1.clone(),
                disposition: DeleteDisposition::Purge,
            },
        );
        store
            .simulate_interrupted_purge_step1_for_test(ctx.clone(), step1_mut.clone())
            .await
            .expect("simulate step1 purge");

        let mut prep_vs_purge = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x23; 16]),
                budget,
            )
            .await
            .expect("prepare while pending purge");
        let hold_vs_purge = prep_vs_purge.acquire_hold().await;
        assert!(
            matches!(hold_vs_purge, Err(PortError::Unavailable(_))),
            "[{label}] acquire_hold must reject incomplete pending_purges"
        );
        drop(prep_vs_purge);

        // Replay the same purge mutation idempotently to drive Step 2/3 to completion!
        store
            .delete_note(ctx.clone(), step1_mut)
            .await
            .expect("complete interrupted purge via idempotent replay");

        // 4. Second participant failure, BudgetExceeded (spool bytes, deadline, WAL bytes), Cancellation, and Drop cleanup.
        control_peer.fail_on_open_cut.store(true, Ordering::SeqCst);
        let mut p_c = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x24; 16]),
                budget,
            )
            .await
            .unwrap();
        let mut p_k = control_peer
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x24; 16]),
                budget,
            )
            .await
            .unwrap();
        let mut pause_c = p_c.pause_writes().await.unwrap();
        let mut pause_k = p_k.pause_writes().await.unwrap();
        let snap_c = pause_c.open_cut().await.unwrap();
        assert!(pause_k.open_cut().await.is_err());
        // Drop both paused handles and snapshot directly without explicit resume/close!
        drop(snap_c);
        drop(pause_c);
        drop(pause_k);

        // Verify writes immediately work again!
        let note_after_abort = NoteId::from_bytes([0x25; 16]);
        store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    CreateNote {
                        note: note_after_abort,
                        parent: None,
                        slug: "after-second-participant-abort".to_owned(),
                        class: DocClass::UserDoc,
                        carrier: "---\ntitle: Alive\n---\n# Alive\n".to_owned(),
                    },
                ),
            )
            .await
            .expect("writes resume cleanly after dropped PausedBackup/BackupSnapshot");

        // BudgetExceeded: max_spool_bytes = 64 bytes
        let tiny_spool_budget = BackupBudget {
            deadline: Duration::from_secs(10),
            max_pinned_wal_bytes: 256 * 1024 * 1024,
            max_spool_bytes: 64,
        };
        let mut prep_tiny = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x26; 16]),
                budget,
            )
            .await
            .unwrap();
        let mut paused_tiny = prep_tiny.pause_writes().await.unwrap();
        let mut snap_tiny = paused_tiny.open_cut().await.unwrap();
        paused_tiny.resume().await.unwrap();
        let tiny_err = snap_tiny
            .spool(tiny_spool_budget, Cancellation::default())
            .await;
        assert_validation_err(&tiny_err, ValidationReason::BudgetExceeded);

        // BudgetExceeded: deadline = 8 ms under step delay = 25 ms
        store.set_backup_step_delay_for_test(Duration::from_millis(25));
        let tiny_time_budget = BackupBudget {
            deadline: Duration::from_millis(8),
            max_pinned_wal_bytes: 256 * 1024 * 1024,
            max_spool_bytes: 1024 * 1024 * 1024,
        };
        let mut prep_slow = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x27; 16]),
                budget,
            )
            .await
            .unwrap();
        let mut paused_slow = prep_slow.pause_writes().await.unwrap();
        let mut snap_slow = paused_slow.open_cut().await.unwrap();
        paused_slow.resume().await.unwrap();
        let slow_err = snap_slow
            .spool(tiny_time_budget, Cancellation::default())
            .await;
        assert_validation_err(&slow_err, ValidationReason::BudgetExceeded);

        // Cancellation mid-spool
        let cancel_tok = Cancellation::default();
        let cancel_bg = cancel_tok.clone();
        let mut prep_can = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x28; 16]),
                budget,
            )
            .await
            .unwrap();
        let mut paused_can = prep_can.pause_writes().await.unwrap();
        let mut snap_can = paused_can.open_cut().await.unwrap();
        paused_can.resume().await.unwrap();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(12)).await;
            cancel_bg.cancel();
        });
        let can_err = snap_can.spool(budget, cancel_tok).await;
        assert!(
            matches!(
                can_err,
                Err(PortError::Cancelled(fail)) if fail.effect() == CommitEffect::NotCommitted
            ),
            "[{label}] expected Cancelled NotCommitted on mid-spool cancel, got {can_err:?}"
        );

        // SQLite WAL growth budget abort (`max_pinned_wal_bytes = 2048` while writes grow WAL).
        if case.is_sqlite {
            let tiny_wal_budget = BackupBudget {
                deadline: Duration::from_secs(10),
                max_pinned_wal_bytes: 2048,
                max_spool_bytes: 1024 * 1024 * 1024,
            };
            let mut prep_wal = store
                .prepare(
                    maintenance_ctx(ServicePurpose::Backup),
                    BackupId::from_bytes([0x29; 16]),
                    tiny_wal_budget,
                )
                .await
                .unwrap();
            let mut paused_wal = prep_wal.pause_writes().await.unwrap();
            let mut snap_wal = paused_wal.open_cut().await.unwrap();
            paused_wal.resume().await.unwrap();

            let store_w = store.clone();
            let ctx_w = ctx.clone();
            let scope_w = scope.clone();
            let actor_w = actor.clone();
            let wal_writer = tokio::spawn(async move {
                for k in 0..8u8 {
                    let _ = store_w
                        .create_note(
                            ctx_w.clone(),
                            next_mutation(
                                &scope_w,
                                &actor_w,
                                CreateNote {
                                    note: NoteId::from_bytes([0x90 + k; 16]),
                                    parent: None,
                                    slug: format!("wal-budget-grow-{k}"),
                                    class: DocClass::UserDoc,
                                    carrier: format!(
                                        "---\ntitle: Grow {k}\n---\n# Grow\n{}\n",
                                        "W".repeat(4096)
                                    ),
                                },
                            ),
                        )
                        .await;
                }
            });

            let wal_err = snap_wal
                .spool(tiny_wal_budget, Cancellation::default())
                .await;
            let _ = wal_writer.await;
            assert_validation_err(&wal_err, ValidationReason::BudgetExceeded);
        }
        store.set_backup_step_delay_for_test(Duration::ZERO);

        // Allow detached Drop cleanups a brief moment and verify zero `.tmp` files exist.
        tokio::time::sleep(Duration::from_millis(40)).await;
        for entry in fs::read_dir(&case.spool_dir).expect("read spool dir") {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(
                !name.ends_with(".tmp") && !name.contains("-journal"),
                "[{label}] leftover temporary backup file found: {name}"
            );
        }

        // 5. Purge raw-byte purity (`PRAGMA secure_delete = ON` + fresh backup scan).
        let secret_token = "SECRET_PURGE_TOKEN_9f4a8b2c7d1e6f30_NEVER_LEAK";
        let secret_note = NoteId::from_bytes([0x31; 16]);
        let secret_created = store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    CreateNote {
                        note: secret_note.clone(),
                        parent: None,
                        slug: format!("slug-{secret_token}").to_ascii_lowercase(),
                        class: DocClass::UserDoc,
                        carrier: format!(
                            "---\ntitle: {secret_token}\ntag: {secret_token}\n---\n# {secret_token}\n\nBody {secret_token}\n"
                        ),
                    },
                ),
            )
            .await
            .expect("create secret note");
        // Rename so `note_aliases` also gets the secret slug/title!
        let renamed = store
            .rename_note(
                ctx.clone(),
                Mutation {
                    preconditions: Preconditions {
                        revision: Some(secret_created.value.revision.clone()),
                        ..Preconditions::default()
                    },
                    ..next_mutation(
                        &scope,
                        &actor,
                        RenameNote {
                            note: secret_note.clone(),
                            slug: "renamed-before-purge".to_owned(),
                            title: None,
                        },
                    )
                },
            )
            .await
            .expect("rename secret note");
        // Open + close a collab session with the secret token in `yrs_snapshot_blob`!
        let opened_sec = store
            .open_collab_session(
                &make_budget(),
                OpenCollabSession {
                    scope: scope.clone(),
                    note: secret_note.clone(),
                    owner_id: "collab-sec".to_owned(),
                    expected_carrier_rev: renamed.value.revision.clone(),
                    expected_lease: None,
                    expected_lineage: None,
                    initial_yrs_snapshot: Some(secret_token.as_bytes().to_vec()),
                    allow_fenced_recovery: false,
                },
            )
            .await
            .expect("open secret collab");
        store
            .close_collab_session(
                &make_budget(),
                notarium_canonical::CloseCollabSession {
                    scope: scope.clone(),
                    note: secret_note.clone(),
                    owner_id: Some("collab-sec".to_owned()),
                    expected_lease: opened_sec.lease_epoch,
                    expected_lineage: opened_sec.lineage_epoch,
                    final_yrs_snapshot: Some(secret_token.as_bytes().to_vec()),
                    carrier_settlement: None,
                },
            )
            .await
            .expect("close secret collab");

        // Now Purge `secret_note`!
        store
            .delete_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    DeleteNote {
                        note: secret_note,
                        disposition: DeleteDisposition::Purge,
                    },
                ),
            )
            .await
            .expect("purge secret note");

        if case.is_sqlite {
            store.run_wal_maintenance_now(true).await;
            let raw_canonical =
                fs::read(case.temp_root.data_root().canonical()).expect("read canonical.sqlite");
            assert!(
                !find_subslice(&raw_canonical, secret_token.as_bytes())
                    && !find_subslice(&raw_canonical, secret_token.to_ascii_lowercase().as_bytes()),
                "[{label}] checkpointed canonical.sqlite must not retain purged secret bytes (secure_delete = ON)"
            );
        }

        // Take a fresh backup and scan raw artifact bytes for `secret_token`!
        let mut prep_clean = store
            .prepare(
                maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x32; 16]),
                budget,
            )
            .await
            .unwrap();
        let mut paused_clean = prep_clean.pause_writes().await.unwrap();
        let mut snap_clean = paused_clean.open_cut().await.unwrap();
        paused_clean.resume().await.unwrap();
        let spool_clean = snap_clean
            .spool(budget, Cancellation::default())
            .await
            .unwrap();
        snap_clean.close().await.unwrap();
        let clean_rec = store
            .get_backup_artifact(&spool_clean.artifact)
            .await
            .unwrap();
        let clean_bytes = fs::read(&clean_rec.artifact_path).unwrap();
        assert!(
            !find_subslice(&clean_bytes, secret_token.as_bytes())
                && !find_subslice(&clean_bytes, secret_token.to_ascii_lowercase().as_bytes()),
            "[{label}] fresh backup artifact must contain zero bytes of purged secret token"
        );

        // 6. `restore_cursors` rotates HistoryIncarnation, emits Resync, and rejects stale seq=N receipt even after new seq=N!
        let pre_restore_space = store.read_space(&scope.space_id).await.unwrap();
        let cut_before_extra = pre_restore_space.last_seq;

        let mut sub = store
            .subscribe(
                maintenance_ctx(ServicePurpose::Projection),
                ChangeCursor {
                    scope: scope.clone(),
                    after: cut_before_extra,
                },
            )
            .await
            .expect("subscribe before restore_cursors");

        // Commit one extra note at `cut_before_extra + 1` (`stale_seq`) and keep its receipt!
        let note_keep = NoteId::from_bytes([0x11; 16]);
        let stale_committed = store
            .rename_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &actor,
                    RenameNote {
                        note: note_keep.clone(),
                        slug: "note-select1-control-ephemeral".to_owned(),
                        title: None,
                    },
                ),
            )
            .await
            .expect("commit post-cut rename before restore");
        let stale_seq = stale_committed.receipt.seq();
        assert_eq!(stale_seq.get(), cut_before_extra.get() + 1);

        // Reject restore_cursors with the SAME incarnation (`InvalidState` per AcknowledgedCursor::restore)!
        let same_inc_err = store
            .restore_cursors(
                maintenance_ctx(ServicePurpose::Restore),
                vec![ChangeCursor {
                    scope: scope.clone(),
                    after: cut_before_extra,
                }],
            )
            .await;
        assert_validation_err(&same_inc_err, ValidationReason::InvalidState);

        // Rotate to `new_inc` at `cut_before_extra`!
        let new_inc = sample_incarnation(0x99);
        let new_scope = HistoryScope {
            space_id: scope.space_id.clone(),
            incarnation: new_inc,
        };
        store
            .restore_cursors(
                maintenance_ctx(ServicePurpose::Restore),
                vec![ChangeCursor {
                    scope: new_scope.clone(),
                    after: cut_before_extra,
                }],
            )
            .await
            .expect("restore_cursors to cut_before_extra");

        // Subscriber must observe `ChangeNotice::Resync { scope: new_scope }`!
        let mut saw_resync = false;
        for _ in 0..4 {
            if let Some(notice) = sub.next().await.expect("sub next")
                && let ChangeNotice::Resync { scope: observed } = notice
            {
                assert_eq!(observed, new_scope);
                saw_resync = true;
                break;
            }
        }
        assert!(
            saw_resync,
            "[{label}] subscriber must receive ChangeNotice::Resync after restore_cursors"
        );

        // Commit a brand-new note under `new_scope` so `last_seq` reaches `stale_seq` AGAIN!
        let ctx_new = owner_ctx(&new_scope, actor.clone());
        let new_at_same_seq = store
            .create_note(
                ctx_new.clone(),
                next_mutation(
                    &new_scope,
                    &actor,
                    CreateNote {
                        note: NoteId::from_bytes([0x39; 16]),
                        parent: None,
                        slug: "new-incarnation-same-seq".to_owned(),
                        class: DocClass::UserDoc,
                        carrier: "---\ntitle: Fresh Incarnation\n---\n# Fresh\n".to_owned(),
                    },
                ),
            )
            .await
            .expect("commit new note at same numeric seq under new incarnation");
        assert_eq!(new_at_same_seq.receipt.seq(), stale_seq);

        // Using the old `stale_committed.receipt` (same numeric seq, old incarnation) MUST fail with HistoryIncarnationMismatch!
        let stale_read = store
            .get_note(
                ctx_new.clone(),
                GetNote {
                    note: note_keep,
                    revision: None,
                    causal: CausalBasis::Exact(
                        ReceiptSet::new(vec![stale_committed.receipt]).unwrap(),
                    ),
                },
            )
            .await;
        assert_validation_err(&stale_read, ValidationReason::HistoryIncarnationMismatch);

        case.shutdown().await;
    }
}

trait OptionalRowExt<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}
impl<T> OptionalRowExt<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

// ============================================================================
// Isolated subprocess memory probes (`64 MiB` peer blob + `50` medium rows)
// ============================================================================

fn run_self_subprocess(
    test_name: &str,
    mode: &str,
    extra_env: &[(&str, &str)],
) -> std::process::Output {
    let exe = env::current_exe().expect("current test executable");
    let mut cmd = Command::new(exe);
    cmd.arg("--exact")
        .arg(test_name)
        .arg("--nocapture")
        .env(SUBPROC_MODE_ENV, mode);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("spawn child test subprocess");
    if !out.status.success() {
        panic!(
            "subprocess mode={mode} failed ({}):\nstdout:\n{}\nstderr:\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    out
}

fn parse_metric_u64(stdout: &str, key: &str) -> u64 {
    let prefix = format!("{key}=");
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix(&prefix) {
            return rest.parse::<u64>().expect("parse subprocess metric");
        }
    }
    panic!("metric '{key}' missing from subprocess stdout:\n{stdout}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn l4_memory_bound_64mib_peer_payload_and_negative_controls_isolated_subprocesses() {
    if let Ok(mode) = env::var(SUBPROC_MODE_ENV) {
        run_memory_subprocess_mode(&mode).await;
        return;
    }

    let test_name =
        "l4_memory_bound_64mib_peer_payload_and_negative_controls_isolated_subprocesses";
    let blob_64m =
        deterministic_incompressible_bytes(b"notarium-l4-64mib-peer-blob", PEER_BLOB_64MIB);
    let expected_digest = ContentDigest::from_bytes(*blake3::hash(&blob_64m).as_bytes()).to_hex();
    drop(blob_64m);

    // --- SQLite 64 MiB + 50 medium rows ---
    let sqlite_root = TempDataRoot::new("l4-mem-sqlite");
    let root_str = sqlite_root.path().to_str().unwrap();

    run_self_subprocess(
        test_name,
        "seed_sqlite_64m",
        &[
            (SUBPROC_PATH_ENV, root_str),
            (SUBPROC_DIGEST_ENV, &expected_digest),
        ],
    );

    let sq_pos_out = String::from_utf8(
        run_self_subprocess(
            test_name,
            "probe_sqlite_backup_positive",
            &[
                (SUBPROC_PATH_ENV, root_str),
                (SUBPROC_DIGEST_ENV, &expected_digest),
            ],
        )
        .stdout,
    )
    .unwrap();
    let sq_pos_delta_kib = parse_metric_u64(&sq_pos_out, "VMHWM_DELTA_KIB");
    let sq_pos_buf_bytes = parse_metric_u64(&sq_pos_out, "EXPORTER_WORKING_BUF_BYTES");

    let sq_neg_out = String::from_utf8(
        run_self_subprocess(
            test_name,
            "probe_sqlite_substr_negative",
            &[(SUBPROC_PATH_ENV, root_str)],
        )
        .stdout,
    )
    .unwrap();
    let sq_neg_delta_kib = parse_metric_u64(&sq_neg_out, "VMHWM_DELTA_KIB");

    assert!(
        sq_pos_buf_bytes <= 8 * 1024 * 1024,
        "SQLite exporter working buffers ({sq_pos_buf_bytes} B) exceeded 8 MiB limit"
    );
    assert!(
        sq_pos_delta_kib <= 24 * 1024,
        "SQLite safe page backup VmHWM delta ({sq_pos_delta_kib} KiB) should stay well below 64 MiB"
    );
    assert!(
        sq_neg_delta_kib >= 50 * 1024,
        "SQLite substr negative control expected >= 50 MiB VmHWM spike, got {sq_neg_delta_kib} KiB"
    );
    assert!(
        sq_neg_delta_kib > sq_pos_delta_kib + 32 * 1024,
        "SQLite safe page backup ({sq_pos_delta_kib} KiB) must clearly beat substr negative control ({sq_neg_delta_kib} KiB)"
    );

    // --- PostgreSQL 16 64 MiB + 50 medium rows ---
    let fixtures = StorageTestFixtures::load_required();
    let pg_schema = fixtures.fresh_pg_schema();
    let pg_spool_root = TempDataRoot::new("l4-mem-pg-spool");
    let pg_spool_str = pg_spool_root.path().to_str().unwrap();

    run_self_subprocess(
        test_name,
        "seed_pg_64m",
        &[
            (SUBPROC_SCHEMA_ENV, &pg_schema),
            (SUBPROC_PATH_ENV, pg_spool_str),
            (SUBPROC_DIGEST_ENV, &expected_digest),
        ],
    );

    let pg_pos_out = String::from_utf8(
        run_self_subprocess(
            test_name,
            "probe_pg_spool_positive",
            &[
                (SUBPROC_SCHEMA_ENV, &pg_schema),
                (SUBPROC_PATH_ENV, pg_spool_str),
                (SUBPROC_DIGEST_ENV, &expected_digest),
            ],
        )
        .stdout,
    )
    .unwrap();
    let pg_pos_delta_kib = parse_metric_u64(&pg_pos_out, "VMHWM_DELTA_KIB");
    let pg_pos_buf_bytes = parse_metric_u64(&pg_pos_out, "EXPORTER_WORKING_BUF_BYTES");
    let pg_pos_chunk_bytes = parse_metric_u64(&pg_pos_out, "EXPORTER_MAX_CHUNK_BYTES");

    let pg_neg_out = String::from_utf8(
        run_self_subprocess(
            test_name,
            "probe_pg_whole_row_negative",
            &[(SUBPROC_SCHEMA_ENV, &pg_schema)],
        )
        .stdout,
    )
    .unwrap();
    let pg_neg_delta_kib = parse_metric_u64(&pg_neg_out, "VMHWM_DELTA_KIB");

    fixtures.drop_pg_schema(&pg_schema).await;

    assert!(
        pg_pos_buf_bytes <= 8 * 1024 * 1024,
        "PostgresSpoolV1 working buffers ({pg_pos_buf_bytes} B) exceeded 8 MiB limit"
    );
    assert!(
        pg_pos_chunk_bytes <= 64 * 1024,
        "PostgresSpoolV1 max slice ({pg_pos_chunk_bytes} B) exceeded 64 KiB"
    );
    assert!(
        pg_pos_delta_kib <= 24 * 1024,
        "PostgresSpoolV1 VmHWM delta ({pg_pos_delta_kib} KiB) should stay well below 64 MiB"
    );
    assert!(
        pg_neg_delta_kib >= 50 * 1024,
        "Postgres SELECT * negative control expected >= 50 MiB VmHWM spike, got {pg_neg_delta_kib} KiB"
    );
    assert!(
        pg_neg_delta_kib > pg_pos_delta_kib + 32 * 1024,
        "PostgresSpoolV1 ({pg_pos_delta_kib} KiB) must clearly beat whole-row SELECT * negative control ({pg_neg_delta_kib} KiB)"
    );
}

async fn run_memory_subprocess_mode(mode: &str) {
    match mode {
        "seed_sqlite_64m" => {
            let root = DataRoot::new(env::var(SUBPROC_PATH_ENV).unwrap());
            let expected_hex = env::var(SUBPROC_DIGEST_ENV).unwrap();
            let cfg = CanonicalConfig {
                installation_id: sample_installation_id(0x71),
                sql: SqlBackendConfig::sqlite_default(root.clone()),
                blobs: BlobBackendConfig::Local {
                    data_root: root.clone(),
                },
                writer: WriterConfig::default(),
                snapshot_retention: Duration::from_secs(300),
                default_backup_budget: default_backup_budget(),
            };
            let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
            seed_64m_and_50_medium_rows(&store, &expected_hex).await;
            store.run_wal_maintenance_now(true).await;
            runtime.shutdown().await.unwrap();
        }
        "probe_sqlite_backup_positive" => {
            let root = DataRoot::new(env::var(SUBPROC_PATH_ENV).unwrap());
            let expected_hex = env::var(SUBPROC_DIGEST_ENV).unwrap();
            let cfg = CanonicalConfig {
                installation_id: sample_installation_id(0x71),
                sql: SqlBackendConfig::sqlite_default(root.clone()),
                blobs: BlobBackendConfig::Local { data_root: root },
                writer: WriterConfig::default(),
                snapshot_retention: Duration::from_secs(300),
                default_backup_budget: default_backup_budget(),
            };
            let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
            let before_hwm = read_proc_vm_hwm_kib();

            let budget = default_backup_budget();
            let mut prep = store
                .prepare(
                    maintenance_ctx(ServicePurpose::Backup),
                    BackupId::from_bytes([0x72; 16]),
                    budget,
                )
                .await
                .unwrap();
            let mut paused = prep.pause_writes().await.unwrap();
            let mut snap = paused.open_cut().await.unwrap();
            paused.resume().await.unwrap();
            let spool = snap.spool(budget, Cancellation::default()).await.unwrap();
            snap.close().await.unwrap();

            let after_hwm = read_proc_vm_hwm_kib();
            let stats = store.last_backup_memory_stats().unwrap();
            let rec = store.get_backup_artifact(&spool.artifact).await.unwrap();
            assert!(
                rec.byte_size >= PEER_BLOB_64MIB as u64,
                "SQLite snapshot artifact must contain the 64 MiB payload"
            );

            // Verify exact 64 MiB payload in the spooled SQLite file AFTER `after_hwm` was already sampled!
            let verify_conn = rusqlite::Connection::open_with_flags(
                &rec.artifact_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .unwrap();
            let spooled_blob: Vec<u8> = verify_conn
                .query_row(
                    "SELECT yrs_snapshot_blob FROM collab_sessions LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(spooled_blob.len(), PEER_BLOB_64MIB);
            assert_eq!(
                ContentDigest::from_bytes(*blake3::hash(&spooled_blob).as_bytes()).to_hex(),
                expected_hex
            );
            let upd_count: i64 = verify_conn
                .query_row("SELECT COUNT(*) FROM collab_update_log", [], |r| r.get(0))
                .unwrap();
            assert_eq!(upd_count, MEDIUM_ROW_COUNT as i64);
            drop(spooled_blob);
            drop(verify_conn);

            runtime.shutdown().await.unwrap();
            println!("VMHWM_DELTA_KIB={}", after_hwm.saturating_sub(before_hwm));
            println!(
                "EXPORTER_WORKING_BUF_BYTES={}",
                stats.max_working_buffer_bytes
            );
        }
        "probe_sqlite_substr_negative" => {
            let root = DataRoot::new(env::var(SUBPROC_PATH_ENV).unwrap());
            let conn = rusqlite::Connection::open_with_flags(
                root.canonical(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .unwrap();
            let before_hwm = read_proc_vm_hwm_kib();
            // Negative control: `SELECT substr(yrs_snapshot_blob, ...)` forces SQLite to materialize the 64 MiB overflow chain!
            let tail_slice: Vec<u8> = conn
                .query_row(
                    "SELECT substr(yrs_snapshot_blob, ?1, 65536) FROM collab_sessions LIMIT 1",
                    [(PEER_BLOB_64MIB - 65535) as i64],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(tail_slice.len(), 65536);
            let after_hwm = read_proc_vm_hwm_kib();
            println!("VMHWM_DELTA_KIB={}", after_hwm.saturating_sub(before_hwm));
        }
        "seed_pg_64m" => {
            let fixtures = StorageTestFixtures::load_required();
            let schema = env::var(SUBPROC_SCHEMA_ENV).unwrap();
            let spool_root = DataRoot::new(env::var(SUBPROC_PATH_ENV).unwrap());
            let expected_hex = env::var(SUBPROC_DIGEST_ENV).unwrap();
            let cfg = fixtures.pg_local_config(sample_installation_id(0x73), &schema, spool_root);
            let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
            seed_64m_and_50_medium_rows(&store, &expected_hex).await;
            runtime.shutdown().await.unwrap();
        }
        "probe_pg_spool_positive" => {
            let fixtures = StorageTestFixtures::load_required();
            let schema = env::var(SUBPROC_SCHEMA_ENV).unwrap();
            let spool_root = DataRoot::new(env::var(SUBPROC_PATH_ENV).unwrap());
            let expected_hex = env::var(SUBPROC_DIGEST_ENV).unwrap();
            let cfg =
                fixtures.pg_local_config(sample_installation_id(0x73), &schema, spool_root.clone());
            let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
            let before_hwm = read_proc_vm_hwm_kib();

            let budget = default_backup_budget();
            let mut prep = store
                .prepare(
                    maintenance_ctx(ServicePurpose::Backup),
                    BackupId::from_bytes([0x74; 16]),
                    budget,
                )
                .await
                .unwrap();
            let mut paused = prep.pause_writes().await.unwrap();
            let mut snap = paused.open_cut().await.unwrap();
            paused.resume().await.unwrap();
            let spool = snap.spool(budget, Cancellation::default()).await.unwrap();
            snap.close().await.unwrap();

            let after_hwm = read_proc_vm_hwm_kib();
            let stats = store.last_backup_memory_stats().unwrap();
            let rec = store.get_backup_artifact(&spool.artifact).await.unwrap();
            assert!(
                rec.byte_size >= PEER_BLOB_64MIB as u64,
                "PostgresSpoolV1 artifact must contain the 64 MiB payload"
            );

            // Verify decoded 64 MiB payload matches exact BLAKE3 AFTER recording `after_hwm`!
            let decoded = decode_postgres_spool_v1(&rec.artifact_path).unwrap();
            let collab_tbl = decoded
                .tables
                .iter()
                .find(|t| t.name == "collab_sessions")
                .unwrap();
            let blob_idx = collab_tbl
                .columns
                .iter()
                .position(|c| c == "yrs_snapshot_blob")
                .unwrap();
            match &collab_tbl.rows[0][blob_idx] {
                PostgresSpoolValue::Bytes(b) => {
                    assert_eq!(b.len(), PEER_BLOB_64MIB);
                    assert_eq!(
                        ContentDigest::from_bytes(*blake3::hash(b).as_bytes()).to_hex(),
                        expected_hex
                    );
                }
                other => panic!("expected 64 MiB Bytes in collab_sessions, got {other:?}"),
            }

            runtime.shutdown().await.unwrap();
            println!("VMHWM_DELTA_KIB={}", after_hwm.saturating_sub(before_hwm));
            println!(
                "EXPORTER_WORKING_BUF_BYTES={}",
                stats.max_working_buffer_bytes
            );
            println!("EXPORTER_MAX_CHUNK_BYTES={}", stats.max_chunk_buffer_bytes);
        }
        "probe_pg_whole_row_negative" => {
            use sqlx::Connection;
            let fixtures = StorageTestFixtures::load_required();
            let schema = env::var(SUBPROC_SCHEMA_ENV).unwrap();
            let mut conn = fixtures.open_raw_pg().await;
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "SET search_path TO \"{schema}\""
            )))
            .execute(&mut conn)
            .await
            .unwrap();
            let before_hwm = read_proc_vm_hwm_kib();
            let whole_row: (Vec<u8>,) =
                sqlx::query_as("SELECT yrs_snapshot_blob FROM collab_sessions LIMIT 1")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(whole_row.0.len(), PEER_BLOB_64MIB);
            let after_hwm = read_proc_vm_hwm_kib();
            let _ = conn.close().await;
            println!("VMHWM_DELTA_KIB={}", after_hwm.saturating_sub(before_hwm));
        }
        other => panic!("unknown subprocess mode '{other}'"),
    }
}

async fn seed_64m_and_50_medium_rows(store: &CanonicalStore, expected_hex: &str) {
    let actor = sample_principal_id(0x75);
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x75),
            incarnation: sample_incarnation(0x75),
            root_folder_id: sample_folder_id(0x75),
            slug: "mem-bound-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let ctx = owner_ctx(&space.scope, actor.clone());
    let note = sample_note_id(0x75);
    let created = store
        .create_note(
            ctx,
            next_mutation(
                &space.scope,
                &actor,
                CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "peer-64m-carrier".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Peer 64M\n---\n# Peer 64M\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();

    let blob_64m =
        deterministic_incompressible_bytes(b"notarium-l4-64mib-peer-blob", PEER_BLOB_64MIB);
    assert_eq!(
        ContentDigest::from_bytes(*blake3::hash(&blob_64m).as_bytes()).to_hex(),
        expected_hex
    );

    let opened = store
        .open_collab_session(
            &make_budget(),
            OpenCollabSession {
                scope: space.scope.clone(),
                note: note.clone(),
                owner_id: "mem-owner".to_owned(),
                expected_carrier_rev: created.value.revision,
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: Some(blob_64m),
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();

    for idx in 1..=(MEDIUM_ROW_COUNT as u64) {
        let med = deterministic_incompressible_bytes(
            format!("med-row-{idx}").as_bytes(),
            MEDIUM_ROW_BYTES,
        );
        store
            .append_collab_update(
                &make_budget(),
                notarium_canonical::AppendCollabUpdate {
                    scope: space.scope.clone(),
                    note: note.clone(),
                    owner_id: "mem-owner".to_owned(),
                    expected_lease: opened.lease_epoch,
                    expected_lineage: opened.lineage_epoch,
                    update_seq: idx,
                    update_bytes: med,
                },
            )
            .await
            .unwrap();
    }
    // Leave session unclosed so BOTH the 64 MiB `yrs_snapshot_blob` AND all 50 `collab_update_log`
    // rows remain resident in the database during isolated backup memory probes.
}

// ============================================================================
// Real OS subprocess `SIGKILL` crash-recovery test
// ============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn l4_real_sigkill_crash_recovery_owner_lock_collab_fence_and_pending_purge() {
    if env::var(SUBPROC_MODE_ENV).as_deref() == Ok("sigkill_victim") {
        run_sigkill_victim_child().await;
        return;
    }

    let temp_root = TempDataRoot::new("l4-sigkill");
    let root_path_str = temp_root.path().to_str().unwrap();

    let exe = env::current_exe().expect("current test exe");
    let mut child = Command::new(exe)
        .arg("--exact")
        .arg("l4_real_sigkill_crash_recovery_owner_lock_collab_fence_and_pending_purge")
        .arg("--nocapture")
        .env(SUBPROC_MODE_ENV, "sigkill_victim")
        .env(SUBPROC_PATH_ENV, root_path_str)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn sigkill victim child");

    let stdout = child.stdout.take().expect("child stdout");
    let mut lines = BufReader::new(stdout).lines();
    let mut ready_digest_hex: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(Ok(line)) = lines.next()
            && let Some(hex_digest) = line.strip_prefix("READY_FOR_SIGKILL:")
        {
            ready_digest_hex = Some(hex_digest.trim().to_owned());
            break;
        }
    }
    let purged_digest_hex = ready_digest_hex.expect("victim child did not reach READY_FOR_SIGKILL");
    let _purged_digest = ContentDigest::parse_hex(&purged_digest_hex).unwrap();

    // Verify `DataRootOwnerLock` is actively held by the live victim process (`DataRootBusy`)!
    let lock_probe = DataRootOwnerLock::acquire(&temp_root.data_root());
    assert!(
        lock_probe.is_err(),
        "DataRootOwnerLock must reject concurrent open while victim process holds flock"
    );

    // Verify the Step-1 purged note's `.zst` CAS blob is STILL on disk right before SIGKILL!
    let space_id = sample_space_id(0x81);
    let cas_file = temp_root.path().join(format!(
        "blobs/{}/{}/{purged_digest_hex}.zst",
        space_id.as_str(),
        &purged_digest_hex[..2]
    ));
    assert!(
        cas_file.exists(),
        "Step-1 interrupted purge should leave local CAS file on disk prior to Step 2/3: {}",
        cas_file.display()
    );

    // Deliver real OS SIGKILL (`kill -9`)!
    child.kill().expect("send SIGKILL to victim process");
    let exit_status = child.wait().expect("reap SIGKILLed victim process");
    assert!(
        !exit_status.success(),
        "SIGKILLed victim process must not exit 0"
    );

    // Reopen CanonicalRuntime on the exact same DataRoot!
    let cfg = CanonicalConfig {
        installation_id: sample_installation_id(0x81),
        sql: SqlBackendConfig::sqlite_default(temp_root.data_root()),
        blobs: BlobBackendConfig::Local {
            data_root: temp_root.data_root(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: default_backup_budget(),
    };
    let (store, runtime) = CanonicalRuntime::open(cfg)
        .await
        .expect("reopen CanonicalRuntime after SIGKILL must acquire released flock and recover");

    // 1. Interrupted Step-1 purge must have been driven through Step 2/3 CAS deletion on startup!
    assert!(
        !cas_file.exists(),
        "startup purge recovery must unlink orphaned CAS file after SIGKILL"
    );
    let incomplete_purges = store
        .execute_diagnostic_read_sql_for_test(
            None,
            "SELECT COUNT(*) FROM pending_purges WHERE phase <> 'completed'",
        )
        .await
        .unwrap();
    assert_eq!(incomplete_purges, 0);

    // 2. Orphaned active collaborative session must have transitioned to `CollabRoomState::Fenced`!
    let scope = HistoryScope {
        space_id: space_id.clone(),
        incarnation: sample_incarnation(0x81),
    };
    let collab_note = sample_note_id(0x82);
    let snap = store
        .read_collab_session(None, &scope, &collab_note)
        .await
        .unwrap()
        .expect("persisted collab session must exist");
    assert_eq!(snap.session.room_state, CollabRoomState::Fenced);
    assert_eq!(snap.session.owner_id, None);
    assert!(
        snap.session.lease_epoch.get() >= 2,
        "fenced recovery must increment lease_epoch"
    );

    runtime.shutdown().await.unwrap();
}

async fn run_sigkill_victim_child() {
    let data_root = DataRoot::new(Path::new(&env::var(SUBPROC_PATH_ENV).unwrap()));
    let cfg = CanonicalConfig {
        installation_id: sample_installation_id(0x81),
        sql: SqlBackendConfig::sqlite_default(data_root.clone()),
        blobs: BlobBackendConfig::Local { data_root },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: default_backup_budget(),
    };
    let (store, _runtime_kept_alive_until_sigkill) = CanonicalRuntime::open(cfg).await.unwrap();
    let actor = sample_principal_id(0x81);
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x81),
            incarnation: sample_incarnation(0x81),
            root_folder_id: sample_folder_id(0x81),
            slug: "sigkill-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let ctx = owner_ctx(&space.scope, actor.clone());

    // 1. Note with active collaborative session left open across SIGKILL.
    let collab_note = sample_note_id(0x82);
    let c_created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &space.scope,
                &actor,
                CreateNote {
                    note: collab_note.clone(),
                    parent: None,
                    slug: "collab-victim-note".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Collab Victim\n---\n# Collab\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    store
        .open_collab_session(
            &make_budget(),
            OpenCollabSession {
                scope: space.scope.clone(),
                note: collab_note,
                owner_id: "victim-live-room".to_owned(),
                expected_carrier_rev: c_created.value.revision,
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: Some(b"yrs-active-state".to_vec()),
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();

    // 2. Note interrupted right after Step 1 of Purge (before Step 2/3 unlinks CAS file).
    let purge_note = sample_note_id(0x83);
    let purge_carrier =
        "---\ntitle: Purge Victim\n---\n# Purge Victim\nUniquePurgePayloadBeforeSigkill\n"
            .to_owned();
    let purge_digest_hex =
        ContentDigest::from_bytes(*blake3::hash(purge_carrier.as_bytes()).as_bytes()).to_hex();
    store
        .create_note(
            ctx.clone(),
            next_mutation(
                &space.scope,
                &actor,
                CreateNote {
                    note: purge_note.clone(),
                    parent: None,
                    slug: "purge-victim-note".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: purge_carrier,
                },
            ),
        )
        .await
        .unwrap();
    store
        .simulate_interrupted_purge_step1_for_test(
            ctx,
            next_mutation(
                &space.scope,
                &actor,
                DeleteNote {
                    note: purge_note,
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();

    println!("READY_FOR_SIGKILL:{purge_digest_hex}");
    use std::io::Write;
    std::io::stdout().flush().unwrap();

    // Sleep holding the open runtime + flock until parent sends SIGKILL!
    let _keep = StdMutex::new(_runtime_kept_alive_until_sigkill);
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
