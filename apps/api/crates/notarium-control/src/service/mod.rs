//! Control service composition. Database authority is rechecked for each effect.
mod abilities;
mod accounts;
mod auth_port;
mod authority;
mod commands;
mod context_state;
mod control_port;
pub use control_port::ControlPlane;
mod episodes;
mod lifecycle;
mod metadata;
pub mod oauth;
pub mod oidc;
mod one_time;
mod outbox;
mod passwords;
mod pats;
pub mod provider;
mod provisioning;
mod schedules;
mod sessions;
mod spaces;
mod telemetry;
use crate::{
    error::{invalid, unavailable},
    store::{ControlStore, lease::OperationBudget},
};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::*,
};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
pub enum AuthenticationMode {
    Password,
    TrustedNone { owner: PrincipalId },
}
#[derive(Clone, Debug)]
pub struct ControlConfig {
    pub authentication: AuthenticationMode,
    pub resource_uri: String,
    pub max_auth_spaces: u16,
    pub schedule_limits: control::RunLimits,
}
pub trait ControlClock: Send + Sync {
    fn now_ms(&self) -> Result<i64, PortError>;
}
#[derive(Default)]
pub struct SystemClock;
impl ControlClock for SystemClock {
    fn now_ms(&self) -> Result<i64, PortError> {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| unavailable("control clock", CommitEffect::NotCommitted))?
            .as_millis();
        i64::try_from(millis).map_err(|_| invalid(ValidationReason::InvalidTimestamp))
    }
}
pub struct ControlService {
    store: ControlStore,
    catalog: Arc<dyn ControlCatalogPort>,
    revoker: Arc<dyn SessionRevocationPort>,
    clock: Arc<dyn ControlClock>,
    config: ControlConfig,
    installation: InstallationId,
}
impl ControlService {
    /// The composition owner publishes a consistent paired data-root epoch first.
    /// A failed pending revocation keeps this constructor from returning ready.
    pub async fn open(
        store: ControlStore,
        catalog: Arc<dyn ControlCatalogPort>,
        revoker: Arc<dyn SessionRevocationPort>,
        clock: Arc<dyn ControlClock>,
        mut config: ControlConfig,
        budget: CallBudget,
    ) -> Result<Self, PortError> {
        let operation = OperationBudget::new(budget.clone());
        if !config
            .schedule_limits
            .fits(control::RunLimits::HARD_CEILING)
            || !(1..=4096).contains(&config.max_auth_spaces)
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let url = url::Url::parse(&config.resource_uri)
            .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || config.resource_uri.len() > 2048
        {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        config.resource_uri = url.to_string();
        let installation = operation
            .run(store.installation(), CommitEffect::NotCommitted)
            .await?
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        let service = Self {
            store,
            catalog,
            revoker,
            clock,
            config,
            installation,
        };
        service.resume_pending_spaces(&operation).await?;
        loop {
            let page = service
                .drain_revocations(
                    MaintenanceContext {
                        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                        budget: operation.context(budget.request.clone()),
                    },
                    200,
                )
                .await?;
            if !page.has_more {
                break;
            }
        }
        service.resume_pending_lifecycles(&operation).await?;
        Ok(service)
    }
}
