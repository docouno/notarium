#![forbid(unsafe_code)]

mod support;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CollabRoomState, CommittedTargets, CreateFolderSpec,
    FenceCollabSession, OpenCollabSession, S3BucketModePolicy, SpaceSignal,
    blobs::s3::admin_ensure_bucket,
};
use notarium_collab::{
    CollabConfig, CollabHub, CollabSessionAuth, SessionEvent,
    wire::{self, LineageHello, PolicyRejectReason},
};
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::{HistoryScope, Lifecycle},
    patch::{BodyPatchPlan, CarrierEditOrigin, HeaderMutation},
    ports::{
        BackupParticipantPort, Cancellation, ChatPort, ChatThreadKind, CreateChat, CreateNote,
        ExternalObservation, ExternalObservationResult, InterceptedMutation, InterceptedPayload,
        InterceptionResult, LiveCollabInterceptor, MaintenanceContext, MoveFolder, MoveNote,
        NoteWritePort, ObservedContent, PortFuture, Preconditions, RenameNote, RevocationLease,
        RevocationReason, RevocationSelector, ServicePurpose, SessionRevocationPort, SpaceContext,
    },
    receipt::{ChangeCursor, CommandIdentity},
};
use notarium_syntax::{carrier::Carrier, content_digest};
use sqlx::Connection;
use support::*;
use tokio::time::timeout;
use yrs::{
    Any, ClientID, Map, ReadTxn, Text, Transact,
    encoding::write::Write,
    sync::{AwarenessUpdate, Message, SyncMessage, awareness::AwarenessUpdateEntry},
    updates::encoder::Encode,
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

    // A non-empty update that normalizes to empty [0, 0] (duplicate resend)
    // ACKs at the existing durable room watermark without appending a no-op WAL row.
    let real_update = editor.append("Once.\n");
    editor.send_update(&real_update).await;
    let ack1 = editor.ack().await;
    assert_eq!(ack1.peer_write_seq, 17);
    assert_eq!(ack1.room_update_seq, 1);

    editor.send_update(&real_update).await;
    let ack2 = editor.ack().await;
    assert_eq!(ack2.lease_epoch, ready.lease_epoch);
    assert_eq!(ack2.peer_write_seq, 18);
    assert_eq!(ack2.room_update_seq, 1);
    let stored_after_dup = store
        .read_collab_session(None, owner.scope(), &seed.note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored_after_dup.updates.len(), 1);

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
    cfg.idle_checkpoint = Duration::from_millis(40);
    cfg.idle_unload = Duration::from_millis(50);
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
        // Sweep across the 50ms idle_unload boundary so intercept races room shutdown.
        tokio::time::sleep(Duration::from_millis(35 + (i % 6) * 5)).await;
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
async fn shutdown_retry_settles_durable_state_after_the_actor_exits() {
    let (_root, store, runtime, hub, owner) =
        open_sqlite_env("shutdown-close-fence", CollabConfig::default()).await;
    let seed = create_note(&store, &owner, 39, "Start.\n", None).await;
    let (mut peer, _) = synced_client(&hub, &owner, &seed.note, 903).await;
    peer.send_update(&peer.append("Confirmed.\n")).await;
    peer.ack().await;
    let held = store
        .room_fences()
        .get_or_init(owner.scope(), &seed.note)
        .lock_owned()
        .await;
    assert!(hub.shutdown(&budget()).await.is_err());
    wait_until(async || hub.active_room_count() == 0).await;
    drop(held);
    hub.shutdown(&budget()).await.unwrap();
    let state = store
        .read_collab_session(None, owner.scope(), &seed.note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        state.session.room_state,
        notarium_canonical::CollabRoomState::Closed
    );
    assert!(state.updates.is_empty());
    assert_eq!(
        note_head(&store, &owner, &seed.note).await.1,
        "Start.\nConfirmed.\n"
    );
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
async fn live_join_reuses_memory_and_cold_open_recovers_the_closed_lease() {
    let (root, store, runtime, hub, owner) =
        open_sqlite_env("warm-join-cold-open", CollabConfig::default()).await;
    let text = "Existing carrier.\n";
    let note = create_note(&store, &owner, 41, text, None).await.note;
    let (writer, ready) = synced_client(&hub, &owner, &note, 901).await;
    let digest = ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes());
    let blob = root.data_root().blob(&owner.scope().space_id, digest);
    let saved = blob.with_extension("held");
    std::fs::rename(&blob, &saved).unwrap();
    let (reader, _) = synced_client(&hub, &owner, &note, 902).await;
    assert_eq!(reader.text(), text);
    std::fs::rename(saved, blob).unwrap();
    hub.shutdown(&budget()).await.unwrap();
    let closed = store
        .read_collab_session(None, owner.scope(), &note)
        .await
        .unwrap()
        .unwrap()
        .session;
    assert!(closed.lease_epoch > ready.lease_epoch);
    drop((reader, writer, hub, store));
    runtime.shutdown().await.unwrap();

    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([77; 16]),
        root.data_root(),
    ))
    .await
    .unwrap();
    assert_eq!(
        store
            .room_fences()
            .get_or_init(owner.scope(), &note)
            .lock()
            .await
            .epoch(),
        LeaseEpoch::ZERO
    );
    let hub = CollabHub::new(store, CollabConfig::default()).unwrap();
    let (rejoined, reopened) = synced_client(&hub, &owner, &note, 903).await;
    assert!(reopened.lease_epoch > closed.lease_epoch);
    assert_eq!(rejoined.text(), text);
    hub.shutdown(&budget()).await.unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn concurrent_hello_on_distinct_notes_respects_room_limit() {
    let mut cfg = fast_config();
    cfg.max_active_rooms = 1;
    let (_root, store, runtime, hub, owner) = open_sqlite_env("concurrent-room-cap", cfg).await;
    let mut peers = Vec::new();
    for seed in 1..=8 {
        let note = create_note(&store, &owner, seed, "Room.\n", None).await;
        peers.push(open(&hub, &owner, &note.note).await);
    }
    for peer in &mut peers {
        peer.send(LineageHello::Fresh.encode()).await.unwrap();
    }
    let mut ready = 0;
    for peer in &mut peers {
        match recv(peer).await {
            SessionEvent::Binary(frame) => {
                assert!(matches!(
                    messages(&frame).as_slice(),
                    [Message::Custom(wire::LINEAGE_READY, _)]
                ));
                ready += 1;
            }
            SessionEvent::Close(close) => assert_eq!(close.code, 1013),
        }
    }
    assert_eq!(ready, 1);
    assert_eq!(hub.active_room_count(), 1);
    hub.shutdown(&budget()).await.unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn stale_incarnation_rejected_raw_title_editable_lease_precondition_and_room_capacity() {
    let mut cfg = fast_config();
    cfg.max_active_rooms = 1;
    let (root, store, runtime, hub, owner) = open_sqlite_env("policy-and-cap", cfg).await;

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
    let blob = root.data_root().blob(
        &owner.scope().space_id,
        ContentDigest::from_bytes(*blake3::hash(b"Second note.\n").as_bytes()),
    );
    let saved = blob.with_extension("held");
    std::fs::rename(&blob, &saved).unwrap();
    let mut over_cap = open(&hub, &owner, &n2.note).await;
    over_cap.send(LineageHello::Fresh.encode()).await.unwrap();
    assert_eq!(close_code(&mut over_cap).await, 1013);
    drop(over_cap);
    std::fs::rename(saved, blob).unwrap();

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

struct MiniLease(Cancellation);

impl RevocationLease for MiniLease {
    fn check(&self) -> Result<(), PortError> {
        if self.0.is_cancelled() {
            return Err(DomainError::AccessDenied.into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct MiniRevocationRegistry {
    providers: Mutex<Vec<(Vec<RevocationSelector>, Cancellation)>>,
}

fn selector_matches(a: &RevocationSelector, b: &RevocationSelector) -> bool {
    match (a, b) {
        (RevocationSelector::Principal(x), RevocationSelector::Principal(y)) => x == y,
        (RevocationSelector::Session(x), RevocationSelector::Session(y)) => x == y,
        _ => false,
    }
}

impl MiniRevocationRegistry {
    fn cancel_matching(&self, selectors: &[RevocationSelector]) {
        let providers = self.providers.lock().expect("providers");
        for (registered, cancellation) in providers.iter() {
            if registered
                .iter()
                .any(|r| selectors.iter().any(|s| selector_matches(r, s)))
            {
                cancellation.cancel();
            }
        }
    }
}

impl SessionRevocationPort for MiniRevocationRegistry {
    fn register_provider(
        &self,
        _ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.providers
            .lock()
            .expect("providers")
            .push((selectors, cancellation.clone()));
        Box::pin(async move { Ok(Box::new(MiniLease(cancellation)) as Box<dyn RevocationLease>) })
    }

    fn register_canonical_effect(
        &self,
        _ctx: MaintenanceContext,
        _selectors: Vec<RevocationSelector>,
        _cancellation: Cancellation,
    ) -> PortFuture<'_, Arc<dyn notarium_core::ports::CanonicalEffectRegistration>> {
        Box::pin(async { Err(DomainError::AccessDenied.into()) })
    }

    fn fence_provider(
        &self,
        _ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.cancel_matching(&selectors);
        Box::pin(async move {
            Ok(Box::new(MiniLease(Cancellation::default())) as Box<dyn RevocationLease>)
        })
    }

    fn fence_inactive_provider(
        &self,
        _ctx: MaintenanceContext,
        _call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async { Ok(None) })
    }

    fn revoke(
        &self,
        _ctx: MaintenanceContext,
        selector: RevocationSelector,
        _reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        self.cancel_matching(std::slice::from_ref(&selector));
        Box::pin(async { Ok(()) })
    }
}

fn session_role_context(
    scope: &HistoryScope,
    seed: u8,
    principal: PrincipalId,
    role: SpaceRole,
    session_id: AuthSessionId,
) -> SpaceContext {
    let grant = SpaceGrant {
        role,
        read_classes: DocClass::all(),
        write_classes: if role == SpaceRole::Viewer {
            Default::default()
        } else {
            DocClass::all()
        },
        project_root: None,
    };
    let verified = VerifiedHuman::attest(
        principal,
        GrantId::from_bytes([seed; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        false,
    )
    .with_credential(AuthenticatedCredential::Session(session_id));
    SpaceContext::new(
        EngineAuthContext::for_human(verified),
        scope.clone(),
        budget(),
    )
    .unwrap()
}

#[tokio::test]
async fn split_sender_drop_closes_disconnected_and_concurrent_revocations_settle_independently() {
    let mut cfg = CollabConfig::default();
    cfg.idle_checkpoint = Duration::from_secs(60);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_secs(60);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("split-revoke", cfg).await;

    // 1. Pre-Hello and post-attach drop of CollabPeerSender yields 1000 DISCONNECTED
    //    and does not trigger a false revocation checkpoint while another editor remains.
    let n_disc = create_note(&store, &owner, 31, "Base.\n", None).await;
    let pre_hello = open(&hub, &owner, &n_disc.note).await;
    let (pre_tx, mut pre_rx) = pre_hello.split();
    drop(pre_tx);
    let ev = timeout(WAIT, pre_rx.recv()).await.unwrap().unwrap();
    assert!(
        matches!(ev, SessionEvent::Close(close) if close.code == 1000),
        "expected 1000 DISCONNECTED on pre-hello sender drop, got {ev:?}"
    );

    let (mut editor2, _) = synced_client(&hub, &owner, &n_disc.note, 701).await;
    let peer1 = open(&hub, &owner, &n_disc.note).await;
    let (tx1, mut rx1) = peer1.split();
    tx1.send(LineageHello::Fresh.encode()).await.unwrap();
    // Drain LineageReady + SyncStep1.
    let _ready = timeout(WAIT, rx1.recv()).await.unwrap().unwrap();
    let _step1 = timeout(WAIT, rx1.recv()).await.unwrap().unwrap();
    // Editor2 writes an uncheckpointed edit so we can verify no false checkpoint fires.
    editor2.send_update(&editor2.append("Pending.\n")).await;
    editor2.ack().await;
    // Drop only the sender half of peer1 while receiver remains alive.
    drop(tx1);
    let mut close_ev = None;
    for _ in 0..8 {
        match timeout(WAIT, rx1.recv()).await.unwrap() {
            Some(SessionEvent::Close(close)) => {
                close_ev = Some(close);
                break;
            }
            Some(SessionEvent::Binary(_)) => continue,
            None => break,
        }
    }
    let close = close_ev.expect("expected Close event after sender drop");
    assert_eq!(
        close.code, 1000,
        "expected 1000 DISCONNECTED, got {close:?}"
    );
    tokio::time::sleep(Duration::from_millis(40)).await;
    // Canonical head must still be "Base.\n" (no false revocation checkpoint).
    assert_eq!(note_head(&store, &owner, &n_disc.note).await.1, "Base.\n");
    drop(editor2);

    // 2. Independent and overlapping revocations settle strictly their own rooms:
    //    Use live owner editors to make rooms A/B/C dirty and registered Viewer
    //    sessions so Phase-1 peer reap does NOT auto-checkpoint on its own.
    //    Revoking `s_a` must settle ONLY room A and leave B/C unsettled until
    //    their own revocations run (catching any premature `std::mem::take` theft).
    let registry = Arc::new(MiniRevocationRegistry::default());
    let revocations = hub.revocations(registry.clone());

    let n_a = create_note(&store, &owner, 32, "Room A.\n", None).await;
    let n_b = create_note(&store, &owner, 33, "Room B.\n", None).await;
    let n_c = create_note(&store, &owner, 34, "Room C.\n", None).await;

    let (mut ed_a, _) = synced_client(&hub, &owner, &n_a.note, 705).await;
    let (mut ed_b, _) = synced_client(&hub, &owner, &n_b.note, 706).await;
    let (mut ed_c, _) = synced_client(&hub, &owner, &n_c.note, 707).await;

    let p_a = PrincipalId::from_bytes([61; 16]);
    let s_a = AuthSessionId::from_bytes([71; 16]);
    let p_b = PrincipalId::from_bytes([62; 16]);
    let s_b = AuthSessionId::from_bytes([72; 16]);
    let p_c = PrincipalId::from_bytes([63; 16]);
    let s_c = AuthSessionId::from_bytes([73; 16]);

    let ctx_a = session_role_context(
        owner.scope(),
        61,
        p_a.clone(),
        SpaceRole::Viewer,
        s_a.clone(),
    );
    let ctx_b = session_role_context(
        owner.scope(),
        62,
        p_b.clone(),
        SpaceRole::Viewer,
        s_b.clone(),
    );
    let ctx_c = session_role_context(
        owner.scope(),
        63,
        p_c.clone(),
        SpaceRole::Viewer,
        s_c.clone(),
    );

    let connect_registered =
        |ctx: SpaceContext, note: NoteId, p: PrincipalId, s: AuthSessionId, cid: u64| {
            let hub = hub.clone();
            let rev = revocations.clone();
            async move {
                let cancel = Cancellation::default();
                let lease = rev
                    .register_provider(
                        maintenance_ctx(ServicePurpose::Revocation),
                        vec![
                            RevocationSelector::Principal(p),
                            RevocationSelector::Session(s),
                        ],
                        cancel.clone(),
                    )
                    .await
                    .unwrap();
                let auth = CollabSessionAuth::new(lease, cancel, None);
                let peer = hub.connect(ctx, note, auth).await.unwrap();
                let mut client = Client::new(peer, cid);
                client.ready(LineageHello::Fresh).await;
                client.sync().await;
                client
            }
        };

    let mut c_a = connect_registered(ctx_a, n_a.note.clone(), p_a.clone(), s_a.clone(), 711).await;
    let mut c_b = connect_registered(ctx_b, n_b.note.clone(), p_b.clone(), s_b.clone(), 712).await;
    let mut c_c = connect_registered(ctx_c, n_c.note.clone(), p_c.clone(), s_c.clone(), 713).await;

    ed_a.send_update(&ed_a.append("Edit A.\n")).await;
    ed_a.ack().await;
    ed_b.send_update(&ed_b.append("Edit B.\n")).await;
    ed_b.ack().await;
    ed_c.send_update(&ed_c.append("Edit C.\n")).await;
    ed_c.ack().await;

    // Phase 1 fence all three sessions and wait for their PeerGuards to close
    // (guaranteed removed from `hub.peers` and recorded in `pending_revoke_settlement`).
    let _fence_a = revocations
        .fence_provider(
            maintenance_ctx(ServicePurpose::Revocation),
            vec![RevocationSelector::Session(s_a.clone())],
        )
        .await
        .unwrap();
    let _fence_b = revocations
        .fence_provider(
            maintenance_ctx(ServicePurpose::Revocation),
            vec![RevocationSelector::Session(s_b.clone())],
        )
        .await
        .unwrap();
    let _fence_c = revocations
        .fence_provider(
            maintenance_ctx(ServicePurpose::Revocation),
            vec![RevocationSelector::Session(s_c.clone())],
        )
        .await
        .unwrap();
    assert_eq!(close_code(&mut c_a.peer).await, 1008);
    assert_eq!(close_code(&mut c_b.peer).await, 1008);
    assert_eq!(close_code(&mut c_c.peer).await, 1008);
    tokio::time::sleep(Duration::from_millis(30)).await;

    // None of A/B/C auto-checkpointed on viewer disconnect.
    assert_eq!(note_head(&store, &owner, &n_a.note).await.1, "Room A.\n");
    assert_eq!(note_head(&store, &owner, &n_b.note).await.1, "Room B.\n");
    assert_eq!(note_head(&store, &owner, &n_c.note).await.1, "Room C.\n");

    // Step 1: Revoking ONLY `s_a` settles room A and MUST NOT steal or touch B/C.
    revocations
        .revoke(
            maintenance_ctx(ServicePurpose::Revocation),
            RevocationSelector::Session(s_a),
            RevocationReason::Logout,
        )
        .await
        .unwrap();
    assert_eq!(
        note_head(&store, &owner, &n_a.note).await.1,
        "Room A.\nEdit A.\n"
    );
    assert_eq!(
        note_head(&store, &owner, &n_b.note).await.1,
        "Room B.\n",
        "revoke(s_a) must not steal room B"
    );
    assert_eq!(
        note_head(&store, &owner, &n_c.note).await.1,
        "Room C.\n",
        "revoke(s_a) must not steal room C"
    );

    // Step 2: Revoking `s_b` still finds its own preserved pending marker and settles B.
    revocations
        .revoke(
            maintenance_ctx(ServicePurpose::Revocation),
            RevocationSelector::Session(s_b),
            RevocationReason::Logout,
        )
        .await
        .unwrap();
    assert_eq!(
        note_head(&store, &owner, &n_b.note).await.1,
        "Room B.\nEdit B.\n"
    );
    assert_eq!(note_head(&store, &owner, &n_c.note).await.1, "Room C.\n");

    // Step 3: Overlapping Session + Principal revokes on room C both succeed and settle C.
    let (r_c1, r_c2) = tokio::join!(
        revocations.revoke(
            maintenance_ctx(ServicePurpose::Revocation),
            RevocationSelector::Session(s_c),
            RevocationReason::Logout,
        ),
        revocations.revoke(
            maintenance_ctx(ServicePurpose::Revocation),
            RevocationSelector::Principal(p_c),
            RevocationReason::PermissionChanged,
        ),
    );
    r_c1.unwrap();
    r_c2.unwrap();
    assert_eq!(
        note_head(&store, &owner, &n_c.note).await.1,
        "Room C.\nEdit C.\n"
    );

    hub.shutdown(&budget()).await.unwrap();
    drop((c_a, c_b, c_c, ed_a, ed_b, ed_c, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn duplicate_edit_over_revoked_prefix_is_restaged_and_persisted() {
    let mut cfg = CollabConfig::default();
    cfg.idle_checkpoint = Duration::from_secs(60);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_secs(60);
    cfg.wal_coalesce = Duration::from_millis(2);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("dup-revoked-prefix", cfg).await;

    let space_rec = store.read_space(&owner.scope().space_id).await.unwrap();
    let folder_a = FolderId::from_bytes([88; 16]);
    let branch = FolderId::from_bytes([87; 16]);
    store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: space_rec.active_epoch,
            folder_id: folder_a.clone(),
            parent: None,
            slug: "proj-a".to_owned(),
            display_name: "Project A".to_owned(),
            is_project: true,
            project_slug: Some("proj-a".to_owned()),
            actor: test_owner(),
            timestamp: None,
        })
        .await
        .unwrap();
    store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: space_rec.active_epoch,
            folder_id: branch.clone(),
            parent: Some(folder_a.clone()),
            slug: "branch".to_owned(),
            display_name: "Branch".to_owned(),
            is_project: false,
            project_slug: None,
            actor: test_owner(),
            timestamp: None,
        })
        .await
        .unwrap();
    let seed = create_note(&store, &owner, 41, "Hello World\n", Some(branch.clone())).await;

    let scoped_ctx = context(
        owner.scope(),
        PrincipalId::from_bytes([81; 16]),
        SpaceRole::Editor,
        Some(folder_a),
    );
    let (mut peer_a, _) = synced_client(&hub, &scoped_ctx, &seed.note, 801).await;
    let (mut peer_b, _) = synced_client(&hub, &owner, &seed.note, 802).await;

    // Both editors delete the exact same range "World" (UTF-16 offsets 6..11).
    // With `wal_coalesce = 2ms` and two editors, peer_a's `del_a` enters
    // `prefix` and peer_b's `del_b` stages against `staging` to `[0, 0]`,
    // triggering `flush_batch([del_a])` which pauses inside `append`.
    let (entered, release) = pause_wal_admission(&store);
    let del_a = peer_a.update(|txn| peer_a.body.remove_range(txn, 6, 5));
    let del_b = peer_b.update(|txn| peer_b.body.remove_range(txn, 6, 5));
    tokio::join!(peer_a.send_update(&del_a), peer_b.send_update(&del_b));
    timeout(WAIT, entered).await.unwrap().unwrap();

    // Move the parent folder `branch` out of `folder_a` while `flush_batch([del_a])`
    // is paused. Now `peer_a` loses DB write authority while `peer_b` (Owner) keeps it.
    store
        .move_folder(
            owner.clone(),
            mutation(
                &owner,
                MoveFolder {
                    folder: branch,
                    new_parent: None,
                },
            ),
        )
        .await
        .unwrap();
    release.send(()).unwrap();

    // `del_a` fails with AccessDenied and is dropped in `retry_authorized`;
    // `peer_b`'s overlapping `del_b` MUST be re-staged against live and persisted.
    let ack_del = peer_b.ack().await;
    assert_eq!(ack_del.peer_write_seq, 1);
    assert_eq!(
        ack_del.room_update_seq, 1,
        "overlapping authorized edit must be persisted into WAL, not no-op ACKed at seq 0"
    );
    assert_eq!(close_code(&mut peer_a.peer).await, 1008);

    // Settle via shutdown and verify canonical text has "World" deleted.
    hub.shutdown(&budget()).await.unwrap();
    assert_eq!(note_head(&store, &owner, &seed.note).await.1, "Hello \n");

    drop((peer_a, peer_b, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn room_error_exit_drains_buffered_intercept_and_shutdown_reports_stop_timeout() {
    let (_root, store, runtime, hub, owner) =
        open_sqlite_env("error-drain-stop", fast_config()).await;

    // 1. Buffered `Intercept` queued while the room is blocked in a failing WAL
    //    append receives `RoomClosingNotStarted` (via `Room::run` error-exit
    //    `drain_on_close`) and succeeds cleanly instead of `CommitEffect::Unknown`.
    let n1 = create_note(&store, &owner, 42, "Start.\n", None).await;
    let (c1, _) = synced_client(&hub, &owner, &n1.note, 811).await;

    let (entered, release) = pause_wal_admission(&store);
    c1.send_update(&c1.append("InFlight.\n")).await;
    timeout(WAIT, entered).await.unwrap().unwrap();

    // Fence the active room directly in canonical storage so the paused append
    // fails with `InvalidAuthority` and forces `Room::run_loop` to exit with Err.
    let stored = store
        .read_collab_session(None, owner.scope(), &n1.note)
        .await
        .unwrap()
        .unwrap()
        .session;
    store
        .fence_collab_session(
            &budget(),
            FenceCollabSession {
                scope: owner.scope().clone(),
                note: n1.note.clone(),
                owner_id: stored.owner_id.expect("active owner"),
                expected_lease: stored.lease_epoch,
                expected_lineage: stored.lineage_epoch,
            },
        )
        .await
        .unwrap();

    let store_for_edit = store.clone();
    let owner_for_edit = owner.clone();
    let n1_id = n1.note.clone();
    let edit_task = tokio::spawn(async move {
        let cmd = edit(
            &owner_for_edit,
            &n1_id,
            "Start.\n",
            CarrierEditOrigin::Body,
            "Start.\n".len(),
            "Start.\n".len(),
            "AfterError.\n",
        );
        store_for_edit.edit_note(owner_for_edit, cmd).await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    release.send(()).unwrap();

    let edit_res = timeout(WAIT, edit_task).await.unwrap().unwrap();
    assert!(
        edit_res.is_ok(),
        "buffered Intercept must fall back cleanly on Room error exit, got {edit_res:?}"
    );
    assert_eq!(
        note_head(&store, &owner, &n1.note).await.1,
        "Start.\nAfterError.\n"
    );
    drop(c1);

    // 2. `CollabHub::shutdown` surfaces `DeadlineExceeded(collab_hub_shutdown)`
    //    when a busy room cannot service shutdown within the shutdown budget.
    let n2 = create_note(&store, &owner, 43, "Busy.\n", None).await;
    let (mut c2, _) = synced_client(&hub, &owner, &n2.note, 812).await;
    c2.send_update(&c2.append("Confirmed.\n")).await;
    c2.ack().await;
    let (entered2, release2) = pause_wal_admission(&store);
    c2.send_update(&c2.append("Blocked.\n")).await;
    timeout(WAIT, entered2).await.unwrap().unwrap();

    let mut short_budget = budget();
    short_budget.remaining = Duration::from_millis(50);
    let shutdown_err = hub.shutdown(&short_budget).await.unwrap_err();
    match shutdown_err {
        PortError::DeadlineExceeded(failure) => {
            assert_eq!(
                failure.diagnostic_ref(),
                notarium_core::ids::ContentDigest::from_bytes(
                    *blake3::hash(b"collab_hub_shutdown").as_bytes()
                ),
                "expected collab_hub_shutdown diagnostic ref"
            );
        }
        other => {
            panic!("expected DeadlineExceeded from hub.shutdown on blocked room, got {other:?}")
        }
    }
    let _ = release2.send(());
    hub.shutdown(&budget()).await.unwrap();
    let settled = store
        .read_collab_session(None, owner.scope(), &n2.note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        settled.session.room_state,
        notarium_canonical::CollabRoomState::Closed
    );
    assert!(settled.updates.is_empty());
    assert!(
        note_head(&store, &owner, &n2.note)
            .await
            .1
            .contains("Confirmed.")
    );
    drop((c2, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn search_indexing_principal_rejected_and_local_capacity_caps_enforced() {
    let mut cfg = fast_config();
    cfg.max_total_peers = 3;
    cfg.max_rooms_per_space = 2;
    let (_root, store, runtime, hub, owner) = open_sqlite_env("search-and-caps", cfg).await;

    let n1 = create_note(&store, &owner, 101, "One.\n", None).await;
    let n2 = create_note(&store, &owner, 102, "Two.\n", None).await;
    let n3 = create_note(&store, &owner, 103, "Three.\n", None).await;

    // SearchIndexing internal principal must be rejected at hub.connect().
    let search_auth = EngineAuthContext::for_search_indexing(
        PrincipalId::from_bytes([91; 16]),
        GrantId::from_bytes([92; 16]),
        owner.scope().space_id.clone(),
        ProviderResourceId::from_bytes([93; 16]),
    );
    let search_ctx = SpaceContext::new(search_auth, owner.scope().clone(), budget()).unwrap();
    let denied = hub
        .connect(
            search_ctx,
            n1.note.clone(),
            test_auth(&Cancellation::default(), None),
        )
        .await;
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // Open 2 rooms in Space A (hits max_rooms_per_space = 2).
    let (p1, _) = synced_client(&hub, &owner, &n1.note, 901).await;
    let (p2, _) = synced_client(&hub, &owner, &n2.note, 902).await;
    assert_eq!(hub.active_room_count(), 2);

    // Joining an ALREADY-open room does NOT consume a per-Space room slot.
    let (p1_join, _) = synced_client(&hub, &owner, &n1.note, 903).await;
    assert_eq!(hub.active_room_count(), 2);

    // 4th total peer hits max_total_peers = 3 before admission/DB work.
    let over_peers = hub
        .connect(
            owner.clone(),
            n1.note.clone(),
            test_auth(&Cancellation::default(), None),
        )
        .await;
    assert!(matches!(over_peers, Err(PortError::Unavailable(_))));

    // Dropping the extra join frees a peer permit, so connect() succeeds again;
    // cold-opening a 3rd room in the same Space still hits max_rooms_per_space (1013).
    drop(p1_join);
    let mut third_room = open(&hub, &owner, &n3.note).await;
    third_room.send(LineageHello::Fresh.encode()).await.unwrap();
    assert_eq!(close_code(&mut third_room).await, 1013);
    drop(third_room);

    // Cold-opening a room in a DIFFERENT Space still succeeds while Space A is at cap.
    let space_b = HistoryScope {
        space_id: SpaceId::from_bytes([119; 16]),
        incarnation: HistoryIncarnation::from_bytes([120; 16]),
    };
    store
        .create_space(notarium_canonical::CreateSpaceSpec {
            space_id: space_b.space_id.clone(),
            incarnation: space_b.incarnation,
            root_folder_id: FolderId::from_bytes([122; 16]),
            slug: "collab-tests-b".to_owned(),
            kind: notarium_core::auth::SpaceKind::Shared,
            owner: test_owner(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let owner_b = owner_context(&space_b);
    let nb = create_note(&store, &owner_b, 104, "Space B.\n", None).await;
    let (pb, _) = synced_client(&hub, &owner_b, &nb.note, 904).await;
    assert_eq!(hub.active_room_count(), 3);

    // Unloading one room in Space A frees its per-Space slot for n3.
    drop((p2, pb));
    wait_until(async || hub.active_room_count() == 1).await;
    let (p3, _) = synced_client(&hub, &owner, &n3.note, 905).await;
    assert_eq!(hub.active_room_count(), 2);

    drop((p1, p3));
    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn folder_trash_blocked_by_open_or_fenced_room_and_recovery_survives_trashed_ancestor() {
    let mut cfg = fast_config();
    cfg.idle_checkpoint = Duration::from_secs(60);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_secs(60);
    let (root, store, runtime, hub, owner) = open_sqlite_env("folder-trash-recovery", cfg).await;

    let space = store.read_space(&owner.scope().space_id).await.unwrap();
    let parent_id = FolderId::from_bytes([121; 16]);
    let child_id = FolderId::from_bytes([122; 16]);
    let parent_rev = store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: space.active_epoch,
            folder_id: parent_id.clone(),
            parent: None,
            slug: "parent-folder".into(),
            display_name: "Parent".into(),
            is_project: false,
            project_slug: None,
            actor: test_owner(),
            timestamp: None,
        })
        .await
        .unwrap()
        .1;
    store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: space.active_epoch,
            folder_id: child_id.clone(),
            parent: Some(parent_id.clone()),
            slug: "child-folder".into(),
            display_name: "Child".into(),
            is_project: false,
            project_slug: None,
            actor: test_owner(),
            timestamp: None,
        })
        .await
        .unwrap();
    let n1 = create_note(&store, &owner, 111, "Nested.\n", Some(child_id)).await;
    let n2 = create_note(&store, &owner, 112, "Sibling.\n", None).await;

    // 1. Active descendant room blocks trashing the ancestor folder.
    let (mut c1, _) = synced_client(&hub, &owner, &n1.note, 911).await;
    c1.send_update(&c1.append("Accepted WAL.\n")).await;
    c1.ack().await;
    let err = store
        .set_folder_lifecycle(
            owner.scope(),
            space.active_epoch,
            &parent_id,
            &parent_rev,
            Lifecycle::Trashed,
            &test_owner(),
            None,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, PortError::Unavailable(_)),
        "active descendant room must block folder trash, got {err:?}"
    );

    // 2. Fenced descendant room ALSO blocks trashing the ancestor folder.
    let sess1 = store
        .read_collab_session(None, owner.scope(), &n1.note)
        .await
        .unwrap()
        .unwrap()
        .session;
    store
        .fence_collab_session(
            &budget(),
            FenceCollabSession {
                scope: owner.scope().clone(),
                note: n1.note.clone(),
                owner_id: sess1.owner_id.expect("owner"),
                expected_lease: sess1.lease_epoch,
                expected_lineage: sess1.lineage_epoch,
            },
        )
        .await
        .unwrap();
    drop(c1);
    wait_until(async || hub.active_room_count() == 0).await;

    let err_fenced = store
        .set_folder_lifecycle(
            owner.scope(),
            space.active_epoch,
            &parent_id,
            &parent_rev,
            Lifecycle::Trashed,
            &test_owner(),
            None,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err_fenced, PortError::Unavailable(_)),
        "fenced descendant room must block folder trash, got {err_fenced:?}"
    );

    // Also fence n2 so we confirm recovery handles both rooms in one sweep.
    let (mut c2, _) = synced_client(&hub, &owner, &n2.note, 912).await;
    c2.send_update(&c2.append("Sibling WAL.\n")).await;
    c2.ack().await;
    let sess2 = store
        .read_collab_session(None, owner.scope(), &n2.note)
        .await
        .unwrap()
        .unwrap()
        .session;
    store
        .fence_collab_session(
            &budget(),
            FenceCollabSession {
                scope: owner.scope().clone(),
                note: n2.note.clone(),
                owner_id: sess2.owner_id.expect("owner"),
                expected_lease: sess2.lease_epoch,
                expected_lineage: sess2.lineage_epoch,
            },
        )
        .await
        .unwrap();
    drop(c2);
    wait_until(async || hub.active_room_count() == 0).await;

    // 3. Even if an ancestor folder is already marked trashed in storage,
    //    `recover_fenced_rooms` must still settle pre-accepted WAL cleanly
    //    without wedging Space recovery.
    {
        let conn = sqlx::SqliteConnection::connect(&format!(
            "sqlite://{}",
            root.data_root().canonical().display()
        ))
        .await
        .unwrap();
        let mut conn = conn;
        sqlx::query("UPDATE folder_heads SET lifecycle_state = 'trashed' WHERE space_id = ? AND folder_id = ?")
            .bind(owner.scope().space_id.as_str())
            .bind(parent_id.as_str())
            .execute(&mut conn)
            .await
            .unwrap();
    }

    let recovered = hub
        .recover_fenced_rooms(
            &maintenance_ctx(ServicePurpose::CollabRecovery),
            owner.scope(),
        )
        .await
        .unwrap();
    assert_eq!(recovered, 2);
    assert_eq!(
        note_head(&store, &owner, &n2.note).await.1,
        "Sibling.\nSibling WAL.\n"
    );

    // Restore parent folder to active so we can read n1 and verify its settled WAL,
    // then verify trashing now succeeds once rooms are closed.
    let (restored_rev, _) = store
        .set_folder_lifecycle(
            owner.scope(),
            space.active_epoch,
            &parent_id,
            &parent_rev,
            Lifecycle::Active,
            &test_owner(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        note_head(&store, &owner, &n1.note).await.1,
        "Nested.\nAccepted WAL.\n"
    );
    store
        .set_folder_lifecycle(
            owner.scope(),
            space.active_epoch,
            &parent_id,
            &restored_rev,
            Lifecycle::Trashed,
            &test_owner(),
            None,
        )
        .await
        .unwrap();

    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_savepoint_batch_enforces_idempotency_replay_and_key_reuse() {
    let (_root, store, runtime, hub, owner) =
        open_sqlite_env("sqlite-savepoint-idemp", fast_config()).await;
    let n1 = create_note(&store, &owner, 131, "Alpha.\n", None).await;
    let n2 = create_note(&store, &owner, 132, "Beta.\n", None).await;

    // Pause the writer briefly so all concurrent requests land in the same
    // SQLite fast-writer batch, and include a duplicate-slug create pair to
    // force the batch into `run_savepoint_fallback_sql_stage`.
    store
        .writer_faults()
        .unwrap()
        .pre_commit_space_delays
        .lock()
        .await
        .insert(owner.scope().space_id.clone(), Duration::from_millis(60));

    // Warm one write so the delay blocks subsequent writers while they queue together.
    let warmup_store = store.clone();
    let warmup_owner = owner.clone();
    let warmup_note = n2.note.clone();
    let warmup = tokio::spawn(async move {
        let cmd = edit(
            &warmup_owner,
            &warmup_note,
            "Beta.\n",
            CarrierEditOrigin::Body,
            6,
            6,
            "0",
        );
        warmup_store.edit_note(warmup_owner, cmd).await
    });
    tokio::time::sleep(Duration::from_millis(15)).await;

    // 1. Same-note duplicate CommandKey with IDENTICAL payload -> replays same revision.
    let shared_key_replay = CommandKey::from_bytes([201; 16]);
    let mut e1 = edit(
        &owner,
        &n1.note,
        "Alpha.\n",
        CarrierEditOrigin::Body,
        7,
        7,
        "X",
    );
    e1.identity.key = shared_key_replay.clone();
    let e2 = e1.clone();

    // 2. Duplicate CommandKey with DIFFERENT payload (cross-note & same-note) -> IdempotencyKeyReused.
    let shared_key_reuse = CommandKey::from_bytes([202; 16]);
    let mut c_ok = mutation(
        &owner,
        CreateNote {
            folder_page: false,
            note: NoteId::from_bytes([133; 16]),
            parent: None,
            slug: "idemp-a".into(),
            class: DocClass::UserDoc,
            carrier: "A.\n".into(),
        },
    );
    c_ok.identity.key = shared_key_reuse.clone();
    let mut c_diff = mutation(
        &owner,
        CreateNote {
            folder_page: false,
            note: NoteId::from_bytes([134; 16]),
            parent: None,
            slug: "idemp-b".into(),
            class: DocClass::UserDoc,
            carrier: "B.\n".into(),
        },
    );
    c_diff.identity.key = shared_key_reuse;

    // 3. Pair of colliding slugs to trigger `run_savepoint_fallback_sql_stage`.
    let col_a = mutation(
        &owner,
        CreateNote {
            folder_page: false,
            note: NoteId::from_bytes([135; 16]),
            parent: None,
            slug: "same-slug-sp".into(),
            class: DocClass::UserDoc,
            carrier: "S1.\n".into(),
        },
    );
    let col_b = mutation(
        &owner,
        CreateNote {
            folder_page: false,
            note: NoteId::from_bytes([136; 16]),
            parent: None,
            slug: "same-slug-sp".into(),
            class: DocClass::UserDoc,
            carrier: "S2.\n".into(),
        },
    );

    let (r_e1, r_e2, r_ok, r_diff, r_ca, r_cb) = tokio::join!(
        store.edit_note(owner.clone(), e1),
        store.edit_note(owner.clone(), e2),
        store.create_note(owner.clone(), c_ok),
        store.create_note(owner.clone(), c_diff),
        store.create_note(owner.clone(), col_a),
        store.create_note(owner.clone(), col_b),
    );
    warmup.await.unwrap().unwrap();
    store
        .writer_faults()
        .unwrap()
        .pre_commit_space_delays
        .lock()
        .await
        .clear();

    // Replay: both return the exact same RevisionId.
    let e1_ok = r_e1.unwrap();
    let e2_ok = r_e2.unwrap();
    assert_eq!(e1_ok.value.revision, e2_ok.value.revision);
    assert_eq!(note_head(&store, &owner, &n1.note).await.1, "Alpha.\nX");

    // Key reuse with different payload: exactly one succeeds, the other gets IdempotencyKeyReused.
    let reuse_pair = [r_ok.map(|_| ()), r_diff.map(|_| ())];
    let ok_count = reuse_pair.iter().filter(|r| r.is_ok()).count();
    let reused_count = reuse_pair
        .iter()
        .filter(|r| matches!(r, Err(PortError::Domain(DomainError::IdempotencyKeyReused))))
        .count();
    assert_eq!(ok_count, 1, "reuse pair: {reuse_pair:?}");
    assert_eq!(reused_count, 1, "reuse pair: {reuse_pair:?}");

    // Slug collision: exactly one succeeded, one failed with PathConflict.
    let col_ok = [r_ca.is_ok(), r_cb.is_ok()]
        .into_iter()
        .filter(|&b| b)
        .count();
    assert_eq!(col_ok, 1);

    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn awareness_not_echoed_auth_gen_invariance_and_chat_targets() {
    let mut cfg = fast_config();
    cfg.idle_checkpoint = Duration::from_secs(60);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_secs(60);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("awareness-authgen-chat", cfg).await;
    let note = create_note(&store, &owner, 141, "Hello.\n", None)
        .await
        .note;
    let (mut peer_a, _) = synced_client(&hub, &owner, &note, 941).await;
    let (mut peer_b, _) = synced_client(&hub, &owner, &note, 942).await;

    // 1. Awareness sent by A reaches B and is NOT echoed back to A.
    let aw = AwarenessUpdate {
        clients: std::collections::HashMap::from([(
            ClientID::new(941),
            AwarenessUpdateEntry {
                clock: 1,
                json: "{\"cursor\":1}".into(),
            },
        )]),
    };
    peer_a
        .peer
        .send(Message::Awareness(aw).encode_v1())
        .await
        .unwrap();
    peer_b.until(|m| matches!(m, Message::Awareness(_))).await;
    assert!(
        timeout(Duration::from_millis(80), peer_a.peer.recv())
            .await
            .is_err(),
        "awareness must not echo back to sender"
    );

    // 2. Pure WAL appends leave sqlite_auth_commit_generation unchanged while
    //    advancing sqlite_commit_generation; subsequent canonical commits advance both.
    let auth_g0 = store.sqlite_auth_commit_generation().unwrap();
    let writer_g0 = store.sqlite_commit_generation().unwrap();
    for step in 0..3 {
        peer_a
            .send_update(&peer_a.append(&format!("More {step}.\n")))
            .await;
        peer_a.ack().await;
    }
    assert_eq!(store.sqlite_auth_commit_generation().unwrap(), auth_g0);
    assert!(store.sqlite_commit_generation().unwrap() > writer_g0);

    // 3. Chat creation emits CommittedTargets::Notes([]) rather than All.
    let mut signals = store.subscribe_space_signals();
    store
        .create_chat(
            owner.clone(),
            mutation(
                &owner,
                CreateChat {
                    thread: ChatThreadId::from_bytes([142; 16]),
                    kind: ChatThreadKind::Personal,
                    owner: test_owner(),
                    project_folder: None,
                    title: "Chat".into(),
                },
            ),
        )
        .await
        .unwrap();
    let mut saw_chat_targets = false;
    while let Ok(Ok(sig)) = timeout(Duration::from_millis(200), signals.recv()).await {
        if let SpaceSignal::Committed {
            targets: CommittedTargets::Notes(notes),
            ..
        } = sig
            && notes.is_empty()
        {
            saw_chat_targets = true;
            break;
        }
    }
    assert!(
        saw_chat_targets,
        "chat-only commit must emit empty Notes targets, not CommittedTargets::All"
    );

    drop((peer_a, peer_b));
    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_null_and_tagged_yaml_roots_advertise_body_only_and_reject_fm() {
    let (_root, store, runtime, hub, owner) =
        open_sqlite_env("yaml-null-tagged", fast_config()).await;

    for (idx, carrier) in [
        "---\nnull\n---\nbody\n",
        "---\n~\n---\nbody\n",
        "---\n!!map {}\n---\nbody\n",
    ]
    .into_iter()
    .enumerate()
    {
        let note = create_note(&store, &owner, 150 + idx as u8, carrier, None)
            .await
            .note;
        let (mut client, ready) = synced_client(&hub, &owner, &note, 950 + idx as u64).await;
        assert!(
            !ready.fm_writable,
            "expected fm_writable=false for {carrier:?}"
        );
        client
            .send_update(&client.update(|txn| {
                client.fields.insert(txn, "status", "done");
            }))
            .await;
        let Message::Custom(_, payload) = client
            .until(|m| matches!(m, Message::Custom(wire::POLICY_REJECTED, _)))
            .await
        else {
            unreachable!()
        };
        assert_eq!(payload[1], PolicyRejectReason::FrontmatterNotWritable as u8);
        assert_eq!(close_code(&mut client.peer).await, 1008);
    }

    let comment_note = create_note(&store, &owner, 155, "---\n# comment\n---\nbody\n", None)
        .await
        .note;
    let (_c, ready) = synced_client(&hub, &owner, &comment_note, 955).await;
    assert!(
        ready.fm_writable,
        "comment-only YAML header must stay writable"
    );

    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn revoke_recovers_unsettled_room_and_invalid_shutdown_budget_keeps_hub_open() {
    let mut cfg = fast_config();
    cfg.idle_checkpoint = Duration::from_millis(250);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_millis(250);
    let (_root, store, runtime, hub, owner) =
        open_sqlite_env("revoke-unsettled-shutdown", cfg).await;

    // 1. Invalid shutdown budget (overflow Duration::MAX) must NOT cancel accept_closed.
    let mut overflow = budget();
    overflow.remaining = Duration::MAX;
    let err = hub.shutdown(&overflow).await.unwrap_err();
    assert!(matches!(
        err,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::InvalidRange
    ));
    let n1 = create_note(&store, &owner, 161, "Alive.\n", None).await;
    let (p_check, _) = synced_client(&hub, &owner, &n1.note, 961).await;
    drop(p_check);
    wait_until(async || hub.active_room_count() == 0).await;

    // 2. Non-SpaceClosed revoke MUST settle/recover even if the room stopped
    //    with `settled == false` (e.g. room fenced before revoke runs).
    let n2 = create_note(&store, &owner, 162, "Base.\n", None).await;
    let session_id = AuthSessionId::from_bytes([162; 16]);
    let peer_principal = PrincipalId::from_bytes([163; 16]);
    let grant = SpaceGrant {
        role: SpaceRole::Editor,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let verified = VerifiedHuman::attest(
        peer_principal,
        GrantId::from_bytes(random_bytes_16()),
        BTreeMap::from([(owner.scope().space_id.clone(), grant)]),
        false,
    )
    .with_credential(AuthenticatedCredential::Session(session_id.clone()));
    let peer_ctx = SpaceContext::new(
        EngineAuthContext::for_human(verified),
        owner.scope().clone(),
        budget(),
    )
    .unwrap();
    let cancel = Cancellation::default();
    let sess = hub
        .connect(peer_ctx.clone(), n2.note.clone(), test_auth(&cancel, None))
        .await
        .unwrap();
    let mut client = Client::new(sess, 962);
    client.ready(LineageHello::Fresh).await;
    client.sync().await;
    client
        .send_update(&client.append("Confirmed edit.\n"))
        .await;
    client.ack().await;

    // Fence the room in storage while the peer is still connected, then cancel
    // the peer's session registration (recording pending_revoke_settlement).
    // Once idle_unload fires, the room attempts close_collab_snapshot against the
    // fenced lease and exits with `settled == false`.
    let stored = store
        .read_collab_session(None, owner.scope(), &n2.note)
        .await
        .unwrap()
        .unwrap()
        .session;
    store
        .fence_collab_session(
            &budget(),
            FenceCollabSession {
                scope: owner.scope().clone(),
                note: n2.note.clone(),
                owner_id: stored.owner_id.expect("owner"),
                expected_lease: stored.lease_epoch,
                expected_lineage: stored.lineage_epoch,
            },
        )
        .await
        .unwrap();
    cancel.cancel();
    assert_eq!(close_code(&mut client.peer).await, 1008);
    wait_until(async || hub.active_room_count() == 0).await;

    // Confirmed WAL is NOT yet materialized in canonical Markdown.
    assert_eq!(note_head(&store, &owner, &n2.note).await.1, "Base.\n");

    // Non-SpaceClosed revoke MUST recover the unsettled fenced room before Ok(()).
    hub.revoke(
        &maintenance_ctx(ServicePurpose::Revocation),
        &RevocationSelector::Session(session_id),
        RevocationReason::Logout,
    )
    .await
    .unwrap();
    assert_eq!(
        note_head(&store, &owner, &n2.note).await.1,
        "Base.\nConfirmed edit.\n"
    );

    hub.shutdown(&budget()).await.unwrap();
    drop((client, hub));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn header_edge_cases_and_fenced_or_pinned_title_renames() {
    let mut cfg = fast_config();
    cfg.idle_checkpoint = Duration::from_secs(60);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_secs(60);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("header-edges-and-rename", cfg).await;

    // 1. Live room + closed note external observation and edit_note on tricky header boundaries.
    let cases = [
        (171u8, "---\nstatus: todo\n---", "---\nstatus: done\n---"),
        (
            172u8,
            "---\nstatus: todo\n---\n---\nnot: fm\n---\n",
            "Plain body.\n",
        ),
        (
            173u8,
            "---\rstatus: todo\r---\r\nbody",
            "---\rstatus: done\r---\r\nbody",
        ),
    ];
    for (seed, before, after) in cases {
        // Open room path:
        let open_note = create_note(&store, &owner, seed, before, None).await;
        let (_client, _) =
            synced_client(&hub, &owner, &open_note.note, 970 + u64::from(seed)).await;
        let obs = store
            .accept_external_observation(
                owner.clone(),
                mutation(
                    &owner,
                    ExternalObservation {
                        note: open_note.note.clone(),
                        base_revision: open_note.revision.clone(),
                        observed_digest: content_digest(after),
                        disk_identity: content_digest("disk-open"),
                        content: ObservedContent::Carrier(after.to_owned()),
                    },
                ),
            )
            .await
            .unwrap();
        assert!(matches!(obs, ExternalObservationResult::Committed(_)));
        assert_eq!(note_head(&store, &owner, &open_note.note).await.1, after);

        // Closed note path (exercises try_closed_room_reservation fast path):
        let closed_note = create_note(&store, &owner, seed + 10, before, None).await;
        let obs_closed = store
            .accept_external_observation(
                owner.clone(),
                mutation(
                    &owner,
                    ExternalObservation {
                        note: closed_note.note.clone(),
                        base_revision: closed_note.revision.clone(),
                        observed_digest: content_digest(after),
                        disk_identity: content_digest("disk-closed"),
                        content: ObservedContent::Carrier(after.to_owned()),
                    },
                ),
            )
            .await
            .unwrap();
        assert!(matches!(
            obs_closed,
            ExternalObservationResult::Committed(_)
        ));
        assert_eq!(note_head(&store, &owner, &closed_note.note).await.1, after);
    }

    // 2. rename_note(title: Some) on an active pinned room (same slug!) fails early cleanly.
    let n_active = create_note(&store, &owner, 185, "# Old\nBody.\n", None).await;
    let (_active_c, _) = synced_client(&hub, &owner, &n_active.note, 985).await;
    let pinned_err = store
        .rename_note(
            owner.clone(),
            mutation(
                &owner,
                RenameNote {
                    note: n_active.note.clone(),
                    slug: "collab-note-185".into(),
                    title: Some("Blocked Title".into()),
                },
            ),
        )
        .await
        .unwrap_err();
    assert!(matches!(pinned_err, PortError::Unavailable(_)));

    // 3. rename_note(title: Some) on a fenced room (no revision precondition) recovers
    //    the WAL first and applies the title onto the recovered content.
    let n_fenced = create_note(&store, &owner, 186, "# Before\nSeed.\n", None).await;
    let (mut fc, _) = synced_client(&hub, &owner, &n_fenced.note, 986).await;
    fc.send_update(&fc.append("Recovered WAL.\n")).await;
    fc.ack().await;
    let sess = store
        .read_collab_session(None, owner.scope(), &n_fenced.note)
        .await
        .unwrap()
        .unwrap()
        .session;
    store
        .fence_collab_session(
            &budget(),
            FenceCollabSession {
                scope: owner.scope().clone(),
                note: n_fenced.note.clone(),
                owner_id: sess.owner_id.expect("owner"),
                expected_lease: sess.lease_epoch,
                expected_lineage: sess.lineage_epoch,
            },
        )
        .await
        .unwrap();
    drop(fc);
    wait_until(async || hub.active_room_count() == 4).await;

    store
        .rename_note(
            owner.clone(),
            mutation(
                &owner,
                RenameNote {
                    note: n_fenced.note.clone(),
                    slug: "renamed-after-fence".into(),
                    title: Some("Fresh Title".into()),
                },
            ),
        )
        .await
        .unwrap();
    let final_text = note_head(&store, &owner, &n_fenced.note).await.1;
    assert!(
        final_text.contains("Fresh Title"),
        "missing title: {final_text}"
    );
    assert!(
        final_text.contains("Recovered WAL."),
        "fenced WAL lost on title rename: {final_text}"
    );

    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn move_pin_unpinned_rejects_room_opened_after_fence_table_eviction() {
    let root = TempDataRoot::new("unpinned-after-evict");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([78; 16]),
        root.data_root(),
    ))
    .await
    .unwrap();
    let scope = test_scope();
    create_space(&store, &scope).await;
    let owner = owner_context(&scope);
    let note = create_note(&store, &owner, 191, "Evicted.\n", None).await;

    // Interceptor that opens a room at lease_epoch = 1 right after returning
    // Unpinned (simulating a race after RoomFenceTable evicted an idle closed slot).
    struct RaceOpenInterceptor {
        store: notarium_canonical::CanonicalStore,
        rev: RevisionId,
    }
    impl LiveCollabInterceptor for RaceOpenInterceptor {
        fn intercept(&self, _req: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
            Box::pin(async { Err(DomainError::validation(ValidationReason::InvalidState).into()) })
        }
        fn reserve_rollback(
            &self,
            _: SpaceContext,
            _: NoteId,
            _: CommandIdentity,
        ) -> PortFuture<'_, notarium_core::ports::RollbackReservation> {
            Box::pin(async { Err(DomainError::validation(ValidationReason::InvalidState).into()) })
        }
        fn filename_pin(
            &self,
            ctx: SpaceContext,
            note: NoteId,
        ) -> PortFuture<'_, notarium_core::ports::FilenamePin> {
            let store = self.store.clone();
            let rev = self.rev.clone();
            Box::pin(async move {
                // Ensure the note is NOT in RoomFenceTable when observed_active_lease ran,
                // then open a durable room at lease_epoch = 1 before rename commits.
                store
                    .open_collab_session(
                        &ctx.budget,
                        OpenCollabSession {
                            scope: ctx.scope().clone(),
                            note,
                            owner_id: "racer".into(),
                            expected_carrier_rev: rev,
                            expected_lease: None,
                            expected_lineage: None,
                            initial_yrs_snapshot: Some(vec![0, 0]),
                            allow_fenced_recovery: false,
                        },
                    )
                    .await?;
                Ok(notarium_core::ports::FilenamePin::Unpinned)
            })
        }
    }

    store
        .register_collab_interceptor(Arc::new(RaceOpenInterceptor {
            store: store.clone(),
            rev: note.revision.clone(),
        }))
        .unwrap();
    store
        .room_fences()
        .remove_note(&owner.scope().space_id, &note.note);

    let err = store
        .rename_note(
            owner.clone(),
            mutation(
                &owner,
                RenameNote {
                    note: note.note.clone(),
                    slug: "should-fail".into(),
                    title: None,
                },
            ),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, PortError::Unavailable(_)),
        "rename must reject room opened at lease_epoch=1 after observing None active lease, got {err:?}"
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn policy_codes_slow_consumer_max_peers_unknown_retry_and_snapshotless_tail() {
    let mut cfg = fast_config();
    cfg.idle_checkpoint = Duration::from_secs(60);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_secs(60);
    let (root, store, runtime, hub, owner) = open_sqlite_env("protocol-edge-matrix", cfg).await;

    // 1. ForbiddenRootOrSubdoc (3) and InvalidFrontmatterValue (8).
    let n1 = create_note(&store, &owner, 201, "---\nstatus: todo\n---\nBody.\n", None)
        .await
        .note;
    {
        let (mut bad_root, _) = synced_client(&hub, &owner, &n1, 1001).await;
        let extra = bad_root.doc.get_or_insert_text("rogue_root");
        let raw = bad_root.update(|txn| extra.insert(txn, 0, "nope"));
        bad_root.send_update(&raw).await;
        let Message::Custom(_, payload) = bad_root
            .until(|m| matches!(m, Message::Custom(wire::POLICY_REJECTED, _)))
            .await
        else {
            unreachable!()
        };
        assert_eq!(payload[1], PolicyRejectReason::ForbiddenRootOrSubdoc as u8);
        assert_eq!(close_code(&mut bad_root.peer).await, 1008);
    }
    {
        let (mut bad_val, _) = synced_client(&hub, &owner, &n1, 1002).await;
        let raw = bad_val.update(|txn| {
            bad_val
                .fields
                .insert(txn, "status", Any::Number(yrs::Number::Float(f64::NAN)));
        });
        bad_val.send_update(&raw).await;
        let Message::Custom(_, payload) = bad_val
            .until(|m| matches!(m, Message::Custom(wire::POLICY_REJECTED, _)))
            .await
        else {
            unreachable!()
        };
        assert_eq!(
            payload[1],
            PolicyRejectReason::InvalidFrontmatterValue as u8
        );
        assert_eq!(close_code(&mut bad_val.peer).await, 1008);
    }

    // 2. SLOW_CONSUMER (1013) when a peer stops draining outbound queue (>8 frames).
    {
        let (mut writer, _) = synced_client(&hub, &owner, &n1, 1003).await;
        let (mut slow, _) = synced_client(&hub, &owner, &n1, 1004).await;
        for i in 0..16 {
            writer.send_update(&writer.append(&format!("{i}"))).await;
            writer.ack().await;
        }
        assert_eq!(close_code(&mut slow.peer).await, 1013);
    }

    // 3. CommitEffect::Unknown retry on Room::append (both committed & rolled-back)
    //    and Room::apply_command (committed).
    {
        let (mut writer, _) = synced_client(&hub, &owner, &n1, 1005).await;
        store
            .writer_faults()
            .unwrap()
            .drop_commit_response_once
            .store(true, Ordering::SeqCst);
        writer.send_update(&writer.append("RetryCommit.\n")).await;
        writer.ack().await;

        store
            .writer_faults()
            .unwrap()
            .rollback_commit_response_once
            .store(true, Ordering::SeqCst);
        writer.send_update(&writer.append("RetryRollback.\n")).await;
        writer.ack().await;

        // Intercepted edit_note with drop_commit_response_once retries cleanly.
        let current_text = note_head(&store, &owner, &n1).await.1;
        store
            .writer_faults()
            .unwrap()
            .drop_commit_response_once
            .store(true, Ordering::SeqCst);
        let cmd = edit(
            &owner,
            &n1,
            &current_text,
            CarrierEditOrigin::Body,
            current_text.len(),
            current_text.len(),
            "",
        );
        // Trigger a live checkpoint via body edit mismatch or valid append on live state.
        let _ = store.edit_note(owner.clone(), cmd).await;
        let head_after_ckpt = note_head(&store, &owner, &n1).await.1;
        assert!(head_after_ckpt.contains("RetryCommit."));
        assert!(head_after_ckpt.contains("RetryRollback."));
        store
            .writer_faults()
            .unwrap()
            .drop_commit_response_once
            .store(true, Ordering::SeqCst);
        let cmd2 = edit(
            &owner,
            &n1,
            &head_after_ckpt,
            CarrierEditOrigin::Body,
            head_after_ckpt.len(),
            head_after_ckpt.len(),
            "CmdRetry.\n",
        );
        store.edit_note(owner.clone(), cmd2).await.unwrap();
        assert!(note_head(&store, &owner, &n1).await.1.contains("CmdRetry."));
    }

    // 4. MAX_PEERS (128 peers accepted, 129th gets 1013).
    {
        let n_cap = create_note(&store, &owner, 202, "Crowded.\n", None)
            .await
            .note;
        let mut peers = Vec::with_capacity(128);
        for i in 0..128u64 {
            let (c, _) = synced_client(&hub, &owner, &n_cap, 2000 + i).await;
            peers.push(c);
        }
        let mut peer_129 = open(&hub, &owner, &n_cap).await;
        peer_129.send(LineageHello::Fresh.encode()).await.unwrap();
        assert_eq!(close_code(&mut peer_129).await, 1013);
        drop(peers);
    }

    // 5. Snapshotless WAL tail fails admission & recovery with ValidationReason::NotReady.
    {
        let n_corrupt = create_note(&store, &owner, 203, "Corrupt.\n", None).await;
        let (mut c, _) = synced_client(&hub, &owner, &n_corrupt.note, 2500).await;
        c.send_update(&c.append("Tail.\n")).await;
        c.ack().await;
        let sess = store
            .read_collab_session(None, owner.scope(), &n_corrupt.note)
            .await
            .unwrap()
            .unwrap()
            .session;
        store
            .fence_collab_session(
                &budget(),
                FenceCollabSession {
                    scope: owner.scope().clone(),
                    note: n_corrupt.note.clone(),
                    owner_id: sess.owner_id.expect("owner"),
                    expected_lease: sess.lease_epoch,
                    expected_lineage: sess.lineage_epoch,
                },
            )
            .await
            .unwrap();
        drop(c);
        wait_until(async || {
            store
                .read_collab_session(None, owner.scope(), &n_corrupt.note)
                .await
                .unwrap()
                .unwrap()
                .session
                .room_state
                == CollabRoomState::Fenced
        })
        .await;
        {
            let mut conn = sqlx::SqliteConnection::connect(&format!(
                "sqlite://{}",
                root.data_root().canonical().display()
            ))
            .await
            .unwrap();
            sqlx::query("UPDATE collab_sessions SET yrs_snapshot_blob = NULL, yrs_snapshot_blake3 = NULL WHERE space_id = ? AND note_id = ?")
                .bind(owner.scope().space_id.as_str())
                .bind(n_corrupt.note.as_str())
                .execute(&mut conn)
                .await
                .unwrap();
        }
        let rec_err = hub
            .recover_fenced_rooms(
                &maintenance_ctx(ServicePurpose::CollabRecovery),
                owner.scope(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(
                rec_err,
                PortError::Domain(DomainError::ValidationFailed { ref diagnostic })
                    if diagnostic.reason == ValidationReason::NotReady
            ),
            "expected NotReady on snapshotless WAL tail, got {rec_err:?}"
        );
        // Hub shutdown also tracks unsettled rooms and must surface NotReady
        // rather than reporting a clean shutdown while the corrupted room remains fenced.
        let shut_err = hub.shutdown(&budget()).await.unwrap_err();
        assert!(
            matches!(
                shut_err,
                PortError::Domain(DomainError::ValidationFailed { ref diagnostic })
                    if diagnostic.reason == ValidationReason::NotReady
            ),
            "expected NotReady on hub.shutdown() for unsettled snapshotless room, got {shut_err:?}"
        );
    }

    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_two_owner_takeover_unhosted_pin_and_single_cte_broadcast() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("collab-hardening-pg");
    let s3 = fixtures.s3_config(bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();

    let installation = InstallationId::from_bytes([171; 16]);
    let cfg_a = fixtures.pg_s3_config(installation.clone(), &schema, s3.clone());
    let cfg_b = fixtures.pg_s3_config(installation, &schema, s3);
    let (store_a, runtime_a) = CanonicalRuntime::open(cfg_a).await.unwrap();
    let (store_b, runtime_b) = CanonicalRuntime::open(cfg_b).await.unwrap();

    let mut hub_cfg = fast_config();
    hub_cfg.idle_checkpoint = Duration::from_secs(60);
    hub_cfg.periodic_checkpoint = Duration::from_secs(60);
    hub_cfg.idle_unload = Duration::from_secs(60);
    let hub_a = CollabHub::new(store_a.clone(), hub_cfg.clone()).unwrap();
    hub_a.register().unwrap();
    let hub_b = CollabHub::new(store_b.clone(), hub_cfg).unwrap();
    hub_b.register().unwrap();

    let scope = test_scope();
    create_space(&store_a, &scope).await;
    let owner = owner_context(&scope);

    // Create 5-level nested folder tree to exercise 1-RTT PG recursive CTE on WAL & auth.
    let mut parent = None;
    for depth in 0..5u8 {
        let fid = FolderId::from_bytes([210 + depth; 16]);
        store_a
            .create_folder(CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                folder_id: fid.clone(),
                parent,
                slug: format!("lvl-{depth}"),
                display_name: format!("Level {depth}"),
                is_project: false,
                project_slug: None,
                actor: test_owner(),
                timestamp: None,
            })
            .await
            .unwrap();
        parent = Some(fid);
    }

    let n1 = create_note(&store_a, &owner, 211, "Note1.\n", parent.clone()).await;
    let n2 = create_note(&store_a, &owner, 212, "Note2.\n", parent).await;

    // 1. Open n1 on A (A's RoomFenceTable has active=true) and broadcast across
    //    two split-session peers using PG single-statement autocommit CTE.
    let (mut a_ed, _) = synced_client(&hub_a, &owner, &n1.note, 3001).await;
    let (mut a_obs, _) = synced_client(&hub_a, &owner, &n1.note, 3002).await;
    a_ed.send_update(&a_ed.append("FromA.\n")).await;
    a_ed.ack().await;
    a_obs.sync().await;
    assert_eq!(a_obs.text(), "Note1.\nFromA.\n");

    // Verify unhosted active room on A is visible via `read_active_room_pin_info` on B.
    let pin_on_b = store_b
        .read_active_room_pin_info(None, &scope, &n1.note)
        .await
        .unwrap();
    assert!(pin_on_b.is_some(), "PG B must observe A's active room pin");

    // Seed a higher local fence epoch on A for n2 (simulating earlier ownership
    // with a higher local epoch than PG's post-takeover fenced lease_epoch).
    {
        let fence = store_a.room_fences().get_or_init(&scope, &n2.note);
        let mut guard = fence.lock().await;
        for _ in 0..5 {
            guard.open().unwrap();
            guard.close().unwrap();
        }
    }

    // 2. Runtime B takes over Space lease (epoch 2): fences A's n1, recovers & closes n1,
    //    and opens n2 with uncompacted WAL.
    store_b
        .advance_space_lease(
            &maintenance_ctx(ServicePurpose::Revocation),
            &scope,
            LeaseEpoch::new(2).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        store_b
            .room_fences()
            .is_room_fenced(&scope.space_id, &n1.note)
    );
    let rec_b = hub_b
        .recover_fenced_rooms(&maintenance_ctx(ServicePurpose::CollabRecovery), &scope)
        .await
        .unwrap();
    assert_eq!(rec_b, 1);
    assert_eq!(
        note_head(&store_b, &owner, &n1.note).await.1,
        "Note1.\nFromA.\n"
    );

    // Open n2 on B (PG lease_epoch = 1, strictly lower than A's local fence epoch 5!)
    // and write confirmed WAL, leaving n2 active when A takes back over.
    let (mut b_n2, _) = synced_client(&hub_b, &owner, &n2.note, 3020).await;
    b_n2.send_update(&b_n2.append("FromB.\n")).await;
    b_n2.ack().await;

    // 3. Mode 1A & 1B: Runtime A takes back Space lease (epoch 3):
    //    - n1 was active on A earlier, now closed on PG -> A must clear stale active=true!
    //    - n2 is now fenced on PG at lease_epoch 1 -> A must mark n2 fenced even
    //      though A had a higher local fence epoch (5)!
    drop((a_ed, a_obs));
    store_a
        .advance_space_lease(
            &maintenance_ctx(ServicePurpose::Revocation),
            &scope,
            LeaseEpoch::new(3).unwrap(),
        )
        .await
        .unwrap();
    wait_until(async || hub_a.active_room_count() == 0).await;

    // Mode 1A check: direct edit_note on n1 via store_a succeeds without stale active block!
    let n1_cur = note_head(&store_a, &owner, &n1.note).await.1;
    let edit_n1 = edit(
        &owner,
        &n1.note,
        &n1_cur,
        CarrierEditOrigin::Body,
        n1_cur.len(),
        n1_cur.len(),
        "AfterTakeover.\n",
    );
    store_a.edit_note(owner.clone(), edit_n1).await.unwrap();
    assert_eq!(
        note_head(&store_a, &owner, &n1.note).await.1,
        "Note1.\nFromA.\nAfterTakeover.\n"
    );

    // Mode 1B check: n2 is marked fenced on A and recovery settles B's WAL.
    assert!(
        store_a
            .room_fences()
            .is_room_fenced(&scope.space_id, &n2.note),
        "A must seed fenced state for n2 on PG takeover"
    );
    let rec_a = hub_a
        .recover_fenced_rooms(&maintenance_ctx(ServicePurpose::CollabRecovery), &scope)
        .await
        .unwrap();
    assert_eq!(rec_a, 1);
    assert_eq!(
        note_head(&store_a, &owner, &n2.note).await.1,
        "Note2.\nFromB.\n"
    );

    drop(b_n2);
    hub_a.shutdown(&budget()).await.unwrap();
    let _ = hub_b.shutdown(&budget()).await;
    drop((hub_a, hub_b));
    runtime_a.shutdown().await.unwrap();
    runtime_b.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn concurrent_move_folder_during_settle_still_evicts_lost_access_peer() {
    let mut cfg = fast_config();
    cfg.idle_checkpoint = Duration::from_secs(60);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_secs(60);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("move-during-settle", cfg).await;

    let project_a = FolderId::from_bytes([221; 16]);
    let sub_in_project = FolderId::from_bytes([231; 16]);
    let folder_outside = FolderId::from_bytes([222; 16]);
    for (fid, parent, slug, is_project) in [
        (project_a.clone(), None, "proj-a", true),
        (
            sub_in_project.clone(),
            Some(project_a.clone()),
            "sub",
            false,
        ),
        (folder_outside.clone(), None, "outside", false),
    ] {
        store
            .create_folder(CreateFolderSpec {
                scope: owner.scope().clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                folder_id: fid,
                parent,
                slug: slug.into(),
                display_name: slug.into(),
                is_project,
                project_slug: is_project.then(|| slug.into()),
                actor: test_owner(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let note = create_note(
        &store,
        &owner,
        223,
        "Scoped.\n",
        Some(sub_in_project.clone()),
    )
    .await;

    let scoped_peer_ctx = context(
        owner.scope(),
        PrincipalId::from_bytes([224; 16]),
        SpaceRole::Editor,
        Some(project_a.clone()),
    );
    let (mut owner_client, _) = synced_client(&hub, &owner, &note.note, 3101).await;
    let (mut scoped_client, _) = synced_client(&hub, &scoped_peer_ctx, &note.note, 3102).await;

    // Make the room dirty so a subsequent intercepted command settlement emits
    // a self-commit seq right next to `move_folder`.
    owner_client
        .send_update(&owner_client.append("Dirty.\n"))
        .await;
    owner_client.ack().await;

    let move_cmd = mutation(
        &owner,
        MoveFolder {
            folder: sub_in_project.clone(),
            new_parent: Some(folder_outside.clone()),
        },
    );
    let head_body = note_head(&store, &owner, &note.note).await.1;
    let edit_cmd = edit(
        &owner,
        &note.note,
        &head_body,
        CarrierEditOrigin::Body,
        head_body.len(),
        head_body.len(),
        "Concurrent.\n",
    );
    let (move_res, edit_res) = tokio::join!(
        store.move_folder(owner.clone(), move_cmd),
        store.edit_note(owner.clone(), edit_cmd),
    );
    move_res.unwrap();
    let _ = edit_res;

    // The project-scoped peer MUST be proactively evicted with 1008 POLICY even
    // though `move_folder` raced with the room's own settlement/command commit.
    assert_eq!(close_code(&mut scoped_client.peer).await, 1008);

    drop((owner_client, scoped_client));
    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn open_collab_session_rejects_trashed_ancestor_even_with_allow_fenced_recovery() {
    let (_root, store, runtime, hub, owner) =
        open_sqlite_env("open-trashed-ancestor", fast_config()).await;
    let folder = FolderId::from_bytes([225; 16]);
    let f_rev = store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: folder.clone(),
            parent: None,
            slug: "trash-me".into(),
            display_name: "Trash Me".into(),
            is_project: false,
            project_slug: None,
            actor: test_owner(),
            timestamp: None,
        })
        .await
        .unwrap()
        .1;
    let note = create_note(&store, &owner, 226, "Under folder.\n", Some(folder.clone())).await;

    // Trash the folder while no room is open.
    store
        .set_folder_lifecycle(
            owner.scope(),
            LeaseEpoch::new(1).unwrap(),
            &folder,
            &f_rev,
            Lifecycle::Trashed,
            &test_owner(),
            None,
        )
        .await
        .unwrap();

    // Direct `open_collab_session` must reject opening a new/closed room under a
    // trashed ancestor both when `allow_fenced_recovery = false` AND `true`.
    for allow_fenced_recovery in [false, true] {
        let err = store
            .open_collab_session(
                &budget(),
                OpenCollabSession {
                    scope: owner.scope().clone(),
                    note: note.note.clone(),
                    owner_id: "direct-open".into(),
                    expected_carrier_rev: note.revision.clone(),
                    expected_lease: Some(LeaseEpoch::ZERO),
                    expected_lineage: None,
                    initial_yrs_snapshot: Some(vec![0, 0]),
                    allow_fenced_recovery,
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, PortError::Domain(DomainError::ResourceNotFound)),
            "expected ResourceNotFound for allow_fenced_recovery={allow_fenced_recovery}, got {err:?}"
        );
    }

    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn revoke_does_not_fence_live_replacement_room_and_recovery_clears_unsettled() {
    let mut cfg = fast_config();
    cfg.idle_checkpoint = Duration::from_millis(200);
    cfg.periodic_checkpoint = Duration::from_secs(60);
    cfg.idle_unload = Duration::from_millis(200);
    let (_root, store, runtime, hub, owner) = open_sqlite_env("revoke-live-replacement", cfg).await;
    let note = create_note(&store, &owner, 227, "Start.\n", None).await;

    let session_a = AuthSessionId::from_bytes([228; 16]);
    let peer_a_principal = PrincipalId::from_bytes([229; 16]);
    let grant = SpaceGrant {
        role: SpaceRole::Editor,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let verified_a = VerifiedHuman::attest(
        peer_a_principal,
        GrantId::from_bytes(random_bytes_16()),
        BTreeMap::from([(owner.scope().space_id.clone(), grant)]),
        false,
    )
    .with_credential(AuthenticatedCredential::Session(session_a.clone()));
    let ctx_a = SpaceContext::new(
        EngineAuthContext::for_human(verified_a),
        owner.scope().clone(),
        budget(),
    )
    .unwrap();
    let cancel_a = Cancellation::default();
    let sess_a = hub
        .connect(ctx_a, note.note.clone(), test_auth(&cancel_a, None))
        .await
        .unwrap();
    let mut client_a = Client::new(sess_a, 3201);
    client_a.ready(LineageHello::Fresh).await;
    client_a.sync().await;
    client_a.send_update(&client_a.append("FromA.\n")).await;
    client_a.ack().await;

    // Fence R1 while client A is connected, then cancel client A so R1 exits
    // with `settled == false` (leaving pending_revoke_settlement & unsettled_shutdown_rooms).
    let stored = store
        .read_collab_session(None, owner.scope(), &note.note)
        .await
        .unwrap()
        .unwrap()
        .session;
    store
        .fence_collab_session(
            &budget(),
            FenceCollabSession {
                scope: owner.scope().clone(),
                note: note.note.clone(),
                owner_id: stored.owner_id.expect("owner"),
                expected_lease: stored.lease_epoch,
                expected_lineage: stored.lineage_epoch,
            },
        )
        .await
        .unwrap();
    cancel_a.cancel();
    assert_eq!(close_code(&mut client_a.peer).await, 1008);
    wait_until(async || hub.active_room_count() == 0).await;

    // Before revoke(session_a) runs, an unrevoked peer B opens a fresh live room R2
    // on the same note (admit() recovers R1's WAL and spawns R2).
    let (mut client_b, _) = synced_client(&hub, &owner, &note.note, 3202).await;
    assert_eq!(client_b.text(), "Start.\nFromA.\n");

    // Revoking session_a must NOT fence or close live replacement room R2!
    hub.revoke(
        &maintenance_ctx(ServicePurpose::Revocation),
        &RevocationSelector::Session(session_a),
        RevocationReason::Logout,
    )
    .await
    .unwrap();

    // Peer B's live room R2 must remain healthy and continue accepting durable edits.
    client_b.send_update(&client_b.append("FromB.\n")).await;
    client_b.ack().await;
    assert_eq!(hub.active_room_count(), 1);

    drop((client_a, client_b));
    hub.shutdown(&budget()).await.unwrap();
    assert_eq!(
        note_head(&store, &owner, &note.note).await.1,
        "Start.\nFromA.\nFromB.\n"
    );
    drop(hub);
    runtime.shutdown().await.unwrap();
}
