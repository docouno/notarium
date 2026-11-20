#![forbid(unsafe_code)]

mod support;

use std::{
    collections::BTreeMap,
    future::poll_fn,
    pin::pin,
    sync::{Arc, atomic::Ordering},
    task::Poll,
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
    LiveDenseLookup, LiveNoteStatus, ProjectionErasures, ProjectionVisibilityCleanup, SpaceRecord,
    StoppedProjectionOwner,
    changes::SyntheticNoteSpec,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::{CommitEffect, PortError, ValidationReason},
    ids::{CommandKey, ContentDigest, GrantId, LeaseEpoch, NoteId, ProjectionGeneration, SpaceSeq},
    model::Lifecycle,
    ports::{
        ChangeBroadcast, ChangeNotice, DeleteDisposition, DeleteNote, Mutation, NoteWritePort,
        PortFuture, Preconditions, ServicePurpose, SpaceContext,
    },
    receipt::{ChangeCursor, CommandIdentity},
};
use tokio::sync::Notify;

use support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_note_id, sample_principal_id,
    sample_space_id,
};

struct OneNote(NoteId, Option<ProjectionGeneration>);

#[derive(Default)]
struct HeldCleanup {
    purged: std::sync::Mutex<Vec<NoteId>>,
    started: Notify,
    complete: Notify,
}

impl ProjectionVisibilityCleanup for HeldCleanup {
    fn erase_visibility<'a>(&'a self, erasures: &'a ProjectionErasures) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.purged
                .lock()
                .unwrap()
                .extend_from_slice(&erasures.purged);
            self.started.notify_one();
            self.complete.notified().await;
            Ok(())
        })
    }
}

impl LiveDenseLookup for OneNote {
    fn slots(&self) -> u32 {
        1
    }

    fn dense_id(&self, note: &NoteId) -> Option<u32> {
        (note == &self.0).then_some(0)
    }

    fn generation(&self) -> Option<ProjectionGeneration> {
        self.1
    }
}

async fn create_space(store: &CanonicalStore, seed: u8) -> SpaceRecord {
    store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed),
            incarnation: sample_incarnation(seed),
            root_folder_id: sample_folder_id(seed),
            slug: format!("visibility-space-{seed}"),
            kind: SpaceKind::Shared,
            owner: sample_principal_id(seed),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
}

fn owner_ctx(record: &SpaceRecord) -> SpaceContext {
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        record.owner.clone(),
        GrantId::from_bytes([18; 16]),
        BTreeMap::from([(
            record.space.id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        false,
    ));
    SpaceContext::new(
        auth,
        record.scope.clone(),
        maintenance_ctx(ServicePurpose::Projection).budget,
    )
    .unwrap()
}

async fn folder_and_note(
    store: &CanonicalStore,
    record: &SpaceRecord,
) -> (
    notarium_core::ids::FolderId,
    notarium_core::ids::RevisionId,
    NoteId,
) {
    let folder = sample_folder_id(21);
    let (_, revision, _) = store
        .create_folder(CreateFolderSpec {
            scope: record.scope.clone(),
            active_epoch: record.active_epoch,
            folder_id: folder.clone(),
            parent: Some(record.root_folder_id.clone()),
            slug: "projection".to_owned(),
            display_name: "Projection".to_owned(),
            is_project: false,
            project_slug: None,
            actor: record.owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let note = sample_note_id(22);
    store
        .commit_synthetic_note_batch_for_test(
            &record.scope,
            record.active_epoch,
            &record.owner,
            vec![SyntheticNoteSpec {
                note_id: note.clone(),
                parent_folder: Some(folder.clone()),
                slug: "member".to_owned(),
                title: "Member".to_owned(),
                doc_class: DocClass::UserDoc,
                lifecycle: Lifecycle::Active,
                carrier: "# Member\nBody".to_owned(),
                fields: BTreeMap::new(),
            }],
        )
        .await
        .unwrap();
    (folder, revision, note)
}

async fn verify_folder_lifecycle(
    store: &CanonicalStore,
    record: &SpaceRecord,
) -> notarium_canonical::LiveSpaceHandle {
    let (folder, revision, note) = folder_and_note(store, record).await;
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let held = store
        .admit_projection_space_with_lookup(
            &projection,
            &record.scope,
            Arc::new(OneNote(note.clone(), None)),
        )
        .await
        .unwrap();
    let ctx = owner_ctx(record);
    {
        let view = held.try_read().unwrap();
        assert!(matches!(
            view.classify(&ctx, &note, true).unwrap(),
            LiveNoteStatus::ActiveVisible(_)
        ));
        assert_eq!(view.memory_usage().dense_slots, 1);
        assert_eq!(view.memory_usage().delta_notes, 0);
    }

    let initial_cut = held.try_read().unwrap().head();
    let mut changes = store
        .subscribe(
            projection.clone(),
            ChangeCursor {
                scope: record.scope.clone(),
                after: initial_cut,
            },
        )
        .await
        .unwrap();
    let (observed_commit, resume) = store.pause_next_visibility_commit_for_test();
    let worker = store.clone();
    let scope = record.scope.clone();
    let active_epoch = record.active_epoch;
    let folder_to_trash = folder.clone();
    let actor = record.owner.clone();
    let caller = tokio::spawn(async move {
        worker
            .set_folder_lifecycle(
                &scope,
                active_epoch,
                &folder_to_trash,
                &revision,
                Lifecycle::Trashed,
                &actor,
                None,
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), observed_commit)
        .await
        .unwrap()
        .unwrap();
    let trashed_cut = initial_cut.checked_next().unwrap();
    assert_eq!(
        store
            .get_space(&record.scope.space_id)
            .await
            .unwrap()
            .last_seq,
        trashed_cut
    );
    assert!(
        held.try_read().is_err(),
        "the confirmed SQL change still holds the delivery gate"
    );
    assert!(!caller.is_finished());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    resume.send(()).unwrap();

    let notice = tokio::time::timeout(Duration::from_secs(3), changes.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(notice, ChangeNotice::Advanced(cursor) if cursor.after == trashed_cut));
    let trashed_revision = store
        .read_entity_revision_at_cutoff(&record.scope, "folder", folder.as_str(), Some(trashed_cut))
        .await
        .unwrap()
        .unwrap()
        .revision_id;
    {
        let view = held.read(&projection.budget).await.unwrap();
        assert_eq!(view.head(), trashed_cut);
        assert_eq!(
            view.classify(&ctx, &note, true).unwrap(),
            LiveNoteStatus::PurgedOrAbsent
        );
        assert!(matches!(
            view.classify(&ctx, &note, false).unwrap(),
            LiveNoteStatus::TrashedVisible(_)
        ));
    }
    store
        .set_folder_lifecycle(
            &record.scope,
            record.active_epoch,
            &folder,
            &trashed_revision,
            Lifecycle::Active,
            &record.owner,
            None,
        )
        .await
        .unwrap();
    assert!(matches!(
        held.try_read()
            .unwrap()
            .classify(&ctx, &note, true)
            .unwrap(),
        LiveNoteStatus::ActiveVisible(_)
    ));
    held
}

#[tokio::test]
async fn sqlite_fence_remains_current_and_releases_old_handles() {
    let root = TempDataRoot::new("projection-visibility-sqlite");
    let config = CanonicalConfig::local_default(sample_installation_id(23), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let space = create_space(&store, 24).await;
    let held = verify_folder_lifecycle(&store, &space).await;

    let projection = maintenance_ctx(ServicePurpose::Projection);
    store
        .suspend_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    assert!(held.try_read().is_err());
    let reopened = store
        .admit_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    assert!(reopened.try_read().is_ok());
    assert!(held.try_read().is_err());

    let note = sample_note_id(22);
    store
        .commit_synthetic_note_purge_for_test(&space.scope, space.active_epoch, &note)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .try_read()
            .unwrap()
            .classify(&owner_ctx(&space), &note, true)
            .unwrap(),
        LiveNoteStatus::PurgedOrAbsent,
    );

    runtime.shutdown().await.unwrap();
    assert!(reopened.try_read().is_err());
}

#[tokio::test]
async fn a_late_lookup_cannot_replace_a_promoted_or_retired_generation() {
    let root = TempDataRoot::new("projection-lookup-monotonicity");
    let config = CanonicalConfig::local_default(sample_installation_id(37), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let space = create_space(&store, 37).await;
    let (_, _, note) = folder_and_note(&store, &space).await;
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let bind = |generation| {
        store.admit_projection_space_with_lookup(
            &projection,
            &space.scope,
            Arc::new(OneNote(
                note.clone(),
                Some(ProjectionGeneration::new(generation).unwrap()),
            )),
        )
    };

    let serving = bind(2).await.unwrap();
    assert_validation_err(&bind(1).await.map(|_| ()), ValidationReason::NotReady);
    assert!(serving.try_read().is_ok());

    let cleanup = Arc::new(HeldCleanup::default());
    cleanup.complete.notify_one();
    store
        .set_projection_visibility_cleanup(&projection, cleanup)
        .unwrap();
    store
        .commit_synthetic_note_purge_for_test(&space.scope, space.active_epoch, &note)
        .await
        .unwrap();
    assert!(serving.try_read().is_err());
    assert_validation_err(&bind(1).await.map(|_| ()), ValidationReason::NotReady);
    assert!(serving.try_read().is_err());

    // Pre-purge snapshots must not be re-admitted once purge retired the fence.
    struct StaleSeqLookup(NoteId);
    impl LiveDenseLookup for StaleSeqLookup {
        fn generation(&self) -> Option<ProjectionGeneration> {
            Some(ProjectionGeneration::new(2).unwrap())
        }
        fn published_seq(&self) -> Option<SpaceSeq> {
            Some(SpaceSeq::ZERO)
        }
        fn slots(&self) -> u32 {
            1
        }
        fn dense_id(&self, note: &NoteId) -> Option<u32> {
            (*note == self.0).then_some(0)
        }
    }
    assert_validation_err(
        &store
            .admit_projection_space_with_lookup(
                &projection,
                &space.scope,
                Arc::new(StaleSeqLookup(note.clone())),
            )
            .await
            .map(|_| ()),
        ValidationReason::NotReady,
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn purge_waits_for_derived_erasure_even_when_space_is_suspended() {
    let root = TempDataRoot::new("projection-erase-sqlite");
    let config = CanonicalConfig::local_default(sample_installation_id(31), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let space = create_space(&store, 31).await;
    let (_, _, note) = folder_and_note(&store, &space).await;
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let held = store
        .admit_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    store
        .suspend_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    let cleanup = Arc::new(HeldCleanup::default());
    store
        .set_projection_visibility_cleanup(&projection, cleanup.clone())
        .unwrap();

    let writer = store.clone();
    let target = note.clone();
    let scope = space.scope.clone();
    let epoch = space.active_epoch;
    let committing = tokio::spawn(async move {
        writer
            .commit_synthetic_note_purge_for_test(&scope, epoch, &target)
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), cleanup.started.notified())
        .await
        .unwrap();
    assert_eq!(*cleanup.purged.lock().unwrap(), vec![note.clone()]);
    assert!(held.try_read().is_err());
    assert!(!committing.is_finished());
    cleanup.complete.notify_one();
    committing.await.unwrap().unwrap();

    let fresh = store
        .admit_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    assert_eq!(
        fresh
            .try_read()
            .unwrap()
            .classify(&owner_ctx(&space), &note, true)
            .unwrap(),
        LiveNoteStatus::PurgedOrAbsent,
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn cold_purge_receipt_repairs_derived_erasure_after_lost_commit_reply() {
    let root = TempDataRoot::new("projection-erase-unknown-sqlite");
    let config = CanonicalConfig::local_default(sample_installation_id(34), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let space = create_space(&store, 34).await;
    let (_, _, note) = folder_and_note(&store, &space).await;
    let revision = store
        .read_entity_revision_at_cutoff(&space.scope, "note", note.as_str(), None)
        .await
        .unwrap()
        .unwrap()
        .revision_id;
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let cleanup = Arc::new(HeldCleanup::default());
    store
        .set_projection_visibility_cleanup(&projection, cleanup.clone())
        .unwrap();
    let mutation = Mutation {
        identity: CommandIdentity {
            scope: space.scope.clone(),
            actor: space.owner.clone(),
            key: CommandKey::from_bytes([35; 16]),
            hash: ContentDigest::from_bytes([36; 32]),
        },
        preconditions: Preconditions {
            revision: Some(revision),
            ..Default::default()
        },
        input: DeleteNote {
            note: note.clone(),
            disposition: DeleteDisposition::Purge,
        },
    };
    store
        .writer_faults()
        .unwrap()
        .drop_commit_response_once
        .store(true, Ordering::SeqCst);
    let initial = store.delete_note(owner_ctx(&space), mutation.clone()).await;
    assert!(matches!(
        initial,
        Err(PortError::Unavailable(failure)) if failure.effect() == CommitEffect::Unknown
    ));
    assert!(cleanup.purged.lock().unwrap().is_empty());

    let worker = store.clone();
    let ctx = owner_ctx(&space);
    let retry = tokio::spawn(async move { worker.delete_note(ctx, mutation).await });
    tokio::time::timeout(Duration::from_secs(3), cleanup.started.notified())
        .await
        .unwrap();
    assert_eq!(*cleanup.purged.lock().unwrap(), vec![note]);
    assert!(!retry.is_finished());
    cleanup.complete.notify_one();
    retry.await.unwrap().unwrap();
    runtime.shutdown().await.unwrap();
}

fn queued_owner_write(space: &SpaceRecord) -> PreparedWriteIntent {
    let root = space.root_folder_id.clone();
    PreparedWriteIntent {
        scope: space.scope.clone(),
        active_epoch: space.active_epoch,
        idempotency: None,
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |_, ctx| {
            Box::pin(async move {
                let seq = ctx.alloc_next_seq()?;
                Ok(ItemCommitArtifacts {
                    command_id: notarium_canonical::codec::new_prefixed_hex_id("cmd_")?,
                    command_kind: "projection_owner_drain_test".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "folder".to_owned(),
                        entity_id: root.to_string(),
                        op_kind: "edit".to_owned(),
                        rev_id: notarium_canonical::codec::new_revision_id()?,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: None,
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: Vec::new(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: CanonicalStore::encode_command_outcome(&seq.get())?,
                })
            })
        }),
    }
}

#[tokio::test]
async fn postgres_next_epoch_requires_the_previous_runtime_to_drain() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let installation = sample_installation_id(25);
    let local_a = TempDataRoot::new("projection-owner-pg-a");
    let local_b = TempDataRoot::new("projection-owner-pg-b");
    let first_config = fixtures.pg_local_config(installation.clone(), &schema, local_a.data_root());
    let second_config = fixtures.pg_local_config(installation, &schema, local_b.data_root());
    let (first, first_runtime) = CanonicalRuntime::open(first_config).await.unwrap();
    let (second, second_runtime) = CanonicalRuntime::open(second_config).await.unwrap();
    let space = create_space(&first, 26).await;
    let handle = verify_folder_lifecycle(&first, &space).await;
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let revocation = maintenance_ctx(ServicePurpose::Revocation);
    let next_epoch = space.active_epoch.checked_next().unwrap();
    let old_identity = first
        .projection_owner_identity(&revocation, &space.scope)
        .await
        .unwrap()
        .unwrap();

    let denied = second
        .admit_projection_space(&projection, &space.scope)
        .await;
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::NotReady
    ));
    let safe_point = first.acquire_writer_safe_point().await.unwrap();
    let permit = handle.try_read().unwrap();
    let old_head = permit.head();
    let mut drain = pin!(first.drain_projection_owner(&revocation, &space.scope));
    poll_fn(|cx| {
        assert!(drain.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(first.live_visibility_fence().space(&space.scope).is_err());

    // Zero staged bytes and an empty mailbox make the first pending poll the
    // reply wait. The command has passed its early local lease check while
    // drain holds the topology gate and waits for the old delivery permit.
    let budget = maintenance_ctx(ServicePurpose::Projection).budget;
    let mut queued =
        pin!(first.submit_fixture_write_command::<u64>(&budget, queued_owner_write(&space)));
    poll_fn(|cx| {
        assert!(queued.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;

    let before_ack = second
        .advance_space_lease(&revocation, &space.scope, next_epoch)
        .await;
    assert_validation_err(&before_ack, ValidationReason::NotReady);
    drop(permit);
    tokio::time::timeout(Duration::from_secs(3), drain)
        .await
        .unwrap()
        .unwrap();
    drop(safe_point);
    let denied = tokio::time::timeout(Duration::from_secs(3), queued)
        .await
        .unwrap();
    assert_validation_err(&denied, ValidationReason::InvalidAuthority);
    let drained = second.get_space(&space.space.id).await.unwrap();
    assert_eq!(drained.last_seq, old_head);
    assert_eq!(drained.active_epoch, space.active_epoch);
    assert!(handle.try_read().is_err());

    second
        .advance_space_lease(&revocation, &space.scope, next_epoch)
        .await
        .unwrap();
    let new_owner = second
        .admit_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    assert!(new_owner.try_read().is_ok());
    assert!(handle.try_read().is_err());
    assert!(
        first
            .admit_projection_space(&projection, &space.scope)
            .await
            .is_err()
    );

    assert!(
        second
            .confirm_projection_owner_stopped(
                &revocation,
                StoppedProjectionOwner::attest(old_identity),
            )
            .await
            .is_err()
    );
    let replacement_identity = first
        .projection_owner_identity(&revocation, &space.scope)
        .await
        .unwrap()
        .unwrap();
    second_runtime.shutdown().await.unwrap();
    assert!(new_owner.try_read().is_err());
    let third_epoch = next_epoch.checked_next().unwrap();
    assert_validation_err(
        &first
            .advance_space_lease(&revocation, &space.scope, third_epoch)
            .await,
        ValidationReason::NotReady,
    );
    first
        .confirm_projection_owner_stopped(
            &revocation,
            StoppedProjectionOwner::attest(replacement_identity),
        )
        .await
        .unwrap();
    first
        .advance_space_lease(&revocation, &space.scope, third_epoch)
        .await
        .unwrap();
    first_runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn suspend_revokes_queued_writer_gate_and_re_admission_observes_post_write_state() {
    let dir = TempDataRoot::new("projection-suspend-race");
    let config = CanonicalConfig::local_default(sample_installation_id(31), dir.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let space = create_space(&store, 31).await;
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let handle = store
        .admit_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    let actor = sample_principal_id(31);
    let owner = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            actor.clone(),
            GrantId::from_bytes([31; 16]),
            BTreeMap::from([(
                space.space.id.clone(),
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                },
            )]),
            true,
        )),
        space.scope.clone(),
        projection.budget.clone(),
    )
    .unwrap();
    let note = sample_note_id(31);
    store
        .create_note(
            owner.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([30; 16]),
                    hash: ContentDigest::from_bytes([30; 32]),
                },
                preconditions: Preconditions::default(),
                input: notarium_core::ports::CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "race-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Race Note\n".into(),
                },
            },
        )
        .await
        .unwrap();

    // Hold a live read permit so suspend_projection_space queues on the old gate,
    // then submit a purge that queues behind suspend on that same gate.
    let permit = handle.try_read().unwrap();
    let mut suspend = pin!(store.suspend_projection_space(&projection, &space.scope));
    poll_fn(|cx| {
        assert!(suspend.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;

    let mut purge = pin!(store.delete_note(
        owner.clone(),
        Mutation {
            identity: CommandIdentity {
                scope: space.scope.clone(),
                actor: actor.clone(),
                key: CommandKey::from_bytes([31; 16]),
                hash: ContentDigest::from_bytes([31; 32]),
            },
            preconditions: Preconditions::default(),
            input: DeleteNote {
                note: note.clone(),
                disposition: DeleteDisposition::Purge,
            },
        },
    ));
    poll_fn(|cx| {
        let _ = purge.as_mut().poll(cx);
        Poll::Ready(())
    })
    .await;

    drop(permit);
    tokio::time::timeout(Duration::from_secs(3), suspend)
        .await
        .unwrap()
        .unwrap();
    let purged = tokio::time::timeout(Duration::from_secs(3), purge)
        .await
        .unwrap()
        .unwrap();

    // Re-admitting after suspend + purge must observe the purged state, never stale pre-purge state.
    let fresh = store
        .admit_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    let fresh_permit = fresh.try_read().unwrap();
    assert!(fresh_permit.head() >= purged.receipt.seq());
    assert!(matches!(
        fresh_permit.classify(&owner, &note, false).unwrap(),
        LiveNoteStatus::PurgedOrAbsent
    ));
    drop(fresh_permit);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn postgres_drain_blocks_concurrent_re_admission_and_single_conn_pool_never_deadlocks() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let dir = TempDataRoot::new("projection-pg-single-conn");
    let mut config = fixtures.pg_local_config(sample_installation_id(32), &schema, dir.data_root());
    if let notarium_canonical::SqlBackendConfig::Postgres {
        ref mut pool_size, ..
    } = config.sql
    {
        *pool_size = 1;
    }
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let space = create_space(&store, 32).await;
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let revocation = maintenance_ctx(ServicePurpose::Revocation);
    let actor = sample_principal_id(32);
    let owner = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            actor.clone(),
            GrantId::from_bytes([32; 16]),
            BTreeMap::from([(
                space.space.id.clone(),
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                },
            )]),
            true,
        )),
        space.scope.clone(),
        projection.budget.clone(),
    )
    .unwrap();

    // Cleanup hook that fails once on the first purge while space is suspended (creating
    // cleanup_debt), then succeeds on the subsequent write on a 1-connection pool.
    struct FailOnceCleanup {
        failed_once: std::sync::atomic::AtomicBool,
        calls: std::sync::atomic::AtomicUsize,
    }
    impl ProjectionVisibilityCleanup for FailOnceCleanup {
        fn erase_visibility<'a>(&'a self, _erasures: &'a ProjectionErasures) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                if !self.failed_once.swap(true, Ordering::SeqCst) {
                    return Err(PortError::Domain(DomainError::validation(
                        ValidationReason::NotReady,
                    )));
                }
                Ok(())
            })
        }
    }
    let cleanup = Arc::new(FailOnceCleanup {
        failed_once: std::sync::atomic::AtomicBool::new(false),
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    store
        .set_projection_visibility_cleanup(&projection, cleanup.clone())
        .unwrap();

    let handle = store
        .admit_projection_space(&projection, &space.scope)
        .await
        .unwrap();

    // 1. Failing single-item write on pool_size = 1 must return ResourceNotFound, never UnknownCommit.
    let missing = sample_note_id(99);
    let err = store
        .delete_note(
            owner.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([33; 16]),
                    hash: ContentDigest::from_bytes([33; 32]),
                },
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: missing,
                    disposition: DeleteDisposition::Trash,
                },
            },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, PortError::Domain(DomainError::ResourceNotFound)),
        "expected ResourceNotFound on pool_size=1 failed write, got {err:?}"
    );

    // 2. Idempotent replay on pool_size = 1 must succeed cleanly without UnknownCommit.
    let note_a = sample_note_id(34);
    let create_cmd = Mutation {
        identity: CommandIdentity {
            scope: space.scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([34; 16]),
            hash: ContentDigest::from_bytes([34; 32]),
        },
        preconditions: Preconditions::default(),
        input: notarium_core::ports::CreateNote {
            note: note_a.clone(),
            parent: None,
            slug: "pool-one-a".into(),
            class: DocClass::UserDoc,
            carrier: "# Pool One A\n".into(),
        },
    };
    let created = store
        .create_note(owner.clone(), create_cmd.clone())
        .await
        .unwrap();
    let replayed = store.create_note(owner.clone(), create_cmd).await.unwrap();
    assert_eq!(created.receipt.seq(), replayed.receipt.seq());

    // 3. Suspend space, purge note_a (cleanup fails once -> records cleanup_debt), then commit
    //    note_b on pool_size = 1: writer must drop cached_pg_conn before draining cleanup_debt
    //    and return Ok (not UnknownCommit).
    store
        .suspend_projection_space(&projection, &space.scope)
        .await
        .unwrap();
    let purge_err = store
        .delete_note(
            owner.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([35; 16]),
                    hash: ContentDigest::from_bytes([35; 32]),
                },
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: note_a,
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            purge_err,
            PortError::Unavailable(ref failure) if failure.effect() == CommitEffect::Unknown
        ),
        "expected UnknownCommit when cleanup hook fails once, got {purge_err:?}"
    );
    assert_eq!(cleanup.calls.load(Ordering::SeqCst), 1);

    let note_b = sample_note_id(36);
    store
        .create_note(
            owner.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([36; 16]),
                    hash: ContentDigest::from_bytes([36; 32]),
                },
                preconditions: Preconditions::default(),
                input: notarium_core::ports::CreateNote {
                    note: note_b,
                    parent: None,
                    slug: "pool-one-b".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Pool One B\n".into(),
                },
            },
        )
        .await
        .expect("subsequent write draining cleanup_debt on pool_size=1 must not self-deadlock");
    assert!(cleanup.calls.load(Ordering::SeqCst) >= 2);

    // 4. Re-admit the suspended space concurrently with another write on pool_size = 1.
    drop(handle);
    let note_c = sample_note_id(37);
    let (admit_live, write_c) = tokio::join!(
        store.admit_projection_space(&projection, &space.scope),
        store.create_note(
            owner.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([37; 16]),
                    hash: ContentDigest::from_bytes([37; 32]),
                },
                preconditions: Preconditions::default(),
                input: notarium_core::ports::CreateNote {
                    note: note_c,
                    parent: None,
                    slug: "pool-one-c".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Pool One C\n".into(),
                },
            },
        ),
    );
    let live_handle =
        admit_live.expect("admit racing write on pool_size=1 must not AB-BA deadlock");
    write_c.expect("write racing admit on pool_size=1 must not AB-BA deadlock");

    // 5. Race fresh admit_projection_space attempts across the entire drain_projection_owner
    //    window (including after gate revocation while set_owner_phase("draining") runs).
    let permit = live_handle.try_read().unwrap();
    let mut drain = pin!(store.drain_projection_owner(&revocation, &space.scope));
    poll_fn(|cx| {
        assert!(drain.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(permit);
    let store_admit = store.clone();
    let scope_admit = space.scope.clone();
    let proj_admit = projection.clone();
    let drain_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let drain_done_bg = Arc::clone(&drain_done);
    let racer = tokio::spawn(async move {
        let mut reopened = false;
        while !drain_done_bg.load(Ordering::Acquire) {
            if store_admit
                .admit_projection_space(&proj_admit, &scope_admit)
                .await
                .is_ok()
            {
                reopened = true;
            }
            tokio::task::yield_now().await;
        }
        reopened
    });
    drain.await.unwrap();
    drain_done.store(true, Ordering::Release);
    let reopened = racer.await.unwrap();
    assert!(
        !reopened,
        "concurrent admit_projection_space must never reopen admission during drain_projection_owner"
    );
    assert!(store.live_visibility_fence().space(&space.scope).is_err());

    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn postgres_multi_space_pool_size_two_concurrent_purges_never_self_deadlock() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let dir = TempDataRoot::new("projection-pg-pool-two");
    let mut config = fixtures.pg_local_config(sample_installation_id(38), &schema, dir.data_root());
    if let notarium_canonical::SqlBackendConfig::Postgres {
        ref mut pool_size, ..
    } = config.sql
    {
        *pool_size = 2;
    }
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let projection = maintenance_ctx(ServicePurpose::Projection);

    struct CountingCleanup {
        calls: std::sync::atomic::AtomicUsize,
    }
    impl ProjectionVisibilityCleanup for CountingCleanup {
        fn erase_visibility<'a>(&'a self, _erasures: &'a ProjectionErasures) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    let cleanup = Arc::new(CountingCleanup {
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    store
        .set_projection_visibility_cleanup(&projection, cleanup.clone())
        .unwrap();

    let space_a = create_space(&store, 38).await;
    let space_b = create_space(&store, 39).await;
    let _handle_a = store
        .admit_projection_space(&projection, &space_a.scope)
        .await
        .unwrap();
    let _handle_b = store
        .admit_projection_space(&projection, &space_b.scope)
        .await
        .unwrap();

    let make_owner = |space: &SpaceRecord, seed: u8| {
        let actor = sample_principal_id(seed);
        (
            actor.clone(),
            SpaceContext::new(
                EngineAuthContext::for_human(VerifiedHuman::attest(
                    actor,
                    GrantId::from_bytes([seed; 16]),
                    BTreeMap::from([(
                        space.space.id.clone(),
                        SpaceGrant {
                            role: SpaceRole::Owner,
                            read_classes: DocClass::all(),
                            write_classes: DocClass::all(),
                            project_root: None,
                        },
                    )]),
                    true,
                )),
                space.scope.clone(),
                projection.budget.clone(),
            )
            .unwrap(),
        )
    };
    let (actor_a, owner_a) = make_owner(&space_a, 38);
    let (actor_b, owner_b) = make_owner(&space_b, 39);

    for round in 0u8..6 {
        let note_a = sample_note_id(100 + round);
        let note_b = sample_note_id(150 + round);
        let (ca, cb) = tokio::join!(
            store.create_note(
                owner_a.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: space_a.scope.clone(),
                        actor: actor_a.clone(),
                        key: CommandKey::from_bytes([100 + round; 16]),
                        hash: ContentDigest::from_bytes([100 + round; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: notarium_core::ports::CreateNote {
                        note: note_a.clone(),
                        parent: None,
                        slug: format!("p2-a-{round}"),
                        class: DocClass::UserDoc,
                        carrier: "# A\n".into(),
                    },
                },
            ),
            store.create_note(
                owner_b.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: space_b.scope.clone(),
                        actor: actor_b.clone(),
                        key: CommandKey::from_bytes([150 + round; 16]),
                        hash: ContentDigest::from_bytes([150 + round; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: notarium_core::ports::CreateNote {
                        note: note_b.clone(),
                        parent: None,
                        slug: format!("p2-b-{round}"),
                        class: DocClass::UserDoc,
                        carrier: "# B\n".into(),
                    },
                },
            ),
        );
        ca.expect("concurrent create on space A with pool_size=2 must succeed");
        cb.expect("concurrent create on space B with pool_size=2 must succeed");

        let (pa, pb) = tokio::join!(
            store.delete_note(
                owner_a.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: space_a.scope.clone(),
                        actor: actor_a.clone(),
                        key: CommandKey::from_bytes([200 + round; 16]),
                        hash: ContentDigest::from_bytes([200 + round; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: DeleteNote {
                        note: note_a,
                        disposition: DeleteDisposition::Purge,
                    },
                },
            ),
            store.delete_note(
                owner_b.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: space_b.scope.clone(),
                        actor: actor_b.clone(),
                        key: CommandKey::from_bytes([220 + round; 16]),
                        hash: ContentDigest::from_bytes([220 + round; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: DeleteNote {
                        note: note_b,
                        disposition: DeleteDisposition::Purge,
                    },
                },
            ),
        );
        pa.expect("concurrent purge on space A with pool_size=2 must not self-deadlock");
        pb.expect("concurrent purge on space B with pool_size=2 must not self-deadlock");
        assert!(
            store
                .live_visibility_fence()
                .try_read(&space_a.scope)
                .is_ok(),
            "space A fence dropped readable after round {round}"
        );
        assert!(
            store
                .live_visibility_fence()
                .try_read(&space_b.scope)
                .is_ok(),
            "space B fence dropped readable after round {round}"
        );
    }

    assert!(
        cleanup.calls.load(Ordering::SeqCst) >= 12,
        "expected cleanup hook to run on all 6 rounds x 2 spaces, got {}",
        cleanup.calls.load(Ordering::SeqCst)
    );
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn postgres_pool_size_one_back_to_back_writes_racing_admit_never_abba_deadlock() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let dir = TempDataRoot::new("projection-pg-pool-one-abba");
    let mut config = fixtures.pg_local_config(sample_installation_id(42), &schema, dir.data_root());
    if let notarium_canonical::SqlBackendConfig::Postgres {
        ref mut pool_size, ..
    } = config.sql
    {
        *pool_size = 1;
    }
    // max_batch_items = 1 with zero flush window guarantees back-to-back writes
    // enter flush_single_batch with !rx.is_empty() and cached_pg_conn = Some(...).
    config.writer.max_batch_items = 1;
    config.writer.batch_flush_window = Duration::ZERO;

    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let projection = maintenance_ctx(ServicePurpose::Projection);

    for round in 0u8..4 {
        let space = create_space(&store, 50 + round).await;

        // Queue 6 direct WriteBatchActor commands alongside admit_projection_space on a
        // non-admitted space (needs_storage_read == false, zero pre-enqueue pool reads).
        // Batch #1 retains cached_pg_conn across the non-empty queue while admit acquires
        // gate.write() and awaits pool.acquire().
        let outcome = tokio::time::timeout(Duration::from_secs(3), async {
            let mut writers = Vec::with_capacity(6);
            for _ in 0..6 {
                let store = store.clone();
                let budget = projection.budget.clone();
                let space_rec = space.clone();
                writers.push(tokio::spawn(async move {
                    store
                        .submit_fixture_write_command::<u64>(
                            &budget,
                            queued_owner_write(&space_rec),
                        )
                        .await
                }));
            }
            tokio::task::yield_now().await;
            let admit = store
                .admit_projection_space(&projection, &space.scope)
                .await;
            let mut results = Vec::with_capacity(6);
            for w in writers {
                results.push(w.await.unwrap());
            }
            (admit, results)
        })
        .await
        .unwrap_or_else(|_| {
            panic!("round {round} AB-BA deadlocked between cached_pg_conn and admit")
        });

        let handle = outcome
            .0
            .expect("admit racing back-to-back writes on pool_size=1 must succeed");
        for (idx, res) in outcome.1.into_iter().enumerate() {
            res.unwrap_or_else(|err| {
                panic!("round {round} write {idx} racing admit on pool_size=1 failed: {err:?}")
            });
        }
        assert!(handle.try_read().is_ok());
    }

    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn postgres_multi_space_trickle_writes_never_starve_admit() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let dir = TempDataRoot::new("projection-pg-pool-three-trickle");
    let mut config = fixtures.pg_local_config(sample_installation_id(60), &schema, dir.data_root());
    if let notarium_canonical::SqlBackendConfig::Postgres {
        ref mut pool_size, ..
    } = config.sql
    {
        // pool_size = 3 (> 2): 3 per-Space WriteBatchActor workers = 100% of the pool if
        // idle workers retain cached_pg_conn across the 50ms idle receive timeout.
        *pool_size = 3;
    }
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let revocation = maintenance_ctx(ServicePurpose::Revocation);

    let trickle_spaces = [
        create_space(&store, 61).await,
        create_space(&store, 62).await,
        create_space(&store, 63).await,
    ];
    let target_spaces = [
        create_space(&store, 64).await,
        create_space(&store, 65).await,
        create_space(&store, 66).await,
    ];

    // Start 3 trickle writers (one per space, every 15ms < 50ms idle worker timeout) using
    // direct WriteBatchActor submissions (no pre-enqueue pool read). If idle workers retained
    // cached_pg_conn on pool_size >= 3, all 3 sockets would remain pinned indefinitely and
    // starve admit/drain on target_spaces past the 1s timeout.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ready = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut handles = Vec::new();
    for (idx, space) in trickle_spaces.iter().enumerate() {
        let space_rec = space.clone();
        let store = store.clone();
        let budget = projection.budget.clone();
        let stop = Arc::clone(&stop);
        let ready = Arc::clone(&ready);
        handles.push(tokio::spawn(async move {
            let mut seq = 0u32;
            while !stop.load(Ordering::Acquire) {
                seq += 1;
                store
                    .submit_fixture_write_command::<u64>(&budget, queued_owner_write(&space_rec))
                    .await
                    .unwrap_or_else(|err| panic!("trickle writer {idx} seq {seq} failed: {err:?}"));
                if seq == 1 {
                    ready.fetch_add(1, Ordering::Release);
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        }));
    }

    tokio::time::timeout(Duration::from_secs(2), async {
        while ready.load(Ordering::Acquire) < 3 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("all 3 trickle workers must complete initial commit");

    for (idx, target) in target_spaces.iter().enumerate() {
        let handle = tokio::time::timeout(
            Duration::from_secs(1),
            store.admit_projection_space(&projection, &target.scope),
        )
        .await
        .unwrap_or_else(|_| panic!("target {idx} admit starved under pool_size=3 trickle writes"))
        .expect("admit must succeed under pool_size=3 trickle writes");
        assert!(handle.try_read().is_ok());
        drop(handle);
        tokio::time::timeout(
            Duration::from_secs(1),
            store.drain_projection_owner(&revocation, &target.scope),
        )
        .await
        .unwrap_or_else(|_| panic!("target {idx} drain starved under pool_size=3 trickle writes"))
        .expect("drain must succeed under pool_size=3 trickle writes");
    }

    stop.store(true, Ordering::Release);
    for h in handles {
        h.await.unwrap();
    }

    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
