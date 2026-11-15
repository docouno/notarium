//! Private static statements. SQL handles never cross the control owner boundary.
macro_rules! rows {
    ($tx:expr,$row:ty,$method:ident,$sqlite:literal,$postgres:literal; $($value:expr),* $(,)?) => {
        match $tx {
            crate::store::Transaction::Sqlite(tx)=>sqlx::query_as::<_,$row>($sqlite)$(.bind($value))*.$method(&mut **tx).await.map_err(crate::error::database),
            crate::store::Transaction::Postgres(tx)=>sqlx::query_as::<_,$row>($postgres)$(.bind($value))*.$method(&mut **tx).await.map_err(crate::error::database),
        }
    }
}
macro_rules! execute {
    ($tx:expr,$sqlite:literal,$postgres:literal; $($value:expr),* $(,)?) => {
        match $tx {
            crate::store::Transaction::Sqlite(tx)=>sqlx::query($sqlite)$(.bind($value))*.execute(&mut **tx).await.map(|result|result.rows_affected()).map_err(crate::error::database),
            crate::store::Transaction::Postgres(tx)=>sqlx::query($postgres)$(.bind($value))*.execute(&mut **tx).await.map(|result|result.rows_affected()).map_err(crate::error::database),
        }
    }
}
macro_rules! read_rows {
    ($backend:expr,$row:ty,$method:ident,$sqlite:literal,$postgres:literal; $($value:expr),* $(,)?) => {
        match $backend {
            crate::store::Backend::Sqlite{pool,..}=>sqlx::query_as::<_,$row>($sqlite)$(.bind($value))*.$method(pool).await.map_err(crate::error::database),
            crate::store::Backend::Postgres(pool)=>sqlx::query_as::<_,$row>($postgres)$(.bind($value))*.$method(pool).await.map_err(crate::error::database),
        }
    }
}
macro_rules! page_rows {
    ($tx:expr,$row:ty,$table:expr,$limit:expr,$sqlite:literal,$postgres:literal; $($value:expr),* $(,)?) => {
        match $tx {
            crate::store::Transaction::Sqlite(tx)=>crate::store::collect_rows(sqlx::query_as::<_,$row>($sqlite)$(.bind($value))*.fetch(&mut **tx),$limit,$table).await,
            crate::store::Transaction::Postgres(tx)=>crate::store::collect_rows(sqlx::query_as::<_,$row>($postgres)$(.bind($value))*.fetch(&mut **tx),$limit,$table).await,
        }
    }
}
pub(crate) use {execute, page_rows, read_rows, rows};
