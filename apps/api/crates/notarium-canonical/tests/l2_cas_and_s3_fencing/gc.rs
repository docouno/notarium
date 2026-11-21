use super::*;
use notarium_canonical::blobs::{PreparedBlobSource, StagedBlobTicket, gc::MAX_GC_RETIREMENTS};
use notarium_core::error::CommitEffect;
use std::time::Duration;

async fn bind(
    store: &CanonicalStore,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    owner: &NoteId,
    ticket: StagedBlobTicket,
) {
    store
        .commit_blob_reference_claim(
            scope,
            epoch,
            BlobReferenceClaim {
                owner_kind: BlobOwnerKind::NoteRevision,
                owner_id: owner.to_string(),
                owner_rev_id: "rev".into(),
                resource_key: "carrier".into(),
                ticket,
            },
            None,
            None,
        )
        .await
        .unwrap();
}

async fn orphan(
    store: &CanonicalStore,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    seed: u8,
) -> PreparedBlobSource {
    let owner = NoteId::from_bytes([seed; 16]);
    let prepared = store.prepare_blob(&[seed; 512]).unwrap();
    let ticket = store.stage_blob(scope, epoch, &prepared).await.unwrap();
    bind(store, scope, epoch, &owner, ticket).await;
    store
        .release_blob_owner_references(scope, epoch, BlobOwnerKind::NoteRevision, owner.as_str())
        .await
        .unwrap();
    prepared
}

async fn mature(store: &CanonicalStore) {
    store
        .execute_diagnostic_write_sql_for_test(
            "UPDATE blob_catalog SET quarantined_at_ms=0 WHERE ref_count=0",
        )
        .await
        .unwrap();
}

fn block_cleanup(
    root: &TempDataRoot,
    scope: &HistoryScope,
    digest: notarium_core::ids::ContentDigest,
) -> std::path::PathBuf {
    let blocker = root
        .data_root()
        .root()
        .join("blobs/.quarantine")
        .join(format!(
            "{}.{}.corrupt",
            scope.space_id.as_str(),
            digest.to_hex()
        ));
    std::fs::create_dir_all(&blocker).unwrap();
    blocker
}

#[tokio::test]
async fn replayed_lease_keeps_a_current_epoch_local_ticket_admissible() {
    let root = TempDataRoot::new("gc-replay-ticket");
    let config = CanonicalConfig::local_default(sample_installation_id(44), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let (scope, epoch) = init_test_space(&store, 44).await;
    let prepared = orphan(&store, &scope, epoch, 40).await;
    store
        .mark_legacy_blob_cleanup(&scope, epoch, prepared.digest())
        .await
        .unwrap();
    let ticket = store.stage_blob(&scope, epoch, &prepared).await.unwrap();
    let mut ctx = maintenance_ctx(ServicePurpose::Revocation);
    ctx.budget.remaining = Duration::from_secs(1);
    assert_eq!(
        store
            .advance_space_lease(&ctx, &scope, epoch)
            .await
            .unwrap(),
        epoch
    );
    bind(&store, &scope, epoch, &NoteId::from_bytes([41; 16]), ticket).await;
    assert_eq!(
        store
            .read_verified_blob(&scope, prepared.digest())
            .await
            .unwrap(),
        [40; 512]
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn postgres_gc_owns_a_retirement_after_losing_the_commit_acknowledgement() {
    let fixtures = StorageTestFixtures::load_required();
    let root = TempDataRoot::new("gc-commit-ack");
    let schema = fixtures.fresh_pg_schema();
    let config = fixtures.pg_local_config(sample_installation_id(45), &schema, root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let (scope, epoch) = init_test_space(&store, 45).await;
    let prepared = orphan(&store, &scope, epoch, 42).await;
    let blocker = block_cleanup(&root, &scope, prepared.digest());
    mature(&store).await;
    store
        .writer_faults()
        .unwrap()
        .drop_auxiliary_commit_response_once
        .store(true, Ordering::SeqCst);
    let page = store
        .sweep_blob_gc(
            &maintenance_ctx(ServicePurpose::Backup).budget,
            &scope,
            epoch,
            None,
        )
        .await
        .unwrap();
    assert!(
        matches!(page.failure, Some(PortError::Internal(e)) if e.effect() == CommitEffect::Unknown)
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while store
            .execute_diagnostic_read_sql_for_test(
                None,
                "SELECT count(*) FROM blob_gc_retries WHERE backoff_ms>250",
            )
            .await
            .unwrap()
            == 0
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("lost acknowledgement must hand physical retry to the durable queue");
    std::fs::remove_dir(blocker).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .data_root()
            .blob(&scope.space_id, prepared.digest())
            .exists()
            || !store.storage_cleanup_idle_for_test()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the committed retirement must finish without a restart or lease change");
    let ticket = store.stage_blob(&scope, epoch, &prepared).await.unwrap();
    bind(&store, &scope, epoch, &NoteId::from_bytes([43; 16]), ticket).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn failing_retirements_release_capacity_for_other_spaces_and_recover_after_restart() {
    let root = TempDataRoot::new("gc-bounded");
    let config = CanonicalConfig::local_default(sample_installation_id(46), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let (scope, epoch) = init_test_space(&store, 46).await;
    let (healthy, healthy_epoch) = init_test_space(&store, 47).await;
    let observer = rusqlite::Connection::open(root.data_root().canonical()).unwrap();
    let count = |sql| {
        let rows: i64 = observer.query_row(sql, [], |row| row.get(0)).unwrap();
        usize::try_from(rows).unwrap()
    };
    let mut blockers = Vec::new();
    for n in 0..MAX_GC_RETIREMENTS {
        let digest = orphan(&store, &scope, epoch, u8::try_from(n).unwrap())
            .await
            .digest();
        blockers.push(block_cleanup(&root, &scope, digest));
    }
    let intermittent = orphan(&store, &healthy, healthy_epoch, 99).await.digest();
    let repaired_first = block_cleanup(&root, &healthy, intermittent);
    let mut healthy_paths = vec![root.data_root().blob(&healthy.space_id, intermittent)];
    for n in 0..(2 * MAX_GC_RETIREMENTS) {
        let digest = orphan(&store, &healthy, healthy_epoch, u8::try_from(n).unwrap())
            .await
            .digest();
        healthy_paths.push(root.data_root().blob(&healthy.space_id, digest));
    }
    mature(&store).await;
    let budget = maintenance_ctx(ServicePurpose::Backup).budget;
    store
        .advance_space_lease(&maintenance_ctx(ServicePurpose::Revocation), &scope, epoch)
        .await
        .unwrap();
    assert_eq!(store.active_retirement_workers_for_test(), 0);
    assert!(healthy_paths.iter().all(|path| path.is_file()));

    const BACKOFF: &str = "SELECT COUNT(*) FROM blob_gc_retries WHERE backoff_ms>250";
    tokio::time::timeout(Duration::from_secs(10), async {
        // Wait for all four independent physical attempts to fail while the blockers remain.
        while count(BACKOFF) != MAX_GC_RETIREMENTS {
            store
                .sweep_blob_gc(&budget, &scope, epoch, None)
                .await
                .unwrap();
            assert!(store.active_retirement_workers_for_test() <= MAX_GC_RETIREMENTS);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        while count(BACKOFF) != MAX_GC_RETIREMENTS + 1 {
            store
                .sweep_blob_gc(&budget, &healthy, healthy_epoch, None)
                .await
                .unwrap();
            assert!(store.active_retirement_workers_for_test() <= MAX_GC_RETIREMENTS);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        std::fs::remove_dir(repaired_first).unwrap();
        while healthy_paths.iter().any(|path| path.exists())
            || count("SELECT COUNT(*) FROM blob_retirements WHERE status='completed'")
                != healthy_paths.len()
        {
            store
                .sweep_blob_gc(&budget, &healthy, healthy_epoch, None)
                .await
                .unwrap();
            assert!(store.active_retirement_workers_for_test() <= MAX_GC_RETIREMENTS);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("unrelated healthy retirements must finish with all four blockers still present");
    assert_eq!(
        count("SELECT COUNT(*) FROM blob_gc_retries"),
        MAX_GC_RETIREMENTS
    );
    runtime.shutdown().await.unwrap();
    drop(store);

    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    store
        .advance_space_lease(&maintenance_ctx(ServicePurpose::Revocation), &scope, epoch)
        .await
        .unwrap();
    assert_eq!(
        count("SELECT COUNT(*) FROM blob_gc_retries"),
        MAX_GC_RETIREMENTS
    );
    for blocker in blockers {
        std::fs::remove_dir(blocker).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while count("SELECT COUNT(*) FROM blob_retirements WHERE status='pending'") != 0
            || !store.storage_cleanup_idle_for_test()
        {
            assert!(store.active_retirement_workers_for_test() <= MAX_GC_RETIREMENTS);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("durable retries must drain after repair without another sweep or epoch change");
    assert_eq!(count("SELECT COUNT(*) FROM blob_gc_retries"), 0);
    runtime.shutdown().await.unwrap();
}
