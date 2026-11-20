//! A backup handle can outlive the caller's executor or the store itself.
//! Keep the database resources on the store executor until release or shutdown.

use super::{
    BackupBudget, BackupHold, BackupSnapshot, BackupSpool, BackupWitness, Cancellation,
    CanonicalInner, CanonicalPreparedBackup, CanonicalStore, PausedBackup, PortError, PortFuture,
    PreparedBackup, cancelled_not_committed,
};
use notarium_core::ports::{CallBudget, TemporaryBackupSpool};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
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

/// Prepared Canonical participant for a paired cut. The store executor owns the
/// preparation and settles any admitted capture after the caller drops it.
pub struct BackupPreparation(Phase<CanonicalPreparedBackup>);

#[derive(Clone, Copy, Debug)]
pub struct PairedPause {
    /// From the Control safe-point acknowledgement through both resume acknowledgements.
    pub confirmed: Duration,
    /// From the first pause request through both resume acknowledgements.
    pub including_drain: Duration,
    /// Time spent checking for a gap in Canonical writes before the first pause request.
    pub writer_wait: Duration,
}

/// Both snapshots are pinned and both writer resumes have been acknowledged.
pub struct PairedBackupCut {
    pub control: Box<dyn BackupSnapshot>,
    pub canonical: Box<dyn BackupSnapshot>,
    pub pause: PairedPause,
}

impl PairedBackupCut {
    async fn close(self) -> Result<(), PortError> {
        let (control, canonical) = tokio::join!(self.control.close(), self.canonical.close());
        control.and(canonical)
    }
}

impl BackupPreparation {
    pub fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
        self.0.acquire_hold()
    }

    pub fn abort(self) -> PortFuture<'static, ()> {
        self.0.finish()
    }

    pub(super) fn into_port(self) -> Box<dyn PreparedBackup> {
        Box::new(self.0)
    }

    /// Capture with the prepared Control participant after both holds are acquired.
    /// The two participants and this call share the operation's cancellation budget.
    pub fn capture_paired(
        &mut self,
        control: Box<dyn PreparedBackup>,
        mut budget: CallBudget,
    ) -> PortFuture<'_, PairedBackupCut> {
        let requested = Instant::now();
        let pending = Arc::new(Mutex::new(Some(control)));
        let offered = pending.clone();
        let capture = self.0.with(
            move |canonical| {
                let control = offered
                    .lock()
                    .expect("backup handoff")
                    .take()
                    .expect("Control preparation");
                budget.remaining = budget.remaining.saturating_sub(requested.elapsed());
                Box::pin(capture_on_owner(canonical, control, budget))
            },
            PairedBackupCut::close,
        );
        Box::pin(async move {
            let result = capture.await;
            if result.is_err() {
                // A closed queue can reject the capture before the owner takes Control.
                let unadmitted = pending.lock().expect("backup handoff").take();
                if let Some(control) = unadmitted {
                    let _ = control.abort().await;
                }
            }
            result
        })
    }
}

async fn capture_on_owner(
    canonical: &mut CanonicalPreparedBackup,
    mut control: Box<dyn PreparedBackup>,
    budget: CallBudget,
) -> Result<PairedBackupCut, PortError> {
    let cancel = canonical.caller_cancel.token.clone();
    let shutdown = canonical.store.inner.backup_shutdown.clone();
    let cancelled = async {
        tokio::select! {
            () = cancel.cancelled() => {},
            () = shutdown.cancelled() => {},
        }
    };
    let result = {
        let capture = pin_pair(canonical, &mut *control, &budget);
        tokio::pin!(capture);
        tokio::select! {
            biased;
            () = cancelled => {
                budget.cancellation.cancel();
                capture.await
            }
            result = &mut capture => result,
        }
    };
    if result.is_err() {
        let _ = control.abort().await;
    }
    result
}

async fn pin_pair(
    canonical: &mut CanonicalPreparedBackup,
    control: &mut dyn PreparedBackup,
    budget: &CallBudget,
) -> Result<PairedBackupCut, PortError> {
    let wait_started = Instant::now();
    canonical.store.wait_for_backup_write_gap(budget).await?;
    let first_pause = Instant::now();
    let mut control_paused = control.pause_writes().await?;
    let confirmed = Instant::now();
    let mut canonical_paused = match canonical.pause_owned().await {
        Ok(paused) => Box::new(paused),
        Err(error) => {
            let _ = control_paused.resume().await;
            return Err(error);
        }
    };
    let (control, canonical) = tokio::join!(
        pin_cut(&mut *control_paused, &budget.cancellation),
        pin_cut(&mut *canonical_paused, &budget.cancellation),
    );
    let (control_resume, canonical_resume) =
        tokio::join!(control_paused.resume(), canonical_paused.resume());
    let resumed = Instant::now();
    let pause = PairedPause {
        confirmed: resumed.duration_since(confirmed),
        including_drain: resumed.duration_since(first_pause),
        writer_wait: first_pause.duration_since(wait_started),
    };
    let cuts = match (control, canonical) {
        (Ok(control), Ok(canonical)) => PairedBackupCut {
            control,
            canonical,
            pause,
        },
        (Err(error), Ok(canonical)) => {
            let _ = canonical.close().await;
            return Err(error);
        }
        (Ok(control), Err(error)) => {
            let _ = control.close().await;
            return Err(error);
        }
        (Err(PortError::Cancelled(_)), Err(error)) | (Err(error), Err(_)) => return Err(error),
    };
    if let Err(error) = control_resume.and(canonical_resume) {
        let _ = cuts.close().await;
        return Err(error);
    }
    Ok(cuts)
}

async fn pin_cut(
    paused: &mut dyn PausedBackup,
    cancellation: &Cancellation,
) -> Result<Box<dyn BackupSnapshot>, PortError> {
    let result = paused.open_cut().await;
    if result.is_err() {
        cancellation.cancel();
    }
    result
}

pub(super) fn prepare(
    store: CanonicalStore,
    mut ctx: super::MaintenanceContext,
    backup: super::BackupId,
    budget: BackupBudget,
) -> PortFuture<'static, BackupPreparation> {
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
                Ok(raw) => Phase::new(
                    &store.inner,
                    raw,
                    cancellation,
                    CanonicalPreparedBackup::abort,
                )
                .await
                .map(BackupPreparation),
                Err(error) => Err(error),
            };
            let shutdown = &store.inner.backup_shutdown;
            let _ = deliver(reply, handle, shutdown, BackupPreparation::abort).await;
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

impl PreparedBackup for Phase<CanonicalPreparedBackup> {
    fn abort(self: Box<Self>) -> PortFuture<'static, ()> {
        self.finish()
    }

    fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
        self.with(CanonicalPreparedBackup::acquire_hold, |hold| hold.release())
    }

    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
        self.with(
            |prepared| {
                Box::pin(async {
                    let paused = prepared.pause_owned().await?;
                    let inner = paused.store.inner.clone();
                    let cancellation = paused.caller_cancel.token.clone();
                    Phase::new(&inner, paused, cancellation, PausedBackup::resume)
                        .await
                        .map(|phase| Box::new(phase) as Box<dyn PausedBackup>)
                })
            },
            |pause| pause.resume(),
        )
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
            source: Phase::new(
                &inner,
                raw,
                cancellation,
                super::CanonicalBackupSnapshot::close,
            )
            .await?,
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
        let offered = self.source.with(
            move |p| p.spool(budget, cancellation, super::SpoolRetention::Durable),
            super::CapturedSpool::discard,
        );
        Box::pin(async move { offered.await?.accept() })
    }

    fn spool_temporary(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, TemporaryBackupSpool> {
        let offered = self.source.with(
            move |p| p.spool(budget, cancellation, super::SpoolRetention::Temporary),
            super::CapturedSpool::discard,
        );
        Box::pin(async move { Ok(offered.await?.temporary()) })
    }

    fn close(self: Box<Self>) -> PortFuture<'static, ()> {
        self.source.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::ids::RequestId;

    struct ControlPreparation {
        started: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
    }

    impl PreparedBackup for ControlPreparation {
        fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
            unreachable!("the Control hold was already acquired")
        }

        fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
            unreachable!("the closed Canonical queue rejects the capture")
        }

        fn abort(self: Box<Self>) -> PortFuture<'static, ()> {
            Box::pin(async move {
                self.started.send(()).unwrap();
                self.release.await.unwrap();
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn rejected_pair_waits_for_control_preparation_cleanup() {
        let (commands, receiver) = mpsc::channel(1);
        drop(receiver);
        let (_done, finished) = oneshot::channel();
        let mut prepared = BackupPreparation(Phase {
            commands,
            finished,
            cancellation: Cancellation::default(),
            shutdown: Cancellation::default(),
        });
        let (started, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let task = tokio::spawn(async move {
            let control = Box::new(ControlPreparation {
                started,
                release: wait,
            });
            let budget = CallBudget {
                request: RequestId::from_bytes([1; 16]),
                remaining: Duration::from_secs(1),
                cancellation: Cancellation::default(),
            };
            prepared.capture_paired(control, budget).await.err()
        });
        observed.await.unwrap();
        assert!(!task.is_finished());
        release.send(()).unwrap();
        assert_eq!(task.await.unwrap(), Some(closed()));
    }

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
