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
    ids::{ArtifactId, BackupId, ContentDigest},
};
use sqlx::PgConnection;

use super::{
    BackendConn, BackupArtifactEncoding, CanonicalInner, CanonicalStore, SqlDriverState,
    create_private_tmp_file, fsync_parent_dir, internal_not_committed, mint_artifact_id,
    open_backup_connection, register_cleanup_task, remove_tmp_artifacts, resolve_spool_dir,
    unavailable_retryable,
};

const HOLD_LOCK_SQL: &str = "SELECT pg_try_advisory_lock(hashtextextended(current_schema() || ':' || $1, 7311230)), set_config('application_name', $2, false)";

pub(super) enum HoldOwnership {
    Local(Weak<CanonicalInner>, BackupId),
    Postgres { connection: Box<PgConnection> },
}

impl HoldOwnership {
    pub(super) async fn acquire(
        store: &CanonicalStore,
        id: &BackupId,
        generation: &ArtifactId,
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
                let acquired: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(HOLD_LOCK_SQL))
                    .bind(id.as_str())
                    .bind(generation.as_str())
                    .fetch_one(&mut conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_backup_owner", err.to_string()))?;
                if acquired {
                    return Ok(Self::Postgres {
                        connection: Box::new(conn),
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

    // PostgreSQL never reconnects this socket. Transactions on it belong only to the
    // session which took this BackupId's advisory lock, including the empty-Space case.
    pub(super) async fn with_write_tx<F, T>(
        &mut self,
        store: &CanonicalStore,
        op: F,
    ) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>,
    {
        let Self::Postgres { connection } = self else {
            return store.with_write_tx(op).await;
        };
        let _gate = store.inner.writer()?.acquire_commit_read_guard().await;
        let mut backend = BackendConn::Postgres(connection);
        let mut transaction = crate::sql_exec::WriteTransaction::begin(&mut backend).await?;
        let value = op(&mut transaction.conn()).await?;
        transaction.commit().await?;
        Ok(value)
    }

    pub(super) async fn verify(&mut self) -> Result<(), PortError> {
        if let Self::Postgres { connection } = self {
            sqlx::raw_sql("SELECT 1")
                .execute(&mut **connection)
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
        let marker = self.directory.join(format!("{}.pending", self.id.as_str()));
        remove_tmp_artifacts(&self.directory.join(format!("{}.tmp", self.id.as_str())))?;
        fsync_parent_dir(&marker)?;
        remove_if_present(&marker)?;
        fsync_parent_dir(&marker)
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
    let ready: bool = store.with_read_tx(|tx| Box::pin(async move {
        match tx {
            BackendConn::Sqlite(conn) => sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM backup_artifacts WHERE artifact_id = ? AND state = 'ready')")
                .bind(lookup.as_str()).fetch_one(&mut **conn).await.map_err(|e|internal_not_committed("recover_sqlite_artifact", e.to_string())),
            BackendConn::Postgres(conn) => sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM backup_artifacts WHERE artifact_id = $1 AND state = 'ready')")
                .bind(lookup.as_str()).fetch_one(&mut **conn).await.map_err(|e|internal_not_committed("recover_pg_artifact", e.to_string())),
        }
    })).await?;
    remove_tmp_artifacts(&dir.join(format!("{}.tmp", id.as_str())))?;
    if !ready {
        for kind in [
            BackupArtifactEncoding::SqliteSnapshotV1,
            BackupArtifactEncoding::PostgresSpoolV1,
        ] {
            remove_if_present(&dir.join(format!("{}.{}", id.as_str(), kind.extension())))?;
        }
    }
    let marker = dir.join(format!("{}.pending", id.as_str()));
    fsync_parent_dir(&marker)?;
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
