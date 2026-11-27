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
