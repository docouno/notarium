//! Provider configuration, current disclosure admission and durable accounting.
mod accounting;
pub(crate) mod admission;
mod attachments;
mod configuration;
mod dispatch;
mod execution;
mod inventory;
pub(crate) mod offers;
mod ports;
mod records;
mod recovery;
pub(crate) mod selection;
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
        self.management_read_impl(ctx, false).await
    }
    async fn management_scoped(&self, ctx: &AccountContext) -> Result<(), PortError> {
        ctx.auth().authorize_human_management()?;
        self.management_read_impl(ctx, true).await
    }
    fn management_read_scoped<'a>(
        &'a self,
        ctx: &'a AccountContext,
    ) -> impl std::future::Future<Output = Result<(), PortError>> + Send + 'a {
        self.management_read_impl(ctx, true)
    }
    async fn management_read_impl(
        &self,
        ctx: &AccountContext,
        scoped: bool,
    ) -> Result<(), PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.control.store.read(budget.clone()).await?;
        let scope = if scoped {
            ManagerScope::TargetScoped
        } else {
            ManagerScope::Full
        };
        budget
            .run(
                self.control.manager_read_impl(
                    rtx.inner_mut(),
                    ctx.auth(),
                    ctx.auth().principal(),
                    scope,
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.rollback(), CommitEffect::NotCommitted).await
    }
    fn mutate<'a, T, F>(
        &'a self,
        ctx: AccountContext,
        command: Command,
        apply: F,
    ) -> impl std::future::Future<Output = Result<ControlCommit<T>, PortError>> + Send + 'a
    where
        T: Serialize + DeserializeOwned + Send + Sync + 'static,
        F: for<'tx> FnOnce(
                &'tx mut Transaction,
                &'tx UsersRow,
                i64,
            ) -> PortFuture<'tx, (T, Vec<RevocationSelector>)>
            + Send
            + 'a,
    {
        self.mutate_authorized_inner(
            ctx,
            command,
            false,
            |_, _| Box::pin(async { Ok(()) }),
            apply,
        )
    }
    fn mutate_authorized<'a, T, A, F>(
        &'a self,
        ctx: AccountContext,
        command: Command,
        authorize: A,
        apply: F,
    ) -> impl std::future::Future<Output = Result<ControlCommit<T>, PortError>> + Send + 'a
    where
        T: Serialize + DeserializeOwned + Send + Sync + 'static,
        A: for<'tx> FnOnce(&'tx mut Transaction, &'tx UsersRow) -> PortFuture<'tx, ()> + Send + 'a,
        F: for<'tx> FnOnce(
                &'tx mut Transaction,
                &'tx UsersRow,
                i64,
            ) -> PortFuture<'tx, (T, Vec<RevocationSelector>)>
            + Send
            + 'a,
    {
        self.mutate_authorized_inner(ctx, command, false, authorize, apply)
    }
    fn mutate_authorized_scoped<'a, T, A, F>(
        &'a self,
        ctx: AccountContext,
        command: Command,
        authorize: A,
        apply: F,
    ) -> impl std::future::Future<Output = Result<ControlCommit<T>, PortError>> + Send + 'a
    where
        T: Serialize + DeserializeOwned + Send + Sync + 'static,
        A: for<'tx> FnOnce(&'tx mut Transaction, &'tx UsersRow) -> PortFuture<'tx, ()> + Send + 'a,
        F: for<'tx> FnOnce(
                &'tx mut Transaction,
                &'tx UsersRow,
                i64,
            ) -> PortFuture<'tx, (T, Vec<RevocationSelector>)>
            + Send
            + 'a,
    {
        self.mutate_authorized_inner(ctx, command, true, authorize, apply)
    }
    async fn mutate_replay_authorized<'a, T, AR, AF, F>(
        &'a self,
        ctx: AccountContext,
        command: Command,
        authorize_replay: AR,
        authorize_fresh: AF,
        apply: F,
    ) -> Result<ControlCommit<T>, PortError>
    where
        T: Serialize + DeserializeOwned + Send + Sync + 'static,
        AR: for<'tx> FnOnce(&'tx mut Transaction, &'tx UsersRow, &'tx T) -> PortFuture<'tx, ()>
            + Send
            + 'a,
        AF: for<'tx> FnOnce(&'tx mut Transaction, &'tx UsersRow) -> PortFuture<'tx, ()> + Send + 'a,
        F: for<'tx> FnOnce(
                &'tx mut Transaction,
                &'tx UsersRow,
                i64,
            ) -> PortFuture<'tx, (T, Vec<RevocationSelector>)>
            + Send
            + 'a,
    {
        if ctx.auth().taint().is_tainted() {
            return Err(notarium_core::DomainError::CrossSpaceTainted.into());
        }
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.control.store.write(budget.clone()).await?;
        let (revision, saved, enqueued) = budget
            .run(
                async {
                    let (_, owner) = self
                        .control
                        .manager_impl(
                            tx.inner_mut(),
                            ctx.auth(),
                            ctx.auth().principal(),
                            ManagerScope::Full,
                        )
                        .await?;
                    if let Some((revision, saved)) = command.replay::<T>(tx.inner_mut()).await? {
                        authorize_replay(tx.inner_mut(), &owner, &saved.value).await?;
                        return Ok((revision, saved, Vec::new()));
                    }
                    authorize_fresh(tx.inner_mut(), &owner).await?;
                    expect_revision(&owner, command.identity.expected)?;
                    let now = self.control.clock.now_ms()?;
                    let (value, selectors) = apply(tx.inner_mut(), &owner, now).await?;
                    let revision = next(owner.revision)?;
                    execute!(tx.inner_mut(), "UPDATE users SET revision=$1 WHERE user_id=$2", "UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&owner.user_id)?;
                    let mut events = Vec::new();
                    for selector in selectors {
                        events.push(
                            super::outbox::enqueue(
                                tx.inner_mut(),
                                selector,
                                RevocationReason::PermissionChanged,
                                revision,
                                now,
                            )
                            .await?,
                        );
                    }
                    let revision = notarium_core::ids::ControlRevision::new(revision as u64)?;
                    let enqueued = events.clone();
                    let saved = SavedResult { value, events };
                    command.save(tx.inner_mut(), revision, &saved, now).await?;
                    Ok((revision, saved, enqueued))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        self.control
            .commit_revocations(tx, &budget, &enqueued)
            .await?;
        for event in &saved.events {
            self.control.flush_event(&budget, event).await?;
        }
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
    async fn mutate_authorized_inner<T, A, F>(
        &self,
        ctx: AccountContext,
        command: Command,
        scoped: bool,
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
        let (revision, saved, enqueued) = budget.run(async {
            let scope = if scoped {
                ManagerScope::TargetScoped
            } else {
                ManagerScope::Full
            };
            let (_, owner) = self
                .control
                .manager_impl(tx.inner_mut(), ctx.auth(), ctx.auth().principal(), scope)
                .await?;
            authorize(tx.inner_mut(), &owner).await?;
            if let Some((revision, saved)) = command.replay::<T>(tx.inner_mut()).await? {
                return Ok((revision, saved, Vec::new()));
            }
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
            let enqueued = events.clone();
            let saved = SavedResult { value, events };
            command.save(tx.inner_mut(), revision, &saved, now).await?;
            Ok((revision, saved, enqueued))
        }, CommitEffect::NotCommitted).await?;
        self.control
            .commit_revocations(tx, &budget, &enqueued)
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
