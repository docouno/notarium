//! Durable anonymous storage attempts that can be reclaimed after lease loss.

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ArtifactId, ContentDigest, HistoryIncarnation, PrincipalId},
    model::HistoryScope,
    ports::{CallBudget, ContentJobKind, SpaceContext},
};

use super::archive_import::{ArchiveObject, ArchiveObjectKind};
use super::{job_clock_ms, lock_peer_space, require_active_job_lease_tx};
use crate::{
    CanonicalStore, ClaimedContentJob,
    codec::{MAX_MSGPACK_DECODE_BYTES, encode_msgpack, internal_not_committed},
    domain::common::CommandDeadline,
    sql_exec::BackendConn,
};

pub struct AbandonedArchiveUpload {
    pub scope: notarium_core::model::HistoryScope,
    pub id: ArtifactId,
    pub kind: ArchiveObjectKind,
    pub bytes: u64,
    pub namespace: ContentDigest,
}

const MAX_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const SOURCE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

impl CanonicalStore {
    pub async fn reserve_archive_source_upload(
        &self,
        ctx: &SpaceContext,
        id: ArtifactId,
        bytes: u64,
        namespace: ContentDigest,
    ) -> Result<(), PortError> {
        if !(1..=MAX_BYTES).contains(&bytes) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let remaining = i64::try_from(ctx.budget.remaining.as_millis())
            .map_err(|_| invalid(ValidationReason::InvalidLimit))?;
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        let inner = self.inner.clone();
        let deadline = CommandDeadline::start(&ctx.budget, "reserve_archive_source");
        self.with_auxiliary_command(Some((&ctx.budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                let space = lock_peer_space(tx, &inner, &scope).await?;
                super::authorize_job_write_on_space(&auth, &space.space)?;
                let now = job_clock_ms(tx).await?;
                let expires = now.checked_add(remaining).ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                const INSERT: &str = "INSERT INTO archive_uploads(space_id,artifact_id,history_incarnation,object_kind,object_bytes,state,created_at_ms,source_deadline_ms,object_namespace,source_owner)
                    VALUES($1,$2,$3,'input',$4,'pending',$5,$6,$7,$8)";
                macro_rules! insert {
                    ($conn:expr) => { sqlx::query(INSERT).bind(scope.space_id.as_str()).bind(id.as_str())
                        .bind(scope.incarnation.as_bytes().as_slice()).bind(bytes as i64).bind(now).bind(expires).bind(namespace.as_bytes().as_slice())
                        .bind(auth.principal().as_str())
                        .execute(&mut **$conn).await.map(|_| ()) };
                }
                match tx { BackendConn::Sqlite(conn) => insert!(conn), BackendConn::Postgres(conn) => insert!(conn) }.map_err(sql_error)
            })
        }).await
    }

    pub async fn finish_archive_source_upload(
        &self,
        ctx: &SpaceContext,
        object: ArchiveObject,
    ) -> Result<(), PortError> {
        let scope = ctx.scope().clone();
        object.scope.check(&scope)?;
        if object.installation != *self.installation_id()
            || object.kind != ArchiveObjectKind::Source
            || !(1..=MAX_BYTES).contains(&object.bytes)
        {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        let encoded = encode_msgpack(&object)?;
        if encoded.len() > MAX_MSGPACK_DECODE_BYTES {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let auth = ctx.auth().clone();
        let inner = self.inner.clone();
        let deadline = CommandDeadline::start(&ctx.budget, "finish_archive_source");
        self.with_auxiliary_command(Some((&ctx.budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                let space = lock_peer_space(tx, &inner, &scope).await?;
                super::authorize_job_write_on_space(&auth, &space.space)?;
                let now = job_clock_ms(tx).await?;
                const READY: &str = "UPDATE archive_uploads SET state='pinned', source_deadline_ms=$5, source_object=$6
                    WHERE space_id=$1 AND artifact_id=$2 AND history_incarnation=$3 AND object_kind='input'
                    AND state='pending' AND source_deadline_ms>$4 AND object_namespace=$7
                    AND object_bytes=$8 AND source_owner=$9";
                macro_rules! finish {
                    ($conn:expr) => { sqlx::query(READY).bind(scope.space_id.as_str()).bind(object.id.as_str())
                        .bind(scope.incarnation.as_bytes().as_slice()).bind(now).bind(now + SOURCE_TTL_MS)
                        .bind(encoded).bind(object.namespace.as_bytes().as_slice()).bind(object.bytes as i64)
                        .bind(auth.principal().as_str()).execute(&mut **$conn).await
                        .map(|result| result.rows_affected()) };
                }
                let changed = match tx { BackendConn::Sqlite(conn) => finish!(conn), BackendConn::Postgres(conn) => finish!(conn) }.map_err(sql_error)?;
                if changed == 1 { Ok(()) } else { Err(invalid(ValidationReason::InvalidAuthority)) }
            })
        }).await
    }

    /// Journal the private generation before creating the first physical key.
    pub async fn reserve_archive_upload(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
        id: ArtifactId,
        kind: ArchiveObjectKind,
        bytes: u64,
        namespace: ContentDigest,
    ) -> Result<(), PortError> {
        if !(1..=MAX_BYTES).contains(&bytes) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let kind = kind_name(&kind)?;
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        let inner = self.inner.clone();
        let claim = claim.clone();
        let deadline = CommandDeadline::start(&ctx.budget, "reserve_archive_upload");
        self.with_auxiliary_command(Some((&ctx.budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                let space = lock_peer_space(tx, &inner, &scope).await?;
                super::authorize_job_write_on_space(&auth, &space.space)?;
                let (job, now, erased) = require_active_job_lease_tx(tx, &scope, &claim.job.id, &claim.lease_owner, claim.job.lease).await?;
                let compatible = matches!((&job.kind, kind), (ContentJobKind::Import { .. }, "plan")
                    | (ContentJobKind::Export { .. } | ContentJobKind::ExportSpace { .. }, "export"));
                if erased || !compatible { return Err(invalid(ValidationReason::InvalidAuthority)); }
                const INSERT: &str = "INSERT INTO archive_uploads(space_id,artifact_id,job_id,history_incarnation,lease_epoch,object_kind,object_bytes,state,created_at_ms,object_namespace)
                    VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)";
                macro_rules! insert {
                    ($conn:expr) => { sqlx::query(INSERT).bind(scope.space_id.as_str()).bind(id.as_str()).bind(job.id.as_str())
                        .bind(scope.incarnation.as_bytes().as_slice()).bind(job.lease.get() as i64).bind(kind)
                        .bind(bytes as i64).bind(now).bind(namespace.as_bytes().as_slice()).execute(&mut **$conn).await.map(|_| ()) };
                }
                match tx { BackendConn::Sqlite(conn) => insert!(conn), BackendConn::Postgres(conn) => insert!(conn) }.map_err(sql_error)
            })
        }).await
    }

    /// Select and mark only generations that can no longer be installed. A
    /// pinned import plan stays available across worker and lease turnover.
    pub async fn take_abandoned_archive_uploads(
        &self,
        budget: &CallBudget,
        namespace: ContentDigest,
    ) -> Result<Vec<AbandonedArchiveUpload>, PortError> {
        let deadline = CommandDeadline::start(budget, "claim_archive_storage_cleanup");
        self.with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                let now = job_clock_ms(tx).await?;
                const TAKE: &str = "UPDATE archive_uploads AS retiring SET state='retiring'
                    WHERE (space_id,artifact_id) IN (SELECT a.space_id,a.artifact_id FROM archive_uploads a
                       LEFT JOIN content_jobs j ON j.space_id=a.space_id AND j.job_id=a.job_id
                       JOIN spaces s ON s.space_id=a.space_id
                       WHERE a.object_namespace=$2 AND (a.state='retiring' OR a.history_incarnation<>s.history_incarnation
                           OR (a.source_deadline_ms<=$1 AND NOT EXISTS(SELECT 1 FROM archive_import_sources r
                               JOIN content_jobs u ON u.space_id=r.space_id AND u.job_id=r.job_id
                               WHERE r.space_id=a.space_id AND r.artifact_id=a.artifact_id AND u.state IN ('queued','running')))
                           OR j.state IN ('failed','succeeded','cancelled')
                           OR (a.state='pending' AND (j.state<>'running' OR j.lease_epoch<>a.lease_epoch OR j.lease_until_ms<=$1
                               OR j.claim_space_epoch IS DISTINCT FROM s.active_epoch)))
                       ORDER BY a.created_at_ms,a.space_id,a.artifact_id LIMIT 16)
                    AND (state='retiring' OR (source_deadline_ms<=$1 AND NOT EXISTS(SELECT 1 FROM archive_import_sources r
                       JOIN content_jobs u ON u.space_id=r.space_id AND u.job_id=r.job_id
                       WHERE r.space_id=retiring.space_id AND r.artifact_id=retiring.artifact_id AND u.state IN ('queued','running')))
                       OR EXISTS(SELECT 1 FROM spaces s LEFT JOIN content_jobs j
                       ON j.space_id=s.space_id AND j.job_id=retiring.job_id WHERE s.space_id=retiring.space_id AND
                         (j.state IN ('failed','succeeded','cancelled') OR retiring.history_incarnation<>s.history_incarnation
                          OR (retiring.state='pending' AND (j.state<>'running' OR j.lease_epoch<>retiring.lease_epoch OR j.lease_until_ms<=$1
                            OR j.claim_space_epoch IS DISTINCT FROM s.active_epoch)))))
                    RETURNING space_id,history_incarnation,artifact_id,object_kind,object_bytes,object_namespace";
                type Row = (String, Vec<u8>, String, String, i64, Vec<u8>);
                let rows: Vec<Row> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_as(TAKE).bind(now).bind(namespace.as_bytes().as_slice()).fetch_all(&mut **conn).await,
                    BackendConn::Postgres(conn) => sqlx::query_as(TAKE).bind(now).bind(namespace.as_bytes().as_slice()).fetch_all(&mut **conn).await,
                }.map_err(sql_error)?;
                rows.into_iter().map(|(space, history, id, kind, bytes, namespace)| {
                    let scope = notarium_core::model::HistoryScope {
                        space_id: notarium_core::ids::SpaceId::parse(&space)?,
                        incarnation: HistoryIncarnation::from_bytes(history.try_into().map_err(|_| invalid(ValidationReason::InvalidState))?),
                    };
                    let kind = match kind.as_str() {
                        "input" => ArchiveObjectKind::Source,
                        "plan" => ArchiveObjectKind::ImportPlan,
                        "export" => ArchiveObjectKind::Export,
                        _ => return Err(invalid(ValidationReason::InvalidState)),
                    };
                    let bytes = u64::try_from(bytes).map_err(|_| invalid(ValidationReason::InvalidState))?;
                    if !(1..=MAX_BYTES).contains(&bytes) { return Err(invalid(ValidationReason::InvalidLimit)); }
                    let namespace = ContentDigest::from_bytes(namespace.try_into().map_err(|_| invalid(ValidationReason::InvalidDigest))?);
                    Ok(AbandonedArchiveUpload { scope, id: ArtifactId::parse(&id)?, kind, bytes, namespace })
                }).collect()
            })
        }).await
    }

    pub async fn finish_archive_upload_cleanup(
        &self,
        budget: &CallBudget,
        upload: AbandonedArchiveUpload,
    ) -> Result<(), PortError> {
        let deadline = CommandDeadline::start(budget, "finish_archive_storage_cleanup");
        self.with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                const DELETE: &str = "DELETE FROM archive_uploads WHERE space_id=$1 AND artifact_id=$2 AND history_incarnation=$3 AND state='retiring'";
                macro_rules! delete {
                    ($conn:expr) => { sqlx::query(DELETE).bind(upload.scope.space_id.as_str()).bind(upload.id.as_str())
                        .bind(upload.scope.incarnation.as_bytes().as_slice()).execute(&mut **$conn).await.map(|_| ()) };
                }
                match tx { BackendConn::Sqlite(conn) => delete!(conn), BackendConn::Postgres(conn) => delete!(conn) }.map_err(sql_error)?;
                if upload.kind == ArchiveObjectKind::Source {
                    const DROP_LOCATORS: &str = "DELETE FROM archive_import_sources WHERE space_id=$1 AND artifact_id=$2";
                    macro_rules! clear {
                        ($conn:expr) => { sqlx::query(DROP_LOCATORS).bind(upload.scope.space_id.as_str())
                            .bind(upload.id.as_str()).execute(&mut **$conn).await.map(|_| ()) };
                    }
                    match tx { BackendConn::Sqlite(conn) => clear!(conn), BackendConn::Postgres(conn) => clear!(conn) }.map_err(sql_error)?;
                }
                Ok(())
            })
        }).await
    }
}

pub(super) async fn attach_archive_source_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    id: &ArtifactId,
    owner: &PrincipalId,
) -> Result<Vec<u8>, PortError> {
    let now = job_clock_ms(tx).await?;
    // Renew the journal row in the admission transaction. A janitor whose
    // statement began earlier must recheck its deadline after this row lock.
    const ATTACH: &str = "UPDATE archive_uploads SET source_deadline_ms=$5
        WHERE space_id=$1 AND artifact_id=$2 AND history_incarnation=$3 AND source_owner=$4
          AND object_kind='input' AND state='pinned' AND source_deadline_ms>$6
        RETURNING source_object";
    macro_rules! attach {
        ($conn:expr) => {
            sqlx::query_scalar::<_, Vec<u8>>(ATTACH)
                .bind(scope.space_id.as_str())
                .bind(id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(owner.as_str())
                .bind(now + SOURCE_TTL_MS)
                .bind(now)
                .fetch_optional(&mut **$conn)
                .await
        };
    }
    match tx {
        BackendConn::Sqlite(conn) => attach!(conn),
        BackendConn::Postgres(conn) => attach!(conn),
    }
    .map_err(sql_error)?
    .ok_or_else(|| DomainError::ResourceNotFound.into())
}

pub(super) async fn consume_archive_upload_tx(
    tx: &mut BackendConn<'_>,
    object: &ArchiveObject,
    job: &notarium_core::ids::JobId,
    lease: notarium_core::ids::LeaseEpoch,
) -> Result<(), PortError> {
    let kind = kind_name(&object.kind)?;
    const PREDICATE: &str = " WHERE space_id=$1 AND artifact_id=$2 AND job_id=$3 AND history_incarnation=$4
                        AND lease_epoch=$5 AND object_kind=$6 AND object_bytes=$7 AND object_namespace=$8 AND state='pending'";
    let mutation = if object.kind == ArchiveObjectKind::ImportPlan {
        "UPDATE archive_uploads SET state='pinned'"
    } else {
        "DELETE FROM archive_uploads"
    };
    let sql = sqlx::AssertSqlSafe(format!("{mutation}{PREDICATE}"));
    macro_rules! execute {
        ($conn:expr) => {
            sqlx::query(sql)
                .bind(object.scope.space_id.as_str())
                .bind(object.id.as_str())
                .bind(job.as_str())
                .bind(object.scope.incarnation.as_bytes().as_slice())
                .bind(lease.get() as i64)
                .bind(kind)
                .bind(object.bytes as i64)
                .bind(object.namespace.as_bytes().as_slice())
                .execute(&mut **$conn)
                .await
                .map(|result| result.rows_affected())
        };
    }
    let changed = match tx {
        BackendConn::Sqlite(conn) => execute!(conn),
        BackendConn::Postgres(conn) => execute!(conn),
    }
    .map_err(sql_error)?;
    if changed == 1 {
        Ok(())
    } else {
        Err(invalid(ValidationReason::InvalidAuthority))
    }
}

fn kind_name(kind: &ArchiveObjectKind) -> Result<&'static str, PortError> {
    match kind {
        ArchiveObjectKind::ImportPlan => Ok("plan"),
        ArchiveObjectKind::Export => Ok("export"),
        ArchiveObjectKind::Source => Err(invalid(ValidationReason::InvalidAuthority)),
    }
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}
fn sql_error(err: sqlx::Error) -> PortError {
    internal_not_committed("archive_upload_registry", err.to_string())
}
