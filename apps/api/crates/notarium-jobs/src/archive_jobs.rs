use std::{path::PathBuf, sync::Arc, time::Duration};

use notarium_canonical::{
    CanonicalStore, JobCompletionOutcome, codec,
    peers::archive_import::{ArchiveObject, ArchiveObjectKind, PinnedImportPlan},
};
use notarium_control::service::ControlService;
use notarium_core::{
    DomainError,
    auth::JobDelegation,
    error::{PortError, ValidationReason},
    ids::{ArtifactId, FolderId},
    ports::{
        Cancellation, Committed, ContentJob, ContentJobKind, ContentJobPort, Mutation, PageLimit,
        PortFuture, SpaceContext,
    },
};
use tokio::io::{AsyncRead, AsyncWriteExt};

use crate::{
    ArchiveOperation, ArchiveRunner, ArchiveStorage, ImportLimits, JobExecution, JobWorkerConfig,
    artifacts::ScratchDirectory,
    import::{ImportBatch, bind_paths, prepare_import, read_batch, validate_plan},
    worker::command_budget,
};

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);

/// Library entry points for archive admission and execution. Transport owns
/// authentication, request deadlines and upload/download protocol.
pub struct ArchiveJobs {
    pub(crate) store: CanonicalStore,
    pub(crate) control: Arc<ControlService>,
    pub(crate) artifacts: ArchiveStorage,
    import_limits: ImportLimits,
}

impl ArchiveJobs {
    pub fn new(
        store: CanonicalStore,
        control: Arc<ControlService>,
        artifacts: ArchiveStorage,
        import_limits: ImportLimits,
    ) -> Result<Self, PortError> {
        import_limits.check()?;
        if store.installation_id() != &artifacts.installation
            || !store.accepts_archive_namespace(artifacts.cloud_namespace())
        {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        Ok(Self {
            store,
            control,
            artifacts,
            import_limits,
        })
    }

    pub fn runner(self: &Arc<Self>, config: JobWorkerConfig) -> Result<ArchiveRunner, PortError> {
        ArchiveRunner::new(
            self.store.clone(),
            self.control.clone(),
            self.clone(),
            config,
        )
    }

    pub async fn sweep_maintenance(&self, shutdown: &Cancellation) -> Result<(), PortError> {
        let artifacts = self.artifacts.clone();
        let cancel = shutdown.clone();
        tokio::task::spawn_blocking(move || artifacts.reap_scratch(&cancel))
            .await
            .map_err(|err| {
                codec::internal_not_committed("reap_archive_scratch", err.to_string())
            })??;
        let mut hold = String::new();
        while let Some(after) = self
            .store
            .reap_archive_export_holds(&command_budget(shutdown)?, hold)
            .await?
        {
            hold = after;
        }
        let expired = self
            .store
            .expired_export_objects(&command_budget(shutdown)?)
            .await?;
        let mut cleanup_error = None;
        for object in expired {
            let cleanup = async {
                self.artifacts.retire_export(&object, shutdown).await?;
                self.store
                    .forget_expired_export(&command_budget(shutdown)?, &object)
                    .await
            };
            if let Err(err) = cleanup.await {
                cleanup_error = Some(err);
            }
        }
        for upload in self
            .store
            .take_abandoned_archive_uploads(&command_budget(shutdown)?, self.artifacts.namespace)
            .await?
        {
            let cleanup = async {
                self.artifacts.retire_abandoned(&upload, shutdown).await?;
                self.store
                    .finish_archive_upload_cleanup(&command_budget(shutdown)?, upload)
                    .await
            };
            if let Err(err) = cleanup.await {
                cleanup_error = Some(err);
            }
        }
        let mut after = None;
        loop {
            let scopes = self
                .store
                .archive_job_scopes(
                    &command_budget(shutdown)?,
                    after.as_ref(),
                    PageLimit::new(64)?,
                )
                .await?;
            if scopes.is_empty() {
                return cleanup_error.map_or(Ok(()), Err);
            }
            for scope in scopes {
                after = Some(scope.space_id.clone());
                let sweep = async {
                    let space = self.store.read_space(&scope.space_id).await?;
                    let mut next = None;
                    loop {
                        let page = self
                            .store
                            .sweep_blob_gc(
                                &command_budget(shutdown)?,
                                &scope,
                                space.active_epoch,
                                next,
                            )
                            .await?;
                        next = page.next;
                        if next.is_none() {
                            return Ok::<(), PortError>(());
                        }
                    }
                };
                if let Err(err) = sweep.await {
                    cleanup_error = Some(err);
                }
            }
        }
    }

    /// Seal an upload before it can be named by a runnable import. The returned
    /// identifier is opaque and can only be enqueued by the admitted principal.
    pub async fn stage_import(
        &self,
        ctx: SpaceContext,
        input: impl AsyncRead + Unpin,
    ) -> Result<ArtifactId, PortError> {
        let ctx = self.fresh_writer(&ctx).await?;
        let artifact = tokio::time::timeout(
            ctx.budget.remaining,
            self.artifacts.stage_source(
                ctx.scope(),
                input,
                self.import_limits.compressed_bytes,
                &ctx.budget.cancellation,
                |id, bytes| {
                    self.store.reserve_archive_source_upload(
                        &ctx,
                        id,
                        bytes,
                        self.artifacts.namespace,
                    )
                },
            ),
        )
        .await
        .map_err(|_| {
            codec::deadline_not_committed("stage_archive_source", "upload deadline exceeded")
        })??;
        let ctx = self.fresh_writer(&ctx).await?;
        let id = artifact.id.clone();
        self.store
            .finish_archive_source_upload(&ctx, artifact)
            .await?;
        Ok(id)
    }

    pub async fn enqueue(
        &self,
        ctx: SpaceContext,
        request: Mutation<ContentJobKind>,
    ) -> Result<Committed<ContentJob>, PortError> {
        let verified = self.fresh_writer(&ctx).await?;
        match &request.input {
            ContentJobKind::Import { .. } => {
                self.store
                    .create_archive_import_job(verified, request)
                    .await
            }
            ContentJobKind::Export { .. } | ContentJobKind::ExportSpace { .. } => {
                self.store.create_job(verified, request).await
            }
            _ => Err(invalid(ValidationReason::InvalidAuthority)),
        }
    }

    async fn fresh_writer(&self, ctx: &SpaceContext) -> Result<SpaceContext, PortError> {
        let delegation = JobDelegation::capture(ctx.auth(), ctx.scope())
            .ok_or_else(|| invalid(ValidationReason::InvalidAuthority))?;
        let verified = self
            .control
            .refresh_archive_job(ctx.budget.clone(), &delegation)
            .await?;
        let space = self.store.read_space(&verified.scope().space_id).await?;
        space.scope.check(verified.scope())?;
        verified.auth().authorize_space_write(&space.space)?;
        Ok(verified)
    }

    pub(crate) async fn seal_attempt(
        &self,
        job: &JobExecution,
        scratch: &ScratchDirectory,
        name: &'static str,
        kind: ArchiveObjectKind,
        limit: u64,
    ) -> Result<ArchiveObject, PortError> {
        let layout = self.artifacts.measure_upload(scratch, name, limit)?;
        let ctx = job.authorize().await?;
        self.store
            .reserve_archive_upload(
                &ctx,
                job.claim(),
                layout.id.clone(),
                kind.clone(),
                layout.bytes,
                self.artifacts.namespace,
            )
            .await?;
        self.artifacts
            .seal(scratch, name, job.scope(), kind, layout, job.cancellation())
            .await
    }

    async fn import(
        &self,
        job: &JobExecution,
        source_id: &ArtifactId,
    ) -> Result<JobCompletionOutcome, PortError> {
        let ctx = job.authorize().await?;
        let root = self
            .store
            .read_space(&ctx.scope().space_id)
            .await?
            .root_folder_id;
        let scratch = self.artifacts.scratch()?;
        let source = self.store.pinned_import_source(&ctx, job.claim()).await?;
        let archive = self
            .artifacts
            .materialize(&source, &scratch, "source.zip", job.cancellation())
            .await?;
        let mut progress = self.store.import_progress(&ctx, job.claim()).await?;
        let plan_path;
        if let Some(pinned) = &progress.plan {
            if pinned.source != *source_id || pinned.source_digest != source.digest {
                return Err(invalid(ValidationReason::InvalidDigest));
            }
            drop(archive);
            plan_path = self.read_pinned_plan(job, &scratch, pinned).await?;
        } else {
            let path = scratch.file("plan.sqlite");
            let archive = archive.into_std().await;
            job.blocking({
                let path = path.clone();
                let scope = job.scope().clone();
                let id = job.claim().job.id.clone();
                let limits = self.import_limits;
                let digest = source.digest;
                move |cancellation| {
                    prepare_import(archive, &path, &scope, &id, digest, limits, cancellation)
                }
            })
            .await?;
            let entries = bind_paths(&self.store, job, path.clone(), root.clone()).await?;
            let object = self
                .seal_attempt(
                    job,
                    &scratch,
                    "plan.sqlite",
                    ArchiveObjectKind::ImportPlan,
                    ArchiveStorage::plan_limit(),
                )
                .await?;
            let id = object.id.clone();
            let ctx = job.authorize().await?;
            progress = self
                .store
                .install_import_plan(
                    &ctx,
                    job.claim(),
                    PinnedImportPlan {
                        source: source.id,
                        source_digest: source.digest,
                        object,
                        entries,
                    },
                    job.commit_authority(),
                )
                .await?;
            let pinned = progress
                .plan
                .as_ref()
                .ok_or_else(|| invalid(ValidationReason::NotReady))?;
            if pinned.object.id == id {
                plan_path = path;
            } else {
                plan_path = self.read_pinned_plan(job, &scratch, pinned).await?;
            }
        }
        let plan = progress
            .plan
            .ok_or_else(|| invalid(ValidationReason::NotReady))?;
        job.blocking({
            let plan_path = plan_path.clone();
            let scope = job.scope().clone();
            let id = job.claim().job.id.clone();
            let digest = plan.source_digest;
            let count = plan.entries;
            move |_| validate_plan(&plan_path, &scope, &id, digest, count)
        })
        .await?;
        self.apply_plan(job, root, plan_path, progress.applied, &plan)
            .await?;
        Ok(JobCompletionOutcome::Succeeded {
            completed_units: plan.entries,
            total_units: Some(plan.entries),
            artifacts: Vec::new(),
            result_msgpack: Some(codec::encode_msgpack(&plan)?),
        })
    }

    async fn read_pinned_plan(
        &self,
        job: &JobExecution,
        scratch: &crate::artifacts::ScratchDirectory,
        plan: &PinnedImportPlan,
    ) -> Result<PathBuf, PortError> {
        let mut input = self
            .artifacts
            .materialize(&plan.object, scratch, "pinned.sqlite", job.cancellation())
            .await?;
        if !self.artifacts.is_cloud() {
            let mut output = tokio::fs::File::from_std(scratch.open_new("pinned.sqlite")?);
            tokio::io::copy(&mut input, &mut output)
                .await
                .map_err(plan_io)?;
            output.flush().await.map_err(plan_io)?;
        }
        Ok(scratch.file("pinned.sqlite"))
    }

    async fn apply_plan(
        &self,
        job: &JobExecution,
        root: FolderId,
        path: PathBuf,
        mut applied: u64,
        plan: &PinnedImportPlan,
    ) -> Result<(), PortError> {
        while applied < plan.entries {
            let batch = job
                .blocking({
                    let path = path.clone();
                    let root = root.clone();
                    move |_| read_batch(&path, &root, applied + 1)
                })
                .await?
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let ctx = job.authorize().await?;
            match batch {
                ImportBatch::Folder(folder) => {
                    self.store
                        .apply_import_folder(
                            &ctx,
                            job.claim(),
                            plan.object.digest,
                            folder,
                            job.commit_authority(),
                        )
                        .await?;
                    applied += 1;
                    job.report_progress(applied, Some(plan.entries));
                }
                ImportBatch::Notes(notes) => {
                    let outcomes = self
                        .store
                        .apply_import_notes(
                            ctx,
                            job.claim(),
                            plan.object.digest,
                            notes,
                            job.commit_authority(),
                        )
                        .await?;
                    for outcome in outcomes {
                        outcome?;
                        applied += 1;
                        job.report_progress(applied, Some(plan.entries));
                    }
                }
            }
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}

impl ArchiveOperation for ArchiveJobs {
    fn execute<'a>(&'a self, job: &'a JobExecution) -> PortFuture<'a, JobCompletionOutcome> {
        Box::pin(async move {
            match &job.claim().job.kind {
                ContentJobKind::Import { artifact } => self.import(job, artifact).await,
                ContentJobKind::Export { .. } | ContentJobKind::ExportSpace { .. } => {
                    self.export(job).await
                }
                _ => Err(invalid(ValidationReason::NotReady)),
            }
        })
    }

    fn maintain<'a>(&'a self, shutdown: &'a Cancellation) -> PortFuture<'a, ()> {
        Box::pin(async move {
            while !shutdown.is_cancelled() {
                let _ = self.sweep_maintenance(shutdown).await;
                tokio::select! {
                    () = shutdown.cancelled() => break,
                    () = tokio::time::sleep(MAINTENANCE_INTERVAL) => {}
                }
            }
            Ok(())
        })
    }
}

fn plan_io(error: std::io::Error) -> PortError {
    codec::internal_not_committed("archive_plan_copy", error.kind().to_string())
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}
