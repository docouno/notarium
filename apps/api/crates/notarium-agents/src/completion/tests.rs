use std::collections::BTreeMap;

use super::*;
use notarium_core::{
    classes::{DocClass, ProviderAudience, ProviderPolicy},
    ids::{ModelProfileId, PrincipalId, ProviderResourceId, RequestId},
    ports::{
        CompletionMessage, CompletionModelLimits, CompletionRole, ProviderInstruction,
        ProviderRevocationScope, ProviderRuntimeEpochs, ProviderSelection,
    },
};

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([1; 16]),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(180),
    }
}

#[test]
fn a_filtered_terminal_reply_has_a_safe_failure_reason() {
    assert!(matches!(
        terminal_outcome(CompletionFinish::ContentFilter),
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::ProviderContentFiltered
    ));
}

fn request() -> CompletionRequest {
    let provider = ProviderResourceId::from_bytes([2; 16]);
    CompletionRequest {
        intent: CommandKey::from_bytes([3; 16]),
        selection: ProviderSelection {
            provider: provider.clone(),
            model: ModelProfileId::from_bytes([4; 16]),
            runtime_epochs: ProviderRuntimeEpochs {
                resource: std::num::NonZeroU64::MIN,
                credential: None,
            },
            project: None,
            project_only: None,
            policy: ProviderPolicy {
                provider,
                audience: ProviderAudience::Personal { consented: true },
                allowed_classes: DocClass::all(),
            },
            completion: Some(CompletionModelLimits {
                max_input_tokens: 5000,
                max_output_tokens: 200,
                supports_tools: false,
            }),
            revocation_scope: ProviderRevocationScope {
                owner: PrincipalId::from_bytes([5; 16]),
                credential: None,
            },
        },
        secondary_projects: Vec::new(),
        messages: vec![CompletionMessage {
            role: CompletionRole::User,
            instruction: Some(ProviderInstruction::from_orchestrator("One reply".into()).unwrap()),
            parts: Vec::new(),
            tool_calls: Vec::new(),
            result_for: None,
        }],
        tools: Vec::new(),
        budget: CompletionBudget {
            max_input_tokens: 1000,
            max_output_tokens: 500,
            max_tool_calls: 0,
        },
    }
}

#[test]
fn reservation_clamps_to_model_and_run_and_refunds_exact_usage_once() {
    let mut run = CompletionRunBudget::new(
        RunLimits {
            max_steps: 2,
            max_tokens: 150,
            timeout_ms: 180_000,
        },
        Instant::now(),
    )
    .unwrap();
    let mut first = request();
    let mut call = budget();
    let reservation = run.reserve(&mut first, &mut call).unwrap();
    assert_eq!(call.remaining, MAX_CALL_TIME);
    assert!(first.budget.max_output_tokens < 150);
    assert!(first.budget.max_input_tokens > 0);
    assert_eq!(
        u64::from(first.budget.max_input_tokens) + u64::from(first.budget.max_output_tokens),
        150
    );
    let exact = ProviderUsage::Exact {
        input_tokens: 5,
        output_tokens: 20,
    };
    let actual = charge(&first.budget, exact).unwrap();
    run.settle(reservation, actual);
    assert_eq!(run.remaining_tokens, 125);
    assert_eq!(run.next_step(), 1);

    let mut second = request();
    let second_reservation = run.reserve(&mut second, &mut budget()).unwrap();
    assert_eq!(second_reservation.step, 1);
    assert_eq!(charge(&second.budget, ProviderUsage::Unknown).unwrap(), 125);
    assert_eq!(run.remaining_tokens, 0);
    assert!(run.reserve(&mut request(), &mut budget()).is_err());
}

#[test]
fn actual_usage_above_either_cap_invalidates_the_step() {
    let limit = CompletionBudget {
        max_input_tokens: 20,
        max_output_tokens: 10,
        max_tool_calls: 0,
    };
    assert!(
        charge(
            &limit,
            ProviderUsage::Exact {
                input_tokens: 21,
                output_tokens: 0
            }
        )
        .is_err()
    );
    assert!(
        charge(
            &limit,
            ProviderUsage::Exact {
                input_tokens: 0,
                output_tokens: 11
            }
        )
        .is_err()
    );
    assert_eq!(charge(&limit, ProviderUsage::Unknown).unwrap(), 30);
}

#[test]
fn four_large_tool_outputs_fit_within_32k_model_window() {
    let calls: Vec<ProviderToolCall> = (0..4)
        .map(|i| ProviderToolCall {
            id: ProviderToolCallId::new(format!("call-{i}")).unwrap(),
            name: "get_note".into(),
            arguments: Default::default(),
        })
        .collect();
    let (max_bytes, max_tokens) = step_tool_display_budget(32_768, 2_000, "Reading notes.", &calls);
    let large_ascii = "alpha beta gamma delta ".repeat(2_000);
    assert!(large_ascii.len() > TOOL_DISPLAY_BYTES);
    let large_utf8 =
        "caf\u{00E9} na\u{00EF}ve r\u{00E9}sum\u{00E9} \u{2014} \u{1F4D3} ".repeat(1_500);
    let bounded_ascii = bounded_tool_text_within(&large_ascii, max_bytes, max_tokens);
    let bounded_utf8 = bounded_tool_text_within(&large_utf8, max_bytes, max_tokens);
    assert!(bounded_ascii.ends_with("\n…[truncated]"));
    assert!(bounded_utf8.ends_with("\n…[truncated]"));
    assert!(bounded_ascii.len() <= max_bytes);
    assert!(bounded_utf8.len() <= max_bytes);
    assert!(completion_text_estimate(&bounded_ascii) <= max_tokens);
    assert!(completion_text_estimate(&bounded_utf8) <= max_tokens);
    // All 4 tool outputs plus fixed prompt overhead stay well under 32,768 tokens.
    assert!(2_000 + 4 * (completion_text_estimate(&bounded_ascii) + 8) < 32_768);
}

#[test]
fn tight_8k_multi_tool_budget_never_overshoots_and_utf8_search_keeps_full_char() {
    let calls: Vec<ProviderToolCall> = (0..64_u8)
        .map(|i| ProviderToolCall {
            id: ProviderToolCallId::new(format!("call-{i}")).unwrap(),
            name: "get_note".into(),
            arguments: BTreeMap::from([("ref".into(), serde_json::json!(format!("note-{i}")))]),
        })
        .collect();
    let (max_bytes, max_tokens) =
        step_tool_display_budget(8_192, 4_500, "Calling 64 tools.", &calls);
    let sample = "alpha beta gamma ".repeat(100);
    let rendered = bounded_tool_text_within(&sample, max_bytes, max_tokens);
    let rendered_tokens = completion_text_estimate(&rendered);
    assert!(rendered_tokens <= max_tokens);
    let per_tool_total = (4 + rendered_tokens) * 64;
    assert!(
        4_500 + per_tool_total <= 8_192,
        "64 tool outputs must not overshoot 8k window (total {})",
        4_500 + per_tool_total
    );

    // 4-byte emoji followed by 2-byte accented char: boundary 4 must be kept when it fits.
    let pair = "\u{1F4D3}\u{00E9}";
    let emoji_tokens = completion_text_estimate("\u{1F4D3}");
    let clipped = bounded_tool_text_within(pair, 4, emoji_tokens);
    assert_eq!(clipped, "\u{1F4D3}");
}
