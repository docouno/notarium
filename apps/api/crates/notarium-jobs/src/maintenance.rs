use std::future::Future;

use notarium_canonical::codec;
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ports::{Cancellation, MaintenanceContext},
};
use tokio::time::Instant;

use crate::{backup_format::invalid, import::check_cancelled};

struct CancelOnDrop(Cancellation);

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
