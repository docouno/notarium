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
