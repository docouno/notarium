//! A reserved projection owns only paths and objects confirmed in its journal.

use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    path::{Path, PathBuf},
};

use cap_std::fs::Dir;
use notarium_canonical::{CanonicalStore, vault::VaultBinding};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{AbilityId, ContentDigest, RevisionId},
    model::HistoryScope,
    ports::{AbilityIdentity, MAX_ABILITY_AUX_FILES, MAX_ABILITY_AUX_PATH_BYTES, SpaceContext},
};
use serde::{Deserialize, Serialize};

use super::{no_access, read_ability_files, schema_yaml};
use crate::{
    filesystem::{
        CaptureCleanup, EntryKind, FileIdentity, FileStamp, Publication, PublishMode, VaultDir,
        Withdrawal, same_file_content, sync_dir,
    },
    journal::{open_or_create, random_digest, read_records, write_record},
    paths::file_identity,
};

const RECORD_EXTENSION: &str = "material";
// Two snapshots, each containing at most one annotated directory entry per
// component of every manifest path. Record contents never include file data.
const MAX_RECORD_BYTES: u64 =
    2 * (MAX_ABILITY_AUX_FILES as u64 + 1) * (MAX_ABILITY_AUX_PATH_BYTES as u64).pow(2);

#[derive(Debug, thiserror::Error)]
pub enum MaterialError {
    #[error("reserved vault material I/O failed")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Canonical(#[from] PortError),
    #[error(transparent)]
    Invalid(#[from] DomainError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ReservedConflictKind {
    ExternalChange,
    IncompleteStage,
    DisplacedChange,
    RetainedCapture,
    PublicationUncertain,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReservedConflict {
    pub path: PathBuf,
    pub kind: ReservedConflictKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserved_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
enum Target {
    Schema,
    Ability(AbilityId),
}

impl Target {
    fn path(&self) -> PathBuf {
        match self {
            Self::Schema => PathBuf::from(".notarium")
                .join("fields")
                .join("schema.yaml"),
            Self::Ability(ability) => PathBuf::from(".notarium")
                .join("abilities")
                .join(ability.as_str()),
        }
    }

    fn name(&self) -> String {
        match self {
            Self::Schema => format!("schema.{RECORD_EXTENSION}"),
            Self::Ability(ability) => format!("ability-{ability}.{RECORD_EXTENSION}"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
enum Version {
    Schema(ContentDigest),
    Ability(RevisionId),
}

enum Material {
    Schema(Vec<u8>),
    Ability(BTreeMap<PathBuf, Vec<u8>>),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum Artifact {
    File(FileStamp),
    Tree(TreeStamp),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TreeStamp {
    root: FileIdentity,
    files: BTreeMap<PathBuf, FileStamp>,
    directories: BTreeMap<PathBuf, FileIdentity>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Published {
    version: Version,
    artifact: Artifact,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum Pending {
    Staging {
        slot: PathBuf,
    },
    Ready {
        slot: PathBuf,
        next: Option<Published>,
    },
    Cleanup {
        slot: PathBuf,
        displaced: Artifact,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    scope: HistoryScope,
    generation: ContentDigest,
    root_identity: ContentDigest,
    target: Target,
    current: Option<Published>,
    pending: Option<Pending>,
    conflicts: Vec<ReservedConflict>,
}

impl Record {
    fn conflict(&mut self, path: PathBuf, kind: ReservedConflictKind) {
        self.clear(&path);
        self.conflicts.push(ReservedConflict {
            path,
            kind,
            preserved_path: None,
        });
    }

    fn retained(&mut self, path: PathBuf, preserved_path: PathBuf) {
        let recovery = ReservedConflict {
            path,
            kind: ReservedConflictKind::RetainedCapture,
            preserved_path: Some(preserved_path),
        };
        if !self.conflicts.contains(&recovery) {
            self.conflicts.push(recovery);
        }
    }

    fn clear(&mut self, path: &Path) {
        self.conflicts.retain(|entry| entry.path != path);
    }
}

pub struct ReservedMaterials {
    state_dir: Dir,
    binding: VaultBinding,
    records: BTreeMap<Target, Record>,
}

impl ReservedMaterials {
    /// Use a generation-specific journal and reject mismatched history or roots.
    /// The vault actor serializes filesystem operations and holds the sidecar lock.
    pub fn open(private_root: &Dir, binding: &VaultBinding) -> Result<Self, MaterialError> {
        let state_dir = open_or_create(
            private_root,
            &format!("vault-materials-{}", binding.generation.to_hex()),
        )?;
        let mut records = BTreeMap::new();
        for (name, record) in
            read_records::<Record>(&state_dir, RECORD_EXTENSION, MAX_RECORD_BYTES)?
        {
            if record.target.name() != name
                || record.generation != binding.generation
                || record.scope != binding.scope
                || record.root_identity != binding.root_identity
            {
                return Err(invalid_record().into());
            }
            records.insert(record.target.clone(), record);
        }
        Ok(Self {
            state_dir,
            binding: binding.clone(),
            records,
        })
    }

    pub fn conflicts(&self) -> impl Iterator<Item = &ReservedConflict> {
        self.records
            .values()
            .flat_map(|record| record.conflicts.iter())
    }

    pub fn recover(&mut self, vault: &VaultDir) -> Result<(), MaterialError> {
        self.check_root(vault)?;
        let targets: Vec<_> = self.records.keys().cloned().collect();
        for target in targets {
            let record = self.record(&target);
            if record.pending.is_some() {
                self.recover_record(vault, record, false)?;
            }
        }
        Ok(())
    }

    pub async fn sync_schema(
        &mut self,
        vault: &VaultDir,
        store: &CanonicalStore,
        ctx: &SpaceContext,
    ) -> Result<(), MaterialError> {
        ctx.check_current(&self.binding.scope)?;
        let schema = match store.read_vault_schema(ctx).await {
            Ok(schema) => schema,
            Err(error) if no_access(&error) => None,
            Err(error) => return Err(error.into()),
        };
        self.update(
            vault,
            Target::Schema,
            schema.map(|schema| {
                (
                    Version::Schema(schema.fingerprint),
                    Material::Schema(schema_yaml(&schema.fields).into_bytes()),
                )
            }),
        )
    }

    pub async fn sync_ability(
        &mut self,
        vault: &VaultDir,
        store: &CanonicalStore,
        ctx: &SpaceContext,
        identity: &AbilityIdentity,
    ) -> Result<(), MaterialError> {
        self.check_root(vault)?;
        ctx.check_current(&self.binding.scope)?;
        let target = Target::Ability(identity.id.clone());
        let planned = match store.read_vault_ability_manifest(ctx, identity).await {
            Ok(value) => value,
            Err(error) if no_access(&error) => return self.update(vault, target, None),
            Err(error) => return Err(error.into()),
        };
        let record = self.record(&target);
        let record = self.recover_record(vault, record, false)?;
        if record.current.as_ref().is_some_and(|current| {
            matches!(&current.version, Version::Ability(revision) if *revision == planned.revision)
        }) {
            return self.observe_reserved(vault, &target.path());
        }
        let files = read_ability_files(store, ctx, &planned).await?;
        // Every read was for one exact immutable manifest. Recheck that the
        // current owned tip and authority still allow that manifest to publish.
        let current = match store.read_vault_ability_manifest(ctx, identity).await {
            Ok(value) => value,
            Err(error) if no_access(&error) => return self.update(vault, target, None),
            Err(error) => return Err(error.into()),
        };
        if current.revision != planned.revision {
            // A newer package revision has its own durable change event.
            // Leave the prior tree intact and let that event publish the tip.
            return Ok(());
        }
        if current.manifest != planned.manifest {
            return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
        }
        let files = files.ok_or(DomainError::ResourceNotFound)?;
        self.update(
            vault,
            target,
            Some((Version::Ability(current.revision), Material::Ability(files))),
        )
    }

    pub fn retain_abilities(
        &mut self,
        vault: &VaultDir,
        bindings: &[AbilityIdentity],
    ) -> Result<(), MaterialError> {
        let bound: BTreeSet<_> = bindings.iter().map(|binding| &binding.id).collect();
        let stale: Vec<_> = self
            .records
            .keys()
            .filter_map(|target| match target {
                Target::Ability(id) if !bound.contains(id) => Some(target.clone()),
                _ => None,
            })
            .collect();
        for target in stale {
            self.update(vault, target, None)?;
        }
        Ok(())
    }

    /// Watcher observations only diagnose drift. They never import reserved
    /// documents or change the approved schema or ability revision.
    pub fn observe_reserved(&mut self, vault: &VaultDir, path: &Path) -> Result<(), MaterialError> {
        self.check_root(vault)?;
        let mut targets: Vec<_> = self
            .records
            .keys()
            .filter(|target| {
                let material = target.path();
                material.starts_with(path) || path.starts_with(material)
            })
            .cloned()
            .collect();
        let schema = Target::Schema;
        if path == schema.path() && !targets.contains(&schema) {
            targets.push(schema);
        }
        for target in targets {
            let target_path = target.path();
            let mut record = self.record(&target);
            if record.pending.is_none() {
                let expected = record.current.as_ref().map(|item| &item.artifact);
                let matched = artifact_matches(vault, &target_path, expected)?;
                if matched {
                    if record
                        .conflicts
                        .iter()
                        .any(|conflict| conflict.path == target_path)
                    {
                        record.clear(&target_path);
                        self.save(record)?;
                    }
                } else if !record
                    .conflicts
                    .iter()
                    .any(|conflict| conflict.path == target_path)
                {
                    record.conflict(target_path, ReservedConflictKind::ExternalChange);
                    self.save(record)?;
                }
            }
        }
        Ok(())
    }

    fn update(
        &mut self,
        vault: &VaultDir,
        target: Target,
        desired: Option<(Version, Material)>,
    ) -> Result<(), MaterialError> {
        self.check_root(vault)?;
        let record = self.record(&target);
        let mut record = self.recover_record(vault, record, false)?;
        let path = target.path();
        let expected = record.current.as_ref().map(|published| &published.artifact);
        if !artifact_matches(vault, &path, expected)? {
            record.conflict(path, ReservedConflictKind::ExternalChange);
            return self.save(record);
        }
        if record.current.as_ref().map(|value| &value.version)
            == desired.as_ref().map(|item| &item.0)
        {
            if record.conflicts.iter().any(|item| item.path == path) {
                record.clear(&path);
                self.save(record)?;
            }
            return Ok(());
        }
        let slot = VaultDir::operation_slot(&path, &random_digest()?.to_hex())?;
        let next = if let Some((version, material)) = desired {
            vault.create_dir_all(path.parent().expect("material path is nested"))?;
            record.pending = Some(Pending::Staging { slot: slot.clone() });
            self.save(record.clone())?;
            let artifact = stage(vault, &path, &slot, material)?;
            Some(Published { version, artifact })
        } else {
            None
        };
        record.pending = Some(Pending::Ready { slot, next });
        self.save(record.clone())?;
        self.recover_record(vault, record, true)?;
        Ok(())
    }

    fn recover_record(
        &mut self,
        vault: &VaultDir,
        mut record: Record,
        may_publish: bool,
    ) -> Result<Record, MaterialError> {
        match record.pending.clone() {
            None => return Ok(record),
            Some(Pending::Staging { slot }) => {
                // A crash before persisting the created identity leaves no
                // authority to touch a partially staged or replaced entry.
                if vault.entry_kind(&slot)?.is_some() {
                    record.conflict(slot, ReservedConflictKind::IncompleteStage);
                }
                record.pending = None;
            }
            Some(Pending::Ready { slot, next }) => {
                self.publish_ready(vault, &mut record, &slot, next, may_publish)?;
                return self.recover_record(vault, record, false);
            }
            Some(Pending::Cleanup { slot, displaced }) => {
                for (source, preserved) in retire(vault, &slot, &displaced)? {
                    record.retained(source, preserved);
                }
                record.pending = None;
            }
        }
        self.save(record.clone())?;
        Ok(record)
    }

    fn publish_ready(
        &mut self,
        vault: &VaultDir,
        record: &mut Record,
        slot: &Path,
        next: Option<Published>,
        may_publish: bool,
    ) -> Result<(), MaterialError> {
        let path = record.target.path();
        let backup = VaultDir::displaced_slot(slot)?;
        let expected = record.current.as_ref().map(|item| &item.artifact);
        let desired = next.as_ref().map(|item| &item.artifact);

        let before = artifact_matches(vault, &path, expected)?
            && artifact_matches(vault, slot, desired)?
            && vault.entry_kind(&backup)?.is_none();
        if before && !may_publish {
            // Startup may settle an applied swap. An unpublished stage has
            // no current authorization; the caller will re-read the tip.
            record.pending = next.map(|value| Pending::Cleanup {
                slot: slot.to_path_buf(),
                displaced: value.artifact,
            });
            return self.save(record.clone());
        }
        let syscall = if before {
            publish(vault, &path, slot, expected, desired)
        } else {
            Ok(())
        };
        let stage_present = vault.entry_kind(slot)?.is_some();
        let backup_present = vault.entry_kind(&backup)?.is_some();
        let displaced = match (stage_present, backup_present) {
            (true, false) => Some(slot),
            (false, true) => Some(backup.as_path()),
            _ => None,
        };
        let capture_accounted_for = if expected.is_some() {
            displaced.is_some()
        } else {
            !stage_present && !backup_present
        };

        if capture_accounted_for && artifact_matches(vault, &path, desired)? {
            // Reestablish durability when replay observes an already applied
            // namespace change, including one whose original flush failed.
            sync_dir(&vault.open_dir(path.parent().expect("material path is nested"))?)?;
            record.pending = expected.zip(displaced).map(|(old, slot)| Pending::Cleanup {
                slot: slot.to_path_buf(),
                displaced: old.clone(),
            });
            record.current = next;
            record.clear(&path);
        } else {
            // I/O failure with unchanged preconditions is retryable. A namespace
            // mismatch may have captured external data and must preserve it.
            if let Err(error) = syscall
                && artifact_matches(vault, &path, expected)?
                && artifact_matches(vault, slot, desired)?
                && vault.entry_kind(&backup)?.is_none()
            {
                return Err(error.into());
            }
            if stage_present {
                record.conflict(slot.to_path_buf(), ReservedConflictKind::DisplacedChange);
            }
            if backup_present {
                record.conflict(backup, ReservedConflictKind::DisplacedChange);
            }
            record.conflict(path, ReservedConflictKind::PublicationUncertain);
            record.pending = None;
        }
        self.save(record.clone())
    }

    fn record(&self, target: &Target) -> Record {
        self.records.get(target).cloned().unwrap_or_else(|| Record {
            scope: self.binding.scope.clone(),
            generation: self.binding.generation,
            root_identity: self.binding.root_identity,
            target: target.clone(),
            current: None,
            pending: None,
            conflicts: Vec::new(),
        })
    }

    fn save(&mut self, record: Record) -> Result<(), MaterialError> {
        write_record(&self.state_dir, &record.target.name(), &record)?;
        self.records.insert(record.target.clone(), record);
        Ok(())
    }

    fn check_root(&self, vault: &VaultDir) -> io::Result<()> {
        if file_identity(&vault.root_identity()) != self.binding.root_identity {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "reserved vault binding root changed",
            ));
        }
        Ok(())
    }
}

fn invalid_record() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid reserved material journal record",
    )
}

fn size_for(stamp: &FileStamp) -> io::Result<usize> {
    usize::try_from(stamp.size).map_err(|_| invalid_record())
}

fn file_matches(vault: &VaultDir, path: &Path, stamp: &FileStamp) -> io::Result<bool> {
    if vault.entry_kind(path)? != Some(EntryKind::File) {
        return Ok(false);
    }
    match vault.read(path, size_for(stamp)?) {
        Ok(value) => Ok(value.is_some_and(|file| same_file_content(&file.stamp, stamp))),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::InvalidInput | io::ErrorKind::AlreadyExists
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

fn artifact_matches(
    vault: &VaultDir,
    path: &Path,
    expected: Option<&Artifact>,
) -> io::Result<bool> {
    match expected {
        None => Ok(vault.entry_kind(path)?.is_none()),
        Some(Artifact::File(stamp)) => file_matches(vault, path, stamp),
        Some(Artifact::Tree(tree)) => {
            if vault.entry_kind(path)? != Some(EntryKind::Directory) {
                return Ok(false);
            }
            let directory = vault.subdir(path)?;
            Ok(directory.root_identity() == tree.root && tree.matches(&directory)?)
        }
    }
}

fn stage(vault: &VaultDir, path: &Path, slot: &Path, material: Material) -> io::Result<Artifact> {
    match material {
        Material::Schema(bytes) => vault.stage(path, slot, &bytes).map(Artifact::File),
        Material::Ability(files) => {
            vault.create_dir(slot)?;
            let staging = vault.subdir(slot)?;
            let mut tree = TreeStamp {
                root: staging.root_identity(),
                files: BTreeMap::new(),
                directories: BTreeMap::new(),
            };
            for (relative, content) in files {
                let parent = relative.parent().ok_or_else(invalid_record)?;
                staging.create_dir_all(parent)?;
                for parent in parent
                    .ancestors()
                    .take_while(|path| !path.as_os_str().is_empty())
                {
                    let id = staging.dir_identity(parent)?.ok_or_else(invalid_record)?;
                    if tree
                        .directories
                        .insert(parent.to_path_buf(), id)
                        .is_some_and(|prev| prev != id)
                    {
                        return Err(invalid_record());
                    }
                }
                let child_slot = VaultDir::operation_slot(&relative, &random_digest()?.to_hex())?;
                let stamp = staging.stage(&relative, &child_slot, &content)?;
                let Publication::Applied {
                    published,
                    displaced: None,
                } = staging.publish(&relative, &child_slot, None, &stamp, PublishMode::Regular)?
                else {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "staged package changed",
                    ));
                };
                tree.files.insert(relative, published);
            }
            if !tree.matches(&staging)? {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "staged package changed",
                ));
            }
            Ok(Artifact::Tree(tree))
        }
    }
}

fn publish(
    vault: &VaultDir,
    path: &Path,
    slot: &Path,
    expected: Option<&Artifact>,
    desired: Option<&Artifact>,
) -> io::Result<()> {
    match (expected, desired) {
        (None, Some(Artifact::Tree(_))) => vault.rename_path_no_replace(slot, path),
        (Some(Artifact::Tree(_)), Some(Artifact::Tree(_))) => vault.exchange_paths(slot, path),
        (Some(Artifact::Tree(_)), None) => vault.rename_path_no_replace(path, slot),
        (None, Some(Artifact::File(staged))) => {
            vault.publish(path, slot, None, staged, PublishMode::Regular)?;
            Ok(())
        }
        (Some(Artifact::File(old)), Some(Artifact::File(staged))) => {
            vault.publish(path, slot, Some(old), staged, PublishMode::Regular)?;
            Ok(())
        }
        (Some(Artifact::File(old)), None) => {
            vault.withdraw(path, slot, old)?;
            Ok(())
        }
        _ => Err(invalid_record()),
    }
}

impl TreeStamp {
    fn matches(&self, vault: &VaultDir) -> io::Result<bool> {
        self.check(vault, None)
    }

    /// Verify the entire old snapshot. During cleanup previously retired
    /// entries can be absent and a captured file can remain in its own slot.
    fn check(&self, vault: &VaultDir, cleanup_slot: Option<&Path>) -> io::Result<bool> {
        let cleaning = cleanup_slot.is_some();
        let mut files_seen = 0;
        let mut directories_seen = 0;
        let file_slots = if let Some(slot) = cleanup_slot {
            self.files
                .iter()
                .map(|(path, stamp)| Ok((nested_capture(path, slot)?, (path, stamp))))
                .collect::<io::Result<BTreeMap<_, _>>>()?
        } else {
            BTreeMap::new()
        };
        let root = Path::new("");
        for path in std::iter::once(root).chain(self.directories.keys().map(PathBuf::as_path)) {
            if !path.as_os_str().is_empty() {
                if vault
                    .entry_kind(path)?
                    .is_some_and(|kind| kind != EntryKind::Directory)
                {
                    return Ok(false);
                }
                match vault.dir_identity(path)? {
                    Some(id) if self.directories[path] == id => directories_seen += 1,
                    None if cleaning => continue,
                    _ => return Ok(false),
                };
            }
            for entry in vault.open_dir(path)?.entries()? {
                let relative = path.join(entry?.file_name());
                if self.directories.contains_key(&relative) {
                    continue;
                }
                if let Some(expected) = self.files.get(&relative)
                    && file_matches(vault, &relative, expected)?
                {
                    files_seen += 1;
                    continue;
                }
                if let Some((original, expected)) = file_slots.get(&relative)
                    && vault.entry_kind(original)?.is_none()
                    && file_matches(vault, &relative, expected)?
                {
                    continue;
                }
                return Ok(false);
            }
        }
        Ok(cleaning
            || (files_seen == self.files.len() && directories_seen == self.directories.len()))
    }
}

fn nested_capture(path: &Path, package_slot: &Path) -> io::Result<PathBuf> {
    let mut hash = blake3::Hasher::new();
    hash.update(package_slot.as_os_str().as_encoded_bytes());
    hash.update(b"\0");
    hash.update(path.as_os_str().as_encoded_bytes());
    VaultDir::operation_slot(path, &hash.finalize().to_hex())
}

type RetainedCaptures = Vec<(PathBuf, PathBuf)>;

fn retire(vault: &VaultDir, slot: &Path, artifact: &Artifact) -> io::Result<RetainedCaptures> {
    let mut retained = Vec::new();
    match artifact {
        Artifact::File(stamp) => {
            if let Some(path) = vault.recovered_capture(slot)? {
                retained.push((slot.to_owned(), path));
            } else if let CaptureCleanup::Retained { path } = vault.clean_capture(slot, stamp)? {
                retained.push((slot.to_owned(), path));
            }
            let shared = vault.path_for_watcher().join(slot);
            if vault.entry_kind(slot)?.is_some()
                && !retained.iter().any(|(_, path)| *path == shared)
            {
                retained.push((slot.to_owned(), shared));
            }
        }
        Artifact::Tree(tree) => retire_tree(vault, slot, tree, &mut retained)?,
    }
    Ok(retained)
}

fn retire_tree(
    vault: &VaultDir,
    slot: &Path,
    tree: &TreeStamp,
    retained: &mut RetainedCaptures,
) -> io::Result<()> {
    // A restart after retiring the last child must still disclose files
    // that were parked before the final private journal update.
    for relative in tree.files.keys() {
        let child = slot.join(nested_capture(relative, slot)?);
        if let Some(path) = vault.recovered_capture(&child)? {
            retained.push((slot.join(relative), path));
        }
    }
    let retained_member = !retained.is_empty();
    let shared = vault.path_for_watcher().join(slot);
    let archive = match vault.retain_tree(slot) {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if archive == shared {
        // A cross-volume or busy capture still occupies the shared name.
        // No retirement step may delete anything under that name.
        retained.push((slot.to_owned(), archive));
        return Ok(());
    }
    if vault.entry_kind(slot)?.is_some() {
        retained.push((slot.to_owned(), shared));
    }
    // Darwin cannot establish the writer exclusion needed for retirement.
    // Preserve its whole displaced directory.
    if !retained_member
        && !cfg!(target_os = "macos")
        && let Some(captured) = vault.open_recovered_tree(slot)?
        && captured.root_identity() == tree.root
    {
        let retired = match retire_tree_members(&captured, tree, slot, retained) {
            Ok(retired) => retired,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock
                ) =>
            {
                false
            }
            Err(error) => return Err(error),
        };
        // The held Windows directory handle excludes delete sharing.
        drop(captured);
        if retired && vault.remove_recovered_empty_tree(slot, tree.root)? {
            return Ok(());
        }
    }
    retained.push((slot.to_owned(), archive));
    Ok(())
}

fn retire_tree_members(
    captured: &VaultDir,
    tree: &TreeStamp,
    package_slot: &Path,
    retained: &mut RetainedCaptures,
) -> io::Result<bool> {
    if !tree.check(captured, Some(package_slot))? {
        return Ok(false);
    }
    for (path, expected) in &tree.files {
        let saved = nested_capture(path, package_slot)?;
        if captured.entry_kind(path)?.is_some() {
            match captured.withdraw(path, &saved, expected)? {
                Withdrawal::Captured(_) | Withdrawal::Missing => {}
                Withdrawal::Conflict => return Ok(false),
            }
        }
        if captured.entry_kind(&saved)?.is_some()
            && let CaptureCleanup::Retained { path: archive } =
                captured.clean_capture(&saved, expected)?
        {
            if archive != captured.path_for_watcher().join(&saved) {
                retained.push((package_slot.join(path), archive));
            }
            // Preserve the remaining members once any captured file needs
            // operator review. In the original tree its name may now be a slot.
            return Ok(false);
        }
    }
    // Child directories precede their parents in reverse path order.
    for (path, expected) in tree.directories.iter().rev() {
        match captured.dir_identity(path)? {
            Some(id) if id == *expected => {
                if !remove_empty(captured, path)? {
                    return Ok(false);
                }
            }
            None => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn remove_empty(vault: &VaultDir, path: &Path) -> io::Result<bool> {
    match vault.remove_empty_dir(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{filesystem::ValidatedRoots, paths::digest};
    use notarium_core::{
        epoch::DataRoot,
        ids::{HistoryIncarnation, SpaceId, SpaceSeq},
    };
    use std::fs;

    fn fixture() -> (tempfile::TempDir, ValidatedRoots, VaultBinding) {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let vault_path = root.join("vault");
        fs::create_dir(&vault_path).unwrap();
        let roots =
            ValidatedRoots::open(&DataRoot::new(root.join("private")), Some(&vault_path)).unwrap();
        let binding = VaultBinding {
            scope: HistoryScope {
                space_id: SpaceId::from_bytes([1; 16]),
                incarnation: HistoryIncarnation::from_bytes([2; 16]),
            },
            generation: digest(b"fixture generation"),
            root_identity: file_identity(&roots.vault().unwrap().root_identity()),
            cursor: SpaceSeq::ZERO,
        };
        (directory, roots, binding)
    }

    #[test]
    fn schema_updates_and_preserves_manual_edits_and_unrelated_files() {
        let (_directory, roots, binding) = fixture();
        let vault = roots.vault().unwrap();
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        let schema = |bytes: &[u8]| {
            Some((
                Version::Schema(digest(bytes)),
                Material::Schema(bytes.to_vec()),
            ))
        };
        let target = Target::Schema;
        let path = target.path();
        let absolute = vault.path_for_watcher().join(&path);
        let other = absolute.with_file_name("untouched.md");
        state
            .update(vault, target.clone(), schema(b"initial"))
            .unwrap();
        fs::write(&other, "unrelated").unwrap();
        state
            .update(vault, target.clone(), schema(b"approved"))
            .unwrap();
        assert_eq!(fs::read(&absolute).unwrap(), b"approved");
        fs::write(&absolute, "external").unwrap();
        state.observe_reserved(vault, &path).unwrap();
        state
            .update(vault, target.clone(), schema(b"newer canonical"))
            .unwrap();
        state.update(vault, target, None).unwrap();
        assert_eq!(fs::read(&absolute).unwrap(), b"external");
        assert_eq!(fs::read(&other).unwrap(), b"unrelated");
        assert!(
            state
                .conflicts()
                .any(|issue| issue.path == path
                    && issue.kind == ReservedConflictKind::ExternalChange)
        );
    }

    fn package(revision_byte: u8) -> (Version, Material) {
        let version = Version::Ability(RevisionId::from_bytes([revision_byte; 16]));
        let dir = PathBuf::from("references");
        (
            version,
            Material::Ability(BTreeMap::from([
                (PathBuf::from("SKILL.md"), vec![revision_byte]),
                (dir.join("evidence.md"), vec![revision_byte, revision_byte]),
            ])),
        )
    }

    fn setup_exchange(vault: &VaultDir, state: &mut ReservedMaterials, target: &Target) -> PathBuf {
        state
            .update(vault, target.clone(), Some(package(3)))
            .unwrap();
        let slot =
            VaultDir::operation_slot(&target.path(), &random_digest().unwrap().to_hex()).unwrap();
        let (version, material) = package(4);
        let artifact = stage(vault, &target.path(), &slot, material).unwrap();
        let mut record = state.record(target);
        record.pending = Some(Pending::Ready {
            slot: slot.clone(),
            next: Some(Published { version, artifact }),
        });
        state.save(record).unwrap();
        slot
    }

    #[test]
    fn restart_finishes_an_applied_atomic_package_exchange() {
        let (_directory, roots, binding) = fixture();
        let vault = roots.vault().unwrap();
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        let target = Target::Ability(AbilityId::from_bytes([1; 16]));
        let path = target.path();
        let slot = setup_exchange(vault, &mut state, &target);
        vault.exchange_paths(&slot, &path).unwrap();
        drop(state);
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        state.recover(vault).unwrap();
        assert_eq!(vault.entry_kind(&slot).unwrap(), None);
        assert_eq!(
            state.conflicts().count(),
            usize::from(cfg!(target_os = "macos"))
        );
        assert_eq!(
            vault
                .read(&path.join("SKILL.md"), 8)
                .unwrap()
                .unwrap()
                .bytes,
            [4]
        );
        assert_eq!(
            vault
                .read(&path.join("references").join("evidence.md"), 8)
                .unwrap()
                .unwrap()
                .bytes,
            [4, 4]
        );
        state.update(vault, target, None).unwrap();
        assert_eq!(vault.entry_kind(&path).unwrap(), None);
    }

    #[test]
    fn restart_checks_fresh_authority_before_publishing_an_unapplied_package() {
        let (_directory, roots, binding) = fixture();
        let vault = roots.vault().unwrap();
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        let target = Target::Ability(AbilityId::from_bytes([4; 16]));
        let path = target.path();
        let slot = setup_exchange(vault, &mut state, &target);
        drop(state);

        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        state.recover(vault).unwrap();
        assert_eq!(vault.entry_kind(&slot).unwrap(), None);
        assert_eq!(
            vault
                .read(&path.join("SKILL.md"), 8)
                .unwrap()
                .unwrap()
                .bytes,
            [3]
        );
        // The host determined that the package is no longer visible.
        state.update(vault, target, None).unwrap();
        assert_eq!(vault.entry_kind(&path).unwrap(), None);
    }

    #[test]
    fn restart_preserves_an_unverified_stage_and_rebuilds_from_the_current_revision() {
        let (_directory, roots, binding) = fixture();
        let vault = roots.vault().unwrap();
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        let target = Target::Ability(AbilityId::from_bytes([3; 16]));
        let path = target.path();
        state
            .update(vault, target.clone(), Some(package(3)))
            .unwrap();
        let slot = VaultDir::operation_slot(&path, &random_digest().unwrap().to_hex()).unwrap();
        let mut before = state.record(&target);
        before.pending = Some(Pending::Staging { slot: slot.clone() });
        state.save(before).unwrap();
        vault.create_dir(&slot).unwrap();
        fs::write(
            vault.path_for_watcher().join(&slot).join("SKILL.md"),
            b"partial",
        )
        .unwrap();
        drop(state);

        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        state.recover(vault).unwrap();
        assert_eq!(
            vault
                .read(&path.join("SKILL.md"), 8)
                .unwrap()
                .unwrap()
                .bytes,
            [3]
        );
        state.update(vault, target, Some(package(4))).unwrap();
        assert_eq!(
            vault
                .read(&path.join("SKILL.md"), 8)
                .unwrap()
                .unwrap()
                .bytes,
            [4]
        );
        assert_eq!(
            vault
                .read(&slot.join("SKILL.md"), 8)
                .unwrap()
                .unwrap()
                .bytes,
            b"partial"
        );
        assert!(state.conflicts().any(|issue| {
            issue.path == slot && issue.kind == ReservedConflictKind::IncompleteStage
        }));
    }

    #[test]
    fn stages_never_erase_the_tree_saved_by_a_racing_editor() {
        let (_directory, roots, binding) = fixture();
        let vault = roots.vault().unwrap();
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        let target = Target::Ability(AbilityId::from_bytes([2; 16]));
        let path = target.path();
        let slot = setup_exchange(vault, &mut state, &target);
        // Simulate a write after the last source verification, followed by the
        // namespace exchange and a stop before the private journal is updated.
        fs::write(
            vault.path_for_watcher().join(&path).join("SKILL.md"),
            b"my edit",
        )
        .unwrap();
        vault.exchange_paths(&slot, &path).unwrap();
        drop(state);
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        state.recover(vault).unwrap();
        let archive = state
            .conflicts()
            .find(|issue| issue.path == slot && issue.kind == ReservedConflictKind::RetainedCapture)
            .and_then(|issue| issue.preserved_path.clone())
            .expect("the previous whole tree is retained");
        assert!(archive.starts_with(roots.data_root().root()));
        assert_eq!(fs::read(archive.join("SKILL.md")).unwrap(), b"my edit");
        assert_eq!(
            fs::read(archive.join("references").join("evidence.md")).unwrap(),
            [3, 3]
        );
        assert_eq!(
            vault
                .read(&path.join("SKILL.md"), 64)
                .unwrap()
                .unwrap()
                .bytes,
            [4]
        );
        state.update(vault, target, Some(package(5))).unwrap();
        assert_eq!(
            vault
                .read(&path.join("SKILL.md"), 64)
                .unwrap()
                .unwrap()
                .bytes,
            [5]
        );
        assert_eq!(fs::read(archive.join("SKILL.md")).unwrap(), b"my edit");
        drop(state);
        let state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        assert!(
            state
                .conflicts()
                .any(|issue| issue.preserved_path.as_ref() == Some(&archive))
        );
    }

    #[test]
    fn restart_reports_a_whole_tree_parked_before_acknowledgement() {
        let (_directory, roots, binding) = fixture();
        let vault = roots.vault().unwrap();
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        let target = Target::Ability(AbilityId::from_bytes([5; 16]));
        let path = target.path();
        let slot = setup_exchange(vault, &mut state, &target);
        vault.exchange_paths(&slot, &path).unwrap();
        fs::write(
            vault.path_for_watcher().join(&slot).join("SKILL.md"),
            b"retained edit",
        )
        .unwrap();
        let mut before = state.record(&target);
        let Pending::Ready { next, .. } = before.pending.take().unwrap() else {
            panic!("fixture must reach the prepared package");
        };
        let displaced = before.current.replace(next.unwrap()).unwrap().artifact;
        before.pending = Some(Pending::Cleanup {
            slot: slot.clone(),
            displaced,
        });
        state.save(before).unwrap();
        let archive = vault.retain_tree(&slot).unwrap();
        drop(state);

        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        state.recover(vault).unwrap();
        assert!(
            state
                .conflicts()
                .any(|issue| issue.path == slot && issue.preserved_path.as_ref() == Some(&archive))
        );
        assert_eq!(
            fs::read(archive.join("SKILL.md")).unwrap(),
            b"retained edit"
        );
        assert_eq!(
            fs::read(archive.join("references").join("evidence.md")).unwrap(),
            [3, 3]
        );
        state.update(vault, target, Some(package(5))).unwrap();
        assert_eq!(
            vault
                .read(&path.join("SKILL.md"), 8)
                .unwrap()
                .unwrap()
                .bytes,
            [5]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn open_schema_writer_is_retained_without_blocking_later_publication() {
        use std::io::Write;

        let (_directory, roots, binding) = fixture();
        let vault = roots.vault().unwrap();
        let mut state = ReservedMaterials::open(roots.private_dir(), &binding).unwrap();
        let schema = |bytes: &[u8]| {
            Some((
                Version::Schema(digest(bytes)),
                Material::Schema(bytes.to_vec()),
            ))
        };
        let target = Target::Schema;
        let path = target.path();
        state
            .update(vault, target.clone(), schema(b"first"))
            .unwrap();
        let mut editor = fs::OpenOptions::new()
            .write(true)
            .open(vault.path_for_watcher().join(&path))
            .unwrap();
        state
            .update(vault, target.clone(), schema(b"second"))
            .unwrap();
        let retained = state
            .conflicts()
            .find(|issue| issue.kind == ReservedConflictKind::RetainedCapture)
            .and_then(|issue| issue.preserved_path.clone())
            .expect("open writer must retain its inode");
        editor.write_all(b"saved").unwrap();
        drop(editor);
        assert_eq!(fs::read(&retained).unwrap(), b"saved");
        state.update(vault, target, schema(b"third")).unwrap();
        assert_eq!(vault.read(&path, 8).unwrap().unwrap().bytes, b"third");
        assert_eq!(fs::read(&retained).unwrap(), b"saved");
    }
}
