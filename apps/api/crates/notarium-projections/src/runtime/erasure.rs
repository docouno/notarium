use std::{
    collections::BTreeSet,
    sync::{Arc, Weak, atomic::Ordering},
};

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
        DerivedStore, ErasureOutcome, GenerationControl, GenerationFiles, PostgresCacheOwner,
        PostgresEraser,
    },
    mmap::{BaseIndexHandle, CheckpointRange, IndexIdentity, sweep_erased_checkpoint},
};

use super::{GenerationCleanup, ProjectionEngine, PublishedCut, checkpoint_error};

type Maintenance = Arc<tokio::sync::OwnedMutexGuard<()>>;

pub(super) struct Eraser {
    engine: Weak<ProjectionEngine>,
    postgres: Option<PostgresEraser>,
    root: DataRoot,
    cache_identity: String,
    control: GenerationControl,
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
            cache_identity: engine.cache_identity.clone(),
            control: engine.control.clone(),
            generation_cleanup: Arc::clone(&engine.generation_cleanup),
            postgres_cache_owner: engine.postgres_cache_owner.clone(),
        })
    }

    async fn verify_target(&self) -> Result<(), PortError> {
        let root = self.root.clone();
        let current = tokio::task::spawn_blocking(move || super::read_cache_identity(&root))
            .await
            .map_err(checkpoint_error)??;
        if current != self.cache_identity {
            return Err(not_ready());
        }
        self.control.verify_cleanup_identity().await
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
            self.verify_target().await?;
            let engine = self.engine.upgrade();
            if let Some(postgres) = &self.postgres {
                erase_postgres_visibility(
                    postgres,
                    &self.root,
                    self.postgres_cache_owner.as_ref(),
                    canonical,
                    erasures,
                    &maintenance,
                )
                .await?;
            } else {
                self.erase_sqlite_visibility(engine.as_deref(), canonical, erasures, &maintenance)
                    .await?;
            }
            // The local volume or the shared control schema may have changed
            // while asynchronous SQL and checkpoint cleanup were running.
            self.verify_target().await?;
            if !erasures.purged.is_empty()
                && let Some(engine) = engine
            {
                engine.invalidate_purged_cuts(erasures);
            }
            Ok(())
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

    fn invalidate_purged_cuts(&self, erasures: &ProjectionErasures) {
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

impl Eraser {
    async fn erase_sqlite_visibility(
        &self,
        engine: Option<&ProjectionEngine>,
        canonical: &CanonicalStore,
        erasures: &ProjectionErasures,
        maintenance: &Maintenance,
    ) -> Result<(), PortError> {
        let resident = engine
            .map(|engine| {
                engine
                    .known_generations
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()
            })
            .unwrap_or_default();
        let mut ids: BTreeSet<_> = GenerationFiles::inventory(&self.root)
            .await?
            .into_iter()
            .collect();
        ids.extend(resident.keys().copied());
        let witness = self.control.local_rotation_witness().await?;
        let range = CheckpointRange::current(&erasures.scope, erasures.through);
        for id in ids {
            let outcome = DerivedStore::erase_existing_sqlite(
                &self.root,
                id,
                resident.get(&id).map(|generation| &generation.store),
                Arc::clone(maintenance),
                canonical,
                erasures,
            )
            .await?;
            let remove_files = match outcome {
                ErasureOutcome::Reconciled => true,
                ErasureOutcome::Empty => witness.excludes_writers(id),
                ErasureOutcome::Obsolete => {
                    // A reused candidate number may again acquire this name.
                    // Only a generation behind the durable active one is final.
                    if !witness.excludes_writers(id)
                        || witness
                            .active
                            .as_ref()
                            .is_none_or(|active| active.generation <= id)
                    {
                        return Err(not_ready());
                    }
                    let lease = GenerationFiles::for_reclamation(&self.root, id)
                        .await?
                        .ok_or_else(not_ready)?;
                    GenerationFiles::remove(&self.root, id, false, lease).await?;
                    continue;
                }
            };
            if !erasures.purged.is_empty() {
                if remove_files {
                    erase_scoped_checkpoints(&self.root, id, &range, None, true, maintenance)
                        .await?;
                } else {
                    let maintenance = Arc::clone(maintenance);
                    let root = self.root.clone();
                    let range = range.clone();
                    tokio::task::spawn_blocking(move || {
                        let _maintenance = maintenance;
                        sweep_checkpoint_files(&root, id, &range, Sweep::Unreconciled)
                    })
                    .await
                    .map_err(checkpoint_error)??;
                }
            }
        }
        Ok(())
    }
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
