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
    model::{LifecycleMask, SnapshotCut},
    ports::{CallBudget, GraphQuery, GraphResult, GraphTier, PageLimit, SpaceContext},
    query::Predicate,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NoteLinkDirection {
    Outgoing,
    Incoming,
}

/// Outgoing authored links include unresolved targets. Incoming links are
/// emitted only when the source and focal target both pass recorded and
/// current admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteLink {
    pub source: NoteId,
    pub ordinal: u32,
    pub raw_target: String,
    pub target: Option<NoteId>,
    pub resolved_tier: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct NoteLinkCursor {
    cut: SnapshotCut,
    note: NoteId,
    direction: NoteLinkDirection,
    position: LinkPosition,
}

#[derive(Clone, Debug)]
pub struct NoteLinkPage {
    pub cut: SnapshotCut,
    pub links: Vec<NoteLink>,
    pub next: Option<NoteLinkCursor>,
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
        let _generation_lease = self
            .admit_generation_read(ctx.scope(), cut.cut.generation)
            .await?;
        query.filter.validate_declared(&cut.fields)?;
        let index = self.open_index(&cut)?;
        let (head, effective, authorized, lens) = {
            let permit = cut.live.try_read()?;
            authorize_graph_entry(&permit, ctx, &cut)?;
            let effective = current_effective(&index, &cut, ctx, &permit)?;
            let authorized = current_bitmap(
                &index,
                &cut,
                ctx,
                &permit,
                structural_universe(&index, permit.space(), ctx.auth())?,
                LifecycleMask::Active,
                true,
            )?;
            let lens = lens_scope(&index, ctx, &permit, &query.tier, &authorized)?;
            (permit.head(), effective, authorized, lens)
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
        let graph = SettledGraph {
            index: &index,
            settlement: durable_clusters.as_ref(),
        };
        let mut plan = plan_graph(
            &graph,
            issued_cut,
            &query.tier,
            &effective,
            &matched,
            lens.as_ref(),
        )?;
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
    /// A page consumed by source authorization may be empty with continuation.
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
        let _generation_lease = self
            .admit_generation_read(ctx.scope(), cut.cut.generation)
            .await?;
        let index = self.open_index(&cut)?;
        let dense = index.dense_id(note).ok_or(DomainError::ResourceNotFound)?;
        let (head, recorded_visible) = {
            let permit = cut.live.try_read()?;
            authorize_graph_entry(&permit, ctx, &cut)?;
            let recorded_visible = structural_universe(&index, permit.space(), ctx.auth())?;
            if !recorded_visible.contains(dense) {
                return Err(DomainError::ResourceNotFound.into());
            }
            authorize_plain_note(&permit, ctx, note)?;
            (permit.head(), recorded_visible)
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
        let rows = cut
            .store
            .link_page_at(
                ctx.scope(),
                cut.cut.projected_seq,
                address,
                after.map(|cursor| &cursor.position),
                limit,
            )
            .await?;
        let next = (rows.len() == usize::from(limit.get()))
            .then(|| rows.last().map(LinkPosition::from))
            .flatten()
            .map(|position| NoteLinkCursor {
                cut: issued_cut.clone(),
                note: note.clone(),
                direction,
                position,
            });

        let permit = cut.live.try_read()?;
        authorize_graph_entry(&permit, ctx, &cut)?;
        authorize_plain_note(&permit, ctx, note)?;
        if permit.head() != head {
            return Err(stale());
        }
        let mut links = Vec::with_capacity(rows.len());
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
            links.push(NoteLink {
                source,
                ordinal: row.link_ord,
                raw_target: row.raw_target,
                resolved_tier: target.as_ref().and(row.resolved_tier),
                target,
            });
        }
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

fn current_effective(
    index: &IndexView,
    cut: &PublishedCut,
    ctx: &SpaceContext,
    permit: &LiveReadPermit,
) -> Result<Bitmap, PortError> {
    let mut effective = graph_settle::active_plain(index)?;
    if permit.head() == cut.cut.projected_seq {
        return Ok(effective);
    }
    if let Some(changes) = permit.note_changes_since(cut.cut.projected_seq) {
        for note in changes {
            if let Some(dense) = index.dense_id(note)
                && effective.contains(dense)
                && !effective_now(permit, ctx, note)?
            {
                effective.remove(dense);
            }
        }
        return Ok(effective);
    }
    let mut live = Bitmap::new();
    for dense in effective.iter() {
        let note = index.note_id(index.dense(dense))?;
        if effective_now(permit, ctx, note)? {
            live.add(dense);
        }
    }
    Ok(live)
}

fn effective_now(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<bool, PortError> {
    Ok(matches!(
        permit.classify(ctx, note, true)?,
        LiveNoteStatus::ActiveVisible(_)
            | LiveNoteStatus::HiddenByAuth {
                is_active_plain: true
            },
    ))
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
    match authorize_plain_note(permit, ctx, note) {
        Ok(()) => Ok(Some(note.clone())),
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
