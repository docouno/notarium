//! Bounded database ownership. No pool or SQL handle crosses the public service API.
mod export;
pub(crate) mod fence;
mod import;
pub(crate) mod lease;
pub(crate) mod state_validation;
pub(crate) mod statements;
pub(crate) mod target;
pub(crate) mod values;
#[cfg(test)]
mod writer_tests;
use crate::error::{database, database_not_committed, invalid, unavailable};
pub use export::TargetExport;
pub use import::TargetImport;
use notarium_core::{
    epoch::DataRoot,
    error::{CommitEffect, PortError, ValidationReason},
    ids::InstallationId,
};
use sqlx::{
    ConnectOptions, PgPool, SqlitePool,
    postgres::{PgConnectOptions, PgPoolOptions},
    sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteSynchronous},
};
use std::{path::PathBuf, sync::Arc, time::Duration};
pub use target::{TARGET_SCHEMA_VERSION, TargetPage, TargetPosition, TargetRecord, TargetTable};
use tokio::sync::{OwnedRwLockReadGuard, OwnedSemaphorePermit, RwLock, Semaphore, oneshot};

static SQLITE_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/sqlite");
static POSTGRES_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/postgres");

/// Every writer shares this cross-pod transaction lock with the backup owner.
pub(crate) const BACKUP_LOCK: i64 = 0x4e54_4354_524c;
pub(crate) const SQLITE_MAX_ACTIVE_WRITERS: usize = 1;
pub(crate) const POSTGRES_MAX_ACTIVE_WRITERS: usize = 4;
pub(crate) const MAX_QUEUED_WRITERS: usize = 64;
pub(crate) const MAX_ACTIVE_READERS: usize = 16;
pub(crate) const MAX_QUEUED_READERS: usize = 512;

#[derive(Clone)]
pub struct ControlStore {
    pub(crate) backend: Backend,
    pub(crate) writes: Arc<RwLock<()>>,
    exports: Arc<Semaphore>,
    write_queue: Arc<Semaphore>,
    write_admission: Arc<Semaphore>,
    read_queue: Arc<Semaphore>,
    read_admission: Arc<Semaphore>,
}

#[derive(Clone)]
pub(crate) enum Backend {
    Sqlite {
        pool: SqlitePool,
        read_pool: SqlitePool,
        path: PathBuf,
    },
    Postgres {
        pool: PgPool,
        read_pool: PgPool,
    },
}

/// Connection configuration is kept out of Debug to avoid credential disclosure.
pub struct PostgresConfig {
    options: PgConnectOptions,
}
impl PostgresConfig {
    pub fn parse(url: &str) -> Result<Self, PortError> {
        let options = url
            .parse()
            .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
        Ok(Self { options })
    }
    /// Local fixtures use a shared socket without enabling container networking.
    pub fn unix_socket(path: PathBuf, database: &str, user: &str) -> Self {
        Self {
            options: PgConnectOptions::new()
                .socket(path)
                .database(database)
                .username(user),
        }
    }
}

impl ControlStore {
    /// The composition owner must classify the data root before opening it.
    /// Missing parent directories are deliberately not created by this adapter.
    pub async fn sqlite(root: &DataRoot) -> Result<Self, PortError> {
        let path = root.control();
        // The bootstrap owner survives cancellation of this caller. Its file
        // fence covers native initialization and the migration driver's ACK.
        tokio::spawn(Self::sqlite_owned(path))
            .await
            .map_err(|_| unavailable("control SQLite bootstrap worker", CommitEffect::Unknown))?
    }

    async fn sqlite_owned(path: PathBuf) -> Result<Self, PortError> {
        let native_path = path.clone();
        let fence = tokio::task::spawn_blocking(move || {
            let started = std::time::Instant::now();
            let fence = fence::FileFence::acquire(
                &fence::sqlite_writer_lock(&native_path),
                true,
                || {
                    if started.elapsed() >= Duration::from_secs(5) {
                        Err(unavailable(
                            "control SQLite bootstrap admission",
                            CommitEffect::NotCommitted,
                        ))
                    } else {
                        Ok(())
                    }
                },
            )?;
            let connection = rusqlite::Connection::open_with_flags(
                &native_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                    | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|_| unavailable("control SQLite bootstrap", CommitEffect::Unknown))?;
            connection
                .busy_timeout(Duration::from_millis(250))
                .and_then(|()| {
                    connection.execute_batch(
                        "PRAGMA fullfsync=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=4194304; PRAGMA secure_delete=ON;",
                    )
                })
                .map_err(|_| unavailable("control SQLite bootstrap", CommitEffect::Unknown))?;
            connection
                .close()
                .map_err(|_| unavailable("control SQLite bootstrap close", CommitEffect::Unknown))?;
            Ok::<_, PortError>(fence)
        })
        .await
        .map_err(|_| unavailable("control SQLite bootstrap worker", CommitEffect::Unknown))??;
        // Request pools only join the already initialized WAL database.
        let write_options = SqliteConnectOptions::new()
            .filename(&path)
            .pragma("fullfsync", "ON")
            .synchronous(SqliteSynchronous::Full)
            .foreign_keys(true)
            .busy_timeout(Duration::from_millis(2500))
            .pragma("cache_size", "-2048")
            .pragma("wal_autocheckpoint", "256")
            .pragma("journal_size_limit", "4194304")
            .pragma("secure_delete", "ON")
            .optimize_on_close(false, None)
            .disable_statement_logging();
        let pool = SqlitePoolOptions::new()
            .max_connections(SQLITE_MAX_ACTIVE_WRITERS as u32)
            .acquire_timeout(Duration::from_secs(2))
            .connect_with(write_options)
            .await
            .map_err(database)?;
        let migrated = SQLITE_MIGRATIONS
            .run(&pool)
            .await
            .map_err(|_| unavailable("control SQLite schema", CommitEffect::Unknown));
        if let Err(error) = migrated {
            pool.close().await;
            let _ = fence.release();
            return Err(error);
        }
        let read_options = SqliteConnectOptions::new()
            .filename(&path)
            .read_only(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_millis(250))
            .pragma("cache_size", "-2048")
            .optimize_on_close(false, None)
            .disable_statement_logging();
        let read_pool = match SqlitePoolOptions::new()
            .max_connections((MAX_ACTIVE_READERS + 4) as u32)
            .acquire_timeout(Duration::from_secs(2))
            .connect_with(read_options)
            .await
        {
            Ok(read_pool) => read_pool,
            Err(err) => {
                pool.close().await;
                let _ = fence.release();
                return Err(database(err));
            }
        };
        fence.release()?;
        Ok(Self {
            backend: Backend::Sqlite {
                pool,
                read_pool,
                path,
            },
            writes: Arc::new(RwLock::new(())),
            exports: Arc::new(Semaphore::new(1)),
            write_queue: Arc::new(Semaphore::new(MAX_QUEUED_WRITERS)),
            write_admission: Arc::new(Semaphore::new(SQLITE_MAX_ACTIVE_WRITERS)),
            read_queue: Arc::new(Semaphore::new(MAX_QUEUED_READERS)),
            read_admission: Arc::new(Semaphore::new(MAX_ACTIVE_READERS)),
        })
    }

    pub async fn postgres(config: PostgresConfig) -> Result<Self, PortError> {
        tokio::spawn(Self::postgres_owned(config))
            .await
            .map_err(|_| {
                unavailable("control PostgreSQL bootstrap worker", CommitEffect::Unknown)
            })?
    }

    async fn postgres_owned(config: PostgresConfig) -> Result<Self, PortError> {
        let options = config.options.disable_statement_logging();
        let pool = PgPoolOptions::new()
            .max_connections((POSTGRES_MAX_ACTIVE_WRITERS + 2) as u32)
            .acquire_timeout(Duration::from_secs(2))
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::raw_sql(
                        "SET synchronous_commit TO on; SET search_path TO v1_control, pg_catalog",
                    )
                    .execute(&mut *connection)
                    .await?;
                    sqlx::query("SET statement_timeout TO '250ms'")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET idle_in_transaction_session_timeout TO '500ms'")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options.clone())
            .await
            .map_err(database)?;
        if let Err(error) = Self::postgres_migrate(&pool).await {
            pool.close().await;
            return Err(error);
        }
        let read_pool = match PgPoolOptions::new()
            .max_connections((MAX_ACTIVE_READERS + 4) as u32)
            .acquire_timeout(Duration::from_secs(2))
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET search_path TO v1_control, pg_catalog")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET statement_timeout TO '250ms'")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET idle_in_transaction_session_timeout TO '500ms'")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
        {
            Ok(read_pool) => read_pool,
            Err(err) => {
                pool.close().await;
                return Err(database(err));
            }
        };
        Ok(Self {
            backend: Backend::Postgres { pool, read_pool },
            writes: Arc::new(RwLock::new(())),
            exports: Arc::new(Semaphore::new(1)),
            write_queue: Arc::new(Semaphore::new(MAX_QUEUED_WRITERS)),
            write_admission: Arc::new(Semaphore::new(POSTGRES_MAX_ACTIVE_WRITERS)),
            read_queue: Arc::new(Semaphore::new(MAX_QUEUED_READERS)),
            read_admission: Arc::new(Semaphore::new(MAX_ACTIVE_READERS)),
        })
    }

    async fn postgres_migrate(pool: &PgPool) -> Result<(), PortError> {
        let mut fence = pool.acquire().await.map_err(database)?;
        fence.close_on_drop();
        let mut locked = false;
        let migrated = async {
            sqlx::query("SET statement_timeout TO '5s'")
                .execute(&mut *fence)
                .await
                .map_err(database)?;
            sqlx::query("SET idle_session_timeout TO '30s'")
                .execute(&mut *fence)
                .await
                .map_err(database)?;
            sqlx::query("SELECT pg_advisory_lock_shared($1)")
                .bind(BACKUP_LOCK)
                .execute(&mut *fence)
                .await
                .map_err(database)?;
            locked = true;
            // The migration connection is separate from the session-level
            // fence and is explicitly closed before the fence is released.
            let mut connection = pool.acquire().await.map_err(database)?;
            connection.close_on_drop();
            let migration = async {
                sqlx::query("SET statement_timeout TO '15s'")
                    .execute(&mut *connection)
                    .await
                    .map_err(database)?;
                sqlx::query("SET idle_in_transaction_session_timeout TO '15s'")
                    .execute(&mut *connection)
                    .await
                    .map_err(database)?;
                // Check the server and this writer before the first persistent change.
                let durable: bool = sqlx::query_scalar(
                    "SELECT pg_catalog.current_setting('fsync') = 'on'
                        AND pg_catalog.current_setting('synchronous_commit') = 'on'",
                )
                .fetch_one(&mut *connection)
                .await
                .map_err(|_| {
                    unavailable("control PostgreSQL durability", CommitEffect::NotCommitted)
                })?;
                if !durable {
                    return Err(unavailable(
                        "control PostgreSQL durability",
                        CommitEffect::NotCommitted,
                    ));
                }
                sqlx::query("CREATE SCHEMA IF NOT EXISTS v1_control")
                    .execute(&mut *connection)
                    .await
                    .map_err(database)?;
                POSTGRES_MIGRATIONS
                    .run_direct(None, &mut *connection, false)
                    .await
                    .map_err(|_| unavailable("control PostgreSQL schema", CommitEffect::Unknown))
            }
            .await;
            let closed = connection.close().await.map_err(database);
            migration?;
            closed
        }
        .await;
        let unlocked = if locked {
            sqlx::query_scalar::<_, bool>("SELECT pg_advisory_unlock_shared($1)")
                .bind(BACKUP_LOCK)
                .fetch_one(&mut *fence)
                .await
                .map_err(database)
                .and_then(|unlocked| {
                    if unlocked {
                        Ok(())
                    } else {
                        Err(unavailable(
                            "control PostgreSQL bootstrap fence",
                            CommitEffect::Unknown,
                        ))
                    }
                })
        } else {
            Ok(())
        };
        let closed = fence.close().await.map_err(database);
        migrated?;
        unlocked?;
        closed
    }

    #[cfg(test)]
    pub(crate) fn max_active_writers(&self) -> usize {
        match &self.backend {
            Backend::Sqlite { .. } => SQLITE_MAX_ACTIVE_WRITERS,
            Backend::Postgres { .. } => POSTGRES_MAX_ACTIVE_WRITERS,
        }
    }

    pub async fn close(self) {
        match self.backend {
            Backend::Sqlite {
                pool, read_pool, ..
            } => {
                read_pool.close().await;
                pool.close().await;
            }
            Backend::Postgres { pool, read_pool } => {
                read_pool.close().await;
                pool.close().await;
            }
        }
    }

    /// Consistent read-only snapshot without writer-fence contention, `FOR UPDATE`,
    /// or `FileFence` syscalls.
    pub(crate) async fn read(
        &self,
        budget: lease::OperationBudget,
    ) -> Result<ReadTransaction, PortError> {
        budget.check(CommitEffect::NotCommitted)?;
        let admission = match self.read_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _queue_slot = self.read_queue.clone().try_acquire_owned().map_err(|_| {
                    notarium_core::DomainError::RateLimited {
                        retry_after_ms: 1000,
                        budget: notarium_core::error::BudgetKind::Concurrency,
                    }
                })?;
                budget
                    .run(
                        async {
                            self.read_admission
                                .clone()
                                .acquire_owned()
                                .await
                                .map_err(|_| {
                                    unavailable(
                                        "control reader admission",
                                        CommitEffect::NotCommitted,
                                    )
                                })
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?
            }
        };
        budget
            .run(
                async {
                    let mut inner = match &self.backend {
                        Backend::Sqlite { read_pool, .. } => Transaction::Sqlite(
                            read_pool.begin().await.map_err(database_not_committed)?,
                        ),
                        Backend::Postgres { read_pool, .. } => Transaction::Postgres(
                            read_pool
                                .begin_with("BEGIN TRANSACTION READ ONLY")
                                .await
                                .map_err(database_not_committed)?,
                        ),
                    };
                    budget.configure(&mut inner).await?;
                    Ok(ReadTransaction {
                        resources: Some(ReadResources {
                            inner,
                            _admission: admission,
                        }),
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await
    }

    pub(crate) async fn write(
        &self,
        budget: lease::OperationBudget,
    ) -> Result<WriteTransaction, PortError> {
        budget.check(CommitEffect::NotCommitted)?;
        let admission = match self.write_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _queue_slot = self.write_queue.clone().try_acquire_owned().map_err(|_| {
                    notarium_core::DomainError::RateLimited {
                        retry_after_ms: 1000,
                        budget: notarium_core::error::BudgetKind::Concurrency,
                    }
                })?;
                budget
                    .run(
                        async {
                            self.write_admission
                                .clone()
                                .acquire_owned()
                                .await
                                .map_err(|_| {
                                    unavailable(
                                        "control writer admission",
                                        CommitEffect::NotCommitted,
                                    )
                                })
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?
            }
        };
        let store = self.clone();
        let worker_budget = budget.clone();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            // Once BEGIN reaches the driver, its owner waits for the reply even
            // if the requesting future has gone. Admission bounds these owners.
            let result = async {
                let guard = worker_budget
                    .run(
                        async { Ok(store.writes.clone().read_owned().await) },
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                let file_fence = match &store.backend {
                    Backend::Sqlite { path, .. } => Some(
                        fence::FileFence::writer(
                            fence::sqlite_writer_lock(path),
                            worker_budget.clone(),
                        )
                        .await?,
                    ),
                    Backend::Postgres { .. } => None,
                };
                let inner = match &store.backend {
                    Backend::Sqlite { pool, .. } => {
                        match pool
                            .begin_with("BEGIN IMMEDIATE")
                            .await
                            .map_err(database_not_committed)
                        {
                            Ok(tx) => Transaction::Sqlite(tx),
                            Err(err) => {
                                if let Some(fence) = file_fence {
                                    let _ = fence.release();
                                }
                                return Err(err);
                            }
                        }
                    }
                    Backend::Postgres { pool, .. } => {
                        Transaction::Postgres(pool.begin().await.map_err(database_not_committed)?)
                    }
                };
                let mut tx = WriteTransaction {
                    resources: Some(WriteResources {
                        revocation_fences: Vec::new(),
                        schedule_pin: None,
                        inner,
                        _guard: guard,
                        _admission: admission,
                        file_fence,
                    }),
                };
                worker_budget.configure(tx.inner_mut()).await?;
                if let Transaction::Postgres(inner) = tx.inner_mut() {
                    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
                        .bind(BACKUP_LOCK)
                        .execute(&mut **inner)
                        .await
                        .map_err(database_not_committed)?;
                }
                worker_budget.check(CommitEffect::NotCommitted)?;
                Ok(tx)
            }
            .await;
            // A value left in or rejected by the channel also has an owned
            // rollback destructor; the writer fence survives until its ACK.
            let _ = sender.send(result);
        });
        budget
            .run(
                async {
                    receiver.await.map_err(|_| {
                        unavailable("control writer worker", CommitEffect::NotCommitted)
                    })?
                },
                CommitEffect::NotCommitted,
            )
            .await
    }

    /// Read a bounded epoch witness; this does not bless or repair a partial root.
    pub async fn installation(&self) -> Result<Option<InstallationId>, PortError> {
        let value: Option<String> = match &self.backend {
            Backend::Sqlite { read_pool, .. } => sqlx::query_scalar(
                "SELECT installation_id FROM v1_storage_epoch WHERE singleton=1 AND epoch_version=1 AND state='ready'",
            )
            .fetch_optional(read_pool)
            .await
            .map_err(database_not_committed)?,
            Backend::Postgres { read_pool, .. } => sqlx::query_scalar(
                "SELECT installation_id FROM v1_control.v1_storage_epoch WHERE singleton=1 AND epoch_version=1 AND state='ready'",
            )
            .fetch_optional(read_pool)
            .await
            .map_err(database_not_committed)?,
        };
        value
            .map(|value| InstallationId::parse(&value).map_err(Into::into))
            .transpose()
    }
}

const EXPORT_PAGE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) struct RowChunk<T> {
    pub(crate) rows: Vec<T>,
    pub(crate) has_more: bool,
}
struct ByteCounter(usize);
impl std::io::Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        if self.0 > EXPORT_PAGE_BYTES {
            return Err(std::io::Error::other("target record limit"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encoded_size(value: &impl serde::Serialize) -> Result<usize, PortError> {
    let mut writer = ByteCounter(0);
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| invalid(ValidationReason::InvalidLimit))?;
    Ok(writer.0)
}
pub(crate) async fn collect_rows<T: serde::Serialize, S>(
    mut stream: S,
    limit: u16,
    table: target::TargetTable,
) -> Result<RowChunk<T>, PortError>
where
    S: futures_util::TryStream<Ok = T, Error = sqlx::Error> + Unpin,
{
    use futures_util::TryStreamExt;
    let envelope = encoded_size(&serde_json::json!({"table":table.name(),"row":null}))? - 4;
    let mut rows = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = stream.try_next().await.map_err(database_not_committed)? {
        // Match TargetRecord's exact tagged envelope used by import admission.
        let size = encoded_size(&row)?.saturating_add(envelope);
        if size > EXPORT_PAGE_BYTES {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        if rows.len() == usize::from(limit) || bytes.saturating_add(size) > EXPORT_PAGE_BYTES {
            return Ok(RowChunk {
                rows,
                has_more: true,
            });
        }
        bytes += size;
        rows.push(row);
    }
    Ok(RowChunk {
        rows,
        has_more: false,
    })
}

pub(crate) enum Transaction {
    Sqlite(sqlx::Transaction<'static, sqlx::Sqlite>),
    Postgres(sqlx::Transaction<'static, sqlx::Postgres>),
}

struct ReadResources {
    inner: Transaction,
    _admission: OwnedSemaphorePermit,
}

pub(crate) struct ReadTransaction {
    resources: Option<ReadResources>,
}
impl ReadTransaction {
    pub(crate) fn inner_mut(&mut self) -> &mut Transaction {
        &mut self
            .resources
            .as_mut()
            .expect("live read transaction")
            .inner
    }
    pub(crate) async fn finish(mut self) -> Result<(), PortError> {
        let ReadResources { inner, _admission } =
            self.resources.take().expect("live read transaction");
        let result = match inner {
            Transaction::Sqlite(tx) => tx.rollback().await.map_err(database_not_committed),
            Transaction::Postgres(tx) => tx.rollback().await.map_err(database_not_committed),
        };
        drop(_admission);
        result
    }
    pub(crate) async fn rollback(self) -> Result<(), PortError> {
        self.finish().await
    }
}
impl Drop for ReadTransaction {
    fn drop(&mut self) {
        if let Some(ReadResources { inner, _admission }) = self.resources.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                match inner {
                    Transaction::Sqlite(tx) => {
                        let _ = tx.rollback().await;
                    }
                    Transaction::Postgres(tx) => {
                        let _ = tx.rollback().await;
                    }
                }
                drop(_admission);
            });
        }
    }
}

struct WriteResources {
    inner: Transaction,
    revocation_fences: Vec<Box<dyn notarium_core::ports::RevocationLease>>,
    schedule_pin: Option<Box<dyn notarium_core::ports::ScheduleAbilityLease>>,
    _guard: OwnedRwLockReadGuard<()>,
    _admission: OwnedSemaphorePermit,
    file_fence: Option<fence::FileFence>,
}
impl WriteResources {
    async fn rollback(self) -> Result<(), PortError> {
        let Self {
            inner,
            revocation_fences,
            schedule_pin,
            _guard,
            _admission,
            file_fence,
        } = self;
        let result = match inner {
            Transaction::Sqlite(tx) => tx.rollback().await.map_err(database_not_committed),
            Transaction::Postgres(tx) => tx.rollback().await.map_err(database_not_committed),
        };
        let fence_result = if let Some(fence) = file_fence {
            fence.release()
        } else {
            Ok(())
        };
        drop(revocation_fences);
        if let Some(mut pin) = schedule_pin {
            let _ = pin.close().await;
        }
        drop(_guard);
        drop(_admission);
        result?;
        fence_result
    }
    async fn commit(self) -> Result<(), PortError> {
        let fences = self.commit_keeping_fences().await?;
        drop(fences);
        Ok(())
    }
    async fn commit_keeping_fences(
        self,
    ) -> Result<Vec<Box<dyn notarium_core::ports::RevocationLease>>, PortError> {
        let checked = self
            .revocation_fences
            .iter()
            .try_for_each(|fence| fence.check());
        if let Err(error) = checked {
            self.rollback().await?;
            return Err(error);
        }
        let Self {
            inner,
            revocation_fences,
            schedule_pin,
            _guard,
            _admission,
            file_fence,
        } = self;
        let result = match inner {
            Transaction::Sqlite(tx) => tx.commit().await.map_err(database),
            Transaction::Postgres(tx) => tx.commit().await.map_err(database),
        };
        let fence_result = if let Some(fence) = file_fence {
            fence.release()
        } else {
            Ok(())
        };
        if let Some(mut pin) = schedule_pin {
            let _ = pin.close().await;
        }
        drop(_guard);
        drop(_admission);
        if let Err(error) = result {
            drop(revocation_fences);
            return Err(error);
        }
        // `tx.commit()` is already durable and `fence.release(self)` closed the
        // file descriptor on return, releasing the OS lock; do not misreport
        // `CommitEffect::NotCommitted` after a committed write.
        let _ = fence_result;
        Ok(revocation_fences)
    }
}
pub(crate) struct WriteTransaction {
    resources: Option<WriteResources>,
}
impl WriteTransaction {
    /// The native writer owns this lease until commit or rollback ACK, even
    /// when the operation abandons its wait for the native writer.
    pub(crate) fn hold_schedule_pin(
        &mut self,
        pin: Box<dyn notarium_core::ports::ScheduleAbilityLease>,
    ) {
        self.resources
            .as_mut()
            .expect("live write transaction")
            .schedule_pin = Some(pin);
    }
    pub(crate) fn hold_revocation_fence(
        &mut self,
        fence: Box<dyn notarium_core::ports::RevocationLease>,
    ) {
        self.resources
            .as_mut()
            .expect("live write transaction")
            .revocation_fences
            .push(fence);
    }
    pub(crate) fn inner_mut(&mut self) -> &mut Transaction {
        &mut self
            .resources
            .as_mut()
            .expect("live write transaction")
            .inner
    }
    pub(crate) async fn rollback(mut self) -> Result<(), PortError> {
        let resources = self.resources.take().expect("live write transaction");
        tokio::spawn(resources.rollback())
            .await
            .map_err(|_| unavailable("control rollback worker", CommitEffect::Unknown))?
    }
    pub(crate) fn spawn_commit(mut self) -> tokio::task::JoinHandle<Result<(), PortError>> {
        let resources = self.resources.take().expect("live write transaction");
        tokio::spawn(resources.commit())
    }
    pub(crate) fn spawn_commit_keeping_fences(
        mut self,
    ) -> tokio::task::JoinHandle<
        Result<Vec<Box<dyn notarium_core::ports::RevocationLease>>, PortError>,
    > {
        let resources = self.resources.take().expect("live write transaction");
        tokio::spawn(resources.commit_keeping_fences())
    }
    pub(crate) async fn commit(self) -> Result<(), PortError> {
        self.spawn_commit()
            .await
            .map_err(|_| unavailable("control commit worker", CommitEffect::Unknown))?
    }
}
impl Drop for WriteTransaction {
    fn drop(&mut self) {
        if let Some(resources) = self.resources.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(resources.rollback());
        }
    }
}
