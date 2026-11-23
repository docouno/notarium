use std::sync::Weak;

use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError, ValidationReason},
    ids::{NoteId, SpaceId},
    model::HistoryScope,
    ports::{
        ClosedRoomReservation, FilenamePin, InterceptedMutation, InterceptedPayload,
        InterceptionResult, LiveCollabInterceptor, PortFuture, RollbackReservation, SpaceContext,
    },
    receipt::CommandIdentity,
};
use tokio::{sync::oneshot, time::Instant};

use crate::{
    hub::{CollabHub, HubInner, lock_slot, operation_error},
    room::{InterceptReply, RoomCommand},
};

const MAX_INTERCEPT_RETRIES: usize = 3;

impl LiveCollabInterceptor for CollabHub {
    fn try_closed_room_reservation(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: &CommandIdentity,
    ) -> Option<ClosedRoomReservation> {
        if self.0.has_live_slot(scope, note) {
            return None;
        }
        self.0
            .store
            .room_fences()
            .try_reserve_if_closed(scope, note, identity.clone())
    }

    fn space_has_live_rooms(&self, space: &SpaceId) -> bool {
        self.0.space_has_live_rooms(space)
    }

    fn intercept(&self, mut request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async move {
            let note = match &request.payload {
                InterceptedPayload::EditNote { note, .. } => note.clone(),
                InterceptedPayload::MoveBoardCard { card, .. } => card.note.clone(),
                InterceptedPayload::ExternalObservation { observation, .. } => {
                    observation.note.clone()
                }
            };
            let scope = request.context.scope().clone();
            let cancellation = request.context.budget.cancellation.clone();
            let deadline = Instant::now()
                .checked_add(request.context.budget.remaining)
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidRange))?;

            for _ in 0..MAX_INTERCEPT_RETRIES {
                request.context.budget.remaining =
                    deadline.saturating_duration_since(Instant::now());
                let slot = self.0.slot(&scope, &note);
                let held = lock_slot(&slot, &request.context.budget).await?;
                let room = held
                    .as_ref()
                    .filter(|room| room.scope() == &scope && !room.stopped().is_cancelled())
                    .cloned();
                if let Some(room) = room {
                    drop(held);
                    let (reply, result) = oneshot::channel();
                    let send = tokio::select! {
                        biased;
                        () = cancellation.cancelled() => {
                            return Err(operation_error(
                                b"collab_intercept_cancelled_before_enqueue",
                                CommitEffect::NotCommitted,
                            ));
                        }
                        send = tokio::time::timeout_at(
                            deadline,
                            room.send(RoomCommand::Intercept {
                                request: Box::new(request),
                                reply,
                                deadline,
                            }),
                        ) => send,
                    };
                    match send {
                        Ok(Ok(())) => {}
                        Ok(Err(tokio::sync::mpsc::error::SendError(RoomCommand::Intercept {
                            request: returned,
                            ..
                        }))) => {
                            // Room closed its mailbox before servicing this mutation.
                            // Wait for it to finish stopping and retry on closed-room path.
                            request = *returned;
                            tokio::select! {
                                biased;
                                () = cancellation.cancelled() => {
                                    return Err(operation_error(
                                        b"collab_intercept_cancelled_waiting_close",
                                        CommitEffect::NotCommitted,
                                    ));
                                }
                                waited = tokio::time::timeout_at(deadline, room.stopped().cancelled()) => {
                                    if waited.is_err() {
                                        return Err(operation_error(
                                            b"collab_intercept_wait_close_timeout",
                                            CommitEffect::NotCommitted,
                                        ));
                                    }
                                }
                            }
                            continue;
                        }
                        Ok(Err(_)) => unreachable!("sent RoomCommand::Intercept"),
                        Err(_) => {
                            return Err(operation_error(
                                b"collab_intercept_not_enqueued",
                                CommitEffect::NotCommitted,
                            ));
                        }
                    }
                    match result.await {
                        Ok(InterceptReply::Result(res)) => return res,
                        Ok(InterceptReply::RoomClosingNotStarted(returned)) => {
                            request = *returned;
                            tokio::select! {
                                biased;
                                () = cancellation.cancelled() => {
                                    return Err(operation_error(
                                        b"collab_intercept_cancelled_waiting_close",
                                        CommitEffect::NotCommitted,
                                    ));
                                }
                                waited = tokio::time::timeout_at(deadline, room.stopped().cancelled()) => {
                                    if waited.is_err() {
                                        return Err(operation_error(
                                            b"collab_intercept_wait_close_timeout",
                                            CommitEffect::NotCommitted,
                                        ));
                                    }
                                }
                            }
                            continue;
                        }
                        Err(_) => {
                            return Err(operation_error(
                                b"collab_intercept_reply_lost",
                                CommitEffect::Unknown,
                            ));
                        }
                    }
                }
                self.0
                    .recover(&request.context.budget, &scope, &note)
                    .await?;
                return match self
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
                };
            }
            Err(operation_error(
                b"collab_intercept_retries_exhausted",
                CommitEffect::NotCommitted,
            ))
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
            // Fast path on local single-process SQLite: if local fences report
            // neither fenced nor active, no active room exists anywhere.
            let local_fast_unpinned = self.0.store.is_local_sqlite()
                && !self
                    .0
                    .store
                    .room_fences()
                    .is_room_fenced(&ctx.scope().space_id, &note)
                && matches!(
                    self.0
                        .store
                        .room_fences()
                        .is_room_active(ctx.scope(), &note)
                        .await,
                    Ok(false)
                );
            if local_fast_unpinned {
                return Ok(FilenamePin::Unpinned);
            }
            // Recover any fenced/unhosted lease owned by this process, then
            // check durable storage so rooms active on another node still pin
            // their filename.
            self.0.recover(&ctx.budget, ctx.scope(), &note).await?;
            if let Some((filename, lease)) = self
                .0
                .store
                .read_active_room_pin_info(Some(&ctx.budget), ctx.scope(), &note)
                .await?
            {
                return Ok(FilenamePin::Pinned {
                    note,
                    filename,
                    lease,
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
    fn try_closed_room_reservation(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: &CommandIdentity,
    ) -> Option<ClosedRoomReservation> {
        self.0
            .upgrade()
            .map(CollabHub)?
            .try_closed_room_reservation(scope, note, identity)
    }

    fn space_has_live_rooms(&self, space: &SpaceId) -> bool {
        self.0
            .upgrade()
            .map(CollabHub)
            .is_some_and(|hub| hub.space_has_live_rooms(space))
    }

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
