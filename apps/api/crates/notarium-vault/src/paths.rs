use std::path::{Component, Path, PathBuf};

use notarium_canonical::vault::{VaultFileStamp, VaultPath};
use notarium_core::{DomainError, DomainResult, error::ValidationReason, ids::ContentDigest};
use notarium_syntax::unicode::{PortableFilename, lookup_key};

use crate::filesystem::{FileIdentity, FileStamp};

pub(crate) const RESERVED: &str = ".notarium";
pub(crate) const GIT_LOCK: &str = ".git/index.lock";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathUse {
    Notes,
    Reserved,
    Ignore,
}

pub(crate) fn path_use(path: &Path) -> PathUse {
    let mut parts = path.components();
    match parts.next() {
        Some(Component::Normal(part)) if part == RESERVED => PathUse::Reserved,
        Some(Component::Normal(part)) if part == ".git" => PathUse::Ignore,
        Some(Component::Normal(part)) if !part.as_encoded_bytes().starts_with(b".") => {
            if parts.any(|part| {
                !matches!(part, Component::Normal(name) if !name.as_encoded_bytes().starts_with(b"."))
            }) {
                PathUse::Ignore
            } else {
                PathUse::Notes
            }
        }
        _ => PathUse::Ignore,
    }
}

pub(crate) fn is_note(path: &Path) -> bool {
    path_use(path) == PathUse::Notes
        && path.extension().is_some_and(|ext| ext == "md")
        && path.file_name().is_some_and(|name| {
            !name
                .as_encoded_bytes()
                .windows(b".conflict-".len())
                .any(|part| part == b".conflict-")
        })
}

pub(crate) fn note_path(folders: &[String], slug: &str) -> DomainResult<PathBuf> {
    let mut path = PathBuf::new();
    for folder in folders {
        path.push(PortableFilename::parse(folder)?.as_str());
    }
    path.push(PortableFilename::note_slug(slug)?.as_str());
    if !is_note(&path) {
        return Err(DomainError::validation(
            ValidationReason::InvalidPathComponent,
        ));
    }
    Ok(path)
}

/// Store slashes on every platform. Use the portable Unicode key even on
/// case-sensitive volumes so a bound vault can be copied to other filesystems.
pub(crate) fn vault_path(path: &Path) -> DomainResult<VaultPath> {
    let invalid = || DomainError::validation(ValidationReason::InvalidPathComponent);
    let mut relative = String::new();
    let mut key = String::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(invalid());
        };
        let component = component.to_str().ok_or_else(invalid)?;
        PortableFilename::parse(component)?;
        if !relative.is_empty() {
            relative.push('/');
            key.push('/');
        }
        relative.push_str(component);
        key.push_str(&lookup_key(component));
    }
    if relative.is_empty() {
        return Err(invalid());
    }
    Ok(VaultPath { relative, key })
}

pub(crate) fn digest(bytes: &[u8]) -> ContentDigest {
    ContentDigest::from_bytes(*blake3::hash(bytes).as_bytes())
}

pub(crate) fn file_identity(identity: &FileIdentity) -> ContentDigest {
    let mut hash = blake3::Hasher::new_derive_key("notarium v1 vault file identity");
    hash.update(&identity.volume.to_be_bytes());
    hash.update(&identity.file.to_be_bytes());
    ContentDigest::from_bytes(*hash.finalize().as_bytes())
}

pub(crate) fn file_stamp(stamp: &FileStamp) -> VaultFileStamp {
    let seconds = stamp.mtime_ns.div_euclid(1_000_000_000);
    let nanos = stamp.mtime_ns.rem_euclid(1_000_000_000);
    VaultFileStamp {
        identity: file_identity(&stamp.identity),
        size: stamp.size,
        mtime_seconds: i64::try_from(seconds)
            .expect("supported filesystem timestamps fit signed seconds"),
        mtime_nanos: nanos as u32,
        digest: stamp.digest,
    }
}

/// mtime may change when a volume updates metadata during the exchange. An
/// equal digest and object identity still prove which inode was displaced.
pub(crate) fn same_file(recorded: &VaultFileStamp, actual: &FileStamp) -> bool {
    recorded.identity == file_identity(&actual.identity)
        && recorded.digest == actual.digest
        && recorded.size == actual.size
}
