use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use notarium_canonical::{CanonicalStore, CollabRoomState, OpenCollabSession, SpaceSignal};
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
    sync::{Mutex as AsyncMutex, broadcast, mpsc},
    time::{Instant, timeout},
};

use crate::{
    interceptor::WeakInterceptor,
    room::{Room, RoomCommand, RoomHandle, recover_fenced},
    session::{
        CollabPeerSession, CollabSessionAuth, OutboundAuthority, PeerGuard, PeerOutbound,
        SessionClose,
    },
    wire::{LineageHello, LineageMismatch, PeerRole, decode_hello},
};

const OPEN_ATTEMPTS: usize = 3;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct CollabConfig {
    pub idle_checkpoint: Duration,
    pub periodic_checkpoint: Duration,
    pub checkpoint_updates: u64,
    pub intercept_coalesce: Duration,
    pub idle_unload: Duration,
    pub handshake_timeout: Duration,
}

impl Default for CollabConfig {
    fn default() -> Self {
        Self {
            idle_checkpoint: Duration::from_secs(3),
            periodic_checkpoint: Duration::from_secs(60),
            checkpoint_updates: 128,
            intercept_coalesce: Duration::from_millis(2),
            idle_unload: Duration::from_secs(30),
            handshake_timeout: Duration::from_secs(10),
        }
    }
}

impl CollabConfig {
    fn valid(&self) -> bool {
        let now = Instant::now();
        self.checkpoint_updates > 0
            && !self.idle_checkpoint.is_zero()
            && !self.periodic_checkpoint.is_zero()
            && !self.handshake_timeout.is_zero()
            && self.idle_unload >= self.idle_checkpoint
            && self.intercept_coalesce < Duration::from_millis(3)
            && [
                self.idle_checkpoint,
                self.periodic_checkpoint,
                self.intercept_coalesce,
                self.idle_unload,
                self.handshake_timeout,
            ]
            .into_iter()
            .all(|duration| now.checked_add(duration).is_some())
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
    peers: Mutex<HashMap<u64, PeerRegistration>>,
    shutdown: Cancellation,
}

struct PeerRegistration {
    note: NoteId,
    ctx: SpaceContext,
    guard: Weak<PeerGuard>,
}

impl Drop for HubInner {
    fn drop(&mut self) {
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
            config,
            owner,
            entropy,
            next_id: AtomicU64::new(1),
            slots: Mutex::default(),
            active: Mutex::default(),
            peers: Mutex::default(),
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
        self.0.active_rooms().len()
    }

    pub async fn connect(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        auth: CollabSessionAuth,
    ) -> Result<CollabPeerSession, PortError> {
        if matches!(
            ctx.auth().kind(),
            PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
        ) {
            return Err(DomainError::AccessDenied.into());
        }
        let guard = PeerGuard::new(auth);
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let registration = PendingPeer {
            hub: Arc::downgrade(&self.0),
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
        tokio::select! {
            biased;
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
            let slots: Vec<_> = self
                .0
                .slots
                .lock()
                .expect("room registry")
                .iter()
                .filter(|((id, _), _)| id == space)
                .filter_map(|(_, slot)| slot.upgrade())
                .collect();
            for slot in slots {
                let mut budget = ctx.budget.clone();
                budget.remaining = deadline.saturating_duration_since(Instant::now());
                drop(lock_slot(&slot, &budget).await?);
            }
        }
        for room in self.0.active_rooms() {
            let close = close_space == Some(&room.scope().space_id);
            if !room.stopped().is_cancelled()
                && (close || affected.remove(&(room.scope().space_id.clone(), room.note().clone())))
            {
                let remaining = deadline.saturating_duration_since(Instant::now());
                timeout(remaining, room.settle_after_revoke(close))
                    .await
                    .map_err(|_| deadline_error(b"collab_revocation_settle"))??;
            }
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
    hub: Weak<HubInner>,
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
        let hub = self.hub.clone();
        let id = self.id;
        let unregister = move || {
            if let Some(hub) = hub.upgrade() {
                hub.peers.lock().expect("peer registry").remove(&id);
            }
        };
        if self.guard.lease_lost().is_cancelled() {
            unregister();
        } else {
            // A draining transport can still receive data. Keep it visible
            // to revocation and history changes until its lease is released.
            let released = self.guard.lease_lost().clone();
            tokio::spawn(async move {
                released.cancelled().await;
                unregister();
            });
        }
    }
}

impl HubInner {
    pub fn shutdown_token(&self) -> Cancellation {
        self.shutdown.clone()
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

    fn active_rooms(&self) -> Vec<RoomHandle> {
        self.active
            .lock()
            .expect("active rooms")
            .values()
            .cloned()
            .collect()
    }

    pub fn room_stopped(&self, room: &RoomHandle) {
        let key = (room.scope().space_id.clone(), room.note().clone());
        let mut active = self.active.lock().expect("active rooms");
        if active
            .get(&key)
            .is_some_and(|registered| registered.same_lease(room))
        {
            active.remove(&key);
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
        let selected: Vec<_> = self
            .peers
            .lock()
            .expect("peer registry")
            .values()
            .filter(|peer| matches_selector(&peer.ctx, selector))
            .filter_map(|peer| {
                Some((
                    (peer.ctx.scope().space_id.clone(), peer.note.clone()),
                    peer.guard.upgrade()?,
                ))
            })
            .collect();
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
            Room::fence_record(&self.store, budget, scope, &record, &self.owner).await?;
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
        let slot = self.slot(ctx.scope(), note);
        let mut held = lock_slot(&slot, &ctx.budget).await?;
        let mut budget = ctx.budget.clone();
        for _ in 0..OPEN_ATTEMPTS {
            outbound
                .guard
                .check()
                .map_err(|_| DomainError::AccessDenied)?;
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            let current = self
                .store
                .read_current_history_scope(Some(&budget), &ctx.scope().space_id)
                .await?;
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
            let admission = self
                .store
                .read_note_collab_admission(&read_ctx, note, base)
                .await?;
            if admission.doc_class != DocClass::UserDoc {
                return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
            }
            let stored = admission.session.as_ref().map(|value| &value.session);
            let role = if admission.can_write {
                PeerRole::Editor
            } else {
                PeerRole::Viewer
            };
            if let LineageHello::Reconnect {
                client_history_incarnation,
                client_lineage_epoch,
                ..
            } = *hello
                && (client_history_incarnation != admission.scope.incarnation
                    || stored.is_none_or(|record| record.lineage_epoch != client_lineage_epoch))
            {
                outbound.finish(
                    LineageMismatch {
                        current_history_incarnation: admission.scope.incarnation,
                        current_rev_id: admission.head_rev_id,
                        current_lineage_epoch: stored
                            .map_or(LineageEpoch::ZERO, |record| record.lineage_epoch),
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
                return Ok(None);
            }
            ctx.check_current(&admission.scope)?;
            if let Some(room) = held.as_ref()
                && room.scope() == &admission.scope
                && !room.stopped().is_cancelled()
            {
                if stored.is_some_and(|record| room.matches_durable_lease(record)) {
                    return Ok(Some((room.clone(), role)));
                }
                room.storage_changed();
                tokio::time::timeout_at(deadline, room.stopped().cancelled())
                    .await
                    .map_err(|_| deadline_error(b"retire_stale_collab_room"))?;
                // Re-read admission after old actor retirement to pick up the
                // latest carrier and lineage before choosing a seed.
                continue;
            }
            budget.remaining = deadline.saturating_duration_since(Instant::now());
            if stored.is_some_and(|record| record.room_state == CollabRoomState::Fenced) {
                recover_fenced(&self.store, &budget, &admission.scope, note).await?;
                continue;
            }
            // A same-process actor may have stopped following an uncertain
            // commit. Its exact durable lease must be fenced before replay.
            if let Some(record) = stored.filter(|record| {
                record.room_state == CollabRoomState::Active
                    && record.owner_id.as_deref() == Some(self.owner.as_ref())
            }) {
                Room::fence_record(&self.store, &budget, &admission.scope, record, &self.owner)
                    .await?;
                budget.remaining = deadline.saturating_duration_since(Instant::now());
                recover_fenced(&self.store, &budget, &admission.scope, note).await?;
                continue;
            }
            let prepared = Room::prepare(&admission, note)?;
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
                    );
                    *held = Some(handle.clone());
                    return Ok(Some((handle, role)));
                }
                Err(PortError::Domain(DomainError::RevisionConflict { .. })) => {}
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::SourceMismatch => {}
                Err(error) if unknown(&error) => {
                    // The open may finish after the handshake expires. Resolve
                    // any unpublished lease under the same slot.
                    self.recover_unhosted(&self.budget(), &admission.scope, note)
                        .await?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(DomainError::validation(ValidationReason::NotReady).into())
    }
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
    let first_frame = tokio::select! {
        biased;
        () = guard.stopped().cancelled() => return,
        result = tokio::time::timeout_at(deadline, ingress.recv()) => match result {
            Ok(Some(frame)) => frame,
            _ => return,
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
    let Some(owner) = hub.upgrade() else { return };
    let room = attach_peer(&owner, &mut peer, ctx, &note, &hello, &outbound, deadline).await;
    drop(owner);
    let Some(room) = room else { return };
    loop {
        let frame = tokio::select! {
            biased;
            () = guard.stopped().cancelled() => break,
            () = room.stopped().cancelled() => break,
            frame = ingress.recv() => match frame { Some(frame) => frame, None => break },
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
        let (room, role) = owner
            .admit(&ctx, note, hello, outbound, deadline)
            .await
            .ok()??;
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
                () = tokio::time::sleep_until(deadline) => return None,
                result = received => result,
            } {
                Ok(true) => return Some(room),
                Ok(false) => return None,
                Err(_) => {}
            }
        }
        // The idle-unload timer may have won against a newly enqueued join.
        // Recheck lineage under a new open before returning any setup frames.
        tokio::select! {
            biased;
            () = guard.stopped().cancelled() => return None,
            () = tokio::time::sleep_until(deadline) => return None,
            () = room.stopped().cancelled() => {}
        }
    }
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
        let scope = match &signal {
            Ok(
                SpaceSignal::Committed { scope, .. }
                | SpaceSignal::Purged { scope, .. }
                | SpaceSignal::WriterLeaseChanged { scope },
            ) => Some(scope),
            Ok(SpaceSignal::IncarnationChanged { new_scope, .. }) => {
                let peers = hub.peers.lock().expect("peer registry");
                for peer in peers.values().filter(|peer| {
                    let scope = peer.ctx.scope();
                    scope.space_id == new_scope.space_id && scope != new_scope
                }) {
                    if let Some(guard) = peer.guard.upgrade() {
                        guard.close(SessionClose::POLICY);
                    }
                }
                Some(new_scope)
            }
            Err(broadcast::error::RecvError::Lagged(_)) => None,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        for room in hub.active_rooms() {
            if scope.is_none_or(|scope| scope.space_id == room.scope().space_id) {
                room.storage_changed();
            }
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
