use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, ProjectionGeneration},
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection as _, PgConnection, PgPool};

use super::{
    internal, invalid_row,
    records::{decode, encode},
    sql::{
        Database, Kind, SqlColumn, SqlFuture, SqlTransaction, validate_schema_prefix, value,
        write_postgres_on,
    },
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GenerationDescriptor {
    pub generation: ProjectionGeneration,
    pub publication_epoch: u64,
    /// Binds the selection to the compared catalog and Space command ends.
    pub cut_fingerprint: ContentDigest,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct DescriptorState {
    active: Option<GenerationDescriptor>,
    candidate: Option<GenerationDescriptor>,
}

impl DescriptorState {
    fn reclaimable(&self, generation: ProjectionGeneration) -> bool {
        self.active.as_ref().map(|d| d.generation) != Some(generation)
            && self.candidate.as_ref().map(|d| d.generation) != Some(generation)
    }
}

enum ControlBackend {
    Local(PathBuf),
    Postgres(PostgresControl),
}

struct PostgresControl {
    database: Arc<Database>,
    schema_prefix: String,
    cleanup_identity: String,
    coordinator: Option<tokio::sync::Mutex<PgConnection>>,
}

impl PostgresControl {
    async fn write<T: Send + 'static>(
        &self,
        operation: impl for<'a> FnOnce(SqlTransaction<'a>) -> SqlFuture<'a, T> + Send + 'static,
    ) -> Result<T, PortError> {
        if let Some(session) = &self.coordinator {
            let (_, schema) = self.database.postgres_config().ok_or_else(invalid_row)?;
            let mut session = session.lock().await;
            return write_postgres_on(&mut session, schema, operation).await;
        }
        self.database.write(false, operation).await
    }
}

/// Serializes single-owner candidate selection and durable activation
/// independently from databases and checkpoint files belonging to individual
/// generations.
#[derive(Clone)]
pub struct GenerationControl(Arc<ControlBackend>);

impl GenerationControl {
    /// A fresh PostgreSQL backend holds the coordinator lock across the separate
    /// transactions that build and publish a candidate. Closing that backend
    /// releases the lock even if the coordinator is cancelled or its host dies.
    /// SQLite already holds the installation's runtime file lock.
    pub(crate) async fn acquire_coordinator(&self) -> Result<Self, PortError> {
        let ControlBackend::Postgres(pg) = self.0.as_ref() else {
            return Ok(self.clone());
        };
        let (pool, schema) = pg.database.postgres_config().ok_or_else(invalid_row)?;
        let mut session = pool
            .acquire()
            .await
            .map_err(|_| internal("projection_coordinator_connection"))?
            .detach();
        let acquired: bool =
            sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1, 251851))")
                .bind(schema)
                .fetch_one(&mut session)
                .await
                .map_err(|_| internal("projection_coordinator_lock"))?;
        if !acquired {
            let _ = session.close().await;
            return Err(super::not_ready());
        }
        Ok(Self(Arc::new(ControlBackend::Postgres(PostgresControl {
            database: Arc::clone(&pg.database),
            schema_prefix: pg.schema_prefix.clone(),
            cleanup_identity: pg.cleanup_identity.clone(),
            coordinator: Some(tokio::sync::Mutex::new(session)),
        }))))
    }

    pub async fn open_sqlite(root: &DataRoot) -> Result<Self, PortError> {
        let path = root.active_projection_generation();
        let directory = path.parent().ok_or_else(invalid_row)?.to_owned();
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&directory).map_err(|_| internal("projection_control_directory"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                    .map_err(|_| internal("projection_control_permissions"))?;
            }
            Ok::<_, PortError>(())
        })
        .await
        .map_err(|_| internal("projection_control_worker"))??;
        let control = Self(Arc::new(ControlBackend::Local(path)));
        control.active().await?;
        Ok(control)
    }

    pub async fn open_postgres(pool: PgPool, schema_prefix: &str) -> Result<Self, PortError> {
        let schema_prefix = validate_schema_prefix(schema_prefix)?.to_owned();
        let schema = format!("{schema_prefix}_ctrl");
        let database = Arc::new(Database::open_postgres(pool, &schema).await?);
        let cleanup_identity = database
            .write(false, |mut tx| {
                Box::pin(async move {
                    let has_column = !tx
                        .select(
                            "SELECT CAST(1 AS BIGINT) FROM pg_catalog.pg_attribute a
                             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = current_schema()
                               AND c.relname = 'projection_generation_control'
                               AND a.attname = 'cleanup_identity'
                               AND NOT a.attisdropped",
                            Vec::new(),
                            &[Kind::Integer],
                        )
                        .await?
                        .is_empty();
                    if !has_column {
                        tx.batch(
                            "SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 272014));
                             CREATE TABLE IF NOT EXISTS projection_generation_control (
                                 row_id BIGINT PRIMARY KEY CHECK (row_id = 1),
                                 descriptor BYTEA NOT NULL,
                                 cleanup_identity UUID NOT NULL DEFAULT gen_random_uuid()
                             );",
                        )
                        .await?;
                        let still_missing = tx
                            .select(
                                "SELECT CAST(1 AS BIGINT) FROM pg_catalog.pg_attribute a
                                 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                                 WHERE n.nspname = current_schema()
                                   AND c.relname = 'projection_generation_control'
                                   AND a.attname = 'cleanup_identity'
                                   AND NOT a.attisdropped",
                                Vec::new(),
                                &[Kind::Integer],
                            )
                            .await?
                            .is_empty();
                        if still_missing {
                            tx.batch(
                                "ALTER TABLE projection_generation_control ADD COLUMN IF NOT EXISTS
                                     cleanup_identity UUID NOT NULL DEFAULT gen_random_uuid();",
                            )
                            .await?;
                        }
                    }
                    if let Some(identity) = try_read_cleanup_identity(&mut tx).await? {
                        return Ok(identity);
                    }
                    tx.execute(
                        "INSERT INTO projection_generation_control (row_id, descriptor) VALUES (1, ?)
                         ON CONFLICT (row_id) DO NOTHING",
                        vec![value(&encode(&DescriptorState::default())?)],
                    )
                    .await?;
                    read_cleanup_identity(&mut tx).await
                })
            })
            .await?;
        let control = Self(Arc::new(ControlBackend::Postgres(PostgresControl {
            database,
            schema_prefix,
            cleanup_identity,
            coordinator: None,
        })));
        control.active().await?;
        Ok(control)
    }

    /// PostgreSQL peers share a derived installation while each owns a local mmap cache.
    pub(crate) fn cleanup_identity<'a>(&'a self, cache_identity: &'a str) -> &'a str {
        match &*self.0 {
            ControlBackend::Postgres(pg) => &pg.cleanup_identity,
            ControlBackend::Local(_) => cache_identity,
        }
    }

    pub(crate) async fn verify_cleanup_identity(&self) -> Result<(), PortError> {
        if let ControlBackend::Postgres(pg) = &*self.0 {
            let current = pg
                .database
                .read(|mut tx| Box::pin(async move { read_cleanup_identity(&mut tx).await }))
                .await?;
            if current != pg.cleanup_identity {
                return Err(super::not_ready());
            }
        }
        Ok(())
    }

    pub(crate) fn is_postgres(&self) -> bool {
        matches!(&*self.0, ControlBackend::Postgres(_))
    }

    pub async fn active(&self) -> Result<Option<GenerationDescriptor>, PortError> {
        Ok(self.read().await?.active)
    }

    pub async fn candidate(&self) -> Result<Option<GenerationDescriptor>, PortError> {
        Ok(self.read().await?.candidate)
    }

    /// Returns true if `generation` is neither the active generation nor a
    /// reserved rotation candidate and may be safely reclaimed.
    pub(crate) async fn generation_reclaimable(
        &self,
        generation: ProjectionGeneration,
    ) -> Result<bool, PortError> {
        Ok(self.read().await?.reclaimable(generation))
    }

    /// Called after admission to the sole cache owner. A process that failed
    /// before the swap leaves a disposable reservation and candidate.
    pub(crate) async fn clear_interrupted_rotation(&self) -> Result<(), PortError> {
        let Some(candidate) = self.candidate().await? else {
            return Ok(());
        };
        match self.cancel_candidate(&candidate).await {
            Ok(_) => Ok(()),
            Err(error) => {
                if !self.is_postgres() && self.local_rotation_witness().await?.candidate.is_none() {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
    }

    /// Resets an obsolete candidate PostgreSQL generation schema while holding
    /// the control row lock so no concurrent rotation can observe half-dropped
    /// tables.
    pub(crate) async fn reset_obsolete_postgres_candidate(
        &self,
        expected: &GenerationDescriptor,
        candidate: &GenerationDescriptor,
    ) -> Result<(), PortError> {
        let ControlBackend::Postgres(pg) = &*self.0 else {
            return Err(invalid_row());
        };
        let expected = expected.clone();
        let candidate = candidate.clone();
        let schema = format!("{}_g{}", pg.schema_prefix, candidate.generation.get());
        pg.write(move |mut tx| {
            Box::pin(async move {
                let state = read_postgres(&mut tx, true).await?;
                if state.active.as_ref() != Some(&expected)
                    || state.candidate.as_ref() != Some(&candidate)
                {
                    return Err(
                        DomainError::validation(ValidationReason::GenerationMismatch).into(),
                    );
                }
                super::maintenance::reset_obsolete_postgres(&mut tx, &schema, candidate.generation)
                    .await
            })
        })
        .await
    }

    /// A CAS whose rename may have succeeded is inspected after taking the
    /// same lock as the writer. Retry the directory sync to establish
    /// durability if its first attempt lost the result.
    pub(crate) async fn local_rotation_witness(&self) -> Result<LocalRotationWitness, PortError> {
        let ControlBackend::Local(path) = self.0.as_ref() else {
            return Err(invalid_row());
        };
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            let _lock = lock_local(&path)?;
            let state = read_local_unlocked(&path)?;
            let durable = sync_descriptor_directory(&path).is_ok();
            Ok(LocalRotationWitness {
                active: state.active,
                candidate: state.candidate,
                durable,
            })
        })
        .await
        .map_err(|_| internal("projection_control_worker"))?
    }

    pub async fn reserve_candidate(
        &self,
        expected: Option<&GenerationDescriptor>,
        next: &GenerationDescriptor,
    ) -> Result<bool, PortError> {
        validate_transition(expected, next)?;
        let expected = expected.cloned();
        let next = next.clone();
        self.update(move |state| {
            if state.active != expected {
                return false;
            }
            match state.candidate.as_ref() {
                Some(candidate) => candidate == &next,
                None => {
                    state.candidate = Some(next);
                    true
                }
            }
        })
        .await
    }

    pub async fn compare_and_swap(
        &self,
        expected: Option<&GenerationDescriptor>,
        next: &GenerationDescriptor,
    ) -> Result<bool, PortError> {
        validate_transition(expected, next)?;
        let expected = expected.cloned();
        let next = next.clone();
        self.update(move |state| {
            if state.active != expected
                || (expected.is_some() && state.candidate.is_none())
                || state.candidate.as_ref().is_some_and(|candidate| {
                    candidate.generation != next.generation
                        || candidate.publication_epoch != next.publication_epoch
                })
            {
                return false;
            }
            state.active = Some(next);
            state.candidate = None;
            true
        })
        .await
    }

    pub async fn cancel_candidate(
        &self,
        expected: &GenerationDescriptor,
    ) -> Result<bool, PortError> {
        let expected = expected.clone();
        self.update(move |state| {
            if state.candidate.as_ref() != Some(&expected) {
                return false;
            }
            state.candidate = None;
            true
        })
        .await
    }

    async fn read(&self) -> Result<DescriptorState, PortError> {
        match &*self.0 {
            ControlBackend::Local(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || read_local(&path))
                    .await
                    .map_err(|_| internal("projection_control_worker"))?
            }
            ControlBackend::Postgres(pg) => {
                pg.database
                    .read(|mut tx| Box::pin(async move { read_postgres(&mut tx, false).await }))
                    .await
            }
        }
    }

    async fn update(
        &self,
        operation: impl FnOnce(&mut DescriptorState) -> bool + Send + 'static,
    ) -> Result<bool, PortError> {
        match &*self.0 {
            ControlBackend::Local(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || {
                    let _lock = lock_local(&path)?;
                    let mut state = read_local_unlocked(&path)?;
                    if !operation(&mut state) {
                        return Ok(false);
                    }
                    write_local(&path, &state)?;
                    Ok(true)
                })
                .await
                .map_err(|_| internal("projection_control_worker"))?
            }
            ControlBackend::Postgres(pg) => {
                pg.write( move |mut tx| {
                        Box::pin(async move {
                            let mut state = read_postgres(&mut tx, true).await?;
                            if !operation(&mut state) {
                                return Ok(false);
                            }
                            tx.execute(
                                "UPDATE projection_generation_control SET descriptor = ? WHERE row_id = 1",
                                vec![value(&encode(&state)?)],
                            )
                            .await?;
                            Ok(true)
                        })
                    })
                    .await
            }
        }
    }
}

/// Recheck eligibility in the DROP transaction. A coordinator cannot reserve
/// or promote this generation between this read and removal of its schema.
pub(super) async fn lock_reclaimable_postgres(
    tx: &mut SqlTransaction<'_>,
    prefix: &str,
    generation: ProjectionGeneration,
) -> Result<bool, PortError> {
    let prefix = validate_schema_prefix(prefix)?;
    tx.batch(&format!(
        "SET LOCAL search_path TO \"{prefix}_ctrl\", pg_catalog"
    ))
    .await?;
    Ok(read_postgres(tx, true).await?.reclaimable(generation))
}

pub(crate) struct LocalRotationWitness {
    pub active: Option<GenerationDescriptor>,
    pub candidate: Option<GenerationDescriptor>,
    pub durable: bool,
}

impl LocalRotationWitness {
    pub(crate) fn selected(&self, generation: ProjectionGeneration) -> bool {
        self.active
            .iter()
            .chain(&self.candidate)
            .any(|descriptor| descriptor.generation == generation)
    }

    pub(crate) fn excludes_writers(&self, generation: ProjectionGeneration) -> bool {
        self.durable && self.active.is_some() && !self.selected(generation)
    }
}

fn validate_transition(
    expected: Option<&GenerationDescriptor>,
    next: &GenerationDescriptor,
) -> Result<(), PortError> {
    let valid = match expected {
        None => next.publication_epoch == 1,
        Some(previous) => {
            next.generation > previous.generation
                && previous.publication_epoch.checked_add(1) == Some(next.publication_epoch)
        }
    };
    if !valid || next.publication_epoch > i64::MAX as u64 {
        return Err(DomainError::validation(ValidationReason::GenerationMismatch).into());
    }
    Ok(())
}

fn validate_state(state: DescriptorState) -> Result<DescriptorState, PortError> {
    if state
        .active
        .as_ref()
        .is_some_and(|active| active.publication_epoch == 0)
    {
        return Err(invalid_row());
    }
    if let Some(candidate) = &state.candidate {
        validate_transition(state.active.as_ref(), candidate)?;
    }
    Ok(state)
}

fn read_local(path: &Path) -> Result<DescriptorState, PortError> {
    #[cfg(windows)]
    let _shared = if path.parent().is_some_and(Path::is_dir) {
        Some(lock_local_shared(path)?)
    } else {
        None
    };
    read_local_unlocked(path)
}

fn read_local_unlocked(path: &Path) -> Result<DescriptorState, PortError> {
    let file = match open_local_readonly(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DescriptorState::default());
        }
        Err(_) => return Err(internal("projection_control_read")),
    };
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| internal("projection_control_read"))?;
    if bytes.len() > 4096 {
        return Err(invalid_row());
    }
    validate_state(serde_json::from_slice(&bytes).map_err(|_| invalid_row())?)
}

#[cfg(windows)]
fn lock_local_shared(path: &Path) -> Result<File, PortError> {
    let lock_path = path.with_extension("lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|_| internal("projection_control_lock_open"))?;
    file.lock_shared()
        .map_err(|_| internal("projection_control_lock"))?;
    Ok(file)
}

fn open_local_readonly(path: &Path) -> std::io::Result<File> {
    #[cfg(unix)]
    {
        use rustix::fs::{Mode, OFlags, open};
        use std::os::unix::fs::MetadataExt;
        let file = File::from(
            open(
                path,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(std::io::Error::from)?,
        );
        let meta = file.metadata()?;
        if !meta.is_file() || meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "invalid control descriptor file",
            ));
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        File::open(path)
    }
}

fn lock_local(path: &Path) -> Result<File, PortError> {
    let lock_path = path.with_extension("lock");
    #[cfg(unix)]
    let file = {
        use rustix::fs::{Mode, OFlags, open};
        use std::os::unix::fs::MetadataExt;
        let file = File::from(
            open(
                &lock_path,
                OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|_| internal("projection_control_lock_open"))?,
        );
        let meta = file
            .metadata()
            .map_err(|_| internal("projection_control_lock_open"))?;
        if !meta.is_file() || meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(internal("projection_control_lock_open"));
        }
        file
    };
    #[cfg(not(unix))]
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|_| internal("projection_control_lock_open"))?;
    file.lock()
        .map_err(|_| internal("projection_control_lock"))?;
    Ok(file)
}

fn write_local(path: &Path, state: &DescriptorState) -> Result<(), PortError> {
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).map_err(|_| internal("projection_control_entropy"))?;
    let temporary = path.with_extension(format!("{:032x}.tmp", u128::from_le_bytes(nonce)));
    let result = (|| {
        #[cfg(unix)]
        let mut file = {
            use rustix::fs::{Mode, OFlags, open};
            File::from(
                open(
                    &temporary,
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::CLOEXEC
                        | OFlags::NOFOLLOW,
                    Mode::RUSR | Mode::WUSR,
                )
                .map_err(|_| internal("projection_control_temp"))?,
            )
        };
        #[cfg(not(unix))]
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| internal("projection_control_temp"))?;
        let body = serde_json::to_vec(state).map_err(|_| invalid_row())?;
        file.write_all(&body)
            .map_err(|_| internal("projection_control_write"))?;
        file.sync_all()
            .map_err(|_| internal("projection_control_sync"))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| internal("projection_control_rename"))?;
        sync_descriptor_directory(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sync_descriptor_directory(path: &Path) -> Result<(), PortError> {
    #[cfg(unix)]
    File::open(path.parent().ok_or_else(invalid_row)?)
        .and_then(|file| file.sync_all())
        .map_err(|_| {
            PortError::Internal(super::failure(
                "projection_control_commit_unknown",
                notarium_core::error::CommitEffect::Unknown,
            ))
        })?;
    let _ = path;
    Ok(())
}

async fn try_read_cleanup_identity(
    tx: &mut SqlTransaction<'_>,
) -> Result<Option<String>, PortError> {
    let Some(identity) = tx
        .select(
            "SELECT replace(cleanup_identity::text, '-', '') FROM projection_generation_control WHERE row_id=1",
            Vec::new(),
            &[Kind::Text],
        )
        .await?
        .pop()
        .and_then(|mut row| row.pop())
    else {
        return Ok(None);
    };
    Ok(Some(String::read(identity)?))
}

async fn read_cleanup_identity(tx: &mut SqlTransaction<'_>) -> Result<String, PortError> {
    try_read_cleanup_identity(tx).await?.ok_or_else(invalid_row)
}

async fn read_postgres(
    tx: &mut SqlTransaction<'_>,
    lock: bool,
) -> Result<DescriptorState, PortError> {
    let sql = if lock {
        "SELECT descriptor FROM projection_generation_control WHERE row_id = 1 FOR UPDATE"
    } else {
        "SELECT descriptor FROM projection_generation_control WHERE row_id = 1"
    };
    let bytes = tx
        .select(sql, Vec::new(), &[Kind::Bytes])
        .await?
        .pop()
        .and_then(|mut row| row.pop())
        .ok_or_else(invalid_row)?;
    validate_state(decode(&Vec::<u8>::read(bytes)?)?)
}
