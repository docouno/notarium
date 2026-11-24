//! Dual-database integration regressions for provider consent boundaries,
//! live collaboration interception, non-blocking TTFB dispatch, and recovery.
use std::time::Duration;

use notarium_agents::{
    chats::{AgentRunSupervisor, ChatRunOptions, ExclusiveDataRoot, StartChatRun},
    mcp::{ConfirmProposedDiff, PersonalToolInvocation},
};
use notarium_canonical::CreateFolderSpec;
use notarium_collab::CollabSessionAuth;
use notarium_core::{
    auth::{ChatAudience, SpaceKind},
    classes::{AbilityKind, DocClass},
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
    let mut fixture = Box::pin(RuntimeFixture::open_named(pg, "agents_security_seams")).await;
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
    Box::pin(contract_and_seams_regressions(&fixture, &personal)).await;
    Box::pin(episode_project_and_folder_journal_regressions(
        &mut fixture,
        &personal,
    ))
    .await;
    Box::pin(role_cursor_and_schema_regressions(&fixture, &personal)).await;
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
    personal: &SpaceContext,
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
    // Verify tainted MCP write attempts did NOT commit any mcp_dedup rows:
    // clean `owner` shares the same TrustedNone grant as `tainted_owner`, so
    // reusing caller tags 129 and 133 with different arguments would fail with
    // IdempotencyKeyReused if any journal row had been persisted.
    assert_eq!(owner.auth().grant(), tainted_owner.auth().grant());
    call(
        fixture,
        owner,
        129,
        "edit_ability",
        json!({
            "ref": owned_ability.id,
            "enabled": true,
        }),
    )
    .await
    .expect("clean edit_ability reusing tag 129 must not hit a tainted mcp_dedup row");
    call(
        fixture,
        owner,
        133,
        "start_session",
        json!({"task": "clean-start"}),
    )
    .await
    .expect("clean start_session reusing tag 133 must not hit a tainted mcp_dedup row");
    let direct_hit = fixture
        .control
        .lookup_mcp_dedup(
            owner.clone(),
            McpDedupKey {
                actor: tainted_owner.auth().principal().to_string(),
                request_key: CommandKey::from_bytes([134; 16]),
                request_hash: ContentDigest::from_bytes([134; 32]),
                operation: "invocation".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        direct_hit.is_none(),
        "tainted direct record_mcp_dedup must not persist tag 134"
    );

    // begin_agent_call with AgentTransport::Mcp must NOT mutate agent_episodes
    // via touch_active for tainted callers, AgentRun, or Keeper principals.
    let saved_clock = fixture
        .storage
        .clock
        .0
        .load(std::sync::atomic::Ordering::SeqCst);
    fixture
        .storage
        .clock
        .0
        .fetch_add(20 * 60_000, std::sync::atomic::Ordering::SeqCst);
    call(
        fixture,
        tainted_owner,
        135,
        "whoami",
        json!({"session": ep_id.to_string()}),
    )
    .await
    .expect("tainted read tool remains allowed while skipping episode heartbeat");
    let tainted_write_with_session = call(
        fixture,
        tainted_owner,
        136,
        "edit_ability",
        json!({
            "ref": owned_ability.id,
            "enabled": false,
            "session": ep_id.to_string(),
        }),
    )
    .await;
    assert!(matches!(
        tainted_write_with_session,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    let personal_space = personal.scope().space_id.clone();
    let agent_run_ctx = AccountContext::new(
        owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([137; 16]),
                personal_space.clone(),
                ChatAudience::Shared,
                owner.auth().spaces().clone(),
            )
            .unwrap(),
        budget(),
    );
    let keeper_call_ctx = AccountContext::new(
        owner
            .auth()
            .for_keeper(
                AgentRunId::from_bytes([138; 16]),
                personal_space,
                None,
                std::collections::BTreeSet::new(),
            )
            .unwrap(),
        budget(),
    );
    for (tag, caller) in [(137u8, agent_run_ctx), (138u8, keeper_call_ctx)] {
        fixture
            .control
            .begin_agent_call(
                caller,
                BeginAgentCall {
                    call: RequestId::from_bytes([tag; 16]),
                    request: RequestId::from_bytes([tag; 16]),
                    episode: Some(ep_id.clone()),
                    operation: AgentOperation::Context,
                    transport: AgentTransport::Mcp,
                    effect: AgentEffect::Read,
                    input_bytes: 0,
                },
            )
            .await
            .unwrap();
    }
    // Advance +15 min (35 min since ep_id creation, only 15 min since the
    // forbidden heartbeat attempts). Because none updated last_seen_at, ep_id
    // must be treated as idle (>= 30 min) and Resumed rather than Forked.
    fixture
        .storage
        .clock
        .0
        .fetch_add(15 * 60_000, std::sync::atomic::Ordering::SeqCst);
    let resumed_after_idle = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 139).await,
                input: StartEpisode {
                    selector: EpisodeSelector::Id(ep_id.clone()),
                    project_hint: None,
                    guard: EpisodeRevisionGuard::default(),
                },
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(
            resumed_after_idle.value,
            EpisodeStartResult::Resumed(ref resumed) if resumed.id == ep_id
        ),
        "tainted/AgentRun/Keeper begin_agent_call must not extend episode idle window: {:?}",
        resumed_after_idle.value
    );
    fixture
        .storage
        .clock
        .0
        .store(saved_clock, std::sync::atomic::Ordering::SeqCst);

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

async fn contract_and_seams_regressions(fixture: &RuntimeFixture, personal: &SpaceContext) {
    let owner = AccountContext::new(
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

    // 1. MCP readOnlyHint annotations: start_session and use_role mutate episode/cursor state
    // and report read_only_hint = false while remaining callable under BearerScope::Read (12 tools).
    let descriptors = fixture
        .registry
        .list_tools(owner.clone(), &EgressTarget::ExternalMcp)
        .await
        .unwrap();
    let hint = |name: &str| {
        descriptors
            .iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("missing tool descriptor {name}"))
            .annotations
            .read_only_hint
    };
    assert!(!hint("start_session"));
    assert!(!hint("use_role"));
    assert!(hint("whoami"));
    assert!(hint("list_notes"));
    assert!(hint("use_skill"));

    // 2. Direct link and link_many must return the exact revision produced by the link command
    // even after an intervening manual edit, so replaying link never hands out a newer token.
    let projects = call(fixture, &owner, 209, "get_my_projects", json!({}))
        .await
        .unwrap();
    let personal_project = projects.structured_content["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["spaceId"].as_str() == Some(personal.scope().space_id.as_str()))
        .expect("personal project in personal space");
    let project_handle = personal_project["handle"]
        .as_str()
        .expect("personal project handle")
        .to_owned();
    let project_folder = FolderId::parse(
        personal_project["projectId"]
            .as_str()
            .expect("personal projectId"),
    )
    .unwrap();
    let src = call(
        fixture,
        &owner,
        210,
        "create_note",
        json!({
            "project": project_handle,
            "title": "Link Source Exact Rev",
            "body": "# Link Source Exact Rev\n\nOriginal body.\n",
        }),
    )
    .await
    .unwrap();
    let dst = call(
        fixture,
        &owner,
        211,
        "create_note",
        json!({
            "project": project_handle,
            "title": "Link Target Secret Title",
            "body": "# Link Target Secret Title\n\nTarget body.\n",
        }),
    )
    .await
    .unwrap();
    let src_id = src.structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();
    let dst_id = dst.structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();

    let first_link = call(
        fixture,
        &owner,
        212,
        "link",
        json!({
            "from": src_id,
            "to": dst_id,
            "relation": "supports",
        }),
    )
    .await
    .unwrap();
    let link_token = first_link.structured_content["versionToken"]
        .as_str()
        .unwrap()
        .to_owned();

    let manual_edit = call(
        fixture,
        &owner,
        213,
        "edit_note",
        json!({
            "ref": src_id,
            "operation": "append",
            "content": "\nManual edit after link.\n",
            "versionToken": link_token,
        }),
    )
    .await
    .unwrap();
    let manual_token = manual_edit.structured_content["versionToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(link_token, manual_token);

    // Replaying the exact same link call (same tag 212) must return the original link revision,
    // NEVER the intervening manual edit's versionToken.
    let replayed_link = call(
        fixture,
        &owner,
        212,
        "link",
        json!({
            "from": src_id,
            "to": dst_id,
            "relation": "supports",
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        replayed_link.structured_content["versionToken"].as_str(),
        Some(link_token.as_str()),
        "link replay must return the link command's exact revision, not a later manual edit"
    );

    // Using the replayed link's versionToken to edit must fail with RevisionConflict rather than
    // silently overwriting the manual edit.
    let stale_edit = call(
        fixture,
        &owner,
        214,
        "edit_note",
        json!({
            "ref": src_id,
            "operation": "append",
            "content": "\nStale overwrite attempt.\n",
            "versionToken": replayed_link.structured_content["versionToken"],
        }),
    )
    .await
    .map(|_| ());
    assert!(
        matches!(
            stale_edit,
            Err(PortError::Domain(DomainError::RevisionConflict { .. }))
        ),
        "stale token from replayed link must conflict with intervening edit: {stale_edit:?}"
    );

    // Same exact-revision guarantee for link_many.
    let batch_link = call(
        fixture,
        &owner,
        215,
        "link_many",
        json!({
            "links": [{
                "from": src_id,
                "toTitle": "Uncreated Forward Title",
                "relation": "mentions",
            }]
        }),
    )
    .await
    .unwrap();
    let batch_token = batch_link.structured_content["results"][0]["versionToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let after_batch_edit = call(
        fixture,
        &owner,
        216,
        "edit_note",
        json!({
            "ref": src_id,
            "operation": "append",
            "content": "\nManual edit after link_many.\n",
            "versionToken": batch_token,
        }),
    )
    .await
    .unwrap();
    let after_batch_token = after_batch_edit.structured_content["versionToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(batch_token, after_batch_token);
    let replayed_batch = call(
        fixture,
        &owner,
        215,
        "link_many",
        json!({
            "links": [{
                "from": src_id,
                "toTitle": "Uncreated Forward Title",
                "relation": "mentions",
            }]
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        replayed_batch.structured_content["results"][0]["versionToken"].as_str(),
        Some(batch_token.as_str()),
        "link_many replay must return exact link revision, not a later manual edit"
    );

    // 3. list_child_folders stays bound to its opening cut and returns CursorStale when a
    // sibling folder is created after the cut.
    for (tag, title) in [(217u8, "Cut Alpha"), (218, "Cut Beta")] {
        call(
            fixture,
            &owner,
            tag,
            "create_note",
            json!({
                "project": project_handle,
                "path": format!("cut-parent/sub-{tag}"),
                "title": title,
                "body": format!("# {title}\n\nBody.\n"),
            }),
        )
        .await
        .unwrap();
    }
    let cut_parent = fixture
        .canonical
        .resolve_folder_path(personal.clone(), Some(project_folder), "cut-parent".into())
        .await
        .unwrap()
        .expect("cut-parent folder");
    let page1 = fixture
        .canonical
        .list_child_folders(
            personal.clone(),
            Some(cut_parent.reference.folder_id.clone()),
            None,
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    let after1 = page1
        .next
        .clone()
        .expect("page 1 must return continuation folder id");
    let page2 = fixture
        .canonical
        .list_child_folders(
            personal.clone(),
            Some(cut_parent.reference.folder_id.clone()),
            Some(after1.clone()),
            Some(page1.cut_seq),
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        page2.next.is_none(),
        "page 2 must end the initial 2-folder cut"
    );
    // Add a 3rd sibling folder after the cut.
    call(
        fixture,
        &owner,
        221,
        "create_note",
        json!({
            "project": project_handle,
            "path": "cut-parent/sub-zzz",
            "title": "Cut Gamma",
            "body": "# Cut Gamma\n\nBody.\n",
        }),
    )
    .await
    .unwrap();
    let stale_page = fixture
        .canonical
        .list_child_folders(
            personal.clone(),
            Some(cut_parent.reference.folder_id.clone()),
            Some(after1),
            Some(page1.cut_seq),
            PageLimit::new(1).unwrap(),
        )
        .await
        .map(|_| ());
    assert!(
        matches!(
            stale_page,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == notarium_core::error::ValidationReason::CursorStale
        ),
        "reusing folder cursor after sibling creation must return CursorStale: {stale_page:?}"
    );

    // 4. Ability names with an `ab_` prefix (e.g. `ab_weekly`) AND 12-character ASCII names
    // (which match legacy ID shape, e.g. `ab_weekly_01`) must both resolve by name, and
    // `use_role` in a SpaceGroup/Shared chat must render inline without mutating the episode.
    for (create_tag, use_tag, name, marker) in [
        (223u8, 224u8, "ab_weekly", "Check progress."),
        (233u8, 234u8, "ab_weekly_01", "Twelve-char name."),
    ] {
        call(
            fixture,
            &owner,
            create_tag,
            "create_ability",
            json!({
                "kind": "skill",
                "name": name,
                "description": "Digest checklist",
                "instructions": format!("# {name}\n\n{marker}"),
                "placement": {"home": "personal"},
            }),
        )
        .await
        .unwrap();
        let activated = call(fixture, &owner, use_tag, "use_skill", json!({"name": name}))
            .await
            .unwrap();
        assert!(
            activated.content[0].text.contains(marker),
            "ability name {name} must activate by name"
        );
    }

    let ep_started = call(
        fixture,
        &owner,
        225,
        "start_session",
        json!({"task": "shared-use-role-check"}),
    )
    .await
    .unwrap();
    let shared_ep = EpisodeId::parse(
        ep_started.structured_content["session"]["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let shared_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([226; 16]),
            personal.scope().space_id.clone(),
            ChatAudience::Shared,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let shared_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let shared_local = loopback_provider(fixture, &owner, &shared_listener, 228, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &shared_local,
        232,
        ProviderAttachmentTarget::Personal {
            owner: owner.auth().principal().clone(),
            space: personal.scope().space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;
    let shared_role_res = shared_local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(shared_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: shared_local.resource.id.clone(),
                    model: shared_local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([226; 16]),
            },
            "use_role",
            json!({
                "name": "research",
                "session": shared_ep.to_string(),
            }),
        )
        .await;
    // System role activation in a Shared chat must succeed inline (never AccessDenied
    // from save_active_role) and leave the episode's active_role unchanged.
    let shared_role_out = shared_role_res.unwrap_or_else(|err| {
        panic!("Shared chat use_role must render inline without error: {err:?}")
    });
    assert!(
        !shared_role_out.content[0].text.is_empty(),
        "Shared chat use_role must return rendered role instructions"
    );
    let ep_after = fixture
        .control
        .get_episode(owner.clone(), shared_ep)
        .await
        .unwrap();
    assert!(
        ep_after.active_role.is_none(),
        "Shared chat use_role must not persist active_role onto the episode"
    );

    // 5. Chat thread_gate respects CallBudget deadline (zero-remaining budget fails immediately
    // with DeadlineExceeded without writing).
    let supervisor = AgentRunSupervisor::new_local(
        fixture.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let mut expired_owner = owner.clone();
    expired_owner.budget.remaining = Duration::ZERO;
    let expired_start = supervisor
        .start(
            expired_owner,
            StartChatRun {
                scope: personal.scope().clone(),
                thread: ChatThreadId::from_bytes([227; 16]),
                expected_leaf: ThreadEntrySeq::ZERO,
                options: ChatRunOptions::default(),
            },
        )
        .await;
    assert!(
        matches!(expired_start, Err(PortError::DeadlineExceeded(_))),
        "expired CallBudget on start must return DeadlineExceeded: {expired_start:?}"
    );
}

async fn episode_project_and_folder_journal_regressions(
    fixture: &mut RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = AccountContext::new(
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
    let actor = owner.auth().principal().clone();
    let active_epoch = fixture
        .canonical
        .read_space(&personal.scope().space_id)
        .await
        .unwrap()
        .active_epoch;
    let call_tool = |account: &AccountContext, seq: u8, tool: &str, args: Value| {
        let mut key = [0xE4; 16];
        key[15] = seq;
        let registry = fixture.registry.clone();
        let account = account.clone();
        let tool = tool.to_owned();
        async move {
            registry
                .call_tool(
                    McpInvocationContext {
                        account,
                        target: EgressTarget::ExternalMcp,
                        request_key: CommandKey::from_bytes(key),
                    },
                    &tool,
                    args,
                )
                .await
        }
    };

    // 1. ProjectUnavailable episode binding must fail closed on relative folder/read/ability
    //    calls (including start_session with explicit role) instead of falling back to the
    //    personal Space, broadening to all Spaces, or clearing the stored project binding.
    let proj_gone = FolderId::from_bytes([0xE4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let proj_gone_docs = FolderId::from_bytes([0xE4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let personal_docs = FolderId::from_bytes([0xE4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    for (id, parent, slug, display, is_project) in [
        (&proj_gone, None, "proj-gone", "Project Gone", true),
        (
            &proj_gone_docs,
            Some(proj_gone.clone()),
            "docs-rel",
            "Docs Inside Project",
            false,
        ),
        (
            &personal_docs,
            None,
            "docs-rel",
            "Docs In Personal Root",
            false,
        ),
    ] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: personal.scope().clone(),
                active_epoch,
                folder_id: id.clone(),
                parent,
                slug: slug.into(),
                display_name: display.into(),
                is_project,
                project_slug: is_project.then(|| slug.into()),
                actor: actor.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let projects = call_tool(&owner, 10, "get_my_projects", json!({}))
        .await
        .unwrap();
    assert!(
        projects.structured_content["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["slug"].as_str() == Some("proj-gone")),
        "proj-gone must be listed before binding"
    );
    let proj_gone_ref = FolderRef {
        space_id: personal.scope().space_id.clone(),
        folder_id: proj_gone.clone(),
    };
    let ep_gone = EpisodeId::from_bytes([0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let started_ep = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE4; 32]),
                },
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_gone.clone(),
                        name: Some("gone-project-guard".into()),
                    },
                    project_hint: Some(proj_gone_ref.clone()),
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await
        .unwrap();
    let EpisodeStartResult::New(initial_ep) = started_ep.value else {
        panic!("expected new episode for gone-project-guard");
    };
    assert_eq!(initial_ep.project_hint, Some(proj_gone_ref));
    // Mark the bound project trashed so Control reports EpisodeDiagnostic::ProjectUnavailable.
    let trashed = fixture
        .canonical
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE folder_heads SET lifecycle_state='trashed' WHERE space_id='{}' AND folder_id='{}'",
            personal.scope().space_id.as_str(),
            proj_gone.as_str(),
        ))
        .await
        .unwrap();
    assert_eq!(trashed, 1);
    let observed_ep = fixture
        .control
        .get_episode(owner.clone(), ep_gone.clone())
        .await
        .unwrap();
    assert!(observed_ep.project_hint.is_none());
    assert!(
        observed_ep
            .diagnostics
            .contains(&EpisodeDiagnostic::ProjectUnavailable),
        "trashed project must produce ProjectUnavailable diagnostic: {:?}",
        observed_ep.diagnostics
    );

    // Passing an explicit role to start_session on a ProjectUnavailable episode must fail
    // closed instead of clearing the episode's stored project binding in Control DB.
    let explicit_role_reopen = call_tool(
        &owner,
        11,
        "start_session",
        json!({"session": {"id": ep_gone.to_string()}, "role": "research"}),
    )
    .await
    .map(|_| ());
    assert!(
        matches!(
            explicit_role_reopen,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "start_session with explicit role on ProjectUnavailable episode must fail closed: {explicit_role_reopen:?}"
    );
    let still_unavailable = fixture
        .control
        .get_episode(owner.clone(), ep_gone.clone())
        .await
        .unwrap();
    assert!(
        still_unavailable
            .diagnostics
            .contains(&EpisodeDiagnostic::ProjectUnavailable),
        "failed start_session with explicit role must preserve ProjectUnavailable diagnostic"
    );

    // Direct Control BindRole { project_hint: None } on a ProjectUnavailable episode must
    // also fail closed with ResourceNotFound while keeping ProjectUnavailable intact.
    let research_role = match fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: "research".into(),
                kind: AbilityKind::Role,
                project: None,
            },
        )
        .await
        .unwrap()
    {
        AbilityResolution::Resolved(desc) => desc.reference,
        other => panic!("expected system research role, got {other:?}"),
    };
    let direct_gone_bind = fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xE4; 32]),
                },
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: ep_gone.clone(),
                    expected: still_unavailable.revision,
                    active_role: research_role,
                    project_hint: None,
                }),
            },
        )
        .await;
    assert!(
        matches!(
            direct_gone_bind,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "direct BindRole with project_hint: None on ProjectUnavailable episode must fail closed: {direct_gone_bind:?}"
    );
    let after_direct_gone = fixture
        .control
        .get_episode(owner.clone(), ep_gone.clone())
        .await
        .unwrap();
    assert!(
        after_direct_gone
            .diagnostics
            .contains(&EpisodeDiagnostic::ProjectUnavailable),
        "direct BindRole failure must preserve ProjectUnavailable diagnostic"
    );

    for (tag, tool, args) in [
        (
            12u8,
            "rename_folder",
            json!({"folder": "docs-rel", "name": "hijacked-rel", "session": ep_gone.to_string()}),
        ),
        (
            13,
            "move_folder",
            json!({"folder": "docs-rel", "toFolder": "", "session": ep_gone.to_string()}),
        ),
        (14, "list_notes", json!({"session": ep_gone.to_string()})),
        (
            15,
            "list_abilities",
            json!({"view": "runtime", "session": ep_gone.to_string()}),
        ),
    ] {
        let res = call_tool(&owner, tag, tool, args).await.map(|_| ());
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "{tool} with ProjectUnavailable episode must fail closed with ResourceNotFound: {res:?}"
        );
    }
    assert!(
        fixture
            .canonical
            .resolve_folder_path(personal.clone(), None, "docs-rel".into())
            .await
            .unwrap()
            .is_some(),
        "personal root docs-rel must remain intact"
    );
    assert!(
        fixture
            .canonical
            .resolve_folder_path(personal.clone(), None, "hijacked-rel".into())
            .await
            .unwrap()
            .is_none(),
        "hijacked-rel must never be created in personal Space"
    );

    // 2. Content-free FolderRoute journal: rename_folder and rename_project (including
    //    omitted displayName and rejected conflicts) must not persist user folder/project
    //    names or slugs into Control's mcp_dedup.safe_result, and replaying rename_project
    //    with displayName omitted must remain idempotent after a subsequent display-name edit.
    let target_folder = FolderId::from_bytes([0xE4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    let target_proj = FolderId::from_bytes([0xE4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    for (id, slug, display, is_project) in [
        (&target_folder, "folder-orig-rel", "Folder Orig Rel", false),
        (
            &target_proj,
            "proj-orig-rel",
            "Secret Display Name Rel",
            true,
        ),
    ] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: personal.scope().clone(),
                active_epoch,
                folder_id: id.clone(),
                parent: None,
                slug: slug.into(),
                display_name: display.into(),
                is_project,
                project_slug: is_project.then(|| slug.into()),
                actor: actor.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let listed_projects = call_tool(&owner, 16, "get_my_projects", json!({}))
        .await
        .unwrap();
    let target_proj_handle = listed_projects.structured_content["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["slug"].as_str() == Some("proj-orig-rel"))
        .expect("proj-orig-rel listed")["handle"]
        .as_str()
        .unwrap()
        .to_owned();
    let renamed_folder = call_tool(
        &owner,
        17,
        "rename_folder",
        json!({"folder": "folder-orig-rel", "name": "secret-folder-name-rel"}),
    )
    .await
    .unwrap();
    assert_eq!(renamed_folder.structured_content["outcome"], "applied");
    let renamed_proj = call_tool(
        &owner,
        18,
        "rename_project",
        json!({"project": target_proj_handle, "slug": "secret-proj-slug-rel"}),
    )
    .await
    .unwrap();
    assert_eq!(renamed_proj.structured_content["outcome"], "applied");
    assert_eq!(
        renamed_proj.structured_content["displayName"],
        "Secret Display Name Rel"
    );
    // Change the display name with a second command, then replay the first rename_project
    // (same key 18, displayName omitted): canonical receipt replay must still succeed
    // without failing with IdempotencyKeyReused.
    let updated_projects = call_tool(&owner, 24, "get_my_projects", json!({}))
        .await
        .unwrap();
    let renamed_proj_handle = updated_projects.structured_content["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["slug"].as_str() == Some("secret-proj-slug-rel"))
        .expect("secret-proj-slug-rel listed")["handle"]
        .as_str()
        .unwrap()
        .to_owned();
    let updated_display = call_tool(
        &owner,
        25,
        "rename_project",
        json!({
            "project": renamed_proj_handle,
            "slug": "secret-proj-slug-rel",
            "displayName": "Updated Display Later",
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        updated_display.structured_content["displayName"],
        "Updated Display Later"
    );
    let replayed_proj = call_tool(
        &owner,
        18,
        "rename_project",
        json!({"project": target_proj_handle, "slug": "secret-proj-slug-rel"}),
    )
    .await
    .expect("replaying rename_project with omitted displayName after later display edit must replay cleanly");
    assert_eq!(replayed_proj.structured_content["outcome"], "applied");

    // Direct BindRole { project_hint: None } on an episode bound to a live project must
    // validate against the preserved project: reject an OwnedSpace role from another Space,
    // accept an OwnedProject role in the preserved project, and retain the project binding.
    let live_proj_ref = FolderRef {
        space_id: personal.scope().space_id.clone(),
        folder_id: target_proj.clone(),
    };
    let ep_live_proj =
        EpisodeId::from_bytes([0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    let started_live = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
                    ]),
                    hash: ContentDigest::from_bytes([0xE4; 32]),
                },
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_live_proj.clone(),
                        name: Some("live-project-bind-guard".into()),
                    },
                    project_hint: Some(live_proj_ref.clone()),
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await
        .unwrap();
    let EpisodeStartResult::New(live_ep) = started_live.value else {
        panic!("expected new episode for live-project-bind-guard");
    };
    let shared_space_id = SpaceId::from_bytes([1; 16]);
    call_tool(
        &owner,
        27,
        "create_ability",
        json!({
            "kind": "role",
            "name": "other-space-bind-role",
            "description": "Role confined to shared Space",
            "instructions": "# Shared Space Role\n",
            "placement": {"home": "space", "space": shared_space_id.as_str()},
        }),
    )
    .await
    .unwrap();
    call_tool(
        &owner,
        28,
        "create_ability",
        json!({
            "kind": "role",
            "name": "same-project-bind-role",
            "description": "Role confined to preserved project",
            "instructions": "# Same Project Role\n",
            "placement": {"home": "project", "project": renamed_proj_handle},
        }),
    )
    .await
    .unwrap();
    let other_space_role = match fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: "other-space-bind-role".into(),
                kind: AbilityKind::Role,
                project: None,
            },
        )
        .await
        .unwrap()
    {
        AbilityResolution::Resolved(desc) => desc.reference,
        other => panic!("expected other-space-bind-role, got {other:?}"),
    };
    let same_proj_role = match fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: "same-project-bind-role".into(),
                kind: AbilityKind::Role,
                project: Some(live_proj_ref.clone()),
            },
        )
        .await
        .unwrap()
    {
        AbilityResolution::Resolved(desc) => desc.reference,
        other => panic!("expected same-project-bind-role, got {other:?}"),
    };
    let cross_space_bind = fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6,
                    ]),
                    hash: ContentDigest::from_bytes([0xE4; 32]),
                },
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: ep_live_proj.clone(),
                    expected: live_ep.revision,
                    active_role: other_space_role,
                    project_hint: None,
                }),
            },
        )
        .await;
    assert!(
        matches!(
            cross_space_bind,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "BindRole with project_hint: None must reject cross-Space role against preserved project: {cross_space_bind:?}"
    );
    let same_proj_bind = fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7,
                    ]),
                    hash: ContentDigest::from_bytes([0xE4; 32]),
                },
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: ep_live_proj.clone(),
                    expected: live_ep.revision,
                    active_role: same_proj_role.clone(),
                    project_hint: None,
                }),
            },
        )
        .await
        .expect(
            "BindRole with project_hint: None must accept OwnedProject role for preserved project",
        );
    assert_eq!(
        same_proj_bind.value.project_hint,
        Some(live_proj_ref.clone())
    );
    assert_eq!(
        same_proj_bind.value.active_role,
        Some(same_proj_role.clone())
    );
    let explicit_proj_bind = fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8,
                    ]),
                    hash: ContentDigest::from_bytes([0xE5; 32]),
                },
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: ep_live_proj.clone(),
                    expected: same_proj_bind.value.revision,
                    active_role: same_proj_role.clone(),
                    project_hint: Some(live_proj_ref.clone()),
                }),
            },
        )
        .await
        .expect("BindRole with explicit project_hint must accept matching OwnedProject role");
    assert_eq!(
        explicit_proj_bind.value.project_hint,
        Some(live_proj_ref.clone())
    );
    assert_eq!(
        explicit_proj_bind.value.active_role,
        Some(same_proj_role.clone())
    );

    let conflicted = call_tool(
        &owner,
        19,
        "rename_folder",
        json!({"folder": "secret-folder-name-rel", "name": "docs-rel"}),
    )
    .await;
    assert!(matches!(
        conflicted,
        Err(PortError::Domain(DomainError::PathConflict { .. }))
    ));
    let leaked_rows = fixture
        .storage
        .observer
        .count(
            "SELECT COUNT(*) FROM mcp_dedup \
             WHERE safe_result LIKE '%secret-folder-name-rel%' \
                OR safe_result LIKE '%secret-proj-slug-rel%' \
                OR safe_result LIKE '%Secret Display Name Rel%' \
                OR safe_result LIKE '%Updated Display Later%' \
                OR safe_result LIKE '%docs-rel%'",
        )
        .await;
    assert_eq!(
        leaked_rows, 0,
        "mcp_dedup.safe_result must stay content-free for folder/project renames"
    );

    // Replaying an already-committed BindRole { project_hint: None } with an OwnedProject
    // role must still replay the committed receipt after the preserved project is trashed.
    let trashed_live_proj = fixture
        .canonical
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE folder_heads SET lifecycle_state='trashed' WHERE space_id='{}' AND folder_id='{}'",
            personal.scope().space_id.as_str(),
            target_proj.as_str(),
        ))
        .await
        .unwrap();
    assert_eq!(trashed_live_proj, 1);
    let replayed_bind = fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7,
                    ]),
                    hash: ContentDigest::from_bytes([0xE4; 32]),
                },
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: ep_live_proj.clone(),
                    expected: live_ep.revision,
                    active_role: same_proj_role.clone(),
                    project_hint: None,
                }),
            },
        )
        .await
        .expect("replaying committed BindRole after project trash must return original receipt");
    assert_eq!(replayed_bind.revision, same_proj_bind.revision);
    assert_eq!(replayed_bind.value.id, ep_live_proj);
    assert!(
        replayed_bind
            .value
            .diagnostics
            .contains(&EpisodeDiagnostic::ProjectUnavailable),
        "replayed BindRole projection after project trash must report ProjectUnavailable"
    );
    let replayed_explicit = fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: ControlRevision::ZERO,
                    key: CommandKey::from_bytes([
                        0xE4, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8,
                    ]),
                    hash: ContentDigest::from_bytes([0xE5; 32]),
                },
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: ep_live_proj.clone(),
                    expected: same_proj_bind.value.revision,
                    active_role: same_proj_role,
                    project_hint: Some(live_proj_ref),
                }),
            },
        )
        .await
        .expect(
            "replaying committed BindRole with explicit project_hint after trash must return original receipt",
        );
    assert_eq!(replayed_explicit.revision, explicit_proj_bind.revision);
    assert_eq!(replayed_explicit.value.id, ep_live_proj);
    assert!(
        replayed_explicit
            .value
            .diagnostics
            .contains(&EpisodeDiagnostic::ProjectUnavailable),
        "replayed explicit BindRole projection after project trash must report ProjectUnavailable"
    );
}

async fn role_cursor_and_schema_regressions(fixture: &RuntimeFixture, personal: &SpaceContext) {
    let owner = AccountContext::new(
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
    let actor = owner.auth().principal().clone();
    let call_tool = |account: &AccountContext, seq: u8, tool: &str, args: Value| {
        let mut key = [0xE4; 16];
        key[15] = seq;
        let registry = fixture.registry.clone();
        let account = account.clone();
        let tool = tool.to_owned();
        async move {
            registry
                .call_tool(
                    McpInvocationContext {
                        account,
                        target: EgressTarget::ExternalMcp,
                        request_key: CommandKey::from_bytes(key),
                    },
                    &tool,
                    args,
                )
                .await
        }
    };

    // 3. Large role bound via use_role(budgetTokens=8000) must reopen cleanly in start_session.
    let big_body = format!("# Big Role\n\n{}", "R".repeat(5_000));
    call_tool(
        &owner,
        20,
        "create_ability",
        json!({
            "kind": "role",
            "name": "large-bound-role",
            "description": "Large role body",
            "instructions": big_body,
            "placement": {"home": "personal"},
        }),
    )
    .await
    .unwrap();
    let large_ep_started = call_tool(
        &owner,
        21,
        "start_session",
        json!({"task": "big-role-reopen"}),
    )
    .await
    .unwrap();
    let large_ep = large_ep_started.structured_content["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call_tool(
        &owner,
        22,
        "use_role",
        json!({"name": "large-bound-role", "budgetTokens": 8000, "session": large_ep}),
    )
    .await
    .unwrap();
    let reopened = call_tool(
        &owner,
        23,
        "start_session",
        json!({"session": {"id": large_ep}}),
    )
    .await
    .expect("start_session must reopen episode with 5000B role bound via budgetTokens=8000");
    assert_eq!(
        reopened.structured_content["activeRole"]["name"],
        "large-bound-role"
    );
    assert!(
        reopened.structured_content["activeRole"]["instructions"]
            .as_str()
            .unwrap()
            .len()
            >= 5_000
    );
    assert!(reopened.structured_content.get("delta").is_some());

    // 4. list_abilities cursor:
    //    (a) opaque server-side token ("ac1:<32-hex>") hides unconsented Space IDs from providers;
    //    (b) cursor is bound to caller actor/egress target (cannot be reused across targets);
    //    (c) unrelated chat writes in the same Space do NOT invalidate ability pagination;
    //    (d) actual ability mutations DO invalidate the cursor with CursorStale.
    call_tool(
        &owner,
        1,
        "create_ability",
        json!({
            "kind": "skill",
            "name": "cursor-skill-alpha",
            "description": "Cursor skill A",
            "instructions": "# Cursor A\n",
            "placement": {"home": "personal"},
        }),
    )
    .await
    .unwrap();
    let page1 = call_tool(
        &owner,
        2,
        "list_abilities",
        json!({"view": "authoring", "limit": 1}),
    )
    .await
    .unwrap();
    let cursor1 = page1.structured_content["nextCursor"]
        .as_str()
        .expect("owned abilities page 1 must emit continuation")
        .to_owned();
    assert!(
        cursor1.starts_with("ac1:")
            && cursor1.len() == 36
            && cursor1[4..]
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "ability cursor must be an opaque lowercase hex token, got {cursor1:?}"
    );
    assert!(
        !cursor1.contains(personal.scope().space_id.as_str()),
        "ability cursor must not expose SpaceId"
    );

    // Deterministically reject uppercase/non-canonical hex token.
    let upper_cursor = format!("ac1:A{}", &cursor1[5..]);
    let bad_hex = call_tool(
        &owner,
        26,
        "list_abilities",
        json!({"view": "authoring", "limit": 1, "cursor": upper_cursor}),
    )
    .await
    .map(|_| ());
    assert!(
        matches!(
            bad_hex,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == notarium_core::error::ValidationReason::InvalidId
        ),
        "uppercase hex cursor must fail with InvalidId: {bad_hex:?}"
    );

    // Verify unconsented InAppProvider receives only an opaque token, never SpaceId,
    // even when the underlying catalog continuation points into an unconsented Space, and
    // verify cursor scope binding on the SAME ToolRegistry instance in both directions.
    let unconsented_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unconsented = loopback_provider(fixture, &owner, &unconsented_listener, 195, true).await;
    let same_reg_ext_page = unconsented
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10,
                ]),
            },
            "list_abilities",
            json!({"view": "authoring", "limit": 1}),
        )
        .await
        .unwrap();
    let same_reg_ext_cursor = same_reg_ext_page.structured_content["nextCursor"]
        .as_str()
        .expect("ExternalMcp page on unconsented.registry must emit cursor")
        .to_owned();
    // Confirm the cursor is live in `unconsented.registry.ability_cursors` under ExternalMcp.
    let same_reg_ext_next = unconsented
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11,
                ]),
            },
            "list_abilities",
            json!({"view": "authoring", "limit": 1, "cursor": same_reg_ext_cursor}),
        )
        .await
        .expect("cursor must redeem on the same registry under the same ExternalMcp target");
    assert_eq!(
        same_reg_ext_next.structured_content["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let unconsented_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([195; 16]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let cross_target = unconsented
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(unconsented_run_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: unconsented.resource.id.clone(),
                    model: unconsented.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9,
                ]),
            },
            "list_abilities",
            json!({"view": "authoring", "limit": 1, "cursor": same_reg_ext_cursor}),
        )
        .await
        .map(|_| ());
    assert!(
        matches!(
            cross_target,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == notarium_core::error::ValidationReason::CursorStale
        ),
        "ability cursor minted for ExternalMcp must be rejected by InAppProvider on same registry: {cross_target:?}"
    );
    let provider_page = unconsented
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(unconsented_run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: unconsented.resource.id.clone(),
                    model: unconsented.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                ]),
            },
            "list_abilities",
            json!({"view": "authoring", "limit": 1}),
        )
        .await
        .unwrap();
    assert!(
        provider_page.structured_content["items"]
            .as_array()
            .unwrap()
            .is_empty(),
        "unconsented Space abilities must be filtered from provider page"
    );
    let prov_cursor = provider_page.structured_content["nextCursor"]
        .as_str()
        .expect("authoring page over unconsented owned abilities must emit continuation");
    assert!(
        prov_cursor.starts_with("ac1:")
            && prov_cursor.len() == 36
            && prov_cursor[4..]
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "provider ability cursor must stay opaque: {prov_cursor:?}"
    );
    assert!(
        !prov_cursor.contains(personal.scope().space_id.as_str()),
        "provider ability cursor must not leak unconsented SpaceId"
    );
    let reverse_cross_target = unconsented
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12,
                ]),
            },
            "list_abilities",
            json!({"view": "authoring", "limit": 1, "cursor": prov_cursor}),
        )
        .await
        .map(|_| ());
    assert!(
        matches!(
            reverse_cross_target,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == notarium_core::error::ValidationReason::CursorStale
        ),
        "ability cursor minted for InAppProvider must be rejected by ExternalMcp on same registry: {reverse_cross_target:?}"
    );

    // Write a chat message in the same Space (advances space.last_seq) and confirm cursor1 still works.
    let seq_before_chat = fixture
        .canonical
        .read_space(&personal.scope().space_id)
        .await
        .unwrap()
        .last_seq;
    let chat_thread = ChatThreadId::from_bytes([0xE4; 16]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: personal.scope().clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                    ]),
                    hash: ContentDigest::from_bytes([0xE4; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: chat_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Pagination survival chat".into(),
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .submit_user_chat_input(
            personal.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: personal.scope().clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
                    ]),
                    hash: ContentDigest::from_bytes([0xE5; 32]),
                },
                id: PendingInputId::from_bytes([0xE5; 16]),
                thread: chat_thread,
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Chat write advancing space.last_seq".into(),
                mentions_agent: false,
            },
        )
        .await
        .unwrap();
    let seq_after_chat = fixture
        .canonical
        .read_space(&personal.scope().space_id)
        .await
        .unwrap()
        .last_seq;
    assert!(seq_after_chat > seq_before_chat);

    let page2 = call_tool(
        &owner,
        6,
        "list_abilities",
        json!({"view": "authoring", "limit": 1, "cursor": cursor1}),
    )
    .await
    .expect("chat write in same Space must not invalidate list_abilities cursor");
    assert_eq!(
        page2.structured_content["items"].as_array().unwrap().len(),
        1
    );
    assert_ne!(
        page2.structured_content["items"][0]["ref"],
        page1.structured_content["items"][0]["ref"]
    );

    // An actual ability mutation in the Space must invalidate cursor1 with CursorStale.
    call_tool(
        &owner,
        7,
        "create_ability",
        json!({
            "kind": "skill",
            "name": "cursor-skill-beta",
            "description": "Invalidates cursor",
            "instructions": "# Cursor B\n",
            "placement": {"home": "personal"},
        }),
    )
    .await
    .unwrap();
    let stale_after_ability = call_tool(
        &owner,
        8,
        "list_abilities",
        json!({"view": "authoring", "limit": 1, "cursor": cursor1}),
    )
    .await
    .map(|_| ());
    assert!(
        matches!(
            stale_after_ability,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == notarium_core::error::ValidationReason::CursorStale
        ),
        "ability mutation must invalidate ability cursor with CursorStale: {stale_after_ability:?}"
    );

    // 5. Provider tool schemas preserve integer bounds and const boolean constraints.
    let provider_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([196; 16]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let tools = fixture.registry.provider_tools(&provider_run_auth);
    let list_notes_tool = tools
        .iter()
        .find(|t| t.name == "list_notes")
        .expect("list_notes published");
    let ProviderToolSchema::Object { properties, .. } = &list_notes_tool.parameters else {
        panic!("list_notes parameters must be an object");
    };
    assert!(
        matches!(
            properties.get("limit"),
            Some(ProviderToolSchema::Integer {
                minimum: Some(1),
                maximum: Some(100),
            })
        ),
        "list_notes.limit must publish integer bounds 1..=100"
    );
    let create_note_tool = tools
        .iter()
        .find(|t| t.name == "create_note")
        .expect("create_note published");
    let ProviderToolSchema::Object { properties, .. } = &create_note_tool.parameters else {
        panic!("create_note parameters must be an object");
    };
    assert!(
        matches!(
            properties.get("folderPage"),
            Some(ProviderToolSchema::ConstBool(true))
        ),
        "create_note.folderPage must publish const true"
    );
}
