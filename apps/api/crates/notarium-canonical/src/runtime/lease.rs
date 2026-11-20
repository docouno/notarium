use super::*;
use crate::{
    backup::{CancelOnDrop, register_cleanup_task},
    domain::purge::RetirementRecovery,
};
use notarium_core::{
    error::{CommitEffect, OperationalFailure, RetryAdvice},
    ports::{Cancellation, MaintenanceContext, ServicePurpose},
};
use tokio::{
    sync::{broadcast, oneshot},
    time::Instant,
};

pub(super) type RecoveryWaiters = broadcast::Sender<Result<(), PortError>>;

struct Attempt {
    started: Instant,
    budget: CallBudget,
    abandoned: Cancellation,
    shutdown: Cancellation,
    committing: AtomicBool,
}

impl Attempt {
    fn remaining(&self) -> Duration {
        self.budget.remaining.saturating_sub(self.started.elapsed())
    }

    fn check(&self) -> Result<(), PortError> {
        if self.budget.cancellation.is_cancelled()
            || self.abandoned.is_cancelled()
            || self.shutdown.is_cancelled()
        {
            return Err(self.interruption(true));
        }
        if self.remaining().is_zero() {
            return Err(self.interruption(false));
        }
        Ok(())
    }

    fn submit(&self) -> Result<(), PortError> {
        self.check()?;
        self.committing.store(true, Ordering::Release);
        Ok(())
    }

    fn interruption(&self, cancelled: bool) -> PortError {
        let effect = if self.committing.load(Ordering::Acquire) {
            CommitEffect::Unknown
        } else {
            CommitEffect::NotCommitted
        };
        let failure = OperationalFailure::new(
            crate::codec::diagnostic_digest("advance_space_lease", "interrupted"),
            effect,
            RetryAdvice::RetrySameCommand,
            true,
        )
        .expect("a retry specifies the same history and epoch");
        if cancelled {
            PortError::Cancelled(failure)
        } else {
            PortError::DeadlineExceeded(failure)
        }
    }

    async fn stopped(&self) -> PortError {
        let cancelled = tokio::select! {
            biased;
            () = self.budget.cancellation.cancelled() => true,
            () = self.abandoned.cancelled() => true,
            () = self.shutdown.cancelled() => true,
            () = tokio::time::sleep(self.remaining()) => false,
        };
        self.interruption(cancelled)
    }
}

impl CanonicalStore {
    /// Fences the prior writer and grants the confirmed epoch to this runtime.
    pub async fn advance_space_lease(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        new_epoch: LeaseEpoch,
    ) -> Result<LeaseEpoch, PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        let attempt = Arc::new(Attempt {
            started: Instant::now(),
            budget: ctx.budget.clone(),
            abandoned: Cancellation::default(),
            shutdown: self.inner.backup_shutdown.clone(),
            committing: AtomicBool::new(false),
        });
        attempt.check()?;
        let _abandon = CancelOnDrop(attempt.abandoned.clone());
        let (reply, result) = oneshot::channel();
        let store = self.clone();
        let scope = scope.clone();
        let task = self.inner.backup_executor.spawn(async move {
            let mut reply = Some(reply);
            let mut turnover = Box::pin(store.update_lease(&scope, new_epoch, attempt.clone()));
            let result = tokio::select! {
                biased;
                result = &mut turnover => result,
                interrupted = attempt.stopped() => {
                    let _ = reply.take().expect("lease caller").send(Err(interrupted));
                    if !attempt.committing.load(Ordering::Acquire) {
                        return;
                    }
                    // The server can commit even though the caller stopped waiting.
                    tokio::select! {
                        result = &mut turnover => result,
                        () = attempt.shutdown.cancelled() => return,
                    }
                }
            };
            drop(turnover);
            match result {
                Ok(true) => store.inner.grant_writer_epoch(&scope.space_id, new_epoch),
                Ok(false) => {} // The same runtime already owns this committed epoch.
                Err(error) => {
                    if let Some(reply) = reply {
                        let _ = reply.send(Err(error));
                    }
                    return;
                }
            }
            let mut recovery = Box::pin(store.lease_recovery(scope, new_epoch));
            if let Some(reply) = reply {
                // A caller whose grant is confirmed can leave while this task
                // continues physical cleanup on the store executor.
                tokio::select! {
                    biased;
                    result = &mut recovery => {
                        let _ = reply.send(result.map(|()| new_epoch));
                        return;
                    }
                    _ = attempt.stopped() => { let _ = reply.send(Ok(new_epoch)); }
                }
            }
            let _ = recovery.await;
        });
        register_cleanup_task(&self.inner, task);
        result
            .await
            .map_err(|e| crate::codec::unknown_commit_outcome("lease_worker", e.to_string()))?
    }

    pub(crate) fn resume_deferred_projection_purges(&self) {
        let store = self.clone();
        let task = self.inner.backup_executor.spawn(async move {
            let mut backoff = Duration::from_millis(50);
            let recover = async {
                loop {
                    let retry = match store.recover_deferred_projection_purges().await {
                        Ok(delay) => delay,
                        Err(error) => {
                            tracing::warn!(?error, "cannot scan pending projection purges");
                            crate::blobs::retirement_worker::retry_after(&error)
                        }
                    };
                    let Some(minimum) = retry else { break };
                    tokio::time::sleep(backoff.max(minimum)).await;
                    backoff = (backoff * 2).min(Duration::from_secs(5));
                }
            };
            tokio::select! {
                () = store.inner.backup_shutdown.cancelled() => {}
                () = recover => {}
            }
        });
        register_cleanup_task(&self.inner, task);
    }

    async fn recover_deferred_projection_purges(&self) -> Result<Option<Duration>, PortError> {
        // Walk the Space primary key even across clean pages. A phase-index lookup
        // per Space avoids traversing its completed purge history on registration.
        const PAGE: &str = concat!(
            "SELECT s.space_id, ",
            include_str!("../domain/purge/has_pending.sql"),
            " FROM spaces s WHERE s.space_id>$1 ORDER BY s.space_id LIMIT 64"
        );
        let mut after = String::new();
        let mut retry = None;
        loop {
            let cursor = after.clone();
            let page: Vec<(String, bool)> = self
                .with_read_tx(move |tx| {
                    Box::pin(async move {
                        match tx {
                            BackendConn::Sqlite(c) => {
                                sqlx::query_as(PAGE).bind(cursor).fetch_all(&mut **c).await
                            }
                            BackendConn::Postgres(c) => {
                                sqlx::query_as(PAGE).bind(cursor).fetch_all(&mut **c).await
                            }
                        }
                        .map_err(|error| pg_read_error("projection_pending_purges", error))
                    })
                })
                .await?;
            if page.is_empty() {
                return Ok(retry);
            }
            for (id, has_purges) in page {
                after = id;
                if !has_purges {
                    continue;
                }
                let result = async {
                    let space = self.read_space(&SpaceId::parse(&after)?).await?;
                    if self
                        .inner
                        .check_writer_epoch(&space.scope.space_id, space.active_epoch)
                        .is_ok()
                    {
                        // A concurrent takeover scan may already be returning "deferred".
                        self.resume_pending_storage_for_space(
                            &space.scope,
                            space.active_epoch,
                            RetirementRecovery::Lease,
                        )
                        .await?;
                    }
                    Ok::<_, PortError>(())
                }
                .await;
                if let Err(error) = result {
                    tracing::warn!(?error, space_id=%after, "projection purge recovery remains pending");
                    if let Some(minimum) = crate::blobs::retirement_worker::retry_after(&error) {
                        retry = Some(retry.unwrap_or_default().max(minimum));
                    }
                }
            }
        }
    }

    async fn lease_recovery(
        &self,
        scope: HistoryScope,
        epoch: LeaseEpoch,
    ) -> Result<(), PortError> {
        use std::collections::hash_map::Entry;
        let key = (scope.clone(), epoch);
        let mut following = {
            let mut active = self.inner.lease_recoveries.lock().expect("lease recovery");
            match active.entry(key.clone()) {
                Entry::Occupied(entry) => Some(entry.get().subscribe()),
                Entry::Vacant(entry) => {
                    entry.insert(broadcast::channel(1).0);
                    None
                }
            }
        };
        if let Some(waiter) = following.as_mut() {
            return waiter.recv().await.map_err(|err| {
                crate::codec::unknown_commit_outcome("lease_recovery_worker", err.to_string())
            })?;
        }
        let result = tokio::select! {
            () = self.inner.backup_shutdown.cancelled() => Ok(()),
            result = self.recover_lease_storage(&scope, epoch) => result,
        };
        let mut active = self.inner.lease_recoveries.lock().expect("lease recovery");
        let waiters = active
            .remove(&key)
            .expect("recovery registered by its owner");
        let _ = waiters.send(result.clone());
        result
    }

    async fn recover_lease_storage(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
    ) -> Result<(), PortError> {
        let mut backoff = Duration::from_millis(50);
        loop {
            let Err(error) = self
                .resume_pending_storage_for_space(scope, epoch, RetirementRecovery::Lease)
                .await
            else {
                return Ok(());
            };
            let Some(minimum) = crate::blobs::retirement_worker::retry_after(&error) else {
                tracing::error!(
                    ?error,
                    "storage recovery stopped after confirmed lease turnover"
                );
                // The epoch committed while the combined transfer/recovery operation failed.
                return Err(crate::codec::unknown_commit_non_idempotent(
                    "lease_recovery_incomplete",
                    format!("{error:?}"),
                ));
            };
            let delay = backoff.max(minimum);
            tracing::warn!(
                ?error,
                ?delay,
                "retrying storage recovery after lease turnover"
            );
            tokio::time::sleep(delay).await;
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
    }

    async fn update_lease(
        &self,
        scope: &HistoryScope,
        new_epoch: LeaseEpoch,
        attempt: Arc<Attempt>,
    ) -> Result<bool, PortError> {
        if let SqlDriverState::Postgres { pool, .. } = &self.inner.sql {
            let _gate = self.inner.writer()?.acquire_commit_read_guard().await;
            let mut visibility = self
                .inner
                .live_visibility
                .for_write(vec![scope.space_id.clone()])
                .await;
            let mut connection = pool.acquire().await.map_err(|e| {
                unavailable_retryable("pg_acquire_lease", e.to_string(), Duration::from_millis(50))
            })?;
            let mut lease = PgTransactionLease::new(&mut connection);
            let timeout_ms = attempt
                .remaining()
                .saturating_add(Duration::from_secs(1))
                .as_millis()
                .min(i32::MAX as u128);
            let begin = format!(
                "BEGIN; SET LOCAL statement_timeout='{timeout_ms}ms'; SET LOCAL client_connection_check_interval='10ms'; SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema(), 7311229))"
            );
            let mut tx = lease
                .conn()
                .begin_with(sqlx::AssertSqlSafe(begin))
                .await
                .map_err(|e| internal_not_committed("pg_begin_lease", e.to_string()))?;
            let changed = self
                .update_lease_rows(
                    &mut BackendConn::Postgres(&mut tx),
                    scope,
                    new_epoch,
                    &attempt,
                )
                .await?;
            if changed {
                visibility.committing();
                tx.commit().await.map_err(|e| {
                    crate::codec::unknown_commit_outcome("pg_commit_lease", e.to_string())
                })?;
            } else {
                tx.rollback().await.map_err(|e| {
                    unavailable_retryable(
                        "pg_end_lease_recheck",
                        e.to_string(),
                        Duration::from_millis(50),
                    )
                })?;
            }
            lease.complete();
            return Ok(changed);
        }
        let scope = scope.clone();
        let space = scope.space_id.clone();
        let store = self.clone();
        self.with_visibility_write_tx(
            Some(space),
            move |tx| {
                Box::pin(async move {
                    store
                        .update_lease_rows(tx, &scope, new_epoch, &attempt)
                        .await
                })
            },
            Ok,
        )
        .await
    }

    async fn update_lease_rows(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
        new_epoch: LeaseEpoch,
        attempt: &Attempt,
    ) -> Result<bool, PortError> {
        let current = load_space_record_for_update_opt(tx, &scope.space_id)
            .await?
            .ok_or(DomainError::ResourceNotFound)?;
        current.scope.check(scope)?;
        if new_epoch == current.active_epoch
            && self
                .inner
                .check_writer_epoch(&scope.space_id, new_epoch)
                .is_ok()
        {
            attempt.check()?;
            return Ok(false);
        }
        if new_epoch <= current.active_epoch {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        self.check_projection_owner_advance(tx, scope).await?;
        let epoch_i64 = new_epoch.get() as i64;
        let affected = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query(
                        "UPDATE spaces SET active_epoch = ? WHERE space_id = ? AND history_incarnation = ?",
                    )
                    .bind(epoch_i64)
                    .bind(scope.space_id.as_str())
                    .bind(scope.incarnation.as_bytes().as_slice())
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_advance_epoch", err.to_string()))?
                    .rows_affected(),
                    BackendConn::Postgres(conn) => sqlx::query(
                        "UPDATE spaces SET active_epoch = $1 WHERE space_id = $2 AND history_incarnation = $3",
                    )
                    .bind(epoch_i64)
                    .bind(scope.space_id.as_str())
                    .bind(scope.incarnation.as_bytes().as_slice())
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_advance_epoch", err.to_string()))?
                    .rows_affected(),
                };
        if affected != 1 {
            return Err(DomainError::ResourceNotFound.into());
        }
        if tx.is_postgres() {
            crate::peers::fence_rooms_on_takeover_tx(tx, scope).await?;
        }
        attempt.submit()?;
        Ok(true)
    }
}
