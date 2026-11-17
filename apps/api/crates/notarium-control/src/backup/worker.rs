//! A bounded owner keeps native handles alive through their real cleanup ACK.
use super::{
    BackupMetrics, artifacts::Artifacts, failure, postgres::PostgresCut, protocol::Client,
    session::Session, sqlite::SqliteCut,
};
use crate::{
    keyring::KeyringWitness,
    store::{
        Backend, ControlStore,
        fence::{FileFence, sqlite_writer_lock},
    },
};
use notarium_core::{
    error::{CommitEffect, PortError},
    ids::{ArtifactId, BackupId, ContentDigest},
    ports::*,
};
use std::{
    fs::OpenOptions,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedRwLockWriteGuard, OwnedSemaphorePermit, mpsc, oneshot};

pub(crate) enum Command {
    Wake,
    Pause(oneshot::Sender<Result<(), PortError>>),
    Pin(oneshot::Sender<Result<BackupWitness, PortError>>),
    Resume(oneshot::Sender<Result<(), PortError>>),
    Spool {
        budget: BackupBudget,
        cancellation: Cancellation,
        reply: oneshot::Sender<Result<BackupSpool, PortError>>,
    },
}
enum Source {
    Sqlite(Box<SqliteCut>),
    Postgres(PostgresCut),
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Prepared,
    Paused,
    Pinned,
    Resumed,
    Offered,
    Finished,
}
struct Worker {
    store: ControlStore,
    data: notarium_core::epoch::DataRoot,
    backup: BackupId,
    keys: Vec<KeyringWitness>,
    witness: BackupWitness,
    session: Arc<Session>,
    source: Option<Source>,
    artifacts: Option<Artifacts>,
    artifact: Option<ArtifactId>,
    path: Option<PathBuf>,
    local_pause: Option<OwnedRwLockWriteGuard<()>>,
    file_pause: Option<FileFence>,
    phase: Phase,
    pause_started: Option<Instant>,
    metrics: BackupMetrics,
    metrics_sink: Arc<Mutex<Option<BackupMetrics>>>,
    _slot: OwnedSemaphorePermit,
}
impl Worker {
    async fn prepare(&mut self) -> Result<(), PortError> {
        self.session.check()?;
        self.artifacts = Some(Artifacts::open(&self.data, || self.session.check())?);
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy).map_err(|_| failure())?;
        let artifact = ArtifactId::from_bytes(entropy);
        self.artifact = Some(artifact.clone());
        let path = self
            .artifacts
            .as_mut()
            .ok_or_else(failure)?
            .begin(&artifact, &self.backup)?;
        self.path = Some(path.clone());
        self.session.track(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|_| failure())?,
        )?;
        self.source = Some(match &self.store.backend {
            Backend::Sqlite { path: source, .. } => {
                Source::Sqlite(Box::new(SqliteCut::prepare(source, &path, &self.session)?))
            }
            Backend::Postgres { pool, .. } => {
                Source::Postgres(PostgresCut::prepare(pool, &self.session, &self.witness).await?)
            }
        });
        self.session.check()?;
        self.metrics.prepare = self.session.elapsed();
        Ok(())
    }
    async fn pause(&mut self) -> Result<(), PortError> {
        if self.phase != Phase::Prepared {
            return Err(failure());
        }
        let started = Instant::now();
        self.pause_started = Some(started);
        self.local_pause = Some(
            self.session
                .operation
                .run(
                    async { Ok(self.store.writes.clone().write_owned().await) },
                    CommitEffect::NotCommitted,
                )
                .await?,
        );
        match self.source.as_mut().ok_or_else(failure)? {
            Source::Sqlite(_) => {
                let Backend::Sqlite { path, .. } = &self.store.backend else {
                    return Err(failure());
                };
                self.file_pause =
                    Some(FileFence::acquire(&sqlite_writer_lock(path), true, || {
                        self.session.check()
                    })?);
            }
            Source::Postgres(source) => source.pause(&self.session).await?,
        }
        self.metrics.drain = started.elapsed();
        self.phase = Phase::Paused;
        self.session.check()
    }
    async fn pin(&mut self) -> Result<BackupWitness, PortError> {
        if self.phase != Phase::Paused {
            return Err(failure());
        }
        let witness = match self.source.as_mut().ok_or_else(failure)? {
            Source::Sqlite(source) => source.pin(&self.witness, &self.keys, &self.session)?,
            Source::Postgres(source) => {
                source.pin(&self.witness, &self.keys, &self.session).await?
            }
        };
        self.phase = Phase::Pinned;
        Ok(witness)
    }
    async fn resume(&mut self) -> Result<(), PortError> {
        if !matches!(self.phase, Phase::Paused | Phase::Pinned) {
            return Err(failure());
        }
        if let Some(Source::Postgres(source)) = &mut self.source {
            source.unlock().await?;
        }
        if let Some(fence) = self.file_pause.take() {
            fence.release()?;
        }
        self.local_pause.take();
        self.metrics.pause = self.pause_started.ok_or_else(failure)?.elapsed();
        if self.phase == Phase::Paused {
            // A coordinator may resume after another participant fails before pin.
            self.close_source().await?;
            self.phase = Phase::Finished;
        } else {
            self.phase = Phase::Resumed;
        }
        Ok(())
    }
    async fn close_source(&mut self) -> Result<(), PortError> {
        let result = match self.source.take() {
            Some(Source::Sqlite(source)) => source.close(&self.session),
            Some(Source::Postgres(source)) => source.close().await,
            None => Ok(()),
        };
        self.session.unpin();
        result
    }
    async fn spool(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> Result<BackupSpool, PortError> {
        if self.phase != Phase::Resumed {
            return Err(failure());
        }
        let started = Instant::now();
        self.session.spool_budget(budget, cancellation)?;
        let path = self.path.as_ref().ok_or_else(failure)?;
        let kind = match self.source.as_mut().ok_or_else(failure)? {
            Source::Sqlite(source) => {
                source.spool(&self.session)?;
                BackupArtifactKind::SqliteSnapshotV1
            }
            Source::Postgres(source) => {
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(path)
                    .map_err(|_| failure())?;
                let file = source
                    .spool(file, self.witness.clone(), &self.session)
                    .await?;
                file.sync_all().map_err(|_| failure())?;
                BackupArtifactKind::PostgresSpoolV1
            }
        };
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|_| failure())?;
        file.sync_all().map_err(|_| failure())?;
        let mut digest = blake3::Hasher::new();
        let mut bytes = 0u64;
        let mut chunk = [0; 65536];
        loop {
            self.session.check()?;
            let count = file.read(&mut chunk).map_err(|_| failure())?;
            if count == 0 {
                break;
            }
            bytes = bytes.checked_add(count as u64).ok_or_else(failure)?;
            digest.update(&chunk[..count]);
        }
        if file.metadata().map_err(|_| failure())?.len() != bytes {
            return Err(failure());
        }
        drop(file);
        self.session.check()?;
        let receipt = BackupSpool {
            artifact: self.artifact.clone().ok_or_else(failure)?,
            kind,
            bytes,
            digest: ContentDigest::from_bytes(*digest.finalize().as_bytes()),
            witness: self.witness.clone(),
        };
        // A stable complete file exists before releasing the source cut. Uploading
        // or packaging later cannot retain a database snapshot through this handle.
        self.close_source().await?;
        self.session.finish_tracking()?;
        self.artifacts
            .as_ref()
            .ok_or_else(failure)?
            .complete(&receipt)?;
        self.session.check()?;
        self.phase = Phase::Offered;
        self.metrics.spool = started.elapsed();
        self.metrics.bytes = bytes;
        Ok(receipt)
    }
    async fn run(&mut self, commands: &mut mpsc::Receiver<Command>) -> Result<(), PortError> {
        loop {
            if self.phase == Phase::Finished || self.session.receipt.load(Ordering::SeqCst) == 1 {
                return Ok(());
            }
            self.session.check()?;
            let cancel = self
                .session
                .operation
                .context(notarium_core::ids::RequestId::from_bytes([0; 16]))
                .cancellation;
            let command = tokio::select! {
                cmd = commands.recv() => cmd,
                _ = cancel.cancelled() => {
                    return self.session.check();
                }
            };
            match command {
                Some(Command::Wake) => (),
                Some(Command::Pause(reply)) => {
                    let result = self.pause().await;
                    let failed = result.is_err();
                    if reply.send(result).is_err() || failed {
                        return Err(failure());
                    }
                }
                Some(Command::Pin(reply)) => {
                    let result = self.pin().await;
                    let failed = result.is_err();
                    if reply.send(result).is_err() || failed {
                        return Err(failure());
                    }
                }
                Some(Command::Resume(reply)) => {
                    let result = self.resume().await;
                    let failed = result.is_err();
                    if reply.send(result).is_err() || failed {
                        return Err(failure());
                    }
                }
                Some(Command::Spool {
                    budget,
                    cancellation,
                    reply,
                }) => {
                    let result = self.spool(budget, cancellation).await;
                    let failed = result.is_err();
                    if reply.send(result).is_err() || failed {
                        return Err(failure());
                    }
                }
                None => return Err(failure()),
            }
        }
    }
    async fn cleanup(&mut self) -> Result<(), PortError> {
        let source = self.close_source().await;
        let fence = if let Some(fence) = self.file_pause.take() {
            fence.release()
        } else {
            Ok(())
        };
        self.local_pause.take();
        let tracking = self.session.finish_tracking();
        let accepted =
            self.session
                .receipt
                .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
                == Err(1);
        let artifact = if let Some(mut artifacts) = self.artifacts.take() {
            if accepted {
                artifacts.retain();
                Ok(())
            } else {
                artifacts.abort()
            }
        } else {
            Ok(())
        };
        if let Ok(mut metrics) = self.metrics_sink.lock() {
            *metrics = Some(self.metrics.clone());
        }
        source?;
        fence?;
        tracking?;
        artifact
    }
}

pub(crate) struct Start {
    pub(crate) store: ControlStore,
    pub(crate) data: notarium_core::epoch::DataRoot,
    pub(crate) backup: BackupId,
    pub(crate) keys: Vec<KeyringWitness>,
    pub(crate) witness: BackupWitness,
    pub(crate) session: Arc<Session>,
    pub(crate) slot: OwnedSemaphorePermit,
    pub(crate) metrics: Arc<Mutex<Option<BackupMetrics>>>,
}
pub(crate) async fn launch(start: Start) -> Result<Client, PortError> {
    let (commands, mut receiver) = mpsc::channel(8);
    let (ready, wait) = oneshot::channel();
    let session = start.session.clone();
    session.set_commands(&commands)?;
    let owner_session = session.clone();
    let worker = std::thread::Builder::new()
        .name("control-backup".into())
        .spawn(move || {
            // Native handles and PostgreSQL I/O share this owner's lifetime. The
            // caller may shut down its Tokio runtime while cleanup is still pending.
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(_) => {
                    let _ = ready.send(Err(failure()));
                    drop(start.slot);
                    owner_session.finished(Err(failure()));
                    return;
                }
            };
            let mut worker = Worker {
                metrics: BackupMetrics {
                    backup: start.backup.clone(),
                    prepare: Duration::ZERO,
                    drain: Duration::ZERO,
                    pause: Duration::ZERO,
                    spool: Duration::ZERO,
                    bytes: 0,
                },
                store: start.store,
                data: start.data,
                backup: start.backup,
                keys: start.keys,
                witness: start.witness,
                session: owner_session.clone(),
                source: None,
                artifacts: None,
                artifact: None,
                path: None,
                local_pause: None,
                file_pause: None,
                phase: Phase::Prepared,
                pause_started: None,
                metrics_sink: start.metrics,
                _slot: start.slot,
            };
            let watch_session = owner_session.clone();
            let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                runtime.block_on(async {
                    let watch = tokio::spawn(watch_session.watch_background());
                    match worker.prepare().await {
                        Ok(()) => {
                            if ready.send(Ok(())).is_ok() {
                                let _ = worker.run(&mut receiver).await;
                            }
                        }
                        Err(error) => {
                            let _ = ready.send(Err(error));
                        }
                    }
                    watch.abort();
                })
            }));
            owner_session.disarm_interrupts();
            let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                runtime.block_on(worker.cleanup())
            }))
            .unwrap_or_else(|_| Err(failure()));
            drop(worker);
            drop(runtime);
            owner_session.finished(if run.is_err() {
                Err(failure())
            } else {
                cleanup
            });
        })
        .map_err(|_| failure())?;
    session.set_worker(worker)?;
    let result = session
        .operation
        .run(
            async { wait.await.map_err(|_| failure())? },
            CommitEffect::NotCommitted,
        )
        .await;
    if let Err(error) = result {
        session.cancel();
        session.closed().await?;
        return Err(error);
    }
    Ok(Client { session, commands })
}
