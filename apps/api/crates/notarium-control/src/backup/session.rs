//! independent cancellation and retention watchdog state.
use super::{failure, worker::Command};
use crate::store::lease::OperationBudget;
use notarium_core::{
    error::{CommitEffect, PortError},
    ports::*,
};
use std::{
    fs::File,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, mpsc};
pub(crate) struct Session {
    pub(crate) operation: OperationBudget,
    pub(crate) receipt: AtomicU8,
    pub(crate) interrupts: Mutex<Vec<rusqlite::InterruptHandle>>,
    original: Cancellation,
    local: Cancellation,
    spool_cancellation: Mutex<Option<Cancellation>>,
    limits: Mutex<BackupBudget>,
    pinned: Mutex<Option<Instant>>,
    started: Instant,
    remaining: Duration,
    wal: Option<PathBuf>,
    pinned_wal: Mutex<Option<File>>,
    file: Mutex<Option<File>>,
    final_bytes: AtomicU64,
    done: AtomicBool,
    result: Mutex<Option<Result<(), PortError>>>,
    failure: Mutex<Option<PortError>>,
    notify: Notify,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    commands: Mutex<Option<mpsc::WeakSender<Command>>>,
}
impl Session {
    pub(crate) fn new(
        mut call: CallBudget,
        mut limits: BackupBudget,
        wal: Option<PathBuf>,
    ) -> Arc<Self> {
        let original = call.cancellation.clone();
        let local = Cancellation::default();
        call.cancellation = local.clone();
        call.remaining = call.remaining.min(limits.deadline);
        limits.deadline = call.remaining;
        let remaining = call.remaining;
        let started = Instant::now();
        Arc::new(Self {
            operation: OperationBudget::new(call),
            receipt: AtomicU8::new(0),
            interrupts: Mutex::new(Vec::new()),
            original,
            local,
            spool_cancellation: Mutex::new(None),
            limits: Mutex::new(limits),
            pinned: Mutex::new(None),
            started,
            remaining,
            wal,
            pinned_wal: Mutex::new(None),
            file: Mutex::new(None),
            final_bytes: AtomicU64::new(0),
            done: AtomicBool::new(false),
            result: Mutex::new(None),
            failure: Mutex::new(None),
            notify: Notify::new(),
            worker: Mutex::new(None),
            commands: Mutex::new(None),
        })
    }
    pub(crate) fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    pub(crate) fn set_worker(&self, worker: std::thread::JoinHandle<()>) -> Result<(), PortError> {
        *self.worker.lock().map_err(|_| failure())? = Some(worker);
        Ok(())
    }
    pub(crate) fn set_commands(&self, commands: &mpsc::Sender<Command>) -> Result<(), PortError> {
        *self.commands.lock().map_err(|_| failure())? = Some(commands.downgrade());
        Ok(())
    }
    pub(crate) fn wake(&self) {
        if let Ok(commands) = self.commands.lock()
            && let Some(sender) = commands.as_ref().and_then(mpsc::WeakSender::upgrade)
        {
            // A full queue already wakes the owner. Cancellation itself lives
            // in an independent flag and cannot be lost with this notification.
            let _ = sender.try_send(Command::Wake);
        }
    }
    pub(crate) fn remaining(&self) -> Duration {
        self.remaining.saturating_sub(self.started.elapsed())
    }
    pub(crate) fn cancel(&self) {
        self.local.cancel();
        self.wake();
        if let Ok(handles) = self.interrupts.lock() {
            for handle in handles.iter() {
                handle.interrupt();
            }
        }
    }
    pub(crate) fn unpin(&self) {
        if let Ok(mut at) = self.pinned.lock() {
            *at = None;
        }
        if let Ok(mut wal) = self.pinned_wal.lock() {
            *wal = None;
        }
    }
    pub(crate) fn mark_pinned(&self) -> Result<(), PortError> {
        if let Some(path) = &self.wal {
            *self.pinned_wal.lock().map_err(|_| failure())? =
                Some(File::open(path).map_err(|_| failure())?);
        }
        *self.pinned.lock().map_err(|_| failure())? = Some(Instant::now());
        Ok(())
    }
    pub(crate) fn track(&self, file: File) -> Result<(), PortError> {
        *self.file.lock().map_err(|_| failure())? = Some(file);
        Ok(())
    }
    pub(crate) fn finish_tracking(&self) -> Result<(), PortError> {
        if let Some(file) = self.file.lock().map_err(|_| failure())?.take() {
            self.final_bytes.store(
                file.metadata().map_err(|_| failure())?.len(),
                Ordering::SeqCst,
            );
        }
        Ok(())
    }
    pub(crate) fn spool_budget(
        &self,
        new: BackupBudget,
        cancellation: Cancellation,
    ) -> Result<(), PortError> {
        let mut limits = self.limits.lock().map_err(|_| failure())?;
        limits.deadline = limits.deadline.min(new.deadline);
        limits.max_spool_bytes = limits.max_spool_bytes.min(new.max_spool_bytes);
        match (&mut limits.retention, new.retention) {
            (
                BackupRetentionBudget::SqliteWal {
                    max_pinned_bytes: old,
                },
                BackupRetentionBudget::SqliteWal {
                    max_pinned_bytes: new,
                },
            ) => *old = (*old).min(new),
            (
                BackupRetentionBudget::PostgresSnapshot { max_age: old },
                BackupRetentionBudget::PostgresSnapshot { max_age: new },
            ) => *old = (*old).min(new),
            _ => return Err(failure()),
        }
        *self.spool_cancellation.lock().map_err(|_| failure())? = Some(cancellation);
        drop(limits);
        self.check()
    }
    pub(crate) fn check(&self) -> Result<(), PortError> {
        if let Some(error) = self.failure.lock().map_err(|_| failure())?.clone() {
            return Err(error);
        }
        if self.original.is_cancelled()
            || self
                .spool_cancellation
                .lock()
                .map_err(|_| failure())?
                .as_ref()
                .is_some_and(Cancellation::is_cancelled)
        {
            self.local.cancel();
        }
        self.operation.check(CommitEffect::NotCommitted)?;
        let limits = *self.limits.lock().map_err(|_| failure())?;
        let pinned = self.pinned.lock().map_err(|_| failure())?;
        let bytes = match self.file.lock().map_err(|_| failure())?.as_ref() {
            Some(file) => file.metadata().map_err(|_| failure())?.len(),
            None => self.final_bytes.load(Ordering::SeqCst),
        };
        let retention = match &self.wal {
            Some(_) => BackupRetentionProgress::SqliteWal {
                pinned_bytes: if pinned.is_some() {
                    self.pinned_wal
                        .lock()
                        .map_err(|_| failure())?
                        .as_ref()
                        .ok_or_else(failure)?
                        .metadata()
                        .map_err(|_| failure())?
                        .len()
                } else {
                    0
                },
            },
            None => BackupRetentionProgress::PostgresSnapshot {
                age: pinned.map(|at| at.elapsed()).unwrap_or_default(),
            },
        };
        limits.check(BackupProgress {
            elapsed: self.started.elapsed(),
            retention,
            spool_bytes: bytes,
        })?;
        Ok(())
    }
    pub(crate) fn watchdog(self: &Arc<Self>) {
        let session = self.clone();
        std::thread::spawn(move || {
            while !session.done.load(Ordering::SeqCst) {
                if let Err(error) = session.check() {
                    if let Ok(mut saved) = session.failure.lock()
                        && saved.is_none()
                    {
                        *saved = Some(error);
                    }
                    session.cancel();
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        });
    }
    pub(crate) fn finished(&self, result: Result<(), PortError>) {
        if let Ok(mut saved) = self.result.lock() {
            *saved = Some(result);
        }
        self.done.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub(crate) async fn closed(&self) -> Result<(), PortError> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let result = self.result.lock().map_err(|_| failure())?.clone();
            if let Some(result) = result {
                let worker = self.worker.lock().map_err(|_| failure())?.take();
                if let Some(worker) = worker {
                    tokio::task::spawn_blocking(move || worker.join())
                        .await
                        .map_err(|_| failure())?
                        .map_err(|_| failure())?;
                }
                return result;
            }
            notified.await;
        }
    }
}
