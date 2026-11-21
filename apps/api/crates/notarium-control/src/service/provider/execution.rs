use super::{admission::Snapshot, records::*, wire};
use crate::{error::invalid, store::lease::OperationBudget};
use notarium_core::{
    classes::ProviderMessage,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope},
    ports::{control::*, *},
};
use std::{collections::BTreeMap, future::Future, time::Duration};

pub(super) struct Runtime {
    pub budget: OperationBudget,
    pub cancelled: Cancellation,
    request: RequestId,
}
pub(super) struct CancelOnDrop(pub Cancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
fn cancelled(effect: CommitEffect) -> PortError {
    PortError::Cancelled(
        OperationalFailure::new(
            ContentDigest::from_bytes(*blake3::hash(b"provider operation cancelled").as_bytes()),
            effect,
            RetryAdvice::Never,
            false,
        )
        .expect("non-retryable failure"),
    )
}
impl Runtime {
    pub fn new(mut call: CallBudget) -> Self {
        call.remaining = call.remaining.min(Duration::from_secs(120));
        Self {
            request: call.request.clone(),
            budget: OperationBudget::new(call),
            cancelled: Cancellation::default(),
        }
    }
    pub fn check(&self, effect: CommitEffect) -> Result<(), PortError> {
        self.budget.check(effect)?;
        if self.cancelled.is_cancelled() {
            return Err(cancelled(effect));
        }
        Ok(())
    }
    pub async fn run<T>(
        &self,
        operation: impl Future<Output = Result<T, PortError>>,
        effect: CommitEffect,
    ) -> Result<T, PortError> {
        self.check(effect)?;
        let result = self
            .budget
            .run(
                async {
                    tokio::select! {
                        biased;
                        () = self.cancelled.cancelled() => Err(cancelled(effect)),
                        value = operation => value,
                    }
                },
                effect,
            )
            .await?;
        self.check(effect)?;
        Ok(result)
    }
    pub fn context(&self) -> CallBudget {
        self.budget.context(self.request.clone())
    }
    pub fn network_budget(
        &self,
        id: RequestId,
        timeout_ms: u32,
        expires: Option<i64>,
        now: i64,
    ) -> Result<CallBudget, PortError> {
        self.check(CommitEffect::NotCommitted)?;
        let mut remaining = self.context().remaining.min(
            Duration::from_millis(u64::from(timeout_ms))
                .saturating_sub(self.budget.started.elapsed()),
        );
        if let Some(expires) = expires {
            remaining = remaining.min(Duration::from_millis(
                expires.saturating_sub(now).max(0) as u64
            ));
        }
        if remaining.is_zero() {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        Ok(CallBudget {
            request: id,
            cancellation: self.cancelled.clone(),
            remaining,
        })
    }
}
pub(super) enum Request {
    Completion(CompletionRequest),
    Embedding(EmbeddingRequest),
    Check(CheckProviderConnection),
}
pub(super) struct Job {
    pub ctx: AccountContext,
    pub scope: Option<HistoryScope>,
    pub request: Request,
}
impl Job {
    pub fn completion(ctx: SpaceContext, request: CompletionRequest) -> Self {
        Self {
            ctx: AccountContext::new(ctx.auth().clone(), ctx.budget.clone()),
            scope: Some(ctx.scope().clone()),
            request: Request::Completion(request),
        }
    }
    pub fn embedding(ctx: SpaceContext, request: EmbeddingRequest) -> Self {
        Self {
            ctx: AccountContext::new(ctx.auth().clone(), ctx.budget.clone()),
            scope: Some(ctx.scope().clone()),
            request: Request::Embedding(request),
        }
    }
    pub fn connection(ctx: AccountContext, request: CheckProviderConnection) -> Self {
        Self {
            ctx,
            scope: None,
            request: Request::Check(request),
        }
    }
    pub fn resource(&self) -> &ProviderResourceId {
        match &self.request {
            Request::Completion(request) => &request.selection.provider,
            Request::Embedding(request) => &request.provider,
            Request::Check(request) => &request.resource,
        }
    }
    pub fn model(&self) -> Option<&ModelProfileId> {
        match &self.request {
            Request::Completion(request) => Some(&request.selection.model),
            Request::Embedding(request) => Some(&request.model),
            Request::Check(_) => None,
        }
    }
    pub fn project(&self) -> Option<&FolderRef> {
        match &self.request {
            Request::Completion(request) => request.selection.project.as_ref(),
            Request::Embedding(request) => request.project.as_ref(),
            Request::Check(_) => None,
        }
    }
    pub fn intent(&self) -> &CommandKey {
        match &self.request {
            Request::Completion(request) => &request.intent,
            Request::Embedding(request) => &request.intent,
            Request::Check(request) => &request.intent,
        }
    }
    pub fn operation(&self) -> &'static str {
        match &self.request {
            Request::Completion(_) => "completion",
            Request::Embedding(_) => "embedding",
            Request::Check(_) => "check",
        }
    }
    pub fn scope_key(&self) -> Result<String, PortError> {
        self.scope
            .as_ref()
            .map_or_else(|| Ok("account".into()), json)
    }
    pub fn fingerprint(&self) -> Result<[u8; 32], PortError> {
        let content = match &self.request {
            Request::Completion(request) => wire::completion_fingerprint(request)?,
            Request::Embedding(request) => wire::embedding_fingerprint(request)?,
            Request::Check(request) => {
                *blake3::hash(json(&("connection-v1", &request.resource))?.as_bytes()).as_bytes()
            }
        };
        Ok(
            *blake3::hash(json(&("provider-intent-v1", self.scope_key()?, content))?.as_bytes())
                .as_bytes(),
        )
    }
    pub fn parts(&self) -> Vec<ProviderMessage> {
        match &self.request {
            Request::Completion(request) => request
                .messages
                .iter()
                .flat_map(|message| message.parts.iter().cloned())
                .collect(),
            Request::Embedding(request) => request
                .inputs
                .iter()
                .filter_map(|input| match input {
                    EmbeddingInput::Part(part) => Some(ProviderMessage::Part(part.clone())),
                    EmbeddingInput::Query(_) => None,
                })
                .collect(),
            Request::Check(_) => vec![],
        }
    }
    pub fn embedding_inputs(&self) -> &[EmbeddingInput] {
        match &self.request {
            Request::Embedding(request) => &request.inputs,
            _ => &[],
        }
    }
    pub fn egress(&self, parts: &[ProviderMessage]) -> Result<ProviderEgressRequest, PortError> {
        let mut origins = BTreeMap::new();
        for part in parts {
            let origin = part.origin();
            origins.insert(json(&origin)?, origin);
        }
        if origins.len() > 4096 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(ProviderEgressRequest {
            origins: origins.into_values().collect(),
            project: self.project().cloned(),
        })
    }
    pub fn encode(&self, snapshot: &Snapshot) -> Result<Vec<u8>, PortError> {
        let wire = wire(&snapshot.resource.wire)?;
        match &self.request {
            Request::Completion(request) => wire::completion(
                wire,
                snapshot
                    .model
                    .as_ref()
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
                request,
            ),
            Request::Embedding(request) => wire::embedding(
                wire,
                snapshot
                    .model
                    .as_ref()
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
                request,
            ),
            Request::Check(_) => Ok(vec![]),
        }
    }
    pub fn reservation(&self, _snapshot: &Snapshot) -> Result<i64, PortError> {
        match &self.request {
            Request::Completion(request) => {
                let input = i64::from(wire::estimate_completion_input_tokens(request)?);
                let output = i64::from(request.budget.max_output_tokens);
                input
                    .checked_add(output)
                    .ok_or_else(|| invalid(ValidationReason::InvalidLimit))
            }
            Request::Embedding(request) => {
                Ok(i64::from(wire::estimate_embedding_input_tokens(request)?))
            }
            Request::Check(_) => Ok(0),
        }
    }
    pub fn usage_mismatch(&self, model: Option<&ProviderModelSpec>, usage: ProviderUsage) -> bool {
        let ProviderUsage::Exact {
            input_tokens,
            output_tokens,
        } = usage
        else {
            return false;
        };
        let model_cap = u64::from(model.map_or(0, |model| model.max_input_tokens));
        match &self.request {
            Request::Completion(request) => {
                let input_cap = u64::from(request.budget.max_input_tokens).min(model_cap);
                input_tokens > input_cap
                    || output_tokens > u64::from(request.budget.max_output_tokens)
            }
            Request::Embedding(_) => input_tokens > model_cap || output_tokens > 0,
            Request::Check(_) => input_tokens > 0 || output_tokens > 0,
        }
    }
}
