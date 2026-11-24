use crate::{
    engine::{Clock, Published, SearchEngine, SpaceHandle, deadline_error, unavailable},
    ports::SearchOverlayNote,
};
use notarium_core::{
    error::PortError,
    ids::{NoteId, SpaceSeq},
    model::{HistoryScope, SnapshotCut},
    ports::{SpaceContext, StructuralSnapshot},
    receipt::{AwaitWatermarks, CausalBasis, MutationReceiptToken},
};
use std::{collections::BTreeMap, sync::Arc};
use tokio::{
    sync::oneshot,
    time::{Instant, timeout_at},
};

pub(super) type Overlay = BTreeMap<NoteId, Option<SearchOverlayNote>>;

pub(super) struct Aligned {
    pub snapshot: Arc<dyn StructuralSnapshot>,
    pub state: Option<Arc<Published>>,
    pub cut: SnapshotCut,
    pub base_cut: SnapshotCut,
    pub overlay: Overlay,
}

impl SearchEngine {
    pub(super) async fn align(
        &self,
        ctx: &SpaceContext,
        causal: &CausalBasis,
        handle: &SpaceHandle,
        clock: &Clock,
        preflight: bool,
    ) -> Result<Aligned, PortError> {
        let required = match causal {
            CausalBasis::Await(watermarks) => watermarks.required(ctx.scope())?,
            CausalBasis::Exact(receipts) => receipts
                .for_scope(ctx.scope())?
                .into_iter()
                .map(|receipt| receipt.seq())
                .max()
                .unwrap_or_default(),
        };
        // Search owns its receipt overlay. The structural owner returns the
        // projection base before any receipt-specific state is applied here.
        let structural_causal = match causal {
            CausalBasis::Await(_) => causal.clone(),
            CausalBasis::Exact(_) => CausalBasis::Exact(Default::default()),
        };
        let mut snapshot = self
            .projection(ctx, structural_causal, clock, preflight)
            .await?;
        let mut state = current(handle, ctx.scope());
        // Exact queries skip initial grace so receipt overlays run immediately
        // when the published index already matches the structural cut.
        if matches!(causal, CausalBasis::Await(_)) {
            let target = snapshot.cut().projected_seq.max(required);
            if state.as_ref().is_none_or(|state| state.seq < target) {
                handle.wake.notify_one();
                drop(state.take());
                let grace = self
                    .services
                    .config
                    .causal_wait_budget
                    .min(clock.remaining()?.remaining / 2);
                if !grace.is_zero() {
                    state = wait_at_least(handle, ctx.scope(), target, Instant::now() + grace)
                        .await?
                        .or_else(|| current(handle, ctx.scope()));
                }
            }
        }
        let overlay = loop {
            let indexed = state.as_ref().map_or(SpaceSeq::ZERO, |state| state.seq);
            let projected = snapshot.cut().projected_seq;
            if indexed > projected {
                let mut waiting = vec![MutationReceiptToken::new(ctx.scope().clone(), indexed)?];
                if let CausalBasis::Await(watermarks) = causal {
                    for (scope, seq) in watermarks.scopes() {
                        if *seq != SpaceSeq::ZERO {
                            waiting.push(MutationReceiptToken::new(scope.clone(), *seq)?);
                        }
                    }
                }
                let cause = CausalBasis::Await(AwaitWatermarks::from_receipts(waiting));
                // Release the old structural snapshot before awaiting a newer cut.
                drop(snapshot);
                snapshot = self.projection(ctx, cause, clock, preflight).await?;
                if snapshot.cut().projected_seq < indexed {
                    return Err(unavailable("projection_behind_search"));
                }
                continue;
            }
            if indexed == projected {
                if state.is_some() && indexed >= required {
                    break Overlay::new();
                }
                if indexed < required
                    && let CausalBasis::Exact(receipts) = causal
                    && let Some(overlay) =
                        self.receipt_overlay(ctx, clock, indexed, receipts).await?
                {
                    break overlay;
                }
            }
            // A newer projection cannot filter or expand an older index.
            // When catching up to `projected`, register an exact align waiter so
            // catch-up publishes `projected` without ping-ponging under writes.
            drop(state.take());
            if indexed < projected {
                let rx = handle.register_align_waiter(projected);
                if let Some(ready) =
                    current(handle, ctx.scope()).filter(|ready| ready.seq >= projected)
                {
                    state = Some(ready);
                    continue;
                }
                handle.wake.notify_one();
                state = Some(
                    wait_exact(handle, ctx.scope(), projected, rx, clock.deadline)
                        .await?
                        .ok_or_else(deadline_error)?,
                );
            } else {
                handle.wake.notify_one();
                state = Some(
                    wait_at_least(handle, ctx.scope(), required, clock.deadline)
                        .await?
                        .ok_or_else(deadline_error)?,
                );
            }
        };
        let cut = snapshot.cut().clone();
        let mut base_cut = cut.clone();
        base_cut.canonical_seq = cut.projected_seq;
        Ok(Aligned {
            cut,
            snapshot,
            state,
            base_cut,
            overlay,
        })
    }

    async fn receipt_overlay(
        &self,
        ctx: &SpaceContext,
        clock: &Clock,
        base: SpaceSeq,
        receipts: &notarium_core::receipt::ReceiptSet,
    ) -> Result<Option<Overlay>, PortError> {
        let Some(versions) = self
            .services
            .deps
            .canonical
            .plan_search_overlay(
                &self.services.authority,
                &clock.remaining()?,
                ctx.scope(),
                base,
                receipts,
            )
            .await?
        else {
            return Ok(None);
        };
        let targets = versions
            .into_iter()
            .map(|version| (version.note_id, version.revision))
            .collect::<Vec<_>>();
        // Keep the mask for a receipt whose revision left the searchable set.
        let mut overlay: Overlay = targets
            .iter()
            .map(|(note, _)| (note.clone(), None))
            .collect();
        let mut context = ctx.clone();
        context.budget = clock.remaining()?;
        overlay.extend(
            self.services
                .deps
                .carriers
                .read_note_revisions_for_overlay(
                    self.services.authority.clone(),
                    context,
                    base,
                    targets,
                )
                .await?,
        );
        Ok(Some(overlay))
    }

    pub(super) async fn projection(
        &self,
        ctx: &SpaceContext,
        causal: CausalBasis,
        clock: &Clock,
        preflight: bool,
    ) -> Result<Arc<dyn StructuralSnapshot>, PortError> {
        let mut context = ctx.clone();
        context.budget = clock.remaining()?;
        let snapshot = if preflight {
            self.services
                .deps
                .structural
                .acquire_snapshot_preflight(context, causal)
                .await?
        } else {
            self.services
                .deps
                .structural
                .acquire_snapshot(context, causal)
                .await?
        };
        ctx.check_current(&snapshot.cut().scope)?;
        Ok(Arc::from(snapshot))
    }
}

fn current(handle: &SpaceHandle, scope: &HistoryScope) -> Option<Arc<Published>> {
    handle
        .published
        .load_full()
        .filter(|state| &state.scope == scope)
}

async fn wait_exact(
    handle: &SpaceHandle,
    scope: &HistoryScope,
    target: SpaceSeq,
    rx: oneshot::Receiver<Arc<Published>>,
    deadline: Instant,
) -> Result<Option<Arc<Published>>, PortError> {
    let awaited = timeout_at(deadline, async {
        tokio::select! {
            biased;
            () = handle.stop.cancelled() => return Err(unavailable("search_indexer_closed")),
            delivered = rx => {
                if let Ok(state) = delivered
                    && &state.scope == scope
                {
                    return Ok(Some(state));
                }
            }
        }
        if let Some(state) = current(handle, scope).filter(|state| state.seq >= target) {
            return Ok(Some(state));
        }
        wait_at_least_inner(handle, scope, target).await
    })
    .await;
    awaited.unwrap_or(Ok(None))
}

async fn wait_at_least(
    handle: &SpaceHandle,
    scope: &HistoryScope,
    target: SpaceSeq,
    deadline: Instant,
) -> Result<Option<Arc<Published>>, PortError> {
    let awaited = timeout_at(deadline, wait_at_least_inner(handle, scope, target)).await;
    awaited.unwrap_or(Ok(None))
}

async fn wait_at_least_inner(
    handle: &SpaceHandle,
    scope: &HistoryScope,
    target: SpaceSeq,
) -> Result<Option<Arc<Published>>, PortError> {
    let mut wake = handle.epoch.subscribe();
    loop {
        if let Some(state) = current(handle, scope).filter(|state| state.seq >= target) {
            return Ok(Some(state));
        }
        tokio::select! {
            () = handle.stop.cancelled() => return Err(unavailable("search_indexer_closed")),
            result = wake.changed() => result.map_err(|_| unavailable("search_indexer_closed"))?,
        }
    }
}
