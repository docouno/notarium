use super::*;
use notarium_core::{
    auth::{AuthenticatedCredential, ProposalHumanAccess, SpaceLifecycle},
    classes::ClassEgressFence,
    error::CommitEffect,
    model::FolderRef,
    ports::{
        ChatContentRead, ChatProposalRead, ChatProvenance, ControlCatalogPort, DismissPending,
        ProviderToolCall, ProviderToolCallId, SubmitUserChatInput, SubmitUserChatOutcome,
    },
    receipt::AccountCommandIdentity,
};
use std::sync::atomic::Ordering;

async fn setup(
    store: &CanonicalStore,
    key: u8,
    kind: SpaceKind,
    thread_kind: ChatThreadKind,
) -> (HistoryScope, PrincipalId, ChatThreadId) {
    let owner = sample_principal_id(key);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(key),
            incarnation: sample_incarnation(key),
            root_folder_id: sample_folder_id(key),
            slug: format!("conversation-{key}"),
            kind,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let thread = sample_thread_id(key);
    let created = store
        .create_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: thread_kind,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Conversation".into(),
                },
            ),
        )
        .await
        .unwrap()
        .value;
    assert_eq!(created.title, "Conversation");
    assert_eq!(created.active_run, None);
    (scope, owner, thread)
}

async fn original_human_classifier(store: &CanonicalStore) {
    let (scope, alice, thread) =
        setup(store, 0xa1, SpaceKind::Shared, ChatThreadKind::SpaceGroup).await;
    let bob = sample_principal_id(0xa2);
    let carol = sample_principal_id(0xa3);
    let run = sample_run_id(0xa1);
    let thread_ctx = |actor: &PrincipalId| owner_ctx(&scope, actor.clone());
    let agent = claim_run(
        store,
        thread_ctx(&alice),
        ChatAudience::Shared,
        &thread,
        &run,
        ThreadEntrySeq::ZERO,
    )
    .await;
    let run_request = || ChatRunRequest {
        thread: thread.clone(),
        expected_run: run.clone(),
    };
    let pending = |sender: &PrincipalId, seed, base| PendingChatInput {
        id: PendingInputId::from_bytes([seed; 16]),
        thread: thread.clone(),
        sender: sender.clone(),
        body: "A pending message".into(),
        queued_base_leaf: base,
        in_flight_run: run.clone(),
        mentions_agent: true,
    };
    let bob_pending = pending(&bob, 0xa2, ThreadEntrySeq::ZERO);
    let carol_pending = pending(&carol, 0xa3, ThreadEntrySeq::ZERO);
    for item in [&bob_pending, &carol_pending] {
        assert!(matches!(
            store
                .queue_chat_input(
                    thread_ctx(&item.sender),
                    next_mutation(&scope, &item.sender, item.clone()),
                )
                .await
                .unwrap(),
            QueueInputOutcome::Queued(_)
        ));
    }
    assert_eq!(
        store
            .finish_run_if_queue_empty(agent.clone(), run_request())
            .await
            .unwrap(),
        FinishChatRunOutcome::Pending,
    );
    assert_eq!(
        store
            .list_pending_chat_inputs(agent.clone(), thread.clone())
            .await
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        vec![bob_pending.id.clone(), carol_pending.id.clone()],
    );

    let model = store
        .append_chat(
            agent.clone(),
            next_mutation(
                &scope,
                &alice,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("A model answer".into()),
                    tool_calls: Vec::new(),
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    let redact = |entry, revision| {
        next_mutation(
            &scope,
            &alice,
            RedactChatEntry {
                thread: thread.clone(),
                entry,
                expected_thread_revision: revision,
            },
        )
    };
    let read = |leaf| ChatRead {
        thread: thread.clone(),
        leaf,
        before: None,
        max_entries: PageLimit::new(5).unwrap(),
    };
    let revision = store
        .read_chat(thread_ctx(&alice), read(model.seq))
        .await
        .unwrap()
        .thread
        .revision;
    store
        .redact_chat_entry(thread_ctx(&alice), redact(model.seq, revision))
        .await
        .unwrap();

    let consume = |item: &PendingChatInput, leaf| {
        next_mutation(
            &scope,
            &item.sender,
            ConsumePending {
                thread: thread.clone(),
                input: item.id.clone(),
                expected_run: run.clone(),
                expected_active_run: run.clone(),
                current_leaf: leaf,
            },
        )
    };
    let from_bob = store
        .consume_chat_input(thread_ctx(&bob), consume(&bob_pending, model.seq))
        .await
        .unwrap()
        .value;
    let ConsumedPending::Appended {
        entry: other_human,
        intervening_human: false,
    } = from_bob
    else {
        panic!("a redacted model reply counted as a human post");
    };
    assert_eq!(other_human.run.as_ref(), Some(&run));
    let revision = store
        .read_chat(thread_ctx(&alice), read(other_human.seq))
        .await
        .unwrap()
        .thread
        .revision;
    store
        .redact_chat_entry(thread_ctx(&alice), redact(other_human.seq, revision))
        .await
        .unwrap();
    let from_carol = store
        .consume_chat_input(thread_ctx(&carol), consume(&carol_pending, other_human.seq))
        .await
        .unwrap()
        .value;
    let ConsumedPending::Appended {
        entry: carol_entry,
        intervening_human: true,
    } = from_carol
    else {
        panic!("a redacted queued human was lost from the branch")
    };
    let other_run = sample_run_id(0xa3);
    let actor = thread_ctx(&carol);
    let other_agent = actor
        .auth()
        .for_agent_run(
            other_run.clone(),
            scope.space_id.clone(),
            ChatAudience::Shared,
            actor.auth().spaces().clone(),
        )
        .unwrap();
    let attempted_handoff = store
        .claim_active_run(
            SpaceContext::new(other_agent, scope.clone(), make_budget()).unwrap(),
            ClaimChatRun {
                thread: thread.clone(),
                run: other_run,
                expected_leaf: carol_entry.seq,
                previous_run: Some(run.clone()),
            },
        )
        .await
        .unwrap();
    assert_eq!(attempted_handoff, ClaimChatRunOutcome::Changed);

    let queued = pending(&bob, 0xa4, other_human.seq);
    assert!(matches!(
        store
            .queue_chat_input(
                thread_ctx(&bob),
                next_mutation(&scope, &bob, queued.clone())
            )
            .await
            .unwrap(),
        QueueInputOutcome::Queued(_)
    ));
    assert!(
        store
            .dismiss_chat_input(
                agent.clone(),
                DismissPending {
                    thread: thread.clone(),
                    input: queued.id.clone(),
                }
            )
            .await
            .unwrap()
    );
    assert_eq!(
        store
            .finish_run_if_queue_empty(agent, run_request())
            .await
            .unwrap(),
        FinishChatRunOutcome::Cleared,
    );
    let after = pending(&bob, 0xa5, other_human.seq);
    assert!(matches!(
        store
            .queue_chat_input(thread_ctx(&bob), next_mutation(&scope, &bob, after))
            .await
            .unwrap(),
        QueueInputOutcome::Changed
    ));
}

async fn model_payloads(store: &CanonicalStore) {
    let (scope, owner, thread) =
        setup(store, 0xb1, SpaceKind::Personal, ChatThreadKind::Personal).await;
    let run = sample_run_id(0xb1);
    let interactive = || owner_ctx(&scope, owner.clone());
    let agent = claim_run(
        store,
        interactive(),
        ChatAudience::Personal,
        &thread,
        &run,
        ThreadEntrySeq::ZERO,
    )
    .await;
    let mut parent = ThreadEntrySeq::ZERO;
    for (seed, text, expected_blob, include_call) in [
        (0xb1, "Here is a result".to_owned(), false, true),
        (0xb2, "Large response. ".repeat(100), true, true),
        (
            0xb3,
            "\u{FDD0}notarium_model_turn_v1\n{\"text\":\"raw\"}".to_owned(),
            false,
            false,
        ),
        (0xb4, "{\"text\":\"raw\"}".to_owned(), false, false),
    ] {
        let id = CommandKey::from_bytes([seed; 16]);
        let tool_calls: Vec<_> = include_call
            .then(|| ProviderToolCall {
                id: ProviderToolCallId::new(id.as_str().to_owned()).unwrap(),
                name: "list_notes".to_owned(),
                arguments: BTreeMap::new(),
            })
            .into_iter()
            .collect();
        let appended = store
            .append_chat(
                agent.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    AppendChat {
                        thread: thread.clone(),
                        parent,
                        kind: ChatEntryKind::Model,
                        body: ChatInputBody::Text(text.clone()),
                        tool_calls,
                        provenance: Some(ChatProvenance::default()),
                        interruption: None,
                        proposed_diff: None,
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap()
            .value;
        parent = appended.seq;
        let digest = match appended.body {
            ChatBody::Inline(raw) if !expected_blob => {
                ContentDigest::from_bytes(*blake3::hash(raw.as_bytes()).as_bytes())
            }
            ChatBody::Blob(digest) if expected_blob => digest,
            other => panic!("unexpected canonical model body: {other:?}"),
        };
        let items = store
            .read_chat_contents(
                interactive(),
                ChatContentRead {
                    thread: thread.clone(),
                    leaf: parent,
                    entries: vec![parent],
                },
            )
            .await
            .unwrap();
        let item = &items[0];
        assert_eq!(item.content.digest(), digest);
        assert_eq!(
            ClassEgressFence::chat_transcript(&item.content, interactive().auth()).unwrap(),
            text
        );
        let (hits, _) = store
            .hydrate_live_visible_chat_hits(
                &interactive(),
                &[(thread.clone(), parent)],
                PageLimit::new(1).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(hits[0].text, text);
        assert_eq!(item.tool_calls.len(), usize::from(include_call));
        if include_call {
            assert_eq!(item.tool_calls[0].id.as_str(), id.as_str());
        }
    }
}

async fn handoff_and_archive_fence(store: &CanonicalStore) {
    let (scope, alice, thread) =
        setup(store, 0xa6, SpaceKind::Shared, ChatThreadKind::SpaceGroup).await;
    let bob = sample_principal_id(0xa7);
    let initial = sample_run_id(0xa6);
    let successor = sample_run_id(0xa7);
    claim_run(
        store,
        owner_ctx(&scope, alice.clone()),
        ChatAudience::Shared,
        &thread,
        &initial,
        ThreadEntrySeq::ZERO,
    )
    .await;
    let new_input = |sender: &PrincipalId, seed, run: &AgentRunId, base| PendingChatInput {
        id: PendingInputId::from_bytes([seed; 16]),
        thread: thread.clone(),
        sender: sender.clone(),
        body: "A queued message with a staged body. ".repeat(18),
        queued_base_leaf: base,
        in_flight_run: run.clone(),
        mentions_agent: true,
    };
    let bob_queued = new_input(&bob, 0xa7, &initial, ThreadEntrySeq::ZERO);
    let alice_queued = new_input(&alice, 0xa8, &initial, ThreadEntrySeq::ZERO);
    for input in [&bob_queued, &alice_queued] {
        assert!(matches!(
            store
                .queue_chat_input(
                    owner_ctx(&scope, input.sender.clone()),
                    next_mutation(&scope, &input.sender, input.clone()),
                )
                .await
                .unwrap(),
            QueueInputOutcome::Queued(_)
        ));
    }
    let consume = |item: &PendingChatInput, active: &AgentRunId, leaf| {
        next_mutation(
            &scope,
            &item.sender,
            ConsumePending {
                thread: thread.clone(),
                input: item.id.clone(),
                expected_run: item.in_flight_run.clone(),
                expected_active_run: active.clone(),
                current_leaf: leaf,
            },
        )
    };
    assert_validation_err(
        &store
            .consume_chat_input(
                owner_ctx(&scope, alice.clone()),
                consume(&alice_queued, &initial, ThreadEntrySeq::ZERO),
            )
            .await,
        ValidationReason::InvalidState,
    );
    let accepted = store
        .consume_chat_input(
            owner_ctx(&scope, bob.clone()),
            consume(&bob_queued, &initial, ThreadEntrySeq::ZERO),
        )
        .await
        .unwrap()
        .value;
    let ConsumedPending::Appended {
        entry,
        intervening_human: false,
    } = accepted
    else {
        panic!("oldest input should be eligible for the handoff")
    };
    let human = owner_ctx(&scope, bob.clone());
    let narrowed = human
        .auth()
        .for_agent_run(
            successor.clone(),
            scope.space_id.clone(),
            ChatAudience::Shared,
            human.auth().spaces().clone(),
        )
        .unwrap();
    let runner = SpaceContext::new(narrowed, scope.clone(), make_budget()).unwrap();
    assert_eq!(
        store
            .claim_active_run(
                runner.clone(),
                ClaimChatRun {
                    thread: thread.clone(),
                    run: successor.clone(),
                    expected_leaf: entry.seq,
                    previous_run: Some(initial.clone()),
                }
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    );

    assert_validation_err(
        &store
            .consume_chat_input(
                owner_ctx(&scope, alice.clone()),
                consume(&alice_queued, &initial, entry.seq),
            )
            .await,
        ValidationReason::InvalidAuthority,
    );
    let accepted = store
        .consume_chat_input(
            owner_ctx(&scope, alice.clone()),
            consume(&alice_queued, &successor, entry.seq),
        )
        .await
        .unwrap()
        .value;
    let ConsumedPending::Appended {
        entry,
        intervening_human: true,
    } = accepted
    else {
        panic!("the successor may drain an inherited item as a plain Human entry")
    };
    assert_eq!(entry.run.as_ref(), Some(&successor));

    let abandoned = new_input(&bob, 0xa9, &successor, entry.seq);
    assert!(matches!(
        store
            .queue_chat_input(
                owner_ctx(&scope, bob.clone()),
                next_mutation(&scope, &bob, abandoned),
            )
            .await
            .unwrap(),
        QueueInputOutcome::Queued(_)
    ));
    let stage = |key| AccountCommandIdentity {
        owner: alice.clone(),
        actor: alice.clone(),
        key: CommandKey::from_bytes([key; 16]),
        hash: ContentDigest::from_bytes([key; 32]),
        expected: notarium_core::ids::ControlRevision::ZERO,
    };
    store
        .change_lifecycle(
            make_budget(),
            stage(0xaa),
            scope.clone(),
            SpaceLifecycle::Archived,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .finish_run_if_queue_empty(
                runner,
                ChatRunRequest {
                    thread: thread.clone(),
                    expected_run: successor,
                }
            )
            .await
            .unwrap(),
        FinishChatRunOutcome::Cleared
    );
    store
        .change_lifecycle(
            make_budget(),
            stage(0xab),
            scope.clone(),
            SpaceLifecycle::Active,
        )
        .await
        .unwrap();
    let branch = store
        .read_chat(
            owner_ctx(&scope, alice),
            ChatRead {
                thread,
                leaf: entry.seq,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(branch.thread.active_run, None);
    assert_eq!(branch.thread.head, entry.seq);
}

async fn clean_leaf_retains_audit_taint(store: &CanonicalStore) {
    let (scope, owner, thread) =
        setup(store, 0xe6, SpaceKind::Personal, ChatThreadKind::Personal).await;
    let post = |parent, tainted| {
        next_mutation(
            &scope,
            &owner,
            AppendChat {
                thread: thread.clone(),
                parent,
                kind: ChatEntryKind::Human,
                body: ChatInputBody::Text("A selected branch".into()),
                tool_calls: Vec::new(),
                provenance: None,
                interruption: None,
                proposed_diff: None,
                referenced_notes: Vec::new(),
                tainted,
            },
        )
    };
    let old = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            post(ThreadEntrySeq::ZERO, true),
        )
        .await
        .unwrap()
        .value;
    let forked = store
        .fork_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                ForkChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    assert!(!forked.tainted);
    let active = claim_run(
        store,
        owner_ctx(&scope, owner.clone()),
        ChatAudience::Personal,
        &thread,
        &sample_run_id(0xe6),
        ThreadEntrySeq::ZERO,
    )
    .await;
    assert!(!active.auth().taint().is_tainted());
    let fresh = store
        .append_chat(active.clone(), post(ThreadEntrySeq::ZERO, false))
        .await
        .unwrap()
        .value;
    assert!(!fresh.tainted);
    assert_eq!(store.execute_diagnostic_read_sql_for_test(None, &format!(
        "SELECT CAST(ext_space_tainted_mask AS BIGINT) FROM chat_threads WHERE space_id='{}' AND thread_id='{}'",
        scope.space_id.as_str(), thread.as_str(),
    )).await.unwrap(), 1);
    let read = store
        .read_chat(
            owner_ctx(&scope, owner),
            ChatRead {
                thread,
                leaf: old.seq,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap();
    assert!(read.thread.tainted);
    assert_eq!(read.thread.head, fresh.seq);
}

async fn submitted_input_replays_across_route_changes(store: &CanonicalStore) {
    let (scope, owner, thread) =
        setup(store, 0xe5, SpaceKind::Personal, ChatThreadKind::Personal).await;
    let human = || owner_ctx(&scope, owner.clone());
    let input = |seed, expected_leaf| SubmitUserChatInput {
        identity: next_mutation(&scope, &owner, ()).identity,
        id: PendingInputId::from_bytes([seed; 16]),
        thread: thread.clone(),
        expected_leaf,
        body: "A human input with a staged body. ".repeat(25),
        mentions_agent: true,
    };
    let lose_ack = || {
        store
            .writer_faults()
            .unwrap()
            .drop_commit_response_once
            .store(true, Ordering::SeqCst);
    };

    let direct = input(0xe5, ThreadEntrySeq::ZERO);
    lose_ack();
    assert!(matches!(
        store.submit_user_chat_input(human(), direct.clone()).await,
        Err(PortError::Unavailable(failure)) if failure.effect() == CommitEffect::Unknown
    ));
    let Some(SubmitUserChatOutcome::Appended(appended)) = store
        .lookup_user_chat_input(human(), &direct)
        .await
        .unwrap()
    else {
        panic!("the direct submission must have a durable append receipt")
    };
    assert!(matches!(appended.value.body, ChatBody::Blob(_)));

    let run = sample_run_id(0xe5);
    let agent = claim_run(
        store,
        human(),
        ChatAudience::Personal,
        &thread,
        &run,
        appended.value.seq,
    )
    .await;
    let SubmitUserChatOutcome::Appended(replayed) = store
        .submit_user_chat_input(human(), direct.clone())
        .await
        .unwrap()
    else {
        panic!("an append receipt cannot be rerouted into the active queue")
    };
    assert_eq!(replayed.value.seq, appended.value.seq);
    assert!(
        store
            .list_pending_chat_inputs(agent.clone(), thread.clone())
            .await
            .unwrap()
            .is_empty()
    );

    let pending = input(0xe6, appended.value.seq);
    lose_ack();
    assert!(matches!(
        store.submit_user_chat_input(human(), pending.clone()).await,
        Err(PortError::Unavailable(failure)) if failure.effect() == CommitEffect::Unknown
    ));
    let Some(SubmitUserChatOutcome::Queued(queued)) = store
        .lookup_user_chat_input(human(), &pending)
        .await
        .unwrap()
    else {
        panic!("the queued submission must have a durable receipt")
    };
    assert_eq!(queued.id, pending.id);
    assert_eq!(queued.in_flight_run, run);
    assert!(
        store
            .dismiss_chat_input(
                agent.clone(),
                DismissPending {
                    thread: thread.clone(),
                    input: pending.id.clone(),
                }
            )
            .await
            .unwrap()
    );
    assert_eq!(
        store
            .finish_run_if_queue_empty(
                agent,
                ChatRunRequest {
                    thread: thread.clone(),
                    expected_run: run,
                }
            )
            .await
            .unwrap(),
        FinishChatRunOutcome::Cleared
    );
    let current_cut = store.get_space(&scope.space_id).await.unwrap().last_seq;
    assert!(matches!(
        store.submit_user_chat_input(human(), pending).await.unwrap(),
        SubmitUserChatOutcome::Queued(replayed) if replayed.id == queued.id
    ));
    assert_eq!(
        store.get_space(&scope.space_id).await.unwrap().last_seq,
        current_cut
    );

    let branch = store
        .read_chat(
            human(),
            ChatRead {
                thread: thread.clone(),
                leaf: appended.value.seq,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap();
    store
        .redact_chat_entry(
            human(),
            next_mutation(
                &scope,
                &owner,
                RedactChatEntry {
                    thread,
                    entry: appended.value.seq,
                    expected_thread_revision: branch.thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    assert!(matches!(
        store.lookup_user_chat_input(human(), &direct).await.unwrap(),
        Some(SubmitUserChatOutcome::Appended(replayed)) if matches!(replayed.value.body, ChatBody::Redacted)
    ));
    let mut forged = direct;
    forged.body.push('!');
    assert!(matches!(
        store.lookup_user_chat_input(human(), &forged).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
}

async fn confirmed_source_fence(store: &CanonicalStore) {
    let (source, owner, thread) =
        setup(store, 0xc1, SpaceKind::Personal, ChatThreadKind::Personal).await;
    let (target, _, _) = setup(store, 0xc2, SpaceKind::Shared, ChatThreadKind::SpaceGroup).await;
    let project = FolderRef {
        space_id: target.space_id.clone(),
        folder_id: sample_folder_id(0xcd),
    };
    store
        .create_folder(CreateFolderSpec {
            scope: target.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: project.folder_id.clone(),
            parent: None,
            slug: "approved-project".into(),
            display_name: "Approved project".into(),
            is_project: true,
            project_slug: Some("approved-project".into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let run = sample_run_id(0xc1);
    let agent = claim_run(
        store,
        owner_ctx(&source, owner.clone()),
        ChatAudience::Personal,
        &thread,
        &run,
        ThreadEntrySeq::ZERO,
    )
    .await;
    let call_id = CommandKey::from_bytes([0xc1; 16]);
    let model = store
        .append_chat(
            agent.clone(),
            next_mutation(
                &source,
                &owner,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text(String::new()),
                    tool_calls: vec![ProviderToolCall {
                        id: ProviderToolCallId::new(call_id.as_str().to_owned()).unwrap(),
                        name: "create_note".into(),
                        arguments: BTreeMap::new(),
                    }],
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    let tool = store
        .append_chat(
            agent,
            next_mutation(
                &source,
                &owner,
                AppendChat {
                    thread: thread.clone(),
                    parent: model.seq,
                    kind: ChatEntryKind::Tool { call_id },
                    body: ChatInputBody::Text("Confirmation is required".into()),
                    tool_calls: Vec::new(),
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: Some("Opaque confirmed action".into()),
                    referenced_notes: Vec::new(),
                    tainted: true,
                },
            ),
        )
        .await
        .unwrap()
        .value;

    let (hits, _) = store
        .hydrate_live_visible_chat_hits(
            &owner_ctx(&source, owner.clone()),
            &[(thread.clone(), tool.seq)],
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(hits[0].text, "Confirmation is required");

    let role = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let live = VerifiedHuman::attest(
        owner.clone(),
        GrantId::from_bytes([0xc3; 16]),
        BTreeMap::from([
            (source.space_id.clone(), role.clone()),
            (target.space_id.clone(), role),
        ]),
        false,
    )
    .with_human_management(true)
    .with_credential(AuthenticatedCredential::TrustedNone);
    let prior = EngineAuthContext::for_human(live.clone());
    let read_auth =
        EngineAuthContext::for_proposal_human(&prior, live.clone(), ProposalHumanAccess::ReadOnly)
            .unwrap();
    let write_auth =
        EngineAuthContext::for_proposal_human(&prior, live, ProposalHumanAccess::Write).unwrap();
    let reader = SpaceContext::new(read_auth, source.clone(), make_budget()).unwrap();
    let proposal = store
        .read_chat_proposal(
            reader.clone(),
            ChatProposalRead {
                thread: thread.clone(),
                entry: tool.seq,
            },
        )
        .await
        .unwrap();
    assert!(reader.auth().taint().is_tainted());
    assert!(!write_auth.taint().is_tainted());

    let make_request = |key| {
        next_mutation(
            &target,
            &owner,
            CreateNote {
                note: sample_note_id(key),
                parent: Some(project.folder_id.clone()),
                slug: format!("confirmed-{key}"),
                class: DocClass::UserDoc,
                carrier: "# Explicitly approved".into(),
                folder_page: false,
            },
        )
    };
    let write = SpaceContext::new(write_auth, target.clone(), make_budget()).unwrap();
    let anchor = store
        .resolve_folder_path(
            write.clone(),
            Some(project.folder_id.clone()),
            String::new(),
        )
        .await
        .unwrap()
        .unwrap();
    let request = make_request(0xc4);
    let stale = make_request(0xc5);
    let approved = |identity: &CommandIdentity| {
        write
            .clone()
            .with_confirmed_chat_step(proposal.witness().clone(), identity)
            .unwrap()
            .with_confirmed_note_destination(notarium_core::ports::ConfirmedNoteDestination {
                anchor: anchor.reference.clone(),
                anchor_revision: anchor.revision.clone(),
                anchor_path: anchor.path.clone(),
                anchor_ancestors: anchor.ancestor_folders.clone(),
                missing_suffix: String::new(),
                move_source: None,
            })
            .unwrap()
            .restrict_to_project(&project)
            .unwrap()
    };
    let outcome = store
        .create_note(approved(&request.identity), request.clone())
        .await
        .unwrap();
    let replay = store
        .create_note(approved(&request.identity), request.clone())
        .await
        .unwrap();
    assert_eq!(outcome.receipt, replay.receipt);
    assert_validation_err(
        &store
            .create_note(approved(&request.identity), stale.clone())
            .await,
        ValidationReason::InvalidAuthority,
    );

    let owner_source = owner_ctx(&source, owner.clone());
    let branch = store
        .read_chat(
            owner_source.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: tool.seq,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap();
    // Redacting the referenced Model invalidates the still-visible Tool.
    store
        .redact_chat_entry(
            owner_source,
            next_mutation(
                &source,
                &owner,
                RedactChatEntry {
                    thread,
                    entry: model.seq,
                    expected_thread_revision: branch.thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    let cut = store.read_space(&target.space_id).await.unwrap().last_seq;
    for item in [request, stale] {
        assert!(matches!(
            store.create_note(approved(&item.identity), item).await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }
    assert_eq!(
        store.read_space(&target.space_id).await.unwrap().last_seq,
        cut
    );
}

#[tokio::test]
async fn supervised_queue_and_hydration_match_across_dialects() {
    let local = TempDataRoot::new("chat-agent-local");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(0xa1),
        local.data_root(),
    ))
    .await
    .unwrap();
    original_human_classifier(&store).await;
    model_payloads(&store).await;
    nested_chat_egress_dependencies(&store).await;
    handoff_and_archive_fence(&store).await;
    clean_leaf_retains_audit_taint(&store).await;
    submitted_input_replays_across_route_changes(&store).await;
    confirmed_source_fence(&store).await;
    runtime.shutdown().await.unwrap();

    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let pg_blobs = TempDataRoot::new("chat-agent-pg");
    let (store, runtime) = CanonicalRuntime::open(fixtures.pg_local_config(
        sample_installation_id(0xa3),
        &schema,
        pg_blobs.data_root(),
    ))
    .await
    .unwrap();
    original_human_classifier(&store).await;
    model_payloads(&store).await;
    nested_chat_egress_dependencies(&store).await;
    handoff_and_archive_fence(&store).await;
    clean_leaf_retains_audit_taint(&store).await;
    submitted_input_replays_across_route_changes(&store).await;
    confirmed_source_fence(&store).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

/// Both contenders miss the receipt. Pause them during preparation, commit
/// their competitor, then check replay and CAS through the public port.
async fn race_prepared_append(
    store: &CanonicalStore,
    agent: &SpaceContext,
    request: &mut Mutation<AppendChat>,
) -> notarium_core::ports::ChatEntry {
    use notarium_canonical::chats::preparation_test::pause_once;
    use tokio::sync::Barrier;

    let head = |leaf| {
        store.read_chat(
            agent.clone(),
            ChatRead {
                thread: request.input.thread.clone(),
                leaf,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
    };
    request.preconditions.revision =
        Some(head(request.input.parent).await.unwrap().thread.revision);
    let mut competing = request.clone();
    competing.identity.key = CommandKey::from_bytes(random_bytes_16());
    let barrier = Arc::new(Barrier::new(3));
    let (duplicate, competing, winner) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(
            pause_once(
                barrier.clone(),
                store.append_chat(agent.clone(), request.clone())
            ),
            pause_once(barrier.clone(), store.append_chat(agent.clone(), competing)),
            async {
                barrier.wait().await;
                let winner = store.append_chat(agent.clone(), request.clone()).await;
                barrier.wait().await;
                winner
            },
        )
    })
    .await
    .expect("both contenders must reach write preparation");
    let winner = winner.unwrap();
    let duplicate = duplicate.unwrap();
    assert_eq!(duplicate.receipt, winner.receipt);
    assert_eq!(duplicate.value, winner.value);
    let current = head(winner.value.seq).await.unwrap().thread;
    assert_eq!(current.head, winner.value.seq);
    assert!(
        matches!(competing, Err(PortError::Domain(DomainError::RevisionConflict {
        current: revision, ..
    })) if revision == current.revision)
    );
    winner.value
}

async fn nested_chat_egress_dependencies(store: &CanonicalStore) {
    use notarium_core::ports::{
        AccountContext, Cancellation, ProviderEgressCatalogPort, ProviderEgressRequest,
    };

    let (scope, owner, thread) =
        setup(store, 0xba, SpaceKind::Personal, ChatThreadKind::Personal).await;
    let human = owner_ctx(&scope, owner.clone());
    let run = sample_run_id(0xba);
    let agent = claim_run(
        store,
        human.clone(),
        ChatAudience::Personal,
        &thread,
        &run,
        ThreadEntrySeq::ZERO,
    )
    .await;

    let append = |parent, kind, text: &str, provenance| {
        next_mutation(
            &scope,
            &owner,
            AppendChat {
                thread: thread.clone(),
                parent,
                kind,
                body: ChatInputBody::Text(text.into()),
                provenance,
                interruption: None,
                proposed_diff: None,
                tool_calls: vec![],
                referenced_notes: vec![],
                tainted: false,
            },
        )
    };
    let source = store
        .append_chat(
            human.clone(),
            append(
                ThreadEntrySeq::ZERO,
                ChatEntryKind::Human,
                "Human source",
                None,
            ),
        )
        .await
        .unwrap()
        .value;
    let read = |entry| ChatContentRead {
        thread: thread.clone(),
        leaf: entry,
        entries: vec![entry],
    };
    let source_origin = store
        .read_chat_contents(agent.clone(), read(source.seq))
        .await
        .unwrap()[0]
        .content
        .origin();
    let account = || AccountContext::new(agent.auth().clone(), agent.budget.clone());
    let metadata = store
        .disclosure(
            account(),
            notarium_core::ports::CatalogDisclosure::Space(scope.clone()),
        )
        .await
        .unwrap()
        .current()
        .origin();
    let mut model_request = append(
        source.seq,
        ChatEntryKind::Model,
        "Derived model",
        Some(ChatProvenance {
            origins: vec![source_origin.clone(), metadata.clone()],
            projects: vec![],
            compacts_through: None,
        }),
    );
    let model = race_prepared_append(store, &agent, &mut model_request).await;
    let model_origin = store
        .read_chat_contents(agent.clone(), read(model.seq))
        .await
        .unwrap()[0]
        .content
        .origin();
    let mut checkpoint_request = append(
        model.seq,
        ChatEntryKind::Compaction,
        "First human input",
        Some(ChatProvenance {
            origins: vec![source_origin],
            projects: vec![],
            compacts_through: Some(source.seq),
        }),
    );
    let checkpoint = race_prepared_append(store, &agent, &mut checkpoint_request).await;
    let compaction = store
        .append_chat(
            agent.clone(),
            append(
                checkpoint.seq,
                ChatEntryKind::Compaction,
                "Compacted model",
                Some(ChatProvenance {
                    origins: vec![model_origin.clone()],
                    projects: vec![],
                    compacts_through: None,
                }),
            ),
        )
        .await
        .unwrap()
        .value;
    let compact_origin = store
        .read_chat_contents(agent.clone(), read(compaction.seq))
        .await
        .unwrap()[0]
        .content
        .origin();
    let proof = store
        .chat_dependencies(account(), vec![compact_origin.clone()])
        .await
        .unwrap();
    assert_eq!(proof.origins, vec![metadata.clone()]);
    assert_eq!(
        store
            .append_chat(agent.clone(), model_request)
            .await
            .unwrap()
            .value
            .seq,
        model.seq
    );
    legacy_proof_chain(store, &agent, &model_origin, &metadata).await;
    let request = ProviderEgressRequest {
        origins: [vec![compact_origin], proof.origins].concat(),
        primary: scope.clone(),
        project: None,
        project_folders: BTreeSet::new(),
        secondary_projects: proof.projects,
    };
    let first = store
        .acquire_egress(account(), request.clone(), Cancellation::default())
        .await
        .unwrap();
    assert_eq!(
        first
            .current()
            .iter()
            .map(|value| value.origin())
            .collect::<Vec<_>>(),
        request.origins
    );
    drop(first);

    let branch = store
        .read_chat(
            human.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: compaction.seq,
                before: None,
                max_entries: PageLimit::new(4).unwrap(),
            },
        )
        .await
        .unwrap();
    store
        .redact_chat_entry(
            human,
            next_mutation(
                &scope,
                &owner,
                RedactChatEntry {
                    thread: thread.clone(),
                    entry: source.seq,
                    expected_thread_revision: branch.thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    assert!(
        matches!(
            store.chat_dependencies(account(), vec![model_origin]).await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "redacting the original source invalidates the stored model proof"
    );
    assert!(
        store
            .acquire_egress(account(), request, Cancellation::default())
            .await
            .is_err()
    );
}

/// Older entries carried only their direct proof. Seed a long chain in one
/// insert, then use normal discovery and admission on its tail.
async fn legacy_proof_chain(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    model: &notarium_core::classes::ProviderOrigin,
    metadata: &notarium_core::classes::ProviderOrigin,
) {
    use notarium_core::{
        classes::ProviderOrigin,
        ports::{
            AccountContext, Cancellation, MAX_PROVIDER_ORIGINS, ProviderEgressCatalogPort,
            ProviderEgressRequest,
        },
    };
    let ProviderOrigin::Chat {
        space,
        thread,
        entry,
        ..
    } = model
    else {
        unreachable!()
    };
    let mut edge = model.clone();
    let ProviderOrigin::Chat { entry: prior, .. } = &mut edge else {
        unreachable!()
    };
    *prior = ThreadEntrySeq::MAX;
    let proof = serde_json::to_string(&ChatProvenance {
        origins: vec![edge],
        ..Default::default()
    })
    .unwrap();
    let (prefix, suffix) = proof
        .split_once(&ThreadEntrySeq::MAX.get().to_string())
        .unwrap();
    let start = 100;
    let end = start + MAX_PROVIDER_ORIGINS;
    let first_parent = entry.get();
    let count = store.execute_diagnostic_write_sql_for_test(&format!(
        "WITH RECURSIVE chain(n) AS (SELECT {start} UNION ALL SELECT n+1 FROM chain WHERE n<{end})
         INSERT INTO chat_entries(space_id,thread_id,entry_seq,parent_seq,revision_id,kind,author_id,
             agent_run_id,inline_text,referenced_notes_json,ext_space_tainted,is_chain_node,branch_depth,
             created_space_seq,body_format,provenance_json)
         SELECT space_id,thread_id,n,CASE WHEN n={start} THEN {first_parent} ELSE n-1 END,
             revision_id,kind,author_id,agent_run_id,inline_text,referenced_notes_json,0,1,
             n-{start}+branch_depth+1,created_space_seq,body_format,
             '{prefix}' || CAST(CASE WHEN n={start} THEN {first_parent} ELSE n-1 END AS TEXT) || '{suffix}'
         FROM chain CROSS JOIN chat_entries WHERE space_id='{space}' AND thread_id='{thread}'
             AND entry_seq={first_parent}"
    )).await.unwrap();
    assert_eq!(count, (end - start + 1) as u64);
    let mut tail = model.clone();
    let ProviderOrigin::Chat { entry, .. } = &mut tail else {
        unreachable!()
    };
    *entry = ThreadEntrySeq::new(end as u64).unwrap();
    let account = || AccountContext::new(ctx.auth().clone(), ctx.budget.clone());
    let deps = store
        .chat_dependencies(account(), vec![tail.clone()])
        .await
        .unwrap();
    assert_eq!(deps.origins.as_slice(), std::slice::from_ref(metadata));
    let request = ProviderEgressRequest {
        origins: vec![tail, metadata.clone()],
        primary: ctx.scope().clone(),
        project: None,
        project_folders: BTreeSet::new(),
        secondary_projects: vec![],
    };
    assert_eq!(
        store
            .acquire_egress(account(), request, Cancellation::default())
            .await
            .unwrap()
            .current()
            .len(),
        2
    );
}
