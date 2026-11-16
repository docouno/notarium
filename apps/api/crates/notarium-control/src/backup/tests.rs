use super::*;
use crate::{
    keyring::KeyringLocation,
    store::{
        statements::{execute, rows},
        target::TargetRecord,
    },
    test_support::{Fixture, budget},
};
use notarium_core::model::HistoryScope;
use std::{fs, path::PathBuf, time::Instant};

pub(super) fn context(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: budget(),
    }
}
pub(super) async fn fixture(pg: bool, label: &str) -> (Fixture, ControlBackup, DataRoot) {
    let fixture = Fixture::new(pg, label).await;
    let mut tx = fixture
        .store
        .write(OperationBudget::new(budget()))
        .await
        .unwrap();
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/keyring/vectors.json")).unwrap();
    execute!(tx.inner_mut(),"INSERT INTO secret_keyring(key_id,key_hash,generation,state,canary,created_at) VALUES($1,$2,1,'active',$3,0)","INSERT INTO v1_control.secret_keyring(key_id,key_hash,generation,state,canary,created_at) VALUES($1,$2,1,'active',$3,0)";vector["keyId"].as_str().unwrap(),vector["keyHash"].as_str().unwrap(),vector["canaryEnvelope"].as_str().unwrap()).unwrap();
    execute!(tx.inner_mut(),"INSERT INTO users(user_id,username,display_name,created_at) VALUES($1,'backup','before',0)","INSERT INTO v1_control.users(user_id,username,display_name,created_at) VALUES($1,'backup','before',0)";PrincipalId::from_bytes([1;16]).as_str()).unwrap();
    tx.commit().await.unwrap();
    let data = DataRoot::new(fixture.root.clone().unwrap_or_else(|| {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap())
            .join(format!("control-tests/backup-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }));
    let keyring = Keyring::open(
        fixture.store.clone(),
        KeyringLocation::External(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native"),
        ),
        budget(),
    )
    .await
    .unwrap();
    let participant = ControlBackup::new(
        fixture.store.clone(),
        keyring,
        data.clone(),
        BackupConfig::default(),
    )
    .unwrap();
    (fixture, participant, data)
}
pub(super) async fn update(store: ControlStore, name: &str) {
    let mut tx = store.write(OperationBudget::new(budget())).await.unwrap();
    execute!(tx.inner_mut(),"UPDATE users SET display_name=$1 WHERE username='backup'","UPDATE v1_control.users SET display_name=$1 WHERE username='backup'";name).unwrap();
    tx.commit().await.unwrap();
}
pub(super) async fn idle(participant: &ControlBackup) {
    let until = Instant::now() + Duration::from_secs(5);
    while participant.admission.available_permits() != 1 {
        assert!(
            Instant::now() < until,
            "backup owner did not acknowledge cleanup"
        );
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}
fn incomplete(data: &DataRoot) -> usize {
    fs::read_dir(data.staging().join("control"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.ends_with(".partial") || name.ends_with(".pending")
        })
        .count()
}
async fn exercise(pg: bool) {
    let (mut fixture, participant, data) = fixture(
        pg,
        if pg {
            "backup_postgres"
        } else {
            "backup_sqlite"
        },
    )
    .await;
    let limits = participant.default_budget();
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([1; 16]),
            limits,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    assert_eq!(hold.witness().schema_version, 1);
    assert!(hold.witness().histories.is_empty());
    assert_eq!(hold.witness().canaries.len(), 1);
    assert_eq!(hold.witness().canaries[0].generation, 1);
    assert!(hold.witness().canaries[0].active);
    let mut pause = prepared.pause_writes().await.unwrap();
    drop(prepared); // An obsolete phase must not abort its successor.
    let writer = tokio::spawn(update_owned(fixture.store.clone(), "after".into()));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!writer.is_finished());
    let mut snapshot = pause.open_cut().await.unwrap();
    pause.resume().await.unwrap();
    writer.await.unwrap();
    assert_eq!(
        fixture
            .observer
            .text("SELECT display_name FROM users WHERE username='backup'")
            .await,
        "after"
    );
    let receipt = snapshot
        .spool(limits, Cancellation::default())
        .await
        .unwrap();
    snapshot.close().await.unwrap();
    hold.release().await.unwrap();
    idle(&participant).await;
    assert!(receipt.bytes > 0);
    assert_eq!(incomplete(&data), 0);
    let (saved, file) = participant
        .open_artifact(context(ServicePurpose::Backup), receipt.artifact.clone())
        .await
        .unwrap();
    assert_eq!(saved.digest, receipt.digest);
    // Neither raw key bytes nor key-file encodings belong to a database backup.
    let bytes = fs::read(
        data.staging()
            .join("control")
            .join(format!("{}.data", receipt.artifact)),
    )
    .unwrap();
    let key: Vec<u8> = (0..32).collect();
    assert!(!bytes.windows(key.len()).any(|window| window == key));
    assert!(!bytes.windows(64).any(
        |window| window == b"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    ));
    match receipt.kind {
        BackupArtifactKind::SqliteSnapshotV1 => {
            assert!(!pg);
            drop(file);
            let connection = rusqlite::Connection::open_with_flags(
                data.staging()
                    .join("control")
                    .join(format!("{}.data", receipt.artifact)),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let name: String = connection
                .query_row(
                    "SELECT display_name FROM users WHERE username='backup'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(name, "before");
            let integrity: String = connection
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .unwrap();
            assert_eq!(integrity, "ok");
        }
        BackupArtifactKind::PostgresSpoolV1 => {
            assert!(pg);
            let mut reader = SpoolReader::open(file).unwrap();
            let mut users = 0;
            while let Some(record) = reader.next_record().unwrap() {
                if let TargetRecord::Users { display_name, .. } = record {
                    assert_eq!(display_name, "before");
                    users += 1;
                }
            }
            assert_eq!(users, 1);
            assert!(reader.next_record().unwrap().is_none());
        }
    }
    // Abandoned phases clean themselves without removing completed artifacts or
    // unrelated files in the staging directory.
    fs::write(data.staging().join("control/unrelated.txt"), b"keep").unwrap();
    for phase in 0..3 {
        let mut prepared = participant
            .prepare(
                context(ServicePurpose::Backup),
                BackupId::from_bytes([10 + phase; 16]),
                limits,
            )
            .await
            .unwrap();
        let hold = prepared.acquire_hold().await.unwrap();
        if phase == 0 {
            drop(prepared);
        } else {
            let mut pause = prepared.pause_writes().await.unwrap();
            if phase == 1 {
                drop(pause);
            } else {
                let snapshot = pause.open_cut().await.unwrap();
                pause.resume().await.unwrap();
                drop(snapshot);
            }
            drop(prepared);
        }
        hold.release().await.unwrap();
        idle(&participant).await;
        assert_eq!(incomplete(&data), 0);
        update(fixture.store.clone(), "live").await;
    }
    assert_eq!(
        fs::read(data.staging().join("control/unrelated.txt")).unwrap(),
        b"keep"
    );
    participant
        .open_artifact(context(ServicePurpose::Backup), receipt.artifact.clone())
        .await
        .unwrap();
    // A crash leaves a durable pending marker; recovery removes only its files.
    let abandoned = ArtifactId::from_bytes([88; 16]);
    {
        let mut owner = artifacts::Artifacts::open(&data, || Ok(())).unwrap();
        assert!(
            owner
                .begin(&receipt.artifact, &BackupId::from_bytes([88; 16]))
                .is_err()
        );
        owner.abort().unwrap();
        owner
            .begin(&abandoned, &BackupId::from_bytes([88; 16]))
            .unwrap();
    }
    assert_eq!(incomplete(&data), 2);
    // A tiny spool budget aborts the complete operation and releases the cut.
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([20; 16]),
            limits,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    let mut pause = prepared.pause_writes().await.unwrap();
    let mut snapshot = pause.open_cut().await.unwrap();
    pause.resume().await.unwrap();
    let mut tiny = limits;
    tiny.max_spool_bytes = 1;
    assert!(matches!(
        snapshot.spool(tiny, Cancellation::default()).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::BudgetExceeded
    ));
    snapshot.close().await.unwrap();
    drop(prepared);
    hold.release().await.unwrap();
    idle(&participant).await;
    assert_eq!(incomplete(&data), 0);
    participant
        .open_artifact(context(ServicePurpose::Backup), receipt.artifact.clone())
        .await
        .unwrap();
    // Backend-specific retention metrics are never silently substituted.
    let mut mismatch = limits;
    mismatch.retention = if pg {
        BackupRetentionBudget::SqliteWal {
            max_pinned_bytes: u64::MAX,
        }
    } else {
        BackupRetentionBudget::PostgresSnapshot {
            max_age: Duration::from_secs(300),
        }
    };
    assert!(matches!(
        participant
            .prepare(
                context(ServicePurpose::Backup),
                BackupId::from_bytes([21; 16]),
                mismatch
            )
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed { .. }))
    ));
    restore(&fixture.store, &participant).await;
    assert!(participant.last_metrics().is_some());
    drop(participant);
    fixture.close().await;
    if pg {
        fs::remove_dir_all(data.root()).unwrap();
    }
}
async fn update_owned(store: ControlStore, name: String) {
    update(store, &name).await
}

async fn restore(store: &ControlStore, participant: &ControlBackup) {
    let owner = PrincipalId::from_bytes([1; 16]);
    let episode = EpisodeId::from_bytes([1; 16]);
    let a = SpaceId::from_bytes([1; 16]);
    let b = SpaceId::from_bytes([2; 16]);
    let mut tx = store.write(OperationBudget::new(budget())).await.unwrap();
    execute!(tx.inner_mut(),"INSERT INTO agent_episodes(episode_id,owner_id,lifecycle,revision,created_at,last_seen_at) VALUES($1,$2,'active',0,0,0)","INSERT INTO v1_control.agent_episodes(episode_id,owner_id,lifecycle,revision,created_at,last_seen_at) VALUES($1,$2,'active',0,0,0)";episode.as_str(),owner.as_str()).unwrap();
    for space in [&a, &b] {
        execute!(tx.inner_mut(),"INSERT INTO mcp_delta_owner_cursors(owner_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,90,0)","INSERT INTO v1_control.mcp_delta_owner_cursors(owner_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,90,0)";owner.as_str(),space.as_str(),[1u8;16].as_slice()).unwrap();
        execute!(tx.inner_mut(),"INSERT INTO mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,5,0)","INSERT INTO v1_control.mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,5,0)";episode.as_str(),space.as_str(),[1u8;16].as_slice()).unwrap();
    }
    tx.commit().await.unwrap();
    let restored = ChangeCursor {
        scope: HistoryScope {
            space_id: a.clone(),
            incarnation: HistoryIncarnation::from_bytes([2; 16]),
        },
        after: SpaceSeq::new(10).unwrap(),
    };
    assert!(
        participant
            .restore_cursors(
                context(ServicePurpose::Restore),
                vec![restored.clone(), restored.clone()]
            )
            .await
            .is_err()
    );
    participant
        .restore_cursors(context(ServicePurpose::Restore), vec![restored.clone()])
        .await
        .unwrap();
    participant
        .restore_cursors(context(ServicePurpose::Restore), vec![restored])
        .await
        .unwrap();
    #[derive(sqlx::FromRow)]
    struct Row {
        history_incarnation: Vec<u8>,
        acked_space_seq: i64,
    }
    let mut tx = store.write(OperationBudget::new(budget())).await.unwrap();
    for (space, history, owner_seq) in [(&a, vec![2u8; 16], 10), (&b, vec![1u8; 16], 90)] {
        let row=rows!(tx.inner_mut(),Row,fetch_one,"SELECT history_incarnation,acked_space_seq FROM mcp_delta_owner_cursors WHERE owner_id=$1 AND space_id=$2","SELECT history_incarnation,acked_space_seq FROM v1_control.mcp_delta_owner_cursors WHERE owner_id=$1 AND space_id=$2";owner.as_str(),space.as_str()).unwrap();
        assert_eq!(
            (row.history_incarnation, row.acked_space_seq),
            (history.clone(), owner_seq)
        );
        let row=rows!(tx.inner_mut(),Row,fetch_one,"SELECT history_incarnation,acked_space_seq FROM mcp_delta_session_cursors WHERE episode_id=$1 AND space_id=$2","SELECT history_incarnation,acked_space_seq FROM v1_control.mcp_delta_session_cursors WHERE episode_id=$1 AND space_id=$2";episode.as_str(),space.as_str()).unwrap();
        assert_eq!((row.history_incarnation, row.acked_space_seq), (history, 5));
    }
    tx.rollback().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_backup_phases_cut_and_restore() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    exercise(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_backup_phases_cut_and_restore() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    exercise(true).await;
}

async fn faults(pg: bool) {
    let (mut fixture, participant, data) = fixture(pg, "backup_faults").await;
    let limits = participant.default_budget();
    // Cancellation is observed even if no further protocol method is polled.
    for phase in 0..4 {
        let ctx = context(ServicePurpose::Backup);
        let cancel = ctx.budget.cancellation.clone();
        let mut prepared = participant
            .prepare(ctx, BackupId::from_bytes([30 + phase; 16]), limits)
            .await
            .unwrap();
        let hold = prepared.acquire_hold().await.unwrap();
        let mut pause = if phase > 0 {
            Some(prepared.pause_writes().await.unwrap())
        } else {
            None
        };
        let snapshot = if phase > 1 {
            Some(pause.as_mut().unwrap().open_cut().await.unwrap())
        } else {
            None
        };
        if phase == 3 {
            pause.take().unwrap().resume().await.unwrap();
        }
        cancel.cancel();
        idle(&participant).await;
        if let Some(snapshot) = snapshot {
            snapshot.close().await.unwrap();
        }
        drop(pause);
        drop(prepared);
        hold.release().await.unwrap();
        assert_eq!(incomplete(&data), 0);
        update(fixture.store.clone(), "after-cancellation").await;
    }
    // Dropping a blocked pause future cannot strand its owner behind a writer.
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([40; 16]),
            limits,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    let writer = fixture
        .store
        .write(OperationBudget::new(budget()))
        .await
        .unwrap();
    let mut pause = prepared.pause_writes();
    assert!(futures_util::poll!(&mut pause).is_pending());
    tokio::time::sleep(Duration::from_millis(10)).await;
    drop(pause);
    writer.rollback().await.unwrap();
    drop(prepared);
    hold.release().await.unwrap();
    idle(&participant).await;
    assert_eq!(incomplete(&data), 0);

    // Retention expires independently of the caller while its cut is idle.
    let mut retained = limits;
    retained.retention = if pg {
        BackupRetentionBudget::PostgresSnapshot {
            max_age: Duration::from_millis(40),
        }
    } else {
        let bytes = fs::metadata(data.control().with_file_name("control.sqlite-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        BackupRetentionBudget::SqliteWal {
            max_pinned_bytes: bytes + 32 * 1024,
        }
    };
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([41; 16]),
            retained,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    let mut pause = prepared.pause_writes().await.unwrap();
    let mut snapshot = pause.open_cut().await.unwrap();
    pause.resume().await.unwrap();
    if pg {
        tokio::time::sleep(Duration::from_millis(65)).await;
    } else {
        for index in 0..30 {
            update(fixture.store.clone(), &format!("grow-wal-{index}")).await;
        }
    }
    idle(&participant).await;
    assert!(
        snapshot
            .spool(retained, Cancellation::default())
            .await
            .is_err()
    );
    snapshot.close().await.unwrap();
    drop(prepared);
    hold.release().await.unwrap();
    assert_eq!(incomplete(&data), 0);
    update(fixture.store.clone(), "retention-cleaned").await;
    if pg {
        assert_eq!(fixture.observer.count("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'").await, 0);
    }

    // A completed spool left unread in the reply channel is still owned by the
    // participant. Dropping that pending future must remove even its ready marker.
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([43; 16]),
            limits,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    let mut pause = prepared.pause_writes().await.unwrap();
    let mut snapshot = pause.open_cut().await.unwrap();
    pause.resume().await.unwrap();
    let mut spool = snapshot.spool(limits, Cancellation::default());
    assert!(futures_util::poll!(&mut spool).is_pending());
    let until = Instant::now() + Duration::from_secs(5);
    while !fs::read_dir(data.staging().join("control"))
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".ready"))
    {
        assert!(Instant::now() < until, "worker did not offer stable spool");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    drop(spool);
    snapshot.close().await.unwrap();
    drop(prepared);
    hold.release().await.unwrap();
    idle(&participant).await;
    assert_eq!(
        fs::read_dir(data.staging().join("control"))
            .unwrap()
            .count(),
        1,
        "only the stable owner lock remains"
    );

    // The owner has its own I/O driver. Dropping the runtime which invoked prepare
    // must not prevent rollback, close ACK or release of a paused writer fence.
    let other = participant.clone();
    let (prepared, hold, pause, snapshot) = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let handles = runtime.block_on(async {
            let mut prepared = other
                .prepare(
                    context(ServicePurpose::Backup),
                    BackupId::from_bytes([44; 16]),
                    limits,
                )
                .await
                .unwrap();
            let hold = prepared.acquire_hold().await.unwrap();
            let mut pause = prepared.pause_writes().await.unwrap();
            let snapshot = pause.open_cut().await.unwrap();
            (prepared, hold, pause, snapshot)
        });
        drop(runtime);
        handles
    })
    .await
    .unwrap();
    drop(snapshot);
    drop(pause);
    drop(prepared);
    hold.release().await.unwrap();
    idle(&participant).await;
    update(fixture.store.clone(), "runtime-cleaned").await;

    if !pg {
        // An already queued native commit may outlive its async writer waiter.
        // The native barrier must drain it before the read-only snapshot is pinned.
        let mut prepared = participant
            .prepare(
                context(ServicePurpose::Backup),
                BackupId::from_bytes([45; 16]),
                limits,
            )
            .await
            .unwrap();
        let hold = prepared.acquire_hold().await.unwrap();
        fixture.observer.execute("BEGIN IMMEDIATE").await;
        fixture
            .observer
            .execute("UPDATE users SET display_name='native-committed' WHERE username='backup'")
            .await;
        let mut pause = prepared.pause_writes().await.unwrap();
        let mut pin = pause.open_cut();
        assert!(futures_util::poll!(&mut pin).is_pending());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(futures_util::poll!(&mut pin).is_pending());
        fixture.observer.execute("COMMIT").await;
        let mut snapshot = pin.await.unwrap();
        pause.resume().await.unwrap();
        let receipt = snapshot
            .spool(limits, Cancellation::default())
            .await
            .unwrap();
        snapshot.close().await.unwrap();
        drop(prepared);
        hold.release().await.unwrap();
        let db = rusqlite::Connection::open_with_flags(
            data.staging()
                .join("control")
                .join(format!("{}.data", receipt.artifact)),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT display_name FROM users WHERE username='backup'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "native-committed"
        );
        drop(db);
    }

    // A keyring change between preparation and pin invalidates the witness.
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([42; 16]),
            limits,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    let mut tx = fixture
        .store
        .write(OperationBudget::new(budget()))
        .await
        .unwrap();
    execute!(
        tx.inner_mut(),
        "UPDATE secret_keyring SET generation=2",
        "UPDATE v1_control.secret_keyring SET generation=2";
    )
    .unwrap();
    tx.commit().await.unwrap();
    let mut pause = prepared.pause_writes().await.unwrap();
    assert!(pause.open_cut().await.is_err());
    drop(pause);
    drop(prepared);
    hold.release().await.unwrap();
    idle(&participant).await;
    assert_eq!(incomplete(&data), 0);
    update(fixture.store.clone(), "witness-cleaned").await;
    drop(participant);
    fixture.close().await;
    if pg {
        fs::remove_dir_all(data.root()).unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_backup_cancellation_retention_and_witness() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    faults(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_backup_cancellation_retention_and_witness() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    faults(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_stalled_query_has_bounded_cleanup() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    let (mut fixture, participant, data) = fixture(true, "backup_stalled").await;
    let limits = participant.default_budget();
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([50; 16]),
            limits,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    let mut pause = prepared.pause_writes().await.unwrap();
    let mut snapshot = pause.open_cut().await.unwrap();
    pause.resume().await.unwrap();
    // Simulate a stalled read without weakening any authority or writer admission.
    fixture.observer.execute("BEGIN").await;
    fixture
        .observer
        .execute("LOCK TABLE users IN ACCESS EXCLUSIVE MODE")
        .await;
    let mut short = limits;
    short.deadline = Duration::from_millis(200);
    let start = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(12),
        snapshot.spool(short, Cancellation::default()),
    )
    .await
    .expect("cleanup exceeded its independent grace");
    assert!(result.is_err());
    assert!(
        start.elapsed() >= Duration::from_secs(5),
        "the blocked rollback should exhaust cleanup grace"
    );
    assert!(
        snapshot.close().await.is_err(),
        "failed cleanup must not report graceful rollback ACK"
    );
    fixture.observer.execute("ROLLBACK").await;
    drop(prepared);
    hold.release().await.unwrap();
    idle(&participant).await;
    assert_eq!(incomplete(&data), 0);
    update(fixture.store.clone(), "after-stalled-query").await;
    drop(participant);
    fixture.close().await;
    fs::remove_dir_all(data.root()).unwrap();
}

#[test]
fn sqlite_backup_writer_child() {
    let Some(root) = std::env::var_os("NOTARIUM_TEST_BACKUP_ROOT") else {
        return;
    };
    let data = DataRoot::new(PathBuf::from(root));
    fs::write(data.root().join("child-started"), []).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let store = ControlStore::sqlite(&data).await.unwrap();
        update(store.clone(), "other-process").await;
        store.close().await;
    });
    fs::write(data.root().join("child-committed"), []).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_backup_fences_another_process_and_keeps_its_cut() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    let (fixture, participant, data) = fixture(false, "backup_process").await;
    let limits = participant.default_budget();
    let mut prepared = participant
        .prepare(
            context(ServicePurpose::Backup),
            BackupId::from_bytes([51; 16]),
            limits,
        )
        .await
        .unwrap();
    let hold = prepared.acquire_hold().await.unwrap();
    let mut pause = prepared.pause_writes().await.unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "backup::tests::sqlite_backup_writer_child",
            "--nocapture",
        ])
        .env("NOTARIUM_TEST_BACKUP_ROOT", data.root())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while !data.root().join("child-started").exists() {
        assert!(Instant::now() < until);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(child.try_wait().unwrap().is_none());
    assert!(!data.root().join("child-committed").exists());
    let mut snapshot = pause.open_cut().await.unwrap();
    pause.resume().await.unwrap();
    let status = tokio::task::spawn_blocking(move || child.wait().unwrap())
        .await
        .unwrap();
    assert!(status.success());
    assert!(data.root().join("child-committed").exists());
    let receipt = snapshot
        .spool(limits, Cancellation::default())
        .await
        .unwrap();
    snapshot.close().await.unwrap();
    drop(prepared);
    hold.release().await.unwrap();
    let db = rusqlite::Connection::open_with_flags(
        data.staging()
            .join("control")
            .join(format!("{}.data", receipt.artifact)),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        db.query_row(
            "SELECT display_name FROM users WHERE username='backup'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "before"
    );
    drop(db);
    drop(participant);
    fixture.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_prepare_observes_cancellation_before_worker_launch() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    let (mut fixture, participant, data) = fixture(true, "backup_preparation_cancel").await;
    fixture.observer.execute("BEGIN").await;
    fixture
        .observer
        .execute("LOCK TABLE v1_storage_epoch IN ACCESS EXCLUSIVE MODE")
        .await;
    let ctx = context(ServicePurpose::Backup);
    let cancellation = ctx.budget.cancellation.clone();
    let other = participant.clone();
    let mut attempt = tokio::spawn(async move {
        other
            .prepare(ctx, BackupId::from_bytes([52; 16]), other.default_budget())
            .await
    });
    let until = Instant::now() + Duration::from_secs(2);
    let Backend::Postgres { pool, .. } = &fixture.store.backend else {
        unreachable!()
    };
    while sqlx::query_scalar::<_, i64>("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT installation_id%'").fetch_one(pool).await.unwrap() == 0 {
        assert!(Instant::now() < until, "prepare did not reach installation read");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_millis(100), &mut attempt).await;
    let prompt = result.is_ok();
    fixture.observer.execute("ROLLBACK").await;
    let result = match result {
        Ok(result) => result.unwrap(),
        Err(_) => attempt.await.unwrap(),
    };
    let cancelled = matches!(result, Err(PortError::Cancelled(_)));
    drop(result);
    idle(&participant).await;
    drop(participant);
    fixture.close().await;
    fs::remove_dir_all(data.root()).unwrap();
    assert!(
        prompt,
        "prepare ignored cancellation until the blocked installation read completed"
    );
    assert!(cancelled, "prepare must preserve the cancellation outcome");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_pinned_cut_close_survives_concurrent_interrupts() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    let (fixture, participant, data) = fixture(false, "backup_close_interrupt").await;
    let limits = participant.default_budget();
    let keys = participant.keyring.inspect(budget()).await.unwrap();
    let installation = fixture.store.installation().await.unwrap().unwrap();
    let witness = BackupWitness {
        installation,
        schema_version: TARGET_SCHEMA_VERSION,
        histories: vec![],
        canaries: vec![],
    };
    let wal = PathBuf::from(format!("{}-wal", data.control().display()));

    for idx in 0..64_u8 {
        let dest = data.root().join(format!("interrupt-dest-{idx}.sqlite"));
        fs::write(&dest, b"").unwrap();
        let session = session::Session::new(budget(), limits, Some(wal.clone()));
        let mut cut = sqlite::SqliteCut::prepare(&data.control(), &dest, &session).unwrap();
        cut.pin(&witness, &keys, &session).unwrap();
        let mut tiny = limits;
        tiny.max_spool_bytes = 1;
        session.spool_budget(tiny, Cancellation::default()).unwrap();
        let _ = cut.spool(&session);
        let ready = Arc::new(std::sync::Barrier::new(2));
        let ready_bg = ready.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_bg = stop.clone();
        let cancel_session = session.clone();
        let interrupter = std::thread::spawn(move || {
            ready_bg.wait();
            while !stop_bg.load(std::sync::atomic::Ordering::Relaxed) {
                cancel_session.cancel();
            }
        });
        ready.wait();
        let closed = cut.close(&session);
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        interrupter.join().unwrap();
        closed.expect(
            "pinned SQLite backup cut close must not fail under concurrent sqlite3_interrupt",
        );
    }

    drop(participant);
    fixture.close().await;
}
