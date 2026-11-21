use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use notarium_canonical::{
    LiveReadPermit,
    codec::{
        cancelled_not_committed, deadline_not_committed, encode_msgpack, unknown_commit_outcome,
    },
};
use notarium_core::{
    DomainError,
    auth::Space,
    error::{CommitEffect, PortError, ValidationReason},
    ids::{ContentDigest, FolderId, ProjectionGeneration, SpaceSeq},
    model::HistoryScope,
    ports::{CallBudget, Cancellation},
};

use crate::derived::{GenerationControl, GenerationDescriptor};

use super::{Generation, ProjectionEngine, ProjectorRuntime, PublishedCut, apply, worker};

type Catalog = [(Space, HistoryScope, FolderId, SpaceSeq)];

pub(super) async fn start_generation(
    control: &GenerationControl,
    generation: ProjectionGeneration,
    spaces: &Catalog,
) -> Result<GenerationDescriptor, PortError> {
    let active = match control.active().await? {
        Some(active) => active,
        None => {
            let first = GenerationDescriptor {
                generation,
                publication_epoch: 1,
                cut_fingerprint: fingerprint(spaces)?,
            };
            if control.compare_and_swap(None, &first).await? {
                first
            } else {
                control.active().await?.ok_or_else(not_ready)?
            }
        }
    };
    Ok(active)
}

impl ProjectorRuntime {
    /// Builds the candidate while the active generation serves readers.
    pub async fn rotate(
        &mut self,
        candidate: ProjectionGeneration,
        budget: &CallBudget,
    ) -> Result<(), PortError> {
        if self.local_rotation.is_some() {
            let previous = self.finish_local_rotation().await;
            if self.descriptor.generation == candidate {
                // Rejoining after a dropped request is idempotent once active.
                if previous.as_ref().is_err_and(commit_unknown) {
                    return self.confirm_activation().await;
                }
                return previous;
            }
            if self.engine.publication_closed.load(Ordering::Acquire) {
                return previous;
            }
        }
        if self.engine.publication_closed.load(Ordering::Acquire) {
            return Err(not_ready());
        }
        if candidate == self.descriptor.generation {
            return self.confirm_activation().await;
        }
        if candidate != self.descriptor.generation.checked_next()? {
            return Err(DomainError::validation(ValidationReason::GenerationMismatch).into());
        }
        let stop = Cancellation::default();
        let previous = LocalWorker {
            stop: self.shutdown.clone(),
            worker: self.worker.take(),
        };
        let engine = Arc::clone(&self.engine);
        let descriptor = self.descriptor.clone();
        let caller = budget.clone();
        let task_stop = stop.clone();
        let local_owner = self.local_owner.clone();
        let task = tokio::spawn(async move {
            // The cache owner survives cancellation/destruction of the API
            // object while an in-flight file operation is being resolved.
            rotate_local(
                engine,
                previous,
                descriptor,
                candidate,
                caller,
                task_stop,
                local_owner,
            )
            .await
        });
        self.local_rotation = Some(LocalRotation { stop, task });
        self.finish_local_rotation().await
    }

    async fn finish_local_rotation(&mut self) -> Result<(), PortError> {
        let Some(rotation) = &mut self.local_rotation else {
            return Ok(());
        };
        // Await through a reference. Dropping this request neither removes
        // the task nor consumes the worker and descriptor it will return.
        let completed = (&mut rotation.task).await;
        self.local_rotation = None;
        let outcome = completed.map_err(|_| {
            self.engine
                .publication_closed
                .store(true, Ordering::Release);
            unknown_switch()
        })?;
        let LocalOutcome {
            mut worker,
            descriptor,
            reply,
        } = outcome;
        self.shutdown = worker.stop.clone();
        self.worker = worker.worker.take();
        self.descriptor = descriptor;
        reply
    }

    async fn confirm_activation(&self) -> Result<(), PortError> {
        if self.control.is_postgres() {
            let active = self.control.active().await.map_err(|_| unknown_switch())?;
            if active.as_ref() != Some(&self.descriptor) {
                return Err(unknown_switch());
            }
            return Ok(());
        }
        let observed = self
            .control
            .local_rotation_witness()
            .await
            .map_err(|_| unknown_switch())?;
        if observed.active.as_ref() != Some(&self.descriptor) || !observed.durable {
            return Err(unknown_switch());
        }
        Ok(())
    }

    pub(super) async fn finish_local_shutdown(&mut self) -> Result<(), PortError> {
        if let Some(rotation) = &self.local_rotation {
            rotation.cancel();
        }
        let result = self.finish_local_rotation().await;
        self.shutdown.cancel();
        match result {
            Err(PortError::Cancelled(_)) => Ok(()),
            result => result,
        }
    }
}

pub(super) struct LocalRotation {
    stop: Cancellation,
    task: tokio::task::JoinHandle<LocalOutcome>,
}

impl LocalRotation {
    pub(super) fn cancel(&self) {
        self.stop.cancel();
    }
}

struct LocalWorker {
    stop: Cancellation,
    worker: Option<tokio::task::JoinHandle<Result<(), PortError>>>,
}

impl LocalWorker {
    async fn stop(mut self) {
        self.stop.cancel();
        if let Some(worker) = self.worker.take() {
            let _ = worker.await;
        }
    }
}

impl Drop for LocalWorker {
    fn drop(&mut self) {
        if self.worker.is_some() {
            self.stop.cancel();
        }
    }
}

struct LocalOutcome {
    worker: LocalWorker,
    descriptor: GenerationDescriptor,
    reply: Result<(), PortError>,
}

struct LocalActivation {
    descriptor: GenerationDescriptor,
    reply: Result<(), PortError>,
}

async fn rotate_local(
    engine: Arc<ProjectionEngine>,
    previous: LocalWorker,
    old: GenerationDescriptor,
    candidate: ProjectionGeneration,
    mut budget: CallBudget,
    stop: Cancellation,
    local_owner: Option<Arc<std::fs::File>>,
) -> LocalOutcome {
    let started = Instant::now();
    let coordinator =
        match before_activation(&budget, &stop, engine.control.acquire_coordinator()).await {
            Ok(coordinator) => coordinator,
            Err(error) => {
                return LocalOutcome {
                    worker: previous,
                    descriptor: old,
                    reply: Err(error),
                };
            }
        };
    budget.remaining = budget.remaining.saturating_sub(started.elapsed());
    let started = Instant::now();
    let result = prepare_local(
        &engine,
        &coordinator,
        &old,
        candidate,
        &budget,
        stop.clone(),
        local_owner,
    )
    .await;
    let (candidate, reservation, worker) = match result {
        Ok(prepared) => prepared,
        Err(error) => {
            return LocalOutcome {
                worker: previous,
                descriptor: old,
                reply: Err(error),
            };
        }
    };
    budget.remaining = budget.remaining.saturating_sub(started.elapsed());
    match wait_for_handoff(
        &engine,
        &coordinator,
        &old,
        &candidate,
        &reservation,
        &budget,
        &stop,
    )
    .await
    {
        Ok(active) => {
            previous.stop().await;
            LocalOutcome {
                worker,
                descriptor: active.descriptor,
                reply: active.reply,
            }
        }
        Err(error) => {
            worker.stop().await;
            engine
                .known_generations
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&reservation.generation);
            drop(candidate);
            if let Err(error) = coordinator.cancel_candidate(&reservation).await {
                // A failed cleanup is resumable at retry or at owner restart.
                tracing::warn!(
                    error = error.code(),
                    "projection reservation cleanup deferred"
                );
            }
            engine
                .activation
                .send_modify(|revision| *revision = revision.wrapping_add(1));
            LocalOutcome {
                worker: previous,
                descriptor: old,
                reply: Err(error),
            }
        }
    }
}

async fn prepare_local(
    engine: &Arc<ProjectionEngine>,
    coordinator: &GenerationControl,
    old: &GenerationDescriptor,
    generation: ProjectionGeneration,
    budget: &CallBudget,
    stop: Cancellation,
    local_owner: Option<Arc<std::fs::File>>,
) -> Result<(Arc<Generation>, GenerationDescriptor, LocalWorker), PortError> {
    let started = Instant::now();
    let catalog = engine
        .canonical
        .subscribe_projection_catalog(&engine.projection_context)?;
    let spaces = engine
        .canonical
        .list_spaces(&engine.projection_context)
        .await?;
    let planned = GenerationDescriptor {
        generation,
        publication_epoch: old
            .publication_epoch
            .checked_add(1)
            .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?,
        cut_fingerprint: fingerprint(&spaces)?,
    };
    let reservation = match engine.control.candidate().await? {
        Some(current)
            if current.generation == planned.generation
                && current.publication_epoch == planned.publication_epoch =>
        {
            current
        }
        Some(_) => return Err(not_ready()),
        None => {
            match coordinator.reserve_candidate(Some(old), &planned).await {
                Ok(true) => {}
                Ok(false) => return Err(not_ready()),
                Err(error) => {
                    if engine.control.is_postgres() {
                        if engine.control.active().await?.as_ref() != Some(old)
                            || engine.control.candidate().await?.as_ref() != Some(&planned)
                        {
                            return Err(error);
                        }
                    } else {
                        let observed = engine.control.local_rotation_witness().await?;
                        if observed.active.as_ref() != Some(old)
                            || observed.candidate.as_ref() != Some(&planned)
                        {
                            return Err(error);
                        }
                    }
                }
            }
            planned
        }
    };
    // Reserve before creating files or a schema so reclamation sees the candidate.
    let active = engine.generation.load_full();
    let mut opening = budget.clone();
    opening.remaining = opening.remaining.saturating_sub(started.elapsed());
    let store = match before_activation(
        &opening,
        &stop,
        active
            .store
            .related_generation(&engine.cache_root, generation),
    )
    .await
    {
        Ok(store) => store,
        Err(error) => {
            coordinator.cancel_candidate(&reservation).await?;
            return Err(error);
        }
    };
    let candidate = Arc::new(Generation::new(store));
    engine
        .known_generations
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .insert(reservation.generation, Arc::clone(&candidate));
    let worker_engine = Arc::clone(engine);
    let worker_candidate = Arc::clone(&candidate);
    let worker_stop = stop.clone();
    let worker = tokio::spawn(async move {
        let _owner = local_owner;
        worker::supervise(
            worker_engine,
            worker_candidate,
            spaces,
            catalog,
            worker_stop,
        )
        .await
    });
    Ok((
        candidate,
        reservation,
        LocalWorker {
            stop,
            worker: Some(worker),
        },
    ))
}

async fn before_activation<T>(
    budget: &CallBudget,
    stop: &Cancellation,
    operation: impl std::future::Future<Output = Result<T, PortError>>,
) -> Result<T, PortError> {
    if budget.remaining.is_zero() {
        return Err(handoff_deadline());
    }
    tokio::select! {
        biased;
        _ = stop.cancelled() => Err(handoff_cancelled()),
        _ = budget.cancellation.cancelled() => Err(handoff_cancelled()),
        result = tokio::time::timeout(budget.remaining, operation) => result.map_err(|_| handoff_deadline())?,
    }
}

async fn wait_for_handoff(
    engine: &ProjectionEngine,
    coordinator: &GenerationControl,
    old: &GenerationDescriptor,
    candidate: &Arc<Generation>,
    reservation: &GenerationDescriptor,
    budget: &CallBudget,
    stop: &Cancellation,
) -> Result<LocalActivation, PortError> {
    let started = Instant::now();
    let active = engine.generation.load_full();
    loop {
        let remaining = budget.remaining.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(handoff_deadline());
        }
        if stop.is_cancelled() || budget.cancellation.is_cancelled() {
            return Err(handoff_cancelled());
        }
        let catalog = engine
            .canonical
            .list_spaces(&engine.projection_context)
            .await?;
        if matching_cuts(&active, candidate, &catalog).is_some() {
            let publication = tokio::select! {
                _ = stop.cancelled() => return Err(handoff_cancelled()),
                _ = budget.cancellation.cancelled() => return Err(handoff_cancelled()),
                _ = tokio::time::sleep(remaining) => return Err(handoff_deadline()),
                lock = engine.publication.write() => lock,
            };
            let current = engine
                .canonical
                .list_spaces(&engine.projection_context)
                .await?;
            let exact = fingerprint(&catalog)?;
            if fingerprint(&current)? == exact
                && let Some(cuts) = matching_cuts(&active, candidate, &current)
                && let Some(permits) = cuts.iter().map(handoff_permit).collect::<Option<Vec<_>>>()
            {
                if stop.is_cancelled() || budget.cancellation.is_cancelled() {
                    return Err(handoff_cancelled());
                }
                if started.elapsed() >= budget.remaining {
                    return Err(handoff_deadline());
                }
                let mut next = reservation.clone();
                next.cut_fingerprint = exact;
                let commit_remaining = budget.remaining.saturating_sub(started.elapsed());
                let reply = commit_rotation(
                    engine,
                    coordinator,
                    old,
                    &next,
                    budget,
                    commit_remaining,
                    stop,
                )
                .await?;
                drop(permits);
                apply::activate_generation(engine, candidate);
                drop(publication);
                // `activation` wakes every open `EventStream` to rebind and emit
                // its single authoritative `ResyncRequired` once the new Space
                // lookup is bound; emitting another one on the broadcast ring
                // would duplicate the signal.
                engine
                    .activation
                    .send_modify(|revision| *revision = revision.wrapping_add(1));
                return Ok(LocalActivation {
                    descriptor: next,
                    reply,
                });
            }
        }
        tokio::select! {
            _ = stop.cancelled() => return Err(handoff_cancelled()),
            _ = budget.cancellation.cancelled() => return Err(handoff_cancelled()),
            _ = tokio::time::sleep(remaining.min(Duration::from_millis(20))) => {}
        }
    }
}

pub(super) async fn commit_rotation(
    engine: &ProjectionEngine,
    coordinator: &GenerationControl,
    old: &GenerationDescriptor,
    next: &GenerationDescriptor,
    budget: &CallBudget,
    remaining: Duration,
    stop: &Cancellation,
) -> Result<Result<(), PortError>, PortError> {
    let deadline = Instant::now() + remaining;
    let uncertain = match coordinator.compare_and_swap(Some(old), next).await {
        Ok(true) => return Ok(Ok(())),
        Ok(false) => not_ready(),
        Err(error) if commit_unknown(&error) => error,
        Err(error) => return Err(error),
    };
    loop {
        if engine.control.is_postgres() {
            match engine.control.active().await {
                Ok(active) if active.as_ref() == Some(next) => return Ok(Ok(())),
                Ok(active) if active.as_ref() == Some(old) => return Err(uncertain),
                Ok(_) => {
                    engine.publication_closed.store(true, Ordering::Release);
                    return Err(unknown_switch());
                }
                Err(_) => {}
            }
        } else {
            match engine.control.local_rotation_witness().await {
                Ok(observed) if observed.active.as_ref() == Some(next) => {
                    // Match the local pointer to the installed file even if the
                    // directory still cannot confirm durable acknowledgement.
                    return Ok(if observed.durable {
                        Ok(())
                    } else {
                        Err(unknown_switch())
                    });
                }
                Ok(observed) if observed.active.as_ref() == Some(old) => return Err(uncertain),
                Ok(_) => {
                    engine.publication_closed.store(true, Ordering::Release);
                    return Err(unknown_switch());
                }
                Err(_) => {}
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stop.is_cancelled() || budget.cancellation.is_cancelled() {
            engine.publication_closed.store(true, Ordering::Release);
            return Err(unknown_switch());
        }
        tokio::select! {
            _ = stop.cancelled() => {
                engine.publication_closed.store(true, Ordering::Release);
                return Err(unknown_switch());
            }
            _ = budget.cancellation.cancelled() => {
                engine.publication_closed.store(true, Ordering::Release);
                return Err(unknown_switch());
            }
            _ = tokio::time::sleep(left.min(Duration::from_millis(50))) => {}
        }
    }
}

fn commit_unknown(error: &PortError) -> bool {
    matches!(error, PortError::Unavailable(failure) | PortError::Internal(failure)
        if failure.effect() == CommitEffect::Unknown)
}

fn unknown_switch() -> PortError {
    unknown_commit_outcome(
        "projection_handoff",
        "local generation activation was not confirmed",
    )
}

fn handoff_cancelled() -> PortError {
    cancelled_not_committed("projection_handoff", "caller or projector cancelled")
}

fn handoff_deadline() -> PortError {
    deadline_not_committed(
        "projection_handoff",
        "candidate did not reach the active cut",
    )
}

fn matching_cuts(
    active: &Generation,
    candidate: &Generation,
    catalog: &Catalog,
) -> Option<Vec<Arc<PublishedCut>>> {
    let mut ready = true;
    let mut cuts = Vec::with_capacity(catalog.len());
    for (_, scope, _, seq) in catalog {
        let active_slot = active.slot(&scope.space_id)?;
        let candidate_slot = candidate.slot(&scope.space_id)?;
        let active = active_slot.admitted_cut()?;
        let candidate = candidate_slot.cut.load_full()?;
        if active.cut.scope != *scope
            || candidate.cut.scope != *scope
            || active.cut.projected_seq != *seq
            || candidate.cut.projected_seq != *seq
        {
            return None;
        }
        if active.watermark.graph_settled_seq != *seq {
            active_slot.align_graph.notify_one();
            ready = false;
            continue;
        }
        if *seq != SpaceSeq::ZERO && candidate.handoff_graph_source.as_ptr() != Arc::as_ptr(&active)
        {
            candidate_slot.align_graph.notify_one();
            ready = false;
            continue;
        }
        cuts.push(active);
    }
    ready.then_some(cuts)
}

fn handoff_permit(cut: &Arc<PublishedCut>) -> Option<LiveReadPermit> {
    let permit = cut.live.try_read().ok()?;
    (permit.head() == cut.cut.projected_seq && permit.scope() == &cut.cut.scope).then_some(permit)
}

pub(super) fn fingerprint(catalog: &Catalog) -> Result<ContentDigest, PortError> {
    let mut rows = catalog.to_vec();
    rows.sort_by(|left, right| left.1.cmp(&right.1));
    let bytes = encode_msgpack(&rows)?;
    Ok(ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes()))
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}

#[cfg(test)]
mod tests;
