//! Canonical import plan and writer fence. Operational storage owns the bytes.

use std::sync::{Arc, Mutex};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ArtifactId, ContentDigest, FolderId, InstallationId, JobId, LeaseEpoch},
    model::{HistoryScope, PathTarget},
    ports::{
        Committed, ContentJob, ContentJobKind, CreateNote, Mutation, RevocationLease, SpaceContext,
    },
};
use serde::{Deserialize, Serialize};

use crate::{
    CanonicalStore, ClaimedContentJob,
    blobs::lock_and_check_space_tx,
    codec::{
        MAX_MSGPACK_DECODE_BYTES, decode_msgpack_bounded, encode_msgpack, internal_not_committed,
        normalize_slug_key,
    },
    domain::{
        common::{
            CommandDeadline, StoredCommittedNoteRevV1, active_note_sibling_exists_tx,
            build_resource_facts_tx,
        },
        notes::{analyze_and_prepare_carrier, build_create_note_intent},
    },
    runtime::load_space_record,
    sql_exec::BackendConn,
};

use super::require_active_job_lease_tx;

const IMPORT_BATCH_LIMIT: usize = 200;
const IMPORT_BATCH_BYTES: usize = 32 * 1024 * 1024;
const PLAN_TAG: &[u8] = b"NIP1\0";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ArchiveObjectKind {
    Source,
    ImportPlan,
    Export,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArchiveSegment {
    pub digest: ContentDigest,
    pub bytes: u32,
    pub version: Option<String>,
}

/// No physical object key or path comes from a user or a restored database.
/// Storage derives it from the trusted namespace and these typed identities.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArchiveObject {
    pub installation: InstallationId,
    pub namespace: ContentDigest,
    pub scope: HistoryScope,
    pub id: ArtifactId,
    pub kind: ArchiveObjectKind,
    pub digest: ContentDigest,
    pub bytes: u64,
    pub segments: Vec<ArchiveSegment>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PinnedImportPlan {
    pub source: ArtifactId,
    pub source_digest: ContentDigest,
    pub object: ArchiveObject,
    pub entries: u64,
}

#[derive(Clone, Debug)]
pub struct ImportProgress {
    pub plan: Option<PinnedImportPlan>,
    pub applied: u64,
}

/// An expected rooted path, including the immutable IDs of each ancestor.
#[derive(Clone, Debug)]
pub struct ImportParent {
    pub root: FolderId,
    pub ancestors: Vec<(String, FolderId)>,
}

impl ImportParent {
    pub fn folder(&self) -> &FolderId {
        self.ancestors.last().map_or(&self.root, |(_, id)| id)
    }
}

#[derive(Debug)]
pub struct PlannedImportNote {
    pub ordinal: u64,
    pub parent: ImportParent,
    pub note: CreateNote,
}

#[derive(Clone, Debug)]
pub struct PlannedImportFolder {
    pub ordinal: u64,
    pub parent: ImportParent,
    pub id: FolderId,
    pub slug: String,
    pub reuse: bool,
}

/// A clone belongs to each admitted writer operation. Control's revocation
/// barrier waits for the last clone, including work whose waiter left early.
#[derive(Clone)]
pub struct ArchiveCommitAuthority(Arc<Mutex<Box<dyn RevocationLease>>>);

impl ArchiveCommitAuthority {
    pub fn new(lease: Box<dyn RevocationLease>) -> Self {
        Self(Arc::new(Mutex::new(lease)))
    }

    pub fn check(&self) -> Result<(), PortError> {
        self.0.lock().unwrap_or_else(|err| err.into_inner()).check()
    }
}

#[derive(Clone)]
pub(crate) struct ImportFolderCommit {
    pub(crate) fence: ImportFence,
    pub(crate) ordinal: u64,
    pub(crate) parent: ImportParent,
    pub(crate) auth: notarium_core::auth::EngineAuthContext,
    pub(crate) authority: ArchiveCommitAuthority,
}

impl ImportFolderCommit {
    pub(crate) async fn check_tx(
        &self,
        tx: &mut BackendConn<'_>,
        space: &crate::SpaceRecord,
    ) -> Result<(), PortError> {
        self.authority.check()?;
        validate_import_parent_tx(tx, &self.fence.scope, &space.root_folder_id, &self.parent)
            .await?;
        let (facts, _) = build_resource_facts_tx(
            tx,
            &space.space,
            self.parent.folder(),
            DocClass::UserDoc,
            None,
            true,
        )
        .await?;
        self.auth.authorize_direct_write(&facts, &facts)?;
        self.fence.check_and_apply(tx, self.ordinal).await
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ImportFence {
    pub(crate) scope: HistoryScope,
    job: JobId,
    owner: String,
    epoch: LeaseEpoch,
    plan: ContentDigest,
}

impl ImportFence {
    pub(crate) fn new(
        scope: &HistoryScope,
        claim: &ClaimedContentJob,
        plan: ContentDigest,
    ) -> Self {
        Self {
            scope: scope.clone(),
            job: claim.job.id.clone(),
            owner: claim.lease_owner.clone(),
            epoch: claim.job.lease,
            plan,
        }
    }

    pub(crate) async fn check_and_apply(
        &self,
        tx: &mut BackendConn<'_>,
        ordinal: u64,
    ) -> Result<(), PortError> {
        let ordinal =
            i64::try_from(ordinal).map_err(|_| invalid(ValidationReason::InvalidRange))?;
        let mut tag = PLAN_TAG.to_vec();
        tag.extend_from_slice(self.plan.as_bytes());
        macro_rules! advance {
            ($clock:literal) => {
                concat!(
                    "UPDATE content_jobs SET completed_units=$1
                    WHERE space_id=$2 AND job_id=$3 AND lease_owner=$4 AND lease_epoch=$5
                      AND substr(result_msgpack,1,37)=$6 AND completed_units=$1-1
                      AND state='running' AND job_kind='import' AND payload_erased_by_purge=0
                      AND claim_space_epoch=(SELECT active_epoch FROM spaces WHERE space_id=$2)
                      AND total_units >= $1 AND lease_until_ms>", $clock,
                )
            };
        }
        let rows = match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(advance!("CAST(unixepoch('subsec')*1000 AS INTEGER)"))
                    .bind(ordinal)
                    .bind(self.scope.space_id.as_str())
                    .bind(self.job.as_str())
                    .bind(&self.owner)
                    .bind(self.epoch.get() as i64)
                    .bind(&tag)
                    .execute(&mut **conn)
                    .await
                    .map(|result| result.rows_affected())
            }
            BackendConn::Postgres(conn) => sqlx::query(advance!(
                "floor(extract(epoch from clock_timestamp())*1000)::BIGINT"
            ))
            .bind(ordinal)
            .bind(self.scope.space_id.as_str())
            .bind(self.job.as_str())
            .bind(&self.owner)
            .bind(self.epoch.get() as i64)
            .bind(&tag)
            .execute(&mut **conn)
            .await
            .map(|result| result.rows_affected()),
        }
        .map_err(|err| internal_not_committed("import_progress", err.to_string()))?;
        if rows == 0 {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        Ok(())
    }
}

impl CanonicalStore {
    pub async fn create_archive_import_job(
        &self,
        ctx: SpaceContext,
        request: Mutation<ContentJobKind>,
    ) -> Result<Committed<ContentJob>, PortError> {
        super::create_job_impl(self, ctx, request, true).await
    }

    pub async fn pinned_import_source(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
    ) -> Result<ArchiveObject, PortError> {
        let scope = ctx.scope().clone();
        let claim = claim.clone();
        let installation = self.installation_id().clone();
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                load_space_record(tx, &scope.space_id)
                    .await?
                    .scope
                    .check(&scope)?;
                let (job, _, erased) = require_active_job_lease_tx(
                    tx,
                    &scope,
                    &claim.job.id,
                    &claim.lease_owner,
                    claim.job.lease,
                )
                .await?;
                let ContentJobKind::Import { artifact } = job.kind else {
                    return Err(invalid(ValidationReason::InvalidAuthority));
                };
                if erased {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let source = import_source_tx(tx, &scope, &claim.job.id).await?;
                if source.scope != scope
                    || source.installation != installation
                    || source.id != artifact
                    || source.kind != ArchiveObjectKind::Source
                {
                    return Err(invalid(ValidationReason::InvalidAuthority));
                }
                Ok(source)
            })
        })
        .await
    }

    pub async fn import_progress(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
    ) -> Result<ImportProgress, PortError> {
        let scope = ctx.scope().clone();
        let claim = claim.clone();
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                load_space_record(tx, &scope.space_id)
                    .await?
                    .scope
                    .check(&scope)?;
                check_import_tx(
                    tx,
                    &scope,
                    &claim.job.id,
                    &claim.lease_owner,
                    claim.job.lease,
                )
                .await
            })
        })
        .await
    }

    /// The first durable plan wins. Retrying after an unknown COMMIT fetches
    /// the original immutable identity and ordinal from canonical storage.
    pub async fn install_import_plan(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
        plan: PinnedImportPlan,
        authority: ArchiveCommitAuthority,
    ) -> Result<ImportProgress, PortError> {
        let scope = ctx.scope().clone();
        plan.object.scope.check(&scope)?;
        if plan.object.installation != self.inner.config.installation_id
            || plan.object.kind != ArchiveObjectKind::ImportPlan
            || plan.entries > 100_000
            || plan.object.bytes == 0
            || !matches!(&claim.job.kind, ContentJobKind::Import { artifact } if artifact == &plan.source)
        {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        let deadline = CommandDeadline::start(&ctx.budget, "install_import_plan");
        let space = self
            .read_space_fast_or_pool(&scope.space_id, Some(&ctx.budget))
            .await?;
        let claimant = claim.clone();
        let auth = ctx.auth().clone();
        let retained = authority.clone();
        self.with_auxiliary_command(
            Some((&ctx.budget, deadline)),
            move |progress| {
                drop(retained);
                Ok(progress)
            },
            move |tx| {
                Box::pin(async move {
                    authority.check()?;
                    lock_and_check_space_tx(tx, &scope, space.active_epoch).await?;
                    let live = load_space_record(tx, &scope.space_id).await?;
                    auth.authorize_space_write(&live.space)?;
                    let progress = check_import_tx(
                        tx,
                        &scope,
                        &claimant.job.id,
                        &claimant.lease_owner,
                        claimant.job.lease,
                    )
                    .await?;
                    if let Some(existing) = &progress.plan {
                        if existing.source != plan.source
                            || existing.source_digest != plan.source_digest
                        {
                            return Err(invalid(ValidationReason::InvalidDigest));
                        }
                        return Ok(progress);
                    }
                    let source = import_source_tx(tx, &scope, &claimant.job.id).await?;
                    if source.id != plan.source || source.digest != plan.source_digest {
                        return Err(invalid(ValidationReason::InvalidDigest));
                    }
                    super::archive_uploads::consume_archive_upload_tx(
                        tx,
                        &plan.object,
                        &claimant.job.id,
                        claimant.job.lease,
                    )
                    .await?;
                    let mut wire = PLAN_TAG.to_vec();
                    wire.extend_from_slice(plan.object.digest.as_bytes());
                    wire.extend(encode_msgpack(&plan)?);
                    if wire.len() > MAX_MSGPACK_DECODE_BYTES {
                        return Err(invalid(ValidationReason::BudgetExceeded));
                    }
                    let sql =
                    "UPDATE content_jobs SET result_msgpack=$1, completed_units=0, total_units=$2
                WHERE space_id=$3 AND job_id=$4";
                    match tx {
                        BackendConn::Sqlite(conn) => sqlx::query(sql)
                            .bind(&wire)
                            .bind(plan.entries as i64)
                            .bind(scope.space_id.as_str())
                            .bind(claimant.job.id.as_str())
                            .execute(&mut **conn)
                            .await
                            .map(|_| ()),
                        BackendConn::Postgres(conn) => sqlx::query(sql)
                            .bind(&wire)
                            .bind(plan.entries as i64)
                            .bind(scope.space_id.as_str())
                            .bind(claimant.job.id.as_str())
                            .execute(&mut **conn)
                            .await
                            .map(|_| ()),
                    }
                    .map_err(|err| {
                        internal_not_committed("install_import_plan", err.to_string())
                    })?;
                    Ok(ImportProgress {
                        plan: Some(plan),
                        applied: 0,
                    })
                })
            },
        )
        .await
    }

    pub async fn apply_import_folder(
        &self,
        ctx: &SpaceContext,
        claim: &ClaimedContentJob,
        plan: ContentDigest,
        folder: PlannedImportFolder,
        authority: ArchiveCommitAuthority,
    ) -> Result<(), PortError> {
        let scope = ctx.scope().clone();
        let space = self
            .read_space_fast_or_pool(&scope.space_id, Some(&ctx.budget))
            .await?;
        space.scope.check(&scope)?;
        let guard = ImportFolderCommit {
            fence: ImportFence::new(&scope, claim, plan),
            ordinal: folder.ordinal,
            parent: folder.parent,
            auth: ctx.auth().clone(),
            authority,
        };
        if folder.reuse {
            let deadline = CommandDeadline::start(&ctx.budget, "reuse_import_folder");
            let slug_fold = normalize_slug_key(&folder.slug)?;
            let retained = guard.authority.clone();
            return self
                .with_auxiliary_command(
                    Some((&ctx.budget, deadline)),
                    move |()| {
                        drop(retained);
                        Ok(())
                    },
                    move |tx| {
                        Box::pin(async move {
                            lock_and_check_space_tx(tx, &scope, space.active_epoch).await?;
                            let live = load_space_record(tx, &scope.space_id).await?;
                            guard.check_tx(tx, &live).await?;
                            let actual =
                                folder_at_tx(tx, &scope, guard.parent.folder(), &slug_fold).await?;
                            if actual.as_ref() != Some(&folder.id) {
                                return Err(path_conflict(
                                    &scope,
                                    guard.parent.folder(),
                                    &folder.slug,
                                ));
                            }
                            Ok(())
                        })
                    },
                )
                .await;
        }
        self.create_folder_import(
            crate::CreateFolderSpec {
                scope,
                active_epoch: space.active_epoch,
                folder_id: folder.id,
                parent: Some(guard.parent.folder().clone()),
                slug: folder.slug.clone(),
                display_name: folder.slug,
                is_project: false,
                project_slug: None,
                actor: ctx.auth().principal().clone(),
                timestamp: None,
            },
            &ctx.budget,
            guard,
        )
        .await
        .map(drop)
    }

    /// Validate archive placement using canonical path and class rules. A
    /// folder may be reused only when it occupies the checked path.
    pub async fn inspect_import_path(
        &self,
        ctx: &SpaceContext,
        parent: &ImportParent,
        slug: &str,
        class: Option<DocClass>,
    ) -> Result<Option<FolderId>, PortError> {
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        let parent = parent.clone();
        let slug = slug.to_owned();
        let fold = normalize_slug_key(&slug)?;
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let live = load_space_record(tx, &scope.space_id).await?;
                live.scope.check(&scope)?;
                validate_import_parent_tx(tx, &scope, &live.root_folder_id, &parent).await?;
                let (facts, _) = build_resource_facts_tx(
                    tx,
                    &live.space,
                    parent.folder(),
                    class.unwrap_or(DocClass::UserDoc),
                    None,
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;
                if class.is_some() {
                    if active_note_sibling_exists_tx(
                        tx,
                        &scope.space_id,
                        parent.folder(),
                        &fold,
                        None,
                    )
                    .await?
                    {
                        return Err(path_conflict(&scope, parent.folder(), &slug));
                    }
                    Ok(None)
                } else {
                    folder_at_tx(tx, &scope, parent.folder(), &fold).await
                }
            })
        })
        .await
    }

    /// Upper bound on a physical writer group.
    pub fn import_write_group_limit(&self) -> usize {
        IMPORT_BATCH_LIMIT.min(self.inner.config.writer.max_batch_items)
    }

    /// Each item and its increasing plan ordinal commit in the same writer
    /// savepoint. A conflicting item prevents every later ordinal from applying.
    pub async fn apply_import_notes(
        &self,
        ctx: SpaceContext,
        claim: &ClaimedContentJob,
        plan: ContentDigest,
        notes: Vec<PlannedImportNote>,
        authority: ArchiveCommitAuthority,
    ) -> Result<Vec<Result<(), PortError>>, PortError> {
        if notes.len() > self.import_write_group_limit()
            || notes
                .iter()
                .map(|note| note.note.carrier.len())
                .try_fold(0_usize, usize::checked_add)
                .is_none_or(|bytes| bytes > IMPORT_BATCH_BYTES)
        {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let deadline = CommandDeadline::start(&ctx.budget, "apply_import_notes");
        let space = self
            .read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
            .await?;
        space.scope.check(ctx.scope())?;
        ctx.auth().authorize_space_write(&space.space)?;
        let fence = Arc::new(ImportFence::new(ctx.scope(), claim, plan));
        let mut intents = Vec::with_capacity(notes.len());
        for PlannedImportNote {
            ordinal,
            parent,
            note,
        } in notes
        {
            deadline.remaining(&ctx.budget)?;
            if note.class == DocClass::Skill || note.parent.as_ref() != Some(parent.folder()) {
                return Err(invalid(ValidationReason::InvalidAuthority));
            }
            let slug_fold = normalize_slug_key(&note.slug)?;
            let info = tokio::task::spawn_blocking({
                let carrier = note.carrier.clone();
                let slug = note.slug.clone();
                let id = note.note.clone();
                let class = note.class;
                let codec = self.blob_codec();
                move || analyze_and_prepare_carrier(&carrier, class, &id, &slug, codec)
            })
            .await
            .map_err(|err| internal_not_committed("prepare_import_note", err.to_string()))??;
            let ticket = deadline
                .prepare(&ctx.budget, || {
                    self.stage_blob_for_batch(&space.scope, space.active_epoch, &info.prepared_blob)
                })
                .await?;
            let mut intent = build_create_note_intent(
                &space.scope,
                space.active_epoch,
                None,
                ctx.auth().clone(),
                note,
                slug_fold,
                info,
                ticket,
            );
            let execute = intent.execute;
            let fence = fence.clone();
            let authority = authority.clone();
            intent.execute = Box::new(move |tx, item| {
                Box::pin(async move {
                    authority.check()?;
                    item.retain_until_batch_commit(authority);
                    validate_import_parent_tx(tx, &fence.scope, &item.root_folder_id, &parent)
                        .await?;
                    fence.check_and_apply(tx, ordinal).await?;
                    execute(tx, item).await
                })
            });
            intents.push(intent);
        }
        let mut budget = ctx.budget.clone();
        budget.remaining = deadline.remaining(&ctx.budget)?;
        let (outcomes, _) = self
            .submit_write_batch::<StoredCommittedNoteRevV1>(&budget, &space.scope.space_id, intents)
            .await?;
        Ok(outcomes
            .into_iter()
            .map(|outcome| outcome.map(drop))
            .collect())
    }
}

pub(super) async fn has_pinned_plan_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    job: &JobId,
) -> Result<bool, PortError> {
    const SQL: &str = "SELECT EXISTS(SELECT 1 FROM content_jobs WHERE space_id=$1
         AND job_id=$2 AND substr(result_msgpack,1,5)=$3)";
    macro_rules! has_plan {
        ($conn:expr) => {
            sqlx::query_scalar(SQL)
                .bind(scope.space_id.as_str())
                .bind(job.as_str())
                .bind(PLAN_TAG)
                .fetch_one(&mut **$conn)
                .await
        };
    }
    match tx {
        BackendConn::Sqlite(conn) => has_plan!(conn),
        BackendConn::Postgres(conn) => has_plan!(conn),
    }
    .map_err(|err| internal_not_committed("check_import_plan", err.to_string()))
}

async fn check_import_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    job_id: &JobId,
    owner: &str,
    epoch: LeaseEpoch,
) -> Result<ImportProgress, PortError> {
    let (job, _, erased) = require_active_job_lease_tx(tx, scope, job_id, owner, epoch).await?;
    if erased || !matches!(job.kind, ContentJobKind::Import { .. }) {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    let sql = "SELECT result_msgpack FROM content_jobs WHERE space_id=$1 AND job_id=$2";
    let encoded: Option<Vec<u8>> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(sql)
                .bind(scope.space_id.as_str())
                .bind(job_id.as_str())
                .fetch_one(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(sql)
                .bind(scope.space_id.as_str())
                .bind(job_id.as_str())
                .fetch_one(&mut **conn)
                .await
        }
    }
    .map_err(|err| internal_not_committed("read_import_progress", err.to_string()))?;
    let plan = encoded
        .map(|encoded| {
            let bytes = encoded
                .strip_prefix(PLAN_TAG)
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let (digest, bytes) = bytes
                .split_at_checked(32)
                .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?;
            let plan: PinnedImportPlan = decode_msgpack_bounded(bytes, MAX_MSGPACK_DECODE_BYTES)?;
            if digest != plan.object.digest.as_bytes() {
                return Err(invalid(ValidationReason::InvalidDigest));
            }
            Ok(plan)
        })
        .transpose()?;
    Ok(ImportProgress {
        plan,
        applied: job.completed_units,
    })
}

pub(crate) async fn validate_import_parent_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    root: &FolderId,
    parent: &ImportParent,
) -> Result<(), PortError> {
    if &parent.root != root || parent.ancestors.len() > 64 {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    let mut current = root;
    for (slug, expected) in &parent.ancestors {
        let slug_fold = normalize_slug_key(slug)?;
        if folder_at_tx(tx, scope, current, &slug_fold).await?.as_ref() != Some(expected) {
            return Err(path_conflict(scope, current, slug));
        }
        current = expected;
    }
    Ok(())
}

pub(crate) async fn folder_at_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    parent: &FolderId,
    slug_fold: &str,
) -> Result<Option<FolderId>, PortError> {
    let sql = "SELECT folder_id FROM folder_heads
        WHERE space_id=$1 AND parent_folder_id=$2 AND slug_fold=$3 AND lifecycle_state='active'";
    let result: Option<String> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(sql)
                .bind(scope.space_id.as_str())
                .bind(parent.as_str())
                .bind(slug_fold)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(sql)
                .bind(scope.space_id.as_str())
                .bind(parent.as_str())
                .bind(slug_fold)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|err| crate::runtime::pg_read_error("read_import_folder_path", err))?;
    Ok(result.as_deref().map(FolderId::parse).transpose()?)
}

fn path_conflict(scope: &HistoryScope, parent: &FolderId, slug: &str) -> PortError {
    DomainError::PathConflict {
        target: PathTarget {
            space_id: scope.space_id.clone(),
            parent: Some(parent.clone()),
            component: slug.to_owned(),
        },
    }
    .into()
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

pub(super) async fn persist_import_source_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    job: &JobId,
    artifact: &ArtifactId,
    payload: Vec<u8>,
) -> Result<(), PortError> {
    const INSERT: &str = "INSERT INTO archive_import_sources(space_id,job_id,artifact_id,object_msgpack) VALUES($1,$2,$3,$4)";
    macro_rules! insert {
        ($conn:expr) => {
            sqlx::query(INSERT)
                .bind(scope.space_id.as_str())
                .bind(job.as_str())
                .bind(artifact.as_str())
                .bind(payload)
                .execute(&mut **$conn)
                .await
                .map(|_| ())
        };
    }
    match tx {
        BackendConn::Sqlite(conn) => insert!(conn),
        BackendConn::Postgres(conn) => insert!(conn),
    }
    .map_err(|err| internal_not_committed("archive_import_source_write", err.to_string()))
}

async fn import_source_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    job: &JobId,
) -> Result<ArchiveObject, PortError> {
    const SELECT: &str =
        "SELECT object_msgpack FROM archive_import_sources WHERE space_id=$1 AND job_id=$2";
    macro_rules! read {
        ($conn:expr) => {
            sqlx::query_scalar(SELECT)
                .bind(scope.space_id.as_str())
                .bind(job.as_str())
                .fetch_optional(&mut **$conn)
                .await
        };
    }
    let payload: Vec<u8> = match tx {
        BackendConn::Sqlite(conn) => read!(conn),
        BackendConn::Postgres(conn) => read!(conn),
    }
    .map_err(|err| internal_not_committed("archive_import_source_read", err.to_string()))?
    .ok_or(DomainError::ResourceNotFound)?;
    decode_msgpack_bounded(&payload, MAX_MSGPACK_DECODE_BYTES)
}
