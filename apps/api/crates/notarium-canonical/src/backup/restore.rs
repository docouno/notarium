use super::{
    CancelOnDrop, apply_restore_cursor_tx, load_restored_room_fences, mint_artifact_id, ownership,
    recover_restored_gc, register_cleanup_task, validate_restore_cursor_tx,
};
use crate::{
    CanonicalStore, RoomFenceTable,
    changes::BroadcastSignal,
    codec::{internal_not_committed, unavailable_retryable, unknown_commit_non_idempotent},
    runtime::SqlDriverState,
    sql_exec::{BackendConn, WriteTransaction},
};
use notarium_core::{
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice},
    ids::{ArtifactId, LeaseEpoch},
    model::HistoryScope,
    ports::{CallBudget, Cancellation},
    receipt::ChangeCursor,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI32, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;

struct Attempt {
    started: Instant,
    remaining: Duration,
    cancellation: Cancellation,
    abandoned: Cancellation,
    shutdown: Cancellation,
    committing: AtomicBool,
    pg_pid: AtomicI32,
    generation: ArtifactId,
}

impl Attempt {
    fn remaining(&self) -> Duration {
        self.remaining.saturating_sub(self.started.elapsed())
    }

    fn interruption(&self) -> Option<PortError> {
        let cancelled = self.cancellation.is_cancelled()
            || self.abandoned.is_cancelled()
            || self.shutdown.is_cancelled();
        if !cancelled && !self.remaining().is_zero() {
            return None;
        }
        Some(self.failure(cancelled))
    }

    fn failure(&self, cancelled: bool) -> PortError {
        let effect = if self.committing.load(Ordering::Acquire) {
            CommitEffect::Unknown
        } else {
            CommitEffect::NotCommitted
        };
        let failure = OperationalFailure::new(
            crate::codec::diagnostic_digest("restore_cursors", "interrupted"),
            effect,
            RetryAdvice::Never,
            false,
        )
        .expect("non-idempotent restore cannot be retried blindly");
        if cancelled {
            PortError::Cancelled(failure)
        } else {
            PortError::DeadlineExceeded(failure)
        }
    }

    async fn stopped(&self) -> PortError {
        let cancelled = tokio::select! {
            () = self.cancellation.cancelled() => true,
            () = self.abandoned.cancelled() => true,
            () = self.shutdown.cancelled() => true,
            () = tokio::time::sleep(self.remaining()) => false,
        };
        self.failure(cancelled)
    }
}

pub(super) async fn run(
    store: &CanonicalStore,
    budget: CallBudget,
    restored: Vec<ChangeCursor>,
) -> Result<(), PortError> {
    let attempt = Arc::new(Attempt {
        started: Instant::now(),
        remaining: budget.remaining,
        cancellation: budget.cancellation,
        abandoned: Cancellation::default(),
        shutdown: store.inner.backup_shutdown.clone(),
        committing: AtomicBool::new(false),
        pg_pid: AtomicI32::new(0),
        generation: mint_artifact_id()?,
    });
    let _cancel_on_drop = CancelOnDrop(attempt.abandoned.clone());
    let (reply, result) = tokio::sync::oneshot::channel();
    let worker = store.clone();
    let task = store.inner.backup_executor.spawn(async move {
        let mut rotate = Box::pin(rotate(&worker, &attempt, restored));
        tokio::select! {
            biased;
            result = &mut rotate => {
                let result = result.map_err(|error| match error {
                    PortError::Unavailable(failure) if failure.effect() == CommitEffect::Unknown =>
                        unknown_commit_non_idempotent("restore_commit", "database acknowledgement unavailable"),
                    other => other,
                });
                let _ = reply.send(result);
            }
            interrupted = attempt.stopped() => {
                if attempt.committing.load(Ordering::Acquire) {
                    // Retain the safe point through the real ACK and local grant publication.
                    let _ = reply.send(Err(interrupted));
                    let _ = rotate.await;
                } else {
                    drop(rotate);
                    let pid = attempt.pg_pid.load(Ordering::Acquire);
                    if pid != 0 {
                        let _ = ownership::interrupt_pg_session(&worker, pid, &attempt.generation).await;
                    }
                    let _ = reply.send(Err(interrupted));
                }
            }
        }
    });
    register_cleanup_task(&store.inner, task);
    result
        .await
        .map_err(|err| unknown_commit_non_idempotent("restore_worker", err.to_string()))?
}

async fn rotate(
    store: &CanonicalStore,
    attempt: &Arc<Attempt>,
    restored: Vec<ChangeCursor>,
) -> Result<(), PortError> {
    if let Some(error) = attempt.interruption() {
        return Err(error);
    }
    let _disclosures = match &store.inner.sql {
        SqlDriverState::Sqlite { disclosures, .. } => Some(disclosures.unscoped_mutation().await),
        SqlDriverState::Postgres { .. } => None,
    };
    let _safe_point = store.inner.writer()?.acquire_safe_point().await;
    let Rotation {
        fences,
        epochs,
        retirements,
    } = match &store.inner.sql {
        SqlDriverState::Sqlite { .. } => {
            let cursors = restored.clone();
            let spaces = cursors
                .iter()
                .map(|cur| cur.scope.space_id.clone())
                .collect();
            let attempt = Arc::clone(attempt);
            let owner = store.clone();
            store
                .with_write_tx_unfenced(
                    Some(spaces),
                    move |tx| {
                        Box::pin(async move { rotate_rows(&owner, tx, &cursors, &attempt).await })
                    },
                    Ok,
                )
                .await?
        }
        SqlDriverState::Postgres { pool, .. } => {
            let mut visibility = store
                .inner
                .live_visibility
                .for_write(
                    restored
                        .iter()
                        .map(|cur| cur.scope.space_id.clone())
                        .collect(),
                )
                .await;
            let mut connection = pool.acquire().await.map_err(|err| {
                unavailable_retryable(
                    "pg_acquire_restore",
                    err.to_string(),
                    Duration::from_millis(50),
                )
            })?;
            // This lease receives a generation tag and a private server deadline.
            // The pool must never reuse it after an interrupted BEGIN or SQL call.
            connection.close_on_drop();
            let remaining = attempt.remaining();
            let timeout_ms = remaining
                .saturating_add(Duration::from_secs(1))
                .as_millis()
                .min(i32::MAX as u128);
            let pid = sqlx::query_scalar("SELECT pg_backend_pid(), set_config('application_name', $1, false), set_config('statement_timeout', $2, false)")
                .bind(attempt.generation.as_str()).bind(format!("{timeout_ms}ms")).fetch_one(&mut *connection).await
                .map_err(|err| internal_not_committed("pg_restore_session", err.to_string()))?;
            attempt.pg_pid.store(pid, Ordering::Release);
            let mut conn = BackendConn::Postgres(&mut connection);
            let mut tx = WriteTransaction::begin(&mut conn).await?;
            let plan = rotate_rows(store, &mut tx.conn(), &restored, attempt).await?;
            visibility.committing();
            tx.commit().await?;
            plan
        }
    };
    // Clear per-Space in-memory caches, clamp watermarks, re-seed collab fences, and notify subscribers.
    let spaces = restored.iter().map(|cur| &cur.scope.space_id).collect();
    store
        .inner
        .room_fences
        .replace_restored_spaces(&spaces, fences);
    for (cur, epoch) in restored.iter().zip(epochs) {
        store.inner.grant_writer_epoch(&cur.scope.space_id, epoch);
        store.inner.job_reads.remove_space(&cur.scope.space_id);
        store
            .inner
            .broadcast_hub
            .rebind_and_clamp_watermarks(&cur.scope, cur.after);
        store
            .inner
            .broadcast_hub
            .publish(BroadcastSignal::IncarnationChanged {
                new_scope: cur.scope.clone(),
                ceiling: cur.after,
            });
    }
    // The cutover has committed. A failed CAS unlink must not report a
    // failed rotation, and cancelling the caller must not abandon GC.
    if !retirements.is_empty() {
        let shutdown = store.inner.backup_shutdown.clone();
        let worker = store.clone();
        register_cleanup_task(
            &store.inner,
            store.inner.backup_executor.spawn(async move {
                tokio::select! {
                    () = shutdown.cancelled() => {}
                    () = recover_restored_gc(worker, retirements) => {}
                }
            }),
        );
    }

    Ok(())
}

struct Rotation {
    fences: RoomFenceTable,
    epochs: Vec<LeaseEpoch>,
    retirements: Vec<(HistoryScope, LeaseEpoch)>,
}

async fn rotate_rows(
    store: &CanonicalStore,
    tx: &mut BackendConn<'_>,
    restored: &[ChangeCursor],
    attempt: &Attempt,
) -> Result<Rotation, PortError> {
    let mut epochs = Vec::with_capacity(restored.len());
    for cur in restored {
        epochs.push(validate_restore_cursor_tx(tx, cur).await?);
    }
    let fences = RoomFenceTable::default();
    let mut retirements = Vec::new();
    for (cur, epoch) in restored.iter().zip(epochs.iter().copied()) {
        store
            .bind_projection_owner_restore(tx, &cur.scope, epoch)
            .await?;
        if apply_restore_cursor_tx(tx, cur, epoch).await? {
            retirements.push((cur.scope.clone(), epoch));
        }
        crate::peers::fence_rooms_on_takeover_tx(tx, &cur.scope).await?;
        load_restored_room_fences(tx, &cur.scope, &fences).await?;
    }
    // Last check before the transaction owner submits COMMIT, without an intervening await.
    if let Some(error) = attempt.interruption() {
        return Err(error);
    }
    attempt.committing.store(true, Ordering::Release);
    Ok(Rotation {
        fences,
        epochs,
        retirements,
    })
}
