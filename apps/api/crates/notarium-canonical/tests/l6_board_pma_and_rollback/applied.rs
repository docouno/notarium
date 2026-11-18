use super::*;
use notarium_canonical::{
    CloseCollabSession, CollabCarrierSettlement, OpenCollabSession, RoomFenceTable,
};
use notarium_core::{
    patch::CarrierEditOrigin,
    ports::{
        ExternalObservation, ExternalObservationResult, FilenamePin, InterceptedMutation,
        InterceptedPayload, InterceptionResult, LiveCollabInterceptor, ObservedContent,
        RollbackReservation,
    },
    receipt::MutationReceiptToken,
    span::ByteSpan,
};
use tokio::sync::oneshot;

type Pause = (oneshot::Sender<()>, oneshot::Receiver<MutationReceiptToken>);

struct PausedRoom {
    fences: Arc<RoomFenceTable>,
    pause: Mutex<Option<Pause>>,
}

impl PausedRoom {
    async fn applied<T, U>(
        &self,
        original: impl Future<Output = Result<T, PortError>>,
        other_writes: impl Future<Output = (MutationReceiptToken, U)>,
    ) -> (Result<T, PortError>, U) {
        let (entered_tx, entered) = oneshot::channel();
        let (release, receipt_rx) = oneshot::channel();
        *self.pause.lock().unwrap() = Some((entered_tx, receipt_rx));
        let writes = async {
            entered.await.unwrap();
            let (receipt, result) = other_writes.await;
            release.send(receipt).unwrap();
            result
        };
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            tokio::join!(original, writes)
        })
        .await
        .expect("room must deliver Applied after the competing writes")
    }
}

impl LiveCollabInterceptor for PausedRoom {
    fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async move {
            let pause = self.pause.lock().unwrap().take();
            if let Some((entered, result)) = pause {
                entered.send(()).unwrap();
                return Ok(InterceptionResult::Applied(result.await.unwrap()));
            }
            let note = match request.payload {
                InterceptedPayload::EditNote { note, .. } => note,
                InterceptedPayload::ExternalObservation { observation, .. } => observation.note,
                InterceptedPayload::MoveBoardCard { card, .. } => card.note,
            };
            match self
                .fences
                .reserve_rollback(request.context.scope(), &note, request.identity)
                .await?
            {
                RollbackReservation::Closed(reservation) => {
                    Ok(InterceptionResult::ClosedRoomReservation(reservation))
                }
                RollbackReservation::SkippedRoomActive => panic!("unexpected active test room"),
            }
        })
    }

    fn reserve_rollback(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        identity: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        Box::pin(async move {
            self.fences
                .reserve_rollback(ctx.scope(), &note, identity)
                .await
        })
    }

    fn filename_pin(&self, _: SpaceContext, _: NoteId) -> PortFuture<'_, FilenamePin> {
        Box::pin(async { Ok(FilenamePin::Unpinned) })
    }
}

pub(super) async fn check(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    view: &ViewRef,
    expected_view: notarium_core::ids::RevisionId,
    planner: &CanonicalTestBoardPlanner,
) {
    let room = Arc::new(PausedRoom {
        fences: Arc::clone(store.room_fences()),
        pause: Mutex::new(None),
    });
    store.register_collab_interceptor(room.clone()).unwrap();
    let scope = ctx.scope();
    let actor = ctx.auth().principal();
    let note = sample_note_id(0xe7);
    let created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                scope,
                actor,
                CreateNote {
                    note: note.clone(),
                    class: DocClass::UserDoc,
                    parent: None,
                    slug: "applied-race".into(),
                    carrier: "zero".into(),
                },
            ),
        )
        .await
        .unwrap();
    let edit = |base: &str, next: &str| {
        let span = ByteSpan::new(0, base.len()).unwrap();
        next_mutation(
            scope,
            actor,
            EditNote {
                note: note.clone(),
                plan: notarium_syntax::patch::plan(
                    base,
                    span,
                    vec![(CarrierEditOrigin::Body, span, next.into())],
                )
                .unwrap(),
            },
        )
    };
    let a = edit("zero", "one");
    let (answer, (committed_a, committed_b)) = room
        .applied(store.edit_note(ctx.clone(), a.clone()), async {
            let committed_a = store.edit_note(ctx.clone(), a).await.unwrap();
            let committed_b = store
                .edit_note(ctx.clone(), edit("one", "two"))
                .await
                .unwrap();
            (committed_a.receipt.clone(), (committed_a, committed_b))
        })
        .await;
    let answer = answer.unwrap();
    assert_eq!(answer.value, committed_a.value);
    assert_eq!(answer.receipt, committed_a.receipt);
    assert_ne!(answer.value, committed_b.value);

    let observation = next_mutation(
        scope,
        actor,
        ExternalObservation {
            note: note.clone(),
            observed_digest: notarium_syntax::content_digest("three"),
            base_revision: committed_b.value.revision,
            disk_identity: notarium_syntax::content_digest("observed-file"),
            content: ObservedContent::Carrier("three".into()),
        },
    );
    let open = store
        .open_collab_session(
            &ctx.budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "observer".into(),
                expected_carrier_rev: observation.input.base_revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    let (answer, (first, later)) = room
        .applied(
            store.accept_external_observation(ctx.clone(), observation),
            async {
                let first = store
                    .close_collab_session(
                        &ctx.budget,
                        CloseCollabSession {
                            scope: scope.clone(),
                            note: note.clone(),
                            owner_id: Some("observer".into()),
                            expected_lease: open.lease_epoch,
                            expected_lineage: open.lineage_epoch,
                            final_yrs_snapshot: None,
                            compacted_through_update_seq: None,
                            carrier_settlement: Some(CollabCarrierSettlement {
                                auth: ctx.auth().clone(),
                                carrier: "three".into(),
                            }),
                        },
                    )
                    .await
                    .unwrap();
                let later = store
                    .edit_note(ctx.clone(), edit("three", "four"))
                    .await
                    .unwrap();
                (
                    MutationReceiptToken::new(scope.clone(), first.updated_seq).unwrap(),
                    (first, later),
                )
            },
        )
        .await;
    let ExternalObservationResult::Committed(answer) = answer.unwrap() else {
        panic!("expected committed observation");
    };
    assert_eq!(answer.value.note, note);
    assert_eq!(answer.value.revision, first.carrier_rev_id);
    assert_eq!(answer.receipt.seq(), first.updated_seq);
    assert_ne!(answer.value, later.value);

    planner.tracked_notes.lock().unwrap().insert(note.clone());
    let card = next_mutation(
        scope,
        actor,
        MoveBoardCard {
            view: view.clone(),
            note: note.clone(),
            group: GroupKey::Absent,
            before: None,
            after: None,
            fields: BTreeMap::new(),
            expected_note: later.value.revision,
            expected_view,
            expected_rank: RankExpectation::Absent,
        },
    );
    let (foreign, ()) = room
        .applied(store.move_board_card(ctx.clone(), card.clone()), async {
            (created.receipt, ())
        })
        .await;
    assert!(matches!(foreign, Err(PortError::Unavailable(failure))
        if failure.effect() == notarium_core::error::CommitEffect::Unknown));
    assert!(
        !store
            .inspect_view_overlays_for_test(&scope.space_id, view)
            .await
            .unwrap()
            .contains_key(&note)
    );

    let saved_card = card.clone();
    let (answer, (first, later)) = room
        .applied(store.move_board_card(ctx.clone(), card.clone()), async {
            let first = store
                .move_board_card(ctx.clone(), card.clone())
                .await
                .unwrap();
            let next = next_mutation(
                scope,
                actor,
                MoveBoardCard {
                    expected_note: first.value.revision.revision.clone(),
                    expected_rank: RankExpectation::Existing(first.value.rank_revision.clone()),
                    group: GroupKey::Value(ScalarValue::String("applied".into())),
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("applied".into())),
                    )]),
                    ..card.input
                },
            );
            let later = store.move_board_card(ctx.clone(), next).await.unwrap();
            (first.receipt.clone(), (first, later))
        })
        .await;
    let answer = answer.unwrap();
    assert_eq!(answer.receipt, first.receipt);
    assert_eq!(answer.value.revision, first.value.revision);
    assert_eq!(answer.value.rank_revision, first.value.rank_revision);
    assert_eq!(answer.value.rank, first.value.rank);
    assert_eq!(answer.value.group, first.value.group);
    assert_ne!(answer.value.rank_revision, later.value.rank_revision);
    assert_ne!(answer.value.group, later.value.group);
    let count = store.execute_diagnostic_write_sql_for_test(&format!(
        "UPDATE command_receipts SET response_payload_id=NULL WHERE space_id='{}' AND idempotency_key='{}'",
        scope.space_id.as_str(), saved_card.identity.key.as_str(),
    )).await.unwrap();
    assert_eq!(count, 1);
    assert!(matches!(
        store.move_board_card(ctx.clone(), saved_card).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
}
