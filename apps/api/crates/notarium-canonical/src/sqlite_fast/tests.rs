use super::*;
use crate::{CanonicalConfig, CanonicalRuntime};
use notarium_core::{
    epoch::DataRoot,
    ids::{InstallationId, RequestId},
    ports::Cancellation,
};
use std::sync::mpsc;
use tokio::sync::oneshot;

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
