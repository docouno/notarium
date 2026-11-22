//! Space-local search generations and stable folder ordinals.

use crate::ports::ResolvedEmbeddingTarget;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, File, OpenOptions},
};
use notarium_core::{
    epoch::{DataRoot, SearchIndexKind},
    ids::{FolderId, ModelProfileId, NoteId, ProviderResourceId, SpaceSeq},
    model::{FolderRef, HistoryScope},
    ports::ProviderRuntimeEpochs,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const FOLDER_DICTIONARY: &str = "folder_dict.bin";
const SEARCH_MANIFEST: &str = "search_manifest.json";
const EPOCH_MANIFEST: &str = "epoch_manifest.json";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_DICTIONARY_BYTES: u64 = 128 * 1024 * 1024;
const FOLDER_MAGIC: [u8; 8] = *b"NFDR\x01\x00\x00\x00";
static TEMP_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum LayoutError {
    #[error("search index I/O failed")]
    Io(#[from] io::Error),
    #[error("corrupt search index data")]
    Corrupt,
    #[error("search index belongs to another history")]
    WrongHistory,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FolderOrd(NonZeroU32);
impl FolderOrd {
    pub fn get(self) -> u32 {
        self.0.get()
    }
}

#[derive(Clone, Debug, Default)]
pub struct FolderDictionary {
    ordinals: HashMap<FolderId, FolderOrd>,
    folders: Vec<FolderId>,
}
impl FolderDictionary {
    pub fn len(&self) -> usize {
        self.folders.len()
    }
    pub fn is_empty(&self) -> bool {
        self.folders.is_empty()
    }
    pub fn get(&self, folder: &FolderId) -> Option<FolderOrd> {
        self.ordinals.get(folder).copied()
    }
    pub fn folder(&self, ord: FolderOrd) -> Option<&FolderId> {
        self.folders.get(ord.get() as usize - 1)
    }
    pub(crate) fn get_or_insert_shared(
        self: &mut std::sync::Arc<Self>,
        folder: &FolderId,
    ) -> Result<FolderOrd, LayoutError> {
        if let Some(ord) = self.get(folder) {
            return Ok(ord);
        }
        std::sync::Arc::make_mut(self).insert(folder.clone())
    }
    pub fn insert(&mut self, folder: FolderId) -> Result<FolderOrd, LayoutError> {
        if let Some(ord) = self.get(&folder) {
            return Ok(ord);
        }
        let ord = u32::try_from(self.folders.len())
            .ok()
            .and_then(|index| index.checked_add(1))
            .and_then(NonZeroU32::new)
            .map(FolderOrd)
            .ok_or(LayoutError::Corrupt)?;
        self.folders.push(folder.clone());
        self.ordinals.insert(folder, ord);
        Ok(ord)
    }
    fn decode(bytes: &[u8]) -> Result<Self, LayoutError> {
        let mut data = verify_footer(bytes)?;
        if take(&mut data, 8)? != FOLDER_MAGIC {
            return Err(LayoutError::Corrupt);
        }
        let count = u32::from_le_bytes(take(&mut data, 4)?.try_into().expect("four bytes"));
        let mut result = Self::default();
        for index in 1..=count {
            let len = u16::from_le_bytes(take(&mut data, 2)?.try_into().expect("two bytes"));
            let id = std::str::from_utf8(take(&mut data, usize::from(len))?)
                .map_err(|_| LayoutError::Corrupt)?;
            let folder = FolderId::parse(id).map_err(|_| LayoutError::Corrupt)?;
            if result.insert(folder)?.get() != index {
                return Err(LayoutError::Corrupt);
            }
        }
        if !data.is_empty() {
            return Err(LayoutError::Corrupt);
        }
        Ok(result)
    }
    fn encode(&self) -> Result<Vec<u8>, LayoutError> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&FOLDER_MAGIC);
        let count = u32::try_from(self.folders.len()).map_err(|_| LayoutError::Corrupt)?;
        bytes.extend_from_slice(&count.to_le_bytes());
        for id in &self.folders {
            let raw = id.as_str().as_bytes();
            let len = u16::try_from(raw.len()).map_err(|_| LayoutError::Corrupt)?;
            bytes.extend_from_slice(&len.to_le_bytes());
            bytes.extend_from_slice(raw);
        }
        let checksum = blake3::hash(&bytes);
        bytes.extend_from_slice(checksum.as_bytes());
        if bytes.len() as u64 > MAX_DICTIONARY_BYTES {
            return Err(LayoutError::Corrupt);
        }
        Ok(bytes)
    }
}

fn take<'a>(data: &mut &'a [u8], bytes: usize) -> Result<&'a [u8], LayoutError> {
    let (prefix, rest) = data.split_at_checked(bytes).ok_or(LayoutError::Corrupt)?;
    *data = rest;
    Ok(prefix)
}

fn verify_footer(bytes: &[u8]) -> Result<&[u8], LayoutError> {
    let (data, digest) = bytes
        .split_at_checked(bytes.len().saturating_sub(32))
        .ok_or(LayoutError::Corrupt)?;
    if blake3::hash(data).as_bytes() != digest {
        return Err(LayoutError::Corrupt);
    }
    Ok(data)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchManifest {
    pub scope: HistoryScope,
    pub tantivy_seq: SpaceSeq,
    pub tantivy_commit: u64,
    pub active_index_dir: String,
    pub tokenizer_version: u32,
    pub active_model: Option<ResolvedEmbeddingTarget>,
    pub vector_seq: Option<SpaceSeq>,
    pub embeddings_pending: bool,
}
impl SearchManifest {
    pub fn generation(&self) -> Result<u64, LayoutError> {
        parse_index_name(&self.active_index_dir)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct VectorModel {
    pub profile: ModelProfileId,
    pub remote: Option<RemoteVectorModel>,
    pub dimension: u32,
    pub max_input_tokens: u32,
    #[serde(default, skip_serializing_if = "crate::embed::Pooling::is_mean")]
    pub pooling: crate::embed::Pooling,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteVectorModel {
    pub provider: ProviderResourceId,
    pub runtime_epochs: ProviderRuntimeEpochs,
    pub project: Option<FolderRef>,
}

impl VectorModel {
    pub fn local(profile: ModelProfileId, dimension: u32) -> Self {
        Self {
            profile,
            remote: None,
            dimension,
            max_input_tokens: 512,
            pooling: crate::embed::Pooling::Mean,
        }
    }

    pub(crate) fn hash(&self) -> [u8; 32] {
        match &self.remote {
            None if self.pooling == crate::embed::Pooling::Cls => {
                let mut hash =
                    blake3::Hasher::new_derive_key("notarium/search/cls-vector-model/v1");
                hash.update(self.profile.as_str().as_bytes());
                *hash.finalize().as_bytes()
            }
            None => crate::vector::model_hash(&self.profile),
            Some(remote) => {
                let mut hash =
                    blake3::Hasher::new_derive_key("notarium/search/remote-vector-model/v1");
                hash.update(remote.provider.as_str().as_bytes());
                hash.update(&[0]);
                hash.update(self.profile.as_str().as_bytes());
                hash.update(&remote.runtime_epochs.resource.get().to_le_bytes());
                hash.update(
                    &remote
                        .runtime_epochs
                        .credential
                        .map_or(0, |epoch| epoch.get())
                        .to_le_bytes(),
                );
                if let Some(project) = &remote.project {
                    hash.update(project.space_id.as_str().as_bytes());
                    hash.update(&[0]);
                    hash.update(project.folder_id.as_str().as_bytes());
                }
                *hash.finalize().as_bytes()
            }
        }
    }
}

/// Older manifests inferred supersession from overlapping note IDs. New
/// manifests permit one revision to span segments and identify a direct
/// replacement explicitly until its predecessor tombstones are durable.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SegmentRecovery {
    #[default]
    Legacy,
    Stable,
    Retire {
        note: NoteId,
        through_segment: u64,
    },
}

impl SegmentRecovery {
    fn is_legacy(&self) -> bool {
        matches!(self, Self::Legacy)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EpochManifest {
    pub scope: HistoryScope,
    pub model: VectorModel,
    pub vector_seq: SpaceSeq,
    pub active_segments: Vec<u64>,
    pub complete_backfill: bool,
    #[serde(default, skip_serializing_if = "SegmentRecovery::is_legacy")]
    pub(crate) recovery: SegmentRecovery,
}
impl EpochManifest {
    fn validate(&self) -> Result<(), LayoutError> {
        if !(64..=4096).contains(&self.model.dimension)
            || self.model.max_input_tokens == 0
            || self.active_segments.first() == Some(&0)
            || self
                .active_segments
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
        {
            return Err(LayoutError::Corrupt);
        }
        if let SegmentRecovery::Retire {
            through_segment, ..
        } = &self.recovery
            && (self.active_segments.binary_search(through_segment).is_err()
                || self.active_segments.last() == Some(through_segment))
        {
            return Err(LayoutError::Corrupt);
        }
        Ok(())
    }
}

pub struct SearchLayout {
    tantivy: Dir,
    tantivy_path: PathBuf,
    vector: Dir,
    vector_path: PathBuf,
    scope: HistoryScope,
}
impl SearchLayout {
    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }

    pub fn open(root: &DataRoot, scope: HistoryScope) -> Result<Self, LayoutError> {
        let dir = Dir::open_ambient_dir(root.root(), ambient_authority())?;
        let dir = open_or_create(&dir, "v1")?;
        let dir = open_or_create(&dir, "search")?;
        let dir = open_or_create(&dir, scope.space_id.as_str())?;
        Ok(Self {
            tantivy: open_or_create(&dir, "tantivy")?,
            tantivy_path: root.search(&scope.space_id, SearchIndexKind::Tantivy),
            vector: open_or_create(&dir, "vector")?,
            vector_path: root.search(&scope.space_id, SearchIndexKind::Vector),
            scope,
        })
    }

    pub fn create_index_generation(&self, generation: u64) -> Result<PathBuf, LayoutError> {
        if generation == 0 {
            return Err(LayoutError::Corrupt);
        }
        let name = index_name(generation);
        self.tantivy.create_dir(&name)?;
        sync_dir(&self.tantivy)?;
        Ok(self.tantivy_path.join(name))
    }

    pub fn remove_index_generation(&self, generation: u64) -> Result<(), LayoutError> {
        remove_dir_all_readonly(&self.tantivy, index_name(generation))?;
        sync_dir(&self.tantivy)?;
        Ok(())
    }

    pub fn index_generations(&self) -> Result<Vec<u64>, LayoutError> {
        let mut generations = Vec::new();
        for entry in self.tantivy.entries()? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                return Err(LayoutError::Corrupt);
            }
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                tracing::warn!(
                    entry = ?name,
                    "ignoring non-utf8 entry in tantivy search directory"
                );
                continue;
            };
            let Some(generation) = name_str
                .starts_with("index_")
                .then(|| parse_index_name(name_str).ok())
                .flatten()
            else {
                if !matches!(name_str, SEARCH_MANIFEST | FOLDER_DICTIONARY) {
                    tracing::warn!(
                        entry = name_str,
                        "ignoring unexpected entry in tantivy search directory"
                    );
                }
                continue;
            };
            if !file_type.is_dir() {
                tracing::warn!(
                    entry = name_str,
                    "ignoring non-directory entry matching index generation prefix"
                );
                continue;
            }
            generations.push(generation);
        }
        generations.sort_unstable();
        Ok(generations)
    }

    /// Clear all derived copies when a purge has an erased or unknown identity.
    /// The indexing owner drains any published mmap snapshots first.
    pub fn remove_vector_epochs(&self, preserve: Option<&VectorModel>) -> Result<(), LayoutError> {
        let preserve = preserve.map(model_epoch_name);
        for entry in self.vector.entries()? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                return Err(LayoutError::Corrupt);
            }
            let name = entry.file_name();
            let valid = name.to_str().is_some_and(|name| {
                name.len() == 16
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            });
            if !valid || !file_type.is_dir() {
                tracing::warn!(
                    entry = ?name,
                    "ignoring unexpected entry in vector search directory"
                );
                continue;
            }
            if name.to_str() != preserve.as_deref() {
                remove_dir_all_readonly(&self.vector, &name)?;
            }
        }
        sync_dir(&self.vector)?;
        Ok(())
    }

    pub fn remove_model_epoch(&self, model: &VectorModel) -> Result<(), LayoutError> {
        let name = model_epoch_name(model);
        match self.vector.open_dir_nofollow(&name) {
            Ok(_) => remove_dir_all_readonly(&self.vector, &name)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        sync_dir(&self.vector)?;
        Ok(())
    }

    pub(crate) fn invalidate_search(&self) -> Result<(), LayoutError> {
        match self.tantivy.remove_file(SEARCH_MANIFEST) {
            Ok(()) => sync_dir(&self.tantivy)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    pub fn clear_lexical_manifests(&self) -> Result<(), LayoutError> {
        for name in [SEARCH_MANIFEST, FOLDER_DICTIONARY] {
            match self.tantivy.remove_file(name) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        sync_dir(&self.tantivy)?;
        Ok(())
    }

    pub fn search_manifest(&self) -> Result<Option<SearchManifest>, LayoutError> {
        let Some(manifest) = read_manifest::<SearchManifest>(&self.tantivy, SEARCH_MANIFEST)?
        else {
            return Ok(None);
        };
        self.check_scope(&manifest.scope)?;
        self.index_dir(&manifest)?;
        Ok(Some(manifest))
    }

    pub fn index_dir(&self, manifest: &SearchManifest) -> Result<PathBuf, LayoutError> {
        self.check_scope(&manifest.scope)?;
        manifest.generation()?;
        let path = &manifest.active_index_dir;
        check_regular_entries(&self.tantivy.open_dir_nofollow(path)?)?;
        Ok(self.tantivy_path.join(path))
    }

    /// Call after the generation and its folder dictionary are durable.
    pub fn publish_search(&self, manifest: &SearchManifest) -> Result<(), LayoutError> {
        self.index_dir(manifest)?;
        write_manifest(&self.tantivy, SEARCH_MANIFEST, manifest)
    }

    pub fn folder_dictionary(&self) -> Result<Option<FolderDictionary>, LayoutError> {
        read_bounded(&self.tantivy, FOLDER_DICTIONARY, MAX_DICTIONARY_BYTES)?
            .map(|bytes| FolderDictionary::decode(&bytes))
            .transpose()
    }

    pub fn persist_folder_dictionary(&self, dict: &FolderDictionary) -> Result<(), LayoutError> {
        atomic_file(&self.tantivy, FOLDER_DICTIONARY, &dict.encode()?)
    }

    pub fn model_epoch(&self, model: &VectorModel) -> Result<PathBuf, LayoutError> {
        let name = model_epoch_name(model);
        check_regular_entries(&open_or_create(&self.vector, &name)?)?;
        Ok(self.vector_path.join(name))
    }

    pub fn epoch_manifest(
        &self,
        model: &VectorModel,
    ) -> Result<Option<EpochManifest>, LayoutError> {
        let dir = match self.vector.open_dir_nofollow(model_epoch_name(model)) {
            Ok(dir) => dir,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        check_regular_entries(&dir)?;
        let Some(manifest) = read_manifest::<EpochManifest>(&dir, EPOCH_MANIFEST)? else {
            return Ok(None);
        };
        self.check_scope(&manifest.scope)?;
        if &manifest.model != model {
            return Err(LayoutError::Corrupt);
        }
        manifest.validate()?;
        Ok(Some(manifest))
    }

    /// Call after all referenced segment files and the mutable journal are durable.
    pub fn publish_epoch(&self, manifest: &EpochManifest) -> Result<(), LayoutError> {
        self.check_scope(&manifest.scope)?;
        manifest.validate()?;
        let dir = open_or_create(&self.vector, &model_epoch_name(&manifest.model))?;
        check_regular_entries(&dir)?;
        write_manifest(&dir, EPOCH_MANIFEST, manifest)
    }

    fn check_scope(&self, scope: &HistoryScope) -> Result<(), LayoutError> {
        if &self.scope != scope {
            return Err(LayoutError::WrongHistory);
        }
        Ok(())
    }
}

pub fn index_name(generation: u64) -> String {
    format!("index_{generation:016x}")
}

fn parse_index_name(name: &str) -> Result<u64, LayoutError> {
    let suffix = name.strip_prefix("index_").ok_or(LayoutError::Corrupt)?;
    let generation = u64::from_str_radix(suffix, 16).map_err(|_| LayoutError::Corrupt)?;
    if generation == 0 || index_name(generation) != name {
        return Err(LayoutError::Corrupt);
    }
    Ok(generation)
}

pub fn model_epoch_name(model: &VectorModel) -> String {
    let mut hash = blake3::Hasher::new_derive_key("notarium/search/vector-epoch/v1");
    hash.update(&model.hash());
    hash.update(&model.dimension.to_le_bytes());
    hash.update(&model.max_input_tokens.to_le_bytes());
    hash.finalize().to_hex()[..16].to_owned()
}

fn check_regular_entries(dir: &Dir) -> Result<(), LayoutError> {
    for entry in dir.entries()? {
        if !entry?.file_type()?.is_file() {
            return Err(LayoutError::Corrupt);
        }
    }
    Ok(())
}

fn open_or_create(parent: &Dir, name: &str) -> io::Result<Dir> {
    match parent.open_dir_nofollow(name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match parent.create_dir(name) {
                Ok(()) => sync_dir(parent)?,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            parent.open_dir_nofollow(name)
        }
        result => result,
    }
}

#[cfg(unix)]
pub(crate) fn sync_dir(dir: &Dir) -> io::Result<()> {
    use cap_fs_ext::OpenOptionsMaybeDirExt;

    dir.open_with(".", OpenOptions::new().read(true).maybe_dir(true))?
        .sync_all()
}

#[cfg(not(unix))]
pub(crate) fn sync_dir(_dir: &Dir) -> io::Result<()> {
    // Directory handles cannot be flushed portably on Windows/non-Unix
    // filesystems; derived indexes always rebuild on missing or corrupt files.
    Ok(())
}

pub(crate) fn remove_file_if_exists(dir: &Dir, name: impl AsRef<Path>) -> io::Result<()> {
    let name = name.as_ref();
    #[cfg(windows)]
    if let Ok(meta) = dir.symlink_metadata(name)
        && meta.is_file()
        && meta.permissions().readonly()
    {
        let mut permissions = meta.permissions();
        permissions.set_readonly(false);
        dir.set_permissions(name, permissions)?;
    }
    match dir.remove_file(name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(crate) fn remove_path_if_exists(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    if let Ok(meta) = std::fs::symlink_metadata(path)
        && meta.is_file()
        && meta.permissions().readonly()
    {
        let mut permissions = meta.permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)?;
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[cfg(windows)]
fn clear_readonly_in_dir(dir: &Dir) -> io::Result<()> {
    for entry in dir.entries()? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        if file_type.is_dir() {
            let child = dir.open_dir_nofollow(&name)?;
            clear_readonly_in_dir(&child)?;
        } else if file_type.is_file() {
            let meta = dir.symlink_metadata(&name)?;
            if meta.permissions().readonly() {
                let mut permissions = meta.permissions();
                permissions.set_readonly(false);
                dir.set_permissions(&name, permissions)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn remove_dir_all_readonly(parent: &Dir, name: impl AsRef<Path>) -> io::Result<()> {
    let name = name.as_ref();
    #[cfg(windows)]
    if let Ok(child) = parent.open_dir_nofollow(name) {
        clear_readonly_in_dir(&child)?;
    }
    parent.remove_dir_all(name)
}

pub(crate) fn atomic_write_with<E>(
    dir: &Dir,
    name: &str,
    write_fn: impl FnOnce(&mut File) -> Result<(), E>,
) -> Result<(), E>
where
    E: From<LayoutError>,
{
    match dir.symlink_metadata(name) {
        Ok(meta) if !meta.is_file() => return Err(LayoutError::Corrupt.into()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(LayoutError::from(error).into()),
    }
    let options = OpenOptions::new()
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No)
        .clone();
    let (tmp, mut file) = loop {
        let counter = TEMP_FILE.fetch_add(1, Ordering::Relaxed);
        let tmp = format!("{name}.{}.{counter}.tmp", std::process::id());
        match dir.open_with(&tmp, &options) {
            Ok(file) => break (tmp, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(LayoutError::from(error).into()),
        }
    };
    let write: Result<(), E> = (|| -> Result<(), E> {
        write_fn(&mut file)?;
        file.sync_data().map_err(LayoutError::from)?;
        drop(file);
        dir.rename(&tmp, dir, name).map_err(LayoutError::from)?;
        sync_dir(dir).map_err(LayoutError::from)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = remove_file_if_exists(dir, &tmp);
    }
    write
}

pub(crate) fn atomic_file(dir: &Dir, name: &str, bytes: &[u8]) -> Result<(), LayoutError> {
    atomic_write_with(dir, name, |file| {
        file.write_all(bytes).map_err(LayoutError::from)
    })
}

fn read_bounded(dir: &Dir, name: &str, limit: u64) -> Result<Option<Vec<u8>>, LayoutError> {
    match dir.symlink_metadata(name) {
        Ok(meta) if !meta.is_file() || meta.len() > limit => return Err(LayoutError::Corrupt),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let file = match dir.open_with(
        name,
        OpenOptions::new().read(true).follow(FollowSymlinks::No),
    ) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > limit {
        return Err(LayoutError::Corrupt);
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(LayoutError::Corrupt);
    }
    Ok(Some(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::ids::{HistoryIncarnation, SpaceId};
    use std::fs;

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn create() -> Self {
            let mut id = [0u8; 16];
            getrandom::fill(&mut id).unwrap();
            let path = std::env::temp_dir().join(format!("search-layout-{}", hex::encode(id)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scope() -> HistoryScope {
        HistoryScope {
            space_id: SpaceId::from_bytes([1; 16]),
            incarnation: HistoryIncarnation::from_bytes([2; 16]),
        }
    }

    #[test]
    fn unpublished_generation_preserves_current_manifest_and_folder_ordinals() {
        let scratch = TestRoot::create();
        let root = DataRoot::new(&scratch.0);
        let scope = scope();
        let layout = SearchLayout::open(&root, scope.clone()).unwrap();
        let folder = FolderId::from_bytes([1; 16]);
        let mut dictionary = FolderDictionary::default();
        let ordinal = dictionary.insert(folder.clone()).unwrap();
        assert_eq!(ordinal.get(), 1);
        layout.persist_folder_dictionary(&dictionary).unwrap();
        layout.create_index_generation(1).unwrap();
        let mut manifest = SearchManifest {
            scope: scope.clone(),
            tantivy_seq: SpaceSeq::new(3).unwrap(),
            tantivy_commit: 42,
            active_index_dir: index_name(1),
            tokenizer_version: 1,
            active_model: None,
            vector_seq: None,
            embeddings_pending: false,
        };
        layout.publish_search(&manifest).unwrap();
        layout.create_index_generation(2).unwrap();
        drop(layout);
        let reopened = SearchLayout::open(&root, scope.clone()).unwrap();
        assert_eq!(reopened.search_manifest().unwrap(), Some(manifest.clone()));
        let mut dictionary = reopened.folder_dictionary().unwrap().unwrap();
        assert_eq!(dictionary.insert(folder.clone()).unwrap(), ordinal);
        assert_eq!(dictionary.folder(ordinal), Some(&folder));
        assert_eq!(
            dictionary
                .insert(FolderId::from_bytes([2; 16]))
                .unwrap()
                .get(),
            2
        );
        reopened.persist_folder_dictionary(&dictionary).unwrap();
        manifest.active_index_dir = index_name(2);
        reopened.publish_search(&manifest).unwrap();
        reopened.remove_index_generation(1).unwrap();
        assert_eq!(reopened.search_manifest().unwrap(), Some(manifest));
        let wrong_scope = HistoryScope {
            incarnation: HistoryIncarnation::from_bytes([3; 16]),
            ..scope
        };
        assert!(matches!(
            SearchLayout::open(&root, wrong_scope)
                .unwrap()
                .search_manifest(),
            Err(LayoutError::WrongHistory)
        ));
    }

    #[test]
    fn legacy_mean_profiles_keep_the_manifest_checksum_and_epoch_identity() {
        let profile = ModelProfileId::from_bytes([1; 16]);
        let legacy = format!(
            r#"{{"profile":"{profile}","remote":null,"dimension":384,"max_input_tokens":512}}"#
        );
        let mean: VectorModel = serde_json::from_str(&legacy).unwrap();
        assert_eq!(serde_json::to_string(&mean).unwrap(), legacy);
        assert_eq!(mean.hash(), crate::vector::model_hash(&profile));
        let cls = VectorModel {
            pooling: crate::embed::Pooling::Cls,
            ..mean.clone()
        };
        assert_ne!(model_epoch_name(&mean), model_epoch_name(&cls));
    }

    #[test]
    fn corrupt_dictionaries_and_epoch_manifests_fail_closed() {
        let scratch = TestRoot::create();
        let root = DataRoot::new(&scratch.0);
        let scope = scope();
        let layout = SearchLayout::open(&root, scope.clone()).unwrap();
        let model = VectorModel::local(ModelProfileId::from_bytes([1; 16]), 384);
        let manifest = EpochManifest {
            scope: scope.clone(),
            model: model.clone(),
            vector_seq: SpaceSeq::new(3).unwrap(),
            active_segments: vec![1, 3],
            complete_backfill: true,
            recovery: SegmentRecovery::Stable,
        };
        let epoch = layout.model_epoch(&model).unwrap();
        layout.publish_epoch(&manifest).unwrap();
        assert_eq!(layout.epoch_manifest(&model).unwrap(), Some(manifest));
        let file = epoch.join(EPOCH_MANIFEST);
        let mut bytes = fs::read(&file).unwrap();
        let pos = bytes.windows(3).position(|word| word == b"384").unwrap();
        bytes[pos] = b'2';
        fs::write(file, bytes).unwrap();
        assert!(matches!(
            layout.epoch_manifest(&model),
            Err(LayoutError::Corrupt)
        ));

        layout
            .persist_folder_dictionary(&FolderDictionary::default())
            .unwrap();
        let file = root
            .search(&scope.space_id, SearchIndexKind::Tantivy)
            .join(FOLDER_DICTIONARY);
        let mut bytes = fs::read(&file).unwrap();
        bytes[8] ^= 1;
        fs::write(file, bytes).unwrap();
        assert!(matches!(
            layout.folder_dictionary(),
            Err(LayoutError::Corrupt)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_rejected_at_directory_and_file_boundaries() {
        let scratch = TestRoot::create();
        let root = DataRoot::new(&scratch.0);
        let scope = scope();
        let layout = SearchLayout::open(&root, scope.clone()).unwrap();
        let path = root.search(&scope.space_id, SearchIndexKind::Tantivy);
        std::os::unix::fs::symlink(&scratch.0, path.join(index_name(1))).unwrap();
        let manifest = SearchManifest {
            scope,
            tantivy_seq: SpaceSeq::ZERO,
            tantivy_commit: 0,
            active_index_dir: index_name(1),
            tokenizer_version: 1,
            active_model: None,
            vector_seq: None,
            embeddings_pending: false,
        };
        assert!(layout.publish_search(&manifest).is_err());
        std::os::unix::fs::symlink(&scratch.0, path.join(FOLDER_DICTIONARY)).unwrap();
        assert!(
            layout
                .persist_folder_dictionary(&FolderDictionary::default())
                .is_err()
        );
        assert!(layout.folder_dictionary().is_err());
    }

    #[test]
    fn stray_regular_files_are_ignored_while_symlinks_still_fail_closed() {
        let scratch = TestRoot::create();
        let root = DataRoot::new(&scratch.0);
        let scope = scope();
        let layout = SearchLayout::open(&root, scope.clone()).unwrap();
        let tantivy_dir = root.search(&scope.space_id, SearchIndexKind::Tantivy);
        let vector_dir = root.search(&scope.space_id, SearchIndexKind::Vector);

        layout.create_index_generation(1).unwrap();
        fs::write(tantivy_dir.join(".DS_Store"), b"finder").unwrap();
        fs::write(tantivy_dir.join("index_stray_file"), b"junk").unwrap();
        assert_eq!(layout.index_generations().unwrap(), vec![1]);

        let model = VectorModel::local(ModelProfileId::from_bytes([9; 16]), 64);
        let epoch_dir = layout.model_epoch(&model).unwrap();
        assert!(epoch_dir.exists());
        fs::write(vector_dir.join(".DS_Store"), b"finder").unwrap();
        layout.remove_vector_epochs(None).unwrap();
        assert!(!epoch_dir.exists());
        assert!(vector_dir.join(".DS_Store").exists());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&scratch.0, vector_dir.join("deadbeefdeadbeef")).unwrap();
            assert!(matches!(
                layout.remove_vector_epochs(None),
                Err(LayoutError::Corrupt)
            ));
            fs::remove_file(vector_dir.join("deadbeefdeadbeef")).unwrap();

            std::os::unix::fs::symlink(&scratch.0, tantivy_dir.join("stray_link")).unwrap();
            assert!(matches!(
                layout.index_generations(),
                Err(LayoutError::Corrupt)
            ));
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checked<T> {
    payload: T,
    blake3: [u8; 32],
}

fn hash_payload(data: &impl Serialize) -> Result<[u8; 32], LayoutError> {
    let data = serde_json::to_vec(data).map_err(|_| LayoutError::Corrupt)?;
    Ok(*blake3::hash(&data).as_bytes())
}

fn write_manifest(dir: &Dir, name: &str, payload: &impl Serialize) -> Result<(), LayoutError> {
    let result = Checked {
        payload,
        blake3: hash_payload(payload)?,
    };
    let bytes = serde_json::to_vec(&result).map_err(|_| LayoutError::Corrupt)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(LayoutError::Corrupt);
    }
    atomic_file(dir, name, &bytes)
}

fn read_manifest<T: Serialize + DeserializeOwned>(
    dir: &Dir,
    name: &str,
) -> Result<Option<T>, LayoutError> {
    let Some(bytes) = read_bounded(dir, name, MAX_MANIFEST_BYTES)? else {
        return Ok(None);
    };
    let envelope: Checked<T> = serde_json::from_slice(&bytes).map_err(|_| LayoutError::Corrupt)?;
    if hash_payload(&envelope.payload)? != envelope.blake3 {
        return Err(LayoutError::Corrupt);
    }
    Ok(Some(envelope.payload))
}
