mod align;
mod hydrate;
pub(crate) mod ranking;

use crate::{
    config::VectorMode,
    embed::{EmbeddingError, RemoteConservativeTokenizerBudget},
    engine::{Clock, Published, SearchEngine, internal, invalid},
    lexical::{LexicalError, LexicalFilter, LexicalHit, LexicalIndex, Update},
    model::Embedder,
    ports::EmbeddingBackendTarget,
    vector::{SearchBudget, VectorFilter, VectorHit},
};
use croaring::Bitmap;
use notarium_core::{
    DomainError,
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
use std::{collections::BTreeSet, sync::Arc};

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
            return Ok(SearchResult {
                hits: Vec::new(),
                chat_hits: Vec::new(),
                cut: snapshot.cut().clone(),
                degraded: None,
                truncated: false,
            });
        }
        let handle = self.space(ctx.scope().clone())?;
        let _pin = handle.pin_query();
        let aligned = self.align(&ctx, &request.causal, &handle, clock).await?;
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
            filtered,
        );
        let vectors = self.vector_candidates(VectorRequest {
            ctx: &ctx,
            query: &request,
            clock,
            filter: filter.clone(),
            snapshot: snapshot.clone(),
            state: state.clone(),
            handle: &handle,
            excluded,
            limit: candidate_k,
            browse,
        });
        let (lexical, vectors) = tokio::join!(lexical, vectors);
        let mut notes = lexical?;
        let vectors = vectors?;
        let overlay =
            rank_overlay(self, clock, &request, &aligned.overlay, &filter, filtered).await?;
        if browse {
            notes.extend(overlay);
            notes.sort_by(|left, right| note_key(left).cmp(&note_key(right)));
        } else {
            // Receipt-bound hits lead the lexical stream. BM25 magnitudes from
            // an eight-row overlay and a durable corpus are not comparable.
            let mut fresh = overlay;
            fresh.extend(notes);
            notes = fresh;
        }

        let mut candidates = ranking::fuse(notes, vectors.hits, browse);
        if let Some(recall) = recall.filter(|recall| recall.graph_depth != 0) {
            ranking::expand(
                &mut candidates,
                snapshot.as_ref(),
                &filter,
                &aligned.overlay,
                recall.graph_depth,
                |note| {
                    clock.remaining()?;
                    Ok(self.services.deps.structural.is_live_visible(&ctx, note)?)
                },
            )?;
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
        ctx.budget = clock.remaining()?;
        let (chat_hits, chat_truncated) = if let Some(state) =
            state.filter(|_| recall.is_none() && request.include_chats && !browse)
        {
            self.search_chats(&ctx, clock, &request, snapshot, state, filter)
                .await?
        } else {
            (Vec::new(), false)
        };
        // Chat hydration can yield while canonical access to a selected note changes.
        let (hits, packing_truncated) = self.finish_note_hits(&ctx, clock, hits, recall)?;
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
                    let current = handle
                        .published
                        .load_full()
                        .filter(|current| {
                            current.seq == state.seq
                                && Arc::ptr_eq(&current.lexical, &state.lexical)
                        })
                        .ok_or(EmbeddingError::ModelUnavailable)?;
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
            let requested = self
                .services
                .model_target(
                    ctx.scope(),
                    filter.project.as_ref().map(|p| &p.folder_id),
                    query.model.as_ref(),
                )
                .await?
                .ok_or(EmbeddingError::ModelUnavailable)?;
            if let EmbeddingBackendTarget::Remote {
                project: Some(expected),
                ..
            } = &requested.backend
                && filter.project.as_ref() != Some(expected)
            {
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
                state
                    .active_model
                    .as_ref()
                    .ok_or(EmbeddingError::ModelUnavailable)?
            };
            if matches!(target.backend, EmbeddingBackendTarget::Remote { .. })
                && requested.backend.local_pooling().is_some()
            {
                return Ok(None);
            }
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
        let vectors = blocking_search(clock, "vector_search_worker", move |budget| {
            let visible = |note: &NoteId| {
                snapshot.lookup(note).is_some_and(|node| {
                    filter
                        .node_allowed(snapshot.as_ref(), node)
                        .unwrap_or(false)
                })
            };
            let mask = VectorFilter {
                classes: &filter.classes,
                folders: filter.ordinals.as_deref(),
                notes: filter.vector_notes.as_ref(),
                excluded: Some(&excluded),
            };
            let index = state
                .vectors
                .as_ref()
                .ok_or(crate::vector::VectorError::CorruptIndex)?;
            index.search_visible(&vector, &mask, limit, budget, visible)
        })
        .await?;
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
            Err(_) => Ok(VectorCandidates::degraded(
                SearchDegradation::ModelUnavailable,
            )),
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
    vector_notes: Option<BTreeSet<NoteId>>,
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
        let fields = snapshot
            .filter_notes(&query.filter)
            .await?
            .map(|nodes| {
                nodes
                    .map(|node| node.index(cut.generation))
                    .collect::<Result<Bitmap, _>>()
            })
            .transpose()?;
        let folder_masks = scope_folders.into_iter().flatten().map(|folder| {
            snapshot
                .folder_subtree(folder)?
                .map(|node| node.index(cut.generation))
                .collect::<Result<Bitmap, _>>()
        });
        let mut nodes = fields.clone();
        for mask in folder_masks {
            let mask = mask?;
            if let Some(nodes) = &mut nodes {
                nodes.and_inplace(&mask);
            } else {
                nodes = Some(mask);
            }
        }
        let vector_notes = fields
            .as_ref()
            .map(|nodes| {
                nodes
                    .iter()
                    .map(|index| snapshot.note_id(DenseNodeId::new(cut.generation, index)))
                    .collect::<Result<BTreeSet<_>, _>>()
            })
            .transpose()?;
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
            vector_notes,
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

#[allow(clippy::too_many_arguments)]
async fn lexical_candidates(
    clock: &Clock,
    snapshot: Arc<dyn StructuralSnapshot>,
    state: Option<Arc<Published>>,
    filter: Arc<Eligible>,
    excluded: Arc<BTreeSet<NoteId>>,
    text: String,
    candidate_k: usize,
    filtered: bool,
) -> Result<Vec<LexicalHit>, PortError> {
    let Some(state) = state else {
        return Ok(Vec::new());
    };
    lexical_work(clock, move |budget| {
        let notes_filter = LexicalFilter::new(
            snapshot.as_ref(),
            filter.ordinals.clone(),
            filter.nodes.as_ref(),
            filter.classes.iter().copied(),
            false,
        )
        .excluding(&excluded)
        .within(budget);
        state
            .lexical
            .search_pinned(&state.searcher, &text, &notes_filter, candidate_k, filtered)
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
) -> Result<Vec<LexicalHit>, PortError> {
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
        return Ok(Vec::new());
    }
    let text = query.text.clone();
    let writers = engine.services.writers.clone();
    lexical_work(clock, move |budget| {
        let updates: Vec<_> = notes
            .iter()
            .map(|(title, content, folder)| Update::Note {
                content,
                title,
                folder: *folder,
            })
            .collect();
        LexicalIndex::rank_overlay(&writers, &text, &updates, filtered, budget)
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
