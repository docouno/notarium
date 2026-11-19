mod support;

use std::time::Duration;

use notarium_canonical::{CanonicalConfig, CanonicalRuntime, OpenCollabSession};
use notarium_collab::{
    CollabConfig, CollabHub, SessionEvent,
    wire::{self, LineageHello},
};
use notarium_core::{
    DomainError,
    auth::SpaceRole,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::HistoryScope,
    patch::{BodyPatchPlan, CarrierEditOrigin, HeaderMutation},
    ports::{
        BackupParticipantPort, Cancellation, InterceptedMutation, InterceptedPayload,
        InterceptionResult, LiveCollabInterceptor, MoveNote, NoteWritePort, Preconditions,
        RenameNote, ServicePurpose,
    },
    receipt::ChangeCursor,
};
use notarium_syntax::carrier::Carrier;
use support::*;
use tokio::time::timeout;
use yrs::{
    Map, ReadTxn, Transact,
    encoding::write::Write,
    sync::{Message, SyncMessage},
};

async fn open_sqlite_env(
    name: &str,
    config: CollabConfig,
) -> (
    TempDataRoot,
    notarium_canonical::CanonicalStore,
    CanonicalRuntime,
    CollabHub,
    notarium_core::ports::SpaceContext,
) {
    let root = TempDataRoot::new(name);
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([77; 16]),
        root.data_root(),
    ))
    .await
    .unwrap();
    let scope = test_scope();
    create_space(&store, &scope).await;
    let hub = CollabHub::new(store.clone(), config).unwrap();
    hub.register().unwrap();
    let owner = owner_context(&scope);
    (root, store, runtime, hub, owner)
}

fn fast_config() -> CollabConfig {
    let mut cfg = CollabConfig::default();
    cfg.idle_checkpoint = Duration::from_millis(80);
    cfg.idle_unload = Duration::from_millis(120);
    cfg
}

#[tokio::test]
async fn empty_updates_do_not_write_wal_and_viewer_colliding_sv_is_bounded() {
    let (_root, store, runtime, hub, owner) = open_sqlite_env("empty-sv-dos", fast_config()).await;
    let seed = create_note(&store, &owner, 1, "Initial text.\n", None).await;
    let (mut editor, ready) = synced_client(&hub, &owner, &seed.note, 501).await;

    // Empty [0, 0] y-sync updates advance peer_write_seq and ACK at the
    // current room watermark (0) without inserting no-op WAL rows.
    for expected_seq in 1..=16_u64 {
        editor.send_update(&[0, 0]).await;
        let ack = editor.ack().await;
        assert_eq!(ack.lease_epoch, ready.lease_epoch);
        assert_eq!(ack.peer_write_seq, expected_seq);
        assert_eq!(ack.room_update_seq, 0);
    }
    let stored = store
        .read_collab_session(None, owner.scope(), &seed.note)
        .await
        .unwrap()
        .unwrap();
    assert!(stored.updates.is_empty());

    // Viewer sending > MAX_STATE_VECTOR_CLIENTS colliding IDs is closed cleanly.
    let viewer_ctx = context(
        owner.scope(),
        PrincipalId::from_bytes([51; 16]),
        SpaceRole::Viewer,
        None,
    );
    let (mut viewer, _) = synced_client(&hub, &viewer_ctx, &seed.note, 502).await;

    // Within cap: 2000 colliding unknown client IDs return SyncStep2 promptly.
    let mut sv_payload = Vec::new();
    sv_payload.write_var(2000_u32);
    for k in 1..=2000_u64 {
        sv_payload.write_var(k << 19);
        sv_payload.write_var(1_u32);
    }
    let mut sv_frame = Vec::new();
    sv_frame.write_var(0_u8); // MSG_SYNC
    sv_frame.write_var(0_u8); // MSG_SYNC_STEP_1
    sv_frame.write_buf(&sv_payload);
    viewer.peer.send(sv_frame).await.unwrap();
    viewer
        .until(|m| matches!(m, Message::Sync(SyncMessage::SyncStep2(_))))
        .await;

    // Over cap (20_000 > MAX_STATE_VECTOR_CLIENTS): closed immediately with 1002.
    let mut over_payload = Vec::new();
    over_payload.write_var(20_000_u32);
    for k in 1..=20_000_u64 {
        over_payload.write_var(k << 19);
        over_payload.write_var(1_u32);
    }
    let mut over_frame = Vec::new();
    over_frame.write_var(0_u8);
    over_frame.write_var(0_u8);
    over_frame.write_buf(&over_payload);
    viewer.peer.send(over_frame).await.unwrap();
    assert_eq!(close_code(&mut viewer.peer).await, 1002);

    drop((editor, viewer, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn intercept_racing_idle_unload_falls_back_cleanly_without_unknown() {
    let mut cfg = CollabConfig::default();
    cfg.idle_checkpoint = Duration::from_millis(20);
    cfg.idle_unload = Duration::from_millis(25);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("intercept-unload", cfg).await;
    let mut text = "Base line.\n".to_owned();
    let seed = create_note(&store, &owner, 2, &text, None).await;

    for i in 0..12 {
        let mut peer_sess = open(&hub, &owner, &seed.note).await;
        peer_sess.send(LineageHello::Fresh.encode()).await.unwrap();
        let ev = recv(&mut peer_sess).await;
        let SessionEvent::Binary(_) = ev else {
            let sess = store
                .read_collab_session(None, owner.scope(), &seed.note)
                .await
                .unwrap();
            panic!(
                "iteration {i}: expected LineageReady, got {ev:?}; active_rooms={}, stored_session={sess:?}",
                hub.active_room_count()
            );
        };
        let _step1 = recv(&mut peer_sess).await;
        drop(peer_sess);
        // Sleep close to the idle_unload timer so intercept races room shutdown.
        tokio::time::sleep(Duration::from_millis(20 + (i % 8))).await;
        let addition = format!("edit-{i}\n");
        let cmd = edit(
            &owner,
            &seed.note,
            &text,
            CarrierEditOrigin::Body,
            text.len(),
            text.len(),
            &addition,
        );
        let res = store.edit_note(owner.clone(), cmd).await;
        assert!(
            res.is_ok(),
            "iteration {i}: edit racing idle_unload failed: {res:?}"
        );
        text.push_str(&addition);
    }
    assert_eq!(note_head(&store, &owner, &seed.note).await.1, text);
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn unhosted_active_room_pins_filename_against_move_and_rename() {
    let (_root, store, runtime, hub, owner) = open_sqlite_env("unhosted-pin", fast_config()).await;
    let seed = create_note(&store, &owner, 3, "Pinned body.\n", None).await;

    // Open a durable room owned by a different node so `hub` has no local slot.
    let _active = store
        .open_collab_session(
            &budget(),
            OpenCollabSession {
                scope: owner.scope().clone(),
                note: seed.note.clone(),
                owner_id: "remote-node-owner".into(),
                expected_carrier_rev: seed.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(hub.active_room_count(), 0);

    let rename_err = store
        .rename_note(
            owner.clone(),
            mutation(
                &owner,
                RenameNote {
                    note: seed.note.clone(),
                    slug: "should-fail-rename".into(),
                    title: None,
                },
            ),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        rename_err,
        PortError::Unavailable(f) if f.effect() == CommitEffect::NotCommitted
    ));

    let move_err = store
        .move_note(
            owner.clone(),
            mutation(
                &owner,
                MoveNote {
                    note: seed.note.clone(),
                    parent: None,
                    slug: "should-fail-move".into(),
                },
            ),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        move_err,
        PortError::Unavailable(f) if f.effect() == CommitEffect::NotCommitted
    ));

    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn graceful_hub_shutdown_settles_dirty_rooms_and_closes_waiting_peers() {
    let mut cfg = CollabConfig::default();
    cfg.idle_checkpoint = Duration::from_secs(120);
    cfg.periodic_checkpoint = Duration::from_secs(120);
    cfg.idle_unload = Duration::from_secs(120);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("graceful-shutdown", cfg).await;

    let n1 = create_note(&store, &owner, 4, "Note one.\n", None).await;
    let n2 = create_note(&store, &owner, 5, "Note two.\n", None).await;

    let (mut c1, _) = synced_client(&hub, &owner, &n1.note, 701).await;
    let (mut c2, _) = synced_client(&hub, &owner, &n2.note, 702).await;
    let mut awaiting_hello = open(&hub, &owner, &n1.note).await;

    c1.send_update(&c1.append("Dirty 1.\n")).await;
    c1.ack().await;
    c2.send_update(&c2.append("Dirty 2.\n")).await;
    c2.ack().await;
    assert_eq!(hub.active_room_count(), 2);

    hub.shutdown(&budget()).await.unwrap();
    assert_eq!(hub.active_room_count(), 0);
    assert_eq!(close_code(&mut awaiting_hello).await, 1001);
    assert_eq!(close_code(&mut c1.peer).await, 1001);
    assert_eq!(close_code(&mut c2.peer).await, 1001);

    for (note, expected) in [
        (&n1.note, "Note one.\nDirty 1.\n"),
        (&n2.note, "Note two.\nDirty 2.\n"),
    ] {
        let rec = store
            .read_collab_session(None, owner.scope(), note)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            rec.session.room_state,
            notarium_canonical::CollabRoomState::Closed
        );
        assert!(!rec.session.carrier_dirty);
        assert!(rec.updates.is_empty());
        assert_eq!(note_head(&store, &owner, note).await.1, expected);
    }

    // New connections after shutdown fail immediately.
    let after = hub
        .connect(
            owner.clone(),
            n1.note.clone(),
            test_auth(&Cancellation::default(), None),
        )
        .await;
    assert!(matches!(after, Err(PortError::Unavailable(_))));

    drop((c1, c2, awaiting_hello, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn split_session_supports_concurrent_send_and_recv() {
    let (_root, store, runtime, hub, owner) = open_sqlite_env("split-session", fast_config()).await;
    let seed = create_note(&store, &owner, 6, "Split base.\n", None).await;
    let mut session = open(&hub, &owner, &seed.note).await;
    session.send(LineageHello::Fresh.encode()).await.unwrap();
    // Wait for LineageReady + SyncStep1 before splitting.
    let _ = recv(&mut session).await;
    let _ = recv(&mut session).await;

    let (tx, mut rx) = session.split();
    let doc = yrs::Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Utf16,
        ..yrs::Options::with_client_id(yrs::block::ClientID::new(801))
    });
    let text = doc.get_or_insert_text("body");
    // Sync initial state via split halves.
    tx.send(encode_sync_step1(doc.transact().state_vector()))
        .await
        .unwrap();
    let SessionEvent::Binary(step2) = timeout(WAIT, rx.recv()).await.unwrap().unwrap() else {
        panic!("expected SyncStep2");
    };
    for msg in messages(&step2) {
        if let Message::Sync(SyncMessage::SyncStep2(raw)) = msg {
            use yrs::updates::decoder::Decode;
            doc.transact_mut()
                .apply_update(yrs::Update::decode_v1(&raw).unwrap())
                .unwrap();
        }
    }

    // Drive concurrent send and recv tasks across 16 updates.
    let mut frames = Vec::new();
    for i in 0..16 {
        use yrs::Text;
        let mut txn = doc.transact_mut();
        text.push(&mut txn, &format!("s{i} "));
        txn.commit();
        frames.push(wire::encode_update(&txn.encode_update_v1()));
    }
    let sender_task = tokio::spawn(async move {
        for frame in frames {
            tx.send(frame).await.unwrap();
        }
        tx
    });
    let mut acks = 0u64;
    while acks < 16 {
        let SessionEvent::Binary(frame) = timeout(WAIT, rx.recv()).await.unwrap().unwrap() else {
            panic!("unexpected close during concurrent split test");
        };
        for msg in messages(&frame) {
            if let Message::Custom(wire::SERVER_ACK_WATERMARK, payload) = msg {
                let ack = decode_ack(&payload);
                assert!(ack.peer_write_seq > acks);
                acks = ack.peer_write_seq;
            }
        }
    }
    let _tx = sender_task.await.unwrap();
    drop((rx, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn stale_incarnation_rejected_raw_title_editable_lease_precondition_and_room_capacity() {
    let mut cfg = fast_config();
    cfg.max_active_rooms = 1;
    let (_root, store, runtime, hub, owner) = open_sqlite_env("policy-and-cap", cfg).await;

    let base = "---\ntitle: Before\nstatus: todo\n---\nBody text.\n";
    let n1 = create_note(&store, &owner, 7, base, None).await;
    let n2 = create_note(&store, &owner, 8, "Second note.\n", None).await;

    // 1. Stale HistoryIncarnation rejected immediately on connect().
    let stale_scope = HistoryScope {
        space_id: owner.scope().space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes([0xee; 16]),
    };
    let stale_ctx = owner_context(&stale_scope);
    let err = hub
        .connect(
            stale_ctx,
            n1.note.clone(),
            test_auth(&Cancellation::default(), None),
        )
        .await
        .err()
        .expect("stale incarnation must fail");
    assert!(matches!(
        err,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch
    ));

    // 2. Open room on n1; verify max_active_rooms=1 closes n2 with 1013.
    let (mut c1, ready) = synced_client(&hub, &owner, &n1.note, 901).await;
    let mut over_cap = open(&hub, &owner, &n2.note).await;
    over_cap.send(LineageHello::Fresh.encode()).await.unwrap();
    assert_eq!(close_code(&mut over_cap).await, 1013);
    drop(over_cap);

    // 3. preconditions.lease mismatch returns ValidationReason::InvalidAuthority
    //    in both Phase 1 (`edit_note`) and open-room interception (`intercept`),
    //    while lineage mismatch returns SourceMismatch in Phase 1 and
    //    RevisionConflict { lineage: Some(..) } inside an open room.
    let mut wrong_lease = edit(
        &owner,
        &n1.note,
        base,
        CarrierEditOrigin::Body,
        base.len(),
        base.len(),
        "x",
    );
    wrong_lease.preconditions.lease = Some(LeaseEpoch::new(ready.lease_epoch.get() + 99).unwrap());
    let lease_err = store
        .edit_note(owner.clone(), wrong_lease)
        .await
        .unwrap_err();
    assert!(matches!(
        lease_err,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::InvalidAuthority
    ));

    let mut wrong_lineage = edit(
        &owner,
        &n1.note,
        base,
        CarrierEditOrigin::Body,
        base.len(),
        base.len(),
        "x",
    );
    wrong_lineage.preconditions.lineage =
        Some(LineageEpoch::new(ready.lineage_epoch.get() + 99).unwrap());
    let lineage_err = store
        .edit_note(owner.clone(), wrong_lineage)
        .await
        .unwrap_err();
    assert!(matches!(
        lineage_err,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::SourceMismatch
    ));

    let sample_lease = edit(
        &owner,
        &n1.note,
        base,
        CarrierEditOrigin::Body,
        base.len(),
        base.len(),
        "x",
    );
    let sample_lineage = edit(
        &owner,
        &n1.note,
        base,
        CarrierEditOrigin::Body,
        base.len(),
        base.len(),
        "y",
    );
    let (body_id, _) = notarium_canonical::CanonicalStore::derive_carrier_identities(&n1.revision);
    let body_text = Carrier::scan(base).unwrap().body.slice(base).unwrap();
    let empty_body = BodyPatchPlan {
        body_identity: body_id,
        base_body_hash: ContentDigest::from_bytes(*blake3::hash(body_text.as_bytes()).as_bytes()),
        edits: Vec::new(),
    };
    let direct_lease = hub
        .intercept(InterceptedMutation {
            context: owner.clone(),
            identity: sample_lease.identity,
            preconditions: Preconditions {
                lease: Some(LeaseEpoch::new(ready.lease_epoch.get() + 99).unwrap()),
                ..Preconditions::default()
            },
            payload: InterceptedPayload::EditNote {
                note: n1.note.clone(),
                plan: sample_lease.input.plan,
                body: empty_body.clone(),
                header: HeaderMutation::Preserve,
            },
        })
        .await
        .unwrap();
    assert!(matches!(
        direct_lease,
        InterceptionResult::Conflict(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::InvalidAuthority
    ));

    let direct_lineage = hub
        .intercept(InterceptedMutation {
            context: owner.clone(),
            identity: sample_lineage.identity,
            preconditions: Preconditions {
                lineage: Some(LineageEpoch::new(ready.lineage_epoch.get() + 99).unwrap()),
                ..Preconditions::default()
            },
            payload: InterceptedPayload::EditNote {
                note: n1.note.clone(),
                plan: sample_lineage.input.plan,
                body: empty_body,
                header: HeaderMutation::Preserve,
            },
        })
        .await
        .unwrap();
    assert!(matches!(
        direct_lineage,
        InterceptionResult::Conflict(DomainError::RevisionConflict {
            lineage: Some(actual),
            ..
        }) if actual == ready.lineage_epoch
    ));

    // 4. RawHeader edit changing `title` succeeds in an open room without
    //    rejecting protected collab key or mirroring `title` into fm_overrides.
    let title_pos = base.find("Before").unwrap();
    let raw_title_edit = edit(
        &owner,
        &n1.note,
        base,
        CarrierEditOrigin::Header,
        title_pos,
        title_pos + "Before".len(),
        "After",
    );
    let committed = store
        .edit_note(owner.clone(), raw_title_edit)
        .await
        .unwrap();
    let (_, carrier_after) = note_head(&store, &owner, &n1.note).await;
    assert!(carrier_after.contains("title: After"));
    assert!(carrier_after.contains("status: todo"));
    assert_eq!(
        Carrier::scan(&carrier_after)
            .unwrap()
            .body
            .slice(&carrier_after)
            .unwrap(),
        "Body text.\n"
    );

    // 5. No-op fm_overrides set + revert back to base does not cause a
    //    spurious self-conflict on a subsequent EditNote touching `status`.
    let set_done = c1.update(|txn| {
        c1.fields.insert(txn, "status", "done");
    });
    let revert_todo = c1.update(|txn| {
        c1.fields.insert(txn, "status", "todo");
    });
    c1.send_update(&set_done).await;
    c1.ack().await;
    c1.send_update(&revert_todo).await;
    c1.ack().await;
    let status_pos = carrier_after.find("todo").unwrap();
    let status_edit = edit(
        &owner,
        &n1.note,
        &carrier_after,
        CarrierEditOrigin::Header,
        status_pos,
        status_pos + "todo".len(),
        "review",
    );
    let updated = store.edit_note(owner.clone(), status_edit).await.unwrap();
    assert_ne!(updated.value.revision, committed.value.revision);
    let (_, carrier_final) = note_head(&store, &owner, &n1.note).await;
    assert!(carrier_final.contains("status: review"));

    // 6. Old-incarnation room is cleanly retired when a new incarnation opens.
    let cut = store
        .read_space(&owner.scope().space_id)
        .await
        .unwrap()
        .last_seq;
    let next_scope = HistoryScope {
        space_id: owner.scope().space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes([0xab; 16]),
    };
    store
        .restore_cursors(
            maintenance_ctx(ServicePurpose::Restore),
            vec![ChangeCursor {
                scope: next_scope.clone(),
                after: cut,
            }],
        )
        .await
        .unwrap();
    assert_eq!(close_code(&mut c1.peer).await, 1008);
    let next_owner = owner_context(&next_scope);
    let (mut c_new, new_ready) = synced_client(&hub, &next_owner, &n1.note, 902).await;
    assert_eq!(new_ready.history_incarnation, next_scope.incarnation);
    assert_eq!(c_new.text(), "Body text.\n");

    // Verify unrelated closed-note edit works cleanly via fast path while room is open.
    let gen_before = store.sqlite_commit_generation().unwrap();
    let closed_edit = edit(
        &next_owner,
        &n2.note,
        "Second note.\n",
        CarrierEditOrigin::Body,
        0,
        0,
        "Fast ",
    );
    store
        .edit_note(next_owner.clone(), closed_edit)
        .await
        .unwrap();
    assert!(store.sqlite_commit_generation().unwrap() > gen_before);
    // Room on n1 stays open and functional after unrelated n2 edit.
    c_new.send_update(&c_new.append("Alive.\n")).await;
    c_new.ack().await;

    drop((c1, c_new, hub));
    runtime.shutdown().await.unwrap();
}
