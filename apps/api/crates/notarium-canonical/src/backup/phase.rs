//! A backup handle can outlive the caller's executor or the store itself.
//! Keep the database resources on the store executor until release or shutdown.

use super::{
    BackupBudget, BackupHold, BackupSnapshot, BackupSpool, BackupWitness, Cancellation,
    CanonicalInner, CanonicalStore, PausedBackup, PortError, PortFuture, PreparedBackup,
    cancelled_not_committed,
};
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

pub(super) struct CaptureCancellation {
    pub(super) token: Cancellation,
    forward: tokio::task::AbortHandle,
}

impl CaptureCancellation {
    fn new(inner: &CanonicalInner, external: Cancellation) -> Arc<Self> {
        let token = Cancellation::default();
        if external.is_cancelled() {
            token.cancel();
        }
        let child = token.clone();
        let forward = inner
            .backup_executor
            .spawn(async move {
                external.cancelled().await;
                child.cancel();
            })
            .abort_handle();
        Arc::new(Self { token, forward })
    }
}

impl Drop for CaptureCancellation {
    fn drop(&mut self) {
        self.forward.abort();
    }
}

fn closed() -> PortError {
    cancelled_not_committed("backup_phase_closed", "backup phase has ended")
}

fn spawn_owner<T, F: Future<Output = ()> + Send + 'static>(
    inner: &CanonicalInner,
    resource: T,
    task: impl FnOnce(T) -> F,
) -> Result<(), T> {
    let mut tasks = inner.backup_cleanups.lock().expect("backup cleanups mutex");
    if inner.backup_shutdown.is_cancelled() {
        return Err(resource);
    }
    tasks.retain(|task| !task.is_finished());
    tasks.push(inner.backup_executor.spawn(task(resource)));
    Ok(())
}

struct PhaseReply<R> {
    result: Arc<Mutex<Option<R>>>,
    received: oneshot::Sender<()>,
}

impl<R> PhaseReply<R> {
    fn claim(self) -> Result<R, PortError> {
        let result = self.result.lock().expect("backup phase reply").take();
        let _ = self.received.send(());
        result.ok_or_else(closed)
    }
}

async fn deliver<R, F>(
    reply: oneshot::Sender<Result<PhaseReply<R>, PortError>>,
    result: Result<R, PortError>,
    shutdown: &Cancellation,
    dispose: impl FnOnce(R) -> F,
) -> Result<(), PortError>
where
    F: Future<Output = Result<(), PortError>>,
{
    let resource = match result {
        Ok(resource) => resource,
        Err(error) => {
            let _ = reply.send(Err(error));
            return Ok(());
        }
    };
    let result = Arc::new(Mutex::new(Some(resource)));
    let (received, acknowledged) = oneshot::channel();
    let offer = PhaseReply {
        result: result.clone(),
        received,
    };
    if reply.send(Ok(offer)).is_ok() {
        let claimed = tokio::select! {
            () = shutdown.cancelled() => false,
            result = acknowledged => result.is_ok(),
        };
        if claimed {
            return Ok(());
        }
    }
    let undelivered = result.lock().expect("backup phase reply").take();
    if let Some(resource) = undelivered {
        dispose(resource).await?;
    }
    Ok(())
}

pub(super) fn prepare(
    store: CanonicalStore,
    mut ctx: super::MaintenanceContext,
    backup: super::BackupId,
    budget: BackupBudget,
) -> PortFuture<'static, Box<dyn PreparedBackup>> {
    Box::pin(async move {
        let (mut reply, result) = oneshot::channel();
        let inner = store.inner.clone();
        spawn_owner(&inner, (), |()| async move {
            if reply.is_closed() {
                return;
            }
            let scope = CaptureCancellation::new(&store.inner, ctx.budget.cancellation);
            let cancellation = scope.token.clone();
            ctx.budget.cancellation = cancellation.clone();
            let prepare = store.prepare_source(ctx, backup, budget, scope);
            tokio::pin!(prepare);
            let prepared = tokio::select! {
                result = &mut prepare => result,
                () = reply.closed() => {
                    cancellation.cancel();
                    prepare.await
                },
            };
            let handle = match prepared {
                Ok(raw) => Phase::new(&store.inner, raw, cancellation, PreparedBackup::abort)
                    .await
                    .map(|phase| Box::new(phase) as Box<dyn PreparedBackup>),
                Err(error) => Err(error),
            };
            let shutdown = &store.inner.backup_shutdown;
            let _ = deliver(reply, handle, shutdown, |phase| phase.abort()).await;
        })
        .map_err(|()| closed())?;
        result.await.map_err(|_| closed())??.claim()
    })
}

type PhaseCall<T> = Box<dyn for<'a> FnOnce(&'a mut T) -> PortFuture<'a, ()> + Send>;

pub(super) struct Phase<T> {
    commands: mpsc::Sender<PhaseCall<T>>,
    finished: oneshot::Receiver<Result<(), PortError>>,
    cancellation: Cancellation,
    shutdown: Cancellation,
}

impl<T: Send + 'static> Phase<T> {
    pub(super) async fn new(
        inner: &CanonicalInner,
        resource: T,
        cancellation: Cancellation,
        close: fn(Box<T>) -> PortFuture<'static, ()>,
    ) -> Result<Self, PortError> {
        let (commands, mut queue) = mpsc::channel::<PhaseCall<T>>(1);
        let (done, finished) = oneshot::channel();
        let shutdown = inner.backup_shutdown.clone();
        let owner_shutdown = shutdown.clone();
        let owner = spawn_owner(inner, resource, |mut resource| async move {
            let settled = loop {
                let command = tokio::select! {
                    biased;
                    () = owner_shutdown.cancelled() => break Ok(()),
                    command = queue.recv() => command,
                };
                let Some(call) = command else { break Ok(()) };
                if let Err(error) = call(&mut resource).await {
                    break Err(error);
                }
            };
            drop(queue);
            // Shutdown, explicit close, and a dropped handle all use the
            // same resource owner and await the same database cleanup.
            let _ = done.send(settled.and(close(Box::new(resource)).await));
        });
        if let Err(resource) = owner {
            close(Box::new(resource)).await?;
            return Err(closed());
        }
        Ok(Self {
            commands,
            finished,
            cancellation,
            shutdown,
        })
    }

    fn with<R, F>(
        &self,
        op: impl for<'a> FnOnce(&'a mut T) -> PortFuture<'a, R> + Send + 'static,
        dispose: impl FnOnce(R) -> F + Send + 'static,
    ) -> PortFuture<'static, R>
    where
        R: Send + 'static,
        F: Future<Output = Result<(), PortError>> + Send + 'static,
    {
        let commands = self.commands.clone();
        let cancellation = self.cancellation.clone();
        let shutdown = self.shutdown.clone();
        Box::pin(async move {
            let (mut reply, result) = oneshot::channel();
            let command: PhaseCall<T> = Box::new(move |resource| {
                Box::pin(async move {
                    if reply.is_closed() {
                        return Ok(());
                    }
                    let operation = op(resource);
                    tokio::pin!(operation);
                    let result = tokio::select! {
                        result = &mut operation => result,
                        () = reply.closed() => {
                            // An admitted phase owns work until it settles.
                            cancellation.cancel();
                            operation.await
                        },
                    };
                    deliver(reply, result, &shutdown, dispose).await
                })
            });
            commands.send(command).await.map_err(|_| closed())?;
            result.await.map_err(|_| closed())??.claim()
        })
    }
    fn finish(self) -> PortFuture<'static, ()> {
        Box::pin(async move {
            drop(self.commands);
            self.finished.await.map_err(|_| closed())?
        })
    }
}

impl PreparedBackup for Phase<super::CanonicalPreparedBackup> {
    fn abort(self: Box<Self>) -> PortFuture<'static, ()> {
        self.finish()
    }

    fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
        self.with(PreparedBackup::acquire_hold, |hold| hold.release())
    }

    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
        self.with(PreparedBackup::pause_writes, |pause| pause.resume())
    }
}

impl PausedBackup for Phase<super::CanonicalPausedBackup> {
    fn open_cut(&mut self) -> PortFuture<'_, Box<dyn BackupSnapshot>> {
        self.with(PausedBackup::open_cut, |snapshot| snapshot.close())
    }

    fn resume(self: Box<Self>) -> PortFuture<'static, ()> {
        self.finish()
    }
}

pub(super) struct Snapshot {
    witness: Arc<BackupWitness>,
    source: Phase<super::CanonicalBackupSnapshot>,
}

impl Snapshot {
    pub(super) async fn new(raw: super::CanonicalBackupSnapshot) -> Result<Self, PortError> {
        let inner = raw.store.inner.clone();
        let cancellation = raw.caller_cancel.token.clone();
        Ok(Self {
            witness: raw.witness.clone(),
            source: Phase::new(&inner, raw, cancellation, BackupSnapshot::close).await?,
        })
    }
}

impl BackupSnapshot for Snapshot {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }

    fn spool(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, BackupSpool> {
        self.source.with(
            move |p| p.spool(budget, cancellation),
            |_| std::future::ready(Ok(())),
        )
    }

    fn close(self: Box<Self>) -> PortFuture<'static, ()> {
        self.source.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unclaimed_reply_waits_for_resource_disposal() {
        let shutdown = Cancellation::default();
        let (reply, response) = oneshot::channel();
        let (started, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let worker = tokio::spawn(async move {
            deliver(reply, Ok(()), &shutdown, |()| async move {
                started.send(()).unwrap();
                wait.await.unwrap();
                Err(closed())
            })
            .await
        });
        let offered = response.await.unwrap().unwrap();
        drop(offered);
        observed.await.unwrap();
        assert!(!worker.is_finished());
        release.send(()).unwrap();
        assert_eq!(worker.await.unwrap(), Err(closed()));
    }

    #[tokio::test]
    async fn shutdown_reclaims_a_reply_whose_receiver_has_stopped_polling() {
        let shutdown = Cancellation::default();
        let (reply, response) = oneshot::channel();
        let (cleanup, cleaned) = oneshot::channel();
        let worker = tokio::spawn({
            let shutdown = shutdown.clone();
            async move {
                deliver(reply, Ok(()), &shutdown, |()| async move {
                    cleanup.send(()).unwrap();
                    Ok(())
                })
                .await
            }
        });
        let offered = response.await.unwrap().unwrap();
        shutdown.cancel();
        cleaned.await.unwrap();
        assert_eq!(offered.claim(), Err(closed()));
        worker.await.unwrap().unwrap();
    }
}
