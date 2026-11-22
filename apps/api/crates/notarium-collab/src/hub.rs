use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use notarium_canonical::{
    CanonicalStore, CollabRoomState, CommittedTargets, NoteCollabAdmissionMeta, OpenCollabSession,
    SpaceSignal,
};
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, PrincipalKind},
    classes::DocClass,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{ContentDigest, LineageEpoch, NoteId, RequestId, SpaceId},
    model::HistoryScope,
    ports::{
        CallBudget, Cancellation, MaintenanceContext, PortFuture, RevocationLease,
        RevocationReason, RevocationSelector, ServiceAuthority, ServicePurpose,
        SessionRevocationPort, SpaceContext,
    },
};
use tokio::{
    sync::{Mutex as AsyncMutex, Semaphore, broadcast, mpsc},
    time::{Instant, timeout},
};

use crate::{
    interceptor::WeakInterceptor,
    room::{JoinOutcome, Room, RoomCommand, RoomHandle, recover_fenced},
    session::{
        CollabPeerSession, CollabSessionAuth, OutboundAuthority, PeerGuard, PeerOutbound,
        SessionClose,
    },
    wire::{LineageHello, LineageMismatch, PeerRole, decode_hello},
};

const OPEN_ATTEMPTS: usize = 3;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_MAX_ACTIVE_ROOMS: usize = 512;
const DEFAULT_MAX_ROOMS_PER_SPACE: usize = 128;
const DEFAULT_MAX_TOTAL_PEERS: usize = 4096;
const LIFECYCLE_DRAIN_CONCURRENCY: usize = 32;

#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct CollabConfig {
    pub idle_checkpoint: Duration,
    pub periodic_checkpoint: Duration,
    pub checkpoint_updates: u64,
    pub wal_coalesce: Duration,
    pub idle_unload: Duration,
    pub handshake_timeout: Duration,
    pub max_active_rooms: usize,
    pub max_rooms_per_space: usize,
    pub max_total_peers: usize,
}

impl Default for CollabConfig {
    fn default() -> Self {
        Self {
            idle_checkpoint: Duration::from_secs(3),
            periodic_checkpoint: Duration::from_secs(60),
            checkpoint_updates: 128,
            wal_coalesce: Duration::from_millis(2),
            idle_unload: Duration::from_secs(30),
            handshake_timeout: Duration::from_secs(10),
            max_active_rooms: DEFAULT_MAX_ACTIVE_ROOMS,
            max_rooms_per_space: DEFAULT_MAX_ROOMS_PER_SPACE,
            max_total_peers: DEFAULT_MAX_TOTAL_PEERS,
        }
    }
}

impl CollabConfig {
    fn valid(&self) -> bool {
        let now = Instant::now();
        self.checkpoint_updates > 0
            && (1..=Semaphore::MAX_PERMITS).contains(&self.max_active_rooms)
            && (1..=Semaphore::MAX_PERMITS).contains(&self.max_rooms_per_space)
            && (1..=Semaphore::MAX_PERMITS).contains(&self.max_total_peers)
            && !self.idle_checkpoint.is_zero()
            && !self.periodic_checkpoint.is_zero()
            && !self.handshake_timeout.is_zero()
            && self.idle_unload >= self.idle_checkpoint
            && self.wal_coalesce < Duration::from_millis(3)
            && [
                self.idle_checkpoint,
                self.periodic_checkpoint,
                self.wal_coalesce,
                self.idle_unload,
                self.handshake_timeout,
            ]
            .into_iter()
            .all(|duration| now.checked_add(duration).is_some())
    }
}

pub(crate) struct SpaceRoomPermit {
    hub: Weak<HubInner>,
    space: SpaceId,
}

impl Drop for SpaceRoomPermit {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            let mut counts = hub.space_room_counts.lock().expect("space room counts");
            if let Some(count) = counts.get_mut(&self.space) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    counts.remove(&self.space);
                }
            }
        }
    }
}

type RoomKey = (SpaceId, NoteId);

pub(crate) struct RoomSlot {
    key: RoomKey,
    hub: Weak<HubInner>,
    state: AsyncMutex<Option<RoomHandle>>,
}

impl Drop for RoomSlot {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            let mut slots = hub.slots.lock().expect("room registry");
            if slots
                .get(&self.key)
                .is_some_and(|slot| std::ptr::eq(slot.as_ptr(), self))
            {
                slots.remove(&self.key);
            }
        }
    }
}

pub(crate) struct HubInner {
    pub store: CanonicalStore,
    pub config: CollabConfig,
    pub owner: Arc<str>,
    entropy: u64,
    next_id: AtomicU64,
    slots: Mutex<HashMap<RoomKey, Weak<RoomSlot>>>,
    active: Mutex<HashMap<RoomKey, RoomHandle>>,
    room_capacity: Arc<Semaphore>,
    space_room_counts: Mutex<HashMap<SpaceId, usize>>,
    peer_capacity: Arc<Semaphore>,
    peers: Mutex<HashMap<u64, PeerRegistration>>,
    pending_revoke_settlement: Mutex<PendingRevokeSettlement>,
    unsettled_shutdown_rooms: Mutex<HashSet<(HistoryScope, NoteId)>>,
    accept_closed: Cancellation,
    shutdown: Cancellation,
}

#[derive(Default)]
struct PendingRevokeSettlement {
    seq: u64,
    rooms: HashMap<RoomKey, HashMap<u64, PendingRevoke>>,
}

struct PendingRevoke {
    rev_seq: u64,
    ctx: SpaceContext,
}

struct PeerRegistration {
    note: NoteId,
    ctx: SpaceContext,
    guard: Weak<PeerGuard>,
}

impl Drop for HubInner {
    fn drop(&mut self) {
        self.accept_closed.cancel();
        self.shutdown.cancel();
    }
}

/// The trusted composition owner keeps one hub for each canonical runtime.
#[derive(Clone)]
pub struct CollabHub(pub(crate) Arc<HubInner>);

impl CollabHub {
    pub fn new(store: CanonicalStore, config: CollabConfig) -> Result<Self, PortError> {
        if !config.valid() {
            return Err(DomainError::validation(ValidationReason::InvalidRange).into());
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| operation_error(b"collab_runtime_missing", CommitEffect::NotCommitted))?;
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy)
            .map_err(|_| operation_error(b"collab_owner_entropy", CommitEffect::NotCommitted))?;
        let owner: Arc<str> = Arc::from(format!("collab-{:032x}", u128::from_be_bytes(entropy)));
        let entropy = u64::from_be_bytes(entropy[..8].try_into().expect("fixed entropy length"));
        let signals = store.subscribe_space_signals();
        let inner = Arc::new(HubInner {
            store,
            room_capacity: Arc::new(Semaphore::new(config.max_active_rooms)),
            space_room_counts: Mutex::default(),
            peer_capacity: Arc::new(Semaphore::new(config.max_total_peers)),
            config,
            owner,
            entropy,
            next_id: AtomicU64::new(1),
            slots: Mutex::default(),
            active: Mutex::default(),
            peers: Mutex::default(),
            pending_revoke_settlement: Mutex::default(),
            unsettled_shutdown_rooms: Mutex::default(),
            accept_closed: Cancellation::default(),
            shutdown: Cancellation::default(),
        });
        runtime.spawn(watch_storage(
            Arc::downgrade(&inner),
            inner.shutdown.clone(),
            signals,
        ));
        Ok(Self(inner))
    }

    /// Register the hub's interceptor without creating a store-to-hub ownership cycle.
    pub fn register(&self) -> Result<(), PortError> {
        self.0
            .store
            .register_collab_interceptor(Arc::new(WeakInterceptor(Arc::downgrade(&self.0))))
    }

    /// Wrap the composition owner's shared registry so post-commit revocations
    /// settle rooms before the control plane finishes a Space close.
    pub fn revocations(
        &self,
        registry: Arc<dyn SessionRevocationPort>,
    ) -> Arc<dyn SessionRevocationPort> {
        Arc::new(CollabRevocations {
            hub: Arc::downgrade(&self.0),
            registry,
        })
    }

    pub fn active_room_count(&self) -> usize {
        self.0.active.lock().expect("active rooms").len()
    }

    /// Gracefully reject new peers, settle and close all active rooms cleanly
    /// within `budget`, and stop background watchers.
    pub async fn shutdown(&self, budget: &CallBudget) -> Result<(), PortError> {
        let deadline = Instant::now()
            .checked_add(budget.remaining)
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidRange))?;
        self.0.accept_closed.cancel();

        // Close any peers still waiting on initial handshake or connected.
        let guards: Vec<_> = {
            self.0
                .peers
                .lock()
                .expect("peer registry")
                .values()
                .filter_map(|peer| peer.guard.upgrade())
                .collect()
        };
        for guard in guards {
            guard.close(SessionClose::GOING_AWAY);
        }

        // Wait for any in-flight room opens to register their handles.
        let slots: Vec<_> = {
            self.0
                .slots
                .lock()
                .expect("room registry")
                .values()
                .filter_map(Weak::upgrade)
                .collect()
        };
        for slot in slots {
            let mut slot_budget = budget.clone();
            slot_budget.remaining = deadline.saturating_duration_since(Instant::now());
            drop(lock_slot(&slot, &slot_budget).await?);
        }

        let mut first_error = None;
        let mut pending_rooms = self.0.active_rooms().into_iter();
        let mut draining = tokio::task::JoinSet::new();
        let spawn_room_shutdown = |set: &mut tokio::task::JoinSet<Result<(), PortError>>,
                                   room: RoomHandle,
                                   budget: CallBudget,
                                   deadline: Instant| {
            set.spawn(async move {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let mut room_budget = budget;
                room_budget.remaining = remaining;
                match timeout(remaining, room.shutdown(room_budget)).await {
                    Ok(Ok(true) | Ok(false)) => {
                        let rem = deadline.saturating_duration_since(Instant::now());
                        if timeout(rem, room.stopped().cancelled()).await.is_err() {
                            return Err(deadline_error(b"collab_hub_shutdown_stop"));
                        }
                        Ok(())
                    }
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(deadline_error(b"collab_hub_shutdown")),
                }
            });
        };
        for _ in 0..LIFECYCLE_DRAIN_CONCURRENCY {
            let Some(room) = pending_rooms.next() else {
                break;
            };
            spawn_room_shutdown(&mut draining, room, budget.clone(), deadline);
        }
        while let Some(joined) = draining.join_next().await {
            match joined {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    first_error.get_or_insert(error);
                }
                Err(_) => {
                    first_error.get_or_insert_with(|| {
                        operation_error(b"collab_hub_shutdown_join", CommitEffect::Unknown)
                    });
                }
            }
            if let Some(room) = pending_rooms.next() {
                spawn_room_shutdown(&mut draining, room, budget.clone(), deadline);
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        // A failed close or unresolved open can outlive its actor. Confirm its
        // durable outcome before a later shutdown call reports success.
        let unsettled = self
            .0
            .unsettled_shutdown_rooms
            .lock()
            .expect("shutdown rooms")
            .clone();
        for (scope, note) in unsettled {
            let slot = self.0.slot(&scope, &note);
            let mut remaining = budget.clone();
            remaining.remaining = deadline.saturating_duration_since(Instant::now());
            let _held = lock_slot(&slot, &remaining).await?;
            remaining.remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout_at(
                deadline,
                self.0.recover_unhosted(&remaining, &scope, &note),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })))
                    if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch => {}
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err(deadline_error(b"collab_shutdown_recovery")),
            }
            self.0
                .unsettled_shutdown_rooms
                .lock()
                .expect("shutdown rooms")
                .remove(&(scope, note));
        }
        self.0.shutdown.cancel();
        Ok(())
    }

    pub async fn connect(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        auth: CollabSessionAuth,
    ) -> Result<CollabPeerSession, PortError> {
        if self.0.accept_closed.is_cancelled() {
            return Err(operation_error(
                b"collab_hub_shutting_down",
                CommitEffect::NotCommitted,
            ));
        }
        if !matches!(
            ctx.auth().kind(),
            PrincipalKind::DirectHuman | PrincipalKind::Pat | PrincipalKind::OAuth { .. }
        ) {
            return Err(DomainError::AccessDenied.into());
        }
        let Ok(peer_permit) = self.0.peer_capacity.clone().try_acquire_owned() else {
            return Err(operation_error(
                b"collab_peer_capacity_exceeded",
                CommitEffect::NotCommitted,
            ));
        };
        let guard = PeerGuard::new_with_permit(auth, Some(peer_permit));
        // Fail fast before running DB admission if credentials are already
        // revoked or expired.
        guard.check().map_err(|_| DomainError::AccessDenied)?;
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let registration = PendingPeer {
            guard: guard.clone(),
            id,
            room: None,
        };
        self.0.peers.lock().expect("peer registry").insert(
            id,
            PeerRegistration {
                note: note.clone(),
                ctx: ctx.clone(),
                guard: Arc::downgrade(&guard),
            },
        );
        guard.attach_hub_registration(Arc::downgrade(&self.0), id);
        tokio::select! {
            biased;
            () = self.0.accept_closed.cancelled() => {
                return Err(operation_error(
                    b"collab_hub_shutting_down",
                    CommitEffect::NotCommitted,
                ));
            }
            () = guard.stopped().cancelled() => return Err(DomainError::AccessDenied.into()),
            admission = self.0.initial_admission(&ctx, &note) => admission?,
        };
        guard.check().map_err(|_| DomainError::AccessDenied)?;
        let deadline = Instant::now() + self.0.config.handshake_timeout;
        let (session, outbound, ingress) =
            CollabPeerSession::pair(self.0.store.clone(), ctx.clone(), note.clone(), guard);
        tokio::spawn(serve_peer(
            Arc::downgrade(&self.0),
            registration,
            ctx,
            note,
            outbound,
            ingress,
            deadline,
        ));
        Ok(session)
    }

    /// Recover fenced rooms in bounded pages using the same path as a fresh peer.
    pub async fn recover_fenced_rooms(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<usize, PortError> {
        ctx.authority.require(ServicePurpose::CollabRecovery)?;
        let deadline = Instant::now()
            .checked_add(ctx.budget.remaining)
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidRange))?;
        let mut recovered = 0;
        loop {
            let mut budget = ctx.budget.clone();
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            let notes = self
                .0
                .store
                .list_fenced_collab_sessions(Some(&budget), scope, 64)
                .await?;
            if notes.is_empty() {
                return Ok(recovered);
            }
            for note in notes {
                let slot = self.0.slot(scope, &note);
                let mut budget = budget.clone();
                budget.remaining = deadline.saturating_duration_since(Instant::now());
                let _held = lock_slot(&slot, &budget).await?;
                recovered +=
                    usize::from(recover_fenced(&self.0.store, &budget, scope, &note).await?);
            }
        }
    }

    pub async fn revoke(
        &self,
        ctx: &MaintenanceContext,
        selector: &RevocationSelector,
        reason: RevocationReason,
    ) -> Result<(), PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        let mut affected = self.0.evict_matching(selector);
        let (pending_rooms, snapshot_seq) = self.0.matching_pending_revoke_settlement(selector);
        affected.extend(pending_rooms);
        let close_space = match (selector, reason) {
            (RevocationSelector::Space(space), RevocationReason::SpaceClosed) => Some(space),
            _ => None,
        };
        let deadline = Instant::now()
            .checked_add(ctx.budget.remaining)
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidRange))?;
        if let Some(space) = close_space {
            // The registration fence already cancelled all eligible peers.
            // Wait for in-flight durable opens to reach their room actor before
            // taking the final snapshot of rooms to close.
            let slots: Vec<_> = {
                self.0
                    .slots
                    .lock()
                    .expect("room registry")
                    .iter()
                    .filter(|((id, _), _)| id == space)
                    .filter_map(|(_, slot)| slot.upgrade())
                    .collect()
            };
            for slot in slots {
                let mut budget = ctx.budget.clone();
                budget.remaining = deadline.saturating_duration_since(Instant::now());
                drop(lock_slot(&slot, &budget).await?);
            }
        }
        let targeted_rooms: Vec<(RoomKey, RoomHandle, bool)> = self
            .0
            .active_rooms()
            .into_iter()
            .filter_map(|room| {
                let key = (room.scope().space_id.clone(), room.note().clone());
                let close = close_space == Some(&room.scope().space_id);
                let targeted = close || affected.remove(&key);
                targeted.then_some((key, room, close))
            })
            .collect();

        let settle_one_room = |hub: Arc<HubInner>,
                               key: RoomKey,
                               room: RoomHandle,
                               close: bool,
                               selector: RevocationSelector,
                               snapshot_seq: u64,
                               budget: CallBudget,
                               deadline: Instant| async move {
            let needs_unhosted_recovery = if room.stopped().is_cancelled() {
                !room.was_settled()
            } else {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match timeout(remaining, room.settle_after_revoke(close)).await {
                    Ok(Ok(true)) => {
                        if close {
                            let rem = deadline.saturating_duration_since(Instant::now());
                            timeout(rem, room.stopped().cancelled())
                                .await
                                .map_err(|_| deadline_error(b"collab_revocation_stop"))?;
                            !room.was_settled()
                        } else {
                            false
                        }
                    }
                    Ok(Ok(false)) => {
                        // The room began stopping naturally (e.g. idle unload)
                        // just before our revocation command arrived. Await
                        // completion and check whether it actually settled.
                        let rem = deadline.saturating_duration_since(Instant::now());
                        timeout(rem, room.stopped().cancelled())
                            .await
                            .map_err(|_| deadline_error(b"collab_revocation_stop"))?;
                        !room.was_settled()
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(_) => return Err(deadline_error(b"collab_revocation_settle")),
                }
            };
            if needs_unhosted_recovery {
                let scope = room.scope();
                let note = room.note();
                let slot = hub.slot(scope, note);
                let mut rem = budget;
                rem.remaining = deadline.saturating_duration_since(Instant::now());
                let _held = lock_slot(&slot, &rem).await?;
                rem.remaining = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout_at(deadline, hub.recover_unhosted(&rem, scope, note))
                    .await
                {
                    Ok(Ok(_)) => {
                        hub.unsettled_shutdown_rooms
                            .lock()
                            .expect("shutdown rooms")
                            .remove(&(scope.clone(), note.clone()));
                    }
                    Ok(Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })))
                        if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch => {}
                    Ok(Err(error)) => return Err(error),
                    Err(_) => return Err(deadline_error(b"collab_revocation_recovery")),
                }
            }
            hub.clear_pending_revoke_settlement(&key, &selector, snapshot_seq);
            Ok(())
        };

        let mut pending_iter = targeted_rooms.into_iter();
        let mut draining = tokio::task::JoinSet::new();
        for _ in 0..LIFECYCLE_DRAIN_CONCURRENCY {
            let Some((key, room, close)) = pending_iter.next() else {
                break;
            };
            draining.spawn(settle_one_room(
                Arc::clone(&self.0),
                key,
                room,
                close,
                selector.clone(),
                snapshot_seq,
                ctx.budget.clone(),
                deadline,
            ));
        }
        let mut first_error = None;
        while let Some(joined) = draining.join_next().await {
            match joined {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    first_error.get_or_insert(error);
                }
                Err(_) => {
                    first_error.get_or_insert_with(|| {
                        operation_error(b"collab_revocation_join", CommitEffect::Unknown)
                    });
                }
            }
            if let Some((key, room, close)) = pending_iter.next() {
                draining.spawn(settle_one_room(
                    Arc::clone(&self.0),
                    key,
                    room,
                    close,
                    selector.clone(),
                    snapshot_seq,
                    ctx.budget.clone(),
                    deadline,
                ));
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }

        // Any remaining `affected` key was no longer in `active` when we
        // scanned. If it still carries pending revocation entries, its room
        // exited without settling cleanly; recover it before clearing.
        for key in affected {
            let pending_scopes =
                self.0
                    .pending_revoke_scopes_if_inactive(&key, selector, snapshot_seq);
            for scope in pending_scopes {
                let slot = self.0.slot(&scope, &key.1);
                let mut rem = ctx.budget.clone();
                rem.remaining = deadline.saturating_duration_since(Instant::now());
                let _held = lock_slot(&slot, &rem).await?;
                rem.remaining = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout_at(
                    deadline,
                    self.0.recover_unhosted(&rem, &scope, &key.1),
                )
                .await
                {
                    Ok(Ok(_)) => {
                        self.0
                            .unsettled_shutdown_rooms
                            .lock()
                            .expect("shutdown rooms")
                            .remove(&(scope, key.1.clone()));
                    }
                    Ok(Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })))
                        if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch => {}
                    Ok(Err(error)) => return Err(error),
                    Err(_) => return Err(deadline_error(b"collab_revocation_recovery")),
                }
            }
            self.0
                .clear_pending_if_inactive(&key, selector, snapshot_seq);
        }
        if let Some(space) = close_space {
            self.settle_unhosted_before_archive(space, ctx.budget.clone(), deadline)
                .await?;
        }
        Ok(())
    }

    async fn settle_unhosted_before_archive(
        &self,
        space: &SpaceId,
        mut budget: CallBudget,
        deadline: Instant,
    ) -> Result<(), PortError> {
        budget.remaining = deadline.saturating_duration_since(Instant::now());
        let scope = self
            .0
            .store
            .read_current_history_scope(Some(&budget), space)
            .await?;
        loop {
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            let owned = self
                .0
                .store
                .list_owned_active_collab_sessions(Some(&budget), &scope, &self.0.owner, 64)
                .await?;
            if owned.is_empty() {
                break;
            }
            for note in owned {
                budget.remaining = deadline.saturating_duration_since(Instant::now());
                let slot = self.0.slot(&scope, &note);
                let _held = lock_slot(&slot, &budget).await?;
                budget.remaining = deadline.saturating_duration_since(Instant::now());
                self.0.recover_unhosted(&budget, &scope, &note).await?;
            }
        }
        budget.remaining = deadline.saturating_duration_since(Instant::now());
        let recovery = MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::CollabRecovery),
            budget,
        };
        self.recover_fenced_rooms(&recovery, &scope).await?;
        Ok(())
    }
}

struct PendingPeer {
    guard: Arc<PeerGuard>,
    id: u64,
    room: Option<RoomHandle>,
}

impl Drop for PendingPeer {
    fn drop(&mut self) {
        // Preserve the terminal frame and status of a session already closing.
        if !self.guard.stopped().is_cancelled() {
            self.guard.close(SessionClose::POLICY);
        }
        if let Some(room) = &self.room {
            room.peer_changed();
        }
        // PeerGuard automatically unregisters `self.id` from `hub.peers` as
        // soon as its revocation lease is released, avoiding a background
        // watcher task per disconnecting peer.
    }
}

impl HubInner {
    pub fn shutdown_token(&self) -> Cancellation {
        self.shutdown.clone()
    }

    pub fn accept_closed_token(&self) -> Cancellation {
        self.accept_closed.clone()
    }

    pub fn current_revoke_seq(&self) -> u64 {
        self.pending_revoke_settlement
            .lock()
            .expect("pending revoke settlement")
            .seq
    }

    /// Lock order across `HubInner` is strictly:
    /// `peers` -> `active` -> `pending_revoke_settlement`.
    pub fn unregister_peer(&self, id: u64, revoked: bool) {
        let mut peers = self.peers.lock().expect("peer registry");
        if revoked && let Some(peer) = peers.get(&id) {
            let key = (peer.ctx.scope().space_id.clone(), peer.note.clone());
            let active = self.active.lock().expect("active rooms");
            if active.contains_key(&key) {
                let mut pending = self
                    .pending_revoke_settlement
                    .lock()
                    .expect("pending revoke settlement");
                pending.seq = pending.seq.saturating_add(1);
                let rev_seq = pending.seq;
                pending.rooms.entry(key).or_default().insert(
                    id,
                    PendingRevoke {
                        rev_seq,
                        ctx: peer.ctx.clone(),
                    },
                );
            }
        }
        peers.remove(&id);
    }

    fn matching_pending_revoke_settlement(
        &self,
        selector: &RevocationSelector,
    ) -> (HashSet<RoomKey>, u64) {
        let pending = self
            .pending_revoke_settlement
            .lock()
            .expect("pending revoke settlement");
        let matched = pending
            .rooms
            .iter()
            .filter(|(_, entries)| {
                entries
                    .values()
                    .any(|entry| matches_selector(&entry.ctx, selector))
            })
            .map(|(key, _)| key.clone())
            .collect();
        (matched, pending.seq)
    }

    fn clear_pending_revoke_settlement(
        &self,
        key: &RoomKey,
        selector: &RevocationSelector,
        through_seq: u64,
    ) {
        let mut pending = self
            .pending_revoke_settlement
            .lock()
            .expect("pending revoke settlement");
        if let Some(entries) = pending.rooms.get_mut(key) {
            entries.retain(|_, entry| {
                entry.rev_seq > through_seq || !matches_selector(&entry.ctx, selector)
            });
            if entries.is_empty() {
                pending.rooms.remove(key);
            }
        }
    }

    fn pending_revoke_scopes_if_inactive(
        &self,
        key: &RoomKey,
        selector: &RevocationSelector,
        through_seq: u64,
    ) -> Vec<HistoryScope> {
        let active = self.active.lock().expect("active rooms");
        if active.contains_key(key) {
            return Vec::new();
        }
        let pending = self
            .pending_revoke_settlement
            .lock()
            .expect("pending revoke settlement");
        let Some(entries) = pending.rooms.get(key) else {
            return Vec::new();
        };
        let mut scopes = Vec::new();
        for entry in entries.values() {
            if entry.rev_seq <= through_seq && matches_selector(&entry.ctx, selector) {
                let scope = entry.ctx.scope();
                if !scopes.contains(scope) {
                    scopes.push(scope.clone());
                }
            }
        }
        scopes
    }

    fn clear_pending_if_inactive(
        &self,
        key: &RoomKey,
        selector: &RevocationSelector,
        through_seq: u64,
    ) {
        let active = self.active.lock().expect("active rooms");
        if active.contains_key(key) {
            return;
        }
        let mut pending = self
            .pending_revoke_settlement
            .lock()
            .expect("pending revoke settlement");
        if let Some(entries) = pending.rooms.get_mut(key) {
            entries.retain(|_, entry| {
                entry.rev_seq > through_seq || !matches_selector(&entry.ctx, selector)
            });
            if entries.is_empty() {
                pending.rooms.remove(key);
            }
        }
    }

    pub fn prune_settled_revocations(
        &self,
        key: &RoomKey,
        through_seq: u64,
        is_peer_gone: impl Fn(u64) -> bool,
    ) {
        let mut pending = self
            .pending_revoke_settlement
            .lock()
            .expect("pending revoke settlement");
        if let Some(entries) = pending.rooms.get_mut(key) {
            entries.retain(|&peer_id, entry| entry.rev_seq > through_seq || !is_peer_gone(peer_id));
            if entries.is_empty() {
                pending.rooms.remove(key);
            }
        }
    }

    pub fn has_live_slot(&self, scope: &HistoryScope, note: &NoteId) -> bool {
        let key = (scope.space_id.clone(), note.clone());
        // Check strong_count without upgrading so `RoomSlot::drop` can never
        // execute while `self.slots` is locked.
        self.slots
            .lock()
            .expect("room registry")
            .get(&key)
            .is_some_and(|slot| slot.strong_count() > 0)
    }

    pub fn space_has_live_rooms(&self, space: &SpaceId) -> bool {
        if self
            .active
            .lock()
            .expect("active rooms")
            .keys()
            .any(|(s, _)| s == space)
        {
            return true;
        }
        // Check strong_count without upgrading so `RoomSlot::drop` can never
        // execute while `self.slots` is locked.
        self.slots
            .lock()
            .expect("room registry")
            .iter()
            .any(|((s, _), slot)| s == space && slot.strong_count() > 0)
    }

    pub fn budget(&self) -> CallBudget {
        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        let id = ((self.entropy as u128) << 64) | sequence as u128;
        CallBudget {
            request: RequestId::from_bytes(id.to_be_bytes()),
            cancellation: Cancellation::default(),
            remaining: OPERATION_TIMEOUT,
        }
    }

    pub fn slot(self: &Arc<Self>, scope: &HistoryScope, note: &NoteId) -> Arc<RoomSlot> {
        let mut slots = self.slots.lock().expect("room registry");
        let key = (scope.space_id.clone(), note.clone());
        if let Some(slot) = slots.get(&key).and_then(Weak::upgrade) {
            return slot;
        }
        let slot = Arc::new(RoomSlot {
            key: key.clone(),
            hub: Arc::downgrade(self),
            state: AsyncMutex::new(None),
        });
        slots.insert(key, Arc::downgrade(&slot));
        slot
    }

    fn try_acquire_space_room(self: &Arc<Self>, space: &SpaceId) -> Option<SpaceRoomPermit> {
        let mut counts = self.space_room_counts.lock().expect("space room counts");
        let count = counts.entry(space.clone()).or_insert(0);
        if *count >= self.config.max_rooms_per_space {
            if *count == 0 {
                counts.remove(space);
            }
            return None;
        }
        *count += 1;
        Some(SpaceRoomPermit {
            hub: Arc::downgrade(self),
            space: space.clone(),
        })
    }

    fn active_rooms(&self) -> Vec<RoomHandle> {
        self.active
            .lock()
            .expect("active rooms")
            .values()
            .cloned()
            .collect()
    }

    fn active_rooms_in_space(&self, space: &SpaceId) -> Vec<RoomHandle> {
        self.active
            .lock()
            .expect("active rooms")
            .iter()
            .filter(|((sid, _), _)| sid == space)
            .map(|(_, room)| room.clone())
            .collect()
    }

    fn active_room(&self, space: &SpaceId, note: &NoteId) -> Option<RoomHandle> {
        self.active
            .lock()
            .expect("active rooms")
            .get(&(space.clone(), note.clone()))
            .cloned()
    }

    pub fn room_stopped(&self, room: &RoomHandle, settled: bool) {
        let key = (room.scope().space_id.clone(), room.note().clone());
        let mut active = self.active.lock().expect("active rooms");
        if !settled {
            self.unsettled_shutdown_rooms
                .lock()
                .expect("shutdown rooms")
                .insert((room.scope().clone(), room.note().clone()));
        } else {
            self.unsettled_shutdown_rooms
                .lock()
                .expect("shutdown rooms")
                .remove(&(room.scope().clone(), room.note().clone()));
        }
        if active
            .get(&key)
            .is_some_and(|registered| registered.same_lease(room))
        {
            active.remove(&key);
            // Keep pending revocation entries intact when the room exited
            // without settling so `revoke()` knows it must run durable recovery.
            if settled {
                self.pending_revoke_settlement
                    .lock()
                    .expect("pending revoke settlement")
                    .rooms
                    .remove(&key);
            }
        }
    }

    pub fn room_started(&self, room: &RoomHandle) {
        let key = (room.scope().space_id.clone(), room.note().clone());
        self.active
            .lock()
            .expect("active rooms")
            .insert(key, room.clone());
    }

    fn evict_matching(&self, selector: &RevocationSelector) -> HashSet<RoomKey> {
        let selected: Vec<_> = {
            let peers = self.peers.lock().expect("peer registry");
            let active = self.active.lock().expect("active rooms");
            let mut pending = self
                .pending_revoke_settlement
                .lock()
                .expect("pending revoke settlement");
            peers
                .iter()
                .filter(|(_, peer)| matches_selector(&peer.ctx, selector))
                .filter_map(|(&id, peer)| {
                    let key = (peer.ctx.scope().space_id.clone(), peer.note.clone());
                    if active.contains_key(&key) {
                        pending.seq = pending.seq.saturating_add(1);
                        let rev_seq = pending.seq;
                        pending.rooms.entry(key.clone()).or_default().insert(
                            id,
                            PendingRevoke {
                                rev_seq,
                                ctx: peer.ctx.clone(),
                            },
                        );
                    }
                    Some((key, peer.guard.upgrade()?))
                })
                .collect()
        };
        let mut affected = HashSet::new();
        for (key, guard) in selected {
            guard.close(SessionClose::POLICY);
            affected.insert(key);
        }
        affected
    }

    async fn initial_admission(&self, ctx: &SpaceContext, note: &NoteId) -> Result<(), PortError> {
        let current = self
            .store
            .read_current_history_scope(Some(&ctx.budget), &ctx.scope().space_id)
            .await?;
        ctx.check_current(&current)?;
        let facts = self
            .store
            .read_room_resource_facts(Some(&ctx.budget), &current, note)
            .await?;
        ctx.auth().authorize_read(&facts)?;
        if facts.class != DocClass::UserDoc {
            return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
        }
        Ok(())
    }

    pub async fn recover(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        if self
            .store
            .room_fences()
            .is_room_fenced(&scope.space_id, note)
        {
            return recover_fenced(&self.store, budget, scope, note).await;
        }
        match self.store.room_fences().is_room_active(scope, note).await {
            Ok(false) => Ok(false),
            Ok(true) | Err(PortError::Unavailable(_)) => {
                self.recover_unhosted(budget, scope, note).await
            }
            Err(error) => Err(error),
        }
    }

    async fn recover_unhosted(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        let Some(snapshot) = self
            .store
            .read_collab_session_after_transition(budget, scope, note)
            .await?
        else {
            return Ok(false);
        };
        let record = snapshot.session;
        if record.room_state == CollabRoomState::Active
            && record.owner_id.as_deref() == Some(self.owner.as_ref())
        {
            match Room::fence_record(&self.store, budget, scope, &record, &self.owner).await {
                Ok(()) => {}
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if matches!(
                        diagnostic.reason,
                        ValidationReason::InvalidState
                            | ValidationReason::InvalidAuthority
                            | ValidationReason::SourceMismatch
                    ) =>
                {
                    // Another transition (for example, a clean idle close or
                    // concurrent fence) advanced the lease in the meantime.
                    // Finish recovery if it transitioned to `Fenced`.
                    return recover_fenced(&self.store, budget, scope, note).await;
                }
                Err(error) => return Err(error),
            }
        } else if record.room_state != CollabRoomState::Fenced {
            return Ok(false);
        }
        recover_fenced(&self.store, budget, scope, note).await
    }

    async fn admit(
        self: &Arc<Self>,
        ctx: &SpaceContext,
        note: &NoteId,
        hello: &LineageHello,
        outbound: &PeerOutbound,
        deadline: Instant,
    ) -> Result<Option<(RoomHandle, PeerRole)>, PortError> {
        if self.accept_closed.is_cancelled() {
            outbound.guard.close(SessionClose::GOING_AWAY);
            return Ok(None);
        }
        let slot = self.slot(ctx.scope(), note);
        let mut held = tokio::select! {
            biased;
            () = self.accept_closed.cancelled() => {
                outbound.guard.close(SessionClose::GOING_AWAY);
                return Ok(None);
            }
            () = outbound.guard.stopped().cancelled() => {
                return Err(DomainError::AccessDenied.into());
            }
            res = lock_slot(&slot, &ctx.budget) => res?,
        };
        let mut budget = ctx.budget.clone();
        budget.cancellation = outbound.guard.stopped().clone();
        let mut open_conflicts = 0usize;
        let mut total_steps = 0usize;
        const MAX_ADMIT_STEPS: usize = 8;
        while open_conflicts < OPEN_ATTEMPTS && total_steps < MAX_ADMIT_STEPS {
            total_steps += 1;
            if self.accept_closed.is_cancelled() {
                outbound.guard.close(SessionClose::GOING_AWAY);
                return Ok(None);
            }
            outbound
                .guard
                .check()
                .map_err(|_| DomainError::AccessDenied)?;
            // Drop any already-stopped local room handle before reading storage
            // so a concurrent clean close is never mistaken for an unhosted row.
            if held
                .as_ref()
                .is_some_and(|room| room.stopped().is_cancelled())
            {
                *held = None;
            }
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            let current = tokio::select! {
                biased;
                () = self.accept_closed.cancelled() => {
                    outbound.guard.close(SessionClose::GOING_AWAY);
                    return Ok(None);
                }
                res = self.store.read_current_history_scope(Some(&budget), &ctx.scope().space_id) => res?,
            };
            ctx.check_current(&current)?;
            if let Some(room) = held.as_ref()
                && room.scope() == &current
                && match hello {
                    LineageHello::Fresh => true,
                    LineageHello::Reconnect {
                        client_history_incarnation,
                        client_lineage_epoch,
                        ..
                    } => {
                        *client_history_incarnation == current.incarnation
                            && *client_lineage_epoch == room.lineage()
                    }
                }
            {
                budget.remaining = deadline.saturating_duration_since(Instant::now());
                let active_res = tokio::select! {
                    biased;
                    () = self.accept_closed.cancelled() => {
                        outbound.guard.close(SessionClose::GOING_AWAY);
                        return Ok(None);
                    }
                    res = self.store.read_active_room_facts(
                        Some(&budget),
                        &current,
                        note,
                        room.epoch(),
                        room.lineage(),
                        &self.owner,
                    ) => res,
                };
                match active_res {
                    Ok(facts) => {
                        ctx.auth().authorize_read(&facts.resource)?;
                        let role = if ctx
                            .auth()
                            .authorize_direct_write(&facts.resource, &facts.resource)
                            .is_ok()
                        {
                            PeerRole::Editor
                        } else {
                            PeerRole::Viewer
                        };
                        return Ok(Some((room.clone(), role)));
                    }
                    // A lease or lineage transition needs the durable admission/recovery path.
                    Err(PortError::Domain(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            // Existing actors and their reconnect handshakes do not need a
            // second permit. A cold open reserves global + per-Space capacity
            // before loading any payloads.
            let (capacity, space_capacity) = if held.is_some() {
                (None, None)
            } else {
                let Ok(permit) = self.room_capacity.clone().try_acquire_owned() else {
                    outbound.guard.close(SessionClose::ROOM_CAPACITY);
                    return Ok(None);
                };
                let Some(space_permit) = self.try_acquire_space_room(&current.space_id) else {
                    outbound.guard.close(SessionClose::ROOM_CAPACITY);
                    return Ok(None);
                };
                (Some(permit), Some(space_permit))
            };
            let base = match hello {
                LineageHello::Reconnect {
                    client_history_incarnation,
                    client_base_rev_id,
                    ..
                } if *client_history_incarnation == current.incarnation => {
                    client_base_rev_id.as_ref()
                }
                _ => None,
            };
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            let read_ctx = SpaceContext::new(ctx.auth().clone(), current, budget.clone())?;
            let admission = tokio::select! {
                biased;
                () = self.accept_closed.cancelled() => {
                    outbound.guard.close(SessionClose::GOING_AWAY);
                    return Ok(None);
                }
                res = self.store.read_note_collab_admission_meta(&read_ctx, note, base) => res?,
            };
            ctx.check_current(&admission.scope)?;
            if admission.doc_class != DocClass::UserDoc {
                return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
            }
            // If the previously-live local room stopped while `admission` was
            // being read, `admission.session` may reflect its pre-close `Active`
            // row. Clear `held` and re-read fresh storage state.
            if held
                .as_ref()
                .is_some_and(|room| room.stopped().is_cancelled())
            {
                *held = None;
                continue;
            }
            let stored = admission.session.as_ref().map(|value| &value.session);
            let role = if admission.can_write {
                PeerRole::Editor
            } else {
                PeerRole::Viewer
            };
            // Always retire stale local actors (including from a previous
            // incarnation) before deciding on reuse or reconnect lineage.
            if let Some(room) = held.as_ref() {
                if room.scope() == &admission.scope
                    && stored.is_some_and(|record| room.matches_durable_lease(record))
                {
                    if let LineageHello::Reconnect {
                        client_history_incarnation,
                        client_lineage_epoch,
                        ..
                    } = *hello
                        && (client_history_incarnation != admission.scope.incarnation
                            || stored
                                .is_none_or(|record| record.lineage_epoch != client_lineage_epoch))
                    {
                        send_lineage_mismatch(outbound, admission, role);
                        return Ok(None);
                    }
                    return Ok(Some((room.clone(), role)));
                }
                room.storage_changed();
                tokio::time::timeout_at(deadline, room.stopped().cancelled())
                    .await
                    .map_err(|_| deadline_error(b"retire_stale_collab_room"))?;
                *held = None;
                continue;
            }
            // Recover fenced or unhosted same-process rooms BEFORE checking
            // Reconnect lineage mismatch or loading the carrier blob so clients
            // observe settled head/lineage without wasted CAS/S3 reads.
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            if stored.is_some_and(|record| record.room_state == CollabRoomState::Fenced) {
                recover_fenced(&self.store, &budget, &admission.scope, note).await?;
                continue;
            }
            if let Some(record) = stored.filter(|record| {
                record.room_state == CollabRoomState::Active
                    && record.owner_id.as_deref() == Some(self.owner.as_ref())
            }) {
                match Room::fence_record(
                    &self.store,
                    &budget,
                    &admission.scope,
                    record,
                    &self.owner,
                )
                .await
                {
                    Ok(()) => {
                        budget.remaining = deadline.saturating_duration_since(Instant::now());
                        recover_fenced(&self.store, &budget, &admission.scope, note).await?;
                        continue;
                    }
                    Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                        if matches!(
                            diagnostic.reason,
                            ValidationReason::InvalidState
                                | ValidationReason::InvalidAuthority
                                | ValidationReason::SourceMismatch
                        ) =>
                    {
                        open_conflicts += 1;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            if let LineageHello::Reconnect {
                client_history_incarnation,
                client_lineage_epoch,
                ..
            } = *hello
                && (client_history_incarnation != admission.scope.incarnation
                    || stored.is_none_or(|record| record.lineage_epoch != client_lineage_epoch))
            {
                send_lineage_mismatch(outbound, admission, role);
                return Ok(None);
            }
            if self.accept_closed.is_cancelled() {
                outbound.guard.close(SessionClose::GOING_AWAY);
                return Ok(None);
            }
            outbound
                .guard
                .check()
                .map_err(|_| DomainError::AccessDenied)?;
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            let carrier = tokio::select! {
                biased;
                () = self.accept_closed.cancelled() => {
                    outbound.guard.close(SessionClose::GOING_AWAY);
                    return Ok(None);
                }
                res = self.store.load_collab_carrier(
                    &admission.scope,
                    admission.carrier_digest,
                    Some(&budget),
                ) => res?,
            };
            let prepared = Room::prepare_from_meta(&admission, &carrier)?;
            drop(carrier);
            outbound
                .guard
                .check()
                .map_err(|_| DomainError::AccessDenied)?;
            let open = OpenCollabSession {
                scope: admission.scope.clone(),
                note: note.clone(),
                owner_id: self.owner.to_string(),
                expected_carrier_rev: admission.head_rev_id,
                expected_lease: stored.map(|record| record.lease_epoch),
                expected_lineage: stored.map(|record| record.lineage_epoch),
                initial_yrs_snapshot: stored
                    .is_none_or(|record| record.yrs_snapshot_blob.is_none())
                    .then(|| prepared.twin.live_snapshot()),
                allow_fenced_recovery: false,
            };
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            let mut open_budget = budget.clone();
            open_budget.cancellation = outbound.guard.stopped().clone();
            match self.store.open_collab_session(&open_budget, open).await {
                Ok(record) => {
                    let handle = Room::spawn(
                        self,
                        slot.clone(),
                        admission.scope,
                        admission.slug,
                        record,
                        prepared,
                        capacity.expect("a cold open reserves room capacity"),
                        space_capacity.expect("a cold open reserves per-Space room capacity"),
                    );
                    *held = Some(handle.clone());
                    return Ok(Some((handle, role)));
                }
                Err(PortError::Domain(DomainError::RevisionConflict { .. })) => {
                    open_conflicts += 1;
                }
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if matches!(
                        diagnostic.reason,
                        ValidationReason::SourceMismatch | ValidationReason::InvalidAuthority
                    ) =>
                {
                    open_conflicts += 1;
                }
                Err(error) if unknown(&error) => {
                    // The open may finish after the handshake expires. Resolve
                    // any unpublished lease under the same slot; if recovery
                    // fails, record it so shutdown reconciles it before Ok(()).
                    if let Err(rec_err) = self
                        .recover_unhosted(&self.budget(), &admission.scope, note)
                        .await
                    {
                        self.unsettled_shutdown_rooms
                            .lock()
                            .expect("shutdown rooms")
                            .insert((admission.scope.clone(), note.clone()));
                        return Err(rec_err);
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(DomainError::validation(ValidationReason::NotReady).into())
    }
}

fn send_lineage_mismatch(
    outbound: &PeerOutbound,
    admission: NoteCollabAdmissionMeta,
    role: PeerRole,
) {
    let current_lineage_epoch = admission
        .session
        .as_ref()
        .map_or(LineageEpoch::ZERO, |record| record.session.lineage_epoch);
    outbound.finish(
        LineageMismatch {
            current_history_incarnation: admission.scope.incarnation,
            current_rev_id: admission.head_rev_id,
            current_lineage_epoch,
            verified_base_rev_id: admission.verified_base_rev_id,
        }
        .encode(),
        OutboundAuthority::Admission {
            scope: admission.scope,
            role,
        },
        SessionClose {
            code: 4409,
            reason: "lineage_mismatch",
        },
    );
}

pub(crate) async fn lock_slot<'a>(
    slot: &'a RoomSlot,
    budget: &CallBudget,
) -> Result<tokio::sync::MutexGuard<'a, Option<RoomHandle>>, PortError> {
    tokio::select! {
        biased;
        () = budget.cancellation.cancelled() => Err(DomainError::AccessDenied.into()),
        result = timeout(budget.remaining, slot.state.lock()) => result.map_err(|_| deadline_error(b"collab_slot")),
    }
}

async fn serve_peer(
    hub: Weak<HubInner>,
    mut peer: PendingPeer,
    ctx: SpaceContext,
    note: NoteId,
    outbound: PeerOutbound,
    mut ingress: mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
) {
    let guard = &outbound.guard;
    let accept_closed = hub.upgrade().map(|owner| owner.accept_closed_token());
    let Some(accept_closed) = accept_closed else {
        guard.close(SessionClose::GOING_AWAY);
        return;
    };
    let first_frame = tokio::select! {
        biased;
        () = accept_closed.cancelled() => {
            guard.close(SessionClose::GOING_AWAY);
            return;
        }
        () = guard.stopped().cancelled() => return,
        result = tokio::time::timeout_at(deadline, ingress.recv()) => match result {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                guard.close(SessionClose::DISCONNECTED);
                return;
            }
            Err(_) => return,
        },
    };
    let hello = match decode_hello(&first_frame) {
        Ok(hello) => hello,
        Err(error) => {
            guard.close(SessionClose {
                code: error.code(),
                reason: error.reason(),
            });
            return;
        }
    };
    let Some(owner) = hub.upgrade() else {
        guard.close(SessionClose::GOING_AWAY);
        return;
    };
    let room = attach_peer(&owner, &mut peer, ctx, &note, &hello, &outbound, deadline).await;
    drop(owner);
    let Some(room) = room else { return };
    loop {
        let frame = tokio::select! {
            biased;
            () = guard.stopped().cancelled() => break,
            () = room.stopped().cancelled() => break,
            frame = ingress.recv() => match frame {
                Some(frame) => frame,
                None => {
                    guard.close(SessionClose::DISCONNECTED);
                    break;
                }
            },
        };
        if !send_until_closed(&room, RoomCommand::Frame { id: peer.id, frame }, guard).await {
            break;
        }
    }
}

async fn attach_peer(
    owner: &Arc<HubInner>,
    peer: &mut PendingPeer,
    mut ctx: SpaceContext,
    note: &NoteId,
    hello: &LineageHello,
    outbound: &PeerOutbound,
    deadline: Instant,
) -> Option<RoomHandle> {
    let guard = &outbound.guard;
    ctx.budget = owner.budget();
    // An accepted open must reach a known outcome even if the peer loses its
    // lease in flight. Its independent guard blocks Ready and drops the lease.
    for _ in 0..OPEN_ATTEMPTS {
        ctx.budget.remaining = deadline.saturating_duration_since(Instant::now());
        let (room, role) = match owner.admit(&ctx, note, hello, outbound, deadline).await {
            Ok(Some(pair)) => pair,
            Ok(None) => return None,
            Err(error) => {
                match &error {
                    PortError::Domain(_) => {
                        guard.close(SessionClose::POLICY);
                    }
                    _ => {
                        tracing::warn!(
                            code = error.code(),
                            space_id = %ctx.scope().space_id,
                            note_id = %note,
                            "collaboration peer admission failed"
                        );
                        guard.close(SessionClose::UNAVAILABLE);
                    }
                }
                return None;
            }
        };
        peer.room = Some(room.clone());
        let (reply, received) = tokio::sync::oneshot::channel();
        let join = RoomCommand::Join {
            id: peer.id,
            ctx: Box::new(ctx.clone()),
            role,
            outbound: outbound.clone(),
            reply,
            deadline,
        };
        if matches!(
            tokio::time::timeout_at(deadline, send_until_closed(&room, join, guard)).await,
            Ok(true)
        ) {
            match tokio::select! {
                biased;
                () = guard.stopped().cancelled() => return None,
                () = tokio::time::sleep_until(deadline) => {
                    guard.close(SessionClose::UNAVAILABLE);
                    return None;
                }
                result = received => result,
            } {
                Ok(JoinOutcome::Accepted) => return Some(room),
                Ok(JoinOutcome::CapacityExceeded) => {
                    guard.close(SessionClose::ROOM_CAPACITY);
                    return None;
                }
                Ok(JoinOutcome::Denied) => {
                    guard.close(SessionClose::POLICY);
                    return None;
                }
                Ok(JoinOutcome::Unavailable) => {
                    guard.close(SessionClose::UNAVAILABLE);
                    return None;
                }
                Ok(JoinOutcome::RoomClosing) | Err(_) => {}
            }
        }
        // The idle-unload timer may have won against a newly enqueued join.
        // Recheck lineage under a new open before returning any setup frames.
        tokio::select! {
            biased;
            () = guard.stopped().cancelled() => return None,
            () = tokio::time::sleep_until(deadline) => {
                guard.close(SessionClose::UNAVAILABLE);
                return None;
            }
            () = room.stopped().cancelled() => {}
        }
    }
    guard.close(SessionClose::UNAVAILABLE);
    None
}

async fn send_until_closed(room: &RoomHandle, command: RoomCommand, guard: &PeerGuard) -> bool {
    tokio::select! {
        biased;
        () = guard.stopped().cancelled() => false,
        () = room.stopped().cancelled() => false,
        result = room.send(command) => result.is_ok(),
    }
}

async fn watch_storage(
    hub: Weak<HubInner>,
    shutdown: Cancellation,
    mut signals: broadcast::Receiver<SpaceSignal>,
) {
    loop {
        let signal = tokio::select! {
            biased;
            () = shutdown.cancelled() => return,
            result = signals.recv() => result,
        };
        let Some(hub) = hub.upgrade() else { return };
        match &signal {
            Ok(SpaceSignal::Committed {
                scope,
                new_last_seq,
                targets,
            }) => match targets {
                CommittedTargets::Notes(notes) => {
                    if notes.len() == 1 {
                        if let Some(room) = hub.active_room(&scope.space_id, &notes[0]) {
                            room.note_solo_committed(new_last_seq.get());
                        }
                    } else {
                        for note in notes.iter() {
                            if let Some(room) = hub.active_room(&scope.space_id, note) {
                                room.storage_changed();
                            }
                        }
                    }
                }
                CommittedTargets::All => {
                    for room in hub.active_rooms_in_space(&scope.space_id) {
                        room.storage_changed();
                    }
                }
            },
            Ok(
                SpaceSignal::CatalogChanged { scope, .. }
                | SpaceSignal::Purged { scope, .. }
                | SpaceSignal::WriterLeaseChanged { scope },
            ) => {
                for room in hub.active_rooms_in_space(&scope.space_id) {
                    room.storage_changed();
                }
            }
            Ok(SpaceSignal::IncarnationChanged { new_scope, .. }) => {
                let stale_guards: Vec<_> = {
                    let peers = hub.peers.lock().expect("peer registry");
                    peers
                        .values()
                        .filter(|peer| {
                            let scope = peer.ctx.scope();
                            scope.space_id == new_scope.space_id && scope != new_scope
                        })
                        .filter_map(|peer| peer.guard.upgrade())
                        .collect()
                };
                for guard in stale_guards {
                    guard.close(SessionClose::POLICY);
                }
                for room in hub.active_rooms_in_space(&new_scope.space_id) {
                    room.storage_changed();
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // Re-verify all registered peer history incarnations after a
                // broadcast lag so no peer survives an incarnation change.
                let peer_scopes: Vec<(HistoryScope, Arc<PeerGuard>)> = {
                    let peers = hub.peers.lock().expect("peer registry");
                    peers
                        .values()
                        .filter_map(|peer| Some((peer.ctx.scope().clone(), peer.guard.upgrade()?)))
                        .collect()
                };
                let unique_spaces: HashSet<SpaceId> = peer_scopes
                    .iter()
                    .map(|(scope, _)| scope.space_id.clone())
                    .collect();
                let mut current_scopes = HashMap::with_capacity(unique_spaces.len());
                for space_id in unique_spaces {
                    let budget = hub.budget();
                    if let Ok(current) = hub
                        .store
                        .read_current_history_scope(Some(&budget), &space_id)
                        .await
                    {
                        current_scopes.insert(space_id, current);
                    }
                }
                for (peer_scope, guard) in peer_scopes {
                    if current_scopes
                        .get(&peer_scope.space_id)
                        .is_none_or(|current| current != &peer_scope)
                    {
                        guard.close(SessionClose::POLICY);
                    }
                }
                for room in hub.active_rooms() {
                    room.storage_changed();
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

fn matches_selector(ctx: &SpaceContext, selector: &RevocationSelector) -> bool {
    let auth = ctx.auth();
    let credential = auth.credential();
    match selector {
        RevocationSelector::Space(space) => space == &ctx.scope().space_id,
        RevocationSelector::Principal(principal) => principal == auth.principal(),
        RevocationSelector::Grant(grant) => grant == auth.grant(),
        RevocationSelector::Membership { space, principal } => {
            space == &ctx.scope().space_id && principal == auth.principal()
        }
        RevocationSelector::Session(session) => {
            matches!(credential, Some(AuthenticatedCredential::Session(id)) if id == session)
        }
        RevocationSelector::Credential(id) => {
            matches!(credential, Some(AuthenticatedCredential::Pat(token)) if token.as_str() == id.as_str())
        }
        RevocationSelector::OAuthAccess(id) => {
            matches!(credential, Some(AuthenticatedCredential::OAuth { token, .. }) if token == id)
        }
        RevocationSelector::OAuthGrant(id) => {
            matches!(credential, Some(AuthenticatedCredential::OAuth { grant, .. }) if grant == id)
        }
        RevocationSelector::OAuthFamily(id) => {
            matches!(credential, Some(AuthenticatedCredential::OAuth { family: Some(family), .. }) if family == id)
        }
        _ => false,
    }
}

pub(crate) fn operation_error(operation: &[u8], effect: CommitEffect) -> PortError {
    let digest = ContentDigest::from_bytes(*blake3::hash(operation).as_bytes());
    PortError::Unavailable(
        OperationalFailure::new(digest, effect, RetryAdvice::Never, false)
            .expect("valid non-retryable operational failure"),
    )
}

fn deadline_error(operation: &[u8]) -> PortError {
    let digest = ContentDigest::from_bytes(*blake3::hash(operation).as_bytes());
    PortError::DeadlineExceeded(
        OperationalFailure::new(
            digest,
            CommitEffect::NotCommitted,
            RetryAdvice::Never,
            false,
        )
        .expect("valid non-retryable operational failure"),
    )
}

pub(crate) fn unknown(error: &PortError) -> bool {
    match error {
        PortError::Cancelled(failure)
        | PortError::DeadlineExceeded(failure)
        | PortError::Unavailable(failure)
        | PortError::Internal(failure) => failure.effect() == CommitEffect::Unknown,
        PortError::Domain(_) => false,
    }
}

struct CollabRevocations {
    hub: Weak<HubInner>,
    registry: Arc<dyn SessionRevocationPort>,
}

impl SessionRevocationPort for CollabRevocations {
    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.registry
            .register_provider(ctx, selectors, cancellation)
    }

    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.registry.fence_provider(ctx, selectors)
    }

    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        self.registry.fence_inactive_provider(ctx, call)
    }

    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.registry
                .revoke(ctx.clone(), selector.clone(), reason)
                .await?;
            if let Some(hub) = self.hub.upgrade() {
                CollabHub(hub).revoke(&ctx, &selector, reason).await?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use notarium_canonical::{CanonicalConfig, CanonicalRuntime};
    use notarium_core::{
        auth::{EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman},
        ids::{AuthSessionId, GrantId, HistoryIncarnation, InstallationId, PrincipalId},
    };

    use super::*;
    use crate::session::SessionEvent;

    struct NoopLease;
    impl RevocationLease for NoopLease {
        fn check(&self) -> Result<(), PortError> {
            Ok(())
        }
    }

    fn session_ctx(
        scope: &HistoryScope,
        seed: u8,
        principal: PrincipalId,
        session: AuthSessionId,
    ) -> SpaceContext {
        let grant = SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        };
        let verified = VerifiedHuman::attest(
            principal,
            GrantId::from_bytes([seed; 16]),
            BTreeMap::from([(scope.space_id.clone(), grant)]),
            false,
        )
        .with_credential(AuthenticatedCredential::Session(session));
        SpaceContext::new(
            EngineAuthContext::for_human(verified),
            scope.clone(),
            CallBudget {
                request: RequestId::from_bytes([seed; 16]),
                cancellation: Cancellation::default(),
                remaining: Duration::from_secs(5),
            },
        )
        .unwrap()
    }

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new(tag: &str) -> Self {
            let mut rnd = [0u8; 8];
            let _ = getrandom::fill(&mut rnd);
            let path = std::env::temp_dir()
                .join(format!("notarium-{tag}-{:016x}", u64::from_le_bytes(rnd)));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn admit_closes_with_going_away_when_accept_closed_and_transient_slots_do_not_leak_pending_revokes()
     {
        let dir = TestDir::new("hub-admit");
        let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
            InstallationId::from_bytes([89; 16]),
            notarium_core::epoch::DataRoot::new(&dir.0),
        ))
        .await
        .unwrap();
        let hub = CollabHub::new(store.clone(), CollabConfig::default()).unwrap();
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([11; 16]),
            incarnation: HistoryIncarnation::from_bytes([12; 16]),
        };
        let note_a = NoteId::from_bytes([21; 16]);
        let p_a = PrincipalId::from_bytes([31; 16]);
        let s_a = AuthSessionId::from_bytes([41; 16]);
        let ctx_a = session_ctx(&scope, 1, p_a, s_a.clone());

        // 1. Transient RoomSlot without an active room must NOT record pending
        //    revoke settlement on peer cancellation (no memory leak).
        let _transient_slot = hub.0.slot(&scope, &note_a);
        let cancel_a = Cancellation::default();
        let guard_a = PeerGuard::new(CollabSessionAuth::new(
            Box::new(NoopLease),
            cancel_a.clone(),
            None,
        ));
        hub.0.peers.lock().unwrap().insert(
            101,
            PeerRegistration {
                note: note_a.clone(),
                ctx: ctx_a.clone(),
                guard: Arc::downgrade(&guard_a),
            },
        );
        guard_a.attach_hub_registration(Arc::downgrade(&hub.0), 101);
        cancel_a.cancel();
        guard_a.close(SessionClose::POLICY);
        let (matched, _) = hub
            .0
            .matching_pending_revoke_settlement(&RevocationSelector::Session(s_a));
        assert!(
            matched.is_empty(),
            "transient slot without active room must not leak pending_revoke_settlement"
        );
        drop(_transient_slot);

        // 2. Direct call into HubInner::admit() after `accept_closed` is
        //    cancelled must close the peer with 1001 GOING_AWAY and return Ok(None).
        hub.0.accept_closed.cancel();
        let guard_b = PeerGuard::new(CollabSessionAuth::new(
            Box::new(NoopLease),
            Cancellation::default(),
            None,
        ));
        let (mut sess_b, outbound_b, _ingress_b) =
            CollabPeerSession::pair(store.clone(), ctx_a.clone(), note_a.clone(), guard_b);
        let admitted = hub
            .0
            .admit(
                &ctx_a,
                &note_a,
                &LineageHello::Fresh,
                &outbound_b,
                Instant::now() + Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(admitted.is_none());
        let ev = sess_b.recv().await;
        assert_eq!(ev, Some(SessionEvent::Close(SessionClose::GOING_AWAY)));

        drop(hub);
        runtime.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn live_slot_queries_do_not_deadlock_under_concurrent_slot_drop() {
        let dir = TestDir::new("hub-slots-race");
        let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
            InstallationId::from_bytes([90; 16]),
            notarium_core::epoch::DataRoot::new(&dir.0),
        ))
        .await
        .unwrap();
        let hub = CollabHub::new(store, CollabConfig::default()).unwrap();
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([13; 16]),
            incarnation: HistoryIncarnation::from_bytes([14; 16]),
        };
        let note_a = NoteId::from_bytes([23; 16]);
        let note_b = NoteId::from_bytes([24; 16]);

        assert!(!hub.0.has_live_slot(&scope, &note_a));
        assert!(!hub.0.space_has_live_rooms(&scope.space_id));
        let held = hub.0.slot(&scope, &note_a);
        assert!(hub.0.has_live_slot(&scope, &note_a));
        assert!(hub.0.space_has_live_rooms(&scope.space_id));
        drop(held);
        assert!(!hub.0.has_live_slot(&scope, &note_a));
        assert!(!hub.0.space_has_live_rooms(&scope.space_id));

        // Stress concurrent slot drop against `has_live_slot` and
        // `space_has_live_rooms` on separate OS threads; upgrading `Weak` under
        // `HubInner::slots` would self-deadlock in `RoomSlot::drop`.
        let inner = Arc::clone(&hub.0);
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let scope_r = scope.clone();
        let note_a_r = note_a.clone();
        let note_b_r = note_b.clone();
        let inner_r = Arc::clone(&inner);
        let done_r = Arc::clone(&done);
        let reader = std::thread::spawn(move || {
            let mut spins = 0u64;
            while !done_r.load(Ordering::Acquire) {
                let _ = inner_r.has_live_slot(&scope_r, &note_a_r);
                let _ = inner_r.has_live_slot(&scope_r, &note_b_r);
                let _ = inner_r.space_has_live_rooms(&scope_r.space_id);
                spins = spins.wrapping_add(1);
            }
            spins
        });
        for i in 0..4_000u32 {
            let note = if i & 1 == 0 { &note_a } else { &note_b };
            let slot = inner.slot(&scope, note);
            std::hint::black_box(&slot);
            drop(slot);
        }
        done.store(true, Ordering::Release);
        let _ = reader.join().expect("reader thread must not panic");

        assert!(!hub.0.has_live_slot(&scope, &note_a));
        assert!(!hub.0.has_live_slot(&scope, &note_b));
        assert!(!hub.0.space_has_live_rooms(&scope.space_id));
        drop(inner);
        drop(hub);
        runtime.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_reports_stop_timeout_when_closing_room_does_not_finish_stopping() {
        let dir = TestDir::new("hub-shutdown-stop");
        let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
            InstallationId::from_bytes([91; 16]),
            notarium_core::epoch::DataRoot::new(&dir.0),
        ))
        .await
        .unwrap();
        let hub = CollabHub::new(store, CollabConfig::default()).unwrap();
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([15; 16]),
            incarnation: HistoryIncarnation::from_bytes([16; 16]),
        };
        let note = NoteId::from_bytes([25; 16]);

        // Mailbox is already closed (`room.shutdown()` immediately returns
        // `Ok(false)`), while `room.stopped()` stays pending. `CollabHub::shutdown`
        // must surface `collab_hub_shutdown_stop` rather than returning `Ok(())`.
        let detached = RoomHandle::detached_for_test(scope, note, Arc::clone(&hub.0.owner));
        hub.0.room_started(&detached);

        let mut short_budget = hub.0.budget();
        short_budget.remaining = Duration::from_millis(25);
        let err = hub.shutdown(&short_budget).await.unwrap_err();
        match err {
            PortError::DeadlineExceeded(failure) => {
                assert_eq!(
                    failure.diagnostic_ref(),
                    ContentDigest::from_bytes(
                        *blake3::hash(b"collab_hub_shutdown_stop").as_bytes()
                    ),
                    "expected collab_hub_shutdown_stop diagnostic ref"
                );
            }
            other => panic!("expected DeadlineExceeded(collab_hub_shutdown_stop), got {other:?}"),
        }

        assert!(!hub.0.shutdown.is_cancelled());
        // Once the closing room cancels `stopped`, shutdown completes cleanly.
        detached.stopped().cancel();
        let mut ok_budget = hub.0.budget();
        ok_budget.remaining = Duration::from_millis(200);
        hub.shutdown(&ok_budget).await.unwrap();

        drop(hub);
        runtime.shutdown().await.unwrap();
    }
}
