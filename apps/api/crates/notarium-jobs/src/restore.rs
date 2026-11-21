use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions as CapOpenOptions},
};
use notarium_canonical::{CanonicalConfig, CanonicalRuntime, codec};
use notarium_control::{
    backup::{BackupConfig, ControlBackup},
    keyring::{Keyring, KeyringLocation},
    store::ControlStore,
};
use notarium_core::{
    DomainError,
    epoch::{DataRoot, EpochManifestV1, ReadyState, SUPPORTED_V1_EPOCH},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, HistoryIncarnation, InstallationId},
    ports::{
        BackupArtifactKind, BackupParticipantPort, CallBudget, MaintenanceContext, ServicePurpose,
    },
    receipt::ChangeCursor,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::{
    ArchiveInput, BackupOptions,
    backup_format::{CasRecord, MAX_BACKUP_METADATA_JSON_BYTES, copy_hash, invalid, io_error},
    fsck::{VerifiedArchive, verify_archive},
    import::check_cancelled,
    sqlite_range::sql_error,
};

const LOCAL_MANIFEST: &str = "v1-epoch.json";
const GUARD_LENGTH: usize = 64;

#[derive(Clone, Debug)]
pub enum RestoreKeyring {
    External(PathBuf),
    ProvisionDefault { separately_saved: PathBuf },
}

impl RestoreKeyring {
    fn source(&self) -> &Path {
        match self {
            Self::External(path)
            | Self::ProvisionDefault {
                separately_saved: path,
            } => path,
        }
    }

    fn is_provisioned(&self) -> bool {
        matches!(self, Self::ProvisionDefault { .. })
    }
}

#[derive(Clone, Debug)]
pub enum RestoreTarget {
    Local {
        root: DataRoot,
        keyring: RestoreKeyring,
    },
    Cloud(Box<CloudRestoreTarget>),
}

#[derive(Clone, Debug)]
pub struct RestoreReport {
    pub installation: InstallationId,
    pub archive_digest: ContentDigest,
    pub histories: Vec<ChangeCursor>,
}

/// Verify the entire archive and external keys before creating a target
/// generation. Only an offline maintenance authority can publish it.
pub async fn run_restore(
    ctx: MaintenanceContext,
    input: ArchiveInput,
    target: RestoreTarget,
    options: BackupOptions,
) -> Result<RestoreReport, PortError> {
    ctx.authority.require(ServicePurpose::Restore)?;
    options.validate()?;
    crate::maintenance::bounded(ctx, "archive_restore", |ctx| {
        run_restore_inner(ctx, input, target, options)
    })
    .await
}

async fn run_restore_inner(
    ctx: MaintenanceContext,
    input: ArchiveInput,
    target: RestoreTarget,
    options: BackupOptions,
) -> Result<RestoreReport, PortError> {
    let verification_keys = match &target {
        RestoreTarget::Local { keyring, .. } => keyring.source().to_owned(),
        RestoreTarget::Cloud(target) => target.external_keyring.clone(),
    };
    let budget = ctx.budget.clone();
    let verified = crate::maintenance::read_source(&ctx.budget.cancellation, {
        let options = options.clone();
        move || verify_archive(input, &verification_keys, &budget, options)
    })
    .await?;
    check_cancelled(&ctx.budget.cancellation)?;
    match target {
        RestoreTarget::Local { root, keyring }
            if verified.manifest.backend == BackupArtifactKind::SqliteSnapshotV1 =>
        {
            restore_local(ctx, root, keyring, verified).await
        }
        RestoreTarget::Cloud(target)
            if verified.manifest.backend == BackupArtifactKind::PostgresSpoolV1 =>
        {
            cloud::restore(ctx, *target, verified, options).await
        }
        _ => Err(invalid(ValidationReason::ScopeMismatch)),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    installation: InstallationId,
    digest: ContentDigest,
    existing: Option<Identity>,
    external_keyring: bool,
    histories: Vec<ChangeCursor>,
    stage: String,
    phase: Phase,
    #[serde(default)]
    published_manifest: Option<Identity>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "name", deny_unknown_fields)]
enum Phase {
    Build {
        directory: Option<Identity>,
    },
    Install {
        directory: Identity,
        components: Vec<(String, Identity)>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct Identity {
    device: u64,
    inode: u64,
}

async fn restore_local(
    ctx: MaintenanceContext,
    root: DataRoot,
    keyring: RestoreKeyring,
    verified: VerifiedArchive,
) -> Result<RestoreReport, PortError> {
    if !cfg!(any(
        target_os = "linux",
        target_os = "android",
        target_vendor = "apple",
        target_os = "redox"
    )) {
        return Err(invalid(ValidationReason::UnsupportedContainer));
    }
    let digest = verified
        .report
        .archive_digest
        .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?;
    let parent_path = root
        .root()
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent_path).map_err(io_error)?;
    let target_name = root
        .root()
        .file_name()
        .ok_or_else(|| invalid(ValidationReason::InvalidPathComponent))?;
    let root = DataRoot::new(parent.join(target_name));
    if keyring.source().starts_with(root.root()) {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    let lock_key = blake3::hash(target_name.as_encoded_bytes());
    let journal_path = parent.join(format!(".notarium-restore-{lock_key}.json"));
    let lock = acquire_lock(&parent.join(format!(".notarium-restore-{lock_key}.lock")))?;
    let mut journal = if exists(&journal_path)? {
        let journal = read_journal(&journal_path)?;
        if journal.version != 1
            || journal.digest != digest
            || journal.installation != verified.report.installation
            || journal.external_keyring == keyring.is_provisioned()
            || !same_cuts(&journal.histories, &verified.histories)
            || !valid_stage(&journal.stage)
        {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        journal
    } else {
        let existing = directory_identity(root.root())?;
        if existing.is_some()
            && fs::read_dir(root.root())
                .map_err(io_error)?
                .next()
                .is_some()
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let mut histories = verified.histories.clone();
        for cursor in &mut histories {
            cursor.scope.incarnation = HistoryIncarnation::from_bytes(codec::csprng_16()?);
        }
        let journal = Journal {
            version: 1,
            installation: verified.report.installation.clone(),
            digest,
            existing,
            external_keyring: !keyring.is_provisioned(),
            histories,
            stage: codec::new_prefixed_hex_id(".notarium-restore-generation-")?,
            phase: Phase::Build { directory: None },
            published_manifest: None,
        };
        save_journal(&journal_path, &journal)?;
        journal
    };

    if let Phase::Build { directory } = journal.phase {
        check_cancelled(&ctx.budget.cancellation)?;
        require_empty_target(&root, journal.existing)?;
        let stage = DataRoot::new(parent.join(&journal.stage));
        discard_interrupted_stage(stage.root(), directory)?;
        journal.phase = Phase::Build { directory: None };
        save_journal(&journal_path, &journal)?;
        private_dir(stage.root())?;
        sync_dir(stage.root())?;
        sync_dir(&parent)?;
        let identity = directory_identity(stage.root())?
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        journal.phase = Phase::Build {
            directory: Some(identity),
        };
        save_journal(&journal_path, &journal)?;
        let work = stage.clone();
        let keys = keyring.clone();
        let budget = ctx.budget.clone();
        let worker_lock = lock.try_clone().map_err(io_error)?;
        crate::maintenance::read_source(&ctx.budget.cancellation, move || {
            let _lock = worker_lock;
            materialize_local(&verified, &work, &keys, &budget)
        })
        .await?;
        rebind_local(&stage, &journal, &keyring, &ctx).await?;
        write_new(&stage.manifest(), &epoch_manifest(&journal.installation)?)?;
        if journal.existing.is_some() {
            write_new(&stage.restore_guard(), journal.digest.to_hex().as_bytes())?;
        }
        sync_dir(stage.root())?;
        verify_installed(&stage, &journal, true)?;
        journal.phase = Phase::Install {
            directory: identity,
            components: ["v1", "blobs", "secret-keyring"]
                .into_iter()
                .filter(|name| *name != "secret-keyring" || keyring.is_provisioned())
                .map(|name| {
                    let id = directory_identity(&stage.root().join(name))?
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                    Ok((name.to_owned(), id))
                })
                .collect::<Result<_, PortError>>()?,
        };
        save_journal(&journal_path, &journal)?;
    }
    check_cancelled(&ctx.budget.cancellation)?;
    if let Some(manifest) = journal.published_manifest {
        if regular_identity(&root.manifest())? != Some(manifest) || exists(&root.restore_guard())? {
            return Err(invalid(ValidationReason::InvalidState));
        }
        require_installed_components(&root, &journal)?;
    } else {
        install_local(&parent, &root, &journal)?;
    }
    verify_installed(&root, &journal, false).map_err(after_local_publication)?;
    if journal.existing.is_some() {
        if journal.published_manifest.is_none() {
            journal.published_manifest =
                Some(regular_identity(&root.manifest())?.ok_or_else(|| {
                    after_local_publication(invalid(ValidationReason::InvalidState))
                })?);
            save_journal(&journal_path, &journal).map_err(after_local_publication)?;
        }
        cleanup_local_stage(&parent, &journal).map_err(after_local_publication)?;
    }
    fs::remove_file(&journal_path).map_err(|err| after_local_publication(io_error(err)))?;
    // Publication and stage cleanup have already been fsynced. A crash may
    // resurrect this last journal entry, whose replay is read-only on the target.
    let _ = sync_dir(&parent);
    Ok(RestoreReport {
        installation: journal.installation,
        archive_digest: digest,
        histories: journal.histories,
    })
}

fn discard_interrupted_stage(path: &Path, recorded: Option<Identity>) -> Result<(), PortError> {
    let (parent, name) = open_parent(path)?;
    if let Some(actual) = directory_identity(path)? {
        match recorded {
            Some(expected) if actual == expected => {
                let dir = parent.open_dir_nofollow(name).map_err(io_error)?;
                let metadata = dir.dir_metadata().map_err(io_error)?;
                if (metadata.dev(), metadata.ino()) != (expected.device, expected.inode) {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                dir.remove_open_dir_all().map_err(io_error)?;
            }
            // An interruption before the first journal fsync can leave the
            // newly created empty directory. No payload was admitted yet.
            None => parent.remove_dir(name).map_err(io_error)?,
            Some(_) => return Err(invalid(ValidationReason::InvalidState)),
        }
    }
    sync_dir(path.parent().expect("private stage has a parent"))?;
    Ok(())
}

fn materialize_local(
    archive: &VerifiedArchive,
    root: &DataRoot,
    keyring: &RestoreKeyring,
    budget: &CallBudget,
) -> Result<(), PortError> {
    private_dir(&root.root().join("v1"))?;
    private_dir(&root.root().join("blobs"))?;
    for (path, expected, mut input) in [
        (
            root.control(),
            archive.manifest.control,
            Box::new(archive.control()?) as Box<dyn Read>,
        ),
        (
            root.canonical(),
            archive.manifest.canonical,
            Box::new(archive.canonical()?) as Box<dyn Read>,
        ),
    ] {
        let mut output = create_file(&path)?;
        if copy_hash(
            &mut input,
            &mut output,
            expected.bytes,
            &budget.cancellation,
        )? != expected
        {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        output.sync_all().map_err(io_error)?;
    }
    let mut canonical = Connection::open(root.canonical()).map_err(sql_error)?;
    let tx = canonical.transaction().map_err(sql_error)?;
    let (records, mut index) = archive.restore_index()?;
    for _ in 0..records {
        check_cancelled(&budget.cancellation)?;
        let record = CasRecord::read(&mut index)?;
        let blob = root.blob(&record.space, record.digest);
        let parent = blob.parent().expect("generated CAS path has parent");
        fs::create_dir_all(parent).map_err(io_error)?;
        let mut file = create_file(&blob)?;
        let mut source = archive.blob(&record)?;
        let compressed = copy_hash(
            &mut source,
            &mut file,
            record.compressed,
            &budget.cancellation,
        )?;
        if compressed.bytes != record.compressed {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        file.sync_all().map_err(io_error)?;
        sync_dir(parent)?;
        // Verify the bytes read a second time before they can become live.
        let mut decoder = zstd::stream::read::Decoder::new(File::open(&blob).map_err(io_error)?)
            .map_err(io_error)?;
        decoder.window_log_max(23).map_err(io_error)?;
        let raw = copy_hash(
            &mut decoder,
            &mut std::io::sink(),
            record.raw,
            &budget.cancellation,
        )?;
        if raw.bytes != record.raw || raw.digest != record.digest {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        let params = rusqlite::params![
            record.compressed as i64,
            record.space.as_str(),
            record.digest.as_bytes().as_slice()
        ];
        tx.execute(
            "UPDATE blob_catalog SET compressed_size=?1 WHERE space_id=?2 AND content_blake3=?3",
            params,
        )
        .map_err(sql_error)?;
        tx.execute("UPDATE blob_publications SET compressed_size=?1 WHERE space_id=?2 AND content_blake3=?3 AND state='active'", params).map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)?;
    canonical.close().map_err(|(_, error)| sql_error(error))?;
    sync_dir(&root.root().join("v1"))?;
    for space in fs::read_dir(root.root().join("blobs")).map_err(io_error)? {
        let space = space.map_err(io_error)?;
        sync_dir(&space.path())?;
    }
    sync_dir(&root.root().join("blobs"))?;
    if let RestoreKeyring::ProvisionDefault { separately_saved } = keyring {
        provision_keys(separately_saved, &root.keyring(), &archive.keys, budget)?;
    }
    sync_dir(root.root())
}

fn provision_keys(
    source: &Path,
    destination: &Path,
    keys: &[notarium_core::ports::KeyCanary],
    budget: &CallBudget,
) -> Result<(), PortError> {
    let source = cap_std::fs::Dir::open_ambient_dir(source, cap_std::ambient_authority())
        .map_err(io_error)?;
    private_dir(destination)?;
    private_dir(&destination.join("keys"))?;
    let mut files = vec!["active.json".to_owned()];
    files.extend(keys.iter().map(|key| format!("keys/{}.json", key.key)));
    for name in files {
        let mut input = source.open(&name).map_err(io_error)?;
        let mut output = create_file(&destination.join(name))?;
        copy_hash(&mut input, &mut output, 16 * 1024, &budget.cancellation)?;
        output.sync_all().map_err(io_error)?;
    }
    sync_dir(&destination.join("keys"))?;
    sync_dir(destination)
}

async fn rebind_local(
    stage: &DataRoot,
    journal: &Journal,
    keyring: &RestoreKeyring,
    ctx: &MaintenanceContext,
) -> Result<(), PortError> {
    clear_operational_rows(stage)?;
    let config = CanonicalConfig::local_default(journal.installation.clone(), stage.clone());
    let (canonical, runtime) = CanonicalRuntime::open(config).await?;
    let control = ControlStore::sqlite(stage).await?;
    let keyring = match keyring {
        RestoreKeyring::External(path) => KeyringLocation::External(path.clone()),
        RestoreKeyring::ProvisionDefault { .. } => KeyringLocation::LocalDefault(stage.clone()),
    };
    let result = async {
        if control.installation().await?.as_ref() != Some(&journal.installation) {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        let keys = Keyring::open(control.clone(), keyring, ctx.budget.clone()).await?;
        let backup = ControlBackup::new(
            control.clone(),
            keys,
            stage.clone(),
            BackupConfig::default(),
        )?;
        canonical
            .restore_cursors(ctx.clone(), journal.histories.clone())
            .await?;
        backup
            .restore_cursors(ctx.clone(), journal.histories.clone())
            .await?;
        Ok::<_, PortError>(())
    }
    .await;
    drop(canonical);
    let (_closed, canonical_shutdown) = tokio::join!(control.close(), runtime.shutdown());
    result?;
    canonical_shutdown?;
    sync_database_files(stage)
}

fn clear_operational_rows(stage: &DataRoot) -> Result<(), PortError> {
    let mut db = Connection::open(stage.canonical()).map_err(sql_error)?;
    db.execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
        .map_err(sql_error)?;
    let tx = db.transaction().map_err(sql_error)?;
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='archive_artifacts')", [], |row| row.get::<_, bool>(0)).map_err(sql_error)? {
        tx.execute_batch("DELETE FROM archive_artifacts; DELETE FROM archive_uploads; DELETE FROM archive_import_sources;").map_err(sql_error)?;
    }
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_catalog_receipts')", [], |row| row.get::<_, bool>(0)).map_err(sql_error)? {
        tx.execute_batch("DELETE FROM account_catalog_receipts").map_err(sql_error)?;
    }
    tx.execute_batch(
        "
         DELETE FROM backup_holds;
         DELETE FROM backup_artifacts;
         DELETE FROM blob_retirement_targets;
         DELETE FROM blob_retirements;
         DELETE FROM pending_purges WHERE phase<>'completed';
         DELETE FROM blob_parts AS p WHERE NOT EXISTS(
             SELECT 1 FROM blob_references r WHERE r.space_id=p.space_id AND r.publication_id=p.publication_id
         );
         DELETE FROM blob_publications AS p WHERE NOT EXISTS(
             SELECT 1 FROM blob_references r WHERE r.space_id=p.space_id AND r.publication_id=p.publication_id
         );
         DELETE FROM blob_catalog WHERE ref_count=0;
         UPDATE blob_catalog SET ref_count=(
           SELECT count(*) FROM blob_references r WHERE r.space_id=blob_catalog.space_id
             AND r.content_blake3=blob_catalog.content_blake3 AND r.owner_kind<>'staged_chat'
         ) WHERE EXISTS(SELECT 1 FROM blob_references r WHERE r.space_id=blob_catalog.space_id
               AND r.content_blake3=blob_catalog.content_blake3 AND r.owner_kind='staged_chat');
         DELETE FROM blob_references WHERE owner_kind='staged_chat';
         UPDATE content_jobs SET lease_owner=NULL, lease_until_ms=NULL, artifacts_json='[]',
             result_msgpack=NULL, state=CASE WHEN state IN ('queued','running') THEN 'failed' ELSE state END;",
    ).map_err(sql_error)?;
    tx.commit().map_err(sql_error)
}

fn sync_database_files(stage: &DataRoot) -> Result<(), PortError> {
    let db = Connection::open(stage.canonical()).map_err(sql_error)?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(sql_error)?;
    drop(db);
    for path in [stage.canonical(), stage.control()] {
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
    }
    sync_dir(&stage.root().join("v1"))
}

fn require_empty_target(root: &DataRoot, expected: Option<Identity>) -> Result<(), PortError> {
    if directory_identity(root.root())? != expected
        || (expected.is_some()
            && fs::read_dir(root.root())
                .map_err(io_error)?
                .next()
                .is_some())
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(())
}

fn install_local(parent: &Path, root: &DataRoot, journal: &Journal) -> Result<(), PortError> {
    let Phase::Install {
        directory,
        components,
    } = &journal.phase
    else {
        return Err(invalid(ValidationReason::InvalidState));
    };
    let stage = parent.join(&journal.stage);
    if let Some(initial) = journal.existing {
        if directory_identity(root.root())? != Some(initial)
            || directory_identity(&stage)? != Some(*directory)
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if exists(&root.manifest())? && !exists(&root.restore_guard())? {
            // Normal use may already have created staging or other root entries.
            // The shared manifest inode and installed component identities prove
            // that this journal published the target before its owner stopped.
            require_installed_components(root, journal)?;
            let marker = regular_identity(&stage.join(LOCAL_MANIFEST))?
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            if regular_identity(&root.manifest())? != Some(marker) {
                return Err(invalid(ValidationReason::InvalidState));
            }
            sync_dir(root.root()).map_err(after_local_publication)?;
            return sync_dir(parent).map_err(after_local_publication);
        }
        validate_components(root, &stage, components)?;
        if !exists(&root.manifest())? {
            if !exists(&root.restore_guard())? {
                fs::hard_link(
                    DataRoot::new(stage.clone()).restore_guard(),
                    root.restore_guard(),
                )
                .map_err(io_error)?;
                sync_dir(root.root())?;
            }
            verify_guard(root, journal.digest)?;
            for (name, id) in components {
                let target = root.root().join(name);
                if directory_identity(&target)?.is_none() {
                    let source = stage.join(name);
                    if directory_identity(&source)? != Some(*id) {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    rename_noreplace(&source, &target)?;
                    sync_dir(root.root())?;
                    sync_dir(&stage)?;
                }
            }
            validate_components(root, &stage, components)?;
            fs::hard_link(stage.join(LOCAL_MANIFEST), root.manifest()).map_err(io_error)?;
            sync_dir(root.root())?;
        }
        if exists(&root.restore_guard())? {
            require_installed_components(root, journal)?;
            if regular_identity(&root.manifest())? != regular_identity(&stage.join(LOCAL_MANIFEST))?
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            verify_installed(root, journal, true)?;
            verify_guard(root, journal.digest)?;
            fs::remove_file(root.restore_guard()).map_err(io_error)?;
            sync_dir(root.root()).map_err(after_local_publication)?;
        }
    } else if directory_identity(root.root())? != Some(*directory) {
        require_empty_target(root, None)?;
        if directory_identity(&stage)? != Some(*directory) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        rename_noreplace(&stage, root.root())?;
    }
    sync_dir(parent).map_err(after_local_publication)
}

fn require_installed_components(root: &DataRoot, journal: &Journal) -> Result<(), PortError> {
    let Phase::Install { components, .. } = &journal.phase else {
        return Err(invalid(ValidationReason::InvalidState));
    };
    if directory_identity(root.root())? != journal.existing {
        return Err(invalid(ValidationReason::InvalidState));
    }
    for (name, id) in components {
        if directory_identity(&root.root().join(name))? != Some(*id) {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    Ok(())
}

fn cleanup_local_stage(parent: &Path, journal: &Journal) -> Result<(), PortError> {
    let Phase::Install { directory, .. } = &journal.phase else {
        return Err(invalid(ValidationReason::InvalidState));
    };
    let stage = DataRoot::new(parent.join(&journal.stage));
    let (parent_dir, name) = open_parent(stage.root())?;
    let Some(dir) = open_optional_dir(&parent_dir, name)? else {
        return sync_dir(parent);
    };
    let meta = dir.dir_metadata().map_err(io_error)?;
    if (meta.dev(), meta.ino()) != (directory.device, directory.inode) {
        return Err(invalid(ValidationReason::InvalidState));
    }
    // CanonicalRuntime creates this empty spool path on its first open.
    // Remove only its known, empty directories through pinned handles.
    if let Some(staging) = open_optional_dir(&dir, "staging")? {
        if let Some(artifacts) = open_optional_dir(&staging, "artifacts")? {
            if let Some(backups) = open_optional_dir(&artifacts, "backups")? {
                backups.remove_open_dir().map_err(io_error)?;
            }
            artifacts.remove_open_dir().map_err(io_error)?;
        }
        staging.remove_open_dir().map_err(io_error)?;
    }
    if let Some(marker) = regular_identity(&stage.manifest())? {
        if Some(marker) != journal.published_manifest {
            return Err(invalid(ValidationReason::InvalidState));
        }
        dir.remove_file(LOCAL_MANIFEST).map_err(io_error)?;
    }
    if regular_identity(&stage.restore_guard())?.is_some() {
        verify_guard(&stage, journal.digest)?;
        dir.remove_file("v1-restore-in-progress")
            .map_err(io_error)?;
    }
    dir.remove_open_dir().map_err(io_error)?;
    sync_dir(parent)
}

fn open_optional_dir(dir: &Dir, name: impl AsRef<Path>) -> Result<Option<Dir>, PortError> {
    match dir.open_dir_nofollow(name) {
        Ok(child) => Ok(Some(child)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io_error(err)),
    }
}

fn regular_identity(path: &Path) -> Result<Option<Identity>, PortError> {
    let (parent, name) = open_parent(path)?;
    match parent.symlink_metadata(name) {
        Ok(meta) if meta.is_file() => Ok(Some(Identity {
            device: meta.dev(),
            inode: meta.ino(),
        })),
        Ok(_) => Err(invalid(ValidationReason::InvalidPathComponent)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io_error(err)),
    }
}

fn after_local_publication(error: PortError) -> PortError {
    codec::unknown_commit_outcome("restore_local_publication", error.to_string())
}

fn validate_components(
    root: &DataRoot,
    stage: &Path,
    components: &[(String, Identity)],
) -> Result<(), PortError> {
    for entry in fs::read_dir(root.root()).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name();
        if name == LOCAL_MANIFEST || name == "v1-restore-in-progress" {
            if !entry.file_type().map_err(io_error)?.is_file() {
                return Err(invalid(ValidationReason::InvalidState));
            }
            continue;
        }
        if !components
            .iter()
            .any(|(expected, _)| name == expected.as_str())
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    for (name, id) in components {
        let installed = directory_identity(&root.root().join(name))?;
        let pending = directory_identity(&stage.join(name))?;
        if (installed, pending) != (Some(*id), None) && (installed, pending) != (None, Some(*id)) {
            return Err(invalid(ValidationReason::InvalidState));
        }
    }
    Ok(())
}

fn verify_installed(
    root: &DataRoot,
    journal: &Journal,
    require_cut: bool,
) -> Result<(), PortError> {
    let mut marker = String::new();
    File::open(root.manifest())
        .map_err(io_error)?
        .take(4096)
        .read_to_string(&mut marker)
        .map_err(io_error)?;
    let epoch: EpochManifestV1 =
        serde_json::from_str(&marker).map_err(|_| invalid(ValidationReason::InvalidState))?;
    if epoch.installation_id != journal.installation || epoch.epoch_version != SUPPORTED_V1_EPOCH {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let canonical = Connection::open_with_flags(root.canonical(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sql_error)?;
    let mut control = Connection::open_with_flags(root.control(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sql_error)?;
    // A running target may acknowledge a new change between reads. Pin all
    // acknowledgements before reading their respective canonical ceilings.
    let control = control.transaction().map_err(sql_error)?;
    let installation: String = control
        .query_row(
            "SELECT installation_id FROM v1_storage_epoch WHERE singleton=1 AND state='ready'",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    if installation != journal.installation.as_str() {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    for cursor in &journal.histories {
        let (history, seq): (Vec<u8>, i64) = canonical
            .query_row(
                "SELECT history_incarnation,last_seq FROM spaces WHERE space_id=?1",
                [cursor.scope.space_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(sql_error)?;
        let cutoff = cursor.after.get() as i64;
        if history != cursor.scope.incarnation.as_bytes()
            || seq < cutoff
            || (require_cut && seq != cutoff)
        {
            return Err(invalid(ValidationReason::HistoryIncarnationMismatch));
        }
        for table in ["mcp_delta_owner_cursors", "mcp_delta_session_cursors"] {
            let sql = format!(
                "SELECT EXISTS(SELECT 1 FROM {table} WHERE space_id=?1 AND (history_incarnation<>?2 OR acked_space_seq>?3))"
            );
            let changed: bool = control
                .query_row(
                    &sql,
                    rusqlite::params![
                        cursor.scope.space_id.as_str(),
                        cursor.scope.incarnation.as_bytes().as_slice(),
                        seq
                    ],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if changed {
                return Err(invalid(ValidationReason::HistoryIncarnationMismatch));
            }
        }
    }
    Ok(())
}

fn same_cuts(proposed: &[ChangeCursor], source: &[ChangeCursor]) -> bool {
    proposed.len() == source.len()
        && proposed.iter().zip(source).all(|(next, original)| {
            next.scope.space_id == original.scope.space_id
                && next.after == original.after
                && next.scope.incarnation != original.scope.incarnation
        })
}

fn valid_stage(name: &str) -> bool {
    name.strip_prefix(".notarium-restore-generation-")
        .is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn verify_guard(root: &DataRoot, digest: ContentDigest) -> Result<(), PortError> {
    let text = digest.to_hex();
    let path = root.restore_guard();
    let mut saved = String::new();
    File::open(path)
        .map_err(io_error)?
        .take(GUARD_LENGTH as u64 + 1)
        .read_to_string(&mut saved)
        .map_err(io_error)?;
    if saved != text {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(())
}

fn directory_identity(path: &Path) -> Result<Option<Identity>, PortError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => {
            let (parent, name) = open_parent(path)?;
            let directory = parent.open_dir_nofollow(name).map_err(io_error)?;
            let meta = directory.dir_metadata().map_err(io_error)?;
            Ok(Some(Identity {
                device: meta.dev(),
                inode: meta.ino(),
            }))
        }
        Ok(_) => Err(invalid(ValidationReason::InvalidPathComponent)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io_error(err)),
    }
}

fn exists(path: &Path) -> Result<bool, PortError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(io_error(err)),
    }
}

fn acquire_lock(path: &Path) -> Result<File, PortError> {
    let (parent, name) = open_parent(path)?;
    let mut options = CapOpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    cap_std::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = parent
        .open_with(name, &options)
        .map_err(io_error)?
        .into_std();
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    file.try_lock()
        .map_err(|_| DomainError::MigrationInProgress)?;
    Ok(file)
}

fn open_parent(path: &Path) -> Result<(Dir, &std::ffi::OsStr), PortError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid(ValidationReason::InvalidPathComponent))?;
    let name = path
        .file_name()
        .ok_or_else(|| invalid(ValidationReason::InvalidPathComponent))?;
    Ok((
        Dir::open_ambient_dir(parent, ambient_authority()).map_err(io_error)?,
        name,
    ))
}

#[cfg(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    target_os = "redox"
))]
fn rename_noreplace(source: &Path, target: &Path) -> Result<(), PortError> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        target,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(|err| io_error(err.into()))
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    target_os = "redox"
)))]
fn rename_noreplace(_: &Path, _: &Path) -> Result<(), PortError> {
    Err(invalid(ValidationReason::UnsupportedContainer))
}

fn read_journal(path: &Path) -> Result<Journal, PortError> {
    let mut input = File::open(path)
        .map_err(io_error)?
        .take(MAX_BACKUP_METADATA_JSON_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    input.read_to_end(&mut bytes).map_err(io_error)?;
    if bytes.len() > MAX_BACKUP_METADATA_JSON_BYTES {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid(ValidationReason::InvalidState))
}

fn encode_journal(value: &impl Serialize) -> Result<String, PortError> {
    let data = serde_json::to_string(value).map_err(|_| invalid(ValidationReason::InvalidState))?;
    if data.len() > MAX_BACKUP_METADATA_JSON_BYTES {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    Ok(data)
}

fn save_journal(path: &Path, value: &Journal) -> Result<(), PortError> {
    let parent = path.parent().expect("journal path has parent");
    let tmp = parent.join(codec::new_prefixed_hex_id(".notarium-restore-journal-")?);
    let data = encode_journal(value)?;
    write_new(&tmp, data.as_bytes())?;
    fs::rename(&tmp, path).map_err(io_error)?;
    sync_dir(parent)
}

fn epoch_manifest(installation: &InstallationId) -> Result<Vec<u8>, PortError> {
    serde_json::to_vec(&EpochManifestV1 {
        epoch_version: SUPPORTED_V1_EPOCH,
        installation_id: installation.clone(),
        state: ReadyState::V1Ready,
        receipt_sha256: None,
    })
    .map_err(|_| invalid(ValidationReason::InvalidState))
}

fn create_file(path: &Path) -> Result<File, PortError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map_err(io_error)
}

fn write_new(path: &Path, data: &[u8]) -> Result<(), PortError> {
    let mut output = create_file(path)?;
    output
        .write_all(data)
        .and_then(|()| output.sync_all())
        .map_err(io_error)
}

fn private_dir(path: &Path) -> Result<(), PortError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path).map_err(io_error)
}

fn sync_dir(path: &Path) -> Result<(), PortError> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(io_error)
}

mod cloud;
pub use cloud::CloudRestoreTarget;

#[cfg(test)]
mod journal_tests {
    use super::*;

    #[test]
    fn full_history_local_and_cloud_journals_round_trip() {
        let directory =
            std::env::temp_dir().join(codec::new_prefixed_hex_id("restore-journal-").unwrap());
        fs::create_dir(&directory).unwrap();
        let path = directory.join("journal.json");
        let journal = Journal {
            version: 1,
            installation: InstallationId::from_bytes([255; 16]),
            digest: ContentDigest::from_bytes([255; 32]),
            existing: None,
            external_keyring: true,
            histories: crate::backup_format::full_history_fixture(),
            stage: ".notarium-restore-generation-ffffffffffffffffffffffffffffffff".into(),
            phase: Phase::Build {
                directory: Some(Identity {
                    device: u64::MAX,
                    inode: u64::MAX,
                }),
            },
            published_manifest: None,
        };
        save_journal(&path, &journal).unwrap();
        assert_eq!(read_journal(&path).unwrap().histories, journal.histories);
        let cloud = encode_journal(&journal.histories).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<ChangeCursor>>(&cloud).unwrap(),
            journal.histories
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
