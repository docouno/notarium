use std::time::Duration;

use notarium_agents::chats::{
    AgentRunSupervisor, ChatRunOptions, ChatSubscription, ExclusiveDataRoot, stream::StreamRead,
};
use notarium_core::classes::{ClassEgressFence, DocClass};
use tokio::{
    io::AsyncReadExt,
    net::TcpListener,
    time::{sleep, timeout},
};

use super::{
    runtime_ability_cases::{approve_disclosure, loopback_provider, read_request, send_ollama},
    *,
};

pub(super) async fn supervised_turn_survives_disconnect_and_stops_cleanly(
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
            options,
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
    supervisor.shutdown();
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
