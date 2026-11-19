use std::time::Duration;

use notarium_agents::chats::{
    AgentRunSupervisor, ChatRunOptions, ChatSubscription, ExclusiveDataRoot, StartChatRun,
    stream::StreamRead,
};
use notarium_core::{
    auth::SpaceKind,
    classes::{ClassEgressFence, DocClass},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::{sleep, timeout},
};

use super::{
    runtime_ability_cases::{approve_disclosure, loopback_provider, read_request, send_ollama},
    *,
};

#[tokio::test]
async fn sqlite_supervised_chat_conflicts_and_revocation() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(supervised_chat_case(false)).await;
}

#[tokio::test]
async fn postgres_supervised_chat_conflicts_and_revocation() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(supervised_chat_case(true)).await;
}

async fn supervised_chat_case(postgres: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(postgres, "supervised_chat")).await;
    let personal = fixture
        .control
        .list_spaces(
            fixture.human.clone(),
            ControlPageRequest::new(4, None).unwrap(),
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|access| access.space.kind == SpaceKind::Personal)
        .unwrap();
    let scoped =
        SpaceContext::new(fixture.human.auth().clone(), personal.history, budget()).unwrap();
    Box::pin(supervised_turn_survives_disconnect_and_stops_cleanly(
        &fixture, &scoped,
    ))
    .await;
    fixture.close().await;
}

async fn supervised_turn_survives_disconnect_and_stops_cleanly(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let thread = ChatThreadId::from_bytes([241; 16]);
    let actor = owner.auth().principal();
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
                identity: mutation(241),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Detached turn".into(),
                },
            },
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, owner, &listener, 241, true).await;
    approve_disclosure(
        fixture,
        owner,
        &local,
        243,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Profile].into(),
    )
    .await;
    let supervisor = AgentRunSupervisor::new_local(
        local.registry,
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id),
        model: Some(local.model),
        limits: RunLimits {
            max_steps: 4,
            max_tokens: 100_000,
            timeout_ms: 30_000,
        },
        ..ChatRunOptions::default()
    };
    let input = |tag, leaf, body: &str| SubmitUserChatInput {
        identity: mutation(tag),
        id: PendingInputId::from_bytes([tag; 16]),
        thread: thread.clone(),
        expected_leaf: leaf,
        body: body.into(),
        mentions_agent: false,
    };
    Box::pin(revoked_admission_cannot_publish(
        fixture,
        personal,
        &supervisor,
        &thread,
        options.clone(),
    ))
    .await;
    let first = supervisor
        .enqueue_input(
            owner.clone(),
            input(242, ThreadEntrySeq::ZERO, "Start a detached turn."),
            options.clone(),
        )
        .await
        .unwrap();
    let SubmitUserChatOutcome::Appended(human) = first.outcome else {
        panic!("expected immediate human append")
    };
    let run = first.run.unwrap();
    let (mut blocked, request) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    assert!(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["role"] == "user" && item["content"] == "Start a detached turn.")
    );
    let mut subscription = supervisor
        .subscribe(owner.clone(), scope.clone(), thread.clone(), None)
        .await
        .unwrap()
        .unwrap();
    let StreamRead::CatchUpRequired(checkpoint) = subscription.next().await else {
        panic!("expected initial checkpoint")
    };
    assert_eq!(checkpoint.cursor.run, run);
    drop(subscription);
    let mut retained = supervisor
        .subscribe(
            owner.clone(),
            scope.clone(),
            thread.clone(),
            Some(&checkpoint.cursor),
        )
        .await
        .unwrap()
        .unwrap();
    let replay = supervisor
        .enqueue_input(
            owner.clone(),
            input(242, ThreadEntrySeq::ZERO, "Start a detached turn."),
            options.clone(),
        )
        .await
        .unwrap();
    assert!(replay.run.is_none());
    assert!(
        matches!(replay.outcome, SubmitUserChatOutcome::Appended(saved) if saved.value.seq == human.value.seq)
    );
    assert_eq!(
        branch(fixture, personal, &thread, ThreadEntrySeq::ZERO)
            .await
            .thread
            .head,
        human.value.seq
    );
    send_ollama(
        &mut blocked,
        json!({"role":"assistant", "tool_calls":[{
            "function":{"index":0,"name":"whoami","arguments":{}}
        }]}),
        "tool_calls",
    )
    .await;
    drop(blocked);

    let (mut final_wire, request) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    let messages = request["messages"].as_array().unwrap();
    assert!(
        messages.iter().any(|item| item["role"] == "assistant"
            && item["tool_calls"][0]["function"]["name"] == "whoami")
    );
    assert!(messages.iter().any(|item| item["role"] == "tool"));
    let resumed = supervisor
        .subscribe(
            owner.clone(),
            scope.clone(),
            thread.clone(),
            Some(&checkpoint.cursor),
        )
        .await
        .unwrap()
        .unwrap();
    send_ollama(
        &mut final_wire,
        json!({"role":"assistant", "content":"The detached turn completed."}),
        "stop",
    )
    .await;
    drop(final_wire);
    let events = stream_events(resumed).await;
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "tool_call_result")
    );
    assert_eq!(events.last().unwrap()["type"], "run_finished");
    let head = idle_leaf(fixture, personal, &thread).await;
    let saved = branch(fixture, personal, &thread, head).await;
    let mut generated: Vec<_> = saved
        .entries
        .iter()
        .filter(|entry| entry.run.as_ref() == Some(&run))
        .collect();
    generated.sort_by_key(|entry| entry.seq);
    assert_eq!(generated.len(), 3);
    let ChatEntryKind::Tool { call_id } = &generated[1].kind else {
        panic!("expected committed Tool entry")
    };
    assert_eq!(generated[0].kind, ChatEntryKind::Model);
    assert_eq!(generated[2].kind, ChatEntryKind::Model);
    let hydrated = fixture
        .canonical
        .read_chat_contents(
            personal.clone(),
            ChatContentRead {
                thread: thread.clone(),
                leaf: head,
                entries: generated.iter().map(|entry| entry.seq).collect(),
            },
        )
        .await
        .unwrap();
    let model = hydrated
        .iter()
        .find(|item| item.seq == generated[0].seq)
        .unwrap();
    assert_eq!(model.tool_calls[0].id.as_str(), call_id.as_str());
    let answer = hydrated
        .iter()
        .find(|item| item.seq == generated[2].seq)
        .unwrap();
    assert_eq!(
        ClassEgressFence::chat_transcript(&answer.content, owner.auth()).unwrap(),
        "The detached turn completed."
    );

    let second = supervisor
        .enqueue_input(
            owner.clone(),
            input(243, head, "Stop without committing a model."),
            options.clone(),
        )
        .await
        .unwrap();
    let SubmitUserChatOutcome::Appended(human) = second.outcome else {
        panic!("expected a second human append")
    };
    let stopping = second.run.unwrap();
    let (mut blocked, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    let subscription = supervisor
        .subscribe(owner.clone(), scope.clone(), thread.clone(), None)
        .await
        .unwrap()
        .unwrap();
    supervisor
        .stop(owner.clone(), scope.clone(), thread.clone(), stopping)
        .await
        .unwrap();
    let events = stream_events(subscription).await;
    assert_eq!(events.last().unwrap()["type"], "run_failed");
    assert_eq!(events.last().unwrap()["code"], "cancelled");
    let mut pending = [0; 1];
    let closed = timeout(Duration::from_secs(5), blocked.read(&mut pending))
        .await
        .unwrap();
    assert!(closed.is_err() || closed.unwrap() == 0);
    assert_eq!(idle_leaf(fixture, personal, &thread).await, human.value.seq);
    Box::pin(queue_conflicts_and_lost_ack(
        fixture,
        personal,
        &supervisor,
        &listener,
        &thread,
        human.value.seq,
        options,
    ))
    .await;
    let current = branch(fixture, personal, &thread, ThreadEntrySeq::ZERO)
        .await
        .thread;
    supervisor
        .redact_chat_entry(
            owner.clone(),
            Mutation {
                identity: mutation(244),
                preconditions: Preconditions::default(),
                input: RedactChatEntry {
                    thread: thread.clone(),
                    entry: head,
                    expected_thread_revision: current.revision,
                },
            },
        )
        .await
        .unwrap();
    let StreamRead::CatchUpRequired(reset) = retained.next().await else {
        panic!("a retained viewer must refresh canonical history after redaction");
    };
    assert!(reset.cursor.byte_offset > checkpoint.cursor.byte_offset);
    assert!(matches!(retained.next().await, StreamRead::Closed));
    assert!(
        branch(fixture, personal, &thread, head)
            .await
            .entries
            .iter()
            .any(|entry| { entry.seq == head && matches!(entry.body, ChatBody::Redacted) })
    );
    supervisor.shutdown();
}

async fn queue_conflicts_and_lost_ack(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    supervisor: &AgentRunSupervisor,
    listener: &TcpListener,
    thread: &ChatThreadId,
    leaf: ThreadEntrySeq,
    options: ChatRunOptions,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let identity = |index| {
        let mut key = [0xf2; 16];
        key[0] = index;
        CommandIdentity {
            scope: scope.clone(),
            actor: owner.auth().principal().clone(),
            key: CommandKey::from_bytes(key),
            hash: ContentDigest::from_bytes(*blake3::hash(&key).as_bytes()),
        }
    };
    let run = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: scope.clone(),
                thread: thread.clone(),
                expected_leaf: leaf,
                options: options.clone(),
            },
        )
        .await
        .unwrap();
    let (mut wire, _) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .unwrap();
    wire.get_mut().write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n",
    ).await.unwrap();
    let mut observer = supervisor
        .subscribe(owner.clone(), scope.clone(), thread.clone(), None)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        observer.next().await,
        StreamRead::CatchUpRequired(_)
    ));
    let cancelled = PendingInputId::from_bytes([0x6e; 16]);
    let materialized = PendingInputId::from_bytes([0x6f; 16]);
    for (index, id, body) in [
        (1, cancelled.clone(), "Dismiss this item"),
        (2, materialized.clone(), "Deliver this item once"),
    ] {
        let accepted = supervisor
            .enqueue_input(
                owner.clone(),
                SubmitUserChatInput {
                    identity: identity(index),
                    id,
                    thread: thread.clone(),
                    expected_leaf: leaf,
                    body: body.into(),
                    mentions_agent: false,
                },
                options.clone(),
            )
            .await
            .unwrap();
        assert!(matches!(accepted.outcome, SubmitUserChatOutcome::Queued(_)));
    }

    fixture.projections.trace_chat_consume_with_lost_ack();
    let (first, resume_first) = fixture.projections.pause_chat_consume();
    supervisor
        .stop(owner.clone(), scope.clone(), thread.clone(), run.clone())
        .await
        .unwrap();
    timeout(Duration::from_secs(15), first)
        .await
        .unwrap()
        .unwrap();
    assert!(
        fixture
            .canonical
            .dismiss_chat_input(
                personal.clone(),
                DismissPending {
                    thread: thread.clone(),
                    input: cancelled.clone(),
                }
            )
            .await
            .unwrap()
    );
    let (second, resume_second) = fixture.projections.pause_chat_consume();
    resume_first.send(()).unwrap();
    timeout(Duration::from_secs(15), second)
        .await
        .unwrap()
        .unwrap();

    let peer = fixture
        .canonical
        .append_chat(
            personal.clone(),
            Mutation {
                identity: identity(3),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: leaf,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("A concurrent post".into()),
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    resume_second.send(()).unwrap();

    let (mut successor, prompt) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .unwrap();
    assert_eq!(
        prompt["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                item["role"] == "user" && item["content"] == "Deliver this item once"
            })
            .count(),
        1
    );
    send_ollama(
        &mut successor,
        json!({"role":"assistant","content":"One successor turn."}),
        "stop",
    )
    .await;
    let StreamRead::CatchUpRequired(watermark) = timeout(Duration::from_secs(15), observer.next())
        .await
        .unwrap()
    else {
        panic!("the missed peer and restored consume receipt require a fresh checkpoint");
    };
    let attempts = fixture.projections.chat_consume_attempts();
    assert_eq!(attempts.len(), 4);
    assert_eq!(attempts[0].input.input, cancelled);
    assert_eq!(attempts[1].input.input, materialized);
    assert_eq!(attempts[1].input.current_leaf, leaf);
    assert_eq!(attempts[2].identity, attempts[3].identity);
    assert_eq!(attempts[2].identity.actor, *owner.auth().principal());
    for attempt in &attempts[2..] {
        assert_eq!(attempt.input.input, materialized);
        assert_eq!(attempt.input.current_leaf, peer.seq);
        assert_eq!(attempt.input.expected_active_run, run);
    }
    let head = idle_leaf(fixture, personal, thread).await;
    let saved = branch(fixture, personal, thread, head).await;
    let mut human = saved
        .entries
        .iter()
        .filter(|entry| entry.parent == Some(peer.seq));
    let consumed = human.next().expect("queued input was materialized");
    assert_eq!(
        consumed.body,
        ChatBody::Inline("Deliver this item once".into())
    );
    assert!(human.next().is_none());
    assert_eq!(saved.thread.head, consumed.seq.checked_next().unwrap());
    assert_eq!(watermark.committed_leaf, consumed.seq);
}

async fn revoked_admission_cannot_publish(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    supervisor: &AgentRunSupervisor,
    thread: &ChatThreadId,
    options: ChatRunOptions,
) {
    let actor = fixture.human.auth().principal().clone();
    let before = fixture
        .canonical
        .read_space(&personal.scope().space_id)
        .await
        .unwrap()
        .last_seq;
    for claim in [false, true] {
        let (entered, release) = if claim {
            fixture.projections.pause_chat_claim()
        } else {
            fixture.projections.pause_chat_submit()
        };
        let supervisor = supervisor.clone();
        let options = options.clone();
        let caller = fixture.human.clone();
        let sender = actor.clone();
        let scope = personal.scope().clone();
        let target = thread.clone();
        let effect = tokio::spawn(async move {
            if claim {
                supervisor
                    .start(
                        caller,
                        StartChatRun {
                            scope,
                            thread: target,
                            expected_leaf: ThreadEntrySeq::ZERO,
                            options,
                        },
                    )
                    .await
                    .map(drop)
            } else {
                supervisor
                    .enqueue_input(
                        caller,
                        SubmitUserChatInput {
                            identity: CommandIdentity {
                                scope,
                                actor: sender,
                                key: CommandKey::from_bytes([0x90; 16]),
                                hash: ContentDigest::from_bytes([0x90; 32]),
                            },
                            id: PendingInputId::from_bytes([0x90; 16]),
                            thread: target,
                            expected_leaf: ThreadEntrySeq::ZERO,
                            body: "An input under a closing authority fence".into(),
                            mentions_agent: false,
                        },
                        options,
                    )
                    .await
                    .map(drop)
            }
        });
        let token = timeout(Duration::from_secs(15), entered)
            .await
            .unwrap()
            .unwrap();
        let revocations = fixture.revocations.clone();
        let selector = RevocationSelector::Principal(actor.clone());
        let fence = tokio::spawn(async move {
            revocations
                .fence_provider(
                    MaintenanceContext {
                        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                        budget: budget(),
                    },
                    vec![selector],
                )
                .await
        });
        timeout(Duration::from_secs(15), token.cancelled())
            .await
            .unwrap();
        assert!(
            !fence.is_finished(),
            "the authority fence must wait for canonical settlement"
        );
        release.send(()).unwrap();
        assert!(matches!(
            timeout(Duration::from_secs(15), effect).await.unwrap().unwrap(),
            Err(PortError::Cancelled(error))
                if error.effect() == notarium_core::error::CommitEffect::NotCommitted
        ));
        drop(
            timeout(Duration::from_secs(15), fence)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        );
        let head = branch(fixture, personal, thread, ThreadEntrySeq::ZERO)
            .await
            .thread;
        assert!(head.active_run.is_none());
        assert_eq!(head.head, ThreadEntrySeq::ZERO);
        assert_eq!(
            fixture
                .canonical
                .read_space(&personal.scope().space_id)
                .await
                .unwrap()
                .last_seq,
            before,
        );
    }
}

async fn branch(
    fixture: &RuntimeFixture,
    scope: &SpaceContext,
    thread: &ChatThreadId,
    leaf: ThreadEntrySeq,
) -> ChatBranch {
    fixture
        .canonical
        .read_chat(
            scope.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf,
                before: None,
                max_entries: PageLimit::new(16).unwrap(),
            },
        )
        .await
        .unwrap()
}

async fn idle_leaf(
    fixture: &RuntimeFixture,
    scope: &SpaceContext,
    thread: &ChatThreadId,
) -> ThreadEntrySeq {
    timeout(Duration::from_secs(15), async {
        loop {
            let live = branch(fixture, scope, thread, ThreadEntrySeq::ZERO)
                .await
                .thread;
            if live.active_run.is_none() {
                return live.head;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

async fn stream_events(mut stream: ChatSubscription) -> Vec<Value> {
    timeout(Duration::from_secs(15), async {
        let mut events = Vec::new();
        loop {
            match stream.next().await {
                StreamRead::Frame(frame) => {
                    events.push(serde_json::from_slice(frame.payload()).unwrap())
                }
                StreamRead::Closed => return events,
                StreamRead::CatchUpRequired(_) => (),
            }
        }
    })
    .await
    .unwrap()
}
