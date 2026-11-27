//! Private static statements. SQL handles never cross the control owner boundary.
macro_rules! rows {
    ($tx:expr,$row:ty,$method:ident,$sqlite:expr,$postgres:expr; $($value:expr),* $(,)?) => {{
        const SQLITE: &str = $sqlite;
        const POSTGRES: &str = $postgres;
        match $tx {
            crate::store::Transaction::Sqlite(tx)=>sqlx::query_as::<_,$row>(SQLITE)$(.bind($value))*.$method(&mut **tx).await.map_err(crate::error::database_not_committed),
            crate::store::Transaction::Postgres(tx)=>sqlx::query_as::<_,$row>(POSTGRES)$(.bind($value))*.$method(&mut **tx).await.map_err(crate::error::database_not_committed),
        }
    }}
}
macro_rules! execute {
    ($tx:expr,$sqlite:expr,$postgres:expr; $($value:expr),* $(,)?) => {{
        const SQLITE: &str = $sqlite;
        const POSTGRES: &str = $postgres;
        match $tx {
            crate::store::Transaction::Sqlite(tx)=>sqlx::query(SQLITE)$(.bind($value))*.execute(&mut **tx).await.map(|result|result.rows_affected()).map_err(crate::error::database_not_committed),
            crate::store::Transaction::Postgres(tx)=>sqlx::query(POSTGRES)$(.bind($value))*.execute(&mut **tx).await.map(|result|result.rows_affected()).map_err(crate::error::database_not_committed),
        }
    }}
}
macro_rules! read_rows {
    ($backend:expr,$row:ty,$method:ident,$sqlite:expr,$postgres:expr; $($value:expr),* $(,)?) => {{
        const SQLITE: &str = $sqlite;
        const POSTGRES: &str = $postgres;
        match $backend {
            crate::store::Backend::Sqlite{read_pool,..}=>sqlx::query_as::<_,$row>(SQLITE)$(.bind($value))*.$method(read_pool).await.map_err(crate::error::database_not_committed),
            crate::store::Backend::Postgres{read_pool,..}=>sqlx::query_as::<_,$row>(POSTGRES)$(.bind($value))*.$method(read_pool).await.map_err(crate::error::database_not_committed),
        }
    }}
}
macro_rules! page_rows {
    ($tx:expr,$row:ty,$table:expr,$limit:expr,$sqlite:expr,$postgres:expr; $($value:expr),* $(,)?) => {{
        const SQLITE: &str = $sqlite;
        const POSTGRES: &str = $postgres;
        match $tx {
            crate::store::Transaction::Sqlite(tx)=>crate::store::collect_rows(sqlx::query_as::<_,$row>(SQLITE)$(.bind($value))*.fetch(&mut **tx),$limit,$table).await,
            crate::store::Transaction::Postgres(tx)=>crate::store::collect_rows(sqlx::query_as::<_,$row>(POSTGRES)$(.bind($value))*.fetch(&mut **tx),$limit,$table).await,
        }
    }}
}
pub(crate) use {execute, page_rows, read_rows, rows};
