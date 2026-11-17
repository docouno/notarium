use notarium_core::error::PortError;
use sqlx::{Connection, PgConnection, Postgres, Sqlite, SqliteConnection, Transaction};

use crate::codec::{internal_not_committed, unknown_commit_outcome};

pub enum BackendConn<'a> {
    Sqlite(&'a mut SqliteConnection),
    Postgres(&'a mut PgConnection),
}

/// PostgreSQL may already have opened the transaction when its BEGIN future is dropped.
pub(crate) struct PgTransactionLease<'a> {
    pooled: &'a mut sqlx::pool::PoolConnection<Postgres>,
    completed: bool,
}

impl<'a> PgTransactionLease<'a> {
    pub(crate) fn new(pooled: &'a mut sqlx::pool::PoolConnection<Postgres>) -> Self {
        Self {
            pooled,
            completed: false,
        }
    }

    pub(crate) fn conn(&mut self) -> &mut PgConnection {
        self.pooled
    }

    pub(crate) fn complete(mut self) {
        self.completed = true;
    }
}

impl Drop for PgTransactionLease<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.pooled.close_on_drop();
        }
    }
}

pub(crate) enum WriteTransaction<'c> {
    Sqlite(Transaction<'c, Sqlite>),
    Postgres(Transaction<'c, Postgres>),
}

impl<'c> WriteTransaction<'c> {
    pub(crate) async fn begin(conn: &'c mut BackendConn<'_>) -> Result<Self, PortError> {
        match conn {
            BackendConn::Sqlite(conn) => conn
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map(Self::Sqlite)
                .map_err(|e| internal_not_committed("sqlite_begin_write", e.to_string())),
            BackendConn::Postgres(conn) => conn.begin_with(
                "BEGIN; SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema(), 7311229))"
            ).await.map(Self::Postgres).map_err(|e| internal_not_committed("pg_begin_write", e.to_string())),
        }
    }

    pub(crate) fn conn(&mut self) -> BackendConn<'_> {
        match self {
            Self::Sqlite(tx) => BackendConn::Sqlite(tx),
            Self::Postgres(tx) => BackendConn::Postgres(tx),
        }
    }

    pub(crate) async fn commit(self) -> Result<(), PortError> {
        match self {
            Self::Sqlite(tx) => tx
                .commit()
                .await
                .map_err(|e| unknown_commit_outcome("sqlite_commit", e.to_string())),
            Self::Postgres(tx) => tx
                .commit()
                .await
                .map_err(|e| unknown_commit_outcome("pg_commit", e.to_string())),
        }
    }

    pub(crate) async fn rollback(self) -> bool {
        match self {
            Self::Sqlite(tx) => tx.rollback().await.is_ok(),
            Self::Postgres(tx) => tx.rollback().await.is_ok(),
        }
    }
}

#[allow(dead_code)]
impl BackendConn<'_> {
    pub fn is_postgres(&self) -> bool {
        matches!(self, Self::Postgres(_))
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
