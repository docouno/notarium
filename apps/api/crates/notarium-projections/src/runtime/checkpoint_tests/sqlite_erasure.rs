use super::*;
use notarium_canonical::{ProjectionErasures, ProjectionVisibilityCleanup};
use notarium_core::{ports::BackupParticipantPort, receipt::ChangeCursor};

async fn restored(canonical: &CanonicalStore, old: &SpaceContext) -> SpaceContext {
    let scope = HistoryScope {
        space_id: old.scope().space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(entropy()),
    };
    let after = canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;
    canonical
        .restore_cursors(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Restore),
                budget: budget(),
            },
            vec![ChangeCursor {
                scope: scope.clone(),
                after,
            }],
        )
        .await
        .unwrap();
    SpaceContext::new(old.auth().clone(), scope, budget()).unwrap()
}

#[tokio::test]
async fn sqlite_purges_file_only_retired_generation_while_neighbor_is_held() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (canonical, writer) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(entropy()),
        root.clone(),
    ))
    .await
    .unwrap();
    let ctx = owner(&canonical).await;
    let neighbor = owner(&canonical).await;
    let victim = create(&canonical, &ctx, "victim", "private".into()).await;
    let survivor = create(&canonical, &neighbor, "neighbor", "unrelated".into()).await;
    let seq = victim.receipt.seq();
    let first = ProjectionGeneration::new(1).unwrap();
    let second = first.checked_next().unwrap();
    let start = || {
        ProjectorRuntime::start_sqlite(
            canonical.clone(),
            projection_context(),
            root.clone(),
            first,
            ProjectionConfig::default(),
        )
    };
    let mut projector = start().await.unwrap();
    let old = projector.engine();
    old.wait_for_projected(ctx.scope(), seq, &budget())
        .await
        .unwrap();
    old.wait_for_projected(neighbor.scope(), survivor.receipt.seq(), &budget())
        .await
        .unwrap();
    let neighbor_file =
        root.space_fast_index(first, &neighbor.scope().space_id, survivor.receipt.seq());
    let named = root.space_fast_index(first, &ctx.scope().space_id, seq);
    let image = std::fs::read(&named).unwrap();
    let held = old
        .acquire_snapshot(neighbor.clone(), CausalBasis::Await(Default::default()))
        .await
        .unwrap();
    #[cfg(unix)]
    let old_store = old.generation.load_full().store.clone();
    projector.rotate(second, &budget()).await.unwrap();
    projector.shutdown().await.unwrap();
    drop(old);

    // Windows SQLite keeps the open database name pinned. Keep an actual
    // file-only lease while closing its SQL connections before simulating loss.
    #[cfg(not(unix))]
    let file_lease = crate::derived::GenerationFiles::hold(&root, first)
        .await
        .unwrap();
    #[cfg(not(unix))]
    drop(held);
    let db = root.derived(first);
    std::fs::remove_file(&db).unwrap();
    if !named.exists() {
        std::fs::write(&named, &image).unwrap();
    }
    let temp = named.with_file_name(".fast-index-0123456789abcdef0123456789abcdef.tmp");
    std::fs::write(&temp, &image).unwrap();
    let ctx = restored(&canonical, &ctx).await;
    let projector = start().await.unwrap();
    let engine = projector.engine();
    engine
        .wait_for_projected(ctx.scope(), seq, &budget())
        .await
        .unwrap();
    assert_eq!(engine.generation.load().store.generation(), second);
    let receipt = canonical
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: command_identity(&ctx),
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: victim.value.note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap()
        .receipt;
    assert!(!named.exists() && !temp.exists() && !db.exists());
    assert!(neighbor_file.is_file());
    #[cfg(unix)]
    assert!(held.lookup(&survivor.value.note).is_some());
    #[cfg(not(unix))]
    drop(file_lease);
    #[cfg(unix)]
    {
        let old_scope = victim.receipt.scope();
        let prepared = FastIndexBuilder::default()
            .prepare(IndexIdentity {
                generation: first,
                scope: old_scope.clone(),
                seq,
            })
            .unwrap();
        let err = apply::publish_checkpoint_file(&engine, &old_store, prepared)
            .await
            .unwrap_err();
        assert!(
            matches!(err, PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::CursorStale)
        );
        assert!(!named.exists());
    }

    let eraser = super::super::erasure::Eraser::new(&engine).unwrap();
    let current = restored(&canonical, &ctx).await;
    engine
        .wait_for_projected(current.scope(), receipt.seq(), &budget())
        .await
        .unwrap();
    let path = root.space_fast_index(second, &ctx.scope().space_id, receipt.seq());
    assert!(path.is_file());
    eraser
        .erase_visibility(
            &canonical,
            &ProjectionErasures {
                scope: ctx.scope().clone(),
                through: receipt.seq(),
                purged: vec![victim.value.note],
                redacted: Vec::new(),
            },
        )
        .await
        .unwrap();
    let store = &engine.generation.load_full().store;
    assert!(path.is_file());
    store
        .validate_checkpoint_publication(current.scope(), receipt.seq())
        .await
        .unwrap();
    projector.shutdown().await.unwrap();
    writer.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn sqlite_file_only_candidate_retries_and_reused_number_rejects_old_writer() {
    use crate::derived::{GenerationDescriptor, SpaceApply};
    use notarium_core::error::CommitEffect;

    let scratch = Scratch::new();
    let root = scratch.root();
    let (canonical, writer) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(entropy()),
        root.clone(),
    ))
    .await
    .unwrap();
    let ctx = owner(&canonical).await;
    let victim = create(&canonical, &ctx, "victim", "private".into()).await;
    let seq = victim.receipt.seq();
    let first = ProjectionGeneration::new(1).unwrap();
    let next = first.checked_next().unwrap();
    let projector = ProjectorRuntime::start_sqlite(
        canonical.clone(),
        projection_context(),
        root.clone(),
        first,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = projector.engine();
    engine
        .wait_for_projected(ctx.scope(), seq, &budget())
        .await
        .unwrap();
    projector.shutdown().await.unwrap();
    let control = &engine.control;
    let active = control.active().await.unwrap().unwrap();
    let candidate = GenerationDescriptor {
        generation: next,
        publication_epoch: active.publication_epoch + 1,
        cut_fingerprint: active.cut_fingerprint,
    };
    assert!(
        control
            .reserve_candidate(Some(&active), &candidate)
            .await
            .unwrap()
    );
    let old = DerivedStore::open_sqlite(&root, next).await.unwrap();
    let watermark = engine
        .generation
        .load_full()
        .store
        .watermarks(&ctx.scope().space_id)
        .await
        .unwrap()
        .unwrap();
    old.apply(&SpaceApply {
        expected: None,
        watermark,
        mutations: Vec::new(),
    })
    .await
    .unwrap();
    let identity = IndexIdentity {
        generation: next,
        scope: ctx.scope().clone(),
        seq,
    };
    let prepare = || {
        FastIndexBuilder::default()
            .prepare(identity.clone())
            .unwrap()
    };
    let (base, _) = apply::publish_checkpoint_file(&engine, &old, prepare())
        .await
        .unwrap();
    base.finish_publication().unwrap();
    let named = base.path().to_owned();
    let image = std::fs::read(&named).unwrap();
    drop(base);
    let db = root.derived(next);
    std::fs::rename(
        db.parent().unwrap(),
        root.root().join("displaced-candidate"),
    )
    .unwrap();
    std::fs::create_dir_all(named.parent().unwrap()).unwrap();
    std::fs::set_permissions(
        named.parent().unwrap(),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    std::fs::write(&named, &image).unwrap();
    let purge = Mutation {
        identity: command_identity(&ctx),
        preconditions: Preconditions::default(),
        input: DeleteNote {
            note: victim.value.note,
            disposition: DeleteDisposition::Purge,
        },
    };
    let error = canonical
        .delete_note(ctx.clone(), purge.clone())
        .await
        .unwrap_err();
    assert!(
        matches!(error, PortError::Internal(f) | PortError::Unavailable(f) if f.effect() == CommitEffect::Unknown)
    );
    assert!(named.is_file() && !db.exists());
    assert!(control.cancel_candidate(&candidate).await.unwrap());
    canonical
        .delete_note(ctx.clone(), purge.clone())
        .await
        .unwrap();
    assert!(!named.exists() && !db.exists());

    // Reserving this number again permits fresh workers. A previously opened
    // SQLite connection still has the pre-purge watermark in the displaced file.
    assert!(
        control
            .reserve_candidate(Some(&active), &candidate)
            .await
            .unwrap()
    );
    canonical.delete_note(ctx.clone(), purge).await.unwrap();
    assert!(!db.exists());
    let fresh = DerivedStore::open_sqlite(&root, next).await.unwrap();
    fresh.register_scope(ctx.scope()).await.unwrap();
    let error = apply::publish_checkpoint_file(&engine, &old, prepare())
        .await
        .unwrap_err();
    assert!(
        matches!(error, PortError::Domain(DomainError::ValidationFailed {diagnostic})
        if diagnostic.reason == ValidationReason::CursorStale)
    );
    assert!(!named.exists());
    writer.shutdown().await.unwrap();
}
