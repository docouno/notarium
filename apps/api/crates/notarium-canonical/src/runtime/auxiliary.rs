use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use notarium_core::{error::PortError, ports::CallBudget};
use tokio::task::JoinHandle;

use crate::{
    CanonicalStore,
    codec::{cancelled_not_committed, internal_not_committed, unknown_commit_non_idempotent},
    domain::common::CommandDeadline,
    sql_exec::BackendConn,
};

// Caller cancellation and COMMIT contend for one permission. Once COMMIT owns
// it, the task also owns the post-commit update to the in-memory room fence.
struct PendingWrite<T> {
    permission: Arc<AtomicBool>,
    task: JoinHandle<Result<T, PortError>>,
}

impl<T> PendingWrite<T> {
    fn revoke(&self) -> bool {
        let pending = self.permission.swap(false, Ordering::AcqRel);
        if pending {
            self.task.abort();
        }
        pending
    }
}

impl<T> Drop for PendingWrite<T> {
    fn drop(&mut self) {
        self.revoke();
    }
}

impl CanonicalStore {
    pub(crate) async fn with_auxiliary_command<T, R, F>(
        &self,
        budget: &CallBudget,
        deadline: CommandDeadline,
        after_commit: impl FnOnce(T) -> Result<R, PortError> + Send + 'static,
        op: F,
    ) -> Result<R, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> crate::BoxFuture<'c, Result<T, PortError>>
            + Send
            + 'static,
        T: Send + 'static,
        R: Send + 'static,
    {
        deadline.remaining(budget)?;
        let store = self.clone();
        let permission = Arc::new(AtomicBool::new(true));
        let commit = Arc::clone(&permission);
        let worker_budget = budget.clone();
        let task = tokio::spawn(async move {
            deadline.remaining(&worker_budget)?;
            let result = store
                .with_write_tx(move |tx| {
                    let body = op(tx);
                    Box::pin(async move {
                        let result = body.await?;
                        deadline.remaining(&worker_budget)?;
                        if !commit.swap(false, Ordering::AcqRel) {
                            return Err(cancelled_not_committed(
                                "auxiliary_write_revoked",
                                "caller left before commit",
                            ));
                        }
                        Ok(result)
                    })
                })
                .await?;
            after_commit(result)
        });
        let mut pending = PendingWrite { permission, task };
        let error = match deadline.wait(budget, || &mut pending.task).await {
            Ok(Ok(result)) => {
                return result.map_err(|error| {
                    if !pending.permission.load(Ordering::Acquire) {
                        unknown_commit_non_idempotent("auxiliary_commit_outcome", error.to_string())
                    } else {
                        error
                    }
                });
            }
            Ok(Err(error)) => internal_not_committed("auxiliary_task_join", error.to_string()),
            Err(error) => error,
        };
        if pending.revoke() {
            Err(error)
        } else {
            Err(unknown_commit_non_idempotent(
                "auxiliary_commit_outcome",
                error.to_string(),
            ))
        }
    }
}
