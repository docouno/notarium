use std::time::Duration;

use notarium_agents::chats::{AgentRunSupervisor, ChatRunOptions, ExclusiveDataRoot, StartChatRun};
use notarium_core::{auth::SpaceKind, classes::DocClass};
use tokio::{
    net::TcpListener,
    time::{sleep, timeout},
};

use super::{
    runtime_ability_cases::{
        approve_disclosure, loopback_provider_with_limits, read_request, send_ollama,
    },
    *,
};

#[tokio::test]
async fn sqlite_compaction_preserves_recent_context() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise(false)).await;
}

#[tokio::test]
async fn postgres_compaction_preserves_recent_context() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise(true)).await;
}

async fn exercise(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(pg, "agents_compaction")).await;
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
        .expect("the fixture owner has a Personal Space");
    let ctx = SpaceContext::new(fixture.human.auth().clone(), personal.history, budget()).unwrap();
    Box::pin(compact_prefix_preserving_recent_context(&fixture, &ctx)).await;
    fixture.close().await;
}

async fn compact_prefix_preserving_recent_context(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider =
        loopback_provider_with_limits(fixture, &fixture.human, &listener, 132, false, 2048, 256)
            .await;
    let scope = personal.scope();
    let actor = fixture.human.auth().principal();
    approve_disclosure(
        fixture,
        &fixture.human,
        &provider,
        134,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Profile].into(),
    )
    .await;

    let thread = ChatThreadId::from_bytes([132; 16]);
    let identity = |ordinal: u8| {
        let mut key = [132; 16];
        key[15] = ordinal;
        CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes(key),
            hash: ContentDigest::from_bytes([ordinal; 32]),
        }
    };
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: identity(0),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Bounded history".into(),
                },
            },
        )
        .await
        .unwrap();
    let mut entries = Vec::new();
    let mut leaf = ThreadEntrySeq::ZERO;
    let mut legacy_empty = None;
    for ordinal in 1..=10 {
        let label = format!("ordered segment {ordinal}");
        let body = if ordinal == 2 {
            label.clone()
        } else {
            format!("{label} {}", "a".repeat(900 - label.len() - 1))
        };
        let SubmitUserChatOutcome::Appended(entry) = fixture
            .canonical
            .submit_user_chat_input(
                personal.clone(),
                SubmitUserChatInput {
                    identity: identity(ordinal),
                    id: PendingInputId::from_bytes([ordinal + 131; 16]),
                    thread: thread.clone(),
                    expected_leaf: leaf,
                    body,
                    mentions_agent: false,
                },
            )
            .await
            .unwrap()
        else {
            panic!("fixture input was not appended");
        };
        leaf = entry.value.seq;
        entries.push((leaf, label));
        if ordinal == 2 {
            // Recreate the inline representation written by older admissions.
            let changed = fixture.canonical.execute_diagnostic_write_sql_for_test(&format!(
                "UPDATE chat_entries SET inline_text='' WHERE space_id='{}' AND thread_id='{thread}' AND entry_seq={}",
                scope.space_id, leaf.get()
            )).await.unwrap();
            assert_eq!(changed, 1);
            legacy_empty = Some(leaf);
        }
        if ordinal == 1 {
            let interrupted =
                interrupted_tool_group(fixture, personal, &thread, leaf, &identity).await;
            leaf = interrupted.last().unwrap().0;
            entries.extend(interrupted);
        }
    }
    let before_compaction = wait_for_idle(fixture, personal, &thread).await;
    let independent_redaction = fixture
        .canonical
        .redact_chat_entry(
            personal.clone(),
            Mutation {
                identity: identity(11),
                preconditions: Preconditions::default(),
                input: RedactChatEntry {
                    thread: thread.clone(),
                    entry: entries[0].0,
                    expected_thread_revision: before_compaction.revision,
                },
            },
        )
        .await
        .unwrap();
    assert!(independent_redaction.value.invalidated_contexts.is_empty());
    let legacy_empty = legacy_empty.unwrap();
    let live_entries: Vec<_> = entries[1..]
        .iter()
        .filter(|(seq, _)| *seq != legacy_empty)
        .cloned()
        .collect();
    let prefix = fixture
        .canonical
        .read_chat_compaction_prefix(
            personal.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf,
                before: None,
                max_entries: PageLimit::new(5).unwrap(),
            },
        )
        .await
        .unwrap();
    assert!(prefix.has_tail);
    assert_eq!(prefix.contents.len(), 5);
    assert!(prefix.contents.iter().all(|item| item.seq != legacy_empty));

    let supervisor = AgentRunSupervisor::new_local(
        provider.registry,
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let request = |expected_leaf| StartChatRun {
        scope: scope.clone(),
        thread: thread.clone(),
        expected_leaf,
        options: ChatRunOptions {
            provider: Some(provider.resource.id.clone()),
            model: Some(provider.model.clone()),
            limits: RunLimits {
                max_steps: 4,
                max_tokens: 20_000,
                timeout_ms: 30_000,
            },
            ..ChatRunOptions::default()
        },
    };
    supervisor
        .start(fixture.human.clone(), request(leaf))
        .await
        .unwrap();
    let (mut socket, summary) = timeout(Duration::from_secs(10), read_request(&listener))
        .await
        .unwrap();
    let summary_messages = summary["messages"].as_array().unwrap();
    assert!(
        summary_messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("older conversation prefix")
    );
    let shown: Vec<_> = summary_messages[1..]
        .iter()
        .map(|message| message["content"].as_str().unwrap())
        .collect();
    let calls = summary_messages[1]["tool_calls"].as_array().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["function"]["name"], "get_note");
    assert_eq!(summary_messages[2]["role"], "tool");
    assert_eq!(summary_messages[2]["tool_name"], "get_note");
    assert_eq!(summary_messages[3]["role"], "assistant");
    assert!(shown[2].contains("Untrusted historical tool output"));
    assert!(shown[2].contains("Unpaired result"));
    let covered = shown.len();
    assert!((2..live_entries.len()).contains(&covered));
    for (text, (_, label)) in shown.iter().zip(&live_entries) {
        assert!(text.starts_with(label));
    }
    send_ollama(
        &mut socket,
        json!({"role":"assistant","content":"Summary of older segments."}),
        "stop",
    )
    .await;
    drop(socket);

    let (mut socket, recent) = timeout(Duration::from_secs(10), read_request(&listener))
        .await
        .unwrap();
    let recent_messages = recent["messages"].as_array().unwrap();
    assert_eq!(recent_messages[1]["content"], "Summary of older segments.");
    assert_eq!(recent_messages.len(), 2 + live_entries.len() - covered);
    for (message, (_, label)) in recent_messages[2..].iter().zip(&live_entries[covered..]) {
        assert!(message["content"].as_str().unwrap().starts_with(label));
    }
    send_ollama(
        &mut socket,
        json!({"role":"assistant","content":"Finished the retained context."}),
        "stop",
    )
    .await;
    drop(socket);

    let final_thread = wait_for_idle(fixture, personal, &thread).await;
    let read = || ChatRead {
        thread: thread.clone(),
        leaf: final_thread.head,
        before: None,
        max_entries: PageLimit::new(20).unwrap(),
    };
    let audit = fixture
        .canonical
        .read_chat(personal.clone(), read())
        .await
        .unwrap();
    let historical = audit
        .entries
        .iter()
        .find(|entry| entry.seq == legacy_empty)
        .unwrap();
    assert_eq!(historical.kind, ChatEntryKind::Human);
    assert_eq!(historical.body, ChatBody::Inline(String::new()));
    assert_eq!(audit.entries.len(), entries.len() + 2);
    assert_eq!(audit.entries[0].kind, ChatEntryKind::Redacted);
    assert_eq!(
        audit.entries[..entries.len()]
            .iter()
            .map(|entry| entry.seq)
            .collect::<Vec<_>>(),
        entries.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
    );
    let checkpoint = audit.entries[entries.len()].seq;
    assert_eq!(audit.entries[entries.len()].kind, ChatEntryKind::Compaction);
    assert_eq!(audit.entries[entries.len()].parent, Some(leaf));
    let summary = fixture
        .canonical
        .read_chat_contents(
            personal.clone(),
            ChatContentRead {
                thread: thread.clone(),
                leaf: final_thread.head,
                entries: vec![checkpoint],
            },
        )
        .await
        .unwrap();
    let proof = summary[0].content.provenance().unwrap();
    assert_eq!(proof.compacts_through, Some(live_entries[covered - 1].0));
    assert!(
        proof
            .origins
            .iter()
            .all(|origin| !matches!(origin, notarium_core::classes::ProviderOrigin::Chat { .. })),
        "the checkpoint covers its chat-only prefix without historical chat edges",
    );
    let context = fixture
        .canonical
        .read_chat_context(personal.clone(), read())
        .await
        .unwrap();
    assert_eq!(context.entries[0].seq, checkpoint);
    assert_eq!(context.entries[1].seq, live_entries[covered].0);
    assert_eq!(context.entries.last().unwrap().seq, final_thread.head);

    let redacted = fixture
        .canonical
        .redact_chat_entry(
            personal.clone(),
            Mutation {
                identity: identity(12),
                preconditions: Preconditions::default(),
                input: RedactChatEntry {
                    thread: thread.clone(),
                    entry: live_entries[0].0,
                    expected_thread_revision: final_thread.revision,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(redacted.value.invalidated_contexts, vec![checkpoint]);
    let audit = fixture
        .canonical
        .read_chat(personal.clone(), read())
        .await
        .unwrap();
    assert_eq!(audit.entries[1].kind, ChatEntryKind::Redacted);
    assert_eq!(audit.entries[entries.len()].kind, ChatEntryKind::Redacted);
    supervisor
        .start(fixture.human.clone(), request(final_thread.head))
        .await
        .unwrap();
    assert!(
        timeout(Duration::from_millis(300), listener.accept())
            .await
            .is_err(),
        "a redacted dependency should not be sent",
    );
    wait_for_idle(fixture, personal, &thread).await;
    supervisor.shutdown();
}

/// A prior run persisted one of two results, and the log also contains a
/// tool value without a matching call. Both actual results must reach the
/// summary with their canonical identities.
async fn interrupted_tool_group(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    thread: &ChatThreadId,
    mut leaf: ThreadEntrySeq,
    identity: &impl Fn(u8) -> CommandIdentity,
) -> Vec<(ThreadEntrySeq, String)> {
    let run = AgentRunId::from_bytes([135; 16]);
    let auth = personal
        .auth()
        .for_agent_run(
            run.clone(),
            personal.scope().space_id.clone(),
            notarium_core::auth::ChatAudience::Personal,
            personal.auth().spaces().clone(),
        )
        .unwrap();
    let ctx = SpaceContext::new(auth, personal.scope().clone(), budget()).unwrap();
    fixture
        .canonical
        .claim_active_run(
            ctx.clone(),
            ClaimChatRun {
                thread: thread.clone(),
                run: run.clone(),
                expected_leaf: leaf,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    let completed = CommandKey::from_bytes([136; 16]);
    let missing = CommandKey::from_bytes([137; 16]);
    let orphan = CommandKey::from_bytes([138; 16]);
    let calls = [(completed.clone(), "get_note"), (missing, "list_notes")]
        .into_iter()
        .map(|(id, name)| ProviderToolCall {
            id: ProviderToolCallId::new(id.to_string()).unwrap(),
            name: name.into(),
            arguments: Default::default(),
        })
        .collect();
    let mut saved = Vec::new();
    for (key, kind, calls, text) in [
        (136, ChatEntryKind::Model, calls, "Two requested reads"),
        (
            137,
            ChatEntryKind::Tool { call_id: completed },
            vec![],
            "Completed read",
        ),
        (
            138,
            ChatEntryKind::Tool { call_id: orphan },
            vec![],
            "Unpaired result",
        ),
    ] {
        let entry = fixture
            .canonical
            .append_chat(
                ctx.clone(),
                Mutation {
                    identity: identity(key),
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: thread.clone(),
                        parent: leaf,
                        kind,
                        body: ChatInputBody::Text(text.into()),
                        tool_calls: calls,
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
                        provenance: Some(ChatProvenance::default()),
                        referenced_notes: vec![],
                        tainted: false,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        leaf = entry.seq;
        let label = if key == 138 {
            "[Untrusted historical tool output]"
        } else {
            text
        };
        saved.push((leaf, label.into()));
    }
    assert_eq!(
        fixture
            .canonical
            .finish_run_if_queue_empty(
                ctx,
                ChatRunRequest {
                    thread: thread.clone(),
                    expected_run: run,
                }
            )
            .await
            .unwrap(),
        FinishChatRunOutcome::Cleared
    );
    saved
}

async fn wait_for_idle(
    fixture: &RuntimeFixture,
    ctx: &SpaceContext,
    thread: &ChatThreadId,
) -> ChatThread {
    timeout(Duration::from_secs(10), async {
        loop {
            let observed = fixture
                .canonical
                .read_chat(
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
            if observed.active_run.is_none() {
                return observed;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
