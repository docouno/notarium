use std::{fs, path::Path, time::Duration};

use notarium_core::{
    epoch::{DataRoot, DatabaseState, DatabaseWitness, MarkerObservation},
    error::PortError,
    ids::InstallationId,
};
use sqlx::{
    Connection, Row, SqliteConnection, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

use crate::{
    codec::internal_not_committed,
    schema::{
        bootstrap_sqlite_schema,
        manifest::{CANONICAL_SCHEMA_VERSION, manifest_checksum},
    },
};

pub const SQLITE_JOURNAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

pub async fn open_and_bootstrap_sqlite(
    data_root: &DataRoot,
    installation_id: &InstallationId,
    read_pool_size: u32,
) -> Result<(SqliteConnection, SqlitePool, DatabaseWitness), PortError> {
    let db_path = data_root.canonical();
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| internal_not_committed("sqlite_parent_mkdir", err.to_string()))?;
    }

    let mut writer_conn = open_sqlite_writer_connection(&db_path).await?;
    let witness = bootstrap_sqlite_schema(&mut writer_conn, installation_id).await?;
    verify_writer_pragmas(&mut writer_conn).await?;

    if let Some(parent) = db_path.parent()
        && let Ok(dir_file) = fs::File::open(parent)
    {
        let _ = dir_file.sync_all();
    }

    let read_pool = open_sqlite_read_pool(&db_path, read_pool_size).await?;
    Ok((writer_conn, read_pool, witness))
}

pub async fn open_sqlite_writer_connection(db_path: &Path) -> Result<SqliteConnection, PortError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
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
        "PRAGMA secure_delete = ON",
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = FULL",
        "PRAGMA wal_autocheckpoint = 0",
        "PRAGMA journal_size_limit = 67108864",
        "PRAGMA foreign_keys = ON",
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

    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_verify_synchronous", err.to_string()))?;
    // FULL is 2 in SQLite.
    if synchronous != 2 {
        return Err(internal_not_committed(
            "sqlite_synchronous_invalid",
            format!("PRAGMA synchronous={synchronous}, expected 2 (FULL)"),
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

    if schema_raw != i64::from(CANONICAL_SCHEMA_VERSION) {
        return MarkerObservation::Invalid;
    }
    if checksum_bytes.as_slice() != manifest_checksum().as_bytes() {
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
