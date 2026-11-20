use std::sync::{Arc, Weak, atomic::Ordering};

use notarium_canonical::{CanonicalStore, ProjectionErasures, ProjectionVisibilityCleanup};
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::{ProjectionGeneration, SpaceSeq},
    ports::PortFuture,
};

use crate::{
    derived::{
        DerivedStore, GenerationControl, GenerationFiles, PostgresCacheOwner, PostgresEraser,
    },
    mmap::{BaseIndexHandle, CheckpointRange, IndexIdentity, sweep_erased_checkpoint},
};

use super::{GenerationCleanup, ProjectionEngine, PublishedCut, checkpoint_error};

type Maintenance = Arc<tokio::sync::OwnedMutexGuard<()>>;

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
    fn erase_visibility<'a>(
        &'a self,
        canonical: &'a CanonicalStore,
        erasures: &'a ProjectionErasures,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            let maintenance = Arc::new(Arc::clone(&self.generation_cleanup).lock_owned().await);
            // Publication uses this same lock. A callback queued before restore
            // must not classify a newly published checkpoint as an old history.
            if canonical.read_space(&erasures.scope.space_id).await?.scope != erasures.scope {
                return Ok(());
            }
            if let Some(engine) = self.engine.upgrade() {
                return engine
                    .erase_committed_visibility(
                        self.postgres.as_ref(),
                        canonical,
                        erasures,
                        &maintenance,
                    )
                    .await;
            }
            if let Some(postgres) = &self.postgres {
                return erase_postgres_visibility(
                    postgres,
                    &self.root,
                    self.postgres_cache_owner.as_ref(),
                    canonical,
                    erasures,
                    &maintenance,
                )
                .await;
            }
            erase_offline_sqlite(&self.root, canonical, erasures, &maintenance).await
        })
    }
}

impl ProjectionEngine {
    pub(super) async fn reclaim_superseded_checkpoints(
        &self,
        current: &PublishedCut,
    ) -> Result<(), PortError> {
        let identity = current.base.identity().clone();
        if identity.seq == SpaceSeq::ZERO {
            return Ok(());
        }
        let maintenance = Arc::clone(&self.generation_cleanup).lock_owned().await;
        let root = self.cache_root.clone();
        let pool = self.pool.clone();
        let cache_owner = self.postgres_cache_owner.clone();
        let generation_lease = current.store.cache_lease()?;
        tokio::task::spawn_blocking(move || {
            let _maintenance = maintenance;
            let _cache_owner = cache_owner;
            let _generation_lease = generation_lease;
            let directory =
                root.space_fast_index_dir(identity.generation, &identity.scope.space_id);
            BaseIndexHandle::retire_superseded(&directory, &identity, &pool)
                .map_err(checkpoint_error)?;
            sweep_checkpoint_files(
                &root,
                identity.generation,
                &CheckpointRange::exact(&identity.scope, identity.seq),
                Sweep::Superseded,
            )
        })
        .await
        .map_err(checkpoint_error)?
    }

    /// Recover the markers for the exact generation and history being built.
    pub(super) async fn hydrate_erasure(
        &self,
        store: &DerivedStore,
        erasures: &ProjectionErasures,
    ) -> Result<(), PortError> {
        let maintenance = Arc::new(Arc::clone(&self.generation_cleanup).lock_owned().await);
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
                &CheckpointRange::exact(&erasures.scope, erasures.through),
                self.postgres_cache_owner.as_ref(),
                sweep,
                &maintenance,
            )
            .await?;
        }
        Ok(())
    }

    async fn erase_committed_visibility(
        &self,
        postgres: Option<&PostgresEraser>,
        canonical: &CanonicalStore,
        erasures: &ProjectionErasures,
        maintenance: &Maintenance,
    ) -> Result<(), PortError> {
        let purging = !erasures.purged.is_empty();
        if let Some(postgres) = postgres {
            erase_postgres_visibility(
                postgres,
                &self.cache_root,
                self.postgres_cache_owner.as_ref(),
                canonical,
                erasures,
                maintenance,
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
                store
                    .erase_committed_visibility(canonical, erasures)
                    .await?;
                if purging {
                    erase_scoped_checkpoints(
                        &self.cache_root,
                        id,
                        &CheckpointRange::current(&erasures.scope, erasures.through),
                        None,
                        true,
                        maintenance,
                    )
                    .await?;
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
            self.scrub_space_events(&erasures.scope, erasures.through);
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
    canonical: &CanonicalStore,
    erasures: &ProjectionErasures,
    maintenance: &Maintenance,
) -> Result<(), PortError> {
    let affected = postgres.erase(root, canonical, erasures).await?;
    if erasures.purged.is_empty() {
        return Ok(());
    }
    let scope = erasures.scope.clone();
    let through = erasures.through;
    let root = root.clone();
    let maintenance = Arc::clone(maintenance);
    let cache_owner = cache_owner.cloned();
    tokio::task::spawn_blocking(move || {
        let _maintenance = maintenance;
        let _cache_owner = cache_owner;
        let range = CheckpointRange::current(&scope, through);
        for generation in affected.reconciled.into_iter().chain(affected.retired) {
            retire_registered(&root, generation, &range)?;
            sweep_checkpoint_files(&root, generation, &range, Sweep::Purged)?;
        }
        // A missing active or reserved SQL floor cannot exclude old writers.
        // Keep the obligation until the retry can reconcile the generation.
        for generation in affected.unreconciled {
            sweep_checkpoint_files(&root, generation, &range, Sweep::Unreconciled)?;
        }
        Ok(())
    })
    .await
    .map_err(checkpoint_error)?
}

async fn erase_offline_sqlite(
    root: &DataRoot,
    canonical: &CanonicalStore,
    erasures: &ProjectionErasures,
    maintenance: &Maintenance,
) -> Result<(), PortError> {
    let purging = !erasures.purged.is_empty();
    let range = CheckpointRange::current(&erasures.scope, erasures.through);
    let control = GenerationControl::open_sqlite(root).await?;
    for id in GenerationFiles::inventory(root).await? {
        if !root.derived(id).exists() {
            if purging {
                erase_closed_checkpoints(root, id, &range, maintenance).await?;
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
        store
            .erase_committed_visibility(canonical, erasures)
            .await?;
        if purging {
            // The committed floor excludes old writers. A reader in any Space
            // can still hold the shared generation lease during this sweep.
            erase_scoped_checkpoints(root, id, &range, None, true, maintenance).await?;
        }
    }
    Ok(())
}

async fn erase_scoped_checkpoints(
    root: &DataRoot,
    generation: ProjectionGeneration,
    range: &CheckpointRange,
    cache_owner: Option<&Arc<PostgresCacheOwner>>,
    sweep: bool,
    maintenance: &Maintenance,
) -> Result<(), PortError> {
    let root = root.clone();
    let range = range.clone();
    let cache_owner = cache_owner.cloned();
    let maintenance = Arc::clone(maintenance);
    tokio::task::spawn_blocking(move || {
        let _maintenance = maintenance;
        let _cache_owner = cache_owner;
        retire_registered(&root, generation, &range)?;
        if sweep {
            sweep_checkpoint_files(&root, generation, &range, Sweep::Purged)?;
        }
        Ok(())
    })
    .await
    .map_err(checkpoint_error)?
}

async fn erase_closed_checkpoints(
    root: &DataRoot,
    generation: ProjectionGeneration,
    range: &CheckpointRange,
    maintenance: &Maintenance,
) -> Result<(), PortError> {
    erase_scoped_checkpoints(root, generation, range, None, false, maintenance).await?;
    let cache = root.clone();
    let range = range.clone();
    let maintenance = Arc::clone(maintenance);
    GenerationFiles::with_exclusive_reclamation(root, generation, move || {
        let _maintenance = maintenance;
        sweep_checkpoint_files(&cache, generation, &range, Sweep::Purged)
    })
    .await?
    .ok_or_else(not_ready)?;
    Ok(())
}

fn retire_registered(
    root: &DataRoot,
    generation: ProjectionGeneration,
    range: &CheckpointRange,
) -> Result<(), PortError> {
    let directory = root.space_fast_index_dir(generation, &range.scope.space_id);
    BaseIndexHandle::purge_registered(&directory, generation, range).map_err(checkpoint_error)
}

enum Sweep {
    Superseded,
    Purged,
    Unreconciled,
}

fn sweep_checkpoint_files(
    root: &DataRoot,
    generation: ProjectionGeneration,
    range: &CheckpointRange,
    sweep: Sweep,
) -> Result<(), PortError> {
    let directory = root.space_fast_index_dir(generation, &range.scope.space_id);
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
        if !range.include_replaced && seq.is_some_and(|seq| seq >= range.through) {
            continue;
        }
        let path = entry.path();
        if matches!(sweep, Sweep::Superseded)
            && let Some(seq) = seq
        {
            let identity = IndexIdentity {
                generation,
                scope: range.scope.clone(),
                seq,
            };
            BaseIndexHandle::discard_unleased_matching(&path, &identity)
                .map_err(checkpoint_error)?;
        } else {
            let probe = matches!(sweep, Sweep::Unreconciled);
            if sweep_erased_checkpoint(&path, generation, range, seq, probe)
                .map_err(checkpoint_error)?
                && probe
            {
                return Err(not_ready());
            }
        }
    }
    Ok(())
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}
