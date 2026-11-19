//! A backup handle can outlive the caller's executor or the store itself.
//! Keep the database resources on the store executor until release or shutdown.

use super::{
    BackupBudget, BackupHold, BackupSnapshot, BackupSpool, BackupWitness, Cancellation,
    CanonicalInner, CanonicalStore, PausedBackup, PortError, PortFuture, PreparedBackup,
    cancelled_not_committed,
};
use std::{future::Future, sync::Arc};
use tokio::sync::{mpsc, oneshot};

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

pub(super) fn prepare(
    store: CanonicalStore,
    ctx: super::MaintenanceContext,
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
            let cancellation = ctx.budget.cancellation.clone();
            let prepare = store.prepare_source(ctx, backup, budget);
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
            if let Err(Ok(handle)) = reply.send(handle) {
                let _ = handle.abort().await;
            }
        })
        .map_err(|()| closed())?;
        result.await.map_err(|_| closed())?
    })
}

type PhaseCall<T> = Box<dyn for<'a> FnOnce(&'a mut T) -> PortFuture<'a, ()> + Send>;

pub(super) struct Phase<T> {
    commands: mpsc::Sender<PhaseCall<T>>,
    finished: oneshot::Receiver<Result<(), PortError>>,
    cancellation: Cancellation,
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
        let owner = spawn_owner(inner, resource, |mut resource| async move {
            let settled = loop {
                let command = tokio::select! {
                    biased;
                    () = shutdown.cancelled() => break Ok(()),
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
                    if let Err(Ok(undelivered)) = reply.send(result) {
                        dispose(undelivered).await?;
                    }
                    Ok(())
                })
            });
            commands.send(command).await.map_err(|_| closed())?;
            result.await.map_err(|_| closed())?
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
        let cancellation = raw.caller_cancel.clone();
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
