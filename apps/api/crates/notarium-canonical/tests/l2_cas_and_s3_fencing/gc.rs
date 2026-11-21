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
async fn a_mature_backlog_keeps_physical_retirements_bounded() {
    let root = TempDataRoot::new("gc-bounded");
    let config = CanonicalConfig::local_default(sample_installation_id(46), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let (scope, epoch) = init_test_space(&store, 46).await;
    let mut paths = Vec::new();
    let mut blockers = Vec::new();
    for n in 0..(3 * MAX_GC_RETIREMENTS) {
        let digest = orphan(&store, &scope, epoch, u8::try_from(n).unwrap())
            .await
            .digest();
        paths.push(root.data_root().blob(&scope.space_id, digest));
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
        blockers.push(blocker);
    }
    mature(&store).await;
    store
        .advance_space_lease(&maintenance_ctx(ServicePurpose::Revocation), &scope, epoch)
        .await
        .unwrap();
    assert_eq!(store.active_retirement_workers_for_test(), 0);
    assert!(paths.iter().all(|path| path.is_file()));
    let budget = maintenance_ctx(ServicePurpose::Backup).budget;
    let page = store
        .sweep_blob_gc(&budget, &scope, epoch, None)
        .await
        .unwrap();
    assert_eq!(page.retirements, MAX_GC_RETIREMENTS);
    assert_eq!(
        store.active_retirement_workers_for_test(),
        MAX_GC_RETIREMENTS
    );
    assert_eq!(
        store
            .sweep_blob_gc(&budget, &scope, epoch, None)
            .await
            .unwrap()
            .retirements,
        0
    );
    for blocker in blockers {
        std::fs::remove_dir(blocker).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while paths.iter().any(|path| path.exists()) || !store.storage_cleanup_idle_for_test() {
            store
                .sweep_blob_gc(&budget, &scope, epoch, None)
                .await
                .unwrap();
            assert!(store.active_retirement_workers_for_test() <= MAX_GC_RETIREMENTS);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the durable backlog must drain after the filesystem is repaired");
    runtime.shutdown().await.unwrap();
}
