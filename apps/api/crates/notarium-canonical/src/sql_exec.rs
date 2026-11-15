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
                sqlx::query("BEGIN")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_begin_write", err.to_string()))?;
            }
        }
        Ok(())
    }

    pub async fn begin_read(&mut self, timeout_ms: Option<u64>) -> Result<(), PortError> {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query("BEGIN DEFERRED")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_begin_read", err.to_string()))?;
            }
            Self::Postgres(conn) => {
                sqlx::query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_begin_read", err.to_string()))?;
                if let Some(ms) = timeout_ms {
                    let ms_clamped = ms.max(1);
                    let stmt = format!("SET LOCAL statement_timeout = '{ms_clamped}ms'");
                    sqlx::query(sqlx::AssertSqlSafe(stmt))
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_set_statement_timeout", err.to_string())
                        })?;
                }
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
                sqlx::query("COMMIT")
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
                sqlx::query("COMMIT")
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
                let _ = sqlx::query("ROLLBACK").execute(&mut **conn).await;
            }
        }
    }

    pub async fn savepoint(&mut self, idx: usize) -> Result<(), PortError> {
        let stmt = format!("SAVEPOINT sp_item_{idx}");
        match self {
            Self::Sqlite(conn) => {
                sqlx::query(sqlx::AssertSqlSafe(stmt))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_savepoint", err.to_string()))?;
            }
            Self::Postgres(conn) => {
                sqlx::query(sqlx::AssertSqlSafe(stmt))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_savepoint", err.to_string()))?;
            }
        }
        Ok(())
    }

    pub async fn release_savepoint(&mut self, idx: usize) -> Result<(), PortError> {
        let stmt = format!("RELEASE SAVEPOINT sp_item_{idx}");
        match self {
            Self::Sqlite(conn) => {
                sqlx::query(sqlx::AssertSqlSafe(stmt))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_release_savepoint", err.to_string())
                    })?;
            }
            Self::Postgres(conn) => {
                sqlx::query(sqlx::AssertSqlSafe(stmt))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_release_savepoint", err.to_string())
                    })?;
            }
        }
        Ok(())
    }

    pub async fn rollback_to_savepoint(&mut self, idx: usize) -> Result<(), PortError> {
        let rb = format!("ROLLBACK TO SAVEPOINT sp_item_{idx}");
        let rel = format!("RELEASE SAVEPOINT sp_item_{idx}");
        match self {
            Self::Sqlite(conn) => {
                sqlx::query(sqlx::AssertSqlSafe(rb))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_rollback_savepoint", err.to_string())
                    })?;
                sqlx::query(sqlx::AssertSqlSafe(rel))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_cleanup_savepoint", err.to_string())
                    })?;
            }
            Self::Postgres(conn) => {
                sqlx::query(sqlx::AssertSqlSafe(rb))
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_rollback_savepoint", err.to_string())
                    })?;
                sqlx::query(sqlx::AssertSqlSafe(rel))
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
