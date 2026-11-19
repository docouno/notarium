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

use crate::derived::{
    DerivedStore, GenerationControl, GenerationDescriptor, GenerationFiles, PeerCandidate,
};

use super::{ProjectionEngine, rotation};

type Catalog = [(Space, HistoryScope, FolderId, SpaceSeq)];

pub(super) enum Source {
    Open(DerivedStore),
    Sqlite,
    Postgres { pool: PgPool, schema_prefix: String },
}

impl Source {
    pub(super) async fn control(&self, root: &DataRoot) -> Result<GenerationControl, PortError> {
        match self {
            Self::Open(store) => store.generation_control(root).await,
            Self::Sqlite => GenerationControl::open_sqlite(root).await,
            Self::Postgres {
                pool,
                schema_prefix,
            } => GenerationControl::open_postgres(pool.clone(), schema_prefix).await,
        }
    }

    async fn open(
        &self,
        root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Option<DerivedStore>, PortError> {
        let store = match self {
            Self::Open(store) if store.generation() == generation => Some(store.clone()),
            Self::Open(store) => {
                store
                    .related_generation_for_runtime(root, generation)
                    .await?
            }
            Self::Sqlite => DerivedStore::open_sqlite_for_runtime(root, generation).await?,
            Self::Postgres {
                pool,
                schema_prefix,
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
    pub(super) recovery: Option<Recovery>,
}

pub(super) enum Recovery {
    Local(GenerationDescriptor),
    Postgres(PeerCandidate),
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
    // A concurrent founder may have published while this process was
    // probing the old format or joining the same shared reservation.
    for _ in 0..3 {
        let probe = match opened.take() {
            Some(store) => Some(store),
            None => source.open(root, old.generation).await?,
        };
        if let Some(store) = probe {
            if !control.is_distributed() || control.active().await?.as_ref() == Some(&old) {
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
            let recovery = if control.is_distributed() {
                control
                    .reserve_format_recovery(&old, &planned)
                    .await?
                    .map(Recovery::Postgres)
            } else {
                Some(Recovery::Local(
                    reserve_local(control, &old, &planned).await?,
                ))
            };
            if let Some(recovery) = recovery {
                let store = if let Some(store) = source.open(root, planned.generation).await? {
                    store
                } else {
                    reset_obsolete_candidate(root, control, &old, &recovery).await?;
                    source
                        .open(root, planned.generation)
                        .await?
                        .ok_or_else(not_ready)?
                };
                return Ok(Selection {
                    old,
                    store,
                    recovery: Some(recovery),
                });
            }
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
    recovery: &Recovery,
) -> Result<(), PortError> {
    match recovery {
        Recovery::Local(candidate) => {
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
        Recovery::Postgres(candidate) => control.reset_obsolete_candidate(old, candidate).await,
    }
}

async fn reserve_local(
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
pub(super) async fn recover_local(
    engine: &ProjectionEngine,
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
        if let Some(_permits) = ready(engine, &catalog) {
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
                    rotation::commit_local(engine, old, &next, stop).await??;
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

fn ready(engine: &ProjectionEngine, catalog: &Catalog) -> Option<Vec<LiveReadPermit>> {
    let candidate = engine.generation.load();
    let mut permits = Vec::with_capacity(catalog.len());
    for (_, scope, _, seq) in catalog {
        let slot = candidate.slot(&scope.space_id)?;
        let cut = slot.cut.load_full()?;
        if cut.cut.scope != *scope || cut.cut.projected_seq != *seq {
            return None;
        }
        if cut.base.open(&engine.pool).is_err() {
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
            _ = tokio::time::sleep(Duration::from_secs(1)), if pending => {},
        }
    }
}

async fn collect(engine: &ProjectionEngine) -> Result<bool, PortError> {
    let _maintenance = engine.generation_cleanup.lock().await;
    engine.reads.expire();
    let active = engine.generation.load_full();
    let Some(durable) = engine.control.active().await? else {
        return Ok(false);
    };
    let ceiling = active.store.generation().min(durable.generation);
    {
        let mut resident = engine
            .known_generations
            .write()
            .unwrap_or_else(|error| error.into_inner());
        resident.retain(|generation, _| *generation >= ceiling);
    }
    let mut old: BTreeSet<_> = GenerationFiles::inventory(&engine.cache_root)
        .await?
        .into_iter()
        .filter(|generation| *generation < ceiling)
        .collect();
    old.extend(
        active
            .store
            .related_generations(&engine.cache_root)
            .await?
            .into_iter()
            .filter(|generation| *generation < ceiling),
    );
    let mut pending = false;
    for generation in old {
        if engine.control.is_distributed()
            && !engine.control.generation_reclaimable(generation).await?
        {
            pending = true;
            continue;
        }
        let Some(lease) = GenerationFiles::for_reclamation(&engine.cache_root, generation).await?
        else {
            pending = true;
            continue;
        };
        engine.pool.evict_generation(generation);
        if !active.store.reclaim_postgres_schema(generation).await? {
            pending = true;
            continue;
        }
        GenerationFiles::remove(
            &engine.cache_root,
            generation,
            engine.control.is_distributed(),
            lease,
        )
        .await?;
    }
    Ok(pending)
}

fn mismatch() -> PortError {
    DomainError::validation(ValidationReason::GenerationMismatch).into()
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}
