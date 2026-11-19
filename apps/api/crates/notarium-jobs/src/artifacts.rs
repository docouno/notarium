use std::{fs, io::ErrorKind, path::PathBuf, sync::Arc, time::Duration};

use bytes::Bytes;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(unix)]
use cap_std::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, OpenOptions},
};
use http::Method;
use notarium_canonical::{
    blobs::s3::{S3BlobStore, S3RawRequest, S3RawResponse, namespace_fingerprint},
    codec,
    config::{S3BucketMode, S3Config},
    peers::{
        archive_import::{ArchiveObject, ArchiveObjectKind, ArchiveSegment},
        archive_uploads::AbandonedArchiveUpload,
    },
};
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::{ArtifactId, ContentDigest, InstallationId},
    model::HistoryScope,
    ports::Cancellation,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::import::check_cancelled;

const SEGMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEGMENTS: usize = 16_384;
const MAX_OBJECT_BYTES: u64 = (MAX_SEGMENTS * SEGMENT_BYTES) as u64;
const RETIRED_SEGMENT: &[u8] = b"notarium-archive-segment-retired-v1\n";
const SCRATCH_GRACE: Duration = Duration::from_secs(3600);
const SCRATCH_LOCK: &str = ".owner";

/// Private operational artifacts bound to an installation. Cloud staging and
/// results live in a separately configured S3 namespace, with local work files
/// used only as a disposable seekable cache.
#[derive(Clone)]
pub struct ArchiveStorage {
    pub(crate) installation: InstallationId,
    pub(crate) namespace: ContentDigest,
    local: Arc<LocalArchiveStorage>,
    remote: Option<Arc<S3BlobStore>>,
}

struct LocalArchiveStorage {
    work: Dir,
    work_path: PathBuf,
    objects: Dir,
}

pub(crate) struct ScratchDirectory {
    dir: Dir,
    path: PathBuf,
    _lock: fs::File,
}

pub(crate) struct DownloadSource {
    local: Option<tokio::fs::File>,
    segment: Option<(usize, Bytes)>,
}

pub(crate) struct UploadLayout {
    pub(crate) id: ArtifactId,
    pub(crate) bytes: u64,
}

impl ScratchDirectory {
    pub(crate) fn file(&self, name: &'static str) -> PathBuf {
        self.path.join(name)
    }

    pub(crate) fn open_new(&self, name: &'static str) -> Result<fs::File, PortError> {
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        options.mode(0o600);
        self.dir
            .open_with(name, &options)
            .map(|file| file.into_std())
            .map_err(storage_io)
    }

    pub(crate) fn open(&self, name: &'static str) -> Result<fs::File, PortError> {
        open_file(&self.dir, name)
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        if let Ok(dir) = self.dir.try_clone() {
            let _ = dir.remove_open_dir_all();
        }
    }
}

impl ArchiveStorage {
    pub fn local(root: &DataRoot, installation: InstallationId) -> Result<Self, PortError> {
        Ok(Self {
            namespace: digest(b"notarium-local-archive-storage-v1"),
            installation,
            local: Arc::new(open_local(root)?),
            remote: None,
        })
    }

    pub async fn cloud(
        root: &DataRoot,
        installation: InstallationId,
        config: S3Config,
    ) -> Result<Self, PortError> {
        let namespace = namespace_fingerprint(&config)?;
        let remote = S3BlobStore::open(config, None).await?;
        if remote.application_prefix().is_empty() {
            return Err(invalid(ValidationReason::InvalidPathComponent));
        }
        Ok(Self {
            namespace,
            installation,
            local: Arc::new(open_local(root)?),
            remote: Some(Arc::new(remote)),
        })
    }

    pub(crate) fn is_cloud(&self) -> bool {
        self.remote.is_some()
    }

    pub(crate) fn cloud_namespace(&self) -> Option<&S3BlobStore> {
        self.remote.as_deref()
    }

    pub(crate) fn plan_limit() -> u64 {
        12 * 1024 * 1024 * 1024
    }

    pub(crate) fn scratch(&self) -> Result<ScratchDirectory, PortError> {
        let name = codec::new_prefixed_hex_id("attempt_")?;
        self.local
            .work
            .create_dir_with(&name, &archive_dir_builder())
            .map_err(storage_io)?;
        let dir = self
            .local
            .work
            .open_dir_nofollow(&name)
            .map_err(storage_io)?;
        let lock = scratch_lock(&dir, true).map_err(storage_io)?;
        lock.try_lock()
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
        Ok(ScratchDirectory {
            dir,
            path: self.local.work_path.join(name),
            _lock: lock,
        })
    }

    pub(crate) fn reap_scratch(&self, cancellation: &Cancellation) -> Result<(), PortError> {
        let mut removed = 0;
        for entry in self.local.work.entries().map_err(storage_io)? {
            check_cancelled(cancellation)?;
            let entry = entry.map_err(storage_io)?;
            let name = entry.file_name();
            if !name
                .to_str()
                .and_then(|name| name.strip_prefix("attempt_"))
                .is_some_and(|suffix| {
                    suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            {
                continue;
            }
            let Ok(dir) = self.local.work.open_dir_nofollow(&name) else {
                continue;
            };
            let age = dir
                .dir_metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.into_std().elapsed().ok());
            if !age.is_some_and(|age| age >= SCRATCH_GRACE) {
                continue;
            }
            // Only an abandoned owner can be claimed. An absent lock can
            // arise before the creator has admitted the first payload file.
            match scratch_lock(&dir, false) {
                Ok(lock) if lock.try_lock().is_ok() => match dir.remove_open_dir_all() {
                    Ok(()) => removed += 1,
                    Err(err) if err.kind() == ErrorKind::NotFound => {}
                    Err(err) => return Err(storage_io(err)),
                },
                Err(err) if err.kind() == ErrorKind::NotFound => {
                    let _ = self.local.work.remove_dir(&name);
                }
                _ => {}
            }
            if removed >= 16 {
                break;
            }
        }
        Ok(())
    }

    pub(crate) async fn stage_source<F: std::future::Future<Output = Result<(), PortError>>>(
        &self,
        scope: &HistoryScope,
        mut input: impl AsyncRead + Unpin,
        max_bytes: u64,
        cancellation: &Cancellation,
        reserve: impl FnOnce(ArtifactId, u64) -> F,
    ) -> Result<ArchiveObject, PortError> {
        let scratch = self.scratch()?;
        let mut file = tokio::fs::File::from_std(scratch.open_new("source.zip")?);
        let mut size = 0_u64;
        let mut bytes = vec![0; 128 * 1024];
        loop {
            let read = tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    return Err(codec::cancelled_not_committed("archive_upload_cancelled", "archive upload cancelled"));
                }
                result = input.read(&mut bytes) => result.map_err(storage_io)?,
            };
            if read == 0 {
                break;
            }
            size += read as u64;
            if size > max_bytes {
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
            file.write_all(&bytes[..read]).await.map_err(storage_io)?;
        }
        file.sync_all().await.map_err(storage_io)?;
        drop(file);
        let layout = self.measure_upload(&scratch, "source.zip", max_bytes)?;
        reserve(layout.id.clone(), layout.bytes).await?;
        self.seal(
            &scratch,
            "source.zip",
            scope,
            ArchiveObjectKind::Source,
            layout,
            cancellation,
        )
        .await
    }

    pub(crate) async fn seal(
        &self,
        scratch: &ScratchDirectory,
        name: &'static str,
        scope: &HistoryScope,
        kind: ArchiveObjectKind,
        layout: UploadLayout,
        cancellation: &Cancellation,
    ) -> Result<ArchiveObject, PortError> {
        check_cancelled(cancellation)?;
        let mut file = tokio::fs::File::from_std(scratch.open(name)?);
        let bytes = file.metadata().await.map_err(storage_io)?.len();
        if bytes != layout.bytes {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        file.sync_all().await.map_err(storage_io)?;
        let mut object = ArchiveObject {
            installation: self.installation.clone(),
            namespace: self.namespace,
            scope: scope.clone(),
            id: layout.id,
            kind,
            digest: ContentDigest::from_bytes([0; 32]),
            bytes,
            segments: Vec::new(),
        };
        let base = base_key(&object);
        let mut hasher = blake3::Hasher::new();
        let mut buffer = vec![0; SEGMENT_BYTES];
        let mut remaining = bytes;
        if let Some(remote) = &self.remote {
            remote.verify_runtime_bucket_mode().await?;
        }
        while remaining > 0 {
            check_cancelled(cancellation)?;
            let len = remaining.min(SEGMENT_BYTES as u64) as usize;
            file.read_exact(&mut buffer[..len])
                .await
                .map_err(storage_io)?;
            let data = &buffer[..len];
            hasher.update(data);
            if let Some(remote) = &self.remote {
                let key = segment_key(&base, object.segments.len());
                let data = Bytes::copy_from_slice(data);
                let digest = digest(&data);
                let version = put_segment(remote, &key, data, digest, cancellation).await?;
                object.segments.push(ArchiveSegment {
                    digest,
                    bytes: len as u32,
                    version,
                });
            }
            remaining -= len as u64;
        }
        match file.read_u8().await {
            Ok(_) => return Err(invalid(ValidationReason::InvalidDigest)),
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => {}
            Err(error) => return Err(storage_io(error)),
        }
        object.digest = ContentDigest::from_bytes(*hasher.finalize().as_bytes());
        if self.remote.is_none() {
            self.publish_local(scratch, name, &base)?;
        }
        self.check_object(&object)?;
        Ok(object)
    }

    pub(crate) fn measure_upload(
        &self,
        scratch: &ScratchDirectory,
        name: &'static str,
        limit: u64,
    ) -> Result<UploadLayout, PortError> {
        let bytes = scratch.open(name)?.metadata().map_err(storage_io)?.len();
        if bytes == 0 || bytes > limit.min(MAX_OBJECT_BYTES) {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        Ok(UploadLayout {
            id: codec::new_artifact_id()?,
            bytes,
        })
    }

    /// Open the exact immutable generation. Verify the full checksum during
    /// initial admission. Cloud workers materialize the shared object into
    /// their own scratch directory without relying on the producer's disk.
    pub(crate) async fn materialize(
        &self,
        object: &ArchiveObject,
        scratch: &ScratchDirectory,
        name: &'static str,
        cancellation: &Cancellation,
    ) -> Result<tokio::fs::File, PortError> {
        self.check_object(object)?;
        let base = base_key(object);
        let mut hasher = blake3::Hasher::new();
        let mut file;
        if let Some(remote) = &self.remote {
            remote.verify_runtime_bucket_mode().await?;
            let mut output = tokio::fs::File::from_std(scratch.open_new(name)?);
            for (index, segment) in object.segments.iter().enumerate() {
                let data = verified_segment(remote, &base, index, segment, cancellation).await?;
                hasher.update(&data);
                output.write_all(&data).await.map_err(storage_io)?;
            }
            output.flush().await.map_err(storage_io)?;
            drop(output);
            file = tokio::fs::File::from_std(scratch.open(name)?);
        } else {
            file = tokio::fs::File::from_std(open_file(&self.local.objects, &base)?);
            if file.metadata().await.map_err(storage_io)?.len() != object.bytes {
                return Err(invalid(ValidationReason::InvalidDigest));
            }
            let mut bytes = vec![0; 128 * 1024];
            loop {
                check_cancelled(cancellation)?;
                let read = file.read(&mut bytes).await.map_err(storage_io)?;
                if read == 0 {
                    break;
                }
                hasher.update(&bytes[..read]);
            }
            file.seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(storage_io)?;
        }
        if hasher.finalize().as_bytes() != object.digest.as_bytes() {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        Ok(file)
    }

    pub(crate) async fn open_download(
        &self,
        object: &ArchiveObject,
        cancellation: &Cancellation,
    ) -> Result<DownloadSource, PortError> {
        self.check_object(object)?;
        if self.remote.is_some() {
            return Ok(DownloadSource {
                local: None,
                segment: None,
            });
        }
        let mut file =
            tokio::fs::File::from_std(open_file(&self.local.objects, &base_key(object))?);
        if file.metadata().await.map_err(storage_io)?.len() != object.bytes {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        let mut digest = blake3::Hasher::new();
        let mut buffer = vec![0; 128 * 1024];
        loop {
            check_cancelled(cancellation)?;
            let count = file.read(&mut buffer).await.map_err(storage_io)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        if digest.finalize().as_bytes() != object.digest.as_bytes() {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        Ok(DownloadSource {
            local: Some(file),
            segment: None,
        })
    }

    pub(crate) async fn download_chunk(
        &self,
        object: &ArchiveObject,
        source: &mut DownloadSource,
        offset: u64,
        max: usize,
        cancellation: &Cancellation,
    ) -> Result<Bytes, PortError> {
        check_cancelled(cancellation)?;
        if offset > object.bytes || max == 0 {
            return Err(invalid(ValidationReason::InvalidRange));
        }
        let len = (object.bytes - offset).min(max as u64) as usize;
        if len == 0 {
            return Ok(Bytes::new());
        }
        if let Some(remote) = &self.remote {
            let index = (offset / SEGMENT_BYTES as u64) as usize;
            let start = (offset % SEGMENT_BYTES as u64) as usize;
            if source
                .segment
                .as_ref()
                .is_none_or(|(cached, _)| *cached != index)
            {
                source.segment = None;
                let data = verified_segment(
                    remote,
                    &base_key(object),
                    index,
                    &object.segments[index],
                    cancellation,
                )
                .await?;
                source.segment = Some((index, data));
            }
            let (_, data) = source.segment.as_ref().expect("validated segment");
            return Ok(Bytes::copy_from_slice(
                &data[start..start + len.min(data.len() - start)],
            ));
        }
        let file = source
            .local
            .as_mut()
            .ok_or_else(|| invalid(ValidationReason::InvalidAuthority))?;
        if file.metadata().await.map_err(storage_io)?.len() != object.bytes {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(storage_io)?;
        let mut bytes = vec![0; len];
        file.read_exact(&mut bytes).await.map_err(storage_io)?;
        Ok(Bytes::from(bytes))
    }

    pub(crate) async fn retire_export(
        &self,
        object: &ArchiveObject,
        cancellation: &Cancellation,
    ) -> Result<(), PortError> {
        self.check_object(object)?;
        if object.kind != ArchiveObjectKind::Export {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        check_cancelled(cancellation)?;
        let base = base_key(object);
        let Some(remote) = &self.remote else {
            return self.retire_local(&base);
        };
        remote.verify_runtime_bucket_mode().await?;
        for (index, segment) in object.segments.iter().enumerate() {
            let key = segment_key(&base, index);
            let current = get_segment(remote, &key, None, SEGMENT_BYTES, cancellation).await;
            let marker_present = match current {
                Ok(current) if current.body.as_ref() == RETIRED_SEGMENT => true,
                Ok(current)
                    if digest(&current.body) == segment.digest
                        && current.version_id() == segment.version =>
                {
                    false
                }
                Err(PortError::Domain(DomainError::ResourceNotFound)) => false,
                Ok(_) => return Err(invalid(ValidationReason::InvalidDigest)),
                Err(err) => return Err(err),
            };
            if !marker_present {
                put_retired_segment(remote, &key, cancellation).await?;
            }
            let marker =
                get_segment(remote, &key, None, RETIRED_SEGMENT.len(), cancellation).await?;
            if marker.body.as_ref() != RETIRED_SEGMENT {
                return Err(invalid(ValidationReason::InvalidDigest));
            }
            if let Some(version) = &segment.version {
                delete_segment_version(remote, &key, version.clone(), cancellation).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn retire_abandoned(
        &self,
        upload: &AbandonedArchiveUpload,
        cancellation: &Cancellation,
    ) -> Result<(), PortError> {
        if upload.namespace != self.namespace {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        check_cancelled(cancellation)?;
        let base = namespace_key(&self.installation, &upload.scope, &upload.id, &upload.kind);
        let Some(remote) = &self.remote else {
            return self.fence_local_upload(&base);
        };
        remote.verify_runtime_bucket_mode().await?;
        for index in 0..upload.bytes.div_ceil(SEGMENT_BYTES as u64) as usize {
            retire_unsealed_key(remote, &segment_key(&base, index), cancellation).await?;
        }
        Ok(())
    }

    fn fence_local_upload(&self, key: &str) -> Result<(), PortError> {
        let scratch = self.scratch()?;
        let mut file = scratch.open_new("retired")?;
        std::io::Write::write_all(&mut file, RETIRED_SEGMENT).map_err(storage_io)?;
        file.sync_all().map_err(storage_io)?;
        scratch
            .dir
            .rename("retired", &self.local.objects, key)
            .map_err(storage_io)?;
        self.local
            .objects
            .open(".")
            .and_then(|dir| dir.sync_all())
            .map_err(storage_io)
    }

    fn retire_local(&self, key: &str) -> Result<(), PortError> {
        match self.local.objects.remove_file(key) {
            Ok(()) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => return Err(storage_io(err)),
        }
        self.local
            .objects
            .open(".")
            .and_then(|dir| dir.sync_all())
            .map_err(storage_io)
    }

    fn check_object(&self, object: &ArchiveObject) -> Result<(), PortError> {
        if object.installation != self.installation
            || object.namespace != self.namespace
            || object.bytes == 0
            || object.bytes > MAX_OBJECT_BYTES
            || object.segments.len() > MAX_SEGMENTS
        {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        if let Some(remote) = &self.remote {
            if object.segments.len() as u64 != object.bytes.div_ceil(SEGMENT_BYTES as u64) {
                return Err(invalid(ValidationReason::InvalidDigest));
            }
            let versioned = remote.bucket_mode() == S3BucketMode::Enabled;
            for (index, segment) in object.segments.iter().enumerate() {
                let expected =
                    (object.bytes - index as u64 * SEGMENT_BYTES as u64).min(SEGMENT_BYTES as u64);
                if segment.bytes as u64 != expected || segment.version.is_some() != versioned {
                    return Err(invalid(ValidationReason::InvalidDigest));
                }
            }
        } else if !object.segments.is_empty() {
            return Err(invalid(ValidationReason::InvalidDigest));
        }
        Ok(())
    }

    fn publish_local(
        &self,
        scratch: &ScratchDirectory,
        name: &str,
        key: &str,
    ) -> Result<(), PortError> {
        let file = open_file(&scratch.dir, name)?;
        let mut permissions = file.metadata().map_err(storage_io)?.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o400);
        }
        #[cfg(not(unix))]
        permissions.set_readonly(true);
        file.set_permissions(permissions).map_err(storage_io)?;
        file.sync_all().map_err(storage_io)?;
        scratch
            .dir
            .hard_link(name, &self.local.objects, key)
            .map_err(storage_io)?;
        self.local
            .objects
            .open(".")
            .and_then(|dir| dir.sync_all())
            .map_err(storage_io)
    }
}

fn scratch_lock(dir: &Dir, create: bool) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(create)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.mode(0o600);
    dir.open_with(SCRATCH_LOCK, &options)
        .map(|file| file.into_std())
}

fn open_local(root: &DataRoot) -> Result<LocalArchiveStorage, PortError> {
    let root_dir = Dir::open_ambient_dir(root.root(), ambient_authority()).map_err(storage_io)?;
    let staging = child_dir(&root_dir, "staging", false)?;
    let archives = child_dir(&staging, "archives", true)?;
    let work = child_dir(&archives, "work", true)?;
    let objects = child_dir(&archives, "objects", true)?;
    Ok(LocalArchiveStorage {
        work,
        objects,
        work_path: root.root().join("staging/archives/work"),
    })
}

fn archive_dir_builder() -> DirBuilder {
    let builder = DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
}

fn child_dir(parent: &Dir, name: &str, private: bool) -> Result<Dir, PortError> {
    let builder = if private {
        archive_dir_builder()
    } else {
        DirBuilder::new()
    };
    match parent.create_dir_with(name, &builder) {
        Ok(()) => {
            parent
                .open(".")
                .and_then(|dir| dir.sync_all())
                .map_err(storage_io)?;
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(storage_io(error)),
    }
    let dir = parent.open_dir_nofollow(name).map_err(storage_io)?;
    #[cfg(unix)]
    if private && dir.dir_metadata().map_err(storage_io)?.permissions().mode() & 0o077 != 0 {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    Ok(dir)
}

fn open_file(parent: &Dir, name: &str) -> Result<fs::File, PortError> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    if !parent.symlink_metadata(name).map_err(storage_io)?.is_file() {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    let file = parent.open_with(name, &options).map_err(storage_io)?;
    let metadata = file.metadata().map_err(storage_io)?;
    if !metadata.is_file() {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    Ok(file.into_std())
}

fn namespace_key(
    installation: &InstallationId,
    scope: &HistoryScope,
    id: &ArtifactId,
    kind: &ArchiveObjectKind,
) -> String {
    let kind = match kind {
        ArchiveObjectKind::Source => "input",
        ArchiveObjectKind::ImportPlan => "plan",
        ArchiveObjectKind::Export => "export",
    };
    let history = u128::from_be_bytes(*scope.incarnation.as_bytes());
    format!(
        "{installation}.{}.{history:032x}.{kind}.{id}",
        scope.space_id
    )
}

fn base_key(object: &ArchiveObject) -> String {
    namespace_key(
        &object.installation,
        &object.scope,
        &object.id,
        &object.kind,
    )
}

fn segment_key(base: &str, index: usize) -> String {
    format!("{base}.{index:08x}")
}

async fn verified_segment(
    store: &S3BlobStore,
    base: &str,
    index: usize,
    segment: &ArchiveSegment,
    cancellation: &Cancellation,
) -> Result<Bytes, PortError> {
    let response = get_segment(
        store,
        &segment_key(base, index),
        segment.version.as_deref(),
        segment.bytes as usize,
        cancellation,
    )
    .await?;
    if response.body.len() != segment.bytes as usize || digest(&response.body) != segment.digest {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(response.body)
}

async fn retire_unsealed_key(
    remote: &S3BlobStore,
    key: &str,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    check_cancelled(cancellation)?;
    let current = get_segment(remote, key, None, SEGMENT_BYTES, cancellation).await;
    if !matches!(current, Ok(ref data) if data.body.as_ref() == RETIRED_SEGMENT) {
        match current {
            Ok(_) | Err(PortError::Domain(DomainError::ResourceNotFound)) => {}
            Err(error) => return Err(error),
        }
        put_retired_segment(remote, key, cancellation).await?;
    }
    let marker = get_segment(remote, key, None, RETIRED_SEGMENT.len(), cancellation).await?;
    if marker.body.as_ref() != RETIRED_SEGMENT {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    if remote.bucket_mode() == S3BucketMode::Enabled {
        let physical = remote_key(remote, key);
        for version in remote.list_exact_key_versions(&physical).await? {
            check_cancelled(cancellation)?;
            if version.key != physical || version.is_delete_marker || version.is_latest {
                continue;
            }
            match get_segment(
                remote,
                key,
                Some(&version.version_id),
                SEGMENT_BYTES,
                cancellation,
            )
            .await
            {
                Ok(data) if data.body.as_ref() == RETIRED_SEGMENT => continue,
                Ok(_) => {
                    delete_segment_version(remote, key, version.version_id, cancellation).await?
                }
                Err(PortError::Domain(DomainError::ResourceNotFound)) => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

async fn put_retired_segment(
    store: &S3BlobStore,
    key: &str,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    let result = s3_request(
        store,
        S3RawRequest {
            method: Method::PUT,
            key: Some(remote_key(store, key)),
            query: Vec::new(),
            headers: Vec::new(),
            body: Bytes::from_static(RETIRED_SEGMENT),
        },
        64 * 1024,
        cancellation,
    )
    .await?;
    if matches!(result.status, 200 | 201) {
        Ok(())
    } else {
        Err(remote_error())
    }
}

async fn delete_segment_version(
    store: &S3BlobStore,
    key: &str,
    version: String,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    let result = s3_request(
        store,
        S3RawRequest {
            method: Method::DELETE,
            key: Some(remote_key(store, key)),
            query: vec![("versionId".to_owned(), version)],
            headers: Vec::new(),
            body: Bytes::new(),
        },
        64 * 1024,
        cancellation,
    )
    .await?;
    if matches!(result.status, 200 | 204 | 404) {
        Ok(())
    } else {
        Err(remote_error())
    }
}

async fn get_segment(
    store: &S3BlobStore,
    key: &str,
    version: Option<&str>,
    limit: usize,
    cancellation: &Cancellation,
) -> Result<S3RawResponse, PortError> {
    let response = s3_request(
        store,
        S3RawRequest {
            method: Method::GET,
            key: Some(remote_key(store, key)),
            query: version
                .map(|id| ("versionId".to_owned(), id.to_owned()))
                .into_iter()
                .collect(),
            headers: Vec::new(),
            body: Bytes::new(),
        },
        limit,
        cancellation,
    )
    .await?;
    match response.status {
        200 if version.is_none() || response.version_id().as_deref() == version => Ok(response),
        404 => Err(DomainError::ResourceNotFound.into()),
        _ => Err(remote_error()),
    }
}

async fn put_segment(
    store: &S3BlobStore,
    key: &str,
    bytes: Bytes,
    expected: ContentDigest,
    cancellation: &Cancellation,
) -> Result<Option<String>, PortError> {
    let len = bytes.len();
    let result = s3_request(
        store,
        S3RawRequest {
            method: Method::PUT,
            key: Some(remote_key(store, key)),
            query: Vec::new(),
            headers: vec![("if-none-match".to_owned(), "*".to_owned())],
            body: bytes,
        },
        64 * 1024,
        cancellation,
    )
    .await;
    check_cancelled(cancellation)?;
    let version = match result {
        Ok(response) if matches!(response.status, 200 | 201) => response.version_id(),
        _ => {
            let verified = get_segment(store, key, None, len, cancellation).await?;
            if verified.body.len() != len || digest(&verified.body) != expected {
                return Err(invalid(ValidationReason::InvalidDigest));
            }
            verified.version_id()
        }
    };
    if version.is_some() != (store.bucket_mode() == S3BucketMode::Enabled) {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    Ok(version)
}

async fn s3_request(
    store: &S3BlobStore,
    request: S3RawRequest,
    limit: usize,
    cancellation: &Cancellation,
) -> Result<S3RawResponse, PortError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(codec::cancelled_not_committed("archive_s3_cancelled", "operational storage cancelled")),
        result = store.transport().send_bounded(request, limit) => result,
    }
}

fn remote_key(store: &S3BlobStore, key: &str) -> String {
    format!(
        "{}/archives/{key}",
        store.application_prefix().trim_end_matches('/')
    )
}

fn digest(bytes: &[u8]) -> ContentDigest {
    ContentDigest::from_bytes(*blake3::hash(bytes).as_bytes())
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

fn storage_io(error: std::io::Error) -> PortError {
    if error.kind() == ErrorKind::NotFound {
        return DomainError::ResourceNotFound.into();
    }
    codec::internal_not_committed("archive_storage_io", error.kind().to_string())
}

fn remote_error() -> PortError {
    codec::unavailable_retryable(
        "archive_s3",
        "operational storage request failed",
        Duration::from_millis(250),
    )
}
