mod mutations;
mod persistence;

use std::{
    collections::HashMap,
    future::pending,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use notarium_canonical::{CanonicalStore, CollabRoomState, CollabSessionRecord, RoomWalEntry};
use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError, ValidationReason},
    ids::{LeaseEpoch, LineageEpoch, NoteId},
    model::HistoryScope,
    ports::{CallBudget, Cancellation, InterceptedMutation, InterceptionResult, SpaceContext},
};
use tokio::{
    sync::{Notify, mpsc, oneshot, watch},
    time::{Instant, sleep_until},
};

use crate::{
    carrier::RoomCarrierState,
    crdt::TwinDoc,
    hub::{CollabConfig, HubInner, RoomSlot, operation_error},
    presence::Presence,
    session::{OutboundAuthority, PeerOutbound, SessionClose, is_authorized},
    wire::{
        InboundMessage, LineageReady, MAX_FRAME_BYTES, PeerRole, ServerAckWatermark, decode_frame,
        encode_awareness, encode_policy_rejected, encode_sync_step1, encode_sync_step2,
        encode_update_into,
    },
};
use persistence::{PendingUpdate, PreparedRoom, invalid_state};

pub(crate) use persistence::recover_fenced;

const MAILBOX_CAPACITY: usize = 32;
const WAL_GROUP_SIZE: usize = 64;
const WAL_GROUP_BYTES: usize = 4 * 1024 * 1024;
const MAX_PEERS: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JoinOutcome {
    Accepted,
    CapacityExceeded,
    Denied,
    Unavailable,
    RoomClosing,
}

pub(crate) enum InterceptReply {
    Result(Result<InterceptionResult, PortError>),
    /// Room entered closing before servicing this queued mutation. The caller
    /// waits for `room.stopped()` and retries on the closed-room path.
    RoomClosingNotStarted(Box<InterceptedMutation>),
}

pub(crate) enum RoomCommand {
    Join {
        id: u64,
        ctx: Box<SpaceContext>,
        role: PeerRole,
        outbound: PeerOutbound,
        reply: oneshot::Sender<JoinOutcome>,
        deadline: Instant,
    },
    Frame {
        id: u64,
        frame: Vec<u8>,
    },
    Intercept {
        request: Box<InterceptedMutation>,
        reply: oneshot::Sender<InterceptReply>,
        deadline: Instant,
    },
    Revoked {
        close: bool,
        reply: oneshot::Sender<Result<(), PortError>>,
    },
    Shutdown {
        budget: CallBudget,
        reply: oneshot::Sender<Result<(), PortError>>,
    },
}

#[derive(Clone)]
pub(crate) struct RoomHandle {
    lease: Arc<RoomLease>,
    commands: mpsc::Sender<RoomCommand>,
    stopped: Cancellation,
    settled: Arc<AtomicBool>,
    slug: watch::Receiver<String>,
    peers_changed: Arc<Notify>,
    storage_changed: Arc<Notify>,
    last_self_seq: Arc<AtomicU64>,
    pending_note_seq: Arc<AtomicU64>,
    pending_broad_change: Arc<AtomicBool>,
}

impl RoomHandle {
    pub fn scope(&self) -> &HistoryScope {
        &self.lease.scope
    }

    pub fn note(&self) -> &NoteId {
        &self.lease.note
    }

    pub fn epoch(&self) -> LeaseEpoch {
        self.lease.epoch
    }

    pub fn lineage(&self) -> LineageEpoch {
        self.lease.lineage
    }

    pub fn slug(&self) -> String {
        self.slug.borrow().clone()
    }

    pub fn stopped(&self) -> &Cancellation {
        &self.stopped
    }

    pub fn was_settled(&self) -> bool {
        self.settled.load(Ordering::Acquire)
    }

    pub fn same_lease(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.lease, &other.lease)
    }

    pub fn matches_durable_lease(&self, record: &CollabSessionRecord) -> bool {
        record.room_state == CollabRoomState::Active
            && record.lease_epoch == self.lease.epoch
            && record.lineage_epoch == self.lease.lineage
            && record.owner_id.as_deref() == Some(self.lease.owner.as_ref())
    }

    pub async fn send(
        &self,
        command: RoomCommand,
    ) -> Result<(), mpsc::error::SendError<RoomCommand>> {
        self.commands.send(command).await
    }

    pub fn peer_changed(&self) {
        self.peers_changed.notify_one();
    }

    pub fn storage_changed(&self) {
        self.pending_broad_change.store(true, Ordering::Release);
        self.storage_changed.notify_one();
    }

    /// Record a solo commit targeting only this room's note at `seq`.
    /// If the commit came from this room's own settlement/command, the actor
    /// updates `last_self_seq` before polling `storage_changed` and skips a
    /// redundant `revalidate()` read without allowing a later self-commit to
    /// mask an earlier concurrent external commit (such as `move_note`).
    pub fn note_solo_committed(&self, seq: u64) {
        if self.last_self_seq.load(Ordering::Acquire) == seq {
            return;
        }
        match self
            .pending_note_seq
            .compare_exchange(0, seq, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => {}
            Err(prev) if prev == seq => {}
            Err(_) => {
                self.pending_broad_change.store(true, Ordering::Release);
            }
        }
        self.storage_changed.notify_one();
    }

    fn take_needs_revalidate(&self) -> bool {
        let broad = self.pending_broad_change.swap(false, Ordering::AcqRel);
        let pending_seq = self.pending_note_seq.swap(0, Ordering::AcqRel);
        let self_seq = self.last_self_seq.load(Ordering::Acquire);
        broad || (pending_seq != 0 && pending_seq != self_seq)
    }

    /// Settle or close the room after revocation. Returns `Ok(false)` if the
    /// room's mailbox is already closed because it began stopping naturally;
    /// callers should await `room.stopped()` before assuming durability.
    pub async fn settle_after_revoke(&self, close: bool) -> Result<bool, PortError> {
        let (reply, received) = oneshot::channel();
        if self
            .send(RoomCommand::Revoked { close, reply })
            .await
            .is_err()
        {
            return Ok(false);
        }
        match received.await {
            Ok(Ok(())) => Ok(true),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(operation_error(
                b"collab_revocation_room_stopped",
                CommitEffect::Unknown,
            )),
        }
    }

    /// Gracefully settle and close the room during hub shutdown.
    pub async fn shutdown(&self, budget: CallBudget) -> Result<bool, PortError> {
        let (reply, received) = oneshot::channel();
        if self
            .send(RoomCommand::Shutdown { budget, reply })
            .await
            .is_err()
        {
            return Ok(false);
        }
        match received.await {
            Ok(Ok(())) => Ok(true),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(operation_error(
                b"collab_shutdown_room_stopped",
                CommitEffect::Unknown,
            )),
        }
    }

    #[cfg(test)]
    pub(crate) fn detached_for_test(scope: HistoryScope, note: NoteId, owner: Arc<str>) -> Self {
        let lease = Arc::new(RoomLease {
            scope,
            note,
            epoch: LeaseEpoch::new(1).expect("non-zero lease epoch"),
            lineage: LineageEpoch::ZERO,
            owner,
        });
        let (commands, receiver) = mpsc::channel(1);
        drop(receiver);
        let (_tx, slug) = watch::channel(String::new());
        Self {
            lease,
            commands,
            stopped: Cancellation::default(),
            settled: Arc::new(AtomicBool::new(false)),
            slug,
            peers_changed: Arc::new(Notify::new()),
            storage_changed: Arc::new(Notify::new()),
            last_self_seq: Arc::new(AtomicU64::new(0)),
            pending_note_seq: Arc::new(AtomicU64::new(0)),
            pending_broad_change: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct RoomLease {
    scope: HistoryScope,
    note: NoteId,
    epoch: LeaseEpoch,
    lineage: LineageEpoch,
    owner: Arc<str>,
}

impl RoomLease {
    fn authority(&self, role: PeerRole) -> OutboundAuthority {
        OutboundAuthority::Active {
            scope: self.scope.clone(),
            role,
            lease: self.epoch,
            lineage: self.lineage,
            owner: self.owner.clone(),
        }
    }
}

struct Peer {
    ctx: SpaceContext,
    outbound: PeerOutbound,
    role: PeerRole,
    write_seq: u64,
}

pub(crate) struct Room {
    store: CanonicalStore,
    config: CollabConfig,
    hub: Weak<HubInner>,
    lease: Arc<RoomLease>,
    slug: watch::Sender<String>,
    last_self_seq: Arc<AtomicU64>,
    twin: TwinDoc,
    carrier: RoomCarrierState,
    last_seq: u64,
    updates_since_checkpoint: u64,
    first_dirty: Option<Instant>,
    last_dirty: Option<Instant>,
    empty_since: Option<Instant>,
    peers: HashMap<u64, Peer>,
    presence: Presence,
}

impl Room {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        hub: &Arc<HubInner>,
        slot: Arc<RoomSlot>,
        scope: HistoryScope,
        slug: String,
        record: CollabSessionRecord,
        prepared: PreparedRoom,
        capacity: tokio::sync::OwnedSemaphorePermit,
        space_capacity: crate::hub::SpaceRoomPermit,
    ) -> RoomHandle {
        let lease = Arc::new(RoomLease {
            scope,
            note: record.note,
            epoch: record.lease_epoch,
            lineage: record.lineage_epoch,
            owner: hub.owner.clone(),
        });
        let (commands, receiver) = mpsc::channel(MAILBOX_CAPACITY);
        let (slug, file) = watch::channel(slug);
        let last_self_seq = Arc::new(AtomicU64::new(record.updated_seq.get()));
        let handle = RoomHandle {
            lease: lease.clone(),
            commands,
            stopped: Cancellation::default(),
            settled: Arc::new(AtomicBool::new(false)),
            slug: file,
            peers_changed: Arc::new(Notify::new()),
            storage_changed: Arc::new(Notify::new()),
            last_self_seq: Arc::clone(&last_self_seq),
            pending_note_seq: Arc::new(AtomicU64::new(0)),
            pending_broad_change: Arc::new(AtomicBool::new(false)),
        };
        let dirty = record.carrier_dirty.then(Instant::now);
        let room = Self {
            store: hub.store.clone(),
            config: hub.config.clone(),
            hub: Arc::downgrade(hub),
            lease,
            slug,
            last_self_seq,
            twin: prepared.twin,
            carrier: prepared.carrier,
            last_seq: 0,
            updates_since_checkpoint: 0,
            first_dirty: dirty,
            last_dirty: dirty,
            empty_since: Some(Instant::now()),
            peers: HashMap::new(),
            presence: Presence::default(),
        };
        let lifecycle = handle.clone();
        let shutdown = hub.shutdown_token();
        hub.room_started(&handle);
        tokio::spawn(async move {
            // Declare `stop` FIRST so Rust drops `room` (TwinDoc, BodyIndex,
            // Topology, Presence) and releases `_slot`, `_space_capacity`, and
            // `_capacity` strictly BEFORE `StopRoom::drop` publishes
            // `room_stopped` and cancels `stopped`.
            let mut stop = StopRoom {
                settled: false,
                hub: room.hub.clone(),
                handle: lifecycle.clone(),
            };
            let _capacity = capacity;
            let _space_capacity = space_capacity;
            let _slot = slot;
            {
                let mut room = room;
                let result = room.run(receiver, &lifecycle, shutdown).await;
                stop.settled = result.is_ok();
                for peer in room.peers.values() {
                    if !peer.outbound.guard.stopped().is_cancelled() {
                        peer.outbound.guard.close(SessionClose::POLICY);
                    }
                }
                if let Err(error) = result {
                    tracing::warn!(
                        code = error.code(),
                        space_id = %room.lease.scope.space_id,
                        note_id = %room.lease.note,
                        lease_epoch = room.lease.epoch.get(),
                        "collaboration room stopped"
                    );
                    if !scope_has_changed(&error)
                        && let Err(fence_error) = room.fence().await
                    {
                        tracing::warn!(
                            code = fence_error.code(),
                            space_id = %room.lease.scope.space_id,
                            note_id = %room.lease.note,
                            lease_epoch = room.lease.epoch.get(),
                            "collaboration lease fence failed"
                        );
                    }
                }
            }
        });
        handle
    }

    fn budget(&self) -> CallBudget {
        self.hub.upgrade().map_or_else(
            || {
                let cancellation = Cancellation::default();
                cancellation.cancel();
                CallBudget {
                    request: notarium_core::ids::RequestId::from_bytes([0; 16]),
                    cancellation,
                    remaining: std::time::Duration::ZERO,
                }
            },
            |hub| hub.budget(),
        )
    }

    /// Close the mailbox before shutting down and reply cleanly to buffered
    /// commands so intercepted callers fall back to the closed-room path
    /// instead of receiving `CommitEffect::Unknown`.
    fn drain_on_close(
        &mut self,
        commands: &mut mpsc::Receiver<RoomCommand>,
        pending_cmd: Option<RoomCommand>,
    ) -> Vec<oneshot::Sender<Result<(), PortError>>> {
        commands.close();
        let mut waiters = Vec::new();
        let mut handle = |cmd: RoomCommand| match cmd {
            RoomCommand::Join { reply, .. } => {
                let _ = reply.send(JoinOutcome::RoomClosing);
            }
            RoomCommand::Intercept { request, reply, .. } => {
                let _ = reply.send(InterceptReply::RoomClosingNotStarted(request));
            }
            RoomCommand::Revoked { reply, .. } | RoomCommand::Shutdown { reply, .. } => {
                waiters.push(reply);
            }
            RoomCommand::Frame { .. } => {}
        };
        if let Some(cmd) = pending_cmd {
            handle(cmd);
        }
        while let Ok(cmd) = commands.try_recv() {
            handle(cmd);
        }
        waiters
    }

    async fn run(
        &mut self,
        mut commands: mpsc::Receiver<RoomCommand>,
        handle: &RoomHandle,
        shutdown: Cancellation,
    ) -> Result<(), PortError> {
        let mut next_command = None;
        let result = self
            .run_loop(&mut commands, &mut next_command, handle, shutdown)
            .await;
        // Drain any remaining buffered commands on every exit path (including
        // error exits) so queued unstarted `Intercept` mutations receive
        // `RoomClosingNotStarted` instead of spurious `CommitEffect::Unknown`.
        let _ = self.drain_on_close(&mut commands, next_command.take());
        result
    }

    async fn run_loop(
        &mut self,
        commands: &mut mpsc::Receiver<RoomCommand>,
        next_command: &mut Option<RoomCommand>,
        handle: &RoomHandle,
        shutdown: Cancellation,
    ) -> Result<(), PortError> {
        loop {
            if shutdown.is_cancelled() {
                return Ok(());
            }
            let command = if let Some(command) = next_command.take() {
                command
            } else {
                let checkpoint_at = self.checkpoint_at();
                let unload_at = self
                    .empty_since
                    .map(|since| since + self.config.idle_unload);
                tokio::select! {
                    () = shutdown.cancelled() => {
                        return Ok(());
                    }
                    () = handle.storage_changed.notified() => {
                        if handle.take_needs_revalidate() {
                            self.revalidate().await?;
                        }
                        continue;
                    }
                    () = handle.peers_changed.notified() => {
                        let revoke_watermark =
                            self.hub.upgrade().map(|hub| hub.current_revoke_seq());
                        if self.reap_peers() {
                            self.carrier.last_writer_auth = None;
                            self.carrier.last_writer_peer = None;
                            self.checkpoint(&self.budget()).await?;
                        } else if self.first_dirty.is_none()
                            && let Some(watermark) = revoke_watermark
                        {
                            self.prune_settled_revocations(watermark);
                        }
                        continue;
                    }
                    () = wait_for(unload_at) => {
                        let waiters = self.drain_on_close(commands, None);
                        let res = self.close(&self.budget()).await;
                        for waiter in waiters {
                            let _ = waiter.send(res.as_ref().copied().map_err(|_| {
                                operation_error(
                                    b"collab_idle_close_failed",
                                    CommitEffect::Unknown,
                                )
                            }));
                        }
                        res?;
                        return Ok(());
                    }
                    () = wait_for(checkpoint_at) => {
                        self.checkpoint(&self.budget()).await?;
                        continue;
                    }
                    command = commands.recv() => match command {
                        Some(command) => command,
                        None => return Ok(()),
                    },
                }
            };
            match command {
                RoomCommand::Join {
                    id,
                    ctx,
                    role,
                    outbound,
                    reply,
                    deadline,
                } => {
                    let outcome = self.join(id, *ctx, role, outbound, deadline).await;
                    let _ = reply.send(outcome);
                }
                RoomCommand::Frame { id, frame } => {
                    let mut batch = Vec::new();
                    self.handle_frame(id, &frame, &mut batch).await?;
                    let coalesce = Instant::now() + self.config.wal_coalesce;
                    let has_multiple_editors = self
                        .peers
                        .values()
                        .filter(|peer| peer.role == PeerRole::Editor)
                        .take(2)
                        .count()
                        > 1;
                    let mut frames = 1;
                    while frames < MAILBOX_CAPACITY && batch.len() < WAL_GROUP_SIZE {
                        let command = if batch.is_empty()
                            || self.config.wal_coalesce.is_zero()
                            || !has_multiple_editors
                        {
                            commands.try_recv().ok()
                        } else {
                            tokio::select! {
                                biased;
                                () = shutdown.cancelled() => {
                                    return Ok(());
                                }
                                () = sleep_until(coalesce) => None,
                                command = commands.recv() => command,
                            }
                        };
                        match command {
                            Some(RoomCommand::Frame { id, frame }) => {
                                self.handle_frame(id, &frame, &mut batch).await?;
                                frames += 1;
                            }
                            other => {
                                *next_command = other;
                                break;
                            }
                        }
                    }
                    self.flush_batch(&mut batch).await?;
                    if self.updates_since_checkpoint >= self.config.checkpoint_updates {
                        self.checkpoint(&self.budget()).await?;
                    }
                }
                RoomCommand::Intercept {
                    mut request,
                    reply,
                    deadline,
                } => {
                    request.context.budget.remaining =
                        deadline.saturating_duration_since(Instant::now());
                    let outcome = self.intercept_command(*request).await;
                    let _ = reply.send(InterceptReply::Result(outcome.reply));
                    if outcome.poison_room {
                        return Err(operation_error(
                            b"collab_command_unresolved",
                            CommitEffect::Unknown,
                        ));
                    }
                }
                RoomCommand::Revoked { close, reply } => {
                    self.reap_peers();
                    self.carrier.last_writer_auth = None;
                    self.carrier.last_writer_peer = None;
                    let waiters = if close {
                        for peer in self.peers.values() {
                            peer.outbound.guard.close(SessionClose::POLICY);
                        }
                        self.drain_on_close(commands, next_command.take())
                    } else {
                        Vec::new()
                    };
                    let result = if close {
                        self.close(&self.budget()).await
                    } else {
                        self.checkpoint(&self.budget()).await
                    };
                    let failed = result.is_err();
                    let _ = reply.send(result);
                    for waiter in waiters {
                        let _ = waiter.send(if failed {
                            Err(operation_error(
                                b"collab_revocation_checkpoint",
                                CommitEffect::Unknown,
                            ))
                        } else {
                            Ok(())
                        });
                    }
                    if failed {
                        return Err(operation_error(
                            b"collab_revocation_checkpoint",
                            CommitEffect::Unknown,
                        ));
                    }
                    if close {
                        return Ok(());
                    }
                }
                RoomCommand::Shutdown { budget, reply } => {
                    for peer in self.peers.values() {
                        peer.outbound.guard.close(SessionClose::GOING_AWAY);
                    }
                    let waiters = self.drain_on_close(commands, next_command.take());
                    let result = self.close(&budget).await;
                    let failed = result.is_err();
                    let _ = reply.send(result);
                    for waiter in waiters {
                        let _ = waiter.send(if failed {
                            Err(operation_error(
                                b"collab_shutdown_close",
                                CommitEffect::Unknown,
                            ))
                        } else {
                            Ok(())
                        });
                    }
                    if failed {
                        return Err(operation_error(
                            b"collab_shutdown_close",
                            CommitEffect::Unknown,
                        ));
                    }
                    return Ok(());
                }
            }
        }
    }

    fn checkpoint_at(&self) -> Option<Instant> {
        self.first_dirty.zip(self.last_dirty).map(|(first, last)| {
            (first + self.config.periodic_checkpoint).min(last + self.config.idle_checkpoint)
        })
    }

    async fn join(
        &mut self,
        id: u64,
        mut ctx: SpaceContext,
        role: PeerRole,
        outbound: PeerOutbound,
        deadline: Instant,
    ) -> JoinOutcome {
        if self.peers.len() >= MAX_PEERS {
            return JoinOutcome::CapacityExceeded;
        }
        if outbound.guard.check().is_err() {
            return JoinOutcome::Denied;
        }
        ctx.budget.remaining = deadline.saturating_duration_since(Instant::now());
        let facts = match self.refresh_metadata(&ctx.budget).await {
            Ok(facts) => facts,
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if matches!(
                    diagnostic.reason,
                    ValidationReason::InvalidState
                        | ValidationReason::InvalidAuthority
                        | ValidationReason::SourceMismatch
                        | ValidationReason::HistoryIncarnationMismatch
                ) =>
            {
                return JoinOutcome::RoomClosing;
            }
            Err(PortError::Domain(_)) => return JoinOutcome::Denied,
            Err(_) => return JoinOutcome::Unavailable,
        };
        if Instant::now() >= deadline
            || !is_authorized(&ctx, role, &facts)
            || outbound.guard.check().is_err()
        {
            return JoinOutcome::Denied;
        }
        let ready = LineageReady {
            history_incarnation: self.lease.scope.incarnation,
            lineage_epoch: self.lease.lineage,
            current_rev_id: self.carrier.carrier_rev_id.clone(),
            lease_epoch: self.lease.epoch,
            role,
            fm_writable: self.carrier.fm_writable,
        };
        if outbound
            .send(ready.encode(), self.lease.authority(role))
            .is_err()
            || outbound
                .send(
                    encode_sync_step1(self.twin.live_state_vector()),
                    self.lease.authority(role),
                )
                .is_err()
        {
            return JoinOutcome::Denied;
        }
        if let Some(presence) = self.presence.snapshot()
            && outbound
                .send(encode_awareness(&presence), self.lease.authority(role))
                .is_err()
        {
            return JoinOutcome::Denied;
        }
        self.peers.insert(
            id,
            Peer {
                ctx,
                outbound,
                role,
                write_seq: 0,
            },
        );
        self.empty_since = None;
        JoinOutcome::Accepted
    }

    fn recheck_peer_access(&self, facts: &notarium_core::auth::ResourceFacts) {
        for peer in self.peers.values() {
            if !is_authorized(&peer.ctx, peer.role, facts) {
                peer.outbound.guard.close(SessionClose::POLICY);
            }
        }
    }

    async fn revalidate(&mut self) -> Result<(), PortError> {
        let facts = self.refresh_metadata(&self.budget()).await?;
        self.recheck_peer_access(&facts);
        if self.reap_peers() {
            self.carrier.last_writer_auth = None;
            self.carrier.last_writer_peer = None;
            self.checkpoint(&self.budget()).await?;
        }
        Ok(())
    }

    fn prune_settled_revocations(&self, watermark: u64) {
        if let Some(hub) = self.hub.upgrade() {
            let key = (self.lease.scope.space_id.clone(), self.lease.note.clone());
            hub.prune_settled_revocations(&key, watermark, |peer_id| {
                !self.peers.contains_key(&peer_id)
            });
        }
    }

    fn has_writers(&self) -> bool {
        self.peers
            .values()
            .any(|peer| peer.role == PeerRole::Editor)
    }

    fn reap_peers(&mut self) -> bool {
        let mut left = Vec::new();
        let mut lost_writer = false;
        let mut revoked_writer = false;
        self.peers.retain(|id, peer| {
            let alive = peer.outbound.guard.check().is_ok();
            if !alive {
                left.push(*id);
                lost_writer |= peer.role == PeerRole::Editor;
                revoked_writer |=
                    peer.role == PeerRole::Editor && peer.outbound.guard.policy_closed();
            }
            alive
        });
        if self
            .carrier
            .last_writer_peer
            .is_some_and(|writer| left.contains(&writer))
        {
            self.carrier.last_writer_auth = None;
            self.carrier.last_writer_peer = None;
        }
        for id in left {
            if let Some(update) = self.presence.remove_peer(id) {
                self.broadcast(encode_awareness(&update));
            }
        }
        if self.peers.is_empty() {
            self.empty_since.get_or_insert_with(Instant::now);
        }
        revoked_writer || (lost_writer && !self.has_writers())
    }

    async fn handle_frame(
        &mut self,
        id: u64,
        frame: &[u8],
        batch: &mut Vec<PendingUpdate>,
    ) -> Result<(), PortError> {
        let Some(peer) = self.peers.get(&id) else {
            return Ok(());
        };
        if peer.outbound.guard.check().is_err() {
            return Ok(());
        }
        let client_ids = self.twin.client_ids();
        let messages = match decode_frame(frame, peer.role, &client_ids) {
            Ok(messages) => messages,
            Err(error) => {
                return self
                    .close_after_batch(
                        id,
                        batch,
                        SessionClose {
                            code: error.code(),
                            reason: error.reason(),
                        },
                    )
                    .await;
            }
        };
        let mut bytes: usize = batch.iter().map(PendingUpdate::mem_bytes).sum();
        for message in messages {
            let Some(peer) = self.peers.get(&id) else {
                break;
            };
            if peer.outbound.guard.check().is_err() {
                break;
            }
            let role = peer.role;
            match message {
                InboundMessage::SyncStep1(state) => {
                    self.flush_batch(batch).await?;
                    bytes = 0;
                    let Ok(state) = state.decode_known(|client| self.twin.has_client(client))
                    else {
                        return self
                            .close_after_batch(
                                id,
                                batch,
                                SessionClose {
                                    code: 1002,
                                    reason: "invalid state vector",
                                },
                            )
                            .await;
                    };
                    if let Some(peer) = self.peers.get(&id) {
                        let update = self.twin.sync_step2(&state);
                        let _ = peer
                            .outbound
                            .send(encode_sync_step2(&update), self.lease.authority(role));
                    }
                }
                InboundMessage::SyncStep2(update) | InboundMessage::Update(update) => {
                    if batch.len() >= WAL_GROUP_SIZE
                        || bytes.saturating_add(update.len() * 2) > WAL_GROUP_BYTES
                    {
                        self.flush_batch(batch).await?;
                        bytes = 0;
                    }
                    if let Some(staged) = self.stage(id, update, batch).await? {
                        if batch.is_empty() {
                            bytes = 0;
                        }
                        bytes += staged.mem_bytes();
                        batch.push(staged);
                    } else if batch.is_empty() {
                        bytes = 0;
                    }
                }
                InboundMessage::Awareness(update) => {
                    let Ok(update) = update.decode() else {
                        return self
                            .close_after_batch(
                                id,
                                batch,
                                SessionClose {
                                    code: 1002,
                                    reason: "invalid awareness update",
                                },
                            )
                            .await;
                    };
                    if let Some(update) = self.presence.apply(id, update) {
                        self.broadcast_except(id, encode_awareness(&update));
                    }
                }
                InboundMessage::AwarenessQuery => {
                    if let Some(update) = self.presence.snapshot() {
                        let _ = peer
                            .outbound
                            .send(encode_awareness(&update), self.lease.authority(role));
                    }
                }
            }
        }
        Ok(())
    }

    async fn close_after_batch(
        &mut self,
        id: u64,
        batch: &mut Vec<PendingUpdate>,
        close: SessionClose,
    ) -> Result<(), PortError> {
        if let Some(peer) = self.peers.get(&id) {
            peer.outbound.guard.stop_input();
        }
        self.flush_batch(batch).await?;
        if let Some(peer) = self.peers.get(&id) {
            peer.outbound.finish_after_output(close);
        }
        Ok(())
    }

    async fn ack_noop_update(
        &mut self,
        id: u64,
        prefix: &mut Vec<PendingUpdate>,
    ) -> Result<Option<PendingUpdate>, PortError> {
        let Some(peer) = self.peers.get_mut(&id) else {
            return Ok(None);
        };
        let Some(next) = peer.write_seq.checked_add(1) else {
            return Err(DomainError::validation(ValidationReason::SequenceOverflow).into());
        };
        peer.write_seq = next;
        self.flush_batch(prefix).await?;
        let ack = ServerAckWatermark {
            lease_epoch: self.lease.epoch,
            peer_write_seq: next,
            room_update_seq: self.last_seq,
        };
        if let Some(peer) = self.peers.get(&id) {
            let _ = peer
                .outbound
                .send(ack.encode(), self.lease.authority(PeerRole::Editor));
        }
        Ok(None)
    }

    async fn stage(
        &mut self,
        id: u64,
        original: &[u8],
        prefix: &mut Vec<PendingUpdate>,
    ) -> Result<Option<PendingUpdate>, PortError> {
        let Some(peer) = self.peers.get(&id) else {
            return Ok(None);
        };
        if peer.role != PeerRole::Editor || peer.outbound.guard.check().is_err() {
            return Ok(None);
        }
        // An empty y-sync update (e.g. SyncStep2 confirmation) advances the
        // peer's write watermark and ACKs with the current durable room seq
        // after flushing preceding edits, without inserting a no-op WAL row.
        if original == [0, 0] {
            return self.ack_noop_update(id, prefix).await;
        }
        let mut staged_after_flush = false;
        loop {
            match self
                .twin
                .stage_peer(original, &self.carrier, &self.lease.note)
            {
                Ok(staged) => {
                    let Some(peer) = self.peers.get_mut(&id) else {
                        self.reset_staging(prefix)?;
                        return Ok(None);
                    };
                    if peer.outbound.guard.check().is_err() {
                        self.reset_staging(prefix)?;
                        return Ok(None);
                    }
                    // A duplicate/already-applied update normalizes to the empty
                    // Yjs update `[0, 0]`: ACK at the durable watermark without
                    // writing a no-op WAL row. When uncommitted `prefix` writes
                    // exist, flush them first and re-stage against `live` so a
                    // rejected earlier author in `prefix` cannot silently drop
                    // an overlapping edit from an authorized peer.
                    if staged.bytes == [0, 0] {
                        if !prefix.is_empty() && !staged_after_flush {
                            self.flush_batch(prefix).await?;
                            let Some(peer) = self.peers.get(&id) else {
                                return Ok(None);
                            };
                            if peer.role != PeerRole::Editor || peer.outbound.guard.check().is_err()
                            {
                                return Ok(None);
                            }
                            staged_after_flush = true;
                            continue;
                        }
                        return self.ack_noop_update(id, prefix).await;
                    }
                    let Some(next) = peer.write_seq.checked_add(1) else {
                        return Err(
                            DomainError::validation(ValidationReason::SequenceOverflow).into()
                        );
                    };
                    peer.write_seq = next;
                    let staged_diff = (staged.bytes.as_slice() != original).then_some(staged.bytes);
                    return Ok(Some(PendingUpdate {
                        peer: id,
                        peer_seq: next,
                        auth: peer.ctx.auth().clone(),
                        original: original.to_vec(),
                        staged: staged_diff,
                    }));
                }
                Err(reason) => {
                    if let Some(peer) = self.peers.get(&id) {
                        peer.outbound.guard.stop_input();
                    }
                    self.reset_staging(prefix)?;
                    // The terminal transition retires the guard for WAL admission.
                    // Settle and queue the valid prefix before entering that state.
                    self.flush_batch(prefix).await?;
                    if let Some(peer) = self.peers.get(&id) {
                        peer.outbound.finish(
                            encode_policy_rejected(reason),
                            self.lease.authority(peer.role),
                            SessionClose::POLICY,
                        );
                    }
                    return Ok(None);
                }
            }
        }
    }

    fn reset_staging(&mut self, prefix: &[PendingUpdate]) -> Result<(), PortError> {
        let updates: Vec<_> = prefix.iter().map(PendingUpdate::staged_bytes).collect();
        self.twin.reset_staging(&updates).map_err(invalid_state)
    }

    async fn flush_batch(&mut self, batch: &mut Vec<PendingUpdate>) -> Result<(), PortError> {
        if batch.is_empty() {
            return Ok(());
        }
        let writes = std::mem::take(batch);
        match self.append(&self.budget(), &writes).await {
            Ok(seq) => self.publish(seq, &writes),
            Err(PortError::Domain(
                DomainError::AccessDenied
                | DomainError::SpaceReadOnly
                | DomainError::ResourceNotFound,
            )) => {
                // A revoked or relocated author does not discard an unrelated
                // writer. Re-validate from live, recreating each surviving
                // candidate in order with its original peer watermark.
                self.reset_staging(&[])?;
                self.retry_authorized(writes).await
            }
            Err(error) => Err(error),
        }
    }

    async fn retry_authorized(&mut self, writes: Vec<PendingUpdate>) -> Result<(), PortError> {
        let facts = self.refresh_metadata(&self.budget()).await?;
        for mut update in writes {
            let Some(peer) = self.peers.get(&update.peer) else {
                continue;
            };
            if peer.outbound.guard.check().is_err() {
                continue;
            }
            if !is_authorized(&peer.ctx, peer.role, &facts) {
                peer.outbound.guard.close(SessionClose::POLICY);
                continue;
            }
            let staged = self
                .twin
                .stage_peer(&update.original, &self.carrier, &self.lease.note);
            match staged {
                Ok(staged) if staged.bytes == [0, 0] => {
                    let ack = ServerAckWatermark {
                        lease_epoch: self.lease.epoch,
                        peer_write_seq: update.peer_seq,
                        room_update_seq: self.last_seq,
                    };
                    let _ = peer
                        .outbound
                        .send(ack.encode(), self.lease.authority(PeerRole::Editor));
                    continue;
                }
                Ok(staged) => {
                    update.staged = (staged.bytes.as_slice() != update.original.as_slice())
                        .then_some(staged.bytes);
                }
                Err(reason) => {
                    peer.outbound.finish(
                        encode_policy_rejected(reason),
                        self.lease.authority(peer.role),
                        SessionClose::POLICY,
                    );
                    self.reset_staging(&[])?;
                    continue;
                }
            }
            let one = std::slice::from_ref(&update);
            match self.append(&self.budget(), one).await {
                Ok(seq) => self.publish(seq, one)?,
                Err(PortError::Domain(
                    DomainError::AccessDenied
                    | DomainError::SpaceReadOnly
                    | DomainError::ResourceNotFound,
                )) => {
                    if let Some(peer) = self.peers.get(&update.peer) {
                        peer.outbound.guard.close(SessionClose::POLICY);
                    }
                    self.reset_staging(&[])?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn wal_entries(&self, writes: &[PendingUpdate]) -> Result<Vec<RoomWalEntry>, PortError> {
        self.last_seq
            .checked_add(writes.len() as u64)
            .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;
        Ok(writes
            .iter()
            .enumerate()
            .map(|(index, write)| RoomWalEntry {
                update_seq: self.last_seq + index as u64 + 1,
                update_bytes: write.staged_bytes().to_vec(),
                auth: write.auth.clone(),
            })
            .collect())
    }

    fn publish(&mut self, seq: u64, writes: &[PendingUpdate]) -> Result<(), PortError> {
        if self.last_seq.checked_add(writes.len() as u64) != Some(seq) {
            return Err(operation_error(
                b"collab_wal_watermark",
                CommitEffect::Unknown,
            ));
        }
        let mut chunks: Vec<Arc<Vec<u8>>> = Vec::new();
        let mut current = Vec::new();
        let mut acknowledgments: HashMap<u64, Vec<u8>> = HashMap::new();
        for (index, write) in writes.iter().enumerate() {
            let staged_bytes = write.staged_bytes();
            self.twin.publish(staged_bytes).map_err(invalid_state)?;
            let encoded_len = staged_bytes.len().saturating_add(12);
            if !current.is_empty() && current.len().saturating_add(encoded_len) > MAX_FRAME_BYTES {
                chunks.push(Arc::new(std::mem::take(&mut current)));
            }
            encode_update_into(&mut current, staged_bytes);
            let ack = ServerAckWatermark {
                lease_epoch: self.lease.epoch,
                peer_write_seq: write.peer_seq,
                room_update_seq: self.last_seq + index as u64 + 1,
            };
            acknowledgments
                .entry(write.peer)
                .or_default()
                .extend(ack.encode());
            self.carrier.last_writer_auth = Some(write.auth.clone());
            self.carrier.last_writer_peer = Some(write.peer);
        }
        if !current.is_empty() {
            chunks.push(Arc::new(current));
        }
        self.last_seq = seq;
        self.updates_since_checkpoint += writes.len() as u64;
        self.mark_dirty();

        for (&peer_id, peer) in &self.peers {
            if let Some(ack_bytes) = acknowledgments.get(&peer_id) {
                // Combine the author's Update and ServerAckWatermark into a
                // single compound binary frame when it fits within MAX_FRAME_BYTES,
                // halving author outbound frames and per-frame authorization checks.
                if chunks.len() == 1
                    && chunks[0].len().saturating_add(ack_bytes.len()) <= MAX_FRAME_BYTES
                {
                    let mut combined = Vec::with_capacity(chunks[0].len() + ack_bytes.len());
                    combined.extend_from_slice(&chunks[0]);
                    combined.extend_from_slice(ack_bytes);
                    let _ = peer
                        .outbound
                        .send(combined, self.lease.authority(peer.role));
                    continue;
                }
                let mut ok = true;
                for chunk in &chunks {
                    if peer
                        .outbound
                        .send(Arc::clone(chunk), self.lease.authority(peer.role))
                        .is_err()
                    {
                        ok = false;
                        break;
                    }
                }
                if ok {
                    let _ = peer
                        .outbound
                        .send(ack_bytes.clone(), self.lease.authority(PeerRole::Editor));
                }
            } else {
                for chunk in &chunks {
                    if peer
                        .outbound
                        .send(Arc::clone(chunk), self.lease.authority(peer.role))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    fn broadcast(&self, data: Vec<u8>) {
        let data = Arc::new(data);
        for peer in self.peers.values() {
            let _ = peer
                .outbound
                .send(data.clone(), self.lease.authority(peer.role));
        }
    }

    fn broadcast_except(&self, exclude_peer: u64, data: Vec<u8>) {
        let data = Arc::new(data);
        for (&peer_id, peer) in &self.peers {
            if peer_id == exclude_peer {
                continue;
            }
            let _ = peer
                .outbound
                .send(data.clone(), self.lease.authority(peer.role));
        }
    }
}

struct StopRoom {
    settled: bool,
    hub: Weak<HubInner>,
    handle: RoomHandle,
}

impl Drop for StopRoom {
    fn drop(&mut self) {
        self.handle.settled.store(self.settled, Ordering::Release);
        if let Some(hub) = self.hub.upgrade() {
            hub.room_stopped(&self.handle, self.settled);
        }
        self.handle.stopped.cancel();
    }
}

fn scope_has_changed(error: &PortError) -> bool {
    matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
        if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch)
}

async fn wait_for(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        sleep_until(deadline).await;
    } else {
        pending().await
    }
}

#[cfg(test)]
mod tests {
    use notarium_core::ids::{HistoryIncarnation, SpaceId};

    use super::*;

    fn test_handle() -> RoomHandle {
        let (commands, _rx) = mpsc::channel(1);
        let (_slug_tx, slug) = watch::channel(String::new());
        RoomHandle {
            lease: Arc::new(RoomLease {
                scope: HistoryScope {
                    space_id: SpaceId::from_bytes([1; 16]),
                    incarnation: HistoryIncarnation::from_bytes([2; 16]),
                },
                note: NoteId::from_bytes([3; 16]),
                epoch: LeaseEpoch::new(1).unwrap(),
                lineage: LineageEpoch::new(1).unwrap(),
                owner: Arc::from("owner"),
            }),
            commands,
            stopped: Cancellation::default(),
            settled: Arc::new(AtomicBool::new(false)),
            slug,
            peers_changed: Arc::new(Notify::new()),
            storage_changed: Arc::new(Notify::new()),
            last_self_seq: Arc::new(AtomicU64::new(0)),
            pending_note_seq: Arc::new(AtomicU64::new(0)),
            pending_broad_change: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn note_solo_committed_never_masks_earlier_external_commit() {
        // Case 1: external seq=11 arrives, then self-commit seq=12 arrives BEFORE
        // `last_self_seq` is stored -> escalated to broad change -> revalidate runs.
        let handle = test_handle();
        handle.note_solo_committed(11);
        handle.note_solo_committed(12);
        handle.last_self_seq.store(12, Ordering::Release);
        assert!(handle.take_needs_revalidate());
        assert!(!handle.take_needs_revalidate());

        // Case 2: self-commit seq=12 stored first, then external seq=11 arrives late ->
        // `pending_seq (11) != self_seq (12)` -> revalidate runs and clears pending_note_seq.
        let handle = test_handle();
        handle.last_self_seq.store(12, Ordering::Release);
        handle.note_solo_committed(12);
        handle.note_solo_committed(11);
        assert!(handle.take_needs_revalidate());
        assert!(!handle.take_needs_revalidate());

        // Case 3: external seq=11 arrives, then self-commit seq=12 stored before signal ->
        // self signal returns early, pending_seq (11) != self_seq (12) -> revalidate runs.
        let handle = test_handle();
        handle.note_solo_committed(11);
        handle.last_self_seq.store(12, Ordering::Release);
        handle.note_solo_committed(12);
        assert!(handle.take_needs_revalidate());
        assert!(!handle.take_needs_revalidate());

        // Case 4: uncontended self-commit seq=12 arrives before store -> skipped.
        let handle = test_handle();
        handle.note_solo_committed(12);
        handle.last_self_seq.store(12, Ordering::Release);
        assert!(!handle.take_needs_revalidate());
    }
}
