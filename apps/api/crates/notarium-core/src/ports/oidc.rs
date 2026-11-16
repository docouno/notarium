//! Explicit external identity proofs, separate from the local OAuth issuer.
use super::{AccountContext, CallBudget, IssuedSession, PortFuture, control::*};
use crate::{auth::SecretString, ids::*};
use serde::{Deserialize, Serialize};

pub struct BeginOidcLogin {
    /// Must exactly identify an operator-configured provider.
    pub issuer: String,
    pub browser_binding: SecretString,
}
#[derive(Debug)]
pub struct ProtectedOidcFlow {
    pub transaction: RequestId,
    pub context: SecretString,
}
#[derive(Debug)]
pub struct OidcAuthorization {
    pub authorization_url: SecretString,
    /// The adapter stores this in a Secure, HttpOnly, SameSite cookie. It must
    /// never put the protected context in the authorization URL or logs.
    pub flow: ProtectedOidcFlow,
    pub expires_at_ms: i64,
}
pub struct FinishOidcCallback {
    pub flow: ProtectedOidcFlow,
    pub code: SecretString,
    pub state: SecretString,
    pub browser_binding: SecretString,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OidcIdentity {
    pub issuer: String,
    pub subject: String,
    pub account: PrincipalId,
    pub created_at_ms: i64,
}
/// This is display information, never authority to bind or create an account.
#[derive(Debug)]
pub struct UnboundOidcIdentity {
    pub issuer: String,
    pub subject: String,
    pub contact_email: Option<String>,
}
#[derive(Debug)]
pub enum OidcOutcome {
    Authenticated(IssuedSession),
    Linked(OidcIdentity),
    IdentityUnbound(UnboundOidcIdentity),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BindOidcIdentity {
    pub account: PrincipalId,
    pub issuer: String,
    pub subject: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnlinkOidcIdentity {
    pub account: PrincipalId,
    pub issuer: String,
    pub subject: String,
}
pub trait OidcPort: Send + Sync {
    fn begin_login(
        &self,
        budget: CallBudget,
        request: BeginOidcLogin,
    ) -> PortFuture<'_, OidcAuthorization>;
    fn begin_link(
        &self,
        ctx: AccountContext,
        request: BeginOidcLogin,
    ) -> PortFuture<'_, OidcAuthorization>;
    fn finish_callback(
        &self,
        budget: CallBudget,
        request: FinishOidcCallback,
    ) -> PortFuture<'_, OidcOutcome>;
    fn admin_bind(
        &self,
        ctx: AccountContext,
        request: AccountMutation<BindOidcIdentity>,
    ) -> PortFuture<'_, ControlCommit<OidcIdentity>>;
    fn unlink(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UnlinkOidcIdentity>,
    ) -> PortFuture<'_, ControlCommit<()>>;
}
