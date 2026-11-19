use crate::{
    config::VectorMode,
    embed::{
        EmbeddingError, OrtModel, Pooling, Priority, RemoteConservativeTokenizerBudget,
        RemoteEmbedder, bounded_batches, deterministic_embedding,
    },
    engine::Services,
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget, SearchIndexedNote},
    vector::{
        ChunkMetadata, MAX_DIMENSION, MIN_DIMENSION, QuantizedVector, VectorChunk, VectorEpoch,
    },
};
use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, ClassifiedDocument, ContentPart, DocClass, SearchContent},
    document::{ChunkDescriptor, ChunkPlan},
    error::ValidationReason,
    ids::{FolderId, ModelProfileId},
    model::{FolderRef, HistoryScope},
    ports::{CallBudget, EmbeddingQueryInput, SpaceContext},
};
use notarium_syntax::chunk::TokenizerBudget;
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct LocalModels(Mutex<Option<InstalledModel>>);

struct InstalledModel {
    profile: ModelProfileId,
    dimension: u32,
    max_input_tokens: u32,
    model: Arc<OrtModel>,
}

pub(super) struct Embedder {
    pub target: ResolvedEmbeddingTarget,
    backend: Backend,
    tokenizer: Arc<dyn TokenizerBudget + Send + Sync>,
}

enum Backend {
    Onnx(Arc<OrtModel>),
    Remote(Arc<RemoteEmbedder>),
    Deterministic,
}

impl Services {
    pub async fn model_target(
        &self,
        scope: &HistoryScope,
        project: Option<&FolderId>,
        explicit: Option<&ModelProfileId>,
    ) -> Result<Option<ResolvedEmbeddingTarget>, EmbeddingError> {
        if matches!(self.config.vector_mode, VectorMode::Disabled) {
            return Ok(None);
        }
        let target = if let Some(resolver) = &self.deps.model_resolver {
            resolver
                .resolve_model(scope, project, explicit)
                .await
                .map_err(|_| EmbeddingError::ModelUnavailable)?
        } else if let VectorMode::DeterministicTest { dimension } = self.config.vector_mode {
            let model = ModelProfileId::from_bytes(*b"deterministic-v1");
            explicit
                .is_none_or(|explicit| *explicit == model)
                .then_some(ResolvedEmbeddingTarget {
                    model,
                    dimension,
                    max_input_tokens: 512,
                    backend: EmbeddingBackendTarget::LocalOnnx,
                })
        } else {
            None
        };
        match target {
            Some(target)
                if (MIN_DIMENSION..=MAX_DIMENSION).contains(&(target.dimension as usize))
                    && target.max_input_tokens > 0
                    && explicit.is_none_or(|explicit| *explicit == target.model) =>
            {
                Ok(Some(target))
            }
            _ => Err(EmbeddingError::ModelUnavailable),
        }
    }

    pub async fn embedder(
        &self,
        target: ResolvedEmbeddingTarget,
        load_local: bool,
    ) -> Result<Embedder, EmbeddingError> {
        let conservative = || {
            Arc::new(RemoteConservativeTokenizerBudget::new(
                target.model.clone(),
                target.max_input_tokens,
            ))
        };
        let (backend, tokenizer): (_, Arc<dyn TokenizerBudget + Send + Sync>) =
            match (&self.config.vector_mode, &target.backend) {
                (VectorMode::Disabled, _) => return Err(EmbeddingError::ModelUnavailable),
                (VectorMode::DeterministicTest { dimension }, _)
                    if *dimension == target.dimension =>
                {
                    (Backend::Deterministic, conservative())
                }
                (VectorMode::DeterministicTest { .. }, _) => {
                    return Err(EmbeddingError::InvalidModel);
                }
                (_, EmbeddingBackendTarget::Remote { provider, .. }) => {
                    let port = self
                        .deps
                        .providers
                        .clone()
                        .ok_or(EmbeddingError::ProviderUnavailable)?;
                    let backend = RemoteEmbedder::new(
                        port,
                        target.model.clone(),
                        provider.clone(),
                        target.dimension,
                        target.max_input_tokens,
                    );
                    (Backend::Remote(Arc::new(backend)), conservative())
                }
                (
                    VectorMode::DynamicOrt {
                        dylib_path,
                        model_dir,
                    },
                    EmbeddingBackendTarget::LocalOnnx,
                ) => {
                    let mut installed = if load_local {
                        self.models.0.lock().await
                    } else {
                        self.models
                            .0
                            .try_lock()
                            .map_err(|_| EmbeddingError::ModelUnavailable)?
                    };
                    let model = if let Some(model) = installed.as_ref().filter(|model| {
                        model.profile == target.model
                            && model.dimension == target.dimension
                            && model.max_input_tokens == target.max_input_tokens
                    }) {
                        model.model.clone()
                    } else if load_local {
                        let library = dylib_path.clone();
                        let root = model_dir.clone();
                        let selected = target.clone();
                        let model = tokio::task::spawn_blocking(move || {
                            OrtModel::open(&library, &root, &selected, Pooling::Mean)
                        })
                        .await
                        .map_err(|_| EmbeddingError::ModelUnavailable)??;
                        let model = Arc::new(model);
                        *installed = Some(InstalledModel {
                            profile: target.model.clone(),
                            dimension: target.dimension,
                            max_input_tokens: target.max_input_tokens,
                            model: model.clone(),
                        });
                        model
                    } else {
                        return Err(EmbeddingError::ModelUnavailable);
                    };
                    let tokenizer = model.tokenizer();
                    (Backend::Onnx(model), tokenizer)
                }
                (VectorMode::RemoteOnly, EmbeddingBackendTarget::LocalOnnx) => {
                    return Err(EmbeddingError::ModelUnavailable);
                }
            };
        Ok(Embedder {
            target,
            backend,
            tokenizer,
        })
    }
}

impl Embedder {
    pub fn tokenizer(&self) -> &(dyn TokenizerBudget + Send + Sync) {
        self.tokenizer.as_ref()
    }

    pub async fn query(
        &self,
        services: &Services,
        mut ctx: SpaceContext,
        text: String,
        classes: BTreeSet<DocClass>,
        project_scope: Option<FolderRef>,
    ) -> Result<Option<QuantizedVector>, EmbeddingError> {
        ctx.budget.remaining = ctx
            .budget
            .remaining
            .min(services.config.query_embedding_budget);
        let mut row = match &self.backend {
            Backend::Remote(remote) => {
                if ctx.auth().taint().is_tainted() {
                    return Err(EmbeddingError::ProviderUnavailable);
                }
                let tokens = self
                    .tokenizer
                    .count(&text)
                    .map_err(|_| EmbeddingError::BudgetExceeded)?;
                let backend = remote.clone();
                services
                    .scheduler
                    .submit(
                        Priority::InteractiveSearchQuery,
                        ctx.budget.clone(),
                        move |budget| async move {
                            ctx.budget = budget;
                            backend
                                .query(
                                    ctx,
                                    EmbeddingQueryInput {
                                        text,
                                        tokens,
                                        classes,
                                        project_scope,
                                    },
                                )
                                .await
                        },
                    )
                    .await?
            }
            _ => {
                self.local(
                    services,
                    Priority::InteractiveSearchQuery,
                    vec![text],
                    ctx.budget,
                )
                .await?
            }
        };
        row.pop()
            .flatten()
            .map(|vector| {
                QuantizedVector::quantize(&vector).map_err(|_| EmbeddingError::InvalidModel)
            })
            .transpose()
    }

    async fn local(
        &self,
        services: &Services,
        priority: Priority,
        texts: Vec<String>,
        budget: CallBudget,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
        match &self.backend {
            Backend::Onnx(model) => {
                let model = model.clone();
                services
                    .scheduler
                    .submit(priority, budget, move |budget| model.embed(texts, budget))
                    .await
            }
            Backend::Deterministic => {
                let dimension = self.target.dimension;
                services
                    .scheduler
                    .submit(priority, budget, move |_| async move {
                        Ok(texts
                            .iter()
                            .map(|text| deterministic_embedding(text, dimension))
                            .collect())
                    })
                    .await
            }
            Backend::Remote(_) => Err(EmbeddingError::ProviderUnavailable),
        }
    }

    pub async fn index_note(
        &self,
        input: IndexNote<'_>,
    ) -> Result<(Vec<VectorChunk>, bool), DomainError> {
        let IndexNote {
            services,
            scope,
            note,
            folder,
            budget,
            priority,
            existing,
        } = input;
        let document = Arc::new(note.document.clone());
        let content =
            ClassEgressFence::index_for_search(note.document.clone(), &services.authority)?;
        let chunks = chunks_for(&content, self.tokenizer())?;
        let mut missing = Vec::new();
        let mut vectors = Vec::new();
        for descriptor in chunks {
            if let Some(vector) = existing.and_then(|epoch| epoch.find_vector(descriptor.key)) {
                vectors.push(vector_chunk(&document, folder, descriptor, vector));
            } else {
                missing.push(descriptor);
            }
        }
        let mut pending = false;
        let cap = self.target.max_input_tokens;
        let Some(batches) = bounded_batches(missing, |chunk| chunk.tokens, cap).ok() else {
            return Ok((vectors, true));
        };
        for batch in batches {
            let rows = if let Backend::Remote(backend) = &self.backend {
                self.remote_index(
                    services, scope, note, &document, backend, &batch, &budget, priority,
                )
                .await
            } else {
                self.local(
                    services,
                    priority,
                    batch.iter().map(|chunk| chunk.text.clone()).collect(),
                    budget.clone(),
                )
                .await
            };
            let Ok(rows) = rows else {
                pending = true;
                continue;
            };
            for (descriptor, row) in batch.into_iter().zip(rows) {
                if let Some(vector) = row.and_then(|row| QuantizedVector::quantize(&row).ok()) {
                    vectors.push(vector_chunk(&document, folder, descriptor, vector));
                } else {
                    pending = true;
                }
            }
        }
        Ok((vectors, pending))
    }

    #[allow(clippy::too_many_arguments)]
    async fn remote_index(
        &self,
        services: &Services,
        scope: &HistoryScope,
        note: &SearchIndexedNote,
        document: &Arc<ClassifiedDocument>,
        backend: &Arc<RemoteEmbedder>,
        batch: &[ChunkDescriptor],
        budget: &CallBudget,
        priority: Priority,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
        let resolver = services
            .deps
            .model_resolver
            .clone()
            .ok_or(EmbeddingError::ProviderUnavailable)?;
        let EmbeddingBackendTarget::Remote { project, .. } = &self.target.backend else {
            return Err(EmbeddingError::ProviderUnavailable);
        };
        let actual_project = note.enclosing_project.clone().map(|folder_id| FolderRef {
            space_id: scope.space_id.clone(),
            folder_id,
        });
        if project
            .as_ref()
            .is_some_and(|project| Some(project) != actual_project.as_ref())
        {
            return Ok(vec![None; batch.len()]);
        }
        let parts = batch
            .iter()
            .cloned()
            .map(|chunk| ContentPart::from_chunk(document.clone(), chunk))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| EmbeddingError::InvalidModel)?;
        let backend = backend.clone();
        let authority = services.authority.clone();
        let scope = scope.clone();
        let actor = note.revision_actor.clone();
        services
            .scheduler
            .submit(priority, budget.clone(), move |budget| async move {
                let grant = resolver
                    .acquire_remote_indexing_grant(
                        &authority,
                        &scope,
                        &actor,
                        &backend.provider,
                        actual_project.as_ref(),
                        budget.clone(),
                    )
                    .await
                    .map_err(|_| EmbeddingError::ProviderUnavailable)?;
                let Some(mut grant) = grant else {
                    return Ok(vec![None; parts.len()]);
                };
                grant.ctx.budget = budget;
                backend.parts(grant, actual_project, parts).await
            })
            .await
    }
}

pub(super) struct IndexNote<'a> {
    pub services: &'a Services,
    pub scope: &'a HistoryScope,
    pub note: &'a SearchIndexedNote,
    pub folder: u32,
    pub budget: CallBudget,
    pub priority: Priority,
    pub existing: Option<&'a VectorEpoch>,
}

pub(super) fn chunks_for(
    content: &SearchContent,
    tokenizer: &dyn TokenizerBudget,
) -> Result<Vec<ChunkDescriptor>, DomainError> {
    let text = content.text();
    let header = notarium_syntax::frontmatter::analyze(text, content.provenance().class())?;
    let markdown = notarium_syntax::markdown::analyze(text, header.carrier.body)?;
    match notarium_syntax::chunk::chunks(text, &markdown, Some(tokenizer))? {
        ChunkPlan::Ready { chunks, .. } => Ok(chunks),
        ChunkPlan::Deferred { .. } => Err(DomainError::validation(
            ValidationReason::MissingModelProfile,
        )),
    }
}

fn vector_chunk(
    document: &ClassifiedDocument,
    folder: u32,
    chunk: ChunkDescriptor,
    vector: QuantizedVector,
) -> VectorChunk {
    VectorChunk {
        metadata: ChunkMetadata {
            note: document.reference().note_id.clone(),
            key: chunk.key,
            source: chunk.source,
            folder,
            class: document.class(),
            tokens: chunk.tokens as u16,
            context: chunk.context,
            spans: chunk.spans,
        },
        vector,
    }
}
