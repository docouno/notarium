//! A backup handle can outlive the caller's executor or the store itself.
//! Keep the database resources on the store executor until release or shutdown.

use super::{
    BackupBudget, BackupHold, BackupSnapshot, BackupSpool, BackupWitness, Cancellation,
    CanonicalInner, CanonicalStore, PausedBackup, PortError, PortFuture, PreparedBackup,
    cancelled_not_committed,
};
use std::{future::Future, pin::Pin, sync::Arc};
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
            let prepared = tokio::select! {
                biased;
                () = reply.closed() => return,
                result = store.prepare_source(ctx, backup, budget) => result,
            };
            let handle = match prepared {
                Ok(raw) => Phase::new(&store.inner, raw, PreparedBackup::abort)
                    .await
                    .map(|phase| Box::new(phase) as Box<dyn PreparedBackup>),
                Err(error) => Err(error),
            };
            let _ = reply.send(handle);
        })
        .map_err(|()| closed())?;
        result.await.map_err(|_| closed())?
    })
}

type PhaseCall<T> =
    Box<dyn for<'a> FnOnce(&'a mut T) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> + Send>;

pub(super) struct Phase<T> {
    commands: mpsc::Sender<PhaseCall<T>>,
    finished: oneshot::Receiver<Result<(), PortError>>,
}

impl<T: Send + 'static> Phase<T> {
    pub(super) async fn new(
        inner: &CanonicalInner,
        resource: T,
        close: fn(Box<T>) -> PortFuture<'static, ()>,
    ) -> Result<Self, PortError> {
        let (commands, mut queue) = mpsc::channel::<PhaseCall<T>>(1);
        let (done, finished) = oneshot::channel();
        let shutdown = inner.backup_shutdown.clone();
        let owner = spawn_owner(inner, resource, |mut resource| async move {
            loop {
                let command = tokio::select! {
                    biased;
                    () = shutdown.cancelled() => break,
                    command = queue.recv() => command,
                };
                let Some(call) = command else { break };
                // An admitted spool reports its actual publication result. Each
                // database phase observes shutdown while it still owns the work.
                call(&mut resource).await;
            }
            drop(queue);
            // Shutdown, explicit close, and a dropped handle all use the
            // same resource owner and await the same database cleanup.
            let _ = done.send(close(Box::new(resource)).await);
        });
        if let Err(resource) = owner {
            close(Box::new(resource)).await?;
            return Err(closed());
        }
        Ok(Self { commands, finished })
    }

    fn with<R: Send + 'static>(
        &self,
        op: impl for<'a> FnOnce(&'a mut T) -> PortFuture<'a, R> + Send + 'static,
    ) -> PortFuture<'static, R> {
        let commands = self.commands.clone();
        Box::pin(async move {
            let (mut reply, result) = oneshot::channel();
            let command: PhaseCall<T> = Box::new(move |resource| {
                Box::pin(async move {
                    tokio::select! {
                        biased;
                        () = reply.closed() => {},
                        result = op(resource) => { let _ = reply.send(result); },
                    }
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
        self.with(PreparedBackup::acquire_hold)
    }

    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
        self.with(PreparedBackup::pause_writes)
    }
}

impl PausedBackup for Phase<super::CanonicalPausedBackup> {
    fn open_cut(&mut self) -> PortFuture<'_, Box<dyn BackupSnapshot>> {
        self.with(PausedBackup::open_cut)
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
        Ok(Self {
            witness: raw.witness.clone(),
            source: Phase::new(&inner, raw, BackupSnapshot::close).await?,
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
        self.source.with(move |p| p.spool(budget, cancellation))
    }

    fn close(self: Box<Self>) -> PortFuture<'static, ()> {
        self.source.finish()
    }
}
