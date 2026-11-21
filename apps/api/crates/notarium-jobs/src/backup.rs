use std::{
    fs::{File, OpenOptions},
    future::Future,
    io::{BufWriter, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use bytes::Bytes;
pub use notarium_canonical::backup::PairedPause;
use notarium_canonical::{
    CanonicalStore,
    backup::{BackupPreparation, PairedBackupCut, PostgresSpoolValue, scan_postgres_spool_v1},
    codec,
};
use notarium_control::backup::ControlBackup;
use notarium_core::{
    DomainError,
    error::{BudgetKind, PortError, ValidationReason},
    ids::{BackupId, ContentDigest, SpaceId},
    model::HistoryScope,
    ports::{
        BackupArtifactKind, BackupHold, BackupParticipantPort, CallBudget, Cancellation,
        MaintenanceContext, PreparedBackup, ServicePurpose, TemporaryBackupSpool,
    },
    receipt::ChangeCursor,
};
use tokio::sync::{Semaphore, SemaphorePermit, mpsc, oneshot};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{
    backup_format::{
        CANONICAL, CAS_DATA, CAS_INDEX, CAS_INDEX_MAGIC, CONTROL, CasRecord, MANIFEST, Manifest,
        Payload, WorkDirectory, check_history_count, copy_hash, invalid, io_error, measure_file,
    },
    export::{LimitedFile, zip_error},
    import::check_cancelled,
    sqlite_range::{sql_error, with_database},
};

#[derive(Clone, Debug)]
pub struct BackupOptions {
    pub max_archive_bytes: u64,
    pub max_index_records: u64,
    pub max_pg_row_bytes: u64,
    pub sqlite_verifier: crate::SqliteVerifier,
}

impl Default for BackupOptions {
    fn default() -> Self {
        Self {
            max_archive_bytes: 64 * 1024 * 1024 * 1024,
            max_index_records: 20_000_000,
            max_pg_row_bytes: 32 * 1024 * 1024,
            sqlite_verifier: crate::SqliteVerifier::default(),
        }
    }
}

impl BackupOptions {
    pub(crate) fn validate(&self) -> Result<(), PortError> {
        let hard = Self::default();
        if self.max_archive_bytes == 0
            || self.max_archive_bytes > hard.max_archive_bytes
            || self.max_index_records == 0
            || self.max_index_records > hard.max_index_records
            || self.max_pg_row_bytes == 0
            || self.max_pg_row_bytes > hard.max_pg_row_bytes
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct BackupArchive {
    pub id: BackupId,
    pub path: PathBuf,
    pub bytes: u64,
    pub digest: ContentDigest,
    pub pause: PairedPause,
}

pub(crate) struct Pair {
    pub(crate) id: BackupId,
    pub(crate) control: File,
    pub(crate) canonical: File,
    pub(crate) control_spool: TemporaryBackupSpool,
    pub(crate) canonical_spool: TemporaryBackupSpool,
    pub(crate) pause: PairedPause,
    pub(crate) workers: BackupWorkers,
    control_hold: Box<dyn BackupHold>,
    canonical_hold: Box<dyn BackupHold>,
}

// Each admitted backup can run its scanner and writer together. Their native
// work does not consume the caller's blocking pool or the external-source slots.
static BACKUP_SLOTS: Semaphore = Semaphore::const_new(4);

pub(crate) struct BackupWorkers(Arc<SemaphorePermit<'static>>);

pub(crate) struct BackupWorker<T>(oneshot::Receiver<Result<T, PortError>>);

impl BackupWorkers {
    fn reserve() -> Result<Self, PortError> {
        let slot = BACKUP_SLOTS
            .try_acquire()
            .map_err(|_| DomainError::RateLimited {
                retry_after_ms: 1_000,
                budget: BudgetKind::Concurrency,
            })?;
        Ok(Self(Arc::new(slot)))
    }

    pub(crate) fn spawn<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T, PortError> + Send + 'static,
    ) -> Result<BackupWorker<T>, PortError> {
        let slot = Arc::clone(&self.0);
        let (reply, result) = oneshot::channel();
        let worker = std::thread::Builder::new()
            .name("notarium-backup-io".into())
            .spawn(move || {
                let _slot = slot;
                let _ = reply.send(work());
            })
            .map_err(io_error)?;
        drop(worker);
        Ok(BackupWorker(result))
    }
}

impl<T> BackupWorker<T> {
    pub(crate) async fn wait(self, cancellation: &Cancellation) -> Result<T, PortError> {
        crate::maintenance::wait_for_io(cancellation, async {
            self.0
                .await
                .map_err(|err| codec::internal_not_committed("backup_io_worker", err.to_string()))?
        })
        .await
    }
}

impl Pair {
    fn scan_references(
        &self,
        options: BackupOptions,
        cancellation: Cancellation,
        references: mpsc::Sender<(SpaceId, ContentDigest)>,
    ) -> Result<BackupWorker<()>, PortError> {
        let spool = self.canonical_spool.clone();
        self.workers.spawn(move || {
            snapshot_references(
                spool.path(),
                spool.receipt().kind,
                spool.receipt().bytes,
                options,
                references,
                &cancellation,
            )
        })
    }

    pub(crate) async fn release(self) -> Result<(), PortError> {
        let (control, canonical) =
            tokio::join!(self.control_hold.release(), self.canonical_hold.release());
        control?;
        canonical
    }
}

/// Capture a paired database cut, release the writer pause, then copy stable
/// spools and held CAS to an atomically published ZIP64 archive.
pub async fn run_backup(
    ctx: MaintenanceContext,
    canonical: &CanonicalStore,
    control: &ControlBackup,
    destination: &Path,
    options: BackupOptions,
) -> Result<BackupArchive, PortError> {
    ctx.authority.require(ServicePurpose::Backup)?;
    options.validate()?;
    if destination.file_name().is_none() || std::fs::symlink_metadata(destination).is_ok() {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    crate::maintenance::bounded(ctx, "paired_backup", |ctx| {
        run_backup_inner(ctx, canonical, control, destination, options)
    })
    .await
}

async fn run_backup_inner(
    ctx: MaintenanceContext,
    canonical: &CanonicalStore,
    control: &ControlBackup,
    destination: &Path,
    options: BackupOptions,
) -> Result<BackupArchive, PortError> {
    let started = Instant::now();
    let work = WorkDirectory::sibling(
        destination,
        canonical.installation_id(),
        &ctx.budget.cancellation,
    )?;
    let mut pair = capture_pair(ctx.clone(), canonical, control).await?;
    let mut budget = ctx.budget;
    budget.remaining = budget.remaining.saturating_sub(started.elapsed());
    let archive = async {
        let cas = pack_cas(canonical, &budget, &mut pair, &work, options.clone()).await?;
        let manifest = Manifest {
            version: 1,
            installation: pair.canonical_spool.receipt().witness.installation.clone(),
            backend: pair.canonical_spool.receipt().kind,
            control: Payload {
                bytes: pair.control_spool.receipt().bytes,
                digest: pair.control_spool.receipt().digest,
            },
            canonical: Payload {
                bytes: pair.canonical_spool.receipt().bytes,
                digest: pair.canonical_spool.receipt().digest,
            },
            index: cas.0,
            cas: cas.1,
        };
        let size = [
            manifest.control,
            manifest.canonical,
            manifest.index,
            manifest.cas,
        ]
        .into_iter()
        .try_fold(0_u64, |bytes, payload| bytes.checked_add(payload.bytes))
        .filter(|size| *size <= options.max_archive_bytes);
        if size.is_none() {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let mut control_input = pair.control.try_clone().map_err(io_error)?;
        let mut canonical_input = pair.canonical.try_clone().map_err(io_error)?;
        let spools = (pair.control_spool.clone(), pair.canonical_spool.clone());
        let cancellation = budget.cancellation.clone();
        let files = work.clone();
        pair.workers
            .spawn(move || {
                let _spools = spools;
                check_cancelled(&cancellation)?;
                let mut index = File::open(files.path("cas.index")).map_err(io_error)?;
                let mut data = File::open(files.path("cas.data")).map_err(io_error)?;
                let mut archive = new_file(&files.path("backup.zip"))?;
                let mut zip = ZipWriter::new(LimitedFile::new(
                    archive.try_clone().map_err(io_error)?,
                    options.max_archive_bytes,
                ));
                let opts = SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Stored)
                    .large_file(true);
                zip.start_file(MANIFEST, opts).map_err(zip_error)?;
                serde_json::to_writer(&mut zip, &manifest).map_err(|err| {
                    codec::internal_not_committed("backup_manifest", err.to_string())
                })?;
                for (name, payload, source) in [
                    (CONTROL, manifest.control, &mut control_input),
                    (CANONICAL, manifest.canonical, &mut canonical_input),
                    (CAS_INDEX, manifest.index, &mut index),
                    (CAS_DATA, manifest.cas, &mut data),
                ] {
                    source.seek(SeekFrom::Start(0)).map_err(io_error)?;
                    zip.start_file(name, opts).map_err(zip_error)?;
                    if copy_hash(source, &mut zip, payload.bytes, &cancellation)? != payload {
                        return Err(invalid(ValidationReason::InvalidDigest));
                    }
                }
                zip.finish()
                    .map_err(zip_error)?
                    .file
                    .sync_all()
                    .map_err(io_error)?;
                measure_file(&mut archive, options.max_archive_bytes, &cancellation)
            })?
            .wait(&budget.cancellation)
            .await
    }
    .await;
    let id = pair.id.clone();
    let pause = pair.pause;
    // Await both release acknowledgements, including failures during copy.
    let released = pair.release().await;
    let digest = archive?;
    released?;
    check_cancelled(&budget.cancellation)?;
    work.publish("backup.zip", destination)?;
    Ok(BackupArchive {
        id,
        path: destination.to_owned(),
        bytes: digest.bytes,
        digest: digest.digest,
        pause,
    })
}

pub(crate) async fn capture_pair(
    mut ctx: MaintenanceContext,
    canonical: &CanonicalStore,
    control: &ControlBackup,
) -> Result<Pair, PortError> {
    let started = Instant::now();
    check_cancelled(&ctx.budget.cancellation)?;
    let workers = BackupWorkers::reserve()?;
    let id = BackupId::from_bytes(codec::ordered_id_16()?);
    let mut cb = control.default_budget();
    let mut nb = canonical.default_backup_budget();
    cb.deadline = cb.deadline.min(ctx.budget.remaining);
    nb.deadline = nb.deadline.min(ctx.budget.remaining);
    let cancel = ctx.budget.cancellation.clone();
    let preparations = join_phases(
        &cancel,
        control.prepare(ctx.clone(), id.clone(), cb),
        canonical.prepare_paired_backup(ctx.clone(), id.clone(), nb),
    )
    .await;
    let (mut ctrl, mut canon) =
        acknowledge_pair(preparations, |p| p.abort(), |p| p.abort()).await?;
    let holds = join_phases(&cancel, ctrl.acquire_hold(), canon.acquire_hold()).await;
    let (control_hold, canonical_hold) =
        match acknowledge_pair(holds, |hold| hold.release(), |hold| hold.release()).await {
            Ok(holds) => holds,
            Err(error) => {
                let _ = tokio::join!(ctrl.abort(), canon.abort());
                return Err(error);
            }
        };
    let held_histories = &canonical_hold.witness().histories;
    ctx.budget.remaining = cb
        .deadline
        .min(nb.deadline)
        .saturating_sub(started.elapsed());
    let captured = async {
        let (control_spool, canonical_spool, pause) =
            capture_spools(&ctx, canonical, ctrl, &mut canon, held_histories, cb, nb).await?;
        if control_spool.receipt().kind != canonical_spool.receipt().kind
            || control_spool.receipt().witness.installation
                != canonical_spool.receipt().witness.installation
        {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        let cancellation = ctx.budget.cancellation.clone();
        workers
            .spawn(move || {
                let control_file = open_temporary_spool(&control_spool, &cancellation)?;
                let canonical_file = open_temporary_spool(&canonical_spool, &cancellation)?;
                Ok((
                    control_file,
                    canonical_file,
                    control_spool,
                    canonical_spool,
                    pause,
                ))
            })?
            .wait(&ctx.budget.cancellation)
            .await
    }
    .await;
    let (control_file, canonical_file, control_spool, canonical_spool, pause) = match captured {
        Ok(pair) => pair,
        Err(error) => {
            let _ = tokio::join!(
                canon.abort(),
                control_hold.release(),
                canonical_hold.release(),
            );
            return Err(error);
        }
    };
    Ok(Pair {
        id,
        control: control_file,
        canonical: canonical_file,
        control_spool,
        canonical_spool,
        pause,
        workers,
        control_hold,
        canonical_hold,
    })
}

fn open_temporary_spool(
    spool: &TemporaryBackupSpool,
    cancellation: &Cancellation,
) -> Result<File, PortError> {
    check_cancelled(cancellation)?;
    let receipt = spool.receipt();
    let expected = Payload {
        bytes: receipt.bytes,
        digest: receipt.digest,
    };
    if !spool.path().symlink_metadata().map_err(io_error)?.is_file() {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let mut file = File::open(spool.path()).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file()
        || metadata.len() != receipt.bytes
        || measure_file(&mut file, receipt.bytes, cancellation)? != expected
    {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(file)
}

async fn join_phases<L, R>(
    cancellation: &Cancellation,
    left: impl Future<Output = Result<L, PortError>>,
    right: impl Future<Output = Result<R, PortError>>,
) -> (Result<L, PortError>, Result<R, PortError>) {
    async fn observe<T>(
        cancellation: &Cancellation,
        phase: impl Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        let result = phase.await;
        if result.is_err() {
            cancellation.cancel();
        }
        result
    }
    tokio::join!(observe(cancellation, left), observe(cancellation, right))
}

async fn acknowledge_pair<L, R, LF, RF>(
    pair: (Result<L, PortError>, Result<R, PortError>),
    close_left: impl FnOnce(L) -> LF,
    close_right: impl FnOnce(R) -> RF,
) -> Result<(L, R), PortError>
where
    LF: Future<Output = Result<(), PortError>>,
    RF: Future<Output = Result<(), PortError>>,
{
    match pair {
        (Ok(left), Ok(right)) => Ok((left, right)),
        (Err(error), Ok(right)) => {
            let _ = close_right(right).await;
            Err(error)
        }
        (Ok(left), Err(error)) => {
            let _ = close_left(left).await;
            Err(error)
        }
        (Err(PortError::Cancelled(_)), Err(error)) | (Err(error), Err(_)) => Err(error),
    }
}

async fn capture_spools(
    ctx: &MaintenanceContext,
    canonical: &CanonicalStore,
    ctrl: Box<dyn PreparedBackup>,
    canon: &mut BackupPreparation,
    held_histories: &[ChangeCursor],
    cb: notarium_core::ports::BackupBudget,
    nb: notarium_core::ports::BackupBudget,
) -> Result<(TemporaryBackupSpool, TemporaryBackupSpool, PairedPause), PortError> {
    let PairedBackupCut {
        control: mut control_cut,
        canonical: mut canonical_cut,
        pause,
    } = canon.capture_paired(ctrl, ctx.budget.clone()).await?;
    let result = async {
        check_history_count(canonical_cut.witness().histories.len())?;
        if control_cut.witness().installation != *canonical.installation_id()
            || canonical_cut.witness().installation != *canonical.installation_id()
            || !control_cut.witness().histories.is_empty()
            || control_cut.witness().canaries.is_empty()
            || !control_cut
                .witness()
                .canaries
                .iter()
                .all(|key| key.readable)
            || !held_histories.iter().map(|c| &c.scope).eq(canonical_cut
                .witness()
                .histories
                .iter()
                .map(|c| &c.scope))
        {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        let spools = join_phases(
            &ctx.budget.cancellation,
            control_cut.spool_temporary(cb, ctx.budget.cancellation.clone()),
            canonical_cut.spool_temporary(nb, ctx.budget.cancellation.clone()),
        )
        .await;
        let (control_spool, canonical_spool) = acknowledge_pair(
            spools,
            |_| std::future::ready(Ok(())),
            |_| std::future::ready(Ok(())),
        )
        .await?;
        Ok::<_, PortError>((control_spool, canonical_spool, pause))
    }
    .await;
    let (control_close, canonical_close) = tokio::join!(control_cut.close(), canonical_cut.close());
    let spools = result?;
    control_close?;
    canonical_close?;
    Ok(spools)
}

struct CasInput {
    scope: HistoryScope,
    digest: ContentDigest,
    bytes: mpsc::Receiver<Bytes>,
}

async fn pack_cas(
    canonical: &CanonicalStore,
    budget: &CallBudget,
    pair: &mut Pair,
    work: &WorkDirectory,
    options: BackupOptions,
) -> Result<(Payload, Payload), PortError> {
    let (references, mut ref_rx) = mpsc::channel(16);
    let reader = pair.scan_references(options.clone(), budget.cancellation.clone(), references)?;
    let (cas_tx, cas_rx) = mpsc::channel(1);
    let writer = pair.workers.spawn({
        let files = work.clone();
        let cancellation = budget.cancellation.clone();
        move || {
            write_cas(
                &files.path("cas.index"),
                &files.path("cas.data"),
                cas_rx,
                options,
                &cancellation,
            )
        }
    })?;
    let histories = &pair.canonical_spool.receipt().witness.histories;
    let produce = async {
        while let Some((space, digest)) = ref_rx.recv().await {
            check_cancelled(&budget.cancellation)?;
            let scope = history_for(histories, &space)?;
            let (raw, bytes) = mpsc::channel(2);
            if cas_tx
                .send(CasInput {
                    scope: scope.clone(),
                    digest,
                    bytes,
                })
                .await
                .is_err()
            {
                break;
            }
            let streamed = canonical
                .stream_held_blob(budget, &pair.id, scope, digest, &raw)
                .await;
            if raw.is_closed() && matches!(streamed, Err(PortError::Cancelled(_))) {
                // The packer stopped reading this blob. Collect its underlying error below.
                break;
            }
            streamed?;
        }
        Ok::<_, PortError>(())
    };
    let produce = crate::maintenance::wait_for_io(&budget.cancellation, produce).await;
    drop(cas_tx);
    drop(ref_rx);
    produce?;
    let packed = writer.wait(&budget.cancellation).await?;
    reader.wait(&budget.cancellation).await?;
    Ok(packed)
}

pub(crate) async fn verify_live_cas(
    canonical: &CanonicalStore,
    budget: &CallBudget,
    pair: &mut Pair,
    options: BackupOptions,
) -> Result<(u64, u64), PortError> {
    let (references, mut rx) = mpsc::channel(16);
    let reader = pair.scan_references(options.clone(), budget.cancellation.clone(), references)?;
    let history = &pair.canonical_spool.receipt().witness.histories;
    let verify = async {
        let mut summary = (0_u64, 0_u64);
        while let Some((space, digest)) = rx.recv().await {
            check_cancelled(&budget.cancellation)?;
            let scope = history_for(history, &space)?;
            let (sender, mut body) = mpsc::channel(2);
            let stream = async {
                let result = canonical
                    .stream_held_blob(budget, &pair.id, scope, digest, &sender)
                    .await;
                drop(sender);
                result
            };
            let discard = async { while body.recv().await.is_some() {} };
            let (verified, ()) = tokio::join!(stream, discard);
            summary.0 += 1;
            summary.1 = summary
                .1
                .checked_add(verified?)
                .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
            if summary.0 > options.max_index_records {
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
        }
        Ok(summary)
    };
    let verify = crate::maintenance::wait_for_io(&budget.cancellation, verify).await;
    drop(rx);
    let verified = verify?;
    reader.wait(&budget.cancellation).await?;
    Ok(verified)
}

fn snapshot_references(
    path: &Path,
    kind: BackupArtifactKind,
    bytes: u64,
    options: BackupOptions,
    output: mpsc::Sender<(SpaceId, ContentDigest)>,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    check_cancelled(cancellation)?;
    let push = |space: &str, digest: &[u8]| -> Result<(), PortError> {
        check_cancelled(cancellation)?;
        let space = SpaceId::parse(space)?;
        let digest = ContentDigest::from_bytes(
            digest
                .try_into()
                .map_err(|_| invalid(ValidationReason::InvalidDigest))?,
        );
        output
            .blocking_send((space, digest))
            .map_err(|_| invalid(ValidationReason::InvalidState))
    };
    match kind {
        BackupArtifactKind::SqliteSnapshotV1 => with_database(
            File::open(path).map_err(io_error)?,
            bytes,
            cancellation,
            |db| {
                let verified = crate::fsck::verify_sqlite_references(db, None, cancellation);
                check_cancelled(cancellation)?;
                verified?;
                let mut query = db
                    .prepare(
                        "SELECT DISTINCT space_id,content_blake3 FROM blob_references
                 ORDER BY space_id,content_blake3",
                    )
                    .map_err(sql_error)?;
                let mut rows = query.query([]).map_err(sql_error)?;
                while let Some(row) = rows.next().map_err(sql_error)? {
                    let space: String = row.get(0).map_err(sql_error)?;
                    let digest: Vec<u8> = row.get(1).map_err(sql_error)?;
                    push(&space, &digest)?;
                }
                Ok(())
            },
        )?,
        BackupArtifactKind::PostgresSpoolV1 => {
            let mut checks = crate::db_integrity::PgRowChecks::new(true)?;
            crate::db_integrity::Relations::new(true)?.verify(cancellation, |keys| {
                scan_postgres_spool_v1(
                    File::open(path).map_err(io_error)?,
                    bytes,
                    options.max_archive_bytes,
                    options.max_pg_row_bytes,
                    |table, row| {
                        check_cancelled(cancellation)?;
                        checks.check(table, row, Some(keys))?;
                        keys.canonical(table, row)
                    },
                )?;
                Ok(())
            })?;
            scan_postgres_spool_v1(
                File::open(path).map_err(io_error)?,
                bytes,
                options.max_archive_bytes,
                options.max_pg_row_bytes,
                |table, row| {
                    check_cancelled(cancellation)?;
                    checks.check(table, row, None)?;
                    if table.name == "blob_catalog" {
                        let [
                            PostgresSpoolValue::Text(space),
                            PostgresSpoolValue::Bytes(digest),
                            _,
                            _,
                            PostgresSpoolValue::Int(references),
                            ..,
                        ] = row
                        else {
                            return Err(invalid(ValidationReason::InvalidState));
                        };
                        if *references > 0 {
                            push(space, digest)?;
                        }
                    }
                    Ok(())
                },
            )?;
        }
    }
    Ok(())
}

fn history_for<'a>(
    histories: &'a [ChangeCursor],
    space: &SpaceId,
) -> Result<&'a HistoryScope, PortError> {
    histories
        .binary_search_by(|entry| entry.scope.space_id.cmp(space))
        .ok()
        .map(|index| &histories[index].scope)
        .ok_or_else(|| DomainError::ResourceNotFound.into())
}

fn write_cas(
    index_path: &Path,
    data_path: &Path,
    mut input: mpsc::Receiver<CasInput>,
    options: BackupOptions,
    cancellation: &Cancellation,
) -> Result<(Payload, Payload), PortError> {
    check_cancelled(cancellation)?;
    let mut index = BufWriter::new(new_file(index_path)?);
    let mut data = BufWriter::new(LimitedFile::new(
        new_file(data_path)?,
        options.max_archive_bytes,
    ));
    index.write_all(CAS_INDEX_MAGIC).map_err(io_error)?;
    index.write_all(&0_u64.to_be_bytes()).map_err(io_error)?;
    let mut entries = 0_u64;
    let mut raw_left = crate::backup_format::raw_cas_limit(options.max_archive_bytes);
    let mut previous = None;
    while let Some(mut item) = input.blocking_recv() {
        check_cancelled(cancellation)?;
        let key = (item.scope.space_id.clone(), item.digest);
        if previous.as_ref().is_some_and(|previous| previous >= &key) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if entries >= options.max_index_records {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let offset = data.stream_position().map_err(io_error)?;
        let (raw, hash) = compress_blob(&mut data, &mut item.bytes, raw_left, cancellation)?;
        raw_left -= raw;
        if hash != item.digest {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        let compressed = data.stream_position().map_err(io_error)? - offset;
        CasRecord {
            space: item.scope.space_id,
            digest: item.digest,
            offset,
            compressed,
            raw,
        }
        .write(&mut index)?;
        entries += 1;
        previous = Some(key);
    }
    check_cancelled(cancellation)?;
    index
        .seek(SeekFrom::Start(CAS_INDEX_MAGIC.len() as u64))
        .map_err(io_error)?;
    index.write_all(&entries.to_be_bytes()).map_err(io_error)?;
    index.flush().map_err(io_error)?;
    data.flush().map_err(io_error)?;
    let mut index = index
        .into_inner()
        .map_err(|err| io_error(err.into_error()))?;
    let mut data = data
        .into_inner()
        .map_err(|err| io_error(err.into_error()))?
        .file;
    Ok((
        measure_file(&mut index, options.max_archive_bytes, cancellation)?,
        measure_file(&mut data, options.max_archive_bytes, cancellation)?,
    ))
}

fn compress_blob(
    output: &mut impl Write,
    bytes: &mut mpsc::Receiver<Bytes>,
    limit: u64,
    cancellation: &Cancellation,
) -> Result<(u64, ContentDigest), PortError> {
    let mut writer = zstd::stream::write::Encoder::new(output, 3).map_err(io_error)?;
    let mut raw = 0_u64;
    let mut hash = blake3::Hasher::new();
    while let Some(chunk) = bytes.blocking_recv() {
        check_cancelled(cancellation)?;
        raw = raw
            .checked_add(chunk.len() as u64)
            .filter(|size| *size <= limit)
            .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
        hash.update(&chunk);
        writer.write_all(&chunk).map_err(io_error)?;
    }
    writer.finish().map_err(io_error)?;
    Ok((raw, ContentDigest::from_bytes(*hash.finalize().as_bytes())))
}

fn new_file(path: &Path) -> Result<File, PortError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map_err(io_error)
}

#[cfg(test)]
mod phase_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_cancelled_waiter_leaves_capacity_and_the_lease_with_its_worker() {
        static CAPACITY: Semaphore = Semaphore::const_new(1);
        let workers = BackupWorkers(Arc::new(CAPACITY.try_acquire().unwrap()));
        let lease = Arc::new(());
        let (started, observed) = oneshot::channel();
        let (release, gate) = std::sync::mpsc::channel();
        let worker = workers
            .spawn({
                let lease = Arc::clone(&lease);
                move || {
                    let _lease = lease;
                    started.send(()).unwrap();
                    let _ = gate.recv();
                    Ok(())
                }
            })
            .unwrap();
        observed.await.unwrap();
        drop(workers);
        let cancellation = Cancellation::default();
        cancellation.cancel();
        assert!(matches!(
            worker.wait(&cancellation).await,
            Err(PortError::Cancelled(_))
        ));
        assert!(CAPACITY.try_acquire().is_err());
        assert_eq!(Arc::strong_count(&lease), 2);
        release.send(()).unwrap();
        let _recovered = tokio::time::timeout(Duration::from_secs(2), CAPACITY.acquire())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(Arc::strong_count(&lease), 1);
    }

    #[tokio::test]
    async fn failed_participant_waits_for_the_other_phase_to_settle() {
        let cancellation = Cancellation::default();
        let error = invalid(ValidationReason::InvalidState);
        let pair = join_phases(
            &cancellation,
            async { Err::<(), _>(error.clone()) },
            async {
                cancellation.cancelled().await;
                Ok(())
            },
        )
        .await;
        let mut closed = false;
        let closed_flag = &mut closed;
        let result = acknowledge_pair(
            pair,
            |()| async { Ok(()) },
            |()| async move {
                tokio::task::yield_now().await;
                *closed_flag = true;
                Ok(())
            },
        )
        .await;
        assert_eq!(result, Err(error));
        assert!(closed);
    }

    #[tokio::test]
    async fn peer_cancellation_preserves_the_spool_failure() {
        let cancellation = Cancellation::default();
        let failure = codec::unavailable_retryable(
            "canonical_spool_failed",
            "lost backup hold",
            Duration::from_millis(10),
        );
        let phases = join_phases(
            &cancellation,
            async {
                cancellation.cancelled().await;
                check_cancelled(&cancellation)
            },
            async { Err::<(), _>(failure.clone()) },
        )
        .await;
        let result = acknowledge_pair(
            phases,
            |_| std::future::ready(Ok(())),
            |_| std::future::ready(Ok(())),
        )
        .await;
        assert_eq!(result, Err(failure));
    }
}
