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
use sqlx::Connection;
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
    runtime.shutdown().await.unwrap();
}

async fn assert_catalog_seal(
    store: &CanonicalStore,
    fixtures: &StorageTestFixtures,
    schema: &str,
    space: &SpaceRecord,
) {
    let observed_record = store.get_space(&space.space.id).await.unwrap();
    let observed_owner = store
        .projection_owner_identity(&maintenance_ctx(ServicePurpose::Revocation), &space.scope)
        .await
        .unwrap()
        .unwrap();
    let owner = store.clone();
    let (ready, acquired) = tokio::sync::oneshot::channel();
    let (release, done) = tokio::sync::oneshot::channel();
    let sealing = tokio::spawn(async move {
        owner
            .with_projection_catalog_seal(
                &maintenance_ctx(ServicePurpose::Projection),
                move |entries| async move {
                    assert_eq!(entries.len(), 1);
                    assert_eq!(entries[0].scope, observed_record.scope);
                    assert_eq!(entries[0].head, observed_record.last_seq);
                    assert_eq!(entries[0].owner.as_ref(), Some(&observed_owner));
                    ready.send(()).unwrap();
                    done.await.unwrap();
                    Ok(())
                },
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), acquired)
        .await
        .unwrap()
        .unwrap();
    let mut raw = fixtures.open_raw_pg().await;
    let mut tx = raw.begin().await.unwrap();
    let search_path = sqlx::AssertSqlSafe(format!("SET LOCAL search_path TO {schema}"));
    sqlx::query(search_path).execute(&mut *tx).await.unwrap();
    let conflict = sqlx::query("LOCK TABLE spaces IN ROW EXCLUSIVE MODE NOWAIT")
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_eq!(
        conflict
            .as_database_error()
            .and_then(|e| e.code())
            .as_deref(),
        Some("55P03"),
    );
    tx.rollback().await.unwrap();
    release.send(()).unwrap();
    sealing.await.unwrap().unwrap();
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
    assert_catalog_seal(&first, &fixtures, &schema, &space).await;

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
