use super::super::{commands::Command, spaces::require_owner};
use super::{
    ProviderService,
    attachments::{check_member, epochs, epochs_read},
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
fn model_kind_name(kind: PreferenceModelKind) -> &'static str {
    match kind {
        PreferenceModelKind::Completion => "completion",
        PreferenceModelKind::Embedding => "embedding",
    }
}
fn matches_preference_kind(actual: &ProviderModelKind, wanted: PreferenceModelKind) -> bool {
    matches!(
        (actual, wanted),
        (
            ProviderModelKind::Completion,
            PreferenceModelKind::Completion
        ) | (
            ProviderModelKind::Embedding { .. },
            PreferenceModelKind::Embedding
        )
    )
}
pub(super) struct PolicyAdmission {
    pub policy: ProviderPolicy,
    pub project_only: Option<FolderRef>,
    pub expires_at_ms: Option<i64>,
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn policy(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    resource: &ProviderResourcesRow,
    credential_epoch: Option<i64>,
    space: &Space,
    project: Option<&FolderRef>,
    now: i64,
    lock: bool,
) -> Result<PolicyAdmission, PortError> {
    // Current-auth revalidation already holds shared Space admission. Policy
    // checks must not upgrade it after taking resource/credential locks.
    check_member(tx, auth, &space.id).await?;
    if space.lifecycle != SpaceLifecycle::Active {
        return Err(unavailable());
    }
    let personal = if lock {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,
            "SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3",
            "SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3 FOR SHARE";&resource.id,auth.principal().as_str(),space.id.as_str())?
    } else {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,
            "SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3",
            "SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3";&resource.id,auth.principal().as_str(),space.id.as_str())?
    }
    .filter(|row| active(row, resource, credential_epoch, now))
    .ok_or_else(unavailable)?;
    let mut disclosure: ProviderDisclosure = parse(&personal.disclosure)?;
    let mut project_only = None;
    let mut expires_at_ms = personal.expires_at;
    let audience = if space.kind == SpaceKind::Personal {
        ProviderAudience::Personal { consented: true }
    } else {
        let shared = shared_attachment(
            tx,
            resource,
            credential_epoch,
            &space.id,
            project,
            now,
            lock,
        )
        .await?;
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
    lock: bool,
) -> Result<ProviderAttachmentsRow, PortError> {
    let global = if lock {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2 FOR SHARE";&resource.id,space.as_str())?
    } else {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2";&resource.id,space.as_str())?
    };
    if let Some(row) = global.filter(|row| active(row, resource, credential_epoch, now)) {
        return Ok(row);
    }
    let project = project
        .filter(|project| project.space_id == *space)
        .ok_or_else(unavailable)?;
    let scoped = if lock {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3 FOR SHARE";&resource.id,space.as_str(),project.folder_id.as_str())?
    } else {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3";&resource.id,space.as_str(),project.folder_id.as_str())?
    };
    scoped
        .filter(|row| active(row, resource, credential_epoch, now))
        .ok_or_else(unavailable)
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
        let wanted_kind = model_kind_name(request.kind);
        let (mut tx, auth) = self
            .control
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let selected=budget.run(async {
            let now=self.control.clock.now_ms()?;
            let (id,model_id)=if let Some(id)=request.resource { (id,request.model) }
            else if let Some(model)=request.model {
                let project_id = request.project.as_ref().map(|p| p.folder_id.as_str());
                let is_shared = if space.space.kind == SpaceKind::Shared { 1_i64 } else { 0_i64 };
                let candidates=rows!(tx.inner_mut(),(String,),fetch_all,
                    "SELECT r.id FROM provider_resources r JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id JOIN provider_models m ON m.resource_id=r.id JOIN provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind=$2 AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='personal' AND a.target_owner=$3 AND a.target_space=$4 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$5) AND ($6=0 OR EXISTS (SELECT 1 FROM provider_attachments sa WHERE sa.resource_id=r.id AND sa.target_space=$4 AND (sa.target_kind='space' OR (sa.target_kind='project' AND sa.target_project=$7)) AND sa.state='approved' AND sa.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND sa.credential_epoch IS NULL) OR sa.credential_epoch=c.consent_epoch) AND (sa.expires_at IS NULL OR sa.expires_at>$5))) ORDER BY r.id LIMIT 2",
                    "SELECT r.id FROM v1_control.provider_resources r JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id JOIN v1_control.provider_models m ON m.resource_id=r.id JOIN v1_control.provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind=$2 AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='personal' AND a.target_owner=$3 AND a.target_space=$4 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$5) AND ($6=0 OR EXISTS (SELECT 1 FROM v1_control.provider_attachments sa WHERE sa.resource_id=r.id AND sa.target_space=$4 AND (sa.target_kind='space' OR (sa.target_kind='project' AND sa.target_project=$7)) AND sa.state='approved' AND sa.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND sa.credential_epoch IS NULL) OR sa.credential_epoch=c.consent_epoch) AND (sa.expires_at IS NULL OR sa.expires_at>$5))) ORDER BY r.id LIMIT 2";model.as_str(),wanted_kind,auth.principal().as_str(),space.space.id.as_str(),now,is_shared,project_id)?;
                if candidates.len()!=1 {return Err(unavailable());}
                (ProviderResourceId::parse(&candidates[0].0)?,Some(model))
            } else {
                let preferred=self.preference(tx.inner_mut(),&auth,&space.space.id,request.project.as_ref(),wanted_kind).await?;
                (ProviderResourceId::parse(&preferred.resource_id)?,Some(ModelProfileId::parse(&preferred.model_id)?))
            };
            let resource=resource_read(tx.inner_mut(),id.as_str()).await?;
            let owner_active = rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT count(*) FROM users WHERE user_id=$1 AND disabled_at IS NULL","SELECT count(*) FROM v1_control.users WHERE user_id=$1 AND disabled_at IS NULL";&resource.owner_id)?.0;
            if owner_active != 1 {
                return Err(unavailable());
            }
            let credential_epoch=epochs_read(tx.inner_mut(),&resource).await.map_err(|_| unavailable())?;
            let model_id=model_id.or_else(||resource.default_model.as_deref().and_then(|value|ModelProfileId::parse(value).ok())).ok_or_else(unavailable)?;
            let loaded=model_info(&model_read(tx.inner_mut(),&resource.id,model_id.as_str()).await.map_err(|_| unavailable())?)?;
            if !matches_preference_kind(&loaded.model.kind, request.kind) {
                return Err(unavailable());
            }
            let admission=policy(tx.inner_mut(),&auth,&resource,credential_epoch,&space.space,request.project.as_ref(),now,false).await?;
            Ok(ProviderSelection{provider:id,model:model_id,project:request.project,project_only:admission.project_only,policy:admission.policy})
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
        model_kind: &str,
    ) -> Result<ProviderPreferencesRow, PortError> {
        let personal = rows!(tx,ProviderPreferencesRow,fetch_optional,"SELECT * FROM provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1 AND model_kind=$2","SELECT * FROM v1_control.provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1 AND model_kind=$2";auth.principal().as_str(),model_kind)?;
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
            let rows = rows!(tx,ProviderPreferencesRow,fetch_all,"SELECT * FROM provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3 ORDER BY owner_id LIMIT 2","SELECT * FROM v1_control.provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3 ORDER BY owner_id LIMIT 2";kind,&id,model_kind)?;
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
            let resource=resource(tx,input.resource.as_str()).await?;let credential_epoch=epochs(tx,&resource).await?;
            let loaded=model_info(&model(tx,&resource.id,input.model.as_str()).await?)?;
            if !matches_preference_kind(&loaded.model.kind, input.kind) {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
            if let Some(catalog)=&catalog {
                let project=match &input.scope{ProviderPreferenceScope::Project(project)=>Some(project),_=>None};
                shared_attachment(tx,&resource,credential_epoch,&catalog.space.id,project,now,true).await?;
            } else {super::inventory::resource_visible(tx,&owner.user_id,&resource).await?;}
            let (kind,id)=preference_scope(&input.scope,auth.principal());
            let wanted_kind = model_kind_name(input.kind);
            // Space/project preferences belong to that scope and model_kind. The
            // row owner is its last authorized editor; a second owner replaces it.
            if kind=="personal" {execute!(tx,"DELETE FROM provider_preferences WHERE owner_id=$1 AND scope_kind=$2 AND scope_id=$3 AND model_kind=$4","DELETE FROM v1_control.provider_preferences WHERE owner_id=$1 AND scope_kind=$2 AND scope_id=$3 AND model_kind=$4";&owner.user_id,kind,&id,wanted_kind)?;}
            else {execute!(tx,"DELETE FROM provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3","DELETE FROM v1_control.provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3";kind,&id,wanted_kind)?;}
            let row=TargetRecord::from(ProviderPreferencesRow{owner_id:owner.user_id.clone(),scope_kind:kind.into(),scope_id:id,model_kind:wanted_kind.into(),resource_id:resource.id,model_id:input.model.to_string(),revision:super::super::authority::next(owner.revision)?});row.validate()?;row.insert(tx).await?;
            Ok((input,vec![]))
        })).await
    }
}
