use super::*;
use notarium_core::{
    DomainError,
    ids::RequestId,
    ports::{CallBudget, Cancellation},
};
use sqlx::Connection;
use std::time::{SystemTime, UNIX_EPOCH};

fn budget(milliseconds: u64) -> lease::OperationBudget {
    lease::OperationBudget::new(CallBudget {
        request: RequestId::from_bytes([1; 16]),
        cancellation: Cancellation::default(),
        remaining: Duration::from_millis(milliseconds),
    })
}
async fn abandon_waiting_writers(store: &ControlStore) {
    let mut attempts = Box::pin(futures_util::future::join_all(
        (0..4).map(|_| store.write(budget(80))),
    ));
    assert!(futures_util::poll!(&mut attempts).is_pending());
    assert_eq!(store.write_admission.available_permits(), 0);
    assert!(matches!(
        store.write(budget(1000)).await,
        Err(PortError::Domain(DomainError::RateLimited { .. }))
    ));
    // Allow BEGIN/advisory-lock workers to reach the database. The caller's
    // budget expires first, but rollback ownership must survive its future.
    let results = attempts.await;
    assert!(
        results
            .iter()
            .all(|result| matches!(result, Err(PortError::DeadlineExceeded(_))))
    );
    assert_eq!(store.write_admission.available_permits(), 0);
    assert!(
        tokio::time::timeout(
            Duration::from_millis(15),
            store.writes.clone().write_owned()
        )
        .await
        .is_err()
    );
}
async fn await_rollback_ack(store: &ControlStore) {
    let pause = tokio::time::timeout(Duration::from_secs(2), store.writes.clone().write_owned())
        .await
        .unwrap();
    assert_eq!(store.write_admission.available_permits(), 4);
    drop(pause);
    store
        .write(budget(2000))
        .await
        .unwrap()
        .rollback()
        .await
        .unwrap();
}
#[tokio::test]
async fn sqlite_cancelled_begin_keeps_writer_fence_until_driver_ack() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").expect("use pinned runner"))
        .join(format!("control-tests/writer-{unique}"));
    std::fs::create_dir_all(root.join("v1")).unwrap();
    let store = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
    let mut blocker = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        root.join("v1/control.sqlite").display()
    ))
    .await
    .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut blocker)
        .await
        .unwrap();
    abandon_waiting_writers(&store).await;
    sqlx::query("ROLLBACK").execute(&mut blocker).await.unwrap();
    await_rollback_ack(&store).await;
    blocker.close().await.unwrap();
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn postgres_cancelled_admission_keeps_writer_fence_until_driver_ack() {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/control-db-fixture/active.json");
    let descriptor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(file).expect("run make test with database fixture"))
            .unwrap();
    let socket = PathBuf::from(descriptor["socket"].as_str().unwrap());
    let options = PgConnectOptions::new()
        .socket(&socket)
        .username("postgres")
        .database("postgres");
    let mut admin = sqlx::PgConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE DATABASE writer_ownership_test")
        .execute(&mut admin)
        .await
        .unwrap();
    let store = ControlStore::postgres(PostgresConfig::unix_socket(
        socket,
        "writer_ownership_test",
        "postgres",
    ))
    .await
    .unwrap();
    let mut blocker = sqlx::PgConnection::connect_with(&options.database("writer_ownership_test"))
        .await
        .unwrap();
    sqlx::query("BEGIN").execute(&mut blocker).await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(BACKUP_LOCK)
        .execute(&mut blocker)
        .await
        .unwrap();
    abandon_waiting_writers(&store).await;
    sqlx::query("ROLLBACK").execute(&mut blocker).await.unwrap();
    await_rollback_ack(&store).await;
    blocker.close().await.unwrap();
    store.close().await;
    sqlx::query("DROP DATABASE writer_ownership_test")
        .execute(&mut admin)
        .await
        .unwrap();
}
