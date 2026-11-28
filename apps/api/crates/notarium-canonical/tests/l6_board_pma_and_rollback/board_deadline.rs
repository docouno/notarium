use super::*;
use notarium_core::{
    error::{CommitEffect, RetryAdvice},
    ports::{
        FilenamePin, InterceptedMutation, InterceptionResult, LiveCollabInterceptor,
        RollbackReservation,
    },
};
use std::time::Duration;

struct PendingRoom {
    received: tokio::sync::Notify,
}

impl LiveCollabInterceptor for PendingRoom {
    fn intercept(&self, _: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async {
            self.received.notify_one();
            std::future::pending().await
        })
    }
    fn filename_pin(&self, _: SpaceContext, _: NoteId) -> PortFuture<'_, FilenamePin> {
        unreachable!()
    }
    fn reserve_rollback(
        &self,
        _: SpaceContext,
        _: NoteId,
        _: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        unreachable!()
    }
}

#[tokio::test]
async fn board_move_deadline_covers_planner_retry_room_and_writer_ack_on_both_backends() {
    let fixtures = StorageTestFixtures::load_required();
    for postgres in [false, true] {
        let root = TempDataRoot::new("board-deadline");
        let schema = fixtures.fresh_pg_schema();
        let config = if postgres {
            fixtures
                .open_pg_s3_config(sample_installation_id(89), &schema)
                .await
        } else {
            CanonicalConfig::local_default(sample_installation_id(89), root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let owner = sample_principal_id(89);
        let (scope, _) = seed_space(
            &store,
            sample_space_id(89),
            sample_incarnation(89),
            owner.clone(),
        )
        .await;
        let ctx = owner_ctx(&scope, owner.clone());
        let mut created = Vec::new();
        for (id, slug) in [(89, "view"), (90, "card")] {
            let note = store
                .create_note(
                    ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        CreateNote {
                            folder_page: false,
                            note: sample_note_id(id),
                            parent: None,
                            slug: slug.into(),
                            class: DocClass::UserDoc,
                            carrier: format!("---\nstatus: todo\n---\n# {slug}\n"),
                        },
                    ),
                )
                .await
                .unwrap();
            created.push(note.value);
        }
        let planner = CanonicalTestBoardPlanner::new(store.clone(), [created[1].note.clone()]);
        store
            .register_board_facts_provider(planner.clone())
            .unwrap();
        let command = next_mutation(
            &scope,
            &owner,
            MoveBoardCard {
                view: ViewRef {
                    note: created[0].note.clone(),
                    key: ViewKey::from_bytes([0x89; 16]),
                },
                note: created[1].note.clone(),
                group: GroupKey::Value(ScalarValue::String("todo".into())),
                before: None,
                after: None,
                fields: BTreeMap::new(),
                expected_view: created[0].revision.clone(),
                expected_note: created[1].revision.clone(),
                expected_rank: RankExpectation::Absent,
            },
        );
        let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
        let receipts = store
            .execute_diagnostic_read_sql_for_test(None, "SELECT count(*) FROM command_receipts")
            .await
            .unwrap();
        let mut short = ctx.clone();
        short.budget.remaining = Duration::from_millis(600);
        *planner.move_waits.lock().unwrap() = Some(Vec::new());
        planner
            .inject_stale_cutoff_once
            .store(true, Ordering::SeqCst);
        let err = tokio::time::timeout(
            Duration::from_secs(4),
            store.move_board_card(short.clone(), command.clone()),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(
            matches!(err,PortError::DeadlineExceeded(ref f) if f.effect() == CommitEffect::NotCommitted),
            "{err:?}"
        );
        let waits = planner.move_waits.lock().unwrap().take().unwrap();
        assert_eq!(waits.len(), 2);
        assert!(waits[1] + Duration::from_millis(160) <= waits[0]);
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            before
        );
        assert_eq!(
            store
                .execute_diagnostic_read_sql_for_test(None, "SELECT count(*) FROM command_receipts")
                .await
                .unwrap(),
            receipts
        );

        let hold = store.acquire_writer_safe_point().await.unwrap();
        let err = tokio::time::timeout(
            Duration::from_secs(4),
            store.move_board_card(short, command.clone()),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(
            matches!(err,PortError::Unavailable(ref f) if f.effect() == CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand),
            "{err:?}"
        );
        drop(hold);
        let saved = store
            .move_board_card(ctx.clone(), command.clone())
            .await
            .unwrap();
        let replay = store
            .move_board_card(ctx.clone(), command.clone())
            .await
            .unwrap();
        assert_eq!(saved.receipt, replay.receipt);
        assert_eq!(saved.value.revision, replay.value.revision);
        assert_eq!(saved.value.rank_revision, replay.value.rank_revision);
        assert_eq!(saved.value.rank, replay.value.rank);
        assert_eq!(saved.value.group, replay.value.group);
        assert_eq!(
            store
                .execute_diagnostic_read_sql_for_test(None, "SELECT count(*) FROM command_receipts")
                .await
                .unwrap(),
            receipts + 1
        );

        let room = Arc::new(PendingRoom {
            received: tokio::sync::Notify::new(),
        });
        store.register_collab_interceptor(room.clone()).unwrap();
        let mut next = command.input;
        next.expected_rank = RankExpectation::Existing(saved.value.rank_revision);
        let next = next_mutation(&scope, &owner, next);
        let mut cancel_ctx = ctx.clone();
        cancel_ctx.budget.cancellation = Cancellation::default();
        let token = cancel_ctx.budget.cancellation.clone();
        let (result, ()) = tokio::time::timeout(Duration::from_secs(4), async {
            tokio::join!(store.move_board_card(cancel_ctx, next), async {
                room.received.notified().await;
                token.cancel();
            })
        })
        .await
        .unwrap();
        assert!(
            matches!(result,Err(PortError::Unavailable(ref f)) if f.effect()==CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand),
            "{result:?}"
        );
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            saved.receipt.seq()
        );
        runtime.shutdown().await.unwrap();
        if postgres {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}

#[tokio::test]
async fn edit_note_bounds_room_dispatch_on_both_backends() {
    let fixtures = StorageTestFixtures::load_required();
    for postgres in [false, true] {
        let root = TempDataRoot::new("edit-room-deadline");
        let schema = fixtures.fresh_pg_schema();
        let config = if postgres {
            fixtures
                .open_pg_s3_config(sample_installation_id(76), &schema)
                .await
        } else {
            CanonicalConfig::local_default(sample_installation_id(76), root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let owner = sample_principal_id(76);
        let (scope, _) = seed_space(
            &store,
            sample_space_id(76),
            sample_incarnation(76),
            owner.clone(),
        )
        .await;
        let ctx = owner_ctx(&scope, owner.clone());
        let note = sample_note_id(76);
        let carrier = "---\nstatus: todo\n---\n# Report\n";
        let created = store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: note.clone(),
                        parent: None,
                        slug: "report".into(),
                        class: DocClass::UserDoc,
                        carrier: carrier.into(),
                    },
                ),
            )
            .await
            .unwrap();
        let plan = extract::finalize_document(
            carrier,
            DocClass::UserDoc,
            &note,
            &[FieldEdit::Set {
                key: "status".into(),
                value: YamlValue::String("done".into()),
            }],
        )
        .unwrap();
        let edit = next_mutation(&scope, &owner, EditNote { note, plan });
        let room = Arc::new(PendingRoom {
            received: tokio::sync::Notify::new(),
        });
        store.register_collab_interceptor(room.clone()).unwrap();

        let mut expired = ctx.clone();
        expired.budget.remaining = Duration::ZERO;
        let result = store.edit_note(expired, edit.clone()).await;
        assert!(
            matches!(result, Err(PortError::DeadlineExceeded(ref f)) if f.effect() == CommitEffect::NotCommitted),
            "{result:?}"
        );

        for cancel in [false, true] {
            let mut call = ctx.clone();
            call.budget.remaining = if cancel {
                Duration::from_secs(10)
            } else {
                Duration::from_millis(300)
            };
            call.budget.cancellation = Cancellation::default();
            let token = call.budget.cancellation.clone();
            let (result, ()) = tokio::time::timeout(Duration::from_secs(4), async {
                tokio::join!(store.edit_note(call, edit.clone()), async {
                    room.received.notified().await;
                    if cancel {
                        token.cancel();
                    }
                })
            })
            .await
            .expect("the dispatched edit must respect the caller");
            assert!(
                matches!(result, Err(PortError::Unavailable(ref f)) if f.effect() == CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand),
                "{result:?}"
            );
        }
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            created.receipt.seq()
        );
        runtime.shutdown().await.unwrap();
        if postgres {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}
