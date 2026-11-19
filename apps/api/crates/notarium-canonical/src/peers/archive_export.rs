use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        ArtifactId, BackupId, ChatThreadId, ContentDigest, FolderId, JobId, NoteId, PrincipalId,
        SpaceId, SpaceSeq,
    },
    model::HistoryScope,
    ports::{BackupHold, CallBudget, ContentJobKind, SpaceContext},
};
use notarium_syntax::unicode::{PortableFilename, lookup_key};
use serde::Serialize;
use sqlx::Row;

use crate::{
    CanonicalStore, ClaimedContentJob,
    codec::{
        MAX_MSGPACK_DECODE_BYTES, decode_msgpack_bounded, doc_class_from_db, encode_msgpack,
        internal_not_committed, ordered_id_16,
    },
    domain::common::CommandDeadline,
    runtime::{SqlDriverState, load_space_record},
    sql_exec::BackendConn,
};

use super::{
    archive_import::{ArchiveObject, ArchiveObjectKind},
    authorize_export_notes_tx, authorize_full_space_export, authorize_job_payload_tx,
    authorize_job_read_on_space, job_clock_ms, load_job_row_opt_tx, require_active_job_lease_tx,
};

mod versioned;
pub use versioned::VersionedChatEntries;

const CUT_LIMIT: Duration = Duration::from_millis(50);
const MAX_EXPORT_ITEMS: i64 = 200_000;
const MAX_INLINE_BYTES: u64 = 32 * 1024 * 1024;
const EXPORT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const SCHEMA_PATH: &str = ".notarium/fields/schema.yaml";

pub struct ExportCut {
    pub hold_id: BackupId,
    pub scope: HistoryScope,
    pub seq: SpaceSeq,
    pub generation: u64,
    pub entries: Vec<ExportEntry>,
    pub snapshot_elapsed: Duration,
    hold: Box<dyn BackupHold>,
}

impl ExportCut {
    pub async fn release(self) -> Result<(), PortError> {
        self.hold.release().await
    }
}

pub struct ExportEntry {
    pub path: String,
    pub data: ExportData,
}

pub enum ExportData {
    Blob(ContentDigest),
    Chat(ExportChat),
    PagedChat(ExportChatHeader, VersionedChatEntries),
}

#[derive(Serialize)]
pub struct ExportChatHeader {
    pub thread: ChatThreadId,
    pub owner: PrincipalId,
    pub kind: String,
    pub title: String,
    pub project: Option<FolderId>,
    pub head: u64,
}

pub struct ExportChat {
    pub header: ExportChatHeader,
    pub entries: Vec<ExportChatEntry>,
}

pub struct ExportChatEntry {
    pub seq: u64,
    pub parent: Option<u64>,
    pub kind: String,
    pub author: PrincipalId,
    pub seconds: i64,
    pub nanos: u32,
    pub body: ExportChatBody,
}

pub enum ExportChatBody {
    Inline(String),
    Blob(ContentDigest),
    Redacted,
}

#[derive(Clone, Debug)]
pub struct ExportPublication {
    pub object: ArchiveObject,
    pub cut: SpaceSeq,
    pub privacy_generation: u64,
    pub files: u64,
}

#[derive(Clone, Debug)]
pub struct CommittedExport {
    pub object: ArchiveObject,
    pub job: JobId,
    pub privacy_generation: u64,
    pub expires_at_ms: i64,
}

impl CanonicalStore {
    /// Returns a bounded worklist. The committed registry doubles as the
    /// cleanup journal until deletion of the exact sealed generation succeeds.
    pub async fn expired_export_objects(
        &self,
        budget: &CallBudget,
    ) -> Result<Vec<ArchiveObject>, PortError> {
        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                let now = job_clock_ms(tx).await?;
                let sql = "SELECT object_msgpack FROM archive_artifacts
                    WHERE expires_at_ms <= $1 ORDER BY expires_at_ms, space_id, artifact_id LIMIT 16";
                let rows: Vec<Vec<u8>> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(sql).bind(now).fetch_all(&mut **conn).await,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(sql).bind(now).fetch_all(&mut **conn).await,
                }.map_err(sql_error)?;
                rows.iter().map(|row| decode_msgpack_bounded(row, MAX_MSGPACK_DECODE_BYTES)).collect()
            })
        }).await
    }

    pub async fn forget_expired_export(
        &self,
        budget: &CallBudget,
        object: &ArchiveObject,
    ) -> Result<(), PortError> {
        let space = object.scope.space_id.clone();
        let id = object.id.clone();
        let exact = encode_msgpack(object)?;
        let deadline = CommandDeadline::start(budget, "forget_expired_export");
        self.with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                let now = job_clock_ms(tx).await?;
                let sql = "DELETE FROM archive_artifacts WHERE space_id=$1 AND artifact_id=$2
                    AND object_msgpack=$3 AND expires_at_ms <= $4";
                match tx {
                    BackendConn::Sqlite(conn) => sqlx::query(sql)
                        .bind(space.as_str())
                        .bind(id.as_str())
                        .bind(exact)
                        .bind(now)
                        .execute(&mut **conn)
                        .await
                        .map(|_| ()),
                    BackendConn::Postgres(conn) => sqlx::query(sql)
                        .bind(space.as_str())
                        .bind(id.as_str())
                        .bind(exact)
                        .bind(now)
                        .execute(&mut **conn)
                        .await
                        .map(|_| ()),
                }
                .map_err(sql_error)
            })
        })
        .await
    }

    pub async fn capture_archive_export(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
    ) -> Result<ExportCut, PortError> {
        let hold_id = BackupId::from_bytes(ordered_id_16()?);
        let scope = ctx.scope().clone();
        let hold = self
            .export_cas_hold(scope.clone(), &ctx.budget, hold_id.clone())
            .await?;
        let (seq, generation, entries, elapsed) = match self.capture_compact(ctx, claim).await {
            Ok(result) => result,
            Err(err) => {
                let size_limited = matches!(err, PortError::DeadlineExceeded(_))
                    || matches!(&err, PortError::Domain(DomainError::ValidationFailed { diagnostic })
                        if diagnostic.reason == ValidationReason::BudgetExceeded);
                match &claim.job.kind {
                    ContentJobKind::ExportSpace { encrypted } if size_limited => {
                        versioned::capture(
                            self,
                            ctx,
                            claim,
                            hold_id.clone(),
                            *encrypted,
                            std::future::ready(Ok(())),
                        )
                        .await?
                    }
                    _ => return Err(err),
                }
            }
        };
        tracing::debug!(
            snapshot_micros = elapsed.as_micros() as u64,
            files = entries.len(),
            "captured archive export manifest"
        );
        Self::finish_export_cut(hold, hold_id, scope, seq, generation, entries, elapsed)
    }

    #[cfg(feature = "test-support")]
    pub async fn capture_archive_export_paged(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
        after_registration: impl std::future::Future<Output = Result<(), PortError>>,
    ) -> Result<ExportCut, PortError> {
        let ContentJobKind::ExportSpace { encrypted } = claim.job.kind else {
            return Err(invalid(ValidationReason::InvalidAuthority));
        };
        let hold_id = BackupId::from_bytes(ordered_id_16()?);
        let scope = ctx.scope().clone();
        let hold = self
            .export_cas_hold(scope.clone(), &ctx.budget, hold_id.clone())
            .await?;
        let (seq, generation, entries, elapsed) = versioned::capture(
            self,
            ctx,
            claim,
            hold_id.clone(),
            encrypted,
            after_registration,
        )
        .await?;
        Self::finish_export_cut(hold, hold_id, scope, seq, generation, entries, elapsed)
    }

    fn finish_export_cut(
        hold: Box<dyn BackupHold>,
        hold_id: BackupId,
        scope: HistoryScope,
        seq: SpaceSeq,
        generation: u64,
        mut entries: Vec<ExportEntry>,
        snapshot_elapsed: Duration,
    ) -> Result<ExportCut, PortError> {
        // Validation and sorting need no SQL resources.
        validate_export_paths(&entries)?;
        entries.sort_by_cached_key(|entry| lookup_key(&entry.path));
        Ok(ExportCut {
            hold_id,
            scope,
            seq,
            generation,
            entries,
            snapshot_elapsed,
            hold,
        })
    }

    async fn capture_compact(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
    ) -> Result<(SpaceSeq, u64, Vec<ExportEntry>, Duration), PortError> {
        let scope = ctx.scope();
        let mut budget = ctx.budget.clone();
        budget.remaining = budget.remaining.min(CUT_LIMIT);
        let auth = ctx.auth().clone();
        let claimant = claim.clone();
        let started = Instant::now();
        let scoped = scope.clone();
        let native = match (&self.inner.sql, &claim.job.kind) {
            (
                SqlDriverState::Sqlite { fast_read_pool, .. },
                ContentJobKind::ExportSpace { encrypted },
            ) => {
                let wal = self
                    .inner
                    .wal_coord
                    .get()
                    .ok_or_else(|| invalid(ValidationReason::NotReady))?;
                let encrypted = *encrypted;
                let scoped = scope.clone();
                let auth = auth.clone();
                let claimant = claimant.clone();
                Some(
                    fast_read_pool
                        .with_read_conn_and_post(
                            wal,
                            Some(&budget),
                            true,
                            move |tx| capture_full_sqlite(tx, &scoped, &auth, &claimant, encrypted),
                            Ok,
                        )
                        .await?,
                )
            }
            _ => None,
        };
        let (seq, generation, entries) = if let Some(native) = native {
            native
        } else {
            self.with_read_tx_budget(Some(&budget), |tx| {
                Box::pin(async move {
                    let space = load_space_record(tx, &scoped.space_id).await?;
                    space.scope.check(&scoped)?;
                    authorize_job_write_for_export(&auth, &space)?;
                    let (job, _, erased) = require_active_job_lease_tx(
                        tx,
                        &scoped,
                        &claimant.job.id,
                        &claimant.lease_owner,
                        claimant.job.lease,
                    )
                    .await?;
                    if erased {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let generation = privacy_generation_tx(tx, &scoped.space_id).await?;
                    let entries = match job.kind {
                        ContentJobKind::Export { notes, encrypted } => {
                            authorize_export_notes_tx(tx, &space.space, &auth, &notes).await?;
                            note_entries(tx, &scoped, Some(&notes), encrypted).await?
                        }
                        ContentJobKind::ExportSpace { encrypted } => {
                            authorize_full_space_export(&auth, &space.space)?;
                            let mut files = note_entries(tx, &scoped, None, encrypted).await?;
                            add_package_entries(tx, &scoped, &mut files).await?;
                            add_chat_entries(tx, &space, &auth, &mut files).await?;
                            files
                        }
                        _ => return Err(invalid(ValidationReason::InvalidAuthority)),
                    };
                    Ok((space.last_seq, generation, entries))
                })
            })
            .await?
        };
        let snapshot_elapsed = started.elapsed();
        if snapshot_elapsed >= CUT_LIMIT {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        Ok((seq, generation, entries, snapshot_elapsed))
    }

    pub async fn check_export_generation(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        expected: u64,
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                let live = load_space_record(tx, &scope.space_id).await?;
                live.scope.check(&scope)?;
                if privacy_generation_tx(tx, &scope.space_id).await? != expected {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Ok(())
            })
        })
        .await
    }

    /// Linearize a bounded, already-read chunk against privacy commits. The
    /// handoff is synchronous and must never do I/O or wait on the recipient.
    pub async fn handoff_export_chunk(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        pointer: &CommittedExport,
        handoff: impl FnOnce() -> Result<(), PortError> + Send + 'static,
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        let generation = pointer.privacy_generation;
        let expires = pointer.expires_at_ms;
        let deadline = CommandDeadline::start(budget, "handoff_archive_chunk");
        let check = budget.clone();
        self.with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                // SQLite BEGIN IMMEDIATE owns the database writer. PostgreSQL
                // privacy triggers take the exclusive half of this Space lock.
                if let BackendConn::Postgres(conn) = tx {
                    let admitted: bool = sqlx::query_scalar(
                        "SELECT pg_try_advisory_xact_lock_shared(
                             hashtextextended(current_schema() || ':' || $1, 7311231))",
                    )
                    .bind(scope.space_id.as_str())
                    .fetch_one(&mut **conn)
                    .await
                    .map_err(sql_error)?;
                    if !admitted {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                }
                let live = load_space_record(tx, &scope.space_id).await?;
                live.scope.check(&scope)?;
                if expires <= job_clock_ms(tx).await?
                    || privacy_generation_tx(tx, &scope.space_id).await? != generation
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                deadline.remaining(&check)?;
                handoff()
            })
        })
        .await
    }

    /// Read the pointer and authorize the selected notes or whole scope in the
    /// same snapshot. Physical bytes are delivered after this transaction closes.
    pub async fn open_committed_export(
        &self,
        ctx: SpaceContext,
        id: &ArtifactId,
    ) -> Result<CommittedExport, PortError> {
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        let id = id.clone();
        let installation = self.installation_id().clone();
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let live = load_space_record(tx, &scope.space_id).await?;
                live.scope.check(&scope)?;
                authorize_job_read_on_space(&auth, &live.space)?;
                let pointer = read_pointer_tx(tx, &scope.space_id, &id).await?;
                if pointer.expires_at_ms <= job_clock_ms(tx).await?
                    || pointer.privacy_generation
                        != privacy_generation_tx(tx, &scope.space_id).await?
                    || pointer.object.installation != installation
                    || pointer.object.scope != scope
                    || pointer.object.id != id
                    || pointer.object.kind != ArchiveObjectKind::Export
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let (job, _, _, _, erased, _) =
                    load_job_row_opt_tx(tx, &scope.space_id, &pointer.job)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                if job.state != notarium_core::ports::JobState::Succeeded
                    || erased
                    || !job.artifacts.contains(&id)
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                authorize_job_payload_tx(tx, &live.space, &auth, &job).await?;
                Ok(pointer)
            })
        })
        .await
    }
}

fn authorize_job_write_for_export(
    auth: &notarium_core::auth::EngineAuthContext,
    space: &crate::SpaceRecord,
) -> Result<(), PortError> {
    super::authorize_job_write_on_space(auth, &space.space)?;
    Ok(())
}

fn capture_full_sqlite(
    tx: &rusqlite::Connection,
    scope: &HistoryScope,
    auth: &notarium_core::auth::EngineAuthContext,
    claim: &ClaimedContentJob,
    encrypted: bool,
) -> Result<(SpaceSeq, u64, Vec<ExportEntry>), PortError> {
    use rusqlite::{OptionalExtension, params};

    let space = crate::sqlite_fast::load_space_record_rusqlite(tx, &scope.space_id)?;
    space.scope.check(scope)?;
    authorize_job_write_for_export(auth, &space)?;
    authorize_full_space_export(auth, &space.space)?;
    let sid = scope.space_id.as_str();
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM content_jobs WHERE space_id=?1 AND job_id=?2 AND job_kind='export'
         AND state='running' AND lease_owner=?3 AND lease_epoch=?4 AND lease_until_ms>?5
         AND claim_space_epoch=?6 AND payload_erased_by_purge=0)",
        params![sid, claim.job.id.as_str(), &claim.lease_owner, claim.job.lease.get() as i64,
            super::now_unix_ms()?, space.active_epoch.get() as i64],
        |row| row.get(0),
    ).map_err(native_error)?;
    if !exists {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    let generation = tx
        .query_row(
            "SELECT generation FROM archive_privacy WHERE space_id=?1",
            [sid],
            |row| row.get(0),
        )
        .optional()
        .map_err(native_error)?
        .unwrap_or(0);
    let mut notes = tx
        .prepare_cached(note_export_query!("SELECT value FROM json_each($2)"))
        .map_err(native_error)?;
    let notes = notes
        .query_map(
            params![sid, rusqlite::types::Null, MAX_EXPORT_ITEMS + 1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(native_error)?
        .collect::<Result<Vec<NoteExportRow>, _>>()
        .map_err(native_error)?;
    let mut files = validated_note_entries(notes, None, encrypted)?;
    let limit = MAX_EXPORT_ITEMS - files.len() as i64;
    let mut packages = tx.prepare_cached(PACKAGES).map_err(native_error)?;
    let packages = packages
        .query_map(params![sid, limit + 1], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(native_error)?
        .collect::<Result<Vec<PackageExportRow>, _>>()
        .map_err(native_error)?;
    insert_package_entries(&mut files, limit, packages)?;
    let limit = MAX_EXPORT_ITEMS - files.len() as i64;
    let mut heads = tx.prepare_cached(CHAT_HEADS).map_err(native_error)?;
    let heads = heads
        .query_map(
            params![sid, scope.incarnation.as_bytes().as_slice(), limit + 1],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .map_err(native_error)?
        .collect::<Result<Vec<ChatExportHead>, _>>()
        .map_err(native_error)?;
    let mut chats = index_chat_headers(&space, auth, limit, heads)?;
    let mut read = tx.prepare_cached(CHAT_ROWS).map_err(native_error)?;
    let mut rows = read
        .query(params![sid, MAX_EXPORT_ITEMS + 1])
        .map_err(native_error)?;
    let mut counts = (0, 0);
    while let Some(row) = rows.next().map_err(native_error)? {
        let row = (|| -> Result<ChatRow, rusqlite::Error> {
            Ok(ChatRow {
                thread: row.get(0)?,
                seq: row.get(1)?,
                parent: row.get(2)?,
                kind: row.get(3)?,
                author: row.get(4)?,
                inline: row.get(5)?,
                reference: row.get(6)?,
                seconds: row.get(7)?,
                nanos: row.get(8)?,
                stale: row.get(9)?,
            })
        })()
        .map_err(native_error)?;
        insert_chat_row(&mut chats, &mut counts, row)?;
    }
    append_chats(&mut files, chats);
    Ok((space.last_seq, unsigned(generation)?, files))
}

fn native_error(err: rusqlite::Error) -> PortError {
    crate::sqlite_fast::map_interrupt_or_internal(err, "capture_archive_export")
}

async fn privacy_generation_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
) -> Result<u64, PortError> {
    const SQL: &str = "SELECT generation FROM archive_privacy WHERE space_id=$1";
    let value: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SQL)
                .bind(space.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SQL)
                .bind(space.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(sql_error)?;
    u64::try_from(value.unwrap_or(0)).map_err(|_| invalid(ValidationReason::InvalidState))
}

pub(super) async fn insert_export_pointer_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    job: &JobId,
    now: i64,
    publication: &ExportPublication,
) -> Result<(), PortError> {
    publication.object.scope.check(scope)?;
    if publication.object.kind != ArchiveObjectKind::Export
        || publication.privacy_generation != privacy_generation_tx(tx, &scope.space_id).await?
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let encoded = encode_msgpack(&publication.object)?;
    if encoded.len() > MAX_MSGPACK_DECODE_BYTES {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let expires_at = now
        .checked_add(EXPORT_TTL_MS)
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
    const SQL: &str = "INSERT INTO archive_artifacts(space_id, artifact_id, job_id, privacy_generation, expires_at_ms, object_msgpack)
        VALUES($1,$2,$3,$4,$5,$6)";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(SQL)
            .bind(scope.space_id.as_str())
            .bind(publication.object.id.as_str())
            .bind(job.as_str())
            .bind(publication.privacy_generation as i64)
            .bind(expires_at)
            .bind(&encoded)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(SQL)
            .bind(scope.space_id.as_str())
            .bind(publication.object.id.as_str())
            .bind(job.as_str())
            .bind(publication.privacy_generation as i64)
            .bind(expires_at)
            .bind(&encoded)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(sql_error)
}

async fn read_pointer_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    artifact: &ArtifactId,
) -> Result<CommittedExport, PortError> {
    const SQL: &str = "SELECT job_id, privacy_generation, expires_at_ms, object_msgpack
        FROM archive_artifacts WHERE space_id=$1 AND artifact_id=$2";
    let row: Option<(String, i64, i64, Vec<u8>)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SQL)
                .bind(space.as_str())
                .bind(artifact.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(SQL)
                .bind(space.as_str())
                .bind(artifact.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(sql_error)?;
    let (job, generation, expires_at_ms, bytes) = row.ok_or(DomainError::ResourceNotFound)?;
    Ok(CommittedExport {
        object: decode_msgpack_bounded(&bytes, MAX_MSGPACK_DECODE_BYTES)?,
        job: JobId::parse(&job)?,
        privacy_generation: generation as u64,
        expires_at_ms,
    })
}

async fn note_entries(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    notes: Option<&[NoteId]>,
    encrypted: bool,
) -> Result<Vec<ExportEntry>, PortError> {
    let selected = notes.map(|notes| notes.iter().map(NoteId::as_str).collect::<BTreeSet<_>>());
    let selection = selected
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| internal_not_committed("export_selection", err.to_string()))?;
    let rows: Vec<NoteExportRow> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(note_export_query!("SELECT value FROM json_each($2)"))
                .bind(scope.space_id.as_str())
                .bind(selection)
                .bind(MAX_EXPORT_ITEMS + 1)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(note_export_query!(
                "SELECT jsonb_array_elements_text(CAST(CAST($2 AS TEXT) AS JSONB))"
            ))
            .bind(scope.space_id.as_str())
            .bind(selection)
            .bind(MAX_EXPORT_ITEMS + 1)
            .fetch_all(&mut **conn)
            .await
        }
    }
    .map_err(sql_error)?;
    validated_note_entries(rows, selected.as_ref().map(BTreeSet::len), encrypted)
}

macro_rules! note_export_query {
    ($selection:literal) => {
        concat!(
            "WITH RECURSIVE paths(folder_id, name, depth) AS (
                  SELECT folder_id, CAST('' AS TEXT), 0 FROM folder_heads
                    WHERE space_id=$1 AND is_root=1 AND lifecycle_state='active'
                  UNION ALL
                  SELECT h.folder_id, p.name || h.slug || '/', p.depth+1
                    FROM folder_heads h JOIN paths p ON h.parent_folder_id=p.folder_id
                    WHERE h.space_id=$1 AND h.lifecycle_state='active' AND p.depth<256
                 ), schema_note AS (
                   SELECT schema_note_id,created_seq FROM space_field_schemas
                   WHERE space_id=$1 AND is_current=1 AND CAST($2 AS TEXT) IS NULL
                 )
                 SELECT n.note_id, p.name || n.slug || '.md' AS rel_path, n.doc_class, n.content_blake3
                 FROM note_heads n JOIN paths p ON n.parent_folder_id=p.folder_id
                 WHERE n.space_id=$1 AND n.lifecycle_state='active'
                   AND ((CAST($2 AS TEXT) IS NULL AND n.ability_id IS NULL
                         AND NOT EXISTS(SELECT 1 FROM schema_note s WHERE s.schema_note_id=n.note_id))
                        OR n.note_id IN (", $selection, "))
                 UNION ALL
                 SELECT s.schema_note_id, '.notarium/fields/schema.yaml', 'user-doc', r.content_blake3
                   FROM schema_note s LEFT JOIN revisions r ON r.space_id=$1 AND r.entity_type='note'
                    AND r.entity_key=s.schema_note_id AND r.space_seq=s.created_seq
                 LIMIT $3"
        )
    };
}
use note_export_query;

type NoteExportRow = (String, String, String, Option<Vec<u8>>);

fn validated_note_entries(
    rows: Vec<NoteExportRow>,
    selected: Option<usize>,
    encrypted: bool,
) -> Result<Vec<ExportEntry>, PortError> {
    if rows.len() > MAX_EXPORT_ITEMS as usize {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    if selected.is_some_and(|count| rows.len() != count) {
        return Err(DomainError::ResourceNotFound.into());
    }
    rows.into_iter()
        .map(|(_, path, class, bytes)| {
            if doc_class_from_db(&class)? == DocClass::EncryptedNote && !encrypted {
                return Err(invalid(ValidationReason::ClassEgressForbidden));
            }
            Ok(ExportEntry {
                path,
                data: ExportData::Blob(digest(
                    bytes.ok_or_else(|| invalid(ValidationReason::InvalidDigest))?,
                )?),
            })
        })
        .collect()
}

async fn add_package_entries(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    entries: &mut Vec<ExportEntry>,
) -> Result<(), PortError> {
    let limit = MAX_EXPORT_ITEMS - entries.len() as i64;
    let files: Vec<PackageExportRow> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(PACKAGES)
                .bind(scope.space_id.as_str())
                .bind(limit + 1)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(PACKAGES)
                .bind(scope.space_id.as_str())
                .bind(limit + 1)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(sql_error)?;
    insert_package_entries(entries, limit, files)
}

const PACKAGES: &str = "SELECT a.slug_fold, r.resource_key, r.content_blake3
    FROM ability_packages a JOIN blob_references r ON r.space_id=a.space_id
      AND r.owner_kind='ability_resource' AND r.owner_id=a.ability_id AND r.owner_rev_id=a.manifest_rev_id
    WHERE a.space_id=$1 AND a.lifecycle_state='active' LIMIT $2";

type PackageExportRow = (String, String, Vec<u8>);

fn insert_package_entries(
    entries: &mut Vec<ExportEntry>,
    limit: i64,
    files: Vec<PackageExportRow>,
) -> Result<(), PortError> {
    if files.len() > limit as usize {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    for (slug, path, bytes) in files {
        entries.push(ExportEntry {
            path: format!(".notarium/abilities/{slug}/{path}"),
            data: ExportData::Blob(digest(bytes)?),
        });
    }
    Ok(())
}

async fn add_chat_entries(
    tx: &mut BackendConn<'_>,
    space: &crate::SpaceRecord,
    auth: &notarium_core::auth::EngineAuthContext,
    entries: &mut Vec<ExportEntry>,
) -> Result<(), PortError> {
    let limit = MAX_EXPORT_ITEMS - entries.len() as i64;
    let heads: Vec<ChatExportHead> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(CHAT_HEADS)
                .bind(space.scope.space_id.as_str())
                .bind(space.scope.incarnation.as_bytes().as_slice())
                .bind(limit + 1)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(CHAT_HEADS)
                .bind(space.scope.space_id.as_str())
                .bind(space.scope.incarnation.as_bytes().as_slice())
                .bind(limit + 1)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(sql_error)?;
    let mut chats = index_chat_headers(space, auth, limit, heads)?;
    load_chat_entries(tx, space, &mut chats).await?;
    append_chats(entries, chats);
    Ok(())
}

const CHAT_HEADS: &str = "SELECT thread_id, owner_id, kind,title,project_folder_id,
    CAST(ext_space_tainted_mask AS BIGINT),head_leaf_seq FROM chat_threads
    WHERE space_id=$1 AND history_incarnation=$2 ORDER BY thread_id LIMIT $3";
const CHAT_ROWS: &str = "SELECT e.thread_id,e.entry_seq,e.parent_seq,e.kind,e.author_id,e.inline_text,
    e.payload_blake3,r.created_at_sec,CAST(COALESCE(r.created_at_nsec,-1) AS BIGINT),CAST(e.checkpoint_stale AS BIGINT)
    FROM chat_entries e LEFT JOIN change_log l ON l.space_id=e.space_id AND l.space_seq=e.created_space_seq
        AND l.entity_type='thread' AND l.entity_id=e.thread_id
    LEFT JOIN revisions r ON r.space_id=e.space_id AND r.rev_id=l.rev_id
    WHERE e.space_id=$1 ORDER BY e.thread_id,e.entry_seq LIMIT $2";
type ChatExportHead = (String, String, String, String, Option<String>, i64, i64);

fn index_chat_headers(
    space: &crate::SpaceRecord,
    auth: &notarium_core::auth::EngineAuthContext,
    limit: i64,
    heads: Vec<ChatExportHead>,
) -> Result<BTreeMap<String, ExportChat>, PortError> {
    if heads.len() > limit as usize {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut chats = BTreeMap::new();
    for (thread, owner, kind, title, project, tainted, head) in heads {
        let project = project.as_deref().map(FolderId::parse).transpose()?;
        auth.authorize_chat_read(&space.space, project.as_ref(), tainted != 0)?;
        let owner = PrincipalId::parse(&owner)?;
        if kind != "space_group" && &owner != auth.principal() {
            return Err(DomainError::AccessDenied.into());
        }
        let id = ChatThreadId::parse(&thread)?;
        chats.insert(
            thread,
            ExportChat {
                header: ExportChatHeader {
                    thread: id,
                    owner,
                    kind,
                    title,
                    project,
                    head: unsigned(head)?,
                },
                entries: Vec::new(),
            },
        );
    }
    Ok(chats)
}

fn append_chats(entries: &mut Vec<ExportEntry>, chats: BTreeMap<String, ExportChat>) {
    entries.extend(chats.into_iter().map(|(thread, chat)| ExportEntry {
        path: format!("chats/{thread}.jsonl"),
        data: ExportData::Chat(chat),
    }));
}

async fn load_chat_entries(
    tx: &mut BackendConn<'_>,
    space: &crate::SpaceRecord,
    chats: &mut BTreeMap<String, ExportChat>,
) -> Result<(), PortError> {
    use futures_util::TryStreamExt;
    let mut cargo = (0, 0);
    macro_rules! read_rows {
        ($conn:expr, $add:ident) => {{
            let mut rows = sqlx::query(CHAT_ROWS)
                .bind(space.scope.space_id.as_str())
                .bind(MAX_EXPORT_ITEMS + 1)
                .fetch(&mut **$conn);
            while let Some(row) = rows.try_next().await.map_err(sql_error)? {
                $add(chats, row, &mut cargo)?;
            }
        }};
    }
    match tx {
        BackendConn::Sqlite(conn) => read_rows!(conn, add_sqlite_chat_row),
        BackendConn::Postgres(conn) => read_rows!(conn, add_pg_chat_row),
    }
    Ok(())
}

macro_rules! chat_row {
    ($name:ident, $row:ty) => {
        fn $name(
            chats: &mut BTreeMap<String, ExportChat>,
            row: $row,
            cargo: &mut (i64, u64),
        ) -> Result<(), PortError> {
            let (thread, seq, parent, kind, author, inline, reference, seconds, nanos, stale) = (
                row.try_get::<String, _>(0).map_err(sql_error)?,
                row.try_get::<i64, _>(1).map_err(sql_error)?,
                row.try_get::<Option<i64>, _>(2).map_err(sql_error)?,
                row.try_get::<String, _>(3).map_err(sql_error)?,
                row.try_get::<String, _>(4).map_err(sql_error)?,
                row.try_get::<Option<String>, _>(5).map_err(sql_error)?,
                row.try_get::<Option<Vec<u8>>, _>(6).map_err(sql_error)?,
                row.try_get::<i64, _>(7).map_err(sql_error)?,
                row.try_get::<i64, _>(8).map_err(sql_error)?,
                row.try_get::<i64, _>(9).map_err(sql_error)?,
            );
            insert_chat_row(
                chats,
                cargo,
                ChatRow {
                    thread,
                    seq,
                    parent,
                    kind,
                    author,
                    inline,
                    reference,
                    seconds,
                    nanos,
                    stale,
                },
            )
        }
    };
}

struct ChatRow {
    thread: String,
    seq: i64,
    parent: Option<i64>,
    kind: String,
    author: String,
    inline: Option<String>,
    reference: Option<Vec<u8>>,
    seconds: i64,
    nanos: i64,
    stale: i64,
}

chat_row!(add_sqlite_chat_row, sqlx::sqlite::SqliteRow);
chat_row!(add_pg_chat_row, sqlx::postgres::PgRow);

fn insert_chat_row(
    chats: &mut BTreeMap<String, ExportChat>,
    counts: &mut (i64, u64),
    row: ChatRow,
) -> Result<(), PortError> {
    counts.0 += 1;
    counts.1 += row.inline.as_ref().map_or(0, |inline| inline.len() as u64);
    if counts.0 > MAX_EXPORT_ITEMS || counts.1 > MAX_INLINE_BYTES {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let Some(chat) = chats.get_mut(&row.thread) else {
        return Err(invalid(ValidationReason::InvalidState));
    };
    chat.entries.push(chat_entry(row)?);
    Ok(())
}

fn chat_entry(row: ChatRow) -> Result<ExportChatEntry, PortError> {
    let body = match (row.inline, row.reference) {
        _ if row.kind == "redacted" || row.stale != 0 => ExportChatBody::Redacted,
        (Some(text), None) => ExportChatBody::Inline(text),
        (None, Some(bytes)) => ExportChatBody::Blob(digest(bytes)?),
        _ => return Err(invalid(ValidationReason::InvalidState)),
    };
    Ok(ExportChatEntry {
        seq: unsigned(row.seq)?,
        parent: row.parent.map(unsigned).transpose()?,
        kind: row.kind,
        author: PrincipalId::parse(&row.author)?,
        seconds: row.seconds,
        nanos: u32::try_from(row.nanos).map_err(|_| invalid(ValidationReason::InvalidTimestamp))?,
        body,
    })
}

fn validate_export_paths(entries: &[ExportEntry]) -> Result<(), PortError> {
    let mut files = BTreeSet::new();
    let mut directories = BTreeMap::new();
    for entry in entries {
        for component in entry.path.split('/') {
            PortableFilename::parse(component)?;
        }
        let key = lookup_key(&entry.path);
        if directories.contains_key(&key) || !files.insert(key) {
            return Err(invalid(ValidationReason::ArchivePathConflict));
        }
        for (index, _) in entry.path.match_indices('/') {
            let path = &entry.path[..index];
            let key = lookup_key(path);
            if files.contains(&key) || *directories.entry(key).or_insert(path) != path {
                return Err(invalid(ValidationReason::ArchivePathConflict));
            }
        }
    }
    Ok(())
}

fn digest(bytes: Vec<u8>) -> Result<ContentDigest, PortError> {
    Ok(ContentDigest::from_bytes(
        bytes
            .try_into()
            .map_err(|_| invalid(ValidationReason::InvalidDigest))?,
    ))
}

fn unsigned(value: i64) -> Result<u64, PortError> {
    u64::try_from(value).map_err(|_| invalid(ValidationReason::InvalidState))
}

fn sql_error(err: sqlx::Error) -> PortError {
    crate::runtime::pg_read_error("capture_archive_export", err)
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}
