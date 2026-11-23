use std::{fs, path::Path, time::Duration};

use notarium_core::{
    epoch::{DataRoot, DatabaseState, DatabaseWitness, MarkerObservation},
    error::PortError,
    ids::InstallationId,
};
use sqlx::{
    Connection, Row, SqliteConnection, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteSynchronous},
};

use crate::{
    codec::internal_not_committed,
    schema::{
        bootstrap_sqlite_schema,
        manifest::{CANONICAL_SCHEMA_VERSION, manifest_checksum},
    },
};

#[cfg(test)]
mod bootstrap_tests;

pub const SQLITE_JOURNAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

#[cfg(target_os = "linux")]
fn suppress_database_access_times(directory: &std::path::Path) {
    use rustix::fs::{IFlags, Mode, OFlags, ioctl_getflags, ioctl_setflags, open};

    // On ext4 an atime update can block a SQLite read on journal space. Newly
    // created database files inherit this directory flag, including WAL sidecars.
    let options = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    if let Ok(dir) = open(directory, options, Mode::empty())
        && let Ok(flags) = ioctl_getflags(&dir)
        && !flags.contains(IFlags::NOATIME)
    {
        // Timestamp policy is optional on filesystems or mounts that deny the ioctl.
        let _ = ioctl_setflags(&dir, flags | IFlags::NOATIME);
    }
}

pub async fn open_and_bootstrap_sqlite(
    data_root: &DataRoot,
    installation_id: &InstallationId,
    read_pool_size: u32,
) -> Result<
    (
        SqliteConnection,
        rusqlite::Connection,
        Vec<rusqlite::Connection>,
        SqlitePool,
        DatabaseWitness,
    ),
    PortError,
> {
    let db_path = data_root.canonical();
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| internal_not_committed("sqlite_parent_mkdir", err.to_string()))?;
        #[cfg(target_os = "linux")]
        suppress_database_access_times(parent);
    }

    let writer_conn = open_sqlite_writer_connection(&db_path).await?;
    let (writer_conn, witness) = bootstrap_new_writer(writer_conn, installation_id).await?;

    if let Some(parent) = db_path.parent()
        && let Ok(dir_file) = fs::File::open(parent)
    {
        let _ = dir_file.sync_all();
    }

    let rusqlite_writer = open_rusqlite_writer_connection(&db_path)?;
    let fast_reader_count = (read_pool_size as usize * 4).clamp(16, 32);
    let mut fast_readers = Vec::with_capacity(fast_reader_count);
    for _ in 0..fast_reader_count {
        fast_readers.push(open_rusqlite_readonly_connection(&db_path)?);
    }

    let read_pool = open_sqlite_read_pool(&db_path, read_pool_size).await?;
    Ok((
        writer_conn,
        rusqlite_writer,
        fast_readers,
        read_pool,
        witness,
    ))
}

// This newly opened connection has no TEMP objects; changing temp_store
// would drop them on an already-serving connection.
async fn bootstrap_new_writer(
    mut conn: SqliteConnection,
    installation_id: &InstallationId,
) -> Result<(SqliteConnection, DatabaseWitness), PortError> {
    sqlx::query("PRAGMA temp_store = FILE")
        .execute(&mut conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_bootstrap_temp_store", err.to_string()))?;
    let witness = bootstrap_sqlite_schema(&mut conn, installation_id).await?;
    sqlx::query("PRAGMA temp_store = MEMORY")
        .execute(&mut conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_writer_temp_store", err.to_string()))?;
    verify_writer_pragmas(&mut conn).await?;
    Ok((conn, witness))
}

pub fn open_rusqlite_writer_connection(db_path: &Path) -> Result<rusqlite::Connection, PortError> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| internal_not_committed("rusqlite_writer_connect", err.to_string()))?;

    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|err| internal_not_committed("rusqlite_writer_busy_timeout", err.to_string()))?;
    conn.set_prepared_statement_cache_capacity(256);

    conn.execute_batch(
        "PRAGMA fullfsync = ON;
         PRAGMA synchronous = FULL;
         PRAGMA secure_delete = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA wal_autocheckpoint = 0;
         PRAGMA journal_size_limit = 67108864;
         PRAGMA foreign_keys = ON;
         PRAGMA cache_size = -524288;
         PRAGMA mmap_size = 268435456;
         PRAGMA temp_store = MEMORY;",
    )
    .map_err(|err| internal_not_committed("rusqlite_apply_pragma", err.to_string()))?;

    let secure_delete: i64 = conn
        .query_row("PRAGMA secure_delete", [], |r| r.get(0))
        .map_err(|err| internal_not_committed("rusqlite_verify_secure_delete", err.to_string()))?;
    if secure_delete != 1 {
        return Err(internal_not_committed(
            "sqlite_secure_delete_disabled",
            format!("PRAGMA secure_delete={secure_delete}, expected 1"),
        ));
    }

    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .map_err(|err| internal_not_committed("rusqlite_verify_journal_mode", err.to_string()))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(internal_not_committed(
            "sqlite_journal_mode_invalid",
            format!("PRAGMA journal_mode={journal_mode}, expected wal"),
        ));
    }

    let (synchronous, fullfsync): (i64, i64) = conn
        .query_row(
            "SELECT synchronous, fullfsync FROM pragma_synchronous, pragma_fullfsync",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|err| internal_not_committed("rusqlite_verify_synchronous", err.to_string()))?;
    if (synchronous, fullfsync) != (2, 1) {
        return Err(internal_not_committed(
            "sqlite_synchronous_invalid",
            format!("expected synchronous=2 and fullfsync=1, got {synchronous} and {fullfsync}"),
        ));
    }

    let autocheckpoint: i64 = conn
        .query_row("PRAGMA wal_autocheckpoint", [], |r| r.get(0))
        .map_err(|err| internal_not_committed("rusqlite_verify_autocheckpoint", err.to_string()))?;
    if autocheckpoint != 0 {
        return Err(internal_not_committed(
            "sqlite_autocheckpoint_invalid",
            format!("PRAGMA wal_autocheckpoint={autocheckpoint}, expected 0"),
        ));
    }

    let journal_limit: i64 = conn
        .query_row("PRAGMA journal_size_limit", [], |r| r.get(0))
        .map_err(|err| internal_not_committed("rusqlite_verify_journal_limit", err.to_string()))?;
    if journal_limit != SQLITE_JOURNAL_SIZE_LIMIT_BYTES {
        return Err(internal_not_committed(
            "sqlite_journal_limit_invalid",
            format!(
                "PRAGMA journal_size_limit={journal_limit}, expected {SQLITE_JOURNAL_SIZE_LIMIT_BYTES}"
            ),
        ));
    }

    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .map_err(|err| internal_not_committed("rusqlite_verify_foreign_keys", err.to_string()))?;
    if foreign_keys != 1 {
        return Err(internal_not_committed(
            "sqlite_foreign_keys_disabled",
            format!("PRAGMA foreign_keys={foreign_keys}, expected 1"),
        ));
    }

    // Install `wal_hook` AFTER `PRAGMA wal_autocheckpoint = 0` (which calls `sqlite3_wal_hook(NULL)`!).
    conn.wal_hook(Some(crate::wal::sqlite_writer_wal_hook));

    Ok(conn)
}

pub fn open_rusqlite_readonly_connection(
    db_path: &Path,
) -> Result<rusqlite::Connection, PortError> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| internal_not_committed("rusqlite_readonly_connect", err.to_string()))?;

    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|err| internal_not_committed("rusqlite_readonly_busy_timeout", err.to_string()))?;
    conn.set_prepared_statement_cache_capacity(64);
    conn.execute_batch(
        "PRAGMA query_only = ON;
         PRAGMA foreign_keys = ON;
         PRAGMA cache_size = -16384;
         PRAGMA temp_store = MEMORY;",
    )
    .map_err(|err| internal_not_committed("rusqlite_readonly_pragmas", err.to_string()))?;
    Ok(conn)
}

/// Opens a dedicated non-blocking checkpoint connection for `PRAGMA wal_checkpoint(PASSIVE)`
/// so background `PASSIVE` checkpoints run concurrently with `WriteBatchActor` without contending on `writer.lock()`.
pub fn open_rusqlite_checkpoint_connection(
    db_path: &Path,
) -> Result<rusqlite::Connection, PortError> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| internal_not_committed("rusqlite_ckpt_connect", err.to_string()))?;

    conn.busy_timeout(Duration::ZERO)
        .map_err(|err| internal_not_committed("rusqlite_ckpt_busy_timeout", err.to_string()))?;
    conn.execute_batch(
        "PRAGMA fullfsync = ON;
         PRAGMA synchronous = FULL;
         PRAGMA secure_delete = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA wal_autocheckpoint = 0;
         PRAGMA foreign_keys = ON;
         PRAGMA cache_size = -8192;
         PRAGMA temp_store = MEMORY;",
    )
    .map_err(|err| internal_not_committed("rusqlite_ckpt_pragmas", err.to_string()))?;
    Ok(conn)
}

pub async fn open_sqlite_writer_connection(db_path: &Path) -> Result<SqliteConnection, PortError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        // SQLx orders its journal_mode option before custom pragmas. Enter WAL
        // in apply_writer_pragmas, after fullfsync is active on this connection.
        .pragma("fullfsync", "ON")
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| internal_not_committed("sqlite_writer_connect", err.to_string()))?;

    apply_writer_pragmas(&mut conn).await?;
    verify_writer_pragmas(&mut conn).await?;
    Ok(conn)
}

async fn apply_writer_pragmas(conn: &mut SqliteConnection) -> Result<(), PortError> {
    for stmt in [
        "PRAGMA synchronous = FULL",
        "PRAGMA secure_delete = ON",
        "PRAGMA journal_mode = WAL",
        "PRAGMA wal_autocheckpoint = 0",
        "PRAGMA journal_size_limit = 67108864",
        "PRAGMA foreign_keys = ON",
        "PRAGMA cache_size = -65536",
        "PRAGMA temp_store = MEMORY",
    ] {
        sqlx::query(stmt)
            .execute(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_apply_pragma", err.to_string()))?;
    }
    Ok(())
}

pub async fn verify_writer_pragmas(conn: &mut SqliteConnection) -> Result<(), PortError> {
    let secure_delete: i64 = sqlx::query_scalar("PRAGMA secure_delete")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_verify_secure_delete", err.to_string()))?;
    if secure_delete != 1 {
        return Err(internal_not_committed(
            "sqlite_secure_delete_disabled",
            format!("PRAGMA secure_delete={secure_delete}, expected 1"),
        ));
    }

    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_verify_journal_mode", err.to_string()))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(internal_not_committed(
            "sqlite_journal_mode_invalid",
            format!("PRAGMA journal_mode={journal_mode}, expected wal"),
        ));
    }

    let (synchronous, fullfsync): (i64, i64) =
        sqlx::query_as("SELECT synchronous, fullfsync FROM pragma_synchronous, pragma_fullfsync")
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_verify_synchronous", err.to_string()))?;
    // FULL is 2 in SQLite.
    if (synchronous, fullfsync) != (2, 1) {
        return Err(internal_not_committed(
            "sqlite_synchronous_invalid",
            format!("expected synchronous=2 and fullfsync=1, got {synchronous} and {fullfsync}"),
        ));
    }

    let autocheckpoint: i64 = sqlx::query_scalar("PRAGMA wal_autocheckpoint")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_verify_autocheckpoint", err.to_string()))?;
    if autocheckpoint != 0 {
        return Err(internal_not_committed(
            "sqlite_autocheckpoint_invalid",
            format!("PRAGMA wal_autocheckpoint={autocheckpoint}, expected 0"),
        ));
    }

    let journal_limit: i64 = sqlx::query_scalar("PRAGMA journal_size_limit")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_verify_journal_limit", err.to_string()))?;
    if journal_limit != SQLITE_JOURNAL_SIZE_LIMIT_BYTES {
        return Err(internal_not_committed(
            "sqlite_journal_limit_invalid",
            format!(
                "PRAGMA journal_size_limit={journal_limit}, expected {SQLITE_JOURNAL_SIZE_LIMIT_BYTES}"
            ),
        ));
    }

    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_verify_foreign_keys", err.to_string()))?;
    if foreign_keys != 1 {
        return Err(internal_not_committed(
            "sqlite_foreign_keys_disabled",
            format!("PRAGMA foreign_keys={foreign_keys}, expected 1"),
        ));
    }

    Ok(())
}

pub async fn open_sqlite_read_pool(
    db_path: &Path,
    max_connections: u32,
) -> Result<SqlitePool, PortError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    SqlitePoolOptions::new()
        .max_connections(max_connections.max(1))
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("PRAGMA query_only = ON")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA foreign_keys = ON")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA cache_size = -8192")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA temp_store = MEMORY")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(|err| internal_not_committed("sqlite_read_pool_connect", err.to_string()))
}

/// Non-mutating observation of `v1/canonical.sqlite` for `notarium_core::epoch::classify`.
pub async fn observe_sqlite_canonical_witness(
    data_root: &DataRoot,
) -> MarkerObservation<DatabaseWitness> {
    let db_path = data_root.canonical();
    if !db_path.exists() {
        return MarkerObservation::Missing;
    }
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .read_only(true)
        .create_if_missing(false);

    let mut conn = match SqliteConnection::connect_with(&options).await {
        Ok(conn) => conn,
        Err(_) => return MarkerObservation::Unreadable,
    };

    let row = match sqlx::query(
        "SELECT schema_version, epoch_version, installation_id, migration_state, manifest_checksum
         FROM schema_meta WHERE singleton_id = 1",
    )
    .fetch_optional(&mut conn)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return MarkerObservation::Invalid,
        Err(_) => return MarkerObservation::Invalid,
    };

    let schema_raw: i64 = row.get("schema_version");
    let epoch_raw: i64 = row.get("epoch_version");
    let installation_raw: String = row.get("installation_id");
    let state_raw: String = row.get("migration_state");
    let checksum_bytes: Vec<u8> = row.get("manifest_checksum");

    let current = schema_raw == i64::from(CANONICAL_SCHEMA_VERSION)
        && checksum_bytes.as_slice() == manifest_checksum().as_bytes();
    let recognized_predecessor =
        crate::schema::migrate::predecessor(schema_raw, &checksum_bytes).is_some();
    if !current && !recognized_predecessor {
        return MarkerObservation::Invalid;
    }

    let Ok(epoch_version) = u32::try_from(epoch_raw) else {
        return MarkerObservation::Invalid;
    };
    let Ok(installation_id) = InstallationId::parse(&installation_raw) else {
        return MarkerObservation::Invalid;
    };
    let state = match state_raw.as_str() {
        "ready" => DatabaseState::Ready,
        "migrating" => DatabaseState::Migrating,
        _ => return MarkerObservation::Invalid,
    };

    let _ = conn.close().await;
    MarkerObservation::Present(DatabaseWitness {
        epoch_version,
        installation_id,
        state,
    })
}
