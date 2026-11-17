//! OIDC RP: operator-selected issuers and explicit local identity ownership.
mod cache;
mod claims;
mod flows;
mod http;
mod identities;
#[cfg(test)]
mod tests;

use super::ControlService;
use crate::{
    auth::token,
    keyring::Keyring,
    outbound::{NetworkPolicy, OutboundScope, OutboundTransport},
};
use notarium_core::{
    DomainError,
    error::{BudgetKind, PortError},
    ids::*,
    ports::{control::*, *},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Serialize)]
pub enum OidcClientAuthentication {
    Public,
    SecretBasic { credential: CredentialId },
    SecretPost { credential: CredentialId },
}
#[derive(Clone, Serialize)]
pub struct OidcProviderConfig {
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub authentication: OidcClientAuthentication,
    /// Additional audiences are rejected unless the operator trusts them here.
    /// The token must still contain this client's audience and matching azp.
    pub trusted_additional_audiences: Vec<String>,
}
struct RateWindow {
    started: Instant,
    used: u16,
}
impl RateWindow {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            used: 0,
        }
    }
    fn admit(&mut self, limit: u16) -> Result<(), PortError> {
        if self.started.elapsed() >= Duration::from_secs(60) {
            self.started = Instant::now();
            self.used = 0;
        }
        if self.used >= limit {
            return Err(DomainError::RateLimited {
                retry_after_ms: 60_000,
                budget: BudgetKind::Requests,
            }
            .into());
        }
        self.used += 1;
        Ok(())
    }
}
struct Provider {
    config: OidcProviderConfig,
    digest: [u8; 32],
    cache: Mutex<cache::Cache>,
    login_rate: StdMutex<RateWindow>,
    link_rate: StdMutex<RateWindow>,
}
impl Provider {
    fn admit_begin(&self, is_link: bool) -> Result<(), PortError> {
        let target = if is_link {
            &self.link_rate
        } else {
            &self.login_rate
        };
        target.lock().map_err(|_| limited())?.admit(60)
    }
}
pub struct OidcService {
    control: Arc<ControlService>,
    keyring: Arc<Keyring>,
    outbound: Arc<OutboundTransport>,
    providers: BTreeMap<String, Arc<Provider>>,
    admission: Arc<Semaphore>,
}
fn denied() -> PortError {
    DomainError::AuthenticationFailed.into()
}
fn limited() -> PortError {
    DomainError::RateLimited {
        retry_after_ms: 1000,
        budget: BudgetKind::Concurrency,
    }
    .into()
}
impl OidcService {
    pub fn new(
        control: Arc<ControlService>,
        keyring: Arc<Keyring>,
        outbound: Arc<OutboundTransport>,
        configs: Vec<OidcProviderConfig>,
    ) -> Result<Self, PortError> {
        if configs.len() > 64 {
            return Err(limited());
        }
        let mut providers = BTreeMap::new();
        for config in configs {
            NetworkPolicy::default().endpoint(
                OutboundScope::Oidc {
                    issuer: config.issuer.clone(),
                },
                &config.issuer,
            )?;
            if config.issuer.len() > 1024
                || config.client_id.is_empty()
                || config.client_id.len() > 256
                || config.client_id.chars().any(char::is_control)
                || config.trusted_additional_audiences.len() > 16
                || config
                    .trusted_additional_audiences
                    .iter()
                    .any(|a| a.is_empty() || a.len() > 256 || a.chars().any(char::is_control))
            {
                return Err(denied());
            }
            super::oauth::validation::redirect(&config.redirect_uri)?;
            let digest = token::digest(&serde_json::to_vec(&config).map_err(|_| denied())?);
            let issuer = config.issuer.clone();
            if providers
                .insert(
                    issuer,
                    Arc::new(Provider {
                        config,
                        digest,
                        cache: Mutex::new(cache::Cache::default()),
                        login_rate: StdMutex::new(RateWindow::new()),
                        link_rate: StdMutex::new(RateWindow::new()),
                    }),
                )
                .is_some()
            {
                return Err(denied());
            }
        }
        Ok(Self {
            control,
            keyring,
            outbound,
            providers,
            admission: Arc::new(Semaphore::new(16)),
        })
    }
    pub(super) fn admit(&self) -> Result<OwnedSemaphorePermit, PortError> {
        self.admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| limited())
    }
    fn provider(&self, issuer: &str) -> Result<Arc<Provider>, PortError> {
        self.providers.get(issuer).cloned().ok_or_else(denied)
    }
}
impl OidcPort for OidcService {
    fn begin_login(&self, b: CallBudget, r: BeginOidcLogin) -> PortFuture<'_, OidcAuthorization> {
        Box::pin(self.begin(b, None, r))
    }
    fn begin_link(
        &self,
        c: AccountContext,
        r: BeginOidcLogin,
    ) -> PortFuture<'_, OidcAuthorization> {
        Box::pin(self.begin(c.budget.clone(), Some(c), r))
    }
    fn finish_callback(&self, b: CallBudget, r: FinishOidcCallback) -> PortFuture<'_, OidcOutcome> {
        Box::pin(self.finish(b, r))
    }
    fn admin_bind(
        &self,
        c: AccountContext,
        r: AccountMutation<BindOidcIdentity>,
    ) -> PortFuture<'_, ControlCommit<OidcIdentity>> {
        Box::pin(self.bind_identity(c, r))
    }
    fn unlink(
        &self,
        c: AccountContext,
        r: AccountMutation<UnlinkOidcIdentity>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(self.unlink_identity(c, r))
    }
}
