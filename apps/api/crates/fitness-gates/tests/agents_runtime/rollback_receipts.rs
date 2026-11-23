use super::*;
use notarium_agents::chats::{AgentRunSupervisor, ExclusiveDataRoot};
use notarium_core::auth::ChatAudience;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReceiptForm {
    HistoricalDetail,
    HistoricalSanitized,
    Current,
}

#[tokio::test]
async fn sqlite_rollback_receipt_after_purging_a_skipped_note() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    exercise(false).await;
}

#[tokio::test]
async fn postgres_rollback_receipt_after_purging_a_skipped_note() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    exercise(true).await;
}

async fn exercise(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(pg, "rollback_receipts")).await;
    let supervisor = AgentRunSupervisor::new_local(
        fixture.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let ctx = fixture.personal_scope().await;
    Box::pin(check_missing_publication(&fixture, &supervisor, &ctx)).await;
    Box::pin(check_late_source_folder(&fixture, &supervisor, &ctx)).await;
    Box::pin(check_edit_before_rollback_admission(
        &fixture,
        &supervisor,
        &ctx,
    ))
    .await;
    for (tag, form) in [
        (80, ReceiptForm::HistoricalDetail),
        (90, ReceiptForm::HistoricalSanitized),
        (100, ReceiptForm::Current),
    ] {
        Box::pin(check_receipt(&fixture, &supervisor, &ctx, tag, form)).await;
    }
    fixture.close().await;
}

async fn check_receipt(
    fixture: &RuntimeFixture,
    supervisor: &AgentRunSupervisor,
    ctx: &SpaceContext,
    tag: u8,
    form: ReceiptForm,
) {
    let store = &fixture.canonical;
    let scope = ctx.scope();
    let space = &scope.space_id;
    let actor = ctx.auth().principal();
    let identity = |tag| CommandIdentity {
        scope: scope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    };
    let run = AgentRunId::from_bytes([tag + 5; 16]);
    let agent = run_context(ctx, &run);
    let manual = append_note(fixture, &agent, tag).await;
    let room = append_note(fixture, &agent, tag + 1).await;
    rename(fixture, ctx, &manual, tag + 2).await;
    // A later write by the same run must preserve the intervening manual edit.
    rename(fixture, &agent, &manual, tag + 6).await;
    store.room_fences().open_room(scope, &room).await.unwrap();

    let key = CommandKey::from_bytes([tag + 3; 16]);
    let rollback = || {
        supervisor.rollback_run(
            fixture.human.clone(),
            scope.clone(),
            run.clone(),
            key.clone(),
        )
    };
    let original = rollback().await.unwrap();
    assert!(original.value.restored.is_empty());
    assert!(original.value.trashed.is_empty());
    assert!(original.value.restored_ranks.is_empty());
    assert_eq!(
        original.value.skipped_manual_edits,
        std::slice::from_ref(&manual)
    );
    assert_eq!(
        original.value.skipped_room_active,
        std::slice::from_ref(&room)
    );
    store.room_fences().close_room(scope, &room).await.unwrap();

    let purged = if form == ReceiptForm::HistoricalDetail {
        &manual
    } else {
        &room
    };
    if form != ReceiptForm::Current {
        // Older receipts did not register either skipped note as an owner.
        let sql = format!(
            "DELETE FROM payload_owners WHERE space_id='{space}' AND payload_kind='command_receipt'
             AND payload_id='{actor}:{key}' AND note_id IN ('{manual}','{room}')"
        );
        assert_eq!(
            store
                .execute_diagnostic_write_sql_for_test(&sql)
                .await
                .unwrap(),
            2
        );
    }
    if form == ReceiptForm::HistoricalSanitized {
        // For a skip-only rollback, the old sanitized bytes matched the detail.
        let sql = format!(
            "UPDATE command_receipts SET sanitized_envelope_msgpack=(
                 SELECT effect_msgpack FROM change_payloads
                 WHERE space_id='{space}' AND payload_id=command_receipts.response_payload_id
             ), response_payload_id=NULL WHERE space_id='{space}' AND actor_id='{actor}' AND idempotency_key='{key}'"
        );
        assert_eq!(
            store
                .execute_diagnostic_write_sql_for_test(&sql)
                .await
                .unwrap(),
            1
        );
    }
    let replay = rollback().await.unwrap();
    assert_eq!(replay.receipt, original.receipt);
    assert_eq!(replay.value, original.value);

    store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: identity(tag + 4),
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: purged.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();
    let revisions = format!(
        "SELECT COUNT(*) FROM revisions WHERE space_id='{space}' AND entity_type='note' AND entity_key='{purged}'"
    );
    assert_eq!(
        store
            .execute_diagnostic_read_sql_for_test(None, &revisions)
            .await
            .unwrap(),
        0
    );
    let before = store.read_space(space).await.unwrap().last_seq;
    match form {
        ReceiptForm::HistoricalDetail | ReceiptForm::HistoricalSanitized => {
            assert_eq!(
                rollback().await.unwrap_err(),
                PortError::Domain(DomainError::ResourceNotFound)
            );
        }
        ReceiptForm::Current => {
            let replay = rollback().await.unwrap();
            assert_eq!(replay.receipt, original.receipt);
            assert!(replay.value.restored.is_empty());
            assert!(replay.value.trashed.is_empty());
            assert!(replay.value.restored_ranks.is_empty());
            assert!(replay.value.skipped_manual_edits.is_empty());
            assert!(replay.value.skipped_room_active.is_empty());
        }
    }
    assert_eq!(store.read_space(space).await.unwrap().last_seq, before);
}

fn run_context(ctx: &SpaceContext, run: &AgentRunId) -> SpaceContext {
    let agent = ctx
        .auth()
        .for_agent_run(
            run.clone(),
            ctx.scope().space_id.clone(),
            ChatAudience::Personal,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    SpaceContext::new(agent, ctx.scope().clone(), budget()).unwrap()
}

async fn rename(fixture: &RuntimeFixture, ctx: &SpaceContext, note: &NoteId, tag: u8) {
    fixture
        .canonical
        .rename_note(
            ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: ctx.scope().clone(),
                    actor: ctx.auth().principal().clone(),
                    key: CommandKey::from_bytes([tag; 16]),
                    hash: ContentDigest::from_bytes([tag; 32]),
                },
                preconditions: Preconditions::default(),
                input: RenameNote {
                    note: note.clone(),
                    slug: format!("renamed-{tag}"),
                    title: None,
                },
            },
        )
        .await
        .unwrap();
}

async fn check_missing_publication(
    fixture: &RuntimeFixture,
    supervisor: &AgentRunSupervisor,
    ctx: &SpaceContext,
) {
    let store = &fixture.canonical;
    let scope = ctx.scope();
    let space = &scope.space_id;
    let run = AgentRunId::from_bytes([110; 16]);
    let agent = run_context(ctx, &run);
    let restored = append_note(fixture, ctx, 111).await;
    let trashed = append_note(fixture, &agent, 112).await;
    rename(fixture, &agent, &restored, 113).await;
    rename(fixture, &agent, &restored, 114).await;

    let key = CommandKey::from_bytes([115; 16]);
    let rollback = || {
        supervisor.rollback_run(
            fixture.human.clone(),
            scope.clone(),
            run.clone(),
            key.clone(),
        )
    };
    let publication = |value: &str| {
        format!(
        "UPDATE blob_catalog SET current_publication_id={value} WHERE space_id='{space}'
         AND content_blake3=(SELECT content_blake3 FROM revisions WHERE space_id='{space}' AND entity_type='note' AND entity_key='{restored}' ORDER BY space_seq LIMIT 1)"
    )
    };
    let before = store.read_space(space).await.unwrap().last_seq;
    assert_eq!(
        store
            .execute_diagnostic_write_sql_for_test(&publication("NULL"))
            .await
            .unwrap(),
        1
    );
    assert!(
        matches!(rollback().await, Err(PortError::Unavailable(failure))
        if failure.effect() == notarium_core::error::CommitEffect::NotCommitted)
    );
    assert_eq!(store.read_space(space).await.unwrap().last_seq, before);
    assert_eq!(
        store
            .execute_diagnostic_read_sql_for_test(
                None,
                &format!(
        "SELECT COUNT(*) FROM note_heads WHERE space_id='{space}' AND lifecycle_state='active'
         AND ((note_id='{restored}' AND slug='renamed-114') OR note_id='{trashed}')"
    )
            )
            .await
            .unwrap(),
        2
    );

    let previous_publication = format!(
        "(SELECT publication_id FROM blob_references WHERE space_id='{space}' AND owner_kind='note_revision' AND owner_id='{restored}' AND resource_key='carrier' ORDER BY created_seq LIMIT 1)"
    );
    assert_eq!(
        store
            .execute_diagnostic_write_sql_for_test(&publication(&previous_publication))
            .await
            .unwrap(),
        1
    );
    let done = rollback().await.unwrap();
    assert_eq!(done.value.restored.len(), 1);
    assert_eq!(done.value.restored[0].note, restored);
    assert_eq!(done.value.trashed.len(), 1);
    assert_eq!(done.value.trashed[0].note, trashed);
    let restored_rev = &done.value.restored[0].revision;
    let trashed_rev = &done.value.trashed[0].revision;
    assert_eq!(store.execute_diagnostic_read_sql_for_test(None, &format!(
        "SELECT COUNT(*) FROM revisions r
         JOIN blob_references b ON b.space_id=r.space_id AND b.owner_kind='note_revision'
           AND b.owner_id=r.entity_key AND b.owner_rev_id=r.rev_id AND b.resource_key='carrier'
           AND b.created_seq=r.space_seq AND b.content_blake3=r.content_blake3
         JOIN blob_catalog c ON c.space_id=b.space_id AND c.content_blake3=b.content_blake3 AND c.current_publication_id=b.publication_id
         WHERE r.space_id='{space}' AND r.rev_id IN ('{restored_rev}', '{trashed_rev}')
           AND c.ref_count=(SELECT COUNT(*) FROM blob_references x WHERE x.space_id=c.space_id AND x.content_blake3=c.content_blake3)"
    )).await.unwrap(), 2);
    let actor = ctx.auth().principal();
    assert_eq!(store.execute_diagnostic_read_sql_for_test(None, &format!(
        "SELECT COUNT(*) FROM payload_owners WHERE space_id='{space}' AND payload_kind='command_receipt'
         AND payload_id='{actor}:{key}' AND note_id IN ('{restored}', '{trashed}')"
    )).await.unwrap(), 2);
    let replay = rollback().await.unwrap();
    assert_eq!(replay.receipt, done.receipt);
    assert_eq!(replay.value, done.value);
    assert_eq!(
        store.read_space(space).await.unwrap().last_seq,
        done.receipt.seq()
    );
}

async fn check_late_source_folder(
    fixture: &RuntimeFixture,
    supervisor: &AgentRunSupervisor,
    ctx: &SpaceContext,
) {
    use notarium_canonical::CreateFolderSpec;
    use notarium_core::{classes::DocClass, model::Lifecycle};
    let store = &fixture.canonical;
    let scope = ctx.scope();
    let actor = ctx.auth().principal();
    let epoch = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    let folder = FolderId::from_bytes([144; 16]);
    let (_, folder_rev, _) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: folder.clone(),
            parent: None,
            slug: "late-source".into(),
            display_name: "Late source".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let run = AgentRunId::from_bytes([145; 16]);
    let agent = run_context(ctx, &run);
    let first_note = append_note(fixture, &agent, 146).await;
    let rollback = || {
        supervisor.rollback_run(
            fixture.human.clone(),
            scope.clone(),
            run.clone(),
            CommandKey::from_bytes([147; 16]),
        )
    };
    let initial = rollback().await.unwrap();
    assert_eq!(initial.value.trashed.len(), 1);
    assert_eq!(initial.value.trashed[0].note, first_note);
    // Only a current-source check sees this note. The original receipt cannot mention it.
    store
        .create_note(
            agent.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: agent.auth().principal().clone(),
                    key: CommandKey::from_bytes([148; 16]),
                    hash: ContentDigest::from_bytes([148; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([148; 16]),
                    parent: Some(folder.clone()),
                    slug: "late-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Late note\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let healthy = rollback().await.unwrap();
    assert_eq!(healthy.value, initial.value);
    assert_eq!(healthy.receipt, initial.receipt);
    let (trashed_rev, before_denial) = store
        .set_folder_lifecycle(
            scope,
            epoch,
            &folder,
            &folder_rev,
            Lifecycle::Trashed,
            actor,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        rollback().await.unwrap_err(),
        PortError::Domain(DomainError::ResourceNotFound)
    );
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before_denial
    );
    let (_, before_replay) = store
        .set_folder_lifecycle(
            scope,
            epoch,
            &folder,
            &trashed_rev,
            Lifecycle::Active,
            actor,
            None,
        )
        .await
        .unwrap();
    let healthy = rollback().await.unwrap();
    assert_eq!(healthy.value, initial.value);
    assert_eq!(healthy.receipt, initial.receipt);
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before_replay
    );
}

async fn check_edit_before_rollback_admission(
    fixture: &RuntimeFixture,
    supervisor: &AgentRunSupervisor,
    ctx: &SpaceContext,
) {
    use notarium_canonical::writer::TestPauseGate;
    let store = &fixture.canonical;
    let scope = ctx.scope();
    let run = AgentRunId::from_bytes([120; 16]);
    let agent = run_context(ctx, &run);
    let created = append_note(fixture, &agent, 121).await;
    let late = append_note(fixture, ctx, 122).await;
    let prior = store
        .read_entity_revision_at_cutoff(scope, "note", late.as_str(), None)
        .await
        .unwrap()
        .unwrap()
        .revision_id;
    let undo = || {
        supervisor.rollback_run(
            fixture.human.clone(),
            scope.clone(),
            run.clone(),
            CommandKey::from_bytes([123; 16]),
        )
    };
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, resume) = tokio::sync::oneshot::channel();
    *store
        .writer_faults()
        .unwrap()
        .guarded_admission_pause_once
        .lock()
        .unwrap() = Some(TestPauseGate {
        entered,
        release: resume,
    });
    // Persist a second source after the rollback was prepared but before the writer admits it.
    let intervening_edit = async {
        waiting.await.unwrap();
        rename(fixture, &agent, &late, 124).await;
        release.send(()).unwrap();
    };
    let (undo_result, ()) = tokio::join!(undo(), intervening_edit);
    let done = undo_result.unwrap();
    assert_eq!(done.value.trashed.len(), 1);
    assert_eq!(done.value.trashed[0].note, created);
    assert_eq!(done.value.restored.len(), 1);
    assert_eq!(done.value.restored[0].note, late);
    let space = &scope.space_id;
    let restored = store
        .read_entity_revision_at_cutoff(scope, "note", late.as_str(), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.revision_id, done.value.restored[0].revision);
    assert_eq!(restored.restored_from_rev_id.as_ref(), Some(&prior));
    let replay = undo().await.unwrap();
    assert_eq!(replay.receipt, done.receipt);
    assert_eq!(replay.value, done.value);
    assert_eq!(
        store.read_space(space).await.unwrap().last_seq,
        done.receipt.seq()
    );
}
