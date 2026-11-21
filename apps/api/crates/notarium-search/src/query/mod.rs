mod align;
mod hydrate;
pub(crate) mod ranking;

use crate::{
    config::VectorMode,
    embed::{EmbeddingError, RemoteConservativeTokenizerBudget},
    engine::{Clock, Published, SearchEngine, internal, invalid},
    lexical::{LexicalError, LexicalFilter, LexicalHit, LexicalIndex, OverlayHits, Update},
    model::Embedder,
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
    vector::{EXACT_SCAN_LIMIT, SearchBudget, VectorFilter, VectorHit},
};
use croaring::Bitmap;
use notarium_core::{
    DomainError, DomainResult,
    classes::{ClassEgressFence, DocClass},
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, PrincipalId},
    model::{DenseNodeId, FolderRef, SnapshotCut},
    ports::{
        PortFuture, RecallQuery, SearchDegradation, SearchPort, SearchQuery, SearchResult,
        SpaceContext, StructuralSnapshot,
    },
    query::Predicate,
};
use std::{collections::BTreeSet, sync::Arc, time::Duration};

const MAX_OVERLAY_FALLBACK_FLOOR: usize = 10;

#[derive(Clone, Copy)]
struct Recall {
    graph_depth: u8,
    tokens: u32,
}

impl SearchPort for SearchEngine {
    fn search(&self, ctx: SpaceContext, request: SearchQuery) -> PortFuture<'_, SearchResult> {
        Box::pin(self.run_query(ctx, request, None))
    }

    fn recall(&self, ctx: SpaceContext, request: RecallQuery) -> PortFuture<'_, SearchResult> {
        Box::pin(async move {
            if request.graph_depth > 2 {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
            if !(1..=131_072).contains(&request.token_budget) {
                return Err(invalid(ValidationReason::TokenBudgetExceeded));
            }
            self.run_query(
                ctx,
                request.query,
                Some(Recall {
                    graph_depth: request.graph_depth,
                    tokens: request.token_budget,
                }),
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
        recall: Option<Recall>,
    ) -> Result<SearchResult, PortError> {
        let clock = Clock::new(&ctx.budget)?;
        clock
            .within(self.query_at_cut(ctx, request, recall, &clock))
            .await
    }

    async fn query_at_cut(
        &self,
        mut ctx: SpaceContext,
        request: SearchQuery,
        recall: Option<Recall>,
        clock: &Clock,
    ) -> Result<SearchResult, PortError> {
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
        let chat_space = if request.include_chats && recall.is_none() && !browse {
            let record = self
                .services
                .deps
                .canonical
                .read_space(&ctx.scope().space_id)
                .await?;
            ctx.check_current(&record.scope)?;
            Some(record.space)
        } else {
            None
        };
        let filter = Arc::new(
            Eligible::new(
                &ctx,
                &request,
                snapshot.as_ref(),
                state.as_deref(),
                chat_space.as_ref(),
            )
            .await?,
        );
        let top_k = usize::from(request.top_k.get());
        let candidate_k = (top_k * 4).max(100);
        let excluded: Arc<BTreeSet<_>> = Arc::new(aligned.overlay.keys().cloned().collect());

        let lexical = lexical_candidates(
            clock,
            snapshot.clone(),
            state.clone(),
            filter.clone(),
            excluded.clone(),
            request.text.clone(),
            candidate_k,
            top_k,
            filtered,
        );
        let vectors = self.vector_candidates(VectorRequest {
            ctx: &ctx,
            query: &request,
            clock,
            filter: filter.clone(),
            snapshot: snapshot.clone(),
            state: state.clone(),
            handle,
            excluded,
            limit: candidate_k,
            browse,
        });
        let (mut notes, vectors) = tokio::try_join!(lexical, vectors)?;
        let overlay =
            rank_overlay(self, clock, &request, &aligned.overlay, &filter, filtered).await?;
        if browse {
            notes.extend(overlay.strict);
            notes.sort_by(|left, right| note_key(left).cmp(&note_key(right)));
        } else {
            // Receipt-bound strict hits lead the lexical stream. Fallback 1-term
            // overlay hits only fill behind strict matches below the floor.
            let mut fresh = overlay.strict;
            fresh.extend(notes);
            let fallback_floor = top_k.min(MAX_OVERLAY_FALLBACK_FLOOR);
            if fresh.len() < fallback_floor && !overlay.fallback.is_empty() {
                let mut seen: BTreeSet<NoteId> = fresh
                    .iter()
                    .filter_map(|hit| note_key(hit).cloned())
                    .collect();
                for hit in overlay.fallback {
                    if let Some(note) = note_key(&hit)
                        && seen.insert(note.clone())
                    {
                        fresh.push(hit);
                    }
                }
            }
            notes = fresh;
        }

        let mut candidates = ranking::fuse(notes, vectors.hits, browse);
        if let Some(recall) = recall.filter(|recall| recall.graph_depth != 0) {
            ranking::expand(
                &mut candidates,
                snapshot.as_ref(),
                self.services.deps.structural.as_ref(),
                &ctx,
                clock,
                &filter,
                &request.filter.predicate,
                &aligned.overlay,
                recall.graph_depth,
            )
            .await?;
        }
        let fallback = RemoteConservativeTokenizerBudget::lexical_fallback();
        let tokenizer = vectors
            .embedder
            .as_deref()
            .map(Embedder::tokenizer)
            .unwrap_or(&fallback);
        let (hits, notes_truncated) = self
            .hydrate_notes(hydrate::Hydration {
                context: &ctx,
                text: &request.text,
                clock,
                cut: &aligned.base_cut,
                overlay: &aligned.overlay,
                candidates,
                tokenizer,
                top_k,
                recall,
            })
            .await?;
        let (chat_hits, chat_truncated) = if let Some(state) =
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
        // Chat hydration can yield while canonical access to a selected note changes.
        let (hits, packing_truncated) = self.finish_note_hits(&ctx, clock, hits, recall).await?;
        Ok(SearchResult {
            hits,
            chat_hits,
            cut: aligned.cut,
            degraded: vectors.degraded,
            truncated: notes_truncated || chat_truncated || packing_truncated,
        })
    }

    async fn vector_candidates(
        &self,
        input: VectorRequest<'_>,
    ) -> Result<VectorCandidates, PortError> {
        let VectorRequest {
            ctx,
            query,
            clock,
            filter,
            snapshot,
            state,
            handle,
            excluded,
            limit,
            browse,
        } = input;
        if browse
            || filter.classes.is_empty()
            || filter.folders.as_ref().is_some_and(BTreeSet::is_empty)
            || matches!(self.services.config.vector_mode, VectorMode::Disabled)
        {
            return Ok(VectorCandidates::default());
        }
        let Some(state) = state else {
            return Ok(VectorCandidates::degraded(
                SearchDegradation::EmbeddingsPending,
            ));
        };
        let remaining = clock.remaining()?.remaining;
        // Leave time for lexical hydration when a durable vector mapping or
        // native model is still opening. Fast reopens can serve the first query.
        let max = if state.reopening_vectors {
            remaining / 2
        } else {
            remaining
        };
        let max = max.min(self.services.config.interactive_budget());
        let (state, embedder, vector) = match tokio::time::timeout(max, async {
            let state = if state.reopening_vectors {
                let mut updated = handle.epoch.subscribe();
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
                    if !current.reopening_vectors {
                        break current;
                    }
                    updated
                        .changed()
                        .await
                        .map_err(|_| EmbeddingError::Cancelled)?;
                }
            } else {
                state
            };
            let mut resolve_budget = clock
                .remaining()
                .map_err(|_| EmbeddingError::BudgetExceeded)?;
            resolve_budget.remaining = resolve_budget.remaining.min(max);
            let requested = self
                .services
                .model_target(ctx.scope(), query.model.as_ref(), &resolve_budget)
                .await?
                .ok_or(EmbeddingError::ModelUnavailable)?;
            if let EmbeddingBackendTarget::Remote {
                project: Some(expected),
                ..
            } = &requested.backend
                && filter.project.as_ref() != Some(expected)
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
                        .is_some_and(|expected| filter.project.as_ref() != Some(expected)))
            {
                return Err(EmbeddingError::ProviderUnavailable);
            }
            let Some(embedder) = state.embedder.clone() else {
                handle.wake.notify_one();
                return Err(EmbeddingError::ModelUnavailable);
            };
            let input = query.text.clone();
            let mut context = ctx.clone();
            context.budget = clock
                .remaining()
                .map_err(|_| EmbeddingError::BudgetExceeded)?;
            let embedding = embedder
                .query(
                    &self.services,
                    context,
                    input,
                    filter.classes.clone(),
                    filter.project.clone(),
                )
                .await?;
            Ok::<_, EmbeddingError>(Some((state, embedder, embedding)))
        })
        .await
        {
            Ok(Ok(Some(ready))) => ready,
            Ok(Ok(None)) => {
                return Ok(VectorCandidates::degraded(
                    SearchDegradation::EmbeddingsPending,
                ));
            }
            Ok(Err(error)) => return Ok(VectorCandidates::degraded(error.degradation())),
            Err(_) => {
                return Ok(VectorCandidates::degraded(
                    SearchDegradation::BudgetExceeded,
                ));
            }
        };
        let pending = state
            .embeddings_pending
            .then_some(SearchDegradation::EmbeddingsPending);
        let vector_notes = match &filter.nodes {
            Some(nodes) if nodes.cardinality() <= EXACT_SCAN_LIMIT => Some(Arc::new(
                retry_snapshot(snapshot.as_ref(), clock, || {
                    let mut ids = BTreeSet::new();
                    for index in nodes.iter() {
                        match snapshot.note_id(DenseNodeId::new(filter.cut.generation, index)) {
                            Ok(id) => {
                                ids.insert(id);
                            }
                            Err(DomainError::ResourceNotFound) => continue,
                            Err(error) => return Err(error),
                        }
                    }
                    Ok(ids)
                })
                .await?,
            )),
            _ => None,
        };
        let vectors = loop {
            clock.remaining()?;
            let snapshot_attempt = snapshot.clone();
            let filter_attempt = filter.clone();
            let excluded_attempt = excluded.clone();
            let state_attempt = state.clone();
            let vector_attempt = vector.clone();
            let notes_attempt = vector_notes.clone();
            let result = blocking_search(clock, "vector_search_worker", move |budget| {
                let visible = |note: &NoteId| -> Result<bool, crate::vector::VectorError> {
                    let node = match snapshot_attempt.lookup(note) {
                        Ok(Some(node)) => node,
                        Ok(None) | Err(DomainError::ResourceNotFound) => return Ok(false),
                        Err(error) => return Err(error.into()),
                    };
                    match filter_attempt.node_allowed(snapshot_attempt.as_ref(), node) {
                        Ok(allowed) => Ok(allowed),
                        Err(DomainError::ResourceNotFound) => Ok(false),
                        Err(error) => Err(error.into()),
                    }
                };
                let mask = VectorFilter {
                    classes: &filter_attempt.classes,
                    folders: filter_attempt.ordinals.as_deref(),
                    notes: notes_attempt.as_deref(),
                    excluded: Some(&excluded_attempt),
                };
                let index = state_attempt
                    .vectors
                    .as_ref()
                    .ok_or(crate::vector::VectorError::CorruptIndex)?;
                index.search_visible(&vector_attempt, &mask, limit, budget, visible)
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
                embedder: Some(embedder),
                degraded: pending,
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

#[derive(Default)]
struct VectorCandidates {
    hits: Vec<VectorHit>,
    embedder: Option<Arc<Embedder>>,
    degraded: Option<SearchDegradation>,
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
    project: Option<FolderRef>,
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
        // Only label a query as project-scoped when its requested search
        // domain fits that project. Pinned reads do not widen provider consent.
        let project = match (note_root, query.folder.as_ref()) {
            (Some(root), _) => Some(root.clone()),
            (None, Some(folder)) => snapshot.enclosing_project(folder).await?,
            (None, None) => None,
        }
        .map(|folder_id| FolderRef {
            space_id: cut.scope.space_id.clone(),
            folder_id,
        });
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
            project,
            folders,
            ordinals,
            chat_folders,
            chat_viewer: chat_space
                .filter(|space| {
                    ctx.auth()
                        .can_view_chat_thread(
                            space,
                            notarium_core::ports::ChatThreadKind::Personal,
                            ctx.auth().principal(),
                            root,
                            false,
                        )
                        .is_ok()
                })
                .map(|_| ctx.auth().principal().clone()),
            nodes,
        })
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
    top_k: usize,
    filtered: bool,
) -> Result<Vec<LexicalHit>, PortError> {
    let Some(state) = state else {
        return Ok(Vec::new());
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
        state.lexical.search_pinned(
            &state.searcher,
            &text,
            &notes_filter,
            candidate_k,
            top_k,
            filtered,
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
        LexicalIndex::rank_overlay(&text, &updates, filtered, budget)
    })
    .await
}

fn note_key(hit: &LexicalHit) -> Option<&NoteId> {
    match &hit.key {
        crate::lexical::HitKey::Note(note) => Some(note),
        _ => None,
    }
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
