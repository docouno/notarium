use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use notarium_canonical::codec;
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, InstallationId, SpaceId},
    ports::{BackupArtifactKind, Cancellation},
};
use serde::{Deserialize, Serialize};

use crate::import::check_cancelled;

pub(crate) const MANIFEST: &str = "manifest.json";
pub(crate) const CONTROL: &str = "db/control";
pub(crate) const CANONICAL: &str = "db/canonical";
pub(crate) const CAS_INDEX: &str = "cas/index";
pub(crate) const CAS_DATA: &str = "cas/data";
pub(crate) const ZIP_NAMES: [&str; 5] = [MANIFEST, CONTROL, CANONICAL, CAS_INDEX, CAS_DATA];
pub(crate) const MANIFEST_LIMIT: usize = 64 * 1024;
pub(crate) const CAS_INDEX_MAGIC: &[u8; 8] = b"NTBCAS1\0";
pub(crate) const CAS_HEADER_BYTES: u64 = 16;
const SPACE_BYTES: usize = 35;
pub(crate) const CAS_RECORD_BYTES: u64 = (SPACE_BYTES + 32 + 3 * 8) as u64;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub installation: InstallationId,
    pub backend: BackupArtifactKind,
    pub control: Payload,
    pub canonical: Payload,
    pub index: Payload,
    pub cas: Payload,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Payload {
    pub bytes: u64,
    pub digest: ContentDigest,
}

#[derive(Clone, Debug)]
pub(crate) struct CasRecord {
    pub space: SpaceId,
    pub digest: ContentDigest,
    pub offset: u64,
    pub compressed: u64,
    pub raw: u64,
}

impl CasRecord {
    pub(crate) fn write(&self, out: &mut impl Write) -> Result<(), PortError> {
        let mut record = [0; CAS_RECORD_BYTES as usize];
        let space = self.space.as_str().as_bytes();
        record[..space.len()].copy_from_slice(space);
        record[SPACE_BYTES..SPACE_BYTES + 32].copy_from_slice(self.digest.as_bytes());
        let base = SPACE_BYTES + 32;
        for (index, value) in [self.offset, self.compressed, self.raw]
            .into_iter()
            .enumerate()
        {
            record[base + index * 8..base + (index + 1) * 8].copy_from_slice(&value.to_be_bytes());
        }
        out.write_all(&record).map_err(io_error)
    }

    pub(crate) fn read(input: &mut impl Read) -> Result<Self, PortError> {
        let mut record = [0; CAS_RECORD_BYTES as usize];
        input.read_exact(&mut record).map_err(io_error)?;
        let space = std::str::from_utf8(&record[..SPACE_BYTES])
            .map_err(|_| invalid(ValidationReason::InvalidUtf8))?
            .trim_end_matches('\0');
        let base = SPACE_BYTES + 32;
        let value = |i: usize| {
            u64::from_be_bytes(record[base + i * 8..base + (i + 1) * 8].try_into().unwrap())
        };
        Ok(Self {
            space: SpaceId::parse(space)?,
            digest: ContentDigest::from_bytes(record[SPACE_BYTES..base].try_into().unwrap()),
            offset: value(0),
            compressed: value(1),
            raw: value(2),
        })
    }
}

pub(crate) struct WorkDirectory(PathBuf);

impl WorkDirectory {
    pub(crate) fn sibling(destination: &Path) -> Result<Self, PortError> {
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = codec::new_prefixed_hex_id(".notarium-backup-")?;
        let path = parent.join(name);
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(io_error)?;
        Ok(Self(path))
    }

    pub(crate) fn path(&self, name: &'static str) -> PathBuf {
        self.0.join(name)
    }

    pub(crate) fn publish(&self, name: &'static str, destination: &Path) -> Result<(), PortError> {
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::hard_link(self.path(name), destination).map_err(io_error)?;
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(io_error)
    }
}

impl Drop for WorkDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn copy_hash(
    input: &mut impl Read,
    output: &mut impl Write,
    limit: u64,
    cancellation: &Cancellation,
) -> Result<Payload, PortError> {
    let mut buffer = [0; 128 * 1024];
    let mut bytes = 0_u64;
    let mut hasher = blake3::Hasher::new();
    loop {
        check_cancelled(cancellation)?;
        let size = input.read(&mut buffer).map_err(io_error)?;
        if size == 0 {
            break;
        }
        bytes = bytes
            .checked_add(size as u64)
            .filter(|&len| len <= limit)
            .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
        hasher.update(&buffer[..size]);
        output.write_all(&buffer[..size]).map_err(io_error)?;
    }
    Ok(Payload {
        bytes,
        digest: ContentDigest::from_bytes(*hasher.finalize().as_bytes()),
    })
}

pub(crate) fn measure_file(
    file: &mut File,
    limit: u64,
    cancellation: &Cancellation,
) -> Result<Payload, PortError> {
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let identity = copy_hash(file, &mut io::sink(), limit, cancellation)?;
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    Ok(identity)
}

pub(crate) fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

pub(crate) fn io_error(err: io::Error) -> PortError {
    codec::internal_not_committed("backup_archive_io", err.kind().to_string())
}
