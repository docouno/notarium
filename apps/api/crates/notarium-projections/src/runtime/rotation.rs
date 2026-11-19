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
    ports::{CallBudget, Cancellation, SpaceEventKind},
};

use crate::derived::{DerivedStore, GenerationControl, GenerationDescriptor};

use super::{Generation, ProjectionEngine, ProjectorRuntime, apply, worker};

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
        candidate: DerivedStore,
        budget: &CallBudget,
    ) -> Result<(), PortError> {
        if self.control.is_distributed() {
            return self.rotate_peers(candidate.generation(), budget).await;
        }
        if self.local_rotation.is_some() {
            let previous = self.finish_local_rotation().await;
            if self.descriptor.generation == candidate.generation() {
                // Rejoining after a dropped request is idempotent once active.
                if previous.as_ref().is_err_and(commit_unknown) {
                    return self.confirm_local_activation().await;
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
        if candidate.generation() == self.descriptor.generation {
            return self.confirm_local_activation().await;
        }
        if candidate.generation() != self.descriptor.generation.checked_next()? {
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

    async fn confirm_local_activation(&self) -> Result<(), PortError> {
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
    candidate: DerivedStore,
    budget: CallBudget,
    stop: Cancellation,
    local_owner: Option<Arc<std::fs::File>>,
) -> LocalOutcome {
    let result = prepare_local(&engine, &old, candidate, stop.clone(), local_owner.clone()).await;
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
    match wait_for_handoff(&engine, &old, &candidate, &reservation, &budget, &stop).await {
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
            if let Err(error) = engine.control.cancel_candidate(&reservation).await {
                // A failed cleanup is resumable at retry or at owner restart.
                tracing::warn!(
                    error = error.code(),
                    "projection reservation cleanup deferred"
                );
            }
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
    old: &GenerationDescriptor,
    store: DerivedStore,
    stop: Cancellation,
    local_owner: Option<Arc<std::fs::File>>,
) -> Result<(Arc<Generation>, GenerationDescriptor, LocalWorker), PortError> {
    let catalog = engine
        .canonical
        .subscribe_projection_catalog(&engine.projection_context)?;
    let spaces = engine
        .canonical
        .list_spaces(&engine.projection_context)
        .await?;
    let planned = GenerationDescriptor {
        generation: store.generation(),
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
            match engine.control.reserve_candidate(Some(old), &planned).await {
                Ok(true) => {}
                Ok(false) => return Err(not_ready()),
                Err(error) => {
                    let observed = engine.control.local_rotation_witness().await?;
                    if observed.active.as_ref() != Some(old)
                        || observed.candidate.as_ref() != Some(&planned)
                    {
                        return Err(error);
                    }
                }
            }
            planned
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

async fn wait_for_handoff(
    engine: &ProjectionEngine,
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
        if let Some(permits) = matching_cuts(&active, candidate, &catalog) {
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
            if fingerprint(&current)? == exact {
                if stop.is_cancelled() || budget.cancellation.is_cancelled() {
                    return Err(handoff_cancelled());
                }
                if started.elapsed() >= budget.remaining {
                    return Err(handoff_deadline());
                }
                let mut next = reservation.clone();
                next.cut_fingerprint = exact;
                let reply = commit_local(engine, old, &next, stop).await?;
                drop(permits);
                apply::activate_generation(engine, candidate);
                drop(publication);
                engine
                    .activation
                    .send_modify(|revision| *revision = revision.wrapping_add(1));
                for (_, scope, _, seq) in &catalog {
                    engine.emit(scope, *seq, SpaceEventKind::ResyncRequired);
                }
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

pub(super) async fn commit_local(
    engine: &ProjectionEngine,
    old: &GenerationDescriptor,
    next: &GenerationDescriptor,
    stop: &Cancellation,
) -> Result<Result<(), PortError>, PortError> {
    let uncertain = match engine.control.compare_and_swap(Some(old), next).await {
        Ok(true) => return Ok(Ok(())),
        Ok(false) => not_ready(),
        Err(error) if commit_unknown(&error) => error,
        Err(error) => return Err(error),
    };
    loop {
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
            Err(_) => {
                tokio::select! {
                    _ = stop.cancelled() => {
                        engine.publication_closed.store(true, Ordering::Release);
                        return Err(unknown_switch());
                    }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                }
            }
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
) -> Option<Vec<LiveReadPermit>> {
    let mut permits = Vec::with_capacity(catalog.len());
    for (_, scope, _, seq) in catalog {
        let active = active.slot(&scope.space_id)?.admitted_cut()?;
        let candidate = candidate.slot(&scope.space_id)?.cut.load_full()?;
        if active.cut.scope != *scope
            || candidate.cut.scope != *scope
            || active.cut.projected_seq != *seq
            || candidate.cut.projected_seq != *seq
        {
            return None;
        }
        let permit = active.live.try_read().ok()?;
        if permit.head() != *seq || permit.scope() != scope {
            return None;
        }
        permits.push(permit);
    }
    Some(permits)
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
