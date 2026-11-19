//! Space-local search generations and stable folder ordinals.

use crate::ports::ResolvedEmbeddingTarget;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::{
    epoch::{DataRoot, SearchIndexKind},
    ids::{FolderId, ModelProfileId, ProviderResourceId, SpaceSeq},
    model::{FolderRef, HistoryScope},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    num::{NonZeroU32, NonZeroU64},
    path::PathBuf,
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
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteVectorModel {
    pub provider: ProviderResourceId,
    pub runtime_epoch: NonZeroU64,
    pub project: Option<FolderRef>,
}

impl VectorModel {
    pub fn local(profile: ModelProfileId, dimension: u32) -> Self {
        Self {
            profile,
            remote: None,
            dimension,
            max_input_tokens: 512,
        }
    }

    pub(crate) fn hash(&self) -> [u8; 32] {
        match &self.remote {
            None => crate::vector::model_hash(&self.profile),
            Some(remote) => {
                let mut hash =
                    blake3::Hasher::new_derive_key("notarium/search/remote-vector-model/v1");
                hash.update(remote.provider.as_str().as_bytes());
                hash.update(&[0]);
                hash.update(self.profile.as_str().as_bytes());
                hash.update(&remote.runtime_epoch.get().to_le_bytes());
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EpochManifest {
    pub scope: HistoryScope,
    pub model: VectorModel,
    pub vector_seq: SpaceSeq,
    pub active_segments: Vec<u64>,
    pub complete_backfill: bool,
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
        self.tantivy.remove_dir_all(index_name(generation))?;
        sync_dir(&self.tantivy)?;
        Ok(())
    }

    pub fn index_generations(&self) -> Result<Vec<u64>, LayoutError> {
        let mut generations = Vec::new();
        for entry in self.tantivy.entries()? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str().filter(|name| name.starts_with("index_")) else {
                continue;
            };
            let generation = parse_index_name(name)?;
            if !entry.file_type()?.is_dir() {
                return Err(LayoutError::Corrupt);
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
            let name = entry.file_name();
            let valid = name.to_str().is_some_and(|name| {
                name.len() == 16
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            });
            if !valid || !entry.file_type()?.is_dir() {
                return Err(LayoutError::Corrupt);
            }
            if name.to_str() != preserve.as_deref() {
                self.vector.remove_dir_all(name)?;
            }
        }
        sync_dir(&self.vector)?;
        Ok(())
    }

    pub fn remove_model_epoch(&self, model: &VectorModel) -> Result<(), LayoutError> {
        let name = model_epoch_name(model);
        match self.vector.open_dir_nofollow(&name) {
            Ok(_) => self.vector.remove_dir_all(&name)?,
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

fn sync_dir(dir: &Dir) -> io::Result<()> {
    dir.open_with(".", OpenOptions::new().read(true).maybe_dir(true))?
        .sync_all()
}

pub(crate) fn atomic_file(dir: &Dir, name: &str, bytes: &[u8]) -> Result<(), LayoutError> {
    match dir.symlink_metadata(name) {
        Ok(meta) if !meta.is_file() => return Err(LayoutError::Corrupt),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
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
            Err(error) => return Err(error.into()),
        }
    };
    let write = (|| {
        file.write_all(bytes)?;
        file.sync_data()?;
        drop(file);
        dir.rename(&tmp, dir, name)?;
        sync_dir(dir)?;
        Ok(())
    })();
    if write.is_err() {
        let _ = dir.remove_file(&tmp);
    }
    write
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
