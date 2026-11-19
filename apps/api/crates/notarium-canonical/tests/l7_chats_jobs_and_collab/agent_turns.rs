use super::*;
use notarium_core::{
    auth::{AuthenticatedCredential, ProposalHumanAccess},
    classes::ClassEgressFence,
    model::FolderRef,
    ports::{
        ChatContentRead, ChatProposalRead, ChatProvenance, DismissPending, ProviderToolCall,
        ProviderToolCallId,
    },
};

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
        assert_eq!(item.tool_calls.len(), usize::from(include_call));
        if include_call {
            assert_eq!(item.tool_calls[0].id.as_str(), id.as_str());
        }
    }
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
                    proposed_diff: Some("Opaque confirmed action".into()),
                    referenced_notes: Vec::new(),
                    tainted: true,
                },
            ),
        )
        .await
        .unwrap()
        .value;

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
    let request = make_request(0xc4);
    let stale = make_request(0xc5);
    let approved = |identity: &CommandIdentity| {
        write
            .clone()
            .with_confirmed_chat_step(proposal.witness().clone(), identity)
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
    confirmed_source_fence(&store).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
