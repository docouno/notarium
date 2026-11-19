use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

use notarium_canonical::{
    LiveReadPermit, ProjectionCatalogSealEntry,
    codec::{cancelled_not_committed, deadline_not_committed, unknown_commit_outcome},
};
use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError, ValidationReason},
    ids::{ProjectionGeneration, SpaceId},
    model::HistoryScope,
    ports::{CallBudget, Cancellation},
};
use tokio::{
    sync::{OwnedRwLockWriteGuard, oneshot, watch},
    task::JoinHandle,
};

use crate::derived::{
    GenerationDescriptor, GenerationLease, PeerAcknowledgement, PeerCandidate, PeerProposal,
    SpaceGenerationWitness,
};
use crate::mmap::BaseIndexHandle;

use super::{
    Generation, ProjectionEngine, ProjectorRuntime, PublishedCut, apply, rotation, worker,
};

const ACTIVE_CHECK: Duration = Duration::from_millis(250);
const HANDOFF_CHECK: Duration = Duration::from_millis(30);
const FREEZE_BUDGET: Duration = Duration::from_millis(400);

struct PeerWorker {
    generation: Arc<Generation>,
    stop: Cancellation,
    join: Option<JoinHandle<Result<(), PortError>>>,
    lease: Option<GenerationLease>,
}

impl PeerWorker {
    async fn stop(mut self, drain: bool) {
        self.stop.cancel();
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
        if drain
            && let Some(lease) = self.lease.take()
            && let Err(error) = lease.release_when_last().await
        {
            tracing::warn!(
                error = error.code(),
                "projection peer lease release is pending"
            );
        }
    }
}

impl Drop for PeerWorker {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct FrozenPeer {
    proposal: PeerProposal,
    until: Instant,
    _acknowledgement: Option<PeerAcknowledgement>,
    permits: Vec<LiveReadPermit>,
    _checkpoints: Vec<BaseIndexHandle>,
    _publication: FrozenPublication,
}

struct FrozenPublication {
    guard: Option<OwnedRwLockWriteGuard<()>>,
    activation: watch::Sender<u64>,
}

impl Drop for FrozenPublication {
    fn drop(&mut self) {
        drop(self.guard.take());
        self.activation
            .send_modify(|value| *value = value.wrapping_add(1));
    }
}

pub(super) struct RecoveryBoot {
    old: GenerationDescriptor,
    attempt: PeerCandidate,
    budget: CallBudget,
    started: Instant,
    uncertain: bool,
    completed: oneshot::Sender<Result<GenerationDescriptor, PortError>>,
}

impl RecoveryBoot {
    pub(super) fn new(
        old: GenerationDescriptor,
        attempt: PeerCandidate,
        budget: CallBudget,
    ) -> (
        Self,
        oneshot::Receiver<Result<GenerationDescriptor, PortError>>,
    ) {
        let (completed, receive) = oneshot::channel();
        (
            Self {
                old,
                attempt,
                budget,
                started: Instant::now(),
                uncertain: false,
                completed,
            },
            receive,
        )
    }

    fn remaining(&self) -> Duration {
        self.budget.remaining.saturating_sub(self.started.elapsed())
    }

    pub(super) async fn wait(
        receive: oneshot::Receiver<Result<GenerationDescriptor, PortError>>,
        budget: &CallBudget,
    ) -> Result<GenerationDescriptor, PortError> {
        tokio::select! {
            biased;
            confirmed = receive => confirmed.map_err(|_| not_ready())?,
            _ = budget.cancellation.cancelled() => Err(recovery_uncertain()),
            _ = tokio::time::sleep(budget.remaining) => Err(recovery_uncertain()),
        }
    }
}

/// Each process owns its candidate files and its canonical owner witnesses.
pub(super) async fn supervise(
    engine: Arc<ProjectionEngine>,
    initial_stop: Cancellation,
    stop: Cancellation,
    mut recovery: Option<RecoveryBoot>,
) {
    let mut active_worker: Option<PeerWorker> = None;
    let mut candidate: Option<(PeerCandidate, PeerWorker)> = None;
    let mut frozen: Option<FrozenPeer> = None;
    while !stop.is_cancelled() {
        let result = if let Some(boot) = recovery.as_ref() {
            if boot.budget.cancellation.is_cancelled() || boot.remaining().is_zero() {
                let error = if boot.uncertain {
                    recovery_uncertain()
                } else if boot.budget.cancellation.is_cancelled() {
                    recovery_cancelled()
                } else {
                    recovery_deadline()
                };
                let _ = recovery
                    .take()
                    .expect("pending recovery")
                    .completed
                    .send(Err(error));
                break;
            }
            match observe_recovery(&engine, boot, &mut frozen).await {
                Ok(RecoveryObservation::Activated(descriptor)) => {
                    frozen = None;
                    let _ = recovery
                        .take()
                        .expect("pending recovery")
                        .completed
                        .send(Ok(descriptor));
                    Ok(())
                }
                Ok(RecoveryObservation::Superseded) => {
                    let _ = recovery
                        .take()
                        .expect("pending recovery")
                        .completed
                        .send(Err(not_ready()));
                    break;
                }
                Ok(RecoveryObservation::Pending) => Ok(()),
                Err(error) => {
                    if matches!(
                        &error,
                        PortError::Internal(failure)
                            | PortError::Unavailable(failure)
                            | PortError::Cancelled(failure)
                            | PortError::DeadlineExceeded(failure)
                            if failure.effect() == CommitEffect::Unknown
                    ) {
                        recovery.as_mut().expect("pending recovery").uncertain = true;
                    }
                    Err(error)
                }
            }
        } else {
            observe(
                &engine,
                &initial_stop,
                &mut active_worker,
                &mut candidate,
                &mut frozen,
            )
            .await
        };
        if let Err(error) = result {
            // Preserve an acknowledged freeze until its own deadline or an
            // authoritative outcome. A lost database reply does neither.
            tracing::debug!(error = error.code(), "projection peer observation deferred");
        }
        let pause = if candidate.is_some() || recovery.is_some() {
            HANDOFF_CHECK
        } else {
            ACTIVE_CHECK
        };
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = engine.peer_handoff.notified() => {},
            _ = tokio::time::sleep(pause) => {}
        }
    }
    if let Some(held) = frozen.take() {
        // The proposal must be invalidated before an orderly participant
        // releases its canonical owner witness.
        let _ = engine.control.cancel_peer_proposal(&held.proposal).await;
    }
    if let Some((_, worker)) = candidate {
        worker.stop(true).await;
    }
    if let Some(worker) = active_worker {
        worker.stop(true).await;
    }
}

enum RecoveryObservation {
    Pending,
    Activated(GenerationDescriptor),
    Superseded,
}

async fn observe_recovery(
    engine: &ProjectionEngine,
    boot: &RecoveryBoot,
    frozen: &mut Option<FrozenPeer>,
) -> Result<RecoveryObservation, PortError> {
    let observed = engine.control.peer_observation().await?;
    let active = observed.active.ok_or_else(not_ready)?;
    let target = &boot.attempt.descriptor;
    let candidate = engine.generation.load_full();
    if candidate.store.generation() != target.generation {
        return Ok(RecoveryObservation::Superseded);
    }
    if active.generation == target.generation
        && active.publication_epoch == target.publication_epoch
    {
        // The same local worker stays in place. All participating founders
        // have proved their own checkpoint before this descriptor was installed.
        return Ok(RecoveryObservation::Activated(active));
    }
    if active != boot.old || observed.candidate.as_ref() != Some(&boot.attempt) {
        return Ok(RecoveryObservation::Superseded);
    }
    participate(
        engine,
        &candidate,
        &candidate,
        &boot.attempt,
        observed.proposal,
        frozen,
    )
    .await?;
    let remaining = boot.remaining();
    if !remaining.is_zero() && !boot.budget.cancellation.is_cancelled() {
        // commit_peer_cutover settles an uncertain CAS under a conflicting
        // control lock before reporting success. Other founders observe it.
        if let Some(next) = try_peer_cutover(engine, &boot.old, &boot.attempt, remaining).await? {
            return Ok(RecoveryObservation::Activated(next));
        }
    }
    Ok(RecoveryObservation::Pending)
}

async fn observe(
    engine: &Arc<ProjectionEngine>,
    initial_stop: &Cancellation,
    active_worker: &mut Option<PeerWorker>,
    candidate: &mut Option<(PeerCandidate, PeerWorker)>,
    frozen: &mut Option<FrozenPeer>,
) -> Result<(), PortError> {
    let observed = engine.control.peer_observation().await?;
    let active = observed.active.ok_or_else(not_ready)?;
    let current = engine.generation.load().store.generation();
    if active.generation != current {
        if let Some(held) = frozen.as_mut() {
            // The durable outcome is known. Release canonical writers while
            // still excluding old-generation delivery at this process.
            held.permits.clear();
        }
        let next = if candidate
            .as_ref()
            .is_some_and(|(_, worker)| worker.generation.store.generation() == active.generation)
        {
            candidate.take().expect("candidate matches").1
        } else {
            start_worker(engine, active.generation).await?
        };
        {
            let publication = if frozen.is_none() {
                Some(engine.publication.write().await)
            } else {
                None
            };
            apply::activate_generation(engine, &next.generation);
            *frozen = None;
            if publication.is_some() {
                drop(publication);
                engine
                    .activation
                    .send_modify(|value| *value = value.wrapping_add(1));
            }
        }
        initial_stop.cancel();
        if let Some(previous) = active_worker.replace(next) {
            previous.stop(false).await;
        }
    }

    let attempt = observed.candidate;
    if candidate.as_ref().map(|(current, _)| current) != attempt.as_ref() {
        *frozen = None;
        if let Some((_, cancelled)) = candidate.take() {
            cancelled.stop(false).await;
        }
        if let Some(attempt) = attempt {
            let worker = start_worker(engine, attempt.descriptor.generation).await?;
            *candidate = Some((attempt, worker));
        }
    }
    let Some((attempt, worker)) = candidate else {
        return Ok(());
    };
    let baseline = engine.generation.load_full();
    participate(
        engine,
        &baseline,
        &worker.generation,
        attempt,
        observed.proposal,
        frozen,
    )
    .await
}

async fn participate(
    engine: &ProjectionEngine,
    baseline: &Generation,
    candidate: &Generation,
    attempt: &PeerCandidate,
    proposal: Option<PeerProposal>,
    frozen: &mut Option<FrozenPeer>,
) -> Result<(), PortError> {
    if let Some(proposal) = proposal {
        if &proposal.candidate != attempt {
            return Ok(());
        }
        if let Some(current) = frozen
            .as_ref()
            .filter(|current| current.proposal == proposal)
        {
            if current.until <= Instant::now() {
                // The same control row serializes cancellation and CAS. Keep
                // local publication closed until observing the winner.
                engine.control.cancel_peer_proposal(&proposal).await?;
            }
            return Ok(());
        }
        *frozen = None;
        if let Some(held) = freeze(engine, baseline, candidate, proposal).await? {
            *frozen = Some(held);
        }
        return Ok(());
    }
    *frozen = None;
    let witnesses = local_readiness(engine, baseline, candidate).await?;
    if !witnesses.is_empty() {
        engine
            .control
            .record_peer_readiness(attempt, &witnesses)
            .await?;
    }
    Ok(())
}

async fn start_worker(
    engine: &Arc<ProjectionEngine>,
    generation: ProjectionGeneration,
) -> Result<PeerWorker, PortError> {
    let lease = engine
        .control
        .admit_generation_worker(generation, &engine.cache_identity)
        .await?;
    let store = engine
        .generation
        .load_full()
        .store
        .related_generation(&engine.cache_root, generation)
        .await?;
    let catalog = engine
        .canonical
        .subscribe_projection_catalog(&engine.projection_context)?;
    let spaces = engine
        .canonical
        .list_spaces(&engine.projection_context)
        .await?;
    let generation = Arc::new(Generation::new(store));
    engine
        .known_generations
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .insert(generation.store.generation(), Arc::clone(&generation));
    let stop = Cancellation::default();
    let worker_engine = Arc::clone(engine);
    let worker_generation = Arc::clone(&generation);
    let worker_stop = stop.clone();
    let worker_lease = lease.clone();
    let join = tokio::spawn(async move {
        let _lease = worker_lease;
        worker::supervise(
            worker_engine,
            worker_generation,
            spaces,
            catalog,
            worker_stop,
        )
        .await
    });
    Ok(PeerWorker {
        generation,
        stop,
        join: Some(join),
        lease: Some(lease),
    })
}

async fn local_readiness(
    engine: &ProjectionEngine,
    baseline: &Generation,
    candidate: &Generation,
) -> Result<Vec<SpaceGenerationWitness>, PortError> {
    let spaces = engine
        .canonical
        .list_spaces(&engine.projection_context)
        .await?;
    let mut ready = Vec::new();
    for (_, scope, _, _) in spaces {
        if let Some(witness) = witness(engine, baseline, candidate, &scope) {
            ready.push(witness.details);
        }
    }
    Ok(ready)
}

async fn freeze(
    engine: &ProjectionEngine,
    baseline: &Generation,
    candidate: &Generation,
    proposal: PeerProposal,
) -> Result<Option<FrozenPeer>, PortError> {
    let until = Instant::now() + FREEZE_BUDGET;
    if !proposal.spaces.values().any(|expected| {
        at_scope(baseline, &expected.scope)
            .and_then(|cut| cut.live.try_read().ok())
            .is_some_and(|permit| permit.owner_witness().process() == expected.participant)
    }) {
        return Ok(None);
    }
    let Ok(publication) = tokio::time::timeout_at(
        tokio::time::Instant::from_std(until),
        Arc::clone(&engine.publication).write_owned(),
    )
    .await
    else {
        return Ok(None);
    };
    let publication = FrozenPublication {
        guard: Some(publication),
        activation: engine.activation.clone(),
    };
    let mut permits = Vec::new();
    let mut checkpoints = Vec::new();
    let mut attestations = Vec::new();
    for expected in proposal.spaces.values() {
        if Instant::now() >= until {
            return Ok(None);
        }
        let Some(cut) = baseline
            .slot(&expected.scope.space_id)
            .and_then(|slot| slot.cut.load_full())
        else {
            continue;
        };
        let Ok(owner) = cut.live.try_read() else {
            continue;
        };
        if owner.owner_witness().process() != expected.participant {
            continue;
        }
        drop(owner);
        let Some(actual) = witness(engine, baseline, candidate, &expected.scope) else {
            drop(permits);
            engine.control.cancel_peer_proposal(&proposal).await?;
            return Ok(None);
        };
        if &actual.details != expected {
            drop(permits);
            drop(actual);
            engine.control.cancel_peer_proposal(&proposal).await?;
            return Ok(None);
        }
        attestations.push(actual.details);
        permits.push(actual.permit);
        checkpoints.push(actual.checkpoint);
    }
    if permits.is_empty() || until <= Instant::now() {
        return Ok(None);
    }
    let acknowledgement = tokio::time::timeout_at(
        tokio::time::Instant::from_std(until),
        engine
            .control
            .acknowledge_peer_cutover(&proposal, &attestations),
    )
    .await;
    match acknowledgement {
        Ok(Ok(None)) => Ok(None),
        Ok(Ok(Some(acknowledgement))) => Ok(Some(FrozenPeer {
            proposal,
            until,
            permits,
            _checkpoints: checkpoints,
            _publication: publication,
            _acknowledgement: Some(acknowledgement),
        })),
        _ => {
            // The database may have accepted an ACK whose response was lost.
            // Authoritative observation or cancellation must precede release.
            Ok(Some(FrozenPeer {
                proposal,
                until: Instant::now(),
                permits,
                _checkpoints: checkpoints,
                _publication: publication,
                _acknowledgement: None,
            }))
        }
    }
}

struct CandidateWitness {
    details: SpaceGenerationWitness,
    permit: LiveReadPermit,
    checkpoint: BaseIndexHandle,
}

fn witness(
    engine: &ProjectionEngine,
    active: &Generation,
    candidate: &Generation,
    scope: &HistoryScope,
) -> Option<CandidateWitness> {
    let old = at_scope(active, scope)?;
    let slot = candidate.slot(&scope.space_id)?;
    let new = slot.cut.load_full().filter(|cut| cut.cut.scope == *scope)?;
    let cut = old.cut.projected_seq;
    if new.cut.projected_seq != cut {
        return None;
    }
    if new.base.identity().seq != cut {
        slot.checkpoint.notify_one();
        return None;
    }
    if new.base.open(&engine.pool).is_err() {
        slot.request_repair(&new.base);
        return None;
    }
    let Ok(permit) = old.live.try_read() else {
        return None;
    };
    if permit.head() != cut || permit.scope() != scope {
        return None;
    }
    let owner = permit.owner_witness();
    let witness = SpaceGenerationWitness {
        scope: scope.clone(),
        through: cut,
        owner_epoch: owner.epoch(),
        participant: owner.process().to_owned(),
        checkpoint_digest: notarium_core::ids::ContentDigest::from_bytes(new.base.trusted_digest()),
    };
    Some(CandidateWitness {
        details: witness,
        permit,
        // The freeze holds the authenticated file lease alongside the
        // canonical permit. The mmap remains eligible for LRU eviction.
        checkpoint: new.base.clone(),
    })
}

fn at_scope(generation: &Generation, scope: &HistoryScope) -> Option<Arc<PublishedCut>> {
    generation
        .slot(&scope.space_id)?
        .admitted_cut()
        .filter(|cut| cut.cut.scope == *scope)
}

impl ProjectorRuntime {
    pub(super) async fn rotate_peers(
        &mut self,
        generation: ProjectionGeneration,
        budget: &CallBudget,
    ) -> Result<(), PortError> {
        let old = self.control.active().await?.ok_or_else(not_ready)?;
        if generation != old.generation.checked_next()? {
            return Err(DomainError::validation(ValidationReason::GenerationMismatch).into());
        }
        let catalog = self
            .engine
            .canonical
            .list_spaces(&self.engine.projection_context)
            .await?;
        let reservation = GenerationDescriptor {
            generation,
            publication_epoch: old
                .publication_epoch
                .checked_add(1)
                .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?,
            cut_fingerprint: rotation::fingerprint(&catalog)?,
        };
        let existing = self.control.peer_candidate().await?;
        let attempt = match existing {
            Some(candidate)
                if candidate.descriptor.generation == generation
                    && candidate.descriptor.publication_epoch == reservation.publication_epoch =>
            {
                candidate
            }
            Some(_) => return Err(not_ready()),
            None => {
                if !self
                    .control
                    .reserve_candidate(Some(&old), &reservation)
                    .await?
                {
                    return Err(not_ready());
                }
                self.control
                    .peer_candidate()
                    .await?
                    .filter(|candidate| candidate.descriptor == reservation)
                    .ok_or_else(not_ready)?
            }
        };
        let result = self.coordinate_cutover(&old, &attempt, budget).await;
        match result {
            Ok(next) => {
                let generation = next.generation;
                self.descriptor = next;
                self.engine.peer_handoff.notify_one();
                let mut activation = self.engine.activation.subscribe();
                tokio::time::timeout(Duration::from_millis(500), async {
                    while self.engine.generation.load().store.generation() != generation {
                        activation.changed().await.map_err(|_| not_ready())?;
                    }
                    Ok(())
                })
                .await
                .map_err(|_| {
                    unknown_commit_outcome(
                        "projection_handoff",
                        "generation descriptor switched before local activation",
                    )
                })?
            }
            Err(error) => {
                let _ = self.control.cancel_candidate(&attempt.descriptor).await;
                Err(error)
            }
        }
    }

    async fn coordinate_cutover(
        &self,
        old: &GenerationDescriptor,
        attempt: &PeerCandidate,
        budget: &CallBudget,
    ) -> Result<GenerationDescriptor, PortError> {
        let started = Instant::now();
        loop {
            let remaining = budget.remaining.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(deadline_not_committed(
                    "projection_handoff",
                    "peers did not reach the sealed cut",
                ));
            }
            if budget.cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "projection_handoff",
                    "caller cancelled",
                ));
            }
            if let Some(next) = try_peer_cutover(&self.engine, old, attempt, remaining).await? {
                return Ok(next);
            }
            tokio::select! {
                _ = budget.cancellation.cancelled() => {
                    return Err(cancelled_not_committed("projection_handoff", "caller cancelled"));
                }
                _ = tokio::time::sleep(remaining.min(HANDOFF_CHECK)) => {}
            }
        }
    }
}

async fn try_peer_cutover(
    engine: &ProjectionEngine,
    old: &GenerationDescriptor,
    attempt: &PeerCandidate,
    remaining: Duration,
) -> Result<Option<GenerationDescriptor>, PortError> {
    let mut ready = engine.control.peer_readiness(attempt).await?;
    let catalog = engine
        .canonical
        .list_spaces(&engine.projection_context)
        .await?;
    let mut exact = BTreeMap::<SpaceId, SpaceGenerationWitness>::new();
    for (_, scope, _, cut) in &catalog {
        let Some(witness) = ready.remove(&scope.space_id) else {
            return Ok(None);
        };
        if witness.scope != *scope || witness.through != *cut {
            return Ok(None);
        }
        exact.insert(scope.space_id.clone(), witness);
    }
    let Some(proposal) = engine
        .control
        .propose_peer_cutover(attempt, exact, remaining.min(FREEZE_BUDGET))
        .await?
    else {
        return Ok(None);
    };
    if !engine.control.all_peers_acknowledged(&proposal).await? {
        return Ok(None);
    }

    let control = engine.control.clone();
    let old = old.clone();
    let mut next = attempt.descriptor.clone();
    next.cut_fingerprint = rotation::fingerprint(&catalog)?;
    let expected = next.cut_fingerprint;
    let result = next.clone();
    let rejected = proposal.clone();
    let mut context = engine.projection_context();
    context.budget.remaining = remaining.min(Duration::from_millis(120));
    context.budget.cancellation = Cancellation::default();
    let accepted = engine
        .canonical
        .with_projection_catalog_seal(&context, move |sealed| async move {
            if !matches_seal(&proposal, &sealed, expected)? {
                control.cancel_peer_proposal(&proposal).await?;
                return Ok(false);
            }
            control.commit_peer_cutover(&old, &next, &proposal).await
        })
        .await;
    match accepted {
        Ok(true) => Ok(Some(result)),
        Ok(false) => Ok(None),
        Err(PortError::Domain(ref error))
            if matches!(error, DomainError::ValidationFailed { diagnostic }
                if diagnostic.reason == ValidationReason::NotReady) =>
        {
            let _ = engine.control.cancel_peer_proposal(&rejected).await;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn matches_seal(
    proposal: &PeerProposal,
    sealed: &[ProjectionCatalogSealEntry],
    fingerprint: notarium_core::ids::ContentDigest,
) -> Result<bool, PortError> {
    if sealed.len() != proposal.spaces.len()
        || sealed.iter().any(|entry| {
            let Some(expected) = proposal.spaces.get(&entry.scope.space_id) else {
                return true;
            };
            expected.scope != entry.scope
                || expected.through != entry.head
                || expected.owner_epoch != entry.epoch
                || entry.owner.as_ref().is_none_or(|owner| {
                    owner.epoch() != expected.owner_epoch || owner.process() != expected.participant
                })
        })
    {
        return Ok(false);
    }
    let catalog: Vec<_> = sealed
        .iter()
        .map(|entry| {
            (
                notarium_core::auth::Space {
                    id: entry.scope.space_id.clone(),
                    kind: entry.kind,
                    lifecycle: entry.lifecycle,
                },
                entry.scope.clone(),
                entry.root_folder_id.clone(),
                entry.head,
            )
        })
        .collect();
    Ok(rotation::fingerprint(&catalog)? == fingerprint)
}

fn recovery_cancelled() -> PortError {
    cancelled_not_committed("projection_format_recovery", "caller cancelled")
}

fn recovery_deadline() -> PortError {
    deadline_not_committed(
        "projection_format_recovery",
        "peers did not reach the sealed cut",
    )
}

fn recovery_uncertain() -> PortError {
    unknown_commit_outcome(
        "projection_format_recovery",
        "local startup ended before the durable result was confirmed",
    )
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}
