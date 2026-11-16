//! Reproducible control-only pause measurements; not a paired-store SLO claim.
use super::{tests::*, *};
use std::sync::atomic::{AtomicBool, Ordering};

fn distribution(mut samples: Vec<u64>) -> serde_json::Value {
    samples.sort_unstable();
    let percentile = |percent: usize| samples[(samples.len() * percent).div_ceil(100) - 1];
    serde_json::json!({"p50":percentile(50),"p95":percentile(95),"p99":percentile(99),"max":samples.last()})
}
async fn measure(pg: bool, count: usize) {
    let (fixture, participant, data) = fixture(pg, "backup_latency").await;
    let stopped = Arc::new(AtomicBool::new(false));
    let stop_writer = stopped.clone();
    let store = fixture.store.clone();
    let writer = tokio::spawn(async move {
        let mut commits = 0u64;
        while !stop_writer.load(Ordering::SeqCst) {
            update(store.clone(), &format!("concurrent-{commits}")).await;
            commits += 1;
            tokio::task::yield_now().await;
        }
        commits
    });
    let mut samples = Vec::with_capacity(count);
    let began = std::time::Instant::now();
    // Initial cache warmup is explicit and excluded from the reported samples.
    for index in 0..count + 10 {
        let mut entropy = [0u8; 16];
        entropy[..8].copy_from_slice(&(index as u64).to_le_bytes());
        let limits = participant.default_budget();
        let mut prepared = participant
            .prepare(
                context(ServicePurpose::Backup),
                BackupId::from_bytes(entropy),
                limits,
            )
            .await
            .unwrap();
        let hold = prepared.acquire_hold().await.unwrap();
        let mut pause = prepared.pause_writes().await.unwrap();
        let mut snapshot = pause.open_cut().await.unwrap();
        pause.resume().await.unwrap();
        let receipt = snapshot
            .spool(limits, Cancellation::default())
            .await
            .unwrap();
        snapshot.close().await.unwrap();
        drop(prepared);
        hold.release().await.unwrap();
        let metrics = participant.last_metrics().unwrap();
        assert_eq!(metrics.bytes, receipt.bytes);
        assert!(metrics.drain <= metrics.pause);
        if index >= 10 {
            samples.push(serde_json::json!({
                "prepare_us":metrics.prepare.as_micros(),"drain_us":metrics.drain.as_micros(),
                "pause_us":metrics.pause.as_micros(),"spool_us":metrics.spool.as_micros(),"bytes":metrics.bytes,
            }));
        }
        // This fixture is the packaging consumer and owns the accepted artifacts.
        // Removing them keeps repeated measurements from accumulating payloads.
        for suffix in ["data", "ready"] {
            std::fs::remove_file(
                data.staging()
                    .join("control")
                    .join(format!("{}.{suffix}", receipt.artifact)),
            )
            .unwrap();
        }
    }
    stopped.store(true, Ordering::SeqCst);
    let commits = writer.await.unwrap();
    assert!(
        commits >= count as u64,
        "the writer must run throughout sampling"
    );
    let mut summary = serde_json::json!({
        "profile":if pg {"PostgreSQL 16 isolated local Unix socket"} else {"warm local SQLite WAL"},
        "samples":count,"warmup":10,"concurrent_writer_commits":commits,
        "elapsed_ms":began.elapsed().as_millis(),"paired_store_measurement":false,
    });
    for metric in ["prepare_us", "drain_us", "pause_us", "spool_us", "bytes"] {
        summary[metric] = distribution(
            samples
                .iter()
                .map(|sample| sample[metric].as_u64().unwrap())
                .collect(),
        );
    }
    let artifact = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap()).join(format!(
        "backup-latency-{}.json",
        if pg { "postgres" } else { "sqlite" }
    ));
    std::fs::write(
        &artifact,
        serde_json::to_vec_pretty(&serde_json::json!({"summary":summary,"samples":samples}))
            .unwrap(),
    )
    .unwrap();
    println!("backup-latency {summary}");
    drop(participant);
    fixture.close().await;
    if pg {
        std::fs::remove_dir_all(data.root()).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_pause_with_concurrent_writers_1000_samples() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    measure(false, 1000).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_pause_with_concurrent_writers_100_samples() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    measure(true, 100).await;
}
