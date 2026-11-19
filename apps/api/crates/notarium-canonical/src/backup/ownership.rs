use std::{
    fs::{File, OpenOptions, TryLockError},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::Duration,
};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ArtifactId, BackupId, ContentDigest, RequestId},
    ports::{CallBudget, Cancellation},
};
use sqlx::{PgConnection, Row};

use super::{
    BACKUP_CLEANUP_GRACE, BackendConn, BackupArtifactEncoding, CanonicalInner, CanonicalStore,
    SqlDriverState, cancelled_not_committed, create_private_tmp_file, deadline_not_committed,
    fsync_parent_dir, internal_not_committed, mint_artifact_id, open_backup_connection,
    register_cleanup_task, remove_tmp_artifacts, resolve_spool_dir, rollback_backup_connection,
    unavailable_retryable,
};

const HOLD_LOCK_SQL: &str = "SELECT pg_try_advisory_lock(hashtextextended(current_schema() || ':' || $1, 7311230)), set_config('application_name', $2, false), pg_backend_pid(), set_config('statement_timeout', $3, false)";

pub(super) async fn fence_artifact_publication(
    conn: &mut PgConnection,
    id: &ArtifactId,
) -> Result<(), PortError> {
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 7311233))",
    )
    .bind(id.as_str())
    .fetch_one(conn)
    .await
    .map_err(|err| internal_not_committed("pg_backup_artifact_fence", err.to_string()))?;
    if !acquired {
        return Err(unavailable_retryable(
            "backup_artifact_publication_pending",
            "artifact publication transaction is still active",
            Duration::from_millis(50),
        ));
    }
    Ok(())
}

pub(super) enum HoldOwnership {
    Local(Weak<CanonicalInner>, BackupId),
    Postgres {
        connection: Option<Box<PgConnection>>,
        pid: i32,
    },
}

#[derive(Clone, Copy)]
pub(super) struct HoldWriteBudget<'a> {
    pub(super) deadline: tokio::time::Instant,
    pub(super) cancellation: Option<&'a Cancellation>,
}

impl HoldWriteBudget<'_> {
    fn cancelled() -> PortError {
        cancelled_not_committed("backup_owner_write", "backup SQL cancelled before COMMIT")
    }

    fn expired() -> PortError {
        deadline_not_committed("backup_owner_write", "backup SQL deadline expired")
    }

    fn check(self) -> Result<(), PortError> {
        if self.cancellation.is_some_and(Cancellation::is_cancelled) {
            return Err(Self::cancelled());
        }
        if tokio::time::Instant::now() >= self.deadline {
            return Err(Self::expired());
        }
        Ok(())
    }

    pub(super) async fn admit<T>(self, action: impl Future<Output = T>) -> Result<T, PortError> {
        self.check()?;
        let wait = tokio::time::timeout_at(self.deadline, action);
        let result = if let Some(cancellation) = self.cancellation {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(Self::cancelled()),
                result = wait => result,
            }
        } else {
            wait.await
        };
        let result = result.map_err(|_| Self::expired())?;
        self.check()?;
        Ok(result)
    }
}

impl HoldOwnership {
    pub(super) async fn acquire(
        store: &CanonicalStore,
        id: &BackupId,
        generation: &ArtifactId,
        deadline: tokio::time::Instant,
    ) -> Result<Self, PortError> {
        match &store.inner.sql {
            SqlDriverState::Sqlite { .. } => {
                if store
                    .inner
                    .backup_local_holds
                    .lock()
                    .expect("backup hold owners")
                    .insert(id.clone())
                {
                    return Ok(Self::Local(Arc::downgrade(&store.inner), id.clone()));
                }
            }
            SqlDriverState::Postgres { .. } => {
                let mut conn = open_backup_connection(store).await?;
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                let timeout = remaining
                    .saturating_add(Duration::from_secs(1))
                    .as_millis()
                    .min(i32::MAX as u128);
                let row = sqlx::query(sqlx::AssertSqlSafe(HOLD_LOCK_SQL))
                    .bind(id.as_str())
                    .bind(generation.as_str())
                    .bind(format!("{timeout}ms"))
                    .fetch_one(&mut conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_backup_owner", err.to_string()))?;
                if row.get::<bool, _>(0) {
                    return Ok(Self::Postgres {
                        connection: Some(Box::new(conn)),
                        pid: row.get(2),
                    });
                }
            }
        }
        Err(unavailable_retryable(
            "backup_id_in_use",
            "another hold owns this BackupId",
            Duration::from_millis(50),
        ))
    }

    // Dropping the client future alone does not wake a backend waiting on a row
    // lock. The generation tag prevents a recycled PID from matching this owner.
    pub(super) async fn interrupt_acquisition(
        &mut self,
        store: &CanonicalStore,
        generation: &ArtifactId,
    ) -> Result<(), PortError> {
        let Self::Postgres { pid, .. } = self else {
            return Ok(());
        };
        interrupt_pg_session(store, *pid, generation).await
    }

    // PostgreSQL never reconnects this socket. Transactions on it belong only to the
    // session which took this BackupId's advisory lock, including the empty-Space case.
    pub(super) async fn with_write_tx<F, T>(
        &mut self,
        store: &CanonicalStore,
        budget: HoldWriteBudget<'_>,
        op: F,
    ) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        store.ensure_open()?;
        let _gate = budget
            .admit(store.inner.writer()?.acquire_commit_read_guard())
            .await?;
        let Self::Postgres { connection, .. } = self else {
            let SqlDriverState::Sqlite { writer, .. } = &store.inner.sql else {
                unreachable!("local hold on PostgreSQL")
            };
            let mut guard = budget.admit(writer.lock()).await?;
            let pair = guard.as_mut().ok_or_else(hold_connection_closed)?;
            // Once SQLite admits BEGIN the writer owns the transaction through
            // rollback or COMMIT. Only the reversible waits above may be abandoned.
            return store
                .write_sqlite_transaction(&mut pair.sqlx_conn, op, || budget.check())
                .await;
        };
        let conn = connection.as_mut().ok_or_else(hold_connection_closed)?;
        let unknown = || {
            crate::codec::unknown_commit_non_idempotent(
                "backup_owner_commit",
                "backup transaction commit was not acknowledged",
            )
        };
        let mut committing = false;
        let write = async {
            let mut backend = BackendConn::Postgres(conn);
            let mut transaction = crate::sql_exec::WriteTransaction::begin(&mut backend).await?;
            let value = op(&mut transaction.conn()).await?;
            budget.check()?;
            committing = true;
            tokio::time::timeout(BACKUP_CLEANUP_GRACE, transaction.commit())
                .await
                .map_err(|_| unknown())??;
            Ok(value)
        };
        let result = tokio::time::timeout_at(budget.deadline, write)
            .await
            .unwrap_or_else(|_| {
                Err(if committing {
                    unknown()
                } else {
                    HoldWriteBudget::expired()
                })
            });
        if result.is_err()
            && rollback_backup_connection(conn, "backup_owner_rollback")
                .await
                .is_err()
        {
            drop(connection.take());
        }
        result
    }

    pub(super) async fn verify(&mut self) -> Result<(), PortError> {
        if let Self::Postgres { connection, .. } = self {
            let conn = connection.as_mut().ok_or_else(hold_connection_closed)?;
            sqlx::raw_sql("SELECT 1")
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    unavailable_retryable(
                        "pg_backup_hold_lost",
                        err.to_string(),
                        Duration::from_millis(50),
                    )
                })?;
        }
        Ok(())
    }
}

fn hold_connection_closed() -> PortError {
    unavailable_retryable(
        "pg_backup_hold_lost",
        "backup hold connection closed",
        Duration::from_millis(50),
    )
}

pub(super) async fn interrupt_pg_session(
    store: &CanonicalStore,
    pid: i32,
    generation: &ArtifactId,
) -> Result<(), PortError> {
    tokio::time::timeout(Duration::from_secs(2), async {
            let mut control = open_backup_connection(store).await?;
            let terminated: Option<bool> = sqlx::query_scalar(
                "SELECT pg_terminate_backend(pid, 1000) FROM pg_stat_activity
                 WHERE pid = $1 AND application_name = $2 AND usename = current_user AND datname = current_database()",
            ).bind(pid).bind(generation.as_str()).fetch_optional(&mut control).await
             .map_err(|err| internal_not_committed("pg_interrupt_backup_session", err.to_string()))?;
            if terminated == Some(false) {
                return Err(internal_not_committed("pg_interrupt_backup_session", "PostgreSQL could not stop the storage transaction"));
            }
            Ok(())
        }).await.map_err(|_| unavailable_retryable("pg_interrupt_backup_session", "PostgreSQL cancellation timed out", Duration::from_millis(50)))?
}

impl Drop for HoldOwnership {
    fn drop(&mut self) {
        if let Self::Local(weak, id) = self
            && let Some(inner) = weak.upgrade()
        {
            inner
                .backup_local_holds
                .lock()
                .expect("backup hold owners")
                .remove(id);
        }
    }
}

pub(super) async fn recover_holds(store: &CanonicalStore) -> Result<(), PortError> {
    store.with_write_tx(|tx| Box::pin(async move {
        match tx {
            BackendConn::Sqlite(conn) => {
                // Startup already holds the exclusive DataRoot owner lock.
                sqlx::query("DELETE FROM backup_holds")
                    .execute(&mut **conn).await
                    .map_err(|e| internal_not_committed("recover_sqlite_backup_holds", e.to_string()))?;
            }
            BackendConn::Postgres(conn) => {
                // A live CAS copy keeps the matching session lock beyond snapshot release.
                sqlx::query("DELETE FROM backup_holds WHERE backup_id IN (
                    SELECT h.backup_id FROM (SELECT DISTINCT backup_id FROM backup_holds) h
                    WHERE pg_try_advisory_xact_lock(hashtextextended(current_schema() || ':' || h.backup_id, 7311230)))")
                    .execute(&mut **conn).await
                    .map_err(|e| internal_not_committed("recover_pg_backup_holds", e.to_string()))?;
            }
        }
        Ok(())
    })).await
}

pub(super) async fn reap_abandoned_holds(
    store: &CanonicalStore,
    budget: &notarium_core::ports::CallBudget,
    after: String,
) -> Result<Option<String>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(budget, "reap_archive_holds");
    store.with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
        Box::pin(async move {
            let BackendConn::Postgres(conn) = tx else {
                return Ok(None);
            };
            let error = |e: sqlx::Error| internal_not_committed("reap_archive_holds", e.to_string());
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT DISTINCT backup_id FROM backup_holds
                 WHERE backup_id>$1 ORDER BY backup_id LIMIT 16",
            ).bind(after).fetch_all(&mut **conn).await.map_err(error)?;
            for id in &ids {
                sqlx::query(
                    "DELETE FROM backup_holds WHERE backup_id=$1 AND
                     pg_try_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 7311230))",
                ).bind(id).execute(&mut **conn).await.map_err(error)?;
            }
            Ok(ids.into_iter().last())
        })
    }).await
}

fn fs_error(err: std::io::Error) -> PortError {
    internal_not_committed("backup_artifact_namespace", err.to_string())
}

// A durable directory identity distinguishes spool volumes, including matching paths
// on different cloud nodes. Registry rows only contain this identity and an opaque file name.
fn namespace(dir: &Path) -> Result<ArtifactId, PortError> {
    let path = dir.join(".spool-id");
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&path).map_err(fs_error)?;
    file.lock().map_err(fs_error)?;
    if file.metadata().map_err(fs_error)?.len() == 0 {
        let id = mint_artifact_id()?;
        file.write_all(id.as_str().as_bytes()).map_err(fs_error)?;
        file.sync_all().map_err(fs_error)?;
        fsync_parent_dir(&path)?;
        return Ok(id);
    }
    file.seek(SeekFrom::Start(0)).map_err(fs_error)?;
    let mut value = String::new();
    file.take(128)
        .read_to_string(&mut value)
        .map_err(fs_error)?;
    Ok(ArtifactId::parse_v1(&value)?)
}

// The same local directory can be configured for separate databases. Only the original
// database may decide whether an abandoned publication committed its registry row.
fn registry_identity(store: &CanonicalStore) -> String {
    let location = match &store.inner.config.sql {
        crate::config::SqlBackendConfig::Sqlite { data_root, .. } => {
            format!("sqlite:{:?}", data_root.canonical())
        }
        crate::config::SqlBackendConfig::Postgres {
            connect, schema, ..
        } => format!(
            "postgres:{:?}:{}:{}",
            connect.transport, connect.database, schema
        ),
    };
    let mut hash = blake3::Hasher::new();
    hash.update(store.installation_id().as_str().as_bytes());
    hash.update(location.as_bytes());
    hash.finalize().to_hex().to_string()
}

pub(super) struct ArtifactLease {
    store: CanonicalStore,
    directory: PathBuf,
    id: ArtifactId,
    namespace: ArtifactId,
    lock: Option<File>,
    publishing: bool,
}

impl ArtifactLease {
    pub(super) fn create(
        store: &CanonicalStore,
        dir: &Path,
        id: &ArtifactId,
    ) -> Result<Self, PortError> {
        let namespace = namespace(dir)?;
        let marker = dir.join(format!("{}.pending", id.as_str()));
        let mut lock = create_private_tmp_file(&marker)?;
        lock.try_lock()
            .map_err(|e| internal_not_committed("backup_artifact_lock", e.to_string()))?;
        // Recovery can win the short create-to-lock interval. No data was created yet.
        if !marker.try_exists().map_err(fs_error)? {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        // A fresh pending lock grants ownership only if this ID has no
        // previously staged or accepted file in the volume.
        for suffix in [
            "sqlite",
            "pgspool",
            "unclaimed",
            "tmp",
            "tmp-journal",
            "tmp-wal",
            "tmp-shm",
        ] {
            let existing = dir.join(format!("{}.{suffix}", id.as_str()));
            match existing.symlink_metadata() {
                Ok(_) => {
                    remove_if_present(&marker)?;
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(fs_error(error)),
            }
        }
        lock.write_all(registry_identity(store).as_bytes())
            .map_err(fs_error)?;
        lock.sync_all().map_err(fs_error)?;
        fsync_parent_dir(&marker)?;
        Ok(Self {
            store: store.clone(),
            directory: dir.to_owned(),
            id: id.clone(),
            namespace,
            lock: Some(lock),
            publishing: false,
        })
    }

    pub(super) fn key(&self, filename: &str) -> String {
        format!("{}/{}", self.namespace.as_str(), filename)
    }

    pub(super) fn begin_publication(&mut self) {
        self.publishing = true;
    }
    pub(super) fn offer_durable(&self) -> Result<(), PortError> {
        let offer = self
            .directory
            .join(format!("{}.unclaimed", self.id.as_str()));
        create_private_tmp_file(&offer)?
            .sync_all()
            .map_err(fs_error)?;
        fsync_parent_dir(&offer)
    }

    pub(super) async fn reconcile_pending(&self) -> Result<(), PortError> {
        let marker = self.directory.join(format!("{}.pending", self.id.as_str()));
        if marker.try_exists().map_err(fs_error)?
            && let Some(file) = &self.lock
        {
            reconcile(
                &self.store,
                &self.directory,
                &self.id,
                file.try_clone().map_err(fs_error)?,
            )
            .await?;
        }
        Ok(())
    }

    pub(super) fn accepted(&self) -> Result<(), PortError> {
        let offer = self
            .directory
            .join(format!("{}.unclaimed", self.id.as_str()));
        let marker = self.directory.join(format!("{}.pending", self.id.as_str()));
        remove_tmp_artifacts(&self.directory.join(format!("{}.tmp", self.id.as_str())))?;
        // Until receipt acceptance, an unclaimed registry row is disposable.
        remove_if_present(&offer)?;
        fsync_parent_dir(&offer).map_err(|err| {
            crate::codec::unknown_commit_non_idempotent("backup_spool_acceptance", err.to_string())
        })?;
        // The durable receipt already owns the file. Recovery may finish
        // removing a pending marker if the cleanup fails.
        if let Err(error) = remove_if_present(&marker).and_then(|()| fsync_parent_dir(&marker)) {
            tracing::warn!(?error, "accepted backup spool has a pending marker");
        }
        Ok(())
    }

    pub(super) fn remove_temporary(&self) -> Result<(), PortError> {
        finish_recovery(&self.directory, &self.id, false)
    }
}

pub(super) fn remove_if_present(path: &Path) -> Result<(), PortError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(fs_error(e)),
    }
}

impl Drop for ArtifactLease {
    fn drop(&mut self) {
        let marker = self.directory.join(format!("{}.pending", self.id.as_str()));
        if !self.publishing {
            let tmp = self.directory.join(format!("{}.tmp", self.id.as_str()));
            if remove_tmp_artifacts(&tmp).is_ok() && fsync_parent_dir(&marker).is_ok() {
                let _ = remove_if_present(&marker);
            }
            return;
        }
        if !marker.exists() {
            return;
        }
        if let Some(lock) = self.lock.take() {
            let rt = &self.store.inner.backup_executor;
            let store = self.store.clone();
            let dir = self.directory.clone();
            let id = self.id.clone();
            register_cleanup_task(
                &self.store.inner,
                rt.spawn(async move {
                    let _ = reconcile(&store, &dir, &id, lock).await;
                }),
            );
        }
    }
}

async fn reconcile(
    store: &CanonicalStore,
    dir: &Path,
    id: &ArtifactId,
    _lock: File,
) -> Result<(), PortError> {
    let lookup = id.clone();
    // Use a fresh PostgreSQL snapshot after the fence. An unresolved COMMIT
    // can still publish the pointer after the publishing client disconnects.
    let ready: Option<String> = store.with_read_tx_budget_pg_local_sql(
        None,
        Some("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"),
        |tx| Box::pin(async move {
        match tx {
            BackendConn::Sqlite(conn) => sqlx::query_scalar("SELECT artifact_rel_path FROM backup_artifacts WHERE artifact_id = ? AND state = 'ready'")
                .bind(lookup.as_str()).fetch_optional(&mut **conn).await.map_err(|e|internal_not_committed("recover_sqlite_artifact", e.to_string())),
            BackendConn::Postgres(conn) => {
                fence_artifact_publication(conn, &lookup).await?;
                sqlx::query_scalar("SELECT artifact_rel_path FROM backup_artifacts WHERE artifact_id = $1 AND state = 'ready'")
                    .bind(lookup.as_str()).fetch_optional(&mut **conn).await.map_err(|e|crate::runtime::pg_read_error("recover_pg_artifact", e))
            }
        }
    })).await?;
    let mut keep = false;
    if let Some(key) = ready {
        let (volume, filename) = key
            .split_once('/')
            .map_or((None, key.as_str()), |(volume, name)| (Some(volume), name));
        let matches_file = [
            BackupArtifactEncoding::SqliteSnapshotV1,
            BackupArtifactEncoding::PostgresSpoolV1,
        ]
        .into_iter()
        .any(|kind| filename == format!("{}.{}", id.as_str(), kind.extension()));
        if matches_file {
            if let Some(volume) = volume {
                if volume == namespace(dir)?.as_str() {
                    let offer = dir.join(format!("{}.unclaimed", id.as_str()));
                    if offer.try_exists().map_err(fs_error)? {
                        forget_unclaimed_artifact(store, id.clone(), key).await?;
                    } else {
                        keep = true;
                    }
                }
            } else {
                // Legacy registry entries have no spool volume in the key.
                keep = true;
            }
        }
    }
    finish_recovery(dir, id, keep)
}

async fn forget_unclaimed_artifact(
    store: &CanonicalStore,
    id: ArtifactId,
    key: String,
) -> Result<(), PortError> {
    let budget = CallBudget {
        request: RequestId::from_bytes(crate::codec::ordered_id_16()?),
        cancellation: Cancellation::default(),
        remaining: BACKUP_CLEANUP_GRACE,
    };
    let deadline =
        crate::domain::common::CommandDeadline::start(&budget, "forget_unclaimed_backup");
    store.with_auxiliary_command(Some((&budget, deadline)), Ok, |tx| Box::pin(async move {
        let delete = "DELETE FROM backup_artifacts WHERE artifact_id = $1 AND artifact_rel_path = $2";
        let result = match tx {
            BackendConn::Sqlite(conn) => sqlx::query(delete)
                .bind(id.as_str()).bind(&key).execute(&mut **conn).await.map(drop),
            BackendConn::Postgres(conn) => {
                fence_artifact_publication(conn, &id).await?;
                sqlx::query(delete).bind(id.as_str()).bind(&key).execute(&mut **conn).await.map(drop)
            }
        };
        result.map_err(|err| internal_not_committed("forget_unclaimed_backup", err.to_string()))
    })).await
}

fn finish_recovery(dir: &Path, id: &ArtifactId, keep: bool) -> Result<(), PortError> {
    remove_tmp_artifacts(&dir.join(format!("{}.tmp", id.as_str())))?;
    if !keep {
        for kind in [
            BackupArtifactEncoding::SqliteSnapshotV1,
            BackupArtifactEncoding::PostgresSpoolV1,
        ] {
            remove_if_present(&dir.join(format!("{}.{}", id.as_str(), kind.extension())))?;
        }
    }
    let marker = dir.join(format!("{}.pending", id.as_str()));
    fsync_parent_dir(&marker)?;
    remove_if_present(&dir.join(format!("{}.unclaimed", id.as_str())))?;
    remove_if_present(&marker)?;
    fsync_parent_dir(&marker)
}

pub(super) async fn recover_directory(store: &CanonicalStore, dir: &Path) -> Result<(), PortError> {
    for entry in std::fs::read_dir(dir).map_err(fs_error)? {
        let entry = entry.map_err(fs_error)?;
        let name = entry.file_name();
        let Some(raw) = name.to_str().and_then(|x| x.strip_suffix(".pending")) else {
            continue;
        };
        let Ok(id) = ArtifactId::parse_v1(raw) else {
            continue;
        };
        let mut file = match File::open(entry.path()) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(fs_error(e)),
        };
        match file.try_lock() {
            Ok(()) => {
                let mut owner = String::new();
                (&mut file)
                    .take(65)
                    .read_to_string(&mut owner)
                    .map_err(fs_error)?;
                if owner == registry_identity(store) {
                    reconcile(store, dir, &id, file).await?;
                } else if owner.is_empty() {
                    // There can be no artifact before the exclusive marker is initialized.
                    remove_if_present(&entry.path())?;
                }
            }
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(e)) => return Err(fs_error(e)),
        }
    }
    Ok(())
}

pub(super) fn locate(
    store: &CanonicalStore,
    id: &ArtifactId,
    encoding: BackupArtifactEncoding,
    key: &str,
    size: u64,
    digest: ContentDigest,
) -> Result<PathBuf, PortError> {
    let (expected_namespace, filename) = key
        .split_once('/')
        .map_or((None, key), |(ns, name)| (Some(ns), name));
    if filename != format!("{}.{}", id.as_str(), encoding.extension()) {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    let current = resolve_spool_dir(&store.inner)?;
    let mut roots = store
        .inner
        .backup_spool_roots
        .lock()
        .expect("backup spool roots")
        .clone();
    roots.push(current);
    for root in roots {
        let path = root.join(filename);
        if !path.try_exists().map_err(fs_error)? {
            continue;
        }
        if let Some(expected) = expected_namespace
            && expected != namespace(&root)?.as_str()
        {
            continue;
        }
        if !path.symlink_metadata().map_err(fs_error)?.is_file() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let mut file = File::open(&path).map_err(fs_error)?;
        if file.metadata().map_err(fs_error)?.len() != size {
            return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
        }
        let mut hasher = blake3::Hasher::new();
        std::io::copy(&mut file, &mut hasher).map_err(fs_error)?;
        if hasher.finalize().as_bytes() != digest.as_bytes() {
            return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
        }
        return Ok(path);
    }
    Err(unavailable_retryable(
        "backup_artifact_not_local",
        "required backup spool volume is unavailable",
        Duration::from_secs(1),
    ))
}
