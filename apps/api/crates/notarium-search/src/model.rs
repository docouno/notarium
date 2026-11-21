use crate::{
    config::VectorMode,
    embed::{
        EmbeddingError, OrtModel, Priority, RemoteConservativeTokenizerBudget, RemoteEmbedder,
        bounded_batches,
    },
    engine::Services,
    ports::{
        EmbeddingBackendTarget, RemoteIndexingGrant, ResolvedEmbeddingTarget, SearchIndexedNote,
        SearchModelResolverPort,
    },
    vector::{ChunkMetadata, MAX_DIMENSION, MIN_DIMENSION, QuantizedVector, VectorChunk},
};
use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, ClassifiedDocument, ContentPart, DocClass, SearchContent},
    document::{ChunkDescriptor, ChunkPlan},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, ModelProfileId},
    model::{FolderRef, HistoryScope},
    ports::{CallBudget, EmbeddingQueryInput, SpaceContext},
};
use notarium_syntax::chunk::TokenizerBudget;
use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex, Weak},
};

const LOCAL_BATCH_QUANTUM: u32 = 16;

#[derive(Default)]
pub(super) struct LocalModels {
    models: StdMutex<HashMap<crate::layout::VectorModel, Weak<OrtModel>>>,
    loading: StdMutex<HashMap<crate::layout::VectorModel, Weak<tokio::sync::Mutex<()>>>>,
}

impl LocalModels {
    fn cached(&self, key: &crate::layout::VectorModel) -> Option<Arc<OrtModel>> {
        let models = self
            .models
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        models.get(key).and_then(Weak::upgrade)
    }

    fn loading_gate(&self, key: &crate::layout::VectorModel) -> Arc<tokio::sync::Mutex<()>> {
        let mut loading = self
            .loading
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        loading.retain(|_, entry| entry.strong_count() != 0);
        loading.get(key).and_then(Weak::upgrade).unwrap_or_else(|| {
            let gate = Arc::new(tokio::sync::Mutex::new(()));
            loading.insert(key.clone(), Arc::downgrade(&gate));
            gate
        })
    }

    async fn get_or_open(
        &self,
        key: crate::layout::VectorModel,
        library: PathBuf,
        root: PathBuf,
        selected: ResolvedEmbeddingTarget,
    ) -> Result<Arc<OrtModel>, EmbeddingError> {
        if let Some(model) = self.cached(&key) {
            return Ok(model);
        }
        let gate = self.loading_gate(&key);
        let _guard = gate.lock().await;
        if let Some(model) = self.cached(&key) {
            return Ok(model);
        }
        let pooling = key.pooling;
        let model = tokio::task::spawn_blocking(move || {
            OrtModel::open(&library, &root, &selected, pooling)
        })
        .await
        .map_err(|_| EmbeddingError::ModelUnavailable)??;
        let model = Arc::new(model);
        {
            let mut models = self
                .models
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            models.retain(|_, entry| entry.strong_count() != 0);
            models.insert(key, Arc::downgrade(&model));
        }
        Ok(model)
    }

    #[cfg(test)]
    pub(super) async fn hold_loading(&self, key: crate::layout::VectorModel) -> impl Drop {
        let gate = self.loading_gate(&key);
        gate.lock_owned().await
    }
}

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
                        ..
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
                    let model = self
                        .models
                        .get_or_open(key, dylib_path.clone(), model_dir.clone(), target.clone())
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
        services: &Services,
        mut ctx: SpaceContext,
        text: String,
        classes: BTreeSet<DocClass>,
        project_scope: Option<FolderRef>,
    ) -> Result<QuantizedVector, EmbeddingError> {
        ctx.budget.remaining = ctx
            .budget
            .remaining
            .min(services.config.interactive_budget());
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
                    .remote_scheduler
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

    pub async fn index_note(
        &self,
        input: IndexNote<'_>,
    ) -> Result<IndexedNoteVectors, DomainError> {
        let IndexNote {
            services,
            scope,
            note,
            folder,
            mut budget,
            priority,
            existing,
        } = input;
        let remote = if let Backend::Remote(backend) = &self.backend {
            if !note.remote_indexable {
                return Ok(IndexedNoteVectors {
                    chunks: Vec::new(),
                    outcome: NoteIndexOutcome::Complete,
                });
            }
            let Some(resolver) = &services.deps.model_resolver else {
                return Ok(IndexedNoteVectors {
                    chunks: Vec::new(),
                    outcome: NoteIndexOutcome::Fatal(EmbeddingError::ModelUnavailable),
                });
            };
            let started = std::time::Instant::now();
            let grant = tokio::select! {
                biased;
                () = budget.cancellation.cancelled() => {
                    return Ok(IndexedNoteVectors {
                        chunks: Vec::new(),
                        outcome: NoteIndexOutcome::Fatal(EmbeddingError::Cancelled),
                    });
                }
                grant = tokio::time::timeout(
                    budget.remaining,
                    self.indexing_grant(services, resolver.as_ref(), scope, note, budget.clone()),
                ) => grant,
            };
            budget.remaining = budget.remaining.saturating_sub(started.elapsed());
            match grant {
                Ok(Ok(Some((grant, project)))) => Some((backend, resolver, grant, project)),
                Ok(Ok(None)) => {
                    return Ok(IndexedNoteVectors {
                        chunks: Vec::new(),
                        outcome: NoteIndexOutcome::Complete,
                    });
                }
                Ok(Err(PortError::Cancelled(_))) => {
                    return Ok(IndexedNoteVectors {
                        chunks: Vec::new(),
                        outcome: NoteIndexOutcome::Fatal(EmbeddingError::Cancelled),
                    });
                }
                Ok(Err(PortError::DeadlineExceeded(_))) | Err(_) => {
                    return Ok(IndexedNoteVectors {
                        chunks: Vec::new(),
                        outcome: NoteIndexOutcome::Pending,
                    });
                }
                Ok(Err(_)) => {
                    return Ok(IndexedNoteVectors {
                        chunks: Vec::new(),
                        outcome: NoteIndexOutcome::Fatal(EmbeddingError::ProviderUnavailable),
                    });
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
            return Ok(IndexedNoteVectors {
                chunks: Vec::new(),
                outcome: NoteIndexOutcome::Complete,
            });
        };
        if chunks.is_empty() {
            return Ok(IndexedNoteVectors {
                chunks: Vec::new(),
                outcome: NoteIndexOutcome::Complete,
            });
        }
        let max_per_chunk = self.target.max_input_tokens;
        let mut missing: Vec<Vec<ChunkDescriptor>> = Vec::new();
        let mut group_by_key = HashMap::new();
        let mut vectors = Vec::new();
        for descriptor in chunks {
            if descriptor.tokens == 0 || descriptor.tokens > max_per_chunk {
                continue;
            }
            if let Some(vector) = existing(descriptor.key) {
                vectors.push(vector_chunk(&document, folder, descriptor, vector));
            } else {
                let group = *group_by_key.entry(descriptor.key).or_insert_with(|| {
                    missing.push(Vec::new());
                    missing.len() - 1
                });
                missing[group].push(descriptor);
            }
        }
        if missing.is_empty() {
            return Ok(IndexedNoteVectors {
                chunks: vectors,
                outcome: NoteIndexOutcome::Complete,
            });
        }
        let batch_cap = match &self.backend {
            Backend::Remote(_) => self.target.max_input_tokens,
            _ => self
                .target
                .max_input_tokens
                .saturating_mul(LOCAL_BATCH_QUANTUM),
        };
        let Ok(batches) = bounded_batches(missing, |group| group[0].tokens, batch_cap) else {
            tracing::warn!(
                note = %note.note_id,
                "skipping note chunks that exceed model batch token cap"
            );
            return Ok(IndexedNoteVectors {
                chunks: vectors,
                outcome: NoteIndexOutcome::Complete,
            });
        };
        let mut pending = false;
        for batch in batches {
            let rows = if let Some((backend, resolver, grant, project)) = &remote {
                self.remote_index(
                    services,
                    &document,
                    backend,
                    Arc::clone(resolver),
                    grant.clone(),
                    project.clone(),
                    &batch,
                    &budget,
                    priority,
                )
                .await
            } else {
                self.local(
                    services,
                    priority,
                    batch.iter().map(|group| group[0].text.clone()).collect(),
                    budget.clone(),
                )
                .await
            };
            let rows = match rows {
                Ok(rows) => rows,
                Err(EmbeddingError::IndexingDenied) => {
                    return Ok(IndexedNoteVectors {
                        chunks: Vec::new(),
                        outcome: NoteIndexOutcome::Complete,
                    });
                }
                Err(err) if err.is_permanent_note_rejection() => {
                    tracing::warn!(
                        note = %note.note_id,
                        kind = %err,
                        "skipping permanently rejected note batch for vector indexing"
                    );
                    continue;
                }
                Err(EmbeddingError::BudgetExceeded) => {
                    pending = true;
                    break;
                }
                Err(err) => {
                    return Ok(IndexedNoteVectors {
                        chunks: vectors,
                        outcome: NoteIndexOutcome::Fatal(err),
                    });
                }
            };
            for (group, row) in batch.into_iter().zip(rows) {
                match row {
                    Some(raw) => match QuantizedVector::quantize(&raw) {
                        Ok(vector) => {
                            for descriptor in group {
                                vectors.push(vector_chunk(
                                    &document,
                                    folder,
                                    descriptor,
                                    vector.clone(),
                                ));
                            }
                        }
                        Err(_) => {
                            tracing::warn!(
                                note = %note.note_id,
                                "skipping unquantizable embedding chunk"
                            );
                        }
                    },
                    None => {
                        pending = true;
                    }
                }
            }
        }
        Ok(IndexedNoteVectors {
            chunks: vectors,
            outcome: if pending {
                NoteIndexOutcome::Pending
            } else {
                NoteIndexOutcome::Complete
            },
        })
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
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
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
            .submit(priority, budget.clone(), move |budget| async move {
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
                backend.parts(grant, project, parts).await
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
    pub existing: &'a (dyn Fn(ContentDigest) -> Option<QuantizedVector> + Sync),
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
