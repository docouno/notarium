use super::*;
use notarium_agents::mcp::{ConfirmProposedDiff, PersonalToolInvocation};
use notarium_core::{
    auth::ChatAudience,
    ports::provider::{ProviderToolCall, ProviderToolCallId},
};

pub(super) async fn explicit_confirmation_applies_once(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let actor = owner.auth().principal();
    let thread = ChatThreadId::from_bytes([170; 16]);
    let run = AgentRunId::from_bytes([170; 16]);
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
                identity: mutation(170),
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
    let key = CommandKey::from_bytes([171; 16]);
    let args =
        json!({"category":"proposal-fixture", "observation":"Apply only after explicit approval."});
    let model = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: mutation(171),
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
    let proposal = result
        .proposal()
        .expect("trusted run receives the typed proposal");
    let entry = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: mutation(172),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: model.value.seq,
                    kind: ChatEntryKind::Tool { call_id: key },
                    body: ChatInputBody::Text(result.content[0].text.clone()),
                    tool_calls: vec![],
                    provenance: Some(result.provenance.clone()),
                    proposed_diff: Some(proposal.envelope().to_owned()),
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();
    let confirm = ConfirmProposedDiff {
        source: scope.clone(),
        thread,
        entry: entry.value.seq,
        proposal: proposal.id(),
    };
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
