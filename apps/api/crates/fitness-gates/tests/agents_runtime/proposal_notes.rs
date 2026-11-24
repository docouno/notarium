use super::{
    runtime_ability_cases::{approve_disclosure, loopback_provider},
    *,
};
use notarium_agents::mcp::{ConfirmProposedDiff, PersonalToolInvocation};
use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    auth::ChatAudience,
    classes::DocClass,
    ports::provider::{ProviderToolCall, ProviderToolCallId},
};
use tokio::net::TcpListener;

#[tokio::test]
async fn sqlite_confirmed_notes_use_fixed_destinations_and_revisions() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise(false)).await;
}

#[tokio::test]
async fn postgres_confirmed_notes_use_fixed_destinations_and_revisions() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise(true)).await;
}

async fn exercise(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(pg, "agents_proposal_notes")).await;
    let personal = fixture.personal_scope().await;
    Box::pin(confirmed_notes_use_fixed_destinations_and_revisions(
        &fixture, &personal,
    ))
    .await;
    Box::pin(fixture.close()).await;
}

async fn confirmed_notes_use_fixed_destinations_and_revisions(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let project_folder = FolderId::from_bytes([178; 16]);
    let storage = fixture.canonical.read_space(&scope.space_id).await.unwrap();
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: storage.active_epoch,
            folder_id: project_folder.clone(),
            parent: None,
            slug: "proposal-corpus".into(),
            display_name: "Proposal corpus".into(),
            is_project: true,
            project_slug: Some("proposal-corpus".into()),
            actor: owner.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let space = fixture
        .control
        .list_spaces(owner.clone(), ControlPageRequest::new(10, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.space.id == scope.space_id)
        .unwrap();
    let project = format!("{}/proposal-corpus", space.slug);
    let path = "drafts/nested";
    let destination = || {
        fixture.canonical.resolve_folder_path(
            personal.clone(),
            Some(project_folder.clone()),
            path.into(),
        )
    };
    assert!(destination().await.unwrap().is_none());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let consented = loopback_provider(fixture, owner, &listener, 210, true).await;
    approve_disclosure(
        fixture,
        owner,
        &consented,
        214,
        ProviderAttachmentTarget::Personal {
            owner: owner.auth().principal().clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    let provider_id = &consented.resource.id;
    let model_id = &consented.model;
    let (create, _) = pending_note_action(fixture, personal, provider_id, model_id, 178, "create_notes", json!({
        "project": project,
        "notes": [
            {"title":"Approved draft", "body":"# Approved draft\n\nOriginal paragraph.", "path":path,
                "links":[{"relation":"related", "toTitle":"Conflicting draft"}]},
            {"title":"Conflicting draft", "fileName":"approved-draft", "body":"Conflicting content.", "path":path},
            {"title":"Sibling draft", "body":"Shares a newly materialized prefix.", "path":"drafts/sibling"},
            {"title":"Companion draft", "body":"Shares the full destination.", "path":path},
        ],
    })).await;
    assert!(destination().await.unwrap().is_none());
    let review = fixture
        .registry
        .preview_proposed_diff(owner.clone(), create.clone())
        .await
        .unwrap();
    let draft = &review.change.as_ref().unwrap()["notes"][0];
    assert_eq!(
        draft["destination"]["folderPath"],
        "proposal-corpus/drafts/nested"
    );
    assert!(
        draft["content"]
            .as_str()
            .unwrap()
            .contains("Original paragraph.")
    );
    assert!(destination().await.unwrap().is_none());
    let first = fixture
        .registry
        .apply_proposed_diff(owner.clone(), create.clone())
        .await
        .unwrap();
    let replay = fixture
        .registry
        .apply_proposed_diff(owner.clone(), create)
        .await
        .unwrap();
    assert_eq!(first.result, replay.result);
    let results = first.result["results"].as_array().unwrap();
    assert_eq!(results[0]["ok"], true);
    assert_eq!(results[1]["ok"], false);
    assert_eq!(results[1]["error"], "path_conflict");
    assert_eq!(results[2]["ok"], true);
    assert_eq!(results[3]["ok"], true);
    let note = NoteId::parse(results[0]["noteId"].as_str().unwrap()).unwrap();
    let folder = destination().await.unwrap().unwrap();
    let snapshot = fixture
        .canonical
        .get_note(
            personal.clone(),
            GetNote {
                note: note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(snapshot.parent, Some(folder.reference.folder_id));
    let carrier = snapshot.document.explicit_read(owner.auth()).unwrap();
    assert!(carrier.contains("Original paragraph."));
    assert!(carrier.contains("- related: [[Conflicting draft]]"));

    let (additive, _) = pending_note_action(
        fixture,
        personal,
        provider_id,
        model_id,
        181,
        "create_note",
        json!({
            "project":project, "path":path, "title":"Additive draft", "body":"Additive content.",
            "versionToken":"v3:legacy-read-token",
        }),
    )
    .await;
    let additive = fixture
        .registry
        .apply_proposed_diff(owner.clone(), additive)
        .await
        .unwrap();
    assert_eq!(additive.result["outcome"], "created");

    let (occupied, _) = pending_note_action(
        fixture,
        personal,
        provider_id,
        model_id,
        46,
        "create_note",
        json!({
            "project":project, "path":"occupied/missing-child", "title":"Pending draft",
            "body":"Do not reuse an independently created prefix.",
        }),
    )
    .await;
    call(fixture, owner, 49, "create_note", json!({
        "project":project, "path":"occupied", "title":"Independent draft", "body":"Creates the prefix.",
    })).await.unwrap();
    assert_eq!(
        fixture
            .registry
            .apply_proposed_diff(owner.clone(), occupied)
            .await
            .unwrap_err()
            .code(),
        "revision_conflict",
    );
    assert!(
        fixture
            .canonical
            .resolve_folder_path(
                personal.clone(),
                Some(project_folder.clone()),
                "occupied/missing-child".into(),
            )
            .await
            .unwrap()
            .is_none()
    );

    let (displaced, _) = pending_note_action(
        fixture,
        personal,
        provider_id,
        model_id,
        50,
        "create_note",
        json!({
            "project":project, "path":path, "title":"Displaced draft",
            "body":"Commit only at the exact approved path.",
        }),
    )
    .await;
    let former = destination().await.unwrap().unwrap();
    call(
        fixture,
        owner,
        53,
        "rename_folder",
        json!({
            "project":project, "folder":"drafts", "name":"relocated-drafts",
        }),
    )
    .await
    .unwrap();
    let relocated = fixture
        .canonical
        .resolve_folder_path(
            personal.clone(),
            Some(project_folder.clone()),
            "relocated-drafts/nested".into(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(former.reference, relocated.reference);
    assert_eq!(former.revision, relocated.revision);
    assert_ne!(former.path, relocated.path);
    assert_eq!(
        fixture
            .registry
            .preview_proposed_diff(owner.clone(), displaced.clone())
            .await
            .unwrap_err()
            .code(),
        "revision_conflict",
    );
    assert_eq!(
        fixture
            .registry
            .apply_proposed_diff(owner.clone(), displaced)
            .await
            .unwrap_err()
            .code(),
        "revision_conflict",
    );

    let (edit, display) = pending_note_action(
        fixture,
        personal,
        provider_id,
        model_id,
        184,
        "edit_note",
        json!({
            "ref":note, "operation":"append", "content":"Only if the approved revision is current.",
            "versionToken":results[0]["versionToken"],
        }),
    )
    .await;
    assert!(
        display["unifiedPreview"]
            .as_str()
            .is_some_and(|text| text.contains("+Only if the approved revision is current."))
    );
    let preview = fixture
        .registry
        .preview_proposed_diff(owner.clone(), edit.clone())
        .await
        .unwrap();
    let unified = preview.unified_preview.as_deref().unwrap();
    assert!(unified.contains("Original paragraph."));
    assert!(unified.contains("+Only if the approved revision is current."));
    let missing_move_path = "proposal-corpus/stale-move/nested";
    let (stale_move, _) = pending_note_action(
        fixture,
        personal,
        provider_id,
        model_id,
        54,
        "move_note",
        json!({"ref":note, "toFolder":missing_move_path}),
    )
    .await;
    let concurrent = call(
        fixture,
        owner,
        189,
        "edit_note",
        json!({
            "ref":note, "operation":"append", "content":"An independent edit.",
            "versionToken":results[0]["versionToken"],
        }),
    )
    .await
    .unwrap();
    let conflict = fixture
        .registry
        .apply_proposed_diff(owner.clone(), edit)
        .await
        .unwrap_err();
    assert!(
        matches!(conflict, PortError::Domain(DomainError::RevisionConflict { current, .. })
        if current.as_str() == concurrent.structured_content["versionToken"].as_str().unwrap())
    );
    assert_eq!(
        fixture
            .registry
            .apply_proposed_diff(owner.clone(), stale_move)
            .await
            .unwrap_err()
            .code(),
        "revision_conflict",
    );
    assert!(
        fixture
            .canonical
            .resolve_folder_path(
                personal.clone(),
                Some(project_folder.clone()),
                "stale-move".into(),
            )
            .await
            .unwrap()
            .is_none()
    );
    let snapshot = fixture
        .canonical
        .get_note(
            personal.clone(),
            GetNote {
                note,
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    let carrier = snapshot.document.explicit_read(owner.auth()).unwrap();
    assert!(carrier.contains("An independent edit."));
    assert!(!carrier.contains("Only if the approved revision is current."));

    // Direct create_notes must propagate CommitEffect::Unknown + RetrySameCommand
    // when a commit acknowledgement is lost (rather than reporting ok:false inside Ok),
    // and replaying with the same key must return ok:true with the committed noteId.
    let batch_args = json!({
        "project": project,
        "notes": [
            {"title": "Lost ack direct note", "body": "Persisted before ack dropped."}
        ],
    });
    fixture.projections.lose_note_create_acks(1);
    let unknown_direct = call(fixture, owner, 71, "create_notes", batch_args.clone())
        .await
        .map(|_| ());
    assert!(
        matches!(
            &unknown_direct,
            Err(PortError::Unavailable(failure))
                if failure.effect() == notarium_core::error::CommitEffect::Unknown
                    && failure.retry() == notarium_core::error::RetryAdvice::RetrySameCommand
        ),
        "create_notes must surface CommitEffect::Unknown + RetrySameCommand on lost ack: {unknown_direct:?}"
    );
    let replayed_direct = call(fixture, owner, 71, "create_notes", batch_args)
        .await
        .expect("replaying create_notes with the same key must recover the committed note");
    let direct_item = &replayed_direct.structured_content["results"][0];
    assert_eq!(direct_item["ok"], true);
    let direct_note_id = NoteId::parse(direct_item["noteId"].as_str().unwrap()).unwrap();
    let direct_snapshot = fixture
        .canonical
        .get_note(
            personal.clone(),
            GetNote {
                note: direct_note_id,
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .expect("committed create_notes item must be readable in canonical");
    assert!(
        direct_snapshot
            .document
            .explicit_read(owner.auth())
            .unwrap()
            .contains("Persisted before ack dropped.")
    );

    // Confirmed batch ProposedDiff for create_notes must likewise surface
    // CommitEffect::Unknown + RetrySameCommand on lost commit ack and replay cleanly.
    let (batch_confirm, _) = pending_note_action(
        fixture,
        personal,
        provider_id,
        model_id,
        72,
        "create_notes",
        json!({
            "project": project,
            "notes": [
                {"title": "Proposed batch first", "body": "First confirmed batch note."},
                {"title": "Proposed batch second", "body": "Second confirmed batch note."},
            ],
        }),
    )
    .await;
    fixture.projections.lose_note_create_acks(1);
    let unknown_batch = fixture
        .registry
        .apply_proposed_diff(owner.clone(), batch_confirm.clone())
        .await
        .map(|_| ());
    assert!(
        matches!(
            &unknown_batch,
            Err(PortError::Unavailable(failure))
                if failure.effect() == notarium_core::error::CommitEffect::Unknown
                    && failure.retry() == notarium_core::error::RetryAdvice::RetrySameCommand
        ),
        "confirmed batch create_notes must surface CommitEffect::Unknown + RetrySameCommand: {unknown_batch:?}"
    );
    let replayed_batch = fixture
        .registry
        .apply_proposed_diff(owner.clone(), batch_confirm)
        .await
        .expect("replaying confirmed batch create_notes must succeed");
    let batch_results = replayed_batch.result["results"].as_array().unwrap();
    assert_eq!(batch_results.len(), 2);
    assert_eq!(batch_results[0]["ok"], true);
    assert_eq!(batch_results[1]["ok"], true);
    for item in batch_results {
        let note_id = NoteId::parse(item["noteId"].as_str().unwrap()).unwrap();
        fixture
            .canonical
            .get_note(
                personal.clone(),
                GetNote {
                    note: note_id,
                    revision: None,
                    causal: CausalBasis::Await(Default::default()),
                },
            )
            .await
            .expect("confirmed batch note must be readable in canonical");
    }
}

async fn pending_note_action(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    provider: &ProviderResourceId,
    model_id: &ModelProfileId,
    tag: u8,
    tool: &str,
    arguments: Value,
) -> (ConfirmProposedDiff, Value) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let actor = owner.auth().principal();
    let thread = ChatThreadId::from_bytes([tag; 16]);
    let run = AgentRunId::from_bytes([tag; 16]);
    let mutation = |id| CommandIdentity {
        scope: scope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([id; 16]),
        hash: ContentDigest::from_bytes([id; 32]),
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
                    title: "Note confirmation fixture".into(),
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
                    body: ChatInputBody::Text("Propose a change to notes.".into()),
                    tool_calls: vec![ProviderToolCall {
                        id: ProviderToolCallId::new(key.as_str().into()).unwrap(),
                        name: tool.into(),
                        arguments: arguments.as_object().unwrap().clone().into_iter().collect(),
                    }],
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
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
                    provider: provider.clone(),
                    model: model_id.clone(),
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
            tool,
            arguments,
        )
        .await
        .unwrap();
    assert_eq!(result.structured_content["outcome"], "approvalRequired");
    let proposal = result.proposal().unwrap();
    let entry = fixture
        .canonical
        .append_chat(
            run_scope,
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
                    proposed_effect: Some(proposal.effect()),
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();
    (
        ConfirmProposedDiff {
            source: scope.clone(),
            thread,
            entry: entry.value.seq,
            proposal: proposal.id(),
        },
        result.structured_content,
    )
}
