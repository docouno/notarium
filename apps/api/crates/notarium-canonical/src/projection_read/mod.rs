//! History-pinned metadata and carrier access for rebuildable projections.

use std::{collections::BTreeMap, time::Duration};

use notarium_core::{
    DomainError,
    auth::{Space, SpaceKind, SpaceLifecycle},
    classes::DocClass,
    error::{Diagnostic, PortError, ValidationReason},
    ids::{ContentDigest, FolderId, HistoryIncarnation, NoteId, RevisionId, SpaceId, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::{MaintenanceContext, PageLimit, ServicePurpose},
    query::FieldSchema,
    value::Timestamp,
};

use crate::{
    BoxFuture, CanonicalStore,
    codec::{
        FolderRevisionMetadata, MAX_MSGPACK_DECODE_BYTES, NoteRevisionMetadata,
        RevisionMetadataEnvelope, RevisionMetadataPayload, decode_msgpack_bounded,
        decode_timestamp_parts, i64_to_space_seq, internal_not_committed,
    },
    domain::common::{CommandDeadline, note_rank_version_digest},
    runtime::{
        SpaceRecord, is_note_purge_fenced_tx, load_space_record, pg_read_error,
        require_command_end_tx,
    },
    sql_exec::BackendConn,
};

/// Both drivers accept numbered SQL parameters. Cast INTEGER columns to BIGINT
/// where the shared row also needs to decode a PostgreSQL integer as i64.
macro_rules! read_rows {
    ($tx:expr, $method:ident, $kind:literal, $ty:ty, $sql:expr $(, $arg:expr)* $(,)?) => {{
        match $tx {
            BackendConn::Sqlite(conn) => sqlx::query_as::<_, $ty>($sql)
                $(.bind($arg))*
                .$method(&mut **conn)
                .await
                .map_err(|err| internal_not_committed(concat!("sqlite_", $kind), err.to_string())),
            BackendConn::Postgres(conn) => sqlx::query_as::<_, $ty>($sql)
                $(.bind($arg))*
                .$method(&mut **conn)
                .await
                .map_err(|err| pg_read_error(concat!("pg_", $kind), err)),
        }
    }};
}

mod aliases;
mod delta;
mod exact;
mod ranks;

pub use aliases::{
    ProjectionAlias, ProjectionAliasCursor, ProjectionFolderAlias, ProjectionNoteAlias,
};
pub use delta::{ProjectionAbility, ProjectionDelta};
pub use exact::{ProjectionOverlayNote, ProjectionOverlaySelection};
pub use ranks::{ProjectionRank, ProjectionRankKey};

const PROJECTION_READ_LIMIT: Duration = Duration::from_millis(240);

#[cfg(feature = "test-support")]
mod metrics {
    use std::{
        sync::atomic::{AtomicBool, AtomicU64, Ordering},
        time::{Duration, Instant},
    };

    /// Canonical read transactions on the measured store, including admission and cleanup.
    #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
    pub struct ProjectionReadMetricsSnapshot {
        pub transactions: u64,
        pub max_elapsed_ns: u64,
        pub non_successful_reads: u64,
    }

    #[derive(Default)]
    pub(crate) struct ProjectionReadMetrics {
        enabled: AtomicBool,
        count: AtomicU64,
        max_ns: AtomicU64,
        failures: AtomicU64,
    }

    impl ProjectionReadMetrics {
        pub(crate) fn measure(&self) -> Option<ReadMeasurement<'_>> {
            self.enabled
                .load(Ordering::Acquire)
                .then(|| ReadMeasurement {
                    metrics: self,
                    started: Instant::now(),
                    success: false,
                })
        }

        fn record(&self, elapsed: Duration, success: bool) {
            self.count.fetch_add(1, Ordering::Relaxed);
            self.max_ns.fetch_max(
                u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX),
                Ordering::Relaxed,
            );
            if !success {
                self.failures.fetch_add(1, Ordering::Relaxed);
            }
        }

        pub(super) fn snapshot(&self) -> ProjectionReadMetricsSnapshot {
            ProjectionReadMetricsSnapshot {
                transactions: self.count.load(Ordering::Relaxed),
                max_elapsed_ns: self.max_ns.load(Ordering::Relaxed),
                non_successful_reads: self.failures.load(Ordering::Relaxed),
            }
        }

        pub(super) fn reset(&self) {
            self.count.store(0, Ordering::Relaxed);
            self.max_ns.store(0, Ordering::Relaxed);
            self.failures.store(0, Ordering::Relaxed);
            self.enabled.store(true, Ordering::Release);
        }
    }

    pub(crate) struct ReadMeasurement<'a> {
        metrics: &'a ProjectionReadMetrics,
        started: Instant,
        success: bool,
    }

    impl ReadMeasurement<'_> {
        pub(crate) fn complete(&mut self, success: bool) {
            self.success = success;
        }
    }

    impl Drop for ReadMeasurement<'_> {
        fn drop(&mut self) {
            self.metrics.record(self.started.elapsed(), self.success);
        }
    }
}

#[cfg(feature = "test-support")]
pub(crate) use metrics::ProjectionReadMetrics;
#[cfg(feature = "test-support")]
pub use metrics::ProjectionReadMetricsSnapshot;

/// A page advances by key, including when some records were filtered.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionPage<T, K> {
    pub rows: Vec<T>,
    pub next: Option<K>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionSpaceHeader {
    pub space: Space,
    pub scope: HistoryScope,
    pub root_folder_id: FolderId,
    pub cutoff: SpaceSeq,
    pub schema: Option<ProjectedSchemaSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectedSchemaSnapshot {
    pub schema_rev_id: RevisionId,
    pub schema_note_id: NoteId,
    pub descriptor_fingerprint: ContentDigest,
    pub fields: BTreeMap<String, FieldSchema>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionFolder {
    pub metadata: FolderRevisionMetadata,
    pub revision_id: RevisionId,
    pub visibility_seq: SpaceSeq,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionNote {
    pub metadata: NoteRevisionMetadata,
    pub revision_id: RevisionId,
    pub visibility_seq: SpaceSeq,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub rank_version: ContentDigest,
    pub header_diagnostic: Option<Diagnostic>,
    carrier: CarrierWitness,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CarrierWitness {
    scope: HistoryScope,
    cutoff: SpaceSeq,
    note_id: NoteId,
    digest: Option<ContentDigest>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionPurgeFence {
    pub note_id: NoteId,
    pub purge_seq: SpaceSeq,
}

impl CanonicalStore {
    /// Lists the canonical installation's Spaces for projection discovery.
    pub async fn list_spaces(
        &self,
        ctx: &MaintenanceContext,
    ) -> Result<Vec<(Space, HistoryScope, FolderId, SpaceSeq)>, PortError> {
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                const SPACES: &str = "SELECT space_id, history_incarnation, root_folder_id,
                        space_kind, lifecycle_state, last_seq FROM spaces ORDER BY space_id";
                type Row = (String, Vec<u8>, String, String, String, i64);
                let rows = read_rows!(tx, fetch_all, "projection_list_spaces", Row, SPACES)?;
                rows.into_iter()
                    .map(|(id, incarnation, root, kind, lifecycle, seq)| {
                        let id = SpaceId::parse(&id)?;
                        let scope = HistoryScope {
                            space_id: id.clone(),
                            incarnation: HistoryIncarnation::from_bytes(
                                incarnation
                                    .try_into()
                                    .map_err(|_| corrupt("invalid Space incarnation"))?,
                            ),
                        };
                        let kind = match kind.as_str() {
                            "personal" => SpaceKind::Personal,
                            "shared" => SpaceKind::Shared,
                            _ => return Err(corrupt("invalid Space kind")),
                        };
                        let lifecycle = match lifecycle.as_str() {
                            "active" => SpaceLifecycle::Active,
                            "closing" => SpaceLifecycle::Closing,
                            "archived" => SpaceLifecycle::Archived,
                            _ => return Err(corrupt("invalid Space lifecycle")),
                        };
                        Ok((
                            Space {
                                id,
                                kind,
                                lifecycle,
                            },
                            scope,
                            FolderId::parse(&root)?,
                            i64_to_space_seq(seq)?,
                        ))
                    })
                    .collect()
            })
        })
        .await
    }

    /// Opens metadata on a command-end boundary (or the current head).
    pub async fn read_projection_space_header(
        &self,
        ctx: &MaintenanceContext,
        space_id: &SpaceId,
        cutoff: Option<SpaceSeq>,
    ) -> Result<ProjectionSpaceHeader, PortError> {
        let space_id = space_id.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &space_id).await?;
                let cutoff = cutoff.unwrap_or(record.last_seq);
                validate_cut(tx, &record, cutoff).await?;
                let schema = schema_at(tx, &record.scope, cutoff).await?;
                Ok(ProjectionSpaceHeader {
                    space: record.space,
                    scope: record.scope,
                    root_folder_id: record.root_folder_id,
                    cutoff,
                    schema,
                })
            })
        })
        .await
    }

    pub async fn read_projection_folders_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        after: Option<FolderId>,
        limit: PageLimit,
    ) -> Result<ProjectionPage<ProjectionFolder, FolderId>, PortError> {
        let scope = scope.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                checked_cut(tx, &scope, cutoff).await?;
                let mut records = read_rows!(
                    tx,
                    fetch_all,
                    "projection_folders_page",
                    FolderRow,
                    concat!(
                        "SELECT h.folder_id, r.rev_id, r.visibility_seq, r.metadata_msgpack ",
                        folder_snapshot_sql!(),
                        " h.folder_id > $4 ORDER BY h.folder_id LIMIT $5"
                    ),
                    scope.space_id.as_str(),
                    scope.incarnation.as_bytes().as_slice(),
                    cutoff.get() as i64,
                    after.as_ref().map_or("", FolderId::as_str),
                    usize::from(limit.get()) as i64 + 1,
                )?;
                let more = truncate_page(&mut records, limit);
                let mut rows = Vec::with_capacity(records.len());
                for record in records {
                    rows.push(folder_from_row(tx, &scope, record).await?);
                }
                Ok(ProjectionPage {
                    next: page_next(&rows, more, |row| row.metadata.folder_id.clone()),
                    rows,
                })
            })
        })
        .await
    }

    pub async fn read_projection_notes_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        after: Option<NoteId>,
        limit: PageLimit,
    ) -> Result<ProjectionPage<ProjectionNote, NoteId>, PortError> {
        let scope_for_read = scope.clone();
        let (records, more) = self
            .with_projection_read(ctx, |tx| {
                Box::pin(async move {
                    let scope = scope_for_read;
                    checked_cut(tx, &scope, cutoff).await?;
                    let mut records = read_rows!(
                        tx,
                        fetch_all,
                        "projection_notes_page",
                        NoteRow,
                        concat!(
                            note_snapshot_sql!(),
                            " h.note_id > $4 ORDER BY h.note_id LIMIT $5"
                        ),
                        scope.space_id.as_str(),
                        scope.incarnation.as_bytes().as_slice(),
                        cutoff.get() as i64,
                        after.as_ref().map_or("", NoteId::as_str),
                        usize::from(limit.get()) as i64 + 1,
                    )?;
                    let more = truncate_page(&mut records, limit);
                    Ok((records, more))
                })
            })
            .await?;
        let rows = records
            .into_iter()
            .map(|record| note_from_row(scope, cutoff, record))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ProjectionPage {
            next: page_next(&rows, more, |row| row.metadata.note_id.clone()),
            rows,
        })
    }

    /// Reads a specific note at the same command cut used by seed and delta pages.
    pub async fn read_projection_note(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        id: &NoteId,
    ) -> Result<Option<ProjectionNote>, PortError> {
        let scope = scope.clone();
        let id = id.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                checked_cut(tx, &scope, cutoff).await?;
                note_at(tx, &scope, cutoff, &id).await
            })
        })
        .await
    }

    /// Opens the canonical carrier admitted with this exact metadata record.
    /// Encrypted notes never admit a digest for carrier I/O.
    pub async fn read_projection_note_carrier(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        note: &ProjectionNote,
    ) -> Result<Option<String>, PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        let witness = &note.carrier;
        scope.check(&witness.scope)?;
        if witness.cutoff != cutoff {
            return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
        }
        let Some(digest) = witness.digest else {
            return Ok(None);
        };
        let deadline = CommandDeadline::start(&ctx.budget, "read_projection_carrier");
        let mut budget = ctx.budget.clone();
        budget.remaining = budget.remaining.min(PROJECTION_READ_LIMIT);
        let bytes = deadline
            .prepare(&budget, || {
                self.read_verified_blob_with_budget(scope, digest, Some(&budget))
            })
            .await
            .map_err(|error| match error {
                PortError::Domain(DomainError::ResourceNotFound) => stale(),
                other => other,
            })?;
        let scope = scope.clone();
        let note_id = witness.note_id.clone();
        let mut ctx = ctx.clone();
        ctx.budget.remaining = deadline.remaining(&budget)?;
        self.with_projection_read(&ctx, |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &scope.space_id).await?;
                record.scope.check(&scope)?;
                if is_note_purge_fenced_tx(tx, &scope.space_id, note_id.as_str()).await? {
                    return Err(stale());
                }
                Ok(())
            })
        })
        .await?;
        Ok(Some(
            String::from_utf8(bytes).map_err(|_| corrupt("note carrier is not UTF-8"))?,
        ))
    }

    /// Returns purge identities retained by canonical for derived-data cleanup.
    pub async fn read_projection_purge_fences_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        after: Option<NoteId>,
        limit: PageLimit,
    ) -> Result<ProjectionPage<ProjectionPurgeFence, NoteId>, PortError> {
        let scope = scope.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &scope.space_id).await?;
                record.scope.check(&scope)?;
                const PAGE: &str = "SELECT note_id, purge_seq FROM revision_purge_fences
                    WHERE space_id = $1 AND history_incarnation = $2 AND note_id > $3
                    ORDER BY note_id LIMIT $4";
                let mut records = read_rows!(
                    tx,
                    fetch_all,
                    "projection_purge_fences",
                    (String, i64),
                    PAGE,
                    scope.space_id.as_str(),
                    scope.incarnation.as_bytes().as_slice(),
                    after.as_ref().map_or("", NoteId::as_str),
                    usize::from(limit.get()) as i64 + 1,
                )?;
                let more = truncate_page(&mut records, limit);
                let rows = records
                    .into_iter()
                    .map(|(id, seq)| {
                        Ok(ProjectionPurgeFence {
                            note_id: NoteId::parse(&id)?,
                            purge_seq: i64_to_space_seq(seq)?,
                        })
                    })
                    .collect::<Result<Vec<_>, PortError>>()?;
                Ok(ProjectionPage {
                    next: page_next(&rows, more, |row| row.note_id.clone()),
                    rows,
                })
            })
        })
        .await
    }

    pub(crate) async fn with_projection_read<F, T>(
        &self,
        ctx: &MaintenanceContext,
        f: F,
    ) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> BoxFuture<'c, Result<T, PortError>>,
    {
        ctx.authority.require(ServicePurpose::Projection)?;
        let mut budget = ctx.budget.clone();
        budget.remaining = budget.remaining.min(PROJECTION_READ_LIMIT);
        self.with_read_tx_budget(Some(&budget), f).await
    }

    #[cfg(feature = "test-support")]
    pub fn reset_projection_read_metrics_for_test(&self) {
        self.inner.projection_read_metrics.reset();
    }

    #[cfg(feature = "test-support")]
    pub fn projection_read_metrics_for_test(&self) -> ProjectionReadMetricsSnapshot {
        self.inner.projection_read_metrics.snapshot()
    }
}

fn corrupt(detail: &'static str) -> PortError {
    internal_not_committed("corrupt_projection_source", detail)
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

fn truncate_page<T>(rows: &mut Vec<T>, limit: PageLimit) -> bool {
    let limit = usize::from(limit.get());
    let more = rows.len() > limit;
    rows.truncate(limit);
    more
}

fn page_next<T, K>(rows: &[T], more: bool, key: impl FnOnce(&T) -> K) -> Option<K> {
    if more { rows.last().map(key) } else { None }
}

async fn validate_cut(
    tx: &mut BackendConn<'_>,
    record: &SpaceRecord,
    cutoff: SpaceSeq,
) -> Result<(), PortError> {
    if cutoff > record.last_seq {
        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
    }
    require_command_end_tx(tx, &record.scope, cutoff).await?;
    if crate::changes::has_post_cutoff_purge_of_prior_note_tx(
        tx,
        &record.scope,
        cutoff,
        record.last_seq,
    )
    .await?
    {
        return Err(stale());
    }
    Ok(())
}

async fn checked_cut(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
) -> Result<(), PortError> {
    let record = load_space_record(tx, &scope.space_id).await?;
    record.scope.check(scope)?;
    validate_cut(tx, &record, cutoff).await
}

async fn schema_at(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cut: SpaceSeq,
) -> Result<Option<ProjectedSchemaSnapshot>, PortError> {
    const QUERY: &str = "SELECT s.schema_rev_id, s.schema_note_id,
            s.descriptor_fingerprint, s.descriptor_msgpack
        FROM space_field_schemas s
        WHERE s.space_id = $1 AND s.visibility_seq <= $2
        ORDER BY s.visibility_seq DESC, s.schema_rev_id DESC LIMIT 1";
    read_rows!(
        tx,
        fetch_optional,
        "projection_schema_at",
        (String, String, Vec<u8>, Vec<u8>),
        QUERY,
        scope.space_id.as_str(),
        cut.get() as i64,
    )?
    .map(|(rev, note, fingerprint, descriptor)| {
        Ok(ProjectedSchemaSnapshot {
            schema_rev_id: RevisionId::parse(&rev)?,
            schema_note_id: NoteId::parse(&note)?,
            descriptor_fingerprint: ContentDigest::from_bytes(
                fingerprint
                    .try_into()
                    .map_err(|_| corrupt("invalid schema descriptor fingerprint"))?,
            ),
            fields: decode_msgpack_bounded(&descriptor, MAX_MSGPACK_DECODE_BYTES)?,
        })
    })
    .transpose()
}

// The correlated probes use canonical's entity/cut indexes. The head maps
// stable key and creation witnesses while the revisions supply content as of
// the cut. Ability publishers can change attachment without a note revision.
macro_rules! note_snapshot_sql {
    () => {
        "SELECT h.note_id, h.created_at_sec, CAST(h.created_at_nsec AS BIGINT),
            r.rev_id, r.visibility_seq, r.created_at_sec, CAST(r.created_at_nsec AS BIGINT),
            r.content_blake3, r.metadata_msgpack, b.rev_id, b.metadata_msgpack
         FROM note_heads h
         LEFT JOIN revisions r ON r.space_id = h.space_id AND r.rev_id = (
            SELECT x.rev_id FROM revisions x
            WHERE x.space_id = h.space_id AND x.entity_type = 'note'
              AND x.entity_key = h.note_id AND x.visibility_seq <= $3 AND x.history_incarnation = $2
            ORDER BY x.visibility_seq DESC, x.space_seq DESC LIMIT 1
         )
         LEFT JOIN revisions b ON b.space_id = h.space_id AND b.rev_id = (
            SELECT x.rev_id FROM revisions x
            WHERE x.space_id = h.space_id AND x.entity_type = 'ability'
              AND x.entity_key = h.ability_id AND x.visibility_seq <= $3 AND x.history_incarnation = $2
            ORDER BY x.visibility_seq DESC, x.space_seq DESC LIMIT 1
         )
         WHERE h.space_id = $1 AND h.created_seq <= $3 AND NOT EXISTS (
            SELECT 1 FROM revision_purge_fences p
            WHERE p.space_id = h.space_id AND p.note_id = h.note_id
         ) AND "
    };
}

macro_rules! folder_snapshot_sql {
    () => {
        "FROM folder_heads h
         LEFT JOIN revisions r ON r.space_id = h.space_id AND r.rev_id = (
            SELECT x.rev_id FROM revisions x
            WHERE x.space_id = h.space_id AND x.entity_type = 'folder'
              AND x.entity_key = h.folder_id AND x.visibility_seq <= $3 AND x.history_incarnation = $2
            ORDER BY x.visibility_seq DESC, x.space_seq DESC LIMIT 1
         )
         WHERE h.space_id = $1 AND h.created_seq <= $3 AND "
    };
}

use folder_snapshot_sql;
use note_snapshot_sql;

type NoteRow = (
    String,
    i64,
    i64,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<Vec<u8>>,
    Option<Vec<u8>>,
    Option<String>,
    Option<Vec<u8>>,
);
type FolderRow = (String, Option<String>, Option<i64>, Option<Vec<u8>>);

pub(crate) async fn note_at(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    id: &NoteId,
) -> Result<Option<ProjectionNote>, PortError> {
    read_rows!(
        tx,
        fetch_optional,
        "projection_note_at",
        NoteRow,
        concat!(note_snapshot_sql!(), " h.note_id = $4"),
        scope.space_id.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        cutoff.get() as i64,
        id.as_str(),
    )?
    .map(|record| note_from_row(scope, cutoff, record))
    .transpose()
}

fn note_from_row(
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    (
        id,
        created_sec,
        created_nsec,
        rev,
        visible,
        updated_sec,
        updated_nsec,
        digest,
        meta,
        ability_rev,
        ability_meta,
    ): NoteRow,
) -> Result<ProjectionNote, PortError> {
    let (Some(rev), Some(visible), Some(updated_sec), Some(updated_nsec), Some(meta)) =
        (rev, visible, updated_sec, updated_nsec, meta)
    else {
        return Err(stale());
    };
    let revision_id = RevisionId::parse(&rev)?;
    let RevisionMetadataPayload::Note(mut metadata) =
        RevisionMetadataEnvelope::decode(&meta)?.payload
    else {
        return Err(corrupt("expected a note revision"));
    };
    if metadata.note_id.as_str() != id || metadata.lifecycle == Lifecycle::Purged {
        return Err(corrupt("note revision identity does not match its head"));
    }
    metadata.ability_id = if let Some(bytes) = ability_meta {
        let RevisionMetadataPayload::Ability(ability) =
            RevisionMetadataEnvelope::decode(&bytes)?.payload
        else {
            return Err(corrupt("expected an ability revision"));
        };
        if ability.entrypoint_note_id != metadata.note_id {
            return Err(corrupt("ability revision does not match its entrypoint"));
        }
        (ability.lifecycle == Lifecycle::Active).then_some(ability.ability_id)
    } else {
        None
    };
    let rank_version = note_rank_version_digest(
        &revision_id,
        ability_rev
            .as_deref()
            .filter(|_| metadata.ability_id.is_some()),
    );
    let (carrier_digest, header_diagnostic) = if metadata.doc_class == DocClass::EncryptedNote {
        metadata.raw_fields = None;
        metadata.evaluated_fields.clear();
        metadata.diagnostics.clear();
        (None, None)
    } else {
        let digest = ContentDigest::from_bytes(
            digest
                .ok_or_else(stale)?
                .try_into()
                .map_err(|_| corrupt("invalid carrier digest"))?,
        );
        if metadata.content_digest != Some(digest) {
            return Err(corrupt("carrier digest does not match revision metadata"));
        }
        let header_diagnostic = metadata
            .raw_fields
            .is_none()
            .then(|| metadata.diagnostics.first().cloned())
            .flatten();
        (Some(digest), header_diagnostic)
    };
    let carrier = CarrierWitness {
        scope: scope.clone(),
        cutoff,
        note_id: metadata.note_id.clone(),
        digest: carrier_digest,
    };
    Ok(ProjectionNote {
        metadata,
        revision_id,
        visibility_seq: i64_to_space_seq(visible)?,
        created_at: timestamp(created_sec, created_nsec)?,
        updated_at: timestamp(updated_sec, updated_nsec)?,
        rank_version,
        header_diagnostic,
        carrier,
    })
}

fn timestamp(seconds: i64, nanos: i64) -> Result<Timestamp, PortError> {
    let nanos = i32::try_from(nanos).map_err(|_| corrupt("invalid timestamp nanos"))?;
    Ok(decode_timestamp_parts(seconds, nanos)?)
}

async fn folder_at(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    id: &FolderId,
) -> Result<Option<ProjectionFolder>, PortError> {
    let row = read_rows!(
        tx,
        fetch_optional,
        "projection_folder_at",
        FolderRow,
        concat!(
            "SELECT h.folder_id, r.rev_id, r.visibility_seq, r.metadata_msgpack ",
            folder_snapshot_sql!(),
            " h.folder_id = $4",
        ),
        scope.space_id.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        cutoff.get() as i64,
        id.as_str(),
    )?;
    match row {
        Some(record) => Ok(Some(folder_from_row(tx, scope, record).await?)),
        None => Ok(None),
    }
}

async fn folder_from_row(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    (id, rev, visible, meta): FolderRow,
) -> Result<ProjectionFolder, PortError> {
    let (Some(rev), Some(visible), Some(meta)) = (rev, visible, meta) else {
        return Err(stale());
    };
    let RevisionMetadataPayload::Folder(mut metadata) =
        RevisionMetadataEnvelope::decode(&meta)?.payload
    else {
        return Err(corrupt("expected a folder revision"));
    };
    if metadata.folder_id.as_str() != id {
        return Err(corrupt("folder revision identity does not match its head"));
    }
    if let Some(cover) = &metadata.cover_note_id
        && is_note_purge_fenced_tx(tx, &scope.space_id, cover.as_str()).await?
    {
        metadata.cover_note_id = None;
    }
    Ok(ProjectionFolder {
        metadata,
        revision_id: RevisionId::parse(&rev)?,
        visibility_seq: i64_to_space_seq(visible)?,
    })
}
