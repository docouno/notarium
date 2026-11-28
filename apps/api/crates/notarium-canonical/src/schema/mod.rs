pub mod manifest;
pub(crate) mod migrate;

use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    epoch::{DatabaseState, DatabaseWitness, SUPPORTED_V1_EPOCH},
    error::PortError,
    ids::{ContentDigest, InstallationId},
};
use sqlx::{PgConnection, Row, SqliteConnection};

use crate::{
    codec::{encode_timestamp_parts, internal_not_committed, now_utc_timestamp},
    schema::manifest::{
        CANONICAL_SCHEMA_VERSION, CANONICAL_TABLES, LogicalColKind, expected_index_names,
        expected_table_names, manifest_checksum,
    },
};

pub const SQLITE_BASELINE_DDL: &str = include_str!("sqlite_ddl.sql");
pub const POSTGRES_BASELINE_DDL: &str = include_str!("postgres_ddl.sql");

/// Splits embedded SQL scripts into individual top-level statements (`;` outside quotes).
pub fn split_sql_statements(script: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut chars = script.chars().peekable();

    while let Some(ch) = chars.next() {
        if !in_single_quote && ch == '-' && chars.peek() == Some(&'-') {
            for next in chars.by_ref() {
                if next == '\n' {
                    current.push('\n');
                    break;
                }
            }
            continue;
        }
        if ch == '\'' {
            if in_single_quote && chars.peek() == Some(&'\'') {
                current.push('\'');
                current.push('\'');
                chars.next();
                continue;
            }
            in_single_quote = !in_single_quote;
            current.push(ch);
            continue;
        }
        if ch == ';' && !in_single_quote {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                statements.push(trimmed.to_owned());
            }
            current.clear();
            continue;
        }
        current.push(ch);
    }
    let tail = current.trim();
    if !tail.is_empty() {
        statements.push(tail.to_owned());
    }
    statements
}

/// Initializes or validates the SQLite canonical baseline schema inside a write transaction.
///
/// The caller owns the connection's temporary storage mode and TEMP objects.
/// To let large index sorts spill to disk, set `PRAGMA temp_store = FILE` on a
/// fresh connection before creating any TEMP objects or starting a transaction.
pub async fn bootstrap_sqlite_schema(
    conn: &mut SqliteConnection,
    expected_installation: &InstallationId,
) -> Result<DatabaseWitness, PortError> {
    let expected_checksum = manifest_checksum();

    let needs_fk_rebuild = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_bootstrap_probe_meta", err.to_string()))?
    .is_some()
        && sqlx::query_scalar::<_, i64>(
            "SELECT CAST(schema_version AS INTEGER) FROM schema_meta WHERE singleton_id = 1",
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_bootstrap_probe_version", err.to_string()))?
        .is_some_and(|version| version < i64::from(CANONICAL_SCHEMA_VERSION));

    if needs_fk_rebuild {
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_bootstrap_fk_off", err.to_string()))?;
        sqlx::query("PRAGMA legacy_alter_table = ON")
            .execute(&mut *conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_bootstrap_legacy_alter_on", err.to_string())
            })?;
    }

    let result = async {
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_bootstrap_begin", err.to_string()))?;

        let outcome = async {
            let witness =
                bootstrap_sqlite_inner(conn, expected_installation, expected_checksum).await?;
            if needs_fk_rebuild {
                let fk_violation = sqlx::query("PRAGMA foreign_key_check")
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_bootstrap_fk_check", err.to_string())
                    })?;
                if fk_violation.is_some() {
                    return Err(internal_not_committed(
                        "sqlite_bootstrap_fk_violation",
                        "foreign key check failed after schema upgrade",
                    ));
                }
            }
            Ok(witness)
        }
        .await;

        match outcome {
            Ok(witness) => {
                sqlx::query("COMMIT")
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_bootstrap_commit", err.to_string())
                    })?;
                Ok(witness)
            }
            Err(err) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(err)
            }
        }
    }
    .await;

    if needs_fk_rebuild {
        let _ = sqlx::query("PRAGMA legacy_alter_table = OFF")
            .execute(&mut *conn)
            .await;
        let _ = sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut *conn)
            .await;
    }

    result
}

async fn bootstrap_sqlite_inner(
    conn: &mut SqliteConnection,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    let existing_tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_inspect_tables", err.to_string()))?;

    let has_schema_meta = existing_tables.iter().any(|name| name == "schema_meta");
    if !existing_tables.is_empty() && !has_schema_meta {
        return Err(internal_not_committed(
            "sqlite_unrecognized_schema",
            "tables exist without schema_meta witness",
        ));
    }

    if has_schema_meta {
        migrate::sqlite(conn, expected_installation, expected_checksum).await?;
        let witness =
            inspect_sqlite_schema_meta(conn, expected_installation, expected_checksum).await?;
        verify_sqlite_catalog(conn).await?;
        return Ok(witness);
    }

    let (now_sec, now_nsec) = encode_timestamp_parts(now_utc_timestamp()?);
    for stmt in split_sql_statements(SQLITE_BASELINE_DDL) {
        sqlx::query(sqlx::AssertSqlSafe(stmt))
            .execute(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_ddl_exec", err.to_string()))?;
    }

    sqlx::query(
        "INSERT INTO schema_meta (
            singleton_id, schema_version, epoch_version, installation_id,
            migration_state, manifest_checksum,
            initialized_at_sec, initialized_at_nsec, updated_at_sec, updated_at_nsec
        ) VALUES (1, ?, ?, ?, 'migrating', ?, ?, ?, ?, ?)",
    )
    .bind(i64::from(CANONICAL_SCHEMA_VERSION))
    .bind(i64::from(SUPPORTED_V1_EPOCH))
    .bind(expected_installation.as_str())
    .bind(expected_checksum.as_bytes().as_slice())
    .bind(now_sec)
    .bind(now_nsec)
    .bind(now_sec)
    .bind(now_nsec)
    .execute(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_insert_schema_meta", err.to_string()))?;

    verify_sqlite_catalog(conn).await?;

    sqlx::query("UPDATE schema_meta SET migration_state = 'ready' WHERE singleton_id = 1")
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_mark_ready", err.to_string()))?;

    inspect_sqlite_schema_meta(conn, expected_installation, expected_checksum).await
}

async fn inspect_sqlite_schema_meta(
    conn: &mut SqliteConnection,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    let row = sqlx::query(
        "SELECT schema_version, epoch_version, installation_id, migration_state, manifest_checksum
         FROM schema_meta WHERE singleton_id = 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_read_schema_meta", err.to_string()))?
    .ok_or_else(|| {
        internal_not_committed("sqlite_missing_schema_meta_row", "singleton row 1 absent")
    })?;

    let schema_version: i64 = row.get("schema_version");
    let epoch_version: i64 = row.get("epoch_version");
    let installation_raw: String = row.get("installation_id");
    let migration_state: String = row.get("migration_state");
    let checksum_bytes: Vec<u8> = row.get("manifest_checksum");

    validate_meta_fields(
        schema_version,
        epoch_version,
        &installation_raw,
        &migration_state,
        &checksum_bytes,
        expected_installation,
        expected_checksum,
    )
}

/// Initializes or validates the PostgreSQL canonical baseline schema inside an advisory-locked transaction.
pub async fn bootstrap_postgres_schema(
    conn: &mut PgConnection,
    schema_name: &str,
    expected_installation: &InstallationId,
) -> Result<DatabaseWitness, PortError> {
    let schema_name = crate::config::validate_pg_schema_name(schema_name)?;
    let expected_checksum = manifest_checksum();

    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_bootstrap_begin", err.to_string()))?;

    let outcome =
        bootstrap_postgres_inner(conn, schema_name, expected_installation, expected_checksum).await;

    match outcome {
        Ok(witness) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| internal_not_committed("pg_bootstrap_commit", err.to_string()))?;
            Ok(witness)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

async fn bootstrap_postgres_inner(
    conn: &mut PgConnection,
    schema_name: &str,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    // Snapshot live ranks and change the chat writer's representation only after
    // in-flight writers release the schema-wide writer fence.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7311229))")
        .bind(schema_name)
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_bootstrap_snapshot_fence", err.to_string()))?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 20261115))")
        .bind(schema_name)
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_migration_lock", err.to_string()))?;

    let create_schema_sql = format!("CREATE SCHEMA IF NOT EXISTS \"{schema_name}\"");
    sqlx::query(sqlx::AssertSqlSafe(create_schema_sql))
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_create_schema", err.to_string()))?;

    let set_path_sql = format!("SET LOCAL search_path TO \"{schema_name}\"");
    sqlx::query(sqlx::AssertSqlSafe(set_path_sql))
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_set_search_path", err.to_string()))?;

    let existing_tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    )
    .bind(schema_name)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_inspect_tables", err.to_string()))?;

    let has_schema_meta = existing_tables.iter().any(|t| t == "schema_meta");
    if !existing_tables.is_empty() && !has_schema_meta {
        return Err(internal_not_committed(
            "pg_unrecognized_schema",
            "tables exist without schema_meta witness",
        ));
    }

    if has_schema_meta {
        migrate::postgres(conn, expected_installation, expected_checksum).await?;
        let witness =
            inspect_postgres_schema_meta(conn, expected_installation, expected_checksum).await?;
        crate::projection_fence::ensure_postgres_owner_table(conn).await?;
        verify_postgres_catalog(conn, schema_name).await?;
        return Ok(witness);
    }

    let (now_sec, now_nsec) = encode_timestamp_parts(now_utc_timestamp()?);
    for stmt in split_sql_statements(POSTGRES_BASELINE_DDL) {
        sqlx::query(sqlx::AssertSqlSafe(stmt))
            .execute(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("pg_ddl_exec", err.to_string()))?;
    }
    crate::projection_fence::ensure_postgres_owner_table(conn).await?;

    sqlx::query(
        "INSERT INTO schema_meta (
            singleton_id, schema_version, epoch_version, installation_id,
            migration_state, manifest_checksum,
            initialized_at_sec, initialized_at_nsec, updated_at_sec, updated_at_nsec
        ) VALUES (1, $1, $2, $3, 'migrating', $4, $5, $6, $5, $6)",
    )
    .bind(CANONICAL_SCHEMA_VERSION as i32)
    .bind(SUPPORTED_V1_EPOCH as i32)
    .bind(expected_installation.as_str())
    .bind(expected_checksum.as_bytes().as_slice())
    .bind(now_sec)
    .bind(now_nsec)
    .execute(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_insert_schema_meta", err.to_string()))?;

    verify_postgres_catalog(conn, schema_name).await?;

    sqlx::query("UPDATE schema_meta SET migration_state = 'ready' WHERE singleton_id = 1")
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_mark_ready", err.to_string()))?;

    inspect_postgres_schema_meta(conn, expected_installation, expected_checksum).await
}

async fn inspect_postgres_schema_meta(
    conn: &mut PgConnection,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    let row = sqlx::query(
        "SELECT schema_version, epoch_version, installation_id, migration_state, manifest_checksum
         FROM schema_meta WHERE singleton_id = 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_read_schema_meta", err.to_string()))?
    .ok_or_else(|| {
        internal_not_committed("pg_missing_schema_meta_row", "singleton row 1 absent")
    })?;

    let schema_version: i32 = row.get("schema_version");
    let epoch_version: i32 = row.get("epoch_version");
    let installation_raw: String = row.get("installation_id");
    let migration_state: String = row.get("migration_state");
    let checksum_bytes: Vec<u8> = row.get("manifest_checksum");

    validate_meta_fields(
        i64::from(schema_version),
        i64::from(epoch_version),
        &installation_raw,
        &migration_state,
        &checksum_bytes,
        expected_installation,
        expected_checksum,
    )
}

fn validate_meta_fields(
    schema_version: i64,
    epoch_version: i64,
    installation_raw: &str,
    migration_state: &str,
    checksum_bytes: &[u8],
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    if epoch_version != i64::from(SUPPORTED_V1_EPOCH) {
        return Err(internal_not_committed(
            "unsupported_epoch_version",
            format!("epoch_version={epoch_version}"),
        ));
    }
    if schema_version != i64::from(CANONICAL_SCHEMA_VERSION) {
        return Err(internal_not_committed(
            "unsupported_schema_version",
            format!("schema_version={schema_version}, supported={CANONICAL_SCHEMA_VERSION}"),
        ));
    }
    let installation_id = InstallationId::parse(installation_raw).map_err(|_| {
        internal_not_committed(
            "invalid_installation_id",
            "schema_meta.installation_id malformed",
        )
    })?;
    if &installation_id != expected_installation {
        return Err(internal_not_committed(
            "installation_mismatch",
            format!("expected {expected_installation}, found {installation_id}"),
        ));
    }
    let state = match migration_state {
        "ready" => DatabaseState::Ready,
        "migrating" => {
            return Err(internal_not_committed(
                "incomplete_migration_state",
                "schema_meta.migration_state is still 'migrating'",
            ));
        }
        other => {
            return Err(internal_not_committed(
                "invalid_migration_state",
                format!("unexpected migration_state '{other}'"),
            ));
        }
    };
    if checksum_bytes != expected_checksum.as_bytes() {
        return Err(internal_not_committed(
            "schema_checksum_mismatch",
            "schema_meta.manifest_checksum does not match canonical manifest",
        ));
    }
    Ok(DatabaseWitness {
        epoch_version: SUPPORTED_V1_EPOCH,
        installation_id,
        state,
    })
}

/// Verifies that the live SQLite database catalog matches `CANONICAL_TABLES` with zero virtual/shadow tables.
pub async fn verify_sqlite_catalog(conn: &mut SqliteConnection) -> Result<(), PortError> {
    let rows = sqlx::query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_catalog_tables", err.to_string()))?;

    let mut observed_tables = BTreeSet::new();
    for row in &rows {
        let name: String = row.get("name");
        let sql: Option<String> = row.get("sql");
        if sql
            .as_deref()
            .is_some_and(|text| text.to_ascii_uppercase().contains("VIRTUAL TABLE"))
        {
            return Err(internal_not_committed(
                "sqlite_forbidden_virtual_table",
                format!("virtual table '{name}' is forbidden"),
            ));
        }
        observed_tables.insert(name);
    }

    let expected_tables: BTreeSet<String> = expected_table_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    if observed_tables != expected_tables {
        return Err(internal_not_committed(
            "sqlite_table_mismatch",
            format!("expected {expected_tables:?}, observed {observed_tables:?}"),
        ));
    }

    for spec in CANONICAL_TABLES {
        let pragma_sql = format!("PRAGMA table_info(\"{}\")", spec.name);
        let col_rows = sqlx::query(sqlx::AssertSqlSafe(pragma_sql))
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_table_info", err.to_string()))?;

        if col_rows.len() != spec.columns.len() {
            return Err(internal_not_committed(
                "sqlite_column_count_mismatch",
                format!(
                    "table {} expected {} columns, found {}",
                    spec.name,
                    spec.columns.len(),
                    col_rows.len()
                ),
            ));
        }

        let mut pk_by_pos = BTreeMap::<i64, String>::new();
        for (col_row, col_spec) in col_rows.iter().zip(spec.columns.iter()) {
            let name: String = col_row.get("name");
            let col_type: String = col_row.get("type");
            let notnull: i64 = col_row.get("notnull");
            let pk_pos: i64 = col_row.get("pk");

            if name != col_spec.name {
                return Err(internal_not_committed(
                    "sqlite_column_name_mismatch",
                    format!(
                        "table {}: expected {}, found {name}",
                        spec.name, col_spec.name
                    ),
                ));
            }
            let expected_type = match col_spec.kind {
                LogicalColKind::Int => "INTEGER",
                LogicalColKind::Text => "TEXT",
                LogicalColKind::Bytes => "BLOB",
            };
            if col_type.to_ascii_uppercase() != expected_type {
                return Err(internal_not_committed(
                    "sqlite_column_type_mismatch",
                    format!(
                        "table {}.{}: expected {expected_type}, found {col_type}",
                        spec.name, name
                    ),
                ));
            }
            let is_nullable = notnull == 0 && pk_pos == 0;
            if is_nullable != col_spec.nullable {
                return Err(internal_not_committed(
                    "sqlite_column_nullability_mismatch",
                    format!(
                        "table {}.{}: expected nullable={}, found {is_nullable}",
                        spec.name, name, col_spec.nullable
                    ),
                ));
            }
            if pk_pos > 0 {
                pk_by_pos.insert(pk_pos, name);
            }
        }

        let observed_pk: Vec<&str> = pk_by_pos.values().map(String::as_str).collect();
        if observed_pk.as_slice() != spec.primary_key {
            return Err(internal_not_committed(
                "sqlite_pk_mismatch",
                format!(
                    "table {}: expected PK {:?}, found {observed_pk:?}",
                    spec.name, spec.primary_key
                ),
            ));
        }
    }

    let without_rowid: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pragma_table_list WHERE schema = 'main' AND name IN ('blob_catalog','payload_owners') AND wr=1",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_catalog_layout", err.to_string()))?;
    if without_rowid != 2 {
        return Err(internal_not_committed(
            "sqlite_catalog_layout",
            "blob_catalog and payload_owners require WITHOUT ROWID",
        ));
    }

    let idx_rows: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_catalog_indexes", err.to_string()))?;

    let observed_indexes: BTreeSet<&str> = idx_rows.iter().map(String::as_str).collect();
    let expected_indexes = expected_index_names();
    if observed_indexes != expected_indexes {
        return Err(internal_not_committed(
            "sqlite_index_mismatch",
            format!("expected {expected_indexes:?}, observed {observed_indexes:?}"),
        ));
    }

    Ok(())
}

/// Verifies that the live PostgreSQL catalog matches `CANONICAL_TABLES` including `spaces` `fillfactor=70`.
pub async fn verify_postgres_catalog(
    conn: &mut PgConnection,
    schema_name: &str,
) -> Result<(), PortError> {
    let observed_tables_vec: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    )
    .bind(schema_name)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_catalog_tables", err.to_string()))?;

    let observed_tables: BTreeSet<&str> = observed_tables_vec.iter().map(String::as_str).collect();
    let mut expected_tables = expected_table_names();
    expected_tables.insert("projection_space_owners");
    expected_tables.insert("projection_cleanup_registration");
    if observed_tables != expected_tables {
        return Err(internal_not_committed(
            "pg_table_mismatch",
            format!("expected {expected_tables:?}, observed {observed_tables:?}"),
        ));
    }

    for spec in CANONICAL_TABLES {
        let col_rows = sqlx::query(
            "SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position ASC",
        )
        .bind(schema_name)
        .bind(spec.name)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_table_columns", err.to_string()))?;

        if col_rows.len() != spec.columns.len() {
            return Err(internal_not_committed(
                "pg_column_count_mismatch",
                format!(
                    "table {} expected {} columns, found {}",
                    spec.name,
                    spec.columns.len(),
                    col_rows.len()
                ),
            ));
        }

        for (col_row, col_spec) in col_rows.iter().zip(spec.columns.iter()) {
            let name: String = col_row.get("column_name");
            let data_type: String = col_row.get("data_type");
            let is_nullable_raw: String = col_row.get("is_nullable");
            if name != col_spec.name {
                return Err(internal_not_committed(
                    "pg_column_name_mismatch",
                    format!(
                        "table {}: expected {}, found {name}",
                        spec.name, col_spec.name
                    ),
                ));
            }
            let type_ok = match col_spec.kind {
                LogicalColKind::Int => data_type == "integer" || data_type == "bigint",
                LogicalColKind::Text => data_type == "text",
                LogicalColKind::Bytes => data_type == "bytea",
            };
            if !type_ok {
                return Err(internal_not_committed(
                    "pg_column_type_mismatch",
                    format!(
                        "table {}.{}: unexpected PG type {data_type}",
                        spec.name, name
                    ),
                ));
            }
            let is_nullable = is_nullable_raw == "YES";
            if is_nullable != col_spec.nullable {
                return Err(internal_not_committed(
                    "pg_column_nullability_mismatch",
                    format!(
                        "table {}.{}: expected nullable={}, found {is_nullable}",
                        spec.name, name, col_spec.nullable
                    ),
                ));
            }
        }

        let pk_cols: Vec<String> = sqlx::query_scalar(
            "SELECT a.attname
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
             WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
             ORDER BY k.ord ASC",
        )
        .bind(schema_name)
        .bind(spec.name)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_table_pk", err.to_string()))?;

        let observed_pk: Vec<&str> = pk_cols.iter().map(String::as_str).collect();
        if observed_pk.as_slice() != spec.primary_key {
            return Err(internal_not_committed(
                "pg_pk_mismatch",
                format!(
                    "table {}: expected PK {:?}, found {observed_pk:?}",
                    spec.name, spec.primary_key
                ),
            ));
        }
    }

    // Verify all explicit non-PK indexes match the semantic manifest (and last_seq is unindexed).
    let idx_rows: Vec<String> = sqlx::query_scalar(
        "SELECT ci.relname
         FROM pg_index i
         JOIN pg_class ct ON ct.oid = i.indrelid
         JOIN pg_class ci ON ci.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = $1 AND NOT i.indisprimary",
    )
    .bind(schema_name)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_catalog_indexes", err.to_string()))?;

    let observed_indexes: BTreeSet<&str> = idx_rows.iter().map(String::as_str).collect();
    let expected_indexes = expected_index_names();
    if observed_indexes != expected_indexes {
        return Err(internal_not_committed(
            "pg_index_mismatch",
            format!("expected {expected_indexes:?}, observed {observed_indexes:?}"),
        ));
    }

    // Verify HOT-friendly fillfactor settings on spaces and note_heads.
    for (relname, expected_opt, err_code) in [
        ("spaces", "fillfactor=70", "pg_spaces_fillfactor_mismatch"),
        (
            "note_heads",
            "fillfactor=80",
            "pg_note_heads_fillfactor_mismatch",
        ),
    ] {
        let reloptions: Option<Vec<String>> = sqlx::query_scalar(
            "SELECT c.reloptions
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2",
        )
        .bind(schema_name)
        .bind(relname)
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_table_reloptions", err.to_string()))?;

        let has_expected = reloptions
            .unwrap_or_default()
            .iter()
            .any(|opt| opt == expected_opt);
        if !has_expected {
            return Err(internal_not_committed(
                err_code,
                format!("{relname} table is missing {expected_opt}"),
            ));
        }
    }

    Ok(())
}
