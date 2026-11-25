//! Provider configuration, current disclosure admission and durable accounting.
mod accounting;
mod admission;
mod attachments;
mod configuration;
mod dispatch;
mod execution;
mod inventory;
mod offers;
mod ports;
mod records;
mod recovery;
mod selection;
pub use selection::ResolvedSearchEmbeddingModel;
pub(super) use selection::SearchDefaultWitness;
mod wire;

use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
};
use crate::{
    error::invalid,
    keyring::Keyring,
    outbound::OutboundTransport,
    store::{Transaction, lease::OperationBudget, statements::execute, target::UsersRow},
};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ports::{control::*, *},
};
use serde::{Serialize, de::DeserializeOwned};
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::Semaphore;

/// Wire payload ceiling enforced by the bounded provider codec.
pub const MAX_COMPLETION_WIRE_BYTES: usize = wire::MAX_PAYLOAD;

/// Estimate the request with the same bounded codec used by admission and
/// provider accounting. This helper performs no authority or network work.
pub fn completion_input_estimate(request: &CompletionRequest) -> Result<u32, PortError> {
    wire::estimate_completion_input_tokens(request)
}

/// Conservatively estimate serialized wire payload bytes for prompt planning.
pub fn completion_wire_bytes_estimate(request: &CompletionRequest) -> Result<usize, PortError> {
    wire::estimate_completion_wire_bytes(request)
}

/// Price generated text when it becomes input to a later completion.
pub fn completion_text_estimate(text: &str) -> u64 {
    wire::text_tokens(text)
}

pub const DEFAULT_MAX_ACTIVE_CALLS: usize = 64;
const MAX_ACTIVE_CALLS_CAP: usize = 1024;

#[derive(Clone, Debug)]
pub struct ProviderConfig {
    pub default_space_limits: ProviderLimits,
    pub space_limits: BTreeMap<notarium_core::ids::SpaceId, ProviderLimits>,
    pub max_active_calls: usize,
}
impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            default_space_limits: ProviderLimits::default(),
            space_limits: BTreeMap::new(),
            max_active_calls: DEFAULT_MAX_ACTIVE_CALLS,
        }
    }
}
#[derive(Clone)]
pub struct ProviderService {
    control: Arc<ControlService>,
    keyring: Arc<Keyring>,
    outbound: Arc<OutboundTransport>,
    egress: Arc<dyn ProviderEgressCatalogPort>,
    config: ProviderConfig,
    dispatcher: notarium_core::ids::RequestId,
    active_calls: Arc<Semaphore>,
}
impl ProviderService {
    pub(super) fn control_service(&self) -> Arc<ControlService> {
        self.control.clone()
    }
    pub fn new(
        control: Arc<ControlService>,
        keyring: Arc<Keyring>,
        outbound: Arc<OutboundTransport>,
        egress: Arc<dyn ProviderEgressCatalogPort>,
        config: ProviderConfig,
    ) -> Result<Self, PortError> {
        records::limits(config.default_space_limits)?;
        if config.space_limits.len() > 4096
            || config.max_active_calls == 0
            || config.max_active_calls > MAX_ACTIVE_CALLS_CAP
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        for limits in config.space_limits.values() {
            records::limits(*limits)?;
        }
        let active_calls = Arc::new(Semaphore::new(config.max_active_calls));
        Ok(Self {
            control,
            keyring,
            outbound,
            egress,
            config,
            dispatcher: notarium_core::ids::RequestId::from_bytes(crate::auth::token::random()?),
            active_calls,
        })
    }
    async fn management(&self, ctx: &AccountContext) -> Result<(), PortError> {
        ctx.auth().authorize_human_management()?;
        self.management_read(ctx).await
    }
    async fn management_read(&self, ctx: &AccountContext) -> Result<(), PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.control.store.read(budget.clone()).await?;
        budget
            .run(
                self.control
                    .manager_read(rtx.inner_mut(), ctx.auth(), ctx.auth().principal()),
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.rollback(), CommitEffect::NotCommitted).await
    }
    async fn mutate<T, F>(
        &self,
        ctx: AccountContext,
        command: Command,
        apply: F,
    ) -> Result<ControlCommit<T>, PortError>
    where
        T: Serialize + DeserializeOwned + Send + 'static,
        F: for<'tx> FnOnce(
                &'tx mut Transaction,
                &'tx UsersRow,
                i64,
            ) -> PortFuture<'tx, (T, Vec<RevocationSelector>)>
            + Send,
    {
        self.mutate_authorized(ctx, command, |_, _| Box::pin(async { Ok(()) }), apply)
            .await
    }
    async fn mutate_authorized<T, A, F>(
        &self,
        ctx: AccountContext,
        command: Command,
        authorize: A,
        apply: F,
    ) -> Result<ControlCommit<T>, PortError>
    where
        T: Serialize + DeserializeOwned + Send + 'static,
        A: for<'tx> FnOnce(&'tx mut Transaction, &'tx UsersRow) -> PortFuture<'tx, ()> + Send,
        F: for<'tx> FnOnce(
                &'tx mut Transaction,
                &'tx UsersRow,
                i64,
            ) -> PortFuture<'tx, (T, Vec<RevocationSelector>)>
            + Send,
    {
        if ctx.auth().taint().is_tainted() {
            return Err(notarium_core::DomainError::CrossSpaceTainted.into());
        }
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.control.store.write(budget.clone()).await?;
        let (revision, saved) = budget.run(async {
            let (_, owner) = self.control.manager(tx.inner_mut(), ctx.auth(), ctx.auth().principal()).await?;
            authorize(tx.inner_mut(), &owner).await?;
            if let Some(replay) = command.replay::<T>(tx.inner_mut()).await? { return Ok(replay); }
            expect_revision(&owner, command.identity.expected)?;
            let now = self.control.clock.now_ms()?;
            let (value, selectors) = apply(tx.inner_mut(), &owner, now).await?;
            let revision = next(owner.revision)?;
            execute!(tx.inner_mut(), "UPDATE users SET revision=$1 WHERE user_id=$2", "UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&owner.user_id)?;
            let mut events = Vec::new();
            for selector in selectors {
                events.push(super::outbox::enqueue(tx.inner_mut(), selector, RevocationReason::PermissionChanged, revision, now).await?);
            }
            let revision = notarium_core::ids::ControlRevision::new(revision as u64)?;
            let saved = SavedResult { value, events };
            command.save(tx.inner_mut(), revision, &saved, now).await?;
            Ok((revision, saved))
        }, CommitEffect::NotCommitted).await?;
        self.control
            .commit_revocations(tx, &budget, &saved.events)
            .await?;
        for event in &saved.events {
            self.control.flush_event(&budget, event).await?;
        }
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
}
