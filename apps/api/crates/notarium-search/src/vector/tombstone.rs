use super::VectorError;
use crate::layout::atomic_file;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use croaring::{Bitmap, Portable};
use std::{
    io::{self, Read},
    path::Path,
};

const MAGIC: &[u8; 8] = b"NCSRTMB1";

#[derive(Clone, Default)]
pub struct Tombstones {
    slots: Bitmap,
}

impl Tombstones {
    pub fn open(path: &Path, slots: u32) -> Result<Self, VectorError> {
        let dir = Dir::open_ambient_dir(
            path.parent().ok_or(VectorError::CorruptIndex)?,
            ambient_authority(),
        )?;
        let name = path.file_name().ok_or(VectorError::CorruptIndex)?;
        let disk_bound = u64::from(slots).saturating_mul(8).saturating_add(1024);
        let meta = match dir.symlink_metadata(name) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error.into()),
        };
        if !meta.is_file() || meta.len() > disk_bound || meta.len() < 40 {
            return Err(VectorError::CorruptIndex);
        }
        let file = dir.open_with(
            name,
            OpenOptions::new().read(true).follow(FollowSymlinks::No),
        )?;
        let mut bytes = Vec::new();
        file.take(disk_bound + 1).read_to_end(&mut bytes)?;
        let (framed, checksum) = bytes
            .split_at_checked(bytes.len().saturating_sub(32))
            .ok_or(VectorError::CorruptIndex)?;
        if bytes.len() as u64 > disk_bound
            || !framed.starts_with(MAGIC)
            || blake3::hash(framed).as_bytes() != checksum
        {
            return Err(VectorError::CorruptIndex);
        }
        let payload = &framed[MAGIC.len()..];
        let bitmap =
            Bitmap::try_deserialize::<Portable>(payload).ok_or(VectorError::CorruptIndex)?;
        if bitmap.maximum().is_some_and(|slot| slot >= slots) {
            return Err(VectorError::CorruptIndex);
        }
        Ok(Self { slots: bitmap })
    }

    pub fn persist(&self, path: &Path) -> Result<(), VectorError> {
        let dir = Dir::open_ambient_dir(
            path.parent().ok_or(VectorError::CorruptIndex)?,
            ambient_authority(),
        )?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(VectorError::CorruptIndex)?;
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&self.slots.serialize::<Portable>());
        let checksum = blake3::hash(&bytes);
        bytes.extend_from_slice(checksum.as_bytes());
        atomic_file(&dir, name, &bytes)?;
        Ok(())
    }

    pub fn mark(&mut self, slot: u32) {
        self.slots.add(slot);
    }

    pub fn bitmap(&self) -> &Bitmap {
        &self.slots
    }
}
