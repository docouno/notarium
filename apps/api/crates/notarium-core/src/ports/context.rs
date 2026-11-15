use crate::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, SecretString},
    error::ValidationReason,
    ids::*,
    model::HistoryScope,
};
use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Clone, Debug, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
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
            budget,
        })
    }
    pub fn auth(&self) -> &EngineAuthContext {
        &self.auth
    }
    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }
    pub fn check_current(&self, current: &HistoryScope) -> DomainResult<()> {
        current.check(&self.scope)
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServicePurpose {
    Projection,
    Search,
    EventPublication,
    Revocation,
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
