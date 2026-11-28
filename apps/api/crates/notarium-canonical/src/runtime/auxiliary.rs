use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use notarium_core::{
    error::PortError,
    ids::SpaceId,
    ports::{CallBudget, CanonicalEffectAdmission, RevocationLease},
};
use tokio::task::JoinHandle;

use crate::{
    CanonicalStore,
    codec::{cancelled_not_committed, internal_not_committed, unknown_commit_non_idempotent},
    domain::common::CommandDeadline,
    sql_exec::BackendConn,
};

#[cfg(feature = "test-support")]
pub(super) struct VisibilityCommitPause {
    committed: tokio::sync::oneshot::Sender<()>,
    resume: tokio::sync::oneshot::Receiver<()>,
}

// Caller cancellation and COMMIT contend for one permission. Once COMMIT owns
// it, the storage executor owns both the SQL result and its local publication.
// A guarded worker also owns rollback before it releases the active lease.
struct PendingWrite<T> {
    permission: Arc<AtomicBool>,
    task: JoinHandle<Result<T, PortError>>,
    abort_on_revoke: bool,
    allow_abort_before_effect: bool,
    effect_entered: Option<Arc<AtomicBool>>,
}

impl<T> PendingWrite<T> {
    fn revoke(&self) -> bool {
        let pending = self.permission.swap(false, Ordering::AcqRel);
        let before_effect = self.allow_abort_before_effect
            && self
                .effect_entered
                .as_ref()
                .is_some_and(|entered| !entered.load(Ordering::Acquire));
        if pending && (self.abort_on_revoke || before_effect) {
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

#[derive(Clone)]
pub(crate) struct AuxiliaryEffect(Option<Arc<AuxiliaryRegistration>>);

struct AuxiliaryRegistration {
    admission: CanonicalEffectAdmission,
    active: Mutex<Option<Box<dyn RevocationLease>>>,
    entered: Arc<AtomicBool>,
}

impl AuxiliaryEffect {
    pub(crate) async fn begin(&self) -> Result<(), PortError> {
        if let Some(effect) = &self.0 {
            effect.entered.store(true, Ordering::Release);
            let active = effect.admission.begin().await?;
            *effect.active.lock().expect("auxiliary effect lock") = Some(active);
        }
        Ok(())
    }

    pub(crate) fn check(&self) -> Result<(), PortError> {
        if let Some(effect) = &self.0 {
            let active = effect.active.lock().expect("auxiliary effect lock");
            active
                .as_ref()
                .ok_or_else(|| {
                    internal_not_committed(
                        "auxiliary_effect_missing",
                        "the SQL effect did not enter",
                    )
                })?
                .check()?;
        }
        Ok(())
    }
}

impl CanonicalStore {
    #[cfg(feature = "test-support")]
    pub fn pause_next_visibility_commit_for_test(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (committed, observed) = tokio::sync::oneshot::channel();
        let (resume, waiting) = tokio::sync::oneshot::channel();
        let previous = self
            .inner
            .visibility_commit_pause
            .lock()
            .expect("visibility test pause")
            .replace(VisibilityCommitPause {
                committed,
                resume: waiting,
            });
        assert!(
            previous.is_none(),
            "one pending visibility commit pause per runtime"
        );
        (observed, resume)
    }

    #[cfg(feature = "test-support")]
    pub(super) async fn pause_after_visibility_commit_for_test(&self) {
        let pause = self
            .inner
            .visibility_commit_pause
            .lock()
            .expect("visibility test pause")
            .take();
        if let Some(pause) = pause {
            let _ = pause.committed.send(());
            let _ = pause.resume.await;
        }
    }

    pub(crate) async fn with_auxiliary_command<T, R, F>(
        &self,
        space: SpaceId,
        timing: Option<(&CallBudget, CommandDeadline)>,
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
        self.with_auxiliary_visibility_command(space, None, timing, after_commit, op)
            .await
    }

    pub(crate) async fn with_auxiliary_visibility_command<T, R, F>(
        &self,
        space: SpaceId,
        visible_space: Option<SpaceId>,
        timing: Option<(&CallBudget, CommandDeadline)>,
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
        self.with_guarded_auxiliary_command(
            space,
            visible_space,
            timing,
            None,
            after_commit,
            move |tx, _| op(tx),
        )
        .await
    }

    pub(crate) async fn with_guarded_auxiliary_command<T, R, F>(
        &self,
        space: SpaceId,
        visible_space: Option<SpaceId>,
        timing: Option<(&CallBudget, CommandDeadline)>,
        registration: Option<CanonicalEffectAdmission>,
        after_commit: impl FnOnce(T) -> Result<R, PortError> + Send + 'static,
        op: F,
    ) -> Result<R, PortError>
    where
        F: for<'c> FnOnce(
                &'c mut BackendConn<'_>,
                AuxiliaryEffect,
            ) -> crate::BoxFuture<'c, Result<T, PortError>>
            + Send
            + 'static,
        T: Send + 'static,
        R: Send + 'static,
    {
        let abort_on_revoke = registration.is_none();
        let allow_abort_before_effect = true;
        let worker_timing = timing.map(|(budget, deadline)| (budget.clone(), deadline));
        let check = move || -> Result<(), PortError> {
            if let Some((budget, deadline)) = &worker_timing {
                deadline.remaining(budget)?;
            }
            Ok(())
        };
        check()?;
        let Ok(aux_permit) = Arc::clone(&self.inner.aux_workers).try_read_owned() else {
            return Err(crate::codec::unavailable_retryable(
                "canonical_shutting_down",
                "canonical runtime is shutting down",
                std::time::Duration::from_millis(100),
            ));
        };
        let store = self.clone();
        let permission = Arc::new(AtomicBool::new(true));
        let commit = Arc::clone(&permission);
        let effect_entered = registration
            .as_ref()
            .map(|_| Arc::new(AtomicBool::new(false)));
        let active = AuxiliaryEffect(registration.map(|admission| {
            Arc::new(AuxiliaryRegistration {
                admission,
                active: Mutex::new(None),
                entered: Arc::clone(
                    effect_entered
                        .as_ref()
                        .expect("entered flag created for registration"),
                ),
            })
        }));
        let barrier_entered = effect_entered.clone();
        let commit_attempted = Arc::new(AtomicBool::new(false));
        let barrier_commit_attempted = Arc::clone(&commit_attempted);
        let task = self.inner.backup_executor.spawn(async move {
            let _aux_permit = aux_permit;
            check()?;
            // The owner keeps the active lease past a canceled waiter and
            // while the connection acknowledges COMMIT or ROLLBACK.
            let barrier_space = space.clone();
            let operation_effect = active.clone();
            let result = store
                .with_visibility_write_tx(
                    Some(space),
                    visible_space,
                    move |tx| {
                        Box::pin(async move {
                            check()?;
                            if !commit.load(Ordering::Acquire) {
                                return Err(cancelled_not_committed(
                                    "auxiliary_write_revoked",
                                    "caller left before SQL execution",
                                ));
                            }
                            let result = op(tx, operation_effect.clone()).await?;
                            check()?;
                            operation_effect.check()?;
                            if !commit.swap(false, Ordering::AcqRel) {
                                return Err(cancelled_not_committed(
                                    "auxiliary_write_revoked",
                                    "caller left before commit",
                                ));
                            }
                            commit_attempted.store(true, Ordering::Release);
                            Ok(result)
                        })
                    },
                    after_commit,
                )
                .await;
            if store.is_postgres()
                && result.is_err()
                && barrier_commit_attempted.load(Ordering::Acquire)
                && barrier_entered
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Acquire))
            {
                store
                    .await_pg_unknown_commit_barrier(std::slice::from_ref(&barrier_space))
                    .await;
            }
            drop(active);
            result
        });
        let mut pending = PendingWrite {
            permission,
            task,
            abort_on_revoke,
            allow_abort_before_effect,
            effect_entered,
        };
        let joined = match timing {
            Some((budget, deadline)) => deadline.wait(budget, || &mut pending.task).await,
            None => Ok((&mut pending.task).await),
        };
        let error = match joined {
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
