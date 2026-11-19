use std::sync::{Arc, Weak, atomic::Ordering};

use notarium_canonical::{ProjectionErasures, ProjectionVisibilityCleanup};
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::{ProjectionGeneration, SpaceSeq},
    model::HistoryScope,
    ports::PortFuture,
};

use crate::{
    derived::{
        DerivedStore, GenerationControl, GenerationFiles, PostgresCacheOwner, PostgresEraser,
    },
    mmap::{BaseIndexHandle, IndexIdentity, discard_abandoned_temp},
};

use super::{GenerationCleanup, ProjectionEngine, checkpoint_error};

pub(super) struct Eraser {
    engine: Weak<ProjectionEngine>,
    postgres: Option<PostgresEraser>,
    root: DataRoot,
    generation_cleanup: Arc<GenerationCleanup>,
    postgres_cache_owner: Option<Arc<PostgresCacheOwner>>,
}

impl Eraser {
    pub(super) fn new(engine: &Arc<ProjectionEngine>) -> Result<Self, PortError> {
        Ok(Self {
            engine: Arc::downgrade(engine),
            postgres: engine
                .generation
                .load()
                .store
                .postgres_eraser(&engine.control)?,
            root: engine.cache_root.clone(),
            generation_cleanup: Arc::clone(&engine.generation_cleanup),
            postgres_cache_owner: engine.postgres_cache_owner.clone(),
        })
    }
}

impl ProjectionVisibilityCleanup for Eraser {
    fn erase_visibility<'a>(&'a self, erasures: &'a ProjectionErasures) -> PortFuture<'a, ()> {
        Box::pin(async move {
            if let Some(engine) = self.engine.upgrade() {
                return engine
                    .erase_committed_visibility(self.postgres.as_ref(), erasures)
                    .await;
            }
            let _maintenance = self.generation_cleanup.lock().await;
            if let Some(postgres) = &self.postgres {
                return erase_postgres_visibility(
                    postgres,
                    &self.root,
                    self.postgres_cache_owner.as_ref(),
                    erasures,
                )
                .await;
            }
            erase_offline_sqlite(&self.root, erasures).await
        })
    }
}

impl ProjectionEngine {
    /// Recover the markers for the exact generation and history being built.
    pub(super) async fn hydrate_erasure(
        &self,
        store: &DerivedStore,
        erasures: &ProjectionErasures,
    ) -> Result<(), PortError> {
        let _maintenance = self.generation_cleanup.lock().await;
        let redacted = erasures
            .redacted
            .iter()
            .map(|row| (row.thread.clone(), row.entry))
            .collect::<Vec<_>>();
        store
            .erase_visibility(
                &erasures.scope,
                erasures.through,
                &erasures.purged,
                &redacted,
            )
            .await?;
        if !erasures.purged.is_empty() {
            let slot = self.generation_slot(store.generation(), &erasures.scope.space_id);
            let sweep = slot
                .as_ref()
                .is_some_and(|slot| !slot.ever_published.load(Ordering::Acquire));
            erase_scoped_checkpoints(
                &self.cache_root,
                store.generation(),
                &erasures.scope,
                erasures.through,
                self.postgres_cache_owner.as_ref(),
                sweep,
            )
            .await?;
        }
        Ok(())
    }

    async fn erase_committed_visibility(
        &self,
        postgres: Option<&PostgresEraser>,
        erasures: &ProjectionErasures,
    ) -> Result<(), PortError> {
        let _maintenance = self.generation_cleanup.lock().await;
        let purging = !erasures.purged.is_empty();
        if let Some(postgres) = postgres {
            erase_postgres_visibility(
                postgres,
                &self.cache_root,
                self.postgres_cache_owner.as_ref(),
                erasures,
            )
            .await?;
        } else {
            let generations = self
                .known_generations
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let active = self.generation.load_full();
            for id in active.store.related_generations(&self.cache_root).await? {
                let resident = generations.get(&id);
                let store = match resident {
                    Some(generation) => Some(generation.store.clone()),
                    None => {
                        active
                            .store
                            .related_generation_for_runtime(&self.cache_root, id)
                            .await?
                    }
                };
                let Some(store) = store else {
                    self.remove_closed_local_generation(id).await?;
                    continue;
                };
                let (scope, through) = store.erase_committed_visibility(erasures).await?;
                drop(store);
                if purging {
                    if resident.is_some() {
                        erase_scoped_checkpoints(&self.cache_root, id, &scope, through, None, true)
                            .await?;
                    } else {
                        erase_closed_checkpoints(&self.cache_root, id, &scope, through).await?;
                    }
                }
            }
        }
        if purging {
            let generations = self
                .known_generations
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            for generation in generations.values() {
                if let Some(slot) = generation.slot(&erasures.scope.space_id)
                    && let Some(cut) = slot.cut.load_full()
                    && cut.cut.scope == erasures.scope
                    && (cut.cut.projected_seq < erasures.through || cut.base.repair_pending())
                {
                    slot.clear_if_current(&cut);
                    self.pool.evict(&cut.base);
                    slot.repair.notify_one();
                }
            }
            self.reads.invalidate_history(&erasures.scope);
            self.scrub_space_events(&erasures.scope.space_id);
        }
        Ok(())
    }

    async fn remove_closed_local_generation(
        &self,
        generation: ProjectionGeneration,
    ) -> Result<(), PortError> {
        if self
            .control
            .active()
            .await?
            .is_none_or(|active| active.generation <= generation)
            || self
                .control
                .candidate()
                .await?
                .is_some_and(|candidate| candidate.generation == generation)
        {
            return Err(not_ready());
        }
        let lease = GenerationFiles::for_reclamation(&self.cache_root, generation)
            .await?
            .ok_or_else(not_ready)?;
        GenerationFiles::remove(&self.cache_root, generation, false, lease).await
    }
}

async fn erase_postgres_visibility(
    postgres: &PostgresEraser,
    root: &DataRoot,
    cache_owner: Option<&Arc<PostgresCacheOwner>>,
    erasures: &ProjectionErasures,
) -> Result<(), PortError> {
    let affected = postgres.erase(root, erasures).await?;
    if erasures.purged.is_empty() {
        return Ok(());
    }
    // The reconciled SQL guard gives the exact erased history and floor.
    // Durable retirement supplies the writer exclusion for missing SQL.
    let retired = affected
        .retired
        .into_iter()
        .map(|generation| (generation, erasures.scope.clone(), erasures.through));
    for (generation, scope, through) in affected.reconciled.into_iter().chain(retired) {
        erase_scoped_checkpoints(root, generation, &scope, through, cache_owner, true).await?;
    }
    Ok(())
}

async fn erase_offline_sqlite(
    root: &DataRoot,
    erasures: &ProjectionErasures,
) -> Result<(), PortError> {
    let purging = !erasures.purged.is_empty();
    let control = GenerationControl::open_sqlite(root).await?;
    for id in GenerationFiles::inventory(root).await? {
        if !root.derived(id).exists() {
            if purging {
                erase_closed_checkpoints(root, id, &erasures.scope, erasures.through).await?;
            }
            continue;
        }
        let store = DerivedStore::open_sqlite_for_runtime(root, id).await?;
        let Some(store) = store else {
            if control
                .active()
                .await?
                .is_none_or(|active| active.generation <= id)
                || control
                    .candidate()
                    .await?
                    .is_some_and(|candidate| candidate.generation == id)
            {
                return Err(not_ready());
            }
            let lease = GenerationFiles::for_reclamation(root, id)
                .await?
                .ok_or_else(not_ready)?;
            GenerationFiles::remove(root, id, false, lease).await?;
            continue;
        };
        let (scope, through) = store.erase_committed_visibility(erasures).await?;
        drop(store);
        if purging {
            erase_closed_checkpoints(root, id, &scope, through).await?;
        }
    }
    Ok(())
}

async fn erase_scoped_checkpoints(
    root: &DataRoot,
    generation: ProjectionGeneration,
    scope: &HistoryScope,
    through: SpaceSeq,
    cache_owner: Option<&Arc<PostgresCacheOwner>>,
    sweep: bool,
) -> Result<(), PortError> {
    let root = root.clone();
    let scope = scope.clone();
    let cache_owner = cache_owner.cloned();
    tokio::task::spawn_blocking(move || {
        // This operation can continue after its caller is cancelled.
        let _cache_owner = cache_owner;
        retire_registered(&root, generation, &scope, through)?;
        if sweep {
            erase_checkpoint_files(&root, generation, &scope, through)?;
        }
        Ok(())
    })
    .await
    .map_err(checkpoint_error)?
}

async fn erase_closed_checkpoints(
    root: &DataRoot,
    generation: ProjectionGeneration,
    scope: &HistoryScope,
    through: SpaceSeq,
) -> Result<(), PortError> {
    let retire_root = root.clone();
    let retire_scope = scope.clone();
    tokio::task::spawn_blocking(move || {
        retire_registered(&retire_root, generation, &retire_scope, through)
    })
    .await
    .map_err(checkpoint_error)??;
    let cache = root.clone();
    let erased_scope = scope.clone();
    GenerationFiles::with_exclusive_reclamation(root, generation, move || {
        erase_checkpoint_files(&cache, generation, &erased_scope, through)
    })
    .await?;
    Ok(())
}

fn retire_registered(
    root: &DataRoot,
    generation: ProjectionGeneration,
    scope: &HistoryScope,
    through: SpaceSeq,
) -> Result<(), PortError> {
    let directory = root.space_fast_index_dir(generation, &scope.space_id);
    BaseIndexHandle::purge_registered(&directory, generation, scope, through)
        .map_err(checkpoint_error)
}

fn erase_checkpoint_files(
    root: &DataRoot,
    generation: ProjectionGeneration,
    scope: &HistoryScope,
    through: SpaceSeq,
) -> Result<(), PortError> {
    let directory = root.space_fast_index_dir(generation, &scope.space_id);
    let paths = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(checkpoint_error(error)),
    };
    for entry in paths {
        let entry = entry.map_err(checkpoint_error)?;
        let name = entry.file_name();
        let seq = name
            .to_str()
            .and_then(|name| name.strip_prefix("fast_index_"))
            .and_then(|name| name.strip_suffix(".mmap"))
            .and_then(|seq| seq.parse::<u64>().ok())
            .and_then(|seq| SpaceSeq::new(seq).ok());
        if let Some(seq) = seq.filter(|&seq| seq < through) {
            let identity = IndexIdentity {
                generation,
                scope: scope.clone(),
                seq,
            };
            BaseIndexHandle::discard_unleased_matching(&entry.path(), &identity)
                .map_err(checkpoint_error)?;
        } else {
            discard_abandoned_temp(&entry.path(), generation, scope, through)
                .map_err(checkpoint_error)?;
        }
    }
    Ok(())
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}
