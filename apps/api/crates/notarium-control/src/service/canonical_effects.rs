use super::ControlService;
use crate::store::lease::OperationBudget;
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, PrincipalKind, SpaceRole},
    classes::DocClass,
    error::{CommitEffect, PortError, ValidationReason},
    ports::{
        AccountContext, BearerScope, CanonicalEffect, MaintenanceContext, ServiceAuthority,
        ServicePurpose, SpaceContext,
    },
};

impl ControlService {
    pub(super) async fn fence_canonical_effect(
        &self,
        authority: EngineAuthContext,
        ctx: SpaceContext,
        effect: CanonicalEffect,
    ) -> Result<SpaceContext, PortError> {
        let source = ctx
            .confirmed_chat_step()
            .map(|step| step.witness().source());
        if ctx.canonical_effect().is_some()
            || (effect == CanonicalEffect::ConfirmedProposal) != source.is_some()
        {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
        match effect {
            CanonicalEffect::AbilityAuthoring => authority.authorize_ability_mutation()?,
            CanonicalEffect::ConfirmedProposal => authority.authorize_proposal_confirmation()?,
            CanonicalEffect::ChatRollback => authority.authorize_human_management()?,
            CanonicalEffect::ChatInput
                if authority.kind() == &PrincipalKind::DirectHuman
                    && ctx.auth().kind() == &PrincipalKind::DirectHuman => {}
            CanonicalEffect::ChatRedaction
                if (authority.kind() == &PrincipalKind::DirectHuman
                    || (matches!(
                        authority.kind(),
                        PrincipalKind::Pat | PrincipalKind::OAuth { .. }
                    ) && authority.bearer_scope() == Some(BearerScope::Write)))
                    && ctx.auth().kind() == authority.kind() => {}
            CanonicalEffect::ChatClaim
                if authority.kind() == &PrincipalKind::DirectHuman
                    && matches!(ctx.auth().kind(), PrincipalKind::AgentRun(_)) => {}
            CanonicalEffect::ChatInput
            | CanonicalEffect::ChatRedaction
            | CanonicalEffect::ChatClaim => {
                return Err(DomainError::AccessDenied.into());
            }
        }
        let target = &ctx.scope().space_id;
        let spaces = std::iter::once(target).chain(source.map(|scope| &scope.space_id));
        let selectors = authority
            .selectors_for_revocation(spaces)?
            .into_iter()
            .collect();
        let budget = OperationBudget::new(ctx.budget.clone());
        let request = ctx.budget.request.clone();
        // Register before the live snapshot so any intervening revoke cancels
        // authorization before it can enter Canonical's SQL boundary.
        let registration = budget
            .run(
                self.revoker.register_canonical_effect(
                    MaintenanceContext {
                        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                        budget: budget.context(request.clone()),
                    },
                    selectors,
                    budget.cancellation().clone(),
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        let account = AccountContext::new(authority, budget.context(request));
        let current = self.current_account(&account, &budget).await?;
        registration.check()?;
        if source.is_some_and(|scope| !current.auth().spaces().contains_key(&scope.space_id)) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let ctx = ctx.with_canonical_effect(&current, registration)?;
        let grant = &ctx.auth().spaces()[&ctx.scope().space_id];
        if grant.role == SpaceRole::Viewer
            || (matches!(
                ctx.auth().kind(),
                PrincipalKind::Pat | PrincipalKind::OAuth { .. }
            ) && ctx.auth().bearer_scope() != Some(BearerScope::Write))
        {
            return Err(DomainError::SpaceReadOnly.into());
        }
        if effect == CanonicalEffect::AbilityAuthoring {
            ctx.auth().authorize_ability_mutation()?;
            if !grant.write_classes.contains(&DocClass::Skill) {
                return Err(DomainError::SpaceReadOnly.into());
            }
        }
        if effect == CanonicalEffect::ChatRollback {
            ctx.auth().authorize_human_management()?;
        }
        if let Some(step) = ctx.confirmed_chat_step() {
            step.witness().authorize_writer(ctx.auth())?;
        }
        Ok(ctx)
    }
}
