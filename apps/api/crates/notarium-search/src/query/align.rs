use crate::{
    engine::{Clock, Published, SearchEngine, SpaceHandle, deadline_error, unavailable},
    ports::SearchOverlayNote,
};
use notarium_canonical::codec::EFFECT_PAYLOAD_BUDGET_BYTES;
use notarium_core::{
    error::PortError,
    ids::{NoteId, SpaceSeq},
    model::{HistoryScope, SnapshotCut},
    ports::{SpaceContext, StructuralSnapshot},
    receipt::{AwaitWatermarks, CausalBasis, MutationReceiptToken, OverlayDecision, plan_overlay},
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::time::{Instant, timeout_at};

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
        let mut snapshot = self.projection(ctx, structural_causal, clock).await?;
        let mut state = current(handle, ctx.scope());
        let target = snapshot.cut().projected_seq.max(required);
        if state.as_ref().is_none_or(|state| state.seq < target) {
            handle.wake.notify_one();
            drop(state.take());
            let grace = self
                .services
                .config
                .causal_wait_budget
                .min(Duration::from_millis(15))
                .min(clock.remaining()?.remaining / 2);
            state = wait(handle, ctx.scope(), target, Instant::now() + grace)
                .await?
                .or_else(|| current(handle, ctx.scope()));
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
                snapshot = self.projection(ctx, cause, clock).await?;
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
            // Hold its cut while the subscriber catches up, then compare again.
            let target = if indexed < projected {
                projected
            } else {
                required
            };
            drop(state.take());
            handle.wake.notify_one();
            state = Some(
                wait(handle, ctx.scope(), target, clock.deadline)
                    .await?
                    .ok_or_else(deadline_error)?,
            );
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
        let effects = self
            .services
            .deps
            .canonical
            .resolve_receipt_effects(ctx.scope(), receipts)
            .await?;
        let OverlayDecision::Bounded { versions } = plan_overlay(
            ctx.scope(),
            base,
            receipts,
            &effects,
            EFFECT_PAYLOAD_BUDGET_BYTES,
        )?
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
                .read_note_revisions_for_overlay(self.services.authority.clone(), context, targets)
                .await?,
        );
        Ok(Some(overlay))
    }

    pub(super) async fn projection(
        &self,
        ctx: &SpaceContext,
        causal: CausalBasis,
        clock: &Clock,
    ) -> Result<Arc<dyn StructuralSnapshot>, PortError> {
        let mut context = ctx.clone();
        context.budget = clock.remaining()?;
        let snapshot = self
            .services
            .deps
            .structural
            .acquire_snapshot(context, causal)
            .await?;
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

async fn wait(
    handle: &SpaceHandle,
    scope: &HistoryScope,
    target: SpaceSeq,
    deadline: Instant,
) -> Result<Option<Arc<Published>>, PortError> {
    let mut wake = handle.epoch.subscribe();
    let awaited = timeout_at(deadline, async {
        loop {
            if let Some(state) = current(handle, scope).filter(|state| state.seq >= target) {
                return Ok(Some(state));
            }
            tokio::select! {
                () = handle.stop.cancelled() => return Err(unavailable("search_indexer_closed")),
                result = wake.changed() => result.map_err(|_| unavailable("search_indexer_closed"))?,
            }
        }
    }).await;
    awaited.unwrap_or(Ok(None))
}
