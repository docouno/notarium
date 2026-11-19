use std::{
    collections::BTreeMap,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

use notarium_canonical::{
    CanonicalStore, LiveReadPermit, ProjectionChatEntryKey, ProjectionChatRef,
    ProjectionChatRefLocator, ProjectionOwnerIdentity,
    codec::{cancelled_not_committed, deadline_not_committed, internal_not_committed},
};
use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    error::{PortError, ValidationReason},
    ids::{ChatThreadId, NoteId, ProjectionGeneration, SpaceId, SpaceSeq, ThreadEntrySeq},
    model::{HistoryScope, NoteRef, SnapshotCut},
    ports::{
        CallBudget, ChatBacklink, ChatBacklinkCursor, ChatBacklinkPage, ChatThreadKind,
        MaintenanceContext, PageLimit, SpaceContext,
    },
    receipt::CausalBasis,
};

use crate::derived::ProjectedChatRef;

use super::{ProjectionEngine, PublishedCut, events::authorize_entry};

/// Resolves a canonical owner to a local endpoint supplied by trusted composition.
pub trait BacklinkOwnerResolver: Send + Sync {
    fn resolve(&self, owner: &ProjectionOwnerIdentity) -> Option<BacklinkOwnerEndpoint>;
}

/// A local endpoint backed by an actual canonical owner's admission gate.
#[derive(Clone)]
pub struct BacklinkOwnerEndpoint {
    canonical: CanonicalStore,
    projector: Weak<ProjectionEngine>,
}

enum BacklinkOwner {
    Local,
    Peer {
        endpoint: BacklinkOwnerEndpoint,
        identity: ProjectionOwnerIdentity,
    },
}

struct BacklinkOwnerRead {
    canonical: CanonicalStore,
    permit: LiveReadPermit,
}

impl BacklinkOwner {
    fn admit(
        &self,
        local: &ProjectionEngine,
        scope: &HistoryScope,
    ) -> Result<BacklinkOwnerRead, PortError> {
        let canonical = match self {
            Self::Local => local.canonical(),
            Self::Peer { endpoint, .. } => &endpoint.canonical,
        };
        let permit = canonical.live_visibility_fence().space(scope)?.try_read()?;
        if let Self::Peer { identity, .. } = self {
            let actual = permit.owner_witness();
            if identity.scope() != actual.scope()
                || identity.epoch() != actual.epoch()
                || identity.process() != actual.process()
            {
                return Err(owner_unavailable());
            }
        }
        Ok(BacklinkOwnerRead {
            canonical: canonical.clone(),
            permit,
        })
    }

    async fn wait_for_projected(
        &self,
        local: &ProjectionEngine,
        scope: &HistoryScope,
        seq: SpaceSeq,
        budget: &CallBudget,
    ) -> Result<SnapshotCut, PortError> {
        match self {
            Self::Local => local.wait_for_projected(scope, seq, budget).await,
            Self::Peer { endpoint, .. } => {
                let engine = endpoint.projector.upgrade().ok_or_else(owner_unavailable)?;
                engine.wait_for_projected(scope, seq, budget).await
            }
        }
    }
}

struct VerifiedBacklinks {
    visible: Vec<(ProjectedChatRef, ChatBacklink)>,
    _permits: BTreeMap<SpaceId, BacklinkOwnerRead>,
}

impl ProjectionEngine {
    /// Exposes this runtime's canonical owner gate and causal projection waiter.
    pub fn backlink_owner_endpoint(self: &Arc<Self>) -> BacklinkOwnerEndpoint {
        BacklinkOwnerEndpoint {
            canonical: self.canonical().clone(),
            projector: Arc::downgrade(self),
        }
    }

    /// Installs local peer routing for backlink reads.
    pub fn set_backlink_owner_resolver(
        &self,
        resolver: Arc<dyn BacklinkOwnerResolver>,
    ) -> Result<(), PortError> {
        self.backlink_owners
            .set(resolver)
            .map_err(|_| DomainError::validation(ValidationReason::InvalidState).into())
    }

    async fn backlink_owner(
        &self,
        projection: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<BacklinkOwner, PortError> {
        match self.live_handle(scope) {
            Ok(_) => return Ok(BacklinkOwner::Local),
            Err(error) if error == owner_unavailable() => (),
            Err(error) => return Err(error),
        }
        let resolver = self.backlink_owners.get().ok_or_else(owner_unavailable)?;
        let identity = self
            .canonical()
            .projection_read_owner_identity(projection, scope)
            .await?
            .ok_or_else(owner_unavailable)?;
        let endpoint = resolver.resolve(&identity).ok_or_else(owner_unavailable)?;
        Ok(BacklinkOwner::Peer { endpoint, identity })
    }

    pub async fn chat_backlinks(
        &self,
        ctx: SpaceContext,
        note: &NoteId,
        causal: CausalBasis,
    ) -> Result<ChatBacklinkPage, PortError> {
        self.chat_backlinks_page(
            ctx,
            note,
            causal,
            None,
            PageLimit::new(50).expect("fixed page limit"),
        )
        .await
    }

    pub async fn chat_backlinks_page(
        &self,
        ctx: SpaceContext,
        note: &NoteId,
        causal: CausalBasis,
        after: Option<&ChatBacklinkCursor>,
        limit: PageLimit,
    ) -> Result<ChatBacklinkPage, PortError> {
        let started = Instant::now();
        let scope = ctx.scope();
        {
            let permit = self.live_handle(scope)?.try_read()?;
            authorize_entry(&ctx, &permit)?;
            super::read::ensure_active(&permit, &ctx, note)?;
        }

        let target_cut = tokio::select! {
            biased;
            _ = ctx.budget.cancellation.cancelled() => {
                Err(cancelled_not_committed("chat_backlinks", "caller cancelled"))
            }
            result = tokio::time::timeout(
                ctx.budget.remaining.saturating_sub(started.elapsed()),
                self.chat_backlink_cut(&ctx, &causal, started),
            ) => {
                result.map_err(|_| deadline_not_committed("chat_backlinks", "causal cut unavailable"))?
            }
        }?;
        let generation = target_cut.cut.generation;
        if after.is_some_and(|cursor| {
            cursor.scope != *scope || cursor.generation != generation || &cursor.note != note
        }) {
            return Err(DomainError::validation(ValidationReason::CursorStale).into());
        }
        // Hide raw pagination state, including pages containing only private
        // threads. No source permit is held while scanning derived pages.
        let remaining = ctx
            .budget
            .remaining
            .saturating_sub(started.elapsed())
            .min(Duration::from_millis(240));
        tokio::select! {
            biased;
            _ = ctx.budget.cancellation.cancelled() => {
                Err(cancelled_not_committed("chat_backlinks", "caller cancelled"))
            }
            result = tokio::time::timeout(remaining, async {
                let verified = self.visible_backlinks(&ctx, note, &target_cut, after, limit).await?;
                let _admission = after.is_none().then(|| self.current_admission(generation)).transpose()?;
                Ok(visible_page(scope, generation, note, usize::from(limit.get()), verified))
            }) => {
                result.map_err(|_| deadline_not_committed("chat_backlinks", "source authority verification exceeded deadline"))?
            }
        }
    }

    async fn visible_backlinks(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        cut: &PublishedCut,
        after: Option<&ChatBacklinkCursor>,
        limit: PageLimit,
    ) -> Result<VerifiedBacklinks, PortError> {
        let capacity = usize::from(limit.get());
        let mut position = after.map(|cursor| cursor.after.clone());
        let mut pending = Vec::with_capacity(capacity);
        loop {
            let after = position
                .as_ref()
                .map(|(space, thread, entry)| (space, thread, *entry));
            let candidates = cut
                .store
                .chat_ref_page(ctx.scope(), note, after, limit)
                .await?;
            let complete = candidates.len() < capacity;
            let verified = self.verify_chat_backlinks(ctx, note, &candidates).await?;
            if pending.is_empty() && (complete || verified.visible.len() == capacity) {
                return Ok(verified);
            }
            let room = capacity - pending.len();
            let VerifiedBacklinks { visible, _permits } = verified;
            let truncated = visible.len() > room;
            let mut last_consumed = None;
            for (candidate, _) in visible.into_iter().take(room) {
                last_consumed = Some(backlink_position(&candidate));
                pending.push(candidate);
            }
            drop(_permits);
            let exhausted = complete && !truncated;
            if exhausted || pending.len() == capacity {
                // Earlier pages released their permits. Verify the full
                // result under current owners again before returning it.
                let reverified = self.verify_chat_backlinks(ctx, note, &pending).await?;
                if exhausted || reverified.visible.len() == capacity {
                    return Ok(reverified);
                }
                // Concurrent redaction or revocation shrank the batch; keep
                // surviving entries and continue scanning instead of truncating.
                pending = reverified
                    .visible
                    .into_iter()
                    .map(|(candidate, _)| candidate)
                    .collect();
            }
            position = if truncated {
                last_consumed
            } else {
                candidates.last().map(backlink_position)
            };
        }
    }

    async fn chat_backlink_cut(
        &self,
        ctx: &SpaceContext,
        causal: &CausalBasis,
        started: Instant,
    ) -> Result<Arc<PublishedCut>, PortError> {
        let target = ctx.scope();
        let mut watermarks = BTreeMap::from([(target.clone(), SpaceSeq::ZERO)]);
        let mut add = |scope: &HistoryScope, required: SpaceSeq| -> Result<(), PortError> {
            if scope.space_id == target.space_id {
                target.check(scope)?;
            }
            if ctx.auth().spaces().contains_key(&scope.space_id) {
                let slot = watermarks.entry(scope.clone()).or_insert(SpaceSeq::ZERO);
                *slot = (*slot).max(required);
            }
            Ok(())
        };
        match causal {
            CausalBasis::Exact(tokens) => {
                for token in tokens.tokens() {
                    add(token.scope(), token.seq())?;
                }
            }
            CausalBasis::Await(awaiting) => {
                for (scope, seq) in awaiting.scopes() {
                    add(scope, *seq)?;
                }
            }
        }
        let required = watermarks.remove(target).unwrap_or(SpaceSeq::ZERO);
        {
            let permit = self.live_handle(target)?.try_read()?;
            check_causal_head(&permit, required)?;
        }
        let remaining = ctx.budget.remaining.saturating_sub(started.elapsed());
        let target_cut = self
            .wait_for_cut(target, required, &ctx.budget, remaining)
            .await?;
        for (scope, seq) in watermarks {
            let mut projection = self.projection_context_for(ctx);
            projection.budget.remaining = ctx.budget.remaining.saturating_sub(started.elapsed());
            let owner = self.backlink_owner(&projection, &scope).await?;
            {
                let read = owner.admit(self, &scope)?;
                check_causal_head(&read.permit, seq)?;
            }
            // A shared generation may already contain the required source cut,
            // including when the peer projector is stopped.
            if target_cut
                .store
                .watermarks(&scope.space_id)
                .await?
                .is_some_and(|row| {
                    row.scope == scope && !row.seed_in_progress && row.projected_seq >= seq
                })
            {
                continue;
            }
            projection.budget.remaining = ctx.budget.remaining.saturating_sub(started.elapsed());
            let source = owner
                .wait_for_projected(self, &scope, seq, &projection.budget)
                .await?;
            if source.generation != target_cut.cut.generation {
                return Err(owner_unavailable());
            }
        }
        Ok(target_cut)
    }

    async fn verify_chat_backlinks(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        candidates: &[ProjectedChatRef],
    ) -> Result<VerifiedBacklinks, PortError> {
        let scope = ctx.scope();
        let mut scopes = BTreeMap::from([(scope.space_id.clone(), Some(scope.clone()))]);
        for row in candidates {
            if scopes.contains_key(&row.thread_space_id)
                || !ctx.auth().spaces().contains_key(&row.thread_space_id)
            {
                continue;
            }
            let current = match self.canonical().read_space(&row.thread_space_id).await {
                Ok(record) if record.space.lifecycle == SpaceLifecycle::Active => {
                    Some(record.scope)
                }
                Ok(_) | Err(PortError::Domain(DomainError::ResourceNotFound)) => None,
                Err(error) => return Err(error),
            };
            scopes.insert(row.thread_space_id.clone(), current);
        }

        let projection = self.projection_context_for(ctx);
        let mut routes = BTreeMap::new();
        for (id, current) in scopes {
            if let Some(current) = current {
                if id == scope.space_id {
                    routes.insert(id, (current, BacklinkOwner::Local));
                } else if candidates.iter().any(|row| {
                    row.thread_space_id == id && row.source_incarnation == current.incarnation
                }) {
                    let owner = self.backlink_owner(&projection, &current).await?;
                    routes.insert(id, (current, owner));
                }
            }
        }

        // Resolve routes before taking any gates. Acquire actual owner permits
        // in SpaceId order and retain them through construction of the result.
        let mut permits = BTreeMap::new();
        for (id, (current, owner)) in routes {
            permits.insert(id, owner.admit(self, &current)?);
        }
        let target = &permits
            .get(&scope.space_id)
            .ok_or(DomainError::ResourceNotFound)?
            .permit;
        authorize_entry(ctx, target)?;
        super::read::ensure_active(target, ctx, note)?;

        let mut heads = BTreeMap::new();
        let mut links = Vec::with_capacity(candidates.len());
        for row in candidates {
            let Some(source) = permits.get(&row.thread_space_id) else {
                continue;
            };
            if source.permit.scope().incarnation != row.source_incarnation
                || row.target_incarnation != scope.incarnation
            {
                continue;
            }
            let head_key = (row.thread_space_id.clone(), row.thread_id.clone());
            let cached = match heads.entry(head_key) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    let head = source
                        .canonical
                        .read_projection_chat_head(
                            &projection,
                            source.permit.scope(),
                            Some(source.permit.head()),
                            &row.thread_id,
                        )
                        .await?;
                    let visible = head.filter(|head| {
                        let thread = &head.thread;
                        !(thread.kind == ChatThreadKind::Personal
                            && &thread.owner != ctx.auth().principal())
                            && ctx
                                .auth()
                                .authorize_chat_read(
                                    source.permit.space(),
                                    thread.project_folder.as_ref(),
                                    thread.tainted,
                                )
                                .is_ok()
                    });
                    entry.insert(visible)
                }
            };
            let Some(head) = cached else {
                continue;
            };
            let occurrence = ProjectionChatRef {
                locator: ProjectionChatRefLocator {
                    source: source.permit.scope().clone(),
                    entry: ProjectionChatEntryKey {
                        thread: row.thread_id.clone(),
                        seq: row.entry_seq,
                    },
                    revision: row.source_revision.clone(),
                    ref_ordinal: u32::try_from(row.ref_ordinal).map_err(|_| {
                        internal_not_committed(
                            "chat_backlinks",
                            "invalid derived reference ordinal",
                        )
                    })?,
                },
                target: NoteRef {
                    space_id: scope.space_id.clone(),
                    note_id: note.clone(),
                },
                target_scope: scope.clone(),
            };
            if source
                .canonical
                .verify_projection_chat_ref(&projection, &occurrence)
                .await?
            {
                links.push((
                    row.clone(),
                    ChatBacklink {
                        thread: head.thread.clone(),
                        title: head.title.clone(),
                        entry: row.entry_seq,
                    },
                ));
            }
        }
        Ok(VerifiedBacklinks {
            visible: links,
            _permits: permits,
        })
    }
}

fn owner_unavailable() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}

fn check_causal_head(permit: &LiveReadPermit, required: SpaceSeq) -> Result<(), PortError> {
    if required > permit.head() {
        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
    }
    Ok(())
}

fn backlink_position(row: &ProjectedChatRef) -> (SpaceId, ChatThreadId, ThreadEntrySeq) {
    (
        row.thread_space_id.clone(),
        row.thread_id.clone(),
        row.entry_seq,
    )
}

fn visible_page(
    scope: &HistoryScope,
    generation: ProjectionGeneration,
    note: &NoteId,
    capacity: usize,
    verified: VerifiedBacklinks,
) -> ChatBacklinkPage {
    let VerifiedBacklinks { visible, _permits } = verified;
    let next = visible
        .last()
        .filter(|_| visible.len() == capacity)
        .map(|(row, _)| ChatBacklinkCursor {
            scope: scope.clone(),
            generation,
            note: note.clone(),
            after: backlink_position(row),
        });
    ChatBacklinkPage {
        links: visible.into_iter().map(|(_, link)| link).collect(),
        next,
    }
}
