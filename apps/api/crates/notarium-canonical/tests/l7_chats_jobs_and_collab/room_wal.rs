use super::{
    AppendCollabUpdate, CallBudget, CanonicalConfig, CanonicalRuntime, CanonicalStore,
    CloseCollabSession, CollabCarrierSettlement, CollabRoomState, CreateNote, CreateSpaceSpec,
    DocClass, DomainError, EngineAuthContext, GrantId, HistoryScope, LeaseEpoch, OpenCollabSession,
    Ordering, PortError, PrincipalId, S3BucketModePolicy, SpaceContext, SpaceGrant, SpaceKind,
    SpaceRole, StorageTestFixtures, TempDataRoot, ValidationReason, VerifiedHuman,
    admin_ensure_bucket, assert_validation_err, make_budget, next_mutation, owner_ctx,
    sample_folder_id, sample_incarnation, sample_installation_id, sample_note_id,
    sample_principal_id, sample_space_id,
};
use notarium_canonical::{
    AppendCollabUpdates, CollabSettlementActor, FenceCollabSession, RoomWalEntry, SpaceSignal,
    SqlBackendConfig, writer::RoomWalAdmissionPause,
};
use notarium_core::{
    error::{CommitEffect, RetryAdvice},
    ports::{NoteRevision, NoteWritePort, ServiceAuthority, ServicePurpose},
};
use std::{sync::atomic::AtomicBool, time::Duration};
use tokio::{sync::oneshot, time::timeout};

#[tokio::test]
async fn room_wal_sqlite_retry_fence_and_recovery() {
    let temp = TempDataRoot::new("room-wal");
    let config = CanonicalConfig::local_default(sample_installation_id(0x94), temp.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    exercise(&store).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn room_wal_postgres_s3_retry_fence_and_recovery() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("room-wal");
    let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let config = fixtures.pg_s3_config(sample_installation_id(0x94), &schema, s3);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    exercise(&store).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn room_takeover_releases_single_checkout_before_waiting_for_room_fence() {
    use sqlx::Row;

    let fixtures = StorageTestFixtures::load_required();
    let temp = TempDataRoot::new("room-lease-single-pg");
    let schema = fixtures.fresh_pg_schema();
    let mut config =
        fixtures.pg_local_config(sample_installation_id(0x94), &schema, temp.data_root());
    let SqlBackendConfig::Postgres { pool_size, .. } = &mut config.sql else {
        unreachable!();
    };
    *pool_size = 1;
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let owner = sample_principal_id(0x94);
    let scope = add_space(&store, 0x94, &owner).await;
    let note = add_note(&store, &scope, &owner, 0x94).await;
    let budget = make_budget();
    store
        .open_collab_session(
            &budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: note.note.clone(),
                owner_id: "previous".into(),
                expected_carrier_rev: note.revision,
                expected_lease: Some(LeaseEpoch::ZERO),
                expected_lineage: None,
                initial_yrs_snapshot: Some(vec![1, 0]),
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();

    // Reconciliation keeps this guard across a new durable read on the only
    // checkout. Takeover must release the checkout and writer gate first.
    let fence = store
        .room_fences()
        .get_or_init(&scope, &note.note)
        .lock_owned()
        .await;
    let epoch = LeaseEpoch::new(2).unwrap();
    let mut signals = store.subscribe_space_signals();
    let mut witness = fixtures.open_raw_pg().await;
    sqlx::query("SELECT set_config('search_path', $1, false)")
        .bind(&schema)
        .execute(&mut witness)
        .await
        .unwrap();
    let takeover = tokio::spawn({
        let store = store.clone();
        let scope = scope.clone();
        async move {
            let ctx = crate::support::maintenance_ctx(ServicePurpose::Revocation);
            store.advance_space_lease(&ctx, &scope, epoch).await
        }
    });
    timeout(Duration::from_secs(8), async {
        loop {
            let row = sqlx::query("SELECT active_epoch FROM spaces WHERE space_id = $1")
                .bind(scope.space_id.as_str())
                .fetch_one(&mut witness)
                .await
                .unwrap();
            if row.get::<i64, _>("active_epoch") == epoch.get() as i64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("takeover must reach its durable COMMIT");

    let stored = timeout(Duration::from_secs(3), store.read_space(&scope.space_id))
        .await
        .expect("the only pooled checkout must be free")
        .unwrap();
    assert_eq!(stored.active_epoch, epoch);
    let point = timeout(Duration::from_secs(3), store.acquire_writer_safe_point())
        .await
        .expect("takeover must release the writer commit guard")
        .unwrap();
    drop(point);

    let mut short = make_budget();
    short.remaining = Duration::from_millis(25);
    let unsettled = store
        .read_collab_session_after_transition(&short, &scope, &note.note)
        .await;
    assert!(
        matches!(unsettled, Err(PortError::DeadlineExceeded(failure))
        if failure.effect() == CommitEffect::NotCommitted)
    );
    drop(fence);
    assert_eq!(
        timeout(Duration::from_secs(8), takeover)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        epoch
    );
    assert!(matches!(
        timeout(Duration::from_secs(3), signals.recv()).await.unwrap().unwrap(),
        SpaceSignal::WriterLeaseChanged { scope: published } if published == scope
    ));
    let settled = store
        .read_collab_session_after_transition(&budget, &scope, &note.note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(settled.session.room_state, CollabRoomState::Fenced);
    assert!(
        store
            .room_fences()
            .is_room_fenced(&scope.space_id, &note.note)
    );
    drop(witness);
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

async fn add_space(store: &CanonicalStore, seed: u8, owner: &PrincipalId) -> HistoryScope {
    let scope = HistoryScope {
        space_id: sample_space_id(seed),
        incarnation: sample_incarnation(seed),
    };
    store
        .create_space(CreateSpaceSpec {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            root_folder_id: sample_folder_id(seed),
            slug: format!("wal-{seed}"),
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: notarium_core::ids::SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    scope
}

async fn add_note(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    seed: u8,
) -> NoteRevision {
    store
        .create_note(
            owner_ctx(scope, owner.clone()),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    note: sample_note_id(seed),
                    parent: None,
                    slug: format!("wal-{seed}"),
                    class: DocClass::UserDoc,
                    carrier: "---\nstatus: todo # retain\n---\n# Архитектура 🚀\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap()
        .value
}

fn assert_unknown(error: PortError) {
    assert!(
        matches!(
            error,
            PortError::Unavailable(failure) | PortError::Internal(failure)
            if failure.effect() == CommitEffect::Unknown
                && failure.retry() == RetryAdvice::RetrySameCommand
        ),
        "{error:?}"
    );
}

async fn exercise(store: &CanonicalStore) {
    let owner = sample_principal_id(0x94);
    let scope = add_space(store, 0x94, &owner).await;
    let sibling_scope = add_space(store, 0x95, &owner).await;
    let note = sample_note_id(0x94);
    let rev = add_note(store, &scope, &owner, 0x94).await.revision;
    let sibling = add_note(store, &scope, &owner, 0x95).await.revision;
    let foreign = add_note(store, &sibling_scope, &owner, 0x94).await.revision;

    let ctx = owner_ctx(&scope, owner.clone());
    for (base, expected) in [
        (&rev, Some(rev.clone())),
        (&sibling, None),
        (&foreign, None),
    ] {
        let admission = store
            .read_note_collab_admission(&ctx, &note, Some(base))
            .await
            .unwrap();
        assert_eq!(admission.verified_base_rev_id, expected);
        assert!(admission.can_write);
        assert!(admission.session.is_none());
    }
    let budget: CallBudget = make_budget();
    let fault = store.writer_faults().unwrap();
    fault
        .drop_room_open_response_once
        .store(true, Ordering::SeqCst);
    let open_error = store
        .open_collab_session(
            &budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "session-a".into(),
                expected_carrier_rev: rev.clone(),
                expected_lease: Some(LeaseEpoch::ZERO),
                expected_lineage: None,
                initial_yrs_snapshot: Some(vec![1, 0]),
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(open_error, PortError::Unavailable(failure) | PortError::Internal(failure)
        if failure.effect() == CommitEffect::Unknown)
    );
    let room = store
        .read_collab_session_after_transition(&budget, &scope, &note)
        .await
        .unwrap()
        .unwrap()
        .session;
    assert_eq!(room.room_state, CollabRoomState::Active);
    assert_eq!(
        store
            .list_owned_active_collab_sessions(Some(&budget), &scope, "session-a", 2)
            .await
            .unwrap()
            .as_slice(),
        std::slice::from_ref(&note)
    );
    assert!(
        store
            .list_owned_active_collab_sessions(Some(&budget), &scope, "wrong-owner", 2)
            .await
            .unwrap()
            .is_empty()
    );
    let append = |seqs: &[u64]| AppendCollabUpdates {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: "session-a".into(),
        expected_lease: room.lease_epoch,
        expected_lineage: room.lineage_epoch,
        updates: seqs
            .iter()
            .map(|seq| RoomWalEntry {
                update_seq: *seq,
                update_bytes: seq.to_be_bytes().to_vec(),
                auth: ctx.auth().clone(),
            })
            .collect(),
    };
    let read = || store.read_collab_session(None, &scope, &note);
    let before_seq = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let before = read().await.unwrap().unwrap();
    assert_eq!(before.session.yrs_snapshot_blob, Some(vec![1, 0]));
    assert!(before.updates.is_empty());

    let (entered, at_admission) = oneshot::channel();
    let (release, wait_release) = oneshot::channel();
    fault
        .room_wal_admission_pause_once
        .lock()
        .unwrap()
        .replace(RoomWalAdmissionPause {
            entered,
            release: wait_release,
        });
    let allowed = AtomicBool::new(true);
    let admission_check = |enqueue: &mut dyn FnMut()| {
        if allowed.load(Ordering::SeqCst) {
            enqueue();
            Ok(())
        } else {
            Err(DomainError::AccessDenied.into())
        }
    };
    let revoke = async {
        at_admission.await.unwrap();
        allowed.store(false, Ordering::SeqCst);
        release.send(()).unwrap();
    };
    let (denied, ()) = tokio::join!(
        store.append_collab_updates_with_admission(&budget, append(&[1]), &admission_check),
        revoke,
    );
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(read().await.unwrap().unwrap().updates.is_empty());

    fault
        .rollback_commit_response_once
        .store(true, Ordering::SeqCst);
    let batch = append(&[1, 2]);
    assert_unknown(
        store
            .append_collab_updates(&budget, batch.clone())
            .await
            .unwrap_err(),
    );
    assert!(read().await.unwrap().unwrap().updates.is_empty());
    assert_eq!(
        store
            .append_collab_updates(&budget, batch.clone())
            .await
            .unwrap(),
        2
    );

    fault
        .drop_commit_response_once
        .store(true, Ordering::SeqCst);
    let third = append(&[3]);
    assert_unknown(
        store
            .append_collab_updates(&budget, third.clone())
            .await
            .unwrap_err(),
    );
    assert_eq!(read().await.unwrap().unwrap().updates.len(), 3);

    let mut changed = third.clone();
    changed.updates[0].update_bytes.push(0);
    for rejection in [changed, append(&[3, 4])] {
        assert_validation_err(
            &store.append_collab_updates(&budget, rejection).await,
            ValidationReason::DuplicateKey,
        );
    }
    let legacy = AppendCollabUpdate {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: "session-a".into(),
        expected_lease: room.lease_epoch,
        expected_lineage: room.lineage_epoch,
        update_seq: 3,
        update_bytes: 3u64.to_be_bytes().to_vec(),
    };
    assert_validation_err(
        &store.append_collab_update(&budget, legacy).await,
        ValidationReason::DuplicateKey,
    );

    let mut mixed_authority = append(&[4, 5]);
    let viewer = VerifiedHuman::attest(
        sample_principal_id(0x95),
        GrantId::from_bytes([0x95; 16]),
        [(
            scope.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Viewer,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]
        .into(),
        false,
    );
    mixed_authority.updates[1].auth = EngineAuthContext::for_human(viewer);
    let viewer_ctx = SpaceContext::new(
        mixed_authority.updates[1].auth.clone(),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    assert!(
        !store
            .read_note_collab_admission(&viewer_ctx, &note, None)
            .await
            .unwrap()
            .can_write
    );
    // A rejected WAL item must leave other canonical work eligible to commit.
    let (denied, _) = tokio::join!(
        store.append_collab_updates(&budget, mixed_authority),
        add_note(store, &scope, &owner, 0x96),
    );
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert_eq!(read().await.unwrap().unwrap().updates.len(), 3);
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before_seq.checked_next().unwrap(),
    );

    store
        .set_folder_write_lock(ctx.clone(), sample_folder_id(0x94), true)
        .await
        .unwrap();
    assert_eq!(
        store
            .append_collab_updates(&budget, third.clone())
            .await
            .unwrap(),
        3
    );
    assert!(matches!(
        store.append_collab_updates(&budget, append(&[4])).await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert_eq!(read().await.unwrap().unwrap().updates.len(), 3);

    let fenced = store
        .fence_collab_session(
            &budget,
            FenceCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "session-a".into(),
                expected_lease: room.lease_epoch,
                expected_lineage: room.lineage_epoch,
            },
        )
        .await
        .unwrap();
    assert_eq!(fenced.room_state, CollabRoomState::Fenced);
    assert!(store.room_fences().is_room_fenced(&scope.space_id, &note));
    assert_eq!(
        store
            .list_fenced_collab_sessions(Some(&budget), &scope, 8)
            .await
            .unwrap()
            .as_slice(),
        std::slice::from_ref(&note)
    );
    assert!(
        store
            .read_active_room_facts(
                Some(&budget),
                &scope,
                &note,
                room.lease_epoch,
                room.lineage_epoch,
                "session-a",
            )
            .await
            .is_err()
    );
    assert!(store.append_collab_updates(&budget, third).await.is_err());
    let authority = ServiceAuthority::admit(ServicePurpose::CollabRecovery);
    let recovered = store
        .read_fenced_collab_recovery(Some(&budget), &scope, &note, &authority)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.head_rev_id, rev);
    assert_eq!(
        recovered
            .session
            .updates
            .iter()
            .map(|entry| entry.update_seq)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );

    let closed = store
        .close_collab_session(
            &budget,
            CloseCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: None,
                expected_lease: fenced.lease_epoch,
                expected_lineage: fenced.lineage_epoch,
                final_yrs_snapshot: Some(vec![1, 0, 1, 2, 3]),
                compacted_through_update_seq: Some(0),
                carrier_settlement: Some(CollabCarrierSettlement {
                    actor: CollabSettlementActor::Recovery { authority },
                    carrier: format!("{}Settled!\n", recovered.carrier),
                }),
                unchanged_carrier_digest: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(closed.room_state, CollabRoomState::Closed);
    assert_ne!(closed.carrier_rev_id, rev);
    assert!(!closed.carrier_dirty);
    assert!(!store.room_fences().is_room_fenced(&scope.space_id, &note));
    assert!(read().await.unwrap().unwrap().updates.is_empty());
    let settled = store
        .read_note_collab_admission(&ctx, &note, Some(&rev))
        .await
        .unwrap();
    assert_eq!(settled.head_rev_id, closed.carrier_rev_id);
    assert!(settled.carrier.ends_with("🚀\nSettled!\n"));
    assert_eq!(settled.verified_base_rev_id, Some(rev));
    let revision = store
        .read_entity_revision_at_cutoff(&scope, "note", note.as_str(), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revision.actor_id, owner);
    assert!(revision.agent_run_id.is_none());

    let sibling_id = sample_note_id(0x95);
    let clean = store
        .read_note_collab_admission(&ctx, &sibling_id, None)
        .await
        .unwrap();
    let clean_seed = vec![2, 0];
    let clean_room = store
        .open_collab_session(
            &budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: sibling_id.clone(),
                owner_id: "clean-seed".into(),
                expected_carrier_rev: sibling.clone(),
                expected_lease: Some(LeaseEpoch::ZERO),
                expected_lineage: None,
                initial_yrs_snapshot: Some(clean_seed.clone()),
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    let clean_digest = notarium_core::ids::ContentDigest::from_bytes(
        *blake3::hash(clean.carrier.as_bytes()).as_bytes(),
    );
    let cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let clean_close = store
        .close_collab_session(
            &budget,
            CloseCollabSession {
                scope: scope.clone(),
                note: sibling_id,
                owner_id: Some("clean-seed".into()),
                expected_lease: clean_room.lease_epoch,
                expected_lineage: clean_room.lineage_epoch,
                final_yrs_snapshot: Some(clean_seed),
                compacted_through_update_seq: Some(0),
                carrier_settlement: None,
                unchanged_carrier_digest: Some(clean_digest),
            },
        )
        .await
        .unwrap();
    assert_eq!(clean_close.carrier_rev_id, sibling);
    assert!(!clean_close.carrier_dirty);
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        cut
    );
}
