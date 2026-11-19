use std::time::Duration;

use notarium_agents::chats::{AgentRunSupervisor, ChatRunOptions, ExclusiveDataRoot};
use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    auth::{ChatAudience, SpaceKind},
    classes::{DocClass, ProviderOrigin},
    model::{FolderRef, NoteRef},
};
use tokio::{
    net::TcpListener,
    time::{sleep, timeout},
};

use super::{
    runtime_ability_cases::{
        approve_disclosure, identity, loopback_provider, read_request, send_ollama,
    },
    *,
};

pub(super) async fn relocated_empty_folder_blocks_old_and_compacted_history(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fixture.human.auth().principal().clone();
    let shared = fixture
        .control
        .create_space(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 162).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([162; 16]),
                    kind: SpaceKind::Shared,
                    name: "Folder egress fixture".into(),
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
    let p = FolderRef {
        space_id: shared.history.space_id.clone(),
        folder_id: FolderId::from_bytes([162; 16]),
    };
    let q = FolderId::from_bytes([163; 16]);
    let folder = FolderRef {
        space_id: p.space_id.clone(),
        folder_id: FolderId::from_bytes([164; 16]),
    };
    for (id, parent, slug) in [
        (p.folder_id.clone(), None, "first"),
        (q.clone(), None, "second"),
        (
            folder.folder_id.clone(),
            Some(p.folder_id.clone()),
            "empty-before-move",
        ),
    ] {
        let is_project = parent.is_none();
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: shared.history.clone(),
                active_epoch: storage.active_epoch,
                folder_id: id,
                parent,
                slug: slug.into(),
                display_name: slug.into(),
                is_project,
                project_slug: is_project.then(|| slug.to_owned()),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    fixture.projections.install(engine::ProjectionFixture {
        view_owner: NoteRef {
            space_id: shared.history.space_id.clone(),
            note_id: NoteId::from_bytes([162; 16]),
        },
        notes: vec![],
    });

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &human, &listener, 163, true).await;
    let personal_ctx =
        SpaceContext::new(human.auth().clone(), personal.scope().clone(), budget()).unwrap();
    for (tag, target) in [
        (
            165,
            ProviderAttachmentTarget::Personal {
                owner: owner.clone(),
                space: personal.scope().space_id.clone(),
            },
        ),
        (
            166,
            ProviderAttachmentTarget::Personal {
                owner: owner.clone(),
                space: p.space_id.clone(),
            },
        ),
        (167, ProviderAttachmentTarget::Project(p.clone())),
    ] {
        approve_disclosure(
            fixture,
            &human,
            &local,
            tag,
            target,
            [DocClass::UserDoc].into(),
        )
        .await;
    }
    let supervisor = AgentRunSupervisor::new_local(
        local.registry,
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id),
        model: Some(local.model),
        ..ChatRunOptions::default()
    };
    let thread = ChatThreadId::from_bytes([162; 16]);
    let identity = |tag| CommandIdentity {
        scope: personal.scope().clone(),
        actor: owner.clone(),
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    };
    fixture
        .canonical
        .create_chat(
            personal_ctx.clone(),
            Mutation {
                identity: identity(162),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Folder disclosure history".into(),
                },
            },
        )
        .await
        .unwrap();
    let input = |tag, leaf, body: &str| SubmitUserChatInput {
        identity: identity(tag),
        thread: thread.clone(),
        id: PendingInputId::from_bytes([tag; 16]),
        expected_leaf: leaf,
        body: body.into(),
        mentions_agent: false,
    };
    let submission = supervisor
        .enqueue_input(
            human.clone(),
            input(163, ThreadEntrySeq::ZERO, "List the project's folders."),
            options.clone(),
        )
        .await
        .unwrap();
    assert!(submission.run.is_some());
    let (mut socket, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    send_ollama(
        &mut socket,
        json!({"role":"assistant","tool_calls":[{"function":{
            "index":0,"name":"list_notes","arguments":{"project":format!("{}/first",shared.slug)}
        }}]}),
        "tool_calls",
    )
    .await;
    drop(socket);
    let (mut socket, wire) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    let tool = wire["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["role"] == "tool")
        .unwrap();
    assert!(
        tool["content"]
            .as_str()
            .unwrap()
            .contains("empty-before-move")
    );
    send_ollama(
        &mut socket,
        json!({"role":"assistant","content":"I found the empty folder."}),
        "stop",
    )
    .await;
    drop(socket);
    let head = wait_idle(fixture, &personal_ctx, &thread).await;
    let transcript_auth = fixture
        .control
        .trusted_none(PerimeterAttestation::attest_checked(), budget())
        .await
        .unwrap();
    let transcript =
        SpaceContext::new(transcript_auth, personal.scope().clone(), budget()).unwrap();
    let history = fixture
        .canonical
        .read_chat(
            transcript.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: head,
                before: None,
                max_entries: PageLimit::new(16).unwrap(),
            },
        )
        .await
        .unwrap();
    let tool = history
        .entries
        .iter()
        .find(|entry| matches!(entry.kind, ChatEntryKind::Tool { .. }))
        .unwrap();
    let saved = fixture
        .canonical
        .read_chat_contents(
            transcript,
            ChatContentRead {
                thread: thread.clone(),
                leaf: head,
                entries: vec![tool.seq],
            },
        )
        .await
        .unwrap();
    assert!(saved[0].content.provenance().unwrap().origins.iter().any(
        |origin| matches!(origin, ProviderOrigin::Folder { reference, .. } if reference == &folder)
    ));
    let shared_ctx = SpaceContext::new(human.auth().clone(), shared.history, budget()).unwrap();
    fixture
        .canonical
        .move_folder(
            shared_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared_ctx.scope().clone(),
                    ..identity(165)
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: folder.folder_id.clone(),
                    new_parent: Some(q.clone()),
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .canonical
            .resolve_folder_path(shared_ctx, Some(q), "empty-before-move".into())
            .await
            .unwrap()
            .unwrap()
            .reference,
        folder
    );

    let denied = supervisor
        .enqueue_input(
            human.clone(),
            input(166, head, "What was the folder?"),
            options.clone(),
        )
        .await
        .unwrap();
    let SubmitUserChatOutcome::Appended(uncompacted) = denied.outcome else {
        panic!("expected a canonical human entry")
    };
    assert!(denied.run.is_some());
    assert_eq!(
        wait_idle(fixture, &personal_ctx, &thread).await,
        uncompacted.value.seq
    );
    assert!(
        timeout(Duration::from_millis(300), listener.accept())
            .await
            .is_err()
    );

    // Persist a canonical compaction covering the real Model→Tool→Folder chain.
    let summary_run = AgentRunId::from_bytes([162; 16]);
    let context = SpaceContext::new(
        human
            .auth()
            .for_agent_run(
                summary_run.clone(),
                personal.scope().space_id.clone(),
                ChatAudience::Personal,
                human.auth().spaces().clone(),
            )
            .unwrap(),
        personal.scope().clone(),
        budget(),
    )
    .unwrap();
    assert_eq!(
        fixture
            .canonical
            .claim_active_run(
                context.clone(),
                ClaimChatRun {
                    thread: thread.clone(),
                    run: summary_run.clone(),
                    expected_leaf: uncompacted.value.seq,
                    previous_run: None
                }
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    );
    let old_model = fixture
        .canonical
        .read_chat_contents(
            context.clone(),
            ChatContentRead {
                thread: thread.clone(),
                leaf: uncompacted.value.seq,
                entries: vec![head],
            },
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    let summary = fixture
        .canonical
        .append_chat(
            context.clone(),
            Mutation {
                identity: identity(164),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: uncompacted.value.seq,
                    kind: ChatEntryKind::Compaction,
                    body: ChatInputBody::Text("Earlier folder listing.".into()),
                    tool_calls: vec![],
                    provenance: Some(ChatProvenance {
                        origins: vec![old_model.content.origin()],
                        projects: vec![],
                        compacts_through: None,
                    }),
                    proposed_diff: None,
                    referenced_notes: vec![],
                    tainted: context.auth().taint().is_tainted(),
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .finish_run_if_queue_empty(
            context,
            ChatRunRequest {
                thread: thread.clone(),
                expected_run: summary_run,
            },
        )
        .await
        .unwrap();

    let denied = supervisor
        .enqueue_input(
            human.clone(),
            input(167, summary.value.seq, "What did the summary say?"),
            options,
        )
        .await
        .unwrap();
    let SubmitUserChatOutcome::Appended(entry) = denied.outcome else {
        panic!("expected a canonical human entry")
    };
    assert!(denied.run.is_some());
    assert_eq!(
        wait_idle(fixture, &personal_ctx, &thread).await,
        entry.value.seq
    );
    assert!(
        timeout(Duration::from_millis(300), listener.accept())
            .await
            .is_err()
    );
    supervisor.shutdown();
}

async fn wait_idle(
    fixture: &RuntimeFixture,
    ctx: &SpaceContext,
    thread: &ChatThreadId,
) -> ThreadEntrySeq {
    timeout(Duration::from_secs(15), async {
        loop {
            let state = fixture
                .canonical
                .read_chat_context(
                    ctx.clone(),
                    ChatRead {
                        thread: thread.clone(),
                        leaf: ThreadEntrySeq::ZERO,
                        before: None,
                        max_entries: PageLimit::new(1).unwrap(),
                    },
                )
                .await
                .unwrap()
                .thread;
            if state.active_run.is_none() {
                return state.head;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
