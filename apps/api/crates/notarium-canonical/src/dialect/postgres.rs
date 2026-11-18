use std::sync::Arc;

use notarium_core::{epoch::DatabaseWitness, error::PortError, ids::InstallationId};
use sqlx::{
    Connection, PgConnection, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};

use crate::{
    codec::internal_not_committed,
    config::{PgConnectConfig, PgTransport, validate_pg_schema_name},
    schema::bootstrap_postgres_schema,
};

pub fn build_pg_connect_options(cfg: &PgConnectConfig) -> PgConnectOptions {
    let base = match &cfg.transport {
        PgTransport::UnixSocket { socket_dir, port } => PgConnectOptions::new_without_pgpass()
            .socket(socket_dir)
            .port(*port)
            .ssl_mode(PgSslMode::Disable),
        PgTransport::Tcp {
            host,
            port,
            root_cert,
        } => {
            let options = PgConnectOptions::new_without_pgpass()
                .host(host)
                .port(*port)
                .ssl_mode(PgSslMode::VerifyFull);
            match root_cert {
                Some(cert) => options.ssl_root_cert(cert),
                None => options,
            }
        }
    };
    base.username(&cfg.username)
        .password(&cfg.password)
        .database(&cfg.database)
}

/// SQLx binds a new socket to the runtime polling pool checkout. A store may be
/// called from short-lived runtimes and keep the connection for later requests.
pub(crate) struct StorePgPool {
    pool: PgPool,
    executor: tokio::runtime::Handle,
}

impl StorePgPool {
    pub(crate) fn acquire_timeout(&self) -> std::time::Duration {
        self.pool.options().get_acquire_timeout()
    }

    pub(crate) async fn acquire(&self) -> Result<StorePgConnection, sqlx::Error> {
        if tokio::runtime::Handle::current().id() == self.executor.id() {
            return Ok(StorePgConnection {
                connection: Some(self.pool.acquire().await?),
                executor: self.executor.clone(),
            });
        }
        // Keep the cross-runtime task out of the ordinary checkout future. The
        // latter is embedded in shared SQLite/PostgreSQL operations.
        let pool = self.pool.clone();
        let executor = self.executor.clone();
        Box::pin(on_store_executor(&self.executor, async move {
            Ok(StorePgConnection {
                connection: Some(pool.acquire().await?),
                executor,
            })
        }))
        .await
    }

    pub(crate) async fn close(&self) {
        self.pool.close().await;
    }
}

pub(crate) async fn on_store_executor<T: Send + 'static>(
    executor: &tokio::runtime::Handle,
    operation: impl Future<Output = Result<T, sqlx::Error>> + Send + 'static,
) -> Result<T, sqlx::Error> {
    if tokio::runtime::Handle::current().id() == executor.id() {
        return operation.await;
    }

    // Dropping the caller aborts any checkout still queued on the store.
    let mut task = tokio::task::JoinSet::new();
    task.spawn_on(operation, executor);
    task.join_next()
        .await
        .expect("one PostgreSQL checkout task")
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e)))?
}

pub(crate) struct StorePgConnection {
    connection: Option<sqlx::pool::PoolConnection<sqlx::Postgres>>,
    executor: tokio::runtime::Handle,
}

impl StorePgConnection {
    pub(crate) fn close_on_drop(&mut self) {
        self.connection
            .as_mut()
            .expect("checked out connection")
            .close_on_drop();
    }
}

impl std::ops::Deref for StorePgConnection {
    type Target = PgConnection;

    fn deref(&self) -> &Self::Target {
        self.connection.as_ref().expect("checked out connection")
    }
}

impl std::ops::DerefMut for StorePgConnection {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.connection.as_mut().expect("checked out connection")
    }
}

impl Drop for StorePgConnection {
    fn drop(&mut self) {
        // PoolConnection::drop schedules return or close on the current executor.
        let _owner = self.executor.enter();
        drop(self.connection.take());
    }
}

pub(crate) async fn open_and_bootstrap_postgres(
    connect: &PgConnectConfig,
    schema: &str,
    installation_id: &InstallationId,
    pool_size: u32,
) -> Result<(StorePgPool, DatabaseWitness, String), PortError> {
    let validated_schema = validate_pg_schema_name(schema)?.to_owned();
    let options = build_pg_connect_options(connect);

    let mut bootstrap_conn = PgConnection::connect_with(&options)
        .await
        .map_err(|err| internal_not_committed("pg_bootstrap_connect", err.to_string()))?;

    sqlx::query("SET synchronous_commit = on")
        .execute(&mut bootstrap_conn)
        .await
        .map_err(|err| internal_not_committed("pg_set_sync_commit", err.to_string()))?;

    let (sync_commit, fsync): (String, String) =
        sqlx::query_as("SELECT current_setting('synchronous_commit'), current_setting('fsync')")
            .fetch_one(&mut bootstrap_conn)
            .await
            .map_err(|err| {
                internal_not_committed("pg_read_durability_settings", err.to_string())
            })?;
    if !sync_commit.eq_ignore_ascii_case("on") {
        return Err(internal_not_committed(
            "pg_sync_commit_disabled",
            format!("SHOW synchronous_commit={sync_commit}, expected on"),
        ));
    }

    if !fsync.eq_ignore_ascii_case("on") {
        return Err(internal_not_committed(
            "pg_fsync_disabled",
            format!("PostgreSQL fsync={fsync}, expected on"),
        ));
    }

    let witness =
        bootstrap_postgres_schema(&mut bootstrap_conn, &validated_schema, installation_id).await?;

    let _ = bootstrap_conn.close().await;

    let init_session_sql = Arc::new(format!(
        "SET search_path TO \"{validated_schema}\"; \
         SET synchronous_commit = on; \
         SET timezone = 'UTC'; \
         SET plan_cache_mode = force_generic_plan; \
         SET seq_page_cost = 0.2; \
         SET random_page_cost = 0.2;"
    ));
    let pool = PgPoolOptions::new()
        .max_connections(pool_size.max(1))
        .test_before_acquire(false)
        .after_connect(move |conn, _meta| {
            let init_session_sql = Arc::clone(&init_session_sql);
            Box::pin(async move {
                sqlx::raw_sql(sqlx::AssertSqlSafe(init_session_sql.as_str()))
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(|err| internal_not_committed("pg_pool_connect", err.to_string()))?;

    let pool = StorePgPool {
        pool,
        executor: tokio::runtime::Handle::current(),
    };
    Ok((pool, witness, validated_schema))
}
