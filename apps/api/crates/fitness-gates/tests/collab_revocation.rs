#![forbid(unsafe_code)]

#[path = "../../notarium-collab/tests/support/mod.rs"]
mod collab_support;
#[allow(dead_code)]
#[path = "../../notarium-control/tests/support/mod.rs"]
mod control_support;

use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use collab_support::{
    Client, StorageTestFixtures, close_code, create_note, note_head, pause_wal_admission,
};
use control_support::{Fixture, budget, command, empty, evidence};
use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CollabRoomState, FenceCollabSession,
    S3BucketModePolicy, blobs::s3::admin_ensure_bucket,
};
use notarium_collab::{
    CollabConfig, CollabHub, CollabSessionAuth,
    wire::{LineageHello, PeerRole},
};
use notarium_control::service::{AuthenticationMode, ControlConfig, ControlService};
use notarium_core::{
    DomainError,
    auth::{SecretString, SpaceKind, SpaceLifecycle},
    epoch::DataRoot,
    error::PortError,
    ids::{AuthSessionId, CommandKey, ControlRevision, InstallationId, SpaceId},
    ports::{
        AccountContext, AccountMutation, AuthEvidenceKind, BootstrapAccount, Cancellation,
        CreateSpace, IssuedSession, MaintenanceContext, PasswordLogin, RevocationSelector,
        ServiceAuthority, ServicePurpose, SessionRevocationPort, SpaceContext,
        SpaceLifecycleChange, control::RunLimits,
    },
};
use tokio::time::{Instant, timeout};

async fn session_auth(
    registry: &Arc<dyn SessionRevocationPort>,
    session: &AuthSessionId,
    space: &SpaceId,
) -> CollabSessionAuth {
    session_auth_until(registry, session, space, None).await
}

async fn session_auth_until(
    registry: &Arc<dyn SessionRevocationPort>,
    session: &AuthSessionId,
    space: &SpaceId,
    expires_at: Option<Instant>,
) -> CollabSessionAuth {
    let cancellation = Cancellation::default();
    let lease = registry
        .register_provider(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                budget: budget(),
            },
            vec![
                RevocationSelector::Session(session.clone()),
                RevocationSelector::Space(space.clone()),
            ],
            cancellation.clone(),
        )
        .await
        .unwrap();
    CollabSessionAuth::new(lease, cancellation, expires_at)
}

async fn archive_space_with_open_room(
    control: &ControlService,
    store: &CanonicalStore,
    hub: &CollabHub,
    registry: &Arc<dyn SessionRevocationPort>,
    session: &IssuedSession,
) {
    let account = || async {
        AccountContext::new(
            control
                .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
                .await
                .unwrap(),
            budget(),
        )
    };
    let principal = &session.account.id;
    let shared = control
        .create_space(
            account().await,
            AccountMutation {
                identity: command(principal, principal, 86, session.account.revision),
                input: CreateSpace {
                    id: SpaceId::from_bytes([86; 16]),
                    kind: SpaceKind::Shared,
                    name: "Collaboration fixture".to_owned(),
                },
            },
        )
        .await
        .unwrap()
        .value
        .history;
    let owner = control
        .admit_space_management(account().await, shared.clone())
        .await
        .unwrap();
    let seed = create_note(store, &owner, 86, "Open space.\n", None).await;
    let auth = session_auth(registry, &session.id, &shared.space_id).await;
    let mut writer = Client::new(
        hub.connect(owner.clone(), seed.note.clone(), auth)
            .await
            .unwrap(),
        307,
    );
    writer.ready(LineageHello::Fresh).await;
    writer.sync().await;
    writer
        .send_update(&writer.append("Confirmed before closing. 🧾\n"))
        .await;
    writer.ack().await;

    // The control plane must also settle WAL whose room lost its owner.
    // Use a different Hub to leave a durable fenced row with no actor
    // registered in the archive operation's collaboration registry.
    let orphan_seed = create_note(store, &owner, 87, "Departed room.\n", None).await;
    let until_archive = Duration::from_secs(120);
    let mut departed_cfg = CollabConfig::default();
    departed_cfg.idle_checkpoint = until_archive;
    departed_cfg.periodic_checkpoint = until_archive;
    departed_cfg.idle_unload = until_archive;
    let departed_hub = CollabHub::new(store.clone(), departed_cfg).unwrap();
    let auth = session_auth(registry, &session.id, &shared.space_id).await;
    let mut departed_writer = Client::new(
        departed_hub
            .connect(owner.clone(), orphan_seed.note.clone(), auth)
            .await
            .unwrap(),
        308,
    );
    departed_writer.ready(LineageHello::Fresh).await;
    departed_writer.sync().await;
    departed_writer
        .send_update(&departed_writer.append("Confirmed before fencing. 🧾\n"))
        .await;
    departed_writer.ack().await;
    let dirty = store
        .read_collab_session(None, &shared, &orphan_seed.note)
        .await
        .unwrap()
        .unwrap();
    assert!(dirty.session.carrier_dirty);
    assert_eq!(dirty.updates.len(), 1);
    let fenced = store
        .fence_collab_session(
            &budget(),
            FenceCollabSession {
                scope: shared.clone(),
                note: orphan_seed.note.clone(),
                owner_id: dirty.session.owner_id.unwrap(),
                expected_lease: dirty.session.lease_epoch,
                expected_lineage: dirty.session.lineage_epoch,
            },
        )
        .await
        .unwrap();
    assert_eq!(fenced.room_state, CollabRoomState::Fenced);
    assert!(fenced.carrier_dirty);
    drop((departed_hub, departed_writer));
    assert_eq!(
        hub.active_room_count(),
        2,
        "the personal room and active shared room remain"
    );

    let archived = control
        .change_space_lifecycle(
            owner,
            SpaceLifecycleChange {
                command: CommandKey::from_bytes([87; 16]),
                lifecycle: SpaceLifecycle::Archived,
                expected: ControlRevision::ZERO,
            },
        )
        .await
        .unwrap();
    assert_eq!(close_code(&mut writer.peer).await, 1008);
    assert_eq!(archived.value.space.lifecycle, SpaceLifecycle::Archived);
    for note in [&seed.note, &orphan_seed.note] {
        let settled = store
            .read_collab_session(None, &shared, note)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settled.session.room_state, CollabRoomState::Closed);
        assert!(!settled.session.carrier_dirty);
        assert!(settled.updates.is_empty());
    }

    let owner = control
        .admit_space_management(account().await, shared.clone())
        .await
        .unwrap();
    control
        .change_space_lifecycle(
            owner,
            SpaceLifecycleChange {
                command: CommandKey::from_bytes([88; 16]),
                lifecycle: SpaceLifecycle::Active,
                expected: archived.revision,
            },
        )
        .await
        .unwrap();
    let owner = SpaceContext::new(account().await.auth().clone(), shared, budget()).unwrap();
    assert_eq!(
        note_head(store, &owner, &seed.note).await.1,
        "Open space.\nConfirmed before closing. 🧾\n",
    );
    assert_eq!(
        note_head(store, &owner, &orphan_seed.note).await.1,
        "Departed room.\nConfirmed before fencing. 🧾\n",
    );
}

async fn logout_with_open_collaboration_session(pg: bool) {
    let fixture = Fixture::new(pg, "collab_revocation").await;
    let storage = pg.then(StorageTestFixtures::load_required);
    let schema = storage.as_ref().map(StorageTestFixtures::fresh_pg_schema);
    let installation = InstallationId::from_bytes([1; 16]);
    let config = if let Some((storage, schema)) = storage.as_ref().zip(schema.as_deref()) {
        let s3 = storage.s3_config(
            storage.fresh_s3_bucket("collab-revoke"),
            S3BucketModePolicy::DetectFromBucket,
        );
        admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
        storage.pg_s3_config(installation, schema, s3)
    } else {
        CanonicalConfig::local_default(installation, DataRoot::new(fixture.root.as_ref().unwrap()))
    };
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let settle_timer = Duration::from_secs(120);
    let mut hub_cfg = notarium_collab::CollabConfig::default();
    hub_cfg.idle_checkpoint = settle_timer;
    hub_cfg.periodic_checkpoint = settle_timer;
    hub_cfg.idle_unload = settle_timer;
    let hub = CollabHub::new(store.clone(), hub_cfg).unwrap();
    hub.register().unwrap();
    let revocations = hub.revocations(fixture.revoker.clone());
    let control = Arc::new(
        ControlService::open(
            fixture.store.clone(),
            Arc::new(store.clone()),
            revocations.clone(),
            fixture.clock.clone(),
            ControlConfig {
                authentication: AuthenticationMode::Password,
                resource_uri: "https://resource.example/".into(),
                max_auth_spaces: 100,
                schedule_limits: RunLimits::HARD_CEILING,
            },
            budget(),
        )
        .await
        .unwrap(),
    );
    let password = || SecretString::new("fixture owner password".to_owned());
    let bootstrapped = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(password()),
            },
        )
        .await
        .unwrap();
    let active = bootstrapped.session.unwrap();
    let other = control
        .login(
            budget(),
            PasswordLogin {
                identifier: "owner".into(),
                password: password(),
            },
        )
        .await
        .unwrap();
    let scope = store
        .read_space(bootstrapped.account.personal_space.as_ref().unwrap())
        .await
        .unwrap()
        .scope;
    let writer = SpaceContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, active.token.expose()))
            .await
            .unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let still_allowed = SpaceContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, other.token.expose()))
            .await
            .unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let seed = create_note(&store, &writer, 19, "Seed.\n", None).await;
    let mut connected = Client::new(
        hub.connect(
            writer.clone(),
            seed.note.clone(),
            session_auth(&revocations, &active.id, &scope.space_id).await,
        )
        .await
        .unwrap(),
        301,
    );
    let mut awaiting_hello = hub
        .connect(
            writer.clone(),
            seed.note.clone(),
            session_auth(&revocations, &active.id, &scope.space_id).await,
        )
        .await
        .unwrap();
    let mut retained = Client::new(
        hub.connect(
            still_allowed.clone(),
            seed.note.clone(),
            session_auth(&revocations, &other.id, &scope.space_id).await,
        )
        .await
        .unwrap(),
        302,
    );
    assert_eq!(
        connected.ready(LineageHello::Fresh).await.role,
        PeerRole::Editor
    );
    connected.sync().await;
    retained.ready(LineageHello::Fresh).await;
    retained.sync().await;

    let draft = "Confirmed before logout 🧾\n";
    connected.send_update(&connected.append(draft)).await;
    connected.ack().await;
    let dirty = store
        .read_collab_session(None, &scope, &seed.note)
        .await
        .unwrap()
        .unwrap();
    assert!(dirty.session.carrier_dirty);
    assert_eq!(dirty.updates.len(), 1);
    assert_eq!(note_head(&store, &writer, &seed.note).await.1, "Seed.\n");

    let (posted, release_wal) = pause_wal_admission(&store);
    connected
        .send_update(&connected.append("Queued before logout, revoked before admission.\n"))
        .await;
    timeout(Duration::from_secs(5), posted)
        .await
        .unwrap()
        .unwrap();

    // Hold only post-commit notification. Reaching it proves that Control
    // can commit while the authorized writer's WAL still awaits settlement.
    let registry = &fixture.revoker;
    registry.gate.store(true, Ordering::SeqCst);
    let logout = tokio::spawn({
        let control = control.clone();
        let token = active.token.expose().to_owned();
        async move {
            control
                .logout(evidence(AuthEvidenceKind::Session, &token))
                .await
        }
    });
    timeout(Duration::from_secs(5), registry.entered.acquire())
        .await
        .expect("revocation cannot wait for a database operation under the session lease")
        .unwrap()
        .forget();
    assert_eq!(close_code(&mut connected.peer).await, 1008);
    assert_eq!(close_code(&mut awaiting_hello).await, 1008);
    assert!(matches!(
        control
            .resolve(evidence(AuthEvidenceKind::Session, active.token.expose()))
            .await,
        Err(PortError::Domain(DomainError::AuthenticationFailed))
    ));
    release_wal.send(()).unwrap();
    registry.release.add_permits(1);
    timeout(Duration::from_secs(5), logout)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let expected = format!("Seed.\n{draft}");
    // Two-phase revocation must settle the room before `logout` returns, even
    // though phase-1 `fence_provider` already evicted the peer registration.
    let saved = store
        .read_collab_session(None, &scope, &seed.note)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !saved.session.carrier_dirty && saved.updates.is_empty(),
        "room must already be settled when logout returns"
    );
    retained.sync().await;
    assert_eq!(retained.text(), expected);
    assert_eq!(
        note_head(&store, &still_allowed, &seed.note).await.1,
        expected
    );
    assert_eq!(hub.active_room_count(), 1);

    // An absolute deadline is enforced at the same queued writer boundary.
    // An unrelated authorization must continue reaching durable ACKs.
    let expires_at = Instant::now() + Duration::from_secs(2);
    let auth = session_auth_until(&revocations, &other.id, &scope.space_id, Some(expires_at)).await;
    let mut expiring = Client::new(
        hub.connect(still_allowed.clone(), seed.note.clone(), auth)
            .await
            .unwrap(),
        309,
    );
    expiring.ready(LineageHello::Fresh).await;
    expiring.sync().await;
    let (posted, release_wal) = pause_wal_admission(&store);
    expiring
        .send_update(&expiring.append("Queued before expiry, expired before admission.\n"))
        .await;
    timeout(Duration::from_secs(5), posted)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(close_code(&mut expiring.peer).await, 1008);
    release_wal.send(()).unwrap();
    let still_writable = "The remaining editor still writes. ✍\n";
    retained.send_update(&retained.append(still_writable)).await;
    assert_eq!(retained.ack().await.room_update_seq, 2);
    retained.sync().await;
    let expected = format!("{expected}{still_writable}");
    assert_eq!(retained.text(), expected);
    let saved = store
        .read_collab_session(None, &scope, &seed.note)
        .await
        .unwrap()
        .unwrap();
    // The permitted suffix may already be checkpointed while the room handles
    // expiry cleanup. In either case, there is at most one new accepted update.
    assert!(saved.updates.len() <= 1);

    registry.gate.store(false, Ordering::SeqCst);
    archive_space_with_open_room(&control, &store, &hub, &revocations, &other).await;
    retained.sync().await;
    assert_eq!(retained.text(), expected);
    assert_eq!(hub.active_room_count(), 1);

    drop((
        connected,
        awaiting_hello,
        retained,
        control,
        revocations,
        hub,
    ));
    runtime.shutdown().await.unwrap();
    fixture.close().await;
    if let Some((storage, schema)) = storage.as_ref().zip(schema.as_deref()) {
        storage.drop_pg_schema(schema).await;
    }
}

#[tokio::test]
async fn sqlite_logout_drains_admitted_session_leases_and_preserves_durable_edits() {
    logout_with_open_collaboration_session(false).await;
}

#[tokio::test]
async fn postgres_logout_drains_admitted_session_leases_and_preserves_durable_edits() {
    logout_with_open_collaboration_session(true).await;
}
