use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, LeaseEpoch, ProjectionGeneration, SpaceId, SpaceSeq},
    model::HistoryScope,
};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, pool::PoolConnection};
use tokio::sync::oneshot;

use super::{
    ControlBackend, GenerationControl, GenerationDescriptor, read_postgres, read_postgres_shared,
    validate_transition,
};
use crate::derived::{
    internal, invalid_row,
    maintenance::reset_obsolete_postgres,
    not_ready,
    records::{decode, encode},
    sql::{Database, Kind, SqlColumn, SqlTransaction, SqlValue, value},
    stale,
};

/// An attempt remains distinct when a generation number is reused after abort.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PeerCandidate {
    pub descriptor: GenerationDescriptor,
    pub attempt: [u8; 16],
}

/// Candidate readiness attested while holding the matching canonical owner.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SpaceGenerationWitness {
    pub scope: HistoryScope,
    pub through: SpaceSeq,
    pub owner_epoch: LeaseEpoch,
    pub participant: String,
    pub checkpoint_digest: ContentDigest,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PeerProposal {
    pub candidate: PeerCandidate,
    pub nonce: [u8; 16],
    pub deadline_ms: i64,
    pub spaces: BTreeMap<SpaceId, SpaceGenerationWitness>,
}

#[derive(Serialize, Deserialize)]
struct PeerState {
    candidate: PeerCandidate,
    ready: BTreeMap<SpaceId, SpaceGenerationWitness>,
    proposal: Option<PeerProposal>,
    acknowledged: BTreeMap<SpaceId, SpaceGenerationWitness>,
    presence: BTreeMap<String, i64>,
    #[serde(default)]
    obsolete_format: bool,
}

pub(crate) struct PeerObservation {
    pub active: Option<GenerationDescriptor>,
    pub candidate: Option<PeerCandidate>,
    pub proposal: Option<PeerProposal>,
}

/// A session-bound witness held only during the short frozen phase.
pub struct PeerAcknowledgement {
    connection: PoolConnection<Postgres>,
    key: i64,
}

impl PeerAcknowledgement {
    pub async fn release(mut self) -> Result<(), PortError> {
        let released: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1)")
            .bind(self.key)
            .fetch_one(&mut *self.connection)
            .await
            .map_err(|_| internal("projection_peer_presence"))?;
        if !released {
            return Err(internal("projection_peer_presence"));
        }
        self.connection
            .close()
            .await
            .map_err(|_| internal("projection_peer_presence"))
    }
}

impl GenerationControl {
    pub fn is_distributed(&self) -> bool {
        matches!(self.0.as_ref(), ControlBackend::Postgres(_))
    }

    pub async fn peer_candidate(&self) -> Result<Option<PeerCandidate>, PortError> {
        Ok(self.peer_state().await?.map(|state| state.candidate))
    }

    /// Joins a format-recovery attempt only after the active generation has
    /// drained. A new reservation closes old admission under the control row.
    pub(crate) async fn reserve_format_recovery(
        &self,
        expected: &GenerationDescriptor,
        next: &GenerationDescriptor,
    ) -> Result<Option<PeerCandidate>, PortError> {
        validate_transition(Some(expected), next)?;
        let expected = expected.clone();
        let next = next.clone();
        self.postgres()?
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let mut state = read_postgres(&mut tx, true).await?;
                    if state.active.as_ref() != Some(&expected)
                        || has_generation_users(&mut tx, expected.generation).await?
                    {
                        return Ok(None);
                    }
                    if let Some(peer) = peer_row(&mut tx).await? {
                        if state.candidate.as_ref() != Some(&peer.candidate.descriptor) {
                            return Err(invalid_row());
                        }
                        if peer.candidate.descriptor.generation != next.generation
                            || peer.candidate.descriptor.publication_epoch != next.publication_epoch
                        {
                            return Ok(None);
                        }
                        if peer.obsolete_format {
                            return Ok(Some(peer.candidate));
                        }
                        if has_generation_users(&mut tx, next.generation).await? {
                            return Ok(None);
                        }
                    } else if state.candidate.is_some() {
                        return Err(invalid_row());
                    }
                    let peer = new_attempt(&next, true)?;
                    write_peer_row(&mut tx, &peer).await?;
                    state.candidate = Some(next);
                    tx.execute(
                        "UPDATE projection_generation_control SET descriptor = ? WHERE row_id = 1",
                        vec![value(&encode(&state)?)],
                    )
                    .await?;
                    Ok(Some(peer.candidate))
                })
            })
            .await
    }

    pub(crate) async fn reset_obsolete_candidate(
        &self,
        old: &GenerationDescriptor,
        candidate: &PeerCandidate,
    ) -> Result<(), PortError> {
        let database = self.postgres()?;
        let (_, control_schema) = database.postgres_config().ok_or_else(invalid_row)?;
        let prefix = control_schema
            .strip_suffix("_ctrl")
            .ok_or_else(invalid_row)?;
        let generation = candidate.descriptor.generation;
        let schema = format!("{prefix}_g{}", generation.get());
        let old = old.clone();
        let candidate = candidate.clone();
        database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let state = read_postgres(&mut tx, true).await?;
                    if state.active.as_ref() == Some(&old)
                        && state.candidate.as_ref() == Some(&candidate.descriptor)
                        && peer_row(&mut tx)
                            .await?
                            .is_some_and(|peer| peer.obsolete_format && peer.candidate == candidate)
                        && !has_generation_users(&mut tx, generation).await?
                    {
                        reset_obsolete_postgres(&mut tx, &schema, generation).await?;
                    }
                    Ok(())
                })
            })
            .await
    }

    pub(crate) async fn peer_observation(&self) -> Result<PeerObservation, PortError> {
        self.postgres()?
            .read(|mut tx| {
                Box::pin(async move {
                    let descriptor = read_postgres(&mut tx, false).await?;
                    let peers = peer_row(&mut tx).await?;
                    if peers.as_ref().map(|state| &state.candidate.descriptor)
                        != descriptor.candidate.as_ref()
                    {
                        return Err(invalid_row());
                    }
                    let (candidate, proposal) = peers
                        .map(|state| (Some(state.candidate), state.proposal))
                        .unwrap_or_default();
                    Ok(PeerObservation {
                        active: descriptor.active,
                        candidate,
                        proposal,
                    })
                })
            })
            .await
    }

    pub async fn peer_proposal(&self) -> Result<Option<PeerProposal>, PortError> {
        Ok(self.peer_state().await?.and_then(|state| state.proposal))
    }

    pub async fn peer_readiness(
        &self,
        candidate: &PeerCandidate,
    ) -> Result<BTreeMap<SpaceId, SpaceGenerationWitness>, PortError> {
        let state = self.peer_state().await?.ok_or_else(not_ready)?;
        if state.candidate != *candidate {
            return Err(stale());
        }
        Ok(state.ready)
    }

    pub async fn record_peer_readiness(
        &self,
        candidate: &PeerCandidate,
        witnesses: &[SpaceGenerationWitness],
    ) -> Result<(), PortError> {
        let witnesses = checked_witnesses(witnesses)?;
        self.peer_update(candidate.clone(), move |state, now| {
            let invalidated = state.proposal.as_ref().is_some_and(|proposal| {
                proposal.deadline_ms <= now
                    || witnesses
                        .iter()
                        .any(|(space, witness)| proposal.spaces.get(space) != Some(witness))
            });
            if invalidated {
                state.proposal = None;
                state.acknowledged.clear();
                state.presence.clear();
            }
            let changed = invalidated
                || witnesses
                    .iter()
                    .any(|(space, witness)| state.ready.get(space) != Some(witness));
            state.ready.extend(witnesses);
            ((), changed)
        })
        .await
    }

    pub async fn propose_peer_cutover(
        &self,
        candidate: &PeerCandidate,
        exact: BTreeMap<SpaceId, SpaceGenerationWitness>,
        ttl: Duration,
    ) -> Result<Option<PeerProposal>, PortError> {
        let candidate = candidate.clone();
        let ttl = ttl.min(Duration::from_millis(500)).as_millis().max(1) as i64;
        let nonce = entropy()?;
        self.peer_update(candidate.clone(), move |state, now| {
            if exact
                .iter()
                .any(|(space, witness)| state.ready.get(space) != Some(witness))
            {
                return (None, false);
            }
            if let Some(existing) = state
                .proposal
                .as_ref()
                .filter(|proposal| proposal.deadline_ms > now)
            {
                return ((existing.spaces == exact).then(|| existing.clone()), false);
            }
            let proposal = PeerProposal {
                candidate,
                nonce,
                deadline_ms: now.saturating_add(ttl),
                spaces: exact,
            };
            state.proposal = Some(proposal.clone());
            state.acknowledged.clear();
            state.presence.clear();
            (Some(proposal), true)
        })
        .await
    }

    pub async fn acknowledge_peer_cutover(
        &self,
        proposal: &PeerProposal,
        frozen: &[SpaceGenerationWitness],
    ) -> Result<Option<PeerAcknowledgement>, PortError> {
        let proposal = proposal.clone();
        let witnesses = checked_witnesses(frozen)?;
        let Some(first) = witnesses.values().next() else {
            return Ok(None);
        };
        let participant = first.participant.clone();
        if witnesses
            .values()
            .any(|witness| witness.participant != participant)
        {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
        let (pool, _) = self.postgres()?.postgres_config().ok_or_else(invalid_row)?;
        let mut connection = pool
            .acquire()
            .await
            .map_err(|_| internal("projection_peer_presence"))?;
        // Closing the connection also revokes the session-level lock on
        // cancellation, an uncertain ACK, or loss of the peer process.
        connection.close_on_drop();
        let key = i64::from_le_bytes(entropy()?[..8].try_into().map_err(|_| invalid_row())?);
        let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
            .bind(key)
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| internal("projection_peer_presence"))?;
        if !locked {
            return Ok(None);
        }
        let accepted = self
            .peer_update(proposal.candidate.clone(), move |state, now| {
                if state.proposal.as_ref() != Some(&proposal)
                    || now >= proposal.deadline_ms
                    || witnesses
                        .iter()
                        .any(|(space, witness)| proposal.spaces.get(space) != Some(witness))
                    || proposal.spaces.iter().any(|(space, witness)| {
                        witness.participant == participant && witnesses.get(space) != Some(witness)
                    })
                {
                    return (false, false);
                }
                let changed = state.presence.insert(participant, key) != Some(key);
                state.acknowledged.extend(witnesses);
                (true, changed)
            })
            .await?;
        Ok(accepted.then_some(PeerAcknowledgement { connection, key }))
    }

    pub async fn cancel_peer_proposal(&self, proposal: &PeerProposal) -> Result<bool, PortError> {
        let proposal = proposal.clone();
        self.peer_update(proposal.candidate.clone(), move |state, _| {
            if state.proposal.as_ref() != Some(&proposal) {
                return (false, false);
            }
            state.proposal = None;
            state.acknowledged.clear();
            state.presence.clear();
            (true, true)
        })
        .await
    }

    pub async fn all_peers_acknowledged(&self, proposal: &PeerProposal) -> Result<bool, PortError> {
        let Some(state) = self.peer_state().await? else {
            return Ok(false);
        };
        Ok(state.proposal.as_ref() == Some(proposal) && state.acknowledged == proposal.spaces)
    }

    /// The caller keeps the matching canonical catalogue seal until this
    /// operation commits or settles an uncertain commit outcome.
    pub async fn commit_peer_cutover(
        &self,
        expected: &GenerationDescriptor,
        next: &GenerationDescriptor,
        proposal: &PeerProposal,
    ) -> Result<bool, PortError> {
        validate_transition(Some(expected), next)?;
        let database = self.postgres()?.clone();
        let expected = expected.clone();
        let next = next.clone();
        let verify = next.clone();
        let proposal = proposal.clone();
        let result = database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let mut state = read_postgres(&mut tx, true).await?;
                    if state.active.as_ref() != Some(&expected)
                        || state.candidate.as_ref() != Some(&proposal.candidate.descriptor)
                        || next.generation != proposal.candidate.descriptor.generation
                        || next.publication_epoch != proposal.candidate.descriptor.publication_epoch
                    {
                        return Ok(false);
                    }
                    let state_peer = peer_row(&mut tx).await?.ok_or_else(not_ready)?;
                    if state_peer.proposal.as_ref() != Some(&proposal)
                        || state_peer.acknowledged != proposal.spaces
                        || now_ms(&mut tx).await? >= proposal.deadline_ms
                        || (state_peer.obsolete_format
                            && has_generation_users(&mut tx, expected.generation).await?)
                    {
                        return Ok(false);
                    }
                    let participants: BTreeSet<_> = proposal
                        .spaces
                        .values()
                        .map(|witness| witness.participant.as_str())
                        .collect();
                    if !participants
                        .iter()
                        .copied()
                        .eq(state_peer.presence.keys().map(String::as_str))
                    {
                        return Ok(false);
                    }
                    for key in state_peer.presence.values() {
                        if !tx
                            .select(
                                "SELECT CAST(1 AS BIGINT) WHERE pg_try_advisory_xact_lock(?)",
                                vec![value(key)],
                                &[Kind::Integer],
                            )
                            .await?
                            .is_empty()
                        {
                            return Ok(false);
                        }
                    }
                    state.active = Some(next);
                    state.candidate = None;
                    clear_attempt(&mut tx).await?;
                    tx.execute(
                        "UPDATE projection_generation_control SET descriptor = ? WHERE row_id = 1",
                        vec![value(&encode(&state)?)],
                    )
                    .await?;
                    Ok(true)
                })
            })
            .await;
        match result {
            Err(PortError::Internal(error))
                if error.effect() == notarium_core::error::CommitEffect::Unknown =>
            {
                // Take a conflicting lock to settle the DB commit while the
                // caller still holds the canonical seal.
                database
                    .write(false, move |mut tx| {
                        Box::pin(async move {
                            Ok(
                                read_postgres(&mut tx, true).await?.active.as_ref()
                                    == Some(&verify),
                            )
                        })
                    })
                    .await
            }
            result => result,
        }
    }

    /// Registers an Open against the same control row used for the flip.
    pub async fn admit_generation_read(
        &self,
        generation: ProjectionGeneration,
        participant: &str,
    ) -> Result<GenerationLease, PortError> {
        self.admit_generation(generation, participant, false).await
    }

    pub(crate) async fn admit_generation_worker(
        &self,
        generation: ProjectionGeneration,
        participant: &str,
    ) -> Result<GenerationLease, PortError> {
        self.admit_generation(generation, participant, true).await
    }

    async fn admit_generation(
        &self,
        generation: ProjectionGeneration,
        participant: &str,
        allow_candidate: bool,
    ) -> Result<GenerationLease, PortError> {
        let ControlBackend::Postgres(database) = self.0.as_ref() else {
            if self
                .active()
                .await?
                .is_none_or(|active| active.generation != generation)
            {
                return Err(stale());
            }
            return Ok(GenerationLease::new(None));
        };
        if participant.is_empty() || participant.len() > 128 {
            return Err(DomainError::validation(ValidationReason::InvalidId).into());
        }
        let participant = participant.to_owned();
        let identity = LeaseIdentity {
            generation,
            id: entropy()?,
        };
        let database = Arc::clone(database);
        let (ready, admitted) = oneshot::channel();
        // Keep the SQL transaction and the lease in the same task. Its
        // lifetime is independent of the Open waiting for the response.
        tokio::spawn(async move {
            let (release, released) = oneshot::channel();
            let (done, completed) = oneshot::channel();
            let lease = GenerationLease::new(Some(LeaseRelease { release, completed }));
            match register_lease(&database, identity, participant, allow_candidate).await {
                Ok(()) => {
                    let _ = ready.send(Ok(lease));
                }
                Err(error) => {
                    let uncertain = matches!(&error, PortError::Internal(failure)
                        if failure.effect() == notarium_core::error::CommitEffect::Unknown);
                    drop(lease);
                    let _ = ready.send(Err(error));
                    if !uncertain {
                        return;
                    }
                }
            }
            // The last guard can be dropped on any thread. This task already
            // lives on the executor that owns the pool and needs no Drop spawn.
            let _ = released.await;
            let _ = done.send(release_lease(&database, identity).await);
        });
        admitted
            .await
            .map_err(|_| internal("projection_generation_lease_admission"))?
    }

    /// An already-held process lease prevents reclamation while this Open
    /// checks the current durable descriptor with a read-only transaction.
    pub async fn check_active_generation(
        &self,
        generation: ProjectionGeneration,
    ) -> Result<(), PortError> {
        if self
            .active()
            .await?
            .is_none_or(|active| active.generation != generation)
        {
            return Err(stale());
        }
        Ok(())
    }

    /// A lost process's lease stays present. Expiry is insufficient evidence
    /// that the process released its files or stopped serving old reads.
    pub async fn generation_reclaimable(
        &self,
        generation: ProjectionGeneration,
    ) -> Result<bool, PortError> {
        self.postgres()?
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let state = read_postgres(&mut tx, true).await?;
                    if state
                        .active
                        .is_none_or(|active| active.generation <= generation)
                        || state
                            .candidate
                            .is_some_and(|candidate| candidate.generation == generation)
                    {
                        return Ok(false);
                    }
                    Ok(!has_generation_users(&mut tx, generation).await?)
                })
            })
            .await
    }

    fn postgres(&self) -> Result<&Arc<Database>, PortError> {
        match self.0.as_ref() {
            ControlBackend::Postgres(database) => Ok(database),
            ControlBackend::Local(_) => {
                Err(DomainError::validation(ValidationReason::InvalidState).into())
            }
        }
    }

    async fn peer_state(&self) -> Result<Option<PeerState>, PortError> {
        self.postgres()?
            .read(|mut tx| Box::pin(async move { peer_row(&mut tx).await }))
            .await
    }

    async fn peer_update<T: Send + 'static>(
        &self,
        candidate: PeerCandidate,
        operation: impl FnOnce(&mut PeerState, i64) -> (T, bool) + Send + 'static,
    ) -> Result<T, PortError> {
        self.postgres()?
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let descriptor = read_postgres(&mut tx, true).await?;
                    if descriptor.candidate.as_ref() != Some(&candidate.descriptor) {
                        return Err(stale());
                    }
                    let mut state = peer_row(&mut tx).await?.ok_or_else(not_ready)?;
                    if state.candidate != candidate {
                        return Err(stale());
                    }
                    let now = now_ms(&mut tx).await?;
                    let (result, changed) = operation(&mut state, now);
                    if changed {
                        write_peer_row(&mut tx, &state).await?;
                    }
                    Ok(result)
                })
            })
            .await
    }
}

async fn reject_recovery_of_active_generation(
    tx: &mut SqlTransaction<'_>,
    generation: ProjectionGeneration,
    active: Option<&GenerationDescriptor>,
    candidate: Option<&GenerationDescriptor>,
) -> Result<(), PortError> {
    if active.is_some_and(|active| active.generation == generation)
        && let Some(candidate) = candidate
    {
        let state = peer_row(tx).await?.ok_or_else(invalid_row)?;
        if &state.candidate.descriptor != candidate {
            return Err(invalid_row());
        }
        if state.obsolete_format {
            return Err(not_ready());
        }
    }
    Ok(())
}

async fn has_generation_users(
    tx: &mut SqlTransaction<'_>,
    generation: ProjectionGeneration,
) -> Result<bool, PortError> {
    Ok(!tx
        .select(
            "SELECT CAST(1 AS BIGINT) FROM projection_generation_read_leases
             WHERE generation = ? LIMIT 1",
            vec![value(&generation)],
            &[Kind::Integer],
        )
        .await?
        .is_empty())
}

#[derive(Clone, Copy)]
struct LeaseIdentity {
    generation: ProjectionGeneration,
    id: [u8; 16],
}

impl LeaseIdentity {
    async fn lock(self, tx: &mut SqlTransaction<'_>) -> Result<(), PortError> {
        let key = i64::from_le_bytes(self.id[..8].try_into().expect("lease key prefix"));
        tx.execute("SELECT pg_advisory_xact_lock(?)", vec![value(&key)])
            .await?;
        Ok(())
    }

    fn values(self) -> Vec<SqlValue> {
        vec![value(&self.generation), value(&self.id.to_vec())]
    }
}

async fn register_lease(
    database: &Arc<Database>,
    identity: LeaseIdentity,
    participant: String,
    allow_candidate: bool,
) -> Result<(), PortError> {
    database
        .write(false, move |mut tx| {
            Box::pin(async move {
                let state = read_postgres_shared(&mut tx).await?;
                reject_recovery_of_active_generation(
                    &mut tx,
                    identity.generation,
                    state.active.as_ref(),
                    state.candidate.as_ref(),
                )
                .await?;
                if !state
                    .active
                    .is_some_and(|active| active.generation == identity.generation)
                    && !(allow_candidate
                        && state
                            .candidate
                            .is_some_and(|candidate| candidate.generation == identity.generation))
                {
                    return Err(stale());
                }
                // Send INSERT only after acquiring this transaction-scoped lock.
                // A release after an uncertain COMMIT must observe its final outcome.
                identity.lock(&mut tx).await?;
                let mut values = identity.values();
                values.push(value(&participant));
                tx.execute(
            "INSERT INTO projection_generation_read_leases (generation, lease_id, participant)
             VALUES (?, ?, ?)",
            values,
        ).await?;
                Ok(())
            })
        })
        .await
}

async fn release_lease(database: &Arc<Database>, identity: LeaseIdentity) -> Result<(), PortError> {
    const INITIAL_DELAY: Duration = Duration::from_millis(10);
    const MAX_DELAY: Duration = Duration::from_secs(1);
    const MAX_ATTEMPT: Duration = Duration::from_secs(2);

    let (pool, _) = database.postgres_config().ok_or_else(invalid_row)?;
    let mut delay = INITIAL_DELAY;
    loop {
        let cleanup = database.write(false, move |mut tx| Box::pin(async move {
            // In READ COMMITTED the next statement starts a fresh snapshot.
            // Putting the wait inside the DELETE would use an older snapshot.
            identity.lock(&mut tx).await?;
            tx.execute(
                "DELETE FROM projection_generation_read_leases WHERE generation = ? AND lease_id = ?",
                identity.values(),
            ).await?;
            Ok(())
        }));
        if matches!(tokio::time::timeout(MAX_ATTEMPT, cleanup).await, Ok(Ok(()))) {
            return Ok(());
        }
        if pool.is_closed() {
            return Err(internal("projection_generation_lease_pool_closed"));
        }
        if delay == INITIAL_DELAY {
            tracing::warn!("projection generation lease release will retry");
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(MAX_DELAY);
    }
}

/// An admitted read keeps this lease until its retained cut is released.
#[derive(Clone)]
pub struct GenerationLease {
    inner: Arc<GenerationLeaseInner>,
}

impl GenerationLease {
    fn new(release: Option<LeaseRelease>) -> Self {
        Self {
            inner: Arc::new(GenerationLeaseInner { release }),
        }
    }

    /// A worker or a runtime may drain its own final lease on orderly
    /// shutdown. Public holders can continue independently.
    pub(crate) async fn release_when_last(self) -> Result<(), PortError> {
        let Some(GenerationLeaseInner {
            release: Some(release),
        }) = Arc::into_inner(self.inner)
        else {
            return Ok(());
        };
        let LeaseRelease { release, completed } = release;
        drop(release);
        // The cleanup actor keeps retrying if the shutdown wait expires.
        tokio::time::timeout(Duration::from_secs(3), completed)
            .await
            .map_err(|_| internal("projection_generation_lease_release_pending"))?
            .map_err(|_| internal("projection_generation_lease_release_worker"))?
    }
}

struct GenerationLeaseInner {
    release: Option<LeaseRelease>,
}

struct LeaseRelease {
    release: oneshot::Sender<()>,
    completed: oneshot::Receiver<Result<(), PortError>>,
}

pub(super) async fn begin_attempt(
    tx: &mut SqlTransaction<'_>,
    descriptor: &GenerationDescriptor,
) -> Result<(), PortError> {
    write_peer_row(tx, &new_attempt(descriptor, false)?).await
}

fn new_attempt(
    descriptor: &GenerationDescriptor,
    obsolete_format: bool,
) -> Result<PeerState, PortError> {
    Ok(PeerState {
        candidate: PeerCandidate {
            descriptor: descriptor.clone(),
            attempt: entropy()?,
        },
        ready: BTreeMap::new(),
        proposal: None,
        acknowledged: BTreeMap::new(),
        presence: BTreeMap::new(),
        obsolete_format,
    })
}

pub(super) async fn clear_attempt(tx: &mut SqlTransaction<'_>) -> Result<(), PortError> {
    tx.execute(
        "DELETE FROM projection_generation_peer_handoff WHERE row_id = 1",
        Vec::new(),
    )
    .await?;
    Ok(())
}

async fn peer_row(tx: &mut SqlTransaction<'_>) -> Result<Option<PeerState>, PortError> {
    let bytes = tx
        .select(
            "SELECT state FROM projection_generation_peer_handoff WHERE row_id = 1",
            Vec::new(),
            &[Kind::Bytes],
        )
        .await?
        .pop()
        .and_then(|mut row| row.pop());
    bytes
        .map(|bytes| decode(&Vec::<u8>::read(bytes)?))
        .transpose()
}

async fn write_peer_row(tx: &mut SqlTransaction<'_>, state: &PeerState) -> Result<(), PortError> {
    tx.execute(
        "INSERT INTO projection_generation_peer_handoff (row_id, state) VALUES (1, ?)
         ON CONFLICT (row_id) DO UPDATE SET state = excluded.state",
        vec![value(&encode(state)?)],
    )
    .await?;
    Ok(())
}

async fn now_ms(tx: &mut SqlTransaction<'_>) -> Result<i64, PortError> {
    let value = tx
        .select(
            "SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)",
            Vec::new(),
            &[Kind::Integer],
        )
        .await?
        .pop()
        .and_then(|mut row| row.pop())
        .ok_or_else(invalid_row)?;
    i64::read(value)
}

fn entropy() -> Result<[u8; 16], PortError> {
    let mut value = [0; 16];
    getrandom::fill(&mut value).map_err(|_| internal("projection_control_entropy"))?;
    Ok(value)
}

fn checked_witnesses(
    values: &[SpaceGenerationWitness],
) -> Result<BTreeMap<SpaceId, SpaceGenerationWitness>, PortError> {
    let mut witnesses = BTreeMap::new();
    for witness in values {
        if witness.participant.is_empty()
            || witness.participant.len() > 128
            || witnesses
                .insert(witness.scope.space_id.clone(), witness.clone())
                .is_some()
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
    }
    Ok(witnesses)
}
