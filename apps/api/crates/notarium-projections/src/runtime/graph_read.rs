use std::{collections::BTreeMap, future::Future};

use croaring::Bitmap;
use notarium_canonical::{
    LiveNoteStatus, LiveReadPermit,
    codec::{cancelled_not_committed, deadline_not_committed},
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::NoteId,
    model::LifecycleMask,
    ports::{
        CallBudget, ChatBacklink, ChatBacklinkCursor, ChatBacklinkPage, GraphQuery, GraphResult,
        GraphTier, LinkReadPort, NoteLink, NoteLinkCursor, NoteLinkDirection, NoteLinkPage,
        PageLimit, PortFuture, SpaceContext,
    },
    query::Predicate,
    receipt::CausalBasis,
};
use notarium_syntax::unicode::lookup_key;

use crate::{
    derived::{LinkAddress, LinkPosition},
    graph::{SettledGraph, plan_graph},
    index::{IndexView, PostingKey},
    query::{entry_folder, structural_universe},
};

use super::{
    ProjectionEngine, PublishedCut, checkpoint_error, graph_settle,
    read::{authorize_entry, current_bitmap},
};

const MAX_ROWS: usize = 200;

impl LinkReadPort for ProjectionEngine {
    fn note_links(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        direction: NoteLinkDirection,
        after: Option<NoteLinkCursor>,
        limit: PageLimit,
    ) -> PortFuture<'_, NoteLinkPage> {
        Box::pin(async move {
            ProjectionEngine::note_links(self, ctx, &note, direction, after.as_ref(), limit).await
        })
    }

    fn chat_backlinks(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        causal: CausalBasis,
    ) -> PortFuture<'_, Vec<ChatBacklink>> {
        Box::pin(async move {
            Ok(ProjectionEngine::chat_backlinks(self, ctx, &note, causal)
                .await?
                .links)
        })
    }

    fn chat_backlinks_page(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        causal: CausalBasis,
        after: Option<ChatBacklinkCursor>,
        limit: PageLimit,
    ) -> PortFuture<'_, ChatBacklinkPage> {
        Box::pin(async move {
            ProjectionEngine::chat_backlinks_page(self, ctx, &note, causal, after.as_ref(), limit)
                .await
        })
    }
}

impl ProjectionEngine {
    pub(super) async fn run_graph(
        &self,
        ctx: &SpaceContext,
        query: GraphQuery,
    ) -> Result<GraphResult, PortError> {
        query.validate()?;
        match self.graph_at_current_cut(ctx, &query).await {
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale =>
            {
                self.graph_at_current_cut(ctx, &query).await
            }
            result => result,
        }
    }

    async fn graph_at_current_cut(
        &self,
        ctx: &SpaceContext,
        query: &GraphQuery,
    ) -> Result<GraphResult, PortError> {
        let cut = self.published_cut(ctx.scope())?;
        let index = self.open_index_async(&cut).await?;
        let (head, authorized, lens) = {
            let permit = cut.live.try_read()?;
            authorize_graph_entry(&permit, ctx, &cut)?;
            query.filter.validate_declared(&cut.fields)?;
            let universe = structural_universe(&index, permit.space(), ctx.auth())?;
            let (authorized, permit) = current_bitmap(
                &index,
                &cut,
                ctx,
                permit,
                universe,
                LifecycleMask::Active,
                true,
            )
            .await?;
            let lens = lens_scope(&index, ctx, &permit, &query.tier, &authorized)?;
            (permit.head(), authorized, lens)
        };
        let matched = exact_filter(&index, &cut, &query.filter.predicate, &authorized).await?;
        let mut issued_cut = cut.cut.clone();
        issued_cut.canonical_seq = head;
        let durable_clusters = match (index.deferred_clusters(), &query.tier) {
            (Some(seq), GraphTier::Superclusters) => Some(
                graph_settle::load_clusters(
                    &cut.store,
                    &cut.cut.scope,
                    seq,
                    index.node_count(),
                    None,
                )
                .await?,
            ),
            (
                Some(seq),
                GraphTier::Lens {
                    cluster: Some(cluster),
                    ..
                },
            ) => Some(
                graph_settle::load_clusters(
                    &cut.store,
                    &cut.cut.scope,
                    seq,
                    index.node_count(),
                    Some(cluster),
                )
                .await?,
            ),
            _ => None,
        };
        // A two-hop neighborhood can scan a whole component even when its
        // output is capped. Dropping the receiver also stops an abandoned scan.
        let tier = query.tier.clone();
        let (reply, result) = tokio::sync::oneshot::channel();
        tokio::task::spawn_blocking(move || {
            let graph = SettledGraph {
                index: &index,
                settlement: durable_clusters.as_ref(),
            };
            let plan = plan_graph(
                &graph,
                issued_cut,
                &tier,
                &authorized,
                &matched,
                lens.as_ref(),
                || reply.is_closed(),
            );
            let _ = reply.send(plan);
        });
        let mut plan = result.await.map_err(checkpoint_error)??;
        let overlay = BTreeMap::new();
        for page in plan.hydration.chunks(MAX_ROWS) {
            let dense: Vec<_> = page.iter().map(|&(_, dense)| dense).collect();
            let cards = self
                .hydrate_cards_at(ctx, &cut, &dense, &overlay, head)
                .await?;
            if cards.len() != page.len() {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            for (&(position, _), card) in page.iter().zip(cards) {
                plan.result.nodes[position].card = Some(card.ok_or_else(stale)?);
            }
        }
        let permit = cut.live.try_read()?;
        authorize_graph_entry(&permit, ctx, &cut)?;
        if permit.head() != head {
            return Err(stale());
        }
        let _admission = self.current_admission(cut.cut.generation)?;
        Ok(plan.result)
    }

    /// A keyset page of authored links or backlinks on the current graph cut.
    pub async fn note_links(
        &self,
        ctx: SpaceContext,
        note: &NoteId,
        direction: NoteLinkDirection,
        after: Option<&NoteLinkCursor>,
        limit: PageLimit,
    ) -> Result<NoteLinkPage, PortError> {
        within_budget(
            &ctx.budget,
            self.note_links_at_current_cut(&ctx, note, direction, after, limit),
        )
        .await
    }

    async fn note_links_at_current_cut(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        direction: NoteLinkDirection,
        after: Option<&NoteLinkCursor>,
        limit: PageLimit,
    ) -> Result<NoteLinkPage, PortError> {
        let cut = self.published_cut(ctx.scope())?;
        let index = self.open_index_async(&cut).await?;
        // Authorize Space entry BEFORE looking up dense_id so cross-space
        // probing triggers BranchTaint even when the note ID is absent.
        let (head, dense, recorded_visible) = {
            let permit = cut.live.try_read()?;
            authorize_graph_entry(&permit, ctx, &cut)?;
            let dense = index.dense_id(note).ok_or(DomainError::ResourceNotFound)?;
            let recorded_visible = structural_universe(&index, permit.space(), ctx.auth())?;
            if !recorded_visible.contains(dense) {
                return Err(DomainError::ResourceNotFound.into());
            }
            authorize_plain_note(&permit, ctx, note)?;
            (permit.head(), dense, recorded_visible)
        };
        let mut issued_cut = cut.cut.clone();
        issued_cut.canonical_seq = head;
        if after.is_some_and(|cursor| {
            cursor.cut != issued_cut || cursor.note != *note || cursor.direction != direction
        }) {
            return Err(stale());
        }
        let address = match direction {
            NoteLinkDirection::Outgoing => LinkAddress::Source(dense),
            NoteLinkDirection::Incoming => LinkAddress::Target(dense),
        };
        let capacity = usize::from(limit.get());
        let mut cursor_pos = after.map(|c| LinkPosition::from_key(c.src_dense_id, c.link_ord));
        let mut links = Vec::with_capacity(capacity);
        let mut last_returned_key: Option<(u32, u32)> = None;
        let mut more_available = false;

        let _delivery_permit = loop {
            let rows = cut
                .store
                .link_page_at(
                    ctx.scope(),
                    cut.cut.projected_seq,
                    address,
                    cursor_pos.as_ref(),
                    limit,
                )
                .await?;
            let page_exhausted = rows.len() < capacity;
            let last_scanned = rows.last().map(LinkPosition::from);

            let permit = cut.live.try_read()?;
            authorize_graph_entry(&permit, ctx, &cut)?;
            authorize_plain_note(&permit, ctx, note)?;
            if permit.head() != head {
                return Err(stale());
            }
            for row in rows {
                let Some(source) =
                    visible_note_id(&index, &recorded_visible, &permit, ctx, row.src_dense_id)?
                else {
                    continue;
                };
                let target = match row.resolved_dense_id {
                    Some(dense) => visible_note_id(&index, &recorded_visible, &permit, ctx, dense)?,
                    None => None,
                };
                if direction == NoteLinkDirection::Incoming && target.is_none() {
                    continue;
                }
                if links.len() == capacity {
                    more_available = true;
                    break;
                }
                last_returned_key = Some((row.src_dense_id, row.link_ord));
                links.push(NoteLink {
                    source,
                    ordinal: row.link_ord,
                    raw_target: row.raw_target,
                    resolved_tier: target.as_ref().and(row.resolved_tier),
                    target,
                });
            }
            if more_available || page_exhausted {
                break permit;
            }
            cursor_pos = last_scanned;
        };

        let next = if more_available {
            last_returned_key.map(|(src_dense_id, link_ord)| NoteLinkCursor {
                cut: issued_cut.clone(),
                note: note.clone(),
                direction,
                src_dense_id,
                link_ord,
            })
        } else {
            None
        };
        let _admission = self.current_admission(cut.cut.generation)?;
        Ok(NoteLinkPage {
            cut: issued_cut,
            links,
            next,
        })
    }
}

fn authorize_graph_entry(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    cut: &PublishedCut,
) -> Result<(), PortError> {
    let grant = ctx
        .auth()
        .spaces()
        .get(&ctx.scope().space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    authorize_entry(permit, ctx, entry_folder(grant, &cut.root_folder_id, None))
}

fn lens_scope(
    index: &IndexView,
    ctx: &SpaceContext,
    permit: &LiveReadPermit,
    tier: &GraphTier,
    universe: &Bitmap,
) -> Result<Option<Bitmap>, PortError> {
    let GraphTier::Lens { project, tags, .. } = tier else {
        return Ok(None);
    };
    let mut scope = universe.clone();
    if let Some(project) = project {
        let facts = permit
            .folder_facts(project)
            .ok_or(DomainError::ResourceNotFound)?;
        ctx.auth()
            .authorize_folder_read(&facts.space, project, &facts.ancestor_folders)?;
        let dense = index
            .dense_folder_id(project)
            .ok_or(DomainError::ResourceNotFound)?;
        scope.and_inplace(
            &index
                .posting(&PostingKey::FolderSubtree(dense))
                .map_err(checkpoint_error)?,
        );
    }
    for tag in tags {
        scope.and_inplace(
            &index
                .posting(&PostingKey::Tag(lookup_key(tag)))
                .map_err(checkpoint_error)?,
        );
    }
    Ok(Some(scope))
}

fn authorize_plain_note(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<(), PortError> {
    let LiveNoteStatus::ActiveVisible(facts) = permit.classify(ctx, note, true)? else {
        return Err(DomainError::ResourceNotFound.into());
    };
    Ok(ctx.auth().authorize_read(&facts)?)
}

fn visible_note_id(
    index: &IndexView,
    recorded_visible: &Bitmap,
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    dense: u32,
) -> Result<Option<NoteId>, PortError> {
    if !recorded_visible.contains(dense) {
        return Ok(None);
    }
    let note = match index.note_id(index.dense(dense)) {
        Ok(note) => note,
        Err(DomainError::ResourceNotFound) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    match authorize_plain_note(permit, ctx, &note) {
        Ok(()) => Ok(Some(note)),
        Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn exact_filter(
    index: &IndexView,
    cut: &PublishedCut,
    predicate: &Predicate,
    universe: &Bitmap,
) -> Result<Bitmap, PortError> {
    let hits = index
        .filter_candidates(predicate, universe)
        .map_err(checkpoint_error)?;
    let unknown = hits.needs_check();
    let mut resolved = hits.definite;
    let mut pending = unknown.iter().peekable();
    while pending.peek().is_some() {
        let page: Vec<_> = pending.by_ref().take(MAX_ROWS).collect();
        let rows = cut
            .store
            .hydrate(&cut.cut.scope, cut.cut.projected_seq, &page)
            .await?;
        for row in rows {
            let note = row.ok_or_else(stale)?;
            if predicate.matches(&note.evaluated_fields()?) {
                resolved.add(note.dense_id);
            }
        }
    }
    Ok(resolved)
}

async fn within_budget<T>(
    budget: &CallBudget,
    operation: impl Future<Output = Result<T, PortError>>,
) -> Result<T, PortError> {
    if budget.remaining.is_zero() {
        return Err(deadline_not_committed(
            "projection_graph",
            "read deadline exhausted",
        ));
    }
    tokio::select! {
        biased;
        _ = budget.cancellation.cancelled() => Err(cancelled_not_committed("projection_graph", "read cancelled")),
        result = tokio::time::timeout(budget.remaining, operation) => {
            result.map_err(|_| deadline_not_committed("projection_graph", "read deadline exhausted"))?
        }
    }
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}
