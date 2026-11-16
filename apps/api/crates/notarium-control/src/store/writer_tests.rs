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

#[tokio::test]
async fn sqlite_file_fence_spans_pools_and_bootstrap() {
    use super::fence::{FileFence, sqlite_writer_lock};
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").expect("use pinned runner"))
        .join(format!("control-tests/file-fence-{unique}"));
    std::fs::create_dir_all(root.join("v1")).unwrap();
    let data = DataRoot::new(&root);
    let first = ControlStore::sqlite(&data).await.unwrap();
    let second = ControlStore::sqlite(&data).await.unwrap();
    let path = sqlite_writer_lock(&data.control());
    let transaction = first.write(budget(2000)).await.unwrap();
    let probe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    assert!(matches!(
        probe.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    transaction.rollback().await.unwrap();
    probe.try_lock().unwrap();
    probe.unlock().unwrap();

    let pause = FileFence::acquire(&path, true, || Ok(())).unwrap();
    assert!(matches!(
        second.write(budget(50)).await,
        Err(PortError::DeadlineExceeded(_))
    ));
    let bootstrap_root = data.clone();
    let bootstrap = tokio::spawn(async move { ControlStore::sqlite(&bootstrap_root).await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!bootstrap.is_finished());
    pause.release().unwrap();
    let third = tokio::time::timeout(Duration::from_secs(3), bootstrap)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    second
        .write(budget(2000))
        .await
        .unwrap()
        .commit()
        .await
        .unwrap();
    first.close().await;
    second.close().await;
    third.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn sqlite_file_fence_excludes_another_process() {
    use super::fence::FileFence;
    const CHILD: &str = "NOTARIUM_TEST_FENCE_CHILD";
    if let Some(path) = std::env::var_os(CHILD) {
        let path = PathBuf::from(path);
        let fence = FileFence::acquire(&path.join("writer.lock"), false, || Ok(())).unwrap();
        std::fs::write(path.join("ready"), b"ready").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !path.join("release").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        fence.release().unwrap();
        return;
    }
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").expect("use pinned runner"))
        .join(format!("control-tests/process-fence-{unique}"));
    std::fs::create_dir_all(&root).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "store::writer_tests::sqlite_file_fence_excludes_another_process",
            "--nocapture",
        ])
        .env(CHILD, &root)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !root.join("ready").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let probe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("writer.lock"))
        .unwrap();
    assert!(matches!(
        probe.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    std::fs::write(root.join("release"), b"release").unwrap();
    assert!(child.wait().unwrap().success());
    probe.try_lock().unwrap();
    probe.unlock().unwrap();
    drop(probe);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn postgres_bootstrap_waits_for_the_backup_fence() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/control-db-fixture/active.json");
    let descriptor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
    let socket = PathBuf::from(descriptor["socket"].as_str().unwrap());
    let options = sqlx::postgres::PgConnectOptions::new()
        .socket(&socket)
        .username("postgres")
        .database("postgres");
    let mut admin = sqlx::PgConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE DATABASE writer_bootstrap_test")
        .execute(&mut admin)
        .await
        .unwrap();
    let mut blocker = sqlx::PgConnection::connect_with(&options.database("writer_bootstrap_test"))
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(BACKUP_LOCK)
        .execute(&mut blocker)
        .await
        .unwrap();
    let bootstrap = tokio::spawn(async move {
        ControlStore::postgres(PostgresConfig::unix_socket(
            socket,
            "writer_bootstrap_test",
            "postgres",
        ))
        .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!bootstrap.is_finished());
    let schema: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='v1_control')")
            .fetch_one(&mut blocker)
            .await
            .unwrap();
    assert!(!schema);
    let unlocked: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1)")
        .bind(BACKUP_LOCK)
        .fetch_one(&mut blocker)
        .await
        .unwrap();
    assert!(unlocked);
    let store = tokio::time::timeout(Duration::from_secs(3), bootstrap)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    store
        .write(budget(2000))
        .await
        .unwrap()
        .rollback()
        .await
        .unwrap();
    store.close().await;
    blocker.close().await.unwrap();
    sqlx::query("DROP DATABASE writer_bootstrap_test")
        .execute(&mut admin)
        .await
        .unwrap();
}
