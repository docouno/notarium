use std::sync::Weak;

use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError, ValidationReason},
    ids::NoteId,
    ports::{
        FilenamePin, InterceptedMutation, InterceptedPayload, InterceptionResult,
        LiveCollabInterceptor, PortFuture, RollbackReservation, SpaceContext,
    },
    receipt::CommandIdentity,
};
use tokio::{sync::oneshot, time::Instant};

use crate::{
    hub::{CollabHub, HubInner, lock_slot, operation_error},
    room::RoomCommand,
};

impl LiveCollabInterceptor for CollabHub {
    fn intercept(&self, mut request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async move {
            let note = match &request.payload {
                InterceptedPayload::EditNote { note, .. } => note.clone(),
                InterceptedPayload::MoveBoardCard { card, .. } => card.note.clone(),
                InterceptedPayload::ExternalObservation { observation, .. } => {
                    observation.note.clone()
                }
            };
            let start = Instant::now();
            let scope = request.context.scope().clone();
            let slot = self.0.slot(&scope, &note);
            let held = lock_slot(&slot, &request.context.budget).await?;
            let room = held
                .as_ref()
                .filter(|room| room.scope() == &scope && !room.stopped().is_cancelled())
                .cloned();
            if let Some(room) = room {
                drop(held);
                request.context.budget.remaining = request
                    .context
                    .budget
                    .remaining
                    .saturating_sub(start.elapsed());
                let cancellation = request.context.budget.cancellation.clone();
                let deadline = Instant::now()
                    .checked_add(request.context.budget.remaining)
                    .ok_or_else(|| DomainError::validation(ValidationReason::InvalidRange))?;
                let (reply, result) = oneshot::channel();
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(operation_error(b"collab_intercept_cancelled_before_enqueue", CommitEffect::NotCommitted)),
                    send = tokio::time::timeout_at(deadline, room.send(RoomCommand::Intercept { request: Box::new(request), reply, deadline })) => {
                        if !matches!(send, Ok(Ok(()))) {
                            return Err(operation_error(b"collab_intercept_not_enqueued", CommitEffect::NotCommitted));
                        }
                    }
                }
                return result.await.map_err(|_| {
                    operation_error(b"collab_intercept_reply_lost", CommitEffect::Unknown)
                })?;
            }
            self.0
                .recover(&request.context.budget, &scope, &note)
                .await?;
            match self
                .0
                .store
                .room_fences()
                .reserve_rollback(&scope, &note, request.identity)
                .await?
            {
                RollbackReservation::Closed(reservation) => {
                    Ok(InterceptionResult::ClosedRoomReservation(reservation))
                }
                // Another process owns the durable room lease. A local direct
                // write cannot acquire a reservation across that lease.
                RollbackReservation::SkippedRoomActive => Ok(InterceptionResult::Conflict(
                    DomainError::validation(ValidationReason::NotReady),
                )),
            }
        })
    }

    fn reserve_rollback(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        identity: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        Box::pin(async move {
            let slot = self.0.slot(ctx.scope(), &note);
            let held = lock_slot(&slot, &ctx.budget).await?;
            if !held
                .as_ref()
                .is_some_and(|room| room.scope() == ctx.scope() && !room.stopped().is_cancelled())
            {
                self.0.recover(&ctx.budget, ctx.scope(), &note).await?;
            }
            self.0
                .store
                .room_fences()
                .reserve_rollback(ctx.scope(), &note, identity)
                .await
        })
    }

    fn filename_pin(&self, ctx: SpaceContext, note: NoteId) -> PortFuture<'_, FilenamePin> {
        Box::pin(async move {
            let slot = self.0.slot(ctx.scope(), &note);
            let held = lock_slot(&slot, &ctx.budget).await?;
            if let Some(room) = held
                .as_ref()
                .filter(|room| room.scope() == ctx.scope() && !room.stopped().is_cancelled())
            {
                return Ok(FilenamePin::Pinned {
                    note,
                    filename: room.slug(),
                    lease: room.epoch(),
                });
            }
            Ok(FilenamePin::Unpinned)
        })
    }
}

pub(crate) struct WeakInterceptor(pub Weak<HubInner>);

impl WeakInterceptor {
    fn hub(&self) -> Result<CollabHub, PortError> {
        self.0
            .upgrade()
            .map(CollabHub)
            .ok_or_else(|| operation_error(b"collab_hub_unavailable", CommitEffect::NotCommitted))
    }
}

impl LiveCollabInterceptor for WeakInterceptor {
    fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async move { self.hub()?.intercept(request).await })
    }

    fn reserve_rollback(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        identity: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        Box::pin(async move { self.hub()?.reserve_rollback(ctx, note, identity).await })
    }

    fn filename_pin(&self, ctx: SpaceContext, note: NoteId) -> PortFuture<'_, FilenamePin> {
        Box::pin(async move { self.hub()?.filename_pin(ctx, note).await })
    }
}
