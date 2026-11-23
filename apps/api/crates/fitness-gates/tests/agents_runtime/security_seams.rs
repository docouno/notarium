//! Dual-database integration regressions for provider consent boundaries,
//! live collaboration interception, non-blocking TTFB dispatch, and recovery.
use std::time::Duration;

use notarium_agents::{
    chats::{AgentRunSupervisor, ChatRunOptions, ExclusiveDataRoot},
    mcp::{ConfirmProposedDiff, PersonalToolInvocation},
};
use notarium_canonical::CreateFolderSpec;
use notarium_collab::CollabSessionAuth;
use notarium_core::{
    auth::{ChatAudience, SpaceKind},
    classes::DocClass,
    model::FolderRef,
    ports::provider::{ProviderToolCall, ProviderToolCallId},
};
use tokio::{io::AsyncWriteExt, net::TcpListener, time::timeout};

use super::{
    runtime_ability_cases::{
        approve_disclosure, identity, loopback_provider, read_request, send_ollama,
    },
    *,
};

#[tokio::test]
async fn sqlite_security_seams_collab_ttfb_and_orphan_recovery() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise(false)).await;
}

#[tokio::test]
async fn postgres_security_seams_collab_ttfb_and_orphan_recovery() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise(true)).await;
}

async fn exercise(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(pg, "agents_security_seams")).await;
    let personal = fixture.personal_scope().await;
    Box::pin(project_only_mutations_and_owned_space_abilities(&fixture)).await;
    Box::pin(unconsented_proposal_fails_closed_with_taint(
        &fixture, &personal,
    ))
    .await;
    Box::pin(live_collab_room_accepts_mcp_and_confirmed_edits(
        &fixture, &personal,
    ))
    .await;
    Box::pin(stalled_provider_ttfb_does_not_block_same_space_writes(
        &fixture, &personal,
    ))
    .await;
    Box::pin(episode_mutation_blocked_for_read_and_shared_agents(
        &fixture,
    ))
    .await;
    Box::pin(exact_causal_graph_and_control_replay_seams(
        &fixture, &personal,
    ))
    .await;
    let fixture = Box::pin(orphan_active_run_recovered_on_enqueue(fixture, &personal)).await;
    Box::pin(fixture.close()).await;
}

async fn project_only_mutations_and_owned_space_abilities(fixture: &RuntimeFixture) {
    let owner = &fixture.human;
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([1; 16]),
                    kind: SpaceKind::Shared,
                    name: "Project Boundary Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let human = AccountContext::new(
        fixture
            .control
            .trusted_none(
                PerimeterAttestation::attest_checked()
                    .with_human_management()
                    .with_ability_write(),
                budget(),
            )
            .await
            .unwrap(),
        budget(),
    );
    let storage = fixture
        .canonical
        .read_space(&shared.history.space_id)
        .await
        .unwrap();
    let p1 = FolderRef {
        space_id: shared.history.space_id.clone(),
        folder_id: FolderId::from_bytes([2; 16]),
    };
    let p2 = FolderRef {
        space_id: shared.history.space_id.clone(),
        folder_id: FolderId::from_bytes([3; 16]),
    };
    let p2_sub = FolderId::from_bytes([4; 16]);
    for (id, parent, slug, is_project) in [
        (&p1.folder_id, None, "alpha", true),
        (&p2.folder_id, None, "beta", true),
        (&p2_sub, Some(p2.folder_id.clone()), "secret-dir", false),
    ] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: shared.history.clone(),
                active_epoch: storage.active_epoch,
                folder_id: id.clone(),
                parent,
                slug: slug.into(),
                display_name: slug.into(),
                is_project,
                project_slug: is_project.then(|| slug.into()),
                actor: human.auth().principal().clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let p1_handle = format!("{}/alpha", shared.slug);
    let p2_handle = format!("{}/beta", shared.slug);
    let p1_note = call(
        fixture,
        &human,
        5,
        "create_note",
        json!({"project": p1_handle, "title": "P1 note", "body": "Allowed project content."}),
    )
    .await
    .unwrap()
    .structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();
    let p2_note = call(
        fixture,
        &human,
        6,
        "create_note",
        json!({"project": p2_handle, "title": "P2 note", "body": "Restricted project secret."}),
    )
    .await
    .unwrap()
    .structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Publish two OwnedSpace skills: one restricted to P2, one disabled.
    let p2_skill = call(
        fixture,
        &human,
        7,
        "create_ability",
        json!({
            "kind": "skill",
            "name": "beta-only-skill",
            "description": "Only for beta project",
            "instructions": "Secret beta instructions.",
            "placement": { "home": "space", "space": shared.slug },
            "availability": { "mode": "selected-projects", "projects": [p2_handle] }
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let disabled_skill = call(
        fixture,
        &human,
        8,
        "create_ability",
        json!({
            "kind": "skill",
            "name": "disabled-space-skill",
            "description": "Disabled skill",
            "instructions": "Should never leak to provider.",
            "placement": { "home": "space", "space": shared.slug }
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let disabled_id = fixture
        .control
        .discover_abilities(
            human.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: None,
                kind: Some(notarium_core::classes::AbilityKind::Skill),
                name: Some("disabled-space-skill".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items[0]
        .descriptor
        .reference
        .clone();
    let inspected = fixture
        .control
        .inspect_ability(human.clone(), disabled_id.identity())
        .await
        .unwrap();
    fixture
        .control
        .update_ability_binding(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, &human, 9).await,
                input: AbilityBindingUpdate {
                    ability: disabled_id,
                    enabled: false,
                    expected: AbilityOverlayGuard::Account(inspected.binding_revision),
                    projects: AbilityProjects::All,
                },
            },
        )
        .await
        .unwrap();

    // Approve provider consent restricted to P1 only.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &human, &listener, 10, true).await;
    approve_disclosure(
        fixture,
        &human,
        &local,
        14,
        ProviderAttachmentTarget::Personal {
            owner: human.auth().principal().clone(),
            space: shared.history.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Skill, DocClass::AgentMemory].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &human,
        &local,
        18,
        ProviderAttachmentTarget::Project(p1.clone()),
        [DocClass::UserDoc, DocClass::Skill, DocClass::AgentMemory].into(),
    )
    .await;

    // Simulate a SpaceGroup AgentRun with whole-Space grant but provider consent on P1 only.
    let run_auth = human
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([22; 16]),
            shared.history.space_id.clone(),
            ChatAudience::Shared,
            human.auth().spaces().clone(),
        )
        .unwrap();
    let provider_call = |tag: u8, name: &'static str, args: Value| {
        let registry = fixture.registry.clone();
        let invocation = McpInvocationContext {
            account: AccountContext::new(run_auth.clone(), budget()),
            target: EgressTarget::InAppProvider {
                provider: local.resource.id.clone(),
                model: local.model.clone(),
                primary_project: Some(p1.clone()),
            },
            request_key: CommandKey::from_bytes([tag; 16]),
        };
        async move { registry.call_tool(invocation, name, args).await }
    };

    // Moving/renaming P2 note or folder into P1 must fail closed with ResourceNotFound.
    for (tag, tool, args) in [
        (
            23,
            "move_note",
            json!({"ref": p2_note, "toFolder": "alpha"}),
        ),
        (
            24,
            "move_note",
            json!({"ref": p1_note, "toFolder": "beta/injected-dir"}),
        ),
        (
            25,
            "move_folder",
            json!({"folder": "/beta/secret-dir", "toFolder": "/alpha"}),
        ),
        (
            26,
            "rename_folder",
            json!({"folder": "/beta/secret-dir", "name": "renamed-secret"}),
        ),
        (
            27,
            "create_note",
            json!({"project": p2_handle, "title": "Cross-project", "body": "Denied."}),
        ),
        (
            28,
            "remember_about_project",
            json!({"project": p2_handle, "observation": "Cross-project memory"}),
        ),
        (
            120,
            "link",
            json!({"from": p1_note, "to": p2_note, "relation": "references"}),
        ),
        (
            121,
            "create_note",
            json!({
                "project": p1_handle,
                "title": "Link to hidden project",
                "body": "Body.",
                "links": [{"to": p2_note, "relation": "references"}]
            }),
        ),
    ] {
        let err = provider_call(tag, tool, args).await.err().expect(tool);
        assert!(
            matches!(err, PortError::Domain(DomainError::ResourceNotFound)),
            "{tool}: expected ResourceNotFound, got {err:?}"
        );
    }
    // Rejected move_note must NOT have created `beta/injected-dir`.
    let shared_ctx =
        SpaceContext::new(human.auth().clone(), shared.history.clone(), budget()).unwrap();
    assert!(
        fixture
            .canonical
            .resolve_folder_path(
                shared_ctx,
                Some(p2.folder_id.clone()),
                "injected-dir".into()
            )
            .await
            .unwrap()
            .is_none()
    );

    // OwnedSpace abilities restricted to P2 or disabled must not leak through authoring list/get/use.
    let authored_list = provider_call(29, "list_abilities", json!({"view": "authoring"}))
        .await
        .unwrap()
        .structured_content;
    let listed_names: Vec<_> = authored_list["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["name"].as_str())
        .collect();
    assert!(
        !listed_names.contains(&"beta-only-skill"),
        "{listed_names:?}"
    );
    assert!(
        !listed_names.contains(&"disabled-space-skill"),
        "{listed_names:?}"
    );
    for (tag, tool, args) in [
        (30, "get_ability", json!({"ref": p2_skill["ref"]})),
        (31, "get_ability", json!({"ref": disabled_skill["ref"]})),
        (
            32,
            "use_skill",
            json!({"name": "beta-only-skill", "project": p2_handle}),
        ),
    ] {
        let err = provider_call(tag, tool, args).await.err().expect(tool);
        assert!(
            matches!(err, PortError::Domain(DomainError::ResourceNotFound)),
            "{tool}: expected ResourceNotFound, got {err:?}"
        );
    }

    // Unfiltered empty list_abilities omits meaningless `zero_results` nextAction.
    let filtered_empty = call(
        fixture,
        &human,
        33,
        "list_abilities",
        json!({"view": "runtime", "q": "definitely-no-such-ability-xyz"}),
    )
    .await
    .unwrap()
    .structured_content;
    assert_eq!(filtered_empty["nextAction"]["reason"], "zero_results");
    let unfiltered = call(
        fixture,
        &human,
        34,
        "list_abilities",
        json!({"view": "runtime"}),
    )
    .await
    .unwrap()
    .structured_content;
    assert_ne!(unfiltered["nextAction"]["reason"], "zero_results");
}

async fn unconsented_proposal_fails_closed_with_taint(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let actor = owner.auth().principal();
    let secret_note = NoteId::from_bytes([40; 16]);
    fixture
        .canonical
        .create_note(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([40; 16]),
                    hash: ContentDigest::from_bytes([40; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: secret_note.clone(),
                    parent: None,
                    slug: "secret-oracle-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Private Title\n\nCanary plaintext secret.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();

    // Provider consented ONLY for Profile (NO UserDoc consent!).
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let profile_only = loopback_provider(fixture, owner, &listener, 41, true).await;
    approve_disclosure(
        fixture,
        owner,
        &profile_only,
        45,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::Profile].into(),
    )
    .await;

    let thread = ChatThreadId::from_bytes([49; 16]);
    let run = AgentRunId::from_bytes([49; 16]);
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
                identity: mutation(49),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Oracle guard".into(),
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
                },
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    );

    // Second Space note triggers `proposals::needs_proposal` even for an untainted Personal run.
    let foreign_space = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 39).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([39; 16]),
                    kind: SpaceKind::Shared,
                    name: "Unconsented Target Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let fresh_owner = AccountContext::new(
        fixture
            .control
            .trusted_none(
                PerimeterAttestation::attest_checked().with_human_management(),
                budget(),
            )
            .await
            .unwrap(),
        budget(),
    );
    let foreign_ctx = SpaceContext::new(
        fresh_owner.auth().clone(),
        foreign_space.history.clone(),
        budget(),
    )
    .unwrap();
    let foreign_secret = NoteId::from_bytes([39; 16]);
    fixture
        .canonical
        .create_note(
            foreign_ctx,
            Mutation {
                identity: CommandIdentity {
                    scope: foreign_space.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([39; 16]),
                    hash: ContentDigest::from_bytes([39; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: foreign_secret.clone(),
                    parent: None,
                    slug: "foreign-secret-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Foreign Secret\n\nForeign canary secret.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();

    // Matching and non-matching FindReplace probes must return identical ResourceNotFound
    // and mark external-read taint BEFORE touching detached human authority.
    let mut leaf = ThreadEntrySeq::ZERO;
    for (tag, target_note, needle, pre_taint) in [
        (50, &foreign_secret, "Foreign canary secret.", false),
        (51, &foreign_secret, "Does not exist.", false),
        (52, &secret_note, "Canary plaintext secret.", true),
        (53, &secret_note, "Absent personal needle.", true),
    ] {
        let key = CommandKey::from_bytes([tag; 16]);
        let args = json!({
            "ref": target_note,
            "operation": "findReplace",
            "find": needle,
            "content": "exfiltrated",
        });
        let model = fixture
            .canonical
            .append_chat(
                run_scope.clone(),
                Mutation {
                    identity: mutation(tag),
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: thread.clone(),
                        parent: leaf,
                        kind: ChatEntryKind::Model,
                        body: ChatInputBody::Text("Probe".into()),
                        tool_calls: vec![ProviderToolCall {
                            id: ProviderToolCallId::new(key.as_str().into()).unwrap(),
                            name: "edit_note".into(),
                            arguments: args.as_object().unwrap().clone().into_iter().collect(),
                        }],
                        provenance: Some(ChatProvenance::default()),
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
                        referenced_notes: vec![],
                        tainted: pre_taint,
                    },
                },
            )
            .await
            .unwrap();
        leaf = model.value.seq;
        let probe_auth = fresh_owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([49; 16]),
                scope.space_id.clone(),
                ChatAudience::Personal,
                fresh_owner.auth().spaces().clone(),
            )
            .unwrap();
        if pre_taint {
            probe_auth.taint().mark_external_read();
        } else {
            assert!(!probe_auth.taint().is_tainted());
        }
        let err = fixture
            .registry
            .call_personal_tool(
                McpInvocationContext {
                    account: AccountContext::new(probe_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: profile_only.resource.id.clone(),
                        model: profile_only.model.clone(),
                        primary_project: None,
                    },
                    request_key: key,
                },
                PersonalToolInvocation {
                    source: scope.clone(),
                    thread: thread.clone(),
                    leaf,
                    owner: fresh_owner.clone(),
                },
                "edit_note",
                args,
            )
            .await
            .err()
            .expect("unconsented FindReplace must fail closed");
        assert!(
            matches!(err, PortError::Domain(DomainError::ResourceNotFound)),
            "{needle}: expected ResourceNotFound, got {err:?}"
        );
        assert!(
            probe_auth.taint().is_tainted(),
            "failed cross-Space/proposal probe must mark external-read taint"
        );
    }
}

async fn live_collab_room_accepts_mcp_and_confirmed_edits(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let actor = owner.auth().principal();
    let note_id = NoteId::from_bytes([60; 16]);
    fixture
        .canonical
        .create_note(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([60; 16]),
                    hash: ContentDigest::from_bytes([60; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note_id.clone(),
                    parent: None,
                    slug: "live-collab-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Live Room Note\n\nInitial line.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();

    // Open a real active room in CollabHub and complete the Fresh handshake so
    // the room is genuinely mounted before any MCP/proposal edit runs.
    let cancellation = Cancellation::default();
    let lease = fixture
        .revocations
        .register_viewer(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                budget: budget(),
            },
            owner.auth(),
            &scope.space_id,
            cancellation.clone(),
        )
        .unwrap();
    let session_auth = CollabSessionAuth::new(Box::new(lease), cancellation, None);
    let mut room_peer = fixture
        .collab
        .connect(personal.clone(), note_id.clone(), session_auth)
        .await
        .unwrap();
    room_peer
        .send(notarium_collab::wire::LineageHello::Fresh.encode())
        .await
        .unwrap();
    assert!(matches!(
        timeout(Duration::from_secs(5), room_peer.recv())
            .await
            .unwrap(),
        Some(notarium_collab::SessionEvent::Binary(_))
    ));
    assert_eq!(fixture.collab.active_room_count(), 1);

    // 1. ExternalMcp edit_note must succeed through live room interception and
    // broadcast an update frame to the connected peer.
    let edited = call(
        fixture,
        owner,
        61,
        "edit_note",
        json!({
            "ref": note_id,
            "operation": "append",
            "content": "Edited via ExternalMcp in active room."
        }),
    )
    .await
    .unwrap();
    let rev_after_mcp = edited.structured_content["versionToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        matches!(
            timeout(Duration::from_secs(5), room_peer.recv())
                .await
                .unwrap(),
            Some(notarium_collab::SessionEvent::Binary(_))
        ),
        "live collab peer must receive broadcast from ExternalMcp edit_note"
    );

    // 2. Confirmed chat proposal edit_note must ALSO succeed through live room interception.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, owner, &listener, 62, true).await;
    approve_disclosure(
        fixture,
        owner,
        &local,
        66,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    let thread = ChatThreadId::from_bytes([69; 16]);
    let run = AgentRunId::from_bytes([69; 16]);
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
                identity: mutation(69),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Live room proposal".into(),
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
    fixture
        .canonical
        .claim_active_run(
            run_scope.clone(),
            ClaimChatRun {
                thread: thread.clone(),
                run,
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    let key = CommandKey::from_bytes([70; 16]);
    let args = json!({
        "ref": note_id,
        "operation": "append",
        "content": "Confirmed edit inside live room.",
        "versionToken": rev_after_mcp,
    });
    let model = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: mutation(70),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Propose edit".into()),
                    tool_calls: vec![ProviderToolCall {
                        id: ProviderToolCallId::new(key.as_str().into()).unwrap(),
                        name: "edit_note".into(),
                        arguments: args.as_object().unwrap().clone().into_iter().collect(),
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
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
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
            "edit_note",
            args,
        )
        .await
        .unwrap();
    let proposal = result.proposal().unwrap();
    let tool_entry = fixture
        .canonical
        .append_chat(
            run_scope,
            Mutation {
                identity: mutation(71),
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
    let outcome = fixture
        .registry
        .apply_proposed_diff(
            owner.clone(),
            ConfirmProposedDiff {
                source: scope.clone(),
                thread,
                entry: tool_entry.value.seq,
                proposal: proposal.id(),
            },
        )
        .await
        .unwrap();
    assert_eq!(outcome.result["outcome"], "edited");
    assert!(
        matches!(
            timeout(Duration::from_secs(5), room_peer.recv())
                .await
                .unwrap(),
            Some(notarium_collab::SessionEvent::Binary(_))
        ),
        "live collab peer must receive broadcast from confirmed proposal edit_note"
    );
    assert_eq!(fixture.collab.active_room_count(), 1);
    drop(room_peer);

    let snap = fixture
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
        .unwrap();
    let text = snap.document.explicit_read(owner.auth()).unwrap();
    assert!(text.contains("Edited via ExternalMcp in active room."));
    assert!(text.contains("Confirmed edit inside live room."));
}

async fn stalled_provider_ttfb_does_not_block_same_space_writes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let actor = owner.auth().principal();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, owner, &listener, 80, true).await;
    approve_disclosure(
        fixture,
        owner,
        &local,
        84,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    let selection = local
        .provider
        .select_provider(
            personal.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let request = CompletionRequest {
        intent: CommandKey::from_bytes([88; 16]),
        selection,
        secondary_projects: vec![],
        messages: vec![CompletionMessage {
            role: CompletionRole::User,
            instruction: Some(ProviderInstruction::from_orchestrator("Ping".into()).unwrap()),
            parts: vec![],
            tool_calls: vec![],
            result_for: None,
        }],
        tools: vec![],
        budget: CompletionBudget {
            max_input_tokens: 1024,
            max_output_tokens: 64,
            max_tool_calls: 0,
        },
    };
    let provider = local.provider.clone();
    let call_scope = personal.clone();
    let call_task = tokio::spawn(async move { provider.complete(call_scope, request).await });

    // Accept the outbound HTTP request and STALL BEFORE sending response headers (TTFB).
    let (_wire, _) = timeout(Duration::from_secs(5), read_request(&listener))
        .await
        .expect("provider request reached TCP listener");

    // While stalled before receive_head(), a write to the SAME Space must commit immediately!
    let concurrent_write = timeout(
        Duration::from_secs(2),
        fixture.canonical.create_note(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([89; 16]),
                    hash: ContentDigest::from_bytes([89; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([89; 16]),
                    parent: None,
                    slug: "during-ttfb-stall".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Concurrent write\n\nMust not block on provider TTFB.\n".into(),
                    folder_page: false,
                },
            },
        ),
    )
    .await
    .expect("same-Space write must not stall while provider waits for TTFB")
    .unwrap();
    assert_eq!(concurrent_write.value.note, NoteId::from_bytes([89; 16]));

    // Revoking the provider resource cancels the stalled in-flight HTTP call promptly.
    timeout(
        Duration::from_secs(5),
        fixture.revocations.revoke(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                budget: budget(),
            },
            RevocationSelector::ProviderResource(local.resource.id.clone()),
            RevocationReason::PermissionChanged,
        ),
    )
    .await
    .expect("revocation completes without deadlocking")
    .unwrap();
    let outcome = timeout(Duration::from_secs(5), call_task)
        .await
        .expect("stalled completion cancelled by revocation")
        .unwrap();
    match outcome {
        Err(_) => (),
        Ok(mut stream) => {
            let err = timeout(Duration::from_secs(5), stream.next())
                .await
                .expect("stream must terminate promptly on revocation");
            assert!(err.is_err(), "revoked stream must fail, got {err:?}");
        }
    }
}

async fn orphan_active_run_recovered_on_enqueue(
    fixture: RuntimeFixture,
    personal: &SpaceContext,
) -> RuntimeFixture {
    let scope = personal.scope().clone();
    let actor = fixture.human.auth().principal().clone();
    let thread = ChatThreadId::from_bytes([98; 16]);
    let dead_run = AgentRunId::from_bytes([98; 16]);
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
                identity: mutation(98),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Orphan recovery".into(),
                },
            },
        )
        .await
        .unwrap();
    // Simulate a crashed process that left `active_run_id` set in canonical storage,
    // then reopen canonical storage under a fresh generation / writer epoch.
    let dead_auth = fixture
        .human
        .auth()
        .for_agent_run(
            dead_run.clone(),
            scope.space_id.clone(),
            ChatAudience::Personal,
            fixture.human.auth().spaces().clone(),
        )
        .unwrap();
    fixture
        .canonical
        .claim_active_run(
            SpaceContext::new(dead_auth, scope.clone(), budget()).unwrap(),
            ClaimChatRun {
                thread: thread.clone(),
                run: dead_run,
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();

    let fixture = fixture.reopen_fenced(&scope).await;
    let owner = &fixture.human;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(&fixture, owner, &listener, 90, true).await;
    approve_disclosure(
        &fixture,
        owner,
        &local,
        94,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
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
    let submitted = supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: mutation(99),
                id: PendingInputId::from_bytes([99; 16]),
                thread: thread.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Recover orphaned thread.".into(),
                mentions_agent: false,
            },
            options,
        )
        .await
        .unwrap();
    assert!(
        matches!(submitted.outcome, SubmitUserChatOutcome::Appended(_)) && submitted.run.is_some(),
        "enqueue_input must fence and recover orphaned active_run_id"
    );
    let (mut wire, _) = timeout(Duration::from_secs(10), read_request(&listener))
        .await
        .unwrap();
    send_ollama(
        &mut wire,
        json!({"role": "assistant", "content": "Recovered."}),
        "stop",
    )
    .await;
    wire.get_mut().shutdown().await.unwrap();
    supervisor.shutdown();
    fixture
}

async fn episode_mutation_blocked_for_read_and_shared_agents(fixture: &RuntimeFixture) {
    let owner = &fixture.human;
    let started = call(fixture, owner, 101, "start_session", json!({}))
        .await
        .unwrap();
    let session_str = started.structured_content["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let episode_id = EpisodeId::parse(&session_str).unwrap();
    let ep = fixture
        .control
        .get_episode(owner.clone(), episode_id.clone())
        .await
        .unwrap();
    let read_pat = fixture.pat(BearerScope::Read, false).await;
    let err = call(
        fixture,
        &read_pat,
        102,
        "use_role",
        json!({"name": "research", "session": session_str}),
    )
    .await
    .err()
    .expect("BearerScope::Read must not mutate episode active_role");
    assert!(
        matches!(err, PortError::Domain(DomainError::AccessDenied)),
        "expected AccessDenied, got {err:?}"
    );

    // ChatAudience::Shared AgentRun and Keeper principals must not mutate or open episodes.
    let personal_scope = fixture.personal_scope().await;
    let personal_space = personal_scope.scope().space_id.clone();
    let shared_run = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([103; 16]),
            personal_space.clone(),
            ChatAudience::Shared,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let shared_ctx = AccountContext::new(shared_run, budget());
    let role_ref = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: None,
                kind: Some(notarium_core::classes::AbilityKind::Role),
                name: Some("research".into()),
                authoring: false,
            },
        )
        .await
        .unwrap()
        .items[0]
        .descriptor
        .reference
        .clone();
    let keeper_ctx = AccountContext::new(
        owner
            .auth()
            .for_keeper(
                AgentRunId::from_bytes([109; 16]),
                personal_space.clone(),
                None,
                std::collections::BTreeSet::new(),
            )
            .unwrap(),
        budget(),
    );
    for result in [
        fixture
            .control
            .touch_episode(shared_ctx.clone(), episode_id.clone())
            .await,
        fixture
            .control
            .touch_episode(keeper_ctx, episode_id.clone())
            .await,
        fixture
            .control
            .update_episode(
                shared_ctx.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, 104).await,
                    input: EpisodeMutation::BindRole(BindEpisodeRole {
                        episode: episode_id.clone(),
                        expected: ep.revision,
                        active_role: role_ref.clone(),
                        project_hint: None,
                    }),
                },
            )
            .await
            .map(|_| ()),
        fixture
            .control
            .update_episode(
                shared_ctx.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, 105).await,
                    input: EpisodeMutation::Full(EpisodeUpdate {
                        episode: episode_id.clone(),
                        expected: ep.revision,
                        name: ep.name.clone(),
                        active_role: Some(role_ref),
                        project_hint: None,
                        lifecycle: EpisodeLifecycle::Active,
                    }),
                },
            )
            .await
            .map(|_| ()),
        fixture
            .control
            .start_or_resume_episode(
                shared_ctx.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, 106).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::Id(episode_id.clone()),
                        project_hint: None,
                        guard: EpisodeRevisionGuard::Target,
                    },
                },
            )
            .await
            .map(|_| ()),
        fixture
            .control
            .acknowledge_delta(
                shared_ctx,
                AccountMutation {
                    identity: identity(fixture, owner, 107).await,
                    input: AcknowledgeDelta {
                        owner: AckOwner::Episode(episode_id),
                        delivered: notarium_core::receipt::ChangeCursor {
                            scope: personal_scope.scope().clone(),
                            after: SpaceSeq::new(1).unwrap(),
                        },
                    },
                },
            )
            .await
            .map(|_| ()),
    ] {
        assert!(
            matches!(result, Err(PortError::Domain(DomainError::AccessDenied))),
            "shared AgentRun/Keeper episode mutation must be denied: {result:?}"
        );
    }

    // Provider tool schema for edit_note.view.source.set must accept nested JSON values.
    let personal_run = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([108; 16]),
            personal_space,
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let tools = fixture.registry.provider_tools(&personal_run);
    let edit_tool = tools
        .iter()
        .find(|tool| tool.name == "edit_note")
        .expect("edit_note provider tool");
    let ProviderToolSchema::Object { properties, .. } = &edit_tool.parameters else {
        panic!("expected object schema");
    };
    let ProviderToolSchema::Object {
        properties: view_props,
        ..
    } = properties.get("view").expect("view schema")
    else {
        panic!("expected view object schema");
    };
    let ProviderToolSchema::Object {
        properties: source_props,
        ..
    } = view_props.get("source").expect("source schema")
    else {
        panic!("expected source object schema");
    };
    let ProviderToolSchema::Map { values } = source_props.get("set").expect("set schema") else {
        panic!("expected map schema for view.source.set");
    };
    assert!(
        matches!(values.as_ref(), ProviderToolSchema::JsonValue),
        "expected JsonValue schema, got {values:?}"
    );
}

async fn exact_causal_graph_and_control_replay_seams(
    fixture: &RuntimeFixture,
    _personal: &SpaceContext,
) {
    // Tainted caller must be rejected on episode mutations.
    let ep_id = EpisodeId::from_bytes([123; 16]);
    let tainted_ep = fixture
        .control
        .start_or_resume_episode(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 123).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_id.clone(),
                        name: Some("replay-guard-compat".into()),
                    },
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await;
    assert!(
        matches!(
            tainted_ep,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ),
        "tainted caller must not open/resume episode: {tainted_ep:?}"
    );

    let fresh_owner = AccountContext::new(
        fixture
            .control
            .trusted_none(
                PerimeterAttestation::attest_checked()
                    .with_human_management()
                    .with_ability_write(),
                budget(),
            )
            .await
            .unwrap(),
        budget(),
    );
    let owner = &fresh_owner;

    // Control replay compatibility: guard variant must not alter the hashed
    // payload for start_or_resume_episode or set_ability_preference.
    let ep_identity = identity(fixture, owner, 123).await;
    let first_ep = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: ep_identity.clone(),
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_id.clone(),
                        name: Some("replay-guard-compat".into()),
                    },
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let replayed_ep = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: ep_identity,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_id.clone(),
                        name: Some("replay-guard-compat".into()),
                    },
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(first_ep.revision, replayed_ep.revision);

    let owned_ability = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: None,
                kind: None,
                name: None,
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.descriptor.reference.placement != AbilityPlacement::System)
        .expect("owned ability present")
        .descriptor
        .reference;
    let pref_identity = identity(fixture, owner, 124).await;
    let first_pref = fixture
        .control
        .set_ability_preference(
            owner.clone(),
            AccountMutation {
                identity: pref_identity.clone(),
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: owned_ability.clone(),
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let mismatched_kind = fixture
        .control
        .set_ability_preference(
            owner.clone(),
            AccountMutation {
                identity: pref_identity.clone(),
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: owned_ability.clone(),
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Authored(None),
                },
            },
        )
        .await;
    assert!(
        matches!(
            mismatched_kind,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ),
        "reusing an Account preference key for Authored CAS must reject: {mismatched_kind:?}"
    );
    let replayed_pref = fixture
        .control
        .set_ability_preference(
            owner.clone(),
            AccountMutation {
                identity: pref_identity,
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: owned_ability.clone(),
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(first_pref.revision, replayed_pref.revision);

    // Tainted caller must be rejected on touch_episode, ability overlay mutations,
    // and overlay-only edit_ability before any control DB write or journal entry.
    let tainted_owner = &fixture.human;
    assert!(
        tainted_owner.auth().taint().is_tainted(),
        "fixture.human must be tainted at this stage"
    );
    let tainted_results = [
        fixture
            .control
            .touch_episode(tainted_owner.clone(), ep_id.clone())
            .await,
        fixture
            .control
            .update_ability_binding(
                tainted_owner.clone(),
                AccountMutation {
                    identity: identity(fixture, tainted_owner, 125).await,
                    input: AbilityBindingUpdate {
                        ability: owned_ability.clone(),
                        enabled: true,
                        expected: AbilityOverlayGuard::Authored(None),
                        projects: AbilityProjects::All,
                    },
                },
            )
            .await
            .map(|_| ()),
        fixture
            .control
            .set_ability_preference(
                tainted_owner.clone(),
                AccountMutation {
                    identity: identity(fixture, tainted_owner, 126).await,
                    input: AbilityPreferenceChange {
                        preference: AbilityPreferenceUpdate {
                            ability: owned_ability.clone(),
                            enabled: false,
                        },
                        expected: AbilityPreferenceGuard::Account,
                    },
                },
            )
            .await
            .map(|_| ()),
        fixture
            .control
            .set_ability_preference(
                tainted_owner.clone(),
                AccountMutation {
                    identity: identity(fixture, tainted_owner, 127).await,
                    input: AbilityPreferenceChange {
                        preference: AbilityPreferenceUpdate {
                            ability: owned_ability.clone(),
                            enabled: false,
                        },
                        expected: AbilityPreferenceGuard::Authored(Some(first_pref.revision)),
                    },
                },
            )
            .await
            .map(|_| ()),
        fixture
            .control
            .set_ability_trail(
                tainted_owner.clone(),
                AccountMutation {
                    identity: identity(fixture, tainted_owner, 128).await,
                    input: AbilityTrailMutation::Set(AbilityTrailUpdate {
                        source: owned_ability.clone(),
                        expected_destination: None,
                        destination: Some(owned_ability.clone()),
                    }),
                },
            )
            .await
            .map(|_| ()),
        call(
            fixture,
            tainted_owner,
            129,
            "edit_ability",
            json!({
                "ref": owned_ability.id,
                "enabled": false,
            }),
        )
        .await
        .map(|_| ()),
        call(
            fixture,
            tainted_owner,
            133,
            "start_session",
            json!({"task": "tainted-start"}),
        )
        .await
        .map(|_| ()),
        fixture
            .control
            .record_mcp_dedup(
                tainted_owner.clone(),
                McpDedupRecord {
                    key: McpDedupKey {
                        actor: tainted_owner.auth().principal().to_string(),
                        request_key: CommandKey::from_bytes([134; 16]),
                        request_hash: ContentDigest::from_bytes([134; 32]),
                        operation: "invocation".into(),
                    },
                    safe_result: "true".into(),
                    effect: AgentEffect::Write,
                    ttl_ms: 60_000,
                },
            )
            .await
            .map(|_| ()),
    ];
    for result in tainted_results {
        assert!(
            matches!(
                result,
                Err(PortError::Domain(DomainError::CrossSpaceTainted))
            ),
            "tainted caller must fail closed with CrossSpaceTainted: {result:?}"
        );
    }
    // Verify tainted MCP write attempts did NOT commit any mcp_dedup rows.
    for (tag, op) in [(129u8, "invocation"), (133u8, "start-episode")] {
        let hit = fixture
            .control
            .lookup_mcp_dedup(
                owner.clone(),
                McpDedupKey {
                    actor: format!("direct:{}", owner.auth().principal()),
                    request_key: CommandKey::from_bytes([tag; 16]),
                    request_hash: ContentDigest::from_bytes([tag; 32]),
                    operation: op.into(),
                },
            )
            .await
            .unwrap();
        assert!(
            hit.is_none(),
            "tainted MCP call must not persist mcp_dedup row for {op}"
        );
    }

    // set_folder_write_lock must honor SpaceContext::canonical_effect inside
    // the canonical writer savepoint on both SQLite and PostgreSQL.
    struct CountingEffect {
        begins: Arc<std::sync::atomic::AtomicUsize>,
        reject_on_begin: bool,
    }
    struct NoopLease;
    impl RevocationLease for NoopLease {
        fn check(&self) -> Result<(), PortError> {
            Ok(())
        }
    }
    impl CanonicalEffectRegistration for CountingEffect {
        fn restrict_until(&self, _deadline: std::time::Instant) -> Result<(), PortError> {
            Ok(())
        }
        fn check(&self) -> Result<(), PortError> {
            Ok(())
        }
        fn begin(self: Arc<Self>) -> PortFuture<'static, Box<dyn RevocationLease>> {
            let begins = self.begins.clone();
            let reject = self.reject_on_begin;
            Box::pin(async move {
                begins.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if reject {
                    return Err(DomainError::AccessDenied.into());
                }
                Ok(Box::new(NoopLease) as Box<dyn RevocationLease>)
            })
        }
    }
    let personal_scope = fixture.personal_scope().await;
    let scope = personal_scope.scope().clone();
    let actor = owner.auth().principal().clone();
    let fresh_personal = SpaceContext::new(owner.auth().clone(), scope.clone(), budget()).unwrap();
    let lock_folder = FolderId::from_bytes([130; 16]);
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: lock_folder.clone(),
            parent: None,
            slug: "fenced-write-lock".into(),
            display_name: "Fenced Write Lock".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();

    let reject_begins = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let rejected_ctx = fresh_personal
        .clone()
        .with_canonical_effect(
            owner,
            Arc::new(CountingEffect {
                begins: reject_begins.clone(),
                reject_on_begin: true,
            }),
        )
        .unwrap();
    let denied = fixture
        .canonical
        .set_folder_write_lock(rejected_ctx, lock_folder.clone(), true)
        .await;
    assert!(
        matches!(denied, Err(PortError::Domain(DomainError::AccessDenied))),
        "revoked canonical_effect must abort set_folder_write_lock: {denied:?}"
    );
    assert_eq!(
        reject_begins.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "set_folder_write_lock must invoke canonical_effect.begin()"
    );
    // Folder must remain unlocked after the aborted write-lock mutation.
    fixture
        .canonical
        .create_note(
            fresh_personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([131; 16]),
                    hash: ContentDigest::from_bytes([131; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([131; 16]),
                    parent: Some(lock_folder.clone()),
                    slug: "unlocked-after-abort".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Still unlocked\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();

    let allow_begins = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let allowed_ctx = fresh_personal
        .clone()
        .with_canonical_effect(
            owner,
            Arc::new(CountingEffect {
                begins: allow_begins.clone(),
                reject_on_begin: false,
            }),
        )
        .unwrap();
    fixture
        .canonical
        .set_folder_write_lock(allowed_ctx, lock_folder.clone(), true)
        .await
        .unwrap();
    assert_eq!(
        allow_begins.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "admitted set_folder_write_lock must still enter canonical_effect.begin()"
    );
    let blocked = fixture
        .canonical
        .create_note(
            fresh_personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([132; 16]),
                    hash: ContentDigest::from_bytes([132; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([132; 16]),
                    parent: Some(lock_folder.clone()),
                    slug: "blocked-after-lock".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Locked\n".into(),
                    folder_page: false,
                },
            },
        )
        .await;
    assert!(
        matches!(blocked, Err(PortError::Domain(DomainError::SpaceReadOnly))),
        "folder must be write-locked after admitted set_folder_write_lock: {blocked:?}"
    );
    fixture
        .canonical
        .set_folder_write_lock(fresh_personal.clone(), lock_folder, false)
        .await
        .unwrap();

    // Cross-Space FolderAncestryCache isolation: identical FolderId in two Spaces
    // (inside project p1 in personal, outside project p1 in shared) must never
    // poison folder_disclosures or acquire_egress under a project_root-scoped caller.
    let shared_space_id = SpaceId::from_bytes([1; 16]);
    let shared_rec = fixture
        .canonical
        .read_space(&shared_space_id)
        .await
        .unwrap();
    let shared_p1 = FolderId::from_bytes([2; 16]);
    let colliding_folder = FolderId::from_bytes([135; 16]);
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: shared_p1.clone(),
            parent: None,
            slug: "personal-p1".into(),
            display_name: "Personal P1".into(),
            is_project: true,
            project_slug: Some("personal-p1".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: colliding_folder.clone(),
            parent: Some(shared_p1.clone()),
            slug: "colliding-in-p1".into(),
            display_name: "Colliding In P1".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: shared_rec.scope.clone(),
            active_epoch: shared_rec.active_epoch,
            folder_id: colliding_folder.clone(),
            parent: None,
            slug: "colliding-outside-p1".into(),
            display_name: "Colliding Outside P1".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();

    let personal_ref = FolderRef {
        space_id: scope.space_id.clone(),
        folder_id: colliding_folder.clone(),
    };
    let shared_ref = FolderRef {
        space_id: shared_space_id.clone(),
        folder_id: colliding_folder.clone(),
    };
    let shared_full_proof = fixture
        .canonical
        .disclosure(owner.clone(), CatalogDisclosure::Folder(shared_ref.clone()))
        .await
        .unwrap();

    let mut scoped_grants = owner.auth().spaces().clone();
    scoped_grants
        .get_mut(&shared_space_id)
        .expect("shared grant")
        .project_root = Some(shared_p1);
    let scoped_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([135; 16]),
            scope.space_id.clone(),
            ChatAudience::Personal,
            scoped_grants,
        )
        .unwrap();
    let scoped_ctx = AccountContext::new(scoped_auth, budget());

    let proofs = fixture
        .canonical
        .folder_disclosures(
            scoped_ctx.clone(),
            vec![personal_ref.clone(), shared_ref.clone()],
        )
        .await
        .unwrap();
    assert_eq!(
        proofs.len(),
        1,
        "out-of-project folder in Space B must not inherit Space A ancestry in folder_disclosures"
    );
    assert_eq!(
        proofs[0].current().origin().space_id(),
        Some(&scope.space_id)
    );

    let egress_result = fixture
        .canonical
        .acquire_egress(
            scoped_ctx,
            ProviderEgressRequest {
                primary: scope.clone(),
                project: None,
                secondary_projects: vec![],
                project_folders: std::collections::BTreeSet::new(),
                origins: vec![
                    proofs[0].current().origin(),
                    shared_full_proof.current().origin(),
                ],
            },
            Cancellation::default(),
        )
        .await
        .map(|_| ());
    assert!(
        matches!(
            egress_result,
            Err(PortError::Domain(
                DomainError::AccessDenied | DomainError::ResourceNotFound
            ))
        ),
        "out-of-project folder in Space B must not inherit Space A ancestry in acquire_egress: {egress_result:?}"
    );
}
