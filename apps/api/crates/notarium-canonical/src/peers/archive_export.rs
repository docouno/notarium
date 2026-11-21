use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, JobDelegation},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        ArtifactId, BackupId, ChatThreadId, ContentDigest, FolderId, JobId, PrincipalId, SpaceId,
        SpaceSeq,
    },
    model::HistoryScope,
    ports::{BackupHold, CallBudget, ContentJobKind, RevocationLease, SpaceContext},
};
use notarium_syntax::unicode::{PortableFilename, lookup_key};
use serde::Serialize;
use sqlx::Row;

use crate::{
    CanonicalStore, ClaimedContentJob,
    codec::{
        MAX_MSGPACK_DECODE_BYTES, cancelled_not_committed, decode_msgpack_bounded,
        doc_class_from_db, encode_msgpack, ordered_id_16,
    },
    domain::common::CommandDeadline,
    runtime::{SqlDriverState, load_space_record},
    sql_exec::BackendConn,
};

use super::{
    ArchiveCleanupCursor, StoredJobPayloadV1,
    archive_import::{ArchiveObject, ArchiveObjectKind},
    authorize_full_space_export, authorize_job_read_on_space, decode_job_payload, job_clock_ms,
    require_active_job_lease_tx, visit_authorized_export_notes_tx,
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

/// An opened, immutable publication bound to its two credential ceilings.
pub struct CommittedExport {
    object: ArchiveObject,
    binding: ExportBinding,
    caller: JobDelegation,
    origin: JobDelegation,
    selection: ExportSelection,
}

#[derive(Clone)]
enum ExportSelection {
    WholeSpace,
    Selected(Arc<SelectedNotes>),
}

struct SelectedNotes {
    count: usize,
    // This reader has one immutable history and privacy generation. Its
    // canonical visibility facts can be reused only at the same Space sequence.
    visible: Mutex<Option<(SpaceSeq, BTreeSet<DocClass>)>>,
}

struct ExportAccess {
    seq: SpaceSeq,
    caller: EngineAuthContext,
    origin: Option<EngineAuthContext>,
    selection: ExportSelection,
}

#[derive(Clone)]
struct ExportBinding {
    id: ArtifactId,
    job: JobId,
    generation: u64,
    expires: i64,
    namespace: ContentDigest,
}

impl CommittedExport {
    pub fn object(&self) -> &ArchiveObject {
        &self.object
    }

    pub fn expires_at_ms(&self) -> i64 {
        self.binding.expires
    }

    pub fn caller(&self) -> &JobDelegation {
        &self.caller
    }

    pub fn origin(&self) -> &JobDelegation {
        &self.origin
    }
}

type RegisteredAuthority = (SpaceContext, Box<dyn RevocationLease>);

/// Issued after the live visibility check and consumed by one handoff.
pub struct ExportChunkPermit {
    binding: ExportBinding,
    installation: notarium_core::ids::InstallationId,
    scope: HistoryScope,
    access: ExportAccess,
    caller_registration: Box<dyn RevocationLease>,
    origin_registration: Option<Box<dyn RevocationLease>>,
}

enum ChunkState {
    Pending,
    Delivered,
    Closed,
}

struct ChunkDelivery(Arc<Mutex<ChunkState>>);

impl ChunkDelivery {
    fn settle(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|err| err.into_inner());
        if matches!(*state, ChunkState::Delivered) {
            return true;
        }
        *state = ChunkState::Closed;
        false
    }
}

impl Drop for ChunkDelivery {
    fn drop(&mut self) {
        self.settle();
    }
}

impl CanonicalStore {
    /// Returns a bounded worklist. The committed registry doubles as the
    /// cleanup journal until deletion of the exact sealed generation succeeds.
    pub async fn expired_export_objects(
        &self,
        budget: &CallBudget,
        namespace: ContentDigest,
        after: Option<&ArchiveCleanupCursor>,
    ) -> Result<Vec<(ArchiveCleanupCursor, ArchiveObject)>, PortError> {
        let ArchiveCleanupCursor(created, space, artifact) = ArchiveCleanupCursor::after(after);
        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                let now = job_clock_ms(tx).await?;
                let sql = "SELECT expires_at_ms,space_id,artifact_id,object_msgpack FROM archive_artifacts
                    WHERE object_namespace=$2 AND expires_at_ms <= $1
                    AND (expires_at_ms,space_id,artifact_id)>($3,$4,$5)
                    ORDER BY expires_at_ms,space_id,artifact_id LIMIT 16";
                macro_rules! get {
                    ($conn:expr) => {
                        sqlx::query_as(sql).bind(now).bind(namespace.as_bytes().as_slice())
                            .bind(created).bind(&space).bind(&artifact).fetch_all(&mut **$conn).await
                    };
                }
                let rows: Vec<(i64, String, String, Vec<u8>)> = match tx {
                    BackendConn::Sqlite(conn) => get!(conn),
                    BackendConn::Postgres(conn) => get!(conn),
                }.map_err(sql_error)?;
                rows.into_iter().map(|(expires, space, id, bytes)| {
                    Ok((
                        ArchiveCleanupCursor(expires, space, id),
                        decode_msgpack_bounded(&bytes, MAX_MSGPACK_DECODE_BYTES)?,
                    ))
                }).collect()
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
                    ContentJobKind::Export { .. }
                        if size_limited && ctx.budget.remaining >= CUT_LIMIT =>
                    {
                        return Err(invalid(ValidationReason::BudgetExceeded));
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
                    let (job, _, erased, _) = require_active_job_lease_tx(
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
                            selected_note_entries(tx, &space.space, &auth, &notes, encrypted)
                                .await?
                        }
                        ContentJobKind::ExportSpace { encrypted } => {
                            authorize_full_space_export(&auth, &space.space)?;
                            let mut files = note_entries(tx, &scoped, encrypted).await?;
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
        permit: ExportChunkPermit,
        handoff: impl FnOnce() -> Result<(), PortError> + Send + 'static,
    ) -> Result<(), PortError> {
        if &permit.installation != self.installation_id() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let ExportChunkPermit {
            binding,
            scope,
            access,
            caller_registration,
            origin_registration,
            ..
        } = permit;
        let store = self.clone();
        let deadline = CommandDeadline::start(budget, "handoff_archive_chunk");
        let check = budget.clone();
        let delivery = ChunkDelivery(Arc::new(Mutex::new(ChunkState::Pending)));
        let state = delivery.0.clone();
        let result = self
            .with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
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
                    check_publication_tx(tx, &scope.space_id, &binding).await?;
                    if live.last_seq != access.seq {
                        store
                            .authorize_export_selection_tx(
                                tx,
                                &live,
                                &binding.job,
                                &access.selection,
                                &access.caller,
                                access.origin.as_ref(),
                            )
                            .await?;
                    }
                    // Serialize the synchronous enqueue with revocation of the
                    // caller's wait. An accepted transfer has its own receipt.
                    let mut state = state.lock().unwrap_or_else(|err| err.into_inner());
                    if matches!(*state, ChunkState::Closed) {
                        return Err(cancelled_not_committed(
                            "handoff_archive_chunk",
                            "download closed before handoff",
                        ));
                    }
                    deadline.remaining(&check)?;
                    caller_registration.check()?;
                    if let Some(origin) = &origin_registration {
                        origin.check()?;
                    }
                    handoff()?;
                    *state = ChunkState::Delivered;
                    Ok(())
                })
            })
            .await;
        if delivery.settle() { Ok(()) } else { result }
    }

    /// Ask the authentication owner for the original authority after loading
    /// its immutable binding. Release the descriptor only after both authorities
    /// pass visibility checks in a current canonical snapshot.
    pub async fn open_committed_export(
        &self,
        ctx: SpaceContext,
        id: &ArtifactId,
        refresh_origin: impl AsyncFnOnce(&JobDelegation) -> Result<SpaceContext, PortError>,
    ) -> Result<CommittedExport, PortError> {
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        let id = id.clone();
        let store = self.clone();
        let pointer = self
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    let live = load_space_record(tx, &scope.space_id).await?;
                    live.scope.check(&scope)?;
                    authorize_job_read_on_space(&auth, &live.space)?;
                    let caller =
                        JobDelegation::capture(&auth, &scope).ok_or(DomainError::AccessDenied)?;
                    let (object, binding) = store.read_pointer_tx(tx, &scope.space_id, &id).await?;
                    if object.installation != *store.installation_id()
                        || object.scope != scope
                        || object.kind != ArchiveObjectKind::Export
                        || object.id != id
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    check_publication_tx(tx, &scope.space_id, &binding).await?;
                    let (origin, selection) =
                        store.read_export_policy_tx(tx, &scope, &binding).await?;
                    if origin.principal() != caller.principal() || origin.scope() != &scope {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    Ok(CommittedExport {
                        object,
                        binding,
                        caller,
                        origin,
                        selection,
                    })
                })
            })
            .await?;
        let origin = if pointer.caller != pointer.origin {
            Some(refresh_origin(&pointer.origin).await?)
        } else {
            None
        };
        self.revalidate_committed_export(&ctx, origin.as_ref(), &pointer)
            .await?;
        Ok(pointer)
    }

    pub async fn authorize_export_chunk(
        &self,
        pointer: &CommittedExport,
        caller: RegisteredAuthority,
        origin: Option<RegisteredAuthority>,
    ) -> Result<ExportChunkPermit, PortError> {
        let access = self
            .revalidate_committed_export(&caller.0, origin.as_ref().map(|(ctx, _)| ctx), pointer)
            .await?;
        Ok(ExportChunkPermit {
            binding: pointer.binding.clone(),
            installation: self.installation_id().clone(),
            scope: pointer.object.scope.clone(),
            access,
            caller_registration: caller.1,
            origin_registration: origin.map(|(_, lease)| lease),
        })
    }

    /// Check both live authorities against the same snapshot of the selection.
    async fn revalidate_committed_export(
        &self,
        ctx: &SpaceContext,
        origin: Option<&SpaceContext>,
        pointer: &CommittedExport,
    ) -> Result<ExportAccess, PortError> {
        let scope = ctx.scope().clone();
        pointer.object.scope.check(&scope)?;
        if pointer.object.installation != *self.installation_id() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let caller = pointer.caller.limit(ctx.auth())?;
        let origin = if pointer.origin != pointer.caller {
            let source = origin.ok_or(DomainError::AccessDenied)?;
            scope.check(source.scope())?;
            Some(pointer.origin.limit(source.auth())?)
        } else {
            None
        };
        let binding = pointer.binding.clone();
        let selection = pointer.selection.clone();
        let store = self.clone();
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let live = load_space_record(tx, &scope.space_id).await?;
                live.scope.check(&scope)?;
                check_publication_tx(tx, &scope.space_id, &binding).await?;
                store
                    .authorize_export_selection_tx(
                        tx,
                        &live,
                        &binding.job,
                        &selection,
                        &caller,
                        origin.as_ref(),
                    )
                    .await?;
                Ok(ExportAccess {
                    seq: live.last_seq,
                    caller,
                    origin,
                    selection,
                })
            })
        })
        .await
    }

    async fn read_export_policy_tx(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
        binding: &ExportBinding,
    ) -> Result<(JobDelegation, ExportSelection), PortError> {
        const SQL: &str = "SELECT payload_msgpack, artifacts_json FROM content_jobs
            WHERE space_id=$1 AND job_id=$2 AND payload_erased_by_purge=0 AND length(payload_msgpack)<=$3";
        macro_rules! policy {
            ($conn:expr) => {
                sqlx::query_as(SQL)
                    .bind(scope.space_id.as_str())
                    .bind(binding.job.as_str())
                    .bind(super::MAX_JOB_WIRE_BYTES as i64)
                    .fetch_optional(&mut **$conn)
                    .await
            };
        }
        let row: Option<(Vec<u8>, String)> = match tx {
            BackendConn::Sqlite(conn) => policy!(conn),
            BackendConn::Postgres(conn) => policy!(conn),
        }
        .map_err(sql_error)?;
        let (bytes, artifacts) = row.ok_or(DomainError::ResourceNotFound)?;
        #[cfg(feature = "test-support")]
        self.inner
            .export_policy_bytes_read
            .fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed);
        let ids: Vec<ArtifactId> =
            serde_json::from_str(&artifacts).map_err(|_| DomainError::ResourceNotFound)?;
        if !ids.contains(&binding.id) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let (kind, origin) = decode_job_payload(&bytes)?;
        let selection = match kind {
            StoredJobPayloadV1::ExportSpace { .. } => ExportSelection::WholeSpace,
            StoredJobPayloadV1::Export { notes, .. } => {
                let selected: BTreeSet<_> = notes.iter().map(|note| note.as_str()).collect();
                const OWNERS: &str = "SELECT note_id FROM payload_owners WHERE space_id=$1
                    AND payload_kind='content_job' AND payload_id=$2 LIMIT $3";
                macro_rules! owners {
                    ($conn:expr) => {
                        sqlx::query_scalar(OWNERS)
                            .bind(scope.space_id.as_str())
                            .bind(binding.job.as_str())
                            .bind(selected.len() as i64 + 1)
                            .fetch_all(&mut **$conn)
                            .await
                    };
                }
                let owners: Vec<String> = match tx {
                    BackendConn::Sqlite(conn) => owners!(conn),
                    BackendConn::Postgres(conn) => owners!(conn),
                }
                .map_err(sql_error)?;
                if selected.len() != owners.len()
                    || owners.iter().any(|id| !selected.contains(id.as_str()))
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                ExportSelection::Selected(Arc::new(SelectedNotes {
                    count: selected.len(),
                    visible: Mutex::default(),
                }))
            }
            _ => return Err(DomainError::ResourceNotFound.into()),
        };
        Ok((origin.ok_or(DomainError::ResourceNotFound)?, selection))
    }

    async fn authorize_export_selection_tx(
        &self,
        tx: &mut BackendConn<'_>,
        live: &crate::SpaceRecord,
        job: &JobId,
        selection: &ExportSelection,
        caller: &EngineAuthContext,
        origin: Option<&EngineAuthContext>,
    ) -> Result<(), PortError> {
        let accounts = || std::iter::once(caller).chain(origin);
        let ExportSelection::Selected(notes) = selection else {
            for account in accounts() {
                authorize_full_space_export(account, &live.space)?;
            }
            return Ok(());
        };
        for account in accounts() {
            authorize_job_read_on_space(account, &live.space)?;
        }
        let cached = notes
            .visible
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|(seq, _)| *seq == live.last_seq)
            .map(|(_, classes)| classes.clone());
        let classes = match cached {
            Some(classes) => classes,
            None => {
                let classes = self
                    .live_selected_classes_tx(tx, live, job, notes.count)
                    .await?;
                let mut visible = notes.visible.lock().unwrap_or_else(|e| e.into_inner());
                if visible
                    .as_ref()
                    .is_none_or(|(seq, _)| *seq <= live.last_seq)
                {
                    *visible = Some((live.last_seq, classes.clone()));
                }
                classes
            }
        };
        for account in accounts() {
            if !account.spaces()[&live.space.id]
                .read_classes
                .is_superset(&classes)
            {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
        Ok(())
    }

    async fn live_selected_classes_tx(
        &self,
        tx: &mut BackendConn<'_>,
        live: &crate::SpaceRecord,
        job: &JobId,
        distinct_notes: usize,
    ) -> Result<BTreeSet<DocClass>, PortError> {
        // Owners are inserted with the immutable job payload. Purge erases the
        // job and revokes its generation in the same transaction as owner removal.
        macro_rules! classes {
            ($conn:expr, $sql:expr) => {
                sqlx::query_as($sql)
                    .bind(live.scope.space_id.as_str())
                    .bind(job.as_str())
                    .bind(crate::domain::common::MAX_FOLDER_DEPTH as i64)
                    .bind(live.root_folder_id.as_str())
                    .fetch_all(&mut **$conn)
                    .await
            };
        }
        let rows: Vec<(String, i64)> = match tx {
            BackendConn::Sqlite(conn) => classes!(conn, SQLITE_SELECTED_CLASSES),
            BackendConn::Postgres(conn) => classes!(conn, PG_SELECTED_CLASSES),
        }
        .map_err(sql_error)?;
        #[cfg(feature = "test-support")]
        self.inner
            .export_selection_reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if rows.iter().map(|(_, count)| *count).sum::<i64>() != distinct_notes as i64 {
            return Err(DomainError::ResourceNotFound.into());
        }
        rows.into_iter()
            .map(|(class, _)| doc_class_from_db(&class))
            .collect()
    }
}

// Resolve only the selected active heads and their active ancestor chains.
// Group by document class in SQL so at most one row per class crosses the port.
macro_rules! selected_classes {
    ($heads:literal, $parent:literal, $root_index:literal) => {
        concat!("WITH RECURSIVE heads AS MATERIALIZED (
    SELECT n.parent_folder_id,n.doc_class FROM payload_owners o ", $heads, "
    WHERE o.space_id=$1 AND o.payload_kind='content_job' AND o.payload_id=$2 AND NOT EXISTS (
        SELECT 1 FROM revision_purge_fences p WHERE p.space_id=o.space_id AND p.note_id=o.note_id)
), ancestry(start_id,folder_id,depth) AS (
    SELECT DISTINCT parent_folder_id,parent_folder_id,0 FROM heads
    UNION ALL SELECT a.start_id,f.parent_folder_id,a.depth+1 FROM ancestry a ", $parent, "
    WHERE a.depth<$3
) SELECT h.doc_class,COUNT(*) FROM heads h
    WHERE h.parent_folder_id IN (SELECT start_id FROM ancestry WHERE folder_id=$4)
      AND EXISTS (SELECT 1 FROM folder_heads f ", $root_index, "
        WHERE f.space_id=$1 AND f.folder_id=$4 AND f.is_root=1 AND f.lifecycle_state='active')
    GROUP BY h.doc_class")
    };
}
// Keep lookups driven by owners and ancestors even before planner statistics
// exist. The composite keys make each bounded PostgreSQL lookup unique.
const SQLITE_SELECTED_CLASSES: &str = selected_classes!(
    "CROSS JOIN note_heads n INDEXED BY idx_note_heads_export_access
        ON n.space_id=o.space_id AND n.note_id=o.note_id AND n.lifecycle_state='active'",
    "CROSS JOIN folder_heads f INDEXED BY idx_folder_heads_export_access
        ON f.space_id=$1 AND f.folder_id=a.folder_id AND f.lifecycle_state='active' AND f.is_root=0",
    "INDEXED BY idx_folder_heads_export_access"
);
const PG_SELECTED_CLASSES: &str = selected_classes!(
    "JOIN LATERAL (SELECT parent_folder_id,doc_class,lifecycle_state FROM note_heads
        WHERE space_id=o.space_id AND note_id=o.note_id LIMIT 1) n ON n.lifecycle_state='active'",
    "JOIN LATERAL (SELECT parent_folder_id,lifecycle_state,is_root FROM folder_heads
        WHERE space_id=$1 AND folder_id=a.folder_id LIMIT 1) f ON f.lifecycle_state='active' AND f.is_root=0",
    ""
);

// The (Space, artifact) key is insert-only. The original open bound the job
// and generation to it. Match its complete expiry index key at handoff to
// avoid the overflow pages of the WITHOUT ROWID table's large object value.
macro_rules! check_publication {
    ($artifact:literal, $job:literal) => {
        concat!(
            "SELECT EXISTS(
        SELECT 1 FROM archive_artifacts a ",
            $artifact,
            " JOIN content_jobs j ",
            $job,
            "
          ON j.space_id=a.space_id
        LEFT JOIN archive_privacy p ON p.space_id=a.space_id
        WHERE a.space_id=$1 AND a.artifact_id=$2 AND j.job_id=$3
          AND COALESCE(p.generation,0)=$4 AND a.expires_at_ms=$5 AND a.expires_at_ms>$6
          AND a.object_namespace=$7 AND j.state='succeeded' AND j.job_kind='export'
          AND j.payload_erased_by_purge=0)"
        )
    };
}
const SQLITE_CHECK_PUBLICATION: &str = check_publication!(
    "INDEXED BY idx_archive_artifacts_expiry",
    "INDEXED BY idx_content_jobs_export_access"
);
const PG_CHECK_PUBLICATION: &str = check_publication!("", "");

async fn check_publication_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    binding: &ExportBinding,
) -> Result<(), PortError> {
    let now = job_clock_ms(tx).await?;
    macro_rules! check {
        ($conn:expr, $sql:expr) => {
            sqlx::query_scalar($sql)
                .bind(space.as_str())
                .bind(binding.id.as_str())
                .bind(binding.job.as_str())
                .bind(binding.generation as i64)
                .bind(binding.expires)
                .bind(now)
                .bind(binding.namespace.as_bytes().as_slice())
                .fetch_one(&mut **$conn)
                .await
        };
    }
    let current: bool = match tx {
        BackendConn::Sqlite(conn) => check!(conn, SQLITE_CHECK_PUBLICATION),
        BackendConn::Postgres(conn) => check!(conn, PG_CHECK_PUBLICATION),
    }
    .map_err(sql_error)?;
    if !current {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
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
    let mut notes = tx.prepare_cached(SPACE_NOTES).map_err(native_error)?;
    let notes = notes
        .query_map(params![sid, MAX_EXPORT_ITEMS + 1], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(native_error)?
        .collect::<Result<Vec<NoteExportRow>, _>>()
        .map_err(native_error)?;
    let mut files = validated_note_entries(notes, encrypted)?;
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
    const SQL: &str = "INSERT INTO archive_artifacts(space_id, artifact_id, job_id, privacy_generation, expires_at_ms, object_msgpack, object_namespace)
        VALUES($1,$2,$3,$4,$5,$6,$7)";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(SQL)
            .bind(scope.space_id.as_str())
            .bind(publication.object.id.as_str())
            .bind(job.as_str())
            .bind(publication.privacy_generation as i64)
            .bind(expires_at)
            .bind(&encoded)
            .bind(publication.object.namespace.as_bytes().as_slice())
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
            .bind(publication.object.namespace.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(sql_error)
}

impl CanonicalStore {
    async fn read_pointer_tx(
        &self,
        tx: &mut BackendConn<'_>,
        space: &SpaceId,
        artifact: &ArtifactId,
    ) -> Result<(ArchiveObject, ExportBinding), PortError> {
        const SQL: &str = "SELECT job_id, privacy_generation, expires_at_ms, object_msgpack
        FROM archive_artifacts WHERE space_id=$1 AND artifact_id=$2 AND length(object_msgpack)<=$3";
        let row: Option<(String, i64, i64, Vec<u8>)> = match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query_as(SQL)
                    .bind(space.as_str())
                    .bind(artifact.as_str())
                    .bind(MAX_MSGPACK_DECODE_BYTES as i64)
                    .fetch_optional(&mut **conn)
                    .await
            }
            BackendConn::Postgres(conn) => {
                sqlx::query_as(SQL)
                    .bind(space.as_str())
                    .bind(artifact.as_str())
                    .bind(MAX_MSGPACK_DECODE_BYTES as i64)
                    .fetch_optional(&mut **conn)
                    .await
            }
        }
        .map_err(sql_error)?;
        let (job, generation, expires_at_ms, bytes) = row.ok_or(DomainError::ResourceNotFound)?;
        #[cfg(feature = "test-support")]
        self.inner
            .export_descriptor_bytes_read
            .fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed);
        let object: ArchiveObject = decode_msgpack_bounded(&bytes, MAX_MSGPACK_DECODE_BYTES)?;
        let namespace = object.namespace;
        Ok((
            object,
            ExportBinding {
                id: artifact.clone(),
                job: JobId::parse(&job)?,
                generation: generation as u64,
                expires: expires_at_ms,
                namespace,
            },
        ))
    }

    #[cfg(feature = "test-support")]
    pub fn export_policy_reads_for_test(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (
            self.inner.export_policy_bytes_read.load(Relaxed),
            self.inner.export_selection_reads.load(Relaxed),
        )
    }

    #[cfg(feature = "test-support")]
    pub fn export_descriptor_bytes_read_for_test(&self) -> u64 {
        self.inner
            .export_descriptor_bytes_read
            .load(std::sync::atomic::Ordering::Relaxed)
    }
}

async fn selected_note_entries(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    notes: &[notarium_core::ids::NoteId],
    encrypted: bool,
) -> Result<Vec<ExportEntry>, PortError> {
    let mut files = Vec::new();
    visit_authorized_export_notes_tx(tx, space, auth, notes, |head, folder| {
        if files.len() >= MAX_EXPORT_ITEMS as usize {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        if head.doc_class == DocClass::EncryptedNote && !encrypted {
            return Err(invalid(ValidationReason::ClassEgressForbidden));
        }
        let mut path = folder.to_owned();
        if !path.is_empty() {
            path.push('/');
        }
        path.push_str(&head.slug);
        path.push_str(".md");
        files.push(ExportEntry {
            path,
            data: ExportData::Blob(
                head.content_digest
                    .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?,
            ),
        });
        Ok(())
    })
    .await?;
    Ok(files)
}

async fn note_entries(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    encrypted: bool,
) -> Result<Vec<ExportEntry>, PortError> {
    macro_rules! read {
        ($conn:expr) => {
            sqlx::query_as(SPACE_NOTES)
                .bind(scope.space_id.as_str())
                .bind(MAX_EXPORT_ITEMS + 1)
                .fetch_all(&mut **$conn)
                .await
        };
    }
    let rows = match tx {
        BackendConn::Sqlite(conn) => read!(conn),
        BackendConn::Postgres(conn) => read!(conn),
    }
    .map_err(sql_error)?;
    validated_note_entries(rows, encrypted)
}

const SPACE_NOTES: &str = "WITH RECURSIVE paths(folder_id, name, depth) AS (
      SELECT folder_id, CAST('' AS TEXT), 0 FROM folder_heads
        WHERE space_id=$1 AND is_root=1 AND lifecycle_state='active'
      UNION ALL
      SELECT h.folder_id, p.name || h.slug || '/', p.depth+1
        FROM folder_heads h JOIN paths p ON h.parent_folder_id=p.folder_id
        WHERE h.space_id=$1 AND h.lifecycle_state='active' AND p.depth<256
     ), schema_note AS (
       SELECT schema_note_id,created_seq FROM space_field_schemas
       WHERE space_id=$1 AND is_current=1
     )
     SELECT n.note_id, p.name || n.slug || '.md', n.doc_class, n.content_blake3
     FROM note_heads n JOIN paths p ON n.parent_folder_id=p.folder_id
     WHERE n.space_id=$1 AND n.lifecycle_state='active' AND n.ability_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM schema_note s WHERE s.schema_note_id=n.note_id)
     UNION ALL
     SELECT s.schema_note_id, '.notarium/fields/schema.yaml', 'user-doc', r.content_blake3
       FROM schema_note s LEFT JOIN revisions r ON r.space_id=$1 AND r.entity_type='note'
        AND r.entity_key=s.schema_note_id AND r.space_seq=s.created_seq
     LIMIT $2";

type NoteExportRow = (String, String, String, Option<Vec<u8>>);

fn validated_note_entries(
    rows: Vec<NoteExportRow>,
    encrypted: bool,
) -> Result<Vec<ExportEntry>, PortError> {
    if rows.len() > MAX_EXPORT_ITEMS as usize {
        return Err(invalid(ValidationReason::BudgetExceeded));
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

#[cfg(test)]
mod tests {
    use super::{SQLITE_CHECK_PUBLICATION, SQLITE_SELECTED_CLASSES};
    use rusqlite::{
        Connection,
        hooks::{AuthAction, AuthContext, Authorization},
        params,
    };

    #[test]
    fn selected_range_reads_one_class_through_its_own_active_ancestry() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        db.execute_batch(
            "INSERT INTO spaces VALUES('space',zeroblob(16),'root','space','space','personal','owner','active',1,0,'{}',0,0);
             INSERT INTO folder_heads(space_id,folder_id,is_root,slug,slug_fold,display_name,is_project,lifecycle_state,
                 rev_seq,head_rev_id,created_seq,updated_seq,updated_at_sec,updated_at_nsec)
             VALUES('space','root',1,'','','',0,'active',0,'rev',0,0,0,0);
             WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<10000)
             INSERT INTO folder_heads(space_id,folder_id,parent_folder_id,is_root,slug,slug_fold,display_name,is_project,lifecycle_state,
                 rev_seq,head_rev_id,created_seq,updated_seq,updated_at_sec,updated_at_nsec)
             SELECT 'space',printf('f%d',i),'root',0,printf('f%d',i),printf('f%d',i),'',0,'active',0,'rev',0,0,0,0 FROM seq;
             INSERT INTO note_heads(space_id,note_id,parent_folder_id,slug,slug_fold,title,title_fold,doc_class,head_rev_id,
                 content_blake3,byte_size,lifecycle_state,created_seq,updated_seq,created_at_sec,created_at_nsec,updated_at_sec,updated_at_nsec,last_actor_id)
             SELECT 'space',folder_id,folder_id,'n','n','','','user-doc','r',zeroblob(32),1,'active',1,1,0,0,0,0,'actor'
             FROM folder_heads WHERE is_root=0;
             INSERT INTO payload_owners(space_id,note_id,payload_kind,payload_id) VALUES('space','f1','content_job','job');"
        ).unwrap();
        let title = format!("b{}aa", "漢".repeat(1_397_971));
        db.execute(
            "UPDATE note_heads SET title=?1,title_fold=?1 WHERE note_id='f1'",
            [&title],
        )
        .unwrap();
        let read = || {
            let mut query = db.prepare(SQLITE_SELECTED_CLASSES).unwrap();
            let rows = query
                .query_map(params!["space", "job", 256, "root"], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(query.get_status(rusqlite::StatementStatus::VmStep) < 2_000);
            rows
        };
        for analyzed in [false, true] {
            if analyzed {
                db.execute_batch("ANALYZE").unwrap();
            }
            db.authorizer(Some(|event: AuthContext<'_>| match event.action {
                AuthAction::Read {
                    table_name: "note_heads",
                    column_name: "title" | "title_fold" | "content_blake3",
                }
                | AuthAction::Read {
                    table_name: "folder_heads",
                    column_name: "display_name" | "description",
                }
                | AuthAction::Read {
                    table_name: "content_jobs" | "archive_artifacts",
                    ..
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))
            .unwrap();
            assert_eq!(read(), vec![("user-doc".into(), 1)]);
            db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
                .unwrap();
        }
        db.execute(
            "UPDATE note_heads SET doc_class='agent-memory' WHERE note_id='f1'",
            [],
        )
        .unwrap();
        assert_eq!(read(), vec![("agent-memory".into(), 1)]);
        db.execute(
            "UPDATE folder_heads SET lifecycle_state='trashed' WHERE folder_id='f1'",
            [],
        )
        .unwrap();
        assert!(read().is_empty());
        db.execute(
            "UPDATE note_heads SET parent_folder_id='root' WHERE note_id='f1'",
            [],
        )
        .unwrap();
        assert_eq!(read(), vec![("agent-memory".into(), 1)]);
        db.execute("INSERT INTO revision_purge_fences VALUES('space',zeroblob(16),'f1',2,'active',NULL,0,0)", []).unwrap();
        assert!(read().is_empty());
    }

    #[test]
    fn range_fence_checks_a_large_publication_without_reading_its_descriptor() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        db.execute_batch(
            "INSERT INTO spaces VALUES('space',zeroblob(16),'root','space','space','personal','owner','active',1,0,'{}',0,0);
             INSERT INTO content_jobs(space_id,job_id,job_kind,payload_msgpack,state,lease_epoch,artifacts_json,created_seq,updated_seq)
               VALUES('space','job','export',zeroblob(4000000),'succeeded',1,'[]',1,2);
             INSERT INTO archive_artifacts(space_id,artifact_id,job_id,privacy_generation,expires_at_ms,object_msgpack,object_namespace)
               VALUES('space','artifact','job',0,1000,zeroblob(647498),zeroblob(32));"
        ).unwrap();
        db.authorizer(Some(|event: AuthContext<'_>| match event.action {
            AuthAction::Read {
                table_name: "archive_artifacts",
                column_name: "object_msgpack",
            }
            | AuthAction::Read {
                table_name: "content_jobs",
                column_name: "payload_msgpack",
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }))
        .unwrap();
        let active = |now| {
            db.query_row(
                SQLITE_CHECK_PUBLICATION,
                params!["space", "artifact", "job", 0, 1000, now, [0u8; 32]],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
        };
        assert!(active(999));
        assert!(!active(1000));
        db.execute("UPDATE content_jobs SET payload_erased_by_purge=1", [])
            .unwrap();
        assert!(!active(999));
    }
}
