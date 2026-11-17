//! confined participant artifacts and crash-recovery ownership.
use super::failure;
use crate::store::fence::FileFence;
use cap_fs_ext::OpenOptionsSyncExt;
use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, OpenOptions},
};
use notarium_core::{
    epoch::DataRoot,
    error::PortError,
    ids::{ArtifactId, BackupId},
    ports::BackupSpool,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
};
const MAX_MARKER: usize = 2 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    format: String,
    artifact: ArtifactId,
    backup: BackupId,
}
/// Owner lock is held through recovery and the complete live worker. A second
/// process cannot mistake a currently running backup for an abandoned task.
pub(crate) struct Artifacts {
    root: Dir,
    path: PathBuf,
    _owner: FileFence,
    owned: Option<ArtifactId>,
}
fn sync(root: &Dir) -> Result<(), PortError> {
    root.open(".")
        .and_then(|f| f.sync_all())
        .map_err(|_| failure())
}
fn create_file(root: &Dir, name: &str) -> Result<cap_std::fs::File, PortError> {
    let mut options = OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    root.open_with(name, &options).map_err(|_| failure())
}
fn open_regular(root: &Dir, name: &str) -> Result<cap_std::fs::File, PortError> {
    let mut options = OpenOptions::new();
    options.read(true).nonblock(true);
    let file = root.open_with(name, &options).map_err(|_| failure())?;
    if !file.metadata().map_err(|_| failure())?.is_file() {
        return Err(failure());
    }
    Ok(file)
}
fn read_json<T: serde::de::DeserializeOwned>(root: &Dir, name: &str) -> Result<T, PortError> {
    let mut file = open_regular(root, name)?;
    let meta = file.metadata().map_err(|_| failure())?;
    if !meta.is_file() || meta.len() > MAX_MARKER as u64 {
        return Err(failure());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    (&mut file)
        .take((MAX_MARKER + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| failure())?;
    if bytes.len() > MAX_MARKER || bytes.len() as u64 != meta.len() {
        return Err(failure());
    }
    serde_json::from_slice(&bytes).map_err(|_| failure())
}
fn write_json(root: &Dir, name: &str, value: &impl Serialize) -> Result<(), PortError> {
    let bytes = serde_json::to_vec(value).map_err(|_| failure())?;
    if bytes.len() > MAX_MARKER {
        return Err(failure());
    }
    let mut file = create_file(root, name)?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| failure())?;
    sync(root)
}
fn name(id: &ArtifactId, suffix: &str) -> String {
    format!("{}{suffix}", id.as_str())
}
fn remove(root: &Dir, name: &str) -> Result<(), PortError> {
    match root.remove_file(name) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(failure()),
    }
}
impl Artifacts {
    pub(crate) fn open(
        data: &DataRoot,
        check: impl Fn() -> Result<(), PortError>,
    ) -> Result<Self, PortError> {
        check()?;
        let data_dir =
            Dir::open_ambient_dir(data.root(), ambient_authority()).map_err(|_| failure())?;
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        {
            use cap_std::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        let mut dir = data_dir;
        for part in ["staging", "artifacts", "control"] {
            match dir.create_dir_with(part, &builder) {
                Ok(()) => sync(&dir)?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err(failure()),
            };
            dir = dir.open_dir(part).map_err(|_| failure())?;
            #[cfg(unix)]
            {
                use cap_std::fs::PermissionsExt;
                if dir
                    .dir_metadata()
                    .map_err(|_| failure())?
                    .permissions()
                    .mode()
                    & 0o022
                    != 0
                {
                    return Err(failure());
                }
            }
        }
        let path = data.staging().join("control");
        let owner = FileFence::acquire(&path.join("owner.lock"), true, &check)?;
        let value = Self {
            root: dir,
            path,
            _owner: owner,
            owned: None,
        };
        value.recover(&check)?;
        Ok(value)
    }
    fn recover(&self, check: &impl Fn() -> Result<(), PortError>) -> Result<(), PortError> {
        for entry in self.root.entries().map_err(|_| failure())? {
            check()?;
            let entry = entry.map_err(|_| failure())?;
            let file = entry.file_name();
            let Some(file) = file.to_str() else { continue };
            let Some(raw) = file.strip_suffix(".pending") else {
                continue;
            };
            let Ok(id) = ArtifactId::parse_v1(raw) else {
                continue;
            };
            let marker: Pending = read_json(&self.root, file)?;
            if marker.format != "notarium-control-pending-v1" || marker.artifact != id {
                return Err(failure());
            }
            // A durable ready marker may exist alongside pending after a crash. It was
            // written and fsynced before any receipt could be acknowledged; retain it.
            if self
                .root
                .try_exists(name(&id, ".ready"))
                .map_err(|_| failure())?
            {
                let ready: BackupSpool = read_json(&self.root, &name(&id, ".ready"))?;
                if ready.artifact != id {
                    return Err(failure());
                }
                remove(&self.root, file)?;
            } else {
                self.remove_owned_files(&id)?;
            }
        }
        sync(&self.root)
    }
    pub(crate) fn begin(
        &mut self,
        artifact: &ArtifactId,
        backup: &BackupId,
    ) -> Result<PathBuf, PortError> {
        // The owner lock serializes this namespace across cooperating processes.
        // A collision must never grant ownership of an existing completed artifact.
        for suffix in [
            ".pending",
            ".partial",
            ".partial-journal",
            ".partial-wal",
            ".partial-shm",
            ".data",
            ".ready",
        ] {
            match self.root.symlink_metadata(name(artifact, suffix)) {
                Ok(_) => return Err(failure()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(failure()),
            }
        }
        let bytes = serde_json::to_vec(&Pending {
            format: "notarium-control-pending-v1".into(),
            artifact: artifact.clone(),
            backup: backup.clone(),
        })
        .map_err(|_| failure())?;
        let mut marker = create_file(&self.root, &name(artifact, ".pending"))?;
        // Ownership starts only after exclusive marker creation. A colliding ID must
        // never authorize deleting a previous worker's files.
        self.owned = Some(artifact.clone());
        marker
            .write_all(&bytes)
            .and_then(|()| marker.sync_all())
            .map_err(|_| failure())?;
        sync(&self.root)?;
        create_file(&self.root, &name(artifact, ".partial"))?
            .sync_all()
            .map_err(|_| failure())?;
        sync(&self.root)?;
        Ok(self.path.join(name(artifact, ".partial")))
    }
    pub(crate) fn complete(&self, receipt: &BackupSpool) -> Result<(), PortError> {
        self.root
            .rename(
                name(&receipt.artifact, ".partial"),
                &self.root,
                name(&receipt.artifact, ".data"),
            )
            .map_err(|_| failure())?;
        sync(&self.root)?;
        write_json(&self.root, &name(&receipt.artifact, ".ready"), receipt)?;
        remove(&self.root, &name(&receipt.artifact, ".pending"))?;
        sync(&self.root)
    }
    pub(crate) fn abort(&mut self) -> Result<(), PortError> {
        if let Some(id) = self.owned.take() {
            self.remove_owned_files(&id)?;
        }
        Ok(())
    }
    pub(crate) fn retain(&mut self) {
        self.owned = None;
    }
    fn remove_owned_files(&self, id: &ArtifactId) -> Result<(), PortError> {
        for suffix in [
            ".partial",
            ".partial-journal",
            ".partial-wal",
            ".partial-shm",
            ".data",
            ".ready",
            ".pending",
        ] {
            remove(&self.root, &name(id, suffix))?;
        }
        sync(&self.root)
    }
}
/// Only participant-owned immutable artifacts are resolved; callers never supply
/// a filesystem path. Complete-file integrity is checked without a RAM copy.
pub(crate) fn open_completed(
    data: &DataRoot,
    id: &ArtifactId,
    check: impl Fn() -> Result<(), PortError>,
) -> Result<(BackupSpool, std::fs::File), PortError> {
    check()?;
    ArtifactId::parse_v1(id.as_str())?;
    let dir = Dir::open_ambient_dir(data.staging().join("control"), ambient_authority())
        .map_err(|_| failure())?;
    let receipt: BackupSpool = read_json(&dir, &name(id, ".ready"))?;
    if &receipt.artifact != id {
        return Err(failure());
    }
    let mut file = open_regular(&dir, &name(id, ".data"))?.into_std();
    if !file.metadata().map_err(|_| failure())?.is_file() {
        return Err(failure());
    }
    let mut digest = blake3::Hasher::new();
    let mut bytes = 0u64;
    let mut chunk = [0; 65536];
    loop {
        check()?;
        let n = file.read(&mut chunk).map_err(|_| failure())?;
        if n == 0 {
            break;
        }
        bytes = bytes.checked_add(n as u64).ok_or_else(failure)?;
        if bytes > receipt.bytes {
            return Err(failure());
        }
        digest.update(&chunk[..n]);
    }
    if bytes != receipt.bytes || digest.finalize().as_bytes() != receipt.digest.as_bytes() {
        return Err(failure());
    }
    use std::io::Seek;
    file.rewind().map_err(|_| failure())?;
    check()?;
    Ok((receipt, file))
}
