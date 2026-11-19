mod mutations;
mod persistence;

use std::{
    collections::HashMap,
    future::pending,
    sync::{Arc, Weak},
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
    hub::{CollabConfig, HubInner, RoomSlot, operation_error, unknown},
    presence::Presence,
    session::{OutboundAuthority, PeerOutbound, SessionClose, is_authorized},
    wire::{
        InboundMessage, LineageReady, PeerRole, ServerAckWatermark, decode_frame, encode_awareness,
        encode_policy_rejected, encode_sync_step1, encode_sync_step2, encode_update,
    },
};
use persistence::{PendingUpdate, PreparedRoom, invalid_state};

pub(crate) use persistence::recover_fenced;

const MAILBOX_CAPACITY: usize = 32;
const WAL_GROUP_SIZE: usize = 64;
const WAL_GROUP_BYTES: usize = 4 * 1024 * 1024;
const MAX_PEERS: usize = 128;

pub(crate) enum RoomCommand {
    Join {
        id: u64,
        ctx: Box<SpaceContext>,
        role: PeerRole,
        outbound: PeerOutbound,
        reply: oneshot::Sender<bool>,
        deadline: Instant,
    },
    Frame {
        id: u64,
        frame: Vec<u8>,
    },
    Intercept {
        request: Box<InterceptedMutation>,
        reply: oneshot::Sender<Result<InterceptionResult, PortError>>,
        deadline: Instant,
    },
    Revoked {
        close: bool,
        reply: oneshot::Sender<Result<(), PortError>>,
    },
}

#[derive(Clone)]
pub(crate) struct RoomHandle {
    lease: Arc<RoomLease>,
    commands: mpsc::Sender<RoomCommand>,
    stopped: Cancellation,
    slug: watch::Receiver<String>,
    peers_changed: Arc<Notify>,
    storage_changed: Arc<Notify>,
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

    pub fn slug(&self) -> String {
        self.slug.borrow().clone()
    }

    pub fn stopped(&self) -> &Cancellation {
        &self.stopped
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
        self.storage_changed.notify_one();
    }

    pub async fn settle_after_revoke(&self, close: bool) -> Result<(), PortError> {
        let (reply, received) = oneshot::channel();
        if self
            .send(RoomCommand::Revoked { close, reply })
            .await
            .is_err()
        {
            return Err(operation_error(
                b"collab_revocation_room_unavailable",
                CommitEffect::NotCommitted,
            ));
        }
        received.await.map_err(|_| {
            operation_error(b"collab_revocation_room_stopped", CommitEffect::Unknown)
        })?
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
    hub: std::sync::Weak<HubInner>,
    lease: Arc<RoomLease>,
    slug: watch::Sender<String>,
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
    pub fn spawn(
        hub: &Arc<HubInner>,
        slot: Arc<RoomSlot>,
        scope: HistoryScope,
        slug: String,
        record: CollabSessionRecord,
        prepared: PreparedRoom,
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
        let handle = RoomHandle {
            lease: lease.clone(),
            commands,
            stopped: Cancellation::default(),
            slug: file,
            peers_changed: Arc::new(Notify::new()),
            storage_changed: Arc::new(Notify::new()),
        };
        let dirty = record.carrier_dirty.then(Instant::now);
        let mut room = Self {
            store: hub.store.clone(),
            config: hub.config.clone(),
            hub: Arc::downgrade(hub),
            lease,
            slug,
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
            // Keep the per-note slot alive for the duration of the actor. Drop
            // it with the document and presence when the actor exits.
            let _slot = slot;
            let _stopped = StopRoom {
                hub: room.hub.clone(),
                handle: lifecycle.clone(),
            };
            let result = room.run(receiver, &lifecycle, shutdown).await;
            for peer in room.peers.values() {
                if !peer.outbound.guard.stopped().is_cancelled() {
                    peer.outbound.guard.close(SessionClose::POLICY);
                }
            }
            if let Err(error) = result {
                tracing::warn!(code = error.code(), "collaboration room stopped");
                if !scope_has_changed(&error)
                    && let Err(fence_error) = room.fence().await
                {
                    tracing::warn!(
                        code = fence_error.code(),
                        "collaboration lease fence failed"
                    );
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

    async fn run(
        &mut self,
        mut commands: mpsc::Receiver<RoomCommand>,
        handle: &RoomHandle,
        shutdown: Cancellation,
    ) -> Result<(), PortError> {
        let mut next_command = None;
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
                    () = shutdown.cancelled() => return Ok(()),
                    () = handle.storage_changed.notified() => {
                        self.revalidate().await?;
                        continue;
                    }
                    () = handle.peers_changed.notified() => {
                        if self.reap_peers() {
                            self.carrier.last_writer_auth = None;
                            self.checkpoint(&self.budget()).await?;
                        }
                        continue;
                    }
                    () = wait_for(unload_at) => {
                        self.close(&self.budget()).await?;
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
                    let accepted = self.join(id, *ctx, role, outbound, deadline).await;
                    let _ = reply.send(accepted);
                }
                RoomCommand::Frame { id, frame } => {
                    let mut batch = Vec::new();
                    self.handle_frame(id, &frame, &mut batch).await?;
                    let coalesce = Instant::now() + self.config.intercept_coalesce;
                    let mut frames = 1;
                    while frames < MAILBOX_CAPACITY && batch.len() < WAL_GROUP_SIZE {
                        let command =
                            if batch.is_empty() || self.config.intercept_coalesce.is_zero() {
                                commands.try_recv().ok()
                            } else {
                                tokio::select! {
                                    biased;
                                    () = shutdown.cancelled() => return Ok(()),
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
                                next_command = other;
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
                    let result = self.intercept_command(*request).await;
                    let poison = result.as_ref().err().is_some_and(unknown);
                    let _ = reply.send(result);
                    if poison {
                        return Err(operation_error(
                            b"collab_command_unresolved",
                            CommitEffect::Unknown,
                        ));
                    }
                }
                RoomCommand::Revoked { close, reply } => {
                    self.reap_peers();
                    self.carrier.last_writer_auth = None;
                    let result = if close {
                        for peer in self.peers.values() {
                            peer.outbound.guard.close(SessionClose::POLICY);
                        }
                        self.close(&self.budget()).await
                    } else {
                        self.checkpoint(&self.budget()).await
                    };
                    let failed = result.is_err();
                    let _ = reply.send(result);
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
    ) -> bool {
        if self.peers.len() >= MAX_PEERS || outbound.guard.check().is_err() {
            return false;
        }
        ctx.budget.remaining = deadline.saturating_duration_since(Instant::now());
        let Ok(facts) = self.refresh_metadata(&ctx.budget).await else {
            return false;
        };
        if Instant::now() >= deadline
            || !is_authorized(&ctx, role, &facts)
            || outbound.guard.check().is_err()
        {
            return false;
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
            return false;
        }
        if let Some(presence) = self.presence.snapshot()
            && outbound
                .send(encode_awareness(&presence), self.lease.authority(role))
                .is_err()
        {
            return false;
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
        true
    }

    async fn revalidate(&mut self) -> Result<(), PortError> {
        let facts = self.refresh_metadata(&self.budget()).await?;
        for peer in self.peers.values() {
            if !is_authorized(&peer.ctx, peer.role, &facts) {
                peer.outbound.guard.close(SessionClose::POLICY);
            }
        }
        if self.reap_peers() {
            self.carrier.last_writer_auth = None;
            self.checkpoint(&self.budget()).await?;
        }
        Ok(())
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
        let mut bytes: usize = batch
            .iter()
            .map(|update| update.original.len() + update.staged.len())
            .sum();
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
                    let Ok(state) = state.decode() else {
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
                    self.flush_batch(batch).await?;
                    bytes = 0;
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
                        bytes += staged.original.len() + staged.staged.len();
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
                        self.broadcast(encode_awareness(&update));
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

    async fn stage(
        &mut self,
        id: u64,
        original: &[u8],
        prefix: &mut Vec<PendingUpdate>,
    ) -> Result<Option<PendingUpdate>, PortError> {
        let Some(peer) = self.peers.get_mut(&id) else {
            return Ok(None);
        };
        if peer.role != PeerRole::Editor || peer.outbound.guard.check().is_err() {
            return Ok(None);
        }
        match self
            .twin
            .stage_peer(original, &self.carrier, &self.lease.note)
        {
            Ok(staged) => {
                if peer.outbound.guard.check().is_err() {
                    self.reset_staging(prefix)?;
                    return Ok(None);
                }
                let Some(next) = peer.write_seq.checked_add(1) else {
                    return Err(DomainError::validation(ValidationReason::SequenceOverflow).into());
                };
                peer.write_seq = next;
                Ok(Some(PendingUpdate {
                    peer: id,
                    peer_seq: next,
                    auth: peer.ctx.auth().clone(),
                    original: original.to_vec(),
                    staged: staged.bytes,
                }))
            }
            Err(reason) => {
                peer.outbound.guard.stop_input();
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
                Ok(None)
            }
        }
    }

    fn reset_staging(&mut self, prefix: &[PendingUpdate]) -> Result<(), PortError> {
        let updates: Vec<_> = prefix
            .iter()
            .map(|update| update.staged.as_slice())
            .collect();
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
                Ok(staged) => update.staged = staged.bytes,
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
                update_bytes: write.staged.clone(),
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
        let mut update_frame = Vec::new();
        let mut acknowledgments: HashMap<u64, Vec<u8>> = HashMap::new();
        for (index, write) in writes.iter().enumerate() {
            self.twin.publish(&write.staged).map_err(invalid_state)?;
            update_frame.extend(encode_update(&write.staged));
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
        }
        self.last_seq = seq;
        self.updates_since_checkpoint += writes.len() as u64;
        self.mark_dirty();
        self.broadcast(update_frame);
        for (id, frame) in acknowledgments {
            if let Some(peer) = self.peers.get(&id) {
                let _ = peer
                    .outbound
                    .send(frame, self.lease.authority(PeerRole::Editor));
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
}

struct StopRoom {
    hub: Weak<HubInner>,
    handle: RoomHandle,
}

impl Drop for StopRoom {
    fn drop(&mut self) {
        self.handle.stopped.cancel();
        if let Some(hub) = self.hub.upgrade() {
            hub.room_stopped(&self.handle);
        }
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
