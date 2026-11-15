//! Bounded database ownership. No pool or SQL handle crosses the public service API.
mod export;
mod import;
mod lease;
pub mod target;
use crate::error::{database, invalid, unavailable};
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
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{OwnedRwLockReadGuard, RwLock, Semaphore};

static SQLITE_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/sqlite");
static POSTGRES_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/postgres");

/// Every writer shares this cross-pod transaction lock with the backup owner.
pub(crate) const BACKUP_LOCK: i64 = 0x4e54_4354_524c;

#[derive(Clone)]
pub struct ControlStore {
    pub(crate) backend: Backend,
    pub(crate) writes: Arc<RwLock<()>>,
    exports: Arc<Semaphore>,
}

#[derive(Clone)]
pub(crate) enum Backend {
    Sqlite { pool: SqlitePool, path: PathBuf },
    Postgres(PgPool),
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
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .foreign_keys(true)
            .busy_timeout(Duration::from_millis(250))
            .pragma("cache_size", "-2048")
            .pragma("wal_autocheckpoint", "1000")
            .disable_statement_logging();
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_millis(250))
            .connect_with(options)
            .await
            .map_err(database)?;
        SQLITE_MIGRATIONS
            .run(&pool)
            .await
            .map_err(|_| unavailable("control SQLite schema", CommitEffect::Unknown))?;
        Ok(Self {
            backend: Backend::Sqlite { pool, path },
            writes: Arc::new(RwLock::new(())),
            exports: Arc::new(Semaphore::new(1)),
        })
    }

    pub async fn postgres(config: PostgresConfig) -> Result<Self, PortError> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_millis(250))
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
            .connect_with(config.options.disable_statement_logging())
            .await
            .map_err(database)?;
        // Schema creation is bootstrap-only; normal queries use qualified names.
        sqlx::query("CREATE SCHEMA IF NOT EXISTS v1_control")
            .execute(&pool)
            .await
            .map_err(database)?;
        POSTGRES_MIGRATIONS
            .run(&pool)
            .await
            .map_err(|_| unavailable("control PostgreSQL schema", CommitEffect::Unknown))?;
        Ok(Self {
            backend: Backend::Postgres(pool),
            writes: Arc::new(RwLock::new(())),
            exports: Arc::new(Semaphore::new(1)),
        })
    }

    pub async fn close(self) {
        match self.backend {
            Backend::Sqlite { pool, .. } => pool.close().await,
            Backend::Postgres(pool) => pool.close().await,
        }
    }

    pub(crate) async fn write(&self) -> Result<WriteTransaction, PortError> {
        let guard = self.writes.clone().read_owned().await;
        let inner = match &self.backend {
            Backend::Sqlite { pool, .. } => {
                Transaction::Sqlite(pool.begin_with("BEGIN IMMEDIATE").await.map_err(database)?)
            }
            Backend::Postgres(pool) => {
                let mut transaction = pool.begin().await.map_err(database)?;
                sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
                    .bind(BACKUP_LOCK)
                    .execute(&mut *transaction)
                    .await
                    .map_err(database)?;
                Transaction::Postgres(transaction)
            }
        };
        Ok(WriteTransaction {
            inner,
            _guard: guard,
        })
    }

    /// Read a bounded epoch witness; this does not bless or repair a partial root.
    pub async fn installation(&self) -> Result<Option<InstallationId>, PortError> {
        let value: Option<String> = match &self.backend {
            Backend::Sqlite { pool, .. } => sqlx::query_scalar("SELECT installation_id FROM v1_storage_epoch WHERE singleton=1 AND epoch_version=1 AND state='ready'").fetch_optional(pool).await.map_err(database)?,
            Backend::Postgres(pool) => sqlx::query_scalar("SELECT installation_id FROM v1_control.v1_storage_epoch WHERE singleton=1 AND epoch_version=1 AND state='ready'").fetch_optional(pool).await.map_err(database)?,
        };
        value
            .map(|value| InstallationId::parse(&value).map_err(Into::into))
            .transpose()
    }
}

const EXPORT_PAGE_BYTES: usize = 8 * 1024 * 1024;
struct RowChunk<T> {
    rows: Vec<T>,
    has_more: bool,
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
async fn collect_rows<T: serde::Serialize, S>(
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
    while let Some(row) = stream.try_next().await.map_err(database)? {
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
pub(crate) struct WriteTransaction {
    pub(crate) inner: Transaction,
    _guard: OwnedRwLockReadGuard<()>,
}
impl WriteTransaction {
    async fn rollback(self) -> Result<(), PortError> {
        let Self { inner, _guard } = self;
        let result = match inner {
            Transaction::Sqlite(tx) => tx.rollback().await.map_err(database),
            Transaction::Postgres(tx) => tx.rollback().await.map_err(database),
        };
        drop(_guard);
        result
    }
    pub(crate) async fn commit(self) -> Result<(), PortError> {
        // Cancellation must not release the writer fence while a queued COMMIT
        // can still reach the database. The owned task outlives its caller.
        tokio::spawn(async move {
            let Self { inner, _guard } = self;
            let result = match inner {
                Transaction::Sqlite(transaction) => transaction.commit().await.map_err(database),
                Transaction::Postgres(transaction) => transaction.commit().await.map_err(database),
            };
            drop(_guard);
            result
        })
        .await
        .map_err(|_| unavailable("control commit worker", CommitEffect::Unknown))?
    }
}
