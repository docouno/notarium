//! Transport-independent public-client authorization server contracts.
use super::{AccountContext, BearerScope, CallBudget, PortFuture};
use crate::{auth::SecretString, ids::*, ports::control::*};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthErrorCode {
    InvalidRequest,
    InvalidClient,
    InvalidRedirectUri,
    InvalidScope,
    InvalidTarget,
    InvalidGrant,
    AccessDenied,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthScope {
    pub access: BearerScope,
    pub offline_access: bool,
}

#[derive(Clone, Debug)]
pub struct OAuthMetadata {
    pub issuer: String,
    pub resource: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: String,
    pub revocation_endpoint: String,
    pub scopes_supported: Vec<String>,
    pub code_challenge_methods_supported: Vec<String>,
    pub token_endpoint_auth_methods_supported: Vec<String>,
    pub grant_types_supported: Vec<String>,
    pub response_types_supported: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterOAuthClient {
    pub client_name: String,
    pub redirect_uris: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OAuthClientInfo {
    pub client_id: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub expires_at_ms: Option<i64>,
}

/// The adapter bounds raw fields before constructing this request. The service
/// independently validates them and checks the live interactive credential.
pub struct PrepareOAuthAuthorization {
    pub client_id: String,
    pub redirect_uri: String,
    pub resource: String,
    pub scope: String,
    pub selected_spaces: Option<Vec<SpaceId>>,
    pub code_challenge: String,
    pub code_challenge_method: String,
    pub browser_binding: SecretString,
}

/// Keep this value in protected browser state; never log or put it in a URL.
#[derive(Debug)]
pub struct OAuthAuthorizationIntent {
    pub id: OAuthGrantId,
    pub protected: SecretString,
}

#[derive(Debug)]
pub struct PreparedOAuthAuthorization {
    pub client: OAuthClientInfo,
    pub redirect_uri: String,
    pub resource: String,
    pub scope: OAuthScope,
    pub selected_spaces: Option<Vec<SpaceId>>,
    pub expires_at_ms: i64,
    pub intent: OAuthAuthorizationIntent,
}

/// Only trusted transport composition attests explicit consent after checking
/// its CSRF and browser binding. This type deliberately has no deserializer.
pub struct OAuthConsent {
    intent: OAuthAuthorizationIntent,
    browser_binding: SecretString,
}
impl OAuthConsent {
    pub fn attest_checked(intent: OAuthAuthorizationIntent, browser_binding: SecretString) -> Self {
        Self {
            intent,
            browser_binding,
        }
    }
    pub fn into_parts(self) -> (OAuthAuthorizationIntent, SecretString) {
        (self.intent, self.browser_binding)
    }
}

#[derive(Debug)]
pub struct IssuedAuthorizationCode {
    pub code: SecretString,
    pub redirect_uri: String,
    pub expires_at_ms: i64,
    pub grant: OAuthGrantId,
}

pub struct ExchangeOAuthCode {
    pub client_id: String,
    pub code: SecretString,
    pub redirect_uri: String,
    pub resource: String,
    pub code_verifier: SecretString,
}

pub struct RefreshOAuthToken {
    pub client_id: String,
    pub refresh_token: SecretString,
    pub resource: String,
    /// Omission preserves the granted scope. A supplied scope must match;
    /// changing consent requires a fresh authorization flow.
    pub scope: Option<String>,
}

#[derive(Debug)]
pub struct IssuedOAuthTokens {
    pub access_token: SecretString,
    pub refresh_token: Option<SecretString>,
    pub expires_at_ms: i64,
    pub refresh_expires_at_ms: Option<i64>,
    pub scope: OAuthScope,
    pub grant: OAuthGrantId,
    pub family: Option<OAuthFamilyId>,
}

pub struct RevokeOAuthToken {
    pub client_id: String,
    pub token: SecretString,
}

#[derive(Clone, Debug)]
pub struct OAuthGrantInfo {
    pub id: OAuthGrantId,
    pub client_id: String,
    pub resource: String,
    pub scope: BearerScope,
    pub selected_spaces: Option<Vec<SpaceId>>,
    pub revoked_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

pub trait OAuthPort: Send + Sync {
    fn metadata(&self) -> OAuthMetadata;
    fn register_client(
        &self,
        budget: CallBudget,
        request: RegisterOAuthClient,
    ) -> PortFuture<'_, OAuthClientInfo>;
    fn resolve_client(
        &self,
        budget: CallBudget,
        client_id: String,
    ) -> PortFuture<'_, OAuthClientInfo>;
    fn prepare_authorization(
        &self,
        ctx: AccountContext,
        request: PrepareOAuthAuthorization,
    ) -> PortFuture<'_, PreparedOAuthAuthorization>;
    fn approve_authorization(
        &self,
        ctx: AccountContext,
        consent: OAuthConsent,
    ) -> PortFuture<'_, IssuedAuthorizationCode>;
    fn exchange_code(
        &self,
        budget: CallBudget,
        request: ExchangeOAuthCode,
    ) -> PortFuture<'_, IssuedOAuthTokens>;
    fn refresh(
        &self,
        budget: CallBudget,
        request: RefreshOAuthToken,
    ) -> PortFuture<'_, IssuedOAuthTokens>;
    fn revoke(&self, budget: CallBudget, request: RevokeOAuthToken) -> PortFuture<'_, ()>;
    fn list_grants(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<OAuthGrantInfo>>;
    fn revoke_grant(
        &self,
        ctx: AccountContext,
        request: AccountMutation<OAuthGrantId>,
    ) -> PortFuture<'_, ControlCommit<()>>;
}
