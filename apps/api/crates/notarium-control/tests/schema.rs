use notarium_control::store::{ControlStore, PostgresConfig, TargetRecord, TargetTable};
use notarium_core::epoch::DataRoot;
use notarium_core::{ids::*, ports::*};
use sqlx::{Connection, Row};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn maintenance(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: CallBudget {
            request: RequestId::from_bytes([1; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(10),
        },
    }
}
fn user(number: u8, username: &str) -> TargetRecord {
    TargetRecord::Users {
        user_id: PrincipalId::from_bytes([number; 16]).to_string(),
        username: username.into(),
        email: None,
        display_name: username.into(),
        password_hash: None,
        is_admin: 0,
        disabled_at: None,
        personal_space_id: None,
        revision: 0,
        metadata_revision: 0,
        auth_version: 0,
        created_at: 0,
    }
}

fn scratch() -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .expect("run tests through the pinned development environment");
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = PathBuf::from(target).join(format!(
        "control-tests/schema-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(path.join("v1")).unwrap();
    path
}

#[tokio::test]
async fn both_dialects_have_the_same_schema_and_constraints() {
    let root = scratch();
    let sqlite = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
    assert!(sqlite.installation().await.unwrap().is_none());
    sqlite.close().await;
    // Repeated migrations must preserve existing state.
    ControlStore::sqlite(&DataRoot::new(&root))
        .await
        .unwrap()
        .close()
        .await;
    let mut local = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        root.join("v1/control.sqlite").display()
    ))
    .await
    .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut local)
        .await
        .unwrap();
    let local_names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")
        .fetch_all(&mut local).await.unwrap();

    let descriptor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/control-db-fixture/active.json");
    let descriptor: serde_json::Value = serde_json::from_slice(
        &std::fs::read(descriptor).expect("PostgreSQL fixture is required; run make test"),
    )
    .unwrap();
    let socket = PathBuf::from(descriptor["socket"].as_str().unwrap());
    let options = sqlx::postgres::PgConnectOptions::new()
        .socket(&socket)
        .username("postgres")
        .database("postgres");
    let mut cloud = sqlx::PgConnection::connect_with(&options).await.unwrap();
    let version: String = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(&mut cloud)
        .await
        .unwrap();
    assert!(version.starts_with("16"));
    let store = ControlStore::postgres(PostgresConfig::unix_socket(
        socket.clone(),
        "postgres",
        "postgres",
    ))
    .await
    .unwrap();
    assert!(store.installation().await.unwrap().is_none());
    store.close().await;
    ControlStore::postgres(PostgresConfig::unix_socket(
        socket.clone(),
        "postgres",
        "postgres",
    ))
    .await
    .unwrap()
    .close()
    .await;
    let cloud_names: Vec<String> = sqlx::query_scalar("SELECT table_name FROM information_schema.tables WHERE table_schema='v1_control' AND table_name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY table_name")
        .fetch_all(&mut cloud).await.unwrap();
    assert_eq!(local_names, cloud_names);
    let mut target_tables: Vec<_> = TargetTable::ALL.iter().map(|table| table.name()).collect();
    target_tables.sort_unstable();
    assert_eq!(
        local_names, target_tables,
        "every table has a target row contract"
    );
    for table in &local_names {
        let local_cols: Vec<(String, bool)> = sqlx::query(
            "SELECT name, (\"notnull\" <> 0 OR pk <> 0) AS required FROM pragma_table_info($1) ORDER BY name",
        )
        .bind(table)
        .fetch_all(&mut local)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.get::<String, _>(0), row.get::<bool, _>(1)))
        .collect();
        let cloud_cols: Vec<(String, bool)> = sqlx::query(
            "SELECT column_name, (is_nullable = 'NO') AS required FROM information_schema.columns WHERE table_schema='v1_control' AND table_name=$1 ORDER BY column_name",
        )
        .bind(table)
        .fetch_all(&mut cloud)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.get::<String, _>(0), row.get::<bool, _>(1)))
        .collect();
        assert_eq!(
            local_cols, cloud_cols,
            "column nullability mismatch on {table}"
        );
    }
    let non_c_text_cols: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='v1_control' AND table_name NOT LIKE '\\_%' ESCAPE '\\' AND data_type='text' AND coalesce(collation_name, '') <> 'C'",
    )
    .fetch_one(&mut cloud)
    .await
    .unwrap();
    assert_eq!(
        non_c_text_cols, 0,
        "all PostgreSQL TEXT columns must use COLLATE \"C\""
    );

    for (sql, valid) in [
        (
            "INSERT INTO users(user_id,username,display_name,created_at) VALUES ('principal_A','Example','Example',0)",
            true,
        ),
        (
            "INSERT INTO users(user_id,username,display_name,created_at) VALUES ('principal_B','Example','Duplicate',0)",
            false,
        ),
        (
            "INSERT INTO space_admission(space_id,state) VALUES ('space','active')",
            true,
        ),
        (
            "INSERT INTO space_members(space_id,user_id,role,admission,created_at) VALUES ('space','principal_A','owner','active',0)",
            true,
        ),
        (
            "INSERT INTO space_members(space_id,user_id,role,admission,created_at) VALUES ('space','missing','viewer','active',0)",
            false,
        ),
        ("UPDATE space_members SET role='admin'", false),
        ("UPDATE users SET auth_version=-1", false),
        ("UPDATE users SET auth_version='not-a-number'", false),
        (
            "INSERT INTO users(user_id,username,display_name,created_at) VALUES (NULL,'null-key','Null',0)",
            false,
        ),
        (
            "INSERT INTO agent_telemetry_config(singleton,version,updated_at) VALUES(1,0,0)",
            true,
        ),
        (
            "UPDATE agent_telemetry_config SET detailed_retention_days=91",
            false,
        ),
        (
            "INSERT INTO provider_budget_buckets VALUES('space','space',0,60000,1,10,0)",
            true,
        ),
        ("UPDATE provider_budget_buckets SET tpm_reserved=-1", false),
    ] {
        assert_eq!(
            sqlx::query(sql).execute(&mut local).await.is_ok(),
            valid,
            "SQLite: {sql}"
        );
        sqlx::query("SET search_path TO v1_control,pg_catalog")
            .execute(&mut cloud)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query(sql).execute(&mut cloud).await.is_ok(),
            valid,
            "PostgreSQL: {sql}"
        );
    }
    let names = sqlx::query("SELECT username FROM v1_control.users")
        .fetch_one(&mut cloud)
        .await
        .unwrap();
    assert_eq!(names.get::<String, _>(0), "Example");

    let local_store = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
    let cloud_store =
        ControlStore::postgres(PostgresConfig::unix_socket(socket, "postgres", "postgres"))
            .await
            .unwrap();
    let epoch = TargetRecord::V1StorageEpoch {
        singleton: 1,
        epoch_version: 1,
        state: "migrating".into(),
        installation_id: InstallationId::from_bytes([3; 16]).to_string(),
        receipt_sha256: None,
        receipt_json: None,
    };
    for store in [&local_store, &cloud_store] {
        assert!(
            store
                .import_target_batch(
                    maintenance(ServicePurpose::Backup),
                    std::slice::from_ref(&epoch)
                )
                .await
                .is_err()
        );
        store
            .import_target_batch(
                maintenance(ServicePurpose::Restore),
                std::slice::from_ref(&epoch),
            )
            .await
            .unwrap();
        // The second row violates a uniqueness constraint; the first must roll back.
        assert!(
            store
                .import_target_batch(
                    maintenance(ServicePurpose::Restore),
                    &[user(4, "Importer"), user(5, "Example")]
                )
                .await
                .is_err()
        );
        store
            .import_target_batch(maintenance(ServicePurpose::Restore), &[user(4, "Importer")])
            .await
            .unwrap();
    }
    sqlx::query("UPDATE v1_storage_epoch SET state='ready'")
        .execute(&mut local)
        .await
        .unwrap();
    sqlx::query("UPDATE v1_control.v1_storage_epoch SET state='ready'")
        .execute(&mut cloud)
        .await
        .unwrap();
    for (store, retention) in [
        (
            &local_store,
            BackupRetentionBudget::SqliteWal {
                max_pinned_bytes: 16 * 1024 * 1024,
            },
        ),
        (
            &cloud_store,
            BackupRetentionBudget::PostgresSnapshot {
                max_age: Duration::from_secs(5),
            },
        ),
    ] {
        assert!(
            store
                .import_target_batch(
                    maintenance(ServicePurpose::Restore),
                    &[user(6, "Forbidden")]
                )
                .await
                .is_err()
        );
        let context = maintenance(ServicePurpose::Backup);
        let cancel = context.budget.cancellation.clone();
        let mut export = store
            .export_target(
                context,
                BackupBudget {
                    deadline: Duration::from_secs(5),
                    max_spool_bytes: 8 * 1024 * 1024,
                    retention,
                },
            )
            .await
            .unwrap();
        sqlx::query("UPDATE users SET display_name='Changed after pin' WHERE username='Importer'")
            .execute(&mut local)
            .await
            .unwrap();
        sqlx::query("UPDATE v1_control.users SET display_name='Changed after pin' WHERE username='Importer'").execute(&mut cloud).await.unwrap();
        let first = export.page(TargetTable::Users, None, 1).await.unwrap();
        assert_eq!(first.records.len(), 1);
        let second = export
            .page(TargetTable::Users, first.continuation, 1)
            .await
            .unwrap();
        assert_eq!(second.records.len(), 1);
        assert!(second.continuation.is_none());
        let mut saw_importer = false;
        for row in first.records.into_iter().chain(second.records) {
            let TargetRecord::Users {
                username,
                display_name,
                ..
            } = row
            else {
                panic!("wrong target table")
            };
            if username == "Importer" {
                assert_eq!(display_name, "Importer");
                saw_importer = true;
            }
        }
        assert!(saw_importer);
        cancel.cancel();
        assert!(export.page(TargetTable::Users, None, 1).await.is_err());
        export.close().await.unwrap();
        sqlx::query("UPDATE users SET display_name='Importer' WHERE username='Importer'")
            .execute(&mut local)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE v1_control.users SET display_name='Importer' WHERE username='Importer'",
        )
        .execute(&mut cloud)
        .await
        .unwrap();
    }
    local_store.close().await;
    cloud_store.close().await;
    local.close().await.unwrap();
    cloud.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn upgrade_from_0001_to_0002_preserves_populated_rows_both_dialects() {
    let root = scratch();
    let sqlite_db = root.join("v1/control.sqlite");
    let sqlite_mig_dir = root.join("mig-sqlite-0001");
    let pg_mig_dir = root.join("mig-pg-0001");
    std::fs::create_dir_all(&sqlite_mig_dir).unwrap();
    std::fs::create_dir_all(&pg_mig_dir).unwrap();
    std::fs::write(
        sqlite_mig_dir.join("0001_control.sql"),
        include_str!("../migrations/sqlite/0001_control.sql"),
    )
    .unwrap();
    std::fs::write(
        pg_mig_dir.join("0001_control.sql"),
        include_str!("../migrations/postgres/0001_control.sql"),
    )
    .unwrap();

    let hash32 = [0xAB_u8; 32];
    let claim_hash = [0xCD_u8; 32];
    let user_id = PrincipalId::from_bytes([11; 16]).to_string();
    let space_id = SpaceId::from_bytes([12; 16]).to_string();
    let grant_id = OAuthGrantId::from_bytes([13; 16]).to_string();
    let schedule_id = ScheduleId::from_bytes([14; 16]).to_string();
    let run_id = AgentRunId::from_bytes([15; 16]).to_string();

    // 1. SQLite: bootstrap 0001-only schema, populate all 5 tables touched by 0002, then open ControlStore::sqlite.
    {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&sqlite_db)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = sqlx::SqlitePool::connect_with(opts).await.unwrap();
        let mig = sqlx::migrate::Migrator::new(sqlite_mig_dir.as_path())
            .await
            .unwrap();
        mig.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO users(user_id,username,display_name,created_at) VALUES($1,'mig_owner','Mig Owner',100)",
        )
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pats(token_id,secret_hash,user_id,name,scope,created_at) VALUES('pat000000001',$1,$2,'legacy-pat','write',100)",
        )
        .bind(hash32.as_slice())
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO oauth_clients(client_id,kind,redirect_uris,client_name,created_at) VALUES('legacy-client','dcr','[\"http://127.0.0.1/cb\"]','Legacy',100)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO oauth_grants(grant_id,user_id,client_id,resource_uri,scope,created_at) VALUES($1,$2,'legacy-client','https://res.example/','read',100)",
        )
        .bind(&grant_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO oauth_access_tokens(token_id,token_hash,grant_id,resource_uri,scope,issued_at,expires_at) VALUES('tok000000001',$1,$2,'https://res.example/','read',100,900)",
        )
        .bind(hash32.as_slice())
        .bind(&grant_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_schedules(schedule_id,owner_id,space_id,project_folder_id,title,init_prompt,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,config_revision,revision,created_at,updated_at) \
             VALUES($1,$2,$3,NULL,'Legacy Keeper','Run checks','0 9 * * *','UTC','{}',NULL,1,'{}','coalesce_latest',2000,NULL,1,2,100,100)",
        )
        .bind(&schedule_id)
        .bind(&user_id)
        .bind(&space_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at) \
             VALUES($1,$2,2000,1,$3,2,3000,'running',2000,NULL,NULL,0,1,0,'{}',4000)",
        )
        .bind(&run_id)
        .bind(&schedule_id)
        .bind(claim_hash.as_slice())
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
    }
    let upgraded_sqlite = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
    upgraded_sqlite.close().await;
    {
        let mut conn = sqlx::SqliteConnection::connect(&format!("sqlite:{}", sqlite_db.display()))
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&mut conn)
            .await
            .unwrap();
        let fk_violations: Vec<(String,)> =
            sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        assert!(
            fk_violations.is_empty(),
            "SQLite FK violations after 0002: {fk_violations:?}"
        );
        let pat_aw: i64 =
            sqlx::query_scalar("SELECT ability_write FROM pats WHERE token_id='pat000000001'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let grant_aw: i64 =
            sqlx::query_scalar("SELECT ability_write FROM oauth_grants WHERE grant_id=$1")
                .bind(&grant_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let tok_aw: i64 = sqlx::query_scalar(
            "SELECT ability_write FROM oauth_access_tokens WHERE token_id='tok000000001'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!((pat_aw, grant_aw, tok_aw), (0, 0, 0));
        let (title, skills, next_slot): (String, String, Option<i64>) = sqlx::query_as(
            "SELECT title, approved_skills, next_slot_utc_ms FROM agent_schedules WHERE schedule_id=$1",
        )
        .bind(&schedule_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(title, "Legacy Keeper");
        assert_eq!(skills, "[]");
        assert_eq!(next_slot, Some(2000));
        let (run_skills, keeper_log, keeper_proj): (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT approved_skills, keeper_log_id, keeper_project_folder_id FROM agent_schedule_runs WHERE run_id=$1",
        )
        .bind(&run_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(run_skills, "[]");
        assert!(keeper_log.is_none() && keeper_proj.is_none());
        // Verify schedule_due partial index and nullable terminal next_slot_utc_ms work after 0002.
        sqlx::query("UPDATE agent_schedules SET next_slot_utc_ms=NULL WHERE schedule_id=$1")
            .bind(&schedule_id)
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
    }

    // 2. PostgreSQL: create isolated database, run 0001-only, populate all 5 tables, then open ControlStore::postgres.
    let descriptor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/control-db-fixture/active.json");
    let descriptor: serde_json::Value = serde_json::from_slice(
        &std::fs::read(descriptor).expect("PostgreSQL fixture is required; run make test"),
    )
    .unwrap();
    let socket = PathBuf::from(descriptor["socket"].as_str().unwrap());
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let db_name = format!(
        "control_mig_{}_{}",
        std::process::id(),
        unique % 1_000_000_000
    );
    let admin_opts = sqlx::postgres::PgConnectOptions::new()
        .socket(&socket)
        .username("postgres")
        .database("postgres");
    let mut admin = sqlx::PgConnection::connect_with(&admin_opts).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {db_name}")))
        .execute(&mut admin)
        .await
        .unwrap();
    {
        let db_opts = sqlx::postgres::PgConnectOptions::new()
            .socket(&socket)
            .username("postgres")
            .database(&db_name);
        let pool = sqlx::PgPool::connect_with(db_opts).await.unwrap();
        sqlx::query("CREATE SCHEMA IF NOT EXISTS v1_control")
            .execute(&pool)
            .await
            .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("SET search_path TO v1_control, pg_catalog")
            .execute(&mut *conn)
            .await
            .unwrap();
        let mig = sqlx::migrate::Migrator::new(pg_mig_dir.as_path())
            .await
            .unwrap();
        mig.run(&mut *conn).await.unwrap();
        sqlx::query(
            "INSERT INTO v1_control.users(user_id,username,display_name,created_at) VALUES($1,'mig_owner','Mig Owner',100)",
        )
        .bind(&user_id)
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO v1_control.pats(token_id,secret_hash,user_id,name,scope,created_at) VALUES('pat000000001',$1,$2,'legacy-pat','write',100)",
        )
        .bind(hash32.as_slice())
        .bind(&user_id)
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO v1_control.oauth_clients(client_id,kind,redirect_uris,client_name,created_at) VALUES('legacy-client','dcr','[\"http://127.0.0.1/cb\"]','Legacy',100)",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO v1_control.oauth_grants(grant_id,user_id,client_id,resource_uri,scope,created_at) VALUES($1,$2,'legacy-client','https://res.example/','read',100)",
        )
        .bind(&grant_id)
        .bind(&user_id)
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO v1_control.oauth_access_tokens(token_id,token_hash,grant_id,resource_uri,scope,issued_at,expires_at) VALUES('tok000000001',$1,$2,'https://res.example/','read',100,900)",
        )
        .bind(hash32.as_slice())
        .bind(&grant_id)
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO v1_control.agent_schedules(schedule_id,owner_id,space_id,project_folder_id,title,init_prompt,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,config_revision,revision,created_at,updated_at) \
             VALUES($1,$2,$3,NULL,'Legacy Keeper','Run checks','0 9 * * *','UTC','{}',NULL,1,'{}','coalesce_latest',2000,NULL,1,2,100,100)",
        )
        .bind(&schedule_id)
        .bind(&user_id)
        .bind(&space_id)
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO v1_control.agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at) \
             VALUES($1,$2,2000,1,$3,2,3000,'running',2000,NULL,NULL,0,1,0,'{}',4000)",
        )
        .bind(&run_id)
        .bind(&schedule_id)
        .bind(claim_hash.as_slice())
        .execute(&mut *conn)
        .await
        .unwrap();
        drop(conn);
        pool.close().await;
    }
    let upgraded_pg = ControlStore::postgres(PostgresConfig::unix_socket(
        socket.clone(),
        &db_name,
        "postgres",
    ))
    .await
    .unwrap();
    upgraded_pg.close().await;
    {
        let db_opts = sqlx::postgres::PgConnectOptions::new()
            .socket(&socket)
            .username("postgres")
            .database(&db_name);
        let mut conn = sqlx::PgConnection::connect_with(&db_opts).await.unwrap();
        let pat_aw: i64 = sqlx::query_scalar(
            "SELECT ability_write FROM v1_control.pats WHERE token_id='pat000000001'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let grant_aw: i64 = sqlx::query_scalar(
            "SELECT ability_write FROM v1_control.oauth_grants WHERE grant_id=$1",
        )
        .bind(&grant_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let tok_aw: i64 = sqlx::query_scalar(
            "SELECT ability_write FROM v1_control.oauth_access_tokens WHERE token_id='tok000000001'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!((pat_aw, grant_aw, tok_aw), (0, 0, 0));
        let (title, skills, next_slot): (String, String, Option<i64>) = sqlx::query_as(
            "SELECT title, approved_skills, next_slot_utc_ms FROM v1_control.agent_schedules WHERE schedule_id=$1",
        )
        .bind(&schedule_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(title, "Legacy Keeper");
        assert_eq!(skills, "[]");
        assert_eq!(next_slot, Some(2000));
        let (run_skills, keeper_log, keeper_proj): (String, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT approved_skills, keeper_log_id, keeper_project_folder_id FROM v1_control.agent_schedule_runs WHERE run_id=$1",
            )
            .bind(&run_id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(run_skills, "[]");
        assert!(keeper_log.is_none() && keeper_proj.is_none());
        let due_idx: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pg_indexes WHERE schemaname='v1_control' AND tablename='agent_schedules' AND indexname='schedule_due'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(due_idx, 1);
        sqlx::query(
            "UPDATE v1_control.agent_schedules SET next_slot_utc_ms=NULL WHERE schedule_id=$1",
        )
        .bind(&schedule_id)
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
    }
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP DATABASE {db_name}")))
        .execute(&mut admin)
        .await
        .unwrap();
    admin.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn sqlite_hot_control_queries_use_covering_indexes_before_and_after_analyze() {
    let root = scratch();
    let sqlite = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
    sqlite.close().await;
    let mut conn = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        root.join("v1/control.sqlite").display()
    ))
    .await
    .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut conn)
        .await
        .unwrap();

    // Seed multi-tenant rows so SQLite's post-ANALYZE planner has real statistics.
    for u in 0..8u8 {
        let uid = PrincipalId::from_bytes([0x10 + u; 16]).to_string();
        sqlx::query(
            "INSERT INTO users(user_id,username,display_name,created_at) VALUES (?1,?2,?2,1)",
        )
        .bind(&uid)
        .bind(format!("user-{u}"))
        .execute(&mut conn)
        .await
        .unwrap();
        let cred_id = CredentialId::from_bytes([0x20 + u; 16]).to_string();
        sqlx::query(
            "INSERT INTO credentials(id,owner_id,name,kind,secret,injection,consent_epoch,runtime_epoch,revision,created_at,updated_at)
             VALUES (?1,?2,'k','provider-header-v1','cipher','header',1,1,1,1,1)",
        )
        .bind(&cred_id)
        .bind(&uid)
        .execute(&mut conn)
        .await
        .unwrap();
        let res_id = ProviderResourceId::from_bytes([0x30 + u; 16]).to_string();
        sqlx::query(
            "INSERT INTO provider_resources(id,owner_id,name,wire,base_url,headers,credential_id,consent_epoch,runtime_epoch,timeouts,revision)
             VALUES (?1,?2,?3,'openai','https://api.openai.com/v1','{}',?4,1,1,'{}',1)",
        )
        .bind(&res_id)
        .bind(&uid)
        .bind(format!("res-{u}"))
        .bind(&cred_id)
        .execute(&mut conn)
        .await
        .unwrap();
        let space_id = SpaceId::from_bytes([0x40 + u; 16]).to_string();
        for a in 0..6u8 {
            let att_id = format!("att_{u:02x}_{a:02x}");
            let state = if a % 2 == 0 { "approved" } else { "pending" };
            let (target_kind, target_project) = if a == 0 {
                ("space", None)
            } else {
                ("project", Some(format!("fld_{u:02x}_{a:02x}")))
            };
            sqlx::query(
                "INSERT INTO provider_attachments(id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision)
                 VALUES (?1,?2,?3,NULL,?4,?5,1,1,?6,'{}',NULL,1)",
            )
            .bind(&att_id)
            .bind(&res_id)
            .bind(target_kind)
            .bind(&space_id)
            .bind(target_project)
            .bind(state)
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for e in 0..16u8 {
            let ep_id =
                EpisodeId::from_bytes([0x60 + u, e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
                    .to_string();
            let lifecycle = if e < 14 { "closed" } else { "active" };
            sqlx::query(
                "INSERT INTO agent_episodes(episode_id,owner_id,name,lifecycle,revision,created_at,last_seen_at)
                 VALUES (?1,?2,'daily',?3,1,1,?4)",
            )
            .bind(&ep_id)
            .bind(&uid)
            .bind(lifecycle)
            .bind(100 + i64::from(e))
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for s in 0..6u8 {
            let sched_id =
                ScheduleId::from_bytes([0x70 + u, s, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
                    .to_string();
            let deleted_at = (s >= 4).then_some(500 + i64::from(s));
            let next_slot = (s < 4).then_some(1000 + i64::from(s));
            sqlx::query(
                "INSERT INTO agent_schedules(schedule_id,owner_id,space_id,project_folder_id,title,init_prompt,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,config_revision,revision,created_at,updated_at)
                 VALUES (?1,?2,?3,NULL,'k','p','0 * * * *','UTC','r',NULL,1,'{}','coalesce_latest',?4,?5,1,1,1,1)",
            )
            .bind(&sched_id)
            .bind(&uid)
            .bind(&space_id)
            .bind(next_slot)
            .bind(deleted_at)
            .execute(&mut conn)
            .await
            .unwrap();
            for r in 0..4u8 {
                let run_id =
                    AgentRunId::from_bytes([0x80 + u, s, r, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
                        .to_string();
                let (status, finished_at) = match r {
                    0 => ("claimed", None),
                    1 => ("running", None),
                    2 => ("succeeded", Some(2000 + i64::from(s))),
                    _ => ("failed", Some(2100 + i64::from(s))),
                };
                sqlx::query(
                    "INSERT INTO agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at)
                     VALUES (?1,?2,?3,1,?4,1,NULL,?5,10,?6,0,1,0,'scope',5000)",
                )
                .bind(&run_id)
                .bind(&sched_id)
                .bind(100 + i64::from(r))
                .bind(&[0xAAu8; 32][..])
                .bind(status)
                .bind(finished_at)
                .execute(&mut conn)
                .await
                .unwrap();
            }
        }
    }

    let queries: &[(&str, &str, &str)] = &[
        (
            "schedule_due",
            "SELECT schedule_id FROM agent_schedules WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms IS NOT NULL AND next_slot_utc_ms<=9999 ORDER BY next_slot_utc_ms,schedule_id LIMIT 64",
            "USING INDEX schedule_due",
        ),
        (
            "schedule_expired_run",
            "SELECT run_id FROM agent_schedule_runs WHERE status IN ('claimed','running') AND expires_at<=9999 ORDER BY expires_at,run_id LIMIT 64",
            "USING INDEX schedule_expired_run",
        ),
        (
            "schedule_deleted",
            "SELECT s.schedule_id FROM agent_schedules s WHERE s.deleted_at IS NOT NULL AND s.deleted_at<=9999 AND NOT EXISTS(SELECT 1 FROM agent_schedule_runs r WHERE r.schedule_id=s.schedule_id) ORDER BY s.deleted_at,s.schedule_id LIMIT 200",
            "schedule_deleted",
        ),
        (
            "schedule_run_retention",
            "SELECT r.run_id FROM agent_schedule_runs r WHERE r.status IN ('succeeded','failed','unknown') AND r.finished_at IS NOT NULL AND r.finished_at<=9999 AND NOT EXISTS(SELECT 1 FROM agent_schedules s WHERE s.schedule_id=r.schedule_id AND s.deleted_at IS NULL) ORDER BY r.finished_at,r.run_id LIMIT 200",
            "USING INDEX schedule_run_retention",
        ),
        (
            "episode_owner_name_open",
            "SELECT * FROM agent_episodes WHERE owner_id='principal_a' AND name='daily' AND lifecycle<>'closed' AND episode_id>'' ORDER BY episode_id LIMIT 64",
            "USING INDEX episode_owner_name_open",
        ),
        (
            "list_offers_space",
            "SELECT p.* FROM provider_attachments p JOIN provider_resources r ON r.id=p.resource_id JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id WHERE p.target_space='sp_a' AND (p.target_kind='space' OR (p.target_kind='project' AND p.target_project='fld_a')) AND p.id>'' AND p.state='approved' AND (p.expires_at IS NULL OR p.expires_at>1) AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND p.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND p.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND p.credential_epoch=c.consent_epoch)) ORDER BY p.id LIMIT 64",
            "USING INDEX attachment_target_approved_id",
        ),
        (
            "list_offers_project_pinned",
            "SELECT p.* FROM provider_attachments p JOIN provider_resources r ON r.id=p.resource_id JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id WHERE p.target_space='sp_a' AND p.target_kind='project' AND p.target_project='fld_a' AND p.id>'' AND p.state='approved' AND (p.expires_at IS NULL OR p.expires_at>1) AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND p.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND p.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND p.credential_epoch=c.consent_epoch)) ORDER BY p.id LIMIT 64",
            "USING INDEX attachment_target_approved_id",
        ),
    ];

    for phase in ["pre-ANALYZE", "post-ANALYZE"] {
        if phase == "post-ANALYZE" {
            sqlx::query("ANALYZE").execute(&mut conn).await.unwrap();
        }
        for (name, sql, expected_idx) in queries {
            let plan: Vec<String> =
                sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")))
                    .fetch_all(&mut conn)
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|r| r.get::<String, _>(3))
                    .collect();
            let joined = plan.join("\n");
            assert!(
                joined.contains(expected_idx),
                "{phase} {name} must use {expected_idx}, got:\n{joined}"
            );
            assert!(
                !joined.contains("SCAN ") && !joined.contains("TEMP B-TREE"),
                "{phase} {name} must have zero table scans and zero temp B-trees, got:\n{joined}"
            );
        }
    }
    conn.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
