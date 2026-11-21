use super::*;
use notarium_canonical::{ArchiveJobClass, peers::archive_import::ArchiveCommitAuthority};
use notarium_core::ports::RevocationLease;
use std::sync::{atomic::AtomicUsize, mpsc};
use tokio::sync::Notify;

struct HoldFinalCheck {
    calls: AtomicUsize,
    entered: Arc<Notify>,
    release: mpsc::Receiver<()>,
}

impl RevocationLease for HoldFinalCheck {
    fn check(&self) -> Result<(), PortError> {
        // The first check admits the mutation. Hold the final check until the
        // independent reader observes expiry on the backend's own clock.
        if self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
            self.entered.notify_one();
            tokio::task::block_in_place(|| self.release.recv_timeout(Duration::from_secs(10)))
                .unwrap();
        }
        Ok(())
    }
}

struct LiveRegistration;

impl RevocationLease for LiveRegistration {
    fn check(&self) -> Result<(), PortError> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn archive_commit_rechecks_the_original_lease_at_admission() {
    let fixtures = StorageTestFixtures::load_required();
    let local = TempDataRoot::new("archive-commit-lease");
    let pg_root = TempDataRoot::new("archive-commit-lease-pg");
    let schema = fixtures.fresh_pg_schema();
    let installation = sample_installation_id(239);
    let sqlite = CanonicalConfig::local_default(installation.clone(), local.data_root());
    let pg = fixtures.pg_local_config(installation, &schema, pg_root.data_root());
    for (config, mut pg_clock) in [(sqlite, None), (pg, Some(fixtures.open_raw_pg().await))] {
        let backend = if pg_clock.is_some() {
            "PostgreSQL"
        } else {
            "SQLite"
        };
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let owner = sample_principal_id(239);
        let scope = store
            .create_space(CreateSpaceSpec {
                space_id: sample_space_id(239),
                incarnation: sample_incarnation(239),
                root_folder_id: sample_folder_id(239),
                slug: "original-lease".into(),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap()
            .scope;
        let ctx = || owner_ctx(&scope, owner.clone());
        let enqueue = async || {
            store
                .create_job(
                    ctx(),
                    next_mutation(
                        &scope,
                        &owner,
                        ContentJobKind::ExportSpace { encrypted: false },
                    ),
                )
                .await
                .unwrap()
                .value
        };
        let claim = async |duration| {
            store
                .claim_next_archive_job(
                    &make_budget(),
                    &scope,
                    "worker",
                    duration,
                    ArchiveJobClass::Export,
                )
                .await
                .unwrap()
                .unwrap()
        };
        let mut db_clock = async || {
            match &mut pg_clock {
                Some(conn) => sqlx::query_scalar::<_, i64>(
                    "SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint",
                )
                .fetch_one(conn)
                .await
                .unwrap(),
                // Local job leases use the process wall clock.
                None => notarium_canonical::codec::now_unix_ms().unwrap(),
            }
        };
        let failure = ContentDigest::from_bytes([239; 32]);
        let succeeded = || JobCompletionOutcome::Succeeded {
            completed_units: 1,
            total_units: Some(1),
            artifacts: Vec::new(),
            result_msgpack: None,
        };

        let job = enqueue().await;
        for heartbeat in [true, false] {
            let attempt = claim(Duration::from_secs(2)).await;
            assert_eq!(attempt.job.id, job.id);
            let cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
            let entered = Arc::new(Notify::new());
            let (release, wait) = mpsc::channel();
            let authority = ArchiveCommitAuthority::new(Box::new(HoldFinalCheck {
                calls: AtomicUsize::new(0),
                entered: entered.clone(),
                release: wait,
            }));
            let effect = async {
                if heartbeat {
                    store
                        .heartbeat_archive_job(
                            &make_budget(),
                            &scope,
                            &attempt,
                            Duration::from_secs(30),
                            (10, Some(10)),
                            authority,
                        )
                        .await
                        .map(drop)
                } else {
                    store
                        .complete_archive_job(
                            &make_budget(),
                            &scope,
                            &attempt,
                            succeeded(),
                            authority,
                        )
                        .await
                        .map(drop)
                }
            };
            let expire = async {
                tokio::time::timeout(Duration::from_secs(5), entered.notified())
                    .await
                    .unwrap();
                let now = db_clock().await;
                assert!(
                    now < attempt.lease_until_ms,
                    "the final callback started with a live lease"
                );
                tokio::time::sleep(Duration::from_millis(
                    attempt.lease_until_ms.abs_diff(now) + 2,
                ))
                .await;
                let after = db_clock().await;
                eprintln!(
                    "{backend} heartbeat={heartbeat} before_ms={now} lease_until_ms={} after_ms={after}",
                    attempt.lease_until_ms
                );
                assert!(after >= attempt.lease_until_ms);
                release.send(()).unwrap();
            };
            let (result, ()) = tokio::join!(effect, expire);
            assert_validation_err(&result, ValidationReason::InvalidAuthority);
            let current = store.get_job(ctx(), job.id.clone()).await.unwrap();
            assert_eq!(
                (current.state, current.lease, current.completed_units),
                (JobState::Running, attempt.job.lease, 0)
            );
            assert_eq!(
                store.read_space(&scope.space_id).await.unwrap().last_seq,
                cut
            );
        }

        // Failure before Control admission has no registration. Pause this
        // single writer group after its item has executed but before COMMIT.
        let short = claim(Duration::from_secs(1)).await;
        assert_eq!(short.job.id, job.id);
        let cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
        let faults = store.writer_faults().unwrap();
        faults
            .pre_commit_space_delays
            .lock()
            .await
            .insert(scope.space_id.clone(), Duration::from_millis(1200));
        let denied = store
            .fail_unadmitted_archive_job(&make_budget(), &scope, &short, failure)
            .await;
        faults
            .pre_commit_space_delays
            .lock()
            .await
            .remove(&scope.space_id);
        assert_validation_err(&denied, ValidationReason::InvalidAuthority);
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            cut
        );
        let taken = claim(Duration::from_secs(30)).await;
        assert_eq!(taken.job.id, job.id);
        assert!(taken.job.lease > short.job.lease);
        store
            .heartbeat_archive_job(
                &make_budget(),
                &scope,
                &taken,
                Duration::from_secs(30),
                (2, Some(3)),
                ArchiveCommitAuthority::new(Box::new(LiveRegistration)),
            )
            .await
            .unwrap();
        store
            .fail_unadmitted_archive_job(&make_budget(), &scope, &taken, failure)
            .await
            .unwrap();
        let denied = store.get_job(ctx(), job.id.clone()).await.unwrap();
        assert_eq!(
            (denied.state, denied.completed_units, denied.total_units),
            (JobState::Failed, 2, Some(3))
        );
        assert!(denied.artifacts.is_empty() && denied.import_diagnostic.is_none());

        let healthy = enqueue().await;
        let taken = claim(Duration::from_secs(30)).await;
        assert_eq!(taken.job.id, healthy.id);
        let completed = store
            .complete_archive_job(
                &make_budget(),
                &scope,
                &taken,
                succeeded(),
                ArchiveCommitAuthority::new(Box::new(LiveRegistration)),
            )
            .await
            .unwrap()
            .value;
        assert_eq!(completed.state, JobState::Succeeded);
        runtime.shutdown().await.unwrap();
    }
    fixtures.drop_pg_schema(&schema).await;
}
