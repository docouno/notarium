use super::{EmbeddingError, normalize};
use crate::ports::RemoteIndexingGrant;
use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, ContentPart, DocClass},
    error::ValidationReason,
    ids::{CommandKey, ModelProfileId, ProviderResourceId},
    model::FolderRef,
    ports::{
        EmbeddingProviderPort, EmbeddingQueryInput, EmbeddingRequest, ProviderErrorCode,
        SpaceContext,
    },
};
use std::sync::Arc;

pub struct RemoteEmbedder {
    port: Arc<dyn EmbeddingProviderPort>,
    pub model: ModelProfileId,
    pub provider: ProviderResourceId,
    pub dimension: u32,
    pub max_input_tokens: u32,
}

impl RemoteEmbedder {
    pub fn new(
        port: Arc<dyn EmbeddingProviderPort>,
        model: ModelProfileId,
        provider: ProviderResourceId,
        dimension: u32,
        max_input_tokens: u32,
    ) -> Self {
        Self {
            port,
            model,
            provider,
            dimension,
            max_input_tokens,
        }
    }

    pub async fn query(
        &self,
        ctx: SpaceContext,
        input: EmbeddingQueryInput,
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
        let mut intent = self.intent(&ctx, b"query", input.project_scope.as_ref());
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
        self.dispatch(ctx, request).await
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
        if grant.ctx.auth().taint().is_tainted() || grant.policy.provider != self.provider {
            return Err(EmbeddingError::ProviderUnavailable);
        }
        let mut intent = self.intent(&grant.ctx, b"parts", project.as_ref());
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
                    .ok_or(EmbeddingError::BudgetExceeded)?;
                positions.push(position);
                admitted.push(part);
            }
        }
        if total > self.max_input_tokens {
            return Err(EmbeddingError::BudgetExceeded);
        }
        if !admitted.is_empty() {
            let request = EmbeddingRequest::parts(
                command(intent),
                self.model.clone(),
                self.provider.clone(),
                project,
                admitted,
                total,
            );
            let result = self.dispatch(grant.ctx, request).await?;
            for (position, vector) in positions.into_iter().zip(result) {
                output[position] = vector;
            }
        }
        Ok(output)
    }

    async fn dispatch(
        &self,
        ctx: SpaceContext,
        request: EmbeddingRequest,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
        if ctx.budget.cancellation.is_cancelled() {
            return Err(EmbeddingError::Cancelled);
        }
        request.validate().map_err(provider_error)?;
        let count = request.inputs.len();
        let result = self
            .port
            .embed(ctx, request)
            .await
            .map_err(|error| match error {
                notarium_core::error::PortError::Domain(error) => provider_error(error),
                notarium_core::error::PortError::Cancelled(_) => EmbeddingError::Cancelled,
                notarium_core::error::PortError::DeadlineExceeded(_) => {
                    EmbeddingError::BudgetExceeded
                }
                _ => EmbeddingError::ProviderUnavailable,
            })?;
        if result.model != self.model
            || result.dimension != self.dimension
            || result.vectors.len() != count
        {
            return Err(EmbeddingError::ProviderUnavailable);
        }
        Ok(result
            .vectors
            .into_iter()
            .map(|vector| {
                let vector = vector.ok()?;
                (vector.len() == self.dimension as usize)
                    .then(|| normalize(&vector))
                    .flatten()
            })
            .collect())
    }

    fn intent(
        &self,
        ctx: &SpaceContext,
        lane: &[u8],
        project: Option<&FolderRef>,
    ) -> blake3::Hasher {
        let mut hash =
            blake3::Hasher::new_derive_key("notarium/search/provider-embedding-intent/v1");
        hash_field(&mut hash, lane);
        hash_field(&mut hash, ctx.scope().space_id.as_str().as_bytes());
        hash_field(&mut hash, ctx.budget.request.as_str().as_bytes());
        hash_field(&mut hash, self.model.as_str().as_bytes());
        hash_field(&mut hash, self.provider.as_str().as_bytes());
        if let Some(project) = project {
            hash_field(&mut hash, project.space_id.as_str().as_bytes());
            hash_field(&mut hash, project.folder_id.as_str().as_bytes());
        }
        hash
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

fn provider_error(error: DomainError) -> EmbeddingError {
    match error {
        DomainError::ValidationFailed { diagnostic }
            if matches!(
                diagnostic.reason,
                ValidationReason::BudgetExceeded | ValidationReason::TokenBudgetExceeded
            ) =>
        {
            EmbeddingError::BudgetExceeded
        }
        DomainError::Provider {
            error: ProviderErrorCode::BudgetMismatch,
        } => EmbeddingError::BudgetExceeded,
        _ => EmbeddingError::ProviderUnavailable,
    }
}
