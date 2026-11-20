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
    #[cfg(unix)]
    let held = old
        .acquire_snapshot(neighbor.clone(), CausalBasis::Await(Default::default()))
        .await
        .unwrap();
    #[cfg(unix)]
    let old_store = old.generation.load_full().store.clone();
    #[cfg(not(unix))]
    let (held_index, _lease) = {
        let cut = old.published_cut(neighbor.scope()).unwrap();
        (
            old.open_index(&cut).unwrap(),
            cut.store.cache_lease().unwrap(),
        )
    };
    let neighbor_image = std::fs::read(&neighbor_file).unwrap();
    projector.rotate(second, &budget()).await.unwrap();
    projector.shutdown().await.unwrap();
    drop(old);

    let db = root.derived(first);
    // Restore only checkpoint files at the installed path. Unix can keep the
    // old SQL handles and snapshot pinned to the displaced generation.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::rename(db.parent().unwrap(), root.root().join("displaced-g1")).unwrap();
        for path in [&named, &neighbor_file] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::set_permissions(
                path.parent().unwrap(),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
    }
    #[cfg(not(unix))]
    std::fs::remove_file(&db).unwrap();
    assert!(!db.with_file_name("derived.sqlite-wal").exists());
    assert!(!db.with_file_name("derived.sqlite-journal").exists());
    if !neighbor_file.exists() {
        std::fs::write(&neighbor_file, &neighbor_image).unwrap();
    }
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
    assert!(held_index.dense_id(&survivor.value.note).is_some());
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
    let error = old.register_scope(ctx.scope()).await.unwrap_err();
    assert!(
        matches!(error, PortError::Domain(DomainError::ValidationFailed {diagnostic})
        if diagnostic.reason == ValidationReason::CursorStale)
    );
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

fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    Mutation {
        identity: command_identity(ctx),
        preconditions: Preconditions::default(),
        input,
    }
}

enum ErasureCommand {
    Purge(Mutation<DeleteNote>),
    Redact(Mutation<notarium_core::ports::RedactChatEntry>),
}

impl ErasureCommand {
    async fn execute(
        &self,
        canonical: &CanonicalStore,
        ctx: &SpaceContext,
    ) -> Result<SpaceSeq, PortError> {
        use notarium_core::ports::ChatPort;
        match self {
            Self::Purge(request) => canonical
                .delete_note(ctx.clone(), request.clone())
                .await
                .map(|outcome| outcome.receipt.seq()),
            Self::Redact(request) => canonical
                .redact_chat_entry(ctx.clone(), request.clone())
                .await
                .map(|outcome| outcome.receipt.seq()),
        }
    }
}

async fn prepare_redaction(
    canonical: &CanonicalStore,
    ctx: &SpaceContext,
    thread: &ChatThreadId,
    note: &NoteId,
) -> (Mutation<notarium_core::ports::RedactChatEntry>, SpaceSeq) {
    use notarium_core::{
        model::NoteRef,
        ports::{
            AppendChat, ChatEntryKind, ChatInputBody, ChatPort, ChatThreadKind, CreateChat,
            RedactChatEntry,
        },
    };
    canonical
        .create_chat(
            ctx.clone(),
            mutation(
                ctx,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: ctx.auth().principal().clone(),
                    project_folder: None,
                    title: "Erasure".into(),
                },
            ),
        )
        .await
        .unwrap();
    let appended = canonical
        .append_chat(
            ctx.clone(),
            mutation(
                ctx,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Link".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: ctx.scope().space_id.clone(),
                        note_id: note.clone(),
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    let head = canonical
        .read_projection_chat_head(&projection_context(), ctx.scope(), None, thread)
        .await
        .unwrap()
        .unwrap();
    (
        mutation(
            ctx,
            RedactChatEntry {
                thread: thread.clone(),
                entry: appended.value.seq,
                expected_thread_revision: head.thread.revision,
            },
        ),
        appended.receipt.seq(),
    )
}

async fn start_checkpoint_projector(
    canonical: &CanonicalStore,
    root: &DataRoot,
) -> ProjectorRuntime {
    ProjectorRuntime::start_sqlite(
        canonical.clone(),
        projection_context(),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap()
}

fn expect_cleanup_unavailable(error: PortError) {
    use notarium_core::error::CommitEffect;
    assert!(
        matches!(&error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::NotReady)
            || matches!(&error, PortError::Internal(f) | PortError::Unavailable(f)
                if f.effect() == CommitEffect::Unknown),
        "{error:?}"
    );
}

fn erasure_rows(
    db: &Path,
    victim: &NoteId,
    thread: &ChatThreadId,
    survivor: &NoteId,
) -> (i64, i64, i64) {
    use rusqlite::{Connection, OpenFlags};

    let db = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.query_row(
        "SELECT (SELECT count(*) FROM projected_notes WHERE note_id = ?1),
                    (SELECT count(*) FROM chat_note_refs WHERE thread_id = ?2),
                    (SELECT count(*) FROM projected_notes WHERE note_id = ?3)",
        [victim.as_str(), thread.as_str(), survivor.as_str()],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )
    .unwrap()
}

#[tokio::test]
async fn sqlite_detached_cleanup_runs_after_canonical_writer_epoch_advances() {
    use notarium_core::ports::ChatPort;

    let storage = Scratch::new();
    let root = storage.root();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(entropy()), root.clone());
    let (canonical, writer) = CanonicalRuntime::open(config).await.unwrap();
    let ctx = owner(&canonical).await;
    let victim = create(&canonical, &ctx, "victim", "private".into()).await;
    let survivor = create(&canonical, &ctx, "survivor", "keep".into()).await;
    let thread = ChatThreadId::from_bytes(entropy());
    let (redact, head) = prepare_redaction(&canonical, &ctx, &thread, &survivor.value.note).await;
    let first = ProjectionGeneration::new(1).unwrap();
    let checkpoint = root.space_fast_index(first, &ctx.scope().space_id, head);
    let rows = || {
        erasure_rows(
            &root.derived(first),
            &victim.value.note,
            &thread,
            &survivor.value.note,
        )
    };
    let projector = start_checkpoint_projector(&canonical, &root).await;
    projector
        .engine()
        .wait_for_projected(ctx.scope(), head, &budget())
        .await
        .unwrap();
    projector.shutdown().await.unwrap();
    assert_eq!(rows(), (1, 1, 1));
    assert!(checkpoint.is_file());

    let revocation = MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
        budget: budget(),
    };
    canonical
        .advance_space_lease(&revocation, ctx.scope(), LeaseEpoch::new(2).unwrap())
        .await
        .unwrap();
    let purge = mutation(
        &ctx,
        DeleteNote {
            note: victim.value.note.clone(),
            disposition: DeleteDisposition::Purge,
        },
    );
    let purged = canonical
        .delete_note(ctx.clone(), purge.clone())
        .await
        .unwrap();
    assert_eq!(rows(), (0, 1, 1));
    assert!(!checkpoint.exists());
    let redacted = canonical
        .redact_chat_entry(ctx.clone(), redact.clone())
        .await
        .unwrap();
    assert_eq!(rows(), (0, 0, 1));
    assert_eq!(
        canonical
            .delete_note(ctx.clone(), purge)
            .await
            .unwrap()
            .receipt,
        purged.receipt
    );
    assert_eq!(
        canonical
            .redact_chat_entry(ctx, redact)
            .await
            .unwrap()
            .receipt,
        redacted.receipt
    );
    writer.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_restart_requires_cleanup_before_acknowledging_purge_and_redaction() {
    let storage = Scratch::new();
    let cache = Scratch::new();
    let root = cache.root();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(entropy()), storage.root());
    let (canonical, writer) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let owner_ctx = owner(&canonical).await;
    let neighbor = owner(&canonical).await;
    let victim = create(&canonical, &owner_ctx, "victim", "private".into()).await;
    let survivor = create(&canonical, &neighbor, "survivor", "keep".into()).await;
    let thread = ChatThreadId::from_bytes(entropy());
    let (redact, chat_seq) =
        prepare_redaction(&canonical, &neighbor, &thread, &survivor.value.note).await;
    let purge = mutation(
        &owner_ctx,
        DeleteNote {
            note: victim.value.note.clone(),
            disposition: DeleteDisposition::Purge,
        },
    );
    let requests = [
        (ErasureCommand::Purge(purge), &owner_ctx),
        (ErasureCommand::Redact(redact), &neighbor),
    ];
    let first = ProjectionGeneration::new(1).unwrap();
    let file = root.space_fast_index(first, &owner_ctx.scope().space_id, victim.receipt.seq());

    let projector = start_checkpoint_projector(&canonical, &root).await;
    projector
        .engine()
        .wait_for_projected(owner_ctx.scope(), victim.receipt.seq(), &budget())
        .await
        .unwrap();
    projector
        .engine()
        .wait_for_projected(neighbor.scope(), chat_seq, &budget())
        .await
        .unwrap();
    projector.shutdown().await.unwrap();
    writer.shutdown().await.unwrap();
    drop(canonical);
    let rows = || {
        erasure_rows(
            &root.derived(first),
            &victim.value.note,
            &thread,
            &survivor.value.note,
        )
    };
    assert_eq!(rows(), (1, 1, 1));
    assert!(file.is_file());

    // The new writer cannot discover this separate cache by scanning its own data root.
    let (canonical, writer) = CanonicalRuntime::open(config).await.unwrap();
    for _ in 0..2 {
        for (command, ctx) in &requests {
            expect_cleanup_unavailable(command.execute(&canonical, ctx).await.unwrap_err());
        }
        assert_eq!(rows(), (1, 1, 1));
        assert!(file.is_file());
    }
    let empty = Scratch::new();
    assert!(
        ProjectorRuntime::start_sqlite(
            canonical.clone(),
            projection_context(),
            empty.root(),
            first,
            ProjectionConfig::default(),
        )
        .await
        .is_err()
    );
    for (command, ctx) in &requests {
        expect_cleanup_unavailable(command.execute(&canonical, ctx).await.unwrap_err());
    }
    assert_eq!(rows(), (1, 1, 1));
    assert!(file.is_file());
    let projector = start_checkpoint_projector(&canonical, &root).await;
    for (command, ctx) in requests {
        let seq = command.execute(&canonical, ctx).await.unwrap();
        assert_eq!(command.execute(&canonical, ctx).await.unwrap(), seq);
        assert_eq!(
            canonical
                .read_space(&ctx.scope().space_id)
                .await
                .unwrap()
                .last_seq,
            seq
        );
    }
    assert_eq!(rows(), (0, 0, 1));
    assert!(!file.exists());
    projector.shutdown().await.unwrap();
    writer.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_attach_drains_two_pages_of_pending_purges_in_one_space() {
    use rusqlite::{Connection, OpenFlags};

    const PURGES: i64 = 33;
    let scratch = Scratch::new();
    let root = scratch.root();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(entropy()), root.clone());
    let (canonical, writer) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let ctx = owner(&canonical).await;
    let mut requests = Vec::new();
    for i in 0..PURGES {
        let slug = format!("victim-{i}");
        let victim = create(&canonical, &ctx, &slug, slug.clone()).await;
        requests.push(mutation(
            &ctx,
            DeleteNote {
                note: victim.value.note,
                disposition: DeleteDisposition::Purge,
            },
        ));
    }
    let survivor = create(&canonical, &ctx, "survivor", "keep".into()).await;
    let projector = start_checkpoint_projector(&canonical, &root).await;
    projector
        .engine()
        .wait_for_projected(ctx.scope(), survivor.receipt.seq(), &budget())
        .await
        .unwrap();
    projector.shutdown().await.unwrap();
    writer.shutdown().await.unwrap();
    drop(canonical);

    let (canonical, writer) = CanonicalRuntime::open(config).await.unwrap();
    let mut expected = Vec::new();
    for request in &requests {
        expect_cleanup_unavailable(
            canonical
                .delete_note(ctx.clone(), request.clone())
                .await
                .unwrap_err(),
        );
        expected.push(
            canonical
                .read_space(&ctx.scope().space_id)
                .await
                .unwrap()
                .last_seq,
        );
    }
    let canonical_db =
        Connection::open_with_flags(root.canonical(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let receipts = || -> (i64, i64) {
        canonical_db.query_row(
            "SELECT count(*) FILTER (WHERE p.phase <> 'completed' AND r.status = 'pending_purge'),
                    count(*) FILTER (WHERE p.phase = 'completed' AND r.status = 'completed')
             FROM pending_purges p JOIN command_receipts r
               USING (space_id, history_incarnation, actor_id, idempotency_key)
             WHERE p.space_id = ?",
            [ctx.scope().space_id.as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap()
    };
    let physical = || -> (i64, i64) {
        let db = Connection::open_with_flags(
            root.derived(ProjectionGeneration::new(1).unwrap()),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        db.query_row(
            "SELECT count(*), count(*) FILTER (WHERE note_id = ?2) FROM projected_notes WHERE space_id = ?1",
            [ctx.scope().space_id.as_str(), survivor.value.note.as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap()
    };
    assert_eq!(receipts(), (PURGES, 0));
    assert_eq!(physical(), (PURGES + 1, 1));

    let projector = start_checkpoint_projector(&canonical, &root).await;
    tokio::time::timeout(budget().remaining, async {
        while receipts() != (0, PURGES) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("attachment must drain every page before any client replay");
    assert_eq!(physical(), (1, 1));
    for (request, seq) in requests.into_iter().zip(expected) {
        assert_eq!(
            canonical
                .delete_note(ctx.clone(), request)
                .await
                .unwrap()
                .receipt
                .seq(),
            seq
        );
    }
    projector.shutdown().await.unwrap();
    writer.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_orphan_wal_keeps_purge_pending_until_database_is_restored() {
    exercise_orphan_journal(false).await;
}

#[tokio::test]
async fn sqlite_orphan_rollback_journal_keeps_redaction_pending_until_database_is_restored() {
    exercise_orphan_journal(true).await;
}

async fn exercise_orphan_journal(redact: bool) {
    use notarium_core::error::CommitEffect;
    use rusqlite::Connection;

    let scratch = Scratch::new();
    let root = scratch.root();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(entropy()), root.clone());
    let (canonical, writer) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let ctx = owner(&canonical).await;
    let neighbor = owner(&canonical).await;
    let victim = create(&canonical, &ctx, "victim", "private".into()).await;
    let survivor = create(&canonical, &neighbor, "neighbor", "unrelated".into()).await;
    let note = &victim.value.note;
    let thread = ChatThreadId::from_bytes(entropy());
    let (command, seq) = if redact {
        let (request, seq) = prepare_redaction(&canonical, &ctx, &thread, note).await;
        (ErasureCommand::Redact(request), seq)
    } else {
        (
            ErasureCommand::Purge(mutation(
                &ctx,
                DeleteNote {
                    note: note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            )),
            victim.receipt.seq(),
        )
    };
    let first = ProjectionGeneration::new(1).unwrap();
    let mut projector = start_checkpoint_projector(&canonical, &root).await;
    let engine = projector.engine();
    engine
        .wait_for_projected(ctx.scope(), seq, &budget())
        .await
        .unwrap();
    engine
        .wait_for_projected(neighbor.scope(), survivor.receipt.seq(), &budget())
        .await
        .unwrap();
    let (neighbor_index, _lease) = {
        let cut = engine.published_cut(neighbor.scope()).unwrap();
        (
            engine.open_index(&cut).unwrap(),
            cut.store.cache_lease().unwrap(),
        )
    };
    projector
        .rotate(first.checked_next().unwrap(), &budget())
        .await
        .unwrap();
    projector.shutdown().await.unwrap();
    drop(engine);

    let db = root.derived(first);
    let sidecar = db.with_file_name(if redact {
        "derived.sqlite-journal"
    } else {
        "derived.sqlite-wal"
    });
    let sql = Connection::open(&db).unwrap();
    let marker = if redact {
        sql.execute_batch("PRAGMA journal_mode=PERSIST").unwrap();
        let marker: String = sql
            .query_row(
                "SELECT source_revision FROM chat_note_refs WHERE thread_id = ?",
                [thread.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            sql.execute(
                "UPDATE chat_note_refs SET ref_ordinal = ref_ordinal + 1 WHERE thread_id = ?",
                [thread.as_str()]
            )
            .unwrap(),
            1
        );
        marker
    } else {
        sql.execute_batch("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        let marker = format!("private-preview-{}", hex::encode(entropy()));
        assert_eq!(
            sql.execute(
                "UPDATE projected_notes SET preview = ? WHERE note_id = ?",
                [&marker, note.as_str()]
            )
            .unwrap(),
            1
        );
        marker
    };
    let matching_main = std::fs::read(&db).unwrap();
    let pages = std::fs::read(&sidecar).unwrap();
    assert!(
        pages
            .windows(marker.len())
            .any(|chunk| chunk == marker.as_bytes())
    );
    drop(sql);
    let wal_mode_main = if redact {
        // A WAL-mode main does not automatically remove a cold PERSIST journal.
        Connection::open(&db)
            .unwrap()
            .execute_batch("PRAGMA journal_mode=WAL")
            .unwrap();
        Some(std::fs::read(&db).unwrap())
    } else {
        None
    };
    // Reconstitute the partial restore only after all SQLite users of G1 closed.
    if redact {
        std::fs::write(&db, []).unwrap();
    } else {
        std::fs::remove_file(&db).unwrap();
    }
    std::fs::write(&sidecar, &pages).unwrap();

    // Exercise a live G2 on purge and the detached canonical writer on redact.
    let projector = if redact {
        None
    } else {
        Some(start_checkpoint_projector(&canonical, &root).await)
    };
    let pending = |err: PortError| {
        assert!(matches!(err,
            PortError::Internal(f) | PortError::Unavailable(f) if f.effect() == CommitEffect::Unknown
        ))
    };
    pending(command.execute(&canonical, &ctx).await.unwrap_err());
    assert!(neighbor_index.dense_id(&survivor.value.note).is_some());
    assert!(DerivedStore::open_sqlite(&root, first).await.is_err());
    assert_eq!(std::fs::read(&sidecar).unwrap(), pages);
    if let Some(wal_mode_main) = wal_mode_main {
        assert_eq!(std::fs::metadata(&db).unwrap().len(), 0);
        std::fs::write(&db, wal_mode_main).unwrap();
        pending(command.execute(&canonical, &ctx).await.unwrap_err());
        assert_eq!(std::fs::read(&sidecar).unwrap(), pages);
    } else {
        assert!(!db.exists());
        // A WAL already opened by a writer can remain empty until COMMIT.
        std::fs::write(&sidecar, []).unwrap();
        pending(command.execute(&canonical, &ctx).await.unwrap_err());
        assert!(DerivedStore::open_sqlite(&root, first).await.is_err());
        assert!(!db.exists());
        std::fs::write(&sidecar, &pages).unwrap();
    }

    // SQLite startup drives pending purges before the reopened projector registers.
    // Its receipt and the WAL preimage must both survive that unattended recovery.
    let (canonical, writer, projector) = if let Some(projector) = projector {
        projector.shutdown().await.unwrap();
        writer.shutdown().await.unwrap();
        drop(canonical);
        let (canonical, writer) = CanonicalRuntime::open(config).await.unwrap();
        let receipt_state = || {
            let sql = Connection::open_with_flags(
                root.canonical(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            sql.query_row(
                "SELECT p.phase, r.status FROM pending_purges p
                 JOIN command_receipts r USING (space_id, history_incarnation, actor_id, idempotency_key)
                 WHERE p.space_id = ? AND p.old_note_id = ?",
                [ctx.scope().space_id.as_str(), note.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            ).unwrap()
        };
        let assert_pending_receipt = || {
            let (phase, status) = receipt_state();
            assert_ne!(phase, "completed");
            assert_eq!(status, "pending_purge");
        };
        assert_pending_receipt();
        expect_cleanup_unavailable(command.execute(&canonical, &ctx).await.unwrap_err());
        assert_pending_receipt();
        assert_eq!(std::fs::read(&sidecar).unwrap(), pages);
        // The real handler can now recover the retired generation's original WAL.
        std::fs::write(&db, matching_main).unwrap();
        let projector = start_checkpoint_projector(&canonical, &root).await;
        tokio::time::timeout(budget().remaining, async {
            loop {
                let (phase, status) = receipt_state();
                if phase == "completed" {
                    assert_eq!(status, "completed");
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("registration must resume the pending purge without another client request");
        (canonical, writer, Some(projector))
    } else {
        std::fs::write(&db, matching_main).unwrap();
        command.execute(&canonical, &ctx).await.unwrap();
        (canonical, writer, None)
    };
    assert!(!sidecar.exists() || std::fs::metadata(&sidecar).unwrap().len() == 0);
    let sql = Connection::open(&db).unwrap();
    let count: i64 = if redact {
        sql.query_row(
            "SELECT COUNT(*) FROM chat_note_refs WHERE thread_id = ?",
            [thread.as_str()],
            |row| row.get(0),
        )
        .unwrap()
    } else {
        sql.query_row(
            "SELECT COUNT(*) FROM projected_notes WHERE note_id = ?",
            [note.as_str()],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(count, 0);
    drop(sql);
    assert!(neighbor_index.dense_id(&survivor.value.note).is_some());
    if let Some(projector) = projector {
        let bytes = std::fs::read(&db).unwrap();
        assert!(
            !bytes
                .windows(marker.len())
                .any(|chunk| chunk == marker.as_bytes())
        );
        let seq = command.execute(&canonical, &ctx).await.unwrap();
        assert_eq!(
            canonical
                .read_space(&ctx.scope().space_id)
                .await
                .unwrap()
                .last_seq,
            seq
        );
        projector.shutdown().await.unwrap();
    }
    writer.shutdown().await.unwrap();
}

#[tokio::test]
async fn detached_sqlite_eraser_requires_its_registered_cache_after_failed_restart() {
    let storage = Scratch::new();
    let media = Scratch::new();
    let mount = media.root().root().join("mounted");
    let detached = media.root().root().join("detached");
    std::fs::create_dir(&mount).unwrap();
    let root = DataRoot::new(&mount);
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(entropy()), storage.root());
    let (canonical, writer) = CanonicalRuntime::open(config).await.unwrap();
    let owner_ctx = owner(&canonical).await;
    let neighbor = owner(&canonical).await;
    let victim = create(&canonical, &owner_ctx, "victim", "private".into()).await;
    let survivor = create(&canonical, &neighbor, "survivor", "keep".into()).await;
    let thread = ChatThreadId::from_bytes(entropy());
    let (redact, chat_seq) =
        prepare_redaction(&canonical, &neighbor, &thread, &survivor.value.note).await;
    let purge = ErasureCommand::Purge(mutation(
        &owner_ctx,
        DeleteNote {
            note: victim.value.note.clone(),
            disposition: DeleteDisposition::Purge,
        },
    ));
    let redact = ErasureCommand::Redact(redact);
    let first = ProjectionGeneration::new(1).unwrap();

    let projector = start_checkpoint_projector(&canonical, &root).await;
    projector
        .engine()
        .wait_for_projected(owner_ctx.scope(), victim.receipt.seq(), &budget())
        .await
        .unwrap();
    projector
        .engine()
        .wait_for_projected(neighbor.scope(), chat_seq, &budget())
        .await
        .unwrap();
    projector.shutdown().await.unwrap();
    // Simulate the separate cache volume going offline between operations. The
    // original installation stays intact, and the canonical writer keeps running.
    std::fs::rename(&mount, &detached).unwrap();
    std::fs::create_dir(&mount).unwrap();
    assert!(
        ProjectorRuntime::start_sqlite(
            canonical.clone(),
            projection_context(),
            root.clone(),
            first,
            ProjectionConfig::default()
        )
        .await
        .is_err()
    );

    expect_cleanup_unavailable(purge.execute(&canonical, &owner_ctx).await.unwrap_err());
    expect_cleanup_unavailable(redact.execute(&canonical, &neighbor).await.unwrap_err());
    // Remount the original volume before inspecting physical rows and checkpoints.
    std::fs::rename(&mount, media.root().root().join("empty-mount")).unwrap();
    std::fs::rename(&detached, &mount).unwrap();
    let checkpoint =
        root.space_fast_index(first, &owner_ctx.scope().space_id, victim.receipt.seq());
    let rows = || {
        erasure_rows(
            &root.derived(first),
            &victim.value.note,
            &thread,
            &survivor.value.note,
        )
    };
    assert_eq!(rows(), (1, 1, 1));
    assert!(checkpoint.is_file());

    let seq = purge.execute(&canonical, &owner_ctx).await.unwrap();
    assert_eq!(purge.execute(&canonical, &owner_ctx).await.unwrap(), seq);
    let seq = redact.execute(&canonical, &neighbor).await.unwrap();
    assert_eq!(redact.execute(&canonical, &neighbor).await.unwrap(), seq);
    assert_eq!(rows(), (0, 0, 1));
    assert!(!checkpoint.exists());
    writer.shutdown().await.unwrap();
}
