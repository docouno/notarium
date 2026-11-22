mod loading;

pub(super) use loading::LocalModels;

use crate::{
    config::VectorMode,
    embed::{
        EmbeddingBatch, EmbeddingError, OrtModel, Priority, RemoteConservativeTokenizerBudget,
        RemoteEmbedder, bounded_batches,
    },
    engine::Services,
    ports::{
        EmbeddingBackendTarget, RemoteIndexingGrant, ResolvedEmbeddingTarget, SearchIndexedNote,
        SearchModelResolverPort,
    },
    vector::{
        ChunkMetadata, MAX_DIMENSION, MIN_DIMENSION, QuantizedVector, VectorChunk, VectorSnapshot,
    },
};
use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, ClassifiedDocument, ContentPart, DocClass, SearchContent},
    document::{ChunkDescriptor, ChunkPlan},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, ModelProfileId},
    model::{FolderRef, HistoryScope},
    ports::{CallBudget, EmbeddingQueryInput, SearchQuery, SpaceContext},
};
use notarium_syntax::chunk::TokenizerBudget;
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

const LOCAL_BATCH_QUANTUM: u32 = 16;

pub(super) struct Embedder {
    pub target: ResolvedEmbeddingTarget,
    backend: Backend,
    tokenizer: Arc<dyn TokenizerBudget + Send + Sync>,
}

enum Backend {
    Onnx(Arc<OrtModel>),
    Remote(Arc<RemoteEmbedder>),
    #[cfg(any(test, feature = "test-support"))]
    Deterministic,
}

pub(super) struct IndexedNoteVectors {
    pub chunks: Vec<VectorChunk>,
    pub outcome: NoteIndexOutcome,
}

#[derive(Debug)]
pub(super) enum NoteIndexOutcome {
    /// All embeddable chunks completed, or the note was permanently skipped.
    Complete,
    /// Admission was revoked while a batch was queued. Discard earlier rows of this note.
    Denied,
    /// At least one chunk failed transiently and should be retried later.
    Pending,
    /// Provider, model, or cancellation failure that should halt backfill.
    Fatal(EmbeddingError),
}

impl Services {
    pub async fn model_target(
        &self,
        scope: &HistoryScope,
        explicit: Option<&ModelProfileId>,
        budget: &CallBudget,
    ) -> Result<Option<ResolvedEmbeddingTarget>, EmbeddingError> {
        if matches!(self.config.vector_mode, VectorMode::Disabled) {
            return Ok(None);
        }
        if self.shutdown.is_cancelled() || budget.cancellation.is_cancelled() {
            return Err(EmbeddingError::Cancelled);
        }
        if budget.remaining.is_zero() {
            return Err(EmbeddingError::BudgetExceeded);
        }
        let target = if let Some(resolver) = &self.deps.model_resolver {
            tokio::select! {
                biased;
                () = self.shutdown.cancelled() => return Err(EmbeddingError::Cancelled),
                () = budget.cancellation.cancelled() => return Err(EmbeddingError::Cancelled),
                resolved = tokio::time::timeout(
                    budget.remaining,
                    resolver.resolve_model(&self.authority, scope, explicit, budget),
                ) => match resolved {
                    Ok(Ok(target)) => target,
                    Ok(Err(PortError::Cancelled(_))) => return Err(EmbeddingError::Cancelled),
                    Ok(Err(PortError::DeadlineExceeded(_))) | Err(_) => {
                        return Err(EmbeddingError::BudgetExceeded);
                    }
                    Ok(Err(_)) => return Err(EmbeddingError::ModelUnavailable),
                },
            }
        } else {
            #[cfg(any(test, feature = "test-support"))]
            {
                if let VectorMode::DeterministicTest { dimension } = self.config.vector_mode {
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
                }
            }
            #[cfg(not(any(test, feature = "test-support")))]
            {
                None
            }
        };
        match target {
            Some(target)
                if (MIN_DIMENSION..=MAX_DIMENSION).contains(&(target.dimension as usize))
                    && target.max_input_tokens > 0
                    && explicit.is_none_or(|explicit| *explicit == target.model) =>
            {
                Ok(Some(target))
            }
            None => Ok(None),
            Some(_) => Err(EmbeddingError::ModelUnavailable),
        }
    }

    pub async fn embedder(
        &self,
        target: ResolvedEmbeddingTarget,
    ) -> Result<Embedder, EmbeddingError> {
        let conservative = || -> Result<Arc<dyn TokenizerBudget + Send + Sync>, EmbeddingError> {
            Ok(Arc::new(RemoteConservativeTokenizerBudget::new(
                target.model.clone(),
                target.max_input_tokens,
            )?))
        };
        let (backend, tokenizer): (_, Arc<dyn TokenizerBudget + Send + Sync>) =
            match (&self.config.vector_mode, &target.backend) {
                (VectorMode::Disabled, _) => return Err(EmbeddingError::ModelUnavailable),
                #[cfg(any(test, feature = "test-support"))]
                (VectorMode::DeterministicTest { dimension }, _)
                    if *dimension == target.dimension =>
                {
                    (Backend::Deterministic, conservative()?)
                }
                #[cfg(any(test, feature = "test-support"))]
                (VectorMode::DeterministicTest { .. }, _) => {
                    return Err(EmbeddingError::InvalidModel);
                }
                (
                    _,
                    EmbeddingBackendTarget::Remote {
                        provider,
                        runtime_epochs,
                        project,
                    },
                ) => {
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
                        *runtime_epochs,
                        project.clone(),
                    );
                    (Backend::Remote(Arc::new(backend)), conservative()?)
                }
                (
                    VectorMode::DynamicOrt {
                        dylib_path,
                        model_dir,
                    },
                    EmbeddingBackendTarget::LocalOnnx | EmbeddingBackendTarget::LocalOnnxCls,
                ) => {
                    let key = target.vector_model();
                    let pooling = key.pooling;
                    let library = dylib_path.clone();
                    let root = model_dir.clone();
                    let selected = target.clone();
                    let model = self
                        .models
                        .get_or_open(key, move || {
                            OrtModel::open(&library, &root, &selected, pooling)
                        })
                        .await?;
                    let tokenizer = model.tokenizer();
                    (Backend::Onnx(model), tokenizer)
                }
                (
                    VectorMode::RemoteOnly,
                    EmbeddingBackendTarget::LocalOnnx | EmbeddingBackendTarget::LocalOnnxCls,
                ) => {
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
        services: &Arc<Services>,
        mut ctx: SpaceContext,
        query: &SearchQuery,
        classes: BTreeSet<DocClass>,
        project_scope: Option<FolderRef>,
        requested: &ResolvedEmbeddingTarget,
    ) -> Result<QuantizedVector, EmbeddingError> {
        ctx.budget.remaining = ctx
            .budget
            .remaining
            .min(services.config.interactive_budget());
        let text = query.text.clone();
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
                let selection = query.model.is_none().then(|| requested.clone());
                let folder = query.folder.clone();
                let models = Arc::clone(services);
                services
                    .remote_scheduler
                    .submit(
                        Priority::InteractiveSearchQuery,
                        ctx.budget.clone(),
                        move |budget| async move {
                            let started = std::time::Instant::now();
                            ctx.budget = budget;
                            let implicit = selection.is_some();
                            if let Some(expected) = selection {
                                let current =
                                    models.model_target(ctx.scope(), None, &ctx.budget).await?;
                                if current
                                    .as_ref()
                                    .is_none_or(|current| current.backend != expected.backend)
                                {
                                    return Err(EmbeddingError::TargetChanged);
                                }
                            }
                            ctx.budget.remaining =
                                ctx.budget.remaining.saturating_sub(started.elapsed());
                            backend
                                .query(
                                    ctx,
                                    EmbeddingQueryInput {
                                        text,
                                        tokens,
                                        classes,
                                        project_scope,
                                        folder,
                                    },
                                    implicit,
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
        let vector = row.pop().flatten().ok_or(EmbeddingError::InvalidModel)?;
        QuantizedVector::quantize(&vector).map_err(|_| EmbeddingError::InvalidModel)
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
                    .local_scheduler
                    .submit(priority, budget, move |budget| model.embed(texts, budget))
                    .await
            }
            #[cfg(any(test, feature = "test-support"))]
            Backend::Deterministic => {
                let dimension = self.target.dimension;
                services
                    .local_scheduler
                    .submit(priority, budget, move |_| async move {
                        Ok(texts
                            .iter()
                            .map(|text| crate::embed::deterministic_embedding(text, dimension))
                            .collect())
                    })
                    .await
            }
            Backend::Remote(_) => Err(EmbeddingError::ProviderUnavailable),
        }
    }

    pub async fn prepare_note<'a>(
        &'a self,
        input: IndexNote<'a>,
    ) -> Result<NotePreparation<'a>, DomainError> {
        let IndexNote {
            services,
            scope,
            note,
            folder,
            mut budget,
            priority,
        } = input;
        let remote = if let Backend::Remote(backend) = &self.backend {
            if !note.remote_indexable {
                return Ok(NotePreparation::Finished(NoteIndexOutcome::Complete));
            }
            let Some(resolver) = &services.deps.model_resolver else {
                return Ok(NotePreparation::Finished(NoteIndexOutcome::Fatal(
                    EmbeddingError::ModelUnavailable,
                )));
            };
            let started = std::time::Instant::now();
            let grant = tokio::select! {
                biased;
                () = budget.cancellation.cancelled() => {
                    return Ok(NotePreparation::Finished(NoteIndexOutcome::Fatal(EmbeddingError::Cancelled)));
                }
                grant = tokio::time::timeout(
                    budget.remaining,
                    self.indexing_grant(services, resolver.as_ref(), scope, note, budget.clone()),
                ) => grant,
            };
            budget.remaining = budget.remaining.saturating_sub(started.elapsed());
            match grant {
                Ok(Ok(Some((grant, project)))) => Some(RemoteNote {
                    backend: backend.clone(),
                    embedded_batch: false,
                    resolver: resolver.clone(),
                    note,
                    grant,
                    project,
                }),
                Ok(Ok(None)) => {
                    return Ok(NotePreparation::Finished(NoteIndexOutcome::Complete));
                }
                Ok(Err(PortError::Cancelled(_))) => {
                    return Ok(NotePreparation::Finished(NoteIndexOutcome::Fatal(
                        EmbeddingError::Cancelled,
                    )));
                }
                Ok(Err(PortError::DeadlineExceeded(_))) | Err(_) => {
                    return Ok(NotePreparation::Finished(NoteIndexOutcome::Pending));
                }
                Ok(Err(_)) => {
                    return Ok(NotePreparation::Finished(NoteIndexOutcome::Fatal(
                        EmbeddingError::ProviderUnavailable,
                    )));
                }
            }
        } else {
            None
        };
        let document = Arc::new(note.document.clone());
        let content =
            ClassEgressFence::index_for_search(note.document.clone(), &services.authority)?;
        let Ok(chunks) = chunks_for(&content, self.tokenizer()) else {
            tracing::warn!(
                note = %note.note_id,
                "skipping note that failed markdown chunking for vector indexing"
            );
            return Ok(NotePreparation::Finished(NoteIndexOutcome::Complete));
        };
        if chunks.is_empty() {
            return Ok(NotePreparation::Finished(NoteIndexOutcome::Complete));
        }
        Ok(NotePreparation::Ready(Box::new(PreparedIndexNote {
            embedder: self,
            services,
            folder,
            document,
            budget,
            priority,
            remote,
            descriptors: chunks.into_iter(),
        })))
    }

    async fn indexing_grant(
        &self,
        services: &Services,
        resolver: &dyn SearchModelResolverPort,
        scope: &HistoryScope,
        note: &SearchIndexedNote,
        budget: CallBudget,
    ) -> Result<Option<(RemoteIndexingGrant, Option<FolderRef>)>, PortError> {
        let EmbeddingBackendTarget::Remote {
            project, provider, ..
        } = &self.target.backend
        else {
            return Ok(None);
        };
        let actual_project = note.enclosing_project.clone().map(|folder_id| FolderRef {
            space_id: scope.space_id.clone(),
            folder_id,
        });
        if project
            .as_ref()
            .is_some_and(|project| Some(project) != actual_project.as_ref())
        {
            return Ok(None);
        }
        let Some(grant) = resolver
            .acquire_remote_indexing_grant(
                &services.authority,
                scope,
                &note.revision_actor,
                provider,
                actual_project.as_ref(),
                budget,
            )
            .await?
        else {
            return Ok(None);
        };
        if &grant.policy.provider != provider
            || ClassEgressFence::provider(note.document.clone(), grant.ctx.auth(), &grant.policy)
                .is_err()
        {
            return Ok(None);
        }
        Ok(Some((grant, actual_project)))
    }

    #[allow(clippy::too_many_arguments)]
    async fn remote_index(
        &self,
        services: &Services,
        document: &Arc<ClassifiedDocument>,
        backend: &Arc<RemoteEmbedder>,
        resolver: Arc<dyn SearchModelResolverPort>,
        mut grant: RemoteIndexingGrant,
        project: Option<FolderRef>,
        batch: &[Vec<ChunkDescriptor>],
        budget: &CallBudget,
        priority: Priority,
    ) -> Result<EmbeddingBatch, EmbeddingError> {
        let parts = batch
            .iter()
            .map(|group| ContentPart::from_chunk(document.clone(), group[0].clone()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| EmbeddingError::InvalidModel)?;
        let backend = backend.clone();
        let target = self.target.clone();
        let canonical = services.deps.canonical.clone();
        let authority = services.authority.clone();
        let note = document.reference().note_id.clone();
        services
            .remote_scheduler
            .submit_batch(priority, budget.clone(), move |budget| async move {
                // Resolve at the scheduled boundary. A queued batch must not
                // inherit the project selection from the start of a backfill.
                let started = std::time::Instant::now();
                let selected = tokio::select! {
                    biased;
                    () = budget.cancellation.cancelled() => return Err(EmbeddingError::Cancelled),
                    result = tokio::time::timeout(
                        budget.remaining,
                        resolver.resolve_model(&authority, grant.ctx.scope(), None, &budget),
                    ) => match result {
                        Ok(Ok(selected)) => selected,
                        Ok(Err(PortError::Cancelled(_))) => return Err(EmbeddingError::Cancelled),
                        Ok(Err(PortError::DeadlineExceeded(_))) | Err(_) => {
                            return Err(EmbeddingError::BudgetExceeded);
                        }
                        Ok(Err(_)) => return Err(EmbeddingError::ModelUnavailable),
                    },
                };
                if selected.as_ref() != Some(&target) {
                    return Err(EmbeddingError::ModelUnavailable);
                }
                let remaining = budget.remaining;
                grant.ctx.budget = budget;
                grant.ctx.budget.remaining =
                    grant.ctx.budget.remaining.saturating_sub(started.elapsed());
                if grant.ctx.budget.remaining.is_zero() {
                    return Err(EmbeddingError::BudgetExceeded);
                }
                if !canonical
                    .can_index_remote_search_note(
                        &authority,
                        grant.ctx.budget.clone(),
                        grant.ctx.scope().clone(),
                        note,
                        project.as_ref().map(|value| value.folder_id.clone()),
                    )
                    .await
                    .map_err(|_| EmbeddingError::ProviderUnavailable)?
                {
                    return Err(EmbeddingError::IndexingDenied);
                }
                grant.ctx.budget.remaining = remaining.saturating_sub(started.elapsed());
                if grant.ctx.budget.remaining.is_zero() {
                    return Err(EmbeddingError::BudgetExceeded);
                }
                backend.index_parts(grant, project, parts).await
            })
            .await
    }
}

struct RemoteNote<'a> {
    embedded_batch: bool,
    note: &'a SearchIndexedNote,
    backend: Arc<RemoteEmbedder>,
    resolver: Arc<dyn SearchModelResolverPort>,
    grant: RemoteIndexingGrant,
    project: Option<FolderRef>,
}

impl RemoteNote<'_> {
    async fn index_batch(
        &mut self,
        embedder: &Embedder,
        services: &Services,
        document: &Arc<ClassifiedDocument>,
        batch: &[Vec<ChunkDescriptor>],
        budget: &mut CallBudget,
        priority: Priority,
    ) -> Result<EmbeddingBatch, EmbeddingError> {
        let mut retried = false;
        loop {
            let result = embedder
                .remote_index(
                    services,
                    document,
                    &self.backend,
                    self.resolver.clone(),
                    self.grant.clone(),
                    self.project.clone(),
                    batch,
                    budget,
                    priority,
                )
                .await;
            let delay = match &result {
                Err(EmbeddingError::IndexingThrottled(delay)) => *delay,
                // A smaller note may fit even now. Wait only for a note that
                // has already embedded content in this attempt.
                Err(EmbeddingError::IndexingTokenLimit(delay)) if self.embedded_batch => *delay,
                Ok(rows) => {
                    self.embedded_batch |= rows.rows.iter().any(Option::is_some);
                    return result;
                }
                _ => return result,
            };
            // Keep this note private for one Control rate window. A second
            // refusal without progress releases staging to the worker backoff.
            if retried || delay > std::time::Duration::from_secs(60) {
                return result;
            }
            // The scheduler has already released its lane to other callers.
            tokio::select! {
                biased;
                () = budget.cancellation.cancelled() => return Err(EmbeddingError::Cancelled),
                () = tokio::time::sleep(delay) => {}
            }
            *budget = crate::indexer::new_budget(&budget.cancellation);
            let started = std::time::Instant::now();
            let grant = tokio::select! {
                biased;
                () = budget.cancellation.cancelled() => return Err(EmbeddingError::Cancelled),
                grant = tokio::time::timeout(
                    budget.remaining,
                    embedder.indexing_grant(
                        services, self.resolver.as_ref(), self.grant.ctx.scope(), self.note, budget.clone(),
                    ),
                ) => grant,
            };
            (self.grant, self.project) = match grant {
                Ok(Ok(Some(grant))) => grant,
                Ok(Ok(None)) => return Err(EmbeddingError::IndexingDenied),
                Ok(Err(PortError::Cancelled(_))) => return Err(EmbeddingError::Cancelled),
                _ => return Err(EmbeddingError::ProviderUnavailable),
            };
            budget.remaining = budget.remaining.saturating_sub(started.elapsed());
            retried = true;
        }
    }
}

pub(super) enum NotePreparation<'a> {
    Ready(Box<PreparedIndexNote<'a>>),
    Finished(NoteIndexOutcome),
}

pub(super) struct PreparedIndexNote<'a> {
    embedder: &'a Embedder,
    services: &'a Services,
    document: Arc<ClassifiedDocument>,
    folder: u32,
    budget: CallBudget,
    priority: Priority,
    remote: Option<RemoteNote<'a>>,
    descriptors: std::vec::IntoIter<ChunkDescriptor>,
}

impl PreparedIndexNote<'_> {
    pub fn descriptor_count(&self) -> usize {
        self.descriptors.len()
    }

    /// Admission has already been checked. Equal metadata for this model also
    /// certifies the embedding keys, even for multiple positions of the same text.
    pub fn matches_snapshot(&self, snapshot: &VectorSnapshot) -> bool {
        let expected = self
            .descriptors
            .as_slice()
            .iter()
            .filter(|d| d.tokens != 0 && d.tokens <= self.embedder.target.max_input_tokens)
            .map(|d| {
                chunk_metadata(
                    &self.document,
                    self.folder,
                    d.key,
                    d.source,
                    d.tokens,
                    d.context.clone(),
                    d.spans.clone(),
                )
            })
            .collect();
        snapshot.matches_note_metadata(&self.document.reference().note_id, expected)
    }

    pub fn has_more(&self) -> bool {
        self.descriptors.len() != 0
    }

    pub async fn index_next(
        &mut self,
        limit: usize,
        existing: &(dyn Fn(ContentDigest) -> Option<QuantizedVector> + Sync),
    ) -> IndexedNoteVectors {
        let embedder = self.embedder;
        let document = &self.document;
        let max_per_chunk = embedder.target.max_input_tokens;
        let mut missing: Vec<Vec<ChunkDescriptor>> = Vec::new();
        let mut group_by_key = HashMap::new();
        let mut vectors = Vec::new();
        for descriptor in self.descriptors.by_ref().take(limit) {
            if descriptor.tokens == 0 || descriptor.tokens > max_per_chunk {
                continue;
            }
            if let Some(vector) = existing(descriptor.key) {
                vectors.push(vector_chunk(document, self.folder, descriptor, vector));
            } else {
                let group = *group_by_key.entry(descriptor.key).or_insert_with(|| {
                    missing.push(Vec::new());
                    missing.len() - 1
                });
                missing[group].push(descriptor);
            }
        }
        if missing.is_empty() {
            return IndexedNoteVectors {
                chunks: vectors,
                outcome: NoteIndexOutcome::Complete,
            };
        }
        let batch_cap = match &embedder.backend {
            Backend::Remote(_) => embedder.target.max_input_tokens,
            _ => embedder
                .target
                .max_input_tokens
                .saturating_mul(LOCAL_BATCH_QUANTUM),
        };
        let Ok(batches) = bounded_batches(missing, |group| group[0].tokens, batch_cap) else {
            tracing::warn!(
                note = %document.reference().note_id,
                "skipping note chunks that exceed model batch token cap"
            );
            return IndexedNoteVectors {
                chunks: vectors,
                outcome: NoteIndexOutcome::Complete,
            };
        };
        let mut pending = false;
        for batch in batches {
            let rows = if let Some(remote) = &mut self.remote {
                remote
                    .index_batch(
                        embedder,
                        self.services,
                        document,
                        &batch,
                        &mut self.budget,
                        self.priority,
                    )
                    .await
            } else {
                embedder
                    .local(
                        self.services,
                        self.priority,
                        batch.iter().map(|group| group[0].text.clone()).collect(),
                        self.budget.clone(),
                    )
                    .await
                    .map(EmbeddingBatch::complete)
            };
            let rows = match rows {
                Ok(batch) => {
                    pending |= batch.pending;
                    batch.rows
                }
                Err(EmbeddingError::IndexingDenied) => {
                    return IndexedNoteVectors {
                        chunks: Vec::new(),
                        outcome: NoteIndexOutcome::Denied,
                    };
                }
                Err(EmbeddingError::PermanentInputRejected) => {
                    tracing::warn!(
                        note = %document.reference().note_id,
                        "skipping permanently rejected note batch for vector indexing"
                    );
                    continue;
                }
                Err(EmbeddingError::BudgetExceeded | EmbeddingError::IndexingTokenLimit(_)) => {
                    pending = true;
                    self.descriptors = Vec::new().into_iter();
                    break;
                }
                Err(err) => {
                    return IndexedNoteVectors {
                        chunks: vectors,
                        outcome: NoteIndexOutcome::Fatal(err),
                    };
                }
            };
            for (group, row) in batch.into_iter().zip(rows) {
                let Some(raw) = row else {
                    continue;
                };
                match QuantizedVector::quantize(&raw) {
                    Ok(vector) => {
                        for descriptor in group {
                            vectors.push(vector_chunk(
                                document,
                                self.folder,
                                descriptor,
                                vector.clone(),
                            ));
                        }
                    }
                    Err(_) => {
                        tracing::warn!(
                            note = %document.reference().note_id,
                            "skipping unquantizable embedding chunk"
                        );
                    }
                }
            }
        }
        IndexedNoteVectors {
            chunks: vectors,
            outcome: if pending {
                NoteIndexOutcome::Pending
            } else {
                NoteIndexOutcome::Complete
            },
        }
    }
}

pub(super) struct IndexNote<'a> {
    pub services: &'a Services,
    pub scope: &'a HistoryScope,
    pub note: &'a SearchIndexedNote,
    pub folder: u32,
    pub budget: CallBudget,
    pub priority: Priority,
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
        metadata: chunk_metadata(
            document,
            folder,
            chunk.key,
            chunk.source,
            chunk.tokens,
            chunk.context,
            chunk.spans,
        ),
        vector,
    }
}

fn chunk_metadata(
    document: &ClassifiedDocument,
    folder: u32,
    key: ContentDigest,
    source: ContentDigest,
    tokens: u32,
    context: Vec<notarium_core::span::ByteSpan>,
    spans: Vec<notarium_core::span::ByteSpan>,
) -> ChunkMetadata {
    ChunkMetadata {
        note: document.reference().note_id.clone(),
        key,
        source,
        folder,
        class: document.class(),
        tokens: tokens as u16,
        context,
        spans,
    }
}
