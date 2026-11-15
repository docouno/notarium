use super::super::{commands::Command, spaces::require_owner};
use super::{
    ProviderService,
    attachments::{check_member, epochs},
    records::*,
};
use crate::{
    error::invalid,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, Space, SpaceKind, SpaceLifecycle},
    classes::{ProviderAudience, ProviderPolicy},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::FolderRef,
    ports::{control::*, *},
};

pub(super) fn unavailable() -> PortError {
    DomainError::Provider {
        error: ProviderErrorCode::Unavailable,
    }
    .into()
}
pub(super) fn preference_scope(
    scope: &ProviderPreferenceScope,
    owner: &PrincipalId,
) -> (&'static str, String) {
    match scope {
        ProviderPreferenceScope::Personal => ("personal", owner.to_string()),
        ProviderPreferenceScope::Space(space) => ("space", space.to_string()),
        ProviderPreferenceScope::Project(project) => (
            "project",
            format!("{}:{}", project.space_id, project.folder_id),
        ),
    }
}
fn active(
    row: &ProviderAttachmentsRow,
    resource: &ProviderResourcesRow,
    credential_epoch: Option<i64>,
    now: i64,
) -> bool {
    row.state == "approved"
        && row.resource_epoch == resource.consent_epoch
        && row.credential_epoch == credential_epoch
        && row.expires_at.is_none_or(|time| time > now)
}
pub(super) struct PolicyAdmission {
    pub policy: ProviderPolicy,
    pub project_only: Option<FolderRef>,
    pub expires_at_ms: Option<i64>,
}
pub(super) async fn policy(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    resource: &ProviderResourcesRow,
    credential_epoch: Option<i64>,
    space: &Space,
    project: Option<&FolderRef>,
    now: i64,
) -> Result<PolicyAdmission, PortError> {
    // Current-auth revalidation already holds shared Space admission. Policy
    // checks must not upgrade it after taking resource/credential locks.
    check_member(tx, auth, &space.id).await?;
    if space.lifecycle != SpaceLifecycle::Active {
        return Err(unavailable());
    }
    let personal=rows!(tx,ProviderAttachmentsRow,fetch_optional,
        "SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3",
        "SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3 FOR SHARE";&resource.id,auth.principal().as_str(),space.id.as_str())?.filter(|row|active(row,resource,credential_epoch,now)).ok_or_else(unavailable)?;
    let mut disclosure: ProviderDisclosure = parse(&personal.disclosure)?;
    let mut project_only = None;
    let mut expires_at_ms = personal.expires_at;
    let audience = if space.kind == SpaceKind::Personal {
        ProviderAudience::Personal { consented: true }
    } else {
        let shared =
            shared_attachment(tx, resource, credential_epoch, &space.id, project, now).await?;
        expires_at_ms = [expires_at_ms, shared.expires_at]
            .into_iter()
            .flatten()
            .min();
        if shared.target_kind == "project" {
            project_only = project.cloned();
        }
        let allowed: ProviderDisclosure = parse(&shared.disclosure)?;
        disclosure.classes = disclosure
            .classes
            .intersection(&allowed.classes)
            .copied()
            .collect();
        ProviderAudience::Shared {
            space: space.id.clone(),
            attached: true,
            space_consented: true,
            sender_consented: true,
        }
    };
    disclosure
        .classes
        .remove(&notarium_core::classes::DocClass::EncryptedNote);
    if space.kind == SpaceKind::Shared {
        disclosure
            .classes
            .remove(&notarium_core::classes::DocClass::Profile);
    }
    if disclosure.classes.is_empty() {
        return Err(unavailable());
    }
    Ok(PolicyAdmission {
        policy: ProviderPolicy {
            provider: ProviderResourceId::parse(&resource.id)?,
            audience,
            allowed_classes: disclosure.classes,
        },
        project_only,
        expires_at_ms,
    })
}
async fn shared_attachment(
    tx: &mut Transaction,
    resource: &ProviderResourcesRow,
    credential_epoch: Option<i64>,
    space: &SpaceId,
    project: Option<&FolderRef>,
    now: i64,
) -> Result<ProviderAttachmentsRow, PortError> {
    let global = rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2 FOR SHARE";&resource.id,space.as_str())?;
    if let Some(row) = global.filter(|row| active(row, resource, credential_epoch, now)) {
        return Ok(row);
    }
    let project = project
        .filter(|project| project.space_id == *space)
        .ok_or_else(unavailable)?;
    rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3 FOR SHARE";&resource.id,space.as_str(),project.folder_id.as_str())?.filter(|row|active(row,resource,credential_epoch,now)).ok_or_else(unavailable)
}
impl ProviderService {
    pub(super) async fn selection_catalog(
        &self,
        ctx: &SpaceContext,
        project: Option<&FolderRef>,
    ) -> Result<CatalogSpace, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let space = budget
            .run(
                self.control.catalog.space(
                    budget.context(ctx.budget.request.clone()),
                    ctx.scope().space_id.clone(),
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        ctx.check_current(&space.history)?;
        if space.space.id != ctx.scope().space_id || space.space.lifecycle != SpaceLifecycle::Active
        {
            return Err(unavailable());
        }
        if let Some(project) = project {
            if project.space_id != space.space.id {
                return Err(invalid(ValidationReason::ScopeMismatch));
            }
            let actual = budget
                .run(
                    self.control.catalog.project(ctx.clone(), project.clone()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            if actual.folder != *project {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
        Ok(space)
    }
    pub async fn select_provider(
        &self,
        ctx: SpaceContext,
        request: SelectProvider,
    ) -> Result<ProviderSelection, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let space = self
            .selection_catalog(&ctx, request.project.as_ref())
            .await?;
        let mut tx = self.control.store.write(budget.clone()).await?;
        let selected=budget.run(async {
            let auth=self.control.revalidate(tx.inner_mut(),ctx.auth()).await?;
            let (id,model_id)=if let Some(id)=request.resource { (id,request.model) }
            else if let Some(model)=request.model {
                let candidates=rows!(tx.inner_mut(),(String,),fetch_all,
                    "SELECT r.id FROM provider_resources r JOIN provider_models m ON m.resource_id=r.id JOIN provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND r.disabled_at IS NULL AND a.target_kind='personal' AND a.target_owner=$2 AND a.target_space=$3 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$4) ORDER BY r.id LIMIT 2",
                    "SELECT r.id FROM v1_control.provider_resources r JOIN v1_control.provider_models m ON m.resource_id=r.id JOIN v1_control.provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND r.disabled_at IS NULL AND a.target_kind='personal' AND a.target_owner=$2 AND a.target_space=$3 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$4) ORDER BY r.id LIMIT 2";model.as_str(),auth.principal().as_str(),space.space.id.as_str(),self.control.clock.now_ms()?)?;
                if candidates.len()!=1 {return Err(unavailable());}
                (ProviderResourceId::parse(&candidates[0].0)?,Some(model))
            } else {
                let preferred=self.preference(tx.inner_mut(),&auth,&space.space.id,request.project.as_ref()).await?;
                (ProviderResourceId::parse(&preferred.resource_id)?,Some(ModelProfileId::parse(&preferred.model_id)?))
            };
            let resource=resource(tx.inner_mut(),id.as_str()).await?;let credential_epoch=epochs(tx.inner_mut(),&resource).await?;
            let model_id=model_id.or_else(||resource.default_model.as_deref().and_then(|value|ModelProfileId::parse(value).ok())).ok_or_else(unavailable)?;
            model_info(&model(tx.inner_mut(),&resource.id,model_id.as_str()).await?)?;
            let admission=policy(tx.inner_mut(),&auth,&resource,credential_epoch,&space.space,request.project.as_ref(),self.control.clock.now_ms()?).await?;
            Ok(ProviderSelection{provider:id,model:model_id,project:request.project,policy:admission.policy})
        },CommitEffect::NotCommitted).await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(selected)
    }
    async fn preference(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        space: &SpaceId,
        project: Option<&FolderRef>,
    ) -> Result<ProviderPreferencesRow, PortError> {
        let personal = rows!(tx,ProviderPreferencesRow,fetch_optional,"SELECT * FROM provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1","SELECT * FROM v1_control.provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1";auth.principal().as_str())?;
        if let Some(row) = personal {
            return Ok(row);
        }
        let mut scopes = Vec::new();
        if let Some(project) = project {
            scopes.push(preference_scope(
                &ProviderPreferenceScope::Project(project.clone()),
                auth.principal(),
            ));
        }
        scopes.push(("space", space.to_string()));
        for (kind, id) in scopes {
            let rows = rows!(tx,ProviderPreferencesRow,fetch_all,"SELECT * FROM provider_preferences WHERE scope_kind=$1 AND scope_id=$2 ORDER BY owner_id LIMIT 2","SELECT * FROM v1_control.provider_preferences WHERE scope_kind=$1 AND scope_id=$2 ORDER BY owner_id LIMIT 2";kind,&id)?;
            if rows.len() > 1 {
                return Err(unavailable());
            }
            if let Some(row) = rows.into_iter().next() {
                return Ok(row);
            }
        }
        Err(unavailable())
    }
    pub async fn set_preference(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<SetProviderPreference>,
    ) -> Result<ControlCommit<SetProviderPreference>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management(&ctx).await?;
        let input = request.input;
        let catalog = match &input.scope {
            ProviderPreferenceScope::Personal => None,
            ProviderPreferenceScope::Space(space) => Some(
                self.target_catalog(&ctx, &ProviderAttachmentTarget::Space(space.clone()))
                    .await?,
            ),
            ProviderPreferenceScope::Project(project) => Some(
                self.target_catalog(&ctx, &ProviderAttachmentTarget::Project(project.clone()))
                    .await?,
            ),
        };
        let command = Command::new(request.identity, "set-provider-preference", &input)?;
        let auth = ctx.auth().clone();
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate(ctx,command,move |tx,owner,now|Box::pin(async move {
            // A shared default is replaced across resource owners. Serialize
            // that scope before taking any provider configuration row locks.
            if let Some(catalog)=&catalog {
                super::super::spaces::admission(tx,&catalog.space.id,true).await?;
                check_member(tx,&auth,&catalog.space.id).await?;require_owner(tx,&auth,&catalog.space.id).await?;
            }
            let resource=resource(tx,input.resource.as_str()).await?;let credential_epoch=epochs(tx,&resource).await?;model_info(&model(tx,&resource.id,input.model.as_str()).await?)?;
            if let Some(catalog)=&catalog {
                let project=match &input.scope{ProviderPreferenceScope::Project(project)=>Some(project),_=>None};
                shared_attachment(tx,&resource,credential_epoch,&catalog.space.id,project,now).await?;
            } else {super::inventory::resource_visible(tx,&owner.user_id,&resource).await?;}
            let (kind,id)=preference_scope(&input.scope,auth.principal());
            // Space/project preferences belong to that scope. The row owner is
            // its last authorized editor; a second owner replaces the default.
            if kind=="personal" {execute!(tx,"DELETE FROM provider_preferences WHERE owner_id=$1 AND scope_kind=$2 AND scope_id=$3","DELETE FROM v1_control.provider_preferences WHERE owner_id=$1 AND scope_kind=$2 AND scope_id=$3";&owner.user_id,kind,&id)?;}
            else {execute!(tx,"DELETE FROM provider_preferences WHERE scope_kind=$1 AND scope_id=$2","DELETE FROM v1_control.provider_preferences WHERE scope_kind=$1 AND scope_id=$2";kind,&id)?;}
            let row=TargetRecord::ProviderPreferences(ProviderPreferencesRow{owner_id:owner.user_id.clone(),scope_kind:kind.into(),scope_id:id,resource_id:resource.id,model_id:input.model.to_string(),revision:super::super::authority::next(owner.revision)?});row.validate()?;row.insert(tx).await?;
            Ok((input,vec![]))
        })).await
    }
}
