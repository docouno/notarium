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

use crate::{ArchiveJobs, artifacts::DownloadSource, request_deadline::RequestDeadline};

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
    pointer: CommittedExport,
    file: Mutex<DownloadSource>,
}

impl ArchiveJobs {
    pub async fn open_export(
        self: &Arc<Self>,
        ctx: SpaceContext,
        artifact: &ArtifactId,
    ) -> Result<ArchiveDownload, PortError> {
        let request = RequestDeadline::new(ctx.budget.clone())?;
        let caller =
            JobDelegation::capture(ctx.auth(), ctx.scope()).ok_or(DomainError::AccessDenied)?;
        let mut live = request
            .wait(
                self.control
                    .refresh_archive_job(request.remaining()?, &caller),
            )
            .await?;
        live.budget = request.remaining()?;
        let pointer = request
            .wait(
                self.store
                    .open_committed_export(live, artifact, async |origin| {
                        self.control
                            .refresh_archive_job(request.remaining()?, origin)
                            .await
                    }),
            )
            .await?;
        let file = request
            .wait(
                self.artifacts
                    .open_download(pointer.object(), &request.budget.cancellation),
            )
            .await?;
        request.check()?;
        Ok(ArchiveDownload {
            jobs: self.clone(),
            pointer,
            file: Mutex::new(file),
        })
    }
}

impl ArchiveDownload {
    pub fn metadata(&self) -> ArchiveDownloadMetadata {
        ArchiveDownloadMetadata {
            id: self.pointer.object().id.clone(),
            etag: self.pointer.object().digest,
            bytes: self.pointer.object().bytes,
            expires_at_ms: self.pointer.expires_at_ms(),
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
        let request = RequestDeadline::new(budget)?;
        let readers = request
            .wait(self.jobs.control.register_archive_readers(
                request.remaining()?,
                self.pointer.caller(),
                self.pointer.origin(),
            ))
            .await?;
        let permit = request
            .wait(
                self.jobs
                    .store
                    .authorize_export_chunk(&self.pointer, readers),
            )
            .await?;
        let bytes = request
            .wait(async {
                let mut file = self.file.lock().await;
                self.jobs
                    .artifacts
                    .download_chunk(
                        self.pointer.object(),
                        &mut file,
                        offset,
                        bytes,
                        &request.budget.cancellation,
                    )
                    .await
            })
            .await?;
        let budget = request.remaining()?;
        self.jobs
            .store
            .handoff_export_chunk(&budget, permit, move || {
                request.check()?;
                output(bytes)
            })
            .await?;
        Ok(())
    }
}
