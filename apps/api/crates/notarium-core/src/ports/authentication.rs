//! Account authentication services; HTTP, cookies and the desktop perimeter are
//! transport responsibilities. Verified contexts never deserialize from input.
use super::{
    PortFuture,
    context::*,
    control::{AccountMutation, ControlCommit, ControlPage, ControlPageRequest},
};
use crate::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, SecretString},
    epoch::{EpochClassification, EpochReason, StorageEpochState},
    error::ValidationReason,
    ids::*,
};

/// Trusted composition supplies the observation made before creating a fresh
/// data root. The authentication owner also checks the durable bootstrap CAS.
pub struct EmptyRootAuthorization {
    installation: InstallationId,
}
impl EmptyRootAuthorization {
    pub fn from_classification(
        installation: InstallationId,
        classification: EpochClassification,
    ) -> DomainResult<Self> {
        if classification.state != StorageEpochState::EmptyRoot
            || classification.reason != EpochReason::ConfirmedEmpty
        {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority));
        }
        Ok(Self { installation })
    }
    pub fn installation(&self) -> &InstallationId {
        &self.installation
    }
}

/// Only a trusted transport/composition owner may attest its checked perimeter.
/// This attestation cannot be parsed from a request or replace bearer validation.
pub struct PerimeterAttestation {
    human_management: bool,
}
impl PerimeterAttestation {
    pub fn attest_checked() -> Self {
        Self {
            human_management: false,
        }
    }
    /// The transport has also admitted an interactive human management action.
    pub fn with_human_management(mut self) -> Self {
        self.human_management = true;
        self
    }
    pub fn human_management(&self) -> bool {
        self.human_management
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AccountInfo {
    pub id: PrincipalId,
    pub username: String,
    pub email: Option<String>,
    pub display_name: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub personal_space: Option<SpaceId>,
    pub revision: ControlRevision,
}
#[derive(Debug)]
pub struct PasswordLogin {
    pub identifier: String,
    pub password: SecretString,
}
#[derive(Debug)]
pub struct BootstrapAccount {
    pub username: String,
    pub email: Option<String>,
    pub display_name: String,
    pub password: Option<SecretString>,
}
#[derive(Debug)]
pub struct IssuedSession {
    pub account: AccountInfo,
    pub id: AuthSessionId,
    pub token: SecretString,
    pub expires_at_ms: i64,
}
#[derive(Debug)]
pub struct BootstrapAccountResult {
    pub account: AccountInfo,
    pub session: Option<IssuedSession>,
}
#[derive(Clone, Debug)]
pub struct NewAccount {
    pub username: String,
    pub email: Option<String>,
    pub display_name: String,
}
#[derive(Debug)]
pub struct ChangePassword {
    pub account: PrincipalId,
    pub current: Option<SecretString>,
    pub replacement: SecretString,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct SetAccountDisabled {
    pub account: PrincipalId,
    pub disabled: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OneTimePurpose {
    Invite,
    Reset,
}
#[derive(Clone, Debug)]
pub struct IssueOneTime {
    pub account: PrincipalId,
    pub purpose: OneTimePurpose,
    pub expected: ControlRevision,
}
#[derive(Debug)]
pub struct IssuedOneTime {
    pub token: SecretString,
    pub purpose: OneTimePurpose,
    pub expires_at_ms: i64,
}
#[derive(Debug)]
pub struct ConsumeOneTime {
    pub token: SecretString,
    pub purpose: OneTimePurpose,
    pub password: SecretString,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BearerScope {
    Read,
    Write,
}
#[derive(Clone, Debug)]
pub struct CreatePat {
    pub name: String,
    pub scope: BearerScope,
    /// None means all current memberships; Some(empty) means no Spaces.
    pub selected_spaces: Option<Vec<SpaceId>>,
    pub expires_at_ms: Option<i64>,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct PatInfo {
    pub id: CredentialTokenId,
    pub account: PrincipalId,
    pub name: String,
    pub scope: BearerScope,
    pub selected_spaces: Option<Vec<SpaceId>>,
    pub expires_at_ms: Option<i64>,
    pub last_used_at_ms: Option<i64>,
    pub revoked_at_ms: Option<i64>,
    pub created_at_ms: i64,
}
#[derive(Debug)]
pub struct IssuedPat {
    pub metadata: PatInfo,
    pub token: SecretString,
}
#[derive(Clone, Debug)]
pub struct RevokePat {
    pub account: PrincipalId,
    pub token: CredentialTokenId,
}
#[derive(Clone, Copy, Debug)]
pub struct RevocationDrain {
    pub delivered: u16,
    pub has_more: bool,
}

/// Minted secrets are returned once. They are never included in replay receipts;
/// a lost mint response requires a new explicit issuance after inspecting/revoking
/// the earlier credential. Each control effect rechecks durable authority.
pub trait AuthPort: Send + Sync {
    fn bootstrap(
        &self,
        authorization: EmptyRootAuthorization,
        budget: CallBudget,
        request: BootstrapAccount,
    ) -> PortFuture<'_, BootstrapAccountResult>;
    fn login(&self, budget: CallBudget, request: PasswordLogin) -> PortFuture<'_, IssuedSession>;
    fn resolve(&self, ctx: PreAuthContext) -> PortFuture<'_, EngineAuthContext>;
    fn trusted_none(
        &self,
        perimeter: PerimeterAttestation,
        budget: CallBudget,
    ) -> PortFuture<'_, EngineAuthContext>;
    /// Revoked session evidence may only resume its own pending logout delivery.
    fn logout(&self, ctx: PreAuthContext) -> PortFuture<'_, ()>;
    fn account(&self, ctx: AccountContext, account: PrincipalId) -> PortFuture<'_, AccountInfo>;
    /// Explicit owner management admission also works while a Space is archived.
    /// Inactive Spaces carry no content read/write classes in the returned context.
    fn admit_space_management(
        &self,
        ctx: AccountContext,
        scope: crate::model::HistoryScope,
    ) -> PortFuture<'_, SpaceContext>;
    fn create_account(
        &self,
        ctx: AccountContext,
        request: AccountMutation<NewAccount>,
    ) -> PortFuture<'_, ControlCommit<AccountInfo>>;
    fn change_password(
        &self,
        ctx: AccountContext,
        request: ChangePassword,
    ) -> PortFuture<'_, ControlCommit<AccountInfo>>;
    fn set_disabled(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetAccountDisabled>,
    ) -> PortFuture<'_, ControlCommit<AccountInfo>>;
    fn issue_one_time(
        &self,
        ctx: AccountContext,
        request: IssueOneTime,
    ) -> PortFuture<'_, ControlCommit<IssuedOneTime>>;
    fn consume_one_time(
        &self,
        budget: CallBudget,
        request: ConsumeOneTime,
    ) -> PortFuture<'_, IssuedSession>;
    fn create_pat(
        &self,
        ctx: AccountContext,
        request: CreatePat,
    ) -> PortFuture<'_, ControlCommit<IssuedPat>>;
    fn list_pats(
        &self,
        ctx: AccountContext,
        account: PrincipalId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<PatInfo>>;
    fn revoke_pat(
        &self,
        ctx: AccountContext,
        request: AccountMutation<RevokePat>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn drain_revocations(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> PortFuture<'_, RevocationDrain>;
}
