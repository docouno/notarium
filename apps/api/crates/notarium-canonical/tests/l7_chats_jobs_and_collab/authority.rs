use super::*;
use notarium_core::{auth::AuthenticatedCredential, ids::ScheduleId};

pub(super) async fn check(store: &CanonicalStore) {
    let owner = sample_principal_id(224);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(224),
            incarnation: sample_incarnation(224),
            root_folder_id: sample_folder_id(224),
            slug: "export-and-consume-authority".into(),
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let admitted = owner_ctx(&scope, owner.clone());
    keeper_log_visibility(store, &admitted).await;
    let note = sample_note_id(225);
    store
        .create_note(
            admitted.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: note.clone(),
                    parent: None,
                    slug: "export-source".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Export document\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    let hidden_export = || {
        next_mutation(
            &scope,
            &owner,
            ContentJobKind::Export {
                notes: vec![note.clone()],
                encrypted: false,
            },
        )
    };
    let hidden = store
        .create_job(admitted.clone(), hidden_export())
        .await
        .unwrap()
        .value;
    let claimed = store
        .claim_next_job(
            &make_budget(),
            &scope,
            "export-worker",
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.job.id, hidden.id);
    let artifact = ArtifactId::from_bytes([224; 16]);
    store
        .complete_job(
            &make_budget(),
            &scope,
            &hidden.id,
            "export-worker",
            claimed.job.lease,
            JobCompletionOutcome::Succeeded {
                completed_units: 1,
                total_units: Some(1),
                artifacts: vec![artifact.clone()],
                result_msgpack: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_job(admitted.clone(), hidden.id.clone())
            .await
            .unwrap()
            .artifacts,
        vec![artifact]
    );
    let visible_old = store
        .create_job(
            admitted.clone(),
            next_mutation(&scope, &owner, ContentJobKind::Reindex),
        )
        .await
        .unwrap()
        .value
        .id;
    store
        .create_job(admitted.clone(), hidden_export())
        .await
        .unwrap();
    let visible_new = store
        .create_job(
            admitted.clone(),
            next_mutation(&scope, &owner, ContentJobKind::Reindex),
        )
        .await
        .unwrap()
        .value
        .id;
    store
        .create_job(admitted.clone(), hidden_export())
        .await
        .unwrap();

    let mut grants = admitted.auth().spaces().clone();
    let grant = grants.get_mut(&scope.space_id).unwrap();
    grant.read_classes = [DocClass::AgentMemory].into_iter().collect();
    grant.write_classes.clear();
    grant.role = SpaceRole::Viewer;
    let restricted = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            owner.clone(),
            GrantId::from_bytes([225; 16]),
            grants,
            false,
        )),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let all_changes = ChangeRead::Log {
        after: ChangeCursor {
            scope: scope.clone(),
            after: SpaceSeq::ZERO,
        },
        through: store.read_space(&scope.space_id).await.unwrap().last_seq,
        limit: PageLimit::new(200).unwrap(),
    };
    for reader in [&admitted, &restricted] {
        let ChangeReadResult::Log(page) = store
            .recent_activity(reader.clone(), all_changes.clone())
            .await
            .unwrap()
        else {
            panic!("expected log")
        };
        assert_eq!(
            page.changes
                .iter()
                .any(|ch| ch.entity == EntityId::Job(hidden.id.clone())),
            reader.auth().spaces()[&scope.space_id]
                .read_classes
                .contains(&DocClass::UserDoc)
        );
        assert!(
            page.changes
                .iter()
                .any(|ch| ch.entity == EntityId::Job(visible_new.clone()))
        );
        assert!(page.complete);
    }
    assert!(matches!(
        store.get_job(restricted.clone(), hidden.id).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let page = store
        .list_jobs(
            restricted.clone(),
            ReadRequest::Open {
                query: JobQuery {
                    states: vec![],
                    limit: PageLimit::new(1).unwrap(),
                },
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, visible_new);
    let cursor = page.next.unwrap();
    assert_eq!(cursor.last.entity_id, visible_new);
    let page = store
        .list_jobs(restricted, ReadRequest::Continue { cursor })
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, visible_old);
    assert!(page.next.is_none());

    let thread = sample_thread_id(226);
    store
        .create_chat(
            admitted.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: owner.clone(),
                    title: "Consume authority".into(),
                    project_folder: None,
                },
            ),
        )
        .await
        .unwrap();
    let message = |text: &str| {
        next_mutation(
            &scope,
            &owner,
            AppendChat {
                tool_calls: Vec::new(),
                provenance: None,
                interruption: None,
                proposed_diff: None,
                proposed_effect: None,
                thread: thread.clone(),
                parent: ThreadEntrySeq::ZERO,
                kind: ChatEntryKind::Human,
                body: ChatInputBody::Text(text.into()),
                referenced_notes: vec![],
                tainted: false,
            },
        )
    };
    let a = store
        .append_chat(admitted.clone(), message("A"))
        .await
        .unwrap()
        .value
        .seq;
    let b = store
        .append_chat(admitted.clone(), message("B"))
        .await
        .unwrap()
        .value
        .seq;
    let run = sample_run_id(226);
    let agent = claim_run(
        store,
        admitted.clone(),
        ChatAudience::Shared,
        &thread,
        &run,
        b,
    )
    .await;
    let consume = |pending: &PendingInputId, leaf| {
        next_mutation(
            &scope,
            &owner,
            ConsumePending {
                thread: thread.clone(),
                input: pending.clone(),
                expected_active_run: run.clone(),
                expected_run: run.clone(),
                current_leaf: leaf,
            },
        )
    };
    let tainted = owner_ctx(&scope, owner.clone());
    tainted.auth().taint().mark_external_read();
    for (seed, base, already_consumed) in [(226, a, false), (227, b, true)] {
        let pending = PendingInputId::from_bytes([seed; 16]);
        assert!(matches!(
            store
                .queue_chat_input(
                    admitted.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        PendingChatInput {
                            id: pending.clone(),
                            thread: thread.clone(),
                            sender: owner.clone(),
                            body: "pending".into(),
                            queued_base_leaf: base,
                            in_flight_run: run.clone(),
                            mentions_agent: false,
                        },
                    ),
                )
                .await
                .unwrap(),
            QueueInputOutcome::Queued(_)
        ));
        let leaf = if already_consumed {
            let appended = store
                .consume_chat_input(admitted.clone(), consume(&pending, b))
                .await
                .unwrap()
                .value;
            let ConsumedPending::Appended { entry, .. } = appended else {
                panic!("expected a human post on the current branch");
            };
            entry.seq
        } else {
            b
        };
        let request = consume(&pending, leaf);
        let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
        assert!(matches!(
            store
                .consume_chat_input(tainted.clone(), request.clone())
                .await,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            before
        );
        let clean = store
            .consume_chat_input(admitted.clone(), request.clone())
            .await
            .unwrap();
        if already_consumed {
            assert!(matches!(clean.value, ConsumedPending::AlreadyConsumed));
        } else {
            assert!(matches!(
                clean.value,
                ConsumedPending::BranchChanged { queued, current } if queued == a && current == b
            ));
        }
        assert_eq!(
            store
                .consume_chat_input(admitted.clone(), request.clone())
                .await
                .unwrap()
                .receipt,
            clean.receipt
        );
        assert!(matches!(
            store.consume_chat_input(tainted.clone(), request).await,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
        if !already_consumed {
            assert!(
                store
                    .dismiss_chat_input(
                        agent.clone(),
                        DismissPending {
                            thread: thread.clone(),
                            input: pending,
                        },
                    )
                    .await
                    .unwrap()
            );
        }
    }
}

async fn keeper_log_visibility(store: &CanonicalStore, owner: &SpaceContext) {
    let scope = owner.scope();
    let principal = owner.auth().principal();
    let log = sample_thread_id(228);
    let keeper = |tag, log| {
        let run = sample_run_id(tag);
        let auth = EngineAuthContext::for_human(
            VerifiedHuman::attest(
                principal.clone(),
                GrantId::from_bytes([tag; 16]),
                owner.auth().spaces().clone(),
                false,
            )
            .with_credential(AuthenticatedCredential::ScheduledRun {
                schedule: ScheduleId::from_bytes([tag; 16]),
                run: run.clone(),
                lease: LeaseEpoch::new(1).unwrap(),
            }),
        )
        .for_keeper(run, scope.space_id.clone(), None, BTreeSet::new())
        .unwrap()
        .with_verified_keeper_log(log)
        .unwrap();
        SpaceContext::new(auth, scope.clone(), make_budget()).unwrap()
    };
    let assigned = keeper(226, log.clone());
    store
        .create_chat(
            assigned.clone(),
            next_mutation(
                scope,
                principal,
                CreateChat {
                    thread: log.clone(),
                    kind: ChatThreadKind::KeeperLog,
                    owner: principal.clone(),
                    project_folder: None,
                    title: "Keeper log".into(),
                },
            ),
        )
        .await
        .unwrap();
    let other_keeper = keeper(227, sample_thread_id(227));
    let mut grants = owner.auth().spaces().clone();
    let member_grant = grants.get_mut(&scope.space_id).unwrap();
    member_grant.role = SpaceRole::Viewer;
    member_grant.write_classes.clear();
    let member = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            sample_principal_id(226),
            GrantId::from_bytes([228; 16]),
            grants,
            false,
        )),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let cutoff = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let limit = PageLimit::new(200).unwrap();
    for (reader, allowed) in [
        (owner.clone(), true),
        (assigned, true),
        (member, false),
        (other_keeper, false),
    ] {
        let direct = store
            .read_chat(
                reader.clone(),
                ChatRead {
                    thread: log.clone(),
                    leaf: ThreadEntrySeq::ZERO,
                    before: None,
                    max_entries: limit,
                },
            )
            .await;
        if allowed {
            assert_eq!(direct.unwrap().thread.id, log);
        } else {
            assert!(matches!(
                direct,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ));
        }
        let ChangeReadResult::Log(changes) = store
            .read_changes(
                reader.clone(),
                ChangeRead::Log {
                    after: ChangeCursor {
                        scope: scope.clone(),
                        after: SpaceSeq::ZERO,
                    },
                    through: cutoff,
                    limit,
                },
            )
            .await
            .unwrap()
        else {
            panic!("expected change log");
        };
        assert_eq!(
            changes
                .changes
                .iter()
                .any(|row| row.entity == EntityId::Thread(log.clone())),
            allowed
        );
        let ChangeReadResult::Seed(seed) = store
            .read_changes(
                reader,
                ChangeRead::Seed {
                    scope: scope.clone(),
                    cutoff: Some(cutoff),
                    limit,
                },
            )
            .await
            .unwrap()
        else {
            panic!("expected change seed");
        };
        assert_eq!(seed.threads.iter().any(|thread| thread.id == log), allowed);
    }
}
