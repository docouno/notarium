//! One local layout and a fail-closed classifier over observations supplied by adapters.
use crate::ids::{ContentDigest, InstallationId, ProjectionGeneration, SpaceId, SpaceSeq};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SUPPORTED_V1_EPOCH: u32 = 1;
pub const CLOUD_CONTROL_SCHEMA: &str = "v1_control";
pub const CLOUD_CANONICAL_SCHEMA: &str = "v1_canonical";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataRoot(PathBuf);
impl DataRoot {
    /// The application selects and checks the root. These helpers never inspect it.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self(root.into())
    }
    pub fn root(&self) -> &Path {
        &self.0
    }
    pub fn control(&self) -> PathBuf {
        self.0.join("v1/control.sqlite")
    }
    pub fn canonical(&self) -> PathBuf {
        self.0.join("v1/canonical.sqlite")
    }
    pub fn manifest(&self) -> PathBuf {
        self.0.join("v1-epoch.json")
    }
    pub fn blob(&self, space: &SpaceId, digest: ContentDigest) -> PathBuf {
        let hex = digest.to_hex();
        self.0
            .join("blobs")
            .join(space.as_str())
            .join(&hex[..2])
            .join(format!("{hex}.zst"))
    }
    pub fn derived(&self, generation: ProjectionGeneration) -> PathBuf {
        self.0
            .join("v1")
            .join(format!("derived_gen_{}", generation.get()))
            .join("derived.sqlite")
    }
    pub fn space_fast_index_dir(
        &self,
        generation: ProjectionGeneration,
        space: &SpaceId,
    ) -> PathBuf {
        self.derived(generation)
            .with_file_name("spaces")
            .join(space.as_str())
    }
    pub fn space_fast_index(
        &self,
        generation: ProjectionGeneration,
        space: &SpaceId,
        seq: SpaceSeq,
    ) -> PathBuf {
        self.space_fast_index_dir(generation, space)
            .join(format!("fast_index_{}.mmap", seq.get()))
    }
    pub fn active_projection_generation(&self) -> PathBuf {
        self.0.join("v1/active_projection_generation.json")
    }
    pub fn search(&self, space: &SpaceId, index: SearchIndexKind) -> PathBuf {
        self.0
            .join("v1/search")
            .join(space.as_str())
            .join(match index {
                SearchIndexKind::Tantivy => "tantivy",
                SearchIndexKind::Vector => "vector",
            })
    }
    pub fn keyring(&self) -> PathBuf {
        self.0.join("secret-keyring")
    }
    pub fn staging(&self) -> PathBuf {
        self.0.join("staging/artifacts")
    }
    pub fn migration_receipt(&self) -> PathBuf {
        self.0.join("migration-receipt.json")
    }
    pub fn migration_journal(&self) -> PathBuf {
        self.0.join("v1-migration-journal.json")
    }
    pub fn migration_lock(&self) -> PathBuf {
        self.0.join("v1-migration.lock")
    }
    pub fn sidecar_lock(&self) -> PathBuf {
        self.0.join("sidecar.lock")
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchIndexKind {
    Tantivy,
    Vector,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ReadyState {
    #[serde(rename = "V1_READY")]
    V1Ready,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EpochManifestV1 {
    pub epoch_version: u32,
    pub installation_id: InstallationId,
    pub state: ReadyState,
    pub receipt_sha256: Option<ContentDigest>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageEpochState {
    V1Ready,
    CorruptOrDowngrade,
    V0MigrationInterrupted,
    V0Detected,
    EmptyRoot,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EpochReason {
    ConsistentV1,
    InterruptedMigration,
    LegacyDetected,
    ConfirmedEmpty,
    UnreadableOrInvalid,
    UnsupportedEpoch,
    InstallationMismatch,
    IncompleteV1,
    MissingKeyring,
    InvalidMigrationWitness,
    UnrecognizedEntries,
    IncompleteObservation,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EpochClassification {
    pub state: StorageEpochState,
    pub reason: EpochReason,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MarkerObservation<T> {
    Missing,
    Present(T),
    Unreadable,
    Invalid,
}
impl<T> MarkerObservation<T> {
    fn invalid(&self) -> bool {
        matches!(self, Self::Unreadable | Self::Invalid)
    }
    fn present(&self) -> Option<&T> {
        if let Self::Present(value) = self {
            Some(value)
        } else {
            None
        }
    }
    fn missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DatabaseState {
    Migrating,
    Ready,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DatabaseWitness {
    pub epoch_version: u32,
    pub installation_id: InstallationId,
    pub state: DatabaseState,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationWitness {
    pub epoch_version: u32,
    pub installation_id: InstallationId,
    pub completed: bool,
    pub receipt_sha256: Option<ContentDigest>,
}

/// Missing is an observed absence. An incomplete directory scan is never emptiness.
#[derive(Clone, Debug)]
pub struct StorageEpochFacts {
    pub manifest: MarkerObservation<EpochManifestV1>,
    pub control: MarkerObservation<DatabaseWitness>,
    pub canonical: MarkerObservation<DatabaseWitness>,
    pub migration: MarkerObservation<MigrationWitness>,
    pub keyring: MarkerObservation<InstallationId>,
    pub key_rows_exist: bool,
    pub legacy: MarkerObservation<()>,
    pub has_unrecognized_entries: bool,
    pub observation_complete: bool,
}

pub fn classify(facts: &StorageEpochFacts) -> EpochClassification {
    use EpochReason as R;
    use StorageEpochState as S;
    let corrupt = |reason| EpochClassification {
        state: S::CorruptOrDowngrade,
        reason,
    };
    if facts.manifest.invalid()
        || facts.control.invalid()
        || facts.canonical.invalid()
        || facts.migration.invalid()
        || facts.keyring.invalid()
        || facts.legacy.invalid()
    {
        return corrupt(R::UnreadableOrInvalid);
    }
    if !facts.observation_complete {
        return corrupt(R::IncompleteObservation);
    }
    let manifest = facts.manifest.present();
    let control = facts.control.present();
    let canonical = facts.canonical.present();
    let migration = facts.migration.present();
    let versions = manifest
        .map(|m| m.epoch_version)
        .into_iter()
        .chain(control.map(|m| m.epoch_version))
        .chain(canonical.map(|m| m.epoch_version))
        .chain(migration.map(|m| m.epoch_version));
    if versions.into_iter().any(|v| v != SUPPORTED_V1_EPOCH) {
        return corrupt(R::UnsupportedEpoch);
    }
    let mut identities = manifest
        .map(|m| &m.installation_id)
        .into_iter()
        .chain(control.map(|m| &m.installation_id))
        .chain(canonical.map(|m| &m.installation_id))
        .chain(migration.map(|m| &m.installation_id))
        .chain(facts.keyring.present());
    if let Some(first) = identities.next()
        && identities.any(|other| first != other)
    {
        return corrupt(R::InstallationMismatch);
    }
    if facts.key_rows_exist && facts.keyring.missing() {
        return corrupt(R::MissingKeyring);
    }
    if let Some(m) = manifest {
        if !control.is_some_and(|d| d.state == DatabaseState::Ready)
            || !canonical.is_some_and(|d| d.state == DatabaseState::Ready)
        {
            return corrupt(R::IncompleteV1);
        }
        if let Some(journal) = migration {
            if !journal.completed
                || journal.receipt_sha256.is_none()
                || journal.receipt_sha256 != m.receipt_sha256
            {
                return corrupt(R::InvalidMigrationWitness);
            }
        } else if m.receipt_sha256.is_some() {
            return corrupt(R::InvalidMigrationWitness);
        }
        return EpochClassification {
            state: S::V1Ready,
            reason: R::ConsistentV1,
        };
    }
    if let Some(journal) = migration {
        // A validated unfinished migration owns its partial target. A published ready
        // database without the final marker is only legitimate under that journal.
        if journal.completed || journal.receipt_sha256.is_some() || facts.legacy.missing() {
            return corrupt(R::InvalidMigrationWitness);
        }
        return EpochClassification {
            state: S::V0MigrationInterrupted,
            reason: R::InterruptedMigration,
        };
    }
    if control.is_some()
        || canonical.is_some()
        || facts.keyring.present().is_some()
        || facts.key_rows_exist
    {
        return corrupt(R::IncompleteV1);
    }
    if facts.legacy.present().is_some() {
        return EpochClassification {
            state: S::V0Detected,
            reason: R::LegacyDetected,
        };
    }
    if facts.has_unrecognized_entries {
        return corrupt(R::UnrecognizedEntries);
    }
    EpochClassification {
        state: S::EmptyRoot,
        reason: R::ConfirmedEmpty,
    }
}
