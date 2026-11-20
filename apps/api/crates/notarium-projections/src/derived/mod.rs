//! Rebuildable card, lookup, and publication storage for one projection generation.

use std::sync::Arc;

use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{
        ChatThreadId, ContentDigest, NoteId, ProjectionGeneration, SpaceSeq, ThreadEntrySeq,
        ViewKey,
    },
    model::HistoryScope,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

mod card;
mod control;
mod erasure;
mod lookup;
mod maintenance;
mod read;
mod records;
mod replay;
mod schema;
mod sql;
mod staging;
mod write;

pub use control::{GenerationControl, GenerationDescriptor};
pub(crate) use erasure::{ErasureOutcome, PostgresEraser};
pub(crate) use lookup::{LinkAddress, LinkPosition};
pub(crate) use maintenance::{GenerationFiles, PostgresCacheOwner};
pub(crate) use read::GroupRankRange;
pub(crate) use records::decode as decode_payload;
pub use records::{
    CandidateLookupKey, ProjectedChatRef, ProjectedChatThread, ProjectedCluster, ProjectedFolder,
    ProjectedFolderAlias, ProjectedLink, ProjectedNote, ProjectedNoteAlias, ProjectedQueryRow,
    ProjectedViewDescriptor, ProjectedViewRank, ProjectionSchema, ProjectionWatermark,
    TrustedCheckpoint,
};
pub(crate) use staging::{MAX_STAGE_BYTES, StageBuffer, approx_mutation_bytes};

use sql::Database;

#[cfg(test)]
#[derive(Default)]
struct RankReadWork {
    positions: usize,
    targets: usize,
}

/// Access to the derived database of a single generation. Canonical state and
/// private staging are never attached to a reader's connection.
#[derive(Clone)]
pub struct DerivedStore {
    #[cfg(test)]
    pub(crate) folder_page_reads: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    pub(crate) reverse_link_reads: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    rank_read_work: Arc<std::sync::Mutex<RankReadWork>>,
    database: Arc<Database>,
    generation: ProjectionGeneration,
    cache_lease: Option<Arc<std::fs::File>>,
    _schema_lease: Option<Arc<maintenance::PostgresSchemaLease>>,
}

impl DerivedStore {
    /// Group positions returned and target IDs supplied to physical rank queries.
    #[cfg(test)]
    pub(crate) fn take_rank_read_work(&self) -> (usize, usize) {
        let work = std::mem::take(&mut *self.rank_read_work.lock().unwrap());
        (work.positions, work.targets)
    }
    /// Take the number of real SQLite read transactions and 128-step VM progress callbacks.
    #[cfg(test)]
    pub(crate) fn take_sqlite_read_work(&self) -> (usize, usize) {
        self.database.sqlite_read_work()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn open_sqlite(
        root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Self, PortError> {
        Self::open_sqlite_for_runtime(root, generation)
            .await?
            .ok_or_else(schema::generation_mismatch)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn open_postgres(
        pool: PgPool,
        schema_prefix: &str,
        generation: ProjectionGeneration,
    ) -> Result<Self, PortError> {
        Self::open_postgres_for_runtime(pool, schema_prefix, generation)
            .await?
            .ok_or_else(schema::generation_mismatch)
    }

    pub(crate) async fn open_sqlite_for_runtime(
        root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Option<Self>, PortError> {
        let lease = GenerationFiles::hold(root, generation).await?;
        let database = Database::open_sqlite(root.derived(generation)).await?;
        Self::init(database, generation, Some(lease), None).await
    }

    pub(crate) async fn open_postgres_for_runtime(
        pool: PgPool,
        schema_prefix: &str,
        generation: ProjectionGeneration,
    ) -> Result<Option<Self>, PortError> {
        sql::validate_schema_prefix(schema_prefix)?;
        let schema = format!("{schema_prefix}_g{}", generation.get());
        let schema_lease = maintenance::PostgresSchemaLease::acquire(&schema);
        let database = Database::open_postgres(pool, &schema).await?;
        Self::init(database, generation, None, Some(schema_lease)).await
    }

    async fn init(
        database: Database,
        generation: ProjectionGeneration,
        cache_lease: Option<Arc<std::fs::File>>,
        schema_lease: Option<Arc<maintenance::PostgresSchemaLease>>,
    ) -> Result<Option<Self>, PortError> {
        let database = Arc::new(database);
        let compatible = database
            .write(false, move |mut tx| {
                Box::pin(async move { schema::initialize(&mut tx, generation).await })
            })
            .await?;
        Ok(compatible.then_some(Self {
            #[cfg(test)]
            folder_page_reads: Default::default(),
            #[cfg(test)]
            reverse_link_reads: Default::default(),
            #[cfg(test)]
            rank_read_work: Default::default(),
            database,
            generation,
            cache_lease,
            _schema_lease: schema_lease,
        }))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn generation_control(
        &self,
        cache_root: &DataRoot,
    ) -> Result<GenerationControl, PortError> {
        if let Some((pool, schema)) = self.database.postgres_config() {
            let (prefix, generation) = schema.rsplit_once("_g").ok_or_else(invalid_row)?;
            if generation.parse::<u64>().ok() != Some(self.generation.get()) {
                return Err(invalid_row());
            }
            return GenerationControl::open_postgres(pool, prefix).await;
        }
        let actual = self.database.sqlite_path().ok_or_else(invalid_row)?;
        let expected = cache_root.derived(self.generation);
        let (actual, expected) = tokio::try_join!(
            tokio::fs::canonicalize(actual),
            tokio::fs::canonicalize(expected),
        )
        .map_err(|_| schema::generation_mismatch())?;
        if actual != expected {
            return Err(schema::generation_mismatch());
        }
        GenerationControl::open_sqlite(cache_root).await
    }

    /// Opens a generation in the same derived installation.
    pub async fn related_generation(
        &self,
        cache_root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Self, PortError> {
        self.related_generation_for_runtime(cache_root, generation)
            .await?
            .ok_or_else(schema::generation_mismatch)
    }

    pub(crate) async fn related_generation_for_runtime(
        &self,
        cache_root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Option<Self>, PortError> {
        if let Some((pool, schema)) = self.database.postgres_config() {
            let (prefix, _) = schema.rsplit_once("_g").ok_or_else(invalid_row)?;
            if let Some(store) = Self::open_postgres_for_runtime(pool, prefix, generation).await? {
                return Ok(Some(store.with_cache_lease(cache_root).await?));
            }
            return Ok(None);
        }
        Self::open_sqlite_for_runtime(cache_root, generation).await
    }

    pub(crate) async fn with_cache_lease(mut self, root: &DataRoot) -> Result<Self, PortError> {
        if self.cache_lease.is_none() {
            self.cache_lease = Some(GenerationFiles::hold(root, self.generation).await?);
        }
        Ok(self)
    }

    pub(crate) fn cache_lease(&self) -> Result<Arc<std::fs::File>, PortError> {
        self.cache_lease.clone().ok_or_else(invalid_row)
    }

    /// Includes retired or cancelled generations with durable derived data.
    pub async fn related_generations(
        &self,
        cache_root: &DataRoot,
    ) -> Result<Vec<ProjectionGeneration>, PortError> {
        let mut generations = if let Some((pool, schema)) = self.database.postgres_config() {
            let (prefix, _) = schema.rsplit_once("_g").ok_or_else(invalid_row)?;
            erasure::postgres_generation_inventory(&pool, prefix).await?
        } else {
            let root = cache_root.root().join("v1");
            tokio::task::spawn_blocking(move || {
                let mut generations = Vec::new();
                let entries = std::fs::read_dir(root)
                    .map_err(|_| internal("projection_generation_directory"))?;
                for entry in entries {
                    let entry = entry.map_err(|_| internal("projection_generation_directory"))?;
                    if !entry
                        .file_type()
                        .map_err(|_| internal("projection_generation_directory"))?
                        .is_dir()
                        || !entry.path().join("derived.sqlite").is_file()
                    {
                        continue;
                    }
                    let name = entry.file_name();
                    if let Some(generation) = name
                        .to_str()
                        .and_then(|name| parse_generation("derived_gen_", name))
                    {
                        generations.push(generation);
                    }
                }
                Ok::<_, PortError>(generations)
            })
            .await
            .map_err(|_| internal("projection_generation_worker"))??
        };
        generations.sort_unstable();
        Ok(generations)
    }

    pub fn generation(&self) -> ProjectionGeneration {
        self.generation
    }
}

/// Durable compare-and-set for one complete canonical command or seed.
#[derive(Clone, Debug)]
pub struct SpaceApply {
    pub expected: Option<SpaceSeq>,
    pub watermark: ProjectionWatermark,
    pub mutations: Vec<DerivedMutation>,
}

/// Logical command key for bounded multi-page staging (used by Cold Seed and
/// very large batches). Neither staging pages nor replaying a page changes the
/// visible watermark.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StageKey {
    pub scope: HistoryScope,
    pub first: SpaceSeq,
    pub last: SpaceSeq,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DerivedMutation {
    UpsertNote(Box<ProjectedNote>),
    UpsertFolder(ProjectedFolder),
    UpsertNoteAlias(ProjectedNoteAlias),
    UpsertFolderAlias(ProjectedFolderAlias),
    UpsertViewDescriptor(ProjectedViewDescriptor),
    UpsertViewRank(ProjectedViewRank),
    UpsertCandidate(CandidateLookupKey),
    UpsertLink(ProjectedLink),
    UpsertChatThread(ProjectedChatThread),
    UpsertChatRef(ProjectedChatRef),
    UpsertCluster(ProjectedCluster),
    DeleteNoteCandidates(u32),
    DeleteNoteLinks(u32),
    DeleteLink(u32, u32),
    DeleteDescriptors(NoteId),
    DeleteRank(NoteId, ViewKey, NoteId),
    DeleteClusters,
    PurgeNote(NoteId),
    RedactChatEntry(ChatThreadId, ThreadEntrySeq),
    InvalidateCheckpointClusters,
}

fn parse_generation(prefix: &str, value: &str) -> Option<ProjectionGeneration> {
    let suffix = value.strip_prefix(prefix)?;
    let generation = suffix.parse::<u64>().ok()?;
    if suffix != generation.to_string() {
        return None;
    }
    ProjectionGeneration::new(generation).ok()
}

fn invalid_row() -> PortError {
    internal("projection_store_invalid_row")
}

fn internal(label: &'static str) -> PortError {
    PortError::Internal(failure(label, CommitEffect::NotCommitted))
}

fn failure(label: &'static str, effect: CommitEffect) -> OperationalFailure {
    OperationalFailure::new(
        ContentDigest::from_bytes(*blake3::hash(label.as_bytes()).as_bytes()),
        effect,
        RetryAdvice::Never,
        false,
    )
    .expect("static failure classification")
}

fn deadline() -> PortError {
    PortError::DeadlineExceeded(failure(
        "projection_store_read_timeout",
        CommitEffect::NotCommitted,
    ))
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

fn mismatch() -> PortError {
    DomainError::validation(ValidationReason::HistoryIncarnationMismatch).into()
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}

#[cfg(test)]
mod tests;
