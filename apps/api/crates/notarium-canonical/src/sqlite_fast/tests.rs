use super::*;
use crate::{CanonicalConfig, CanonicalRuntime};
use notarium_core::{
    epoch::DataRoot,
    ids::{InstallationId, RequestId},
    ports::Cancellation,
};
use std::sync::mpsc;
use tokio::sync::oneshot;

#[tokio::test]
async fn native_rollback_checks_the_lease_before_publishing_sql_and_room_state() {
    struct Lease(bool);
    impl RevocationLease for Lease {
        fn check(&self) -> Result<(), PortError> {
            if self.0 {
                Ok(())
            } else {
                Err(deadline_not_committed("test_expired", "test lease expired"))
            }
        }
    }

    let (store, runtime, _, path) = fixture().await;
    for admitted in [false, true] {
        let conn = open_rusqlite_writer_connection(&path.join("v1/canonical.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TEMP TABLE changes (n INTEGER); BEGIN IMMEDIATE; INSERT INTO changes VALUES (1)",
        )
        .unwrap();
        let published = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let room_state = published.clone();
        let committed = Arc::new(AtomicBool::new(false));
        let result = finish_fast_sql_stage(
            &conn,
            BTreeMap::new(),
            PendingDirSyncs::default(),
            Vec::new(),
            Vec::new(),
            vec![CommitAction::ConfirmedOrUnknown(Box::new(move || {
                room_state.store(true, Ordering::SeqCst);
            }))],
            Arc::clone(&committed),
            Vec::new(),
            None,
            &store.inner,
            false,
            Some(&Lease(admitted)),
            false,
        );
        assert!(match result {
            FastSqlStageResult::CommittedDirectly { .. } => admitted,
            FastSqlStageResult::AbortedBeforeCommit(PortError::DeadlineExceeded(_)) => !admitted,
            _ => false,
        });
        assert!(conn.is_autocommit());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM changes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, i64::from(admitted));
        assert_eq!(published.load(Ordering::SeqCst), admitted);
        assert_eq!(committed.load(Ordering::Acquire), admitted);
    }
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

async fn fixture() -> (
    CanonicalStore,
    CanonicalRuntime,
    SqliteFastReadPool,
    PathBuf,
) {
    let mut id = [0; 16];
    getrandom::fill(&mut id).unwrap();
    let path = std::env::temp_dir().join(format!("notarium-native-read-{}", hex::encode(id)));
    std::fs::create_dir_all(&path).unwrap();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(id), DataRoot::new(&path));
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let pool = SqliteFastReadPool::new(
        path.join("v1/canonical.sqlite"),
        vec![rusqlite::Connection::open_in_memory().unwrap()],
    );
    (store, runtime, pool, path)
}

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([71; 16]),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(10),
    }
}

#[tokio::test]
async fn edit_preparation_restarts_one_expired_snapshot_within_the_original_budget() {
    let budget = budget();
    let deadline = CommandDeadline::start(&budget, "edit_note");
    let attempts = std::cell::Cell::new(0);
    let (store, runtime, pool, path) = fixture().await;
    let wal = store.inner.wal_coord.get().unwrap();
    let result = deadline.prepare_read(&budget, || async {
        attempts.set(attempts.get() + 1);
        let mut current = budget.clone();
        current.remaining = deadline.remaining(&budget)?;
        let expire = attempts.get() == 1;
        pool.with_read_conn(wal, Some(&current), move |conn| {
            if expire {
                // This read runs until the ordinary SQLite VM progress deadline.
                conn.query_row("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n) SELECT sum(i) FROM n", [], |row| row.get::<_, i64>(0))
            } else {
                conn.query_row("SELECT 17", [], |row| row.get::<_, i64>(0))
            }
            .map_err(|err| map_interrupt_or_internal(err, "edit_preparation_read"))
        })
        .await
    })
    .await;
    assert_eq!(result.unwrap(), 17);
    assert_eq!(attempts.get(), 2);
    assert_eq!(wal.telemetry().timed_out_reads, 1);
    assert_eq!(wal.telemetry().active_readers, 0);
    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn edit_preparation_preserves_terminal_errors_and_limits_attempts() {
    for mode in ["repeated_timeout", "domain_error", "cancelled", "expired"] {
        let mut budget = budget();
        if mode == "expired" {
            budget.remaining = Duration::ZERO;
        }
        let deadline = CommandDeadline::start(&budget, "edit_note");
        let attempts = std::cell::Cell::new(0);
        let result: Result<(), _> = deadline
            .prepare_read(&budget, || async {
                attempts.set(attempts.get() + 1);
                if mode == "domain_error" {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if mode == "cancelled" {
                    budget.cancellation.cancel();
                }
                Err(deadline_not_committed(
                    "test_read_timeout",
                    "snapshot expired",
                ))
            })
            .await;
        match mode {
            "repeated_timeout" => {
                assert!(matches!(result, Err(PortError::DeadlineExceeded(_))));
                assert_eq!(attempts.get(), 2);
            }
            "domain_error" => {
                assert!(matches!(
                    result,
                    Err(PortError::Domain(DomainError::ResourceNotFound))
                ));
                assert_eq!(attempts.get(), 1);
            }
            "cancelled" => {
                assert!(matches!(result, Err(PortError::Cancelled(_))));
                assert_eq!(attempts.get(), 1);
            }
            "expired" => {
                assert!(matches!(result, Err(PortError::DeadlineExceeded(_))));
                assert_eq!(attempts.get(), 0);
            }
            _ => unreachable!(),
        }
    }
}

#[tokio::test]
async fn cancelled_post_cannot_interrupt_the_next_checkout() {
    let (store, runtime, pool, path) = fixture().await;
    let wal = store.inner.wal_coord.get().unwrap();
    let first_budget = budget();
    let next_budget = budget();
    let (entered_post, post_started) = oneshot::channel();
    let (end_post, await_end_post) = mpsc::channel();
    let (entered_next_vm, next_vm_started) = oneshot::channel();
    let (resume_vm, await_resume_vm) = mpsc::channel();

    let first = pool.with_read_conn_and_post(
        wal,
        Some(&first_budget),
        true,
        |_| Ok(()),
        move |_| {
            entered_post.send(()).unwrap();
            await_end_post.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        },
    );
    let next = async {
        post_started.await.unwrap();
        assert_eq!(wal.telemetry().active_readers, 0);
        let result = pool
            .with_read_conn(wal, Some(&next_budget), move |conn| {
                let mut entered_next_vm = Some(entered_next_vm);
                conn.progress_handler(
                    1,
                    Some(move || {
                        if let Some(sender) = entered_next_vm.take() {
                            sender.send(()).unwrap();
                            await_resume_vm
                                .recv_timeout(Duration::from_secs(5))
                                .unwrap();
                        }
                        false
                    }),
                )
                .unwrap();
                conn.query_row("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 32) SELECT sum(i) FROM n", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|err| map_interrupt_or_internal(err, "next_checkout"))
            })
            .await;
        end_post.send(()).unwrap();
        result
    };
    let cancel = async {
        next_vm_started.await.unwrap();
        first_budget.cancellation.cancel();
    };
    let release_next_vm = async {
        let (result, ()) = tokio::join!(first, cancel);
        assert!(matches!(result, Err(PortError::Cancelled(_))));
        resume_vm.send(()).unwrap();
    };
    let ((), result) = tokio::join!(release_next_vm, next);
    assert_eq!(result.unwrap(), 528);

    runtime.shutdown().await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn worker_queue_and_post_use_the_caller_deadline() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    rt.block_on(async {
        let (store, runtime, pool, path) = fixture().await;
        let wal = store.inner.wal_coord.get().unwrap();
        let budget = budget();
        let pause = wal.read_deadline() + Duration::from_millis(25);
        let (queued, ready) = oneshot::channel();
        let (unblock_worker, resume_worker) = mpsc::channel();
        let occupied = tokio::task::spawn_blocking(move || {
            queued.send(()).unwrap();
            resume_worker.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        ready.await.unwrap();

        let (post_entered, in_post) = oneshot::channel();
        let (finish_post, resume_post) = mpsc::channel();
        let read = pool.with_read_conn_and_post(
            wal,
            Some(&budget),
            true,
            |conn| {
                conn.query_row("SELECT 17", [], |row| row.get::<_, i64>(0))
                    .map_err(|err| map_interrupt_or_internal(err, "queued_read"))
            },
            move |val| {
                post_entered.send(()).unwrap();
                resume_post.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(val)
            },
        );
        let drive = async {
            tokio::time::sleep(pause).await;
            unblock_worker.send(()).unwrap();
            in_post.await.unwrap();
            assert_eq!(wal.telemetry().active_readers, 0);
            tokio::time::sleep(pause).await;
            finish_post.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(read, drive);
        assert_eq!(result.unwrap(), 17);
        occupied.await.unwrap();

        let mut short_budget = budget.clone();
        short_budget.remaining = pause;
        let (post_entered, in_post) = oneshot::channel();
        let (finish_post, resume_post) = mpsc::channel();
        let read = pool.with_read_conn_and_post(
            wal,
            Some(&short_budget),
            true,
            |_| Ok(()),
            move |_| {
                post_entered.send(()).unwrap();
                resume_post.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            },
        );
        let (result, ()) = tokio::join!(read, async { in_post.await.unwrap() });
        assert!(matches!(result, Err(PortError::DeadlineExceeded(_))));
        assert_eq!(wal.telemetry().active_readers, 0);
        finish_post.send(()).unwrap();

        // A live snapshot still expires while the SQL body owns it.
        let (started, in_sql) = oneshot::channel();
        let (release_sql, finish_sql) = mpsc::channel();
        let read = pool.with_read_conn(wal, Some(&budget), move |conn| {
            conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
            started.send(()).unwrap();
            finish_sql.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        });
        let bounded = async {
            in_sql.await.unwrap();
            tokio::time::sleep(pause).await;
        };
        let (result, ()) = tokio::join!(read, bounded);
        assert!(matches!(result, Err(PortError::DeadlineExceeded(_))));
        release_sql.send(()).unwrap();
        pool.with_read_conn(wal, Some(&budget), |_| Ok(()))
            .await
            .unwrap();

        runtime.shutdown().await.unwrap();
        std::fs::remove_dir_all(path).unwrap();
    });
}

#[test]
fn native_sqlite_checkout_finishes_before_owner_handoff() {
    use tokio::runtime::Builder;

    let owner = Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let client = Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let (store, runtime, _, path) = owner.block_on(fixture());
    let SqlDriverState::Sqlite { fast_read_pool, .. } = &store.inner.sql else {
        unreachable!()
    };
    let wal = store.inner.wal_coord.get().unwrap();
    let (occupied, ready) = mpsc::channel();
    let (resume_client, blocked_client) = mpsc::channel();
    let client_worker = client.spawn_blocking(move || {
        occupied.send(()).unwrap();
        let _ = blocked_client.recv_timeout(Duration::from_secs(10));
    });
    ready.recv_timeout(Duration::from_secs(2)).unwrap();

    let (started, reading) = mpsc::channel();
    let (finish, finish_read) = mpsc::channel();
    let mut read = Box::pin(fast_read_pool.with_read_conn(wal, None, move |conn| {
        let count = conn
            .query_row("SELECT count(*) FROM schema_meta", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        started.send(count).unwrap();
        let _ = finish_read.recv_timeout(Duration::from_secs(5));
        Ok(count)
    }));
    client.block_on(async {
        tokio::select! {
            biased;
            result = &mut read => panic!("read returned before release: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
    });
    assert_eq!(
        reading
            .recv_timeout(Duration::from_secs(2))
            .expect("a native checkout must progress on the storage executor"),
        1
    );
    let stopping = owner.spawn(runtime.shutdown());
    owner.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !fast_read_pool.sem.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shutdown must close native admission");
    });
    assert!(!stopping.is_finished());
    assert!(
        owner
            .block_on(CanonicalRuntime::open(store.inner.config.clone()))
            .is_err()
    );
    finish.send(()).unwrap();
    owner.block_on(stopping).unwrap().unwrap();
    assert_eq!(wal.telemetry().active_readers, 0);
    assert!(matches!(
        client.block_on(read),
        Ok(1) | Err(PortError::DeadlineExceeded(_))
    ));
    resume_client.send(()).unwrap();
    client.block_on(client_worker).unwrap();

    let (_next, runtime) = owner
        .block_on(CanonicalRuntime::open(store.inner.config.clone()))
        .unwrap();
    assert!(matches!(
        owner.block_on(fast_read_pool.with_read_conn(wal, None, |_| Ok(()))),
        Err(PortError::Unavailable(_))
    ));
    owner.block_on(runtime.shutdown()).unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn native_sqlite_shutdown_releases_waiters_without_a_checkout() {
    let (store, runtime, _, path) = fixture().await;
    let SqlDriverState::Sqlite { fast_read_pool, .. } = &store.inner.sql else {
        unreachable!()
    };
    let wal = store.inner.wal_coord.get().unwrap();
    let reserved = fast_read_pool.hold_idle_slots();
    let mut read = Box::pin(fast_read_pool.with_read_conn(wal, None, |_| Ok(())));
    tokio::select! {
        biased;
        result = &mut read => panic!("read returned before checkout: {result:?}"),
        () = tokio::task::yield_now() => {}
    }
    assert_eq!(wal.telemetry().active_readers, 1);
    tokio::time::timeout(Duration::from_secs(2), runtime.shutdown())
        .await
        .expect("a parked client does not own a SQLite connection")
        .unwrap();
    drop(reserved);
    assert!(matches!(read.await, Err(PortError::Unavailable(_))));
    assert_eq!(wal.telemetry().active_readers, 0);
    std::fs::remove_dir_all(path).unwrap();
}
