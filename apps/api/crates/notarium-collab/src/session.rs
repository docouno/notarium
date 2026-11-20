//! Transport boundary for admitted collaboration peers.

use std::{
    fmt,
    future::pending,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};

use notarium_canonical::CanonicalStore;
use notarium_core::{
    auth::ResourceFacts,
    classes::DocClass,
    ids::{LeaseEpoch, LineageEpoch, NoteId},
    model::HistoryScope,
    ports::{CallBudget, Cancellation, RevocationLease, SpaceContext},
};
use tokio::{
    sync::mpsc,
    time::{Instant, sleep_until, timeout},
};

use crate::{
    hub::HubInner,
    wire::{MAX_FRAME_BYTES, PeerRole},
};

const QUEUE_CAPACITY: usize = 8;
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(5);

/// A registration issued by the authentication owner for this peer's context.
///
/// The owner registers under its authority locks and hands this value to the
/// transport after commit. Its cancellation and expiry belong to that same
/// registration and continue to apply while the peer waits for its first frame.
pub struct CollabSessionAuth {
    lease: Box<dyn RevocationLease>,
    cancellation: Cancellation,
    expires_at: Option<Instant>,
}

impl CollabSessionAuth {
    pub fn new(
        lease: Box<dyn RevocationLease>,
        cancellation: Cancellation,
        expires_at: Option<Instant>,
    ) -> Self {
        Self {
            lease,
            cancellation,
            expires_at,
        }
    }
}

/// A transport-independent close code and safe reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionClose {
    pub code: u16,
    pub reason: &'static str,
}

impl SessionClose {
    pub const POLICY: Self = Self {
        code: 1008,
        reason: "collaboration policy",
    };

    pub const GOING_AWAY: Self = Self {
        code: 1001,
        reason: "server shutting down",
    };

    const OVERSIZE: Self = Self {
        code: 1009,
        reason: "frame too large",
    };

    pub(crate) const DISCONNECTED: Self = Self {
        code: 1000,
        reason: "peer disconnected",
    };

    const SLOW_CONSUMER: Self = Self {
        code: 1013,
        reason: "peer is not receiving frames",
    };

    pub(crate) const ROOM_CAPACITY: Self = Self {
        code: 1013,
        reason: "collaboration capacity exceeded",
    };

    pub(crate) const UNAVAILABLE: Self = Self {
        code: 1011,
        reason: "collaboration unavailable",
    };
}

/// The peer can no longer send input. The close event carries the reason.
#[derive(thiserror::Error, Clone, Copy, Debug, Eq, PartialEq)]
#[error("collaboration session is closed")]
pub struct SessionClosed;

#[derive(Eq, PartialEq)]
pub enum SessionEvent {
    Binary(Vec<u8>),
    Close(SessionClose),
}

impl fmt::Debug for SessionEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Binary(bytes) => f.debug_struct("Binary").field("len", &bytes.len()).finish(),
            Self::Close(close) => f.debug_tuple("Close").field(close).finish(),
        }
    }
}

/// Inbound write half of a split collaboration session.
pub struct CollabPeerSender {
    guard: Arc<PeerGuard>,
    input: mpsc::Sender<Vec<u8>>,
}

impl CollabPeerSender {
    /// Submit an inbound binary protocol frame to the bounded peer queue.
    pub async fn send(&self, frame: Vec<u8>) -> Result<(), SessionClosed> {
        {
            let state = self.guard.open_input()?;
            if frame.len() > MAX_FRAME_BYTES {
                self.guard.close_locked(state, SessionClose::OVERSIZE);
                return Err(SessionClosed);
            }
        }
        let permit = tokio::select! {
            biased;
            () = self.guard.input_stopped.cancelled() => return Err(SessionClosed),
            permit = self.input.reserve() => permit.map_err(|_| SessionClosed)?,
        };
        let _state = self.guard.open_input()?;
        permit.send(frame);
        Ok(())
    }
}

struct VerifiedSqliteGen {
    commit_gen: u64,
    lease: LeaseEpoch,
    lineage: LineageEpoch,
    role: PeerRole,
    owner: Arc<str>,
}

/// Outbound authorized read half of a split collaboration session.
pub struct CollabPeerReceiver {
    store: CanonicalStore,
    context: SpaceContext,
    note: NoteId,
    guard: Arc<PeerGuard>,
    output: mpsc::Receiver<Outgoing>,
    pending: Option<Outgoing>,
    last_verified: Option<VerifiedSqliteGen>,
    delivered_close: bool,
}

impl CollabPeerReceiver {
    /// Receive one authorized event. Safe to call again if the waiting
    /// future is cancelled, including during its storage check.
    pub async fn recv(&mut self) -> Option<SessionEvent> {
        if self.delivered_close {
            return None;
        }
        loop {
            if let Some(ending) = self.guard.ending() {
                match ending {
                    Ending::Closed(close) => {
                        self.discard_queued_frames();
                        self.delivered_close = true;
                        return Some(SessionEvent::Close(close));
                    }
                    Ending::Drain(final_frame) => {
                        self.output.close();
                        if self.pending.is_none() {
                            self.pending = self.output.try_recv().ok();
                        }
                        let last = self.pending.is_none();
                        let authority = self
                            .pending
                            .as_ref()
                            .or(final_frame.as_ref())
                            .map(|frame| frame.authority.clone());
                        let lease_lost = self.guard.lease_lost.clone();
                        let result = match authority {
                            Some(authority) => tokio::select! {
                                biased;
                                () = lease_lost.cancelled() => continue,
                                result = self.authorize(&authority) => result,
                            },
                            None => Ok(()),
                        };
                        if self.guard.finish_delivery(result, last)
                            && let Some(frame) = self.pending.take().or(final_frame)
                        {
                            return Some(frame.into_event());
                        }
                        continue;
                    }
                }
            }

            if self.pending.is_none() {
                self.pending = tokio::select! {
                    biased;
                    () = self.guard.stopped().cancelled() => continue,
                    frame = self.output.recv() => frame,
                };
            }
            let Some(authority) = self.pending.as_ref().map(|f| f.authority.clone()) else {
                self.guard.close(SessionClose::UNAVAILABLE);
                continue;
            };
            let stopped = self.guard.stopped().clone();
            let result = tokio::select! {
                biased;
                () = stopped.cancelled() => continue,
                result = self.authorize(&authority) => result,
            };
            if let Err(close) = result {
                self.guard.close(close);
            } else if self.guard.check().is_ok() {
                return self.pending.take().map(Outgoing::into_event);
            }
        }
    }

    fn discard_queued_frames(&mut self) {
        self.pending = None;
        self.output.close();
        while self.output.try_recv().is_ok() {}
    }

    async fn authorize(&mut self, authority: &OutboundAuthority) -> Result<(), SessionClose> {
        // Linearizable zero-SQL fast path on SQLite when no canonical commit
        // has occurred since this session last verified the exact room lease.
        if let OutboundAuthority::Active {
            scope,
            role,
            lease,
            lineage,
            owner,
        } = authority
        {
            if scope != self.context.scope() {
                return Err(SessionClose::POLICY);
            }
            if let Some(current_gen) = self.store.sqlite_commit_generation()
                && self.last_verified.as_ref().is_some_and(|v| {
                    v.commit_gen == current_gen
                        && v.lease == *lease
                        && v.lineage == *lineage
                        && v.role == *role
                        && v.owner == *owner
                })
            {
                return Ok(());
            }
        }

        let gen_before = self.store.sqlite_commit_generation();
        let budget = CallBudget {
            request: self.context.budget.request.clone(),
            cancellation: Cancellation::default(),
            remaining: AUTHORIZATION_TIMEOUT,
        };
        let store = &self.store;
        let context = &self.context;
        let note = &self.note;
        let check = async {
            let (facts, role) = match authority {
                OutboundAuthority::Active {
                    scope,
                    role,
                    lease,
                    lineage,
                    owner,
                } if scope == context.scope() => (
                    store
                        .read_active_room_facts(Some(&budget), scope, note, *lease, *lineage, owner)
                        .await
                        .map(|facts| facts.resource),
                    *role,
                ),
                OutboundAuthority::Admission { scope, role } if scope == context.scope() => (
                    store
                        .read_room_resource_facts(Some(&budget), scope, note)
                        .await,
                    *role,
                ),
                _ => return Err(SessionClose::POLICY),
            };
            let facts = facts.map_err(|_| SessionClose::POLICY)?;
            if is_authorized(context, role, &facts) {
                Ok(())
            } else {
                Err(SessionClose::POLICY)
            }
        };
        let res = timeout(budget.remaining, check)
            .await
            .unwrap_or(Err(SessionClose::POLICY));
        if res.is_ok()
            && let (Some(before), Some(after)) = (gen_before, self.store.sqlite_commit_generation())
            && before == after
            && let OutboundAuthority::Active {
                role,
                lease,
                lineage,
                owner,
                ..
            } = authority
        {
            self.last_verified = Some(VerifiedSqliteGen {
                commit_gen: after,
                lease: *lease,
                lineage: *lineage,
                role: *role,
                owner: Arc::clone(owner),
            });
        } else if res.is_err() {
            self.last_verified = None;
        }
        res
    }
}

impl Drop for CollabPeerReceiver {
    fn drop(&mut self) {
        self.guard.close(SessionClose::DISCONNECTED);
    }
}

/// One independently revocable binary protocol session.
///
/// Use `recv` when the transport is ready for its next frame, or `split` into
/// independent send and receive halves for full-duplex WebSocket adapters. The
/// fresh authority check is part of `recv`, so an adapter must keep
/// backpressure at this boundary.
pub struct CollabPeerSession {
    sender: CollabPeerSender,
    receiver: CollabPeerReceiver,
}

#[derive(Clone)]
pub(crate) enum OutboundAuthority {
    Active {
        scope: HistoryScope,
        role: PeerRole,
        lease: LeaseEpoch,
        lineage: LineageEpoch,
        owner: Arc<str>,
    },
    Admission {
        scope: HistoryScope,
        role: PeerRole,
    },
}

#[derive(Clone)]
struct Outgoing {
    bytes: Arc<Vec<u8>>,
    authority: OutboundAuthority,
}

impl Outgoing {
    fn new(bytes: impl Into<Arc<Vec<u8>>>, authority: OutboundAuthority) -> Self {
        Self {
            bytes: bytes.into(),
            authority,
        }
    }

    fn into_event(self) -> SessionEvent {
        SessionEvent::Binary(Arc::unwrap_or_clone(self.bytes))
    }
}

#[derive(Clone)]
pub(crate) struct PeerOutbound {
    pub(crate) guard: Arc<PeerGuard>,
    output: mpsc::Sender<Outgoing>,
}

impl PeerOutbound {
    /// A slow peer cannot block a room actor or accumulate an unbounded queue.
    pub(crate) fn send(
        &self,
        bytes: impl Into<Arc<Vec<u8>>>,
        authority: OutboundAuthority,
    ) -> Result<(), SessionClosed> {
        self.guard.check()?;
        self.output
            .try_send(Outgoing::new(bytes, authority))
            .map_err(|err| {
                let close = match err {
                    mpsc::error::TrySendError::Full(_) => SessionClose::SLOW_CONSUMER,
                    mpsc::error::TrySendError::Closed(_) => SessionClose::DISCONNECTED,
                };
                self.guard.close(close);
                SessionClosed
            })
    }

    /// Stop room participation and deliver queued frames before the final frame.
    pub(crate) fn finish(
        &self,
        bytes: impl Into<Arc<Vec<u8>>>,
        authority: OutboundAuthority,
        close: SessionClose,
    ) {
        self.guard
            .finish(Some(Outgoing::new(bytes, authority)), close);
    }

    /// End a protocol session after delivering already queued output.
    pub(crate) fn finish_after_output(&self, close: SessionClose) {
        self.guard.finish(None, close);
    }
}

impl CollabPeerSession {
    pub(crate) fn pair(
        store: CanonicalStore,
        context: SpaceContext,
        note: NoteId,
        guard: Arc<PeerGuard>,
    ) -> (Self, PeerOutbound, mpsc::Receiver<Vec<u8>>) {
        let (input, frames) = mpsc::channel(QUEUE_CAPACITY);
        let (output, receiver) = mpsc::channel(QUEUE_CAPACITY);
        (
            Self {
                sender: CollabPeerSender {
                    guard: guard.clone(),
                    input,
                },
                receiver: CollabPeerReceiver {
                    store,
                    context,
                    note,
                    guard: guard.clone(),
                    output: receiver,
                    pending: None,
                    last_verified: None,
                    delivered_close: false,
                },
            },
            PeerOutbound { guard, output },
            frames,
        )
    }

    /// Split into independent inbound and outbound halves so full-duplex
    /// transports can send frames concurrently without cancelling `recv`.
    pub fn split(self) -> (CollabPeerSender, CollabPeerReceiver) {
        (self.sender, self.receiver)
    }

    /// Submit an inbound binary protocol frame to the bounded peer queue.
    pub async fn send(&self, frame: Vec<u8>) -> Result<(), SessionClosed> {
        self.sender.send(frame).await
    }

    /// Receive one authorized event. Safe to call again if the waiting
    /// future is cancelled, including during its storage check.
    pub async fn recv(&mut self) -> Option<SessionEvent> {
        self.receiver.recv().await
    }
}

pub(crate) fn is_authorized(context: &SpaceContext, role: PeerRole, facts: &ResourceFacts) -> bool {
    facts.space.id == context.scope().space_id
        && facts.class == DocClass::UserDoc
        && context.auth().authorize_read(facts).is_ok()
        && (role == PeerRole::Viewer || context.auth().authorize_direct_write(facts, facts).is_ok())
}

enum PeerState {
    Open(Box<dyn RevocationLease>),
    Ending {
        lease: Box<dyn RevocationLease>,
        final_frame: Option<Outgoing>,
        close: SessionClose,
    },
    Closed(SessionClose),
}

enum Ending {
    Drain(Option<Outgoing>),
    Closed(SessionClose),
}

/// The registration is kept in a synchronous, short critical section. No
/// canonical I/O or actor command runs while it is locked.
pub(crate) struct PeerGuard {
    cancellation: Cancellation,
    expires_at: Option<Instant>,
    state: Mutex<PeerState>,
    hub_peer: Mutex<Option<(Weak<HubInner>, u64)>>,
    input_stopped: Cancellation,
    stopped: Cancellation,
    lease_lost: Cancellation,
}

pub(crate) struct PeerAdmission<'a> {
    guard: &'a PeerGuard,
    _state: MutexGuard<'a, PeerState>,
}

impl PeerAdmission<'_> {
    pub(crate) fn valid_at(&self, now: Instant) -> bool {
        self.guard.signal_valid_at(now)
    }
}

impl PeerGuard {
    pub(crate) fn new(auth: CollabSessionAuth) -> Arc<Self> {
        let guard = Arc::new(Self {
            cancellation: auth.cancellation.clone(),
            expires_at: auth.expires_at,
            state: Mutex::new(PeerState::Open(auth.lease)),
            hub_peer: Mutex::new(None),
            input_stopped: Cancellation::default(),
            stopped: Cancellation::default(),
            lease_lost: Cancellation::default(),
        });
        let peer = Arc::downgrade(&guard);
        let released = guard.lease_lost.clone();
        tokio::spawn(async move {
            let expiry = async {
                match auth.expires_at {
                    Some(expiry) => sleep_until(expiry).await,
                    None => pending::<()>().await,
                }
            };
            tokio::select! {
                biased;
                () = released.cancelled() => return,
                () = auth.cancellation.cancelled() => {}
                () = expiry => {}
            }
            if let Some(guard) = peer.upgrade() {
                guard.close(SessionClose::POLICY);
            }
        });
        guard
    }

    pub(crate) fn attach_hub_registration(&self, hub: Weak<HubInner>, id: u64) {
        if self.lease_lost.is_cancelled() {
            if let Some(hub) = hub.upgrade() {
                hub.unregister_peer(id, self.cancellation.is_cancelled());
            }
            return;
        }
        *self.hub_peer.lock().unwrap_or_else(|e| e.into_inner()) = Some((hub, id));
        if self.lease_lost.is_cancelled() {
            self.unregister_hub_peer();
        }
    }

    fn unregister_hub_peer(&self) {
        let entry = self
            .hub_peer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some((hub, id)) = entry
            && let Some(hub) = hub.upgrade()
        {
            hub.unregister_peer(id, self.cancellation.is_cancelled());
        }
    }

    pub(crate) fn check(&self) -> Result<(), SessionClosed> {
        self.open().map(drop)
    }

    pub(crate) fn hold_admission(&self) -> Result<PeerAdmission<'_>, SessionClosed> {
        self.open().map(|state| PeerAdmission {
            guard: self,
            _state: state,
        })
    }

    fn open(&self) -> Result<MutexGuard<'_, PeerState>, SessionClosed> {
        let state = self.state();
        let PeerState::Open(lease) = &*state else {
            return Err(SessionClosed);
        };
        if self.credentials_valid(lease.as_ref()) {
            return Ok(state);
        }
        self.close_locked(state, SessionClose::POLICY);
        Err(SessionClosed)
    }

    pub(crate) fn stopped(&self) -> &Cancellation {
        &self.stopped
    }

    pub(crate) fn stop_input(&self) {
        // Serialize the cutoff with transport enqueue and the oversize close.
        let _state = self.state();
        self.input_stopped.cancel();
    }

    fn open_input(&self) -> Result<MutexGuard<'_, PeerState>, SessionClosed> {
        let state = self.open()?;
        if self.input_stopped.is_cancelled() {
            return Err(SessionClosed);
        }
        Ok(state)
    }

    pub(crate) fn policy_closed(&self) -> bool {
        matches!(&*self.state(), PeerState::Closed(close) | PeerState::Ending { close, .. }
            if close.code == SessionClose::POLICY.code)
    }

    pub(crate) fn close(&self, close: SessionClose) {
        let state = self.state();
        if let PeerState::Closed(_) = &*state {
            return;
        }
        self.close_locked(state, close);
    }

    fn finish(&self, final_frame: Option<Outgoing>, close: SessionClose) {
        let mut state = self.state();
        let PeerState::Open(lease) = &*state else {
            return;
        };
        if !self.credentials_valid(lease.as_ref()) {
            self.close_locked(state, SessionClose::POLICY);
            return;
        }
        if let PeerState::Open(lease) = std::mem::replace(&mut *state, PeerState::Closed(close)) {
            *state = PeerState::Ending {
                lease,
                final_frame,
                close,
            };
        }
        self.input_stopped.cancel();
        drop(state);
        self.stopped.cancel();
    }

    fn ending(&self) -> Option<Ending> {
        match &*self.state() {
            PeerState::Open(_) => None,
            PeerState::Ending { final_frame, .. } => Some(Ending::Drain(final_frame.clone())),
            PeerState::Closed(close) => Some(Ending::Closed(*close)),
        }
    }

    fn finish_delivery(&self, result: Result<(), SessionClose>, last: bool) -> bool {
        let state = self.state();
        let PeerState::Ending { lease, close, .. } = &*state else {
            return false;
        };
        let result = if self.credentials_valid(lease.as_ref()) {
            result
        } else {
            Err(SessionClose::POLICY)
        };
        match result {
            Err(status) => {
                self.close_locked(state, status);
                false
            }
            Ok(()) => {
                if last {
                    let status = *close;
                    self.close_locked(state, status);
                }
                true
            }
        }
    }

    fn credentials_valid(&self, lease: &dyn RevocationLease) -> bool {
        self.signal_valid_at(Instant::now()) && lease.check().is_ok()
    }

    fn signal_valid_at(&self, now: Instant) -> bool {
        !self.cancellation.is_cancelled() && self.expires_at.is_none_or(|expiry| now < expiry)
    }

    fn state(&self) -> MutexGuard<'_, PeerState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn close_locked(&self, mut state: MutexGuard<'_, PeerState>, close: SessionClose) {
        let retired = std::mem::replace(&mut *state, PeerState::Closed(close));
        // Record pending revocation settlement and remove the peer from the
        // hub BEFORE dropping `retired` (which releases `RevocationLease` and
        // unblocks Phase-1 `fence_provider`) and while `state` is still held
        // (so no reader observes `Ending::Closed` before the lease is released).
        // Lock order: `PeerGuard::state` -> `hub_peer` -> `HubInner::{peers,
        // active, pending_revoke_settlement}`.
        self.unregister_hub_peer();
        drop(retired);
        self.input_stopped.cancel();
        drop(state);
        self.lease_lost.cancel();
        self.stopped.cancel();
    }
}

impl Drop for PeerGuard {
    fn drop(&mut self) {
        self.lease_lost.cancel();
        self.unregister_hub_peer();
    }
}

#[cfg(test)]
mod tests {
    use notarium_core::{
        error::PortError,
        ids::{HistoryIncarnation, SpaceId},
    };
    use tokio::sync::oneshot;

    use super::*;

    struct ObservableLease(Option<oneshot::Sender<()>>);

    impl RevocationLease for ObservableLease {
        fn check(&self) -> Result<(), PortError> {
            Ok(())
        }
    }

    impl Drop for ObservableLease {
        fn drop(&mut self) {
            if let Some(released) = self.0.take() {
                let _ = released.send(());
            }
        }
    }

    fn registration(
        deadline: Option<Instant>,
    ) -> (Arc<PeerGuard>, Cancellation, oneshot::Receiver<()>) {
        let (released, observed) = oneshot::channel();
        let cancellation = Cancellation::default();
        let guard = PeerGuard::new(CollabSessionAuth::new(
            Box::new(ObservableLease(Some(released))),
            cancellation.clone(),
            deadline,
        ));
        (guard, cancellation, observed)
    }

    fn terminal_frame() -> Outgoing {
        Outgoing::new(
            vec![102],
            OutboundAuthority::Admission {
                scope: HistoryScope {
                    space_id: SpaceId::from_bytes([0; 16]),
                    incarnation: HistoryIncarnation::from_bytes([0; 16]),
                },
                role: PeerRole::Viewer,
            },
        )
    }

    #[tokio::test]
    async fn revocation_releases_registration_even_without_room_or_transport_progress() {
        let (guard, cancellation, released) = registration(None);
        assert!(guard.check().is_ok());
        cancellation.cancel();
        timeout(Duration::from_secs(1), released)
            .await
            .unwrap()
            .unwrap();
        assert!(guard.stopped().is_cancelled());
        assert!(matches!(
            guard.ending(),
            Some(Ending::Closed(SessionClose::POLICY))
        ));
    }

    #[tokio::test]
    async fn expiry_while_waiting_for_first_frame_stops_peer() {
        let (guard, _, released) = registration(Some(Instant::now() + Duration::from_millis(10)));
        timeout(Duration::from_secs(1), released)
            .await
            .unwrap()
            .unwrap();
        assert!(guard.check().is_err());
        assert!(matches!(
            guard.ending(),
            Some(Ending::Closed(SessionClose::POLICY))
        ));
    }

    #[tokio::test]
    async fn input_cutoff_preserves_only_the_existing_admission() {
        let (guard, _, mut released) = registration(None);
        assert!(guard.open_input().is_ok());
        guard.stop_input();
        assert!(guard.open_input().is_err());
        let registration = guard.hold_admission().unwrap();
        assert!(matches!(
            guard.state.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        assert_eq!(
            released.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        drop(registration);
        guard.finish(None, SessionClose::POLICY);
        assert!(guard.check().is_err());
        assert!(guard.finish_delivery(Ok(()), true));
        released.try_recv().unwrap();
    }

    #[tokio::test]
    async fn held_admission_detects_an_independent_cancellation() {
        let (guard, cancellation, mut released) = registration(None);
        let held = guard.hold_admission().unwrap();
        assert!(held.valid_at(Instant::now()));
        cancellation.cancel();
        assert!(!held.valid_at(Instant::now()));
        assert_eq!(
            released.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        drop(held);
        timeout(Duration::from_secs(1), released)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn revocation_suppresses_terminal_frame_even_after_its_storage_check() {
        let (guard, cancellation, mut released) = registration(None);
        guard.finish(
            Some(terminal_frame()),
            SessionClose {
                code: 4409,
                reason: "lineage mismatch",
            },
        );
        assert!(guard.stopped().is_cancelled());
        assert!(matches!(guard.ending(), Some(Ending::Drain(Some(_)))));
        assert!(guard.finish_delivery(Ok(()), false));
        assert_eq!(
            released.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );

        cancellation.cancel();
        assert!(!guard.finish_delivery(Ok(()), true));
        timeout(Duration::from_secs(1), released)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            guard.ending(),
            Some(Ending::Closed(SessionClose::POLICY))
        ));
    }

    #[tokio::test]
    async fn terminal_frame_releases_lease_before_emitting_close_code() {
        let (guard, _, mut released) = registration(None);
        let expected_close = SessionClose {
            code: 4409,
            reason: "lineage mismatch",
        };
        guard.finish(Some(terminal_frame()), expected_close);
        assert!(guard.finish_delivery(Ok(()), true));
        released.try_recv().unwrap();
        assert!(matches!(guard.ending(), Some(Ending::Closed(close)) if close == expected_close));
    }
}
