use super::*;
use notarium_canonical::{
    CloseCollabSession, CollabCarrierSettlement, CollabRoomState, CollabSessionRecord,
    OpenCollabSession, RoomCommandSettlement, RoomFenceTable,
};
use notarium_core::{
    ids::RevisionId,
    patch::CarrierEditOrigin,
    ports::{
        BoardMoveResult, Committed, ExternalObservation, ExternalObservationResult, FilenamePin,
        InterceptedMutation, InterceptedOutcome, InterceptedPayload, InterceptionResult,
        LiveCollabInterceptor, ObservedContent, RollbackReservation,
    },
    span::ByteSpan,
};
use tokio::sync::oneshot;

enum PauseReply {
    Direct(InterceptionResult),
    Commit(RoomCommandSettlement),
}

type Pause = (oneshot::Sender<()>, oneshot::Receiver<PauseReply>);

struct PausedRoom {
    store: CanonicalStore,
    fences: Arc<RoomFenceTable>,
    pause: Mutex<Option<Pause>>,
    cancel_on_reply: AtomicBool,
    settlement: Mutex<Option<RoomCommandSettlement>>,
    pinned: Mutex<Option<(NoteId, LeaseEpoch)>>,
    pin_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}

impl PausedRoom {
    fn settlement_for(
        room: &CollabSessionRecord,
        expected_base_rev: RevisionId,
        final_carrier: impl Into<String>,
        yrs_snapshot: Vec<u8>,
        through: Option<u64>,
    ) -> RoomCommandSettlement {
        RoomCommandSettlement {
            owner_id: room.owner_id.clone().unwrap(),
            expected_lease: room.lease_epoch,
            expected_lineage: room.lineage_epoch,
            expected_base_rev,
            final_carrier: final_carrier.into(),
            yrs_snapshot,
            compacted_through_update_seq: through,
        }
    }

    fn accept(
        &self,
        room: &CollabSessionRecord,
        expected_base_rev: RevisionId,
        final_carrier: impl Into<String>,
        yrs_snapshot: Vec<u8>,
        through: Option<u64>,
    ) {
        *self.settlement.lock().unwrap() = Some(Self::settlement_for(
            room,
            expected_base_rev,
            final_carrier,
            yrs_snapshot,
            through,
        ));
    }

    async fn commit_settlement(
        &self,
        request: InterceptedMutation,
        settlement: RoomCommandSettlement,
    ) -> Result<InterceptionResult, PortError> {
        match request.payload {
            InterceptedPayload::EditNote { note, plan, .. } => {
                let committed = self
                    .store
                    .commit_intercepted_edit_note(
                        request.context,
                        request.identity,
                        request.preconditions,
                        EditNote { note, plan },
                        settlement,
                    )
                    .await?;
                Ok(InterceptionResult::Applied(Box::new(
                    InterceptedOutcome::NoteRevision(committed),
                )))
            }
            InterceptedPayload::ExternalObservation { observation, .. } => {
                let outcome = self
                    .store
                    .commit_intercepted_external_observation(
                        request.context,
                        request.identity,
                        request.preconditions,
                        observation,
                        settlement,
                    )
                    .await?;
                Ok(InterceptionResult::Applied(Box::new(
                    InterceptedOutcome::ExternalObservation(outcome),
                )))
            }
            InterceptedPayload::MoveBoardCard { .. } => {
                unreachable!("board room command commit is exercised separately")
            }
        }
    }

    async fn during_interception<T, U>(
        &self,
        original: impl Future<Output = Result<T, PortError>>,
        other_writes: impl Future<Output = (InterceptionResult, U)>,
    ) -> (Result<T, PortError>, U) {
        self.during_interception_reply(original, async {
            let (outcome, result) = other_writes.await;
            (PauseReply::Direct(outcome), result)
        })
        .await
    }

    async fn during_interception_reply<T, U>(
        &self,
        original: impl Future<Output = Result<T, PortError>>,
        other_writes: impl Future<Output = (PauseReply, U)>,
    ) -> (Result<T, PortError>, U) {
        let (entered_tx, entered) = oneshot::channel();
        let (release, outcome_rx) = oneshot::channel();
        *self.pause.lock().unwrap() = Some((entered_tx, outcome_rx));
        let writes = async {
            entered.await.unwrap();
            let (outcome, result) = other_writes.await;
            release.send(outcome).ok().expect("room waiting for reply");
            result
        };
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            tokio::join!(original, writes)
        })
        .await
        .expect("room must respond after the competing writes")
    }
}

impl LiveCollabInterceptor for PausedRoom {
    fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async move {
            let settlement = self.settlement.lock().unwrap().take();
            if let Some(settlement) = settlement {
                return self.commit_settlement(request, settlement).await;
            }
            let pause = self.pause.lock().unwrap().take();
            if let Some((entered, result)) = pause {
                entered.send(()).unwrap();
                let reply = result.await.unwrap();
                if self.cancel_on_reply.swap(false, Ordering::SeqCst) {
                    // The room has a definite answer and returns it in this same poll.
                    request.context.budget.cancellation.cancel();
                }
                return match reply {
                    PauseReply::Direct(reply) => Ok(reply),
                    PauseReply::Commit(settlement) => {
                        self.commit_settlement(request, settlement).await
                    }
                };
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

    fn filename_pin(&self, _: SpaceContext, note: NoteId) -> PortFuture<'_, FilenamePin> {
        Box::pin(async move {
            let gate = self.pin_gate.lock().unwrap().take();
            if let Some((entered, resume)) = gate {
                entered.send(()).unwrap();
                resume.await.unwrap();
            }
            let pin = self.pinned.lock().unwrap();
            match pin.as_ref() {
                Some((pinned, lease)) if *pinned == note => Ok(FilenamePin::Pinned {
                    note,
                    filename: "room-move".into(),
                    lease: *lease,
                }),
                _ => Ok(FilenamePin::Unpinned),
            }
        })
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
        store: store.clone(),
        fences: Arc::clone(store.room_fences()),
        pause: Mutex::new(None),
        cancel_on_reply: AtomicBool::new(false),
        settlement: Mutex::new(None),
        pinned: Mutex::new(None),
        pin_gate: Mutex::new(None),
    });
    store.register_collab_interceptor(room.clone()).unwrap();
    check_move_pin(store, ctx, &room).await;
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
                    folder_page: false,
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
        .during_interception(store.edit_note(ctx.clone(), a.clone()), async {
            let committed_a = store.edit_note(ctx.clone(), a).await.unwrap();
            let committed_b = store
                .edit_note(ctx.clone(), edit("one", "two"))
                .await
                .unwrap();
            (
                InterceptionResult::Applied(Box::new(InterceptedOutcome::NoteRevision(
                    committed_a.clone(),
                ))),
                (committed_a, committed_b),
            )
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
    let (answer, (_, later)) = room
        .during_interception(
            store.accept_external_observation(ctx.clone(), observation),
            async {
                let first = store
                    .close_collab_session(
                        &ctx.budget,
                        CloseCollabSession {
                            unchanged_carrier_digest: None,
                            scope: scope.clone(),
                            note: note.clone(),
                            owner_id: Some("observer".into()),
                            expected_lease: open.lease_epoch,
                            expected_lineage: open.lineage_epoch,
                            final_yrs_snapshot: None,
                            compacted_through_update_seq: None,
                            carrier_settlement: Some(CollabCarrierSettlement {
                                actor: notarium_canonical::CollabSettlementActor::writer(
                                    ctx.auth().clone(),
                                ),
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
                    InterceptionResult::Applied(Box::new(InterceptedOutcome::NoteRevision(
                        later.clone(),
                    ))),
                    (first, later),
                )
            },
        )
        .await;
    assert!(matches!(answer, Err(PortError::Unavailable(f))
        if f.effect() == notarium_core::error::CommitEffect::Unknown));
    check_room_command_commit(store, ctx, &room).await;
    check_planned_observation_conflict_replay(store, ctx).await;

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
        .during_interception(store.move_board_card(ctx.clone(), card.clone()), async {
            (
                InterceptionResult::Applied(Box::new(InterceptedOutcome::NoteRevision(
                    created.clone(),
                ))),
                (),
            )
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
        .during_interception(store.move_board_card(ctx.clone(), card.clone()), async {
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
            (
                InterceptionResult::Applied(Box::new(InterceptedOutcome::BoardMove(first.clone()))),
                (first, later),
            )
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
    let latest = check_board_conflict_replay(store, ctx, &room, &saved_card, later).await;
    check_board_planner_conflict_replay(store, ctx, planner, &saved_card, latest).await;
    let mut changed = saved_card.clone();
    changed.preconditions.lease = Some(LeaseEpoch::MAX);
    assert!(matches!(
        store.move_board_card(ctx.clone(), changed).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
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

async fn check_board_conflict_replay(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    room: &PausedRoom,
    original: &Mutation<MoveBoardCard>,
    mut latest: Committed<BoardMoveResult>,
) -> Committed<BoardMoveResult> {
    for (status, divergent) in [("reviewed", false), ("published", true)] {
        let candidate_fields = |status: &str| {
            BTreeMap::from([("status".into(), Some(YamlValue::String(status.into())))])
        };
        let command = next_mutation(
            ctx.scope(),
            ctx.auth().principal(),
            MoveBoardCard {
                group: GroupKey::Value(ScalarValue::String(status.into())),
                fields: candidate_fields(status),
                expected_note: latest.value.revision.revision.clone(),
                expected_rank: RankExpectation::Existing(latest.value.rank_revision.clone()),
                ..original.input.clone()
            },
        );
        let mut queued = command.clone();
        if divergent {
            queued.input.group = GroupKey::Value(ScalarValue::String("later".into()));
            queued.input.fields = candidate_fields("later");
        }
        let (queued_result, committed) = room
            .during_interception(store.move_board_card(ctx.clone(), queued), async {
                let committed = store.move_board_card(ctx.clone(), command).await.unwrap();
                let error = if divergent {
                    DomainError::RevisionConflict {
                        current: committed.value.revision.revision.clone(),
                        lineage: None,
                    }
                } else {
                    DomainError::validation(ValidationReason::CursorStale)
                };
                (InterceptionResult::Conflict(error), committed)
            })
            .await;
        if divergent {
            assert!(matches!(
                queued_result,
                Err(PortError::Domain(DomainError::IdempotencyKeyReused))
            ));
        } else {
            let replayed = queued_result.unwrap();
            assert_eq!(replayed.receipt, committed.receipt);
            assert_eq!(replayed.value.rank_revision, committed.value.rank_revision);
        }
        assert_eq!(
            store
                .read_space(&ctx.scope().space_id)
                .await
                .unwrap()
                .last_seq,
            committed.receipt.seq()
        );
        latest = committed;
    }
    latest
}

async fn check_board_planner_conflict_replay(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    planner: &CanonicalTestBoardPlanner,
    original: &Mutation<MoveBoardCard>,
    latest: Committed<BoardMoveResult>,
) {
    let writer = next_mutation(
        ctx.scope(),
        ctx.auth().principal(),
        MoveBoardCard {
            group: GroupKey::Value(ScalarValue::String("moved-during-planning".into())),
            fields: BTreeMap::from([(
                "status".into(),
                Some(YamlValue::String("moved-during-planning".into())),
            )]),
            expected_note: latest.value.revision.revision,
            expected_rank: RankExpectation::Existing(latest.value.rank_revision),
            ..original.input.clone()
        },
    );
    let mut rank_only = writer.clone();
    rank_only.input.group = latest.value.group;
    rank_only.input.fields.clear();
    let (entered, waiting) = oneshot::channel();
    let (release, resume) = oneshot::channel();
    *planner.move_pause_once.lock().unwrap() = Some((entered, resume));
    let write = async {
        waiting.await.unwrap();
        let committed = store.move_board_card(ctx.clone(), writer).await.unwrap();
        release.send(()).unwrap();
        committed
    };
    let (rank_only, committed) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(store.move_board_card(ctx.clone(), rank_only), write)
    })
    .await
    .expect("both commands pass preflight");
    assert!(matches!(
        rank_only,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    assert_eq!(
        store
            .read_space(&ctx.scope().space_id)
            .await
            .unwrap()
            .last_seq,
        committed.receipt.seq()
    );
}

async fn check_planned_observation_conflict_replay(store: &CanonicalStore, ctx: &SpaceContext) {
    use notarium_canonical::writer::PlannedObservationPause;
    use notarium_syntax::{content_digest, patch};

    let note = sample_note_id(0xfa);
    let mut carrier = "Before planned observation";
    let created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                ctx.scope(),
                ctx.auth().principal(),
                CreateNote {
                    folder_page: false,
                    note: note.clone(),
                    parent: None,
                    slug: "planned-observation-race".into(),
                    class: DocClass::UserDoc,
                    carrier: carrier.into(),
                },
            ),
        )
        .await
        .unwrap();
    let mut base = created.value.revision;
    for (new_carrier, explicit_revision) in [("Changed once", false), ("Changed twice", true)] {
        let mut queued = next_mutation(
            ctx.scope(),
            ctx.auth().principal(),
            ExternalObservation {
                note: note.clone(),
                base_revision: base.clone(),
                observed_digest: content_digest(carrier),
                disk_identity: content_digest("physical file"),
                content: ObservedContent::Planned(
                    patch::plan(
                        carrier,
                        ByteSpan::new(0, carrier.len()).unwrap(),
                        Vec::new(),
                    )
                    .unwrap(),
                ),
            },
        );
        queued.preconditions.revision = explicit_revision.then(|| base.clone());
        let mut write = queued.clone();
        write.input.observed_digest = content_digest(new_carrier);
        write.input.content = ObservedContent::Carrier(new_carrier.into());

        let (entered, waiting) = oneshot::channel();
        let (release, resume) = oneshot::channel();
        *store
            .writer_faults()
            .unwrap()
            .planned_observation_pause_once
            .lock()
            .unwrap() = Some(PlannedObservationPause {
            entered,
            release: resume,
        });
        let writer = async {
            waiting.await.unwrap();
            let ExternalObservationResult::Committed(committed) = store
                .accept_external_observation(ctx.clone(), write)
                .await
                .unwrap()
            else {
                panic!("the changed observation must commit");
            };
            release.send(()).unwrap();
            committed
        };
        let (queued, committed) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(
                store.accept_external_observation(ctx.clone(), queued),
                writer
            )
        })
        .await
        .expect("competing write after planned observation reads its base");
        assert!(matches!(
            queued,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ));
        assert_eq!(
            store
                .read_space(&ctx.scope().space_id)
                .await
                .unwrap()
                .last_seq,
            committed.receipt.seq()
        );
        base = committed.value.revision;
        carrier = new_carrier;
    }
}

async fn check_move_pin(store: &CanonicalStore, ctx: &SpaceContext, room: &PausedRoom) {
    use notarium_core::ports::{AcceptBatch, BatchItem, MoveNote};

    let note = NoteId::from_bytes(*b"batch-move-pin!!");
    let scope = ctx.scope();
    let actor = ctx.auth().principal();
    let create = next_mutation(
        scope,
        actor,
        BatchItem::Create(CreateNote {
            folder_page: false,
            note: note.clone(),
            parent: None,
            slug: "before-room-move".into(),
            class: DocClass::UserDoc,
            carrier: "Remember the filename.\n".into(),
        }),
    );
    let mov = |slug: &str| MoveNote {
        note: note.clone(),
        parent: None,
        slug: slug.into(),
    };
    let before_room = store
        .accept_batch(
            ctx.clone(),
            AcceptBatch {
                items: vec![
                    create,
                    next_mutation(scope, actor, BatchItem::Move(mov("room-move"))),
                ],
            },
        )
        .await
        .unwrap();
    let before = before_room.items[1].as_ref().unwrap();
    let active = store
        .open_collab_session(
            &ctx.budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "filename-owner".into(),
                expected_carrier_rev: before.value.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    *room.pinned.lock().unwrap() = Some((note.clone(), active.lease_epoch));
    let request = next_mutation(scope, actor, mov("after-room-move"));
    let batch = AcceptBatch {
        items: vec![Mutation {
            identity: request.identity.clone(),
            preconditions: request.preconditions.clone(),
            input: BatchItem::Move(request.input.clone()),
        }],
    };
    let cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
    for error in [
        store
            .move_note(ctx.clone(), request.clone())
            .await
            .unwrap_err(),
        store
            .accept_batch(ctx.clone(), batch.clone())
            .await
            .unwrap_err(),
    ] {
        assert!(matches!(error, PortError::Unavailable(failure)
            if failure.effect() == notarium_core::error::CommitEffect::NotCommitted));
    }
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        cut
    );
    *room.pinned.lock().unwrap() = None;
    let result = store
        .accept_batch(ctx.clone(), batch.clone())
        .await
        .unwrap();
    let moved = result.items[0].as_ref().unwrap();
    let durable = store
        .read_collab_session(Some(&ctx.budget), scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(durable.session.room_state, CollabRoomState::Active);
    assert_eq!(durable.session.carrier_rev_id, moved.value.revision);
    assert_eq!(durable.session.lineage_epoch, active.lineage_epoch);
    *room.pinned.lock().unwrap() = Some((note.clone(), active.lease_epoch));
    assert_eq!(
        store.move_note(ctx.clone(), request).await.unwrap().receipt,
        moved.receipt
    );
    assert_eq!(
        store.accept_batch(ctx.clone(), batch).await.unwrap().items[0]
            .as_ref()
            .unwrap()
            .receipt,
        moved.receipt
    );
    *room.pinned.lock().unwrap() = None;
    check_rename_placement_and_deadline(store, ctx, room, &note).await;
}

async fn check_rename_placement_and_deadline(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    room: &PausedRoom,
    note: &NoteId,
) {
    use notarium_core::ports::MoveNote;
    let scope = ctx.scope();
    let owner = ctx.auth().principal();
    let folder = FolderId::from_bytes([173; 16]);
    store
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: folder.clone(),
            parent: None,
            slug: "concurrent-move".into(),
            display_name: "Concurrent move".into(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let rename = |slug: &str| {
        next_mutation(
            scope,
            owner,
            RenameNote {
                note: note.clone(),
                slug: slug.into(),
                title: None,
            },
        )
    };
    let pause = || {
        let (entered, waiting) = oneshot::channel();
        let (release, resume) = oneshot::channel();
        *room.pin_gate.lock().unwrap() = Some((entered, resume));
        (waiting, release)
    };
    let (waiting, release) = pause();
    let move_during_pin = async {
        waiting.await.unwrap();
        store
            .move_note(
                ctx.clone(),
                next_mutation(
                    scope,
                    owner,
                    MoveNote {
                        note: note.clone(),
                        parent: Some(folder.clone()),
                        slug: "concurrent-placement".into(),
                    },
                ),
            )
            .await
            .unwrap();
        release.send(()).unwrap();
    };
    let (renamed, ()) = tokio::join!(
        store.rename_note(ctx.clone(), rename("renamed-in-place")),
        move_during_pin
    );
    let renamed = renamed.unwrap();
    let read = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: note.clone(),
                revision: Some(renamed.value.revision.clone()),
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(read.parent, Some(folder.clone()));
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let (waiting, _hold) = pause();
    let mut short = ctx.clone();
    short.budget.remaining = std::time::Duration::from_millis(180);
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        tokio::join!(store.rename_note(short, rename("expired-rename")), waiting).0
    })
    .await
    .unwrap();
    assert!(
        matches!(result, Err(PortError::DeadlineExceeded(failure)) if failure.effect() == notarium_core::error::CommitEffect::NotCommitted)
    );
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before
    );
    Box::pin(check_observation_conflict(
        store,
        ctx,
        room,
        &folder,
        renamed.value,
    ))
    .await;
}

async fn check_observation_conflict(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    room: &PausedRoom,
    folder: &FolderId,
    mut base: NoteRevision,
) {
    enum AfterChange {
        Writable,
        Cancelled,
        Locked,
    }
    let active = store
        .read_collab_session(Some(&ctx.budget), ctx.scope(), &base.note)
        .await
        .unwrap()
        .unwrap()
        .session;
    for (i, (settle, state)) in [
        (false, AfterChange::Writable),
        (true, AfterChange::Writable),
        (false, AfterChange::Cancelled),
        (false, AfterChange::Locked),
        (true, AfterChange::Locked),
    ]
    .into_iter()
    .enumerate()
    {
        let mut caller = ctx.clone();
        caller.budget = make_budget();
        room.cancel_on_reply
            .store(matches!(state, AfterChange::Cancelled), Ordering::SeqCst);
        let mut observation = next_mutation(
            ctx.scope(),
            ctx.auth().principal(),
            ExternalObservation {
                note: base.note.clone(),
                base_revision: base.revision.clone(),
                observed_digest: notarium_syntax::content_digest("Observed bytes.\n"),
                disk_identity: notarium_syntax::content_digest("observation-conflict"),
                content: ObservedContent::Carrier("Observed bytes.\n".into()),
            },
        );
        observation.preconditions.revision = Some(base.revision.clone());
        let (answer, (changed, cut)) = room
            .during_interception_reply(
                store.accept_external_observation(caller, observation),
                async {
                    let changed = store
                        .rename_note(
                            ctx.clone(),
                            next_mutation(
                                ctx.scope(),
                                ctx.auth().principal(),
                                RenameNote {
                                    note: base.note.clone(),
                                    slug: format!("observed-change-{i}"),
                                    title: None,
                                },
                            ),
                        )
                        .await
                        .unwrap();
                    if matches!(state, AfterChange::Locked) {
                        store
                            .set_folder_write_lock(ctx.clone(), folder.clone(), true)
                            .await
                            .unwrap();
                    }
                    let cut = store
                        .read_space(&ctx.scope().space_id)
                        .await
                        .unwrap()
                        .last_seq;
                    let reply = if settle {
                        PauseReply::Commit(PausedRoom::settlement_for(
                            &active,
                            base.revision.clone(),
                            "Observed bytes.\n",
                            b"obs-conflict-snap".to_vec(),
                            None,
                        ))
                    } else {
                        // This deliberately stale revision cannot establish the current head.
                        PauseReply::Direct(InterceptionResult::Conflict(
                            DomainError::RevisionConflict {
                                current: base.revision.clone(),
                                lineage: None,
                            },
                        ))
                    };
                    (reply, (changed.value, cut))
                },
            )
            .await;
        assert_ne!(base.revision, changed.revision);
        match state {
            AfterChange::Writable => assert!(
                matches!(answer, Ok(ExternalObservationResult::Conflict { current }) if current == changed.revision)
            ),
            AfterChange::Cancelled => assert!(matches!(answer, Err(PortError::Cancelled(f))
                if f.effect() == notarium_core::error::CommitEffect::NotCommitted)),
            AfterChange::Locked => assert!(matches!(
                answer,
                Err(PortError::Domain(DomainError::SpaceReadOnly))
            )),
        }
        assert_eq!(
            store
                .read_space(&ctx.scope().space_id)
                .await
                .unwrap()
                .last_seq,
            cut
        );
        if matches!(state, AfterChange::Locked) {
            store
                .set_folder_write_lock(ctx.clone(), folder.clone(), false)
                .await
                .unwrap();
        }
        base = changed;
    }

    let mut caller = ctx.clone();
    caller.budget = make_budget();
    let cancelled = caller.budget.cancellation.clone();
    let waiting = next_mutation(
        ctx.scope(),
        ctx.auth().principal(),
        ExternalObservation {
            note: base.note,
            base_revision: base.revision,
            observed_digest: notarium_syntax::content_digest("Pending observation."),
            disk_identity: notarium_syntax::content_digest("pending-observation"),
            content: ObservedContent::Carrier("Pending observation.".to_owned()),
        },
    );
    let (started, entered) = oneshot::channel();
    let (hold, reply) = oneshot::channel();
    *room.pause.lock().unwrap() = Some((started, reply));
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(store.accept_external_observation(caller, waiting), async {
            entered.await.unwrap();
            cancelled.cancel();
        },)
    })
    .await
    .expect("cancelled dispatched room call releases its wait");
    drop(hold);
    assert!(matches!(result, Err(PortError::Unavailable(f))
        if f.effect() == notarium_core::error::CommitEffect::Unknown
        && f.retry() == notarium_core::error::RetryAdvice::RetrySameCommand));
}

async fn check_room_command_commit(store: &CanonicalStore, ctx: &SpaceContext, room: &PausedRoom) {
    let scope = ctx.scope();
    let actor = ctx.auth().principal();
    let note = sample_note_id(0xea);
    let original = "---\ntitle: Before\n---\nbase";
    let created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                scope,
                actor,
                CreateNote {
                    folder_page: false,
                    note: note.clone(),
                    parent: None,
                    slug: "room-carrier-command".into(),
                    class: DocClass::UserDoc,
                    carrier: original.into(),
                },
            ),
        )
        .await
        .unwrap();
    let open = |revision| OpenCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: "carrier-owner".into(),
        expected_carrier_rev: revision,
        expected_lease: None,
        expected_lineage: None,
        initial_yrs_snapshot: None,
        allow_fenced_recovery: false,
    };
    let active = store
        .open_collab_session(&ctx.budget, open(created.value.revision.clone()))
        .await
        .unwrap();
    let body = ByteSpan::new(original.len() - 4, original.len()).unwrap();
    let edit = next_mutation(
        scope,
        actor,
        EditNote {
            note: note.clone(),
            plan: notarium_syntax::patch::plan(
                original,
                body,
                vec![(CarrierEditOrigin::Body, body, "agent edit".into())],
            )
            .unwrap(),
        },
    );
    let run = sample_run_id(0xea);
    let agent = agent_run_ctx(ctx, run.clone());
    room.accept(
        &active,
        created.value.revision.clone(),
        "---\ntitle: Before\n---\nagent edit",
        b"edit-snap".to_vec(),
        None,
    );
    store
        .writer_faults()
        .unwrap()
        .drop_commit_response_once
        .store(true, Ordering::SeqCst);
    let lost = store
        .edit_note(agent.clone(), edit.clone())
        .await
        .unwrap_err();
    assert!(
        matches!(lost, PortError::Unavailable(f) if f.effect() == notarium_core::error::CommitEffect::Unknown)
    );
    let settled = store
        .read_collab_session(Some(&ctx.budget), scope, &note)
        .await
        .unwrap()
        .unwrap()
        .session;
    assert_eq!(settled.room_state, CollabRoomState::Active);
    assert_ne!(settled.carrier_rev_id, created.value.revision);
    let closed = store
        .close_collab_session(
            &ctx.budget,
            CloseCollabSession {
                unchanged_carrier_digest: None,
                scope: scope.clone(),
                note: note.clone(),
                owner_id: active.owner_id.clone(),
                expected_lease: active.lease_epoch,
                expected_lineage: active.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(closed.room_state, CollabRoomState::Closed);
    let rollback = store
        .rollback_agent_run(
            ctx.clone(),
            next_mutation(
                scope,
                actor,
                RollbackAgentRun {
                    expected_run_revision: store
                        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
                        .await
                        .unwrap()
                        .unwrap(),
                    run,
                    expected_entities: vec![NoteRevision {
                        note: note.clone(),
                        revision: settled.carrier_rev_id.clone(),
                    }],
                    associated_board_expectations: vec![],
                },
            ),
        )
        .await
        .unwrap();
    assert!(rollback.value.skipped_manual_edits.is_empty());
    assert_eq!(rollback.value.restored.len(), 1);
    assert_eq!(rollback.value.restored[0].note, note);
    let retried = store.edit_note(agent, edit).await.unwrap();
    assert_eq!(retried.value.revision, settled.carrier_rev_id);
    assert_eq!(retried.receipt.seq(), settled.updated_seq);

    let base = rollback.value.restored[0].revision.clone();
    let active = store
        .open_collab_session(&ctx.budget, open(base.clone()))
        .await
        .unwrap();
    let new_file = "---\ntitle: Observed\n---\nfrom disk";
    let disk = notarium_syntax::content_digest(original);
    let header_value = original.find("Before").unwrap();
    let header_value = ByteSpan::new(header_value, header_value + "Before".len()).unwrap();
    let plan = notarium_syntax::patch::plan(
        original,
        body,
        vec![
            (CarrierEditOrigin::Header, header_value, "Observed".into()),
            (CarrierEditOrigin::Body, body, "from disk".into()),
        ],
    )
    .unwrap();
    let observation = next_mutation(
        scope,
        actor,
        ExternalObservation {
            note: note.clone(),
            observed_digest: notarium_syntax::content_digest(new_file),
            base_revision: base.clone(),
            disk_identity: disk,
            content: ObservedContent::Planned(plan),
        },
    );
    store
        .append_collab_update(
            &ctx.budget,
            notarium_canonical::AppendCollabUpdate {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: active.owner_id.clone().unwrap(),
                expected_lease: active.lease_epoch,
                expected_lineage: active.lineage_epoch,
                update_seq: 1,
                update_bytes: b"pending room delta".to_vec(),
            },
        )
        .await
        .unwrap();
    room.accept(
        &active,
        base.clone(),
        new_file,
        b"checkpoint".to_vec(),
        None,
    );
    let rejected = store
        .accept_external_observation(ctx.clone(), observation.clone())
        .await;
    assert_validation_err(&rejected, ValidationReason::InvalidState);
    let still_open = store
        .read_collab_session(Some(&ctx.budget), scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_open.session.carrier_rev_id, active.carrier_rev_id);
    assert_eq!(still_open.updates.len(), 1);
    let (queued, applied) = room
        .during_interception(
            store.accept_external_observation(ctx.clone(), observation.clone()),
            async {
                room.accept(&active, base, new_file, b"checkpoint".to_vec(), Some(1));
                let ExternalObservationResult::Committed(applied) = store
                    .accept_external_observation(ctx.clone(), observation.clone())
                    .await
                    .unwrap()
                else {
                    panic!("observation was not applied");
                };
                (
                    InterceptionResult::Conflict(DomainError::RevisionConflict {
                        current: applied.value.revision.clone(),
                        lineage: Some(active.lineage_epoch),
                    }),
                    applied,
                )
            },
        )
        .await;
    let ExternalObservationResult::Committed(queued) = queued.unwrap() else {
        panic!("the same queued observation must return its committed receipt");
    };
    assert_eq!(queued.receipt, applied.receipt);
    assert_eq!(queued.value, applied.value);
    let checkpoint = store
        .read_collab_session(Some(&ctx.budget), scope, &note)
        .await
        .unwrap()
        .unwrap()
        .session;
    assert_eq!(checkpoint.room_state, CollabRoomState::Active);
    assert_eq!(
        checkpoint.yrs_snapshot_blob.as_deref(),
        Some(b"checkpoint".as_slice())
    );
    assert_eq!(checkpoint.carrier_rev_id, applied.value.revision);
    assert_eq!(checkpoint.updated_seq, applied.receipt.seq());
    let rows = store.execute_diagnostic_read_sql_for_test(None, &format!(
        "SELECT count(*) FROM materialized_observations o
         JOIN revisions base ON base.space_id=o.space_id AND base.rev_id='{}'
         JOIN revisions observed ON observed.space_id=o.space_id AND observed.rev_id=o.observed_revision
         WHERE o.space_id='{}' AND o.note_id='{}' AND o.rel_path='room-carrier-command.md'
           AND o.observed_revision='{}' AND o.applied_seq={} AND o.disk_identity=base.content_blake3
           AND o.blake3_hash=observed.content_blake3",
        created.value.revision.as_str(), scope.space_id.as_str(),note.as_str(),applied.value.revision.as_str(),applied.receipt.seq().get()
    )).await.unwrap();
    assert_eq!(rows, 1);
    let later = store
        .close_collab_session(
            &ctx.budget,
            CloseCollabSession {
                unchanged_carrier_digest: None,
                scope: scope.clone(),
                note: note.clone(),
                owner_id: active.owner_id,
                expected_lease: active.lease_epoch,
                expected_lineage: active.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: Some(CollabCarrierSettlement {
                    actor: notarium_canonical::CollabSettlementActor::writer(ctx.auth().clone()),
                    carrier: "---\ntitle: Observed\n---\nlater".into(),
                }),
            },
        )
        .await
        .unwrap();
    let ExternalObservationResult::Committed(replayed) = store
        .accept_external_observation(ctx.clone(), observation)
        .await
        .unwrap()
    else {
        panic!("the accepted observation must survive a later carrier settlement");
    };
    assert_eq!(replayed.value, applied.value);
    assert_eq!(replayed.receipt, applied.receipt);
    assert_ne!(replayed.value.revision, later.carrier_rev_id);
}

#[tokio::test]
async fn committed_room_observation_survives_process_exit() {
    use notarium_core::{epoch::DataRoot, ids::RevisionId};
    use std::{env, process::Command};

    const CHILD_ROOT: &str = "NOTARIUM_L6_ROOM_CRASH_ROOT";
    const BASE_REV: &str = "NOTARIUM_L6_ROOM_CRASH_BASE";
    let installation = sample_installation_id(0xeb);
    let scope = HistoryScope {
        space_id: sample_space_id(0xeb),
        incarnation: sample_incarnation(0xeb),
    };
    let actor = sample_principal_id(0xeb);
    let note = sample_note_id(0xeb);
    let ctx = owner_ctx(&scope, actor.clone());
    let observation = |base_revision| Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xeb; 16]),
            hash: ContentDigest::from_bytes([0xeb; 32]),
        },
        preconditions: Preconditions::default(),
        input: ExternalObservation {
            note: note.clone(),
            base_revision,
            observed_digest: notarium_syntax::content_digest("disk"),
            disk_identity: notarium_syntax::content_digest("disk-version"),
            content: ObservedContent::Carrier("disk".into()),
        },
    };
    if let Some(path) = env::var_os(CHILD_ROOT) {
        let cfg = CanonicalConfig::local_default(
            installation,
            DataRoot::new(std::path::PathBuf::from(path)),
        );
        let (store, _runtime) = CanonicalRuntime::open(cfg).await.unwrap();
        let base = RevisionId::parse(&env::var(BASE_REV).unwrap()).unwrap();
        let active = store
            .open_collab_session(
                &ctx.budget,
                OpenCollabSession {
                    scope: scope.clone(),
                    note: note.clone(),
                    owner_id: "crash-room".into(),
                    expected_carrier_rev: base.clone(),
                    expected_lease: None,
                    expected_lineage: None,
                    initial_yrs_snapshot: None,
                    allow_fenced_recovery: false,
                },
            )
            .await
            .unwrap();
        let room = Arc::new(PausedRoom {
            store: store.clone(),
            fences: Arc::clone(store.room_fences()),
            pause: Mutex::new(None),
            cancel_on_reply: AtomicBool::new(false),
            settlement: Mutex::new(None),
            pinned: Mutex::new(None),
            pin_gate: Mutex::new(None),
        });
        room.accept(
            &active,
            base.clone(),
            "disk",
            b"crash-obs-snap".to_vec(),
            None,
        );
        store.register_collab_interceptor(room).unwrap();
        store
            .writer_faults()
            .unwrap()
            .drop_commit_response_once
            .store(true, Ordering::SeqCst);
        let lost = store
            .accept_external_observation(ctx, observation(base))
            .await
            .unwrap_err();
        assert!(
            matches!(lost, PortError::Unavailable(f) if f.effect()==notarium_core::error::CommitEffect::Unknown)
        );
        std::process::exit(47);
    }
    let root = TempDataRoot::new("l6-room-crash");
    let cfg = CanonicalConfig::local_default(installation, root.data_root());
    let (store, runtime) = CanonicalRuntime::open(cfg.clone()).await.unwrap();
    seed_space(
        &store,
        scope.space_id.clone(),
        scope.incarnation,
        actor.clone(),
    )
    .await;
    let created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &actor,
                CreateNote {
                    folder_page: false,
                    note: note.clone(),
                    parent: None,
                    slug: "crash-room-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "initial".into(),
                },
            ),
        )
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
    let result = Command::new(env::current_exe().unwrap())
        .args([
            "--exact",
            "applied::committed_room_observation_survives_process_exit",
        ])
        .env(CHILD_ROOT, root.path())
        .env(BASE_REV, created.value.revision.as_str())
        .status()
        .unwrap();
    assert_eq!(result.code(), Some(47));
    let (restored, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let settled = restored
        .read_collab_session(Some(&ctx.budget), &scope, &note)
        .await
        .unwrap()
        .unwrap()
        .session;
    assert_eq!(settled.room_state, CollabRoomState::Fenced);
    assert_eq!(
        settled.yrs_snapshot_blob.as_deref(),
        Some(b"crash-obs-snap".as_slice())
    );
    restored
        .close_collab_session(
            &ctx.budget,
            CloseCollabSession {
                unchanged_carrier_digest: None,
                scope: scope.clone(),
                note: note.clone(),
                owner_id: None,
                expected_lease: settled.lease_epoch,
                expected_lineage: settled.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: None,
            },
        )
        .await
        .unwrap();
    let mut db = root.open_raw_sqlite().await;
    let receipt: Vec<u8> = sqlx::query_scalar(
        "SELECT p.effect_msgpack FROM command_receipts r JOIN change_payloads p
         ON p.space_id=r.space_id AND p.payload_id=r.response_payload_id JOIN change_commands c
         ON c.space_id=r.space_id AND c.history_incarnation=r.history_incarnation AND c.last_seq=r.canonical_seq
         WHERE r.space_id=? AND r.actor_id=? AND r.idempotency_key=? AND c.command_kind='accept_external_observation'"
    ).bind(scope.space_id.as_str()).bind(actor.as_str()).bind(CommandKey::from_bytes([0xeb;16]).as_str())
        .fetch_one(&mut db).await.unwrap();
    #[derive(serde::Deserialize)]
    struct ReceiptGrant {
        originating_grant: GrantId,
    }
    assert_eq!(
        &rmp_serde::from_slice::<ReceiptGrant>(&receipt)
            .unwrap()
            .originating_grant,
        ctx.auth().grant()
    );
    drop(db);
    let span = ByteSpan::new(0, 4).unwrap();
    let later = restored
        .edit_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &actor,
                EditNote {
                    note: note.clone(),
                    plan: notarium_syntax::patch::plan(
                        "disk",
                        span,
                        vec![(CarrierEditOrigin::Body, span, "later".into())],
                    )
                    .unwrap(),
                },
            ),
        )
        .await
        .unwrap();
    let ExternalObservationResult::Committed(replayed) = restored
        .accept_external_observation(ctx, observation(created.value.revision))
        .await
        .unwrap()
    else {
        panic!("missing durable observation receipt after process exit");
    };
    assert_eq!(replayed.value.revision, settled.carrier_rev_id);
    assert_eq!(replayed.receipt.seq(), settled.updated_seq);
    assert_ne!(replayed.value, later.value);
    runtime.shutdown().await.unwrap();
}
