use super::*;
use notarium_core::{
    ids::PrincipalId,
    ports::{ChatBody, ProviderToolCallId},
};
use proptest::prelude::*;
use serde_json::{Value, json};

fn seq(value: u64) -> ThreadEntrySeq {
    ThreadEntrySeq::new(value).unwrap()
}

fn thread() -> ChatThreadId {
    ChatThreadId::from_bytes([1; 16])
}

fn stream() -> StepStreamBuffer {
    StepStreamBuffer::new(AgentRunId::from_bytes([2; 16]), thread(), seq(1))
}

fn cursor(buffer: &StepStreamBuffer, byte_offset: u64) -> StreamCursor {
    StreamCursor {
        run: buffer.run.clone(),
        byte_offset,
    }
}

fn entry(buffer: &StepStreamBuffer, parent: u64, index: u64, kind: ChatEntryKind) -> ChatEntry {
    ChatEntry {
        thread: thread(),
        seq: seq(index),
        parent: Some(seq(parent)),
        is_chain_node: true,
        depth: 0,
        ancestors: Vec::new(),
        author: PrincipalId::from_bytes([3; 16]),
        run: (kind != ChatEntryKind::Human).then(|| buffer.run.clone()),
        kind,
        body: ChatBody::Inline(String::new()),
        tainted: false,
        referenced_notes: Vec::new(),
    }
}

fn encoded(frame: &StreamFrame) -> Value {
    assert!(frame.payload().len() <= STREAM_FRAME_BYTES);
    assert_eq!(
        frame.end_offset - frame.start_offset,
        frame.payload().len() as u64
    );
    serde_json::from_slice(frame.payload()).unwrap()
}

async fn frame(viewer: &mut StepSubscription) -> StreamFrame {
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), viewer.next())
        .await
        .expect("stream sent no frame");
    let StreamRead::Frame(frame) = event else {
        panic!("expected a frame")
    };
    frame
}

async fn checkpoint(viewer: &mut StepSubscription) -> StreamCheckpoint {
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), viewer.next())
        .await
        .expect("stream sent no checkpoint");
    let StreamRead::CatchUpRequired(checkpoint) = event else {
        panic!("expected a checkpoint")
    };
    checkpoint
}

#[tokio::test]
async fn text_is_replayable_across_escaped_utf8_boundaries() {
    let buffer = stream();
    let text = "a🙂\\\"\u{1}\n\r\t\u{c}\u{8}".repeat(1600);
    buffer.begin_step(0).unwrap();
    buffer.text_delta(0, &text).unwrap();
    let frame_count = lock(&buffer.state).frames.len();
    assert!(frame_count > 1);
    let mut replay = buffer.subscribe(Some(&cursor(&buffer, 0)));
    let mut rebuilt = String::new();
    let mut offset = 0;
    for _ in 0..frame_count {
        let frame = frame(&mut replay).await;
        assert_eq!(frame.start_offset, offset);
        let value = encoded(&frame);
        assert_eq!(value["type"], "text_delta");
        rebuilt.push_str(value["text"].as_str().unwrap());
        offset = frame.end_offset;
    }
    assert_eq!(rebuilt, text);

    for wrong in [
        cursor(&buffer, 1),
        cursor(&buffer, offset + 1),
        StreamCursor {
            run: AgentRunId::from_bytes([7; 16]),
            byte_offset: offset,
        },
    ] {
        let snapshot = checkpoint(&mut buffer.subscribe(Some(&wrong))).await;
        assert_eq!(snapshot.cursor, cursor(&buffer, offset));
        assert_eq!(snapshot.committed_leaf, seq(1));
        assert_eq!(snapshot.incomplete_step, Some(0));
    }
}

#[tokio::test]
async fn lagging_and_reconnecting_viewers_recover_the_complete_model_commit_once() {
    let buffer = stream();
    let start = cursor(&buffer, 0);
    let mut first = buffer.subscribe(Some(&start));
    let mut second = buffer.subscribe(Some(&start));
    buffer.begin_step(0).unwrap();
    buffer.text_delta(0, "early").unwrap();
    assert_eq!(encoded(&frame(&mut first).await)["text"], "early");

    let text = "🙂\"\\\u{1}\n".repeat(13_000);
    assert!(text.len() >= 96 * 1024);
    buffer.text_delta(0, &text).unwrap();
    let before_commit = checkpoint(&mut second).await;
    assert_eq!(before_commit.committed_leaf, seq(1));
    assert_eq!(before_commit.incomplete_step, Some(0));
    assert_eq!(checkpoint(&mut first).await, before_commit);
    assert_eq!(checkpoint(&mut buffer.subscribe(None)).await, before_commit);

    let mut reconnect = buffer.subscribe(Some(&before_commit.cursor));
    let first_frame = tokio::spawn(async move { frame(&mut first).await });
    tokio::task::yield_now().await;
    let model = entry(&buffer, 1, 2, ChatEntryKind::Model);
    assert!(buffer.committed(&model, Some(0)).unwrap());
    assert!(!buffer.committed(&model, Some(0)).unwrap());

    let first_commit = first_frame.await.unwrap();
    for receipt in [
        first_commit,
        frame(&mut second).await,
        frame(&mut reconnect).await,
    ] {
        assert_eq!(receipt.start_offset, before_commit.cursor.byte_offset);
        assert_eq!(
            encoded(&receipt),
            json!({
                "run": buffer.run,
                "type": "committed",
                "entrySeq": 2,
                "step": 0,
                "transientStart": 0,
                "transientEnd": before_commit.cursor.byte_offset,
            })
        );
    }
    let after_commit = checkpoint(&mut buffer.subscribe(Some(&start))).await;
    assert_eq!(after_commit.committed_leaf, seq(2));
    assert_eq!(after_commit.incomplete_step, None);

    buffer.finish().unwrap();
    assert_eq!(
        encoded(&frame(&mut reconnect).await)["type"],
        "run_finished"
    );
    assert!(matches!(reconnect.next().await, StreamRead::Closed));
    let done = checkpoint(&mut buffer.subscribe(None)).await;
    assert_eq!(done.terminal, Some(RunTerminal::Finished));
    assert_eq!(done.committed_leaf, seq(2));
}

#[tokio::test]
async fn validated_tool_call_fragments_and_committed_result_stay_bounded() {
    let buffer = stream();
    buffer.begin_step(0).unwrap();
    let call_id = CommandKey::from_bytes([4; 16]);
    let call = ProviderToolCall {
        id: ProviderToolCallId::new(call_id.to_string()).unwrap(),
        name: "example".into(),
        arguments: [(
            "large".to_owned(),
            json!(format!("{}🙂\\\"\n", "x".repeat(48 * 1024))),
        )]
        .into(),
    };
    buffer.tool_call(0, &call).unwrap();
    let mut replay = buffer.subscribe(Some(&cursor(&buffer, 0)));
    assert_eq!(
        encoded(&frame(&mut replay).await),
        json!({"run": buffer.run, "type": "tool_call_start", "step": 0, "callId": call_id, "name": "example"})
    );
    let mut arguments = String::new();
    let mut index = 0;
    loop {
        let part = encoded(&frame(&mut replay).await);
        assert_eq!(part["type"], "tool_call_delta");
        assert_eq!(part["callId"], call_id.as_str());
        assert_eq!(part["index"], index);
        arguments.push_str(part["fragment"].as_str().unwrap());
        index += 1;
        if part["last"] == true {
            break;
        }
    }
    assert!(index > 1);
    assert_eq!(
        serde_json::from_str::<Value>(&arguments).unwrap(),
        json!(call.arguments)
    );

    assert!(
        buffer
            .tool_result(0, &call_id, seq(3), "uncommitted")
            .is_err()
    );
    buffer
        .committed(&entry(&buffer, 1, 2, ChatEntryKind::Model), Some(0))
        .unwrap();
    buffer
        .committed(
            &entry(
                &buffer,
                2,
                3,
                ChatEntryKind::Tool {
                    call_id: call_id.clone(),
                },
            ),
            None,
        )
        .unwrap();
    buffer
        .tool_result(0, &call_id, seq(3), &"🙂\"\n".repeat(20_000))
        .unwrap();
    buffer
        .approval_needed(0, &call_id, seq(3), ContentDigest::from_bytes([5; 32]))
        .unwrap();
    for seq in [2, 3] {
        let event = encoded(&frame(&mut replay).await);
        assert_eq!(event["type"], "committed");
        assert_eq!(event["entrySeq"], seq);
    }
    let result = encoded(&frame(&mut replay).await);
    assert_eq!(result["type"], "tool_call_result");
    assert_eq!(result["entrySeq"], 3);
    assert_eq!(result["previewTruncated"], true);
    assert_eq!(
        encoded(&frame(&mut replay).await)["type"],
        "taint_approval_needed"
    );
}

#[tokio::test]
async fn missing_peer_commit_updates_even_live_tail_before_terminal() {
    let buffer = stream();
    let mut viewer = buffer.subscribe(Some(&cursor(&buffer, 0)));
    let mut wrong_thread = entry(&buffer, 1, 4, ChatEntryKind::Human);
    wrong_thread.thread = ChatThreadId::from_bytes([9; 16]);
    assert!(buffer.committed(&wrong_thread, None).is_err());
    assert!(
        buffer
            .committed(&entry(&buffer, 3, 4, ChatEntryKind::Human), None)
            .unwrap()
    );
    let peer = checkpoint(&mut viewer).await;
    assert_eq!(peer.committed_leaf, seq(4));
    assert!(peer.cursor.byte_offset > 0);
    buffer.fail(RunFailure::AuthorityRevoked).unwrap();
    assert_eq!(
        encoded(&frame(&mut viewer).await),
        json!({"run": buffer.run, "type": "run_failed", "code": "authority_revoked"})
    );
    assert!(matches!(viewer.next().await, StreamRead::Closed));
}

#[tokio::test]
async fn late_model_ack_clears_its_step_without_rewinding_peer_watermark() {
    let buffer = stream();
    let mut viewer = buffer.subscribe(Some(&cursor(&buffer, 0)));
    buffer.begin_step(0).unwrap();
    buffer.text_delta(0, "pending model").unwrap();
    assert_eq!(encoded(&frame(&mut viewer).await)["type"], "text_delta");

    let peer = entry(&buffer, 2, 3, ChatEntryKind::Human);
    assert!(buffer.committed(&peer, None).unwrap());
    let before_model_ack = checkpoint(&mut viewer).await;
    assert_eq!(before_model_ack.committed_leaf, seq(3));
    assert_eq!(before_model_ack.incomplete_step, Some(0));

    let model = entry(&buffer, 1, 2, ChatEntryKind::Model);
    assert!(buffer.committed(&model, Some(0)).unwrap());
    let after_model_ack = checkpoint(&mut viewer).await;
    assert_eq!(after_model_ack.committed_leaf, seq(3));
    assert_eq!(after_model_ack.incomplete_step, None);
    assert!(after_model_ack.cursor.byte_offset > before_model_ack.cursor.byte_offset);
    buffer.begin_step(1).unwrap();
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn window_keeps_complete_json_frames_at_measured_boundaries(
        lengths in prop::collection::vec(1usize..=48 * 1024, 1..=16),
    ) {
        let buffer = stream();
        let source = "aб🙂\"\\\u{1} ".repeat(48 * 1024);
        let mut remaining = 512 * 1024;
        buffer.begin_step(0).unwrap();
        for length in lengths {
            let length = source.floor_char_boundary(length.min(remaining));
            buffer.text_delta(0, &source[..length]).unwrap();
            remaining -= length;
        }

        let state = lock(&buffer.state);
        let mut offset = state.frames.front().unwrap().start_offset;
        let oldest = offset;
        let total: usize = state.frames.iter().map(|frame| frame.payload().len()).sum();
        prop_assert_eq!(state.retained, total);
        prop_assert!(total <= STREAM_WINDOW_BYTES);
        for frame in &state.frames {
            prop_assert_eq!(frame.start_offset, offset);
            prop_assert_eq!(&encoded(frame)["type"], "text_delta");
            prop_assert!(state.valid_boundary(offset));
            prop_assert!(!state.valid_boundary(offset + 1));
            offset = frame.end_offset;
        }
        prop_assert_eq!(offset, state.end);
        drop(state);

        prop_assert!(buffer.subscribe(Some(&cursor(&buffer, oldest))).checkpoint.is_none());
        prop_assert!(buffer.subscribe(Some(&cursor(&buffer, oldest + 1))).checkpoint.is_some());
        if oldest > 0 {
            prop_assert!(buffer.subscribe(Some(&cursor(&buffer, 0))).checkpoint.is_some());
        }
    }
}
