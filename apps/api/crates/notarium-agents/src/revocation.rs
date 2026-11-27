//! In-process revocation authority for the exclusive local DataRoot owner.
//! All registry transitions are synchronous. Provider sockets and bounded
//! canonical effects drain while the Control writer is fenced.
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, PrincipalKind},
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::*,
    model::HistoryScope,
    ports::{
        Cancellation, CanonicalEffectRegistration, MaintenanceContext, PortFuture,
        ProviderSelection, RevocationLease, RevocationReason, RevocationSelector, ServicePurpose,
        SessionRevocationPort,
    },
    receipt::CommandIdentity,
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};

use crate::chats::{
    ChatRunOptions,
    stream::{StepStreamBuffer, StreamRedaction},
};

type Selectors = BTreeSet<RevocationSelector>;
type RegistrationId = u64;
type ThreadRedactionHold = Arc<Mutex<Vec<StreamRedaction>>>;
type ActiveRedactionsMap = BTreeMap<(HistoryScope, ChatThreadId), Vec<ThreadRedactionHold>>;
const MAX_SELECTORS: usize = 512;
const RECENT_EVENTS: usize = 4096;
const MAX_PENDING_CREDENTIALS: usize = 4096;
const PENDING_CREDENTIAL_TTL: Duration = Duration::from_secs(90 * 60);

#[derive(Clone)]
pub struct RevocationHub {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    changed: watch::Sender<()>,
}

#[derive(Default)]
struct State {
    closed: bool,
    next: RegistrationId,
    provider: BTreeMap<RegistrationId, Registered>,
    canonical_effects: BTreeMap<RegistrationId, CanonicalRegistration>,
    runs: BTreeMap<AgentRunId, Registered>,
    viewers: BTreeMap<RegistrationId, Registered>,
    fences: BTreeMap<RegistrationId, Selectors>,
    pending: BTreeMap<PendingCredentialKey, PendingCredential>,
    thread_streams: BTreeMap<(HistoryScope, ChatThreadId), Vec<Weak<StepStreamBuffer>>>,
    active_redactions: ActiveRedactionsMap,
    events: BTreeMap<RequestId, EventDelivery>,
    event_order: VecDeque<RequestId>,
}

struct Registered {
    selectors: Selectors,
    cancellation: Cancellation,
    thread: Option<(HistoryScope, ChatThreadId)>,
    run_owner: Option<(PrincipalId, bool)>,
}

struct CanonicalRegistration {
    entry: Registered,
    deadline: Instant,
    active: usize,
    revoked: bool,
}

enum EventDelivery {
    Applying {
        cancellations: Vec<Cancellation>,
        waiters: usize,
    },
    Applied,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct PendingCredentialKey {
    pub(crate) scope: HistoryScope,
    pub(crate) thread: ChatThreadId,
    pub(crate) input: PendingInputId,
}

/// Store the durable enqueue fingerprint alongside the credential. The same
/// input ID cannot be rebound to a new sender or credentials during replay.
#[derive(Clone)]
pub(crate) struct PendingCredential {
    auth: EngineAuthContext,
    options: ChatRunOptions,
    cancellation: Cancellation,
    pub(crate) handoff: Arc<tokio::sync::Mutex<()>>,
    registration: RegistrationId,
    registered_at: Instant,
    command_key: CommandKey,
    command_hash: ContentDigest,
    selectors: Selectors,
    submitters: usize,
}

impl PendingCredential {
    pub(crate) fn auth(&self) -> &EngineAuthContext {
        &self.auth
    }

    pub(crate) fn cancellation(&self) -> &Cancellation {
        &self.cancellation
    }

    pub(crate) fn options(&self) -> &ChatRunOptions {
        &self.options
    }
}

/// A failed new enqueue may remove only the entry it installed. The supervisor
/// serializes admissions for one thread and retains the credential if commit
/// status is unknown. Successful consume or dismissal removes by stable key.
pub(crate) struct PendingRegistration {
    key: PendingCredentialKey,
    id: RegistrationId,
}

impl State {
    fn ensure_open(&self) -> Result<(), PortError> {
        if self.closed {
            return Err(revocation_unavailable());
        }
        Ok(())
    }

    fn allocate(&mut self) -> Result<RegistrationId, PortError> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(revocation_unavailable)?;
        Ok(self.next)
    }

    fn fenced(&self, selectors: &Selectors) -> bool {
        self.fences
            .values()
            .any(|other| !other.is_disjoint(selectors))
    }

    fn has_active_effect(&self, selectors: &Selectors) -> bool {
        self.provider
            .values()
            .any(|call| !call.selectors.is_disjoint(selectors))
            || self
                .canonical_effects
                .values()
                .any(|effect| effect.active != 0 && !effect.entry.selectors.is_disjoint(selectors))
    }

    fn take_matching(
        &mut self,
        matches: impl Fn(&Selectors) -> bool,
        clear_pending: bool,
    ) -> Vec<Cancellation> {
        let mut cancellations = self
            .provider
            .values()
            .chain(self.runs.values())
            .chain(self.viewers.values())
            .filter(|entry| matches(&entry.selectors))
            .map(|entry| entry.cancellation.clone())
            .collect::<Vec<_>>();
        for effect in self.canonical_effects.values_mut() {
            if matches(&effect.entry.selectors) {
                effect.revoked = true;
                cancellations.push(effect.entry.cancellation.clone());
            }
        }
        if clear_pending {
            self.pending.retain(|_, entry| {
                if matches(&entry.selectors) {
                    cancellations.push(entry.cancellation.clone());
                    false
                } else {
                    true
                }
            });
        }
        cancellations
    }

    fn sweep_expired_pending(&mut self, now: Instant) -> Vec<Cancellation> {
        let mut expired = Vec::new();
        let active_threads: BTreeSet<(&HistoryScope, &ChatThreadId)> = self
            .runs
            .values()
            .filter_map(|run| run.thread.as_ref().map(|(scope, thread)| (scope, thread)))
            .collect();
        self.pending.retain(|key, entry| {
            let live_handoff = entry.handoff.try_lock().is_err();
            let active_thread = active_threads.contains(&(&key.scope, &key.thread));
            if !live_handoff
                && !active_thread
                && now.saturating_duration_since(entry.registered_at) >= PENDING_CREDENTIAL_TTL
            {
                expired.push(entry.cancellation.clone());
                false
            } else {
                true
            }
        });
        expired
    }

    fn event_targets(
        &mut self,
        event: &RequestId,
        selector: &RevocationSelector,
    ) -> Vec<Cancellation> {
        match self.events.get_mut(event) {
            Some(EventDelivery::Applying {
                cancellations,
                waiters,
            }) => {
                *waiters += 1;
                return cancellations.clone();
            }
            Some(EventDelivery::Applied) => return Vec::new(),
            None => (),
        }
        let cancellations = self.take_matching(|other| other.contains(selector), true);
        self.events.insert(
            event.clone(),
            EventDelivery::Applying {
                cancellations: cancellations.clone(),
                waiters: 1,
            },
        );
        cancellations
    }

    fn release_applying_event(&mut self, event: &RequestId) {
        let should_remove = match self.events.get_mut(event) {
            Some(EventDelivery::Applying { waiters, .. }) => {
                *waiters = waiters.saturating_sub(1);
                *waiters == 0
            }
            _ => false,
        };
        if should_remove {
            self.events.remove(event);
        }
    }

    fn apply_event(&mut self, event: RequestId) {
        let Some(entry) = self.events.get_mut(&event) else {
            return;
        };
        if matches!(entry, EventDelivery::Applied) {
            return;
        }
        *entry = EventDelivery::Applied;
        self.event_order.push_back(event);
        if self.event_order.len() > RECENT_EVENTS {
            let expired = self.event_order.pop_front().expect("bounded event history");
            self.events.remove(&expired);
        }
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn notify(&self) {
        self.changed.send_replace(());
    }
}

impl RevocationHub {
    /// A process-local authority requires the exclusive, live DataRoot owner.
    /// Serving Cloud instances require a composed shared authority adapter.
    pub fn new_local() -> Self {
        let (changed, _) = watch::channel(());
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                changed,
            }),
        }
    }

    /// Loss of local owner or shutdown is permanent for this hub generation.
    pub fn close(&self) {
        let cancellations = {
            let mut state = self.inner.lock();
            state.closed = true;
            state.take_matching(|_| true, true)
        };
        cancel_all(cancellations);
        self.inner.notify();
    }

    pub(crate) fn register_run(
        &self,
        ctx: MaintenanceContext,
        auth: &EngineAuthContext,
        selection: Option<&ProviderSelection>,
        cancellation: Cancellation,
    ) -> Result<RunRevocationLease, PortError> {
        self.register_run_with_sender(ctx, auth, selection, cancellation, None, None)
    }

    pub(crate) fn register_run_with_sender(
        &self,
        ctx: MaintenanceContext,
        auth: &EngineAuthContext,
        selection: Option<&ProviderSelection>,
        cancellation: Cancellation,
        thread: Option<(HistoryScope, ChatThreadId)>,
        sender: Option<(&PendingCredentialKey, &PendingCredential)>,
    ) -> Result<RunRevocationLease, PortError> {
        let budget = RevocationBudget::new(ctx)?;
        budget.check()?;
        let run = match auth.kind() {
            PrincipalKind::AgentRun(run) | PrincipalKind::Keeper(run) => run,
            _ => return Err(invalid(ValidationReason::InvalidAuthority)),
        };
        let primary = auth
            .pinned_write_space()
            .ok_or_else(|| invalid(ValidationReason::ScopeMismatch))?;
        let mut selectors = auth.selectors_for_revocation(auth.spaces().keys())?;
        if !auth.spaces().contains_key(primary) {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        if let Some(selection) = selection {
            selectors.extend(selection.revocation_scope.selectors(&selection.provider));
        }
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let mut state = self.inner.lock();
        state.ensure_open()?;
        // A regrant must never revive a revoked input. Validate its original
        // registration and publish the run to revocation under the same lock.
        if let Some((key, sender)) = sender
            && state
                .pending
                .get(key)
                .is_none_or(|entry| entry.registration != sender.registration)
        {
            return Err(cancelled());
        }
        if state.fenced(&selectors) || state.runs.contains_key(run) {
            return Err(revocation_unavailable());
        }
        let shared_group = matches!(auth.kind(), PrincipalKind::AgentRun(_))
            && auth.chat_audience() == Some(notarium_core::auth::ChatAudience::Shared);
        state.runs.insert(
            run.clone(),
            Registered {
                selectors,
                cancellation: cancellation.clone(),
                thread,
                run_owner: Some((auth.principal().clone(), shared_group)),
            },
        );
        Ok(RunRevocationLease {
            hub: self.clone(),
            run: run.clone(),
            cancellation,
        })
    }

    /// Close the viewer's stream when their own credential or membership is
    /// revoked, even when the run belongs to a different principal.
    pub fn register_viewer(
        &self,
        ctx: MaintenanceContext,
        auth: &EngineAuthContext,
        space: &SpaceId,
        cancellation: Cancellation,
    ) -> Result<ViewerRevocationLease, PortError> {
        RevocationBudget::new(ctx)?.check()?;
        if !matches!(
            auth.kind(),
            PrincipalKind::DirectHuman | PrincipalKind::Pat | PrincipalKind::OAuth { .. }
        ) {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let selectors = auth.selectors_for_revocation([space])?;
        let mut state = self.inner.lock();
        state.ensure_open()?;
        if state.fenced(&selectors) {
            return Err(revocation_unavailable());
        }
        let id = state.allocate()?;
        state.viewers.insert(
            id,
            Registered {
                selectors,
                cancellation: cancellation.clone(),
                thread: None,
                run_owner: None,
            },
        );
        Ok(ViewerRevocationLease {
            hub: self.clone(),
            id,
            cancellation,
        })
    }

    /// A run chooses a provider after the durable claim. Track that selection
    /// before dispatch and revalidate it in Control after adjoining selectors.
    pub(crate) fn bind_run_provider(
        &self,
        lease: &RunRevocationLease,
        selection: &ProviderSelection,
    ) -> Result<(), PortError> {
        if !Arc::ptr_eq(&self.inner, &lease.hub.inner) {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        lease.check()?;
        let selectors = selection.revocation_scope.selectors(&selection.provider);
        let mut state = self.inner.lock();
        state.ensure_open()?;
        if state.fenced(&selectors) {
            return Err(revocation_unavailable());
        }
        let entry = state
            .runs
            .get_mut(&lease.run)
            .ok_or_else(revocation_unavailable)?;
        entry.selectors.extend(selectors);
        Ok(())
    }

    pub(crate) fn register_pending(
        &self,
        ctx: MaintenanceContext,
        key: PendingCredentialKey,
        auth: EngineAuthContext,
        identity: &CommandIdentity,
        options: ChatRunOptions,
    ) -> Result<PendingRegistration, PortError> {
        let budget = RevocationBudget::new(ctx)?;
        budget.check()?;
        key.scope.check(&identity.scope)?;
        if auth.principal() != &identity.actor {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        if !matches!(
            auth.kind(),
            PrincipalKind::DirectHuman | PrincipalKind::Pat | PrincipalKind::OAuth { .. }
        ) {
            return Err(invalid(ValidationReason::InvalidAuthority));
        }
        let selectors = auth.selectors_for_revocation(std::iter::once(&key.scope.space_id))?;
        let now = Instant::now();
        let (expired, result) = {
            let mut state = self.inner.lock();
            state.ensure_open()?;
            let expired = state.sweep_expired_pending(now);
            let outcome = if state.fenced(&selectors) {
                Err(revocation_unavailable())
            } else if let Some(existing) = state.pending.get_mut(&key) {
                if existing.command_key != identity.key
                    || existing.command_hash != identity.hash
                    || existing.options != options
                    || existing.auth.principal() != auth.principal()
                    || existing.auth.grant() != auth.grant()
                    || existing.auth.credential() != auth.credential()
                {
                    Err(DomainError::IdempotencyKeyReused.into())
                } else {
                    existing.submitters = existing.submitters.saturating_add(1);
                    Ok(PendingRegistration {
                        key,
                        id: existing.registration,
                    })
                }
            } else if state.pending.len() >= MAX_PENDING_CREDENTIALS {
                Err(invalid(ValidationReason::BudgetExceeded))
            } else {
                let registration = state.allocate()?;
                state.pending.insert(
                    key.clone(),
                    PendingCredential {
                        auth,
                        options,
                        selectors,
                        command_key: identity.key.clone(),
                        command_hash: identity.hash,
                        registration,
                        registered_at: now,
                        cancellation: Cancellation::default(),
                        handoff: Arc::default(),
                        submitters: 1,
                    },
                );
                Ok(PendingRegistration {
                    key,
                    id: registration,
                })
            };
            (expired, outcome)
        };
        cancel_all(expired);
        result
    }

    pub(crate) fn pending(&self, key: &PendingCredentialKey) -> Option<PendingCredential> {
        self.inner.lock().pending.get(key).cloned()
    }

    pub fn has_pending(
        &self,
        scope: &HistoryScope,
        thread: &ChatThreadId,
        input: &PendingInputId,
    ) -> bool {
        self.inner
            .lock()
            .pending
            .contains_key(&PendingCredentialKey {
                scope: scope.clone(),
                thread: thread.clone(),
                input: input.clone(),
            })
    }

    pub(crate) fn finish_pending(&self, key: &PendingCredentialKey) {
        self.remove_pending_when(key, |_| true);
    }

    pub(crate) fn pending_submission(
        &self,
        key: &PendingCredentialKey,
        identity: &CommandIdentity,
        auth: &EngineAuthContext,
    ) -> Option<PendingCredential> {
        self.pending(key).filter(|entry| {
            key.scope == identity.scope
                && entry.auth.principal() == &identity.actor
                && entry.command_key == identity.key
                && entry.command_hash == identity.hash
                && entry.auth.credential() == auth.credential()
                && entry.auth.grant() == auth.grant()
        })
    }

    /// Recheck the registration after acquiring its handoff lock. Concurrent
    /// receipt readers and revocation can settle it while the caller waits.
    pub(crate) fn submission_live(
        &self,
        key: &PendingCredentialKey,
        selected: &PendingCredential,
    ) -> Result<bool, PortError> {
        let state = self.inner.lock();
        if !state
            .pending
            .get(key)
            .is_some_and(|entry| entry.registration == selected.registration)
        {
            return Ok(false);
        }
        state.ensure_open()?;
        if state.fenced(&selected.selectors) {
            return Err(revocation_unavailable());
        }
        Ok(true)
    }

    pub(crate) fn finish_submission(
        &self,
        key: &PendingCredentialKey,
        selected: &PendingCredential,
    ) {
        self.remove_pending_when(key, |entry| entry.registration == selected.registration);
    }

    pub(crate) fn finish_registered_pending(&self, registration: PendingRegistration) {
        self.rollback_pending(registration);
    }

    fn remove_pending_when(
        &self,
        key: &PendingCredentialKey,
        matches: impl FnOnce(&PendingCredential) -> bool,
    ) {
        let removed = {
            let mut state = self.inner.lock();
            if state.pending.get(key).is_some_and(matches) {
                state.pending.remove(key)
            } else {
                None
            }
        };
        if let Some(entry) = removed {
            entry.cancellation.cancel();
        }
    }

    pub(crate) fn rollback_pending(&self, registration: PendingRegistration) {
        let removed = {
            let mut state = self.inner.lock();
            if let Some(entry) = state.pending.get_mut(&registration.key)
                && entry.registration == registration.id
            {
                entry.submitters = entry.submitters.saturating_sub(1);
                if entry.submitters == 0 {
                    state.pending.remove(&registration.key)
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(entry) = removed {
            entry.cancellation.cancel();
        }
    }

    pub(crate) fn register_thread_stream(
        &self,
        scope: HistoryScope,
        thread: ChatThreadId,
        stream: Weak<StepStreamBuffer>,
    ) {
        let mut state = self.inner.lock();
        let prune_threshold = state.runs.len().saturating_mul(2).max(16);
        if state.thread_streams.len() > prune_threshold {
            state.thread_streams.retain(|_, entries| {
                entries.retain(|existing| existing.strong_count() > 0);
                !entries.is_empty()
            });
        }
        let key = (scope, thread);
        if let Some(active_list) = state.active_redactions.get(&key)
            && let Some(strong) = stream.upgrade()
        {
            for active in active_list {
                let mut holds = active.lock().unwrap_or_else(|error| error.into_inner());
                holds.push(strong.pause_for_redaction());
            }
        }
        let entry = state.thread_streams.entry(key).or_default();
        entry.retain(|existing| existing.strong_count() > 0);
        entry.push(stream);
    }

    pub(crate) fn pause_thread_streams(
        &self,
        scope: &HistoryScope,
        thread: &ChatThreadId,
    ) -> ThreadRedactionGuard {
        let key = (scope.clone(), thread.clone());
        let active = {
            let mut state = self.inner.lock();
            let mut holds = Vec::new();
            if let Some(entries) = state.thread_streams.get_mut(&key) {
                entries.retain(|weak| {
                    if let Some(stream) = weak.upgrade() {
                        holds.push(stream.pause_for_redaction());
                        true
                    } else {
                        false
                    }
                });
                if entries.is_empty() {
                    state.thread_streams.remove(&key);
                }
            }
            let active = Arc::new(Mutex::new(holds));
            state
                .active_redactions
                .entry(key.clone())
                .or_default()
                .push(Arc::clone(&active));
            active
        };
        ThreadRedactionGuard {
            hub: self.clone(),
            key,
            active,
            discard: true,
        }
    }

    pub(crate) fn cancel_thread_runs(&self, scope: &HistoryScope, thread: &ChatThreadId) {
        let cancellations: Vec<Cancellation> = {
            let state = self.inner.lock();
            state
                .runs
                .values()
                .filter(|entry| {
                    entry
                        .thread
                        .as_ref()
                        .is_some_and(|(s, t)| s == scope && t == thread)
                })
                .map(|entry| entry.cancellation.clone())
                .collect()
        };
        cancel_all(cancellations);
    }

    /// Fence, cancel, and wait for any local in-flight chat or Keeper run
    /// matching `(space, run)` that `caller` is authorized to stop (either a
    /// Shared-Space group run or the run's own principal) to drop its run lease,
    /// provider calls, and canonical effects before executing a rollback.
    pub(crate) async fn stop_and_drain_run(
        &self,
        space: &SpaceId,
        run: &AgentRunId,
        caller: &PrincipalId,
        budget: &notarium_core::ports::CallBudget,
    ) -> Result<Option<RollbackRunGuard>, PortError> {
        if budget.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        if budget.remaining.is_zero() {
            return Err(deadline_exceeded());
        }
        let deadline = Instant::now()
            .checked_add(budget.remaining)
            .ok_or_else(deadline_exceeded)?;
        let selector = RevocationSelector::AgentRun {
            space: space.clone(),
            run: run.clone(),
        };
        let (guard, cancellations) = {
            let mut state = self.inner.lock();
            state.ensure_open()?;
            if let Some(entry) = state.runs.get(run)
                && entry.selectors.contains(&selector)
                && let Some((owner, shared_group)) = &entry.run_owner
                && !*shared_group
                && owner != caller
            {
                return Ok(None);
            }
            let fence_id = state.allocate()?;
            state
                .fences
                .insert(fence_id, Selectors::from([selector.clone()]));
            let mut to_cancel = Vec::new();
            if let Some(entry) = state.runs.get(run)
                && entry.selectors.contains(&selector)
            {
                to_cancel.push(entry.cancellation.clone());
            }
            for call in state.provider.values() {
                if call.selectors.contains(&selector) {
                    to_cancel.push(call.cancellation.clone());
                }
            }
            for effect in state.canonical_effects.values_mut() {
                if effect.entry.selectors.contains(&selector) {
                    effect.revoked = true;
                    to_cancel.push(effect.entry.cancellation.clone());
                }
            }
            (
                RollbackRunGuard {
                    hub: self.clone(),
                    fence_id,
                },
                to_cancel,
            )
        };
        cancel_all(cancellations);
        let mut updates = self.inner.changed.subscribe();
        loop {
            let drained = {
                let state = self.inner.lock();
                state.ensure_open()?;
                let run_active = state
                    .runs
                    .get(run)
                    .is_some_and(|entry| entry.selectors.contains(&selector));
                let provider_active = state
                    .provider
                    .values()
                    .any(|call| call.selectors.contains(&selector));
                let effect_active = state
                    .canonical_effects
                    .values()
                    .any(|effect| effect.active != 0 && effect.entry.selectors.contains(&selector));
                !run_active && !provider_active && !effect_active
            };
            if drained {
                return Ok(Some(guard));
            }
            if budget.cancellation.is_cancelled() {
                return Err(cancelled());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(PortError::DeadlineExceeded(
                    OperationalFailure::new(
                        ContentDigest::from_bytes(
                            *blake3::hash(b"rollback run drain deadline").as_bytes(),
                        ),
                        CommitEffect::NotCommitted,
                        RetryAdvice::RetrySameCommand,
                        true,
                    )
                    .expect("valid deadline failure"),
                ));
            }
            tokio::select! {
                biased;
                () = budget.cancellation.cancelled() => return Err(cancelled()),
                () = tokio::time::sleep(remaining) => {
                    return Err(PortError::DeadlineExceeded(
                        OperationalFailure::new(
                            ContentDigest::from_bytes(*blake3::hash(b"rollback run drain deadline").as_bytes()),
                            CommitEffect::NotCommitted,
                            RetryAdvice::RetrySameCommand,
                            true,
                        )
                        .expect("valid deadline failure"),
                    ));
                }
                changed = updates.changed() => {
                    if changed.is_err() {
                        return Err(revocation_unavailable());
                    }
                }
            }
        }
    }
}

pub(crate) struct ThreadRedactionGuard {
    hub: RevocationHub,
    key: (HistoryScope, ChatThreadId),
    active: Arc<Mutex<Vec<StreamRedaction>>>,
    discard: bool,
}

impl ThreadRedactionGuard {
    pub(crate) fn keep_history(&mut self) {
        self.discard = false;
    }
}

impl Drop for ThreadRedactionGuard {
    fn drop(&mut self) {
        {
            let mut state = self.hub.inner.lock();
            if let Some(entries) = state.active_redactions.get_mut(&self.key) {
                entries.retain(|entry| !Arc::ptr_eq(entry, &self.active));
                if entries.is_empty() {
                    state.active_redactions.remove(&self.key);
                }
            }
        }
        let mut holds = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !self.discard {
            for hold in holds.iter_mut() {
                hold.keep_history();
            }
        }
        holds.clear();
    }
}

pub(crate) struct RollbackRunGuard {
    hub: RevocationHub,
    fence_id: RegistrationId,
}

impl Drop for RollbackRunGuard {
    fn drop(&mut self) {
        self.hub.inner.lock().fences.remove(&self.fence_id);
        self.hub.inner.notify();
    }
}

pub(crate) struct RunRevocationLease {
    hub: RevocationHub,
    run: AgentRunId,
    cancellation: Cancellation,
}

#[cfg(test)]
impl RunRevocationLease {
    pub(crate) fn cancellation(&self) -> &Cancellation {
        &self.cancellation
    }
}

impl RevocationLease for RunRevocationLease {
    fn check(&self) -> Result<(), PortError> {
        self.hub.inner.lock().ensure_open()?;
        if self.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        Ok(())
    }
}

impl Drop for RunRevocationLease {
    fn drop(&mut self) {
        {
            let mut state = self.hub.inner.lock();
            if let Some(removed) = state.runs.remove(&self.run)
                && let Some(key) = removed.thread
                && let Some(entries) = state.thread_streams.get_mut(&key)
            {
                entries.retain(|weak| weak.strong_count() > 0);
                if entries.is_empty() {
                    state.thread_streams.remove(&key);
                }
            }
        }
        self.cancellation.cancel();
        self.hub.inner.notify();
    }
}

pub struct ViewerRevocationLease {
    hub: RevocationHub,
    id: RegistrationId,
    cancellation: Cancellation,
}

impl RevocationLease for ViewerRevocationLease {
    fn check(&self) -> Result<(), PortError> {
        self.hub.inner.lock().ensure_open()?;
        if self.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        Ok(())
    }
}

impl Drop for ViewerRevocationLease {
    fn drop(&mut self) {
        self.hub.inner.lock().viewers.remove(&self.id);
    }
}

enum RegistryLeaseKind {
    Provider(Cancellation),
    Fence,
}

struct RegistryLease {
    hub: RevocationHub,
    id: RegistrationId,
    kind: RegistryLeaseKind,
}

impl RevocationLease for RegistryLease {
    fn check(&self) -> Result<(), PortError> {
        self.hub.inner.lock().ensure_open()?;
        if let RegistryLeaseKind::Provider(cancellation) = &self.kind
            && cancellation.is_cancelled()
        {
            return Err(cancelled());
        }
        Ok(())
    }
}

impl Drop for RegistryLease {
    fn drop(&mut self) {
        {
            let mut state = self.hub.inner.lock();
            match self.kind {
                RegistryLeaseKind::Provider(_) => {
                    state.provider.remove(&self.id);
                }
                RegistryLeaseKind::Fence => {
                    state.fences.remove(&self.id);
                }
            }
        }
        self.hub.inner.notify();
    }
}

struct EffectRegistration {
    hub: RevocationHub,
    id: RegistrationId,
    caller_cancellation: Cancellation,
    cancellation: Cancellation,
}

impl EffectRegistration {
    fn check_state(&self, state: &State) -> Result<(), PortError> {
        state.ensure_open()?;
        if self.caller_cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let entry = state
            .canonical_effects
            .get(&self.id)
            .ok_or_else(revocation_unavailable)?;
        if Instant::now() >= entry.deadline {
            return Err(deadline_exceeded());
        }
        if entry.revoked || self.cancellation.is_cancelled() || state.fenced(&entry.entry.selectors)
        {
            return Err(cancelled());
        }
        Ok(())
    }
}

impl Drop for EffectRegistration {
    fn drop(&mut self) {
        self.hub.inner.lock().canonical_effects.remove(&self.id);
    }
}

impl CanonicalEffectRegistration for EffectRegistration {
    fn restrict_until(&self, deadline: std::time::Instant) -> Result<(), PortError> {
        let mut state = self.hub.inner.lock();
        let entry = state
            .canonical_effects
            .get_mut(&self.id)
            .ok_or_else(revocation_unavailable)?;
        entry.deadline = entry.deadline.min(Instant::from_std(deadline));
        self.check_state(&state)
    }

    fn check(&self) -> Result<(), PortError> {
        self.check_state(&self.hub.inner.lock())
    }

    fn begin(self: Arc<Self>) -> PortFuture<'static, Box<dyn RevocationLease>> {
        Box::pin(async move {
            let mut state = self.hub.inner.lock();
            self.check_state(&state)?;
            let registration = state
                .canonical_effects
                .get_mut(&self.id)
                .ok_or_else(revocation_unavailable)?;
            registration.active = registration
                .active
                .checked_add(1)
                .ok_or_else(revocation_unavailable)?;
            drop(state);
            Ok(Box::new(ActiveCanonicalEffect(self)) as Box<dyn RevocationLease>)
        })
    }
}

struct ActiveCanonicalEffect(Arc<EffectRegistration>);

impl RevocationLease for ActiveCanonicalEffect {
    fn check(&self) -> Result<(), PortError> {
        self.0.check_state(&self.0.hub.inner.lock())
    }
}

impl Drop for ActiveCanonicalEffect {
    fn drop(&mut self) {
        let inner = &self.0.hub.inner;
        if let Some(entry) = inner.lock().canonical_effects.get_mut(&self.0.id) {
            entry.active -= 1;
        }
        inner.notify();
    }
}

impl SessionRevocationPort for RevocationHub {
    fn register_canonical_effect(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Arc<dyn CanonicalEffectRegistration>> {
        Box::pin(async move {
            let budget = RevocationBudget::new(ctx)?;
            let selectors = checked_selectors(selectors)?;
            let mut changes = self.inner.changed.subscribe();
            loop {
                budget.check()?;
                if cancellation.is_cancelled() {
                    return Err(cancelled());
                }
                {
                    let mut state = self.inner.lock();
                    state.ensure_open()?;
                    if !state.fenced(&selectors) {
                        let id = state.allocate()?;
                        state.canonical_effects.insert(
                            id,
                            CanonicalRegistration {
                                entry: Registered {
                                    selectors,
                                    cancellation: cancellation.clone(),
                                    thread: None,
                                    run_owner: None,
                                },
                                deadline: budget.deadline,
                                active: 0,
                                revoked: false,
                            },
                        );
                        let owner = EffectRegistration {
                            hub: self.clone(),
                            id,
                            caller_cancellation: budget.cancellation,
                            cancellation,
                        };
                        return Ok(Arc::new(owner) as Arc<dyn CanonicalEffectRegistration>);
                    }
                }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(cancelled()),
                    result = budget.changed(&mut changes) => result?,
                }
            }
        })
    }

    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async move {
            let budget = RevocationBudget::new(ctx)?;
            let selectors = checked_selectors(selectors)?;
            let mut changes = self.inner.changed.subscribe();
            loop {
                budget.check()?;
                if cancellation.is_cancelled() {
                    return Err(cancelled());
                }
                {
                    let mut state = self.inner.lock();
                    state.ensure_open()?;
                    if !state.fenced(&selectors) {
                        let id = state.allocate()?;
                        state.provider.insert(
                            id,
                            Registered {
                                selectors,
                                cancellation: cancellation.clone(),
                                thread: None,
                                run_owner: None,
                            },
                        );
                        return Ok(Box::new(RegistryLease {
                            hub: self.clone(),
                            id,
                            kind: RegistryLeaseKind::Provider(cancellation),
                        }) as Box<dyn RevocationLease>);
                    }
                }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(cancelled()),
                    result = budget.changed(&mut changes) => result?,
                }
            }
        })
    }

    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async move {
            let budget = RevocationBudget::new(ctx)?;
            budget.check()?;
            let selectors = checked_selectors(selectors)?;
            let mut changes = self.inner.changed.subscribe();
            let (fence, cancellations) = {
                let mut state = self.inner.lock();
                state.ensure_open()?;
                let id = state.allocate()?;
                state.fences.insert(id, selectors.clone());
                let cancellations =
                    state.take_matching(|other| !other.is_disjoint(&selectors), false);
                let fence = RegistryLease {
                    hub: self.clone(),
                    id,
                    kind: RegistryLeaseKind::Fence,
                };
                (fence, cancellations)
            };
            cancel_all(cancellations);
            loop {
                budget.check()?;
                {
                    let state = self.inner.lock();
                    state.ensure_open()?;
                    if !state.has_active_effect(&selectors) {
                        return Ok(Box::new(fence) as Box<dyn RevocationLease>);
                    }
                }
                budget.changed(&mut changes).await?;
            }
        })
    }

    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async move {
            RevocationBudget::new(ctx)?.check()?;
            let selectors = Selectors::from([RevocationSelector::ProviderCall(call)]);
            let mut state = self.inner.lock();
            state.ensure_open()?;
            if state.fenced(&selectors) || state.has_active_effect(&selectors) {
                return Ok(None);
            }
            let id = state.allocate()?;
            state.fences.insert(id, selectors);
            Ok(Some(Box::new(RegistryLease {
                hub: self.clone(),
                id,
                kind: RegistryLeaseKind::Fence,
            }) as Box<dyn RevocationLease>))
        })
    }

    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        _reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        Box::pin(async move {
            struct ApplyingEventGuard {
                hub: RevocationHub,
                request: RequestId,
                applied: bool,
            }
            impl Drop for ApplyingEventGuard {
                fn drop(&mut self) {
                    if !self.applied {
                        self.hub.inner.lock().release_applying_event(&self.request);
                    }
                }
            }
            let request = ctx.budget.request.clone();
            let budget = RevocationBudget::new(ctx)?;
            budget.check()?;
            let mut changes = self.inner.changed.subscribe();
            let (cancellations, mut guard) = {
                let mut state = self.inner.lock();
                state.ensure_open()?;
                if matches!(state.events.get(&request), Some(EventDelivery::Applied)) {
                    return Ok(());
                }
                let cancellations = state.event_targets(&request, &selector);
                (
                    cancellations,
                    ApplyingEventGuard {
                        hub: self.clone(),
                        request: request.clone(),
                        applied: false,
                    },
                )
            };
            // An in-flight duplicate repeats the same signals. A completed
            // duplicate cannot cancel a newly authorized registration.
            cancel_all(cancellations);
            loop {
                budget.check()?;
                {
                    let mut state = self.inner.lock();
                    state.ensure_open()?;
                    if !state.canonical_effects.values().any(|effect| {
                        effect.active != 0
                            && effect.revoked
                            && effect.entry.selectors.contains(&selector)
                    }) {
                        state.apply_event(request);
                        guard.applied = true;
                        return Ok(());
                    }
                }
                budget.changed(&mut changes).await?;
            }
        })
    }
}

struct RevocationBudget {
    deadline: Instant,
    cancellation: Cancellation,
}

impl RevocationBudget {
    fn new(ctx: MaintenanceContext) -> Result<Self, PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        let deadline = Instant::now()
            .checked_add(ctx.budget.remaining)
            .ok_or_else(|| invalid(ValidationReason::InvalidLimit))?;
        Ok(Self {
            deadline,
            cancellation: ctx.budget.cancellation,
        })
    }

    fn check(&self) -> Result<(), PortError> {
        if self.cancellation.is_cancelled() {
            return Err(cancelled());
        }
        if Instant::now() >= self.deadline {
            return Err(deadline_exceeded());
        }
        Ok(())
    }

    async fn changed(&self, changes: &mut watch::Receiver<()>) -> Result<(), PortError> {
        tokio::select! {
            biased;
            () = self.cancellation.cancelled() => Err(cancelled()),
            () = tokio::time::sleep_until(self.deadline) => Err(deadline_exceeded()),
            result = changes.changed() => result.map_err(|_| revocation_unavailable()),
        }
    }
}

fn checked_selectors(selectors: Vec<RevocationSelector>) -> Result<Selectors, PortError> {
    if selectors.is_empty() || selectors.len() > MAX_SELECTORS {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok(selectors.into_iter().collect())
}

fn cancel_all(cancellations: Vec<Cancellation>) {
    for cancellation in cancellations {
        cancellation.cancel();
    }
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

fn failure(label: &str) -> OperationalFailure {
    OperationalFailure::new(
        ContentDigest::from_bytes(*blake3::hash(label.as_bytes()).as_bytes()),
        CommitEffect::NotCommitted,
        RetryAdvice::Never,
        false,
    )
    .expect("non-retryable operational failure")
}

fn cancelled() -> PortError {
    PortError::Cancelled(failure("revocation cancelled"))
}

fn deadline_exceeded() -> PortError {
    PortError::DeadlineExceeded(failure("revocation deadline"))
}

fn revocation_unavailable() -> PortError {
    PortError::Unavailable(failure("revocation authority unavailable"))
}

#[cfg(test)]
mod tests;
