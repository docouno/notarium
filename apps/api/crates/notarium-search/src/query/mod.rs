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
            if request.graph_depth > 2 || request.token_budget == 0 {
                return Err(invalid(ValidationReason::InvalidLimit));
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
        let filter = Arc::new(Eligible::new(
            &ctx,
            &request,
            snapshot.as_ref(),
            state.as_deref(),
        )?);
        let top_k = usize::from(request.top_k.get());
        let candidate_k = (top_k * 4).max(100);
        let chat_k = if recall.is_none() && request.include_chats && !browse {
            (top_k * 2).min(200)
        } else {
            0
        };
        let excluded: Arc<BTreeSet<_>> = Arc::new(aligned.overlay.keys().cloned().collect());

        let lexical = lexical_candidates(
            snapshot.clone(),
            state.clone(),
            filter.clone(),
            excluded.clone(),
            request.text.clone(),
            candidate_k,
            chat_k,
            filtered,
        );
        let vectors = self.vector_candidates(VectorRequest {
            ctx: &ctx,
            query: &request,
            clock,
            filter: filter.clone(),
            state: state.clone(),
            handle: &handle,
            excluded,
            limit: candidate_k,
            browse,
        });
        let (lexical, vectors) = tokio::join!(lexical, vectors);
        let (mut notes, chats) = lexical?;
        let mut vectors = vectors?;
        vectors.hits.retain(|hit| {
            snapshot.lookup(&hit.metadata.note).is_some_and(|node| {
                filter
                    .node_allowed(snapshot.as_ref(), node)
                    .unwrap_or(false)
            })
        });
        let overlay = rank_overlay(self, &request, &aligned.overlay, &filter, filtered).await?;
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
            .as_ref()
            .map(Embedder::tokenizer)
            .unwrap_or(&fallback);
        let (hits, notes_truncated) = self
            .hydrate_notes(hydrate::Hydration {
                context: &ctx,
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
        let (chat_hits, chat_truncated) = self.hydrate_chats(&ctx, chats, request.top_k).await?;
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
        let max = clock
            .remaining()?
            .remaining
            .min(self.services.config.query_embedding_budget);
        let (embedder, vector) = match tokio::time::timeout(max, async {
            let target = self
                .services
                .model_target(
                    ctx.scope(),
                    filter.project.as_ref().map(|p| &p.folder_id),
                    query.model.as_ref(),
                )
                .await?
                .ok_or(EmbeddingError::ModelUnavailable)?;
            if let EmbeddingBackendTarget::Remote { project, .. } = &target.backend
                && (ctx.auth().taint().is_tainted()
                    || project
                        .as_ref()
                        .is_some_and(|expected| filter.project.as_ref() != Some(expected)))
            {
                return Err(EmbeddingError::ProviderUnavailable);
            }
            // The indexing side owns native session initialization, so
            // timed-out queries cannot start duplicate blocking loads.
            let embedder = self
                .services
                .embedder(target.clone(), false)
                .await
                .inspect_err(|_| handle.wake.notify_one())?;
            if !state.vectors.as_ref().is_some_and(|vectors| {
                let indexed = vectors.manifest();
                indexed.model_id == target.model && indexed.dimension == target.dimension
            }) {
                handle.wake.notify_one();
                return Ok(None);
            }
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
            Ok::<_, EmbeddingError>(Some((embedder, embedding)))
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
        let Some(vector) = vector else {
            return Ok(VectorCandidates {
                hits: Vec::new(),
                embedder: Some(embedder),
                degraded: pending,
            });
        };
        let budget = clock.remaining()?;
        let deadline = clock.deadline.into_std();
        let vectors = tokio::task::spawn_blocking(move || {
            let filter = VectorFilter {
                classes: &filter.classes,
                folders: filter.ordinals.as_deref(),
                notes: filter.vector_notes.as_ref(),
                excluded: Some(&excluded),
            };
            let search = SearchBudget {
                cancellation: &budget.cancellation,
                deadline,
            };
            let index = state
                .vectors
                .as_ref()
                .ok_or(crate::vector::VectorError::CorruptIndex)?;
            index.search(&vector, &filter, limit, search)
        })
        .await
        .map_err(|_| internal("vector_search_worker"))?;
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
    state: Option<Arc<Published>>,
    handle: &'a crate::engine::SpaceHandle,
    excluded: Arc<BTreeSet<NoteId>>,
    limit: usize,
    browse: bool,
}

#[derive(Default)]
struct VectorCandidates {
    hits: Vec<VectorHit>,
    embedder: Option<Embedder>,
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
    chat_viewer: PrincipalId,
    nodes: Option<Bitmap>,
    vector_notes: Option<BTreeSet<NoteId>>,
}

impl Eligible {
    fn new(
        ctx: &SpaceContext,
        query: &SearchQuery,
        snapshot: &dyn StructuralSnapshot,
        state: Option<&Published>,
    ) -> Result<Self, PortError> {
        let cut = snapshot.cut().clone();
        let grant = ctx
            .auth()
            .spaces()
            .get(&cut.scope.space_id)
            .ok_or(DomainError::ResourceNotFound)?;
        let classes = grant
            .read_classes
            .iter()
            .copied()
            .filter(|class| {
                *class != DocClass::EncryptedNote
                    && (query.classes.is_empty() || query.classes.contains(class))
            })
            .collect();
        let root = grant.project_root.as_ref();
        let mut masks = [query.folder.as_ref(), root]
            .into_iter()
            .flatten()
            .map(|folder| {
                snapshot
                    .folder_descendants(folder)
                    .map(|descendants| descendants.into_iter().collect::<BTreeSet<_>>())
            });
        let mut folders = masks.next().transpose()?;
        if let Some(folders) = &mut folders
            && let Some(restrict) = masks.next().transpose()?
        {
            folders.retain(|folder| restrict.contains(folder));
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
        let project = match root {
            Some(folder) => Some(folder.clone()),
            None => query
                .folder
                .as_ref()
                .map(|folder| snapshot.enclosing_project(folder))
                .transpose()?
                .flatten(),
        }
        .map(|folder_id| FolderRef {
            space_id: cut.scope.space_id.clone(),
            folder_id,
        });
        let fields = snapshot
            .filter_notes(&query.filter)?
            .map(|nodes| {
                nodes
                    .map(|node| node.index(cut.generation))
                    .collect::<Result<Bitmap, _>>()
            })
            .transpose()?;
        let folder_masks = [query.folder.as_ref(), root]
            .into_iter()
            .flatten()
            .map(|folder| {
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
                    .map(|index| {
                        snapshot
                            .note_id(DenseNodeId::new(cut.generation, index))
                            .cloned()
                    })
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
            chat_viewer: ctx.auth().principal().clone(),
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

#[allow(clippy::too_many_arguments)]
async fn lexical_candidates(
    snapshot: Arc<dyn StructuralSnapshot>,
    state: Option<Arc<Published>>,
    filter: Arc<Eligible>,
    excluded: Arc<BTreeSet<NoteId>>,
    text: String,
    candidate_k: usize,
    chat_k: usize,
    filtered: bool,
) -> Result<(Vec<LexicalHit>, Vec<LexicalHit>), PortError> {
    let Some(state) = state else {
        return Ok((Vec::new(), Vec::new()));
    };
    tokio::task::spawn_blocking(move || {
        let notes_filter = LexicalFilter::new(
            snapshot.as_ref(),
            filter.ordinals.clone(),
            filter.nodes.as_ref(),
            filter.classes.iter().copied(),
            false,
        )
        .excluding(&excluded);
        let notes = state
            .lexical
            .search_pinned(&state.searcher, &text, &notes_filter, candidate_k, filtered)
            .map_err(lexical_error)?;
        let chats = if chat_k == 0 {
            Vec::new()
        } else {
            let chat_filter = LexicalFilter::new(
                snapshot.as_ref(),
                filter.chat_folders.clone(),
                None,
                [],
                true,
            )
            .visible_chats_for(&filter.chat_viewer);
            state
                .lexical
                .search_pinned(&state.searcher, &text, &chat_filter, chat_k, filtered)
                .map_err(lexical_error)?
        };
        Ok((notes, chats))
    })
    .await
    .map_err(|_| internal("lexical_search_worker"))?
}

async fn rank_overlay(
    engine: &SearchEngine,
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
    tokio::task::spawn_blocking(move || {
        let updates: Vec<_> = notes
            .iter()
            .map(|(title, content, folder)| Update::Note {
                content,
                title,
                folder: *folder,
            })
            .collect();
        LexicalIndex::rank_overlay(&writers, &text, &updates, filtered).map_err(lexical_error)
    })
    .await
    .map_err(|_| internal("overlay_search_worker"))?
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
