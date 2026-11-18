use super::*;
use notarium_canonical::{
    CloseCollabSession, CollabCarrierSettlement, CollabRoomState, CollabSessionRecord,
    OpenCollabSession, RoomFenceTable,
};
use notarium_core::{
    patch::CarrierEditOrigin,
    ports::{
        AcceptedRoomCarrier, ExternalObservation, ExternalObservationResult, FilenamePin,
        InterceptedMutation, InterceptedPayload, InterceptionResult, LiveCollabInterceptor,
        ObservedContent, RollbackReservation, RoomCarrierAction,
    },
    receipt::MutationReceiptToken,
    span::ByteSpan,
};
use tokio::sync::oneshot;

type Pause = (oneshot::Sender<()>, oneshot::Receiver<MutationReceiptToken>);

struct PausedRoom {
    fences: Arc<RoomFenceTable>,
    pause: Mutex<Option<Pause>>,
    accepted: Mutex<Option<AcceptedRoomCarrier>>,
}

impl PausedRoom {
    fn accept(&self, room: &CollabSessionRecord, action: RoomCarrierAction, through: Option<u64>) {
        *self.accepted.lock().unwrap() = Some(AcceptedRoomCarrier {
            owner_id: room.owner_id.clone().unwrap(),
            expected_lease: room.lease_epoch,
            expected_lineage: room.lineage_epoch,
            compacted_through_update_seq: through,
            action,
        });
    }

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
            if let Some(accepted) = self.accepted.lock().unwrap().take() {
                return Ok(InterceptionResult::SettleCarrier(accepted));
            }
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
        accepted: Mutex::new(None),
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
    let (answer, (_, later)) = room
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
    assert!(matches!(answer, Err(PortError::Unavailable(f))
        if f.effect() == notarium_core::error::CommitEffect::Unknown));
    check_room_command_commit(store, ctx, &room).await;

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
        RoomCarrierAction::Close {
            final_yrs_snapshot: None,
        },
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
    let closed = store
        .read_collab_session(Some(&ctx.budget), scope, &note)
        .await
        .unwrap()
        .unwrap()
        .session;
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
                        revision: closed.carrier_rev_id.clone(),
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
    assert_eq!(retried.value.revision, closed.carrier_rev_id);
    assert_eq!(retried.receipt.seq(), closed.updated_seq);

    let base = rollback.value.restored[0].revision.clone();
    let active = store
        .open_collab_session(&ctx.budget, open(base.clone()))
        .await
        .unwrap();
    let new_file = "---\ntitle: Observed\n---\nfrom disk";
    let disk = notarium_syntax::content_digest(original);
    let observation = next_mutation(
        scope,
        actor,
        ExternalObservation {
            note: note.clone(),
            observed_digest: notarium_syntax::content_digest(new_file),
            base_revision: base,
            disk_identity: disk,
            content: ObservedContent::Carrier(new_file.into()),
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
    let checkpoint = || RoomCarrierAction::Checkpoint {
        yrs_snapshot: b"checkpoint".to_vec(),
    };
    room.accept(&active, checkpoint(), None);
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
    room.accept(&active, checkpoint(), Some(1));
    let ExternalObservationResult::Committed(applied) = store
        .accept_external_observation(ctx.clone(), observation.clone())
        .await
        .unwrap()
    else {
        panic!("observation was not applied");
    };
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
                scope: scope.clone(),
                note: note.clone(),
                owner_id: active.owner_id,
                expected_lease: active.lease_epoch,
                expected_lineage: active.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: Some(CollabCarrierSettlement {
                    auth: ctx.auth().clone(),
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
            fences: Arc::clone(store.room_fences()),
            pause: Mutex::new(None),
            accepted: Mutex::new(None),
        });
        room.accept(
            &active,
            RoomCarrierAction::Close {
                final_yrs_snapshot: None,
            },
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
    let closed = restored
        .read_collab_session(Some(&ctx.budget), &scope, &note)
        .await
        .unwrap()
        .unwrap()
        .session;
    assert_eq!(closed.room_state, CollabRoomState::Closed);
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
    assert_eq!(replayed.value.revision, closed.carrier_rev_id);
    assert_eq!(replayed.receipt.seq(), closed.updated_seq);
    assert_ne!(replayed.value, later.value);
    runtime.shutdown().await.unwrap();
}
