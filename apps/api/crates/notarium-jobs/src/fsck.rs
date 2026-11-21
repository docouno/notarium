use std::{
    collections::BTreeSet,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use notarium_canonical::{
    CanonicalStore,
    backup::{PostgresSpoolValue, scan_postgres_spool_v1, verify_schema_witness},
};
use notarium_control::{
    backup::{ControlBackup, SpoolReader},
    keyring::{BackupKeyRow, verify_backup_keys},
    store::{TARGET_SCHEMA_VERSION, TargetRecord},
};
use notarium_core::{
    epoch::SUPPORTED_V1_EPOCH,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, HistoryIncarnation, InstallationId, SpaceId, SpaceSeq},
    model::HistoryScope,
    ports::{
        BackupArtifactKind, CallBudget, KeyCanary, MAX_BACKUP_KEYS, MaintenanceContext,
        ServiceAuthority, ServicePurpose,
    },
    receipt::ChangeCursor,
};
use rusqlite::Connection;
use zip::CompressionMethod;

use crate::{
    BackupOptions,
    backup::capture_pair,
    backup_format::{
        CAS_HEADER_BYTES, CAS_INDEX_MAGIC, CAS_RECORD_BYTES, CasRecord, MANIFEST_LIMIT, Manifest,
        Payload, ZIP_NAMES, authenticated_payload, check_history_count, copy_hash, invalid,
        io_error,
    },
    db_integrity::{
        Partition, PgRowChecks, Relations, check_sqlite_blob_owners, check_sqlite_canonical,
        check_sqlite_control,
    },
    import::check_cancelled,
    range_source::RangeSource,
    sqlite_range::{sql_error, with_database},
    zip_layout::{EntrySpan, ZipLimits, open_zip},
};

pub(crate) trait SeekRead: Read + Seek + Send {}
impl<T: Read + Seek + Send> SeekRead for T {}
pub(crate) type ArchiveRange = RangeSource<Box<dyn SeekRead>>;

/// An owned seekable source. The caller opens the immutable file or pins the
/// remote version before transferring it to the verifier.
pub struct ArchiveInput {
    source: ArchiveRange,
}

impl ArchiveInput {
    pub fn new(source: impl Read + Seek + Send + 'static) -> Result<Self, PortError> {
        let source: Box<dyn SeekRead> = Box::new(source);
        Ok(Self {
            source: RangeSource::new(source).map_err(io_error)?,
        })
    }

    /// Build without I/O using the exact size of the pinned source version.
    pub fn with_length(source: impl Read + Seek + Send + 'static, bytes: u64) -> Self {
        let source: Box<dyn SeekRead> = Box::new(source);
        Self {
            source: RangeSource::with_length(source, bytes),
        }
    }
}

pub enum FsckInput<'a> {
    Archive(ArchiveInput),
    Live {
        canonical: &'a CanonicalStore,
        control: &'a ControlBackup,
    },
}

#[derive(Clone, Debug)]
pub struct FsckReport {
    pub installation: InstallationId,
    pub backend: BackupArtifactKind,
    pub archive_digest: Option<ContentDigest>,
    pub spaces: usize,
    pub blobs: u64,
    pub raw_blob_bytes: u64,
    pub readable_keys: usize,
    pub sqlite_native_peak_bytes: Option<u64>,
}

pub(crate) struct VerifiedArchive {
    source: ArchiveRange,
    pub(crate) manifest: Manifest,
    spans: [EntrySpan; 5],
    pub(crate) report: FsckReport,
    pub(crate) histories: Vec<ChangeCursor>,
    pub(crate) keys: Vec<KeyCanary>,
}

impl VerifiedArchive {
    pub(crate) fn control(&self) -> Result<impl Read + Seek + Send + 'static, PortError> {
        self.view(1)
    }

    pub(crate) fn canonical(&self) -> Result<impl Read + Seek + Send + 'static, PortError> {
        self.view(2)
    }

    pub(crate) fn restore_index(&self) -> Result<(u64, impl Read + use<>), PortError> {
        let mut source = authenticated_payload(self.view(3)?, self.manifest.index);
        let count = read_index_header(&mut source, self.manifest.index.bytes)?;
        Ok((count, source))
    }

    pub(crate) fn blob(
        &self,
        record: &CasRecord,
    ) -> Result<impl Read + Seek + Send + 'static, PortError> {
        self.view(4)?
            .view(record.offset, record.compressed)
            .map_err(io_error)
    }

    fn view(&self, index: usize) -> Result<ArchiveRange, PortError> {
        self.source
            .view(self.spans[index].offset, self.spans[index].len)
            .map_err(io_error)
    }
}

pub async fn run_fsck(
    ctx: MaintenanceContext,
    input: FsckInput<'_>,
    external_keyring: &Path,
    options: BackupOptions,
) -> Result<FsckReport, PortError> {
    ctx.authority.require(ServicePurpose::Fsck)?;
    options.validate()?;
    crate::maintenance::bounded(ctx, "archive_fsck", |ctx| {
        run_fsck_inner(ctx, input, external_keyring, options)
    })
    .await
}

async fn run_fsck_inner(
    ctx: MaintenanceContext,
    input: FsckInput<'_>,
    external_keyring: &Path,
    options: BackupOptions,
) -> Result<FsckReport, PortError> {
    match input {
        FsckInput::Archive(input) => {
            let keys = external_keyring.to_owned();
            let cancellation = ctx.budget.cancellation.clone();
            let verified = crate::maintenance::read_source(&cancellation, move || {
                verify_archive(input, &keys, &ctx.budget, options)
            })
            .await?;
            Ok(verified.report)
        }
        FsckInput::Live { canonical, control } => {
            verify_live(ctx, canonical, control, external_keyring, options).await
        }
    }
}

pub(crate) fn verify_archive(
    input: ArchiveInput,
    keyring: &Path,
    budget: &CallBudget,
    options: BackupOptions,
) -> Result<VerifiedArchive, PortError> {
    check_cancelled(&budget.cancellation)?;
    let source = input.source.with_cancellation(budget.cancellation.clone());
    let (mut zip, spans) = open_zip(
        source.clone(),
        ZipLimits {
            bytes: options.max_archive_bytes,
            metadata_bytes: MANIFEST_LIMIT as u64,
            entries: ZIP_NAMES.len(),
        },
    )?;
    if zip.len() != ZIP_NAMES.len() || !zip.comment().is_empty() {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    for (index, name) in ZIP_NAMES.into_iter().enumerate() {
        let entry = zip
            .by_index_data(index)
            .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
        if entry.name_raw() != name.as_bytes()
            || !entry.is_file()
            || entry.encrypted()
            || entry.compression() != CompressionMethod::Stored
            || entry.flags().is_using_data_descriptor()
            || !entry.comment().is_empty()
        {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
    }
    let mut manifest_file = zip
        .by_index(0)
        .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
    if manifest_file.size() > MANIFEST_LIMIT as u64 {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut bytes = Vec::new();
    manifest_file.read_to_end(&mut bytes).map_err(io_error)?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| invalid(ValidationReason::InvalidArchive))?;
    if manifest.version != 1 {
        return Err(invalid(ValidationReason::UnsupportedContainer));
    }
    drop(manifest_file);
    for (offset, expected) in [
        manifest.control,
        manifest.canonical,
        manifest.index,
        manifest.cas,
    ]
    .into_iter()
    .enumerate()
    {
        let mut file = zip
            .by_index(offset + 1)
            .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
        if file.size() != expected.bytes
            || copy_hash(
                &mut file,
                &mut io::sink(),
                expected.bytes,
                &budget.cancellation,
            )? != expected
        {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
    }
    drop(zip);
    let spans: [EntrySpan; 5] = spans
        .try_into()
        .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
    let view = |index: usize| {
        source
            .view(spans[index].offset, spans[index].len)
            .map_err(io_error)
    };
    let mut index = CasIndex::open(view(3)?, manifest.index.bytes)?;
    let data = view(4)?;
    let (blobs, raw_blob_bytes) = check_index_and_data(&mut index, data.clone(), budget, &options)?;
    let databases = verify_databases(
        view(1)?,
        view(2)?,
        &manifest,
        keyring,
        budget,
        &options,
        Some((&mut index, &data)),
    )?;
    let mut whole = source.clone();
    let archive_digest = copy_hash(
        &mut whole,
        &mut io::sink(),
        options.max_archive_bytes,
        &budget.cancellation,
    )?
    .digest;
    let report = FsckReport {
        installation: manifest.installation.clone(),
        backend: manifest.backend,
        archive_digest: Some(archive_digest),
        spaces: databases.histories.len(),
        blobs,
        raw_blob_bytes,
        readable_keys: databases.keys.len(),
        sqlite_native_peak_bytes: databases.native_peak,
    };
    Ok(VerifiedArchive {
        source,
        manifest,
        spans,
        report,
        histories: databases.histories,
        keys: databases.keys,
    })
}

struct Databases {
    histories: Vec<ChangeCursor>,
    keys: Vec<KeyCanary>,
    native_peak: Option<u64>,
}

fn verify_databases(
    control: ArchiveRange,
    canonical: ArchiveRange,
    manifest: &Manifest,
    keyring: &Path,
    budget: &CallBudget,
    options: &BackupOptions,
    cas: Option<(&mut CasIndex, &ArchiveRange)>,
) -> Result<Databases, PortError> {
    if control.len() != manifest.control.bytes || canonical.len() != manifest.canonical.bytes {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    let mut control_cursors = BTreeSet::new();
    let mut native_peak = None;
    let (keys, histories) = match manifest.backend {
        BackupArtifactKind::SqliteSnapshotV1 => {
            let (facts, peak) = crate::sqlite_process::verify_sqlite(
                &options.sqlite_verifier,
                manifest,
                control,
                canonical,
                cas.as_ref().map(|(index, _)| &**index),
                &budget.cancellation,
            )?;
            native_peak = Some(peak);
            control_cursors = facts.control_cursors;
            (
                verify_backup_keys(keyring, facts.keys, budget.clone())?,
                facts.histories,
            )
        }
        BackupArtifactKind::PostgresSpoolV1 => {
            let keys =
                verify_control_spool(control, manifest, keyring, budget, &mut control_cursors)?;
            let histories = verify_canonical_spool(canonical, manifest, budget, options, cas)?;
            (keys, histories)
        }
    };
    for space in control_cursors {
        if histories
            .binary_search_by(|cursor| cursor.scope.space_id.cmp(&space))
            .is_err()
        {
            return Err(invalid(ValidationReason::HistoryIncarnationMismatch));
        }
    }
    Ok(Databases {
        histories,
        keys,
        native_peak,
    })
}

// A native key ID, hash, state and sealed canary together fit in 256 bytes.
const MAX_BACKUP_KEY_FIELDS_BYTES: usize = MAX_BACKUP_KEYS * 256;

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct SqliteFacts {
    pub(crate) keys: Vec<BackupKeyRow>,
    pub(crate) histories: Vec<ChangeCursor>,
    pub(crate) control_cursors: BTreeSet<SpaceId>,
}

pub(crate) fn inspect_sqlite(
    control: ArchiveRange,
    canonical: ArchiveRange,
    manifest: &Manifest,
    cancellation: &notarium_core::ports::Cancellation,
    index: Option<&mut CasIndex>,
) -> Result<SqliteFacts, PortError> {
    let mut control_cursors = BTreeSet::new();
    let keys = with_database(control, manifest.control.bytes, cancellation, |db| {
        check_sqlite_control(db)?;
        check_integrity(db)?;
        let (install, epoch, state): (String, i64, String) = db.query_row(
            "SELECT installation_id,epoch_version,state FROM v1_storage_epoch WHERE singleton=1",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).map_err(sql_error)?;
        if install != manifest.installation.as_str()
            || epoch != i64::from(SUPPORTED_V1_EPOCH)
            || state != "ready"
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        for sql in [
            "SELECT DISTINCT space_id FROM mcp_delta_owner_cursors",
            "SELECT DISTINCT space_id FROM mcp_delta_session_cursors",
        ] {
            let mut query = db.prepare(sql).map_err(sql_error)?;
            let mut rows = query.query([]).map_err(sql_error)?;
            while let Some(row) = rows.next().map_err(sql_error)? {
                let id: String = row.get(0).map_err(sql_error)?;
                record_cursor(&mut control_cursors, &id)?;
            }
        }
        let mut controls = db
            .prepare(
                "SELECT key_id,key_hash,generation,state,canary FROM secret_keyring
             WHERE retired_at IS NULL ORDER BY generation LIMIT 4097",
            )
            .map_err(sql_error)?;
        let mut rows = controls.query([]).map_err(sql_error)?;
        let mut keys = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next().map_err(sql_error)? {
            let key = BackupKeyRow {
                key_id: row.get(0).map_err(sql_error)?,
                key_hash: row.get(1).map_err(sql_error)?,
                generation: row.get(2).map_err(sql_error)?,
                state: row.get(3).map_err(sql_error)?,
                canary: row.get(4).map_err(sql_error)?,
            };
            bytes += key.key_id.len() + key.key_hash.len() + key.state.len() + key.canary.len();
            if keys.len() >= MAX_BACKUP_KEYS || bytes > MAX_BACKUP_KEY_FIELDS_BYTES {
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
            keys.push(key);
        }
        Ok(keys)
    })?;
    let histories = with_database(canonical, manifest.canonical.bytes, cancellation, |db| {
        let (install, epoch, version, checksum, state): (String, i64, u32, Vec<u8>, String) = db.query_row(
            "SELECT installation_id,epoch_version,schema_version,manifest_checksum,migration_state
             FROM schema_meta WHERE singleton_id=1",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).map_err(sql_error)?;
        verify_schema_witness(version, &checksum)?;
        if install != manifest.installation.as_str()
            || epoch != i64::from(SUPPORTED_V1_EPOCH)
            || state != "ready"
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        check_sqlite_canonical(db, version)?;
        check_integrity(db)?;
        verify_sqlite_references(db, index, cancellation)?;
        let mut query = db
            .prepare("SELECT space_id,history_incarnation,last_seq FROM spaces ORDER BY space_id")
            .map_err(sql_error)?;
        let mut rows = query.query([]).map_err(sql_error)?;
        let mut history = Vec::new();
        while let Some(row) = rows.next().map_err(sql_error)? {
            let space: String = row.get(0).map_err(sql_error)?;
            let incarnation: Vec<u8> = row.get(1).map_err(sql_error)?;
            let seq: i64 = row.get(2).map_err(sql_error)?;
            history.push(cursor(&space, &incarnation, seq)?);
            check_history_count(history.len())?;
        }
        Ok(history)
    })?;
    Ok(SqliteFacts {
        keys,
        histories,
        control_cursors,
    })
}

fn check_integrity(db: &Connection) -> Result<(), PortError> {
    let mut statement = db.prepare("PRAGMA integrity_check(1)").map_err(sql_error)?;
    if statement.column_count() != 1 {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    let mut rows = statement.query([]).map_err(sql_error)?;
    let Some(first) = rows.next().map_err(sql_error)? else {
        return Err(invalid(ValidationReason::InvalidArchive));
    };
    if first.get::<_, String>(0).map_err(sql_error)? != "ok"
        || rows.next().map_err(sql_error)?.is_some()
    {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    let mut foreign_keys = db.prepare("PRAGMA foreign_key_check").map_err(sql_error)?;
    if foreign_keys.column_count() != 4
        || foreign_keys
            .query([])
            .map_err(sql_error)?
            .next()
            .map_err(sql_error)?
            .is_some()
    {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    Ok(())
}

pub(crate) fn verify_sqlite_references(
    db: &Connection,
    mut index: Option<&mut CasIndex>,
    cancellation: &notarium_core::ports::Cancellation,
) -> Result<(), PortError> {
    let missing_root: bool = db
        .query_row(
            "SELECT EXISTS (
            SELECT 1 FROM spaces s
            LEFT JOIN folder_heads f ON f.space_id=s.space_id AND f.folder_id=s.root_folder_id
            WHERE f.folder_id IS NULL OR f.is_root<>1
               OR f.parent_folder_id IS NOT NULL OR f.lifecycle_state<>'active'
        )",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    if missing_root {
        return Err(invalid(ValidationReason::InvalidState));
    }
    check_sqlite_blob_owners(db, cancellation)?;
    let lost: bool = db.query_row(
        "SELECT EXISTS (SELECT 1 FROM blob_references r
            LEFT JOIN blob_catalog c ON c.space_id=r.space_id AND c.content_blake3=r.content_blake3
            LEFT JOIN blob_publications p ON p.space_id=r.space_id AND p.publication_id=r.publication_id
            WHERE c.content_blake3 IS NULL OR p.publication_id IS NULL OR p.content_blake3<>r.content_blake3
               OR c.admission_state<>'open' OR c.blob_state<>'active'
               OR p.state<>'active' OR p.manifest_sealed<>1 OR p.raw_size<>c.raw_size
               OR c.current_publication_id IS DISTINCT FROM p.publication_id)",
        [], |row| row.get(0),
    ).map_err(sql_error)?;
    if lost {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let mut query = db.prepare(
        "SELECT c.space_id,c.content_blake3,c.raw_size,c.ref_count,
            (SELECT count(*) FROM blob_references r WHERE r.space_id=c.space_id AND r.content_blake3=c.content_blake3)
         FROM blob_catalog c ORDER BY c.space_id,c.content_blake3",
    ).map_err(sql_error)?;
    let mut rows = query.query([]).map_err(sql_error)?;
    let mut ordinal = 0;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let ref_count: i64 = row.get(3).map_err(sql_error)?;
        let count: i64 = row.get(4).map_err(sql_error)?;
        if ref_count != count {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if count > 0
            && let Some(index) = index.as_deref_mut()
        {
            let id: String = row.get(0).map_err(sql_error)?;
            let raw: i64 = row.get(2).map_err(sql_error)?;
            let hash: Vec<u8> = row.get(1).map_err(sql_error)?;
            index.expect(ordinal, &id, &hash, raw)?;
            ordinal += 1;
        }
    }
    if index.is_some_and(|index| index.count != ordinal) {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(())
}

fn verify_control_spool(
    input: ArchiveRange,
    manifest: &Manifest,
    keyring: &Path,
    budget: &CallBudget,
    cursors: &mut BTreeSet<SpaceId>,
) -> Result<Vec<KeyCanary>, PortError> {
    let mut reader = SpoolReader::open(input.clone())?;
    let witness = reader.witness().clone();
    if witness.installation != manifest.installation
        || witness.schema_version != TARGET_SCHEMA_VERSION
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let mut keys = Vec::new();
    let mut key_bytes = 0;
    let mut found_installation = false;
    let mut checks = PgRowChecks::new(false)?;
    while let Some(row) = reader.next_record()? {
        check_cancelled(&budget.cancellation)?;
        checks.check_control(&row, None)?;
        match row {
            TargetRecord::V1StorageEpoch {
                installation_id,
                state,
                epoch_version,
                ..
            } => {
                if found_installation
                    || installation_id != manifest.installation.as_str()
                    || state != "ready"
                    || epoch_version != i64::from(SUPPORTED_V1_EPOCH)
                {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                found_installation = true;
            }
            TargetRecord::SecretKeyring {
                key_id,
                key_hash,
                generation,
                state,
                canary,
                retired_at: None,
                ..
            } => {
                if canary.len() > 1024 {
                    return Err(invalid(ValidationReason::InvalidArchive));
                }
                key_bytes += key_id.len() + key_hash.len() + state.len() + canary.len();
                if keys.len() >= MAX_BACKUP_KEYS || key_bytes > MAX_BACKUP_KEY_FIELDS_BYTES {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                keys.push(BackupKeyRow {
                    key_id,
                    key_hash,
                    generation,
                    state,
                    canary,
                });
            }
            TargetRecord::McpDeltaOwnerCursors { space_id, .. }
            | TargetRecord::McpDeltaSessionCursors { space_id, .. } => {
                record_cursor(cursors, &space_id)?
            }
            _ => {}
        }
    }
    if !found_installation {
        return Err(invalid(ValidationReason::InvalidState));
    }
    keys.sort_unstable_by_key(|row| row.generation);
    let keys = verify_backup_keys(keyring, keys, budget.clone())?;
    if !keys
        .iter()
        .map(canary_identity)
        .eq(witness.canaries.iter().map(canary_identity))
    {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Relations::new(false)?.verify(&budget.cancellation, |keys| {
        let mut scan = SpoolReader::open(input.clone())?;
        while let Some(record) = scan.next_record()? {
            check_cancelled(&budget.cancellation)?;
            checks.check_control(&record, Some(keys))?;
            keys.control(&record)?;
        }
        Ok(())
    })?;
    Ok(keys)
}

fn record_cursor(cursors: &mut BTreeSet<SpaceId>, space: &str) -> Result<(), PortError> {
    cursors.insert(SpaceId::parse(space)?);
    check_history_count(cursors.len())
}

fn canary_identity(key: &KeyCanary) -> (&str, u64, bool, ContentDigest, bool) {
    (
        key.key.as_str(),
        key.generation,
        key.active,
        key.digest,
        key.readable,
    )
}

fn verify_canonical_spool(
    canonical: ArchiveRange,
    manifest: &Manifest,
    budget: &CallBudget,
    options: &BackupOptions,
    cas: Option<(&mut CasIndex, &ArchiveRange)>,
) -> Result<Vec<ChangeCursor>, PortError> {
    use PostgresSpoolValue::{Bytes, Int, Text};
    let (mut index, data) = cas.unzip();
    let mut histories = Vec::new();
    let mut schema_version = 0;
    let mut ordinal = 0;
    let mut checks = PgRowChecks::new(true)?;
    let witness = scan_postgres_spool_v1(
        canonical.clone(),
        manifest.canonical.bytes,
        options.max_archive_bytes,
        options.max_pg_row_bytes,
        |table, row| {
            check_cancelled(&budget.cancellation)?;
            checks.check(table, row, None)?;
            match (table.name, row) {
                (
                    "schema_meta",
                    [
                        Int(1),
                        Int(version),
                        Int(epoch),
                        Text(installation),
                        Text(state),
                        Bytes(checksum),
                        ..,
                    ],
                ) => {
                    if schema_version != 0
                        || *epoch != i64::from(SUPPORTED_V1_EPOCH)
                        || installation != manifest.installation.as_str()
                        || state != "ready"
                    {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    schema_version = u32::try_from(*version)
                        .map_err(|_| invalid(ValidationReason::InvalidState))?;
                    verify_schema_witness(schema_version, checksum)?;
                }
                ("spaces", [Text(id), Bytes(history), _, _, _, _, _, _, _, Int(seq), ..]) => {
                    histories.push(cursor(id, history, *seq)?);
                    check_history_count(histories.len())?;
                }
                ("blob_catalog", [Text(space), Bytes(digest), Int(raw), _, Int(refs), ..]) => {
                    if *refs > 0
                        && let Some(index) = index.as_deref_mut()
                    {
                        index.expect(ordinal, space, digest, *raw)?;
                        ordinal += 1;
                    }
                }
                _ => {}
            }
            Ok(())
        },
    )?;
    if schema_version == 0
        || schema_version != witness.schema_version
        || witness.installation != manifest.installation
        || !witness.canaries.is_empty()
        || histories != witness.histories
        || index.as_ref().is_some_and(|index| index.count != ordinal)
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Relations::new(true)?.verify(&budget.cancellation, |keys| {
        scan_postgres_spool_v1(
            canonical.clone(),
            manifest.canonical.bytes,
            options.max_archive_bytes,
            options.max_pg_row_bytes,
            |table, row| {
                check_cancelled(&budget.cancellation)?;
                if let (
                    "blob_catalog",
                    [
                        Text(space),
                        Bytes(hash),
                        _,
                        _,
                        Int(refs),
                        Text(publication),
                        ..,
                    ],
                    Some((index, data)),
                ) = (table.name, row, index.as_deref_mut().zip(data))
                    && *refs > 0
                    && keys.includes_publication(space, publication)
                {
                    let ordinal = index
                        .find(space, hash)?
                        .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?;
                    note_archived_parts(keys, data, index.read(ordinal)?, publication, budget)?;
                }
                checks.check(table, row, Some(keys))?;
                keys.canonical(table, row)
            },
        )?;
        Ok(())
    })?;
    Ok(histories)
}

fn note_archived_parts(
    keys: &mut Partition<'_>,
    data: &ArchiveRange,
    record: CasRecord,
    publication: &str,
    budget: &CallBudget,
) -> Result<(), PortError> {
    const CHUNK: u64 = notarium_canonical::blobs::S3_MAX_RAW_CHUNK_BYTES as u64;
    let compressed = data
        .view(record.offset, record.compressed)
        .map_err(io_error)?;
    let mut decoder = zstd::stream::read::Decoder::new(compressed).map_err(io_error)?;
    decoder.window_log_max(23).map_err(io_error)?;
    let mut left = record.raw;
    for part in 0..record.raw.div_ceil(CHUNK).max(1) {
        let size = left.min(CHUNK);
        let actual = copy_hash(
            &mut (&mut decoder).take(size),
            &mut io::sink(),
            size,
            &budget.cancellation,
        )?;
        if actual.bytes != size {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        keys.note_part_digest(
            record.space.as_str(),
            publication,
            part as i64,
            size as i64,
            actual.digest.as_bytes(),
            true,
        );
        left -= size;
    }
    Ok(())
}

pub(crate) struct CasIndex {
    data: ArchiveRange,
    pub(crate) count: u64,
}

impl CasIndex {
    pub(crate) fn open(mut data: ArchiveRange, bytes: u64) -> Result<Self, PortError> {
        if bytes != data.len() {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
        let count = read_index_header(&mut data, bytes)?;
        Ok(Self { data, count })
    }

    pub(crate) fn source(&self) -> ArchiveRange {
        self.data.clone()
    }

    pub(crate) fn read(&mut self, ordinal: u64) -> Result<CasRecord, PortError> {
        if ordinal >= self.count {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        self.data
            .seek(SeekFrom::Start(
                CAS_HEADER_BYTES + ordinal * CAS_RECORD_BYTES,
            ))
            .map_err(io_error)?;
        CasRecord::read(&mut self.data)
    }

    fn expect(
        &mut self,
        ordinal: u64,
        space: &str,
        hash: &[u8],
        raw: i64,
    ) -> Result<(), PortError> {
        let found = self.read(ordinal)?;
        if found.space.as_str() != space
            || found.digest.as_bytes() != hash
            || i64::try_from(found.raw).ok() != Some(raw)
        {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        Ok(())
    }

    fn find(&mut self, space: &str, hash: &[u8]) -> Result<Option<u64>, PortError> {
        let mut low = 0;
        let mut high = self.count;
        while low < high {
            let mid = low + (high - low) / 2;
            let row = self.read(mid)?;
            let key = (row.space.as_str(), row.digest.as_bytes().as_slice());
            match key.cmp(&(space, hash)) {
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Equal => return Ok(Some(mid)),
                std::cmp::Ordering::Greater => high = mid,
            }
        }
        Ok(None)
    }
}

fn read_index_header(input: &mut impl Read, bytes: u64) -> Result<u64, PortError> {
    let mut head = [0; CAS_HEADER_BYTES as usize];
    input.read_exact(&mut head).map_err(io_error)?;
    let count = u64::from_be_bytes(head[8..].try_into().unwrap());
    if &head[..8] != CAS_INDEX_MAGIC
        || count
            .checked_mul(CAS_RECORD_BYTES)
            .and_then(|size| size.checked_add(CAS_HEADER_BYTES))
            != Some(bytes)
    {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    Ok(count)
}

fn check_index_and_data(
    index: &mut CasIndex,
    data: ArchiveRange,
    budget: &CallBudget,
    options: &BackupOptions,
) -> Result<(u64, u64), PortError> {
    if index.count > options.max_index_records {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut offset = 0_u64;
    let mut total_raw = 0_u64;
    let mut previous = None;
    for position in 0..index.count {
        let record = index.read(position)?;
        let key = (record.space.clone(), record.digest);
        if record.offset != offset
            || record.compressed == 0
            || previous
                .as_ref()
                .is_some_and(|key_before| key_before >= &key)
        {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
        total_raw = total_raw
            .checked_add(record.raw)
            .filter(|size| *size <= crate::backup_format::raw_cas_limit(options.max_archive_bytes))
            .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
        let slice = data
            .view(record.offset, record.compressed)
            .map_err(io_error)?;
        verify_frame(slice, &record, budget)?;
        offset += record.compressed;
        previous = Some(key);
    }
    if offset != data.len() {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    Ok((index.count, total_raw))
}

fn verify_frame(
    input: impl Read + Seek,
    record: &CasRecord,
    budget: &CallBudget,
) -> Result<(), PortError> {
    let mut decoder = zstd::stream::read::Decoder::new(input)
        .map_err(io_error)?
        .single_frame();
    decoder.window_log_max(23).map_err(io_error)?;
    let raw = copy_hash(
        &mut decoder,
        &mut io::sink(),
        record.raw,
        &budget.cancellation,
    )?;
    let mut source = decoder.finish();
    if raw.bytes != record.raw
        || raw.digest != record.digest
        || source.stream_position().map_err(io_error)? != record.compressed
    {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(())
}

fn cursor(space: &str, history: &[u8], seq: i64) -> Result<ChangeCursor, PortError> {
    Ok(ChangeCursor {
        scope: HistoryScope {
            space_id: SpaceId::parse(space)?,
            incarnation: HistoryIncarnation::from_bytes(
                history
                    .try_into()
                    .map_err(|_| invalid(ValidationReason::InvalidState))?,
            ),
        },
        after: SpaceSeq::new(
            u64::try_from(seq).map_err(|_| invalid(ValidationReason::InvalidState))?,
        )?,
    })
}

async fn verify_live(
    ctx: MaintenanceContext,
    canonical: &CanonicalStore,
    control: &ControlBackup,
    external_keyring: &Path,
    options: BackupOptions,
) -> Result<FsckReport, PortError> {
    let budget = ctx.budget;
    let mut pair = capture_pair(
        MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Backup),
            budget: budget.clone(),
        },
        canonical,
        control,
    )
    .await?;
    let installation = pair.canonical_spool.receipt().witness.installation.clone();
    let backend = pair.canonical_spool.receipt().kind;
    let verified: Result<_, PortError> = async {
        let (manifest, database_inputs) = live_inputs(&mut pair)?;
        let keys = external_keyring.to_owned();
        let database_budget = budget.clone();
        let verify_options = options.clone();
        let spools = (pair.control_spool.clone(), pair.canonical_spool.clone());
        let databases = pair
            .workers
            .spawn(move || {
                let _spools = spools;
                check_cancelled(&database_budget.cancellation)?;
                verify_databases(
                    database_inputs.0,
                    database_inputs.1,
                    &manifest,
                    &keys,
                    &database_budget,
                    &verify_options,
                    None,
                )
            })?
            .wait(&budget.cancellation)
            .await?;
        let (blobs, raw_blob_bytes) =
            crate::backup::verify_live_cas(canonical, &budget, &mut pair, options).await?;
        Ok(FsckReport {
            installation,
            backend,
            archive_digest: None,
            spaces: databases.histories.len(),
            blobs,
            raw_blob_bytes,
            readable_keys: databases.keys.len(),
            sqlite_native_peak_bytes: databases.native_peak,
        })
    }
    .await;
    let released = pair.release().await;
    let report = verified?;
    released?;
    Ok(report)
}

fn live_inputs(
    pair: &mut crate::backup::Pair,
) -> Result<(Manifest, (ArchiveRange, ArchiveRange)), PortError> {
    let ctrl = pair.control.try_clone().map_err(io_error)?;
    let canon = pair.canonical.try_clone().map_err(io_error)?;
    let empty = Payload {
        bytes: 0,
        digest: ContentDigest::from_bytes([0; 32]),
    };
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
        index: empty,
        cas: empty,
    };
    let control: Box<dyn SeekRead> = Box::new(ctrl);
    let canonical: Box<dyn SeekRead> = Box::new(canon);
    Ok((
        manifest,
        (
            RangeSource::new(control).map_err(io_error)?,
            RangeSource::new(canonical).map_err(io_error)?,
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_empty_space_requires_its_root() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(notarium_canonical::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        db.execute(
            "INSERT INTO spaces VALUES(
                'test-space',zeroblob(16),'missing-root','test','test','shared',
                'owner','active',1,0,'{}',0,0
            )",
            [],
        )
        .unwrap();
        let pragma: String = db
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pragma, "ok");
        assert_eq!(
            db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0,
        );
        assert!(verify_sqlite_references(&db, None, &Default::default()).is_err());
    }
}
