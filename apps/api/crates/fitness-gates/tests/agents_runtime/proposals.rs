use super::*;
use super::{
    runtime_ability_cases::{
        approve_disclosure, begin_ollama_response, loopback_provider, read_request, send_ollama,
    },
    supervised_chat_cases::{branch, idle_leaf},
};
use notarium_agents::chats::{AgentRunSupervisor, ChatRunOptions, ExclusiveDataRoot, StartChatRun};
use notarium_agents::mcp::{ConfirmProposedDiff, PersonalToolInvocation};
use notarium_core::{
    auth::{ChatAudience, ProposalHumanAccess},
    classes::DocClass,
    ports::provider::{ProviderToolCall, ProviderToolCallId},
};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpListener, time::timeout};

#[tokio::test]
async fn sqlite_supervised_proposals_on_tainted_branch() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(supervised_proposals_on_tainted_branch(false)).await;
}

#[tokio::test]
async fn postgres_supervised_proposals_on_tainted_branch() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(supervised_proposals_on_tainted_branch(true)).await;
}

async fn supervised_proposals_on_tainted_branch(postgres: bool) {
    let fixture = RuntimeFixture::open_named(postgres, "supervised_proposals").await;
    let personal = fixture.personal_scope().await;
    let scope = personal.scope().clone();
    let fresh_owner = || async {
        let auth = fixture
            .control
            .trusted_none(
                PerimeterAttestation::attest_checked().with_human_management(),
                budget(),
            )
            .await
            .unwrap();
        AccountContext::new(auth, budget())
    };
    let owner = fresh_owner().await;
    let thread = ChatThreadId::from_bytes([10; 16]);
    let mutation = |tag| CommandIdentity {
        scope: scope.clone(),
        actor: owner.auth().principal().clone(),
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    };
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: mutation(10),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.auth().principal().clone(),
                    project_folder: None,
                    title: "Personal proposals".into(),
                },
            },
        )
        .await
        .unwrap();
    let leaf = fixture
        .canonical
        .append_chat(
            personal.clone(),
            Mutation {
                identity: mutation(11),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Review changes to my memory.".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap()
        .value;
    assert!(leaf.tainted);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(&fixture, &owner, &listener, 20, true).await;
    approve_disclosure(
        &fixture,
        &owner,
        &local,
        24,
        ProviderAttachmentTarget::Personal {
            owner: owner.auth().principal().clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Profile].into(),
    )
    .await;
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        ..Default::default()
    };
    supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: scope.clone(),
                thread: thread.clone(),
                expected_leaf: leaf.seq,
                options: options.clone(),
            },
        )
        .await
        .unwrap();
    assert!(owner.auth().taint().is_tainted());

    let input = |tag, head| SubmitUserChatInput {
        identity: mutation(tag),
        id: PendingInputId::from_bytes([tag; 16]),
        thread: thread.clone(),
        expected_leaf: head,
        body: "Review my next observation.".into(),
        mentions_agent: false,
    };
    let mut proposals = Vec::new();
    for turn in 0..4 {
        if turn == 3 {
            let head = idle_leaf(&fixture, &personal, &thread).await;
            let direct = supervisor
                .enqueue_input(fresh_owner().await, input(33, head), options.clone())
                .await
                .unwrap();
            assert!(
                matches!(direct.outcome, SubmitUserChatOutcome::Appended(_))
                    && direct.run.is_some()
            );
        }
        let (mut wire, _) = timeout(Duration::from_secs(15), read_request(&listener))
            .await
            .unwrap();
        let category = format!("supervised-proposal-{turn}");
        // Acknowledge dispatch so Canonical can admit the queued write while the model streams.
        let reply = begin_ollama_response(
            &mut wire,
            json!({"role":"assistant","tool_calls":[{"function":{
                "index":0,"name":"remember_about_user","arguments":{
                    "category":category,"observation":"Only after my approval."
                }
            }}]}),
            "tool_calls",
        )
        .await;
        let head = branch(&fixture, &personal, &thread, ThreadEntrySeq::ZERO)
            .await
            .thread
            .head;
        if turn < 2 {
            // The third turn's sender has already read the tainted branch independently.
            let sender = fresh_owner().await;
            if turn == 1 {
                let reader =
                    SpaceContext::new(sender.auth().clone(), scope.clone(), budget()).unwrap();
                branch(&fixture, &reader, &thread, head).await;
                assert!(sender.auth().taint().is_tainted());
            }
            let queued = supervisor
                .enqueue_input(sender, input(30 + turn, head), options.clone())
                .await
                .unwrap();
            assert!(matches!(queued.outcome, SubmitUserChatOutcome::Queued(_)));
        }
        wire.get_mut().write_all(reply.as_bytes()).await.unwrap();
        drop(wire);
        let (mut wire, _) = timeout(Duration::from_secs(15), read_request(&listener))
            .await
            .unwrap();
        let head = branch(&fixture, &personal, &thread, ThreadEntrySeq::ZERO)
            .await
            .thread
            .head;
        let history = branch(&fixture, &personal, &thread, head).await;
        let tool = history.entries.iter().find(|row| row.seq == head).unwrap();
        assert!(matches!(tool.kind, ChatEntryKind::Tool { .. }) && tool.tainted);
        let interactive = fresh_owner().await;
        let reader = fixture
            .control_plane
            .revalidate_proposal_human(interactive.clone(), ProposalHumanAccess::ReadOnly)
            .await
            .unwrap();
        let proposal = fixture
            .canonical
            .read_chat_proposal(
                SpaceContext::new(reader, scope.clone(), budget()).unwrap(),
                ChatProposalRead {
                    thread: thread.clone(),
                    entry: head,
                },
            )
            .await;
        assert_eq!(
            fixture
                .control
                .inspect_memory_target(
                    interactive,
                    MemoryTarget::User {
                        owner: owner.auth().principal().clone(),
                    },
                    category
                )
                .await
                .unwrap()
                .revision,
            None
        );
        if turn != 2 {
            let envelope: Value = serde_json::from_str(&proposal.unwrap().envelope).unwrap();
            proposals.push(ConfirmProposedDiff {
                source: scope.clone(),
                thread: thread.clone(),
                entry: head,
                proposal: serde_json::from_value(envelope["proposal_id"].clone()).unwrap(),
            });
        } else {
            assert!(matches!(
                proposal,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ));
            assert!(
                matches!(&tool.body, ChatBody::Inline(body) if body.contains("cross_space_tainted")),
                "{:?}",
                tool.body
            );
        }
        send_ollama(
            &mut wire,
            json!({"role":"assistant","content":"Finished."}),
            "stop",
        )
        .await;
    }
    idle_leaf(&fixture, &personal, &thread).await;
    for proposal in proposals {
        assert!(
            fixture
                .registry
                .apply_proposed_diff(owner.clone(), proposal.clone())
                .await
                .is_err()
        );
        fixture
            .registry
            .apply_proposed_diff(fresh_owner().await, proposal)
            .await
            .unwrap();
    }
    supervisor.shutdown();
    fixture.close().await;
}

async fn record_memory_proposal(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    owner: &AccountContext,
    tag: u8,
    category: &str,
) -> ConfirmProposedDiff {
    let scope = personal.scope();
    let actor = owner.auth().principal();
    let thread = ChatThreadId::from_bytes([tag; 16]);
    let run = AgentRunId::from_bytes([tag; 16]);
    let mutation = |tag| CommandIdentity {
        scope: scope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    };
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: mutation(tag),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Confirmation fixture".into(),
                },
            },
        )
        .await
        .unwrap();
    let run_auth = owner
        .auth()
        .for_agent_run(
            run.clone(),
            scope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_scope = SpaceContext::new(run_auth.clone(), scope.clone(), budget()).unwrap();
    assert_eq!(
        fixture
            .canonical
            .claim_active_run(
                run_scope.clone(),
                ClaimChatRun {
                    thread: thread.clone(),
                    run,
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None,
                }
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    );
    let key = CommandKey::from_bytes([tag + 1; 16]);
    let args = json!({"category":category, "observation":"Apply only after explicit approval."});
    let model = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: mutation(tag + 1),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Propose a memory update.".into()),
                    tool_calls: vec![ProviderToolCall {
                        id: ProviderToolCallId::new(key.as_str().into()).unwrap(),
                        name: "remember_about_user".into(),
                        arguments: args.as_object().unwrap().clone().into_iter().collect(),
                    }],
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap();
    run_auth.taint().mark_external_read();
    let result = fixture
        .registry
        .call_personal_tool(
            McpInvocationContext {
                account: AccountContext::new(run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: ProviderResourceId::from_bytes([1; 16]),
                    model: ModelProfileId::from_bytes([1; 16]),
                    primary_project: None,
                },
                request_key: key.clone(),
            },
            PersonalToolInvocation {
                source: scope.clone(),
                thread: thread.clone(),
                leaf: model.value.seq,
                owner: owner.clone(),
            },
            "remember_about_user",
            args,
        )
        .await
        .unwrap();
    assert_eq!(result.structured_content["outcome"], "approvalRequired");
    let proposal = result
        .proposal()
        .expect("trusted run receives the typed proposal");
    let entry = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: mutation(tag + 2),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: model.value.seq,
                    kind: ChatEntryKind::Tool { call_id: key },
                    body: ChatInputBody::Text(result.content[0].text.clone()),
                    tool_calls: vec![],
                    provenance: Some(result.provenance.clone()),
                    interruption: None,
                    proposed_diff: Some(proposal.envelope().to_owned()),
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();
    ConfirmProposedDiff {
        source: scope.clone(),
        thread,
        entry: entry.value.seq,
        proposal: proposal.id(),
    }
}

pub(super) async fn explicit_confirmation_applies_once(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let confirm = record_memory_proposal(fixture, personal, owner, 170, "proposal-fixture").await;
    let target = MemoryTarget::User {
        owner: owner.auth().principal().clone(),
    };
    let inspect = || {
        fixture.control.inspect_memory_target(
            owner.clone(),
            target.clone(),
            "proposal-fixture".into(),
        )
    };
    assert_eq!(inspect().await.unwrap().revision, None);
    let preview = fixture
        .registry
        .preview_proposed_diff(owner.clone(), confirm.clone())
        .await
        .unwrap();
    assert_eq!(
        preview["memory"]["observation"],
        "Apply only after explicit approval."
    );
    assert!(
        fixture
            .registry
            .apply_proposed_diff(
                fixture.pat(BearerScope::Write, false).await,
                confirm.clone()
            )
            .await
            .is_err()
    );
    assert_eq!(inspect().await.unwrap().revision, None);
    let applied = fixture
        .registry
        .apply_proposed_diff(owner.clone(), confirm.clone())
        .await
        .unwrap();
    let replay = fixture
        .registry
        .apply_proposed_diff(owner.clone(), confirm)
        .await
        .unwrap();
    assert_eq!(applied, replay);
    let memory = inspect().await.unwrap();
    let note = fixture
        .canonical
        .get_note(
            personal.clone(),
            GetNote {
                note: memory.resolved.note.note_id,
                revision: memory.revision,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        note.document
            .explicit_read(owner.auth())
            .unwrap()
            .matches("Apply only after explicit approval.")
            .count(),
        1
    );
}

pub(super) async fn revoked_session_cannot_apply_or_replay(fixture: &mut RuntimeFixture) {
    let principal = fixture.human.auth().principal().clone();
    let space = fixture
        .control
        .whoami(fixture.human.clone())
        .await
        .unwrap()
        .personal_space
        .unwrap();
    let scope = fixture.canonical.read_space(&space).await.unwrap().scope;
    let personal = SpaceContext::new(fixture.human.auth().clone(), scope, budget()).unwrap();
    for (tag, replay) in [(190, false), (193, true)] {
        let (owner, token) = authoring_authority_cases::native_session(fixture, tag).await;
        let category = format!("proposal-revocation-{tag}");
        let confirm = record_memory_proposal(fixture, &personal, &owner, tag, &category).await;
        if replay {
            fixture
                .registry
                .apply_proposed_diff(owner.clone(), confirm.clone())
                .await
                .unwrap();
        }
        let inspect = || {
            fixture.control.inspect_memory_target(
                fixture.human.clone(),
                MemoryTarget::User {
                    owner: principal.clone(),
                },
                category.clone(),
            )
        };
        let before = inspect().await.unwrap().revision;
        assert_eq!(before.is_some(), replay);
        let denied = authoring_authority_cases::revoke_before_effect(
            fixture.projections.pause_memory_append(),
            fixture
                .registry
                .apply_proposed_diff(owner.clone(), confirm.clone()),
            fixture.control.logout(support::evidence(
                AuthEvidenceKind::Session,
                token.secret.expose(),
            )),
        )
        .await;
        assert!(matches!(denied, PortError::Cancelled(_)), "{denied:?}");
        assert_eq!(inspect().await.unwrap().revision, before);
        let stale_owner = AccountContext::new(owner.auth().clone(), budget());
        let denied = fixture
            .registry
            .apply_proposed_diff(stale_owner, confirm)
            .await
            .unwrap_err();
        assert!(
            matches!(denied, PortError::Domain(DomainError::AuthenticationFailed)),
            "{denied:?}"
        );
    }
}
