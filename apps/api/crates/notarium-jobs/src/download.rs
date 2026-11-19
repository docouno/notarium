use std::sync::Arc;

use bytes::Bytes;
use notarium_canonical::peers::archive_export::CommittedExport;
use notarium_core::{
    DomainError,
    auth::JobDelegation,
    error::{PortError, ValidationReason},
    ids::{ArtifactId, ContentDigest},
    ports::{CallBudget, SpaceContext},
};
use tokio::sync::{Mutex, mpsc};

use crate::{ArchiveJobs, artifacts::DownloadSource, import::check_cancelled};

const MAX_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug)]
pub struct ArchiveDownloadMetadata {
    pub id: ArtifactId,
    pub etag: ContentDigest,
    pub bytes: u64,
    pub expires_at_ms: i64,
}

/// Each read returns a bounded range after checking current authorization, the
/// committed pointer and privacy generation. The underlying file stays private.
pub struct ArchiveDownload {
    jobs: Arc<ArchiveJobs>,
    caller: JobDelegation,
    origin: JobDelegation,
    pointer: CommittedExport,
    file: Mutex<DownloadSource>,
}

impl ArchiveJobs {
    pub async fn open_export(
        self: &Arc<Self>,
        ctx: SpaceContext,
        artifact: &ArtifactId,
    ) -> Result<ArchiveDownload, PortError> {
        let caller =
            JobDelegation::capture(ctx.auth(), ctx.scope()).ok_or(DomainError::AccessDenied)?;
        let live = self
            .control
            .refresh_archive_job(ctx.budget.clone(), &caller)
            .await?;
        let pointer = self.store.open_committed_export(live, artifact).await?;
        let origin = self
            .store
            .archive_job_delegation(&ctx.budget, ctx.scope(), &pointer.job)
            .await?
            .ok_or(DomainError::ResourceNotFound)?;
        if origin.principal() != caller.principal() {
            return Err(DomainError::ResourceNotFound.into());
        }
        if origin != caller {
            let live_origin = self
                .control
                .refresh_archive_job(ctx.budget.clone(), &origin)
                .await?;
            self.store
                .open_committed_export(live_origin, artifact)
                .await?;
        }
        let file = self
            .artifacts
            .open_download(&pointer.object, &ctx.budget.cancellation)
            .await?;
        Ok(ArchiveDownload {
            jobs: self.clone(),
            caller,
            origin,
            pointer,
            file: Mutex::new(file),
        })
    }
}

impl ArchiveDownload {
    pub fn metadata(&self) -> ArchiveDownloadMetadata {
        ArchiveDownloadMetadata {
            id: self.pointer.object.id.clone(),
            etag: self.pointer.object.digest,
            bytes: self.pointer.object.bytes,
            expires_at_ms: self.pointer.expires_at_ms,
        }
    }

    /// Reads at most 256 KiB and may stop on a storage segment boundary.
    /// Callers begin the next chunk at the offset returned by their byte count.
    pub async fn read_chunk(
        &self,
        budget: CallBudget,
        offset: u64,
        bytes: usize,
    ) -> Result<Bytes, PortError> {
        let (output, mut ready) = tokio::sync::oneshot::channel();
        self.deliver_chunk(budget, offset, bytes, move |bytes| {
            output
                .send(bytes)
                .map_err(|_| DomainError::ResourceNotFound.into())
        })
        .await?;
        ready
            .try_recv()
            .map_err(|_| DomainError::ResourceNotFound.into())
    }

    /// Hand a chunk directly to a bounded transport queue. Reserve the slot
    /// before calling this method so a slow consumer holds no admission fence.
    pub async fn read_chunk_into(
        &self,
        budget: CallBudget,
        offset: u64,
        bytes: usize,
        output: mpsc::OwnedPermit<Bytes>,
    ) -> Result<(), PortError> {
        self.deliver_chunk(budget, offset, bytes, move |bytes| {
            output.send(bytes);
            Ok(())
        })
        .await
    }

    async fn deliver_chunk(
        &self,
        budget: CallBudget,
        offset: u64,
        bytes: usize,
        output: impl FnOnce(Bytes) -> Result<(), PortError> + Send + 'static,
    ) -> Result<(), PortError> {
        if bytes == 0 || bytes > MAX_CHUNK_BYTES {
            return Err(DomainError::validation(ValidationReason::InvalidRange).into());
        }
        let (ctx, registration) = self
            .jobs
            .control
            .register_archive_job(budget.clone(), &self.caller)
            .await?;
        let id = &self.pointer.object.id;
        let source_registration = if self.origin != self.caller {
            let (source, registration) = self
                .jobs
                .control
                .register_archive_job(budget.clone(), &self.origin)
                .await?;
            self.jobs.store.open_committed_export(source, id).await?;
            Some(registration)
        } else {
            None
        };
        let current = self
            .jobs
            .store
            .open_committed_export(ctx.clone(), id)
            .await?;
        if current.object != self.pointer.object || current.job != self.pointer.job {
            return Err(DomainError::ResourceNotFound.into());
        }
        let bytes = {
            let mut file = self.file.lock().await;
            self.jobs
                .artifacts
                .download_chunk(
                    &current.object,
                    &mut file,
                    offset,
                    bytes,
                    &budget.cancellation,
                )
                .await?
        };
        check_cancelled(&budget.cancellation)?;
        self.jobs
            .store
            .handoff_export_chunk(&budget, ctx.scope(), &current, move || {
                registration.check()?;
                if let Some(source_registration) = source_registration {
                    source_registration.check()?;
                }
                output(bytes)
            })
            .await?;
        Ok(())
    }
}
