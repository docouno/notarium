#![forbid(unsafe_code)]

#[path = "support/commands.rs"]
mod commands;
#[path = "support/prefix_fallback.rs"]
mod prefix_fallback;
mod support;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak, atomic::Ordering},
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CollabRoomState, CreateFolderSpec,
    S3BucketModePolicy, blobs::s3::admin_ensure_bucket,
};
use notarium_collab::{
    CollabConfig, CollabHub, SessionEvent,
    wire::{self, LineageHello, LineageMismatch, PeerRole, PolicyRejectReason},
};
use notarium_core::{
    DomainError,
    auth::SpaceRole,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::*,
    patch::CarrierEditOrigin,
    ports::{
        BackupParticipantPort, Cancellation, ChatPort, ChatThreadKind, CreateChat, CreateNote,
        ExternalObservation, ExternalObservationResult, FilenamePin, InterceptedMutation,
        InterceptionResult, LiveCollabInterceptor, MoveFolder, NoteWritePort, ObservedContent,
        PortFuture, RevocationReason, RevocationSelector, RollbackReservation, ServicePurpose,
        SpaceContext,
    },
    receipt::{ChangeCursor, CommandIdentity},
};
use notarium_syntax::{carrier::Carrier, content_digest};
use support::*;
use tokio::{
    sync::Barrier,
    time::{Instant, timeout},
};
use yrs::{
    Any, ClientID, Doc, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact,
    Update,
    sync::{AwarenessUpdate, Message, SyncMessage, awareness::AwarenessUpdateEntry},
    updates::{decoder::Decode, encoder::Encode},
};

const BODY: &str = "# Архитектура 🚀\r\n\r\nНачало.\r\n";
const SEED: &str = "---\r\n# first YAML comment\r\nstatus: 'todo' # status comment\r\nquoted: \"unchanged\" # quoted comment\r\nunknown:\r\n  nested: [alpha, beta] # nested comment\r\n---\r\n# Архитектура 🚀\r\n\r\nНачало.\r\n";
const ENCRYPTED: &str = concat!(
    "---\nclass: encrypted-note\ntitle: Sealed note\n---\n# Sealed note\n\n```age\n",
    "-----BEGIN AGE ENCRYPTED FILE-----\n",
    "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBURWlGMHlwcXIrYnB2Y3FY\n",
    "TnlDVkpwTDdPdXdQZFZ3UEw3S1FFYkZET0NjCmhqYWJHWHdTTFE5YzNTNkx3Mmkr\n",
    "UzJUdTJmaXdRSEhzbGJCTjZCNDFGTEUKLS0tIFd5SnA5Ri85Rk9aaDdnSmRoZXEy\n",
    "V0lKY3dIZ1ljOE5JVmgzZGR3aHJjTmcK7s9ix86RtDMnTmjU8vkTTLdMW/73vqpS\n",
    "yPC8DpksHoMx+2Y=\n",
    "-----END AGE ENCRYPTED FILE-----\n",
    "```\n",
);

fn config() -> CollabConfig {
    let mut cfg = CollabConfig::default();
    cfg.idle_checkpoint = Duration::from_millis(100);
    cfg.idle_unload = Duration::from_secs(1);
    cfg
}

async fn latest_session(
    store: &CanonicalStore,
    ctx: &notarium_core::ports::SpaceContext,
    note: &NoteId,
) -> notarium_canonical::CollabSessionSnapshot {
    store
        .read_collab_session(None, ctx.scope(), note)
        .await
        .unwrap()
        .expect("persisted collaborative session")
}

fn header_comments(carrier: &str) -> Vec<&str> {
    let header = Carrier::scan(carrier).unwrap().header.unwrap();
    header
        .slice(carrier)
        .unwrap()
        .split_inclusive('\n')
        .filter_map(|line| line.find('#').map(|start| &line[start..]))
        .collect()
}

struct DuplicateEditGate {
    hub: Weak<CollabHub>,
    key: Mutex<Option<CommandKey>>,
    both: Barrier,
}

impl DuplicateEditGate {
    fn hub(&self) -> Result<Arc<CollabHub>, PortError> {
        self.hub
            .upgrade()
            .ok_or_else(|| DomainError::validation(ValidationReason::NotReady).into())
    }
}

impl LiveCollabInterceptor for DuplicateEditGate {
    fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async move {
            let gated = self.key.lock().unwrap().as_ref() == Some(&request.identity.key);
            if gated {
                timeout(WAIT, self.both.wait())
                    .await
                    .expect("duplicate commands both passed canonical preflight");
            }
            self.hub()?.intercept(request).await
        })
    }

    fn reserve_rollback(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        identity: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        Box::pin(async move { self.hub()?.reserve_rollback(ctx, note, identity).await })
    }

    fn filename_pin(&self, ctx: SpaceContext, note: NoteId) -> PortFuture<'_, FilenamePin> {
        Box::pin(async move { self.hub()?.filename_pin(ctx, note).await })
    }
}

async fn postgres_takeover_in_same_hub(
    store: &CanonicalStore,
    owner: &notarium_core::ports::SpaceContext,
) {
    let seed = create_note(store, owner, 88, "Cloud room.\n", None).await;
    let hub = CollabHub::new(store.clone(), config()).unwrap();
    let (warm, _) = synced_client(&hub, owner, &seed.note, 205).await;
    drop(warm);
    wait_until(async || hub.active_room_count() == 0).await;

    let (mut previous, ready) = synced_client(&hub, owner, &seed.note, 206).await;
    let active = latest_session(store, owner, &seed.note).await;
    assert_eq!(active.session.room_state, CollabRoomState::Active);
    assert!(!active.session.carrier_dirty);
    assert!(active.updates.is_empty());

    // The runtime accepts a new writer epoch while its Hub still owns the
    // old actor in memory. The next connect must not rejoin that stale actor.
    let epoch = LeaseEpoch::new(2).unwrap();
    store
        .advance_space_lease(
            &maintenance_ctx(ServicePurpose::Revocation),
            owner.scope(),
            epoch,
        )
        .await
        .unwrap();
    let (mut current, renewed) = synced_client(&hub, owner, &seed.note, 207).await;
    assert_eq!(close_code(&mut previous.peer).await, 1008);
    assert!(renewed.lease_epoch > ready.lease_epoch);
    assert_eq!(renewed.lineage_epoch, ready.lineage_epoch);
    assert_eq!(renewed.current_rev_id, seed.revision);
    assert_eq!(current.text(), "Cloud room.\n");

    current
        .send_update(&current.append("After takeover. 🌥\n"))
        .await;
    assert_eq!(current.ack().await.lease_epoch, renewed.lease_epoch);
    assert_eq!(hub.active_room_count(), 1);
    drop(current);
    wait_until(async || hub.active_room_count() == 0).await;
    assert_eq!(
        note_head(store, owner, &seed.note).await.1,
        "Cloud room.\nAfter takeover. 🌥\n"
    );
}

async fn lost_open_reply_keeps_direct_edit_available(
    store: &CanonicalStore,
    hub: &CollabHub,
    owner: &SpaceContext,
) {
    let original = "Before uncertain open.\n";
    let note = create_note(store, owner, 89, original, None).await.note;
    store
        .writer_faults()
        .unwrap()
        .drop_room_open_response_once
        .store(true, Ordering::SeqCst);
    let mut failed = open(hub, owner, &note).await;
    failed.send(LineageHello::Fresh.encode()).await.unwrap();
    assert_eq!(close_code(&mut failed).await, 1011);
    assert_eq!(hub.active_room_count(), 0);
    assert!(
        store
            .read_collab_session(None, owner.scope(), &note)
            .await
            .unwrap()
            .is_some()
    );

    // The open reached storage but no actor became active. A direct command
    // alone must be able to resolve the durable fence for this note.
    let appended = "Direct edit after failed Hello.\n";
    let committed = store
        .edit_note(
            owner.clone(),
            edit(
                owner,
                &note,
                original,
                CarrierEditOrigin::Body,
                original.len(),
                original.len(),
                appended,
            ),
        )
        .await
        .unwrap();
    let settled = latest_session(store, owner, &note).await;
    assert_eq!(settled.session.room_state, CollabRoomState::Closed);
    assert_eq!(settled.session.carrier_rev_id, committed.value.revision);
    assert_eq!(
        note_head(store, owner, &note).await.1,
        format!("{original}{appended}")
    );
}

async fn live_collab_end_to_end_contract(store: &CanonicalStore, pg: bool) {
    let scope = test_scope();
    create_space(store, &scope).await;
    let owner = owner_context(&scope);
    if pg {
        postgres_takeover_in_same_hub(store, &owner).await;
    }
    policy_edges(store).await;
    let editor = context(
        &scope,
        PrincipalId::from_bytes([27; 16]),
        SpaceRole::Editor,
        None,
    );
    let viewer = context(
        &scope,
        PrincipalId::from_bytes([28; 16]),
        SpaceRole::Viewer,
        None,
    );
    let mut cfg = CollabConfig::default();
    cfg.checkpoint_updates = 2;
    cfg.idle_checkpoint = Duration::from_secs(2);
    cfg.idle_unload = Duration::from_secs(3);
    let hub = Arc::new(CollabHub::new(store.clone(), cfg).unwrap());
    let duplicate_gate = Arc::new(DuplicateEditGate {
        hub: Arc::downgrade(&hub),
        key: Mutex::new(None),
        both: Barrier::new(2),
    });
    store
        .register_collab_interceptor(duplicate_gate.clone())
        .unwrap();
    lost_open_reply_keeps_direct_edit_available(store, &hub, &owner).await;
    let seed = create_note(store, &owner, 60, SEED, None).await;
    let other = create_note(store, &owner, 61, "Another note.\n", None).await;
    let note = seed.note;
    let (mut first, ready) = synced_client(&hub, &owner, &note, 101).await;
    let (mut second, second_ready) = synced_client(&hub, &editor, &note, 102).await;
    let (mut read_only, read_only_ready) = synced_client(&hub, &viewer, &note, 103).await;

    assert_eq!(hub.active_room_count(), 1);
    assert_eq!(ready.history_incarnation, scope.incarnation);
    assert_eq!(ready.current_rev_id, seed.revision);
    assert_eq!(ready.role, PeerRole::Editor);
    assert!(ready.fm_writable);
    assert_eq!(second_ready.lease_epoch, ready.lease_epoch);
    assert_eq!(read_only_ready.role, PeerRole::Viewer);
    assert_eq!(first.text(), BODY);
    assert_eq!(second.text(), BODY);
    assert_eq!(read_only.text(), BODY);
    let pinned = hub.filename_pin(owner.clone(), note.clone()).await.unwrap();
    assert!(matches!(
        pinned,
        FilenamePin::Pinned { note: id, filename, lease }
            if id == note && filename == "collab-note-60" && lease == ready.lease_epoch
    ));
    let before_viewer_traffic = latest_session(store, &owner, &note).await;
    let before_viewer_space_seq = store.read_space(&scope.space_id).await.unwrap().last_seq;

    // One transport packet may contain a discarded Viewer write followed by a
    // legitimate read. Regaining a response also establishes processing order.
    let forged = read_only.append("viewer-injected\n");
    let mut frame = wire::encode_update(&forged);
    frame.extend_from_slice(&empty_sync());
    read_only.peer.send(frame).await.unwrap();
    read_only
        .until(|message| matches!(message, Message::Sync(SyncMessage::SyncStep2(_))))
        .await;
    assert_eq!(latest_session(store, &owner, &note).await.updates.len(), 0);
    first.sync().await;
    assert_eq!(first.text(), BODY);

    let presence = AwarenessUpdate {
        clients: HashMap::from([(
            ClientID::new(103),
            AwarenessUpdateEntry {
                clock: 1,
                json: r#"{"cursor":{"anchor":4,"head":4}}"#.into(),
            },
        )]),
    };
    read_only
        .peer
        .send(Message::Awareness(presence.clone()).encode_v1())
        .await
        .unwrap();
    let event = first
        .until(|message| matches!(message, Message::Awareness(_)))
        .await;
    assert_eq!(event, Message::Awareness(presence));
    assert_eq!(
        latest_session(store, &owner, &note).await,
        before_viewer_traffic
    );
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before_viewer_space_seq
    );
    drop(read_only);

    let comments = header_comments(SEED);
    let mut last_revision = seed.revision.clone();
    for round in 0..50u32 {
        // Offsets straddle the surrogate pair and are deliberately different
        // between the two writers. They prepare their operations independently.
        let rocket_start = "# Архитектура ".encode_utf16().count() as u32;
        let frontmatter = match round % 4 {
            0 => Any::from("todo"),
            1 => Any::from("done"),
            2 => Any::from(HashMap::from([("$unset".to_owned(), Any::Bool(true))])),
            _ => Any::from("active"),
        };
        let a = first.update(|txn| {
            first.body.insert(txn, rocket_start, "я");
            first.fields.insert(txn, "status", frontmatter);
        });
        let b = second.append("界\r\n");
        tokio::join!(first.send_update(&a), second.send_update(&b));
        let (left, right) = tokio::join!(first.ack(), second.ack());
        assert_eq!(left.lease_epoch, ready.lease_epoch);
        assert_eq!(left.peer_write_seq, u64::from(round + 1));
        assert_eq!(right.peer_write_seq, u64::from(round + 1));
        assert_ne!(left.room_update_seq, right.room_update_seq);
        wait_until(async || {
            let saved = latest_session(store, &owner, &note).await;
            !saved.session.carrier_dirty
                && saved.updates.is_empty()
                && saved.session.carrier_rev_id != last_revision
        })
        .await;
        let (revision, carrier) = note_head(store, &owner, &note).await;
        assert_eq!(header_comments(&carrier), comments);
        assert!(carrier.contains("quoted: \"unchanged\""));
        assert!(carrier.contains("unknown:\r\n  nested: [alpha, beta]"));
        if round % 4 == 2 {
            assert!(!carrier.contains("status:"));
        }
        let body = Carrier::scan(&carrier)
            .unwrap()
            .body
            .slice(&carrier)
            .unwrap();
        let ((), ()) = tokio::join!(first.sync(), second.sync());
        assert_eq!(first.text(), body);
        assert_eq!(second.text(), body);
        assert_eq!(body.matches('界').count(), (round + 1) as usize);
        assert_eq!(body.matches('я').count(), (round + 1) as usize);
        assert_eq!(body.matches('🚀').count(), 1);
        last_revision = revision;
    }

    // Two consecutive frontmatter-only edits exercise snapshot replacement
    // at the same WAL sequence. No peer update separates the two commits.
    let (mut canonical_revision, mut canonical) = note_head(store, &owner, &note).await;
    let peer_text = "Concurrent browser edit. 🌿\r\n";
    first.send_update(&first.append(peer_text)).await;
    first.ack().await;
    assert!(
        latest_session(store, &owner, &note)
            .await
            .session
            .carrier_dirty
    );
    for (old, new) in [("\"unchanged\"", "\"first\""), ("\"first\"", "\"second\"")] {
        let at = canonical.find(old).unwrap();
        let command = edit(
            &owner,
            &note,
            &canonical,
            CarrierEditOrigin::Header,
            at,
            at + old.len(),
            new,
        );
        let (committed, replay) = if old == "\"unchanged\"" {
            // Force both calls through preflight before either reaches the
            // real room actor, so the second must replay an exact receipt.
            *duplicate_gate.key.lock().unwrap() = Some(command.identity.key.clone());
            let replies = tokio::join!(
                store.edit_note(owner.clone(), command.clone()),
                store.edit_note(owner.clone(), command),
            );
            (replies.0.unwrap(), replies.1.unwrap())
        } else {
            let committed = store
                .edit_note(owner.clone(), command.clone())
                .await
                .unwrap();
            let replay = store.edit_note(owner.clone(), command).await.unwrap();
            (committed, replay)
        };
        assert_eq!(committed.receipt, replay.receipt);
        assert_eq!(committed.value, replay.value);
        (canonical_revision, canonical) = note_head(store, &owner, &note).await;
        assert_eq!(committed.value.revision, canonical_revision);
        assert_eq!(header_comments(&canonical), comments);
        assert!(canonical.ends_with(peer_text));
    }
    first.sync().await;
    assert_eq!(
        first.fields.get(&first.doc.transact(), "quoted"),
        Some(Out::Any(Any::from("second"))),
    );

    // An external observed revision enters the same room, whose existing
    // peer sees the exact carrier edit through y-sync without reopening.
    let external = format!("{canonical}Внешний источник. 🌍\r\n");
    let observation = mutation(
        &owner,
        ExternalObservation {
            note: note.clone(),
            observed_digest: content_digest(&external),
            base_revision: canonical_revision,
            disk_identity: content_digest("disk-file"),
            content: ObservedContent::Carrier(external.clone()),
        },
    );
    assert!(matches!(
        store
            .accept_external_observation(owner.clone(), observation)
            .await
            .unwrap(),
        ExternalObservationResult::Committed(_)
    ));
    first.sync().await;
    assert!(first.text().ends_with("Внешний источник. 🌍\r\n"));
    assert_eq!(note_head(store, &owner, &note).await.1, external);

    // A rejected write cannot influence the other participants or reach WAL.
    let forbidden = first.update(|txn| {
        first.fields.insert(txn, "class", "skill");
    });
    first.send_update(&forbidden).await;
    let rejected = first
        .until(|message| matches!(message, Message::Custom(wire::POLICY_REJECTED, _)))
        .await;
    let Message::Custom(_, payload) = rejected else {
        unreachable!()
    };
    assert_eq!(
        payload[1],
        PolicyRejectReason::ProtectedFrontmatterKey as u8
    );
    assert_eq!(close_code(&mut first.peer).await, 1008);
    second.sync().await;
    let forbidden_delete = second.update(|txn| {
        assert!(second.fields.remove(txn, "status").is_some());
    });
    second.send_update(&forbidden_delete).await;
    let rejected = second
        .until(|message| matches!(message, Message::Custom(wire::POLICY_REJECTED, _)))
        .await;
    let Message::Custom(_, payload) = rejected else {
        unreachable!()
    };
    assert_eq!(payload[1], PolicyRejectReason::FrontmatterKeyDeleted as u8);
    assert_eq!(close_code(&mut second.peer).await, 1008);
    assert!(
        latest_session(store, &owner, &note)
            .await
            .updates
            .is_empty()
    );

    // A genuine reconnect to the same lineage retains the causal seed.
    let mut live_again = Client::new(open(&hub, &owner, &note).await, 105);
    let unchanged = live_again
        .ready(LineageHello::Reconnect {
            client_history_incarnation: ready.history_incarnation,
            client_lineage_epoch: ready.lineage_epoch,
            client_base_rev_id: Some(seed.revision.clone()),
        })
        .await;
    assert_eq!(unchanged.lineage_epoch, ready.lineage_epoch);
    live_again.sync().await;
    assert!(live_again.text().ends_with("Внешний источник. 🌍\r\n"));
    drop(live_again);
    wait_until(async || hub.active_room_count() == 0).await;

    let (old_rev, carrier) = note_head(store, &owner, &note).await;
    let out_of_band = store
        .edit_note(
            owner.clone(),
            edit(
                &owner,
                &note,
                &carrier,
                CarrierEditOrigin::Body,
                carrier.len(),
                carrier.len(),
                "Вне комнаты.\r\n",
            ),
        )
        .await
        .unwrap();
    let stale = latest_session(store, &owner, &note).await.session;
    assert_eq!(stale.room_state, CollabRoomState::Closed);
    assert!(stale.lineage_epoch > ready.lineage_epoch);

    // A known revision belonging to this note can be disclosed as the merge
    // ancestor. A valid revision ID from another note is never echoed.
    for base in [old_rev.clone(), other.revision] {
        let mut offline = open(&hub, &owner, &note).await;
        offline
            .send(
                LineageHello::Reconnect {
                    client_history_incarnation: ready.history_incarnation,
                    client_lineage_epoch: ready.lineage_epoch,
                    client_base_rev_id: Some(base.clone()),
                }
                .encode(),
            )
            .await
            .unwrap();
        let expected = LineageMismatch {
            current_history_incarnation: ready.history_incarnation,
            current_rev_id: out_of_band.value.revision.clone(),
            current_lineage_epoch: stale.lineage_epoch,
            verified_base_rev_id: (base == old_rev).then_some(base),
        };
        match recv(&mut offline).await {
            SessionEvent::Binary(frame) => assert_eq!(frame, expected.encode()),
            other => panic!("expected lineage mismatch, got {other:?}"),
        }
        assert_eq!(close_code(&mut offline).await, 4409);
        assert_eq!(hub.active_room_count(), 0);
    }

    let (mut after_direct, _) = synced_client(&hub, &owner, &note, 107).await;
    assert_eq!(after_direct.text().matches("Архитектура").count(), 1);
    assert_eq!(after_direct.text().matches("Вне комнаты.").count(), 1);

    commands::board_move(store, &hub, &owner).await;
    commands::rollback(store, &hub, &owner, false).await;
    commands::rollback(store, &hub, &owner, true).await;

    // Restore can rebind a Space to a different history with the same stored
    // revision, note and CRDT lineage counter.
    let cutoff = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let replacement_scope = notarium_core::model::HistoryScope {
        space_id: scope.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes([108; 16]),
    };
    store
        .restore_cursors(
            maintenance_ctx(ServicePurpose::Restore),
            vec![ChangeCursor {
                scope: replacement_scope.clone(),
                after: cutoff,
            }],
        )
        .await
        .unwrap();
    assert_eq!(close_code(&mut after_direct.peer).await, 1008);
    let current_ctx = owner_context(&replacement_scope);
    let after_restore = latest_session(store, &current_ctx, &note).await.session;
    assert_eq!(after_restore.lineage_epoch, stale.lineage_epoch);
    let mut offline = open(&hub, &current_ctx, &note).await;
    offline
        .send(
            LineageHello::Reconnect {
                client_history_incarnation: scope.incarnation,
                client_lineage_epoch: stale.lineage_epoch,
                client_base_rev_id: Some(after_restore.carrier_rev_id.clone()),
            }
            .encode(),
        )
        .await
        .unwrap();
    let expected = LineageMismatch {
        current_history_incarnation: replacement_scope.incarnation,
        current_rev_id: after_restore.carrier_rev_id,
        current_lineage_epoch: after_restore.lineage_epoch,
        verified_base_rev_id: None,
    };
    match recv(&mut offline).await {
        SessionEvent::Binary(frame) => assert_eq!(frame, expected.encode()),
        other => panic!("expected lineage mismatch after restore, got {other:?}"),
    }
    assert_eq!(close_code(&mut offline).await, 4409);
}

async fn note_scope_eviction(store: &CanonicalStore, hub: &CollabHub) {
    let scope = test_scope();
    let owner = owner_context(&scope);
    let root = store.read_space(&scope.space_id).await.unwrap();
    let project = FolderId::from_bytes([121; 16]);
    let branch = FolderId::from_bytes([122; 16]);
    for (id, parent, slug, is_project) in [
        (project.clone(), None, "project", true),
        (branch.clone(), Some(project.clone()), "branch", false),
    ] {
        store
            .create_folder(CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: root.active_epoch,
                folder_id: id,
                parent,
                slug: slug.to_owned(),
                display_name: slug.to_owned(),
                is_project,
                project_slug: is_project.then(|| slug.to_owned()),
                actor: test_owner(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let seed = create_note(
        store,
        &owner,
        109,
        "Initial body 🧭\n",
        Some(branch.clone()),
    )
    .await;
    let scoped = context(
        &scope,
        PrincipalId::from_bytes([121; 16]),
        SpaceRole::Viewer,
        Some(project),
    );
    let editor = context(
        &scope,
        PrincipalId::from_bytes([122; 16]),
        SpaceRole::Editor,
        None,
    );
    let viewer = context(
        &scope,
        PrincipalId::from_bytes([124; 16]),
        SpaceRole::Viewer,
        None,
    );
    let (mut owner_peer, _) = synced_client(hub, &owner, &seed.note, 121).await;
    let (mut evicted, _) = synced_client(hub, &scoped, &seed.note, 122).await;
    let (mut editor, _) = synced_client(hub, &editor, &seed.note, 123).await;
    let (mut retained, ready) = synced_client(hub, &viewer, &seed.note, 124).await;
    assert_eq!(ready.role, PeerRole::Viewer);
    // The marker is sent in the same frame after the read. Seeing it on the
    // retained peer proves the scoped peer already has a SyncStep2 queued.
    let marker = Message::Awareness(AwarenessUpdate {
        clients: HashMap::from([(
            ClientID::new(122),
            AwarenessUpdateEntry {
                clock: 1,
                json: r#"{"queueMarker":true}"#.into(),
            },
        )]),
    });
    let mut read_then_mark = empty_sync();
    read_then_mark.extend(marker.encode_v1());
    evicted.peer.send(read_then_mark).await.unwrap();
    retained.until(|message| message == &marker).await;

    // Pause the actor before admitting another write. This holds a writer
    // queue permit and leaves database authority transactions free to commit.
    let (posted, release) = pause_wal_admission(store);
    let allowed = "Owner still writes after ancestry changes.\n";
    owner_peer.send_update(&owner_peer.append(allowed)).await;
    timeout(WAIT, posted).await.unwrap().unwrap();
    store
        .move_folder(
            owner.clone(),
            mutation(
                &owner,
                MoveFolder {
                    folder: branch.clone(),
                    new_parent: None,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(note_head(store, &owner, &seed.note).await.0, seed.revision);
    // The actor cannot process the storage notification while paused. The
    // reader's fresh outbound check must refuse the already queued response.
    assert_eq!(close_code(&mut evicted.peer).await, 1008);
    release.send(()).unwrap();
    owner_peer.ack().await;
    retained.sync().await;

    store
        .set_folder_write_lock(owner.clone(), branch.clone(), true)
        .await
        .unwrap();
    assert_eq!(close_code(&mut editor.peer).await, 1008);
    assert_eq!(close_code(&mut owner_peer.peer).await, 1008);
    // The already admitted Viewer retains read access after the lock.
    retained.sync().await;
    assert_eq!(retained.text(), format!("Initial body 🧭\n{allowed}"));
}

async fn rejected_update_keeps_the_accepted_prefix(
    store: &CanonicalStore,
    hub: &CollabHub,
    owner: &SpaceContext,
) {
    let original = "Original body.\n";
    let accepted = "Accepted prefix. 🚀\n";
    let note = create_note(store, owner, 93, original, None).await.note;
    let (mut author, _) = synced_client(hub, owner, &note, 402).await;
    let (mut observer, _) = synced_client(hub, owner, &note, 403).await;
    let prefix = author.append(accepted);

    // Another client's suffix can apply after the prefix without depending
    // on the forbidden update's client clock, so rejecting it tests the
    // packet cutoff even if a later update would otherwise be admissible.
    let prefixed_state = author
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let mut options = Options::with_client_id(ClientID::new(404));
    options.offset_kind = OffsetKind::Utf16;
    let suffix_doc = Doc::with_options(options);
    let body = suffix_doc.get_or_insert_text("body");
    suffix_doc
        .transact_mut()
        .apply_update(Update::decode_v1(&prefixed_state).unwrap())
        .unwrap();
    let suffix = {
        let mut txn = suffix_doc.transact_mut();
        let end = body.len(&txn);
        body.insert(&mut txn, end, "Do not apply this suffix.\n");
        txn.encode_update_v1()
    };
    let forbidden = author.update(|txn| {
        author.fields.insert(txn, "class", "skill");
    });
    let mut packet = wire::encode_update(&prefix);
    packet.extend(wire::encode_update(&forbidden));
    packet.extend(wire::encode_update(&suffix));

    let (posted, release) = pause_wal_admission(store);
    author.peer.send(packet).await.unwrap();
    timeout(WAIT, posted).await.unwrap().unwrap();
    assert!(latest_session(store, owner, &note).await.updates.is_empty());
    assert!(
        author
            .peer
            .send(vec![0; wire::MAX_FRAME_BYTES + 1])
            .await
            .is_err(),
        "the rejected author cannot replace the pending policy close with 1009"
    );
    // The writer pause holds no database lock. An eager terminal frame
    // could finish its outbound authorization and drop the lease here.
    assert!(
        timeout(Duration::from_secs(1), author.peer.recv())
            .await
            .is_err(),
        "terminal delivery must wait for the already accepted WAL prefix"
    );
    release.send(()).unwrap();

    // Keep the author parked until the actor has published the batch and
    // checkpointed it. By then the author's session is already draining.
    observer
        .until(|message| matches!(message, Message::Sync(SyncMessage::Update(_))))
        .await;
    wait_until(async || {
        let settled = latest_session(store, owner, &note).await;
        !settled.session.carrier_dirty && settled.updates.is_empty()
    })
    .await;
    let SessionEvent::Binary(frame) = recv(&mut author.peer).await else {
        panic!("expected the committed prefix before the terminal frame");
    };
    let parsed = messages(&frame);
    assert!(matches!(
        parsed.first(),
        Some(Message::Sync(SyncMessage::Update(update))) if update == &prefix
    ));
    let ack = match parsed.get(1) {
        Some(Message::Custom(wire::SERVER_ACK_WATERMARK, payload)) => decode_ack(payload),
        _ => decode_ack(&custom(&mut author.peer, wire::SERVER_ACK_WATERMARK).await),
    };
    assert_eq!(ack.peer_write_seq, 1);
    assert_eq!(ack.room_update_seq, 1);
    let payload = custom(&mut author.peer, wire::POLICY_REJECTED).await;
    assert_eq!(
        payload[1],
        PolicyRejectReason::ProtectedFrontmatterKey as u8
    );
    assert_eq!(close_code(&mut author.peer).await, 1008);

    observer.sync().await;
    let expected = format!("{original}{accepted}");
    assert_eq!(observer.text(), expected);
    assert!(
        observer
            .fields
            .get(&observer.doc.transact(), "class")
            .is_none()
    );
    assert_eq!(note_head(store, owner, &note).await.1, expected);
}

async fn revocation_overrides_queued_policy_output(
    store: &CanonicalStore,
    hub: &CollabHub,
    owner: &SpaceContext,
) {
    let note = create_note(store, owner, 95, "Selective revoke.\n", None)
        .await
        .note;
    let principal = PrincipalId::from_bytes([125; 16]);
    let editor = context(owner.scope(), principal.clone(), SpaceRole::Editor, None);
    let (mut author, _) = synced_client(hub, &editor, &note, 405).await;
    let (mut observer, _) = synced_client(hub, owner, &note, 406).await;

    let presence = Message::Awareness(AwarenessUpdate {
        clients: HashMap::from([(
            ClientID::new(405),
            AwarenessUpdateEntry {
                clock: 1,
                json: r#"{"editing":true}"#.into(),
            },
        )]),
    });
    author.peer.send(presence.encode_v1()).await.unwrap();
    observer.until(|message| message == &presence).await;
    let prefix = author.append("Persist before revoke.\n");
    let forbidden = author.update(|txn| {
        author.fields.insert(txn, "class", "skill");
    });
    let mut packet = wire::encode_update(&prefix);
    packet.extend(wire::encode_update(&forbidden));
    author.peer.send(packet).await.unwrap();

    // Wait for the actor to reap the sender. An unaffected observer keeps the
    // room lease current while a selector alone revokes the queued output.
    observer
        .until(|message| {
            matches!(message, Message::Awareness(update) if update.clients
                .get(&ClientID::new(405)).is_some_and(|entry| entry.json.as_ref() == "null"))
        })
        .await;
    hub.revoke(
        &maintenance_ctx(ServicePurpose::Revocation),
        &RevocationSelector::Principal(principal),
        RevocationReason::Logout,
    )
    .await
    .unwrap();

    assert_eq!(close_code(&mut author.peer).await, 1008);
    observer.sync().await;
    assert_eq!(
        observer.text(),
        "Selective revoke.\nPersist before revoke.\n"
    );
}

async fn policy_edges(store: &CanonicalStore) {
    let scope = test_scope();
    let owner = owner_context(&scope);
    let hub = CollabHub::new(store.clone(), config()).unwrap();

    for (seed, class, carrier) in [
        (
            82,
            DocClass::AgentMemory,
            "---\nclass: agent-memory\n---\nMemory.\n",
        ),
        (
            83,
            DocClass::Profile,
            "---\nclass: profile\n---\nProfile.\n",
        ),
        (84, DocClass::Skill, "---\nclass: skill\n---\nSkill.\n"),
        (85, DocClass::EncryptedNote, ENCRYPTED),
    ] {
        let note = NoteId::from_bytes([seed; 16]);
        store
            .create_note(
                owner.clone(),
                mutation(
                    &owner,
                    CreateNote {
                        note: note.clone(),
                        parent: None,
                        slug: format!("non-collaborative-{seed}"),
                        class,
                        carrier: carrier.into(),
                    },
                ),
            )
            .await
            .unwrap();
        assert!(matches!(
            hub.connect(owner.clone(), note.clone(), test_auth(&Cancellation::default(), None)).await,
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::ClassMismatch
        ));
        assert!(
            store
                .read_collab_session(None, &scope, &note)
                .await
                .unwrap()
                .is_none()
        );
    }
    store
        .create_chat(
            owner.clone(),
            mutation(
                &owner,
                CreateChat {
                    thread: ChatThreadId::from_bytes([86; 16]),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: test_owner(),
                    project_folder: None,
                    title: "Thread without a note carrier".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let chat_as_note = NoteId::from_bytes([86; 16]);
    assert!(matches!(
        hub.connect(
            owner.clone(),
            chat_as_note,
            test_auth(&Cancellation::default(), None)
        )
        .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    let note = create_note(store, &owner, 90, "Cold room.\n", None)
        .await
        .note;
    let mut connecting = tokio::task::JoinSet::new();
    for client_id in 300..320 {
        let (hub, owner, note) = (hub.clone(), owner.clone(), note.clone());
        connecting.spawn(async move {
            let mut client = Client::new(open(&hub, &owner, &note).await, client_id);
            let ready = client.ready(LineageHello::Fresh).await;
            (client, ready)
        });
    }
    let mut connected = Vec::new();
    while let Some(joined) = connecting.join_next().await {
        connected.push(joined.unwrap());
    }
    let (mut writer, ready) = connected.pop().unwrap();
    assert_eq!(connected.len(), 19);
    assert!(
        connected
            .iter()
            .all(|(_, peer)| peer.lease_epoch == ready.lease_epoch)
    );
    assert_eq!(hub.active_room_count(), 1);
    let (mut observer, _) = connected.pop().unwrap();
    drop(connected);

    // Each update after the first references a preceding struct in the same
    // payload. The staged prefix must remain visible across all six, and
    // dispatching them cannot overflow a healthy peer's delivery queue.
    writer.sync().await;
    observer.sync().await;
    let mut packet = Vec::new();
    for digit in ["1", "2", "3", "4", "5", "6"] {
        packet.extend(wire::encode_update(&writer.append(digit)));
    }
    writer.peer.send(packet).await.unwrap();
    let mut acks = Vec::new();
    while acks.len() < 6 {
        let SessionEvent::Binary(frame) = recv(&mut writer.peer).await else {
            panic!("expected durable ACKs for all six accepted updates");
        };
        acks.extend(
            messages(&frame)
                .into_iter()
                .filter_map(|message| match message {
                    Message::Custom(wire::SERVER_ACK_WATERMARK, payload) => {
                        Some(decode_ack(&payload))
                    }
                    _ => None,
                }),
        );
    }
    assert_eq!(
        acks.iter()
            .map(|ack| ack.peer_write_seq)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6]
    );
    assert_eq!(
        acks.iter()
            .map(|ack| ack.room_update_seq)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6]
    );
    writer.sync().await;
    observer.sync().await;
    assert_eq!(writer.text(), "Cold room.\n123456");
    assert_eq!(observer.text(), writer.text());
    wait_until(async || {
        !latest_session(store, &owner, &note)
            .await
            .session
            .carrier_dirty
    })
    .await;
    assert_eq!(
        note_head(store, &owner, &note).await.1,
        "Cold room.\n123456"
    );
    drop((writer, observer));

    let alias_carrier = "---\nanchor: &same yes\nalias: *same\n---\nProse.\n";
    let note = create_note(store, &owner, 91, alias_carrier, None)
        .await
        .note;
    let (mut client, ready) = synced_client(&hub, &owner, &note, 401).await;
    assert!(!ready.fm_writable);
    client.send_update(&client.append("Continues.\n")).await;
    client.ack().await;
    wait_until(async || {
        !latest_session(store, &owner, &note)
            .await
            .session
            .carrier_dirty
    })
    .await;
    assert_eq!(
        note_head(store, &owner, &note).await.1,
        format!("{alias_carrier}Continues.\n")
    );
    client
        .send_update(&client.update(|txn| {
            client.fields.insert(txn, "status", "done");
        }))
        .await;
    let rejected = client
        .until(|message| matches!(message, Message::Custom(wire::POLICY_REJECTED, _)))
        .await;
    let Message::Custom(_, payload) = rejected else {
        unreachable!()
    };
    assert_eq!(payload[1], PolicyRejectReason::FrontmatterNotWritable as u8);
    assert_eq!(close_code(&mut client.peer).await, 1008);

    let note = create_note(store, &owner, 92, "Pending.\n", None)
        .await
        .note;
    let expiry = Instant::now() + Duration::from_secs(1);
    let mut expires = hub
        .connect(
            owner.clone(),
            note.clone(),
            test_auth(&notarium_core::ports::Cancellation::default(), Some(expiry)),
        )
        .await
        .unwrap();
    assert_eq!(close_code(&mut expires).await, 1008);
    assert!(
        store
            .read_collab_session(None, &scope, &note)
            .await
            .unwrap()
            .is_none()
    );

    let mut too_large = open(&hub, &owner, &note).await;
    let _ = too_large.send(vec![0; wire::MAX_FRAME_BYTES + 1]).await;
    assert_eq!(close_code(&mut too_large).await, 1009);
    assert!(
        store
            .read_collab_session(None, &scope, &note)
            .await
            .unwrap()
            .is_none()
    );

    note_scope_eviction(store, &hub).await;
    rejected_update_keeps_the_accepted_prefix(store, &hub, &owner).await;
    revocation_overrides_queued_policy_output(store, &hub, &owner).await;
    prefix_fallback::check(store, &owner).await;
    wait_until(async || hub.active_room_count() == 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_collaboration() {
    let root = TempDataRoot::new("collab-end-to-end");
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes([16; 16]), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    live_collab_end_to_end_contract(&store, false).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_minio_collaboration() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("collab-contract");
    let s3 = fixtures.s3_config(bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let config = fixtures.pg_s3_config(InstallationId::from_bytes([17; 16]), &schema, s3);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    live_collab_end_to_end_contract(&store, true).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
