use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use notarium_core::{
    classes::DocClass,
    error::{CommitEffect, PortError},
    ids::*,
    model::Lifecycle,
    ports::ChatThreadKind,
};
use rusqlite::{
    Connection, OpenFlags,
    types::{ToSql, ToSqlOutput, ValueRef},
};
use serde::{Deserialize, Serialize};
use sqlx::{
    AssertSqlSafe, Connection as _, PgConnection, PgPool, Postgres, Row, pool::PoolConnection,
    postgres::PgArguments, query::Query,
};
use tokio::{runtime::Handle, sync::Semaphore};

use super::{deadline, failure, internal, invalid_row};

const READ_LIMIT: Duration = Duration::from_millis(240);
const PG_READ_LIMIT: Duration = Duration::from_millis(225);
const READERS: usize = 8;
const WAL_LIMIT: u64 = 64 * 1024 * 1024;
// PostgreSQL identifier limit (NAMEDATALEN - 1 = 63) minus "_g" and max u64 digits (19).
const MAX_SCHEMA_PREFIX_LEN: usize = 42;

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Integer,
    Text,
    Bytes,
}

impl Kind {
    pub(super) fn ddl(self, postgres: bool) -> &'static str {
        match self {
            Self::Integer => "BIGINT",
            Self::Text if postgres => "TEXT COLLATE \"C\"",
            Self::Text => "TEXT",
            Self::Bytes if postgres => "BYTEA",
            Self::Bytes => "BLOB",
        }
    }

    fn null(self) -> SqlValue {
        match self {
            Self::Integer => SqlValue::Integer(None),
            Self::Text => SqlValue::Text(None),
            Self::Bytes => SqlValue::Bytes(None),
        }
    }

    fn sqlite(self, row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<SqlValue> {
        Ok(match self {
            Self::Integer => SqlValue::Integer(row.get(column)?),
            Self::Text => SqlValue::Text(row.get(column)?),
            Self::Bytes => SqlValue::Bytes(row.get(column)?),
        })
    }

    fn postgres(self, row: &sqlx::postgres::PgRow, column: usize) -> sqlx::Result<SqlValue> {
        Ok(match self {
            Self::Integer => SqlValue::Integer(row.try_get(column)?),
            Self::Text => SqlValue::Text(row.try_get(column)?),
            Self::Bytes => SqlValue::Bytes(row.try_get(column)?),
        })
    }
}

pub(super) struct Column {
    pub name: &'static str,
    pub kind: Kind,
    pub nullable: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub(super) enum SqlValue {
    Integer(Option<i64>),
    Text(Option<String>),
    Bytes(Option<Vec<u8>>),
    IntArray(Vec<i64>),
    TextArray(Vec<String>),
    OutOfRange,
}

impl ToSql for SqlValue {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self {
            Self::Integer(Some(value)) => ValueRef::Integer(*value),
            Self::Text(Some(value)) => ValueRef::Text(value.as_bytes()),
            Self::Bytes(Some(value)) => ValueRef::Blob(value),
            Self::Integer(None) | Self::Text(None) | Self::Bytes(None) => ValueRef::Null,
            Self::IntArray(_) | Self::TextArray(_) => return Err(rusqlite::Error::InvalidQuery),
            Self::OutOfRange => return Err(rusqlite::Error::IntegralValueOutOfRange(0, i64::MAX)),
        }))
    }
}

pub(super) trait SqlColumn: Sized {
    const KIND: Kind;
    const NULLABLE: bool = false;

    fn value(&self) -> SqlValue;
    fn read(value: SqlValue) -> Result<Self, PortError>;
}

pub(super) fn value<T: SqlColumn>(value: &T) -> SqlValue {
    value.value()
}

impl<T: SqlColumn> SqlColumn for Option<T> {
    const KIND: Kind = T::KIND;
    const NULLABLE: bool = true;
    fn value(&self) -> SqlValue {
        self.as_ref()
            .map_or_else(|| T::KIND.null(), SqlColumn::value)
    }
    fn read(value: SqlValue) -> Result<Self, PortError> {
        if matches!(
            value,
            SqlValue::Integer(None) | SqlValue::Text(None) | SqlValue::Bytes(None)
        ) {
            Ok(None)
        } else {
            T::read(value).map(Some)
        }
    }
}

macro_rules! integer {
    ($($ty:ty),* $(,)?) => {
        $(impl SqlColumn for $ty {
            const KIND: Kind = Kind::Integer;
            fn value(&self) -> SqlValue {
                match i64::try_from(*self) {
                    Ok(value) => SqlValue::Integer(Some(value)),
                    Err(_) => SqlValue::OutOfRange,
                }
            }
            fn read(value: SqlValue) -> Result<Self, PortError> {
                <$ty>::try_from(i64::read(value)?).map_err(|_| invalid_row())
            }
        })*
    };
}
integer!(u16, u32, u64);

impl SqlColumn for i64 {
    const KIND: Kind = Kind::Integer;
    fn value(&self) -> SqlValue {
        SqlValue::Integer(Some(*self))
    }
    fn read(value: SqlValue) -> Result<Self, PortError> {
        match value {
            SqlValue::Integer(Some(value)) => Ok(value),
            _ => Err(invalid_row()),
        }
    }
}

impl SqlColumn for bool {
    const KIND: Kind = Kind::Integer;
    fn value(&self) -> SqlValue {
        i64::from(*self).value()
    }
    fn read(value: SqlValue) -> Result<Self, PortError> {
        match i64::read(value)? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(invalid_row()),
        }
    }
}

impl SqlColumn for String {
    const KIND: Kind = Kind::Text;
    fn value(&self) -> SqlValue {
        SqlValue::Text(Some(self.clone()))
    }
    fn read(value: SqlValue) -> Result<Self, PortError> {
        match value {
            SqlValue::Text(Some(value)) => Ok(value),
            _ => Err(invalid_row()),
        }
    }
}

impl SqlColumn for Vec<u8> {
    const KIND: Kind = Kind::Bytes;
    fn value(&self) -> SqlValue {
        SqlValue::Bytes(Some(self.clone()))
    }
    fn read(value: SqlValue) -> Result<Self, PortError> {
        match value {
            SqlValue::Bytes(Some(value)) => Ok(value),
            _ => Err(invalid_row()),
        }
    }
}

macro_rules! counters {
    ($($ty:ty),* $(,)?) => {
        $(impl SqlColumn for $ty {
            const KIND: Kind = Kind::Integer;
            fn value(&self) -> SqlValue {
                self.get().value()
            }
            fn read(value: SqlValue) -> Result<Self, PortError> {
                <$ty>::new(u64::read(value)?).map_err(Into::into)
            }
        })*
    };
}
counters!(SpaceSeq, ThreadEntrySeq, ProjectionGeneration);

macro_rules! text_id {
    ($($ty:ty),* $(,)?) => {
        $(impl SqlColumn for $ty {
            const KIND: Kind = Kind::Text;
            fn value(&self) -> SqlValue {
                SqlValue::Text(Some(self.as_str().to_owned()))
            }
            fn read(value: SqlValue) -> Result<Self, PortError> {
                <$ty>::parse(&String::read(value)?).map_err(|_| invalid_row())
            }
        })*
    };
}
text_id!(
    SpaceId,
    NoteId,
    FolderId,
    ViewKey,
    RevisionId,
    AbilityId,
    ClusterId,
    ChatThreadId,
    PrincipalId
);

macro_rules! fixed_bytes {
    ($($ty:ty),* $(,)?) => {
        $(impl SqlColumn for $ty {
            const KIND: Kind = Kind::Bytes;
            fn value(&self) -> SqlValue {
                SqlValue::Bytes(Some(self.as_bytes().to_vec()))
            }
            fn read(value: SqlValue) -> Result<Self, PortError> {
                let bytes = Vec::<u8>::read(value)?.try_into().map_err(|_| invalid_row())?;
                Ok(<$ty>::from_bytes(bytes))
            }
        })*
    };
}
fixed_bytes!(HistoryIncarnation, ContentDigest);

macro_rules! text_enum {
    ($ty:ident {$($v:ident => $name:literal),+}) => {
        impl SqlColumn for $ty {
            const KIND: Kind = Kind::Text;
            fn value(&self) -> SqlValue {
                let name = match self { $(Self::$v => $name),+ };
                SqlValue::Text(Some(name.to_owned()))
            }
            fn read(value: SqlValue) -> Result<Self, PortError> {
                match String::read(value)?.as_str() {
                    $($name => Ok(Self::$v),)+
                    _ => Err(invalid_row()),
                }
            }
        }
    };
}
text_enum!(DocClass {
    UserDoc => "user-doc", EncryptedNote => "encrypted-note", AgentMemory => "agent-memory",
    Skill => "skill", Profile => "profile"
});
text_enum!(Lifecycle { Active => "active", Trashed => "trashed", Purged => "purged" });
text_enum!(ChatThreadKind { Personal => "personal", SpaceGroup => "space_group", KeeperLog => "keeper_log" });

pub(super) trait SqlRecord: Sized {
    const TABLE: &'static str;
    const COLUMNS: &'static [Column];
    const KEY: &'static [&'static str];

    fn values(&self) -> Vec<SqlValue>;
    fn key(&self) -> Vec<SqlValue>;
    fn read(values: Vec<SqlValue>) -> Result<Self, PortError>;

    fn columns() -> String {
        Self::COLUMNS
            .iter()
            .map(|column| column.name)
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn kinds() -> Vec<Kind> {
        Self::COLUMNS.iter().map(|column| column.kind).collect()
    }
}

pub(super) fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

pub(super) fn key_filter<R: SqlRecord>() -> String {
    R::KEY
        .iter()
        .map(|column| format!("{column} = ?"))
        .collect::<Vec<_>>()
        .join(" AND ")
}

struct SqliteDatabase {
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    permits: Arc<Semaphore>,
    checkpoint: Arc<CheckpointGate>,
    wal: PathBuf,
}

#[derive(Default)]
struct CheckpointGate {
    state: Mutex<CheckpointState>,
    changed: Condvar,
}

#[derive(Default)]
struct CheckpointState {
    active_readers: usize,
    draining: bool,
}

impl CheckpointGate {
    fn admit(
        &self,
        deadline_at: Instant,
        aborted: &AtomicBool,
    ) -> Result<CheckpointLease<'_>, PortError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| internal("projection_checkpoint_gate"))?;
        while state.draining {
            if aborted.load(Ordering::Acquire) {
                return Err(deadline());
            }
            let remaining = deadline_at
                .checked_duration_since(Instant::now())
                .ok_or_else(deadline)?;
            let (updated, wait) = self
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| internal("projection_checkpoint_gate"))?;
            if wait.timed_out() || aborted.load(Ordering::Acquire) {
                return Err(deadline());
            }
            state = updated;
        }
        state.active_readers += 1;
        Ok(CheckpointLease {
            gate: self,
            writer: false,
        })
    }

    fn wake_all(&self) {
        if let Ok(_state) = self.state.lock() {
            self.changed.notify_all();
        }
    }

    /// Only the single derived writer calls this method. It closes admission
    /// before waiting for old transactions to release their WAL snapshots.
    fn checkpoint(&self) -> Result<CheckpointLease<'_>, PortError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| internal("projection_checkpoint_gate"))?;
        state.draining = true;
        while state.active_readers != 0 {
            state = self
                .changed
                .wait(state)
                .map_err(|_| internal("projection_checkpoint_gate"))?;
        }
        Ok(CheckpointLease {
            gate: self,
            writer: true,
        })
    }
}

struct CheckpointLease<'a> {
    gate: &'a CheckpointGate,
    writer: bool,
}

impl Drop for CheckpointLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            if self.writer {
                state.draining = false;
                self.gate.changed.notify_all();
            } else {
                state.active_readers -= 1;
                if state.draining && state.active_readers == 0 {
                    self.gate.changed.notify_all();
                }
            }
        }
    }
}

struct ReaderGuard<'a> {
    sqlite: &'a SqliteDatabase,
    reader: Option<Connection>,
}

impl Drop for ReaderGuard<'_> {
    fn drop(&mut self) {
        let Some(reader) = self.reader.take() else {
            return;
        };
        let _ = reader.progress_handler(0, None::<fn() -> bool>);
        if !reader.is_autocommit() && reader.execute_batch("ROLLBACK").is_err() {
            // Drop the tainted connection and replace it with a clean reader.
            drop(reader);
            if let Ok(replacement) = open_reader(&self.sqlite.path)
                && let Ok(mut pool) = self.sqlite.readers.lock()
            {
                pool.push(replacement);
            }
            return;
        }
        if let Ok(mut pool) = self.sqlite.readers.lock() {
            pool.push(reader);
        }
    }
}

enum Backend {
    Sqlite(Box<SqliteDatabase>),
    Postgres { pool: PgPool, schema: String },
}

pub(super) struct Database(Backend);

type SqlFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, PortError>> + Send + 'a>>;

impl Database {
    pub(super) fn postgres_config(&self) -> Option<(PgPool, &str)> {
        match &self.0 {
            Backend::Postgres { pool, schema } => Some((pool.clone(), schema)),
            Backend::Sqlite(_) => None,
        }
    }

    pub(super) async fn open_sqlite(path: PathBuf) -> Result<Self, PortError> {
        tokio::task::spawn_blocking(move || {
            let directory = path.parent().ok_or_else(invalid_row)?;
            std::fs::create_dir_all(directory)
                .map_err(|_| internal("projection_sqlite_directory"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
            }
            #[cfg(target_os = "linux")]
            suppress_access_times(directory);
            let writer = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(sqlite_error)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            writer
                .busy_timeout(Duration::from_secs(5))
                .map_err(sqlite_error)?;
            writer.set_prepared_statement_cache_capacity(128);
            writer
                .execute_batch(
                    "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA secure_delete=ON;
                 PRAGMA foreign_keys=ON;
                 PRAGMA wal_autocheckpoint=0;
                 PRAGMA journal_size_limit=67108864;
                 PRAGMA temp_store=MEMORY;",
                )
                .map_err(sqlite_error)?;
            let mode: String = writer
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .map_err(sqlite_error)?;
            let secure_delete: i64 = writer
                .query_row("PRAGMA secure_delete", [], |r| r.get(0))
                .map_err(sqlite_error)?;
            if mode != "wal" || secure_delete != 1 {
                return Err(internal("projection_sqlite_pragmas"));
            }
            let mut readers = Vec::with_capacity(READERS);
            for _ in 0..READERS {
                readers.push(open_reader(&path)?);
            }
            let mut wal = path.as_os_str().to_os_string();
            wal.push("-wal");
            Ok(Self(Backend::Sqlite(Box::new(SqliteDatabase {
                path,
                writer: Mutex::new(writer),
                readers: Mutex::new(readers),
                permits: Arc::new(Semaphore::new(READERS)),
                checkpoint: Arc::new(CheckpointGate::default()),
                wal: PathBuf::from(wal),
            }))))
        })
        .await
        .map_err(join_error)?
    }

    pub(super) async fn open_postgres(pool: PgPool, schema: &str) -> Result<Self, PortError> {
        let schema = validate_identifier(schema)?.to_owned();
        let mut tx = pool.begin().await.map_err(postgres_error)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 251850))")
            .bind(&schema)
            .execute(&mut *tx)
            .await
            .map_err(postgres_error)?;
        let ddl = format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\"");
        sqlx::query(AssertSqlSafe(ddl.as_str()))
            .execute(&mut *tx)
            .await
            .map_err(postgres_error)?;
        tx.commit().await.map_err(commit_error)?;
        Ok(Self(Backend::Postgres { pool, schema }))
    }

    /// Serializes erasure with schema reclamation without opening or creating
    /// a generation. Initialization and compatibility checks belong to the caller.
    pub(super) async fn write_existing_postgres<T, F>(
        pool: &PgPool,
        schema: &str,
        operation: F,
    ) -> Result<Option<T>, PortError>
    where
        F: for<'a> FnOnce(SqlTransaction<'a>) -> SqlFuture<'a, T> + Send + 'static,
        T: Send + 'static,
    {
        let schema = validate_identifier(schema)?;
        let mut tx = pool.begin().await.map_err(postgres_error)?;
        configure_postgres(&mut tx, schema, false).await?;
        sqlx::query("SET LOCAL lock_timeout = '225ms'")
            .execute(&mut *tx)
            .await
            .map_err(postgres_error)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 251850))")
            .bind(schema)
            .execute(&mut *tx)
            .await
            .map_err(postgres_error)?;
        // Once the generation lifecycle lock is held, reset lock_timeout so
        // physical erasure rows do not fail prematurely under concurrent writes.
        sqlx::query("SET LOCAL lock_timeout = DEFAULT")
            .execute(&mut *tx)
            .await
            .map_err(postgres_error)?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1)",
        )
        .bind(schema)
        .fetch_one(&mut *tx)
        .await
        .map_err(postgres_error)?;
        if !exists {
            tx.rollback().await.map_err(postgres_error)?;
            return Ok(None);
        }
        let result = operation(SqlTransaction::Postgres(&mut tx)).await?;
        tx.commit().await.map_err(commit_error)?;
        Ok(Some(result))
    }

    pub(super) async fn write<T, F>(
        self: &Arc<Self>,
        scrub_wal: bool,
        operation: F,
    ) -> Result<T, PortError>
    where
        F: for<'a> FnOnce(SqlTransaction<'a>) -> SqlFuture<'a, T> + Send + 'static,
        T: Send + 'static,
    {
        self.write_adaptive(move |tx| {
            Box::pin(async move { operation(tx).await.map(|value| (value, scrub_wal)) })
        })
        .await
    }

    pub(super) async fn write_adaptive<T, F>(self: &Arc<Self>, operation: F) -> Result<T, PortError>
    where
        F: for<'a> FnOnce(SqlTransaction<'a>) -> SqlFuture<'a, (T, bool)> + Send + 'static,
        T: Send + 'static,
    {
        match &self.0 {
            Backend::Postgres { pool, schema } => {
                let mut tx = pool.begin().await.map_err(postgres_error)?;
                configure_postgres(&mut tx, schema, false).await?;
                let (result, _) = operation(SqlTransaction::Postgres(&mut tx)).await?;
                tx.commit().await.map_err(commit_error)?;
                Ok(result)
            }
            Backend::Sqlite(_) => {
                let database = Arc::clone(self);
                let runtime = Handle::current();
                tokio::task::spawn_blocking(move || {
                    let Backend::Sqlite(sqlite) = &database.0 else {
                        unreachable!();
                    };
                    let mut writer = sqlite
                        .writer
                        .lock()
                        .map_err(|_| internal("projection_writer_lock"))?;
                    writer
                        .execute_batch("BEGIN IMMEDIATE")
                        .map_err(sqlite_error)?;
                    let result = runtime.block_on(operation(SqlTransaction::Sqlite(&mut writer)));
                    let result = match result {
                        Ok(value) => match writer.execute_batch("COMMIT") {
                            Ok(()) => Ok(value),
                            Err(error) => {
                                tracing::warn!(
                                    error_code = ?error.sqlite_error_code(),
                                    extended_code = sqlite_extended_code(&error),
                                    "derived SQLite COMMIT failed"
                                );
                                Err(unknown_commit())
                            }
                        },
                        Err(err) => Err(err),
                    };
                    if !writer.is_autocommit() {
                        writer.execute_batch("ROLLBACK").map_err(sqlite_error)?;
                    }
                    let (result, scrub_wal) = result?;
                    let over_limit = !scrub_wal
                        && std::fs::metadata(&sqlite.wal)
                            .is_ok_and(|metadata| metadata.len() > WAL_LIMIT);
                    if scrub_wal || over_limit {
                        // Backfill WAL frames while readers can still run so
                        // the exclusive TRUNCATE step does minimal I/O.
                        if let Err(error) =
                            writer.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))
                        {
                            tracing::warn!(
                                scrub_wal,
                                error_code = ?error.sqlite_error_code(),
                                extended_code = sqlite_extended_code(&error),
                                "derived SQLite PASSIVE checkpoint failed"
                            );
                            if scrub_wal {
                                return Err(unknown_commit());
                            }
                        } else if let Ok(_checkpoint) = sqlite.checkpoint.checkpoint() {
                            match writer.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                                r.get::<_, i64>(0)
                            }) {
                                Ok(0) => {}
                                Ok(busy) => {
                                    tracing::warn!(
                                        scrub_wal,
                                        busy,
                                        "derived SQLite TRUNCATE checkpoint busy"
                                    );
                                    if scrub_wal {
                                        return Err(unknown_commit());
                                    }
                                }
                                Err(error) => {
                                    tracing::warn!(
                                        scrub_wal,
                                        error_code = ?error.sqlite_error_code(),
                                        extended_code = sqlite_extended_code(&error),
                                        "derived SQLite TRUNCATE checkpoint failed"
                                    );
                                    if scrub_wal {
                                        return Err(unknown_commit());
                                    }
                                }
                            }
                        } else if scrub_wal {
                            return Err(unknown_commit());
                        }
                    }
                    Ok(result)
                })
                .await
                .map_err(join_error)?
            }
        }
    }

    pub(super) async fn read<T, F>(self: &Arc<Self>, operation: F) -> Result<T, PortError>
    where
        F: for<'a> FnOnce(SqlTransaction<'a>) -> SqlFuture<'a, T> + Send + 'static,
        T: Send + 'static,
    {
        let cutoff = Instant::now() + READ_LIMIT;
        let budget = tokio::time::Instant::from_std(cutoff);
        match &self.0 {
            Backend::Postgres { pool, schema } => {
                // On PostgreSQL 16 statement_timeout is per statement. An
                // interrupted or timed-out transaction drops its connection so
                // an in-flight query cannot pin MVCC, whereas clean domain
                // errors roll back and return the connection to the pool.
                let budget = tokio::time::Instant::from_std(cutoff - (READ_LIMIT - PG_READ_LIMIT));
                tokio::time::timeout_at(budget, async {
                    let mut lease = PgReadConnection {
                        connection: pool.acquire().await.map_err(postgres_error)?,
                        finished: false,
                    };
                    let mut tx = lease.connection.begin().await.map_err(postgres_error)?;
                    configure_postgres(&mut tx, schema, true).await?;
                    match operation(SqlTransaction::Postgres(&mut tx)).await {
                        Ok(result) => {
                            tx.commit().await.map_err(postgres_error)?;
                            lease.finished = true;
                            Ok(result)
                        }
                        Err(err) => {
                            let clean_domain = !matches!(
                                err,
                                PortError::Internal(_)
                                    | PortError::DeadlineExceeded(_)
                                    | PortError::Cancelled(_)
                            );
                            if clean_domain && tx.rollback().await.is_ok() {
                                lease.finished = true;
                            }
                            Err(err)
                        }
                    }
                })
                .await
                .map_err(|_| deadline())?
            }
            Backend::Sqlite(sqlite) => {
                let permit =
                    tokio::time::timeout_at(budget, Arc::clone(&sqlite.permits).acquire_owned())
                        .await
                        .map_err(|_| deadline())?
                        .map_err(|_| internal("projection_reader_pool"))?;
                let database = Arc::clone(self);
                let runtime = Handle::current();
                let abort = ReadAbort {
                    flag: Arc::new(AtomicBool::new(false)),
                    gate: Arc::clone(&sqlite.checkpoint),
                };
                let abort_worker = Arc::clone(&abort.flag);
                let task = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let Backend::Sqlite(sqlite) = &database.0 else {
                        unreachable!();
                    };
                    let _checkpoint = sqlite.checkpoint.admit(cutoff, &abort_worker)?;
                    if Instant::now() >= cutoff || abort_worker.load(Ordering::Acquire) {
                        return Err(deadline());
                    }
                    let reader = sqlite
                        .readers
                        .lock()
                        .map_err(|_| internal("projection_reader_lock"))?
                        .pop()
                        .ok_or_else(|| internal("projection_reader_pool"))?;
                    let mut guard = ReaderGuard {
                        sqlite,
                        reader: Some(reader),
                    };
                    run_sqlite_read(
                        guard.reader.as_mut().expect("reader present"),
                        cutoff,
                        abort_worker,
                        runtime,
                        operation,
                    )
                });
                let result = tokio::time::timeout_at(budget, task)
                    .await
                    .map_err(|_| deadline())?;
                drop(abort);
                result.map_err(join_error)?
            }
        }
    }
}

struct PgReadConnection {
    connection: PoolConnection<Postgres>,
    finished: bool,
}

impl Drop for PgReadConnection {
    fn drop(&mut self) {
        if !self.finished {
            self.connection.close_on_drop();
        }
    }
}

struct ReadAbort {
    flag: Arc<AtomicBool>,
    gate: Arc<CheckpointGate>,
}

impl Drop for ReadAbort {
    fn drop(&mut self) {
        self.flag.store(true, Ordering::Release);
        self.gate.wake_all();
    }
}

fn run_sqlite_read<T, F>(
    reader: &mut Connection,
    limit: Instant,
    aborted: Arc<AtomicBool>,
    runtime: Handle,
    operation: F,
) -> Result<T, PortError>
where
    F: for<'a> FnOnce(SqlTransaction<'a>) -> SqlFuture<'a, T> + Send + 'static,
{
    let stop = Arc::clone(&aborted);
    reader
        .progress_handler(
            128,
            Some(move || Instant::now() >= limit || stop.load(Ordering::Acquire)),
        )
        .map_err(sqlite_error)?;
    let result = (|| {
        reader
            .execute_batch("BEGIN DEFERRED")
            .map_err(sqlite_error)?;
        let result = runtime.block_on(operation(SqlTransaction::Sqlite(reader)))?;
        if Instant::now() >= limit || aborted.load(Ordering::Acquire) {
            return Err(deadline());
        }
        reader.execute_batch("COMMIT").map_err(sqlite_error)?;
        Ok(result)
    })();
    reader
        .progress_handler(0, None::<fn() -> bool>)
        .map_err(sqlite_error)?;
    if !reader.is_autocommit() {
        reader.execute_batch("ROLLBACK").map_err(sqlite_error)?;
    }
    result
}

fn open_reader(path: &Path) -> Result<Connection, PortError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sqlite_error)?;
    conn.busy_timeout(Duration::from_millis(25))
        .map_err(sqlite_error)?;
    conn.execute_batch("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;")
        .map_err(sqlite_error)?;
    conn.set_prepared_statement_cache_capacity(96);
    Ok(conn)
}

#[cfg(target_os = "linux")]
fn suppress_access_times(directory: &Path) {
    use rustix::fs::{IFlags, Mode, OFlags, ioctl_getflags, ioctl_setflags, open};

    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    if let Ok(dir) = open(directory, flags, Mode::empty())
        && let Ok(flags) = ioctl_getflags(&dir)
        && !flags.contains(IFlags::NOATIME)
    {
        let _ = ioctl_setflags(&dir, flags | IFlags::NOATIME);
    }
}

async fn configure_postgres(
    tx: &mut PgConnection,
    schema: &str,
    read: bool,
) -> Result<(), PortError> {
    let settings = if read {
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
         SET LOCAL statement_timeout = '240ms';
         SET LOCAL idle_in_transaction_session_timeout = '240ms';
         SET LOCAL client_connection_check_interval = '10ms';"
    } else {
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCAL synchronous_commit = on;"
    };
    let sql = format!("{settings} SET LOCAL search_path TO \"{schema}\", pg_catalog;");
    sqlx::raw_sql(AssertSqlSafe(sql.as_str()))
        .execute(&mut *tx)
        .await
        .map_err(postgres_error)?;
    Ok(())
}

pub(super) fn validate_schema_prefix(value: &str) -> Result<&str, PortError> {
    let validated = validate_identifier(value)?;
    if validated.len() > MAX_SCHEMA_PREFIX_LEN {
        return Err(notarium_core::DomainError::validation(
            notarium_core::error::ValidationReason::InvalidId,
        )
        .into());
    }
    Ok(validated)
}

pub(super) fn validate_identifier(value: &str) -> Result<&str, PortError> {
    if !value.is_empty()
        && value.len() <= 63
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Ok(value);
    }
    Err(
        notarium_core::DomainError::validation(notarium_core::error::ValidationReason::InvalidId)
            .into(),
    )
}

pub(super) enum SqlTransaction<'a> {
    Sqlite(&'a mut Connection),
    Postgres(&'a mut PgConnection),
}

impl SqlTransaction<'_> {
    pub(super) fn postgres(&self) -> bool {
        matches!(self, Self::Postgres(_))
    }

    pub(super) async fn batch(&mut self, sql: &str) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => conn.execute_batch(sql).map_err(sqlite_error),
            Self::Postgres(conn) => {
                sqlx::raw_sql(AssertSqlSafe(sql))
                    .execute(&mut **conn)
                    .await
                    .map_err(postgres_error)?;
                Ok(())
            }
        }
    }

    pub(super) async fn execute(
        &mut self,
        sql: &str,
        params: Vec<SqlValue>,
    ) -> Result<u64, PortError> {
        match self {
            Self::Sqlite(conn) => sqlite_execute(conn, sql, &params, true),
            Self::Postgres(conn) => {
                let sql = postgres_parameters(sql);
                let query = bind_postgres(&sql, params)?;
                Ok(query
                    .execute(&mut **conn)
                    .await
                    .map_err(postgres_error)?
                    .rows_affected())
            }
        }
    }

    /// Executes a dynamically shaped statement (such as a multi-row `VALUES`
    /// batch) without polluting the prepared statement cache.
    pub(super) async fn execute_uncached(
        &mut self,
        sql: &str,
        params: Vec<SqlValue>,
    ) -> Result<u64, PortError> {
        match self {
            Self::Sqlite(conn) => sqlite_execute(conn, sql, &params, false),
            Self::Postgres(conn) => {
                let sql = postgres_parameters(sql);
                let query = bind_postgres(&sql, params)?.persistent(false);
                Ok(query
                    .execute(&mut **conn)
                    .await
                    .map_err(postgres_error)?
                    .rows_affected())
            }
        }
    }

    pub(super) async fn select(
        &mut self,
        sql: &str,
        params: Vec<SqlValue>,
        kinds: &[Kind],
    ) -> Result<Vec<Vec<SqlValue>>, PortError> {
        match self {
            Self::Sqlite(conn) => sqlite_select(conn, sql, &params, kinds),
            Self::Postgres(conn) => {
                let sql = postgres_parameters(sql);
                let query = bind_postgres(&sql, params)?;
                query
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(postgres_error)?
                    .into_iter()
                    .map(|row| {
                        kinds
                            .iter()
                            .enumerate()
                            .map(|(i, kind)| kind.postgres(&row, i).map_err(postgres_error))
                            .collect()
                    })
                    .collect()
            }
        }
    }

    pub(super) async fn records<R: SqlRecord>(
        &mut self,
        sql: &str,
        params: Vec<SqlValue>,
    ) -> Result<Vec<R>, PortError> {
        self.select(sql, params, &R::kinds())
            .await?
            .into_iter()
            .map(R::read)
            .collect()
    }
}

fn sqlite_execute(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
    cached: bool,
) -> Result<u64, PortError> {
    let count = if cached {
        let mut statement = conn.prepare_cached(sql).map_err(sqlite_error)?;
        statement
            .execute(rusqlite::params_from_iter(params))
            .map_err(sqlite_error)?
    } else {
        let mut statement = conn.prepare(sql).map_err(sqlite_error)?;
        statement
            .execute(rusqlite::params_from_iter(params))
            .map_err(sqlite_error)?
    };
    Ok(count as u64)
}

fn sqlite_select(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
    kinds: &[Kind],
) -> Result<Vec<Vec<SqlValue>>, PortError> {
    let mut statement = conn.prepare_cached(sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params), |row| {
            kinds
                .iter()
                .enumerate()
                .map(|(i, kind)| kind.sqlite(row, i))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(sqlite_error)?;
    rows.map(|row| row.map_err(sqlite_error)).collect()
}

fn postgres_parameters(sql: &str) -> String {
    use std::fmt::Write;
    let mut result = String::with_capacity(sql.len() + 16);
    let mut index = 0usize;
    let mut in_single = false;
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_single {
            result.push(ch);
            if ch == '\'' {
                if chars.peek() == Some(&'\'') {
                    result.push(chars.next().expect("peeked quote"));
                } else {
                    in_single = false;
                }
            }
        } else if ch == '\'' {
            in_single = true;
            result.push(ch);
        } else if ch == '?' {
            index += 1;
            write!(result, "${index}").expect("writing to a String");
        } else {
            result.push(ch);
        }
    }
    result
}

fn bind_postgres(
    sql: &str,
    params: Vec<SqlValue>,
) -> Result<Query<'_, sqlx::Postgres, PgArguments>, PortError> {
    let mut query = sqlx::query(AssertSqlSafe(sql));
    for param in params {
        query = match param {
            SqlValue::Integer(value) => query.bind(value),
            SqlValue::Text(value) => query.bind(value),
            SqlValue::Bytes(value) => query.bind(value),
            SqlValue::IntArray(values) => query.bind(values),
            SqlValue::TextArray(values) => query.bind(values),
            SqlValue::OutOfRange => return Err(invalid_row()),
        };
    }
    Ok(query)
}

fn sqlite_extended_code(error: &rusqlite::Error) -> Option<i32> {
    match error {
        rusqlite::Error::SqliteFailure(ffi, _) => Some(ffi.extended_code),
        _ => None,
    }
}

fn sqlite_error(error: rusqlite::Error) -> PortError {
    if matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::OperationInterrupted)
    ) {
        return deadline();
    }
    tracing::warn!(
        error_code = ?error.sqlite_error_code(),
        extended_code = sqlite_extended_code(&error),
        "derived SQLite operation failed"
    );
    internal("projection_sqlite_operation")
}

fn postgres_error(error: sqlx::Error) -> PortError {
    if matches!(error, sqlx::Error::PoolTimedOut) {
        return deadline();
    }
    let code = error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code);
    match code.as_deref() {
        Some("57014" | "25P03") => return deadline(),
        Some("40P01" | "55P03") => {
            return notarium_canonical::codec::unavailable_retryable(
                "projection_postgres_lock_contention",
                "derived PostgreSQL lock conflict or deadlock",
                Duration::from_millis(20),
            );
        }
        _ => {}
    }
    let kind = match &error {
        sqlx::Error::Database(_) => "database",
        sqlx::Error::Io(_) => "io",
        sqlx::Error::Protocol(_) => "protocol",
        sqlx::Error::PoolClosed => "pool_closed",
        sqlx::Error::WorkerCrashed => "worker_crashed",
        sqlx::Error::Decode(_) => "decode",
        _ => "other",
    };
    tracing::warn!(
        error_code = ?code,
        error_kind = kind,
        "derived PostgreSQL operation failed"
    );
    internal("projection_postgres_operation")
}

fn commit_error(_: sqlx::Error) -> PortError {
    unknown_commit()
}

fn unknown_commit() -> PortError {
    PortError::Internal(failure(
        "projection_store_commit_unknown",
        CommitEffect::Unknown,
    ))
}

fn join_error(_: tokio::task::JoinError) -> PortError {
    internal("projection_database_worker")
}
