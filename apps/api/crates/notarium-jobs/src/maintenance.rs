use std::future::Future;

use notarium_canonical::codec;
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ports::{Cancellation, MaintenanceContext},
};
use tokio::{sync::Semaphore, time::Instant};

use crate::{backup_format::invalid, import::check_cancelled};

struct CancelOnDrop(Cancellation);

// A caller-provided Read can stay inside blocking I/O after cancellation.
// The worker retains its slot until that call actually returns.
static SOURCE_WORKERS: Semaphore = Semaphore::const_new(2);

pub(crate) async fn read_source<T: Send + 'static>(
    cancellation: &Cancellation,
    work: impl FnOnce() -> Result<T, PortError> + Send + 'static,
) -> Result<T, PortError> {
    let permit = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(source_cancelled()),
        permit = SOURCE_WORKERS.acquire() => permit.expect("source worker limit is never closed"),
    };
    let worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    });
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(source_cancelled()),
        result = worker => result.map_err(|err| {
            codec::internal_not_committed("read_archive_source", err.to_string())
        })?,
    }
}

fn source_cancelled() -> PortError {
    codec::cancelled_not_committed("read_archive_source", "archive source read cancelled")
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// One wall-clock deadline for verification, materialization and publication.
/// On a signalled cancellation, let bounded work observe it and drain before
/// returning. An abandoned outer future still revokes the child operation.
pub(crate) async fn bounded<T, F: Future<Output = Result<T, PortError>>>(
    mut ctx: MaintenanceContext,
    operation: &'static str,
    work: impl FnOnce(MaintenanceContext) -> F,
) -> Result<T, PortError> {
    check_cancelled(&ctx.budget.cancellation)?;
    if ctx.budget.remaining.is_zero() {
        return Err(codec::deadline_not_committed(
            operation,
            "maintenance deadline exceeded",
        ));
    }
    let deadline = Instant::now()
        .checked_add(ctx.budget.remaining)
        .ok_or_else(|| invalid(ValidationReason::InvalidRange))?;
    let cancellation = Cancellation::default();
    let external = std::mem::replace(&mut ctx.budget.cancellation, cancellation.clone());
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let work = work(ctx);
    tokio::pin!(work);
    tokio::select! {
        biased;
        result = &mut work => result,
        () = external.cancelled() => {
            cancellation.cancel();
            work.await.map_err(|error| match error {
                PortError::Cancelled(failure) if failure.effect() == CommitEffect::NotCommitted =>
                    codec::cancelled_not_committed(operation, "maintenance cancelled"),
                other => other,
            })
        }
        () = tokio::time::sleep_until(deadline) => {
            cancellation.cancel();
            work.await.map_err(|error| match error {
                PortError::Cancelled(failure) if failure.effect() == CommitEffect::NotCommitted =>
                    codec::deadline_not_committed(operation, "maintenance deadline exceeded"),
                other => other,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn caller_can_cancel_before_a_blocking_source_returns() {
        let cancelled = Cancellation::default();
        let worker_cancel = cancelled.clone();
        let (started, observed) = tokio::sync::oneshot::channel();
        let (release, gate) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(async move {
            read_source(&worker_cancel, move || {
                started.send(()).unwrap();
                let _ = gate.recv();
                Ok(())
            })
            .await
        });
        observed.await.unwrap();
        cancelled.cancel();
        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
                .await
                .expect("caller stopped waiting")
                .unwrap(),
            Err(PortError::Cancelled(failure)) if failure.effect() == CommitEffect::NotCommitted
        ));
        release.send(()).unwrap();
    }
}
