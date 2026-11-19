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

fn spawn_owner(
    inner: &CanonicalInner,
    task: impl Future<Output = ()> + Send + 'static,
) -> Result<(), PortError> {
    let mut tasks = inner.backup_cleanups.lock().expect("backup cleanups mutex");
    if inner.backup_shutdown.is_cancelled() {
        return Err(closed());
    }
    tasks.retain(|task| !task.is_finished());
    tasks.push(inner.backup_executor.spawn(task));
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
        spawn_owner(&inner, async move {
            let prepared = tokio::select! {
                biased;
                () = reply.closed() => return,
                result = store.prepare_source(ctx, backup, budget) => result,
            };
            let _ = reply.send(prepared.and_then(|handle| {
                Phase::new(&store.inner, handle).map(|p| Box::new(p) as Box<dyn PreparedBackup>)
            }));
        })?;
        result.await.map_err(|_| closed())?
    })
}

type PhaseCall<T> = Box<
    dyn for<'a> FnOnce(&'a mut Option<T>) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> + Send,
>;

pub(super) struct Phase<T> {
    commands: mpsc::Sender<PhaseCall<T>>,
}

impl<T: Send + 'static> Phase<T> {
    pub(super) fn new(inner: &CanonicalInner, resource: T) -> Result<Self, PortError> {
        let (commands, mut queue) = mpsc::channel::<PhaseCall<T>>(1);
        let shutdown = inner.backup_shutdown.clone();
        spawn_owner(inner, async move {
            let mut resource = Some(resource);
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
        })?;
        Ok(Self { commands })
    }

    fn call<R: Send + 'static>(
        &self,
        op: impl for<'a> FnOnce(&'a mut Option<T>) -> PortFuture<'a, R> + Send + 'static,
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
    fn with<R: Send + 'static>(
        &self,
        op: impl for<'a> FnOnce(&'a mut T) -> PortFuture<'a, R> + Send + 'static,
    ) -> PortFuture<'static, R> {
        self.call(move |state| {
            Box::pin(async move { op(state.as_mut().ok_or_else(closed)?).await })
        })
    }

    fn finish<R: Send + 'static>(
        &self,
        op: impl FnOnce(Box<T>) -> PortFuture<'static, R> + Send + 'static,
    ) -> PortFuture<'static, R> {
        self.call(move |state| {
            Box::pin(async move { op(Box::new(state.take().ok_or_else(closed)?)).await })
        })
    }
}

impl PreparedBackup for Phase<super::CanonicalPreparedBackup> {
    fn abort(self: Box<Self>) -> PortFuture<'static, ()> {
        self.finish(PreparedBackup::abort)
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
        self.finish(PausedBackup::resume)
    }
}

pub(super) struct Snapshot {
    witness: Arc<BackupWitness>,
    source: Phase<super::CanonicalBackupSnapshot>,
}

impl Snapshot {
    pub(super) fn new(raw: super::CanonicalBackupSnapshot) -> Result<Self, PortError> {
        let inner = raw.store.inner.clone();
        Ok(Self {
            witness: raw.witness.clone(),
            source: Phase::new(&inner, raw)?,
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
        Box::pin(async move {
            let result = self.source.finish(BackupSnapshot::close).await;
            if result.as_ref().is_err_and(|error| *error == closed())
                && self.source.commands.is_closed()
            {
                return Ok(());
            }
            result
        })
    }
}
