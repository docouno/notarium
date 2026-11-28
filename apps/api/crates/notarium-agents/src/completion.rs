use std::{collections::BTreeSet, future::Future, time::Duration};

use notarium_control::service::provider::{completion_input_estimate, completion_text_estimate};
use notarium_core::{
    DomainError,
    auth::PrincipalKind,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{AgentRunId, CommandKey, ContentDigest, EpisodeId},
    ports::{
        AppendChat, CallBudget, Cancellation, CompletionBudget, CompletionEvent, CompletionFinish,
        CompletionRequest, ControlPort, ProviderErrorCode, ProviderToolCall, ProviderToolCallId,
        ProviderUsage, RunLimits, SpaceContext,
    },
};
use tokio::time::Instant;

use crate::mcp::{ToolRegistry, derive_key};

const MAX_MODEL_TEXT_BYTES: usize = 200 * 1024;
const MAX_TURN_PAYLOAD_BYTES: usize = AppendChat::MAX_STRUCTURED_BODY_BYTES - 1024;
const TOOL_DISPLAY_BYTES: usize = 32 * 1024;
const MAX_STEP_TOOL_DISPLAY_BYTES: usize = 1024 * 1024;
const MAX_CALL_TIME: Duration = Duration::from_secs(120);

fn json_escaped_len(text: &str) -> usize {
    text.chars().fold(0usize, |used, ch| {
        used + match ch {
            '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
            '\0'..='\u{1f}' => 6,
            ch => ch.len_utf8(),
        }
    })
}

pub(crate) struct CompletionRunBudget {
    next_step: u32,
    max_steps: u32,
    remaining_tokens: u64,
    deadline: Instant,
}

struct Reservation {
    step: u32,
    tokens: u64,
    deadline: Instant,
}

impl CompletionRunBudget {
    pub(crate) fn new(limits: RunLimits, started: Instant) -> Result<Self, PortError> {
        if !limits.fits(RunLimits::HARD_CEILING) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(Self {
            next_step: 0,
            max_steps: limits.max_steps,
            remaining_tokens: limits.max_tokens,
            deadline: started + Duration::from_millis(limits.timeout_ms),
        })
    }

    pub(crate) fn next_step(&self) -> u32 {
        self.next_step
    }

    pub(crate) fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub(crate) fn input_ceiling(&self) -> u32 {
        u32::try_from(self.remaining_tokens.saturating_sub(1)).unwrap_or(u32::MAX)
    }

    fn reserve(
        &mut self,
        request: &mut CompletionRequest,
        call: &mut CallBudget,
    ) -> Result<Reservation, PortError> {
        if call.cancellation.is_cancelled() {
            return Err(cancelled(CommitEffect::NotCommitted));
        }
        if self.remaining().is_zero() || call.remaining.is_zero() {
            return Err(deadline(CommitEffect::NotCommitted));
        }
        if self.next_step >= self.max_steps {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let model = request
            .selection
            .completion
            .ok_or_else(|| invalid(ValidationReason::MissingModelProfile))?;
        if !request.tools.is_empty()
            && (!model.supports_tools || request.budget.max_tool_calls == 0)
        {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        let estimate = u64::from(completion_input_estimate(request)?);
        let model_input = request.budget.max_input_tokens.min(model.max_input_tokens);
        if estimate > u64::from(model_input) {
            return Err(invalid(ValidationReason::TokenBudgetExceeded));
        }
        let output = self
            .remaining_tokens
            .checked_sub(estimate)
            .filter(|left| *left > 0)
            .ok_or_else(|| invalid(ValidationReason::TokenBudgetExceeded))?
            .min(u64::from(
                request
                    .budget
                    .max_output_tokens
                    .min(model.max_output_tokens),
            ));
        if output == 0 {
            return Err(invalid(ValidationReason::TokenBudgetExceeded));
        }
        let input = u64::from(model_input).min(self.remaining_tokens - output);
        request.budget.max_input_tokens = input as u32;
        request.budget.max_output_tokens = output as u32;
        call.remaining = self.remaining().min(call.remaining).min(MAX_CALL_TIME);
        if call.remaining.is_zero() {
            return Err(deadline(CommitEffect::NotCommitted));
        }
        let reserved = Reservation {
            step: self.next_step,
            tokens: input + output,
            deadline: Instant::now() + call.remaining,
        };
        self.next_step += 1;
        self.remaining_tokens -= reserved.tokens;
        Ok(reserved)
    }

    fn settle(&mut self, reservation: Reservation, actual: u64) {
        // An indeterminate dispatch or malformed terminal stream keeps its full
        // reservation. Settled exact usage can return only this call's balance.
        debug_assert!(actual <= reservation.tokens);
        self.remaining_tokens += reservation.tokens.saturating_sub(actual);
    }
}

pub(crate) struct CompletionActor<'a> {
    pub run: &'a AgentRunId,
    pub episode: Option<&'a EpisodeId>,
}

pub(crate) struct SettledStep {
    pub text: String,
    pub calls: Vec<ProviderToolCall>,
    pub finish: CompletionFinish,
}

/// Classify a terminal response after its partial text has been persisted.
pub(crate) fn terminal_outcome(finish: CompletionFinish) -> Result<(), PortError> {
    match finish {
        CompletionFinish::Stop => Ok(()),
        CompletionFinish::Length => Err(invalid(ValidationReason::TokenBudgetExceeded)),
        CompletionFinish::ContentFilter => Err(invalid(ValidationReason::ProviderContentFiltered)),
        CompletionFinish::ToolCalls => Err(protocol()),
    }
}

/// Wait for wire validation and durable provider settlement before arming a
/// tool. The caller still owns the durable Model/Tool append and any effects.
pub(crate) async fn complete_step(
    control: &dyn ControlPort,
    registry: &ToolRegistry,
    mut ctx: SpaceContext,
    mut request: CompletionRequest,
    actor: CompletionActor<'_>,
    run_budget: &mut CompletionRunBudget,
    mut text_delta: impl FnMut(&str) -> Result<(), PortError> + Send,
) -> Result<SettledStep, PortError> {
    match ctx.auth().kind() {
        PrincipalKind::AgentRun(run) if run == actor.run && actor.episode.is_some() => (),
        PrincipalKind::Keeper(run) if run == actor.run && actor.episode.is_none() => (),
        _ => return Err(invalid(ValidationReason::InvalidAuthority)),
    }
    let reservation = run_budget.reserve(&mut request, &mut ctx.budget)?;
    let budget = request.budget.clone();
    let allowed = request
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<BTreeSet<_>>();
    let admissions = ctx.auth().clone();
    let cancellation = ctx.budget.cancellation.clone();
    let mut stream = within(&reservation, &cancellation, control.complete(ctx, request)).await?;
    let mut text = String::new();
    let mut escaped_text_bytes = 0usize;
    let mut tool_calls_bytes = 0usize;
    let mut calls = Vec::new();
    let mut raw_ids = BTreeSet::new();
    let mut usage = None;
    let mut finish = None;
    while let Some(event) = within(&reservation, &cancellation, stream.next()).await? {
        if finish.is_some() {
            return Err(protocol());
        }
        match event {
            CompletionEvent::Text(delta) => {
                if usage.is_some() || !calls.is_empty() {
                    return Err(protocol());
                }
                let delta_escaped = json_escaped_len(&delta);
                if delta.len() > MAX_MODEL_TEXT_BYTES.saturating_sub(text.len())
                    || escaped_text_bytes
                        .saturating_add(delta_escaped)
                        .saturating_add(tool_calls_bytes)
                        > MAX_TURN_PAYLOAD_BYTES
                {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                text_delta(&delta)?;
                text.push_str(&delta);
                escaped_text_bytes += delta_escaped;
            }
            CompletionEvent::ToolCall(mut call) => {
                if usage.is_some()
                    || calls.len() >= usize::from(budget.max_tool_calls)
                    || !allowed.contains(&call.name)
                    || !raw_ids.insert(call.id.clone())
                {
                    return Err(protocol());
                }
                registry.validate_provider_call(&admissions, actor.episode, &mut call)?;
                let ordinal = u16::try_from(calls.len()).map_err(|_| protocol())?;
                let stable = derive_key(
                    "notarium:tool-call:v1",
                    &[
                        actor.run.as_str().as_bytes(),
                        &reservation.step.to_be_bytes(),
                        &ordinal.to_be_bytes(),
                        call.id.as_str().as_bytes(),
                    ],
                );
                call.id = ProviderToolCallId::new(stable.to_string())?;
                let call_bytes = serde_json::to_vec(&call)
                    .map_err(|_| protocol())?
                    .len()
                    .saturating_add(2);
                if escaped_text_bytes
                    .saturating_add(tool_calls_bytes)
                    .saturating_add(call_bytes)
                    > MAX_TURN_PAYLOAD_BYTES
                {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                tool_calls_bytes += call_bytes;
                calls.push(call);
            }
            CompletionEvent::Usage(measured) if usage.is_none() => usage = Some(measured),
            CompletionEvent::Finished(reason) if usage.is_some() => finish = Some(reason),
            _ => return Err(protocol()),
        }
    }
    let finish = finish.ok_or_else(protocol)?;
    match finish {
        CompletionFinish::ToolCalls if calls.is_empty() => return Err(protocol()),
        CompletionFinish::ToolCalls => {}
        CompletionFinish::Stop | CompletionFinish::ContentFilter if !calls.is_empty() => {
            return Err(protocol());
        }
        CompletionFinish::Stop | CompletionFinish::ContentFilter => {}
        CompletionFinish::Length => {
            // A truncated completion may include partial or unverified tool
            // calls alongside generated text. Drop tool calls so they are not
            // executed and preserve the partial text with Length interruption.
            calls.clear();
        }
    }
    let charge_tokens = charge(&budget, usage.ok_or_else(protocol)?)?;
    run_budget.settle(reservation, charge_tokens);
    Ok(SettledStep {
        text,
        calls,
        finish,
    })
}

fn charge(budget: &CompletionBudget, usage: ProviderUsage) -> Result<u64, PortError> {
    let input_limit = u64::from(budget.max_input_tokens);
    let output_limit = u64::from(budget.max_output_tokens);
    match usage {
        ProviderUsage::Exact {
            input_tokens,
            output_tokens,
        } if input_tokens <= input_limit && output_tokens <= output_limit => {
            Ok(input_tokens + output_tokens)
        }
        ProviderUsage::Exact { .. } => Err(invalid(ValidationReason::TokenBudgetExceeded)),
        ProviderUsage::Unknown => Ok(input_limit + output_limit),
    }
}

async fn within<T>(
    reservation: &Reservation,
    cancellation: &Cancellation,
    work: impl Future<Output = Result<T, PortError>>,
) -> Result<T, PortError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(cancelled(CommitEffect::Unknown)),
        () = tokio::time::sleep_until(reservation.deadline) => Err(deadline(CommitEffect::Unknown)),
        result = work => result,
    }
}

pub(crate) fn call_key(call: &ProviderToolCall) -> Result<CommandKey, PortError> {
    Ok(CommandKey::parse(call.id.as_str())?)
}

/// Compute a per-tool (max_bytes, max_tokens) display budget so an unsplittable
/// `Assistant + N Tool` group always fits comfortably inside the model window
/// and remains compactable on future turns.
pub(crate) fn step_tool_display_budget(
    input_ceiling: u32,
    fixed_tokens: u32,
    assistant_text: &str,
    calls: &[ProviderToolCall],
) -> (usize, u64) {
    let count = calls.len().max(1);
    let mut assistant_tokens = 4_u64.saturating_add(completion_text_estimate(assistant_text));
    for call in calls {
        let args_len = serde_json::to_string(&call.arguments)
            .map(|encoded| completion_text_estimate(&encoded))
            .unwrap_or(64);
        assistant_tokens = assistant_tokens
            .saturating_add(8)
            .saturating_add(completion_text_estimate(&call.name))
            .saturating_add(args_len);
    }
    let ceiling = u64::from(input_ceiling);
    let headroom = ceiling
        .saturating_sub(u64::from(fixed_tokens))
        .saturating_sub(assistant_tokens);
    // Reserve room for follow-up turn + compaction summary checkpoint framing
    // (`MAX_SUMMARY_TOKENS + 4` when headroom allows) so the latest group stays
    // compactable on tight windows and never overshoots with many tool calls.
    let reserve = 2_052_u64.min(headroom / 2);
    let step_tokens = headroom.saturating_sub(reserve).min(ceiling / 2);
    let per_tool_slot = step_tokens / (count as u64);
    let per_tool_tokens = per_tool_slot.saturating_sub(4);
    let per_tool_bytes = TOOL_DISPLAY_BYTES.min((MAX_STEP_TOOL_DISPLAY_BYTES / count).max(256));
    (per_tool_bytes, per_tool_tokens)
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

pub(crate) fn bounded_tool_text_within(text: &str, max_bytes: usize, max_tokens: u64) -> String {
    const SUFFIX: &str = "\n…[truncated]";
    if max_tokens == 0 || max_bytes == 0 {
        return String::new();
    }
    let suffix_fits = max_bytes >= SUFFIX.len() && completion_text_estimate(SUFFIX) <= max_tokens;
    let byte_cap = max_bytes.min(TOOL_DISPLAY_BYTES);
    let mut truncated = text.len() > byte_cap;
    let mut end = if truncated {
        let content_cap = if suffix_fits {
            byte_cap.saturating_sub(SUFFIX.len())
        } else {
            byte_cap
        };
        floor_char_boundary(text, content_cap)
    } else {
        text.len()
    };
    let fits = |prefix_end: usize, is_truncated: bool| -> bool {
        if !is_truncated || !suffix_fits {
            completion_text_estimate(&text[..prefix_end]) <= max_tokens
        } else {
            let mut candidate = String::with_capacity(prefix_end + SUFFIX.len());
            candidate.push_str(&text[..prefix_end]);
            candidate.push_str(SUFFIX);
            completion_text_estimate(&candidate) <= max_tokens
        }
    };
    if !fits(end, truncated) {
        truncated = true;
        let max_prefix_bytes = if suffix_fits {
            byte_cap.saturating_sub(SUFFIX.len())
        } else {
            byte_cap
        };
        let mut lo = 0usize;
        let mut hi = floor_char_boundary(text, max_prefix_bytes.min(end));
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            let mut cut = floor_char_boundary(text, mid);
            if cut == lo {
                cut = ceil_char_boundary(text, lo + 1);
            }
            if fits(cut, true) {
                lo = cut;
            } else {
                hi = floor_char_boundary(text, cut.saturating_sub(1));
            }
        }
        end = lo;
    }
    if !truncated || !suffix_fits {
        return text[..end].to_owned();
    }
    let mut display = text[..end].to_owned();
    display.push_str(SUFFIX);
    display
}

fn protocol() -> PortError {
    DomainError::Provider {
        error: ProviderErrorCode::Protocol,
    }
    .into()
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

fn failure(label: &str, effect: CommitEffect) -> OperationalFailure {
    OperationalFailure::new(
        ContentDigest::from_bytes(*blake3::hash(label.as_bytes()).as_bytes()),
        effect,
        RetryAdvice::Never,
        false,
    )
    .expect("non-retryable operational failure")
}

fn cancelled(effect: CommitEffect) -> PortError {
    PortError::Cancelled(failure("completion cancelled", effect))
}

fn deadline(effect: CommitEffect) -> PortError {
    PortError::DeadlineExceeded(failure("completion deadline", effect))
}

#[cfg(test)]
mod tests;
