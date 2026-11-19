use super::{ChatProposalWitness, RevocationLease};
use crate::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, SecretString},
    error::ValidationReason,
    ids::*,
    model::{FolderRef, HistoryScope},
    receipt::CommandIdentity,
};
use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Duration,
};

#[derive(Default)]
struct WakerSlab {
    entries: Vec<Option<Waker>>,
    free: Vec<usize>,
}

#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    wakers: Mutex<WakerSlab>,
}

#[derive(Clone, Default)]
pub struct Cancellation(Arc<CancellationState>);
impl Cancellation {
    pub fn cancel(&self) {
        let entries = {
            let mut guard = self.0.wakers.lock().unwrap_or_else(|e| e.into_inner());
            if self.0.cancelled.swap(true, Ordering::SeqCst) {
                return;
            }
            guard.free.clear();
            std::mem::take(&mut guard.entries)
        };
        for waker in entries.into_iter().flatten() {
            waker.wake();
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }
    pub fn cancelled(&self) -> Cancelled<'_> {
        Cancelled {
            cancellation: self,
            slot: None,
        }
    }
}
impl fmt::Debug for Cancellation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Cancellation")
            .field(&self.is_cancelled())
            .finish()
    }
}
pub struct Cancelled<'a> {
    cancellation: &'a Cancellation,
    slot: Option<usize>,
}
impl Unpin for Cancelled<'_> {}
impl Future for Cancelled<'_> {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.cancellation.is_cancelled() {
            return Poll::Ready(());
        }
        let mut guard = self
            .cancellation
            .0
            .wakers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.cancellation.is_cancelled() {
            self.slot = None;
            return Poll::Ready(());
        }
        let waker = cx.waker();
        match self.slot {
            Some(idx) => {
                if let Some(entry) = guard.entries.get_mut(idx) {
                    match entry {
                        Some(existing) if existing.will_wake(waker) => {}
                        _ => *entry = Some(waker.clone()),
                    }
                }
            }
            None => {
                let idx = if let Some(free_idx) = guard.free.pop() {
                    guard.entries[free_idx] = Some(waker.clone());
                    free_idx
                } else {
                    let idx = guard.entries.len();
                    guard.entries.push(Some(waker.clone()));
                    idx
                };
                self.slot = Some(idx);
            }
        }
        Poll::Pending
    }
}
impl Drop for Cancelled<'_> {
    fn drop(&mut self) {
        if let Some(idx) = self.slot.take()
            && !self.cancellation.is_cancelled()
        {
            let mut guard = self
                .cancellation
                .0
                .wakers
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = guard.entries.get_mut(idx)
                && entry.take().is_some()
            {
                guard.free.push(idx);
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct CallBudget {
    pub request: RequestId,
    pub cancellation: Cancellation,
    pub remaining: Duration,
}

/// Credentials are consumed by the authentication owner, never formatted in errors.
pub struct AuthEvidence {
    kind: AuthEvidenceKind,
    secret: SecretString,
    human_management: bool,
    ability_write: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthEvidenceKind {
    Session,
    Pat,
    OAuth,
    Oidc,
}
impl AuthEvidence {
    pub fn new(kind: AuthEvidenceKind, secret: String) -> Self {
        Self {
            kind,
            secret: SecretString::new(secret),
            human_management: false,
            ability_write: false,
        }
    }
    pub fn kind(&self) -> AuthEvidenceKind {
        self.kind
    }
    pub fn secret(&self) -> &str {
        self.secret.expose()
    }
    /// Trusted interactive transport explicitly admits human management after
    /// checking its perimeter and CSRF policy. Delegated bearers ignore this bit.
    pub fn with_human_management(mut self) -> Self {
        self.human_management = true;
        self
    }
    pub fn human_management(&self) -> bool {
        self.human_management
    }
    /// Trusted interactive transport explicitly admits ability package authoring
    /// independently from ordinary account/Space management mutations.
    pub fn with_ability_write(mut self) -> Self {
        self.ability_write = true;
        self
    }
    pub fn ability_write(&self) -> bool {
        self.ability_write
    }
}
impl fmt::Debug for AuthEvidence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthEvidence")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}
#[derive(Debug)]
pub struct PreAuthContext {
    pub budget: CallBudget,
    pub evidence: AuthEvidence,
}
#[derive(Clone, Debug)]
pub struct AccountContext {
    auth: EngineAuthContext,
    pub budget: CallBudget,
}
impl AccountContext {
    pub fn new(auth: EngineAuthContext, budget: CallBudget) -> Self {
        Self { auth, budget }
    }
    pub fn auth(&self) -> &EngineAuthContext {
        &self.auth
    }
}
#[derive(Clone, Debug)]
/// Account authority cannot stand in for a specific Space/history admission.
/// ```compile_fail
/// use notarium_core::ports::{AccountContext, SpaceContext};
/// fn admit(account: AccountContext) { let _: SpaceContext = account; }
/// ```
pub struct SpaceContext {
    auth: EngineAuthContext,
    scope: HistoryScope,
    confirmed_chat_step: Option<Arc<ConfirmedChatStep>>,
    canonical_effect: Option<CanonicalEffectLease>,
    pub budget: CallBudget,
}
impl SpaceContext {
    pub fn new(
        auth: EngineAuthContext,
        scope: HistoryScope,
        budget: CallBudget,
    ) -> DomainResult<Self> {
        if !auth.spaces().contains_key(&scope.space_id) {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(Self {
            auth,
            scope,
            confirmed_chat_step: None,
            canonical_effect: None,
            budget,
        })
    }
    pub fn auth(&self) -> &EngineAuthContext {
        &self.auth
    }
    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }
    /// Bind one explicitly confirmed step to this independently authenticated
    /// write context. Cloning the proposal read context cannot clear its taint.
    pub fn with_confirmed_chat_step(
        mut self,
        witness: ChatProposalWitness,
        identity: &CommandIdentity,
    ) -> DomainResult<Self> {
        self.scope.check(&identity.scope)?;
        witness.authorize_writer(&self.auth)?;
        if identity.actor != *self.auth.principal() || self.confirmed_chat_step.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority));
        }
        self.confirmed_chat_step = Some(Arc::new(ConfirmedChatStep {
            witness,
            identity: identity.clone(),
            destination: None,
        }));
        Ok(self)
    }
    pub fn confirmed_chat_step(&self) -> Option<&Arc<ConfirmedChatStep>> {
        self.confirmed_chat_step.as_ref()
    }
    pub fn with_confirmed_note_destination(
        mut self,
        destination: ConfirmedNoteDestination,
    ) -> DomainResult<Self> {
        if self.scope.space_id != destination.anchor.space_id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        let step = self
            .confirmed_chat_step
            .as_mut()
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidAuthority))?;
        let step = Arc::make_mut(step);
        if step.destination.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority));
        }
        step.destination = Some(destination);
        Ok(self)
    }
    /// Bind freshly revalidated Control authority for one bounded canonical
    /// operation. Its owned writer may retain the lease past the caller's wait.
    pub fn with_canonical_effect(
        mut self,
        current: &AccountContext,
        lease: Box<dyn RevocationLease>,
    ) -> DomainResult<Self> {
        if self.canonical_effect.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority));
        }
        self.auth = self.auth.intersect_current(current.auth())?;
        if !self.auth.spaces().contains_key(&self.scope.space_id) {
            return Err(DomainError::ResourceNotFound);
        }
        self.budget = current.budget.clone();
        self.canonical_effect = Some(CanonicalEffectLease(Arc::new(Mutex::new(lease))));
        Ok(self)
    }
    pub fn canonical_effect(&self) -> Option<&CanonicalEffectLease> {
        self.canonical_effect.as_ref()
    }
    pub fn restrict_to_project(mut self, project: &FolderRef) -> DomainResult<Self> {
        if self.scope.space_id != project.space_id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        self.auth = self.auth.restrict_to_project(project)?;
        Ok(self)
    }
    pub fn check_current(&self, current: &HistoryScope) -> DomainResult<()> {
        current.check(&self.scope)
    }
}

/// Shared lifetime of a revocable canonical operation and its writer settlement.
#[derive(Clone)]
pub struct CanonicalEffectLease(Arc<Mutex<Box<dyn RevocationLease>>>);

impl CanonicalEffectLease {
    pub fn check(&self) -> Result<(), crate::error::PortError> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .check()
    }
}

impl fmt::Debug for CanonicalEffectLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CanonicalEffectLease")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalEffect {
    AbilityAuthoring,
    ConfirmedProposal,
    ChatInput,
    ChatClaim,
}

/// The step identity and source witness travel together on the trusted writer
/// context. Neither is accepted from transport payloads.
#[derive(Clone, Debug)]
pub struct ConfirmedChatStep {
    witness: ChatProposalWitness,
    identity: CommandIdentity,
    destination: Option<ConfirmedNoteDestination>,
}
impl ConfirmedChatStep {
    pub fn witness(&self) -> &ChatProposalWitness {
        &self.witness
    }
    pub fn identity(&self) -> &CommandIdentity {
        &self.identity
    }
    pub fn destination(&self) -> Option<&ConfirmedNoteDestination> {
        self.destination.as_ref()
    }
}

/// The exact approved folder anchor and the path components observed absent.
/// A move also guards its source before any missing folders can be created.
#[derive(Clone, Debug)]
pub struct ConfirmedNoteDestination {
    pub anchor: FolderRef,
    pub anchor_revision: RevisionId,
    pub anchor_path: String,
    pub anchor_ancestors: Vec<FolderId>,
    pub missing_suffix: String,
    pub move_source: Option<(NoteId, RevisionId)>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServicePurpose {
    Projection,
    Search,
    EventPublication,
    Revocation,
    ProviderRecovery,
    Scheduler,
    Telemetry,
    Backup,
    Restore,
}
#[derive(Clone, Debug)]
/// Service authority is never parsed from an external request.
/// ```compile_fail
/// use notarium_core::ports::ServiceAuthority;
/// let _: ServiceAuthority = serde_json::from_str("{}").unwrap();
/// ```
pub struct ServiceAuthority {
    purpose: ServicePurpose,
}
impl ServiceAuthority {
    /// Trusted composition/admission owner only; not an external request constructor.
    pub fn admit(purpose: ServicePurpose) -> Self {
        Self { purpose }
    }
    pub fn require(&self, purpose: ServicePurpose) -> DomainResult<()> {
        if self.purpose == purpose {
            Ok(())
        } else {
            Err(DomainError::validation(ValidationReason::InvalidAuthority))
        }
    }
}
#[derive(Clone, Debug)]
pub struct MaintenanceContext {
    pub authority: ServiceAuthority,
    pub budget: CallBudget,
}
