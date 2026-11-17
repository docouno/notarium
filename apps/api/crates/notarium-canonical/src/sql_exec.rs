use notarium_core::error::PortError;
use sqlx::{PgConnection, SqliteConnection};

use crate::codec::{internal_not_committed, unknown_commit_outcome};

pub enum BackendConn<'a> {
    Sqlite(&'a mut SqliteConnection),
    Postgres(&'a mut PgConnection),
}

#[allow(dead_code)]
impl BackendConn<'_> {
    pub fn is_postgres(&self) -> bool {
        matches!(self, Self::Postgres(_))
    }

    pub async fn begin_write(&mut self) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("BEGIN IMMEDIATE")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_begin_write", err.to_string()))?;
            }
            Self::Postgres(conn) => {
                sqlx::raw_sql("BEGIN")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_begin_write", err.to_string()))?;
            }
        }
        Ok(())
    }

    pub async fn begin_read(&mut self, timeout_ms: Option<u64>) -> Result<(), PortError> {
        self.begin_read_with_pg_local_sql(timeout_ms, None).await
    }

    pub async fn begin_read_with_pg_local_sql(
        &mut self,
        timeout_ms: Option<u64>,
        extra_pg_sql: Option<&'static str>,
    ) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("BEGIN DEFERRED")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_begin_read", err.to_string()))?;
            }
            Self::Postgres(conn) => {
                let mut stmt =
                    String::from("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
                if let Some(ms) = timeout_ms {
                    let ms_clamped = ms.max(1);
                    stmt.push_str(&format!("; SET LOCAL statement_timeout = '{ms_clamped}ms'"));
                }
                if let Some(extra) = extra_pg_sql {
                    stmt.push_str("; ");
                    stmt.push_str(extra);
                }
                sqlx::raw_sql(sqlx::AssertSqlSafe(stmt))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_begin_read", err.to_string()))?;
            }
        }
        Ok(())
    }

    pub async fn commit_write(&mut self) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("COMMIT")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| unknown_commit_outcome("sqlite_commit", err.to_string()))?;
            }
            Self::Postgres(conn) => {
                sqlx::raw_sql("COMMIT")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| unknown_commit_outcome("pg_commit", err.to_string()))?;
            }
        }
        Ok(())
    }

    pub async fn commit_read(&mut self) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("COMMIT")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_commit_read", err.to_string()))?;
            }
            Self::Postgres(conn) => {
                sqlx::raw_sql("COMMIT")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_commit_read", err.to_string()))?;
            }
        }
        Ok(())
    }

    pub async fn rollback_best_effort(&mut self) {
        match self {
            Self::Sqlite(conn) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut **conn).await;
            }
            Self::Postgres(conn) => {
                let _ = sqlx::raw_sql("ROLLBACK").execute(&mut **conn).await;
            }
        }
    }

    pub async fn savepoint(&mut self, _idx: usize) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_savepoint", err.to_string()))?;
            }
            Self::Postgres(conn) => {
                sqlx::query("SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_savepoint", err.to_string()))?;
            }
        }
        Ok(())
    }

    pub async fn release_savepoint(&mut self, _idx: usize) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("RELEASE SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_release_savepoint", err.to_string())
                    })?;
            }
            Self::Postgres(conn) => {
                sqlx::query("RELEASE SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_release_savepoint", err.to_string())
                    })?;
            }
        }
        Ok(())
    }

    pub async fn rollback_to_savepoint(&mut self, _idx: usize) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("ROLLBACK TO SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_rollback_savepoint", err.to_string())
                    })?;
                sqlx::query("RELEASE SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_cleanup_savepoint", err.to_string())
                    })?;
            }
            Self::Postgres(conn) => {
                sqlx::query("ROLLBACK TO SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_rollback_savepoint", err.to_string())
                    })?;
                sqlx::query("RELEASE SAVEPOINT sp_item")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_cleanup_savepoint", err.to_string())
                    })?;
            }
        }
        Ok(())
    }
}
