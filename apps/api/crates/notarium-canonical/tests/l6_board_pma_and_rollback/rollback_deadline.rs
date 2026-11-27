use super::*;
use notarium_canonical::RoomFenceTable;
use notarium_core::{
    error::{CommitEffect, RetryAdvice},
    ports::{
        FilenamePin, InterceptedMutation, InterceptionResult, LiveCollabInterceptor,
        RollbackReservation,
    },
};
use std::time::Duration;

struct DelayedReservations {
    fences: Arc<RoomFenceTable>,
    delay: AtomicBool,
    received: Mutex<Vec<Duration>>,
    returned: AtomicUsize,
}

impl LiveCollabInterceptor for DelayedReservations {
    fn intercept(&self, _: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        unreachable!()
    }
    fn filename_pin(&self, _: SpaceContext, _: NoteId) -> PortFuture<'_, FilenamePin> {
        unreachable!()
    }
    fn reserve_rollback(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        identity: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        Box::pin(async move {
            self.received.lock().unwrap().push(ctx.budget.remaining);
            if self.delay.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let result = self
                .fences
                .reserve_rollback(ctx.scope(), &note, identity)
                .await;
            self.returned.fetch_add(1, Ordering::SeqCst);
            result
        })
    }
}

#[tokio::test]
async fn rollback_deadline_spans_room_reservations_and_writer_ack_on_both_backends() {
    let fixtures = StorageTestFixtures::load_required();
    for postgres in [false, true] {
        let root = TempDataRoot::new("l6-rollback-room-deadline");
        let schema = fixtures.fresh_pg_schema();
        let config = if postgres {
            fixtures.pg_local_config(sample_installation_id(78), &schema, root.data_root())
        } else {
            CanonicalConfig::local_default(sample_installation_id(78), root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let owner = sample_principal_id(78);
        let (scope, _) = seed_space(
            &store,
            sample_space_id(78),
            sample_incarnation(78),
            owner.clone(),
        )
        .await;
        let ctx = owner_ctx(&scope, owner.clone());
        let run = sample_run_id(78);
        let agent = agent_run_ctx(&ctx, run.clone());
        let mut fence_epochs = Vec::new();
        for id in [78, 79] {
            let note = sample_note_id(id);
            let _created = store
                .create_note(
                    agent.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        CreateNote {
                            folder_page: false,
                            note: note.clone(),
                            parent: None,
                            slug: format!("deadline-{id}"),
                            class: DocClass::UserDoc,
                            carrier: "# Deadline\n".into(),
                        },
                    ),
                )
                .await
                .unwrap();
            let fence = store.room_fences().get_or_init(&scope, &note);
            let epoch = fence.lock().await.epoch();
            fence_epochs.push((fence, epoch));
        }
        let command = next_mutation(&scope, &owner, run);
        let rooms = Arc::new(DelayedReservations {
            fences: Arc::clone(store.room_fences()),
            delay: AtomicBool::new(true),
            received: Mutex::new(Vec::new()),
            returned: AtomicUsize::new(0),
        });
        store.register_collab_interceptor(rooms.clone()).unwrap();
        let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
        let receipts = store
            .execute_diagnostic_read_sql_for_test(None, "SELECT count(*) FROM command_receipts")
            .await
            .unwrap();

        let mut short = ctx.clone();
        short.budget.remaining = Duration::from_millis(340);
        let failure = store
            .rollback_agent_run_by_id(short.clone(), command.clone())
            .await
            .unwrap_err();
        assert!(
            matches!(failure, PortError::DeadlineExceeded(ref f) if f.effect()==CommitEffect::NotCommitted),
            "{failure:?}"
        );
        {
            let received = rooms.received.lock().unwrap();
            assert_eq!(received.len(), 2);
            assert!(received[1] + Duration::from_millis(190) <= received[0]);
        }
        assert_eq!(rooms.returned.load(Ordering::SeqCst), 1);
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
        for (fence, epoch) in &fence_epochs {
            assert_eq!(fence.lock().await.epoch(), *epoch);
        }

        rooms.delay.store(false, Ordering::SeqCst);
        let pause = store.acquire_writer_safe_point().await.unwrap();
        let ambiguous = store
            .rollback_agent_run_by_id(short, command.clone())
            .await
            .unwrap_err();
        assert!(
            matches!(ambiguous, PortError::Unavailable(ref f) if f.effect()==CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand),
            "{ambiguous:?}"
        );
        drop(pause);
        let confirmed = store
            .rollback_agent_run_by_id(ctx.clone(), command.clone())
            .await
            .unwrap();
        let replayed = store.rollback_agent_run_by_id(ctx, command).await.unwrap();
        assert_eq!(confirmed.receipt, replayed.receipt);
        assert_eq!(confirmed.value.trashed.len(), 2);
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            confirmed.receipt.seq()
        );
        assert_eq!(
            store
                .execute_diagnostic_read_sql_for_test(None, "SELECT count(*) FROM command_receipts")
                .await
                .unwrap(),
            receipts + 1
        );
        for (fence, epoch) in fence_epochs {
            assert_eq!(fence.lock().await.epoch(), epoch.checked_next().unwrap());
        }
        runtime.shutdown().await.unwrap();
        if postgres {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}

#[tokio::test]
async fn rollback_room_plan_replans_on_concurrent_open_and_clean_close_both_backends() {
    use notarium_canonical::peers::{CloseCollabSession, OpenCollabSession};

    struct RacingRoomInterceptor {
        store: CanonicalStore,
        scope: HistoryScope,
        fences: Arc<RoomFenceTable>,
        open_target: NoteId,
        open_target_rev: RevisionId,
        open_raced: AtomicBool,
        clean_close_target: NoteId,
        clean_close_raced: AtomicBool,
        reserve_calls: AtomicUsize,
    }

    impl LiveCollabInterceptor for RacingRoomInterceptor {
        fn intercept(&self, _: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
            unreachable!()
        }
        fn filename_pin(&self, _: SpaceContext, _: NoteId) -> PortFuture<'_, FilenamePin> {
            unreachable!()
        }
        fn reserve_rollback(
            &self,
            ctx: SpaceContext,
            note: NoteId,
            identity: CommandIdentity,
        ) -> PortFuture<'_, RollbackReservation> {
            Box::pin(async move {
                self.reserve_calls.fetch_add(1, Ordering::SeqCst);
                let res = self
                    .fences
                    .reserve_rollback(ctx.scope(), &note, identity)
                    .await?;
                if note == self.open_target && !self.open_raced.swap(true, Ordering::SeqCst) {
                    // Simulate a peer opening a live room AFTER reservation and BEFORE writer TX
                    // without changing `note_heads.head_rev_id`.
                    self.store
                        .open_collab_session(
                            &make_budget(),
                            OpenCollabSession {
                                scope: self.scope.clone(),
                                note: note.clone(),
                                owner_id: "racer".into(),
                                expected_carrier_rev: self.open_target_rev.clone(),
                                expected_lease: None,
                                expected_lineage: None,
                                initial_yrs_snapshot: None,
                                allow_fenced_recovery: false,
                            },
                        )
                        .await?;
                    self.fences.open_room(&self.scope, &note).await?;
                } else if note == self.clean_close_target
                    && !self.clean_close_raced.swap(true, Ordering::SeqCst)
                {
                    // Simulate a clean room open+close AFTER reservation and BEFORE writer TX:
                    // `head_rev_id` stays identical, but `room_fences.epoch` advances by 2.
                    self.fences.open_room(&self.scope, &note).await?;
                    self.fences.close_room(&self.scope, &note).await?;
                }
                Ok(res)
            })
        }
    }

    let fixtures = StorageTestFixtures::load_required();
    for postgres in [false, true] {
        let root = TempDataRoot::new("l6-rollback-room-race");
        let schema = fixtures.fresh_pg_schema();
        let config = if postgres {
            fixtures.pg_local_config(sample_installation_id(81), &schema, root.data_root())
        } else {
            CanonicalConfig::local_default(sample_installation_id(81), root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let owner = sample_principal_id(81);
        let (scope, _) = seed_space(
            &store,
            sample_space_id(81),
            sample_incarnation(81),
            owner.clone(),
        )
        .await;
        let ctx = owner_ctx(&scope, owner.clone());

        // Case 1: Concurrent room open on note_a during planned rollback -> must replan and skip note_a while trashing note_b.
        let run1 = sample_run_id(81);
        let agent1 = agent_run_ctx(&ctx, run1.clone());
        let note_a = sample_note_id(81);
        let note_b = sample_note_id(82);
        let note_c = sample_note_id(83);
        let created_a = store
            .create_note(
                agent1.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: note_a.clone(),
                        parent: None,
                        slug: "race-a".into(),
                        class: DocClass::UserDoc,
                        carrier: "# A\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        store
            .create_note(
                agent1,
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: note_b.clone(),
                        parent: None,
                        slug: "race-b".into(),
                        class: DocClass::UserDoc,
                        carrier: "# B\n".into(),
                    },
                ),
            )
            .await
            .unwrap();

        let run2 = sample_run_id(82);
        let agent2 = agent_run_ctx(&ctx, run2.clone());
        store
            .create_note(
                agent2,
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: note_c.clone(),
                        parent: None,
                        slug: "race-c".into(),
                        class: DocClass::UserDoc,
                        carrier: "# C\n".into(),
                    },
                ),
            )
            .await
            .unwrap();

        let rooms = Arc::new(RacingRoomInterceptor {
            store: store.clone(),
            scope: scope.clone(),
            fences: Arc::clone(store.room_fences()),
            open_target: note_a.clone(),
            open_target_rev: created_a.value.revision.clone(),
            open_raced: AtomicBool::new(false),
            clean_close_target: note_c.clone(),
            clean_close_raced: AtomicBool::new(false),
            reserve_calls: AtomicUsize::new(0),
        });
        store.register_collab_interceptor(rooms.clone()).unwrap();

        let rb1 = store
            .rollback_agent_run_by_id(ctx.clone(), next_mutation(&scope, &owner, run1))
            .await
            .expect("concurrent room open must trigger CursorStale replan, not InvalidState");
        assert_eq!(rb1.value.skipped_room_active, vec![note_a.clone()]);
        assert_eq!(rb1.value.trashed.len(), 1);
        assert_eq!(rb1.value.trashed[0].note, note_b);
        assert!(rooms.open_raced.load(Ordering::SeqCst));

        // Close the raced session cleanly before Case 2.
        let sess = store
            .read_collab_session(None, &scope, &note_a)
            .await
            .unwrap()
            .unwrap()
            .session;
        store
            .close_collab_session(
                &make_budget(),
                CloseCollabSession {
                    unchanged_carrier_digest: None,
                    scope: scope.clone(),
                    note: note_a.clone(),
                    owner_id: sess.owner_id,
                    expected_lease: sess.lease_epoch,
                    expected_lineage: sess.lineage_epoch,
                    final_yrs_snapshot: None,
                    compacted_through_update_seq: None,
                    carrier_settlement: None,
                },
            )
            .await
            .unwrap();
        store
            .room_fences()
            .close_room(&scope, &note_a)
            .await
            .unwrap();

        // Case 2: Concurrent clean room open+close on note_c -> must replan and trash note_c (no SourceMismatch).
        let before_calls = rooms.reserve_calls.load(Ordering::SeqCst);
        let rb2 = store
            .rollback_agent_run_by_id(ctx, next_mutation(&scope, &owner, run2))
            .await
            .expect(
                "concurrent clean open+close must replan and succeed, not fail with SourceMismatch",
            );
        assert!(rb2.value.skipped_room_active.is_empty());
        assert_eq!(rb2.value.trashed.len(), 1);
        assert_eq!(rb2.value.trashed[0].note, note_c);
        assert!(rooms.clean_close_raced.load(Ordering::SeqCst));
        assert!(
            rooms.reserve_calls.load(Ordering::SeqCst) >= before_calls + 2,
            "clean open+close race must replan and reserve a second time"
        );

        runtime.shutdown().await.unwrap();
        if postgres {
            fixtures.drop_pg_schema(&schema).await;
        }
    }
}
