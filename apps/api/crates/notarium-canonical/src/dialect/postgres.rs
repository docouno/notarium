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

pub async fn open_and_bootstrap_postgres(
    connect: &PgConnectConfig,
    schema: &str,
    installation_id: &InstallationId,
    pool_size: u32,
) -> Result<(PgPool, DatabaseWitness, String), PortError> {
    let validated_schema = validate_pg_schema_name(schema)?.to_owned();
    let options = build_pg_connect_options(connect);

    let mut bootstrap_conn = PgConnection::connect_with(&options)
        .await
        .map_err(|err| internal_not_committed("pg_bootstrap_connect", err.to_string()))?;

    sqlx::query("SET synchronous_commit = on")
        .execute(&mut bootstrap_conn)
        .await
        .map_err(|err| internal_not_committed("pg_set_sync_commit", err.to_string()))?;

    let sync_commit: String = sqlx::query_scalar("SHOW synchronous_commit")
        .fetch_one(&mut bootstrap_conn)
        .await
        .map_err(|err| internal_not_committed("pg_show_sync_commit", err.to_string()))?;
    if !sync_commit.eq_ignore_ascii_case("on") {
        return Err(internal_not_committed(
            "pg_sync_commit_disabled",
            format!("SHOW synchronous_commit={sync_commit}, expected on"),
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

    Ok((pool, witness, validated_schema))
}
