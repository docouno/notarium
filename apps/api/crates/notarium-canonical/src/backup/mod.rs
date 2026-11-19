mod materialize;
mod ownership;
mod phase;
mod restore;
use ownership::{ArtifactLease, HoldOwnership};

use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{
        ArtifactId, BackupId, ContentDigest, HistoryIncarnation, InstallationId, LeaseEpoch,
        SpaceId,
    },
    model::HistoryScope,
    ports::{
        BackupArtifactKind, BackupBudget, BackupHold, BackupParticipantPort, BackupProgress,
        BackupSnapshot, BackupSpool, BackupWitness, Cancellation, MaintenanceContext, PausedBackup,
        PortFuture, PreparedBackup, ServicePurpose,
    },
    ports::{BackupRetentionBudget, BackupRetentionProgress},
    receipt::ChangeCursor,
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, PgConnection, Row};

use crate::{
    CanonicalStore, RoomFenceTable,
    codec::{
        MAX_MSGPACK_DECODE_BYTES, cancelled_not_committed, deadline_not_committed,
        decode_msgpack_bounded, encode_msgpack, i64_to_space_seq, internal_not_committed,
        now_unix_ms, unavailable_retryable,
    },
    config::{BlobBackendConfig, SqlBackendConfig},
    domain::purge::has_incomplete_pending_purges_tx,
    runtime::{
        CanonicalInner, SqlDriverState, load_space_record_for_update_opt, require_command_end_tx,
    },
    schema::manifest::{
        CANONICAL_SCHEMA_VERSION, CANONICAL_TABLES, LogicalColKind, TableSpec, checksum_tables,
        manifest_checksum,
    },
    sql_exec::BackendConn,
    wal::BackupWalPinGuard,
    writer::WriterSafePointGuard,
};

pub const POSTGRES_SPOOL_V1_MAGIC: &[u8] = b"NOTARIUM_PG_SPOOL_V1\n";
pub const PG_SLICE_MAX_BYTES: usize = 64 * 1024;
pub const SQLITE_BACKUP_PAGES_PER_STEP: i32 = 16;
const SQLITE_CACHE_KIB: i32 = 512;
const STREAM_IO_BUF_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupArtifactEncoding {
    SqliteSnapshotV1,
    PostgresSpoolV1,
}

impl BackupArtifactEncoding {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::SqliteSnapshotV1 => "sqlite_snapshot_v1",
            Self::PostgresSpoolV1 => "postgres_spool_v1",
        }
    }

    pub fn from_db_str(raw: &str) -> Result<Self, PortError> {
        match raw {
            "sqlite_snapshot_v1" => Ok(Self::SqliteSnapshotV1),
            "postgres_spool_v1" => Ok(Self::PostgresSpoolV1),
            other => Err(internal_not_committed(
                "corrupt_backup_encoding",
                format!("unknown backup artifact encoding '{other}'"),
            )),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::SqliteSnapshotV1 => "sqlite",
            Self::PostgresSpoolV1 => "pgspool",
        }
    }
}

#[derive(Clone, Debug)]
pub struct BackupArtifactRecord {
    pub artifact_id: ArtifactId,
    pub backup_id: BackupId,
    pub installation_id: InstallationId,
    pub encoding: BackupArtifactEncoding,
    pub schema_version: u32,
    pub artifact_path: PathBuf,
    pub byte_size: u64,
    pub digest: ContentDigest,
    pub witness: BackupWitness,
    pub state: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BackupExporterMemoryStats {
    pub encoding: BackupArtifactEncoding,
    pub max_chunk_buffer_bytes: usize,
    pub max_working_buffer_bytes: usize,
    pub total_bytes_written: u64,
    pub step_or_slice_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PostgresSpoolValue {
    Null,
    Int(i64),
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedPostgresSpoolTable {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<PostgresSpoolValue>>,
}

#[derive(Clone, Debug)]
pub struct DecodedPostgresSpoolV1 {
    pub schema_version: u32,
    pub manifest_checksum: ContentDigest,
    pub witness: BackupWitness,
    pub tables: Vec<DecodedPostgresSpoolTable>,
}

fn encode_witness_json(w: &BackupWitness) -> Result<String, PortError> {
    serde_json::to_string(w)
        .map_err(|err| internal_not_committed("encode_backup_witness_json", err.to_string()))
}

fn encode_hold_witness(
    installation: &InstallationId,
    cursor: &ChangeCursor,
) -> Result<String, PortError> {
    encode_witness_json(&BackupWitness {
        installation: installation.clone(),
        schema_version: CANONICAL_SCHEMA_VERSION,
        histories: vec![cursor.clone()],
        canaries: Vec::new(),
    })
}

fn decode_witness_json(raw: &str) -> Result<BackupWitness, PortError> {
    serde_json::from_str(raw)
        .map_err(|err| internal_not_committed("decode_backup_witness_json", err.to_string()))
}

pub(crate) fn register_cleanup_task(inner: &CanonicalInner, handle: tokio::task::JoinHandle<()>) {
    let mut guard = inner.backup_cleanups.lock().expect("backup cleanups mutex");
    guard.retain(|h| !h.is_finished());
    guard.push(handle);
}

fn resolve_spool_dir(inner: &CanonicalInner) -> Result<PathBuf, PortError> {
    if let Some(custom) = inner
        .backup_spool_override
        .lock()
        .expect("backup spool override mutex")
        .clone()
    {
        ensure_private_dir(&custom)?;
        return Ok(custom);
    }

    let dir = match (&inner.config.sql, &inner.config.blobs) {
        (SqlBackendConfig::Sqlite { data_root, .. }, _) => data_root.staging().join("backups"),
        (_, BlobBackendConfig::Local { data_root }) => data_root.staging().join("backups"),
        _ => std::env::temp_dir().join(format!(
            "notarium-backup-spool-{}",
            inner.config.installation_id.as_str()
        )),
    };
    ensure_private_dir(&dir)?;
    Ok(dir)
}

fn ensure_private_dir(path: &Path) -> Result<(), PortError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(path)
            .map_err(|err| internal_not_committed("create_backup_spool_dir", err.to_string()))?;
        let metadata = fs::symlink_metadata(path)
            .map_err(|err| internal_not_committed("stat_backup_spool_dir", err.to_string()))?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(internal_not_committed(
                "private_backup_spool_required",
                "backup spool directory must be private",
            ));
        }
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)
            .map_err(|err| internal_not_committed("create_backup_spool_dir", err.to_string()))?;
    }
    Ok(())
}

fn create_private_tmp_file(path: &Path) -> Result<File, PortError> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .map_err(|err| internal_not_committed("create_backup_tmp_file", err.to_string()))
}

fn fsync_parent_dir(path: &Path) -> Result<(), PortError> {
    if let Some(parent) = path.parent() {
        let dir_file = File::open(parent)
            .map_err(|err| internal_not_committed("open_backup_parent_dir", err.to_string()))?;
        dir_file
            .sync_all()
            .map_err(|err| internal_not_committed("fsync_backup_parent_dir", err.to_string()))?;
    }
    Ok(())
}

fn remove_tmp_artifacts(tmp: &Path) -> Result<(), PortError> {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let mut path = tmp.as_os_str().to_owned();
        path.push(suffix);
        ownership::remove_if_present(Path::new(&path))?;
    }
    Ok(())
}

fn remove_tmp_artifacts_best_effort(tmp: &Path) {
    let _ = remove_tmp_artifacts(tmp);
}

fn mint_artifact_id() -> Result<ArtifactId, PortError> {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw)
        .map_err(|err| internal_not_committed("csprng_artifact_id", err.to_string()))?;
    Ok(ArtifactId::from_bytes(raw))
}

fn tighten_budget(a: BackupBudget, b: BackupBudget) -> Result<BackupBudget, PortError> {
    let retention = match (a.retention, b.retention) {
        (
            BackupRetentionBudget::SqliteWal {
                max_pinned_bytes: a,
            },
            BackupRetentionBudget::SqliteWal {
                max_pinned_bytes: b,
            },
        ) => BackupRetentionBudget::SqliteWal {
            max_pinned_bytes: a.min(b),
        },
        (
            BackupRetentionBudget::PostgresSnapshot { max_age: a },
            BackupRetentionBudget::PostgresSnapshot { max_age: b },
        ) => BackupRetentionBudget::PostgresSnapshot { max_age: a.min(b) },
        _ => return Err(DomainError::validation(ValidationReason::ScopeMismatch).into()),
    };
    let budget = BackupBudget {
        deadline: a.deadline.min(b.deadline),
        retention,
        max_spool_bytes: a.max_spool_bytes.min(b.max_spool_bytes),
    };
    validate_backup_budget(budget)?;
    Ok(budget)
}

async fn wait_for_phase<T>(
    remaining: Duration,
    cancellation: &Cancellation,
    shutdown: &Cancellation,
    operation: impl std::future::Future<Output = Result<T, PortError>>,
) -> Result<T, PortError> {
    if cancellation.is_cancelled() {
        return Err(cancelled_not_committed(
            "backup_cancelled",
            "backup cancelled",
        ));
    }
    if remaining.is_zero() {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
    tokio::select! {
        () = shutdown.cancelled() => Err(cancelled_not_committed("backup_shutdown", "backup shutting down")),
        () = cancellation.cancelled() => Err(cancelled_not_committed("backup_cancelled", "backup cancelled")),
        result = tokio::time::timeout(remaining, operation) => result.map_err(|_| DomainError::validation(ValidationReason::BudgetExceeded))?,
    }
}

fn validate_backup_budget(budget: BackupBudget) -> Result<(), PortError> {
    if budget.deadline.is_zero()
        || budget.max_spool_bytes == 0
        || matches!(budget.retention, BackupRetentionBudget::PostgresSnapshot { max_age } if max_age.is_zero())
    {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
    Ok(())
}

pub(crate) async fn recover_backup_state(store: &CanonicalStore) -> Result<(), PortError> {
    ownership::recover_holds(store).await?;
    let dir = resolve_spool_dir(&store.inner)?;
    ownership::recover_directory(store, &dir).await
}

impl CanonicalStore {
    pub fn default_backup_budget(&self) -> BackupBudget {
        self.inner.config.default_backup_budget
    }

    pub fn set_backup_spool_dir(&self, dir: PathBuf) {
        *self
            .inner
            .backup_spool_override
            .lock()
            .expect("backup spool override mutex") = Some(dir);
    }

    pub fn last_backup_memory_stats(&self) -> Option<BackupExporterMemoryStats> {
        *self
            .inner
            .last_backup_memory_stats
            .lock()
            .expect("backup memory stats mutex")
    }

    #[cfg(feature = "test-support")]
    pub fn set_backup_step_delay_for_test(&self, delay: Duration) {
        let us = u64::try_from(delay.as_micros()).unwrap_or(u64::MAX);
        self.inner.backup_step_delay_us.store(us, Ordering::SeqCst);
    }

    pub async fn get_backup_artifact(
        &self,
        artifact_id: &ArtifactId,
    ) -> Result<BackupArtifactRecord, PortError> {
        let aid = artifact_id.clone();
        let mut record = self.with_read_tx(|tx| {
            Box::pin(async move {
                type RawBackupArtifactRow = (
                    String,
                    String,
                    String,
                    i64,
                    String,
                    i64,
                    Vec<u8>,
                    String,
                    String,
                    i64,
                );
                let row_opt: Option<RawBackupArtifactRow> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let r = sqlx::query(
                            "SELECT backup_id, installation_id, encoding, schema_version,
                                    artifact_rel_path, byte_size, content_blake3, witness_json,
                                    state, created_at_ms
                             FROM backup_artifacts
                             WHERE artifact_id = ?",
                        )
                        .bind(aid.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_get_backup_artifact", err.to_string())
                        })?;
                        r.map(|row| {
                            (
                                row.get("backup_id"),
                                row.get("installation_id"),
                                row.get("encoding"),
                                row.get("schema_version"),
                                row.get("artifact_rel_path"),
                                row.get("byte_size"),
                                row.get("content_blake3"),
                                row.get("witness_json"),
                                row.get("state"),
                                row.get("created_at_ms"),
                            )
                        })
                    }
                    BackendConn::Postgres(conn) => {
                        let r = sqlx::query(
                            "SELECT backup_id, installation_id, encoding, schema_version::BIGINT AS schema_version,
                                    artifact_rel_path, byte_size, content_blake3, witness_json,
                                    state, created_at_ms
                             FROM backup_artifacts
                             WHERE artifact_id = $1",
                        )
                        .bind(aid.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            crate::runtime::pg_read_error("pg_get_backup_artifact", err)
                        })?;
                        r.map(|row| {
                            (
                                row.get("backup_id"),
                                row.get("installation_id"),
                                row.get("encoding"),
                                row.get("schema_version"),
                                row.get("artifact_rel_path"),
                                row.get("byte_size"),
                                row.get("content_blake3"),
                                row.get("witness_json"),
                                row.get("state"),
                                row.get("created_at_ms"),
                            )
                        })
                    }
                };

                let Some((
                    backup_raw,
                    inst_raw,
                    enc_raw,
                    schema_ver_i64,
                    rel_path,
                    byte_size_i64,
                    digest_bytes,
                    witness_json,
                    state,
                    created_at_ms,
                )) = row_opt
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };

                let backup_id = BackupId::parse(&backup_raw).map_err(|_| {
                    internal_not_committed("corrupt_backup_id", "invalid BackupId in registry")
                })?;
                let installation_id = InstallationId::parse(&inst_raw).map_err(|_| {
                    internal_not_committed(
                        "corrupt_backup_installation",
                        "invalid InstallationId in registry",
                    )
                })?;
                let encoding = BackupArtifactEncoding::from_db_str(&enc_raw)?;
                let schema_version = u32::try_from(schema_ver_i64).map_err(|_| {
                    internal_not_committed("corrupt_backup_schema_ver", "negative schema_version")
                })?;
                let byte_size = u64::try_from(byte_size_i64).map_err(|_| {
                    internal_not_committed("corrupt_backup_byte_size", "negative byte_size")
                })?;
                let digest_arr: [u8; 32] = digest_bytes.try_into().map_err(|_| {
                    internal_not_committed("corrupt_backup_digest", "content_blake3 != 32B")
                })?;
                let witness = decode_witness_json(&witness_json)?;

                Ok(BackupArtifactRecord {
                    artifact_id: aid,
                    backup_id,
                    installation_id,
                    encoding,
                    schema_version,
                    artifact_path: PathBuf::from(rel_path),
                    byte_size,
                    digest: ContentDigest::from_bytes(digest_arr),
                    witness,
                    state,
                    created_at_ms,
                })
            })
        })
        .await?;
        let key = record
            .artifact_path
            .to_str()
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?
            .to_owned();
        let store = self.clone();
        let id = artifact_id.clone();
        let encoding = record.encoding;
        let size = record.byte_size;
        let digest = record.digest;
        record.artifact_path = tokio::task::spawn_blocking(move || {
            ownership::locate(&store, &id, encoding, &key, size, digest)
        })
        .await
        .map_err(|err| internal_not_committed("locate_backup_artifact", err.to_string()))??;
        Ok(record)
    }
}

// ============================================================================
// SQLite dedicated owner-thread worker (`!Send` `rusqlite::Connection` + `Backup`)
// ============================================================================

struct SqliteSpoolSuccess {
    bytes: u64,
    digest: ContentDigest,
    stats: BackupExporterMemoryStats,
}

enum SqliteWorkerCmd {
    OpenCut {
        wal_pin: BackupWalPinGuard,
        shutdown: Cancellation,
        remaining: Duration,
        expected_installation: InstallationId,
        reply: tokio::sync::oneshot::Sender<Result<BackupWitness, PortError>>,
    },
    Spool {
        budget: BackupBudget,
        expected_witness: Arc<BackupWitness>,
        final_path: PathBuf,
        step_delay_us: u64,
        reply: tokio::sync::oneshot::Sender<Result<SqliteSpoolSuccess, PortError>>,
    },
    Abort {
        reply: Option<tokio::sync::oneshot::Sender<()>>,
    },
}

struct SqliteBackupWorkerHandle {
    cmd_tx: Option<mpsc::SyncSender<SqliteWorkerCmd>>,
    cancel_flag: Arc<AtomicBool>,
    interrupt_handle: Arc<rusqlite::InterruptHandle>,
    join_handle: Option<std::thread::JoinHandle<()>>,
    tmp_path: PathBuf,
}

struct AbortBackupWatcher(tokio::task::AbortHandle);
impl Drop for AbortBackupWatcher {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Drop for SqliteBackupWorkerHandle {
    fn drop(&mut self) {
        self.cancel_flag.store(true, Ordering::Release);
        self.interrupt_handle.interrupt();
        self.cmd_tx.take();
    }
}

impl SqliteBackupWorkerHandle {
    fn spawn(
        src_path: PathBuf,
        tmp_path: PathBuf,
        finished: tokio::sync::oneshot::Sender<()>,
    ) -> Result<Self, PortError> {
        // Pre-create private `0600` destination file before opening SQLite on it.
        let pre_file = create_private_tmp_file(&tmp_path)?;
        drop(pre_file);

        let (init_tx, init_rx) =
            mpsc::sync_channel::<Result<rusqlite::InterruptHandle, PortError>>(1);
        let (cmd_tx, cmd_rx) = mpsc::sync_channel::<SqliteWorkerCmd>(2);
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let cancel_cl = Arc::clone(&cancel_flag);
        let tmp_cl = tmp_path.clone();

        let join_handle = std::thread::Builder::new()
            .name("notarium-sqlite-backup".to_owned())
            .spawn(move || {
                let _finished = finished;
                sqlite_backup_worker_loop(src_path, tmp_cl, cancel_cl, init_tx, cmd_rx);
            })
            .map_err(|err| {
                remove_tmp_artifacts_best_effort(&tmp_path);
                internal_not_committed("spawn_sqlite_backup_thread", err.to_string())
            })?;

        match init_rx.recv() {
            Ok(Ok(interrupt_handle)) => Ok(Self {
                cmd_tx: Some(cmd_tx),
                cancel_flag,
                interrupt_handle: Arc::new(interrupt_handle),
                join_handle: Some(join_handle),
                tmp_path,
            }),
            Ok(Err(err)) => {
                let _ = join_handle.join();
                remove_tmp_artifacts_best_effort(&tmp_path);
                Err(err)
            }
            Err(err) => {
                let _ = join_handle.join();
                remove_tmp_artifacts_best_effort(&tmp_path);
                Err(internal_not_committed(
                    "sqlite_backup_worker_init_eof",
                    err.to_string(),
                ))
            }
        }
    }

    async fn abort_and_join(&mut self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        self.interrupt_handle.interrupt();
        if let Some(tx) = self.cmd_tx.take() {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let _ = tx.try_send(SqliteWorkerCmd::Abort {
                reply: Some(reply_tx),
            });
            drop(tx);
            let _ = reply_rx.await;
        }
        if let Some(jh) = self.join_handle.take() {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = jh.join();
            })
            .await;
        }
        remove_tmp_artifacts_best_effort(&self.tmp_path);
    }

    fn detach_abort_cleanup(&mut self, inner: &CanonicalInner) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        self.interrupt_handle.interrupt();
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.try_send(SqliteWorkerCmd::Abort { reply: None });
            drop(tx);
        }
        let tmp = self.tmp_path.clone();
        if let Some(jh) = self.join_handle.take() {
            let handle = inner.backup_executor.spawn_blocking(move || {
                let _ = jh.join();
                remove_tmp_artifacts_best_effort(&tmp);
            });
            register_cleanup_task(inner, handle);
        }
    }
}

fn open_sqlite_backup_destination(path: &Path) -> Result<rusqlite::Connection, PortError> {
    let dst = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| internal_not_committed("rusqlite_open_backup_dst", err.to_string()))?;
    dst.busy_timeout(Duration::from_millis(250))
        .map_err(|err| internal_not_committed("rusqlite_dst_busy_timeout", err.to_string()))?;
    dst.execute_batch(&format!(
            "PRAGMA fullfsync = ON; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON; PRAGMA cache_size = -{SQLITE_CACHE_KIB}; PRAGMA temp_store = MEMORY;"
        ))
        .map_err(|err| internal_not_committed("rusqlite_dst_pragmas", err.to_string()))?;
    Ok(dst)
}

const SQLITE_CUT_SCHEMA: &str = "SELECT schema_version, installation_id, manifest_checksum
    FROM schema_meta WHERE singleton_id = 1 AND epoch_version = 1 AND migration_state = 'ready'";
const SQLITE_CUT_HISTORIES: &str =
    "SELECT space_id, history_incarnation, last_seq FROM spaces ORDER BY space_id ASC";
const SQLITE_CUT_RETIREMENTS: &str =
    "SELECT EXISTS (SELECT 1 FROM blob_retirements WHERE status = 'pending')";

fn warm_sqlite_backup_schema(
    conn: &rusqlite::Connection,
    queries: &[&str],
) -> rusqlite::Result<()> {
    let timeout_ms: u32 = conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
    conn.busy_timeout(Duration::ZERO)?;
    // Schema warming is optional. The cut performs the authoritative reads.
    let _ = conn.query_row("SELECT 1 FROM main.sqlite_schema LIMIT 1", [], |_| Ok(()));
    // Compile the queries before pausing writers. The cut executes them in
    // its own transaction, including after a schema change.
    for query in queries {
        let _ = conn.prepare_cached(query);
    }
    conn.busy_timeout(Duration::from_millis(u64::from(timeout_ms)))
}

fn sqlite_backup_worker_loop(
    src_path: PathBuf,
    tmp_path: PathBuf,
    cancel_flag: Arc<AtomicBool>,
    init_tx: mpsc::SyncSender<Result<rusqlite::InterruptHandle, PortError>>,
    cmd_rx: mpsc::Receiver<SqliteWorkerCmd>,
) {
    let open_res = (|| -> Result<_, PortError> {
        let read_only =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let src = rusqlite::Connection::open_with_flags(&src_path, read_only)
            .map_err(|err| internal_not_committed("rusqlite_open_backup_src", err.to_string()))?;
        src.busy_timeout(Duration::from_millis(250))
            .map_err(|err| internal_not_committed("rusqlite_src_busy_timeout", err.to_string()))?;
        src.execute_batch(&format!(
            "PRAGMA query_only = ON; PRAGMA cache_size = -{SQLITE_CACHE_KIB}; PRAGMA temp_store = MEMORY;"
        ))
        .map_err(|err| internal_not_committed("rusqlite_src_pragmas", err.to_string()))?;

        let dst = open_sqlite_backup_destination(&tmp_path)?;

        // SQLite requires the WAL-status query to run outside the pinned transaction.
        let observer =
            rusqlite::Connection::open_with_flags(&src_path, read_only).map_err(|err| {
                internal_not_committed("rusqlite_open_backup_wal_observer", err.to_string())
            })?;
        let queries = [
            SQLITE_CUT_SCHEMA,
            SQLITE_CUT_HISTORIES,
            SQLITE_CUT_RETIREMENTS,
        ];
        for (conn, queries) in [(&src, queries.as_slice()), (&observer, &[])] {
            warm_sqlite_backup_schema(conn, queries).map_err(|err| {
                internal_not_committed("sqlite_backup_warm_schema", err.to_string())
            })?;
        }
        Ok((src, dst, observer))
    })();

    let (src, dst, observer) = match open_res {
        Ok(pair) => {
            let handle = pair.0.get_interrupt_handle();
            if init_tx.send(Ok(handle)).is_err() {
                drop(pair);
                remove_tmp_artifacts_best_effort(&tmp_path);
                return;
            }
            pair
        }
        Err(err) => {
            let _ = init_tx.send(Err(err));
            remove_tmp_artifacts_best_effort(&tmp_path);
            return;
        }
    };

    let mut src_opt = Some(src);
    let mut dst_opt = Some(dst);
    let mut pinned = false;
    let mut published = false;

    let mut pin: Option<(BackupWalPinGuard, Instant, Duration, Cancellation)> = None;
    loop {
        let cmd = if let Some((guard, start, lifetime, shutdown)) = &pin {
            if shutdown.is_cancelled()
                || start.elapsed() >= *lifetime
                || guard.is_aborted_by_coordinator()
            {
                break;
            }
            match cmd_rx.recv_timeout(
                Duration::from_millis(5).min(lifetime.saturating_sub(start.elapsed())),
            ) {
                Ok(cmd) => cmd,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match cmd_rx.recv() {
                Ok(cmd) => cmd,
                Err(_) => break,
            }
        };
        match cmd {
            SqliteWorkerCmd::OpenCut {
                wal_pin,
                remaining,
                shutdown,
                expected_installation,
                reply,
            } => {
                let res = if let Some(src_conn) = src_opt.as_ref() {
                    match pin_and_read_sqlite_witness(src_conn, &expected_installation).and_then(
                        |witness| {
                            wal_pin.mark_cut(&observer)?;
                            Ok(witness)
                        },
                    ) {
                        Ok(w) => {
                            pinned = true;
                            pin = Some((wal_pin, Instant::now(), remaining, shutdown));
                            Ok(w)
                        }
                        Err(err) => {
                            let _ = src_conn.execute_batch("ROLLBACK;");
                            Err(err)
                        }
                    }
                } else {
                    Err(internal_not_committed(
                        "sqlite_backup_src_gone",
                        "source connection already closed",
                    ))
                };
                let ok = res.is_ok();
                let _ = reply.send(res);
                if !ok {
                    break;
                }
            }
            SqliteWorkerCmd::Spool {
                budget,
                expected_witness,
                final_path,
                step_delay_us,
                reply,
            } => {
                let Some((wal_pin, _, _, _)) = pin.take() else {
                    let _ = reply
                        .send(Err(
                            DomainError::validation(ValidationReason::InvalidState).into()
                        ));
                    break;
                };
                let res = run_sqlite_spool_on_owner_thread(
                    &mut src_opt,
                    &mut dst_opt,
                    &mut pinned,
                    &observer,
                    wal_pin,
                    budget,
                    &cancel_flag,
                    &expected_witness,
                    &tmp_path,
                    &final_path,
                    step_delay_us,
                );
                if res.is_ok() {
                    published = true;
                }
                if reply.send(res).is_err() && published {
                    let _ = fs::remove_file(&final_path);
                }
                break;
            }
            SqliteWorkerCmd::Abort { reply } => {
                if let Some(src_conn) = src_opt.take() {
                    if pinned {
                        let _ = src_conn.execute_batch("ROLLBACK;");
                    }
                    let _ = src_conn.close();
                }
                if let Some(dst_conn) = dst_opt.take() {
                    let _ = dst_conn.close();
                }
                remove_tmp_artifacts_best_effort(&tmp_path);
                if let Some(r) = reply {
                    let _ = r.send(());
                }
                return;
            }
        }
    }

    if let Some(src_conn) = src_opt.take() {
        if pinned {
            let _ = src_conn.execute_batch("ROLLBACK;");
        }
        let _ = src_conn.close();
    }
    if let Some(dst_conn) = dst_opt.take() {
        let _ = dst_conn.close();
    }
    if !published {
        remove_tmp_artifacts_best_effort(&tmp_path);
    }
}

fn pin_and_read_sqlite_witness(
    src: &rusqlite::Connection,
    expected_installation: &InstallationId,
) -> Result<BackupWitness, PortError> {
    src.execute_batch("BEGIN DEFERRED;")
        .map_err(|err| internal_not_committed("sqlite_backup_begin", err.to_string()))?;

    let witness = read_and_verify_sqlite_conn_witness(src, expected_installation)?;
    let pending: bool = src
        .prepare_cached(SQLITE_CUT_RETIREMENTS)
        .and_then(|mut stmt| stmt.query_row([], |row| row.get(0)))
        .map_err(|err| internal_not_committed("sqlite_backup_pin_retirements", err.to_string()))?;
    if pending {
        return Err(pending_retirement_at_cut());
    }
    Ok(witness)
}

fn pending_retirement_at_cut() -> PortError {
    unavailable_retryable(
        "backup_cut_pending_retirement",
        "a CAS retirement is pending in the backup snapshot",
        Duration::from_millis(100),
    )
}

fn read_and_verify_sqlite_conn_witness(
    conn: &rusqlite::Connection,
    expected_installation: &InstallationId,
) -> Result<BackupWitness, PortError> {
    let (schema_version, installation_raw, checksum_bytes): (i64, String, Vec<u8>) = conn
        .prepare_cached(SQLITE_CUT_SCHEMA)
        .and_then(|mut stmt| stmt.query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))))
        .map_err(|err| internal_not_committed("sqlite_backup_read_schema_meta", err.to_string()))?;

    if schema_version != i64::from(CANONICAL_SCHEMA_VERSION) {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if installation_raw != expected_installation.as_str() {
        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
    }
    if checksum_bytes.as_slice() != manifest_checksum().as_bytes().as_slice() {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }

    let mut stmt = conn
        .prepare_cached(SQLITE_CUT_HISTORIES)
        .map_err(|err| internal_not_committed("sqlite_backup_prepare_spaces", err.to_string()))?;

    let mut rows = stmt
        .query([])
        .map_err(|err| internal_not_committed("sqlite_backup_query_spaces", err.to_string()))?;

    let mut histories = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| internal_not_committed("sqlite_backup_next_space", err.to_string()))?
    {
        let sid_raw: String = row
            .get(0)
            .map_err(|err| internal_not_committed("sqlite_backup_space_id", err.to_string()))?;
        let inc_bytes: Vec<u8> = row
            .get(1)
            .map_err(|err| internal_not_committed("sqlite_backup_space_inc", err.to_string()))?;
        let last_seq_i64: i64 = row
            .get(2)
            .map_err(|err| internal_not_committed("sqlite_backup_space_seq", err.to_string()))?;

        let space_id = SpaceId::parse(&sid_raw).map_err(|_| {
            internal_not_committed("corrupt_backup_space_id", "invalid SpaceId in spaces")
        })?;
        let inc_arr: [u8; 16] = inc_bytes.try_into().map_err(|_| {
            internal_not_committed("corrupt_backup_inc", "history_incarnation != 16B")
        })?;
        let after = i64_to_space_seq(last_seq_i64)?;
        histories.push(ChangeCursor {
            scope: HistoryScope {
                space_id,
                incarnation: HistoryIncarnation::from_bytes(inc_arr),
            },
            after,
        });
    }

    Ok(BackupWitness {
        installation: expected_installation.clone(),
        schema_version: CANONICAL_SCHEMA_VERSION,
        histories,
        canaries: Vec::new(),
    })
}

#[allow(clippy::too_many_arguments)]
fn run_sqlite_spool_on_owner_thread(
    src_opt: &mut Option<rusqlite::Connection>,
    dst_opt: &mut Option<rusqlite::Connection>,
    pinned: &mut bool,
    observer: &rusqlite::Connection,
    wal_pin: BackupWalPinGuard,
    budget: BackupBudget,
    cancel_flag: &Arc<AtomicBool>,
    expected_witness: &BackupWitness,
    tmp_path: &Path,
    final_path: &Path,
    step_delay_us: u64,
) -> Result<SqliteSpoolSuccess, PortError> {
    if !*pinned {
        return Err(internal_not_committed(
            "sqlite_backup_not_pinned",
            "spool called before open_cut pinned source snapshot",
        ));
    }

    let started = Instant::now();
    let mut step_count = 0u64;
    let mut src_page_size = 4096u64;

    let src = src_opt.take().ok_or_else(|| {
        internal_not_committed("sqlite_backup_missing_src", "missing source connection")
    })?;
    *pinned = false;
    let step_res: Result<(), PortError> = (|| {
        if let Ok(ps) = src.query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0))
            && ps >= 512
        {
            src_page_size = ps as u64;
        }
        let dst = dst_opt.as_mut().ok_or_else(|| {
            internal_not_committed(
                "sqlite_backup_missing_dst",
                "missing destination connection",
            )
        })?;

        let backup = rusqlite::backup::Backup::new(&src, dst)
            .map_err(|err| internal_not_committed("rusqlite_backup_init", err.to_string()))?;

        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(cancelled_not_committed(
                    "sqlite_backup_cancelled",
                    "SQLite backup spool cancelled",
                ));
            }
            if wal_pin.is_aborted_by_coordinator() {
                return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
            }

            let disk_bytes = fs::metadata(tmp_path).map(|m| m.len()).unwrap_or(0);
            let progress_info = backup.progress();
            let copied_pages = (progress_info.pagecount - progress_info.remaining).max(0) as u64;
            let est_bytes = disk_bytes.max(copied_pages.saturating_mul(src_page_size));
            budget.check(BackupProgress {
                elapsed: started.elapsed(),
                retention: BackupRetentionProgress::SqliteWal {
                    pinned_bytes: wal_pin.current_pinned_wal_bytes(observer)?,
                },
                spool_bytes: est_bytes,
            })?;

            if step_delay_us > 0 {
                sleep_interruptible(
                    Duration::from_micros(step_delay_us),
                    started,
                    budget.deadline,
                    cancel_flag,
                    &wal_pin,
                )?;
            }

            match backup.step(SQLITE_BACKUP_PAGES_PER_STEP) {
                Ok(rusqlite::backup::StepResult::Done) => {
                    step_count += 1;
                    break;
                }
                Ok(rusqlite::backup::StepResult::More) => {
                    step_count += 1;
                }
                Ok(rusqlite::backup::StepResult::Busy)
                | Ok(rusqlite::backup::StepResult::Locked) => {
                    sleep_interruptible(
                        Duration::from_millis(2),
                        started,
                        budget.deadline,
                        cancel_flag,
                        &wal_pin,
                    )?;
                }
                Ok(_) => {
                    sleep_interruptible(
                        Duration::from_millis(1),
                        started,
                        budget.deadline,
                        cancel_flag,
                        &wal_pin,
                    )?;
                }
                Err(rusqlite::Error::SqliteFailure(err, _))
                    if err.code == rusqlite::ErrorCode::OperationInterrupted =>
                {
                    return Err(cancelled_not_committed(
                        "sqlite_backup_interrupted",
                        "SQLite backup interrupted",
                    ));
                }
                Err(rusqlite::Error::SqliteFailure(err, _))
                    if matches!(
                        err.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) =>
                {
                    sleep_interruptible(
                        Duration::from_millis(2),
                        started,
                        budget.deadline,
                        cancel_flag,
                        &wal_pin,
                    )?;
                }
                Err(err) => {
                    return Err(internal_not_committed(
                        "rusqlite_backup_step",
                        err.to_string(),
                    ));
                }
            }
        }
        Ok(())
    })();

    if let Err(err) = step_res {
        if let Some(dst_conn) = dst_opt.take() {
            let _ = dst_conn.close();
        }
        remove_tmp_artifacts_best_effort(tmp_path);
        return Err(err);
    }

    // Verify destination witness and integrity before closing `dst`.
    let verify_res: Result<(), PortError> = (|| {
        let dst = dst_opt.take().ok_or_else(|| {
            internal_not_committed("sqlite_backup_dst_gone", "destination connection missing")
        })?;
        let abort = Arc::clone(&wal_pin.abort_flag);
        let cancelled = Arc::clone(cancel_flag);
        dst.progress_handler(
            1000,
            Some(move || {
                cancelled.load(Ordering::Acquire)
                    || abort.load(Ordering::Acquire)
                    || started.elapsed() > budget.deadline
            }),
        )
        .map_err(|err| internal_not_committed("sqlite_verify_progress", err.to_string()))?;
        // Holds protect source CAS objects until the backup owner releases them.
        // Normalize the private copy before hashing and publishing its single database file.
        dst.execute_batch("PRAGMA journal_mode = DELETE; DELETE FROM backup_holds;")
            .map_err(|err| {
                internal_not_committed("sqlite_backup_clear_source_holds", err.to_string())
            })?;
        let dst_witness =
            read_and_verify_sqlite_conn_witness(&dst, &expected_witness.installation)?;
        if !witnesses_equal(&dst_witness, expected_witness) {
            let _ = dst.close();
            return Err(internal_not_committed(
                "sqlite_backup_witness_mismatch",
                "destination snapshot witness diverged from pinned cut witness",
            ));
        }
        let quick_ok: String = dst
            .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
            .map_err(|err| internal_not_committed("sqlite_backup_quick_check", err.to_string()))?;
        dst.close().map_err(|(_, err)| {
            internal_not_committed("sqlite_backup_close_dst", err.to_string())
        })?;
        if quick_ok != "ok" {
            return Err(internal_not_committed(
                "sqlite_backup_corrupt_dst",
                format!("PRAGMA quick_check failed: {quick_ok}"),
            ));
        }
        Ok(())
    })();

    if let Err(err) = verify_res {
        remove_tmp_artifacts_best_effort(tmp_path);
        if cancel_flag.load(Ordering::Acquire) {
            return Err(cancelled_not_committed(
                "backup_verification_cancelled",
                "SQLite backup cancelled",
            ));
        }
        if wal_pin.is_aborted_by_coordinator() || started.elapsed() >= budget.deadline {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        return Err(err);
    }

    // Check final file size against budget, stream BLAKE3 with a bounded 64 KiB buffer, fsync, atomic rename.
    let final_meta = fs::metadata(tmp_path)
        .map_err(|err| internal_not_committed("sqlite_backup_stat_tmp", err.to_string()))?;
    let total_bytes = final_meta.len();
    budget.check(BackupProgress {
        elapsed: started.elapsed(),
        retention: BackupRetentionProgress::SqliteWal {
            pinned_bytes: wal_pin.current_pinned_wal_bytes(observer)?,
        },
        spool_bytes: total_bytes,
    })?;

    let digest = match stream_file_blake3_and_sync(
        tmp_path,
        cancel_flag,
        &wal_pin,
        started,
        budget.deadline,
    ) {
        Ok(d) => d,
        Err(err) => {
            remove_tmp_artifacts_best_effort(tmp_path);
            return Err(err);
        }
    };

    budget.check(BackupProgress {
        elapsed: started.elapsed(),
        retention: BackupRetentionProgress::SqliteWal {
            pinned_bytes: wal_pin.current_pinned_wal_bytes(observer)?,
        },
        spool_bytes: total_bytes,
    })?;
    if let Err(err) = fs::rename(tmp_path, final_path) {
        remove_tmp_artifacts_best_effort(tmp_path);
        return Err(internal_not_committed(
            "sqlite_backup_publish_rename",
            err.to_string(),
        ));
    }
    fsync_parent_dir(final_path)?;
    // Release the source after the verified destination and its directory are durable.
    drop(src);
    drop(wal_pin);

    let page_step_bytes = (SQLITE_BACKUP_PAGES_PER_STEP as usize) * (src_page_size as usize);
    let working_bytes = STREAM_IO_BUF_BYTES + 2 * (SQLITE_CACHE_KIB as usize) * 1024;

    Ok(SqliteSpoolSuccess {
        bytes: total_bytes,
        digest,
        stats: BackupExporterMemoryStats {
            encoding: BackupArtifactEncoding::SqliteSnapshotV1,
            max_chunk_buffer_bytes: page_step_bytes.max(STREAM_IO_BUF_BYTES),
            max_working_buffer_bytes: working_bytes,
            total_bytes_written: total_bytes,
            step_or_slice_count: step_count,
        },
    })
}

fn sleep_interruptible(
    total: Duration,
    started: Instant,
    deadline: Duration,
    cancel_flag: &AtomicBool,
    wal_pin: &BackupWalPinGuard,
) -> Result<(), PortError> {
    let target = Instant::now() + total;
    while Instant::now() < target {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_not_committed(
                "sqlite_backup_cancelled",
                "SQLite backup cancelled",
            ));
        }
        if wal_pin.is_aborted_by_coordinator() {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        if started.elapsed() > deadline {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        let rem = target.saturating_duration_since(Instant::now());
        std::thread::sleep(rem.min(Duration::from_millis(5)));
    }
    Ok(())
}

fn stream_file_blake3_and_sync(
    path: &Path,
    cancel_flag: &AtomicBool,
    wal_pin: &BackupWalPinGuard,
    started: Instant,
    deadline: Duration,
) -> Result<ContentDigest, PortError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|err| internal_not_committed("open_backup_for_hash_sync", err.to_string()))?;
    file.sync_all()
        .map_err(|err| internal_not_committed("fsync_backup_tmp", err.to_string()))?;

    let mut reader = BufReader::with_capacity(STREAM_IO_BUF_BYTES, file);
    let mut buf = vec![0u8; STREAM_IO_BUF_BYTES];
    let mut hasher = blake3::Hasher::new();
    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_not_committed(
                "backup_hash_cancelled",
                "backup hashing cancelled",
            ));
        }
        if wal_pin.is_aborted_by_coordinator() || started.elapsed() >= deadline {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        let n = reader
            .read(&mut buf)
            .map_err(|err| internal_not_committed("read_backup_for_hash", err.to_string()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(ContentDigest::from_bytes(*hasher.finalize().as_bytes()))
}

fn witnesses_equal(a: &BackupWitness, b: &BackupWitness) -> bool {
    a.installation == b.installation
        && a.histories == b.histories
        && a.canaries.len() == b.canaries.len()
}

// ============================================================================
// PostgreSQL prepared / pinned connection state (`PostgresSpoolV1`)
// ============================================================================

async fn open_backup_connection(store: &CanonicalStore) -> Result<PgConnection, PortError> {
    let SqlBackendConfig::Postgres {
        connect, schema, ..
    } = &store.inner.config.sql
    else {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    };
    let options = crate::dialect::postgres::build_pg_connect_options(connect);
    let mut conn =
        crate::dialect::postgres::on_store_executor(&store.inner.backup_executor, async move {
            PgConnection::connect_with(&options).await
        })
        .await
        .map_err(|err| internal_not_committed("pg_backup_connect", err.to_string()))?;
    sqlx::query("SELECT set_config('search_path', quote_ident($1), false)")
        .bind(schema)
        .execute(&mut conn)
        .await
        .map_err(|err| internal_not_committed("pg_backup_schema", err.to_string()))?;
    Ok(conn)
}

struct PgPreparedSource {
    source: Option<PgConnection>,
    store: CanonicalStore,
    backend_pid: i32,
    barrier: Option<PgConnection>,
    pinned_at: Option<Instant>,
    tmp_path: PathBuf,
}

impl Drop for PgPreparedSource {
    fn drop(&mut self) {
        // Dedicated sockets never return a cancelled transaction to a caller's pool.
        remove_tmp_artifacts_best_effort(&self.tmp_path);
    }
}

impl PgPreparedSource {
    async fn abort_cleanly(&mut self) {
        if let Some(mut conn) = self.source.take() {
            let _ = sqlx::raw_sql("ROLLBACK").execute(&mut conn).await;
            let _ = conn.close().await;
        }
    }

    async fn cancel_and_close(&mut self) {
        if self.source.is_some()
            && let Ok(Ok(mut cancel)) =
                tokio::time::timeout(Duration::from_secs(1), open_backup_connection(&self.store))
                    .await
        {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                sqlx::query("SELECT pg_cancel_backend($1)")
                    .bind(self.backend_pid)
                    .execute(&mut cancel),
            )
            .await;
        }
        self.abort_cleanly().await;
    }

    fn detach_abort_cleanup(&mut self, inner: &CanonicalInner) {
        let connections = [self.source.take(), self.barrier.take()];
        if connections.iter().any(Option::is_some) {
            register_cleanup_task(
                inner,
                inner.backup_executor.spawn(async move {
                    for conn in connections.into_iter().flatten() {
                        let _ = conn.close().await;
                    }
                }),
            );
        }
    }
}

const PG_BACKUP_BARRIER_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 7311229)) WHERE $1";

async fn warm_pg_backup_barrier(
    conn: &mut PgConnection,
    remaining: Duration,
) -> Result<(), PortError> {
    let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128);
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "SET plan_cache_mode TO force_generic_plan;
         SET statement_timeout = {timeout_ms};
         SET idle_in_transaction_session_timeout = {timeout_ms}"
    )))
    .execute(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_backup_configure_barrier", err.to_string()))?;
    // The false predicate prepares and plans the statement without taking the
    // writer lock. Only pause_writes executes its true predicate.
    sqlx::query(PG_BACKUP_BARRIER_SQL)
        .bind(false)
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_backup_warm_barrier", err.to_string()))?;
    sqlx::raw_sql("BEGIN")
        .execute(conn)
        .await
        .map_err(|err| internal_not_committed("pg_backup_begin_barrier", err.to_string()))?;
    Ok(())
}

const PG_PIN_WITNESS_SQL: &str =
    "SELECT 0::int2 AS kind, schema_version::bigint AS num_col, installation_id AS id_col,
            manifest_checksum AS bytes_col,
            set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)
     FROM schema_meta
     WHERE singleton_id = 1 AND epoch_version = 1 AND migration_state = 'ready'
     UNION ALL
     SELECT 1::int2, last_seq, space_id, history_incarnation, NULL, NULL FROM spaces
     UNION ALL
     SELECT 2::int2, NULL, NULL, NULL, NULL, NULL
     WHERE EXISTS (SELECT 1 FROM blob_retirements WHERE status = 'pending')
     ORDER BY kind, id_col";

async fn warm_pg_backup_connection(
    conn: &mut PgConnection,
    remaining: Duration,
    max_age: Duration,
) -> Result<i32, PortError> {
    let idle_ms = remaining.as_millis().clamp(1, i32::MAX as u128);
    let statement_ms = remaining
        .min(max_age)
        .as_millis()
        .clamp(1, i32::MAX as u128);
    let pid = sqlx::query_scalar(
        "SELECT pg_backend_pid(), set_config('plan_cache_mode', 'force_generic_plan', false)",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_backup_backend_pid", err.to_string()))?;
    // Use the same binary prepared statement on this socket for the pin. Its
    // autocommit snapshot and transaction-local settings end before BEGIN.
    sqlx::query(PG_PIN_WITNESS_SQL)
        .bind(format!("{idle_ms}ms"))
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_backup_warm_stmt", err.to_string()))?;
    // Before pin the idle transaction is bounded by the overall deadline. The
    // first data query restricts its subsequent idle time to the snapshot budget.
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "SET statement_timeout = {statement_ms};
         SET idle_in_transaction_session_timeout = {idle_ms};
         BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    )))
    .execute(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_backup_begin", err.to_string()))?;
    Ok(pid)
}

async fn pin_and_read_pg_witness(
    conn: &mut PgConnection,
    expected_installation: &InstallationId,
    remaining: Duration,
) -> Result<BackupWitness, PortError> {
    use futures_util::TryStreamExt;

    let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128);
    let mut rows = sqlx::query(PG_PIN_WITNESS_SQL)
        .bind(format!("{timeout_ms}ms"))
        .fetch(conn);
    let read_error =
        |err: sqlx::Error| internal_not_committed("pg_backup_pin_witness", err.to_string());
    let meta = rows.try_next().await.map_err(read_error)?.ok_or_else(|| {
        internal_not_committed("pg_backup_read_schema_meta", "missing schema_meta row")
    })?;
    if meta.try_get::<i16, _>(0).map_err(read_error)? != 0
        || meta.try_get::<i64, _>(1).map_err(read_error)? != i64::from(CANONICAL_SCHEMA_VERSION)
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if meta.try_get::<&str, _>(2).map_err(read_error)? != expected_installation.as_str() {
        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
    }
    if meta.try_get::<&[u8], _>(3).map_err(read_error)? != manifest_checksum().as_bytes() {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }

    let mut histories = Vec::new();
    while let Some(row) = rows.try_next().await.map_err(read_error)? {
        if row.try_get::<i16, _>(0).map_err(read_error)? == 2 {
            return Err(pending_retirement_at_cut());
        }
        let after = i64_to_space_seq(row.try_get(1).map_err(read_error)?)?;
        let space_id = SpaceId::parse(row.try_get(2).map_err(read_error)?).map_err(|_| {
            internal_not_committed("corrupt_pg_backup_space_id", "invalid SpaceId in spaces")
        })?;
        let incarnation = row
            .try_get::<&[u8], _>(3)
            .map_err(read_error)?
            .try_into()
            .map_err(|_| {
                internal_not_committed("corrupt_pg_backup_inc", "history_incarnation != 16B")
            })?;
        histories.push(ChangeCursor {
            scope: HistoryScope {
                space_id,
                incarnation: HistoryIncarnation::from_bytes(incarnation),
            },
            after,
        });
    }
    Ok(BackupWitness {
        installation: expected_installation.clone(),
        schema_version: CANONICAL_SCHEMA_VERSION,
        histories,
        canaries: Vec::new(),
    })
}

struct HashingSpoolWriter {
    writer: BufWriter<File>,
    body_hasher: blake3::Hasher,
    whole_hasher: blake3::Hasher,
    bytes_written: u64,
    started: Instant,
    budget: BackupBudget,
}

impl HashingSpoolWriter {
    fn new(file: File, started: Instant, budget: BackupBudget) -> Self {
        Self {
            writer: BufWriter::with_capacity(STREAM_IO_BUF_BYTES, file),
            body_hasher: blake3::Hasher::new(),
            whole_hasher: blake3::Hasher::new(),
            bytes_written: 0,
            started,
            budget,
        }
    }

    fn write_body(&mut self, bytes: &[u8]) -> Result<(), PortError> {
        let next_bytes = self.bytes_written.saturating_add(bytes.len() as u64);
        self.budget.check(BackupProgress {
            elapsed: self.started.elapsed(),
            retention: BackupRetentionProgress::PostgresSnapshot {
                age: self.started.elapsed(),
            },
            spool_bytes: next_bytes,
        })?;
        self.writer
            .write_all(bytes)
            .map_err(|err| internal_not_committed("pg_spool_write", err.to_string()))?;
        self.body_hasher.update(bytes);
        self.whole_hasher.update(bytes);
        self.bytes_written = next_bytes;
        Ok(())
    }

    fn finish_trailer_and_into_file(mut self) -> Result<(File, u64, ContentDigest), PortError> {
        let body_digest = *self.body_hasher.finalize().as_bytes();
        let next_bytes = self.bytes_written.saturating_add(32);
        self.budget.check(BackupProgress {
            elapsed: self.started.elapsed(),
            retention: BackupRetentionProgress::PostgresSnapshot {
                age: self.started.elapsed(),
            },
            spool_bytes: next_bytes,
        })?;
        self.writer
            .write_all(&body_digest)
            .map_err(|err| internal_not_committed("pg_spool_write_trailer", err.to_string()))?;
        self.whole_hasher.update(&body_digest);
        self.bytes_written = next_bytes;
        self.writer
            .flush()
            .map_err(|err| internal_not_committed("pg_spool_flush", err.to_string()))?;
        let file = self.writer.into_inner().map_err(|err| {
            internal_not_committed("pg_spool_into_inner", err.error().to_string())
        })?;
        let whole_digest = ContentDigest::from_bytes(*self.whole_hasher.finalize().as_bytes());
        Ok((file, self.bytes_written, whole_digest))
    }
}

async fn run_pg_query_bounded<F, T>(
    started: Instant,
    budget: BackupBudget,
    cancellation: &Cancellation,
    fut: F,
) -> Result<T, PortError>
where
    F: std::future::Future<Output = Result<T, sqlx::Error>>,
{
    if cancellation.is_cancelled() {
        return Err(cancelled_not_committed(
            "pg_backup_cancelled",
            "PostgreSQL backup spool cancelled",
        ));
    }
    let elapsed = started.elapsed();
    if elapsed > budget.deadline {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
    let rem = budget.deadline.saturating_sub(elapsed);
    if rem.is_zero() {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
    let result = tokio::select! {
        result = tokio::time::timeout(rem, fut) => result,
        () = cancellation.cancelled() => return Err(cancelled_not_committed("pg_backup_cancelled", "PostgreSQL backup spool cancelled")),
    };
    match result {
        Ok(Ok(v)) => {
            if cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "pg_backup_cancelled",
                    "PostgreSQL backup spool cancelled",
                ));
            }
            Ok(v)
        }
        Ok(Err(err)) => {
            if cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "pg_backup_cancelled",
                    "PostgreSQL backup spool cancelled",
                ));
            }
            // Query canceled due to statement_timeout maps cleanly to BudgetExceeded.
            if let Some(db_err) = err.as_database_error()
                && db_err.code().as_deref() == Some("57014")
            {
                return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
            }
            Err(internal_not_committed("pg_backup_query", err.to_string()))
        }
        Err(_) => Err(DomainError::validation(ValidationReason::BudgetExceeded).into()),
    }
}

async fn stream_postgres_spool_v1(
    pg: &mut PgPreparedSource,
    witness: &BackupWitness,
    mut budget: BackupBudget,
    cancellation: &Cancellation,
    final_path: &Path,
    step_delay_us: u64,
) -> Result<(u64, ContentDigest, BackupExporterMemoryStats), PortError> {
    let started = pg
        .pinned_at
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
    let BackupRetentionBudget::PostgresSnapshot { max_age } = budget.retention else {
        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
    };
    // The spool deadline is the remaining overall time. Queries and writes use
    // the earlier of that deadline and the retention limit measured from pin.
    budget.deadline = budget
        .deadline
        .saturating_add(started.elapsed())
        .min(max_age);

    let timeout_ms = u64::try_from(budget.deadline.as_millis().max(1)).unwrap_or(30_000);

    let tmp_file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&pg.tmp_path)
        .map_err(|err| internal_not_committed("open_pg_spool_tmp", err.to_string()))?;

    let mut spool_writer = HashingSpoolWriter::new(tmp_file, started, budget);
    let mut max_slice_seen = 0usize;
    let mut slice_or_row_ops = 0u64;

    let stream_res: Result<(File, u64, ContentDigest), PortError> = async {
        let conn = pg.source.as_mut().ok_or_else(|| {
            internal_not_committed("pg_backup_conn_missing", "PostgreSQL pinned connection missing")
        })?;

        run_pg_query_bounded(
            started,
            budget,
            cancellation,
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "RESET plan_cache_mode; SET LOCAL statement_timeout = {timeout_ms}"
            )))
            .execute(&mut *conn),
        )
        .await?;

        // Header: magic + schema_version + manifest_checksum + witness_msgpack + table_count
        spool_writer.write_body(POSTGRES_SPOOL_V1_MAGIC)?;
        spool_writer.write_body(&CANONICAL_SCHEMA_VERSION.to_be_bytes())?;
        spool_writer.write_body(manifest_checksum().as_bytes())?;

        let witness_bytes = encode_msgpack(witness)?;
        let witness_len = u32::try_from(witness_bytes.len()).map_err(|_| {
            internal_not_committed("pg_spool_witness_too_large", "witness > u32::MAX")
        })?;
        spool_writer.write_body(&witness_len.to_be_bytes())?;
        spool_writer.write_body(&witness_bytes)?;

        let table_count = u32::try_from(CANONICAL_TABLES.len()).expect("table count fits in u32");
        spool_writer.write_body(&table_count.to_be_bytes())?;

        for (t_idx, table) in CANONICAL_TABLES.iter().enumerate() {
            let name_bytes = table.name.as_bytes();
            let name_len = u16::try_from(name_bytes.len()).expect("table name fits in u16");
            spool_writer.write_body(&name_len.to_be_bytes())?;
            spool_writer.write_body(name_bytes)?;

            let col_count = u16::try_from(table.columns.len()).expect("col count fits in u16");
            spool_writer.write_body(&col_count.to_be_bytes())?;

            if table.name == "backup_holds" {
                // V1 requires every table frame. Source-local holds have no owner on restore.
                spool_writer.write_body(&[0])?;
                spool_writer.write_body(&0u64.to_be_bytes())?;
                continue;
            }

            let pk_order = table
                .primary_key
                .iter()
                .map(|pk| format!("\"{pk}\" ASC"))
                .collect::<Vec<_>>()
                .join(", ");
            let cursor_name = format!("backup_cur_{t_idx}");
            let declare_sql = format!(
                "DECLARE {cursor_name} NO SCROLL CURSOR FOR SELECT ctid::text FROM \"{}\" ORDER BY {pk_order}",
                table.name
            );
            let fetch_sql = format!("FETCH 1 FROM {cursor_name}");
            let close_sql = format!("CLOSE {cursor_name}");

            let meta_projections = table
                .columns
                .iter()
                .enumerate()
                .map(|(c_idx, c)| match c.kind {
                    LogicalColKind::Int => format!("\"{}\"::BIGINT AS m{c_idx}", c.name),
                    LogicalColKind::Text => {
                        format!(
                            "octet_length(convert_to(\"{}\", 'UTF8'))::BIGINT AS m{c_idx}",
                            c.name
                        )
                    }
                    LogicalColKind::Bytes => {
                        format!("octet_length(\"{}\")::BIGINT AS m{c_idx}", c.name)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let meta_sql = format!(
                "SELECT {meta_projections} FROM \"{}\" WHERE ctid = $1::tid",
                table.name
            );

            run_pg_query_bounded(
                started,
                budget,
                cancellation,
                sqlx::query(sqlx::AssertSqlSafe(declare_sql))
                    .persistent(false)
                    .execute(&mut *conn),
            )
            .await?;

            let mut row_count = 0u64;
            loop {
                if step_delay_us > 0 {
                    sleep_async_interruptible(
                        Duration::from_micros(step_delay_us),
                        started,
                        budget.deadline,
                        cancellation,
                    )
                    .await?;
                }

                let ctid_opt: Option<String> = run_pg_query_bounded(
                    started,
                    budget,
                    cancellation,
                    sqlx::query_scalar(sqlx::AssertSqlSafe(fetch_sql.clone()))
                        .persistent(false)
                        .fetch_optional(&mut *conn),
                )
                .await?;

                let Some(ctid_str) = ctid_opt else {
                    break;
                };

                // Row frame present tag = 1 (`ctid` is NEVER written to the spool artifact!).
                spool_writer.write_body(&[1u8])?;
                row_count += 1;
                slice_or_row_ops += 1;

                let meta_row = run_pg_query_bounded(
                    started,
                    budget,
                    cancellation,
                    sqlx::query(sqlx::AssertSqlSafe(meta_sql.clone()))
                        .bind(&ctid_str)
                        .persistent(false)
                        .fetch_one(&mut *conn),
                )
                .await?;

                for (c_idx, col) in table.columns.iter().enumerate() {
                    let meta_val: Option<i64> = meta_row.try_get(c_idx).map_err(|err| {
                        internal_not_committed("pg_backup_meta_col", err.to_string())
                    })?;

                    match (meta_val, col.kind) {
                        (None, _) => {
                            if !col.nullable {
                                return Err(internal_not_committed(
                                    "pg_backup_unexpected_null",
                                    format!("unexpected NULL in {}.{}", table.name, col.name),
                                ));
                            }
                            spool_writer.write_body(&[0u8])?;
                        }
                        (Some(int_val), LogicalColKind::Int) => {
                            spool_writer.write_body(&[1u8])?;
                            spool_writer.write_body(&int_val.to_be_bytes())?;
                        }
                        (Some(byte_len_i64), LogicalColKind::Text | LogicalColKind::Bytes) => {
                            let total_len = u64::try_from(byte_len_i64).map_err(|_| {
                                internal_not_committed(
                                    "pg_backup_neg_octet_len",
                                    "negative octet_length",
                                )
                            })?;
                            spool_writer.write_body(&[1u8])?;
                            spool_writer.write_body(&total_len.to_be_bytes())?;

                            if total_len > 0 {
                                let slice_sql = match col.kind {
                                    LogicalColKind::Text => format!(
                                        "SELECT substring(convert_to(\"{}\", 'UTF8') FROM $2 FOR $3) FROM \"{}\" WHERE ctid = $1::tid",
                                        col.name, table.name
                                    ),
                                    LogicalColKind::Bytes => format!(
                                        "SELECT substring(\"{}\" FROM $2 FOR $3) FROM \"{}\" WHERE ctid = $1::tid",
                                        col.name, table.name
                                    ),
                                    LogicalColKind::Int => unreachable!(),
                                };

                                let mut offset = 0u64;
                                while offset < total_len {
                                    if step_delay_us > 0 {
                                        sleep_async_interruptible(
                                            Duration::from_micros(step_delay_us),
                                            started,
                                            budget.deadline,
                                            cancellation,
                                        )
                                        .await?;
                                    }
                                    let want_usize =
                                        ((total_len - offset).min(PG_SLICE_MAX_BYTES as u64))
                                            as usize;
                                    let start_1based =
                                        i32::try_from(offset + 1).map_err(|_| {
                                            internal_not_committed(
                                                "pg_slice_offset_overflow",
                                                "column exceeds 2 GiB PostgreSQL toast limit",
                                            )
                                        })?;
                                    let want_i32 = want_usize as i32;

                                    let slice: Vec<u8> = run_pg_query_bounded(
                                        started,
                                        budget,
                                        cancellation,
                                        sqlx::query_scalar(sqlx::AssertSqlSafe(slice_sql.clone()))
                                            .bind(&ctid_str)
                                            .bind(start_1based)
                                            .bind(want_i32)
                                            .persistent(false)
                                            .fetch_one(&mut *conn),
                                    )
                                    .await?;

                                    if slice.len() != want_usize {
                                        return Err(internal_not_committed(
                                            "pg_slice_len_mismatch",
                                            format!(
                                                "expected {want_usize}B slice for {}.{}, got {}B",
                                                table.name,
                                                col.name,
                                                slice.len()
                                            ),
                                        ));
                                    }
                                    max_slice_seen = max_slice_seen.max(slice.len());
                                    let chunk_u32 = slice.len() as u32;
                                    spool_writer.write_body(&chunk_u32.to_be_bytes())?;
                                    spool_writer.write_body(&slice)?;
                                    offset += slice.len() as u64;
                                    slice_or_row_ops += 1;
                                }
                            }
                        }
                    }
                }
            }

            // End-of-table row marker = 0 followed by verified row_count.
            spool_writer.write_body(&[0u8])?;
            spool_writer.write_body(&row_count.to_be_bytes())?;

            run_pg_query_bounded(
                started,
                budget,
                cancellation,
                sqlx::query(sqlx::AssertSqlSafe(close_sql))
                    .persistent(false)
                    .execute(&mut *conn),
            )
            .await?;
        }

        spool_writer.finish_trailer_and_into_file()
    }
    .await;

    let (file, total_bytes, whole_digest) = match stream_res {
        Ok(complete) => complete,
        Err(error) => {
            pg.cancel_and_close().await;
            return Err(error);
        }
    };
    if let Err(err) = file.sync_all() {
        drop(file);
        remove_tmp_artifacts_best_effort(&pg.tmp_path);
        return Err(internal_not_committed(
            "pg_spool_fsync_tmp",
            err.to_string(),
        ));
    }
    drop(file);

    if let Err(err) = fs::rename(&pg.tmp_path, final_path) {
        remove_tmp_artifacts_best_effort(&pg.tmp_path);
        return Err(internal_not_committed("pg_spool_rename", err.to_string()));
    }
    fsync_parent_dir(final_path)?;

    pg.abort_cleanly().await;

    let max_chunk = max_slice_seen.max(STREAM_IO_BUF_BYTES);
    let working_bytes = STREAM_IO_BUF_BYTES + PG_SLICE_MAX_BYTES;

    Ok((
        total_bytes,
        whole_digest,
        BackupExporterMemoryStats {
            encoding: BackupArtifactEncoding::PostgresSpoolV1,
            max_chunk_buffer_bytes: max_chunk,
            max_working_buffer_bytes: working_bytes,
            total_bytes_written: total_bytes,
            step_or_slice_count: slice_or_row_ops,
        },
    ))
}

async fn sleep_async_interruptible(
    total: Duration,
    started: Instant,
    deadline: Duration,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    let target = tokio::time::Instant::now() + total;
    while tokio::time::Instant::now() < target {
        if cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "pg_backup_cancelled",
                "PostgreSQL backup cancelled",
            ));
        }
        if started.elapsed() > deadline {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        let rem = target.saturating_duration_since(tokio::time::Instant::now());
        tokio::time::sleep(rem.min(Duration::from_millis(5))).await;
    }
    Ok(())
}

#[cfg(test)]
#[test]
fn historical_spool_shapes_match_their_published_manifests() {
    for version in [6, 7] {
        let observed = checksum_tables(version, spool_tables(version));
        assert!(crate::schema::migrate::recognized_predecessor(
            i64::from(version),
            observed.as_bytes()
        ));
    }
}

fn spool_tables(schema_version: u32) -> impl Iterator<Item = TableSpec> + Clone {
    CANONICAL_TABLES
        .iter()
        .copied()
        .filter_map(move |mut table| {
            if schema_version < 9 && table.name.starts_with("vault_") {
                return None;
            }
            if schema_version == 7 && table.name == "chat_entry_note_refs" {
                table.columns = &table.columns[..6];
                table.indexes = &["idx_chat_entry_note_refs_target"];
            }
            if schema_version < 7 {
                match table.name {
                    "projection_rank_anchors"
                    | "projection_rank_anchor_rows"
                    | "chat_entry_note_refs" => return None,
                    "folder_aliases" => table.indexes = &["idx_folder_aliases_lookup"],
                    "note_aliases" => {
                        table.indexes = &[
                            "idx_note_aliases_slug_lookup",
                            "idx_note_aliases_title_lookup",
                            "idx_note_aliases_target",
                        ];
                    }
                    "revisions" => {
                        table.indexes = &[
                            "idx_revisions_entity_vis_seq",
                            "idx_revisions_agent_run",
                            "idx_revisions_parent_rev",
                        ];
                    }
                    "chat_entries" => {
                        table.indexes = &["idx_chat_entries_parent", "idx_chat_entries_compaction"];
                    }
                    _ => {}
                }
            }
            if schema_version < 5 && table.name == "command_receipts" {
                table.indexes = &["idx_command_receipts_expires"];
            }
            if schema_version < 5 && table.name == "payload_owners" {
                table.primary_key = &["space_id", "payload_kind", "payload_id", "note_id"];
                table.indexes = &[];
            }
            if schema_version < 4 && table.name == "blob_references" {
                table.indexes = &["idx_blob_references_non_note_owner"];
            }
            if schema_version < 3 {
                match table.name {
                    "collab_checkpoints" => return None,
                    "backup_holds" => table.columns = &table.columns[..8],
                    _ => {}
                }
            }
            if schema_version == 1 {
                match table.name {
                    "account_catalog_receipts" => return None,
                    "chat_pending_inputs" => {
                        // Version 2 appended ext_space_tainted after consumed_entry_seq.
                        table.columns = &table.columns[..13];
                    }
                    _ => {}
                }
            }
            Some(table)
        })
}

/// Materializes a verified canonical spool for offline inspection within the default budget.
pub fn decode_postgres_spool_v1(path: &Path) -> Result<DecodedPostgresSpoolV1, PortError> {
    decode_postgres_spool_v1_bounded(
        path,
        crate::config::default_postgres_backup_budget().max_spool_bytes,
    )
}

/// Limits both the encoded file and the decoded table, row and variable-value allocations.
pub fn decode_postgres_spool_v1_bounded(
    path: &Path,
    max_bytes: u64,
) -> Result<DecodedPostgresSpoolV1, PortError> {
    let file = File::open(path)
        .map_err(|err| internal_not_committed("open_pg_spool_decode", err.to_string()))?;
    let total_file_len = file
        .metadata()
        .map_err(|err| internal_not_committed("stat_pg_spool_decode", err.to_string()))?
        .len();
    if total_file_len > max_bytes {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
    let mut remaining_capacity = max_bytes;
    let mut charge = |bytes: u64| -> Result<(), PortError> {
        remaining_capacity = remaining_capacity
            .checked_sub(bytes)
            .ok_or_else(|| DomainError::validation(ValidationReason::BudgetExceeded))?;
        Ok(())
    };
    if total_file_len < (POSTGRES_SPOOL_V1_MAGIC.len() as u64 + 4 + 32 + 4 + 4 + 32) {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    let body_limit = total_file_len - 32;

    struct HashingReader<R> {
        inner: R,
        hasher: blake3::Hasher,
        pos: u64,
    }

    impl<R: Read> HashingReader<R> {
        fn read_exact_body(&mut self, buf: &mut [u8], body_limit: u64) -> Result<(), PortError> {
            if self.pos.saturating_add(buf.len() as u64) > body_limit {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            self.inner
                .read_exact(buf)
                .map_err(|err| internal_not_committed("read_pg_spool_body", err.to_string()))?;
            self.hasher.update(buf);
            self.pos += buf.len() as u64;
            Ok(())
        }
    }

    let mut reader = HashingReader {
        inner: BufReader::with_capacity(STREAM_IO_BUF_BYTES, file),
        hasher: blake3::Hasher::new(),
        pos: 0,
    };

    let mut magic = [0u8; POSTGRES_SPOOL_V1_MAGIC.len()];
    reader.read_exact_body(&mut magic, body_limit)?;
    if magic != POSTGRES_SPOOL_V1_MAGIC {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    let mut u32_buf = [0u8; 4];
    reader.read_exact_body(&mut u32_buf, body_limit)?;
    let schema_version = u32::from_be_bytes(u32_buf);
    let expected_tables = spool_tables(schema_version);
    let expected_checksum = match schema_version {
        CANONICAL_SCHEMA_VERSION => manifest_checksum(),
        1..=8 => {
            let digest = checksum_tables(schema_version, expected_tables.clone());
            if !crate::schema::migrate::recognized_predecessor(
                i64::from(schema_version),
                digest.as_bytes(),
            ) {
                return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
            }
            digest
        }
        _ => return Err(DomainError::validation(ValidationReason::InvalidState).into()),
    };
    let mut checksum_buf = [0u8; 32];
    reader.read_exact_body(&mut checksum_buf, body_limit)?;
    let observed_checksum = ContentDigest::from_bytes(checksum_buf);
    if observed_checksum != expected_checksum {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }

    reader.read_exact_body(&mut u32_buf, body_limit)?;
    let witness_len = u32::from_be_bytes(u32_buf) as usize;
    if witness_len > MAX_MSGPACK_DECODE_BYTES {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
    if witness_len as u64 > body_limit.saturating_sub(reader.pos) {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    charge(witness_len as u64)?;
    let mut witness_bytes = vec![0u8; witness_len];
    reader.read_exact_body(&mut witness_bytes, body_limit)?;
    let witness: BackupWitness = decode_msgpack_bounded(&witness_bytes, MAX_MSGPACK_DECODE_BYTES)?;
    if witness.schema_version != schema_version {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    reader.read_exact_body(&mut u32_buf, body_limit)?;
    let table_count = u32::from_be_bytes(u32_buf) as usize;
    if table_count != expected_tables.clone().count() {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    charge((table_count * std::mem::size_of::<DecodedPostgresSpoolTable>()) as u64)?;
    let mut tables = Vec::with_capacity(table_count);
    let mut u16_buf = [0u8; 2];
    let mut u64_buf = [0u8; 8];
    let mut tag_buf = [0u8; 1];

    for expected_table in expected_tables {
        reader.read_exact_body(&mut u16_buf, body_limit)?;
        let name_len = u16::from_be_bytes(u16_buf) as usize;
        if name_len != expected_table.name.len() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        charge(expected_table.name.len() as u64)?;
        let mut name_bytes = vec![0u8; expected_table.name.len()];
        reader.read_exact_body(&mut name_bytes, body_limit)?;
        let table_name = String::from_utf8(name_bytes)
            .map_err(|_| DomainError::validation(ValidationReason::InvalidState))?;
        if table_name != expected_table.name {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }

        reader.read_exact_body(&mut u16_buf, body_limit)?;
        let col_count = u16::from_be_bytes(u16_buf) as usize;
        if col_count != expected_table.columns.len() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        for col in expected_table.columns {
            charge((std::mem::size_of::<String>() + col.name.len()) as u64)?;
        }

        let mut rows = Vec::new();
        loop {
            reader.read_exact_body(&mut tag_buf, body_limit)?;
            match tag_buf[0] {
                0 => break,
                1 => {
                    charge(
                        (std::mem::size_of::<Vec<PostgresSpoolValue>>()
                            + col_count * std::mem::size_of::<PostgresSpoolValue>())
                            as u64,
                    )?;
                    let mut row_vals = Vec::with_capacity(col_count);
                    for col_spec in expected_table.columns {
                        reader.read_exact_body(&mut tag_buf, body_limit)?;
                        match tag_buf[0] {
                            0 => {
                                if !col_spec.nullable {
                                    return Err(DomainError::validation(
                                        ValidationReason::InvalidState,
                                    )
                                    .into());
                                }
                                row_vals.push(PostgresSpoolValue::Null);
                            }
                            1 => match col_spec.kind {
                                LogicalColKind::Int => {
                                    reader.read_exact_body(&mut u64_buf, body_limit)?;
                                    row_vals
                                        .push(PostgresSpoolValue::Int(i64::from_be_bytes(u64_buf)));
                                }
                                LogicalColKind::Text | LogicalColKind::Bytes => {
                                    reader.read_exact_body(&mut u64_buf, body_limit)?;
                                    let total_len = u64::from_be_bytes(u64_buf);
                                    if total_len > body_limit.saturating_sub(reader.pos) {
                                        return Err(DomainError::validation(
                                            ValidationReason::InvalidState,
                                        )
                                        .into());
                                    }
                                    let cap = usize::try_from(total_len).map_err(|_| {
                                        DomainError::validation(ValidationReason::BudgetExceeded)
                                    })?;
                                    charge(total_len)?;
                                    let mut assembled = Vec::new();
                                    assembled.try_reserve_exact(cap).map_err(|_| {
                                        DomainError::validation(ValidationReason::BudgetExceeded)
                                    })?;
                                    let mut read_so_far = 0u64;
                                    while read_so_far < total_len {
                                        reader.read_exact_body(&mut u32_buf, body_limit)?;
                                        let chunk_len = u32::from_be_bytes(u32_buf) as usize;
                                        if chunk_len == 0
                                            || chunk_len > PG_SLICE_MAX_BYTES
                                            || read_so_far + (chunk_len as u64) > total_len
                                        {
                                            return Err(DomainError::validation(
                                                ValidationReason::InvalidState,
                                            )
                                            .into());
                                        }
                                        let prev = assembled.len();
                                        assembled.resize(prev + chunk_len, 0);
                                        reader.read_exact_body(
                                            &mut assembled[prev..prev + chunk_len],
                                            body_limit,
                                        )?;
                                        read_so_far += chunk_len as u64;
                                    }
                                    if col_spec.kind == LogicalColKind::Text {
                                        let s = String::from_utf8(assembled).map_err(|_| {
                                            DomainError::validation(ValidationReason::InvalidState)
                                        })?;
                                        row_vals.push(PostgresSpoolValue::Text(s));
                                    } else {
                                        row_vals.push(PostgresSpoolValue::Bytes(assembled));
                                    }
                                }
                            },
                            _ => {
                                return Err(DomainError::validation(
                                    ValidationReason::InvalidState,
                                )
                                .into());
                            }
                        }
                    }
                    rows.push(row_vals);
                }
                _ => return Err(DomainError::validation(ValidationReason::InvalidState).into()),
            }
        }

        reader.read_exact_body(&mut u64_buf, body_limit)?;
        let declared_row_count = u64::from_be_bytes(u64_buf);
        if declared_row_count != rows.len() as u64 {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }

        tables.push(DecodedPostgresSpoolTable {
            name: table_name,
            columns: expected_table
                .columns
                .iter()
                .map(|c| c.name.to_owned())
                .collect(),
            rows,
        });
    }

    if reader.pos != body_limit {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    let mut trailer = [0u8; 32];
    reader
        .inner
        .read_exact(&mut trailer)
        .map_err(|err| internal_not_committed("read_pg_spool_trailer", err.to_string()))?;
    let expected_body_digest = *reader.hasher.finalize().as_bytes();
    if trailer != expected_body_digest {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }

    Ok(DecodedPostgresSpoolV1 {
        schema_version,
        manifest_checksum: observed_checksum,
        witness,
        tables,
    })
}

// ============================================================================
// Core `BackupParticipantPort` phase handles and `Drop` guarantees
// ============================================================================

enum PreparedBackendDriver {
    Sqlite(SqliteBackupWorkerHandle),
    Postgres(PgPreparedSource),
}

impl PreparedBackendDriver {
    fn detach_abort_cleanup(&mut self, inner: &CanonicalInner) {
        match self {
            Self::Sqlite(w) => w.detach_abort_cleanup(inner),
            Self::Postgres(pg) => pg.detach_abort_cleanup(inner),
        }
    }
}

struct CanonicalPreparedBackup {
    store: CanonicalStore,
    backup_id: BackupId,
    artifact_id: ArtifactId,
    prepare_budget: BackupBudget,
    caller_cancel: Cancellation,
    prepared_at: Instant,
    spool_dir: PathBuf,
    artifact_lease: Option<ArtifactLease>,
    driver: Option<PreparedBackendDriver>,
    held_histories: Option<(HoldProof, Vec<ChangeCursor>)>,
}

impl Drop for CanonicalPreparedBackup {
    fn drop(&mut self) {
        if let Some(mut drv) = self.driver.take() {
            drv.detach_abort_cleanup(&self.store.inner);
        }
    }
}

#[derive(Clone)]
struct HoldProof {
    generation: ArtifactId,
    owner: Arc<tokio::sync::Mutex<Option<HoldOwnership>>>,
    release: Cancellation,
    copying: Arc<tokio::sync::RwLock<()>>,
}

impl HoldProof {
    async fn verify(&self) -> Result<(), PortError> {
        let mut guard = self.owner.lock().await;
        let owner = guard
            .as_mut()
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
        owner.verify().await
    }
}

struct CanonicalBackupHold {
    witness: BackupWitness,
    proof: HoldProof,
    finished: tokio::sync::oneshot::Receiver<Result<(), PortError>>,
}

impl Drop for CanonicalBackupHold {
    fn drop(&mut self) {
        self.proof.release.cancel();
    }
}

impl BackupHold for CanonicalBackupHold {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }

    fn release(mut self: Box<Self>) -> PortFuture<'static, ()> {
        self.proof.release.cancel();
        Box::pin(async move {
            (&mut self.finished)
                .await
                .map_err(|err| internal_not_committed("backup_release_owner", err.to_string()))?
        })
    }
}

struct PauseLocks {
    _local: WriterSafePointGuard,
    database: Option<PgConnection>,
}

struct CanonicalPausedBackup {
    store: CanonicalStore,
    backup_id: BackupId,
    artifact_id: ArtifactId,
    prepare_budget: BackupBudget,
    caller_cancel: Cancellation,
    prepared_at: Instant,
    spool_dir: PathBuf,
    artifact_lease: Option<ArtifactLease>,
    locks: Arc<std::sync::Mutex<Option<PauseLocks>>>,
    watchdog: tokio::task::AbortHandle,
    held_histories: Option<(HoldProof, Vec<ChangeCursor>)>,
    unpinned_driver: Option<PreparedBackendDriver>,
}

impl CanonicalPausedBackup {
    fn validate_cut(&self, witness: &BackupWitness) -> Result<(), PortError> {
        if self.locks.lock().expect("backup pause").is_none() {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
        }
        if let Some((proof, histories)) = &self.held_histories {
            let held = histories.iter().map(|cursor| &cursor.scope);
            let pinned = witness.histories.iter().map(|cursor| &cursor.scope);
            if proof.release.is_cancelled() || !held.eq(pinned) {
                return Err(unavailable_retryable(
                    "backup_hold_scope_changed",
                    "Space membership changed since the CAS hold",
                    Duration::from_millis(10),
                ));
            }
        }
        Ok(())
    }
}

impl Drop for CanonicalPausedBackup {
    fn drop(&mut self) {
        // Release writer safe point first so concurrent writers are never stranded.
        self.watchdog.abort();
        self.locks.lock().expect("backup pause").take();
        if let Some(mut drv) = self.unpinned_driver.take() {
            drv.detach_abort_cleanup(&self.store.inner);
        }
    }
}

impl PausedBackup for CanonicalPausedBackup {
    fn open_cut(&mut self) -> PortFuture<'_, Box<dyn BackupSnapshot>> {
        Box::pin(async move {
            if self.locks.lock().expect("backup pause").is_none() {
                return Err(internal_not_committed(
                    "backup_pause_already_resumed",
                    "open_cut called after writer pause was released",
                ));
            }
            let remaining = self
                .prepare_budget
                .deadline
                .saturating_sub(self.prepared_at.elapsed());
            if remaining.is_zero() {
                return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
            }
            let drv = self
                .unpinned_driver
                .take()
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;

            let expected_inst = self.store.inner.config.installation_id.clone();
            let (witness, state) = match drv {
                PreparedBackendDriver::Sqlite(mut worker) => {
                    let wal = self.store.inner.wal_coord.get().ok_or_else(|| {
                        internal_not_committed(
                            "sqlite_wal_coord_missing",
                            "SqliteWalCoordinator missing on SQLite store",
                        )
                    })?;
                    let BackupRetentionBudget::SqliteWal { max_pinned_bytes } =
                        self.prepare_budget.retention
                    else {
                        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
                    };
                    let wal_pin = wal.register_backup_pin(max_pinned_bytes);

                    let tx = worker.cmd_tx.as_ref().ok_or_else(|| {
                        internal_not_committed(
                            "sqlite_backup_channel_closed",
                            "SQLite backup worker channel closed",
                        )
                    })?;
                    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                    let abort_flag = Arc::clone(&wal_pin.abort_flag);
                    let abort_notify = Arc::clone(&wal_pin.abort_notify);
                    tx.send(SqliteWorkerCmd::OpenCut {
                        wal_pin,
                        remaining,
                        shutdown: self.store.inner.backup_shutdown.clone(),
                        expected_installation: expected_inst,
                        reply: reply_tx,
                    })
                    .map_err(|err| {
                        internal_not_committed("sqlite_backup_send_open_cut", err.to_string())
                    })?;

                    let result = wait_for_phase(
                        remaining,
                        &self.caller_cancel,
                        &self.store.inner.backup_shutdown,
                        async {
                            reply_rx.await.map_err(|err| {
                                internal_not_committed(
                                    "sqlite_backup_open_cut_eof",
                                    err.to_string(),
                                )
                            })?
                        },
                    )
                    .await;
                    let witness = match result {
                        Ok(witness) => witness,
                        Err(error) => {
                            worker.abort_and_join().await;
                            return Err(error);
                        }
                    };
                    (
                        witness,
                        PinnedSnapshotDriver::Sqlite {
                            worker,
                            abort_flag,
                            abort_notify,
                        },
                    )
                }
                PreparedBackendDriver::Postgres(mut pg) => {
                    let conn = pg.source.as_mut().ok_or_else(|| {
                        internal_not_committed(
                            "pg_backup_conn_missing",
                            "PostgreSQL backup connection missing",
                        )
                    })?;
                    let BackupRetentionBudget::PostgresSnapshot { max_age } =
                        self.prepare_budget.retention
                    else {
                        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
                    };
                    let remaining = remaining.min(max_age);
                    pg.pinned_at = Some(Instant::now());
                    let pin_res = wait_for_phase(
                        remaining,
                        &self.caller_cancel,
                        &self.store.inner.backup_shutdown,
                        async {
                            let hold = &self.held_histories.as_ref().expect("pause owns hold").0;
                            let (witness, ()) = tokio::try_join!(
                                pin_and_read_pg_witness(&mut *conn, &expected_inst, remaining),
                                hold.verify()
                            )?;
                            Ok(witness)
                        },
                    )
                    .await;
                    let witness = match pin_res {
                        Ok(w) => w,
                        Err(err) => {
                            pg.cancel_and_close().await;
                            return Err(err);
                        }
                    };

                    (witness, PinnedSnapshotDriver::Postgres(pg))
                }
            };
            self.validate_cut(&witness)?;
            let snapshot = CanonicalBackupSnapshot {
                store: self.store.clone(),
                backup_id: self.backup_id.clone(),
                artifact_id: self.artifact_id.clone(),
                prepare_budget: self.prepare_budget,
                caller_cancel: self.caller_cancel.clone(),
                prepared_at: self.prepared_at,
                spool_dir: self.spool_dir.clone(),
                artifact_lease: self.artifact_lease.take(),
                witness: Arc::new(witness),
                active: None,
                hold: self
                    .held_histories
                    .as_ref()
                    .expect("pause owns hold")
                    .0
                    .clone(),
                state: Some(state),
            };
            Ok(Box::new(phase::Snapshot::new(snapshot)?) as Box<dyn BackupSnapshot>)
        })
    }

    fn resume(mut self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            self.watchdog.abort();
            let locks = self
                .locks
                .lock()
                .expect("backup pause")
                .take()
                .ok_or_else(|| DomainError::validation(ValidationReason::BudgetExceeded))?;
            let unpinned = self.unpinned_driver.take();
            if let Some(mut conn) = locks.database {
                sqlx::raw_sql("ROLLBACK")
                    .execute(&mut conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_resume_backup", err.to_string()))?;
            }
            drop(locks._local);
            if let Some(drv) = unpinned {
                match drv {
                    PreparedBackendDriver::Sqlite(mut w) => w.abort_and_join().await,
                    PreparedBackendDriver::Postgres(mut p) => p.abort_cleanly().await,
                }
            }
            Ok(())
        })
    }
}

enum PinnedSnapshotDriver {
    Sqlite {
        worker: SqliteBackupWorkerHandle,
        abort_flag: Arc<AtomicBool>,
        abort_notify: Arc<tokio::sync::Notify>,
    },
    Postgres(PgPreparedSource),
}

struct CanonicalBackupSnapshot {
    store: CanonicalStore,
    backup_id: BackupId,
    artifact_id: ArtifactId,
    prepare_budget: BackupBudget,
    caller_cancel: Cancellation,
    prepared_at: Instant,
    spool_dir: PathBuf,
    artifact_lease: Option<ArtifactLease>,
    witness: Arc<BackupWitness>,
    hold: HoldProof,
    state: Option<PinnedSnapshotDriver>,
    active: Option<ActiveSpool>,
}

struct ActiveSpool {
    cancel: Cancellation,
    task: tokio::task::JoinHandle<Result<BackupSpool, PortError>>,
}
pub(crate) struct CancelOnDrop(pub(crate) Cancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl Drop for CanonicalBackupSnapshot {
    fn drop(&mut self) {
        if let Some(active) = self.active.take() {
            active.cancel.cancel();
            register_cleanup_task(
                &self.store.inner,
                self.store.inner.backup_executor.spawn(async move {
                    let _ = active.task.await;
                }),
            );
        }
        if let Some(st) = self.state.take() {
            match st {
                PinnedSnapshotDriver::Sqlite { mut worker, .. } => {
                    worker.detach_abort_cleanup(&self.store.inner);
                }
                PinnedSnapshotDriver::Postgres(mut pg) => {
                    pg.detach_abort_cleanup(&self.store.inner);
                }
            }
        }
    }
}

impl CanonicalBackupSnapshot {
    fn run_spool(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, BackupSpool> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                if let Some(st) = self.state.take() {
                    abort_pinned_driver(st).await;
                }
                return Err(cancelled_not_committed(
                    "backup_spool_cancelled_pre_start",
                    "backup spool cancelled before start",
                ));
            }
            let Some(pinned) = self.state.take() else {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            };
            let remaining_budget =
                tighten_budget(self.prepare_budget, budget).and_then(|mut limit| {
                    limit.deadline = limit.deadline.saturating_sub(self.prepared_at.elapsed());
                    validate_backup_budget(limit)?;
                    Ok(limit)
                });
            let eff_budget = match remaining_budget {
                Ok(limit) => limit,
                Err(err) => {
                    abort_pinned_driver(pinned).await;
                    return Err(err);
                }
            };

            let lease = self
                .artifact_lease
                .as_mut()
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            lease.begin_publication();
            let step_delay_us = self.store.inner.backup_step_delay_us.load(Ordering::SeqCst);

            let (encoding, rel_name, bytes, digest, stats) = match pinned {
                PinnedSnapshotDriver::Sqlite {
                    mut worker,
                    abort_flag,
                    abort_notify,
                } => {
                    let rel_name = format!(
                        "{}.{}",
                        self.artifact_id.as_str(),
                        BackupArtifactEncoding::SqliteSnapshotV1.extension()
                    );
                    let final_path = self.spool_dir.join(&rel_name);

                    let cancel_bridge_stop = Arc::new(AtomicBool::new(false));
                    let cancel_bridge_stop_cl = Arc::clone(&cancel_bridge_stop);
                    let worker_cancel_cl = Arc::clone(&worker.cancel_flag);
                    let interrupt_cl = Arc::clone(&worker.interrupt_handle);
                    if abort_flag.load(Ordering::Acquire) {
                        worker.abort_and_join().await;
                        return Err(
                            DomainError::validation(ValidationReason::BudgetExceeded).into()
                        );
                    }
                    let abort_notify_cl = abort_notify;
                    let caller_cancel_cl = cancellation.clone();

                    let watcher = tokio::spawn(async move {
                        loop {
                            if cancel_bridge_stop_cl.load(Ordering::SeqCst) {
                                break;
                            }
                            if caller_cancel_cl.is_cancelled() {
                                worker_cancel_cl.store(true, Ordering::SeqCst);
                                interrupt_cl.interrupt();
                                break;
                            }
                            tokio::select! {
                                _ = abort_notify_cl.notified() => {
                                    interrupt_cl.interrupt();
                                    break;
                                }
                                _ = tokio::time::sleep(Duration::from_millis(5)) => {}
                            }
                        }
                    });

                    let _stop_on_drop = AbortBackupWatcher(watcher.abort_handle());
                    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                    let send_res = worker
                        .cmd_tx
                        .as_ref()
                        .ok_or_else(|| {
                            internal_not_committed(
                                "sqlite_backup_tx_missing",
                                "SQLite backup channel missing",
                            )
                        })
                        .and_then(|tx| {
                            tx.send(SqliteWorkerCmd::Spool {
                                budget: eff_budget,
                                expected_witness: self.witness.clone(),
                                final_path: final_path.clone(),
                                step_delay_us,
                                reply: reply_tx,
                            })
                            .map_err(|err| {
                                internal_not_committed("sqlite_backup_send_spool", err.to_string())
                            })
                        });

                    if let Err(err) = send_res {
                        cancel_bridge_stop.store(true, Ordering::SeqCst);
                        let _ = watcher.await;
                        worker.abort_and_join().await;
                        if abort_flag.load(Ordering::Acquire) {
                            return Err(
                                DomainError::validation(ValidationReason::BudgetExceeded).into()
                            );
                        }
                        return Err(err);
                    }

                    let outcome = reply_rx.await;
                    cancel_bridge_stop.store(true, Ordering::SeqCst);
                    let _ = watcher.await;

                    // Join the owner thread so all SQLite handles are guaranteed closed before return.
                    worker.cmd_tx.take();
                    if let Some(jh) = worker.join_handle.take() {
                        let _ = tokio::task::spawn_blocking(move || {
                            let _ = jh.join();
                        })
                        .await;
                    }

                    match outcome {
                        Ok(Ok(ok)) => (
                            BackupArtifactEncoding::SqliteSnapshotV1,
                            rel_name,
                            ok.bytes,
                            ok.digest,
                            ok.stats,
                        ),
                        Ok(Err(err)) => {
                            let _ = fs::remove_file(&final_path);
                            return Err(err);
                        }
                        Err(err) => {
                            let _ = fs::remove_file(&final_path);
                            return Err(internal_not_committed(
                                "sqlite_backup_spool_eof",
                                err.to_string(),
                            ));
                        }
                    }
                }
                PinnedSnapshotDriver::Postgres(mut pg) => {
                    let rel_name = format!(
                        "{}.{}",
                        self.artifact_id.as_str(),
                        BackupArtifactEncoding::PostgresSpoolV1.extension()
                    );
                    let final_path = self.spool_dir.join(&rel_name);
                    match stream_postgres_spool_v1(
                        &mut pg,
                        &self.witness,
                        eff_budget,
                        &cancellation,
                        &final_path,
                        step_delay_us,
                    )
                    .await
                    {
                        Ok((bytes, digest, stats)) => (
                            BackupArtifactEncoding::PostgresSpoolV1,
                            rel_name,
                            bytes,
                            digest,
                            stats,
                        ),
                        Err(err) => {
                            let _ = fs::remove_file(&final_path);
                            return Err(err);
                        }
                    }
                }
            };

            *self
                .store
                .inner
                .last_backup_memory_stats
                .lock()
                .expect("backup memory stats mutex") = Some(stats);

            if cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "backup_cancelled_before_publish",
                    "spool cancelled",
                ));
            }
            persist_backup_artifact_ready(
                &self.store,
                &self.artifact_id,
                &self.backup_id,
                &self.hold,
                encoding,
                &lease.key(&rel_name),
                bytes,
                digest,
                &self.witness,
            )
            .await?;
            lease.accepted()?;

            Ok(BackupSpool {
                kind: match encoding {
                    BackupArtifactEncoding::SqliteSnapshotV1 => {
                        BackupArtifactKind::SqliteSnapshotV1
                    }
                    BackupArtifactEncoding::PostgresSpoolV1 => BackupArtifactKind::PostgresSpoolV1,
                },
                artifact: self.artifact_id.clone(),
                bytes,
                digest,
                witness: self.witness.as_ref().clone(),
            })
        })
    }
}

impl BackupSnapshot for CanonicalBackupSnapshot {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }

    fn spool(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, BackupSpool> {
        Box::pin(async move {
            let pinned = self
                .state
                .take()
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            let mut job = CanonicalBackupSnapshot {
                store: self.store.clone(),
                backup_id: self.backup_id.clone(),
                artifact_id: self.artifact_id.clone(),
                prepare_budget: self.prepare_budget,
                caller_cancel: self.caller_cancel.clone(),
                prepared_at: self.prepared_at,
                spool_dir: self.spool_dir.clone(),
                artifact_lease: self.artifact_lease.take(),
                witness: self.witness.clone(),
                state: Some(pinned),
                active: None,
                hold: self.hold.clone(),
            };
            let owner_cancel = Cancellation::default();
            if cancellation.is_cancelled() {
                owner_cancel.cancel();
            }
            let _cancel_on_drop = CancelOnDrop(owner_cancel.clone());
            let worker_cancel = owner_cancel.clone();
            let shutdown = self.store.inner.backup_shutdown.clone();
            let hold = self.hold.clone();
            let caller_cancel = self.caller_cancel.clone();
            let (done, completion) = tokio::sync::oneshot::channel::<()>();
            register_cleanup_task(
                &self.store.inner,
                self.store.inner.backup_executor.spawn(async move {
                    let _ = completion.await;
                }),
            );
            let task = self.store.inner.backup_executor.spawn(async move {
                let _done = done;
                let _copy_guard = hold.copying.read().await;
                hold.verify().await?;
                if hold.release.is_cancelled() {
                    worker_cancel.cancel();
                }
                let result = {
                    let work = job.run_spool(budget, worker_cancel.clone());
                    tokio::pin!(work);
                    tokio::select! {
                        result = &mut work => result,
                        () = hold.release.cancelled() => { worker_cancel.cancel(); work.await },
                        () = caller_cancel.cancelled() => { worker_cancel.cancel(); work.await },
                        () = shutdown.cancelled() => { worker_cancel.cancel(); work.await }
                    }
                };
                if result.is_err()
                    && let Some(lease) = job.artifact_lease.as_ref()
                {
                    lease.reconcile_pending().await?;
                }
                result
            });
            let active = self.active.insert(ActiveSpool {
                cancel: owner_cancel,
                task,
            });
            let result = tokio::select! {
                result = &mut active.task => result,
                () = cancellation.cancelled() => {
                    active.cancel.cancel();
                    (&mut active.task).await
                }
            };
            self.active.take();
            result.map_err(|err| internal_not_committed("backup_spool_worker", err.to_string()))?
        })
    }

    fn close(mut self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            if let Some(active) = self.active.as_mut() {
                active.cancel.cancel();
                let _ = (&mut active.task).await;
                self.active.take();
            }
            if let Some(st) = self.state.take() {
                abort_pinned_driver(st).await;
            }
            Ok(())
        })
    }
}

async fn abort_pinned_driver(st: PinnedSnapshotDriver) {
    match st {
        PinnedSnapshotDriver::Sqlite { mut worker, .. } => {
            worker.abort_and_join().await;
        }
        PinnedSnapshotDriver::Postgres(mut pg) => pg.abort_cleanly().await,
    }
}

impl PreparedBackup for CanonicalPreparedBackup {
    fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
        Box::pin(async move {
            if self.driver.is_none() {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            if self.held_histories.is_some() {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            let backup_id = self.backup_id.clone();
            let store = self.store.clone();
            let caller = self.caller_cancel.clone();
            let deadline = tokio::time::Instant::now()
                + self
                    .prepare_budget
                    .deadline
                    .saturating_sub(self.prepared_at.elapsed());
            let abandoned = Cancellation::default();
            let _cancel_on_drop = CancelOnDrop(abandoned.clone());
            let worker = self.store.inner.backup_executor.spawn(async move {
                let generation = mint_artifact_id()?;
                let stop = async {
                    tokio::select! {
                        () = tokio::time::sleep_until(deadline) =>
                            DomainError::validation(ValidationReason::BudgetExceeded).into(),
                        () = caller.cancelled() => cancelled_not_committed("backup_cancelled", "backup cancelled"),
                        () = abandoned.cancelled() => cancelled_not_committed("backup_hold_abandoned", "hold acquisition dropped"),
                        () = store.inner.backup_shutdown.cancelled() => cancelled_not_committed("backup_shutdown", "backup shutting down"),
                    }
                };
                let (owner, witness) = acquire_owned_hold(&store, &backup_id, &generation, deadline, stop).await?;
                let held_count = witness.histories.len() as u64;
                let (done, finished) = tokio::sync::oneshot::channel();
                let proof = HoldProof {
                    generation,
                    owner: Arc::new(tokio::sync::Mutex::new(Some(owner))),
                    release: Cancellation::default(),
                    copying: Default::default(),
                };
                let hold = CanonicalBackupHold {
                    witness,
                    proof: proof.clone(),
                    finished,
                };
                let inner = Arc::clone(&store.inner);
                let cleanup = inner.backup_executor.spawn(async move {
                    tokio::select! {
                        () = proof.release.cancelled() => {},
                        () = store.inner.backup_shutdown.cancelled() => {},
                    }
                    proof.release.cancel();
                    let _drained = proof.copying.write().await;
                    let mut owner = proof.owner.lock().await.take().expect("hold owns session");
                    let result = delete_backup_hold_rows(
                        &store,
                        &mut owner,
                        &backup_id,
                        &proof.generation,
                        held_count,
                    )
                    .await;
                    drop(owner);
                    let _ = done.send(result);
                });
                register_cleanup_task(&inner, cleanup);
                Ok::<_, PortError>(hold)
            });
            let hold = worker
                .await
                .map_err(|err| internal_not_committed("backup_hold_worker", err.to_string()))??;
            self.held_histories = Some((hold.proof.clone(), hold.witness.histories.clone()));
            Ok(Box::new(hold) as Box<dyn BackupHold>)
        })
    }

    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
        Box::pin(async move {
            let (hold, _) = self
                .held_histories
                .as_ref()
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            let hold_release = hold.release.clone();
            if hold_release.is_cancelled() {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }

            let mut drv = self
                .driver
                .take()
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;

            let remaining = self
                .prepare_budget
                .deadline
                .saturating_sub(self.prepared_at.elapsed());
            let (safe_point, pg_barrier) = wait_for_phase(
                remaining,
                &self.caller_cancel,
                &self.store.inner.backup_shutdown,
                async {
                    let guard = self.store.inner.writer()?.acquire_safe_point().await;
                    let mut barrier = match &mut drv {
                        PreparedBackendDriver::Postgres(pg) => pg.barrier.take(),
                        PreparedBackendDriver::Sqlite(_) => None,
                    };
                    if let Some(conn) = barrier.as_mut() {
                        sqlx::query(PG_BACKUP_BARRIER_SQL)
                            .bind(true)
                            .execute(conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_backup_barrier", err.to_string())
                            })?;
                    }
                    Ok::<_, PortError>((guard, barrier))
                },
            )
            .await?;

            let locks = Arc::new(std::sync::Mutex::new(Some(PauseLocks {
                _local: safe_point,
                database: pg_barrier,
            })));
            let weak = Arc::downgrade(&locks);
            let lifetime = self
                .prepare_budget
                .deadline
                .saturating_sub(self.prepared_at.elapsed());
            let shutdown = self.store.inner.backup_shutdown.clone();
            let cancel = self.caller_cancel.clone();
            let watchdog = self
                .store
                .inner
                .backup_executor
                .spawn(async move {
                    tokio::select! {
                        () = tokio::time::sleep(lifetime) => {},
                        () = cancel.cancelled() => {},
                        () = shutdown.cancelled() => {},
                        () = hold_release.cancelled() => {},
                    }
                    if let Some(locks) = weak.upgrade() {
                        locks.lock().expect("backup pause").take();
                    }
                })
                .abort_handle();
            let paused = CanonicalPausedBackup {
                store: self.store.clone(),
                backup_id: self.backup_id.clone(),
                artifact_id: self.artifact_id.clone(),
                prepare_budget: self.prepare_budget,
                caller_cancel: self.caller_cancel.clone(),
                prepared_at: self.prepared_at,
                spool_dir: self.spool_dir.clone(),
                artifact_lease: self.artifact_lease.take(),
                locks,
                watchdog,
                held_histories: self.held_histories.take(),
                unpinned_driver: Some(drv),
            };
            Ok(Box::new(phase::Phase::new(&self.store.inner, paused)?) as Box<dyn PausedBackup>)
        })
    }
}

impl CanonicalStore {
    async fn prepare_source(
        &self,
        ctx: MaintenanceContext,
        backup: BackupId,
        budget: BackupBudget,
    ) -> Result<CanonicalPreparedBackup, PortError> {
        let store = self.clone();
        ctx.authority.require(ServicePurpose::Backup)?;
        if ctx.budget.cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "backup_prepare_cancelled",
                "backup prepare cancelled",
            ));
        }
        if ctx.budget.remaining.is_zero() {
            return Err(deadline_not_committed(
                "backup_prepare_zero_budget",
                "backup prepare call budget expired",
            ));
        }
        let prepared_at = Instant::now();
        let mut budget = tighten_budget(store.default_backup_budget(), budget)?;
        budget.deadline = budget.deadline.min(ctx.budget.remaining);
        match (&store.inner.sql, budget.retention) {
            (SqlDriverState::Sqlite { .. }, BackupRetentionBudget::SqliteWal { .. })
            | (SqlDriverState::Postgres { .. }, BackupRetentionBudget::PostgresSnapshot { .. }) => {
            }
            _ => return Err(DomainError::validation(ValidationReason::ScopeMismatch).into()),
        }
        store.ensure_open()?;

        let spool_dir = resolve_spool_dir(&store.inner)?;
        wait_for_phase(
            budget.deadline,
            &ctx.budget.cancellation,
            &store.inner.backup_shutdown,
            ownership::recover_directory(&store, &spool_dir),
        )
        .await?;
        let artifact_id = mint_artifact_id()?;
        let artifact_lease = ArtifactLease::create(&store, &spool_dir, &artifact_id)?;
        {
            let mut roots = store
                .inner
                .backup_spool_roots
                .lock()
                .expect("backup spool roots");
            if !roots.contains(&spool_dir) {
                roots.push(spool_dir.clone());
            }
        }
        let tmp_path = spool_dir.join(format!("{}.tmp", artifact_id.as_str()));

        let (driver, artifact_lease) = match (&store.inner.config.sql, &store.inner.sql) {
            (SqlBackendConfig::Sqlite { data_root, .. }, SqlDriverState::Sqlite { .. }) => {
                let src_path = data_root.canonical();
                let remaining = budget.deadline.saturating_sub(prepared_at.elapsed());
                // A cancelled preparation can leave native initialization in flight.
                // Track the thread through its last database and staging-file access.
                let (finished, completion) = tokio::sync::oneshot::channel();
                register_cleanup_task(
                    &store.inner,
                    store.inner.backup_executor.spawn(async move {
                        let _ = completion.await;
                    }),
                );
                wait_for_phase(
                    remaining,
                    &ctx.budget.cancellation,
                    &store.inner.backup_shutdown,
                    async move {
                        tokio::task::spawn_blocking(move || {
                            let worker =
                                SqliteBackupWorkerHandle::spawn(src_path, tmp_path, finished)?;
                            Ok((PreparedBackendDriver::Sqlite(worker), artifact_lease))
                        })
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_prepare_worker", err.to_string())
                        })?
                    },
                )
                .await?
            }
            (_, SqlDriverState::Postgres { .. }) => {
                let remaining = budget.deadline.saturating_sub(prepared_at.elapsed());
                let (source, barrier, backend_pid) = wait_for_phase(
                    remaining,
                    &ctx.budget.cancellation,
                    &store.inner.backup_shutdown,
                    async {
                        let (mut source, mut barrier) = tokio::try_join!(
                            open_backup_connection(&store),
                            open_backup_connection(&store)
                        )?;
                        let BackupRetentionBudget::PostgresSnapshot { max_age } = budget.retention
                        else {
                            return Err(
                                DomainError::validation(ValidationReason::ScopeMismatch).into()
                            );
                        };
                        let (backend_pid, ()) = tokio::try_join!(
                            warm_pg_backup_connection(&mut source, remaining, max_age),
                            warm_pg_backup_barrier(&mut barrier, remaining)
                        )?;
                        Ok((source, barrier, backend_pid))
                    },
                )
                .await?;
                create_private_tmp_file(&tmp_path)?;
                (
                    PreparedBackendDriver::Postgres(PgPreparedSource {
                        source: Some(source),
                        store: store.clone(),
                        backend_pid,
                        barrier: Some(barrier),
                        pinned_at: None,
                        tmp_path,
                    }),
                    artifact_lease,
                )
            }
            _ => {
                remove_tmp_artifacts_best_effort(&tmp_path);
                return Err(internal_not_committed(
                    "backup_driver_mismatch",
                    "SQL config and runtime state mismatch",
                ));
            }
        };

        Ok(CanonicalPreparedBackup {
            store,
            backup_id: backup,
            artifact_id,
            prepared_at,
            prepare_budget: budget,
            caller_cancel: ctx.budget.cancellation.clone(),
            spool_dir,
            artifact_lease: Some(artifact_lease),
            driver: Some(driver),
            held_histories: None,
        })
    }
}

impl BackupParticipantPort for CanonicalStore {
    fn prepare(
        &self,
        ctx: MaintenanceContext,
        backup: BackupId,
        budget: BackupBudget,
    ) -> PortFuture<'_, Box<dyn PreparedBackup>> {
        phase::prepare(self.clone(), ctx, backup, budget)
    }

    fn restore_cursors(
        &self,
        ctx: MaintenanceContext,
        mut restored: Vec<ChangeCursor>,
    ) -> PortFuture<'_, ()> {
        let store = self.clone();
        Box::pin(async move {
            let started = Instant::now();
            ctx.authority.require(ServicePurpose::Restore)?;
            if ctx.budget.cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "restore_cursors_cancelled",
                    "restore_cursors cancelled",
                ));
            }
            if ctx.budget.remaining.is_zero() {
                return Err(deadline_not_committed(
                    "restore_cursors_zero_budget",
                    "restore_cursors call budget expired",
                ));
            }
            store.ensure_open()?;

            if restored.is_empty() {
                return Ok(());
            }

            // Lock Spaces in a stable order across independent PostgreSQL runtimes.
            restored.sort_unstable_by(|a, b| a.scope.space_id.cmp(&b.scope.space_id));
            if restored
                .windows(2)
                .any(|pair| pair[0].scope.space_id == pair[1].scope.space_id)
            {
                return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
            }

            let mut budget = ctx.budget;
            budget.remaining = budget.remaining.saturating_sub(started.elapsed());
            restore::run(&store, budget, restored).await
        })
    }
}

// ============================================================================
// Durable SQL helpers for `backup_holds`, `backup_artifacts`, `restore_cursors`
// ============================================================================

async fn recover_restored_gc(store: CanonicalStore, spaces: Vec<(HistoryScope, LeaseEpoch)>) {
    use crate::domain::purge::{RetirementRecovery, RetirementSelection};
    use futures_util::StreamExt;
    futures_util::stream::iter(spaces)
        .for_each_concurrent(4, |(scope, epoch)| {
            let store = store.clone();
            async move {
                let mut backoff = Duration::from_millis(50);
                loop {
                    match store
                        .resume_blob_retirements(
                            &scope,
                            epoch,
                            RetirementRecovery::Online,
                            RetirementSelection::GcOnly,
                        )
                        .await
                    {
                        Ok(()) => return,
                        Err(error) => {
                            let Some(minimum) = crate::blobs::retirement_worker::retry_after(&error) else {
                                tracing::warn!(?error, space = %scope.space_id.as_str(), "restored Space GC stopped");
                                return;
                            };
                            tokio::time::sleep(backoff.max(minimum)).await;
                        }
                    }
                    backoff = (backoff * 2).min(Duration::from_secs(5));
                }
            }
        })
        .await;
}

async fn acquire_owned_hold(
    store: &CanonicalStore,
    id: &BackupId,
    generation: &ArtifactId,
    deadline: tokio::time::Instant,
    stop: impl std::future::Future<Output = PortError>,
) -> Result<(HoldOwnership, BackupWitness), PortError> {
    tokio::pin!(stop);
    let mut owner = tokio::select! {
        biased;
        reason = &mut stop => return Err(reason),
        result = HoldOwnership::acquire(store, id, generation, deadline) => result?,
    };

    let committing = Arc::new(AtomicBool::new(false));
    let mut write = Box::pin(acquire_durable_backup_holds(
        store,
        &mut owner,
        id,
        generation,
        Arc::clone(&committing),
    ));
    let reason = tokio::select! {
        biased;
        reason = &mut stop => reason,
        result = &mut write => {
            let witness = result?;
            drop(write);
            return Ok((owner, witness));
        }
    };
    if committing.load(Ordering::Acquire) {
        // An issued COMMIT may already be durable. Retain its owner and delete
        // exactly this generation once its outcome is known.
        let witness = write.await?;
        delete_backup_hold_rows(
            store,
            &mut owner,
            id,
            generation,
            witness.histories.len() as u64,
        )
        .await?;
    } else {
        drop(write);
        owner.interrupt_acquisition(store, generation).await?;
    }
    Err(reason)
}

async fn acquire_durable_backup_holds(
    store: &CanonicalStore,
    owner: &mut HoldOwnership,
    backup_id: &BackupId,
    generation: &ArtifactId,
    committing: Arc<AtomicBool>,
) -> Result<BackupWitness, PortError> {
    let bid = backup_id.clone();
    let inst_id = store.inner.config.installation_id.clone();
    let now_ms = now_unix_ms()?;

    let generation = generation.clone();
    owner.with_write_tx(store, |tx| {
            Box::pin(async move {
                // Under the same session lock, only remnants of a disconnected predecessor may exist.
                let stale = "DELETE FROM backup_holds WHERE backup_id = $1";
                match tx {
                    BackendConn::Sqlite(conn) => sqlx::query(stale)
                        .bind(bid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map(|_| ()),
                    BackendConn::Postgres(conn) => sqlx::query(stale)
                        .bind(bid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map(|_| ()),
                }
                .map_err(|err| internal_not_committed("replace_abandoned_backup_hold", err.to_string()))?;
                let spaces: Vec<(String, Vec<u8>, i64)> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let rows = sqlx::query(
                            "SELECT space_id, history_incarnation, last_seq
                             FROM spaces
                             ORDER BY space_id ASC",
                        )
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_hold_scan_spaces", err.to_string())
                        })?;
                        rows.into_iter()
                            .map(|r| {
                                (
                                    r.get("space_id"),
                                    r.get("history_incarnation"),
                                    r.get("last_seq"),
                                )
                            })
                            .collect()
                    }
                    BackendConn::Postgres(conn) => {
                        let rows = sqlx::query(
                            "SELECT space_id, history_incarnation, last_seq
                             FROM spaces
                             ORDER BY space_id ASC
                             FOR UPDATE",
                        )
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_hold_scan_spaces", err.to_string())
                        })?;
                        rows.into_iter()
                            .map(|r| {
                                (
                                    r.get("space_id"),
                                    r.get("history_incarnation"),
                                    r.get("last_seq"),
                                )
                            })
                            .collect()
                    }
                };

                let mut histories = Vec::with_capacity(spaces.len());
                for (sid_raw, inc_bytes, last_seq_i64) in &spaces {
                    let space_id = SpaceId::parse(sid_raw).map_err(|_| {
                        internal_not_committed("corrupt_hold_space_id", "invalid SpaceId")
                    })?;
                    let inc_arr: [u8; 16] = inc_bytes.as_slice().try_into().map_err(|_| {
                        internal_not_committed("corrupt_hold_inc", "history_incarnation != 16B")
                    })?;
                    let after = i64_to_space_seq(*last_seq_i64)?;

                    // Mutual exclusion with incomplete purges and pending CAS retirements!
                    if has_incomplete_pending_purges_tx(tx, &space_id).await?
                        || has_pending_blob_retirements_tx(tx, &space_id).await?
                    {
                        return Err(unavailable_retryable(
                            "backup_blocked_by_active_purge",
                            "cannot acquire backup hold while a purge or CAS retirement is incomplete",
                            Duration::from_millis(100),
                        ));
                    }

                    histories.push(ChangeCursor {
                        scope: HistoryScope {
                            space_id,
                            incarnation: HistoryIncarnation::from_bytes(inc_arr),
                        },
                        after,
                    });
                }

                let witness = BackupWitness {
                    installation: inst_id.clone(),
                    schema_version: CANONICAL_SCHEMA_VERSION,
                    histories,
                    canaries: Vec::new(),
                };
                for cur in &witness.histories {
                    let witness_json = encode_hold_witness(&inst_id, cur)?;
                    let cutoff_i64 = cur.after.get() as i64;
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "INSERT INTO backup_holds (
                                    backup_id, space_id, history_incarnation, owner_installation_id,
                                    phase, cutoff_seq, witness_json, created_at_ms, owner_generation
                                ) VALUES (?, ?, ?, ?, 'holding', ?, ?, ?, ?)",
                            )
                            .bind(bid.as_str())
                            .bind(cur.scope.space_id.as_str())
                            .bind(cur.scope.incarnation.as_bytes().as_slice())
                            .bind(inst_id.as_str())
                            .bind(cutoff_i64)
                            .bind(&witness_json)
                            .bind(now_ms)
                            .bind(generation.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_insert_backup_hold", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "INSERT INTO backup_holds (
                                    backup_id, space_id, history_incarnation, owner_installation_id,
                                    phase, cutoff_seq, witness_json, created_at_ms, owner_generation
                                ) VALUES ($1, $2, $3, $4, 'holding', $5, $6, $7, $8)",
                            )
                            .bind(bid.as_str())
                            .bind(cur.scope.space_id.as_str())
                            .bind(cur.scope.incarnation.as_bytes().as_slice())
                            .bind(inst_id.as_str())
                            .bind(cutoff_i64)
                            .bind(&witness_json)
                            .bind(now_ms)
                            .bind(generation.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_insert_backup_hold", err.to_string())
                            })?;
                        }
                    }
                }

                if let BackendConn::Postgres(conn) = tx {
                    sqlx::raw_sql("SET statement_timeout = 0").execute(&mut **conn).await
                        .map_err(|err| internal_not_committed("pg_backup_owner_timeout", err.to_string()))?;
                }
                committing.store(true, Ordering::Release);
                Ok(witness)
            })
        })
        .await
}

async fn has_pending_blob_retirements_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<bool, PortError> {
    let found: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM blob_retirements WHERE space_id = ? AND status = 'pending' LIMIT 1",
        )
        .bind(space_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_check_pending_retirements", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM blob_retirements WHERE space_id = $1 AND status = 'pending' LIMIT 1",
        )
        .bind(space_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_check_pending_retirements", err.to_string()))?,
    };
    Ok(found.is_some())
}

async fn delete_backup_hold_rows(
    store: &CanonicalStore,
    owner: &mut HoldOwnership,
    backup_id: &BackupId,
    generation: &ArtifactId,
    expected_count: u64,
) -> Result<(), PortError> {
    let bid = backup_id.clone();
    let generation = generation.clone();
    owner
        .with_write_tx(store, |tx| {
            Box::pin(async move {
                let sql = "DELETE FROM backup_holds WHERE backup_id = $1 AND owner_generation = $2";
                let deleted = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query(sql)
                        .bind(bid.as_str())
                        .bind(generation.as_str())
                        .execute(&mut **conn)
                        .await
                        .map(|r| r.rows_affected()),
                    BackendConn::Postgres(conn) => sqlx::query(sql)
                        .bind(bid.as_str())
                        .bind(generation.as_str())
                        .execute(&mut **conn)
                        .await
                        .map(|r| r.rows_affected()),
                }
                .map_err(|err| {
                    internal_not_committed("delete_owned_backup_hold", err.to_string())
                })?;
                if deleted != expected_count {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                Ok(())
            })
        })
        .await
}

#[allow(clippy::too_many_arguments)]
async fn persist_backup_artifact_ready(
    store: &CanonicalStore,
    artifact_id: &ArtifactId,
    backup_id: &BackupId,
    proof: &HoldProof,
    encoding: BackupArtifactEncoding,
    rel_path: &str,
    byte_size: u64,
    digest: ContentDigest,
    witness: &BackupWitness,
) -> Result<(), PortError> {
    let aid = artifact_id.clone();
    let bid = backup_id.clone();
    let inst = witness.installation.clone();
    let rel_owned = rel_path.to_owned();
    let witness_json = encode_witness_json(witness)?;
    let now_ms = now_unix_ms()?;
    let byte_size_i64 = i64::try_from(byte_size)
        .map_err(|_| DomainError::validation(ValidationReason::BudgetExceeded))?;
    let histories = witness.histories.clone();

    let generation = proof.generation.clone();
    let mut guard = proof.owner.lock().await;
    let owner = guard
        .as_mut()
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
    owner.with_write_tx(store, |tx| {
            Box::pin(async move {
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO backup_artifacts (
                                artifact_id, backup_id, installation_id, encoding, schema_version,
                                artifact_rel_path, byte_size, content_blake3, witness_json, state, created_at_ms
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)",
                        )
                        .bind(aid.as_str())
                        .bind(bid.as_str())
                        .bind(inst.as_str())
                        .bind(encoding.as_db_str())
                        .bind(i64::from(CANONICAL_SCHEMA_VERSION))
                        .bind(&rel_owned)
                        .bind(byte_size_i64)
                        .bind(digest.as_bytes().as_slice())
                        .bind(&witness_json)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_insert_backup_artifact", err.to_string())
                        })?;

                        for cur in &histories {
                            let hold_witness = encode_hold_witness(&inst, cur)?;
                            let updated = sqlx::query(
                                "UPDATE backup_holds
                                 SET phase = 'spooled', cutoff_seq = ?, witness_json = ?
                                 WHERE backup_id = ? AND space_id = ? AND owner_generation = ?",
                            )
                            .bind(cur.after.get() as i64)
                            .bind(hold_witness)
                            .bind(bid.as_str())
                            .bind(cur.scope.space_id.as_str())
                            .bind(generation.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_update_hold_spooled", err.to_string())
                            })?;
                            if updated.rows_affected() != 1 {
                                return Err(DomainError::validation(ValidationReason::InvalidState).into());
                            }
                        }
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO backup_artifacts (
                                artifact_id, backup_id, installation_id, encoding, schema_version,
                                artifact_rel_path, byte_size, content_blake3, witness_json, state, created_at_ms
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ready', $10)",
                        )
                        .bind(aid.as_str())
                        .bind(bid.as_str())
                        .bind(inst.as_str())
                        .bind(encoding.as_db_str())
                        .bind(CANONICAL_SCHEMA_VERSION as i32)
                        .bind(&rel_owned)
                        .bind(byte_size_i64)
                        .bind(digest.as_bytes().as_slice())
                        .bind(&witness_json)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_insert_backup_artifact", err.to_string())
                        })?;

                        for cur in &histories {
                            let hold_witness = encode_hold_witness(&inst, cur)?;
                            let updated = sqlx::query(
                                "UPDATE backup_holds
                                 SET phase = 'spooled', cutoff_seq = $1, witness_json = $2
                                 WHERE backup_id = $3 AND space_id = $4 AND owner_generation = $5",
                            )
                            .bind(cur.after.get() as i64)
                            .bind(hold_witness)
                            .bind(bid.as_str())
                            .bind(cur.scope.space_id.as_str())
                            .bind(generation.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_update_hold_spooled", err.to_string())
                            })?;
                            if updated.rows_affected() != 1 {
                                return Err(DomainError::validation(ValidationReason::InvalidState).into());
                            }
                        }
                    }
                }
                Ok(())
            })
        })
        .await
}

async fn validate_restore_cursor_tx(
    tx: &mut BackendConn<'_>,
    target: &ChangeCursor,
) -> Result<LeaseEpoch, PortError> {
    let space_rec = load_space_record_for_update_opt(tx, &target.scope.space_id)
        .await?
        .ok_or(DomainError::ResourceNotFound)?;

    // Restore MUST rotate HistoryIncarnation so old external tokens/receipts at >= ceiling are invalidated.
    if target.scope.incarnation == space_rec.scope.incarnation {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    if target.after != space_rec.last_seq {
        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
    }

    require_command_end_tx(tx, &space_rec.scope, target.after).await?;

    // Check no active backup hold on this Space.
    let hold_exists: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar("SELECT 1 FROM backup_holds WHERE space_id = ? LIMIT 1")
                .bind(target.scope.space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_restore_check_hold", err.to_string())
                })?
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar("SELECT 1::BIGINT FROM backup_holds WHERE space_id = $1 LIMIT 1")
                .bind(target.scope.space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_restore_check_hold", err.to_string()))?
        }
    };
    if hold_exists.is_some() {
        return Err(unavailable_retryable(
            "restore_blocked_by_backup_hold",
            "cannot restore Space cursors while a backup hold is active",
            Duration::from_millis(100),
        ));
    }

    Ok(space_rec.active_epoch.checked_next()?)
}

async fn apply_restore_cursor_tx(
    tx: &mut BackendConn<'_>,
    target: &ChangeCursor,
    next_epoch: LeaseEpoch,
) -> Result<bool, PortError> {
    let next_epoch_i64 = next_epoch.get() as i64;
    let sid = target.scope.space_id.as_str();
    let new_inc = target.scope.incarnation.as_bytes().as_slice();

    let mut rebound_retirements = false;
    // Vault bindings keep their physical identity and original incarnation.
    // They require reconciliation or explicit rebinding after this rotation.
    let history_scoped_tables = [
        "revisions",
        "revision_purge_fences",
        "blob_retirements",
        "change_commands",
        "change_log",
        "agent_run_heads",
        "board_move_history",
        "chat_threads",
        "pending_purges",
        "projection_rank_anchors",
    ];

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query("DELETE FROM command_receipts WHERE space_id = ?")
                .bind(sid)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_restore_clear_receipts", err.to_string())
                })?;

            sqlx::query(
                "DELETE FROM payload_owners
                 WHERE space_id = ? AND payload_kind = 'command_receipt'",
            )
            .bind(sid)
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_restore_clear_receipt_owners", err.to_string())
            })?;

            sqlx::query(
                "DELETE FROM change_payloads
                 WHERE space_id = ? AND codec = 'receipt_detail_v1'",
            )
            .bind(sid)
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_restore_clear_receipt_payloads", err.to_string())
            })?;

            for table in history_scoped_tables {
                let result = sqlx::query(sqlx::AssertSqlSafe(format!(
                    "UPDATE {table} SET history_incarnation = ? WHERE space_id = ?"
                )))
                .bind(new_inc)
                .bind(sid)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_restore_rebind_inc", err.to_string())
                })?;
                if table == "blob_retirements" {
                    rebound_retirements = result.rows_affected() > 0;
                }
            }

            sqlx::query(
                "UPDATE spaces
                 SET history_incarnation = ?, active_epoch = ?
                 WHERE space_id = ?",
            )
            .bind(new_inc)
            .bind(next_epoch_i64)
            .bind(sid)
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_restore_update_space", err.to_string())
            })?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query("DELETE FROM command_receipts WHERE space_id = $1")
                .bind(sid)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_restore_clear_receipts", err.to_string())
                })?;

            sqlx::query(
                "DELETE FROM payload_owners
                 WHERE space_id = $1 AND payload_kind = 'command_receipt'",
            )
            .bind(sid)
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("pg_restore_clear_receipt_owners", err.to_string())
            })?;

            sqlx::query(
                "DELETE FROM change_payloads
                 WHERE space_id = $1 AND codec = 'receipt_detail_v1'",
            )
            .bind(sid)
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("pg_restore_clear_receipt_payloads", err.to_string())
            })?;

            for table in history_scoped_tables {
                let result = sqlx::query(sqlx::AssertSqlSafe(format!(
                    "UPDATE {table} SET history_incarnation = $1 WHERE space_id = $2"
                )))
                .bind(new_inc)
                .bind(sid)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_restore_rebind_inc", err.to_string()))?;
                if table == "blob_retirements" {
                    rebound_retirements = result.rows_affected() > 0;
                }
            }

            sqlx::query(
                "UPDATE spaces
                 SET history_incarnation = $1, active_epoch = $2
                 WHERE space_id = $3",
            )
            .bind(new_inc)
            .bind(next_epoch_i64)
            .bind(sid)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_restore_update_space", err.to_string()))?;
        }
    }

    rebound_retirements |=
        crate::blobs::plan_unowned_active_blobs_tx(tx, &target.scope, next_epoch).await?;
    Ok(rebound_retirements)
}

// Stage the replacement in private memory. A read or validation error must roll
// back the SQL rotation before any subscriber can observe the new history.
async fn load_restored_room_fences(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    fences: &RoomFenceTable,
) -> Result<(), PortError> {
    let rows: Vec<(String, i64, String)> =
        match tx {
            BackendConn::Sqlite(conn) => sqlx::query_as(
                "SELECT note_id, lease_epoch, room_state FROM collab_sessions WHERE space_id = ? AND room_state <> 'closed'",
            )
            .bind(scope.space_id.as_str())
            .fetch_all(&mut **conn)
            .await,
            BackendConn::Postgres(conn) => sqlx::query_as(
                "SELECT note_id, lease_epoch, room_state FROM collab_sessions WHERE space_id = $1 AND room_state <> 'closed'",
            )
            .bind(scope.space_id.as_str())
            .fetch_all(&mut **conn)
            .await,
        }
        .map_err(|err| internal_not_committed("restore_load_room_fences", err.to_string()))?;

    for (note, epoch, state) in rows {
        let note = notarium_core::ids::NoteId::parse(&note)
            .map_err(|_| internal_not_committed("corrupt_collab_note", "invalid NoteId"))?;
        let epoch = LeaseEpoch::new(u64::try_from(epoch).map_err(|_| {
            internal_not_committed("corrupt_collab_lease", "negative lease_epoch")
        })?)?;
        fences
            .seed_persisted_room(scope, &note, epoch, state == "active")
            .await?;
        fences.set_room_fenced(&scope.space_id, &note, state == "fenced");
    }
    Ok(())
}

#[cfg(test)]
mod sqlite_sync_tests {
    use super::*;
    use crate::dialect::sqlite::{
        open_rusqlite_checkpoint_connection, open_rusqlite_writer_connection,
        open_sqlite_writer_connection,
    };

    #[test]
    fn schema_warm_returns_while_an_exclusive_writer_owns_the_file() {
        let root =
            std::env::temp_dir().join(crate::codec::new_prefixed_hex_id("schema-warm-").unwrap());
        std::fs::create_dir(&root).unwrap();
        let path = root.join("main.sqlite");
        let writer = rusqlite::Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL; CREATE TABLE data(v INTEGER);
             PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO data VALUES(1);",
            )
            .unwrap();

        let reader = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        reader.busy_timeout(Duration::ZERO).unwrap();
        let blocked = reader
            .query_row("SELECT 1 FROM main.sqlite_schema LIMIT 1", [], |_| Ok(()))
            .unwrap_err();
        assert_eq!(
            blocked.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        let initial_timeout_ms = 30_000_u32;
        reader
            .busy_timeout(Duration::from_millis(initial_timeout_ms.into()))
            .unwrap();

        let (started, start) = mpsc::sync_channel(0);
        let (finished, finish) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            let result = warm_sqlite_backup_schema(
                &reader,
                &[
                    SQLITE_CUT_SCHEMA,
                    SQLITE_CUT_HISTORIES,
                    SQLITE_CUT_RETIREMENTS,
                ],
            );
            let restored: u32 = reader
                .pragma_query_value(None, "busy_timeout", |row| row.get(0))
                .unwrap();
            finished
                .send((result, restored, reader.is_autocommit()))
                .unwrap();
        });
        start.recv().unwrap();
        let observed = finish.recv_timeout(Duration::from_secs(3));
        // An unguarded schema read may still be waiting. Release its writer before joining.
        drop(writer);
        let joined = worker.join();
        std::fs::remove_dir_all(root).unwrap();
        joined.unwrap();
        let (result, timeout_ms, autocommit) = observed.expect("schema warm waited for the writer");
        result.unwrap();
        assert_eq!(timeout_ms, initial_timeout_ms);
        assert!(autocommit);
    }

    #[tokio::test]
    async fn disk_writers_and_checkpoint_request_full_hardware_sync() {
        let root = std::env::temp_dir().join(format!(
            "notarium-sync-{}",
            hex::encode(crate::codec::csprng_16().unwrap())
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("main.sqlite");
        let mut sql = open_sqlite_writer_connection(&path).await.unwrap();
        const FLAGS: &str =
            "SELECT synchronous, fullfsync FROM pragma_synchronous, pragma_fullfsync";
        let flags: (i64, i64) = sqlx::query_as(FLAGS).fetch_one(&mut sql).await.unwrap();
        assert_eq!(flags, (2, 1));
        let target = root.join("backup.sqlite");
        std::fs::File::create(&target).unwrap();
        for conn in [
            open_rusqlite_writer_connection(&path).unwrap(),
            open_rusqlite_checkpoint_connection(&path).unwrap(),
            open_sqlite_backup_destination(&target).unwrap(),
        ] {
            let flags: (i64, i64) = conn
                .query_row(FLAGS, [], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            assert_eq!(flags, (2, 1));
        }
        sqlx::Connection::close(sql).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
