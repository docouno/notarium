#![forbid(unsafe_code)]

mod support;

use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec, S3BucketModePolicy,
    blobs::{BlobOwnerKind, BlobReferenceClaim, s3::admin_ensure_bucket},
    codec::new_prefixed_hex_id,
    writer::{
        BatchEventDraft, CommandIdentitySpec, ItemCommitArtifacts, PreparedWriteIntent,
        SemanticCutMismatchKind,
    },
};
use notarium_core::{
    DomainError,
    auth::SpaceKind,
    error::{CommitEffect, PortError, RetryAdvice, ValidationReason},
    ids::{CommandKey, ContentDigest, LeaseEpoch, RequestId, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::{CallBudget, Cancellation, ServicePurpose},
};

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, random_bytes_16,
    sample_folder_id, sample_incarnation, sample_installation_id, sample_principal_id,
    sample_space_id,
};

fn default_budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(random_bytes_16()),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(30),
    }
}

async fn cancel_pg_write_during_begin(
    store: &CanonicalStore,
    fixtures: &StorageTestFixtures,
    schema: &str,
) {
    let pid = store
        .execute_diagnostic_read_sql_for_test(None, "SELECT pg_backend_pid()::bigint")
        .await
        .unwrap();
    let mut barrier = fixtures.open_raw_pg().await;
    sqlx::query("SELECT pg_advisory_lock(hashtextextended($1, 7311229))")
        .bind(schema)
        .execute(&mut barrier)
        .await
        .unwrap();
    let caller = store.clone();
    let task = tokio::spawn(async move {
        caller
            .execute_diagnostic_write_sql_for_test("SELECT 1")
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let blocked: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted)"
            ).bind(i32::try_from(pid).unwrap()).fetch_one(&mut barrier).await.unwrap();
            if blocked { break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("writer must reach the backup barrier inside BEGIN");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1, 7311229))")
        .bind(schema)
        .execute(&mut barrier)
        .await
        .unwrap();
    let next = store
        .execute_diagnostic_read_sql_for_test(None, "SELECT pg_backend_pid()::bigint")
        .await
        .unwrap();
    assert_ne!(
        pid, next,
        "a connection with an interrupted BEGIN must leave the pool"
    );
}

fn make_simple_intent(
    scope: HistoryScope,
    active_epoch: LeaseEpoch,
    idempotency: Option<CommandIdentitySpec>,
    required_semantic_cut: Option<(SpaceSeq, SemanticCutMismatchKind)>,
    fail_savepoint: bool,
    entity_id: &str,
) -> PreparedWriteIntent {
    let entity_id_owned = entity_id.to_owned();
    PreparedWriteIntent {
        scope,
        active_epoch,
        idempotency,
        source_note_ids: Vec::new(),
        staged_bytes: 256,
        required_semantic_cut,
        execute: Box::new(move |_tx, ctx| {
            Box::pin(async move {
                let seq = ctx.alloc_next_seq()?;
                if fail_savepoint {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let ev_rev = notarium_canonical::codec::new_revision_id()?;
                let resp = CanonicalStore::encode_command_outcome(&seq.get())?;
                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "l3_test_op".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: entity_id_owned,
                        op_kind: "edit".to_owned(),
                        rev_id: ev_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: None,
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp,
                })
            })
        }),
    }
}

async fn run_core_writer_batch_suite(store: &CanonicalStore, seed: u8) {
    let epoch = LeaseEpoch::new(1).unwrap();
    let space_rec = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed),
            incarnation: sample_incarnation(seed),
            root_folder_id: sample_folder_id(seed),
            slug: format!("l3-space-{seed}"),
            kind: SpaceKind::Personal,
            owner: sample_principal_id(seed),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space");
    let scope = space_rec.scope;
    let actor = sample_principal_id(seed);

    // 1. 64 concurrent duplicate idempotent commands -> 1 effect & 1 receipt!
    let dup_key = CommandKey::from_bytes([seed; 16]);
    let dup_hash = ContentDigest::from_bytes([seed.wrapping_add(1); 32]);
    let idemp = CommandIdentitySpec::new(actor.clone(), dup_key.clone(), dup_hash);

    let blob_raw = format!("deduped-batch-blob-{seed}").into_bytes();
    let prep = store.prepare_blob(&blob_raw).unwrap();

    let mut dup_tasks = Vec::with_capacity(64);
    for worker_idx in 0..64usize {
        let st = store.clone();
        let sc = scope.clone();
        let id_cl = idemp.clone();
        let prep_cl = prep.clone();
        dup_tasks.push(tokio::spawn(async move {
            let ticket = st.stage_blob(&sc, epoch, &prep_cl).await.unwrap();
            st.commit_blob_reference_claim(
                &sc,
                epoch,
                BlobReferenceClaim {
                    owner_kind: BlobOwnerKind::NoteRevision,
                    owner_id: notarium_core::ids::NoteId::from_bytes([seed; 16])
                        .as_str()
                        .to_owned(),
                    owner_rev_id: format!("rev_{worker_idx}"),
                    resource_key: "carrier".to_owned(),
                    ticket,
                },
                Some(id_cl),
                None,
            )
            .await
        }));
    }

    let mut committed_seqs = Vec::with_capacity(64);
    for t in dup_tasks {
        let seq = t.await.unwrap().expect("duplicate retry must succeed");
        committed_seqs.push(seq);
    }
    assert!(
        committed_seqs
            .iter()
            .all(|s| *s == SpaceSeq::new(1).unwrap()),
        "all 64 concurrent duplicates must observe SpaceSeq(1), got {:?}",
        &committed_seqs[..4]
    );
    assert_eq!(
        store.get_space(&scope.space_id).await.unwrap().last_seq,
        SpaceSeq::new(1).unwrap(),
        "64 duplicate commands must advance last_seq by exactly 1"
    );

    // 2. Same key + different command hash -> IdempotencyKeyReused!
    let mismatched_idemp = CommandIdentitySpec::new(
        actor.clone(),
        dup_key.clone(),
        ContentDigest::from_bytes([0xEE; 32]),
    );
    let hash_mismatch_res: Result<u64, PortError> = store
        .submit_fixture_write_command(
            &default_budget(),
            make_simple_intent(
                scope.clone(),
                epoch,
                Some(mismatched_idemp),
                None,
                false,
                "n_bad_hash",
            ),
        )
        .await;
    assert!(
        matches!(
            hash_mismatch_res,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ),
        "same command_key with different command_hash must return IdempotencyKeyReused, got {hash_mismatch_res:?}"
    );

    // 3. Stale HistoryIncarnation MUST fail with HistoryIncarnationMismatch BEFORE receipt lookup!
    let stale_scope = HistoryScope {
        space_id: scope.space_id.clone(),
        incarnation: sample_incarnation(seed.wrapping_add(99)),
    };
    let stale_hist_res: Result<u64, PortError> = store
        .submit_fixture_write_command(
            &default_budget(),
            make_simple_intent(
                stale_scope,
                epoch,
                Some(idemp.clone()),
                None,
                false,
                "n_stale_hist",
            ),
        )
        .await;
    assert_validation_err(
        &stale_hist_res,
        ValidationReason::HistoryIncarnationMismatch,
    );

    // 4. Intra-batch savepoint isolation + virtual `effective_cut` (both subcases)!
    // Subcase A: Hold writer safe point briefly so [succeeding Item A (1->2), pre-batch-cut Item B (expects cut=1)]
    // land in the EXACT SAME batch -> Item B must fail with CursorStale because intra-batch effective_cut became 2!
    {
        let pause_guard = store.acquire_writer_safe_point().await.unwrap();
        let st1 = store.clone();
        let sc1 = scope.clone();
        let h_a = tokio::spawn(async move {
            st1.submit_fixture_write_command::<u64>(
                &default_budget(),
                make_simple_intent(sc1, epoch, None, None, false, "intra_a"),
            )
            .await
        });
        // Small sleep ensures h_a is enqueued ahead of h_b in the FIFO channel.
        tokio::time::sleep(Duration::from_millis(2)).await;

        let st2 = store.clone();
        let sc2 = scope.clone();
        let h_b = tokio::spawn(async move {
            st2.submit_fixture_write_command::<u64>(
                &default_budget(),
                make_simple_intent(
                    sc2,
                    epoch,
                    None,
                    Some((
                        SpaceSeq::new(1).unwrap(),
                        SemanticCutMismatchKind::CursorStale,
                    )),
                    false,
                    "intra_b_stale_facts",
                ),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(3)).await;
        drop(pause_guard);

        let res_a = h_a.await.unwrap().expect("Item A succeeds at seq 2");
        assert_eq!(res_a, 2);

        let res_b = h_b.await.unwrap();
        assert_validation_err(&res_b, ValidationReason::CursorStale);
        assert_eq!(
            store.get_space(&scope.space_id).await.unwrap().last_seq,
            SpaceSeq::new(2).unwrap(),
            "failed intra-batch Item B must leave zero sequence gap"
        );
    }

    // Subcase B: Hold writer safe point so [failing savepoint Item C, pre-batch-cut Item D (expects cut=2)]
    // land in the EXACT SAME batch -> Item C rolls back savepoint & virtual range, so Item D sees effective_cut == 2
    // and succeeds at seq 3 with ZERO phantom cut and ZERO seq gap!
    {
        let pause_guard = store.acquire_writer_safe_point().await.unwrap();
        let st1 = store.clone();
        let sc1 = scope.clone();
        let h_c = tokio::spawn(async move {
            st1.submit_fixture_write_command::<u64>(
                &default_budget(),
                make_simple_intent(sc1, epoch, None, None, true, "intra_c_fails"),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(2)).await;

        let st2 = store.clone();
        let sc2 = scope.clone();
        let h_d = tokio::spawn(async move {
            st2.submit_fixture_write_command::<u64>(
                &default_budget(),
                make_simple_intent(
                    sc2,
                    epoch,
                    None,
                    Some((
                        SpaceSeq::new(2).unwrap(),
                        SemanticCutMismatchKind::CursorStale,
                    )),
                    false,
                    "intra_d_valid_after_rollback",
                ),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(3)).await;
        drop(pause_guard);

        let res_c = h_c.await.unwrap();
        assert!(matches!(
            res_c,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));

        let res_d = h_d
            .await
            .unwrap()
            .expect("Item D must succeed after Item C savepoint rollback");
        assert_eq!(res_d, 3);
        assert_eq!(
            store.get_space(&scope.space_id).await.unwrap().last_seq,
            SpaceSeq::new(3).unwrap()
        );
    }

    // 5. Unknown commit outcome (lost response after COMMIT) + idempotent replay without duplicate effect!
    let unk_idemp = CommandIdentitySpec::new(
        actor.clone(),
        CommandKey::from_bytes([seed.wrapping_add(50); 16]),
        ContentDigest::from_bytes([seed.wrapping_add(51); 32]),
    );
    store
        .writer_faults()
        .unwrap()
        .drop_commit_response_once
        .store(true, Ordering::SeqCst);

    let first_attempt: Result<u64, PortError> = store
        .submit_fixture_write_command(
            &default_budget(),
            make_simple_intent(
                scope.clone(),
                epoch,
                Some(unk_idemp.clone()),
                None,
                false,
                "unk_item",
            ),
        )
        .await;
    match first_attempt {
        Err(PortError::Unavailable(f))
            if f.effect() == CommitEffect::Unknown
                && f.retry() == RetryAdvice::RetrySameCommand => {}
        other => {
            panic!("expected Unknown commit outcome with RetrySameCommand, got {other:?}")
        }
    }

    // Retry with the exact same idempotency identity -> replays seq 4 without advancing to 5!
    let replay_seq: u64 = store
        .submit_fixture_write_command(
            &default_budget(),
            make_simple_intent(
                scope.clone(),
                epoch,
                Some(unk_idemp),
                None,
                false,
                "unk_item",
            ),
        )
        .await
        .expect("retry after Unknown commit must replay stored receipt");
    assert_eq!(replay_seq, 4);
    assert_eq!(
        store.get_space(&scope.space_id).await.unwrap().last_seq,
        SpaceSeq::new(4).unwrap(),
        "replay after Unknown commit must not create a second mutation"
    );

    // 6. Pre-admission cancellation -> NotCommitted and zero seq increment!
    let cancel = Cancellation::default();
    cancel.cancel();
    let cancelled_budget = CallBudget {
        request: RequestId::from_bytes(random_bytes_16()),
        cancellation: cancel,
        remaining: Duration::from_secs(10),
    };
    let cancel_res: Result<u64, PortError> = store
        .submit_fixture_write_command(
            &cancelled_budget,
            make_simple_intent(scope.clone(), epoch, None, None, false, "never_admitted"),
        )
        .await;
    assert!(matches!(
        cancel_res,
        Err(PortError::Cancelled(f)) if f.effect() == CommitEffect::NotCommitted
    ));
    assert_eq!(
        store.get_space(&scope.space_id).await.unwrap().last_seq,
        SpaceSeq::new(4).unwrap()
    );

    // 7. SpaceSeq::MAX overflow fails cleanly without wrapping or corrupting Space!
    let max_space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed.wrapping_add(100)),
            incarnation: sample_incarnation(seed.wrapping_add(100)),
            root_folder_id: sample_folder_id(seed.wrapping_add(100)),
            slug: format!("max-space-{seed}"),
            kind: SpaceKind::Personal,
            owner: actor,
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::MAX,
            created_at: None,
        })
        .await
        .unwrap();
    let overflow_res: Result<u64, PortError> = store
        .submit_fixture_write_command(
            &default_budget(),
            make_simple_intent(
                max_space.scope.clone(),
                epoch,
                None,
                None,
                false,
                "overflow_note",
            ),
        )
        .await;
    assert_validation_err(&overflow_res, ValidationReason::SequenceOverflow);
    assert_eq!(
        store
            .get_space(&max_space.scope.space_id)
            .await
            .unwrap()
            .last_seq,
        SpaceSeq::MAX
    );
}

#[tokio::test]
async fn l3_sqlite_writer_batch_savepoints_idempotency_and_clean_drain() {
    let temp = TempDataRoot::new("l3-sqlite");
    let cfg = CanonicalConfig::local_default(sample_installation_id(60), temp.data_root());
    let (store, rt) = CanonicalRuntime::open(cfg).await.unwrap();
    run_core_writer_batch_suite(&store, 60).await;
    drop(store);
    rt.shutdown().await.expect("clean writer drain & shutdown");
}

#[tokio::test]
async fn l3_postgres_and_s3_writer_cross_space_independence_and_epoch_takeover() {
    let fixtures = StorageTestFixtures::load_required();

    // 1. PostgreSQL + S3 CAS: full L3 suite + cross-Space independence + mid-batch epoch takeover!
    let pg_schema = fixtures.fresh_pg_schema();
    let pg_cfg = fixtures
        .open_pg_s3_config(sample_installation_id(70), &pg_schema)
        .await;
    let (pg_store, pg_rt) = CanonicalRuntime::open(pg_cfg).await.unwrap();

    run_core_writer_batch_suite(&pg_store, 70).await;

    // Cross-Space independence: slow Space A (300 ms pre-commit delay) MUST NOT block Space B!
    let epoch1 = LeaseEpoch::new(1).unwrap();
    let space_a = pg_store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(81),
            incarnation: sample_incarnation(81),
            root_folder_id: sample_folder_id(81),
            slug: "slow-space-a".to_owned(),
            kind: SpaceKind::Shared,
            owner: sample_principal_id(81),
            active_epoch: epoch1,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let space_b = pg_store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(82),
            incarnation: sample_incarnation(82),
            root_folder_id: sample_folder_id(82),
            slug: "fast-space-b".to_owned(),
            kind: SpaceKind::Shared,
            owner: sample_principal_id(82),
            active_epoch: epoch1,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();

    {
        let faults = pg_store.writer_faults().unwrap();
        faults
            .pre_commit_space_delays
            .lock()
            .await
            .insert(space_a.scope.space_id.clone(), Duration::from_millis(300));
    }

    let st_a = pg_store.clone();
    let sc_a = space_a.scope.clone();
    let slow_task = tokio::spawn(async move {
        st_a.submit_fixture_write_command::<u64>(
            &default_budget(),
            make_simple_intent(sc_a, epoch1, None, None, false, "slow_a_1"),
        )
        .await
    });

    // Give Space A 15ms to enter its batch transaction and start sleeping.
    tokio::time::sleep(Duration::from_millis(15)).await;

    let fast_start = Instant::now();
    for idx in 0..5usize {
        let seq: u64 = pg_store
            .submit_fixture_write_command(
                &default_budget(),
                make_simple_intent(
                    space_b.scope.clone(),
                    epoch1,
                    None,
                    None,
                    false,
                    &format!("fast_b_{idx}"),
                ),
            )
            .await
            .expect("Space B must commit without waiting on slow Space A");
        assert_eq!(seq, (idx + 1) as u64);
    }
    let fast_elapsed = fast_start.elapsed();
    assert!(
        fast_elapsed < Duration::from_millis(200),
        "Space B took {fast_elapsed:?}, expected independent fast completion (<200 ms) while Space A sleeps 300 ms"
    );
    assert_eq!(slow_task.await.unwrap().unwrap(), 1);

    // Mid-batch epoch takeover on PostgreSQL:
    // Note: Space A row lock serializes `advance_space_lease` if Space A already holds `FOR UPDATE`,
    // AND if `advance_space_lease` commits BEFORE an old-epoch writer reaches Phase 2, the old-epoch
    // writer MUST roll back with `InvalidAuthority`!
    {
        let faults = pg_store.writer_faults().unwrap();
        faults.pre_commit_space_delays.lock().await.clear();
    }
    let epoch2 = pg_store
        .advance_space_lease(
            &maintenance_ctx(ServicePurpose::Revocation),
            &space_a.scope,
            LeaseEpoch::new(2).unwrap(),
        )
        .await
        .unwrap();

    // Old-epoch batch of multiple items submitted after lease turnover -> ALL rolled back!
    let stale_ep_res: Result<u64, PortError> = pg_store
        .submit_fixture_write_command(
            &default_budget(),
            make_simple_intent(
                space_a.scope.clone(),
                epoch1,
                None,
                None,
                false,
                "stale_epoch_write",
            ),
        )
        .await;
    assert_validation_err(&stale_ep_res, ValidationReason::InvalidAuthority);
    assert_eq!(
        pg_store
            .get_space(&space_a.scope.space_id)
            .await
            .unwrap()
            .last_seq,
        SpaceSeq::new(1).unwrap(),
        "stale-epoch write must not advance last_seq"
    );

    // New-epoch write (`epoch2`) succeeds cleanly at seq 2!
    let ep2_seq: u64 = pg_store
        .submit_fixture_write_command(
            &default_budget(),
            make_simple_intent(
                space_a.scope.clone(),
                epoch2,
                None,
                None,
                false,
                "valid_epoch2_write",
            ),
        )
        .await
        .unwrap();
    assert_eq!(ep2_seq, 2);

    // A different runtime must obtain its own grant. Reading spaces.active_epoch does
    // not authorize the original process to continue using NoteWritePort after takeover.
    let mut successor_cfg = fixtures
        .open_pg_s3_config(sample_installation_id(70), &pg_schema)
        .await;
    let notarium_canonical::SqlBackendConfig::Postgres { pool_size, .. } = &mut successor_cfg.sql
    else {
        unreachable!()
    };
    *pool_size = 1;
    let (successor, successor_rt) = CanonicalRuntime::open(successor_cfg).await.unwrap();
    cancel_pg_write_during_begin(&successor, &fixtures, &pg_schema).await;
    use notarium_core::{
        auth::{EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman},
        classes::DocClass,
        ids::{GrantId, NoteId},
        ports::{CreateNote, Mutation, NoteWritePort, Preconditions, SpaceContext},
        receipt::CommandIdentity,
    };
    let owner = space_a.owner.clone();
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner.clone(),
        GrantId::from_bytes([1; 16]),
        std::collections::BTreeMap::from([(
            space_a.scope.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        false,
    ));
    let ctx = SpaceContext::new(auth, space_a.scope.clone(), default_budget()).unwrap();
    let request = Mutation {
        identity: CommandIdentity {
            scope: space_a.scope.clone(),
            actor: owner,
            key: CommandKey::from_bytes([201; 16]),
            hash: ContentDigest::from_bytes([201; 32]),
        },
        input: CreateNote {
            folder_page: false,
            note: NoteId::from_bytes([201; 16]),
            parent: None,
            slug: "successor".into(),
            class: DocClass::UserDoc,
            carrier: "# Successor".into(),
        },
        preconditions: Preconditions::default(),
    };
    let lower = maintenance_ctx(ServicePurpose::Revocation);
    let higher = maintenance_ctx(ServicePurpose::Revocation);
    let high_epoch = LeaseEpoch::new(4).unwrap();
    let (_, high) = tokio::join!(
        pg_store.advance_space_lease(&lower, &space_a.scope, LeaseEpoch::new(3).unwrap()),
        successor.advance_space_lease(&higher, &space_a.scope, high_epoch),
    );
    assert_eq!(high.unwrap(), high_epoch);
    assert_eq!(
        pg_store
            .get_space(&space_a.scope.space_id)
            .await
            .unwrap()
            .active_epoch,
        high_epoch
    );
    assert_validation_err(
        &pg_store.create_note(ctx.clone(), request.clone()).await,
        ValidationReason::InvalidAuthority,
    );
    successor
        .create_note(ctx, request)
        .await
        .expect("granted writer commits");
    tokio::time::timeout(Duration::from_secs(2), async {
        while pg_store.retained_pg_writer_spaces_for_test().unwrap() != 0
            || successor.retained_pg_writer_spaces_for_test().unwrap() != 0
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("all inactive Space workers and trackers must retire");
    drop(successor);
    successor_rt.shutdown().await.unwrap();

    drop(pg_store);
    pg_rt.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&pg_schema).await;

    // 2. PostgreSQL + MinIO CE S3 profile parity for L3 writer suite!
    let s3_bucket = fixtures.fresh_s3_bucket("l3-writer");
    let s3_cfg = fixtures.s3_config(&s3_bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3_cfg, Some("Enabled"))
        .await
        .expect("create L3 S3 bucket");
    let pg_s3_schema = fixtures.fresh_pg_schema();
    let s3_can_cfg = fixtures.pg_s3_config(sample_installation_id(90), &pg_s3_schema, s3_cfg);
    let (s3_store, s3_rt) = CanonicalRuntime::open(s3_can_cfg).await.unwrap();
    run_core_writer_batch_suite(&s3_store, 90).await;
    drop(s3_store);
    s3_rt.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&pg_s3_schema).await;
}

#[tokio::test]
async fn pg_unknown_commit_barrier_waits_for_active_space_row_lock() {
    use sqlx::Connection;

    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let cfg = fixtures
        .open_pg_s3_config(sample_installation_id(79), &schema)
        .await;
    let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let space_id = sample_space_id(79);
    store
        .create_space(CreateSpaceSpec {
            space_id: space_id.clone(),
            incarnation: sample_incarnation(79),
            root_folder_id: sample_folder_id(79),
            slug: "pg-barrier".to_owned(),
            kind: SpaceKind::Personal,
            owner: sample_principal_id(79),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();

    // Hold an exclusive FOR UPDATE lock on the Space row (simulating an in-flight
    // server-side COMMIT whose client connection was lost).
    let mut raw = fixtures.open_raw_pg().await;
    let mut tx = raw.begin().await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT 1 FROM \"{schema}\".spaces WHERE space_id = $1 FOR UPDATE"
    )))
    .bind(space_id.as_str())
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    let mut barrier =
        Box::pin(store.await_pg_unknown_commit_barrier_for_test(std::slice::from_ref(&space_id)));
    assert!(
        tokio::time::timeout(Duration::from_millis(80), &mut barrier)
            .await
            .is_err(),
        "unknown-commit barrier must wait while a Space FOR UPDATE transaction is active"
    );

    tx.rollback().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), barrier)
        .await
        .expect("unknown-commit barrier must complete once the Space row lock releases");

    let _ = raw.close().await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
