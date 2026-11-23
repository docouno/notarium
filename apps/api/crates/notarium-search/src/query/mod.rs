mod align;
mod hydrate;
pub(crate) mod ranking;

use crate::{
    config::VectorMode,
    embed::{EmbeddingError, RemoteConservativeTokenizerBudget},
    engine::{Clock, Published, SearchEngine, internal, invalid},
    lexical::{
        LexicalError, LexicalFilter, LexicalIndex, MAX_FALLBACK_FLOOR, OverlayHits, RankedLexical,
        Update,
    },
    model::Embedder,
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
    vector::{ProjectedVectorFilter, SearchBudget, VectorHit, search_candidate_limit},
};
use croaring::Bitmap;
use notarium_core::{
    DomainError, DomainResult,
    classes::{ClassEgressFence, DocClass},
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, PrincipalId},
    model::{DenseNodeId, FolderRef, SnapshotCut},
    ports::{
        PageLimit, PortFuture, RecallQuery, SearchDegradation, SearchPort, SearchQuery,
        SearchRecipient, SearchResult, SpaceContext, StructuralSnapshot,
    },
    query::Predicate,
};
use std::{collections::BTreeSet, sync::Arc, time::Duration};

#[derive(Clone, Copy)]
struct Recall {
    graph_depth: u8,
    tokens: u32,
    max_per_source: Option<u16>,
}

#[derive(Clone, Copy)]
struct QueryDelivery<'a> {
    recall: Option<Recall>,
    recipient: Option<&'a dyn SearchRecipient>,
}

impl SearchPort for SearchEngine {
    fn search_for<'a>(
        &'a self,
        ctx: SpaceContext,
        request: SearchQuery,
        recipient: Option<&'a dyn SearchRecipient>,
    ) -> PortFuture<'a, SearchResult> {
        Box::pin(self.run_query(
            ctx,
            request,
            QueryDelivery {
                recall: None,
                recipient,
            },
        ))
    }

    fn recall_for<'a>(
        &'a self,
        ctx: SpaceContext,
        request: RecallQuery,
        recipient: Option<&'a dyn SearchRecipient>,
    ) -> PortFuture<'a, SearchResult> {
        Box::pin(async move {
            if request.graph_depth > RecallQuery::MAX_GRAPH_DEPTH {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
            if !(1..=131_072).contains(&request.token_budget) || request.max_per_source == Some(0) {
                return Err(invalid(ValidationReason::TokenBudgetExceeded));
            }
            self.run_query(
                ctx,
                request.query,
                QueryDelivery {
                    recall: Some(Recall {
                        graph_depth: request.graph_depth,
                        tokens: request.token_budget,
                        max_per_source: request.max_per_source,
                    }),
                    recipient,
                },
            )
            .await
        })
    }
}

impl SearchEngine {
    async fn run_query(
        &self,
        ctx: SpaceContext,
        request: SearchQuery,
        delivery: QueryDelivery<'_>,
    ) -> Result<SearchResult, PortError> {
        let clock = Clock::new(&ctx.budget)?;
        clock
            .within(self.query_at_cut(ctx, request, delivery, &clock))
            .await
    }

    async fn query_at_cut(
        &self,
        mut ctx: SpaceContext,
        request: SearchQuery,
        delivery: QueryDelivery<'_>,
        clock: &Clock,
    ) -> Result<SearchResult, PortError> {
        let recall = delivery.recall;
        let browse = request.text.trim().is_empty();
        let filtered = request.folder.is_some()
            || (!request.classes.is_empty() && request.classes != DocClass::all())
            || !matches!(&request.filter.predicate, Predicate::All(items) if items.is_empty());
        let empty_query =
            LexicalIndex::is_empty_query(&request.text, filtered).map_err(lexical_error)?;
        let encrypted_only = (recall.is_some() || !request.include_chats)
            && !request.classes.is_empty()
            && request
                .classes
                .iter()
                .all(|class| *class == DocClass::EncryptedNote);
        if empty_query || encrypted_only {
            let snapshot = self.projection(&ctx, request.causal, clock).await?;
            let _ = snapshot.filter_notes(&request.filter).await?;
            if let Some(folder) = &request.folder {
                let _ = snapshot.folder_descendants(folder).await?;
            }
            return Ok(SearchResult {
                hits: Vec::new(),
                chat_hits: Vec::new(),
                cut: snapshot.cut().clone(),
                degraded: None,
                truncated: false,
            });
        }
        let pinned = self.pin_space(ctx.scope().clone())?;
        let handle = &pinned.handle;
        let aligned = self.align(&ctx, &request.causal, handle, clock).await?;
        let snapshot = aligned.snapshot;
        let state = aligned.state;
        let chat_record = if request.include_chats && recall.is_none() && !browse {
            let record = self
                .services
                .deps
                .canonical
                .read_space(&ctx.scope().space_id)
                .await?;
            ctx.check_current(&record.scope)?;
            Some(record)
        } else {
            None
        };
        let filter = Arc::new(
            Eligible::new(
                &ctx,
                &request,
                snapshot.as_ref(),
                state.as_deref(),
                chat_record.as_ref().map(|record| &record.space),
            )
            .await?,
        );
        let top_k = usize::from(request.top_k.get());
        let ordinary_limit = search_candidate_limit(top_k);
        let floor = top_k.min(MAX_FALLBACK_FLOOR);
        let mut admission = hydrate::NoteAdmission {
            context: &ctx,
            clock,
            cut: &aligned.base_cut,
            overlay: &aligned.overlay,
            recipient: delivery.recipient.filter(|r| r.filters_notes()),
            checked: Default::default(),
        };
        // A recipient may reject an entire ranked prefix. Start at the ordinary
        // candidate limit (plus one overflow witness when widening is possible)
        // and only widen to `RECIPIENT_LIMIT` if recipient filtering actually
        // rejected hits and left fewer than `top_k + 1` admitted candidates.
        const RECIPIENT_LIMIT: usize = search_candidate_limit(PageLimit::MAX as usize);
        let max_probe_k = if admission.recipient.is_some() {
            let probe_limit = RECIPIENT_LIMIT + 1;
            filter.nodes.as_ref().map_or(probe_limit, |nodes| {
                // The base mask bounds distinct indexed notes. Receipts may
                // introduce new ones. Preserve the ordinary vector chunk depth.
                nodes
                    .cardinality()
                    .saturating_add(aligned.overlay.len() as u64)
                    .clamp(ordinary_limit as u64, probe_limit as u64) as usize
            })
        } else {
            ordinary_limit
        };
        let excluded: Arc<BTreeSet<_>> = Arc::new(aligned.overlay.keys().cloned().collect());
        let overlay_hits = Arc::new(
            rank_overlay(
                self,
                clock,
                &request,
                &aligned.overlay,
                &filter,
                state.as_deref(),
                filtered,
            )
            .await?,
        );

        let can_widen = admission.recipient.is_some()
            && ordinary_limit < RECIPIENT_LIMIT
            && max_probe_k > ordinary_limit + 1;
        let initial_cap = if can_widen {
            ordinary_limit
        } else {
            RECIPIENT_LIMIT
        };
        let initial_k = if can_widen {
            ordinary_limit + 1
        } else {
            max_probe_k
        };
        let initial_fallback = if admission.recipient.is_some() {
            initial_k
        } else {
            floor
        };
        let lexical = lexical_candidates(
            clock,
            snapshot.clone(),
            state.clone(),
            filter.clone(),
            excluded.clone(),
            request.text.clone(),
            initial_k,
            initial_fallback,
            filtered,
            overlay_hits.clone(),
        );
        let vectors = self.vector_candidates(VectorRequest {
            ctx: &ctx,
            query: &request,
            clock,
            filter: filter.clone(),
            snapshot: snapshot.clone(),
            state: state.clone(),
            handle,
            excluded: excluded.clone(),
            limit: initial_k,
            browse,
        });
        let (mut notes, mut vectors) = tokio::try_join!(lexical, vectors)?;
        let strict_overflow = notes.strict_len > initial_cap;
        let weak_overflow = !strict_overflow && notes.hits.len() > initial_cap;
        notes.hits.truncate(initial_cap);
        notes.strict_len = notes.strict_len.min(initial_cap);
        let vector_overflow =
            initial_k > initial_cap && ranking::trim_vector_window(&mut vectors.hits, initial_cap);
        let floor_filled = if admission.recipient.is_some()
            && (notes.hits.len() > notes.strict_len || weak_overflow)
        {
            admission.fill_fallback(self, &mut notes, floor).await?
        } else {
            false
        };
        let pass1_overflow = strict_overflow || vector_overflow || (weak_overflow && !floor_filled);
        let mut candidates = ranking::fuse(notes.hits, vectors.hits, browse);
        let mut graph_truncated =
            if let Some(recall) = recall.filter(|recall| recall.graph_depth != 0) {
                ranking::expand(
                    &mut candidates,
                    snapshot.as_ref(),
                    self,
                    &mut admission,
                    &filter,
                    &request.filter.predicate,
                    recall.graph_depth,
                )
                .await?
            } else {
                false
            };
        let mut selected = admission
            .select(
                self,
                candidates.into_iter(),
                |candidate| &candidate.note,
                top_k + 1,
                can_widen,
            )
            .await?;
        let any_rejected = admission.checked.values().any(|&admitted| !admitted);
        let mut window_truncated = if can_widen { false } else { pass1_overflow };
        let mut embedder = vectors.embedder;
        let mut degraded = vectors.degraded;

        if can_widen && any_rejected && selected.len() <= top_k && pass1_overflow {
            let wide_lexical = lexical_candidates(
                clock,
                snapshot.clone(),
                state.clone(),
                filter.clone(),
                excluded.clone(),
                request.text.clone(),
                max_probe_k,
                max_probe_k,
                filtered,
                overlay_hits,
            );
            let wide_vectors = async {
                if let Some(prepared) = vectors.prepared.as_ref() {
                    self.widen_prepared_vectors(
                        prepared,
                        clock,
                        snapshot.clone(),
                        filter.clone(),
                        excluded.clone(),
                        max_probe_k,
                    )
                    .await
                } else {
                    Ok(VectorCandidates {
                        hits: Vec::new(),
                        embedder: embedder.clone(),
                        degraded,
                        prepared: None,
                    })
                }
            };
            let (mut notes, mut wide_vec) = tokio::try_join!(wide_lexical, wide_vectors)?;
            let strict_overflow = notes.strict_len > RECIPIENT_LIMIT;
            let weak_overflow = !strict_overflow && notes.hits.len() > RECIPIENT_LIMIT;
            notes.hits.truncate(RECIPIENT_LIMIT);
            notes.strict_len = notes.strict_len.min(RECIPIENT_LIMIT);
            let vector_overflow = max_probe_k > RECIPIENT_LIMIT
                && ranking::trim_vector_window(&mut wide_vec.hits, RECIPIENT_LIMIT);
            let floor_filled = if notes.hits.len() > notes.strict_len || weak_overflow {
                admission.fill_fallback(self, &mut notes, floor).await?
            } else {
                false
            };
            window_truncated =
                strict_overflow || vector_overflow || (weak_overflow && !floor_filled);
            if wide_vec.embedder.is_some() {
                embedder = wide_vec.embedder;
            }
            if wide_vec.degraded.is_some() {
                degraded = wide_vec.degraded;
            }
            let mut candidates = ranking::fuse(notes.hits, wide_vec.hits, browse);
            graph_truncated = if let Some(recall) = recall.filter(|recall| recall.graph_depth != 0)
            {
                ranking::expand(
                    &mut candidates,
                    snapshot.as_ref(),
                    self,
                    &mut admission,
                    &filter,
                    &request.filter.predicate,
                    recall.graph_depth,
                )
                .await?
            } else {
                false
            };
            selected = admission
                .select(
                    self,
                    candidates.into_iter(),
                    |candidate| &candidate.note,
                    top_k + 1,
                    false,
                )
                .await?;
        }

        let fallback = RemoteConservativeTokenizerBudget::lexical_fallback();
        let tokenizer = embedder
            .as_deref()
            .map(Embedder::tokenizer)
            .unwrap_or(&fallback);
        let (hits, notes_truncated) = self
            .hydrate_notes(hydrate::Hydration {
                admission,
                text: &request.text,
                selected,
                tokenizer,
                top_k,
                delivery,
            })
            .await?;
        let (mut chat_hits, chat_truncated) = if let Some(state) =
            state.filter(|_| recall.is_none() && request.include_chats && !browse)
        {
            if hits.is_empty() {
                ctx.budget = clock.remaining()?;
                self.search_chats(&ctx, clock, &request, snapshot, state, filter)
                    .await?
            } else {
                // Reserve a short tail for final live-visibility verification so
                // a chat deadline preserves already-hydrated note hits.
                let mut chat_budget = clock.remaining()?;
                let reserve = Duration::from_millis(25).min(chat_budget.remaining / 5);
                if chat_budget.remaining <= reserve {
                    (Vec::new(), true)
                } else {
                    chat_budget.remaining -= reserve;
                    let chat_clock = Clock::new(&chat_budget)?;
                    ctx.budget = chat_clock.remaining()?;
                    match chat_clock
                        .within(self.search_chats(
                            &ctx,
                            &chat_clock,
                            &request,
                            snapshot,
                            state,
                            filter,
                        ))
                        .await
                    {
                        Ok(result) => result,
                        Err(PortError::DeadlineExceeded(_)) => (Vec::new(), true),
                        Err(error) => return Err(error),
                    }
                }
            }
        } else {
            (Vec::new(), false)
        };
        let (hits, packing_truncated) = self
            .finish_hits(
                &ctx,
                clock,
                hits,
                delivery,
                &mut chat_hits,
                aligned.cut.canonical_seq,
            )
            .await?;
        Ok(SearchResult {
            hits,
            chat_hits,
            cut: aligned.cut,
            degraded,
            truncated: window_truncated
                || graph_truncated
                || notes_truncated
                || chat_truncated
                || packing_truncated,
        })
    }

    async fn vector_candidates(
        &self,
        mut input: VectorRequest<'_>,
    ) -> Result<VectorCandidates, PortError> {
        if input.browse
            || input.filter.classes.is_empty()
            || input
                .filter
                .folders
                .as_ref()
                .is_some_and(BTreeSet::is_empty)
            || matches!(self.services.config.vector_mode, VectorMode::Disabled)
        {
            return Ok(VectorCandidates::default());
        }
        let Some(state) = input.state.take() else {
            return Ok(VectorCandidates::degraded(
                SearchDegradation::EmbeddingsPending,
            ));
        };
        let request_clock = input.clock;
        let remaining = request_clock.remaining()?.remaining;
        let needs_embedder_reload = state.vectors.is_some()
            && state.embedder.is_none()
            && state.active_model.is_some()
            && !state.embedder_unavailable;
        let waiting_for_vectors = state.reopening_vectors || needs_embedder_reload;
        // Leave time for lexical hydration when a durable vector mapping or
        // native model is still opening. Fast reopens can serve the first query.
        let max = if waiting_for_vectors {
            remaining / 2
        } else {
            remaining
        };
        let clock = request_clock.limited(max.min(self.services.config.interactive_budget()));
        let work = self.search_vector_index(
            VectorRequest {
                clock: &clock,
                ..input
            },
            state,
            needs_embedder_reload,
        );
        match clock.within(work).await {
            Err(PortError::DeadlineExceeded(_)) => {
                request_clock.remaining()?;
                Ok(VectorCandidates::degraded(
                    SearchDegradation::BudgetExceeded,
                ))
            }
            result => result,
        }
    }

    async fn search_vector_index(
        &self,
        input: VectorRequest<'_>,
        state: Arc<Published>,
        needs_embedder_reload: bool,
    ) -> Result<VectorCandidates, PortError> {
        let VectorRequest {
            ctx,
            query,
            clock,
            filter,
            snapshot,
            handle,
            excluded,
            limit,
            ..
        } = input;
        let waiting_for_vectors = state.reopening_vectors || needs_embedder_reload;
        let (state, embedder, vector) = match async {
            let state = if waiting_for_vectors {
                let mut updated = handle.epoch.subscribe();
                if needs_embedder_reload {
                    handle.wake.notify_one();
                }
                loop {
                    let Some(current) = handle.published.load_full() else {
                        return Ok(None);
                    };
                    if current.scope != state.scope
                        || current.seq != state.seq
                        || !Arc::ptr_eq(&current.lexical, &state.lexical)
                    {
                        // A live edit advanced the published cut while vectors
                        // were reopening; degrade to EmbeddingsPending instead
                        // of reporting a false ModelUnavailable.
                        return Ok(None);
                    }
                    if !current.reopening_vectors
                        && (current.embedder.is_some()
                            || current.vectors.is_none()
                            || current.active_model.is_none()
                            || current.embedder_unavailable)
                    {
                        break current;
                    }
                    if needs_embedder_reload && !current.reopening_vectors {
                        handle.wake.notify_one();
                    }
                    updated
                        .changed()
                        .await
                        .map_err(|_| EmbeddingError::Cancelled)?;
                }
            } else {
                state
            };
            // Lexical results are ready while the worker waits to retry checkpoint I/O.
            if state.vectors.is_none() && state.embedder_unavailable {
                return Err(EmbeddingError::ModelUnavailable);
            }
            let resolve_budget = clock
                .remaining()
                .map_err(|_| EmbeddingError::BudgetExceeded)?;
            let requested = self
                .services
                .model_target(ctx.scope(), query.model.as_ref(), &resolve_budget)
                .await?
                .ok_or(EmbeddingError::ModelUnavailable)?;
            let query_project =
                if matches!(requested.backend, EmbeddingBackendTarget::Remote { .. }) {
                    filter
                        .query_project(snapshot.as_ref(), query.folder.as_ref())
                        .await?
                } else {
                    None
                };
            if let EmbeddingBackendTarget::Remote {
                project: Some(expected),
                ..
            } = &requested.backend
                && query_project.as_ref() != Some(expected)
            {
                // A changed default still needs indexing when this request cannot
                // disclose its query to the newly selected project.
                if query.model.is_none() && state.active_model.as_ref() != Some(&requested) {
                    handle.wake.notify_one();
                }
                return Err(EmbeddingError::ProviderUnavailable);
            }
            let Some(indexed) = &state.vectors else {
                handle.wake.notify_one();
                if state
                    .active_model
                    .as_ref()
                    .is_some_and(|active| active.vector_model() == requested.vector_model())
                    && state.embedder.is_none()
                {
                    return Err(EmbeddingError::ModelUnavailable);
                }
                return Ok(None);
            };
            let target = if indexed.manifest().model == requested.vector_model() {
                &requested
            } else {
                handle.wake.notify_one();
                if query.model.is_some() {
                    return Ok(None);
                }
                let Some(active) = state.active_model.as_ref() else {
                    return Ok(None);
                };
                if !can_fallback_to_active(active, &requested) {
                    return Ok(None);
                }
                active
            };
            if let EmbeddingBackendTarget::Remote { project, .. } = &target.backend
                && (ctx.auth().taint().is_tainted()
                    || project
                        .as_ref()
                        .is_some_and(|expected| query_project.as_ref() != Some(expected)))
            {
                return Err(EmbeddingError::ProviderUnavailable);
            }
            let Some(embedder) = state.embedder.clone() else {
                handle.wake.notify_one();
                return Err(EmbeddingError::ModelUnavailable);
            };
            let mut context = ctx.clone();
            context.budget = clock
                .remaining()
                .map_err(|_| EmbeddingError::BudgetExceeded)?;
            let embedding = embedder
                .query(
                    &self.services,
                    context,
                    query,
                    filter.classes.clone(),
                    query_project,
                    &requested,
                )
                .await?;
            Ok::<_, EmbeddingError>(Some((state, embedder, embedding)))
        }
        .await
        {
            Ok(Some(ready)) => ready,
            Ok(None) => {
                return Ok(VectorCandidates::degraded(
                    SearchDegradation::EmbeddingsPending,
                ));
            }
            Err(error) => {
                if matches!(error, EmbeddingError::TargetChanged) {
                    handle.wake.notify_one();
                }
                return Ok(VectorCandidates::degraded(error.degradation()));
            }
        };
        let pending = state
            .embeddings_pending
            .then_some(SearchDegradation::EmbeddingsPending);
        let prepared = PreparedVector {
            state,
            vector,
            embedder,
            pending,
        };
        let mut result = self
            .search_prepared_vectors(&prepared, clock, snapshot, filter, excluded, limit)
            .await?;
        result.prepared = Some(prepared);
        Ok(result)
    }

    async fn widen_prepared_vectors(
        &self,
        prepared: &PreparedVector,
        request_clock: &Clock,
        snapshot: Arc<dyn StructuralSnapshot>,
        filter: Arc<Eligible>,
        excluded: Arc<BTreeSet<NoteId>>,
        limit: usize,
    ) -> Result<VectorCandidates, PortError> {
        let remaining = request_clock.remaining()?.remaining;
        let clock = request_clock.limited(remaining.min(self.services.config.interactive_budget()));
        let work =
            self.search_prepared_vectors(prepared, &clock, snapshot, filter, excluded, limit);
        match clock.within(work).await {
            Err(PortError::DeadlineExceeded(_)) => {
                request_clock.remaining()?;
                Ok(VectorCandidates::degraded(
                    SearchDegradation::BudgetExceeded,
                ))
            }
            result => result,
        }
    }

    async fn search_prepared_vectors(
        &self,
        prepared: &PreparedVector,
        clock: &Clock,
        snapshot: Arc<dyn StructuralSnapshot>,
        filter: Arc<Eligible>,
        excluded: Arc<BTreeSet<NoteId>>,
        limit: usize,
    ) -> Result<VectorCandidates, PortError> {
        let vectors = loop {
            clock.remaining()?;
            let snapshot_attempt = snapshot.clone();
            let filter_attempt = filter.clone();
            let excluded_attempt = excluded.clone();
            let state_attempt = prepared.state.clone();
            let vector_attempt = prepared.vector.clone();
            let result = blocking_search(clock, "vector_search_worker", move |budget| {
                let index = state_attempt
                    .vectors
                    .as_ref()
                    .ok_or(crate::vector::VectorError::CorruptIndex)?;
                index.search_projected(
                    &vector_attempt,
                    ProjectedVectorFilter {
                        snapshot: snapshot_attempt.as_ref(),
                        classes: &filter_attempt.classes,
                        folders: filter_attempt.ordinals.as_deref(),
                        nodes: filter_attempt.nodes.as_ref(),
                        excluded: &excluded_attempt,
                    },
                    limit,
                    budget,
                )
            })
            .await?;
            match result {
                Err(crate::vector::VectorError::Domain(error)) if is_not_ready(&error) => {
                    clock.within(snapshot.wait_ready()).await?;
                }
                other => break other,
            }
        };
        match vectors {
            Ok(vectors) => Ok(VectorCandidates {
                hits: vectors.hits,
                embedder: Some(prepared.embedder.clone()),
                degraded: prepared.pending,
                prepared: None,
            }),
            Err(crate::vector::VectorError::Cancelled) => {
                clock.remaining()?;
                Ok(VectorCandidates::degraded(
                    SearchDegradation::BudgetExceeded,
                ))
            }
            Err(crate::vector::VectorError::Domain(error)) => Err(error.into()),
            Err(_) => Ok(VectorCandidates::degraded(
                SearchDegradation::ModelUnavailable,
            )),
        }
    }
}

/// Privacy-first fallback policy when a new default model is still backfilling:
/// local active indices may serve queries without external disclosure; remote
/// active indices may only serve when provider, runtime epochs, and project
/// scope are identical to the requested target.
fn can_fallback_to_active(
    active: &ResolvedEmbeddingTarget,
    requested: &ResolvedEmbeddingTarget,
) -> bool {
    match (&active.backend, &requested.backend) {
        (EmbeddingBackendTarget::LocalOnnx | EmbeddingBackendTarget::LocalOnnxCls, _) => true,
        (
            EmbeddingBackendTarget::Remote {
                provider: active_provider,
                runtime_epochs: active_epochs,
                project: active_project,
            },
            EmbeddingBackendTarget::Remote {
                provider: req_provider,
                runtime_epochs: req_epochs,
                project: req_project,
            },
        ) => {
            active_provider == req_provider
                && active_epochs == req_epochs
                && active_project == req_project
        }
        (EmbeddingBackendTarget::Remote { .. }, _) => false,
    }
}

pub(super) fn is_not_ready(error: &DomainError) -> bool {
    matches!(
        error,
        DomainError::ValidationFailed { diagnostic }
            if diagnostic.reason == ValidationReason::NotReady
    )
}

pub(super) async fn retry_snapshot<T>(
    snapshot: &dyn StructuralSnapshot,
    clock: &Clock,
    mut op: impl FnMut() -> DomainResult<T>,
) -> Result<T, PortError> {
    loop {
        clock.remaining()?;
        match op() {
            Ok(value) => return Ok(value),
            Err(error) if is_not_ready(&error) => {
                clock.within(snapshot.wait_ready()).await?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

struct VectorRequest<'a> {
    ctx: &'a SpaceContext,
    query: &'a SearchQuery,
    clock: &'a Clock,
    filter: Arc<Eligible>,
    snapshot: Arc<dyn StructuralSnapshot>,
    state: Option<Arc<Published>>,
    handle: &'a crate::engine::SpaceHandle,
    excluded: Arc<BTreeSet<NoteId>>,
    limit: usize,
    browse: bool,
}

struct PreparedVector {
    state: Arc<Published>,
    vector: crate::vector::QuantizedVector,
    embedder: Arc<Embedder>,
    pending: Option<SearchDegradation>,
}

#[derive(Default)]
struct VectorCandidates {
    hits: Vec<VectorHit>,
    embedder: Option<Arc<Embedder>>,
    degraded: Option<SearchDegradation>,
    prepared: Option<PreparedVector>,
}

impl VectorCandidates {
    fn degraded(reason: SearchDegradation) -> Self {
        Self {
            degraded: Some(reason),
            ..Self::default()
        }
    }
}

struct Eligible {
    cut: SnapshotCut,
    classes: BTreeSet<DocClass>,
    project_root: Option<FolderId>,
    grant_root: Option<FolderId>,
    folders: Option<BTreeSet<FolderId>>,
    ordinals: Option<Arc<Bitmap>>,
    chat_folders: Option<Arc<Bitmap>>,
    chat_viewer: Option<PrincipalId>,
    nodes: Option<Bitmap>,
}

impl Eligible {
    async fn new(
        ctx: &SpaceContext,
        query: &SearchQuery,
        snapshot: &dyn StructuralSnapshot,
        state: Option<&Published>,
        chat_space: Option<&notarium_core::auth::Space>,
    ) -> Result<Self, PortError> {
        let cut = snapshot.cut().clone();
        let grant = ctx
            .auth()
            .spaces()
            .get(&cut.scope.space_id)
            .ok_or(DomainError::ResourceNotFound)?;
        let classes: BTreeSet<_> = grant
            .read_classes
            .iter()
            .copied()
            .filter(|class| {
                *class != DocClass::EncryptedNote
                    && (query.classes.is_empty() || query.classes.contains(class))
            })
            .collect();
        let root = grant.project_root.as_ref();
        // A Keeper's authorized structural snapshot includes its pinned skills,
        // which can live outside the project. A requested folder still narrows
        // those notes just as it narrows ordinary project notes.
        let includes_pins =
            classes.contains(&DocClass::Skill) && !ctx.auth().readonly_abilities().is_empty();
        let note_root = root.filter(|_| !includes_pins);
        let scope_folders = [query.folder.as_ref(), note_root];
        let mut folders: Option<BTreeSet<FolderId>> = None;
        for folder in scope_folders.into_iter().flatten() {
            let descendants: BTreeSet<_> = snapshot
                .folder_descendants(folder)
                .await?
                .into_iter()
                .collect();
            if let Some(folders) = &mut folders {
                folders.retain(|id| descendants.contains(id));
            } else {
                folders = Some(descendants);
            }
        }
        let ordinals = folders.as_ref().map(|folders| {
            Arc::new(
                folders
                    .iter()
                    .filter_map(|id| {
                        state
                            .and_then(|state| state.folders.get(id))
                            .map(crate::layout::FolderOrd::get)
                    })
                    .collect::<Bitmap>(),
            )
        });
        let chat_folders = match root {
            Some(root) => {
                let mut pinned = Bitmap::new();
                if let Some(ordinal) = state.and_then(|state| state.folders.get(root))
                    && ordinals
                        .as_ref()
                        .is_none_or(|folders| folders.contains(ordinal.get()))
                {
                    pinned.add(ordinal.get());
                }
                Some(Arc::new(pinned))
            }
            None => ordinals.clone(),
        };
        let mut nodes = snapshot
            .filter_notes(&query.filter)
            .await?
            .map(|nodes| {
                nodes
                    .map(|node| node.index(cut.generation))
                    .collect::<Result<Bitmap, _>>()
            })
            .transpose()?;
        for folder in scope_folders.into_iter().flatten() {
            let mask = snapshot
                .folder_subtree(folder)
                .await?
                .map(|node| node.index(cut.generation))
                .collect::<Result<Bitmap, _>>()?;
            if let Some(nodes) = &mut nodes {
                nodes.and_inplace(&mask);
            } else {
                nodes = Some(mask);
            }
        }
        Ok(Self {
            cut,
            classes,
            project_root: note_root.cloned(),
            grant_root: root.cloned(),
            folders,
            ordinals,
            chat_folders,
            chat_viewer: chat_space
                .filter(|space| {
                    ctx.auth()
                        .can_view_own_personal_chat(space, root, false)
                        .is_ok()
                })
                .map(|_| ctx.auth().principal().clone()),
            nodes,
        })
    }

    /// Resolve provider scope only for a remote target, within the vector deadline.
    /// Broad searches that include pinned reads outside the Keeper's root return
    /// `None` so project-only remote embedders fail closed, and folder-narrowed
    /// Keeper searches never borrow a different project's consent.
    async fn query_project(
        &self,
        snapshot: &dyn StructuralSnapshot,
        folder: Option<&FolderId>,
    ) -> Result<Option<FolderRef>, EmbeddingError> {
        let project = match (&self.project_root, folder) {
            (Some(root), _) => Some(root.clone()),
            (None, Some(folder)) => {
                let enclosing = snapshot.enclosing_project(folder).await.map_err(|error| {
                    if matches!(error, PortError::DeadlineExceeded(_)) {
                        EmbeddingError::BudgetExceeded
                    } else {
                        EmbeddingError::ProviderUnavailable
                    }
                })?;
                match (&self.grant_root, enclosing) {
                    (Some(bound), Some(found)) if found != *bound => None,
                    (_, found) => found,
                }
            }
            (None, None) => None,
        };
        Ok(project.map(|folder_id| FolderRef {
            space_id: self.cut.scope.space_id.clone(),
            folder_id,
        }))
    }

    fn node_allowed(
        &self,
        snapshot: &dyn StructuralSnapshot,
        node: DenseNodeId,
    ) -> Result<bool, DomainError> {
        let index = node.index(self.cut.generation)?;
        Ok(self.classes.contains(&snapshot.doc_class(node)?)
            && self
                .nodes
                .as_ref()
                .is_none_or(|nodes| nodes.contains(index)))
    }

    fn overlay_allowed(
        &self,
        predicate: &Predicate,
        row: &crate::ports::SearchOverlayNote,
    ) -> bool {
        self.classes.contains(&row.document.class())
            && self
                .folders
                .as_ref()
                .is_none_or(|ids| ids.contains(&row.parent_folder_id))
            && predicate.matches(&row.fields)
    }
}

struct BlockingSearch<F> {
    stop: notarium_core::ports::Cancellation,
    task: tokio::task::AbortHandle,
    pending: Arc<std::sync::Mutex<Option<F>>>,
}

impl<F> Drop for BlockingSearch<F> {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
        // Tokio can leave an aborted task in a saturated blocking queue.
        // Release its captured index and projection as soon as the query drops.
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

async fn blocking_search<T: Send + 'static>(
    clock: &Clock,
    worker: &'static str,
    work: impl FnOnce(SearchBudget<'_>) -> T + Send + 'static,
) -> Result<T, PortError> {
    clock.remaining()?;
    let deadline = clock.deadline.into_std();
    let stop = notarium_core::ports::Cancellation::default();
    let worker_stop = stop.clone();
    let pending = Arc::new(std::sync::Mutex::new(Some(work)));
    let queued = pending.clone();
    let task = tokio::task::spawn_blocking(move || {
        let work = queued.lock().unwrap_or_else(|e| e.into_inner()).take()?;
        Some(work(SearchBudget {
            cancellation: &worker_stop,
            deadline,
        }))
    });
    let _guard = BlockingSearch {
        stop,
        task: task.abort_handle(),
        pending,
    };
    task.await
        .map_err(|_| internal(worker))?
        .ok_or_else(|| internal(worker))
}

async fn lexical_work<T: Send + 'static>(
    clock: &Clock,
    work: impl FnOnce(SearchBudget<'_>) -> Result<T, LexicalError> + Send + 'static,
) -> Result<T, PortError> {
    let result = blocking_search(clock, "lexical_search_worker", work).await?;
    clock.remaining()?;
    result.map_err(lexical_error)
}

pub(super) async fn lexical_work_with_retry<T: Send + 'static>(
    clock: &Clock,
    snapshot: &Arc<dyn StructuralSnapshot>,
    work: impl Fn(SearchBudget<'_>) -> Result<T, LexicalError> + Clone + Send + 'static,
) -> Result<T, PortError> {
    loop {
        clock.remaining()?;
        let result = blocking_search(clock, "lexical_search_worker", work.clone()).await?;
        clock.remaining()?;
        match result {
            Ok(value) => return Ok(value),
            Err(LexicalError::Domain(error)) if is_not_ready(&error) => {
                clock.within(snapshot.wait_ready()).await?;
            }
            Err(error) => return Err(lexical_error(error)),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn lexical_candidates(
    clock: &Clock,
    snapshot: Arc<dyn StructuralSnapshot>,
    state: Option<Arc<Published>>,
    filter: Arc<Eligible>,
    excluded: Arc<BTreeSet<NoteId>>,
    text: String,
    candidate_k: usize,
    fallback_window: usize,
    filtered: bool,
    overlay: Arc<OverlayHits>,
) -> Result<RankedLexical, PortError> {
    let Some(state) = state else {
        return Ok(overlay.merge(
            Vec::new(),
            Vec::new(),
            candidate_k,
            fallback_window,
            text.trim().is_empty(),
        ));
    };
    let snapshot_work = snapshot.clone();
    lexical_work_with_retry(clock, &snapshot, move |budget| {
        let notes_filter = LexicalFilter::new(
            snapshot_work.as_ref(),
            filter.ordinals.clone(),
            filter.nodes.as_ref(),
            filter.classes.iter().copied(),
            false,
        )
        .excluding(&excluded)
        .within(budget);
        state.lexical.search_with_overlay(
            &state.searcher,
            &text,
            &notes_filter,
            candidate_k,
            fallback_window,
            filtered,
            &overlay,
        )
    })
    .await
}

async fn rank_overlay(
    engine: &SearchEngine,
    clock: &Clock,
    query: &SearchQuery,
    overlay: &align::Overlay,
    filter: &Eligible,
    state: Option<&Published>,
    filtered: bool,
) -> Result<OverlayHits, PortError> {
    let mut dictionary = crate::layout::FolderDictionary::default();
    let mut notes = Vec::new();
    for row in overlay
        .values()
        .flatten()
        .filter(|row| filter.overlay_allowed(&query.filter.predicate, row))
    {
        if let Ok(content) =
            ClassEgressFence::index_for_search(row.document.clone(), &engine.services.authority)
        {
            let folder = dictionary
                .insert(row.parent_folder_id.clone())
                .map_err(|_| internal("overlay_folder"))?;
            notes.push((row.title.clone(), content, folder));
        }
    }
    if notes.is_empty() {
        return Ok(OverlayHits::default());
    }
    let base = state.map(|state| state.searcher.clone());
    let text = query.text.clone();
    lexical_work(clock, move |budget| {
        let updates: Vec<_> = notes
            .iter()
            .map(|(title, content, folder)| Update::Note {
                content,
                title,
                folder: *folder,
            })
            .collect();
        LexicalIndex::rank_overlay(&text, &updates, base.as_ref(), filtered, budget)
    })
    .await
}

fn lexical_error(error: LexicalError) -> PortError {
    match error {
        LexicalError::Domain(error) => error.into(),
        _ => internal("lexical_search"),
    }
}

#[cfg(test)]
mod blocking_worker_tests {
    use super::*;
    use notarium_core::{ids::RequestId, ports::CallBudget};
    use std::time::Duration;

    fn worker_clock() -> Clock {
        Clock::new(&CallBudget {
            request: RequestId::from_bytes([44; 16]),
            remaining: Duration::from_secs(10),
            cancellation: Default::default(),
        })
        .unwrap()
    }

    #[tokio::test]
    async fn dropping_the_query_signals_its_active_lexical_worker() {
        let clock = worker_clock();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (resume, wait) = std::sync::mpsc::channel();
        let (finished, stopped) = tokio::sync::oneshot::channel();
        let mut query = Box::pin(lexical_work(&clock, move |budget| {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            finished.send(budget.cancellation.is_cancelled()).unwrap();
            Ok(())
        }));
        tokio::select! {
            result = &mut query => panic!("lexical worker finished before cancellation: {result:?}"),
            signal = ready => signal.unwrap(),
        }
        drop(query);
        resume.send(()).unwrap();
        assert!(stopped.await.unwrap());
    }

    #[test]
    fn dropping_a_queued_vector_search_releases_its_pin_before_the_pool_is_free() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let (started, ready) = tokio::sync::oneshot::channel();
            let (resume, wait) = std::sync::mpsc::channel();
            let busy = tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
            });
            ready.await.unwrap();
            let clock = worker_clock();
            let index = Arc::new(());
            let retired = Arc::downgrade(&index);
            let mut query = Box::pin(blocking_search(&clock, "vector_search_worker", move |_| {
                drop(index);
                panic!("cancelled vector search started");
            }));
            tokio::select! {
                biased;
                _ = &mut query => panic!("vector search ran on the occupied pool"),
                () = std::future::ready(()) => {}
            }
            drop(query);
            assert!(retired.upgrade().is_none());
            resume.send(()).unwrap();
            busy.await.unwrap();
        });
    }
}
