use super::*;
use notarium_core::{
    classes::{DocClass, ProviderAudience, ProviderPolicy},
    ids::*,
    ports::{control::*, *},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn model(kind: ProviderModelKind) -> ProviderModelSpec {
    ProviderModelSpec {
        id: ModelProfileId::from_bytes([1; 16]),
        wire_name: "fixture-model".into(),
        kind,
        accounting: TokenAccountingProfile::ConservativeModelCapV1,
        max_input_tokens: 131072,
        max_output_tokens: 1024,
        tools: true,
    }
}
fn decoder(wire: ProviderWireKind) -> CompletionDecoder {
    CompletionDecoder::new(
        wire,
        "fixture-model".into(),
        CommandKey::from_bytes([1; 16]),
        BTreeSet::from(["lookup".into()]),
        4,
    )
    .unwrap()
}
fn sse(value: Value) -> String {
    format!("data: {value}\r\n\r\n")
}
fn chunk(delta: Value, reason: Option<&str>) -> Value {
    json!({"model":"fixture-model","choices":[{"index":0,"delta":delta,"finish_reason":reason}],"usage":null})
}
#[test]
fn openai_sse_every_byte_boundary_preserves_text_tools_usage_and_terminal_order() {
    let raw = format!(
        "\u{feff}: heartbeat\r\n\r\n{}{}{}{}{}{}data: [DONE]\r\n\r\n",
        sse(json!({"model":"fixture-model-2026-11-16","choices":[]})),
        sse(chunk(
            json!({"role":"assistant","content":"Hello 🦀","tool_calls":null}),
            None
        )),
        sse(chunk(
            json!({"role":null,"tool_calls":[{"index":0,"id":"functions.lookup:0","type":"function","function":{"name":"look","arguments":"{\"city\":"}}]}),
            None
        )),
        sse(chunk(
            json!({"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":"up","arguments":"\"東京\"}"}}]}),
            None
        )),
        sse(chunk(
            json!({"content":null,"tool_calls":null}),
            Some("tool_calls")
        )),
        sse(
            json!({"model":"fixture-model-2026-11-16","choices":[],"usage":{"prompt_tokens":23,"completion_tokens":17,"total_tokens":45}})
        ),
    );
    for boundary in 0..=raw.len() {
        let mut parser = decoder(ProviderWireKind::OpenaiCompatible);
        let mut events = parser.feed(&raw.as_bytes()[..boundary]).unwrap();
        events.extend(parser.feed(&raw.as_bytes()[boundary..]).unwrap());
        events.extend(parser.eof().unwrap());
        assert_eq!(events.len(), 4);
        assert!(matches!(&events[0],CompletionEvent::Text(text) if text=="Hello 🦀"));
        assert!(
            matches!(&events[1],CompletionEvent::ToolCall(call) if call.name=="lookup" && call.id.as_str()=="functions.lookup:0" && call.arguments["city"]=="東京")
        );
        assert!(matches!(
            events[2],
            CompletionEvent::Usage(ProviderUsage::Exact {
                input_tokens: 23,
                output_tokens: 17
            })
        ));
        assert!(matches!(
            events[3],
            CompletionEvent::Finished(CompletionFinish::ToolCalls)
        ));
    }
    let mut parser = decoder(ProviderWireKind::OpenaiCompatible);
    let mut events = Vec::new();
    for byte in raw.as_bytes() {
        events.extend(parser.feed(&[*byte]).unwrap());
    }
    events.extend(parser.eof().unwrap());
    assert_eq!(events.len(), 4);
}
#[test]
fn sse_multiline_unknown_usage_and_bad_frames_fail_without_fabricated_counts() {
    let raw = "data: {\"model\":\"fixture-model\",\n\
data: \"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n\
data: [DONE]\n\n";
    let mut parser = decoder(ProviderWireKind::OpenaiCompatible);
    let events = parser.feed(raw.as_bytes()).unwrap();
    parser.eof().unwrap();
    assert!(matches!(
        events[1],
        CompletionEvent::Usage(ProviderUsage::Unknown)
    ));
    for raw in [
        sse(chunk(json!({"content":"partial"}), None)),
        "data: [DONE]\n\n".into(),
        sse(json!({"model":"another","choices":[]})),
        sse(json!({"model":"fixture-model","choices":[{"index":1,"delta":{}}]})),
        sse(
            json!({"model":"fixture-model","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":0}}),
        ),
        format!("data: {}\n\n", "x".repeat(MAX_FRAME + 1)),
    ] {
        let mut parser = decoder(ProviderWireKind::OpenaiCompatible);
        assert!(
            parser
                .feed(raw.as_bytes())
                .and_then(|_| parser.eof())
                .is_err()
        );
        assert_eq!(parser.usage(), ProviderUsage::Unknown);
    }
    let mut parser = decoder(ProviderWireKind::OpenaiCompatible);
    let valid = sse(
        json!({"model":"fixture-model","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}),
    );
    parser.feed(valid.as_bytes()).unwrap();
    let conflict = sse(
        json!({"model":"fixture-model","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0}}),
    );
    assert!(parser.feed(conflict.as_bytes()).is_err());
    assert_eq!(parser.usage(), ProviderUsage::Unknown);
}
#[test]
fn ollama_ndjson_byte_splits_and_tool_ids_are_stable_and_reasoning_is_not_text() {
    let raw = format!(
        "{}\n{}\n{}",
        json!({"model":"fixture-model","message":{"role":"assistant","content":"Hi 🦀","thinking":"not output"},"done":false}),
        json!({"model":"fixture-model","message":{"tool_calls":[{"function":{"index":0,"name":"lookup","arguments":{"city":"Oslo"}}}]},"done":false}),
        json!({"model":"fixture-model","done":true,"done_reason":"stop","prompt_eval_count":11,"eval_count":7}),
    );
    for boundary in 0..=raw.len() {
        let mut parser = decoder(ProviderWireKind::Ollama);
        let mut events = parser.feed(&raw.as_bytes()[..boundary]).unwrap();
        events.extend(parser.feed(&raw.as_bytes()[boundary..]).unwrap());
        events.extend(parser.eof().unwrap());
        assert_eq!(events.len(), 4);
        assert!(matches!(&events[0],CompletionEvent::Text(text) if text=="Hi 🦀"));
        assert!(
            matches!(&events[1],CompletionEvent::ToolCall(call) if call.id.as_str()==format!("ollama-{}-0",CommandKey::from_bytes([1;16])))
        );
        assert_eq!(
            parser.usage(),
            ProviderUsage::Exact {
                input_tokens: 11,
                output_tokens: 7
            }
        );
    }
    // Ollama Go omitempty (zero eval_count omitted) and done_reason="tool_calls" are accepted.
    let mut omitempty_parser = decoder(ProviderWireKind::Ollama);
    let omitempty_raw = format!(
        "{}\n{}",
        json!({"model":"fixture-model:latest","message":{"tool_calls":[{"function":{"index":0,"name":"lookup","arguments":{"city":"Oslo"}}}]},"done":false}),
        json!({"model":"fixture-model:latest","done":true,"done_reason":"tool_calls","prompt_eval_count":12}),
    );
    let mut omitempty_events = omitempty_parser.feed(omitempty_raw.as_bytes()).unwrap();
    omitempty_events.extend(omitempty_parser.eof().unwrap());
    assert_eq!(
        omitempty_parser.usage(),
        ProviderUsage::Exact {
            input_tokens: 12,
            output_tokens: 0
        }
    );
    assert!(matches!(
        omitempty_events.last(),
        Some(CompletionEvent::Finished(CompletionFinish::ToolCalls))
    ));
    for value in [
        json!({"model":"fixture-model","done":true,"prompt_eval_count":"bad"}),
        json!({"model":"","done":true}),
        json!({"model":"fixture-model","message":{"tool_calls":[{"function":{"index":2,"name":"lookup","arguments":{}}}]},"done":true}),
        json!({"model":"fixture-model","message":{"tool_calls":[{"function":{"name":"unknown","arguments":{}}}]},"done":true}),
    ] {
        let mut parser = decoder(ProviderWireKind::Ollama);
        assert!(
            parser
                .feed(value.to_string().as_bytes())
                .and_then(|_| parser.eof())
                .is_err()
        );
    }
}
#[test]
fn embedding_bijection_order_dimensions_finite_values_and_usage_are_enforced() {
    let model = model(ProviderModelKind::Embedding { dimension: 2 });
    let valid = json!({"model":"fixture-model","data":[{"index":1,"embedding":[3,4]},{"index":0,"embedding":[1,2]}],"usage":{"prompt_tokens":4,"total_tokens":4}});
    let result = decode_embedding(
        ProviderWireKind::OpenaiCompatible,
        &model,
        2,
        valid.to_string().as_bytes(),
    )
    .unwrap();
    assert_eq!(result.vectors, vec![vec![1.0, 2.0], vec![3.0, 4.0]]);
    assert_eq!(
        result.usage,
        ProviderUsage::Exact {
            input_tokens: 4,
            output_tokens: 0
        }
    );
    for data in [
        json!([{"index":0,"embedding":[1,2]}]),
        json!([{"index":0,"embedding":[1,2]},{"index":0,"embedding":[3,4]}]),
        json!([{"index":0,"embedding":[1]},{"index":1,"embedding":[3,4]}]),
        json!([{"index":2,"embedding":[1,2]},{"index":1,"embedding":[3,4]}]),
        json!([{"index":0,"embedding":[1e308,2]},{"index":1,"embedding":[3,4]}]),
    ] {
        let mut bad = valid.clone();
        bad["data"] = data;
        assert!(
            decode_embedding(
                ProviderWireKind::OpenaiCompatible,
                &model,
                2,
                bad.to_string().as_bytes()
            )
            .is_err()
        );
    }
    let response = json!({"model":"fixture-model","embeddings":[[1,2],[3,4]]});
    let mut oversized = response.clone();
    oversized["extension"] = json!(vec![0; 5000]);
    assert!(
        decode_embedding(
            ProviderWireKind::Ollama,
            &model,
            2,
            oversized.to_string().as_bytes()
        )
        .is_err()
    );
    assert!(decode_embedding(ProviderWireKind::Ollama,&model,2,b"{\"model\":\"fixture-model\",\"model\":\"fixture-model\",\"embeddings\":[[1,2],[3,4]]}").is_err());
    assert_eq!(
        decode_embedding(
            ProviderWireKind::Ollama,
            &model,
            2,
            response.to_string().as_bytes()
        )
        .unwrap()
        .usage,
        ProviderUsage::Unknown
    );
    assert!(
        decode_embedding(
            ProviderWireKind::Ollama,
            &model,
            2,
            b"{\"model\":\"fixture-model\",\"embeddings\":[[NaN,2],[3,4]]}"
        )
        .is_err()
    );
}
#[test]
fn encoded_requests_keep_base_paths_roles_tools_and_conservative_limits() {
    assert_eq!(
        endpoint(
            "https://example.test/proxy/v1/",
            ProviderWireKind::OpenaiCompatible,
            "completion"
        )
        .unwrap(),
        "https://example.test/proxy/v1/chat/completions"
    );
    assert_eq!(
        endpoint(
            "https://example.test/proxy",
            ProviderWireKind::Ollama,
            "embedding"
        )
        .unwrap(),
        "https://example.test/proxy/api/embed"
    );
    assert!(
        endpoint(
            "https://example.test/?secret=x",
            ProviderWireKind::OpenaiCompatible,
            "check"
        )
        .is_err()
    );
    let model = model(ProviderModelKind::Completion);
    let mut request = CompletionRequest {
        intent: CommandKey::from_bytes([1; 16]),
        selection: ProviderSelection {
            project: None,
            provider: ProviderResourceId::from_bytes([1; 16]),
            model: model.id.clone(),
            runtime_epochs: ProviderRuntimeEpochs {
                resource: std::num::NonZeroU64::MIN,
                credential: None,
            },
            policy: ProviderPolicy {
                provider: ProviderResourceId::from_bytes([1; 16]),
                audience: ProviderAudience::Personal { consented: true },
                allowed_classes: DocClass::all(),
            },
        },
        messages: vec![CompletionMessage {
            role: CompletionRole::System,
            instruction: Some(
                ProviderInstruction::from_orchestrator("Use the declared tools.".into()).unwrap(),
            ),
            parts: vec![],
            tool_calls: vec![],
            result_for: None,
        }],
        tools: vec![ProviderToolDefinition {
            name: "lookup".into(),
            description: "Look up a city".into(),
            parameters: ProviderToolSchema::Object {
                properties: BTreeMap::from([(
                    "city".into(),
                    ProviderToolSchema::String { choices: vec![] },
                )]),
                required: BTreeSet::from(["city".into()]),
            },
        }],
        budget: CompletionBudget {
            max_input_tokens: model.max_input_tokens,
            max_output_tokens: 16,
            max_tool_calls: 4,
        },
    };
    let openai: Value = serde_json::from_slice(
        &completion(ProviderWireKind::OpenaiCompatible, &model, &request).unwrap(),
    )
    .unwrap();
    assert_eq!(openai["max_completion_tokens"], 16);
    assert!(openai.get("store").is_none());
    assert_eq!(openai["stream_options"]["include_usage"], true);
    assert_eq!(
        openai["tools"][0]["function"]["parameters"]["additionalProperties"],
        false
    );
    let ollama: Value =
        serde_json::from_slice(&completion(ProviderWireKind::Ollama, &model, &request).unwrap())
            .unwrap();
    assert_eq!(ollama["options"]["num_predict"], 16);
    assert!(ollama["options"].get("num_ctx").is_none());
    // Tighter caller max_input_tokens (< model cap) and Cyrillic + tool-output instructions succeed.
    request.budget.max_input_tokens = 4096;
    request.messages.push(CompletionMessage {
        role: CompletionRole::User,
        instruction: Some(
            ProviderInstruction::from_orchestrator("Привет! Проверь погоду в Москве.".into())
                .unwrap(),
        ),
        parts: vec![],
        tool_calls: vec![],
        result_for: None,
    });
    request.messages.push(CompletionMessage {
        role: CompletionRole::Assistant,
        instruction: None,
        parts: vec![],
        tool_calls: vec![ProviderToolCall {
            id: ProviderToolCallId::new("functions.lookup:0".into()).unwrap(),
            name: "lookup".into(),
            arguments: BTreeMap::new(),
        }],
        result_for: None,
    });
    request.messages.push(CompletionMessage {
        role: CompletionRole::Tool,
        instruction: None,
        parts: vec![],
        tool_calls: vec![],
        result_for: Some(ProviderToolCallId::new("functions.lookup:0".into()).unwrap()),
    });
    assert!(completion(ProviderWireKind::OpenaiCompatible, &model, &request).is_ok());
    request.messages.pop();
    assert!(
        completion(ProviderWireKind::OpenaiCompatible, &model, &request).is_err(),
        "unresolved tool calls cannot be sent as complete history"
    );
    request.messages.pop();
    request.messages.pop();
    request.budget.max_input_tokens = model.max_input_tokens + 1;
    assert!(completion(ProviderWireKind::OpenaiCompatible, &model, &request).is_err());
    request.budget.max_input_tokens = 1;
    assert!(completion(ProviderWireKind::OpenaiCompatible, &model, &request).is_err());
}

#[test]
fn token_estimates_use_shared_conservative_weights_and_preserve_message_framing() {
    let embed_request = |text: &str| {
        EmbeddingRequest::query(
            CommandKey::from_bytes([1; 16]),
            ModelProfileId::from_bytes([1; 16]),
            ProviderResourceId::from_bytes([1; 16]),
            EmbeddingQueryInput {
                text: text.into(),
                tokens: 1,
                classes: BTreeSet::from([DocClass::UserDoc]),
                project_scope: None,
                folder: None,
            },
        )
    };
    // ASCII prose: 12 chars * 4/12 = 4 tokens.
    assert_eq!(
        estimate_embedding_input_tokens(&embed_request("hello world ")).unwrap(),
        4
    );
    // Cyrillic (2B UTF-8): 6 chars * 12/12 = 6 tokens.
    assert_eq!(
        estimate_embedding_input_tokens(&embed_request("привет")).unwrap(),
        6
    );
    // Code punctuation/digits: 6 chars * 12/12 = 6 tokens.
    assert_eq!(
        estimate_embedding_input_tokens(&embed_request("a[0]+=1")).unwrap(),
        1 + 6
    );
    // CJK (3B UTF-8): 2 chars * 18/12 = 3 tokens.
    assert_eq!(
        estimate_embedding_input_tokens(&embed_request("東京")).unwrap(),
        3
    );
    // Emoji (4B UTF-8): 2 chars * 24/12 = 4 tokens.
    assert_eq!(
        estimate_embedding_input_tokens(&embed_request("🦀🚀")).unwrap(),
        4
    );

    let model = model(ProviderModelKind::Completion);
    let completion_req = CompletionRequest {
        intent: CommandKey::from_bytes([2; 16]),
        selection: ProviderSelection {
            project: None,
            provider: ProviderResourceId::from_bytes([1; 16]),
            model: model.id.clone(),
            runtime_epochs: ProviderRuntimeEpochs {
                resource: std::num::NonZeroU64::MIN,
                credential: None,
            },
            policy: ProviderPolicy {
                provider: ProviderResourceId::from_bytes([1; 16]),
                audience: ProviderAudience::Personal { consented: true },
                allowed_classes: DocClass::all(),
            },
        },
        messages: vec![CompletionMessage {
            role: CompletionRole::User,
            instruction: Some(ProviderInstruction::from_orchestrator("привет".into()).unwrap()),
            parts: vec![],
            tool_calls: vec![],
            result_for: None,
        }],
        tools: vec![],
        budget: CompletionBudget {
            max_input_tokens: 1024,
            max_output_tokens: 16,
            max_tool_calls: 0,
        },
    };
    // 4 framing tokens for the message + 6 conservative tokens for "привет".
    assert_eq!(
        estimate_completion_input_tokens(&completion_req).unwrap(),
        10
    );
}
