use super::{runtime_ability_cases as wire, *};
use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    auth::{ChatAudience, SpaceKind},
    classes::{CanonicalChatContent, ClassEgressFence, DocClass, ProviderMessage, ProviderOrigin},
    error::ValidationReason,
    receipt::ReceiptSet,
};
use std::time::Duration;
use tokio::{net::TcpListener, time::timeout};

const TEXT: &str = "# Project note\n\nAn exact canonical carrier.\n";
const WIRE_DEADLINE: Duration = Duration::from_secs(15);

#[tokio::test]
async fn sqlite_provider_rejects_note_carried_from_old_project() {
    exercise(false).await;
}

#[tokio::test]
async fn postgres_provider_rejects_note_carried_from_old_project() {
    exercise(true).await;
}

async fn exercise(pg: bool) {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    let fixture = RuntimeFixture::open_named(pg, "moved_note_wire").await;
    Box::pin(moved_note_history(&fixture)).await;
    fixture.close().await;
}

async fn moved_note_history(fixture: &RuntimeFixture) {
    let canonical = &fixture.canonical;
    let shared = fixture
        .control
        .create_space(
            fixture.human.clone(),
            AccountMutation {
                identity: wire::identity(fixture, &fixture.human, 18).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([18; 16]),
                    kind: SpaceKind::Shared,
                    name: "Moved note proof".into(),
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
                PerimeterAttestation::attest_checked().with_human_management(),
                budget(),
            )
            .await
            .unwrap(),
        budget(),
    );
    let scope = SpaceContext::new(human.auth().clone(), shared.history, budget()).unwrap();
    let space = &scope.scope().space_id;
    let actor = human.auth().principal();
    let project_a = FolderId::from_bytes([18; 16]);
    let project_b = FolderId::from_bytes([19; 16]);
    let folder = FolderId::from_bytes([20; 16]);
    let note = NoteId::from_bytes([18; 16]);
    let active_epoch = canonical.read_space(space).await.unwrap().active_epoch;
    for (folder_id, parent, slug) in [
        (project_a.clone(), None, "first"),
        (project_b.clone(), None, "second"),
        (folder.clone(), Some(project_a.clone()), "relocated"),
    ] {
        let is_project = parent.is_none();
        canonical
            .create_folder(CreateFolderSpec {
                scope: scope.scope().clone(),
                active_epoch,
                folder_id,
                parent,
                slug: slug.into(),
                display_name: slug.into(),
                is_project,
                project_slug: is_project.then(|| slug.into()),
                actor: actor.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    canonical
        .create_note(
            scope.clone(),
            mutation(
                &scope,
                18,
                CreateNote {
                    note: note.clone(),
                    parent: Some(folder.clone()),
                    slug: "disclosure".into(),
                    class: DocClass::UserDoc,
                    carrier: TEXT.into(),
                    folder_page: false,
                },
            ),
        )
        .await
        .unwrap();

    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = wire::loopback_provider(fixture, &human, &socket, 20, false).await;
    for (tag, target) in [
        (
            22,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: space.clone(),
            },
        ),
        (23, ProviderAttachmentTarget::Space(space.clone())),
    ] {
        wire::approve_disclosure(
            fixture,
            &human,
            &local,
            tag,
            target,
            [DocClass::UserDoc].into(),
        )
        .await;
    }
    let selected = local
        .provider
        .select_provider(
            scope.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    assert!(selected.project_only.is_none());
    let get = GetNote {
        note,
        revision: None,
        causal: CausalBasis::Exact(ReceiptSet::default()),
    };
    let first = canonical
        .get_note(scope.clone(), get.clone())
        .await
        .unwrap();
    assert_eq!(first.provenance.as_ref().unwrap().project, Some(project_a));
    let first_origin = first.document.origin();
    let classified = |note: NoteSnapshot| {
        ProviderMessage::Document(
            ClassEgressFence::provider(note.document, scope.auth(), &selected.policy).unwrap(),
        )
    };
    let original = classified(first);
    send(
        &local.provider,
        &scope,
        &selected,
        &socket,
        21,
        original.clone(),
        TEXT,
    )
    .await;

    let (previous_model, summary) = persist_summary(canonical, &scope, first_origin.clone()).await;
    let classified_chat = |content| {
        ProviderMessage::Chat(
            ClassEgressFence::chat(content, scope.auth(), &selected.policy).unwrap(),
        )
    };
    let history = classified_chat(summary);
    send(
        &local.provider,
        &scope,
        &selected,
        &socket,
        22,
        history.clone(),
        "Prior note summary.",
    )
    .await;

    // Legacy chat proofs still decode and keep their original serialized identity.
    let mut legacy = serde_json::to_value(first_origin.clone()).unwrap();
    legacy["Note"]
        .as_object_mut()
        .unwrap()
        .remove("placement")
        .unwrap();
    let legacy_origin: ProviderOrigin = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&legacy_origin).unwrap(), legacy);
    let (_, summary) = persist_summary(canonical, &scope, legacy_origin).await;
    refuse(
        &local.provider,
        &scope,
        &selected,
        23,
        classified_chat(summary),
    )
    .await;

    canonical
        .move_folder(
            scope.clone(),
            mutation(
                &scope,
                19,
                MoveFolder {
                    folder,
                    new_parent: Some(project_b.clone()),
                },
            ),
        )
        .await
        .unwrap();
    refuse(&local.provider, &scope, &selected, 24, original).await;
    refuse(
        &local.provider,
        &scope,
        &selected,
        25,
        classified_chat(previous_model),
    )
    .await;
    refuse(&local.provider, &scope, &selected, 26, history).await;
    assert!(
        timeout(Duration::from_millis(300), socket.accept())
            .await
            .is_err()
    );

    let fresh = canonical.get_note(scope.clone(), get).await.unwrap();
    assert_eq!(fresh.provenance.as_ref().unwrap().project, Some(project_b));
    assert!(matches!(
        (&first_origin, fresh.document.origin()),
        (ProviderOrigin::Note { revision: before, digest: old_digest, .. },
         ProviderOrigin::Note { revision: after, digest: new_digest, .. })
            if before == &after && old_digest == &new_digest
    ));
    assert_ne!(first_origin, fresh.document.origin());
    send(
        &local.provider,
        &scope,
        &selected,
        &socket,
        27,
        classified(fresh),
        TEXT,
    )
    .await;
}

fn mutation<T>(scope: &SpaceContext, tag: u8, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: scope.scope().clone(),
            actor: scope.auth().principal().clone(),
            key: CommandKey::from_bytes([tag; 16]),
            hash: ContentDigest::from_bytes([tag; 32]),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

async fn persist_summary(
    canonical: &CanonicalStore,
    scope: &SpaceContext,
    origin: ProviderOrigin,
) -> (CanonicalChatContent, CanonicalChatContent) {
    let legacy = matches!(
        origin,
        ProviderOrigin::Note {
            placement: None,
            ..
        }
    );
    let tag = if legacy { 33 } else { 30 };
    let thread = ChatThreadId::from_bytes([tag; 16]);
    let run = AgentRunId::from_bytes([tag; 16]);
    canonical
        .create_chat(
            scope.clone(),
            mutation(
                scope,
                tag,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: scope.auth().principal().clone(),
                    title: "Note disclosure history".into(),
                    project_folder: None,
                },
            ),
        )
        .await
        .unwrap();
    let agent = SpaceContext::new(
        scope
            .auth()
            .for_agent_run(
                run.clone(),
                scope.scope().space_id.clone(),
                ChatAudience::Shared,
                scope.auth().spaces().clone(),
            )
            .unwrap(),
        scope.scope().clone(),
        budget(),
    )
    .unwrap();
    assert_eq!(
        canonical
            .claim_active_run(
                agent.clone(),
                ClaimChatRun {
                    thread: thread.clone(),
                    run: run.clone(),
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None
                },
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed,
    );
    let append = |parent, kind, text: &str, origin| AppendChat {
        thread: thread.clone(),
        parent,
        kind,
        body: ChatInputBody::Text(text.into()),
        tool_calls: vec![],
        provenance: Some(ChatProvenance {
            origins: vec![origin],
            ..Default::default()
        }),
        interruption: None,
        proposed_diff: None,
        referenced_notes: vec![],
        tainted: false,
    };
    let model = canonical
        .append_chat(
            agent.clone(),
            mutation(
                &agent,
                tag + 1,
                append(
                    ThreadEntrySeq::ZERO,
                    ChatEntryKind::Model,
                    "I read the note.",
                    origin,
                ),
            ),
        )
        .await
        .unwrap()
        .value;
    let read = async |seq| {
        canonical
            .read_chat_contents(
                agent.clone(),
                ChatContentRead {
                    thread: thread.clone(),
                    leaf: seq,
                    entries: vec![seq],
                },
            )
            .await
            .unwrap()
            .pop()
            .unwrap()
            .content
    };
    let model = read(model.seq).await;
    let summary = canonical
        .append_chat(
            agent.clone(),
            mutation(
                &agent,
                tag + 2,
                append(
                    model.entry,
                    ChatEntryKind::Compaction,
                    "Prior note summary.",
                    model.origin(),
                ),
            ),
        )
        .await
        .unwrap()
        .value;
    let summary = read(summary.seq).await;
    canonical
        .finish_run_if_queue_empty(
            agent,
            ChatRunRequest {
                thread,
                expected_run: run,
            },
        )
        .await
        .unwrap();
    (model, summary)
}

fn request(selected: &ProviderSelection, tag: u8, content: ProviderMessage) -> CompletionRequest {
    CompletionRequest {
        intent: CommandKey::from_bytes([tag; 16]),
        selection: selected.clone(),
        secondary_projects: vec![],
        messages: vec![CompletionMessage {
            role: CompletionRole::User,
            instruction: None,
            parts: vec![content],
            tool_calls: vec![],
            result_for: None,
        }],
        tools: vec![],
        budget: CompletionBudget {
            max_input_tokens: 4096,
            max_output_tokens: 256,
            max_tool_calls: 0,
        },
    }
}

async fn send(
    provider: &ProviderService,
    scope: &SpaceContext,
    selected: &ProviderSelection,
    socket: &TcpListener,
    tag: u8,
    content: ProviderMessage,
    expected: &str,
) {
    let wire = async {
        let (mut peer, request) = timeout(WIRE_DEADLINE, wire::read_request(socket))
            .await
            .unwrap();
        assert_eq!(request["messages"][0]["content"], expected);
        wire::send_ollama(
            &mut peer,
            json!({"role":"assistant","content":"Verified"}),
            "stop",
        )
        .await;
    };
    let response = async {
        let mut stream = provider
            .complete(scope.clone(), request(selected, tag, content))
            .await
            .unwrap();
        let mut finished = false;
        while let Some(event) = stream.next().await.unwrap() {
            finished |= matches!(event, CompletionEvent::Finished(CompletionFinish::Stop));
        }
        assert!(finished);
    };
    tokio::join!(wire, response);
}

async fn refuse(
    provider: &ProviderService,
    scope: &SpaceContext,
    selected: &ProviderSelection,
    tag: u8,
    content: ProviderMessage,
) {
    let mut stream = provider
        .complete(scope.clone(), request(selected, tag, content))
        .await
        .unwrap();
    let error = stream
        .next()
        .await
        .expect_err("stale disclosure unexpectedly admitted");
    assert!(matches!(
        error,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::SourceMismatch
    ));
}
