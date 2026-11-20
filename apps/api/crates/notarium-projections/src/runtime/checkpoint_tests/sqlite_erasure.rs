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
    ) -> Result<(), PortError> {
        use notarium_core::ports::ChatPort;
        match self {
            Self::Purge(request) => canonical
                .delete_note(ctx.clone(), request.clone())
                .await
                .map(|_| ()),
            Self::Redact(request) => canonical
                .redact_chat_entry(ctx.clone(), request.clone())
                .await
                .map(|_| ()),
        }
    }
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
    use notarium_core::{
        error::CommitEffect,
        model::NoteRef,
        ports::{
            AppendChat, ChatEntryKind, ChatInputBody, ChatPort, ChatThreadKind, CreateChat,
            RedactChatEntry,
        },
    };
    use rusqlite::Connection;

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
    let note = &victim.value.note;
    let thread = ChatThreadId::from_bytes(entropy());
    let (command, seq) = if redact {
        canonical
            .create_chat(
                ctx.clone(),
                mutation(
                    &ctx,
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
                    &ctx,
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
            .read_projection_chat_head(&projection_context(), ctx.scope(), None, &thread)
            .await
            .unwrap()
            .unwrap();
        (
            ErasureCommand::Redact(mutation(
                &ctx,
                RedactChatEntry {
                    thread: thread.clone(),
                    entry: appended.value.seq,
                    expected_thread_revision: head.thread.revision,
                },
            )),
            appended.receipt.seq(),
        )
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
    let marker: String;
    if redact {
        sql.execute_batch("PRAGMA journal_mode=PERSIST").unwrap();
        marker = sql
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
    } else {
        sql.execute_batch("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        marker = format!("private-preview-{}", hex::encode(entropy()));
        assert_eq!(
            sql.execute(
                "UPDATE projected_notes SET preview = ? WHERE note_id = ?",
                [&marker, note.as_str()]
            )
            .unwrap(),
            1
        );
    }
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
        Some(start().await.unwrap())
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

    // Restore the matching main beside its original journal and retry the
    // canonical receipt. SQLite can now recover and scrub the actual rows.
    std::fs::write(&db, matching_main).unwrap();
    command.execute(&canonical, &ctx).await.unwrap();
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
    assert!(neighbor_index.dense_id(&survivor.value.note).is_some());
    if let Some(projector) = projector {
        projector.shutdown().await.unwrap();
    }
    writer.shutdown().await.unwrap();
}
