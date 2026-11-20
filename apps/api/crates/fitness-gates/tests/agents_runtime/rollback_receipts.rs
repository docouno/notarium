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
    let agent = ctx
        .auth()
        .for_agent_run(
            run.clone(),
            space.clone(),
            ChatAudience::Personal,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    let agent = SpaceContext::new(agent, scope.clone(), budget()).unwrap();
    let manual = append_note(fixture, &agent, tag).await;
    let room = append_note(fixture, &agent, tag + 1).await;
    store
        .rename_note(
            ctx.clone(),
            Mutation {
                identity: identity(tag + 2),
                preconditions: Preconditions::default(),
                input: RenameNote {
                    note: manual.clone(),
                    slug: format!("renamed-{tag}"),
                    title: None,
                },
            },
        )
        .await
        .unwrap();
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
