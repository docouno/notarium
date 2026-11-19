use super::{BackupWitness, DecodedPostgresSpoolV1, PostgresSpoolValue, spool_tables};
use crate::{
    codec::internal_not_committed,
    schema::manifest::{CANONICAL_SCHEMA_VERSION, checksum_tables},
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
};
use sqlx::{Acquire, Postgres, QueryBuilder, Transaction};

/// Materialize a validated archive inside the coordinator's unpublished target
/// transaction. Decode one bounded row at a time and keep SQL identifiers tied
/// to the canonical schema registry.
pub async fn import_postgres_spool(
    input: impl std::io::Read + Send + 'static,
    bytes: u64,
    row_limit: u64,
    cancellation: notarium_core::ports::Cancellation,
    target: &mut Transaction<'_, Postgres>,
) -> Result<BackupWitness, PortError> {
    use crate::schema::manifest::TableSpec;
    use tokio::sync::mpsc;
    type Row = (TableSpec, Vec<PostgresSpoolValue>);
    let (sender, mut rows) = mpsc::channel::<Row>(1);
    let parser = tokio::task::spawn_blocking(move || {
        super::scan_postgres_spool_v1(input, bytes, bytes, row_limit, |table, row| {
            if cancellation.is_cancelled() {
                return Err(crate::codec::cancelled_not_committed(
                    "pg_spool_import",
                    "restore cancelled",
                ));
            }
            if matches!(
                table.name,
                "archive_artifacts"
                    | "archive_export_cuts"
                    | "archive_export_shadows"
                    | "archive_uploads"
                    | "archive_import_sources"
                    | "backup_artifacts"
                    | "backup_holds"
                    | "blob_retirements"
                    | "blob_retirement_targets"
                    | "pending_purges"
            ) {
                return Ok(());
            }
            sender.blocking_send((table, row.to_vec())).map_err(|_| {
                crate::codec::cancelled_not_committed("pg_spool_import", "restore receiver closed")
            })
        })
    });
    let insert_rows = async {
        let mut current: Option<TableSpec> = None;
        let mut columns = String::new();
        let mut statement = String::new();
        while let Some((table, row)) = rows.recv().await {
            if current.is_none_or(|previous| previous.name != table.name) {
                if let Some(previous) = current {
                    finish_staged_table(target, previous.name, &columns).await?;
                }
                current = Some(table);
                columns = table
                    .columns
                    .iter()
                    .map(|col| col.name)
                    .collect::<Vec<_>>()
                    .join(", ");
                let dest = if self_referencing(table.name) {
                    let create = format!(
                        "CREATE TEMP TABLE notarium_restore_rows ON COMMIT DROP AS SELECT {columns}
                         FROM {} WITH NO DATA",
                        table.name,
                    );
                    sqlx::raw_sql(sqlx::AssertSqlSafe(create))
                        .execute(&mut **target)
                        .await
                        .map_err(import_error)?;
                    "pg_temp.notarium_restore_rows"
                } else {
                    table.name
                };
                statement = format!("INSERT INTO {dest} ({columns}) ");
            }
            insert_row(target, &statement, row).await?;
        }
        if let Some(table) = current {
            finish_staged_table(target, table.name, &columns).await?;
        }
        Ok::<_, PortError>(())
    }
    .await;
    drop(rows);
    let validated = parser
        .await
        .map_err(|err| internal_not_committed("pg_restore_spool_worker", err.to_string()))?;
    insert_rows?;
    validated
}

fn self_referencing(table: &str) -> bool {
    matches!(table, "folder_heads" | "chat_entries")
}

async fn finish_staged_table(
    tx: &mut Transaction<'_, Postgres>,
    table: &str,
    columns: &str,
) -> Result<(), PortError> {
    if self_referencing(table) {
        let apply = format!(
            "INSERT INTO {table} ({columns}) SELECT {columns} FROM pg_temp.notarium_restore_rows;
             DROP TABLE pg_temp.notarium_restore_rows"
        );
        sqlx::raw_sql(sqlx::AssertSqlSafe(apply))
            .execute(&mut **tx)
            .await
            .map_err(import_error)?;
    }
    Ok(())
}

async fn insert_row(
    target: &mut Transaction<'_, Postgres>,
    statement: &str,
    row: Vec<PostgresSpoolValue>,
) -> Result<(), PortError> {
    let mut query = QueryBuilder::<Postgres>::new(statement.to_owned());
    query.push_values([row], |mut args, row| {
        for value in row {
            match value {
                PostgresSpoolValue::Null => {
                    args.push("NULL");
                }
                PostgresSpoolValue::Int(v) => {
                    args.push_bind(v);
                }
                PostgresSpoolValue::Text(v) => {
                    args.push_bind(v);
                }
                PostgresSpoolValue::Bytes(v) => {
                    args.push_bind(v);
                }
            }
        }
    });
    query
        .build()
        .execute(&mut **target)
        .await
        .map_err(import_error)?;
    Ok(())
}

impl DecodedPostgresSpoolV1 {
    /// Import a verified spool into the transaction's empty, version-matched schema.
    /// A failed constraint rolls the import back to its savepoint.
    pub async fn import_rows(
        self,
        target: &mut Transaction<'_, Postgres>,
    ) -> Result<BackupWitness, PortError> {
        let specs = spool_tables(self.schema_version);
        if !(1..=CANONICAL_SCHEMA_VERSION).contains(&self.schema_version)
            || self.witness.schema_version != self.schema_version
            || self.manifest_checksum != checksum_tables(self.schema_version, specs.clone())
            || specs.clone().count() != self.tables.len()
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let mut batch = target.begin().await.map_err(import_error)?;
        for (spec, table) in specs.zip(self.tables) {
            if table.name != spec.name
                || !spec
                    .columns
                    .iter()
                    .map(|c| c.name)
                    .eq(table.columns.iter().map(String::as_str))
            {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            let columns = table.columns.join(", ");
            let staged = matches!(spec.name, "folder_heads" | "chat_entries");
            let dest = if staged {
                // Immediate self-FKs check the whole final INSERT statement. Stage
                // the rows so ordering and PostgreSQL's bind limit do not matter.
                let create = format!(
                    "CREATE TEMP TABLE notarium_restore_rows ON COMMIT DROP AS SELECT {columns} FROM {} WITH NO DATA",
                    spec.name
                );
                sqlx::raw_sql(sqlx::AssertSqlSafe(create))
                    .execute(&mut *batch)
                    .await
                    .map_err(import_error)?;
                "pg_temp.notarium_restore_rows"
            } else {
                spec.name
            };
            let insert = format!("INSERT INTO {dest} ({columns}) ");
            for row in table.rows {
                if row.len() != spec.columns.len() {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                let mut query = QueryBuilder::<Postgres>::new(insert.clone());
                query.push_values([row], |mut args, row| {
                    for value in row {
                        match value {
                            PostgresSpoolValue::Null => {
                                args.push("NULL");
                            }
                            PostgresSpoolValue::Int(v) => {
                                args.push_bind(v);
                            }
                            PostgresSpoolValue::Text(v) => {
                                args.push_bind(v);
                            }
                            PostgresSpoolValue::Bytes(v) => {
                                args.push_bind(v);
                            }
                        }
                    }
                });
                query
                    .build()
                    .execute(&mut *batch)
                    .await
                    .map_err(import_error)?;
            }
            if staged {
                let apply = format!(
                    "INSERT INTO {} ({columns}) SELECT {columns} FROM pg_temp.notarium_restore_rows; DROP TABLE pg_temp.notarium_restore_rows",
                    spec.name
                );
                sqlx::raw_sql(sqlx::AssertSqlSafe(apply))
                    .execute(&mut *batch)
                    .await
                    .map_err(import_error)?;
            }
        }
        batch.commit().await.map_err(import_error)?;
        Ok(self.witness)
    }
}

fn import_error(error: sqlx::Error) -> PortError {
    internal_not_committed("pg_import_spool_rows", error.to_string())
}
