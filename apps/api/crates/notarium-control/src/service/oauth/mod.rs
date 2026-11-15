//! OAuth AS composition. Browser and HTTP adapters own their transport defenses.
mod authorization;
mod clients;
mod grants;
mod tokens;
pub(crate) mod validation;

use super::ControlService;
use crate::{keyring::Keyring, outbound::OutboundTransport};
use notarium_core::{
    DomainError,
    error::PortError,
    ids::*,
    ports::{control::*, *},
};
use std::sync::Arc;

pub struct OAuthConfig {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: String,
    pub revocation_endpoint: String,
}
pub struct OAuthService {
    control: Arc<ControlService>,
    keyring: Arc<Keyring>,
    outbound: Arc<OutboundTransport>,
    metadata: OAuthMetadata,
}
fn rejected(error: OAuthErrorCode) -> PortError {
    DomainError::OAuth { error }.into()
}
fn invalid_grant() -> PortError {
    rejected(OAuthErrorCode::InvalidGrant)
}
fn expiry(now: i64, millis: i64) -> Result<i64, PortError> {
    now.checked_add(millis).ok_or_else(invalid_grant)
}
impl OAuthService {
    /// URLs come only from operator configuration, never request Host headers.
    pub fn new(
        control: Arc<ControlService>,
        keyring: Arc<Keyring>,
        outbound: Arc<OutboundTransport>,
        config: OAuthConfig,
    ) -> Result<Self, PortError> {
        for value in [
            &config.issuer,
            &config.authorization_endpoint,
            &config.token_endpoint,
            &config.registration_endpoint,
            &config.revocation_endpoint,
        ] {
            validation::server_url(value)?;
        }
        Ok(Self {
            metadata: OAuthMetadata {
                issuer: config.issuer,
                resource: control.config.resource_uri.clone(),
                authorization_endpoint: config.authorization_endpoint,
                token_endpoint: config.token_endpoint,
                registration_endpoint: config.registration_endpoint,
                revocation_endpoint: config.revocation_endpoint,
                scopes_supported: vec!["read".into(), "write".into(), "offline_access".into()],
                code_challenge_methods_supported: vec!["S256".into()],
                token_endpoint_auth_methods_supported: vec!["none".into()],
                grant_types_supported: vec!["authorization_code".into(), "refresh_token".into()],
                response_types_supported: vec!["code".into()],
            },
            control,
            keyring,
            outbound,
        })
    }
}
impl OAuthPort for OAuthService {
    fn metadata(&self) -> OAuthMetadata {
        self.metadata.clone()
    }
    fn register_client(
        &self,
        b: CallBudget,
        r: RegisterOAuthClient,
    ) -> PortFuture<'_, OAuthClientInfo> {
        Box::pin(self.register(b, r))
    }
    fn resolve_client(&self, b: CallBudget, id: String) -> PortFuture<'_, OAuthClientInfo> {
        Box::pin(async move {
            let client = self.client(b, &id).await?;
            clients::info(&client)
        })
    }
    fn prepare_authorization(
        &self,
        c: AccountContext,
        r: PrepareOAuthAuthorization,
    ) -> PortFuture<'_, PreparedOAuthAuthorization> {
        Box::pin(self.prepare(c, r))
    }
    fn approve_authorization(
        &self,
        c: AccountContext,
        r: OAuthConsent,
    ) -> PortFuture<'_, IssuedAuthorizationCode> {
        Box::pin(self.approve(c, r))
    }
    fn exchange_code(
        &self,
        b: CallBudget,
        r: ExchangeOAuthCode,
    ) -> PortFuture<'_, IssuedOAuthTokens> {
        Box::pin(self.exchange(b, r))
    }
    fn refresh(&self, b: CallBudget, r: RefreshOAuthToken) -> PortFuture<'_, IssuedOAuthTokens> {
        Box::pin(self.rotate(b, r))
    }
    fn revoke(&self, b: CallBudget, r: RevokeOAuthToken) -> PortFuture<'_, ()> {
        Box::pin(self.revoke_token(b, r))
    }
    fn list_grants(
        &self,
        c: AccountContext,
        p: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<OAuthGrantInfo>> {
        Box::pin(self.grants(c, p))
    }
    fn revoke_grant(
        &self,
        c: AccountContext,
        r: AccountMutation<OAuthGrantId>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(self.disconnect(c, r))
    }
}
