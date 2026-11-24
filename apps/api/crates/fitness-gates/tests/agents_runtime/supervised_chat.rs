use std::{sync::atomic::Ordering, time::Duration};

use notarium_agents::chats::{
    AgentRunSupervisor, ChatRunOptions, ChatSubscription, ExclusiveDataRoot, StartChatRun,
    stream::StreamRead,
};
use notarium_control::auth::token::{TokenKind, mint};
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
    let mut fixture = Box::pin(RuntimeFixture::open_named(postgres, "supervised_chat")).await;
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
    let token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            fixture.human.auth().principal(),
            &AuthSessionId::from_bytes([0xb8; 16]),
            &token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let evidence = || support::evidence(AuthEvidenceKind::Session, token.secret.expose());
    let claimant = LogoutClaimant {
        account: AccountContext::new(fixture.control.resolve(evidence()).await.unwrap(), budget()),
        logout: evidence(),
    };
    Box::pin(supervised_turn_survives_disconnect_and_stops_cleanly(
        &fixture, &scoped, claimant,
    ))
    .await;
    fixture.close().await;
}

pub(super) async fn retry_unacknowledged_append(
    fixture: &RuntimeFixture,
    supervisor: &AgentRunSupervisor,
    account: &AccountContext,
    input: SubmitUserChatInput,
    options: &ChatRunOptions,
) -> notarium_agents::chats::ChatSubmission {
    fixture
        .projections
        .fail_chat_submit_unknown_then_not_committed();
    let enqueue = || supervisor.enqueue_input(account.clone(), input.clone(), options.clone());
    assert!(matches!(enqueue().await, Err(PortError::Unavailable(error))
        if error.effect() == notarium_core::error::CommitEffect::Unknown));
    let (left, right) = tokio::join!(enqueue(), enqueue());
    let (left, right) = (left.unwrap(), right.unwrap());
    let (SubmitUserChatOutcome::Appended(a), SubmitUserChatOutcome::Appended(b)) =
        (&left.outcome, &right.outcome)
    else {
        panic!("both retries must resolve the durable append");
    };
    assert_eq!(a.receipt, b.receipt);
    assert_ne!(left.run.is_some(), right.run.is_some());
    if left.run.is_some() { left } else { right }
}

struct LogoutClaimant {
    account: AccountContext,
    logout: PreAuthContext,
}

async fn supervised_turn_survives_disconnect_and_stops_cleanly(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    claimant: LogoutClaimant,
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
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let peer_supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
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
    let expiry = fixture.storage.clock.0.load(Ordering::SeqCst) + 100;
    let viewer = fixture
        .pat_with_expiry(BearerScope::Read, false, Some(expiry))
        .await;
    let former_input = input(242, ThreadEntrySeq::ZERO, "Start a detached turn.");
    let first =
        retry_unacknowledged_append(fixture, &supervisor, owner, former_input.clone(), &options)
            .await;
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
    let mut buffered = supervisor
        .subscribe(viewer.clone(), scope.clone(), thread.clone(), None)
        .await
        .unwrap()
        .unwrap();
    let mut live = supervisor
        .subscribe(
            viewer,
            scope.clone(),
            thread.clone(),
            Some(&checkpoint.cursor),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        timeout(Duration::from_secs(2), live.next()).await.unwrap(),
        StreamRead::Closed
    ));
    assert!(matches!(buffered.next().await, StreamRead::Closed));
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
        .enqueue_input(owner.clone(), former_input.clone(), options.clone())
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
    *fixture.projections.fail_finish_once.lock().unwrap() = true;
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

    let partial = supervisor
        .enqueue_input(
            owner.clone(),
            input(245, head, "Return a limited response."),
            options.clone(),
        )
        .await
        .unwrap();
    let (mut limited, _) = timeout(Duration::from_secs(10), read_request(&listener))
        .await
        .unwrap();
    let stream = supervisor
        .subscribe(owner.clone(), scope.clone(), thread.clone(), None)
        .await
        .unwrap()
        .unwrap();
    send_ollama(
        &mut limited,
        json!({"role":"assistant","content":"Partial result"}),
        "length",
    )
    .await;
    let events = stream_events(stream).await;
    assert_eq!(events.last().unwrap()["type"], "run_failed");
    assert_eq!(events.last().unwrap()["code"], "budget_exceeded");
    let partial_head = idle_leaf(fixture, personal, &thread).await;
    assert!(partial.run.is_some());
    let entries = fixture
        .canonical
        .read_chat_contents(
            personal.clone(),
            ChatContentRead {
                thread: thread.clone(),
                leaf: partial_head,
                entries: vec![partial_head],
            },
        )
        .await
        .unwrap();
    assert_eq!(entries[0].interruption, Some(CompletionFinish::Length));
    assert_eq!(
        ClassEgressFence::chat_transcript(&entries[0].content, owner.auth()).unwrap(),
        "Partial result"
    );

    // Invalid ChatRunOptions (max_steps = 0) must reject before appending any human entry.
    let mut bad_options = options.clone();
    bad_options.limits.max_steps = 0;
    let rejected = supervisor
        .enqueue_input(
            owner.clone(),
            input(246, partial_head, "Should not persist with max_steps=0."),
            bad_options,
        )
        .await
        .map(|_| ());
    assert!(
        matches!(
            rejected,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == notarium_core::error::ValidationReason::BudgetExceeded
        ),
        "max_steps=0 must fail before append: {rejected:?}"
    );
    assert_eq!(idle_leaf(fixture, personal, &thread).await, partial_head);

    // Partial text + well-formed tool call + finish=length must preserve the
    // partial text with Length interruption without executing the truncated call.
    let partial_with_tool = supervisor
        .enqueue_input(
            owner.clone(),
            input(247, partial_head, "Return truncated text with tool call."),
            options.clone(),
        )
        .await
        .unwrap();
    let (mut truncated_call_conn, _) = timeout(Duration::from_secs(10), read_request(&listener))
        .await
        .unwrap();
    let stream = supervisor
        .subscribe(owner.clone(), scope.clone(), thread.clone(), None)
        .await
        .unwrap()
        .unwrap();
    send_ollama(
        &mut truncated_call_conn,
        json!({
            "role": "assistant",
            "content": "Partial before truncated tool",
            "tool_calls": [{
                "function": {
                    "name": "whoami",
                    "arguments": {}
                }
            }]
        }),
        "length",
    )
    .await;
    let events = stream_events(stream).await;
    assert_eq!(events.last().unwrap()["type"], "run_failed");
    assert_eq!(events.last().unwrap()["code"], "budget_exceeded");
    assert!(
        !events.iter().any(|event| event["type"] == "tool_result"),
        "truncated tool call on finish=length must not execute"
    );
    let partial_head = idle_leaf(fixture, personal, &thread).await;
    assert!(partial_with_tool.run.is_some());
    let entries = fixture
        .canonical
        .read_chat_contents(
            personal.clone(),
            ChatContentRead {
                thread: thread.clone(),
                leaf: partial_head,
                entries: vec![partial_head],
            },
        )
        .await
        .unwrap();
    assert_eq!(entries[0].interruption, Some(CompletionFinish::Length));
    assert!(entries[0].tool_calls.is_empty());
    assert_eq!(
        ClassEgressFence::chat_transcript(&entries[0].content, owner.auth()).unwrap(),
        "Partial before truncated tool"
    );

    let second = supervisor
        .enqueue_input(
            owner.clone(),
            input(243, partial_head, "Stop without committing a model."),
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
        former_input,
        human.value.seq,
        options.clone(),
    ))
    .await;
    let leaf = idle_leaf(fixture, personal, &thread).await;
    Box::pin(settle_lost_claim_acknowledgements(
        fixture,
        personal,
        &supervisor,
        &peer_supervisor,
        &listener,
        StartChatRun {
            scope: scope.clone(),
            thread: thread.clone(),
            expected_leaf: leaf,
            options: options.clone(),
        },
        claimant,
    ))
    .await;
    let current = branch(fixture, personal, &thread, ThreadEntrySeq::ZERO)
        .await
        .thread;
    let redact = Mutation {
        identity: mutation(244),
        preconditions: Preconditions::default(),
        input: RedactChatEntry {
            thread: thread.clone(),
            entry: head,
            expected_thread_revision: current.revision,
        },
    };
    *fixture.projections.lose_redaction_acks.lock().unwrap() = 2;
    let lost_redaction_ack = || supervisor.redact_chat_entry(owner.clone(), redact.clone());
    assert!(
        matches!(lost_redaction_ack().await, Err(PortError::Unavailable(error))
        if error.effect() == notarium_core::error::CommitEffect::Unknown)
    );
    let redacted_at = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;
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
    fixture
        .canonical
        .fork_chat(
            personal.clone(),
            Mutation {
                identity: mutation(248),
                preconditions: Preconditions::default(),
                input: ForkChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                },
            },
        )
        .await
        .unwrap();
    let clean = supervisor
        .enqueue_input(
            owner.clone(),
            input(249, ThreadEntrySeq::ZERO, "A fresh branch"),
            options.clone(),
        )
        .await
        .unwrap();
    let clean_run = clean.run.unwrap();
    let (mut wire, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    let mut witness = supervisor
        .subscribe(owner.clone(), scope.clone(), thread.clone(), None)
        .await
        .unwrap()
        .unwrap();
    let StreamRead::CatchUpRequired(fresh) = witness.next().await else {
        panic!("expected the fresh stream checkpoint");
    };
    assert_eq!(fresh.cursor.run, clean_run);
    let mut lagging = supervisor
        .subscribe(
            owner.clone(),
            scope.clone(),
            thread.clone(),
            Some(&fresh.cursor),
        )
        .await
        .unwrap()
        .unwrap();
    begin_ollama_stream(&mut wire).await;
    let part = format!(
        "{}\n",
        json!({"model":runtime_ability_cases::MODEL, "message":{"role":"assistant","content":"Fresh response"}, "done":false})
    );
    wire.get_mut()
        .write_all(format!("{:x}\r\n{part}\r\n", part.len()).as_bytes())
        .await
        .unwrap();
    let StreamRead::Frame(frame) = timeout(Duration::from_secs(10), witness.next())
        .await
        .unwrap()
    else {
        panic!("expected fresh response delta");
    };
    assert!(
        matches!(lost_redaction_ack().await, Err(PortError::Unavailable(error))
        if error.effect() == notarium_core::error::CommitEffect::Unknown)
    );
    let replay = supervisor
        .redact_chat_entry(owner.clone(), redact)
        .await
        .unwrap();
    assert_eq!(replay.receipt.seq(), redacted_at);
    let StreamRead::Frame(saved) = timeout(Duration::from_secs(10), lagging.next())
        .await
        .unwrap()
    else {
        panic!("redaction replay discarded fresh frames");
    };
    assert_eq!(saved.payload(), frame.payload());
    finish_ollama_stream(
        &mut wire,
        json!({"role":"assistant","content":" complete"}),
        "stop",
    )
    .await;
    let events = stream_events(lagging).await;
    assert_eq!(events.last().unwrap()["type"], "run_finished");
    idle_leaf(fixture, personal, &thread).await;
    Box::pin(resilience_submit_gate_and_archival(
        fixture,
        personal,
        &local,
        &supervisor,
        &listener,
        options,
    ))
    .await;
    supervisor.shutdown();
}

async fn begin_ollama_stream(stream: &mut tokio::io::BufReader<tokio::net::TcpStream>) {
    stream
        .get_mut()
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
}

async fn finish_ollama_stream(
    stream: &mut tokio::io::BufReader<tokio::net::TcpStream>,
    message: Value,
    reason: &str,
) {
    let reply = format!(
        "{}\n{}\n",
        json!({"model":runtime_ability_cases::MODEL,"message":message,"done":false}),
        json!({"model":runtime_ability_cases::MODEL,"done":true,"done_reason":reason,"prompt_eval_count":100,"eval_count":2}),
    );
    let chunk = format!("{:x}\r\n{reply}\r\n0\r\n\r\n", reply.len());
    stream.get_mut().write_all(chunk.as_bytes()).await.unwrap();
}

async fn resilience_submit_gate_and_archival(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    local: &runtime_ability_cases::LoopbackProvider,
    supervisor: &AgentRunSupervisor,
    listener: &TcpListener,
    options: ChatRunOptions,
) {
    let owner = &fixture.human;
    let actor = owner.auth().principal();
    let scope = personal.scope();
    let thread = ChatThreadId::from_bytes([0xd0; 16]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xcf; 16]),
                    hash: ContentDigest::from_bytes([0xcf; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    owner: actor.clone(),
                    kind: ChatThreadKind::Personal,
                    title: "Resilience thread".into(),
                    project_folder: None,
                },
            },
        )
        .await
        .unwrap();
    let seed = fixture
        .canonical
        .append_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xd0; 16]),
                    hash: ContentDigest::from_bytes([0xd0; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Seed resilience branch".into()),
                    tool_calls: Vec::new(),
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            },
        )
        .await
        .unwrap();
    let thread = &thread;
    let leaf = seed.value.seq;

    // `submit()` keeps `CommitEffect::Unknown` and retains `PendingCredential`
    // when the first `publish_input` commits `Queued` with a lost ACK and the
    // retry fails `NotCommitted`, so `drain()` still delivers the message.
    let _active_run = supervisor
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
    begin_ollama_stream(&mut wire).await;
    fixture
        .projections
        .fail_chat_submit_unknown_then_not_committed();
    let text = "Survive unknown commit plus not-committed retry.";
    let submit_err = supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xd1; 16]),
                    hash: ContentDigest::from_bytes([0xd1; 32]),
                },
                id: PendingInputId::from_bytes([0xd1; 16]),
                thread: thread.clone(),
                expected_leaf: leaf,
                body: text.into(),
                mentions_agent: false,
            },
            options.clone(),
        )
        .await
        .err()
        .expect("submit must preserve CommitEffect::Unknown");
    assert!(
        matches!(
            &submit_err,
            PortError::Unavailable(failure)
                if failure.effect() == notarium_core::error::CommitEffect::Unknown
        ),
        "{submit_err:?}"
    );
    assert!(
        fixture
            .revocations
            .has_pending(scope, thread, &PendingInputId::from_bytes([0xd1; 16])),
        "pending credential must survive Unknown+NotCommitted retry"
    );
    finish_ollama_stream(
        &mut wire,
        json!({"role":"assistant","content":"Done before draining queued message."}),
        "stop",
    )
    .await;
    drop(wire);
    let (mut next_wire, prompt) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .unwrap();
    assert!(
        prompt["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|msg| msg["role"] == "user" && msg["content"] == text),
        "queued message after Unknown+NotCommitted retry must be delivered: {prompt}"
    );

    send_ollama(
        &mut next_wire,
        json!({"role":"assistant","content":"Delivered unknown-commit message."}),
        "stop",
    )
    .await;
    drop(next_wire);
    let _ = idle_leaf(fixture, personal, thread).await;

    // On a SpaceGroup thread, a concurrent `start()` must wait on `thread_gate`
    // across `refresh_current_peer_head` until `remove_run` finishes, and
    // archiving the Shared Space mid-`drain()` must settle via `closing` cleanup.
    let account_rev = fixture
        .control
        .account(owner.clone(), actor.clone())
        .await
        .unwrap()
        .revision;
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: notarium_core::receipt::AccountCommandIdentity {
                    owner: actor.clone(),
                    actor: actor.clone(),
                    expected: account_rev,
                    key: CommandKey::from_bytes([0xd2; 16]),
                    hash: ContentDigest::from_bytes([0xd2; 32]),
                },
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xd2; 16]),
                    kind: SpaceKind::Shared,
                    name: "ArchivalDrain".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let refreshed_owner = AccountContext::new(
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
    approve_disclosure(
        fixture,
        &refreshed_owner,
        local,
        0xd9,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: shared.history.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &refreshed_owner,
        local,
        0xda,
        ProviderAttachmentTarget::Space(shared.history.space_id.clone()),
        [DocClass::UserDoc].into(),
    )
    .await;
    let shared_ctx = SpaceContext::new(
        refreshed_owner.auth().clone(),
        shared.history.clone(),
        budget(),
    )
    .unwrap();
    let shared_thread = ChatThreadId::from_bytes([0xd4; 16]);
    fixture
        .canonical
        .create_chat(
            shared_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xd4; 16]),
                    hash: ContentDigest::from_bytes([0xd4; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: shared_thread.clone(),
                    owner: actor.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    title: "Archival drain test".into(),
                    project_folder: None,
                },
            },
        )
        .await
        .unwrap();
    let first = supervisor
        .enqueue_input(
            refreshed_owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xd5; 16]),
                    hash: ContentDigest::from_bytes([0xd5; 32]),
                },
                id: PendingInputId::from_bytes([0xd5; 16]),
                thread: shared_thread.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Trigger shared run".into(),
                mentions_agent: true,
            },
            options.clone(),
        )
        .await
        .unwrap();
    let SubmitUserChatOutcome::Appended(_first_entry) = first.outcome else {
        panic!("expected Appended on shared thread");
    };
    let (mut refresh_wire, _) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .unwrap();
    // Pause inside `refresh_current_peer_head` after `finish_run_if_queue_empty`
    // has already returned `Cleared` so a concurrent `start()` proves
    // `thread_gate` stays held until `remove_run` completes.
    let (refresh_entered, refresh_release) = fixture
        .projections
        .pause_peer_head_refresh_after_finish_cleared();
    send_ollama(
        &mut refresh_wire,
        json!({"role":"assistant","content":"Finished first SpaceGroup run."}),
        "stop",
    )
    .await;
    drop(refresh_wire);
    timeout(Duration::from_secs(15), refresh_entered)
        .await
        .unwrap()
        .unwrap();
    let leaf_after = branch(fixture, &shared_ctx, &shared_thread, ThreadEntrySeq::ZERO)
        .await
        .thread
        .head;
    let waiting_start = {
        let supervisor = supervisor.clone();
        let owner = refreshed_owner.clone();
        let start_req = StartChatRun {
            scope: shared.history.clone(),
            thread: shared_thread.clone(),
            expected_leaf: leaf_after,
            options: options.clone(),
        };
        tokio::spawn(async move { supervisor.start(owner, start_req).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        !waiting_start.is_finished(),
        "concurrent start must wait on thread_gate during SpaceGroup peer-head refresh"
    );
    refresh_release.send(()).unwrap();
    let _next_run = timeout(Duration::from_secs(15), waiting_start)
        .await
        .unwrap()
        .unwrap()
        .expect("concurrent start after SpaceGroup peer-head refresh must succeed without owner_unavailable");
    let (mut shared_wire, _) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .unwrap();
    begin_ollama_stream(&mut shared_wire).await;
    let shared_stream = supervisor
        .subscribe(
            refreshed_owner.clone(),
            shared.history.clone(),
            shared_thread.clone(),
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let queued = supervisor
        .enqueue_input(
            refreshed_owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xd6; 16]),
                    hash: ContentDigest::from_bytes([0xd6; 32]),
                },
                id: PendingInputId::from_bytes([0xd6; 16]),
                thread: shared_thread.clone(),
                expected_leaf: leaf_after,
                body: "Pending input cancelled by archival".into(),
                mentions_agent: true,
            },
            options,
        )
        .await
        .unwrap();
    assert!(matches!(queued.outcome, SubmitUserChatOutcome::Queued(_)));
    let (consume_entered, consume_release) = fixture.projections.pause_chat_consume();
    finish_ollama_stream(
        &mut shared_wire,
        json!({"role":"assistant","content":"Finishing before archival."}),
        "stop",
    )
    .await;
    drop(shared_wire);
    timeout(Duration::from_secs(15), consume_entered)
        .await
        .unwrap()
        .unwrap();
    let space_rev = fixture
        .control
        .context_scope(
            refreshed_owner.clone(),
            ContextScope::Space(shared.history.space_id.clone()),
        )
        .await
        .unwrap()
        .revision;
    let archived = fixture
        .control
        .change_space_lifecycle(
            shared_ctx.clone(),
            SpaceLifecycleChange {
                command: CommandKey::from_bytes([0xd7; 16]),
                lifecycle: notarium_core::auth::SpaceLifecycle::Archived,
                expected: space_rev,
            },
        )
        .await
        .unwrap();
    consume_release.send(()).unwrap();
    // Wait for `run_task` to finish closing settlement and close its stream.
    let _ = stream_events(shared_stream).await;
    // Restore the Space to Active and verify `active_run_id` and the pending queue were cleared.
    fixture
        .control
        .change_space_lifecycle(
            shared_ctx.clone(),
            SpaceLifecycleChange {
                command: CommandKey::from_bytes([0xd8; 16]),
                lifecycle: notarium_core::auth::SpaceLifecycle::Active,
                expected: archived.revision,
            },
        )
        .await
        .unwrap();
    let restored_owner = AccountContext::new(
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
    let restored_ctx = SpaceContext::new(
        restored_owner.auth().clone(),
        shared.history.clone(),
        budget(),
    )
    .unwrap();
    let final_thread = branch(fixture, &restored_ctx, &shared_thread, ThreadEntrySeq::ZERO)
        .await
        .thread;
    assert!(
        final_thread.active_run.is_none(),
        "archival mid-drain must clear active_run_id: {:?}",
        final_thread.active_run
    );
    let still_pending = fixture
        .canonical
        .dismiss_chat_input(
            restored_ctx,
            DismissPending {
                thread: shared_thread,
                input: PendingInputId::from_bytes([0xd6; 16]),
            },
        )
        .await
        .unwrap();
    assert!(
        !still_pending,
        "archival mid-drain must cancel pending inputs"
    );
}

async fn queue_conflicts_and_lost_ack(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    supervisor: &AgentRunSupervisor,
    listener: &TcpListener,
    former_input: SubmitUserChatInput,
    leaf: ThreadEntrySeq,
    options: ChatRunOptions,
) {
    let owner = &fixture.human;
    let scope = personal.scope();
    let thread = &former_input.thread;
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
    begin_ollama_stream(&mut wire).await;
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
    let materialized = former_input.id.clone();
    for (index, id, body) in [
        (1, cancelled.clone(), "Dismiss this item"),
        (2, materialized.clone(), "Deliver this item once"),
    ] {
        let mut identity = identity(index);
        if id == materialized {
            identity.hash = former_input.identity.hash;
        }
        let accepted = supervisor
            .enqueue_input(
                owner.clone(),
                SubmitUserChatInput {
                    identity,
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
    let prior_receipt = supervisor
        .enqueue_input(owner.clone(), former_input.clone(), options.clone())
        .await
        .unwrap();
    assert!(matches!(
        prior_receipt.outcome,
        SubmitUserChatOutcome::Appended(saved)
            if matches!(&saved.value.body, ChatBody::Inline(text) if text == &former_input.body)
    ));

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
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
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

async fn settle_lost_claim_acknowledgements(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    supervisor: &AgentRunSupervisor,
    peer: &AgentRunSupervisor,
    listener: &TcpListener,
    mut request: StartChatRun,
    claimant: LogoutClaimant,
) {
    let thread = request.thread.clone();
    let scope = request.scope.clone();
    let (committed, release) = fixture.projections.pause_and_lose_chat_claim_acks(1);
    fixture.projections.lose_chat_finish_acks(2);
    let first = {
        let supervisor = supervisor.clone();
        let request = request.clone();
        tokio::spawn(async move { supervisor.start(claimant.account, request).await })
    };
    let cancellation = timeout(Duration::from_secs(15), committed)
        .await
        .unwrap()
        .unwrap();
    let unpublished = branch(fixture, personal, &thread, ThreadEntrySeq::ZERO)
        .await
        .thread
        .active_run
        .unwrap();
    timeout(
        Duration::from_secs(15),
        fixture.control.logout(claimant.logout),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(cancellation.is_cancelled());

    let next = {
        let supervisor = supervisor.clone();
        let account = fixture.human.clone();
        let request = request.clone();
        tokio::spawn(async move { supervisor.start(account, request).await })
    };
    tokio::task::yield_now().await;
    assert!(!next.is_finished());
    release.send(()).unwrap();
    assert!(matches!(
        timeout(Duration::from_secs(15), first).await.unwrap().unwrap(),
        Err(PortError::Unavailable(failure))
            if failure.effect() == notarium_core::error::CommitEffect::Unknown
    ));
    let successor = timeout(Duration::from_secs(15), next)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_ne!(successor, unpublished);
    let (mut wire, _) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .unwrap();
    send_ollama(
        &mut wire,
        json!({"role":"assistant","content":"The current claim settled."}),
        "stop",
    )
    .await;
    request.expected_leaf = idle_leaf(fixture, personal, &thread).await;

    let (committed, release) = fixture.projections.pause_and_lose_chat_claim_acks(2);
    let dropped = {
        let supervisor = supervisor.clone();
        let account = fixture.human.clone();
        let request = request.clone();
        tokio::spawn(async move { supervisor.start(account, request).await })
    };
    timeout(Duration::from_secs(15), committed)
        .await
        .unwrap()
        .unwrap();
    let unpublished = branch(fixture, personal, &thread, ThreadEntrySeq::ZERO)
        .await
        .thread
        .active_run
        .unwrap();
    let text = "Deliver the live input despite both unknown claim replies.";
    let queued = peer
        .enqueue_input(
            fixture.human.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope,
                    actor: fixture.human.auth().principal().clone(),
                    key: CommandKey::from_bytes([0xb8; 16]),
                    hash: ContentDigest::from_bytes([0xb8; 32]),
                },
                id: PendingInputId::from_bytes([0xb8; 16]),
                thread: thread.clone(),
                expected_leaf: request.expected_leaf,
                body: text.into(),
                mentions_agent: false,
            },
            request.options,
        )
        .await
        .unwrap();
    assert!(matches!(
        queued.outcome,
        SubmitUserChatOutcome::Queued(input) if input.in_flight_run == unpublished
    ));
    dropped.abort();
    assert!(dropped.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();

    let (mut wire, prompt) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .unwrap();
    assert!(
        prompt["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| { message["role"] == "user" && message["content"] == text })
    );
    let live = branch(fixture, personal, &thread, ThreadEntrySeq::ZERO)
        .await
        .thread;
    assert_ne!(live.active_run.as_ref().unwrap(), &unpublished);
    send_ollama(
        &mut wire,
        json!({"role":"assistant","content":"One healthy successor."}),
        "stop",
    )
    .await;
    let head = idle_leaf(fixture, personal, &thread).await;
    let branch = branch(fixture, personal, &thread, head).await;
    assert_eq!(
        head,
        request
            .expected_leaf
            .checked_next()
            .unwrap()
            .checked_next()
            .unwrap()
    );
    assert_eq!(
        branch
            .entries
            .iter()
            .filter(|entry| { matches!(&entry.body, ChatBody::Inline(body) if body == text) })
            .count(),
        1
    );
    assert!(
        branch
            .entries
            .iter()
            .filter(|entry| entry.kind == ChatEntryKind::Model)
            .all(|entry| entry.run.as_ref() != Some(&unpublished))
    );
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
        let fence = timeout(Duration::from_secs(15), fence)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        release.send(()).unwrap();
        assert!(matches!(
            timeout(Duration::from_secs(15), effect).await.unwrap().unwrap(),
            Err(PortError::Cancelled(error))
                if error.effect() == notarium_core::error::CommitEffect::NotCommitted
        ));
        drop(fence);
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

pub(super) async fn branch(
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

pub(super) async fn idle_leaf(
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
