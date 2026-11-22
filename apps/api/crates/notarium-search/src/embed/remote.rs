use super::{EmbeddingError, normalize};
use crate::ports::RemoteIndexingGrant;
use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, ContentPart, DocClass},
    error::{BudgetKind, PortError, ValidationReason},
    ids::{CommandKey, ModelProfileId, ProviderResourceId},
    model::FolderRef,
    ports::{
        EmbeddingProviderPort, EmbeddingQueryInput, EmbeddingRequest, EmbeddingSelection,
        ProviderErrorCode, ProviderRuntimeEpochs, SpaceContext,
    },
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub struct RemoteEmbedder {
    port: Arc<dyn EmbeddingProviderPort>,
    pub model: ModelProfileId,
    pub provider: ProviderResourceId,
    pub dimension: u32,
    pub max_input_tokens: u32,
    runtime_epochs: ProviderRuntimeEpochs,
    default_project: Option<FolderRef>,
}

impl RemoteEmbedder {
    pub fn new(
        port: Arc<dyn EmbeddingProviderPort>,
        model: ModelProfileId,
        provider: ProviderResourceId,
        dimension: u32,
        max_input_tokens: u32,
        runtime_epochs: ProviderRuntimeEpochs,
        default_project: Option<FolderRef>,
    ) -> Self {
        Self {
            port,
            model,
            provider,
            dimension,
            max_input_tokens,
            runtime_epochs,
            default_project,
        }
    }

    pub async fn query(
        &self,
        mut ctx: SpaceContext,
        mut input: EmbeddingQueryInput,
        implicit: bool,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
        if ctx.auth().taint().is_tainted()
            || input.classes.is_empty()
            || input.classes.contains(&DocClass::EncryptedNote)
        {
            return Err(EmbeddingError::ProviderUnavailable);
        }
        if input.tokens > self.max_input_tokens || input.tokens == 0 {
            return Err(EmbeddingError::BudgetExceeded);
        }
        let started = Instant::now();
        let disclosed = self
            .port
            .query_disclosure(
                ctx.clone(),
                self.provider.clone(),
                self.model.clone(),
                input.project_scope.clone(),
                input.folder.clone(),
            )
            .await
            .map_err(query_port_error)?;
        input.classes.retain(|class| disclosed.contains(class));
        if input.classes.is_empty() || ctx.auth().taint().is_tainted() {
            return Err(EmbeddingError::ProviderUnavailable);
        }
        ctx.budget.remaining = ctx.budget.remaining.saturating_sub(started.elapsed());
        if ctx.budget.remaining.is_zero() {
            return Err(EmbeddingError::BudgetExceeded);
        }
        let mut intent = self.intent(&ctx, b"query", input.project_scope.as_ref(), implicit);
        if let Some(folder) = &input.folder {
            hash_field(&mut intent, folder.as_str().as_bytes());
        }
        hash_field(&mut intent, input.text.as_bytes());
        hash_field(&mut intent, &input.tokens.to_le_bytes());
        for class in &input.classes {
            hash_field(&mut intent, &[*class as u8]);
        }
        let request = EmbeddingRequest::query(
            command(intent),
            self.model.clone(),
            self.provider.clone(),
            input,
        );
        let mut rows = self
            .dispatch(ctx, request, implicit, query_port_error)
            .await?;
        let vector = rows
            .pop()
            .ok_or(EmbeddingError::ProviderUnavailable)?
            .map_err(query_provider_error)?;
        Ok(vec![Some(
            self.normalized_row(vector)
                .ok_or(EmbeddingError::ProviderUnavailable)?,
        )])
    }

    pub async fn parts(
        &self,
        grant: RemoteIndexingGrant,
        project: Option<FolderRef>,
        parts: Vec<ContentPart>,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
        if parts.len() > 16 || parts.is_empty() {
            return Err(EmbeddingError::BudgetExceeded);
        }
        if grant.policy.provider != self.provider {
            return Err(EmbeddingError::ProviderUnavailable);
        }
        if grant.ctx.auth().taint().is_tainted() {
            return Err(EmbeddingError::IndexingDenied);
        }
        let mut intent = self.intent(&grant.ctx, b"parts", project.as_ref(), true);
        let mut positions = Vec::new();
        let mut admitted = Vec::new();
        let mut total = 0u32;
        let mut output = vec![None; parts.len()];
        for (position, part) in parts.into_iter().enumerate() {
            if let Ok(part) = ClassEgressFence::provider_part(part, grant.ctx.auth(), &grant.policy)
            {
                let content = part.part();
                let document = part.provenance();
                hash_field(
                    &mut intent,
                    document.reference().note_id.as_str().as_bytes(),
                );
                hash_field(&mut intent, document.revision().as_str().as_bytes());
                hash_field(&mut intent, content.key().as_bytes());
                total = total
                    .checked_add(content.tokens())
                    .ok_or(EmbeddingError::PermanentInputRejected)?;
                positions.push(position);
                admitted.push(part);
            }
        }
        if admitted.is_empty() {
            return Err(EmbeddingError::IndexingDenied);
        }
        if total > self.max_input_tokens {
            return Err(EmbeddingError::PermanentInputRejected);
        }
        let request = EmbeddingRequest::parts(
            command(intent),
            self.model.clone(),
            self.provider.clone(),
            project,
            admitted,
            total,
        );
        let result = self
            .dispatch(grant.ctx, request, true, indexing_port_error)
            .await?;
        let mut permanent_error = None;
        let mut has_success = false;
        let mut has_transient_failure = false;
        for (position, row) in positions.into_iter().zip(result) {
            match row {
                Ok(vector) => {
                    if vector.len() != self.dimension as usize {
                        return Err(EmbeddingError::ProviderUnavailable);
                    }
                    if let Some(normalized) = self.normalized_row(vector) {
                        output[position] = Some(normalized);
                        has_success = true;
                    } else {
                        permanent_error.get_or_insert(EmbeddingError::PermanentInputRejected);
                    }
                }
                Err(error) => {
                    let mapped = indexing_provider_error(error);
                    if mapped.is_permanent_note_rejection() {
                        permanent_error.get_or_insert(mapped);
                    } else {
                        has_transient_failure = true;
                    }
                }
            }
        }
        if !has_success
            && !has_transient_failure
            && let Some(error) = permanent_error
        {
            return Err(error);
        }
        Ok(output)
    }

    async fn dispatch(
        &self,
        ctx: SpaceContext,
        mut request: EmbeddingRequest,
        implicit: bool,
        map_error: fn(PortError) -> EmbeddingError,
    ) -> Result<Vec<Result<Vec<f32>, DomainError>>, EmbeddingError> {
        if ctx.budget.cancellation.is_cancelled() {
            return Err(EmbeddingError::Cancelled);
        }
        if implicit {
            request.selection = EmbeddingSelection::SearchDefault {
                project: self.default_project.clone(),
            };
        }
        let request = request.with_runtime_epochs(self.runtime_epochs);
        request
            .validate()
            .map_err(|error| map_error(PortError::Domain(error)))?;
        let count = request.inputs.len();
        let result = self.port.embed(ctx, request).await.map_err(map_error)?;
        if result.model != self.model
            || result.dimension != self.dimension
            || result.vectors.len() != count
        {
            return Err(EmbeddingError::ProviderUnavailable);
        }
        Ok(result.vectors)
    }

    fn normalized_row(&self, vector: Vec<f32>) -> Option<Vec<f32>> {
        (vector.len() == self.dimension as usize)
            .then(|| normalize(&vector))
            .flatten()
    }

    fn intent(
        &self,
        ctx: &SpaceContext,
        lane: &[u8],
        project: Option<&FolderRef>,
        implicit: bool,
    ) -> blake3::Hasher {
        let mut hash =
            blake3::Hasher::new_derive_key("notarium/search/provider-embedding-intent/v1");
        hash_field(&mut hash, lane);
        if implicit {
            hash_field(&mut hash, b"search-default");
            if let Some(scope) = &self.default_project {
                hash_field(&mut hash, scope.space_id.as_str().as_bytes());
                hash_field(&mut hash, scope.folder_id.as_str().as_bytes());
            }
        }
        hash_field(&mut hash, ctx.scope().space_id.as_str().as_bytes());
        hash_field(&mut hash, ctx.budget.request.as_str().as_bytes());
        hash_field(&mut hash, self.model.as_str().as_bytes());
        hash_field(&mut hash, self.provider.as_str().as_bytes());
        hash_field(&mut hash, &self.runtime_epochs.resource.get().to_le_bytes());
        hash_field(
            &mut hash,
            &self
                .runtime_epochs
                .credential
                .map_or(0, |epoch| epoch.get())
                .to_le_bytes(),
        );
        if let Some(project) = project {
            hash_field(&mut hash, project.space_id.as_str().as_bytes());
            hash_field(&mut hash, project.folder_id.as_str().as_bytes());
        }
        hash
    }
}

fn query_port_error(error: PortError) -> EmbeddingError {
    match error {
        PortError::Domain(error) => query_provider_error(error),
        PortError::Cancelled(_) => EmbeddingError::Cancelled,
        PortError::DeadlineExceeded(_) => EmbeddingError::BudgetExceeded,
        _ => EmbeddingError::ProviderUnavailable,
    }
}

fn query_provider_error(error: DomainError) -> EmbeddingError {
    match error {
        DomainError::ValidationFailed { diagnostic }
            if matches!(
                diagnostic.reason,
                ValidationReason::BudgetExceeded | ValidationReason::TokenBudgetExceeded
            ) =>
        {
            EmbeddingError::BudgetExceeded
        }
        DomainError::ValidationFailed { diagnostic }
            if diagnostic.reason == ValidationReason::NotReady =>
        {
            EmbeddingError::TargetChanged
        }
        DomainError::RateLimited { .. } => EmbeddingError::BudgetExceeded,
        DomainError::Provider {
            error: ProviderErrorCode::BudgetMismatch,
        } => EmbeddingError::BudgetExceeded,
        _ => EmbeddingError::ProviderUnavailable,
    }
}

fn indexing_port_error(error: PortError) -> EmbeddingError {
    match error {
        PortError::Domain(error) => indexing_provider_error(error),
        PortError::Cancelled(_) => EmbeddingError::Cancelled,
        PortError::DeadlineExceeded(_) => EmbeddingError::BudgetExceeded,
        _ => EmbeddingError::ProviderUnavailable,
    }
}

fn indexing_provider_error(error: DomainError) -> EmbeddingError {
    match error {
        DomainError::ResourceNotFound | DomainError::CrossSpaceTainted => {
            EmbeddingError::IndexingDenied
        }
        DomainError::ValidationFailed { diagnostic } => match diagnostic.reason {
            ValidationReason::ClassEgressForbidden
            | ValidationReason::ClassMismatch
            | ValidationReason::SourceMismatch => EmbeddingError::IndexingDenied,
            ValidationReason::TokenBudgetExceeded | ValidationReason::InvalidLimit => {
                EmbeddingError::PermanentInputRejected
            }
            ValidationReason::BudgetExceeded => EmbeddingError::BudgetExceeded,
            _ => EmbeddingError::ProviderUnavailable,
        },
        // Every note in this Space targets the same resource and credential.
        // Only the number of requested tokens can make a smaller note fit.
        DomainError::RateLimited {
            budget: BudgetKind::Requests | BudgetKind::Concurrency,
            retry_after_ms,
        } => EmbeddingError::IndexingThrottled(Duration::from_millis(retry_after_ms)),
        DomainError::RateLimited { .. } => EmbeddingError::BudgetExceeded,
        DomainError::Provider {
            error: ProviderErrorCode::BudgetMismatch,
        } => EmbeddingError::BudgetExceeded,
        _ => EmbeddingError::ProviderUnavailable,
    }
}

fn hash_field(hash: &mut blake3::Hasher, bytes: &[u8]) {
    hash.update(&(bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

fn command(hash: blake3::Hasher) -> CommandKey {
    let mut bytes = [0; 16];
    hash.finalize_xof().fill(&mut bytes);
    CommandKey::from_bytes(bytes)
}
