#![forbid(unsafe_code)]

mod support;

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use notarium_canonical::{
    BlobBackendConfig, CanonicalConfig, CanonicalRuntime, CreateFolderSpec, CreateSpaceSpec,
    SqlBackendConfig, WriterConfig, default_backup_budget, wal::sqlite_wal_path_for,
};
use notarium_core::{
    auth::SpaceKind,
    error::{CommitEffect, PortError},
    ids::{FolderId, LeaseEpoch, RequestId, SpaceSeq},
    ports::{CallBudget, Cancellation},
};

use crate::support::{
    TempDataRoot, random_bytes_16, sample_folder_id, sample_incarnation, sample_installation_id,
    sample_principal_id, sample_space_id,
};

const STUCK_RECURSIVE_SQL: &str = "WITH RECURSIVE spin(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM spin WHERE x < 500000000) \
     SELECT count(*) FROM spin";

#[tokio::test]
async fn sqlx_commit_after_restart_reuses_wal_without_closing_admission_again() {
    let temp = TempDataRoot::new("l4-retained-wal");
    let mut config = CanonicalConfig::local_default(sample_installation_id(0x49), temp.data_root());
    let SqlBackendConfig::Sqlite {
        passive_checkpoint_interval,
        wal_soft_watermark_bytes,
        wal_high_watermark_bytes,
        ..
    } = &mut config.sql
    else {
        unreachable!()
    };
    const HIGH: u64 = 3 * 1024 * 1024;
    *passive_checkpoint_interval = Duration::from_secs(600);
    *wal_soft_watermark_bytes = 2 * 1024 * 1024;
    *wal_high_watermark_bytes = HIGH;

    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    store
        .execute_diagnostic_write_sql_for_test(
            "CREATE TABLE wal_reuse AS SELECT zeroblob(4194304) AS payload",
        )
        .await
        .unwrap();
    store.run_wal_maintenance_now(false).await;
    let after_restart = store.wal_telemetry().unwrap();
    assert_eq!(after_restart.reset_successes, 1);
    assert!(after_restart.wal_bytes >= HIGH);

    store
        .execute_diagnostic_write_sql_for_test("INSERT INTO wal_reuse VALUES (X'01')")
        .await
        .unwrap();
    store.run_wal_maintenance_now(false).await;
    let reused = store.wal_telemetry().unwrap();
    assert!(reused.wal_bytes >= HIGH);
    assert_eq!(reused.reset_attempts, after_restart.reset_attempts);
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overlapping_readers_and_heavy_writes_trigger_bounded_wal_reset_with_zero_busy() {
    let temp = TempDataRoot::new("l4-wal-overlap");
    let data_root = temp.data_root();
    let wal_path = sqlite_wal_path_for(&data_root.canonical());

    let cfg = CanonicalConfig {
        installation_id: sample_installation_id(0x41),
        sql: SqlBackendConfig::Sqlite {
            data_root: data_root.clone(),
            read_pool_size: 8,
            read_deadline: Duration::from_millis(120),
            passive_checkpoint_interval: Duration::from_millis(10),
            wal_soft_watermark_bytes: 32 * 1024,
            wal_high_watermark_bytes: 64 * 1024,
            wal_reset_cycle_deadline: Duration::from_millis(250),
        },
        blobs: BlobBackendConfig::Local { data_root },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: default_backup_budget(),
    };

    let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open runtime");
    let epoch = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x41),
            incarnation: sample_incarnation(0x41),
            root_folder_id: sample_folder_id(0x41),
            slug: "wal-overlap-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: sample_principal_id(0x41),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space");

    let stop_readers = Arc::new(AtomicBool::new(false));
    let completed_reads = Arc::new(AtomicUsize::new(0));
    let mut reader_handles = Vec::new();

    // Launch 6 continuous overlapping readers so without reader-gate admission control,
    // overlapping snapshots would continuously prevent WAL frame-0 reset.
    for reader_idx in 0..6usize {
        let store_cl = store.clone();
        let stop_cl = Arc::clone(&stop_readers);
        let reads_cl = Arc::clone(&completed_reads);
        let sid = space.scope.space_id.clone();
        reader_handles.push(tokio::spawn(async move {
            let stagger = Duration::from_millis((reader_idx as u64) % 3);
            if !stagger.is_zero() {
                tokio::time::sleep(stagger).await;
            }
            while !stop_cl.load(Ordering::Relaxed) {
                let rec = store_cl
                    .get_space(&sid)
                    .await
                    .expect("ordinary overlapping read should succeed");
                assert_eq!(rec.scope.space_id, sid);
                reads_cl.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        }));
    }

    // Drive 80 folder creations + blob reference claims to push WAL well past 64 KiB watermark.
    let actor = sample_principal_id(0x41);
    for i in 0..80u32 {
        let mut fid_bytes = [0u8; 16];
        fid_bytes[0] = 0x41;
        fid_bytes[12..16].copy_from_slice(&i.to_be_bytes());
        let fid = FolderId::from_bytes(fid_bytes);
        let display = format!("Folder-{i:04}-{}", "x".repeat(512));
        store
            .create_folder(CreateFolderSpec {
                scope: space.scope.clone(),
                active_epoch: epoch,
                folder_id: fid,
                parent: None,
                slug: format!("folder-{i:04}"),
                display_name: display,
                is_project: false,
                project_slug: None,
                actor: actor.clone(),
                timestamp: None,
            })
            .await
            .expect("create folder under overlapping read load");
    }

    // Give background maintenance a couple of 10ms ticks to execute bounded reset.
    tokio::time::sleep(Duration::from_millis(60)).await;

    stop_readers.store(true, Ordering::Relaxed);
    for h in reader_handles {
        h.await.expect("join reader task");
    }

    assert!(
        completed_reads.load(Ordering::Relaxed) > 20,
        "readers must have overlapped actively with writes"
    );

    let telemetry_mid = store.wal_telemetry().expect("sqlite wal telemetry");
    assert_eq!(
        telemetry_mid.leaked_sqlite_busy_errors, 0,
        "managed connections must leak 0 SQLITE_BUSY errors"
    );
    assert!(
        telemetry_mid.passive_checkpoints > 0,
        "background 15ms/10ms PASSIVE checkpoint loop must run"
    );
    assert!(
        telemetry_mid.reset_attempts > 0 && telemetry_mid.reset_successes > 0,
        "soft/high WAL watermark must trigger bounded reset: {telemetry_mid:?}"
    );

    // Final explicit reset after readers drained truncates WAL cleanly to 0 bytes.
    store.run_wal_maintenance_now(true).await;
    let telemetry_after = store.wal_telemetry().expect("sqlite wal telemetry");
    assert_eq!(telemetry_after.active_readers, 0);
    assert_eq!(telemetry_after.leaked_sqlite_busy_errors, 0);
    let disk_wal_len = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
    assert_eq!(
        disk_wal_len, 0,
        "PRAGMA wal_checkpoint(TRUNCATE) must truncate WAL to 0 bytes once readers drain"
    );

    runtime.shutdown().await.expect("clean shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stuck_query_is_interrupted_at_deadline_and_dropped_future_closes_worker_snapshot() {
    let temp = TempDataRoot::new("l4-wal-interrupt");
    let data_root = temp.data_root();
    let wal_path = sqlite_wal_path_for(&data_root.canonical());

    let cfg = CanonicalConfig {
        installation_id: sample_installation_id(0x42),
        sql: SqlBackendConfig::Sqlite {
            data_root: data_root.clone(),
            read_pool_size: 4,
            read_deadline: Duration::from_millis(60),
            passive_checkpoint_interval: Duration::from_millis(50),
            wal_soft_watermark_bytes: 64 * 1024 * 1024,
            wal_high_watermark_bytes: 128 * 1024 * 1024,
            wal_reset_cycle_deadline: Duration::from_millis(250),
        },
        blobs: BlobBackendConfig::Local { data_root },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: default_backup_budget(),
    };

    let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open runtime");
    let epoch = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0x42),
            incarnation: sample_incarnation(0x42),
            root_folder_id: sample_folder_id(0x42),
            slug: "wal-interrupt-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: sample_principal_id(0x42),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space");

    // 1. Deliberately stuck recursive query must be interrupted by SQLite progress handler at ~60ms (<250ms)!
    let started = Instant::now();
    let timeout_res = store
        .execute_diagnostic_read_sql_for_test(None, STUCK_RECURSIVE_SQL)
        .await;
    let elapsed = started.elapsed();

    match timeout_res {
        Err(PortError::DeadlineExceeded(failure)) => {
            assert_eq!(failure.effect(), CommitEffect::NotCommitted);
        }
        other => panic!("expected DeadlineExceeded on stuck query, got {other:?}"),
    }
    assert!(
        elapsed < Duration::from_millis(250),
        "ordinary SQLite read must be interrupted within <250ms, took {elapsed:?}"
    );

    // Wait briefly for detached background close of interrupted connection.
    let wait_start = Instant::now();
    while store.wal_telemetry().unwrap().active_readers != 0 {
        assert!(
            wait_start.elapsed() < Duration::from_millis(250),
            "interrupted reader snapshot failed to close"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(store.wal_telemetry().unwrap().timed_out_reads >= 1);

    // 2. Caller future dropped mid-flight after 15ms MUST still interrupt & close worker snapshot!
    let drop_res = tokio::time::timeout(
        Duration::from_millis(15),
        store.execute_diagnostic_read_sql_for_test(None, STUCK_RECURSIVE_SQL),
    )
    .await;
    assert!(drop_res.is_err(), "outer 15ms timeout should drop future");

    let wait_drop = Instant::now();
    while store.wal_telemetry().unwrap().active_readers != 0 {
        assert!(
            wait_drop.elapsed() < Duration::from_millis(250),
            "dropped caller future left SQLite worker snapshot open!"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let tel = store.wal_telemetry().unwrap();
    assert!(
        tel.cancelled_or_dropped_reads >= 1,
        "dropped reader must be counted and detached: {tel:?}"
    );

    // 3. Cancellation via CallBudget::cancellation must return PortError::Cancelled(NotCommitted).
    let cancel = Cancellation::default();
    let cancel_cl = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel_cl.cancel();
    });
    let cancel_budget = CallBudget {
        request: RequestId::from_bytes(random_bytes_16()),
        cancellation: cancel,
        remaining: Duration::from_millis(200),
    };
    let cancel_res = store
        .execute_diagnostic_read_sql_for_test(Some(&cancel_budget), STUCK_RECURSIVE_SQL)
        .await;
    match cancel_res {
        Err(PortError::Cancelled(failure)) => {
            assert_eq!(failure.effect(), CommitEffect::NotCommitted);
        }
        other => panic!("expected Cancelled on cancelled query, got {other:?}"),
    }

    let wait_cancel = Instant::now();
    while store.wal_telemetry().unwrap().active_readers != 0 {
        assert!(wait_cancel.elapsed() < Duration::from_millis(250));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // 4. Prove NO phantom WAL read mark remains from any timed-out, dropped, or cancelled reader:
    // write a new transaction and run `TRUNCATE` -> WAL file size MUST become 0!
    store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: epoch,
            folder_id: FolderId::from_bytes([0x99; 16]),
            parent: None,
            slug: "post-drop-folder".to_owned(),
            display_name: "Post Drop".to_owned(),
            is_project: false,
            project_slug: None,
            actor: sample_principal_id(0x42),
            timestamp: None,
        })
        .await
        .expect("write after dropped/cancelled reads");

    store.run_wal_maintenance_now(true).await;
    let final_wal_len = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
    assert_eq!(
        final_wal_len, 0,
        "dropped/cancelled SQLite read snapshots must be fully closed so TRUNCATE zeroes the WAL"
    );

    // Snapshot-free local CAS blob staging works independently without touching SQLite read snapshots.
    let prep = store.prepare_blob(b"cas-only").expect("prepare CAS blob");
    let staged: notarium_canonical::blobs::StagedBlobTicket = store
        .stage_blob(&space.scope, LeaseEpoch::new(1).unwrap(), &prep)
        .await
        .expect("stage CAS blob");
    assert_eq!(staged.raw_size(), 8);

    runtime.shutdown().await.expect("clean shutdown");
}
