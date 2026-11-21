use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, Instant},
};

use notarium_canonical::{
    LiveReadPermit,
    codec::{cancelled_not_committed, deadline_not_committed},
};
use notarium_core::{
    DomainError,
    auth::Space,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::{FolderId, ProjectionGeneration, SpaceSeq},
    model::HistoryScope,
    ports::{CallBudget, Cancellation},
};
use sqlx::PgPool;

use crate::derived::{DerivedStore, GenerationControl, GenerationDescriptor, GenerationFiles};

use super::{ProjectionEngine, rotation};

type Catalog = [(Space, HistoryScope, FolderId, SpaceSeq)];

pub(super) enum Source {
    #[cfg(any(test, feature = "test-support"))]
    Open(DerivedStore),
    Sqlite,
    Postgres {
        pool: PgPool,
        schema_prefix: String,
        expected_cache_id: Option<String>,
    },
}

impl Source {
    pub(super) async fn control(&self, root: &DataRoot) -> Result<GenerationControl, PortError> {
        match self {
            #[cfg(any(test, feature = "test-support"))]
            Self::Open(store) => store.generation_control(root).await,
            Self::Sqlite => GenerationControl::open_sqlite(root).await,
            Self::Postgres {
                pool,
                schema_prefix,
                ..
            } => GenerationControl::open_postgres(pool.clone(), schema_prefix).await,
        }
    }

    async fn open(
        &self,
        root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Option<DerivedStore>, PortError> {
        let store = match self {
            #[cfg(any(test, feature = "test-support"))]
            Self::Open(store) if store.generation() == generation => Some(store.clone()),
            #[cfg(any(test, feature = "test-support"))]
            Self::Open(store) => {
                store
                    .related_generation_for_runtime(root, generation)
                    .await?
            }
            Self::Sqlite => DerivedStore::open_sqlite_for_runtime(root, generation).await?,
            Self::Postgres {
                pool,
                schema_prefix,
                ..
            } => {
                DerivedStore::open_postgres_for_runtime(pool.clone(), schema_prefix, generation)
                    .await?
            }
        };
        match store {
            Some(store) => Ok(Some(store.with_cache_lease(root).await?)),
            None => Ok(None),
        }
    }
}

pub(super) struct Selection {
    pub(super) old: GenerationDescriptor,
    pub(super) store: DerivedStore,
    pub(super) recovery: Option<GenerationDescriptor>,
}

pub(super) async fn select(
    source: &Source,
    root: &DataRoot,
    control: &GenerationControl,
    initial: ProjectionGeneration,
    catalog: &Catalog,
) -> Result<Selection, PortError> {
    let (mut old, mut opened) = match control.active().await? {
        Some(old) => (old, None),
        None => {
            // Prove the initial format before installing its first descriptor.
            let store = source.open(root, initial).await?.ok_or_else(mismatch)?;
            let descriptor = rotation::start_generation(control, initial, catalog).await?;
            let store = (descriptor.generation == initial).then_some(store);
            (descriptor, store)
        }
    };
    // A concurrent starter may have published while probing the old format.
    for _ in 0..3 {
        let probe = match opened.take() {
            Some(store) => Some(store),
            None => source.open(root, old.generation).await?,
        };
        if let Some(store) = probe {
            if !control.is_postgres() || control.active().await?.as_ref() == Some(&old) {
                return Ok(Selection {
                    old,
                    store,
                    recovery: None,
                });
            }
        } else {
            let planned = GenerationDescriptor {
                generation: old.generation.checked_next()?,
                publication_epoch: old
                    .publication_epoch
                    .checked_add(1)
                    .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?,
                cut_fingerprint: rotation::fingerprint(catalog)?,
            };
            let candidate = reserve_candidate(control, &old, &planned).await?;
            let open_candidate = async {
                if let Some(store) = source.open(root, candidate.generation).await? {
                    return Ok(store);
                }
                reset_obsolete_candidate(root, control, &old, &candidate).await?;
                source
                    .open(root, candidate.generation)
                    .await?
                    .ok_or_else(not_ready)
            };
            let store = match open_candidate.await {
                Ok(store) => store,
                Err(error) => {
                    control.cancel_candidate(&candidate).await?;
                    return Err(error);
                }
            };
            return Ok(Selection {
                old,
                store,
                recovery: Some(candidate),
            });
        }
        let active = control.active().await?.ok_or_else(not_ready)?;
        if active == old {
            return Err(not_ready());
        }
        old = active;
    }
    Err(not_ready())
}

async fn reset_obsolete_candidate(
    root: &DataRoot,
    control: &GenerationControl,
    old: &GenerationDescriptor,
    candidate: &GenerationDescriptor,
) -> Result<(), PortError> {
    if control.is_postgres() {
        return control
            .reset_obsolete_postgres_candidate(old, candidate)
            .await;
    }
    // Startup owns this cache root exclusively. Standalone store
    // handles also hold the per-generation file lease.
    let lease = GenerationFiles::for_reclamation(root, candidate.generation)
        .await?
        .ok_or_else(not_ready)?;
    let witness = control.local_rotation_witness().await?;
    if !witness.durable
        || witness.active.as_ref() != Some(old)
        || witness.candidate.as_ref() != Some(candidate)
    {
        return Err(not_ready());
    }
    GenerationFiles::remove_obsolete_sqlite(root, candidate.generation, lease).await
}

async fn reserve_candidate(
    control: &GenerationControl,
    old: &GenerationDescriptor,
    planned: &GenerationDescriptor,
) -> Result<GenerationDescriptor, PortError> {
    match control.candidate().await? {
        Some(existing)
            if existing.generation == planned.generation
                && existing.publication_epoch == planned.publication_epoch =>
        {
            Ok(existing)
        }
        Some(_) => Err(not_ready()),
        None if control.reserve_candidate(Some(old), planned).await? => Ok(planned.clone()),
        None => Err(not_ready()),
    }
}

/// During startup the replacement worker can seed eagerly, while the caller
/// still has no reader handle and the old descriptor remains durable.
pub(super) async fn recover_generation(
    engine: &ProjectionEngine,
    coordinator: &GenerationControl,
    old: &GenerationDescriptor,
    candidate: &GenerationDescriptor,
    budget: &CallBudget,
    stop: &Cancellation,
) -> Result<GenerationDescriptor, PortError> {
    let started = Instant::now();
    loop {
        let remaining = budget.remaining.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(deadline_not_committed(
                "projection_format_recovery",
                "new generation did not reach a sealed cut",
            ));
        }
        if budget.cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "projection_format_recovery",
                "caller cancelled",
            ));
        }
        let catalog = engine
            .canonical
            .list_spaces(&engine.projection_context)
            .await?;
        if let Some(_permits) = ready(engine, &catalog).await {
            let mut next = candidate.clone();
            next.cut_fingerprint = rotation::fingerprint(&catalog)?;
            let _admission = tokio::select! {
                _ = budget.cancellation.cancelled() => {
                    return Err(cancelled_not_committed("projection_format_recovery", "caller cancelled"));
                },
                _ = tokio::time::sleep(remaining) => {
                    return Err(deadline_not_committed("projection_format_recovery", "catalog seal unavailable"));
                },
                lock = engine.publication.write() => lock,
            };
            let remaining = budget.remaining.saturating_sub(started.elapsed());
            if !remaining.is_zero() && !budget.cancellation.is_cancelled() {
                let current = engine
                    .canonical
                    .list_spaces(&engine.projection_context)
                    .await?;
                if rotation::fingerprint(&current)? == next.cut_fingerprint {
                    let commit_remaining = budget.remaining.saturating_sub(started.elapsed());
                    rotation::commit_rotation(
                        engine,
                        coordinator,
                        old,
                        &next,
                        budget,
                        commit_remaining,
                        stop,
                    )
                    .await??;
                    return Ok(next);
                }
            }
        }
        tokio::select! {
            _ = budget.cancellation.cancelled() => {
                return Err(cancelled_not_committed("projection_format_recovery", "caller cancelled"));
            },
            _ = tokio::time::sleep(remaining.min(Duration::from_millis(30))) => {},
        }
    }
}

async fn ready(engine: &ProjectionEngine, catalog: &Catalog) -> Option<Vec<LiveReadPermit>> {
    let candidate = engine.generation.load();
    let mut permits = Vec::with_capacity(catalog.len());
    for (_, scope, _, seq) in catalog {
        let slot = candidate.slot(&scope.space_id)?;
        let cut = slot.cut.load_full()?;
        if cut.cut.scope != *scope || cut.cut.projected_seq != *seq {
            return None;
        }
        if engine.open_index_async(&cut).await.is_err() {
            slot.checkpoint.notify_one();
            return None;
        }
        let permit = cut.live.try_read().ok()?;
        if permit.scope() != scope || permit.head() != *seq {
            return None;
        }
        permits.push(permit);
    }
    Some(permits)
}

pub(super) async fn supervise(engine: Arc<ProjectionEngine>, stop: Cancellation) {
    let mut activation = engine.activation.subscribe();
    while !stop.is_cancelled() {
        let pending = match collect(&engine).await {
            Ok(pending) => pending,
            Err(error) => {
                tracing::warn!(
                    error = error.code(),
                    "projection generation reclamation deferred"
                );
                true
            }
        };
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = activation.changed() => {},
            _ = engine.reads.expire_on_deadline() => {},
            _ = tokio::time::sleep(Duration::from_secs(1)), if pending => {},
        }
    }
}

async fn collect(engine: &ProjectionEngine) -> Result<bool, PortError> {
    let _maintenance = engine.generation_cleanup.lock().await;
    engine.prune_event_channels();
    let active = engine.generation.load_full();
    let Some(durable) = engine.control.active().await? else {
        return Ok(false);
    };
    let reserved = engine.control.candidate().await?;
    let ceiling = active.store.generation().min(durable.generation);
    let kept: BTreeSet<_> = {
        let mut resident = engine
            .known_generations
            .write()
            .unwrap_or_else(|error| error.into_inner());
        resident.retain(|generation, _| *generation >= ceiling);
        let mut kept: BTreeSet<_> = resident.keys().copied().collect();
        kept.insert(active.store.generation());
        kept.insert(durable.generation);
        if let Some(candidate) = &reserved {
            kept.insert(candidate.generation);
        }
        kept
    };
    let mut disposable: BTreeSet<_> = GenerationFiles::inventory(&engine.cache_root)
        .await?
        .into_iter()
        .filter(|generation| !kept.contains(generation))
        .collect();
    disposable.extend(
        active
            .store
            .related_generations(&engine.cache_root)
            .await?
            .into_iter()
            .filter(|generation| !kept.contains(generation)),
    );
    let mut pending = false;
    for generation in disposable {
        let step: Result<bool, PortError> = async {
            if !engine.control.generation_reclaimable(generation).await? {
                return Ok(true);
            }
            let Some(lease) =
                GenerationFiles::for_reclamation(&engine.cache_root, generation).await?
            else {
                return Ok(true);
            };
            engine.pool.evict_generation(generation);
            if !active.store.reclaim_postgres_schema(generation).await? {
                return Ok(true);
            }
            GenerationFiles::remove(
                &engine.cache_root,
                generation,
                engine.control.is_postgres(),
                lease,
            )
            .await?;
            Ok(false)
        }
        .await;
        match step {
            Ok(still_pending) => pending |= still_pending,
            Err(error) => {
                tracing::warn!(
                    generation = generation.get(),
                    error = error.code(),
                    "projection generation cleanup deferred"
                );
                pending = true;
            }
        }
    }
    Ok(pending)
}

fn mismatch() -> PortError {
    DomainError::validation(ValidationReason::GenerationMismatch).into()
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}
