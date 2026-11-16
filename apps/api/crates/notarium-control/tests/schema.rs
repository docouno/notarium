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
